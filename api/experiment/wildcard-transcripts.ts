import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'

// GET /api/experiment/wildcard-transcripts?since_epoch=N
// North/GLM's actual dialogue from their side experiments, for the
// experiment-log panel — previously written to a table nothing read.
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
      return res.status(200).json({ transcripts: [] })
    }

    const sinceEpoch = parseInt((req.query.since_epoch as string) || '0', 10)
    const result = await sql`
      SELECT id, epoch_number, speaker, model_id, text, created_at
      FROM transcripts
      WHERE experiment_id = ${experiment.id} AND epoch_number >= ${sinceEpoch}
      ORDER BY created_at DESC
      LIMIT 60
    `
    return res.status(200).json({ transcripts: result.rows })
  } catch (e) {
    // Table may not exist yet (created lazily on North's first persisted run)
    console.warn('[API] wildcard transcripts unavailable:', e instanceof Error ? e.message : e)
    return res.status(200).json({ transcripts: [] })
  }
}
