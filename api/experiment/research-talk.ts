import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleResearchTalk } from '../_lib/research-talk.js'

// A short story from the research loop's best kept model.
// Off unless LAB_ENABLE_RESEARCH_TALK is "true".
//
// GET  /api/experiment/research-talk   the model that can be asked, and the limits
// POST /api/experiment/research-talk   { prompt } -> { story }
//
// Public, like the other observer endpoints. It starts a small sandbox on
// Modal for each story, so it is held to a visitor rate limit and a number
// of stories a day. See api/_lib/research-talk.ts.
export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleResearchTalk(req, res)
}
