import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { execInSprite, sanitizeOutput, spriteKeyForModel, spriteName, spritesConfigured, tailBytes, SPRITE_KEYS } from '../_lib/sprites.js'

// POST /api/sprites/exec {modelId, command}  (operator only)
// Runs one shell command in a model's sprite and replies as server-sent
// events, in the shape src/systems/SpritesService.ts reads:
//   {type:'start', command, spriteName} {type:'output', text} {type:'error', text}
//   {type:'exit', exitCode} {type:'done'}
// The Sprites HTTP exec endpoint answers once the command has finished, so
// the output lines arrive together at the end. exitCode is null when no
// trustworthy exit status came back.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!spritesConfigured()) {
    return res.status(503).json({ error: 'SPRITES_TOKEN is not set' })
  }

  const { modelId, command } = (req.body && typeof req.body === 'object' ? req.body : {}) as { modelId?: unknown; command?: unknown }
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) {
    return res.status(400).json({ error: 'command must be a non-empty string of at most 4000 characters' })
  }
  const key = typeof modelId === 'string' && modelId.length <= 120 ? spriteKeyForModel(modelId) : null
  if (!key) {
    return res.status(400).json({ error: 'modelId must be one of ' + SPRITE_KEYS.join(', ') + ' or a model id from those labs' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Connection', 'keep-alive')
  const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`)

  send({ type: 'start', command, spriteName: spriteName(key) })
  try {
    // vercel.json gives this route 60 s; leave room for the HTTP round trip.
    const result = await execInSprite(key, command, { dir: '/home/sprite', timeoutS: 45 })
    const output = sanitizeOutput(tailBytes(result.output, 16 * 1024))
    for (const line of output.split('\n')) send({ type: 'output', text: line })
    if (result.timedOut) send({ type: 'error', text: 'timed out' })
    send({ type: 'exit', exitCode: result.exitCode })
  } catch (error) {
    send({ type: 'error', text: sanitizeOutput(error instanceof Error ? error.message : 'Unknown error') })
  }
  send({ type: 'done' })
  return res.end()
}
