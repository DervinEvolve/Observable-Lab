import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import type { AgentSpecification } from '../_lib/types.js'

// POST /api/experiment/patch-research?confirm=true
// Admin: re-baseline the ACTIVE research experiment in place (e.g. after a
// dataset switch) without archiving it. Body: { baseline_bpb, note? }.
// Sets baseline_bpb AND best_bpb to the given value, best_epoch to the
// current epoch, clears last_run, and drops a system note in the lab
// notebook so the models know history before this point isn't comparable.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'Pass ?confirm=true to actually patch.' })
  }
  const baseline = Number((req.body as Record<string, unknown>)?.baseline_bpb)
  const target = Number((req.body as Record<string, unknown>)?.target_bpb)
  const note = String((req.body as Record<string, unknown>)?.note ?? '')
  if (!isFinite(baseline) || baseline <= 0 || baseline > 10) {
    return res.status(400).json({ error: 'baseline_bpb must be a sane positive number' })
  }
  if (!isFinite(target) || target <= 0 || target >= baseline) {
    return res.status(400).json({ error: 'target_bpb must be positive and below baseline_bpb' })
  }

  try {
    const r = await sql`
      SELECT id, current_epoch, current_spec FROM experiments
      WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1
    `
    const exp = r.rows[0]
    if (!exp) return res.status(404).json({ error: 'no active experiment' })
    const spec = exp.current_spec as AgentSpecification
    if (!spec.meta.research) {
      return res.status(400).json({ error: 'active experiment is not in research mode' })
    }

    const before = { ...spec.meta.research }
    spec.meta.research = {
      ...spec.meta.research,
      baseline_bpb: baseline,
      best_bpb: baseline,
      target_bpb: target,
      best_epoch: exp.current_epoch as number,
      last_run: undefined,
    }

    await sql`
      UPDATE experiments SET current_spec = ${JSON.stringify(spec)} WHERE id = ${exp.id}
    `
    if (note) {
      await sql`
        INSERT INTO lab_notebook (experiment_id, epoch_number, author, note)
        VALUES (${exp.id}, ${exp.current_epoch}, 'System (admin)', ${note.slice(0, 500)})
      `
    }
    return res.status(200).json({ success: true, before, after: spec.meta.research })
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'unknown' })
  }
}

