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
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from '@vercel/postgres'

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

export async function spentTodayUsd(now: Date = new Date()): Promise<number> {
  await ensureSpendTable()
  const r = await sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM model_calls
    WHERE created_at >= ${utcDayStart(now).toISOString()}
  `
  return Number(r.rows[0]?.total) || 0
}

export interface BudgetStatus {
  allowed: boolean
  spent_usd: number | null  // null when the ledger could not be read
  budget_usd: number
  resumes_at: string        // next UTC midnight
  reason?: string
}

export const BUDGET_PAUSED_STATE = 'paused: daily budget reached'

/**
 * May the lab spend more today? Fails closed: if the ledger can't be read,
 * nothing new starts, because the cap could not be checked.
 */
export async function checkDailyBudget(now: Date = new Date()): Promise<BudgetStatus> {
  const budget = dailyBudgetUsd()
  const resumes_at = nextUtcMidnight(now).toISOString()
  let spent: number
  try {
    spent = await spentTodayUsd(now)
  } catch (e) {
    console.warn('[spend] could not read today\'s spend:', e instanceof Error ? e.message : e)
    return { allowed: false, spent_usd: null, budget_usd: budget, resumes_at, reason: 'spend ledger unavailable' }
  }
  if (spent >= budget) {
    return { allowed: false, spent_usd: spent, budget_usd: budget, resumes_at, reason: 'daily budget reached' }
  }
  return { allowed: true, spent_usd: spent, budget_usd: budget, resumes_at }
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
  if (budget && !budget.allowed && budget.reason === 'daily budget reached') {
    return { run_state: BUDGET_PAUSED_STATE, resumes_at: budget.resumes_at }
  }
  if (exp.status === 'failing') return { run_state: 'failing: stability below 0.2, epochs continue' }
  return { run_state: 'waiting for next epoch' }
}
