import * as THREE from 'three'

// The buffers the overgrowth is drawn from, shared by the fixed base organism
// (Overgrowth.ts) and the growth each real event adds (eventGrowth.ts). Stems,
// flowers, buds and floor cracks all go into one merged mesh; leaves are
// instanced. Every vertex carries:
//   aGrow   the growth level at which it is drawn (the stage gate)
//   aSpine  the point it grows out of
//   aPrev   where its ring starts before sliding out (the tip of a growing stem)
//   aSurf   the surface it lies on (FREE, WALL, CEIL), for the doll's-house cut
//   aLife   when it appears and when it starts to wither, in seconds on the
//           room's clock (LONG_AGO = already there, NEVER = never withers)

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
  idx: number[] = []
  leaves: LeafSpec[] = []

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
    return this.pos.length / 3 - 1
  }

  /** Appends another sink's geometry (indices shifted). */
  append(o: GrowthSink): void {
    const base = this.vertexCount
    for (const k of ['pos', 'nor', 'col', 'grow', 'spine', 'prev', 'surf', 'life'] as const) {
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
      const th = (j / radial) * Math.PI * 2 + 0.5
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

export interface FlowerOpts {
  petals: number // 4..9
  notch: number // 0.2..0.6: how broad each petal is at its base
  cup: number // petal tips lift toward the viewer
  color: THREE.Color
  heart: THREE.Color
  g: number
  surf: number
  appear: number
  wither: number
  twist?: number
}

/**
 * A ring of petals facing `facing`, one wedge-shaped triangle a petal, gold
 * at the heart, coloured at the rim.
 */
export function flower(sink: GrowthSink, centre: THREE.Vector3, facing: THREE.Vector3, ref: THREE.Vector3, size: number, o: FlowerOpts): void {
  const z = facing.clone().normalize()
  const x = ref.clone().addScaledVector(z, -ref.dot(z))
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0).addScaledVector(z, -z.x)
  if (x.lengthSq() < 1e-6) x.set(0, 1, 0).addScaledVector(z, -z.y)
  x.normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  const n = Math.max(3, Math.round(o.petals))
  const tw = o.twist ?? 0
  const half = (Math.PI / n) * (0.6 + o.notch * 0.6)
  const base = o.color.clone().lerp(o.heart, 0.55)
  const at = (a: number, r: number, lift: number) => centre.clone().addScaledVector(x, Math.cos(a) * r).addScaledVector(y, Math.sin(a) * r).addScaledVector(z, lift)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + tw
    const h = sink.vert(at(a, size * 0.06, size * 0.08), z, base, o.g, centre, o.surf, o.appear, o.wither)
    const l = sink.vert(at(a - half, size, o.cup * size), z, o.color, o.g, centre, o.surf, o.appear, o.wither)
    const r = sink.vert(at(a + half, size, o.cup * size), z, o.color, o.g, centre, o.surf, o.appear, o.wither)
    sink.idx.push(h, l, r)
  }
}

/** A closed bud on the end of a stem: 6 triangles. */
export function bud(sink: GrowthSink, base: THREE.Vector3, dir: THREE.Vector3, size: number, c: THREE.Color, g: number, surf: number, appear: number, wither: number): void {
  const d = dir.clone().normalize()
  const side = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(d, side).normalize()
  const v = new THREE.Vector3().crossVectors(d, u)
  const b = sink.vert(base, d.clone().negate(), c, g, base, surf, appear, wither)
  const ring: number[] = []
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const o = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a))
    ring.push(sink.vert(base.clone().addScaledVector(d, size * 0.42).addScaledVector(o, size * 0.32), o, c, g, base, surf, appear, wither))
  }
  const t = sink.vert(base.clone().addScaledVector(d, size), d, c, g, base, surf, appear, wither)
  for (let i = 0; i < 3; i++) {
    const a = ring[i]
    const b2 = ring[(i + 1) % 3]
    sink.idx.push(b, b2, a, a, b2, t)
  }
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
