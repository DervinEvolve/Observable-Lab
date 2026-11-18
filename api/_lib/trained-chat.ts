/**
 * The visitor chat with adapters the lab's models trained
 * (docs/TOOLS.md, "Talking to a trained adapter").
 *
 *   GET  /api/experiment/trained-chat   the adapters that can be talked to, and the limits
 *   POST /api/experiment/trained-chat   { adapter, messages } -> { reply }
 *
 * Public, and off unless LAB_ENABLE_TRAINED_CHAT is "true" and this server
 * has a Tinker key. While it is off, GET says so and POST answers 503, and
 * neither touches the database or the network.
 *
 * Anyone can call this, so everything about a call is bounded here: how long
 * a message may be, how many turns a conversation may have, how long the
 * answer may be, how many messages one visitor may send in ten minutes and
 * in a day, and how much all visitor chat may cost in a day
 * (LAB_TINKER_CHAT_DAILY_USD, counted inside LAB_TINKER_DAILY_USD and the
 * lab's own daily budget). The cost is an estimate from Tinker's published
 * prices, set aside before the call and settled after it.
 *
 * A visitor is remembered only as a keyed hash that changes every day
 * (tinker-store.ts). What a visitor writes is sent to Tinker to be answered
 * and is not stored or logged by the lab: a call leaves a row of counts.
 * The replies come from a small model fine-tuned on data the lab's models
 * wrote, and nobody reviews them; the room says so beside the chat.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { checkDailyBudget, recordModelCall, withSpendContext } from './spend.js'
import { sanitizeOutput } from './sprites.js'
import {
  isAdapterSlug, tinkerChatCostUsd, tinkerChatDailyUsd, tinkerChatWorstCaseUsd, tinkerDailyUsd, trainedChatFlag, trainedChatStatus,
} from './tinker.js'
import { callTinkerChat, type TinkerChatMessage } from './tinker-chat.js'
import {
  countVisitorMessage, getAdapter, listAdapters, pruneVisitorCounts, recordTrainedChatCall, reserveTinkerSpend, settleTinkerSpend, utcDay,
  visitorHash, type Reservation,
} from './tinker-store.js'

export const TRAINED_CHAT_PURPOSE = 'trained_chat'
/** One message a visitor writes, in characters. */
export const TRAINED_CHAT_MAX_MESSAGE_CHARS = 500
/** Turns (visitor messages) in one conversation. */
export const TRAINED_CHAT_MAX_TURNS = 8
/** Tokens in one reply, and the characters of it that are returned. */
export const TRAINED_CHAT_MAX_TOKENS = 200
export const TRAINED_CHAT_MAX_REPLY_CHARS = 1200
export const TRAINED_CHAT_TEMPERATURE = 0.7
/** Messages one visitor may send: in a ten minute window, and in a UTC day. */
export const TRAINED_CHAT_PER_WINDOW = 10
export const TRAINED_CHAT_WINDOW_S = 600
export const TRAINED_CHAT_PER_DAY = 40
export const TRAINED_CHAT_MAX_BODY_BYTES = 16 * 1024
export const TRAINED_CHAT_TIMEOUT_MS = 45_000

/** Shown beside the chat. Plain, and no dashes. */
export const TRAINED_CHAT_NOTICE = 'A small model fine-tuned by the lab\'s AI models on data they wrote. Replies are not reviewed.'

const MESSAGES = {
  off: 'The chat with trained models is switched off.',
  budget: 'The lab has used today\'s small budget for visitor chats. It opens again at 00:00 UTC.',
  rate: 'That is a lot of messages in a short time. Give it a few minutes and try again.',
  day: 'You have reached today\'s message limit. It starts again at 00:00 UTC.',
  turns: `This conversation has reached its ${TRAINED_CHAT_MAX_TURNS} turns. Start a new one to keep going.`,
  gone: 'That model is no longer kept. Trained models expire after a while.',
  busy: 'The model did not answer this time. Please try again in a moment.',
  unavailable: 'The chat is not available just now. Please try again later.',
}

function say(res: VercelResponse, status: number, error: string, message: string) {
  return res.status(status).json({ error, message })
}

export type ChatRefusal = { ok: false; status: number; error: string; message: string }
export interface ChatRequest { ok: true; adapter: string; messages: TinkerChatMessage[]; turns: number; chars: number }

/**
 * Reads what a visitor's browser sent. Strict: an object with "adapter" and
 * "messages" and nothing else; messages alternate user and assistant,
 * starting and ending with the visitor; no system message.
 */
export function readChatRequest(raw: unknown): ChatRequest | ChatRefusal {
  const bad = (message: string, error = 'invalid_request'): ChatRefusal => ({ ok: false, status: 400, error, message })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Send a JSON object with "adapter" and "messages".')
  const req = raw as Record<string, unknown>
  if (Object.keys(req).some(k => k !== 'adapter' && k !== 'messages')) return bad('Only "adapter" and "messages" are accepted.')
  if (!isAdapterSlug(req.adapter)) return bad('"adapter" must be the name of a trained model from the list.')
  const list = req.messages
  if (!Array.isArray(list) || list.length === 0) return bad('"messages" must be a non-empty list.')
  if (list.length > TRAINED_CHAT_MAX_TURNS * 2 - 1) return { ok: false, status: 400, error: 'turns', message: MESSAGES.turns }
  const messages: TinkerChatMessage[] = []
  let chars = 0
  for (const [i, m] of list.entries()) {
    const o = m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : null
    const role = i % 2 === 0 ? 'user' : 'assistant'
    if (!o || Object.keys(o).some(k => k !== 'role' && k !== 'content') || o.role !== role) {
      return bad('Messages must alternate "user" and "assistant", starting and ending with "user".')
    }
    if (typeof o.content !== 'string' || !o.content.trim()) return bad('Every message needs some text.')
    const limit = role === 'user' ? TRAINED_CHAT_MAX_MESSAGE_CHARS : TRAINED_CHAT_MAX_REPLY_CHARS
    if (o.content.length > limit) {
      return bad(role === 'user' ? `A message may be at most ${TRAINED_CHAT_MAX_MESSAGE_CHARS} characters.` : 'An earlier reply in the conversation is longer than a reply can be.', 'too_long')
    }
    // eslint-disable-next-line no-control-regex
    const content = o.content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    chars += content.length
    messages.push({ role, content })
  }
  if (messages.length % 2 !== 1) return bad('Messages must alternate "user" and "assistant", starting and ending with "user".')
  return { ok: true, adapter: req.adapter, messages, turns: (messages.length + 1) / 2, chars }
}

function header(req: VercelRequest, name: string): string {
  const v = req.headers?.[name]
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : ''
}

/** The visitor's address as the platform reports it. Used for the hash only; never stored or logged. */
function visitorAddress(req: VercelRequest): string {
  const real = header(req, 'x-real-ip').trim()
  if (real) return real.slice(0, 80)
  return header(req, 'x-forwarded-for').split(',')[0].trim().slice(0, 80) || 'unknown'
}

function sentAsJson(req: VercelRequest): boolean {
  // application/json only. A page on another site cannot send that from a
  // visitor's browser without a preflight, which this route does not answer.
  return header(req, 'content-type').split(';')[0].trim().toLowerCase() === 'application/json'
}

function readBody(req: VercelRequest): unknown {
  const body = (req as { body?: unknown }).body
  if (typeof body === 'string') return JSON.parse(body)
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'))
  return body
}

export const chatLimits = () => ({
  max_message_chars: TRAINED_CHAT_MAX_MESSAGE_CHARS, max_turns: TRAINED_CHAT_MAX_TURNS, max_reply_tokens: TRAINED_CHAT_MAX_TOKENS,
})

export async function handleTrainedChat(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const status = trainedChatStatus()
  if (req.method === 'GET') {
    if (!status.enabled) return res.status(200).json({ enabled: false, adapters: [] })
    try {
      const adapters = (await listAdapters()).map(t => t.adapter)
      return res.status(200).json({ enabled: true, adapters, limits: chatLimits(), notice: TRAINED_CHAT_NOTICE })
    } catch (e) {
      console.warn('[trained-chat] could not list adapters:', e instanceof Error ? e.message : e)
      return res.status(200).json({ enabled: true, adapters: [], limits: chatLimits(), notice: TRAINED_CHAT_NOTICE, unavailable: true })
    }
  }

  if (!status.enabled) return say(res, 503, 'off', trainedChatFlag() ? MESSAGES.unavailable : MESSAGES.off)

  // ---- the request ----
  if (!sentAsJson(req)) return say(res, 415, 'unsupported_media_type', 'Send the request as JSON.')
  let raw: unknown
  try {
    raw = readBody(req)
  } catch {
    return say(res, 400, 'invalid_request', 'The request is not valid JSON.')
  }
  let size = 0
  try { size = Buffer.byteLength(JSON.stringify(raw ?? null), 'utf8') } catch { size = Infinity }
  if (size > TRAINED_CHAT_MAX_BODY_BYTES) return say(res, 413, 'too_long', 'The request is too large.')
  const chat = readChatRequest(raw)
  if (!chat.ok) return say(res, chat.status, chat.error, chat.message)

  // ---- one visitor's share: counted by the database, by a hash only ----
  const now = new Date()
  const visitor = visitorHash(visitorAddress(req), header(req, 'user-agent'), now)
  try {
    if (!(await countVisitorMessage(visitor, `w:${Math.floor(now.getTime() / 1000 / TRAINED_CHAT_WINDOW_S)}`, TRAINED_CHAT_PER_WINDOW))) {
      res.setHeader('Retry-After', String(TRAINED_CHAT_WINDOW_S))
      return say(res, 429, 'rate', MESSAGES.rate)
    }
    if (!(await countVisitorMessage(visitor, `d:${utcDay(now)}`, TRAINED_CHAT_PER_DAY))) return say(res, 429, 'rate', MESSAGES.day)
  } catch (e) {
    console.warn('[trained-chat] could not count a message:', e instanceof Error ? e.message : e)
    return say(res, 503, 'unavailable', MESSAGES.unavailable)
  }
  if (Math.random() < 0.02) void pruneVisitorCounts(now)

  // ---- the adapter ----
  let target: Awaited<ReturnType<typeof getAdapter>>
  try {
    target = await getAdapter(chat.adapter, now)
  } catch (e) {
    console.warn('[trained-chat] could not read the adapter:', e instanceof Error ? e.message : e)
    return say(res, 503, 'unavailable', MESSAGES.unavailable)
  }
  if (!target) return say(res, 404, 'gone', MESSAGES.gone)
  const base = target.adapter.base_model

  // ---- today's money: the lab's budget, then the chat's cap, then all of Tinker's ----
  const budget = await checkDailyBudget(now)
  if (!budget.allowed) return say(res, budget.spent_usd === null ? 503 : 429, budget.spent_usd === null ? 'unavailable' : 'budget', budget.spent_usd === null ? MESSAGES.unavailable : MESSAGES.budget)
  const worst = tinkerChatWorstCaseUsd(base, chat.messages, TRAINED_CHAT_MAX_TOKENS)
  let chatHold: Reservation | null = null
  let allHold: Reservation
  try {
    chatHold = await reserveTinkerSpend('chat', worst, tinkerChatDailyUsd(), now)
    if (!chatHold.ok) return say(res, 429, 'budget', MESSAGES.budget)
    allHold = await reserveTinkerSpend('all', worst, tinkerDailyUsd(), now)
    if (!allHold.ok) {
      await settleTinkerSpend(chatHold, 0)
      return say(res, 429, 'budget', MESSAGES.budget)
    }
  } catch (e) {
    console.warn('[trained-chat] could not check today\'s spend:', e instanceof Error ? e.message : e)
    if (chatHold?.ok) await settleTinkerSpend(chatHold, 0)
    return say(res, 503, 'unavailable', MESSAGES.unavailable)
  }

  // ---- the call ----
  const started = Date.now()
  const answer = await callTinkerChat({
    samplerPath: target.sampler_path, messages: chat.messages, maxTokens: TRAINED_CHAT_MAX_TOKENS,
    temperature: TRAINED_CHAT_TEMPERATURE, timeoutMs: TRAINED_CHAT_TIMEOUT_MS,
  })
  // A call that timed out may still have been served: what was set aside is counted.
  const costUsd = answer.ok ? tinkerChatCostUsd(base, answer.promptTokens, answer.completionTokens) : answer.kind === 'timeout' ? worst : 0
  await settleTinkerSpend(chatHold, costUsd)
  await settleTinkerSpend(allHold, costUsd)
  if (costUsd > 0) {
    await withSpendContext({ purpose: TRAINED_CHAT_PURPOSE }, () => recordModelCall({
      model: target.adapter.model_id, assigned: `tinker:${base}`, cost_usd: costUsd, cost_source: 'estimate',
      prompt_tokens: answer.ok ? answer.promptTokens : 0, completion_tokens: answer.ok ? answer.completionTokens : 0, reasoning_tokens: 0,
    }))
  }
  await recordTrainedChatCall({
    slug: target.adapter.slug, status: answer.ok ? 'ok' : answer.kind, httpStatus: answer.httpStatus, turns: chat.turns, promptChars: chat.chars,
    promptTokens: answer.ok ? answer.promptTokens : 0, completionTokens: answer.ok ? answer.completionTokens : 0, costUsd, durationMs: Date.now() - started,
  })
  if (!answer.ok) {
    // Counts and status only: an upstream error line could repeat what the visitor wrote.
    console.warn(`[trained-chat] no reply (${answer.kind}${answer.httpStatus ? `, ${answer.httpStatus}` : ''})`)
    return say(res, answer.kind === 'timeout' ? 504 : 502, 'busy', MESSAGES.busy)
  }
  const reply = sanitizeOutput(answer.content).trim().slice(0, TRAINED_CHAT_MAX_REPLY_CHARS)
  return res.status(200).json({
    adapter: target.adapter.slug,
    reply: reply || '(the model gave an empty reply)',
    cut_short: answer.finishReason === 'length',
    turns_left: Math.max(0, TRAINED_CHAT_MAX_TURNS - chat.turns),
  })
}
