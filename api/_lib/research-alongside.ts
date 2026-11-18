/**
 * Research beside run 2 (LAB_RESEARCH_ALONGSIDE): bringing the research
 * experiment back, and its public state.
 *
 * The research record lives in two places that must agree: the experiment
 * row (its epochs, its spec with the best score so far) and the Research-Lab
 * repository (results.tsv, one wiki page per epoch). So when no research
 * experiment is active, the tick continues the one that wrote that record
 * instead of starting another:
 *
 * 1. Reactivate the newest archived research experiment. Everything it owns
 *    is keyed by its id and its next epoch is current_epoch + 1, so setting
 *    its status back is nearly all it takes: the spec, the best score, the
 *    notebook and the epoch numbers carry on where they stopped. Two things
 *    are brought up to date first, because an epoch that was running when
 *    the experiment was archived finishes into the archived row: a finished
 *    epoch the experiment row never advanced to is taken over (its spec and
 *    its number), and a score the ledger kept after that becomes the best.
 * 2. Only when the database holds no research experiment at all, seed a new
 *    one whose numbering starts after the last epoch in results.tsv, with
 *    the best kept score from that ledger.
 *
 * Either way the next epoch number is never at or below the last epoch in
 * results.tsv, so ledger rows and wiki pages cannot collide or restart. If
 * the ledger cannot be read, nothing is activated and the next tick tries
 * again. The classic experiment is never read or written here.
 *
 * How far the ledger is trusted. results.tsv is written by the lab, but the
 * numbers in it start as output of model-written code. Only lines shaped
 * exactly like the lab's own rows count, the ledger may move an existing
 * experiment's epoch number forward by LEDGER_AHEAD_MAX at most (more than
 * that and nothing is activated until someone has looked), and a kept score
 * below the spec's target is not taken as the best.
 */
import { sql } from '@vercel/postgres'
import { getResearchFile } from './research.js'
import { getRoleAssignments } from './role-rotation.js'
import { generateSeedPlant } from './plant-generator.js'
import { RESEARCH_SEED_SPECIFICATION } from './seed-spec.js'
import { researchAlongside, activeExperimentId } from './experiment-modes.js'
import { envEpochStaleMinutes } from './epoch-claim.js'
import { checkDailyBudget, describeRunState, type BudgetStatus } from './spend.js'
import type { AgentSpecification, ResearchAlongside, ResearchMeta } from './types.js'

// ---------------------------------------------------------------------------
// The ledger in the research repository
// ---------------------------------------------------------------------------

export interface LedgerSummary {
  last_epoch: number                                  // 0 when the ledger has no rows
  best_kept: { epoch: number; val_bpb: number } | null // lowest score among rows marked keep
}

interface LedgerRow { epoch: number; val_bpb: number | null; status: 'keep' | 'discard' | 'crash' }

/**
 * One line of results.tsv as the lab writes it (appendResultsRow), or null.
 * A row has 9 columns (before the provenance columns were added) or 13, an
 * epoch number, merged or reverted, a score with four decimals or "-", and
 * keep, discard or crash; a kept row was merged and has a score. The header,
 * blank lines and anything else are not rows.
 */
function parseLedgerRow(line: string): LedgerRow | null {
  const cols = line.replace(/\r$/, '').split('\t')
  if (cols.length !== 9 && cols.length !== 13) return null
  if (!/^\d{1,6}$/.test(cols[0])) return null
  if (cols[1] !== 'merged' && cols[1] !== 'reverted') return null
  const status = cols[7]
  if (status !== 'keep' && status !== 'discard' && status !== 'crash') return null
  const scored = /^\d{1,3}\.\d{4}$/.test(cols[2])
  if (!scored && cols[2] !== '-') return null
  if (status === 'keep' && (!scored || cols[1] !== 'merged')) return null
  return { epoch: Number(cols[0]), val_bpb: scored ? Number(cols[2]) : null, status }
}

/**
 * Reads results.tsv: the highest epoch number, and the best score that was
 * kept. `keptAfter` counts kept scores only from epochs above that number,
 * and `minBpb` leaves out kept scores below it.
 */
export function summarizeLedger(tsv: string, opts: { keptAfter?: number; minBpb?: number } = {}): LedgerSummary {
  const keptAfter = opts.keptAfter ?? 0
  const minBpb = typeof opts.minBpb === 'number' && Number.isFinite(opts.minBpb) && opts.minBpb > 0 ? opts.minBpb : 0
  let last = 0
  let best: LedgerSummary['best_kept'] = null
  for (const line of tsv.split('\n')) {
    const row = parseLedgerRow(line)
    if (!row) continue
    if (row.epoch > last) last = row.epoch
    if (row.status === 'keep' && row.val_bpb !== null && row.val_bpb > 0 && row.val_bpb >= minBpb
      && row.epoch > keptAfter && (!best || row.val_bpb < best.val_bpb)) {
      best = { epoch: row.epoch, val_bpb: row.val_bpb }
    }
  }
  return { last_epoch: last, best_kept: best }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export type ResearchActivation =
  | { activated: false; reason: string; experiment_id?: string }
  | { activated: true; how: 'reactivated' | 'seeded'; experiment_id: string; next_epoch: number; ledger_last_epoch: number }

// How far results.tsv may be ahead of the archived experiment. In normal work
// it is one epoch at most (the epoch that was running when the experiment was
// archived wrote its row); two leaves a little room. Past that the ledger and
// the database disagree in a way the lab did not cause, and guessing would
// renumber every later epoch, row and page for good.
export const LEDGER_AHEAD_MAX = 2

const researchOf = (spec: unknown): ResearchMeta | null => {
  const r = (spec as AgentSpecification | null | undefined)?.meta?.research
  return r && typeof r === 'object' ? r : null
}

// A GPU run that was still going when the experiment was archived can be
// picked up again while Modal keeps its result (about a week). Older than
// this, the call is forgotten so the epoch starts a fresh run instead of
// recording an expired call as a crash.
const STALE_RUN_MS = 6 * 24 * 60 * 60 * 1000

/**
 * Makes sure one research experiment is active. Called by the tick only
 * while LAB_RESEARCH_ALONGSIDE is on and it found none. Never throws.
 */
export async function ensureResearchExperiment(): Promise<ResearchActivation> {
  if (!researchAlongside()) return { activated: false, reason: 'LAB_RESEARCH_ALONGSIDE is off' }
  try {
    const active = await activeExperimentId('research')
    if (active) return { activated: false, reason: 'a research experiment is already active', experiment_id: active }

    // The ledger first: without it the next epoch number cannot be trusted.
    let ledgerText: string
    try {
      const file = await getResearchFile('results.tsv')
      ledgerText = file?.content ?? ''
    } catch (e) {
      const why = e instanceof Error ? e.message.slice(0, 160) : 'unknown error'
      console.warn(`[Research] not starting research: results.tsv could not be read (${why})`)
      return { activated: false, reason: 'the research ledger could not be read; trying again next tick' }
    }
    const ledger = summarizeLedger(ledgerText)

    const archived = (await sql`
      SELECT id, current_epoch, current_spec FROM experiments
      WHERE status = 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object'
      ORDER BY created_at DESC LIMIT 1
    `).rows[0]

    if (archived) {
      // A reset a few minutes ago can leave an epoch still running on the
      // archived row (it finishes there). Wait for it, so the same epoch is
      // never run twice at once. A request says it is working on an epoch
      // when it makes the row (started_at) and each time it picks an
      // unfinished one up again (resumed_at, research-epoch.ts).
      await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMP WITH TIME ZONE`
      const recent = new Date(Date.now() - envEpochStaleMinutes() * 60_000).toISOString()
      const running = (await sql`
        SELECT epoch_number FROM epochs
        WHERE experiment_id = ${archived.id} AND completed_at IS NULL AND (started_at > ${recent} OR resumed_at > ${recent})
        ORDER BY epoch_number DESC LIMIT 1
      `).rows[0]
      if (running) {
        return { activated: false, reason: `epoch ${running.epoch_number} may still be running on the archived research experiment; trying again next tick`, experiment_id: archived.id as string }
      }

      // An epoch that finished into the archived row: its last write, the one
      // that advances the experiment, skips an archived experiment. Take it
      // over now (its spec holds its best score, last run and finding), as
      // the research runner does for a finished epoch it finds ahead of the row.
      const stoppedAt = Number(archived.current_epoch) || 0
      let epoch = stoppedAt
      let spec: AgentSpecification | null = null
      const finished = (await sql`
        SELECT epoch_number, spec_after FROM epochs
        WHERE experiment_id = ${archived.id} AND epoch_number > ${stoppedAt}
          AND completed_at IS NOT NULL AND spec_after IS NOT NULL AND commentator_output IS NOT NULL
        ORDER BY epoch_number DESC LIMIT 1
      `).rows[0]
      if (finished && researchOf(finished.spec_after)) {
        epoch = Number(finished.epoch_number)
        spec = finished.spec_after as AgentSpecification
      }

      // The ledger may be a little ahead of that (a row was written but the
      // epoch never finished). Far ahead, it is not this experiment's ledger
      // as the lab left it: start nothing.
      if (ledger.last_epoch > epoch + LEDGER_AHEAD_MAX) {
        console.warn(`[Research] not starting research: results.tsv is at epoch ${ledger.last_epoch}, more than ${LEDGER_AHEAD_MAX} past the experiment's ${epoch}`)
        return {
          activated: false, experiment_id: archived.id as string,
          reason: `results.tsv is at epoch ${ledger.last_epoch}, more than ${LEDGER_AHEAD_MAX} past the research experiment's epoch ${epoch}; not starting until the ledger or the experiment is corrected`,
        }
      }

      // A score the ledger kept after the last epoch the spec knows: train.py
      // in the repository is that epoch's (it is written before the row), so
      // that score is the one to beat. Without this a worse run could be kept.
      const current = researchOf(spec ?? archived.current_spec)
      const kept = summarizeLedger(ledgerText, { keptAfter: epoch, minBpb: current?.target_bpb }).best_kept
      if (current && kept && kept.val_bpb < current.best_bpb) {
        spec = JSON.parse(JSON.stringify(spec ?? archived.current_spec)) as AgentSpecification
        const research = spec.meta.research as ResearchMeta
        research.best_bpb = kept.val_bpb
        research.best_epoch = kept.epoch
        console.warn(`[Research] results.tsv kept ${kept.val_bpb.toFixed(4)} at epoch ${kept.epoch}, after the experiment's last finished epoch; that is now its best score`)
      }

      // One statement: back to active, never below the ledger's last epoch,
      // and only while no other research experiment became active meanwhile.
      const back = (await sql`
        UPDATE experiments
        SET status = 'growing', epoch_in_progress = FALSE, epoch_started_at = NULL,
          current_epoch = GREATEST(current_epoch, ${epoch}::int, ${ledger.last_epoch}::int),
          current_spec = COALESCE(${spec ? JSON.stringify(spec) : null}::jsonb, current_spec)
        WHERE id = ${archived.id} AND status = 'archived'
          AND NOT EXISTS (
            SELECT 1 FROM experiments x
            WHERE x.status <> 'archived' AND jsonb_typeof(x.current_spec->'meta'->'research') = 'object'
          )
        RETURNING id, current_epoch
      `).rows[0]
      if (!back) return { activated: false, reason: 'another request activated research first' }
      const resumedAt = Number(back.current_epoch)
      if (epoch > stoppedAt) {
        console.warn(`[Research] epoch ${epoch} had finished on the archived experiment (it stopped at ${stoppedAt}); took its result over`)
      }
      if (resumedAt > epoch) {
        console.warn(`[Research] results.tsv is at epoch ${ledger.last_epoch}, past the experiment's ${epoch}; continuing after the ledger`)
      }
      try {
        const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString()
        await sql`
          UPDATE epochs SET research_run = NULL
          WHERE experiment_id = ${archived.id} AND completed_at IS NULL AND started_at < ${cutoff}
            AND research_run IS NOT NULL AND research_run->'result' IS NULL
        `
      } catch { /* no research_run column yet: nothing to forget */ }
      console.log(`[Research] reactivated experiment ${back.id}; next epoch ${resumedAt + 1}`)
      return { activated: true, how: 'reactivated', experiment_id: back.id as string, next_epoch: resumedAt + 1, ledger_last_epoch: ledger.last_epoch }
    }

    // No research experiment in the database: seed one that carries on
    // after the ledger, holding the best score the ledger kept. There is no
    // experiment row to hold the ledger against here, so only rows in the
    // lab's own shape count and a kept score below the target is left out
    // (patch-research sets the baseline by hand if that is wrong).
    const spec: AgentSpecification = JSON.parse(JSON.stringify(RESEARCH_SEED_SPECIFICATION))
    const research = spec.meta.research as ResearchMeta
    spec.meta.total_epochs = ledger.last_epoch
    const kept = summarizeLedger(ledgerText, { minBpb: research.target_bpb }).best_kept
    if (kept && kept.val_bpb < research.best_bpb) {
      research.best_bpb = kept.val_bpb
      research.best_epoch = kept.epoch
    }
    const seeded = (await sql`
      INSERT INTO experiments (status, current_spec, current_epoch, epoch_in_progress, glass_shattered)
      SELECT 'seeding', ${JSON.stringify(spec)}::jsonb, ${ledger.last_epoch}::int, FALSE, FALSE
      WHERE NOT EXISTS (
        SELECT 1 FROM experiments x
        WHERE x.status <> 'archived' AND jsonb_typeof(x.current_spec->'meta'->'research') = 'object'
      )
      RETURNING id
    `).rows[0]
    if (!seeded) return { activated: false, reason: 'another request activated research first' }
    // The seed row every experiment has (epoch 0), so the cadence has a start.
    await sql`
      INSERT INTO epochs (
        experiment_id, epoch_number, role_assignments,
        spec_before, spec_after, plant_geometry, completed_at
      )
      VALUES (
        ${seeded.id}, 0, ${JSON.stringify(getRoleAssignments(0))},
        ${JSON.stringify(spec)}, ${JSON.stringify(spec)},
        ${JSON.stringify(generateSeedPlant())}, NOW()
      )
    `
    console.log(`[Research] seeded research experiment ${seeded.id}; next epoch ${ledger.last_epoch + 1}`)
    return { activated: true, how: 'seeded', experiment_id: seeded.id as string, next_epoch: ledger.last_epoch + 1, ledger_last_epoch: ledger.last_epoch }
  } catch (e) {
    console.error('[Research] could not activate the research experiment:', e instanceof Error ? e.message : e)
    return { activated: false, reason: 'activation failed; trying again next tick' }
  }
}

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

export const RESEARCH_OFF_STATE = 'paused: research alongside is off'

/**
 * The research experiment's run state in plain words. When it shares the
 * lab with a classic experiment and the flag is off, nothing advances it,
 * and the state says so.
 */
export function describeResearchRunState(
  exp: { status: string; epoch_in_progress?: boolean | null },
  budget: BudgetStatus | null,
  idle: boolean,
): { run_state: string; resumes_at?: string } {
  if (idle && !exp.epoch_in_progress) return { run_state: RESEARCH_OFF_STATE }
  return describeRunState(exp, budget)
}

// Viewers poll the state; the research cap is read at most once a minute per instance.
let budgetCache: { at: number; status: BudgetStatus } | null = null
async function cachedResearchBudget(): Promise<BudgetStatus | null> {
  if (budgetCache && Date.now() - budgetCache.at < 60_000) return budgetCache.status
  try {
    const status = await checkDailyBudget(new Date(), 'research')
    budgetCache = { at: Date.now(), status }
    return status
  } catch {
    return null
  }
}

/**
 * Run state for the active research experiment. `idle` is true when the
 * flag is off and a classic experiment is active too (the tick then runs
 * only the classic one).
 */
export async function researchRunState(exp: { status: string; epoch_in_progress?: boolean | null }): Promise<{ run_state: string; resumes_at?: string }> {
  const idle = !researchAlongside() && (await activeExperimentId('classic').catch(() => null)) !== null
  return describeResearchRunState(exp, idle ? null : await cachedResearchBudget(), idle)
}

/** The few facts about research the room's state carries while it runs alongside. No dollar amounts. */
export type ResearchSummary = ResearchAlongside

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

let summaryCache: { at: number; summary: ResearchSummary | null } | null = null
const SUMMARY_CACHE_MS = 30_000

/** The active research experiment in brief, or null. Never throws; kept for 30 s per instance. */
export async function researchSummary(): Promise<ResearchSummary | null> {
  if (summaryCache && Date.now() - summaryCache.at < SUMMARY_CACHE_MS) return summaryCache.summary
  let summary: ResearchSummary | null = null
  try {
    const exp = (await sql`
      SELECT id, status, current_epoch, epoch_in_progress, current_spec->'meta'->'research' AS research
      FROM experiments
      WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object'
      ORDER BY created_at DESC LIMIT 1
    `).rows[0]
    if (exp) {
      const meta = (exp.research ?? {}) as Partial<ResearchMeta>
      let gpuRunning = false
      if (exp.epoch_in_progress) {
        const open = (await sql`
          SELECT * FROM epochs WHERE experiment_id = ${exp.id} AND completed_at IS NULL
          ORDER BY epoch_number DESC LIMIT 1
        `).rows[0]
        const run = open?.research_run as { call_id?: string; result?: unknown } | null | undefined
        gpuRunning = Boolean(run?.call_id && !run.result)
      }
      summary = {
        id: exp.id as string,
        status: exp.status as string,
        current_epoch: Number(exp.current_epoch) || 0,
        epoch_in_progress: exp.epoch_in_progress === true,
        gpu_running: gpuRunning,
        ...(await researchRunState(exp as { status: string; epoch_in_progress?: boolean | null })),
        baseline_bpb: finite(meta.baseline_bpb),
        best_bpb: finite(meta.best_bpb),
        best_epoch: finite(meta.best_epoch),
        target_bpb: finite(meta.target_bpb),
        last_run: meta.last_run ?? null,
      }
    }
  } catch (e) {
    console.warn('[Research] could not read the research state (non-fatal):', e instanceof Error ? e.message : e)
    return null // not cached: the next request tries again
  }
  summaryCache = { at: Date.now(), summary }
  return summary
}

/** For tests: forget the cached budget and summary. */
export function resetResearchStateCache(): void {
  budgetCache = null
  summaryCache = null
}
