/**
 * One chat completion from an adapter the lab trained, through Tinker's
 * OpenAI-compatible endpoint. Used by the lab model endpoint ("lab/<name>",
 * live-trained.ts) and by the visitor chat (trained-chat.ts), and by nothing
 * else.
 *
 * This is the only file on this server that reads TINKER_API_KEY. The key
 * goes into the Authorization header of the one request below and nowhere
 * else: not into a log line, a record, a response or an error message. The
 * body sent is built here field by field, and the answer is read field by
 * field, so nothing a caller wrote travels on unread and nothing Tinker
 * answered travels back unread.
 *
 * The model named in the request is the adapter's checkpoint path. Tinker
 * runs it on the base model it was trained on. "reasoning_effort": false
 * asks that base model to answer directly, which is how the adapter was
 * trained (the runner trains without the thinking block).
 */
import { sanitizeOutput } from './sprites.js'
import { isSamplerPath } from './tinker.js'

export const TINKER_CHAT_URL = 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions'

export interface TinkerChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface TinkerChatInput {
  samplerPath: string
  messages: TinkerChatMessage[]
  maxTokens: number
  temperature?: number
  timeoutMs: number
}

export type TinkerChatResult =
  | { ok: true; httpStatus: number; data: unknown; content: string; finishReason: string; promptTokens: number; completionTokens: number }
  | {
    ok: false
    /** timeout: no answer in time, and the call may still have been served. upstream: Tinker answered with an error. */
    kind: 'not_configured' | 'timeout' | 'unreachable' | 'upstream' | 'no_answer'
    httpStatus: number | null
    /** A short cleaned line for the server's own record. Never the key, never a whole body. */
    detail: string
  }

const short = (text: unknown, max = 200): string => sanitizeOutput(typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, max)
const tokens = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** The body sent to Tinker for one call. Exported so a test can see exactly what leaves. */
export function tinkerChatBody(input: TinkerChatInput): Record<string, unknown> {
  return {
    model: input.samplerPath,
    messages: input.messages.map(m => ({ role: m.role, content: m.content })),
    max_completion_tokens: Math.max(1, Math.floor(input.maxTokens)),
    ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
    reasoning_effort: false,
  }
}

/** Sends one call. Never throws. */
export async function callTinkerChat(input: TinkerChatInput): Promise<TinkerChatResult> {
  const key = (process.env.TINKER_API_KEY || '').trim()
  if (!key) return { ok: false, kind: 'not_configured', httpStatus: null, detail: 'no Tinker key on this server' }
  if (!isSamplerPath(input.samplerPath)) return { ok: false, kind: 'not_configured', httpStatus: null, detail: 'not a saved adapter' }

  let response: Response
  try {
    response = await fetch(TINKER_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(tinkerChatBody(input)),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    return name === 'TimeoutError' || name === 'AbortError'
      ? { ok: false, kind: 'timeout', httpStatus: null, detail: `no answer within ${Math.round(input.timeoutMs / 1000)} s` }
      : { ok: false, kind: 'unreachable', httpStatus: null, detail: 'the training service could not be reached' }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = ''
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown }
      message = short(typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.detail)
    } catch { /* not JSON */ }
    return { ok: false, kind: 'upstream', httpStatus: response.status, detail: message || `HTTP ${response.status}` }
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    return { ok: false, kind: 'no_answer', httpStatus: response.status, detail: 'the answer was not JSON' }
  }
  const d = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const choice = Array.isArray(d.choices) && d.choices[0] && typeof d.choices[0] === 'object' ? d.choices[0] as Record<string, unknown> : null
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : null
  if (!choice || !message) return { ok: false, kind: 'no_answer', httpStatus: response.status, detail: 'no choices in the answer' }
  const usage = d.usage && typeof d.usage === 'object' ? d.usage as Record<string, unknown> : {}
  return {
    ok: true, httpStatus: response.status, data,
    content: typeof message.content === 'string' ? message.content : '',
    finishReason: choice.finish_reason === 'length' ? 'length' : 'stop',
    promptTokens: tokens(usage.prompt_tokens), completionTokens: tokens(usage.completion_tokens),
  }
}
