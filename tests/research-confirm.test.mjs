// How the lab scores results: LAB_RESEARCH_CONFIRM (a run is repeated by the
// lab before it becomes the best, and the run-to-run noise is measured) and
// LAB_TINKER_ORIGIN_LABELS (where a Tinker run's examples came from).
//
// What is checked: the margin rule (beats, within noise, crash, no noise
// yet), the noise estimate and its ceiling (one wild pair of scores cannot
// lift the margin), when a control run is due (one per tick at most, every N
// epochs), that nothing differs while the switches are off, what a repeat
// does when the cap is reached or the runner cannot be asked, the
// results.tsv header as it gains the new columns, the origin labels and
// their summary, the public state, and the documents.
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
const build = mkdtempSync(join(tmpdir(), 'observable-research-confirm-test-'))
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
for (const path of ['src/systems/TrainedChatPanel.ts', 'src/systems/paperTheme.ts']) {
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
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder' // read once at import
process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'
process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
process.env.RESEARCH_RUNNER_TOKEN = 'test-only-runner-token-0000000000000000'
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
const confirm = await load('api/_lib/research-confirm.js')
const research = await load('api/_lib/research.js')
const researchEpoch = await load('api/_lib/research-epoch.js')
const researchAlongside = await load('api/_lib/research-alongside.js')
const researchPrompts = await load('api/_lib/research-prompts.js')
const openrouter = await load('api/_lib/openrouter.js')
const tinker = await load('api/_lib/tinker.js')
const tinkerStore = await load('api/_lib/tinker-store.js')
const scoring = await load('api/_lib/scoring.js')
const growth = await load('api/_lib/growth.js')
const chatPanel = await load('src/systems/TrainedChatPanel.js')
const { default: scoringRoute } = await load('api/experiment/scoring.js')

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
    nextId = 1
    this.experiments = []
    this.epochs = []
    this.modelCalls = []
    this.repeats = []
    this.tinkerRuns = null // null: the table does not exist
    this.statements = []
    this.failRepeats = false
    this.spentToday = 0 // what the spend ledger says was spent today, under whichever cap is asked about
  }

  handle(text, v) {
    this.statements.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }

    // The lab's repeat runs
    if (text.includes('research_repeats') && this.failRepeats) throw new Error('database is away')
    if (text === 'SELECT * FROM research_repeats WHERE experiment_id = ? ORDER BY id DESC LIMIT ?') {
      return { rows: this.repeats.filter(r => r.experiment_id === v[0]).sort((a, b) => b.id - a.id).slice(0, v[1]).map(r => ({ ...r })) }
    }
    if (text.startsWith('INSERT INTO research_repeats (experiment_id, epoch_number, kind, train_sha256, reference_bpb, reference_epoch, call_id, status) VALUES')) {
      assert.match(text, /ON CONFLICT \(experiment_id, epoch_number, kind\) DO NOTHING RETURNING \*$/)
      const [experiment_id, epoch_number, kind, train_sha256, reference_bpb, reference_epoch, call_id, status] = v
      if (this.repeats.some(r => r.experiment_id === experiment_id && r.epoch_number === epoch_number && r.kind === kind)) return { rows: [] }
      const row = { id: Math.max(0, ...this.repeats.map(r => Number(r.id))) + 1, created_at: new Date(), experiment_id, epoch_number, kind, train_sha256, reference_bpb, reference_epoch, call_id, status, val_bpb: null, result: null, cost_usd: null, ledger_written: false, finished_at: null }
      this.repeats.push(row)
      return { rows: [{ ...row }] }
    }
    if (text === 'UPDATE research_repeats SET status = ?, val_bpb = ?, result = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = ? RETURNING *') {
      const row = this.repeats.find(r => String(r.id) === String(v[4]) && r.status === v[5])
      if (!row) return { rows: [] }
      Object.assign(row, { status: v[0], val_bpb: v[1], result: v[2], cost_usd: v[3], finished_at: new Date() })
      return { rows: [{ ...row }] }
    }
    if (text === 'UPDATE research_repeats SET call_id = ?, status = ? WHERE id = ? AND status = ? RETURNING *') {
      const row = this.repeats.find(r => String(r.id) === String(v[2]) && r.status === v[3])
      if (!row) return { rows: [] }
      Object.assign(row, { call_id: v[0], status: v[1] })
      return { rows: [{ ...row }] }
    }
    if (text === 'DELETE FROM research_repeats WHERE id = ? AND status = ?') {
      this.repeats = this.repeats.filter(r => !(String(r.id) === String(v[0]) && r.status === v[1]))
      return { rows: [] }
    }
    if (text === 'UPDATE research_repeats SET ledger_written = TRUE WHERE id = ?') {
      this.repeats.find(r => String(r.id) === String(v[0])).ledger_written = true
      return { rows: [] }
    }
    if (text.includes('research_repeats')) throw new Error(`fake db: unsupported statement: ${text}`)

    // Tinker runs, for the origin summary
    if (text === 'SELECT * FROM tinker_runs ORDER BY created_at DESC LIMIT ?') {
      if (this.tinkerRuns === null) throw new Error('relation "tinker_runs" does not exist')
      return { rows: this.tinkerRuns.slice(0, v[0]) }
    }

    // The spend ledger
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, , , , budget_scope] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, budget_scope })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) return { rows: [{ total: String(this.spentToday) }] }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number = ?')) {
      const rows = this.modelCalls.filter(c => c.experiment_id === v[0] && c.epoch_number === v[1])
      return { rows: [{ cost_usd: rows.reduce((s, c) => s + c.cost_usd, 0), prompt_tokens: 0, completion_tokens: 0 }] }
    }

    // Experiments and epochs, as one research epoch and the public state use them
    if (text === 'SELECT * FROM experiments WHERE id = ?') return { rows: this.experiments.filter(e => e.id === v[0]) }
    if (text.startsWith("SELECT id, current_spec->'meta'->'research' AS research FROM experiments WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object'")) {
      return { rows: this.experiments.filter(e => e.status !== 'archived').map(e => ({ id: e.id, research: e.current_spec.meta.research })).slice(0, 1) }
    }
    if (text.startsWith("SELECT id, status, current_epoch, epoch_in_progress, current_spec->'meta'->'research' AS research FROM experiments")) {
      return { rows: this.experiments.map(e => ({ ...e, research: e.current_spec.meta.research })).slice(0, 1) }
    }
    if (text.startsWith("SELECT id FROM experiments WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') IS DISTINCT FROM 'object'")) return { rows: [] }
    if (text.startsWith('UPDATE experiments SET current_spec = ?, current_epoch = ?')) {
      const e = this.experiments.find(x => x.id === v[2])
      Object.assign(e, { current_spec: JSON.parse(v[0]), current_epoch: v[1], epoch_in_progress: false })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE experiments SET epoch_in_progress = FALSE')) return { rows: [] }
    if (/\bexperiments\b/.test(text) && !text.includes('experiment_id')) throw new Error(`fake db: unsupported experiments statement: ${text}`)
    if (text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND epoch_number = ? LIMIT 1')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number === v[1]).map(e => JSON.parse(JSON.stringify(e))) }
    }
    if (text.startsWith('INSERT INTO epochs (experiment_id, epoch_number, role_assignments, spec_before) VALUES')) {
      const ep = { id: uuid(), experiment_id: v[0], epoch_number: v[1], role_assignments: JSON.parse(v[2]), spec_before: JSON.parse(v[3]), completed_at: null }
      this.epochs.push(ep)
      return { rows: [{ id: ep.id }] }
    }
    if (text.startsWith('UPDATE epochs')) {
      const ep = this.epochs.find(e => e.id === v[v.length - 1])
      // The lab's verdict is merged into the stored run, leaving what is there.
      if (text === "UPDATE epochs SET research_run = COALESCE(research_run, '{}'::jsonb) || ?::jsonb WHERE id = ?") {
        ep.research_run = { ...(ep.research_run ?? {}), ...JSON.parse(v[0]) }
        return { rows: [] }
      }
      const m = text.match(/^UPDATE epochs SET (.*) WHERE id = \?$/)
      if (!m) throw new Error(`fake db: unsupported epochs update: ${text}`)
      let i = 0
      for (const pair of m[1].split(', ')) {
        const [col, expr] = pair.split(' = ')
        ep[col.trim()] = decode(col.trim(), expr.trim() === '?' ? v[i++] : expr.trim() === 'NOW()' ? new Date().toISOString() : expr.trim())
      }
      return { rows: [] }
    }
    return { rows: [] }
  }
}

let lab
function freshLab() {
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  return lab
}
beforeEach(() => {
  freshLab()
  logs = []
  process.env = { ...BASE_ENV }
  openrouter.resetModelCatalog()
  confirm.resetRepeatsTable()
  scoring.resetScoringCache()
  researchAlongside.resetResearchStateCache()
})

const enable = (extra = {}) => Object.assign(process.env, { LAB_RESEARCH_CONFIRM: 'true', ...extra })
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
async function getScoring(method = 'GET') {
  const res = response()
  await scoringRoute({ method, headers: {}, query: {} }, res)
  return res
}

const MODEL_IDS = ['google/gemini-4-hydrogen', 'deepseek/deepseek-v4-pro-0813', 'anthropic/claude-fable-5.2', 'openai/gpt-6-astra', 'x-ai/grok-4.7', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash']
const CATALOG = {
  data: MODEL_IDS.map(id => ({
    id, supported_parameters: ['max_tokens', 'reasoning', 'response_format'],
    reasoning: { supported_efforts: ['high', 'medium', 'low'] }, top_provider: { max_completion_tokens: 128000 },
    pricing: { prompt: '0.000002', completion: '0.00001' },
  })),
}
const TRAIN_PY = `def train():\n    pass\n${'# filler line for a plausible file\n'.repeat(80)}print('RESULT {}')\n`
const NEW_TRAIN_PY = TRAIN_PY.replace('pass', 'return 1')
const LEDGER_9 = 'epoch\tcommit\tval_bpb\ttrain_steps\ttrain_seconds\tpeak_vram_mb\tparams_m\tstatus\thypothesis'
const LEDGER_13 = `${LEDGER_9}\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds`
const LEDGER_14 = `${LEDGER_13}\trunner_flow`
const LEDGER_19 = `${LEDGER_14}\trepeat_val_bpb\tmean_val_bpb\tnoise_bpb\tmargin_bpb\tconfirm`

function researchExperiment(meta = {}) {
  const exp = {
    id: EXPERIMENT, status: 'growing', current_epoch: 80, epoch_in_progress: true,
    current_spec: {
      identity: { purpose: 'research', domain: 'ml' }, capabilities: [], constraints: [], behaviors: [], conflicts: [],
      meta: { stability_score: 0.2, growth_stage: 'seed', total_epochs: 80, total_mutations: 0, total_prunings: 0,
        research: { baseline_bpb: 0.72, best_bpb: 0.7, best_epoch: 40, target_bpb: 0.35, ...meta } },
    },
  }
  lab.experiments.push(exp)
  return exp
}

/**
 * OpenRouter, the research repository and the runner. `runs` is what each
 * call to the runner answers, in the order the runs are started: a number
 * (its val_bpb), 'crash', 'running', 'failed' (the runner says the call
 * failed), or 'http502' and 'unreachable' (the status endpoint could not be
 * read). `verdict` is the Reviewer's.
 */
function fakeWorld({ verdict = 'keep', runs = [0.69], files = {} } = {}) {
  const world = { starts: [], polls: [], chats: [], files: { 'train.py': TRAIN_PY, 'wiki/index.md': '# Wiki\n', ...files }, puts: [], messages: {}, runs, verdict, requests: [] }
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    world.requests.push(`${options.method || 'GET'} ${target} ${options.body ?? ''}`)
    if (target === 'https://openrouter.ai/api/v1/models') return new Response(JSON.stringify(CATALOG))
    if (target === 'https://openrouter.ai/api/v1/chat/completions') {
      world.chats.push(body)
      const user = body.messages.at(-1).content
      const content = user.startsWith('Propose this epoch') ? { hypothesis: 'a warmup schedule lowers val_bpb', notebook: '' }
        : user.startsWith('Implement the experiment') ? { train_py: NEW_TRAIN_PY, change_summary: 'added warmup' }
        : user.startsWith('Stress-test') ? { challenges: [] }
        : user.startsWith('Rule: keep or revert') ? { verdict: world.verdict, reason: 'the number decided' }
        : { summary: 'A run, measured.', mood: 'steady' }
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 } }))
    }
    if (target === 'https://runner.example/start') {
      world.starts.push(body)
      return new Response(JSON.stringify({ call_id: `call-${world.starts.length}` }))
    }
    if (target.startsWith('https://runner.example/status')) {
      const callId = new URL(target).searchParams.get('call_id')
      world.polls.push(callId)
      const outcome = world.runs[Number(callId.split('-')[1]) - 1]
      if (outcome === 'running' || outcome === undefined) return new Response(JSON.stringify({ status: 'running' }))
      // The status endpoint itself cannot be read: a gateway error, or no answer at all. Says nothing about the run.
      if (outcome === 'http502') return new Response('Bad Gateway', { status: 502 })
      if (outcome === 'unreachable') throw new TypeError('fetch failed')
      if (outcome === 'failed') return new Response(JSON.stringify({ status: 'failed', error: 'run result expired before it was collected' }))
      const result = outcome === 'crash'
        ? { status: 'crash', stage: 'train', error: 'boom', wall_seconds: 60 }
        : { status: 'ok', metrics: { val_bpb: outcome, train_steps: 100, train_seconds: 299, params_m: 10.9 }, metrics_source: 'experiment_stdout_unverified', dataset: 'tinystories_gpt4_clean', wall_seconds: 400, train_wall_seconds: 310 }
      return new Response(JSON.stringify({ status: 'done', result }))
    }
    if (target.startsWith('https://api.github.com/repos/test-owner/Research-Lab/')) {
      const path = decodeURIComponent(target.split('/contents/')[1] ?? '').split('?')[0]
      if ((options.method || 'GET') === 'PUT') {
        world.files[path] = Buffer.from(body.content, 'base64').toString('utf8')
        world.puts.push(path)
        world.messages[path] = body.message
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
const runEpoch = () => researchEpoch.runResearchEpoch(EXPERIMENT)
const researchMeta = () => lab.experiments[0].current_spec.meta.research
const ledgerRows = world => world.files['results.tsv'].trimEnd().split('\n')
/** The Reviewer's verdict and reason, without the record of which model answered. */
const said = ({ verdict, reason }) => ({ verdict, reason })
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`)

// ===========================================================================
// 1. The switches and the arithmetic
// ===========================================================================
test('both switches are off unless exactly "true", and the numbers have their documented defaults and bounds', () => {
  for (const value of [undefined, '', 'false', '1', 'yes', 'on']) {
    if (value === undefined) { delete process.env.LAB_RESEARCH_CONFIRM; delete process.env.LAB_TINKER_ORIGIN_LABELS } else Object.assign(process.env, { LAB_RESEARCH_CONFIRM: value, LAB_TINKER_ORIGIN_LABELS: value })
    assert.equal(confirm.researchConfirmEnabled(), false, String(value))
    assert.equal(tinker.tinkerOriginFlag(), false, String(value))
  }
  Object.assign(process.env, { LAB_RESEARCH_CONFIRM: ' true ', LAB_TINKER_ORIGIN_LABELS: 'true' })
  assert.equal(confirm.researchConfirmEnabled(), true)
  assert.equal(tinker.tinkerOriginFlag(), true)

  assert.equal(confirm.DEFAULT_MIN_MARGIN_BPB, 0.002)
  assert.equal(confirm.DEFAULT_MAX_MARGIN_BPB, 0.05)
  assert.equal(confirm.researchMaxMargin(), 0.05)
  for (const [raw, ceiling] of [['0.02', 0.02], ['0', 0], ['1', 1], ['1.5', 0.05], ['-0.1', 0.05], ['none', 0.05], ['NaN', 0.05], ['Infinity', 0.05]]) {
    process.env.LAB_RESEARCH_MAX_MARGIN = raw
    assert.equal(confirm.researchMaxMargin(), ceiling, raw)
  }
  assert.equal(confirm.DEFAULT_CONTROL_EVERY, 10)
  assert.equal(confirm.NOISE_MIN_SAMPLES, 3)
  assert.equal(confirm.researchMinMargin(), 0.002)
  assert.equal(confirm.researchControlEvery(), 10)
  for (const [raw, margin] of [['0.005', 0.005], ['0', 0], ['1', 1], ['1.5', 0.002], ['-0.1', 0.002], ['a lot', 0.002], ['NaN', 0.002], ['Infinity', 0.002]]) {
    process.env.LAB_RESEARCH_MIN_MARGIN = raw
    assert.equal(confirm.researchMinMargin(), margin, raw)
  }
  for (const [raw, every] of [['5', 5], ['1', 1], ['0', 1], ['-3', 1], ['5000', 1000], ['2.5', 10], ['often', 10]]) {
    process.env.LAB_RESEARCH_CONTROL_EVERY = raw
    assert.equal(confirm.researchControlEvery(), every, raw)
  }
})

test('the noise is the median spread of each file\'s runs about their own middle, every run counted once, and is not measured until three repeated scores exist', () => {
  const K = confirm.PAIR_DISTANCE_TO_SD
  assert.equal(K, 1.0483)
  // The factor that turns a file's median distance from its middle into a standard deviation, by how many runs it has.
  assert.equal(confirm.madToSd(2), 2 * K) // a pair: half its distance, times 2 x 1.0483, as when the noise was a median of pair distances
  assert.deepEqual([3, 4, 5, 10].map(confirm.madToSd), [2.77, 2.21, 1.99, 1.68])
  close(confirm.madToSd(20), 1.4826 * 1.06)
  for (const odd of [0, 1, 2.5, NaN]) assert.ok(Number.isNaN(confirm.madToSd(odd)), String(odd))
  // Nothing, one score, and one pair: not measured, with the count it has.
  assert.deepEqual(confirm.estimateNoise([]), { noise_bpb: null, samples: 0, groups: 0 })
  assert.deepEqual(confirm.estimateNoise([[0.7]]), { noise_bpb: null, samples: 0, groups: 0 })
  assert.deepEqual(confirm.estimateNoise([[0.7, 0.702]]), { noise_bpb: null, samples: 2, groups: 1 })
  // Single scores of different files say nothing about spread, however many there are.
  assert.deepEqual(confirm.estimateNoise([[0.7], [0.69], [0.68], [0.67]]), { noise_bpb: null, samples: 0, groups: 0 })
  // Three runs of one file: distances from its middle score 0.702 of 0.002, 0 and 0.002, whose median is 0.002, scaled for three runs.
  let n = confirm.estimateNoise([[0.700, 0.702, 0.704]])
  close(n.noise_bpb, 2.77 * 0.002)
  assert.deepEqual([n.samples, n.groups], [3, 1])
  // Two pairs of different files, far apart in level: only the distance inside each pair counts.
  n = confirm.estimateNoise([[0.700, 0.702], [0.600, 0.604], [0.9]])
  close(n.noise_bpb, K * 0.003)
  assert.deepEqual([n.samples, n.groups], [4, 2])
  // Identical scores are a measured noise of zero, and what is not a number is left out.
  assert.deepEqual(confirm.estimateNoise([[0.5, 0.5, 0.5, NaN, null, 'x']]), { noise_bpb: 0, samples: 3, groups: 1 })

  // From stored repeats: a confirmation gives two scores, a control one, grouped by the file's hash.
  const row = (id, kind, sha, val, ref, status = 'ok') => ({ id: String(id), kind, train_sha256: sha.repeat(64), val_bpb: val, reference_bpb: ref, status, epoch_number: id })
  assert.deepEqual(confirm.noiseFromRepeats([row(1, 'control', 'a', 0.701, 0.7)]), { noise_bpb: null, samples: 0, groups: 0 })
  // A control's reference (the best on record) is not a repeated score; a confirmation's reference (its first run) is.
  n = confirm.noiseFromRepeats([row(1, 'control', 'a', 0.700, 0.9), row(2, 'control', 'a', 0.702, 0.9), row(3, 'control', 'a', 0.704, 0.9)])
  close(n.noise_bpb, 2.77 * 0.002)
  n = confirm.noiseFromRepeats([row(1, 'confirm', 'b', 0.702, 0.700), row(2, 'control', 'b', 0.704, 0.701)])
  close(n.noise_bpb, 2.77 * 0.002)
  assert.equal(n.samples, 3)
  // Runs that gave no score, are still running, or have no usable hash are left out.
  n = confirm.noiseFromRepeats([row(1, 'confirm', 'b', 0.702, 0.700), row(2, 'control', 'b', null, 0.7, 'crash'), row(3, 'control', 'b', null, 0.7, 'running'), { ...row(4, 'control', 'b', 0.9, 0.7), train_sha256: 'short' }])
  assert.deepEqual([n.noise_bpb, n.samples], [null, 2])
  // Only the newest NOISE_WINDOW finished repeats count.
  const many = Array.from({ length: confirm.NOISE_WINDOW + 5 }, (_, i) => row(i + 1, 'control', 'c', i < 5 ? 5 : 0.5, 0.5))
  assert.equal(confirm.noiseFromRepeats(many).noise_bpb, 0)
})

test('one wild pair of scores cannot move the noise among quiet runs, and can never lift the margin above the ceiling', () => {
  const K = confirm.PAIR_DISTANCE_TO_SD
  const row = (id, kind, sha, val, ref) => ({ id: String(id), kind, train_sha256: sha.repeat(64), val_bpb: val, reference_bpb: ref, status: 'ok', epoch_number: id })
  // A train.py that printed 0.10 and then 4.90, beside three quiet controls of the best file: two spreads,
  // the quiet file's counted three times and the wild pair's twice, and the middle is the quiet one.
  const quiet = [row(1, 'control', 'a', 0.700, 0.7), row(2, 'control', 'a', 0.702, 0.7), row(3, 'control', 'a', 0.704, 0.7)]
  const wild = row(4, 'confirm', 'b', 4.90, 0.10)
  let n = confirm.noiseFromRepeats([...quiet, wild])
  close(n.noise_bpb, 2.77 * 0.002)
  assert.equal(n.samples, 5)
  assert.deepEqual(confirm.marginFor(n, 0.002).basis, 'noise')
  close(confirm.marginFor(n, 0.002).margin_bpb, 2 * 2.77 * 0.002)

  // One wild score inside the group of controls (one control diverged) does not set that file's spread:
  // 0.7001, 0.7003 and 0.95 are 0.0002, 0 and 0.2497 from their middle, and the median of those is 0.0002.
  const diverged = [row(1, 'control', 'a', 0.7001, 0.7001), row(2, 'control', 'a', 0.7003, 0.7001), row(3, 'control', 'a', 0.95, 0.7001)]
  n = confirm.noiseFromRepeats(diverged)
  close(n.noise_bpb, 2.77 * 0.0002)
  assert.deepEqual(confirm.marginFor(n, 0.002), { margin_bpb: 0.002, basis: 'floor' })
  // With a quiet confirmation pair beside it the margin is still the floor, and a real improvement repeats into a new best.
  n = confirm.noiseFromRepeats([...diverged, row(4, 'confirm', 'd', 0.6905, 0.6900)])
  assert.ok(n.noise_bpb < 0.001, String(n.noise_bpb))
  assert.equal(confirm.marginFor(n, 0.002).basis, 'floor')
  assert.equal(confirm.decideConfirmation({ first: 0.6900, repeat: 0.6902, repeatStatus: 'ok', best: 0.7001, noise: n, minMargin: 0.002 }).verdict, 'confirmed')
  // Distances between every two scores, as the noise was taken before, would have put that margin at the ceiling.
  const pairwise = [0.0002, 0.2499, 0.2497].sort((a, b) => a - b)[1] * K
  assert.ok(2 * pairwise > 0.05)
  // With only one quiet pair beside it the middle is far out (2.4 before scaling), and the ceiling is what holds.
  n = confirm.noiseFromRepeats([row(1, 'control', 'a', 0.70, 0.7), row(2, 'control', 'a', 0.70, 0.7), wild])
  close(n.noise_bpb, K * 2.4)
  assert.deepEqual(confirm.marginFor(n, 0.002), { margin_bpb: 0.05, basis: 'ceiling' })
  assert.deepEqual(confirm.marginFor(n, 0.002, 0.02), { margin_bpb: 0.02, basis: 'ceiling' })
  // Whatever scores are printed, however many of them, the margin is never above the ceiling.
  for (const spread of [0.03, 1, 50, 1e9]) {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, 'confirm', String.fromCharCode(97 + (i % 6)), spread * (i + 1), 0))
    const margin = confirm.marginFor(confirm.noiseFromRepeats(rows), 0.002)
    assert.ok(margin.margin_bpb <= 0.05, String(spread))
    assert.equal(margin.basis, 'ceiling')
  }
  // The floor always holds: a ceiling below it counts as the floor, and a nonsense ceiling as the default.
  assert.deepEqual(confirm.marginFor(n, 0.1, 0.05), { margin_bpb: 0.1, basis: 'floor' })
  assert.deepEqual(confirm.marginFor({ noise_bpb: 0.2, samples: 4, groups: 2 }, 0.1, 0.05), { margin_bpb: 0.1, basis: 'floor' })
  assert.deepEqual(confirm.marginFor(n, 0.002, NaN), { margin_bpb: 0.05, basis: 'ceiling' })
  assert.deepEqual(confirm.marginFor(n, 0.002, -1), { margin_bpb: 0.05, basis: 'ceiling' })
  // The record says the ceiling applied, in the line and in the stored verdict.
  const capped = confirm.marginFor(n, 0.002)
  assert.equal(confirm.describeMargin(n, capped), `margin: the ceiling of 0.0500, because twice the measured noise of ${(K * 2.4).toFixed(4)} from 4 repeated scores is above it`)
  const d = confirm.decideConfirmation({ first: 0.60, repeat: 0.60, repeatStatus: 'ok', best: 0.70, noise: n, minMargin: 0.002, maxMargin: 0.05 })
  assert.deepEqual([d.verdict, d.margin_bpb, d.margin_basis], ['confirmed', 0.05, 'ceiling'])
  assert.match(d.line, /^confirmed: mean 0\.6000 of two runs \(0\.6000 and 0\.6000\) beats 0\.7000 by 0\.1000, more than the 0\.0500 margin; kept as the new best at 0\.6000 \(margin: the ceiling of 0\.0500, because /)
  assert.equal(confirm.readDecision(JSON.parse(JSON.stringify(d))).margin_basis, 'ceiling')
  assert.equal(confirm.decideConfirmation({ first: 0.66, repeat: 0.66, repeatStatus: 'ok', best: 0.70, noise: n, minMargin: 0.002 }).verdict, 'within_noise')
  // The snapshot and the note the models read say it too.
  const snapshot = confirm.scoringSnapshot({ epoch: 90, rows: [row(1, 'control', 'a', 0.70, 0.7), row(2, 'control', 'a', 0.70, 0.7), wild], minMargin: 0.002, maxMargin: 0.05 })
  assert.deepEqual([snapshot.margin_bpb, snapshot.margin_basis, snapshot.max_margin_bpb], [0.05, 'ceiling', 0.05])
  const note = confirm.scoringPromptNote([row(1, 'control', 'a', 0.70, 0.7), row(2, 'control', 'a', 0.70, 0.7), wild], 0.002, 0.05)
  assert.ok(note.includes('The margin now is 0.0500 val_bpb (margin: the ceiling of 0.0500, because twice the measured noise of'))
  assert.ok(note.includes('and it is never more than a fixed ceiling of 0.0500.'))
})

test('the margin is the larger of the floor and twice the measured noise', () => {
  const none = { noise_bpb: null, samples: 2, groups: 1 }
  assert.deepEqual(confirm.marginFor(none, 0.002), { margin_bpb: 0.002, basis: 'floor' })
  assert.deepEqual(confirm.marginFor({ noise_bpb: 0.0004, samples: 6, groups: 2 }, 0.002), { margin_bpb: 0.002, basis: 'floor' })
  assert.deepEqual(confirm.marginFor({ noise_bpb: 0.003, samples: 6, groups: 2 }, 0.002), { margin_bpb: 0.006, basis: 'noise' })
  assert.deepEqual(confirm.marginFor({ noise_bpb: 0.003, samples: 6, groups: 2 }, 0), { margin_bpb: 0.006, basis: 'noise' })
  assert.deepEqual(confirm.marginFor(none, 0), { margin_bpb: 0, basis: 'floor' })
  assert.equal(confirm.describeMargin(none, confirm.marginFor(none, 0.002)), 'margin: the floor of 0.0020; noise not yet measured, 2 repeated scores so far')
  const measured = { noise_bpb: 0.003, samples: 6, groups: 2 }
  assert.equal(confirm.describeMargin(measured, confirm.marginFor(measured, 0.002)), 'margin: twice the measured noise of 0.0030, from 6 repeated scores')
  const small = { noise_bpb: 0.0004, samples: 1, groups: 1 }
  assert.equal(confirm.describeMargin(small, confirm.marginFor(small, 0.002)), 'margin: the floor of 0.0020, which is above twice the measured noise of 0.0004 from 1 repeated score')
})

test('the rule: beats by more than the margin, within noise, a repeat with no score, and no noise yet', () => {
  const none = { noise_bpb: null, samples: 0, groups: 0 }
  const decide = (over = {}) => confirm.decideConfirmation({ first: 0.7058, repeat: 0.7064, repeatStatus: 'ok', best: 0.7067, noise: none, minMargin: 0.002, ...over })

  // Within noise: the two runs together beat the best, but by less than the margin.
  let d = decide()
  assert.equal(d.verdict, 'within_noise')
  close(d.mean_bpb, 0.7061)
  close(d.improvement_bpb, 0.0006)
  assert.deepEqual([d.first_bpb, d.repeat_bpb, d.best_bpb, d.margin_bpb, d.margin_basis, d.noise_bpb, d.noise_samples, d.repeat_status], [0.7058, 0.7064, 0.7067, 0.002, 'floor', null, 0, 'ok'])
  assert.equal(d.line, 'within noise: mean 0.7061 of two runs (0.7058 and 0.7064) beats 0.7067 by 0.0006, not more than the 0.0020 margin; not kept (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far)')

  // Beats: the mean is below the best by more than the margin.
  d = decide({ first: 0.7030, repeat: 0.7050 })
  assert.equal(d.verdict, 'confirmed')
  close(d.mean_bpb, 0.704)
  assert.equal(d.line, 'confirmed: mean 0.7040 of two runs (0.7030 and 0.7050) beats 0.7067 by 0.0027, more than the 0.0020 margin; kept as the new best at 0.7040 (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far)')

  // Exactly the margin is not more than the margin.
  d = confirm.decideConfirmation({ first: 0.5, repeat: 0.5, repeatStatus: 'ok', best: 0.75, noise: none, minMargin: 0.25 })
  assert.equal(d.verdict, 'within_noise')
  // Nor is a tie that floating point makes look like more: 0.7067 - 0.7047 is 0.0020000000000000018 in binary.
  assert.ok(0.7067 - (0.7040 + 0.7054) / 2 > 0.002)
  d = decide({ first: 0.7040, repeat: 0.7054 })
  assert.equal(d.verdict, 'within_noise')
  assert.match(d.line, /^within noise: mean 0\.7047 of two runs \(0\.7040 and 0\.7054\) beats 0\.7067 by 0\.0020, not more than the 0\.0020 margin; not kept/)
  // The two numbers the line shows are the two that were compared, so the line never contradicts its verdict.
  for (const [first, repeat, minMargin] of [[0.7040, 0.7054, 0.002], [0.70437, 0.70437, 0.00231], [0.7044, 0.7044, 0.00225], [0.7039, 0.7053, 0.002], [0.7, 0.7, 0], [0.70669, 0.70669, 0]]) {
    d = decide({ first, repeat, minMargin })
    const [, by, margin] = /by (\d\.\d{4}), (?:not )?more than the (\d\.\d{4}) margin/.exec(d.line)
    assert.equal(d.verdict === 'confirmed', Number(by) > Number(margin), d.line)
    assert.equal(d.line.includes(', more than the'), d.verdict === 'confirmed', d.line)
  }

  // A lucky first run whose repeat is worse than the best: the mean does not beat it at all.
  d = decide({ first: 0.7060, repeat: 0.7080 })
  assert.equal(d.verdict, 'within_noise')
  assert.equal(d.line, 'within noise: mean 0.7070 of two runs (0.7060 and 0.7080) does not beat 0.7067; not kept (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far)')

  // Measured noise raises the margin: what the floor alone would have kept is within noise.
  const noisy = { noise_bpb: 0.002, samples: 5, groups: 2 }
  assert.equal(decide({ first: 0.7030, repeat: 0.7050 }).verdict, 'confirmed')
  d = decide({ first: 0.7030, repeat: 0.7050, noise: noisy })
  assert.equal(d.verdict, 'within_noise')
  assert.deepEqual([d.margin_bpb, d.margin_basis, d.noise_bpb, d.noise_samples], [0.004, 'noise', 0.002, 5])
  assert.match(d.line, /beats 0\.7067 by 0\.0027, not more than the 0\.0040 margin; not kept \(margin: twice the measured noise of 0\.0020, from 5 repeated scores\)$/)
  // And measured noise below the floor leaves the floor in charge.
  assert.equal(decide({ first: 0.7030, repeat: 0.7050, noise: { noise_bpb: 0.0001, samples: 9, groups: 3 } }).margin_basis, 'floor')

  // A repeat that crashed, was lost, or came back without a score confirms nothing, whatever the first run said.
  for (const [status, repeat, word] of [['crash', null, 'crash'], ['infra_error', null, 'infra error'], ['lost', undefined, 'lost'], ['ok', null, 'crash'], ['ok', NaN, 'crash'], ['ok', -1, 'crash'], ['Not A Status', 0.1, 'infra error']]) {
    d = decide({ first: 0.6, repeat, repeatStatus: status })
    assert.equal(d.verdict, 'not_confirmed', status)
    assert.deepEqual([d.repeat_bpb, d.mean_bpb, d.improvement_bpb], [null, null, null])
    assert.equal(d.line, `not confirmed: the lab's repeat of the same train.py gave no score (${word}); the first run printed 0.6000 against a best of 0.7067; not kept (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far)`)
  }

  // A stored verdict is read back strictly.
  const stored = JSON.parse(JSON.stringify(decide()))
  assert.deepEqual(confirm.readDecision(stored), decide())
  for (const bad of [null, [], 'x', {}, { ...stored, verdict: 'kept' }, { ...stored, first_bpb: '0.7' }, { ...stored, mean_bpb: null }, { ...stored, margin_bpb: undefined }]) {
    assert.equal(confirm.readDecision(bad), undefined)
  }
  assert.deepEqual(confirm.confirmColumns(decide()), { repeat_bpb: 0.7064, mean_bpb: decide().mean_bpb, noise_bpb: null, margin_bpb: 0.002, verdict: 'within_noise' })
  for (const text of [decide().line, decide({ first: 0.7030, repeat: 0.7050 }).line, decide({ repeat: null, repeatStatus: 'crash' }).line]) assert.equal(/[—–]/.test(text), false)
})

test('a control is due after the first three epochs, then every N, never twice for an epoch and never while one is open', () => {
  const due = (epoch, lastControlEpoch, controls, open = false, every = 10) => confirm.controlDue({ epoch, every, lastControlEpoch, controls, open })
  assert.equal(due(81, null, 0), true) // none yet
  assert.equal(due(81, 81, 1), false) // this epoch already has one
  assert.equal(due(82, 81, 1), true) // the first three follow consecutive epochs
  assert.equal(due(83, 82, 2), true)
  assert.equal(due(84, 83, 3), false) // then every N
  assert.equal(due(92, 83, 3), false)
  assert.equal(due(93, 83, 3), true)
  assert.equal(due(200, 83, 3), true)
  assert.equal(due(85, 83, 3, false, 2), true)
  assert.equal(due(84, 83, 3, false, 2), false)
  assert.equal(due(84, 83, 3, false, 1), true)
  assert.equal(due(84, 83, 3, false, 0), true) // a nonsense interval reads as 1
  // While one is still running, none is started, whatever else is true.
  for (const args of [[81, null, 0], [82, 81, 1], [200, 83, 3]]) assert.equal(due(...args, true), false)
  // A control recorded for a later epoch than this one (a retried epoch) starts nothing.
  assert.equal(due(82, 83, 1), false)
})

// ===========================================================================
// 2. Off: nothing differs
// ===========================================================================
/** Everything one epoch sends and stores, for comparing two runs of the same epoch. */
async function trace(env) {
  freshLab()
  process.env = { ...BASE_ENV, ...env }
  openrouter.resetModelCatalog()
  researchExperiment()
  const world = fakeWorld({ runs: [0.69] })
  await runEpoch()
  return {
    requests: world.requests, files: world.files, messages: world.messages, puts: world.puts,
    // The spend ledger's own table is made once per process, by whichever epoch runs first.
    statements: lab.statements.filter(s => !/^(CREATE (TABLE|INDEX) IF NOT EXISTS (model_calls|idx_model_calls)|ALTER TABLE model_calls)/.test(s.text))
      .map(s => `${s.text} :: ${JSON.stringify(s.values)}`),
    epoch: { ...lab.epochs[0], completed_at: null }, spec: lab.experiments[0].current_spec,
  }
}

test('with the switch off a kept run becomes the best on one run, exactly as before, and nothing of the repeat exists', async () => {
  const off = await trace({})
  // One run, started with the two fields it always had; no second run, and no statement about repeats.
  assert.deepEqual(off.requests.filter(r => r.includes('runner.example/start')), [`POST https://runner.example/start ${JSON.stringify({ train_py: NEW_TRAIN_PY, budget_s: 300 })}`])
  assert.equal(off.statements.some(s => /research_repeats|COALESCE\(research_run/.test(s)), false)
  assert.deepEqual(Object.keys(off.epoch.research_run), ['call_id', 'budget_s', 'result'])
  // The first run's own score is the best, the Reviewer's words are untouched, and the spec has no scoring.
  const meta = off.spec.meta.research
  assert.deepEqual([meta.best_bpb, meta.best_epoch], [0.69, 81])
  assert.deepEqual(meta.last_run, { epoch: 81, val_bpb: 0.69, verdict: 'keep', status: 'ok', hypothesis: 'a warmup schedule lowers val_bpb' })
  assert.equal('scoring' in meta, false)
  assert.equal(off.spec.capabilities[0].description, 'a warmup schedule lowers val_bpb (val_bpb 0.6900, self-reported)')
  assert.deepEqual(said(off.epoch.reviewer_output), { verdict: 'keep', reason: 'the number decided' })
  // The ledger keeps thirteen columns, there is no repeat ledger, and the page says the score was not repeated.
  assert.deepEqual(off.puts, ['train.py', 'results.tsv', 'wiki/findings/epoch-081.md'])
  assert.equal(off.files['results.tsv'], `${LEDGER_13}\n81\tmerged\t0.6900\t100\t299.0\t-\t10.900\tkeep\ta warmup schedule lowers val_bpb\texperiment_stdout_unverified\ttinystories_gpt4_clean\t-\t310.0\n`)
  assert.match(off.messages['results.tsv'], /^results: epoch 81 — keep \(val_bpb 0\.6900, unverified\)\n\nMetrics-Source: /)
  assert.match(off.messages['train.py'], /^e81 KEEP \(0\.6900 bpb, unverified\): a warmup schedule lowers val_bpb\n/)
  const page = off.files['wiki/findings/epoch-081.md']
  assert.ok(page.includes('- **Score source:** experiment_stdout_unverified (printed by the generated train.py itself; not independently evaluated or repeated)\n- **Dataset:**'))
  assert.equal(/lab repeat/i.test(JSON.stringify(off.files) + JSON.stringify(off.messages)), false)
  // No prompt says anything about how the lab scores.
  const prompts = off.requests.filter(r => r.includes('chat/completions')).join('\n')
  assert.equal(/HOW THE LAB SCORES|LAB REPEAT|lab repeat|repeat_val_bpb/.test(prompts), false)

  // Any value but "true" is the same epoch, request for request and statement for statement.
  for (const value of ['false', '1', 'yes', '']) assert.deepEqual(await trace({ LAB_RESEARCH_CONFIRM: value }), off, value)
  // The other settings do nothing by themselves.
  assert.deepEqual(await trace({ LAB_RESEARCH_MIN_MARGIN: '0.5', LAB_RESEARCH_CONTROL_EVERY: '1', LAB_TINKER_ORIGIN_LABELS: 'true' }), off)

  // The prompt builders are what they were when nothing is passed.
  const inputs = { epochNumber: 81, spec: off.spec, research: { baseline_bpb: 0.72, best_bpb: 0.7, best_epoch: 40, target_bpb: 0.35, last_run: { epoch: 80, val_bpb: 0.71, verdict: 'revert', status: 'ok', hypothesis: 'h' } }, trainPy: TRAIN_PY, resultsTsv: '', wikiIndex: '', recentHistory: [] }
  const shared = researchPrompts.getResearchSharedContext(inputs)
  assert.ok(shared.includes('- Last run (epoch 80): 0.7100 → REVERT — "h"'))
  assert.equal(researchPrompts.getResearchSharedContext({ ...inputs, scoringNote: '\n\nNOTE' }), shared.replace('```\n\nWHERE YOU ARE', '```\n\nNOTE\n\nWHERE YOU ARE'))
  const narrate = { hypothesis: 'h', changeSummary: 'c', run: { status: 'ok', metrics: { val_bpb: 0.7 } }, verdict: 'revert', bestBpb: 0.7, baselineBpb: 0.72 }
  assert.ok(researchPrompts.RESEARCH_PROMPTS.commentator(narrate).includes('VERDICT: revert\nBEST NOW: 0.7000'))
  assert.ok(researchPrompts.RESEARCH_PROMPTS.commentator({ ...narrate, labRepeat: 'within noise: x' }).includes('VERDICT: revert\nLAB REPEAT (the lab ran the same train.py once more before taking it as the best): within noise: x\nBEST NOW: 0.7000'))
})

test('while both switches are off the public scoring state says so and touches neither the database nor the network', async () => {
  noNetwork()
  noDatabase()
  const res = await getScoring()
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { research: { enabled: false }, tinker_origin: { enabled: false } })
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await getScoring(method)).code, 405)
})

// ===========================================================================
// 3. On: confirm before best
// ===========================================================================
test('a run that would be the best is repeated once, and a mean that beats the best by more than the margin is kept at that mean', async () => {
  enable()
  researchExperiment()
  const world = fakeWorld({ runs: [0.69, 0.692] })
  await runEpoch()

  // The repeat is the same train.py and budget, with no key; the third run is the control after the epoch.
  assert.equal(world.starts.length, 3)
  assert.deepEqual(world.starts[1], { train_py: NEW_TRAIN_PY, budget_s: 300 })
  assert.deepEqual(world.starts[1], world.starts[0])
  // The verdict, with every number it used, is on the epoch's row.
  const stored = lab.epochs[0].research_run.confirm
  assert.equal(stored.verdict, 'confirmed')
  close(stored.mean_bpb, 0.691)
  // The noise that judged it leaves its own pair out, so it had no repeated scores to go on.
  assert.deepEqual([stored.first_bpb, stored.repeat_bpb, stored.best_bpb, stored.margin_bpb, stored.margin_basis, stored.noise_bpb, stored.noise_samples], [0.69, 0.692, 0.7, 0.002, 'floor', null, 0])
  const line = 'confirmed: mean 0.6910 of two runs (0.6900 and 0.6920) beats 0.7000 by 0.0090, more than the 0.0020 margin; kept as the new best at 0.6910 (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far, not counting this run\'s own two scores)'
  assert.equal(stored.line, line)
  assert.deepEqual(said(lab.epochs[0].reviewer_output), { verdict: 'keep', reason: 'the number decided' })

  // The best is the mean of the two runs.
  const meta = researchMeta()
  close(meta.best_bpb, 0.691)
  assert.equal(meta.best_epoch, 81)
  assert.deepEqual(meta.last_run, { epoch: 81, val_bpb: 0.69, verdict: 'keep', status: 'ok', hypothesis: 'a warmup schedule lowers val_bpb', confirm: 'confirmed' })
  assert.equal(lab.experiments[0].current_spec.capabilities[0].description, 'a warmup schedule lowers val_bpb (val_bpb mean of two runs 0.6910, self-reported)')
  assert.deepEqual([meta.scoring.noise_bpb, meta.scoring.noise_samples, meta.scoring.margin_bpb, meta.scoring.min_margin_bpb, meta.scoring.updated_epoch], [null, 2, 0.002, 0.002, 81])
  assert.deepEqual({ ...meta.scoring.last_verdict, mean_bpb: 0 }, { epoch: 81, verdict: 'confirmed', first_bpb: 0.69, repeat_bpb: 0.692, mean_bpb: 0, best_bpb: 0.7, margin_bpb: 0.002, line })

  // The repository: train.py is replaced, the ledger has the nineteen columns, the page states the verdict.
  assert.deepEqual(world.puts, ['train.py', 'results.tsv', 'wiki/findings/epoch-081.md', 'lab-repeats.tsv'])
  assert.equal(world.files['train.py'], NEW_TRAIN_PY)
  assert.match(world.messages['train.py'], /^e81 KEEP \(0\.6900 bpb, unverified; lab repeat 0\.6920, mean 0\.6910\): a warmup schedule lowers val_bpb\n/)
  const rows = ledgerRows(world)
  assert.equal(rows[0], LEDGER_19)
  assert.equal(rows[1], '81\tmerged\t0.6900\t100\t299.0\t-\t10.900\tkeep\ta warmup schedule lowers val_bpb\texperiment_stdout_unverified\ttinystories_gpt4_clean\t-\t310.0\t-\t0.6920\t0.6910\t-\t0.0020\tconfirmed')
  assert.match(world.messages['results.tsv'], /^results: epoch 81 — keep \(val_bpb 0\.6900, unverified; lab repeat: confirmed\)\n/)
  const page = world.files['wiki/findings/epoch-081.md']
  assert.ok(page.includes(`- **Score source:** experiment_stdout_unverified (printed by the generated train.py itself; not independently evaluated)\n- **Lab repeat:** ${line}. Both scores were printed by the generated train.py and are unverified: a repeat checks luck, not honesty\n- **Dataset:**`))
  assert.ok(page.includes('- **Verdict:** KEEP (run: ok)'))
  // The repeat has its own row in the lab's ledger of repeats, committed by the owner (no model trailer).
  const repeats = world.files['lab-repeats.tsv'].trimEnd().split('\n')
  assert.equal(repeats[0], 'kind\tepoch\ttrain_sha256\tval_bpb\tstatus\treference_bpb\treference_epoch\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds\tcall_id\trunner_flow')
  assert.equal(repeats[1], `confirm\t81\t${confirm.trainSha256(NEW_TRAIN_PY)}\t0.6920\tok\t0.6900\t81\texperiment_stdout_unverified\ttinystories_gpt4_clean\t-\t310.0\tcall-2\t-`)
  assert.equal(repeats.length, 2)
  assert.match(world.messages['lab-repeats.tsv'], /^lab repeat: repeat of epoch 81, ok \(val_bpb 0\.6920, unverified\)\n\nMetrics-Source: experiment_stdout_unverified\n/)
  assert.equal(/^Model:/m.test(world.messages['lab-repeats.tsv']), false)
  // The lab reads its own wider ledger, and takes a confirmed row at its mean.
  assert.deepEqual(researchAlongside.summarizeLedger(world.files['results.tsv']), { last_epoch: 81, best_kept: { epoch: 81, val_bpb: 0.691 } })

  // The models are told the rule as a fact, with the margin as it was at the start of the epoch; the Commentator hears the verdict.
  const prompts = world.chats.map(c => JSON.stringify(c))
  assert.equal(prompts.length, 5)
  for (const p of prompts) {
    assert.ok(p.includes('HOW THE LAB SCORES A NEW BEST (a fact about the lab, not a goal; val_bpb is still the only thing a run is judged on)'))
    assert.ok(p.includes('The margin now is 0.0020 val_bpb (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far)'))
    assert.ok(p.includes('Both scores are printed by train.py itself, so the repeat does not make a score independently evaluated.'))
  }
  assert.equal(prompts.slice(0, 4).some(p => p.includes('LAB REPEAT (')), false)
  assert.ok(world.chats[4].messages[0].content.includes(`VERDICT: keep\nLAB REPEAT (the lab ran the same train.py once more before taking it as the best): ${line}\nBEST NOW: 0.6910`))

  // The control after the epoch re-runs the train.py that now holds the best, against the new best.
  assert.deepEqual(world.starts[2], { train_py: NEW_TRAIN_PY, budget_s: 300 })
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.epoch_number, r.status, r.call_id, r.train_sha256 === confirm.trainSha256(NEW_TRAIN_PY)]), [['confirm', 81, 'ok', 'call-2', true], ['control', 81, 'running', 'call-3', true]])
  close(lab.repeats[1].reference_bpb, 0.691)
  assert.equal(lab.repeats[1].reference_epoch, 81)
  // Research is not running beside run 2 here, so no GPU time is written, for the epoch's run or the repeat.
  assert.equal(lab.modelCalls.some(c => c.model_id.startsWith('tool/')), false)
})

test('a mean that does not clear the margin is recorded as within noise with both values, and train.py stays as it was', async () => {
  enable()
  researchExperiment({ best_bpb: 0.7067 })
  const world = fakeWorld({ runs: [0.7058, 0.7064] })
  await runEpoch()

  const line = 'within noise: mean 0.7061 of two runs (0.7058 and 0.7064) beats 0.7067 by 0.0006, not more than the 0.0020 margin; not kept (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far, not counting this run\'s own two scores)'
  assert.equal(lab.epochs[0].research_run.confirm.verdict, 'within_noise')
  assert.equal(lab.epochs[0].research_run.confirm.line, line)
  // The Reviewer's keep is not taken, and its stored reason says why.
  assert.deepEqual(said(lab.epochs[0].reviewer_output), { verdict: 'revert', reason: `the number decided [LAB: keep not taken. ${line}.]` })
  // Not kept: the best, train.py and the capabilities are what they were.
  const meta = researchMeta()
  assert.deepEqual([meta.best_bpb, meta.best_epoch], [0.7067, 40])
  assert.deepEqual(lab.experiments[0].current_spec.capabilities, [])
  assert.deepEqual(meta.last_run, { epoch: 81, val_bpb: 0.7058, verdict: 'revert', status: 'ok', hypothesis: 'a warmup schedule lowers val_bpb', confirm: 'within_noise' })
  assert.equal(meta.scoring.last_verdict.verdict, 'within_noise')
  assert.equal(world.puts.includes('train.py'), false)
  assert.equal(world.files['train.py'], TRAIN_PY)
  // The row is a discard with both values, the mean, the margin and the verdict.
  assert.equal(ledgerRows(world)[1], '81\treverted\t0.7058\t100\t299.0\t-\t10.900\tdiscard\ta warmup schedule lowers val_bpb\texperiment_stdout_unverified\ttinystories_gpt4_clean\t-\t310.0\t-\t0.7064\t0.7061\t-\t0.0020\twithin_noise')
  assert.match(world.messages['results.tsv'], /^results: epoch 81 — discard \(val_bpb 0\.7058, unverified; lab repeat: within noise\)\n/)
  const page = world.files['wiki/findings/epoch-081.md']
  assert.ok(page.includes('- **Verdict:** REVERT (run: ok)'))
  assert.ok(page.includes(`- **Lab repeat:** ${line}. Both scores were printed by the generated train.py and are unverified: a repeat checks luck, not honesty\n`))
  assert.ok(world.chats[4].messages[0].content.includes(`VERDICT: revert\nLAB REPEAT (the lab ran the same train.py once more before taking it as the best): ${line}\nBEST NOW: 0.7067`))
  // A row within noise is not a kept score for the lab's own reading of the ledger.
  assert.deepEqual(researchAlongside.summarizeLedger(world.files['results.tsv']), { last_epoch: 81, best_kept: null })
  // The control that follows re-runs the train.py that still holds the best.
  assert.deepEqual(world.starts[2], { train_py: TRAIN_PY, budget_s: 300 })
  assert.deepEqual([lab.repeats[1].kind, lab.repeats[1].reference_bpb, lab.repeats[1].reference_epoch], ['control', 0.7067, 40])

  // The next epoch's models see the last run with the lab's verdict beside the Reviewer's.
  world.verdict = 'revert'
  world.runs = [0.7058, 0.7064, 0.7066, 0.74]
  await runEpoch()
  assert.ok(world.chats[5].messages[0].content.includes('- Last run (epoch 81): 0.7058 → REVERT (lab repeat: within noise) — "a warmup schedule lowers val_bpb"'))
})

test('a repeat that crashes, or whose call is lost, is not confirmed, and nothing is kept', async () => {
  for (const [outcome, status, word] of [['crash', 'crash', 'crash'], ['failed', 'infra_error', 'infra error']]) {
    freshLab()
    enable()
    researchExperiment()
    const world = fakeWorld({ runs: [0.65, outcome] })
    await runEpoch()
    const stored = lab.epochs[0].research_run.confirm
    assert.deepEqual([stored.verdict, stored.repeat_status, stored.repeat_bpb, stored.mean_bpb], ['not_confirmed', status, null, null], outcome)
    assert.equal(stored.line, `not confirmed: the lab's repeat of the same train.py gave no score (${word}); the first run printed 0.6500 against a best of 0.7000; not kept (margin: the floor of 0.0020; noise not yet measured, 0 repeated scores so far, not counting this run's own two scores)`)
    assert.equal(lab.epochs[0].reviewer_output.verdict, 'revert')
    assert.deepEqual([researchMeta().best_bpb, researchMeta().best_epoch, researchMeta().last_run.confirm], [0.7, 40, 'not_confirmed'])
    assert.equal(world.puts.includes('train.py'), false)
    assert.equal(ledgerRows(world)[1].split('\t').slice(13).join('|'), '-|-|-|-|0.0020|not_confirmed')
    assert.deepEqual(ledgerRows(world)[1].split('\t').slice(1, 3).concat(ledgerRows(world)[1].split('\t')[7]), ['reverted', '0.6500', 'discard'])
    assert.equal(world.files['lab-repeats.tsv'].trimEnd().split('\n')[1].split('\t').slice(0, 6).join('|'), `confirm|81|${confirm.trainSha256(NEW_TRAIN_PY)}|-|${status}|0.6500`)
  }
})

test('a run that is not a candidate is not repeated: a revert, a keep that does not beat the best, and a crash', async () => {
  for (const [verdict, first] of [['revert', 0.65], ['keep', 0.71], ['keep', 'crash']]) {
    freshLab()
    enable()
    researchExperiment()
    const world = fakeWorld({ verdict, runs: [first] })
    await runEpoch()
    // Two starts: the epoch's own run and the control after it. No confirmation.
    assert.equal(world.starts.length, 2, `${verdict} ${first}`)
    assert.deepEqual(lab.repeats.map(r => r.kind), ['control'])
    assert.equal('confirm' in lab.epochs[0].research_run, false)
    assert.equal('confirm' in researchMeta().last_run, false)
    assert.equal(researchMeta().best_bpb, 0.7)
    // Its row has the wider header and "-" in the five columns; its page has no repeat line.
    assert.equal(ledgerRows(world)[0], LEDGER_19)
    assert.equal(ledgerRows(world)[1].split('\t').slice(13).join('|'), '-|-|-|-|-|-')
    assert.equal(world.files['wiki/findings/epoch-081.md'].includes('Lab repeat'), false)
    assert.equal('last_verdict' in researchMeta().scoring, false)
    assert.equal(world.chats.some(c => JSON.stringify(c).includes('LAB REPEAT (')), false)
  }
})

test('a repeat still training when the request stops waiting is picked up by the next attempt, and is never started twice', async () => {
  enable({ RESEARCH_RUN_POLL_MAX_MS: '40' })
  researchExperiment()
  const world = fakeWorld({ runs: [0.69, 'running'] })
  await assert.rejects(runEpoch(), e => e.name === 'ResearchRunPendingError' && e.callId === 'call-2')
  // The epoch is not finished: nothing was committed, the best is unchanged, and the repeat's call is stored.
  assert.equal(world.starts.length, 2)
  assert.deepEqual(world.puts, [])
  assert.equal(lab.experiments[0].current_epoch, 80)
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.status, r.call_id, r.reference_bpb]), [['confirm', 'running', 'call-2', 0.69]])
  assert.equal(lab.epochs[0].reviewer_output.verdict, 'keep')
  assert.equal('confirm' in lab.epochs[0].research_run, false)
  const chatsSoFar = world.chats.length
  assert.equal(chatsSoFar, 4)

  // Still training at the next attempt: the same call is asked again, and nothing new starts.
  await assert.rejects(runEpoch(), e => e.name === 'ResearchRunPendingError' && e.callId === 'call-2')
  assert.equal(world.starts.length, 2)
  assert.equal(world.chats.length, chatsSoFar)

  // It answers: the verdict is worked out from the stored first score, and the epoch finishes.
  world.runs = [0.69, 0.688]
  await runEpoch()
  assert.equal(lab.epochs[0].research_run.confirm.verdict, 'confirmed')
  close(researchMeta().best_bpb, 0.689)
  assert.equal(lab.experiments[0].current_epoch, 81)
  assert.equal(world.chats.length, 5) // only the Commentator was still to speak
  assert.deepEqual(world.starts.length, 3) // and the control after the epoch
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.status]), [['confirm', 'ok'], ['control', 'running']])

  // An epoch picked up again after its verdict was stored repeats nothing and decides nothing anew.
  freshLab()
  enable()
  researchExperiment()
  const again = fakeWorld({ runs: [0.699, 0.6995] })
  await runEpoch()
  assert.equal(lab.epochs[0].research_run.confirm.verdict, 'within_noise')
  const reason = lab.epochs[0].reviewer_output.reason
  Object.assign(lab.epochs[0], { completed_at: null, commentator_output: null })
  lab.experiments[0].current_epoch = 80
  again.runs = [0.699, 0.5, 0.5, 0.5]
  await runEpoch()
  assert.equal(again.starts.length, 3) // run, repeat, one control: no second repeat, no second control
  assert.equal(lab.epochs[0].research_run.confirm.verdict, 'within_noise')
  assert.equal(lab.epochs[0].reviewer_output.reason, reason) // the note is not added twice
  assert.equal(researchMeta().best_bpb, 0.7)
})

// ===========================================================================
// 4. On: the noise floor and the control runs
// ===========================================================================
test('controls follow the first three epochs and then every N, one per tick at most, and their spread becomes the margin', async () => {
  enable({ LAB_RESEARCH_CONTROL_EVERY: '2' })
  researchExperiment()
  // Every epoch's own run is reverted at 0.74. Calls in order: e81 run, control, e82 run, control, e83 run, control, ...
  const world = fakeWorld({ verdict: 'revert', runs: [0.74, 0.700, 0.74, 0.702, 0.74, 0.704, 0.74, 0.74, 0.74, 0.703, 0.74] })
  const controls = () => lab.repeats.filter(r => r.kind === 'control').map(r => [r.epoch_number, r.status, r.val_bpb])
  const noteOf = chat => /The margin now is .*?\); it is the larger/.exec(chat.messages[0].content)?.[0]

  await runEpoch() // 81
  assert.deepEqual(controls(), [[81, 'running', null]])
  assert.deepEqual(world.starts[1], { train_py: TRAIN_PY, budget_s: 300 }) // the best train.py, unchanged
  assert.deepEqual([researchMeta().scoring.noise_bpb, researchMeta().scoring.noise_samples, researchMeta().scoring.margin_bpb], [null, 0, 0.002])
  assert.equal('last_control' in researchMeta().scoring, false)

  await runEpoch() // 82: collects the first control at its start, starts the second at its end
  assert.deepEqual(controls(), [[81, 'ok', 0.7], [82, 'running', null]])
  assert.deepEqual(researchMeta().scoring.last_control, { epoch: 81, status: 'ok', val_bpb: 0.7, reference_bpb: 0.7 })
  assert.equal(researchMeta().scoring.noise_bpb, null)

  await runEpoch() // 83
  assert.deepEqual(controls(), [[81, 'ok', 0.7], [82, 'ok', 0.702], [83, 'running', null]])
  assert.deepEqual([researchMeta().scoring.noise_bpb, researchMeta().scoring.noise_samples], [null, 2])
  assert.equal(noteOf(world.chats.at(-5)), 'The margin now is 0.0020 val_bpb (margin: the floor of 0.0020; noise not yet measured, 2 repeated scores so far); it is the larger')

  await runEpoch() // 84: three controls are in, the noise is measured; no control is due (the third was one epoch ago)
  assert.deepEqual(controls(), [[81, 'ok', 0.7], [82, 'ok', 0.702], [83, 'ok', 0.704]])
  close(researchMeta().scoring.noise_bpb, confirm.madToSd(3) * 0.002)
  close(researchMeta().scoring.margin_bpb, 2 * confirm.madToSd(3) * 0.002)
  assert.deepEqual([researchMeta().scoring.noise_samples, researchMeta().scoring.min_margin_bpb, researchMeta().scoring.updated_epoch], [3, 0.002, 84])
  assert.deepEqual([researchMeta().scoring.margin_basis, researchMeta().scoring.max_margin_bpb], ['noise', 0.05])
  assert.equal(noteOf(world.chats.at(-5)), 'The margin now is 0.0111 val_bpb (margin: twice the measured noise of 0.0055, from 3 repeated scores); it is the larger')
  assert.equal(world.starts.length, 7)

  await runEpoch() // 85: two epochs since the last control, so one is due
  assert.deepEqual(controls().at(-1), [85, 'running', null])
  assert.equal(world.starts.length, 9)

  // 86: the control after 85 is still training. It is asked about once, left open, and no other control is started.
  world.runs[8] = 'running'
  await runEpoch()
  assert.deepEqual(controls().at(-1), [85, 'running', null])
  assert.equal(world.starts.length, 10)
  // 87: two epochs have passed, but one control is still open: none is started.
  world.runs[9] = 0.74
  world.runs[10] = 0.74
  await runEpoch()
  assert.equal(controls().length, 4)
  assert.equal(world.starts.length, 11)
  // Every control was the best train.py, unchanged, and is in the lab's ledger of repeats once it finished.
  for (const i of [1, 3, 5, 8]) assert.deepEqual(world.starts[i], { train_py: TRAIN_PY, budget_s: 300 })
  const repeats = world.files['lab-repeats.tsv'].trimEnd().split('\n').slice(1).map(l => l.split('\t').slice(0, 7).join('|'))
  const sha = confirm.trainSha256(TRAIN_PY)
  assert.deepEqual(repeats, [`control|81|${sha}|0.7000|ok|0.7000|40`, `control|82|${sha}|0.7020|ok|0.7000|40`, `control|83|${sha}|0.7040|ok|0.7000|40`])
  assert.match(world.messages['lab-repeats.tsv'], /^lab repeat: control after epoch 83, ok \(val_bpb 0\.7040, unverified\)\n/)
  // The epochs' own rows were never touched by any of it.
  assert.equal(ledgerRows(world).length, 8)
  assert.equal(researchMeta().best_bpb, 0.7)
})

test('with the noise measured, a result the floor alone would have kept is within noise', async () => {
  enable()
  researchExperiment()
  const sha = confirm.trainSha256(TRAIN_PY)
  for (const [i, val] of [0.700, 0.702, 0.704].entries()) {
    lab.repeats.push({ id: i + 1, created_at: new Date(), experiment_id: EXPERIMENT, epoch_number: 78 + i, kind: 'control', train_sha256: sha, reference_bpb: 0.7, reference_epoch: 40, call_id: `old-${i}`, status: 'ok', val_bpb: val, result: null, cost_usd: null, ledger_written: true, finished_at: new Date() })
  }
  // 0.697 twice beats 0.700 by 0.003: more than the 0.002 floor, less than twice the measured noise of the three controls.
  const world = fakeWorld({ runs: [0.697, 0.697] })
  await runEpoch()
  const stored = lab.epochs[0].research_run.confirm
  assert.equal(stored.verdict, 'within_noise')
  assert.equal(stored.margin_basis, 'noise')
  assert.equal(stored.noise_samples, 3) // the three controls; this pair is not in the noise that judges it
  close(stored.noise_bpb, confirm.madToSd(3) * 0.002)
  assert.match(stored.line, /^within noise: mean 0\.6970 of two runs \(0\.6970 and 0\.6970\) beats 0\.7000 by 0\.0030, not more than the 0\.0111 margin; not kept \(margin: twice the measured noise of 0\.0055, from 3 repeated scores, not counting this run's own two scores\)$/)
  assert.equal(researchMeta().best_bpb, 0.7)
  // The row carries the noise and the margin the verdict used.
  const cells = ledgerRows(world)[1].split('\t').slice(14)
  assert.deepEqual([cells[0], cells[1], cells[4]], ['0.6970', '0.6970', 'within_noise'])
  assert.equal(cells[2], stored.noise_bpb.toFixed(4))
  assert.equal(cells[3], stored.margin_bpb.toFixed(4))
  // For later epochs the pair counts: the state after the epoch has all five scores (two spreads of zero and 0.0055 by three).
  close(researchMeta().scoring.noise_bpb, stored.noise_bpb)
  assert.equal(researchMeta().scoring.noise_samples, 5)
  // Three controls exist, the last two epochs ago of ten: none is started.
  assert.equal(world.starts.length, 2)
})

test('a control that is lost or crashes gives no score, GPU time is counted beside run 2, and a database that is away costs the epoch nothing', async () => {
  // Beside run 2 the repeats' GPU time goes on the ledger like the epoch's own run.
  enable({ LAB_RESEARCH_ALONGSIDE: 'true' })
  researchExperiment()
  let world = fakeWorld({ runs: [0.69, 0.692, 'failed', 0.74, 'crash', 0.74] })
  await runEpoch() // 81: run, repeat (confirmed), control (call-3)
  const tools = () => lab.modelCalls.filter(c => c.model_id.startsWith('tool/')).map(c => [c.model_id, c.assigned_model_id, c.cost_source, Number(c.cost_usd.toFixed(6))])
  const rate = 0.000306
  assert.deepEqual(tools(), [['tool/research_gpu_run', lab.epochs[0].role_assignments.executor, 'estimate', Number((400 * rate).toFixed(6))], ['tool/research_gpu_repeat', 'lab', 'estimate', Number((400 * rate).toFixed(6))]])
  world.verdict = 'revert'
  await runEpoch() // 82: the control's call is gone on the runner; it is closed as lost and charged the whole budget
  assert.deepEqual(lab.repeats.filter(r => r.kind === 'control').map(r => [r.epoch_number, r.status, r.val_bpb]), [[81, 'lost', null], [82, 'running', null]])
  assert.deepEqual(tools().at(-2), ['tool/research_gpu_control', 'lab', 'estimate', Number(((300 + 180) * rate).toFixed(6))])
  assert.deepEqual(researchMeta().scoring.last_control, { epoch: 81, status: 'lost', val_bpb: null, reference_bpb: lab.repeats[1].reference_bpb })
  await runEpoch() // 83: the second control crashed
  assert.deepEqual(lab.repeats.filter(r => r.kind === 'control').map(r => r.status), ['lost', 'crash', 'running'])
  assert.equal(researchMeta().scoring.noise_bpb, null)
  assert.equal(world.files['lab-repeats.tsv'].trimEnd().split('\n').slice(1).map(l => l.split('\t').slice(0, 5).filter((_, i) => i !== 2).join('|')).join(' '), 'confirm|81|0.6920|ok control|81|-|lost control|82|-|crash')

  // Once the day's cap is reached no control is started; the epoch itself is not affected.
  freshLab()
  process.env = { ...BASE_ENV }
  enable({ LAB_DAILY_BUDGET_USD: '15' })
  researchExperiment()
  lab.spentToday = 15
  world = fakeWorld({ verdict: 'revert', runs: [0.74] })
  await runEpoch()
  assert.equal(world.starts.length, 1)
  assert.deepEqual(lab.repeats, [])
  assert.equal(lab.experiments[0].current_epoch, 81)
  assert.ok(logs.some(l => l.includes('[Research e81] no control run: daily budget reached')))
  // Beside run 2 it is research's own cap that counts.
  lab.spentToday = 39
  Object.assign(process.env, { LAB_RESEARCH_ALONGSIDE: 'true', LAB_RESEARCH_DAILY_BUDGET_USD: '40' })
  world = fakeWorld({ verdict: 'revert', runs: [0.74, 0.74] })
  await runEpoch()
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.epoch_number]), [['control', 82]])
  lab.spentToday = 40
  world = fakeWorld({ verdict: 'revert', runs: [0.74, 0.74] })
  lab.repeats[0].status = 'ok'
  await runEpoch()
  assert.equal(lab.repeats.length, 1)
  assert.ok(logs.some(l => l.includes('[Research e83] no control run: research daily budget reached')))

  // A control still unanswered long after it started is given up as lost.
  freshLab()
  process.env = { ...BASE_ENV }
  enable()
  researchExperiment()
  lab.repeats.push({ id: 1, created_at: new Date(Date.now() - confirm.REPEAT_LOST_AFTER_MS - 60_000), experiment_id: EXPERIMENT, epoch_number: 80, kind: 'control', train_sha256: 'a'.repeat(64), reference_bpb: 0.7, reference_epoch: 40, call_id: 'call-9', status: 'running', val_bpb: null, result: null, cost_usd: null, ledger_written: false, finished_at: null })
  world = fakeWorld({ verdict: 'revert', runs: [0.74] })
  await runEpoch()
  assert.equal(lab.repeats[0].status, 'lost')

  // The table cannot be read: the epoch runs, the margin is the floor, and no repeat or control is recorded.
  freshLab()
  enable()
  researchExperiment()
  lab.failRepeats = true
  world = fakeWorld({ verdict: 'revert', runs: [0.74] })
  await runEpoch()
  assert.equal(lab.experiments[0].current_epoch, 81)
  assert.equal(world.starts.length, 1)
  assert.ok(logs.some(l => l.includes('could not collect the lab\'s repeat runs (non-fatal)')))
  assert.ok(logs.some(l => l.includes('could not start a control run (non-fatal)')))
  assert.deepEqual([researchMeta().scoring.noise_bpb, researchMeta().scoring.margin_bpb], [null, 0.002])
  // An earlier snapshot's noise is not thrown away because the rows could not be read this once.
  const kept = confirm.scoringSnapshot({ epoch: 90, rows: [], minMargin: 0.002, previous: { noise_bpb: 0.003, noise_samples: 7, margin_bpb: 0.006, min_margin_bpb: 0.002, updated_epoch: 89 } })
  assert.deepEqual(kept, { noise_bpb: 0.003, noise_samples: 7, margin_bpb: 0.006, margin_basis: 'noise', min_margin_bpb: 0.002, max_margin_bpb: 0.05, updated_epoch: 90 })
})

test('a file that printed wild scores cannot block later results: the margin stops at the ceiling and a real improvement is still confirmed', async () => {
  enable()
  researchExperiment()
  // On record: two earlier candidates whose repeats were far from their first scores (0.10 then 4.90, 0.20 then 3.00),
  // and two controls of the best file that agreed at 0.70: three spreads, two of them wild. The new pair is not counted.
  const stored = (id, epoch, kind, sha, val, ref) => ({ id, created_at: new Date(), experiment_id: EXPERIMENT, epoch_number: epoch, kind, train_sha256: sha, reference_bpb: ref, reference_epoch: epoch, call_id: `old-${id}`, status: 'ok', val_bpb: val, result: null, cost_usd: null, ledger_written: true, finished_at: new Date() })
  lab.repeats.push(stored(1, 69, 'confirm', 'c'.repeat(64), 3.00, 0.20), stored(2, 70, 'confirm', 'b'.repeat(64), 4.90, 0.10), stored(3, 71, 'control', confirm.trainSha256(TRAIN_PY), 0.70, 0.7), stored(4, 72, 'control', confirm.trainSha256(TRAIN_PY), 0.70, 0.7))
  // Twice the noise is 2.9 val_bpb. A run that repeats at 0.60 against a best of 0.70 is kept all the same.
  const world = fakeWorld({ runs: [0.60, 0.60] })
  await runEpoch()
  const d = lab.epochs[0].research_run.confirm
  assert.deepEqual([d.verdict, d.margin_bpb, d.margin_basis, d.mean_bpb], ['confirmed', 0.05, 'ceiling', 0.6])
  assert.match(d.line, /more than the 0\.0500 margin; kept as the new best at 0\.6000 \(margin: the ceiling of 0\.0500, because twice the measured noise of \d+\.\d{4} from 6 repeated scores is above it, not counting this run's own two scores\)$/)
  assert.deepEqual([researchMeta().best_bpb, researchMeta().best_epoch], [0.6, 81])
  assert.deepEqual([researchMeta().scoring.margin_bpb, researchMeta().scoring.margin_basis, researchMeta().scoring.max_margin_bpb], [0.05, 'ceiling', 0.05])
  // The models are told the margin that applies, not the runaway one, and the row and the public state carry it.
  assert.ok(world.chats[0].messages[0].content.includes('The margin now is 0.0500 val_bpb (margin: the ceiling of 0.0500, because twice the measured noise of'))
  assert.equal(ledgerRows(world)[1].split('\t')[17], '0.0500')
  const res = await getScoring()
  assert.deepEqual([res.body.research.margin_bpb, res.body.research.margin_basis, res.body.research.max_margin_bpb], [0.05, 'ceiling', 0.05])
  // A lower ceiling of my own is honoured, and the floor still holds under it.
  freshLab()
  enable({ LAB_RESEARCH_MAX_MARGIN: '0.01' })
  researchExperiment()
  lab.repeats.push(stored(1, 69, 'confirm', 'c'.repeat(64), 3.00, 0.20), stored(2, 70, 'confirm', 'b'.repeat(64), 4.90, 0.10), stored(3, 71, 'control', confirm.trainSha256(TRAIN_PY), 0.70, 0.7), stored(4, 72, 'control', confirm.trainSha256(TRAIN_PY), 0.70, 0.7))
  fakeWorld({ runs: [0.695, 0.695] })
  await runEpoch()
  assert.deepEqual([lab.epochs[0].research_run.confirm.verdict, lab.epochs[0].research_run.confirm.margin_bpb, lab.epochs[0].research_run.confirm.margin_basis], ['within_noise', 0.01, 'ceiling'])
})

// ===========================================================================
// 4b. What a repeat costs, and what ends it
// ===========================================================================
test('a repeat is not started once the day\'s cap is reached: the epoch waits with its candidate and repeats it when the cap allows', async () => {
  enable({ LAB_RESEARCH_ALONGSIDE: 'true', LAB_RESEARCH_DAILY_BUDGET_USD: '2' })
  researchExperiment()
  const world = fakeWorld({ runs: [0.69, 0.692] })
  // The epoch's own run used up what was left: by the time the Reviewer has kept it, the ledger says the cap is reached.
  lab.spentToday = 2
  await assert.rejects(runEpoch(), e => e.name === 'BudgetPausedError' && e.status.allowed === false && e.status.reason === 'research daily budget reached')
  // No second GPU run, no row, and the candidate is neither kept nor thrown away.
  assert.equal(world.starts.length, 1)
  assert.deepEqual(lab.repeats, [])
  assert.equal(lab.modelCalls.some(c => c.model_id === 'tool/research_gpu_repeat'), false)
  assert.equal(lab.epochs[0].reviewer_output.verdict, 'keep')
  assert.equal('confirm' in lab.epochs[0].research_run, false)
  assert.equal(lab.experiments[0].current_epoch, 80)
  assert.deepEqual(world.puts, [])
  assert.ok(logs.some(l => l.includes('[Research e81] lab repeat not started: research daily budget reached; the epoch waits')))
  assert.equal(logs.some(l => l.includes('[Research e81] failed')), false)
  // Asked again while the cap still holds: the same answer, and still nothing started or asked of a model.
  const chats = world.chats.length
  await assert.rejects(runEpoch(), e => e.name === 'BudgetPausedError')
  assert.deepEqual([world.starts.length, world.chats.length], [1, chats])
  // A ledger that cannot be read starts nothing either.
  const handler = db.handler
  db.handler = (text, values) => { if (text.includes('FROM model_calls WHERE created_at >= ?')) throw new Error('database is away'); return handler(text, values) }
  await assert.rejects(runEpoch(), e => e.name === 'BudgetPausedError' && e.status.reason === 'spend ledger unavailable')
  assert.equal(world.starts.length, 1)
  db.handler = handler
  // The cap resets: the same epoch repeats the run it kept and decides.
  lab.spentToday = 0
  await runEpoch()
  assert.deepEqual(world.starts[1], { train_py: NEW_TRAIN_PY, budget_s: 300 })
  assert.equal(lab.epochs[0].research_run.confirm.verdict, 'confirmed')
  close(researchMeta().best_bpb, 0.691)
  assert.equal(world.chats.length, chats + 1) // only the Commentator was still to speak
  assert.equal(lab.modelCalls.filter(c => c.model_id === 'tool/research_gpu_repeat').length, 1)

  // The tick and the manual route answer this the way they answer any budget pause.
  const tick = readFileSync(join(root, 'api/epoch/tick.ts'), 'utf8')
  const run = readFileSync(join(root, 'api/epoch/run.ts'), 'utf8')
  assert.ok(tick.includes('if (e instanceof BudgetPausedError) {') && run.includes('if (e instanceof BudgetPausedError) {'))
})

test('a status endpoint that cannot be read is not an outcome: the repeat stays open until the runner answers or it is too old', async () => {
  const pending = e => e.name === 'ResearchRunPendingError' && e.callId === 'call-2'
  for (const hiccup of ['http502', 'unreachable']) {
    freshLab()
    process.env = { ...BASE_ENV }
    enable({ RESEARCH_RUN_POLL_MAX_MS: '40' })
    researchExperiment({ best_bpb: 0.699 })
    // The Reviewer kept 0.6950 against a best of 0.6990. The repeat is training, but its status cannot be read.
    const world = fakeWorld({ runs: [0.695, hiccup] })
    await assert.rejects(runEpoch(), pending, hiccup)
    assert.deepEqual(lab.repeats.map(r => [r.kind, r.status, r.val_bpb]), [['confirm', 'running', null]])
    assert.equal(lab.epochs[0].reviewer_output.verdict, 'keep')
    assert.equal('confirm' in lab.epochs[0].research_run, false)
    assert.deepEqual(world.puts, [])
    // The repeat finishes and the status can be read again: the keep stands on both runs.
    world.runs = [0.695, 0.6952]
    await runEpoch()
    assert.equal(lab.epochs[0].research_run.confirm.verdict, 'confirmed', hiccup)
    assert.equal(lab.epochs[0].reviewer_output.verdict, 'keep')
    close(researchMeta().best_bpb, 0.6951)
    assert.equal(world.starts.length, 3) // run, one repeat, the control after the epoch
  }

  // Unreadable for longer than the age limit: given up as lost, which confirms nothing.
  freshLab()
  process.env = { ...BASE_ENV }
  enable({ RESEARCH_RUN_POLL_MAX_MS: '40' })
  researchExperiment({ best_bpb: 0.699 })
  let world = fakeWorld({ runs: [0.695, 'http502'] })
  await assert.rejects(runEpoch(), pending)
  lab.repeats[0].created_at = new Date(Date.now() - confirm.REPEAT_LOST_AFTER_MS + 60_000)
  await assert.rejects(runEpoch(), pending) // not yet
  lab.repeats[0].created_at = new Date(Date.now() - confirm.REPEAT_LOST_AFTER_MS - 60_000)
  await runEpoch()
  assert.deepEqual([lab.epochs[0].research_run.confirm.verdict, lab.epochs[0].research_run.confirm.repeat_status], ['not_confirmed', 'lost'])
  assert.equal(lab.repeats[0].status, 'lost')
  assert.equal(lab.epochs[0].reviewer_output.verdict, 'revert')

  // A control whose status cannot be read stays open: it is not closed as lost, nothing is charged, and no second control starts beside it.
  freshLab()
  process.env = { ...BASE_ENV }
  enable({ LAB_RESEARCH_ALONGSIDE: 'true' })
  researchExperiment()
  world = fakeWorld({ verdict: 'revert', runs: [0.74, 'http502', 0.74, 0.74, 0.74] })
  const controls = () => lab.repeats.filter(r => r.kind === 'control').map(r => [r.epoch_number, r.status, r.val_bpb])
  const charged = () => lab.modelCalls.filter(c => c.model_id === 'tool/research_gpu_control').length
  await runEpoch() // 81: the control is call-2
  await runEpoch() // 82: its status answers 502
  assert.deepEqual(controls(), [[81, 'running', null]])
  assert.deepEqual([world.starts.length, charged()], [3, 0])
  world.runs[1] = 'unreachable'
  await runEpoch() // 83: no answer at all
  assert.deepEqual(controls(), [[81, 'running', null]])
  assert.deepEqual([world.starts.length, charged()], [4, 0])
  world.runs[1] = 0.701
  await runEpoch() // 84: it had finished; collected once, charged once, and the next control may start
  assert.deepEqual(controls(), [[81, 'ok', 0.701], [84, 'running', null]])
  assert.deepEqual([world.starts.length, charged()], [6, 1])
  // The runner's own word that a call failed still ends a control at once (the test of lost controls above).
  const source = readFileSync(join(root, 'api/_lib/research.ts'), 'utf8')
  assert.ok(source.includes("if (data.status === 'failed') return { status: 'failed', error: String(data.error || 'unknown'), reported: true }"))
  assert.ok(source.includes("if (!res.ok) return { status: 'failed', error: `status endpoint HTTP ${res.status}` }"))
})

test('a confirmation left open by an epoch that ended without it is collected at the next epoch, and its GPU time reaches the ledger', async () => {
  enable({ LAB_RESEARCH_ALONGSIDE: 'true', RESEARCH_RUN_POLL_MAX_MS: '40' })
  researchExperiment()
  const world = fakeWorld({ runs: [0.69, 'running'] })
  await assert.rejects(runEpoch(), e => e.name === 'ResearchRunPendingError') // 81 waits for its repeat (call-2)
  // The switch goes off while the repeat trains: the epoch finishes on the Reviewer's stored keep.
  delete process.env.LAB_RESEARCH_CONFIRM
  await runEpoch()
  assert.deepEqual([lab.experiments[0].current_epoch, researchMeta().best_bpb], [81, 0.69])
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.epoch_number, r.status]), [['confirm', 81, 'running']])
  const repeatCost = () => lab.modelCalls.filter(c => c.model_id === 'tool/research_gpu_repeat').map(c => [c.epoch_number, Number(c.cost_usd.toFixed(6))])
  assert.deepEqual(repeatCost(), [])

  // A confirmation of the epoch that is running belongs to that epoch: collecting leaves it alone.
  process.env.LAB_RESEARCH_CONFIRM = 'true'
  world.runs = [0.69, 0.691, 0.74]
  await confirm.collectRepeats(EXPERIMENT, 81, 300)
  assert.equal(lab.repeats[0].status, 'running')

  // On again: the next epoch closes it before anything else, and its GPU time is counted under the epoch it belonged to.
  world.verdict = 'revert'
  await runEpoch() // 82
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.epoch_number, r.status, r.val_bpb]), [['confirm', 81, 'ok', 0.691], ['control', 82, 'running', null]])
  assert.deepEqual(repeatCost(), [[81, Number((400 * 0.000306).toFixed(6))]])
  assert.ok(logs.some(l => l.includes('[Research] repeat left open by epoch 81 collected: ok val_bpb=0.691')))
  assert.equal(world.files['lab-repeats.tsv'].trimEnd().split('\n')[1].split('\t').slice(0, 6).join('|'), `confirm|81|${confirm.trainSha256(NEW_TRAIN_PY)}|0.6910|ok|0.6900`)
  // The epoch it belonged to is not reopened: its record stays as it finished.
  assert.equal('confirm' in lab.epochs[0].research_run, false)
  assert.equal(researchMeta().best_bpb, 0.69)
  // One that the runner no longer has, or that is too old, is closed as lost the same way.
  lab.repeats.push({ id: 3, created_at: new Date(Date.now() - confirm.REPEAT_LOST_AFTER_MS - 60_000), experiment_id: EXPERIMENT, epoch_number: 80, kind: 'confirm', train_sha256: 'a'.repeat(64), reference_bpb: 0.7, reference_epoch: 80, call_id: 'call-99', status: 'running', val_bpb: null, result: null, cost_usd: null, ledger_written: false, finished_at: null })
  await confirm.collectRepeats(EXPERIMENT, 83, 300)
  assert.equal(lab.repeats[2].status, 'lost')
})

test('the wait for a repeat leaves room for the rest of the epoch, the runner is always asked once, and no control is started late in a request', async () => {
  // 800 s, less one Commentator call at its full timeout, less 150 s for the writes.
  assert.equal(confirm.FUNCTION_LIMIT_MS, 800_000)
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
  for (const route of ['api/epoch/tick.ts', 'api/epoch/run.ts']) assert.equal(vercel.functions[route].maxDuration * 1000, confirm.FUNCTION_LIMIT_MS)
  assert.equal(confirm.confirmWaitDeadlineMs(240_000), 410_000)
  assert.equal(confirm.confirmWaitDeadlineMs(openrouter.completionTimeoutMs()), 410_000)
  assert.equal(confirm.confirmWaitDeadlineMs(600_000), 50_000)
  assert.equal(confirm.confirmWaitDeadlineMs(900_000), 0)
  for (const odd of [NaN, 0, -1, undefined, '240000']) assert.equal(confirm.confirmWaitDeadlineMs(odd), 410_000)
  const epochSource = readFileSync(join(root, 'api/_lib/research-epoch.ts'), 'utf8')
  assert.ok(epochSource.includes('maxWaitMs: Math.min(runPollMaxMs(), confirmWaitDeadlineMs(completionTimeoutMs()) - (Date.now() - requestStartedAt)),'))
  assert.ok(epochSource.includes('requestElapsedMs: Date.now() - requestStartedAt,'))

  // No time left to wait: the runner is still asked once, so a repeat that has finished is never left waiting for a tick with time to spare.
  enable()
  let world = fakeWorld({ runs: [0.692] })
  const args = { experimentId: EXPERIMENT, epoch: 81, trainPy: NEW_TRAIN_PY, first: 0.69, best: 0.7, budgetS: 300 }
  const decision = await confirm.confirmNewBest({ ...args, maxWaitMs: -5000 })
  assert.equal(decision.verdict, 'confirmed')
  assert.deepEqual(world.polls, ['call-1'])
  freshLab()
  world = fakeWorld({ runs: ['running'] })
  await assert.rejects(confirm.confirmNewBest({ ...args, maxWaitMs: 0 }), e => e.name === 'ResearchRunPendingError' && e.callId === 'call-1')
  assert.deepEqual(world.polls, ['call-1'])

  // A control is not started past the deadline: nothing is asked of the database or the runner, and it is due again after the next epoch.
  freshLab()
  world = fakeWorld()
  const control = { experimentId: EXPERIMENT, epoch: 81, trainPy: TRAIN_PY, bestBpb: 0.7, bestEpoch: 40, budgetS: 300 }
  assert.equal(confirm.CONTROL_START_DEADLINE_MS, 680_000)
  assert.equal(await confirm.maybeStartControl({ ...control, requestElapsedMs: confirm.CONTROL_START_DEADLINE_MS + 1 }), null)
  assert.deepEqual([world.starts.length, lab.statements.length, lab.repeats.length], [0, 0, 0])
  assert.ok(logs.some(l => l.includes('[Research e81] no control run: 680 s into the request, too late to start one safely')))
  assert.equal(await confirm.maybeStartControl({ ...control, epoch: 82, requestElapsedMs: confirm.CONTROL_START_DEADLINE_MS }), 82)
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.epoch_number, r.status]), [['control', 82, 'running']])
})

// ===========================================================================
// 4c. Starting a repeat, the cap with open repeats, and whose noise judges a run
// ===========================================================================
const storedRepeat = (over = {}) => ({ id: 1, created_at: new Date(), experiment_id: EXPERIMENT, epoch_number: 80, kind: 'control', train_sha256: 'a'.repeat(64), reference_bpb: 0.7, reference_epoch: 40, call_id: 'call-50', status: 'running', val_bpb: null, result: null, cost_usd: null, ledger_written: false, finished_at: null, ...over })
const confirmArgs = { experimentId: EXPERIMENT, epoch: 81, trainPy: NEW_TRAIN_PY, first: 0.69, best: 0.7, budgetS: 300, maxWaitMs: 0 }

test('a repeat is not started late in a request: the epoch defers it, the next tick starts it, and the time before the epoch counts', async () => {
  const deferred = e => e instanceof research.ResearchRunPendingError && e.name === 'RepeatDeferredError'
  assert.equal(confirm.REPEAT_START_DEADLINE_MS, 680_000)
  assert.equal(confirm.CONTROL_START_DEADLINE_MS, confirm.REPEAT_START_DEADLINE_MS)
  enable()
  researchExperiment()
  const world = fakeWorld({ runs: [0.69, 0.692] })
  // The request began 700 s ago (the tick spent that long before this epoch): the epoch's run is kept, the repeat is not started.
  await assert.rejects(researchEpoch.runResearchEpoch(EXPERIMENT, { requestStartedAt: Date.now() - 700_000 }), deferred)
  assert.equal(world.starts.length, 1)
  assert.deepEqual(lab.repeats, [])
  assert.equal(lab.epochs[0].reviewer_output.verdict, 'keep')
  assert.equal(lab.experiments[0].current_epoch, 80)
  assert.ok(logs.some(l => l.includes('[Research e81] lab repeat not started: 700 s into the request, too late to start one safely; the next tick starts it')))
  // The next tick, early in its request, starts it and decides.
  await researchEpoch.runResearchEpoch(EXPERIMENT, { requestStartedAt: Date.now() - 5_000 })
  assert.deepEqual(world.starts[1], { train_py: NEW_TRAIN_PY, budget_s: 300 })
  assert.equal(lab.epochs[0].research_run.confirm.verdict, 'confirmed')
  assert.equal(world.starts.length, 3) // and the control after it

  // A start time in the future, or not a number, is taken as now.
  freshLab()
  enable()
  researchExperiment()
  const later = fakeWorld({ runs: [0.69, 0.692] })
  await researchEpoch.runResearchEpoch(EXPERIMENT, { requestStartedAt: Date.now() + 3_600_000 })
  assert.equal(later.starts.length, 3)

  // No control is started when the request is late, counted from when it began, not from when the epoch began.
  freshLab()
  enable()
  researchExperiment()
  const reverted = fakeWorld({ verdict: 'revert', runs: [0.74] })
  await researchEpoch.runResearchEpoch(EXPERIMENT, { requestStartedAt: Date.now() - 690_000 })
  assert.equal(reverted.starts.length, 1)
  assert.ok(logs.some(l => l.includes('[Research e81] no control run: 690 s into the request')))

  // The handlers take the time before anything else and pass it down to the research epoch.
  const tick = readFileSync(join(root, 'api/epoch/tick.ts'), 'utf8')
  assert.ok(tick.indexOf('const requestStartedAt = Date.now()') < tick.indexOf('await collectTinkerRuns()'))
  assert.ok(tick.includes('result = await runEpoch(experiment.id, { requestStartedAt })'))
  const run = readFileSync(join(root, 'api/epoch/run.ts'), 'utf8')
  assert.ok(run.includes('const requestStartedAt = Date.now()') && run.includes('result = await runEpoch(experiment.id, { requestStartedAt })'))
  const runner = readFileSync(join(root, 'api/_lib/epoch-runner.ts'), 'utf8')
  assert.ok(runner.includes('return runResearchEpoch(experimentId, opts)'))
})

test('the wait for a repeat is counted from before its start, so a slow start comes out of it', async () => {
  enable()
  const world = fakeWorld({ runs: ['running'] })
  const inner = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://runner.example/start') await new Promise(r => setTimeout(r, 150))
    return inner(url, options)
  }
  // 100 ms to wait, and the start alone takes 150 ms: the runner is asked once, and the request does not wait on.
  await assert.rejects(confirm.confirmNewBest({ ...confirmArgs, maxWaitMs: 100 }), e => e.name === 'ResearchRunPendingError' && e.callId === 'call-1')
  assert.deepEqual(world.polls, ['call-1'])
})

test('a repeat\'s row is written before the runner is asked: a start that is refused is removed, one that never answered is closed as lost and never started again', async () => {
  enable({ LAB_RESEARCH_ALONGSIDE: 'true' })
  let world = fakeWorld({ runs: [0.692] })
  const inner = globalThis.fetch
  let startAnswer = 'refuse'
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://runner.example/start') {
      if (startAnswer === 'refuse') return new Response('{"detail":"busy"}', { status: 503 })
      if (startAnswer === 'silent') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }
    return inner(url, options)
  }
  // The row is there, starting and without a call id, while the runner is asked.
  const seen = []
  const handler = db.handler
  db.handler = (text, values) => {
    if (text.startsWith('UPDATE research_repeats SET call_id')) seen.push(lab.repeats.map(r => [r.status, r.call_id]))
    return handler(text, values)
  }

  // Refused: the runner answered and started nothing, so the row goes and the next attempt starts it.
  await assert.rejects(confirm.confirmNewBest(confirmArgs), e => e.name === 'RunnerStartRefusedError' && /runner start failed: 503/.test(e.message))
  assert.deepEqual(lab.repeats, [])
  startAnswer = 'ok'
  const decision = await confirm.confirmNewBest(confirmArgs)
  assert.equal(decision.verdict, 'confirmed')
  assert.deepEqual(seen, [[['starting', null]]])
  assert.deepEqual(lab.repeats.map(r => [r.status, r.call_id]), [['ok', 'call-1']])

  // No answer at all: the run may have started. The row stays starting, and nothing starts a second one.
  freshLab()
  enable({ LAB_RESEARCH_ALONGSIDE: 'true' })
  world = fakeWorld({ runs: [0.692] })
  let plain = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://runner.example/start') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return plain(url, options)
  }
  await assert.rejects(confirm.confirmNewBest(confirmArgs), e => e.name === 'TimeoutError')
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.status, r.call_id]), [['confirm', 'starting', null]])
  // While the request that wrote it could still be running, the next attempt waits.
  globalThis.fetch = plain
  await assert.rejects(confirm.confirmNewBest(confirmArgs), e => e.name === 'RepeatDeferredError')
  assert.equal(world.starts.length, 0)
  // Once that request is certainly over: lost, charged at the full estimate, not confirmed, and not started again.
  lab.repeats[0].created_at = new Date(Date.now() - confirm.REPEAT_START_LOST_AFTER_MS - 1_000)
  const lost = await confirm.confirmNewBest(confirmArgs)
  assert.deepEqual([lost.verdict, lost.repeat_status], ['not_confirmed', 'lost'])
  assert.equal(world.starts.length, 0)
  assert.equal(lab.repeats[0].status, 'lost')
  assert.deepEqual(lab.modelCalls.filter(c => c.model_id === 'tool/research_gpu_repeat').map(c => Number(c.cost_usd.toFixed(6))), [Number(((300 + 180) * 0.000306).toFixed(6))])

  // A control whose start never answered holds back the next control until it is closed as lost the same way.
  freshLab()
  enable({ LAB_RESEARCH_ALONGSIDE: 'true' })
  world = fakeWorld({ runs: [] })
  plain = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://runner.example/start') throw new TypeError('fetch failed')
    return plain(url, options)
  }
  const control = { experimentId: EXPERIMENT, epoch: 81, trainPy: TRAIN_PY, bestBpb: 0.7, bestEpoch: 40, budgetS: 300 }
  assert.equal(await confirm.maybeStartControl(control), null)
  assert.deepEqual(lab.repeats.map(r => [r.kind, r.status]), [['control', 'starting']])
  // The public state does not take a control that is still starting as the last one.
  const starting = lab.repeats.map(r => ({ ...r, id: String(r.id), created_at: r.created_at.toISOString() }))
  assert.equal('last_control' in confirm.scoringSnapshot({ epoch: 81, rows: starting, minMargin: 0.002 }), false)
  globalThis.fetch = plain
  assert.equal(await confirm.maybeStartControl({ ...control, epoch: 82 }), null)
  await confirm.collectRepeats(EXPERIMENT, 82, 300)
  assert.equal(lab.repeats[0].status, 'starting')
  await confirm.collectRepeats(EXPERIMENT, 82, 300, new Date(Date.now() + confirm.REPEAT_START_LOST_AFTER_MS + 1_000))
  assert.equal(lab.repeats[0].status, 'lost')
  assert.equal(lab.modelCalls.filter(c => c.model_id === 'tool/research_gpu_control').length, 1)
  assert.ok(logs.some(l => l.includes('control after epoch 81 collected: lost val_bpb=n/a (its start was never recorded)')))
  // Only now is the next control started.
  assert.equal(await confirm.maybeStartControl({ ...control, epoch: 82 }), 82)
  assert.equal(world.starts.length, 1)
})

test('repeats that are still open count against the research cap at the full estimate before any more GPU time is started', async () => {
  const estimate = (300 + 180) * 0.000306
  enable({ LAB_RESEARCH_ALONGSIDE: 'true', LAB_RESEARCH_DAILY_BUDGET_USD: '1' })
  // Spent 0.90 of 1.00, and a control is still training: one more run would take the day past the cap.
  lab.spentToday = 0.9
  lab.repeats.push(storedRepeat())
  let world = fakeWorld({ runs: [0.692] })
  const status = await confirm.checkResearchGpuBudget(lab.repeats.map(r => ({ ...r, id: String(r.id) })), 300)
  assert.deepEqual([status.allowed, status.reason, Number(status.reserved_usd.toFixed(6))], [false, 'research daily budget reached', Number(estimate.toFixed(6))])
  await assert.rejects(confirm.confirmNewBest({ ...confirmArgs, epoch: 81 }), e => e.name === 'BudgetPausedError' && e.status.reserved_usd > 0)
  assert.equal(world.starts.length, 0)
  assert.equal(await confirm.maybeStartControl({ experimentId: EXPERIMENT, epoch: 90, trainPy: TRAIN_PY, bestBpb: 0.7, bestEpoch: 40, budgetS: 300 }), null)
  assert.equal(world.starts.length, 0)
  // With room for both it is started, and the cap check says what it held back for the open one.
  lab.spentToday = 0.8
  assert.ok((await confirm.checkResearchGpuBudget(lab.repeats.map(r => ({ ...r, id: String(r.id) })), 300)).allowed)
  assert.equal((await confirm.confirmNewBest({ ...confirmArgs, epoch: 81 })).verdict, 'confirmed')
  assert.equal(world.starts.length, 1)

  // The epoch's own run is held back the same way while one of the lab's repeats is open, and goes on when there is room.
  freshLab()
  enable({ LAB_RESEARCH_ALONGSIDE: 'true', LAB_RESEARCH_DAILY_BUDGET_USD: '1' })
  researchExperiment()
  lab.repeats.push(storedRepeat())
  lab.spentToday = 0.9
  world = fakeWorld({ verdict: 'revert', runs: [0.74] })
  await assert.rejects(runEpoch(), e => e.name === 'BudgetPausedError')
  assert.equal(world.starts.length, 0)
  assert.ok(logs.some(l => l.includes('[Research e81] GPU run not started: research daily budget reached, with the lab\'s open repeats counted')))
  lab.spentToday = 0.5
  await runEpoch()
  assert.equal(world.starts.length, 1)

  // Not beside run 2, GPU time is not on the ledger at all, so nothing is held back for it.
  freshLab()
  process.env = { ...BASE_ENV }
  enable({ LAB_DAILY_BUDGET_USD: '1' })
  lab.spentToday = 0.99
  const open = [storedRepeat({ id: '1' }), storedRepeat({ id: '2', kind: 'confirm', status: 'starting', call_id: null })]
  const single = await confirm.checkResearchGpuBudget(open, 300)
  assert.deepEqual([single.allowed, 'reserved_usd' in single], [true, false])
  // Nothing open beside run 2: the plain check of research's own cap.
  Object.assign(process.env, { LAB_RESEARCH_ALONGSIDE: 'true', LAB_RESEARCH_DAILY_BUDGET_USD: '1' })
  lab.spentToday = 0.99
  const plainCheck = await confirm.checkResearchGpuBudget([], 300)
  assert.deepEqual(plainCheck, { allowed: true, spent_usd: 0.99, budget_usd: 1, resumes_at: plainCheck.resumes_at, scope: 'research' })
})

test('the run being judged is not in the noise that judges it: a file that prints one number twice does not lower its own bar', async () => {
  enable()
  researchExperiment({ best_bpb: 0.6905 })
  const best = confirm.trainSha256(TRAIN_PY)
  // Controls of the best file printed 0.700 and 0.708; an earlier candidate printed 0.690 and then 0.694.
  lab.repeats.push(
    storedRepeat({ id: 1, epoch_number: 70, train_sha256: best, status: 'ok', val_bpb: 0.700, call_id: 'old-1', ledger_written: true }),
    storedRepeat({ id: 2, epoch_number: 71, train_sha256: best, status: 'ok', val_bpb: 0.708, call_id: 'old-2', ledger_written: true }),
    storedRepeat({ id: 3, epoch_number: 72, kind: 'confirm', train_sha256: 'e'.repeat(64), status: 'ok', val_bpb: 0.694, reference_bpb: 0.690, call_id: 'old-3', ledger_written: true }),
  )
  // The candidate prints 0.6800 in both runs: 0.0105 below the best.
  const world = fakeWorld({ runs: [0.68, 0.68] })
  await runEpoch()
  const d = lab.epochs[0].research_run.confirm
  // The noise without the pair: spreads of 0.004 and 0.002 (by 2 x 1.0483), middle 0.0031; margin 0.0063 x 2.
  close(d.noise_bpb, 2 * confirm.PAIR_DISTANCE_TO_SD * 0.003)
  assert.equal(d.noise_samples, 4)
  assert.equal(d.verdict, 'within_noise')
  assert.match(d.line, /^within noise: mean 0\.6800 of two runs \(0\.6800 and 0\.6800\) beats 0\.6905 by 0\.0105, not more than the 0\.0126 margin; not kept \(margin: twice the measured noise of 0\.0063, from 4 repeated scores, not counting this run's own two scores\)$/)
  assert.deepEqual([researchMeta().best_bpb, world.files['train.py']], [0.6905, TRAIN_PY])
  // With its own pair counted (a spread of zero), the bar would have been 0.0084 and the same pair a new best.
  const withPair = confirm.noiseFromRepeats(lab.repeats.map(r => ({ ...r, id: String(r.id) })))
  close(withPair.noise_bpb, 2 * confirm.PAIR_DISTANCE_TO_SD * 0.002)
  assert.equal(confirm.decideConfirmation({ first: 0.68, repeat: 0.68, repeatStatus: 'ok', best: 0.6905, noise: withPair, minMargin: 0.002 }).verdict, 'confirmed')
  // For later epochs the pair does count: the public state after the epoch has it.
  assert.equal(researchMeta().scoring.noise_samples, 6)
})

test('with stories on, the record and the models are told that the repeat has no save step', async () => {
  enable()
  fakeWorld({ runs: [0.692] })
  const d = await confirm.confirmNewBest({ ...confirmArgs, firstRunnerFlow: 'keep-1' })
  assert.match(d.line, /not counting this run's own two scores\); the first run had the runner's save step \(runner_flow keep-1\) and the lab's repeat did not$/)
  // A first run without it, or a flow that is not a plain word, adds nothing.
  freshLab()
  enable()
  fakeWorld({ runs: [0.692] })
  assert.equal((await confirm.confirmNewBest({ ...confirmArgs, firstRunnerFlow: 'keep 1; rm -rf' })).line.includes('save step'), false)
  // The note the models read says the same while stories are on, and what it always said otherwise.
  const plain = confirm.scoringPromptNote([], 0.002)
  assert.ok(plain.includes('the lab runs the same train.py once more, unchanged, through the same runner and harness.'))
  const saving = confirm.scoringPromptNote([], 0.002, 0.05, { saveStep: true })
  assert.ok(saving.includes('through the same runner, without the step that saves the trained model'))
  assert.equal(/\b(you should|you must|try to|aim|make sure|please)\b/i.test(saving), false)
  const epochSource = readFileSync(join(root, 'api/_lib/research-epoch.ts'), 'utf8')
  assert.ok(epochSource.includes('{ saveStep: researchTalkStatus().enabled }'))
  assert.ok(epochSource.includes('...(runResult.runner_flow ? { firstRunnerFlow: runResult.runner_flow } : {}),'))
})

test('the growth feed counts a confirmed best at the mean of its two runs, as the record does', () => {
  const epoch = (n, extra = {}) => ({ id: `e${n}`, epoch_number: n, completed_at: new Date(Date.parse('2026-11-01T00:00:00Z') + n * 3600_000).toISOString(), assigned_executor: 'openai/gpt-6-astra', decisions: [], review_verdict: 'keep', run_status: 'ok', ...extra })
  const breakthroughs = epochs => growth.buildGrowthEvents({ baselineBpb: 0.72, epochs, contributions: [], exhibits: [] }).filter(e => e.kind === 'breakthrough').map(e => [e.epoch, e.magnitude])
  // Epoch 10 printed 0.6900 and 0.6960: the best on record is their mean, 0.6930. Epoch 11 printed 0.6905 and
  // 0.6895: its mean of 0.6900 beat 0.6930 and the lab recorded a new best. Its first score alone is not below 0.6900.
  const confirmed = [
    epoch(10, { val_bpb: '0.69', confirm_verdict: 'confirmed', confirm_mean_bpb: '0.693' }),
    epoch(11, { val_bpb: '0.6905', confirm_verdict: 'confirmed', confirm_mean_bpb: 0.69 }),
  ]
  assert.deepEqual(breakthroughs(confirmed), [[10, growth.breakthroughMagnitude(0.72, 0.693)], [11, growth.breakthroughMagnitude(0.693, 0.69)]])
  // Without the lab's verdict (the switch was never on) the first score is the score, as it always was.
  assert.deepEqual(breakthroughs(confirmed.map(({ confirm_verdict, confirm_mean_bpb, ...e }) => e)), [[10, growth.breakthroughMagnitude(0.72, 0.69)]])
  for (const none of [{ confirm_verdict: null, confirm_mean_bpb: null }, { confirm_verdict: 'confirmed', confirm_mean_bpb: null }, { confirm_verdict: 'confirmed', confirm_mean_bpb: '' }, { confirm_verdict: 'confirmed', confirm_mean_bpb: 'x' }, { confirm_verdict: 'within_noise', confirm_mean_bpb: 0.5 }]) {
    assert.deepEqual(breakthroughs([epoch(10, { val_bpb: 0.69, ...none })]), [[10, growth.breakthroughMagnitude(0.72, 0.69)]], JSON.stringify(none))
  }
  // A keep the lab did not take is stored as a revert, and a mean without a score from the run itself is nothing.
  assert.deepEqual(breakthroughs([epoch(10, { review_verdict: 'revert', val_bpb: 0.69, confirm_verdict: 'within_noise', confirm_mean_bpb: 0.6995 })]), [])
  assert.deepEqual(breakthroughs([epoch(10, { val_bpb: null, confirm_verdict: 'confirmed', confirm_mean_bpb: 0.6 })]), [])
  // The feed reads the verdict and the mean from the epoch's stored run.
  const source = readFileSync(join(root, 'api/_lib/growth.ts'), 'utf8')
  assert.ok(source.includes("research_run->'confirm'->>'verdict' AS confirm_verdict, research_run->'confirm'->>'mean_bpb' AS confirm_mean_bpb"))
})

// ===========================================================================
// 5. The ledgers
// ===========================================================================
test('results.tsv gains the five columns the first time a row is written with the switch on, whatever header it had', async () => {
  const provenance = { metrics_source: 'experiment_stdout_unverified', dataset: 'tinystories', harness_sha256: null, train_wall_seconds: 310 }
  const fields = { epoch: 81, commit: 'reverted', val_bpb: 0.7058, train_steps: 100, train_seconds: 299, peak_vram_mb: null, params_m: 10.9, status: 'discard', hypothesis: 'h', provenance }
  const repeated = { repeat_bpb: 0.7064, mean_bpb: 0.7061, noise_bpb: 0.0011, margin_bpb: 0.0022, verdict: 'within_noise' }
  const old9 = '80\treverted\t0.7400\t100\t299.0\t-\t10.900\tdiscard\tan earlier run'
  const old13 = `${old9}\texperiment_stdout_unverified\ttinystories\t-\t310.0`
  const old14 = `${old13}\tkeep-1`
  const base13 = '81\treverted\t0.7058\t100\t299.0\t-\t10.900\tdiscard\th\texperiment_stdout_unverified\ttinystories\t-\t310.0'

  for (const [header, old] of [[LEDGER_9, old9], [LEDGER_13, old13], [LEDGER_14, old14], [LEDGER_19, `${old14}\t-\t-\t-\t-\t-`]]) {
    const world = fakeWorld({ files: { 'results.tsv': `${header}\n${old}\n` } })
    assert.equal(await research.appendResultsRow({ ...fields, confirm: repeated }), true)
    const rows = ledgerRows(world)
    assert.equal(rows[0], LEDGER_19, header)
    assert.equal(rows[1], old) // earlier rows are left as they were
    assert.equal(rows[2], `${base13}\t-\t0.7064\t0.7061\t0.0011\t0.0022\twithin_noise`)
    // The same row again (a retried epoch) is not written twice.
    assert.equal(await research.appendResultsRow({ ...fields, confirm: repeated }), false)
    assert.equal(ledgerRows(world).length, 3)
    // The lab reads every width of row in the one file.
    assert.equal(researchAlongside.summarizeLedger(world.files['results.tsv']).last_epoch, 81)
  }

  // A row with the switch on and no repeat: the wider header, and "-" in the five.
  let world = fakeWorld({ files: { 'results.tsv': `${LEDGER_13}\n${old13}\n` } })
  await research.appendResultsRow({ ...fields, confirm: null })
  assert.deepEqual(ledgerRows(world), [LEDGER_19, old13, `${base13}\t-\t-\t-\t-\t-\t-`])
  // A new ledger starts with the wider header.
  world = fakeWorld({})
  await research.appendResultsRow({ ...fields, confirm: null })
  assert.equal(ledgerRows(world)[0], LEDGER_19)
  // With the runner's flow on a repeated row, both are there.
  world = fakeWorld({ files: { 'results.tsv': `${LEDGER_13}\n` } })
  await research.appendResultsRow({ ...fields, provenance: { ...provenance, runner_flow: 'keep-1' }, confirm: repeated })
  assert.equal(ledgerRows(world)[1], `${base13}\tkeep-1\t0.7064\t0.7061\t0.0011\t0.0022\twithin_noise`)

  // Switch off (no confirm passed): a ledger that never saw it keeps its header and its width.
  for (const [header, width] of [[LEDGER_9, 13], [LEDGER_13, 13], [LEDGER_14, 14]]) {
    world = fakeWorld({ files: { 'results.tsv': `${header}\n` } })
    await research.appendResultsRow(fields)
    assert.equal(ledgerRows(world)[0], header === LEDGER_9 ? LEDGER_13 : header)
    assert.equal(ledgerRows(world)[1].split('\t').length, width)
  }
  // Switched off again later: the wider header stays and the row has "-" in the five.
  world = fakeWorld({ files: { 'results.tsv': `${LEDGER_19}\n` } })
  await research.appendResultsRow(fields)
  assert.deepEqual(ledgerRows(world), [LEDGER_19, `${base13}\t-\t-\t-\t-\t-\t-`])
  // A header the lab does not know is never rewritten, with or without the switch.
  for (const extra of [{}, { confirm: repeated }]) {
    world = fakeWorld({ files: { 'results.tsv': `${LEDGER_13}\tsomething_else\n` } })
    await assert.rejects(research.appendResultsRow({ ...fields, ...extra }), /does not start with a known header/)
    assert.deepEqual(world.puts, [])
  }
  // No cell of the new columns can carry anything but a number or a known word.
  world = fakeWorld({})
  await research.appendResultsRow({ ...fields, confirm: { repeat_bpb: '0.1\t9', mean_bpb: NaN, noise_bpb: Infinity, margin_bpb: null, verdict: 'confirmed' } })
  assert.equal(ledgerRows(world)[1].split('\t').slice(14).join('|'), '-|-|-|-|confirmed')
  assert.equal(ledgerRows(world).length, 2)

  // A kept row the lab confirmed counts at its mean; any other row at its own score.
  const kept = (epoch, val, tail) => `${epoch}\tmerged\t${val}\t100\t299.0\t-\t10.900\tkeep\th\texperiment_stdout_unverified\ttinystories\t-\t310.0\t-\t${tail}`
  assert.deepEqual(researchAlongside.summarizeLedger([LEDGER_19, kept(81, '0.6900', '0.6920\t0.6910\t-\t0.0020\tconfirmed')].join('\n')).best_kept, { epoch: 81, val_bpb: 0.691 })
  assert.deepEqual(researchAlongside.summarizeLedger([LEDGER_19, kept(81, '0.6900', '-\t-\t-\t-\t-')].join('\n')).best_kept, { epoch: 81, val_bpb: 0.69 })
  assert.deepEqual(researchAlongside.summarizeLedger([LEDGER_19, kept(81, '0.6900', '0.6920\tnot-a-number\t-\t0.0020\tconfirmed')].join('\n')).best_kept, { epoch: 81, val_bpb: 0.69 })
  // Rows of a width the lab never writes are not rows.
  assert.equal(researchAlongside.summarizeLedger(`${LEDGER_19}\n${kept(81, '0.6900', '-\t-\t-\t-\t-')}\textra`).last_epoch, 0)
})

test('lab-repeats.tsv gets one row per repeat, once, and a file that is not the lab\'s is left alone', async () => {
  const provenance = research.provenanceOf({ status: 'ok', metrics: { val_bpb: 0.7 }, dataset: 'tinystories', train_wall_seconds: 310 })
  const fields = { kind: 'control', epoch: 81, train_sha256: 'a'.repeat(64), val_bpb: 0.7012, status: 'ok', reference_bpb: 0.7, reference_epoch: 40, provenance, call_id: 'fc-01ABC' }
  let world = fakeWorld({})
  assert.equal(await research.appendLabRepeatRow(fields), true)
  assert.equal(await research.appendLabRepeatRow(fields), false)
  assert.equal(await research.appendLabRepeatRow({ ...fields, kind: 'confirm', epoch: 82, val_bpb: null, status: 'crash', reference_epoch: 82, provenance: research.provenanceOf(undefined), call_id: null }), true)
  assert.deepEqual(world.files['lab-repeats.tsv'].trimEnd().split('\n').slice(1), [
    `control\t81\t${'a'.repeat(64)}\t0.7012\tok\t0.7000\t40\texperiment_stdout_unverified\ttinystories\t-\t310.0\tfc-01ABC\t-`,
    `confirm\t82\t${'a'.repeat(64)}\t-\tcrash\t0.7000\t82\t-\t-\t-\t-\t-\t-`,
  ])
  // A run with the runner's save step says so in the last column.
  await research.appendLabRepeatRow({ ...fields, epoch: 83, provenance: research.provenanceOf({ status: 'ok', metrics: { val_bpb: 0.7 }, runner_flow: 'keep-1' }) })
  assert.equal(world.files['lab-repeats.tsv'].trimEnd().split('\n')[3].split('\t')[12], 'keep-1')
  // A file written with the twelve columns it had before gets the wider header; its rows stay as they were.
  const OLD_REPEATS_HEADER = 'kind\tepoch\ttrain_sha256\tval_bpb\tstatus\treference_bpb\treference_epoch\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds\tcall_id'
  const oldRow = `control\t80\t${'a'.repeat(64)}\t0.7000\tok\t0.7000\t40\t-\t-\t-\t-\tfc-0`
  world = fakeWorld({ files: { 'lab-repeats.tsv': `${OLD_REPEATS_HEADER}\n${oldRow}\n` } })
  assert.equal(await research.appendLabRepeatRow(fields), true)
  assert.deepEqual(world.files['lab-repeats.tsv'].trimEnd().split('\n').map(l => l.split('\t').length), [13, 12, 13])
  assert.equal(world.files['lab-repeats.tsv'].split('\n')[1], oldRow)
  // What is not a hash, a status word or a call id is written as "-", so no cell can add a column or a row.
  world = fakeWorld({})
  await research.appendLabRepeatRow({ ...fields, train_sha256: 'x\ty', status: 'ok\n81', call_id: 'a\tb' })
  assert.equal(world.files['lab-repeats.tsv'].trimEnd().split('\n')[1].split('\t').length, 13)
  assert.deepEqual(world.files['lab-repeats.tsv'].trimEnd().split('\n')[1].split('\t').filter((_, i) => [2, 4, 11].includes(i)), ['-', '-', '-'])
  world = fakeWorld({ files: { 'lab-repeats.tsv': 'someone else\'s file\n' } })
  await assert.rejects(research.appendLabRepeatRow(fields), /does not start with the lab's header/)
  assert.deepEqual(world.puts, [])
  await assert.rejects(research.appendLabRepeatRow({ ...fields, epoch: 1.5 }), /not a whole number/)
})

// ===========================================================================
// 6. Where a Tinker run's examples came from
// ===========================================================================
const SHA = 'ab12'.repeat(10)
const tinkerRow = (over = {}) => ({
  id: 'r1', experiment_id: EXPERIMENT, epoch: 41, model: 'anthropic/claude-fable-5.2', assigned_model: null, slug: 'e41-0a1b2c3d', base_model: 'meta/base',
  purpose: 'a test', dataset_sha256: 'd'.repeat(64), dataset_examples: 20, dataset_bytes: 2000, settings: {}, split_salt: 's', status: 'ok', reason: null,
  call_id: 'fc-0a1b2c3d', spend_day: '2026-11-19', reserved_usd: 0, cost_usd: 0.1, result: { n_holdout: 4, holdout_loss_before: 2.5, holdout_loss_after: 1.5 },
  sampler_path: null, expires_at: null, created_at: '2026-11-19T00:00:00.000Z', display_name: null, ...over,
})
const fromDataset = (repo = 'org/stories', sha = SHA) => ({ dataset_source: { repo, sha, file: 'train.jsonl' } })

test('every run has one of two origin labels, read from its own row, and the adapter carries it only while labels are on', () => {
  assert.equal(tinkerStore.ORIGIN_MODELS, 'written by the models')
  assert.equal(tinkerStore.dataOrigin(tinkerRow()), 'written by the models')
  assert.equal(tinkerStore.dataOrigin(tinkerRow(fromDataset())), `public dataset org/stories@${SHA}`)
  // A stored source that cannot be read is still a dataset, never "written by the models".
  for (const odd of [{ repo: 'org/stories' }, { repo: 'not a repo', sha: SHA }, { repo: 'org/stories', sha: 'main' }, {}]) {
    assert.equal(tinkerStore.dataOrigin(tinkerRow({ dataset_source: odd })), 'public dataset (its stored source cannot be read)')
  }
  // Off: the adapter is what it always was.
  const plain = tinkerStore.publicAdapter(tinkerRow())
  assert.equal('origin' in plain, false)
  assert.equal('origin' in tinkerStore.publicAdapter(tinkerRow(fromDataset())), false)
  process.env.LAB_TINKER_ORIGIN_LABELS = 'true'
  // On: one more field, and nothing else differs.
  assert.deepEqual(tinkerStore.publicAdapter(tinkerRow()), { ...plain, origin: 'written by the models' })
  const dataset = tinkerStore.publicAdapter(tinkerRow(fromDataset()))
  assert.equal(dataset.origin, `public dataset org/stories@${SHA}`)
  assert.equal(dataset.data_from, `org/stories@${SHA}`)

  // The stored record of a run says it too, only while labels are on.
  const run = readFileSync(join(root, 'api/_lib/tinker-run.ts'), 'utf8')
  assert.ok(run.includes("const origin = tinkerOriginFlag() ? dataOrigin(row) : null"))
  assert.ok(run.includes("${origin ? `; data origin: ${origin}` : ''}"))
  assert.ok(run.includes('...(origin ? { origin } : {})'))
})

test('the summary gives, per origin, the count of runs and the median held-out loss before and after', async () => {
  const measured = (before, after, extra = {}) => tinkerRow({ result: { holdout_loss_before: before, holdout_loss_after: after }, ...extra })
  const rows = [
    measured(3.0, 2.0), measured(2.0, 1.0), measured(4.0, 1.5), // written by the models: medians 3.0 and 1.5
    tinkerRow({ status: 'refused', result: null }), // counted as a run, not as measured
    tinkerRow({ status: 'ok', result: { holdout_loss_before: 2.2, holdout_loss_after: null } }), // one loss missing: not measured
    tinkerRow({ status: 'failed', result: { holdout_loss_before: 9, holdout_loss_after: 9 } }), // did not finish: not measured
    measured(2.0, 1.8, fromDataset()), measured(3.0, 2.0, fromDataset()), // a dataset: medians 2.5 and 1.9
    tinkerRow({ status: 'running', result: null, ...fromDataset('org/other') }),
    tinkerRow({ status: 'running', result: null, dataset_source: { repo: 'broken' } }),
    // Opened and closed before anything reached the runner: not a training run of either origin. The first
    // is how a dataset run looks when its source could not be stored, which must not count as model-written.
    tinkerRow({ status: 'failed', result: null, call_id: null, reason: 'the lab could not store where the examples came from, so nothing was started' }),
    tinkerRow({ status: 'failed', result: null, call_id: null, reason: 'its start was never confirmed', ...fromDataset() }),
    tinkerRow({ status: 'reserved', result: null, call_id: null }),
  ]
  for (const [row, reached] of [
    [{ status: 'failed', result: null, call_id: null }, false], [{ status: 'reserved', result: null }, false], [{ status: 'lost', result: null, call_id: '' }, false],
    [{ status: 'failed', result: null, call_id: 'fc-1' }, true], [{ status: 'running', result: null, call_id: null }, true],
    [{ status: 'ok', result: null, call_id: null }, true], [{ status: 'refused', result: { stage: 'checks' }, call_id: null }, true],
  ]) assert.equal(tinkerStore.reachedRunner(row), reached, JSON.stringify(row))
  const summary = tinkerStore.summarizeOrigins(rows)
  assert.deepEqual(summary[0], { origin: 'written by the models', runs: 6, measured: 3, median_holdout_loss_before: 3, median_holdout_loss_after: 1.5 })
  assert.deepEqual({ ...summary[1], median_holdout_loss_after: 0 }, {
    origin: 'public dataset', runs: 4, measured: 2, median_holdout_loss_before: 2.5, median_holdout_loss_after: 0,
    datasets: [{ data_from: `org/stories@${SHA}`, runs: 2 }, { data_from: '(its stored source cannot be read)', runs: 1 }, { data_from: `org/other@${SHA}`, runs: 1 }],
  })
  close(summary[1].median_holdout_loss_after, 1.9)
  // Nothing trained yet: two rows of zeros, and no medians.
  const empty = [
    { origin: 'written by the models', runs: 0, measured: 0, median_holdout_loss_before: null, median_holdout_loss_after: null },
    { origin: 'public dataset', runs: 0, measured: 0, median_holdout_loss_before: null, median_holdout_loss_after: null, datasets: [] },
  ]
  assert.deepEqual(tinkerStore.summarizeOrigins([]), empty)

  // From the database: it only looks. A lab with no such table gets the empty summary and creates nothing.
  noNetwork()
  assert.deepEqual(await tinkerStore.originSummary(), empty)
  assert.deepEqual(lab.statements.map(s => s.text), ['SELECT * FROM tinker_runs ORDER BY created_at DESC LIMIT ?'])
  assert.equal(lab.statements[0].values[0], tinkerStore.ORIGIN_SUMMARY_RUNS)
  lab.tinkerRuns = rows.map(r => ({ ...r, result: r.result ? JSON.stringify(r.result) : null, dataset_source: r.dataset_source ? JSON.stringify(r.dataset_source) : undefined }))
  assert.deepEqual(await tinkerStore.originSummary(), summary)
})

test('the chat panel shows the label the server sent, and nothing new when it sent none', () => {
  const base = { slug: 'e41-0a1b2c3d', base_model: 'meta/base', epoch: 41, author_name: 'Claude Fable 5.2', examples: 20 }
  const [plain] = chatPanel.parseAdapters({ adapters: [base] })
  assert.equal('dataOrigin' in plain, false)
  assert.equal('label' in chatPanel.describeAdapter(plain), false)
  const [models] = chatPanel.parseAdapters({ adapters: [{ ...base, origin: 'written by the models' }] })
  assert.equal(models.dataOrigin, 'written by the models')
  assert.equal(chatPanel.describeAdapter(models).label, 'Data origin: written by the models.')
  // Everything else about the adapter's lines is what it was.
  const { label, ...rest } = chatPanel.describeAdapter(models)
  assert.deepEqual(rest, chatPanel.describeAdapter(plain))
  const [dataset] = chatPanel.parseAdapters({ adapters: [{ ...base, data_from: `org/stories@${SHA}`, origin: `public dataset org/stories@${SHA}` }] })
  assert.equal(chatPanel.describeAdapter(dataset).label, `Data origin: public dataset org/stories@${SHA.slice(0, 12)}.`)
  // Only the two labels the lab writes are shown; anything else is left out.
  for (const odd of ['written by a person', 'public dataset <b>x</b>', 'public dataset org/stories@main', '', 7, null, `public dataset org/stories@${SHA} and more`]) {
    assert.equal('dataOrigin' in chatPanel.parseAdapters({ adapters: [{ ...base, origin: odd }] })[0], false, String(odd))
  }
  const panel = readFileSync(join(root, 'src/systems/TrainedChatPanel.ts'), 'utf8')
  assert.ok(panel.includes('for (const line of [a.purpose, d.origin, d.label, d.score, d.kept])'))
  assert.equal(/[—–]/.test(chatPanel.describeAdapter(dataset).label), false)
})

// ===========================================================================
// 7. The public state
// ===========================================================================
test('the public scoring state shows the noise with its sample count, the margin, the last verdict and the repeats, and the origin summary', async () => {
  enable()
  researchExperiment({ best_bpb: 0.7067 })
  fakeWorld({ runs: [0.7058, 0.7064] })
  await runEpoch()
  noNetwork()
  lab.statements = []

  let res = await getScoring()
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.tinker_origin, { enabled: false })
  assert.deepEqual(Object.keys(res.body.about), ['research'])
  assert.match(res.body.about.research, /printed by the generated train\.py and is unverified/)
  const r = res.body.research
  assert.deepEqual([r.enabled, r.min_margin_bpb, r.control_every_epochs, r.experiment_id, r.noise_bpb, r.noise_samples, r.noise_state, r.margin_bpb], [true, 0.002, 10, EXPERIMENT, null, 2, 'noise not yet measured', 0.002])
  assert.deepEqual([r.margin_basis, r.max_margin_bpb], ['floor', 0.05])
  assert.deepEqual([r.last_verdict.epoch, r.last_verdict.verdict, r.last_verdict.first_bpb, r.last_verdict.repeat_bpb, r.last_verdict.best_bpb], [81, 'within_noise', 0.7058, 0.7064, 0.7067])
  assert.match(r.last_verdict.line, /^within noise: mean 0\.7061 of two runs/)
  assert.deepEqual(r.repeats.map(x => [x.kind, x.epoch, x.status, x.val_bpb, x.reference_bpb]), [['control', 81, 'running', null, 0.7067], ['confirm', 81, 'ok', 0.7064, 0.7058]])
  assert.deepEqual(Object.keys(r.repeats[0]), ['kind', 'epoch', 'status', 'val_bpb', 'reference_bpb', 'train_sha256', 'started_at'])
  // No dollar amount, no call id, and it created nothing.
  assert.equal(/usd|cost|call_id|call-/.test(JSON.stringify(res.body)), false)
  assert.equal(lab.statements.some(s => /^(CREATE|ALTER|INSERT|UPDATE|DELETE)/.test(s.text)), false)
  // Kept for a minute per instance: a second read asks the database nothing.
  lab.statements = []
  await getScoring()
  assert.deepEqual(lab.statements, [])

  // The research state beside run 2 carries the same scoring once there is one.
  const summary = await researchAlongside.researchSummary()
  assert.deepEqual(summary.scoring, researchMeta().scoring)
  assert.equal(summary.scoring.last_verdict.verdict, 'within_noise')

  // With measured noise the state says so.
  scoring.resetScoringCache()
  const sha = 'c'.repeat(64)
  for (const val of [0.700, 0.702, 0.704]) lab.repeats.push({ id: lab.repeats.length + 1, created_at: new Date(), experiment_id: EXPERIMENT, epoch_number: 90 + lab.repeats.length, kind: 'control', train_sha256: sha, reference_bpb: 0.7, reference_epoch: 40, call_id: 'x', status: 'ok', val_bpb: val, result: null, cost_usd: null, ledger_written: true, finished_at: new Date() })
  res = await getScoring()
  assert.equal(res.body.research.noise_state, 'measured from repeated runs of the same train.py')
  assert.equal(res.body.research.noise_samples, 5)
  assert.ok(res.body.research.margin_bpb > 0.002)
  assert.equal(res.body.research.margin_basis, 'noise')

  // The origin summary alone, with the research switch off: the research part reads nothing.
  process.env = { ...BASE_ENV, LAB_TINKER_ORIGIN_LABELS: 'true' }
  scoring.resetScoringCache()
  lab.statements = []
  lab.tinkerRuns = [tinkerRow(), tinkerRow(fromDataset())]
  res = await getScoring()
  assert.deepEqual(res.body.research, { enabled: false })
  assert.deepEqual(Object.keys(res.body.about), ['tinker_origin'])
  assert.deepEqual(res.body.tinker_origin.origins.map(o => [o.origin, o.runs, o.measured, o.median_holdout_loss_before, o.median_holdout_loss_after]), [['written by the models', 1, 1, 2.5, 1.5], ['public dataset', 1, 1, 2.5, 1.5]])
  assert.deepEqual(lab.statements.map(s => s.text), ['SELECT * FROM tinker_runs ORDER BY created_at DESC LIMIT ?'])

  // No active research experiment, and a database that is away: plain answers, not errors.
  freshLab()
  enable()
  scoring.resetScoringCache()
  res = await getScoring()
  assert.deepEqual([res.code, res.body.research.experiment_id, res.body.research.noise_bpb, res.body.research.last_verdict, res.body.research.repeats], [200, null, null, null, []])
  scoring.resetScoringCache()
  db.handler = () => { throw new Error('database is away') }
  res = await getScoring()
  assert.deepEqual([res.code, res.body.research], [200, { enabled: true, unavailable: true }])
})

// ===========================================================================
// 8. The documents and the room
// ===========================================================================
test('the documents state the switches, their defaults and the owner\'s steps as the code has them', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const ops = readFileSync(join(root, 'docs/OPERATIONS.md'), 'utf8')
  const tools = readFileSync(join(root, 'docs/TOOLS.md'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  for (const name of ['LAB_RESEARCH_CONFIRM', 'LAB_RESEARCH_MIN_MARGIN', 'LAB_RESEARCH_MAX_MARGIN', 'LAB_RESEARCH_CONTROL_EVERY', 'LAB_TINKER_ORIGIN_LABELS']) {
    for (const [doc, text] of [['OPERATIONS.md', ops], ['.env.example', env]]) assert.ok(text.includes(name), `${name} in ${doc}`)
  }
  for (const line of ['LAB_RESEARCH_CONFIRM=false', `LAB_RESEARCH_MIN_MARGIN=${confirm.DEFAULT_MIN_MARGIN_BPB}`, `LAB_RESEARCH_MAX_MARGIN=${confirm.DEFAULT_MAX_MARGIN_BPB}`, `LAB_RESEARCH_CONTROL_EVERY=${confirm.DEFAULT_CONTROL_EVERY}`, 'LAB_TINKER_ORIGIN_LABELS=false']) {
    assert.ok(env.split('\n').includes(line), `${line} in .env.example`)
  }
  for (const row of ['| `LAB_RESEARCH_CONFIRM` | false |', `| \`LAB_RESEARCH_MIN_MARGIN\` | ${confirm.DEFAULT_MIN_MARGIN_BPB} |`, `| \`LAB_RESEARCH_MAX_MARGIN\` | ${confirm.DEFAULT_MAX_MARGIN_BPB} |`, `| \`LAB_RESEARCH_CONTROL_EVERY\` | ${confirm.DEFAULT_CONTROL_EVERY} |`, '| `LAB_TINKER_ORIGIN_LABELS` | false |']) {
    assert.ok(ops.includes(row), `${row} in OPERATIONS.md`)
  }
  assert.ok(ops.includes('## Scoring research results'))
  assert.ok(ops.includes('this change does not touch `modal/research_runner.py` or any other Modal file, so I redeploy nothing there'))
  assert.ok(ops.includes(`never past ${confirm.confirmWaitDeadlineMs(240_000) / 1000} s into the request`))
  assert.ok(ops.includes(`less ${confirm.CONFIRM_TAIL_MS / 1000} s for the repository and database writes`))
  assert.ok(ops.includes(`not started later than ${confirm.CONTROL_START_DEADLINE_MS / 1000} s into a request`))
  assert.ok(ops.includes(`over the newest ${confirm.NOISE_WINDOW} finished repeats`) && ops.includes(`(for a pair, 2 x ${confirm.PAIR_DISTANCE_TO_SD}`))
  assert.ok(ops.includes('The noise is the median of those spreads, each counted once for every score in its group, so every run counts once.'))
  assert.ok(ops.includes('leaves out the pair being judged') && ops.includes("not counting this run's own two scores"))
  assert.ok(ops.includes(`once the request that wrote it is certainly over (${confirm.REPEAT_START_LOST_AFTER_MS / 1000} s)`))
  assert.ok(ops.includes('it counts each open one at the full estimate'))
  assert.equal(ops.includes('No run is started twice.'), false)
  assert.ok(ops.includes('never more than `LAB_RESEARCH_MAX_MARGIN`') && ops.includes('`margin_basis: "ceiling"`'))
  assert.equal(ops.split('still unanswered three hours after it started').length, 3) // said of a confirmation and of a control
  assert.equal(confirm.REPEAT_LOST_AFTER_MS, 3 * 60 * 60 * 1000)
  assert.ok(ops.includes('If the cap is reached, or the spend ledger cannot be read, no repeat is started.'))
  assert.ok(ops.includes('it counts as still training and is asked about again at the next tick'))
  assert.ok(ops.includes('the next research epoch closes both kinds first, a control and a confirmation whose epoch ended without it'))
  assert.ok(ops.includes('is not counted under either origin'))
  assert.ok(ops.includes(`from the newest ${tinkerStore.ORIGIN_SUMMARY_RUNS} runs`))
  for (const heading of ['## How a research result is scored', '## Where the training data came from']) assert.ok(tools.includes(heading), heading)
  // The route exists and is counted.
  const routes = readdirSync(join(root, 'api'), { recursive: true }).filter(f => String(f).endsWith('.ts') && !String(f).startsWith('_lib'))
  assert.ok(ops.includes(`\`api/experiment/scoring.ts\` (the project now has ${routes.length};`))

  // The README section: near the run 2 sections, first person, the report by title and link, and what it does not prove.
  const start = readme.indexOf('### How the lab scores results')
  const end = readme.indexOf('## Run 2 so far')
  assert.ok(start > readme.indexOf('### The research loop') && end > start)
  const section = readme.slice(start, end)
  for (const text of [
    '[MAI-Thinking-1: Building a Hill-Climbing Machine](https://microsoft.ai/pdf/mai-thinking-1.pdf)',
    '**Self-reported and unverified.**', '**Measured by the lab.**', '`LAB_RESEARCH_CONFIRM`, off by default', '`LAB_TINKER_ORIGIN_LABELS`, off by default',
    `\`LAB_RESEARCH_MIN_MARGIN\`, ${confirm.DEFAULT_MIN_MARGIN_BPB} val_bpb by default`, `\`LAB_RESEARCH_MAX_MARGIN\`, ${confirm.DEFAULT_MAX_MARGIN_BPB} by default`,
    'uses the median of those spreads, with every run counted once', 'The run being judged is not part of the noise that judges it', 'compared at four decimal places', 'the epoch waits with its candidate and repeats it when the budget resets', 'noise not yet measured', 'A repeat checks luck, not honesty.',
    'a `train.py` that prints a false score would print it twice and pass', 'It is not built yet.', '"written by the models"', '"public dataset"',
  ]) assert.ok(section.includes(text), text)
  // The example line in the README is what the code writes for those numbers.
  const example = confirm.decideConfirmation({ first: 0.7058, repeat: 0.7064, repeatStatus: 'ok', best: 0.7067, noise: { noise_bpb: null, samples: 0, groups: 0 }, minMargin: 0.002 }).line
  assert.ok(section.includes(`"${example.split(' (margin:')[0]}"`))
  assert.equal(/[—–]/.test(section), false, 'no dashes in the README section')
  assert.equal(/\bwe\b|\bour\b/i.test(section.replace(/changing their baseline[^.]+\./, '')), false, 'the owner writes in the first person singular')
  for (const [name, text] of [['OPERATIONS.md', ops.slice(ops.indexOf('## Scoring research results'), ops.indexOf('## Model proposals to this repository'))], ['TOOLS.md', tools.slice(tools.indexOf('## How a research result is scored'), tools.indexOf('## Exhibits'))]]) {
    assert.ok(text.length > 500, name)
    assert.equal(/[—–]/.test(text), false, `no dashes in ${name}`)
  }

  // The About card has one sentence about it, said as something that is switched on.
  const overlay = readFileSync(join(root, 'src/systems/UIOverlay.ts'), 'utf8')
  const sentence = 'When the lab\'s repeat check is switched on, a research result only counts as the best after the lab runs it again and the average of the two printed scores beats the old best by more than the run-to-run spread the lab has measured. Both scores are printed by the models\' own code, so a repeat checks luck, not honesty.'
  assert.ok(overlay.includes(`and every result goes to the Research-Lab repository. ${sentence}\n`))
  assert.equal(/[—–]/.test(sentence), false)
  assert.equal(/chance|significan|verif/i.test(sentence), false)
  // What the models are told has no instruction in it: it states the rule and its limits.
  const note = confirm.scoringPromptNote([], 0.002)
  assert.ok(note.startsWith('\n\nHOW THE LAB SCORES A NEW BEST (a fact about the lab, not a goal;'))
  assert.equal(/\b(you should|you must|try to|aim|make sure|please)\b/i.test(note), false)
})
