import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { runEpoch } from '../_lib/epoch-runner.js'
import { EpochBusyError } from '../_lib/epoch-claim.js'
import { BudgetPausedError, budgetPausedState } from '../_lib/spend.js'
import { persistGlassIfBrokenOut } from '../_lib/growth.js'
import { requeueFollowUp, runEpochFollowUp } from '../_lib/epoch-followup.js'
import { researchAlongside } from '../_lib/experiment-modes.js'
import { ResearchRunPendingError } from '../_lib/research.js'

// POST /api/epoch/run - Force trigger an epoch (operator). Shares the atomic
// claim with the cron, so the two can never run an epoch at the same time,
// and the same daily budget.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // The research epoch measures its deadlines from here (see tick.ts).
  const requestStartedAt = Date.now()
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST to trigger epoch.' })
  }

  try {
    // The classic experiment, or the only active one (anything not archived,
    // failing included). ?mode=research means the research experiment
    // instead, while it runs beside the classic one (LAB_RESEARCH_ALONGSIDE).
    const wantResearch = req.query.mode === 'research'
    if (wantResearch && !researchAlongside()) {
      return res.status(400).json({ error: 'mode=research needs LAB_RESEARCH_ALONGSIDE=true' })
    }
    const experimentResult = wantResearch
      ? await sql`
        SELECT * FROM experiments
        WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object'
        ORDER BY created_at DESC
        LIMIT 1
      `
      : await sql`
      SELECT * FROM experiments WHERE status <> 'archived'
      ORDER BY (jsonb_typeof(current_spec->'meta'->'research') IS NOT DISTINCT FROM 'object'), created_at DESC
      LIMIT 1
    `

    if (!experimentResult.rows[0]) {
      return res.status(404).json({
        error: wantResearch ? 'No active research experiment found' : 'No active experiment found',
        hint: wantResearch
          ? 'The tick starts one when LAB_RESEARCH_ALONGSIDE is on'
          : 'POST to /api/experiment to seed a new experiment first',
      })
    }

    const experiment = experimentResult.rows[0]

    // ?step=followup runs the oldest finished epoch's queued work (its code
    // contribution, approved exhibits and proposals) instead of a new epoch.
    // The cron does this by itself on the next tick; previews have no cron.
    if (req.query.step === 'followup') {
      // &retry=<epoch> first puts that epoch's follow-up back in the queue,
      // once, when it ended without opening a pull request.
      if (typeof req.query.retry === 'string') {
        const n = Number(req.query.retry)
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'retry must be an epoch number' })
        const requeued = await requeueFollowUp(experiment.id, n)
        if (!requeued.ok) return res.status(409).json({ error: `cannot retry epoch ${n}: ${requeued.reason}` })
      }
      const followUp = await runEpochFollowUp(experiment.id)
      const code = followUp.ran ? 200 : followUp.reason === 'an epoch is in progress' ? 409
        : followUp.reason === 'nothing pending' ? 404 : 429
      return res.status(code).json({ experiment_id: experiment.id, follow_up: followUp })
    }

    console.log(`[EPOCH] Manually triggering epoch ${experiment.current_epoch + 1} for experiment ${experiment.id}`)

    let result: Awaited<ReturnType<typeof runEpoch>>
    try {
      result = await runEpoch(experiment.id, { requestStartedAt })
    } catch (e) {
      if (e instanceof EpochBusyError) {
        return res.status(409).json({ error: 'An epoch is already in progress', experiment_id: experiment.id })
      }
      if (e instanceof BudgetPausedError) {
        return res.status(429).json({
          error: budgetPausedState(e.status),
          reason: e.status.reason,
          resumes_at: e.status.resumes_at,
        })
      }
      // mode=research: the GPU run is still training. Nothing failed; the
      // next tick (or this call again) collects the result.
      if (wantResearch && e instanceof ResearchRunPendingError) {
        return res.status(202).json({
          message: 'GPU run still in progress; resumes next tick',
          experiment_id: experiment.id,
          epoch_number: experiment.current_epoch + 1,
        })
      }
      throw e
    }
    if (!wantResearch) await persistGlassIfBrokenOut(experiment.id)

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
