/**
 * Client for modal/gpu_jobs.py: one short Python script per job, on a Modal
 * GPU, network blocked, no credentials inside, 120 s hard limit, compiled
 * before any GPU time. Spawn, then poll, like the research runner.
 *
 * The token goes in the Authorization header only, never in a URL or body.
 * Cost is estimated from the job's measured time at the A10G rate
 * (tools-config.ts) and recorded; when the job's time is unknown the full
 * limit plus startup is charged, so the estimate errs high.
 *
 * The same Modal app holds the lab's weights fetcher (weights.ts). It is
 * reached through the same two endpoints with the same token:
 * runWeightsFetch asks for a public repository, and runGpuJob can name
 * fetched weights for the job's sandbox to read.
 *
 * A job may also name a dataset from the lab's dataset shelf (datasets.ts).
 * That shelf is filled by another Modal app; this one only mounts the named
 * entry, read-only, in the job's sandbox.
 */
import { requireEnv, requireHttpsUrl } from './config.js'
import { GPU_JOB_MAX_S, GPU_JOB_SCRIPT_MAX_CHARS, modalGpuUsdPerSecond } from './tools-config.js'
import { assertNoSecrets } from './sprites.js'
import {
  estimateWeightsFetchCost, normalizeFetchResult, normalizeMounted, weightsLimits, weightsWaitMs,
  type MountedWeights, type WeightsFetchResult, type WeightsRef, type WeightsRequest,
} from './weights.js'
import { datasetsLimits, normalizeMountedDataset, type DatasetRef, type MountedDataset } from './datasets.js'

const REQUEST_TIMEOUT_MS = 30_000
/** Seconds charged when the job's real time never came back. */
export const GPU_JOB_WORST_CASE_S = GPU_JOB_MAX_S + 90

/** How long an epoch waits for a job's result: LAB_GPU_JOB_POLL_MAX_MS, default 300 s, at most 600 s. */
export function gpuJobWaitMs(): number {
  const envWait = Number(process.env.LAB_GPU_JOB_POLL_MAX_MS)
  return Number.isFinite(envWait) && envWait > 0 ? Math.min(envWait, 600_000) : 300_000
}

/**
 * The wait left for a GPU job that first waited `waitedMs` for its weights.
 * The fetch and the job run one after the other, so together they get the
 * one wait a job always had, not that wait twice. null when too little is
 * left for a job to finish in (its 120 s limit plus startup, or half the
 * configured wait when that is shorter): starting it would spend GPU time on
 * a result the epoch could not collect.
 */
export function gpuWaitAfterFetch(configuredMs: number, waitedMs: number): number | null {
  const left = configuredMs - Math.max(0, waitedMs)
  return left >= Math.min((GPU_JOB_MAX_S + 30) * 1000, configuredMs / 2) ? left : null
}

export interface GpuJobResult {
  status: 'ok' | 'error' | 'timeout' | 'crash' | 'failed'
  stage?: string
  exit_code: number | null
  log_tail: string
  run_seconds: number | null
  wall_seconds: number | null
  gpu: string | null
  error?: string
  cost_usd: number
  /** The public weights the sandbox had mounted, as the controller reported them; null when it had none. */
  weights: MountedWeights | null
  /**
   * Only on a job that named a dataset: the public dataset its sandbox had
   * mounted, as the controller reported it, or null when it had none.
   */
  dataset?: MountedDataset | null
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv('GPU_JOBS_TOKEN', 'GPU jobs')}` }
}

export function estimateGpuCost(wallSeconds: number | null): number {
  const s = wallSeconds !== null && Number.isFinite(wallSeconds) && wallSeconds >= 0 ? wallSeconds : GPU_JOB_WORST_CASE_S
  return s * modalGpuUsdPerSecond()
}

/** What the lab sends: a non-empty script within the size limit. */
export function normalizeGpuScript(raw: unknown): { script: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'script is not a non-empty string' }
  if (raw.length > GPU_JOB_SCRIPT_MAX_CHARS) return { error: `script is longer than ${GPU_JOB_SCRIPT_MAX_CHARS} characters` }
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(raw)) return { error: 'script contains a NUL byte' }
  return { script: raw }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function normalizeJobResult(raw: unknown): GpuJobResult {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const status = ['ok', 'error', 'timeout', 'crash'].includes(String(r.status)) ? String(r.status) as GpuJobResult['status'] : 'failed'
  const wall = num(r.wall_seconds)
  // A syntax failure never started a GPU: only the tiny controller ran.
  // The same when the weights it named were not on the shelf (stage "weights").
  // Stage "mount" (the sandbox could not read them) did start one, and is
  // charged for its time like any other job.
  // Stage "dataset" is the same for a named dataset that is not on its shelf.
  const noGpu = r.stage === 'syntax' || r.stage === 'input' || r.stage === 'weights' || r.stage === 'dataset'
  const cost = noGpu ? estimateGpuCost(Math.min(wall ?? 1, 5)) : estimateGpuCost(wall)
  return {
    status,
    stage: typeof r.stage === 'string' ? r.stage.slice(0, 20) : undefined,
    exit_code: Number.isInteger(r.exit_code) ? r.exit_code as number : null,
    log_tail: typeof r.log_tail === 'string' ? r.log_tail : '',
    run_seconds: num(r.run_seconds),
    wall_seconds: wall,
    gpu: typeof r.gpu === 'string' ? r.gpu.slice(0, 20) : null,
    error: typeof r.error === 'string' ? r.error.slice(0, 1500) : undefined,
    cost_usd: cost,
    weights: normalizeMounted(r.weights),
    // The controller sends this field only for a job that named a dataset.
    ...(r.dataset !== undefined ? { dataset: normalizeMountedDataset(r.dataset) } : {}),
  }
}

type JobsCall =
  | { state: 'not_started'; error: string }   // nothing ran: nothing to charge
  | { state: 'done'; result: unknown }
  | { state: 'failed'; error: string }        // started, then lost
  | { state: 'no_result'; waitedMs: number }  // started, still running when the wait ended

/** One call to the Modal app: POST the body to /start, then poll /status. Never throws. */
async function callJobsApp(body: Record<string, unknown>, pollMs: number, maxWaitMs: number): Promise<JobsCall> {
  let callId: string
  try {
    const startUrl = requireHttpsUrl('GPU_JOBS_START_URL', 'GPU jobs')
    const res = await fetch(startUrl, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    statusUrl = new URL(requireHttpsUrl('GPU_JOBS_STATUS_URL', 'GPU jobs'))
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
      return { state: 'failed', error: typeof data.error === 'string' ? data.error.slice(0, 300) : 'unknown status' }
    } catch {
      // keep polling until the deadline
    }
  }
  return { state: 'no_result', waitedMs: maxWaitMs }
}

/**
 * Starts the job and waits for it. Never throws: a start failure costs
 * nothing, a lost poll is charged at the worst case.
 *
 * `weights` names public weights from the lab's shelf for the sandbox to
 * read at /weights. It is sent only when given, so a job without it is the
 * same request as before. `dataset` names a public dataset from the lab's
 * dataset shelf for the sandbox to read at /datasets, and is sent the same way.
 */
export async function runGpuJob(script: string, opts: { pollMs?: number; maxWaitMs?: number; weights?: WeightsRef; dataset?: DatasetRef } = {}): Promise<GpuJobResult> {
  const pollMs = opts.pollMs ?? 5000
  const maxWaitMs = opts.maxWaitMs ?? gpuJobWaitMs()
  const failed = (error: string, cost: number): GpuJobResult => ({
    status: 'failed', exit_code: null, log_tail: '', run_seconds: null, wall_seconds: null, gpu: null, error, cost_usd: cost, weights: null,
  })
  try { assertNoSecrets([script]) } catch { return failed('refusing to send a server credential into a GPU job', 0) }
  const body: Record<string, unknown> = { script }
  if (opts.weights) body.weights = { ...opts.weights, licenses: weightsLimits().licenses }
  if (opts.dataset) body.dataset = { ...opts.dataset, licenses: datasetsLimits().licenses }
  const call = await callJobsApp(body, pollMs, maxWaitMs)
  // Not known to have started: nothing charged.
  if (call.state === 'not_started') return failed(call.error, 0)
  if (call.state === 'done') return normalizeJobResult(call.result)
  if (call.state === 'failed') return failed(`job failed: ${call.error}`, estimateGpuCost(null))
  return failed(`no result after ${Math.round(call.waitedMs / 1000)} s of waiting`, estimateGpuCost(null))
}

/**
 * Asks the lab's fetcher on Modal for one public repository and waits for
 * its answer. Never throws. The limits (licenses, sizes) are the owner's,
 * read from the environment here and sent with the request; a model cannot
 * set them. If the fetch is still running when the wait ends it carries on
 * on Modal, and the result here is "pending", charged at the worst case.
 */
export async function runWeightsFetch(request: WeightsRequest, opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<WeightsFetchResult> {
  const none = (status: 'failed' | 'pending', error: string, cost: number): WeightsFetchResult => ({
    status, repo: request.repo, sha: null, cached: false, license: null, size_bytes: null, files: null, evicted: [],
    error, wall_seconds: null, cost_usd: cost,
  })
  const call = await callJobsApp(
    { fetch_weights: { repo: request.repo, revision: request.revision, limits: weightsLimits() } },
    opts.pollMs ?? 5000, opts.maxWaitMs ?? weightsWaitMs(),
  )
  if (call.state === 'not_started') return none('failed', call.error, 0)
  if (call.state === 'done') return normalizeFetchResult(call.result, request)
  if (call.state === 'failed') return none('failed', `fetch failed: ${call.error}`, estimateWeightsFetchCost(null))
  return none('pending', `still fetching after ${Math.round(call.waitedMs / 1000)} s; it carries on, and asking again later finds it on the shelf`, estimateWeightsFetchCost(null))
}
