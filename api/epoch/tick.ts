import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { runEpoch } from '../_lib/epoch-runner.js'
import { runAndPersistNorth } from '../_lib/north-persist.js'
import {
  EpochBusyError, clearStaleClaim, envEpochStaleMinutes, epochCadence, epochIntervalMinutes,
} from '../_lib/epoch-claim.js'
import { BUDGET_PAUSED_STATE, BudgetPausedError, describeBudget } from '../_lib/spend.js'
import { persistGlassIfBrokenOut } from '../_lib/growth.js'

// GET /api/epoch/tick - Cron endpoint (hourly) to run the next epoch when it is due.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res, 'CRON_SECRET')) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const staleMinutes = envEpochStaleMinutes()

    // The newest active experiment is the only one the cron runs. Active
    // means anything not archived (seeding, growing, stable, failing): a
    // failing spec keeps running so it can recover, and says so publicly.
    const experimentResult = await sql`
      SELECT e.*,
        (SELECT completed_at FROM epochs WHERE experiment_id = e.id ORDER BY epoch_number DESC LIMIT 1) as last_epoch_at
      FROM experiments e
      WHERE e.status <> 'archived'
      ORDER BY e.created_at DESC
      LIMIT 1
    `
    const experiment = experimentResult.rows[0]
    if (!experiment) {
      console.log('[CRON] No active experiment')
      return res.status(200).json({ message: 'No active experiment', next_check: 'On next cron invocation' })
    }

    // An epoch that is still marked as running: leave it, unless it is older
    // than the stale limit (a function that hit its time limit never clears it).
    if (experiment.epoch_in_progress) {
      const startedAt = experiment.epoch_started_at ? new Date(experiment.epoch_started_at).getTime() : 0
      const minutesInProgress = startedAt ? (Date.now() - startedAt) / 60000 : Infinity
      if (minutesInProgress < staleMinutes) {
        return res.status(200).json({
          message: 'Epoch already in progress',
          experiment_id: experiment.id,
          minutes_in_progress: Math.round(minutesInProgress),
          stale_minutes: staleMinutes,
        })
      }
      if (await clearStaleClaim(experiment.id, staleMinutes)) {
        console.warn(`[CRON] Cleared stale epoch flag after ${Math.round(minutesInProgress)} minutes for experiment ${experiment.id}`)
      }
    }

    // Cadence: measured from the end of the last epoch, with a small
    // tolerance so an hourly cron keeps a 180-minute rhythm.
    const cadence = epochCadence(experiment.last_epoch_at, epochIntervalMinutes(experiment.current_spec))
    if (!cadence.due) {
      return res.status(200).json({
        message: `Waiting. ${cadence.minutes_remaining} minutes until next epoch.`,
        experiment_id: experiment.id,
        current_epoch: experiment.current_epoch,
        last_epoch_at: experiment.last_epoch_at,
        interval_minutes: cadence.interval_minutes,
      })
    }

    console.log(`[CRON] Starting epoch ${experiment.current_epoch + 1} for experiment ${experiment.id} (status ${experiment.status})`)

    const tickStart = Date.now()
    let result: Awaited<ReturnType<typeof runEpoch>>
    try {
      result = await runEpoch(experiment.id)
    } catch (e) {
      if (e instanceof BudgetPausedError) {
        console.warn(`[CRON] Skipping epoch ${experiment.current_epoch + 1}: ${describeBudget(e.status)}`)
        return res.status(200).json({
          message: `Skipped: ${e.status.reason ?? 'daily budget reached'}`,
          state: BUDGET_PAUSED_STATE,
          resumes_at: e.status.resumes_at,
          experiment_id: experiment.id,
        })
      }
      if (e instanceof EpochBusyError) {
        console.log(`[CRON] Epoch already claimed by another request for ${experiment.id}`)
        return res.status(200).json({ message: 'Epoch already in progress', experiment_id: experiment.id })
      }
      throw e
    }

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

    return res.status(200).json({
      success: true,
      message: `Epoch ${result.epochNumber} completed`,
      experiment_id: experiment.id,
      epoch_number: result.epochNumber,
      stability_score: result.newSpec.meta.stability_score,
      mood: result.commentatorOutput.mood,
      summary: result.commentatorOutput.summary,
      north: north ? {
        hypothesis: north.hypothesis,
        tools_used: north.toolsUsed,
        contribution: north.contribution,
        cost_usd: north.cost,
      } : null,
    })
  } catch (error) {
    // Log full error server-side, return sanitized message to client
    console.error('[CRON] Error in epoch tick:', error)
    return res.status(500).json({
      error: 'Epoch processing failed',
    })
  }
}
