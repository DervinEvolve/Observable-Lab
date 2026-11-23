/**
 * What the database holds for Tinker training (tinker.ts):
 *
 *   tinker_runs          one row per training run: who asked, the dataset's
 *                        hash and size, the settings, the lab-measured
 *                        scores, the estimated cost, and the saved adapter.
 *   tinker_spend_days    what Tinker use has been set aside and spent per
 *                        UTC day, per scope. This is where the daily caps
 *                        are enforced.
 *   trained_chat_rate    how many messages an address, and an address with
 *                        a browser string, has sent, by keyed hashes. No
 *                        address is stored.
 *   trained_chat_calls   one row of counts per visitor chat call. No text.
 *   tinker_keeps         one row per adapter that is marked to keep, or is
 *                        being kept. Its slot number is the cap: there are
 *                        only as many slots as adapters may be kept.
 *
 * The caps are held by the database, not by this code's own arithmetic. A
 * reservation is one conditional UPDATE that adds the amount only while
 * spent + reserved + amount stays within the cap; Postgres re-checks the
 * condition under the row lock, so two requests arriving together cannot
 * both pass it. After the work, the reservation is replaced by what the
 * measured tokens cost at the published prices.
 *
 * Scope 'all' counts every use of Tinker (training runs, calls to trained
 * adapters through the lab model endpoint, visitor chat) against
 * LAB_TINKER_DAILY_USD. Scope 'chat' counts visitor chat against
 * LAB_TINKER_CHAT_DAILY_USD as well.
 *
 * The first four tables are created at runtime, like the other run 2 tables.
 * tinker_keeps, and the two name columns on tinker_runs, are added only by
 * the paths that name or keep an adapter (ensureTinkerExtras): a lab that
 * never switches those on never has them, and none of the statements the
 * other paths run mention them.
 */
import { createHash, createHmac } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'
import { sql } from '@vercel/postgres'
import { sanitizeOutput } from './sprites.js'
import { modelDisplayName } from './types.js'
import {
  isAdapterSlug, isExternalPath, isSamplerPath, tinkerKeepFlag, tinkerNamesFlag, tinkerOriginFlag, type TinkerRequest, type TinkerRunResult,
} from './tinker.js'
import type { RlProgress, RlRecord, TinkerRlRequest, TinkerRlResult } from './tinker-rl.js'
import { adapterNameKey } from './tinker-names.js'

export type TinkerScope = 'all' | 'chat'

let tablesReady: Promise<void> | null = null
export function ensureTinkerTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS tinker_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          experiment_id UUID NOT NULL,
          epoch INTEGER NOT NULL,
          model TEXT NOT NULL,
          assigned_model TEXT,
          slug TEXT NOT NULL UNIQUE,
          base_model TEXT NOT NULL,
          purpose TEXT,
          dataset_sha256 TEXT NOT NULL,
          dataset_examples INTEGER NOT NULL,
          dataset_bytes INTEGER NOT NULL,
          settings JSONB NOT NULL,
          split_salt TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          call_id TEXT,
          spend_day TEXT NOT NULL,
          reserved_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          cost_usd NUMERIC(12,6),
          result JSONB,
          sampler_path TEXT,
          expires_at TIMESTAMP WITH TIME ZONE,
          finished_at TIMESTAMP WITH TIME ZONE,
          UNIQUE (experiment_id, epoch)
        )
      `
      await sql`CREATE INDEX IF NOT EXISTS idx_tinker_runs_status ON tinker_runs(status, created_at)`
      // Tinker RL (tinker-rl.ts) shares this table: kind is 'rl' for its runs and empty for training runs,
      // progress is the latest record the runner wrote while the run went, rl is what was asked.
      await sql`ALTER TABLE tinker_runs ADD COLUMN IF NOT EXISTS kind TEXT`
      await sql`ALTER TABLE tinker_runs ADD COLUMN IF NOT EXISTS progress JSONB`
      await sql`ALTER TABLE tinker_runs ADD COLUMN IF NOT EXISTS rl JSONB`
      await sql`
        CREATE TABLE IF NOT EXISTS tinker_spend_days (
          day TEXT NOT NULL,
          scope TEXT NOT NULL,
          reserved_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
          spent_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
          PRIMARY KEY (day, scope)
        )
      `
      await sql`
        CREATE TABLE IF NOT EXISTS trained_chat_rate (
          visitor TEXT NOT NULL,
          bucket TEXT NOT NULL,
          n INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          PRIMARY KEY (visitor, bucket)
        )
      `
      await sql`
        CREATE TABLE IF NOT EXISTS trained_chat_calls (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          slug TEXT NOT NULL,
          status TEXT NOT NULL,
          http_status INTEGER,
          turns INTEGER NOT NULL DEFAULT 0,
          prompt_chars INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          duration_ms INTEGER
        )
      `
    })().catch(e => {
      tablesReady = null
      throw e
    })
  }
  return tablesReady
}

let extrasReady: Promise<void> | null = null
/**
 * What naming and keeping add to the database: two columns on tinker_runs
 * for a display name, and the table of kept adapters. A name is unique among
 * the rows that hold a name key, which the database enforces; a row gives its
 * key up when its adapter is gone (claimAdapterName). A kept adapter holds a
 * slot, and slots are numbered 1 to the cap, so the primary key is the cap.
 * One epoch may ask for one keep, which the second index enforces.
 */
export function ensureTinkerExtras(): Promise<void> {
  if (!extrasReady) {
    extrasReady = (async () => {
      await ensureTinkerTables()
      await sql`ALTER TABLE tinker_runs ADD COLUMN IF NOT EXISTS display_name TEXT`
      await sql`ALTER TABLE tinker_runs ADD COLUMN IF NOT EXISTS name_key TEXT`
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tinker_runs_name_key ON tinker_runs(name_key) WHERE name_key IS NOT NULL`
      await sql`
        CREATE TABLE IF NOT EXISTS tinker_keeps (
          slot INTEGER PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          kept_by TEXT NOT NULL,
          reason TEXT,
          experiment_id TEXT,
          epoch INTEGER,
          job_id TEXT NOT NULL,
          call_id TEXT,
          requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          kept_at TIMESTAMP WITH TIME ZONE,
          detail JSONB
        )
      `
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tinker_keeps_epoch ON tinker_keeps(experiment_id, epoch) WHERE epoch IS NOT NULL`
    })().catch(e => {
      extrasReady = null
      throw e
    })
  }
  return extrasReady
}

/** The UTC day a moment falls on, as YYYY-MM-DD. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

const usd = (v: number) => (Number.isFinite(v) && v > 0 ? Math.ceil(v * 1e6) / 1e6 : 0)

// ---------------------------------------------------------------------------
// The daily caps
// ---------------------------------------------------------------------------

export type Reservation =
  | { ok: true; day: string; scope: TinkerScope; usd: number }
  | { ok: false; reason: string }

/**
 * Sets `amountUsd` aside under one scope's cap for today, or says why not.
 * The UPDATE is the gate: it adds the amount only while what is already
 * spent and set aside, plus this, stays within the cap.
 */
export async function reserveTinkerSpend(scope: TinkerScope, amountUsd: number, capUsd: number, now: Date = new Date()): Promise<Reservation> {
  const amount = usd(amountUsd)
  if (!(capUsd > 0)) return { ok: false, reason: 'the daily cap is 0' }
  if (amount > capUsd) return { ok: false, reason: `$${amount.toFixed(4)} is more than the whole daily cap of $${capUsd.toFixed(2)}` }
  await ensureTinkerTables()
  const day = utcDay(now)
  await sql`INSERT INTO tinker_spend_days (day, scope) VALUES (${day}, ${scope}) ON CONFLICT (day, scope) DO NOTHING`
  const r = await sql`
    UPDATE tinker_spend_days
    SET reserved_usd = reserved_usd + ${amount}
    WHERE day = ${day} AND scope = ${scope} AND spent_usd + reserved_usd + ${amount} <= ${capUsd}
    RETURNING spent_usd, reserved_usd
  `
  if (r.rows[0]) return { ok: true, day, scope, usd: amount }
  return { ok: false, reason: `it would pass today's cap of $${capUsd.toFixed(2)} (UTC)` }
}

/** Replaces a reservation with what the work really cost by the lab's estimate. Never throws. */
export async function settleTinkerSpend(reservation: { day: string; scope: TinkerScope; usd: number }, actualUsd: number): Promise<void> {
  try {
    await sql`
      UPDATE tinker_spend_days
      SET reserved_usd = GREATEST(0, reserved_usd - ${usd(reservation.usd)}), spent_usd = spent_usd + ${usd(actualUsd)}
      WHERE day = ${reservation.day} AND scope = ${reservation.scope}
    `
  } catch (e) {
    console.warn('[tinker] could not settle a reservation (it stays set aside for the day):', e instanceof Error ? e.message : e)
  }
}

/** Today's totals for one scope: what was spent and what is still set aside. */
export async function tinkerSpendToday(scope: TinkerScope, now: Date = new Date()): Promise<{ spent_usd: number; reserved_usd: number }> {
  await ensureTinkerTables()
  const r = await sql`SELECT spent_usd, reserved_usd FROM tinker_spend_days WHERE day = ${utcDay(now)} AND scope = ${scope}`
  return { spent_usd: Number(r.rows[0]?.spent_usd) || 0, reserved_usd: Number(r.rows[0]?.reserved_usd) || 0 }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface TinkerRunRow {
  id: string
  experiment_id: string
  epoch: number
  model: string
  assigned_model: string | null
  slug: string
  base_model: string
  purpose: string | null
  dataset_sha256: string
  dataset_examples: number
  dataset_bytes: number
  settings: Record<string, unknown>
  split_salt: string
  status: string
  reason: string | null
  call_id: string | null
  spend_day: string
  reserved_usd: number
  cost_usd: number | null
  result: Record<string, unknown> | null
  sampler_path: string | null
  expires_at: string | null
  created_at: string
  finished_at: string | null
  /** The name its author gave the adapter, when names were on and the name was free. */
  display_name: string | null
  /** 'rl' for a Tinker RL run (tinker-rl.ts). Null for a training run. */
  kind: string | null
  /** The latest progress record of an RL run, as the lab stored it. */
  progress: Record<string, unknown> | null
  /** What an RL run was asked to do: its rubric, settings and estimate (RlRecord in tinker-rl.ts). */
  rl: Record<string, unknown> | null
  /**
   * Only on a run whose examples the lab read from a shelf dataset
   * (datasets.ts): the repository, commit, file, columns and row counts.
   */
  dataset_source?: Record<string, unknown>
}

function json(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)

function runRow(row: Record<string, unknown>): TinkerRunRow {
  return {
    id: String(row.id ?? ''),
    experiment_id: String(row.experiment_id ?? ''),
    epoch: Number(row.epoch) || 0,
    model: String(row.model ?? ''),
    assigned_model: row.assigned_model ? String(row.assigned_model) : null,
    slug: String(row.slug ?? ''),
    base_model: String(row.base_model ?? ''),
    purpose: row.purpose ? String(row.purpose) : null,
    dataset_sha256: String(row.dataset_sha256 ?? ''),
    dataset_examples: Number(row.dataset_examples) || 0,
    dataset_bytes: Number(row.dataset_bytes) || 0,
    settings: json(row.settings) ?? {},
    split_salt: String(row.split_salt ?? ''),
    status: String(row.status ?? ''),
    reason: row.reason ? String(row.reason) : null,
    call_id: row.call_id ? String(row.call_id) : null,
    spend_day: String(row.spend_day ?? ''),
    reserved_usd: Number(row.reserved_usd) || 0,
    cost_usd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd) || 0,
    result: json(row.result),
    sampler_path: row.sampler_path ? String(row.sampler_path) : null,
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at) ?? '',
    finished_at: iso(row.finished_at),
    display_name: row.display_name ? String(row.display_name).slice(0, 40) : null,
    kind: row.kind ? String(row.kind) : null,
    progress: json(row.progress),
    rl: json(row.rl),
    ...(json(row.dataset_source) ? { dataset_source: json(row.dataset_source) as Record<string, unknown> } : {}),
  }
}

let datasetColumnReady: Promise<void> | null = null
/**
 * What training on a shelf dataset adds to the database: one column on
 * tinker_runs for where the examples came from. It is added the first time
 * such a run is opened, so a lab that never uses datasets never has it.
 */
export function ensureTinkerDatasetColumn(): Promise<void> {
  if (!datasetColumnReady) {
    datasetColumnReady = (async () => {
      await ensureTinkerTables()
      await sql`ALTER TABLE tinker_runs ADD COLUMN IF NOT EXISTS dataset_source JSONB`
    })().catch(e => {
      datasetColumnReady = null
      throw e
    })
  }
  return datasetColumnReady
}

/** Writes where a run's examples came from onto its row. Throws when it could not be stored. */
export async function setRunDatasetSource(runId: string, source: Record<string, unknown>): Promise<void> {
  await ensureTinkerDatasetColumn()
  await sql`UPDATE tinker_runs SET dataset_source = ${JSON.stringify(source)} WHERE id = ${runId}`
}

/**
 * Opens the one run an epoch may have. The row is written before anything is
 * started, and (experiment, epoch) is unique, so an epoch whose follow-up is
 * run twice cannot start a second run: null means there already is one.
 */
export async function openTinkerRun(params: {
  experimentId: string
  epoch: number
  model: string
  assignedModel: string
  slug: string
  request: TinkerRequest
  splitSalt: string
  spendDay: string
  reservedUsd: number
}): Promise<TinkerRunRow | null> {
  await ensureTinkerTables()
  const r = await sql`
    INSERT INTO tinker_runs (
      experiment_id, epoch, model, assigned_model, slug, base_model, purpose, dataset_sha256, dataset_examples, dataset_bytes,
      settings, split_salt, status, spend_day, reserved_usd
    ) VALUES (
      ${params.experimentId}, ${params.epoch}, ${params.model}, ${params.assignedModel}, ${params.slug}, ${params.request.base_model},
      ${sanitizeOutput(params.request.purpose).slice(0, 200)}, ${params.request.dataset_sha256}, ${params.request.examples.length},
      ${params.request.dataset_bytes}, ${JSON.stringify(params.request.settings)}, ${params.splitSalt}, ${'reserved'},
      ${params.spendDay}, ${usd(params.reservedUsd)}
    )
    ON CONFLICT (experiment_id, epoch) DO NOTHING
    RETURNING *
  `
  return r.rows[0] ? runRow(r.rows[0] as Record<string, unknown>) : null
}

/**
 * Opens the one run an epoch may have, for a Tinker RL request. The same
 * table and the same rule as openTinkerRun (an epoch has one run of either
 * kind): null means the epoch already has one. `dataset_examples` holds the
 * number of tasks and `settings` the RL settings; `rl` is the public record
 * of what was asked.
 */
export async function openTinkerRlRun(params: {
  experimentId: string
  epoch: number
  model: string
  assignedModel: string
  slug: string
  request: TinkerRlRequest
  record: RlRecord
  splitSalt: string
  spendDay: string
  reservedUsd: number
}): Promise<TinkerRunRow | null> {
  await ensureTinkerTables()
  const r = await sql`
    INSERT INTO tinker_runs (
      experiment_id, epoch, model, assigned_model, slug, base_model, purpose, dataset_sha256, dataset_examples, dataset_bytes,
      settings, split_salt, status, spend_day, reserved_usd, kind, rl
    ) VALUES (
      ${params.experimentId}, ${params.epoch}, ${params.model}, ${params.assignedModel}, ${params.slug}, ${params.request.base_model},
      ${sanitizeOutput(params.request.purpose).slice(0, 200)}, ${params.request.dataset_sha256}, ${params.request.tasks.length},
      ${params.request.dataset_bytes}, ${JSON.stringify(params.request.settings)}, ${params.splitSalt}, ${'reserved'},
      ${params.spendDay}, ${usd(params.reservedUsd)}, ${'rl'}, ${JSON.stringify(params.record)}
    )
    ON CONFLICT (experiment_id, epoch) DO NOTHING
    RETURNING *
  `
  return r.rows[0] ? runRow(r.rows[0] as Record<string, unknown>) : null
}

/** Stores the latest progress record of a run that is still open. Never throws: a record that could not be stored costs the room a view, not the run. */
export async function setRlProgress(id: string, progress: RlProgress): Promise<void> {
  try {
    // Never backwards: a slower, older answer that lands late does not replace a newer record. Records with no counter (an older runner) are stored as they come.
    await sql`
      UPDATE tinker_runs SET progress = ${JSON.stringify(progress)}
      WHERE id = ${id} AND status IN ('reserved', 'running')
        AND (${progress.seq}::int IS NULL OR progress IS NULL OR (progress->>'seq') IS NULL OR (progress->>'seq')::int < ${progress.seq}::int)
    `
  } catch (e) {
    console.warn('[tinker] could not store the progress of a run:', e instanceof Error ? e.message : e)
  }
}

/** The newest RL run, whatever state it is in. Only looks: null when there is none or the table does not exist yet. */
export async function latestRlRun(): Promise<TinkerRunRow | null> {
  try {
    const r = await sql`SELECT * FROM tinker_runs WHERE kind = 'rl' ORDER BY created_at DESC LIMIT 1`
    return r.rows[0] ? runRow(r.rows[0] as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Short, cleaned text for the stored result of an RL run: the samples are model output. */
function cleanRlResult(result: TinkerRlResult): string {
  const text = (v: string, max: number) => sanitizeOutput(v).slice(0, max)
  return JSON.stringify({
    kind: 'rl',
    n_tasks: result.n_tasks, n_train: result.n_train, n_holdout: result.n_holdout,
    steps_planned: result.steps_planned, steps_done: result.steps_done, steps_trained: result.steps_trained, stopped_early: result.stopped_early ? text(result.stopped_early, 200) : null,
    max_reward: result.max_reward, score_before: result.score_before, score_after: result.score_after,
    train_score_first: result.train_score_first, train_score_last: result.train_score_last,
    step_means: result.step_means, step_frac_max: result.step_frac_max,
    tokens: result.tokens, ttl_seconds: result.ttl_seconds, wall_seconds: result.wall_seconds, stage: result.stage,
    samples: result.samples.map(s => ({ prompt: text(s.prompt, 300), completion: text(s.completion, 600), reward: s.reward })),
    scores: 'held-out rubric scores measured by the lab',
    cost: 'estimate from published prices',
    ...(isExternalPath(result.external_path) ? { external_path: result.external_path } : {}),
  })
}

/**
 * Closes an RL run, with the same rule as finishTinkerRun: only a run that is
 * still open is closed, and the row comes back only to the caller that closed
 * it, so two requests collecting one result cannot both settle its money.
 */
export async function finishTinkerRlRun(id: string, params: {
  status: 'ok' | 'refused' | 'error' | 'failed' | 'lost'
  reason: string | null
  costUsd: number
  result: TinkerRlResult | null
  expiresAt: string | null
  progress: RlProgress | null
}): Promise<TinkerRunRow | null> {
  const path = params.status === 'ok' && params.result && isSamplerPath(params.result.sampler_path) ? params.result.sampler_path : null
  const r = await sql`
    UPDATE tinker_runs
    SET status = ${params.status}, reason = ${params.reason ? sanitizeOutput(params.reason).slice(0, 500) : null},
      cost_usd = ${usd(params.costUsd)}, result = ${params.result ? cleanRlResult(params.result) : null},
      progress = COALESCE(${params.progress ? JSON.stringify(params.progress) : null}::jsonb, progress),
      sampler_path = ${path}, expires_at = ${path ? params.expiresAt : null}, finished_at = NOW()
    WHERE id = ${id} AND status IN ('reserved', 'running')
    RETURNING *
  `
  return r.rows[0] ? runRow(r.rows[0] as Record<string, unknown>) : null
}

const UNIQUE_VIOLATION = '23505'

/**
 * Gives a run's adapter its display name, if no other adapter has it. "Has
 * it" means a run that is still open, or an adapter that is still alive
 * (kept ones are alive for as long as they are kept): any other row that
 * holds the name gives it up first. Then the name is written, and the unique
 * index decides: two runs asking for one name at the same moment cannot both
 * get it. False means the name is taken. Names are compared by their key
 * (tinker-names.ts), so case, separators and look-alike characters do not
 * make a name different.
 */
export async function claimAdapterName(runId: string, name: string, now: Date = new Date()): Promise<boolean> {
  await ensureTinkerExtras()
  const key = adapterNameKey(name)
  await sql`
    UPDATE tinker_runs SET name_key = NULL
    WHERE name_key = ${key} AND id <> ${runId}
      AND status NOT IN ('reserved', 'running')
      AND NOT (status = 'ok' AND expires_at > ${now.toISOString()})
  `
  try {
    const r = await sql`UPDATE tinker_runs SET display_name = ${name}, name_key = ${key} WHERE id = ${runId} RETURNING id`
    return Boolean(r.rows[0])
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === UNIQUE_VIOLATION) return false
    throw e
  }
}

/** Takes an adapter's display name away (the owner's route). True when it had one. */
export async function clearAdapterName(slug: string): Promise<boolean> {
  if (!isAdapterSlug(slug)) return false
  await ensureTinkerExtras()
  const r = await sql`UPDATE tinker_runs SET display_name = NULL, name_key = NULL WHERE slug = ${slug} AND display_name IS NOT NULL RETURNING id`
  return Boolean(r.rows[0])
}

/** Marks a run as started on Modal, with the id its result is collected by. */
export async function markTinkerRunStarted(id: string, callId: string): Promise<void> {
  await sql`UPDATE tinker_runs SET status = ${'running'}, call_id = ${callId} WHERE id = ${id} AND status = ${'reserved'}`
}

/** Short, cleaned text for the stored result: samples are model output. */
function cleanResult(result: TinkerRunResult): string {
  const text = (v: string, max: number) => sanitizeOutput(v).slice(0, max)
  return JSON.stringify({
    n_train: result.n_train, n_holdout: result.n_holdout,
    steps_planned: result.steps_planned, steps_done: result.steps_done, stopped_early: result.stopped_early ? text(result.stopped_early, 200) : null,
    holdout_loss_before: result.holdout_loss_before, holdout_loss_after: result.holdout_loss_after,
    train_loss_first: result.train_loss_first, train_loss_last: result.train_loss_last,
    tokens: result.tokens, ttl_seconds: result.ttl_seconds, wall_seconds: result.wall_seconds, stage: result.stage,
    samples: result.samples.map(s => ({ prompt: text(s.prompt, 300), completion: text(s.completion, 600) })),
    scores: 'held-out loss measured by the lab',
    cost: 'estimate from published prices',
    // Present only when the runner was asked to save weights for download (adapters can be kept).
    ...(isExternalPath(result.external_path) ? { external_path: result.external_path } : {}),
  })
}

/**
 * Closes a run. Only a run that is still open (reserved or running) is
 * closed, and the row comes back only to the caller that closed it, so two
 * requests collecting the same result cannot both settle its money.
 */
export async function finishTinkerRun(id: string, params: {
  status: 'ok' | 'refused' | 'error' | 'failed' | 'lost'
  reason: string | null
  costUsd: number
  result: TinkerRunResult | null
  expiresAt: string | null
}): Promise<TinkerRunRow | null> {
  const path = params.status === 'ok' && params.result && isSamplerPath(params.result.sampler_path) ? params.result.sampler_path : null
  const r = await sql`
    UPDATE tinker_runs
    SET status = ${params.status}, reason = ${params.reason ? sanitizeOutput(params.reason).slice(0, 500) : null},
      cost_usd = ${usd(params.costUsd)}, result = ${params.result ? cleanResult(params.result) : null},
      sampler_path = ${path}, expires_at = ${path ? params.expiresAt : null}, finished_at = NOW()
    WHERE id = ${id} AND status IN ('reserved', 'running')
    RETURNING *
  `
  return r.rows[0] ? runRow(r.rows[0] as Record<string, unknown>) : null
}

/**
 * Runs that were opened and not closed yet, oldest first, whichever
 * experiment they belong to: a run still owes its record and its cost after
 * its experiment was archived or replaced. `createTables: false` is for a
 * server where the tool is switched off: it only looks, and the caller
 * treats a failure (no such table) as no runs.
 */
export async function openTinkerRuns(opts: { createTables?: boolean } = {}): Promise<TinkerRunRow[]> {
  if (opts.createTables !== false) await ensureTinkerTables()
  const r = await sql`
    SELECT * FROM tinker_runs
    WHERE status IN ('reserved', 'running')
    ORDER BY created_at ASC
    LIMIT 5
  `
  return r.rows.map(row => runRow(row as Record<string, unknown>))
}

/**
 * Runs that count toward today's limit (LAB_TINKER_PER_DAY): every run that
 * was opened on this UTC day, except one that was closed at no cost (it never
 * started, or the runner refused it before training). A run that is still
 * training counts from the moment it is opened, which is why this is read
 * from tinker_runs and not from tool_runs, where a run appears only once its
 * result has been collected.
 */
export async function tinkerRunsToday(now: Date = new Date()): Promise<number> {
  await ensureTinkerTables()
  const r = await sql`
    SELECT COUNT(*) AS n FROM tinker_runs
    WHERE spend_day = ${utcDay(now)} AND (status IN ('reserved', 'running', 'ok') OR COALESCE(cost_usd, 0) > 0) AND kind IS DISTINCT FROM 'rl'
  `
  return Number(r.rows[0]?.n) || 0
}

/** The same count for Tinker RL runs (LAB_TINKER_RL_PER_DAY): they have a limit of their own. */
export async function tinkerRlRunsToday(now: Date = new Date()): Promise<number> {
  await ensureTinkerTables()
  const r = await sql`
    SELECT COUNT(*) AS n FROM tinker_runs
    WHERE spend_day = ${utcDay(now)} AND (status IN ('reserved', 'running', 'ok') OR COALESCE(cost_usd, 0) > 0) AND kind = 'rl'
  `
  return Number(r.rows[0]?.n) || 0
}

// ---------------------------------------------------------------------------
// Adapters that can be talked to
// ---------------------------------------------------------------------------

/** A trained adapter as the public sees it. The checkpoint path is not part of it. */
export interface TrainedAdapter {
  slug: string
  /** Its id on the lab model endpoint. */
  model_id: string
  base_model: string
  epoch: number
  author_model: string
  author_name: string
  purpose: string | null
  examples: number
  holdout_examples: number | null
  /** Mean cross-entropy per trained token on the held-out slice, measured by the lab. Lower is better. */
  holdout_loss_before: number | null
  holdout_loss_after: number | null
  created_at: string
  expires_at: string | null
  /** Present, and 'rl', only for an adapter made by Tinker RL: its examples are tasks, and its scores are rubric scores, not losses. */
  kind?: 'rl'
  /** For an RL adapter: the mean rubric score on the held-out tasks, measured by the lab, before and after. Higher is better. */
  rl_score_before?: number | null
  rl_score_after?: number | null
  /** The display name its author gave it. A label: the adapter is still addressed by its slug. Absent when it has none. */
  name?: string
  /** Only for an adapter trained on rows the lab read from a public dataset: "org/name@commit". */
  data_from?: string
  /**
   * Where its training examples came from, in the lab's two labels: "written
   * by the models" or "public dataset org/name@commit". Only while
   * LAB_TINKER_ORIGIN_LABELS is on.
   */
  origin?: string
  /** Present, and true, only for an adapter that is marked to keep. */
  kept?: true
  kept_at?: string
  /** Who marked it: "the owner" or a model's display name. */
  kept_by?: string
  kept_reason?: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function publicAdapter(row: TinkerRunRow, keep: KeepRow | null = null): TrainedAdapter {
  const result = row.result ?? {}
  const name = shownName(row)
  const kept = keep && keep.status === 'kept' ? keep : null
  return {
    slug: row.slug,
    model_id: `lab/${row.slug}`,
    base_model: row.base_model,
    epoch: row.epoch,
    author_model: row.model,
    author_name: modelDisplayName(row.model) || row.model.split('/').pop() || row.model,
    purpose: row.purpose ? sanitizeOutput(row.purpose).slice(0, 200) : null,
    examples: row.dataset_examples,
    holdout_examples: num(result.n_holdout),
    holdout_loss_before: num(result.holdout_loss_before),
    holdout_loss_after: num(result.holdout_loss_after),
    created_at: row.created_at,
    expires_at: row.expires_at,
    // The fields below exist only for an adapter that has a name or is marked
    // to keep, so a lab that uses neither sends exactly what it always sent.
    ...(row.kind === 'rl' ? { kind: 'rl' as const, rl_score_before: num(result.score_before), rl_score_after: num(result.score_after) } : {}),
    ...(name ? { name } : {}),
    ...(dataFrom(row) ? { data_from: dataFrom(row) as string } : {}),
    ...(tinkerOriginFlag() ? { origin: dataOrigin(row) } : {}),
    ...(kept ? {
      kept: true as const,
      ...(kept.kept_at ? { kept_at: kept.kept_at } : {}),
      kept_by: keptByName(kept.kept_by),
      ...(kept.reason ? { kept_reason: sanitizeOutput(kept.reason).slice(0, 200) } : {}),
    } : {}),
  }
}

/** "org/name@commit" of the public dataset a run's examples were read from, or null. */
export function dataFrom(row: Pick<TinkerRunRow, 'dataset_source'>): string | null {
  const s = row.dataset_source
  if (!s || typeof s.repo !== 'string' || typeof s.sha !== 'string') return null
  return /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/.test(s.repo) && /^[0-9a-f]{40}$/.test(s.sha) ? `${s.repo}@${s.sha}` : null
}

/** The label for examples a model wrote into its training request. */
export const ORIGIN_MODELS = 'written by the models'
/** The start of the label for examples the lab read from a shelf dataset. */
export const ORIGIN_DATASET = 'public dataset'

/**
 * Where a run's training examples came from, as a label. A run has a stored
 * dataset source only when the lab read its examples from a public dataset
 * on the shelf (datasets.ts), and it is stored before anything is sent to
 * the runner: a run whose source could not be stored is closed without being
 * started (tinker-run.ts). So a run that trained, and has no stored source,
 * was trained on examples the model wrote into its request. The label is
 * read from the row, so every run that trained has one, the ones made before
 * labels existed included. A row that was opened and never reached the
 * runner trained on nothing: reachedRunner() tells those apart, and the
 * summary leaves them out.
 */
export function dataOrigin(row: Pick<TinkerRunRow, 'dataset_source'>): string {
  if (!row.dataset_source) return ORIGIN_MODELS
  // A stored source that no longer reads as a repository and a commit is still a dataset.
  return `${ORIGIN_DATASET} ${dataFrom(row) ?? '(its stored source cannot be read)'}`
}

/**
 * Did this run reach the runner? It has a call id, is marked as running, or
 * has an answer from the runner. A row that was opened and closed before
 * anything was sent (the runner said no, the dataset source could not be
 * stored, its start was never confirmed) has none of these. Such a row may
 * be a dataset run whose source never got onto it, so its origin cannot be
 * told from the row, and it trained on nothing either way.
 */
export function reachedRunner(row: Pick<TinkerRunRow, 'status' | 'result'> & { call_id?: string | null }): boolean {
  return Boolean(row.call_id) || row.status === 'running' || row.status === 'ok' || Boolean(row.result)
}

/** One origin's runs in the public summary. */
export interface OriginSummary {
  origin: typeof ORIGIN_MODELS | typeof ORIGIN_DATASET
  /** Every run that reached the runner, whatever became of it. */
  runs: number
  /** Runs that finished with both held-out losses measured by the lab. */
  measured: number
  /** Medians over the measured runs. Mean cross-entropy per trained token on the lab's held-out slice; lower is better. */
  median_holdout_loss_before: number | null
  median_holdout_loss_after: number | null
  /** Only for the dataset origin: which datasets, and how many runs each. */
  datasets?: { data_from: string; runs: number }[]
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Per origin: how many runs, and the median held-out loss before and after training. No I/O. */
export function summarizeOrigins(rows: (Pick<TinkerRunRow, 'dataset_source' | 'status' | 'result'> & { call_id?: string | null; kind?: string | null })[]): OriginSummary[] {
  const groups: Record<'models' | 'dataset', { runs: number; before: number[]; after: number[]; datasets: Map<string, number> }> = {
    models: { runs: 0, before: [], after: [], datasets: new Map() },
    dataset: { runs: 0, before: [], after: [], datasets: new Map() },
  }
  for (const row of rows) {
    // A row that never reached the runner is not a training run of either origin.
    if (!reachedRunner(row)) continue
    // A Tinker RL run is scored with a rubric, not a loss: its scores are another unit and have their own record.
    if (row.kind === 'rl') continue
    const g = row.dataset_source ? groups.dataset : groups.models
    g.runs += 1
    if (row.dataset_source) {
      const from = dataFrom(row) ?? '(its stored source cannot be read)'
      g.datasets.set(from, (g.datasets.get(from) ?? 0) + 1)
    }
    const before = num(row.result?.holdout_loss_before)
    const after = num(row.result?.holdout_loss_after)
    if (row.status === 'ok' && before !== null && after !== null) {
      g.before.push(before)
      g.after.push(after)
    }
  }
  const one = (origin: OriginSummary['origin'], g: typeof groups.models): OriginSummary => ({
    origin, runs: g.runs, measured: g.before.length,
    median_holdout_loss_before: median(g.before), median_holdout_loss_after: median(g.after),
    ...(origin === ORIGIN_DATASET
      ? { datasets: [...g.datasets.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([data_from, runs]) => ({ data_from, runs })) }
      : {}),
  })
  return [one(ORIGIN_MODELS, groups.models), one(ORIGIN_DATASET, groups.dataset)]
}

/** How many of the newest runs the origin summary is taken from. */
export const ORIGIN_SUMMARY_RUNS = 500

/**
 * The origin summary from the stored runs. It only looks: it never creates
 * the table, and a lab that has never trained anything gets two empty rows.
 */
export async function originSummary(): Promise<OriginSummary[]> {
  let rows: TinkerRunRow[] = []
  try {
    const r = await sql`SELECT * FROM tinker_runs ORDER BY created_at DESC LIMIT ${ORIGIN_SUMMARY_RUNS}`
    rows = r.rows.map(row => runRow(row as Record<string, unknown>))
  } catch {
    rows = [] // no such table yet: nothing has been trained
  }
  return summarizeOrigins(rows)
}

/**
 * An adapter's display name as it may be shown and recorded, or null. Only
 * while names are switched on: with LAB_ENABLE_TINKER_NAMES off, a name
 * given earlier stays in the database and goes nowhere.
 */
export function shownName(row: Pick<TinkerRunRow, 'display_name'>): string | null {
  if (!tinkerNamesFlag() || !row.display_name) return null
  return sanitizeOutput(row.display_name).slice(0, 40) || null
}

/**
 * What the lab model endpoint says about an adapter beside its id: its
 * display name, and that it is kept. Empty when it has neither.
 */
export function adapterDescription(adapter: TrainedAdapter): string {
  const parts: string[] = []
  if (adapter.name) parts.push(`"${adapter.name}"`)
  if (adapter.kept) parts.push(`kept${adapter.kept_by ? ` by ${adapter.kept_by}` : ''}`)
  if (!parts.length) return ''
  return `${parts.join(', ')}. A LoRA adapter trained in this lab on ${adapter.base_model}; the id is its identity, the name is a label.`
}

/** Who marked an adapter to keep, in words. */
export function keptByName(keptBy: string): string {
  return keptBy === KEPT_BY_OWNER ? 'the owner' : modelDisplayName(keptBy) || keptBy.split('/').pop() || keptBy
}

/** A kept adapter with what the server needs to call it. Not for a response body. */
export interface AdapterTarget {
  adapter: TrainedAdapter
  sampler_path: string
  experiment_id: string
  /**
   * Present, and true, only when the run's examples were rows the lab read
   * from a public dataset. It is set from the stored source itself, whether
   * or not that source still reads as a well formed one, so the visitor chat
   * (trained-chat.ts) can leave such an adapter out without trusting it.
   */
  from_dataset?: true
}

function target(row: TinkerRunRow, now: Date, keep: KeepRow | null = null): AdapterTarget | null {
  if (row.status !== 'ok' || !isSamplerPath(row.sampler_path) || !isAdapterSlug(row.slug)) return null
  if (!row.expires_at || !(new Date(row.expires_at).getTime() > now.getTime())) return null
  return {
    adapter: publicAdapter(row, keep), sampler_path: row.sampler_path, experiment_id: row.experiment_id,
    ...(row.dataset_source ? { from_dataset: true as const } : {}),
  }
}

/**
 * Adapters that were trained, saved and have not expired, newest first.
 *
 * While adapters can be kept (LAB_ENABLE_TINKER_KEEP), the kept ones come
 * first, the most recently kept at the top, and are listed however old they
 * are; the rest follow, newest first. With that switch off this is the one
 * query it always was.
 */
export async function listAdapters(now: Date = new Date(), limit = 20): Promise<AdapterTarget[]> {
  await ensureTinkerTables()
  const r = await sql`
    SELECT * FROM tinker_runs
    WHERE status = ${'ok'} AND sampler_path IS NOT NULL AND expires_at > ${now.toISOString()}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
  const rows = r.rows.map(row => runRow(row as Record<string, unknown>))
  if (!tinkerKeepFlag()) return rows.map(row => target(row, now)).filter((t): t is AdapterTarget => t !== null)

  const kept = (await listKeeps()).filter(k => k.status === 'kept')
    .sort((a, b) => Date.parse(b.kept_at ?? '') - Date.parse(a.kept_at ?? ''))
  const bySlug = new Map(rows.map(row => [row.slug, row]))
  const first: AdapterTarget[] = []
  for (const keep of kept) {
    // A kept adapter older than the newest ones is read on its own.
    const row = bySlug.get(keep.slug) ?? await getRun(keep.slug)
    const t = row ? target(row, now, keep) : null
    if (t) first.push(t)
  }
  const keptSlugs = new Set(first.map(t => t.adapter.slug))
  const rest = rows.filter(row => !keptSlugs.has(row.slug)).map(row => target(row, now)).filter((t): t is AdapterTarget => t !== null)
  return [...first, ...rest]
}

/** One run by its adapter's slug, whatever state it is in. */
export async function getRun(slug: string): Promise<TinkerRunRow | null> {
  if (!isAdapterSlug(slug)) return null
  await ensureTinkerTables()
  const r = await sql`SELECT * FROM tinker_runs WHERE slug = ${slug} LIMIT 1`
  return r.rows[0] ? runRow(r.rows[0] as Record<string, unknown>) : null
}

/** The weights a run saved for download, if it saved any. */
export function externalPathOf(row: TinkerRunRow): string | null {
  const path = row.result?.external_path
  return isExternalPath(path) ? path : null
}

export async function getAdapter(slug: string, now: Date = new Date()): Promise<AdapterTarget | null> {
  if (!isAdapterSlug(slug)) return null
  await ensureTinkerTables()
  const r = await sql`SELECT * FROM tinker_runs WHERE slug = ${slug} LIMIT 1`
  return r.rows[0] ? target(runRow(r.rows[0] as Record<string, unknown>), now) : null
}

// ---------------------------------------------------------------------------
// Adapters marked to keep
// ---------------------------------------------------------------------------

/** What kept_by holds when the owner marked the adapter. Otherwise it is the id of the model that asked. */
export const KEPT_BY_OWNER = 'owner'

export interface KeepRow {
  slot: number
  slug: string
  /** pending: the runner is extending its life and copying it. kept: done. */
  status: 'pending' | 'kept'
  kept_by: string
  reason: string | null
  /** The epoch a model asked in. Both null when the owner asked. */
  experiment_id: string | null
  epoch: number | null
  /** The lab's name for this attempt at the runner. */
  job_id: string
  call_id: string | null
  requested_at: string
  kept_at: string | null
  detail: Record<string, unknown> | null
}

function keepRow(row: Record<string, unknown>): KeepRow {
  return {
    slot: Number(row.slot) || 0,
    slug: String(row.slug ?? ''),
    status: row.status === 'kept' ? 'kept' : 'pending',
    kept_by: String(row.kept_by ?? ''),
    reason: row.reason ? String(row.reason) : null,
    experiment_id: row.experiment_id ? String(row.experiment_id) : null,
    epoch: row.epoch === null || row.epoch === undefined ? null : Number(row.epoch),
    job_id: String(row.job_id ?? ''),
    call_id: row.call_id ? String(row.call_id) : null,
    requested_at: iso(row.requested_at) ?? '',
    kept_at: iso(row.kept_at),
    detail: json(row.detail),
  }
}

/**
 * Every adapter that is kept or being kept, by slot. `createTables: false`
 * only looks, for a server where keeping is switched off; the caller treats
 * a failure (no such table) as none.
 */
export async function listKeeps(opts: { createTables?: boolean } = {}): Promise<KeepRow[]> {
  if (opts.createTables !== false) await ensureTinkerExtras()
  const r = await sql`SELECT * FROM tinker_keeps ORDER BY slot ASC`
  return r.rows.map(row => keepRow(row as Record<string, unknown>))
}

export async function getKeep(slug: string, opts: { createTables?: boolean } = {}): Promise<KeepRow | null> {
  if (!isAdapterSlug(slug)) return null
  if (opts.createTables !== false) await ensureTinkerExtras()
  const r = await sql`SELECT * FROM tinker_keeps WHERE slug = ${slug} LIMIT 1`
  return r.rows[0] ? keepRow(r.rows[0] as Record<string, unknown>) : null
}

export type KeepClaim = { ok: true; row: KeepRow } | { ok: false; reason: string }

/** How many times a claim looks again after another request took the slot it was about to take. */
export const KEEP_CLAIM_ATTEMPTS = 5

/**
 * Takes a place among the kept adapters, or says why not. The cap is held by
 * the database: a place is a slot numbered 1 to `max`, the slot is the
 * table's primary key, and the statement takes the lowest free one only
 * while fewer than `max` rows exist. Two requests arriving together cannot
 * both take the last place: one of them finds the slot taken and gets no row
 * back. The same statement cannot keep one adapter twice (slug is unique) or
 * serve two keeps for one epoch (the index on experiment and epoch).
 *
 * Two requests arriving together both aim at the lowest free slot, so the
 * one that gets no row back has not been refused by the cap: it looks again,
 * and takes the next free slot, finds the adapter or the epoch taken, or
 * finds the places full. Every round has a winner, so a request only runs
 * out of attempts when that many others were served ahead of it at the same
 * moment.
 */
export async function claimKeepSlot(params: {
  slug: string
  keptBy: string
  reason: string
  experimentId: string | null
  epoch: number | null
  jobId: string
  max: number
}): Promise<KeepClaim> {
  await ensureTinkerExtras()
  if (!(params.max > 0)) return { ok: false, reason: 'no adapter may be kept (the limit is 0)' }
  for (let attempt = 0; attempt < KEEP_CLAIM_ATTEMPTS; attempt++) {
    const existing = await getKeep(params.slug, { createTables: false })
    if (existing) return { ok: false, reason: existing.status === 'kept' ? 'that adapter is already kept' : 'that adapter is already being kept' }
    if (params.experimentId !== null && params.epoch !== null) {
      const same = await sql`SELECT slug FROM tinker_keeps WHERE experiment_id = ${params.experimentId} AND epoch = ${params.epoch} LIMIT 1`
      if (same.rows[0]) return { ok: false, reason: 'this epoch already asked for one adapter to be kept' }
    }
    const r = await sql`
      INSERT INTO tinker_keeps (slot, slug, status, kept_by, reason, experiment_id, epoch, job_id)
      SELECT s.slot, ${params.slug}::text, 'pending', ${params.keptBy}::text, ${sanitizeOutput(params.reason).slice(0, 200)}::text,
        ${params.experimentId}::text, ${params.epoch}::integer, ${params.jobId}::text
      FROM generate_series(1, ${params.max}::integer) AS s(slot)
      WHERE NOT EXISTS (SELECT 1 FROM tinker_keeps k WHERE k.slot = s.slot)
        AND (SELECT COUNT(*) FROM tinker_keeps) < ${params.max}::integer
      ORDER BY s.slot ASC
      LIMIT 1
      ON CONFLICT DO NOTHING
      RETURNING *
    `
    if (r.rows[0]) return { ok: true, row: keepRow(r.rows[0] as Record<string, unknown>) }
    const held = await sql`SELECT COUNT(*) AS n FROM tinker_keeps`
    const n = Number(held.rows[0]?.n) || 0
    if (n >= params.max) return { ok: false, reason: `${n} adapters are kept and at most ${params.max} may be; the owner has to unkeep one first` }
  }
  return { ok: false, reason: 'other requests took a place at the same moment, several times over; nothing was changed' }
}

/**
 * Keeps models asked for today (UTC) that the runner has not answered yet. A
 * keep is written to tool_runs only when it is closed, so the requests-per-day
 * limit adds these to the stored ones.
 */
export async function pendingModelKeepsToday(now: Date = new Date()): Promise<number> {
  await ensureTinkerExtras()
  const r = await sql`
    SELECT COUNT(*) AS n FROM tinker_keeps
    WHERE status = ${'pending'} AND kept_by <> ${KEPT_BY_OWNER} AND requested_at >= ${`${utcDay(now)}T00:00:00.000Z`}
  `
  return Number(r.rows[0]?.n) || 0
}

/** Stores the runner's call for a keep that was started. */
export async function markKeepStarted(slug: string, callId: string): Promise<void> {
  await sql`UPDATE tinker_keeps SET call_id = ${callId} WHERE slug = ${slug} AND status = ${'pending'}`
}

/**
 * Closes a keep that worked: the adapter is kept, and its life in the lab's
 * own record is set to what the runner set on Tinker. Only a pending keep is
 * closed, and the row comes back only to the caller that closed it.
 */
export async function finishKeep(slug: string, detail: Record<string, unknown>, expiresAt: string): Promise<KeepRow | null> {
  const r = await sql`
    UPDATE tinker_keeps SET status = ${'kept'}, kept_at = NOW(), detail = ${JSON.stringify(detail)}
    WHERE slug = ${slug} AND status = ${'pending'}
    RETURNING *
  `
  if (!r.rows[0]) return null
  await sql`UPDATE tinker_runs SET expires_at = ${expiresAt} WHERE slug = ${slug} AND status = ${'ok'}`
  return keepRow(r.rows[0] as Record<string, unknown>)
}

/**
 * Gives a place back. `status` says which rows may go: a keep that failed
 * gives back a pending row only, the owner's unkeep a kept one. The row comes
 * back only to the caller that removed it.
 */
export async function releaseKeep(slug: string, status: 'pending' | 'kept'): Promise<KeepRow | null> {
  const r = await sql`DELETE FROM tinker_keeps WHERE slug = ${slug} AND status = ${status} RETURNING *`
  return r.rows[0] ? keepRow(r.rows[0] as Record<string, unknown>) : null
}

/**
 * Kept adapters whose time on Tinker has run out give their places back. A
 * keep lasts as long as the life it set on Tinker; after that the adapter is
 * gone like any other, and a place held by it would be a place nothing can
 * use. Each row comes back only to the caller that removed it.
 */
export async function releaseExpiredKeeps(now: Date = new Date()): Promise<KeepRow[]> {
  const r = await sql`
    DELETE FROM tinker_keeps WHERE status = ${'kept'} AND slug IN (
      SELECT slug FROM tinker_runs WHERE status <> ${'ok'} OR expires_at IS NULL OR expires_at <= ${now.toISOString()}
    )
    RETURNING *
  `
  return r.rows.map(row => keepRow(row as Record<string, unknown>))
}

/** Sets when the lab stops offering an adapter (after an unkeep). */
export async function setAdapterExpiry(slug: string, expiresAt: string): Promise<void> {
  await sql`UPDATE tinker_runs SET expires_at = ${expiresAt} WHERE slug = ${slug} AND status = ${'ok'}`
}

/**
 * Keeps that were started and not closed yet, oldest first. `createTables:
 * false` only looks, for a server where keeping is switched off; the caller
 * treats a failure (no such table) as none.
 */
export async function openKeeps(opts: { createTables?: boolean } = {}): Promise<KeepRow[]> {
  if (opts.createTables !== false) await ensureTinkerExtras()
  const r = await sql`SELECT * FROM tinker_keeps WHERE status = ${'pending'} ORDER BY requested_at ASC LIMIT 5`
  return r.rows.map(row => keepRow(row as Record<string, unknown>))
}

// ---------------------------------------------------------------------------
// Visitor chat: rate limits by a hash, and counts
// ---------------------------------------------------------------------------

function visitorKey(): Buffer {
  const secret = (process.env.LAB_OPERATOR_SECRET || process.env.CRON_SECRET || process.env.POSTGRES_URL || '').trim()
  return createHash('sha256').update(`trained-chat-visitor|${secret}`, 'utf8').digest()
}

/**
 * The network an address belongs to, for counting. An IPv4 address is itself.
 * An IPv6 address is its first 64 bits: a home or a phone is usually given a
 * whole /64 and can pick any address in it, so counting each address apart
 * would count one sender as many. An IPv4 address written the IPv6 way
 * (::ffff:1.2.3.4) is the IPv4 address. Anything else is kept as it came.
 */
export function addressNetwork(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (isIPv4(raw)) return raw
  if (!isIPv6(raw)) return raw.slice(0, 80)
  // A dotted IPv4 tail is two groups of the address.
  let text = raw
  const tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  if (tail) {
    const [a, b, c, d] = tail.slice(2).map(Number)
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, rest] = text.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = rest ? rest.split(':') : []
  const groups = (rest === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right])
    .map(g => parseInt(g, 16) || 0)
  if (groups.length !== 8) return raw
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`
  }
  return `${groups.slice(0, 4).map(g => g.toString(16)).join(':')}::/64`
}

/**
 * A visitor, as the lab remembers one: a keyed hash of the address and the
 * browser string, new every UTC day. The address itself is never stored or
 * logged. The key is taken from a secret this server already has, so the
 * hash cannot be turned back into an address by trying every address.
 *
 * The browser string is whatever the sender writes, so this hash only splits
 * the people behind one address from each other. It is never the only thing
 * a limit is counted by: addressHash below is counted too.
 */
export function visitorHash(ip: string, userAgent: string, now: Date = new Date()): string {
  return createHmac('sha256', visitorKey()).update(`${utcDay(now)}|${addressNetwork(ip)}|${userAgent.slice(0, 300)}`, 'utf8').digest('hex').slice(0, 40)
}

/**
 * An address alone, as the lab remembers one: a keyed hash of its network
 * (addressNetwork), new every UTC day. Nothing the sender can choose besides
 * the network it sends from goes into it.
 */
export function addressHash(ip: string, now: Date = new Date()): string {
  return createHmac('sha256', visitorKey()).update(`address|${utcDay(now)}|${addressNetwork(ip)}`, 'utf8').digest('hex').slice(0, 40)
}

/**
 * Counts one message for a visitor in one bucket, or refuses it. One
 * statement: the row is made at 1, or raised by 1 only while it is under
 * the limit. No row back means the limit is reached.
 */
export async function countVisitorMessage(visitor: string, bucket: string, limit: number): Promise<boolean> {
  await ensureTinkerTables()
  const r = await sql`
    INSERT INTO trained_chat_rate (visitor, bucket, n) VALUES (${visitor}, ${bucket}, 1)
    ON CONFLICT (visitor, bucket) DO UPDATE SET n = trained_chat_rate.n + 1
    WHERE trained_chat_rate.n < ${limit}
    RETURNING n
  `
  return Boolean(r.rows[0])
}

/** Removes rate rows older than two days. Never throws. */
export async function pruneVisitorCounts(now: Date = new Date()): Promise<void> {
  try {
    await sql`DELETE FROM trained_chat_rate WHERE created_at < ${new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()}`
  } catch {
    // housekeeping only
  }
}

export interface TrainedChatCall {
  slug: string
  status: string
  httpStatus: number | null
  turns: number
  promptChars: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  durationMs: number
}

/** Stores one visitor chat call as counts. What was said is not stored. Never throws. */
export async function recordTrainedChatCall(call: TrainedChatCall): Promise<void> {
  try {
    await ensureTinkerTables()
    await sql`
      INSERT INTO trained_chat_calls (slug, status, http_status, turns, prompt_chars, prompt_tokens, completion_tokens, cost_usd, duration_ms)
      VALUES (${call.slug}, ${call.status.slice(0, 40)}, ${call.httpStatus}, ${call.turns}, ${call.promptChars},
        ${call.promptTokens}, ${call.completionTokens}, ${usd(call.costUsd)}, ${Math.round(call.durationMs)})
    `
  } catch (e) {
    console.warn('[trained-chat] could not store a call record:', e instanceof Error ? e.message : e)
  }
}

/**
 * The newest visitor chat call that was answered (status 'ok'): which adapter
 * and when. Reads the counts row only; no text is kept anywhere. An error, a
 * refusal and an untrained comparison row (status 'base_...') are not 'ok'.
 */
export async function latestChatCall(): Promise<{ slug: string; at: Date } | null> {
  await ensureTinkerTables()
  const r = await sql`SELECT slug, created_at FROM trained_chat_calls WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1`
  const row = r.rows[0] as { slug?: unknown; created_at?: unknown } | undefined
  if (!row || typeof row.slug !== 'string') return null
  const at = new Date(row.created_at as string | number | Date)
  return Number.isFinite(at.getTime()) ? { slug: row.slug, at } : null
}

/** How many visitor chat calls were answered (status 'ok') since 00:00 UTC of `now`'s day. */
export async function chatCallsToday(now: Date = new Date()): Promise<number> {
  await ensureTinkerTables()
  const r = await sql`SELECT COUNT(*) AS n FROM trained_chat_calls WHERE status = 'ok' AND created_at >= ${`${utcDay(now)}T00:00:00.000Z`}`
  return Math.max(0, Math.floor(Number(r.rows[0]?.n) || 0))
}
