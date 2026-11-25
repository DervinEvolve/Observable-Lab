import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { advanceTutorLessonsDetailed } from '../_lib/tinker-tutor-run.js'
import { TUTOR_SLICE_MS } from '../_lib/tinker-tutor.js'

// GET /api/epoch/lesson - Cron endpoint (every ten minutes) that moves open
// Socratic lessons forward (docs/TOOLS.md, "The Socratic lesson").
//
// Each open lesson, oldest first, is advanced under its lease for one slice:
// the lab's own code asks the small model, the teacher and the training
// runner what the lesson needs next, and stores every answer as it comes.
// With no open lesson this is one query. With the tool switched off and
// nothing configured to run it, no model or runner is called: lessons left
// open too long are closed and their money settled.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now()
  if (!requireBearer(req, res, 'CRON_SECRET')) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const moved = await advanceTutorLessonsDetailed({ deadlineAt: startedAt + TUTOR_SLICE_MS })
  return res.status(200).json({ lessons: moved.map(m => ({ slug: m.slug, stage: m.stage, status: m.status })) })
}
