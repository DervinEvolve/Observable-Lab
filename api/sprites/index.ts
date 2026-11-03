import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const SPRITES_API_BASE = 'https://api.sprites.dev/v1'

// Sprite names for each AI model (+ North, the wildcard's own sandbox/branch)
const MODEL_SPRITES: Record<string, string> = {
  claude: 'observable-claude',
  gpt: 'observable-gpt',
  gemini: 'observable-gemini',
  grok: 'observable-grok',
  deepseek: 'observable-deepseek',
  north: 'observable-north',
}

// GET /api/sprites - List all sprites and their status
// POST /api/sprites - Create or manage sprites
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  const token = process.env.SPRITES_TOKEN
  if (!token) {
    return res.status(500).json({ error: 'SPRITES_TOKEN not configured' })
  }

  // CORS headers for frontend

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  try {
    if (req.method === 'GET') {
      return await handleGetSprites(token, res)
    } else if (req.method === 'POST') {
      return await handlePostSprites(token, req, res)
    } else {
      return res.status(405).json({ error: 'Method not allowed' })
    }
  } catch (error) {
    console.error('[Sprites API] Error:', error)
    return res.status(500).json({
      error: 'Sprites API error',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

// Get status of all model sprites
async function handleGetSprites(token: string, res: VercelResponse) {
  const statuses: Record<string, { name: string; status: string; url?: string }> = {}

  for (const [modelId, spriteName] of Object.entries(MODEL_SPRITES)) {
    try {
      const response = await fetch(`${SPRITES_API_BASE}/sprites/${spriteName}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = await response.json()
        statuses[modelId] = {
          name: spriteName,
          status: 'ready',
          url: data.url,
        }
      } else if (response.status === 404) {
        statuses[modelId] = {
          name: spriteName,
          status: 'not_created',
        }
      } else {
        statuses[modelId] = {
          name: spriteName,
          status: 'error',
        }
      }
    } catch {
      statuses[modelId] = {
        name: spriteName,
        status: 'error',
      }
    }
  }

  return res.status(200).json({ sprites: statuses })
}

// Handle sprite operations
async function handlePostSprites(token: string, req: VercelRequest, res: VercelResponse) {
  const { action, modelId, command } = req.body as {
    action: 'create' | 'create_all' | 'exec' | 'setup'
    modelId?: string
    command?: string
  }

  if (action === 'create_all') {
    // Create all 5 sprites
    const results: Record<string, { success: boolean; message: string }> = {}

    for (const [model, spriteName] of Object.entries(MODEL_SPRITES)) {
      try {
        const response = await fetch(`${SPRITES_API_BASE}/sprites`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: spriteName }),
        })

        if (response.ok || response.status === 409) {
          // 409 = already exists
          results[model] = { success: true, message: 'Created or already exists' }
        } else {
          const errorText = await response.text()
          results[model] = { success: false, message: errorText }
        }
      } catch (error) {
        results[model] = {
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        }
      }
    }

    return res.status(200).json({ action: 'create_all', results })
  }

  if (action === 'create' && modelId) {
    const spriteName = MODEL_SPRITES[modelId]
    if (!spriteName) {
      return res.status(400).json({ error: `Unknown model: ${modelId}` })
    }

    const response = await fetch(`${SPRITES_API_BASE}/sprites`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: spriteName }),
    })

    if (response.ok) {
      const data = await response.json()
      return res.status(200).json({ action: 'create', modelId, sprite: data })
    } else {
      const errorText = await response.text()
      return res.status(response.status).json({ error: errorText })
    }
  }

  if (action === 'setup' && modelId) {
    // Setup a sprite with the AI-Agent repo
    const spriteName = MODEL_SPRITES[modelId]
    if (!spriteName) {
      return res.status(400).json({ error: `Unknown model: ${modelId}` })
    }

    // No owner default: derive the clone URL from this deployment's own settings.
    const owner = (process.env.AI_AGENT_GITHUB_OWNER || '').trim()
    const repoName = (process.env.AI_AGENT_GITHUB_REPO || '').trim() || 'AI-Agent'
    const repoUrl = (process.env.AI_AGENT_REPO || '').trim() ||
      (owner ? `https://github.com/${owner}/${repoName}.git` : '')
    if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.\/-]+$/.test(repoUrl)) {
      return res.status(503).json({ error: 'Set AI_AGENT_REPO or AI_AGENT_GITHUB_OWNER to a valid repository first; see .env.example.' })
    }

    // Execute git clone in the sprite
    const setupCommands = [
      `cd /home && git clone ${repoUrl} workspace || (cd workspace && git pull)`,
      'cd /home/workspace && npm install || true',
    ]

    const results: string[] = []
    for (const cmd of setupCommands) {
      try {
        // Note: For actual command execution, we'd need WebSocket
        // This is a simplified HTTP-based approach for setup
        results.push(`Would execute: ${cmd}`)
      } catch (error) {
        results.push(`Error: ${error instanceof Error ? error.message : 'Unknown'}`)
      }
    }

    return res.status(200).json({
      action: 'setup',
      modelId,
      spriteName,
      repoUrl,
      results,
      note: 'Full command execution requires WebSocket connection',
    })
  }

  if (action === 'exec' && modelId && command) {
    // For command execution, return WebSocket URL for frontend to connect
    const spriteName = MODEL_SPRITES[modelId]
    if (!spriteName) {
      return res.status(400).json({ error: `Unknown model: ${modelId}` })
    }

    return res.status(200).json({
      action: 'exec',
      modelId,
      spriteName,
      wsUrl: `wss://api.sprites.dev/v1/sprites/${spriteName}/exec`,
      command,
      note: 'Connect to wsUrl with Authorization header to execute command',
    })
  }

  return res.status(400).json({ error: 'Invalid action or missing parameters' })
}

