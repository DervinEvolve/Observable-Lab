import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import type { AgentSpecification } from '../_lib/types.js'

// POST /api/experiment/patch-identity?confirm=true
// Body: { purpose?: string, domain?: string }
// Admin one-off: merges the given fields into the active experiment's
// current_spec.identity. Exists because applyMutations silently dropped every
// identity mutation for epochs 0-4 (fixed in epoch-runner.ts) — this backfills
// the value the Reviewer already decided on but never actually took effect.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  }
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'Pass ?confirm=true to actually patch identity.' })
  }

  const { purpose, domain } = req.body as { purpose?: string; domain?: string }
  if (!purpose && domain === undefined) {
    return res.status(400).json({ error: 'Provide at least one of purpose/domain in the request body.' })
  }

  try {
    const experimentResult = await sql`
      SELECT id, current_spec FROM experiments WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1
    `
    const experiment = experimentResult.rows[0]
    if (!experiment) {
      return res.status(404).json({ error: 'No active experiment found' })
    }

    const spec = experiment.current_spec as AgentSpecification
    const newSpec: AgentSpecification = JSON.parse(JSON.stringify(spec))
    if (purpose) newSpec.identity.purpose = purpose
    if (domain !== undefined) newSpec.identity.domain = domain

    await sql`
      UPDATE experiments SET current_spec = ${JSON.stringify(newSpec)} WHERE id = ${experiment.id}
    `

    return res.status(200).json({ success: true, identity: newSpec.identity })
  } catch (error) {
    console.error('[ADMIN] Error patching identity:', error)
    return res.status(500).json({ error: 'Failed to patch identity' })
  }
}

