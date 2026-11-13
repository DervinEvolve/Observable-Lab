import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  SPRITE_KEYS,
  deleteSprite,
  ensureSprite,
  execInSprite,
  getSpriteStatus,
  sanitizeOutput,
  setupSprite,
  spriteKeyForModel,
  spriteName,
  spritesConfigured,
  tailBytes,
  type SpriteKey,
} from '../_lib/sprites.js'

// Operator-only management of the per-model sprites (observable-<key> for
// gemini, deepseek, claude, gpt, grok, north and glm).
//
// GET  /api/sprites                                   status of every sprite
// POST /api/sprites {action:'create', modelId}        create (or reuse) one, apply the network policy
// POST /api/sprites {action:'create_all'}             the same for all of them
// POST /api/sprites {action:'setup', modelId}         clone or update AI-Agent in /home/sprite/AI-Agent, npm ci
// POST /api/sprites {action:'exec', modelId, command} run one shell command (60 s limit), JSON result
// POST /api/sprites {action:'delete', modelId}        delete one sprite
//
// modelId is a sprite key ("claude", "north", ...) or an OpenRouter model id.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (!spritesConfigured()) {
    return res.status(503).json({ error: 'SPRITES_TOKEN is not set' })
  }

  try {
    if (req.method === 'GET') {
      const statuses = await Promise.all(SPRITE_KEYS.map(key => getSpriteStatus(key)))
      return res.status(200).json({
        sprites: Object.fromEntries(statuses.map(s => [s.key, { name: s.name, status: s.status, ...(s.detail ? { detail: sanitizeOutput(s.detail) } : {}) }])),
      })
    }
    if (req.method === 'POST') {
      return await handlePost(req, res)
    }
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    const details = sanitizeOutput(error instanceof Error ? error.message : 'Unknown error')
    console.error('[Sprites API] Error:', details)
    return res.status(502).json({ error: 'Sprites API error', details })
  }
}

function resolveKey(modelId: unknown): SpriteKey | null {
  return typeof modelId === 'string' && modelId.length <= 120 ? spriteKeyForModel(modelId) : null
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    action?: unknown
    modelId?: unknown
    command?: unknown
  }
  const action = body.action

  if (action === 'create_all') {
    const results: Record<string, { success: boolean; status?: string; created?: boolean; message?: string }> = {}
    for (const key of SPRITE_KEYS) {
      try {
        const info = await ensureSprite(key)
        results[key] = { success: true, status: info.status, created: info.created }
      } catch (error) {
        results[key] = { success: false, message: sanitizeOutput(error instanceof Error ? error.message : 'Unknown error') }
      }
    }
    return res.status(200).json({ action, results })
  }

  const key = resolveKey(body.modelId)
  if (!key) {
    return res.status(400).json({ error: 'modelId must be one of ' + SPRITE_KEYS.join(', ') + ' or a model id from those labs' })
  }

  if (action === 'create') {
    const info = await ensureSprite(key)
    return res.status(200).json({ action, modelId: key, sprite: info })
  }

  if (action === 'setup') {
    const result = await setupSprite(key)
    return res.status(200).json({
      action,
      modelId: key,
      spriteName: result.sprite,
      exitCode: result.exitCode,
      ok: result.exitCode === 0,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      output: result.output,
    })
  }

  if (action === 'exec') {
    if (typeof body.command !== 'string' || !body.command.trim() || body.command.length > 4000) {
      return res.status(400).json({ error: 'command must be a non-empty string of at most 4000 characters' })
    }
    const result = await execInSprite(key, body.command, { dir: '/home/sprite', timeoutS: 50 })
    return res.status(200).json({
      action,
      modelId: key,
      spriteName: spriteName(key),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      output: sanitizeOutput(tailBytes(result.output, 16 * 1024)),
    })
  }

  if (action === 'delete') {
    await deleteSprite(key)
    return res.status(200).json({ action, modelId: key, spriteName: spriteName(key) })
  }

  return res.status(400).json({ error: 'Invalid action or missing parameters' })
}
