import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const SPRITES_API_BASE = 'https://api.sprites.dev/v1'

// Sprite names for each AI model
const MODEL_SPRITES: Record<string, string> = {
  claude: 'observable-claude',
  gpt: 'observable-gpt',
  gemini: 'observable-gemini',
  grok: 'observable-grok',
  deepseek: 'observable-deepseek',
}

// POST /api/sprites/exec - Execute command with streaming output
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireBearer(req, res)) return

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const token = process.env.SPRITES_TOKEN
  if (!token) {
    return res.status(500).json({ error: 'SPRITES_TOKEN not configured' })
  }

  const { modelId, command } = req.body as {
    modelId: string
    command: string
  }

  if (!modelId || !command) {
    return res.status(400).json({ error: 'modelId and command are required' })
  }

  const spriteName = MODEL_SPRITES[modelId]
  if (!spriteName) {
    return res.status(400).json({ error: `Unknown model: ${modelId}` })
  }

  // Set up SSE headers for streaming
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    // Execute command via Sprites HTTP API (non-streaming for now)
    // Sprites.dev uses WebSocket for full streaming, but for simplicity
    // we'll use their HTTP exec endpoint and stream the response
    const execResponse = await fetch(`${SPRITES_API_BASE}/sprites/${spriteName}/exec`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command }),
    })

    if (!execResponse.ok) {
      const errorText = await execResponse.text()
      res.write(`data: ${JSON.stringify({ type: 'error', message: errorText })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      return res.end()
    }

    // Check if response is streaming
    const contentType = execResponse.headers.get('content-type') || ''

    if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
      // Stream the response body
      const reader = execResponse.body?.getReader()
      if (!reader) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'No response body' })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
        return res.end()
      }

      const decoder = new TextDecoder()

      // Send start event
      res.write(`data: ${JSON.stringify({ type: 'start', command, spriteName })}\n\n`)

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const text = decoder.decode(value, { stream: true })
          // Split by lines and send each as an output event
          const lines = text.split('\n')
          for (const line of lines) {
            if (line.length > 0) {
              res.write(`data: ${JSON.stringify({ type: 'output', text: line })}\n\n`)
            }
          }
        }
      } catch (streamError) {
        console.error('[Sprites Exec] Stream error:', streamError)
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted' })}\n\n`)
      }
    } else {
      // JSON response - parse and send
      const data = await execResponse.json()

      res.write(`data: ${JSON.stringify({ type: 'start', command, spriteName })}\n\n`)

      // Handle different response formats
      if (data.output) {
        const lines = String(data.output).split('\n')
        for (const line of lines) {
          res.write(`data: ${JSON.stringify({ type: 'output', text: line })}\n\n`)
        }
      } else if (data.stdout) {
        const lines = String(data.stdout).split('\n')
        for (const line of lines) {
          res.write(`data: ${JSON.stringify({ type: 'output', text: line })}\n\n`)
        }
      }

      if (data.stderr) {
        const lines = String(data.stderr).split('\n')
        for (const line of lines) {
          res.write(`data: ${JSON.stringify({ type: 'error', text: line })}\n\n`)
        }
      }

      if (data.exitCode !== undefined) {
        res.write(`data: ${JSON.stringify({ type: 'exit', code: data.exitCode })}\n\n`)
      }
    }

    // Send done event
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
    return res.end()

  } catch (error) {
    console.error('[Sprites Exec] Error:', error)
    res.write(`data: ${JSON.stringify({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error'
    })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
    return res.end()
  }
}

