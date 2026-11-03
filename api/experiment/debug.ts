import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'

// GET /api/experiment/debug - Debug endpoint to check database state
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Get all experiments (not just active ones)
    const experimentsResult = await sql`
      SELECT id, status, current_epoch, created_at, glass_shattered
      FROM experiments
      ORDER BY created_at DESC
      LIMIT 10
    `

    // Get epoch counts per experiment
    const epochsResult = await sql`
      SELECT experiment_id, COUNT(*) as epoch_count, MAX(epoch_number) as max_epoch
      FROM epochs
      GROUP BY experiment_id
    `

    // Get total epochs
    const totalEpochsResult = await sql`
      SELECT COUNT(*) as total FROM epochs
    `

    return res.status(200).json({
      experiments: experimentsResult.rows,
      epoch_stats: epochsResult.rows,
      total_epochs: totalEpochsResult.rows[0]?.total || 0,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[DEBUG] Error:', error)
    return res.status(500).json({
      error: 'Database query failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

