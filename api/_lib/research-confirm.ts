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
 *     through the same runner. (While LAB_ENABLE_RESEARCH_TALK is on, the
 *     epoch's own run has the runner's save step and the repeat does not:
 *     the repeat is started without a key. The verdict line and
 *     lab-repeats.tsv say so.) It becomes the new best only if the mean of
 *     the two scores beats the best by more than the margin. Otherwise it is
 *     recorded as within noise, or as not confirmed when the repeat gives no
 *     score, and train.py stays as it was.
 *  2. A noise floor. The margin is max(2 x noise, LAB_RESEARCH_MIN_MARGIN),
 *     and never more than LAB_RESEARCH_MAX_MARGIN. The noise is the spread
 *     between runs of the same file, measured from every confirmation pair
 *     and from control runs: the lab re-runs the current best train.py
 *     unchanged after an epoch, the first three times on consecutive epochs
 *     and then every LAB_RESEARCH_CONTROL_EVERY epochs. Until three repeated
 *     scores exist the margin is the floor alone. The scores the noise is
 *     taken from are printed by generated code, so each file's spread is
 *     taken about its own middle score, the estimate is the middle of those
 *     spreads with every run counted once (one wild score, or one wild pair,
 *     does not set it), and the margin has a ceiling (many wild scores
 *     cannot lift it without limit). The run being judged is not in the
 *     noise that judges it: its own pair counts only for later epochs.
 *  3. A record. Every repeat is a row in research_repeats, written before
 *     the runner is asked, so no GPU run the lab starts goes unrecorded; a
 *     row in lab-repeats.tsv in the research repository; and its GPU time
 *     goes on the spend ledger like an epoch's own run. Until it is
 *     collected, an open repeat counts against the research cap at the full
 *     estimate of a run.
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
import {
  BudgetPausedError, checkDailyBudget, recordModelCall, RESEARCH_BUDGET_REACHED, withSpendContext, type BudgetStatus,
} from './spend.js'
import {
  appendLabRepeatRow, pollResearchRun, provenanceOf, researchGpuCostUsd, ResearchRunPendingError,
  RunnerStartRefusedError, sanitizeRunResult, startResearchRun,
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
 * No repeat, a confirmation or a control, is started later than this into a
 * request, counted from when the request began (the tick or the manual
 * route, before anything else it does): starting one may take the runner's
 * whole start timeout, and the call id it hands back still has to be
 * written. A confirmation that is not started for this is started early in
 * the next tick's request; a control is tried after the next epoch.
 */
export const REPEAT_START_DEADLINE_MS = FUNCTION_LIMIT_MS - 120_000
/** The same deadline, under the name it had when it applied to controls only. */
export const CONTROL_START_DEADLINE_MS = REPEAT_START_DEADLINE_MS
/**
 * A repeat's row is written before the runner is asked to start it (status
 * starting, no call id), and the call id is written when the runner hands it
 * back. A row still starting this long after it was written was left by a
 * request that stopped in between, which is certainly over by now: the run
 * may or may not have been started, and nothing can ask about it. It is
 * closed as lost, charged at the full estimate, and never started again.
 */
export const REPEAT_START_LOST_AFTER_MS = FUNCTION_LIMIT_MS + 60_000

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
 * For a file run k times, what the median distance of its scores from their
 * own middle score is multiplied by to estimate the standard deviation:
 * chosen so that, for scores with a normal spread s, the middle of many such
 * estimates is s. For a pair the median distance is half the pair's
 * distance, so the factor is twice PAIR_DISTANCE_TO_SD and a pair counts
 * exactly as it did when the noise was a median of pair distances. For 3 to
 * 10 runs the factors come from a simulation of 1.5 million groups of
 * normal scores each, rounded to two places; above 10 runs it is
 * 1.4826 x (1 + 1.2 / k), within one per cent of the same simulation and
 * tending to the large-sample 1.4826.
 */
const MAD_TO_SD = [NaN, NaN, 2 * PAIR_DISTANCE_TO_SD, 2.77, 2.21, 1.99, 1.87, 1.79, 1.75, 1.71, 1.68]
export function madToSd(k: number): number {
  if (!Number.isInteger(k) || k < 2) return NaN
  return k < MAD_TO_SD.length ? MAD_TO_SD[k] : 1.4826 * (1 + 1.2 / k)
}

/** The middle of values that each count `weight` times. */
function weightedMedian(items: Array<{ value: number; weight: number }>): number {
  const sorted = [...items].sort((a, b) => a.value - b.value)
  const half = sorted.reduce((sum, item) => sum + item.weight, 0) / 2
  let seen = 0
  for (let i = 0; i < sorted.length; i++) {
    seen += sorted[i].weight
    if (seen > half) return sorted[i].value
    if (seen === half && i + 1 < sorted.length) return (sorted[i].value + sorted[i + 1].value) / 2
  }
  return sorted[sorted.length - 1].value
}

/**
 * The run-to-run spread from groups of scores, one group per train.py. A
 * group of one says nothing about spread and is left out. Each group gives
 * one spread: the median distance of its scores from the group's own middle
 * score, times madToSd(k). The estimate is the middle of those spreads, each
 * counted once for every run in its group, so every run counts once.
 * Medians throughout, not a pooled variance, because the scores are printed
 * by generated code. One wild score among three or more runs of a file (a
 * control that diverged) is one distance from the middle among the others
 * and does not set that file's spread, where with distances between every
 * two runs it would have been in most of them. One pair that is far apart (a
 * file that prints a random number) is one spread among the others and does
 * not move the middle, where it would dominate a sum of squares. It is null
 * ("not yet measured") until NOISE_MIN_SAMPLES scores are in such groups.
 */
export function estimateNoise(groups: number[][]): NoiseEstimate {
  let samples = 0
  const spreads: Array<{ value: number; weight: number }> = []
  for (const group of groups) {
    const values = group.filter(finite)
    if (values.length < 2) continue
    const middle = median(values)
    spreads.push({ value: madToSd(values.length) * median(values.map(v => Math.abs(v - middle))), weight: values.length })
    samples += values.length
  }
  if (samples < NOISE_MIN_SAMPLES || spreads.length < 1) return { noise_bpb: null, samples, groups: spreads.length }
  return { noise_bpb: weightedMedian(spreads), samples, groups: spreads.length }
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
  /** The noise was measured without this run's own two scores, and the line says so. */
  ownPairLeftOut?: boolean
  /** One more plain clause for the end of the line, such as how the two runs differed in the runner. */
  note?: string
}): ConfirmDecision {
  const margin = marginFor(args.noise, args.minMargin, args.maxMargin)
  const how = describeMargin(args.noise, margin) + (args.ownPairLeftOut ? ', not counting this run\'s own two scores' : '')
  const note = args.note ? `; ${args.note.replace(/[\r\n\t]+/g, ' ').slice(0, 200)}` : ''
  const common = {
    first_bpb: args.first, best_bpb: args.best, margin_bpb: margin.margin_bpb, margin_basis: margin.basis,
    noise_bpb: args.noise.noise_bpb, noise_samples: args.noise.samples,
  }
  const status = /^[a-z_]{1,20}$/.test(args.repeatStatus) ? args.repeatStatus : 'infra_error'
  if (status !== 'ok' || !finite(args.repeat) || args.repeat < 0) {
    return {
      ...common, verdict: 'not_confirmed', repeat_bpb: null, repeat_status: status === 'ok' ? 'crash' : status, mean_bpb: null, improvement_bpb: null,
      line: `not confirmed: the lab's repeat of the same train.py gave no score (${(status === 'ok' ? 'crash' : status).replace(/_/g, ' ')}); the first run printed ${f4(args.first)} against a best of ${f4(args.best)}; not kept (${how})${note}`,
    }
  }
  const mean = (args.first + args.repeat) / 2
  const improvement = args.best - mean
  const runs = `mean ${f4(mean)} of two runs (${f4(args.first)} and ${f4(args.repeat)})`
  const scored = { ...common, repeat_bpb: args.repeat, repeat_status: 'ok', mean_bpb: mean, improvement_bpb: improvement }
  if (Number(f4(improvement)) > Number(f4(margin.margin_bpb))) {
    return {
      ...scored, verdict: 'confirmed',
      line: `confirmed: ${runs} beats ${f4(args.best)} by ${f4(improvement)}, more than the ${f4(margin.margin_bpb)} margin; kept as the new best at ${f4(mean)} (${how})${note}`,
    }
  }
  return {
    ...scored, verdict: 'within_noise',
    line: improvement > 0
      ? `within noise: ${runs} beats ${f4(args.best)} by ${f4(improvement)}, not more than the ${f4(margin.margin_bpb)} margin; not kept (${how})${note}`
      : `within noise: ${runs} does not beat ${f4(args.best)}; not kept (${how})${note}`,
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
  /**
   * starting (the row is written before the runner is asked, and has no call
   * id yet), running (the call id is written), then ok, crash, infra_error
   * or lost.
   */
  status: string
  val_bpb: number | null
  result: ResearchRunResult | null
  cost_usd: number | null
  ledger_written: boolean
  created_at: string
}

/** A repeat that has not finished: being started, or training. Its GPU time is not on the ledger yet. */
export function repeatOpen(status: string): boolean {
  return status === 'starting' || status === 'running'
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

interface RepeatStart {
  experimentId: string
  epoch: number
  kind: RepeatKind
  trainPy: string
  referenceBpb: number | null
  referenceEpoch: number | null
  budgetS: number
}

/**
 * Starts a repeat so that no GPU run the lab starts can go unrecorded. The
 * row is written first (starting, no call id), then the runner is asked,
 * then the call id goes on the row. A request stopped in between leaves a
 * row that says a run may have been started; it is closed as lost at the
 * full estimate once REPEAT_START_LOST_AFTER_MS has passed (settleRepeat),
 * and nothing starts it again. When the runner answers that it started
 * nothing (RunnerStartRefusedError) the row is removed, so a later epoch
 * can try again; any other failure leaves the row as it is, because the run
 * may have started. (experiment, epoch, kind) is unique, so an epoch has
 * one confirmation and is followed by one control at most: null means there
 * already is one, and nothing was started.
 */
async function startRepeat(params: RepeatStart): Promise<RepeatRow | null> {
  await ensureRepeatsTable()
  const inserted = await sql`
    INSERT INTO research_repeats (experiment_id, epoch_number, kind, train_sha256, reference_bpb, reference_epoch, call_id, status)
    VALUES (${params.experimentId}, ${params.epoch}, ${params.kind}, ${trainSha256(params.trainPy)}, ${params.referenceBpb}, ${params.referenceEpoch}, ${null}, ${'starting'})
    ON CONFLICT (experiment_id, epoch_number, kind) DO NOTHING
    RETURNING *
  `
  if (!inserted.rows[0]) return null
  const row = repeatRow(inserted.rows[0] as Record<string, unknown>)
  let callId: string
  try {
    callId = await startResearchRun(params.trainPy, params.budgetS)
  } catch (e) {
    if (e instanceof RunnerStartRefusedError) {
      await sql`DELETE FROM research_repeats WHERE id = ${row.id} AND status = ${'starting'}`.catch(() => undefined)
    }
    throw e
  }
  const started = await sql`
    UPDATE research_repeats SET call_id = ${callId}, status = ${'running'}
    WHERE id = ${row.id} AND status = ${'starting'}
    RETURNING *
  `
  return started.rows[0] ? repeatRow(started.rows[0] as Record<string, unknown>) : { ...row, call_id: callId, status: 'running' }
}

/**
 * Closes a repeat with what the runner answered and puts its GPU time on the
 * spend ledger. Only a row that is still open (starting or running) is
 * closed, and only the request that closed it writes the cost. A row closed
 * as lost has no measured time and is charged the full estimate. The cost is the same estimate as
 * for an epoch's own run (researchGpuCostUsd), written under the same
 * condition: only beside run 2, where research has a cap of its own.
 */
async function closeRepeat(row: RepeatRow, outcome: ResearchRunResult | 'lost', budgetS: number): Promise<RepeatRow> {
  if (!repeatOpen(row.status)) return row
  const result = outcome === 'lost' ? null : outcome
  const status = outcome === 'lost' ? 'lost' : outcome.status
  const score = result?.status === 'ok' && finite(result.metrics?.val_bpb) ? result.metrics.val_bpb : null
  const cost = researchAlongside() ? researchGpuCostUsd(result ?? undefined, budgetS) : null
  const r = await sql`
    UPDATE research_repeats
    SET status = ${status}, val_bpb = ${score}, result = ${result ? JSON.stringify(result) : null}, cost_usd = ${cost}, finished_at = NOW()
    WHERE id = ${row.id} AND status = ${row.status}
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
  const control = args.rows.filter(r => r.kind === 'control' && !repeatOpen(r.status)).sort((a, b) => Number(b.id) - Number(a.id))[0]
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
export function scoringPromptNote(
  rows: RepeatRow[], minMargin: number, maxMargin: number = DEFAULT_MAX_MARGIN_BPB,
  /** saveStep: the epoch's own run has the runner's save step (LAB_ENABLE_RESEARCH_TALK), and the repeat does not. */
  opts: { saveStep?: boolean } = {},
): string {
  const noise = noiseFromRepeats(rows)
  const margin = marginFor(noise, minMargin, maxMargin)
  const runner = opts.saveStep
    ? 'through the same runner, without the step that saves the trained model (the epoch\'s own run has that step while the lab keeps models for stories; the repeat is started without it)'
    : 'through the same runner and harness'
  return `

HOW THE LAB SCORES A NEW BEST (a fact about the lab, not a goal; val_bpb is still the only thing a run is judged on): when the Reviewer keeps a run whose val_bpb is below the current best, the lab runs the same train.py once more, unchanged, ${runner}. The run becomes the new best only if the mean of the two scores beats the current best by more than the margin, and the new best is then recorded as that mean. Otherwise the result is recorded as within noise, or as not confirmed when the repeat gives no score, and train.py stays as it was. The margin now is ${f4(margin.margin_bpb)} val_bpb (${describeMargin(noise, margin)}); it is the larger of a fixed floor and twice the run-to-run noise the lab measures by running the same file more than once, which it also does now and then with the current best train.py, and it is never more than a fixed ceiling of ${f4(Math.max(minMargin, maxMargin))}. In results.tsv the columns repeat_val_bpb, mean_val_bpb, noise_bpb, margin_bpb and confirm hold this for a run that was repeated. Its limits: a repeat tells a lucky run from one that repeats, and nothing more. Both scores are printed by train.py itself, so the repeat does not make a score independently evaluated. The confirmation margin applies only to the two-run mean after the lab runs its repeat, not to a single draw: the repeat only runs when the Reviewer votes "keep", so reverting a clean run whose val_bpb beats the current best by less than the margin prevents the lab from ever running the confirmation repeat.`
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
 * until the runner answers or the age limit passes. A row still starting
 * (no call id was ever written) is lost once REPEAT_START_LOST_AFTER_MS has
 * passed, and until then belongs to the request that is starting it.
 */
async function settleRepeat(row: RepeatRow, now: number = Date.now()): Promise<ResearchRunResult | 'lost' | null> {
  const age = now - Date.parse(row.created_at || '')
  if (row.status === 'starting') return !Number.isFinite(age) || age > REPEAT_START_LOST_AFTER_MS ? 'lost' : null
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
      if (!repeatOpen(row.status)) continue
      if (row.kind !== 'control' && !(row.epoch_number < epoch)) continue
      const outcome = await settleRepeat(row, now.getTime())
      if (!outcome) continue
      const closed = await closeRepeat(row, outcome, budgetS)
      changed = true
      console.log(`[Research] ${row.kind === 'control' ? `control after epoch ${row.epoch_number}` : `repeat left open by epoch ${row.epoch_number}`} collected: ${closed.status} val_bpb=${closed.val_bpb ?? 'n/a'}${row.status === 'starting' ? ' (its start was never recorded)' : ''}`)
    }
    return changed ? await loadRepeats(experimentId) : rows
  } catch (e) {
    console.warn('[Research] could not collect the lab\'s repeat runs (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * Waits for a repeat until `waitUntil` (a Date.now() time), asking the
 * runner at least once however little time is left. null: still training
 * at the deadline.
 */
async function awaitRepeat(row: RepeatRow, waitUntil: number, pollMs = 15_000): Promise<ResearchRunResult | 'lost' | null> {
  for (;;) {
    const outcome = await settleRepeat(row)
    if (outcome) return outcome
    const left = waitUntil - Date.now()
    if (left <= 0) return null
    await new Promise(r => setTimeout(r, Math.min(pollMs, left)))
  }
}

/**
 * The day's cap for one more GPU run of the lab's own (a repeat, a control,
 * or an epoch's own run while one of them is open), with the runs it has
 * started and not yet collected counted in: their GPU time reaches the
 * ledger only when they are collected. Beside run 2, where research has a
 * cap of its own and GPU time is counted, each open repeat is counted at the
 * full estimate of a run, the most it can be charged. Otherwise GPU time is
 * not on the ledger at all and this is checkDailyBudget. Not allowed when
 * the cap is reached or the ledger cannot be read.
 */
export async function checkResearchGpuBudget(rows: RepeatRow[], budgetS: number, now: Date = new Date()): Promise<BudgetStatus> {
  const budget = await checkDailyBudget(now, 'research')
  if (!budget.allowed || budget.spent_usd === null || !researchAlongside()) return budget
  const open = rows.filter(r => repeatOpen(r.status)).length
  if (open === 0) return budget
  const reserved = open * researchGpuCostUsd(undefined, budgetS)
  if (budget.spent_usd + reserved < budget.budget_usd) return { ...budget, reserved_usd: reserved }
  return { ...budget, allowed: false, reserved_usd: reserved, reason: RESEARCH_BUDGET_REACHED }
}

/**
 * The lab's repeat was not started in this request, or an earlier request's
 * start of it is not recorded yet. Nothing failed: the next tick goes on
 * from here. A kind of ResearchRunPendingError, so the tick and the manual
 * route answer it as they answer a GPU run that is still training.
 */
export class RepeatDeferredError extends ResearchRunPendingError {
  constructor(reason: string) {
    super('none')
    this.message = reason
    this.name = 'RepeatDeferredError'
  }
}

const RUNNER_FLOW = /^[a-z0-9-]{1,20}$/

/**
 * The lab's repeat of a run that would become the best: starts it if this
 * epoch has none yet, waits for it while the request has time, and returns
 * the verdict. The noise that sets the margin is the noise as it was before
 * this pair: the run being judged does not help set its own bar. Throws
 * ResearchRunPendingError when the repeat is still training or the runner
 * could not be asked about it (the next tick picks the same call up again),
 * RepeatDeferredError when it is too late in the request to start one, or an
 * earlier request's start is not recorded yet, BudgetPausedError when the
 * day's cap is reached before the repeat is started (the epoch waits as it
 * is, with the Reviewer's verdict stored, and is picked up when the cap
 * resets), and any error from starting the run, like the epoch's own run
 * does.
 */
export async function confirmNewBest(args: {
  experimentId: string
  epoch: number
  trainPy: string
  first: number
  best: number
  budgetS: number
  /**
   * How long this request may still wait for the repeat, in ms, counted from
   * this call: the budget check and the start come out of it.
   */
  maxWaitMs: number
  /** When the request began (a Date.now() time). Past REPEAT_START_DEADLINE_MS into it no repeat is started. */
  requestStartedAt?: number
  /** runner_flow of the epoch's own run, when it had one (keep-1): the line says the repeat did not. */
  firstRunnerFlow?: string
}): Promise<ConfirmDecision> {
  const waitUntil = Date.now() + (finite(args.maxWaitMs) ? Math.max(0, args.maxWaitMs) : 0)
  const mine = (rows: RepeatRow[]) => rows.find(r => r.kind === 'confirm' && r.epoch_number === args.epoch)
  const before = await loadRepeats(args.experimentId)
  let row = mine(before)
  if (!row) {
    // Starting a run late in a request risks the function being stopped
    // before the call is recorded. The row is written first, so even then
    // the run is not lost from the record, but it could not be collected or
    // judged: the next tick, early in its request, starts it instead.
    const elapsed = finite(args.requestStartedAt) ? Date.now() - args.requestStartedAt : 0
    if (elapsed > REPEAT_START_DEADLINE_MS) {
      throw new RepeatDeferredError(`lab repeat not started: ${Math.round(elapsed / 1000)} s into the request, too late to start one safely; the next tick starts it`)
    }
    // A repeat is one more GPU run. The cap was checked when the tick began,
    // before the epoch's own run, which may have used up what was left: it
    // is checked again here (research's own cap beside run 2, the one cap
    // otherwise), with the lab's repeats that are still open counted in, and
    // nothing is started once it is reached or cannot be read. The candidate
    // is not thrown away for that: the epoch stops here and repeats the run
    // when the cap allows.
    const budget = await checkResearchGpuBudget(before, args.budgetS)
    if (!budget.allowed) throw new BudgetPausedError(budget)
    row = await startRepeat({
      experimentId: args.experimentId, epoch: args.epoch, kind: 'confirm', trainPy: args.trainPy,
      referenceBpb: args.first, referenceEpoch: args.epoch, budgetS: args.budgetS,
    }) ?? mine(await loadRepeats(args.experimentId))
    if (!row) throw new Error('the lab could not store its repeat run')
    console.log(`[Research e${args.epoch}] lab repeat started: ${row.call_id}`)
  }
  if (row.status === 'starting') {
    // An earlier request wrote the row and stopped before the call id was
    // written. Once that request is certainly over, the repeat is lost:
    // charged at the full estimate, not confirmed, and never started again.
    const outcome = await settleRepeat(row)
    if (!outcome) throw new RepeatDeferredError('lab repeat: an earlier request\'s start of it is not recorded yet; the next tick looks again')
    row = await closeRepeat(row, outcome, args.budgetS)
    console.log(`[Research e${args.epoch}] lab repeat closed as ${row.status}: its start was never recorded`)
  }
  if (row.status === 'running') {
    const outcome = await awaitRepeat(row, waitUntil)
    if (outcome === null) throw new ResearchRunPendingError(row.call_id as string)
    row = await closeRepeat(row, outcome, args.budgetS)
    console.log(`[Research e${args.epoch}] lab repeat finished: ${row.status} val_bpb=${row.val_bpb ?? 'n/a'}`)
  }
  // The noise as it was before this pair. The pair stays in the table and
  // counts for later epochs.
  const ownId = row.id
  const others = (await loadRepeats(args.experimentId).catch(() => before)).filter(r => r.id !== ownId)
  const firstFlow = typeof args.firstRunnerFlow === 'string' && RUNNER_FLOW.test(args.firstRunnerFlow) ? args.firstRunnerFlow : undefined
  const repeatFlow = row.result?.runner_flow
  return decideConfirmation({
    // The first score as it was stored when the repeat was started.
    first: finite(row.reference_bpb) ? row.reference_bpb : args.first,
    repeat: row.val_bpb, repeatStatus: row.status, best: args.best, noise: noiseFromRepeats(others),
    minMargin: researchMinMargin(), maxMargin: researchMaxMargin(), ownPairLeftOut: true,
    ...(firstFlow && repeatFlow !== firstFlow
      ? { note: `the first run had the runner's save step (runner_flow ${firstFlow}) and the lab's repeat did not` } : {}),
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
  /** How far into its request the caller is, in ms. Past REPEAT_START_DEADLINE_MS nothing is started. */
  requestElapsedMs?: number
}): Promise<number | null> {
  try {
    if (finite(args.requestElapsedMs) && args.requestElapsedMs > REPEAT_START_DEADLINE_MS) {
      console.log(`[Research e${args.epoch}] no control run: ${Math.round(args.requestElapsedMs / 1000)} s into the request, too late to start one safely; tried again after the next epoch`)
      return null
    }
    const rows = await loadRepeats(args.experimentId)
    const controls = rows.filter(r => r.kind === 'control')
    const last = controls.length ? Math.max(...controls.map(r => r.epoch_number)) : null
    if (!controlDue({
      epoch: args.epoch, every: researchControlEvery(), lastControlEpoch: last, controls: controls.length,
      open: controls.some(r => repeatOpen(r.status)),
    })) return null
    // A control is extra spend the epoch did not have to make: none once the
    // day's cap is reached (research's own cap beside run 2, the one cap
    // otherwise), with the lab's open repeats counted in, or when the cap
    // cannot be checked.
    const budget = await checkResearchGpuBudget(rows, args.budgetS)
    if (!budget.allowed) {
      console.log(`[Research e${args.epoch}] no control run: ${budget.reason ?? 'daily budget reached'}`)
      return null
    }
    const row = await startRepeat({
      experimentId: args.experimentId, epoch: args.epoch, kind: 'control', trainPy: args.trainPy,
      referenceBpb: args.bestBpb, referenceEpoch: args.bestEpoch, budgetS: args.budgetS,
    })
    if (!row) return null
    console.log(`[Research e${args.epoch}] control run of the best train.py started: ${row.call_id}`)
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
    const pending = (await loadRepeats(experimentId)).filter(r => !repeatOpen(r.status) && !r.ledger_written)
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
