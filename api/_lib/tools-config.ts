/**
 * The tool menu: which tools the Executor may choose this epoch, and their
 * limits. One function reads the environment, and both the runner and the
 * prompts use it, so the models are only ever told about what is really on.
 *
 * Every tool is off unless its flag is "true" AND what it needs is
 * configured. Limits are per epoch (hard constants) and per UTC day (env,
 * clamped). All spending also counts against LAB_DAILY_BUDGET_USD.
 *
 * The lab model endpoint (LAB_ENABLE_LIVE_MODEL) is reported here too, as
 * liveModelToolStatus: it is part of a Sprite session, not a tool of its own.
 * Tinker training (LAB_ENABLE_TINKER) is a tool; its settings and dollar
 * caps live in tinker.ts. Keeping a trained adapter (LAB_ENABLE_TINKER_KEEP)
 * is a tool too; how many may be kept is in tinker.ts. Public datasets
 * (LAB_ENABLE_DATASETS) are a tool with their own Modal app; their limits
 * are in datasets.ts.
 */
import { spritesConfigured } from './sprites.js'
import { liveModelStatus, type LiveModelStatus } from './live-model.js'
import { liveTrainedStatus, tinkerKeepStatus, tinkerStatus } from './tinker.js'
import { tinkerRlPerDay, tinkerRlStatus } from './tinker-rl.js'

export const TOOL_NAMES = ['subagents', 'sprite_session', 'gpu_job', 'weights', 'exhibit', 'lab_proposal', 'tinker_train', 'tinker_rl', 'keep_adapter', 'datasets'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** Per-epoch limits. Not tunable: one of each kind per epoch at most. */
export const PER_EPOCH = {
  explorers: 2,           // explorer subagents for the epoch's contribution
  sprite_sessions: 1,
  sprite_commands: 4,     // commands in that one session
  gpu_jobs: 1,
  weights: 1,             // public weights fetched for GPU jobs
  exhibits: 1,
  lab_proposals: 1,
  tinker_runs: 1,         // LoRA fine-tuning runs on Tinker
  tinker_rl_runs: 1,      // reinforcement-learning runs on Tinker (an epoch has one run of either kind)
  adapter_keeps: 1,       // requests to keep a trained adapter
  datasets: 1,            // public datasets fetched onto the lab's shelf
} as const

/** Sprite session limits. */
export const SPRITE_COMMAND_MAX_S = 120
export const SPRITE_COMMAND_DEFAULT_S = 60
export const SPRITE_SESSION_TOTAL_MAX_S = 240
export const SPRITE_COMMAND_MAX_CHARS = 600

/** GPU job limits (the Modal side enforces the same 120 s). */
export const GPU_JOB_MAX_S = 120
export const GPU_JOB_SCRIPT_MAX_CHARS = 20_000

/**
 * Cost estimates. Sprites and Modal bill by time; neither bill is read back
 * here, so the lab records an estimate from measured duration.
 * - Modal A10G: $0.000306 per second was Modal's published A10G rate when
 *   this was written. The whole job time is billed at it (the controller
 *   holds no GPU, so this overestimates a little).
 * - Sprites: $1.30 per hour of command time is a placeholder chosen to be on
 *   the high side, not a published price. Set it from the current price list.
 */
export const DEFAULT_MODAL_GPU_USD_PER_SECOND = 0.000306
export const DEFAULT_SPRITE_USD_PER_HOUR = 1.3

function flag(name: string): boolean {
  return (process.env[name] || '').trim().toLowerCase() === 'true'
}
function has(name: string): boolean {
  return Boolean((process.env[name] || '').trim())
}
function intEnv(name: string, fallback: number, lo: number, hi: number): number {
  const raw = (process.env[name] || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
function rateEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** The licenses a repository of public weights may state when LAB_WEIGHTS_LICENSES is not set. */
export const DEFAULT_WEIGHTS_LICENSES = ['apache-2.0', 'mit', 'bsd-3-clause', 'bsd-2-clause', 'cc-by-4.0'] as const
const LICENSE_ID = /^[a-z0-9][a-z0-9.+-]{0,39}$/

export interface WeightsLicenses {
  /** The list that applies. Empty when the variable is set but names no license id. */
  licenses: string[]
  /** How many entries were left out because they are not license ids. */
  dropped: number
  /** The variable is set and nothing in it is a license id: public weights stay off. */
  unusable: boolean
}

/**
 * LAB_WEIGHTS_LICENSES, comma separated. The defaults apply only when it is
 * not set. A list that is set is never widened: an entry that is not a
 * license id (as Hugging Face writes them, like apache-2.0) is left out, and
 * if none is left, public weights are off rather than back on the defaults.
 */
export function weightsLicenses(): WeightsLicenses {
  const raw = (process.env.LAB_WEIGHTS_LICENSES || '').trim()
  if (!raw) return { licenses: [...DEFAULT_WEIGHTS_LICENSES], dropped: 0, unusable: false }
  const entries = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const licenses = [...new Set(entries.filter(s => LICENSE_ID.test(s)))].sort()
  return { licenses, dropped: entries.length - entries.filter(s => LICENSE_ID.test(s)).length, unusable: licenses.length === 0 }
}

/** The licenses a public dataset may state when LAB_DATASETS_LICENSES is not set. */
export const DEFAULT_DATASETS_LICENSES = ['apache-2.0', 'mit', 'cc-by-4.0', 'cc-by-sa-4.0', 'cc0-1.0', 'odc-by', 'bsd-3-clause'] as const

/**
 * LAB_DATASETS_LICENSES, comma separated, read the same way as the weights
 * list: the defaults apply only when it is not set, and a list that is set
 * is never widened. If nothing in it is a license id, public datasets are off.
 */
export function datasetsLicenses(): WeightsLicenses {
  const raw = (process.env.LAB_DATASETS_LICENSES || '').trim()
  if (!raw) return { licenses: [...DEFAULT_DATASETS_LICENSES], dropped: 0, unusable: false }
  const entries = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const licenses = [...new Set(entries.filter(s => LICENSE_ID.test(s)))].sort()
  return { licenses, dropped: entries.length - entries.filter(s => LICENSE_ID.test(s)).length, unusable: licenses.length === 0 }
}

let datasetLicensesWarnedFor: string | null = null
function warnAboutDatasetLicenses(found: WeightsLicenses): void {
  const raw = process.env.LAB_DATASETS_LICENSES || ''
  if (!found.dropped || datasetLicensesWarnedFor === raw) return
  datasetLicensesWarnedFor = raw
  console.warn(found.unusable
    ? '[Tools] LAB_DATASETS_LICENSES is set but names no license id (write them like apache-2.0,mit); public datasets stay off'
    : `[Tools] LAB_DATASETS_LICENSES: ${found.dropped} entr${found.dropped === 1 ? 'y is not a license id and was' : 'ies are not license ids and were'} left out; ${found.licenses.length} license${found.licenses.length === 1 ? '' : 's'} allowed`)
}

/** The dataset shelf's two HTTPS endpoints on Modal (modal/datasets.py) and the token they ask for. */
export function datasetsAppConfigured(): boolean {
  return has('DATASETS_START_URL') && has('DATASETS_STATUS_URL') && has('DATASETS_TOKEN')
}

// Said once per value, and only while the switch is on, so the logs show a
// list that was narrowed or refused without a line on every epoch. The
// entries themselves are not printed.
let licensesWarnedFor: string | null = null
function warnAboutLicenses(found: WeightsLicenses): void {
  const raw = process.env.LAB_WEIGHTS_LICENSES || ''
  if (!found.dropped || licensesWarnedFor === raw) return
  licensesWarnedFor = raw
  console.warn(found.unusable
    ? '[Tools] LAB_WEIGHTS_LICENSES is set but names no license id (write them like apache-2.0,mit); public weights stay off'
    : `[Tools] LAB_WEIGHTS_LICENSES: ${found.dropped} entr${found.dropped === 1 ? 'y is not a license id and was' : 'ies are not license ids and were'} left out; ${found.licenses.length} license${found.licenses.length === 1 ? '' : 's'} allowed`)
}

// Tinker RL is on unless it is switched off, so when it is on and something it needs is missing the logs
// say why, once per reason. Switched off on purpose is not worth a line.
let rlWarnedFor: string | null = null
function warnAboutRl(status: { enabled: boolean; off_reason?: string }): void {
  if (status.enabled || !status.off_reason || status.off_reason.startsWith('LAB_ENABLE_TINKER_RL') || rlWarnedFor === status.off_reason) return
  rlWarnedFor = status.off_reason
  console.warn(`[Tools] Tinker RL is on by default and is off here: ${status.off_reason}`)
}

export function modalGpuUsdPerSecond(): number {
  return rateEnv('LAB_MODAL_GPU_USD_PER_SECOND', DEFAULT_MODAL_GPU_USD_PER_SECOND)
}
export function spriteUsdPerHour(): number {
  return rateEnv('LAB_SPRITE_USD_PER_HOUR', DEFAULT_SPRITE_USD_PER_HOUR)
}

export interface ToolStatus {
  enabled: boolean
  /** Why it is off, for logs and docs; never shown to the models. */
  off_reason?: string
  per_day: number
}

export type ToolConfig = Record<ToolName, ToolStatus>

function status(enabled: boolean, offReason: string, perDay: number): ToolStatus {
  return enabled ? { enabled, per_day: perDay } : { enabled, off_reason: offReason, per_day: perDay }
}

export function codeWritesEnabled(): boolean {
  return flag('LAB_ENABLE_CODE_WRITES')
}

/** What is on right now. Read on every call: env changes take effect on the next epoch. */
export function toolConfig(): ToolConfig {
  const code = codeWritesEnabled()
  const ci = has('LAB_REQUIRED_CI_WORKFLOW_IDS') && has('AI_AGENT_GITHUB_TOKEN') && has('AI_AGENT_GITHUB_OWNER')
  const gpuJobs = flag('LAB_ENABLE_GPU_JOBS') && has('GPU_JOBS_START_URL') && has('GPU_JOBS_STATUS_URL') && has('GPU_JOBS_TOKEN')
  const licenses = weightsLicenses()
  if (flag('LAB_ENABLE_WEIGHTS')) warnAboutLicenses(licenses)
  const tinker = tinkerStatus()
  const rl = tinkerRlStatus()
  warnAboutRl(rl)
  const keep = tinkerKeepStatus()
  // Public datasets (datasets.ts). A dataset on the shelf is read by a GPU job
  // or by a Tinker training run, so with neither on there is nothing to use
  // it with and the tool stays off.
  const datasetsFlag = flag('LAB_ENABLE_DATASETS')
  const datasetLicenses = datasetsLicenses()
  if (datasetsFlag) warnAboutDatasetLicenses(datasetLicenses)
  const datasetUsers = gpuJobs || tinker.enabled
  return {
    subagents: status(code, 'LAB_ENABLE_CODE_WRITES is not true', intEnv('LAB_SUBAGENTS_PER_DAY', 24, 0, 200)),
    sprite_session: status(
      flag('LAB_ENABLE_SPRITE_SESSIONS') && spritesConfigured(),
      !flag('LAB_ENABLE_SPRITE_SESSIONS') ? 'LAB_ENABLE_SPRITE_SESSIONS is not true' : 'SPRITES_TOKEN is not set',
      intEnv('LAB_SPRITE_SESSIONS_PER_DAY', 8, 0, 100),
    ),
    gpu_job: status(
      gpuJobs,
      !flag('LAB_ENABLE_GPU_JOBS') ? 'LAB_ENABLE_GPU_JOBS is not true' : 'GPU_JOBS_START_URL, GPU_JOBS_STATUS_URL or GPU_JOBS_TOKEN is not set',
      intEnv('LAB_GPU_JOBS_PER_DAY', 4, 0, 50),
    ),
    // Public weights are only for GPU jobs, and are fetched by the same Modal app.
    // A license list with nothing usable in it turns them off: it must never
    // quietly mean the default list.
    weights: status(
      flag('LAB_ENABLE_WEIGHTS') && gpuJobs && !licenses.unusable,
      !flag('LAB_ENABLE_WEIGHTS') ? 'LAB_ENABLE_WEIGHTS is not true'
        : !gpuJobs ? 'GPU jobs are off' : 'LAB_WEIGHTS_LICENSES is set but names no license id',
      intEnv('LAB_WEIGHTS_PER_DAY', 2, 0, 20),
    ),
    exhibit: status(
      flag('LAB_ENABLE_EXHIBITS') && code && ci,
      !flag('LAB_ENABLE_EXHIBITS') ? 'LAB_ENABLE_EXHIBITS is not true'
        : !code ? 'LAB_ENABLE_CODE_WRITES is not true' : 'the AI-Agent token, owner or CI workflow ids are not set',
      intEnv('LAB_EXHIBITS_PER_DAY', 2, 0, 20),
    ),
    lab_proposal: status(
      flag('LAB_ENABLE_LAB_PROPOSALS') && has('LAB_PROPOSALS_GITHUB_TOKEN') && has('LAB_PROPOSALS_GITHUB_OWNER'),
      !flag('LAB_ENABLE_LAB_PROPOSALS') ? 'LAB_ENABLE_LAB_PROPOSALS is not true' : 'LAB_PROPOSALS_GITHUB_TOKEN or LAB_PROPOSALS_GITHUB_OWNER is not set',
      intEnv('LAB_LAB_PROPOSALS_PER_DAY', 1, 0, 5),
    ),
    // Tinker training (tinker.ts): a fine-tuning run by the lab's own runner
    // on Modal. Its dollar caps are separate settings; this is the count.
    tinker_train: status(tinker.enabled, tinker.off_reason ?? '', intEnv('LAB_TINKER_PER_DAY', 2, 0, 10)),
    // Tinker RL (tinker-rl.ts): on by default, through the same runner. The count is its own.
    tinker_rl: status(rl.enabled, rl.off_reason ?? '', tinkerRlPerDay()),
    // Keeping a trained adapter (tinker-keep.ts). How many may be kept at one
    // time is LAB_TINKER_KEEP_MAX; this is how many requests a day may be run.
    keep_adapter: status(keep.enabled, keep.off_reason ?? '', intEnv('LAB_TINKER_KEEPS_PER_DAY', 2, 0, 10)),
    datasets: status(
      datasetsFlag && datasetsAppConfigured() && !datasetLicenses.unusable && datasetUsers,
      !datasetsFlag ? 'LAB_ENABLE_DATASETS is not true'
        : !datasetsAppConfigured() ? 'DATASETS_START_URL, DATASETS_STATUS_URL or DATASETS_TOKEN is not set'
          : datasetLicenses.unusable ? 'LAB_DATASETS_LICENSES is set but names no license id'
            : 'neither GPU jobs nor Tinker training is on, so nothing could read a dataset',
      intEnv('LAB_DATASETS_PER_DAY', 2, 0, 20),
    ),
  }
}

/**
 * The lab model endpoint (live-model.ts). It is not a tool the Executor asks
 * for: it is something a Sprite session comes with when it is on, so it
 * needs LAB_ENABLE_LIVE_MODEL and its own settings AND Sprite sessions.
 */
export function liveModelToolStatus(config: ToolConfig = toolConfig()): LiveModelStatus {
  const own = liveModelStatus()
  if (!own.enabled) return own
  if (!config.sprite_session.enabled || config.sprite_session.per_day <= 0) {
    return { enabled: false, off_reason: `Sprite sessions are off (${config.sprite_session.off_reason ?? 'daily limit is 0'})` }
  }
  return { enabled: true }
}

/**
 * Trained adapters on the lab model endpoint ("lab/<name>", live-trained.ts):
 * needs its own switch and a Tinker key on this server, AND the endpoint
 * being offered to Sprite sessions.
 */
export function liveTrainedToolStatus(config: ToolConfig = toolConfig()): LiveModelStatus {
  const own = liveTrainedStatus()
  if (!own.enabled) return own
  const endpoint = liveModelToolStatus(config)
  return endpoint.enabled ? { enabled: true } : { enabled: false, off_reason: `the lab model endpoint is off (${endpoint.off_reason ?? 'not configured'})` }
}

/** The enabled tool names, for the public state and logs. "live_model" is added when Sprite sessions offer the lab model endpoint, "live_trained" when that endpoint also answers for trained adapters. */
export function enabledTools(config: ToolConfig = toolConfig()): Array<ToolName | 'live_model' | 'live_trained'> {
  const tools: Array<ToolName | 'live_model' | 'live_trained'> = TOOL_NAMES.filter(name => config[name].enabled && config[name].per_day > 0)
  if (liveModelToolStatus(config).enabled) tools.push('live_model')
  if (liveTrainedToolStatus(config).enabled) tools.push('live_trained')
  return tools
}
