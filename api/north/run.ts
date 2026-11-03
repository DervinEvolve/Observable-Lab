import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { runAndPersistNorth } from '../_lib/north-persist.js'
import { generatePlantFromSpec } from '../_lib/plant-generator.js'
import type { AgentSpecification } from '../_lib/types.js'

// POST /api/north/run — trigger one North wildcard experiment for the active experiment.
// North contributes a single green leaf (a behavior tagged source: 'north').
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  }

  try {
    const experimentResult = await sql`
      SELECT * FROM experiments
      WHERE status IN ('seeding', 'growing', 'stable')
      ORDER BY created_at DESC
      LIMIT 1
    `
    const experiment = experimentResult.rows[0]
    if (!experiment) {
      return res.status(404).json({ error: 'No active experiment found' })
    }

    const spec = experiment.current_spec as AgentSpecification

    // Pull the most recent direction for context (best-effort)
    let recentDirection: string | undefined
    try {
      const recent = await sql`
        SELECT planner_output FROM epochs
        WHERE experiment_id = ${experiment.id} AND planner_output IS NOT NULL
        ORDER BY epoch_number DESC LIMIT 1
      `
      recentDirection = (recent.rows[0]?.planner_output as { direction?: string })?.direction
    } catch { /* no epochs yet */ }

    const result = await runAndPersistNorth(experiment.id, spec, experiment.current_epoch as number, recentDirection)

    const newSpec: AgentSpecification = JSON.parse(JSON.stringify(spec))
    newSpec.behaviors.push(result.contribution)

    return res.status(200).json({
      success: true,
      branch: result.branch,
      hypothesis: result.hypothesis,
      tools_used: result.toolsUsed,
      contribution: result.contribution,
      transcript: result.transcript,
      cost_usd: result.cost,
      plant_growth_stage: generatePlantFromSpec(newSpec).growthStage,
      north_leaf_count: newSpec.behaviors.filter(b => b.source === 'north').length,
    })
  } catch (error) {
    console.error('[North] run error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    const safe = ['Model service not configured', 'Model service error', 'Model returned invalid response']
    return res.status(500).json({
      error: safe.some(s => message.includes(s)) ? message : 'North experiment failed',
    })
  }
}

