import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleScoring } from '../_lib/scoring.js'

// GET /api/experiment/scoring
//
// How the lab scores results, as public JSON: the research loop's margin,
// measured noise and last verdict (only with LAB_RESEARCH_CONFIRM on), and
// the Tinker runs by where their training examples came from (only with
// LAB_TINKER_ORIGIN_LABELS on). Public and read-only, like the other
// observer endpoints. With both switches off it says so and reads nothing.
// See api/_lib/scoring.ts.
export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleScoring(req, res)
}
