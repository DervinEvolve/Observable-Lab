/**
 * Who may run an epoch right now, and when the next one is due.
 *
 * The claim is one conditional UPDATE, so the hourly cron and a manual
 * /api/epoch/run can never both start an epoch on the same experiment: only
 * the request whose UPDATE flips the flag gets a row back.
 */
import { sql } from '@vercel/postgres'

// Statuses that keep running epochs. `failing` is included on purpose: a
// spec with low stability can recover, and the public state says so.
export const ACTIVE_STATUSES = ['seeding', 'growing', 'stable', 'failing'] as const

export class EpochBusyError extends Error {
  constructor(experimentId: string) {
    super(`An epoch is already in progress for experiment ${experimentId}`)
    this.name = 'EpochBusyError'
  }
}

/** Atomically marks the experiment's epoch as started. False when someone else holds it. */
export async function claimEpoch(experimentId: string): Promise<boolean> {
  const result = await sql`
    UPDATE experiments
    SET epoch_in_progress = TRUE, epoch_started_at = NOW()
    WHERE id = ${experimentId}
      AND epoch_in_progress IS NOT TRUE
      AND status <> 'archived'
    RETURNING id
  `
  return result.rows.length > 0
}

/** Releases the claim. Safe to call when it is already released. */
export async function releaseEpoch(experimentId: string): Promise<void> {
  await sql`
    UPDATE experiments SET epoch_in_progress = FALSE, epoch_started_at = NULL
    WHERE id = ${experimentId}
  `
}

/**
 * Clears a claim older than `staleMinutes` (a function that died at its
 * time limit never releases it). Conditional, so a claim taken a moment ago
 * by another request is left alone.
 */
export async function clearStaleClaim(experimentId: string, staleMinutes: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString()
  const result = await sql`
    UPDATE experiments
    SET epoch_in_progress = FALSE, epoch_started_at = NULL
    WHERE id = ${experimentId}
      AND epoch_in_progress = TRUE
      AND (epoch_started_at IS NULL OR epoch_started_at < ${cutoff})
    RETURNING id
  `
  return result.rows.length > 0
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

export const DEFAULT_EPOCH_INTERVAL_MINUTES = 180
export const DEFAULT_EPOCH_STALE_MINUTES = 50
// The interval runs from the END of the last epoch and the cron fires on the
// hour, so an epoch that ends at :08 would otherwise wait an extra hour.
export const CADENCE_TOLERANCE_MINUTES = 10

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim())
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback
}

export function envEpochIntervalMinutes(): number {
  return positiveNumber(process.env.EPOCH_INTERVAL_MINUTES, DEFAULT_EPOCH_INTERVAL_MINUTES)
}

export function envEpochStaleMinutes(): number {
  return positiveNumber(process.env.EPOCH_STALE_MINUTES, DEFAULT_EPOCH_STALE_MINUTES)
}

/** Interval for this experiment: the agents' own setting (clamped 30-180 when written) or the env default. */
export function epochIntervalMinutes(spec: unknown): number {
  const params = (spec as { meta?: { experiment_params?: { epoch_interval_minutes?: unknown } } } | null)?.meta?.experiment_params
  const own = params?.epoch_interval_minutes
  return typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : envEpochIntervalMinutes()
}

export interface Cadence {
  due: boolean
  minutes_since_last: number | null // null when no epoch has finished yet
  minutes_remaining: number
  interval_minutes: number
}

export function epochCadence(lastEpochEndedAt: string | Date | null | undefined, intervalMinutes: number, now = Date.now()): Cadence {
  const last = lastEpochEndedAt ? new Date(lastEpochEndedAt).getTime() : NaN
  if (!Number.isFinite(last)) {
    return { due: true, minutes_since_last: null, minutes_remaining: 0, interval_minutes: intervalMinutes }
  }
  const since = (now - last) / 60_000
  const needed = Math.max(0, intervalMinutes - CADENCE_TOLERANCE_MINUTES)
  return {
    due: since >= needed,
    minutes_since_last: since,
    minutes_remaining: Math.max(0, Math.ceil(needed - since)),
    interval_minutes: intervalMinutes,
  }
}
