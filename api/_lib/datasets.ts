/**
 * Public datasets (docs/TOOLS.md, "Public datasets").
 *
 * A model's code never gets the network, so it cannot download a dataset.
 * What it can do, when LAB_ENABLE_DATASETS is on, is ask the lab for one
 * public Hugging Face dataset repository by id. The lab's own fetcher on
 * Modal (fetch_dataset in modal/datasets.py) checks it and downloads its data
 * files onto a shelf. Two things can then read a shelf entry:
 *
 *  - a GPU job that names it finds that one entry, read-only, at /datasets
 *    (its network stays off);
 *  - a Tinker training request may name it, with the two columns that hold
 *    the user turn and the assistant turn, instead of writing its examples
 *    inline. The lab's reader on Modal (read_rows, no network, no secrets)
 *    turns rows into chat examples, and from there the run is the same run:
 *    the same checks, the same cost estimate and caps, the same held-out
 *    slice.
 *
 * This file holds what the lab server needs, with no database and no network
 * in it: strict checks of what a model wrote, the owner's limits, the reading
 * of what the fetcher and the reader send back, and the text the models are
 * told. Nothing here trusts a model, the fetcher or the reader without
 * checking the shape of what it said. The rules themselves (license, gating,
 * file kinds, size, the shelf, the column mapping) live in the Modal file and
 * are tested there.
 */
import { DEFAULT_DATASETS_LICENSES, datasetsLicenses, modalGpuUsdPerSecond } from './tools-config.js'
import { isValidRepoId, isValidRevision } from './weights.js'
import {
  TINKER_MAX_DATASET_BYTES, TINKER_MAX_EXAMPLES, TINKER_MAX_EXAMPLE_BYTES, TINKER_MAX_STEPS, TINKER_MIN_EXAMPLES,
  estimateTinkerRun, normalizeTinkerRequest, plannedSteps, readSettings, tinkerBaseModels, tinkerNamesFlag,
  type TinkerEstimate, type TinkerExample, type TinkerRequest, type TinkerSettings,
} from './tinker.js'
import { readAdapterName } from './tinker-names.js'

export { DEFAULT_DATASETS_LICENSES }

export const DATASETS_TOOL = 'datasets'

const SHA = /^[0-9a-f]{40}$/
/** A file inside a shelf entry, as the fetcher accepts them (SAFE_PATH_PATTERN in modal/datasets.py). */
const DATA_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,5}$/
/** A top-level column name (COLUMN_PATTERN in modal/datasets.py). */
const COLUMN = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/
const DATA_KINDS = ['parquet', 'jsonl', 'json', 'csv', 'tsv', 'txt', 'arrow'] as const

export const DEFAULT_DATASETS_MAX_GB = 1
export const DEFAULT_DATASETS_SHELF_GB = 20
/** Ceilings the Modal side also enforces (HARD_MAX_GB and HARD_SHELF_GB in modal/datasets.py). */
export const DATASETS_HARD_MAX_GB = 20
export const DATASETS_HARD_SHELF_GB = 200
/** The fetcher's own time limit on Modal (FETCH_TIMEOUT_S), and what is charged when its real time never came back. */
export const DATASETS_FETCH_MAX_S = 900
export const DATASETS_FETCH_WORST_CASE_S = DATASETS_FETCH_MAX_S + 60
/** The reader's own time limit on Modal (READ_TIMEOUT_S), and what is charged when its real time never came back. */
export const DATASETS_READ_MAX_S = 300
export const DATASETS_READ_WORST_CASE_S = DATASETS_READ_MAX_S + 60
/** How long the lab waits for a fetch inside an epoch before going on without it. */
export const DEFAULT_DATASETS_WAIT_MS = 180_000
export const DATASETS_MAX_WAIT_MS = 300_000
/** How long the lab waits for the reader before a training run is given up. */
export const DEFAULT_DATASETS_READ_WAIT_MS = 150_000
export const DATASETS_READ_MAX_WAIT_MS = 240_000
/** Rows a training request takes from a dataset when it gives no limit. The reader has the same number (DEFAULT_ROWS). */
export const DATASETS_DEFAULT_ROWS = 500
/** Bytes of system text a training request may put before every row (MAX_SYSTEM_BYTES in modal/datasets.py). */
export const DATASETS_MAX_SYSTEM_BYTES = 2000

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

export function isDataPath(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 600 && DATA_PATH.test(v) && !v.includes('..')
}
export function isColumnName(v: unknown): v is string {
  return typeof v === 'string' && COLUMN.test(v) && v === v.trim()
}

// ---------------------------------------------------------------------------
// Asking for a dataset, and naming one on a GPU job
// ---------------------------------------------------------------------------

export interface DatasetRequest {
  repo: string
  revision: string
}

/** What the Executor wrote under "datasets": { "repo": "org/name", "revision"?: "..." }. */
export function normalizeDatasetRequest(raw: unknown): { request: DatasetRequest } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'not an object with a "repo"' }
  if (!isValidRepoId(raw.repo)) return { error: 'repo must be a Hugging Face dataset id written as org/name' }
  if (raw.revision === undefined || raw.revision === null || raw.revision === '') return { request: { repo: raw.repo, revision: 'main' } }
  if (!isValidRevision(raw.revision)) return { error: 'revision must be a branch, tag or commit sha' }
  return { request: { repo: raw.repo, revision: raw.revision } }
}

/** A dataset on the shelf: a repository, and a commit when the lab knows which one. */
export interface DatasetRef {
  repo: string
  sha?: string
}

/** "org/name" or "org/name@<40 character commit sha>", as a GPU job or a training request names a shelf dataset. */
export function normalizeDatasetRef(raw: unknown): { ref: DatasetRef } | { error: string } {
  if (typeof raw !== 'string') return { error: 'dataset must be a dataset id written as org/name' }
  const at = raw.indexOf('@')
  const repo = at < 0 ? raw : raw.slice(0, at)
  if (!isValidRepoId(repo)) return { error: 'dataset must be a dataset id written as org/name' }
  if (at < 0) return { ref: { repo } }
  const sha = raw.slice(at + 1)
  if (!SHA.test(sha)) return { error: 'the commit after @ must be a 40 character sha' }
  return { ref: { repo, sha } }
}

// ---------------------------------------------------------------------------
// The owner's limits
// ---------------------------------------------------------------------------

export interface DatasetsLimits {
  licenses: string[]
  max_gb: number
  shelf_gb: number
}

/**
 * The owner's limits, from the environment. They are sent to the fetcher
 * with every request, and it turns them into its own numbers once. A model
 * cannot set them. The license list is empty when LAB_DATASETS_LICENSES is
 * set but unusable (the tool is off then, and an empty list sent anyway
 * refuses every repository).
 */
export function datasetsLimits(): DatasetsLimits {
  const gb = (name: string, fallback: number, ceiling: number) => {
    const raw = (process.env[name] || '').trim()
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? Math.min(n, ceiling) : fallback
  }
  const max_gb = gb('LAB_DATASETS_MAX_GB', DEFAULT_DATASETS_MAX_GB, DATASETS_HARD_MAX_GB)
  return {
    licenses: datasetsLicenses().licenses,
    max_gb,
    shelf_gb: Math.max(gb('LAB_DATASETS_SHELF_GB', DEFAULT_DATASETS_SHELF_GB, DATASETS_HARD_SHELF_GB), max_gb),
  }
}

export function datasetsWaitMs(): number {
  const n = Number((process.env.LAB_DATASETS_POLL_MAX_MS || '').trim() || NaN)
  return Number.isFinite(n) && n > 0 ? Math.min(n, DATASETS_MAX_WAIT_MS) : DEFAULT_DATASETS_WAIT_MS
}

/** How long the follow-up waits for the reader: LAB_DATASETS_READ_POLL_MAX_MS, default 150 s, at most 240 s. */
export function datasetsReadWaitMs(): number {
  const n = Number((process.env.LAB_DATASETS_READ_POLL_MAX_MS || '').trim() || NaN)
  return Number.isFinite(n) && n > 0 ? Math.min(n, DATASETS_READ_MAX_WAIT_MS) : DEFAULT_DATASETS_READ_WAIT_MS
}

/**
 * The fetcher and the reader run on CPU. Their time is charged at the same
 * per-second rate as a GPU job (tools-config.ts), which is about ten times
 * Modal's listed CPU price, so the estimate errs high like the others.
 */
export function estimateDatasetFetchCost(wallSeconds: number | null): number {
  const s = wallSeconds !== null && Number.isFinite(wallSeconds) && wallSeconds >= 0 ? wallSeconds : DATASETS_FETCH_WORST_CASE_S
  return s * modalGpuUsdPerSecond()
}
export function estimateDatasetReadCost(wallSeconds: number | null): number {
  const s = wallSeconds !== null && Number.isFinite(wallSeconds) && wallSeconds >= 0 ? wallSeconds : DATASETS_READ_WORST_CASE_S
  return s * modalGpuUsdPerSecond()
}

// ---------------------------------------------------------------------------
// What the fetcher sends back
// ---------------------------------------------------------------------------

/** One data file of a shelf entry, as the lab's reader described it. null means it was not counted. */
export interface DatasetFile {
  path: string
  kind: string
  rows: number | null
  columns: string[] | null
}

export interface DatasetFetchResult {
  /** ok: on the shelf. refused: a rule said no. error: the fetcher failed. failed: no usable answer. pending: still fetching when the lab stopped waiting. */
  status: 'ok' | 'refused' | 'error' | 'failed' | 'pending'
  repo: string
  sha: string | null
  cached: boolean
  license: string | null
  size_bytes: number | null
  /** How many data files are on the shelf for it. */
  files: number | null
  /** Rows in all its files that have rows and columns, when every one was counted. */
  rows: number | null
  /** The first few data files, with their rows and column names. */
  data_files: DatasetFile[]
  /** Files of the repository that were left on the hub: everything that is not a data file, any code included. */
  skipped_files: number | null
  evicted: string[]
  rule?: string
  reason?: string
  error?: string
  wall_seconds: number | null
  cost_usd: number
}

function readDataFiles(raw: unknown): DatasetFile[] {
  const out: DatasetFile[] = []
  for (const item of Array.isArray(raw) ? raw.slice(0, 12) : []) {
    if (!isPlainObject(item) || !isDataPath(item.path)) continue
    const kind = (DATA_KINDS as readonly unknown[]).includes(item.kind) ? item.kind as string : ''
    if (!kind) continue
    const columns = Array.isArray(item.columns) ? item.columns.filter(isColumnName).slice(0, 12) : []
    out.push({ path: item.path, kind, rows: count(item.rows), columns: columns.length ? columns : null })
  }
  return out
}

/** Reads the fetcher's answer. An "ok" that does not name the repository asked for and a full commit sha is not an ok. */
export function normalizeDatasetFetchResult(raw: unknown, asked: DatasetRequest): DatasetFetchResult {
  const r = isPlainObject(raw) ? raw : {}
  const wall = typeof r.wall_seconds === 'number' && Number.isFinite(r.wall_seconds) && r.wall_seconds >= 0 ? r.wall_seconds : null
  const base: DatasetFetchResult = {
    status: 'failed', repo: asked.repo, sha: null, cached: false, license: null, size_bytes: null, files: null, rows: null,
    data_files: [], skipped_files: null, evicted: [], wall_seconds: wall, cost_usd: estimateDatasetFetchCost(wall),
  }
  if (r.status === 'refused') {
    return { ...base, status: 'refused', rule: text(r.rule, 30) || 'rule', reason: text(r.reason, 400) || 'refused' }
  }
  if (r.status === 'error') return { ...base, status: 'error', error: text(r.error, 400) || 'the fetcher failed' }
  if (r.status !== 'ok') return { ...base, error: 'the fetcher gave no usable answer' }
  if (r.repo !== asked.repo || typeof r.sha !== 'string' || !SHA.test(r.sha)) {
    return { ...base, error: 'the fetcher\'s answer did not name the dataset and a commit' }
  }
  return {
    ...base, status: 'ok', sha: r.sha, cached: r.cached === true,
    license: text(r.license, 80) || null, size_bytes: count(r.size_bytes), files: count(r.files), rows: count(r.rows),
    data_files: readDataFiles(r.data_files), skipped_files: count(r.skipped_files),
    evicted: Array.isArray(r.evicted) ? r.evicted.filter((k): k is string => typeof k === 'string').slice(0, 20).map(k => k.slice(0, 240)) : [],
  }
}

function describeFile(f: DatasetFile): string {
  const rows = f.rows === null ? 'rows not counted' : `${f.rows} row${f.rows === 1 ? '' : 's'}`
  return `${f.path} (${f.kind}, ${rows}${f.columns ? `; columns: ${f.columns.join(', ')}` : ''})`
}

/**
 * One line for the stored record of a fetch. The data files and their columns
 * come first: they are what a later request needs, and the next epoch's
 * context shows only the start of a long line.
 */
export function describeDatasetFetch(r: DatasetFetchResult): string {
  if (r.status === 'ok') {
    const size = r.size_bytes === null ? '' : `, ${(r.size_bytes / 1e9).toFixed(3)} GB`
    const where = r.cached ? 'already on the shelf, nothing downloaded' : `fetched${r.files === null ? '' : ` ${r.files} data file${r.files === 1 ? '' : 's'}`}${size}`
    const left = r.skipped_files ? `; ${r.skipped_files} other file${r.skipped_files === 1 ? '' : 's'} of the repository left on the hub (only data files are downloaded, never code)` : ''
    const files = r.data_files.length ? `files: ${r.data_files.map(describeFile).join('; ')}${r.files !== null && r.files > r.data_files.length ? '; and more' : ''}; ` : ''
    const evicted = r.evicted.length ? `; removed from the shelf to make room: ${r.evicted.join(', ')}` : ''
    return `${r.repo}@${r.sha}: ${files}${where}${r.license ? `; license ${r.license}` : ''}${left}${evicted}`
  }
  if (r.status === 'refused') return `refused (${r.rule}): ${r.reason}`
  if (r.status === 'pending') return r.error || 'still fetching'
  return `error: ${r.error || 'unknown'}`
}

/** The dataset a job's sandbox really had mounted, as the Modal controller reported it. */
export interface MountedDataset {
  repo: string
  sha: string
  license: string | null
}

export function normalizeMountedDataset(raw: unknown): MountedDataset | null {
  if (!isPlainObject(raw)) return null
  if (!isValidRepoId(raw.repo) || typeof raw.sha !== 'string' || !SHA.test(raw.sha)) return null
  return { repo: raw.repo, sha: raw.sha, license: text(raw.license, 80) || null }
}

/**
 * The label a GPU job result carries when its sandbox had a dataset mounted.
 * It is built from what the controller mounted, never from what a model
 * asked for or printed.
 */
export function datasetLabel(mounted: MountedDataset, shortSha = false): string {
  return `data from ${mounted.repo}@${shortSha ? mounted.sha.slice(0, 12) : mounted.sha}`
}

// ---------------------------------------------------------------------------
// A Tinker training request that names a shelf dataset instead of examples
// ---------------------------------------------------------------------------

/** Where a training run's examples come from when they are not written inline. */
export interface TinkerDatasetSource {
  repo: string
  sha?: string
  /** A file inside the shelf entry. Needed when the entry holds more than one file with rows. */
  file?: string
  /** The column that holds the user turn, and the one that holds the assistant turn. */
  user_column: string
  assistant_column: string
  /** Text put before every row as a system message, when given. It is text the model wrote, not a column. */
  system?: string
  /** The most rows to use. */
  limit: number
}

export interface TinkerDatasetRequest {
  purpose: string
  base_model: string
  settings: TinkerSettings
  dataset: TinkerDatasetSource
  name?: string
  name_refused?: string
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(o).find(k => !allowed.includes(k))
  return extra === undefined ? null : extra.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_'
}
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Does a "tinker_train" request name a dataset? Only then is it read by this file. */
export function namesDataset(raw: unknown): boolean {
  return isPlainObject(raw) && raw.dataset !== undefined && raw.dataset !== null
}

/**
 * Reads a "tinker_train" request that names a shelf dataset. As strict as
 * the inline form (normalizeTinkerRequest in tinker.ts): any field the lab
 * does not know and any value out of range is a refusal with a reason,
 * never a guess. The base model and the settings are read by the same code.
 */
export function normalizeTinkerDatasetRequest(raw: unknown, allowed: string[] = tinkerBaseModels().models): { request: TinkerDatasetRequest } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'not an object with a "dataset"' }
  const names = tinkerNamesFlag()
  if (raw.examples !== undefined && raw.examples !== null) return { error: 'give "examples" or "dataset", not both' }
  const extra = onlyKeys(raw, names ? ['purpose', 'base_model', 'dataset', 'settings', 'name', 'examples'] : ['purpose', 'base_model', 'dataset', 'settings', 'examples'])
  if (extra) return { error: `unknown field: ${extra}` }
  if (!allowed.length) return { error: 'no base model is allowed' }
  const base = raw.base_model === undefined || raw.base_model === null || raw.base_model === '' ? allowed[0] : raw.base_model
  if (typeof base !== 'string' || !allowed.includes(base)) return { error: `base_model must be one of: ${allowed.join(', ')}` }
  const checked = readSettings(raw.settings)
  if ('error' in checked) return checked

  const d = raw.dataset
  if (!isPlainObject(d)) return { error: 'dataset is not an object' }
  const unknown = onlyKeys(d, ['repo', 'file', 'user_column', 'assistant_column', 'system', 'limit'])
  if (unknown) return { error: `dataset has an unknown field: ${unknown}` }
  const ref = normalizeDatasetRef(d.repo)
  if ('error' in ref) return { error: `dataset.repo: ${ref.error}` }
  if (d.file !== undefined && d.file !== null && !isDataPath(d.file)) return { error: 'dataset.file must be the path of a file inside the dataset' }
  if (!isColumnName(d.user_column) || !isColumnName(d.assistant_column)) {
    return { error: 'dataset.user_column and dataset.assistant_column must be column names (letters, digits, underscore, dot, hyphen and space, at most 64 characters)' }
  }
  if (d.user_column === d.assistant_column) return { error: 'dataset.user_column and dataset.assistant_column must be different columns' }
  let system: string | undefined
  if (d.system !== undefined && d.system !== null) {
    if (typeof d.system !== 'string' || !d.system.trim()) return { error: 'dataset.system must be non-empty text when it is given' }
    if (FORBIDDEN_CHARS.test(d.system) || LONE_SURROGATE.test(d.system)) return { error: 'dataset.system holds a control character or broken text' }
    if (Buffer.byteLength(d.system, 'utf8') > DATASETS_MAX_SYSTEM_BYTES) return { error: `dataset.system holds more than ${DATASETS_MAX_SYSTEM_BYTES} bytes` }
    system = d.system
  }
  const limit = d.limit === undefined || d.limit === null ? DATASETS_DEFAULT_ROWS : d.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < TINKER_MIN_EXAMPLES || limit > TINKER_MAX_EXAMPLES) {
    return { error: `dataset.limit must be a whole number from ${TINKER_MIN_EXAMPLES} to ${TINKER_MAX_EXAMPLES}` }
  }
  // Fewer rows can only take fewer steps, so a request that passes here with
  // its limit passes with whatever the file really holds.
  const steps = plannedSteps(limit, checked.settings)
  if (steps > TINKER_MAX_STEPS) {
    return { error: `with ${limit} rows these settings need ${steps} optimizer steps and a run may take ${TINKER_MAX_STEPS}: lower limit or epochs, or raise batch_size` }
  }
  const purpose = typeof raw.purpose === 'string' ? raw.purpose.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  const named = names && raw.name !== undefined && raw.name !== null && raw.name !== '' ? readAdapterName(raw.name) : null
  return {
    request: {
      purpose, base_model: base, settings: checked.settings,
      dataset: {
        repo: ref.ref.repo, ...(ref.ref.sha ? { sha: ref.ref.sha } : {}),
        ...(typeof d.file === 'string' ? { file: d.file } : {}),
        user_column: d.user_column, assistant_column: d.assistant_column,
        ...(system !== undefined ? { system } : {}), limit,
      },
      ...(named && 'name' in named ? { name: named.name } : {}),
      ...(named && 'error' in named ? { name_refused: named.error } : {}),
    },
  }
}

/**
 * The most a run on this dataset could cost, before one row has been read:
 * the estimate (tinker.ts) for a set of rows that is at least as heavy, in
 * every part of the estimate, as any set the caps allow. It has as many rows
 * as could fit (the row limit, or fewer when the system text alone fills the
 * total), all the text a run may hold, and that text packed into as few rows
 * as the per-example cap allows, because the cost of measuring the held-out
 * slice grows with its largest rows. No real set of rows is all of these at
 * once, so the real rows cost less than this, and usually far less. It is
 * what the Reviewer is told and what the daily budget is checked against
 * before the read; the estimate that is set aside is made from the real rows
 * (tinkerRequestFromRows).
 */
export function datasetRunCeiling(request: Pick<TinkerDatasetRequest, 'base_model' | 'settings' | 'dataset'>): TinkerEstimate {
  const system = request.dataset.system
  // Every row holds the system text and at least one byte in each turn, so
  // the total size cap also bounds how many rows a run can hold.
  const least = (system ? Buffer.byteLength(system, 'utf8') : 0) + 2
  const rows = Math.max(1, Math.min(request.dataset.limit, Math.floor(TINKER_MAX_DATASET_BYTES / least)))
  let left = TINKER_MAX_DATASET_BYTES
  const examples: TinkerExample[] = []
  for (let i = 0; i < rows; i++) {
    const take = Math.min(TINKER_MAX_EXAMPLE_BYTES, left)
    left -= take
    // Only the sizes and the number of messages matter to the estimate, so the text is filler.
    examples.push({
      messages: [
        ...(system ? [{ role: 'system' as const, content: '' }] : []),
        { role: 'user' as const, content: 'a'.repeat(take) }, { role: 'assistant' as const, content: '' },
      ],
    })
  }
  return estimateTinkerRun({ base_model: request.base_model, settings: request.settings, examples })
}

/** What a dataset training request asks for, in one line, for records made before the rows are read. */
export function datasetRequestSummary(request: TinkerDatasetRequest): string {
  const d = request.dataset
  return `LoRA fine-tune of ${request.base_model} on up to ${d.limit} rows of ${d.repo}${d.sha ? `@${d.sha.slice(0, 12)}` : ''}${d.file ? ` (${d.file})` : ''}${request.purpose ? `: ${request.purpose}` : ''}`
}

// ---------------------------------------------------------------------------
// What the reader sends back
// ---------------------------------------------------------------------------

const SKIP_REASONS = ['not_a_row', 'column_missing', 'not_text', 'empty', 'bad_text', 'too_long', 'duplicate'] as const
const STOP_REASONS = ['limit', 'total_bytes', 'end_of_file', 'scan_limit'] as const

export interface DatasetRowsResult {
  /** ok: rows read. refused: the reader said no (not on the shelf, no such file or column). error: it failed. failed: no usable answer. pending: still reading when the lab stopped waiting. */
  status: 'ok' | 'refused' | 'error' | 'failed' | 'pending'
  repo: string
  sha: string | null
  license: string | null
  file: string | null
  rows_scanned: number | null
  rows_used: number | null
  /** Rows left out, by reason. */
  skipped: Record<string, number>
  /** Why reading stopped: the row limit, the total size limit, the end of the file, or the scan limit. */
  stopped: string | null
  /** The examples exactly as the reader sent them. Not checked here: normalizeTinkerRequest reads them like inline examples. */
  examples: unknown[]
  rule?: string
  reason?: string
  error?: string
  wall_seconds: number | null
  cost_usd: number
}

/** Reads the reader's answer. An "ok" that does not name the dataset asked for, a commit and a file is not an ok. */
export function normalizeRowsResult(raw: unknown, asked: Pick<TinkerDatasetSource, 'repo' | 'sha'>): DatasetRowsResult {
  const r = isPlainObject(raw) ? raw : {}
  const wall = typeof r.wall_seconds === 'number' && Number.isFinite(r.wall_seconds) && r.wall_seconds >= 0 ? r.wall_seconds : null
  const base: DatasetRowsResult = {
    status: 'failed', repo: asked.repo, sha: null, license: null, file: null, rows_scanned: null, rows_used: null, skipped: {},
    stopped: null, examples: [], wall_seconds: wall, cost_usd: estimateDatasetReadCost(wall),
  }
  if (r.status === 'refused') return { ...base, status: 'refused', rule: text(r.rule, 30) || 'rule', reason: text(r.reason, 500) || 'refused' }
  if (r.status === 'error') return { ...base, status: 'error', error: text(r.error, 400) || 'the reader failed' }
  if (r.status !== 'ok') return { ...base, error: 'the reader gave no usable answer' }
  if (r.repo !== asked.repo || typeof r.sha !== 'string' || !SHA.test(r.sha) || (asked.sha && r.sha !== asked.sha) || !isDataPath(r.file) || !Array.isArray(r.examples)) {
    return { ...base, error: 'the reader\'s answer did not name the dataset, a commit and a file' }
  }
  const skipped: Record<string, number> = {}
  if (isPlainObject(r.skipped)) {
    for (const reason of SKIP_REASONS) {
      const n = count(r.skipped[reason])
      if (n) skipped[reason] = n
    }
  }
  return {
    ...base, status: 'ok', sha: r.sha, license: text(r.license, 80) || null, file: r.file,
    rows_scanned: count(r.rows_scanned), rows_used: r.examples.length, skipped,
    stopped: (STOP_REASONS as readonly unknown[]).includes(r.stopped) ? r.stopped as string : null,
    examples: r.examples.slice(0, TINKER_MAX_EXAMPLES + 1),
  }
}

/** The stored record of where a run's examples came from. Public; it holds no row text. */
export interface TinkerDatasetRecord {
  repo: string
  sha: string
  license: string | null
  file: string
  user_column: string
  assistant_column: string
  /** Whether a system message, written by the model, was put before every row. */
  system: boolean
  limit: number
  rows_scanned: number | null
  rows_used: number
  skipped: Record<string, number>
  stopped: string | null
  order: 'the first rows that fit, in file order'
}

/**
 * Turns the rows the reader sent into the same request an inline dataset
 * makes. The examples go through normalizeTinkerRequest, so every check a
 * model's own examples get (the format, the per-example and total size, the
 * number of examples, no two alike, the step limit) is made on these too,
 * by the same code. Nothing is trusted because the reader sent it.
 */
export function tinkerRequestFromRows(asked: TinkerDatasetRequest, rows: DatasetRowsResult, allowed: string[] = tinkerBaseModels().models):
  { request: TinkerRequest; record: TinkerDatasetRecord } | { error: string } {
  if (rows.status !== 'ok' || !rows.sha || !rows.file) return { error: describeRows(rows) }
  if (rows.examples.length < TINKER_MIN_EXAMPLES) {
    return { error: `only ${rows.examples.length} row${rows.examples.length === 1 ? '' : 's'} of ${rows.file} could be used and a run needs ${TINKER_MIN_EXAMPLES} (${describeSkipped(rows)})` }
  }
  if (rows.examples.length > asked.dataset.limit) return { error: 'the reader sent more rows than the limit asked for' }
  const checked = normalizeTinkerRequest({
    purpose: asked.purpose, base_model: asked.base_model, examples: rows.examples, settings: asked.settings,
    ...(tinkerNamesFlag() && asked.name ? { name: asked.name } : {}),
  }, allowed)
  if ('error' in checked) return { error: `the rows the lab read did not pass the checks every dataset gets: ${checked.error}` }
  // The shape the mapping promises: an optional system message, one user turn, one assistant turn.
  const system = asked.dataset.system
  for (const example of checked.request.examples) {
    const m = example.messages
    const ok = system ? m.length === 3 && m[0].role === 'system' && m[0].content === system : m.length === 2
    if (!ok) return { error: 'the rows the lab read are not the mapping that was asked for' }
  }
  return {
    request: checked.request,
    record: {
      repo: rows.repo, sha: rows.sha, license: rows.license, file: rows.file,
      user_column: asked.dataset.user_column, assistant_column: asked.dataset.assistant_column, system: Boolean(system),
      limit: asked.dataset.limit, rows_scanned: rows.rows_scanned, rows_used: checked.request.examples.length,
      skipped: rows.skipped, stopped: rows.stopped, order: 'the first rows that fit, in file order',
    },
  }
}

function describeSkipped(r: Pick<DatasetRowsResult, 'skipped' | 'rows_scanned'>): string {
  const parts = Object.entries(r.skipped).map(([reason, n]) => `${n} ${reason.replace(/_/g, ' ')}`)
  return `${r.rows_scanned ?? '?'} rows looked at${parts.length ? `; left out: ${parts.join(', ')}` : ''}`
}

/** One line about a read, for the stored record. */
export function describeRows(r: DatasetRowsResult): string {
  if (r.status === 'ok') return `${r.rows_used} rows of ${r.repo}@${r.sha} ${r.file} (${describeSkipped(r)}${r.stopped ? `; stopped at ${r.stopped.replace(/_/g, ' ')}` : ''})`
  if (r.status === 'refused') return `the lab's reader refused (${r.rule}): ${r.reason}`
  if (r.status === 'pending') return r.error || 'the lab\'s reader was still reading'
  return `the lab's reader failed: ${r.error || 'unknown'}`
}

/** "repo@sha" with the file and rows, for the one-line summary of a run. */
export function datasetRecordLine(record: TinkerDatasetRecord): string {
  return `${record.rows_used} rows of ${record.repo}@${record.sha} (${record.file}; user turn from "${record.user_column}", assistant turn from "${record.assistant_column}"${record.system ? ', with a system message' : ''})`
}

/** Reads a stored record back. null when it is not one. */
export function readDatasetRecord(raw: unknown): TinkerDatasetRecord | null {
  if (!isPlainObject(raw)) return null
  if (!isValidRepoId(raw.repo) || typeof raw.sha !== 'string' || !SHA.test(raw.sha) || !isDataPath(raw.file)) return null
  if (!isColumnName(raw.user_column) || !isColumnName(raw.assistant_column)) return null
  const used = count(raw.rows_used)
  if (used === null) return null
  const skipped: Record<string, number> = {}
  if (isPlainObject(raw.skipped)) {
    for (const reason of SKIP_REASONS) {
      const n = count(raw.skipped[reason])
      if (n) skipped[reason] = n
    }
  }
  return {
    repo: raw.repo, sha: raw.sha, license: text(raw.license, 80) || null, file: raw.file,
    user_column: raw.user_column, assistant_column: raw.assistant_column, system: raw.system === true,
    limit: count(raw.limit) ?? used, rows_scanned: count(raw.rows_scanned), rows_used: used, skipped,
    stopped: (STOP_REASONS as readonly unknown[]).includes(raw.stopped) ? raw.stopped as string : null,
    order: 'the first rows that fit, in file order',
  }
}

// ---------------------------------------------------------------------------
// What the models are told
// ---------------------------------------------------------------------------

/**
 * One paragraph about the tool, only while it is on (the callers check). It
 * says what the tool does and where its limits are, and nothing about which
 * dataset to ask for or what to do with one. `gpu` and `tinker` say which of
 * the two readers are on, so nothing is described that is not there.
 */
export function datasetsNote(opts: { perDay: number; gpu: boolean; tinker: boolean; gpuJobMaxS: number }): string {
  const limits = datasetsLimits()
  const gpu = opts.gpu
    ? ` A GPU job that names a fetched dataset reads that one entry, read-only, at /datasets; its network stays off and it is still stopped after ${opts.gpuJobMaxS} s. The stored result of such a job is labelled "data from <repo>@<commit>" by what the lab mounted, and what the job prints is still self-reported.`
    : ''
  const tinker = opts.tinker
    ? ` A Tinker training request may name a fetched dataset instead of writing its examples: it names one file, the column that holds the user turn and the column that holds the assistant turn, optional system text of its own, and a row limit. The lab's own code reads the rows, not yours: the first rows that fit, in file order, each row one user turn and one assistant turn. A row is left out, and counted, when a cell is missing, is not text, is empty, holds a control character, would pass ${TINKER_MAX_EXAMPLE_BYTES} bytes, or repeats an earlier row; reading stops at the row limit or at ${TINKER_MAX_DATASET_BYTES} bytes of text in all. Nothing is cut to fit. Only top-level columns that hold text can be mapped, and only ones whose names are letters, digits, underscore, dot, hyphen and space, at most 64 characters. The run then goes on exactly like one with inline examples: the same limits, the same cost estimate and caps, made from the rows that were really read before anything is set aside, and the same held-out slice. Its record names the dataset, the commit, the file, the columns and how many rows were used and left out.`
    : ''
  return `Public datasets: as Executor you may ask the lab for one public Hugging Face dataset repository by its id, written org/name (and a revision if you want one). The lab's own code downloads it, not yours, and only when all of this holds: it is public and not gated (the lab uses no Hugging Face account), every license its card states is one of ${limits.licenses.join(', ')}, and its data files total at most ${limits.max_gb} GB. Only parquet, jsonl, json, csv, tsv, txt and arrow files are downloaded; a loading script, any other code and every other file is left where it is and never run, so a dataset that exists only as a script or an archive is refused. A refusal is stored with its reason. The fetch's record lists the data files with their rows and column names where the lab could count them. The shelf holds ${limits.shelf_gb} GB; the least recently used datasets are removed to make room, and one in use is not removed. At most ${opts.perDay} request${opts.perDay === 1 ? '' : 's'} a day.${gpu}${tinker}`
}
