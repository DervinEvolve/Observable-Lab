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
 *
 * A run that was opened is always closed, with its record and its cost,
 * whatever happens to the switch or to its experiment afterwards: collecting
 * (collectTinkerRuns) only asks the runner and closes rows, it starts
 * nothing, so it keeps going while the tool is switched off.
 */
import { budgetScopeFor } from './experiment-modes.js'
import { recordModelCall, refreshEpochCost, withSpendContext } from './spend.js'
import { recordToolRun, type ToolRunStatus } from './tool-runs-store.js'
import { modelDisplayName } from './types.js'
import { TINKER_NAME_TOOL } from './tinker-keep-request.js'
import {
  TINKER_PRICE_TABLE_DATE, TINKER_RUN_TIMEOUT_S, TINKER_TOOL, describeTinkerRun, estimateTinkerRun, newAdapterSlug, newSplitSalt,
  normalizeTinkerResult, tinkerCostUsd, tinkerDailyUsd, tinkerFlag, tinkerJobsConfigured, tinkerKeepFlag, tinkerNamesFlag, tinkerRunUsd, tinkerTtlDays,
  tinkerWaitMs, usdText,
  type TinkerRequest, type TinkerRunResult,
} from './tinker.js'
import { findTinkerCall, pollTinkerJob, startTinkerJob, tinkerJobBody, waitForTinkerJob, type TinkerPoll } from './tinker-client.js'
import {
  claimAdapterName, finishTinkerRun, markTinkerRunStarted, openTinkerRun, openTinkerRuns, reserveTinkerSpend, settleTinkerSpend,
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

/** What was asked, in one line, for the stored record. `name` is the adapter's display name, when it has one. */
export function tinkerRequestSummary(baseModel: string, examples: number, purpose: string | null, name: string | null = null): string {
  return `LoRA fine-tune of ${baseModel} on ${examples} examples${name ? `, named "${name}"` : ''}${purpose ? `: ${purpose}` : ''}`
}

/** The most this request could cost, for the checks made before it is run. */
export function tinkerWorstCaseUsd(request: TinkerRequest): number {
  return estimateTinkerRun(request).max_cost_usd
}

/** Stores why an adapter got no name. The run itself goes on. Never throws. */
async function recordNameRefusal(ctx: TinkerRunContext, slug: string, reason: string): Promise<void> {
  console.warn(`[Epoch ${ctx.epochNumber}] adapter name refused: ${reason}`)
  await recordToolRun({
    experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: TINKER_NAME_TOOL,
    requestSummary: `a display name for adapter lab/${slug}`, status: 'skipped',
    outputTail: `name refused: ${reason}; the run goes on and the adapter has no name`,
  })
}

/** A lost runner whose result never came: nothing measured. */
function lostResult(reason: string): TinkerRunResult {
  return { ...normalizeTinkerResult(null), status: 'failed', reason }
}

/**
 * When the lab stops offering an adapter. Tinker counts the time to live
 * from the moment the checkpoint was saved, which this server does not know
 * exactly: a result can be collected hours after the save. The run's row was
 * opened before anything was sent to the runner, so its time is never after
 * the save, and the expiry counted from it is never after Tinker's. An hour
 * is taken off on top.
 */
export function adapterExpiry(openedAt: string, ttlSeconds: number, now: Date = new Date()): string {
  const opened = Date.parse(openedAt)
  const from = Number.isFinite(opened) ? Math.min(opened, now.getTime()) : now.getTime()
  return new Date(from + Math.max(0, ttlSeconds - 3600) * 1000).toISOString()
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
  const expiresAt = result.status === 'ok' ? adapterExpiry(row.created_at, result.ttl_seconds ?? tinkerTtlDays() * 24 * 60 * 60) : null

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
    // The epoch's own row carries its cost for the public record. A run
    // collected by a later tick lands after that row was last written, so it
    // is brought up to date from the ledger here.
    await refreshEpochCost(row.experiment_id, row.epoch)
  }

  const status: ToolRunStatus = result.status === 'ok' ? 'ok' : result.status === 'refused' ? 'failed' : 'error'
  // The display name, when the run was given one (names are on and it was free). A label; the lab id is the identity.
  const name = row.display_name
  const line = describeTinkerRun(result, row.base_model, result.status === 'ok' ? row.slug : null, costUsd, expiresAt, name)
  await recordToolRun({
    experimentId: row.experiment_id, epoch: row.epoch, model: row.model, tool: TINKER_TOOL,
    requestSummary: tinkerRequestSummary(row.base_model, row.dataset_examples, row.purpose, name),
    status, durationMs: result.wall_seconds === null ? null : result.wall_seconds * 1000, costUsd, outputTail: line,
    detail: {
      ...(result.status === 'ok' ? { adapter: `lab/${row.slug}`, sampler_path: result.sampler_path, expires_at: expiresAt } : {}),
      ...(name ? { name } : {}),
      ...(result.status === 'ok' && result.external_path ? { external_path: result.external_path } : {}),
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
 * verdict, the runs-per-day limit (tinkerRunsToday in tinker-store.ts) and the lab's daily budget; the Tinker
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

  // The display name, while names are on. It never decides the run: a name
  // another adapter still has is left off with the reason stored, and the
  // run goes on. (A name that broke a rule was refused, and stored, when the
  // request was read: tool-requests.ts.)
  if (tinkerNamesFlag() && request.name) {
    let refused: string | null = null
    try {
      if (await claimAdapterName(row.id, request.name)) row = { ...row, display_name: request.name }
      else refused = `"${request.name}" is the name of another adapter that is still alive`
    } catch (e) {
      console.warn('[tinker] could not store the adapter name:', e instanceof Error ? e.message : e)
      refused = 'the lab could not store the name'
    }
    if (refused) await recordNameRefusal(ctx, row.slug, refused)
  }

  let started = await startTinkerJob(tinkerJobBody(request, {
    splitSalt, budgetUsd: reservation.usd, label: `epoch ${ctx.epochNumber} ${row.slug}`, runId: row.slug,
    ...(tinkerKeepFlag() ? { exportWeights: true } : {}),
  }))
  if (!started.ok && started.unconfirmed) {
    // The answer was lost or came from a gateway. The runner keeps the call
    // it started under the run's name, so it is asked once before giving up.
    const found = await findTinkerCall(row.slug)
    if (found) started = { ok: true, callId: found }
  }
  if (!started.ok && started.unconfirmed) {
    // The request left and nothing settles whether a run was started: it may
    // be training. Its row stays open with the money set aside. A later tick
    // asks the runner for it by name again, and if it is still unknown closes
    // it as a run whose usage is unknown (collectTinkerRuns).
    return {
      tool: TINKER_TOOL, status: 'error',
      summary: `${name(ctx.executorModelId)}'s Tinker training: ${started.error}; the ${usdText(reservation.usd)} set aside stays counted until the lab closes the run`,
    }
  }
  if (!started.ok) {
    // The runner said no before it started anything: the run is closed at no cost and the money is given back.
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
 * died between the two, or the runner's answer was lost and the runner does
 * not know the run by name) is closed. Whether it started is not known, so
 * it is charged like a lost run.
 */
export const TINKER_UNCONFIRMED_AFTER_MS = 15 * 60 * 1000

/** The most time one tick spends asking the runner about open runs before it moves on. */
export const TINKER_COLLECT_BUDGET_MS = 90_000

/**
 * Collects the runs that were still training, or whose start was never
 * confirmed, when their request ended. Called once on every tick, for every
 * experiment's runs: a run still owes its record and its cost after its
 * experiment was archived or replaced.
 *
 * It keeps going while LAB_ENABLE_TINKER is off, as long as the runner's
 * address and token are still set. Collecting starts nothing: it asks the
 * runner about runs that were already started and closes their rows, so the
 * spend of a run that was training when the tool was switched off still
 * reaches the ledger. With the switch off it only looks at the table and
 * never creates it. With the switch off and no runner configured it does
 * nothing at all, no query and no request. Never throws.
 */
export async function collectTinkerRuns(now: Date = new Date()): Promise<TinkerOutcome[]> {
  const on = tinkerFlag()
  if (!on && !tinkerJobsConfigured()) return []
  const out: TinkerOutcome[] = []
  try {
    const rows = on ? await openTinkerRuns() : await openTinkerRuns({ createTables: false }).catch(() => [])
    // The tick has an epoch to run after this. If the runner is slow to
    // answer, the runs not reached wait for the next tick.
    const giveUpAt = Date.now() + TINKER_COLLECT_BUDGET_MS
    for (const row of rows) {
      if (Date.now() > giveUpAt) break
      const age = now.getTime() - new Date(row.created_at).getTime()
      let callId = row.call_id
      if (!callId) {
        // Its start was not confirmed. The runner may know the run by name.
        callId = await findTinkerCall(row.slug)
        if (callId) await markTinkerRunStarted(row.id, callId).catch(() => {})
      }
      let settled: Extract<TinkerPoll, { state: 'done' | 'failed' }> | null
      if (!callId) {
        settled = age < TINKER_UNCONFIRMED_AFTER_MS ? null : { state: 'failed', error: 'its start was never confirmed' }
      } else {
        const poll = await pollTinkerJob(callId)
        settled = poll.state === 'done' || poll.state === 'failed' ? poll
          : age > TINKER_LOST_AFTER_MS ? { state: 'failed', error: 'no result long after its time limit' } : null
      }
      if (!settled) continue
      const outcome = await completeRun({ ...row, call_id: callId }, settled)
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
