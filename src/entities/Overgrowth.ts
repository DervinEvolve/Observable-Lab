import * as THREE from 'three'
import { LAB_RADIUS, LAB_HEIGHT } from '../scene/Lab'
import { STATION_RADIUS } from './Station'
import { flowerAccents, shapeKey, shapeParams, type OrganismShape } from '../systems/organismShape'

// The specimen taking over the room. One organism grows out of the dome:
// tendrils fill the glass, press on it, spill over the broken rim, root across
// the floor (cracking and lifting boards), climb desk legs and lamps, run along
// the brass rail, climb the walls, and finally knit a canopy over the ceiling.
//
// Everything is driven by one number, the growth level G = stage + progress
// (0..7), reported by the backend from stored epochs. Each vertex and leaf
// carries the G at which it appears, so growth is a single uniform per frame:
// no geometry is rebuilt, nothing pops.
//
// Cost: six draw calls (vines, leaves, flowers, boards, falling leaves,
// spores) plus the canopy shade on the floor. None of them cast shadows.

const WALL_R = LAB_RADIUS + 0.22 // just in front of the wall surface (8.3)
const RAIL_R = LAB_RADIUS // brass baseboard ring
const CEIL_Y = LAB_HEIGHT - 0.03
const DOME_C = new THREE.Vector3(0, 0.3, 0)
const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

// Surfaces, used by the shader to hide growth on walls or the ceiling that the
// camera is looking through (the room is open on the near side, like a doll's
// house, and the ceiling is only drawn from below).
const FREE = 0
const WALL = 1
const CEIL = 2

// Bark, vine and leaf tones that sit with the wood, brass and cream of the lab.
const ROOT_DARK = new THREE.Color(0x8a6a44)
const ROOT = new THREE.Color(0x8f8a4c)
const VINE_OLD = new THREE.Color(0x6e6a3c)
const VINE_YOUNG = new THREE.Color(0x8db04e)
const CRACK = new THREE.Color(0x1e1610)
const LEAF_TONES = [0x6f9a42, 0x7cb342, 0x8bc34a, 0x5f8a3a, 0x9ab755, 0x76a544].map(c => new THREE.Color(c))
const CANOPY_TONES = [0x5f8a3a, 0x6f9a42, 0x4f7a34, 0x7cb342].map(c => new THREE.Color(c))
const CREAM = new THREE.Color(0xf4ecd8)
// before any record: the stage 6 minimums from docs/GROWTH.md, no merges known
const DEFAULT_SHAPE: OrganismShape = { seed: 20261113, capabilities: 20, constraints: 10, behaviors: 30, merges: [], mergedTotal: 0 }
const FLOWER_TONES = [0xf4ecd8, 0xe9c2b8, 0xf2d98d, 0xd9cce6, 0xf7f1e6].map(c => new THREE.Color(c))

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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
  flowerChance: number
  sway: number
}

interface LeafSpec {
  m: THREE.Matrix4
  thr: number
  phase: number
  surf: number
  sway: number
  color: THREE.Color
}

// Geometry being collected for the merged vine mesh
class VineBuilder {
  pos: number[] = []
  nor: number[] = []
  col: number[] = []
  grow: number[] = []
  spine: number[] = []
  surf: number[] = []
  idx: number[] = []
  leaves: LeafSpec[] = []
  flowers: LeafSpec[] = []
  boards: Array<{ m: THREE.Matrix4; thr: number; tilt: number }> = []
  private rand: () => number

  constructor(seed: number) {
    this.rand = rng(seed)
  }

  r(): number {
    return this.rand()
  }

  addPath(cps: CP[], o: PathOpts): void {
    if (cps.length < 2) return
    const curve = new THREE.CatmullRomCurve3(cps.map(c => c.p), false, 'centripetal')
    const len = curve.getLength()
    const n = Math.max(3, Math.ceil(len / o.spacing))
    const last = cps.length - 1
    const T = new THREE.Vector3()
    const N = new THREE.Vector3()
    const B = new THREE.Vector3()
    const sp = new THREE.Vector3()
    const off = new THREE.Vector3()
    const color = new THREE.Color()
    const base = this.pos.length / 3
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
      const sx = sp.x + N.x * lift
      const sy = sp.y + N.y * lift
      const sz = sp.z + N.z * lift
      color.copy(o.c0).lerp(o.c1, Math.min(1, t * 1.2))

      for (let j = 0; j < o.radial; j++) {
        const th = (j / o.radial) * Math.PI * 2
        off.copy(N).multiplyScalar(Math.cos(th)).addScaledVector(B, Math.sin(th))
        // flatten a little where the vine lies on something
        const flat = o.lift ? 0.75 : 1
        this.pos.push(sx + off.x * rad, sy + off.y * rad * (o.lift ? flat : 1), sz + off.z * rad)
        this.nor.push(off.x, off.y, off.z)
        this.col.push(color.r, color.g, color.b)
        this.grow.push(g)
        this.spine.push(sx, sy, sz)
        this.surf.push(surf)
      }
      if (i > 0) {
        const r0 = base + (i - 1) * o.radial
        const r1 = base + i * o.radial
        for (let j = 0; j < o.radial; j++) {
          const j1 = (j + 1) % o.radial
          this.idx.push(r0 + j, r1 + j, r0 + j1, r0 + j1, r1 + j, r1 + j1)
        }
        travelled += prev.distanceTo(sp)
      }
      prev.copy(sp)

      // leaves and the odd flower along the way
      if (travelled >= nextLeaf && i < n) {
        nextLeaf = travelled + o.leafEvery * (0.6 + this.r() * 0.8)
        side = -side
        const pos = new THREE.Vector3(sx, sy, sz).addScaledVector(B, side * rad * 0.7).addScaledVector(N, rad * 0.4)
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
        })
        if (this.r() < o.flowerChance) {
          const fpos = new THREE.Vector3(sx, sy, sz).addScaledVector(B, -side * rad * 0.9).addScaledVector(N, rad * 1.1)
          const facing = N.clone().addScaledVector(B, -side * 0.4).normalize()
          this.flowers.push({
            m: flowerMatrix(fpos, facing, T, 0.045 + this.r() * 0.035),
            thr: g + 0.22 + this.r() * 0.2,
            phase: this.r() * Math.PI * 2,
            surf,
            sway: o.sway,
            color: FLOWER_TONES[Math.floor(this.r() * FLOWER_TONES.length)].clone(),
          })
        }
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
    const base = this.pos.length / 3
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const jag = (this.r() - 0.5) * width * 1.6
      const c = new THREE.Vector3().lerpVectors(a, b, t).addScaledVector(perp, jag)
      c.y = 0.004
      const w = width * (0.35 + 0.65 * Math.sin(Math.PI * t))
      for (const s of [-1, 1]) {
        this.pos.push(c.x + perp.x * w * s, c.y, c.z + perp.z * w * s)
        this.nor.push(0, 1, 0)
        this.col.push(CRACK.r, CRACK.g, CRACK.b)
        this.grow.push(THREE.MathUtils.lerp(g0, g1, t))
        this.spine.push(c.x, c.y, c.z)
        this.surf.push(FREE)
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

  vineGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    geo.setAttribute('aGrow', new THREE.Float32BufferAttribute(this.grow, 1))
    geo.setAttribute('aSpine', new THREE.Float32BufferAttribute(this.spine, 3))
    geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 1))
    geo.setIndex(this.idx)
    geo.computeBoundingSphere()
    return geo
  }
}

// Leaf: blade along +Y from its stalk at the origin, face normal +Z, folded
// along the midrib.
function leafGeometry(): THREE.BufferGeometry {
  const v = [
    0, 0, 0, // 0 base
    0, 0.5, -0.02, // 1 midrib
    0, 1, 0.04, // 2 tip
    -0.34, 0.42, 0.1, // 3 left
    0.34, 0.42, 0.1, // 4 right
  ]
  const idx = [0, 3, 1, 3, 2, 1, 0, 1, 4, 1, 2, 4]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

function leafMatrix(pos: THREE.Vector3, dir: THREE.Vector3, normal: THREE.Vector3, size: number): THREE.Matrix4 {
  const y = dir.clone().normalize()
  const z = normal.clone().addScaledVector(y, -normal.dot(y))
  if (z.lengthSq() < 1e-6) z.set(1, 0, 0)
  z.normalize()
  const x = new THREE.Vector3().crossVectors(y, z).normalize()
  const m = new THREE.Matrix4().makeBasis(x.multiplyScalar(size), y.multiplyScalar(size), z.multiplyScalar(size))
  m.setPosition(pos)
  return m
}

// Flower: five petals in the XY plane facing +Z, gold centre.
function flowerGeometry(): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0.12]
  const col: number[] = [0.95, 0.75, 0.3]
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    const r = i % 2 === 0 ? 1 : 0.42
    pos.push(Math.cos(a) * r, Math.sin(a) * r, i % 2 === 0 ? 0.18 : 0)
    col.push(1, 1, 1)
  }
  const idx: number[] = []
  for (let i = 0; i < 10; i++) idx.push(0, 1 + i, 1 + ((i + 1) % 10))
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

function flowerMatrix(pos: THREE.Vector3, facing: THREE.Vector3, tangent: THREE.Vector3, size: number): THREE.Matrix4 {
  const z = facing.clone().normalize()
  const x = tangent.clone().addScaledVector(z, -tangent.dot(z))
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0)
  x.normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  const m = new THREE.Matrix4().makeBasis(x.multiplyScalar(size), y.multiplyScalar(size), z.multiplyScalar(size))
  m.setPosition(pos)
  return m
}

// ---------------------------------------------------------------------------
// shader chunks shared by the grown parts
// ---------------------------------------------------------------------------
const VIS_FN = /* glsl */ `
uniform float uG;
uniform float uTime;
uniform float uSway;
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
  }
  private fallUniforms = { uFall: { value: 0 } }
  private sporeMat: THREE.ShaderMaterial
  private shadeMat: THREE.ShaderMaterial
  private materials: THREE.Material[] = []
  private geometries: THREE.BufferGeometry[] = []

  private readonly body = new THREE.Group()
  private bodyGeometries: THREE.BufferGeometry[] = []
  private bodyMaterials: THREE.Material[] = []
  private shapeKey = ''
  private bodyTriangles = 0
  private effectTriangles = 0
  public flowerCount = 0
  public accentedFlowers = 0

  private level = 0 // what is drawn
  private target = 0 // what the record says
  private reducedMotion = false
  private time = 0
  public triangleCount = 0

  constructor() {
    this.group.name = 'overgrowth'
    this.body.name = 'overgrowthBody'
    this.group.add(this.body)

    // --- falling leaves from the walls and canopy (shader-animated loop)
    {
      const COUNT = 70
      const geo = leafGeometry()
      const seeds = new Float32Array(COUNT * 4)
      const r = rng(7)
      for (let i = 0; i < COUNT; i++) {
        const rad = 1.8 + r() * 5.6
        const a = r() * Math.PI * 2
        seeds.set([Math.cos(a) * rad, Math.sin(a) * rad, 0.05 + r() * 0.05, r()], i * 4)
      }
      geo.setAttribute('aFall', new THREE.InstancedBufferAttribute(seeds, 4))
      const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8, color: 0x8c9a48 })
      mat.onBeforeCompile = (sh: Shader) => {
        Object.assign(sh.uniforms, this.uniforms, this.fallUniforms)
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>\nattribute vec4 aFall;\nuniform float uG;\nuniform float uTime;\nuniform float uFall;`)
          .replace(
            '#include <begin_vertex>',
            `float ft = uTime * aFall.z + aFall.w * 17.0;
            float ff = fract(ft);
            float on = step(aFall.w, uFall) * (1.0 - smoothstep(0.9, 1.0, ff)) * smoothstep(0.0, 0.04, ff);
            float ty = ft * 6.2831;
            vec3 p = position - vec3(0.0, 0.5, 0.0);
            float c1 = cos(ty * 1.7 + aFall.w * 9.0); float s1 = sin(ty * 1.7 + aFall.w * 9.0);
            p.xy = vec2(c1 * p.x - s1 * p.y, s1 * p.x + c1 * p.y);
            float c2 = cos(ty * 1.1); float s2 = sin(ty * 1.1);
            p.yz = vec2(c2 * p.y - s2 * p.z, s2 * p.y + c2 * p.z);
            vec3 transformed = p * 0.11 * on + vec3(
              aFall.x + sin(ty * 2.3 + aFall.w * 5.0) * 0.32,
              mix(${(LAB_HEIGHT - 0.2).toFixed(2)}, 0.03, ff),
              aFall.y + cos(ty * 1.9 + aFall.w * 3.0) * 0.32);`
          )
      }
      mat.customProgramCacheKey = () => 'og-fall'
      const mesh = new THREE.InstancedMesh(geo, mat, COUNT)
      mesh.name = 'overgrowthFallingLeaves'
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.track(geo, mat)
      this.effectTriangles += 4 * COUNT
    }

    // --- drifting spores (replace the dust motes as the room overgrows)
    {
      const COUNT = 260
      const seeds = new Float32Array(COUNT * 4)
      const pos = new Float32Array(COUNT * 3)
      const r = rng(11)
      for (let i = 0; i < COUNT; i++) seeds.set([r() * Math.PI * 2, Math.sqrt(r()) * 7.4, r(), r()], i * 4)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
      this.sporeMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { ...this.uniforms, uAmt: { value: 0 }, uPx: { value: Math.min(window.devicePixelRatio || 1, 2) } },
        vertexShader: /* glsl */ `
          attribute vec4 aSeed;
          uniform float uTime; uniform float uAmt; uniform float uPx;
          varying float vA;
          void main() {
            float t = uTime * (0.02 + aSeed.z * 0.03) + aSeed.w;
            float y = fract(t) * ${(LAB_HEIGHT - 0.2).toFixed(2)} + 0.1;
            float a = aSeed.x + sin(t * 6.2831 + aSeed.z * 4.0) * 0.25;
            float r = aSeed.y + sin(t * 9.0 + aSeed.w * 6.0) * 0.3;
            vec3 p = vec3(cos(a) * r, y, sin(a) * r);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float on = step(aSeed.w, uAmt);
            vA = on * smoothstep(0.0, 0.15, fract(t)) * (1.0 - smoothstep(0.85, 1.0, fract(t)));
            gl_PointSize = (2.0 + aSeed.z * 3.0) * uPx * (8.0 / max(1.0, -mv.z)) * on;
          }`,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() {
            vec2 d = gl_PointCoord - 0.5;
            float m = smoothstep(0.5, 0.1, length(d));
            if (m * vA < 0.01) discard;
            gl_FragColor = vec4(0.93, 0.95, 0.72, m * vA * 0.7);
          }`,
      })
      const pts = new THREE.Points(geo, this.sporeMat)
      pts.name = 'overgrowthSpores'
      pts.frustumCulled = false
      this.group.add(pts)
      this.track(geo, this.sporeMat)
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
      mesh.renderOrder = 1
      this.group.add(mesh)
      this.track(geo, this.shadeMat)
    }

    this.triangleCount = this.effectTriangles
    this.group.visible = false
  }

  /**
   * Grows this run's organism: seeded from the experiment id and shaped by the
   * record (see organismShape.ts). Rebuilt only when the shape changes, which
   * is at most once an epoch; growth itself stays a uniform.
   */
  public configure(shape: OrganismShape): void {
    const key = shapeKey(shape)
    if (key === this.shapeKey) return
    this.shapeKey = key
    this.disposeBody()
    const b = new VineBuilder(shape.seed)
    buildOrganism(b, shape)
    // flowers in the order the vine grows them, coloured by merge order
    b.flowers.sort((x, y) => x.thr - y.thr)
    const accents = flowerAccents(b.flowers.length, shape.merges, shape.mergedTotal)
    b.flowers.forEach((f, i) => {
      const a = accents[i]
      if (a !== null) f.color = new THREE.Color(a).lerp(CREAM, 0.18)
    })
    this.flowerCount = b.flowers.length
    this.accentedFlowers = accents.filter(a => a !== null).length
    this.bodyTriangles = 0
    // --- vines, roots and floor cracks: one merged mesh
    const vineGeo = b.vineGeometry()
    const vineMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0 })
    vineMat.onBeforeCompile = (sh: Shader) => {
      Object.assign(sh.uniforms, this.uniforms)
      lighterFog(sh)
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nattribute float aGrow;\nattribute vec3 aSpine;\nattribute float aSurf;\n${VIS_FN}`)
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3(position);
          float ogk = ogGrow(aGrow, 0.14) * ogVisible((modelMatrix * vec4(aSpine, 1.0)).xyz, aSurf);
          transformed = mix(aSpine, transformed, ogk);`
        )
    }
    vineMat.customProgramCacheKey = () => 'og-vine'
    const vines = new THREE.Mesh(vineGeo, vineMat)
    vines.frustumCulled = false
    vines.name = 'overgrowthVines'
    this.body.add(vines)
    this.trackBody(vineGeo, vineMat)
    this.bodyTriangles += (vineGeo.index?.count ?? 0) / 3

    // --- leaves and flowers: instanced, scaled in by growth, swaying in the shader
    const mkInstanced = (geo: THREE.BufferGeometry, specs: LeafSpec[], name: string, vertexColors: boolean, span: number) => {
      const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.7, metalness: 0, vertexColors })
      mat.onBeforeCompile = (sh: Shader) => {
        Object.assign(sh.uniforms, this.uniforms)
        lighterFog(sh)
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>\nattribute vec4 aLeaf;\n${VIS_FN}`)
          .replace(
            '#include <begin_vertex>',
            `vec3 transformed = vec3(position);
            vec3 ogIp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            float ogk = ogGrow(aLeaf.x, ${span.toFixed(2)}) * ogVisible(ogIp, aLeaf.z);
            float ogSw = sin(uTime * 1.3 + aLeaf.y) * aLeaf.w * uSway + sin(uTime * 0.53 + aLeaf.y * 2.0) * aLeaf.w * 0.5 * uSway;
            float ogC = cos(ogSw); float ogS = sin(ogSw);
            transformed.yz = vec2(ogC * transformed.y - ogS * transformed.z, ogS * transformed.y + ogC * transformed.z);
            transformed *= ogk;`
          )
      }
      mat.customProgramCacheKey = () => 'og-' + name
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, specs.length))
      mesh.name = name
      mesh.frustumCulled = false
      const attr = new Float32Array(specs.length * 4)
      specs.forEach((sp, i) => {
        mesh.setMatrixAt(i, sp.m)
        mesh.setColorAt(i, sp.color)
        attr.set([sp.thr, sp.phase, sp.surf, sp.sway], i * 4)
      })
      mesh.count = specs.length
      geo.setAttribute('aLeaf', new THREE.InstancedBufferAttribute(attr, 4))
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      this.body.add(mesh)
      this.trackBody(geo, mat)
      this.bodyTriangles += ((geo.index?.count ?? 0) / 3) * specs.length
    }
    mkInstanced(leafGeometry(), b.leaves, 'overgrowthLeaves', false, 0.1)
    mkInstanced(flowerGeometry(), b.flowers, 'overgrowthFlowers', true, 0.16)

    // --- lifted floorboards
    {
      const geo = new THREE.BoxGeometry(0.21, 0.035, 0.5)
      geo.translate(0, 0.0175, 0.25) // pivot at the outer end, lying on the floor
      const mat = new THREE.MeshStandardMaterial({ color: 0x67533f, roughness: 0.85, metalness: 0.02 })
      mat.onBeforeCompile = (sh: Shader) => {
        Object.assign(sh.uniforms, this.uniforms)
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>\nattribute vec2 aBoard;\n${VIS_FN}`)
          .replace(
            '#include <begin_vertex>',
            `vec3 transformed = vec3(position);
            float ogk = ogGrow(aBoard.x, 0.2);
            float ogA = ogk * aBoard.y;
            float ogC = cos(ogA); float ogS = sin(ogA);
            transformed.yz = vec2(ogC * transformed.y + ogS * transformed.z, -ogS * transformed.y + ogC * transformed.z);
            transformed *= step(0.001, ogk);`
          )
      }
      mat.customProgramCacheKey = () => 'og-boards'
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, b.boards.length))
      mesh.name = 'overgrowthBoards'
      mesh.frustumCulled = false
      const attr = new Float32Array(b.boards.length * 2)
      b.boards.forEach((bd, i) => {
        mesh.setMatrixAt(i, bd.m)
        attr.set([bd.thr, bd.tilt], i * 2)
      })
      mesh.count = b.boards.length
      geo.setAttribute('aBoard', new THREE.InstancedBufferAttribute(attr, 2))
      this.body.add(mesh)
      this.trackBody(geo, mat)
      this.bodyTriangles += 12 * b.boards.length
    }

    this.bodyTriangles = Math.round(this.bodyTriangles)
    this.triangleCount = this.bodyTriangles + this.effectTriangles
  }

  private ensureBody(): void {
    if (!this.shapeKey) this.configure(DEFAULT_SHAPE)
  }

  private trackBody(geo: THREE.BufferGeometry, mat: THREE.Material): void {
    this.bodyGeometries.push(geo)
    this.bodyMaterials.push(mat)
  }

  private disposeBody(): void {
    this.bodyGeometries.forEach(g => g.dispose())
    this.bodyMaterials.forEach(m => m.dispose())
    this.bodyGeometries = []
    this.bodyMaterials = []
    this.body.clear()
  }

  private track(geo: THREE.BufferGeometry, mat: THREE.Material): void {
    this.geometries.push(geo)
    this.materials.push(mat)
  }

  /** Growth level from the stored record (stage + progress, 0..7). */
  public setTarget(level: number, immediate = false): void {
    this.ensureBody()
    this.target = THREE.MathUtils.clamp(level, 0, 7)
    if (immediate || this.reducedMotion) this.level = this.target
  }

  public getLevel(): number {
    return this.level
  }

  public setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
    this.uniforms.uSway.value = reduced ? 0 : 1
    if (reduced) this.level = this.target
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
    const d = Math.min(dt, 0.05)
    // Ease toward the record: a stage change unfolds over roughly ten
    // seconds, a small step in progress over a second or two.
    const gap = this.target - this.level
    if (Math.abs(gap) > 1e-4) {
      const rate = Math.max(0.05, Math.abs(gap) * 0.2)
      this.level += Math.sign(gap) * Math.min(Math.abs(gap), rate * d)
    }
    if (!this.reducedMotion) this.time += d
    this.uniforms.uG.value = this.level
    this.uniforms.uTime.value = this.time
    this.group.visible = this.level > 1.0
    const air = this.airborne()
    this.sporeMat.uniforms.uAmt.value = this.reducedMotion ? air * 0.5 : air
    this.fallUniforms.uFall.value = this.reducedMotion ? 0 : THREE.MathUtils.smoothstep(this.level, 5.3, 7) * 0.9
    this.shadeMat.uniforms.uAmt.value = this.canopy()
  }

  public dispose(): void {
    this.disposeBody()
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

function buildOrganism(b: VineBuilder, shape: OrganismShape): void {
  const R = () => b.r()
  const P = shapeParams(shape)
  // more behaviours, denser leaves: leaf spacing shrinks
  const every = (v: number) => v / P.leafDensity
  const root: PathOpts = { radial: 4, spacing: 0.3, lift: true, c0: ROOT_DARK, c1: ROOT, leafEvery: every(0.3), leafSize: 0.13, flowerChance: 0.05, sway: 0.08 }
  const vine: PathOpts = { radial: 3, spacing: 0.28, lift: true, c0: VINE_OLD, c1: VINE_YOUNG, leafEvery: every(0.1), leafSize: 0.22, flowerChance: 0.12, sway: 0.18 }
  const tendril: PathOpts = { radial: 3, spacing: 0.1, lift: true, c0: VINE_OLD, c1: VINE_YOUNG, leafEvery: every(0.15), leafSize: 0.1, flowerChance: 0.1, sway: 0.15 }
  const hanging: PathOpts = { radial: 3, spacing: 0.2, lift: false, c0: VINE_OLD, c1: VINE_YOUNG, leafEvery: every(0.13), leafSize: 0.15, flowerChance: 0.08, sway: 0.3 }
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
    // start far enough round that the runner leaves the dome facing its desk
    const a0 = deskAngles[k] - twist * (2.2 + (R() - 0.5) * 0.4)

    // inside the dome: a low runner around the plant (stage 1), then up the
    // inside of the glass, pressing on it (stage 2)
    const inner: CP[] = []
    for (let j = 0; j <= 4; j++) {
      const t = j / 4
      const a = a0 + twist * t * 0.9
      inner.push(cp(polar(0.12 + t * 0.6, a, 0.31 + Math.sin(t * Math.PI) * (0.05 + R() * 0.06)), 1.0 + t * 0.95, 0.03 - t * 0.006))
    }
    const hug: CP[] = []
    const aH = a0 + twist * 0.9
    const climbDome = 0.9 + R() * 0.4
    for (let j = 1; j <= 6; j++) {
      const t = j / 6
      const el = 0.12 + t * climbDome // elevation on the dome, radians
      const az = aH + twist * t * 1.3
      const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
      hug.push(cp(DOME_C.clone().addScaledVector(dir, 0.9), 2.0 + t * 0.95, 0.026 + t * 0.006, dir.clone().negate()))
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
    b.addPath(trunk, { ...tendril, radial: 4, spacing: 0.15, leafEvery: every(0.2), leafSize: 0.11 })

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
    b.addPath([...helix, ...toLamp, ...lampUp], { ...tendril, spacing: 0.075, flowerChance: 0.22 })
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
    for (const rr of [4.1, 6.3, 5.2].slice(0, P.boardsPerRun)) {
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
      b.addPath(ceiling, { ...vine, spacing: 0.36, leafEvery: every(0.2), leafSize: 0.24, leafTones: CANOPY_TONES })

      // canopy side shoots across the ceiling, with tendrils hanging down
      const shoots = 2 + Math.floor(R() * 3)
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
        b.addPath(shoot, { ...vine, spacing: 0.3, leafEvery: every(0.18), leafSize: 0.22, leafTones: CANOPY_TONES })
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
      const drapes = 2 + Math.floor(R() * 3)
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

  // wound round the brass crown moulding, linking the climbers into one rim.
  // It is a real object in front of the room on the near side too, so these
  // stay visible from everywhere.
  const crownY = LAB_HEIGHT - 0.08
  const crowns = 4 + Math.floor(R() * 4)
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
  const rings = 3 + Math.floor(R() * 3)
  const ringStart = R() * Math.PI * 2
  for (let k = 0; k < rings; k++) {
    const a0 = ringStart + (k / rings) * Math.PI * 2
    const ring: CP[] = []
    const bulge = 0.05 + R() * 0.15
    for (let j = 0; j <= 5; j++) {
      const t = j / 5
      ring.push(cp(polar(0.5 + Math.sin(t * Math.PI) * bulge, a0 + sweep * t * 1.6, CEIL_Y), 6.75 + t * 0.2, 0.012, DOWN, CEIL))
    }
    b.addPath(ring, { ...vine, spacing: 0.2, leafEvery: every(0.14), leafSize: 0.2, leafTones: CANOPY_TONES })
    const end = ring[ring.length - 1].p
    b.addPath(
      [cp(end.clone(), 6.95, 0.006, inward(end), CEIL), cp(end.clone().add(new THREE.Vector3(0.04, -0.4 - R() * 0.4, 0.0)), 7.0, 0.004, inward(end), CEIL)],
      hanging
    )
  }
}
