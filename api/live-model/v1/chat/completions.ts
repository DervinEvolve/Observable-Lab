import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleLiveModel } from '../../../_lib/live-model-handler.js'

// The lab model endpoint, in the OpenAI shape, for a model's own Sprite
// session. Off unless LAB_ENABLE_LIVE_MODEL is "true" (503 otherwise).
//
// POST /api/live-model/v1/chat/completions   one non-streaming chat completion
// GET  /api/live-model/v1/models             the models it answers for
//                                            (vercel.json rewrites this path here)
//
// Authorised by a scoped key the lab makes for one Sprite session and passes
// in as LAB_MODEL_API_KEY: "Authorization: Bearer <key>". It is not a public
// route and not an operator route. See api/_lib/live-model.ts.
export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleLiveModel(req, res)
}
