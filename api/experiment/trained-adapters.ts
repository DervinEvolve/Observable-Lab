import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { keepAdapter, keepOverview, removeAdapterName, unkeepAdapter } from '../_lib/tinker-keep.js'
import { KEEP_REASON_MAX, keepSlugOf } from '../_lib/tinker-keep-request.js'

// The owner's side of keeping trained adapters (docs/TOOLS.md, "Keeping a
// trained adapter"). Operator only: Authorization: Bearer LAB_OPERATOR_SECRET,
// like the other operator routes. Nothing here is public.
//
// GET  /api/experiment/trained-adapters
//      Every adapter that is alive, which are kept, by whom and why, and how
//      many of the LAB_TINKER_KEEP_MAX places are taken.
//
// POST /api/experiment/trained-adapters?confirm=true
//      { "action": "keep", "adapter": "lab/e41-0a1b2c3d", "reason": "one line" (optional) }
//        Marks an adapter to keep. Needs LAB_ENABLE_TINKER_KEEP. It counts
//        against LAB_TINKER_KEEP_MAX like a model's keep does.
//      { "action": "unkeep", "adapter": "lab/e41-0a1b2c3d", "remove_copy": true | false (optional) }
//        Takes the mark off again. Only this route can. It works with the
//        switch off as well, so a keep can always be undone. The copy on the
//        Volume stays unless remove_copy is true.
//      { "action": "clear_name", "adapter": "lab/e41-0a1b2c3d" }
//        Takes an adapter's display name away. The adapter itself is not touched.
//
// Every change is stored in tool_runs, under the adapter's own epoch.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method === 'GET') {
    try {
      return res.status(200).json(await keepOverview())
    } catch (e) {
      console.error('[trained-adapters] could not read the adapters:', e instanceof Error ? e.message : e)
      return res.status(500).json({ error: 'Could not read the adapters' })
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' })
  if (req.query.confirm !== 'true') return res.status(400).json({ error: 'Pass ?confirm=true to change anything.' })

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}
  const slug = keepSlugOf(body.adapter)
  if (!slug) return res.status(400).json({ error: 'adapter must be the lab id of a trained adapter, like lab/e41-0a1b2c3d' })

  try {
    if (body.action === 'keep') {
      if (body.reason !== undefined && typeof body.reason !== 'string') return res.status(400).json({ error: 'reason must be one line of text' })
      const reason = (typeof body.reason === 'string' ? body.reason : '').replace(/\s+/g, ' ').trim() || 'kept by the owner'
      if (reason.length > KEEP_REASON_MAX) return res.status(400).json({ error: `reason may be at most ${KEEP_REASON_MAX} characters` })
      const outcome = await keepAdapter({ slug, reason }, { by: 'owner' })
      // "started": the runner is still working and the hourly check collects it. "skipped": refused, nothing changed.
      const code = outcome.status === 'ok' ? 200 : outcome.status === 'started' ? 202 : outcome.status === 'skipped' ? 409 : 502
      return res.status(code).json({ adapter: `lab/${slug}`, status: outcome.status === 'skipped' ? 'refused' : outcome.status, message: outcome.summary })
    }
    if (body.action === 'unkeep') {
      if (body.remove_copy !== undefined && typeof body.remove_copy !== 'boolean') return res.status(400).json({ error: 'remove_copy must be true or false' })
      const outcome = await unkeepAdapter(slug, { removeCopy: body.remove_copy === true })
      const code = outcome.ok ? 200 : outcome.status === 'not_kept' ? 404 : outcome.status === 'pending' ? 409 : 502
      return res.status(code).json({ adapter: `lab/${slug}`, ...outcome })
    }
    if (body.action === 'clear_name') {
      const outcome = await removeAdapterName(slug)
      return res.status(outcome.ok ? 200 : 404).json({ adapter: `lab/${slug}`, ...outcome })
    }
    return res.status(400).json({ error: 'action must be keep, unkeep or clear_name' })
  } catch (e) {
    console.error('[trained-adapters] failed:', e instanceof Error ? e.message : e)
    return res.status(500).json({ error: 'The change could not be made' })
  }
}
