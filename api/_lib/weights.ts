/**
 * Public weights for GPU jobs (docs/TOOLS.md, "Public weights").
 *
 * A model's GPU script never gets the network, so it cannot download a
 * trained model. What it can do, when LAB_ENABLE_WEIGHTS is on, is ask the
 * lab for one public Hugging Face repository by id. The lab's own fetcher on
 * Modal (fetch_weights in modal/gpu_jobs.py) checks it and downloads it onto
 * a shelf; a GPU job that names it then reads that one entry, read-only, at
 * /weights. The script still has no network.
 *
 * This file holds what the lab server needs: strict checks of what a model
 * wrote, the limits it sends to the fetcher, and the reading of what comes
 * back. Nothing here trusts a model or the fetcher's answer without checking
 * its shape. The rules themselves (license, gating, file kinds, custom code,
 * size, the shelf) live in one place, the Modal file, and are tested there.
 */
import { DEFAULT_WEIGHTS_LICENSES, modalGpuUsdPerSecond, weightsLicenses } from './tools-config.js'

export { DEFAULT_WEIGHTS_LICENSES }

/** `org/name`, as Hugging Face spells repository ids. Both parts are required. */
const REPO_PART = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?'
const REPO_ID = new RegExp(`^${REPO_PART}/${REPO_PART}$`)
const REVISION = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/
const SHA = /^[0-9a-f]{40}$/

export const DEFAULT_WEIGHTS_MAX_GB = 3
export const DEFAULT_WEIGHTS_SHELF_GB = 30
/** Ceilings the Modal side also enforces (HARD_MAX_GB and HARD_SHELF_GB in modal/gpu_jobs.py). */
export const WEIGHTS_HARD_MAX_GB = 20
export const WEIGHTS_HARD_SHELF_GB = 500
/** The fetcher's own time limit on Modal (FETCH_TIMEOUT_S), and what is charged when its real time never came back. */
export const WEIGHTS_FETCH_MAX_S = 900
export const WEIGHTS_FETCH_WORST_CASE_S = WEIGHTS_FETCH_MAX_S + 60
/** How long the lab waits for a fetch inside an epoch before going on without it. */
export const DEFAULT_WEIGHTS_WAIT_MS = 180_000
export const WEIGHTS_MAX_WAIT_MS = 300_000

export function isValidRepoId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 193 && REPO_ID.test(v) && !v.includes('..') && !v.includes('--') && !v.toLowerCase().endsWith('.git')
}

/** A branch or tag name without slashes, or a full commit sha. */
export function isValidRevision(v: unknown): v is string {
  return typeof v === 'string' && REVISION.test(v) && !v.includes('..')
}

export interface WeightsRequest {
  repo: string
  revision: string
}

/** What the Executor wrote under "weights": { "repo": "org/name", "revision"?: "..." }. */
export function normalizeWeightsRequest(raw: unknown): { request: WeightsRequest } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object with a "repo"' }
  const r = raw as Record<string, unknown>
  if (!isValidRepoId(r.repo)) return { error: 'repo must be a Hugging Face repository id written as org/name' }
  if (r.revision === undefined || r.revision === null || r.revision === '') return { request: { repo: r.repo, revision: 'main' } }
  if (!isValidRevision(r.revision)) return { error: 'revision must be a branch, tag or commit sha' }
  return { request: { repo: r.repo, revision: r.revision } }
}

/** Weights a GPU job names: a repository, and a commit when the lab knows which one. */
export interface WeightsRef {
  repo: string
  sha?: string
}

/** What the Executor wrote under gpu_job.weights: "org/name" or "org/name@<40 character commit sha>". */
export function normalizeWeightsRef(raw: unknown): { ref: WeightsRef } | { error: string } {
  if (typeof raw !== 'string') return { error: 'weights must be a repository id written as org/name' }
  const at = raw.indexOf('@')
  const repo = at < 0 ? raw : raw.slice(0, at)
  if (!isValidRepoId(repo)) return { error: 'weights must be a repository id written as org/name' }
  if (at < 0) return { ref: { repo } }
  const sha = raw.slice(at + 1)
  if (!SHA.test(sha)) return { error: 'the commit after @ must be a 40 character sha' }
  return { ref: { repo, sha } }
}

export interface WeightsLimits {
  licenses: string[]
  max_gb: number
  shelf_gb: number
}

/**
 * The owner's limits, from the environment. They are sent to the fetcher
 * with every request, and it turns them into its own numbers once. The
 * license list is tools-config.ts's: empty when LAB_WEIGHTS_LICENSES is set
 * but unusable (public weights are off then, and an empty list sent anyway
 * refuses every repository).
 */
export function weightsLimits(): WeightsLimits {
  const gb = (name: string, fallback: number, ceiling: number) => {
    const raw = (process.env[name] || '').trim()
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? Math.min(n, ceiling) : fallback
  }
  const max_gb = gb('LAB_WEIGHTS_MAX_GB', DEFAULT_WEIGHTS_MAX_GB, WEIGHTS_HARD_MAX_GB)
  return {
    licenses: weightsLicenses().licenses,
    max_gb,
    shelf_gb: Math.max(gb('LAB_WEIGHTS_SHELF_GB', DEFAULT_WEIGHTS_SHELF_GB, WEIGHTS_HARD_SHELF_GB), max_gb),
  }
}

export function weightsWaitMs(): number {
  const n = Number((process.env.LAB_WEIGHTS_POLL_MAX_MS || '').trim() || NaN)
  return Number.isFinite(n) && n > 0 ? Math.min(n, WEIGHTS_MAX_WAIT_MS) : DEFAULT_WEIGHTS_WAIT_MS
}

/**
 * The fetcher runs on CPU. Its time is charged at the same per-second rate
 * as a GPU job (tools-config.ts), which is about ten times Modal's listed
 * CPU price, so the estimate errs high like the others.
 */
export function estimateWeightsFetchCost(wallSeconds: number | null): number {
  const s = wallSeconds !== null && Number.isFinite(wallSeconds) && wallSeconds >= 0 ? wallSeconds : WEIGHTS_FETCH_WORST_CASE_S
  return s * modalGpuUsdPerSecond()
}

export interface WeightsFetchResult {
  /** ok: on the shelf. refused: a rule said no. error: the fetcher failed. failed: no usable answer. pending: still fetching when the lab stopped waiting. */
  status: 'ok' | 'refused' | 'error' | 'failed' | 'pending'
  repo: string
  sha: string | null
  cached: boolean
  license: string | null
  size_bytes: number | null
  files: number | null
  evicted: string[]
  rule?: string
  reason?: string
  error?: string
  wall_seconds: number | null
  cost_usd: number
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/** Reads the fetcher's answer. An "ok" that does not name the repository asked for and a full commit sha is not an ok. */
export function normalizeFetchResult(raw: unknown, asked: WeightsRequest): WeightsFetchResult {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const wall = typeof r.wall_seconds === 'number' && Number.isFinite(r.wall_seconds) && r.wall_seconds >= 0 ? r.wall_seconds : null
  const base: WeightsFetchResult = {
    status: 'failed', repo: asked.repo, sha: null, cached: false, license: null, size_bytes: null, files: null, evicted: [],
    wall_seconds: wall, cost_usd: estimateWeightsFetchCost(wall),
  }
  if (r.status === 'refused') {
    return { ...base, status: 'refused', rule: text(r.rule, 30) || 'rule', reason: text(r.reason, 400) || 'refused' }
  }
  if (r.status === 'error') return { ...base, status: 'error', error: text(r.error, 400) || 'the fetcher failed' }
  if (r.status !== 'ok') return { ...base, error: 'the fetcher gave no usable answer' }
  if (r.repo !== asked.repo || typeof r.sha !== 'string' || !SHA.test(r.sha)) {
    return { ...base, error: 'the fetcher\'s answer did not name the repository and a commit' }
  }
  return {
    ...base, status: 'ok', sha: r.sha, cached: r.cached === true,
    license: text(r.license, 80) || null, size_bytes: count(r.size_bytes), files: count(r.files),
    evicted: Array.isArray(r.evicted) ? r.evicted.filter((k): k is string => typeof k === 'string').slice(0, 20).map(k => k.slice(0, 240)) : [],
  }
}

/** The weights a job's sandbox really had mounted, as the Modal controller reported them. */
export interface MountedWeights {
  repo: string
  sha: string
  license: string | null
}

export function normalizeMounted(raw: unknown): MountedWeights | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isValidRepoId(r.repo) || typeof r.sha !== 'string' || !SHA.test(r.sha)) return null
  return { repo: r.repo, sha: r.sha, license: text(r.license, 80) || null }
}

/**
 * The label every GPU job result carries while public weights are on. It is
 * built from what the controller mounted, never from what a model asked for
 * or printed: a sandbox with no weights mounted has no network and no files
 * from outside, so "from scratch" holds.
 */
export function weightsLabel(mounted: MountedWeights | null, shortSha = false): string {
  return mounted ? `fine-tuned from ${mounted.repo}@${shortSha ? mounted.sha.slice(0, 12) : mounted.sha}` : 'from scratch'
}

/** One line for the stored record of a fetch. */
export function describeFetch(r: WeightsFetchResult): string {
  if (r.status === 'ok') {
    const size = r.size_bytes === null ? '' : `, ${(r.size_bytes / 1e9).toFixed(2)} GB`
    const where = r.cached ? 'already on the shelf, nothing downloaded' : `fetched${r.files === null ? '' : ` ${r.files} file${r.files === 1 ? '' : 's'}`}${size}`
    const evicted = r.evicted.length ? `; removed from the shelf to make room: ${r.evicted.join(', ')}` : ''
    return `${r.repo}@${r.sha}: ${where}${r.license ? `; license ${r.license}` : ''}${evicted}`
  }
  if (r.status === 'refused') return `refused (${r.rule}): ${r.reason}`
  if (r.status === 'pending') return r.error || 'still fetching'
  return `error: ${r.error || 'unknown'}`
}
