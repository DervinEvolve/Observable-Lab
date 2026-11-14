import * as THREE from 'three'

// The buffers the overgrowth is drawn from, shared by the fixed base organism
// (Overgrowth.ts) and the growth each real event adds (eventGrowth.ts). Stems,
// flowers, buds and floor cracks all go into one merged mesh (the flowers are
// the specimen's own, specimen.ts); leaves are instanced. Every vertex carries:
//   aGrow   the growth level at which it is drawn (the stage gate)
//   aSpine  the point it grows out of
//   aPrev   where its ring starts before sliding out (the tip of a growing stem)
//   aSurf   the surface it lies on (FREE, WALL, CEIL), for the doll's-house cut
//   aLife   when it appears and when it starts to wither, in seconds on the
//           room's clock (LONG_AGO = already there, NEVER = never withers)
//   aPlant  zero, except on the flowering plant in the dome (specimen.ts):
//           (1, how far it sways, its sway phase, which part it is)

export const FREE = 0
export const WALL = 1
export const CEIL = 2
export const LONG_AGO = -1e4
export const NEVER = 1e9

export interface LeafSpec {
  m: THREE.Matrix4
  thr: number
  phase: number
  surf: number
  sway: number
  color: THREE.Color
  appear: number
  wither: number
}

export class GrowthSink {
  pos: number[] = []
  nor: number[] = []
  col: number[] = []
  grow: number[] = []
  spine: number[] = []
  prev: number[] = []
  surf: number[] = []
  life: number[] = []
  plant: number[] = []
  idx: number[] = []
  leaves: LeafSpec[] = []
  // what vert() writes to aPlant: set while drawing the flowering plant
  plantAttr: [number, number, number, number] = [0, 0, 0, 0]

  get vertexCount(): number {
    return this.pos.length / 3
  }

  vert(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, g: number, spine: THREE.Vector3, surf: number, appear = LONG_AGO, wither = NEVER, prev: THREE.Vector3 = spine): number {
    this.pos.push(p.x, p.y, p.z)
    this.nor.push(n.x, n.y, n.z)
    this.col.push(c.r, c.g, c.b)
    this.grow.push(g)
    this.spine.push(spine.x, spine.y, spine.z)
    this.prev.push(prev.x, prev.y, prev.z)
    this.surf.push(surf)
    this.life.push(appear, wither)
    const a = this.plantAttr
    this.plant.push(a[0], a[1], a[2], a[3])
    return this.pos.length / 3 - 1
  }

  /** Appends another sink's geometry (indices shifted). */
  append(o: GrowthSink): void {
    const base = this.vertexCount
    for (const k of ['pos', 'nor', 'col', 'grow', 'spine', 'prev', 'surf', 'life', 'plant'] as const) {
      const a = this[k]
      const b = o[k]
      for (let i = 0; i < b.length; i++) a.push(b[i])
    }
    for (let i = 0; i < o.idx.length; i++) this.idx.push(o.idx[i] + base)
    for (const l of o.leaves) this.leaves.push(l)
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    geo.setAttribute('aGrow', new THREE.Float32BufferAttribute(this.grow, 1))
    geo.setAttribute('aSpine', new THREE.Float32BufferAttribute(this.spine, 3))
    geo.setAttribute('aPrev', new THREE.Float32BufferAttribute(this.prev, 3))
    geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 1))
    geo.setAttribute('aLife', new THREE.Float32BufferAttribute(this.life, 2))
    geo.setAttribute('aPlant', new THREE.Float32BufferAttribute(this.plant, 4))
    geo.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    geo.computeBoundingSphere()
    return geo
  }
}

/** One ring of a stem. */
export interface Ring {
  p: THREE.Vector3 // centre
  n: THREE.Vector3 // the surface's normal there (frame reference)
  r: number
  g: number
  surf: number
  c: THREE.Color
  appear: number
  wither: number
  tw?: number // how far the cross-section has turned about the stem (radians): a slight twist along a stem
}

const _T = new THREE.Vector3()
const _N = new THREE.Vector3()
const _B = new THREE.Vector3()
const _O = new THREE.Vector3()
const _V = new THREE.Vector3()

/**
 * A tube through the rings, `radial` sides (3 is a rounded triangle, the
 * cheapest stem that still reads as round). Each ring slides out from the
 * previous ring's centre as it appears, so a new stem extends from its tip.
 */
export function tube(sink: GrowthSink, rings: Ring[], radial = 3): void {
  if (rings.length < 2) return
  const base = sink.vertexCount
  for (let i = 0; i < rings.length; i++) {
    const a = rings[Math.max(0, i - 1)].p
    const b = rings[Math.min(rings.length - 1, i + 1)].p
    _T.subVectors(b, a)
    if (_T.lengthSq() < 1e-12) _T.set(0, 1, 0)
    _T.normalize()
    const R = rings[i]
    _N.copy(R.n).addScaledVector(_T, -R.n.dot(_T))
    if (_N.lengthSq() < 1e-6) _N.set(_T.y, -_T.x, 0.3).addScaledVector(_T, -_T.dot(_N))
    _N.normalize()
    _B.crossVectors(_T, _N).normalize()
    const prev = rings[Math.max(0, i - 1)].p
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2 + 0.5 + (R.tw ?? 0)
      _O.copy(_N).multiplyScalar(Math.cos(th)).addScaledVector(_B, Math.sin(th))
      _V.copy(R.p).addScaledVector(_O, R.r)
      sink.vert(_V, _O, R.c, R.g, R.p, R.surf, R.appear, R.wither, prev)
    }
    if (i > 0) {
      const r0 = base + (i - 1) * radial
      const r1 = base + i * radial
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial
        sink.idx.push(r0 + j, r1 + j, r0 + j1, r0 + j1, r1 + j, r1 + j1)
      }
    }
  }
}

/**
 * A flat strip through the rings, lying in the surface (its width across the
 * stem, in the plane the ring's normal faces out of): two triangles a
 * segment, for stems that creep along the floor, walls and ceiling.
 */
export function ribbon(sink: GrowthSink, rings: Ring[]): void {
  if (rings.length < 2) return
  const base = sink.vertexCount
  const nrm = new THREE.Vector3()
  for (let i = 0; i < rings.length; i++) {
    const a = rings[Math.max(0, i - 1)].p
    const b = rings[Math.min(rings.length - 1, i + 1)].p
    _T.subVectors(b, a)
    if (_T.lengthSq() < 1e-12) _T.set(0, 1, 0)
    _T.normalize()
    const R = rings[i]
    _N.copy(R.n).addScaledVector(_T, -R.n.dot(_T))
    if (_N.lengthSq() < 1e-6) _N.set(_T.y, -_T.x, 0.3).addScaledVector(_T, -_T.dot(_N))
    _N.normalize()
    _B.crossVectors(_T, _N).normalize()
    if (R.tw) {
      // turn the strip a little about the stem
      const c = Math.cos(R.tw)
      const sn = Math.sin(R.tw)
      _O.copy(_B).multiplyScalar(c).addScaledVector(_N, sn)
      _N.multiplyScalar(c).addScaledVector(_B, -sn)
      _B.copy(_O)
    }
    const prev = rings[Math.max(0, i - 1)].p
    for (const side of [-1, 1]) {
      // edges lean their normals outward so the strip shades like a rounded stem
      nrm.copy(_N).multiplyScalar(0.6).addScaledVector(_B, side * 0.8).normalize()
      _V.copy(R.p).addScaledVector(_B, side * R.r * 1.15).addScaledVector(_N, R.r * 0.3)
      sink.vert(_V, nrm, R.c, R.g, R.p, R.surf, R.appear, R.wither, prev)
    }
    if (i > 0) {
      const p = base + (i - 1) * 2
      sink.idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3)
    }
  }
}

/**
 * Where to set the rings of a smooth stem through `pts`: a centripetal
 * Catmull-Rom spline through the points, sampled finely, with a ring wherever
 * the stem has turned by `maxTurn` radians or run `maxLen` metres since the
 * last one (never closer than `minLen`). Straight runs stay cheap and bends
 * get the rings. Each station is its point on the spline and its place
 * between the input points (0 .. pts.length - 1), for interpolating the rest.
 */
export function splineStations(pts: THREE.Vector3[], maxTurn: number, maxLen: number, minLen = 0.02): Array<{ p: THREE.Vector3; f: number }> {
  const n = pts.length
  if (n < 2) return pts.map((p, i) => ({ p: p.clone(), f: i }))
  if (n === 2) return [{ p: pts[0].clone(), f: 0 }, { p: pts[1].clone(), f: 1 }]
  let chord = 0
  for (let i = 1; i < n; i++) chord += pts[i].distanceTo(pts[i - 1])
  if (chord < 1e-5) return [{ p: pts[0].clone(), f: 0 }, { p: pts[n - 1].clone(), f: n - 1 }]
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
  const N = Math.min((n - 1) * 24, Math.max((n - 1) * 3, Math.ceil(chord / 0.012)))
  const out: Array<{ p: THREE.Vector3; f: number }> = [{ p: pts[0].clone(), f: 0 }]
  const lastT = new THREE.Vector3()
  const t = new THREE.Vector3()
  const prevP = pts[0].clone()
  const p = new THREE.Vector3()
  curve.getPoint(1 / N, p)
  lastT.subVectors(p, prevP).normalize()
  let run = 0
  let turned = 0
  const prevT = lastT.clone()
  for (let i = 1; i <= N; i++) {
    curve.getPoint(i / N, p)
    const step = p.distanceTo(prevP)
    if (step > 1e-7) {
      t.subVectors(p, prevP).divideScalar(step)
      turned += prevT.angleTo(t)
      prevT.copy(t)
    }
    run += step
    prevP.copy(p)
    if (i === N) break
    if (run >= minLen && (run >= maxLen || turned >= maxTurn)) {
      out.push({ p: p.clone(), f: (i / N) * (n - 1) })
      run = 0
      turned = 0
    }
  }
  // the tip: merge a very short last stretch into it
  if (out.length > 1 && run < minLen * 0.5) out.pop()
  out.push({ p: pts[n - 1].clone(), f: n - 1 })
  return out
}

/**
 * Triangles over the points given (three indices each), each vertex's normal
 * from the faces round it, so a small shape shades smoothly.
 */
export function facets(sink: GrowthSink, P: THREE.Vector3[], C: THREE.Color[], tris: number[], spine: THREE.Vector3, g: number, surf: number, appear: number, wither: number): void {
  const nrm = P.map(() => new THREE.Vector3())
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k]
    const b = tris[k + 1]
    const c = tris[k + 2]
    _T.subVectors(P[b], P[a])
    _N.subVectors(P[c], P[a])
    _B.crossVectors(_T, _N)
    nrm[a].add(_B)
    nrm[b].add(_B)
    nrm[c].add(_B)
  }
  const base = sink.vertexCount
  for (let i = 0; i < P.length; i++) {
    const n = nrm[i]
    if (n.lengthSq() < 1e-16) n.set(0, 1, 0)
    sink.vert(P[i], n.normalize(), C[i], g, spine, surf, appear, wither)
  }
  for (const k of tris) sink.idx.push(base + k)
}

// Leaf: blade along +Y from its stalk at the origin, face normal +Z, folded
// along the midrib. Two triangles.
export function leafGeometry(): THREE.BufferGeometry {
  const v = [
    0, 0, 0, // base
    -0.34, 0.45, 0.1, // left
    0, 1, 0.03, // tip
    0.34, 0.45, 0.1, // right
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  g.setIndex([0, 2, 1, 0, 3, 2])
  g.computeVertexNormals()
  return g
}

export function leafMatrix(pos: THREE.Vector3, dir: THREE.Vector3, normal: THREE.Vector3, size: number, width = 1): THREE.Matrix4 {
  const y = dir.clone().normalize()
  const z = normal.clone().addScaledVector(y, -normal.dot(y))
  if (z.lengthSq() < 1e-6) z.set(1, 0, 0).addScaledVector(y, -y.x)
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1)
  z.normalize()
  const x = new THREE.Vector3().crossVectors(y, z).normalize()
  const m = new THREE.Matrix4().makeBasis(x.multiplyScalar(size * width), y.multiplyScalar(size), z.multiplyScalar(size))
  m.setPosition(pos)
  return m
}
