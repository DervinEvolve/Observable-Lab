import * as THREE from 'three'
import { FREE, GrowthSink, LONG_AGO, NEVER, facets, tube, type Ring } from './growthParts'
import { accentForModel, rng, type GrowthEvent } from '../systems/growthEvents'
import type { GrowStats } from './eventGrowth'

// The specimen itself: one flowering plant in the glass dome. A central stem
// rises from the soil with a rosette of leaves at its foot and leaves in pairs
// up the stem, and a main flower at the top that grows, opens and multiplies
// as the record's growth level rises (more petals, a second and a third bloom,
// side buds), with a few smaller flowering stems coming up round it.
//
// After the break-out it keeps maturing with the room, quietly: the first
// blooms go to seed (capsules where the hearts were), the side buds open in a
// second flush, new flowering shoots come off the upper stem, the stem
// thickens and goes woody at the foot, the oldest rosette leaves yellow, and
// seedlings come up in the soil round it.
//
// While the plant is in the dome (events at level below 3), every real event
// grows on this plant: an epoch adds leaves or a leafy side shoot, a merged
// contribution a bloom in its author's colour, a setback a bud that withers,
// a breakthrough a large bloom, an exhibit a curling tendril. Each from its
// own random stream, so the same event grows the same way every time.
//
// It is drawn into the same merged mesh as the overgrowth (no extra draw
// calls). Every vertex of it carries aPlant = (1, sway, phase, part): the
// vine shader sways it gently (by height, so everything on one stem moves
// together), scales it about the foot of the stem while the drawn level eases
// toward the record, and tints leaves and berries from the spec.

export const SOIL_Y = 0.31
const PLANT_SEED = 20261114

// which part a vertex belongs to (aPlant.w)
export const PART = { stem: 0, leaf: 1, petal: 2, heart: 3, north: 4, gold: 5 }
export const BERRIES = 6

// Height from the soil to the main flower at growth level L. The plant keeps
// growing a little after the break-out, then holds.
export function plantHeight(L: number): number {
  const l = Math.max(0, Math.min(4, L))
  return 0.3 + 0.46 * (1 - Math.exp(-0.75 * l))
}

// the soil mound: radius from the middle -> height
const SOIL_R = [0, 0.14, 0.42, 0.76, 0.965]
const SOIL_H = [0.338, 0.334, 0.322, 0.312, 0.304]

/** The height of the soil at distance r from the middle of the dome. */
export function soilHeight(r: number): number {
  if (r <= 0) return SOIL_H[0]
  for (let i = 1; i < SOIL_R.length; i++) {
    if (r <= SOIL_R[i]) return SOIL_H[i - 1] + ((SOIL_H[i] - SOIL_H[i - 1]) * (r - SOIL_R[i - 1])) / (SOIL_R[i] - SOIL_R[i - 1])
  }
  return SOIL_H[SOIL_H.length - 1]
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const col = (h: number) => new THREE.Color(h)

// Tones: soft rose petals fading to cream, a dark heart ringed with pollen
// gold, leaves from deep to fresh green, the soil dark and a little mossy.
const PETAL_BASE = col(0xd4877e)
const PETAL_TIP = col(0xf7e6da)
const HEART_DARK = col(0x4a3826)
const HEART_GOLD = col(0xe2b04a)
const SEPAL = col(0x6a8c3a)
const STEM_FOOT = col(0x6f7d3a)
const STEM_TOP = col(0x8fb052)
const LEAF_TONES = [0x5f8a3a, 0x6f9a42, 0x76a544, 0x7cb342, 0x86a83f].map(col)
const LEAF_LIGHT = col(0xc4d68a)
const CREAM = col(0xf4ecd8)
const BUD_REJECTED = col(0xa9b46a)
const BUD_FAILED = col(0xb7845c)
const SOIL_DARK = col(0x2b2018)
const SOIL = col(0x3d2d20)
const MOSS = col(0x56692f)
const NORTH_GREEN = col(0x34c38f)
const CODE_GOLD = col(0xffc94a)
const SEED_POD = col(0x8a7346)
const WOODY = col(0x7a6444)
const OLD_LEAF = col(0x9a9548)

interface Life {
  g: number
  appear: number
  wither: number
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A grid of points drawn as one smooth patch, normals from its own faces. */
function patch(sink: GrowthSink, P: THREE.Vector3[][], C: THREE.Color[][], spine: THREE.Vector3, life: Life): void {
  const rows = P.length
  const cols = P[0].length
  const nrm = P.map(r => r.map(() => new THREE.Vector3()))
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const f = new THREE.Vector3()
  const face = (a: [number, number], b: [number, number], c: [number, number]) => {
    const A = P[a[0]][a[1]]
    e1.subVectors(P[b[0]][b[1]], A)
    e2.subVectors(P[c[0]][c[1]], A)
    f.crossVectors(e1, e2)
    nrm[a[0]][a[1]].add(f)
    nrm[b[0]][b[1]].add(f)
    nrm[c[0]][c[1]].add(f)
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      face([i, j], [i + 1, j], [i, j + 1])
      face([i, j + 1], [i + 1, j], [i + 1, j + 1])
    }
  }
  const base = sink.vertexCount
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const n = nrm[i][j]
      if (n.lengthSq() < 1e-14) n.set(0, 1, 0)
      n.normalize()
      sink.vert(P[i][j], n, C[i][j], life.g, spine, FREE, life.appear, life.wither)
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = base + i * cols + j
      sink.idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1)
    }
  }
}

const frame = (dir: THREE.Vector3, up: THREE.Vector3) => {
  const T = dir.clone().normalize()
  const N = up.clone().addScaledVector(T, -up.dot(T))
  if (N.lengthSq() < 1e-6) N.set(T.y, -T.x, 0.3).addScaledVector(T, -T.dot(N))
  N.normalize()
  const S = new THREE.Vector3().crossVectors(T, N)
  return { T, N, S }
}

interface LeafOpts {
  len: number
  width: number // half-width at its widest, as a share of the length
  arch: number // how much it rises off its stalk
  droop: number // how far the tip falls back
  fold: number // the blade folds down from the midrib
  twist: number
  color: THREE.Color
  rows?: number
}

/**
 * A leaf with a real leaf shape: a short stalk, an ovate blade widest a third
 * of the way along, a raised midrib, edges folding down, arching out and
 * drooping at the tip. 16 triangles (12 when small).
 */
export function leaf(sink: GrowthSink, base: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, o: LeafOpts, life: Life): void {
  const { T, N, S } = frame(dir, up)
  if (o.twist) {
    const q = new THREE.Quaternion().setFromAxisAngle(T, o.twist)
    N.applyQuaternion(q)
    S.applyQuaternion(q)
  }
  const ts = o.rows === 4 ? [0, 0.3, 0.66, 1] : [0, 0.18, 0.42, 0.72, 1]
  const hw = o.rows === 4 ? [0.05, 0.92, 0.72, 0] : [0.05, 0.72, 1.0, 0.68, 0]
  const P: THREE.Vector3[][] = []
  const C: THREE.Color[][] = []
  const light = o.color.clone().lerp(LEAF_LIGHT, 0.32)
  const dark = o.color.clone().multiplyScalar(0.82)
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]
    const lift = o.len * (o.arch * t - o.droop * t * t)
    const c = base.clone().addScaledVector(T, o.len * t).addScaledVector(N, lift)
    const w = hw[i] * o.width * o.len
    const tone = o.color.clone().lerp(dark, (1 - t) * 0.35).lerp(LEAF_LIGHT, t * t * 0.12)
    P.push([
      c.clone().addScaledVector(S, -w).addScaledVector(N, -w * o.fold),
      c.clone().addScaledVector(N, w * 0.12),
      c.clone().addScaledVector(S, w).addScaledVector(N, -w * o.fold),
    ])
    C.push([tone, tone.clone().lerp(light, 0.5), tone.clone().multiplyScalar(1.04)])
  }
  patch(sink, P, C, base, life)
}

interface BloomOpts {
  petals: number
  rings: number
  open: number // 0 a closed bud .. 1 fully open
  size: number // petal length
  tip: THREE.Color
  base: THREE.Color
  cup: number // how much the petal edges lift
  curl: number // how much the petals bend back toward their tips when open
  R: () => number
  ringGates?: number[] // when each inner ring appears (growth level)
  low?: boolean // fewer rows: small blooms from events
  sepals?: boolean
}

/**
 * A flower facing `axis`: sepals, rings of soft petals that open from a bud,
 * and a heart (a dark centre ringed with pollen gold) that shows once open.
 */
export function bloom(sink: GrowthSink, centre: THREE.Vector3, axis: THREE.Vector3, ref: THREE.Vector3, o: BloomOpts, life: Life): void {
  const z = axis.clone().normalize()
  const x = ref.clone().addScaledVector(z, -ref.dot(z))
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0).addScaledVector(z, -z.x)
  if (x.lengthSq() < 1e-6) x.set(0, 0, 1).addScaledVector(z, -z.z)
  x.normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  const R = o.R
  const open = Math.max(0, Math.min(1, o.open))
  const keep = sink.plantAttr[3]
  const ts = o.low ? [0, 0.55] : [0, 0.3, 0.62, 0.88]
  const hw = o.low ? [0.15, 1.0] : [0.12, 0.72, 1.0, 0.78]

  // one petal: a curved strip from the heart out, cupped, with a rounded tip
  const petal = (az: number, len: number, width: number, theta0: number, curl: number, tipC: THREE.Color, baseC: THREE.Color, startR: number, part: number, l: Life) => {
    const radial = x.clone().multiplyScalar(Math.cos(az)).addScaledVector(y, Math.sin(az))
    const side = y.clone().multiplyScalar(Math.cos(az)).addScaledVector(x, -Math.sin(az))
    const dirAt = (t: number) => {
      const th = theta0 + curl * t * t
      return z.clone().multiplyScalar(Math.cos(th)).addScaledVector(radial, Math.sin(th))
    }
    const P: THREE.Vector3[][] = []
    const C: THREE.Color[][] = []
    let c = centre.clone().addScaledVector(radial, startR).addScaledVector(z, startR * 0.3)
    let tPrev = 0
    const jitter = 0.95 + R() * 0.1
    const rowsT = [...ts, 1]
    for (let i = 0; i < rowsT.length; i++) {
      const t = rowsT[i]
      const d = dirAt((t + tPrev) / 2)
      c = c.clone().addScaledVector(d, (t - tPrev) * len)
      tPrev = t
      const n = new THREE.Vector3().crossVectors(d, side) // faces the heart / up
      const tone = baseC.clone().lerp(tipC, Math.pow(t, 0.65)).multiplyScalar(jitter)
      if (i < rowsT.length - 1) {
        const w = hw[i] * width
        const edge = n.clone().multiplyScalar(o.cup * w * w / Math.max(1e-4, width))
        P.push([c.clone().addScaledVector(side, -w).add(edge), c.clone().addScaledVector(n, -w * 0.08), c.clone().addScaledVector(side, w).add(edge)])
        const edgeTone = tone.clone().lerp(tipC, 0.18)
        C.push([edgeTone, tone, edgeTone.clone()])
      } else {
        // the rounded tip: the edges stop a little short of the middle
        const back = d.clone().multiplyScalar(-len * 0.05)
        const w = width * 0.38
        const edge = n.clone().multiplyScalar(o.cup * w * w / Math.max(1e-4, width))
        P.push([c.clone().add(back).addScaledVector(side, -w).add(edge), c.clone(), c.clone().add(back).addScaledVector(side, w).add(edge)])
        C.push([tone.clone(), tone.clone(), tone.clone()])
      }
    }
    sink.plantAttr[3] = part
    patch(sink, P, C, centre, l)
    sink.plantAttr[3] = keep
  }

  // sepals: green, holding the bud, turning back as it opens (hidden behind
  // an open flower, so only drawn where they show)
  if (o.sepals ?? (!o.low && open < 0.8)) {
    const ns = 5
    for (let i = 0; i < ns; i++) {
      const az = (i / ns) * Math.PI * 2 + 0.3
      const th = lerp(0.35, 1.95, open)
      petal(az, o.size * lerp(0.62, 0.45, open), o.size * 0.16, th, 0.25, SEPAL.clone().lerp(LEAF_LIGHT, 0.15), SEPAL, o.size * 0.06, PART.stem, life)
    }
  }

  // petal rings, outer first; inner rings are smaller, more upright, offset
  for (let k = 0; k < o.rings; k++) {
    const g = Math.max(life.g, o.ringGates?.[k] ?? life.g)
    const lk: Life = { ...life, g }
    const n = Math.max(4, o.petals - (k === 0 ? 0 : 1))
    const len = o.size * (1 - 0.2 * k) * (0.92 + R() * 0.08)
    const width = len * 0.5 * Math.sqrt(8 / n) * lerp(0.75, 1, open)
    const theta0 = lerp(0.14 + k * 0.03, 1.32 - k * 0.3, open)
    const curl = lerp(-0.25, o.curl * (1 - k * 0.4), open)
    const tipC = o.tip.clone().lerp(o.base, k * 0.12)
    const startR = o.size * lerp(0.04, 0.17 - k * 0.04, open)
    const twist = R() * 0.3 + (k * Math.PI) / n
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + twist + (R() - 0.5) * 0.12
      petal(az, len * (0.94 + R() * 0.1), width, theta0 + (R() - 0.5) * 0.1 * open, curl, tipC, o.base, startR, PART.petal, lk)
    }
  }

  // the heart, once there is room to see it
  if (open > 0.3) {
    const hs = o.low ? 6 : 8
    sink.plantAttr[3] = PART.heart
    const r1 = o.size * 0.1
    const r2 = o.size * (0.2 - 0.02 * (o.rings - 1))
    const top = centre.clone().addScaledVector(z, o.size * 0.13)
    const ring = (r: number, h: number, c: THREE.Color) =>
      Array.from({ length: hs }, (_, i) => {
        const a = (i / hs) * Math.PI * 2
        const p = centre.clone().addScaledVector(x, Math.cos(a) * r).addScaledVector(y, Math.sin(a) * r).addScaledVector(z, h)
        const nn = z.clone().multiplyScalar(0.8).addScaledVector(x, Math.cos(a) * 0.6).addScaledVector(y, Math.sin(a) * 0.6).normalize()
        return sink.vert(p, nn, c, life.g, centre, FREE, life.appear, life.wither)
      })
    const t = sink.vert(top, z, HEART_DARK.clone().lerp(SEPAL, 0.25), life.g, centre, FREE, life.appear, life.wither)
    const a = ring(r1, o.size * 0.1, HEART_DARK)
    const b = ring(r2, o.size * 0.04, HEART_GOLD)
    for (let i = 0; i < hs; i++) {
      const j = (i + 1) % hs
      sink.idx.push(t, a[i], a[j], a[i], b[i], a[j], a[j], b[i], b[j])
    }
    sink.plantAttr[3] = keep
  }
}

/** A small round berry or seed pod: 8 triangles. */
function berry(sink: GrowthSink, p: THREE.Vector3, r: number, c: THREE.Color, life: Life): void {
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)]
  const v = dirs.map(d => sink.vert(p.clone().addScaledVector(d, r), d, c, life.g, p, FREE, life.appear, life.wither))
  const faces = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]]
  for (const f of faces) sink.idx.push(v[f[0]], v[f[1]], v[f[2]])
}

// ---------------------------------------------------------------------------
// Its offspring: the same flower, cheap enough to scatter through the room
// ---------------------------------------------------------------------------

/**
 * Petal tones for a flower grown from someone's merged work: the specimen's
 * own rose-to-cream petals, drawn toward that model's accent (most at the
 * base of each petal, a little at the tip), so it reads as the specimen's
 * offspring in that model's colour. No model: the specimen's own tones.
 */
export function offspringTones(accent: number | null, v: number): { tip: THREE.Color; base: THREE.Color } {
  if (accent === null) return { tip: PETAL_TIP.clone().lerp(CREAM, v * 0.5), base: PETAL_BASE.clone().lerp(PETAL_TIP, 0.25 * v) }
  const a = new THREE.Color(accent)
  return { tip: PETAL_TIP.clone().lerp(a, 0.26 + v * 0.1), base: PETAL_BASE.clone().lerp(a, 0.64 + v * 0.1) }
}

export interface HeadOpts {
  size: number // petal length
  open: number // 0 a closed bud .. 1 wide open
  petals: number
  tip: THREE.Color
  base: THREE.Color
  cup: number // how much the petal edges lift
  curl: number // how much the petals bend back toward their tips when open
  fine: boolean // rounded petal tips and a ringed heart (6 triangles a petal), else 4
  g: number
  surf: number
  appear: number
  wither: number
  R: () => number
  rings?: number // 2: a second, smaller ring of petals inside (a doubled bloom)
}

const frameOf = (axis: THREE.Vector3, ref: THREE.Vector3) => {
  const z = axis.clone().normalize()
  const x = ref.clone().addScaledVector(z, -ref.dot(z))
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0).addScaledVector(z, -z.x)
  if (x.lengthSq() < 1e-6) x.set(0, 0, 1).addScaledVector(z, -z.z)
  x.normalize()
  return { z, x, y: new THREE.Vector3().crossVectors(z, x) }
}

/**
 * A closed bud: green sepals holding it, the petal colour showing at the
 * tip. 10 triangles.
 */
export function budHead(sink: GrowthSink, base: THREE.Vector3, axis: THREE.Vector3, size: number, tipC: THREE.Color, surf: number, l: Life): void {
  const { z, x, y } = frameOf(axis, new THREE.Vector3(1, 0.3, 0.2))
  const P = [base.clone()]
  const C = [SEPAL.clone().multiplyScalar(0.9)]
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    P.push(base.clone().addScaledVector(z, size * 0.42).addScaledVector(x, Math.cos(a) * size * 0.3).addScaledVector(y, Math.sin(a) * size * 0.3))
    C.push(SEPAL.clone().lerp(tipC, 0.22))
  }
  P.push(base.clone().addScaledVector(z, size))
  C.push(tipC.clone())
  const T: number[] = []
  for (let i = 0; i < 5; i++) {
    const a = 1 + i
    const b = 1 + ((i + 1) % 5)
    T.push(0, b, a, a, b, 6)
  }
  facets(sink, P, C, T, base, l.g, surf, l.appear, l.wither)
}

/**
 * What is left when the petals have fallen: the dark heart swollen into a
 * seed capsule, its gold ring dried to a crown, a collar of dry sepals under
 * it (fine only). 10 triangles, 20 fine.
 */
export function seedHead(sink: GrowthSink, base: THREE.Vector3, axis: THREE.Vector3, size: number, fine: boolean, surf: number, l: Life): void {
  const { z, x, y } = frameOf(axis, new THREE.Vector3(1, 0.3, 0.2))
  const at = (h: number, r: number, a: number) => base.clone().addScaledVector(z, h * size).addScaledVector(x, Math.cos(a) * r * size).addScaledVector(y, Math.sin(a) * r * size)
  const P = [base.clone()]
  const C = [SEPAL.clone().lerp(SEED_POD, 0.6)]
  const T: number[] = []
  for (let i = 0; i < 5; i++) {
    P.push(at(0.32, 0.34, (i / 5) * Math.PI * 2))
    C.push(SEED_POD.clone())
  }
  const top = P.length
  P.push(at(fine ? 0.74 : 0.7, 0, 0))
  C.push(HEART_GOLD.clone().lerp(SEED_POD, 0.45))
  if (fine) {
    // the crown: a narrower ring under the top, its rays picked out in dried gold
    const crown = P.length
    for (let i = 0; i < 5; i++) {
      P.push(at(0.62, 0.27, (i / 5) * Math.PI * 2 + 0.3))
      C.push(HEART_GOLD.clone().lerp(SEED_POD, 0.65))
    }
    for (let i = 0; i < 5; i++) {
      const a = 1 + i
      const b = 1 + ((i + 1) % 5)
      const c = crown + i
      const d = crown + ((i + 1) % 5)
      T.push(0, b, a, a, b, c, c, b, d, c, d, top)
    }
    // dry sepals, turned back
    const dry = SEPAL.clone().lerp(SEED_POD, 0.7)
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.6
      const k = P.length
      P.push(at(0.08, 0.1, a - 0.35), at(-0.12, 0.5, a), at(0.08, 0.1, a + 0.35))
      C.push(dry, dry.clone().multiplyScalar(0.85), dry)
      T.push(k, k + 2, k + 1)
    }
  } else {
    for (let i = 0; i < 5; i++) {
      const a = 1 + i
      const b = 1 + ((i + 1) % 5)
      T.push(0, b, a, a, b, top)
    }
  }
  facets(sink, P, C, T, base, l.g, surf, l.appear, l.wither)
}

/**
 * The specimen's flower, made cheap: a ring of cupped petals widest past
 * the middle with a rounded tip (pointed when not fine), shading from the
 * petal base out to the tip, round the same dark heart ringed with gold.
 * Under about a sixth open it is a closed bud.
 */
export function flowerHead(sink: GrowthSink, centre: THREE.Vector3, axis: THREE.Vector3, ref: THREE.Vector3, o: HeadOpts): void {
  const l: Life = { g: o.g, appear: o.appear, wither: o.wither }
  if (o.open < 0.16) {
    budHead(sink, centre, axis, o.size * 0.55, o.tip.clone().lerp(o.base, 0.4), o.surf, l)
    return
  }
  const { z, x, y } = frameOf(axis, ref)
  const R = o.R
  const open = Math.min(1, o.open)
  const rings = o.rings ?? 1
  for (let k = 0; k < rings; k++) {
    const n = Math.max(4, Math.min(o.fine ? 12 : 6, Math.round(o.petals)) - k)
    const len = o.size * (1 - 0.24 * k)
    const width = len * 0.5 * Math.sqrt(8 / n) * lerp(0.8, 1.05, open)
    const theta0 = lerp(0.3, 1.32 - k * 0.32, open)
    const curl = lerp(-0.3, o.curl * (1 - k * 0.4), open)
    const startR = len * lerp(0.05, 0.16 - k * 0.04, open)
    const tipC = o.tip.clone().lerp(o.base, k * 0.15)
    const twist = R() * 6.283 + (k * Math.PI) / n
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + twist + (R() - 0.5) * 0.14
      const radial = x.clone().multiplyScalar(Math.cos(az)).addScaledVector(y, Math.sin(az))
      const side = y.clone().multiplyScalar(Math.cos(az)).addScaledVector(x, -Math.sin(az))
      const lean = (R() - 0.5) * 0.12 * open
      const dirAt = (t: number) => {
        const th = theta0 + lean + curl * t * t
        return z.clone().multiplyScalar(Math.cos(th)).addScaledVector(radial, Math.sin(th))
      }
      const nAt = (t: number) => new THREE.Vector3().crossVectors(dirAt(t), side)
      const c0 = centre.clone().addScaledVector(radial, startR).addScaledVector(z, startR * 0.3)
      const c1 = c0.clone().addScaledVector(dirAt(0.27), len * 0.55)
      const c2 = c1.clone().addScaledVector(dirAt(0.72), len * (o.fine ? 0.31 : 0.45))
      const jit = 0.95 + R() * 0.1
      const tone = (t: number) => o.base.clone().lerp(tipC, Math.pow(t, 0.65)).multiplyScalar(jit)
      const w1 = width
      const e1 = nAt(0.55).multiplyScalar(o.cup * w1)
      const P = [c0, c1.clone().addScaledVector(side, -w1).add(e1), c1.clone().addScaledVector(nAt(0.55), -w1 * 0.08), c1.clone().addScaledVector(side, w1).add(e1)]
      const C = [tone(0), tone(0.55).lerp(tipC, 0.15), tone(0.55), tone(0.55).lerp(tipC, 0.15)]
      let T: number[]
      if (o.fine) {
        // shoulders and a rounded tip
        const w2 = width * 0.6
        const e2 = nAt(0.86).multiplyScalar(o.cup * w2)
        const c3 = c2.clone().addScaledVector(dirAt(0.95), len * 0.14)
        P.push(c2.clone().addScaledVector(side, -w2).add(e2), c3, c2.clone().addScaledVector(side, w2).add(e2))
        C.push(tone(0.86).lerp(tipC, 0.2), tone(1), tone(0.86).lerp(tipC, 0.2))
        T = [0, 1, 2, 0, 2, 3, 1, 4, 2, 2, 4, 5, 2, 5, 6, 2, 6, 3]
      } else {
        P.push(c2)
        C.push(tone(1))
        T = [0, 1, 2, 0, 2, 3, 1, 4, 2, 2, 4, 3]
      }
      facets(sink, P, C, T, centre, o.g, o.surf, o.appear, o.wither)
    }
  }
  // the heart, once there is room to see it (ringed in two tones on the
  // larger heads)
  if (open > 0.3) {
    const fineHeart = o.fine && o.size >= 0.07
    const hs = fineHeart ? 6 : 5
    const P = [centre.clone().addScaledVector(z, o.size * 0.14)]
    const C = [HEART_DARK.clone().lerp(SEPAL, 0.25)]
    const T: number[] = []
    const ring = (r: number, h: number, c: THREE.Color, off: number) => {
      const k = P.length
      for (let i = 0; i < hs; i++) {
        const a = (i / hs) * Math.PI * 2 + off
        P.push(centre.clone().addScaledVector(x, Math.cos(a) * r).addScaledVector(y, Math.sin(a) * r).addScaledVector(z, h))
        C.push(c.clone())
      }
      return k
    }
    if (fineHeart) {
      const a = ring(o.size * 0.1, o.size * 0.1, HEART_DARK, 0)
      const b = ring(o.size * 0.2, o.size * 0.04, HEART_GOLD, 0)
      for (let i = 0; i < hs; i++) {
        const j = (i + 1) % hs
        T.push(0, a + i, a + j, a + i, b + i, a + j, a + j, b + i, b + j)
      }
    } else {
      // one ring: the dark middle runs out into the gold
      const b = ring(o.size * 0.19, o.size * 0.05, HEART_GOLD, 0)
      for (let i = 0; i < hs; i++) T.push(0, b + i, b + ((i + 1) % hs))
    }
    facets(sink, P, C, T, centre, o.g, o.surf, o.appear, o.wither)
  }
}

// ---------------------------------------------------------------------------
// The plant
// ---------------------------------------------------------------------------

interface PlantStem {
  pts: THREE.Vector3[]
  r0: number
  r1: number
  phase: number
  g: number // level from which it is drawn
}

const UP = new THREE.Vector3(0, 1, 0)

export class Specimen {
  readonly level: number
  readonly height: number
  private stems: PlantStem[] = []
  private head = { p: new THREE.Vector3(), axis: new THREE.Vector3() }

  constructor(level: number) {
    this.level = Math.max(0, Math.min(7, level))
    this.height = plantHeight(this.level)
  }

  private attr(sway: number, phase: number, part: number, sink: GrowthSink): void {
    sink.plantAttr = [1, sway, phase, part]
  }

  /** A point on stem `k` at fraction u of its length, and which way it runs there. */
  private along(k: number, u: number): { p: THREE.Vector3; t: THREE.Vector3; r: number } {
    const s = this.stems[k]
    const f = Math.max(0, Math.min(1, u)) * (s.pts.length - 1)
    const i = Math.min(s.pts.length - 2, Math.floor(f))
    const a = f - i
    const p = s.pts[i].clone().lerp(s.pts[i + 1], a)
    const t = s.pts[i + 1].clone().sub(s.pts[i]).normalize()
    return { p, t, r: lerp(s.r0, s.r1, u) }
  }

  private stemRings(pts: THREE.Vector3[], r0: number, r1: number, c0: THREE.Color, c1: THREE.Color, life: Life, appearSpan = 0): Ring[] {
    return pts.map((p, i) => {
      const t = i / (pts.length - 1)
      return { p, n: new THREE.Vector3(1, 0, 0), r: lerp(r0, r1, Math.pow(t, 0.9)), g: life.g, surf: FREE, c: c0.clone().lerp(c1, t), appear: life.appear > LONG_AGO + 1 ? life.appear + t * appearSpan : life.appear, wither: life.wither }
    })
  }

  /** The plant as it stands at this level, and the soil it grows from. */
  build(sink: GrowthSink): void {
    const L = this.level
    const R = rng(PLANT_SEED)
    const H = this.height
    const always: Life = { g: -1, appear: LONG_AGO, wither: NEVER }
    const at = (g: number): Life => ({ g, appear: LONG_AGO, wither: NEVER })

    // --- the soil: a low dark mound filling the dome, mossy toward the glass
    this.attr(0, 0, PART.stem, sink)
    {
      const seg = 28
      const radii = SOIL_R
      const ys = SOIL_H
      const ids: number[][] = []
      const sr = rng(PLANT_SEED + 1)
      for (let i = 0; i < radii.length; i++) {
        const row: number[] = []
        const n = i === 0 ? 1 : seg
        for (let j = 0; j < n; j++) {
          const a = (j / seg) * Math.PI * 2
          const p = new THREE.Vector3(Math.cos(a) * radii[i], ys[i] + (i > 0 && i < 4 ? (sr() - 0.5) * 0.008 : 0), Math.sin(a) * radii[i])
          const moss = i >= 2 ? Math.max(0, Math.sin(a * 3 + 1.3) * 0.5 + Math.sin(a * 7 + 0.4) * 0.3) * (i === 4 ? 0.7 : 0.45) : 0
          const c = SOIL_DARK.clone().lerp(SOIL, 0.35 + sr() * 0.4).lerp(MOSS, moss)
          row.push(sink.vert(p, UP, c, -1, p, FREE))
        }
        ids.push(row)
      }
      for (let j = 0; j < seg; j++) sink.idx.push(ids[0][0], ids[1][(j + 1) % seg], ids[1][j])
      for (let i = 1; i < radii.length - 1; i++) {
        for (let j = 0; j < seg; j++) {
          const j1 = (j + 1) % seg
          sink.idx.push(ids[i][j], ids[i][j1], ids[i + 1][j], ids[i][j1], ids[i + 1][j1], ids[i + 1][j])
        }
      }
    }

    // --- the habit, all drawn from the seed in a fixed order so it never
    // changes as the plant grows (only how much of it is there)
    const leanA = Math.PI / 4 + (R() - 0.5) * 0.8 // toward the room's usual view, roughly
    const leanAmt = 0.05 + R() * 0.04
    const wobA = R() * Math.PI * 2
    const rosetteTw = R() * Math.PI * 2
    const rosette = Array.from({ length: 12 }, (_, i) => ({ a: rosetteTw + i * 2.39996 + (R() - 0.5) * 0.3, s: 0.85 + R() * 0.3, tone: Math.floor(R() * LEAF_TONES.length), tw: (R() - 0.5) * 0.6, g: i < 5 ? -1 : (i - 5) * 0.45 }))
    const sats = Array.from({ length: 5 }, (_, i) => ({ a: leanA + Math.PI + (i - 2) * 1.15 + (R() - 0.5) * 0.5, r: 0.15 + R() * 0.16, h: 0.5 + R() * 0.2, lean: 0.12 + R() * 0.12, phase: R() * 6.28, g: [0.45, 1.05, 1.65, 2.2, 2.7][i], tone: R(), leafA: R() * 6.28 }))
    const sideBlooms = [
      { u: 0.74, a: leanA + 2.3 + (R() - 0.5) * 0.4, len: 0.11 + R() * 0.03, g: 1.55, open: true },
      { u: 0.6, a: leanA - 2.0 + (R() - 0.5) * 0.4, len: 0.12 + R() * 0.03, g: 2.25, open: true },
      { u: 0.84, a: leanA - 0.9 + (R() - 0.5) * 0.4, len: 0.06 + R() * 0.02, g: 0.95, open: false },
      { u: 0.5, a: leanA + 1.1 + (R() - 0.5) * 0.4, len: 0.07 + R() * 0.02, g: 1.9, open: false },
      { u: 0.88, a: leanA + 3.6 + (R() - 0.5) * 0.4, len: 0.05 + R() * 0.02, g: 2.7, open: false },
    ]

    // --- the main stem
    const mainPhase = 0
    const n = 10
    const lean = new THREE.Vector3(Math.cos(leanA), 0, Math.sin(leanA))
    const wob = new THREE.Vector3(Math.cos(wobA), 0, Math.sin(wobA))
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      pts.push(new THREE.Vector3(0, soilHeight(0) + H * t, 0).addScaledVector(lean, leanAmt * H * Math.pow(t, 1.6)).addScaledVector(wob, Math.sin(t * Math.PI) * 0.012))
    }
    // ageing: from the break-out on, a little thicker and woody at the foot
    const age = smooth(3, 6.5, L)
    const r0 = 0.0085 + 0.007 * smooth(0, 3, L) + 0.0025 * age
    this.stems = [{ pts, r0, r1: r0 * 0.55, phase: mainPhase, g: -1 }]
    this.attr(1, mainPhase, PART.stem, sink)
    // grounded: a short flare into the soil
    const foot = [new THREE.Vector3(0, soilHeight(0) - 0.012, 0), ...pts]
    tube(sink, this.stemRings(foot, r0 * 1.5, r0 * 0.55, STEM_FOOT.clone().lerp(WOODY, 0.55 * age), STEM_TOP, always), 5)

    // --- the rosette of leaves at its foot
    this.attr(0.25, mainPhase, PART.leaf, sink)
    const rosetteSize = 0.11 + 0.06 * (1 - Math.exp(-0.9 * L))
    rosette.forEach((lf, i) => {
      if (lf.g > L) return
      const d = new THREE.Vector3(Math.cos(lf.a), 0.75 + lf.s * 0.2, Math.sin(lf.a))
      const b = new THREE.Vector3(Math.cos(lf.a) * 0.012, soilHeight(0) + 0.006, Math.sin(lf.a) * 0.012)
      // the oldest leaves yellow and lie flatter as the plant ages
      const old = i < 5 ? smooth(4.2 + i * 0.35, 5.6 + i * 0.35, L) : 0
      const tone = LEAF_TONES[lf.tone].clone().lerp(OLD_LEAF, 0.45 * old)
      leaf(sink, b, d, UP, { len: rosetteSize * lf.s, width: 0.36, arch: 0.55 - 0.2 * old, droop: 0.95 + 0.25 * old, fold: 0.22, twist: lf.tw, color: tone }, at(lf.g))
    })

    // --- leaves in pairs up the stem, each pair turned a quarter from the last
    this.attr(1, mainPhase, PART.leaf, sink)
    const pairs = [
      { u: 0.24, g: -1 },
      { u: 0.43, g: 0.55 },
      { u: 0.6, g: 1.35 },
    ]
    pairs.forEach((pr, k) => {
      if (pr.g > L) return
      const s = this.along(0, pr.u)
      for (const side of [-1, 1]) {
        const a = leanA + k * (Math.PI / 2) + (side > 0 ? 0 : Math.PI) + 0.3
        const d = new THREE.Vector3(Math.cos(a), 0.55, Math.sin(a))
        leaf(sink, s.p.clone().addScaledVector(d.clone().setY(0).normalize(), s.r), d, UP, { len: (0.07 + 0.035 * smooth(0, 2.5, L)) * (1 - pr.u * 0.3), width: 0.33, arch: 0.4, droop: 0.7, fold: 0.25, twist: side * 0.2, color: LEAF_TONES[(k * 2 + (side > 0 ? 1 : 0)) % LEAF_TONES.length] }, at(pr.g))
      }
    })

    // --- the main flower
    const top = pts[pts.length - 1]
    const axis = top.clone().sub(pts[pts.length - 3]).normalize().lerp(lean, 0.35).normalize()
    this.head.p.copy(top)
    this.head.axis.copy(axis)
    // a young plant already flowers: its first bloom half open at stage 0,
    // wide open by stage 1
    const open = 0.4 + 0.6 * smooth(0, 1.1, L)
    const petalLen = 0.07 + 0.058 * (1 - Math.exp(-0.8 * L))
    this.attr(1, mainPhase, PART.petal, sink)
    // late on the main flower's petals turn back a little more and blush at the tips
    const late = smooth(4.8, 6.8, L)
    bloom(sink, top.clone().addScaledVector(axis, 0.006), axis, lean, { petals: 8, rings: L >= 1.4 ? (L >= 2.3 ? 3 : 2) : 1, ringGates: [-1, 1.4, 2.3], open, size: petalLen, tip: PETAL_TIP.clone().lerp(PETAL_BASE, 0.18 * late), base: PETAL_BASE, cup: 0.18, curl: 0.35 + 0.22 * late, R }, always)

    // --- the second and third blooms and the side buds, off the upper stem
    // the open ones go to seed in time; the buds open in a second flush
    const SEEDS_AT = [3.7, 4.7, 6.1, 6.6, 7.5]
    const FLUSH_AT = [0, 0, 3.3, 4.3, 5.3]
    sideBlooms.forEach((sb, i) => {
      if (sb.g > L) return
      const s = this.along(0, sb.u)
      const out = new THREE.Vector3(Math.cos(sb.a), 0, Math.sin(sb.a))
      const len = sb.len * (H / 0.6)
      const p1 = s.p.clone().addScaledVector(out, len * 0.55).addScaledVector(UP, len * 0.35)
      const p2 = s.p.clone().addScaledVector(out, len * 0.8).addScaledVector(UP, len * 0.95)
      const stalk = [s.p.clone(), p1, p2]
      this.attr(1, mainPhase, PART.stem, sink)
      tube(sink, this.stemRings(stalk, s.r * 0.6, s.r * 0.45, STEM_TOP, STEM_TOP, at(sb.g)), 4)
      const ax = p2.clone().sub(p1).normalize().lerp(out, 0.2).normalize()
      const sOpen = sb.open ? 0.15 + 0.85 * smooth(sb.g, sb.g + 0.7, L) : 0.04
      const first: BloomOpts = { petals: sb.open ? 7 : 6, rings: sb.open && L > sb.g + 0.8 ? 2 : 1, open: sOpen, size: petalLen * (sb.open ? 0.78 : 0.42), tip: PETAL_TIP, base: PETAL_BASE, cup: 0.18, curl: 0.3, R, low: !sb.open }
      const seeded = L >= SEEDS_AT[i]
      const flush = !sb.open && L >= FLUSH_AT[i]
      if (!seeded && !flush) {
        this.attr(1, mainPhase, PART.petal, sink)
        bloom(sink, p2, ax, out, first, at(sb.g))
        return
      }
      // R is drawn just as for the first bloom, so nothing after it moves
      bloom(new GrowthSink(), p2, ax, out, first, at(sb.g))
      if (seeded) {
        this.attr(1, mainPhase, PART.stem, sink)
        seedHead(sink, p2, ax.clone().lerp(UP, 0.3).normalize(), petalLen * 0.5, true, FREE, at(sb.g))
        return
      }
      const f = smooth(FLUSH_AT[i], FLUSH_AT[i] + 0.7, L)
      this.attr(1, mainPhase, PART.petal, sink)
      bloom(sink, p2, ax, out, { petals: 7, rings: L > FLUSH_AT[i] + 0.8 ? 2 : 1, open: 0.15 + 0.85 * f, size: petalLen * (0.42 + 0.3 * f), tip: PETAL_TIP, base: PETAL_BASE, cup: 0.18, curl: 0.3, R: rng(PLANT_SEED + 10 + i), low: f < 0.4 }, at(sb.g))
    })

    // the second flush: new flowering shoots off the upper stem, from their
    // own stream so nothing drawn before them moves
    {
      const F = rng(PLANT_SEED + 3)
      const shoots = [
        { u: 0.68, g: 4.0 },
        { u: 0.56, g: 4.8 },
        { u: 0.8, g: 5.6 },
      ].map(sh => ({ ...sh, a: leanA + Math.PI + (F() - 0.5) * 2.4, len: 0.1 + F() * 0.04, petals: 6 + Math.floor(F() * 2) }))
      for (const sh of shoots) {
        if (sh.g > L) continue
        const s = this.along(0, sh.u)
        const out = new THREE.Vector3(Math.cos(sh.a), 0, Math.sin(sh.a))
        const len = sh.len * (H / 0.6)
        const p1 = s.p.clone().addScaledVector(out, len * 0.5).addScaledVector(UP, len * 0.3)
        const p2 = s.p.clone().addScaledVector(out, len * 0.78).addScaledVector(UP, len * 0.9)
        this.attr(1, mainPhase, PART.stem, sink)
        tube(sink, this.stemRings([s.p.clone(), p1, p2], s.r * 0.55, s.r * 0.4, STEM_TOP, STEM_TOP, at(sh.g)), 4)
        const ax = p2.clone().sub(p1).normalize().lerp(out, 0.2).normalize()
        this.attr(1, mainPhase, PART.leaf, sink)
        leaf(sink, s.p.clone().lerp(p1, 0.7), out.clone().addScaledVector(UP, 0.5), UP, { len: 0.05, width: 0.32, arch: 0.4, droop: 0.7, fold: 0.25, twist: 0.2, rows: 4, color: LEAF_TONES[2] }, at(sh.g))
        this.attr(1, mainPhase, PART.petal, sink)
        const op = 0.04 + 0.96 * smooth(sh.g + 0.15, sh.g + 0.85, L)
        bloom(sink, p2, ax, out, { petals: sh.petals, rings: 1, open: op, size: petalLen * (0.42 + 0.3 * smooth(sh.g, sh.g + 0.8, L)), tip: PETAL_TIP, base: PETAL_BASE, cup: 0.18, curl: 0.3, R: F, low: op < 0.5 }, at(sh.g))
      }
    }

    // --- the smaller flowering stems coming up round it
    sats.forEach((st, k) => {
      if (st.g > L) return
      const foot = new THREE.Vector3(Math.cos(st.a) * st.r, soilHeight(st.r) - 0.004, Math.sin(st.a) * st.r)
      const out = new THREE.Vector3(Math.cos(st.a), 0, Math.sin(st.a))
      const h = H * st.h * (0.75 + 0.25 * smooth(st.g, st.g + 1, L))
      const sp: THREE.Vector3[] = []
      for (let i = 0; i <= 6; i++) {
        const t = i / 6
        sp.push(foot.clone().addScaledVector(UP, h * t).addScaledVector(out, st.lean * h * t * t))
      }
      const life = at(st.g)
      this.stems.push({ pts: sp, r0: 0.006, r1: 0.0035, phase: st.phase, g: st.g })
      this.attr(1, st.phase, PART.stem, sink)
      tube(sink, this.stemRings(sp, 0.006, 0.0035, STEM_FOOT, STEM_TOP, life), 4)
      // a pair of leaves low down
      this.attr(1, st.phase, PART.leaf, sink)
      const lp = this.along(this.stems.length - 1, 0.3)
      for (const side of [-1, 1]) {
        const a = st.leafA + (side > 0 ? 0 : Math.PI)
        const d = new THREE.Vector3(Math.cos(a), 0.6, Math.sin(a))
        leaf(sink, lp.p, d, UP, { len: 0.055 + 0.02 * smooth(st.g, st.g + 1, L), width: 0.32, arch: 0.4, droop: 0.75, fold: 0.25, twist: 0, rows: 4, color: LEAF_TONES[(k + (side > 0 ? 2 : 0)) % LEAF_TONES.length] }, life)
      }
      const tipP = sp[sp.length - 1]
      const ax = tipP.clone().sub(sp[sp.length - 2]).normalize().lerp(out, 0.3).normalize()
      const sOpen = 0.08 + 0.92 * smooth(st.g + 0.1, st.g + 0.9, L)
      const tone = st.tone
      if (L >= [3.4, 4.1, 5.0, 5.7, 6.4][k]) {
        // gone to seed (R still drawn as for the bloom, so nothing after it moves)
        bloom(new GrowthSink(), tipP, ax, out, { petals: 6 + (k % 2), rings: 1, open: sOpen, size: 0.01, tip: CREAM, base: CREAM, cup: 0.2, curl: 0.25, R }, life)
        this.attr(1, st.phase, PART.stem, sink)
        seedHead(sink, tipP, ax, petalLen * 0.36, true, FREE, life)
        return
      }
      this.attr(1, st.phase, PART.petal, sink)
      bloom(sink, tipP, ax, out, { petals: 6 + (k % 2), rings: 1, open: sOpen, size: petalLen * (0.55 + 0.1 * tone), tip: PETAL_TIP.clone().lerp(CREAM, tone * 0.5), base: PETAL_BASE.clone().lerp(PETAL_TIP, 0.25 - tone * 0.25), cup: 0.2, curl: 0.25, R }, life)
    })

    // seedlings: fallen seed coming up in the soil round the mother plant
    {
      const F = rng(PLANT_SEED + 4)
      for (let i = 0; i < 7; i++) {
        const g = 4.3 + i * 0.36
        const a = leanA + Math.PI * 0.6 + i * 2.39996 + (F() - 0.5) * 0.5
        const r = 0.2 + F() * 0.42
        const tw = F() * 6.28
        const size = 0.85 + F() * 0.4
        if (g > L) continue
        const grown = smooth(g, g + 1.2, L) * size
        const footP = new THREE.Vector3(Math.cos(a) * r, soilHeight(r) - 0.002, Math.sin(a) * r)
        const h = 0.012 + 0.03 * grown
        const tipP = footP.clone().addScaledVector(UP, h)
        this.attr(0.5, tw, PART.stem, sink)
        tube(sink, this.stemRings([footP, footP.clone().lerp(tipP, 0.5).add(new THREE.Vector3(0.002, 0, 0.002)), tipP], 0.0028, 0.002, STEM_FOOT, STEM_TOP, at(g)), 3)
        this.attr(0.5, tw, PART.leaf, sink)
        for (const side of [-1, 1]) {
          const d = new THREE.Vector3(Math.cos(tw) * side, 0.7, Math.sin(tw) * side)
          leaf(sink, tipP, d, UP, { len: 0.022 + 0.026 * grown, width: 0.42, arch: 0.4, droop: 0.6, fold: 0.15, twist: 0, rows: 4, color: LEAF_TONES[(i + (side > 0 ? 3 : 0)) % LEAF_TONES.length].clone().lerp(LEAF_LIGHT, 0.2) }, at(g))
        }
      }
    }

    // --- berries on the upper stem for North's accepted experiments (one
    // side) and code-backed spec items (the other); the shader shows as many
    // as the spec has
    for (const [part, c, a] of [[PART.north, NORTH_GREEN, leanA + 1.6], [PART.gold, CODE_GOLD, leanA - 1.6]] as Array<[number, THREE.Color, number]>) {
      const s = this.along(0, 0.78)
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
      for (let i = 0; i < BERRIES; i++) {
        this.attr(1, mainPhase, part + i / 100, sink)
        const ang = a + (i - 2.5) * 0.42
        const o = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang))
        const p = s.p.clone().addScaledVector(out, s.r + 0.012).addScaledVector(o, 0.012).addScaledVector(UP, (i % 3) * 0.014 - 0.012)
        berry(sink, p, 0.008 + (i % 3) * 0.0015, c, always)
      }
    }

    sink.plantAttr = [0, 0, 0, 0]
  }

  // -------------------------------------------------------------------------
  // What each event grows on the plant
  // -------------------------------------------------------------------------

  /**
   * Grows one event's piece on the plant. `level` is the event's place in the
   * arc (it only uses stems that were there by then, so a piece never moves
   * to another stem as the plant grows), `gate` the level at which it shows,
   * `t0` when it starts to appear, `detail` how much of it old growth keeps.
   */
  grow(sink: GrowthSink, e: GrowthEvent, R: () => number, level: number, gate: number, t0: number, detail: number, stats: GrowStats): void {
    const animate = t0 > LONG_AGO + 1
    const m = e.magnitude
    const accent = accentForModel(e.model)
    const setback = e.kind === 'contribution_rejected' || e.kind === 'tests_failed'
    const dur = 2 + R() * 1.5
    const witherAt = setback ? (animate ? t0 + dur + 1.2 : LONG_AGO) : NEVER
    const timeAt = (f: number) => (animate ? t0 + f * dur : LONG_AGO)
    const tone = LEAF_TONES[Math.floor(R() * LEAF_TONES.length)]
    const phase = R() * 6.28

    // which stem: the main one or a smaller one already there at this level
    const hosts = this.stems.map((s, i) => ({ s, i })).filter(h => h.s.g <= Math.max(level, 0) + 0.05)
    const roll = R()
    const hostPick = R()
    const uPick = R()
    const sidePick = R()
    const host = hosts.length > 1 && hostPick < 0.6 ? hosts[1 + Math.floor(R() * (hosts.length - 1))] : hosts[0]
    const g = Math.max(gate, host.s.g + 0.02)
    const kept = R() < 0.1 + detail * 0.9

    // where on it, facing outward
    const site = (u0: number, u1: number) => {
      const s = this.along(host.i, lerp(u0, u1, uPick))
      const a = sidePick * Math.PI * 2
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
      out.addScaledVector(s.t, -out.dot(s.t)).normalize()
      return { p: s.p.clone().addScaledVector(out, s.r * 0.8), out, t: s.t, r: s.r }
    }
    const stalkTo = (from: THREE.Vector3, out: THREE.Vector3, len: number, rise: number, r: number, life: Life) => {
      const p1 = from.clone().addScaledVector(out, len * 0.5).addScaledVector(UP, len * rise * 0.45)
      const p2 = from.clone().addScaledVector(out, len * 0.85).addScaledVector(UP, len * rise)
      tube(sink, this.stemRings([from.clone(), p1, p2], r, r * 0.65, STEM_TOP.clone().lerp(STEM_FOOT, 0.2), STEM_TOP, life, dur * 0.6), 3)
      stats.rings += 3
      return { tip: p2, dir: p2.clone().sub(p1).normalize() }
    }
    const L0: Life = { g, appear: timeAt(0), wither: witherAt }
    const leafLife = (f: number): Life => ({ g: g + 0.01, appear: animate ? timeAt(f) + 0.35 : LONG_AGO, wither: witherAt })
    // the specimen's own petals, tinted toward the author's accent
    const tones = offspringTones(accent, 0.5)

    if (e.kind === 'epoch') {
      // leaves on a stem, a leafy side shoot, or new leaves at the foot
      const leafLen = (0.05 + m * 0.09) * (0.85 + R() * 0.3)
      const shape = { width: 0.3 + R() * 0.1, arch: 0.35 + R() * 0.2, droop: 0.6 + R() * 0.4, fold: 0.2 + R() * 0.1, twist: (R() - 0.5) * 0.6, rows: 4 }
      if (!kept) return
      if (roll < 0.42) {
        // at the foot: one or two leaves joining the rosette, or a low shoot
        const a = sidePick * Math.PI * 2
        const rr = 0.04 + uPick * 0.32
        const foot = new THREE.Vector3(Math.cos(a) * rr, soilHeight(rr) + 0.004, Math.sin(a) * rr)
        this.attr(0.4, phase, PART.leaf, sink)
        const nl = 1 + (m > 0.2 ? 1 : 0)
        for (let i = 0; i < nl; i++) {
          const aa = a + (i - (nl - 1) / 2) * 0.7
          const d = new THREE.Vector3(Math.cos(aa), 0.8 + R() * 0.4, Math.sin(aa))
          leaf(sink, foot, d, UP, { len: leafLen * 1.15, ...shape, color: tone.clone().multiplyScalar(0.92 + R() * 0.16) }, leafLife(0.2 + i * 0.2))
          stats.leaves++
        }
      } else if (roll < 0.76) {
        // a leaf (or an opposite pair) on the stem
        const s = site(0.15, host.i === 0 ? 0.68 : 0.78)
        this.attr(1, host.s.phase, PART.leaf, sink)
        const pair = R() < 0.5
        for (const side of pair ? [-1, 1] : [1]) {
          const o = s.out.clone().multiplyScalar(side)
          const d = o.clone().multiplyScalar(0.9).addScaledVector(UP, 0.55 + R() * 0.3)
          leaf(sink, s.p.clone().addScaledVector(o, s.r * 0.2), d, UP, { len: leafLen * (1 - 0.25 * (host.i > 0 ? 1 : 0)), ...shape, color: tone.clone().multiplyScalar(0.92 + R() * 0.16) }, leafLife(0.3))
          stats.leaves++
        }
      } else {
        // a short leafy shoot out from the stem, with a small bud if it was a strong round
        const s = site(0.2, 0.65)
        this.attr(1, host.s.phase, PART.stem, sink)
        const len = 0.06 + m * 0.18
        const st = stalkTo(s.p, s.out, len, 0.7, s.r * 0.55, L0)
        this.attr(1, host.s.phase, PART.leaf, sink)
        for (let i = 0; i < 2; i++) {
          const side = i === 0 ? -1 : 1
          const o = new THREE.Vector3().crossVectors(st.dir, UP).normalize().multiplyScalar(side)
          const at = s.p.clone().lerp(st.tip, 0.55 + i * 0.25)
          leaf(sink, at, o.clone().addScaledVector(UP, 0.5).addScaledVector(st.dir, 0.3), UP, { len: leafLen * 0.85, ...shape, color: tone.clone().multiplyScalar(0.92 + R() * 0.16) }, leafLife(0.5 + i * 0.2))
          stats.leaves++
        }
        if (m >= 0.25) {
          this.attr(1, host.s.phase, PART.petal, sink)
          bloom(sink, st.tip, st.dir.clone().lerp(UP, 0.5), s.out, { petals: 5, rings: 1, open: 0.02, size: 0.022, tip: PETAL_TIP, base: PETAL_BASE, cup: 0.1, curl: 0, R, low: true }, { ...L0, appear: timeAt(0.9) })
          stats.buds++
        }
      }
    } else if (e.kind === 'contribution_merged' || e.kind === 'breakthrough') {
      // a bloom in its author's colour: on a stalk off the upper stem, or a
      // slender flowering stem of its own from the soil. A breakthrough is a
      // larger, doubled bloom on a stronger stalk off the main stem.
      const big = e.kind === 'breakthrough'
      const tipC = big && accent === null ? col(0xf3d27a) : tones.tip
      const baseC = big && accent === null ? col(0xd9963a) : tones.base
      const size = big ? 0.07 + m * 0.035 : (0.036 + m * 0.036) * (0.9 + R() * 0.2)
      // most come up from the soil as stems of their own, so the main
      // flower keeps its head clear
      const ownStem = !big && roll < (hosts.length > 2 ? 0.55 : 0.7)
      const life = L0
      let tip: THREE.Vector3
      let dir: THREE.Vector3
      let ref: THREE.Vector3
      let ph = host.s.phase
      if (ownStem) {
        const a = sidePick * Math.PI * 2
        const rr = 0.1 + uPick * 0.3
        const foot = new THREE.Vector3(Math.cos(a) * rr, soilHeight(rr) - 0.004, Math.sin(a) * rr)
        const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
        // always below the main flower
        const h = Math.min(this.height * 0.72, (0.16 + m * 0.24) * (this.height / 0.6) * (0.85 + R() * 0.3))
        const sp = [0, 0.33, 0.66, 1].map(t => foot.clone().addScaledVector(UP, h * t).addScaledVector(out, 0.1 * h * t * t))
        ph = phase
        this.attr(1, ph, PART.stem, sink)
        tube(sink, this.stemRings(sp, 0.005, 0.003, STEM_FOOT, STEM_TOP, life, dur * 0.7), 3)
        stats.rings += sp.length
        this.attr(1, ph, PART.leaf, sink)
        const lp = sp[1]
        const la = a + (R() - 0.5) * 2
        leaf(sink, lp, new THREE.Vector3(Math.cos(la), 0.6, Math.sin(la)), UP, { len: 0.05 + m * 0.03, width: 0.32, arch: 0.4, droop: 0.75, fold: 0.25, twist: 0, rows: 4, color: tone }, leafLife(0.4))
        stats.leaves++
        tip = sp[3]
        dir = sp[3].clone().sub(sp[2]).normalize().lerp(out, 0.25).normalize()
        ref = out
      } else {
        const s = site(big ? 0.55 : 0.4, big ? 0.72 : 0.7)
        this.attr(1, ph, PART.stem, sink)
        const st = stalkTo(s.p, s.out, ((big ? 0.12 : 0.09) + m * 0.08) * Math.min(1, this.height / 0.55), 0.8, s.r * (big ? 0.7 : 0.5), life)
        tip = st.tip
        dir = st.dir.clone().lerp(UP, 0.55).normalize()
        ref = s.out
        if (big || R() < 0.5) {
          this.attr(1, ph, PART.leaf, sink)
          const o = new THREE.Vector3().crossVectors(st.dir, UP).normalize()
          leaf(sink, s.p.clone().lerp(st.tip, 0.4), o.addScaledVector(UP, 0.4), UP, { len: 0.045 + m * 0.04, width: 0.32, arch: 0.4, droop: 0.7, fold: 0.25, twist: 0, rows: 4, color: tone }, leafLife(0.5))
          stats.leaves++
        }
      }
      this.attr(1, ph, PART.petal, sink)
      const bl: Life = { ...life, appear: animate ? timeAt(1) + 0.4 : LONG_AGO }
      if (!big && detail < 1) {
        // over: gone to seed
        seedHead(sink, tip, dir, 0.03, false, FREE, bl)
        stats.buds++
      } else {
        bloom(sink, tip, dir, ref, { petals: big ? 9 : 6 + Math.floor(R() * 3), rings: big ? 2 : 1, open: big ? 1 : 0.6 + R() * 0.25, size, tip: tipC, base: baseC, cup: 0.22 + R() * 0.1, curl: 0.15 + R() * 0.2, R, low: !big }, bl)
        stats.flowers += big ? 2 : 1
      }
    } else if (setback) {
      // a bud on a short nodding stalk, that withers; long-gone ones have fallen
      if (detail < 1) return
      const s = site(0.3, 0.85)
      const out = s.out.clone()
      this.attr(1, host.s.phase, PART.stem, sink)
      const p1 = s.p.clone().addScaledVector(out, 0.03).addScaledVector(UP, 0.012)
      const p2 = s.p.clone().addScaledVector(out, 0.05).addScaledVector(UP, -0.006)
      tube(sink, this.stemRings([s.p.clone(), p1, p2], s.r * 0.4, s.r * 0.3, STEM_TOP, STEM_TOP.clone().lerp(BUD_REJECTED, 0.4), L0, dur * 0.5), 3)
      stats.rings += 3
      const c = (e.kind === 'tests_failed' ? BUD_FAILED : BUD_REJECTED).clone()
      this.attr(1, host.s.phase, PART.petal, sink)
      bloom(sink, p2, p2.clone().sub(p1).normalize(), out, { petals: 5, rings: 1, open: 0.03, size: 0.026 + R() * 0.008, tip: c.clone().lerp(CREAM, 0.15), base: c, cup: 0.1, curl: 0, R, low: true, sepals: true }, { ...L0, appear: timeAt(0.8) })
      stats.buds++
    } else if (e.kind === 'exhibit_merged') {
      // a fine tendril curling out from the stem, a bud at its end
      if (!kept) return
      const s = site(0.3, 0.7)
      const ring: THREE.Vector3[] = []
      const side = new THREE.Vector3().crossVectors(s.out, UP).normalize()
      const turns = 1.4 + R()
      for (let i = 0; i <= 10; i++) {
        const t = i / 10
        const rad = 0.03 * (1 - t * 0.7)
        const a = t * turns * Math.PI * 2
        ring.push(s.p.clone().addScaledVector(s.out, 0.02 + t * 0.07).addScaledVector(UP, t * 0.05 + Math.sin(a) * rad * t).addScaledVector(side, (Math.cos(a) - 1) * rad * t))
      }
      this.attr(1, host.s.phase, PART.stem, sink)
      tube(sink, this.stemRings(ring, 0.0022, 0.0012, STEM_TOP, STEM_TOP.clone().lerp(LEAF_LIGHT, 0.4), L0, dur), 3)
      stats.rings += ring.length
      if (accent !== null) {
        this.attr(1, host.s.phase, PART.petal, sink)
        berry(sink, ring[ring.length - 1], 0.006, new THREE.Color(accent).lerp(CREAM, 0.3), { ...L0, appear: timeAt(1) })
      }
    }
    sink.plantAttr = [0, 0, 0, 0]
  }
}
