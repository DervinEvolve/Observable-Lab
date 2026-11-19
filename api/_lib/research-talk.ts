/**
 * Asking the research loop's best model for a story
 * (docs/TOOLS.md, "The research model talks").
 *
 *   GET  /api/experiment/research-talk   the model that can be asked, and the limits
 *   POST /api/experiment/research-talk   { prompt } -> { story }
 *
 * Off unless LAB_ENABLE_RESEARCH_TALK is "true" and this server knows the
 * research runner's models endpoint (RESEARCH_RUNNER_MODELS_URL) and its
 * token. While it is off, GET says so and POST answers 503, neither touches
 * the database or the network, and the research loop asks the runner for
 * nothing new: its request to start a run is the one it always sent.
 *
 * While it is on, three things happen:
 *
 * 1. A research run is started with a key (e<epoch>-<8 hex of the experiment
 *    id>). The runner then saves the model that run trained as a candidate
 *    (modal/research_runner.py, "Keeping a model"), and says in the run's
 *    result whether it could. That is recorded on the epoch.
 * 2. When the Reviewer keeps the run as the new best, the lab asks the runner
 *    to promote that candidate. The runner samples it once by itself, and
 *    only a model whose sample worked is offered to visitors.
 * 3. A visitor may send one line and get a short story back. The model is
 *    loaded and run only inside a sandbox on Modal with no network; this
 *    server sends the line and receives plain text.
 *
 * Anyone can call the route, so everything about a call is bounded here: one
 * line of at most 200 plain characters, a fixed number of new bytes, a few
 * stories per visitor in ten minutes and in a day, and a number of stories
 * for all visitors in a day (LAB_RESEARCH_TALK_DAILY). Each story is written
 * to the spend ledger as a small flat estimate, so it counts inside the
 * lab's daily budget.
 *
 * A visitor is counted the way the trained chat counts one: by keyed hashes
 * of the address, and of the address with the browser string, new every day.
 * What a visitor writes is sent to the runner to be continued and is not
 * stored or logged by the lab: a call leaves a row of counts.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { requireHttpsUrl } from './config.js'
import { checkDailyBudget, recordModelCall, withSpendContext } from './spend.js'
import { sanitizeOutput } from './sprites.js'
import { addressHash, utcDay, visitorHash } from './tinker-store.js'

export const RESEARCH_TALK_PURPOSE = 'research_talk'
/** The line a visitor writes, in characters. */
export const RESEARCH_TALK_MAX_PROMPT_CHARS = 200
export const RESEARCH_TALK_DEFAULT_PROMPT = 'Once upon a time'
/** New bytes in one story. The model's tokens are single bytes, so 200 is about forty words. */
export const DEFAULT_RESEARCH_TALK_MAX_NEW = 200
export const RESEARCH_TALK_HARD_MAX_NEW = 500
/** Stories for all visitors in one UTC day. */
export const DEFAULT_RESEARCH_TALK_DAILY = 200
export const RESEARCH_TALK_HARD_DAILY = 2000
/** What one story is written to the ledger as, in dollars. A flat estimate that errs high. */
export const DEFAULT_RESEARCH_TALK_USD_PER_STORY = 0.005
export const RESEARCH_TALK_HARD_USD_PER_STORY = 0.25
/** Stories one visitor (an address and a browser string) may ask for: in ten minutes, and in a UTC day. */
export const RESEARCH_TALK_PER_WINDOW = 3
export const RESEARCH_TALK_WINDOW_S = 600
export const RESEARCH_TALK_PER_DAY = 10
/** Stories one address may ask for, whatever browser string comes with them. */
export const RESEARCH_TALK_ADDRESS_PER_WINDOW = 6
export const RESEARCH_TALK_ADDRESS_PER_DAY = 20
export const RESEARCH_TALK_MAX_BODY_BYTES = 4 * 1024
/** A story waits for a sandbox to start, load the model and write. */
export const RESEARCH_TALK_TIMEOUT_MS = 105_000
export const RESEARCH_TALK_PROMOTE_TIMEOUT_MS = 45_000
const INFO_TIMEOUT_MS = 20_000
const INFO_TTL_MS = 60_000

/** Shown beside the story box. Plain, and no dashes. */
export const RESEARCH_TALK_NOTICE = 'It does not answer questions. It carries on from the line you give it, and nobody reviews what it writes.'

const MESSAGES = {
  off: 'Stories from the research model are switched off.',
  budget: 'The lab has reached today\'s number of stories. It opens again at 00:00 UTC.',
  rate: 'That is a lot of stories in a short time. Give it a few minutes and try again.',
  day: 'You have reached today\'s story limit. It starts again at 00:00 UTC.',
  none: 'No story model has been saved yet. The next run the research loop keeps as its best will be saved.',
  busy: 'The model did not write this time. Please try again in a moment.',
  unavailable: 'Stories are not available just now. Please try again later.',
}

function flag(name: string): boolean {
  return (process.env[name] || '').trim() === 'true'
}
function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] || '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function researchTalkFlag(): boolean {
  return flag('LAB_ENABLE_RESEARCH_TALK')
}
/** Stories for all visitors in one UTC day. 0 switches stories off and keeps saving on. */
export function researchTalkDaily(): number {
  return Math.floor(boundedNumber('LAB_RESEARCH_TALK_DAILY', DEFAULT_RESEARCH_TALK_DAILY, 0, RESEARCH_TALK_HARD_DAILY))
}
export function researchTalkMaxNew(): number {
  return Math.floor(boundedNumber('LAB_RESEARCH_TALK_MAX_NEW', DEFAULT_RESEARCH_TALK_MAX_NEW, 20, RESEARCH_TALK_HARD_MAX_NEW))
}
export function researchTalkUsdPerStory(): number {
  return boundedNumber('LAB_RESEARCH_TALK_USD_PER_STORY', DEFAULT_RESEARCH_TALK_USD_PER_STORY, 0, RESEARCH_TALK_HARD_USD_PER_STORY)
}

function modelsUrl(): string {
  return requireHttpsUrl('RESEARCH_RUNNER_MODELS_URL', 'the research runner\'s kept models')
}
function runnerToken(): string {
  return (process.env.RESEARCH_RUNNER_TOKEN || '').trim()
}

export interface ResearchTalkStatus { enabled: boolean; off_reason?: string }

/**
 * Is the lab saving research models and promoting the kept ones? This is
 * what the research loop asks. The flag, the runner's models endpoint and
 * its token must all be there; with any of them missing nothing is saved,
 * since a saved model could never be promoted or asked for anything.
 */
export function researchTalkStatus(): ResearchTalkStatus {
  if (!researchTalkFlag()) return { enabled: false, off_reason: 'LAB_ENABLE_RESEARCH_TALK is not true' }
  try {
    modelsUrl()
  } catch {
    return { enabled: false, off_reason: 'RESEARCH_RUNNER_MODELS_URL is not set to an https:// URL' }
  }
  if (!runnerToken()) return { enabled: false, off_reason: 'RESEARCH_RUNNER_TOKEN is not set' }
  return { enabled: true }
}

/** May visitors ask for stories? The same, and a daily number above 0. */
export function researchStoryStatus(): ResearchTalkStatus {
  const status = researchTalkStatus()
  if (!status.enabled) return status
  if (!(researchTalkDaily() > 0)) return { enabled: false, off_reason: 'LAB_RESEARCH_TALK_DAILY is 0' }
  return { enabled: true }
}

const KEY = /^(?:e[0-9]{1,6}|owner)-[0-9a-f]{8}$/
const EPOCH_KEY = /^e([0-9]{1,6})-([0-9a-f]{8})$/

/**
 * The key one research run's model is saved under: its epoch and the first
 * eight hex characters of its experiment's id. Null when the id is not a
 * UUID, in which case nothing is saved.
 */
export function researchModelKey(experimentId: string, epochNumber: number): string | null {
  const hex = String(experimentId || '').replace(/-/g, '').toLowerCase().slice(0, 8)
  if (!/^[0-9a-f]{8}$/.test(hex) || !Number.isSafeInteger(epochNumber) || epochNumber < 1 || epochNumber > 999_999) return null
  return `e${epochNumber}-${hex}`
}

// ---------------------------------------------------------------------------
// The runner's kept models
// ---------------------------------------------------------------------------

export interface StoryModel {
  key: string
  /** "epoch" for a run the loop kept, "owner_rerun" for one the owner trained by hand. */
  source: 'epoch' | 'owner_rerun'
  epoch: number | null
  /** Printed by the generated train.py itself. */
  val_bpb: number | null
  params_m: number | null
  budget_s: number | null
  promoted_at: number | null
  model_sha256: string | null
  /** The runner's own sample of the model: null while it has not run. */
  check: { ok: boolean; reason: string | null } | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// Printable ASCII on one line: for anything a sandbox or a model said.
function plain(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return sanitizeOutput(v).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** One kept model as the runner lists it, strictly read. Null for anything that is not one. */
export function readStoryModel(raw: unknown): StoryModel | null {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!o || typeof o.key !== 'string' || !KEY.test(o.key)) return null
  const epochKey = EPOCH_KEY.exec(o.key)
  const check = o.check && typeof o.check === 'object' && !Array.isArray(o.check) ? o.check as Record<string, unknown> : null
  const bpb = num(o.val_bpb)
  const params = num(o.params_m) ?? (num(o.params) !== null ? (num(o.params) as number) / 1e6 : null)
  return {
    key: o.key,
    source: epochKey ? 'epoch' : 'owner_rerun',
    epoch: epochKey ? Number(epochKey[1]) : null,
    val_bpb: bpb !== null && bpb >= 0 ? bpb : null,
    params_m: params !== null && params > 0 && params < 1e6 ? params : null,
    budget_s: num(o.budget_s),
    promoted_at: num(o.promoted_at),
    model_sha256: typeof o.model_sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.model_sha256) ? o.model_sha256 : null,
    check: check && typeof check.ok === 'boolean' ? { ok: check.ok, reason: plain(check.reason, 200) || null } : null,
  }
}

async function callRunner(body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(modelsUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runnerToken()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`the runner's models endpoint answered ${res.status}`)
  return res.json()
}

/** The kept models, newest first. Throws when the runner cannot be asked. */
export async function listStoryModels(): Promise<StoryModel[]> {
  const data = await callRunner({ action: 'info' }, INFO_TIMEOUT_MS) as { models?: unknown }
  const list = Array.isArray(data?.models) ? data.models : []
  return list.slice(0, 10).map(readStoryModel).filter((m): m is StoryModel => m !== null)
}

export interface Promotion { ok: boolean; at: string; error?: string }

/**
 * Asks the runner to keep the model saved under `key`: called when the
 * Reviewer keeps that run as the new best. Never throws. Asking twice is the
 * same as asking once.
 */
export async function promoteResearchModel(key: string): Promise<Promotion> {
  const at = new Date().toISOString()
  if (!EPOCH_KEY.test(key)) return { ok: false, at, error: 'not a model key' }
  try {
    const data = await callRunner({ action: 'promote', key }, RESEARCH_TALK_PROMOTE_TIMEOUT_MS) as Record<string, unknown>
    infoCache = null
    if (data?.ok === true) return { ok: true, at }
    return { ok: false, at, error: plain(data?.error, 200) || 'the runner did not keep it' }
  } catch (e) {
    return { ok: false, at, error: plain(e instanceof Error ? e.message : String(e), 200) || 'the runner could not be asked' }
  }
}

export interface StoryView {
  /** The newest kept model whose sample worked: the one a story comes from. */
  talk: StoryModel | null
  /** The newest kept model, when it is not that one (still being checked, or its sample failed). */
  newest: StoryModel | null
  /**
   * The epoch of the research loop's current best, when that is a later
   * epoch of the same experiment than the model that talks: the heading must
   * not call an older model the best one.
   */
  best_epoch: number | null
}

let infoCache: { at: number; view: StoryView } | null = null
/** Forgets what was last read from the runner. For tests, and after a promotion. */
export function resetResearchTalkCache(): void {
  infoCache = null
}

async function currentBest(): Promise<{ hex: string; epoch: number } | null> {
  try {
    const r = await sql`
      SELECT id, current_spec->'meta'->'research'->'best_epoch' AS best_epoch FROM experiments
      WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object'
      ORDER BY created_at DESC LIMIT 1
    `
    const row = r.rows[0]
    const epoch = Number(row?.best_epoch)
    const hex = String(row?.id ?? '').replace(/-/g, '').toLowerCase().slice(0, 8)
    return row && Number.isSafeInteger(epoch) && /^[0-9a-f]{8}$/.test(hex) ? { hex, epoch } : null
  } catch {
    return null
  }
}

/** What the room is told about the story model. Read from the runner at most once a minute per server instance. */
export async function storyView(now: number = Date.now()): Promise<StoryView> {
  if (infoCache && now - infoCache.at < INFO_TTL_MS) return infoCache.view
  const models = await listStoryModels()
  const talk = models.find(m => m.check?.ok === true) ?? null
  const newest = models[0] && models[0].key !== talk?.key ? models[0] : null
  let best_epoch: number | null = null
  const epochKey = talk ? EPOCH_KEY.exec(talk.key) : null
  if (epochKey) {
    const best = await currentBest()
    if (best && best.hex === epochKey[2] && best.epoch > Number(epochKey[1])) best_epoch = best.epoch
  }
  const view = { talk, newest, best_epoch }
  infoCache = { at: now, view }
  return view
}

// ---------------------------------------------------------------------------
// What the database holds: counts, and one row per story with no text in it
// ---------------------------------------------------------------------------

let tablesReady: Promise<void> | null = null
export function ensureResearchTalkTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS research_talk_rate (
          who TEXT NOT NULL,
          bucket TEXT NOT NULL,
          n INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          PRIMARY KEY (who, bucket)
        )
      `
      await sql`
        CREATE TABLE IF NOT EXISTS research_talk_calls (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          model_key TEXT NOT NULL,
          status TEXT NOT NULL,
          stage TEXT,
          prompt_chars INTEGER NOT NULL DEFAULT 0,
          new_bytes INTEGER NOT NULL DEFAULT 0,
          stopped TEXT,
          cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          duration_ms INTEGER
        )
      `
    })().catch(e => {
      tablesReady = null
      throw e
    })
  }
  return tablesReady
}

/**
 * Counts one story in one bucket, or refuses it. One statement: the row is
 * made at 1, or raised by 1 only while it is under the limit. No row back
 * means the limit is reached.
 */
export async function countStory(who: string, bucket: string, limit: number): Promise<boolean> {
  if (!(limit > 0)) return false
  await ensureResearchTalkTables()
  const r = await sql`
    INSERT INTO research_talk_rate (who, bucket, n) VALUES (${who}, ${bucket}, 1)
    ON CONFLICT (who, bucket) DO UPDATE SET n = research_talk_rate.n + 1
    WHERE research_talk_rate.n < ${limit}
    RETURNING n
  `
  return Boolean(r.rows[0])
}

async function pruneCounts(now: Date): Promise<void> {
  try {
    await sql`DELETE FROM research_talk_rate WHERE created_at < ${new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()}`
  } catch {
    // housekeeping only
  }
}

interface StoryCall {
  modelKey: string
  status: string
  stage: string | null
  promptChars: number
  newBytes: number
  stopped: string | null
  costUsd: number
  durationMs: number
}

async function recordStoryCall(call: StoryCall): Promise<void> {
  try {
    await ensureResearchTalkTables()
    await sql`
      INSERT INTO research_talk_calls (model_key, status, stage, prompt_chars, new_bytes, stopped, cost_usd, duration_ms)
      VALUES (${call.modelKey}, ${call.status.slice(0, 40)}, ${call.stage ? call.stage.slice(0, 40) : null}, ${call.promptChars},
        ${call.newBytes}, ${call.stopped}, ${call.costUsd}, ${Math.round(call.durationMs)})
    `
  } catch (e) {
    console.warn('[research-talk] could not store a call record:', e instanceof Error ? e.message : e)
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export type StoryRefusal = { ok: false; status: number; error: string; message: string }
export interface StoryRequest { ok: true; prompt: string; chars: number }

/** One line of printable ASCII. The model was trained on plain English bytes; anything else becomes a space. */
export function cleanStoryPrompt(text: string): string {
  return text.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, RESEARCH_TALK_MAX_PROMPT_CHARS)
}

/**
 * Reads what a visitor's browser sent. Strict: an object with "prompt" and
 * nothing else. An empty line means the default opening.
 */
export function readStoryRequest(raw: unknown): StoryRequest | StoryRefusal {
  const bad = (message: string, error = 'invalid_request'): StoryRefusal => ({ ok: false, status: 400, error, message })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Send a JSON object with "prompt".')
  const req = raw as Record<string, unknown>
  if (Object.keys(req).some(k => k !== 'prompt')) return bad('Only "prompt" is accepted.')
  if (req.prompt !== undefined && typeof req.prompt !== 'string') return bad('"prompt" must be text.')
  const sent = typeof req.prompt === 'string' ? req.prompt : ''
  if (sent.length > RESEARCH_TALK_MAX_PROMPT_CHARS) return bad(`The opening line may be at most ${RESEARCH_TALK_MAX_PROMPT_CHARS} characters.`, 'too_long')
  const prompt = cleanStoryPrompt(sent) || RESEARCH_TALK_DEFAULT_PROMPT
  return { ok: true, prompt, chars: prompt.length }
}

export type StoryAnswer =
  | { ok: true; continuation: string; stopped: 'end' | 'limit' | 'time' }
  | { ok: false; stage: string }

/**
 * What the runner answered, strictly read. Only the new text is taken, cut
 * to `maxNew` characters and to printable ASCII and line breaks; the prompt
 * shown to the visitor is the one this server sent.
 */
export function readStoryAnswer(raw: unknown, maxNew: number): StoryAnswer {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!o || o.status !== 'ok' || typeof o.continuation !== 'string') {
    const stage = typeof o?.stage === 'string' && /^[a-z_]{1,24}$/.test(o.stage) ? o.stage : 'runner'
    return { ok: false, stage }
  }
  const continuation = sanitizeOutput(o.continuation.slice(0, 4 * maxNew)).replace(/[^\x20-\x7e\n]/g, '').slice(0, maxNew)
  const stopped = o.stopped === 'end' || o.stopped === 'time' ? o.stopped : 'limit'
  return { ok: true, continuation, stopped }
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
function say(res: VercelResponse, status: number, error: string, message: string) {
  return res.status(status).json({ error, message })
}

const publicModel = (m: StoryModel) => ({
  key: m.key, source: m.source, epoch: m.epoch, val_bpb: m.val_bpb, params_m: m.params_m, budget_s: m.budget_s,
})
export const storyLimits = () => ({ max_prompt_chars: RESEARCH_TALK_MAX_PROMPT_CHARS, max_new_bytes: researchTalkMaxNew() })

export async function handleResearchTalk(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const status = researchStoryStatus()
  if (req.method === 'GET') {
    if (!status.enabled) return res.status(200).json({ enabled: false, model: null })
    try {
      const view = await storyView()
      return res.status(200).json({
        enabled: true,
        model: view.talk ? publicModel(view.talk) : null,
        // The newest kept model when it is not the one that talks, and why not.
        ...(view.newest ? { newest: { epoch: view.newest.epoch, source: view.newest.source, checked: view.newest.check !== null } } : {}),
        ...(view.best_epoch !== null ? { best_epoch: view.best_epoch } : {}),
        limits: storyLimits(), notice: RESEARCH_TALK_NOTICE, default_prompt: RESEARCH_TALK_DEFAULT_PROMPT,
      })
    } catch (e) {
      console.warn('[research-talk] could not read the kept models:', e instanceof Error ? e.message : e)
      return res.status(200).json({ enabled: true, model: null, limits: storyLimits(), notice: RESEARCH_TALK_NOTICE, default_prompt: RESEARCH_TALK_DEFAULT_PROMPT, unavailable: true })
    }
  }

  if (!status.enabled) return say(res, 503, 'off', researchTalkFlag() ? MESSAGES.unavailable : MESSAGES.off)

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
  if (size > RESEARCH_TALK_MAX_BODY_BYTES) return say(res, 413, 'too_long', 'The request is too large.')
  const story = readStoryRequest(raw)
  if (!story.ok) return say(res, story.status, story.error, story.message)

  // ---- one visitor's share: counted by the database, by hashes only ----
  const now = new Date()
  const ip = visitorAddress(req)
  const address = addressHash(ip, now)
  const visitor = visitorHash(ip, header(req, 'user-agent'), now)
  const windowBucket = `w:${Math.floor(now.getTime() / 1000 / RESEARCH_TALK_WINDOW_S)}`
  const dayBucket = `d:${utcDay(now)}`
  try {
    for (const [who, perWindow] of [[address, RESEARCH_TALK_ADDRESS_PER_WINDOW], [visitor, RESEARCH_TALK_PER_WINDOW]] as const) {
      if (!(await countStory(who, windowBucket, perWindow))) {
        res.setHeader('Retry-After', String(RESEARCH_TALK_WINDOW_S))
        return say(res, 429, 'rate', MESSAGES.rate)
      }
    }
    for (const [who, perDay] of [[address, RESEARCH_TALK_ADDRESS_PER_DAY], [visitor, RESEARCH_TALK_PER_DAY]] as const) {
      if (!(await countStory(who, dayBucket, perDay))) return say(res, 429, 'rate', MESSAGES.day)
    }
  } catch (e) {
    console.warn('[research-talk] could not count a story:', e instanceof Error ? e.message : e)
    return say(res, 503, 'unavailable', MESSAGES.unavailable)
  }
  if (Math.random() < 0.02) void pruneCounts(now)

  // ---- the model ----
  let found: StoryModel | null
  try {
    found = (await storyView()).talk
  } catch (e) {
    console.warn('[research-talk] could not read the kept models:', e instanceof Error ? e.message : e)
    return say(res, 503, 'unavailable', MESSAGES.unavailable)
  }
  if (!found) return say(res, 404, 'no_model', MESSAGES.none)
  const model = found

  // ---- today's share: the lab's budget, then the number of stories for everyone ----
  const budget = await checkDailyBudget(now)
  if (!budget.allowed) return say(res, budget.spent_usd === null ? 503 : 429, budget.spent_usd === null ? 'unavailable' : 'budget', budget.spent_usd === null ? MESSAGES.unavailable : MESSAGES.budget)
  try {
    if (!(await countStory('all', dayBucket, researchTalkDaily()))) return say(res, 429, 'budget', MESSAGES.budget)
  } catch (e) {
    console.warn('[research-talk] could not count a story:', e instanceof Error ? e.message : e)
    return say(res, 503, 'unavailable', MESSAGES.unavailable)
  }

  // ---- the call ----
  const maxNew = researchTalkMaxNew()
  const started = Date.now()
  let answer: StoryAnswer
  try {
    answer = readStoryAnswer(await callRunner({ action: 'sample', key: model.key, prompt: story.prompt, max_new: maxNew }, RESEARCH_TALK_TIMEOUT_MS), maxNew)
  } catch (e) {
    // The kind of failure only: an error line could repeat what the visitor wrote.
    answer = { ok: false, stage: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'unreachable' }
  }
  // A sandbox ran, or may have: the story is counted at its flat estimate
  // either way, so the ledger fills from estimates that err high.
  const costUsd = researchTalkUsdPerStory()
  if (costUsd > 0) {
    await withSpendContext({ purpose: RESEARCH_TALK_PURPOSE }, () => recordModelCall({
      model: 'tool/research_talk', assigned: `research:${model.key}`, cost_usd: costUsd, cost_source: 'estimate',
      prompt_tokens: story.chars, completion_tokens: answer.ok ? answer.continuation.length : 0, reasoning_tokens: 0,
    }))
  }
  await recordStoryCall({
    modelKey: model.key, status: answer.ok ? 'ok' : 'error', stage: answer.ok ? null : answer.stage, promptChars: story.chars,
    newBytes: answer.ok ? answer.continuation.length : 0, stopped: answer.ok ? answer.stopped : null, costUsd, durationMs: Date.now() - started,
  })
  if (!answer.ok) {
    console.warn(`[research-talk] no story (${answer.stage})`)
    // A model that can no longer be sampled should not be offered for another minute on the strength of an old check.
    if (answer.stage !== 'timeout' && answer.stage !== 'unreachable') infoCache = null
    return say(res, answer.stage === 'timeout' ? 504 : 502, 'busy', MESSAGES.busy)
  }
  return res.status(200).json({
    model: publicModel(model),
    prompt: story.prompt,
    continuation: answer.continuation,
    story: story.prompt + answer.continuation,
    stopped: answer.stopped,
  })
}
