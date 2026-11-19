/**
 * Runs one Tinker RL request the Reviewer approved (tinker-rl.ts), keeps its
 * progress while it goes, and closes it when the runner has answered.
 *
 * The order is the one tinker-run.ts uses for a training run: estimate the
 * most it could cost; refuse it above the per-run cap; set that estimate
 * aside under the daily Tinker cap in the database (the same table and the
 * same atomic statement); open the epoch's one run row; start the lab's runner
 * on Modal; wait a while, storing the runner's progress on the row each time
 * it answers. When the result is in, the money set aside is replaced by the
 * tokens the runner counted at the published prices, the run is stored as
 * evidence (tinker_runs and tool_runs) and its estimated cost goes on the
 * spend ledger.
 *
 * Collecting a run that was still going when its request ended is
 * collectTinkerRuns in tinker-run.ts, which hands RL rows to completeRlRun.
 * Nothing here throws into the epoch.
 */
import { budgetScopeFor } from './experiment-modes.js'
import { recordModelCall, refreshEpochCost, withSpendContext } from './spend.js'
import { recordToolRun, type ToolRunStatus } from './tool-runs-store.js'
import { modelDisplayName } from './types.js'
import { TINKER_NAME_TOOL } from './tinker-keep-request.js'
import {
  TINKER_PRICE_TABLE_DATE, newAdapterSlug, newSplitSalt, tinkerCostUsd, tinkerDailyUsd, tinkerKeepFlag, tinkerNamesFlag, tinkerRunUsd, tinkerTtlDays, tinkerWaitMs, usdText,
} from './tinker.js'
import {
  TINKER_RL_TOOL, describeTinkerRl, estimateTinkerRl, isNewerProgress, normalizeRlResult, readRlProgress, rlHackingFlag, rlRecordOf, storedRlProgress, tinkerRlJobBody,
  tinkerRlRequestSummary,
  type RlProgress, type TinkerRlRequest, type TinkerRlResult,
} from './tinker-rl.js'
import { findTinkerCall, startTinkerJob, waitForTinkerJob, type TinkerPoll } from './tinker-client.js'
import {
  claimAdapterName, finishTinkerRlRun, markTinkerRunStarted, openTinkerRlRun, reserveTinkerSpend, setRlProgress, settleTinkerSpend, shownName,
  type TinkerRunRow,
} from './tinker-store.js'
import { adapterExpiry, type TinkerOutcome, type TinkerRunContext } from './tinker-run.js'

const name = (id: string) => modelDisplayName(id) || id.split('/').pop() || id

/** The most this request could cost, for the checks made before it is run. */
export function tinkerRlWorstCaseUsd(request: TinkerRlRequest): number {
  return estimateTinkerRl(request).max_cost_usd
}

/** The summary line of a request, for the stored record. */
export function rlSummary(request: TinkerRlRequest): string {
  return tinkerRlRequestSummary(request.base_model, request.tasks.length, request.rubric.rules.length, request.settings.steps, request.purpose || null, request.name ?? null)
}

/**
 * Stores what the runner said about a run that is still going, if it is a
 * well formed record. Whatever the runner sent is read strictly first; a
 * record that is not well formed is dropped and the last good one stays.
 * Never throws.
 */
export async function storeRlProgress(row: Pick<TinkerRunRow, 'id'> & Partial<Pick<TinkerRunRow, 'progress'>>, raw: unknown, now: Date = new Date()): Promise<RlProgress | null> {
  const progress = readRlProgress(raw, now)
  if (!progress) return null
  // A record the lab already holds is not stored again, so its time stays the time the runner last said something new.
  const held = storedRlProgress(row.progress ?? null)
  if (held && !isNewerProgress(progress, held)) return held
  await setRlProgress(row.id, progress)
  return progress
}

/**
 * The record of a run that has finished, made from what the runner returned:
 * the same fields the live record has, from the stored result. Nothing in it
 * is new: the step means, the held-out scores and the answers the runner kept.
 */
export function finalRlProgress(row: Pick<TinkerRunRow, 'settings'>, result: TinkerRlResult, now: Date = new Date()): RlProgress | null {
  if (result.status !== 'ok' && !result.step_means.length) return null
  const s = row.settings as { group_size?: unknown; tasks_per_step?: unknown }
  const group = typeof s.group_size === 'number' ? s.group_size : 2
  const perStep = typeof s.tasks_per_step === 'number' ? s.tasks_per_step : 1
  return readRlProgress({
    v: 1, phase: 'done', step: result.steps_done ?? result.step_means.length, steps_planned: Math.max(result.steps_planned ?? 1, result.steps_done ?? 1, result.step_means.length, 1),
    group_size: group, tasks_per_step: perStep, max_reward: result.max_reward ?? 1,
    means: result.step_means, frac_max: result.step_frac_max, attempts: [], samples: result.samples,
    score_before: result.score_before, score_after: result.score_after, wall_seconds: result.wall_seconds ?? 0,
    steps_trained: result.steps_trained,
  }, now)
}

/** A lost runner whose result never came: nothing measured. */
function lostResult(reason: string): TinkerRlResult {
  return { ...normalizeRlResult(null), status: 'failed', reason }
}

/**
 * Closes an RL run with what the runner answered: settles the money, stores
 * the evidence and returns the line for the epoch. null when another request
 * closed the same run first (it did all of this already).
 */
export async function completeRlRun(row: TinkerRunRow, poll: Extract<TinkerPoll, { state: 'done' | 'failed' }>): Promise<TinkerOutcome | null> {
  const result = poll.state === 'done' ? normalizeRlResult(poll.result) : lostResult(`the runner was lost: ${poll.error}`)
  const usageKnown = poll.state === 'done' && result.status !== 'failed'
  const costUsd = usageKnown ? tinkerCostUsd(row.base_model, result.tokens) : row.reserved_usd
  const expiresAt = result.status === 'ok' ? adapterExpiry(row.created_at, result.ttl_seconds ?? tinkerTtlDays() * 24 * 60 * 60) : null
  const progress = finalRlProgress(row, result) ?? storedRlProgress(row.progress)

  const closed = await finishTinkerRlRun(row.id, { status: result.status, reason: result.reason, costUsd, result, expiresAt, progress })
  if (!closed) return null
  await settleTinkerSpend({ day: row.spend_day, scope: 'all', usd: row.reserved_usd }, costUsd)

  const budgetScope = await budgetScopeFor(row.experiment_id).catch(() => 'classic' as const)
  if (costUsd > 0) {
    await withSpendContext({ experimentId: row.experiment_id, epochNumber: row.epoch, purpose: TINKER_RL_TOOL, budgetScope }, () =>
      recordModelCall({
        model: `tool/${TINKER_RL_TOOL}`, assigned: row.assigned_model ?? row.model, cost_usd: costUsd, cost_source: 'estimate',
        prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      }))
    await refreshEpochCost(row.experiment_id, row.epoch)
  }

  const status: ToolRunStatus = result.status === 'ok' ? 'ok' : result.status === 'refused' ? 'failed' : 'error'
  const displayName = shownName(row)
  const hacking = rlHackingFlag({ means: result.step_means, maxReward: result.max_reward ?? 1, scoreBefore: result.score_before, scoreAfter: result.score_after })
  const line = describeTinkerRl(result, row.base_model, result.status === 'ok' ? row.slug : null, costUsd, expiresAt, displayName, hacking)
  const record = (row.rl ?? {}) as { task_set?: unknown; tasks?: unknown; rubric_lines?: unknown; max_reward?: unknown }
  await recordToolRun({
    experimentId: row.experiment_id, epoch: row.epoch, model: row.model, tool: TINKER_RL_TOOL,
    requestSummary: tinkerRlRequestSummary(row.base_model, row.dataset_examples, Array.isArray(record.rubric_lines) ? record.rubric_lines.length : 0, Number((row.settings as { steps?: unknown }).steps) || 0, row.purpose, displayName),
    status, durationMs: result.wall_seconds === null ? null : result.wall_seconds * 1000, costUsd, outputTail: line,
    detail: {
      kind: 'rl',
      ...(result.status === 'ok' ? { adapter: `lab/${row.slug}`, sampler_path: result.sampler_path, expires_at: expiresAt } : {}),
      ...(displayName ? { name: displayName } : {}),
      ...(result.status === 'ok' && result.external_path ? { external_path: result.external_path } : {}),
      ...(result.status === 'ok' && result.export_error ? { export_error: result.export_error } : {}),
      base_model: row.base_model,
      tasks: { sha256: row.dataset_sha256, count: row.dataset_examples, bytes: row.dataset_bytes, task_set: typeof record.task_set === 'string' ? record.task_set : null },
      rubric: Array.isArray(record.rubric_lines) ? record.rubric_lines : [],
      settings: row.settings,
      measured: {
        by: 'the lab, with the rubric, on tasks it held out and the model could not choose',
        holdout_tasks: result.n_holdout, train_tasks: result.n_train, max_reward: result.max_reward,
        score_before: result.score_before, score_after: result.score_after,
      },
      training: {
        steps_planned: result.steps_planned, steps_done: result.steps_done, steps_trained: result.steps_trained, stopped_early: result.stopped_early,
        reward_first: result.train_score_first, reward_last: result.train_score_last,
        note: 'the reward of the training steps is what the run trained on, not a measurement of what it learned',
      },
      reward_hacking: hacking,
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
  return { tool: TINKER_RL_TOOL, status, summary: `${name(row.model)}'s Tinker RL: ${line}` }
}

/**
 * Runs an approved request. The caller has already checked the Reviewer's
 * verdict, the runs-per-day limit (tinkerRlRunsToday) and the lab's daily
 * budget; the Tinker caps are checked here. A refusal is returned as
 * `skipped` with its reason for the caller to store.
 */
export async function runTinkerRl(ctx: TinkerRunContext, request: TinkerRlRequest, opts: { maxWaitMs?: number; pollMs?: number } = {}): Promise<TinkerOutcome> {
  const skipped = (reason: string): TinkerOutcome => ({ tool: TINKER_RL_TOOL, status: 'skipped', summary: reason })
  const estimate = estimateTinkerRl(request)
  const runCap = tinkerRunUsd()
  if (estimate.max_cost_usd > runCap) {
    return skipped(`the most it could cost (${usdText(estimate.max_cost_usd)}, estimated from published prices) is over the ${usdText(runCap)} a run may cost`)
  }

  let reservation: Awaited<ReturnType<typeof reserveTinkerSpend>>
  try {
    reservation = await reserveTinkerSpend('all', estimate.max_cost_usd, tinkerDailyUsd())
  } catch (e) {
    console.warn('[tinker-rl] could not set the estimate aside:', e instanceof Error ? e.message : e)
    return skipped('the lab could not check today\'s Tinker spend, so nothing was started')
  }
  if (!reservation.ok) return skipped(`its estimated cost of ${usdText(estimate.max_cost_usd)} was not set aside: ${reservation.reason}`)

  const splitSalt = newSplitSalt()
  let row: TinkerRunRow | null
  try {
    row = await openTinkerRlRun({
      experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, assignedModel: ctx.assignedExecutorId,
      slug: newAdapterSlug(ctx.epochNumber), request, record: rlRecordOf(request), splitSalt, spendDay: reservation.day, reservedUsd: reservation.usd,
    })
  } catch (e) {
    await settleTinkerSpend(reservation, 0)
    console.warn('[tinker-rl] could not open a run:', e instanceof Error ? e.message : e)
    return skipped('the lab could not store the run, so nothing was started')
  }
  if (!row) {
    await settleTinkerSpend(reservation, 0)
    return skipped('this epoch already has a Tinker run')
  }

  // The display name, while names are on: it never decides the run.
  if (tinkerNamesFlag() && request.name) {
    let refused: string | null = null
    try {
      if (await claimAdapterName(row.id, request.name)) row = { ...row, display_name: request.name }
      else refused = `"${request.name}" is the name of another adapter that is still alive`
    } catch (e) {
      console.warn('[tinker-rl] could not store the adapter name:', e instanceof Error ? e.message : e)
      refused = 'the lab could not store the name'
    }
    if (refused) {
      console.warn(`[Epoch ${ctx.epochNumber}] adapter name refused: ${refused}`)
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: TINKER_NAME_TOOL,
        requestSummary: `a display name for adapter lab/${row.slug}`, status: 'skipped',
        outputTail: `name refused: ${refused}; the run goes on and the adapter has no name`,
      })
    }
  }

  let started = await startTinkerJob(tinkerRlJobBody(request, {
    splitSalt, budgetUsd: reservation.usd, label: `epoch ${ctx.epochNumber} ${row.slug} rl`, runId: row.slug,
    ...(tinkerKeepFlag() ? { exportWeights: true } : {}),
  }))
  if (!started.ok && started.unconfirmed) {
    const found = await findTinkerCall(row.slug)
    if (found) started = { ok: true, callId: found }
  }
  if (!started.ok && started.unconfirmed) {
    // Whether a run was started is not settled: it may be training. Its row stays open with the money set aside,
    // and a later tick asks the runner for it by name again (collectTinkerRuns).
    return {
      tool: TINKER_RL_TOOL, status: 'error',
      summary: `${name(ctx.executorModelId)}'s Tinker RL: ${started.error}; the ${usdText(reservation.usd)} set aside stays counted until the lab closes the run`,
    }
  }
  if (!started.ok) {
    const closed = await finishTinkerRlRun(row.id, { status: 'failed', reason: started.error, costUsd: 0, result: null, expiresAt: null, progress: null }).catch(() => null)
    if (closed) await settleTinkerSpend(reservation, 0)
    await recordToolRun({
      experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: TINKER_RL_TOOL,
      requestSummary: rlSummary(request), status: 'error', outputTail: `not started: ${started.error}`,
      detail: { kind: 'rl', base_model: request.base_model, tasks: { sha256: request.dataset_sha256, count: request.tasks.length, bytes: request.dataset_bytes }, reason: started.error },
    })
    return { tool: TINKER_RL_TOOL, status: 'error', summary: `${name(ctx.executorModelId)}'s Tinker RL was not started: ${started.error}` }
  }
  await markTinkerRunStarted(row.id, started.callId).catch(e =>
    console.warn('[tinker-rl] could not store the call id:', e instanceof Error ? e.message : e))

  const waitMs = opts.maxWaitMs ?? tinkerWaitMs()
  let held: RlProgress | null = null
  const poll = await waitForTinkerJob(started.callId, waitMs, opts.pollMs, {
    runId: row.slug,
    onProgress: async raw => {
      const stored = await storeRlProgress({ id: row.id, progress: held as unknown as Record<string, unknown> | null }, raw)
      if (stored) held = stored
    },
  })
  if (poll.state === 'done' || poll.state === 'failed') {
    const outcome = await completeRlRun({ ...row, call_id: started.callId }, poll)
    if (outcome) return outcome
  }
  return {
    tool: TINKER_RL_TOOL, status: 'started',
    summary: `${name(ctx.executorModelId)}'s Tinker RL is running (at most ${usdText(reservation.usd)} set aside); the lab collects the result at a later hourly check`,
  }
}
