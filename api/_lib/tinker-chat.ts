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
  | {
    ok: true; httpStatus: number; data: unknown; content: string; finishReason: string
    promptTokens: number; completionTokens: number
    /**
     * Did the answer carry token counts the lab can price? Tinker's endpoint
     * is a beta. An answer with no usable "usage" must not be read as a call
     * that cost nothing: the caller counts the most the call could have cost.
     */
    usageKnown: boolean
  }
  | {
    ok: false
    /**
     * timeout: no answer in time. unreachable: the request failed on the way.
     * upstream: Tinker answered with an error. no_answer: Tinker answered 200
     * with nothing usable in it.
     */
    kind: 'not_configured' | 'timeout' | 'unreachable' | 'upstream' | 'no_answer'
    /**
     * Could Tinker have served (and billed) the call all the same? True
     * unless it is certain the request never arrived or Tinker said no. The
     * caller counts the most the call could have cost when this is true.
     */
    maybeServed: boolean
    httpStatus: number | null
    /** A short cleaned line for the server's own record. Never the key, never a whole body. */
    detail: string
  }

const short = (text: unknown, max = 200): string => sanitizeOutput(typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, max)
/** A token count as Tinker reports one, or null when the field is missing or is not a count. */
const tokens = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

/**
 * Errors that mean no connection was ever made, so nothing was sent. Any
 * other failure (a reset, a socket closed part way) may have come after the
 * request arrived.
 */
const NEVER_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
function neverConnected(e: unknown): boolean {
  for (let err: unknown = e, depth = 0; err && typeof err === 'object' && depth < 4; err = (err as { cause?: unknown }).cause, depth++) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && NEVER_CONNECTED.has(code)) return true
  }
  return false
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

/**
 * What one call is counted at, by the lab's estimate. Measured tokens at the
 * published prices when Tinker reported them. The most the call could have
 * cost (`worstUsd`, what was set aside) when it answered without usable
 * token counts, or failed in a way that does not rule out that it was
 * served. Nothing only when it is certain the call was not served.
 */
export function tinkerChatCharge(answer: TinkerChatResult, measuredUsd: (promptTokens: number, completionTokens: number) => number, worstUsd: number):
  { usd: number; basis: 'measured' | 'worst_case' | 'none' } {
  if (answer.ok) {
    return answer.usageKnown
      ? { usd: measuredUsd(answer.promptTokens, answer.completionTokens), basis: 'measured' }
      : { usd: worstUsd, basis: 'worst_case' }
  }
  return answer.maybeServed ? { usd: worstUsd, basis: 'worst_case' } : { usd: 0, basis: 'none' }
}

/** Sends one call. Never throws. */
export async function callTinkerChat(input: TinkerChatInput): Promise<TinkerChatResult> {
  const key = (process.env.TINKER_API_KEY || '').trim()
  if (!key) return { ok: false, kind: 'not_configured', maybeServed: false, httpStatus: null, detail: 'no Tinker key on this server' }
  if (!isSamplerPath(input.samplerPath)) return { ok: false, kind: 'not_configured', maybeServed: false, httpStatus: null, detail: 'not a saved adapter' }

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
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, kind: 'timeout', maybeServed: true, httpStatus: null, detail: `no answer within ${Math.round(input.timeoutMs / 1000)} s` }
    }
    return neverConnected(e)
      ? { ok: false, kind: 'unreachable', maybeServed: false, httpStatus: null, detail: 'the training service could not be reached' }
      : { ok: false, kind: 'unreachable', maybeServed: true, httpStatus: null, detail: 'the connection to the training service failed part way' }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = ''
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown }
      message = short(typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.detail)
    } catch { /* not JSON */ }
    // An error status is Tinker saying it did not serve the call.
    return { ok: false, kind: 'upstream', maybeServed: false, httpStatus: response.status, detail: message || `HTTP ${response.status}` }
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    return { ok: false, kind: 'no_answer', maybeServed: true, httpStatus: response.status, detail: 'the answer was not JSON' }
  }
  const d = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const choice = Array.isArray(d.choices) && d.choices[0] && typeof d.choices[0] === 'object' ? d.choices[0] as Record<string, unknown> : null
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : null
  if (!choice || !message) return { ok: false, kind: 'no_answer', maybeServed: true, httpStatus: response.status, detail: 'no choices in the answer' }
  const usage = d.usage && typeof d.usage === 'object' ? d.usage as Record<string, unknown> : {}
  const promptTokens = tokens(usage.prompt_tokens)
  const completionTokens = tokens(usage.completion_tokens)
  // A prompt always has tokens, so a count of 0 is as good as none.
  const usageKnown = promptTokens !== null && promptTokens > 0 && completionTokens !== null
  if (!usageKnown) console.warn('[tinker] an answer carried no usable token counts; the most the call could cost is counted')
  return {
    ok: true, httpStatus: response.status, data,
    content: typeof message.content === 'string' ? message.content : '',
    finishReason: choice.finish_reason === 'length' ? 'length' : 'stop',
    promptTokens: usageKnown ? promptTokens ?? 0 : 0, completionTokens: usageKnown ? completionTokens ?? 0 : 0, usageKnown,
  }
}
