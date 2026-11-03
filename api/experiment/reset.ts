import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { getRoleAssignments } from '../_lib/role-rotation.js'
import { generateSeedPlant } from '../_lib/plant-generator.js'
import { SEED_SPECIFICATION, RESEARCH_SEED_SPECIFICATION } from '../_lib/seed-spec.js'

// POST /api/experiment/reset?confirm=true — admin: archive any active experiment
// and seed a brand-new one at epoch 0. Also patches schema drift (missing
// glass_shattered column) so it doesn't block future runs.
// Pass &mode=research to seed the autonomous ML research lab instead of the
// classic spec-growing experiment.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  }
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'Pass ?confirm=true to actually reset the experiment.' })
  }
  const seed = req.query.mode === 'research' ? RESEARCH_SEED_SPECIFICATION : SEED_SPECIFICATION

  try {
    // Patch schema drift: some deployed DBs predate this column.
    await sql`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS glass_shattered BOOLEAN DEFAULT FALSE`

    const archivedResult = await sql`
      UPDATE experiments
      SET status = 'archived'
      WHERE status IN ('seeding', 'growing', 'stable', 'failing')
      RETURNING id, current_epoch
    `

    const plantGeometry = generateSeedPlant()

    const result = await sql`
      INSERT INTO experiments (status, current_spec, current_epoch)
      VALUES ('seeding', ${JSON.stringify(seed)}, 0)
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

    return res.status(200).json({
      success: true,
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

