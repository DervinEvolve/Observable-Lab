/**
 * Trained adapters on the lab model endpoint (live-model-handler.ts).
 *
 * While LAB_ENABLE_LIVE_TRAINED is on, the endpoint also answers for the
 * adapters the lab trained on Tinker and still keeps, as the models
 * "lab/<name>". The same scoped key authorises the call, the same limits of
 * that key count it, and it is recorded in the same two places. What
 * differs is where it goes (Tinker's OpenAI-compatible endpoint, through
 * tinker-chat.ts) and how its cost is known: Tinker reports no cost, so the
 * tokens it reports are priced at Tinker's published prices and written to
 * the ledger as an estimate. Before the call the most it could cost is set
 * aside under the daily Tinker cap; after it, that is replaced by the
 * estimate.
 *
 * An adapter takes text messages only: system, user and assistant. Tools
 * and every other field are dropped and named in X-Lab-Dropped-Fields.
 */
import type { VercelResponse } from '@vercel/node'
import { recordModelCall, withSpendContext } from './spend.js'
import { LIVE_MAX_MESSAGES, LIVE_UPSTREAM_TIMEOUT_MS, shapeLiveCompletion, type LiveRefusal } from './live-model.js'
import { LIVE_MODEL_PURPOSE, recordLiveCall, settleLiveCall, type LiveCallRecord, type LiveKeyGrant } from './live-model-keys.js'
import { LAB_ADAPTER_PREFIX, isAdapterSlug, tinkerChatCostUsd, tinkerChatWorstCaseUsd, tinkerDailyUsd } from './tinker.js'
import { callTinkerChat, type TinkerChatMessage } from './tinker-chat.js'
import { reserveTinkerSpend, settleTinkerSpend, type AdapterTarget } from './tinker-store.js'

/** The most one call to an adapter may generate. */
export const TRAINED_MAX_OUTPUT_TOKENS = 1024
export const TRAINED_DEFAULT_OUTPUT_TOKENS = 512

const refuse = (message: string, status = 400, type = 'invalid_request_error'): LiveRefusal => ({ ok: false, status, type, message })

/** The adapter name in a model id like "lab/e12-0a1b2c3d", or null when the id is not one. */
export function adapterSlugOf(model: unknown): string | null {
  if (typeof model !== 'string' || !model.startsWith(LAB_ADAPTER_PREFIX)) return null
  const slug = model.slice(LAB_ADAPTER_PREFIX.length)
  return isAdapterSlug(slug) ? slug : null
}

/** Does the request name a model in the lab's own namespace (whether or not it exists)? */
export function asksForAdapter(raw: unknown): boolean {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
    && typeof (raw as { model?: unknown }).model === 'string' && (raw as { model: string }).model.startsWith(LAB_ADAPTER_PREFIX)
}

export interface TrainedRequest {
  ok: true
  messages: TinkerChatMessage[]
  maxTokens: number
  temperature?: number
  dropped: string[]
}

const FORWARDED = ['model', 'messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'stream']

/** What is sent on for a call to an adapter, built field by field from what the caller wrote. */
export function buildTrainedRequest(raw: unknown): TrainedRequest | LiveRefusal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('The request body must be a JSON object.')
  const req = raw as Record<string, unknown>
  if (req.stream !== undefined && req.stream !== false && req.stream !== null) {
    return refuse('This endpoint is non-streaming only: leave "stream" out or set it to false.', 400, 'stream_not_supported')
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) return refuse('"messages" must be a non-empty list.')
  if (req.messages.length > LIVE_MAX_MESSAGES) return refuse(`"messages" may hold at most ${LIVE_MAX_MESSAGES} messages.`)
  const messages: TinkerChatMessage[] = []
  for (const [i, m] of req.messages.entries()) {
    const where = `messages[${i}]`
    const o = m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : null
    if (!o || (o.role !== 'system' && o.role !== 'user' && o.role !== 'assistant')) {
      return refuse(`${where}: a trained adapter takes text messages only, with "role" system, user or assistant.`)
    }
    let content: string
    if (typeof o.content === 'string') content = o.content
    else if (Array.isArray(o.content) && o.content.every(p => p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')) {
      content = o.content.map(p => (p as { text: string }).text).join('')
    } else return refuse(`${where}: "content" must be a string or a list of text parts.`)
    messages.push({ role: o.role, content })
  }
  const asked = [req.max_completion_tokens, req.max_tokens].map(Number).find(n => Number.isFinite(n) && n >= 1)
  const maxTokens = Math.min(TRAINED_MAX_OUTPUT_TOKENS, asked === undefined ? TRAINED_DEFAULT_OUTPUT_TOKENS : Math.floor(asked))
  const dropped = Object.keys(req).filter(k => !FORWARDED.includes(k))
  const out: TrainedRequest = { ok: true, messages, maxTokens, dropped: [] }
  if (req.temperature !== undefined) {
    if (typeof req.temperature === 'number' && Number.isFinite(req.temperature) && req.temperature >= 0 && req.temperature <= 2) out.temperature = req.temperature
    else dropped.push('temperature')
  }
  out.dropped = dropped.map(k => k.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40)).slice(0, 20)
  return out
}

function fail(res: VercelResponse, status: number, type: string, message: string) {
  return res.status(status).json({ error: { message, type, code: null } })
}

/**
 * Runs one call to an adapter for a key whose call has already been let
 * through (live-model-keys.ts). Whatever happens, the key gets its cost and
 * its in-flight slot back, the money set aside is settled, and the call is
 * stored.
 */
export async function runTrainedCall(res: VercelResponse, key: LiveKeyGrant, target: AdapterTarget, request: TrainedRequest) {
  const started = Date.now()
  const model = target.adapter.model_id
  const base = target.adapter.base_model
  const lastUser = [...request.messages].reverse().find(m => m.role === 'user')?.content ?? ''
  const record: LiveCallRecord = {
    key, modelAsked: model, modelServed: `tinker:${base}`, status: 'upstream_error', httpStatus: null, finishReason: null,
    promptTokens: 0, completionTokens: 0, costUsd: 0, costSource: 'none', durationMs: 0,
    detail: {
      messages: request.messages.length, tools: 0, ...(request.dropped.length ? { dropped: request.dropped } : {}),
      request_excerpt: lastUser, adapter: target.adapter.slug,
    },
  }

  const worst = tinkerChatWorstCaseUsd(base, request.messages, request.maxTokens)
  let reservation: Awaited<ReturnType<typeof reserveTinkerSpend>>
  try {
    reservation = await reserveTinkerSpend('all', worst, tinkerDailyUsd())
  } catch (e) {
    console.warn('[live-model] could not check today\'s Tinker spend:', e instanceof Error ? e.message : e)
    reservation = { ok: false, reason: 'unavailable' }
  }
  let costUsd = 0
  const finish = async () => {
    record.durationMs = Date.now() - started
    record.costUsd = costUsd
    if (reservation.ok) await settleTinkerSpend(reservation, costUsd)
    try {
      await settleLiveCall(key.id, costUsd)
    } catch (e) {
      console.warn('[live-model] could not settle a call:', e instanceof Error ? e.message : e)
    }
    await recordLiveCall(record)
  }
  if (!reservation.ok) {
    record.detail.error = 'daily Tinker cap'
    await finish()
    return reservation.reason === 'unavailable'
      ? fail(res, 503, 'endpoint_unavailable', 'The lab could not read its spend ledger, so nothing new may start.')
      : fail(res, 429, 'tinker_budget_reached', `The lab's Tinker use has reached its $${tinkerDailyUsd().toFixed(2)} for today (UTC).`)
  }

  const answer = await callTinkerChat({
    samplerPath: target.sampler_path, messages: request.messages, maxTokens: request.maxTokens,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), timeoutMs: LIVE_UPSTREAM_TIMEOUT_MS,
  })
  record.httpStatus = answer.httpStatus
  if (!answer.ok) {
    record.status = answer.kind === 'timeout' ? 'timeout' : answer.kind === 'no_answer' ? 'no_answer' : 'upstream_error'
    record.detail.error = answer.detail
    // A call that timed out may still have been served and billed: the amount set aside is counted.
    if (answer.kind === 'timeout') {
      costUsd = worst
      record.costSource = 'estimate'
      await ledger(key, model, costUsd, 0, 0)
    }
    console.error(`[live-model] adapter call failed (${answer.kind}${answer.httpStatus ? `, ${answer.httpStatus}` : ''}): ${answer.detail}`)
    await finish()
    if (answer.kind === 'timeout') return fail(res, 504, 'upstream_timeout', `The adapter did not answer within ${LIVE_UPSTREAM_TIMEOUT_MS / 1000} s.`)
    if (answer.kind === 'upstream' && answer.httpStatus === 429) return fail(res, 429, 'upstream_rate_limited', 'The training service is rate limiting the lab. Try again shortly.')
    return fail(res, 502, 'upstream_error', answer.kind === 'upstream'
      ? `The training service returned an error (status ${answer.httpStatus}).`
      : 'The training service could not be reached or gave no usable answer.')
  }

  costUsd = tinkerChatCostUsd(base, answer.promptTokens, answer.completionTokens)
  record.costSource = 'estimate'
  record.promptTokens = answer.promptTokens
  record.completionTokens = answer.completionTokens
  await ledger(key, model, costUsd, answer.promptTokens, answer.completionTokens)

  const completion = shapeLiveCompletion(answer.data, model)
  if (!completion) {
    record.status = 'no_answer'
    await finish()
    return fail(res, 502, 'upstream_error', 'The training service answered without a completion.')
  }
  // An adapter is sent no tools, so anything shaped like a call is left out.
  delete completion.choices[0].message.tool_calls
  delete completion.choices[0].message.reasoning_details
  completion.choices[0].message.content = answer.content
  completion.choices[0].finish_reason = answer.finishReason
  record.status = 'ok'
  record.finishReason = answer.finishReason
  record.detail.response_excerpt = answer.content
  await finish()

  res.setHeader('X-Lab-Calls-Left', String(Math.max(0, key.max_calls - key.calls_used)))
  res.setHeader('X-Lab-Usd-Left', Math.max(0, key.max_usd - key.usd_used - costUsd).toFixed(4))
  res.setHeader('X-Lab-Cost-Basis', 'estimate')
  if (request.dropped.length) res.setHeader('X-Lab-Dropped-Fields', request.dropped.join(','))
  return res.status(200).json(completion)
}

/** The call on the spend ledger, tagged like every other call through this endpoint, marked as an estimate. */
async function ledger(key: LiveKeyGrant, model: string, costUsd: number, promptTokens: number, completionTokens: number): Promise<void> {
  await withSpendContext(
    { ...(key.experiment_id ? { experimentId: key.experiment_id } : {}), ...(key.epoch !== null ? { epochNumber: key.epoch } : {}), purpose: LIVE_MODEL_PURPOSE },
    () => recordModelCall({
      model, assigned: key.model, cost_usd: costUsd, cost_source: 'estimate',
      prompt_tokens: promptTokens, completion_tokens: completionTokens, reasoning_tokens: 0,
    }),
  )
}
