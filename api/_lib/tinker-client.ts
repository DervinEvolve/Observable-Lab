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
const CALL_ID = /^[A-Za-z0-9_-]{1,100}$/

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv('TINKER_JOBS_TOKEN', 'Tinker training')}` }
}

/**
 * The body the runner is sent: the data and settings a model wrote, and the
 * limits and prices the lab sets. `runId` is the run's own name (its adapter
 * slug). The runner remembers which call it started for a name, so a start
 * whose answer was lost can be found again (findTinkerCall), and a start
 * sent twice for one name starts one run.
 */
export function tinkerJobBody(request: TinkerRequest, opts: { splitSalt: string; budgetUsd: number; label: string; runId: string; exportWeights?: boolean }): Record<string, unknown> {
  return {
    run_id: opts.runId,
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
      // Asked for only while adapters can be kept: the runner also saves the
      // weights in the form Tinker lets be downloaded, which can only be done
      // while the run is open. Without it a kept adapter has no copy.
      ...(opts.exportWeights ? { export: true } : {}),
    },
  }
}

/** The lab's name for one attempt to keep ("k") or unkeep ("u") an adapter at the runner. */
export function keepJobId(kind: 'k' | 'u', slug: string, nonce: string): string {
  return `${kind}-${slug}-${nonce}`
}

/**
 * The body for keeping an adapter: the runner sets the sampler checkpoint's
 * time to live on Tinker and, when the run saved weights for download,
 * copies them to the lab's own Volume with the manifest given here. All of
 * it is the lab's own record of the run; nothing in it was written for this
 * request by a model except the one-line reason inside the manifest.
 */
export function tinkerKeepBody(opts: {
  jobId: string
  slug: string
  baseModel: string
  samplerPath: string
  externalPath: string | null
  ttlSeconds: number
  maxBytes: number
  manifest: Record<string, unknown>
}): Record<string, unknown> {
  return {
    run_id: opts.jobId,
    keep: {
      slug: opts.slug, base_model: opts.baseModel, sampler_path: opts.samplerPath, external_path: opts.externalPath,
      ttl_seconds: opts.ttlSeconds, max_bytes: opts.maxBytes, manifest: opts.manifest,
    },
  }
}

/** The body for unkeeping: the checkpoint's time to live goes back to the usual one, and the copy is removed only when asked. */
export function tinkerUnkeepBody(opts: {
  jobId: string; slug: string; samplerPath: string; externalPath: string | null; ttlSeconds: number; removeCopy: boolean
}): Record<string, unknown> {
  return {
    run_id: opts.jobId,
    unkeep: {
      slug: opts.slug, sampler_path: opts.samplerPath, external_path: opts.externalPath, ttl_seconds: opts.ttlSeconds, remove_copy: opts.removeCopy,
    },
  }
}

/**
 * `unconfirmed`: the request left and nothing came back that settles whether
 * a run was started, so it may be training. Without it, a failure means
 * nothing started.
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
  // A 4xx is the runner itself saying no (the token, the job), which it does
  // before it starts anything. A 5xx, or a 408, can come from the gateway in
  // front of it after the run was already started, so it settles nothing.
  if (res.status >= 400 && res.status < 500 && res.status !== 408) return { ok: false, error: `start failed: HTTP ${res.status}` }
  if (!res.ok) return { ok: false, unconfirmed: true, error: `start not confirmed: HTTP ${res.status}` }
  try {
    const data = await res.json() as { call_id?: unknown }
    if (typeof data.call_id === 'string' && CALL_ID.test(data.call_id)) return { ok: true, callId: data.call_id }
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

/**
 * Asks the runner which call it started for a run's name. null when it knows
 * none, cannot say, or is an older runner that does not keep names: null
 * never means that nothing was started. Never throws.
 */
export async function findTinkerCall(runId: string): Promise<string | null> {
  try {
    const url = new URL(requireHttpsUrl('TINKER_JOBS_STATUS_URL', 'Tinker training'))
    url.searchParams.set('run_id', runId)
    const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = await res.json() as { call_id?: unknown }
    return typeof data.call_id === 'string' && CALL_ID.test(data.call_id) ? data.call_id : null
  } catch {
    return null
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
