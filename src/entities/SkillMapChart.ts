import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COLORS } from '../scene/colors'
import { PAPER_TOKENS } from '../systems/paperTheme'
import { BAR_TICKS, CHART_CENTER_Y, CHART_FOOT, chartView, share, type ChartView, type TutorLessonState } from '../systems/skillMap'
import { BENCH_ANGLE_DEG, BENCH_RADIUS } from './PracticeBench'

// The skill map chart: a framed sheet of paper on the wall above the practice
// bench, drawn from the stored record of the newest Socratic lesson
// (systems/skillMap.ts). Nothing on it is made up and nothing on it moves:
//
//   one row for each subskill (up to ten): two bars on a scale of 0 to 1, the
//     upper pale and hatched (the untrained model), the lower solid (after
//     the lesson), and the pass bands at the right. The bars differ by
//     pattern, position and label, never by colour alone. A small red dot at
//     the end of a row says the gain was better on practice questions only;
//   a stage line, and a line saying what the numbers are and who wrote the rules;
//   a small amber lamp on the frame, lit and steady only while the lab has
//     heard from the lesson recently. It never blinks or pulses.
//
// The paper is redrawn only when the record changes. With no lesson on record,
// or no experiment connected, it is a blank sheet and the lamp is dark.
//
// Cost: 1 merged mesh for the frame (5 boxes, 60 triangles), the paper (2
// triangles) and the lamp: 3 draw calls, about 110 triangles (stats() reports
// the exact count), and one 1024 by 640 texture.

const WOOD = new THREE.Color(COLORS.structure.wood)
const BRASS = new THREE.Color(COLORS.structure.brass)

// the paper's own colours come from the shared paper theme
const T = PAPER_TOKENS
const INK = T['--paper-ink']
const INK_2 = T['--paper-ink-2']
const LINE = T['--paper-line']
const SUNK = T['--paper-sunk']
const BAR = T['--paper-bar']
const BRASS_FILL = T['--paper-brass']
const BRASS_EDGE = T['--paper-brass-edge']
const DANGER = T['--paper-danger']
const PAPER = T['--paper-raised']

const CW = 1024
const CH = 640
const PAPER_W = 0.94
const PAPER_H = (PAPER_W * CH) / CW // 0.5875
const FRAME = 0.03 // the width of a frame bar
const PLATE_H = 0.045 // the brass strip's height at the bottom
const FRAME_W = PAPER_W + 2 * FRAME
const FRAME_H = PAPER_H + 2 * FRAME + PLATE_H
const FRAME_D = 0.05
// The back of the frame nearly touches the wall. The wall's inner face is at LAB_RADIUS + 0.3 (scene/Lab.ts), the bench
// stands at BENCH_RADIUS, and the bench's own -Z points at the wall.
const WALL_RADIUS = 8.26 // 8.3 at a corner of the 32 sided wall, 8.26 in the middle of a side
const BACK_Z = -(WALL_RADIUS - BENCH_RADIUS) + 0.02

const LAMP_OFF = 0x3a2523
const LAMP_ON = new THREE.Color(COLORS.states.working).getHex()

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  g.deleteAttribute('uv')
  const n = g.getAttribute('position').count
  const c = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(c, 3))
  return g
}

/** Text cut to fit a width, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, t: string, max: number): string {
  let s = t
  while (ctx.measureText(s).width > max && s.length > 3) s = s.slice(0, -2)
  return s === t ? s : `${s.trimEnd()}…`
}

/** Text broken into at most two lines to fit a width; the last line gets an ellipsis if it still does not fit. */
function twoLines(ctx: CanvasRenderingContext2D, t: string, max: number): string[] {
  if (ctx.measureText(t).width <= max) return [t]
  const words = t.split(' ')
  let first = ''
  let i = 0
  while (i < words.length) {
    const next = first ? `${first} ${words[i]}` : words[i]
    if (ctx.measureText(next).width > max && first) break
    first = next
    i++
  }
  const rest = words.slice(i).join(' ')
  return rest ? [fit(ctx, first, max), fit(ctx, rest, max)] : [fit(ctx, first, max)]
}

export class SkillMapChart {
  public group: THREE.Group

  private paper: THREE.Mesh
  private canvas: HTMLCanvasElement
  private texture: THREE.CanvasTexture
  private lamp: THREE.Mesh
  private lampMat: THREE.MeshBasicMaterial
  private frame: THREE.Mesh
  private view: ChartView = chartView(null, true)
  private drawn = ''
  private dirty = true

  /** Hangs against the wall above the bench that stands at (angleDeg, radius). */
  constructor(angleDeg = BENCH_ANGLE_DEG, radius = BENCH_RADIUS) {
    this.group = new THREE.Group()
    this.group.name = 'skill_map_chart'
    const a = (angleDeg * Math.PI) / 180
    this.group.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius)
    this.group.rotation.y = -a - Math.PI / 2 // the bench's own space: +Z faces the middle of the room
    // a click or a tap on it opens the lesson (main.ts)
    this.group.userData.inspect = { kind: 'lesson' }

    const cy = CHART_CENTER_Y
    const z = BACK_Z + FRAME_D / 2
    const parts: THREE.BufferGeometry[] = []
    // four wood bars around the paper, and the brass plate strip under it
    const top = cy + FRAME_H / 2 - FRAME / 2
    const bottom = cy - FRAME_H / 2 + FRAME / 2
    parts.push(box(FRAME_W, FRAME, FRAME_D, 0, top, z, WOOD))
    parts.push(box(FRAME_W, FRAME, FRAME_D, 0, bottom, z, WOOD))
    const sideH = FRAME_H - 2 * FRAME
    const sideY = cy
    parts.push(box(FRAME, sideH, FRAME_D, -(FRAME_W - FRAME) / 2, sideY, z, WOOD))
    parts.push(box(FRAME, sideH, FRAME_D, (FRAME_W - FRAME) / 2, sideY, z, WOOD))
    parts.push(box(FRAME_W - 2 * FRAME, PLATE_H, 0.012, 0, cy - FRAME_H / 2 + FRAME + PLATE_H / 2 - 0.0, z + FRAME_D / 2 - 0.004, BRASS))
    const merged = mergeGeometries(parts, false)!
    parts.forEach(g => g.dispose())
    this.frame = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 }))
    this.group.add(this.frame)

    // the paper: one canvas plane, set into the frame
    this.canvas = document.createElement('canvas')
    this.canvas.width = CW
    this.canvas.height = CH
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 4
    this.paper = new THREE.Mesh(new THREE.PlaneGeometry(PAPER_W, PAPER_H), new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.6, metalness: 0 }))
    this.paper.position.set(0, cy + PLATE_H / 2, BACK_Z + 0.012)
    this.group.add(this.paper)

    // the lamp on the frame's top bar, near its right end
    this.lampMat = new THREE.MeshBasicMaterial({ color: LAMP_OFF })
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 4), this.lampMat)
    this.lamp.position.set(FRAME_W / 2 - 0.05, top, BACK_Z + FRAME_D + 0.008)
    this.group.add(this.lamp)

    this.setLesson(null, true)
    this.update(0)
  }

  /** Draw calls and triangles the chart costs when drawn, counted from its own geometry. */
  public stats(): { drawCalls: number; triangles: number } {
    let drawCalls = 0
    let triangles = 0
    this.group.traverse(o => {
      if (!(o instanceof THREE.Mesh) || !o.visible) return
      const g = o.geometry as THREE.BufferGeometry
      drawCalls++
      triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3
    })
    return { drawCalls, triangles }
  }

  /** What the room's state says about the newest lesson, and whether no experiment is connected. */
  public setLesson(state: TutorLessonState | null, simulation: boolean): void {
    this.setView(chartView(state, simulation))
  }

  public setView(view: ChartView): void {
    if (view.key !== this.view.key) this.dirty = true
    this.view = view
    this.lampMat.color.setHex(view.lamp ? LAMP_ON : LAMP_OFF)
  }

  /** The view now on the paper: its stage line, rows and lamp. */
  public get current(): ChartView { return this.view }

  /** Called every frame. It redraws the paper when the record changed, and does nothing else: nothing here moves. */
  public update(_dt: number): void {
    if (!this.dirty && this.drawn === this.view.key) return
    this.dirty = false
    this.drawn = this.view.key
    this.drawPaper()
  }

  // ------------------------------------------------------------------ drawing

  private drawPaper(): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const v = this.view
    const M = 40
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, CW, CH)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'

    if (v.mode === 'dark') {
      ctx.fillStyle = INK_2
      ctx.font = '600 40px Georgia, serif'
      ctx.textAlign = 'center'
      ctx.fillText(fit(ctx, v.title, CW - 2 * M), CW / 2, CH / 2 - 6)
      ctx.font = '500 26px Georgia, serif'
      ctx.fillText(fit(ctx, CHART_FOOT, CW - 2 * M), CW / 2, CH - 34)
      this.texture.needsUpdate = true
      return
    }

    // the topic, and who taught it
    ctx.fillStyle = INK
    ctx.font = '700 46px Georgia, serif'
    ctx.fillText(fit(ctx, v.title, CW - 2 * M), M, 62)
    ctx.fillStyle = INK_2
    ctx.font = '500 26px Georgia, serif'
    if (v.byline) ctx.fillText(fit(ctx, v.byline, CW - 2 * M), M, 100)

    // the key: a pale hatched swatch, "before", and a solid brass swatch, "after"
    const keyY = 140
    this.swatch(ctx, M, keyY - 16, 44, 18, false)
    ctx.fillStyle = INK
    ctx.font = '500 24px Georgia, serif'
    ctx.fillText('before', M + 54, keyY)
    this.swatch(ctx, M + 170, keyY - 16, 44, 18, true)
    ctx.fillStyle = INK
    ctx.fillText('after', M + 224, keyY)
    ctx.textAlign = 'right'
    ctx.fillText('pass band, 0 to 5', CW - M, keyY)
    ctx.textAlign = 'left'

    // the rows: names at the left, two bars on a 0 to 1 scale, the bands at the right
    const top = 162
    ctx.font = '600 26px Georgia, serif'
    const stage = twoLines(ctx, v.stageLine, CW - 2 * M)
    const lift = (stage.length - 1) * 30 // a stage line of two lines pushes the rows up
    const bottom = (v.flagNote ? 524 : 548) - lift
    const n = Math.max(1, v.rows.length)
    const rowH = Math.min(58, (bottom - top) / n)
    const nameX = M
    const nameW = 300
    const barX = 360
    const barW = 470
    const barH = Math.max(9, Math.min(15, rowH * 0.3))
    const font = Math.max(20, Math.min(30, Math.round(rowH * 0.58)))
    // the scale: six ticks, labelled once
    ctx.strokeStyle = LINE
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 1
    for (const t of BAR_TICKS) {
      const x = Math.round(barX + t * barW) + 0.5
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + rowH * n); ctx.stroke()
    }
    ctx.globalAlpha = 1
    v.rows.forEach((row, i) => {
      const y = top + i * rowH
      const mid = y + rowH / 2
      ctx.fillStyle = INK
      ctx.font = `600 ${font}px Georgia, serif`
      ctx.textAlign = 'left'
      ctx.fillText(fit(ctx, row.name, nameW), nameX, mid + font * 0.34)
      const b = share(row.before)
      const a = share(row.after)
      this.bar(ctx, barX, mid - barH - 2, barW, barH, b, false)
      this.bar(ctx, barX, mid + 2, barW, barH, a, true)
      if (row.seenOnly) {
        ctx.fillStyle = DANGER
        ctx.strokeStyle = INK
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(barX + barW + 26, mid, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      }
      if (row.bands) {
        ctx.fillStyle = INK
        ctx.font = `600 ${font}px "Courier New", monospace`
        ctx.textAlign = 'right'
        ctx.fillText(row.bands, CW - M, mid + font * 0.34)
      }
    })
    ctx.textAlign = 'left'

    // a corner note when the finished lesson is flagged
    if (v.flagNote) {
      ctx.fillStyle = DANGER
      ctx.font = '600 24px Georgia, serif'
      ctx.fillText(fit(ctx, v.flagNote, CW - 2 * M), M, 548 - lift)
    }
    // the stage line, then what the numbers are
    ctx.fillStyle = INK
    ctx.font = '600 26px Georgia, serif'
    stage.forEach((line, k) => ctx.fillText(line, M, 584 - lift + k * 30))
    ctx.fillStyle = INK_2
    ctx.font = '500 24px Georgia, serif'
    ctx.fillText(fit(ctx, CHART_FOOT, CW - 2 * M), M, 618)
    this.texture.needsUpdate = true
  }

  /** One bar: a track, and a fill to `frac` of it. Before is pale and hatched, after is solid brass. */
  private bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number | null, solid: boolean): void {
    ctx.fillStyle = SUNK
    ctx.fillRect(x, y, w, h)
    if (frac !== null && frac > 0) {
      const fw = Math.max(2, Math.round(w * Math.min(1, frac)))
      ctx.fillStyle = solid ? BRASS_FILL : SUNK
      ctx.fillRect(x, y, fw, h)
      if (!solid) this.hatch(ctx, x, y, fw, h)
      ctx.strokeStyle = solid ? BRASS_EDGE : BAR
      ctx.lineWidth = 2
      ctx.strokeRect(x + 1, y + 1, fw - 2, h - 2)
    }
    ctx.strokeStyle = LINE
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  }

  private swatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, solid: boolean): void {
    ctx.fillStyle = solid ? BRASS_FILL : SUNK
    ctx.fillRect(x, y, w, h)
    if (!solid) this.hatch(ctx, x, y, w, h)
    ctx.strokeStyle = solid ? BRASS_EDGE : BAR
    ctx.lineWidth = 2
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
  }

  /** Diagonal lines inside a rectangle: the "before" pattern. */
  private hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    ctx.strokeStyle = BAR
    ctx.lineWidth = 2
    for (let k = -h; k < w; k += 8) {
      ctx.beginPath(); ctx.moveTo(x + k, y + h); ctx.lineTo(x + k + h, y); ctx.stroke()
    }
    ctx.restore()
  }

  public dispose(): void {
    this.group.traverse(o => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        Array.isArray(m) ? m.forEach(x => x.dispose()) : (m as THREE.Material).dispose()
      }
    })
    this.texture.dispose()
  }
}
