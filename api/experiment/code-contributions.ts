import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { getRecentContributions } from '../_lib/code-contributions-store.js'

// GET /api/experiment/code-contributions?since_epoch=N
// Real code (files + content) that scientists/wildcards have actually pushed
// to AI-Agent, for the frontend to stream into the matching terminal screen.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const experimentResult = await sql`
      SELECT id FROM experiments WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1
    `
    const experiment = experimentResult.rows[0]
    if (!experiment) {
      return res.status(200).json({ contributions: [] })
    }

    const sinceEpoch = parseInt((req.query.since_epoch as string) || '0', 10)
    const contributions = await getRecentContributions(experiment.id, sinceEpoch)

    return res.status(200).json({ contributions })
  } catch (error) {
    console.error('[API] Error fetching code contributions:', error)
    return res.status(500).json({ error: 'Failed to load code contributions' })
  }
}
