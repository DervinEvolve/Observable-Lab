// The practice bench (src/entities/PracticeBench.ts) is drawn from the stored
// record of the newest Tinker RL run, which comes on GET /api/experiment as
// `rl_practice` (api/_lib/tinker-rl-public.ts). Everything here is pure: it
// reads that record strictly and says what the bench shows. Nothing is
// invented. A bench with no run is dark, a finished run is shown at rest, and
// only a run the lab has heard from recently is shown moving.
//
// The reward numbers are what the runner reported while it trained (the
// reward on the training tasks). The two held-out scores are measured by the
// lab, with the rubric, on tasks the model never chose and never trained on.

export type BenchMode = 'dark' | 'ready' | 'sampling' | 'scored' | 'done' | 'failed' | 'resting'

export interface PracticeSample { prompt: string; completion: string; reward: number }

export interface PracticeProgress {
  phase: 'starting' | 'baseline' | 'sampling' | 'scored' | 'measuring' | 'saving' | 'done'
  step: number
  stepsPlanned: number
  groupSize: number
  tasksPerStep: number
  maxReward: number
  means: number[]
  fracMax: number[]
  attempts: number[]
  samples: PracticeSample[]
  scoreBefore: number | null
  scoreAfter: number | null
  /** Steps in which some group had answers that scored differently, so training really ran. Null when the runner did not say. */
  stepsTrained: number | null
  /** For each finished step, how many sampled answers used the whole token limit without finishing. Null when the runner did not say. */
  capped: number[] | null
  /** For each finished step, the mean number of tokens an answer used. Null when the runner did not say. */
  meanTokens: number[] | null
}

/** One held-out scoring: how many answers were graded and how many of them reached the token limit without finishing. */
export interface PracticeCutOff { graded: number; capped: number }

export interface PracticeRun {
  slug: string
  adapter: string
  authorName: string
  epoch: number
  baseModel: string
  taskSet: string | null
  purpose: string | null
  name: string | null
  status: string
  live: boolean
  tasks: { total: number; heldOut: number | null; training: number | null }
  rubric: string[]
  maxReward: number
  settings: { steps: number; groupSize: number; tasksPerStep: number; maxCompletionTokens: number; loss: string; learningRate: number; rank: number } | null
  progress: PracticeProgress | null
  heldOut: { before: number | null; after: number | null; tasks: number | null } | null
  hacking: { flag: boolean; reasons: string[] }
  /** Held-out answers the token limit cut off, and the lab's flag for them. The counts are null when the record holds none. */
  cutOff: { flag: boolean; reasons: string[]; before: PracticeCutOff | null; after: PracticeCutOff | null }
  cost: { estimatedUsd: number | null; maxUsd: number | null; basis: string }
  origin: string
  /** The lab id to talk to; there only while the adapter is alive and the visitor chat is on. */
  talk: string | null
  createdAt: string
  finishedAt: string | null
  reason: string | null
}

export interface Practice {
  enabled: boolean
  offReason: string | null
  run: PracticeRun | null
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g

/** Short plain text: control characters become spaces, the length is cut. The panel escapes it again when it writes it. */
export function plain(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const unit = (v: unknown): number | null => { const n = finite(v); return n !== null && n >= 0 && n <= 1 ? n : null }
const whole = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null)
const SLUG = /^e[0-9]{1,6}-[0-9a-f]{8}$/
const PHASES = ['starting', 'baseline', 'sampling', 'scored', 'measuring', 'saving', 'done'] as const

function unitList(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: number[] = []
  for (const x of v) {
    const n = unit(x)
    if (n === null) return null
    out.push(n)
  }
  return out
}

/** A list with one number for each finished step, each passing `one`; null when it is absent or is anything else. */
function stepList(v: unknown, steps: number, one: (x: unknown) => number | null): number[] | null {
  if (!Array.isArray(v) || v.length !== steps) return null
  const out: number[] = []
  for (const x of v) {
    const n = one(x)
    if (n === null) return null
    out.push(n)
  }
  return out
}

/** The counts of one held-out scoring; null when they are absent or do not fit together. */
function readCutOff(raw: unknown): PracticeCutOff | null {
  if (!isObject(raw)) return null
  const graded = whole(raw.graded, 1, 120)
  const capped = graded === null ? null : whole(raw.capped, 0, graded)
  return graded === null || capped === null ? null : { graded, capped }
}

function readProgress(raw: unknown): PracticeProgress | null {
  if (!isObject(raw)) return null
  const phase = PHASES.find(p => p === raw.phase)
  const step = whole(raw.step, 0, 30)
  const planned = whole(raw.steps_planned, 1, 30)
  const group = whole(raw.group_size, 2, 16)
  const perStep = whole(raw.tasks_per_step, 1, 16)
  const maxReward = unit(raw.max_reward)
  const means = unitList(raw.means, 30)
  const fracMax = unitList(raw.frac_max, 30)
  const attempts = unitList(raw.attempts, 16)
  if (!phase || step === null || planned === null || group === null || perStep === null || maxReward === null || maxReward <= 0 || !means || !fracMax || !attempts) return null
  if (step > planned || means.length > planned) return null
  const samples: PracticeSample[] = []
  if (Array.isArray(raw.samples)) {
    for (const s of raw.samples.slice(0, 3)) {
      if (!isObject(s)) continue
      const reward = unit(s.reward)
      if (reward === null) continue
      samples.push({ prompt: plain(s.prompt, 100) ?? '', completion: plain(s.completion, 160) ?? '', reward })
    }
  }
  const before = raw.score_before == null ? null : unit(raw.score_before)
  const after = raw.score_after == null ? null : unit(raw.score_after)
  // New with the counting: a record without them (an older lab server or runner), or with anything else in their place, has none.
  const capped = stepList(raw.capped, means.length, x => whole(x, 0, group * perStep))
  const meanTokens = stepList(raw.mean_tokens, means.length, x => { const n = finite(x); return n !== null && n >= 0 && n <= 4096 ? n : null })
  return { phase, step, stepsPlanned: planned, groupSize: group, tasksPerStep: perStep, maxReward, means, fracMax, attempts, samples, scoreBefore: before, scoreAfter: after, stepsTrained: raw.steps_trained == null ? null : whole(raw.steps_trained, 0, 30), capped, meanTokens }
}

function readRun(raw: unknown): PracticeRun | null {
  if (!isObject(raw)) return null
  if (typeof raw.slug !== 'string' || !SLUG.test(raw.slug)) return null
  const status = plain(raw.status, 20)
  const epoch = whole(raw.epoch, 0, 1_000_000)
  const base = plain(raw.base_model, 80)
  if (!status || epoch === null || !base) return null
  const tasks = isObject(raw.tasks) ? raw.tasks : {}
  const s = isObject(raw.settings) ? raw.settings : null
  const steps = s ? whole(s.steps, 1, 30) : null
  const group = s ? whole(s.group_size, 2, 16) : null
  const perStep = s ? whole(s.tasks_per_step, 1, 16) : null
  const tokens = s ? whole(s.max_completion_tokens, 1, 4096) : null
  const rank = s ? whole(s.rank, 1, 256) : null
  const lr = s ? finite(s.learning_rate) : null
  const loss = s ? plain(s.loss, 40) : null
  const settings = s && steps !== null && group !== null && perStep !== null && tokens !== null && rank !== null && lr !== null && loss
    ? { steps, groupSize: group, tasksPerStep: perStep, maxCompletionTokens: tokens, loss, learningRate: lr, rank }
    : null
  const held = isObject(raw.held_out) ? raw.held_out : null
  const hack = isObject(raw.hacking) ? raw.hacking : {}
  const cut = isObject(raw.cut_off) ? raw.cut_off : {}
  const cost = isObject(raw.cost) ? raw.cost : {}
  const max = unit(raw.max_reward)
  return {
    slug: raw.slug,
    adapter: `lab/${raw.slug}`,
    authorName: plain(raw.author_name, 60) ?? 'a lab model',
    epoch,
    baseModel: base,
    taskSet: plain(raw.task_set, 48),
    purpose: plain(raw.purpose, 200),
    name: plain(raw.name, 40),
    status,
    live: raw.live === true,
    tasks: { total: whole(tasks.total, 0, 1000) ?? 0, heldOut: whole(tasks.held_out, 0, 1000), training: whole(tasks.training, 0, 1000) },
    rubric: Array.isArray(raw.rubric) ? raw.rubric.slice(0, 8).map(l => plain(l, 200)).filter((l): l is string => l !== null) : [],
    maxReward: max !== null && max > 0 ? max : 1,
    settings,
    progress: readProgress(raw.progress),
    heldOut: held ? { before: unit(held.before), after: unit(held.after), tasks: whole(held.tasks, 0, 1000) } : null,
    hacking: {
      flag: hack.flag === true,
      reasons: Array.isArray(hack.reasons) ? hack.reasons.slice(0, 4).map(r => plain(r, 200)).filter((r): r is string => r !== null) : [],
    },
    cutOff: {
      flag: cut.flag === true,
      reasons: Array.isArray(cut.reasons) ? cut.reasons.slice(0, 2).map(r => plain(r, 300)).filter((r): r is string => r !== null) : [],
      before: readCutOff(cut.before),
      after: readCutOff(cut.after),
    },
    cost: { estimatedUsd: finite(cost.estimated_usd), maxUsd: finite(cost.max_usd), basis: plain(cost.basis, 200) ?? 'an estimate, not a billed amount' },
    origin: plain(raw.origin, 40) ?? 'written by the models',
    talk: typeof raw.talk === 'string' && raw.talk === `lab/${raw.slug}` ? raw.talk : null,
    createdAt: plain(raw.created_at, 40) ?? '',
    finishedAt: plain(raw.finished_at, 40),
    reason: plain(raw.reason, 300),
  }
}

/** The `rl_practice` part of the state, strictly read. Anything that is not well formed leaves the bench dark. */
export function parsePractice(raw: unknown): Practice | null {
  if (!isObject(raw)) return null
  return { enabled: raw.enabled === true, offReason: plain(raw.off_reason, 300), run: readRun(raw.run) }
}

// ---------------------------------------------------------------------------
// What the bench shows
// ---------------------------------------------------------------------------

export type JarFill = 'empty' | 'amber' | 'scored'
export interface JarView { fill: JarFill; /** 0 to 1: the reward as a share of the best the rubric allows. Only for 'scored'. */ share: number }

export interface BenchView {
  mode: BenchMode
  /** True only while the lab has heard from the runner recently. Nothing moves otherwise. */
  animated: boolean
  jars: JarView[]
  step: number
  steps: number
  /** The mean reward of each finished step as a share of the best score (0 to 1), oldest first. */
  curve: number[]
  /** Where the curve is planned to end, in steps. */
  curveSteps: number
  before: number | null
  after: number | null
  hacking: boolean
  plate: { title: string; author: string | null }
}

export const NOTHING_PRACTISED = 'Nothing has been practised yet'
export const NO_EXPERIMENT = 'No experiment is connected'
export const MAX_JARS = 16

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** A reward as a share of the best score the rubric allows; 0 when the best is not a positive number. */
export function rewardShare(reward: number, maxReward: number): number {
  return maxReward > 0 ? clamp01(reward / maxReward) : 0
}

const RED = [0xe5, 0x73, 0x73]
const AMBER = [0xff, 0xb7, 0x4d]
const GREEN = [0x7c, 0xb3, 0x42]

/** Red for 0, the lab's working amber at the middle, green for the best score; a gradient between. */
export function rewardColor(share: number): number {
  const s = clamp01(Number.isFinite(share) ? share : 0)
  const [from, to, k] = s < 0.5 ? [RED, AMBER, s / 0.5] : [AMBER, GREEN, (s - 0.5) / 0.5]
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * k))
  return (c[0] << 16) | (c[1] << 8) | c[2]
}

const emptyJars = (n: number): JarView[] => Array.from({ length: n }, () => ({ fill: 'empty' as const, share: 0 }))

function plateFor(run: PracticeRun): { title: string; author: string | null } {
  const title = run.taskSet ?? run.name ?? (run.purpose ? run.purpose.slice(0, 48) : `Epoch ${run.epoch} practice`)
  return { title, author: run.authorName }
}

/**
 * The bench's state from the record. `simulation` is true while no experiment
 * is connected: the bench stays dark then, whatever else is on the page.
 */
export function benchView(practice: Practice | null, simulation: boolean): BenchView {
  const dark: BenchView = {
    mode: 'dark', animated: false, jars: [], step: 0, steps: 0, curve: [], curveSteps: 0,
    before: null, after: null, hacking: false, plate: { title: NOTHING_PRACTISED, author: null },
  }
  if (simulation || !practice || !practice.run) return dark
  const run = practice.run
  const p = run.progress
  const groupSize = Math.min(MAX_JARS, Math.max(2, p?.groupSize ?? run.settings?.groupSize ?? 8))
  const steps = p?.stepsPlanned ?? run.settings?.steps ?? 0
  const step = p?.step ?? 0
  const max = p?.maxReward ?? run.maxReward
  const curve = (p?.means ?? []).map(m => rewardShare(m, max))
  const before = run.heldOut?.before ?? p?.scoreBefore ?? null
  const after = run.heldOut?.after ?? p?.scoreAfter ?? null
  const scored = (): JarView[] => {
    const a = p?.attempts ?? []
    return a.length
      ? Array.from({ length: groupSize }, (_, i) => (i < a.length ? { fill: 'scored' as const, share: rewardShare(a[i], max) } : { fill: 'empty' as const, share: 0 }))
      : emptyJars(groupSize)
  }
  const base = { step, steps, curve, curveSteps: steps, before, after, hacking: run.hacking.flag, plate: plateFor(run) }
  const live = run.live && (run.status === 'running' || run.status === 'reserved')
  if (live && p) {
    if (p.phase === 'baseline' || p.phase === 'sampling' || p.phase === 'measuring') {
      return { ...base, mode: 'sampling', animated: true, jars: Array.from({ length: groupSize }, () => ({ fill: 'amber' as const, share: 0 })) }
    }
    if (p.phase === 'scored' || p.phase === 'saving') return { ...base, mode: 'scored', animated: true, jars: scored() }
    return { ...base, mode: 'ready', animated: true, jars: emptyJars(groupSize) }
  }
  if (live) return { ...base, mode: 'ready', animated: true, jars: emptyJars(groupSize) }
  if (run.status === 'ok') return { ...base, mode: 'done', animated: false, jars: scored() }
  if (run.status === 'running' || run.status === 'reserved') return { ...base, mode: 'resting', animated: false, jars: scored() }
  return { ...base, mode: 'failed', animated: false, jars: scored() }
}

/** Where the pen is on the paper: x and y from 0 to 1 (y up), or null when there is nothing drawn yet. */
export function penPoint(view: Pick<BenchView, 'curve' | 'curveSteps'>): { x: number; y: number } | null {
  const n = view.curve.length
  if (!n) return null
  const span = Math.max(1, view.curveSteps - 1, n - 1)
  return { x: clamp01(((n - 1) + 0.5) / (span + 1)), y: view.curve[n - 1] }
}

/** The points of the reward curve on the paper: x and y from 0 to 1, one per finished step. */
export function curvePoints(view: Pick<BenchView, 'curve' | 'curveSteps'>): Array<{ x: number; y: number }> {
  const span = Math.max(1, view.curveSteps - 1, view.curve.length - 1)
  return view.curve.map((y, i) => ({ x: clamp01((i + 0.5) / (span + 1)), y }))
}

/** A gauge needle's angle for a score, from the left end of the arc (0) to the right (1), in radians from 0 to pi. */
export function needleAngle(score: number | null): number {
  return score === null ? 0 : clamp01(score) * Math.PI
}

/** The words for the step dial. */
export function stepLabel(step: number, steps: number): string {
  return steps > 0 ? `step ${step} of ${steps}` : 'no run'
}

/** A score for the page, as a share of the best score: "0.42", or "not measured" when there is none. */
export function scoreText(score: number | null): string {
  return score === null ? 'not measured' : score.toFixed(2)
}

export interface PracticeRow { label: string; value: string }

/**
 * The rows the panel adds to "Steps" about answers that reached the token
 * limit, from the stored counts only. A row is there only where there is
 * something to say: steps with no cut off answer are not listed, and a
 * record with no counts adds nothing. The value is bounded: the first and
 * the last step that had any, and how many other steps did, so a run of
 * thirty steps does not fill the panel with a list (the record holds every
 * step's count).
 */
export function stepCutOffRows(run: Pick<PracticeRun, 'progress'>): PracticeRow[] {
  const p = run.progress
  if (!p) return []
  const rows: PracticeRow[] = []
  const answers = p.groupSize * p.tasksPerStep
  const cut = (p.capped ?? []).map((n, i) => ({ n, step: i + 1 })).filter(c => c.n > 0)
  if (cut.length) {
    const one = (c: { n: number; step: number }): string => `${c.n} of ${answers} in step ${c.step}`
    const others = cut.length - 2
    rows.push({
      label: 'Answers Cut Off By The Token Limit',
      value: cut.length === 1 ? one(cut[0]) : `${one(cut[0])}, ${one(cut[cut.length - 1])}${others > 0 ? `, and in ${others} other step${others === 1 ? '' : 's'}` : ''}`,
    })
  }
  const used = p.meanTokens ?? []
  if (used.length && used.some(t => t > 0)) {
    const last = used.length
    rows.push({
      label: 'Mean Tokens An Answer Used',
      value: last === 1 ? `${used[0].toFixed(1)} in step 1` : `${used[0].toFixed(1)} in step 1, ${used[last - 1].toFixed(1)} in step ${last}`,
    })
  }
  return rows
}

/** The rows the panel adds to the held-out scores: how many graded answers the token limit cut off, shown when any was. */
export function heldOutCutOffRows(run: Pick<PracticeRun, 'cutOff'>): PracticeRow[] {
  const { before, after } = run.cutOff
  if (!((before?.capped ?? 0) > 0 || (after?.capped ?? 0) > 0)) return []
  const words = (c: PracticeCutOff | null): string => (c ? `${c.capped} of ${c.graded} answers` : 'not counted')
  return [
    { label: 'Cut Off Before Training', value: words(before) },
    { label: 'Cut Off After Training', value: words(after) },
  ]
}

export const CUT_OFF_FLAG_LABEL = 'Cut Off Flag.'

/** A reason as a sentence: a capital letter first and a full stop last. */
export function sentence(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const up = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(up) ? up : `${up}.`
}

/** What the panel says under the cut off flag, or null when the flag is not set. The reasons are the lab's own, as stored. */
export function cutOffFlagText(run: Pick<PracticeRun, 'cutOff'>): string | null {
  if (!run.cutOff.flag) return null
  const reasons = run.cutOff.reasons.map(sentence).filter(Boolean).join(' ')
  return `An answer that reaches the token limit is graded as the text it has, which may be nothing. ${reasons ? `${reasons} ` : ''}It blocks nothing; it is recorded here.`
}

/** The state of the lamp: 'off', 'on' (steady, for reduced motion) or 'blink'. */
export function lampState(view: Pick<BenchView, 'hacking'>, reducedMotion: boolean): 'off' | 'on' | 'blink' {
  if (!view.hacking) return 'off'
  return reducedMotion ? 'on' : 'blink'
}

// ---------------------------------------------------------------------------
// Where the camera goes to look at the bench
// ---------------------------------------------------------------------------

export interface BenchCameraView { position: [number, number, number]; target: [number, number, number] }

/**
 * The bench stands against the wall at the edge of the default view, with its
 * front to the middle of the room, so a visitor who has not orbited cannot read
 * it. This is a view of it from inside the room, about 6.4 m from its
 * instruments, a little to one side so the plant is not in the way and raised
 * so the Executor's desk in front of it does not hide it. It stays inside the
 * orbit limits (6 to 15 m from the target, polar angle 30 to 82 degrees), so
 * the controls do not push the camera back on the next frame.
 */
export function benchCameraView(angleDeg: number, radius: number, sideDeg = -30): BenchCameraView {
  const a = (angleDeg * Math.PI) / 180
  const bx = Math.cos(a) * radius
  const bz = Math.sin(a) * radius
  const toCentre = Math.atan2(-bz, -bx) + (sideDeg * Math.PI) / 180
  const distance = 5.7
  return {
    position: [bx + Math.cos(toCentre) * distance, 4, bz + Math.sin(toCentre) * distance],
    target: [bx, 1, bz],
  }
}
