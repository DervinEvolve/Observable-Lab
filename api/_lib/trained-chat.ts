/**
 * The visitor chat with adapters the lab's models trained
 * (docs/TOOLS.md, "Talking to a trained adapter").
 *
 *   GET  /api/experiment/trained-chat   the adapters that can be talked to, and the limits
 *   POST /api/experiment/trained-chat   { adapter, messages } -> { reply }
 *                                       { adapter, messages, compare: true, base_replies } -> both answers
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
 * A visitor is remembered only as keyed hashes that change every day
 * (tinker-store.ts): one of the address alone, and one of the address with
 * the browser string. Both have limits and both must pass. The browser
 * string is whatever the sender says it is, so on its own it would let one
 * sender pose as any number of visitors; the address limit is the one that
 * holds. What a visitor writes is sent to Tinker to be answered
 * and is not stored or logged by the lab: a call leaves a row of counts.
 * The replies come from a small model fine-tuned on data the lab's models
 * wrote, and nobody reviews them; the room says so beside the chat.
 *
 * An adapter trained on rows of a public dataset (datasets.ts) is a
 * different thing: the Reviewer approved that run without seeing a row, and
 * neither a model nor the owner has read the data. Such an adapter is not
 * listed here and a message to it is refused, unless the owner sets
 * LAB_TRAINED_CHAT_DATASET_ADAPTERS=true. When that is set and one is
 * listed, the notice beside the chat says so.
 *
 * Compare (LAB_ENABLE_TRAINED_CHAT_COMPARE, on unless false, 0, off or no)
 * asks the untrained base model the same question beside the adapter, so a
 * visitor can see what training changed. It uses the same caps twice as
 * fast: it counts as two messages, sets aside the worst case of both calls
 * under both daily caps before either is sent, and charges each call by the
 * usual rules. It never quietly answers with one side only because the
 * budget is short; it says so and asks for nothing.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { checkDailyBudget, recordModelCall, withSpendContext } from './spend.js'
import { sanitizeOutput } from './sprites.js'
import {
  isAdapterSlug, tinkerChatCostUsd, tinkerChatDailyUsd, tinkerChatWorstCaseUsd, tinkerDailyUsd, trainedChatCompareFlag, trainedChatDatasetAdaptersFlag, trainedChatFlag,
  trainedChatStatus,
} from './tinker.js'
import { callTinkerChat, tinkerChatCharge, type TinkerChatMessage, type TinkerChatResult } from './tinker-chat.js'
import {
  addressHash, countVisitorMessage, getAdapter, listAdapters, pruneVisitorCounts, recordTrainedChatCall, reserveTinkerSpend, settleTinkerSpend,
  utcDay, visitorHash, type AdapterTarget, type Reservation,
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
/** Messages one visitor (an address and a browser string) may send: in a ten minute window, and in a UTC day. */
export const TRAINED_CHAT_PER_WINDOW = 10
export const TRAINED_CHAT_WINDOW_S = 600
export const TRAINED_CHAT_PER_DAY = 40
/**
 * Messages one address may send, whatever browser string comes with them.
 * Twice the visitor limits, so a few people behind one address can each
 * talk, and changing the browser string buys nothing past it. An IPv6
 * address counts as its /64 network.
 */
export const TRAINED_CHAT_ADDRESS_PER_WINDOW = 20
export const TRAINED_CHAT_ADDRESS_PER_DAY = 80
export const TRAINED_CHAT_MAX_BODY_BYTES = 16 * 1024
/** A comparison also carries the untrained side's earlier replies. This only has to hold them; it is not a spend cap. */
export const TRAINED_CHAT_COMPARE_MAX_BODY_BYTES = 28 * 1024
export const TRAINED_CHAT_TIMEOUT_MS = 45_000

/** Shown beside the chat. Plain, and no dashes. */
export const TRAINED_CHAT_NOTICE = 'A small model fine-tuned by the lab\'s AI models on data they wrote. Replies are not reviewed.'
/** Shown instead while the list holds an adapter trained on a public dataset (only with LAB_TRAINED_CHAT_DATASET_ADAPTERS on). */
export const TRAINED_CHAT_NOTICE_DATASETS = 'Small models fine-tuned by the lab\'s AI models. Some were trained on data the models wrote, and some on rows of a public dataset that nobody at the lab has read. Replies are not reviewed.'

/**
 * May the visitor chat answer with this adapter? One trained on data a model
 * wrote into its answer: yes, as ever (the Reviewer saw that data). One
 * trained on rows of a public dataset: only when the owner has said so.
 */
export function chatOffers(target: Pick<AdapterTarget, 'from_dataset'>): boolean {
  return !target.from_dataset || trainedChatDatasetAdaptersFlag()
}

const MESSAGES = {
  off: 'The chat with trained models is switched off.',
  budget: 'The lab has used today\'s small budget for visitor chats. It opens again at 00:00 UTC.',
  budgetCompare: 'The lab\'s chat budget for today can cover one reply but may not cover two. Turn off the comparison to ask one question, or try again after 00:00 UTC.',
  compareOff: 'Comparing with the untrained model is switched off.',
  rate: 'That is a lot of messages in a short time. Give it a few minutes and try again.',
  day: 'You have reached today\'s message limit. It starts again at 00:00 UTC.',
  turns: `This conversation has reached its ${TRAINED_CHAT_MAX_TURNS} turns. Start a new one to keep going.`,
  gone: 'That model is no longer kept. Trained models expire after a while.',
  notOffered: 'That model is not offered in this chat.',
  busy: 'The model did not answer this time. Please try again in a moment.',
  unavailable: 'The chat is not available just now. Please try again later.',
}

function say(res: VercelResponse, status: number, error: string, message: string) {
  return res.status(status).json({ error, message })
}

export type ChatRefusal = { ok: false; status: number; error: string; message: string }
export interface ChatRequest {
  ok: true; adapter: string; messages: TinkerChatMessage[]; turns: number; chars: number
  /** True when the visitor asked for the untrained model's answer too. */
  compare: boolean
  /**
   * The same visitor messages, with the untrained side's own earlier replies
   * between them. Built here from the visitor's texts, so the two sides differ
   * in nothing but their own earlier answers. Empty unless compare.
   */
  baseMessages: TinkerChatMessage[]
  /** Characters of baseMessages. 0 unless compare. */
  baseChars: number
}

// eslint-disable-next-line no-control-regex
const stripControls = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

/**
 * Reads what a visitor's browser sent. Strict: an object with "adapter" and
 * "messages" and, for a comparison, "compare" (true) and "base_replies" (one
 * string for each earlier reply), and nothing else; messages alternate user
 * and assistant, starting and ending with the visitor; no system message.
 */
export function readChatRequest(raw: unknown): ChatRequest | ChatRefusal {
  const bad = (message: string, error = 'invalid_request'): ChatRefusal => ({ ok: false, status: 400, error, message })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Send a JSON object with "adapter" and "messages".')
  const req = raw as Record<string, unknown>
  if (Object.keys(req).some(k => k !== 'adapter' && k !== 'messages' && k !== 'compare' && k !== 'base_replies')) {
    return bad('Only "adapter", "messages", "compare" and "base_replies" are accepted.')
  }
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
    const content = stripControls(o.content)
    chars += content.length
    messages.push({ role, content })
  }
  if (messages.length % 2 !== 1) return bad('Messages must alternate "user" and "assistant", starting and ending with "user".')
  const turns = (messages.length + 1) / 2

  if ('compare' in req && typeof req.compare !== 'boolean') return bad('compare must be true or false.')
  if (req.compare !== true) {
    if ('base_replies' in req) return bad('base_replies is only accepted with compare.')
    return { ok: true, adapter: req.adapter, messages, turns, chars, compare: false, baseMessages: [], baseChars: 0 }
  }
  const replies = req.base_replies
  if (!Array.isArray(replies) || replies.length !== turns - 1 || replies.some(r => typeof r !== 'string' || !r.trim())) {
    return bad('base_replies must hold one reply for each earlier reply.')
  }
  const baseMessages: TinkerChatMessage[] = []
  let baseChars = 0
  for (const [i, m] of messages.entries()) {
    if (m.role === 'user') {
      baseMessages.push(m)
      baseChars += m.content.length
      continue
    }
    const text = replies[(i - 1) / 2] as string
    if (text.length > TRAINED_CHAT_MAX_REPLY_CHARS) return bad('An earlier reply in the conversation is longer than a reply can be.', 'too_long')
    const content = stripControls(text)
    if (!content.trim()) return bad('base_replies must hold one reply for each earlier reply.')
    baseMessages.push({ role: 'assistant', content })
    baseChars += content.length
  }
  return { ok: true, adapter: req.adapter, messages, turns, chars, compare: true, baseMessages, baseChars }
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
      const offered = (await listAdapters()).filter(chatOffers)
      const adapters = offered.map(t => t.adapter)
      const notice = offered.some(t => t.from_dataset) ? TRAINED_CHAT_NOTICE_DATASETS : TRAINED_CHAT_NOTICE
      return res.status(200).json({ enabled: true, adapters, limits: chatLimits(), notice, compare_enabled: trainedChatCompareFlag() })
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
  // Only a body that asks for a comparison may be the larger size. It carries
  // the extra replies and nothing more.
  const asksCompare = Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>).compare === true)
  if (size > (asksCompare ? TRAINED_CHAT_COMPARE_MAX_BODY_BYTES : TRAINED_CHAT_MAX_BODY_BYTES)) return say(res, 413, 'too_long', 'The request is too large.')
  const chat = readChatRequest(raw)
  if (!chat.ok) return say(res, chat.status, chat.error, chat.message)
  // Switched off: nothing is counted and nothing is spent.
  if (chat.compare && !trainedChatCompareFlag()) return say(res, 403, 'compare_off', MESSAGES.compareOff)

  // ---- one visitor's share: counted by the database, by hashes only ----
  // The address alone is counted first. It is the limit a sender cannot get
  // around by changing the browser string, and a message it refuses writes
  // nothing more. Then the address with the browser string, at half as many.
  const now = new Date()
  const ip = visitorAddress(req)
  const address = addressHash(ip, now)
  const visitor = visitorHash(ip, header(req, 'user-agent'), now)
  const windowBucket = `w:${Math.floor(now.getTime() / 1000 / TRAINED_CHAT_WINDOW_S)}`
  const dayBucket = `d:${utcDay(now)}`
  try {
    // A comparison asks two models, so it counts as two messages: the limits
    // fill twice as fast and the address limits do not loosen. A pass that is
    // refused does not undo the one before it, as a refused call never has.
    for (let pass = 0; pass < (chat.compare ? 2 : 1); pass++) {
      for (const [who, perWindow] of [[address, TRAINED_CHAT_ADDRESS_PER_WINDOW], [visitor, TRAINED_CHAT_PER_WINDOW]] as const) {
        if (!(await countVisitorMessage(who, windowBucket, perWindow))) {
          res.setHeader('Retry-After', String(TRAINED_CHAT_WINDOW_S))
          return say(res, 429, 'rate', MESSAGES.rate)
        }
      }
      for (const [who, perDay] of [[address, TRAINED_CHAT_ADDRESS_PER_DAY], [visitor, TRAINED_CHAT_PER_DAY]] as const) {
        if (!(await countVisitorMessage(who, dayBucket, perDay))) return say(res, 429, 'rate', MESSAGES.day)
      }
    }
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
  // An adapter trained on a public dataset is not on the list unless the
  // owner allowed it, and asking for it by name gets no further than this.
  if (!chatOffers(target)) return say(res, 404, 'not_offered', MESSAGES.notOffered)
  const base = target.adapter.base_model

  // ---- today's money: the lab's budget, then the chat's cap, then all of Tinker's ----
  const budget = await checkDailyBudget(now)
  if (!budget.allowed) return say(res, budget.spent_usd === null ? 503 : 429, budget.spent_usd === null ? 'unavailable' : 'budget', budget.spent_usd === null ? MESSAGES.unavailable : MESSAGES.budget)
  // Each call's own worst case. A comparison sets aside both, once, under
  // each scope, before either call is sent.
  const worstTrained = tinkerChatWorstCaseUsd(base, chat.messages, TRAINED_CHAT_MAX_TOKENS)
  const worstBase = chat.compare ? tinkerChatWorstCaseUsd(base, chat.baseMessages, TRAINED_CHAT_MAX_TOKENS) : 0
  const worst = chat.compare ? Math.ceil((worstTrained + worstBase) * 1e6) / 1e6 : worstTrained
  const budgetMessage = chat.compare ? MESSAGES.budgetCompare : MESSAGES.budget
  let chatHold: Reservation | null = null
  let allHold: Reservation
  try {
    chatHold = await reserveTinkerSpend('chat', worst, tinkerChatDailyUsd(), now)
    if (!chatHold.ok) return say(res, 429, 'budget', budgetMessage)
    allHold = await reserveTinkerSpend('all', worst, tinkerDailyUsd(), now)
    if (!allHold.ok) {
      await settleTinkerSpend(chatHold, 0)
      return say(res, 429, 'budget', budgetMessage)
    }
  } catch (e) {
    console.warn('[trained-chat] could not check today\'s spend:', e instanceof Error ? e.message : e)
    if (chatHold?.ok) await settleTinkerSpend(chatHold, 0)
    return say(res, 503, 'unavailable', MESSAGES.unavailable)
  }

  // ---- the call (or the two calls, side by side) ----
  const timed = async (input: Parameters<typeof callTinkerChat>[0]) => {
    const t0 = Date.now()
    const answer = await callTinkerChat(input)
    return { answer, ms: Date.now() - t0 }
  }
  const trainedInput = {
    samplerPath: target.sampler_path, messages: chat.messages, maxTokens: TRAINED_CHAT_MAX_TOKENS,
    temperature: TRAINED_CHAT_TEMPERATURE, timeoutMs: TRAINED_CHAT_TIMEOUT_MS,
  }
  // callTinkerChat never throws, so one side failing cannot lose the other's answer.
  // The base model is always the adapter's own record, never anything the visitor sent.
  const [trained, untrained] = await Promise.all([
    timed(trainedInput),
    chat.compare
      ? timed({ baseModel: base, messages: chat.baseMessages, maxTokens: TRAINED_CHAT_MAX_TOKENS, temperature: TRAINED_CHAT_TEMPERATURE, timeoutMs: TRAINED_CHAT_TIMEOUT_MS })
      : Promise.resolve(null),
  ])
  // Measured tokens at the published prices. A call that may have been
  // served without the lab learning its token counts (a timeout, a broken
  // connection, an answer with no usage) is counted at what was set aside,
  // so the caps fill from estimates that err high, never from zeros. A
  // comparison charges each call by its own worst case, then settles both
  // holds once with the sum.
  const measured = (p: number, c: number) => tinkerChatCostUsd(base, p, c)
  const trainedCost = tinkerChatCharge(trained.answer, measured, worstTrained).usd
  const untrainedCost = untrained ? tinkerChatCharge(untrained.answer, measured, worstBase).usd : 0
  const costUsd = trainedCost + untrainedCost
  await settleTinkerSpend(chatHold, costUsd)
  await settleTinkerSpend(allHold, costUsd)

  const record = async (side: { answer: TinkerChatResult; ms: number }, cost: number, opts: { model: string; status: (kind: string) => string; chars: number }) => {
    const a = side.answer
    if (cost > 0) {
      await withSpendContext({ purpose: TRAINED_CHAT_PURPOSE }, () => recordModelCall({
        model: opts.model, assigned: `tinker:${base}`, cost_usd: cost, cost_source: 'estimate',
        prompt_tokens: a.ok ? a.promptTokens : 0, completion_tokens: a.ok ? a.completionTokens : 0, reasoning_tokens: 0,
      }))
    }
    await recordTrainedChatCall({
      slug: target.adapter.slug, status: opts.status(a.ok ? 'ok' : a.kind), httpStatus: a.httpStatus, turns: chat.turns, promptChars: opts.chars,
      promptTokens: a.ok ? a.promptTokens : 0, completionTokens: a.ok ? a.completionTokens : 0, costUsd: cost, durationMs: side.ms,
    })
    if (!a.ok) {
      // Counts and status only: an upstream error line could repeat what the visitor wrote.
      console.warn(`[trained-chat] no ${opts.model === target.adapter.model_id ? '' : 'untrained '}reply (${a.kind}${a.httpStatus ? `, ${a.httpStatus}` : ''})`)
    }
  }
  await record(trained, trainedCost, { model: target.adapter.model_id, status: k => k, chars: chat.chars })
  if (untrained) await record(untrained, untrainedCost, { model: base, status: k => `base_${k}`, chars: chat.baseChars })

  const cleaned = (answer: Extract<TinkerChatResult, { ok: true }>) => ({
    reply: sanitizeOutput(answer.content).trim().slice(0, TRAINED_CHAT_MAX_REPLY_CHARS) || '(the model gave an empty reply)',
    cut_short: answer.finishReason === 'length',
  })
  const turnsLeft = Math.max(0, TRAINED_CHAT_MAX_TURNS - chat.turns)

  if (!untrained) {
    if (!trained.answer.ok) return say(res, trained.answer.kind === 'timeout' ? 504 : 502, 'busy', MESSAGES.busy)
    return res.status(200).json({ adapter: target.adapter.slug, ...cleaned(trained.answer), turns_left: turnsLeft })
  }
  if (!trained.answer.ok && !untrained.answer.ok) {
    return say(res, trained.answer.kind === 'timeout' && untrained.answer.kind === 'timeout' ? 504 : 502, 'busy', MESSAGES.busy)
  }
  const side = (answer: TinkerChatResult) => answer.ok
    ? { ok: true as const, ...cleaned(answer) }
    : { ok: false as const, error: 'busy', message: MESSAGES.busy }
  return res.status(200).json({
    adapter: target.adapter.slug, compare: true, base_model: base,
    trained: side(trained.answer), untrained: side(untrained.answer), turns_left: turnsLeft,
  })
}
