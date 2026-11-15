// Run 2 behaviour: model panel and request parameters, real cost and the spend
// ledger, the daily budget, cadence, the atomic epoch claim, validated model
// output, one contribution per epoch, growth, reset and commit authors.
//
// No network, no database, no secrets: fetch is a fake that answers like
// OpenRouter and GitHub, and `@vercel/postgres` is swapped for an in-memory
// fake that understands the queries the lab makes.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-run2-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')

// ---------------------------------------------------------------------------
// Fake SQL layer
// ---------------------------------------------------------------------------
const FAKE_PG = join(build, 'fake-postgres.js')
writeFileSync(FAKE_PG, `
export const db = { handler: null, log: [] }
export function sql(strings, ...values) {
  const text = (Array.isArray(strings) ? strings.join('?') : String(strings)).replace(/\\s+/g, ' ').trim()
  db.log.push({ text, values })
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
const originalWarn = console.warn
const originalLog = console.log
const originalError = console.error
after(() => {
  process.env = originalEnv
  globalThis.fetch = originalFetch
  console.warn = originalWarn
  console.log = originalLog
  console.error = originalError
  rmSync(build, { recursive: true, force: true })
})

for (const name of Object.keys(process.env)) {
  if (/^(OPENROUTER|POSTGRES|LAB_|AI_AGENT|RESEARCH_|SPRITES|MODAL|EPOCH_|NORTH_)/.test(name)) delete process.env[name]
}
const CRON = 'test-only-scheduler-secret-000000000000000'
const OPERATOR = 'test-only-operator-secret-0000000000000000'
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder' // read once at import
process.env.CRON_SECRET = CRON
process.env.LAB_OPERATOR_SECRET = OPERATOR
process.env.AI_AGENT_GITHUB_TOKEN = 'test-only-not-a-provider-token'
process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'

// Quiet logs, but keep them for assertions.
let logs = []
const capture = (...args) => logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = capture
console.log = capture
console.error = capture

const load = path => import(pathToFileURL(join(build, path)).href)
const { db } = await import(fakePgUrl)
const openrouter = await load('api/_lib/openrouter.js')
const spend = await load('api/_lib/spend.js')
const claim = await load('api/_lib/epoch-claim.js')
const runner = await load('api/_lib/epoch-runner.js')
const growth = await load('api/_lib/growth.js')
const output = await load('api/_lib/model-output.js')
const identity = await load('api/_lib/commit-identity.js')
const types = await load('api/_lib/types.js')
const prompts = await load('api/_lib/prompts.js')
const researchPrompts = await load('api/_lib/research-prompts.js')
const logger = await load('api/_lib/research-logger.js')
const research = await load('api/_lib/research.js')
const followups = await load('api/_lib/epoch-followup.js')
const activityLib = await load('api/_lib/activity.js')

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------
const JSON_COLUMNS = new Set(['current_spec', 'role_assignments', 'spec_before', 'spec_after', 'plant_geometry',
  'planner_output', 'executor_output', 'challenger_output', 'executor_rebuttal', 'reviewer_output',
  'commentator_output', 'research_run', 'log_data', 'files', 'subagent_files', 'web_searches', 'web_sources', 'followup'])
const decode = (col, v) => (JSON_COLUMNS.has(col) && typeof v === 'string' ? JSON.parse(v) : v)
let nextId = 1
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`

function literal(expr, take) {
  if (expr === '?') return take()
  if (expr === 'TRUE' || expr === 'true') return true
  if (expr === 'FALSE' || expr === 'false') return false
  if (expr === 'NULL') return null
  if (expr === 'NOW()') return new Date()
  const q = expr.match(/^'(.*)'$/)
  if (q) return q[1]
  throw new Error(`fake db: unsupported expression ${expr}`)
}

class FakeLab {
  constructor() {
    this.experiments = []
    this.epochs = []
    this.modelCalls = []
    this.conflicts = []
    this.mutations = []
    this.epochLogs = []
    this.contributions = []
    this.queries = []
    this.spendError = false
  }

  addExperiment(row) {
    const exp = {
      id: uuid(), created_at: new Date(Date.now() - 1000 * (100 - this.experiments.length)),
      status: 'growing', current_epoch: 0, epoch_in_progress: false, epoch_started_at: null,
      glass_shattered: false, current_spec: classicSpec(), ...row,
    }
    this.experiments.push(exp)
    return exp
  }

  // UPDATE experiments ... with a WHERE made of the conditions the lab uses.
  updateExperiments(text, values) {
    const m = text.match(/^UPDATE experiments SET (.*?)(?: WHERE (.*?))?(?: RETURNING (.*))?$/)
    let i = 0
    const take = () => values[i++]
    const sets = m[1].split(', ').map(pair => {
      const [col, expr] = pair.split(' = ')
      return [col.trim(), literal(expr.trim(), take)]
    })
    const conds = (m[2] || '').split(' AND ').filter(Boolean).map(c => {
      c = c.trim()
      if (c === 'id = ?') { const v = take(); return e => e.id === v }
      if (c === 'epoch_in_progress IS NOT TRUE') return e => e.epoch_in_progress !== true
      if (c === 'epoch_in_progress = TRUE') return e => e.epoch_in_progress === true
      if (c === "status <> 'archived'") return e => e.status !== 'archived'
      if (c === 'current_epoch < ?') { const v = take(); return e => e.current_epoch < v }
      if (c === '(epoch_started_at IS NULL OR epoch_started_at < ?)') {
        const v = new Date(take()); return e => !e.epoch_started_at || new Date(e.epoch_started_at) < v
      }
      throw new Error(`fake db: unsupported condition ${c}`)
    })
    const hit = this.experiments.filter(e => conds.every(f => f(e)))
    for (const e of hit) for (const [col, v] of sets) e[col] = decode(col, v)
    return { rows: m[3] ? hit.map(e => ({ id: e.id, current_epoch: e.current_epoch })) : [] }
  }

  updateEpochs(text, values) {
    const m = text.match(/^UPDATE epochs SET (.*) WHERE id = \?$/)
    if (!m) return { rows: [] }
    let i = 0
    const take = () => values[i++]
    const sets = m[1].split(', ').map(pair => {
      const [col, expr] = pair.split(' = ')
      return [col.trim(), literal(expr.trim(), take)]
    })
    const id = values[i]
    const ep = this.epochs.find(e => e.id === id)
    if (ep) for (const [col, v] of sets) ep[col] = decode(col, v)
    return { rows: [] }
  }

  handle(text, v) {
    this.queries.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }

    // Spend ledger
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, reasoning_tokens] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, reasoning_tokens, created_at: new Date() })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) {
      if (this.spendError) throw new Error('ledger down')
      const since = new Date(v[0])
      const total = this.modelCalls.filter(c => c.created_at >= since).reduce((s, c) => s + c.cost_usd, 0)
      return { rows: [{ total: String(total) }] }
    }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number = ?')) {
      const rows = this.modelCalls.filter(c => c.experiment_id === v[0] && c.epoch_number === v[1])
      const sum = k => rows.reduce((s, c) => s + c[k], 0)
      return { rows: [{ cost_usd: sum('cost_usd'), prompt_tokens: sum('prompt_tokens'), completion_tokens: sum('completion_tokens') }] }
    }

    // Experiments
    if (text.startsWith('UPDATE experiments')) return this.updateExperiments(text, v)
    if (text.startsWith('SELECT * FROM experiments WHERE id = ?') || text.startsWith('SELECT id, current_epoch, current_spec, glass_shattered FROM experiments WHERE id = ?')) {
      return { rows: this.experiments.filter(e => e.id === v[0]) }
    }
    if (/FROM experiments e? ?WHERE e?\.?status <> 'archived' ORDER BY (e\.)?created_at DESC LIMIT 1/.test(text) || text.startsWith("SELECT id FROM experiments WHERE status <> 'archived'") || text.startsWith("SELECT * FROM experiments WHERE status <> 'archived'")) {
      const active = this.experiments.filter(e => e.status !== 'archived').sort((a, b) => b.created_at - a.created_at)
      return {
        rows: active.slice(0, 1).map(e => {
          const own = this.epochs.filter(p => p.experiment_id === e.id).sort((a, b) => b.epoch_number - a.epoch_number)
          return { ...e, last_epoch_at: own[0]?.completed_at ?? null, recent_epochs: own.slice(0, 5) }
        }),
      }
    }
    if (text.startsWith("SELECT e.*, (SELECT json_agg")) {
      const active = this.experiments.filter(e => e.status !== 'archived').sort((a, b) => b.created_at - a.created_at)
      return { rows: active.slice(0, 1).map(e => ({ ...e, recent_epochs: this.epochs.filter(p => p.experiment_id === e.id) })) }
    }
    if (text.startsWith('INSERT INTO experiments')) {
      const exp = { id: uuid(), created_at: new Date(), status: 'seeding', current_spec: JSON.parse(v[0]), current_epoch: 0, epoch_in_progress: false, epoch_started_at: null, glass_shattered: false }
      this.experiments.push(exp)
      return { rows: [{ id: exp.id }] }
    }

    // Epochs
    if (text.includes("followup->>'status' IN ('pending', 'awaiting_ci')")) {
      const rows = this.epochs.filter(e => e.experiment_id === v[0] && e.spec_after && ['pending', 'awaiting_ci'].includes(e.followup?.status))
        .sort((a, b) => a.epoch_number - b.epoch_number).slice(0, 1).map(e => ({ epoch_number: e.epoch_number }))
      return { rows }
    }
    if (text.startsWith('SELECT MAX(epoch_number) AS n FROM epochs')) {
      const own = this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number > 0)
      return { rows: [{ n: own.length ? Math.max(...own.map(e => e.epoch_number)) : null }] }
    }
    if (text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND epoch_number BETWEEN ? AND ?')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number >= v[1] && e.epoch_number <= v[2]).sort((a, b) => a.epoch_number - b.epoch_number) }
    }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number BETWEEN ? AND ? GROUP BY')) {
      const groups = new Map()
      for (const c of this.modelCalls.filter(c => c.experiment_id === v[0] && c.epoch_number >= v[1] && c.epoch_number <= v[2])) {
        const key = `${c.epoch_number}|${c.model_id}|${c.purpose}`
        const g = groups.get(key) ?? { epoch_number: c.epoch_number, model_id: c.model_id, purpose: c.purpose, requests: 0, cost_usd: 0, prompt_tokens: 0, completion_tokens: 0 }
        g.requests++; g.cost_usd += c.cost_usd; g.prompt_tokens += c.prompt_tokens; g.completion_tokens += c.completion_tokens
        groups.set(key, g)
      }
      return { rows: [...groups.values()] }
    }
    if (text.includes('FROM code_contributions WHERE experiment_id = ? AND epoch_number BETWEEN')) {
      return { rows: this.contributions.filter(c => c.experiment_id === v[0]).map(c => ({ ...c, author_name: 'Claude Fable 5.2' })) }
    }
    if (text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND epoch_number = ? LIMIT 1')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number === v[1]) }
    }
    if (text.startsWith('SELECT epoch_number, commentator_output FROM epochs')) return { rows: [] }
    if (text.startsWith('INSERT INTO epochs (experiment_id, epoch_number, role_assignments, spec_before) VALUES')) {
      const ep = { id: uuid(), experiment_id: v[0], epoch_number: v[1], role_assignments: JSON.parse(v[2]), spec_before: JSON.parse(v[3]), started_at: new Date(), completed_at: null, cost_usd: 0 }
      this.epochs.push(ep)
      return { rows: [{ id: ep.id }] }
    }
    if (text.startsWith('INSERT INTO epochs')) {
      // The seed epoch: epoch_number is the literal 0 in the SQL.
      const ep = { id: uuid(), experiment_id: v[0], epoch_number: 0, role_assignments: JSON.parse(v[1]), spec_before: JSON.parse(v[2]), spec_after: JSON.parse(v[3]), plant_geometry: JSON.parse(v[4]), completed_at: new Date() }
      this.epochs.push(ep)
      return { rows: [] }
    }
    if (text.startsWith('UPDATE epochs')) return this.updateEpochs(text, v)

    // Records
    if (text.startsWith('INSERT INTO conflicts')) {
      const [experiment_id, detected_epoch, element_a, element_b, description, severity, spec_conflict_id] = v
      if (!['critical', 'warning', 'note'].includes(severity)) throw new Error('violates check constraint "conflicts_severity_check"')
      this.conflicts.push({ experiment_id, detected_epoch, element_a, element_b, description, severity, spec_conflict_id, resolved_epoch: null })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE conflicts SET resolved_epoch = ?')) {
      const [epoch, experimentId, specId, detected, a, b] = v
      for (const c of this.conflicts) {
        if (c.experiment_id !== experimentId || c.resolved_epoch !== null) continue
        if (c.spec_conflict_id === specId || (!c.spec_conflict_id && c.detected_epoch === detected && c.element_a === a && c.element_b === b)) c.resolved_epoch = epoch
      }
      return { rows: [] }
    }
    if (text.startsWith('INSERT INTO mutations')) {
      const [epoch_id, mutation_index, type, target, path, model_id, approved, reason] = v
      if (!['add', 'modify', 'remove'].includes(type)) throw new Error('violates check constraint "mutations_type_check"')
      if (target === null || target === undefined) throw new Error('null value in column "target"')
      this.mutations.push({ epoch_id, mutation_index, type, target, path, model_id, approved, reason })
      return { rows: [] }
    }
    if (text.startsWith('INSERT INTO epoch_logs')) {
      this.epochLogs.push({ experiment_id: v[0], epoch_number: v[1], text })
      return { rows: [] }
    }
    if (text.startsWith('INSERT INTO code_contributions')) {
      this.contributions.push({ experiment_id: v[0], epoch_number: v[1], model_id: v[2], branch: v[4], merged: v[6] })
      return { rows: [] }
    }
    if (text.includes('FROM code_contributions WHERE experiment_id = ?') && text.includes('COUNT(*)')) {
      return { rows: [{ merged: 0, tested: 0, sprite: 0 }] }
    }
    return { rows: [] }
  }
}

let lab
beforeEach(() => {
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  logs = []
  openrouter.resetModelCatalog()
  delete process.env.LAB_ENABLE_CODE_WRITES
  delete process.env.LAB_DAILY_BUDGET_USD
  delete process.env.EPOCH_INTERVAL_MINUTES
  delete process.env.EPOCH_STALE_MINUTES
})

function classicSpec(extra = {}) {
  return {
    identity: { purpose: 'test agent', domain: null },
    capabilities: [], constraints: [], behaviors: [],
    conflicts: [{ id: 'conflict_3_0', element_a: 'capabilities.a', element_b: 'constraints.b', description: 'old', severity: 'warning', detected_epoch: 3, resolved: false }],
    meta: { stability_score: 0.5, growth_stage: 'sprout', total_epochs: 3, total_mutations: 0, total_prunings: 0 },
    ...extra,
  }
}

function response() {
  return {
    code: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}

// ---------------------------------------------------------------------------
// Fake OpenRouter
// ---------------------------------------------------------------------------
const CATALOG = {
  data: [
    { id: 'anthropic/claude-fable-5.2', supported_parameters: ['max_tokens', 'max_completion_tokens', 'reasoning', 'response_format', 'tools'], reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 128000 }, pricing: { prompt: '0.000008', completion: '0.00004' } },
    { id: 'openai/gpt-6-astra', supported_parameters: ['max_tokens', 'reasoning', 'response_format'], reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 128000 }, pricing: { prompt: '0.00001', completion: '0.00005' } },
    { id: 'google/gemini-4-hydrogen', supported_parameters: ['max_tokens', 'reasoning', 'response_format', 'temperature'], reasoning: { supported_efforts: ['xhigh', 'high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 943718 }, pricing: { prompt: '0.0000015', completion: '0.0000075' } },
    { id: 'deepseek/deepseek-v4-pro-0813', supported_parameters: ['max_tokens', 'reasoning', 'response_format', 'temperature'], reasoning: { supported_efforts: ['max', 'high', 'low', 'none'] }, top_provider: { max_completion_tokens: 943718 }, pricing: { prompt: '0.000000111', completion: '0.00000444' } },
    { id: 'x-ai/grok-4.7', supported_parameters: ['max_tokens', 'reasoning', 'response_format', 'temperature'], reasoning: { supported_efforts: ['xhigh', 'high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 450000 }, pricing: { prompt: '0.000002', completion: '0.000006' } },
    { id: 'cohere/north-mini-code:free', supported_parameters: ['max_tokens', 'reasoning', 'temperature'], reasoning: { mandatory: false }, top_provider: { max_completion_tokens: 64000 }, pricing: { prompt: '0', completion: '0' } },
    { id: 'z-ai/glm-5.3-prime', supported_parameters: ['max_tokens', 'reasoning', 'response_format', 'temperature'], reasoning: { supported_efforts: ['max', 'high', 'low'] }, top_provider: { max_completion_tokens: 131072 }, pricing: { prompt: '0.0000028', completion: '0.0000088' } },
    { id: 'anthropic/claude-sonnet-5.5', supported_parameters: ['max_tokens', 'reasoning', 'response_format'], reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 128000 }, pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'google/gemini-3.8-flash', supported_parameters: ['max_tokens', 'reasoning', 'response_format', 'temperature'], reasoning: { supported_efforts: ['high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 65536 }, pricing: { prompt: '0.000000825', completion: '0.000004125' } },
  ],
}

const completion = (model, content, usage = { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 }) =>
  new Response(JSON.stringify({ model, choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage }))

/**
 * A fake fetch. `answer(body, request)` decides each chat completion; every
 * request is recorded with its options so tests can check the signal.
 */
function fakeFetch(answer, { github } = {}) {
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    requests.push({ url: target, method, body, signal: options.signal })
    if (target === 'https://openrouter.ai/api/v1/models') return new Response(JSON.stringify(CATALOG))
    if (target === 'https://openrouter.ai/api/v1/chat/completions') return answer(body, requests)
    if (target.startsWith('https://api.github.com') && github) return github(target, method, body)
    throw new Error(`Unexpected request ${method} ${target}`)
  }
  return requests
}

// ===========================================================================
// 1. Model panel
// ===========================================================================
test('the panel is the newest flagship from each lab, one per lab, with the chosen fallbacks', () => {
  assert.deepEqual([...types.MODELS], [
    'google/gemini-4-hydrogen', 'deepseek/deepseek-v4-pro-0813', 'anthropic/claude-fable-5.2', 'openai/gpt-6-astra', 'x-ai/grok-4.7',
  ])
  const labs = types.MODELS.map(id => id.split('/')[0])
  assert.equal(new Set(labs).size, 5)
  assert.deepEqual(Object.values(types.MODEL_DISPLAY_NAMES), ['Gemini 4', 'DeepSeek V4 Pro', 'Claude Fable 5.2', 'GPT-6 Astra', 'Grok 4.7'])
  assert.deepEqual([...types.FALLBACK_MODELS], ['anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash'])
  assert.deepEqual(types.WILDCARD_MODELS, { north: 'cohere/north-mini-code:free', glm: 'z-ai/glm-5.3-prime' })
  assert.deepEqual(types.WILDCARD_DISPLAY_NAMES, { north: 'North', glm: 'GLM 5.3' })

  // The frontend copy matches the backend copy.
  const front = readFileSync(join(root, 'src/shared/types.ts'), 'utf8')
  for (const id of [...types.MODELS, ...types.FALLBACK_MODELS, ...Object.values(types.WILDCARD_MODELS)]) assert.ok(front.includes(`'${id}'`), id)

  // No old id is left anywhere in code, prompts or the model docs.
  const OLD = /gemini-3\.5-flash|deepseek-v4-pro'|claude-opus-4\.8|gpt-5\.5|grok-4\.3|glm-5\.2|poolside|laguna/
  const offenders = []
  const scan = dir => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.(ts|mjs|md)$/.test(entry.name) && OLD.test(readFileSync(join(root, path), 'utf8'))) offenders.push(path)
    }
  }
  scan('api'); scan('src'); scan('tests')
  // modelLabels.ts maps provider prefixes of archived run 1 records to plain names; it names no model.
  offenders.splice(0, offenders.length, ...offenders.filter(p => p !== join('src', 'systems', 'modelLabels.ts')))
  if (OLD.test(readFileSync(join(root, 'CLAUDE.md'), 'utf8'))) offenders.push('CLAUDE.md')
  assert.deepEqual(offenders.filter(p => !p.endsWith('run2.test.mjs')), [])
})

test('each model gets only the parameters its catalog entry lists, at medium effort', async () => {
  const bodies = {}
  fakeFetch(body => {
    bodies[body.model] = body
    return completion(body.model, { ok: true })
  })
  for (const id of [...types.MODELS, ...Object.values(types.WILDCARD_MODELS)]) {
    await openrouter.callModel(id, 'system', 'user', { noFallback: true })
  }
  const claude = bodies['anthropic/claude-fable-5.2']
  assert.equal('temperature' in claude, false) // Anthropic: no temperature
  assert.deepEqual(claude.reasoning, { effort: 'medium' })
  assert.equal(claude.max_tokens, 32000) // 16000 answer + room for medium reasoning
  assert.equal('response_format' in claude, false) // first attempt, not OpenAI
  assert.equal('usage' in claude, false) // deprecated flag not sent; usage.cost always comes back

  const gpt = bodies['openai/gpt-6-astra']
  assert.equal('temperature' in gpt, false) // OpenAI: no temperature
  assert.deepEqual(gpt.reasoning, { effort: 'medium' })
  assert.deepEqual(gpt.response_format, { type: 'json_object' })

  assert.equal(bodies['google/gemini-4-hydrogen'].temperature, 0.7)
  assert.deepEqual(bodies['google/gemini-4-hydrogen'].reasoning, { effort: 'medium' })
  assert.deepEqual(bodies['x-ai/grok-4.7'].reasoning, { effort: 'medium' })
  // No "medium" listed: the nearest level, the lower one on a tie.
  assert.deepEqual(bodies['deepseek/deepseek-v4-pro-0813'].reasoning, { effort: 'low' })
  assert.deepEqual(bodies['z-ai/glm-5.3-prime'].reasoning, { effort: 'low' })

  const north = bodies['cohere/north-mini-code:free']
  assert.equal('reasoning' in north, false) // no effort selection exposed
  assert.equal(north.max_tokens, 16000)
  assert.equal(north.temperature, 0.7)

  // North never gets response_format, even on a strict-JSON retry.
  const strict = openrouter.buildRequestBody('cohere/north-mini-code:free', await openrouter.getModelCapabilities('cohere/north-mini-code:free'), 's', 'u', { jsonOnly: true, webSearch: false })
  assert.equal('response_format' in strict, false)
  const claudeStrict = openrouter.buildRequestBody('anthropic/claude-fable-5.2', await openrouter.getModelCapabilities('anthropic/claude-fable-5.2'), 's', 'u', { jsonOnly: true, webSearch: false, maxTokens: 28000 })
  assert.deepEqual(claudeStrict.response_format, { type: 'json_object' })
  assert.equal(claudeStrict.max_tokens, 56000)

  // An unknown model gets the bare minimum.
  assert.deepEqual(Object.keys(openrouter.buildRequestBody('someone/new', null, 's', 'u', { jsonOnly: false, webSearch: false })).sort(), ['max_tokens', 'messages', 'model'])
})

test('effort selection follows the catalog', () => {
  assert.equal(openrouter.pickEffort(['max', 'xhigh', 'high', 'medium', 'low']), 'medium')
  assert.equal(openrouter.pickEffort(['max', 'high', 'low', 'none']), 'low')
  assert.equal(openrouter.pickEffort(['max', 'high']), 'high')
  assert.equal(openrouter.pickEffort(['none']), undefined)
  assert.equal(openrouter.pickEffort(null), 'medium')
  assert.equal(openrouter.pickEffort(undefined), undefined)
})

test('without the live catalog the built-in snapshot still keeps forbidden parameters out', async () => {
  const bodies = []
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/models')) throw new Error('offline')
    const body = JSON.parse(options.body)
    bodies.push(body)
    return completion(body.model, { ok: true })
  }
  await openrouter.callModel('openai/gpt-6-astra', 's', 'u', { noFallback: true })
  assert.equal('temperature' in bodies[0], false)
  assert.deepEqual(bodies[0].reasoning, { effort: 'medium' })
})

// ===========================================================================
// 2. Real cost
// ===========================================================================
test('every billed attempt, retry and fallback is counted at its real usage.cost and written to the ledger', async () => {
  let n = 0
  fakeFetch(body => {
    n++
    // Grok answers twice with junk (billed), once with an error (not billed), then the fallback answers.
    if (body.model === 'x-ai/grok-4.7') {
      if (n <= 2) return completion(body.model, 'not json at all', { prompt_tokens: 1000, completion_tokens: 200, cost: 0.003 })
      return new Response('overloaded', { status: 503 })
    }
    return completion(body.model, { verdict: 'keep' }, { prompt_tokens: 1200, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 120 }, cost: 0.05 })
  })
  const result = await spend.withSpendContext({ experimentId: 'exp-cost', epochNumber: 7, purpose: 'epoch' }, () =>
    openrouter.callModel('x-ai/grok-4.7', 's', 'u'))
  assert.equal(result.servedBy.model, 'anthropic/claude-sonnet-5.5')
  assert.ok(Math.abs(result.cost - 0.056) < 1e-9, `cost ${result.cost}`)
  assert.deepEqual(result.usage, { prompt_tokens: 3200, completion_tokens: 700, reasoning_tokens: 120, requests: 3 })

  assert.equal(lab.modelCalls.length, 3)
  assert.deepEqual(lab.modelCalls.map(c => [c.model_id, c.assigned_model_id, c.cost_usd, c.cost_source]), [
    ['x-ai/grok-4.7', 'x-ai/grok-4.7', 0.003, 'usage'],
    ['x-ai/grok-4.7', 'x-ai/grok-4.7', 0.003, 'usage'],
    ['anthropic/claude-sonnet-5.5', 'x-ai/grok-4.7', 0.05, 'usage'],
  ])
  assert.ok(lab.modelCalls.every(c => c.experiment_id === 'exp-cost' && c.epoch_number === 7 && c.purpose === 'epoch'))
})

test('a refusal is not retried, skips the same lab\'s fallback, and its billed prompt still counts', async () => {
  const refusal = (model) => new Response(JSON.stringify({
    model, choices: [{ finish_reason: 'content_filter', native_finish_reason: 'refusal', message: { content: '' } }],
    usage: { prompt_tokens: 4000, completion_tokens: 0, cost: 0.032 },
  }))
  const asked = []
  fakeFetch(body => {
    asked.push(body.model)
    if (body.model.startsWith('anthropic/')) return refusal(body.model)
    return completion(body.model, { mutations: [] }, { prompt_tokens: 4000, completion_tokens: 500, cost: 0.004 })
  })
  const result = await spend.withSpendContext({ experimentId: 'exp-refusal', epochNumber: 1, purpose: 'epoch' }, () =>
    openrouter.callModel('anthropic/claude-fable-5.2', 's', 'u', { webSearch: true }))
  // One ask of the assigned model, no Anthropic fallback, straight to another lab.
  assert.deepEqual(asked, ['anthropic/claude-fable-5.2', 'google/gemini-3.8-flash'])
  assert.equal(result.servedBy.model, 'google/gemini-3.8-flash')
  assert.equal(result.servedBy.fallback, true)
  assert.ok(Math.abs(result.cost - 0.036) < 1e-9, `cost ${result.cost}`)
  assert.equal(result.usage.requests, 2)
  assert.deepEqual(lab.modelCalls.map(c => [c.model_id, c.cost_usd]), [
    ['anthropic/claude-fable-5.2', 0.032],
    ['google/gemini-3.8-flash', 0.004],
  ])

  // With no fallback allowed, a refusal fails after one billed ask.
  asked.length = 0
  await assert.rejects(openrouter.callModel('anthropic/claude-sonnet-5.5', 's', 'u', { noFallback: true }), /invalid response/)
  assert.deepEqual(asked, ['anthropic/claude-sonnet-5.5'])
})

test('the shared prompt asks for a short explanation, not the model\'s chain of thought', () => {
  for (const file of ['api/_lib/prompts.ts', 'api/_lib/research-prompts.ts']) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.doesNotMatch(source, /chain[- ]of[- ]thought/i, `${file} still asks for chain of thought`)
    assert.match(source, /not a transcript of your internal reasoning/, `${file} reasoning line`)
  }
})

test('a response without usage.cost is priced from the catalog, not at a flat rate', async () => {
  fakeFetch(body => completion(body.model, { ok: 1 }, { prompt_tokens: 1_000_000, completion_tokens: 100_000 }))
  const { cost } = await openrouter.callModel('anthropic/claude-fable-5.2', 's', 'u', { noFallback: true })
  assert.ok(Math.abs(cost - (8 + 4)) < 1e-6, `cost ${cost}`) // $8/M in + $40/M out
  assert.equal(lab.modelCalls[0].cost_source, 'estimate')
})

// ===========================================================================
// 3. Spend guard and cadence
// ===========================================================================
test('the daily budget sums the ledger for the current UTC day and defaults to $15', async () => {
  assert.equal(spend.dailyBudgetUsd(), 15)
  process.env.LAB_DAILY_BUDGET_USD = '2.5'
  assert.equal(spend.dailyBudgetUsd(), 2.5)
  process.env.LAB_DAILY_BUDGET_USD = 'lots'
  assert.equal(spend.dailyBudgetUsd(), 15)
  delete process.env.LAB_DAILY_BUDGET_USD

  const now = new Date('2026-11-13T23:30:00Z')
  lab.modelCalls.push({ cost_usd: 14.99, created_at: new Date('2026-11-13T01:00:00Z') })
  lab.modelCalls.push({ cost_usd: 50, created_at: new Date('2026-11-12T23:59:00Z') }) // yesterday
  let status = await spend.checkDailyBudget(now)
  assert.equal(status.allowed, true)
  assert.ok(Math.abs(status.spent_usd - 14.99) < 1e-9)
  const sumQuery = lab.queries.find(q => q.text.includes('FROM model_calls WHERE created_at >= ?'))
  assert.equal(sumQuery.values[0], '2026-11-13T00:00:00.000Z')

  lab.modelCalls.push({ cost_usd: 0.02, created_at: new Date('2026-11-13T02:00:00Z') })
  status = await spend.checkDailyBudget(now)
  assert.equal(status.allowed, false)
  assert.equal(status.reason, 'daily budget reached')
  assert.equal(status.resumes_at, '2026-11-14T00:00:00.000Z')
  assert.equal(spend.describeRunState({ status: 'growing', epoch_in_progress: false }, status).run_state, 'paused: daily budget reached')

  lab.spendError = true
  status = await spend.checkDailyBudget(now)
  assert.equal(status.allowed, false, 'an unreadable ledger fails closed')
})

test('cadence: 180 minutes from the end of the last epoch, with a 10 minute tolerance for the hourly cron', () => {
  assert.equal(claim.envEpochIntervalMinutes(), 180)
  assert.equal(claim.envEpochStaleMinutes(), 50)
  process.env.EPOCH_INTERVAL_MINUTES = '60'
  assert.equal(claim.envEpochIntervalMinutes(), 60)
  delete process.env.EPOCH_INTERVAL_MINUTES

  const ended = new Date('2026-11-13T12:08:00Z').getTime()
  const at = iso => new Date(iso).getTime()
  assert.equal(claim.epochCadence(ended, 180, at('2026-11-13T14:00:00Z')).due, false)
  assert.equal(claim.epochCadence(ended, 180, at('2026-11-13T15:00:00Z')).due, true) // 172 min: inside the tolerance
  assert.equal(claim.epochCadence(ended, 180, at('2026-11-13T14:57:00Z')).due, false) // 169 min
  assert.equal(claim.epochCadence(null, 180).due, true)
  assert.equal(claim.epochIntervalMinutes({ meta: { experiment_params: { epoch_interval_minutes: 90 } } }), 90)
  assert.equal(claim.epochIntervalMinutes({ meta: {} }), 180)
})

// ===========================================================================
// 4. Robustness
// ===========================================================================
test('the epoch claim is one conditional update: two concurrent claims, one winner', async () => {
  const exp = lab.addExperiment({})
  const [a, b] = await Promise.all([claim.claimEpoch(exp.id), claim.claimEpoch(exp.id)])
  assert.deepEqual([a, b].sort(), [false, true])
  const q = lab.queries.find(x => x.text.startsWith('UPDATE experiments SET epoch_in_progress = TRUE'))
  assert.match(q.text, /WHERE id = \? AND epoch_in_progress IS NOT TRUE AND status <> 'archived' RETURNING id$/)
  // A fresh claim is never cleared as stale; an old one is.
  assert.equal(await claim.clearStaleClaim(exp.id, 50), false)
  exp.epoch_started_at = new Date(Date.now() - 51 * 60_000)
  assert.equal(await claim.clearStaleClaim(exp.id, 50), true)
  assert.equal(exp.epoch_in_progress, false)
})

test('model output is clamped to the CHECK sets before it reaches an insert', () => {
  assert.equal(output.normalizeSeverity('HIGH'), 'critical')
  assert.equal(output.normalizeSeverity('note'), 'note')
  assert.equal(output.normalizeSeverity(undefined), 'warning')
  assert.equal(output.normalizeSeverity('catastrophic!!'), 'warning')
  assert.equal(output.normalizeMutationType('Create'), 'add')
  assert.equal(output.normalizeMutationType('delete'), 'remove')
  assert.equal(output.normalizeMutationType('rewrite-everything'), null)
  assert.equal(output.clampStability('0.72', 0.5), 0.72)
  assert.equal(output.clampStability(85, 0.5), 1)
  assert.equal(output.clampStability('n/a', 0.4), 0.4)
  const muts = output.sanitizeMutations([{ type: 'Add', target: 'capabilities', path: 3, value: 'x' }, 'junk'])
  assert.deepEqual(muts[0], { type: 'add', target: 'capabilities', path: '', value: {}, rationale: '' })
  assert.equal(muts[1].type, null)
  assert.deepEqual(output.sanitizeDecisions([{ mutation_index: 5, verdict: 'approve' }, { mutation_index: '1', verdict: 'APPROVE' }], 2).map(d => d.mutation_index), [1])
})

test('one contribution per epoch goes to the highest-value approved mutation', () => {
  const muts = output.sanitizeMutations([
    { type: 'add', target: 'constraints', path: 'constraints[new]', value: { id: 'c1' } },
    { type: 'add', target: 'capabilities', path: 'capabilities[new]', value: { id: 'cap1' } },
    { type: 'add', target: 'capabilities', path: 'capabilities[new]', value: { id: 'cap2' } },
    { type: 'remove', target: 'capabilities', path: 'capabilities.cap0', value: {} },
    { type: 'add', target: 'experiment_params', path: 'x', value: {} },
  ])
  const all = [0, 1, 2, 3, 4].map(i => ({ mutation_index: i, verdict: 'approve', reason: '', challenger_concern_addressed: false }))
  // cap1 has an open critical concern, so cap2 wins.
  const pick = output.pickContributionCandidate(muts, all, [{ mutation_index: 1, severity: 'critical', issue: 'x' }])
  assert.equal(pick.decision.mutation_index, 2)
  // Rejections and non-code targets never become contributions.
  assert.equal(output.pickContributionCandidate(muts, [{ ...all[1], verdict: 'reject' }, all[3], all[4]], []), null)
})

test('the resolved-conflict update matches the spec conflict id', async () => {
  // Covered end to end in the epoch test below; this checks old rows too.
  lab.conflicts.push({ experiment_id: 'e1', detected_epoch: 3, element_a: 'capabilities.a', element_b: 'constraints.b', severity: 'warning', spec_conflict_id: null, resolved_epoch: null })
  lab.handle('UPDATE conflicts SET resolved_epoch = ? WHERE experiment_id = ? AND resolved_epoch IS NULL AND ( spec_conflict_id = ? OR (spec_conflict_id IS NULL AND detected_epoch = ? AND element_a = ? AND element_b = ?) )', [9, 'e1', 'conflict_3_0', 3, 'capabilities.a', 'constraints.b'])
  assert.equal(lab.conflicts[0].resolved_epoch, 9)
})

test('epoch_logs is keyed per experiment, with a runtime migration off the old global key', async () => {
  await logger.ensureEpochLogsTable()
  const texts = lab.queries.map(q => q.text)
  assert.ok(texts.includes('ALTER TABLE epoch_logs ADD COLUMN IF NOT EXISTS experiment_id UUID'))
  assert.ok(texts.includes('ALTER TABLE epoch_logs DROP CONSTRAINT IF EXISTS epoch_logs_epoch_number_key'))
  assert.ok(texts.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_epoch_logs_experiment_epoch ON epoch_logs(experiment_id, epoch_number)'))
  const schema = readFileSync(join(root, 'api/_lib/schema.sql'), 'utf8')
  assert.doesNotMatch(schema, /epoch_number INTEGER UNIQUE/)
})

// A scripted classic epoch: planner, executor, challenger, rebuttal, reviewer, commentator.
function epochAnswers({ failPlanner = false } = {}) {
  return body => {
    const sys = body.messages[0].content
    const say = (content, cost) => completion(body.model, content, { prompt_tokens: 1000, completion_tokens: 400, cost })
    if (sys.includes('You are the PLANNER')) {
      if (failPlanner) return new Response('down', { status: 500 })
      return say({ direction: 'tool use', rationale: 'r', priority: 3, suggested_focus: 'capabilities' }, 0.02)
    }
    if (sys.includes('You are the EXECUTOR again')) return say({ responses: [] }, 0.005)
    if (sys.includes('You are the EXECUTOR this epoch')) {
      return say({
        mutations: [
          { type: 'Create', target: 'capabilities', path: 'capabilities[new]', value: { id: 'cap_tools_4', description: 'call tools' }, rationale: 'needed' },
          { type: 'rewrite-everything', target: 'behaviors', path: 'behaviors[new]', value: { id: 'b1' }, rationale: '?' },
          { type: 'add', target: 'constraints', path: 'constraints[new]', value: { id: 'con_1', description: 'no secrets', type: 'must_not' }, rationale: 'safety' },
        ],
        projected_stability_impact: 0.1, implementation_notes: '',
      }, 0.04)
    }
    if (sys.includes('You are the CHALLENGER')) {
      return say({ challenges: [{ mutation_index: 2, issue: 'vague', severity: 'note', example_scenario: 'x' }], conflicts_with_existing: [], overall_risk: 'low', recommendation: 'proceed' }, 0.015)
    }
    if (sys.includes('You are the REVIEWER')) {
      return say({
        decisions: [
          { mutation_index: 0, verdict: 'approve', reason: 'good', challenger_concern_addressed: true },
          { mutation_index: 1, verdict: 'approve', reason: 'odd', challenger_concern_addressed: true },
          { mutation_index: 2, verdict: 'modify', reason: { why: 'tighten' }, modified_value: { id: 'con_1', description: 'never leak secrets', type: 'must_not' }, challenger_concern_addressed: true },
          { mutation_index: 9, verdict: 'approve', reason: 'no such mutation' },
        ],
        new_conflicts_detected: [{ element_a: 'capabilities.cap_tools_4', element_b: 'constraints.con_1', description: 'tension', severity: 'HIGH' }, 'junk'],
        conflicts_resolved: ['conflict_3_0', 42],
        updated_stability_score: '0.72',
        epoch_summary: 'tools added',
      }, 0.03)
    }
    if (sys.includes('You are the COMMENTATOR')) return say({ summary: 's', highlight: 'h', plant_metaphor: 'p', mood: 'growing' }, 0.01)
    if (sys.includes('explore and research BEFORE')) return say({ task: 'Researching tools', search_queries: [], findings: 'f' }, 0.007)
    if (sys.includes('You are a software engineer')) return say({ files: [{ path: 'src/tools.ts', content: 'export const tools = []\n' }], commit_message: 'feat: tools', pr_summary: 'adds tools' }, 0.06)
    if (sys.includes('You are a subagent')) return say({ files: [{ path: 'tests/tools.test.ts', content: 'test("x", () => {})\n' }], commit_message: 'test: tools' }, 0.008)
    throw new Error(`unexpected prompt: ${sys.slice(0, 80)}`)
  }
}

function fakeGitHub() {
  return (url, method) => {
    if (method === 'GET' && url.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'b'.repeat(40) } }))
    if (method === 'GET' && url.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'c'.repeat(40) } }))
    if (method === 'GET' && url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }))
    if (method === 'GET' && url.includes('/contents/')) return new Response('{}', { status: 404 })
    if (method === 'POST' && url.endsWith('/pulls')) return new Response(JSON.stringify({ number: 7, html_url: 'https://github.example/pr/7' }))
    return new Response('{}')
  }
}

test('a classic epoch: validated output, one contribution, real cost from the ledger, flag released', async () => {
  process.env.LAB_ENABLE_CODE_WRITES = 'true'
  const exp = lab.addExperiment({ current_epoch: 3, current_spec: classicSpec() })
  const requests = fakeFetch(epochAnswers(), { github: fakeGitHub() })

  const result = await runner.runEpoch(exp.id)
  assert.equal(result.success, true)
  assert.equal(result.epochNumber, 4)

  // The epoch queues its contribution instead of running it (it would not
  // fit in the same 800 s request); the follow-up runs it on its own.
  assert.equal(requests.filter(r => r.url.includes('api.github.com')).length, 0)
  const queued = lab.epochs.find(e => e.experiment_id === exp.id && e.epoch_number === 4)
  assert.equal(queued.followup.status, 'pending')
  assert.equal(queued.followup.contribution_mutation_index, 0)
  // Stage 1: code written and the PR opened; nothing waits for CI here.
  const stage1 = await followups.runEpochFollowUp(exp.id)
  assert.equal(stage1.ran, true)
  assert.equal(stage1.status, 'awaiting_ci')
  assert.equal(queued.followup.status, 'awaiting_ci')
  assert.equal(queued.followup.pending.pr_url, 'https://github.example/pr/7')
  assert.equal(requests.some(r => r.url.includes('/actions/runs')), false)
  assert.equal(lab.contributions.length, 0)
  assert.equal(exp.epoch_in_progress, false)
  // Stage 2 (a later tick): CI is read (no trusted workflow is configured
  // here, so there is no passing result) and the PR is closed and recorded.
  const followUp = await followups.runEpochFollowUp(exp.id)
  assert.equal(followUp.ran, true)
  assert.equal(followUp.epoch_number, 4)
  assert.equal(queued.followup.status, 'done')
  assert.equal(queued.followup.result.merged, false)
  assert.equal(exp.epoch_in_progress, false)
  assert.deepEqual(await followups.runEpochFollowUp(exp.id), { ran: false, reason: 'nothing pending' })

  // Exactly one branch was created: the capability (highest value), not the constraint.
  const branches = requests.filter(r => r.method === 'POST' && r.url.endsWith('/git/refs'))
  assert.equal(branches.length, 1)
  assert.equal(branches[0].body.ref, 'refs/heads/epoch-4-capabilities-0')
  assert.equal(lab.contributions.length, 1)

  // Spec and the CHECK-constrained rows
  assert.equal(exp.current_epoch, 4)
  assert.equal(exp.epoch_in_progress, false)
  assert.equal(exp.current_spec.meta.stability_score, 0.72)
  assert.deepEqual(exp.current_spec.capabilities.map(c => c.id), ['cap_tools_4'])
  assert.deepEqual(exp.current_spec.constraints.map(c => c.description), ['never leak secrets'])
  assert.deepEqual(lab.mutations.map(m => [m.mutation_index, m.type]), [[0, 'add'], [2, 'add']]) // the unknown type was skipped
  assert.equal(lab.mutations[1].reason, '{"why":"tighten"}')
  assert.deepEqual(lab.conflicts.map(c => [c.severity, c.spec_conflict_id]), [['critical', 'conflict_4_1']])
  const resolved = exp.current_spec.conflicts.find(c => c.id === 'conflict_3_0')
  assert.equal(resolved.resolved, true)
  const resolveQuery = lab.queries.find(q => q.text.startsWith('UPDATE conflicts SET resolved_epoch'))
  assert.equal(resolveQuery.values[2], 'conflict_3_0')

  // Real cost: the epoch row holds the ledger total, contribution calls included.
  const epoch = lab.epochs.find(e => e.experiment_id === exp.id && e.epoch_number === 4)
  const ledgerTotal = lab.modelCalls.filter(c => c.experiment_id === exp.id && c.epoch_number === 4).reduce((s, c) => s + c.cost_usd, 0)
  assert.ok(Math.abs(ledgerTotal - (0.02 + 0.04 + 0.015 + 0.005 + 0.03 + 0.01 + 0.007 + 0.06 + 0.008)) < 1e-9, `ledger ${ledgerTotal}`)
  assert.ok(Math.abs(epoch.cost_usd - ledgerTotal) < 1e-9)
  assert.equal(epoch.prompt_tokens, 9000)
  assert.equal(epoch.completion_tokens, 3600)

  // Research log keyed by experiment
  assert.deepEqual(lab.epochLogs.map(l => [l.experiment_id, l.epoch_number]), [[exp.id, 4]])
  assert.match(lab.epochLogs[0].text, /ON CONFLICT \(experiment_id, epoch_number\)/)

  // Every outbound request had a timeout signal.
  assert.ok(requests.length > 10)
  for (const r of requests) assert.ok(r.signal instanceof AbortSignal, `${r.method} ${r.url} has no timeout`)
})

test('no contribution when the budget runs out mid-epoch', async () => {
  process.env.LAB_ENABLE_CODE_WRITES = 'true'
  process.env.LAB_DAILY_BUDGET_USD = '0.1' // the six role calls cost 0.12
  const exp = lab.addExperiment({ current_epoch: 3 })
  const requests = fakeFetch(epochAnswers(), { github: fakeGitHub() })
  await runner.runEpoch(exp.id)
  const followUp = await followups.runEpochFollowUp(exp.id)
  assert.equal(followUp.ran, false)
  assert.equal(followUp.reason, 'daily budget reached')
  assert.equal(requests.filter(r => r.url.includes('api.github.com')).length, 0)
  assert.ok(logs.some(l => /Not running epoch 4's follow-up: daily budget reached/.test(l)))
  // Still queued, for when the budget allows.
  assert.equal(lab.epochs.find(e => e.experiment_id === exp.id).followup.status, 'pending')
})

test('over budget, an epoch never starts: no claim, no model call', async () => {
  process.env.LAB_DAILY_BUDGET_USD = '1'
  lab.modelCalls.push({ cost_usd: 1.5, created_at: new Date() })
  const exp = lab.addExperiment({})
  const requests = fakeFetch(() => { throw new Error('no model call expected') })
  await assert.rejects(runner.runEpoch(exp.id), err => err instanceof spend.BudgetPausedError)
  assert.equal(requests.length, 0)
  assert.equal(lab.queries.some(q => q.text.startsWith('UPDATE experiments SET epoch_in_progress = TRUE')), false)
})

test('a busy epoch is refused, and a failed epoch always releases its claim', async () => {
  const busy = lab.addExperiment({ epoch_in_progress: true, epoch_started_at: new Date() })
  await assert.rejects(runner.runEpoch(busy.id), err => err instanceof claim.EpochBusyError)

  const exp = lab.addExperiment({ current_epoch: 3 })
  fakeFetch(epochAnswers({ failPlanner: true }))
  await assert.rejects(runner.runEpoch(exp.id), /Model returned invalid response/)
  assert.equal(exp.epoch_in_progress, false)
  assert.equal(exp.current_epoch, 3)
})

test('a research epoch whose repo read fails still clears the flag', async () => {
  process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
  const exp = lab.addExperiment({
    current_epoch: 2,
    current_spec: classicSpec({ meta: { stability_score: 0.2, growth_stage: 'seed', total_epochs: 2, total_mutations: 0, total_prunings: 0, research: { baseline_bpb: 0.72, best_bpb: 0.72, best_epoch: 0, target_bpb: 0.35 } } }),
  })
  fakeFetch(() => { throw new Error('no model call expected') }, { github: () => new Response('boom', { status: 502 }) })
  await assert.rejects(runner.runEpoch(exp.id), /getResearchFile\(train\.py\) failed: 502/)
  assert.equal(exp.epoch_in_progress, false)
  delete process.env.RESEARCH_GITHUB_TOKEN
})

test('research runner requests carry a timeout', async () => {
  process.env.RESEARCH_RUNNER_TOKEN = 'test-only-runner-token'
  process.env.RESEARCH_RUNNER_START_URL = 'https://runner.example/start'
  process.env.RESEARCH_RUNNER_STATUS_URL = 'https://runner.example/status'
  const signals = []
  globalThis.fetch = async (url, options = {}) => {
    signals.push(options.signal)
    return new Response(JSON.stringify(String(url).includes('/start') ? { call_id: 'c1' } : { status: 'running' }))
  }
  await research.startResearchRun('print(1)', 300)
  await research.pollResearchRun('c1')
  assert.equal(signals.length, 2)
  for (const s of signals) assert.ok(s instanceof AbortSignal)
  assert.match(readFileSync(join(root, 'api/_lib/research-epoch.ts'), 'utf8'), /RESEARCH_RUN_POLL_MAX_MS \|\| 400_000/)
})

// ===========================================================================
// Routes: tick, public state, seeding and reset
// ===========================================================================
test('the tick skips with a logged reason when the budget is spent, and the public state says paused', async () => {
  process.env.LAB_DAILY_BUDGET_USD = '3'
  lab.modelCalls.push({ cost_usd: 3.2, created_at: new Date() })
  const older = lab.addExperiment({ status: 'growing' })
  const exp = lab.addExperiment({ status: 'failing', current_epoch: 5 }) // newest, and failing still runs
  fakeFetch(() => { throw new Error('no model call expected') })

  const { default: tick } = await load('api/epoch/tick.js')
  const res = response()
  await tick({ method: 'GET', headers: { authorization: `Bearer ${CRON}` }, query: {} }, res)
  assert.equal(res.code, 200)
  assert.equal(res.body.state, 'paused: daily budget reached')
  assert.equal(res.body.experiment_id, exp.id)
  assert.notEqual(res.body.experiment_id, older.id)
  assert.ok(logs.some(l => /\[CRON\] Skipping epoch 6: daily budget reached \(\$3\.20 of \$3\.00/.test(l)), logs.join('\n'))
  const pick = lab.queries.find(q => q.text.includes('as last_epoch_at FROM experiments e'))
  assert.match(pick.text, /ORDER BY e\.created_at DESC LIMIT 1$/)

  const { default: experiment } = await load('api/experiment/index.js')
  const state = response()
  await experiment({ method: 'GET', headers: {}, query: {} }, state)
  assert.equal(state.code, 200)
  assert.equal(state.body.status, 'failing')
  assert.equal(state.body.run_state, 'paused: daily budget reached')
  assert.match(state.body.resumes_at, /T00:00:00\.000Z$/)
  assert.deepEqual(state.body.repos, {
    lab: 'https://github.com/test-owner/Observable-Lab',
    specimen: 'https://github.com/test-owner/AI-Agent',
    research: 'https://github.com/test-owner/Research-Lab',
  })
  assert.equal(state.body.growth.stage, 0)
  assert.equal(state.body.growth.epochs, 5)
  for (const key of ['progress', 'capabilities', 'constraints', 'behaviors', 'stability', 'merged_contributions', 'contributions_with_passing_tests', 'sprite_test_passes', 'glass_shattered']) {
    assert.ok(key in state.body.growth, key)
  }
  // The public state never carries dollar amounts.
  assert.doesNotMatch(JSON.stringify({ run_state: state.body.run_state, resumes_at: state.body.resumes_at }), /\$|spent/)
})

test('the tick waits for the interval measured from the end of the last epoch', async () => {
  const exp = lab.addExperiment({ current_epoch: 2 })
  lab.epochs.push({ id: uuid(), experiment_id: exp.id, epoch_number: 2, completed_at: new Date(Date.now() - 100 * 60_000) })
  fakeFetch(() => { throw new Error('no model call expected') })
  const { default: tick } = await load('api/epoch/tick.js')
  const res = response()
  await tick({ method: 'GET', headers: { authorization: `Bearer ${CRON}` }, query: {} }, res)
  assert.match(res.body.message, /^Waiting\. 70 minutes until next epoch\.$/)
  assert.equal(res.body.interval_minutes, 180)
})

test('seeding refuses while any experiment is active; reset archives and seeds classic, then research', async () => {
  const auth = { authorization: `Bearer ${OPERATOR}` }
  const { default: experiment } = await load('api/experiment/index.js')
  const { default: reset } = await load('api/experiment/reset.js')

  const failing = lab.addExperiment({ status: 'failing', epoch_in_progress: true })
  let res = response()
  await experiment({ method: 'POST', headers: auth, query: {} }, res)
  assert.equal(res.code, 400)
  assert.equal(res.body.experiment_id, failing.id)

  res = response()
  await reset({ method: 'POST', headers: auth, query: { confirm: 'true', mode: 'bogus' } }, res)
  assert.equal(res.code, 400)

  res = response()
  await reset({ method: 'POST', headers: auth, query: { confirm: 'true', mode: 'classic' } }, res)
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.equal(res.body.mode, 'classic')
  assert.equal(failing.status, 'archived')
  assert.equal(failing.epoch_in_progress, false)
  const classic = lab.experiments.find(e => e.id === res.body.new_experiment_id)
  assert.equal(classic.status, 'seeding')
  assert.equal(classic.current_epoch, 0)
  assert.equal(classic.current_spec.meta.research, undefined)
  assert.equal(lab.epochs.filter(e => e.experiment_id === classic.id && e.epoch_number === 0).length, 1)
  // The run 2 tables are created by reset (once per process, so checked in the source).
  assert.match(readFileSync(join(root, 'api/experiment/reset.ts'), 'utf8'), /await ensureEpochLogsTable\(\)\n\s+await ensureSpendTable\(\)/)

  res = response()
  await reset({ method: 'POST', headers: auth, query: { confirm: 'true', mode: 'research' } }, res)
  assert.equal(res.code, 200)
  assert.equal(classic.status, 'archived')
  const researchExp = lab.experiments.find(e => e.id === res.body.new_experiment_id)
  assert.ok(researchExp.current_spec.meta.research)
  assert.equal(lab.experiments.filter(e => e.status !== 'archived').length, 1)
})

test('an epoch still running on an archived experiment cannot un-archive it', async () => {
  const exp = lab.addExperiment({ status: 'archived', current_epoch: 1 })
  lab.handle("UPDATE experiments SET current_spec = ?, current_epoch = ?, epoch_in_progress = FALSE, epoch_started_at = NULL, status = ? WHERE id = ? AND status <> 'archived'", ['{}', 2, 'growing', exp.id])
  assert.equal(exp.status, 'archived')
  const runnerSource = readFileSync(join(root, 'api/_lib/epoch-runner.ts'), 'utf8')
  assert.match(runnerSource, /status = \$\{newStatus\}\n\s+WHERE id = \$\{experimentId\} AND status <> 'archived'/)
})

// ===========================================================================
// 6. Growth
// ===========================================================================
const facts = over => ({
  epochs: 0, capabilities: 0, constraints: 0, behaviors: 0, stability: 0.5,
  merged_contributions: 0, contributions_with_passing_tests: 0, sprite_test_passes: 0, stored_glass_shattered: false, ...over,
})

test('growth needs merged, tested code and a healthy spec, never epochs alone', () => {
  const T = growth.GROWTH_THRESHOLDS
  assert.equal(T.length, 6)
  for (let i = 1; i < T.length; i++) {
    for (const k of ['epochs', 'spec_elements', 'capabilities', 'constraints', 'stability', 'tested_merges']) {
      assert.ok(T[i][k] >= T[i - 1][k], `stage ${i + 1} ${k} must not be lower than stage ${i}`)
    }
    assert.ok(T[i].tested_merges > 0 && T[i].epochs > T[i - 1].epochs)
  }

  assert.deepEqual(growth.computeGrowth(facts({})).stage, 0)
  // A thousand epochs and a huge spec, but nothing merged: still contained.
  assert.equal(growth.computeGrowth(facts({ epochs: 1000, capabilities: 50, constraints: 30, behaviors: 30, stability: 0.95 })).stage, 0)
  // Plenty of merged code, but an unhealthy spec: held back.
  assert.equal(growth.computeGrowth(facts({ epochs: 1000, capabilities: 50, constraints: 30, behaviors: 30, stability: 0.3, contributions_with_passing_tests: 99, merged_contributions: 99 })).stage, 0)

  const stage2 = growth.computeGrowth(facts({ epochs: 30, capabilities: 6, constraints: 3, behaviors: 4, stability: 0.52, merged_contributions: 4, contributions_with_passing_tests: 4 }))
  assert.equal(stage2.stage, 2)
  assert.ok(stage2.progress > 0 && stage2.progress < 1)
  assert.equal(stage2.glass_shattered, false)

  const out = growth.computeGrowth(facts({ epochs: 60, capabilities: 10, constraints: 5, behaviors: 12, stability: 0.6, merged_contributions: 9, contributions_with_passing_tests: 9, sprite_test_passes: 4 }))
  assert.equal(out.stage, 3)
  assert.equal(out.glass_shattered, true)

  const full = growth.computeGrowth(facts({ epochs: 400, capabilities: 30, constraints: 15, behaviors: 30, stability: 0.8, merged_contributions: 60, contributions_with_passing_tests: 60 }))
  assert.deepEqual([full.stage, full.progress], [6, 1])

  // A stored broken glass stays broken.
  assert.equal(growth.computeGrowth(facts({ stored_glass_shattered: true })).glass_shattered, true)
  // Bad values never produce NaN.
  const junk = growth.computeGrowth(facts({ epochs: NaN, stability: 'x', capabilities: -4 }))
  assert.equal(junk.stage, 0)
  assert.ok(Number.isFinite(junk.progress))
})

test('GROWTH.md documents the same table as the code', () => {
  const doc = readFileSync(join(root, 'docs/GROWTH.md'), 'utf8')
  for (const row of growth.GROWTH_THRESHOLDS) {
    const line = doc.split('\n').find(l => l.startsWith(`| ${row.stage} |`))
    assert.ok(line, `stage ${row.stage} missing from docs/GROWTH.md`)
    const cells = line.split('|').map(c => c.trim())
    assert.deepEqual(cells.slice(3, 9).map(Number), [row.epochs, row.spec_elements, row.capabilities, row.constraints, row.stability, row.tested_merges])
  }
  // The worked example on the page is what the code computes.
  const example = JSON.parse(doc.match(/```json\n"growth": (\{[\s\S]*?\n\})\n```/)[1])
  const computed = growth.computeGrowth({ ...example, stored_glass_shattered: false })
  assert.deepEqual([computed.stage, computed.progress], [example.stage, example.progress])
})

test('growth events: stable ids, the magnitude rules, setbacks, breakthroughs, the 400 cap', () => {
  const t0 = Date.parse('2026-11-01T00:00:00Z')
  const when = n => new Date(t0 + n * 3600_000).toISOString()
  const epoch = (n, extra = {}) => ({ id: `e${n}`, epoch_number: n, completed_at: when(n), assigned_executor: 'openai/gpt-6-astra', decisions: [], ...extra })
  const approve = k => Array.from({ length: k }, () => ({ verdict: 'approve' }))

  const events = growth.buildGrowthEvents({
    baselineBpb: 0.9,
    epochs: [
      epoch(0), // the seed is not work
      epoch(1, { decisions: approve(4) }),
      epoch(2, { decisions: [{ verdict: 'reject' }] }),
      epoch(3, { review_verdict: 'keep', run_status: 'ok', val_bpb: '0.85' }),
      epoch(4, { review_verdict: 'keep', run_status: 'ok', val_bpb: 0.87 }), // keeps, but does not beat 0.85
      epoch(5, { review_verdict: 'revert', run_status: 'ok', val_bpb: 0.5 }), // never a breakthrough
      epoch(6, { executor_served_by: { fallback: true, model: 'x-ai/grok-4.7' } }),
    ],
    contributions: [
      { id: 'c1', epoch_number: 1, model_id: 'openai/gpt-6-astra', merged: true, ci_passed: true, pr_url: 'https://github.com/o/r/pull/42', lines_changed: '400', created_at: when(1.5) },
      { id: 'c2', epoch_number: 2, model_id: 'openai/gpt-6-astra', merged: true, ci_passed: null, lines_changed: 0, created_at: when(2.5) },
      { id: 'c3', epoch_number: 3, model_id: 'openai/gpt-6-astra', merged: false, ci_passed: false, created_at: when(3.5) },
      { id: 'c4', epoch_number: 4, model_id: 'openai/gpt-6-astra', merged: false, ci_passed: null, sprite_ran_at: when(4.4), sprite_exit_code: 2, created_at: when(4.5) },
      { id: 'c5', epoch_number: 5, model_id: 'openai/gpt-6-astra', merged: false, ci_passed: null, pr_url: 'https://github.com/o/r/pull/43', created_at: when(5.5) },
      { id: 'c6', epoch_number: 5, model_id: 'openai/gpt-6-astra', merged: false, ci_passed: null, pr_url: null, created_at: when(5.6) }, // never opened a pull request
    ],
    exhibits: [{ id: 't1', epoch: 2, model: 'openai/gpt-6-astra', created_at: when(2.7) }],
  })

  const byId = Object.fromEntries(events.map(e => [e.id, e]))
  assert.equal(byId['epoch:e0'], undefined)
  assert.equal(byId['epoch:e1'].magnitude, 0.3)
  assert.equal(byId['epoch:e2'].magnitude, 0.1)
  assert.equal(byId['epoch:e3'].magnitude, 0.2)
  assert.equal(byId['epoch:e3'].ref, 'keep')
  assert.equal(byId['research:e3'].kind, 'breakthrough')
  assert.ok(byId['research:e3'].magnitude > 0.8 && byId['research:e3'].magnitude <= 1)
  assert.equal(byId['research:e4'], undefined)
  assert.equal(byId['research:e5'], undefined)
  assert.equal(byId['contribution:c1'].magnitude, 0.8)
  assert.equal(byId['contribution:c1'].ref, '#42')
  assert.equal(byId['contribution:c2'].magnitude, 0.4)
  assert.deepEqual([byId['contribution:c3'].kind, byId['contribution:c3'].magnitude, byId['contribution:c3'].ref], ['tests_failed', 0.2, 'ci failed'])
  assert.deepEqual([byId['contribution:c4'].kind, byId['contribution:c4'].ref], ['tests_failed', 'sprite failed'])
  assert.deepEqual([byId['contribution:c5'].kind, byId['contribution:c5'].magnitude], ['contribution_rejected', 0.2])
  assert.equal(byId['contribution:c6'], undefined) // no pull request, so no setback in the room
  assert.deepEqual([byId['tool:t1'].kind, byId['tool:t1'].magnitude], ['exhibit_merged', 0.3])
  assert.equal(byId['epoch:e1'].model, 'GPT-6 Astra')
  assert.equal(byId['epoch:e6'].model, 'Grok 4.7')
  for (const e of events) {
    assert.ok(e.magnitude >= 0 && e.magnitude <= 1 && Number.isFinite(e.magnitude))
    assert.match(e.at, /^\d{4}-\d\d-\d\dT.*Z$/)
  }
  assert.deepEqual(events.map(e => Date.parse(e.at)), events.map(e => Date.parse(e.at)).sort((a, b) => a - b))
  // Same records, same feed.
  const again = growth.buildGrowthEvents({ baselineBpb: 0.9, epochs: [epoch(1, { decisions: approve(4) })], contributions: [], exhibits: [] })
  assert.deepEqual(again, growth.buildGrowthEvents({ baselineBpb: 0.9, epochs: [epoch(1, { decisions: approve(4) })], contributions: [], exhibits: [] }))

  // A full window cannot judge its first KEEP; the cap keeps the newest 400.
  const kept = growth.buildGrowthEvents({ truncated: true, baselineBpb: 0.9, epochs: [epoch(1, { review_verdict: 'keep', run_status: 'ok', val_bpb: 0.8 }), epoch(2, { review_verdict: 'keep', run_status: 'ok', val_bpb: 0.7 })], contributions: [], exhibits: [] })
  assert.deepEqual(kept.filter(e => e.kind === 'breakthrough').map(e => e.epoch), [2])
  const many = growth.buildGrowthEvents({ epochs: Array.from({ length: 450 }, (_, i) => epoch(i + 1)), contributions: [], exhibits: [] })
  assert.equal(many.length, 400)
  assert.equal(many[0].epoch, 51)
  assert.equal(many.at(-1).epoch, 450)
})

test('GET /api/experiment carries growth_events from one limited query per table, and survives missing tables', async () => {
  const exp = lab.addExperiment({ status: 'growing', current_epoch: 2 })
  const when = n => new Date(Date.parse('2026-11-01T00:00:00Z') + n * 3600_000)
  const seen = []
  const inner = db.handler
  db.handler = (text, values) => {
    if (text.includes('FROM epochs WHERE experiment_id = ? AND completed_at IS NOT NULL')) {
      seen.push(text)
      return { rows: [{ id: 'ep1', epoch_number: 1, completed_at: when(1), assigned_executor: 'openai/gpt-6-astra', decisions: [{ verdict: 'approve' }, { verdict: 'modify' }] }] }
    }
    if (text.includes('FROM code_contributions WHERE experiment_id = ? ORDER BY')) {
      seen.push(text)
      return { rows: [{ id: 'cc1', epoch_number: 1, model_id: 'google/gemini-4-hydrogen', merged: true, ci_passed: true, lines_changed: 100, created_at: when(1.5) }] }
    }
    if (text.includes("FROM tool_runs WHERE experiment_id = ? AND tool = 'exhibit'")) { seen.push(text); throw new Error('relation "tool_runs" does not exist') }
    return inner(text, values)
  }
  fakeFetch(() => { throw new Error('no model call expected') })
  const { default: experiment } = await load('api/experiment/index.js')
  const res = response()
  await experiment({ method: 'GET', headers: {}, query: {} }, res)
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.growth_events.map(e => e.id), ['epoch:ep1', 'contribution:cc1'])
  assert.equal(res.body.growth_events[0].magnitude, 0.2)
  assert.equal(res.body.growth_events[1].magnitude, 0.575)
  assert.equal(seen.length, 3)
  for (const text of seen) assert.match(text, /LIMIT \?$/)
  assert.equal(JSON.stringify(res.body.growth_events).includes('train_py'), false)

  // A second poll inside the cache window asks nothing again.
  const before = seen.length
  await experiment({ method: 'GET', headers: {}, query: {} }, response())
  assert.equal(seen.length, before)
  // The contract's growth_events field stays documented.
  assert.match(readFileSync(join(root, 'docs/GROWTH.md'), 'utf8'), /## Growth events/)
  assert.ok(exp.id)
})

// ===========================================================================
// 5. Prompts
// ===========================================================================
test('prompts name the new panel, describe rotation correctly and tell the truth about contributions', () => {
  const spec = classicSpec()
  delete process.env.LAB_ENABLE_CODE_WRITES
  let ctx = prompts.getSharedContext(4, spec, [])
  assert.match(ctx, /Gemini 4 \(Google\), DeepSeek V4 Pro \(DeepSeek\), Claude Fable 5\.2 \(Anthropic\), GPT-6 Astra \(OpenAI\), and Grok 4\.7 \(xAI\)/)
  assert.match(ctx, /Roles rotate every epoch: in each aligned block of five epochs/)
  assert.match(ctx, /Code contributions are switched off for this run/)
  assert.doesNotMatch(ctx, /max_code_contributions_per_epoch/)
  assert.match(ctx, /current default 180/)

  process.env.LAB_ENABLE_CODE_WRITES = 'true'
  ctx = prompts.getSharedContext(4, spec, [])
  assert.match(ctx, /AT MOST ONE approved mutation becomes a code contribution/)
  assert.match(ctx, /pull request to AI-Agent/)
  assert.match(ctx, /merges only if CI passes and the Reviewer approved/)
  assert.doesNotMatch(ctx, /Sprite sandbox/) // not configured here
  process.env.SPRITES_TOKEN = 'test-only-sprites-token'
  assert.match(prompts.getSharedContext(4, spec, []), /author's own Sprite sandbox also checks out that exact commit and runs the tests/)
  delete process.env.SPRITES_TOKEN

  const rctx = researchPrompts.getResearchSharedContext({
    epochNumber: 1, spec, research: { baseline_bpb: 0.7, best_bpb: 0.7, best_epoch: 0, target_bpb: 0.35 },
    trainPy: '', resultsTsv: '', wikiIndex: '', recentHistory: [],
  })
  assert.doesNotMatch(rctx, /every 5 epochs/)
  assert.match(rctx, /Roles rotate every epoch/)
  assert.match(rctx, /Claude Fable 5\.2/)
})

// ===========================================================================
// 8. Commit authors
// ===========================================================================
test('commit authors are the models on observable-lab.invalid; the owner commits', () => {
  const OWNER = { name: 'DervinEvolve', email: '39844362+DervinEvolve@users.noreply.github.com' }
  const expected = {
    'Gemini 4': 'gemini-4', 'DeepSeek V4 Pro': 'deepseek-v4-pro', 'Claude Fable 5.2': 'claude-fable-5-2',
    'GPT-6 Astra': 'gpt-6-astra', 'Grok 4.7': 'grok-4-7', North: 'north', 'GLM 5.3': 'glm-5-3',
  }
  for (const [name, local] of Object.entries(expected)) {
    assert.deepEqual(identity.modelCommitAuthor(name), { name, email: `${local}@observable-lab.invalid` })
  }
  // Panel, subagent, wildcard and fallback messages
  const panel = identity.labCommitIdentityFields('feat: x\n\nModel: Claude Fable 5.2 (anthropic/claude-fable-5.2)')
  assert.deepEqual(panel, { author: { name: 'Claude Fable 5.2', email: 'claude-fable-5-2@observable-lab.invalid' }, committer: OWNER })
  const sub = identity.labCommitIdentityFields('test: x\n\nModel: GPT-6 Astra (openai/gpt-6-astra)\nModel-Role: subagent')
  assert.equal(sub.author.email, 'gpt-6-astra@observable-lab.invalid')
  const glm = identity.labCommitIdentityFields('feat: y\n\nModel: GLM 5.3 (z-ai/glm-5.3-prime)')
  assert.equal(glm.author.name, 'GLM 5.3')
  const north = identity.labCommitIdentityFields('feat: y\n\nModel: North (cohere/north-mini-code:free)')
  assert.equal(north.author.email, 'north@observable-lab.invalid')
  const fallback = identity.labCommitIdentityFields('feat: z\n\nModel: claude-sonnet-5.5 (anthropic/claude-sonnet-5.5)\nModel-Fallback-For: Grok 4.7')
  assert.deepEqual(fallback.author, { name: 'Claude Sonnet 5.5', email: 'claude-sonnet-5-5@observable-lab.invalid' })
  // No trailer: the owner authors it.
  assert.deepEqual(identity.labCommitIdentityFields('chore: bootstrap repo'), { author: OWNER, committer: OWNER })
  // Hostile names can't break the header.
  const evil = identity.modelCommitAuthor('Evil <x@y>\nCo-authored-by: z')
  assert.doesNotMatch(evil.name, /[<>\n]/)
  assert.match(evil.email, /^[a-z0-9-]+@observable-lab\.invalid$/)

  const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
  assert.match(claudeMd, /claude-fable-5-2@observable-lab\.invalid/)
  assert.match(claudeMd, /39844362\+DervinEvolve@users\.noreply\.github\.com/)
})

// ===========================================================================
// Research record: what each model did beside what it said it did
// ===========================================================================
test('the activity record puts claimed searches beside recorded citations and flags the gaps', () => {
  const a = activityLib.buildEpochActivity({
    epoch: {
      epoch_number: 2, started_at: '2026-11-15T00:00:00Z', completed_at: '2026-11-15T00:10:00Z',
      role_assignments: { planner: 'deepseek/deepseek-v4-pro-0813', executor: 'anthropic/claude-fable-5.2', challenger: 'openai/gpt-6-astra', reviewer: 'x-ai/grok-4.7', commentator: 'google/gemini-4-hydrogen' },
      planner_output: {
        direction: 'd', web_searches: ['AI agent futures'],
        web_sources: [{ url: 'https://www.forethought.org/research/x', title: 'Forethought' }, { url: 'javascript:alert(1)', title: 'bad' }],
      },
      executor_output: { mutations: [], web_searches: ['tool use patterns'], web_sources: [] },
      challenger_output: { challenges: [], web_searches: ['I looked this up'] },
      reviewer_output: { decisions: [], served_by: { model: 'anthropic/claude-sonnet-5.5', assigned: 'x-ai/grok-4.7', fallback: true } },
      followup: { status: 'done', result: { pr_url: 'https://github.com/x/y/pull/1', merged: false, ci_passed: false } },
    },
    toolRuns: [{ tool: 'sprite_session', model: 'anthropic/claude-fable-5.2', request_summary: 'check node', status: 'ok', exit_code: 0, duration_ms: 900, cost_usd: '0.001', output_tail: '$ curl https://example.com\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', created_at: '2026-11-15T00:05:00Z' }],
    contributions: [{ author_name: 'Claude Fable 5.2', branch: 'epoch-2-capabilities-0', pr_url: 'https://github.com/x/y/pull/1', merged: true, ci_passed: null, sprite_exit_code: 0, sprite_ran_at: '2026-11-15T00:09:00Z', explorer_task: 'Researching tools', web_searches: ['q1'], web_sources: [{ url: 'https://docs.example.com/a', title: 'Docs' }] }],
    spend: [{ model_id: 'anthropic/claude-fable-5.2', purpose: 'followup', requests: '3', cost_usd: '0.31', prompt_tokens: '9000', completion_tokens: '2000' }, { model_id: 'deepseek/deepseek-v4-pro-0813', purpose: 'epoch', requests: '1', cost_usd: '0.01', prompt_tokens: '1000', completion_tokens: '100' }],
  })
  const role = name => a.roles.find(r => r.role === name)
  assert.deepEqual(role('planner').recorded_sources, [{ url: 'https://www.forethought.org/research/x', title: 'Forethought', domain: 'forethought.org' }]) // the javascript: link is dropped
  assert.deepEqual(role('planner').flags, [])
  assert.deepEqual(role('executor').flags, ['reported web searches, but no cited pages were recorded'])
  assert.equal(role('challenger').had_web_access, false)
  assert.deepEqual(role('challenger').flags, ['reported web searches on a step that had no web access'])
  assert.equal(role('reviewer').fallback, true)
  assert.equal(role('reviewer').answered_by_name, 'Claude Sonnet 5.5')
  assert.match(a.tools[0].output_tail, /\$ curl https:\/\/example\.com/) // the command it ran is kept
  assert.doesNotMatch(a.tools[0].output_tail, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/) // credentials are not
  assert.equal(a.contributions[0].sprite_tests, 'passed')
  assert.deepEqual(a.contributions[0].flags, ['merged without a passing CI record'])
  assert.equal(a.spend[0].model_name, 'Claude Fable 5.2')
  assert.deepEqual(a.totals, { cost_usd: 0.32, searches_claimed: 4, sources_recorded: 2, flags: 3 })
  assert.deepEqual(a.follow_up, { status: 'done', pr_url: 'https://github.com/x/y/pull/1', merged: false, ci_passed: false })
})

test('GET /api/experiment/activity serves the latest epoch, one epoch, or the whole run, to anyone', async () => {
  const exp = lab.addExperiment({ current_epoch: 3 })
  lab.epochs.push({ id: uuid(), experiment_id: exp.id, epoch_number: 0, role_assignments: {}, completed_at: new Date() })
  lab.epochs.push({ id: uuid(), experiment_id: exp.id, epoch_number: 1, role_assignments: { planner: 'deepseek/deepseek-v4-pro-0813' }, planner_output: { web_searches: ['x'], web_sources: [{ url: 'https://a.example/1', title: 'A' }] }, completed_at: new Date() })
  lab.epochs.push({ id: uuid(), experiment_id: exp.id, epoch_number: 2, role_assignments: { planner: 'x-ai/grok-4.7' }, planner_output: { direction: 'd' }, completed_at: new Date() })
  lab.modelCalls.push({ experiment_id: exp.id, epoch_number: 2, purpose: 'epoch', model_id: 'x-ai/grok-4.7', cost_usd: 0.02, prompt_tokens: 10, completion_tokens: 5, created_at: new Date() })
  const { default: activity } = await load('api/experiment/activity.js')

  let res = response()
  await activity({ method: 'GET', headers: {}, query: {} }, res)
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.epochs.map(e => e.epoch_number), [2])
  assert.equal(res.body.epochs[0].spend[0].model_name, 'Grok 4.7')

  res = response()
  await activity({ method: 'GET', headers: {}, query: { epoch: '1' } }, res)
  assert.equal(res.body.epochs[0].roles[0].recorded_sources[0].domain, 'a.example')

  res = response()
  await activity({ method: 'GET', headers: {}, query: { all: 'true' } }, res)
  assert.deepEqual(res.body.epochs.map(e => e.epoch_number), [1, 2]) // the seed record is not an epoch of work

  res = response()
  await activity({ method: 'GET', headers: {}, query: { epoch: '-3' } }, res)
  assert.equal(res.code, 400)
  res = response()
  await activity({ method: 'POST', headers: {}, query: {} }, res)
  assert.equal(res.code, 405)
})

// ===========================================================================
// Follow-up timing: deadlines, timeouts and one retry
// ===========================================================================
test('a timed-out model call goes straight to the fallback, and a spent deadline makes no request', async () => {
  const requested = []
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/models')) return new Response(JSON.stringify(CATALOG))
    const body = JSON.parse(options.body)
    requested.push(body.model)
    if (body.model === 'anthropic/claude-fable-5.2') throw new DOMException('The operation timed out.', 'TimeoutError')
    return completion(body.model, { ok: true })
  }
  const r = await openrouter.callModel('anthropic/claude-fable-5.2', 's', 'u')
  assert.deepEqual(requested, ['anthropic/claude-fable-5.2', 'anthropic/claude-sonnet-5.5']) // no second try on the slow model
  assert.equal(r.servedBy.model, 'anthropic/claude-sonnet-5.5')

  requested.length = 0
  await assert.rejects(openrouter.callModel('openai/gpt-6-astra', 's', 'u', { deadlineAt: Date.now() + 5_000 }), /Model returned invalid response/)
  assert.deepEqual(requested, []) // under 20 s left: nothing is started
})

test('a follow-up that opened no pull request can be retried once', async () => {
  const exp = lab.addExperiment({ current_epoch: 1 })
  const ep = { id: uuid(), experiment_id: exp.id, epoch_number: 1, spec_after: classicSpec(), completed_at: new Date(),
    followup: { status: 'done', contribution_mutation_index: 0, deliverables: false, queued_at: 'x', result: { pr_url: null, merged: false } } }
  lab.epochs.push(ep)
  const fake = lab.handle.bind(lab)
  db.handler = (text, v) => text.startsWith('SELECT id, followup FROM epochs') ? { rows: lab.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number === v[1]) } : fake(text, v)
  assert.deepEqual(await followups.requeueFollowUp(exp.id, 1), { ok: true })
  assert.equal(ep.followup.status, 'pending')
  assert.equal(ep.followup.retries, 1)
  ep.followup = { ...ep.followup, status: 'done', result: { pr_url: null } }
  assert.deepEqual(await followups.requeueFollowUp(exp.id, 1), { ok: false, reason: 'already retried' })
  ep.followup = { status: 'done', contribution_mutation_index: 0, deliverables: false, queued_at: 'x', result: { pr_url: 'https://github.com/x/y/pull/3' } }
  assert.match((await followups.requeueFollowUp(exp.id, 1)).reason, /a PR was opened/)
})

test('an answer cut off at max_tokens is billed but never parsed from the reasoning, and goes straight to the fallback', async () => {
  const requested = []
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/models')) return new Response(JSON.stringify(CATALOG))
    const body = JSON.parse(options.body)
    requested.push(body)
    if (body.model === 'anthropic/claude-fable-5.2') {
      return new Response(JSON.stringify({
        model: body.model,
        choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'thinking... {"note": "a stray fragment"} ...' } }],
        usage: { prompt_tokens: 5000, completion_tokens: 32000, completion_tokens_details: { reasoning_tokens: 30000 }, cost: 1.3 },
      }))
    }
    return completion(body.model, { files: [{ path: 'src/a.ts', content: 'x' }] }, { prompt_tokens: 100, completion_tokens: 100, cost: 0.02 })
  }
  const r = await openrouter.callModel('anthropic/claude-fable-5.2', 's', 'u', { maxTokens: 48000, effort: 'low' })
  assert.deepEqual(requested.map(b => b.model), ['anthropic/claude-fable-5.2', 'anthropic/claude-sonnet-5.5'])
  assert.deepEqual(r.output.files, [{ path: 'src/a.ts', content: 'x' }]) // not the stray fragment
  assert.ok(Math.abs(r.cost - 1.32) < 1e-9) // the cut-off answer still counts
  // Low effort and the larger budget reach the request.
  assert.deepEqual(requested[0].reasoning, { effort: 'low' })
  assert.equal(requested[0].max_tokens, 96000)
  assert.ok(logs.some(l => /cut off at max_tokens \(32000 completion tokens, 30000 reasoning\)/.test(l)))
})

test('a request that Node\'s fetch gives up on (no headers in 300 s) counts as a timeout and goes to the fallback', async () => {
  const requested = []
  const dispatchers = []
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/models')) return new Response(JSON.stringify(CATALOG))
    const body = JSON.parse(options.body)
    requested.push(body.model)
    dispatchers.push(options.dispatcher)
    if (body.model === 'anthropic/claude-fable-5.2') throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
    return completion(body.model, { ok: true })
  }
  const r = await openrouter.callModel('anthropic/claude-fable-5.2', 's', 'u')
  assert.deepEqual(requested, ['anthropic/claude-fable-5.2', 'anthropic/claude-sonnet-5.5']) // not asked again
  assert.equal(r.servedBy.model, 'anthropic/claude-sonnet-5.5')
  // Every model request carries the dispatcher with the 300 s limits switched off.
  assert.ok(dispatchers.every(d => d && typeof d.dispatch === 'function'))
  assert.equal(openrouter.isTimeoutError(new TypeError('fetch failed', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } })), true)
  assert.equal(openrouter.isTimeoutError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), false)
})

test('an answer in the wrong shape goes to the fallback instead of ending the call as a success', async () => {
  const requested = []
  fakeFetch(body => {
    requested.push(body.model)
    if (body.model === 'deepseek/deepseek-v4-pro-0813') return completion(body.model, { note: 'a stray fragment' })
    return completion(body.model, { files: [{ path: 'src/a.ts', content: 'x' }] })
  })
  const accept = p => Array.isArray(p?.files) && p.files.length > 0
  const r = await openrouter.callModel('deepseek/deepseek-v4-pro-0813', 's', 'u', { accept })
  assert.deepEqual(requested, ['deepseek/deepseek-v4-pro-0813', 'anthropic/claude-sonnet-5.5'])
  assert.deepEqual(r.output.files, [{ path: 'src/a.ts', content: 'x' }])
  // With no fallback allowed, the wrong shape is a failure that says so.
  await assert.rejects(openrouter.callModel('deepseek/deepseek-v4-pro-0813', 's', 'u', { accept, noFallback: true }), /expected shape/)
})

test('time kept back for a fallback: the assigned model never takes the fallback\'s share', async () => {
  const requested = []
  fakeFetch(body => {
    requested.push(body.model)
    return completion(body.model, { files: [{ path: 'src/a.ts', content: 'x' }] })
  })
  // 130 s left and 120 s kept back: too little for the assigned model, enough for a fallback.
  const r = await openrouter.callModel('openai/gpt-6-astra', 's', 'u', { deadlineAt: Date.now() + 130_000, fallbackReserveMs: 120_000, timeoutMs: 420_000 })
  assert.deepEqual(requested, ['anthropic/claude-sonnet-5.5'])
  assert.equal(r.servedBy.fallback, true)
})
