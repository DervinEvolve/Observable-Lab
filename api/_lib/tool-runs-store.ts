/**
 * tool_runs: one row per tool use the Executor chose (subagents, a Sprite
 * session, a GPU job, an exhibit, a lab proposal), including the ones that
 * were refused or failed. The room reads the recent ones from the public
 * state; the daily limits count them. Created at runtime like the other
 * run 2 tables.
 *
 * Output text is cleaned before it is stored and again when it is served.
 */
import { sql } from '@vercel/postgres'
import { sanitizeOutput, tailBytes } from './sprites.js'
import { utcDayStart } from './spend.js'

export type ToolRunStatus = 'ok' | 'failed' | 'error' | 'timeout' | 'skipped' | 'opened' | 'merged' | 'closed'

export interface ToolRunInput {
  experimentId: string
  epoch: number
  model: string           // OpenRouter id of the model that asked
  tool: string            // tool name, e.g. sprite_session, gpu_job, exhibit, subagent_explore
  requestSummary: string  // short plain text of what was asked
  status: ToolRunStatus
  exitCode?: number | null
  durationMs?: number | null
  costUsd?: number
  outputTail?: string | null
  detail?: Record<string, unknown> | null // small structured extras (pr_url, slug, commands)
}

export const TOOL_OUTPUT_TAIL_BYTES = 4096

let tableReady: Promise<void> | null = null
export function ensureToolRunsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS tool_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          experiment_id UUID NOT NULL,
          epoch INTEGER NOT NULL,
          model TEXT NOT NULL,
          tool TEXT NOT NULL,
          request_summary TEXT,
          status TEXT NOT NULL,
          exit_code INTEGER,
          duration_ms INTEGER,
          cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          output_tail TEXT,
          detail JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `
      await sql`CREATE INDEX IF NOT EXISTS idx_tool_runs_experiment ON tool_runs(experiment_id, epoch)`
      await sql`CREATE INDEX IF NOT EXISTS idx_tool_runs_created ON tool_runs(tool, created_at)`
    })().catch(e => {
      tableReady = null
      throw e
    })
  }
  return tableReady
}

export function cleanTail(text: string | null | undefined, maxBytes = TOOL_OUTPUT_TAIL_BYTES): string | null {
  if (text === null || text === undefined || text === '') return null
  return tailBytes(sanitizeOutput(tailBytes(String(text), maxBytes * 2)), maxBytes)
}

// Detail values are model text in places (slugs, titles); keep them short and clean.
function cleanDetail(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail) return null
  const clean = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return sanitizeOutput(v).slice(0, 400)
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'boolean' || v === null) return v
    if (depth > 3) return null
    if (Array.isArray(v)) return v.slice(0, 16).map(x => clean(x, depth + 1))
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 24)) out[k.slice(0, 40)] = clean(x, depth + 1)
      return out
    }
    return null
  }
  return JSON.stringify(clean(detail, 0))
}

/** Stores one tool run. Never throws: a store failure is logged, the epoch goes on. */
export async function recordToolRun(run: ToolRunInput): Promise<void> {
  try {
    await ensureToolRunsTable()
    await sql`
      INSERT INTO tool_runs (
        experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail
      ) VALUES (
        ${run.experimentId}, ${run.epoch}, ${run.model}, ${run.tool},
        ${sanitizeOutput(run.requestSummary).slice(0, 500)}, ${run.status},
        ${run.exitCode ?? null}, ${run.durationMs === null || run.durationMs === undefined ? null : Math.round(run.durationMs)},
        ${Math.max(0, run.costUsd ?? 0)}, ${cleanTail(run.outputTail)}, ${cleanDetail(run.detail)}
      )
    `
  } catch (e) {
    console.warn('[tool-runs] could not store a tool run:', e instanceof Error ? e.message : e)
  }
}

/** Runs of a tool since 00:00 UTC that count toward its daily limit (refusals do not). */
export async function toolRunsToday(tool: string, now: Date = new Date()): Promise<number> {
  await ensureToolRunsTable()
  const r = await sql`
    SELECT COUNT(*) AS n FROM tool_runs
    WHERE tool = ${tool} AND created_at >= ${utcDayStart(now).toISOString()} AND status <> 'skipped'
  `
  return Number(r.rows[0]?.n) || 0
}

/** Tools already run for this epoch (an epoch resumed after a timeout must not run them twice). */
export async function toolsRunInEpoch(experimentId: string, epoch: number): Promise<Set<string>> {
  try {
    await ensureToolRunsTable()
    const r = await sql`
      SELECT DISTINCT tool FROM tool_runs WHERE experiment_id = ${experimentId} AND epoch = ${epoch}
    `
    return new Set(r.rows.map(row => String(row.tool)))
  } catch {
    // Unknown: treat everything as already run, so nothing runs twice.
    return new Set(['*'])
  }
}

export interface ToolRunRow {
  id: string
  epoch: number
  model: string
  tool: string
  request_summary: string | null
  status: string
  exit_code: number | null
  duration_ms: number | null
  cost_usd: number
  output_tail: string | null
  detail: Record<string, unknown> | null
  created_at: string
}

/** Recent runs for the public state, newest first, cleaned again on the way out. */
export async function getRecentToolRuns(experimentId: string, limit = 12): Promise<ToolRunRow[]> {
  try {
    await ensureToolRunsTable()
    const r = await sql`
      SELECT id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail, created_at
      FROM tool_runs
      WHERE experiment_id = ${experimentId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    return r.rows.map(row => publicToolRun(row as Record<string, unknown>))
  } catch (e) {
    console.warn('[tool-runs] read failed (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

export function publicToolRun(row: Record<string, unknown>): ToolRunRow {
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
  let detail: Record<string, unknown> | null = null
  if (row.detail && typeof row.detail === 'object') detail = row.detail as Record<string, unknown>
  else if (typeof row.detail === 'string') {
    try { detail = JSON.parse(row.detail) } catch { detail = null }
  }
  if (detail) detail = JSON.parse(cleanDetail(detail) || 'null')
  return {
    id: String(row.id ?? ''),
    epoch: Number(row.epoch) || 0,
    model: String(row.model ?? ''),
    tool: String(row.tool ?? ''),
    request_summary: row.request_summary ? sanitizeOutput(String(row.request_summary)).slice(0, 500) : null,
    status: String(row.status ?? ''),
    exit_code: num(row.exit_code),
    duration_ms: num(row.duration_ms),
    cost_usd: num(row.cost_usd) ?? 0,
    output_tail: cleanTail(row.output_tail as string | null),
    detail,
    created_at: row.created_at ? new Date(row.created_at as string).toISOString() : '',
  }
}
