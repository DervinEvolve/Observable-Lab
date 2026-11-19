// Research beside run 2 (LAB_RESEARCH_ALONGSIDE): one classic and one research
// experiment active together, each advanced by the same tick on its own
// claim and its own daily cap, the research experiment brought back so its
// epoch numbers carry on, and nothing different while the flag is off.
//
// No network, no database, no secrets: fetch is a fake that answers like
// OpenRouter, GitHub and the research runner, and `@vercel/postgres` is
// swapped for an in-memory fake that understands the queries involved. An
// experiments statement the fake does not know is an error, so a query that
// changed cannot pass by returning nothing.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-alongside-test-'))
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
const originalConsole = { warn: console.warn, log: console.log, error: console.error }
after(() => {
  process.env = originalEnv
  globalThis.fetch = originalFetch
  Object.assign(console, originalConsole)
  rmSync(build, { recursive: true, force: true })
})

for (const name of Object.keys(process.env)) {
  if (/^(OPENROUTER|POSTGRES|LAB_|AI_AGENT|RESEARCH_|SPRITES|MODAL|EPOCH_|NORTH_|GPU_JOBS)/.test(name)) delete process.env[name]
}
const CRON = 'test-only-scheduler-secret-000000000000000'
const OPERATOR = 'test-only-operator-secret-0000000000000000'
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder' // read once at import
process.env.CRON_SECRET = CRON
process.env.LAB_OPERATOR_SECRET = OPERATOR
process.env.AI_AGENT_GITHUB_TOKEN = 'test-only-not-a-provider-token'
process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'
process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
process.env.RESEARCH_RUNNER_TOKEN = 'test-only-runner-token'
process.env.RESEARCH_RUNNER_START_URL = 'https://runner.example/start'
process.env.RESEARCH_RUNNER_STATUS_URL = 'https://runner.example/status'

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
const modes = await load('api/_lib/experiment-modes.js')
const alongside = await load('api/_lib/research-alongside.js')
const research = await load('api/_lib/research.js')
const { default: tick } = await load('api/epoch/tick.js')
const { default: experimentRoute } = await load('api/experiment/index.js')
const { default: graphRoute } = await load('api/experiment/graph.js')
const { default: runRoute } = await load('api/epoch/run.js')
const { default: resetRoute } = await load('api/experiment/reset.js')
const { default: patchResearchRoute } = await load('api/experiment/patch-research.js')

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------
const JSON_COLUMNS = new Set(['current_spec', 'role_assignments', 'spec_before', 'spec_after', 'plant_geometry',
  'planner_output', 'executor_output', 'challenger_output', 'executor_rebuttal', 'reviewer_output',
  'commentator_output', 'research_run', 'followup'])
const decode = (col, v) => (JSON_COLUMNS.has(col) && typeof v === 'string' ? JSON.parse(v) : v)
let nextId = 1
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
const isResearch = e => Boolean(e.current_spec?.meta?.research && typeof e.current_spec.meta.research === 'object')

class FakeLab {
  constructor() {
    this.experiments = []
    this.epochs = []
    this.modelCalls = []
    this.queries = []
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

  addEpoch(exp, n, row = {}) {
    const ep = { id: uuid(), experiment_id: exp.id, epoch_number: n, role_assignments: {}, spec_before: exp.current_spec, started_at: new Date(), completed_at: new Date(), cost_usd: 0, ...row }
    this.epochs.push(ep)
    return ep
  }

  spend(exp, cost, extra = {}) {
    this.modelCalls.push({ experiment_id: exp ? exp.id : null, epoch_number: null, purpose: 'epoch', model_id: 'm', cost_usd: cost, prompt_tokens: 0, completion_tokens: 0, budget_scope: null, created_at: new Date(), ...extra })
  }

  /** A row spent under the research cap (the mark the research epoch writes while the flag is on). */
  spendResearch(exp, cost, extra = {}) {
    this.spend(exp, cost, { budget_scope: 'research', ...extra })
  }

  // Any SELECT on experiments: the archive filter, the mode filter and the
  // ordering are read from the same SQL the lab sends.
  selectExperiments(text, v) {
    let rows = [...this.experiments]
    if (/WHERE (e\.)?id = \?/.test(text)) rows = rows.filter(e => e.id === v[0])
    if (/status = 'archived'/.test(text)) rows = rows.filter(e => e.status === 'archived')
    else if (/status (<>|!=) 'archived'/.test(text)) rows = rows.filter(e => e.status !== 'archived')
    if (/AND jsonb_typeof\((e\.)?current_spec->'meta'->'research'\) = 'object'/.test(text)) rows = rows.filter(isResearch)
    if (/AND jsonb_typeof\((e\.)?current_spec->'meta'->'research'\) IS DISTINCT FROM 'object'/.test(text)) rows = rows.filter(e => !isResearch(e))
    const byNewest = (a, b) => b.created_at - a.created_at
    if (/IS NOT DISTINCT FROM 'object'\) DESC, /.test(text)) rows.sort((a, b) => isResearch(b) - isResearch(a) || byNewest(a, b))
    else if (/ORDER BY \(jsonb_typeof\((e\.)?current_spec->'meta'->'research'\) IS NOT DISTINCT FROM 'object'\), /.test(text)) rows.sort((a, b) => isResearch(a) - isResearch(b) || byNewest(a, b))
    else rows.sort(byNewest)
    if (/LIMIT 1/.test(text)) rows = rows.slice(0, 1)
    return {
      rows: rows.map(e => {
        const own = this.epochs.filter(p => p.experiment_id === e.id).sort((a, b) => b.epoch_number - a.epoch_number)
        return {
          ...e, last_epoch_at: own[0]?.completed_at ?? null, recent_epochs: own.slice(0, 5),
          research: text.includes("jsonb_typeof(current_spec->'meta'->'research') AS research") ? (isResearch(e) ? 'object' : null) : e.current_spec?.meta?.research ?? null,
        }
      }),
    }
  }

  noActiveResearch() {
    return !this.experiments.some(e => e.status !== 'archived' && isResearch(e))
  }

  updateExperiments(text, v) {
    const set = (rows, changes) => { for (const e of rows) Object.assign(e, changes); return { rows: rows.map(e => ({ id: e.id, current_epoch: e.current_epoch })) } }
    const byId = id => this.experiments.filter(e => e.id === id)
    // claimEpoch
    if (text === "UPDATE experiments SET epoch_in_progress = TRUE, epoch_started_at = NOW() WHERE id = ? AND epoch_in_progress IS NOT TRUE AND status <> 'archived' RETURNING id") {
      return set(byId(v[0]).filter(e => e.epoch_in_progress !== true && e.status !== 'archived'), { epoch_in_progress: true, epoch_started_at: new Date() })
    }
    // releaseEpoch
    if (text === 'UPDATE experiments SET epoch_in_progress = FALSE, epoch_started_at = NULL WHERE id = ?') {
      set(byId(v[0]), { epoch_in_progress: false, epoch_started_at: null })
      return { rows: [] }
    }
    // clearStaleClaim
    if (text === 'UPDATE experiments SET epoch_in_progress = FALSE, epoch_started_at = NULL WHERE id = ? AND epoch_in_progress = TRUE AND (epoch_started_at IS NULL OR epoch_started_at < ?) RETURNING id') {
      const cutoff = new Date(v[1])
      return set(byId(v[0]).filter(e => e.epoch_in_progress === true && (!e.epoch_started_at || new Date(e.epoch_started_at) < cutoff)), { epoch_in_progress: false, epoch_started_at: null })
    }
    // ensureResearchExperiment: reactivate
    if (text === "UPDATE experiments SET status = 'growing', epoch_in_progress = FALSE, epoch_started_at = NULL, current_epoch = GREATEST(current_epoch, ?::int, ?::int), current_spec = COALESCE(?::jsonb, current_spec) WHERE id = ? AND status = 'archived' AND NOT EXISTS ( SELECT 1 FROM experiments x WHERE x.status <> 'archived' AND jsonb_typeof(x.current_spec->'meta'->'research') = 'object' ) RETURNING id, current_epoch") {
      const rows = this.noActiveResearch() ? byId(v[3]).filter(e => e.status === 'archived') : []
      for (const e of rows) {
        Object.assign(e, { status: 'growing', epoch_in_progress: false, epoch_started_at: null, current_epoch: Math.max(e.current_epoch, v[0], v[1]) })
        if (v[2] !== null) e.current_spec = JSON.parse(v[2])
      }
      return { rows: rows.map(e => ({ id: e.id, current_epoch: e.current_epoch })) }
    }
    // patch-research?archive=true: the research experiment only
    if (text === "UPDATE experiments SET status = 'archived', epoch_in_progress = FALSE, epoch_started_at = NULL WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object' RETURNING id, current_epoch") {
      return set(this.experiments.filter(e => e.status !== 'archived' && isResearch(e)), { status: 'archived', epoch_in_progress: false, epoch_started_at: null })
    }
    // the end of a research epoch, and a finished epoch whose experiment row was never advanced
    if (text === "UPDATE experiments SET current_spec = ?, current_epoch = ?, epoch_in_progress = FALSE, epoch_started_at = NULL, status = 'growing' WHERE id = ? AND status <> 'archived'") {
      set(byId(v[2]).filter(e => e.status !== 'archived'), { current_spec: JSON.parse(v[0]), current_epoch: v[1], epoch_in_progress: false, epoch_started_at: null, status: 'growing' })
      return { rows: [] }
    }
    throw new Error(`fake db: unsupported experiments update: ${text}`)
  }

  updateEpochs(text, values) {
    if (text.startsWith('UPDATE epochs SET research_run = NULL WHERE experiment_id = ? AND completed_at IS NULL AND started_at < ?')) {
      const cutoff = new Date(values[1])
      for (const e of this.epochs) {
        if (e.experiment_id === values[0] && !e.completed_at && new Date(e.started_at) < cutoff && e.research_run && !e.research_run.result) e.research_run = null
      }
      return { rows: [] }
    }
    const m = text.match(/^UPDATE epochs SET (.*) WHERE id = \?$/)
    if (!m) throw new Error(`fake db: unsupported epochs update: ${text}`)
    let i = 0
    const sets = m[1].split(', ').map(pair => {
      const [col, expr] = pair.split(' = ')
      return [col.trim(), expr.trim() === '?' ? values[i++] : expr.trim() === 'NOW()' ? new Date() : expr.trim()]
    })
    const ep = this.epochs.find(e => e.id === values[i])
    if (ep) for (const [col, val] of sets) ep[col] = decode(col, val)
    return { rows: [] }
  }

  spentSince(since, keep) {
    const total = this.modelCalls.filter(c => c.created_at >= since && keep(c)).reduce((s, c) => s + c.cost_usd, 0)
    return { rows: [{ total: String(total) }] }
  }

  handle(text, v) {
    this.queries.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }

    // Spend ledger
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, reasoning_tokens, budget_scope] = v
      assert.equal(v.length, 11, 'a ledger row has eleven values, the cap it was spent under last')
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, reasoning_tokens, budget_scope, created_at: new Date() })
      return { rows: [] }
    }
    // Today's spend under one cap: the rows marked research, or every other row.
    if (text.endsWith("FROM model_calls WHERE created_at >= ? AND budget_scope = 'research'")) {
      return this.spentSince(new Date(v[0]), c => c.budget_scope === 'research')
    }
    if (text.endsWith("FROM model_calls WHERE created_at >= ? AND budget_scope IS DISTINCT FROM 'research'")) {
      return this.spentSince(new Date(v[0]), c => c.budget_scope !== 'research')
    }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number = ?')) {
      const rows = this.modelCalls.filter(c => c.experiment_id === v[0] && c.epoch_number === v[1])
      const sum = k => rows.reduce((s, c) => s + (c[k] || 0), 0)
      return { rows: [{ cost_usd: sum('cost_usd'), prompt_tokens: sum('prompt_tokens'), completion_tokens: sum('completion_tokens') }] }
    }
    if (text.includes('FROM model_calls')) throw new Error(`fake db: unsupported ledger read: ${text}`)

    // Experiments
    if (text.startsWith('UPDATE experiments')) return this.updateExperiments(text, v)
    if (text.startsWith("INSERT INTO experiments (status, current_spec, current_epoch, epoch_in_progress, glass_shattered) SELECT 'seeding', ?::jsonb, ?::int, FALSE, FALSE WHERE NOT EXISTS")) {
      if (!this.noActiveResearch()) return { rows: [] }
      const exp = this.addExperiment({ created_at: new Date(), status: 'seeding', current_spec: JSON.parse(v[0]), current_epoch: v[1] })
      return { rows: [{ id: exp.id }] }
    }
    if (text.startsWith('INSERT INTO experiments')) {
      const exp = this.addExperiment({ created_at: new Date(), status: 'seeding', current_spec: JSON.parse(v[0]) })
      return { rows: [{ id: exp.id }] }
    }
    if (/^SELECT .* FROM experiments\b/.test(text)) return this.selectExperiments(text, v)
    if (/\bexperiments\b/.test(text) && !text.includes('experiment_id')) throw new Error(`fake db: unsupported experiments statement: ${text}`)

    // Epochs
    if (text.includes("followup->>'status' IN ('pending', 'awaiting_ci')")) return { rows: [] }
    if (text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND epoch_number = ? LIMIT 1')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number === v[1]) }
    }
    if (text.startsWith('SELECT epoch_number FROM epochs WHERE experiment_id = ? AND completed_at IS NULL AND (started_at > ? OR resumed_at > ?) ORDER BY epoch_number DESC LIMIT 1')) {
      const since = new Date(v[1])
      assert.equal(v[2], v[1])
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && !e.completed_at && (new Date(e.started_at) > since || (e.resumed_at && new Date(e.resumed_at) > since))).sort((a, b) => b.epoch_number - a.epoch_number).slice(0, 1) }
    }
    if (text.startsWith('SELECT epoch_number, spec_after FROM epochs WHERE experiment_id = ? AND epoch_number > ? AND completed_at IS NOT NULL AND spec_after IS NOT NULL AND commentator_output IS NOT NULL ORDER BY epoch_number DESC LIMIT 1')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number > v[1] && e.completed_at && e.spec_after && e.commentator_output).sort((a, b) => b.epoch_number - a.epoch_number).slice(0, 1) }
    }
    if (text.startsWith('SELECT epoch_number, spec_after FROM epochs')) throw new Error(`fake db: unsupported epochs read: ${text}`)
    if (text.includes('FROM epochs WHERE experiment_id = ? AND completed_at IS NULL') && !text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND completed_at IS NULL ORDER BY epoch_number DESC LIMIT 1')) {
      throw new Error(`fake db: unsupported epochs read: ${text}`)
    }
    if (text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND completed_at IS NULL ORDER BY epoch_number DESC LIMIT 1')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && !e.completed_at).sort((a, b) => b.epoch_number - a.epoch_number).slice(0, 1) }
    }
    if (text.startsWith('INSERT INTO epochs (experiment_id, epoch_number, role_assignments, spec_before) VALUES')) {
      const ep = { id: uuid(), experiment_id: v[0], epoch_number: v[1], role_assignments: JSON.parse(v[2]), spec_before: JSON.parse(v[3]), started_at: new Date(), completed_at: null, cost_usd: 0 }
      this.epochs.push(ep)
      return { rows: [{ id: ep.id }] }
    }
    if (text.startsWith('INSERT INTO epochs')) {
      // The seed row: epoch_number is the literal 0 in the SQL.
      this.epochs.push({ id: uuid(), experiment_id: v[0], epoch_number: 0, role_assignments: JSON.parse(v[1]), spec_before: JSON.parse(v[2]), spec_after: JSON.parse(v[3]), plant_geometry: JSON.parse(v[4]), started_at: new Date(), completed_at: new Date() })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE epochs')) return this.updateEpochs(text, v)
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
  alongside.resetResearchStateCache()
  for (const name of ['LAB_RESEARCH_ALONGSIDE', 'LAB_RESEARCH_DAILY_BUDGET_USD', 'LAB_DAILY_BUDGET_USD', 'EPOCH_INTERVAL_MINUTES', 'EPOCH_STALE_MINUTES', 'RESEARCH_RUN_POLL_MAX_MS']) delete process.env[name]
})

function classicSpec() {
  return {
    identity: { purpose: 'test agent', domain: null },
    capabilities: [], constraints: [], behaviors: [], conflicts: [],
    meta: { stability_score: 0.5, growth_stage: 'sprout', total_epochs: 3, total_mutations: 0, total_prunings: 0 },
  }
}

function researchSpec(researchMeta = {}) {
  return {
    identity: { purpose: 'research', domain: 'ml' },
    capabilities: [], constraints: [], behaviors: [], conflicts: [],
    meta: {
      stability_score: 0.2, growth_stage: 'seed', total_epochs: 77, total_mutations: 0, total_prunings: 0,
      research: { baseline_bpb: 0.72, best_bpb: 0.7, best_epoch: 40, target_bpb: 0.35, ...researchMeta },
    },
  }
}

/** Run 2 (classic, newer) with its last epoch just finished, so it is not due. */
function runTwo(row = {}) {
  const exp = lab.addExperiment({ current_epoch: 21, ...row })
  lab.addEpoch(exp, 21, { completed_at: new Date(Date.now() - 20 * 60_000) })
  return exp
}

/** The research experiment that stopped at epoch 77, created before run 2. */
function researchAt77(row = {}) {
  const exp = lab.addExperiment({ created_at: new Date(Date.now() - 40 * 86_400_000), current_epoch: 77, current_spec: researchSpec(), ...row })
  lab.addEpoch(exp, 77, { completed_at: new Date(Date.now() - 4 * 86_400_000) })
  return exp
}

function response() {
  return {
    code: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}
const cronTick = async () => {
  const res = response()
  await tick({ method: 'GET', headers: { authorization: `Bearer ${CRON}` }, query: {} }, res)
  return res
}
// The state route keeps the budget for a minute per instance; each read here
// uses a fresh copy of the route so a test never sees another test's budget.
let routeCopy = 0
const getState = async (query = {}) => {
  const res = response()
  alongside.resetResearchStateCache()
  const { default: route } = await import(`${pathToFileURL(join(build, 'api/experiment/index.js')).href}?copy=${++routeCopy}`)
  await route({ method: 'GET', headers: {}, query }, res)
  return res
}

// ---------------------------------------------------------------------------
// Fake OpenRouter, GitHub (the research repository) and research runner
// ---------------------------------------------------------------------------
const MODEL_IDS = ['google/gemini-4-hydrogen', 'deepseek/deepseek-v4-pro-0813', 'anthropic/claude-fable-5.2', 'openai/gpt-6-astra', 'x-ai/grok-4.7', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash']
const CATALOG = {
  data: MODEL_IDS.map(id => ({
    id, supported_parameters: ['max_tokens', 'reasoning', 'response_format'],
    reasoning: { supported_efforts: ['high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 128000 },
    pricing: { prompt: '0.000002', completion: '0.00001' },
  })),
}
const TRAIN_PY = `def train():\n    pass\n${'# filler line for a plausible file\n'.repeat(80)}print('RESULT {}')\n`
const LEDGER_HEADER = 'epoch\tcommit\tval_bpb\ttrain_steps\ttrain_seconds\tpeak_vram_mb\tparams_m\tstatus\thypothesis\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds'
const ledgerRow = (epoch, status, bpb) => `${epoch}\t${status === 'keep' ? 'merged' : 'reverted'}\t${bpb}\t100\t300.0\t9000\t10.000\t${status}\tsome hypothesis\texperiment_stdout_unverified\ttinystories\t-\t310.0`
const ledgerTo = last => [LEDGER_HEADER, ...Array.from({ length: last }, (_, i) => ledgerRow(i + 1, i + 1 === 40 ? 'keep' : 'discard', i + 1 === 40 ? '0.7000' : '0.7400'))].join('\n') + '\n'

/**
 * The outside world for one test. `files` is the research repository (path
 * to content), written to by PUTs; `model(body)` may answer a chat
 * completion itself (return a Response) before the research answers apply.
 */
function fakeWorld({ files = {}, model, github, wallSeconds = 400, metrics, runner } = {}) {
  const world = { files: { 'train.py': TRAIN_PY, 'wiki/index.md': '# Wiki\n', ...files }, puts: [], chats: [], runnerStarts: 0, runnerPolls: 0 }
  const answer = (body) => {
    const user = body.messages.at(-1).content
    const content = user.startsWith('Propose this epoch') ? { hypothesis: 'a warmup schedule lowers val_bpb', notebook: '' }
      : user.startsWith('Implement the experiment') ? { train_py: TRAIN_PY, change_summary: 'added warmup' }
      : user.startsWith('Stress-test') ? { challenges: [] }
      : user.startsWith('Rule: keep or revert') ? { verdict: 'revert', reason: 'did not beat the best' }
      : user.startsWith('Narrate this epoch') ? { summary: 'A run, measured, reverted.', mood: 'steady' }
      : null
    if (!content) throw new Error(`fake world: unexpected model request: ${user.slice(0, 60)}`)
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.5 } }))
  }
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    if (target === 'https://openrouter.ai/api/v1/models') return new Response(JSON.stringify(CATALOG))
    if (target === 'https://openrouter.ai/api/v1/chat/completions') {
      world.chats.push(body)
      return (model && await model(body)) || answer(body)
    }
    if (target.startsWith('https://runner.example/start')) {
      world.runnerStarts++
      return new Response(JSON.stringify({ call_id: 'call-1' }))
    }
    if (target.startsWith('https://runner.example/status')) {
      world.runnerPolls++
      const early = runner && runner()
      if (early) return new Response(JSON.stringify(early))
      return new Response(JSON.stringify({ status: 'done', result: {
        status: 'ok', metrics: metrics ?? { val_bpb: 0.74, train_steps: 100, train_seconds: 299, peak_vram_mb: 9000, params_m: 10, tokens_seen: 1 },
        metrics_source: 'experiment_stdout_unverified', dataset: 'tinystories', wall_seconds: wallSeconds, train_wall_seconds: 310,
      } }))
    }
    if (target.startsWith('https://api.github.com/repos/test-owner/Research-Lab/')) {
      if (github) { const early = await github(target, method); if (early) return early }
      const path = decodeURIComponent(target.split('/contents/')[1] ?? '').split('?')[0]
      if (method === 'PUT') {
        world.files[path] = Buffer.from(body.content, 'base64').toString('utf8')
        world.puts.push({ path, message: body.message })
        return new Response(JSON.stringify({ content: { sha: 'new' } }))
      }
      if (!(path in world.files)) return new Response('{}', { status: 404 })
      const bytes = Buffer.from(world.files[path], 'utf8')
      return new Response(JSON.stringify({ type: 'file', sha: `sha-${path}`, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }))
    }
    throw new Error(`Unexpected request ${method} ${target}`)
  }
  return world
}
const noNetwork = () => { globalThis.fetch = async (url) => { throw new Error(`no request expected: ${url}`) } }

// ===========================================================================
// 1. The flag and the two modes
// ===========================================================================
test('research alongside is off unless the flag is "true" (any capitalisation)', () => {
  assert.equal(modes.researchAlongside(), false)
  for (const value of ['1', 'yes', 'on', '']) {
    process.env.LAB_RESEARCH_ALONGSIDE = value
    assert.equal(modes.researchAlongside(), false, value)
  }
  for (const value of [' true ', 'TRUE', 'True']) {
    process.env.LAB_RESEARCH_ALONGSIDE = value
    assert.equal(modes.researchAlongside(), true, value)
  }
})

test('an experiment\'s mode is read from its stored spec', async () => {
  const classic = lab.addExperiment({})
  const researchExp = lab.addExperiment({ current_spec: researchSpec() })
  const nulled = lab.addExperiment({ current_spec: { meta: { research: null } } })
  assert.equal(await modes.experimentMode(classic.id), 'classic')
  assert.equal(await modes.experimentMode(researchExp.id), 'research')
  assert.equal(await modes.experimentMode(nulled.id), 'classic')
  assert.equal(await modes.experimentMode('00000000-0000-4000-8000-999999999999'), 'classic')
})

// ===========================================================================
// 2. Flag off: nothing different
// ===========================================================================
test('with the flag off the tick runs only the classic experiment, on the one budget, and never touches research', async () => {
  const researchExp = researchAt77() // active, left over from a time the flag was on
  const classic = runTwo()
  lab.spend(researchExp, 9)
  lab.spend(classic, 2)
  const before = JSON.stringify(researchExp)
  noNetwork()

  const res = await cronTick()
  assert.equal(res.code, 200)
  assert.equal(res.body.experiment_id, classic.id)
  assert.match(res.body.message, /^Waiting\. \d+ minutes until next epoch\.$/)
  assert.equal('research' in res.body, false)
  assert.equal(JSON.stringify(researchExp), before)
  // No research slot, no activation, no mode lookup, no split ledger read.
  for (const q of lab.queries) {
    assert.doesNotMatch(q.text, /= 'object' ORDER BY/, q.text)
    assert.doesNotMatch(q.text, /FROM model_calls m /, q.text)
  }

  // One cap over all spend, exactly as before the flag existed.
  const budget = await spend.checkDailyBudget()
  assert.deepEqual(Object.keys(budget).sort(), ['allowed', 'budget_usd', 'resumes_at', 'spent_usd'])
  assert.equal(budget.spent_usd, 11)
  assert.equal(budget.budget_usd, 15)
  assert.equal((await spend.checkDailyBudget(new Date(), 'research')).budget_usd, 15)
  assert.equal((await spend.checkDailyBudget(new Date(), 'research')).spent_usd, 11)
  assert.equal(lab.queries.filter(q => q.text.includes('FROM model_calls')).every(q => q.text.includes('FROM model_calls WHERE created_at >= ?')), true)

  // The room's state is the classic experiment, with no research field.
  const state = await getState()
  assert.equal(state.body.id, classic.id)
  assert.equal('research' in state.body, false)
  // The research state can still be read, and says why it is not moving.
  const side = await getState({ mode: 'research' })
  assert.equal(side.body.id, researchExp.id)
  assert.equal(side.body.run_state, 'paused: research alongside is off')
  assert.equal(side.body.alongside, false)
})

test('with the flag off and one experiment, the tick picks it whatever its mode, and no research starts', async () => {
  const archived = researchAt77({ status: 'archived' })
  const classic = runTwo()
  noNetwork()
  let res = await cronTick()
  assert.equal(res.body.experiment_id, classic.id)
  assert.equal(archived.status, 'archived')

  // Research on its own (the old way to run it) is still the experiment the tick and the room mean.
  lab = new FakeLab()
  const only = researchAt77()
  lab.epochs.at(-1).completed_at = new Date() // its last epoch just ended, so it is not due
  res = await cronTick()
  assert.equal(res.body.experiment_id, only.id)
  assert.equal((await getState()).body.id, only.id)
})

test('turning the flag off does not charge what research spent under its own cap to the classic experiment', async () => {
  // Earlier today, with the flag on, research spent $22 of its $40. Now the flag is off.
  const researchExp = researchAt77()
  const classic = runTwo()
  lab.spendResearch(researchExp, 21.88)
  lab.spendResearch(researchExp, 0.12, { model_id: 'tool/research_gpu_run' })
  lab.spend(classic, 3)
  noNetwork()

  const budget = await spend.checkDailyBudget()
  assert.deepEqual(Object.keys(budget).sort(), ['allowed', 'budget_usd', 'resumes_at', 'spent_usd'])
  assert.equal(budget.allowed, true)
  assert.equal(budget.spent_usd, 3)
  assert.equal(budget.budget_usd, 15)
  // The classic experiment's own scope is that same cap, with no mode lookup.
  assert.equal(await modes.budgetScopeFor(classic.id), 'classic')
  assert.equal(lab.queries.some(q => q.text.includes('AS research FROM experiments WHERE id = ?')), false)
  // Its public state is not paused, and neither is the tick.
  assert.equal((await getState()).body.run_state, 'waiting for next epoch')
  const res = await cronTick()
  assert.equal(res.code, 200)
  assert.match(res.body.message, /^Waiting\./)
  assert.equal('state' in res.body, false)

  // Past its own $15 the classic experiment still pauses, on its own spend.
  lab.spend(classic, 12.5)
  const over = await spend.checkDailyBudget()
  assert.equal(over.allowed, false)
  assert.equal(over.spent_usd, 15.5)
  assert.equal(over.reason, 'daily budget reached')

  // Back on, the same rows are the research cap's again.
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  assert.equal((await spend.checkDailyBudget(new Date(), 'research')).spent_usd, 22)
})

// ===========================================================================
// 3. Budgets
// ===========================================================================
test('with the flag on each mode has its own cap and counts only its own spend', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77()
  const classic = runTwo()
  const oldClassic = lab.addExperiment({ status: 'archived' })
  // Rows written under the research cap carry its mark; every other row does not.
  lab.spendResearch(researchExp, 20)
  lab.spendResearch(researchExp, 0.12, { model_id: 'tool/research_gpu_run' })
  lab.spend(classic, 6)
  lab.spend(oldClassic, 1)
  lab.spend(null, 0.5) // a row with no experiment counts as classic
  lab.spendResearch(researchExp, 99, { created_at: new Date(Date.now() - 3 * 86_400_000) }) // an earlier day

  const now = new Date()
  assert.equal(await spend.spentTodayUsd(now, 'research'), 20.12)
  assert.equal(await spend.spentTodayUsd(now, 'classic'), 7.5)
  assert.equal(await spend.spentTodayUsd(now), 7.5)

  let c = await spend.checkDailyBudget()
  assert.deepEqual({ allowed: c.allowed, spent: c.spent_usd, budget: c.budget_usd, scope: c.scope }, { allowed: true, spent: 7.5, budget: 15, scope: 'classic' })
  let r = await spend.checkDailyBudget(now, 'research')
  assert.deepEqual({ allowed: r.allowed, spent: r.spent_usd, budget: r.budget_usd, scope: r.scope }, { allowed: true, spent: 20.12, budget: 40, scope: 'research' })
  assert.equal(spend.DEFAULT_RESEARCH_DAILY_BUDGET_USD, 40)

  // Research over its cap: research waits, classic does not.
  process.env.LAB_RESEARCH_DAILY_BUDGET_USD = '20'
  r = await spend.checkDailyBudget(now, 'research')
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'research daily budget reached')
  assert.match(r.resumes_at, /T00:00:00\.000Z$/)
  assert.equal(spend.budgetPausedState(r), 'paused: research daily budget reached')
  assert.equal((await spend.checkDailyBudget()).allowed, true)

  // Classic over its cap: classic waits, research does not.
  process.env.LAB_RESEARCH_DAILY_BUDGET_USD = '40'
  process.env.LAB_DAILY_BUDGET_USD = '7'
  c = await spend.checkDailyBudget()
  assert.equal(c.allowed, false)
  assert.equal(c.reason, 'daily budget reached')
  assert.equal(spend.budgetPausedState(c), 'paused: daily budget reached')
  assert.equal((await spend.checkDailyBudget(now, 'research')).allowed, true)

  // A bad value falls back to the default; the scope follows the experiment.
  process.env.LAB_RESEARCH_DAILY_BUDGET_USD = 'lots'
  assert.equal(spend.researchDailyBudgetUsd(), 40)
  assert.equal(await modes.budgetScopeFor(researchExp.id), 'research')
  assert.equal(await modes.budgetScopeFor(classic.id), 'classic')
  process.env.LAB_RESEARCH_ALONGSIDE = 'false'
  assert.equal(await modes.budgetScopeFor(researchExp.id), 'classic')
})

test('a research run\'s GPU time is priced from the runner\'s measured time, or the whole budget when that is missing', () => {
  assert.equal(research.researchGpuCostUsd({ wall_seconds: 400 }, 300), 400 * 0.000306)
  assert.equal(research.researchGpuCostUsd({}, 300), (300 + 180) * 0.000306)
  assert.equal(research.researchGpuCostUsd({ wall_seconds: -1 }, 300), 480 * 0.000306)
})

// ===========================================================================
// 4. Bringing research back
// ===========================================================================
test('the archived research experiment is reactivated and its numbering carries on from 77', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const archived = researchAt77({ status: 'archived' })
  const olderResearch = lab.addExperiment({ status: 'archived', created_at: new Date(Date.now() - 90 * 86_400_000), current_epoch: 12, current_spec: researchSpec() })
  const classic = runTwo()
  const classicBefore = JSON.stringify(classic)
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })

  const result = await alongside.ensureResearchExperiment()
  assert.deepEqual(result, { activated: true, how: 'reactivated', experiment_id: archived.id, next_epoch: 78, ledger_last_epoch: 77 })
  assert.equal(archived.status, 'growing')
  assert.equal(archived.current_epoch, 77)
  assert.equal(archived.current_spec.meta.research.best_bpb, 0.7) // the spec and its best score are the ones it stopped with
  assert.equal(olderResearch.status, 'archived')
  assert.equal(JSON.stringify(classic), classicBefore)
  assert.equal(lab.experiments.filter(e => e.status !== 'archived').length, 2)
  assert.equal(lab.experiments.length, 3) // nothing was created

  // Asked again, it does nothing.
  const again = await alongside.ensureResearchExperiment()
  assert.equal(again.activated, false)
  assert.equal(again.experiment_id, archived.id)
})

test('numbering never goes back behind the ledger, and an unreadable ledger starts nothing', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const archived = researchAt77({ status: 'archived' })
  // A GPU call from long ago is forgotten; a recent one is kept so its result can still be collected.
  const oldOpen = lab.addEpoch(archived, 78, { completed_at: null, started_at: new Date(Date.now() - 10 * 86_400_000), research_run: { call_id: 'expired' } })
  runTwo()

  // The repository cannot be read: no activation, the experiment stays archived.
  fakeWorld({ github: () => new Response('boom', { status: 502 }) })
  let result = await alongside.ensureResearchExperiment()
  assert.equal(result.activated, false)
  assert.match(result.reason, /ledger could not be read/)
  assert.equal(archived.status, 'archived')

  // An epoch that started minutes ago may still be running on the archived row (a reset just now): wait for it.
  const justStarted = lab.addEpoch(archived, 79, { completed_at: null, started_at: new Date(Date.now() - 5 * 60_000) })
  fakeWorld({ files: { 'results.tsv': ledgerTo(79) } })
  result = await alongside.ensureResearchExperiment()
  assert.equal(result.activated, false)
  assert.match(result.reason, /epoch 79 may still be running/)
  assert.equal(archived.status, 'archived')
  justStarted.started_at = new Date(Date.now() - 2 * 86_400_000)
  justStarted.research_run = { call_id: 'recent enough to collect' }

  // The same epoch picked up again by a later request (its started_at is days
  // old, its resumed_at is minutes old) is still running: wait for that too.
  justStarted.resumed_at = new Date(Date.now() - 5 * 60_000)
  result = await alongside.ensureResearchExperiment()
  assert.equal(result.activated, false)
  assert.match(result.reason, /epoch 79 may still be running/)
  assert.equal(archived.status, 'archived')
  justStarted.resumed_at = new Date(Date.now() - 3 * 60 * 60_000)

  // The ledger is a little ahead of the experiment (rows 78 and 79 exist): continue after it.
  result = await alongside.ensureResearchExperiment()
  assert.equal(result.activated, true)
  assert.equal(result.next_epoch, 80)
  assert.equal(archived.current_epoch, 79)
  assert.equal(archived.current_spec.meta.research.best_bpb, 0.7) // rows 78 and 79 kept nothing: the spec is untouched
  assert.equal(oldOpen.research_run, null)
  assert.deepEqual(justStarted.research_run, { call_id: 'recent enough to collect' })
  assert.ok(logs.some(l => /results\.tsv is at epoch 79, past the experiment's 77/.test(l)))

  assert.deepEqual(alongside.summarizeLedger(ledgerTo(77)), { last_epoch: 77, best_kept: { epoch: 40, val_bpb: 0.7 } })
  assert.deepEqual(alongside.summarizeLedger(''), { last_epoch: 0, best_kept: null })
  // 2,326 repeated rows for one epoch (run 1's ledger) do not move the last epoch.
  assert.equal(alongside.summarizeLedger(ledgerTo(20) + (ledgerRow(20, 'discard', '0.7400') + '\n').repeat(50)).last_epoch, 20)
  assert.equal(alongside.summarizeLedger(`${LEDGER_HEADER}\n5\treverted\t-\t-\t-\t-\t-\tcrash\tx\n`).best_kept, null)
  // Kept scores can be read from a later epoch on only, and with a floor.
  assert.equal(alongside.summarizeLedger(ledgerTo(77), { keptAfter: 40 }).best_kept, null)
  assert.deepEqual(alongside.summarizeLedger(ledgerTo(77), { keptAfter: 39 }).best_kept, { epoch: 40, val_bpb: 0.7 })
  assert.equal(alongside.summarizeLedger(ledgerTo(77), { minBpb: 0.71 }).best_kept, null)
})

test('a ledger far ahead of the experiment, or lines not shaped like the lab\'s rows, start nothing and count for nothing', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const archived = researchAt77({ status: 'archived' })
  runTwo()
  const before = JSON.stringify(archived)

  // Three epochs past the experiment is more than one request can have written.
  fakeWorld({ files: { 'results.tsv': ledgerTo(80) } })
  let result = await alongside.ensureResearchExperiment()
  assert.equal(result.activated, false)
  assert.equal(result.experiment_id, archived.id)
  assert.match(result.reason, /results\.tsv is at epoch 80, more than 2 past the research experiment's epoch 77/)
  assert.equal(JSON.stringify(archived), before)
  assert.ok(logs.some(l => /not starting research: results\.tsv is at epoch 80, more than 2 past the experiment's 77/.test(l)))

  // A row in the lab's own shape with a number nobody reached: the same answer, and the tick says so.
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) + ledgerRow(999999, 'keep', '0.0001') + '\n' } })
  const res = await cronTick()
  assert.equal(res.code, 200)
  assert.equal(res.body.research.message, 'No active research experiment')
  assert.match(res.body.research.activation.reason, /more than 2 past/)
  assert.equal(JSON.stringify(archived), before)

  // Lines that are not rows as appendResultsRow writes them are not read at all.
  const good = ledgerTo(77)
  const notRows = [
    '999999999\tmerged\t0.0001\t1\t1.0\t1\t1.000\tkeep\tx\t-\t-\t-\t-',                 // an epoch number with more than six digits
    '500\tmerged\t0.0001\t1\t1.0\t1\t1.000\tkeep\tx\t-\t-\t-\t-\t300.0\t9000\t10.000\tdiscard\th', // too many columns (a row split in two)
    '500\tmerged\t0.0001\t1\t1.0\t1\t1.000\tkeep',                                       // too few
    '500\tmerged\t-\t1\t1.0\t1\t1.000\tkeep\tx',                                          // kept with no score
    '500\treverted\t0.0001\t1\t1.0\t1\t1.000\tkeep\tx',                                   // kept but not merged
    '500\tmerged\t1e-4\t1\t1.0\t1\t1.000\tkeep\tx',                                       // a score not written the lab's way
    '500\tmerged\t0.0001\t1\t1.0\t1\t1.000\tbest\tx',                                     // an unknown status
    '500\tpushed\t0.0001\t1\t1.0\t1\t1.000\tkeep\tx',                                     // an unknown commit word
  ]
  for (const line of notRows) {
    assert.deepEqual(alongside.summarizeLedger(`${good}${line}\n`), { last_epoch: 77, best_kept: { epoch: 40, val_bpb: 0.7 } }, line)
  }
  // Both real shapes are read: nine columns (before the provenance columns) and thirteen.
  assert.deepEqual(alongside.summarizeLedger(`${good}78\tmerged\t0.6900\t1\t1.0\t1\t1.000\tkeep\tx\n`), { last_epoch: 78, best_kept: { epoch: 78, val_bpb: 0.69 } })
})

test('what the generated train.py prints cannot add a row to results.tsv', async () => {
  // The runner passes the printed metrics on after checking only val_bpb.
  const forged = '5\n999999999\tmerged\t0.0001\t1\t1.0\t1\t1.000\tkeep\tx\t-\t-\t-\t-'
  assert.deepEqual(research.sanitizeRunResult({ status: 'ok', metrics: { val_bpb: 1.2, train_steps: forged, train_seconds: '9\n9', peak_vram_mb: null, params_m: Infinity, extra: 'x' }, wall_seconds: '400', log_tail: 7, dataset: 'tinystories' }),
    { status: 'ok', metrics: { val_bpb: 1.2 }, dataset: 'tinystories' })
  // A real result comes through unchanged.
  const real = { status: 'ok', metrics: { val_bpb: 0.74, train_steps: 100, train_seconds: 299.5, peak_vram_mb: 9000, params_m: 10.72, tokens_seen: 1 }, metrics_source: 'experiment_stdout_unverified', dataset: 'tinystories', harness_sha256: 'a'.repeat(64), budget_s: 300, train_wall_seconds: 310.2, gpu: 'A10G', log_tail: 'done', wall_seconds: 400.5 }
  assert.deepEqual(research.sanitizeRunResult(real), real)
  // No usable score: not a result. A status the runner never sends: an infrastructure error.
  assert.deepEqual(research.sanitizeRunResult({ status: 'ok', metrics: { val_bpb: '1.2' } }), { status: 'crash', error: 'the run reported no usable val_bpb' })
  assert.deepEqual(research.sanitizeRunResult({ status: 'ok' }), { status: 'crash', error: 'the run reported no usable val_bpb' })
  assert.deepEqual(research.sanitizeRunResult({ status: 'crash', error: 'boom', stage: 'train' }), { status: 'crash', error: 'boom', stage: 'train' })
  assert.deepEqual(research.sanitizeRunResult({ status: 'keep\n1' }), { status: 'infra_error' })
  assert.deepEqual(research.sanitizeRunResult(null), { status: 'infra_error' })

  // The row writer itself writes "-" for anything that is not a number, whatever it is handed.
  const world = fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })
  await research.appendResultsRow({
    epoch: 78, commit: 'reverted', val_bpb: 1.2, train_steps: forged, train_seconds: '300\t1', peak_vram_mb: NaN, params_m: null,
    status: 'discard', hypothesis: 'a\tb\nc', provenance: { metrics_source: 'experiment_stdout_unverified', dataset: 'tinystories', harness_sha256: null, train_wall_seconds: 310 },
  })
  let lines = world.files['results.tsv'].trim().split('\n')
  assert.equal(lines.length, 79)
  assert.equal(lines.at(-1), '78\treverted\t1.2000\t-\t-\t-\t-\tdiscard\ta b c\texperiment_stdout_unverified\ttinystories\t-\t310.0')
  assert.deepEqual(alongside.summarizeLedger(world.files['results.tsv']), { last_epoch: 78, best_kept: { epoch: 40, val_bpb: 0.7 } })

  // The whole way: an epoch whose run printed the forged value writes one row, numbered 78.
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77()
  runTwo()
  const run = fakeWorld({ files: { 'results.tsv': ledgerTo(77) }, metrics: { val_bpb: 0.74, train_steps: forged, train_seconds: 299, peak_vram_mb: 9000, params_m: 10 } })
  const res = await cronTick()
  assert.equal(res.body.research.epoch_number, 78, JSON.stringify(res.body))
  lines = run.files['results.tsv'].trim().split('\n')
  assert.equal(lines.length, 79)
  assert.equal(lines.at(-1).split('\t').length, 13)
  assert.match(lines.at(-1), /^78\treverted\t0\.7400\t-\t299\.0\t9000\t10\.000\tdiscard\t/)
  assert.equal(alongside.summarizeLedger(run.files['results.tsv']).last_epoch, 78)
  // What was stored for the epoch is the cleaned result.
  const stored = lab.epochs.find(e => e.experiment_id === researchExp.id && e.epoch_number === 78).research_run.result
  assert.deepEqual(stored.metrics, { val_bpb: 0.74, train_seconds: 299, peak_vram_mb: 9000, params_m: 10 })
})

test('an epoch that finished on the archived experiment is taken over, and a score the ledger kept after that is the one to beat', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'

  // 1. Epoch 78 was running when the experiment was archived. It finished into
  //    the archived row (train.py, ledger row, wiki page, its epochs row), but
  //    the experiment row stayed at 77 with the spec from before.
  let archived = researchAt77({ status: 'archived' })
  const after78 = researchSpec({ best_bpb: 0.69, best_epoch: 78, last_run: { epoch: 78, val_bpb: 0.69, verdict: 'keep', status: 'ok', hypothesis: 'h' } })
  after78.meta.total_epochs = 78
  lab.addEpoch(archived, 78, { started_at: new Date(Date.now() - 3 * 86_400_000), completed_at: new Date(Date.now() - 3 * 86_400_000), spec_after: after78, commentator_output: { summary: 's', mood: 'm' } })
  runTwo()
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) + ledgerRow(78, 'keep', '0.6900') + '\n' } })
  let result = await alongside.ensureResearchExperiment()
  assert.deepEqual(result, { activated: true, how: 'reactivated', experiment_id: archived.id, next_epoch: 79, ledger_last_epoch: 78 })
  assert.equal(archived.current_epoch, 78)
  assert.deepEqual(archived.current_spec, after78)
  assert.ok(logs.some(l => /epoch 78 had finished on the archived experiment \(it stopped at 77\); took its result over/.test(l)))

  // 2. Epoch 78 wrote train.py and its ledger row (kept, 0.6800) and then the
  //    request died: its epochs row never finished. The spec still says 0.70.
  lab = new FakeLab()
  archived = researchAt77({ status: 'archived' })
  lab.addEpoch(archived, 78, { completed_at: null, started_at: new Date(Date.now() - 3 * 86_400_000) })
  const classic = runTwo()
  const world = fakeWorld({
    files: { 'results.tsv': ledgerTo(77) + ledgerRow(78, 'keep', '0.6800') + '\n' },
    // The next run scores 0.69: better than the stale 0.70, worse than what train.py now holds.
    metrics: { val_bpb: 0.69, train_steps: 100, train_seconds: 299, peak_vram_mb: 9000, params_m: 10 },
    model: (body) => {
      if (body.messages.at(-1).content.startsWith('Rule: keep or revert')) {
        return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify({ verdict: 'keep', reason: 'beats the best' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.5 } }))
      }
    },
  })
  const res = await cronTick()
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.equal(res.body.research.activation.next_epoch, 79)
  assert.equal(res.body.research.epoch_number, 79)
  assert.equal(res.body.experiment_id, classic.id)
  assert.ok(logs.some(l => /results\.tsv kept 0\.6800 at epoch 78/.test(l)))
  // The keep was overturned against 0.68: train.py is not overwritten with a worse one.
  assert.equal(world.puts.some(p => p.path === 'train.py'), false)
  assert.match(world.files['results.tsv'].trim().split('\n').at(-1), /^79\treverted\t0\.6900\t/)
  const epoch79 = lab.epochs.find(e => e.experiment_id === archived.id && e.epoch_number === 79)
  assert.equal(epoch79.reviewer_output.verdict, 'revert')
  assert.equal(archived.current_epoch, 79)
  assert.equal(archived.current_spec.meta.research.best_bpb, 0.68)
  assert.equal(archived.current_spec.meta.research.best_epoch, 78)

  // 3. Kept rows at or before the experiment's own epoch are its history, already in
  //    its spec (or set aside by a re-baseline): they do not change the best score.
  //    Nor does a kept score below the target.
  lab = new FakeLab()
  archived = researchAt77({ status: 'archived', current_spec: researchSpec({ best_bpb: 0.72, best_epoch: 60 }) })
  lab.addEpoch(archived, 78, { completed_at: null, started_at: new Date(Date.now() - 3 * 86_400_000) })
  runTwo()
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) + ledgerRow(78, 'keep', '0.0001') + '\n' } })
  result = await alongside.ensureResearchExperiment()
  assert.equal(result.activated, true)
  assert.equal(archived.current_epoch, 78)
  assert.equal(archived.current_spec.meta.research.best_bpb, 0.72)
  assert.equal(archived.current_spec.meta.research.best_epoch, 60)
})

test('with no research experiment in the database a new one is seeded after the ledger\'s last epoch', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const classic = runTwo()
  const classicBefore = JSON.stringify(classic)
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })

  const result = await alongside.ensureResearchExperiment()
  assert.equal(result.activated, true)
  assert.equal(result.how, 'seeded')
  assert.equal(result.next_epoch, 78)
  const seeded = lab.experiments.find(e => e.id === result.experiment_id)
  assert.equal(seeded.current_epoch, 77)
  assert.equal(seeded.current_spec.meta.total_epochs, 77)
  assert.deepEqual(seeded.current_spec.meta.research, { baseline_bpb: 0.7236, best_bpb: 0.7, best_epoch: 40, target_bpb: 0.35 })
  assert.equal(lab.epochs.filter(e => e.experiment_id === seeded.id).map(e => e.epoch_number).join(), '0')
  assert.equal(JSON.stringify(classic), classicBefore)
  // The seeded experiment is the newer row, and the room still means run 2.
  assert.ok(seeded.created_at > classic.created_at)
  assert.equal((await modes.loadTickExperiment('primary')).id, classic.id)
  assert.equal((await getState()).body.id, classic.id)

  // With the flag off it never activates anything.
  process.env.LAB_RESEARCH_ALONGSIDE = 'false'
  seeded.status = 'archived'
  assert.equal((await alongside.ensureResearchExperiment()).activated, false)
  assert.equal(seeded.status, 'archived')

  // A kept score below the target is not taken as the best: the seed keeps its own baseline.
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  lab = new FakeLab()
  runTwo()
  fakeWorld({ files: { 'results.tsv': `${LEDGER_HEADER}\n${ledgerRow(1, 'discard', '0.7400')}\n${ledgerRow(2, 'keep', '0.0001')}\n` } })
  const second = await alongside.ensureResearchExperiment()
  assert.equal(second.how, 'seeded')
  assert.equal(second.next_epoch, 3)
  assert.deepEqual(lab.experiments.find(e => e.id === second.experiment_id).current_spec.meta.research, { baseline_bpb: 0.7236, best_bpb: 0.7236, best_epoch: 0, target_bpb: 0.35 })
})

// ===========================================================================
// 5. The tick advances both, independently
// ===========================================================================
test('one tick reactivates research and runs epoch 78 while the classic experiment keeps its own rhythm', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77({ status: 'archived' })
  const classic = runTwo()
  const classicBefore = JSON.stringify(classic)
  const world = fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })

  const res = await cronTick()
  assert.equal(res.code, 200, JSON.stringify(res.body))
  // Classic: the same answer the tick has always given, at the top level.
  assert.equal(res.body.experiment_id, classic.id)
  assert.match(res.body.message, /^Waiting\. \d+ minutes until next epoch\.$/)
  assert.equal(JSON.stringify(classic), classicBefore)
  // Research: reactivated and advanced in the same request.
  assert.equal(res.body.research.activation.how, 'reactivated')
  assert.equal(res.body.research.epoch_number, 78)
  assert.equal(res.body.research.experiment_id, researchExp.id)
  assert.equal('north' in res.body.research, false)
  assert.equal(researchExp.current_epoch, 78)
  assert.equal(researchExp.epoch_in_progress, false)
  assert.equal(researchExp.current_spec.meta.research.last_run.epoch, 78)

  // The repository record continues: row 78 after row 77, page epoch-078.
  const rows = world.files['results.tsv'].trim().split('\n')
  assert.equal(rows.length, 79)
  assert.match(rows.at(-1), /^78\treverted\t0\.7400\t/)
  assert.deepEqual(world.puts.map(p => p.path), ['results.tsv', 'wiki/findings/epoch-078.md'])
  assert.equal(world.runnerStarts, 1)

  // Every cost of the epoch is on the ledger under the research experiment,
  // the GPU time included as an estimate, and none of it counts as classic.
  const mine = lab.modelCalls.filter(c => c.experiment_id === researchExp.id)
  assert.equal(mine.length, lab.modelCalls.length)
  assert.equal(mine.every(c => c.epoch_number === 78), true)
  assert.equal(mine.every(c => c.budget_scope === 'research'), true) // spent under the research cap, and marked so
  const gpu = mine.filter(c => c.model_id === 'tool/research_gpu_run')
  assert.equal(gpu.length, 1)
  assert.equal(gpu[0].cost_source, 'estimate')
  assert.equal(gpu[0].cost_usd, 400 * 0.000306)
  assert.equal(await spend.spentTodayUsd(new Date(), 'classic'), 0)
  assert.equal(await spend.spentTodayUsd(new Date(), 'research'), 5 * 0.5 + 400 * 0.000306)
  const epoch78 = lab.epochs.find(e => e.experiment_id === researchExp.id && e.epoch_number === 78)
  assert.equal(Number(epoch78.cost_usd), 5 * 0.5 + 400 * 0.000306)

  // The next tick: research waits for its own interval, measured from its own last epoch.
  const next = await cronTick()
  assert.match(next.body.research.message, /^Waiting\. \d+ minutes until next epoch\.$/)
  assert.equal(next.body.research.experiment_id, researchExp.id)
})

test('the GPU estimate is not written while the flag is off', async () => {
  const only = researchAt77()
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })
  const res = await cronTick()
  assert.equal(res.body.epoch_number, 78)
  assert.equal(only.current_epoch, 78)
  assert.equal(lab.modelCalls.some(c => c.model_id === 'tool/research_gpu_run'), false)
  assert.equal(lab.modelCalls.length, 5)
  // Nothing is marked, the resumed-at stamp is not written, and the one cap counts every row.
  assert.equal(lab.modelCalls.every(c => c.budget_scope === null), true)
  assert.equal(lab.queries.some(q => q.text.includes('resumed_at')), false)
  assert.equal((await spend.checkDailyBudget()).spent_usd, 2.5)
})

test('classic over its cap waits while research runs; research over its cap waits while classic is unaffected', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77()
  const classic = lab.addExperiment({ current_epoch: 21 }) // no finished epoch: due now
  const world = fakeWorld({ files: { 'results.tsv': ledgerTo(77) }, model: (body) => {
    if (body.messages.at(-1).content.startsWith('What direction')) throw new Error('the classic epoch must not start')
  } })

  // Classic has spent its $15; research has spent $30 of its $40.
  lab.spend(classic, 15.5)
  lab.spendResearch(researchExp, 30)
  let res = await cronTick()
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.equal(res.body.state, 'paused: daily budget reached')
  assert.equal(res.body.experiment_id, classic.id)
  assert.match(res.body.resumes_at, /T00:00:00\.000Z$/)
  assert.equal(classic.current_epoch, 21)
  assert.equal(res.body.research.epoch_number, 78)
  assert.equal(researchExp.current_epoch, 78)
  assert.ok(logs.some(l => /\[CRON\] Skipping epoch 22: daily budget reached \(\$15\.50 of \$15\.00/.test(l)), logs.join('\n'))

  // Now research passes its own cap. Its next epoch is due (pretend 78 ended long ago).
  lab.epochs.find(e => e.experiment_id === researchExp.id && e.epoch_number === 78).completed_at = new Date(Date.now() - 300 * 60_000)
  lab.spendResearch(researchExp, 10)
  const chatsBefore = world.chats.length
  res = await cronTick()
  assert.equal(res.code, 200)
  assert.equal(res.body.research.state, 'paused: research daily budget reached')
  assert.equal(res.body.research.message, 'Skipped: research daily budget reached')
  assert.match(res.body.research.resumes_at, /T00:00:00\.000Z$/)
  assert.equal(researchExp.current_epoch, 78)
  assert.equal(researchExp.epoch_in_progress, false)
  assert.equal(world.chats.length, chatsBefore)
  assert.ok(logs.some(l => /\[CRON research\] Skipping epoch 79: research daily budget reached \(\$4\d\.\d\d of \$40\.00/.test(l)), logs.join('\n'))

  // The public states say so, each for itself, with no dollar amounts.
  const state = await getState()
  assert.equal(state.body.id, classic.id)
  assert.equal(state.body.run_state, 'paused: daily budget reached')
  assert.equal(state.body.research.run_state, 'paused: research daily budget reached')
  assert.match(state.body.research.resumes_at, /T00:00:00\.000Z$/)
  const side = await getState({ mode: 'research' })
  assert.equal(side.body.run_state, 'paused: research daily budget reached')
  assert.match(side.body.resumes_at, /T00:00:00\.000Z$/)
  assert.doesNotMatch(JSON.stringify({ a: state.body.research, b: side.body.run_state, c: side.body.resumes_at }), /\$|spent|budget_usd/)
})

test('a failure in one experiment leaves the other\'s tick intact', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77()
  const classic = runTwo()

  // Research fails (its repository is down): classic still gets its answer, the request reports the failure.
  fakeWorld({ github: () => new Response('boom', { status: 502 }) })
  let res = await cronTick()
  assert.equal(res.code, 500)
  assert.deepEqual(res.body.research, { error: 'Epoch processing failed' })
  assert.equal(res.body.experiment_id, classic.id)
  assert.match(res.body.message, /^Waiting\./)
  assert.equal(researchExp.epoch_in_progress, false) // its claim was released
  assert.equal(classic.epoch_in_progress, false)

  // Classic fails (its Planner gets no usable answer): research still completes its epoch.
  lab.epochs.find(e => e.experiment_id === classic.id).completed_at = new Date(Date.now() - 300 * 60_000)
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) }, model: (body) => {
    if (!/^(Propose this epoch|Implement the experiment|Stress-test|Rule: keep or revert|Narrate this epoch)/.test(body.messages.at(-1).content)) {
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: 'not json' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }))
    }
  } })
  res = await cronTick()
  assert.equal(res.code, 500)
  assert.equal(res.body.error, 'Epoch processing failed')
  assert.equal(res.body.research.epoch_number, 78)
  assert.equal(researchExp.current_epoch, 78)
  assert.equal(classic.current_epoch, 21)
  assert.equal(classic.epoch_in_progress, false)
  // The failed classic calls were billed to classic, not to research.
  assert.ok(lab.modelCalls.some(c => c.experiment_id === classic.id))
  assert.equal(await spend.spentTodayUsd(new Date(), 'research'), 5 * 0.5 + 400 * 0.000306)
})

test('claims and stale limits are per experiment', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  process.env.EPOCH_STALE_MINUTES = '50'
  const researchExp = researchAt77({ epoch_in_progress: true, epoch_started_at: new Date(Date.now() - 10 * 60_000) })
  const classic = runTwo({ epoch_in_progress: true, epoch_started_at: new Date(Date.now() - 90 * 60_000) })
  noNetwork()

  // Research is mid-epoch (10 minutes): left alone. Classic's claim is 90 minutes old: cleared.
  const res = await cronTick()
  assert.equal(res.code, 200)
  assert.equal(res.body.research.message, 'Epoch already in progress')
  assert.equal(res.body.research.minutes_in_progress, 10)
  assert.equal(researchExp.epoch_in_progress, true)
  assert.equal(classic.epoch_in_progress, false)
  assert.ok(logs.some(l => l.includes(`[CRON] Cleared stale epoch flag after 90 minutes for experiment ${classic.id}`)))

  // One experiment's claim never blocks the other's.
  assert.equal(await claim.claimEpoch(classic.id), true)
  assert.equal(await claim.claimEpoch(classic.id), false)
  await claim.releaseEpoch(researchExp.id)
  assert.equal(await claim.claimEpoch(researchExp.id), true)
  assert.equal(classic.epoch_in_progress, true)
})

// ===========================================================================
// 6. Public state, the operator trigger and the graph
// ===========================================================================
test('GET /api/experiment stays the classic experiment; research is a field beside it and a state of its own', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77({ epoch_in_progress: true, epoch_started_at: new Date() })
  lab.addEpoch(researchExp, 78, { completed_at: null, research_run: { call_id: 'call-1' } })
  const classic = runTwo()
  noNetwork()

  const off = { ...process.env }
  delete process.env.LAB_RESEARCH_ALONGSIDE
  const plain = (await getState()).body
  process.env.LAB_RESEARCH_ALONGSIDE = off.LAB_RESEARCH_ALONGSIDE

  const state = (await getState()).body
  // Everything the room reads is what it was with the flag off; only `research` is new.
  const { research: summary, ...rest } = state
  assert.deepEqual(rest, plain)
  assert.equal(state.id, classic.id)
  assert.equal(state.current_spec.meta.research, undefined)
  assert.deepEqual(summary, {
    id: researchExp.id, status: 'growing', current_epoch: 77, epoch_in_progress: true, gpu_running: true,
    run_state: 'running epoch', baseline_bpb: 0.72, best_bpb: 0.7, best_epoch: 40, target_bpb: 0.35, last_run: null,
  })

  const side = await getState({ mode: 'research' })
  assert.equal(side.code, 200)
  assert.equal(side.body.mode, 'research')
  assert.equal(side.body.alongside, true)
  assert.equal(side.body.id, researchExp.id)
  assert.equal(side.body.current_epoch, 77)
  assert.equal(side.body.run_state, 'running epoch')
  assert.equal(side.body.current_spec.meta.research.best_bpb, 0.7)
  assert.equal(side.body.recent_epochs[0].epoch_number, 78)
  for (const key of ['growth', 'tool_runs', 'repo_commit_count', 'research']) assert.equal(key in side.body, false, key)

  // No research experiment: the classic state has no field, and the research state is a 404.
  researchExp.status = 'archived'
  alongside.resetResearchStateCache()
  assert.equal('research' in (await getState()).body, false)
  const none = await getState({ mode: 'research' })
  assert.equal(none.code, 404)
  assert.deepEqual(none.body, { error: 'No active research experiment' })
})

test('the knowledge graph and the operator routes mean the classic experiment, even when research is the newer row', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const classic = runTwo()
  const researchExp = lab.addExperiment({ created_at: new Date(), current_epoch: 77, current_spec: researchSpec() }) // newer than run 2
  lab.addEpoch(researchExp, 77, { completed_at: new Date() })
  noNetwork()

  const res = response()
  await graphRoute({ method: 'GET', headers: {}, query: {} }, res)
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.equal(res.body.experiment_id, classic.id)
  // Every row the graph read belongs to the classic experiment.
  const reads = lab.queries.filter(q => /FROM (epochs|code_contributions|tool_runs) WHERE experiment_id = \?/.test(q.text))
  assert.ok(reads.length >= 2)
  for (const q of reads) assert.equal(q.values[0], classic.id, q.text)

  assert.equal(await modes.activeExperimentId('research'), researchExp.id)
  assert.equal(await modes.activeExperimentId('classic'), classic.id)
  assert.equal((await modes.loadTickExperiment('primary')).id, classic.id)
  assert.equal((await modes.loadTickExperiment('research')).id, researchExp.id)

  // Each route that picks "the experiment" orders the classic one first.
  const ORDER = "ORDER BY (jsonb_typeof(current_spec->'meta'->'research') IS NOT DISTINCT FROM 'object'), created_at DESC"
  for (const file of ['api/experiment/graph.ts', 'api/experiment/activity.ts', 'api/experiment/code-contributions.ts',
    'api/experiment/wildcard-transcripts.ts', 'api/experiment/shatter.ts', 'api/experiment/patch-identity.ts',
    'api/north/run.ts', 'api/epoch/run.ts']) {
    assert.ok(readFileSync(join(root, file), 'utf8').includes(ORDER), file)
  }
  // No route is left that takes the newest active row whatever its mode.
  const leftovers = []
  const scan = dir => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (path.endsWith('.ts') && /status (<>|!=) 'archived'\s+ORDER BY (e\.)?created_at DESC/.test(readFileSync(join(root, path), 'utf8'))) leftovers.push(path)
    }
  }
  scan('api')
  // The one that remains is the seed route's "is anything active at all" check with the flag off.
  assert.deepEqual(leftovers, ['api/experiment/index.ts'])
  assert.equal(readFileSync(join(root, 'api/experiment/index.ts'), 'utf8').match(/status (<>|!=) 'archived'\s+ORDER BY (e\.)?created_at DESC/g).length, 1)

  // Seeding a classic experiment is refused only by another classic one.
  const auth = { authorization: `Bearer ${OPERATOR}` }
  let post = response()
  await experimentRoute({ method: 'POST', headers: auth, query: {} }, post)
  assert.equal(post.code, 400)
  assert.equal(post.body.experiment_id, classic.id)
  classic.status = 'archived'
  post = response()
  await experimentRoute({ method: 'POST', headers: auth, query: {} }, post)
  assert.equal(post.code, 201)
  assert.equal(researchExp.status, 'growing')
})

test('POST /api/epoch/run?mode=research runs the research experiment; without it, the classic one', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77()
  const classic = runTwo({ epoch_in_progress: true, epoch_started_at: new Date() })
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })
  const auth = { authorization: `Bearer ${OPERATOR}` }

  let res = response()
  await runRoute({ method: 'POST', headers: auth, query: {} }, res)
  assert.equal(res.code, 409)
  assert.equal(res.body.experiment_id, classic.id)

  res = response()
  await runRoute({ method: 'POST', headers: auth, query: { mode: 'research' } }, res)
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.equal(res.body.experiment_id, researchExp.id)
  assert.equal(res.body.epoch_number, 78)

  process.env.LAB_RESEARCH_DAILY_BUDGET_USD = '1'
  res = response()
  await runRoute({ method: 'POST', headers: auth, query: { mode: 'research' } }, res)
  assert.equal(res.code, 429)
  assert.equal(res.body.error, 'paused: research daily budget reached')

  researchExp.status = 'archived'
  res = response()
  await runRoute({ method: 'POST', headers: auth, query: { mode: 'research' } }, res)
  assert.equal(res.code, 404)

  // With the flag off the parameter is refused, and nothing runs.
  researchExp.status = 'growing'
  delete process.env.LAB_RESEARCH_ALONGSIDE
  res = response()
  await runRoute({ method: 'POST', headers: auth, query: { mode: 'research' } }, res)
  assert.equal(res.code, 400)
  assert.equal(researchExp.current_epoch, 78)
})

test('a GPU run still training when the request stops waiting is not a failed tick, and the next tick collects it', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  process.env.RESEARCH_RUN_POLL_MAX_MS = '0' // stop waiting at once
  const researchExp = researchAt77()
  const classic = runTwo()
  const world = fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })

  let res = await cronTick()
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.research, { message: 'GPU run still in progress; resumes next tick', experiment_id: researchExp.id, epoch_number: 78 })
  assert.equal(res.body.experiment_id, classic.id)
  assert.equal(researchExp.epoch_in_progress, false) // the claim was released
  assert.equal(researchExp.current_epoch, 77)
  const epoch78 = lab.epochs.find(e => e.experiment_id === researchExp.id && e.epoch_number === 78)
  assert.equal(epoch78.research_run.call_id, 'call-1')
  assert.equal(epoch78.resumed_at, undefined) // made by this request, not picked up again
  assert.equal(world.runnerStarts, 1)
  assert.equal(logs.some(l => /\[CRON research\] Error in epoch tick/.test(l)), false)
  assert.ok(logs.some(l => l.includes('[CRON research] Epoch 78: GPU run still in progress; resumes next tick')))
  // The room's state shows the run as open only while a request holds the epoch.
  assert.equal((await getState()).body.research.epoch_in_progress, false)

  // The operator's trigger answers the same way: 202, not 500.
  const auth = { authorization: `Bearer ${OPERATOR}` }
  let manual = response()
  await runRoute({ method: 'POST', headers: auth, query: { mode: 'research' } }, manual)
  assert.equal(manual.code, 202)
  assert.deepEqual(manual.body, { message: 'GPU run still in progress; resumes next tick', experiment_id: researchExp.id, epoch_number: 78 })
  assert.ok(epoch78.resumed_at instanceof Date) // that request picked the epoch up again, and said so

  // Next tick, with time to wait: the same call is collected, no second run starts.
  delete process.env.RESEARCH_RUN_POLL_MAX_MS
  epoch78.resumed_at = undefined
  res = await cronTick()
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.equal(res.body.research.epoch_number, 78)
  assert.equal(world.runnerStarts, 1)
  assert.equal(researchExp.current_epoch, 78)
  assert.ok(epoch78.resumed_at instanceof Date)

  // A real failure is still a 500 (covered above); and with the flag off the
  // tick answers as it always did for a run that outlasts the wait.
  delete process.env.LAB_RESEARCH_ALONGSIDE
  process.env.RESEARCH_RUN_POLL_MAX_MS = '0'
  lab = new FakeLab()
  const only = researchAt77()
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })
  res = await cronTick()
  assert.equal(res.code, 500)
  assert.deepEqual(res.body, { error: 'Epoch processing failed' })
  assert.equal(only.epoch_in_progress, false)
})

test('reset?mode=research is refused while the flag is on, and nothing is archived', async () => {
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  const researchExp = researchAt77()
  const classic = runTwo()
  noNetwork()
  const before = JSON.stringify([researchExp, classic])
  const queriesBefore = lab.queries.length
  const res = response()
  await resetRoute({ method: 'POST', headers: { authorization: `Bearer ${OPERATOR}` }, query: { confirm: 'true', mode: 'research' } }, res)
  assert.equal(res.code, 409)
  assert.match(res.body.error, /refused while LAB_RESEARCH_ALONGSIDE is on/)
  assert.equal(JSON.stringify([researchExp, classic]), before)
  assert.equal(lab.queries.length, queriesBefore) // the database was not touched
  assert.equal(lab.experiments.length, 2)
})

test('patch-research?archive=true archives the research experiment only, and only while the flag is off', async () => {
  const auth = { authorization: `Bearer ${OPERATOR}` }
  const call = async (query) => {
    const res = response()
    await patchResearchRoute({ method: 'POST', headers: auth, query, body: {} }, res)
    return res
  }
  const researchExp = researchAt77({ epoch_in_progress: true, epoch_started_at: new Date() })
  const classic = runTwo()
  const classicBefore = JSON.stringify(classic)
  noNetwork()

  // With the flag on the tick would bring it straight back: refused.
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  let res = await call({ confirm: 'true', archive: 'true' })
  assert.equal(res.code, 409)
  assert.equal(researchExp.status, 'growing')

  delete process.env.LAB_RESEARCH_ALONGSIDE
  assert.equal((await call({ archive: 'true' })).code, 400) // no confirm
  assert.equal((await call({ confirm: 'true', archive: 'yes' })).code, 400)
  assert.equal(researchExp.status, 'growing')

  res = await call({ confirm: 'true', archive: 'true' })
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body, { success: true, archived: [{ id: researchExp.id, current_epoch: 77 }] })
  assert.equal(researchExp.status, 'archived')
  assert.equal(researchExp.epoch_in_progress, false)
  assert.equal(JSON.stringify(classic), classicBefore) // run 2 is not touched
  assert.equal((await getState()).body.id, classic.id)

  // Nothing left to archive.
  assert.equal((await call({ confirm: 'true', archive: 'true' })).code, 404)
  assert.equal(JSON.stringify(classic), classicBefore)

  // Turned on again, the tick brings that same experiment back at 78.
  process.env.LAB_RESEARCH_ALONGSIDE = 'true'
  fakeWorld({ files: { 'results.tsv': ledgerTo(77) } })
  const back = await alongside.ensureResearchExperiment()
  assert.equal(back.how, 'reactivated')
  assert.equal(back.experiment_id, researchExp.id)
  assert.equal(back.next_epoch, 78)
})

// ===========================================================================
// 7. Documentation
// ===========================================================================
test('the flag and the cap are documented with their defaults', () => {
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  assert.match(env, /^LAB_RESEARCH_ALONGSIDE=false$/m)
  assert.match(env, /^LAB_RESEARCH_DAILY_BUDGET_USD=40$/m)
  const ops = readFileSync(join(root, 'docs/OPERATIONS.md'), 'utf8')
  for (const needle of ['LAB_RESEARCH_ALONGSIDE', 'LAB_RESEARCH_DAILY_BUDGET_USD', '/api/experiment?mode=research', 'paused: research daily budget reached',
    'budget_scope', 'resumed_at', 'patch-research?confirm=true&archive=true', 'more than 2 past', 'SEPARATE RESEARCH', 'GPU run still in progress; resumes next tick']) {
    assert.ok(ops.includes(needle), needle)
  }
  // The way to archive research alone is not the reset, and the docs say what the reset does.
  assert.doesNotMatch(ops, /To archive it as well, use the reset/)
  assert.match(ops, /the reset ends run 2 too/)
  assert.match(readFileSync(join(root, 'api/_lib/schema.sql'), 'utf8'), /budget_scope TEXT/)
  // Visitor-facing and owner-facing text here uses no em dashes.
  const section = ops.slice(ops.indexOf('## Research beside run 2'))
  assert.ok(section.length > 500)
  assert.doesNotMatch(section.slice(0, section.indexOf('\n## ', 5) === -1 ? undefined : section.indexOf('\n## ', 5)), /—/)
})
