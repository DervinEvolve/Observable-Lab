/**
 * Client for modal/tinker_jobs.py: the lab's own training runner on Modal.
 * Spawn, then poll, like GPU jobs. The two calls are separate here because a
 * training run can outlast the request that started it: the follow-up polls
 * for a while, and a later tick collects what it did not wait for.
 *
 * The token (TINKER_JOBS_TOKEN) goes in the Authorization header only, never
 * in a URL or body. It only lets the lab reach the runner. The Tinker API
 * key is not here at all: the runner has its own copy in a Modal secret, and
 * nothing this file sends or receives carries it.
 */
import { requireEnv, requireHttpsUrl } from './config.js'
import { assertNoSecrets } from './sprites.js'
import {
  TINKER_PRICES, TINKER_SAMPLE_COUNT, TINKER_SAMPLE_MAX_TOKENS, tinkerTtlDays,
  type TinkerRequest,
} from './tinker.js'

const REQUEST_TIMEOUT_MS = 30_000

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv('TINKER_JOBS_TOKEN', 'Tinker training')}` }
}

/** The body the runner is sent: the data and settings a model wrote, and the limits and prices the lab sets. */
export function tinkerJobBody(request: TinkerRequest, opts: { splitSalt: string; budgetUsd: number; label: string }): Record<string, unknown> {
  return {
    train: {
      base_model: request.base_model,
      examples: request.examples,
      settings: request.settings,
      split_salt: opts.splitSalt,
      // The most this run may cost by the published prices. The runner counts
      // real tokens against it: it refuses a plan that costs more, and stops
      // training before the measured use would pass it.
      budget_usd: opts.budgetUsd,
      prices: TINKER_PRICES[request.base_model],
      ttl_seconds: tinkerTtlDays() * 24 * 60 * 60,
      samples: TINKER_SAMPLE_COUNT,
      sample_max_tokens: TINKER_SAMPLE_MAX_TOKENS,
      label: opts.label,
    },
  }
}

/**
 * `unconfirmed`: the request left and no usable answer came back, so the run
 * may have started all the same. Without it, a failure means nothing started.
 */
export type TinkerStart = { ok: true; callId: string } | { ok: false; error: string; unconfirmed?: true }

/** Starts a run. Never throws. */
export async function startTinkerJob(body: Record<string, unknown>): Promise<TinkerStart> {
  let text: string
  try {
    text = JSON.stringify(body)
    assertNoSecrets([text])
  } catch {
    return { ok: false, error: 'refusing to send a server credential to the training runner' }
  }
  let url: string
  let headers: Record<string, string>
  try {
    url = requireHttpsUrl('TINKER_JOBS_START_URL', 'Tinker training')
    headers = { ...authHeaders(), 'Content-Type': 'application/json' }
  } catch (e) {
    return { ok: false, error: `start failed: ${e instanceof Error ? e.message : 'not configured'}` }
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (e) {
    return { ok: false, unconfirmed: true, error: `start not confirmed: ${e instanceof Error ? e.message : 'request error'}` }
  }
  // The endpoint starts the run as its last step, so an error status means it did not start one.
  if (!res.ok) return { ok: false, error: `start failed: HTTP ${res.status}` }
  try {
    const data = await res.json() as { call_id?: unknown }
    if (typeof data.call_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(data.call_id)) return { ok: true, callId: data.call_id }
  } catch {
    // an answer that is not JSON
  }
  return { ok: false, unconfirmed: true, error: 'start not confirmed: the runner answered without a call id' }
}

export type TinkerPoll =
  | { state: 'running' }
  | { state: 'done'; result: unknown }
  | { state: 'failed'; error: string }
  | { state: 'unknown' } // the status call itself did not answer; ask again later

/** Asks once whether a run has finished. Never throws. */
export async function pollTinkerJob(callId: string): Promise<TinkerPoll> {
  try {
    const url = new URL(requireHttpsUrl('TINKER_JOBS_STATUS_URL', 'Tinker training'))
    url.searchParams.set('call_id', callId)
    const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) return { state: 'unknown' }
    const data = await res.json() as { status?: unknown; result?: unknown; error?: unknown }
    if (data.status === 'running') return { state: 'running' }
    if (data.status === 'done') return { state: 'done', result: data.result }
    return { state: 'failed', error: typeof data.error === 'string' ? data.error.slice(0, 300) : 'unknown status' }
  } catch {
    return { state: 'unknown' }
  }
}

/** Polls until the run finishes or the wait ends. `running` means it is still going and can be collected later. */
export async function waitForTinkerJob(callId: string, maxWaitMs: number, pollMs = 10_000): Promise<TinkerPoll> {
  const deadline = Date.now() + maxWaitMs
  for (let first = true; first || Date.now() < deadline; first = false) {
    if (!first) await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    const poll = await pollTinkerJob(callId)
    if (poll.state === 'done' || poll.state === 'failed') return poll
  }
  return { state: 'running' }
}
