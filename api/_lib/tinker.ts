/**
 * Tinker training (docs/TOOLS.md, "Tinker training").
 *
 * When LAB_ENABLE_TINKER is on, the Executor may ask for one LoRA fine-tune
 * of a small open-weight model on Tinker (Thinking Machines), on a dataset it
 * writes into its answer. The Reviewer rules on it like an exhibit. The run
 * itself is done by the lab's own code on Modal (modal/tinker_jobs.py): it
 * holds out a slice the model did not choose, measures the base model and
 * the trained one on it, and keeps the adapter for a while so it can be
 * talked to.
 *
 * This file is the part with no database and no network in it: the switches
 * and their settings, the published price table, the strict reading of what
 * a model wrote, the cost estimate, the reading of what the runner sent
 * back, and the text the models are told.
 *
 * About money. Tinker returns no cost with a call, its billing page lags by
 * hours, and its keys cannot carry a spending limit. So every dollar figure
 * here is an ESTIMATE: token counts times the price Tinker published on the
 * date below. Before a run the lab sets aside the most the run could cost;
 * after it, that is replaced by the tokens the runner counted times the same
 * prices. Nothing here is a billed amount.
 *
 * The Tinker API key is never read in this file.
 */
import { createHash, randomBytes } from 'node:crypto'
import { ADAPTER_NAME_MAX, ADAPTER_NAME_MIN, readAdapterName } from './tinker-names.js'

export const TINKER_TOOL = 'tinker_train'

// ---------------------------------------------------------------------------
// Published prices
// ---------------------------------------------------------------------------

/** US dollars per million tokens. */
export interface TinkerPrice {
  /** Forward and backward passes, and forward-only passes made by a training client. */
  train: number
  /** Generated tokens. */
  sample: number
  /** Prompt tokens when sampling. The cached discount is not applied, so estimates err high. */
  prefill: number
}

/** The day these prices were copied from https://tinker-docs.thinkingmachines.ai/tinker/models.json. */
export const TINKER_PRICE_TABLE_DATE = '2026-11-18'

/**
 * The base models the lab knows a price and a chat format for. All three are
 * current chat models that can answer without reasoning first ("Hybrid" in
 * Tinker's table); none is marked as retiring. LAB_TINKER_BASE_MODELS can
 * only choose among these: a model with no price here cannot be estimated,
 * so it cannot be allowed. The runner on Modal has the same three ids.
 */
export const TINKER_PRICES: Readonly<Record<string, TinkerPrice>> = {
  'Qwen/Qwen3.5-4B': { train: 0.737, sample: 1.005, prefill: 0.33 },
  'Qwen/Qwen3.5-9B': { train: 1.463, sample: 0.807, prefill: 0.30 },
  'Qwen/Qwen3.6-35B-A3B': { train: 1.177, sample: 1.335, prefill: 0.45 },
}

/** The cheapest of them to train, and the one Tinker's own first tutorial uses. */
export const DEFAULT_TINKER_BASE_MODELS = ['Qwen/Qwen3.5-4B'] as const

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const TINKER_MIN_EXAMPLES = 10
export const TINKER_MAX_EXAMPLES = 2000
export const TINKER_MAX_MESSAGES = 12
/**
 * UTF-8 bytes of message text in one example, and in the whole dataset. The
 * dataset is part of the Executor's answer, which the Challenger and the
 * Reviewer read whole, so its size is held to what an answer can carry.
 */
export const TINKER_MAX_EXAMPLE_BYTES = 6000
export const TINKER_MAX_DATASET_BYTES = 120_000
/** Optimizer steps in one run: examples trained on, divided by the batch size, times the epochs. */
export const TINKER_MAX_STEPS = 600
export const TINKER_RANKS = [8, 16, 32] as const
export const TINKER_LEARNING_RATE = { min: 1e-5, max: 5e-4, fallback: 2e-4 } as const
export const TINKER_EPOCHS = { min: 1, max: 3, fallback: 2 } as const
export const TINKER_BATCH_SIZE = { min: 1, max: 16, fallback: 8 } as const
export const TINKER_DEFAULT_RANK = 16
/** The slice the lab holds out: about a tenth, at least 2 and at most 200 examples. */
export const TINKER_HOLDOUT_FRACTION = 0.1
export const TINKER_HOLDOUT_MIN = 2
export const TINKER_HOLDOUT_MAX = 200
/** Completions the runner samples from the trained model on held-out prompts. */
export const TINKER_SAMPLE_COUNT = 3
export const TINKER_SAMPLE_MAX_TOKENS = 120
/** The runner's own time limits on Modal (TRAIN_WALL_S and RUN_TIMEOUT_S in modal/tinker_jobs.py). */
export const TINKER_TRAIN_WALL_S = 1800
export const TINKER_RUN_TIMEOUT_S = 2700

/**
 * The estimate: one token for every byte of text, some for the chat format,
 * and a margin on top. One token per byte is a ceiling, not a guess: the
 * tokenizer never makes more tokens than there are bytes, and text such as
 * digits really does come close to one each. An estimate that assumed 3 bytes
 * a token set aside too little for data like that, and the runner, which
 * counts real tokens, then refused a run the Reviewer had approved.
 */
export const TINKER_BYTES_PER_TOKEN = 1
export const TINKER_TOKENS_PER_MESSAGE = 8
export const TINKER_TOKENS_PER_EXAMPLE = 12
export const TINKER_ESTIMATE_MARGIN = 1.25

export const DEFAULT_TINKER_RUN_USD = 2
export const DEFAULT_TINKER_DAILY_USD = 10
export const DEFAULT_TINKER_CHAT_DAILY_USD = 1
/** Ceilings the environment cannot raise (the runner refuses a larger run budget too). */
export const TINKER_HARD_RUN_USD = 5
export const TINKER_HARD_DAILY_USD = 50
export const TINKER_HARD_CHAT_DAILY_USD = 10
export const DEFAULT_TINKER_TTL_DAYS = 14
export const TINKER_MAX_TTL_DAYS = 30
export const DEFAULT_TINKER_WAIT_MS = 300_000
export const TINKER_MAX_WAIT_MS = 480_000
/** Adapters that may be marked to keep at one time (LAB_TINKER_KEEP_MAX), and the most the environment can ask for. */
export const DEFAULT_TINKER_KEEP_MAX = 10
export const TINKER_HARD_KEEP_MAX = 40
/** How long a kept adapter stays on Tinker, counted from the day it is kept (LAB_TINKER_KEEP_DAYS). */
export const DEFAULT_TINKER_KEEP_DAYS = 365
export const TINKER_MIN_KEEP_DAYS = 30
export const TINKER_MAX_KEEP_DAYS = 3650
/** The most one exported copy of an adapter may weigh (LAB_TINKER_KEEP_MAX_MB), and the runner's own ceiling. */
export const DEFAULT_TINKER_KEEP_MAX_MB = 1024
export const TINKER_HARD_KEEP_MAX_MB = 4096
/** How long a request waits for the runner to keep or unkeep an adapter before a later tick collects it. */
export const TINKER_KEEP_WAIT_MS = 45_000

// ---------------------------------------------------------------------------
// Switches and settings
// ---------------------------------------------------------------------------

function flag(name: string): boolean {
  return (process.env[name] || '').trim().toLowerCase() === 'true'
}
function has(name: string): boolean {
  return Boolean((process.env[name] || '').trim())
}
function usdEnv(name: string, fallback: number, ceiling: number): number {
  const raw = (process.env[name] || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.min(n, ceiling) : fallback
}

export function tinkerFlag(): boolean {
  return flag('LAB_ENABLE_TINKER')
}
/** Trained adapters as models of the lab model endpoint ("lab/<name>"). */
export function liveTrainedFlag(): boolean {
  return flag('LAB_ENABLE_LIVE_TRAINED')
}
/** The visitor chat with trained adapters. */
export function trainedChatFlag(): boolean {
  return flag('LAB_ENABLE_TRAINED_CHAT')
}
/** A training request may name its adapter (tinker-names.ts). */
export function tinkerNamesFlag(): boolean {
  return flag('LAB_ENABLE_TINKER_NAMES')
}
/** Adapters can be marked to keep (tinker-keep.ts). */
export function tinkerKeepFlag(): boolean {
  return flag('LAB_ENABLE_TINKER_KEEP')
}
function wholeEnv(name: string, fallback: number, lo: number, hi: number): number {
  const raw = (process.env[name] || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
/** LAB_TINKER_KEEP_MAX: how many adapters may be kept at one time. Default 10, 0 to 40. */
export function tinkerKeepMax(): number {
  return wholeEnv('LAB_TINKER_KEEP_MAX', DEFAULT_TINKER_KEEP_MAX, 0, TINKER_HARD_KEEP_MAX)
}
/** LAB_TINKER_KEEP_DAYS: how long a kept adapter stays on Tinker from the day it is kept. Default 365, 30 to 3650. */
export function tinkerKeepDays(): number {
  return wholeEnv('LAB_TINKER_KEEP_DAYS', DEFAULT_TINKER_KEEP_DAYS, TINKER_MIN_KEEP_DAYS, TINKER_MAX_KEEP_DAYS)
}
/** LAB_TINKER_KEEP_MAX_MB: the most one exported copy may weigh. Default 1024, 1 to 4096. */
export function tinkerKeepMaxMb(): number {
  return wholeEnv('LAB_TINKER_KEEP_MAX_MB', DEFAULT_TINKER_KEEP_MAX_MB, 1, TINKER_HARD_KEEP_MAX_MB)
}

export interface TinkerBaseModels {
  /** The allowlist that applies. Empty when the variable is set but names no model the lab has a price for. */
  models: string[]
  /** How many entries were left out. */
  dropped: number
  unusable: boolean
}

/**
 * LAB_TINKER_BASE_MODELS, comma separated. The default applies only when it
 * is not set. A list that is set is never widened: an entry the lab has no
 * price for is left out, and if none is left the tool is off rather than
 * back on the default.
 */
export function tinkerBaseModels(): TinkerBaseModels {
  const raw = (process.env.LAB_TINKER_BASE_MODELS || '').trim()
  if (!raw) return { models: [...DEFAULT_TINKER_BASE_MODELS], dropped: 0, unusable: false }
  const entries = raw.split(',').map(s => s.trim()).filter(Boolean)
  const models = [...new Set(entries.filter(id => Object.hasOwn(TINKER_PRICES, id)))]
  return { models, dropped: entries.length - entries.filter(id => Object.hasOwn(TINKER_PRICES, id)).length, unusable: models.length === 0 }
}

export function tinkerRunUsd(): number {
  return usdEnv('LAB_TINKER_RUN_USD', DEFAULT_TINKER_RUN_USD, TINKER_HARD_RUN_USD)
}
export function tinkerDailyUsd(): number {
  return usdEnv('LAB_TINKER_DAILY_USD', DEFAULT_TINKER_DAILY_USD, TINKER_HARD_DAILY_USD)
}
export function tinkerChatDailyUsd(): number {
  return usdEnv('LAB_TINKER_CHAT_DAILY_USD', DEFAULT_TINKER_CHAT_DAILY_USD, TINKER_HARD_CHAT_DAILY_USD)
}

/** How long a saved adapter is kept on Tinker: LAB_TINKER_TTL_DAYS, default 14, 1 to 30. */
export function tinkerTtlDays(): number {
  const raw = (process.env.LAB_TINKER_TTL_DAYS || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 1 ? Math.min(n, TINKER_MAX_TTL_DAYS) : DEFAULT_TINKER_TTL_DAYS
}

/** How long the follow-up waits for a run before leaving it for a later tick to collect. */
export function tinkerWaitMs(): number {
  const n = Number((process.env.LAB_TINKER_POLL_MAX_MS || '').trim() || NaN)
  return Number.isFinite(n) && n > 0 ? Math.min(n, TINKER_MAX_WAIT_MS) : DEFAULT_TINKER_WAIT_MS
}

/** The runner's two HTTPS endpoints on Modal and the token they ask for. */
export function tinkerJobsConfigured(): boolean {
  return has('TINKER_JOBS_START_URL') && has('TINKER_JOBS_STATUS_URL') && has('TINKER_JOBS_TOKEN')
}

/** Is there a Tinker key on this server for sampling? Says only whether, never what. */
export function tinkerSamplingConfigured(): boolean {
  return has('TINKER_API_KEY')
}

export interface TinkerStatus {
  enabled: boolean
  /** Why it is off, for logs and docs; never shown to the models. */
  off_reason?: string
}

/** Is the training tool on? */
export function tinkerStatus(): TinkerStatus {
  if (!tinkerFlag()) return { enabled: false, off_reason: 'LAB_ENABLE_TINKER is not true' }
  if (!tinkerJobsConfigured()) return { enabled: false, off_reason: 'TINKER_JOBS_START_URL, TINKER_JOBS_STATUS_URL or TINKER_JOBS_TOKEN is not set' }
  if (tinkerBaseModels().unusable) return { enabled: false, off_reason: 'LAB_TINKER_BASE_MODELS is set but names no model the lab has a price for' }
  if (!(tinkerRunUsd() > 0) || !(tinkerDailyUsd() > 0)) return { enabled: false, off_reason: 'LAB_TINKER_RUN_USD or LAB_TINKER_DAILY_USD is 0' }
  return { enabled: true }
}

/**
 * May adapters be marked to keep? Keeping is done by the lab's runner on
 * Modal (it holds the Tinker key), so the runner must be configured. Training
 * need not be on: adapters trained earlier can still be kept.
 */
export function tinkerKeepStatus(): TinkerStatus {
  if (!tinkerKeepFlag()) return { enabled: false, off_reason: 'LAB_ENABLE_TINKER_KEEP is not true' }
  if (!tinkerJobsConfigured()) return { enabled: false, off_reason: 'TINKER_JOBS_START_URL, TINKER_JOBS_STATUS_URL or TINKER_JOBS_TOKEN is not set' }
  if (!(tinkerKeepMax() > 0)) return { enabled: false, off_reason: 'LAB_TINKER_KEEP_MAX is 0' }
  return { enabled: true }
}

/** May the lab model endpoint answer for trained adapters? (The endpoint itself must be on too.) */
export function liveTrainedStatus(): TinkerStatus {
  if (!liveTrainedFlag()) return { enabled: false, off_reason: 'LAB_ENABLE_LIVE_TRAINED is not true' }
  if (!tinkerSamplingConfigured()) return { enabled: false, off_reason: 'TINKER_API_KEY is not set on this server' }
  return { enabled: true }
}

/** Is the visitor chat on? */
export function trainedChatStatus(): TinkerStatus {
  if (!trainedChatFlag()) return { enabled: false, off_reason: 'LAB_ENABLE_TRAINED_CHAT is not true' }
  if (!tinkerSamplingConfigured()) return { enabled: false, off_reason: 'TINKER_API_KEY is not set on this server' }
  if (!(tinkerChatDailyUsd() > 0)) return { enabled: false, off_reason: 'LAB_TINKER_CHAT_DAILY_USD is 0' }
  return { enabled: true }
}

// ---------------------------------------------------------------------------
// What a model may ask for
// ---------------------------------------------------------------------------

export type TinkerRole = 'system' | 'user' | 'assistant'
export interface TinkerMessage { role: TinkerRole; content: string }
export interface TinkerExample { messages: TinkerMessage[] }
export interface TinkerSettings { rank: number; learning_rate: number; epochs: number; batch_size: number }

export interface TinkerRequest {
  purpose: string
  base_model: string
  examples: TinkerExample[]
  settings: TinkerSettings
  /** SHA-256 of the examples exactly as the lab read them (JSON, in order). */
  dataset_sha256: string
  dataset_bytes: number
  /** A display name for the adapter, when names are on and the model gave a usable one (tinker-names.ts). */
  name?: string
  /** Why the name the model gave was refused. The run goes on without a name. */
  name_refused?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(o).find(k => !allowed.includes(k))
  return extra === undefined ? null : extra.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_'
}
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function readExample(raw: unknown, i: number): { example: TinkerExample; bytes: number } | { error: string } {
  const where = `examples[${i}]`
  if (!isPlainObject(raw)) return { error: `${where} is not an object with "messages"` }
  const extra = onlyKeys(raw, ['messages'])
  if (extra) return { error: `${where} has a field that is not "messages": ${extra}` }
  const list = raw.messages
  if (!Array.isArray(list) || list.length < 2 || list.length > TINKER_MAX_MESSAGES) {
    return { error: `${where}: "messages" must hold 2 to ${TINKER_MAX_MESSAGES} messages` }
  }
  const messages: TinkerMessage[] = []
  let bytes = 0
  for (const [j, m] of list.entries()) {
    if (!isPlainObject(m) || onlyKeys(m, ['role', 'content'])) return { error: `${where}.messages[${j}] must be { "role", "content" } and nothing else` }
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') return { error: `${where}.messages[${j}]: role must be system, user or assistant` }
    if (typeof m.content !== 'string' || !m.content.trim()) return { error: `${where}.messages[${j}]: content must be non-empty text` }
    if (FORBIDDEN_CHARS.test(m.content) || LONE_SURROGATE.test(m.content)) return { error: `${where}.messages[${j}]: content holds a control character or broken text` }
    bytes += Buffer.byteLength(m.content, 'utf8')
    messages.push({ role: m.role, content: m.content })
  }
  // An optional system message first, then user and assistant in turn, ending on the assistant.
  const turns = messages[0].role === 'system' ? messages.slice(1) : messages
  if (turns.length < 2 || turns.length % 2 !== 0 || turns.some((m, k) => m.role !== (k % 2 === 0 ? 'user' : 'assistant'))) {
    return { error: `${where}: after an optional system message, messages must alternate user, assistant and end with the assistant` }
  }
  if (bytes > TINKER_MAX_EXAMPLE_BYTES) return { error: `${where} holds more than ${TINKER_MAX_EXAMPLE_BYTES} bytes of text` }
  return { example: { messages }, bytes }
}

function readSettings(raw: unknown): { settings: TinkerSettings } | { error: string } {
  const s = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(s)) return { error: 'settings is not an object' }
  const extra = onlyKeys(s, ['rank', 'learning_rate', 'epochs', 'batch_size'])
  if (extra) return { error: `settings has an unknown field: ${extra}` }
  const rank = s.rank === undefined ? TINKER_DEFAULT_RANK : s.rank
  if (!(TINKER_RANKS as readonly unknown[]).includes(rank)) return { error: `settings.rank must be one of ${TINKER_RANKS.join(', ')}` }
  const lr = s.learning_rate === undefined ? TINKER_LEARNING_RATE.fallback : s.learning_rate
  if (typeof lr !== 'number' || !Number.isFinite(lr) || lr < TINKER_LEARNING_RATE.min || lr > TINKER_LEARNING_RATE.max) {
    return { error: `settings.learning_rate must be a number from ${TINKER_LEARNING_RATE.min} to ${TINKER_LEARNING_RATE.max}` }
  }
  const epochs = s.epochs === undefined ? TINKER_EPOCHS.fallback : s.epochs
  if (typeof epochs !== 'number' || !Number.isInteger(epochs) || epochs < TINKER_EPOCHS.min || epochs > TINKER_EPOCHS.max) {
    return { error: `settings.epochs must be a whole number from ${TINKER_EPOCHS.min} to ${TINKER_EPOCHS.max}` }
  }
  const batch = s.batch_size === undefined ? TINKER_BATCH_SIZE.fallback : s.batch_size
  if (typeof batch !== 'number' || !Number.isInteger(batch) || batch < TINKER_BATCH_SIZE.min || batch > TINKER_BATCH_SIZE.max) {
    return { error: `settings.batch_size must be a whole number from ${TINKER_BATCH_SIZE.min} to ${TINKER_BATCH_SIZE.max}` }
  }
  return { settings: { rank: rank as number, learning_rate: lr, epochs, batch_size: batch } }
}

/** How many examples the lab holds out of a dataset of `n`. */
export function holdoutCount(n: number): number {
  return Math.min(TINKER_HOLDOUT_MAX, Math.max(TINKER_HOLDOUT_MIN, Math.ceil(n * TINKER_HOLDOUT_FRACTION)))
}

/** Optimizer steps a run of `n` examples takes with these settings. */
export function plannedSteps(n: number, settings: Pick<TinkerSettings, 'epochs' | 'batch_size'>): number {
  return Math.ceil((n - holdoutCount(n)) / settings.batch_size) * settings.epochs
}

/**
 * Reads what the Executor wrote under "tinker_train". Strict: any field the
 * lab does not know, any value out of range and any malformed example is a
 * refusal with a reason, never a guess. Nothing is cut to fit.
 */
export function normalizeTinkerRequest(raw: unknown, allowed: string[] = tinkerBaseModels().models): { request: TinkerRequest } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'not an object with "examples"' }
  // "name" is a field only while names are on. While they are off it is an
  // unknown field like any other, and refuses the request as it always did.
  const names = tinkerNamesFlag()
  const extra = onlyKeys(raw, names ? ['purpose', 'base_model', 'examples', 'settings', 'name'] : ['purpose', 'base_model', 'examples', 'settings'])
  if (extra) return { error: `unknown field: ${extra}` }
  if (!allowed.length) return { error: 'no base model is allowed' }
  const base = raw.base_model === undefined || raw.base_model === null || raw.base_model === '' ? allowed[0] : raw.base_model
  if (typeof base !== 'string' || !allowed.includes(base)) return { error: `base_model must be one of: ${allowed.join(', ')}` }
  const checked = readSettings(raw.settings)
  if ('error' in checked) return checked
  const list = raw.examples
  if (!Array.isArray(list)) return { error: 'examples is not a list' }
  if (list.length < TINKER_MIN_EXAMPLES || list.length > TINKER_MAX_EXAMPLES) {
    return { error: `examples must hold ${TINKER_MIN_EXAMPLES} to ${TINKER_MAX_EXAMPLES} conversations (it holds ${list.length})` }
  }
  const examples: TinkerExample[] = []
  const seen = new Map<string, number>()
  let bytes = 0
  for (const [i, item] of list.entries()) {
    const read = readExample(item, i)
    if ('error' in read) return read
    // A copy could land on both sides of the held-out split and make the score look better than it is.
    const key = createHash('sha256').update(JSON.stringify(read.example.messages), 'utf8').digest('hex')
    const first = seen.get(key)
    if (first !== undefined) return { error: `examples[${i}] is the same as examples[${first}]: every example must be different` }
    seen.set(key, i)
    bytes += read.bytes
    if (bytes > TINKER_MAX_DATASET_BYTES) return { error: `the dataset holds more than ${TINKER_MAX_DATASET_BYTES} bytes of text` }
    examples.push(read.example)
  }
  const steps = plannedSteps(examples.length, checked.settings)
  if (steps > TINKER_MAX_STEPS) {
    return { error: `these settings need ${steps} optimizer steps and a run may take ${TINKER_MAX_STEPS}: raise batch_size or lower epochs` }
  }
  const purpose = typeof raw.purpose === 'string' ? raw.purpose.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  // The name is optional and never decides the run: a name that is refused
  // is left off, with the reason, and the request stands.
  const named = names && raw.name !== undefined && raw.name !== null && raw.name !== '' ? readAdapterName(raw.name) : null
  return {
    request: {
      purpose, base_model: base, examples, settings: checked.settings,
      dataset_sha256: createHash('sha256').update(JSON.stringify(examples), 'utf8').digest('hex'),
      dataset_bytes: bytes,
      ...(named && 'name' in named ? { name: named.name } : {}),
      ...(named && 'error' in named ? { name_refused: named.error } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Cost: the estimate before, the measured tokens after
// ---------------------------------------------------------------------------

/** Tokens the lab assumes an example takes, before anything has been tokenized. */
export function estimateExampleTokens(example: TinkerExample): number {
  let tokens = TINKER_TOKENS_PER_EXAMPLE
  for (const m of example.messages) tokens += Math.ceil(Buffer.byteLength(m.content, 'utf8') / TINKER_BYTES_PER_TOKEN) + TINKER_TOKENS_PER_MESSAGE
  return tokens
}

export interface TinkerEstimate {
  examples: number
  holdout: number
  steps: number
  /** Assumed tokens in the whole dataset. */
  dataset_tokens: number
  /** Token passes billed at the train price: every epoch over the dataset, and two passes over the held-out slice. */
  train_token_passes: number
  eval_token_passes: number
  /** The most the run could cost at the published prices, margin included. This is what is set aside. */
  max_cost_usd: number
}

/**
 * The most a run could cost, from the text alone: a token for every byte,
 * which no text can exceed. Training is counted over the whole dataset for
 * every epoch (the held-out slice is not trained on, so this is a little
 * high), the two measurements over the largest examples the slice could
 * hold, and the samples at their longest. Prose takes a fifth to a third
 * of this, so a run usually settles well under what was set aside. The
 * runner counts real tokens and would still refuse a plan that cost more
 * than this, so the amount set aside is a ceiling on what is spent either way.
 */
export function estimateTinkerRun(request: Pick<TinkerRequest, 'base_model' | 'examples' | 'settings'>): TinkerEstimate {
  const price = TINKER_PRICES[request.base_model]
  const sizes = request.examples.map(estimateExampleTokens).sort((a, b) => b - a)
  const n = sizes.length
  const holdout = holdoutCount(n)
  const dataset = sizes.reduce((a, b) => a + b, 0)
  const largestHeldOut = sizes.slice(0, holdout).reduce((a, b) => a + b, 0)
  const train = dataset * request.settings.epochs
  const evals = 2 * largestHeldOut
  const sampling = TINKER_SAMPLE_COUNT * ((sizes[0] ?? 0) * price.prefill + TINKER_SAMPLE_MAX_TOKENS * price.sample)
  const usd = TINKER_ESTIMATE_MARGIN * ((train + evals) * price.train + sampling) / 1e6
  return {
    examples: n, holdout, steps: plannedSteps(n, request.settings), dataset_tokens: dataset,
    train_token_passes: train, eval_token_passes: evals,
    max_cost_usd: Math.ceil(usd * 1e6) / 1e6,
  }
}

/** A dollar amount in words: two decimals, or four when it is under a cent, so a small estimate does not read as nothing. */
export function usdText(amount: number): string {
  return amount > 0 && amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`
}

/** Tokens the runner counted while it worked. */
export interface TinkerTokens {
  train: number
  eval: number
  sample_prompt: number
  sample_completion: number
}

/** What those tokens cost at the published prices. An estimate, never a bill. */
export function tinkerCostUsd(baseModel: string, tokens: TinkerTokens): number {
  const price = TINKER_PRICES[baseModel]
  if (!price) return 0
  return ((tokens.train + tokens.eval) * price.train + tokens.sample_prompt * price.prefill + tokens.sample_completion * price.sample) / 1e6
}

/** What one chat call cost at the published prices: prompt tokens at the prefill price, the answer at the sample price. */
export function tinkerChatCostUsd(baseModel: string, promptTokens: number, completionTokens: number): number {
  return tinkerCostUsd(baseModel, { train: 0, eval: 0, sample_prompt: Math.max(0, promptTokens), sample_completion: Math.max(0, completionTokens) })
}

/**
 * The most one chat call could cost, set aside before it is sent: one token
 * for every byte of the messages (no tokenizer makes more), some for the
 * chat format, and the whole answer limit.
 */
export function tinkerChatWorstCaseUsd(baseModel: string, messages: Array<{ content: unknown }>, maxTokens: number): number {
  let promptTokens = 64
  for (const m of messages) promptTokens += Buffer.byteLength(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''), 'utf8') + TINKER_TOKENS_PER_MESSAGE
  return Math.ceil(tinkerChatCostUsd(baseModel, promptTokens, maxTokens) * 1e6) / 1e6
}

// ---------------------------------------------------------------------------
// What the runner sends back
// ---------------------------------------------------------------------------

/** A checkpoint saved for sampling, as Tinker names it. */
export const SAMPLER_PATH = /^tinker:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\/sampler_weights\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/

export function isSamplerPath(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 320 && SAMPLER_PATH.test(v)
}

/** Weights saved for use outside Tinker, as Tinker names them. Only these can be downloaded. */
export const EXTERNAL_PATH = /^tinker:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\/external_weights\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/

export function isExternalPath(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 320 && EXTERNAL_PATH.test(v)
}

export interface TinkerSample { prompt: string; completion: string }

export interface TinkerRunResult {
  /** ok: trained, measured and saved. refused: the runner said no before training. error: it failed part way. failed: no usable answer. */
  status: 'ok' | 'refused' | 'error' | 'failed'
  stage: string | null
  reason: string | null
  n_train: number | null
  n_holdout: number | null
  steps_planned: number | null
  steps_done: number | null
  stopped_early: string | null
  /** Mean cross-entropy per trained token on the held-out slice, measured by the runner before and after training. */
  holdout_loss_before: number | null
  holdout_loss_after: number | null
  train_loss_first: number | null
  train_loss_last: number | null
  tokens: TinkerTokens
  sampler_path: string | null
  ttl_seconds: number | null
  samples: TinkerSample[]
  wall_seconds: number | null
  /** The weights saved for download, when the lab asked the runner for them (adapters can be kept) and the save worked. */
  external_path?: string
  /** Why they were not saved, when the lab asked and the save failed. The run stands; the adapter can have no copy. */
  export_error?: string
}

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const short = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * Reads the runner's answer. An "ok" that carries no well-formed sampler
 * path and no held-out measurement is not an ok. Token counts are read
 * whatever the status, because a run that failed part way still used some.
 */
export function normalizeTinkerResult(raw: unknown): TinkerRunResult {
  const r = isPlainObject(raw) ? raw : {}
  const t = isPlainObject(r.tokens) ? r.tokens : {}
  const base: TinkerRunResult = {
    status: 'failed', stage: short(r.stage, 30) || null, reason: null,
    n_train: count(r.n_train), n_holdout: count(r.n_holdout), steps_planned: count(r.steps_planned), steps_done: count(r.steps_done),
    stopped_early: short(r.stopped_early, 200) || null,
    holdout_loss_before: finite(r.holdout_loss_before), holdout_loss_after: finite(r.holdout_loss_after),
    train_loss_first: finite(r.train_loss_first), train_loss_last: finite(r.train_loss_last),
    tokens: { train: count(t.train) ?? 0, eval: count(t.eval) ?? 0, sample_prompt: count(t.sample_prompt) ?? 0, sample_completion: count(t.sample_completion) ?? 0 },
    sampler_path: null, ttl_seconds: count(r.ttl_seconds),
    samples: [], wall_seconds: finite(r.wall_seconds),
  }
  if (r.status === 'refused') return { ...base, status: 'refused', reason: short(r.reason, 400) || 'refused' }
  if (r.status === 'error') return { ...base, status: 'error', reason: short(r.error, 400) || short(r.reason, 400) || 'the runner failed' }
  if (r.status !== 'ok') return { ...base, reason: 'the runner gave no usable answer' }
  if (!isSamplerPath(r.sampler_path) || base.holdout_loss_before === null || base.holdout_loss_after === null) {
    return { ...base, reason: 'the runner\'s answer had no saved adapter or no held-out measurement' }
  }
  const samples: TinkerSample[] = []
  for (const s of Array.isArray(r.samples) ? r.samples.slice(0, TINKER_SAMPLE_COUNT) : []) {
    if (!isPlainObject(s)) continue
    const prompt = short(s.prompt, 300)
    const completion = short(s.completion, 600)
    if (prompt) samples.push({ prompt, completion })
  }
  return {
    ...base, status: 'ok', sampler_path: r.sampler_path, samples,
    ...(isExternalPath(r.external_path) ? { external_path: r.external_path } : {}),
    ...(!isExternalPath(r.external_path) && short(r.export_error, 200) ? { export_error: short(r.export_error, 200) } : {}),
  }
}

/** One line for the stored record and the next epoch's context. Says what was measured, by whom, and that the cost is an estimate. */
export function describeTinkerRun(r: TinkerRunResult, baseModel: string, slug: string | null, costUsd: number, expiresAt: string | null, name: string | null = null): string {
  const cost = `estimated cost $${costUsd.toFixed(4)} (token counts at Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}, not a billed amount)`
  if (r.status === 'ok') {
    const loss = `LAB-MEASURED held-out loss ${r.holdout_loss_before!.toFixed(4)} before training, ${r.holdout_loss_after!.toFixed(4)} after, on ${r.n_holdout ?? '?'} examples the lab held out`
    const steps = `${r.steps_done ?? '?'} of ${r.steps_planned ?? '?'} steps${r.stopped_early ? ` (stopped early: ${r.stopped_early})` : ''}`
    const adapter = slug ? `adapter lab/${slug}${name ? ` named "${name}"` : ''} on ${baseModel}${expiresAt ? `, kept until ${expiresAt.slice(0, 10)}` : ''}` : `adapter on ${baseModel}`
    return `${loss}; ${steps}; ${adapter}; ${cost}`
  }
  if (r.status === 'refused') return `refused by the runner${r.stage ? ` (${r.stage})` : ''}: ${r.reason}; ${cost}`
  return `${r.status}${r.stage ? ` at ${r.stage}` : ''}: ${r.reason || 'unknown'}; ${cost}`
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The model id prefix of the lab's own adapters on the lab model endpoint. */
export const LAB_ADAPTER_PREFIX = 'lab/'
const SLUG = /^e[0-9]{1,6}-[0-9a-f]{8}$/

export function isAdapterSlug(v: unknown): v is string {
  return typeof v === 'string' && SLUG.test(v)
}

/** A name for a run's adapter: the epoch and eight random hex characters. */
export function newAdapterSlug(epoch: number): string {
  return `e${Math.max(0, Math.min(999_999, Math.trunc(epoch)))}-${randomBytes(4).toString('hex')}`
}

/** The secret-free value the runner mixes into its split, new for every run, so a model cannot know which examples are held out. */
export function newSplitSalt(): string {
  return randomBytes(16).toString('hex')
}

// ---------------------------------------------------------------------------
// What the models are told
// ---------------------------------------------------------------------------

/**
 * One paragraph about the tool, only while it is on (the callers check). It
 * says what the tool does and where its limits are, and nothing about what
 * to train. `liveTrained` adds the fact that kept adapters answer on the lab
 * model endpoint.
 */
export function tinkerNote(opts: { perDay: number; liveTrained: boolean; names?: boolean; keep?: boolean }): string {
  const models = tinkerBaseModels().models.join(', ')
  const named = opts.names
    ? ` You may give the adapter a display name with "name": ${ADAPTER_NAME_MIN} to ${ADAPTER_NAME_MAX} characters, only letters, digits, spaces, hyphens, apostrophes and dots. The name is a label shown beside the adapter's lab id; the lab id stays its identity. A name that another adapter still alive has, that looks like a web address, or that reads like a real model or product name is refused with the reason stored, and the run goes on without a name.`
    : ''
  // With the two switches off these two sentences are word for word what
  // they always were. While adapters can be marked kept, "kept" means that
  // and nothing else, so an adapter that has not expired is called alive;
  // while adapters can be named, "name" means the display name, so the
  // address is called the lab id.
  const live = opts.liveTrained
    ? ` While an adapter is ${opts.keep ? 'alive' : 'kept'}, the lab model endpoint also answers for it as the model "lab/<${opts.names ? 'id' : 'name'}>", with the ${opts.names ? 'lab id' : 'name'} from the run's record: text messages only, no tools.`
    : ''
  const expires = opts.keep
    ? `The adapter stays for ${tinkerTtlDays()} days and then expires, unless it is marked kept.`
    : `The adapter is kept for ${tinkerTtlDays()} days and then expires.`
  return `Tinker training: as Executor you may ask for one LoRA fine-tuning run of an open-weight model on Tinker, a training service. LoRA only: the base model's own weights are not changed. The base model is one of: ${models}. You write the training data into your answer as chat conversations: ${TINKER_MIN_EXAMPLES} to ${TINKER_MAX_EXAMPLES} different examples, each 2 to ${TINKER_MAX_MESSAGES} messages (an optional system message, then user and assistant in turn, ending with the assistant), at most ${TINKER_MAX_EXAMPLE_BYTES} bytes of text in one example and ${TINKER_MAX_DATASET_BYTES} in all. Only the last assistant message of each example is trained on. Settings are bounded: rank ${TINKER_RANKS.join(', ')}; learning_rate ${TINKER_LEARNING_RATE.min} to ${TINKER_LEARNING_RATE.max}; epochs ${TINKER_EPOCHS.min} to ${TINKER_EPOCHS.max}; batch_size ${TINKER_BATCH_SIZE.min} to ${TINKER_BATCH_SIZE.max}; at most ${TINKER_MAX_STEPS} optimizer steps. A request that breaks any of this is refused whole, with the reason stored. The run needs the Reviewer's approval and happens after the epoch, run by the lab's own code: your answer supplies data and settings and no code. The lab estimates the most the run could cost before it starts and refuses it above $${tinkerRunUsd().toFixed(2)} a run or $${tinkerDailyUsd().toFixed(2)} of Tinker use a day (UTC), at most ${opts.perDay} run${opts.perDay === 1 ? '' : 's'} a day, inside the lab's daily spending cap. Costs are estimates from Tinker's published prices, because Tinker reports no cost per call. The lab holds out about a tenth of the examples, chosen by the lab after the request so that you cannot know which, and measures the loss on them before and after training: that score is measured by the lab, not reported by you. A few completions on held-out prompts are sampled and stored. The dataset's size and hash, the settings, both scores, the samples and the adapter's name are public. ${expires}${live}${named}`
}
