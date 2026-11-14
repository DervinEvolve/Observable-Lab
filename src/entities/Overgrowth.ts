import * as THREE from 'three'
import { LAB_RADIUS, LAB_HEIGHT } from '../scene/Lab'
import { STATION_RADIUS } from './Station'
import { eventsKey, rng, type GrowthEvent } from '../systems/growthEvents'
import { CEIL, FREE, WALL, GrowthSink, LONG_AGO, NEVER, leafGeometry, leafMatrix, type LeafSpec } from './growthParts'
import { EventGrower, toChart, type Anchor, type ExhibitBayRef, type GrowStats } from './eventGrowth'
import { BERRIES, PART, SOIL_Y, Specimen, plantHeight, soilHeight } from './specimen'

// The specimen taking over the room. Until it breaks out it is one flowering
// plant in the dome (specimen.ts); at stage 2 runners leave its foot and press
// on the glass, and from the break-out the same plant spills over the broken
// rim, roots across the floor (cracking and lifting boards), climbs desk legs
// and lamps, runs along the brass rail, climbs the walls, and finally knits a
// canopy over the ceiling.
//
// Three layers, drawn together:
// - The flowering plant, built for the record's level: its stem, leaves and
//   flowers, which the events inside the dome grow on.
// - The base organism, the same in every run: five runners and their roots,
//   climbers and canopy, so the stage arc reads. Each vertex carries the growth
//   level G = stage + progress at which it appears, so the stage is a single
//   uniform per frame.
// - What really happened: every event in growth_events grows its own piece on
//   top (eventGrowth.ts), shaped by its kind and magnitude, from its own
//   random stream. New events since the last poll grow in over a few seconds;
//   the history already there on load is simply there.
//
// Cost: two draw calls (the plant, stems with flowers, buds and lifted boards;
// leaves, growing and falling, and the drifting spores), plus the canopy's
// shade on the floor once there is a canopy. None cast shadows.

const WALL_R = LAB_RADIUS + 0.22 // just in front of the wall surface (8.3)
const RAIL_R = LAB_RADIUS // brass baseboard ring
const CEIL_Y = LAB_HEIGHT - 0.03
const DOME_C = new THREE.Vector3(0, 0.3, 0)
const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

// Bark, vine and leaf tones that sit with the wood, brass and cream of the lab.
const ROOT_DARK = new THREE.Color(0x8a6a44)
const ROOT = new THREE.Color(0x8f8a4c)
const VINE_OLD = new THREE.Color(0x6e6a3c)
const VINE_YOUNG = new THREE.Color(0x8db04e)
const CRACK = new THREE.Color(0x1e1610)
const LEAF_TONES = [0x6f9a42, 0x7cb342, 0x8bc34a, 0x5f8a3a, 0x9ab755, 0x76a544].map(c => new THREE.Color(c))
const CANOPY_TONES = [0x5f8a3a, 0x6f9a42, 0x4f7a34, 0x7cb342].map(c => new THREE.Color(c))

// The base organism: fixed, the same in every run. Sparse on purpose, so that
// most of what a visitor sees is what the events grew.
const BASE = {
  seed: 20261113,
  climbers: 6, // wall climbers in the whole room
  sideRoots: 2, // side roots per floor runner
  rootSpread: 0.95,
  rootGirth: 0.95,
  boardsPerRun: 2,
  leafDensity: 0.42, // leaf spacing divides by this
  coarse: 3.0, // ring spacing multiplies by this: the base stays cheap, the events get the triangles
}

// New events grow in one after another, at most this many seconds apart, and
// a batch never takes longer than BATCH_SPAN to start.
const STAGGER = 1.4
const BATCH_SPAN = 12
// marks a falling leaf in the leaf mesh (its appear time)
const FALLING = -2e4
// marks a drifting spore in the leaf mesh
const SPORE = -3e4
// The newest FRESH events are drawn in full; older ones up to WOODY have shed
// about half their leaves, the rest most of them (same shapes, fewer parts).
const FRESH = 90
const WOODY = 200

function polar(r: number, a: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)
}

function inward(p: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(-p.x, 0, -p.z).normalize()
}

// A control point of a growth path: where, which way the surface faces, when
// it grows (G), how thick, and which surface it lies on.
interface CP {
  p: THREE.Vector3
  n: THREE.Vector3
  g: number
  r: number
  s: number // FREE | WALL | CEIL
}

interface PathOpts {
  radial: number
  spacing: number
  lift: boolean // sit on the surface (true) or be centred on the line (false)
  c0: THREE.Color
  c1: THREE.Color
  leafEvery: number // 0 = no leaves
  leafSize: number
  leafTones?: THREE.Color[]
  sway: number
  round?: boolean // a round stem even where it lies on something
}

// Geometry of the base organism
class VineBuilder extends GrowthSink {
  boards: Array<{ m: THREE.Matrix4; thr: number; tilt: number }> = []
  // points on the five runners (and everything that grows off them) that
  // event growth can start from
  anchors: Array<{ p: THREE.Vector3; g: number; family: number }> = []
  family = -1
  private rand: () => number

  constructor(seed: number) {
    super()
    this.rand = rng(seed)
  }

  r(): number {
    return this.rand()
  }

  addPath(cps: CP[], o: PathOpts): void {
    if (cps.length < 2) return
    const curve = new THREE.CatmullRomCurve3(cps.map(c => c.p), false, 'centripetal')
    const len = curve.getLength()
    const n = Math.max(3, Math.ceil(len / (o.spacing * (o.round ? 1.2 : BASE.coarse))))
    // stems lying on the floor, walls or ceiling are flat strips (two
    // triangles a segment); the rest are round
    const flat = o.lift && !o.round
    const radial = flat ? 2 : Math.min(3, o.radial)
    const last = cps.length - 1
    const T = new THREE.Vector3()
    const N = new THREE.Vector3()
    const B = new THREE.Vector3()
    const sp = new THREE.Vector3()
    const off = new THREE.Vector3()
    const v = new THREE.Vector3()
    const spine = new THREE.Vector3()
    const color = new THREE.Color()
    const base = this.vertexCount
    let nextLeaf = o.leafEvery > 0 ? o.leafEvery * (0.3 + this.r() * 0.7) : Infinity
    let travelled = 0
    const prev = new THREE.Vector3()
    let side = this.r() < 0.5 ? 1 : -1
    const wob = this.r() * 10

    for (let i = 0; i <= n; i++) {
      const t = i / n
      curve.getPoint(t, sp)
      curve.getTangent(t, T).normalize()
      // interpolate per-control-point values by curve parameter
      const f = t * last
      const k0 = Math.min(Math.floor(f), last - 1)
      const a = f - k0
      const c0 = cps[k0]
      const c1 = cps[k0 + 1]
      const g = THREE.MathUtils.lerp(c0.g, c1.g, a)
      const rad = THREE.MathUtils.lerp(c0.r, c1.r, a) * (1 + 0.12 * Math.sin(t * len * 6 + wob))
      const surf = a < 0.5 ? c0.s : c1.s
      N.copy(c0.n).lerp(c1.n, a)
      // cross-section frame around the tangent, oriented by the surface normal
      N.addScaledVector(T, -N.dot(T))
      if (N.lengthSq() < 1e-6) N.set(T.y, -T.x, 0.3).addScaledVector(T, -T.dot(N))
      N.normalize()
      B.crossVectors(T, N).normalize()
      const lift = o.lift ? rad : 0
      spine.set(sp.x + N.x * lift, sp.y + N.y * lift, sp.z + N.z * lift)
      color.copy(o.c0).lerp(o.c1, Math.min(1, t * 1.2))
      if (this.family >= 0 && i % 2 === 0) this.anchors.push({ p: sp.clone(), g, family: this.family })

      if (flat) {
        for (const side of [-1, 1]) {
          off.copy(N).multiplyScalar(0.6).addScaledVector(B, side * 0.8).normalize()
          v.copy(spine).addScaledVector(B, side * rad * 1.15).addScaledVector(N, -rad * 0.6)
          this.vert(v, off, color, g, spine, surf)
        }
      } else {
        for (let j = 0; j < radial; j++) {
          const th = (j / radial) * Math.PI * 2
          off.copy(N).multiplyScalar(Math.cos(th)).addScaledVector(B, Math.sin(th))
          // flatten a little where the vine lies on something
          v.set(spine.x + off.x * rad, spine.y + off.y * rad * (o.lift ? 0.75 : 1), spine.z + off.z * rad)
          this.vert(v, off, color, g, spine, surf)
        }
      }
      if (i > 0) {
        const r0 = base + (i - 1) * radial
        const r1 = base + i * radial
        if (flat) this.idx.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1)
        else {
          for (let j = 0; j < radial; j++) {
            const j1 = (j + 1) % radial
            this.idx.push(r0 + j, r1 + j, r0 + j1, r0 + j1, r1 + j, r1 + j1)
          }
        }
        travelled += prev.distanceTo(sp)
      }
      prev.copy(sp)

      // leaves along the way (several to a segment where the rings are far apart)
      while (travelled >= nextLeaf && i < n) {
        const back = travelled - nextLeaf
        nextLeaf += o.leafEvery * (0.6 + this.r() * 0.8)
        side = -side
        const pos = spine.clone().addScaledVector(T, -back).addScaledVector(B, side * rad * 0.7).addScaledVector(N, rad * 0.4)
        const dir = new THREE.Vector3()
          .addScaledVector(T, 0.45 + this.r() * 0.3)
          .addScaledVector(B, side * (0.7 + this.r() * 0.3))
          .addScaledVector(N, 0.35 + this.r() * 0.5)
          .normalize()
        const size = o.leafSize * (0.7 + this.r() * 0.6) * (0.55 + 0.45 * Math.min(1, t * 3 + 0.3))
        const tones = o.leafTones || LEAF_TONES
        this.leaves.push({
          m: leafMatrix(pos, dir, N, size),
          thr: g + 0.03 + this.r() * 0.05,
          phase: this.r() * Math.PI * 2,
          surf,
          sway: o.sway * (0.6 + this.r() * 0.8),
          color: tones[Math.floor(this.r() * tones.length)].clone().multiplyScalar(0.9 + this.r() * 0.2),
          appear: LONG_AGO,
          wither: NEVER,
        })
      }
    }
  }

  // A flat dark ribbon on the floor: the boards splitting where a root runs.
  addCrack(a: THREE.Vector3, b: THREE.Vector3, g0: number, g1: number, width: number): void {
    const dir = new THREE.Vector3().subVectors(b, a)
    const len = dir.length()
    dir.normalize()
    const perp = new THREE.Vector3(-dir.z, 0, dir.x)
    const n = Math.max(2, Math.ceil(len / 0.12))
    const base = this.vertexCount
    const v = new THREE.Vector3()
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const jag = (this.r() - 0.5) * width * 1.6
      const c = new THREE.Vector3().lerpVectors(a, b, t).addScaledVector(perp, jag)
      c.y = 0.004
      const w = width * (0.35 + 0.65 * Math.sin(Math.PI * t))
      for (const s of [-1, 1]) {
        v.set(c.x + perp.x * w * s, c.y, c.z + perp.z * w * s)
        this.vert(v, UP, CRACK, THREE.MathUtils.lerp(g0, g1, t), c, FREE)
      }
      if (i > 0) {
        const p = base + (i - 1) * 2
        this.idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2)
      }
    }
  }

  // Two boards prised up into a tent over a root, with cracks fanning out.
  addLiftedBoards(at: THREE.Vector3, along: THREE.Vector3, g: number): void {
    const across = new THREE.Vector3(-along.z, 0, along.x).normalize()
    for (const s of [-1, 1]) {
      // board pivots at its outer end and lifts its inner end over the root
      const pivot = at.clone().addScaledVector(across, s * 0.5)
      pivot.y = 0.0
      const dirToRoot = across.clone().multiplyScalar(-s)
      const m = new THREE.Matrix4()
      const z = dirToRoot
      const y = UP
      const x = new THREE.Vector3().crossVectors(y, z).normalize()
      m.makeBasis(x, y, z)
      m.setPosition(pivot.clone().addScaledVector(along, (this.r() - 0.5) * 0.18))
      this.boards.push({ m, thr: g + 0.02 + this.r() * 0.05, tilt: 0.2 + this.r() * 0.2 })
    }
    // the gap the boards came out of
    this.addCrack(at.clone().addScaledVector(along, -0.3), at.clone().addScaledVector(along, 0.3), g, g + 0.05, 0.16)
    for (let k = 0; k < 2; k++) {
      const ang = Math.atan2(along.z, along.x) + (this.r() - 0.5) * 2.2 + (k === 1 ? Math.PI : 0)
      const end = at.clone().add(new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)).multiplyScalar(0.35 + this.r() * 0.5))
      this.addCrack(at, end, g, g + 0.12, 0.022)
    }
  }
}

// ---------------------------------------------------------------------------
// shader chunks shared by the grown parts
// ---------------------------------------------------------------------------
const VIS_FN = /* glsl */ `
uniform float uG;
uniform float uTime;
uniform float uSway;
uniform float uNow;
uniform float uPlantScale;
uniform float uPulseY;
uniform float uPulseA;
uniform float uVital;
uniform float uBlight;
uniform float uNorth;
uniform float uGold;
// 1 when the surface this sits on is drawn from where the camera is
float ogVisible(vec3 wp, float surf) {
  if (surf > 1.5) return 1.0 - smoothstep(${(LAB_HEIGHT - 0.06).toFixed(2)}, ${(LAB_HEIGHT + 0.04).toFixed(2)}, cameraPosition.y);
  if (surf > 0.5) {
    vec2 rad = normalize(wp.xz);
    return 1.0 - smoothstep(-0.4, 0.4, dot(rad, cameraPosition.xz - wp.xz));
  }
  return 1.0;
}
float ogGrow(float thr, float span) {
  float k = clamp((uG - thr) / span, 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}
// 0..1 how far a piece has come into the world (x = when it appears), and
// 0..1 how far it has withered (y = when it starts to)
float ogBorn(vec2 life) { return smoothstep(life.x, life.x + 0.9, uNow); }
float ogWither(vec2 life) { return clamp((uNow - life.y) / 2.5, 0.0, 1.0); }
// the dry brown a withered piece ends up, a little different for each
vec3 ogBrown(vec3 p) {
  float h = fract(sin(dot(p.xz, vec2(12.9898, 78.233))) * 43758.5453);
  return mix(vec3(0.38, 0.27, 0.16), vec3(0.56, 0.44, 0.27), h);
}
`

type Shader = Parameters<THREE.Material['onBeforeCompile']>[0]

// The room's fog nearly whites out the far wall; growth there keeps a little
// more of its colour so the climbers still read from the usual view.
function lighterFog(sh: Shader): void {
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <fog_fragment>',
    `#ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
      #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      #endif
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * 0.5 );
    #endif`
  )
}

export class Overgrowth {
  public readonly group = new THREE.Group()

  private uniforms = {
    uG: { value: 0 },
    uTime: { value: 0 },
    uSway: { value: 1 },
    uNow: { value: 0 },
    uPlantScale: { value: 1 },
    uPulseY: { value: -1 },
    uPulseA: { value: 0 },
    uVital: { value: 1 },
    uBlight: { value: 0 },
    uNorth: { value: 0 },
    uGold: { value: 0 },
  }
  private fallUniforms = { uFall: { value: 0 }, uSpore: { value: 0 } }
  // falling leaves: aLeaf holds (x, z, speed, seed) instead of (threshold, phase, surface, sway)
  private falling: LeafSpec[] = []
  private shadeMat: THREE.ShaderMaterial
  private shadeMesh: THREE.Mesh | null = null
  private materials: THREE.Material[] = []
  private geometries: THREE.BufferGeometry[] = []

  // the base organism, built once
  private readonly body = new THREE.Group()
  private base: VineBuilder | null = null
  private anchors: Anchor[] = []
  private vineMat: THREE.MeshStandardMaterial | null = null
  private leafMat: THREE.MeshStandardMaterial | null = null
  // the merged stems and leaves, rebuilt when the events change
  private vines: THREE.Mesh | null = null
  private leaves: THREE.InstancedMesh | null = null
  private bodyTriangles = 0
  private effectTriangles = 0

  // the events drawn, and when each started to appear on this screen
  private events: GrowthEvent[] = []
  private levels: number[] = []
  private bays: ExhibitBayRef[] = []
  private builtKey = ''
  private appearAt = new Map<string, number>()
  private builtOnce = false
  public eventStats: GrowStats = { events: 0, rings: 0, leaves: 0, flowers: 0, buds: 0, desks: 0 }
  // triangles each kind of event adds, for checking the budget
  public costByKind: Record<string, { events: number; triangles: number }> = {}

  private level = 0 // what is drawn
  private target = 0 // what the record says
  // the flowering plant is built for the record's level (to the nearest 0.02)
  private plantLevel = 0
  private builtPlantLevel = -1
  private reducedMotion = false
  private time = 0 // sway clock, stops under reduced motion
  private now = 0 // the room's clock for growing in, always runs
  public triangleCount = 0

  constructor() {
    this.group.name = 'overgrowth'
    this.body.name = 'overgrowthBody'
    this.group.add(this.body)

    // --- falling leaves from the walls and canopy: drawn with the other
    // leaves (marked by FALLING), their loop runs in the leaf shader
    {
      const COUNT = 70
      const r = rng(7)
      const tone = new THREE.Color(0x8c9a48)
      for (let i = 0; i < COUNT; i++) {
        const rad = 1.8 + r() * 5.6
        const a = r() * Math.PI * 2
        this.falling.push({ m: new THREE.Matrix4(), thr: Math.cos(a) * rad, phase: Math.sin(a) * rad, surf: 0.05 + r() * 0.05, sway: r(), color: tone, appear: FALLING, wither: NEVER })
      }
    }

    // --- drifting spores (replace the dust motes as the room overgrows):
    // tiny pale flecks facing the camera, drawn with the leaves (marked by
    // SPORE); aLeaf holds (angle, radius, speed, seed)
    {
      const COUNT = 180
      const r = rng(11)
      const pale = new THREE.Color(0xedf2b8)
      for (let i = 0; i < COUNT; i++) {
        this.falling.push({ m: new THREE.Matrix4(), thr: r() * Math.PI * 2, phase: Math.sqrt(r()) * 7.4, surf: r(), sway: r(), color: pale, appear: SPORE, wither: NEVER })
      }
    }

    // --- the canopy's dappled shade on the floor
    {
      const geo = new THREE.CircleGeometry(LAB_RADIUS - 0.05, 48)
      geo.rotateX(-Math.PI / 2)
      this.shadeMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        uniforms: { uTime: this.uniforms.uTime, uAmt: { value: 0 } },
        vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          varying vec2 vP; uniform float uTime; uniform float uAmt;
          float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
          void main(){
            vec2 p = vP * 1.6 + vec2(sin(uTime * 0.05), cos(uTime * 0.04)) * 0.6;
            float leaf = n(p) * 0.6 + n(p * 2.3 + 7.0) * 0.4;
            float shade = smoothstep(0.42, 0.62, leaf);
            float edge = smoothstep(${(LAB_RADIUS - 0.05).toFixed(2)}, ${(LAB_RADIUS - 1.2).toFixed(2)}, length(vP));
            gl_FragColor = vec4(0.13, 0.17, 0.08, shade * 0.30 * uAmt * edge);
          }`,
      })
      const mesh = new THREE.Mesh(geo, this.shadeMat)
      mesh.position.y = 0.002
      mesh.name = 'overgrowthShade'
      this.shadeMesh = mesh
      mesh.renderOrder = 1
      this.group.add(mesh)
      this.track(geo, this.shadeMat)
    }

    this.effectTriangles += 2 * this.falling.length // falling leaves and spores
    this.triangleCount = this.effectTriangles
    this.group.visible = false
  }

  // The base organism and its materials, built the first time they are needed.
  private ensureBase(): void {
    if (this.base) return
    const b = new VineBuilder(BASE.seed)
    buildOrganism(b)
    this.base = b
    // where event growth can start from on it
    for (const a of b.anchors) {
      const c = toChart(a.p)
      if (c) this.anchors.push({ theta: c.theta, s: c.s, g: a.g, family: a.family })
    }

    // stems, roots, cracks, flowers and buds: one merged mesh
    const vineMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, side: THREE.DoubleSide })
    vineMat.onBeforeCompile = (sh: Shader) => {
      Object.assign(sh.uniforms, this.uniforms)
      lighterFog(sh)
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nattribute float aGrow;\nattribute vec3 aSpine;\nattribute vec3 aPrev;\nattribute float aSurf;\nattribute vec2 aLife;\nattribute vec4 aPlant;\n${VIS_FN}`)
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3(position);
          float ogB = ogBorn(aLife);
          float ogW = ogWither(aLife);
          float ogk = ogGrow(aGrow, 0.14) * ogVisible((modelMatrix * vec4(aSpine, 1.0)).xyz, aSurf);
          // berries: as many as the spec has, the rest not drawn
          if (aPlant.w > ${(PART.north - 0.5).toFixed(1)}) {
            float idx = fract(aPlant.w) * 100.0 + 0.5;
            ogk *= step(idx, aPlant.w < ${(PART.gold - 0.5).toFixed(1)} ? uNorth : uGold);
          }
          // a new ring slides out from the one before it, so a stem grows from its tip
          vec3 ogC = mix(aPrev, aSpine, ogB);
          transformed = ogC + (transformed - aSpine) * ogk * ogB * (1.0 - 0.3 * ogW);
          #if defined( USE_COLOR )
            vColor.rgb = mix(vColor.rgb, ogBrown(aSpine), ogW);
          #endif
          if (aPlant.x > 0.5) {
            // the flowering plant: grows about the foot of its stem while the
            // drawn level catches up with the record, and sways by height, so
            // everything on one stem moves together
            vec3 foot = vec3(0.0, ${SOIL_Y.toFixed(3)}, 0.0);
            transformed = foot + (transformed - foot) * uPlantScale;
            float h = max(0.0, transformed.y - foot.y) / 0.6;
            float ph = aPlant.z;
            vec2 wind = vec2(sin(uTime * 0.83 + ph) + 0.35 * sin(uTime * 1.9 + ph * 2.3), sin(uTime * 0.61 + ph * 1.7 + 1.1) + 0.3 * sin(uTime * 1.7 + ph));
            transformed.xz += wind * aPlant.y * h * h * 0.014 * uSway;
            #if defined( USE_COLOR )
              float part = floor(aPlant.w + 0.5);
              float hsh = fract(sin(dot(aSpine.xz * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
              // a tired spec dulls the leaves; unresolved conflicts brown a few
              if (part > 0.5 && part < 1.5) {
                vColor.rgb = mix(vColor.rgb, vec3(0.62, 0.58, 0.3), (1.0 - uVital) * 0.4);
                vColor.rgb = mix(vColor.rgb, ogBrown(aSpine), step(hsh, uBlight) * 0.85);
              }
              // gold shimmer travelling up the stem when real code merges
              vColor.rgb += vec3(1.0, 0.8, 0.35) * exp(-pow((transformed.y - uPulseY) * 9.0, 2.0)) * uPulseA;
              if (part > ${(PART.north - 0.5).toFixed(1)}) vColor.rgb *= 1.25 + 0.15 * sin(uTime * 2.6 + aPlant.w * 40.0);
            #endif
          }`
        )
    }
    vineMat.customProgramCacheKey = () => 'og-vine'
    this.vineMat = vineMat
    this.track(new THREE.BufferGeometry(), vineMat)

    const leafMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.7, metalness: 0 })
    leafMat.onBeforeCompile = (sh: Shader) => {
      Object.assign(sh.uniforms, this.uniforms, this.fallUniforms)
      lighterFog(sh)
      // spores are pale flecks of their own light, not lit like leaves
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vOgGlow;`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n  if (vOgGlow > 0.5) gl_FragColor.rgb = mix(vec3(0.93, 0.95, 0.72), gl_FragColor.rgb, 0.25);`)
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nattribute vec4 aLeaf;\nattribute vec2 aLeafLife;\nuniform float uFall;\nuniform float uSpore;\nvarying float vOgGlow;\n${VIS_FN}`)
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3(position);
          vOgGlow = 0.0;
          if (aLeafLife.x < ${(SPORE + 1).toFixed(1)}) {
            // a spore drifting up through the room, turned to face the camera
            float t = uTime * (0.02 + aLeaf.z * 0.03) + aLeaf.w;
            float y = fract(t) * ${(LAB_HEIGHT - 0.2).toFixed(2)} + 0.1;
            float a = aLeaf.x + sin(t * 6.2831 + aLeaf.z * 4.0) * 0.25;
            float r = aLeaf.y + sin(t * 9.0 + aLeaf.w * 6.0) * 0.3;
            float on = step(aLeaf.w, uSpore) * smoothstep(0.0, 0.15, fract(t)) * (1.0 - smoothstep(0.85, 1.0, fract(t)));
            vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            vec2 q = (position.xy - vec2(0.0, 0.5)) * (0.012 + aLeaf.z * 0.012) * on;
            transformed = vec3(cos(a) * r, y, sin(a) * r) + right * q.x + up * q.y;
            vOgGlow = 1.0;
          } else if (aLeafLife.x < ${(FALLING + 1).toFixed(1)}) {
            // a falling leaf, drifting down from the canopy on a loop
            float ft = uTime * aLeaf.z + aLeaf.w * 17.0;
            float ff = fract(ft);
            float on = step(aLeaf.w, uFall) * (1.0 - smoothstep(0.9, 1.0, ff)) * smoothstep(0.0, 0.04, ff);
            float ty = ft * 6.2831;
            vec3 p = position - vec3(0.0, 0.5, 0.0);
            float c1 = cos(ty * 1.7 + aLeaf.w * 9.0); float s1 = sin(ty * 1.7 + aLeaf.w * 9.0);
            p.xy = vec2(c1 * p.x - s1 * p.y, s1 * p.x + c1 * p.y);
            float c2 = cos(ty * 1.1); float s2 = sin(ty * 1.1);
            p.yz = vec2(c2 * p.y - s2 * p.z, s2 * p.y + c2 * p.z);
            transformed = p * 0.11 * on + vec3(
              aLeaf.x + sin(ty * 2.3 + aLeaf.w * 5.0) * 0.32,
              mix(${(LAB_HEIGHT - 0.2).toFixed(2)}, 0.03, ff),
              aLeaf.y + cos(ty * 1.9 + aLeaf.w * 3.0) * 0.32);
          } else {
          vec3 ogIp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float ogW = ogWither(aLeafLife);
          float ogk = ogGrow(aLeaf.x, 0.1) * ogVisible(ogIp, aLeaf.z) * ogBorn(aLeafLife) * (1.0 - 0.35 * ogW);
          float ogSw = sin(uTime * 1.3 + aLeaf.y) * aLeaf.w * uSway + sin(uTime * 0.53 + aLeaf.y * 2.0) * aLeaf.w * 0.5 * uSway + ogW * 0.9;
          float ogC = cos(ogSw); float ogS = sin(ogSw);
          transformed.yz = vec2(ogC * transformed.y - ogS * transformed.z, ogS * transformed.y + ogC * transformed.z);
          transformed *= ogk;
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            vColor.rgb = mix(vColor.rgb, ogBrown(ogIp), ogW);
          #endif
          }`
        )
    }
    leafMat.customProgramCacheKey = () => 'og-leaves'
    this.leafMat = leafMat
    this.track(new THREE.BufferGeometry(), leafMat)

    // --- lifted floorboards: baked into the stem mesh in their lifted pose,
    // each growing out of its pivot when the stage reaches it
    {
      const wood = new THREE.Color(0x67533f)
      const pos = new THREE.Vector3()
      const nor = new THREE.Vector3()
      const pivot = new THREE.Vector3()
      for (const bd of b.boards) {
        const geo = new THREE.BoxGeometry(0.21, 0.035, 0.5)
        geo.translate(0, 0.0175, 0.25) // pivot at the outer end, lying on the floor
        geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-bd.tilt))
        geo.applyMatrix4(bd.m)
        pivot.setFromMatrixPosition(bd.m)
        const P = geo.getAttribute('position')
        const Nn = geo.getAttribute('normal')
        const first = b.vertexCount
        for (let i = 0; i < P.count; i++) {
          pos.fromBufferAttribute(P, i)
          nor.fromBufferAttribute(Nn, i)
          b.vert(pos, nor, wood, bd.thr, pivot, FREE)
        }
        const idx = geo.getIndex()!
        for (let i = 0; i < idx.count; i++) b.idx.push(first + idx.getX(i))
        geo.dispose()
      }
    }
    this.rebuild()
  }

  /**
   * The real events to grow (oldest first), with the growth level each one
   * belongs to (growthEvents.ts eventLevels). Rebuilt only when the list or
   * the levels change, which is at most once an epoch.
   */
  public setEvents(events: GrowthEvent[], levels: number[]): void {
    this.events = events.slice()
    this.levels = events.map((_, i) => Math.round((levels[i] ?? 0) * 1000) / 1000)
    this.ensureBase()
    this.rebuild()
  }

  /** Where the exhibits stand, so a tendril for one reaches toward its shelf. */
  public setExhibitBays(bays: ExhibitBayRef[]): void {
    this.bays = bays.slice()
    if (this.base) this.rebuild()
  }

  private rebuild(): void {
    const base = this.base
    if (!base || !this.vineMat || !this.leafMat) return
    const key = eventsKey(this.events) + '|' + this.levels.join(',') + '|' + this.bays.map(b => `${b.angle.toFixed(3)}:${b.model}:${b.mergedAt}`).join(',') + '|' + this.plantLevel
    if (key === this.builtKey && this.vines) return
    this.builtKey = key
    this.builtPlantLevel = this.plantLevel

    // when each event starts to appear on this screen: history that is
    // already there on load (or under reduced motion) is simply there; new
    // events since the last poll grow in one after another
    const fresh = this.events.filter(e => !this.appearAt.has(e.id))
    const animate = this.builtOnce && !this.reducedMotion
    const gap = fresh.length ? Math.min(STAGGER, BATCH_SPAN / fresh.length) : 0
    fresh.forEach((e, k) => this.appearAt.set(e.id, animate ? this.now + 0.4 + k * gap : LONG_AGO))
    if (this.events.length) this.builtOnce = true

    const ev = new GrowthSink()
    const plant = new Specimen(this.plantLevel)
    plant.build(ev)
    const grower = new EventGrower(ev, this.anchors, this.bays, plant)
    const n = this.events.length
    this.costByKind = {}
    this.events.forEach((e, i) => {
      const level = this.levels[i]
      // shown once the plant has reached that stage
      const gate = Math.floor(level) - 0.3
      // the newest growth is fresh and leafy; older growth has gone woody
      const age = n - 1 - i
      const detail = age < FRESH ? 1 : age < WOODY ? 0.5 : 0.25
      const t0 = ev.idx.length / 3 + ev.leaves.length * 2
      grower.grow(e, i, level, gate, this.appearAt.get(e.id) ?? LONG_AGO, detail)
      const k = this.costByKind[e.kind] || (this.costByKind[e.kind] = { events: 0, triangles: 0 })
      k.events++
      k.triangles += ev.idx.length / 3 + ev.leaves.length * 2 - t0
    })
    this.eventStats = { ...grower.getStats() }

    const all = new GrowthSink()
    all.append(base)
    all.append(ev)

    // swap in the new meshes
    if (this.vines) {
      this.body.remove(this.vines)
      this.vines.geometry.dispose()
    }
    if (this.leaves) {
      this.body.remove(this.leaves)
      this.leaves.geometry.dispose()
      this.leaves.dispose()
    }
    const vineGeo = all.geometry()
    const vines = new THREE.Mesh(vineGeo, this.vineMat)
    vines.frustumCulled = false
    vines.name = 'overgrowthVines'
    this.body.add(vines)
    this.vines = vines

    this.leaves = this.instancedLeaves([...all.leaves, ...this.falling])
    this.body.add(this.leaves)

    this.bodyTriangles = Math.round((vineGeo.index?.count ?? 0) / 3 + all.leaves.length * 2)
    this.triangleCount = this.bodyTriangles + this.effectTriangles
  }

  private instancedLeaves(specs: LeafSpec[]): THREE.InstancedMesh {
    const geo = leafGeometry()
    const mesh = new THREE.InstancedMesh(geo, this.leafMat!, Math.max(1, specs.length))
    mesh.name = 'overgrowthLeaves'
    mesh.frustumCulled = false
    const attr = new Float32Array(Math.max(1, specs.length) * 4)
    const life = new Float32Array(Math.max(1, specs.length) * 2)
    const c = new THREE.Color(1, 1, 1)
    specs.forEach((sp, i) => {
      mesh.setMatrixAt(i, sp.m)
      mesh.setColorAt(i, sp.color)
      attr.set([sp.thr, sp.phase, sp.surf, sp.sway], i * 4)
      life.set([sp.appear, sp.wither], i * 2)
    })
    if (!specs.length) mesh.setColorAt(0, c)
    mesh.count = specs.length
    geo.setAttribute('aLeaf', new THREE.InstancedBufferAttribute(attr, 4))
    geo.setAttribute('aLeafLife', new THREE.InstancedBufferAttribute(life, 2))
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    return mesh
  }

  private track(geo: THREE.BufferGeometry, mat: THREE.Material): void {
    this.geometries.push(geo)
    this.materials.push(mat)
  }

  /** Growth level from the stored record (stage + progress, 0..7). */
  public setTarget(level: number, immediate = false): void {
    this.ensureBase()
    this.target = THREE.MathUtils.clamp(level, 0, 7)
    if (immediate || this.reducedMotion) this.level = this.target
    const pl = Math.round(Math.min(this.target, 4) * 50) / 50
    if (pl !== this.plantLevel) {
      this.plantLevel = pl
      this.rebuild()
    }
  }

  /**
   * What the spec says about the plant's health: leaf vitality 0..1, how many
   * conflicts are unresolved, North's and code-backed items (berries), and the
   * gold pulse when real code merges (0..1.3 up the stem, <0 off).
   */
  public setSpecSignals(o: { health: number; conflicts: number; north: number; gold: number; pulse: number; pulseStrength: number }): void {
    const u = this.uniforms
    u.uVital.value = THREE.MathUtils.clamp(o.health, 0, 1)
    u.uBlight.value = Math.min(3, Math.max(0, o.conflicts)) * 0.07
    u.uNorth.value = Math.min(BERRIES, Math.max(0, o.north))
    u.uGold.value = Math.min(BERRIES, Math.max(0, o.gold))
    const top = soilHeight(0) + plantHeight(this.level) + 0.08
    u.uPulseY.value = o.pulse < 0 ? -1 : SOIL_Y + o.pulse * (top - SOIL_Y)
    u.uPulseA.value = o.pulse < 0 ? 0 : o.pulseStrength
  }

  public getLevel(): number {
    return this.level
  }

  public setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
    this.uniforms.uSway.value = reduced ? 0 : 1
    if (reduced) {
      this.level = this.target
      // anything still growing in is shown as it ends up
      let changed = false
      for (const [id, t] of this.appearAt) {
        if (t > this.now - 20) {
          this.appearAt.set(id, LONG_AGO)
          changed = true
        }
      }
      if (changed) {
        this.builtKey = ''
        this.rebuild()
      }
    }
  }

  /** 0..1: how much the canopy has closed over the room (for light and fog). */
  public canopy(): number {
    return THREE.MathUtils.smoothstep(this.level, 5.6, 7)
  }

  /** 0..1: how far spores and falling leaves have replaced the dust. */
  public airborne(): number {
    return THREE.MathUtils.smoothstep(this.level, 3.4, 5.6)
  }

  public update(dt: number): void {
    this.ensureBase()
    const d = Math.min(dt, 0.05)
    // Ease toward the record: a stage change unfolds over roughly ten
    // seconds, a small step in progress over a second or two.
    const gap = this.target - this.level
    if (Math.abs(gap) > 1e-4) {
      const rate = Math.max(0.05, Math.abs(gap) * 0.2)
      this.level += Math.sign(gap) * Math.min(Math.abs(gap), rate * d)
    }
    if (!this.reducedMotion) this.time += d
    // growing in follows real time even when frames are slow (a hidden tab pauses it)
    this.now += Math.min(Math.max(dt, 0), 0.5)
    this.uniforms.uG.value = this.level
    this.uniforms.uTime.value = this.time
    this.uniforms.uNow.value = this.now
    // the plant grows into its new build while the drawn level catches up
    const built = this.builtPlantLevel < 0 ? this.level : this.builtPlantLevel
    this.uniforms.uPlantScale.value = THREE.MathUtils.clamp(plantHeight(this.level) / plantHeight(built), 0.6, 1.4)
    this.group.visible = true
    const air = this.airborne()
    this.fallUniforms.uSpore.value = this.reducedMotion ? air * 0.5 : air
    this.fallUniforms.uFall.value = this.reducedMotion ? 0 : THREE.MathUtils.smoothstep(this.level, 5.3, 7) * 0.9
    this.shadeMat.uniforms.uAmt.value = this.canopy()
    if (this.shadeMesh) this.shadeMesh.visible = this.canopy() > 0.001
  }

  public dispose(): void {
    this.vines?.geometry.dispose()
    this.leaves?.geometry.dispose()
    this.leaves?.dispose()
    this.geometries.forEach(g => g.dispose())
    this.materials.forEach(m => m.dispose())
  }
}


// ---------------------------------------------------------------------------
// The organism's layout. Five main runners leave the plant; each splits into
// a root that heads for a desk and one that heads for the wall.
// ---------------------------------------------------------------------------
function stationFrame(i: number): THREE.Matrix4 {
  const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2
  const m = new THREE.Matrix4().makeRotationY(-angle - Math.PI / 2)
  m.setPosition(Math.cos(angle) * STATION_RADIUS, 0, Math.sin(angle) * STATION_RADIUS)
  return m
}

// Desk lamp x/z on each station's desk (Station.ts), planner first.
const LAMP_LOCAL: Array<[number, number]> = [
  [0.7, -0.1],
  [-0.7, 0.1],
  [-0.7, -0.2],
  [-0.7, 0.15],
  [0.65, 0.2],
]

function cp(p: THREE.Vector3, g: number, r: number, n: THREE.Vector3 = UP, s = FREE): CP {
  return { p, g, r, n: n.clone(), s }
}

function buildOrganism(b: VineBuilder): void {
  const R = () => b.r()
  const P = BASE
  // more behaviours, denser leaves: leaf spacing shrinks
  const every = (v: number) => v / P.leafDensity
  const root: PathOpts = { radial: 4, spacing: 0.3, lift: true, c0: ROOT_DARK, c1: ROOT, leafEvery: every(0.3), leafSize: 0.13, sway: 0.08 }
  const vine: PathOpts = { radial: 3, spacing: 0.28, lift: true, c0: VINE_OLD, c1: VINE_YOUNG, leafEvery: every(0.1), leafSize: 0.22, sway: 0.18 }
  const tendril: PathOpts = { radial: 3, spacing: 0.1, lift: true, c0: VINE_OLD, c1: VINE_YOUNG, leafEvery: every(0.15), leafSize: 0.1, sway: 0.15 }
  const hanging: PathOpts = { radial: 3, spacing: 0.2, lift: false, c0: VINE_OLD, c1: VINE_YOUNG, leafEvery: every(0.13), leafSize: 0.15, sway: 0.3 }
  // more constraints, thicker roots
  const girth = P.rootGirth

  // This run's habit, all from the seed: which way the runners wind out of
  // the dome, which way the canopy turns, how restless the climbers are.
  const twist = R() < 0.5 ? 1 : -1
  const sweep = R() < 0.5 ? 1 : -1
  const wave = 0.03 + R() * 0.09
  const waveF = 3 + R() * 5
  const splitR = 2.2 + R() * 0.8

  // the station angles, and the gaps between desks where roots run to the wall
  const deskAngles = [0, 1, 2, 3, 4].map(i => (i * 2 * Math.PI) / 5 - Math.PI / 2)

  // more capabilities, more climbing runners: share them out over the ten
  // rail runs (five runners, two ways each), in a seeded order
  const sides: Array<{ k: number; dirA: number; climbers: number }> = []
  for (let k = 0; k < 5; k++) for (const dirA of [-1, 1]) sides.push({ k, dirA, climbers: 0 })
  for (let i = sides.length - 1; i > 0; i--) {
    const j = Math.floor(R() * (i + 1))
    ;[sides[i], sides[j]] = [sides[j], sides[i]]
  }
  for (let c = 0; c < P.climbers; c++) sides[c % sides.length].climbers++

  for (let k = 0; k < 5; k++) {
    b.family = k
    // start far enough round that the runner leaves the dome facing its desk
    const a0 = deskAngles[k] - twist * (2.2 + (R() - 0.5) * 0.4)

    // inside the dome: once the plant fills it (stage 2) a runner leaves the
    // foot of its stem, creeps over the soil to the glass, and climbs the
    // inside of it, pressing on it
    const inner: CP[] = []
    for (let j = 0; j <= 4; j++) {
      const t = j / 4
      const a = a0 + twist * t * 0.9
      const r = 0.03 + t * 0.69
      inner.push(cp(polar(r, a, soilHeight(r) + 0.008 + Math.sin(t * Math.PI) * (0.02 + R() * 0.03)), 2.0 + t * 0.4, 0.013 + t * 0.009))
    }
    const hug: CP[] = []
    const aH = a0 + twist * 0.9
    const climbDome = 0.9 + R() * 0.4
    for (let j = 1; j <= 6; j++) {
      const t = j / 6
      const el = 0.12 + t * climbDome // elevation on the dome, radians
      const az = aH + twist * t * 1.3
      const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
      hug.push(cp(DOME_C.clone().addScaledVector(dir, 0.9), 2.4 + t * 0.55, 0.023 + t * 0.008, dir.clone().negate()))
    }
    // out over the broken rim and down the wooden base to the floor (stage 3)
    const top = hug[hug.length - 1].p
    const aOut = Math.atan2(top.z, top.x) + twist * 0.25
    const spill: CP[] = [
      cp(polar(1.02, aOut, 0.62), 3.06, 0.034),
      cp(polar(1.12, aOut + twist * 0.05, 0.34), 3.18, 0.04),
      cp(polar(1.38, aOut + twist * 0.08, 0.22), 3.3, 0.054, polar(1, aOut, 0.6).normalize()),
      cp(polar(1.55, aOut + twist * 0.1, 0.0), 3.42, 0.062),
    ]
    const trunk = [...inner, ...hug, ...spill]
    b.addPath(trunk, { ...tendril, radial: 4, spacing: 0.15, leafEvery: every(0.2), leafSize: 0.11, round: true })

    // across the floor (stage 4), splitting toward a desk and the wall
    const aS = aOut + twist * 0.25
    const split = polar(splitR, aS, 0)
    const toSplit = [cp(polar(1.55, aOut + twist * 0.1, 0), 3.42, 0.062 * girth), cp(polar((1.55 + splitR) / 2, aOut + twist * 0.2 + (R() - 0.5) * 0.3, 0), 3.62, 0.06 * girth), cp(split, 3.85, 0.056 * girth)]
    b.addPath(toSplit, root)
    b.addLiftedBoards(polar((1.55 + splitR) / 2 + 0.1, aOut + twist * 0.2, 0), polar(1, aOut + twist * 0.2, 0), 3.66)

    // ---- desk branch: to a centre-facing leg, up it, across the desk to the lamp
    const st = stationFrame(k)
    const [lx, lz] = LAMP_LOCAL[k]
    const sx = (R() < 0.7 ? Math.sign(lx) : -Math.sign(lx)) || 1
    const legL = new THREE.Vector3(sx * 0.8, 0, 0.35)
    const legW = legL.clone().applyMatrix4(st)
    const deskRoot: CP[] = [cp(split, 3.85, 0.05 * girth)]
    {
      const steps = 4
      const amp = 0.15 + R() * 0.3
      for (let j = 1; j <= steps; j++) {
        const t = j / steps
        const p = new THREE.Vector3().lerpVectors(split, legW, t)
        const perp = new THREE.Vector3(-(legW.z - split.z), 0, legW.x - split.x).normalize()
        if (j < steps) p.addScaledVector(perp, Math.sin(t * Math.PI * 2 + k) * amp)
        p.y = 0
        deskRoot.push(cp(p, 3.85 + t * 1.0, (0.05 - t * 0.026) * girth))
      }
    }
    // a gentle hop around the leg base, then the climb
    const helix: CP[] = []
    const turns = 1.5 + R() * 1.5
    for (let j = 0; j <= 18; j++) {
      const t = j / 18
      const th = t * turns * Math.PI * 2 * twist + k
      const local = new THREE.Vector3(legL.x + Math.cos(th) * 0.058, 0.02 + t * 0.74, legL.z + Math.sin(th) * 0.058)
      const nrm = new THREE.Vector3(Math.cos(th), 0, Math.sin(th)).transformDirection(st)
      helix.push(cp(local.applyMatrix4(st), 5.0 + t * 0.45, 0.02, nrm))
    }
    const deskTop = (x: number, z: number, y = 0.848) => new THREE.Vector3(x, y, z).applyMatrix4(st)
    const toLamp: CP[] = [
      cp(deskTop(sx * 0.82, 0.47, 0.8), 5.4, 0.016, new THREE.Vector3(0, 0, 1).transformDirection(st)),
      cp(deskTop(sx * 0.74, 0.42), 5.46, 0.015),
      cp(deskTop((sx * 0.74 + lx) / 2, (0.42 + lz) / 2 + 0.06), 5.55, 0.014),
      cp(deskTop(lx + 0.04, lz + 0.05), 5.64, 0.013),
    ]
    // round the brass stem and along the arm to the shade
    const lampUp: CP[] = []
    for (let j = 0; j <= 10; j++) {
      const t = j / 10
      const th = t * Math.PI * 3.2 * twist + k
      lampUp.push(cp(new THREE.Vector3(lx + Math.cos(th) * 0.026, 0.86 + t * 0.24, lz + Math.sin(th) * 0.026).applyMatrix4(st), 5.66 + t * 0.26, 0.009, new THREE.Vector3(Math.cos(th), 0, Math.sin(th)).transformDirection(st)))
    }
    lampUp.push(cp(new THREE.Vector3(lx + 0.06, 1.15, lz).applyMatrix4(st), 5.96, 0.008))
    lampUp.push(cp(new THREE.Vector3(lx + 0.12, 1.2, lz + 0.02).applyMatrix4(st), 6.02, 0.007))
    b.addPath([...deskRoot], root)
    b.addPath([...helix, ...toLamp, ...lampUp], { ...tendril, spacing: 0.075 })
    // a tendril dropping from the shade
    b.addPath(
      [
        cp(new THREE.Vector3(lx + 0.12, 1.2, lz + 0.02).applyMatrix4(st), 6.02, 0.006),
        cp(new THREE.Vector3(lx + 0.16, 1.06, lz + 0.05).applyMatrix4(st), 6.15, 0.005),
        cp(new THREE.Vector3(lx + 0.15, 0.95 - R() * 0.2, lz + 0.03).applyMatrix4(st), 6.3, 0.004),
      ],
      { ...hanging, leafEvery: every(0.07), leafSize: 0.06 }
    )
    // and, on most desks, one along the front edge to the far leg and down it
    if (R() < 0.75) {
      const edge: CP[] = []
      for (let j = 0; j <= 6; j++) {
        const t = j / 6
        edge.push(cp(deskTop(sx * 0.8 - sx * 1.6 * t, 0.46, 0.79 + Math.sin(t * Math.PI * 3) * 0.015), 5.42 + t * 0.4, 0.014, new THREE.Vector3(0, 0, 1).transformDirection(st)))
      }
      for (let j = 1; j <= 8; j++) {
        const t = j / 8
        const th = t * 1.7 * Math.PI * 2
        const nrm = new THREE.Vector3(Math.cos(th), 0, Math.sin(th)).transformDirection(st)
        edge.push(cp(new THREE.Vector3(-sx * 0.8 + Math.cos(th) * 0.056, 0.76 - t * 0.7, 0.35 + Math.sin(th) * 0.056).applyMatrix4(st), 5.82 + t * 0.3, 0.012, nrm))
      }
      b.addPath(edge, { ...tendril, spacing: 0.1, leafEvery: every(0.2) })
    }

    // ---- wall branch: across the floor to the brass rail, in the gap on
    // one side of the desk or the other
    const gapSide = R() < 0.5 ? 1 : -1
    let aW = deskAngles[k] + gapSide * Math.PI / 5 + (R() - 0.5) * 0.35
    // take the short way round
    while (aW - aS > Math.PI) aW -= Math.PI * 2
    while (aW - aS < -Math.PI) aW += Math.PI * 2
    const wallAt = (t: number) => THREE.MathUtils.lerp(aS, aW, Math.min(1, t * 1.3)) + Math.sin(t * waveF + k) * wave
    const wallRoot: CP[] = [cp(split, 3.85, 0.056 * girth)]
    for (let j = 1; j <= 6; j++) {
      const t = j / 6
      const r = THREE.MathUtils.lerp(splitR, RAIL_R - 0.12, t)
      wallRoot.push(cp(polar(r, wallAt(t), 0), 3.85 + t * 1.1, (0.056 - t * 0.024) * girth))
    }
    b.addPath(wallRoot, root)
    const tAtR = (rr: number) => (rr - splitR) / (RAIL_R - 0.12 - splitR)
    // more constraints, more of the floor prised up along the way
    // each runner lifts its own boards at its own distances, so the five runners never echo each other
    const boardCount = Math.min(P.boardsPerRun, 1 + Math.floor(R() * P.boardsPerRun))
    for (let k = 0; k < boardCount; k++) {
      const rr = 3.6 + R() * 3.0
      const t = tAtR(rr + (R() - 0.5) * 0.4)
      const a = wallAt(t)
      b.addLiftedBoards(polar(rr, a, 0), polar(1, a, 0), 3.85 + t * 1.1)
    }
    // side roots off the wall branch: more and wider with more constraints
    for (let j = 0; j < P.sideRoots; j++) {
      const rr = splitR + 0.5 + ((j + R() * 0.8) / P.sideRoots) * (RAIL_R - splitR - 1.6)
      const t = tAtR(rr)
      const a = wallAt(t)
      const dir = (R() < 0.5 ? -1 : 1) * (0.1 + R() * 0.1) * P.rootSpread
      const reach = P.rootSpread
      const g = 3.85 + t * 1.1
      b.addPath(
        [cp(polar(rr, a, 0), g, 0.02 * girth), cp(polar(rr + 0.45 * reach, a + dir, 0), g + 0.2, 0.014 * girth), cp(polar(Math.min(RAIL_R - 0.2, rr + 0.75 * reach), a + dir * 2.2, 0), g + 0.35, 0.008 * girth)],
        { ...root, radial: 3, leafEvery: every(0.5) }
      )
    }

    // ---- along the brass rail both ways (stage 5), then up the wall
    for (const dirA of [-1, 1]) {
      const climbers = sides.find(sd => sd.k === k && sd.dirA === dirA)?.climbers ?? 0
      const span = 0.3 + R() * 0.45
      const rail: CP[] = [cp(polar(RAIL_R - 0.12, aW, 0), 4.95, 0.03)]
      for (let j = 1; j <= 6; j++) {
        const t = j / 6
        rail.push(cp(polar(RAIL_R, aW + dirA * span * t, 0.105), 5.0 + t * 0.4, 0.028, UP))
      }
      if (climbers === 0) {
        b.addPath(rail, { ...vine, spacing: 0.34 })
        continue
      }
      const aC = aW + dirA * span
      const climb: CP[] = []
      const lean = (R() - 0.3) * 0.16
      for (let j = 0; j <= 8; j++) {
        const t = j / 8
        const y = 0.2 + t * (LAB_HEIGHT - 0.55)
        const a = aC + Math.sin(t * waveF + k + dirA) * wave + dirA * t * lean
        const p = polar(WALL_R, a, y)
        climb.push(cp(p, 5.4 + t * 0.6, 0.036 - t * 0.012, inward(p), WALL))
      }
      // over the crown moulding and onto the ceiling, toward the lamp (stage 6)
      const aT = aC + dirA * 0.08
      const turn = dirA * sweep * (0.25 + R() * 0.8)
      const ceiling: CP[] = [
        cp(polar(LAB_RADIUS - 0.12, aT, LAB_HEIGHT - 0.2), 6.02, 0.022, inward(polar(1, aT, 0)), WALL),
        cp(polar(LAB_RADIUS - 0.3, aT, CEIL_Y), 6.08, 0.022, DOWN, CEIL),
      ]
      const reachIn = 0.4 + R() * 1.8
      for (let j = 1; j <= 7; j++) {
        const t = j / 7
        const r = THREE.MathUtils.lerp(LAB_RADIUS - 0.3, reachIn, t)
        const a = aT + t * turn + Math.sin(t * 6 + k) * 0.12
        ceiling.push(cp(polar(r, a, CEIL_Y), 6.08 + t * 0.75, 0.022 - t * 0.01, DOWN, CEIL))
      }
      b.addPath([...rail, ...climb], { ...vine, spacing: 0.34 })
      // younger climbers from along the rail run
      for (let c = 1; c < climbers; c++) {
        const aM = aW + dirA * span * (c / climbers) + (R() - 0.5) * 0.05
        const height = 0.55 + R() * 0.35
        const mid: CP[] = []
        for (let j = 0; j <= 7; j++) {
          const t = j / 7
          const p = polar(WALL_R, aM + Math.sin(t * waveF * 0.8 + k * 2 + dirA + c) * wave, 0.12 + t * LAB_HEIGHT * height)
          mid.push(cp(p, 5.2 + t * 0.75, 0.03 - t * 0.012, inward(p), WALL))
        }
        b.addPath(mid, { ...vine, spacing: 0.34 })
      }
      b.addPath(ceiling, { ...vine, spacing: 0.36, leafEvery: every(0.08), leafSize: 0.3, leafTones: CANOPY_TONES })

      // canopy side shoots across the ceiling, with tendrils hanging down
      const shoots = 2 + Math.floor(R() * 2)
      for (let s = 0; s < shoots; s++) {
        const t = 0.15 + (s / shoots) * 0.75 + R() * 0.08
        const r = THREE.MathUtils.lerp(LAB_RADIUS - 0.3, reachIn, t)
        const a = aT + t * turn
        const g = 6.08 + t * 0.75
        const side = (R() < 0.5 ? -1 : 1) * (0.25 + R() * 0.2)
        const shoot = [
          cp(polar(r, a, CEIL_Y), g, 0.014, DOWN, CEIL),
          cp(polar(Math.max(0.5, r - 0.4), a + side * 0.6, CEIL_Y), g + 0.15, 0.011, DOWN, CEIL),
          cp(polar(Math.max(0.5, r - 0.6), a + side * 1.3, CEIL_Y), g + 0.28, 0.008, DOWN, CEIL),
        ]
        b.addPath(shoot, { ...vine, spacing: 0.3, leafEvery: every(0.08), leafSize: 0.28, leafTones: CANOPY_TONES })
        if (R() < 0.65) {
          const end = shoot[2].p
          const drop = 0.5 + R() * 0.9
          b.addPath(
            [
              cp(end.clone(), g + 0.28, 0.007, inward(end), CEIL),
              cp(end.clone().add(new THREE.Vector3(0.05, -drop * 0.5, 0.03)), g + 0.4, 0.006, inward(end), CEIL),
              cp(end.clone().add(new THREE.Vector3(0.02, -drop, 0.06)), g + 0.55, 0.004, inward(end), CEIL),
            ],
            hanging
          )
        }
      }
      // drapes off the crown, down the wall: what you see of the canopy from above
      const drapes = 1 + Math.floor(R() * 2)
      for (let s = 0; s < drapes; s++) {
        const a = aC + dirA * (0.06 + s * 0.1) + (R() - 0.5) * 0.06
        const len = 0.5 + R() * 1.4
        const p0 = polar(LAB_RADIUS - 0.08, a, LAB_HEIGHT - 0.12)
        b.addPath(
          [
            cp(p0, 6.05 + s * 0.05, 0.01, inward(p0), WALL),
            cp(polar(LAB_RADIUS - 0.04, a + 0.02, LAB_HEIGHT - 0.12 - len * 0.5), 6.25 + s * 0.05, 0.008, inward(p0), WALL),
            cp(polar(LAB_RADIUS, a + 0.03, LAB_HEIGHT - 0.12 - len), 6.5 + s * 0.05, 0.005, inward(p0), WALL),
          ],
          { ...hanging, leafEvery: every(0.12), leafSize: 0.16 }
        )
      }
    }
  }

  b.family = -1

  // wound round the brass crown moulding, linking the climbers into one rim.
  // It is a real object in front of the room on the near side too, so these
  // stay visible from everywhere.
  const crownY = LAB_HEIGHT - 0.08
  const crowns = 3 + Math.floor(R() * 2)
  const crownStart = R() * Math.PI * 2
  for (let k = 0; k < crowns; k++) {
    const a0 = crownStart + (k / crowns) * Math.PI * 2 + (R() - 0.5) * 0.4
    const arc = 0.4 + R() * 0.45
    const crown: CP[] = []
    const steps = 28
    for (let j = 0; j <= steps; j++) {
      const t = j / steps
      const a = a0 + sweep * t * arc
      const phi = t * arc * LAB_RADIUS * 2.2 + k // about one wrap per half metre
      const radial = polar(1, a, 0)
      const nrm = radial.clone().multiplyScalar(Math.cos(phi)).addScaledVector(UP, Math.sin(phi))
      const p = polar(LAB_RADIUS, a, crownY).addScaledVector(nrm, 0.08)
      crown.push(cp(p, 6.0 + t * 0.7, 0.022 - t * 0.008, nrm))
    }
    b.addPath(crown, { ...vine, spacing: 0.15, leafEvery: every(0.16), leafSize: 0.17 })
  }

  // around the central lamp: the canopy closes over the light
  const rings = 2 + Math.floor(R() * 2)
  const ringStart = R() * Math.PI * 2
  for (let k = 0; k < rings; k++) {
    const a0 = ringStart + (k / rings) * Math.PI * 2
    const ring: CP[] = []
    const bulge = 0.05 + R() * 0.15
    for (let j = 0; j <= 5; j++) {
      const t = j / 5
      ring.push(cp(polar(0.5 + Math.sin(t * Math.PI) * bulge, a0 + sweep * t * 1.6, CEIL_Y), 6.75 + t * 0.2, 0.012, DOWN, CEIL))
    }
    b.addPath(ring, { ...vine, spacing: 0.2, leafEvery: every(0.07), leafSize: 0.26, leafTones: CANOPY_TONES })
    const end = ring[ring.length - 1].p
    b.addPath(
      [cp(end.clone(), 6.95, 0.006, inward(end), CEIL), cp(end.clone().add(new THREE.Vector3(0.04, -0.4 - R() * 0.4, 0.0)), 7.0, 0.004, inward(end), CEIL)],
      hanging
    )
  }
}
