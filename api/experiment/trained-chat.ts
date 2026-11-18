import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleTrainedChat } from '../_lib/trained-chat.js'

// The visitor chat with adapters the lab's models trained on Tinker.
// Off unless LAB_ENABLE_TRAINED_CHAT is "true".
//
// GET  /api/experiment/trained-chat   the adapters that can be talked to
// POST /api/experiment/trained-chat   { adapter, messages } -> { reply }
//
// Public, like the other observer endpoints, and the only one that spends
// money, so it is held to a visitor rate limit and its own small daily cap.
// See api/_lib/trained-chat.ts.
export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleTrainedChat(req, res)
}
