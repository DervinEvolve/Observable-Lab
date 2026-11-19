/**
 * How the lab scores a research result (LAB_RESEARCH_CONFIRM, off by default).
 *
 * The research loop keeps a run when its val_bpb is below the best so far.
 * One run can be below the best by luck: the training has a fixed time
 * budget, so two runs of the same train.py do not print the same score.
 * With the switch on the lab does three things, all in its own code:
 *
 *  1. Confirm before best. A run the Reviewer kept, whose score is below the
 *     best, is run once more by the lab: the same train.py, unchanged,
 *     through the same runner and harness. It becomes the new best only if
 *     the mean of the two scores beats the best by more than the margin.
 *     Otherwise it is recorded as within noise, or as not confirmed when the
 *     repeat gives no score, and train.py stays as it was.
 *  2. A noise floor. The margin is max(2 x noise, LAB_RESEARCH_MIN_MARGIN),
 *     and never more than LAB_RESEARCH_MAX_MARGIN. The noise is the spread
 *     between runs of the same file, measured from every confirmation pair
 *     and from control runs: the lab re-runs the current best train.py
 *     unchanged after an epoch, the first three times on consecutive epochs
 *     and then every LAB_RESEARCH_CONTROL_EVERY epochs. Until three repeated
 *     scores exist the margin is the floor alone. The scores the noise is
 *     taken from are printed by generated code, so the estimate is a median
 *     (one wild pair does not move it) and the margin has a ceiling (many
 *     wild pairs cannot lift it without limit).
 *  3. A record. Every repeat is a row in research_repeats, a row in
 *     lab-repeats.tsv in the research repository, and its GPU time goes on
 *     the spend ledger like an epoch's own run.
 *
 * What this is not: a check on honesty. Both scores are printed by the
 * generated train.py. A repeat tells a lucky run from one that repeats; a
 * script that prints a false score prints it twice.
 *
 * Nothing here changes what the models are asked to do. They are told the
 * rule as a fact about the lab (research-prompts.ts), only while it is on.
 * With the switch off none of this code runs: no table, no query, no request.
 */

import { createHash } from 'node:crypto'
import { sql } from '@vercel/postgres'
import { researchAlongside } from './experiment-modes.js'
import { BudgetPausedError, checkDailyBudget, recordModelCall, withSpendContext } from './spend.js'
import {
  appendLabRepeatRow, pollResearchRun, provenanceOf, researchGpuCostUsd, ResearchRunPendingError,
  sanitizeRunResult, startResearchRun,
  type ResearchRunResult, type ResultConfirmColumns,
} from './research.js'
import type { ResearchConfirmVerdict, ResearchScoring } from './types.js'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** On only when the flag is exactly "true". */
export function researchConfirmEnabled(): boolean {
  return (process.env.LAB_RESEARCH_CONFIRM || '').trim().toLowerCase() === 'true'
}

export const DEFAULT_MIN_MARGIN_BPB = 0.002
export const MAX_MIN_MARGIN_BPB = 1
/** The least a new best has to beat the old one by, in val_bpb. Anything that is not a number from 0 to 1 reads as the default. */
export function researchMinMargin(): number {
  const raw = (process.env.LAB_RESEARCH_MIN_MARGIN || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 && n <= MAX_MIN_MARGIN_BPB ? n : DEFAULT_MIN_MARGIN_BPB
}

export const DEFAULT_MAX_MARGIN_BPB = 0.05
/**
 * The most the margin may ever be, in val_bpb. The noise it is worked out
 * from comes from scores the generated train.py prints, so without a ceiling
 * a file that prints wild scores could put the margin out of reach of every
 * real improvement. Anything that is not a number from 0 to 1 reads as the
 * default. The floor always holds: a ceiling below it counts as the floor.
 */
export function researchMaxMargin(): number {
  const raw = (process.env.LAB_RESEARCH_MAX_MARGIN || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 && n <= MAX_MIN_MARGIN_BPB ? n : DEFAULT_MAX_MARGIN_BPB
}

export const DEFAULT_CONTROL_EVERY = 10
/** How many research epochs may pass between two control runs, 1 to 1000. */
export function researchControlEvery(): number {
  const raw = (process.env.LAB_RESEARCH_CONTROL_EVERY || '').trim()
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) ? Math.min(1000, Math.max(1, n)) : DEFAULT_CONTROL_EVERY
}

/** Repeated scores needed before the measured noise is used. */
export const NOISE_MIN_SAMPLES = 3
/** The noise is taken from this many of the newest finished repeats. */
export const NOISE_WINDOW = 30
/**
 * A repeat (a control or a confirmation) still unanswered this long after it
 * was started is given up as lost. Until then a status endpoint that cannot
 * be read counts as "still training": only the runner's own answer, or this
 * age, ends a repeat.
 */
export const REPEAT_LOST_AFTER_MS = 3 * 60 * 60 * 1000
/** The function's own time limit: maxDuration of the tick and run routes in vercel.json. */
export const FUNCTION_LIMIT_MS = 800_000
/** Kept, after a repeat, for everything but the Commentator: the repository writes, the last database writes and starting a control. */
export const CONFIRM_TAIL_MS = 150_000
/**
 * How far into a request the lab still waits for a repeat. What follows the
 * repeat has to fit in the rest of the function's 800 s: one Commentator
 * call at its full timeout (`completionTimeoutMs`: OPENROUTER_TIMEOUT_MS,
 * 240 s by default) and CONFIRM_TAIL_MS for the writes. 410 s by default.
 */
export function confirmWaitDeadlineMs(completionTimeoutMs: number): number {
  const call = finite(completionTimeoutMs) && completionTimeoutMs > 0 ? completionTimeoutMs : 240_000
  return Math.max(0, FUNCTION_LIMIT_MS - call - CONFIRM_TAIL_MS)
}
/**
 * A control is not started later than this into a request: starting it may
 * take the runner's whole start timeout, and a function that is stopped
 * between the start and the row that records it would leave a GPU run nobody
 * collects. A control that is skipped is tried after the next epoch.
 */
export const CONTROL_START_DEADLINE_MS = FUNCTION_LIMIT_MS - 120_000

// ---------------------------------------------------------------------------
// The arithmetic (no I/O)
// ---------------------------------------------------------------------------

export interface NoiseEstimate {
  /** Run-to-run standard deviation of val_bpb between runs of the same train.py, as estimated below. null until measured. */
  noise_bpb: number | null
  /** Scores that have at least one other run of the same train.py beside them. */
  samples: number
  /** How many different train.py files those scores belong to. */
  groups: number
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Turns the median distance between two runs of one file into a standard
 * deviation: for scores with a normal spread s, the median of |a - b| is
 * 0.9539 s, and 1 / 0.9539 = 1.0483.
 */
export const PAIR_DISTANCE_TO_SD = 1.0483

/**
 * The run-to-run spread from groups of scores, one group per train.py. A
 * group of one says nothing about spread and is left out. Inside each group
 * every two scores give one distance, |a - b|; the estimate is the median of
 * all those distances, scaled to a standard deviation. A median, not a
 * pooled variance, because the scores are printed by generated code: one
 * pair that is far apart (a file that prints a random number, a run that
 * diverged) is one distance among the others and does not move the middle,
 * where it would dominate a sum of squares. It is null ("not yet measured")
 * until NOISE_MIN_SAMPLES scores are in such groups.
 */
export function estimateNoise(groups: number[][]): NoiseEstimate {
  let samples = 0
  let used = 0
  const distances: number[] = []
  for (const group of groups) {
    const values = group.filter(finite)
    if (values.length < 2) continue
    for (let a = 0; a < values.length; a++) {
      for (let b = a + 1; b < values.length; b++) distances.push(Math.abs(values[a] - values[b]))
    }
    samples += values.length
    used += 1
  }
  if (samples < NOISE_MIN_SAMPLES || distances.length < 1) return { noise_bpb: null, samples, groups: used }
  return { noise_bpb: PAIR_DISTANCE_TO_SD * median(distances), samples, groups: used }
}

export type MarginBasis = 'noise' | 'floor' | 'ceiling'

export interface Margin {
  margin_bpb: number
  /**
   * noise: twice the measured noise. floor: LAB_RESEARCH_MIN_MARGIN, because
   * the noise is not measured yet or is smaller. ceiling:
   * LAB_RESEARCH_MAX_MARGIN, because twice the measured noise is above it.
   */
  basis: MarginBasis
}

/**
 * max(2 x the measured noise, the floor), and never more than the ceiling;
 * the floor alone while the noise is not measured. A ceiling below the floor
 * counts as the floor.
 */
export function marginFor(noise: NoiseEstimate, minMargin: number, maxMargin: number = DEFAULT_MAX_MARGIN_BPB): Margin {
  const floor = finite(minMargin) && minMargin >= 0 ? minMargin : DEFAULT_MIN_MARGIN_BPB
  const ceiling = finite(maxMargin) && maxMargin >= 0 ? maxMargin : DEFAULT_MAX_MARGIN_BPB
  const twice = noise.noise_bpb === null ? null : 2 * noise.noise_bpb
  if (twice === null || !(twice > floor) || !(ceiling > floor)) return { margin_bpb: floor, basis: 'floor' }
  if (twice > ceiling) return { margin_bpb: ceiling, basis: 'ceiling' }
  return { margin_bpb: twice, basis: 'noise' }
}

const f4 = (v: number) => v.toFixed(4)

/** How the margin was arrived at, for a record line. */
export function describeMargin(noise: NoiseEstimate, margin: Margin): string {
  const scores = `${noise.samples} repeated score${noise.samples === 1 ? '' : 's'}`
  if (noise.noise_bpb === null) return `margin: the floor of ${f4(margin.margin_bpb)}; noise not yet measured, ${scores} so far`
  if (margin.basis === 'noise') return `margin: twice the measured noise of ${f4(noise.noise_bpb)}, from ${scores}`
  if (margin.basis === 'ceiling') return `margin: the ceiling of ${f4(margin.margin_bpb)}, because twice the measured noise of ${f4(noise.noise_bpb)} from ${scores} is above it`
  return `margin: the floor of ${f4(margin.margin_bpb)}, which is above twice the measured noise of ${f4(noise.noise_bpb)} from ${scores}`
}

/** The lab's verdict on a run it repeated, with every number it used. Stored on the epoch's row. */
export interface ConfirmDecision {
  verdict: ResearchConfirmVerdict
  first_bpb: number
  repeat_bpb: number | null
  /** ok, crash, infra_error or lost. */
  repeat_status: string
  mean_bpb: number | null
  /** The best the run had to beat. */
  best_bpb: number
  /** best - mean: positive when the two runs together beat the best. */
  improvement_bpb: number | null
  margin_bpb: number
  margin_basis: MarginBasis
  noise_bpb: number | null
  noise_samples: number
  /** The verdict in one plain line, as the finding page states it. */
  line: string
}

/**
 * The rule. The run becomes the new best only if the mean of its two scores
 * beats the best by more than the margin. A repeat with no score confirms
 * nothing. "More than" is decided at four decimal places, the precision the
 * line and results.tsv record: the two numbers the record shows are the two
 * that were compared, so a tie in the record is never a confirmation and
 * floating-point dust cannot make one.
 */
export function decideConfirmation(args: {
  first: number
  repeat: number | null | undefined
  repeatStatus: string
  best: number
  noise: NoiseEstimate
  minMargin: number
  /** The ceiling, LAB_RESEARCH_MAX_MARGIN. Left out: the default. */
  maxMargin?: number
}): ConfirmDecision {
  const margin = marginFor(args.noise, args.minMargin, args.maxMargin)
  const how = describeMargin(args.noise, margin)
  const common = {
    first_bpb: args.first, best_bpb: args.best, margin_bpb: margin.margin_bpb, margin_basis: margin.basis,
    noise_bpb: args.noise.noise_bpb, noise_samples: args.noise.samples,
  }
  const status = /^[a-z_]{1,20}$/.test(args.repeatStatus) ? args.repeatStatus : 'infra_error'
  if (status !== 'ok' || !finite(args.repeat) || args.repeat < 0) {
    return {
      ...common, verdict: 'not_confirmed', repeat_bpb: null, repeat_status: status === 'ok' ? 'crash' : status, mean_bpb: null, improvement_bpb: null,
      line: `not confirmed: the lab's repeat of the same train.py gave no score (${(status === 'ok' ? 'crash' : status).replace(/_/g, ' ')}); the first run printed ${f4(args.first)} against a best of ${f4(args.best)}; not kept (${how})`,
    }
  }
  const mean = (args.first + args.repeat) / 2
  const improvement = args.best - mean
  const runs = `mean ${f4(mean)} of two runs (${f4(args.first)} and ${f4(args.repeat)})`
  const scored = { ...common, repeat_bpb: args.repeat, repeat_status: 'ok', mean_bpb: mean, improvement_bpb: improvement }
  if (Number(f4(improvement)) > Number(f4(margin.margin_bpb))) {
    return {
      ...scored, verdict: 'confirmed',
      line: `confirmed: ${runs} beats ${f4(args.best)} by ${f4(improvement)}, more than the ${f4(margin.margin_bpb)} margin; kept as the new best at ${f4(mean)} (${how})`,
    }
  }
  return {
    ...scored, verdict: 'within_noise',
    line: improvement > 0
      ? `within noise: ${runs} beats ${f4(args.best)} by ${f4(improvement)}, not more than the ${f4(margin.margin_bpb)} margin; not kept (${how})`
      : `within noise: ${runs} does not beat ${f4(args.best)}; not kept (${how})`,
  }
}

/** A stored decision read back, or undefined when it is not one. */
export function readDecision(raw: unknown): ConfirmDecision | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const d = raw as Record<string, unknown>
  if (d.verdict !== 'confirmed' && d.verdict !== 'within_noise' && d.verdict !== 'not_confirmed') return undefined
  if (!finite(d.first_bpb) || !finite(d.best_bpb) || !finite(d.margin_bpb)) return undefined
  const mean = finite(d.mean_bpb) ? d.mean_bpb : null
  if (d.verdict !== 'not_confirmed' && mean === null) return undefined
  return {
    verdict: d.verdict,
    first_bpb: d.first_bpb,
    repeat_bpb: finite(d.repeat_bpb) ? d.repeat_bpb : null,
    repeat_status: typeof d.repeat_status === 'string' && /^[a-z_]{1,20}$/.test(d.repeat_status) ? d.repeat_status : 'infra_error',
    mean_bpb: mean,
    best_bpb: d.best_bpb,
    improvement_bpb: finite(d.improvement_bpb) ? d.improvement_bpb : null,
    margin_bpb: d.margin_bpb,
    margin_basis: d.margin_basis === 'noise' || d.margin_basis === 'ceiling' ? d.margin_basis : 'floor',
    noise_bpb: finite(d.noise_bpb) ? d.noise_bpb : null,
    noise_samples: finite(d.noise_samples) ? d.noise_samples : 0,
    line: typeof d.line === 'string' ? d.line.replace(/[\r\n\t]+/g, ' ').slice(0, 600) : '',
  }
}

/** The five cells a repeated run adds to its row in results.tsv. */
export function confirmColumns(d: ConfirmDecision): ResultConfirmColumns {
  return { repeat_bpb: d.repeat_bpb, mean_bpb: d.mean_bpb, noise_bpb: d.noise_bpb, margin_bpb: d.margin_bpb, verdict: d.verdict }
}

/**
 * Is a control run due after this epoch? Never while one is still open and
 * never twice for one epoch, which is what keeps it to one per tick: a tick
 * finishes at most one research epoch. The first NOISE_MIN_SAMPLES controls
 * follow consecutive epochs, so the noise is measured within a few epochs of
 * switching this on. After that, one every `every` epochs.
 */
export function controlDue(args: {
  epoch: number
  every: number
  /** The epoch of the newest control, or null when there has been none. */
  lastControlEpoch: number | null
  /** Controls started so far for this experiment. */
  controls: number
  /** A control is still running. */
  open: boolean
}): boolean {
  if (args.open) return false
  if (args.lastControlEpoch === null) return true
  if (args.lastControlEpoch >= args.epoch) return false
  if (args.controls < NOISE_MIN_SAMPLES) return true
  return args.epoch - args.lastControlEpoch >= Math.max(1, args.every)
}

/** SHA-256 of a train.py: two runs are repeats of one another when this is the same. */
export function trainSha256(trainPy: string): string {
  return createHash('sha256').update(trainPy, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export type RepeatKind = 'confirm' | 'control'

export interface RepeatRow {
  id: string
  experiment_id: string
  /** confirm: the epoch whose run is repeated. control: the epoch after which the best train.py was re-run. */
  epoch_number: number
  kind: RepeatKind
  train_sha256: string
  /** confirm: the first run's score. control: the best on record at the time. */
  reference_bpb: number | null
  /** control: the epoch that best came from. */
  reference_epoch: number | null
  call_id: string | null
  /** running, then ok, crash, infra_error or lost. */
  status: string
  val_bpb: number | null
  result: ResearchRunResult | null
  cost_usd: number | null
  ledger_written: boolean
  created_at: string
}

let tableReady: Promise<void> | null = null
/** Made the first time the lab repeats a run, so a lab that never does has no such table. */
export function ensureRepeatsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS research_repeats (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          experiment_id UUID NOT NULL,
          epoch_number INTEGER NOT NULL,
          kind TEXT NOT NULL,
          train_sha256 TEXT NOT NULL,
          reference_bpb DOUBLE PRECISION,
          reference_epoch INTEGER,
          call_id TEXT,
          status TEXT NOT NULL,
          val_bpb DOUBLE PRECISION,
          result JSONB,
          cost_usd NUMERIC(12,6),
          ledger_written BOOLEAN NOT NULL DEFAULT FALSE,
          finished_at TIMESTAMP WITH TIME ZONE,
          UNIQUE (experiment_id, epoch_number, kind)
        )
      `
    })().catch(e => {
      tableReady = null
      throw e
    })
  }
  return tableReady
}

function repeatRow(row: Record<string, unknown>): RepeatRow {
  const number = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  let result: unknown = row.result
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { result = null }
  }
  return {
    id: String(row.id ?? ''),
    experiment_id: String(row.experiment_id ?? ''),
    epoch_number: Number(row.epoch_number) || 0,
    kind: row.kind === 'control' ? 'control' : 'confirm',
    train_sha256: String(row.train_sha256 ?? ''),
    reference_bpb: number(row.reference_bpb),
    reference_epoch: number(row.reference_epoch),
    call_id: row.call_id ? String(row.call_id) : null,
    status: String(row.status ?? ''),
    val_bpb: number(row.val_bpb),
    result: result && typeof result === 'object' ? sanitizeRunResult(result) : null,
    cost_usd: number(row.cost_usd),
    ledger_written: row.ledger_written === true,
    created_at: row.created_at ? new Date(row.created_at as string).toISOString() : '',
  }
}

/** How many of an experiment's newest repeats are read at a time. */
export const REPEATS_READ = 60

/**
 * An experiment's newest lab repeats, newest first. `createTable: false` is
 * for the public state: it only looks, and the caller treats a failure (no
 * such table) as no repeats.
 */
export async function loadRepeats(experimentId: string, opts: { createTable?: boolean } = {}): Promise<RepeatRow[]> {
  if (opts.createTable !== false) await ensureRepeatsTable()
  const r = await sql`
    SELECT * FROM research_repeats WHERE experiment_id = ${experimentId}
    ORDER BY id DESC LIMIT ${REPEATS_READ}
  `
  return r.rows.map(row => repeatRow(row as Record<string, unknown>))
}

/**
 * Writes the row for a repeat that was just started. (experiment, epoch,
 * kind) is unique, so an epoch has one confirmation and is followed by one
 * control at most: null means there already is one.
 */
async function openRepeat(params: {
  experimentId: string
  epoch: number
  kind: RepeatKind
  trainSha256: string
  referenceBpb: number | null
  referenceEpoch: number | null
  callId: string
}): Promise<RepeatRow | null> {
  await ensureRepeatsTable()
  const r = await sql`
    INSERT INTO research_repeats (experiment_id, epoch_number, kind, train_sha256, reference_bpb, reference_epoch, call_id, status)
    VALUES (${params.experimentId}, ${params.epoch}, ${params.kind}, ${params.trainSha256}, ${params.referenceBpb}, ${params.referenceEpoch}, ${params.callId}, ${'running'})
    ON CONFLICT (experiment_id, epoch_number, kind) DO NOTHING
    RETURNING *
  `
  return r.rows[0] ? repeatRow(r.rows[0] as Record<string, unknown>) : null
}

/**
 * Closes a repeat with what the runner answered and puts its GPU time on the
 * spend ledger. Only a row that is still running is closed, and only the
 * request that closed it writes the cost. The cost is the same estimate as
 * for an epoch's own run (researchGpuCostUsd), written under the same
 * condition: only beside run 2, where research has a cap of its own.
 */
async function closeRepeat(row: RepeatRow, outcome: ResearchRunResult | 'lost', budgetS: number): Promise<RepeatRow> {
  const result = outcome === 'lost' ? null : outcome
  const status = outcome === 'lost' ? 'lost' : outcome.status
  const score = result?.status === 'ok' && finite(result.metrics?.val_bpb) ? result.metrics.val_bpb : null
  const cost = researchAlongside() ? researchGpuCostUsd(result ?? undefined, budgetS) : null
  const r = await sql`
    UPDATE research_repeats
    SET status = ${status}, val_bpb = ${score}, result = ${result ? JSON.stringify(result) : null}, cost_usd = ${cost}, finished_at = NOW()
    WHERE id = ${row.id} AND status = ${'running'}
    RETURNING *
  `
  if (!r.rows[0]) return { ...row, status, val_bpb: score, result }
  if (cost !== null) {
    // Under the epoch the repeat belongs to, and the research cap the caller is working under.
    await withSpendContext({ experimentId: row.experiment_id, epochNumber: row.epoch_number }, () =>
      recordModelCall({
        model: row.kind === 'control' ? 'tool/research_gpu_control' : 'tool/research_gpu_repeat', assigned: 'lab',
        cost_usd: cost, cost_source: 'estimate', prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      }))
  }
  return repeatRow(r.rows[0] as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Noise and scoring from the stored repeats
// ---------------------------------------------------------------------------

/**
 * The noise from stored repeats: the newest NOISE_WINDOW finished ones that
 * have a score, grouped by the train.py they ran. A confirmation gives its
 * group two scores (the first run's and the repeat's), a control one.
 */
export function noiseFromRepeats(rows: RepeatRow[]): NoiseEstimate {
  const groups = new Map<string, number[]>()
  const scored = rows.filter(r => r.status === 'ok' && finite(r.val_bpb) && /^[0-9a-f]{64}$/.test(r.train_sha256))
    .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, NOISE_WINDOW)
  for (const r of scored) {
    const values = groups.get(r.train_sha256) ?? []
    if (r.kind === 'confirm' && finite(r.reference_bpb)) values.push(r.reference_bpb)
    values.push(r.val_bpb as number)
    groups.set(r.train_sha256, values)
  }
  return estimateNoise([...groups.values()])
}

/** What the scoring state is now, for the spec and the public state. */
export function scoringSnapshot(args: {
  epoch: number
  rows: RepeatRow[]
  minMargin: number
  /** The ceiling, LAB_RESEARCH_MAX_MARGIN. Left out: the default. */
  maxMargin?: number
  previous?: ResearchScoring
  decision?: ConfirmDecision
}): ResearchScoring {
  // No rows in hand although an earlier snapshot had some: they could not be
  // read this time, and the earlier noise stands rather than "not measured".
  const noise: NoiseEstimate = args.rows.length === 0 && args.previous && args.previous.noise_samples > 0
    ? { noise_bpb: args.previous.noise_bpb, samples: args.previous.noise_samples, groups: 0 }
    : noiseFromRepeats(args.rows)
  const margin = marginFor(noise, args.minMargin, args.maxMargin)
  const control = args.rows.filter(r => r.kind === 'control' && r.status !== 'running').sort((a, b) => Number(b.id) - Number(a.id))[0]
  const d = args.decision
  const lastVerdict = d
    ? {
      epoch: args.epoch, verdict: d.verdict, first_bpb: d.first_bpb, repeat_bpb: d.repeat_bpb, mean_bpb: d.mean_bpb,
      best_bpb: d.best_bpb, margin_bpb: d.margin_bpb, line: d.line,
    }
    : args.previous?.last_verdict
  return {
    noise_bpb: noise.noise_bpb,
    noise_samples: noise.samples,
    margin_bpb: margin.margin_bpb,
    margin_basis: margin.basis,
    min_margin_bpb: args.minMargin,
    max_margin_bpb: Math.max(args.minMargin, args.maxMargin ?? DEFAULT_MAX_MARGIN_BPB),
    updated_epoch: args.epoch,
    ...(lastVerdict ? { last_verdict: lastVerdict } : {}),
    ...(control
      ? { last_control: { epoch: control.epoch_number, status: control.status, val_bpb: control.val_bpb, reference_bpb: control.reference_bpb } }
      : args.previous?.last_control ? { last_control: args.previous.last_control } : {}),
  }
}

/**
 * Told to the research models only while the switch is on. A fact about how
 * the lab scores, with its limits: nothing here asks for anything.
 */
export function scoringPromptNote(rows: RepeatRow[], minMargin: number, maxMargin: number = DEFAULT_MAX_MARGIN_BPB): string {
  const noise = noiseFromRepeats(rows)
  const margin = marginFor(noise, minMargin, maxMargin)
  return `

HOW THE LAB SCORES A NEW BEST (a fact about the lab, not a goal; val_bpb is still the only thing a run is judged on): when the Reviewer keeps a run whose val_bpb is below the current best, the lab runs the same train.py once more, unchanged, through the same runner and harness. The run becomes the new best only if the mean of the two scores beats the current best by more than the margin, and the new best is then recorded as that mean. Otherwise the result is recorded as within noise, or as not confirmed when the repeat gives no score, and train.py stays as it was. The margin now is ${f4(margin.margin_bpb)} val_bpb (${describeMargin(noise, margin)}); it is the larger of a fixed floor and twice the run-to-run noise the lab measures by running the same file more than once, which it also does now and then with the current best train.py, and it is never more than a fixed ceiling of ${f4(Math.max(minMargin, maxMargin))}. In results.tsv the columns repeat_val_bpb, mean_val_bpb, noise_bpb, margin_bpb and confirm hold this for a run that was repeated. Its limits: a repeat tells a lucky run from one that repeats, and nothing more. Both scores are printed by train.py itself, so the repeat does not make a score independently evaluated.`
}

// ---------------------------------------------------------------------------
// Running repeats
// ---------------------------------------------------------------------------

/**
 * One look at a repeat that is still open. A result: the runner answered
 * with the run's own outcome. 'lost': the runner itself says the call failed
 * or is gone (a control), there is no call to ask about, or the repeat has
 * been unanswered for REPEAT_LOST_AFTER_MS. null: still training, as far as
 * the lab knows. A status endpoint that could not be read (an HTTP error
 * from a gateway, a timeout, an answer that is not the runner's) is not an
 * outcome: the run may be training fine, so it counts as still training
 * until the runner answers or the age limit passes.
 */
async function settleRepeat(row: RepeatRow, now: number = Date.now()): Promise<ResearchRunResult | 'lost' | null> {
  if (!row.call_id) return 'lost'
  let poll: Awaited<ReturnType<typeof pollResearchRun>> | null
  try {
    poll = await pollResearchRun(row.call_id)
  } catch {
    poll = null
  }
  if (poll?.status === 'done') return poll.result
  if (poll?.status === 'failed' && poll.reported === true) {
    return row.kind === 'control' ? 'lost' : { status: 'infra_error', error: poll.error }
  }
  const age = now - Date.parse(row.created_at || '')
  return Number.isFinite(age) && age > REPEAT_LOST_AFTER_MS ? 'lost' : null
}

/**
 * Asks the runner once about each repeat that an earlier epoch left open and
 * closes the ones that have answered, were lost, or have been silent too
 * long: every control, and a confirmation whose own epoch is over. (A
 * confirmation of the epoch that is running is waited for by that epoch,
 * confirmNewBest.) A confirmation is left behind when its epoch finished
 * without it, which is what happens when the switch goes off while a repeat
 * is training: closing it here puts its GPU time on the ledger and its score
 * in the noise. Called at the start of a research epoch. Returns the
 * experiment's repeats as they are afterwards. Never throws: without the
 * rows the margin is the floor.
 */
export async function collectRepeats(experimentId: string, epoch: number, budgetS: number, now: Date = new Date()): Promise<RepeatRow[]> {
  try {
    const rows = await loadRepeats(experimentId)
    let changed = false
    for (const row of rows) {
      if (row.status !== 'running') continue
      if (row.kind !== 'control' && !(row.epoch_number < epoch)) continue
      const outcome = await settleRepeat(row, now.getTime())
      if (!outcome) continue
      const closed = await closeRepeat(row, outcome, budgetS)
      changed = true
      console.log(`[Research] ${row.kind === 'control' ? `control after epoch ${row.epoch_number}` : `repeat left open by epoch ${row.epoch_number}`} collected: ${closed.status} val_bpb=${closed.val_bpb ?? 'n/a'}`)
    }
    return changed ? await loadRepeats(experimentId) : rows
  } catch (e) {
    console.warn('[Research] could not collect the lab\'s repeat runs (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * Waits for a repeat while the request has time, asking the runner at least
 * once however little time is left. null: still training at the deadline.
 */
async function awaitRepeat(row: RepeatRow, maxWaitMs: number, pollMs = 15_000): Promise<ResearchRunResult | 'lost' | null> {
  const deadline = Date.now() + Math.max(0, maxWaitMs)
  for (;;) {
    const outcome = await settleRepeat(row)
    if (outcome) return outcome
    const left = deadline - Date.now()
    if (left <= 0) return null
    await new Promise(r => setTimeout(r, Math.min(pollMs, left)))
  }
}

/**
 * The lab's repeat of a run that would become the best: starts it if this
 * epoch has none yet, waits for it while the request has time, and returns
 * the verdict. Throws ResearchRunPendingError when the repeat is still
 * training or the runner could not be asked about it (the next tick picks
 * the same call up again), BudgetPausedError when the day's cap is reached
 * before the repeat is started (the epoch waits as it is, with the
 * Reviewer's verdict stored, and is picked up when the cap resets), and any
 * error from starting the run, like the epoch's own run does.
 */
export async function confirmNewBest(args: {
  experimentId: string
  epoch: number
  trainPy: string
  first: number
  best: number
  budgetS: number
  /** How long this request may still wait, in ms. */
  maxWaitMs: number
}): Promise<ConfirmDecision> {
  const mine = (rows: RepeatRow[]) => rows.find(r => r.kind === 'confirm' && r.epoch_number === args.epoch)
  let row = mine(await loadRepeats(args.experimentId))
  if (!row) {
    // A repeat is one more GPU run. The cap was checked when the tick began,
    // before the epoch's own run, which may have used up what was left: it
    // is checked again here (research's own cap beside run 2, the one cap
    // otherwise), and nothing is started once it is reached or cannot be
    // read. The candidate is not thrown away for that: the epoch stops here
    // and repeats the run when the cap allows.
    const budget = await checkDailyBudget(new Date(), 'research')
    if (!budget.allowed) throw new BudgetPausedError(budget)
    const callId = await startResearchRun(args.trainPy, args.budgetS)
    row = await openRepeat({
      experimentId: args.experimentId, epoch: args.epoch, kind: 'confirm', trainSha256: trainSha256(args.trainPy),
      referenceBpb: args.first, referenceEpoch: args.epoch, callId,
    }) ?? mine(await loadRepeats(args.experimentId))
    if (!row) throw new Error('the lab could not store its repeat run')
    console.log(`[Research e${args.epoch}] lab repeat started: ${callId}`)
  }
  if (row.status === 'running') {
    const outcome = await awaitRepeat(row, args.maxWaitMs)
    if (outcome === null) throw new ResearchRunPendingError(row.call_id as string)
    row = await closeRepeat(row, outcome, args.budgetS)
    console.log(`[Research e${args.epoch}] lab repeat finished: ${row.status} val_bpb=${row.val_bpb ?? 'n/a'}`)
  }
  // The noise as it is now, this pair included.
  const noise = noiseFromRepeats(await loadRepeats(args.experimentId).catch(() => [row as RepeatRow]))
  return decideConfirmation({
    // The first score as it was stored when the repeat was started.
    first: finite(row.reference_bpb) ? row.reference_bpb : args.first,
    repeat: row.val_bpb, repeatStatus: row.status, best: args.best, noise, minMargin: researchMinMargin(), maxMargin: researchMaxMargin(),
  })
}

/**
 * After an epoch: starts a control run of the current best train.py when
 * one is due and the day's cap is not reached. Returns the epoch it was
 * started for, or null. Never throws: a control that could not be started is
 * tried again after the next epoch.
 */
export async function maybeStartControl(args: {
  experimentId: string
  epoch: number
  /** The train.py that holds the best score now. */
  trainPy: string
  bestBpb: number
  bestEpoch: number
  budgetS: number
  /** How far into its request the caller is, in ms. Past CONTROL_START_DEADLINE_MS nothing is started. */
  requestElapsedMs?: number
}): Promise<number | null> {
  try {
    if (finite(args.requestElapsedMs) && args.requestElapsedMs > CONTROL_START_DEADLINE_MS) {
      console.log(`[Research e${args.epoch}] no control run: ${Math.round(args.requestElapsedMs / 1000)} s into the request, too late to start one safely; tried again after the next epoch`)
      return null
    }
    const controls = (await loadRepeats(args.experimentId)).filter(r => r.kind === 'control')
    const last = controls.length ? Math.max(...controls.map(r => r.epoch_number)) : null
    if (!controlDue({
      epoch: args.epoch, every: researchControlEvery(), lastControlEpoch: last, controls: controls.length,
      open: controls.some(r => r.status === 'running'),
    })) return null
    // A control is extra spend the epoch did not have to make: none once the
    // day's cap is reached (research's own cap beside run 2, the one cap
    // otherwise), or when the cap cannot be checked.
    const budget = await checkDailyBudget(new Date(), 'research')
    if (!budget.allowed) {
      console.log(`[Research e${args.epoch}] no control run: ${budget.reason ?? 'daily budget reached'}`)
      return null
    }
    const callId = await startResearchRun(args.trainPy, args.budgetS)
    const row = await openRepeat({
      experimentId: args.experimentId, epoch: args.epoch, kind: 'control', trainSha256: trainSha256(args.trainPy),
      referenceBpb: args.bestBpb, referenceEpoch: args.bestEpoch, callId,
    })
    if (!row) return null
    console.log(`[Research e${args.epoch}] control run of the best train.py started: ${callId}`)
    return args.epoch
  } catch (e) {
    console.warn(`[Research e${args.epoch}] could not start a control run (non-fatal):`, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Writes finished repeats that are not in lab-repeats.tsv yet, a few at a
 * time, oldest first. Never throws: a row that could not be written is tried
 * again at the next epoch.
 */
export async function writeRepeatLedger(experimentId: string): Promise<number> {
  let written = 0
  try {
    const pending = (await loadRepeats(experimentId)).filter(r => r.status !== 'running' && !r.ledger_written)
      .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, 4)
    for (const row of pending) {
      await appendLabRepeatRow({
        kind: row.kind, epoch: row.epoch_number, train_sha256: row.train_sha256, val_bpb: row.val_bpb, status: row.status,
        reference_bpb: row.reference_bpb, reference_epoch: row.reference_epoch,
        provenance: provenanceOf(row.result ?? undefined), call_id: row.call_id,
      })
      await sql`UPDATE research_repeats SET ledger_written = TRUE WHERE id = ${row.id}`
      written += 1
    }
  } catch (e) {
    console.warn('[Research] could not write lab-repeats.tsv (non-fatal):', e instanceof Error ? e.message : e)
  }
  return written
}

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

/** One lab repeat as the public sees it. */
export interface PublicRepeat {
  kind: RepeatKind
  epoch: number
  status: string
  val_bpb: number | null
  reference_bpb: number | null
  train_sha256: string
  started_at: string
}

export function publicRepeat(row: RepeatRow): PublicRepeat {
  return {
    kind: row.kind, epoch: row.epoch_number, status: row.status, val_bpb: row.val_bpb, reference_bpb: row.reference_bpb,
    train_sha256: /^[0-9a-f]{64}$/.test(row.train_sha256) ? row.train_sha256 : '', started_at: row.created_at,
  }
}

/** For tests: forget that the table was made. */
export function resetRepeatsTable(): void {
  tableReady = null
}
