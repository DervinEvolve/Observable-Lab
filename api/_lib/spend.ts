/**
 * Spend ledger and daily budget.
 *
 * Every OpenRouter response is written to `model_calls` with the real
 * `usage.cost` OpenRouter reported for it (retries and fallbacks included),
 * the token counts, and which experiment/epoch it belonged to. The daily
 * budget reads the sum for the current UTC day from that table, so it counts
 * everything that actually cost money: epochs, contributions, North runs.
 *
 * The experiment/epoch for a call comes from an async context set by whoever
 * starts the work (runEpoch, runAndPersistNorth), so callModel's callers do
 * not have to pass it through.
 *
 * With LAB_RESEARCH_ALONGSIDE on there are two caps. Every row already
 * carries its experiment, and an experiment's mode never changes, so the
 * split is a join at read time: LAB_RESEARCH_DAILY_BUDGET_USD counts the
 * rows of research experiments (the GPU run estimate included), and
 * LAB_DAILY_BUDGET_USD counts every other row. With the flag off there is
 * one cap over all rows, as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from '@vercel/postgres'
import { researchAlongside, type ExperimentMode } from './experiment-modes.js'

export interface SpendContext {
  experimentId?: string
  epochNumber?: number
  purpose?: string
}

const contextStore = new AsyncLocalStorage<SpendContext>()

/** Runs `fn` with calls attributed to this experiment/epoch. Nested contexts inherit. */
export function withSpendContext<T>(ctx: SpendContext, fn: () => Promise<T>): Promise<T> {
  return contextStore.run({ ...(contextStore.getStore() ?? {}), ...ctx }, fn)
}

export function currentSpendContext(): SpendContext | undefined {
  return contextStore.getStore()
}

/** Sets the epoch number once the runner knows it (after reading the experiment). */
export function setSpendEpoch(epochNumber: number): void {
  const ctx = contextStore.getStore()
  if (ctx) ctx.epochNumber = epochNumber
}

export interface ModelCallRecord {
  model: string            // model that answered this request
  assigned: string         // model the caller asked for
  cost_usd: number
  cost_source: 'usage' | 'estimate' | 'none'
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
}

let tableReady: Promise<void> | null = null
export function ensureSpendTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS model_calls (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          experiment_id UUID,
          epoch_number INTEGER,
          purpose TEXT,
          model_id TEXT NOT NULL,
          assigned_model_id TEXT,
          cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          cost_source TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0
        )
      `
      await sql`CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at)`
      await sql`CREATE INDEX IF NOT EXISTS idx_model_calls_epoch ON model_calls(experiment_id, epoch_number)`
    })().catch(e => {
      tableReady = null
      throw e
    })
  }
  return tableReady
}

let warnedRecordFailure = false

/** Writes one billed response to the ledger. Never throws. */
export async function recordModelCall(rec: ModelCallRecord): Promise<void> {
  const ctx = contextStore.getStore() ?? {}
  try {
    await ensureSpendTable()
    await sql`
      INSERT INTO model_calls (
        experiment_id, epoch_number, purpose, model_id, assigned_model_id,
        cost_usd, cost_source, prompt_tokens, completion_tokens, reasoning_tokens
      ) VALUES (
        ${ctx.experimentId ?? null}, ${ctx.epochNumber ?? null}, ${ctx.purpose ?? null},
        ${rec.model}, ${rec.assigned}, ${rec.cost_usd}, ${rec.cost_source},
        ${rec.prompt_tokens}, ${rec.completion_tokens}, ${rec.reasoning_tokens}
      )
    `
  } catch (e) {
    if (!warnedRecordFailure) {
      warnedRecordFailure = true
      console.warn('[spend] could not write the model call ledger:', e instanceof Error ? e.message : e)
    }
  }
}

/** Ledger totals for one epoch, or null when the ledger can't be read. */
export async function epochSpend(experimentId: string, epochNumber: number): Promise<
  { cost_usd: number; prompt_tokens: number; completion_tokens: number } | null
> {
  try {
    await ensureSpendTable()
    const r = await sql`
      SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens
      FROM model_calls
      WHERE experiment_id = ${experimentId} AND epoch_number = ${epochNumber}
    `
    const row = r.rows[0] ?? {}
    return {
      cost_usd: Number(row.cost_usd) || 0,
      prompt_tokens: Number(row.prompt_tokens) || 0,
      completion_tokens: Number(row.completion_tokens) || 0,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Daily budget
// ---------------------------------------------------------------------------

export const DEFAULT_DAILY_BUDGET_USD = 15

export function dailyBudgetUsd(): number {
  const raw = (process.env.LAB_DAILY_BUDGET_USD ?? '').trim()
  if (!raw) return DEFAULT_DAILY_BUDGET_USD
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET_USD
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 24 * 60 * 60 * 1000)
}

export const DEFAULT_RESEARCH_DAILY_BUDGET_USD = 40

/** The research experiment's own cap, used only while LAB_RESEARCH_ALONGSIDE is on. */
export function researchDailyBudgetUsd(): number {
  const raw = (process.env.LAB_RESEARCH_DAILY_BUDGET_USD ?? '').trim()
  if (!raw) return DEFAULT_RESEARCH_DAILY_BUDGET_USD
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESEARCH_DAILY_BUDGET_USD
}

/**
 * Today's spend (UTC). With no scope, every row. With a scope, only the rows
 * of that kind of experiment: `research` is rows whose experiment is in
 * research mode, `classic` is every other row (rows with no experiment too).
 */
export async function spentTodayUsd(now: Date = new Date(), scope?: ExperimentMode): Promise<number> {
  await ensureSpendTable()
  const since = utcDayStart(now).toISOString()
  const r = scope === 'research'
    ? await sql`
      SELECT COALESCE(SUM(m.cost_usd), 0) AS total
      FROM model_calls m JOIN experiments e ON e.id = m.experiment_id
      WHERE m.created_at >= ${since} AND jsonb_typeof(e.current_spec->'meta'->'research') = 'object'
    `
    : scope === 'classic'
    ? await sql`
      SELECT COALESCE(SUM(m.cost_usd), 0) AS total
      FROM model_calls m LEFT JOIN experiments e ON e.id = m.experiment_id
      WHERE m.created_at >= ${since} AND jsonb_typeof(e.current_spec->'meta'->'research') IS DISTINCT FROM 'object'
    `
    : await sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM model_calls
    WHERE created_at >= ${since}
  `
  return Number(r.rows[0]?.total) || 0
}

export interface BudgetStatus {
  allowed: boolean
  spent_usd: number | null  // null when the ledger could not be read
  budget_usd: number
  resumes_at: string        // next UTC midnight
  reason?: string
  scope?: ExperimentMode    // which cap this is, when there are two
}

export const BUDGET_PAUSED_STATE = 'paused: daily budget reached'
export const RESEARCH_BUDGET_REACHED = 'research daily budget reached'
export const RESEARCH_BUDGET_PAUSED_STATE = `paused: ${RESEARCH_BUDGET_REACHED}`

/** The run state for a budget pause: research names its own cap. */
export function budgetPausedState(status: BudgetStatus): string {
  return status.reason === RESEARCH_BUDGET_REACHED ? RESEARCH_BUDGET_PAUSED_STATE : BUDGET_PAUSED_STATE
}

/**
 * May the lab spend more today? Fails closed: if the ledger can't be read,
 * nothing new starts, because the cap could not be checked.
 *
 * `scope` says whose work is asking. It only matters while
 * LAB_RESEARCH_ALONGSIDE is on: then research is held to its own cap and
 * its own spend, and everything else to LAB_DAILY_BUDGET_USD and the spend
 * that is not research. With the flag off both scopes are the one cap over
 * all spend.
 */
export async function checkDailyBudget(now: Date = new Date(), scope: ExperimentMode = 'classic'): Promise<BudgetStatus> {
  const split = researchAlongside()
  const research = split && scope === 'research'
  const budget = research ? researchDailyBudgetUsd() : dailyBudgetUsd()
  const resumes_at = nextUtcMidnight(now).toISOString()
  const which = split ? { scope } : {}
  let spent: number
  try {
    spent = await spentTodayUsd(now, split ? scope : undefined)
  } catch (e) {
    console.warn('[spend] could not read today\'s spend:', e instanceof Error ? e.message : e)
    return { allowed: false, spent_usd: null, budget_usd: budget, resumes_at, reason: 'spend ledger unavailable', ...which }
  }
  if (spent >= budget) {
    return { allowed: false, spent_usd: spent, budget_usd: budget, resumes_at, reason: research ? RESEARCH_BUDGET_REACHED : 'daily budget reached', ...which }
  }
  return { allowed: true, spent_usd: spent, budget_usd: budget, resumes_at, ...which }
}

export class BudgetPausedError extends Error {
  constructor(public readonly status: BudgetStatus) {
    super(`Daily budget paused: ${status.reason ?? 'daily budget reached'}`)
    this.name = 'BudgetPausedError'
  }
}

export function describeBudget(status: BudgetStatus): string {
  const spent = status.spent_usd === null ? 'unknown' : `$${status.spent_usd.toFixed(2)}`
  return `${status.reason ?? 'within budget'} (${spent} of $${status.budget_usd.toFixed(2)} spent today, UTC; resumes ${status.resumes_at})`
}

/** The run state in plain words for the public experiment state. */
export function describeRunState(
  exp: { status: string; epoch_in_progress?: boolean | null },
  budget: BudgetStatus | null
): { run_state: string; resumes_at?: string } {
  if (exp.epoch_in_progress) return { run_state: 'running epoch' }
  if (budget && !budget.allowed && (budget.reason === 'daily budget reached' || budget.reason === RESEARCH_BUDGET_REACHED)) {
    return { run_state: budgetPausedState(budget), resumes_at: budget.resumes_at }
  }
  if (exp.status === 'failing') return { run_state: 'failing: stability below 0.2, epochs continue' }
  return { run_state: 'waiting for next epoch' }
}
