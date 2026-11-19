// Stories from the research loop's best kept model (LAB_ENABLE_RESEARCH_TALK):
// that nothing of it exists while the switch is off, what the research loop
// asks the runner for while it is on, what is recorded, every limit and
// refusal on the visitor route, and what the room shows.
//
// No network, no database, no secrets: fetch answers like OpenRouter, GitHub
// and the research runner on Modal, and `@vercel/postgres` is an in-memory
// fake that understands the queries these paths make.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-research-talk-test-'))
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
for (const path of ['src/systems/TrainedChatPanel.ts', 'src/systems/ResearchStoryBox.ts']) {
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
const RUNNER_TOKEN = 'test-only-runner-token-0000000000000000'
const MODELS_URL = 'https://runner.example/models'
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder' // read once at import
process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'
process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
process.env.RESEARCH_RUNNER_TOKEN = RUNNER_TOKEN
process.env.RESEARCH_RUNNER_START_URL = 'https://runner.example/start'
process.env.RESEARCH_RUNNER_STATUS_URL = 'https://runner.example/status'
const BASE_ENV = { ...process.env }

let logs = []
const capture = (...args) => logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = capture
console.log = capture
console.error = capture

const load = path => import(pathToFileURL(join(build, path)).href)
const { db } = await import(fakePgUrl)
const talk = await load('api/_lib/research-talk.js')
const research = await load('api/_lib/research.js')
const researchPrompts = await load('api/_lib/research-prompts.js')
const researchEpoch = await load('api/_lib/research-epoch.js')
const openrouter = await load('api/_lib/openrouter.js')
const storyBox = await load('src/systems/ResearchStoryBox.js')
const chatPanel = await load('src/systems/TrainedChatPanel.js')
const { default: route } = await load('api/experiment/research-talk.js')

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------
const JSON_COLUMNS = new Set(['current_spec', 'role_assignments', 'spec_before', 'spec_after', 'plant_geometry', 'planner_output',
  'executor_output', 'challenger_output', 'reviewer_output', 'commentator_output', 'research_run'])
const decode = (col, v) => (JSON_COLUMNS.has(col) && typeof v === 'string' ? JSON.parse(v) : v)
const EXPERIMENT = '0a1b2c3d-0000-4000-8000-000000000001'
let nextId = 1
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`

class FakeLab {
  constructor() {
    this.experiments = []
    this.epochs = []
    this.modelCalls = []
    this.rate = new Map()
    this.storyCalls = []
    this.statements = []
    this.failRate = false
    this.failSpend = false
  }

  handle(text, v) {
    this.statements.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }

    // The story counts and the call records
    if (text.startsWith('INSERT INTO research_talk_rate')) {
      if (this.failRate) throw new Error('database is away')
      const key = `${v[0]}|${v[1]}`
      const n = this.rate.get(key) ?? 0
      if (n >= v[2]) return { rows: [] }
      this.rate.set(key, n + 1)
      return { rows: [{ n: n + 1 }] }
    }
    if (text.startsWith('DELETE FROM research_talk_rate')) return { rows: [] }
    if (text.startsWith('INSERT INTO research_talk_calls')) {
      const [model_key, status, stage, prompt_chars, new_bytes, stopped, cost_usd, duration_ms] = v
      assert.equal(v.length, 8, 'a story record has eight values and none of them is text a visitor wrote')
      this.storyCalls.push({ model_key, status, stage, prompt_chars, new_bytes, stopped, cost_usd, duration_ms })
      return { rows: [] }
    }
    if (text.includes('research_talk_')) throw new Error(`fake db: unsupported statement: ${text}`)

    // The spend ledger
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) {
      if (this.failSpend) throw new Error('ledger is away')
      return { rows: [{ total: String(this.modelCalls.reduce((s, c) => s + c.cost_usd, 0)) }] }
    }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number = ?')) {
      const rows = this.modelCalls.filter(c => c.experiment_id === v[0] && c.epoch_number === v[1])
      return { rows: [{ cost_usd: rows.reduce((s, c) => s + c.cost_usd, 0), prompt_tokens: 0, completion_tokens: 0 }] }
    }

    // Experiments and epochs, as one research epoch uses them
    if (text.startsWith("SELECT id, current_spec->'meta'->'research'->'best_epoch' AS best_epoch FROM experiments")) {
      const e = this.experiments.find(x => x.status !== 'archived' && x.current_spec?.meta?.research)
      return { rows: e ? [{ id: e.id, best_epoch: e.current_spec.meta.research.best_epoch }] : [] }
    }
    if (text === 'SELECT * FROM experiments WHERE id = ?') return { rows: this.experiments.filter(e => e.id === v[0]) }
    if (text.startsWith('UPDATE experiments SET current_spec = ?, current_epoch = ?')) {
      const e = this.experiments.find(x => x.id === v[2])
      Object.assign(e, { current_spec: JSON.parse(v[0]), current_epoch: v[1], epoch_in_progress: false })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE experiments SET epoch_in_progress = FALSE')) return { rows: [] }
    if (/\bexperiments\b/.test(text) && !text.includes('experiment_id')) throw new Error(`fake db: unsupported experiments statement: ${text}`)
    if (text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND epoch_number = ? LIMIT 1')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number === v[1]) }
    }
    if (text.startsWith('INSERT INTO epochs (experiment_id, epoch_number, role_assignments, spec_before) VALUES')) {
      const ep = { id: uuid(), experiment_id: v[0], epoch_number: v[1], role_assignments: JSON.parse(v[2]), spec_before: JSON.parse(v[3]), completed_at: null }
      this.epochs.push(ep)
      return { rows: [{ id: ep.id }] }
    }
    if (text.startsWith('UPDATE epochs')) {
      const ep = this.epochs.find(e => e.id === v[v.length - 1])
      // The promotion is merged into the stored run, leaving what is there.
      if (text === "UPDATE epochs SET research_run = COALESCE(research_run, '{}'::jsonb) || ?::jsonb WHERE id = ?") {
        ep.research_run = { ...(ep.research_run ?? {}), ...JSON.parse(v[0]) }
        return { rows: [] }
      }
      const m = text.match(/^UPDATE epochs SET (.*) WHERE id = \?$/)
      if (!m) throw new Error(`fake db: unsupported epochs update: ${text}`)
      let i = 0
      for (const pair of m[1].split(', ')) {
        const [col, expr] = pair.split(' = ')
        ep[col.trim()] = decode(col.trim(), expr.trim() === '?' ? v[i++] : expr.trim() === 'NOW()' ? new Date() : expr.trim())
      }
      return { rows: [] }
    }
    return { rows: [] }
  }
}

let lab
beforeEach(() => {
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  logs = []
  process.env = { ...BASE_ENV }
  talk.resetResearchTalkCache()
  openrouter.resetModelCatalog()
})

const enable = (extra = {}) => Object.assign(process.env, { LAB_ENABLE_RESEARCH_TALK: 'true', RESEARCH_RUNNER_MODELS_URL: MODELS_URL, ...extra })
const noNetwork = () => { globalThis.fetch = async url => { throw new Error(`no request expected: ${url}`) } }
const noDatabase = () => { db.handler = text => { throw new Error(`no statement expected: ${text}`) } }

function response() {
  return {
    code: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}
async function visit(body, { method = 'POST', ip = '203.0.113.9', agent = 'test-browser', type = 'application/json', handler = route } = {}) {
  const res = response()
  await handler({ method, headers: { 'content-type': type, 'x-real-ip': ip, 'user-agent': agent }, query: {}, body }, res)
  return res
}

const KEY = 'e81-0a1b2c3d'
const kept = (over = {}) => ({
  key: KEY, source: 'epoch', epoch: 81, saved_at: 1000, promoted_at: 2000, dataset: 'tinystories_gpt4_clean', gpu: 'A10G', budget_s: 300,
  val_bpb: 0.6912, params_m: 10.9, metrics_source: 'experiment_stdout_unverified', params: 10916736, seq_len: 512, module: 'GPT',
  model_bytes: 43_000_000, model_sha256: 'c'.repeat(64), check: { ok: true, reason: null, sample: 'Once upon a time', checked_at: 2100 }, ...over,
})

/** The research runner's models endpoint. `models` is what "info" lists; `sample(body)` answers a story request. */
function fakeRunner({ models = [kept()], sample, promote } = {}) {
  const sent = []
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), MODELS_URL)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, `Bearer ${RUNNER_TOKEN}`)
    const body = JSON.parse(options.body)
    sent.push(body)
    if (body.action === 'info') return new Response(JSON.stringify({ models: typeof models === 'function' ? models() : models }))
    if (body.action === 'promote') return new Response(JSON.stringify(promote ? promote(body) : { ok: true, already: false, model: kept() }))
    if (body.action === 'sample') {
      const answer = sample ? await sample(body) : { status: 'ok', prompt: body.prompt, continuation: ' there was a small red fox.\n\n', text: 'x', new_bytes: 29, stopped: 'end', key: body.key }
      return answer instanceof Response ? answer : new Response(JSON.stringify(answer))
    }
    return new Response('{}', { status: 400 })
  }
  return sent
}

// ===========================================================================
// 1. The switch
// ===========================================================================
test('it is off unless the flag is exactly "true" and the runner\'s models endpoint and token are set', () => {
  assert.equal(talk.researchTalkFlag(), false)
  assert.deepEqual(talk.researchTalkStatus(), { enabled: false, off_reason: 'LAB_ENABLE_RESEARCH_TALK is not true' })
  for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
    process.env.LAB_ENABLE_RESEARCH_TALK = value
    process.env.RESEARCH_RUNNER_MODELS_URL = MODELS_URL
    assert.equal(talk.researchTalkStatus().enabled, false, value)
  }
  process.env.LAB_ENABLE_RESEARCH_TALK = ' true '
  assert.equal(talk.researchTalkStatus().enabled, true)
  for (const bad of ['', 'http://runner.example/models', 'https://user:pw@runner.example/models', 'not a url']) {
    process.env.RESEARCH_RUNNER_MODELS_URL = bad
    assert.equal(talk.researchTalkStatus().enabled, false, bad)
    assert.equal(talk.researchStoryStatus().enabled, false, bad)
  }
  process.env.RESEARCH_RUNNER_MODELS_URL = MODELS_URL
  delete process.env.RESEARCH_RUNNER_TOKEN
  assert.equal(talk.researchTalkStatus().enabled, false)
  process.env.RESEARCH_RUNNER_TOKEN = RUNNER_TOKEN
  // A daily number of 0 closes the story box and keeps the saving on.
  process.env.LAB_RESEARCH_TALK_DAILY = '0'
  assert.equal(talk.researchTalkStatus().enabled, true)
  assert.deepEqual(talk.researchStoryStatus(), { enabled: false, off_reason: 'LAB_RESEARCH_TALK_DAILY is 0' })
})

test('the limits have the documented defaults and cannot be set past their hard caps', () => {
  assert.deepEqual([talk.researchTalkDaily(), talk.researchTalkMaxNew(), talk.researchTalkUsdPerStory()], [200, 200, 0.005])
  Object.assign(process.env, { LAB_RESEARCH_TALK_DAILY: '999999', LAB_RESEARCH_TALK_MAX_NEW: '999999', LAB_RESEARCH_TALK_USD_PER_STORY: '99' })
  assert.deepEqual([talk.researchTalkDaily(), talk.researchTalkMaxNew(), talk.researchTalkUsdPerStory()], [2000, 500, 0.25])
  Object.assign(process.env, { LAB_RESEARCH_TALK_DAILY: '-5', LAB_RESEARCH_TALK_MAX_NEW: '1', LAB_RESEARCH_TALK_USD_PER_STORY: '-1' })
  assert.deepEqual([talk.researchTalkDaily(), talk.researchTalkMaxNew(), talk.researchTalkUsdPerStory()], [0, 20, 0])
  Object.assign(process.env, { LAB_RESEARCH_TALK_DAILY: 'many', LAB_RESEARCH_TALK_MAX_NEW: 'NaN', LAB_RESEARCH_TALK_USD_PER_STORY: 'x' })
  assert.deepEqual([talk.researchTalkDaily(), talk.researchTalkMaxNew(), talk.researchTalkUsdPerStory()], [200, 200, 0.005])
})

test('while it is off the route says so and touches neither the database nor the network', async () => {
  noNetwork()
  noDatabase()
  for (const env of [{}, { LAB_ENABLE_RESEARCH_TALK: 'true' }, { RESEARCH_RUNNER_MODELS_URL: MODELS_URL }]) {
    process.env = { ...BASE_ENV, ...env }
    const get = await visit(undefined, { method: 'GET' })
    assert.equal(get.code, 200)
    assert.deepEqual(get.body, { enabled: false, model: null })
    assert.equal(get.headers['Cache-Control'], 'no-store')
    const post = await visit({ prompt: 'A cat' })
    assert.equal(post.code, 503)
    assert.equal(post.body.error, 'off')
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await visit({}, { method })).code, 405)
  // The room's state names the story box only while it is on.
  const state = readFileSync(join(root, 'api/experiment/index.ts'), 'utf8')
  assert.match(state, /\.\.\.\(researchStoryStatus\(\)\.enabled \? \{ research_talk_enabled: true \} : \{\}\)/)
})

// ===========================================================================
// 2. The research loop: what it asks the runner for
// ===========================================================================
const MODEL_IDS = ['google/gemini-4-hydrogen', 'deepseek/deepseek-v4-pro-0813', 'anthropic/claude-fable-5.2', 'openai/gpt-6-astra', 'x-ai/grok-4.7', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash']
const CATALOG = {
  data: MODEL_IDS.map(id => ({
    id, supported_parameters: ['max_tokens', 'reasoning', 'response_format'],
    reasoning: { supported_efforts: ['high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 128000 },
    pricing: { prompt: '0.000002', completion: '0.00001' },
  })),
}
const TRAIN_PY = `def train():\n    pass\n${'# filler line for a plausible file\n'.repeat(80)}print('RESULT {}')\n`

function researchExperiment() {
  const exp = {
    id: EXPERIMENT, status: 'growing', current_epoch: 80, epoch_in_progress: true,
    current_spec: {
      identity: { purpose: 'research', domain: 'ml' }, capabilities: [], constraints: [], behaviors: [], conflicts: [],
      meta: { stability_score: 0.2, growth_stage: 'seed', total_epochs: 80, total_mutations: 0, total_prunings: 0,
        research: { baseline_bpb: 0.72, best_bpb: 0.7, best_epoch: 40, target_bpb: 0.35 } },
    },
  }
  lab.experiments.push(exp)
  return exp
}

/** OpenRouter, the research repository and the runner for one research epoch. */
function fakeWorld({ verdict = 'keep', bpb = 0.69, checkpoint, promote, status = 'ok' } = {}) {
  const world = { starts: [], runner: [], chats: [], files: { 'train.py': TRAIN_PY, 'wiki/index.md': '# Wiki\n' }, puts: [] }
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    if (target === 'https://openrouter.ai/api/v1/models') return new Response(JSON.stringify(CATALOG))
    if (target === 'https://openrouter.ai/api/v1/chat/completions') {
      world.chats.push(body)
      const user = body.messages.at(-1).content
      const content = user.startsWith('Propose this epoch') ? { hypothesis: 'a warmup schedule lowers val_bpb', notebook: '' }
        : user.startsWith('Implement the experiment') ? { train_py: TRAIN_PY, change_summary: 'added warmup' }
        : user.startsWith('Stress-test') ? { challenges: [] }
        : user.startsWith('Rule: keep or revert') ? { verdict, reason: 'the number decided' }
        : { summary: 'A run, measured.', mood: 'steady' }
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 } }))
    }
    if (target === 'https://runner.example/start') {
      world.starts.push(options.body)
      return new Response(JSON.stringify({ call_id: 'call-1' }))
    }
    if (target.startsWith('https://runner.example/status')) {
      const result = status === 'ok'
        ? { status: 'ok', metrics: { val_bpb: bpb, train_steps: 100, train_seconds: 299, params_m: 10.9 }, metrics_source: 'experiment_stdout_unverified', dataset: 'tinystories_gpt4_clean', wall_seconds: 400, train_wall_seconds: 310, ...(checkpoint ? { checkpoint } : {}) }
        : { status: 'crash', stage: 'train', error: 'boom' }
      return new Response(JSON.stringify({ status: 'done', result }))
    }
    if (target === MODELS_URL) {
      assert.equal(options.headers.Authorization, `Bearer ${RUNNER_TOKEN}`)
      world.runner.push(body)
      if (promote instanceof Error) throw promote
      return new Response(JSON.stringify(promote ?? { ok: true, already: false, model: kept() }))
    }
    if (target.startsWith('https://api.github.com/repos/test-owner/Research-Lab/')) {
      const path = decodeURIComponent(target.split('/contents/')[1] ?? '').split('?')[0]
      if ((options.method || 'GET') === 'PUT') {
        world.files[path] = Buffer.from(body.content, 'base64').toString('utf8')
        world.puts.push(path)
        return new Response(JSON.stringify({ content: { sha: 'new' } }))
      }
      if (!(path in world.files)) return new Response('{}', { status: 404 })
      const bytes = Buffer.from(world.files[path], 'utf8')
      return new Response(JSON.stringify({ type: 'file', sha: `sha-${path}`, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }))
    }
    throw new Error(`Unexpected request ${options.method || 'GET'} ${target}`)
  }
  return world
}
const savedCheckpoint = (over = {}) => ({ key: KEY, saved: true, bytes: 43_000_000, parts: 11, sha256: 'c'.repeat(64), params: 10916736, seq_len: 512, eval_calls: 1, eval_bpb: 0.69, save_seconds: 0.7, collect_seconds: 9.1, ...over })

test('with the flag off a research run is started exactly as before and nothing about a saved model is asked or recorded', async () => {
  researchExperiment()
  const world = fakeWorld({ checkpoint: savedCheckpoint() })
  await researchEpoch.runResearchEpoch(EXPERIMENT)
  // The request body is the two fields it always had, in the same order.
  assert.deepEqual(world.starts, [JSON.stringify({ train_py: TRAIN_PY, budget_s: 300 })])
  assert.deepEqual(world.runner, [])
  const run = lab.epochs[0].research_run
  assert.deepEqual(Object.keys(run), ['call_id', 'budget_s', 'result'])
  assert.equal(lab.statements.some(s => s.text.includes('COALESCE(research_run')), false)
  assert.equal(world.files['wiki/findings/epoch-081.md'].includes('Saved model'), false)
  // No prompt of the epoch says anything about saved models.
  assert.equal(world.chats.length, 5)
  for (const chat of world.chats) assert.equal(JSON.stringify(chat).includes('WHAT HAPPENS TO A KEPT MODEL'), false)
  // And the flag alone, without the runner's models endpoint, is still off.
  lab = new FakeLab(); db.handler = (t, v) => lab.handle(t, v)
  researchExperiment()
  process.env.LAB_ENABLE_RESEARCH_TALK = 'true'
  const again = fakeWorld({})
  await researchEpoch.runResearchEpoch(EXPERIMENT)
  assert.deepEqual(again.starts, [JSON.stringify({ train_py: TRAIN_PY, budget_s: 300 })])
})

test('with the flag on the run carries a key, and a run kept as the new best has its saved model promoted and recorded', async () => {
  enable()
  researchExperiment()
  assert.equal(talk.researchModelKey(EXPERIMENT, 81), KEY)
  const world = fakeWorld({ checkpoint: savedCheckpoint() })
  await researchEpoch.runResearchEpoch(EXPERIMENT)
  assert.deepEqual(world.starts, [JSON.stringify({ train_py: TRAIN_PY, budget_s: 300, keep_key: KEY })])
  assert.deepEqual(world.runner, [{ action: 'promote', key: KEY }])
  const run = lab.epochs[0].research_run
  assert.equal(run.keep_key, KEY)
  assert.equal(run.result.checkpoint.saved, true)
  assert.equal(run.result.checkpoint.sha256, 'c'.repeat(64))
  assert.equal(run.promotion.ok, true)
  assert.match(run.promotion.at, /^\d{4}-\d\d-\d\dT/)
  // The epoch itself is what it would have been: kept, the new best, train.py committed.
  assert.equal(lab.experiments[0].current_spec.meta.research.best_bpb, 0.69)
  assert.ok(world.puts.includes('train.py'))
  const page = world.files['wiki/findings/epoch-081.md']
  assert.match(page, /- \*\*Saved model:\*\* saved by the runner as e81-0a1b2c3d \(43000000 bytes, SHA-256 `c{64}`\); the file was written in the same process as the generated code and is not independently checked\. Kept for visitors to ask for a story\n\n## Hypothesis/)
  // The models are told what happens, as a fact with its limits, in every role's prompt.
  for (const chat of world.chats) {
    const text = JSON.stringify(chat)
    assert.ok(text.includes('WHAT HAPPENS TO A KEPT MODEL (a fact about the lab, not a goal'))
    assert.ok(text.includes('A model it cannot save or load that way is simply not offered to visitors'))
  }
})

test('a reverted run, a run whose model was not saved, and a runner that was not redeployed promote nothing', async () => {
  for (const [world, words] of [
    [() => fakeWorld({ verdict: 'revert', bpb: 0.74, checkpoint: savedCheckpoint() }), 'Not kept for visitors: the run was not a new best'],
    [() => fakeWorld({ checkpoint: { key: KEY, saved: false, reason: 'prepare.evaluate_bpb was never called,\nso there was no model to save' } }), 'not saved (prepare.evaluate_bpb was never called, so there was no model to save)'],
    [() => fakeWorld({}), 'not saved (the runner said nothing about a saved model; it may not have been redeployed)'],
    [() => fakeWorld({ status: 'crash' }), 'not saved (the run did not finish with a score)'],
    // A checkpoint under another key, or without its hash, is not one the lab asked for.
    [() => fakeWorld({ checkpoint: savedCheckpoint({ key: 'e82-0a1b2c3d' }) }), 'saved by the runner'],
    [() => fakeWorld({ checkpoint: savedCheckpoint({ sha256: 'zz' }) }), 'not saved'],
  ]) {
    lab = new FakeLab(); db.handler = (t, v) => lab.handle(t, v)
    enable()
    researchExperiment()
    const w = world()
    await researchEpoch.runResearchEpoch(EXPERIMENT)
    assert.deepEqual(w.runner, [], words)
    assert.equal(lab.epochs[0].research_run.promotion, undefined, words)
    assert.ok(w.files['wiki/findings/epoch-081.md'].includes(words), `${words}\n${w.files['wiki/findings/epoch-081.md'].slice(0, 900)}`)
    assert.equal(lab.epochs[0].completed_at instanceof Date, true)
  }
})

test('a promotion the runner refuses, or that cannot be asked, is recorded and does not fail the epoch', async () => {
  for (const [promote, words] of [
    [{ ok: false, error: 'no saved model under that key\n(it was not saved, or it has been cleared away)' }, 'no saved model under that key (it was not saved, or it has been cleared away)'],
    [new Error('connect ECONNREFUSED'), 'connect ECONNREFUSED'],
  ]) {
    lab = new FakeLab(); db.handler = (t, v) => lab.handle(t, v)
    enable()
    researchExperiment()
    const world = fakeWorld({ checkpoint: savedCheckpoint(), promote })
    const out = await researchEpoch.runResearchEpoch(EXPERIMENT)
    assert.equal(out.success, true)
    assert.equal(lab.experiments[0].current_spec.meta.research.best_epoch, 81)
    assert.deepEqual([lab.epochs[0].research_run.promotion.ok, lab.epochs[0].research_run.promotion.error], [false, words])
    assert.ok(world.files['wiki/findings/epoch-081.md'].includes(`Not kept for visitors: ${words}`))
  }
})

test('what the runner says about a saved model is cleaned before it is stored', () => {
  const clean = raw => research.sanitizeRunResult({ status: 'ok', metrics: { val_bpb: 0.7 }, checkpoint: raw }).checkpoint
  assert.equal(research.sanitizeRunResult({ status: 'ok', metrics: { val_bpb: 0.7 } }).checkpoint, undefined)
  assert.equal('checkpoint' in research.sanitizeRunResult({ status: 'ok', metrics: { val_bpb: 0.7 } }), false)
  assert.equal(clean('yes'), undefined)
  assert.equal(research.sanitizeRunResult({ status: 'crash', checkpoint: savedCheckpoint() }).checkpoint, undefined)
  assert.deepEqual(clean(savedCheckpoint()), { key: KEY, saved: true, sha256: 'c'.repeat(64), bytes: 43_000_000, params: 10916736, seq_len: 512, eval_bpb: 0.69, save_seconds: 0.7, collect_seconds: 9.1 })
  assert.equal(clean(savedCheckpoint({ key: '../x' })).saved, false)
  assert.equal(clean(savedCheckpoint({ key: 'owner-0a1b2c3d' })).saved, false)
  assert.equal(clean(savedCheckpoint({ bytes: 'many' })).saved, false)
  assert.equal(clean(savedCheckpoint({ saved: 'true' })).saved, false)
  const odd = clean({ key: KEY, saved: false, reason: `line one\nline two\t${'x'.repeat(900)}`, bytes: -4, eval_bpb: Infinity, extra: '<script>' })
  assert.equal(odd.reason.length, 300)
  assert.equal(/[\n\t]/.test(odd.reason), false)
  assert.deepEqual(Object.keys(odd).sort(), ['key', 'reason', 'saved'])
})

test('a key is made only from a real epoch and experiment id, and the prompt note appears only when asked for', () => {
  assert.equal(talk.researchModelKey('0A1B2C3D-0000-4000-8000-000000000001', 5), 'e5-0a1b2c3d')
  for (const [id, epoch] of [['not-a-uuid', 5], ['', 5], [EXPERIMENT, 0], [EXPERIMENT, 1.5], [EXPERIMENT, 1_000_000], [EXPERIMENT, NaN]]) {
    assert.equal(talk.researchModelKey(id, epoch), null, `${id} ${epoch}`)
  }
  const inputs = { epochNumber: 81, spec: researchExperimentSpec(), research: { baseline_bpb: 0.72, best_bpb: 0.7, best_epoch: 40, target_bpb: 0.35 }, trainPy: TRAIN_PY, resultsTsv: '', wikiIndex: '', recentHistory: [] }
  const off = researchPrompts.getResearchSharedContext(inputs)
  const on = researchPrompts.getResearchSharedContext({ ...inputs, storyModel: true })
  assert.equal(off.includes('KEPT MODEL'), false)
  assert.equal(on, off.replace('```\n\nWHERE YOU ARE', '```' + researchPrompts.STORY_MODEL_NOTE + '\n\nWHERE YOU ARE'))
  // The note states what the lab does and its limits. It sets no task.
  assert.match(researchPrompts.STORY_MODEL_NOTE, /a fact about the lab, not a goal; val_bpb is still the only thing a run is judged on/)
  assert.match(researchPrompts.STORY_MODEL_NOTE, /nothing needs to be added for it/)
  assert.equal(/\b(you should|you must|try to|make sure|please)\b/i.test(researchPrompts.STORY_MODEL_NOTE), false)
})
function researchExperimentSpec() {
  return { identity: { purpose: 'research' }, capabilities: [], constraints: [], behaviors: [], conflicts: [], meta: { stability_score: 0.2 } }
}

// ===========================================================================
// 3. The visitor route
// ===========================================================================
test('GET names the newest kept model whose sample worked, and says when the best is not that one', async () => {
  enable()
  const sent = fakeRunner({ models: [
    kept({ key: 'e90-0a1b2c3d', epoch: 90, val_bpb: 0.65, check: null }),
    kept({ key: 'e85-0a1b2c3d', epoch: 85, check: { ok: false, reason: 'definitions: NameError' } }),
    kept(),
    { key: '<img>', check: { ok: true } }, 'nonsense',
  ] })
  lab.experiments.push({ id: EXPERIMENT, status: 'growing', current_spec: { meta: { research: { best_epoch: 90 } } } })
  const get = await visit(undefined, { method: 'GET' })
  assert.equal(get.code, 200)
  assert.deepEqual(get.body, {
    enabled: true,
    model: { key: KEY, source: 'epoch', epoch: 81, val_bpb: 0.6912, params_m: 10.9, budget_s: 300 },
    newest: { epoch: 90, source: 'epoch', checked: false },
    best_epoch: 90,
    limits: { max_prompt_chars: 200, max_new_bytes: 200 },
    notice: talk.RESEARCH_TALK_NOTICE,
    default_prompt: 'Once upon a time',
  })
  // Read from the runner once a minute at most, however often the page asks.
  await visit(undefined, { method: 'GET' })
  await visit(undefined, { method: 'GET' })
  assert.deepEqual(sent, [{ action: 'info' }])
  // Another experiment's best, or an older one, is no reason for a note.
  for (const [id, best] of [['ffffffff-0000-4000-8000-000000000001', 90], [EXPERIMENT, 81], [EXPERIMENT, 40]]) {
    talk.resetResearchTalkCache()
    lab.experiments = [{ id, status: 'growing', current_spec: { meta: { research: { best_epoch: best } } } }]
    assert.equal('best_epoch' in (await visit(undefined, { method: 'GET' })).body, false)
  }
})

test('GET with nothing kept, an owner\'s re-run, and a runner that cannot be reached', async () => {
  enable()
  fakeRunner({ models: [] })
  assert.deepEqual((await visit(undefined, { method: 'GET' })).body.model, null)
  talk.resetResearchTalkCache()
  fakeRunner({ models: [kept({ key: 'owner-0a1b2c3d', source: 'owner_rerun', epoch: null })] })
  assert.deepEqual((await visit(undefined, { method: 'GET' })).body.model, { key: 'owner-0a1b2c3d', source: 'owner_rerun', epoch: null, val_bpb: 0.6912, params_m: 10.9, budget_s: 300 })
  talk.resetResearchTalkCache()
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  const down = await visit(undefined, { method: 'GET' })
  assert.deepEqual([down.code, down.body.enabled, down.body.model, down.body.unavailable], [200, true, null, true])
  // A smoke run's model is never listed as one to talk to, whatever the runner says.
  assert.equal(talk.readStoryModel(kept({ key: 'smoke-0a1b2c3d' })), null)
})

const VISITOR_TEXT = 'Tell me about the secret garden of Zanzibar'

test('a story: one line goes to the runner, plain text comes back, and only counts are kept', async () => {
  enable()
  const sent = fakeRunner({ sample: body => ({ status: 'ok', prompt: body.prompt, continuation: ' was green.\u0000\u001b[31m She smiled <b>.\n\n' + 'z'.repeat(900), stopped: 'limit' }) })
  const res = await visit({ prompt: `  ${VISITOR_TEXT}\n\u2603  ` })
  assert.equal(res.code, 200)
  assert.deepEqual(sent, [{ action: 'info' }, { action: 'sample', key: KEY, prompt: VISITOR_TEXT, max_new: 200 }])
  assert.equal(res.body.prompt, VISITOR_TEXT)
  assert.equal(res.body.story, VISITOR_TEXT + res.body.continuation)
  assert.ok(res.body.continuation.startsWith(' was green. She smiled <b>.\n\nzzz'))
  assert.equal(res.body.continuation.length, 200)
  assert.equal(/[^\x20-\x7e\n]/.test(res.body.story), false)
  assert.equal(res.body.stopped, 'limit')
  assert.deepEqual(res.body.model, { key: KEY, source: 'epoch', epoch: 81, val_bpb: 0.6912, params_m: 10.9, budget_s: 300 })
  // The ledger: one flat estimate, under its own purpose.
  assert.equal(lab.modelCalls.length, 1)
  assert.deepEqual([lab.modelCalls[0].purpose, lab.modelCalls[0].model_id, lab.modelCalls[0].assigned_model_id, lab.modelCalls[0].cost_usd, lab.modelCalls[0].cost_source],
    ['research_talk', 'tool/research_talk', `research:${KEY}`, 0.005, 'estimate'])
  // The record of the call: counts, and nothing the visitor wrote or the model answered.
  assert.equal(lab.storyCalls.length, 1)
  assert.deepEqual({ ...lab.storyCalls[0], duration_ms: 0 }, { model_key: KEY, status: 'ok', stage: null, prompt_chars: VISITOR_TEXT.length, new_bytes: 200, stopped: 'limit', cost_usd: 0.005, duration_ms: 0 })
  const everything = JSON.stringify(lab.statements) + logs.join('\n')
  assert.equal(everything.includes('Zanzibar'), false)
  assert.equal(everything.includes('She smiled'), false)
  assert.equal(everything.includes('203.0.113.9'), false)
  assert.equal(everything.includes(RUNNER_TOKEN), false)
  // An empty line means the default opening.
  const plain = await visit({}, { ip: '203.0.113.10' })
  assert.equal(plain.body.prompt, 'Once upon a time')
  assert.equal(sent.at(-1).prompt, 'Once upon a time')
})

test('requests that are not one short line of JSON are refused before anything is counted or sent', async () => {
  enable()
  const sent = fakeRunner()
  for (const [body, options, code, error] of [
    [{ prompt: 'x'.repeat(201) }, {}, 400, 'too_long'],
    [{ prompt: 5 }, {}, 400, 'invalid_request'],
    [{ prompt: 'a', model: KEY }, {}, 400, 'invalid_request'],
    [{ prompt: 'a', max_new: 5000 }, {}, 400, 'invalid_request'],
    [['a'], {}, 400, 'invalid_request'],
    ['{not json', {}, 400, 'invalid_request'],
    [{ prompt: 'a' }, { type: 'text/plain' }, 415, 'unsupported_media_type'],
    [{ prompt: 'a' }, { type: 'application/x-www-form-urlencoded' }, 415, 'unsupported_media_type'],
  ]) {
    const res = await visit(body, options)
    assert.deepEqual([res.code, res.body.error], [code, error], JSON.stringify(body).slice(0, 40))
  }
  assert.deepEqual([sent.length, lab.rate.size, lab.modelCalls.length, lab.storyCalls.length], [0, 0, 0, 0])
  assert.equal(talk.cleanStoryPrompt('a\u0000b\tc\nd  \u00e9\u4e2d e'), 'a b c d e')
})

test('one visitor, one address and all visitors together each have a limit, held by the database', async () => {
  enable()
  const sent = fakeRunner()
  const stories = () => sent.filter(b => b.action === 'sample').length
  // One visitor: three in ten minutes.
  for (let i = 0; i < talk.RESEARCH_TALK_PER_WINDOW; i++) assert.equal((await visit({ prompt: `story ${i}` })).code, 200)
  const fourth = await visit({ prompt: 'one more' })
  assert.deepEqual([fourth.code, fourth.body.error, fourth.headers['Retry-After']], [429, 'rate', '600'])
  assert.equal(stories(), talk.RESEARCH_TALK_PER_WINDOW)
  // Changing the browser string gets as far as the address limit and no further.
  let passed = 0
  for (let i = 0; i < 10; i++) if ((await visit({ prompt: 'again' }, { agent: `other-browser-${i}` })).code === 200) passed++
  // (The refused fourth was counted for the address before the visitor's own limit stopped it.)
  assert.equal(passed, talk.RESEARCH_TALK_ADDRESS_PER_WINDOW - talk.RESEARCH_TALK_PER_WINDOW - 1)
  // The day's own limits.
  assert.ok(talk.RESEARCH_TALK_PER_DAY > talk.RESEARCH_TALK_PER_WINDOW && talk.RESEARCH_TALK_ADDRESS_PER_DAY > talk.RESEARCH_TALK_PER_DAY)
  for (const key of [...lab.rate.keys()]) if (key.includes('|w:')) lab.rate.delete(key)
  for (const key of [...lab.rate.keys()]) if (key.includes('|d:') && !key.startsWith('all|')) lab.rate.set(key, 1000)
  const day = await visit({ prompt: 'tomorrow then' })
  assert.deepEqual([day.code, day.body.error, day.body.message], [429, 'rate', 'You have reached today\'s story limit. It starts again at 00:00 UTC.'])
  // All visitors together: LAB_RESEARCH_TALK_DAILY.
  process.env.LAB_RESEARCH_TALK_DAILY = '8'
  const before = stories()
  const all = [...lab.rate.entries()].find(([k]) => k.startsWith('all|d:'))
  assert.equal(all[1], before)
  let more = 0
  for (let i = 0; i < 6; i++) if ((await visit({ prompt: 'hello' }, { ip: `198.51.100.${i}` })).code === 200) more++
  assert.equal(more, 8 - before)
  const full = await visit({ prompt: 'hello' }, { ip: '198.51.100.99' })
  assert.deepEqual([full.code, full.body.error], [429, 'budget'])
  assert.equal(stories(), 8)
  // No address is stored: the counts are kept under keyed hashes.
  for (const key of lab.rate.keys()) assert.match(key, /^(all|[0-9a-f]{40})\|[wd]:/)
})

test('the lab\'s daily budget, a database that cannot count and a missing model all refuse before a sandbox starts', async () => {
  enable()
  let sent = fakeRunner()
  lab.modelCalls.push({ cost_usd: 15, purpose: 'epoch' })
  const broke = await visit({ prompt: 'a' })
  assert.deepEqual([broke.code, broke.body.error], [429, 'budget'])
  lab.modelCalls = []
  lab.failSpend = true
  assert.equal((await visit({ prompt: 'a' }, { ip: '198.51.100.1' })).code, 503)
  lab.failSpend = false
  lab.failRate = true
  const closed = await visit({ prompt: 'a' }, { ip: '198.51.100.2' })
  assert.deepEqual([closed.code, closed.body.error], [503, 'unavailable'])
  lab.failRate = false
  assert.equal(sent.filter(b => b.action === 'sample').length, 0)
  // Nothing kept, or nothing whose sample worked: there is no model to ask.
  for (const models of [[], [kept({ check: null })], [kept({ check: { ok: false, reason: 'load: boom' } })]]) {
    talk.resetResearchTalkCache()
    sent = fakeRunner({ models })
    const none = await visit({ prompt: 'a' }, { ip: `198.51.100.${10 + models.length}`, agent: JSON.stringify(models).length + 'x' })
    assert.deepEqual([none.code, none.body.error], [404, 'no_model'])
    assert.equal(sent.filter(b => b.action === 'sample').length, 0)
  }
  assert.equal(lab.modelCalls.length, 0)
})

test('a model that fails, a runner that is away and a slow sandbox are plain refusals, still counted, with nothing of the error shown or logged', async () => {
  enable()
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  let n = 0
  for (const [sample, code, stage] of [
    [() => ({ status: 'error', stage: 'load', error: `UnpicklingError near ${VISITOR_TEXT}` }), 502, 'load'],
    [() => ({ status: 'error', stage: '<script>alert(1)</script>', error: 'x' }), 502, 'runner'],
    [() => ({ status: 'ok', continuation: 5 }), 502, 'runner'],
    [() => new Response('upstream broke', { status: 500 }), 502, 'unreachable'],
    [() => { throw timeout }, 504, 'timeout'],
  ]) {
    talk.resetResearchTalkCache()
    fakeRunner({ sample })
    logs = []
    const res = await visit({ prompt: VISITOR_TEXT }, { ip: `198.51.100.${++n}` })
    assert.deepEqual([res.code, res.body.error, res.body.message], [code, 'busy', 'The model did not write this time. Please try again in a moment.'], stage)
    assert.deepEqual(logs, [`[research-talk] no story (${stage})`])
    assert.deepEqual([lab.storyCalls.at(-1).status, lab.storyCalls.at(-1).stage, lab.storyCalls.at(-1).new_bytes], ['error', stage, 0])
  }
  assert.equal(lab.modelCalls.length, 5)
  assert.equal((JSON.stringify(lab.statements) + JSON.stringify(lab.storyCalls)).includes('Zanzibar'), false)
})

test('what the runner lists and answers is read strictly', () => {
  assert.equal(talk.readStoryModel(null), null)
  assert.equal(talk.readStoryModel({ key: 'e81-0A1B2C3D' }), null)
  const odd = talk.readStoryModel({ key: KEY, source: 'owner_rerun', epoch: 999, val_bpb: -1, params_m: 'big', params: 5_000_000, model_sha256: 'short', check: { ok: 'yes' } })
  assert.deepEqual(odd, { key: KEY, source: 'epoch', epoch: 81, val_bpb: null, params_m: 5, budget_s: null, promoted_at: null, model_sha256: null, check: null })
  assert.deepEqual(talk.readStoryModel(kept({ check: { ok: false, reason: 'load:\nboom\u0007' } })).check, { ok: false, reason: 'load: boom' })
  assert.deepEqual(talk.readStoryAnswer({ status: 'ok', continuation: 'a\u0000b\u00e9\n' + 'c'.repeat(50), stopped: 'whenever' }, 10), { ok: true, continuation: 'ab\nccccccc', stopped: 'limit' })
  assert.deepEqual(talk.readStoryAnswer({ status: 'ok', continuation: '', stopped: 'time' }, 10), { ok: true, continuation: '', stopped: 'time' })
  for (const bad of [null, 'text', [], { status: 'ok' }, { status: 'error' }, { status: 'error', stage: 5 }]) assert.deepEqual(talk.readStoryAnswer(bad, 10), { ok: false, stage: 'runner' })
})

// ===========================================================================
// 4. The room
// ===========================================================================
test('the story box says which model it is, that its score is self-reported, and when the best is not this one', () => {
  const info = storyBox.parseStoryInfo({
    enabled: true, model: { key: KEY, source: 'epoch', epoch: 81, val_bpb: 0.6912, params_m: 10.9, budget_s: 300 },
    limits: { max_prompt_chars: 200, max_new_bytes: 200 }, notice: talk.RESEARCH_TALK_NOTICE, default_prompt: 'Once upon a time',
  })
  assert.deepEqual(storyBox.describeStoryModel(info), {
    title: 'The research loop\'s best story model (epoch 81, val_bpb 0.6912, self-reported)',
    about: 'A tiny model trained from scratch on children\'s stories in five minutes. It only writes story-like text. It has about 11 million parameters and reads and writes one byte at a time.',
    note: '',
  })
  assert.equal(storyBox.describeStoryModel({ ...info, bestEpoch: 90 }).note, 'The loop has since kept a better run (epoch 90). Its model could not be saved or loaded, so this is the last one that could.')
  assert.equal(storyBox.describeStoryModel({ ...info, bestEpoch: 90 }).title, 'The research loop\'s story model (epoch 81, val_bpb 0.6912, self-reported)')
  assert.equal(storyBox.describeStoryModel({ ...info, bestEpoch: 81 }).title, 'The research loop\'s best story model (epoch 81, val_bpb 0.6912, self-reported)')
  assert.equal(storyBox.describeStoryModel({ ...info, newest: { epoch: 90, checked: false } }).note, 'A newer model has just been saved and the lab is trying it out.')
  const owner = storyBox.parseStoryInfo({ model: { source: 'owner_rerun', epoch: 7, val_bpb: 0.71, budget_s: 300 } })
  assert.equal(owner.model.epoch, null)
  assert.equal(storyBox.describeStoryModel(owner).title, 'The research loop\'s training code, run once more by the owner (val_bpb 0.7100, self-reported)')
  // Nothing saved, a save still being tried, and a save that could not be loaded.
  const none = storyBox.parseStoryInfo({ enabled: true, model: null })
  assert.match(storyBox.describeStoryModel(none).about, /^No story model has been saved yet\./)
  assert.match(storyBox.describeStoryModel(storyBox.parseStoryInfo({ model: null, newest: { epoch: 90, checked: false } })).about, /^A model has just been saved and the lab is trying it out\./)
  assert.match(storyBox.describeStoryModel(storyBox.parseStoryInfo({ model: null, newest: { epoch: 90, checked: true } })).about, /could not load it again to write/)
  // Strictly read.
  const junk = storyBox.parseStoryInfo({ model: { source: '<img>', epoch: 1 }, best_epoch: 'x', limits: { max_prompt_chars: -5 }, default_prompt: 7 })
  assert.deepEqual(junk, { model: null, bestEpoch: null, newest: null, maxPromptChars: 200, defaultPrompt: 'Once upon a time', notice: null })
  const strange = storyBox.parseStoryInfo({ model: { source: 'epoch', epoch: 1.5, val_bpb: 1e9, params_m: -1, budget_s: 1e9 } })
  assert.deepEqual(strange.model, { source: 'epoch', epoch: null, valBpb: null, paramsM: null, budgetS: null })
  assert.equal(storyBox.describeStoryModel(strange).title, 'The research loop\'s training code, run once more by the owner (no score recorded)')
})

test('the story box asks for nothing until the room says stories are on, and the panel shows its button for either part', async () => {
  const element = () => {
    const el = { style: {}, classList: { add(c) { el.classes.add(c) }, remove(c) { el.classes.delete(c) } }, classes: new Set() }
    return new Proxy(el, {
      get: (t, k) => (k in t ? t[k] : k === 'querySelector' ? () => element() : () => undefined),
      set: (t, k, v) => { t[k] = v; return true },
    })
  }
  const timers = new Map()
  let nextTimer = 1
  const page = { document: globalThis.document, window: globalThis.window }
  const made = []
  globalThis.document = { createElement: () => { const el = element(); made.push(el); return el }, body: element() }
  globalThis.window = { setInterval: (fn, ms) => { timers.set(nextTimer, { fn, ms }); return nextTimer++ }, clearInterval: id => { timers.delete(id) } }
  const asked = []
  let story = { enabled: true, model: { key: KEY, source: 'epoch', epoch: 81, val_bpb: 0.69, params_m: 10.9, budget_s: 300 }, limits: { max_prompt_chars: 200 } }
  let chat = { enabled: true, adapters: [] }
  globalThis.fetch = async (url, options = {}) => {
    asked.push([options.method ?? 'GET', String(url)])
    return new Response(JSON.stringify(String(url).endsWith('research-talk') ? story : chat), { headers: { 'content-type': 'application/json' } })
  }
  const settle = () => new Promise(r => setTimeout(r, 5))
  try {
    // A panel with no story box attached behaves as it always did.
    const bare = new chatPanel.TrainedChatPanel()
    bare.setStoryAvailable(true)
    await settle()
    assert.deepEqual(asked, [])

    made.length = 0
    const panel = new chatPanel.TrainedChatPanel()
    const container = made[0]
    const panelElement = made[3]
    panel.attachStory(onChange => new storyBox.ResearchStoryBox(onChange))
    panel.setStoryAvailable(false)
    panel.setAvailable(false)
    await settle()
    assert.deepEqual([asked.length, timers.size, container.style.display], [0, 0, 'none'])

    // Stories on, chat off: one request, no timer, the button is shown and the chat's parts are hidden.
    panel.setStoryAvailable(true)
    panel.setStoryAvailable(true)
    await settle()
    assert.deepEqual(asked, [['GET', '/api/experiment/research-talk']])
    assert.deepEqual([timers.size, container.style.display, panelElement.classes.has('tc-chat-off')], [0, '', true])

    // The chat comes on too: its own request and timer, and its parts are shown.
    panel.setAvailable(true)
    await settle()
    assert.deepEqual(asked.at(-1), ['GET', '/api/experiment/trained-chat'])
    assert.deepEqual([timers.size, container.style.display, panelElement.classes.has('tc-chat-off')], [1, '', false])

    // Stories off again: nothing more is asked of that route, and the chat stays.
    const before = asked.length
    panel.setStoryAvailable(false)
    await settle()
    assert.deepEqual([asked.length, container.style.display], [before, ''])
    // The chat off too: the button goes.
    panel.setAvailable(false)
    await settle()
    assert.deepEqual([timers.size, container.style.display], [0, 'none'])

    // On again, but the route itself answers that stories are off: it stops asking.
    story = { enabled: false, model: null }
    panel.setStoryAvailable(true)
    await settle()
    const after = asked.length
    panel.setStoryAvailable(true)
    await settle()
    assert.deepEqual([asked.length, container.style.display], [after, 'none'])
  } finally {
    globalThis.document = page.document
    globalThis.window = page.window
  }
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
  assert.match(main, /this\.trainedChat\?\.setStoryAvailable\(\(state as unknown as \{ research_talk_enabled\?: unknown \}\)\.research_talk_enabled === true\)/)
  assert.match(main, /this\.trainedChat\.attachStory\(onChange => new ResearchStoryBox\(onChange\)\)/)
})

test('visitor text has no dashes, model text is never written as markup, and the box says what the model is', () => {
  for (const file of ['src/systems/ResearchStoryBox.ts', 'api/_lib/research-talk.ts', 'api/experiment/research-talk.ts', 'api/_lib/research-prompts.ts']) {
    const source = readFileSync(join(root, file), 'utf8')
    const mine = file.endsWith('research-prompts.ts') ? source.slice(source.indexOf('export const STORY_MODEL_NOTE'), source.indexOf('export function getResearchSharedContext')) : source
    assert.equal(/[\u2014\u2013]/.test(mine), false, `${file} has a dash that visitors or models would see`)
  }
  const source = readFileSync(join(root, 'src/systems/ResearchStoryBox.ts'), 'utf8')
  assert.equal(/innerHTML\s*=\s*(?!['`])\S/.test(source), false)
  assert.equal(/setInterval\(/.test(source), false)
  assert.match(source, /A tiny model trained from scratch on children's stories in/)
  assert.match(source, /It only writes story-like text\./)
  assert.match(talk.RESEARCH_TALK_NOTICE, /nobody reviews what it writes/)
  const panel = readFileSync(join(root, 'src/systems/TrainedChatPanel.ts'), 'utf8')
  assert.match(panel, /\.tc-story-input \{[^}]*min-height: 44px;[^}]*font-family: inherit; font-size: 16px;/)
})

// ===========================================================================
// 5. The documents
// ===========================================================================
test('the documents state the switch, the limits and the owner\'s steps as the code has them', () => {
  const tools = readFileSync(join(root, 'docs/TOOLS.md'), 'utf8')
  const ops = readFileSync(join(root, 'docs/OPERATIONS.md'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  const runner = readFileSync(join(root, 'modal/research_runner.py'), 'utf8')
  for (const name of ['LAB_ENABLE_RESEARCH_TALK', 'RESEARCH_RUNNER_MODELS_URL', 'LAB_RESEARCH_TALK_DAILY', 'LAB_RESEARCH_TALK_MAX_NEW', 'LAB_RESEARCH_TALK_USD_PER_STORY']) {
    for (const [doc, text] of [['TOOLS.md', tools], ['OPERATIONS.md', ops], ['.env.example', env]]) assert.ok(text.includes(name), `${name} in ${doc}`)
  }
  for (const line of ['LAB_ENABLE_RESEARCH_TALK=false', 'RESEARCH_RUNNER_MODELS_URL=', `LAB_RESEARCH_TALK_DAILY=${talk.DEFAULT_RESEARCH_TALK_DAILY}`,
    `LAB_RESEARCH_TALK_MAX_NEW=${talk.DEFAULT_RESEARCH_TALK_MAX_NEW}`, `LAB_RESEARCH_TALK_USD_PER_STORY=${talk.DEFAULT_RESEARCH_TALK_USD_PER_STORY}`]) {
    assert.ok(env.split('\n').includes(line), `${line} in .env.example`)
  }
  for (const row of ['| `LAB_ENABLE_RESEARCH_TALK` | false |', `| \`LAB_RESEARCH_TALK_DAILY\` | ${talk.DEFAULT_RESEARCH_TALK_DAILY} |`,
    `| \`LAB_RESEARCH_TALK_MAX_NEW\` | ${talk.DEFAULT_RESEARCH_TALK_MAX_NEW} |`, `| \`LAB_RESEARCH_TALK_USD_PER_STORY\` | ${talk.DEFAULT_RESEARCH_TALK_USD_PER_STORY} |`]) {
    assert.ok(ops.includes(row), `${row} in OPERATIONS.md`)
  }
  for (const heading of ['## The research model talks']) assert.ok(tools.includes(heading), heading)
  assert.ok(ops.includes('## Stories from the research model'))
  // The owner's steps: the exact deploy command, the hand-run training, and the Volume.
  assert.ok(ops.includes('uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/research_runner.py'))
  assert.ok(ops.includes('uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal run modal/research_runner.py::keep_current --train-py'))
  assert.ok(ops.includes('modal run modal/research_runner.py::list_kept'))
  const volume = /MODELS_VOLUME_NAME = "([a-z-]+)"/.exec(runner)[1]
  for (const text of [tools, ops, env]) assert.ok(text.includes(volume), volume)
  // The numbers the documents give are the ones in the code.
  const constant = name => Number(new RegExp(`^${name} = ([0-9* ]+)`, 'm').exec(runner)[1].split('*').reduce((a, b) => a * Number(b), 1))
  assert.equal(constant('SAMPLE_DEFAULT_NEW'), talk.DEFAULT_RESEARCH_TALK_MAX_NEW)
  assert.equal(constant('SAMPLE_HARD_NEW'), talk.RESEARCH_TALK_HARD_MAX_NEW)
  assert.equal(constant('PROMPT_MAX_CHARS'), talk.RESEARCH_TALK_MAX_PROMPT_CHARS)
  assert.ok(tools.includes(`${constant('KEEP_MAX_BYTES') / 1024 / 1024} MB`))
  assert.ok(tools.includes(`${talk.RESEARCH_TALK_PER_WINDOW} stories in ten minutes and ${talk.RESEARCH_TALK_PER_DAY} in a day`))
  assert.ok(tools.includes(`${talk.RESEARCH_TALK_ADDRESS_PER_WINDOW} and ${talk.RESEARCH_TALK_ADDRESS_PER_DAY}`))
  assert.ok(tools.includes(`the newest ${constant('KEPT_MAX')} kept models`))
  assert.ok(ops.includes('a boundary for the research scores'))
  const routes = []
  const walk = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== '_lib') walk(join(directory, entry.name)) } else if (entry.name.endsWith('.ts')) routes.push(entry.name)
    }
  }
  walk('api')
  assert.ok(ops.includes(`the project now has ${routes.length};`), `OPERATIONS.md should say the project has ${routes.length} functions`)
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
  assert.equal(vercel.functions['api/experiment/research-talk.ts'].maxDuration, 120)
  assert.ok(talk.RESEARCH_TALK_TIMEOUT_MS < 120_000)
})
