// Names for trained adapters (LAB_ENABLE_TINKER_NAMES) and keeping the best
// ones (LAB_ENABLE_TINKER_KEEP): what a name may be, that a refused name never
// refuses the run, where a name is shown; who may keep an adapter, the caps
// the database holds, what the runner is sent and what is recorded, that only
// the owner can unkeep, and that none of it exists while the switches are off.
//
// No network, no database, no secrets. The harness is the one of
// tests/tinker.test.mjs (fetch answers like the lab's runner on Modal, and
// `@vercel/postgres` is an in-memory fake), with the statements naming and
// keeping add understood on top of it, including the one conditional INSERT
// that holds the number of kept adapters.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-tinker-keep-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')

const FAKE_PG = join(build, 'fake-postgres.js')
writeFileSync(FAKE_PG, `
export const db = { handler: null }
export function sql(strings, ...values) {
  const text = (Array.isArray(strings) ? strings.join('?') : String(strings)).replace(/\\s+/g, ' ').trim()
  return (async () => (db.handler ? await db.handler(text, values) : undefined) ?? { rows: [] })()
}
`)
const fakePgUrl = pathToFileURL(FAKE_PG).href
function compile(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) compile(path)
    else if (path.endsWith('.ts')) {
      const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText.replaceAll(`from '@vercel/postgres'`, `from '${fakePgUrl}'`)
      const destination = join(build, path.replace(/\.ts$/, '.js'))
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, output)
    }
  }
}
compile('api')
for (const path of ['src/systems/TrainedChatPanel.ts', 'src/systems/ActivityPanel.ts', 'src/scene/colors.ts', 'src/shared/types.ts']) {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from '([^']+)'/g, (whole, specifier) => specifier.startsWith('.') ? `from '${specifier}.js'` : whole)
  mkdirSync(dirname(join(build, path)), { recursive: true })
  writeFileSync(join(build, path.replace(/\.ts$/, '.js')), output)
}

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const quiet = { warn: console.warn, log: console.log, error: console.error }
after(() => {
  process.env = originalEnv
  globalThis.fetch = originalFetch
  Object.assign(console, quiet)
  rmSync(build, { recursive: true, force: true })
})

for (const name of Object.keys(process.env)) {
  if (/^(OPENROUTER|POSTGRES|LAB_|AI_AGENT|RESEARCH_|SPRITES|MODAL|EPOCH_|NORTH_|GPU_JOBS|VERCEL|TINKER|CRON_)/.test(name)) delete process.env[name]
}
const OPENROUTER_KEY = 'test-only-openrouter-placeholder-0000'
const TINKER_KEY = 'tml-test-only-tinker-placeholder-0000'
const JOBS_TOKEN = 'test-only-tinker-jobs-token-000000000000'
const SPRITES_TOKEN = 'test-org/test-id/test-only-sprites-secret'
process.env.OPENROUTER_API_KEY = OPENROUTER_KEY
const BASE_ENV = { ...process.env }

let logs = []
const capture = (...args) => logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = capture
console.log = capture
console.error = capture

const load = path => import(pathToFileURL(join(build, path)).href)
const { db } = await import(fakePgUrl)
const tinker = await load('api/_lib/tinker.js')
const store = await load('api/_lib/tinker-store.js')
const runs = await load('api/_lib/tinker-run.js')
const client = await load('api/_lib/tinker-client.js')
const tinkerChat = await load('api/_lib/tinker-chat.js')
const liveTrained = await load('api/_lib/live-trained.js')
const trainedChat = await load('api/_lib/trained-chat.js')
const keys = await load('api/_lib/live-model-keys.js')
const sprites = await load('api/_lib/sprites.js')
const toolsConfig = await load('api/_lib/tools-config.js')
const toolRequests = await load('api/_lib/tool-requests.js')
const epochTools = await load('api/_lib/epoch-tools.js')
const prompts = await load('api/_lib/prompts.js')
const openrouter = await load('api/_lib/openrouter.js')
const panel = await load('src/systems/TrainedChatPanel.js')
const { default: liveRoute } = await load('api/live-model/v1/chat/completions.js')
const { default: chatRoute } = await load('api/experiment/trained-chat.js')

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------
let nextId = 1
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
const at = v => new Date(v).getTime()

class FakeDb {
  constructor() {
    this.keys = []
    this.liveCalls = []
    this.modelCalls = []
    this.toolRuns = []
    this.spendDays = new Map()
    this.tinkerRuns = []
    this.rate = new Map()
    this.chatCalls = []
    this.statements = []
    this.epochCosts = []
    this.failSpend = false
    this.failTinker = false
    this.noTinkerTables = false
  }

  handle(text, v) {
    this.statements.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }

    // ---- live model keys (as in tests/live-model.test.mjs) ----
    if (text.startsWith('UPDATE live_model_keys SET revoked = TRUE, revoked_at = ?, revoke_reason = ? WHERE sprite = ?')) return { rows: [] }
    if (text.startsWith('INSERT INTO live_model_keys')) {
      const [token_hash, experiment_id, epoch, model, sprite, issued_at, expires_at, max_calls, max_usd] = v
      const row = { id: uuid(), token_hash, experiment_id, epoch, model, sprite, issued_at, expires_at, max_calls, max_usd: String(max_usd), calls_used: 0, usd_used: '0', busy_until: null, revoked: false }
      this.keys.push(row)
      return { rows: [{ id: row.id }] }
    }
    if (text.startsWith('SELECT id, experiment_id, epoch, model, sprite, expires_at') && text.includes('FROM live_model_keys WHERE token_hash = ?')) {
      const row = this.keys.find(k => k.token_hash === v[0])
      return { rows: row ? [{ ...row }] : [] }
    }
    if (text.startsWith('UPDATE live_model_keys SET calls_used = calls_used + 1, busy_until = ?')) {
      const [lease, hash, now] = v
      const k = this.keys.find(row => row.token_hash === hash)
      if (!k || k.revoked || !(at(k.expires_at) > at(now)) || !(k.calls_used < k.max_calls) || !(Number(k.usd_used) < Number(k.max_usd))
        || !(k.busy_until === null || at(k.busy_until) <= at(now))) return { rows: [] }
      k.calls_used += 1
      k.busy_until = lease
      return { rows: [{ ...k }] }
    }
    if (text.startsWith('UPDATE live_model_keys SET usd_used = usd_used + ?, busy_until = NULL WHERE id = ?')) {
      const k = this.keys.find(row => row.id === v[1])
      if (k) { k.usd_used = String(Number(k.usd_used) + Number(v[0])); k.busy_until = null }
      return { rows: [] }
    }
    if (text.startsWith('INSERT INTO live_model_calls')) {
      const [key_id, experiment_id, epoch, issued_to, sprite, model_asked, model_served, status, http_status, finish_reason, prompt_tokens, completion_tokens, cost_usd, cost_source, duration_ms, detail] = v
      this.liveCalls.push({ key_id, experiment_id, epoch, issued_to, sprite, model_asked, model_served, status, http_status, finish_reason, prompt_tokens, completion_tokens, cost_usd, cost_source, duration_ms, detail: JSON.parse(detail) })
      return { rows: [] }
    }

    // ---- spend ledger ----
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, created_at: new Date() })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number = ?')) {
      const calls = this.modelCalls.filter(c => c.experiment_id === v[0] && c.epoch_number === v[1])
      return { rows: [{ cost_usd: calls.reduce((a, c) => a + Number(c.cost_usd), 0), prompt_tokens: 0, completion_tokens: 0 }] }
    }
    if (text.startsWith('UPDATE epochs SET cost_usd = ?, prompt_tokens = ?, completion_tokens = ? WHERE experiment_id = ? AND epoch_number = ?')) {
      this.epochCosts.push({ cost_usd: v[0], experiment_id: v[3], epoch_number: v[4] })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE purpose = ? AND created_at >= ?')) {
      const total = this.modelCalls.filter(c => c.purpose === v[0] && c.created_at >= new Date(v[1])).reduce((s, c) => s + Number(c.cost_usd), 0)
      return { rows: [{ total }] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) {
      if (this.failSpend) throw new Error('ledger down')
      const total = this.modelCalls.filter(c => c.created_at >= new Date(v[0])).reduce((s, c) => s + Number(c.cost_usd), 0)
      return { rows: [{ total }] }
    }

    // ---- tool runs ----
    if (text.startsWith('INSERT INTO tool_runs')) {
      const [experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail] = v
      this.toolRuns.push({ id: uuid(), experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail: detail ? JSON.parse(detail) : null, created_at: new Date() })
      return { rows: [] }
    }
    if (text.startsWith('SELECT COUNT(*) AS n FROM tool_runs WHERE tool = ?')) {
      return { rows: [{ n: this.toolRuns.filter(r => r.tool === v[0] && r.created_at >= new Date(v[1]) && r.status !== 'skipped').length }] }
    }
    if (text.startsWith('SELECT DISTINCT tool FROM tool_runs WHERE experiment_id = ? AND epoch = ?')) {
      return { rows: [...new Set(this.toolRuns.filter(r => r.experiment_id === v[0] && r.epoch === v[1]).map(r => r.tool))].map(tool => ({ tool })) }
    }

    // ---- the daily Tinker caps ----
    if (text.startsWith('INSERT INTO tinker_spend_days (day, scope) VALUES (?, ?) ON CONFLICT (day, scope) DO NOTHING')) {
      const key = `${v[0]}|${v[1]}`
      if (!this.spendDays.has(key)) this.spendDays.set(key, { day: v[0], scope: v[1], reserved_usd: 0, spent_usd: 0 })
      return { rows: [] }
    }
    // The gate. Every condition of the real statement, checked and applied in one step.
    if (text.startsWith('UPDATE tinker_spend_days SET reserved_usd = reserved_usd + ?')) {
      assert.ok(text.includes('WHERE day = ? AND scope = ? AND spent_usd + reserved_usd + ? <= ?'), 'the reserve statement lost its cap condition')
      if (this.failTinker) throw new Error('spend table down')
      const [amount, day, scope, again, cap] = v
      assert.equal(amount, again)
      const row = this.spendDays.get(`${day}|${scope}`)
      if (!row || !(row.spent_usd + row.reserved_usd + amount <= cap + 1e-12)) return { rows: [] }
      row.reserved_usd += amount
      return { rows: [{ spent_usd: row.spent_usd, reserved_usd: row.reserved_usd }] }
    }
    if (text.startsWith('UPDATE tinker_spend_days SET reserved_usd = GREATEST(0, reserved_usd - ?), spent_usd = spent_usd + ?')) {
      const [reserved, actual, day, scope] = v
      const row = this.spendDays.get(`${day}|${scope}`)
      if (row) { row.reserved_usd = Math.max(0, row.reserved_usd - reserved); row.spent_usd += actual }
      return { rows: [] }
    }
    if (text.startsWith('SELECT spent_usd, reserved_usd FROM tinker_spend_days')) {
      const row = this.spendDays.get(`${v[0]}|${v[1]}`)
      return { rows: row ? [{ ...row }] : [] }
    }

    // ---- training runs ----
    if (text.startsWith('INSERT INTO tinker_runs')) {
      assert.ok(text.includes('ON CONFLICT (experiment_id, epoch) DO NOTHING'), 'a run must be unique per epoch')
      const [experiment_id, epoch, model, assigned_model, slug, base_model, purpose, dataset_sha256, dataset_examples, dataset_bytes, settings, split_salt, status, spend_day, reserved_usd] = v
      if (this.tinkerRuns.some(r => r.experiment_id === experiment_id && r.epoch === epoch)) return { rows: [] }
      const row = {
        id: uuid(), created_at: new Date().toISOString(), experiment_id, epoch, model, assigned_model, slug, base_model, purpose, dataset_sha256,
        dataset_examples, dataset_bytes, settings, split_salt, status, reason: null, call_id: null, spend_day, reserved_usd, cost_usd: null,
        result: null, sampler_path: null, expires_at: null,
      }
      this.tinkerRuns.push(row)
      return { rows: [{ ...row }] }
    }
    if (text.startsWith('UPDATE tinker_runs SET status = ?, call_id = ? WHERE id = ? AND status = ?')) {
      const row = this.tinkerRuns.find(r => r.id === v[2] && r.status === v[3])
      if (row) Object.assign(row, { status: v[0], call_id: v[1] })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE tinker_runs SET status = ?, reason = ?, cost_usd = ?, result = ?, sampler_path = ?, expires_at = ?')) {
      assert.ok(text.includes("AND status IN ('reserved', 'running')"), 'a run may be closed only once')
      const [status, reason, cost_usd, result, sampler_path, expires_at, id] = v
      const row = this.tinkerRuns.find(r => r.id === id && (r.status === 'reserved' || r.status === 'running'))
      if (!row) return { rows: [] }
      Object.assign(row, { status, reason, cost_usd, result, sampler_path, expires_at })
      return { rows: [{ ...row }] }
    }
    if (text.startsWith("SELECT * FROM tinker_runs WHERE status IN ('reserved', 'running') ORDER BY created_at ASC LIMIT 5")) {
      if (this.noTinkerTables) throw new Error('relation "tinker_runs" does not exist')
      return { rows: this.tinkerRuns.filter(r => r.status === 'reserved' || r.status === 'running').slice(0, 5).map(r => ({ ...r })) }
    }
    // The runs-per-day count: every run opened today except one closed at no cost.
    if (text.startsWith('SELECT COUNT(*) AS n FROM tinker_runs WHERE spend_day = ?')) {
      assert.ok(text.includes("AND (status IN ('reserved', 'running', 'ok') OR COALESCE(cost_usd, 0) > 0)"), 'the runs-per-day count lost its condition')
      return { rows: [{ n: this.tinkerRuns.filter(r => r.spend_day === v[0] && (['reserved', 'running', 'ok'].includes(r.status) || Number(r.cost_usd) > 0)).length }] }
    }
    if (text.startsWith('SELECT * FROM tinker_runs WHERE status = ? AND sampler_path IS NOT NULL AND expires_at > ?')) {
      return { rows: this.tinkerRuns.filter(r => r.status === v[0] && r.sampler_path && at(r.expires_at) > at(v[1])).slice().reverse().map(r => ({ ...r })) }
    }
    if (text.startsWith('SELECT * FROM tinker_runs WHERE slug = ?')) {
      const row = this.tinkerRuns.find(r => r.slug === v[0])
      return { rows: row ? [{ ...row }] : [] }
    }

    // ---- visitor chat ----
    if (text.startsWith('INSERT INTO trained_chat_rate (visitor, bucket, n) VALUES (?, ?, 1)')) {
      assert.ok(text.includes('DO UPDATE SET n = trained_chat_rate.n + 1 WHERE trained_chat_rate.n < ?'), 'the count statement lost its limit')
      const [visitor, bucket, limit] = v
      const key = `${visitor}|${bucket}`
      const n = this.rate.get(key)
      if (n === undefined) { this.rate.set(key, 1); return { rows: [{ n: 1 }] } }
      if (!(n < limit)) return { rows: [] }
      this.rate.set(key, n + 1)
      return { rows: [{ n: n + 1 }] }
    }
    if (text.startsWith('DELETE FROM trained_chat_rate')) return { rows: [] }
    if (text.startsWith('INSERT INTO trained_chat_calls')) {
      const [slug, status, http_status, turns, prompt_chars, prompt_tokens, completion_tokens, cost_usd, duration_ms] = v
      this.chatCalls.push({ slug, status, http_status, turns, prompt_chars, prompt_tokens, completion_tokens, cost_usd, duration_ms })
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${text.slice(0, 140)}`)
  }

  spend(scope, day = store.utcDay()) {
    return this.spendDays.get(`${day}|${scope}`) ?? { reserved_usd: 0, spent_usd: 0 }
  }
}

let lab
beforeEach(() => {
  process.env = { ...BASE_ENV }
  logs = []
  lab = new KeepDb()
  db.handler = (text, values) => lab.handle(text, values)
  globalThis.fetch = async url => { throw new Error(`Unexpected outbound request to ${url}`) }
})

function response() {
  return {
    code: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}

const START_URL = 'https://lab--oblab-tinker-start.modal.example/'
const STATUS_URL = 'https://lab--oblab-tinker-status.modal.example/'
function enableTinker(extra = {}) {
  Object.assign(process.env, {
    LAB_ENABLE_TINKER: 'true', TINKER_JOBS_START_URL: START_URL, TINKER_JOBS_STATUS_URL: STATUS_URL, TINKER_JOBS_TOKEN: JOBS_TOKEN, ...extra,
  })
}

const BASE = 'Qwen/Qwen3.5-4B'
const example = (i, extra = '') => ({ messages: [{ role: 'user', content: `Question number ${i}?${extra}` }, { role: 'assistant', content: `Answer number ${i}.` }] })
const dataset = (n = 20) => Array.from({ length: n }, (_, i) => example(i))
const ask = (extra = {}) => ({ purpose: 'a tiny test run', examples: dataset(), ...extra })
const ok = raw => {
  const checked = tinker.normalizeTinkerRequest(raw)
  assert.ok('request' in checked, checked.error)
  return checked.request
}
const refusal = (raw, allowed) => {
  const checked = tinker.normalizeTinkerRequest(raw, allowed)
  assert.ok('error' in checked, 'the request should have been refused')
  return checked.error
}

const SAMPLER = 'tinker://0a1b2c3d-1111-2222-3333-444455556666:train:0/sampler_weights/final'
/** What the lab's runner on Modal answers for a run that worked. */
const runnerOk = (extra = {}) => ({
  status: 'ok', n_train: 18, n_holdout: 2, steps_planned: 6, steps_done: 6, stopped_early: null,
  holdout_loss_before: 2.9531, holdout_loss_after: 1.1042, train_loss_first: 3.01, train_loss_last: 0.92,
  tokens: { train: 1200, eval: 140, sample_prompt: 60, sample_completion: 30 },
  sampler_path: SAMPLER, ttl_seconds: 14 * 86400,
  samples: [{ prompt: 'Question number 3?', completion: 'Answer number 3.' }], wall_seconds: 95.5, ...extra,
})

/**
 * fetch that answers like the runner's two endpoints. `statuses` are served in order; the last repeats.
 * `names` is what the runner remembers: the call it started under each run's name. It is filled when a
 * start is answered, and a test can fill it to stand for a run that started although its answer was lost.
 */
function fakeRunner(sent, statuses = [{ status: 'done', result: runnerOk() }], start = { call_id: 'fc-test-1' }, names = new Map()) {
  let polls = 0
  return async (url, options = {}) => {
    const u = String(url)
    if (u === START_URL) {
      const body = JSON.parse(options.body)
      sent.push({ kind: 'start', headers: options.headers, raw: options.body, body })
      if (!(start instanceof Response) && body.run_id) names.set(body.run_id, start.call_id)
      return start instanceof Response ? start.clone() : new Response(JSON.stringify(start), { headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith(STATUS_URL) && new URL(u).searchParams.has('run_id')) {
      const callId = names.get(new URL(u).searchParams.get('run_id'))
      sent.push({ kind: 'lookup', headers: options.headers, url: u })
      return new Response(JSON.stringify(callId ? { status: 'running', call_id: callId } : { status: 'unknown', error: 'no call is known for that run' }), { headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith(STATUS_URL)) {
      sent.push({ kind: 'status', headers: options.headers, url: u })
      const answer = statuses[Math.min(polls++, statuses.length - 1)]
      return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected outbound request to ${u}`)
  }
}

const CTX = { experimentId: 'exp-1', epochNumber: 41, executorModelId: 'anthropic/claude-fable-5.2', assignedExecutorId: 'anthropic/claude-fable-5.2', reviewerModelId: 'openai/gpt-6-astra' }
const planFor = raw => toolRequests.planTools({ tinker_train: raw }, toolsConfig.toolConfig())
const deliver = (plan, verdicts = { tinker_train: 'approve' }, ctx = CTX) => epochTools.runDeliverables(ctx, plan, verdicts, new Set())
const everything = () => JSON.stringify({ logs, statements: lab.statements, toolRuns: lab.toolRuns, runs: lab.tinkerRuns, calls: lab.liveCalls, chat: lab.chatCalls, ledger: lab.modelCalls })

/** A kept adapter, as a finished run leaves it. */
function keepAdapter({ slug = 'e41-0a1b2c3d', expiresInMs = 5 * 86400_000, base = BASE, status = 'ok' } = {}) {
  lab.tinkerRuns.push({
    id: uuid(), created_at: new Date().toISOString(), experiment_id: 'exp-1', epoch: 41, model: 'anthropic/claude-fable-5.2', assigned_model: 'anthropic/claude-fable-5.2',
    slug, base_model: base, purpose: 'a tiny test run', dataset_sha256: 'a'.repeat(64), dataset_examples: 20, dataset_bytes: 700,
    settings: JSON.stringify({ rank: 16, learning_rate: 0.0002, epochs: 2, batch_size: 8 }), split_salt: 'ab'.repeat(16), status, reason: null, call_id: 'fc-test-1',
    spend_day: store.utcDay(), reserved_usd: 0.01, cost_usd: 0.001,
    result: JSON.stringify({ n_holdout: 2, n_train: 18, holdout_loss_before: 2.9531, holdout_loss_after: 1.1042 }),
    sampler_path: SAMPLER, expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  })
  return slug
}

/** fetch that answers like Tinker's OpenAI-compatible endpoint. */
function fakeTinker(sent, answer = () => tinkerCompletion()) {
  return async (url, options = {}) => {
    const u = String(url)
    if (u !== tinkerChat.TINKER_CHAT_URL) throw new Error(`Unexpected outbound request to ${u}`)
    const request = { headers: options.headers, body: JSON.parse(options.body) }
    sent.push(request)
    const out = await answer(request)
    return out instanceof Response ? out : new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } })
  }
}
const tinkerCompletion = ({ content = 'Answer number 3.', prompt_tokens = 20, completion_tokens = 8, finish_reason = 'stop' } = {}) => ({
  id: 'chatcmpl-test', object: 'chat.completion', created: 1794500000, model: SAMPLER,
  choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: 'kept out of the answer', tool_calls: null }, finish_reason }],
  usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens, prompt_tokens_details: { cached_tokens: 0 } },
})

const ORIGIN = 'https://lab.example'
function enableLive(extra = {}) {
  Object.assign(process.env, { LAB_ENABLE_LIVE_MODEL: 'true', LAB_PUBLIC_ORIGIN: ORIGIN, LAB_ENABLE_LIVE_TRAINED: 'true', TINKER_API_KEY: TINKER_KEY, ...extra })
}
const mint = (extra = {}) => keys.mintLiveModelKey({ experimentId: 'exp-1', epoch: 44, model: 'openai/gpt-6-astra', sprite: 'observable-gpt', ttlMs: 300_000, ...extra })
async function liveCall(token, body, method = 'POST') {
  const res = response()
  await liveRoute({ method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, query: {}, body }, res)
  return res
}
async function visit(body, { ip = '203.0.113.77', method = 'POST', agent = 'TestBrowser/1.0' } = {}) {
  const res = response()
  await chatRoute({ method, headers: { 'content-type': 'application/json', 'x-real-ip': ip, 'user-agent': agent }, query: {}, body }, res)
  return res
}

// ---------------------------------------------------------------------------
// The database, with what naming and keeping add to it
// ---------------------------------------------------------------------------
class KeepDb extends FakeDb {
  constructor() {
    super()
    this.keeps = []
    // Rivals: each entry stands for another request that takes the slot a claim was about to take, at the same moment.
    this.keepRaces = []
    this.failKeeps = false
    this.noKeepTables = false
  }

  handle(text, v) {
    // ---- display names ----
    if (text.startsWith('UPDATE tinker_runs SET name_key = NULL WHERE name_key = ? AND id <> ?')) {
      this.statements.push({ text, values: v })
      assert.ok(text.includes("AND status NOT IN ('reserved', 'running') AND NOT (status = 'ok' AND expires_at > ?)"), 'a name is given up only by a run that is over and an adapter that is gone')
      const [key, id, now] = v
      for (const r of this.tinkerRuns) {
        const open = r.status === 'reserved' || r.status === 'running'
        const alive = r.status === 'ok' && at(r.expires_at) > at(now)
        if (r.name_key === key && r.id !== id && !open && !alive) r.name_key = null
      }
      return { rows: [] }
    }
    if (text.startsWith('UPDATE tinker_runs SET display_name = ?, name_key = ? WHERE id = ? RETURNING id')) {
      this.statements.push({ text, values: v })
      const [name, key, id] = v
      // The unique index on name_key.
      if (this.tinkerRuns.some(r => r.name_key === key && r.id !== id)) throw Object.assign(new Error('duplicate key value violates unique constraint "idx_tinker_runs_name_key"'), { code: '23505' })
      const row = this.tinkerRuns.find(r => r.id === id)
      if (!row) return { rows: [] }
      Object.assign(row, { display_name: name, name_key: key })
      return { rows: [{ id }] }
    }
    if (text.startsWith('UPDATE tinker_runs SET display_name = NULL, name_key = NULL WHERE slug = ? AND display_name IS NOT NULL RETURNING id')) {
      this.statements.push({ text, values: v })
      const row = this.tinkerRuns.find(r => r.slug === v[0] && r.display_name)
      if (!row) return { rows: [] }
      Object.assign(row, { display_name: null, name_key: null })
      return { rows: [{ id: row.id }] }
    }
    if (text.startsWith('UPDATE tinker_runs SET expires_at = ? WHERE slug = ? AND status = ?')) {
      this.statements.push({ text, values: v })
      const row = this.tinkerRuns.find(r => r.slug === v[1] && r.status === v[2])
      if (row) row.expires_at = v[0]
      return { rows: [] }
    }

    // ---- kept adapters ----
    if (text.includes('tinker_keeps')) {
      this.statements.push({ text, values: v })
      if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }
      if (this.noKeepTables) throw new Error('relation "tinker_keeps" does not exist')
      if (this.failKeeps) throw new Error('keeps table down')
      const copy = rows => ({ rows: rows.map(r => ({ ...r })) })
      if (text === 'SELECT * FROM tinker_keeps ORDER BY slot ASC') return copy(this.keeps.slice().sort((a, b) => a.slot - b.slot))
      if (text === 'SELECT * FROM tinker_keeps WHERE slug = ? LIMIT 1') return copy(this.keeps.filter(k => k.slug === v[0]).slice(0, 1))
      if (text === 'SELECT slug FROM tinker_keeps WHERE experiment_id = ? AND epoch = ? LIMIT 1') {
        return copy(this.keeps.filter(k => k.experiment_id === v[0] && k.epoch === v[1]).slice(0, 1))
      }
      if (text === 'SELECT COUNT(*) AS n FROM tinker_keeps') return { rows: [{ n: this.keeps.length }] }
      if (text === 'SELECT COUNT(*) AS n FROM tinker_keeps WHERE status = ? AND kept_by <> ? AND requested_at >= ?') {
        return { rows: [{ n: this.keeps.filter(k => k.status === v[0] && k.kept_by !== v[1] && at(k.requested_at) >= at(v[2])).length }] }
      }
      // The gate. The lowest free slot from 1 to max, only while fewer than max rows exist; a slot,
      // an adapter or an epoch that is already there gives no row.
      if (text.startsWith('INSERT INTO tinker_keeps (slot, slug, status, kept_by, reason, experiment_id, epoch, job_id) SELECT s.slot,')) {
        assert.ok(text.includes('FROM generate_series(1, ?::integer) AS s(slot)'), 'slots must be numbered 1 to the cap')
        assert.ok(text.includes('WHERE NOT EXISTS (SELECT 1 FROM tinker_keeps k WHERE k.slot = s.slot)'), 'only a free slot may be taken')
        assert.ok(text.includes('AND (SELECT COUNT(*) FROM tinker_keeps) < ?::integer'), 'the claim lost its cap condition')
        assert.ok(text.includes('ON CONFLICT DO NOTHING'), 'a lost race must change nothing')
        const [slug, kept_by, reason, experiment_id, epoch, job_id, max, again] = v
        assert.equal(max, again)
        if (!(this.keeps.length < max)) return { rows: [] }
        let slot = 0
        for (let s = 1; s <= max && !slot; s++) if (!this.keeps.some(k => k.slot === s)) slot = s
        if (!slot) return { rows: [] }
        // Another request took that slot first: its row is there, and ON CONFLICT DO NOTHING gives this one no row.
        if (this.keepRaces.length) {
          const rival = this.keepRaces.shift()
          this.keeps.push({ slot, status: 'pending', kept_by: 'owner', reason: 'rival', experiment_id: null, epoch: null, job_id: 'k-rival', call_id: null, requested_at: new Date().toISOString(), kept_at: null, detail: null, ...rival })
          return { rows: [] }
        }
        if (this.keeps.some(k => k.slug === slug)) return { rows: [] }
        if (epoch !== null && this.keeps.some(k => k.experiment_id === experiment_id && k.epoch === epoch)) return { rows: [] }
        const row = { slot, slug, status: 'pending', kept_by, reason, experiment_id, epoch, job_id, call_id: null, requested_at: new Date().toISOString(), kept_at: null, detail: null }
        this.keeps.push(row)
        return copy([row])
      }
      if (text === 'UPDATE tinker_keeps SET call_id = ? WHERE slug = ? AND status = ?') {
        const row = this.keeps.find(k => k.slug === v[1] && k.status === v[2])
        if (row) row.call_id = v[0]
        return { rows: [] }
      }
      if (text === 'UPDATE tinker_keeps SET status = ?, kept_at = NOW(), detail = ? WHERE slug = ? AND status = ? RETURNING *') {
        const row = this.keeps.find(k => k.slug === v[2] && k.status === v[3])
        if (!row) return { rows: [] }
        Object.assign(row, { status: v[0], kept_at: new Date().toISOString(), detail: v[1] })
        return copy([row])
      }
      if (text === 'DELETE FROM tinker_keeps WHERE slug = ? AND status = ? RETURNING *') {
        const i = this.keeps.findIndex(k => k.slug === v[0] && k.status === v[1])
        return i < 0 ? { rows: [] } : copy(this.keeps.splice(i, 1))
      }
      // Kept adapters whose run is gone or has expired give their places back.
      if (text === 'DELETE FROM tinker_keeps WHERE status = ? AND slug IN ( SELECT slug FROM tinker_runs WHERE status <> ? OR expires_at IS NULL OR expires_at <= ? ) RETURNING *') {
        const gone = k => this.tinkerRuns.some(r => r.slug === k.slug && (r.status !== v[1] || !r.expires_at || at(r.expires_at) <= at(v[2])))
        const out = this.keeps.filter(k => k.status === v[0] && gone(k))
        this.keeps = this.keeps.filter(k => !out.includes(k))
        return copy(out)
      }
      if (text === 'SELECT * FROM tinker_keeps WHERE status = ? ORDER BY requested_at ASC LIMIT 5') {
        return copy(this.keeps.filter(k => k.status === v[0]).slice(0, 5))
      }
      throw new Error(`unexpected keeps query: ${text.slice(0, 160)}`)
    }
    return super.handle(text, v)
  }
}

const keepLib = await load('api/_lib/tinker-keep.js')
const keepRequest = await load('api/_lib/tinker-keep-request.js')
const names = await load('api/_lib/tinker-names.js')
const activityPanel = await load('src/systems/ActivityPanel.js')
const activity = await load('api/_lib/activity.js')
const { default: adaptersRoute } = await load('api/experiment/trained-adapters.js')

const OPERATOR = 'test-only-operator-secret-000000000000000'
const EXTERNAL = SAMPLER.replace('/sampler_weights/', '/external_weights/')
const SLUG = 'e41-0a1b2c3d'
const mentions = word => lab.statements.filter(s => s.text.includes(word)).length

function enableNames(extra = {}) {
  enableTinker({ LAB_ENABLE_TINKER_NAMES: 'true', ...extra })
}
function enableKeep(extra = {}) {
  enableTinker({ LAB_ENABLE_TINKER_KEEP: 'true', ...extra })
}
/** A finished run's adapter, with downloadable weights unless told otherwise. */
function adapter({ slug = SLUG, external = true, name = null, expiresInMs = 5 * 86400_000, epoch = 41 } = {}) {
  keepAdapter({ slug, expiresInMs })
  const row = lab.tinkerRuns[lab.tinkerRuns.length - 1]
  row.epoch = epoch
  const result = JSON.parse(row.result)
  row.result = JSON.stringify({ ...result, ...(external ? { external_path: EXTERNAL } : {}) })
  if (name) Object.assign(row, { display_name: name, name_key: names.adapterNameKey(name) })
  return row
}
const FILES = [
  { path: 'adapter_config.json', bytes: 412, sha256: 'c'.repeat(64) },
  { path: 'adapter_model.safetensors', bytes: 18_400_000, sha256: 'd'.repeat(64) },
]
/** What the runner answers for a keep that worked, with a copy. */
const keeperOk = (extra = {}) => ({
  status: 'ok', ttl_seconds: 365 * 86400, checkpoints: 41, wall_seconds: 12.5,
  copy: { status: 'ok', format: 'peft', dir: SLUG, bytes: 18_400_412, files: FILES, reason: null }, ...extra,
})
const keeperRunner = (sent, result = keeperOk(), start) => fakeRunner(sent, [{ status: 'done', result }], start)
const keepPlan = (raw = { adapter: `lab/${SLUG}`, reason: 'the lowest held-out loss so far' }) => toolRequests.planTools({ keep_adapter: raw }, toolsConfig.toolConfig())
const approve = { keep_adapter: 'approve' }
async function operator(body, { method = 'POST', token = OPERATOR, confirm = true } = {}) {
  const res = response()
  await adaptersRoute({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: confirm ? { confirm: 'true' } : {}, body }, res)
  return res
}
const keptRuns = tool => lab.toolRuns.filter(r => r.tool === tool)

// ===========================================================================
// Off by default
// ===========================================================================
test('with both switches off nothing changes: no field, no tool, no prompt text, no query, no export, no list change', async () => {
  enableTinker()
  // A name is an unknown field like any other, and the request is refused whole, as it always was.
  assert.equal(refusal(ask({ name: 'Brass Finch' })), 'unknown field: name')
  // keep_adapter is an unknown tool, as it always was.
  const config = toolsConfig.toolConfig()
  assert.equal(config.keep_adapter.enabled, false)
  assert.equal(config.keep_adapter.off_reason, 'LAB_ENABLE_TINKER_KEEP is not true')
  assert.equal(toolsConfig.enabledTools().includes('keep_adapter'), false)
  const plan = toolRequests.planTools({ keep_adapter: { adapter: `lab/${SLUG}`, reason: 'x' } }, config)
  assert.equal(plan.keep_adapter, undefined)
  assert.deepEqual(plan.ignored, [{ tool: 'keep_adapter', reason: 'unknown tool' }])
  // The models are told nothing about either.
  const told = prompts.toolLines() + prompts.executorToolsSection() + prompts.reviewerToolSection({ tinker_train: { line: 'x' } })
  for (const word of ['keep_adapter', 'display name', '"name"', 'Keeping a trained adapter', 'TRAINED ADAPTERS']) assert.equal(told.includes(word), false, word)
  assert.equal(tinker.tinkerNote({ perDay: 2, liveTrained: false }), tinker.tinkerNote({ perDay: 2, liveTrained: false, names: false }))
  assert.equal(await keepLib.adaptersContext(), '')

  // A whole run: the runner is not asked to save weights for download, and no statement names what the two features add.
  const sent = []
  globalThis.fetch = fakeRunner(sent)
  const out = await deliver(planFor(ask()))
  assert.equal(out[0].status, 'ok')
  assert.equal('export' in sent[0].body.train, false)
  assert.equal(await keepLib.collectTinkerKeeps().then(o => o.length), 0)
  const row = lab.tinkerRuns[0]
  Object.assign(row, { display_name: 'Left Over', name_key: 'leftover' })
  lab.keeps.push({ slot: 1, slug: row.slug, status: 'kept', kept_by: 'owner', reason: 'earlier', experiment_id: null, epoch: null, job_id: 'k-x', call_id: null, requested_at: new Date().toISOString(), kept_at: new Date().toISOString(), detail: null })
  const listed = await store.listAdapters()
  assert.deepEqual(Object.keys(listed[0].adapter).sort(), ['author_model', 'author_name', 'base_model', 'created_at', 'epoch', 'examples', 'expires_at', 'holdout_examples', 'holdout_loss_after', 'holdout_loss_before', 'model_id', 'purpose', 'slug'])
  assert.equal(store.adapterDescription(listed[0].adapter), '')
  for (const word of ['tinker_keeps', 'display_name', 'name_key']) assert.equal(mentions(word), 0, `a statement mentions ${word} while both switches are off`)
  // The stored record of the run names no name either.
  assert.equal(JSON.stringify(keptRuns('tinker_train')).includes('Left Over'), false)

  // Both flags need exactly "true", and keeping needs the runner.
  for (const value of ['1', 'yes', 'TRUE', ' true']) {
    process.env.LAB_ENABLE_TINKER_NAMES = value
    process.env.LAB_ENABLE_TINKER_KEEP = value
    assert.equal(tinker.tinkerNamesFlag(), value.trim() === 'true')
    assert.equal(tinker.tinkerKeepFlag(), value.trim() === 'true')
  }
  process.env = { ...BASE_ENV, LAB_ENABLE_TINKER_KEEP: 'true' }
  assert.equal(tinker.tinkerKeepStatus().off_reason, 'TINKER_JOBS_START_URL, TINKER_JOBS_STATUS_URL or TINKER_JOBS_TOKEN is not set')
  enableKeep({ LAB_TINKER_KEEP_MAX: '0' })
  assert.equal(tinker.tinkerKeepStatus().off_reason, 'LAB_TINKER_KEEP_MAX is 0')
})

test('the limits have the defaults the owner was told, and a ceiling the environment cannot raise', () => {
  assert.deepEqual([tinker.tinkerKeepMax(), tinker.tinkerKeepDays(), tinker.tinkerKeepMaxMb()], [10, 365, 1024])
  Object.assign(process.env, { LAB_TINKER_KEEP_MAX: '500', LAB_TINKER_KEEP_DAYS: '99999', LAB_TINKER_KEEP_MAX_MB: '999999' })
  assert.deepEqual([tinker.tinkerKeepMax(), tinker.tinkerKeepDays(), tinker.tinkerKeepMaxMb()], [40, 3650, 4096])
  Object.assign(process.env, { LAB_TINKER_KEEP_MAX: 'many', LAB_TINKER_KEEP_DAYS: '1', LAB_TINKER_KEEP_MAX_MB: '-3' })
  assert.deepEqual([tinker.tinkerKeepMax(), tinker.tinkerKeepDays(), tinker.tinkerKeepMaxMb()], [10, 30, 1])
  enableKeep()
  assert.equal(toolsConfig.toolConfig().keep_adapter.per_day, 2)
  assert.equal(toolsConfig.PER_EPOCH.adapter_keeps, 1)
  // The runner holds the same ceilings, and writes to the Volume the lab names.
  const source = readFileSync(join(root, 'modal', 'tinker_jobs.py'), 'utf8')
  assert.match(source, /^KEPT_VOLUME = "oblab-kept-models"$/m)
  assert.equal(keepLib.KEPT_VOLUME, 'oblab-kept-models')
  assert.match(source, /^HARD_KEEP_BYTES = 4096 \* 1024 \* 1024$/m)
  assert.equal(tinker.TINKER_HARD_KEEP_MAX_MB, 4096)
  assert.match(source, /^MAX_KEEP_TTL_S = 10 \* 365 \* 24 \* 3600$/m)
  assert.ok(tinker.TINKER_MAX_KEEP_DAYS * 86400 <= 10 * 365 * 24 * 3600)
  // A kept adapter never lives shorter than an unkept one could.
  assert.ok(tinker.TINKER_MIN_KEEP_DAYS >= tinker.TINKER_MAX_TTL_DAYS)
})

// ===========================================================================
// Names
// ===========================================================================
test('a name is read strictly: a small alphabet, 2 to 40 characters, no web address, no lab id, no real model or product', () => {
  for (const good of ['Brass Finch', "O'Brien's Parrot", 'Lamp-7', 'Dr. Lin', 'v1.5 Quill', 'Octopus', 'Ink', 'Marmalade 3', '  Brass Finch  ']) {
    const read = names.readAdapterName(good)
    assert.deepEqual(read, { name: good.trim() }, `${good}: ${read.error}`)
  }
  const refused = {
    'not text': [7, null, ['Brass'], { name: 'x' }],
    '2 to 40 characters': ['', 'A', 'x'.repeat(41)],
    'only letters, digits, spaces, hyphens, apostrophes and dots': ['Brass_Finch', 'Finch!', 'Fïnch', 'a/b', '<b>Finch</b>', 'Finch & Co', 'Fin"ch', 'Fin\nch', 'Brass​Finch', 'Финч', 'Finch 🐦'],
    'must start with a letter or digit': ['-Finch', '.Finch', "'Finch", 'Finch-', "Finch'"],
    'two spaces in a row': ['Brass  Finch'],
    'at least two letters': ['7-7', 'A1', '1.5'],
    'web address': ['example.com', 'www.Finch', 'finch.ai', 'http-finch', 'https finch', 'my.site.org', 'Finch.io'],
    // A lab id anywhere in the name, not only as the whole of it: "e41-0a1b2c3d v2" would be shown as another adapter's id.
    'lab id': ['e41-0a1b2c3d', 'E41 0A1B2C3D', 'lab e41-0a1b2c3d', 'lab-e7-deadbeef', 'e41-0a1b2c3d v2', 'Finch e41-0a1b2c3d', 'E41 0A1B2C3D Finch', 'My e7deadbeef'],
  }
  for (const [reason, values] of Object.entries(refused)) {
    for (const value of values) {
      const read = names.readAdapterName(value)
      assert.ok('error' in read, `${JSON.stringify(value)} should be refused`)
      assert.ok(read.error.includes(reason), `${JSON.stringify(value)}: "${read.error}" does not say "${reason}"`)
    }
  }
  // Real names: the five lab models, the fallbacks and the wildcards, by display name and by id; the well known
  // families; and the same names in other case, with other separators, or spelt with look-alike characters.
  const real = [
    'Gemini 4', 'DeepSeek V4 Pro', 'Claude Fable 5.2', 'GPT-6 Astra', 'Grok 4.7', 'claude-sonnet-5.5', 'gemini 3.8 flash', 'North', 'GLM 5.3',
    'gpt-6-astra', 'grok-4.7', 'deepseek-v4-pro-0813', 'north-mini-code',
    'GPT', 'gpt 7', 'G P T Five', 'ChatGPT', 'Claude', 'claude jr', 'C1aude', 'CIaude', 'Cl4ude', 'Gemini Two', 'Gernini', 'G3mini', 'Grok', 'Gr0k', 'DeepSeek', 'Deep Seek', 'D33pSeek',
    'Llama', 'L1ama', 'Qwen', 'Q-w-e-n', 'Qvven', 'Mistral', 'OpenAI Finch', 'Anthropic', 'Google Bird', 'Opus', 'Sonnet 9', 'Haiku', 'Fable', 'Astra', 'Kimi', 'Phi', 'Gemma', 'Codex', 'Tinker', 'o3 Mini',
    // i, l and 1 pass for one another in either direction and in either case, in the name and in the real name alike.
    'GEMlNI', 'Gemlni', 'Gem1ni', 'Gemin1', 'Gem1ni 4', 'OPENAl', 'OPENA1', '0penAl', 'MlSTRAL', 'NVlDlA', 'NV1DIA', 'Ciaude', 'C1AUDE', 'Anthropl c', 'Copi1ot', 'Kiml', 'Ph1', 'Halku',
    // The maker of a panel model that has no family word of its own, as a word or as the provider id writes it.
    'xAI', 'xAI Labs', 'x-ai', 'X AI Finch', 'XAl',
    // A version written straight after the name, and a tier after that.
    'Fable5.2', 'Sonnet5.5', 'Opus4.5', 'Haiku4', 'GLM5', 'GLM 6', 'Astra6', 'Gemma3', 'Phi4', 'Kimi2', 'Codex5', 'o3mini', 'o4-mini', 'Phi4mini', 'GLM4Plus', '0pus4',
    // One of the lab's own models under another version, or under none.
    'North 2', 'North7', 'N0rth', 'Claude Fable', 'claude-fable 6', 'Gemini 3.8 Flash 2', 'north-mini-code 3',
    // A real name that begins after an r is not hidden by "rn" passing for m.
    'Supernvidia',
  ]
  for (const value of real) {
    const read = names.readAdapterName(value)
    assert.ok('error' in read && read.error.includes('reads like the real model or product name'), `${value} should read like a real name: ${JSON.stringify(read)}`)
  }
  // Dots between letters are refused before that, as a web address would be.
  assert.ok('error' in names.readAdapterName('G.P.T. Five'))
  // A short model name is refused as a word, not as a few letters inside another word.
  for (const fine of ['Octopus', 'Philosopher', 'Sophia', 'Bonnet', 'Stable Quill', 'Fables', 'Tinkerbell', 'Northern Finch', 'North Star', 'Glow Worm', 'Max Allen', 'Hexalith']) {
    assert.ok('name' in names.readAdapterName(fine), fine)
  }
  // Two names are the same name whatever their case, separators or look-alike characters.
  assert.equal(names.adapterNameKey('Brass Finch'), names.adapterNameKey("brass-finch"))
  assert.equal(names.adapterNameKey('Bill'), names.adapterNameKey('B1ll'))
  assert.equal(names.adapterNameKey('QUIET LAMP'), names.adapterNameKey('Quiet Lamp'))
  assert.equal(names.adapterNameKey('Quiet Lamp'), names.adapterNameKey('Qulet Larnp'))
  // Ordinary names that only share letters with a model's name are fine.
  for (const fine of ['Quiet Lamp', 'Morning Glory', 'Little Owl', 'Mill Pond', 'Lily', 'Emil', 'Small Pilot', 'Aloe Vera', 'Apollo 11']) assert.ok('name' in names.readAdapterName(fine), fine)
  // The comparison is wide on purpose, and words are not kept apart, so a few ordinary names are refused as well:
  // "Open Al" is how "OpenAI" looks with a small l, and "liam a" is "llama" with an i for an l. The run goes on without a name.
  for (const [wide, real] of [['Open Aloe', 'openai'], ['William and Mary', 'llama'], ['Liam Ashford', 'llama']]) {
    assert.match(names.readAdapterName(wide).error ?? '', new RegExp(`reads like the real model or product name "${real}"`), wide)
  }
  // The key two names are compared by treats the same characters as one, so it is the old key for every name.
  assert.equal(names.adapterNameKey("Qulet-Larnp 1.5"), 'quletlampls')
  assert.notEqual(names.adapterNameKey('Brass Finch'), names.adapterNameKey('Brass Finch 2'))
})

test('a refused name never refuses the run: the reason is stored on its own and the adapter goes without a name', async () => {
  enableNames()
  const plan = planFor(ask({ name: 'Claude Mini' }))
  assert.ok(plan.tinker_train, 'the run stands')
  assert.equal(plan.tinker_train.name, undefined)
  assert.deepEqual(plan.ignored, [{ tool: 'tinker_name', reason: 'name refused: "Claude Mini" reads like the real model or product name "claude"; the run stands and the adapter gets no name' }])
  // Left out, null or empty is simply no name. Any other unknown field still refuses the whole request.
  for (const extra of [{}, { name: null }, { name: '' }]) assert.deepEqual(planFor(ask(extra)).ignored, [])
  assert.equal(refusal(ask({ name: 'Brass Finch', label: 'x' })), 'unknown field: label')

  const sent = []
  globalThis.fetch = fakeRunner(sent)
  await epochTools.recordIgnored(CTX, plan)
  const out = await deliver(plan)
  assert.equal(out[0].status, 'ok')
  assert.equal(lab.tinkerRuns[0].display_name ?? null, null)
  // The refusal is stored under its own tool name, so it never reads as the epoch's run having been dealt with.
  assert.deepEqual(keptRuns('tinker_name').map(r => [r.status, r.output_tail]), [['skipped', plan.ignored[0].reason]])
  assert.equal(keptRuns('tinker_train').length, 1)
  // The name is the lab's business: the runner is not sent it.
  assert.equal(JSON.stringify(sent[0].body).includes('Claude Mini'), false)
})

test('a name that is free goes on the adapter, the record, the chat list and the model list; the lab id stays the identity', async () => {
  enableNames()
  const sent = []
  globalThis.fetch = fakeRunner(sent)
  const out = await deliver(planFor(ask({ name: "O'Brien's Finch" })))
  assert.equal(out[0].status, 'ok')
  const row = lab.tinkerRuns[0]
  assert.equal(row.display_name, "O'Brien's Finch")
  assert.match(out[0].summary, new RegExp(`adapter lab/${row.slug} named "O'Brien's Finch" on `))
  assert.equal(JSON.stringify(sent[0].body).includes('Finch'), false)
  // The record.
  const run = keptRuns('tinker_train')[0]
  assert.equal(run.detail.name, "O'Brien's Finch")
  assert.equal(run.detail.adapter, `lab/${row.slug}`)
  assert.equal(run.request_summary, `LoRA fine-tune of ${BASE} on 20 examples, named "O'Brien's Finch": a tiny test run`)

  // The visitor chat lists it by name; a message still goes to the lab id.
  Object.assign(process.env, { LAB_ENABLE_TRAINED_CHAT: 'true', TINKER_API_KEY: TINKER_KEY, CRON_SECRET: 'test-only-scheduler-secret-0000000000' })
  const list = await visit(undefined, { method: 'GET' })
  assert.deepEqual([list.body.adapters[0].slug, list.body.adapters[0].model_id, list.body.adapters[0].name], [row.slug, `lab/${row.slug}`, "O'Brien's Finch"])
  const view = panel.parseAdapters(list.body)[0]
  assert.deepEqual([view.name, view.modelId, view.kept], ["O'Brien's Finch", `lab/${row.slug}`, false])
  const described = panel.describeAdapter(view)
  assert.deepEqual([described.title, described.id, described.mark], ["O'Brien's Finch", `lab/${row.slug}`, undefined])

  // The lab model endpoint: the id is lab/<id>, the name is a description.
  enableLive()
  const key = await mint()
  const models = (await liveCall(key.token, undefined, 'GET')).body.data
  const entry = models.find(m => m.id === `lab/${row.slug}`)
  assert.deepEqual(Object.keys(entry).sort(), ['description', 'id', 'object', 'owned_by'])
  assert.match(entry.description, /^"O'Brien's Finch"\. A LoRA adapter trained in this lab on Qwen\/Qwen3\.5-4B; the id is its identity, the name is a label\.$/)
  // The name is not an id: it cannot be called.
  const call = await liveCall(key.token, { model: "lab/O'Brien's Finch", messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(call.code, 400)

  // The Activity panel shows it as text.
  const html = activityPanel.renderEpochActivity(activity.buildEpochActivity({
    epoch: { epoch_number: 41, role_assignments: {} }, toolRuns: lab.toolRuns.map(r => ({ ...r })), contributions: [], spend: [],
  }))
  assert.ok(html.includes('named &quot;O&#39;Brien&#39;s Finch&quot;'), 'the name is escaped in the Activity panel')
  assert.equal(html.includes("O'Brien"), false)

  // Switching names off hides every name again without touching the adapter.
  process.env.LAB_ENABLE_TINKER_NAMES = 'false'
  const hidden = await visit(undefined, { method: 'GET' })
  assert.equal('name' in hidden.body.adapters[0], false)
  assert.equal('description' in (await liveCall(key.token, undefined, 'GET')).body.data.find(m => m.id === `lab/${row.slug}`), false)
})

test('a name is unique among the adapters that are alive, whatever its case or separators, and is free again once its adapter is gone', async () => {
  enableNames()
  const first = adapter({ slug: 'e30-11112222', name: 'Brass Finch', epoch: 30 })
  const sent = []
  globalThis.fetch = fakeRunner(sent)
  const taken = await deliver(planFor(ask({ name: 'brass-finch' })))
  assert.equal(taken[0].status, 'ok', 'the run goes on')
  const second = lab.tinkerRuns[1]
  assert.equal(second.display_name ?? null, null)
  assert.deepEqual(keptRuns('tinker_name').map(r => [r.status, r.request_summary, r.output_tail]), [[
    'skipped', `a display name for adapter lab/${second.slug}`,
    'name refused: "brass-finch" is the name of another adapter that is still alive; the run goes on and the adapter has no name',
  ]])

  // Two runs asking for one name at the same moment: the database gives it to one.
  const [a, b] = [adapter({ slug: 'e50-aaaa0000', epoch: 50 }), adapter({ slug: 'e51-bbbb0000', epoch: 51 })]
  const got = await Promise.all([store.claimAdapterName(a.id, 'Quiet Lamp'), store.claimAdapterName(b.id, 'QUIET LAMP')])
  assert.deepEqual(got.slice().sort(), [false, true])

  // Once the first adapter has expired, its name can be taken.
  first.expires_at = new Date(Date.now() - 1000).toISOString()
  const c = adapter({ slug: 'e52-cccc0000', epoch: 52 })
  assert.equal(await store.claimAdapterName(c.id, 'Brass Finch'), true)
  assert.equal(first.name_key, null)
  // An adapter that is kept is alive for as long as it is kept, so its name stays taken.
  c.expires_at = new Date(Date.now() + 300 * 86400_000).toISOString()
  assert.equal(await store.claimAdapterName(a.id, 'Brass Finch'), false)
  // If the name cannot be stored the run still goes on, and says why it has no name.
  lab.tinkerRuns.length = 0
  lab.toolRuns.length = 0
  const original = lab.handle.bind(lab)
  lab.handle = (text, v) => {
    if (text.startsWith('UPDATE tinker_runs SET display_name = ?')) throw new Error('names are down')
    return original(text, v)
  }
  const down = await deliver(planFor(ask({ name: 'Paper Kite' })), undefined, { ...CTX, epochNumber: 77 })
  assert.equal(down[0].status, 'ok')
  assert.match(keptRuns('tinker_name')[0].output_tail, /the lab could not store the name/)
})

test('with names on, the models are told the rules of a name and nothing about what to call anything', () => {
  enableNames()
  const told = prompts.toolLines()
  assert.match(told, /You may give the adapter a display name with "name": 2 to 40 characters, only letters, digits, spaces, hyphens, apostrophes and dots\./)
  assert.match(told, /the lab id stays its identity/)
  assert.match(told, /is refused with the reason stored, and the run goes on without a name/)
  const section = prompts.executorToolsSection()
  assert.match(section, /"name": "a display name, 2 to 40 characters \(optional\)"/)
  assert.match(section, /The name is the one field that cannot refuse the request/)
  // With names on, "name" means the display name, so the model endpoint's address is called the lab id.
  assert.match(tinker.tinkerNote({ perDay: 2, liveTrained: true, names: true }), /answers for it as the model "lab\/<id>", with the lab id from the run's record/)
  assert.match(tinker.tinkerNote({ perDay: 2, liveTrained: true }), /While an adapter is kept, the lab model endpoint also answers for it as the model "lab\/<name>", with the name from the run's record/)
  for (const nudge of [/should name/i, /good name/i, /memorable/i, /creative/i, /for example/i]) assert.equal(nudge.test(told + section), false, String(nudge))
})

// ===========================================================================
// Keeping
// ===========================================================================
test('a keep request is read strictly', () => {
  const read = raw => keepRequest.normalizeKeepRequest(raw)
  assert.deepEqual(read({ adapter: `lab/${SLUG}`, reason: '  the lowest \n loss  ' }), { request: { slug: SLUG, reason: 'the lowest loss' } })
  assert.deepEqual(read({ adapter: SLUG, reason: 'x' }), { request: { slug: SLUG, reason: 'x' } })
  for (const [raw, word] of [
    [null, 'not an object'], ['lab/e41-0a1b2c3d', 'not an object'], [[], 'not an object'],
    [{ adapter: `lab/${SLUG}`, reason: 'x', days: 9000 }, 'unknown field: days'],
    [{ adapter: `lab/${SLUG}`, reason: 'x', unkeep: true }, 'unknown field: unkeep'],
    [{ adapter: 'Brass Finch', reason: 'x' }, 'lab id'], [{ adapter: 'lab/../x', reason: 'x' }, 'lab id'], [{ adapter: SAMPLER, reason: 'x' }, 'lab id'],
    [{ adapter: 7, reason: 'x' }, 'lab id'], [{ adapter: `lab/${SLUG}` }, 'reason'], [{ adapter: `lab/${SLUG}`, reason: '   ' }, 'reason'],
    [{ adapter: `lab/${SLUG}`, reason: 'x'.repeat(201) }, 'at most 200'],
  ]) {
    const out = read(raw)
    assert.ok('error' in out && out.error.includes(word), `${JSON.stringify(raw)}: ${JSON.stringify(out)}`)
  }
  enableKeep()
  // A malformed request is refused with its reason; a model has no way to ask for an unkeep.
  assert.deepEqual(keepPlan({ adapter: 'nonsense', reason: 'x' }).ignored, [{ tool: 'keep_adapter', reason: 'adapter must be the lab id of a trained adapter, like lab/e41-0a1b2c3d' }])
  const plan = toolRequests.planTools({ unkeep_adapter: { adapter: `lab/${SLUG}` }, keep_adapter: false }, toolsConfig.toolConfig())
  assert.deepEqual(plan.ignored, [{ tool: 'unkeep_adapter', reason: 'unknown tool' }])
  assert.equal(plan.keep_adapter, undefined)
})

test('an approved keep: the runner is sent the lab\'s own record, the adapter\'s life is extended, the copy is recorded, and it is listed first', async () => {
  enableKeep({ LAB_ENABLE_TINKER_NAMES: 'true' })
  const row = adapter({ name: 'Brass Finch' })
  const newer = adapter({ slug: 'e44-99990000', epoch: 44 })
  const before = row.expires_at
  const sent = []
  globalThis.fetch = keeperRunner(sent)
  const ctx = { ...CTX, epochNumber: 45, executorModelId: 'x-ai/grok-4.7', assignedExecutorId: 'x-ai/grok-4.7' }
  const out = await deliver(keepPlan(), approve, ctx)
  assert.equal(out.length, 1)
  assert.deepEqual([out[0].tool, out[0].status], ['keep_adapter', 'ok'])
  assert.match(out[0].summary, /^Grok 4\.7 kept lab\/e41-0a1b2c3d \("Brass Finch"\): kept until \d{4}-\d\d-\d\d \(its time to live on Tinker was set to 365 days\); a copy of its LoRA weights is on the lab's Volume oblab-kept-models under e41-0a1b2c3d\/ \(2 files, 18\.4 MB, PEFT format\); the lab's Tinker key now holds 41 checkpoints \(Tinker stores 100, or 100 GB, for free\)$/)

  // What went to the runner: the lab's token, the lab's record of the run, the limits. No Tinker key, nothing the model wrote but its reason.
  const start = sent.find(s => s.kind === 'start')
  assert.equal(start.headers.Authorization, `Bearer ${JOBS_TOKEN}`)
  assert.match(start.body.run_id, /^k-e41-0a1b2c3d-[0-9a-f]{8}$/)
  assert.deepEqual(Object.keys(start.body).sort(), ['keep', 'run_id'])
  const keep = start.body.keep
  assert.deepEqual([keep.slug, keep.base_model, keep.sampler_path, keep.external_path, keep.ttl_seconds, keep.max_bytes], [SLUG, BASE, SAMPLER, EXTERNAL, 365 * 86400, 1024 * 1024 * 1024])
  const m = keep.manifest
  assert.deepEqual([m.schema, m.lab_id, m.name, m.base_model, m.tinker_run_id, m.epoch, m.author_model, m.kept_by, m.kept_reason],
    ['observable-lab/kept-adapter/1', `lab/${SLUG}`, 'Brass Finch', BASE, '0a1b2c3d-1111-2222-3333-444455556666:train:0', 41, 'anthropic/claude-fable-5.2', 'Grok 4.7', 'the lowest held-out loss so far'])
  assert.deepEqual(m.dataset, { sha256: 'a'.repeat(64), examples: 20, bytes: 700 })
  assert.deepEqual([m.measured_by_the_lab.holdout_loss_before, m.measured_by_the_lab.holdout_loss_after, m.measured_by_the_lab.holdout_examples], [2.9531, 1.1042, 2])
  assert.ok(!Number.isNaN(Date.parse(m.kept_at)))
  assert.equal(start.raw.includes(TINKER_KEY), false)

  // The lab's own record: the place is taken, the adapter lives on, and the evidence is stored under the asking epoch.
  assert.deepEqual(lab.keeps.map(k => [k.slot, k.slug, k.status, k.kept_by, k.experiment_id, k.epoch]), [[1, SLUG, 'kept', 'x-ai/grok-4.7', 'exp-1', 45]])
  assert.ok(at(row.expires_at) > at(before) + 300 * 86400_000)
  assert.ok(at(row.expires_at) <= Date.now() + 365 * 86400_000)
  const record = keptRuns('keep_adapter')
  assert.deepEqual(record.map(r => [r.epoch, r.model, r.status, r.cost_usd]), [[45, 'x-ai/grok-4.7', 'ok', 0]])
  assert.equal(record[0].request_summary, 'keep lab/e41-0a1b2c3d ("Brass Finch"): the lowest held-out loss so far')
  const d = record[0].detail
  assert.deepEqual([d.adapter, d.name, d.kept_by, d.reason, d.base_model, d.dataset_sha256], [`lab/${SLUG}`, 'Brass Finch', 'Grok 4.7', 'the lowest held-out loss so far', BASE, 'a'.repeat(64)])
  assert.deepEqual(d.tinker, { ttl_seconds: 365 * 86400, checkpoints_in_account: 41 })
  assert.deepEqual([d.copy.status, d.copy.volume, d.copy.dir, d.copy.format, d.copy.bytes], ['ok', 'oblab-kept-models', SLUG, 'peft', 18_400_412])
  assert.deepEqual(d.copy.files, FILES)
  // Keeping uses no Tinker tokens: nothing is set aside and nothing goes on the ledger.
  assert.deepEqual(lab.modelCalls, [])
  assert.equal(lab.spendDays.size, 0)

  // Kept adapters come first, with a mark, however old they are.
  const listed = (await store.listAdapters()).map(t => t.adapter)
  assert.deepEqual(listed.map(a => [a.slug, a.kept ?? false]), [[SLUG, true], [newer.slug, false]])
  assert.deepEqual([listed[0].kept_by, listed[0].kept_reason, listed[0].name], ['Grok 4.7', 'the lowest held-out loss so far', 'Brass Finch'])
  assert.equal('kept' in listed[1], false)
  const views = panel.parseAdapters({ adapters: listed })
  const described = panel.describeAdapter(views[0])
  assert.deepEqual([described.title, described.id, described.mark], ['Brass Finch', `lab/${SLUG}`, 'kept'])
  assert.match(described.kept, /^Marked to keep by Grok 4\.7\. Stays until \d{4}-\d\d-\d\d\.$/)
  assert.equal(panel.describeAdapter(views[1]).mark, undefined)
  assert.equal(store.adapterDescription(listed[0]), `"Brass Finch", kept by Grok 4.7. A LoRA adapter trained in this lab on ${BASE}; the id is its identity, the name is a label.`)
  // The checkpoint path is still never part of what the public is sent.
  assert.equal(JSON.stringify(listed).includes('tinker://'), false)
})

test('nothing is kept without the Reviewer, for an adapter that is not alive, over the daily limit, or with the budget spent; each refusal is stored', async () => {
  enableKeep({ LAB_TINKER_KEEPS_PER_DAY: '1' })
  adapter()
  const sent = []
  globalThis.fetch = keeperRunner(sent)
  for (const verdicts of [{}, { keep_adapter: 'reject' }, { tinker_train: 'approve' }]) {
    lab.toolRuns.length = 0
    const out = await deliver(keepPlan(), verdicts)
    assert.deepEqual([out[0].tool, out[0].status, out[0].summary], ['keep_adapter', 'skipped', 'keep_adapter not run: the Reviewer did not approve it'])
    assert.deepEqual(keptRuns('keep_adapter').map(r => [r.status, r.output_tail]), [['skipped', 'the Reviewer did not approve it']])
  }
  assert.deepEqual([sent.length, lab.keeps.length], [0, 0])
  assert.deepEqual(epochTools.readToolVerdicts({ tool_verdicts: { keep_adapter: 'APPROVE', tinker_train: 'maybe' } }), { keep_adapter: 'approve' })

  // An adapter that does not exist, has expired, or did not train is not kept.
  lab.toolRuns.length = 0
  adapter({ slug: 'e30-11112222', expiresInMs: -1000 })
  for (const slug of ['e99-00000000', 'e30-11112222']) {
    const out = await deliver(keepPlan({ adapter: `lab/${slug}`, reason: 'x' }), approve)
    assert.equal(out[0].summary, `keep_adapter not run: no trained adapter lab/${slug} is alive (adapters expire)`)
  }
  assert.deepEqual([sent.length, lab.keeps.length], [0, 0])

  // The daily limit counts keeps that worked and keeps the runner has not answered yet.
  lab.toolRuns.length = 0
  assert.equal((await deliver(keepPlan(), approve))[0].status, 'ok')
  adapter({ slug: 'e42-22223333' })
  const over = await deliver(keepPlan({ adapter: 'lab/e42-22223333', reason: 'x' }), approve, { ...CTX, epochNumber: 46 })
  assert.equal(over[0].summary, 'keep_adapter not run: daily limit of 1 reached')
  lab.toolRuns.length = 0
  lab.keeps.length = 0
  lab.keeps.push({ slot: 1, slug: 'e60-0000aaaa', status: 'pending', kept_by: 'x-ai/grok-4.7', reason: 'x', experiment_id: 'exp-1', epoch: 40, job_id: 'k-e60-0000aaaa-00000000', call_id: 'fc-1', requested_at: new Date().toISOString(), kept_at: null, detail: null })
  assert.equal((await deliver(keepPlan({ adapter: 'lab/e42-22223333', reason: 'x' }), approve, { ...CTX, epochNumber: 46 }))[0].summary, 'keep_adapter not run: daily limit of 1 reached')
  // An owner's pending keep does not use up the models' limit.
  lab.keeps[0].kept_by = 'owner'
  assert.equal((await deliver(keepPlan({ adapter: 'lab/e42-22223333', reason: 'x' }), approve, { ...CTX, epochNumber: 46 }))[0].status, 'ok')

  // With the lab's daily budget spent nothing more is done that day, a keep included.
  lab.keeps.length = 0
  lab.toolRuns.length = 0
  process.env.LAB_DAILY_BUDGET_USD = '1'
  lab.modelCalls.push({ experiment_id: 'exp-1', epoch_number: 1, purpose: 'epoch', model_id: 'x', cost_usd: 5, created_at: new Date() })
  const spent = await deliver(keepPlan(), approve, { ...CTX, epochNumber: 47 })
  assert.equal(spent[0].status, 'skipped')
  assert.equal(lab.keeps.length, 0)
})

test('at most LAB_TINKER_KEEP_MAX adapters are kept, the database holds that cap, and an epoch gets one keep', async () => {
  enableKeep({ LAB_TINKER_KEEP_MAX: '2', LAB_TINKER_KEEPS_PER_DAY: '10' })
  const slugs = ['e41-0a1b2c3d', 'e42-22223333', 'e43-44445555']
  slugs.forEach(slug => adapter({ slug }))
  globalThis.fetch = keeperRunner([])
  const keep = (slug, epoch) => deliver(keepPlan({ adapter: `lab/${slug}`, reason: 'x' }), approve, { ...CTX, epochNumber: epoch })
  assert.equal((await keep(slugs[0], 50))[0].status, 'ok')
  // The same epoch asks again (a resumed follow-up, or a second request): one keep an epoch.
  lab.toolRuns.length = 0
  assert.equal((await keep(slugs[1], 50))[0].summary, 'keep_adapter not run: this epoch already asked for one adapter to be kept')
  // The same adapter twice.
  assert.equal((await keep(slugs[0], 51))[0].summary, 'keep_adapter not run: that adapter is already kept')
  assert.equal((await keep(slugs[1], 52))[0].status, 'ok')
  // Full: refused, by a model and by the owner alike, and nothing is sent to the runner.
  const sent = []
  globalThis.fetch = keeperRunner(sent)
  assert.equal((await keep(slugs[2], 53))[0].summary, 'keep_adapter not run: 2 adapters are kept and at most 2 may be; the owner has to unkeep one first')
  process.env.LAB_OPERATOR_SECRET = OPERATOR
  const owner = await operator({ action: 'keep', adapter: `lab/${slugs[2]}` })
  assert.deepEqual([owner.code, owner.body.status], [409, 'refused'])
  assert.equal(sent.length, 0)
  assert.deepEqual(lab.keeps.map(k => k.slot).sort(), [1, 2])

  // Requests arriving together cannot pass the cap between them: the claim is one statement and the slot is the key.
  lab.keeps.length = 0
  const many = Array.from({ length: 6 }, (_, i) => `e6${i}-0000000${i}`)
  many.forEach(slug => adapter({ slug }))
  const claims = await Promise.all(many.map((slug, i) => store.claimKeepSlot({ slug, keptBy: 'owner', reason: 'x', experimentId: null, epoch: null, jobId: `k-${slug}-0000000${i}`, max: 2 })))
  assert.equal(claims.filter(c => c.ok).length, 2)
  assert.equal(lab.keeps.length, 2)
  assert.ok(claims.filter(c => !c.ok).every(c => /at most 2 may be/.test(c.reason)))
  // Two requests arriving together both aim at the lowest free slot. The one that gets no row back was not refused by
  // the cap, so it looks again and takes the next free place.
  lab.keeps.length = 0
  const claim = (slug, extra = {}) => store.claimKeepSlot({ slug, keptBy: 'owner', reason: 'x', experimentId: null, epoch: null, jobId: `k-${slug}-00000000`, max: 3, ...extra })
  lab.keepRaces.push({ slug: many[0] })
  const second = await claim(many[1])
  assert.deepEqual([second.ok, second.row?.slot], [true, 2])
  assert.deepEqual(lab.keeps.map(k => [k.slot, k.slug]), [[1, many[0]], [2, many[1]]])
  // The rival took the last place: full, said as full.
  lab.keepRaces.push({ slug: many[2] })
  assert.deepEqual(await claim(many[3]), { ok: false, reason: '3 adapters are kept and at most 3 may be; the owner has to unkeep one first' })
  // The rival was this same adapter, or this same epoch: looking again finds that, and says which.
  lab.keeps.length = 0
  lab.keepRaces.push({ slug: many[4] })
  assert.deepEqual(await claim(many[4]), { ok: false, reason: 'that adapter is already being kept' })
  lab.keepRaces.push({ slug: many[5], kept_by: 'x-ai/grok-4.7', experiment_id: 'exp-1', epoch: 70 })
  assert.deepEqual(await claim(many[0], { keptBy: 'x-ai/grok-4.7', experimentId: 'exp-1', epoch: 70 }), { ok: false, reason: 'this epoch already asked for one adapter to be kept' })
  // It does not look for ever: beaten at every attempt, it stops, changes nothing and says why.
  lab.keeps.length = 0
  for (let i = 0; i < store.KEEP_CLAIM_ATTEMPTS; i++) lab.keepRaces.push({ slug: `e7${i}-0000000${i}` })
  const beaten = await store.claimKeepSlot({ slug: many[0], keptBy: 'owner', reason: 'x', experimentId: null, epoch: null, jobId: 'k-x', max: 40 })
  assert.deepEqual(beaten, { ok: false, reason: 'other requests took a place at the same moment, several times over; nothing was changed' })
  assert.equal(lab.keeps.some(k => k.slug === many[0]), false)
  assert.equal(lab.keeps.length, store.KEEP_CLAIM_ATTEMPTS)
  lab.keeps.length = 0
  many.slice(0, 2).forEach((slug, i) => lab.keeps.push({ slot: i + 1, slug, status: 'kept', kept_by: 'owner', reason: 'x', experiment_id: null, epoch: null, job_id: 'k-x', call_id: null, requested_at: new Date().toISOString(), kept_at: new Date().toISOString(), detail: null }))
  // Lowering the limit below what is kept keeps nothing new and removes nothing.
  assert.deepEqual(await store.claimKeepSlot({ slug: many[5], keptBy: 'owner', reason: 'x', experimentId: null, epoch: null, jobId: 'k-x', max: 1 }),
    { ok: false, reason: '2 adapters are kept and at most 1 may be; the owner has to unkeep one first' })
  assert.equal((await store.claimKeepSlot({ slug: many[5], keptBy: 'owner', reason: 'x', experimentId: null, epoch: null, jobId: 'k-x', max: 0 })).ok, false)
})

test('a keep that fails gives its place back and says why; a copy that fails does not undo the keep', async () => {
  enableKeep()
  const row = adapter()
  const before = row.expires_at
  // The runner could not set the time to live: not kept.
  globalThis.fetch = keeperRunner([], { status: 'error', stage: 'ttl', error: '404 checkpoint not found' })
  const failed = await deliver(keepPlan(), approve)
  assert.deepEqual([failed[0].status, failed[0].summary], ['error', 'lab/e41-0a1b2c3d was not kept: at ttl: 404 checkpoint not found'])
  assert.equal(lab.keeps.length, 0)
  assert.equal(row.expires_at, before)
  assert.match(keptRuns('keep_adapter')[0].output_tail, /^not kept: at ttl: 404 checkpoint not found; its place was given back and it still expires on \d{4}-\d\d-\d\d$/)
  assert.equal('tinker_time_to_live' in keptRuns('keep_adapter')[0].detail, false)
  // An "ok" that does not say the time to live was set is not an ok.
  lab.toolRuns.length = 0
  globalThis.fetch = keeperRunner([], { status: 'ok', copy: { status: 'ok', dir: SLUG, files: FILES } })
  assert.equal((await deliver(keepPlan(), approve, { ...CTX, epochNumber: 42 }))[0].status, 'error')
  assert.equal(lab.keeps.length, 0)
  // The runner refused to start (an older runner that knows no keep answers 400): nothing was started, the place is given back.
  lab.toolRuns.length = 0
  globalThis.fetch = fakeRunner([], undefined, new Response('{"detail":"the job is not an object"}', { status: 400 }))
  const old = await deliver(keepPlan(), approve, { ...CTX, epochNumber: 43 })
  assert.deepEqual([old[0].status, old[0].summary], ['error', 'lab/e41-0a1b2c3d was not kept: start failed: HTTP 400'])
  assert.equal(lab.keeps.length, 0)
  assert.equal(keptRuns('keep_adapter')[0].status, 'error')

  // The copy failed but the time to live was set: kept, and the record says there is no copy and why.
  lab.toolRuns.length = 0
  globalThis.fetch = keeperRunner([], keeperOk({ copy: { status: 'error', reason: 'the weights are larger than the 1073741824 bytes a copy may weigh' } }))
  const noCopy = await deliver(keepPlan(), approve, { ...CTX, epochNumber: 44 })
  assert.equal(noCopy[0].status, 'ok')
  assert.match(noCopy[0].summary, /no copy of its weights was made: the weights are larger than/)
  assert.equal(lab.keeps[0].status, 'kept')
  assert.deepEqual(keptRuns('keep_adapter')[0].detail.copy, { status: 'error', reason: 'the weights are larger than the 1073741824 bytes a copy may weigh' })

  // A copy the runner describes badly is not taken for one: a folder outside the adapter's own, or a file path that climbs out.
  for (const copy of [{ status: 'ok', dir: '../other', files: FILES }, { status: 'ok', dir: SLUG, files: [{ path: '../../x', bytes: 1, sha256: 'e'.repeat(64) }] }, { status: 'ok', dir: SLUG, files: [] }]) {
    const read = keepLib.normalizeKeepResult(keeperOk({ copy }))
    assert.deepEqual([read.status, read.copy.status, read.copy.dir], ['ok', 'error', null])
  }
})

test('an adapter trained before keeping was on is kept without a copy, and a run trained with it on asks the runner to save its weights for download', async () => {
  enableKeep()
  adapter({ external: false })
  const sent = []
  globalThis.fetch = keeperRunner(sent, keeperOk({ copy: { status: 'none', reason: 'this adapter was trained before keeping was switched on, so Tinker has no downloadable weights for it' } }))
  const out = await deliver(keepPlan(), approve)
  assert.equal(out[0].status, 'ok')
  assert.equal(sent[0].body.keep.external_path, null)
  assert.match(out[0].summary, /no copy of its weights was made: this adapter was trained before keeping was switched on/)

  // Training with keeping on: the runner is asked, and what it saved is in the run's record.
  lab.tinkerRuns.length = 0
  lab.keeps.length = 0
  lab.toolRuns.length = 0
  const trained = []
  globalThis.fetch = fakeRunner(trained, [{ status: 'done', result: runnerOk({ external_path: EXTERNAL }) }])
  await deliver(planFor(ask()), { tinker_train: 'approve' }, { ...CTX, epochNumber: 60 })
  assert.equal(trained[0].body.train.export, true)
  assert.equal(JSON.parse(lab.tinkerRuns[0].result).external_path, EXTERNAL)
  assert.equal(keptRuns('tinker_train')[0].detail.external_path, EXTERNAL)
  assert.equal(store.externalPathOf(store.publicAdapter ? { result: JSON.parse(lab.tinkerRuns[0].result) } : {}), EXTERNAL)
  // A save for download that failed is recorded, and the run stands. Anything that is not such a path is not taken for one.
  lab.tinkerRuns.length = 0
  lab.toolRuns.length = 0
  globalThis.fetch = fakeRunner([], [{ status: 'done', result: runnerOk({ export_error: 'storage limit reached' }) }])
  assert.equal((await deliver(planFor(ask()), { tinker_train: 'approve' }, { ...CTX, epochNumber: 61 }))[0].status, 'ok')
  assert.equal(keptRuns('tinker_train')[0].detail.export_error, 'storage limit reached')
  assert.equal('external_path' in tinker.normalizeTinkerResult(runnerOk({ external_path: SAMPLER })), false)
  assert.equal('external_path' in tinker.normalizeTinkerResult(runnerOk({ external_path: 'https://example.com/x' })), false)
})

test('a keep still going when the wait ends is collected by a later tick, once; one whose start was never confirmed gives its place back', async () => {
  enableKeep()
  adapter()
  const sent = []
  globalThis.fetch = fakeRunner(sent, [{ status: 'running' }])
  const out = await keepLib.keepAdapter({ slug: SLUG, reason: 'x' }, { by: 'model', modelId: 'x-ai/grok-4.7', experimentId: 'exp-1', epoch: 45 }, { maxWaitMs: 20, pollMs: 5 })
  assert.deepEqual([out.status, out.summary], ['started', 'keeping lab/e41-0a1b2c3d has started; the lab collects the result at a later hourly check'])
  assert.deepEqual(lab.keeps.map(k => [k.status, k.call_id]), [['pending', 'fc-test-1']])
  assert.equal(keptRuns('keep_adapter').length, 0)
  // While it is going the adapter is not listed as kept, and cannot be asked for again or unkept.
  assert.equal('kept' in (await store.listAdapters())[0].adapter, false)
  assert.equal((await keepLib.keepAdapter({ slug: SLUG, reason: 'x' }, { by: 'owner' })).summary, 'that adapter is already being kept')
  assert.equal((await keepLib.unkeepAdapter(SLUG)).status, 'pending')
  // Still running at the next tick: nothing changes.
  assert.deepEqual(await keepLib.collectTinkerKeeps(), [])
  // The status call fails at the tick after that, when the keep is most of an hour old (the tick is hourly, and a keep
  // asked for during an epoch is 40 to 55 minutes old at the first one). The keeper may have finished long ago with
  // the year set on Tinker, so one call that did not answer settles nothing: the place stays taken and nothing is stored.
  const hour = 60 * 60 * 1000
  for (const down of [async () => new Response('bad gateway', { status: 502 }), async () => { throw new Error('socket hang up') }]) {
    globalThis.fetch = down
    for (const age of [55 * 60 * 1000, hour + 55 * 60 * 1000, keepLib.KEEP_LOST_AFTER_MS - 60_000]) {
      assert.deepEqual(await keepLib.collectTinkerKeeps(new Date(Date.now() + age)), [])
    }
    assert.deepEqual(lab.keeps.map(k => k.status), ['pending'])
    assert.equal(keptRuns('keep_adapter').length, 0)
  }
  // The lab goes on asking for at least three ticks before it gives up, and the keeper's own time limit is far inside that.
  assert.ok(keepLib.KEEP_LOST_AFTER_MS >= 3 * hour)
  assert.ok(keepLib.KEEP_UNCONFIRMED_AFTER_MS > hour && keepLib.KEEP_UNCONFIRMED_AFTER_MS < keepLib.KEEP_LOST_AFTER_MS)
  // Done at the one after: closed once, with its record.
  globalThis.fetch = keeperRunner(sent)
  const collected = await keepLib.collectTinkerKeeps()
  assert.deepEqual(collected.map(o => o.status), ['ok'])
  assert.deepEqual(await keepLib.collectTinkerKeeps(), [])
  assert.deepEqual(keptRuns('keep_adapter').map(r => [r.epoch, r.status]), [[45, 'ok']])
  assert.equal(lab.keeps[0].status, 'kept')

  // A start whose answer was lost: the place stays taken, the runner is asked by the keep's name, and it is found.
  lab.keeps.length = 0
  lab.toolRuns.length = 0
  const remembered = new Map()
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === START_URL) {
      remembered.set(JSON.parse(options.body).run_id, 'fc-lost-1')
      throw new Error('socket hang up')
    }
    return fakeRunner([], [{ status: 'done', result: keeperOk() }], undefined, remembered)(url, options)
  }
  const found = await keepLib.keepAdapter({ slug: SLUG, reason: 'x' }, { by: 'owner' }, { maxWaitMs: 20, pollMs: 5 })
  assert.equal(found.status, 'ok')
  // Lost, and the runner knows no such keep: the place is given back once enough time has passed, with the reason stored.
  lab.keeps.length = 0
  lab.toolRuns.length = 0
  globalThis.fetch = async url => {
    if (String(url) === START_URL) throw new Error('socket hang up')
    return new Response(JSON.stringify({ status: 'unknown' }), { headers: { 'content-type': 'application/json' } })
  }
  const lost = await keepLib.keepAdapter({ slug: SLUG, reason: 'x' }, { by: 'owner' }, { maxWaitMs: 20, pollMs: 5 })
  assert.equal(lost.status, 'error')
  assert.equal(lab.keeps.length, 1)
  assert.deepEqual(await keepLib.collectTinkerKeeps(), [])
  // Not at the first tick either, most of an hour on: "no call known" is also what one failed request looks like.
  assert.deepEqual(await keepLib.collectTinkerKeeps(new Date(Date.now() + 55 * 60 * 1000)), [])
  assert.equal(lab.keeps.length, 1)
  const later = await keepLib.collectTinkerKeeps(new Date(Date.now() + keepLib.KEEP_UNCONFIRMED_AFTER_MS + 1000))
  assert.deepEqual(later.map(o => o.status), ['error'])
  assert.equal(lab.keeps.length, 0)
  assert.match(keptRuns('owner_keep_adapter')[0].output_tail, /not kept: the runner was lost: its start was never confirmed/)
  // A lost runner cannot say whether it set the time to live on Tinker, so the record says that is not known.
  assert.match(keptRuns('owner_keep_adapter')[0].output_tail, /in the lab's record it still expires on \d{4}-\d\d-\d\d\. The runner may have set the long time to live on Tinker before it was lost/)
  assert.equal(keptRuns('owner_keep_adapter')[0].detail.tinker_time_to_live, 'unknown: the runner was lost')
  // Started, and then the runner never answers again: after three hours of asking the lab gives up, with the same honest record.
  lab.keeps.length = 0
  lab.toolRuns.length = 0
  globalThis.fetch = fakeRunner([], [{ status: 'running' }])
  assert.equal((await keepLib.keepAdapter({ slug: SLUG, reason: 'x' }, { by: 'owner' }, { maxWaitMs: 20, pollMs: 5 })).status, 'started')
  globalThis.fetch = async () => new Response('bad gateway', { status: 502 })
  const gone = await keepLib.collectTinkerKeeps(new Date(Date.now() + keepLib.KEEP_LOST_AFTER_MS + 60_000))
  assert.deepEqual(gone.map(o => o.status), ['error'])
  assert.equal(lab.keeps.length, 0)
  assert.match(keptRuns('owner_keep_adapter')[0].output_tail, /not kept: the runner was lost: no answer long after its time limit/)
  assert.equal(keptRuns('owner_keep_adapter')[0].detail.tinker_time_to_live, 'unknown: the runner was lost')
  // A runner that says the keep failed is believed at once, however young the keep is.
  lab.toolRuns.length = 0
  globalThis.fetch = fakeRunner([], [{ status: 'running' }])
  assert.equal((await keepLib.keepAdapter({ slug: SLUG, reason: 'x' }, { by: 'owner' }, { maxWaitMs: 20, pollMs: 5 })).status, 'started')
  globalThis.fetch = fakeRunner([], [{ status: 'failed', error: "the run's result expired before it was collected" }])
  assert.deepEqual((await keepLib.collectTinkerKeeps()).map(o => o.status), ['error'])
  assert.equal(lab.keeps.length, 0)
  // With the switch off the tick does not look at all.
  lab.statements.length = 0
  process.env.LAB_ENABLE_TINKER_KEEP = 'false'
  assert.deepEqual(await keepLib.collectTinkerKeeps(), [])
  assert.equal(lab.statements.length, 0)
})

test('the owner keeps and unkeeps through an operator route; unkeeping is the owner\'s alone and works with the switch off', async () => {
  enableKeep()
  const row = adapter({ name: 'Brass Finch' })
  // Operator only: no secret configured, no token, a wrong token.
  assert.equal((await operator({ action: 'keep', adapter: `lab/${SLUG}` })).code, 503)
  process.env.LAB_OPERATOR_SECRET = OPERATOR
  for (const token of [null, 'wrong', JOBS_TOKEN]) {
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await operator({ action: 'keep', adapter: `lab/${SLUG}` }, { token, method })).code, 401)
  }
  assert.equal(lab.keeps.length, 0)
  // Bad requests change nothing.
  assert.equal((await operator({ action: 'keep', adapter: `lab/${SLUG}` }, { confirm: false })).code, 400)
  assert.equal((await operator({ action: 'keep', adapter: 'Brass Finch' })).code, 400)
  assert.equal((await operator({ action: 'delete', adapter: `lab/${SLUG}` })).code, 400)
  assert.equal((await operator({ action: 'keep', adapter: `lab/${SLUG}`, reason: 'x'.repeat(201) })).code, 400)
  assert.equal((await operator({ action: 'unkeep', adapter: `lab/${SLUG}`, remove_copy: 'yes' })).code, 400)
  assert.equal((await operator({}, { method: 'PUT' })).code, 405)

  const sent = []
  globalThis.fetch = keeperRunner(sent)
  const kept = await operator({ action: 'keep', adapter: `lab/${SLUG}`, reason: 'worth a second look' })
  assert.deepEqual([kept.code, kept.body.status, kept.headers['Cache-Control']], [200, 'ok', 'no-store'])
  assert.equal(sent[0].body.keep.manifest.kept_by, 'the owner')
  // Stored under the adapter's own epoch and its own tool name, so it never stands in for a model's keep.
  assert.deepEqual(keptRuns('owner_keep_adapter').map(r => [r.experiment_id, r.epoch, r.model, r.status]), [['exp-1', 41, 'owner', 'ok']])
  assert.deepEqual(lab.keeps.map(k => [k.kept_by, k.experiment_id, k.epoch, k.reason]), [['owner', null, null, 'worth a second look']])
  const keptUntil = row.expires_at

  // What the owner sees.
  const overview = await operator(undefined, { method: 'GET', confirm: false })
  assert.deepEqual([overview.code, overview.body.enabled, overview.body.kept, overview.body.pending, overview.body.max], [200, true, 1, 0, 10])
  assert.deepEqual(overview.body.adapters.map(a => [a.slug, a.kept, a.kept_by]), [[SLUG, true, 'the owner']])
  assert.deepEqual(overview.body.keeps.map(k => [k.slot, k.slug, k.status, k.kept_by]), [[1, SLUG, 'kept', 'the owner']])
  assert.equal(JSON.stringify(overview.body).includes(JOBS_TOKEN), false)

  // Unkeep with the switch off: the runner sets the usual time to live, the copy stays, the place is free.
  process.env.LAB_ENABLE_TINKER_KEEP = 'false'
  sent.length = 0
  globalThis.fetch = keeperRunner(sent, { status: 'ok', ttl_seconds: 14 * 86400, checkpoints: null, copy: { status: 'none', reason: 'The copy on the Volume was left where it is.' } })
  const unkept = await operator({ action: 'unkeep', adapter: `lab/${SLUG}` })
  assert.deepEqual([unkept.code, unkept.body.status], [200, 'unkept'])
  assert.match(unkept.body.message, /^lab\/e41-0a1b2c3d is no longer kept; it now expires on \d{4}-\d\d-\d\d\. Its time to live on Tinker was set to 14 days from now\. The copy on the Volume was left where it is\.$/)
  assert.match(sent[0].body.run_id, /^u-e41-0a1b2c3d-[0-9a-f]{8}$/)
  assert.deepEqual(sent[0].body.unkeep, { slug: SLUG, sampler_path: SAMPLER, external_path: EXTERNAL, ttl_seconds: 14 * 86400, remove_copy: false })
  assert.equal(lab.keeps.length, 0)
  assert.ok(at(row.expires_at) < at(keptUntil) && at(row.expires_at) > Date.now() + 13 * 86400_000)
  assert.deepEqual(keptRuns('owner_unkeep_adapter').map(r => [r.epoch, r.model, r.status]), [[41, 'owner', 'ok']])
  assert.equal((await operator({ action: 'unkeep', adapter: `lab/${SLUG}` })).code, 404)
  // With the switch off nothing new is kept.
  assert.deepEqual([(await operator({ action: 'keep', adapter: `lab/${SLUG}` })).code, lab.keeps.length], [409, 0])

  // remove_copy is passed on; a runner that does not answer changes nothing in the lab's record, so the call can be made again.
  process.env.LAB_ENABLE_TINKER_KEEP = 'true'
  globalThis.fetch = keeperRunner([])
  await operator({ action: 'keep', adapter: `lab/${SLUG}` })
  globalThis.fetch = keeperRunner([], { status: 'error', stage: 'ttl', error: 'Tinker is down' })
  const down = await operator({ action: 'unkeep', adapter: `lab/${SLUG}`, remove_copy: true })
  assert.deepEqual([down.code, down.body.status, lab.keeps.length], [502, 'failed', 1])
  sent.length = 0
  globalThis.fetch = keeperRunner(sent, { status: 'ok', ttl_seconds: 14 * 86400, copy: { status: 'none', reason: 'The copy on the Volume was removed.' } })
  const removed = await operator({ action: 'unkeep', adapter: `lab/${SLUG}`, remove_copy: true })
  assert.equal(sent[0].body.unkeep.remove_copy, true)
  assert.match(removed.body.message, /The copy on the Volume was removed\.$/)

  // The owner can take a name away; the adapter stays.
  process.env.LAB_ENABLE_TINKER_NAMES = 'true'
  const cleared = await operator({ action: 'clear_name', adapter: `lab/${SLUG}` })
  assert.deepEqual([cleared.code, cleared.body.ok, row.display_name, row.name_key], [200, true, null, null])
  assert.equal(keptRuns('owner_clear_adapter_name').length, 1)
  assert.equal((await operator({ action: 'clear_name', adapter: `lab/${SLUG}` })).code, 404)
  // The Activity panel has words for all of it, and the owner is named as the owner.
  const built = activity.buildEpochActivity({ epoch: { epoch_number: 41, role_assignments: {} }, toolRuns: lab.toolRuns.map(r => ({ ...r })), contributions: [], spend: [] })
  assert.ok(built.tools.every(t => t.model_name === 'The owner'))
  const html = activityPanel.renderEpochActivity(built)
  for (const words of ['kept a trained adapter', 'stopped keeping a trained adapter', 'took a display name off an adapter']) assert.ok(html.includes(words), words)
})

test('a keep lasts as long as the life it set on Tinker: an expired kept adapter gives its place back, with a record, and the owner can still unkeep one', async () => {
  enableKeep({ LAB_TINKER_KEEP_MAX: '1' })
  process.env.LAB_OPERATOR_SECRET = OPERATOR
  const old = adapter({ name: 'Brass Finch' })
  adapter({ slug: 'e42-11111111', epoch: 42 })
  globalThis.fetch = keeperRunner([])
  assert.equal((await keepLib.keepAdapter({ slug: SLUG, reason: 'x' }, { by: 'model', modelId: 'x-ai/grok-4.7', experimentId: 'exp-1', epoch: 45 })).status, 'ok')
  // The one place is taken while the kept adapter is alive.
  assert.match((await keepLib.keepAdapter({ slug: 'e42-11111111', reason: 'y' }, { by: 'owner' })).summary, /1 adapters are kept and at most 1 may be/)
  assert.deepEqual(await keepLib.collectTinkerKeeps(), [])
  assert.equal(lab.keeps.length, 1)

  // Its year on Tinker runs out. The tick gives the place back, once, and stores that it did. Tinker is not asked anything.
  old.expires_at = new Date(Date.now() - 1000).toISOString()
  const sent = []
  globalThis.fetch = keeperRunner(sent)
  const released = await keepLib.collectTinkerKeeps()
  assert.deepEqual(released.map(o => [o.tool, o.status]), [['kept_adapter_expired', 'ok']])
  assert.deepEqual([lab.keeps.length, sent.length], [0, 0])
  assert.deepEqual(await keepLib.collectTinkerKeeps(), [])
  const record = keptRuns('kept_adapter_expired')
  assert.deepEqual(record.map(r => [r.experiment_id, r.epoch, r.model, r.status]), [['exp-1', 41, 'x-ai/grok-4.7', 'ok']])
  assert.equal(record[0].request_summary, 'kept adapter lab/e41-0a1b2c3d reached the end of its time on Tinker')
  assert.match(record[0].output_tail, /^no longer kept: its time on Tinker ended on \d{4}-\d\d-\d\d, so it has expired like any other adapter and its place among the kept was given back\. The copy of its weights on the lab's Volume oblab-kept-models stays\.$/)
  assert.deepEqual([record[0].detail.adapter, record[0].detail.was_kept_by, record[0].detail.copy_stays], ['lab/e41-0a1b2c3d', 'Grok 4.7', true])
  // It does not count as a keep request of today, and the place can be taken again.
  assert.equal((await keepLib.keepAdapter({ slug: 'e42-11111111', reason: 'y' }, { by: 'owner' })).status, 'ok')
  assert.deepEqual(lab.keeps.map(k => k.slug), ['e42-11111111'])
  const html = activityPanel.renderEpochActivity(activity.buildEpochActivity({ epoch: { epoch_number: 41, role_assignments: {} }, toolRuns: record.map(r => ({ ...r })), contributions: [], spend: [] }))
  assert.ok(html.includes('<b>Grok 4.7</b> had a kept adapter reach the end of its time'))

  // A keep asked for when every place is held by an expired adapter frees that place first, without waiting for a tick.
  lab.tinkerRuns.find(r => r.slug === 'e42-11111111').expires_at = new Date(Date.now() - 1000).toISOString()
  adapter({ slug: 'e43-22222222', epoch: 43 })
  assert.equal((await keepLib.keepAdapter({ slug: 'e43-22222222', reason: 'z' }, { by: 'owner' })).status, 'ok')
  assert.deepEqual(lab.keeps.map(k => k.slug), ['e43-22222222'])
  assert.equal(keptRuns('kept_adapter_expired').length, 2)

  // The owner unkeeps an adapter that expired before any tick noticed: nothing is asked of Tinker (the checkpoint is gone),
  // the place is free, and the date it expired on is left as it is.
  const gone = lab.tinkerRuns.find(r => r.slug === 'e43-22222222')
  gone.expires_at = new Date(Date.now() - 5000).toISOString()
  const expiredOn = gone.expires_at
  sent.length = 0
  const unkept = await operator({ action: 'unkeep', adapter: 'lab/e43-22222222', remove_copy: true })
  assert.deepEqual([unkept.code, unkept.body.status, sent.length, lab.keeps.length, gone.expires_at], [200, 'unkept', 0, 0, expiredOn])
  assert.match(unkept.body.message, /^lab\/e43-22222222 is no longer kept; it expired on \d{4}-\d\d-\d\d\. It had already expired, so Tinker was not asked to change anything\. Any copy on the Volume was left where it is; remove it with: modal volume rm -r oblab-kept-models e43-22222222$/)
})

test('a lab that never kept anything gets no new table from the owner looking, and the keeper has the training key while the web endpoints do not', async () => {
  enableTinker()
  process.env.LAB_OPERATOR_SECRET = OPERATOR
  adapter()
  lab.noKeepTables = true
  const overview = await operator(undefined, { method: 'GET', confirm: false })
  assert.deepEqual([overview.code, overview.body.enabled, overview.body.kept, overview.body.adapters.length], [200, false, 0, 1])
  assert.equal((await operator({ action: 'unkeep', adapter: `lab/${SLUG}` })).code, 404)
  assert.equal(lab.statements.some(s => /^(CREATE|ALTER)\b/.test(s.text) && /tinker_keeps|display_name|name_key/.test(s.text)), false)

  const source = readFileSync(join(root, 'modal', 'tinker_jobs.py'), 'utf8')
  assert.match(source, /@app\.function\(image=train_image, secrets=\[modal\.Secret\.from_name\("oblab-tinker-auth"\)\], volumes=\{KEPT_DIR: kept_volume\},\s+timeout=KEEP_TIMEOUT_S, retries=0, max_containers=1/)
  assert.equal((source.match(/secrets=\[modal\.Secret\.from_name\("oblab-tinker-jobs-auth"\)\]/g) || []).length, 2)
  // A server secret written into a reason is taken out before the reason is stored, so it reaches neither the runner nor the record.
  enableKeep({ TINKER_API_KEY: TINKER_KEY })
  lab.noKeepTables = false
  const sent = []
  globalThis.fetch = keeperRunner(sent)
  const kept = await operator({ action: 'keep', adapter: `lab/${SLUG}`, reason: `my key is ${TINKER_KEY}` })
  assert.equal(kept.code, 200)
  assert.ok(sent.length > 0)
  for (const request of sent) assert.equal(JSON.stringify(request).includes(TINKER_KEY), false)
  assert.equal(JSON.stringify([lab.keeps, lab.toolRuns, kept.body, logs]).includes(TINKER_KEY), false)
})

test('with keeping on, the models are told what it does and where its limits are, the adapters alive are listed, and the Reviewer gets the lab\'s record', async () => {
  enableKeep({ LAB_TINKER_KEEP_MAX: '3' })
  const told = prompts.toolLines()
  assert.match(told, /Keeping a trained adapter: as Executor you may ask the lab to mark one trained adapter that is still alive as kept, by its lab id, with a one-line reason\./)
  assert.match(told, /It needs the Reviewer's approval/)
  assert.match(told, /At most one request an epoch and 2 a day, and at most 3 adapters are kept at one time/)
  assert.match(told, /only the owner can unkeep one/)
  assert.match(told, /stays on Tinker for 365 days from the day it is kept instead of expiring 14 days after training/)
  assert.match(told, /a copy may be at most 1024 MB and can only be made of an adapter that was trained while keeping was switched on/)
  assert.match(told, /The request, its reason and what was done are public\./)
  // While adapters can be marked kept, "kept" means only that: the training line calls an adapter that has not expired alive.
  assert.match(told, /The adapter stays for 14 days and then expires, unless it is marked kept\./)
  assert.equal(/The adapter is kept for 14 days/.test(told), false)
  assert.match(tinker.tinkerNote({ perDay: 2, liveTrained: true, keep: true }), /While an adapter is alive, the lab model endpoint also answers for it/)
  // An ability with its limits, not a goal.
  for (const nudge of [/should keep/i, /keep the best/i, /you are encouraged/i, /try to/i, /worth keeping/i]) assert.equal(nudge.test(told), false, String(nudge))
  const section = prompts.executorToolsSection()
  assert.match(section, /"keep_adapter": \{ "adapter": "the lab id of a trained adapter that is alive, like lab\/e41-0a1b2c3d", "reason": "one line, at most 200 characters" \}/)
  assert.match(section, /Nothing is kept without the Reviewer's approval\./)

  assert.equal(await keepLib.adaptersContext(), '', 'no adapters, no section')
  adapter()
  adapter({ slug: 'e44-99990000', epoch: 44, external: false })
  const context = await keepLib.adaptersContext()
  assert.match(context, /^- lab\/e44-99990000: trained in epoch 44 by Claude Fable 5\.2 on 20 examples, base model Qwen\/Qwen3\.5-4B; LAB-MEASURED held-out loss 2\.9531 before training, 1\.1042 after, on 2 held-out examples; alive until \d{4}-\d\d-\d\d$/m)
  assert.match(context, /\n0 of 3 places for kept adapters are taken\.$/)

  const facts = await keepLib.keepReviewFacts({ slug: SLUG, reason: 'the lowest loss' }, { modelId: 'x-ai/grok-4.7' })
  assert.match(facts.line, /^Grok 4\.7 asks the lab to mark adapter lab\/e41-0a1b2c3d as kept, with the reason: "the lowest loss"\. The lab's record of it: lab\/e41-0a1b2c3d: trained in epoch 41/)
  assert.match(facts.line, /If you approve, it stays on Tinker for 365 days from now and a copy of its weights can be stored; 0 of 3 places are taken$/)
  const old = await keepLib.keepReviewFacts({ slug: 'e44-99990000', reason: 'x' }, { modelId: 'x-ai/grok-4.7' })
  assert.match(old.line, /no copy of its weights can be stored \(it was trained before keeping was switched on\), so only its life would be extended/)
  const gone = await keepLib.keepReviewFacts({ slug: 'e99-00000000', reason: 'x' }, { modelId: 'x-ai/grok-4.7' })
  assert.match(gone.line, /The lab's record: no adapter with that id is alive, so nothing would be kept$/)
  const asked = prompts.reviewerToolSection({ keep_adapter: facts })
  assert.match(asked, /- Keeping a trained adapter: Grok 4\.7 asks/)
  assert.match(asked, /\{ "keep_adapter": "approve" \| "reject" \}\. Nothing is opened or kept without "approve"\./)
  // No em dash or en dash in anything a visitor or a model is shown.
  for (const file of ['api/_lib/tinker-keep.ts', 'api/_lib/tinker-keep-request.ts', 'api/_lib/tinker-names.ts', 'api/experiment/trained-adapters.ts']) {
    assert.equal(/[—–]/.test(readFileSync(join(root, file), 'utf8')), false, file)
  }
})

test('the documents state the switches, the limits and the owner\'s steps as the code has them', () => {
  const tools = readFileSync(join(root, 'docs/TOOLS.md'), 'utf8')
  const ops = readFileSync(join(root, 'docs/OPERATIONS.md'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  for (const name of ['LAB_ENABLE_TINKER_NAMES', 'LAB_ENABLE_TINKER_KEEP', 'LAB_TINKER_KEEP_MAX', 'LAB_TINKER_KEEPS_PER_DAY', 'LAB_TINKER_KEEP_DAYS', 'LAB_TINKER_KEEP_MAX_MB']) {
    for (const [doc, text] of [['TOOLS.md', tools], ['OPERATIONS.md', ops], ['.env.example', env]]) assert.ok(text.includes(name), `${name} in ${doc}`)
  }
  // Off in the example file, with the defaults the code has.
  for (const line of ['LAB_ENABLE_TINKER_NAMES=false', 'LAB_ENABLE_TINKER_KEEP=false', `LAB_TINKER_KEEP_MAX=${tinker.DEFAULT_TINKER_KEEP_MAX}`, 'LAB_TINKER_KEEPS_PER_DAY=2',
    `LAB_TINKER_KEEP_DAYS=${tinker.DEFAULT_TINKER_KEEP_DAYS}`, `LAB_TINKER_KEEP_MAX_MB=${tinker.DEFAULT_TINKER_KEEP_MAX_MB}`]) {
    assert.ok(env.split('\n').includes(line), `${line} in .env.example`)
  }
  for (const row of [
    `| \`LAB_TINKER_KEEP_MAX\` | ${tinker.DEFAULT_TINKER_KEEP_MAX} |`, '| `LAB_TINKER_KEEPS_PER_DAY` | 2 |',
    `| \`LAB_TINKER_KEEP_DAYS\` | ${tinker.DEFAULT_TINKER_KEEP_DAYS} |`, `| \`LAB_TINKER_KEEP_MAX_MB\` | ${tinker.DEFAULT_TINKER_KEEP_MAX_MB} |`,
    '| `LAB_ENABLE_TINKER_NAMES` | false |', '| `LAB_ENABLE_TINKER_KEEP` | false |',
  ]) assert.ok(ops.includes(row), `${row} in OPERATIONS.md`)
  assert.ok(tools.includes(`\`LAB_TINKER_KEEP_MAX\` (default ${tinker.DEFAULT_TINKER_KEEP_MAX}, never more than ${tinker.TINKER_HARD_KEEP_MAX})`))
  assert.ok(tools.includes(`\`LAB_TINKER_KEEP_DAYS\` (default ${tinker.DEFAULT_TINKER_KEEP_DAYS}, ${tinker.TINKER_MIN_KEEP_DAYS} to ${tinker.TINKER_MAX_KEEP_DAYS})`))
  assert.ok(tools.includes(`${names.ADAPTER_NAME_MIN} to ${names.ADAPTER_NAME_MAX} characters`))
  assert.ok(tools.includes(`at most ${keepRequest.KEEP_REASON_MAX} characters`))
  assert.ok(tools.includes(`The request waits ${tinker.TINKER_KEEP_WAIT_MS / 1000} seconds for the runner`))
  assert.ok(tools.includes(`within ${keepLib.KEEP_UNCONFIRMED_AFTER_MS / 60000} minutes, or gives no answer within ${keepLib.KEEP_LOST_AFTER_MS / 60000}`))
  // The sections the code's comments point at exist, and so do the tool names the records are stored under.
  for (const heading of ['## Naming a trained adapter', '## Keeping a trained adapter']) assert.ok(tools.includes(heading), heading)
  assert.ok(ops.includes('## Naming and keeping trained adapters'))
  for (const tool of [keepRequest.KEEP_TOOL, keepRequest.OWNER_KEEP_TOOL, keepRequest.OWNER_UNKEEP_TOOL, keepRequest.OWNER_NAME_TOOL, keepRequest.KEEP_EXPIRED_TOOL, keepRequest.TINKER_NAME_TOOL]) {
    assert.ok(tools.includes(`\`${tool}\``), `${tool} in TOOLS.md`)
  }
  // The owner's steps: the exact deploy command, the smoke test, the Volume, the route, and the number of functions.
  assert.ok(ops.includes('uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/tinker_jobs.py'))
  assert.ok(ops.includes('uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py keep'))
  for (const text of [tools, ops, env]) assert.ok(text.includes(keepLib.KEPT_VOLUME))
  assert.ok(ops.includes('/api/experiment/trained-adapters?confirm=true'))
  const routes = []
  const walk = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== '_lib') walk(join(directory, entry.name)) } else if (entry.name.endsWith('.ts')) routes.push(entry.name)
    }
  }
  walk('api')
  assert.ok(ops.includes(`the project now has ${routes.length};`), `OPERATIONS.md should say the project has ${routes.length} functions`)
  // The smoke test prints as many checks as the document says to expect.
  const smoke = readFileSync(join(root, 'modal', 'tinker_smoke.py'), 'utf8')
  const keepCheck = smoke.slice(smoke.indexOf('def keep() -> int:'), smoke.indexOf('if __name__ == "__main__":'))
  assert.equal((keepCheck.match(/^    expect\(/gm) || []).length, 7)
  assert.ok(ops.includes('seven lines that start with `ok`'))
})
