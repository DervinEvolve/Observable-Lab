import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { runEpoch } from '../_lib/epoch-runner.js'

// POST /api/epoch/run - Force trigger an epoch (for testing)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST to trigger epoch.' })
  }

  try {
    // Get the active experiment
    const experimentResult = await sql`
      SELECT * FROM experiments
      WHERE status IN ('seeding', 'growing', 'stable') AND epoch_in_progress = FALSE
      LIMIT 1
    `

    if (!experimentResult.rows[0]) {
      return res.status(404).json({
        error: 'No active experiment found or epoch already in progress',
        hint: 'POST to /api/experiment to seed a new experiment first',
      })
    }

    const experiment = experimentResult.rows[0]

    console.log(`[TEST] Force triggering epoch ${experiment.current_epoch + 1} for experiment ${experiment.id}`)

    // Run the epoch
    const result = await runEpoch(experiment.id)

    return res.status(200).json({
      success: true,
      message: `Epoch ${result.epochNumber} completed successfully`,
      experiment_id: experiment.id,
      epoch_number: result.epochNumber,
      new_spec: {
        stability_score: result.newSpec.meta.stability_score,
        growth_stage: result.newSpec.meta.growth_stage,
        capabilities_count: result.newSpec.capabilities.length,
        constraints_count: result.newSpec.constraints.length,
        behaviors_count: result.newSpec.behaviors.length,
        conflicts_count: result.newSpec.conflicts.filter(c => !c.resolved).length,
      },
      commentator: result.commentatorOutput,
    })
  } catch (error) {
    // Log full error server-side, return sanitized message to client
    console.error('[EPOCH] Error running epoch:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    // Only expose safe error messages to client
    const safeMessages = ['Model service not configured', 'Model service error', 'Model returned invalid response']
    const clientMessage = safeMessages.some(m => message.includes(m)) ? message : 'Epoch processing failed'
    return res.status(500).json({
      error: clientMessage,
    })
  }
}

// redeploy trigger 1769129894

