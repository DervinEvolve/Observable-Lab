import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COLORS } from '../scene/colors'
import {
  MAX_JARS, benchView, curvePoints, lampState, needleAngle, penPoint, rewardColor, scoreText, stepLabel,
  type BenchView, type Practice,
} from '../systems/practiceBench'

// The practice bench: where the lab's Tinker RL runs (docs/TOOLS.md, "Tinker RL")
// are drawn. Everything on it comes from the stored record of the newest run
// (systems/practiceBench.ts); nothing here is made up, and nothing moves while
// no run is going:
//
//   a brass chart recorder with a paper roll: the pen draws the mean reward of
//     each finished step, and rests when the run is idle;
//   a rack of glass bell jars, one per answer in a group: amber while a step
//     is being sampled, then red to green by the reward each answer earned;
//   a step dial ("step N of M");
//   a brass plate with the task set's name and the author model's name;
//   two gauges for the held-out score the lab measured, before and after
//     training, labelled "measured by the lab";
//   a small red tell-tale lamp that blinks when the reward-hacking flag is set.
//
// With no run on record, or while no experiment is connected, the bench is
// dark and still and its plate says that nothing has been practised yet.
//
// Cost: 1 merged mesh of static parts, 2 instanced meshes (jars and what is in
// them), 3 canvas planes (instruments, plate, chart paper), the pen and the
// lamp: 8 draw calls, about 3,000 triangles (stats() reports the exact count).

const WOOD = new THREE.Color(COLORS.structure.wood)
const WOOD_DARK = new THREE.Color(COLORS.structure.woodDark)
const BRASS = new THREE.Color(COLORS.structure.brass)
const BRASS_DARK = new THREE.Color(COLORS.structure.brassPatina)
const PAPER = new THREE.Color(0xf4ecd8)

/** Where the bench stands: against the wall, between the crates and the Executor's desk, clear of both. */
export const BENCH_ANGLE_DEG = -31
export const BENCH_RADIUS = 7.45

const TOP_Y = 0.86 // the bench top
const BOARD_Z = -0.24 // the back board's front face, in the bench's own space (+Z faces the middle of the room)
const JAR_H = 0.11
const JAR_R = 0.032
const ROWS = 2
const PER_ROW = MAX_JARS / ROWS
const JAR_STEP = 0.082

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return tinted(g, color)
}

function cylinder(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, color: THREE.Color, rotZ = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg)
  if (rotZ) g.rotateZ(rotZ)
  g.translate(x, y, z)
  return tinted(g, color)
}

function tinted(g: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  g.deleteAttribute('uv')
  const n = g.getAttribute('position').count
  const c = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(c, 3))
  return g
}

function canvasPlane(w: number, h: number, cw: number, ch: number): { mesh: THREE.Mesh; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, metalness: 0.1 }))
  return { mesh, canvas, texture }
}

/** Text cut to fit a width, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  let t = text
  while (ctx.measureText(t).width > max && t.length > 3) t = t.slice(0, -2)
  return t === text ? t : `${t.trimEnd()}…`
}

export class PracticeBench {
  public group: THREE.Group

  private body: THREE.Mesh
  private shells: THREE.InstancedMesh
  private liquid: THREE.InstancedMesh
  private slots: THREE.Vector3[] = []
  private instruments: ReturnType<typeof canvasPlane>
  private plate: ReturnType<typeof canvasPlane>
  private paper: ReturnType<typeof canvasPlane>
  private paperGroup: THREE.Group
  private pen: THREE.Mesh
  private lamp: THREE.Mesh
  private lampMat: THREE.MeshBasicMaterial

  private view: BenchView = benchView(null, true)
  private reducedMotion = false
  private time = 0
  // the needles ease to the recorded scores, and stop when they get there
  private needleBefore = 0
  private needleAfter = 0
  private instrumentsDirty = true
  private plateDirty = true
  private paperDirty = true
  private jarsDirty = true
  private penX = 0.04
  private penY = 0.04
  private penDown = false
  private amber = new THREE.Color(COLORS.states.working)
  private tmp = new THREE.Color()

  constructor(angleDeg = BENCH_ANGLE_DEG, radius = BENCH_RADIUS) {
    this.group = new THREE.Group()
    this.group.name = 'practice_bench'
    const a = (angleDeg * Math.PI) / 180
    this.group.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius)
    this.group.rotation.y = -a - Math.PI / 2 // +Z faces the middle of the room
    // a click or a tap anywhere on it opens the record (main.ts)
    this.group.userData.inspect = { kind: 'practice' }

    // ---- the static furniture: one merged mesh, colours in the vertices ----
    const parts: THREE.BufferGeometry[] = []
    // top, legs and the shelf under it
    parts.push(box(1.7, 0.06, 0.62, 0, TOP_Y - 0.03, 0, WOOD))
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(0.06, TOP_Y - 0.06, 0.06, sx * 0.79, (TOP_Y - 0.06) / 2, sz * 0.26, WOOD_DARK))
    parts.push(box(1.6, 0.03, 0.5, 0, 0.22, 0, WOOD_DARK))
    // the back board the instruments hang on
    parts.push(box(1.7, 0.62, 0.04, 0, TOP_Y + 0.31, BOARD_Z - 0.02, WOOD_DARK))
    // brass trim along the board's top, and the lamp's collar
    parts.push(box(1.7, 0.02, 0.05, 0, TOP_Y + 0.63, BOARD_Z - 0.02, BRASS))
    parts.push(cylinder(0.034, 0.04, 0.02, 10, 0.76, TOP_Y + 0.64, BOARD_Z + 0.02, BRASS_DARK))
    // the chart recorder: a brass case with a drum at each end of the paper
    parts.push(box(0.5, 0.12, 0.34, -0.52, TOP_Y + 0.06, -0.05, BRASS_DARK))
    parts.push(box(0.5, 0.02, 0.36, -0.52, TOP_Y + 0.13, -0.05, BRASS))
    parts.push(cylinder(0.026, 0.026, 0.4, 10, -0.52, TOP_Y + 0.17, -0.2, BRASS, Math.PI / 2))
    parts.push(cylinder(0.026, 0.026, 0.4, 10, -0.52, TOP_Y + 0.155, 0.1, BRASS, Math.PI / 2))
    parts.push(box(0.03, 0.05, 0.03, -0.76, TOP_Y + 0.15, -0.2, BRASS_DARK), box(0.03, 0.05, 0.03, -0.28, TOP_Y + 0.15, -0.2, BRASS_DARK))
    // the jar rack: a shelf with a low rail, and a brass lid for every jar
    parts.push(box(0.76, 0.02, 0.2, 0.37, TOP_Y + 0.01, 0.12, WOOD_DARK))
    parts.push(box(0.76, 0.03, 0.012, 0.37, TOP_Y + 0.035, 0.225, BRASS_DARK))
    const slotX0 = 0.37 - ((PER_ROW - 1) * JAR_STEP) / 2
    for (let r = 0; r < ROWS; r++) {
      for (let i = 0; i < PER_ROW; i++) {
        const p = new THREE.Vector3(slotX0 + i * JAR_STEP, TOP_Y + 0.02 + JAR_H / 2, 0.075 + r * 0.095)
        this.slots.push(p)
        parts.push(cylinder(JAR_R * 0.82, JAR_R * 0.82, 0.014, 8, p.x, p.y + JAR_H / 2 + 0.007, p.z, BRASS))
      }
    }
    // the plate's mount on the front edge
    parts.push(box(0.64, 0.14, 0.012, 0.05, TOP_Y - 0.15, 0.31, WOOD_DARK))
    const merged = mergeGeometries(parts, false)!
    parts.forEach(g => g.dispose())
    this.body = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 }))
    this.group.add(this.body)

    // ---- the jars: every shell and every filling is one instance of one mesh ----
    const shellGeo = new THREE.CylinderGeometry(JAR_R, JAR_R, JAR_H, 10)
    this.shells = new THREE.InstancedMesh(shellGeo, new THREE.MeshStandardMaterial({
      color: COLORS.structure.glass, transparent: true, opacity: 0.3, roughness: 0.08, metalness: 0, depthWrite: false,
    }), MAX_JARS)
    const liquidGeo = new THREE.CylinderGeometry(JAR_R * 0.82, JAR_R * 0.82, JAR_H * 0.8, 10)
    this.liquid = new THREE.InstancedMesh(liquidGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0 }), MAX_JARS)
    const m = new THREE.Matrix4()
    for (let i = 0; i < MAX_JARS; i++) {
      m.makeTranslation(this.slots[i].x, this.slots[i].y, this.slots[i].z)
      this.shells.setMatrixAt(i, m)
      this.liquid.setMatrixAt(i, m)
      this.liquid.setColorAt(i, this.tmp.set(0xffffff))
    }
    this.shells.count = 0
    this.liquid.count = 0
    this.shells.frustumCulled = false
    this.liquid.frustumCulled = false
    this.shells.renderOrder = 2
    this.group.add(this.liquid, this.shells)

    // ---- the instruments: the two gauges and the step dial on one panel ----
    this.instruments = canvasPlane(0.96, 0.32, 768, 256)
    this.instruments.mesh.position.set(0.28, TOP_Y + 0.33, BOARD_Z + 0.002)
    this.group.add(this.instruments.mesh)

    // ---- the brass plate on the front of the bench ----
    this.plate = canvasPlane(0.6, 0.12, 512, 102)
    this.plate.mesh.position.set(0.05, TOP_Y - 0.15, 0.318)
    this.group.add(this.plate.mesh)

    // ---- the paper on the recorder, tilted toward the room, with the pen on it ----
    this.paperGroup = new THREE.Group()
    this.paperGroup.position.set(-0.52, TOP_Y + 0.168, -0.05)
    this.paperGroup.rotation.x = -0.5
    this.paper = canvasPlane(0.4, 0.26, 512, 333)
    this.paperGroup.add(this.paper.mesh)
    this.pen = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.03, 6), new THREE.MeshStandardMaterial({ color: COLORS.structure.brass, roughness: 0.4, metalness: 0.7 }))
    this.pen.rotation.x = -Math.PI / 2 // the point down onto the paper
    this.paperGroup.add(this.pen)
    this.group.add(this.paperGroup)

    // ---- the tell-tale lamp on top of the board ----
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x3a2523 })
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), this.lampMat)
    this.lamp.position.set(0.76, TOP_Y + 0.68, BOARD_Z + 0.02)
    this.group.add(this.lamp)

    this.setView(benchView(null, true))
    this.update(0)
  }

  /** Draw calls and triangles the bench costs when drawn, counted from its own geometry. */
  public stats(): { drawCalls: number; triangles: number } {
    let drawCalls = 0
    let triangles = 0
    this.group.traverse(o => {
      if (!(o instanceof THREE.Mesh) || !o.visible) return
      const g = o.geometry as THREE.BufferGeometry
      const per = (g.index ? g.index.count : g.getAttribute('position').count) / 3
      const n = o instanceof THREE.InstancedMesh ? o.count : 1
      if (n === 0) return
      drawCalls++
      triangles += per * n
    })
    return { drawCalls, triangles }
  }

  /** The bench's worst case: all sixteen jars standing. Used to report its cost. */
  public maxStats(): { drawCalls: number; triangles: number } {
    const was = [this.shells.count, this.liquid.count]
    this.shells.count = MAX_JARS
    this.liquid.count = MAX_JARS
    const s = this.stats()
    this.shells.count = was[0]
    this.liquid.count = was[1]
    return s
  }

  public setReducedMotion(on: boolean): void {
    if (this.reducedMotion === on) return
    this.reducedMotion = on
    this.jarsDirty = true
  }

  /** What the room's state says about Tinker RL. `simulation` is true while no experiment is connected. */
  public setPractice(practice: Practice | null, simulation: boolean): void {
    this.setView(benchView(practice, simulation))
  }

  public setView(view: BenchView): void {
    const was = this.view
    this.view = view
    const n = Math.min(MAX_JARS, view.jars.length)
    this.shells.count = n
    this.liquid.count = n
    this.jarsDirty = true
    this.instrumentsDirty = true
    this.paperDirty = true
    if (was.plate.title !== view.plate.title || was.plate.author !== view.plate.author || was.mode === 'dark' !== (view.mode === 'dark')) this.plateDirty = true
    const dark = view.mode === 'dark'
    this.paper.mesh.visible = true
    this.pen.visible = !dark
    if (this.reducedMotion || dark) {
      this.needleBefore = needleAngle(view.before)
      this.needleAfter = needleAngle(view.after)
    }
    const pt = penPoint(view)
    this.penDown = view.animated && view.mode !== 'resting'
    if (pt) { this.penX = pt.x; this.penY = pt.y }
    else { this.penX = 0.04; this.penY = 0.04 }
    this.placePen()
  }

  /** Rewards only: the paper is 0.4 by 0.26, with a margin. */
  private placePen(): void {
    const w = 0.4
    const h = 0.26
    const mx = 0.03
    const my = 0.03
    const x = -w / 2 + mx + this.penX * (w - 2 * mx)
    const y = -h / 2 + my + this.penY * (h - 2 * my)
    this.pen.position.set(x, y, this.penDown ? 0.016 : 0.045)
  }

  // ------------------------------------------------------------------ drawing

  private drawInstruments(): void {
    const ctx = this.instruments.canvas.getContext('2d')
    if (!ctx) return
    const v = this.view
    const dark = v.mode === 'dark'
    ctx.fillStyle = dark ? '#2f2a24' : '#efe9db'
    ctx.fillRect(0, 0, 768, 256)
    const ink = dark ? '#6b6254' : '#3a3128'
    const soft = dark ? '#544d42' : '#8a8072'
    const gauge = (cx: number, angle: number, score: number | null, title: string): void => {
      const cy = 150
      ctx.strokeStyle = soft
      ctx.lineWidth = 3
      for (let i = 0; i <= 10; i++) {
        const ang = Math.PI * (1 + i / 10)
        const r1 = 82
        const r2 = i % 5 === 0 ? 68 : 74
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1)
        ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2)
        ctx.stroke()
      }
      ctx.fillStyle = ink
      ctx.textAlign = 'center'
      ctx.font = '600 20px Georgia, serif'
      ctx.fillText(title, cx, 36)
      ctx.font = '600 24px "Courier New", monospace'
      ctx.fillText(scoreText(score), cx, 206)
      ctx.font = '500 13px Georgia, serif'
      ctx.fillStyle = soft
      ctx.fillText('measured by the lab', cx, 232)
      const ang = Math.PI * (1 + angle / Math.PI)
      ctx.strokeStyle = dark ? '#5a3a35' : '#a33d2f'
      ctx.lineWidth = 5
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(ang) * 62, cy + Math.sin(ang) * 62)
      ctx.stroke()
      ctx.fillStyle = dark ? '#5e5530' : '#8a7a32'
      ctx.beginPath()
      ctx.arc(cx, cy, 8, 0, Math.PI * 2)
      ctx.fill()
    }
    gauge(128, this.needleBefore, v.before, 'held-out, before')
    gauge(640, this.needleAfter, v.after, 'held-out, after')
    // the step dial in the middle: a ring that fills as steps are finished
    const cx = 384
    const cy = 128
    ctx.lineWidth = 12
    ctx.lineCap = 'butt'
    ctx.strokeStyle = dark ? '#3b352d' : '#d9d2c0'
    ctx.beginPath()
    ctx.arc(cx, cy, 70, 0, Math.PI * 2)
    ctx.stroke()
    if (v.steps > 0) {
      ctx.strokeStyle = v.mode === 'failed' ? '#e57373' : '#7cb342'
      ctx.beginPath()
      ctx.arc(cx, cy, 70, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(v.step, v.steps)) / v.steps)
      ctx.stroke()
    }
    ctx.fillStyle = ink
    ctx.textAlign = 'center'
    ctx.font = '600 44px "Courier New", monospace'
    ctx.fillText(v.steps > 0 ? String(v.step) : '-', cx, cy + 14)
    ctx.font = '500 16px Georgia, serif'
    ctx.fillStyle = soft
    ctx.fillText(stepLabel(v.step, v.steps), cx, cy + 46)
    this.instruments.texture.needsUpdate = true
  }

  private drawPlate(): void {
    const ctx = this.plate.canvas.getContext('2d')
    if (!ctx) return
    const v = this.view
    const dark = v.mode === 'dark'
    const g = ctx.createLinearGradient(0, 0, 512, 102)
    g.addColorStop(0, dark ? '#5e5a3a' : '#c9ba5a')
    g.addColorStop(1, dark ? '#4c4830' : '#a89a38')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 512, 102)
    ctx.strokeStyle = dark ? '#3d3a28' : '#7d7128'
    ctx.lineWidth = 3
    ctx.strokeRect(5, 5, 502, 92)
    ctx.textAlign = 'center'
    ctx.fillStyle = dark ? '#2b2a1e' : '#2b241b'
    ctx.font = '600 30px Georgia, serif'
    ctx.fillText(fit(ctx, v.plate.title, 470), 256, v.plate.author ? 44 : 62)
    if (v.plate.author) {
      ctx.font = 'italic 400 24px Georgia, serif'
      ctx.fillText(fit(ctx, `by ${v.plate.author}`, 470), 256, 80)
    }
    this.plate.texture.needsUpdate = true
  }

  private drawPaper(): void {
    const ctx = this.paper.canvas.getContext('2d')
    if (!ctx) return
    const v = this.view
    const W = 512
    const H = 333
    ctx.fillStyle = `#${PAPER.getHexString()}`
    ctx.fillRect(0, 0, W, H)
    // the chart's ruled lines
    ctx.strokeStyle = 'rgba(90, 80, 68, 0.28)'
    ctx.lineWidth = 1
    const mx = 0.075 * W
    const my = 0.115 * H
    for (let i = 0; i <= 4; i++) {
      const y = my + ((H - 2 * my) * i) / 4
      ctx.beginPath(); ctx.moveTo(mx, y); ctx.lineTo(W - mx, y); ctx.stroke()
    }
    const pts = curvePoints(v)
    if (v.steps > 1) {
      for (let i = 0; i < v.steps; i++) {
        const x = mx + ((W - 2 * mx) * (i + 0.5)) / v.steps
        ctx.beginPath(); ctx.moveTo(x, my); ctx.lineTo(x, H - my); ctx.stroke()
      }
    }
    ctx.fillStyle = '#5a5044'
    ctx.font = '500 20px Georgia, serif'
    ctx.textAlign = 'left'
    ctx.fillText('mean reward per step', mx, 28)
    if (v.mode === 'dark') ctx.fillText('no run', mx, H / 2)
    // the pen's line, from the recorded means only
    if (pts.length) {
      const px = (p: { x: number; y: number }): [number, number] => [mx + p.x * (W - 2 * mx), H - my - p.y * (H - 2 * my)]
      ctx.strokeStyle = '#1d4f91'
      ctx.lineWidth = 3
      ctx.lineJoin = 'round'
      ctx.beginPath()
      pts.forEach((p, i) => { const [x, y] = px(p); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) })
      ctx.stroke()
      ctx.fillStyle = '#1d4f91'
      for (const p of pts) { const [x, y] = px(p); ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill() }
    }
    this.paper.texture.needsUpdate = true
  }

  private paintJars(): void {
    const v = this.view
    const colours = this.liquid.instanceColor
    const m = new THREE.Matrix4()
    const pulse = v.animated && !this.reducedMotion
    for (let i = 0; i < v.jars.length && i < MAX_JARS; i++) {
      const jar = v.jars[i]
      const s = this.slots[i]
      const fillY = jar.fill === 'empty' ? 0.001 : 1
      m.makeScale(1, fillY, 1)
      m.setPosition(s.x, s.y - (jar.fill === 'empty' ? JAR_H * 0.4 : 0), s.z)
      this.liquid.setMatrixAt(i, m)
      if (jar.fill === 'amber') {
        const k = pulse ? 0.78 + 0.22 * Math.sin(this.time * 3 + i * 0.7) : 1
        this.tmp.copy(this.amber).multiplyScalar(k)
      } else if (jar.fill === 'scored') this.tmp.set(rewardColor(jar.share))
      else this.tmp.set(0x8a8478)
      this.liquid.setColorAt(i, this.tmp)
    }
    this.liquid.instanceMatrix.needsUpdate = true
    if (colours) colours.needsUpdate = true
  }

  // ------------------------------------------------------------------- frame

  /**
   * Called every frame. While nothing is running it does almost nothing: it
   * redraws only what the record changed, and moves nothing.
   */
  public update(dt: number): void {
    const fdt = Math.min(dt, 0.05)
    this.time += fdt
    const v = this.view

    // the needles ease to the scores the lab recorded, then stay still
    const easeTo = (now: number, target: number): number => {
      if (this.reducedMotion || Math.abs(target - now) < 0.002) return target
      return now + (target - now) * Math.min(1, fdt * 3)
    }
    const nb = easeTo(this.needleBefore, needleAngle(v.before))
    const na = easeTo(this.needleAfter, needleAngle(v.after))
    if (nb !== this.needleBefore || na !== this.needleAfter) {
      this.needleBefore = nb
      this.needleAfter = na
      this.instrumentsDirty = true
    }
    if (this.instrumentsDirty) { this.instrumentsDirty = false; this.drawInstruments() }
    if (this.plateDirty) { this.plateDirty = false; this.drawPlate() }
    if (this.paperDirty) { this.paperDirty = false; this.drawPaper() }

    // jars: redrawn when the record changes; amber ones breathe only while the run is live
    if (this.jarsDirty || (v.animated && !this.reducedMotion && v.jars.some(j => j.fill === 'amber'))) {
      this.jarsDirty = false
      this.paintJars()
    }

    // the lamp: dim and still unless the flag is set
    const lamp = lampState(v, this.reducedMotion)
    if (lamp === 'off') this.lampMat.color.setHex(0x3a2523)
    else if (lamp === 'on') this.lampMat.color.setHex(0xe57373)
    else this.lampMat.color.setHex(Math.sin(this.time * 5) > 0 ? 0xff6b5e : 0x4a2a27)
  }

  public dispose(): void {
    this.group.traverse(o => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        Array.isArray(m) ? m.forEach(x => x.dispose()) : (m as THREE.Material).dispose()
      }
    })
    this.instruments.texture.dispose()
    this.plate.texture.dispose()
    this.paper.texture.dispose()
    this.shells.dispose()
    this.liquid.dispose()
  }
}
