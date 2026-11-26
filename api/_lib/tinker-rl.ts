/**
 * Tinker RL (docs/TOOLS.md, "Tinker RL").
 *
 * With LAB_ENABLE_TINKER_RL on (it is on unless the value is false, 0, off or
 * no), the Executor may ask for one reinforcement-learning run of a small
 * open-weight model on Tinker. The model writes a set of tasks and a rubric as
 * data. The Reviewer rules on it like a training run. The run itself is the
 * lab's own code on Modal (modal/tinker_jobs.py): it holds out about 15% of
 * the tasks, scores the base model on them with the rubric, trains with
 * rewards from the rubric, scores the held-out tasks again on the saved
 * adapter, and writes its progress as it goes.
 *
 * This file is the part with no database and no network in it: the switch and
 * its settings, the strict reading of what a model wrote, the cost estimate,
 * the reading of what the runner sends back and of its progress, the flag for
 * rewards that look gamed, the public record, and the text the models are told.
 *
 * About money, as in tinker.ts: every dollar figure is an ESTIMATE, token
 * counts times the prices Tinker published on the date in tinker.ts. Before a
 * run the lab sets aside the most it could cost; after it that is replaced by
 * the tokens the runner counted.
 *
 * About scores. The reward of an attempt is the rubric's, computed by the
 * lab's own engine (rubric.ts here, the same rules in the runner). The
 * held-out scores are measured by the lab on tasks the model could not
 * choose. The scores of the training steps are the rewards the run trained on:
 * they are not a measurement of what the model learned.
 */
import { createHash } from 'node:crypto'
import {
  RUBRIC_MAX_RULES, describeRubric, normalizeRubric, normalizeTask, rubricFitsTasks, rubricMax,
  type Rubric, type RubricTask,
} from './rubric.js'
import {
  TINKER_ESTIMATE_MARGIN, TINKER_PRICES, TINKER_PRICE_TABLE_DATE, TINKER_RANKS, TINKER_TOKENS_PER_EXAMPLE, TINKER_TOKENS_PER_MESSAGE,
  isExternalPath, isSamplerPath, tinkerBaseModels, tinkerCostUsd, tinkerDailyUsd, tinkerJobsConfigured, tinkerNamesFlag, tinkerRunUsd, tinkerTtlDays,
  usdText, type TinkerStatus, type TinkerTokens,
} from './tinker.js'
import { ADAPTER_NAME_MAX, ADAPTER_NAME_MIN, readAdapterName } from './tinker-names.js'

export const TINKER_RL_TOOL = 'tinker_rl'

// ---------------------------------------------------------------------------
// Limits (the runner in modal/tinker_jobs.py has the same numbers; a test compares them)
// ---------------------------------------------------------------------------

export const RL_MIN_TASKS = 8
export const RL_MAX_TASKS = 400
export const RL_MAX_TASK_BYTES = 120_000
export const RL_GROUP_SIZE = { min: 2, max: 16, fallback: 8 } as const
export const RL_STEPS = { min: 1, max: 30, fallback: 10 } as const
export const RL_TASKS_PER_STEP = { min: 1, max: 16, fallback: 4 } as const
export const RL_COMPLETION_TOKENS = { min: 16, max: 512, fallback: 256 } as const
export const RL_LEARNING_RATE = { min: 5e-6, max: 5e-4, fallback: 4e-5 } as const
export const RL_DEFAULT_RANK = 16
/**
 * Tinker's built-in RL losses that take the plain inputs the runner builds
 * (target tokens, sampling log probabilities, advantages), from
 * https://tinker-docs.thinkingmachines.ai/tinker/losses/. The first is the
 * default of the cookbook's tutorial 104 (importance sampling with
 * group-centred advantages, the GRPO recipe).
 */
export const RL_LOSSES = ['importance_sampling', 'ppo', 'cispo'] as const
export const RL_HOLDOUT_FRACTION = 0.15
export const RL_HOLDOUT_MIN = 2
export const RL_HOLDOUT_MAX = 60
/** Answers sampled for every held-out task, each time the held-out tasks are scored. */
export const RL_EVAL_SAMPLES = 2
export const RL_TASK_NAME_MAX = 48
export const RL_PROGRESS_MAX_BYTES = 8000
export const RL_PROGRESS_SAMPLE_MAX = 3
export const DEFAULT_RL_PER_DAY = 2
/** How long a progress record counts as live, counted from the moment the lab stored it. */
export const RL_PROGRESS_LIVE_MS = 6 * 60 * 1000
/** The most often the public state asks the runner how a run is going. */
export const RL_PROGRESS_REFRESH_MS = 15_000

/** More than this share of the held-out answers reaching the token limit before training is flagged (the Socratic lesson's TUTOR_CUT_SHORT_SHARE). */
export const RL_CUT_SHARE = 0.2
/** A mean reward at or above this share of the best score, in the first three steps, is flagged. */
export const RL_HACK_EARLY_LEVEL = 0.95
export const RL_HACK_EARLY_STEPS = 3
/** The held-out gain is "much smaller" when it is under this share of the training gain, and the training gain is at least the floor. */
export const RL_HACK_GAP_SHARE = 0.4
export const RL_HACK_GAIN_FLOOR = 0.15
export const RL_HACK_MIN_STEPS = 6

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** The values that turn an on-by-default switch off. Anything else, including nothing, leaves it on. */
const OFF_VALUES = new Set(['false', '0', 'off', 'no'])

/** LAB_ENABLE_TINKER_RL: on unless it is explicitly false, 0, off or no (any capitalisation, spaces trimmed). */
export function tinkerRlFlag(): boolean {
  return !OFF_VALUES.has((process.env.LAB_ENABLE_TINKER_RL || '').trim().toLowerCase())
}

/** LAB_TINKER_RL_PER_DAY: runs a day, 0 to 10, default 2. */
export function tinkerRlPerDay(): number {
  const raw = (process.env.LAB_TINKER_RL_PER_DAY || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) ? Math.min(10, Math.max(0, n)) : DEFAULT_RL_PER_DAY
}

/**
 * Is Tinker RL on? It is on by default and shares Tinker training's runner,
 * base model list and dollar caps (LAB_ENABLE_TINKER itself is a separate
 * switch and is not needed). When something it needs is missing the reason is
 * said, for the logs and the public record; the models are never told it.
 */
export function tinkerRlStatus(): TinkerStatus {
  if (!tinkerRlFlag()) return { enabled: false, off_reason: 'LAB_ENABLE_TINKER_RL is switched off' }
  if (!tinkerJobsConfigured()) return { enabled: false, off_reason: 'TINKER_JOBS_START_URL, TINKER_JOBS_STATUS_URL or TINKER_JOBS_TOKEN is not set' }
  if (tinkerBaseModels().unusable) return { enabled: false, off_reason: 'LAB_TINKER_BASE_MODELS is set but names no model the lab has a price for' }
  if (!(tinkerRunUsd() > 0) || !(tinkerDailyUsd() > 0)) return { enabled: false, off_reason: 'LAB_TINKER_RUN_USD or LAB_TINKER_DAILY_USD is 0' }
  return { enabled: true }
}

// ---------------------------------------------------------------------------
// What a model may ask for
// ---------------------------------------------------------------------------

export interface TinkerRlSettings {
  rank: number
  learning_rate: number
  group_size: number
  steps: number
  tasks_per_step: number
  max_completion_tokens: number
  loss: (typeof RL_LOSSES)[number]
}

export interface TinkerRlRequest {
  purpose: string
  /** A short name for the task set, for the plate on the practice bench. */
  task_set: string
  base_model: string
  tasks: RubricTask[]
  rubric: Rubric
  settings: TinkerRlSettings
  /** SHA-256 of the tasks and the rubric exactly as the lab read them (JSON, in order). */
  dataset_sha256: string
  dataset_bytes: number
  name?: string
  name_refused?: string
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
function onlyKeys(o: Json, allowed: readonly string[]): string | null {
  const extra = Object.keys(o).find(k => !allowed.includes(k))
  return extra === undefined ? null : extra.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_'
}

/** How many of `n` tasks the lab holds out. */
export function rlHoldoutCount(n: number): number {
  return Math.min(RL_HOLDOUT_MAX, Math.max(RL_HOLDOUT_MIN, Math.ceil(n * RL_HOLDOUT_FRACTION)))
}

function wholeIn(v: unknown, bounds: { min: number; max: number; fallback: number }, name: string): number | string {
  const x = v === undefined ? bounds.fallback : v
  if (typeof x !== 'number' || !Number.isInteger(x) || x < bounds.min || x > bounds.max) return `settings.${name} must be a whole number from ${bounds.min} to ${bounds.max}`
  return x
}

/** The bounded settings of an RL run, read strictly. */
export function readRlSettings(raw: unknown): { settings: TinkerRlSettings } | { error: string } {
  const s = raw === undefined || raw === null ? {} : raw
  if (!isObject(s)) return { error: 'settings is not an object' }
  const extra = onlyKeys(s, ['rank', 'learning_rate', 'group_size', 'steps', 'tasks_per_step', 'max_completion_tokens', 'loss'])
  if (extra) return { error: `settings has an unknown field: ${extra}` }
  const rank = s.rank === undefined ? RL_DEFAULT_RANK : s.rank
  if (!(TINKER_RANKS as readonly unknown[]).includes(rank)) return { error: `settings.rank must be one of ${TINKER_RANKS.join(', ')}` }
  const lr = s.learning_rate === undefined ? RL_LEARNING_RATE.fallback : s.learning_rate
  if (typeof lr !== 'number' || !Number.isFinite(lr) || lr < RL_LEARNING_RATE.min || lr > RL_LEARNING_RATE.max) {
    return { error: `settings.learning_rate must be a number from ${RL_LEARNING_RATE.min} to ${RL_LEARNING_RATE.max}` }
  }
  const group = wholeIn(s.group_size, RL_GROUP_SIZE, 'group_size')
  if (typeof group === 'string') return { error: group }
  const steps = wholeIn(s.steps, RL_STEPS, 'steps')
  if (typeof steps === 'string') return { error: steps }
  const perStep = wholeIn(s.tasks_per_step, RL_TASKS_PER_STEP, 'tasks_per_step')
  if (typeof perStep === 'string') return { error: perStep }
  const tokens = wholeIn(s.max_completion_tokens, RL_COMPLETION_TOKENS, 'max_completion_tokens')
  if (typeof tokens === 'string') return { error: tokens }
  const loss = s.loss === undefined ? RL_LOSSES[0] : s.loss
  if (typeof loss !== 'string' || !(RL_LOSSES as readonly string[]).includes(loss)) return { error: `settings.loss must be one of ${RL_LOSSES.join(', ')}` }
  return { settings: { rank: rank as number, learning_rate: lr, group_size: group, steps, tasks_per_step: perStep, max_completion_tokens: tokens, loss: loss as TinkerRlSettings['loss'] } }
}

/** Letters, digits, spaces, hyphens, apostrophes, dots and commas: a name for a plate, not a place for markup. */
const TASK_SET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,'-]*$/

/**
 * Reads what the Executor wrote under "tinker_rl". Strict: any field the lab
 * does not know, any value out of range, any malformed task or rule is a
 * refusal with a reason, never a guess. Nothing is cut to fit.
 */
export function normalizeTinkerRlRequest(raw: unknown, allowed: string[] = tinkerBaseModels().models): { request: TinkerRlRequest } | { error: string } {
  if (!isObject(raw)) return { error: 'not an object with "tasks" and "rubric"' }
  const names = tinkerNamesFlag()
  const extra = onlyKeys(raw, names
    ? ['purpose', 'task_set', 'base_model', 'tasks', 'rubric', 'settings', 'name']
    : ['purpose', 'task_set', 'base_model', 'tasks', 'rubric', 'settings'])
  if (extra) return { error: `unknown field: ${extra}` }
  if (!allowed.length) return { error: 'no base model is allowed' }
  const base = raw.base_model === undefined || raw.base_model === null || raw.base_model === '' ? allowed[0] : raw.base_model
  if (typeof base !== 'string' || !allowed.includes(base)) return { error: `base_model must be one of: ${allowed.join(', ')}` }
  const checked = readRlSettings(raw.settings)
  if ('error' in checked) return checked

  const list = raw.tasks
  if (!Array.isArray(list)) return { error: 'tasks is not a list' }
  if (list.length < RL_MIN_TASKS || list.length > RL_MAX_TASKS) return { error: `tasks must hold ${RL_MIN_TASKS} to ${RL_MAX_TASKS} tasks (it holds ${list.length})` }
  const tasks: RubricTask[] = []
  const seen = new Map<string, number>()
  let bytes = 0
  for (const [i, item] of list.entries()) {
    const read = normalizeTask(item, `tasks[${i}]`)
    if ('error' in read) return read
    // Two tasks that are the same could land on both sides of the held-out split and make the score look better than it is.
    const first = seen.get(read.task.prompt)
    if (first !== undefined) return { error: `tasks[${i}] has the same prompt as tasks[${first}]: every task must be different` }
    seen.set(read.task.prompt, i)
    bytes += read.bytes
    if (bytes > RL_MAX_TASK_BYTES) return { error: `the tasks hold more than ${RL_MAX_TASK_BYTES} bytes of text` }
    tasks.push(read.task)
  }
  const rubric = normalizeRubric(raw.rubric)
  if ('error' in rubric) return rubric
  const fits = rubricFitsTasks(rubric.rubric, tasks)
  if (fits) return { error: fits }

  const purpose = typeof raw.purpose === 'string' ? raw.purpose.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  let taskSet = ''
  if (raw.task_set !== undefined && raw.task_set !== null && raw.task_set !== '') {
    if (typeof raw.task_set !== 'string' || raw.task_set.trim().length > RL_TASK_NAME_MAX || !TASK_SET_PATTERN.test(raw.task_set.trim())) {
      return { error: `task_set must be 1 to ${RL_TASK_NAME_MAX} characters: letters, digits, spaces, dots, commas, apostrophes and hyphens, starting with a letter or digit` }
    }
    taskSet = raw.task_set.trim().replace(/\s+/g, ' ')
  }
  const named = names && raw.name !== undefined && raw.name !== null && raw.name !== '' ? readAdapterName(raw.name) : null
  return {
    request: {
      purpose, task_set: taskSet, base_model: base, tasks, rubric: rubric.rubric, settings: checked.settings,
      dataset_sha256: createHash('sha256').update(JSON.stringify({ tasks, rubric: rubric.rubric }), 'utf8').digest('hex'),
      dataset_bytes: bytes,
      ...(named && 'name' in named ? { name: named.name } : {}),
      ...(named && 'error' in named ? { name_refused: named.error } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Cost: the estimate before, the measured tokens after
// ---------------------------------------------------------------------------

/** Tokens the lab assumes a task prompt takes before anything has been tokenized: a token for every byte, which no text exceeds, and some for the chat format. */
export function estimateTaskTokens(task: RubricTask): number {
  return Buffer.byteLength(task.prompt, 'utf8') + TINKER_TOKENS_PER_MESSAGE + TINKER_TOKENS_PER_EXAMPLE
}

export interface TinkerRlEstimate {
  tasks: number
  holdout: number
  train_tasks: number
  steps: number
  tasks_per_step: number
  /** Answers sampled while training, at the most. */
  attempts: number
  /** Tokens the run could generate while training and while scoring the held-out tasks twice. */
  sampled_tokens: number
  /** The most the run could cost at the published prices, margin included. This is what is set aside. */
  max_cost_usd: number
}

/**
 * The most a run could cost, from the request alone. The runner trains on
 * the training tasks the lab picks after the request, so the estimate takes
 * the longest prompts of the whole set for every step, and the longest
 * prompts for the held-out slice. Every answer is counted at its longest
 * (max_completion_tokens). A run that stops early or whose answers are short
 * costs less, and settles on the tokens the runner counted.
 */
export function estimateTinkerRl(request: Pick<TinkerRlRequest, 'base_model' | 'tasks' | 'settings'>): TinkerRlEstimate {
  const s = request.settings
  const sizes = request.tasks.map(estimateTaskTokens).sort((a, b) => b - a)
  const n = sizes.length
  const holdout = rlHoldoutCount(n)
  const trainTasks = n - holdout
  const perStep = Math.min(s.tasks_per_step, trainTasks)
  const top = sizes.slice(0, perStep).reduce((a, b) => a + b, 0)
  const heldTop = sizes.slice(0, holdout).reduce((a, b) => a + b, 0)
  const evalCompletion = holdout * RL_EVAL_SAMPLES * s.max_completion_tokens
  const stepCompletion = perStep * s.group_size * s.max_completion_tokens
  const tokens: TinkerTokens = {
    train: s.steps * (s.group_size * top + stepCompletion),
    eval: 0,
    sample_prompt: s.steps * top + 2 * heldTop,
    sample_completion: s.steps * stepCompletion + 2 * evalCompletion,
  }
  const usd = TINKER_ESTIMATE_MARGIN * tinkerCostUsd(request.base_model, tokens)
  return {
    tasks: n, holdout, train_tasks: trainTasks, steps: s.steps, tasks_per_step: perStep,
    attempts: s.steps * perStep * s.group_size,
    sampled_tokens: tokens.sample_completion,
    max_cost_usd: Math.ceil(usd * 1e6) / 1e6,
  }
}

// ---------------------------------------------------------------------------
// The body the runner is sent
// ---------------------------------------------------------------------------

/**
 * The body for the runner: the data and settings a model wrote, and the
 * limits and prices the lab sets. `runId` is the run's own name (its adapter
 * slug), which is also the key its progress is stored under at the runner.
 */
export function tinkerRlJobBody(request: TinkerRlRequest, opts: { splitSalt: string; budgetUsd: number; label: string; runId: string; exportWeights?: boolean }): Record<string, unknown> {
  return {
    run_id: opts.runId,
    rl: {
      base_model: request.base_model,
      tasks: request.tasks,
      rubric: request.rubric,
      settings: request.settings,
      split_salt: opts.splitSalt,
      budget_usd: opts.budgetUsd,
      prices: TINKER_PRICES[request.base_model],
      ttl_seconds: tinkerTtlDays() * 24 * 60 * 60,
      samples: RL_PROGRESS_SAMPLE_MAX,
      label: opts.label,
      ...(opts.exportWeights ? { export: true } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Progress: what the runner writes after every step
// ---------------------------------------------------------------------------

export const RL_PHASES = ['starting', 'baseline', 'sampling', 'scored', 'measuring', 'saving', 'done'] as const
export type RlPhase = (typeof RL_PHASES)[number]

export interface RlSample { prompt: string; completion: string; reward: number }

export interface RlProgress {
  phase: RlPhase
  /** Steps whose answers were scored and trained on. */
  step: number
  steps_planned: number
  group_size: number
  tasks_per_step: number
  max_reward: number
  /** Mean reward of each finished step, oldest first. Taken from the tasks of that step, so it is the reward the run trained on. */
  means: number[]
  /** The share of a step's answers that earned the best score. */
  frac_max: number[]
  /** The rewards of the answers of the first task of the step that was scored last: one per answer of the group. Empty while a step is being sampled. */
  attempts: number[]
  samples: RlSample[]
  score_before: number | null
  score_after: number | null
  wall_seconds: number
  /** Steps in which at least one group had answers that scored differently, so a gradient step really ran. Null when the runner did not say. */
  steps_trained: number | null
  /** The runner's own count of the records it has written. It rises with every one, so a record the lab has already stored is told from a new one. Null from an older runner. */
  seq: number | null
  /**
   * For each finished step, how many of its sampled answers used the whole
   * token limit without finishing. Counting only: an answer is graded as the
   * text it has. Null when the runner did not say (a runner deployed before
   * the count existed, or a run whose answers did not say how they ended).
   */
  capped: number[] | null
  /** For each finished step, the mean number of tokens an answer used. Null when the runner did not say. */
  mean_tokens: number[] | null
  /** How many held-out answers were graded before training, and how many of them reached the token limit. Null until measured, and when the runner did not say. */
  answers_before: number | null
  capped_before: number | null
  /** The same after training, on the saved adapter. */
  answers_after: number | null
  capped_after: number | null
  /** When the lab first stored this record: the last time the runner reported something new, not the last time the lab asked. */
  updated_at: string
}

// eslint-disable-next-line no-control-regex
const CONTROL_RUN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g
const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(CONTROL_RUN, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
const unit = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 1e4) / 1e4 : null)
const whole = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null)

/** The most answers one step samples, and the most one held-out scoring grades. */
const RL_STEP_ANSWERS_MAX = RL_GROUP_SIZE.max * RL_TASKS_PER_STEP.max
const RL_HELD_ANSWERS_MAX = RL_HOLDOUT_MAX * RL_EVAL_SAMPLES

/** A list of numbers, each passing `one`, or null when it is not such a list. */
function numberList(v: unknown, max: number, one: (x: unknown) => number | null): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: number[] = []
  for (const x of v) {
    const n = one(x)
    if (n === null) return null
    out.push(n)
  }
  return out
}
const tokenMean = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= RL_COMPLETION_TOKENS.max ? Math.round(x * 10) / 10 : null

/**
 * The counts of one held-out scoring, from the runner's two numbers. `ok` is
 * false when what was sent is not a count, or says more answers reached the
 * limit than were graded. A runner that sends neither number has said
 * nothing; one that sends only how many were graded has said nothing about
 * the limit, and `capped` stays null.
 */
function heldCounts(answers: unknown, capped: unknown): { ok: boolean; answers: number | null; capped: number | null } {
  const none = { ok: true, answers: null, capped: null }
  if (answers == null && capped == null) return none
  const a = whole(answers, 0, RL_HELD_ANSWERS_MAX)
  if (a === null) return { ...none, ok: false }
  if (capped == null) return { ok: true, answers: a, capped: null }
  const c = whole(capped, 0, a)
  return c === null ? { ...none, ok: false } : { ok: true, answers: a, capped: c }
}

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

/**
 * Reads a progress record from the runner, strictly, and bounds it. A record
 * with anything out of range is dropped whole (null): the bench shows nothing
 * rather than a guess. Strings are cut and cleaned here whatever the runner
 * did.
 */
export function readRlProgress(raw: unknown, now: Date = new Date()): RlProgress | null {
  if (!isObject(raw) || raw.v !== 1) return null
  const phase = raw.phase
  if (typeof phase !== 'string' || !(RL_PHASES as readonly string[]).includes(phase)) return null
  const step = whole(raw.step, 0, RL_STEPS.max)
  const planned = whole(raw.steps_planned, 1, RL_STEPS.max)
  const group = whole(raw.group_size, RL_GROUP_SIZE.min, RL_GROUP_SIZE.max)
  const perStep = whole(raw.tasks_per_step, 1, RL_TASKS_PER_STEP.max)
  const maxReward = unit(raw.max_reward)
  const means = unitList(raw.means, RL_STEPS.max)
  const fracMax = unitList(raw.frac_max, RL_STEPS.max)
  const attempts = unitList(raw.attempts, RL_GROUP_SIZE.max)
  if (step === null || planned === null || group === null || perStep === null || maxReward === null || !means || !fracMax || !attempts) return null
  if (step > planned || means.length > planned) return null
  const samples: RlSample[] = []
  if (raw.samples !== undefined) {
    if (!Array.isArray(raw.samples)) return null
    for (const s of raw.samples.slice(0, RL_PROGRESS_SAMPLE_MAX)) {
      if (!isObject(s)) return null
      const reward = unit(s.reward)
      if (reward === null) return null
      samples.push({ prompt: clean(s.prompt, 100), completion: clean(s.completion, 160), reward })
    }
  }
  const before = raw.score_before === null || raw.score_before === undefined ? null : unit(raw.score_before)
  const after = raw.score_after === null || raw.score_after === undefined ? null : unit(raw.score_after)
  if ((raw.score_before != null && before === null) || (raw.score_after != null && after === null)) return null
  const wall = typeof raw.wall_seconds === 'number' && Number.isFinite(raw.wall_seconds) && raw.wall_seconds >= 0 ? Math.min(raw.wall_seconds, 86_400) : 0
  const trained = raw.steps_trained === undefined || raw.steps_trained === null ? null : whole(raw.steps_trained, 0, RL_STEPS.max)
  const seq = raw.seq === undefined || raw.seq === null ? null : whole(raw.seq, 0, 1_000_000)
  if ((raw.steps_trained != null && trained === null) || (raw.seq != null && seq === null)) return null
  // The counts of cut off answers. Absent (an older runner) is "not said". Present and not what the runner sends
  // (not a count, more than a step samples, a list of another length than the steps) drops the record, like the rest.
  const capped = raw.capped == null ? null : numberList(raw.capped, RL_STEPS.max, x => whole(x, 0, group * perStep))
  const meanTokens = raw.mean_tokens == null ? null : numberList(raw.mean_tokens, RL_STEPS.max, tokenMean)
  if ((raw.capped != null && (capped === null || capped.length !== means.length)) || (raw.mean_tokens != null && (meanTokens === null || meanTokens.length !== means.length))) return null
  const heldBefore = heldCounts(raw.answers_before, raw.capped_before)
  const heldAfter = heldCounts(raw.answers_after, raw.capped_after)
  if (!heldBefore.ok || !heldAfter.ok) return null
  const progress: RlProgress = {
    phase: phase as RlPhase, step, steps_planned: planned, group_size: group, tasks_per_step: perStep, max_reward: maxReward,
    means, frac_max: fracMax, attempts, samples, score_before: before, score_after: after, wall_seconds: wall,
    steps_trained: trained, seq, capped, mean_tokens: meanTokens,
    answers_before: heldBefore.answers, capped_before: heldBefore.capped, answers_after: heldAfter.answers, capped_after: heldAfter.capped,
    updated_at: now.toISOString(),
  }
  // Bounded whatever it was sent: samples go first, then the record is refused.
  while (Buffer.byteLength(JSON.stringify(progress), 'utf8') > RL_PROGRESS_MAX_BYTES && progress.samples.length) progress.samples.pop()
  return Buffer.byteLength(JSON.stringify(progress), 'utf8') > RL_PROGRESS_MAX_BYTES ? null : progress
}

/** Reads a record the lab stored itself (it comes back from the database as an object or text). */
export function storedRlProgress(raw: unknown): RlProgress | null {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (!isObject(value)) return null
  const updated = typeof value.updated_at === 'string' && !Number.isNaN(Date.parse(value.updated_at)) ? new Date(value.updated_at) : new Date(0)
  return readRlProgress({ v: 1, ...value }, updated)
}

/**
 * Is this record newer than the one the lab already holds? With the runner's
 * counter it is, when the counter is higher. Without one (an older runner) it
 * is, when anything in it differs. A record the lab has already stored is not
 * new, however often it is asked for again, so asking never makes a run look
 * alive.
 */
export function isNewerProgress(incoming: RlProgress, stored: RlProgress | null): boolean {
  if (!stored) return true
  if (incoming.seq !== null && stored.seq !== null) return incoming.seq > stored.seq
  const strip = (p: RlProgress) => JSON.stringify({ ...p, updated_at: '' })
  return strip(incoming) !== strip(stored)
}

/** Is a stored progress record recent enough to say a run is still moving? */
export function progressIsLive(progress: RlProgress | null, status: string, now: Date = new Date()): boolean {
  if (!progress || (status !== 'running' && status !== 'reserved')) return false
  if (progress.phase === 'done') return false
  return now.getTime() - Date.parse(progress.updated_at) <= RL_PROGRESS_LIVE_MS
}

// ---------------------------------------------------------------------------
// The flag for rewards that may have been gamed
// ---------------------------------------------------------------------------

export interface RlHackingFlag { flag: boolean; reasons: string[] }

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * Two signs that the reward may be easier to earn than the rubric means:
 *  1. the mean reward of one of the first 3 steps is at least 0.95 of the
 *     best score the rubric allows (the task set may be too easy, or the
 *     rubric may be gameable);
 *  2. from 6 steps on, the reward on the training tasks rose by at least 0.15
 *     (the mean of the last 3 steps over the first 3) and the held-out score
 *     rose by less than 40% of that.
 * The flag is recorded and shown. It blocks nothing.
 */
export function rlHackingFlag(input: { means: number[]; maxReward: number; scoreBefore: number | null; scoreAfter: number | null }): RlHackingFlag {
  const reasons: string[] = []
  const best = input.maxReward > 0 ? input.maxReward : 1
  const early = input.means.slice(0, RL_HACK_EARLY_STEPS)
  const hit = early.findIndex(m => m >= RL_HACK_EARLY_LEVEL * best - 1e-9)
  if (hit >= 0) reasons.push(`the mean reward reached ${early[hit].toFixed(2)} in step ${hit + 1}, within the first ${RL_HACK_EARLY_STEPS} steps: the tasks may be too easy or the rubric may be easy to satisfy without doing what it was meant to measure`)
  if (input.means.length >= RL_HACK_MIN_STEPS && input.scoreBefore !== null && input.scoreAfter !== null) {
    const trainGain = mean(input.means.slice(-3)) - mean(input.means.slice(0, 3))
    const heldGain = input.scoreAfter - input.scoreBefore
    if (trainGain >= RL_HACK_GAIN_FLOOR && heldGain < RL_HACK_GAP_SHARE * trainGain) {
      reasons.push(`the reward on the training tasks rose by ${trainGain.toFixed(2)} but the held-out score by ${heldGain.toFixed(2)}: what was learned may not carry over to tasks it was not trained on`)
    }
  }
  return { flag: reasons.length > 0, reasons }
}

// ---------------------------------------------------------------------------
// The flag for held-out answers the token limit cut off
// ---------------------------------------------------------------------------

/** One held-out scoring: how many answers were graded and how many of them used the whole token limit without finishing. */
export interface RlCutOff { graded: number; capped: number }

export interface RlCutOffFlag {
  flag: boolean
  /** More than RL_CUT_SHARE of the held-out answers before training reached the limit. */
  cut_short_before: boolean
  /** A smaller share of the held-out answers reached the limit after training than before. */
  cut_off_fell: boolean
  reasons: string[]
  before: RlCutOff | null
  after: RlCutOff | null
}

/** The counts of one scoring as a pair, or null when either number is missing or they do not fit together. */
export function rlCutOff(answers: unknown, capped: unknown): RlCutOff | null {
  const read = heldCounts(answers, capped)
  return read.ok && read.answers !== null && read.capped !== null && read.answers > 0 ? { graded: read.answers, capped: read.capped } : null
}

/**
 * An answer that reaches the token limit is graded as the text it has, which
 * for a model that writes a thinking passage first may be nothing. So a
 * held-out score can move because fewer answers are cut off, without the
 * model having learned the task. Two signs, the same two the Socratic lesson
 * flags (tutorFlags in tinker-tutor.ts) and worded the same way:
 *  1. more than a fifth of the held-out answers before training reached the limit;
 *  2. a smaller share reached it after training than before.
 * With no counts (a runner that does not send them) there is no flag: the lab
 * does not know. The flag is recorded and shown. It blocks nothing.
 */
export function rlCutOffFlag(input: { before: RlCutOff | null; after: RlCutOff | null }): RlCutOffFlag {
  const { before, after } = input
  const reasons: string[] = []
  const cut = before !== null && before.capped / before.graded > RL_CUT_SHARE
  if (cut) reasons.push(`many untrained held-out answers were cut off by the token limit (${before!.capped} of ${before!.graded}), so a change in the held-out score may come from answers no longer being cut off`)
  const fell = before !== null && after !== null && before.capped > 0 && after.capped / after.graded < before.capped / before.graded - 1e-12
  if (fell && !cut) reasons.push(`fewer held-out answers were cut off by the token limit after training (${before!.capped} of ${before!.graded} before, ${after!.capped} of ${after!.graded} after), so part of a change in the held-out score may come from answers no longer being cut off`)
  return { flag: cut || fell, cut_short_before: cut, cut_off_fell: fell, reasons, before, after }
}

// ---------------------------------------------------------------------------
// What the runner sends back
// ---------------------------------------------------------------------------

export interface TinkerRlResult {
  status: 'ok' | 'refused' | 'error' | 'failed'
  stage: string | null
  reason: string | null
  n_tasks: number | null
  n_train: number | null
  n_holdout: number | null
  steps_planned: number | null
  steps_done: number | null
  /** Steps in which a gradient step ran. A step whose answers all scored the same teaches nothing and is done but not trained. */
  steps_trained: number | null
  stopped_early: string | null
  max_reward: number | null
  /** Mean rubric score of the base model on the held-out tasks, measured by the lab. */
  score_before: number | null
  /** The same on the saved adapter. */
  score_after: number | null
  train_score_first: number | null
  train_score_last: number | null
  step_means: number[]
  step_frac_max: number[]
  /** For each step, how many sampled answers reached the token limit without finishing. Null when the runner did not send a count for every step. */
  step_capped: number[] | null
  /** For each step, the mean number of tokens an answer used. Null when the runner did not send one for every step. */
  step_mean_tokens: number[] | null
  /** The held-out answers graded before and after training, and how many of them reached the token limit. Null when the runner did not say. */
  answers_before: number | null
  capped_before: number | null
  answers_after: number | null
  capped_after: number | null
  tokens: TinkerTokens
  sampler_path: string | null
  ttl_seconds: number | null
  samples: RlSample[]
  wall_seconds: number | null
  external_path?: string
  export_error?: string
}

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Reads the runner's answer. An "ok" with no well-formed sampler path or no
 * held-out scores is not an ok. Token counts are read whatever the status,
 * because a run that failed part way still used some.
 */
export function normalizeRlResult(raw: unknown): TinkerRlResult {
  const r = isObject(raw) ? raw : {}
  const t = isObject(r.tokens) ? r.tokens : {}
  const list = (v: unknown): number[] => (unitList(v, RL_STEPS.max) ?? [])
  const stepMeans = list(r.step_means)
  // A count for every step or no count: a list of another length, or with anything in it that is not a count, is "not said".
  const perStep = (v: unknown, one: (x: unknown) => number | null): number[] | null => {
    const read = v == null ? null : numberList(v, RL_STEPS.max, one)
    return read !== null && read.length === stepMeans.length ? read : null
  }
  const heldBefore = heldCounts(r.answers_before, r.capped_before)
  const heldAfter = heldCounts(r.answers_after, r.capped_after)
  const base: TinkerRlResult = {
    status: 'failed', stage: clean(r.stage, 30) || null, reason: null,
    n_tasks: count(r.n_tasks), n_train: count(r.n_train), n_holdout: count(r.n_holdout),
    steps_planned: count(r.steps_planned), steps_done: count(r.steps_done), steps_trained: count(r.steps_trained), stopped_early: clean(r.stopped_early, 200) || null,
    max_reward: unit(r.max_reward), score_before: unit(r.score_before), score_after: unit(r.score_after),
    train_score_first: unit(r.train_score_first), train_score_last: unit(r.train_score_last),
    step_means: stepMeans, step_frac_max: list(r.step_frac_max),
    step_capped: perStep(r.step_capped, x => whole(x, 0, RL_STEP_ANSWERS_MAX)), step_mean_tokens: perStep(r.step_mean_tokens, tokenMean),
    answers_before: heldBefore.answers, capped_before: heldBefore.capped, answers_after: heldAfter.answers, capped_after: heldAfter.capped,
    tokens: { train: count(t.train) ?? 0, eval: count(t.eval) ?? 0, sample_prompt: count(t.sample_prompt) ?? 0, sample_completion: count(t.sample_completion) ?? 0 },
    sampler_path: null, ttl_seconds: count(r.ttl_seconds), samples: [], wall_seconds: finite(r.wall_seconds),
  }
  if (r.status === 'refused') return { ...base, status: 'refused', reason: clean(r.reason, 400) || 'refused' }
  if (r.status === 'error') return { ...base, status: 'error', reason: clean(r.error, 400) || clean(r.reason, 400) || 'the runner failed' }
  if (r.status !== 'ok') return { ...base, reason: 'the runner gave no usable answer' }
  if (!isSamplerPath(r.sampler_path) || base.score_before === null || base.score_after === null) {
    return { ...base, reason: 'the runner\'s answer had no saved adapter or no held-out scores' }
  }
  const samples: RlSample[] = []
  for (const s of Array.isArray(r.samples) ? r.samples.slice(0, RL_PROGRESS_SAMPLE_MAX) : []) {
    if (!isObject(s)) continue
    const reward = unit(s.reward)
    const prompt = clean(s.prompt, 300)
    if (prompt && reward !== null) samples.push({ prompt, completion: clean(s.completion, 600), reward })
  }
  return {
    ...base, status: 'ok', sampler_path: r.sampler_path, samples,
    ...(isExternalPath(r.external_path) ? { external_path: r.external_path } : {}),
    ...(!isExternalPath(r.external_path) && clean(r.export_error, 200) ? { export_error: clean(r.export_error, 200) } : {}),
  }
}

/** One line for the stored record and the next epoch's context. Says what was measured, by whom, and that the cost is an estimate. */
export function describeTinkerRl(r: TinkerRlResult, baseModel: string, slug: string | null, costUsd: number, expiresAt: string | null, name: string | null, hacking: RlHackingFlag,
  cutOff: RlCutOffFlag = rlCutOffFlag({ before: rlCutOff(r.answers_before, r.capped_before), after: rlCutOff(r.answers_after, r.capped_after) })): string {
  const cost = `estimated cost $${costUsd.toFixed(4)} (token counts at Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}, not a billed amount)`
  if (r.status === 'ok') {
    const score = `LAB-MEASURED held-out rubric score ${r.score_before!.toFixed(3)} before training, ${r.score_after!.toFixed(3)} after (best possible ${(r.max_reward ?? 1).toFixed(2)}), on ${r.n_holdout ?? '?'} tasks the lab held out`
    const steps = `${r.steps_done ?? '?'} of ${r.steps_planned ?? '?'} steps${r.steps_trained !== null && r.steps_trained !== r.steps_done ? ` (${r.steps_trained} of them trained the model)` : ''}${r.stopped_early ? ` (stopped early: ${r.stopped_early})` : ''}`
    const adapter = slug ? `adapter lab/${slug}${name ? ` named "${name}"` : ''} on ${baseModel}${expiresAt ? `, kept until ${expiresAt.slice(0, 10)}` : ''}` : `adapter on ${baseModel}`
    // Said only where an answer was cut off: a run with none reads as it always did.
    const cut = (cutOff.before?.capped ?? 0) > 0 || (cutOff.after?.capped ?? 0) > 0
      ? `; held-out answers that reached the token limit without finishing: ${cutOff.before ? `${cutOff.before.capped} of ${cutOff.before.graded}` : 'not counted'} before training, ${cutOff.after ? `${cutOff.after.capped} of ${cutOff.after.graded}` : 'not counted'} after`
      : ''
    return `${score}${cut}; ${steps}${hacking.flag ? '; FLAG: the reward may be gamed (see the record)' : ''}${cutOff.flag ? '; FLAG: a change in the held-out score may come from answers no longer being cut off (see the record)' : ''}; ${adapter}; ${cost}`
  }
  if (r.status === 'refused') return `refused by the runner${r.stage ? ` (${r.stage})` : ''}: ${r.reason}; ${cost}`
  return `${r.status}${r.stage ? ` at ${r.stage}` : ''}: ${r.reason || 'unknown'}; ${cost}`
}

/** What was asked, in one line, for the stored record. */
export function tinkerRlRequestSummary(baseModel: string, tasks: number, rulesCount: number, steps: number, purpose: string | null, name: string | null = null): string {
  return `Tinker RL of ${baseModel} on ${tasks} tasks, ${rulesCount} rubric rule${rulesCount === 1 ? '' : 's'}, ${steps} step${steps === 1 ? '' : 's'}${name ? `, named "${name}"` : ''}${purpose ? `: ${purpose}` : ''}`
}

// ---------------------------------------------------------------------------
// The public record
// ---------------------------------------------------------------------------

/** What the lab keeps on the run's row about the request (the `rl` column): public, so nothing in it that was not already in the model's answer. */
export interface RlRecord {
  task_set: string | null
  tasks: number
  rubric: Rubric
  rubric_lines: string[]
  max_reward: number
  settings: TinkerRlSettings
  estimate: TinkerRlEstimate
  tasks_sha256: string
}

export function rlRecordOf(request: TinkerRlRequest): RlRecord {
  return {
    task_set: request.task_set || null,
    tasks: request.tasks.length,
    rubric: request.rubric,
    rubric_lines: describeRubric(request.rubric),
    max_reward: rubricMax(request.rubric),
    settings: request.settings,
    estimate: estimateTinkerRl(request),
    tasks_sha256: request.dataset_sha256,
  }
}

/** The run as visitors see it. No checkpoint path, no split salt, no call id. */
export interface RlPracticeRun {
  slug: string
  adapter: string
  kind: 'rl'
  author_model: string
  author_name: string
  epoch: number
  base_model: string
  task_set: string | null
  purpose: string | null
  name?: string
  status: string
  /** True while the lab has heard from the runner recently and the run is not finished. */
  live: boolean
  tasks: { total: number; held_out: number | null; training: number | null }
  rubric: string[]
  max_reward: number
  settings: TinkerRlSettings | null
  progress: RlProgress | null
  held_out: { before: number | null; after: number | null; measured_by: string; tasks: number | null } | null
  hacking: RlHackingFlag
  /** Held-out answers the token limit cut off, before and after, and the flag for them. The counts are null when the runner sent none. */
  cut_off: RlCutOffFlag
  cost: { estimated_usd: number | null; max_usd: number | null; basis: string }
  origin: string
  /** The lab id to talk to, present only while the adapter is alive and the visitor chat is on. */
  talk?: string
  created_at: string
  finished_at: string | null
  reason: string | null
}

export interface RlPractice {
  enabled: boolean
  off_reason?: string
  run: RlPracticeRun | null
}

/** Short text for the page: no control characters, no markup characters are kept out here (the panel escapes), only length is bounded. */
export const publicText = (v: unknown, max: number): string => clean(v, max)

// ---------------------------------------------------------------------------
// What the models are told
// ---------------------------------------------------------------------------

/**
 * One paragraph about the tool, only while it is on (the callers check). It
 * says what the tool does and where its limits are, and nothing about what to
 * train or which tasks to write.
 */
export function tinkerRlNote(opts: { perDay: number; names?: boolean; chat?: boolean }): string {
  const models = tinkerBaseModels().models.join(', ')
  const named = opts.names
    ? ` You may give the adapter a display name with "name": ${ADAPTER_NAME_MIN} to ${ADAPTER_NAME_MAX} characters, only letters, digits, spaces, hyphens, apostrophes and dots; a name that is refused is left off with the reason stored and the run goes on.`
    : ''
  const chat = opts.chat ? ' While the adapter is alive it can be talked to in the room\'s trained chat.' : ''
  return `Tinker RL: as Executor you may ask for one reinforcement-learning run of an open-weight model on Tinker, a training service. LoRA only: the base model's own weights are not changed. The base model is one of: ${models}. You write the tasks and a rubric into your answer as data, and no code: nothing you write is run. Tasks: ${RL_MIN_TASKS} to ${RL_MAX_TASKS} different tasks, each { "prompt" (text, at most 1500 bytes), optionally "expected" (text) and "data" (up to 8 named whole numbers or short texts) }, at most ${RL_MAX_TASK_BYTES} bytes of text in all. The rubric is 1 to ${RUBRIC_MAX_RULES} rules, each with a "weight" above 0 and at most 1, the weights adding up to at most 1. The rules are chosen from this menu: exact_match (the answer equals a value, the task's "expected" or one of its "data" entries, after case, spaces, quotes and ending punctuation are normalised); contains (any or all of some strings, or one value); not_contains (none of some strings); number_close (the first or last number in the answer is within a tolerance of a value, absolute or relative); regex_match (a pattern in a safe subset: characters, classes like [a-z] and \\d \\w \\s, groups, | and the quantifiers * + ? {m,n}; no lookarounds, back references, lazy quantifiers or \\b; at most 120 characters); json_valid (the answer is JSON, optionally fitting a small schema of type, required, properties and items); length_between (characters). A rule may read the whole answer, its "first_line" or its "last_line" ("scope"). Each rule gives 0 or 1 and an answer's reward is the weighted sum, from 0 to 1, computed by the lab's own code. Settings are bounded: group_size ${RL_GROUP_SIZE.min} to ${RL_GROUP_SIZE.max} (answers sampled for each task, default ${RL_GROUP_SIZE.fallback}); steps ${RL_STEPS.min} to ${RL_STEPS.max} (default ${RL_STEPS.fallback}); tasks_per_step ${RL_TASKS_PER_STEP.min} to ${RL_TASKS_PER_STEP.max} (default ${RL_TASKS_PER_STEP.fallback}); max_completion_tokens ${RL_COMPLETION_TOKENS.min} to ${RL_COMPLETION_TOKENS.max} (default ${RL_COMPLETION_TOKENS.fallback}); rank ${TINKER_RANKS.join(', ')}; learning_rate ${RL_LEARNING_RATE.min} to ${RL_LEARNING_RATE.max}; loss one of Tinker's built-in ${RL_LOSSES.join(', ')} (default ${RL_LOSSES[0]}, with rewards centred within each group of answers). A request that breaks any of this is refused whole, with the reason stored. The run needs the Reviewer's approval and happens after the epoch, run by the lab's own code. The lab estimates the most the run could cost before it starts and refuses it above $${tinkerRunUsd().toFixed(2)} a run or $${tinkerDailyUsd().toFixed(2)} of Tinker use a day (UTC), at most ${opts.perDay} run${opts.perDay === 1 ? '' : 's'} a day, inside the lab's daily spending cap. Costs are estimates from Tinker's published prices, because Tinker reports no cost per call. The lab holds out about ${Math.round(RL_HOLDOUT_FRACTION * 100)}% of the tasks, chosen by the lab after the request so that you cannot know which, and scores the base model and the trained one on them with your rubric: those scores are measured by the lab, not reported by you. A mean reward of at least 0.95 of the best score within the first ${RL_HACK_EARLY_STEPS} steps, or a held-out gain much smaller than the gain on the training tasks, is flagged in the record; a flag blocks nothing. The task set's size and hash, the rubric, the settings, the reward of each step, a few short sample answers, both held-out scores and the adapter's lab id are public, and the room's practice bench draws the run from them as it goes. The adapter is kept for ${tinkerTtlDays()} days and then expires.${chat}${named}`
}

/** What the Reviewer is told about an RL request: its size, its rubric in words, its settings and the most it could cost. */
export function tinkerRlReviewFacts(request: TinkerRlRequest): { line: string } {
  const estimate = estimateTinkerRl(request)
  const s = request.settings
  const rules = describeRubric(request.rubric).join('; ')
  return {
    line: `a reinforcement-learning run of ${request.base_model} on the ${request.tasks.length} tasks in the Executor's "tools" (${request.dataset_bytes} bytes of text). The rubric that scores every answer, written by the Executor, has ${request.rubric.rules.length} rule${request.rubric.rules.length === 1 ? '' : 's'}: ${rules}. Settings: ${s.steps} step${s.steps === 1 ? '' : 's'} of ${estimate.tasks_per_step} task${estimate.tasks_per_step === 1 ? '' : 's'} with ${s.group_size} answers each (up to ${s.max_completion_tokens} tokens), rank ${s.rank}, learning rate ${s.learning_rate}, loss ${s.loss}. The lab's check: the request meets the format and the limits, and every rule compiles. The lab's estimate of the most it could cost, from Tinker's published prices: ${usdText(estimate.max_cost_usd)} (a run may cost at most ${usdText(tinkerRunUsd())}). If you approve, the lab's own code holds out ${estimate.holdout} of the tasks, scores the base model on them, trains on the rest with the rubric's scores as rewards, and scores the held-out tasks again on the trained adapter. Whether the rubric measures what the tasks seem to ask for is for you to judge`,
  }
}

