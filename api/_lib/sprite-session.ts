/**
 * A Sprite session: up to four shell commands the Executor chose to run in
 * its own Sprite, for prototyping or a quick benchmark. Its output is stored
 * and shown on the screen above the model's desk.
 *
 * Same safeguards as the contribution check (sprites.ts): the sprite gets the
 * "defaults" egress policy before anything runs, no credential is ever sent
 * in (execInSprite refuses arguments or env carrying one of this server's
 * secrets), every command has its own time limit under coreutils timeout,
 * and the output is cleaned of anything that looks like a credential before
 * it is stored. Commands run in ~/lab-session and take the same lock as the
 * contribution check, so they never run while the sprite is testing a
 * branch.
 */
import {
  ensureSprite, execInSprite, sanitizeOutput, spriteKeyForModel, spriteName, tailBytes,
} from './sprites.js'
import {
  PER_EPOCH, SPRITE_COMMAND_DEFAULT_S, SPRITE_COMMAND_MAX_CHARS, SPRITE_COMMAND_MAX_S, SPRITE_SESSION_TOTAL_MAX_S,
  spriteUsdPerHour,
} from './tools-config.js'

export interface SessionCommand { run: string; timeout_s: number }

export interface SessionCommandResult {
  run: string
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
  output_tail: string
}

export interface SpriteSessionResult {
  status: 'ok' | 'failed' | 'error'
  sprite_name: string | null
  commands: SessionCommandResult[]
  duration_ms: number
  cost_usd: number
  error?: string
}

const COMMAND_TAIL_BYTES = 1500
const SESSION_DIR = '/home/sprite/lab-session'
const LOCK = '/home/sprite/.lab-check.lock'

/**
 * The commands as the lab will run them: plain single strings, a time limit
 * each, the total held under SPRITE_SESSION_TOTAL_MAX_S. Anything else is
 * dropped with a reason.
 */
export function normalizeSessionCommands(raw: unknown): { commands: SessionCommand[]; dropped: string[] } {
  const dropped: string[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!Array.isArray(raw)) dropped.push('commands is not a list')
  const commands: SessionCommand[] = []
  let total = 0
  for (const [i, item] of list.entries()) {
    if (commands.length >= PER_EPOCH.sprite_commands) { dropped.push(`command ${i + 1}: more than ${PER_EPOCH.sprite_commands} commands`); continue }
    const run = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as Record<string, unknown>).run : undefined
    if (typeof run !== 'string' || !run.trim()) { dropped.push(`command ${i + 1}: not a string`); continue }
    if (run.length > SPRITE_COMMAND_MAX_CHARS) { dropped.push(`command ${i + 1}: longer than ${SPRITE_COMMAND_MAX_CHARS} characters`); continue }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000\r]/.test(run)) { dropped.push(`command ${i + 1}: control characters`); continue }
    const asked = item && typeof item === 'object' ? Number((item as Record<string, unknown>).timeout_s) : NaN
    let timeout = Number.isFinite(asked) ? Math.round(asked) : SPRITE_COMMAND_DEFAULT_S
    timeout = Math.max(5, Math.min(SPRITE_COMMAND_MAX_S, timeout))
    if (total + timeout > SPRITE_SESSION_TOTAL_MAX_S) {
      timeout = SPRITE_SESSION_TOTAL_MAX_S - total
      if (timeout < 5) { dropped.push(`command ${i + 1}: the session's ${SPRITE_SESSION_TOTAL_MAX_S} s are used up`); continue }
    }
    total += timeout
    commands.push({ run: run.trim(), timeout_s: timeout })
  }
  return { commands, dropped }
}

export function sessionScript(command: string): string {
  return [
    `mkdir -p ${SESSION_DIR} && cd ${SESSION_DIR}`,
    `if command -v flock >/dev/null 2>&1; then exec 9>${LOCK}; flock -w 20 9 || { echo "the sprite is busy testing a contribution"; exit 75; }; fi`,
    command,
  ].join('\n')
}

export function estimateSpriteCost(durationMs: number): number {
  return Math.max(0, durationMs) / 3_600_000 * spriteUsdPerHour()
}

/** Runs the session. Never throws: every failure is a result to store. */
export async function runSpriteSession(modelId: string, commands: SessionCommand[]): Promise<SpriteSessionResult> {
  const key = spriteKeyForModel(modelId)
  if (!key) return { status: 'error', sprite_name: null, commands: [], duration_ms: 0, cost_usd: 0, error: `no sprite for ${modelId}` }
  const name = spriteName(key)
  const results: SessionCommandResult[] = []
  let total = 0
  try {
    await ensureSprite(key) // creates it if needed and (re)applies the egress policy
    for (const cmd of commands) {
      const r = await execInSprite(key, sessionScript(cmd.run), { timeoutS: cmd.timeout_s, maxOutputBytes: 16 * 1024 })
      total += r.durationMs
      let out = r.output
      if (r.timedOut) out += `\ntimed out after ${cmd.timeout_s} s`
      results.push({
        run: sanitizeOutput(cmd.run).slice(0, SPRITE_COMMAND_MAX_CHARS),
        exit_code: r.exitCode,
        duration_ms: r.durationMs,
        timed_out: r.timedOut,
        output_tail: tailBytes(sanitizeOutput(tailBytes(out, COMMAND_TAIL_BYTES * 2)), COMMAND_TAIL_BYTES),
      })
    }
    const allOk = results.every(r => r.exit_code === 0)
    return { status: allOk ? 'ok' : 'failed', sprite_name: name, commands: results, duration_ms: total, cost_usd: estimateSpriteCost(total) }
  } catch (e) {
    const message = sanitizeOutput(e instanceof Error ? e.message : String(e)).slice(0, 300)
    return { status: 'error', sprite_name: name, commands: results, duration_ms: total, cost_usd: estimateSpriteCost(total), error: message }
  }
}

/** One text block for the stored output tail: each command and the end of its output. */
export function sessionTranscript(result: SpriteSessionResult): string {
  const lines: string[] = []
  for (const c of result.commands) {
    lines.push(`$ ${c.run}`)
    if (c.output_tail) lines.push(c.output_tail)
    lines.push(`[exit ${c.exit_code === null ? 'unknown' : c.exit_code}, ${(c.duration_ms / 1000).toFixed(1)} s]`)
  }
  if (result.error) lines.push(`sprite error: ${result.error}`)
  return lines.join('\n')
}
