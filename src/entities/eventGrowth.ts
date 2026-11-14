import * as THREE from 'three'
import { LAB_HEIGHT } from '../scene/Lab'
import { STATION_RADIUS } from './Station'
import { accentForModel, eventRandom, lineageOf, type GrowthEvent } from '../systems/growthEvents'
import { CEIL, FREE, GrowthSink, LONG_AGO, NEVER, WALL, bud, flower, leafMatrix, ribbon, tube, type Ring } from './growthParts'

// The growth each real event adds. The base organism (Overgrowth.ts) is the
// same in every run; on top of it, every event in growth_events grows its own
// piece, from its own random stream (seeded by the event id), so the same
// event grows the same way on every screen and every reload, and no two
// events grow alike.
//
// Where: the room is unrolled into one chart, a surface of revolution traced
// from the soil in the dome, up the inside of the glass, over the rim and down
// the plinth, across the floor, up the wall and across the ceiling. A point is
// (angle round the room, distance s along that profile, lift off the surface).
// An event's level says how far along s it can reach (the stage arc); growth
// is a turtle walking the chart, drawn back toward attraction points ahead of
// it, so it bends, branches and tapers, then is lifted into the room.
//
// Whose: each model follows one of the five base runners, and each new piece
// starts from the most recent growth by the same model near where it is
// heading, so a model's work forms its own line through the room.

// ---------------------------------------------------------------------------
// The profile: (r, y) points in order, with what each stretch lies on
// ---------------------------------------------------------------------------
interface PSample {
  s: number
  r: number
  y: number
  nr: number
  ny: number
  surf: number
}

const WALL_FACE = 8.2
const CEIL_Y = LAB_HEIGHT - 0.03

function arc(cx: number, cy: number, R: number, a0: number, a1: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R])
  }
  return out
}

function line(a: [number, number], b: [number, number], n: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
  return out
}

// stretch boundaries, filled in when the profile is built
const MARK = { soil: 0, glass: 0, rim: 0, floor: 0, wall: 0, ceiling: 0, end: 0 }

const PROFILE: PSample[] = (() => {
  const pts: Array<[number, number]> = []
  const marks: number[] = []
  const add = (seg: Array<[number, number]>) => {
    marks.push(pts.length)
    for (const p of seg) {
      const last = pts[pts.length - 1]
      if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-4) continue
      pts.push(p)
    }
  }
  add(line([0.2, 0.31], [0.9, 0.31], 14)) // soil in the dome
  add(arc(0, 0.3, 0.95, 0.04, 0.42, 8)) // up the inside of the glass
  // over the broken rim and down the plinth
  add([[0.95 * Math.cos(0.42) + 0.04, 0.3 + 0.95 * Math.sin(0.42) + 0.06], [1.0, 0.74], [1.07, 0.66], [1.11, 0.5], [1.13, 0.36], [1.22, 0.3], [1.38, 0.2], [1.55, 0.04], [1.66, 0.006]])
  add(line([1.66, 0.006], [7.7, 0.006], 60)) // the floor
  add([[7.88, 0.03], [8.05, 0.16], [WALL_FACE, 0.32], ...line([WALL_FACE, 0.45], [WALL_FACE, LAB_HEIGHT - 0.35], 16)]) // the rail and the wall
  add([[8.12, LAB_HEIGHT - 0.12], [7.9, CEIL_Y], ...line([7.6, CEIL_Y], [0.55, CEIL_Y], 40)]) // the ceiling
  const out: PSample[] = []
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const tr = b[0] - a[0]
    const ty = b[1] - a[1]
    const l = Math.hypot(tr, ty) || 1
    // left of the direction of travel is the side the plant lies on
    const [r, y] = pts[i]
    const surf = r >= 8.0 && y > 0.25 && y < LAB_HEIGHT - 0.2 ? WALL : y > LAB_HEIGHT - 0.2 ? CEIL : FREE
    out.push({ s, r, y, nr: -ty / l, ny: tr / l, surf })
  }
  const sAt = (k: number) => out[Math.min(out.length - 1, marks[k])].s
  MARK.soil = 0
  MARK.glass = sAt(1)
  MARK.rim = sAt(2)
  MARK.floor = sAt(3)
  MARK.wall = sAt(4)
  MARK.ceiling = sAt(5)
  MARK.end = out[out.length - 1].s
  return out
})()

function sample(s: number): PSample {
  const P = PROFILE
  if (s <= 0) return P[0]
  if (s >= P[P.length - 1].s) return P[P.length - 1]
  let lo = 0
  let hi = P.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (P[m].s <= s) lo = m
    else hi = m
  }
  const a = P[lo]
  const b = P[hi]
  const t = (s - a.s) / Math.max(1e-6, b.s - a.s)
  const nr = a.nr + (b.nr - a.nr) * t
  const ny = a.ny + (b.ny - a.ny) * t
  const nl = Math.hypot(nr, ny) || 1
  return { s, r: a.r + (b.r - a.r) * t, y: a.y + (b.y - a.y) * t, nr: nr / nl, ny: ny / nl, surf: t < 0.5 ? a.surf : b.surf }
}

/** Where along the profile the frontier is at growth level L (0..7). */
export function sOfLevel(L: number): number {
  const at = (r: number) => MARK.soil + (r - 0.2) // soil runs r 0.2..0.9 at constant y
  const knots: Array<[number, number]> = [
    [0, at(0.28)],
    [1, at(0.6)],
    [2, MARK.glass],
    [3, MARK.rim - 0.01],
    [3.5, MARK.floor],
    [5, MARK.wall],
    [6, MARK.ceiling],
    [7, MARK.end],
  ]
  const l = Math.max(0, Math.min(7, L))
  for (let i = 1; i < knots.length; i++) {
    if (l <= knots[i][0]) {
      const [l0, s0] = knots[i - 1]
      const [l1, s1] = knots[i]
      return s0 + ((l - l0) / (l1 - l0)) * (s1 - s0)
    }
  }
  return MARK.end
}

const effR = (s: number) => Math.max(0.3, sample(s).r)

function vigourAt(s: number): number {
  const knots: Array<[number, number]> = [
    [MARK.glass, 0.65],
    [MARK.rim, 0.85],
    [MARK.floor, 1.2],
    [MARK.wall, 1.6],
    [MARK.ceiling, 2.0],
    [MARK.end, 2.2],
  ]
  if (s <= knots[0][0]) return knots[0][1]
  for (let i = 1; i < knots.length; i++) {
    if (s <= knots[i][0]) return lerp(knots[i - 1][1], knots[i][1], (s - knots[i - 1][0]) / (knots[i][0] - knots[i - 1][0]))
  }
  return 2.2
}

/** A chart point in the room. */
export function chartPoint(theta: number, s: number, lift: number, out = new THREE.Vector3()): THREE.Vector3 {
  const p = sample(s)
  const c = Math.cos(theta)
  const sn = Math.sin(theta)
  return out.set((p.r + p.nr * lift) * c, p.y + p.ny * lift, (p.r + p.nr * lift) * sn)
}

export function chartNormal(theta: number, s: number, out = new THREE.Vector3()): THREE.Vector3 {
  const p = sample(s)
  return out.set(p.nr * Math.cos(theta), p.ny, p.nr * Math.sin(theta))
}

/** The nearest chart point to a room point, or null when it is not on the profile. */
export function toChart(p: THREE.Vector3, tolerance = 0.14): { theta: number; s: number } | null {
  const r = Math.hypot(p.x, p.z)
  let best = Infinity
  let bi = -1
  for (let i = 0; i < PROFILE.length; i++) {
    const d = (PROFILE[i].r - r) ** 2 + (PROFILE[i].y - p.y) ** 2
    if (d < best) {
      best = d
      bi = i
    }
  }
  if (bi < 0 || Math.sqrt(best) > tolerance) return null
  return { theta: Math.atan2(p.z, p.x), s: PROFILE[bi].s }
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

function chartDist(t0: number, s0: number, t1: number, s1: number): number {
  const dx = wrap(t1 - t0) * effR((s0 + s1) / 2)
  return Math.hypot(dx, s1 - s0)
}

// ---------------------------------------------------------------------------
// Inputs from the room
// ---------------------------------------------------------------------------

/** A point on the base organism that event growth can start from. */
export interface Anchor {
  theta: number
  s: number
  g: number // level at which the base reaches it
  family: number // which of the five runners
}

/** Where an exhibit stands: its bay's angle round the room, its model and when it merged. */
export interface ExhibitBayRef {
  angle: number
  model: string | null
  mergedAt: number
}

interface Node {
  theta: number
  s: number
  lift: number
  model: string | null
  event: number // index, -1 for the base
  level: number
}

export interface GrowStats {
  events: number
  rings: number
  leaves: number
  flowers: number
  buds: number
  desks: number
}

// The desk legs (Station.ts: legs at x ±0.8, z ±0.35 under every desk),
// in the room, and each desk's middle.
const DESKS = [0, 1, 2, 3, 4].map(i => {
  const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2
  const m = new THREE.Matrix4().makeRotationY(-angle - Math.PI / 2)
  m.setPosition(Math.cos(angle) * STATION_RADIUS, 0, Math.sin(angle) * STATION_RADIUS)
  return m
})
const DESK_LEGS: THREE.Vector3[] = DESKS.flatMap(m => [-0.8, 0.8].flatMap(x => [-0.35, 0.35].map(z => new THREE.Vector3(x, 0, z).applyMatrix4(m))))
function deskCentreOf(leg: THREE.Vector3): THREE.Vector3 {
  const i = Math.floor(DESK_LEGS.indexOf(leg) / 4)
  return new THREE.Vector3().setFromMatrixPosition(DESKS[Math.max(0, i)])
}

// Bark, leaf and petal tones that sit with the lab's wood, brass and cream.
const STEM_OLD = new THREE.Color(0x6e6a3c)
const STEM_YOUNG = new THREE.Color(0x8db04e)
const LEAF_TONES = [0x6f9a42, 0x7cb342, 0x8bc34a, 0x5f8a3a, 0x9ab755, 0x76a544, 0x86a83f].map(c => new THREE.Color(c))
const CREAM = new THREE.Color(0xf4ecd8)
const GOLD = new THREE.Color(0xe8b64c)
const HEART = new THREE.Color(0xf0c04a)
const BUD_REJECTED = new THREE.Color(0xa9b46a)
const BUD_FAILED = new THREE.Color(0xb7845c)
const SETBACK_STEM = new THREE.Color(0x8f9450)
const BARK = new THREE.Color(0x7a6444)

// How each kind grows. Lengths in metres; magnitude scales between lo and hi.
interface Habit {
  len: [number, number]
  radius: [number, number]
  leaves: number // leaves per metre
  leafSize: [number, number]
  branches: [number, number]
  back: number // how far behind the frontier it tends to start
  dur: [number, number] // seconds to grow in
}

const HABITS: Record<GrowthEvent['kind'], Habit> = {
  epoch: { len: [0.26, 0.6], radius: [0.007, 0.012], leaves: 10, leafSize: [0.09, 0.14], branches: [0, 1], back: 0.9, dur: [2.5, 3.5] },
  contribution_merged: { len: [1.1, 2.5], radius: [0.014, 0.024], leaves: 6, leafSize: [0.12, 0.19], branches: [1, 3], back: 0.35, dur: [4.5, 6.5] },
  contribution_rejected: { len: [0.18, 0.26], radius: [0.006, 0.008], leaves: 6, leafSize: [0.06, 0.08], branches: [0, 0], back: 1.2, dur: [2, 2.5] },
  tests_failed: { len: [0.18, 0.26], radius: [0.006, 0.008], leaves: 6, leafSize: [0.06, 0.08], branches: [0, 0], back: 1.2, dur: [2, 2.5] },
  breakthrough: { len: [0.8, 1.6], radius: [0.018, 0.028], leaves: 8, leafSize: [0.14, 0.2], branches: [4, 6], back: 0.15, dur: [6, 8] },
  exhibit_merged: { len: [0.7, 1.2], radius: [0.007, 0.01], leaves: 8, leafSize: [0.06, 0.09], branches: [0, 0], back: 0.4, dur: [3.5, 4.5] },
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// ---------------------------------------------------------------------------
// The grower
// ---------------------------------------------------------------------------

interface Step {
  theta: number
  s: number
  lift: number
  d: number // distance from the event's start, for timing
}

interface WalkOpts {
  len: number
  step: number
  attract: number // how hard it turns toward its target, 0..1 per step
  curl: number // steady turning, rad per metre (sign = hand)
  wiggle: number
  wfreq: number
  noise: number
  lift: 'hug' | 'rise' | 'hang'
  rise: number // how high a shoot gets ('rise', 'hang'); arch height for 'hug'
  archFreq: number // arches per length ('hug'); for a shoot, how far over it bends (0.5 stays up, 1 comes back down)
  sCap: number
  coil?: number // extra turning toward the end (a tendril's curl)
}

export class EventGrower {
  private nodes: Node[] = []
  private stats: GrowStats = { events: 0, rings: 0, leaves: 0, flowers: 0, buds: 0, desks: 0 }
  private familyAnchors: Anchor[][] = [[], [], [], [], []]

  constructor(
    private sink: GrowthSink,
    anchors: Anchor[],
    private bays: ExhibitBayRef[]
  ) {
    for (const a of anchors) {
      this.familyAnchors[a.family % 5].push(a)
      this.nodes.push({ theta: a.theta, s: a.s, lift: 0.01, model: null, event: -1, level: a.g })
    }
  }

  getStats(): GrowStats {
    return this.stats
  }

  /**
   * Grows one event. `level` is where in the arc it belongs, `gate` the
   * stage at which it shows, `t0` when it starts to appear (LONG_AGO for
   * growth that is already there). `detail` 1 is fresh growth; older growth
   * (lower) keeps exactly the same shape but goes woody: fewer rings, and it
   * has dropped most of its leaves.
   */
  grow(e: GrowthEvent, index: number, level: number, gate: number, t0: number, detail = 1): void {
    const R = eventRandom(e.id)
    const H = HABITS[e.kind]
    const m = e.magnitude
    const lin = lineageOf(e.model)
    const accent = accentForModel(e.model)
    const animate = t0 > LONG_AGO + 1
    const dur = lerp(H.dur[0], H.dur[1], R())

    // the frontier for this level; before the glass breaks nothing passes it
    const sFront = sOfLevel(level)
    const sCap = level < 3 ? Math.min(sFront + 0.05, MARK.rim - 0.02) : Math.min(MARK.end - 0.05, sFront + 0.25)

    // where it heads: near its model's runner, some way behind the frontier
    const back = H.back * Math.pow(R(), 1.6) * (level < 3 ? 0.35 : 1)
    const sGuide = Math.max(0.08, Math.min(sCap - 0.02, sFront - back))
    const thetaRunner = this.runnerAngle(lin.family, sGuide, level, R)
    // spread round the room widens as the plant gets further from the dome
    const spread = (0.2 + 0.3 * Math.min(sGuide, 16)) * (R() + R() + R() - 1.5)
    let thetaGuide = thetaRunner + (lin.offset * 0.9 + spread) / effR(sGuide)

    // a tendril toward an exhibit heads for that exhibit's bay instead
    let sTarget = sGuide
    if (e.kind === 'exhibit_merged') {
      const bay = this.bayFor(e)
      if (bay !== null) {
        thetaGuide = bay
        sTarget = Math.min(sCap, MARK.wall + 1.1)
      }
    }

    // Once the plant climbs walls and desks, some shoots and vines head for a
    // desk leg instead, go up it and out across the top.
    const deskRoll = R()
    const legPick = R()
    let leg: THREE.Vector3 | null = null
    if ((e.kind === 'epoch' || e.kind === 'contribution_merged') && level >= 4.9 && deskRoll < 0.14) {
      leg = DESK_LEGS[Math.floor(legPick * DESK_LEGS.length)]
      const c = toChart(new THREE.Vector3(leg.x, 0.006, leg.z))
      if (c) {
        thetaGuide = c.theta
        sTarget = c.s
      } else leg = null
    }

    // where it starts: the closest growth to there, the same model's preferred
    const start = this.parentFor(e.model, index, thetaGuide, Math.min(sGuide, sTarget), level)

    const g = gate
    const stemC = STEM_YOUNG.clone().lerp(STEM_OLD, 0.15 + R() * 0.3)
    if (accent !== null) stemC.lerp(new THREE.Color(accent), 0.12)
    // older growth has thickened and gone to bark
    if (detail < 1) stemC.lerp(BARK, (1 - detail) * 0.75)
    const tones = [LEAF_TONES[Math.floor(R() * LEAF_TONES.length)], LEAF_TONES[Math.floor(R() * LEAF_TONES.length)]]

    // An established plant grows harder: the same kind of event grows more
    // on the open floor, walls and ceiling than in the dome.
    // (a setback stays a small dry mark wherever it is)
    const vigour = e.kind === 'contribution_rejected' || e.kind === 'tests_failed' ? Math.min(1, vigourAt(sGuide)) : vigourAt(sGuide)

    // this event's habit: how it bends, branches and sets its leaves
    const hand = R() < 0.5 ? -1 : 1
    const habit = {
      curl: hand * (0.2 + R() * 1.4),
      wiggle: 0.05 + R() * 0.35,
      wfreq: 2 + R() * 9,
      branchAngle: 0.35 + R() * 0.75,
      // alternate, golden spiral, opposite pairs, or whorls of three
      phyllo: Math.floor(R() * 4),
      divergence: [Math.PI, 2.39996, Math.PI / 2, (Math.PI * 2) / 3][0],
      leafLean: 0.5 + R() * 0.7,
      leafWidth: 0.6 + R() * 0.6,
      leafSize: lerp(H.leafSize[0], H.leafSize[1], R()) * Math.sqrt(vigour),
      spacing: ((0.75 + R() * 0.6) / H.leaves) * Math.sqrt(vigour),
      petals: 5 + Math.floor(R() * 4),
      notch: 0.25 + R() * 0.35,
      cup: 0.05 + R() * 0.3,
      cluster: Math.floor(R() * 3), // umbel, raceme, single
    }
    habit.divergence = [Math.PI, 2.39996, Math.PI / 2, (Math.PI * 2) / 3][habit.phyllo]

    const len = lerp(H.len[0], H.len[1], m) * (0.85 + R() * 0.3) * vigour
    const radius = lerp(H.radius[0], H.radius[1], m) * (1 + (1 - detail) * 1.1)
    const timeOf = (d: number, total: number) => (animate ? t0 + (d / Math.max(0.01, total)) * dur * 0.8 : LONG_AGO)

    const setback = e.kind === 'contribution_rejected' || e.kind === 'tests_failed'
    const witherAt = setback ? (animate ? t0 + dur + 1.2 : LONG_AGO) : NEVER

    // the main shoot
    const mainOpts: WalkOpts = {
      len,
      step: e.kind === 'contribution_merged' ? 0.14 : e.kind === 'breakthrough' ? 0.12 : 0.085,
      attract: e.kind === 'exhibit_merged' ? 0.35 : 0.1 + R() * 0.15,
      curl: habit.curl * (e.kind === 'contribution_merged' ? 0.4 : 1),
      wiggle: habit.wiggle,
      wfreq: habit.wfreq,
      noise: 0.06 + R() * 0.14,
      lift: 'hug',
      rise: 0,
      archFreq: 0.5 + R() * 1.5,
      sCap,
      coil: e.kind === 'exhibit_merged' ? 6 + R() * 6 : 0,
    }
    // epochs and setbacks are shoots off the surface; vines hug it with arches
    const onCeiling = sample(start.s).surf === CEIL || start.s > MARK.ceiling
    if (e.kind === 'epoch' || setback) {
      mainOpts.lift = onCeiling ? 'hang' : 'rise'
      mainOpts.rise = Math.min(0.5, len * (0.3 + R() * 0.35)) * (onCeiling ? 1.3 : 1)
      mainOpts.archFreq = 0.45 + R() * 0.5
    } else {
      mainOpts.rise = (e.kind === 'contribution_merged' ? 0.04 + R() * 0.16 : 0.02 + R() * 0.06) * (onCeiling ? 1.8 : 1)
    }
    const aimAt = { theta: thetaGuide + (R() - 0.5) * 0.4 / effR(sTarget), s: Math.min(sCap, sTarget + len * (0.3 + R() * 0.5)) }

    // a runner along the surface from the growth it starts on to where it is
    // heading, so the plant creeps out into open ground and every piece shows
    // where it landed
    const stems: Array<{ steps: Step[]; r0: number; r1: number; main: boolean; runner?: boolean }> = []
    let from: Step = start
    const sHead = Math.min(sGuide, sTarget)
    const gapTo = chartDist(start.theta, start.s, thetaGuide, sHead)
    if (gapTo > 0.25) {
      const runOpts: WalkOpts = { ...mainOpts, len: Math.min(leg ? 3 : 1.8, gapTo), step: 0.15, attract: leg ? 0.45 : 0.22, curl: habit.curl * 0.25, wiggle: habit.wiggle * 0.4, noise: 0.05, lift: 'hug', rise: 0.006, archFreq: 0.5, coil: 0 }
      const run = this.walk(R, start, { theta: thetaGuide, s: sHead }, runOpts, 0)
      stems.push({ steps: run, r0: radius * 0.95, r1: radius * 0.85, main: false, runner: true })
      from = run[run.length - 1]
    }
    const total = from.d + len * (1 + (H.branches[1] > 0 ? 0.4 : 0))
    const main = this.walk(R, from, aimAt, mainOpts, from.d)

    // the climb starts where the runner reached; too far off, it stays a shoot
    if (leg && Math.hypot(leg.x - chartPoint(from.theta, from.s, 0).x, leg.z - chartPoint(from.theta, from.s, 0).z) > 0.6) leg = null
    if (!leg) stems.push({ steps: main, r0: radius * (from === start ? 1 : 0.85), r1: radius * 0.3, main: true })

    // side branches (a breakthrough's all start from one point: the surge)
    const nb = leg ? 0 : Math.round(lerp(H.branches[0], H.branches[1], e.kind === 'breakthrough' ? m : R() * (0.4 + m)))
    for (let b = 0; b < nb; b++) {
      let from: Step
      let heading: number
      if (e.kind === 'breakthrough') {
        from = main[Math.min(main.length - 1, 1 + Math.floor(R() * 2))]
        heading = (b / nb) * Math.PI * 2 + R() * 0.5
      } else {
        const k = Math.max(1, Math.min(main.length - 2, Math.floor(main.length * (0.2 + R() * 0.6))))
        from = main[k]
        const fwd = Math.atan2(wrap(main[k + 1].theta - main[k - 1].theta) * effR(main[k].s), main[k + 1].s - main[k - 1].s)
        heading = fwd + (R() < 0.5 ? -1 : 1) * habit.branchAngle * (0.8 + R() * 0.4)
      }
      const bl = (e.kind === 'breakthrough' ? lerp(0.4, 1.0, R()) * len : len * (0.25 + R() * 0.3)) * (0.8 + m * 0.4)
      const aim = { theta: from.theta + (Math.sin(heading) * bl * 1.4) / effR(from.s), s: Math.min(sCap, from.s + Math.cos(heading) * bl * 1.4) }
      const opts: WalkOpts = { ...mainOpts, len: bl, attract: 0.12 + R() * 0.12, curl: -habit.curl * (0.5 + R()), rise: mainOpts.lift === 'hug' ? mainOpts.rise * 0.6 : mainOpts.rise * 0.8, coil: 0 }
      const steps = this.walk(R, from, aim, opts, from.d, heading)
      stems.push({ steps, r0: radius * (e.kind === 'breakthrough' ? 0.8 : 0.65), r1: radius * 0.25, main: false })
    }

    // draw the stems and set their leaves. Rings are set every `stride`
    // steps of the walk: about this far apart, wider on old growth
    const segLen = e.kind === 'epoch' || setback ? len / (detail >= 1 ? 3 : 2) : (e.kind === 'exhibit_merged' ? 0.16 : 0.5) / Math.max(0.5, detail)
    const stride = Math.max(1, Math.round(segLen / mainOpts.step))
    const tmp = new THREE.Vector3()
    for (const st of stems) {
      const S = st.steps
      if (S.length < 2) continue
      const rings: Ring[] = []
      const pts: THREE.Vector3[] = []
      const ns: THREE.Vector3[] = []
      for (let i = 0; i < S.length; i++) {
        const t = i / (S.length - 1)
        const p = chartPoint(S[i].theta, S[i].s, S[i].lift)
        const n = chartNormal(S[i].theta, S[i].s)
        pts.push(p)
        ns.push(n)
        const c = stemC.clone().lerp(STEM_YOUNG, t * 0.6)
        if (setback) c.lerp(SETBACK_STEM, 0.4)
        rings.push({ p, n, r: lerp(st.r0, st.r1, Math.pow(t, 0.8)), g, surf: sample(S[i].s).surf, c, appear: timeOf(S[i].d, total), wither: witherAt })
      }
      // rings evenly spaced along the walk, `every` steps apart or a little
      // more. Stems that creep along a surface are flat strips (cheap, so
      // they get more of them and curve smoothly); shoots are round.
      const creeping = st.runner || mainOpts.lift === 'hug'
      const every = creeping ? Math.max(1, Math.round(Math.min(0.42, 0.3 / Math.max(0.5, detail)) / (st.runner ? 0.15 : mainOpts.step))) : stride
      const segs = Math.max(1, Math.floor((rings.length - 1) / every))
      const drawn = Array.from({ length: segs + 1 }, (_, j) => rings[Math.round((j * (rings.length - 1)) / segs)])
      // the oldest shoots are flat too: woody, leafless and far from the eye
      if (creeping || detail < 0.4) ribbon(this.sink, drawn)
      else tube(this.sink, drawn, 3)
      this.stats.rings += drawn.length

      // leaves by this event's phyllotaxis
      let psi = R() * Math.PI * 2
      let nextLeaf = habit.spacing * (0.3 + R() * 0.7)
      let travelled = 0
      for (let i = 1; i < S.length; i++) {
        travelled += pts[i].distanceTo(pts[i - 1])
        if (travelled < nextLeaf || i === S.length - 1) continue
        nextLeaf = travelled + habit.spacing * (0.7 + R() * 0.6)
        const T = tmp.subVectors(pts[Math.min(pts.length - 1, i + 1)], pts[i - 1]).normalize().clone()
        const N = ns[i].clone().addScaledVector(T, -ns[i].dot(T)).normalize()
        const B = new THREE.Vector3().crossVectors(T, N)
        const per = habit.phyllo === 2 ? 2 : habit.phyllo === 3 ? 3 : 1
        const along = i / (S.length - 1)
        for (let q = 0; q < per; q++) {
          const a = psi + (q * Math.PI * 2) / per
          const lean = habit.leafLean * (0.8 + R() * 0.4)
          // old growth has dropped most of its leaves (drawn from the stream
          // either way, so the shape never changes with age)
          const kept = R() < (0.1 + detail * 0.9) * (st.runner ? 0.35 : 1)
          const dir = T.clone().multiplyScalar(Math.cos(lean)).addScaledVector(N.clone().multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a)), Math.sin(lean))
          // keep blades out of the surface they grow on
          const into = dir.dot(ns[i])
          if (into < 0.05 && S[i].lift < 0.08) dir.addScaledVector(ns[i], 0.1 - into * 1.6)
          dir.normalize()
          const face = ns[i].clone().addScaledVector(dir, -ns[i].dot(dir))
          if (face.lengthSq() < 1e-4) face.copy(B)
          const size = habit.leafSize * (0.6 + R() * 0.5) * (st.main ? 1 : 0.85) * (0.55 + 0.45 * Math.min(1, along * 2.5 + 0.2))
          const pos = pts[i].clone().addScaledVector(dir, st.r0 * 0.5)
          const color = tones[q % 2].clone().multiplyScalar(0.88 + R() * 0.24)
          const phase = R() * Math.PI * 2
          const sway = (mainOpts.lift === 'hug' ? 0.08 : 0.2) * (0.6 + R() * 0.8)
          if (!kept) continue
          this.sink.leaves.push({
            m: leafMatrix(pos, dir, face, size, habit.leafWidth),
            thr: g + 0.03,
            phase,
            surf: rings[i].surf,
            sway,
            color,
            appear: animate ? rings[i].appear + 0.35 : LONG_AGO,
            wither: witherAt,
          })
          this.stats.leaves++
        }
        psi += habit.divergence
      }

      // keep the stem as somewhere later growth can start from
      if (!setback) {
        for (let i = 1; i < S.length; i += 2) this.nodes.push({ theta: S[i].theta, s: S[i].s, lift: S[i].lift, model: e.model, event: index, level })
      }
    }

    if (leg) {
      const accentC = accent !== null ? new THREE.Color(accent).lerp(CREAM, 0.14) : CREAM.clone()
      this.climbDesk(R, from, leg, {
        radius: radius * 0.8,
        color: stemC,
        tones,
        leafSize: habit.leafSize,
        g,
        appear: (d: number) => timeOf(d, Math.max(total, from.d + 1.4)),
        animate,
        flowers: e.kind === 'contribution_merged' ? 2 + Math.floor(m * 4) : 0,
        petal: accentC,
        petals: habit.petals,
        notch: habit.notch,
        cup: habit.cup,
      })
      this.stats.events++
      this.stats.desks++
      return
    }

    // flowers, buds and blooms
    const tipOf = (steps: Step[]) => {
      const i = steps.length - 1
      const p = chartPoint(steps[i].theta, steps[i].s, steps[i].lift)
      const q = chartPoint(steps[Math.max(0, i - 1)].theta, steps[Math.max(0, i - 1)].s, steps[Math.max(0, i - 1)].lift)
      const n = chartNormal(steps[i].theta, steps[i].s)
      return { p, dir: p.clone().sub(q).normalize(), n, surf: sample(steps[i].s).surf, appear: timeOf(steps[i].d, total) }
    }
    const petal = (accent !== null ? new THREE.Color(accent) : CREAM.clone()).lerp(CREAM, accent !== null ? 0.14 : 0)

    if (setback) {
      const tip = tipOf(main)
      const c = (e.kind === 'tests_failed' ? BUD_FAILED : BUD_REJECTED).clone()
      bud(this.sink, tip.p, tip.dir.clone().addScaledVector(tip.n, 0.4), 0.05 + R() * 0.025, c, g, tip.surf, animate ? tip.appear + 0.3 : LONG_AGO, witherAt)
      this.stats.buds++
    } else if (e.kind === 'contribution_merged') {
      // clusters at the main tip and some branch tips, by this event's habit
      const tips = stems.filter((_, i) => i === 0 || R() < 0.3 + m * 0.3).map(s => s.steps)
      for (const steps of tips) {
        const tip = tipOf(steps)
        const count = habit.cluster === 2 ? 1 : 2 + Math.floor(R() * (1 + m * 3))
        for (let f = 0; f < count; f++) {
          let at = tip.p.clone()
          let facing = tip.n.clone().addScaledVector(tip.dir, 0.5)
          if (habit.cluster === 0) {
            // umbel: florets fanned on short stalks round the tip
            const a = (f / count) * Math.PI * 2 + R()
            const side = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).addScaledVector(tip.n, -0.0).normalize()
            at = tip.p.clone().addScaledVector(side, 0.05 + R() * 0.04).addScaledVector(tip.n, 0.04 + R() * 0.03)
            facing = tip.n.clone().addScaledVector(side, 0.6)
          } else if (habit.cluster === 1) {
            // raceme: florets along the last stretch of the stem
            const k = Math.max(0, steps.length - 1 - f)
            at = chartPoint(steps[k].theta, steps[k].s, steps[k].lift + 0.03)
            facing = chartNormal(steps[k].theta, steps[k].s).addScaledVector(tip.dir, 0.3 * (f % 2 ? 1 : -1))
          }
          const size = (habit.cluster === 2 ? 0.07 + m * 0.05 : 0.035 + R() * 0.02) * (0.9 + m * 0.3)
          const tint = petal.clone().multiplyScalar(0.92 + R() * 0.16)
          flower(this.sink, at, facing, tip.dir, size, { petals: habit.petals, notch: habit.notch, cup: habit.cup, color: tint, heart: HEART, g, surf: tip.surf, appear: animate ? tip.appear + 0.5 + f * 0.15 : LONG_AGO, wither: NEVER, twist: R() * 3 })
          this.stats.flowers++
        }
      }
    } else if (e.kind === 'breakthrough') {
      // the bloom, raised on the surge, and a flower on every branch tip
      const base = main[Math.min(main.length - 1, 2)]
      const n = chartNormal(base.theta, base.s)
      const centre = chartPoint(base.theta, base.s, base.lift + 0.22 + m * 0.12)
      const size = 0.08 + m * 0.06
      const col = accent !== null ? petal : GOLD.clone()
      const bloomAt = animate ? t0 + dur * 0.85 : LONG_AGO
      const ref = new THREE.Vector3(1, 0, 0)
      flower(this.sink, centre, n, ref, size, { petals: habit.petals + 3, notch: 0.45, cup: 0.45, color: col.clone().lerp(CREAM, 0.25), heart: HEART, g, surf: sample(base.s).surf, appear: bloomAt, wither: NEVER, twist: R() })
      flower(this.sink, centre.clone().addScaledVector(n, size * 0.15), n, ref, size * 0.62, { petals: habit.petals + 2, notch: 0.4, cup: 0.7, color: col, heart: HEART, g, surf: sample(base.s).surf, appear: bloomAt + 0.3, wither: NEVER, twist: R() + 0.4 })
      // its stalk
      const p0 = chartPoint(base.theta, base.s, base.lift)
      const stalk: Ring[] = [0, 0.5, 1].map(t => ({ p: p0.clone().lerp(centre, t), n: new THREE.Vector3(1, 0, 0), r: radius * (1 - t * 0.5), g, surf: sample(base.s).surf, c: stemC, appear: animate ? bloomAt - 0.6 + t * 0.5 : LONG_AGO, wither: NEVER }))
      tube(this.sink, stalk, 3)
      this.stats.flowers += 2
      for (const st of stems.slice(1)) {
        const tip = tipOf(st.steps)
        flower(this.sink, tip.p.clone().addScaledVector(tip.n, 0.02), tip.n.clone().addScaledVector(tip.dir, 0.4), tip.dir, 0.05 + R() * 0.03, { petals: habit.petals, notch: habit.notch, cup: habit.cup, color: col.clone().multiplyScalar(0.92 + R() * 0.16), heart: HEART, g, surf: tip.surf, appear: animate ? tip.appear + 0.4 : LONG_AGO, wither: NEVER, twist: R() * 3 })
        this.stats.flowers++
      }
    }
    this.stats.events++
  }

  // Up a desk leg in a loose spiral and out across the desk top: flat strips
  // lying on the brass and the wood, leaves along the way, and for a merged
  // contribution its flowers on the desk.
  private climbDesk(
    R: () => number,
    from: Step,
    leg: THREE.Vector3,
    o: { radius: number; color: THREE.Color; tones: THREE.Color[]; leafSize: number; g: number; appear: (d: number) => number; animate: boolean; flowers: number; petal: THREE.Color; petals: number; notch: number; cup: number }
  ): void {
    const fp = chartPoint(from.theta, from.s, 0.01)
    const centre = new THREE.Vector3(leg.x, 0, leg.z).sub(deskCentreOf(leg)).multiplyScalar(-1).normalize() // from the leg toward the desk's middle
    const rings: Ring[] = []
    let d = from.d
    let last = fp.clone()
    const push = (p: THREE.Vector3, n: THREE.Vector3, r: number) => {
      d += p.distanceTo(last)
      last = p.clone()
      rings.push({ p, n, r, g: o.g, surf: FREE, c: o.color.clone().lerp(STEM_YOUNG, Math.min(0.6, (d - from.d) * 0.4)), appear: o.appear(d), wither: NEVER })
    }
    const up = new THREE.Vector3(0, 1, 0)
    const toLeg = new THREE.Vector3(leg.x - fp.x, 0, leg.z - fp.z)
    const a0 = Math.atan2(-toLeg.z, -toLeg.x) // the side of the leg it arrives on
    push(fp.clone(), up, o.radius)
    push(new THREE.Vector3(leg.x + Math.cos(a0) * 0.12, 0.012, leg.z + Math.sin(a0) * 0.12), up, o.radius)
    const turns = (1.2 + R() * 1.6) * (R() < 0.5 ? 1 : -1)
    const height = 0.74
    const n = 14
    const leaves: Array<{ p: THREE.Vector3; out: THREE.Vector3; d: number }> = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const a = a0 + t * turns * Math.PI * 2
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
      const p = new THREE.Vector3(leg.x, 0.03 + t * height, leg.z).addScaledVector(out, 0.052)
      push(p, out, o.radius * (1 - t * 0.3))
      if (i % 3 === 2) leaves.push({ p, out, d })
    }
    // over the edge and across the top
    const top = new THREE.Vector3(leg.x, 0.845, leg.z)
    const reach = 0.25 + R() * 0.4
    const side = new THREE.Vector3(-centre.z, 0, centre.x).multiplyScalar((R() - 0.5) * 0.6)
    for (let i = 1; i <= 4; i++) {
      const t = i / 4
      const p = top.clone().addScaledVector(centre, 0.06 + t * reach).addScaledVector(side, t * t)
      push(p, up, o.radius * (0.7 - t * 0.35))
      if (i === 2 || i === 4) leaves.push({ p, out: centre.clone(), d })
    }
    ribbon(this.sink, rings)
    this.stats.rings += rings.length
    for (const l of leaves) {
      const dir = l.out.clone().multiplyScalar(0.8).addScaledVector(up, 0.5 + R() * 0.5).addScaledVector(new THREE.Vector3(-l.out.z, 0, l.out.x), (R() - 0.5) * 1.2).normalize()
      this.sink.leaves.push({
        m: leafMatrix(l.p.clone().addScaledVector(l.out, 0.01), dir, l.out, o.leafSize * (0.7 + R() * 0.5)),
        thr: o.g + 0.03,
        phase: R() * Math.PI * 2,
        surf: FREE,
        sway: 0.1,
        color: o.tones[Math.floor(R() * 2)].clone().multiplyScalar(0.9 + R() * 0.2),
        appear: o.animate ? o.appear(l.d) + 0.35 : LONG_AGO,
        wither: NEVER,
      })
      this.stats.leaves++
    }
    const end = rings[rings.length - 1]
    for (let f = 0; f < o.flowers; f++) {
      const a = (f / Math.max(1, o.flowers)) * Math.PI * 2 + R()
      const at = end.p.clone().add(new THREE.Vector3(Math.cos(a) * 0.05, 0.02 + R() * 0.03, Math.sin(a) * 0.05))
      flower(this.sink, at, up.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.5)), centre, 0.04 + R() * 0.02, { petals: o.petals, notch: o.notch, cup: o.cup, color: o.petal.clone().multiplyScalar(0.92 + R() * 0.16), heart: HEART, g: o.g, surf: FREE, appear: o.animate ? end.appear + 0.5 + f * 0.15 : LONG_AGO, wither: NEVER, twist: R() * 3 })
      this.stats.flowers++
    }
  }

  // The angle of a model's runner at this distance along the profile.
  private runnerAngle(family: number, s: number, level: number, R: () => number): number {
    const list = this.familyAnchors[family % 5].filter(a => a.g <= Math.max(1.05, level + 0.1))
    if (!list.length) return (family * 2 * Math.PI) / 5 - Math.PI / 2
    // several branches of a runner can be at about the same distance; the
    // event's own stream picks one of them
    const near = list.filter(a => Math.abs(a.s - s) < 0.5)
    if (near.length) return near[Math.floor(R() * near.length)].theta
    let best = list[0]
    for (const a of list) if (Math.abs(a.s - s) < Math.abs(best.s - s)) best = a
    return best.theta
  }

  private parentFor(model: string | null, index: number, theta: number, s: number, level: number): Step {
    let best: Node | null = null
    let score = Infinity
    for (const n of this.nodes) {
      if (n.level > level + 0.05 || n.s > s + 0.3) continue
      const d = chartDist(n.theta, n.s, theta, s)
      const w = n.event < 0 ? 1.7 : n.model === model ? 1 : 2.4
      const age = n.event < 0 ? 0 : (index - n.event) * 0.004
      const sc = d * w + age
      if (sc < score) {
        score = sc
        best = n
      }
    }
    if (!best) return { theta, s: Math.max(0.05, Math.min(s, 0.3)), lift: 0.01, d: 0 }
    return { theta: best.theta, s: best.s, lift: best.lift, d: 0 }
  }

  private bayFor(e: GrowthEvent): number | null {
    if (!this.bays.length) return null
    const at = Date.parse(e.at)
    let best: ExhibitBayRef | null = null
    let bd = Infinity
    for (const b of this.bays) {
      const d = Math.abs(b.mergedAt - at) / 86400000 + (b.model && e.model && b.model === e.model ? 0 : 3)
      if (d < bd) {
        bd = d
        best = b
      }
    }
    return best ? best.angle : null
  }

  // The turtle: steps through the chart, turning toward its aim, curling,
  // wiggling and drifting, sliding along the frontier when it reaches it.
  private walk(R: () => number, start: Step, aim: { theta: number; s: number }, o: WalkOpts, d0: number, heading?: number): Step[] {
    const n = Math.max(2, Math.ceil(o.len / o.step))
    const step = o.len / n
    let th = start.theta
    let s = start.s
    let lift = start.lift
    const towards = () => Math.atan2(wrap(aim.theta - th) * effR(s), aim.s - s)
    let phi = heading ?? towards() + (R() - 0.5) * 0.6
    const ph = R() * 6.28
    const out: Step[] = [{ theta: th, s, lift, d: d0 }]
    let d = d0
    const baseLift = 0.012
    for (let i = 1; i <= n; i++) {
      const t = i / n
      let turn = wrap(towards() - phi) * o.attract
      turn += o.curl * step + Math.sin(t * o.wfreq + ph) * o.wiggle * step * 4 + (R() - 0.5) * o.noise
      if (o.coil) turn += o.coil * step * Math.pow(t, 3)
      phi = wrap(phi + turn)
      let dt = Math.sin(phi) * step
      let ds = Math.cos(phi) * step
      if (o.lift === 'rise' || o.lift === 'hang') {
        // a shoot: rises off the surface (or hangs from the ceiling) and bends
        // back over under its own weight
        const next = start.lift + o.rise * Math.sin(Math.PI * t * o.archFreq)
        const slope = (next - lift) / step
        lift = next
        const k = 1 / Math.sqrt(1 + slope * slope)
        dt *= k
        ds *= k
      } else {
        const target = baseLift + o.rise * Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * o.archFreq + ph)), 1.5)
        lift = lerp(lift, target, Math.min(1, 0.35 + t))
      }
      // at the frontier, slide along it instead of passing it
      if (s + ds > o.sCap) {
        ds = Math.min(0, o.sCap - s)
        phi = (Math.sin(phi) >= 0 ? 1 : -1) * (Math.PI / 2 + 0.15)
        dt = Math.sin(phi) * step
      }
      th = wrap(th + dt / effR(s))
      s = Math.max(0.04, s + ds)
      d += step
      out.push({ theta: th, s, lift, d })
    }
    return out
  }
}
