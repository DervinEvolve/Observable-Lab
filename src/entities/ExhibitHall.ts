import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { LAB_HEIGHT } from '../scene/Lab'
import {
  EXHIBITS_API,
  EXHIBITS_API_FALLBACK,
  SEGMENTS,
  clampColour,
  commitUrl,
  parseExhibitsResponse,
  selectExhibits,
  type ExhibitData,
  type ExhibitPart,
  type ExhibitRecord,
  type MaterialKind,
  type Placement,
} from '../systems/exhibits'

// The exhibit bays around the walls. Each merged exhibit gets a bay with the
// fixture its placement asks for (a plinth, a slab on the floor, a shelf, a
// board on the wall, or a chain from the ceiling) and a brass plaque naming
// its title and its model. Hover or keyboard focus shows the description and
// the commit it came from.
//
// The room's own builder makes every shape at fixed segment counts from the
// checked data; nothing from the file is run or fetched. Cost: all exhibits,
// fixtures and plaques together are four draw calls (opaque, glass, light,
// plaques). Each bay's spin, bob, pulse and near-wall hiding are uniforms;
// vertices carry their bay index.

const BAYS = 8
// Bays in the order they are filled: far side of the default view first.
// Angles avoid the desks, the archive, the compute corner and the wall art.
const BAY_ANGLES = [216, 144, 282, 108, 0, 72, 36, 330].map(d => (d * Math.PI) / 180)
const WALL_FACE = 8.28 // inner face of the wall cylinder (8.3)

interface Mount {
  pivot: THREE.Vector3 // in the bay frame: x along the wall, y up, z into the room
  env: THREE.Vector3 // the box the exhibit is fitted into
  anchor: 'bottom' | 'back' | 'top'
  plaque: { at: THREE.Vector3; tilt: number }
}

const MOUNTS: Record<Placement, Mount> = {
  pedestal: { pivot: new THREE.Vector3(0, 0.93, 1.0), env: new THREE.Vector3(0.5, 0.8, 0.5), anchor: 'bottom', plaque: { at: new THREE.Vector3(0, 0.72, 1.254), tilt: 0 } },
  floor: { pivot: new THREE.Vector3(0, 0.05, 1.0), env: new THREE.Vector3(0.8, 1.4, 0.8), anchor: 'bottom', plaque: { at: new THREE.Vector3(0, 0.09, 1.47), tilt: -1.0 } },
  shelf: { pivot: new THREE.Vector3(0, 1.32, 0.18), env: new THREE.Vector3(0.62, 0.6, 0.28), anchor: 'bottom', plaque: { at: new THREE.Vector3(0, 1.235, 0.343), tilt: 0 } },
  wall: { pivot: new THREE.Vector3(0, 2.0, 0.035), env: new THREE.Vector3(0.7, 0.7, 0.25), anchor: 'back', plaque: { at: new THREE.Vector3(0, 1.5, 0.012), tilt: 0 } },
  ceiling: { pivot: new THREE.Vector3(0, 3.0, 1.2), env: new THREE.Vector3(0.7, 0.8, 0.7), anchor: 'top', plaque: { at: new THREE.Vector3(0, 1.6, 0.012), tilt: 0 } },
}

// The room's materials: roughness, metalness and the tone a palette colour is
// pulled toward, so a brass part still reads as brass.
const LOOK: Record<MaterialKind, { r: number; m: number; tone: number; mix: number }> = {
  wood: { r: 0.8, m: 0.0, tone: 0x8b7355, mix: 0.35 },
  brass: { r: 0.4, m: 0.7, tone: 0xb5a642, mix: 0.45 },
  glass: { r: 0.08, m: 0.0, tone: 0xe8e4d9, mix: 0.3 },
  paper: { r: 0.95, m: 0.0, tone: 0xf4ecd8, mix: 0.3 },
  stone: { r: 0.9, m: 0.0, tone: 0x9a958c, mix: 0.3 },
  ceramic: { r: 0.35, m: 0.0, tone: 0xf2ede2, mix: 0.15 },
  leaf: { r: 0.7, m: 0.0, tone: 0x7cb342, mix: 0.3 },
  light: { r: 1.0, m: 0.0, tone: 0xffcc66, mix: 0.3 },
}
const WOOD = new THREE.Color(0x8b7355)
const WOOD_DARK = new THREE.Color(0x6b5344)
const BRASS = new THREE.Color(0xb5a642)
const STONE = new THREE.Color(0x8f8a80)

type Kind = 'opaque' | 'glass'

const SHADER_COMMON = /* glsl */ `
attribute vec2 aEx;
uniform vec4 uPivot[${BAYS}];
uniform vec4 uAnim[${BAYS}];
uniform float uGlow[${BAYS}];
varying float vGlow;
vec3 exRot(vec3 q, float a) { float c = cos(a); float s = sin(a); return vec3(c * q.x + s * q.z, q.y, -s * q.x + c * q.z); }
`

type Shader = Parameters<THREE.Material['onBeforeCompile']>[0]

// rm: the material reads roughness, metalness and glow per vertex (the opaque
// mesh, where light parts glow and plaques take their engraving from the atlas)
function inject(mat: THREE.Material, uniforms: Record<string, THREE.IUniform>, name: string, rm: boolean): void {
  mat.onBeforeCompile = (sh: Shader) => {
    Object.assign(sh.uniforms, uniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${SHADER_COMMON}${rm ? 'attribute vec2 aRM;\nattribute vec3 aEm;\nvarying vec2 vRM;\nvarying vec3 vEm;\n' : ''}`)
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3(normal);
        if (aEx.y > 0.5) { int exb = int(aEx.x + 0.5); objectNormal = exRot(exRot(objectNormal, uAnim[exb].x), uPivot[exb].w); }
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed;
        {
          int exb = int(aEx.x + 0.5);
          vec4 pv = uPivot[exb];
          vec4 an = uAnim[exb];
          vec3 q = position;
          if (aEx.y > 0.5) {
            q = exRot(q * an.z, an.x);
            q.y += an.y;
            q = exRot(q, pv.w) + pv.xyz;
          }
          transformed = mix(pv.xyz, q, an.w);
          vGlow = uGlow[exb];
        }
        ${rm ? 'vRM = aRM;\nvEm = aEm;' : ''}`
      )
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying float vGlow;\n${rm ? 'varying vec2 vRM;\nvarying vec3 vEm;\n' : ''}`)
    if (rm) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRM.x;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;')
        .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vEm * vGlow;')
    }
  }
  mat.customProgramCacheKey = () => 'exhibit-' + name
}

// Segment counts. Full detail is the contract's table (SEGMENTS). When the
// shown exhibits together would pass the room's share of the triangle budget,
// the whole hall is built one step coarser (still fixed counts, never more
// than the contract's estimate), and as a last resort the oldest shown
// exhibits are left out until it fits.
type Segs = { [K in keyof typeof SEGMENTS]: { [P in keyof (typeof SEGMENTS)[K]]: number } }
const TIERS: Segs[] = [
  SEGMENTS,
  { sphere: { width: 10, height: 8 }, cylinder: { radial: 10 }, cone: { radial: 10 }, torus: { radial: 8, tubular: 14 }, capsule: { cap: 4, radial: 10 }, ring: { theta: 16 }, tube: { radial: 6 } },
  { sphere: { width: 8, height: 6 }, cylinder: { radial: 8 }, cone: { radial: 8 }, torus: { radial: 6, tubular: 10 }, capsule: { cap: 2, radial: 8 }, ring: { theta: 12 }, tube: { radial: 4 } },
]
// The room at stage 6 is about 57,000 triangles at its most overgrown, so
// the exhibits get what is left under the 70,000 budget (fixtures and
// plaques add under 1,000 more).
export const EXHIBIT_TRIANGLE_BUDGET = 11000

function tierTriangles(p: ExhibitPart, t: Segs): number {
  let each: number
  switch (p.shape) {
    case 'box': each = 12; break
    case 'sphere': each = t.sphere.width * t.sphere.height * 2 - 2 * t.sphere.width; break
    case 'cylinder': each = t.cylinder.radial * 4; break
    case 'cone': each = t.cone.radial * 3; break
    case 'torus': each = t.torus.radial * t.torus.tubular * 2; break
    case 'capsule': each = (2 * t.capsule.cap + 1) * t.capsule.radial * 2; break
    case 'ring': each = t.ring.theta * 2; break
    case 'tube': each = t.tube.radial * 2 * Math.max((p.path?.length ?? 0) - 1, 0); break
  }
  return each * (p.repeat?.count ?? 1)
}

function exhibitTriangles(d: ExhibitData, t: Segs): number {
  return d.parts.reduce((sum, p) => sum + tierTriangles(p, t), 0)
}

/** The finest tier the shown exhibits fit in, and which of them are shown. */
export function planDetail(shown: ExhibitRecord[], budget = EXHIBIT_TRIANGLE_BUDGET): { tier: number; shown: ExhibitRecord[] } {
  for (let tier = 0; tier < TIERS.length; tier++) {
    if (shown.reduce((sum, r) => sum + exhibitTriangles(r.data, TIERS[tier]), 0) <= budget) return { tier, shown }
  }
  // still too many: keep the newest that fit at the coarsest tier
  const last = TIERS.length - 1
  const kept: ExhibitRecord[] = []
  let total = 0
  for (const r of shown) {
    const t = exhibitTriangles(r.data, TIERS[last])
    if (total + t > budget) continue
    total += t
    kept.push(r)
  }
  return { tier: last, shown: kept }
}

/** Geometry for one part at fixed segment counts, sized in metres. */
function partGeometry(p: ExhibitPart, SEG: Segs = SEGMENTS): THREE.BufferGeometry {
  const [sx, sy, sz] = p.size
  switch (p.shape) {
    case 'box': {
      return new THREE.BoxGeometry(sx, sy, sz)
    }
    case 'sphere': {
      const g = new THREE.SphereGeometry(0.5, SEG.sphere.width, SEG.sphere.height)
      g.scale(sx, sy, sz)
      return g
    }
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1, SEG.cylinder.radial, 1)
      g.scale(sx, sy, sz)
      return g
    }
    case 'cone': {
      const g = new THREE.ConeGeometry(0.5, 1, SEG.cone.radial, 1)
      g.scale(sx, sy, sz)
      return g
    }
    case 'torus': {
      // in the XY plane like three's torus: x and y the outer diameter, z the tube thickness
      const outer = Math.max(sx, sy) / 2
      const tube = Math.min(sz / 2, outer * 0.45)
      const g = new THREE.TorusGeometry(Math.max(outer - tube, 0.004), tube, SEG.torus.radial, SEG.torus.tubular)
      g.scale(sx / (2 * outer), sy / (2 * outer), 1)
      return g
    }
    case 'capsule': {
      const r = Math.min(sx, sz) / 2
      const g = new THREE.CapsuleGeometry(r, Math.max(sy - 2 * r, 0), SEG.capsule.cap, SEG.capsule.radial)
      g.scale(sx / (2 * r), 1, sz / (2 * r))
      return g
    }
    case 'ring': {
      // a flat band in the XY plane: x and y the outer diameter, z the band width
      const outer = Math.max(sx, sy) / 2
      const inner = Math.max(0, outer - Math.max(sz, 0.005))
      const g = new THREE.RingGeometry(inner, outer, SEG.ring.theta, 1)
      g.scale(sx / (2 * outer), sy / (2 * outer), 1)
      return g
    }
    case 'tube': {
      const pts = (p.path ?? []).map(v => new THREE.Vector3(v[0], v[1], v[2]))
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
      // the path is in exhibit space; position offsets it
      return new THREE.TubeGeometry(curve, Math.max(1, pts.length - 1), Math.max(sx / 2, 0.003), SEG.tube.radial, false)
    }
  }
}

/** Every copy's matrix for a part (repeat: radial ring about the part's position, or linear steps). */
function partMatrices(p: ExhibitPart): THREE.Matrix4[] {
  const count = p.repeat?.count ?? 1
  const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(p.rotation ?? [0, 0, 0])))
  const out: THREE.Matrix4[] = []
  for (let i = 0; i < count; i++) {
    const m = new THREE.Matrix4().makeTranslation(p.position[0], p.position[1], p.position[2])
    // both may be given: a ring of copies, each also stepped along
    if (p.repeat?.linear) {
      const [x, y, z] = p.repeat.linear.step
      m.premultiply(new THREE.Matrix4().makeTranslation(x * i, y * i, z * i))
    }
    if (p.repeat?.radial && count > 1) {
      const a = (i / count) * Math.PI * 2
      m.multiply(new THREE.Matrix4().makeRotationY(-a)).multiply(new THREE.Matrix4().makeTranslation(p.repeat.radial.radius, 0, 0))
    }
    m.multiply(rot)
    out.push(m)
  }
  return out
}

// The atlas's lower half is plain white: every part that is not a plaque
// samples it, so plaques and parts share one textured material.
const WHITE_UV: [number, number] = [0.5, 0.25]

interface Look {
  rgb: [number, number, number]
  rm: [number, number]
  em?: [number, number, number] // glow (light parts and plaques)
  plaqueUv?: boolean // keep the geometry's own uv (remapped into the atlas)
  glass?: boolean
}

function withAttributes(g: THREE.BufferGeometry, look: Look, bay: number, animated: boolean): THREE.BufferGeometry {
  const geo = g.index ? g : g.setIndex([...Array(g.getAttribute('position').count).keys()])
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && !(look.plaqueUv && name === 'uv')) geo.deleteAttribute(name)
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals()
  const n = geo.getAttribute('position').count
  const fill = (size: number, v: number[]) => {
    const a = new Float32Array(n * size)
    for (let i = 0; i < n; i++) a.set(v, i * size)
    return new THREE.BufferAttribute(a, size)
  }
  geo.setAttribute('color', fill(3, look.rgb))
  geo.setAttribute('aEx', fill(2, [bay, animated ? 1 : 0]))
  if (!look.glass) {
    geo.setAttribute('aRM', fill(2, look.rm))
    geo.setAttribute('aEm', fill(3, look.em ?? [0, 0, 0]))
    if (!look.plaqueUv) geo.setAttribute('uv', fill(2, WHITE_UV))
  }
  geo.clearGroups()
  return geo
}

function bayFrame(angle: number): THREE.Matrix4 {
  const inward = new THREE.Vector3(-Math.cos(angle), 0, -Math.sin(angle))
  const along = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), inward).normalize()
  const m = new THREE.Matrix4().makeBasis(along, new THREE.Vector3(0, 1, 0), inward)
  m.setPosition(Math.cos(angle) * WALL_FACE, 0, Math.sin(angle) * WALL_FACE)
  return m
}

// Yaw that turns the bay frame's +z (into the room) the same way the shader's exRot does.
function bayYaw(angle: number): number {
  return Math.atan2(-Math.cos(angle), -Math.sin(angle))
}

interface Bay {
  record: ExhibitRecord
  angle: number
  spin: number
  bob: number
  pulse: number
  spinAngle: number
  hitCentre: THREE.Vector3
  hitRadius: number
  plaqueWorld: THREE.Vector3
  wallPoint: THREE.Vector3
  visible: number
  button: HTMLButtonElement
}

export class ExhibitHall {
  public readonly group = new THREE.Group()
  public triangleCount = 0

  private uniforms = {
    uPivot: { value: Array.from({ length: BAYS }, () => new THREE.Vector4()) },
    uAnim: { value: Array.from({ length: BAYS }, () => new THREE.Vector4(0, 0, 1, 0)) },
    uGlow: { value: new Array(BAYS).fill(1) },
  }
  private materials: Record<Kind, THREE.Material>
  private atlas: HTMLCanvasElement
  private atlasTex: THREE.CanvasTexture
  private bays: Bay[] = []
  private time = 0
  private reducedMotion = false
  private key = ''
  private repoUrl = 'https://github.com/DervinEvolve/AI-Agent'

  // DOM: one focusable button per exhibit, and the card
  private layer: HTMLDivElement
  private card: HTMLDivElement
  private shownBay: Bay | null = null
  private pinned = false
  private hideTimer: number | null = null
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private downAt: { x: number; y: number } | null = null
  private pollTimer: number | null = null

  constructor(private camera: THREE.Camera, private canvas: HTMLCanvasElement) {
    this.group.name = 'exhibit_hall'
    this.atlas = document.createElement('canvas')
    this.atlas.width = 1024
    this.atlas.height = 1024
    this.atlasTex = new THREE.CanvasTexture(this.atlas)
    this.atlasTex.colorSpace = THREE.SRGBColorSpace
    this.atlasTex.anisotropy = 4

    const opaque = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, map: this.atlasTex })
    inject(opaque, this.uniforms, 'opaque', true)
    const glass = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.32, roughness: 0.08, metalness: 0, depthWrite: false, side: THREE.DoubleSide })
    inject(glass, this.uniforms, 'glass', false)
    this.materials = { opaque, glass }

    this.layer = document.createElement('div')
    this.layer.id = 'exhibit-layer'
    this.layer.setAttribute('aria-label', 'Exhibits')
    this.card = document.createElement('div')
    this.card.id = 'exhibit-card'
    this.card.setAttribute('role', 'dialog')
    this.card.hidden = true
    const style = document.createElement('style')
    style.textContent = `
      #exhibit-layer { position: fixed; inset: 0; pointer-events: none; z-index: 120; }
      #exhibit-layer button { position: absolute; width: 30px; height: 30px; margin: -15px 0 0 -15px; padding: 0; border: 0; border-radius: 50%; background: transparent; pointer-events: none; opacity: 0; }
      #exhibit-layer button:focus-visible { opacity: 1; outline: 2px solid #b5a642; outline-offset: 2px; background: rgba(181, 166, 66, 0.18); }
      #exhibit-card { position: fixed; z-index: 320; max-width: min(300px, calc(100vw - 32px)); padding: 12px 14px; border-radius: 10px; background: rgba(245, 242, 235, 0.97); color: #2b241b; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22); border: 1px solid rgba(139, 115, 85, 0.35); font: 13px/1.45 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; pointer-events: auto; }
      #exhibit-card .ex-kicker { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #8b7355; }
      #exhibit-card .ex-title { font-weight: 650; font-size: 15px; margin: 2px 0 1px; }
      #exhibit-card .ex-by { color: #5b4e3d; font-size: 12px; margin-bottom: 6px; }
      #exhibit-card .ex-desc { margin: 0 0 8px; }
      #exhibit-card a { color: #6b5a1e; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
      #exhibit-card a:focus-visible { outline: 2px solid #b5a642; outline-offset: 2px; border-radius: 3px; }
    `
    document.head.appendChild(style)
    document.body.appendChild(this.layer)
    document.body.appendChild(this.card)

    this.card.addEventListener('pointerenter', () => this.cancelHide())
    this.card.addEventListener('pointerleave', () => { if (!this.pinned) this.scheduleHide() })
    this.card.addEventListener('focusout', e => {
      const next = e.relatedTarget as Node | null
      if (!next || (!this.card.contains(next) && !this.layer.contains(next))) this.scheduleHide()
    })
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointerleave', () => { if (!this.pinned) this.scheduleHide() })
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && this.shownBay) this.hideCard(true) })
    this.group.visible = false
  }

  public setRepoUrl(url: string): void {
    this.repoUrl = url
  }

  public setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
  }

  public get count(): number {
    return this.bays.length
  }

  /** Poll the public endpoint. Missing backend or a bad answer shows nothing. */
  public startPolling(intervalMs = 5 * 60_000): void {
    const tick = async () => {
      await this.refresh()
      this.pollTimer = window.setTimeout(tick, intervalMs)
    }
    if (this.pollTimer === null) void tick()
  }

  public async refresh(): Promise<void> {
    for (const url of [EXHIBITS_API, EXHIBITS_API_FALLBACK]) {
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' } })
        if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) continue
        const body = (await response.json()) as unknown
        if (!body || typeof body !== 'object' || !Array.isArray((body as { exhibits?: unknown }).exhibits)) continue
        return this.setExhibits(parseExhibitsResponse(body))
      } catch {
        // try the next address
      }
    }
    this.setExhibits([])
  }

  /** Build the shown exhibits (at most 8, chosen by the contract's rule). */
  public setExhibits(records: ExhibitRecord[]): void {
    const shown = selectExhibits(records)
    const key = shown.map(r => `${r.slug}@${r.commit_sha}`).join(',')
    if (key === this.key) return
    this.key = key
    this.build(shown)
  }

  public detailTier = 0

  private build(selected: ExhibitRecord[]): void {
    const plan = planDetail(selected)
    const shown = plan.shown
    this.detailTier = plan.tier
    const segs = TIERS[plan.tier]
    this.group.children.forEach(o => (o as THREE.Mesh).geometry?.dispose())
    this.group.clear()
    this.bays.forEach(b => b.button.remove())
    this.bays = []
    this.hideCard(true)
    this.triangleCount = 0
    const buckets: Record<Kind, THREE.BufferGeometry[]> = { opaque: [], glass: [] }
    const ctx = this.atlas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, this.atlas.width, this.atlas.height)
    }

    shown.forEach((record, i) => {
      const angle = BAY_ANGLES[i]
      const frame = bayFrame(angle)
      const mount = MOUNTS[record.data.placement]
      this.buildFixture(record.data.placement, frame, i, buckets.opaque)
      const fitted = this.buildExhibit(record.data, mount, i, buckets, segs)
      // pivot in world space, yaw so the bay's +z faces the room
      const pivot = mount.pivot.clone().applyMatrix4(frame)
      this.uniforms.uPivot.value[i].set(pivot.x, pivot.y, pivot.z, bayYaw(angle))
      // plaque
      const plaqueAt = mount.plaque.at.clone()
      const pg = new THREE.PlaneGeometry(0.34, 0.085)
      pg.rotateX(mount.plaque.tilt)
      pg.translate(plaqueAt.x, plaqueAt.y, plaqueAt.z)
      pg.applyMatrix4(frame)
      const uv = pg.getAttribute('uv')
      const col = i % 2
      const row = Math.floor(i / 2) // rows 0..3: the top half of the atlas
      for (let v = 0; v < uv.count; v++) uv.setXY(v, (col + uv.getX(v)) / 2, 1 - (row + 1 - uv.getY(v)) / 8)
      buckets.opaque.push(withAttributes(pg, { rgb: [1, 1, 1], rm: [0.5, 0], em: [0.06, 0.05, 0.02], plaqueUv: true }, i, false))
      if (ctx) drawPlaque(ctx, col * 512, row * 128, record.data.title, record.author_model)

      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('aria-label', `Exhibit: ${record.data.title}, by ${record.author_model}`)
      button.addEventListener('focus', () => this.showCard(this.bays[i], null))
      button.addEventListener('blur', e => {
        const next = e.relatedTarget as Node | null
        if (!next || !this.card.contains(next)) this.scheduleHide()
      })
      this.layer.appendChild(button)
      const centre = pivot.clone().add(new THREE.Vector3(0, fitted.centreY, 0))
      this.bays.push({
        record,
        angle,
        spin: record.data.animation?.spin ?? 0,
        bob: record.data.animation?.bob ?? 0,
        pulse: record.data.animation?.pulse ?? 0,
        spinAngle: 0,
        hitCentre: centre,
        hitRadius: fitted.radius + 0.12,
        plaqueWorld: plaqueAt.clone().applyMatrix4(frame),
        wallPoint: new THREE.Vector3(Math.cos(angle) * WALL_FACE, 0, Math.sin(angle) * WALL_FACE),
        visible: 1,
        button,
      })
    })
    for (let i = shown.length; i < BAYS; i++) this.uniforms.uAnim.value[i].set(0, 0, 1, 0)
    this.atlasTex.needsUpdate = true

    for (const kind of ['opaque', 'glass'] as const) {
      const geos = buckets[kind]
      if (!geos.length) continue
      const merged = mergeGeometries(geos, false)
      geos.forEach(g => g.dispose())
      if (!merged) continue
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, this.materials[kind])
      mesh.name = `exhibits_${kind}`
      mesh.frustumCulled = false
      mesh.receiveShadow = kind === 'opaque'
      mesh.renderOrder = kind === 'glass' ? 2 : 0
      // the vertices move in the shader; hover uses the bays' own spheres
      mesh.raycast = () => {}
      this.group.add(mesh)
      this.triangleCount += (merged.index?.count ?? 0) / 3
    }
    this.group.visible = shown.length > 0
  }

  private buildFixture(placement: Placement, frame: THREE.Matrix4, bay: number, out: THREE.BufferGeometry[]): void {
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, c: THREE.Color, r: number, m: number) => {
      g.translate(x, y, z)
      g.applyMatrix4(frame)
      out.push(withAttributes(g, { rgb: [c.r, c.g, c.b], rm: [r, m] }, bay, false))
    }
    switch (placement) {
      case 'pedestal':
        add(new THREE.BoxGeometry(0.46, 0.06, 0.46), 0, 0.03, 1.0, WOOD_DARK, 0.85, 0)
        add(new THREE.BoxGeometry(0.4, 0.82, 0.4), 0, 0.47, 1.0, WOOD, 0.8, 0)
        add(new THREE.BoxGeometry(0.5, 0.03, 0.5), 0, 0.895, 1.0, BRASS, 0.4, 0.7)
        add(new THREE.BoxGeometry(0.34, 0.1, 0.01), 0, 0.72, 1.205, WOOD_DARK, 0.85, 0)
        break
      case 'floor':
        add(new THREE.BoxGeometry(0.9, 0.05, 0.9), 0, 0.025, 1.0, STONE, 0.9, 0)
        add(new THREE.BoxGeometry(0.34, 0.02, 0.1), 0, 0.055, 1.47, WOOD_DARK, 0.85, 0)
        break
      case 'shelf':
        add(new THREE.BoxGeometry(0.72, 0.04, 0.32), 0, 1.3, 0.18, WOOD, 0.8, 0)
        for (const x of [-0.28, 0.28]) add(new THREE.BoxGeometry(0.03, 0.2, 0.22), x, 1.18, 0.12, BRASS, 0.4, 0.7)
        break
      case 'wall': {
        add(new THREE.BoxGeometry(0.82, 0.82, 0.03), 0, 2.0, 0.015, WOOD_DARK, 0.85, 0)
        for (const [w, h, x, y] of [[0.88, 0.03, 0, 2.425], [0.88, 0.03, 0, 1.575], [0.03, 0.88, -0.425, 2.0], [0.03, 0.88, 0.425, 2.0]]) {
          add(new THREE.BoxGeometry(w, h, 0.04), x, y, 0.02, BRASS, 0.4, 0.7)
        }
        break
      }
      case 'ceiling': {
        add(new THREE.CylinderGeometry(0.11, 0.13, 0.04, 16), 0, LAB_HEIGHT - 0.02, 1.2, BRASS, 0.4, 0.7)
        add(new THREE.CylinderGeometry(0.008, 0.008, LAB_HEIGHT - 0.04 - 3.0, 6), 0, (LAB_HEIGHT - 0.04 + 3.0) / 2, 1.2, BRASS, 0.4, 0.7)
        break
      }
    }
    if (placement === 'wall' || placement === 'ceiling') {
      // a backing strip under the plaque on the wall
      add(new THREE.BoxGeometry(0.34, 0.1, 0.008), 0, placement === 'wall' ? 1.5 : 1.6, 0.004, WOOD_DARK, 0.85, 0)
    }
  }

  /** The exhibit's parts, fitted into the mount's box, in pivot space. */
  private buildExhibit(d: ExhibitData, mount: Mount, bay: number, buckets: Record<Kind, THREE.BufferGeometry[]>, segs: Segs): { centreY: number; radius: number } {
    const parts: Array<{ geo: THREE.BufferGeometry; kind: Kind; look: Look }> = []
    const box = new THREE.Box3()
    for (const p of d.parts) {
      const base = partGeometry(p, segs)
      const look0 = LOOK[p.material]
      const c = new THREE.Color().setRGB(...clampColour(d.palette[p.colour]))
      c.lerp(new THREE.Color(look0.tone), look0.mix)
      const kind: Kind = p.material === 'glass' ? 'glass' : 'opaque'
      // a light part glows its own colour, like a lamp in the room
      const look: Look = p.material === 'light'
        ? { rgb: [c.r * 0.25, c.g * 0.25, c.b * 0.25], rm: [1, 0], em: [c.r, c.g, c.b] }
        : { rgb: [c.r, c.g, c.b], rm: [look0.r, look0.m], glass: kind === 'glass' }
      for (const m of partMatrices(p)) {
        const g = base.clone().applyMatrix4(m)
        g.computeBoundingBox()
        box.union(g.boundingBox!)
        parts.push({ geo: g, kind, look })
      }
      base.dispose()
    }
    const size = box.getSize(new THREE.Vector3())
    const s = Math.min(1.5, mount.env.x / Math.max(size.x, 1e-3), mount.env.y / Math.max(size.y, 1e-3), mount.env.z / Math.max(size.z, 1e-3))
    const centre = box.getCenter(new THREE.Vector3())
    // anchor: base on the fixture, back against the wall, or top on the chain
    const shift = new THREE.Vector3(-centre.x, 0, -centre.z)
    if (mount.anchor === 'bottom') shift.y = -box.min.y
    else if (mount.anchor === 'top') shift.y = -box.max.y
    else {
      shift.y = -centre.y
      shift.z = -box.min.z
    }
    const fit = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z))
    for (const part of parts) {
      part.geo.applyMatrix4(fit)
      buckets[part.kind].push(withAttributes(part.geo, part.look, bay, true))
    }
    const h = size.y * s
    const centreY = mount.anchor === 'bottom' ? h / 2 : mount.anchor === 'top' ? -h / 2 : 0
    return { centreY, radius: Math.max(size.x, size.y, size.z) * s * 0.6 }
  }

  public update(dt: number): void {
    if (!this.bays.length) return
    const d = Math.min(dt, 0.05)
    if (!this.reducedMotion) this.time += d
    const cam = this.camera.position
    const v = new THREE.Vector3()
    const w = window.innerWidth
    const h = window.innerHeight
    this.bays.forEach((b, i) => {
      if (!this.reducedMotion) b.spinAngle += b.spin * d
      // hidden while the camera looks through that stretch of wall from outside
      const toCam = (cam.x - b.wallPoint.x) * Math.cos(b.angle) + (cam.z - b.wallPoint.z) * Math.sin(b.angle)
      const target = toCam > 0.2 ? 0 : 1
      b.visible += (target - b.visible) * Math.min(1, d * 6)
      const bob = this.reducedMotion ? 0 : b.bob * Math.sin(this.time * 1.6 + i)
      const beat = this.reducedMotion || !b.pulse ? 0 : Math.sin(this.time * Math.PI * 2 * b.pulse)
      this.uniforms.uAnim.value[i].set(b.spinAngle, bob, 1 + 0.02 * beat, b.visible)
      this.uniforms.uGlow.value[i] = 1 + 0.35 * beat
      // keep the focus target over the plaque
      v.copy(b.plaqueWorld).project(this.camera)
      const on = b.visible > 0.5 && v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1
      b.button.style.display = on ? '' : 'none'
      if (on) {
        b.button.style.left = `${((v.x + 1) / 2) * w}px`
        b.button.style.top = `${((1 - v.y) / 2) * h}px`
      }
    })
    if (this.shownBay && this.shownBay.visible < 0.5) this.hideCard(true)
  }

  // ---- hover, tap and focus ----

  private hit(e: PointerEvent): Bay | null {
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    let best: Bay | null = null
    let bestD = Infinity
    const sphere = new THREE.Sphere()
    const p = new THREE.Vector3()
    for (const b of this.bays) {
      if (b.visible < 0.5) continue
      sphere.set(b.hitCentre, b.hitRadius)
      if (this.raycaster.ray.intersectSphere(sphere, p)) {
        const dist = p.distanceTo(this.raycaster.ray.origin)
        if (dist < bestD) {
          bestD = dist
          best = b
        }
      }
    }
    return best
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || this.pinned || e.buttons) return
    const b = this.hit(e)
    if (b) this.showCard(b, { x: e.clientX, y: e.clientY })
    else if (this.shownBay) this.scheduleHide()
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY }
  }

  private onPointerUp = (e: PointerEvent): void => {
    const start = this.downAt
    this.downAt = null
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return
    const b = this.hit(e)
    if (b) {
      this.showCard(b, { x: e.clientX, y: e.clientY })
      this.pinned = true
    } else if (this.shownBay) this.hideCard(true)
  }

  private showCard(b: Bay | undefined, at: { x: number; y: number } | null): void {
    if (!b) return
    this.cancelHide()
    if (this.shownBay !== b) {
      this.pinned = false
      const r = b.record
      const link = commitUrl(this.repoUrl, r.commit_sha)
      const when = new Date(r.merged_at)
      const date = Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      this.card.replaceChildren()
      const el = (tag: string, cls: string, text: string) => {
        const n = document.createElement(tag)
        n.className = cls
        n.textContent = text
        this.card.appendChild(n)
        return n
      }
      el('div', 'ex-kicker', r.data.label ? `Exhibit · ${r.data.label}` : 'Exhibit')
      el('div', 'ex-title', r.data.title)
      el('div', 'ex-by', `By ${r.author_model}${date ? `, merged ${date}` : ''}`)
      el('p', 'ex-desc', r.data.description)
      if (link) {
        const a = el('a', '', `View commit ${r.commit_sha.slice(0, 7)} on GitHub`) as HTMLAnchorElement
        a.href = link
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
      }
      this.card.setAttribute('aria-label', `${r.data.title}, by ${r.author_model}`)
      this.shownBay = b
    }
    this.card.hidden = false
    let x: number
    let y: number
    if (at) {
      x = at.x + 16
      y = at.y + 16
    } else {
      const r = b.button.getBoundingClientRect()
      x = r.right + 8
      y = r.top
    }
    const cw = this.card.offsetWidth
    const ch = this.card.offsetHeight
    x = Math.max(16, Math.min(x, window.innerWidth - cw - 16))
    y = Math.max(16, Math.min(y, window.innerHeight - ch - 16))
    this.card.style.left = `${x}px`
    this.card.style.top = `${y}px`
  }

  private scheduleHide(): void {
    this.cancelHide()
    this.hideTimer = window.setTimeout(() => this.hideCard(false), 280)
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer)
    this.hideTimer = null
  }

  private hideCard(force: boolean): void {
    this.cancelHide()
    if (!force && (this.pinned || this.card.matches(':hover') || this.card.contains(document.activeElement))) return
    this.card.hidden = true
    this.shownBay = null
    this.pinned = false
  }
}

// Brass plaque, engraved: the title, then the model.
function drawPlaque(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, model: string): void {
  const w = 512
  const h = 128
  const g = ctx.createLinearGradient(x, y, x, y + h)
  g.addColorStop(0, '#d2c26a')
  g.addColorStop(0.5, '#b5a642')
  g.addColorStop(1, '#8f8032')
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = 'rgba(70, 58, 20, 0.7)'
  ctx.lineWidth = 4
  ctx.strokeRect(x + 6, y + 6, w - 12, h - 12)
  ctx.fillStyle = '#2f2712'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const fit = (text: string, weight: string, size: number, max: number) => {
    let s = size
    ctx.font = `${weight} ${s}px Georgia, 'Times New Roman', serif`
    while (ctx.measureText(text).width > max && s > 18) {
      s -= 2
      ctx.font = `${weight} ${s}px Georgia, 'Times New Roman', serif`
    }
    let t = text
    while (ctx.measureText(t).width > max && t.length > 4) t = t.slice(0, -2)
    return t === text ? t : `${t.trimEnd()}…`
  }
  ctx.fillText(fit(title, '700', 40, w - 48), x + w / 2, y + 50)
  ctx.fillStyle = '#4a3d18'
  ctx.fillText(fit(`by ${model}`, 'italic 400', 28, w - 60), x + w / 2, y + 92)
}
