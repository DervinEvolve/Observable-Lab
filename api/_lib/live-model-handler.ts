/**
 * The HTTP side of the lab model endpoint (live-model.ts):
 *
 *   POST /api/live-model/v1/chat/completions   one chat completion, OpenAI shape
 *   GET  /api/live-model/v1/models             the models it answers for
 *
 * Authorised by a scoped key (live-model-keys.ts), never by the operator
 * secret and never anonymously. The order for a call: is the endpoint on, is
 * the key a live key, is the request one the allowlist accepts, is there
 * budget left today (the lab's cap, then this endpoint's own), and only then
 * the database lets the call through and it is sent on with the lab's
 * OpenRouter key. That key is read here and goes nowhere but the
 * Authorization header of that one request.
 *
 * What the call cost is OpenRouter's own usage.cost and nothing else: it is
 * written to the spend ledger as purpose "live_model" and added to the key.
 * A response without usage.cost is recorded as costing nothing, with
 * cost_source "none"; no price table is consulted.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getModelCapabilities, usageFromResponse, isTimeoutError } from './openrouter.js'
import { checkDailyBudget, describeBudget, recordModelCall, withSpendContext } from './spend.js'
import { sanitizeOutput } from './sprites.js'
import {
  LIVE_MAX_BODY_BYTES, LIVE_UPSTREAM_TIMEOUT_MS, buildLiveRequest, checkLiveRequest, liveModelDailyUsd, liveModelFlag,
  liveModelList, liveModelOrigin, liveModelStatus, shapeLiveCompletion,
} from './live-model.js'
import {
  LIVE_MODEL_PURPOSE, bearerLiveKey, checkLiveKey, liveModelSpentTodayUsd, recordLiveCall, reserveLiveCall, settleLiveCall,
  type LiveCallRecord, type LiveKeyGrant,
} from './live-model-keys.js'

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'

function fail(res: VercelResponse, status: number, type: string, message: string) {
  return res.status(status).json({ error: { message, type, code: null } })
}

const short = (text: unknown, max = 200): string => sanitizeOutput(typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, max)

function readBody(req: VercelRequest): unknown {
  // Vercel parses JSON bodies lazily and throws on a malformed one.
  const body = (req as { body?: unknown }).body
  if (typeof body === 'string') return JSON.parse(body)
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'))
  return body
}

/** The text of the last user message, for the call record. */
function lastUserText(messages: unknown): string {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] as { role?: unknown; content?: unknown }
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) return m.content.map(p => (p as { text?: unknown })?.text).filter(t => typeof t === 'string').join(' ')
  }
  return ''
}

export async function handleLiveModel(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const status = liveModelStatus()
  if (!status.enabled) {
    return fail(res, 503, 'endpoint_off', liveModelFlag()
      ? 'The lab model endpoint is switched on but not fully configured.'
      : 'The lab model endpoint is switched off.')
  }

  const token = bearerLiveKey(req.headers?.authorization)
  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    return fail(res, 401, 'invalid_api_key', 'A lab model key is required: send "Authorization: Bearer <LAB_MODEL_API_KEY>".')
  }

  let key: Awaited<ReturnType<typeof checkLiveKey>>
  try {
    key = await checkLiveKey(token)
  } catch (e) {
    console.warn('[live-model] could not read the key store:', e instanceof Error ? e.message : e)
    return fail(res, 503, 'endpoint_unavailable', 'The lab could not check this key just now.')
  }
  if (!key.ok) {
    if (key.status === 401) res.setHeader('WWW-Authenticate', 'Bearer')
    return fail(res, key.status, key.status === 401 ? 'invalid_api_key' : 'key_limit_reached', key.reason)
  }

  if (req.method === 'GET') return res.status(200).json(liveModelList())
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Use POST for chat completions and GET for the model list.')

  // ---- the request, through the allowlist ----
  let raw: unknown
  try {
    raw = readBody(req)
  } catch {
    return fail(res, 400, 'invalid_request_error', 'The request body is not valid JSON.')
  }
  let size = 0
  try { size = Buffer.byteLength(JSON.stringify(raw ?? null), 'utf8') } catch { size = Infinity }
  if (size > LIVE_MAX_BODY_BYTES) {
    return fail(res, 413, 'invalid_request_error', `The request is larger than ${LIVE_MAX_BODY_BYTES / 1024} KB.`)
  }
  const first = checkLiveRequest(raw)
  if (!first.ok) return fail(res, first.status, first.type, first.message)
  const caps = await getModelCapabilities(first.model).catch(() => null)
  const built = buildLiveRequest(raw, caps)
  if (!built.ok) return fail(res, built.status, built.type, built.message)

  // ---- today's money: the lab's cap first, then this endpoint's own ----
  const budget = await checkDailyBudget()
  if (!budget.allowed) {
    return budget.spent_usd === null
      ? fail(res, 503, 'endpoint_unavailable', 'The lab could not read its spend ledger, so nothing new may start.')
      : fail(res, 429, 'lab_budget_reached', `The lab's daily budget is reached: ${describeBudget(budget)}.`)
  }
  let spentHere: number
  try {
    spentHere = await liveModelSpentTodayUsd()
  } catch (e) {
    console.warn('[live-model] could not read today\'s endpoint spend:', e instanceof Error ? e.message : e)
    return fail(res, 503, 'endpoint_unavailable', 'The lab could not read its spend ledger, so nothing new may start.')
  }
  const dailyCap = liveModelDailyUsd()
  if (spentHere >= dailyCap) {
    return fail(res, 429, 'endpoint_budget_reached', `This endpoint has reached its $${dailyCap.toFixed(2)} for today (UTC).`)
  }

  // ---- the gate: the database counts the call or refuses it ----
  let grant: Awaited<ReturnType<typeof reserveLiveCall>>
  try {
    grant = await reserveLiveCall(token)
  } catch (e) {
    console.warn('[live-model] could not reserve a call:', e instanceof Error ? e.message : e)
    return fail(res, 503, 'endpoint_unavailable', 'The lab could not check this key just now.')
  }
  if (!grant.ok) {
    if (grant.status === 401) res.setHeader('WWW-Authenticate', 'Bearer')
    return fail(res, grant.status, grant.status === 401 ? 'invalid_api_key' : 'key_limit_reached', grant.reason)
  }

  return runCall(res, grant, first.model, built.body, built.dropped)
}

async function runCall(res: VercelResponse, key: LiveKeyGrant, model: string, body: Record<string, unknown>, dropped: string[]) {
  const started = Date.now()
  const record: LiveCallRecord = {
    key, modelAsked: model, modelServed: null, status: 'upstream_error', httpStatus: null, finishReason: null,
    promptTokens: 0, completionTokens: 0, costUsd: 0, costSource: 'none', durationMs: 0,
    detail: {
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      ...(dropped.length ? { dropped } : {}),
      request_excerpt: lastUserText(body.messages),
    },
  }
  let costUsd = 0
  // Whatever happens below, the key gets its cost and its in-flight slot back, and the call is stored.
  const finish = async () => {
    record.durationMs = Date.now() - started
    record.costUsd = costUsd
    try {
      await settleLiveCall(key.id, costUsd)
    } catch (e) {
      console.warn('[live-model] could not settle a call:', e instanceof Error ? e.message : e)
    }
    await recordLiveCall(record)
  }

  let response: Response
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${(process.env.OPENROUTER_API_KEY || '').trim()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': liveModelOrigin() || 'https://observable-lab.vercel.app',
        'X-Title': 'Observable Multi-Agent Lab',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LIVE_UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    const timedOut = isTimeoutError(e)
    record.status = timedOut ? 'timeout' : 'upstream_error'
    await finish()
    return timedOut
      ? fail(res, 504, 'upstream_timeout', `The model did not answer within ${LIVE_UPSTREAM_TIMEOUT_MS / 1000} s.`)
      : fail(res, 502, 'upstream_error', 'The model service could not be reached.')
  }

  record.httpStatus = response.status
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(`[live-model] model call failed: ${response.status}`, short(text, 1000))
    let upstream = ''
    try { upstream = short((JSON.parse(text) as { error?: { message?: unknown } })?.error?.message) } catch { /* not JSON */ }
    record.detail.error = upstream || `HTTP ${response.status}`
    await finish()
    if (response.status === 429) return fail(res, 429, 'upstream_rate_limited', 'The model service is rate limiting the lab. Try again shortly.')
    // A 400 from the model service is about the request, so its short message is worth passing on.
    const detail = (response.status === 400 || response.status === 422) && upstream ? `: ${upstream}` : ''
    return fail(res, 502, 'upstream_error', `The model service returned an error (status ${response.status})${detail}.`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    record.status = 'no_answer'
    await finish()
    return fail(res, 502, 'upstream_error', 'The model service answered with something that is not JSON.')
  }

  // Billed as soon as it answered. usage.cost only: with no catalog entry
  // passed, a response without it is recorded as "none", never priced.
  const usage = usageFromResponse(data, null)
  costUsd = usage.cost_usd
  record.costSource = usage.cost_source
  record.promptTokens = usage.prompt_tokens
  record.completionTokens = usage.completion_tokens
  const served = (data as { model?: unknown })?.model
  record.modelServed = typeof served === 'string' && served ? served : model
  await withSpendContext(
    { ...(key.experiment_id ? { experimentId: key.experiment_id } : {}), ...(key.epoch !== null ? { epochNumber: key.epoch } : {}), purpose: LIVE_MODEL_PURPOSE },
    () => recordModelCall({ model, assigned: key.model, ...usage }),
  )
  if (usage.cost_source !== 'usage') console.warn(`[live-model] ${model} response had no usage.cost; recorded as costing nothing`)

  const completion = shapeLiveCompletion(data, model)
  if (!completion) {
    record.status = 'no_answer'
    record.detail.error = short((data as { error?: { message?: unknown } })?.error?.message) || 'no choices in the answer'
    await finish()
    return fail(res, 502, 'upstream_error', 'The model service answered without a completion.')
  }

  const message = completion.choices[0].message
  record.status = 'ok'
  record.finishReason = completion.choices[0].finish_reason
  record.detail.response_excerpt = message.content ?? ''
  if (message.tool_calls?.length) record.detail.tool_calls = message.tool_calls.map(c => c.function.name)
  await finish()

  res.setHeader('X-Lab-Calls-Left', String(Math.max(0, key.max_calls - key.calls_used)))
  res.setHeader('X-Lab-Usd-Left', Math.max(0, key.max_usd - key.usd_used - costUsd).toFixed(4))
  if (dropped.length) res.setHeader('X-Lab-Dropped-Fields', dropped.join(','))
  return res.status(200).json(completion)
}
