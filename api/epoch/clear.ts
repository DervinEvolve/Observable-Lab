import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'

// POST /api/epoch/clear - Clear stuck epoch state (admin endpoint)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST to clear stuck epochs.' })
  }

  try {
    // Find experiments with stuck epochs
    const stuckResult = await sql`
      SELECT id, current_epoch, epoch_started_at
      FROM experiments
      WHERE epoch_in_progress = TRUE
    `

    if (stuckResult.rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No stuck epochs found',
        cleared: 0,
      })
    }

    const cleared: { experiment_id: string; epoch_number: number; stuck_duration_minutes: number }[] = []

    for (const experiment of stuckResult.rows) {
      const stuckMinutes = experiment.epoch_started_at
        ? Math.round((Date.now() - new Date(experiment.epoch_started_at).getTime()) / 60000)
        : 0

      // Clear the stuck flag
      await sql`
        UPDATE experiments
        SET epoch_in_progress = FALSE, epoch_started_at = NULL
        WHERE id = ${experiment.id}
      `

      // Mark any incomplete epochs for this experiment as failed
      await sql`
        UPDATE epochs
        SET completed_at = NOW()
        WHERE experiment_id = ${experiment.id}
          AND epoch_number = ${experiment.current_epoch + 1}
          AND completed_at IS NULL
      `

      cleared.push({
        experiment_id: experiment.id,
        epoch_number: experiment.current_epoch + 1,
        stuck_duration_minutes: stuckMinutes,
      })

      console.log(`[ADMIN] Cleared stuck epoch ${experiment.current_epoch + 1} for experiment ${experiment.id} (stuck for ${stuckMinutes} minutes)`)
    }

    return res.status(200).json({
      success: true,
      message: `Cleared ${cleared.length} stuck epoch(s)`,
      cleared: cleared.length,
      details: cleared,
    })
  } catch (error) {
    console.error('[ADMIN] Error clearing stuck epochs:', error)
    return res.status(500).json({
      error: 'Failed to clear stuck epochs',
    })
  }
}

