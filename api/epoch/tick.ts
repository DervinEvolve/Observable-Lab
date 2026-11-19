import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { runEpoch } from '../_lib/epoch-runner.js'
import { runAndPersistNorth } from '../_lib/north-persist.js'
import {
  EpochBusyError, clearStaleClaim, envEpochStaleMinutes, epochCadence, epochIntervalMinutes,
} from '../_lib/epoch-claim.js'
import { BudgetPausedError, budgetPausedState, describeBudget } from '../_lib/spend.js'
import { persistGlassIfBrokenOut } from '../_lib/growth.js'
import { runEpochFollowUp } from '../_lib/epoch-followup.js'
import { loadTickExperiment, researchAlongside, type TickSlot } from '../_lib/experiment-modes.js'
import { ensureResearchExperiment, type ResearchActivation } from '../_lib/research-alongside.js'
import { ResearchRunPendingError } from '../_lib/research.js'
import { collectTinkerRuns } from '../_lib/tinker-run.js'
import { collectTinkerKeeps } from '../_lib/tinker-keep.js'

type TickBody = Record<string, unknown>

const NO_EXPERIMENT: TickBody = { message: 'No active experiment', next_check: 'On next cron invocation' }

// GET /api/epoch/tick - Cron endpoint (hourly) to run the next epoch when it is due.
//
// Normally one experiment is active and the tick advances it. With
// LAB_RESEARCH_ALONGSIDE on, a research experiment runs beside the classic
// one: both are advanced in the same request, at the same time, each with
// its own claim, stale limit, follow-ups, cadence and daily cap, so one that
// fails, is busy or is over its cap never holds up the other.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Before anything else: the research epoch measures how long it may still
  // wait, and whether it may still start a GPU run, from this moment.
  const requestStartedAt = Date.now()
  if (!requireBearer(req, res, 'CRON_SECRET')) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Tinker training runs that were still going when their follow-up ended:
  // their results are collected here, once per tick and before anything
  // else, whichever experiment they belong to and whatever this tick goes on
  // to do (an epoch in progress, nothing due, no active experiment). With
  // LAB_ENABLE_TINKER off and no runner configured this does nothing, not
  // even a query. It never throws.
  const collected = await collectTinkerRuns()
  if (collected.length) console.log(`[CRON] Collected ${collected.length} Tinker training run(s)`)
  // The same for adapters that were still being kept when their request
  // ended. With LAB_ENABLE_TINKER_KEEP off this does nothing, not even a
  // query. It never throws.
  const kept = await collectTinkerKeeps()
  if (kept.length) console.log(`[CRON] Collected ${kept.length} adapter keep(s)`)

  if (!researchAlongside()) {
    try {
      // The classic experiment, or the only active one. Active means anything
      // not archived (seeding, growing, stable, failing): a failing spec keeps
      // running so it can recover, and says so publicly.
      const experiment = await loadTickExperiment('primary')
      if (!experiment) {
        console.log('[CRON] No active experiment')
        return res.status(200).json(NO_EXPERIMENT)
      }
      return res.status(200).json(await advance(experiment, 'primary', requestStartedAt))
    } catch (error) {
      // Log full error server-side, return sanitized message to client
      console.error('[CRON] Error in epoch tick:', error)
      return res.status(500).json({
        error: 'Epoch processing failed',
      })
    }
  }

  const [classic, research] = await Promise.allSettled([
    (async (): Promise<TickBody> => {
      const experiment = await loadTickExperiment('classic')
      if (!experiment) {
        console.log('[CRON] No active experiment')
        return NO_EXPERIMENT
      }
      return advance(experiment, 'classic', requestStartedAt)
    })(),
    (async (): Promise<TickBody> => {
      let experiment = await loadTickExperiment('research')
      let activation: ResearchActivation | undefined
      if (!experiment) {
        activation = await ensureResearchExperiment()
        if (activation.activated) experiment = await loadTickExperiment('research')
      }
      if (!experiment) {
        console.log(`[CRON research] No active research experiment: ${activation && !activation.activated ? activation.reason : 'none found'}`)
        return { message: 'No active research experiment', activation }
      }
      return { ...(await advance(experiment, 'research', requestStartedAt)), ...(activation ? { activation } : {}) }
    })(),
  ])
  if (classic.status === 'rejected') console.error('[CRON] Error in epoch tick:', classic.reason)
  if (research.status === 'rejected') console.error('[CRON research] Error in epoch tick:', research.reason)
  const failed: TickBody = { error: 'Epoch processing failed' }
  return res.status(classic.status === 'rejected' || research.status === 'rejected' ? 500 : 200).json({
    ...(classic.status === 'fulfilled' ? classic.value : failed),
    research: research.status === 'fulfilled' ? research.value : failed,
  })
}

/**
 * Advances one experiment by at most one step: clears a stale claim, runs a
 * waiting follow-up, or runs the next epoch when it is due. Returns what it
 * did; throws only for an error nobody expected.
 */
async function advance(experiment: Record<string, any>, slot: TickSlot, requestStartedAt: number): Promise<TickBody> {
  const tag = slot === 'research' ? '[CRON research]' : '[CRON]'
  const staleMinutes = envEpochStaleMinutes()

  // An epoch that is still marked as running: leave it, unless it is older
  // than the stale limit (a function that hit its time limit never clears it).
  if (experiment.epoch_in_progress) {
    const startedAt = experiment.epoch_started_at ? new Date(experiment.epoch_started_at).getTime() : 0
    const minutesInProgress = startedAt ? (Date.now() - startedAt) / 60000 : Infinity
    if (minutesInProgress < staleMinutes) {
      return {
        message: 'Epoch already in progress',
        experiment_id: experiment.id,
        minutes_in_progress: Math.round(minutesInProgress),
        stale_minutes: staleMinutes,
      }
    }
    if (await clearStaleClaim(experiment.id, staleMinutes)) {
      console.warn(`${tag} Cleared stale epoch flag after ${Math.round(minutesInProgress)} minutes for experiment ${experiment.id}`)
    }
  }

  // A finished epoch's queued work (its code contribution, approved
  // exhibits and proposals) gets a tick of its own before the next epoch,
  // so neither has to share the 800 s function limit with the other.
  const followUp = await runEpochFollowUp(experiment.id)
  if (followUp.ran || followUp.reason !== 'nothing pending') {
    console.log(`${tag} Follow-up for epoch ${followUp.epoch_number ?? '?'}: ${followUp.ran ? followUp.status : followUp.reason}`)
    if (followUp.ran || followUp.reason === 'an epoch is in progress') {
      return { message: 'Ran the previous epoch\'s follow-up', experiment_id: experiment.id, follow_up: followUp }
    }
    // Budget spent: the epoch below will pause for the same reason.
  }

  // Cadence: measured from the end of the last epoch, with a small
  // tolerance so an hourly cron keeps a 180-minute rhythm.
  const cadence = epochCadence(experiment.last_epoch_at, epochIntervalMinutes(experiment.current_spec))
  if (!cadence.due) {
    return {
      message: `Waiting. ${cadence.minutes_remaining} minutes until next epoch.`,
      experiment_id: experiment.id,
      current_epoch: experiment.current_epoch,
      last_epoch_at: experiment.last_epoch_at,
      interval_minutes: cadence.interval_minutes,
    }
  }

  console.log(`${tag} Starting epoch ${experiment.current_epoch + 1} for experiment ${experiment.id} (status ${experiment.status})`)

  const tickStart = Date.now()
  let result: Awaited<ReturnType<typeof runEpoch>>
  try {
    result = await runEpoch(experiment.id, { requestStartedAt })
  } catch (e) {
    if (e instanceof BudgetPausedError) {
      console.warn(`${tag} Skipping epoch ${experiment.current_epoch + 1}: ${describeBudget(e.status)}`)
      return {
        message: `Skipped: ${e.status.reason ?? 'daily budget reached'}`,
        state: budgetPausedState(e.status),
        resumes_at: e.status.resumes_at,
        experiment_id: experiment.id,
      }
    }
    if (e instanceof EpochBusyError) {
      console.log(`${tag} Epoch already claimed by another request for ${experiment.id}`)
      return { message: 'Epoch already in progress', experiment_id: experiment.id }
    }
    // Beside run 2, a GPU run that is still training when the request stops
    // waiting is not a failure: the claim is released, the call id is stored
    // and the next tick collects the result.
    if (slot === 'research' && e instanceof ResearchRunPendingError) {
      console.log(`${tag} Epoch ${experiment.current_epoch + 1}: GPU run still in progress; resumes next tick`)
      return { message: 'GPU run still in progress; resumes next tick', experiment_id: experiment.id, epoch_number: experiment.current_epoch + 1 }
    }
    throw e
  }

  const done: TickBody = {
    success: true,
    message: `Epoch ${result.epochNumber} completed`,
    experiment_id: experiment.id,
    epoch_number: result.epochNumber,
    stability_score: result.newSpec.meta.stability_score,
    mood: result.commentatorOutput.mood,
    summary: result.commentatorOutput.summary,
  }
  // The research experiment beside run 2 has no glass and no North: both
  // belong to the specimen in the room.
  if (slot === 'research') return done

  // Once the specimen has broken out of the glass, keep it broken.
  await persistGlassIfBrokenOut(experiment.id)

  // North (+ optional GLM pairing) runs its own wildcard experiment every
  // few epochs, off to the side of the main panel — kept infrequent to
  // conserve credits, per design. Skipped when the epoch (now including
  // real CI waits) already ate most of the 800s budget — North catches the
  // next multiple-of-N epoch instead of dying mid-run to the timeout.
  const specParams = (experiment.current_spec?.meta?.experiment_params ?? {}) as Record<string, number>
  const northEveryNEpochs = specParams.north_every_n_epochs
    ?? parseInt(process.env.NORTH_EVERY_N_EPOCHS || '3', 10)
  const elapsedS = (Date.now() - tickStart) / 1000
  let north: Awaited<ReturnType<typeof runAndPersistNorth>> | null = null
  if (northEveryNEpochs > 0 && result.epochNumber % northEveryNEpochs === 0) {
    if (elapsedS > 420) {
      console.warn(`[CRON] Skipping North this epoch — ${Math.round(elapsedS)}s already elapsed`)
    } else {
      try {
        north = await runAndPersistNorth(experiment.id, result.newSpec, result.epochNumber)
      } catch (e) {
        if (e instanceof BudgetPausedError) console.warn(`[CRON] Skipping North: ${describeBudget(e.status)}`)
        else console.warn('[CRON] North experiment failed (non-fatal):', e instanceof Error ? e.message : e)
      }
    }
  }

  return {
    ...done,
    north: north ? {
      hypothesis: north.hypothesis,
      tools_used: north.toolsUsed,
      contribution: north.contribution,
      cost_usd: north.cost,
    } : null,
  }
}
