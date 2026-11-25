import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireBearer } from '../_lib/auth.js'
import { readBody } from '../_lib/trained-chat.js'
import { isOfferId, ownerDeleteAllOffers, ownerDeleteOffer, ownerReadOffers } from '../_lib/visitor-offers-store.js'

// POST /api/experiment/visitor-offers   (operator only: Bearer LAB_OPERATOR_SECRET)
//   { "action": "read", "limit": 1..100, "before": "<ISO or YYYY-MM-DD>" }
//       stored offers with their text, newest day first; read_at is set on
//       every row returned, in the same statement, and the public record
//       counts those rows (read_by_owner)
//   { "action": "delete", "id": "<uuid>" }   ?confirm=true   deletes one offer's text
//   { "action": "delete_all" }               ?confirm=true   deletes every offer's text
//
// This is the only way anyone at the lab reads an offer. It is a POST, so a
// prefetch, a retry of a GET or a cache cannot count as a read. There is no
// GET. It works whether offers are switched on or off. No log line here
// carries offered text.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res, 'LAB_OPERATOR_SECRET')) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' })

  let body: unknown
  try {
    body = readBody(req)
  } catch {
    return res.status(400).json({ error: 'The request is not valid JSON.' })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Send a JSON object with "action".' })
  const b = body as Record<string, unknown>
  const only = (keys: string[]) => Object.keys(b).every(k => keys.includes(k))
  const confirmed = req.query?.confirm === 'true'

  try {
    if (b.action === 'read') {
      if (!only(['action', 'limit', 'before'])) return res.status(400).json({ error: 'read takes "limit" and "before" only.' })
      const limit = b.limit === undefined ? 20 : b.limit
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: 'limit must be a whole number from 1 to 100.' })
      let beforeDay: string | null = null
      if (b.before !== undefined && b.before !== null) {
        const m = typeof b.before === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(b.before) : null
        if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return res.status(400).json({ error: 'before must be an ISO date.' })
        beforeDay = m[1]
      }
      const offers = await ownerReadOffers({ limit, beforeDay })
      return res.status(200).json({ offers, count: offers.length })
    }
    if (b.action === 'delete') {
      if (!only(['action', 'id']) || !isOfferId(b.id)) return res.status(400).json({ error: 'delete takes "id", the uuid of one offer.' })
      if (!confirmed) return res.status(400).json({ error: 'Pass ?confirm=true to delete.' })
      return res.status(200).json({ deleted: await ownerDeleteOffer(b.id) ? 1 : 0 })
    }
    if (b.action === 'delete_all') {
      if (!only(['action'])) return res.status(400).json({ error: 'delete_all takes nothing else.' })
      if (!confirmed) return res.status(400).json({ error: 'Pass ?confirm=true to delete the text of every offer.' })
      return res.status(200).json({ deleted: await ownerDeleteAllOffers() })
    }
    return res.status(400).json({ error: 'action must be read, delete or delete_all.' })
  } catch {
    console.warn('[visitor-offers] the operator request failed')
    return res.status(503).json({ error: 'The database is not available.' })
  }
}
