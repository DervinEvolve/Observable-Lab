// The lab model endpoint (LAB_ENABLE_LIVE_MODEL): the request allowlist, the
// model allowlist, scoped keys (issue, verify, expiry, revoke, limits), the
// spend it records, how a Sprite session is given a key, and that none of
// this exists while the switch is off.
//
// No network, no database, no secrets: fetch answers like OpenRouter and
// Sprites, and `@vercel/postgres` is an in-memory fake that understands the
// queries these paths make, including the one conditional UPDATE that lets a
// call through.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-live-model-test-'))
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
  if (/^(OPENROUTER|POSTGRES|LAB_|AI_AGENT|RESEARCH_|SPRITES|MODAL|EPOCH_|NORTH_|GPU_JOBS|VERCEL)/.test(name)) delete process.env[name]
}
const OPENROUTER_KEY = 'test-only-openrouter-placeholder-0000'
const SPRITES_TOKEN = 'test-org/test-id/test-only-sprites-secret'
const OTHER_SECRET = 'test-only-server-credential-value'
process.env.OPENROUTER_API_KEY = OPENROUTER_KEY
const BASE_ENV = { ...process.env }

let logs = []
const capture = (...args) => logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = capture
console.log = capture
console.error = capture

const load = path => import(pathToFileURL(join(build, path)).href)
const { db } = await import(fakePgUrl)
const live = await load('api/_lib/live-model.js')
const keys = await load('api/_lib/live-model-keys.js')
const sprites = await load('api/_lib/sprites.js')
const session = await load('api/_lib/sprite-session.js')
const toolsConfig = await load('api/_lib/tools-config.js')
const prompts = await load('api/_lib/prompts.js')
const openrouter = await load('api/_lib/openrouter.js')
const { default: route } = await load('api/live-model/v1/chat/completions.js')

// ---------------------------------------------------------------------------
// In-memory database: the key and call tables and the spend ledger.
// ---------------------------------------------------------------------------
let nextId = 1
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
const at = v => new Date(v).getTime()

class FakeDb {
  constructor() {
    this.keys = []
    this.calls = []
    this.modelCalls = []
    this.statements = []
    this.failLedger = false
    this.usageReads = 0
  }

  handle(text, v) {
    this.statements.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }

    if (text.startsWith('UPDATE live_model_keys SET revoked = TRUE, revoked_at = ?, revoke_reason = ? WHERE sprite = ?')) {
      const [revokedAt, reason, sprite] = v
      for (const k of this.keys) if (k.sprite === sprite && !k.revoked) Object.assign(k, { revoked: true, revoked_at: revokedAt, revoke_reason: reason })
      return { rows: [] }
    }
    if (text.startsWith('INSERT INTO live_model_keys')) {
      const [token_hash, experiment_id, epoch, model, sprite, issued_at, expires_at, max_calls, max_usd] = v
      const row = { id: uuid(), token_hash, experiment_id, epoch, model, sprite, issued_at, expires_at, max_calls, max_usd: String(max_usd), calls_used: 0, usd_used: '0', busy_until: null, revoked: false, revoked_at: null, revoke_reason: null }
      this.keys.push(row)
      return { rows: [{ id: row.id }] }
    }
    if (text.startsWith('SELECT id, experiment_id, epoch, model, sprite, expires_at') && text.includes('FROM live_model_keys WHERE token_hash = ?')) {
      const row = this.keys.find(k => k.token_hash === v[0])
      return { rows: row ? [{ ...row }] : [] }
    }
    // The gate. Every condition of the real statement, checked and applied in one step.
    if (text.startsWith('UPDATE live_model_keys SET calls_used = calls_used + 1, busy_until = ?')) {
      for (const clause of ['revoked = FALSE', 'expires_at > ?', 'calls_used < max_calls', 'usd_used < max_usd', '(busy_until IS NULL OR busy_until <= ?)']) {
        assert.ok(text.includes(clause), `the reserve statement lost its "${clause}" condition`)
      }
      const [lease, hash, now, nowAgain] = v
      assert.equal(now, nowAgain)
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
    if (text.startsWith('UPDATE live_model_keys SET revoked = TRUE, revoked_at = COALESCE(revoked_at, ?)')) {
      const [revokedAt, reason, id] = v
      const k = this.keys.find(row => row.id === id)
      if (!k) return { rows: [] }
      Object.assign(k, { revoked: true, revoked_at: k.revoked_at ?? revokedAt, revoke_reason: k.revoke_reason ?? reason })
      return { rows: [{ calls_used: k.calls_used, usd_used: k.usd_used, busy_until: k.busy_until }] }
    }
    if (text.startsWith('SELECT calls_used, usd_used, busy_until FROM live_model_keys WHERE id = ?')) {
      this.usageReads += 1
      const k = this.keys.find(row => row.id === v[0])
      return { rows: k ? [{ calls_used: k.calls_used, usd_used: k.usd_used, busy_until: k.busy_until }] : [] }
    }
    if (text.startsWith('INSERT INTO live_model_calls')) {
      const [key_id, experiment_id, epoch, issued_to, sprite, model_asked, model_served, status, http_status, finish_reason, prompt_tokens, completion_tokens, cost_usd, cost_source, duration_ms, detail] = v
      this.calls.push({ key_id, experiment_id, epoch, issued_to, sprite, model_asked, model_served, status, http_status, finish_reason, prompt_tokens, completion_tokens, cost_usd, cost_source, duration_ms, detail: JSON.parse(detail) })
      return { rows: [] }
    }
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, created_at: new Date() })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE purpose = ? AND created_at >= ?')) {
      if (this.failLedger) throw new Error('ledger down')
      const total = this.modelCalls.filter(c => c.purpose === v[0] && c.created_at >= new Date(v[1])).reduce((s, c) => s + Number(c.cost_usd), 0)
      return { rows: [{ total }] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) {
      if (this.failLedger) throw new Error('ledger down')
      const total = this.modelCalls.filter(c => c.created_at >= new Date(v[0])).reduce((s, c) => s + Number(c.cost_usd), 0)
      return { rows: [{ total }] }
    }
    throw new Error(`unexpected query: ${text.slice(0, 120)}`)
  }
}

let lab
beforeEach(() => {
  process.env = { ...BASE_ENV }
  logs = []
  lab = new FakeDb()
  db.handler = (text, values) => lab.handle(text, values)
  globalThis.fetch = async url => { throw new Error(`Unexpected outbound request to ${url}`) }
})

const MODEL = 'google/gemini-3.8-flash'
const ORIGIN = 'https://lab.example'
const BASE_URL = `${ORIGIN}/api/live-model/v1`
function enable(extra = {}) {
  Object.assign(process.env, {
    LAB_ENABLE_LIVE_MODEL: 'true', LAB_PUBLIC_ORIGIN: ORIGIN, LAB_ENABLE_SPRITE_SESSIONS: 'true', SPRITES_TOKEN, ...extra,
  })
}

function response() {
  return {
    code: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}
async function call(token, body, method = 'POST', contentType = 'application/json') {
  const res = response()
  const headers = { authorization: token === undefined ? undefined : `Bearer ${token}`, ...(contentType ? { 'content-type': contentType } : {}) }
  await route({ method, headers, query: {}, body }, res)
  return res
}
const ask = (extra = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'What is 2 + 2?' }], ...extra })
const mint = (extra = {}) => keys.mintLiveModelKey({ experimentId: 'exp-1', epoch: 22, model: 'openai/gpt-6-astra', sprite: 'observable-gpt', ttlMs: 300_000, ...extra })

const CATALOG = { data: [{ id: MODEL, supported_parameters: ['max_tokens', 'temperature', 'response_format', 'tools', 'tool_choice'], top_provider: { max_completion_tokens: 65536 }, pricing: { prompt: '0.000000825', completion: '0.000004125' } }] }
/** fetch that answers like OpenRouter: the public catalog, and chat completions through `answer`. */
function fakeOpenRouter(sent, answer = () => completion()) {
  openrouter.resetModelCatalog()
  return async (url, options = {}) => {
    const u = new URL(String(url))
    if (u.host !== 'openrouter.ai') throw new Error(`Unexpected outbound request to ${u.host}`)
    if (u.pathname === '/api/v1/models') return new Response(JSON.stringify(CATALOG))
    assert.equal(u.pathname, '/api/v1/chat/completions')
    const request = { headers: options.headers, body: JSON.parse(options.body) }
    sent.push(request)
    const out = await answer(request)
    return out instanceof Response ? out : new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } })
  }
}
function completion({ cost = 0.0004, content = 'It is 4.', tool_calls, finish_reason = 'stop', usage } = {}) {
  return {
    id: 'gen-test-1', model: `${MODEL}-20261101`, provider: 'Google',
    choices: [{ index: 0, finish_reason, native_finish_reason: 'STOP', message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}), reasoning: 'kept out of the answer' } }],
    usage: usage ?? { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost },
  }
}

// ===========================================================================
// Off by default
// ===========================================================================
test('with the switch off there is no endpoint, no key, no variable in a Sprite and no word in the prompts', async () => {
  Object.assign(process.env, { LAB_PUBLIC_ORIGIN: ORIGIN, LAB_ENABLE_SPRITE_SESSIONS: 'true', SPRITES_TOKEN })
  assert.deepEqual(live.liveModelStatus(), { enabled: false, off_reason: 'LAB_ENABLE_LIVE_MODEL is not true' })
  assert.equal(toolsConfig.liveModelToolStatus().enabled, false)
  assert.deepEqual(toolsConfig.enabledTools(), ['sprite_session'])
  for (const value of ['1', 'yes', 'on', 'truthy']) {
    process.env.LAB_ENABLE_LIVE_MODEL = value
    assert.equal(live.liveModelFlag(), false, `"${value}" must not switch it on`)
  }
  // Any capitalisation of true, with spaces around it, is on (the owner typed TRUE once).
  for (const value of ['TRUE', 'True', ' true ']) {
    process.env.LAB_ENABLE_LIVE_MODEL = value
    assert.equal(live.liveModelFlag(), true, `"${value}" should switch it on`)
  }
  delete process.env.LAB_ENABLE_LIVE_MODEL

  // The route says it is off, to anyone, and touches nothing.
  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const token of [undefined, `labk_${'a'.repeat(64)}`]) {
      const res = await call(token, ask(), method)
      assert.equal(res.code, 503)
      assert.match(res.body.error.message, /switched off/)
      assert.equal(res.headers['Cache-Control'], 'no-store')
    }
  }
  assert.equal(lab.statements.length, 0)

  // The prompts say nothing about it.
  const text = prompts.toolLines() + prompts.executorToolsSection()
  assert.match(text, /Your own Sprite/)
  for (const words of [/LAB_MODEL/, /OPENAI_/, /model endpoint/i, /localhost fixture/]) assert.doesNotMatch(text, words)
  assert.match(text, /and nothing else, it holds no credentials, and its output/)

  // A Sprite session is exactly what it was: the defaults policy, no key, no extra variables.
  const calls = []
  globalThis.fetch = fakeSprites(calls)
  const result = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'env', timeout_s: 10 }], { liveModel: { experimentId: 'exp-1', epoch: 3 } })
  assert.equal(result.status, 'ok')
  assert.equal('live_model' in result, false)
  const policies = calls.filter(c => c.path.endsWith('/policy/network') && c.method === 'POST')
  assert.deepEqual(policies.map(c => c.body), [{ rules: [{ include: 'defaults' }] }])
  for (const c of calls.filter(c => c.path.endsWith('/exec'))) {
    assert.deepEqual(c.query.getAll('env').map(p => p.split('=')[0]).sort(), ['CI', 'FORCE_COLOR', 'NO_COLOR', 'npm_config_fund', 'npm_config_update_notifier'])
  }
  assert.equal(lab.keys.length, 0)
  assert.equal(lab.statements.length, 0)
})

test('the switch alone is not enough: it needs the model key, an https origin and Sprite sessions', async () => {
  process.env.LAB_ENABLE_LIVE_MODEL = 'true'
  assert.match(live.liveModelStatus().off_reason, /LAB_PUBLIC_ORIGIN/)
  assert.equal((await call(`labk_${'a'.repeat(64)}`, ask())).code, 503)
  assert.equal(lab.statements.length, 0)

  for (const bad of ['http://lab.example', 'https://user:pass@lab.example', 'https://lab.example/path', 'https://lab.example?x=1', 'https://lab.example:8443', 'https://10.0.0.1', 'https://localhost', 'lab.example', 'ftp://lab.example']) {
    process.env.LAB_PUBLIC_ORIGIN = bad
    assert.equal(live.liveModelOrigin(), null, `${bad} must not be accepted`)
  }
  process.env.LAB_PUBLIC_ORIGIN = 'https://Lab.Example/'
  assert.equal(live.liveModelOrigin(), 'https://lab.example')
  assert.equal(live.liveModelBaseUrl(), BASE_URL)
  assert.equal(live.liveModelHost(), 'lab.example')
  // Vercel's own production domain is the fallback when the origin is not set.
  delete process.env.LAB_PUBLIC_ORIGIN
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'observable-lab.example.app'
  assert.equal(live.liveModelOrigin(), 'https://observable-lab.example.app')

  assert.equal(live.liveModelStatus().enabled, true)
  assert.match(toolsConfig.liveModelToolStatus().off_reason, /Sprite sessions are off/)
  delete process.env.OPENROUTER_API_KEY
  assert.match(live.liveModelStatus().off_reason, /OPENROUTER_API_KEY/)
  process.env.OPENROUTER_API_KEY = OPENROUTER_KEY
  Object.assign(process.env, { LAB_ENABLE_SPRITE_SESSIONS: 'true', SPRITES_TOKEN })
  assert.equal(toolsConfig.liveModelToolStatus().enabled, true)
  assert.deepEqual(toolsConfig.enabledTools(), ['sprite_session', 'live_model'])
})

// ===========================================================================
// The request allowlist and the model allowlist
// ===========================================================================
const CAPS = { supported_parameters: ['max_tokens', 'temperature', 'response_format'], max_completion_tokens: 65536 }

test('only allowlisted fields are forwarded; routing, plugins, transforms and user keys are dropped', () => {
  const built = live.buildLiveRequest({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Be brief.', cache_control: { type: 'ephemeral' } },
      { role: 'user', content: [{ type: 'text', text: 'weather?', extra: 1 }], name: 'visitor' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: { city: 'Oslo' } }, index: 0 }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"c": 3}' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } }, strict: true, secret: 'x' }, cache_control: {} }],
    tool_choice: { type: 'function', function: { name: 'get_weather' }, extra: true },
    max_tokens: 100000,
    temperature: 0.2,
    response_format: { type: 'json_object', junk: 1 },
    stream: false,
    // everything below must never leave the server
    provider: { order: ['Expensive'], allow_fallbacks: true, data_collection: 'allow' },
    plugins: [{ id: 'web', max_results: 50 }],
    transforms: ['middle-out'],
    models: ['openai/gpt-6-astra', 'anthropic/claude-fable-5.2'],
    route: 'fallback',
    user: 'someone',
    usage: { include: true },
    reasoning: { effort: 'max' },
    stream_options: { include_usage: true },
    api_key: 'sk-or-v1-somebody-elses-key-0000000000',
    Authorization: 'Bearer sk-or-v1-somebody-elses-key-0000000000',
    web_search_options: {},
    n: 8,
    logit_bias: {},
    __proto__: { provider: 'x' },
  }, CAPS)
  assert.equal(built.ok, true)
  assert.deepEqual(Object.keys(built.body).sort(), ['max_tokens', 'messages', 'model', 'response_format', 'temperature', 'tool_choice', 'tools'])
  assert.deepEqual(built.body, {
    model: MODEL,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'weather?' }], name: 'visitor' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] },
      { role: 'tool', content: '{"c": 3}', tool_call_id: 'call_1' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } }, strict: true } }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    max_tokens: live.LIVE_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  })
  for (const gone of ['provider', 'plugins', 'transforms', 'models', 'route', 'user', 'usage', 'reasoning', 'stream_options', 'api_key', 'Authorization', 'web_search_options', 'n', 'logit_bias']) {
    assert.ok(built.dropped.includes(gone), `${gone} should be reported as dropped`)
  }
  assert.doesNotMatch(JSON.stringify(built.body), /somebody-elses-key|middle-out|Expensive|"web"/)
})

test('the output limit is always sent and capped; temperature and response_format go only to a model that takes them', () => {
  const body = extra => live.buildLiveRequest(ask(extra), CAPS).body
  assert.equal(body({}).max_tokens, live.LIVE_MAX_OUTPUT_TOKENS)
  assert.equal(body({ max_tokens: 64 }).max_tokens, 64)
  assert.equal(body({ max_completion_tokens: 32, max_tokens: 64 }).max_tokens, 32)
  assert.equal(body({ max_tokens: 1e9 }).max_tokens, live.LIVE_MAX_OUTPUT_TOKENS)
  for (const junk of [-5, 0, 'lots', null, Infinity, NaN]) assert.equal(body({ max_tokens: junk }).max_tokens, live.LIVE_MAX_OUTPUT_TOKENS)
  assert.equal(live.buildLiveRequest(ask({ max_tokens: 9000 }), { supported_parameters: ['max_tokens'], max_completion_tokens: 512 }).body.max_tokens, 512)

  // A model that takes max_completion_tokens and no temperature (Anthropic, OpenAI reasoning models).
  const strict = live.buildLiveRequest(ask({ temperature: 0.9, response_format: { type: 'json_object' }, max_tokens: 50 }), { supported_parameters: ['max_completion_tokens'] })
  assert.deepEqual(Object.keys(strict.body).sort(), ['max_completion_tokens', 'messages', 'model'])
  assert.equal(strict.body.max_completion_tokens, 50)
  assert.deepEqual(strict.dropped.sort(), ['response_format', 'temperature'])

  // A model the catalog does not know gets the plain minimum.
  const unknown = live.buildLiveRequest(ask({ temperature: 0.9, response_format: { type: 'json_object' } }), null)
  assert.deepEqual(Object.keys(unknown.body).sort(), ['max_tokens', 'messages', 'model'])

  for (const t of [-1, 2.5, '0.5', NaN]) assert.equal('temperature' in body({ temperature: t }), false)
  assert.equal('response_format' in body({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } } }), false) // needs structured_outputs
  const schema = live.buildLiveRequest(ask({ response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true, extra: 1 } } }), { supported_parameters: ['max_tokens', 'response_format', 'structured_outputs'] })
  assert.deepEqual(schema.body.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } })
  // tool_choice without tools is dropped, and junk tool_choice is dropped.
  assert.equal('tool_choice' in body({ tool_choice: 'required' }), false)
  assert.equal('tool_choice' in body({ tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: { type: 'web_search' } }), false)
  assert.equal(body({ tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'required' }).tool_choice, 'required')
})

test('malformed requests are refused with a clear 400', () => {
  const refused = (req, pattern) => {
    const r = live.buildLiveRequest(req, CAPS)
    assert.equal(r.ok, false, String(JSON.stringify(req)).slice(0, 80))
    assert.equal(r.status, 400)
    assert.match(r.message, pattern)
  }
  for (const junk of [null, undefined, 'hi', 42, [], [ask()]]) refused(junk, /JSON object/)
  refused({ model: MODEL }, /messages/)
  refused(ask({ messages: [] }), /non-empty/)
  refused(ask({ messages: Array.from({ length: live.LIVE_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' })) }), /at most/)
  refused(ask({ messages: [{ role: 'developer', content: 'x' }] }), /role/)
  refused(ask({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.example/a.png' } }] }] }), /only text content/)
  refused(ask({ messages: [{ role: 'user', content: 7 }] }), /content/)
  refused(ask({ messages: [{ role: 'tool', content: 'x' }] }), /tool_call_id/)
  refused(ask({ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'bad name!' } }] }] }), /tool call/)
  refused(ask({ tools: [{ type: 'web_search' }] }), /tools\[0\]/)
  refused(ask({ tools: Array.from({ length: live.LIVE_MAX_TOOLS + 1 }, (_, i) => ({ type: 'function', function: { name: `f${i}` } })) }), /at most/)
})

test('only allowlisted models are answered for, and an unknown one is told which are', () => {
  assert.deepEqual(live.liveModelIds(), ['google/gemini-3.8-flash'])
  for (const model of ['openai/gpt-6-astra', 'google/gemini-3.8-flash:online', 'google/gemini-3.8-flash:nitro', ' google/gemini-3.8-flash', 'GOOGLE/GEMINI-3.8-FLASH', '', undefined, 7, ['google/gemini-3.8-flash'], { id: MODEL }]) {
    const r = live.checkLiveRequest(ask({ model }))
    assert.equal(r.ok, false, `${JSON.stringify(model)} must be refused`)
    assert.equal(r.status, 400)
    assert.equal(r.type, 'model_not_allowed')
    assert.match(r.message, /must be one of: google\/gemini-3\.8-flash\./)
  }
  assert.deepEqual(live.checkLiveRequest(ask()), { ok: true, model: MODEL })

  // The owner's list: plain ids only. A routing suffix or junk in the list is left out.
  process.env.LAB_LIVE_MODEL_IDS = ' google/gemini-3.8-flash , thinkingmachines/inkling-2-small, openai/gpt-6-astra:online, not a model, ../x, google/gemini-3.8-flash '
  assert.deepEqual(live.liveModelIds(), ['google/gemini-3.8-flash', 'thinkingmachines/inkling-2-small'])
  assert.equal(live.checkLiveRequest(ask({ model: 'thinkingmachines/inkling-2-small' })).ok, true)
  assert.match(live.checkLiveRequest(ask({ model: 'x/y' })).message, /google\/gemini-3\.8-flash, thinkingmachines\/inkling-2-small/)
  assert.deepEqual(live.liveModelList().data.map(m => m.id), ['google/gemini-3.8-flash', 'thinkingmachines/inkling-2-small'])

  // OpenRouter's own router ids pick the model themselves, at a price nobody chose: never allowed, alone or in a list.
  for (const router of ['openrouter/auto', 'openrouter/free', 'openrouter/anything-new']) {
    process.env.LAB_LIVE_MODEL_IDS = router
    assert.deepEqual(live.liveModelIds(), ['google/gemini-3.8-flash'], `${router} alone falls back to the default`)
    assert.equal(live.checkLiveRequest(ask({ model: router })).ok, false)
    process.env.LAB_LIVE_MODEL_IDS = `thinkingmachines/inkling-2-small,${router}`
    assert.deepEqual(live.liveModelIds(), ['thinkingmachines/inkling-2-small'])
    assert.equal(live.checkLiveRequest(ask({ model: router })).type, 'model_not_allowed')
  }
  // A list with nothing usable in it falls back to the default instead of allowing nothing or everything.
  process.env.LAB_LIVE_MODEL_IDS = '*, , :free'
  assert.deepEqual(live.liveModelIds(), ['google/gemini-3.8-flash'])
})

test('a streaming request is refused before a call is counted or anything is sent', async () => {
  for (const stream of [true, 1, 'true', {}]) {
    const r = live.checkLiveRequest(ask({ stream }))
    assert.equal(r.status, 400)
    assert.equal(r.type, 'stream_not_supported')
  }
  for (const stream of [false, null, undefined]) assert.equal(live.checkLiveRequest(ask({ stream })).ok, true)

  enable()
  const key = await mint()
  const res = await call(key.token, ask({ stream: true }))
  assert.equal(res.code, 400)
  assert.match(res.body.error.message, /non-streaming only/)
  assert.equal(lab.keys[0].calls_used, 0)
  assert.equal(lab.modelCalls.length, 0)
})

test('the answer is rebuilt in the OpenAI shape, with tool call arguments as a string', () => {
  const shaped = live.shapeLiveCompletion(completion({
    content: null, finish_reason: 'tool_calls',
    tool_calls: [{ id: 'call_a', type: 'function', index: 0, function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }, { type: 'function', function: { name: 'add', arguments: { a: 1, b: 2 } } }, { function: {} }],
  }), MODEL, new Date('2026-11-18T10:00:00Z'))
  assert.deepEqual(Object.keys(shaped).sort(), ['choices', 'created', 'id', 'model', 'object', 'usage'])
  assert.equal(shaped.object, 'chat.completion')
  assert.equal(shaped.model, MODEL)
  assert.equal(shaped.created, 1794996000)
  const { message, finish_reason, index } = shaped.choices[0]
  assert.equal(index, 0)
  assert.equal(finish_reason, 'tool_calls')
  assert.deepEqual(Object.keys(message).sort(), ['content', 'role', 'tool_calls']) // no reasoning, no provider fields
  assert.equal(message.content, null)
  assert.deepEqual(message.tool_calls[0], { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } })
  assert.match(message.tool_calls[1].id, /^call_[0-9a-f]{24}$/)
  assert.equal(message.tool_calls[1].function.arguments, '{"a":1,"b":2}')
  assert.equal(message.tool_calls.length, 2)
  assert.deepEqual(shaped.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }) // no cost field

  const plain = live.shapeLiveCompletion(completion({ finish_reason: 'STOP' }), MODEL)
  assert.equal(plain.choices[0].finish_reason, 'stop')
  assert.equal(plain.choices[0].message.content, 'It is 4.')
  assert.equal('tool_calls' in plain.choices[0].message, false)
  assert.equal(live.shapeLiveCompletion({ error: { message: 'no' } }, MODEL), null)
  assert.equal(live.shapeLiveCompletion(null, MODEL), null)
})

// ===========================================================================
// Scoped keys
// ===========================================================================
test('a key is 256 random bits, and only its hash is stored', async () => {
  enable()
  const a = await mint()
  const b = await mint({ sprite: 'observable-claude', model: 'anthropic/claude-fable-5.2' })
  assert.match(a.token, /^labk_[0-9a-f]{64}$/)
  assert.notEqual(a.token, b.token)
  assert.ok(sprites.SCOPED_MODEL_KEY.test(a.token))
  assert.equal(a.max_calls, 20)
  assert.equal(a.max_usd, 0.25)
  const row = lab.keys.find(k => k.id === a.id)
  assert.equal(row.token_hash, keys.hashLiveKey(a.token))
  assert.match(row.token_hash, /^[0-9a-f]{64}$/)
  assert.deepEqual([row.experiment_id, row.epoch, row.model, row.sprite], ['exp-1', 22, 'openai/gpt-6-astra', 'observable-gpt'])
  assert.equal(at(row.expires_at) - at(row.issued_at), 300_000)
  // Nothing the database was given holds the key itself.
  assert.doesNotMatch(JSON.stringify(lab.statements) + JSON.stringify(lab.keys), new RegExp(a.token.slice(5)))

  // A Sprite has one live key: making a new one for it revokes the old one.
  const again = await mint()
  assert.equal(lab.keys.find(k => k.id === a.id).revoked, true)
  assert.equal(lab.keys.find(k => k.id === a.id).revoke_reason, 'replaced by a newer session')
  assert.equal(lab.keys.find(k => k.id === b.id).revoked, false)
  assert.equal((await keys.checkLiveKey(again.token)).ok, true)
  assert.deepEqual(await keys.checkLiveKey(a.token), { ok: false, status: 401, reason: 'this key was revoked: its Sprite session has ended' })

  // The header must be exactly one well-formed key.
  assert.equal(keys.bearerLiveKey(`Bearer ${a.token}`), a.token)
  for (const header of [undefined, null, '', a.token, `bearer ${a.token}`, `Bearer ${a.token} x`, `Bearer ${a.token.toUpperCase()}`, `Bearer labk_${'g'.repeat(64)}`, `Bearer ${OPENROUTER_KEY}`, [`Bearer ${a.token}`]]) {
    assert.equal(keys.bearerLiveKey(header), null, `${JSON.stringify(header)} must not be read as a key`)
  }
})

test('a live key makes a real call: the lab key goes upstream, the real cost is recorded, the caller sees neither', async () => {
  enable()
  const key = await mint()
  const sent = []
  globalThis.fetch = fakeOpenRouter(sent, () => completion({
    cost: 0.0123, content: null, finish_reason: 'tool_calls',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":2}' } }],
  }))

  const models = await call(key.token, undefined, 'GET')
  assert.equal(models.code, 200)
  assert.deepEqual(models.body, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'google' }] })
  assert.equal(lab.keys[0].calls_used, 0) // listing models is not a call

  const res = await call(key.token, ask({
    tools: [{ type: 'function', function: { name: 'add', parameters: { type: 'object' } } }],
    temperature: 0.1, provider: { order: ['X'] }, plugins: [{ id: 'web' }], user: 'u',
  }))
  assert.equal(res.code, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers['X-Lab-Calls-Left'], '19')
  assert.equal(res.headers['X-Lab-Usd-Left'], '0.2377')
  assert.equal(res.headers['X-Lab-Dropped-Fields'], 'provider,plugins,user')
  assert.equal(res.body.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(res.body.choices[0].message, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":2}' } }] })
  assert.equal(res.body.model, MODEL)
  assert.deepEqual(res.body.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })

  // Upstream: the lab's own key in the header, and only allowlisted fields in the body.
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers.Authorization, `Bearer ${OPENROUTER_KEY}`)
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['max_tokens', 'messages', 'model', 'temperature', 'tools'])
  assert.equal(sent[0].body.max_tokens, live.LIVE_MAX_OUTPUT_TOKENS)
  assert.doesNotMatch(JSON.stringify(sent[0]), new RegExp(key.token))
  // The caller: no lab key anywhere in what came back.
  assert.doesNotMatch(JSON.stringify(res), new RegExp(OPENROUTER_KEY))

  // Spend: OpenRouter's usage.cost, tagged live_model, under the key's experiment and epoch.
  assert.deepEqual(lab.modelCalls.map(c => [c.experiment_id, c.epoch_number, c.purpose, c.model_id, c.assigned_model_id, c.cost_usd, c.cost_source, c.prompt_tokens, c.completion_tokens]),
    [['exp-1', 22, 'live_model', MODEL, 'openai/gpt-6-astra', 0.0123, 'usage', 12, 5]])
  assert.equal(lab.keys[0].calls_used, 1)
  assert.equal(Number(lab.keys[0].usd_used), 0.0123)
  assert.equal(lab.keys[0].busy_until, null)

  // Evidence: one row for the call, with short excerpts only.
  assert.equal(lab.calls.length, 1)
  const row = lab.calls[0]
  assert.deepEqual([row.key_id, row.experiment_id, row.epoch, row.issued_to, row.sprite, row.model_asked, row.model_served, row.status, row.http_status, row.finish_reason, row.prompt_tokens, row.completion_tokens, row.cost_usd, row.cost_source],
    [key.id, 'exp-1', 22, 'openai/gpt-6-astra', 'observable-gpt', MODEL, `${MODEL}-20261101`, 'ok', 200, 'tool_calls', 12, 5, 0.0123, 'usage'])
  assert.deepEqual(row.detail, { messages: 1, tools: 1, dropped: ['provider', 'plugins', 'user'], request_excerpt: 'What is 2 + 2?', response_excerpt: '', tool_calls: ['add'] })
  assert.doesNotMatch(JSON.stringify(lab.calls), new RegExp(`${key.token}|${OPENROUTER_KEY}`))
})

test('call records keep short, cleaned excerpts and never the whole conversation', async () => {
  enable()
  const key = await mint()
  globalThis.fetch = fakeOpenRouter([], () => completion({ content: `answer ${'z'.repeat(5000)} ghp_abcdefghijklmnopqrstuvwxyz0123456789` }))
  const res = await call(key.token, ask({ messages: [{ role: 'user', content: `secret ${OTHER_SECRET} then ${'q'.repeat(5000)}` }] }))
  assert.equal(res.code, 200)
  const detail = lab.calls[0].detail
  assert.ok(detail.request_excerpt.length <= 200)
  assert.ok(detail.response_excerpt.length <= 200)
  assert.equal(JSON.stringify(lab.calls).length < 1500, true)
})

test('an expired or revoked key is refused with 401 and a short reason', async () => {
  enable()
  const sent = []
  globalThis.fetch = fakeOpenRouter(sent)
  const reason = res => res.body.error.message

  const unknown = await call(`labk_${'0'.repeat(64)}`, ask())
  assert.equal(unknown.code, 401)
  assert.equal(reason(unknown), 'unknown key')
  assert.equal(unknown.headers['WWW-Authenticate'], 'Bearer')
  for (const token of [undefined, 'wrong', OPENROUTER_KEY, `labk_${'0'.repeat(63)}`]) assert.equal((await call(token, ask())).code, 401)

  // Issued 20 minutes ago with a 5 minute life.
  const old = await mint({ now: new Date(Date.now() - 20 * 60_000) })
  for (const method of ['GET', 'POST']) {
    const res = await call(old.token, ask(), method)
    assert.equal(res.code, 401)
    assert.equal(reason(res), 'this key has expired')
  }
  assert.deepEqual(await keys.reserveLiveCall(old.token), { ok: false, status: 401, reason: 'this key has expired' })
  // The same check at the moment of expiry, to the millisecond.
  const edge = await mint({ sprite: 'observable-grok', now: new Date('2026-11-18T10:00:00Z') })
  assert.equal((await keys.reserveLiveCall(edge.token, new Date('2026-11-18T10:04:59.999Z'))).ok, true)
  await keys.settleLiveCall(edge.id, 0)
  assert.equal((await keys.reserveLiveCall(edge.token, new Date('2026-11-18T10:05:00.000Z'))).ok, false)

  const key = await mint({ sprite: 'observable-claude' })
  assert.equal((await call(key.token, ask())).code, 200)
  assert.deepEqual(await keys.revokeLiveKey(key.id, 'the Sprite session ended'), { calls_used: 1, usd_used: 0.0004, in_flight: false })
  assert.deepEqual(await keys.liveKeyUsage(key.id), { calls_used: 1, usd_used: 0.0004, in_flight: false })
  assert.equal(await keys.liveKeyUsage('no-such-id'), null)
  for (const method of ['GET', 'POST']) {
    const res = await call(key.token, ask(), method)
    assert.equal(res.code, 401)
    assert.match(reason(res), /revoked/)
  }
  assert.equal(sent.length, 1) // only the one call before the key was revoked went upstream
  assert.equal(lab.keys.find(k => k.id === key.id).revoke_reason, 'the Sprite session ended')
  assert.equal(await keys.revokeLiveKey('no-such-id', 'x'), null)
})

test('a key allows 20 calls: the 21st is refused with 429 and nothing is sent', async () => {
  enable()
  const key = await mint()
  const sent = []
  globalThis.fetch = fakeOpenRouter(sent, () => completion({ cost: 0.001 }))
  for (let i = 0; i < 20; i++) assert.equal((await call(key.token, ask())).code, 200, `call ${i + 1}`)
  const res = await call(key.token, ask())
  assert.equal(res.code, 429)
  assert.equal(res.body.error.message, 'this key has used its 20 calls')
  assert.equal(res.body.error.type, 'key_limit_reached')
  assert.equal(sent.length, 20)
  assert.equal(lab.keys[0].calls_used, 20)
  assert.equal(lab.modelCalls.length, 20)
  assert.equal((await call(key.token, undefined, 'GET')).code, 200) // still a live key, it just has no calls left
})

test('a key allows $0.25: the limit can be passed by one call at most, then it is 429', async () => {
  enable()
  const key = await mint()
  const sent = []
  globalThis.fetch = fakeOpenRouter(sent, () => completion({ cost: 0.2 }))
  assert.equal((await call(key.token, ask())).code, 200)   // 0.20 used
  assert.equal((await call(key.token, ask())).code, 200)   // 0.20 < 0.25, so this one runs: 0.40 used
  const res = await call(key.token, ask())
  assert.equal(res.code, 429)
  assert.equal(res.body.error.message, 'this key has used its $0.25')
  assert.equal(sent.length, 2)
  assert.equal(Number(lab.keys[0].usd_used).toFixed(2), '0.40')
})

test('calls arriving together cannot pass a limit: the database lets one through at a time', async () => {
  enable()
  const key = await mint()
  const sent = []
  let release
  const gate = new Promise(r => { release = r })
  globalThis.fetch = fakeOpenRouter(sent, async () => { await gate; return completion({ cost: 0.3 }) })

  // Eight at once, each over the dollar limit on its own. One reaches the model; the rest are told to wait.
  const all = Array.from({ length: 8 }, () => call(key.token, ask()))
  await new Promise(r => setTimeout(r, 30))
  release()
  const results = await Promise.all(all)
  assert.equal(results.filter(r => r.code === 200).length, 1)
  const refused = results.filter(r => r.code !== 200)
  assert.equal(refused.length, 7)
  for (const r of refused) {
    assert.equal(r.code, 429)
    assert.match(r.body.error.message, /one at a time/)
  }
  assert.equal(sent.length, 1)
  assert.equal(lab.keys[0].calls_used, 1)
  assert.equal(Number(lab.keys[0].usd_used), 0.3) // over by one call, never by eight

  // The reserve step itself, with no handler around it: 40 at once on a fresh key give exactly one grant,
  // and taking them in turn gives exactly 20.
  const fresh = await mint({ sprite: 'observable-claude' })
  const grants = await Promise.all(Array.from({ length: 40 }, () => keys.reserveLiveCall(fresh.token)))
  assert.equal(grants.filter(g => g.ok).length, 1)
  await keys.settleLiveCall(fresh.id, 0)
  let granted = 1
  for (let i = 0; i < 40; i++) {
    const g = await keys.reserveLiveCall(fresh.token)
    if (g.ok) { granted++; await keys.settleLiveCall(fresh.id, 0) }
  }
  assert.equal(granted, 20)

  // A call that never came back (a crashed function) gives its slot up when its lease runs out.
  const t0 = new Date('2026-11-18T10:00:00Z')
  const stuck = await mint({ sprite: 'observable-grok', now: t0 })
  assert.equal((await keys.reserveLiveCall(stuck.token, t0)).ok, true)
  assert.equal((await keys.reserveLiveCall(stuck.token, new Date(t0.getTime() + 60_000))).ok, false)
  assert.equal((await keys.reserveLiveCall(stuck.token, new Date(t0.getTime() + keys.LIVE_CALL_LEASE_MS))).ok, true)
})

// ===========================================================================
// Spend
// ===========================================================================
test('the lab daily budget is checked first, then the endpoint\'s own daily cap', async () => {
  enable()
  const key = await mint()
  const sent = []
  globalThis.fetch = fakeOpenRouter(sent, () => completion({ cost: 0.1 }))
  assert.equal(live.liveModelDailyUsd(), 1)

  // The whole lab is over its budget for the day.
  lab.modelCalls.push({ purpose: 'epoch', cost_usd: 15, created_at: new Date() })
  let res = await call(key.token, ask())
  assert.equal(res.code, 429)
  assert.equal(res.body.error.type, 'lab_budget_reached')
  assert.equal(sent.length, 0)
  assert.equal(lab.keys[0].calls_used, 0) // a refused call is not counted against the key

  // The lab has room, the endpoint has used its own dollar.
  lab.modelCalls = [{ purpose: 'epoch', cost_usd: 3, created_at: new Date() }, { purpose: 'live_model', cost_usd: 1, created_at: new Date() }]
  res = await call(key.token, ask())
  assert.equal(res.code, 429)
  assert.equal(res.body.error.type, 'endpoint_budget_reached')
  assert.match(res.body.error.message, /\$1\.00 for today/)
  assert.equal(sent.length, 0)

  // Yesterday's spend does not count, and other spend does not count against the endpoint's cap.
  lab.modelCalls = [{ purpose: 'epoch', cost_usd: 3, created_at: new Date() }, { purpose: 'live_model', cost_usd: 5, created_at: new Date(Date.now() - 26 * 3600_000) }]
  assert.equal((await call(key.token, ask())).code, 200)
  assert.equal(sent.length, 1)

  // The owner's own cap, and zero switches spending off without switching the route off.
  process.env.LAB_LIVE_MODEL_DAILY_USD = '0.05'
  assert.equal((await call(key.token, ask())).body.error.type, 'endpoint_budget_reached')
  process.env.LAB_LIVE_MODEL_DAILY_USD = '0'
  assert.equal((await call(key.token, ask())).code, 429)
  for (const junk of ['-1', 'lots', '']) {
    process.env.LAB_LIVE_MODEL_DAILY_USD = junk
    assert.equal(live.liveModelDailyUsd(), 1)
  }

  // If the ledger cannot be read the cap cannot be checked, so nothing starts.
  lab.failLedger = true
  res = await call(key.token, ask())
  assert.equal(res.code, 503)
  assert.equal(sent.length, 1)
})

test('spend is only ever OpenRouter\'s usage.cost: a response without it is recorded as costing nothing, not priced', async () => {
  enable()
  const key = await mint()
  // The catalog in this test has prices; they must not be used.
  globalThis.fetch = fakeOpenRouter([], () => completion({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }))
  const res = await call(key.token, ask())
  assert.equal(res.code, 200)
  assert.deepEqual(lab.modelCalls.map(c => [c.purpose, c.cost_usd, c.cost_source, c.prompt_tokens]), [['live_model', 0, 'none', 1_000_000]])
  assert.equal(Number(lab.keys[0].usd_used), 0)
  assert.equal(lab.calls[0].cost_source, 'none')
  assert.ok(logs.some(l => /no usage\.cost/.test(l)))
})

test('a failed model call is recorded, counted against the key, costs nothing and frees the key', async () => {
  enable()
  const key = await mint()
  let mode = 'http'
  globalThis.fetch = fakeOpenRouter([], () => {
    if (mode === 'http') return new Response(JSON.stringify({ error: { message: `Invalid schema for tool add. key ${OPENROUTER_KEY}` } }), { status: 400 })
    if (mode === 'rate') return new Response('slow down', { status: 429 })
    if (mode === 'empty') return { error: { message: 'provider returned nothing' }, usage: { cost: 0.002 } }
    if (mode === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    throw new Error('socket hang up')
  })
  let res = await call(key.token, ask())
  assert.equal(res.code, 502)
  assert.match(res.body.error.message, /status 400\): Invalid schema for tool add/)
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(OPENROUTER_KEY)) // the lab key is cleaned out of anything passed on
  mode = 'rate'
  assert.equal((await call(key.token, ask())).code, 429)
  mode = 'empty'
  res = await call(key.token, ask())
  assert.equal(res.code, 502)
  mode = 'timeout'
  assert.equal((await call(key.token, ask())).code, 504)
  mode = 'network'
  assert.equal((await call(key.token, ask())).code, 502)

  assert.deepEqual(lab.calls.map(c => [c.status, c.http_status, c.cost_usd]), [['upstream_error', 400, 0], ['upstream_error', 429, 0], ['no_answer', 200, 0.002], ['timeout', null, 0], ['upstream_error', null, 0]])
  assert.equal(lab.keys[0].calls_used, 5)
  assert.equal(lab.keys[0].busy_until, null)
  // What was billed is on the ledger even though no completion came back.
  assert.deepEqual(lab.modelCalls.map(c => c.cost_usd), [0.002])
  assert.equal(Number(lab.keys[0].usd_used), 0.002)
  assert.doesNotMatch(JSON.stringify(lab.calls), new RegExp(OPENROUTER_KEY))
})

test('other methods and oversized or unreadable bodies are refused', async () => {
  enable()
  const key = await mint()
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await call(key.token, ask(), method)).code, 405)
  assert.equal((await call(key.token, ask({ messages: [{ role: 'user', content: 'x'.repeat(live.LIVE_MAX_BODY_BYTES) }] }))).code, 413)
  assert.equal((await call(key.token, '{not json')).code, 400)
  assert.equal((await call(key.token, JSON.stringify(ask({ model: 'x/y' })))).code, 400)
  assert.equal(lab.keys[0].calls_used, 0)
})

test('a body that was not sent as JSON is refused with the real reason, before a call is counted', async () => {
  enable()
  const key = await mint()
  globalThis.fetch = fakeOpenRouter([])
  // What Vercel hands the route: nothing at all when there is no Content-Type (Node's https.request),
  // and the JSON text as the one key of a form object for a form type (what Python's urllib adds by itself).
  const text = JSON.stringify(ask())
  for (const [contentType, body] of [[null, undefined], ['application/x-www-form-urlencoded', { [text]: '' }], ['multipart/form-data; boundary=x', undefined], ['application/xml', undefined]]) {
    const res = await call(key.token, body, 'POST', contentType)
    assert.equal(res.code, 415, `${contentType}`)
    assert.equal(res.body.error.type, 'unsupported_media_type')
    assert.match(res.body.error.message, /Content-Type: application\/json/)
  }
  assert.equal(lab.keys[0].calls_used, 0)
  // JSON by its header (parameters and case do not matter), and the two types that arrive as text.
  for (const [contentType, body] of [['application/json; charset=utf-8', ask()], ['Application/JSON', ask()], [['application/json'], ask()], ['text/plain', text], ['application/octet-stream', Buffer.from(text)]]) {
    assert.equal((await call(key.token, body, 'POST', contentType)).code, 200, `${contentType}`)
  }
  // The model list has no body, so it needs no header.
  assert.equal((await call(key.token, undefined, 'GET', null)).code, 200)
  // Without a key the answer is still 401: the header is only looked at for a live key.
  assert.equal((await call(undefined, undefined, 'POST', null)).code, 401)
})

// ===========================================================================
// Reasoning details: what a tool loop has to hand back
// ===========================================================================
test('reasoning_details come back with the answer and are forwarded again on the assistant turn', async () => {
  enable()
  const key = await mint()
  const sent = []
  const signature = 'c2lnbmF0dXJl'.repeat(40)
  const details = [
    { type: 'reasoning.text', text: 'I will add them.', signature: 'sig-1', format: 'anthropic-claude-v1', index: 0, id: null },
    { type: 'reasoning.encrypted', id: 'call_1', format: 'google-gemini-v1', index: 1, data: signature, provider: { order: ['X'] }, extra: 'dropped' },
    { type: 'reasoning.summary', summary: 'Adds two numbers.', index: 2 },
    { type: 'not-reasoning', data: 'left out' },
    'left out too',
  ]
  const kept = [
    { type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'I will add them.', signature: 'sig-1', index: 0 },
    { type: 'reasoning.encrypted', id: 'call_1', format: 'google-gemini-v1', data: signature, index: 1 },
    { type: 'reasoning.summary', summary: 'Adds two numbers.', index: 2 },
  ]
  const toolCall = { id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":2}' } }
  globalThis.fetch = fakeOpenRouter(sent, () => {
    const out = completion({ content: null, finish_reason: 'tool_calls', tool_calls: [toolCall] })
    out.choices[0].message.reasoning_details = details
    return out
  })
  const tools = [{ type: 'function', function: { name: 'add', parameters: { type: 'object' } } }]

  // Round one: the answer carries them, rebuilt from known fields only, payloads whole.
  const first = await call(key.token, ask({ tools }))
  assert.equal(first.code, 200)
  assert.deepEqual(first.body.choices[0].message, { role: 'assistant', content: null, tool_calls: [toolCall], reasoning_details: kept })
  assert.equal('reasoning' in first.body.choices[0].message, false)
  assert.equal(lab.calls[0].detail.reasoning_details, 3)
  assert.doesNotMatch(JSON.stringify(lab.calls), /c2lnbmF0dXJl/) // the record keeps a count, not the payload

  // Round two: the client sends the assistant turn back as it got it, with the tool result.
  const second = await call(key.token, ask({
    tools,
    messages: [
      { role: 'user', content: 'What is 2 + 2?', reasoning_details: kept },
      first.body.choices[0].message,
      { role: 'tool', tool_call_id: 'call_1', content: '4' },
    ],
  }))
  assert.equal(second.code, 200)
  assert.deepEqual(sent[1].body.messages, [
    { role: 'user', content: 'What is 2 + 2?' }, // only an assistant message carries them
    { role: 'assistant', content: null, tool_calls: [toolCall], reasoning_details: kept },
    { role: 'tool', content: '4', tool_call_id: 'call_1' },
  ])
  assert.equal(second.headers['X-Lab-Dropped-Fields'], undefined)

  // On the way in they are held to the same shape: unknown fields are dropped, anything else is a 400.
  const turn = extra => ask({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [toolCall], ...extra }, { role: 'tool', tool_call_id: 'call_1', content: '4' }] })
  const caps = { supported_parameters: ['max_tokens'] }
  const built = live.buildLiveRequest(turn({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'abc', cache_control: { type: 'ephemeral' }, provider: 'X' }] }), caps)
  assert.deepEqual(built.body.messages[1].reasoning_details, [{ type: 'reasoning.encrypted', data: 'abc' }])
  for (const empty of [undefined, null, []]) {
    assert.equal('reasoning_details' in live.buildLiveRequest(turn({ reasoning_details: empty }), caps).body.messages[1], false)
  }
  for (const bad of ['text', {}, [7], [{ data: 'no type' }], [{ type: 'reasoning.text', text: 7 }], [{ type: 'image_url' }], [{ type: 'reasoning.text', id: 'x'.repeat(201) }],
    Array.from({ length: live.LIVE_MAX_REASONING_DETAILS + 1 }, () => ({ type: 'reasoning.text', text: 'x' }))]) {
    const r = live.buildLiveRequest(turn({ reasoning_details: bad }), caps)
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60))
    assert.equal(r.status, 400)
    assert.match(r.message, /messages\[1\]: "reasoning_details"/)
  }

  // On the way out the list is bounded: whole entries only, up to the count and size limits.
  const shape = list => live.shapeLiveCompletion({ choices: [{ message: { content: 'ok', reasoning_details: list } }] }, MODEL).choices[0].message.reasoning_details
  assert.equal(shape(Array.from({ length: 200 }, () => ({ type: 'reasoning.text', text: 'x' }))).length, live.LIVE_MAX_REASONING_DETAILS)
  const big = shape(Array.from({ length: 5 }, () => ({ type: 'reasoning.encrypted', data: 'x'.repeat(50_000) })))
  assert.equal(big.length, 2)
  for (const d of big) assert.equal(d.data.length, 50_000)
  assert.equal(shape([]), undefined)
  assert.equal(shape('nope'), undefined)
})

// ===========================================================================
// The Sprite session
// ===========================================================================
function fakeSprites(calls, { answer = () => 'ok', policy = body => new Response(body) } = {}) {
  return async (url, options = {}) => {
    const u = new URL(String(url))
    const method = options.method || 'GET'
    if (u.host !== 'api.sprites.dev') throw new Error(`Unexpected outbound request to ${u.host}`)
    const entry = { url: u.href, path: u.pathname, method, query: u.searchParams, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined }
    calls.push(entry)
    if (u.pathname.endsWith('/policy/network')) return method === 'POST' ? policy(options.body, entry) : new Response(JSON.stringify({ rules: [{ include: 'defaults' }] }))
    if (method === 'GET') return new Response(JSON.stringify({ status: 'warm' }), { headers: { 'content-type': 'application/json' } })
    if (u.pathname.endsWith('/exec')) {
      const cmd = u.searchParams.getAll('cmd')
      const nonce = /__EXIT_([0-9a-f]+):/.exec(cmd[2] || '')?.[1]
      const env = Object.fromEntries(u.searchParams.getAll('env').map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
      return new Response(`${answer(cmd[5], env)}\n__EXIT_${nonce}:0\n`)
    }
    return new Response('unexpected', { status: 500 })
  }
}
const envOf = c => Object.fromEntries(c.query.getAll('env').map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))

test('a Sprite session gets the lab host in its egress policy, then a key, and loses both when it ends', async () => {
  enable({ SOME_SERVICE_API_KEY: OTHER_SECRET, AI_AGENT_GITHUB_TOKEN: 'test-only-ai-agent-token-value-0000', LAB_OPERATOR_SECRET: 'test-only-operator-secret-0000000000000000', POSTGRES_URL: 'postgres://user:test-only-db-password@db.example/lab' })
  const calls = []
  let duringSession
  globalThis.fetch = fakeSprites(calls, {
    answer: (script, env) => {
      duringSession ??= lab.keys.map(k => ({ ...k }))
      return `base=${env.LAB_MODEL_BASE_URL}\nkey is ${env.LAB_MODEL_API_KEY} and OPENAI_API_KEY=${env.OPENAI_API_KEY}`
    },
  })
  const result = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'env | grep MODEL', timeout_s: 30 }, { run: 'node call.js', timeout_s: 60 }],
    { liveModel: { experimentId: 'exp-1', epoch: 22 } })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.live_model, { offered: true, calls: 0, cost_usd: 0 })

  // Order: defaults policy, then the policy with the lab's host, then the commands, then defaults again.
  const steps = calls.filter(c => c.method === 'POST').map(c => c.path.endsWith('/exec') ? 'exec' : JSON.stringify(c.body.rules))
  assert.deepEqual(steps, [
    '[{"include":"defaults"}]',
    '[{"include":"defaults"},{"domain":"lab.example","action":"allow"}]',
    'exec', 'exec',
    '[{"include":"defaults"}]',
  ])

  // Each command got the four variables, the same key, and the lab's https base URL.
  const execs = calls.filter(c => c.path.endsWith('/exec'))
  const token = envOf(execs[0]).LAB_MODEL_API_KEY
  assert.match(token, /^labk_[0-9a-f]{64}$/)
  for (const c of execs) {
    const env = envOf(c)
    assert.deepEqual(Object.keys(env).filter(k => /MODEL|OPENAI/.test(k)).sort(), ['LAB_MODEL_API_KEY', 'LAB_MODEL_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'])
    assert.equal(env.LAB_MODEL_BASE_URL, BASE_URL)
    assert.equal(env.OPENAI_BASE_URL, BASE_URL)
    assert.equal(env.LAB_MODEL_API_KEY, token)
    assert.equal(env.OPENAI_API_KEY, token)
    // The only variables shaped like a credential are those two.
    assert.deepEqual(Object.keys(env).filter(k => /TOKEN|SECRET|KEY|PASSWORD|POSTGRES/.test(k)).sort(), ['LAB_MODEL_API_KEY', 'OPENAI_API_KEY'])
    // A command that holds the key is not told it is CI: the models are told the key is never there in CI.
    assert.deepEqual(Object.keys(env).sort(), ['FORCE_COLOR', 'LAB_MODEL_API_KEY', 'LAB_MODEL_BASE_URL', 'NO_COLOR', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'npm_config_fund', 'npm_config_update_notifier'])
  }
  // Its stored output ends with what the endpoint was used for.
  assert.match(session.sessionTranscript(result), /\nlab model endpoint: 0 calls, \$0\.0000$/)
  // No server secret reached the sprite in any argument, variable or URL.
  const everything = calls.map(c => c.url + JSON.stringify(c.body ?? '')).join('\n')
  for (const secret of [OPENROUTER_KEY, OTHER_SECRET, 'test-only-ai-agent-token-value-0000', 'test-only-operator-secret-0000000000000000', 'test-only-db-password']) {
    assert.equal(everything.includes(secret), false, 'a server secret was sent to Sprites')
    assert.equal(decodeURIComponent(everything).includes(secret), false)
  }
  for (const c of calls) assert.equal(c.headers.Authorization, `Bearer ${SPRITES_TOKEN}`)

  // The key was live while the commands ran, for this experiment, epoch, model and sprite, and short lived.
  assert.equal(duringSession.length, 1)
  assert.equal(duringSession[0].revoked, false)
  assert.equal(duringSession[0].token_hash, keys.hashLiveKey(token))
  assert.deepEqual([duringSession[0].experiment_id, duringSession[0].epoch, duringSession[0].model, duringSession[0].sprite], ['exp-1', 22, 'openai/gpt-6-astra', 'observable-gpt'])
  const life = at(duringSession[0].expires_at) - at(duringSession[0].issued_at)
  assert.equal(life, session.sessionKeyTtlMs([{ timeout_s: 30 }, { timeout_s: 60 }]))
  assert.equal(life, 150_000)
  assert.ok(life <= live.LIVE_KEY_TTL_MS)
  // ... and it is revoked now that the session is over.
  assert.equal(lab.keys[0].revoked, true)
  assert.equal(lab.keys[0].revoke_reason, 'the Sprite session ended')
  enable()
  assert.equal((await call(token, ask())).code, 401)

  // The key never reaches stored output, even when a command prints it.
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token))
  assert.doesNotMatch(JSON.stringify(result), /labk_[0-9a-f]{16}/)
  assert.match(result.commands[0].output_tail, /base=https:\/\/lab\.example\/api\/live-model\/v1/)
  assert.match(session.sessionTranscript(result), /\[redacted\]/)
  assert.equal(sprites.sanitizeOutput(`x ${token} y`), 'x [redacted] y')

  // A long session's key still ends at 15 minutes.
  assert.equal(session.sessionKeyTtlMs(Array.from({ length: 40 }, () => ({ timeout_s: 120 }))), live.LIVE_KEY_TTL_MS)
})

test('a key cut in two by the output tail does not leave its end in stored output', async () => {
  enable()
  const calls = []
  // The command prints its key; the sprite's answer starts in the middle of it, as a tail can.
  globalThis.fetch = fakeSprites(calls, { answer: (script, env) => `${env.LAB_MODEL_API_KEY.slice(7)} tail\nand whole: ${env.LAB_MODEL_API_KEY}` })
  const result = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'echo $LAB_MODEL_API_KEY', timeout_s: 10 }], { liveModel: { experimentId: 'exp-1', epoch: 22 } })
  const token = envOf(calls.find(c => c.path.endsWith('/exec'))).LAB_MODEL_API_KEY
  assert.equal(result.commands[0].output_tail, '[redacted] tail\nand whole: [redacted]')
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token.slice(-20)))
})

test('calls made during a session are reported with the session', async () => {
  enable()
  const calls = []
  const upstream = fakeOpenRouter([], () => completion({ cost: 0.01 }))
  const spritesApi = fakeSprites(calls, { answer: () => 'called the model twice' })
  let codes = []
  globalThis.fetch = async (url, options) => {
    const u = new URL(String(url))
    if (u.host === 'openrouter.ai') return upstream(url, options)
    const res = await spritesApi(url, options)
    // Stand in for the code inside the sprite: while the command runs, it calls the endpoint with its key.
    if (u.pathname.endsWith('/exec')) {
      const token = envOf(calls[calls.length - 1]).LAB_MODEL_API_KEY
      codes = [(await call(token, ask())).code, (await call(token, ask())).code]
    }
    return res
  }
  const result = await session.runSpriteSession('x-ai/grok-4.7', [{ run: 'node call.js', timeout_s: 30 }], { liveModel: { experimentId: 'exp-9', epoch: 4 } })
  assert.deepEqual(codes, [200, 200])
  assert.equal(result.live_model.offered, true)
  assert.equal(result.live_model.calls, 2)
  assert.equal(result.live_model.cost_usd.toFixed(2), '0.02')
  assert.deepEqual(lab.modelCalls.map(c => [c.experiment_id, c.epoch_number, c.purpose, c.assigned_model_id]), [['exp-9', 4, 'live_model', 'x-ai/grok-4.7'], ['exp-9', 4, 'live_model', 'x-ai/grok-4.7']])
  assert.deepEqual(lab.calls.map(c => [c.sprite, c.issued_to, c.status]), [['observable-grok', 'x-ai/grok-4.7', 'ok'], ['observable-grok', 'x-ai/grok-4.7', 'ok']])
  assert.equal('call_in_flight' in result.live_model, false)
  assert.equal(lab.usageReads, 0) // nothing was running at the end, so there was nothing to wait for
  assert.match(session.sessionTranscript(result), /\nlab model endpoint: 2 calls, \$0\.0200$/)
})

test('a call still running when the session ends is waited for, and if it outlasts the wait the totals say so', async () => {
  enable()
  // The code in the sprite starts a call and the command returns without waiting for it.
  const run = async (settleWaitMs, answerAfterMs) => {
    lab = new FakeDb()
    const calls = []
    let inFlight
    const upstream = fakeOpenRouter([], async () => {
      await new Promise(resolve => setTimeout(resolve, answerAfterMs))
      return completion({ cost: 0.03 })
    })
    const spritesApi = fakeSprites(calls, { answer: () => 'started a call in the background' })
    globalThis.fetch = async (url, options) => {
      const u = new URL(String(url))
      if (u.host === 'openrouter.ai') return upstream(url, options)
      const res = await spritesApi(url, options)
      if (u.pathname.endsWith('/exec')) {
        inFlight = call(envOf(calls[calls.length - 1]).LAB_MODEL_API_KEY, ask())
        while (!lab.keys[0]?.busy_until) await new Promise(resolve => setTimeout(resolve, 1)) // the call has been let through
      }
      return res
    }
    const result = await session.runSpriteSession('x-ai/grok-4.7', [{ run: 'nohup node call.js &', timeout_s: 30 }], { liveModel: { experimentId: 'exp-9', epoch: 4, settleWaitMs } })
    const atEnd = { ...result.live_model }
    assert.equal((await inFlight).code, 200) // revoking the key did not stop the call that was already let through
    return { result, atEnd }
  }

  // It ends inside the wait: the session's totals include its cost and match the ledger.
  const settled = await run(5_000, 40)
  assert.deepEqual(settled.atEnd, { offered: true, calls: 1, cost_usd: 0.03 })
  assert.ok(lab.usageReads >= 1)
  assert.equal(lab.modelCalls.reduce((s, c) => s + c.cost_usd, 0), settled.atEnd.cost_usd)
  assert.match(session.sessionTranscript(settled.result), /\nlab model endpoint: 1 call, \$0\.0300$/)

  // It outlasts the wait: the call is counted, the figure is marked as short, and the ledger still gets the cost.
  const pending = await run(0, 60)
  assert.deepEqual(pending.atEnd, { offered: true, calls: 1, cost_usd: 0, call_in_flight: true })
  assert.match(session.sessionTranscript(pending.result), /\nlab model endpoint: 1 call, \$0\.0000 when the session ended; one call was still running and its cost is not in this figure$/)
  assert.deepEqual(lab.modelCalls.map(c => c.cost_usd), [0.03])
  assert.equal(Number(lab.keys[0].usd_used), 0.03)
  assert.equal(lab.keys[0].revoked, true)
  assert.equal(session.LIVE_SETTLE_WAIT_MS, 10_000)

  // The one-line summary of a session: silent with the endpoint off or unused, plain about the rest.
  assert.equal(session.liveModelClause(undefined), '')
  assert.equal(session.liveModelLine(undefined), '')
  assert.equal(session.liveModelClause({ offered: true, calls: 0, cost_usd: 0 }), '')
  assert.equal(session.liveModelClause(settled.atEnd), '; 1 call(s) to the lab model endpoint')
  assert.equal(session.liveModelClause(pending.atEnd), '; 1 call(s) to the lab model endpoint, one still running when the session ended')
  assert.equal(session.liveModelClause({ offered: false, calls: 0, cost_usd: 0, note: 'the lab has no public https origin set' }), '; the lab model endpoint was not available in this session (the lab has no public https origin set)')
  for (const text of [session.liveModelLine(pending.atEnd), session.liveModelClause(pending.atEnd)]) assert.doesNotMatch(text, /—/)
})

test('no key is made unless the sprite confirmed the egress rule, and the session still runs', async () => {
  enable()
  const widened = entry => entry.body.rules.length > 1
  const cases = {
    'the policy call fails': (body, entry) => widened(entry) ? new Response('no', { status: 500 }) : new Response(body),
    'the sprite answers without the rule': (body, entry) => widened(entry) ? new Response(JSON.stringify({ rules: [{ include: 'defaults' }] })) : new Response(body),
    'the sprite answers with a deny for the host': (body, entry) => widened(entry) ? new Response(JSON.stringify({ rules: [{ include: 'defaults' }, { domain: 'lab.example', action: 'deny' }] })) : new Response(body),
    'the sprite answers with something unreadable': (body, entry) => widened(entry) ? new Response('ok') : new Response(body),
  }
  for (const [name, policy] of Object.entries(cases)) {
    lab = new FakeDb()
    const calls = []
    globalThis.fetch = fakeSprites(calls, { policy })
    const result = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'node -v', timeout_s: 10 }], { liveModel: { experimentId: 'exp-1', epoch: 22 } })
    assert.equal(result.status, 'ok', name)
    assert.equal(result.live_model.offered, false, name)
    assert.match(result.live_model.note, /no key was made/, name)
    assert.equal(lab.keys.length, 0, `${name}: a key was made`)
    for (const c of calls.filter(c => c.path.endsWith('/exec'))) {
      assert.deepEqual(Object.keys(envOf(c)).filter(k => /MODEL|OPENAI|KEY/.test(k)), [], name)
      assert.equal(envOf(c).CI, 'true', `${name}: a session without the key runs as it always did`)
    }
    // The models are told the endpoint is on, so the stored output has to say this session did not get it.
    assert.match(session.sessionTranscript(result), /\nlab model endpoint: not available in this session, no key was made: /, name)
    assert.equal(session.liveModelLine(result.live_model), session.sessionTranscript(result).split('\n').pop(), name)
    assert.match(session.liveModelClause(result.live_model), /^; the lab model endpoint was not available in this session \(no key was made: /, name)
    // Whatever the sprite was left with, the last thing it is given is the defaults policy again.
    const policies = calls.filter(c => c.method === 'POST' && c.path.endsWith('/policy/network')).map(c => c.body.rules.length)
    assert.deepEqual(policies, [1, 2, 1], name)
  }

  // The key store is down: the policy is put back, and the session runs without a key.
  lab = new FakeDb()
  db.handler = text => { if (text.includes('live_model_keys')) throw new Error('database down') }
  const calls = []
  globalThis.fetch = fakeSprites(calls)
  const result = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'node -v', timeout_s: 10 }], { liveModel: { experimentId: 'exp-1', epoch: 22 } })
  assert.equal(result.status, 'ok')
  assert.equal(result.live_model.offered, false)
  const rules = calls.filter(c => c.method === 'POST' && c.path.endsWith('/policy/network')).map(c => c.body.rules.length)
  assert.deepEqual(rules, [1, 2, 1])
  assert.deepEqual(Object.keys(envOf(calls.find(c => c.path.endsWith('/exec')))).filter(k => /MODEL|OPENAI|KEY/.test(k)), [])

  // Without the caller saying who the key is for (any other use of a session), nothing is offered.
  db.handler = (text, values) => lab.handle(text, values)
  const plain = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'node -v', timeout_s: 10 }])
  assert.equal('live_model' in plain, false)
  assert.equal(lab.keys.length, 0)
})

test('the egress rule is one exact host, and the scoped key is the only API key variable a sprite can be given', async () => {
  assert.deepEqual(sprites.networkPolicyRules(), [{ include: 'defaults' }])
  assert.deepEqual(sprites.networkPolicyRules(['lab.example']), [{ include: 'defaults' }, { domain: 'lab.example', action: 'allow' }])
  for (const bad of ['*', '*.example', 'lab.example/x', 'lab.example:443', 'https://lab.example', '10.0.0.1', 'localhost', '', 'LAB.example', 'a b.example']) {
    assert.throws(() => sprites.networkPolicyRules([bad]), /plain host name/, `${bad} must not become a rule`)
  }

  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  process.env.SOME_SERVICE_API_KEY = OTHER_SECRET
  let sentRequests = 0
  globalThis.fetch = async () => { sentRequests++; return new Response('') }
  const good = `labk_${'a'.repeat(64)}`
  // The ordinary env option still cannot set a key-like name, these four included.
  for (const name of ['OPENAI_API_KEY', 'LAB_MODEL_API_KEY', 'OPENAI_BASE_URL', 'LAB_MODEL_BASE_URL', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN']) {
    await assert.rejects(sprites.execInSprite('gpt', 'env', { env: { [name]: good } }), /Refusing env name/)
  }
  // The scoped option takes a scoped key and nothing else.
  for (const key of [OPENROUTER_KEY, OTHER_SECRET, SPRITES_TOKEN, 'sk-or-v1-' + 'a'.repeat(40), `labk_${'a'.repeat(63)}`, `${good}\nX=1`, '']) {
    await assert.rejects(sprites.execInSprite('gpt', 'env', { scopedModelKey: { baseUrl: BASE_URL, key } }), /not a scoped lab key/)
  }
  for (const baseUrl of ['http://lab.example/api', 'https://user:pw@lab.example', 'https://lab.example/?k=1', `https://lab.example/${OTHER_SECRET}?x`, '']) {
    await assert.rejects(sprites.execInSprite('gpt', 'env', { scopedModelKey: { baseUrl, key: good } }), /not plain https/)
  }
  // The check against the server's own credentials still runs with a scoped key present.
  await assert.rejects(sprites.execInSprite('gpt', `echo ${OTHER_SECRET}`, { scopedModelKey: { baseUrl: BASE_URL, key: good } }), /server credential/)
  await assert.rejects(sprites.execInSprite('gpt', 'env', { scopedModelKey: { baseUrl: `https://lab.example/${OTHER_SECRET}`, key: good } }), /server credential/)
  assert.equal(sentRequests, 0)
})

// ===========================================================================
// What the models are told
// ===========================================================================
test('with the endpoint on, the prompts say what it is and where its limits are, and nothing about what to do with it', async () => {
  enable({ LAB_LIVE_MODEL_IDS: 'google/gemini-3.8-flash,thinkingmachines/inkling-2-small', LAB_ENABLE_CODE_WRITES: 'true' })
  const note = live.liveModelNote()
  for (const words of [
    /LAB_MODEL_BASE_URL and LAB_MODEL_API_KEY/, /OPENAI_BASE_URL and OPENAI_API_KEY/,
    /google\/gemini-3\.8-flash, thinkingmachines\/inkling-2-small/,
    /non-streaming only/, /20 calls, one at a time, and \$0\.25/, /15 minutes/, /\$1\.00 a day/, /at most 4096/,
    /not set in CI or in the contribution check, which need no key and keep using a localhost fixture/,
    /Every call is recorded/, /untrusted data/, /every other field is dropped/,
    // It is conditional: switched on is not the same as this session having the key.
    /^Lab model endpoint: when the lab can open it for a Sprite session, that session's commands have/,
    /When the lab cannot open it, the variables are absent and the session's stored output says so/,
    // What the environment and the request really look like.
    /A session that has the key is not given the CI variable; a session without the key, like the contribution check, runs with CI=true/,
    /sent with the header Content-Type: application\/json/,
    /keeps its tool_calls and its reasoning_details/, /comes back with them unchanged/,
  ]) assert.match(note, words)
  // Abilities and limits only: no suggestion of what to build, and no em dash.
  for (const steer of [/should/i, /you can use (it|this) to/i, /build/i, /adapter/i, /try/i, /recommend/i, /—/]) assert.doesNotMatch(note, steer)

  const context = prompts.toolLines()
  assert.ok(context.includes(note))
  assert.match(context, /during a session, the lab model endpoint in the next line/)
  assert.match(context, /it holds no credentials apart from that endpoint's short-lived key/)
  assert.match(prompts.executorToolsSection(), /LAB_MODEL_BASE_URL, with that session's key in LAB_MODEL_API_KEY, when the lab could open the endpoint for that session; the session's stored output says whether it did\./)

  // Sprite sessions off: the endpoint is not offered, so it is not mentioned either.
  delete process.env.LAB_ENABLE_SPRITE_SESSIONS
  const without = prompts.toolLines() + prompts.executorToolsSection()
  for (const words of [/LAB_MODEL/, /OPENAI_/, /model endpoint/i]) assert.doesNotMatch(without, words)
  assert.equal(toolsConfig.enabledTools().includes('live_model'), false)
})
