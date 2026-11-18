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
 */
import { spritesConfigured } from './sprites.js'
import { liveModelStatus, type LiveModelStatus } from './live-model.js'

export const TOOL_NAMES = ['subagents', 'sprite_session', 'gpu_job', 'weights', 'exhibit', 'lab_proposal'] as const
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
  return (process.env[name] || '').trim() === 'true'
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
    weights: status(
      flag('LAB_ENABLE_WEIGHTS') && gpuJobs,
      !flag('LAB_ENABLE_WEIGHTS') ? 'LAB_ENABLE_WEIGHTS is not true' : 'GPU jobs are off',
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

/** The enabled tool names, for the public state and logs. "live_model" is added when Sprite sessions offer the lab model endpoint. */
export function enabledTools(config: ToolConfig = toolConfig()): Array<ToolName | 'live_model'> {
  const tools: Array<ToolName | 'live_model'> = TOOL_NAMES.filter(name => config[name].enabled && config[name].per_day > 0)
  if (liveModelToolStatus(config).enabled) tools.push('live_model')
  return tools
}
