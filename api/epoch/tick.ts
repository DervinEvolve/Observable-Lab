import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { runEpoch } from '../_lib/epoch-runner.js'
import { runAndPersistNorth } from '../_lib/north-persist.js'

// GET /api/epoch/tick - Cron endpoint to trigger epoch if ready
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res, 'CRON_SECRET')) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const envInterval = parseInt(process.env.EPOCH_INTERVAL_MINUTES || '60', 10)
    const staleMinutes = parseInt(process.env.EPOCH_STALE_MINUTES || '60', 10)

    // Detect and clear stale in-progress epoch so the scheduler can resume
    const inProgressResult = await sql`
      SELECT e.*
      FROM experiments e
      WHERE e.status IN ('seeding', 'growing', 'stable') AND e.epoch_in_progress = TRUE
      ORDER BY created_at DESC
      LIMIT 1
    `

    if (inProgressResult.rows[0]) {
      const inProgress = inProgressResult.rows[0]
      const startedAt = inProgress.epoch_started_at
        ? new Date(inProgress.epoch_started_at).getTime()
        : 0
      const minutesInProgress = startedAt ? (Date.now() - startedAt) / 60000 : Infinity

      if (minutesInProgress >= staleMinutes) {
        await sql`
          UPDATE experiments
          SET epoch_in_progress = FALSE, epoch_started_at = NULL
          WHERE id = ${inProgress.id}
        `
        console.warn(
          `[CRON] Cleared stale epoch flag after ${Math.round(minutesInProgress)} minutes for experiment ${inProgress.id}`
        )
      } else {
        return res.status(200).json({
          message: 'Epoch already in progress',
          experiment_id: inProgress.id,
          minutes_in_progress: Math.round(minutesInProgress),
          stale_minutes: staleMinutes,
        })
      }
    }

    // Check if there's an active experiment ready for next epoch
    const experimentResult = await sql`
      SELECT e.*,
        (SELECT completed_at FROM epochs WHERE experiment_id = e.id ORDER BY epoch_number DESC LIMIT 1) as last_epoch_at
      FROM experiments e
      WHERE e.status IN ('seeding', 'growing', 'stable') AND e.epoch_in_progress = FALSE
      LIMIT 1
    `

    if (!experimentResult.rows[0]) {
      return res.status(200).json({
        message: 'No active experiment or epoch already in progress',
        next_check: 'On next cron invocation',
      })
    }

    const experiment = experimentResult.rows[0]
    // Self-governance: the agents can tune their own epoch tempo (clamped
    // 30-180 at write time); falls back to the env default.
    const specParams = (experiment.current_spec?.meta?.experiment_params ?? {}) as Record<string, number>
    const interval = specParams.epoch_interval_minutes ?? envInterval
    const lastEpochAt = experiment.last_epoch_at
      ? new Date(experiment.last_epoch_at).getTime()
      : 0

    const minutesSinceLastEpoch = lastEpochAt
      ? (Date.now() - lastEpochAt) / 60000
      : Infinity

    if (minutesSinceLastEpoch < interval) {
      const minutesRemaining = Math.round(interval - minutesSinceLastEpoch)
      return res.status(200).json({
        message: `Waiting. ${minutesRemaining} minutes until next epoch.`,
        experiment_id: experiment.id,
        current_epoch: experiment.current_epoch,
        last_epoch_at: experiment.last_epoch_at,
        interval_minutes: interval,
      })
    }

    // Run the epoch
    console.log(`Starting epoch ${experiment.current_epoch + 1} for experiment ${experiment.id}`)

    const tickStart = Date.now()
    const result = await runEpoch(experiment.id)

    // North (+ optional GLM pairing) runs its own wildcard experiment every
    // few epochs, off to the side of the main panel — kept infrequent to
    // conserve credits, per design. Skipped when the epoch (now including
    // real CI waits) already ate most of the 800s budget — North catches the
    // next multiple-of-N epoch instead of dying mid-run to the timeout.
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
          console.warn('[CRON] North experiment failed (non-fatal):', e instanceof Error ? e.message : e)
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

