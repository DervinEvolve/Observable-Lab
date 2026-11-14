/**
 * Client for modal/gpu_jobs.py: one short Python script per job, on a Modal
 * GPU, network blocked, no credentials inside, 120 s hard limit, compiled
 * before any GPU time. Spawn, then poll, like the research runner.
 *
 * The token goes in the Authorization header only, never in a URL or body.
 * Cost is estimated from the job's measured time at the A10G rate
 * (tools-config.ts) and recorded; when the job's time is unknown the full
 * limit plus startup is charged, so the estimate errs high.
 */
import { requireEnv, requireHttpsUrl } from './config.js'
import { GPU_JOB_MAX_S, GPU_JOB_SCRIPT_MAX_CHARS, modalGpuUsdPerSecond } from './tools-config.js'
import { assertNoSecrets } from './sprites.js'

const REQUEST_TIMEOUT_MS = 30_000
/** Seconds charged when the job's real time never came back. */
export const GPU_JOB_WORST_CASE_S = GPU_JOB_MAX_S + 90

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
  const cost = r.stage === 'syntax' || r.stage === 'input' ? estimateGpuCost(Math.min(wall ?? 1, 5)) : estimateGpuCost(wall)
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
  }
}

/**
 * Starts the job and waits for it. Never throws: a start failure costs
 * nothing, a lost poll is charged at the worst case.
 */
export async function runGpuJob(script: string, opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<GpuJobResult> {
  const pollMs = opts.pollMs ?? 5000
  const envWait = Number(process.env.LAB_GPU_JOB_POLL_MAX_MS)
  const maxWaitMs = opts.maxWaitMs ?? (Number.isFinite(envWait) && envWait > 0 ? Math.min(envWait, 600_000) : 300_000)
  const failed = (error: string, cost: number): GpuJobResult => ({
    status: 'failed', exit_code: null, log_tail: '', run_seconds: null, wall_seconds: null, gpu: null, error, cost_usd: cost,
  })
  try { assertNoSecrets([script]) } catch { return failed('refusing to send a server credential into a GPU job', 0) }
  let callId: string
  try {
    const startUrl = requireHttpsUrl('GPU_JOBS_START_URL', 'GPU jobs')
    const res = await fetch(startUrl, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ script }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return failed(`start failed: HTTP ${res.status}`, 0)
    const data = await res.json() as { call_id?: unknown }
    if (typeof data.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.call_id)) return failed('start: no call id', 0)
    callId = data.call_id
  } catch (e) {
    // Not known to have started: nothing charged.
    return failed(`start failed: ${e instanceof Error ? e.message : 'request error'}`, 0)
  }

  const statusUrl = new URL(requireHttpsUrl('GPU_JOBS_STATUS_URL', 'GPU jobs'))
  statusUrl.searchParams.set('call_id', callId)
  const deadline = Date.now() + maxWaitMs
  for (let first = true; Date.now() < deadline; first = false) {
    if (!first) await new Promise(r => setTimeout(r, pollMs))
    try {
      const res = await fetch(statusUrl, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!res.ok) continue
      const data = await res.json() as { status?: unknown; result?: unknown; error?: unknown }
      if (data.status === 'running') continue
      if (data.status === 'done') return normalizeJobResult(data.result)
      return failed(`job failed: ${typeof data.error === 'string' ? data.error.slice(0, 300) : 'unknown status'}`, estimateGpuCost(null))
    } catch {
      // keep polling until the deadline
    }
  }
  return failed(`no result after ${Math.round(maxWaitMs / 1000)} s of waiting`, estimateGpuCost(null))
}
