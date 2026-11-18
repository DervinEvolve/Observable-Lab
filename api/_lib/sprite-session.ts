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
 *
 * With the lab model endpoint on (LAB_ENABLE_LIVE_MODEL, live-model.ts) a
 * session also gets a scoped model key: the lab's own host is added to the
 * sprite's egress policy, a key is made for this session, the commands get
 * it as LAB_MODEL_API_KEY with LAB_MODEL_BASE_URL, and when the session ends
 * the key is revoked and the policy goes back to the defaults. The order
 * matters: no key is made unless the sprite confirmed the policy, and a
 * session without a key runs exactly as it does with the endpoint off.
 */
import {
  applyNetworkPolicy, ensureSprite, execInSprite, sanitizeOutput, spriteKeyForModel, spriteName, tailBytes,
} from './sprites.js'
import {
  PER_EPOCH, SPRITE_COMMAND_DEFAULT_S, SPRITE_COMMAND_MAX_CHARS, SPRITE_COMMAND_MAX_S, SPRITE_SESSION_TOTAL_MAX_S,
  liveModelToolStatus, spriteUsdPerHour,
} from './tools-config.js'
import { LIVE_KEY_TTL_MS, liveModelBaseUrl, liveModelHost } from './live-model.js'
import { mintLiveModelKey, revokeLiveKey, type IssuedLiveKey } from './live-model-keys.js'

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
  /** Only when the lab model endpoint is on: whether this session got a key, and what the key was used for. */
  live_model?: { offered: boolean; calls: number; cost_usd: number; note?: string }
}

/** What a session needs to be given a scoped model key: who the key is issued to. */
export interface SessionOptions {
  liveModel?: { experimentId: string | null; epoch: number | null }
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

/** How long a session's key may live: the commands' own time limits and the waits around them, 15 minutes at most. */
export function sessionKeyTtlMs(commands: SessionCommand[]): number {
  const seconds = commands.reduce((sum, c) => sum + c.timeout_s + 15, 30)
  return Math.min(LIVE_KEY_TTL_MS, seconds * 1000)
}

/**
 * Opens the lab model endpoint for one session: the lab's host goes into the
 * sprite's egress policy first, and only once the sprite has confirmed it is
 * a key made. When either step fails `issued` is null and `note` says why;
 * the session then runs without a key. `widened` says the policy was (or may
 * have been) changed and needs putting back.
 */
async function openLiveModel(
  key: NonNullable<ReturnType<typeof spriteKeyForModel>>, modelId: string, commands: SessionCommand[], issuedTo: NonNullable<SessionOptions['liveModel']>,
): Promise<{ issued: IssuedLiveKey | null; baseUrl: string; widened: boolean; note?: string }> {
  const host = liveModelHost()
  const baseUrl = liveModelBaseUrl()
  if (!host || !baseUrl) return { issued: null, baseUrl: '', widened: false, note: 'the lab has no public https origin set' }
  let widened = false
  try {
    widened = true // from here on the sprite may hold the wider policy, even if the call below fails
    await applyNetworkPolicy(key, [host])
    const issued = await mintLiveModelKey({
      experimentId: issuedTo.experimentId, epoch: issuedTo.epoch, model: modelId, sprite: spriteName(key), ttlMs: sessionKeyTtlMs(commands),
    })
    return { issued, baseUrl, widened }
  } catch (e) {
    const message = sanitizeOutput(e instanceof Error ? e.message : String(e)).slice(0, 200)
    console.warn(`[sprite-session] no model key for ${spriteName(key)}: ${message}`)
    return { issued: null, baseUrl, widened, note: `no key was made: ${message}` }
  }
}

/** Runs the session. Never throws: every failure is a result to store. */
export async function runSpriteSession(modelId: string, commands: SessionCommand[], options: SessionOptions = {}): Promise<SpriteSessionResult> {
  const key = spriteKeyForModel(modelId)
  if (!key) return { status: 'error', sprite_name: null, commands: [], duration_ms: 0, cost_usd: 0, error: `no sprite for ${modelId}` }
  const name = spriteName(key)
  const results: SessionCommandResult[] = []
  let total = 0
  let live: Awaited<ReturnType<typeof openLiveModel>> | null = null
  let liveResult: SpriteSessionResult['live_model']
  // The key must never reach stored output, whatever a command prints. The
  // output is a tail, so a key cut in two by that leaves its end at the very
  // start; that piece goes too.
  const hideKey = (text: string): string => {
    if (!live?.issued) return text
    const token = live.issued.token
    const out = text.split(token).join('[redacted]')
    for (let n = token.length - 1; n >= 16; n--) {
      if (out.startsWith(token.slice(-n))) return `[redacted]${out.slice(n)}`
    }
    return out
  }
  let result: SpriteSessionResult
  try {
    await ensureSprite(key) // creates it if needed and (re)applies the egress policy
    if (options.liveModel && liveModelToolStatus().enabled) live = await openLiveModel(key, modelId, commands, options.liveModel)
    const scopedModelKey = live?.issued ? { baseUrl: live.baseUrl, key: live.issued.token } : undefined
    for (const cmd of commands) {
      const r = await execInSprite(key, sessionScript(cmd.run), { timeoutS: cmd.timeout_s, maxOutputBytes: 16 * 1024, ...(scopedModelKey ? { scopedModelKey } : {}) })
      total += r.durationMs
      let out = hideKey(r.output)
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
    result = { status: allOk ? 'ok' : 'failed', sprite_name: name, commands: results, duration_ms: total, cost_usd: estimateSpriteCost(total) }
  } catch (e) {
    const message = sanitizeOutput(hideKey(e instanceof Error ? e.message : String(e))).slice(0, 300)
    result = { status: 'error', sprite_name: name, commands: results, duration_ms: total, cost_usd: estimateSpriteCost(total), error: message }
  }
  // The session is over: the key stops working now, and the sprite goes back to the default egress policy.
  if (live) {
    const used = live.issued ? await revokeLiveKey(live.issued.id, 'the Sprite session ended') : null
    if (live.widened) {
      await applyNetworkPolicy(key).catch(e => console.warn(`[sprite-session] could not reset the egress policy of ${name}:`, e instanceof Error ? e.message : e))
    }
    liveResult = { offered: Boolean(live.issued), calls: used?.calls_used ?? 0, cost_usd: used?.usd_used ?? 0, ...(live.note ? { note: live.note } : {}) }
  }
  return liveResult ? { ...result, live_model: liveResult } : result
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
