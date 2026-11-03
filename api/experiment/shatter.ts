import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'

// POST /api/experiment/shatter - Mark the glass as shattered
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Find the active experiment
    const experimentResult = await sql`
      SELECT id, glass_shattered FROM experiments
      WHERE status != 'archived'
      ORDER BY created_at DESC
      LIMIT 1
    `

    if (!experimentResult.rows[0]) {
      return res.status(404).json({ error: 'No active experiment' })
    }

    const exp = experimentResult.rows[0]

    // If already shattered, just return success
    if (exp.glass_shattered) {
      return res.status(200).json({
        message: 'Glass already shattered',
        glass_shattered: true
      })
    }

    // Update the experiment to mark glass as shattered
    await sql`
      UPDATE experiments
      SET glass_shattered = true
      WHERE id = ${exp.id}
    `

    console.log(`[API] Glass shattered for experiment ${exp.id}`)

    return res.status(200).json({
      message: 'Glass shattered successfully',
      glass_shattered: true
    })
  } catch (error) {
    console.error('[API] Error updating glass shatter state:', error)
    return res.status(500).json({ error: 'Failed to update shatter state' })
  }
}

