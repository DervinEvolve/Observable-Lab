import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { getRoleAssignments } from '../_lib/role-rotation.js'
import { generateSeedPlant } from '../_lib/plant-generator.js'
import { SEED_SPECIFICATION, RESEARCH_SEED_SPECIFICATION } from '../_lib/seed-spec.js'
import { ensureEpochLogsTable } from '../_lib/research-logger.js'
import { ensureSpendTable } from '../_lib/spend.js'
import { researchAlongside } from '../_lib/experiment-modes.js'

// POST /api/experiment/reset?confirm=true&mode=classic|research (operator)
// Archives every active experiment and seeds a brand-new one at epoch 0.
// mode=classic (the default) grows the agent specification; mode=research
// seeds the autonomous ML research lab instead. Also patches schema drift
// and creates the run 2 tables, so they exist before the first epoch.
//
// While LAB_RESEARCH_ALONGSIDE is on, mode=research is refused: a research
// experiment seeded at epoch 0 would write epoch 1 again into a results.tsv
// and a wiki that already have one, and it would end the classic experiment
// too. With the flag on the tick is what starts research (it carries on from
// the archived experiment).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  }
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'Pass ?confirm=true to actually reset the experiment.' })
  }
  const mode = req.query.mode === undefined || req.query.mode === '' ? 'classic' : req.query.mode
  if (mode !== 'classic' && mode !== 'research') {
    return res.status(400).json({ error: 'mode must be classic or research.' })
  }
  if (mode === 'research' && researchAlongside()) {
    return res.status(409).json({
      error: 'mode=research is refused while LAB_RESEARCH_ALONGSIDE is on',
      hint: 'The tick brings the research experiment back and carries on its epoch numbers. This reset would archive the classic experiment and start research again at epoch 0, on top of the existing results.tsv rows and wiki pages. To really start a new research record, turn the flag off first.',
    })
  }
  const seed = mode === 'research' ? RESEARCH_SEED_SPECIFICATION : SEED_SPECIFICATION

  try {
    // Patch schema drift: some deployed DBs predate these columns.
    await sql`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS glass_shattered BOOLEAN DEFAULT FALSE`
    await sql`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS epoch_started_at TIMESTAMP WITH TIME ZONE`
    await ensureEpochLogsTable()
    await ensureSpendTable()

    // Archive everything that is not archived yet. Clearing the flag keeps a
    // stale claim from following the old run; an epoch still running on it
    // finishes into the archived row and cannot un-archive it (the runners'
    // final updates skip archived experiments).
    const archivedResult = await sql`
      UPDATE experiments
      SET status = 'archived', epoch_in_progress = FALSE, epoch_started_at = NULL
      WHERE status <> 'archived'
      RETURNING id, current_epoch
    `

    const plantGeometry = generateSeedPlant()

    const result = await sql`
      INSERT INTO experiments (status, current_spec, current_epoch, epoch_in_progress, glass_shattered)
      VALUES ('seeding', ${JSON.stringify(seed)}, 0, FALSE, FALSE)
      RETURNING id
    `
    const experimentId = result.rows[0].id

    await sql`
      INSERT INTO epochs (
        experiment_id, epoch_number, role_assignments,
        spec_before, spec_after, plant_geometry, completed_at
      )
      VALUES (
        ${experimentId}, 0, ${JSON.stringify(getRoleAssignments(0))},
        ${JSON.stringify(seed)}, ${JSON.stringify(seed)},
        ${JSON.stringify(plantGeometry)}, NOW()
      )
    `

    console.log(`[ADMIN] Reset: archived ${archivedResult.rows.length} experiment(s), seeded ${mode} experiment ${experimentId}`)
    return res.status(200).json({
      success: true,
      mode,
      archived: archivedResult.rows,
      new_experiment_id: experimentId,
    })
  } catch (error) {
    console.error('[ADMIN] Error resetting experiment:', error)
    return res.status(500).json({
      error: 'Failed to reset experiment',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
