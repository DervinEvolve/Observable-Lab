/**
 * What the database holds for Tinker training (tinker.ts):
 *
 *   tinker_runs          one row per training run: who asked, the dataset's
 *                        hash and size, the settings, the lab-measured
 *                        scores, the estimated cost, and the saved adapter.
 *   tinker_spend_days    what Tinker use has been set aside and spent per
 *                        UTC day, per scope. This is where the daily caps
 *                        are enforced.
 *   trained_chat_rate    how many messages a visitor has sent, by a hash of
 *                        the visitor. No address is stored.
 *   trained_chat_calls   one row of counts per visitor chat call. No text.
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
 * All four tables are created at runtime, like the other run 2 tables.
 */
import { createHash, createHmac } from 'node:crypto'
import { sql } from '@vercel/postgres'
import { sanitizeOutput } from './sprites.js'
import { modelDisplayName } from './types.js'
import { isAdapterSlug, isSamplerPath, type TinkerRequest, type TinkerRunResult } from './tinker.js'

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
  }
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

/** Runs of one experiment that were started and not collected yet, oldest first. */
export async function openTinkerRuns(experimentId: string): Promise<TinkerRunRow[]> {
  await ensureTinkerTables()
  const r = await sql`
    SELECT * FROM tinker_runs
    WHERE experiment_id = ${experimentId} AND status IN ('reserved', 'running')
    ORDER BY created_at ASC
    LIMIT 5
  `
  return r.rows.map(row => runRow(row as Record<string, unknown>))
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
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function publicAdapter(row: TinkerRunRow): TrainedAdapter {
  const result = row.result ?? {}
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
  }
}

/** A kept adapter with what the server needs to call it. Not for a response body. */
export interface AdapterTarget { adapter: TrainedAdapter; sampler_path: string; experiment_id: string }

function target(row: TinkerRunRow, now: Date): AdapterTarget | null {
  if (row.status !== 'ok' || !isSamplerPath(row.sampler_path) || !isAdapterSlug(row.slug)) return null
  if (!row.expires_at || !(new Date(row.expires_at).getTime() > now.getTime())) return null
  return { adapter: publicAdapter(row), sampler_path: row.sampler_path, experiment_id: row.experiment_id }
}

/** Adapters that were trained, saved and have not expired, newest first. */
export async function listAdapters(now: Date = new Date(), limit = 20): Promise<AdapterTarget[]> {
  await ensureTinkerTables()
  const r = await sql`
    SELECT * FROM tinker_runs
    WHERE status = ${'ok'} AND sampler_path IS NOT NULL AND expires_at > ${now.toISOString()}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
  return r.rows.map(row => target(runRow(row as Record<string, unknown>), now)).filter((t): t is AdapterTarget => t !== null)
}

export async function getAdapter(slug: string, now: Date = new Date()): Promise<AdapterTarget | null> {
  if (!isAdapterSlug(slug)) return null
  await ensureTinkerTables()
  const r = await sql`SELECT * FROM tinker_runs WHERE slug = ${slug} LIMIT 1`
  return r.rows[0] ? target(runRow(r.rows[0] as Record<string, unknown>), now) : null
}

// ---------------------------------------------------------------------------
// Visitor chat: rate limits by a hash, and counts
// ---------------------------------------------------------------------------

/**
 * A visitor, as the lab remembers one: a keyed hash of the address and the
 * browser string, new every UTC day. The address itself is never stored or
 * logged. The key is taken from a secret this server already has, so the
 * hash cannot be turned back into an address by trying every address.
 */
export function visitorHash(ip: string, userAgent: string, now: Date = new Date()): string {
  const secret = (process.env.LAB_OPERATOR_SECRET || process.env.CRON_SECRET || process.env.POSTGRES_URL || '').trim()
  const key = createHash('sha256').update(`trained-chat-visitor|${secret}`, 'utf8').digest()
  return createHmac('sha256', key).update(`${utcDay(now)}|${ip}|${userAgent.slice(0, 300)}`, 'utf8').digest('hex').slice(0, 40)
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
