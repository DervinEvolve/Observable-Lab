/**
 * Runs one Tinker training request the Reviewer approved (tinker.ts), and
 * collects runs that were still training when their request ended.
 *
 * The order for a run: estimate the most it could cost; refuse it above the
 * per-run cap; set that estimate aside under the daily Tinker cap in the
 * database (tinker-store.ts); open the epoch's one run row; start the lab's
 * runner on Modal; wait a while. When the result is in, the money set aside
 * is replaced by the tokens the runner counted at the published prices, the
 * run is stored as evidence (tinker_runs and tool_runs) and its estimated
 * cost goes on the spend ledger, so LAB_DAILY_BUDGET_USD counts it.
 *
 * A run whose usage is unknown (the runner was lost, or its answer was
 * unusable) is charged the whole amount set aside, so the record errs high.
 * Nothing here throws into the epoch.
 */
import { budgetScopeFor } from './experiment-modes.js'
import { recordModelCall, withSpendContext } from './spend.js'
import { recordToolRun, type ToolRunStatus } from './tool-runs-store.js'
import { modelDisplayName } from './types.js'
import {
  TINKER_PRICE_TABLE_DATE, TINKER_RUN_TIMEOUT_S, TINKER_TOOL, describeTinkerRun, estimateTinkerRun, newAdapterSlug, newSplitSalt,
  normalizeTinkerResult, tinkerCostUsd, tinkerDailyUsd, tinkerFlag, tinkerJobsConfigured, tinkerRunUsd, tinkerTtlDays, tinkerWaitMs, usdText,
  type TinkerRequest, type TinkerRunResult,
} from './tinker.js'
import { pollTinkerJob, startTinkerJob, tinkerJobBody, waitForTinkerJob, type TinkerPoll } from './tinker-client.js'
import {
  finishTinkerRun, markTinkerRunStarted, openTinkerRun, openTinkerRuns, reserveTinkerSpend, settleTinkerSpend,
  type TinkerRunRow,
} from './tinker-store.js'

export interface TinkerRunContext {
  experimentId: string
  epochNumber: number
  executorModelId: string
  assignedExecutorId: string
}

export interface TinkerOutcome {
  tool: typeof TINKER_TOOL
  status: ToolRunStatus | 'started'
  summary: string
}

const name = (id: string) => modelDisplayName(id) || id.split('/').pop() || id

/** What was asked, in one line, for the stored record. */
export function tinkerRequestSummary(baseModel: string, examples: number, purpose: string | null): string {
  return `LoRA fine-tune of ${baseModel} on ${examples} examples${purpose ? `: ${purpose}` : ''}`
}

/** The most this request could cost, for the checks made before it is run. */
export function tinkerWorstCaseUsd(request: TinkerRequest): number {
  return estimateTinkerRun(request).max_cost_usd
}

/** A lost runner whose result never came: nothing measured. */
function lostResult(reason: string): TinkerRunResult {
  return { ...normalizeTinkerResult(null), status: 'failed', reason }
}

/**
 * Closes a run with what the runner answered: settles the money, stores the
 * evidence and returns the line for the epoch. null when another request
 * closed the same run first (it did all of this already).
 */
async function completeRun(row: TinkerRunRow, poll: Extract<TinkerPoll, { state: 'done' | 'failed' }>): Promise<TinkerOutcome | null> {
  const result = poll.state === 'done' ? normalizeTinkerResult(poll.result) : lostResult(`the runner was lost: ${poll.error}`)
  // Usage is known when the runner answered in its own words (ok, refused, error).
  const usageKnown = poll.state === 'done' && result.status !== 'failed'
  const costUsd = usageKnown ? tinkerCostUsd(row.base_model, result.tokens) : row.reserved_usd
  // An hour is taken off, so the lab stops offering an adapter before Tinker removes it.
  const ttlSeconds = result.ttl_seconds ?? tinkerTtlDays() * 24 * 60 * 60
  const expiresAt = result.status === 'ok' ? new Date(Date.now() + Math.max(0, ttlSeconds - 3600) * 1000).toISOString() : null

  const closed = await finishTinkerRun(row.id, { status: result.status, reason: result.reason, costUsd, result, expiresAt })
  if (!closed) return null
  await settleTinkerSpend({ day: row.spend_day, scope: 'all', usd: row.reserved_usd }, costUsd)

  const budgetScope = await budgetScopeFor(row.experiment_id).catch(() => 'classic' as const)
  if (costUsd > 0) {
    await withSpendContext({ experimentId: row.experiment_id, epochNumber: row.epoch, purpose: TINKER_TOOL, budgetScope }, () =>
      recordModelCall({
        model: `tool/${TINKER_TOOL}`, assigned: row.assigned_model ?? row.model, cost_usd: costUsd, cost_source: 'estimate',
        prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      }))
  }

  const status: ToolRunStatus = result.status === 'ok' ? 'ok' : result.status === 'refused' ? 'failed' : 'error'
  const line = describeTinkerRun(result, row.base_model, result.status === 'ok' ? row.slug : null, costUsd, expiresAt)
  await recordToolRun({
    experimentId: row.experiment_id, epoch: row.epoch, model: row.model, tool: TINKER_TOOL,
    requestSummary: tinkerRequestSummary(row.base_model, row.dataset_examples, row.purpose),
    status, durationMs: result.wall_seconds === null ? null : result.wall_seconds * 1000, costUsd, outputTail: line,
    detail: {
      ...(result.status === 'ok' ? { adapter: `lab/${row.slug}`, sampler_path: result.sampler_path, expires_at: expiresAt } : {}),
      base_model: row.base_model,
      dataset: { sha256: row.dataset_sha256, examples: row.dataset_examples, bytes: row.dataset_bytes },
      settings: row.settings,
      measured: {
        by: 'the lab, on examples it held out and the model could not choose',
        holdout_examples: result.n_holdout, train_examples: result.n_train,
        holdout_loss_before: result.holdout_loss_before, holdout_loss_after: result.holdout_loss_after,
      },
      training: {
        steps_planned: result.steps_planned, steps_done: result.steps_done, stopped_early: result.stopped_early,
        train_loss_first: result.train_loss_first, train_loss_last: result.train_loss_last,
      },
      cost: {
        estimated_usd: Math.round(costUsd * 1e6) / 1e6, set_aside_usd: row.reserved_usd, tokens: result.tokens,
        basis: usageKnown
          ? `token counts at Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}; an estimate, not a billed amount`
          : 'usage unknown, so the whole amount set aside is counted; an estimate, not a billed amount',
      },
      samples: result.samples,
      split_salt: row.split_salt,
      ...(result.reason ? { reason: result.reason } : {}),
    },
  })
  return { tool: TINKER_TOOL, status, summary: `${name(row.model)}'s Tinker training: ${line}` }
}

/**
 * Runs an approved request. The caller has already checked the Reviewer's
 * verdict, the runs-per-day limit and the lab's daily budget; the Tinker
 * caps are checked here. A refusal is returned as `skipped` with its reason
 * for the caller to store.
 */
export async function runTinkerTrain(ctx: TinkerRunContext, request: TinkerRequest, opts: { maxWaitMs?: number; pollMs?: number } = {}): Promise<TinkerOutcome> {
  const skipped = (reason: string): TinkerOutcome => ({ tool: TINKER_TOOL, status: 'skipped', summary: reason })
  const estimate = estimateTinkerRun(request)
  const runCap = tinkerRunUsd()
  if (estimate.max_cost_usd > runCap) {
    return skipped(`the most it could cost (${usdText(estimate.max_cost_usd)}, estimated from published prices) is over the ${usdText(runCap)} a run may cost`)
  }

  let reservation: Awaited<ReturnType<typeof reserveTinkerSpend>>
  try {
    reservation = await reserveTinkerSpend('all', estimate.max_cost_usd, tinkerDailyUsd())
  } catch (e) {
    console.warn('[tinker] could not set the estimate aside:', e instanceof Error ? e.message : e)
    return skipped('the lab could not check today\'s Tinker spend, so nothing was started')
  }
  if (!reservation.ok) return skipped(`its estimated cost of ${usdText(estimate.max_cost_usd)} was not set aside: ${reservation.reason}`)

  const splitSalt = newSplitSalt()
  let row: TinkerRunRow | null
  try {
    row = await openTinkerRun({
      experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, assignedModel: ctx.assignedExecutorId,
      slug: newAdapterSlug(ctx.epochNumber), request, splitSalt, spendDay: reservation.day, reservedUsd: reservation.usd,
    })
  } catch (e) {
    await settleTinkerSpend(reservation, 0)
    console.warn('[tinker] could not open a run:', e instanceof Error ? e.message : e)
    return skipped('the lab could not store the run, so nothing was started')
  }
  if (!row) {
    await settleTinkerSpend(reservation, 0)
    return skipped('this epoch already has a training run')
  }

  const started = await startTinkerJob(tinkerJobBody(request, {
    splitSalt, budgetUsd: reservation.usd, label: `epoch ${ctx.epochNumber} ${row.slug}`,
  }))
  if (!started.ok && started.unconfirmed) {
    // The request left and no usable answer came back: the run may be
    // training. Its row stays open with the money set aside, and a later tick
    // closes it as a run whose usage is unknown (collectTinkerRuns).
    return {
      tool: TINKER_TOOL, status: 'error',
      summary: `${name(ctx.executorModelId)}'s Tinker training: ${started.error}; the ${usdText(reservation.usd)} set aside stays counted until the lab closes the run`,
    }
  }
  if (!started.ok) {
    // Nothing reached Tinker: the run is closed at no cost and the money is given back.
    const closed = await finishTinkerRun(row.id, { status: 'failed', reason: started.error, costUsd: 0, result: null, expiresAt: null }).catch(() => null)
    if (closed) await settleTinkerSpend(reservation, 0)
    await recordToolRun({
      experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: TINKER_TOOL,
      requestSummary: tinkerRequestSummary(request.base_model, request.examples.length, request.purpose), status: 'error', outputTail: `not started: ${started.error}`,
      detail: { base_model: request.base_model, dataset: { sha256: request.dataset_sha256, examples: request.examples.length, bytes: request.dataset_bytes }, reason: started.error },
    })
    return { tool: TINKER_TOOL, status: 'error', summary: `${name(ctx.executorModelId)}'s Tinker training was not started: ${started.error}` }
  }
  await markTinkerRunStarted(row.id, started.callId).catch(e =>
    console.warn('[tinker] could not store the call id:', e instanceof Error ? e.message : e))

  const waitMs = opts.maxWaitMs ?? tinkerWaitMs()
  const poll = await waitForTinkerJob(started.callId, waitMs, opts.pollMs)
  if (poll.state === 'done' || poll.state === 'failed') {
    const outcome = await completeRun({ ...row, call_id: started.callId }, poll)
    if (outcome) return outcome
  }
  return {
    tool: TINKER_TOOL, status: 'started',
    summary: `${name(ctx.executorModelId)}'s Tinker training is running (at most ${usdText(reservation.usd)} set aside); the lab collects the result at a later hourly check`,
  }
}

/** A run still marked as going this long after it was opened is given up as lost. */
export const TINKER_LOST_AFTER_MS = (TINKER_RUN_TIMEOUT_S + 900) * 1000
/**
 * A run that was opened and still has no call id this long after (its request
 * died between the two, or the runner's answer was lost) is closed. Whether
 * it started is not known, so it is charged like a lost run.
 */
export const TINKER_UNCONFIRMED_AFTER_MS = 15 * 60 * 1000

/**
 * Collects the runs of one experiment that were still training when their
 * request ended. Called on every tick. Does nothing at all, no query and no
 * request, unless the tool is switched on. Never throws.
 */
export async function collectTinkerRuns(experimentId: string, now: Date = new Date()): Promise<TinkerOutcome[]> {
  if (!tinkerFlag() || !tinkerJobsConfigured()) return []
  const out: TinkerOutcome[] = []
  try {
    for (const row of await openTinkerRuns(experimentId)) {
      const age = now.getTime() - new Date(row.created_at).getTime()
      let settled: Extract<TinkerPoll, { state: 'done' | 'failed' }> | null
      if (!row.call_id) {
        settled = age < TINKER_UNCONFIRMED_AFTER_MS ? null : { state: 'failed', error: 'its start was never confirmed' }
      } else {
        const poll = await pollTinkerJob(row.call_id)
        settled = poll.state === 'done' || poll.state === 'failed' ? poll
          : age > TINKER_LOST_AFTER_MS ? { state: 'failed', error: 'no result long after its time limit' } : null
      }
      if (!settled) continue
      const outcome = await completeRun(row, settled)
      if (outcome) {
        out.push(outcome)
        console.log(`[tinker] collected the run of epoch ${row.epoch}: ${outcome.status}`)
      }
    }
  } catch (e) {
    console.warn('[tinker] could not collect training runs (non-fatal):', e instanceof Error ? e.message : e)
  }
  return out
}
