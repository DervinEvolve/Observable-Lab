/**
 * Client for modal/datasets.py: the lab's dataset fetcher and its reader on
 * Modal. Spawn, then poll, like GPU jobs.
 *
 * The token (DATASETS_TOKEN) goes in the Authorization header only, never in
 * a URL or body. It only lets the lab reach that app. No Hugging Face token
 * exists anywhere: the fetcher reads what anyone can read without an account.
 *
 * Cost is estimated from measured time at the lab's per-second Modal rate
 * (datasets.ts); when the time is unknown the whole time limit is charged,
 * so the estimate errs high. A call that never started costs nothing.
 */
import { requireEnv, requireHttpsUrl } from './config.js'
import { assertNoSecrets } from './sprites.js'
import { plainLine } from './weights.js'
import {
  datasetsLimits, datasetsReadWaitMs, datasetsWaitMs, estimateDatasetFetchCost, estimateDatasetReadCost,
  normalizeDatasetFetchResult, normalizeRowsResult,
  type DatasetFetchResult, type DatasetRequest, type DatasetRowsResult, type TinkerDatasetSource,
} from './datasets.js'

const REQUEST_TIMEOUT_MS = 30_000

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv('DATASETS_TOKEN', 'public datasets')}` }
}

type DatasetsCall =
  | { state: 'not_started'; error: string }   // nothing ran: nothing to charge
  | { state: 'done'; result: unknown }
  | { state: 'failed'; error: string }        // started, then lost
  | { state: 'no_result'; waitedMs: number }  // started, still running when the wait ended

/** One call to the Modal app: POST the body to /start, then poll /status. Never throws. */
async function callDatasetsApp(body: Record<string, unknown>, pollMs: number, maxWaitMs: number): Promise<DatasetsCall> {
  let callId: string
  const sent = JSON.stringify(body)
  try { assertNoSecrets([sent]) } catch { return { state: 'not_started', error: 'refusing to send a server credential to the dataset shelf' } }
  try {
    const startUrl = requireHttpsUrl('DATASETS_START_URL', 'public datasets')
    const res = await fetch(startUrl, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: sent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return { state: 'not_started', error: `start failed: HTTP ${res.status}` }
    const data = await res.json() as { call_id?: unknown }
    if (typeof data.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.call_id)) return { state: 'not_started', error: 'start: no call id' }
    callId = data.call_id
  } catch (e) {
    return { state: 'not_started', error: `start failed: ${e instanceof Error ? e.message : 'request error'}` }
  }

  let statusUrl: URL
  try {
    statusUrl = new URL(requireHttpsUrl('DATASETS_STATUS_URL', 'public datasets'))
  } catch (e) {
    return { state: 'failed', error: e instanceof Error ? e.message : 'no status URL' }
  }
  statusUrl.searchParams.set('call_id', callId)
  const deadline = Date.now() + maxWaitMs
  for (let first = true; Date.now() < deadline; first = false) {
    if (!first) await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    try {
      const res = await fetch(statusUrl, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!res.ok) continue
      const data = await res.json() as { status?: unknown; result?: unknown; error?: unknown }
      if (data.status === 'running') continue
      if (data.status === 'done') return { state: 'done', result: data.result }
      return { state: 'failed', error: plainLine(data.error, 300) || 'unknown status' }
    } catch {
      // keep polling until the deadline
    }
  }
  return { state: 'no_result', waitedMs: maxWaitMs }
}

/**
 * Asks the lab's fetcher on Modal for one public dataset and waits for its
 * answer. Never throws. The limits (licenses, sizes) are the owner's, read
 * from the environment here and sent with the request; a model cannot set
 * them. If the fetch is still running when the wait ends it carries on on
 * Modal, and the result here is "pending", charged at the worst case.
 */
export async function runDatasetFetch(request: DatasetRequest, opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<DatasetFetchResult> {
  const none = (status: 'failed' | 'pending', error: string, cost: number): DatasetFetchResult => ({
    status, repo: request.repo, sha: null, cached: false, license: null, size_bytes: null, files: null, rows: null, data_files: [],
    skipped_files: null, evicted: [], error, wall_seconds: null, cost_usd: cost,
  })
  const call = await callDatasetsApp(
    { fetch_dataset: { repo: request.repo, revision: request.revision, limits: datasetsLimits() } },
    opts.pollMs ?? 5000, opts.maxWaitMs ?? datasetsWaitMs(),
  )
  if (call.state === 'not_started') return none('failed', call.error, 0)
  if (call.state === 'done') return normalizeDatasetFetchResult(call.result, request)
  if (call.state === 'failed') return none('failed', `fetch failed: ${call.error}`, estimateDatasetFetchCost(null))
  return none('pending', `still fetching after ${Math.round(call.waitedMs / 1000)} s; it carries on, and asking again later finds it on the shelf`, estimateDatasetFetchCost(null))
}

/**
 * Asks the lab's reader on Modal for the rows of one shelf file, mapped into
 * chat examples. Never throws. The reader has no network and no secrets; the
 * current license list goes with the request, so a dataset fetched under a
 * license that has since been taken off the list is not read.
 */
export async function readDatasetRows(source: TinkerDatasetSource, opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<DatasetRowsResult> {
  const none = (status: 'failed' | 'pending', error: string, cost: number): DatasetRowsResult => ({
    status, repo: source.repo, sha: null, license: null, file: null, rows_scanned: null, rows_used: null, skipped: {}, stopped: null,
    examples: [], error, wall_seconds: null, cost_usd: cost,
  })
  const call = await callDatasetsApp({
    read_rows: {
      repo: source.repo, ...(source.sha ? { sha: source.sha } : {}), licenses: datasetsLimits().licenses,
      ...(source.file ? { file: source.file } : {}),
      user_column: source.user_column, assistant_column: source.assistant_column,
      ...(source.system !== undefined ? { system: source.system } : {}), limit: source.limit,
    },
  }, opts.pollMs ?? 3000, opts.maxWaitMs ?? datasetsReadWaitMs())
  if (call.state === 'not_started') return none('failed', call.error, 0)
  if (call.state === 'done') return normalizeRowsResult(call.result, source)
  if (call.state === 'failed') return none('failed', `read failed: ${call.error}`, estimateDatasetReadCost(null))
  return none('pending', `the lab's reader gave no answer in ${Math.round(call.waitedMs / 1000)} s`, estimateDatasetReadCost(null))
}
