import { Agent } from 'undici'
import { recordModelCall } from './spend.js'
import { FALLBACK_MODELS } from './types.js'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODELS_URL = 'https://openrouter.ai/api/v1/models'

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
// A reasoning model writing a whole file can take a few minutes; a hung
// connection must not eat the function's 800 s budget.
const COMPLETION_TIMEOUT_MS = envMs('OPENROUTER_TIMEOUT_MS', 240_000)
/** The longest one completion request may run, for code that plans the rest of a request around it. */
export function completionTimeoutMs(): number {
  return COMPLETION_TIMEOUT_MS
}
const CATALOG_TIMEOUT_MS = 15_000
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
const CATALOG_RETRY_MS = 5 * 60 * 1000

// Room for the answer itself. With reasoning on, max_tokens is doubled so
// medium effort (about half the budget on effort-only providers) still
// leaves this much for the JSON.
const DEFAULT_ANSWER_TOKENS = 16_000
const WANTED_EFFORT = 'medium'

// A real web page the model consulted (from OpenRouter's web plugin), surfaced
// so the lab can stream what a model actually browsed into its terminal.
export interface WebCitation {
  url: string
  title: string
}

// Pull url_citation annotations off an OpenRouter message (present when the
// web plugin ran). Best-effort — shape varies slightly across models.
function extractCitations(message: any): WebCitation[] {
  const annotations = message?.annotations
  if (!Array.isArray(annotations)) return []
  const out: WebCitation[] = []
  for (const a of annotations) {
    const c = a?.url_citation ?? a
    if (c?.url) out.push({ url: String(c.url), title: String(c.title || c.url) })
  }
  return out
}

/**
 * The model declined to answer: OpenRouter reports finish_reason
 * "content_filter" (native "refusal" for Anthropic). Asking again with the
 * same prompt gets the same refusal and is billed for the prompt each time,
 * so it is not retried, and a fallback from the same lab is skipped.
 */
export class ModelRefusalError extends Error {
  constructor(readonly modelId: string, readonly finishReason: string, readonly usage: CallUsage) {
    super(`${modelId} refused (finish_reason=${finishReason})`)
    this.name = 'ModelRefusalError'
  }
}

/**
 * The answer was cut off at the output limit (finish_reason "length"),
 * usually because reasoning used most of max_tokens. It is billed, it is not
 * the answer, and the same request would be cut off again, so it is not
 * retried on the same model.
 */
export class ModelTruncatedError extends Error {
  constructor(readonly modelId: string, readonly usage: CallUsage) {
    super(`${modelId} was cut off at the output limit`)
    this.name = 'ModelTruncatedError'
  }
}

/** The lab part of a model ID: "anthropic" for "anthropic/claude-fable-5.2". */
export function providerOf(modelId: string): string {
  return modelId.split('/')[0]
}

function extractJson(content: string): unknown {
  let trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Empty model response');
  }

  // Clean up common issues
  // Remove BOM and other invisible characters
  trimmed = trimmed.replace(/^\uFEFF/, '');
  // Remove any leading/trailing backticks without code block
  trimmed = trimmed.replace(/^`+|`+$/g, '');

  // First try: extract from markdown code block
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      // Continue to other methods
    }
  }

  // Second try: find JSON object/array anywhere in the content
  const jsonObjectMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonArrayMatch = trimmed.match(/\[[\s\S]*\]/);
  const match = jsonObjectMatch || jsonArrayMatch;
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      // Try to fix common JSON issues
      let fixed = match[0]
        .replace(/,\s*}/g, '}')  // Remove trailing commas in objects
        .replace(/,\s*]/g, ']')  // Remove trailing commas in arrays
        .replace(/'/g, '"')       // Replace single quotes with double
        .replace(/(\w+):/g, '"$1":'); // Quote unquoted keys
      try {
        return JSON.parse(fixed);
      } catch (e2) {
        // Continue to last try
      }
    }
  }

  // Last try: parse entire content as JSON
  return JSON.parse(trimmed);
}

// ---------------------------------------------------------------------------
// Model catalog: which request parameters each model accepts
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  supported_parameters: string[]
  // reasoning.supported_efforts from the catalog: undefined = no effort
  // selection, null = every effort accepted
  supported_efforts?: string[] | null
  max_completion_tokens?: number | null
  pricing?: { prompt: number; completion: number } // USD per token
}

// Snapshot of https://openrouter.ai/api/v1/models for the run 2 models
// (2026-11-13), trimmed to the parameters this client can send. Only used
// when the live catalog can't be read.
const SNAPSHOT: Record<string, { params: string[]; efforts?: string[]; maxOut: number; price: [number, number] }> = {
  'google/gemini-4-hydrogen': { params: ['max_tokens', 'reasoning', 'response_format', 'temperature'], efforts: ['xhigh', 'high', 'medium', 'low'], maxOut: 943718, price: [0.0000015, 0.0000075] },
  'deepseek/deepseek-v4-pro-0813': { params: ['max_tokens', 'reasoning', 'response_format', 'temperature'], efforts: ['max', 'high', 'low', 'none'], maxOut: 943718, price: [0.000000111, 0.00000444] },
  'anthropic/claude-fable-5.2': { params: ['max_completion_tokens', 'max_tokens', 'reasoning', 'response_format'], efforts: ['max', 'xhigh', 'high', 'medium', 'low'], maxOut: 128000, price: [0.000008, 0.00004] },
  'openai/gpt-6-astra': { params: ['max_completion_tokens', 'max_tokens', 'reasoning', 'response_format'], efforts: ['max', 'xhigh', 'high', 'medium', 'low'], maxOut: 128000, price: [0.00001, 0.00005] },
  'x-ai/grok-4.7': { params: ['max_tokens', 'reasoning', 'response_format', 'temperature'], efforts: ['xhigh', 'high', 'medium', 'low'], maxOut: 450000, price: [0.000002, 0.000006] },
  'cohere/north-mini-code:free': { params: ['max_tokens', 'reasoning', 'temperature'], maxOut: 64000, price: [0, 0] },
  'z-ai/glm-5.3-prime': { params: ['max_tokens', 'reasoning', 'response_format', 'temperature'], efforts: ['max', 'high', 'low'], maxOut: 131072, price: [0.0000028, 0.0000088] },
  'anthropic/claude-sonnet-5.5': { params: ['max_completion_tokens', 'max_tokens', 'reasoning', 'response_format'], efforts: ['max', 'xhigh', 'high', 'medium', 'low'], maxOut: 128000, price: [0.000002, 0.00001] },
  'google/gemini-3.8-flash': { params: ['max_tokens', 'reasoning', 'response_format', 'temperature'], efforts: ['high', 'medium', 'low'], maxOut: 65536, price: [0.000000825, 0.000004125] },
}

function fromSnapshot(modelId: string): ModelCapabilities | null {
  const s = Object.hasOwn(SNAPSHOT, modelId) ? SNAPSHOT[modelId] : undefined
  if (!s) return null
  return {
    supported_parameters: s.params,
    ...(s.efforts ? { supported_efforts: s.efforts } : {}),
    max_completion_tokens: s.maxOut,
    pricing: { prompt: s.price[0], completion: s.price[1] },
  }
}

function capabilitiesFromCatalogEntry(m: any): ModelCapabilities | null {
  if (!m || typeof m.id !== 'string' || !Array.isArray(m.supported_parameters)) return null
  const reasoning = m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : undefined
  const efforts = reasoning && 'supported_efforts' in reasoning
    ? (Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts.filter((e: unknown) => typeof e === 'string') : null)
    : undefined
  const maxOut = Number(m.top_provider?.max_completion_tokens)
  const prompt = Number(m.pricing?.prompt)
  const completion = Number(m.pricing?.completion)
  return {
    supported_parameters: m.supported_parameters.filter((p: unknown) => typeof p === 'string'),
    ...(efforts !== undefined ? { supported_efforts: efforts } : {}),
    max_completion_tokens: Number.isFinite(maxOut) && maxOut > 0 ? maxOut : null,
    ...(Number.isFinite(prompt) && Number.isFinite(completion) ? { pricing: { prompt, completion } } : {}),
  }
}

let catalog: { at: number; ok: boolean; models: Map<string, ModelCapabilities> } | null = null
let catalogLoading: Promise<void> | null = null

async function loadCatalog(): Promise<void> {
  try {
    // Public endpoint; no key is sent.
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const models = new Map<string, ModelCapabilities>()
    for (const m of Array.isArray(body?.data) ? body.data : []) {
      const caps = capabilitiesFromCatalogEntry(m)
      if (caps) models.set(m.id, caps)
    }
    if (models.size === 0) throw new Error('empty catalog')
    catalog = { at: Date.now(), ok: true, models }
  } catch (e) {
    console.warn('[MODEL] model catalog unavailable, using the built-in snapshot:', e instanceof Error ? e.message : e)
    catalog = { at: Date.now(), ok: false, models: catalog?.models ?? new Map() }
  }
}

/** What the model accepts, from the live catalog (cached), else the snapshot. */
export async function getModelCapabilities(modelId: string): Promise<ModelCapabilities | null> {
  const age = catalog ? Date.now() - catalog.at : Infinity
  if (age > (catalog?.ok ? CATALOG_TTL_MS : CATALOG_RETRY_MS)) {
    catalogLoading ??= loadCatalog().finally(() => { catalogLoading = null })
    await catalogLoading
  }
  return catalog?.models.get(modelId) ?? fromSnapshot(modelId)
}

/** Forget the cached catalog (tests). */
export function resetModelCatalog(): void {
  catalog = null
  catalogLoading = null
}

// Gateway effort levels, highest first.
const EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']

/**
 * The effort to request: `wanted` when the model lists it, otherwise the
 * nearest level it does list (the lower one on a tie: cheaper, and it leaves
 * more of max_tokens for the answer). undefined when the model exposes no
 * effort selection.
 */
export function pickEffort(supported: string[] | null | undefined, wanted = WANTED_EFFORT): string | undefined {
  if (supported === undefined) return undefined
  if (supported === null || supported.includes(wanted)) return wanted
  const target = EFFORT_ORDER.indexOf(wanted)
  let best: string | undefined
  let bestDistance = Infinity
  for (const effort of supported) {
    const i = EFFORT_ORDER.indexOf(effort)
    if (i < 0) continue // "none" and unknown values are never chosen
    const d = Math.abs(i - target)
    if (d < bestDistance || (d === bestDistance && i > EFFORT_ORDER.indexOf(best!))) {
      best = effort
      bestDistance = d
    }
  }
  return best
}

export interface CompletionOptions {
  jsonOnly: boolean
  webSearch: boolean
  maxTokens?: number
  effort?: string // reasoning effort to ask for; default medium
  // An exact output limit, reasoning included: sent as min(exactLimit, the
  // model's own limit), with no 1000 token floor and no doubling for reasoning.
  exactLimit?: number
}

/**
 * The request body for one chat completion. Only parameters the model lists
 * in its catalog `supported_parameters` are sent: Anthropic and OpenAI
 * reasoning models reject temperature, North rejects response_format.
 * Unknown models (no catalog, no snapshot) get model, messages and max_tokens.
 */
export function buildRequestBody(
  modelId: string,
  caps: ModelCapabilities | null,
  systemPrompt: string,
  userPrompt: string,
  opts: CompletionOptions
): Record<string, unknown> {
  const supported = new Set(caps?.supported_parameters ?? ['max_tokens'])
  const enforcedSystemPrompt = opts.jsonOnly
    ? `${systemPrompt}\n\nReturn valid JSON only. Do not include markdown or commentary.`
    : systemPrompt

  const body: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: 'system', content: enforcedSystemPrompt },
      { role: 'user', content: userPrompt },
    ],
  }

  if (supported.has('temperature')) body.temperature = 0.7

  const effort = supported.has('reasoning') ? pickEffort(caps?.supported_efforts, opts.effort ?? WANTED_EFFORT) : undefined
  if (effort) body.reasoning = { effort }

  // A truncated answer is unparseable JSON, which throws the work away.
  // Reasoning tokens count against the same limit, so double it when on.
  const answer = Math.max(1000, opts.maxTokens ?? DEFAULT_ANSWER_TOKENS)
  let limit = opts.exactLimit !== undefined ? Math.max(1, Math.floor(opts.exactLimit)) : effort ? answer * 2 : answer
  if (caps?.max_completion_tokens) limit = Math.min(limit, caps.max_completion_tokens)
  if (supported.has('max_tokens')) body.max_tokens = limit
  else if (supported.has('max_completion_tokens')) body.max_completion_tokens = limit

  // Real web access via OpenRouter's web plugin; cited sources come back as
  // message.annotations. A gateway feature, not a model parameter.
  if (opts.webSearch) body.plugins = [{ id: 'web', max_results: 4 }]

  // Strict JSON mode where the model has it. Skipped while web-searching:
  // the plugin and json_object mode don't reliably compose, and the JSON is
  // parsed out of the text anyway.
  const wantsJsonMode = opts.jsonOnly || modelId.startsWith('openai/')
  if (!opts.webSearch && wantsJsonMode && supported.has('response_format')) {
    body.response_format = { type: 'json_object' }
  }

  // No usage flag: OpenRouter documents `usage: { include: true }` as
  // deprecated with no effect on Chat Completions, and returns usage.cost
  // on every response.
  return body
}

export interface CallUsage {
  cost_usd: number
  cost_source: 'usage' | 'estimate' | 'none'
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
}

function count(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** Cost and tokens of one response: usage.cost when present, else priced from the catalog. */
export function usageFromResponse(data: any, caps: ModelCapabilities | null): CallUsage {
  const u = data?.usage ?? {}
  const prompt_tokens = count(u.prompt_tokens)
  const completion_tokens = count(u.completion_tokens)
  const reasoning_tokens = count(u.completion_tokens_details?.reasoning_tokens)
  const reported = typeof u.cost === 'number' ? u.cost : typeof u.cost === 'string' ? Number(u.cost) : NaN
  if (Number.isFinite(reported) && reported >= 0) {
    return { cost_usd: reported, cost_source: 'usage', prompt_tokens, completion_tokens, reasoning_tokens }
  }
  if (caps?.pricing && (prompt_tokens || completion_tokens)) {
    const estimate = prompt_tokens * caps.pricing.prompt + completion_tokens * caps.pricing.completion
    return { cost_usd: estimate, cost_source: 'estimate', prompt_tokens, completion_tokens, reasoning_tokens }
  }
  return { cost_usd: 0, cost_source: 'none', prompt_tokens, completion_tokens, reasoning_tokens }
}

// Node's fetch gives up after 300 s without response headers (undici's headersTimeout), with a
// TypeError that is not a timeout. OpenRouter answers a non-streaming request only when the model
// is done, and writing a whole code file can take longer than that. Each request has its own
// AbortSignal deadline, so the dispatcher's own timeouts are switched off.
const MODEL_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

/** A request that ran out of time: our own deadline, or one of undici's timeouts. */
export function isTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  const code = (e as Error & { cause?: { code?: unknown } }).cause?.code
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
}

async function requestCompletion(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  jsonOnly: boolean,
  webSearch = false,
  maxTokens?: number,
  assigned = modelId,
  timeoutMs = COMPLETION_TIMEOUT_MS,
  effort?: string,
  exactLimit?: number
): Promise<{ data: any; content: string; citations: WebCitation[]; usage: CallUsage }> {
  const caps = await getModelCapabilities(modelId)
  const requestBody = buildRequestBody(modelId, caps, systemPrompt, userPrompt, { jsonOnly, webSearch, maxTokens, effort, exactLimit })

  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://observable-lab.vercel.app',
      'X-Title': 'Observable Multi-Agent Lab',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: MODEL_DISPATCHER,
  } as RequestInit);

  if (!response.ok) {
    // Log full error server-side only, return generic message to client
    const errorBody = await response.text();
    console.error(`[API] Model call failed: ${response.status}`, errorBody.slice(0, 2000));
    throw new Error(`Model service error (${response.status})`);
  }

  const data = await response.json();
  // Billed as soon as it answered, whether or not the content parses.
  const usage = usageFromResponse(data, caps)
  const answeredBy = typeof data?.model === 'string' && data.model ? data.model : modelId
  await recordModelCall({ model: modelId, assigned, ...usage })
  if (usage.cost_source !== 'usage') {
    console.warn(`[MODEL] ${answeredBy} response had no usage.cost; recorded ${usage.cost_source} $${usage.cost_usd.toFixed(6)}`)
  }

  const choice = data.choices?.[0] ?? {};
  const message = choice.message ?? {};
  // A refusal is billed (recorded above) but has nothing to parse.
  if (choice.finish_reason === 'content_filter' || choice.native_finish_reason === 'refusal') {
    const reason = choice.native_finish_reason || choice.finish_reason
    console.warn(`[MODEL] ${modelId} refused the request (finish_reason=${choice.finish_reason}, native=${choice.native_finish_reason ?? 'n/a'})`)
    throw new ModelRefusalError(modelId, String(reason), usage)
  }
  // Cut off at the output limit: whatever is in content or reasoning is not
  // the answer (a stray JSON fragment from the reasoning once parsed as one).
  if (choice.finish_reason === 'length') {
    console.warn(`[MODEL] ${modelId} was cut off at max_tokens (${usage.completion_tokens} completion tokens, ${usage.reasoning_tokens} reasoning)`)
    throw new ModelTruncatedError(modelId, usage)
  }
  // Some models (e.g. reasoning models) return the answer in content, but if
  // content is empty and reasoning holds the text, fall back to it so we don't
  // discard a usable response. finish_reason is logged to diagnose emptiness.
  let content = message.content || '';
  if (!content && typeof message.reasoning === 'string') content = message.reasoning;
  if (!content) console.warn(`[MODEL] ${modelId} returned empty content (finish_reason=${choice.finish_reason})`);

  return { data, content, citations: extractCitations(message), usage };
}

// Which model actually produced an output. Attached to object outputs as
// `served_by` so it is stored with the role output and shown in the log.
export interface ServedBy {
  model: string      // the model ID that answered (the assigned one, or the fallback)
  assigned: string   // the model the role was assigned to
  fallback: boolean  // true when the assigned model failed and a substitute answered
  reported?: string  // the model name OpenRouter reported for the answering call
}

/** The model that answered a stored output: the fallback model if one stepped in, else `assigned`. */
export function answeredModel(output: unknown, assigned: string): string {
  const servedBy = output && typeof output === 'object'
    ? (output as { served_by?: Partial<ServedBy> }).served_by
    : undefined
  return servedBy?.fallback && typeof servedBy.model === 'string' && servedBy.model ? servedBy.model : assigned
}

export interface CallModelResult {
  output: any
  cost: number            // real USD for every billed attempt, fallbacks included
  citations: WebCitation[]
  servedBy: ServedBy
  usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; requests: number }
}

export async function callModel(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  opts: {
    webSearch?: boolean
    maxTokens?: number
    noFallback?: boolean
    // Longest a single request may run (default OPENROUTER_TIMEOUT_MS, 240 s).
    timeoutMs?: number
    // Wall-clock time (ms since epoch) by which the whole call, retries and
    // fallbacks included, must be over. Each request gets what is left, and
    // nothing new starts with under MIN_REQUEST_MS remaining.
    deadlineAt?: number
    // Reasoning effort to ask for (default medium). Code writing uses low:
    // the answer is long, and reasoning shares its output budget.
    effort?: string
    // Time kept back from the assigned model's requests so a fallback can
    // still run before deadlineAt (code writing, where one request is long).
    fallbackReserveMs?: number
    // Whether a parsed answer has the shape the caller needs. A parsed answer
    // that fails it counts as no answer: the assigned model is not asked
    // again (it answered, just wrongly) and the fallbacks are tried.
    accept?: (parsed: unknown) => boolean
  } = {}
): Promise<CallModelResult> {

  if (!OPENROUTER_API_KEY) {
    // Generic error - don't reveal env var names
    console.error('[CONFIG] Model API key not configured');
    throw new Error('Model service not configured');
  }

  console.log(`[MODEL] Calling ${modelId}${opts.webSearch ? ' (web search)' : ''}...`);

  let data: any;
  let content = '';
  let parsed: unknown;
  let citations: WebCitation[] = [];
  let lastError: Error | null = null;
  let answeredBy = modelId;
  let cost = 0
  const usage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, requests: 0 }
  const tally = (u: CallUsage) => {
    cost += u.cost_usd
    usage.prompt_tokens += u.prompt_tokens
    usage.completion_tokens += u.completion_tokens
    usage.reasoning_tokens += u.reasoning_tokens
    usage.requests++
  }

  const MIN_REQUEST_MS = 20_000
  const requestTimeout = (reserve = 0): number => {
    const base = opts.timeoutMs ?? COMPLETION_TIMEOUT_MS
    return opts.deadlineAt ? Math.min(base, opts.deadlineAt - Date.now() - reserve) : base
  }
  // A request that ran out of time would very likely run out again with the
  // same prompt, so a timeout goes straight to the fallback instead.
  const isTimeout = isTimeoutError
  const reserve = opts.noFallback ? 0 : opts.fallbackReserveMs ?? 0
  let wrongShape = false
  let outOfTime = false

  // Try up to 3 times with increasing JSON enforcement. Web search and strict
  // json_object mode don't reliably compose, so after the first attempt we
  // DROP web search and turn strict JSON back on — grounding is best-effort,
  // but a parseable response is not (a flubbed one throws away the epoch).
  for (let attempt = 0; attempt < 3; attempt++) {
    const jsonOnly = attempt > 0;
    const useWeb = opts.webSearch && attempt === 0;
    const timeoutMs = requestTimeout(reserve)
    if (timeoutMs < MIN_REQUEST_MS) {
      // Out of time for the assigned model; the reserve, if any, is for a fallback.
      outOfTime = reserve === 0
      lastError = new Error('Model call skipped: out of time')
      console.warn(`[MODEL] ${modelId}: out of time before attempt ${attempt + 1}`)
      break
    }
    try {
      const result = await requestCompletion(modelId, systemPrompt, userPrompt, jsonOnly, useWeb, opts.maxTokens, modelId, timeoutMs, opts.effort);
      tally(result.usage)
      data = result.data;
      content = result.content || '';
      if (result.citations.length) citations = result.citations; // keep first-attempt sources
      parsed = extractJson(content);
      if (parsed !== undefined && opts.accept && !opts.accept(parsed)) {
        parsed = undefined
        wrongShape = true
        lastError = new Error('Model answer did not have the expected shape')
        console.warn(`[MODEL] ${modelId} answered, but not in the expected shape; trying a fallback`)
      }
      break;
    } catch (e) {
      lastError = e as Error;
      if (e instanceof ModelRefusalError) {
        tally(e.usage) // billed, so it counts toward this call's cost
        break // the same prompt gets the same refusal
      }
      if (e instanceof ModelTruncatedError) {
        tally(e.usage) // billed; the same request would be cut off again
        break
      }
      if (isTimeout(e)) {
        console.warn(`[MODEL] ${modelId} timed out after ${Math.round(timeoutMs / 1000)} s; not retrying the same model`)
        break
      }
      if (attempt < 2) {
        console.warn(`[PARSE] Attempt ${attempt + 1} failed for ${modelId}, retrying...`);
        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      console.error(`[PARSE] All attempts failed for ${modelId}. Last content:`, content.substring(0, 500));
    }
  }

  // RESILIENCE: if the assigned model never produced a usable response (empty
  // content or unparseable JSON, e.g. a flaky provider), fall back to a
  // reliable substitute so ONE bad model call can't kill the whole epoch —
  // roles depend on each other, so a dead planner/executor is fatal otherwise.
  if (parsed === undefined && !opts.noFallback && !outOfTime) {
    // A refusal comes from the lab's own policy, so another model from the
    // same lab refuses the same prompt; go straight to a different lab.
    const refusedBy = new Set<string>()
    if (lastError instanceof ModelRefusalError) refusedBy.add(providerOf(modelId))
    const fallbacks = FALLBACK_MODELS.filter(m => m !== modelId);
    for (const fb of fallbacks) {
      if (refusedBy.has(providerOf(fb))) {
        console.warn(`[MODEL] skipping fallback ${fb}: ${providerOf(fb)} already refused this prompt`);
        continue;
      }
      const fbTimeout = requestTimeout()
      if (fbTimeout < MIN_REQUEST_MS) {
        console.warn(`[MODEL] no time left to try fallback ${fb} for ${modelId}`)
        break
      }
      try {
        console.warn(`[MODEL] ${modelId} failed — falling back to ${fb}`);
        const result = await requestCompletion(fb, systemPrompt, userPrompt, true, false, opts.maxTokens, modelId, fbTimeout, opts.effort);
        tally(result.usage)
        parsed = extractJson(result.content || '');
        if (parsed !== undefined && opts.accept && !opts.accept(parsed)) {
          parsed = undefined
          wrongShape = true
          lastError = new Error('Model answer did not have the expected shape')
          console.warn(`[MODEL] fallback ${fb} answered, but not in the expected shape`)
          continue
        }
        if (parsed === undefined) {
          lastError = new Error('Model answer could not be parsed')
          continue
        }
        data = result.data;
        answeredBy = fb;
        console.log(`[MODEL] fallback ${fb} succeeded for ${modelId}'s call`);
        break;
      } catch (e) {
        lastError = e as Error;
        if (e instanceof ModelRefusalError) {
          tally(e.usage)
          refusedBy.add(providerOf(fb))
        }
        if (e instanceof ModelTruncatedError) tally(e.usage)
      }
    }
  }

  if (parsed === undefined) {
    if (cost > 0) console.warn(`[MODEL] ${modelId} gave no usable answer after $${cost.toFixed(4)} of billed attempts`)
    // Say why, so the record can tell a timeout from a cut-off from a wrong answer.
    const why = lastError?.message ? `: ${lastError.message}` : wrongShape ? ': wrong shape' : ''
    throw new Error(`Model returned invalid response${why}`.slice(0, 300));
  }

  const fallback = answeredBy !== modelId;
  const reported = typeof data?.model === 'string' && data.model.length <= 200 ? data.model : '';
  const servedBy: ServedBy = { model: answeredBy, assigned: modelId, fallback, ...(reported ? { reported } : {}) };
  console.log(fallback
    ? `[MODEL] ${modelId} failed; ${servedBy.model} answered instead`
    : `[MODEL] ${modelId} responded successfully`)
  // Record attribution with the output itself, so every stored role output
  // says who answered and whether a fallback happened.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    (parsed as Record<string, unknown>).served_by = servedBy;
  }

  return { output: parsed, cost, citations, servedBy, usage };
}

export type CallOnceResult =
  | { ok: true; parsed: unknown; usage: CallUsage }
  | { ok: false; reason: 'refused' | 'truncated' | 'timeout' | 'unparseable' | 'error'; usage: CallUsage | null }

/**
 * One request to one model, for work whose every call is counted and capped
 * by its caller (the Socratic lesson's teacher, tinker-tutor-run.ts). JSON
 * mode, an exact output limit (reasoning included), no retry and no fallback.
 * The ledger row is written by requestCompletion as for every call. Never
 * throws: a failure is a reason, with the usage when the call was billed.
 */
export async function callModelOnce(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokensExact: number; effort?: string; timeoutMs?: number },
): Promise<CallOnceResult> {
  if (!OPENROUTER_API_KEY) return { ok: false, reason: 'error', usage: null }
  let result: { content: string; usage: CallUsage }
  try {
    result = await requestCompletion(modelId, systemPrompt, userPrompt, true, false, undefined, modelId, opts.timeoutMs ?? COMPLETION_TIMEOUT_MS, opts.effort, opts.maxTokensExact)
  } catch (e) {
    if (e instanceof ModelRefusalError) return { ok: false, reason: 'refused', usage: e.usage }
    if (e instanceof ModelTruncatedError) return { ok: false, reason: 'truncated', usage: e.usage }
    if (isTimeoutError(e)) return { ok: false, reason: 'timeout', usage: null }
    return { ok: false, reason: 'error', usage: null }
  }
  try {
    const parsed = extractJson(result.content || '')
    if (parsed === undefined) return { ok: false, reason: 'unparseable', usage: result.usage }
    return { ok: true, parsed, usage: result.usage }
  } catch {
    return { ok: false, reason: 'unparseable', usage: result.usage }
  }
}
