// Phase 3 backend: the tool menu the Executor chooses from (subagents, a
// Sprite session, a GPU job, an exhibit, a lab proposal), the prompts that
// describe it, the exhibit contract and reader, tool_runs and the spend cap.
//
// No network, no database, no secrets: fetch answers like OpenRouter, GitHub,
// Sprites and the Modal job endpoints, and `@vercel/postgres` is an in-memory
// fake that understands the queries these paths make.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-tools-test-'))
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
  if (/^(OPENROUTER|POSTGRES|LAB_|AI_AGENT|RESEARCH_|SPRITES|MODAL|EPOCH_|NORTH_|GPU_JOBS)/.test(name)) delete process.env[name]
}
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder' // read once at import
const BASE_ENV = { ...process.env }

let logs = []
const capture = (...args) => logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = capture
console.log = capture
console.error = capture

const load = path => import(pathToFileURL(join(build, path)).href)
const { db } = await import(fakePgUrl)
const openrouter = await load('api/_lib/openrouter.js')
const runner = await load('api/_lib/epoch-runner.js')
const followups = await load('api/_lib/epoch-followup.js')
const prompts = await load('api/_lib/prompts.js')
const toolsConfig = await load('api/_lib/tools-config.js')
const requests = await load('api/_lib/tool-requests.js')
const exhibits = await load('api/_lib/exhibits.js')
const reader = await load('api/_lib/exhibits-reader.js')
const session = await load('api/_lib/sprite-session.js')
const gpu = await load('api/_lib/gpu-jobs.js')
const proposals = await load('api/_lib/lab-proposals.js')
const githubPr = await load('api/_lib/github-pr.js')
const contribution = await load('api/_lib/code-contribution.js')
const store = await load('api/_lib/tool-runs-store.js')
const { default: experimentHandler } = await load('api/experiment/index.js')

// ---------------------------------------------------------------------------
// In-memory database: just what the classic epoch and the tool paths query.
// ---------------------------------------------------------------------------
const JSON_COLUMNS = new Set(['current_spec', 'role_assignments', 'spec_before', 'spec_after', 'plant_geometry',
  'planner_output', 'executor_output', 'challenger_output', 'executor_rebuttal', 'reviewer_output', 'commentator_output', 'followup'])
let nextId = 1
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`

class FakeLab {
  constructor() {
    this.experiments = []
    this.epochs = []
    this.modelCalls = []
    this.toolRuns = []
    this.contributions = []
  }

  addExperiment(row = {}) {
    const exp = {
      id: uuid(), created_at: new Date(), status: 'growing', current_epoch: 3, epoch_in_progress: false,
      epoch_started_at: null, glass_shattered: false, current_spec: spec(), ...row,
    }
    this.experiments.push(exp)
    return exp
  }

  handle(text, v) {
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, created_at: new Date() })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) {
      const since = new Date(v[0])
      return { rows: [{ total: String(this.modelCalls.filter(c => c.created_at >= since).reduce((s, c) => s + c.cost_usd, 0)) }] }
    }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number = ?')) {
      const rows = this.modelCalls.filter(c => c.experiment_id === v[0] && c.epoch_number === v[1])
      const sum = k => rows.reduce((s, c) => s + (c[k] || 0), 0)
      return { rows: [{ cost_usd: sum('cost_usd'), prompt_tokens: sum('prompt_tokens'), completion_tokens: sum('completion_tokens') }] }
    }
    // tool_runs
    if (text.startsWith('INSERT INTO tool_runs')) {
      const [experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail] = v
      this.toolRuns.push({ id: uuid(), experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail: detail ? JSON.parse(detail) : null, created_at: new Date() })
      return { rows: [] }
    }
    if (text.startsWith('SELECT COUNT(*) AS n FROM tool_runs')) {
      const since = new Date(v[1])
      return { rows: [{ n: this.toolRuns.filter(r => r.tool === v[0] && r.created_at >= since && r.status !== 'skipped').length }] }
    }
    if (text.startsWith('SELECT DISTINCT tool FROM tool_runs')) {
      return { rows: [...new Set(this.toolRuns.filter(r => r.experiment_id === v[0] && r.epoch === v[1]).map(r => r.tool))].map(tool => ({ tool })) }
    }
    if (text.startsWith('SELECT id, epoch, model, tool, request_summary')) {
      return { rows: this.toolRuns.filter(r => r.experiment_id === v[0]).slice().reverse().slice(0, v[1]) }
    }
    // experiments and epochs
    if (text.startsWith('UPDATE experiments')) {
      if (text.includes('epoch_in_progress = TRUE') && text.includes('IS NOT TRUE')) {
        const exp = this.experiments.find(e => e.id === v[v.length - 1] || v.includes(e.id))
        if (exp && !exp.epoch_in_progress) { exp.epoch_in_progress = true; return { rows: [{ id: exp.id, current_epoch: exp.current_epoch }] } }
        return { rows: [] }
      }
      const exp = this.experiments.find(e => v.includes(e.id))
      if (exp && text.includes('current_spec = ?')) {
        exp.current_spec = JSON.parse(v[0]); exp.current_epoch = v[1]; exp.epoch_in_progress = false
      } else if (exp && text.includes('epoch_in_progress = FALSE')) exp.epoch_in_progress = false
      return { rows: [] }
    }
    if (text.startsWith('SELECT * FROM experiments WHERE id = ?')) return { rows: this.experiments.filter(e => e.id === v[0]) }
    if (text.startsWith("SELECT e.*, (SELECT json_agg")) {
      return { rows: this.experiments.filter(e => e.status !== 'archived').slice(-1).map(e => ({ ...e, recent_epochs: [] })) }
    }
    if (text.includes("followup->>'status' IN ('pending', 'awaiting_ci')")) {
      const rows = this.epochs.filter(e => e.experiment_id === v[0] && e.spec_after && ['pending', 'awaiting_ci'].includes(e.followup?.status))
        .sort((a, b) => a.epoch_number - b.epoch_number).slice(0, 1).map(e => ({ epoch_number: e.epoch_number }))
      return { rows }
    }
    if (text.startsWith('SELECT * FROM epochs WHERE experiment_id = ? AND epoch_number = ? LIMIT 1')) {
      return { rows: this.epochs.filter(e => e.experiment_id === v[0] && e.epoch_number === v[1]) }
    }
    if (text.startsWith('INSERT INTO epochs (experiment_id, epoch_number, role_assignments, spec_before) VALUES')) {
      const ep = { id: uuid(), experiment_id: v[0], epoch_number: v[1], role_assignments: JSON.parse(v[2]), spec_before: JSON.parse(v[3]), started_at: new Date() }
      this.epochs.push(ep)
      return { rows: [{ id: ep.id }] }
    }
    if (text.startsWith('UPDATE epochs SET')) {
      const m = text.match(/^UPDATE epochs SET (.*) WHERE id = \?$/)
      if (!m) return { rows: [] }
      const ep = this.epochs.find(e => e.id === v[v.length - 1])
      let i = 0
      for (const pair of m[1].split(', ')) {
        const [col, expr] = pair.split(' = ').map(x => x.trim())
        const value = expr === '?' ? v[i++] : expr === 'NOW()' ? new Date() : expr
        if (ep) ep[col] = JSON_COLUMNS.has(col) && typeof value === 'string' ? JSON.parse(value) : value
      }
      return { rows: [] }
    }
    if (text.startsWith('INSERT INTO code_contributions')) {
      this.contributions.push({ experiment_id: v[0], epoch_number: v[1], branch: v[4], explorer_task: v[9], web_searches: v[11] })
      return { rows: [] }
    }
    if (text.includes('FROM code_contributions') && text.includes('COUNT(*)')) return { rows: [{ merged: 0, tested: 0, sprite: 0 }] }
    return { rows: [] }
  }
}

let lab
beforeEach(() => {
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  logs = []
  process.env = { ...BASE_ENV }
  openrouter.resetModelCatalog()
  reader.resetExhibitsCache()
})

function spec() {
  return {
    identity: { purpose: 'test agent', domain: null }, capabilities: [], constraints: [], behaviors: [], conflicts: [],
    meta: { stability_score: 0.5, growth_stage: 'sprout', total_epochs: 3, total_mutations: 0, total_prunings: 0 },
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
// Configuration helpers
// ---------------------------------------------------------------------------
const AI_TOKEN = 'test-only-ai-agent-token-value-0000'
const LAB_TOKEN = 'test-only-lab-proposals-token-0000'
const SPRITES_TOKEN = 'test-org/test-id/test-only-sprites-secret'
const JOBS_TOKEN = 'test-only-gpu-jobs-token-00000000000000'

function enableEverything() {
  Object.assign(process.env, {
    LAB_ENABLE_CODE_WRITES: 'true',
    LAB_REQUIRED_CI_WORKFLOW_IDS: '101',
    AI_AGENT_GITHUB_TOKEN: AI_TOKEN,
    AI_AGENT_GITHUB_OWNER: 'test-owner',
    LAB_ENABLE_SPRITE_SESSIONS: 'true',
    SPRITES_TOKEN,
    LAB_ENABLE_GPU_JOBS: 'true',
    GPU_JOBS_START_URL: 'https://jobs.example/start',
    GPU_JOBS_STATUS_URL: 'https://jobs.example/status',
    GPU_JOBS_TOKEN: JOBS_TOKEN,
    LAB_ENABLE_EXHIBITS: 'true',
    LAB_ENABLE_LAB_PROPOSALS: 'true',
    LAB_PROPOSALS_GITHUB_TOKEN: LAB_TOKEN,
    LAB_PROPOSALS_GITHUB_OWNER: 'lab-owner',
  })
}

const JAR = {
  version: 1, title: 'Specimen jar', description: 'A glass jar with a brass lid and a leaf inside.', author_model: 'Observable Lab',
  placement: 'shelf', palette: ['#E8E4D9', '#B5A642', '#7CB342', '#8B7355'],
  parts: [
    { shape: 'cylinder', size: [0.16, 0.26, 0.16], position: [0, 0.13, 0], colour: 0, material: 'glass' },
    { shape: 'torus', size: [0.17, 0.17, 0.02], position: [0, 0.01, 0], rotation: [1.5708, 0, 0], colour: 1, material: 'brass' },
    { shape: 'box', size: [0.06, 0.01, 0.03], position: [0.03, 0.17, 0], colour: 2, material: 'leaf', repeat: { count: 3, radial: { radius: 0.02 } } },
    { shape: 'tube', size: [0.01, 0.01, 0.01], position: [0, 0, 0], colour: 3, material: 'wood', path: [[0, 0, 0], [0, 0.1, 0], [0.05, 0.2, 0]] },
  ],
  animation: { bob: 0.01 }, label: 'Specimen 001',
}

// ===========================================================================
// The menu and the prompts
// ===========================================================================
test('every tool is off by default, and a flag without its credentials stays off', () => {
  let config = toolsConfig.toolConfig()
  for (const name of toolsConfig.TOOL_NAMES) assert.equal(config[name].enabled, false, name)
  assert.deepEqual(toolsConfig.enabledTools(), [])

  process.env.LAB_ENABLE_SPRITE_SESSIONS = 'true'
  process.env.LAB_ENABLE_GPU_JOBS = 'true'
  process.env.LAB_ENABLE_EXHIBITS = 'true'
  process.env.LAB_ENABLE_LAB_PROPOSALS = 'true'
  config = toolsConfig.toolConfig()
  for (const name of toolsConfig.TOOL_NAMES) assert.equal(config[name].enabled, false, name)
  assert.match(config.sprite_session.off_reason, /SPRITES_TOKEN/)
  assert.match(config.gpu_job.off_reason, /GPU_JOBS_START_URL/)
  assert.match(config.exhibit.off_reason, /LAB_ENABLE_CODE_WRITES/)
  assert.match(config.lab_proposal.off_reason, /LAB_PROPOSALS_GITHUB_TOKEN/)

  enableEverything()
  assert.deepEqual(toolsConfig.enabledTools(), ['subagents', 'sprite_session', 'gpu_job', 'exhibit', 'lab_proposal'])
  process.env.LAB_GPU_JOBS_PER_DAY = '0'
  assert.equal(toolsConfig.enabledTools().includes('gpu_job'), false)
  process.env.LAB_GPU_JOBS_PER_DAY = 'lots'
  assert.equal(toolsConfig.toolConfig().gpu_job.per_day, 4)
})

test('the prompts describe exactly the tools that are on', () => {
  // Nothing on: no tool is promised.
  let ctx = prompts.getSharedContext(4, spec(), [])
  let exec = prompts.ROLE_PROMPTS.executor({ direction: 'x' })
  for (const words of [/Sprite/, /GPU/, /Exhibit/i, /model-proposal/, /drones/, /explorer subagents/]) assert.doesNotMatch(ctx, words)
  assert.doesNotMatch(exec, /"tools"/)
  assert.doesNotMatch(ctx, /writing the real, tested code/)

  // Code writes only: subagents become the Executor's choice, nothing else appears.
  process.env.LAB_ENABLE_CODE_WRITES = 'true'
  ctx = prompts.getSharedContext(4, spec(), [])
  exec = prompts.ROLE_PROMPTS.executor({ direction: 'x' })
  assert.match(ctx, /Subagents, chosen by the Executor: up to 2 explorer subagents/)
  assert.match(ctx, /published in the pull request description/)
  assert.match(ctx, /appear in the room as drones/)
  assert.match(ctx, /writing the real, tested code/)
  assert.match(exec, /"subagents": \{ "explore": 0-2, "test": true \| false \}/)
  for (const words of [/sprite_session/, /gpu_job/, /EXHIBIT FORMAT/, /lab_proposal/]) assert.doesNotMatch(exec, words)
  assert.doesNotMatch(ctx, /GPU jobs on Modal/)

  // Everything on.
  enableEverything()
  ctx = prompts.getSharedContext(4, spec(), [])
  exec = prompts.ROLE_PROMPTS.executor({ direction: 'x' })
  assert.match(ctx, /Your own Sprite: a persistent Linux computer/)
  assert.match(ctx, /shown as the screen above your desk/)
  assert.match(ctx, /GPU jobs on Modal: .* stopped after 120 s/)
  assert.match(ctx, /Exhibits for the room/)
  assert.match(ctx, /labelled model-proposal\. The lab never merges these/)
  assert.match(ctx, /counts against the lab's daily spending cap/)
  assert.match(exec, /"sprite_session": \{ "purpose"/)
  assert.match(exec, /"gpu_job": \{ "purpose"/)
  assert.match(exec, /EXHIBIT FORMAT \(version 1/)
  assert.match(exec, /At most 6000 triangles in all, counted per copy as: box 12, sphere 352/)
  assert.match(exec, /"lab_proposal": \{ "title"/)
  // No em dashes in the new visitor-facing tool text.
  assert.doesNotMatch(prompts.toolLines(), /—/)
})

test('the Executor\'s tool requests: unknown or disabled tools are ignored with a reason, junk never throws', () => {
  const off = toolsConfig.toolConfig()
  for (const junk of [undefined, null, 'tools please', 42, [], { subagents: 'many' }, { sprite_session: { commands: 'rm -rf /' } }, { exhibit: { slug: '../x' } }, { __proto__: { gpu_job: 1 } }]) {
    const plan = requests.planTools(junk, off)
    assert.deepEqual(plan.subagents, { explore: 1, test: true, chosen: false })
  }
  const disabled = requests.planTools({ gpu_job: { script: 'print(1)' }, rocket: { launch: true } }, off)
  assert.equal(disabled.gpu_job, undefined)
  assert.deepEqual(disabled.ignored.map(i => [i.tool, i.reason]).sort(), [['gpu_job', 'not enabled'], ['rocket', 'unknown tool']])

  enableEverything()
  const on = toolsConfig.toolConfig()
  const plan = requests.planTools({
    subagents: { explore: 9, test: false },
    sprite_session: { purpose: 'bench', commands: [{ run: 'node -v', timeout_s: 500 }, 'echo hi', { run: '' }, 'a', 'b', 'c'] },
    gpu_job: { script: 'x'.repeat(30000) },
    exhibit: { slug: 'Not A Slug', exhibit: {} },
    lab_proposal: { title: 'Tidy up', summary: 'too short', files: [] },
  }, on)
  assert.deepEqual(plan.subagents, { explore: 2, test: false, chosen: true })
  assert.deepEqual(plan.sprite_session.commands.map(c => [c.run, c.timeout_s]), [['node -v', 120], ['echo hi', 60], ['a', 60]])
  assert.equal(plan.gpu_job, undefined)
  assert.equal(plan.exhibit, undefined)
  assert.equal(plan.lab_proposal, undefined)
  const reasons = plan.ignored.map(i => `${i.tool}: ${i.reason}`).join('\n')
  assert.match(reasons, /subagents: explore capped at 2/)
  assert.match(reasons, /command 3: not a string/)
  assert.match(reasons, /more than 4 commands|used up/)
  assert.match(reasons, /gpu_job: script is longer than 20000/)
  assert.match(reasons, /exhibit: slug must be/)
  assert.match(reasons, /lab_proposal: summary missing/)
})

// ===========================================================================
// Exhibits
// ===========================================================================
test('the exhibit validator accepts the contract and rejects anything outside it', () => {
  assert.deepEqual(exhibits.validateExhibit(JAR), [])
  const bad = (patch, pattern) => {
    const errors = exhibits.validateExhibit({ ...structuredClone(JAR), ...patch })
    assert.ok(errors.some(e => pattern.test(e)), `${JSON.stringify(patch).slice(0, 80)} -> ${errors.join('; ')}`)
  }
  bad({ description: 'see https://example.org/x' }, /URLs or markup/)
  bad({ title: '<script>alert(1)</script>' }, /URLs or markup/)
  bad({ label: 'javascript:void(0)' }, /URLs or markup/)
  bad({ script: 'x' }, /unknown key "script"/)
  bad({ version: 2 }, /version must be 1/)
  bad({ placement: 'roof' }, /placement/)
  bad({ palette: ['red'] }, /palette\[0\]/)
  bad({ palette: Array(7).fill('#000000') }, /palette: 1 to 6/)
  bad({ title: 'x'.repeat(61) }, /title/)
  bad({ animation: { spin: 3 } }, /animation.spin/)
  bad({ parts: [] }, /parts: 1 to 64/)
  bad({ parts: Array(65).fill(JAR.parts[0]) }, /parts: 1 to 64/)
  bad({ parts: [{ ...JAR.parts[0], colour: 9 }] }, /colour/)
  bad({ parts: [{ ...JAR.parts[0], size: [3, 1, 1] }] }, /size/)
  bad({ parts: [{ ...JAR.parts[0], position: [0, 2, 0] }] }, /position/)
  bad({ parts: [{ ...JAR.parts[0], material: 'gold' }] }, /material/)
  bad({ parts: [{ ...JAR.parts[0], path: [[0, 0, 0], [1, 1, 1]] }] }, /only a tube has a path/)
  bad({ parts: [{ ...JAR.parts[3], path: [[0, 0, 0]] }] }, /a tube needs 2 to 16 points/)
  bad({ parts: [{ ...JAR.parts[0], repeat: { count: 25 } }] }, /repeat.count/)
  // 18 spheres x 352 = 6336 triangles
  bad({ parts: [{ ...JAR.parts[0], shape: 'sphere', repeat: { count: 18 } }] }, /estimated 6336 triangles, the limit is 6000/)
  assert.equal(exhibits.estimateTriangles({ parts: [{ shape: 'sphere', repeat: { count: 17 } }] }), 5984)
  assert.equal(exhibits.partTriangles({ shape: 'tube', path: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] }), 32)

  assert.equal(exhibits.isExhibitPath('exhibits/jar-01/exhibit.json'), true)
  for (const p of ['exhibits/jar/other.json', 'exhibits/../x/exhibit.json', 'exhibits/ab/exhibit.json', 'src/exhibits/jar/exhibit.json']) {
    assert.equal(exhibits.isExhibitPath(p), false, p)
  }
  // The lab fills in author_model; what the model wrote there is not trusted.
  const prepared = exhibits.prepareExhibit({ ...JAR, author_model: 'Someone Famous' }, 'GPT-6 Astra')
  assert.equal(prepared.ok, true)
  assert.equal(JSON.parse(prepared.json).author_model, 'GPT-6 Astra')
  assert.equal(exhibits.prepareExhibit({ ...JAR, onload: 'x' }, 'GPT-6 Astra').ok, false)
})

test('the room shows at most 8 exhibits, newest first, one per model per placement kind', () => {
  const make = (slug, model, placement, day) => ({ slug, commit_sha: 'a'.repeat(40), merged_at: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`, author_model: model, data: { ...JAR, placement, author_model: model } })
  const all = [
    make('old-shelf', 'Gemini 4', 'shelf', 1),
    make('new-shelf', 'Gemini 4', 'shelf', 20),
    make('gem-wall', 'Gemini 4', 'wall', 2),
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((m, i) => make(`m-${m}`, `Model ${m}`, 'floor', 3 + i)),
  ]
  const shown = exhibits.selectForRoom(all)
  assert.equal(shown.length, 8)
  assert.equal(shown[0].slug, 'new-shelf')
  assert.ok(!shown.some(e => e.slug === 'old-shelf'))
  assert.ok(!shown.some(e => e.slug === 'gem-wall')) // oldest, pushed out by the cap
})

function fakeGitHubReader({ files = {}, emptyRepo = false, authors = {}, calls }) {
  return async (url, options = {}) => {
    const u = new URL(String(url))
    calls.push({ url: u.href, headers: options.headers || {}, signal: options.signal })
    if (u.host !== 'api.github.com') throw new Error(`unexpected host ${u.host}`)
    const p = u.pathname
    if (p === '/repos/test-owner/AI-Agent') return new Response(JSON.stringify({ default_branch: 'main' }))
    if (p.startsWith('/repos/test-owner/AI-Agent/git/trees/')) {
      if (emptyRepo) return new Response('{"message":"Git Repository is empty."}', { status: 409 })
      return new Response(JSON.stringify({ tree: [
        { path: 'README.md', type: 'blob', sha: '1'.repeat(40) },
        { path: 'exhibits/README.md', type: 'blob', sha: '2'.repeat(40) },
        ...Object.keys(files).map((path, i) => ({ path, type: 'blob', sha: String(i + 3).repeat(40) })),
      ] }))
    }
    const blob = p.match(/\/git\/blobs\/(\d)\1+$/)
    if (blob) {
      const path = Object.keys(files)[Number(blob[1]) - 3]
      const text = typeof files[path] === 'string' ? files[path] : JSON.stringify(files[path])
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length }))
    }
    if (p === '/repos/test-owner/AI-Agent/commits') {
      const path = u.searchParams.get('path')
      const author = authors[path] || { name: 'DervinEvolve', email: '39844362+DervinEvolve@users.noreply.github.com' }
      return new Response(JSON.stringify([{ sha: 'd'.repeat(40), commit: { author: { ...author, date: '2026-11-10T00:00:00Z' }, committer: { date: '2026-11-10T00:00:00Z' } } }]))
    }
    if (/\/commits\/d+\/pulls$/.test(p)) return new Response(JSON.stringify([{ merged_at: '2026-11-11T12:00:00Z' }]))
    return new Response('{}', { status: 404 })
  }
}

test('merged exhibits are read from AI-Agent, validated again, credited from git, and cached', async () => {
  process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'
  const calls = []
  globalThis.fetch = fakeGitHubReader({
    calls,
    files: {
      'exhibits/specimen-jar/exhibit.json': JAR,
      'exhibits/clock-face/exhibit.json': { ...JAR, title: 'Clock', placement: 'wall', author_model: 'Claimed Name' },
      'exhibits/bad-one/exhibit.json': { ...JAR, description: 'visit https://evil.example' },
      'exhibits/not-json/exhibit.json': '{ nope',
    },
    authors: { 'exhibits/clock-face/exhibit.json': { name: 'Grok 4.7', email: 'grok-4-7@observable-lab.invalid' } },
  })
  const res = response()
  await experimentHandler({ method: 'GET', headers: {}, query: { view: 'exhibits' } }, res)
  assert.equal(res.code, 200)
  const slugs = res.body.exhibits.map(e => e.slug).sort()
  assert.deepEqual(slugs, ['clock-face', 'specimen-jar'])
  const clock = res.body.exhibits.find(e => e.slug === 'clock-face')
  assert.equal(clock.author_model, 'Grok 4.7') // from the commit, not the file
  assert.equal(clock.data.author_model, 'Grok 4.7')
  assert.equal(clock.commit_sha, 'd'.repeat(40))
  assert.equal(clock.merged_at, '2026-11-11T12:00:00.000Z')
  assert.equal(res.body.exhibits.find(e => e.slug === 'specimen-jar').author_model, 'Observable Lab')
  assert.ok(logs.some(l => /bad-one.*does not meet the contract/.test(l)))
  // No token configured: anonymous reads, all with timeouts.
  for (const c of calls) {
    assert.equal(c.headers.Authorization, undefined)
    assert.ok(c.signal instanceof AbortSignal)
  }
  // Cached for about ten minutes.
  const before = calls.length
  await experimentHandler({ method: 'GET', headers: {}, query: { view: 'exhibits' } }, response())
  assert.equal(calls.length, before)
})

test('a missing exhibits folder, an empty repository or an outage gives an empty list', async () => {
  process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'
  globalThis.fetch = fakeGitHubReader({ calls: [], files: {} })
  assert.deepEqual(await reader.getRoomExhibits(), [])
  reader.resetExhibitsCache()
  globalThis.fetch = fakeGitHubReader({ calls: [], emptyRepo: true })
  assert.deepEqual(await reader.getRoomExhibits(), [])
  reader.resetExhibitsCache()
  globalThis.fetch = async () => { throw new Error('network down') }
  assert.deepEqual(await reader.getRoomExhibits(), [])
  reader.resetExhibitsCache()
  delete process.env.AI_AGENT_GITHUB_OWNER
  assert.deepEqual(await reader.getRoomExhibits(), [])
})

// ===========================================================================
// Sprites and Modal
// ===========================================================================
function fakeSprites(calls, answer = () => 'ok') {
  return async (url, options = {}) => {
    const u = new URL(String(url))
    const method = options.method || 'GET'
    calls.push({ url: u.href, host: u.host, path: u.pathname, method, query: u.searchParams, headers: options.headers || {}, signal: options.signal })
    if (u.host !== 'api.sprites.dev') return null
    if (method === 'GET') return new Response(JSON.stringify({ status: 'warm' }), { headers: { 'content-type': 'application/json' } })
    if (u.pathname.endsWith('/policy/network')) return new Response(options.body)
    if (u.pathname.endsWith('/exec')) {
      const cmd = u.searchParams.getAll('cmd')
      const nonce = /__EXIT_([0-9a-f]+):/.exec(cmd[2] || '')?.[1]
      const { out, code = 0 } = typeof answer(cmd[5]) === 'string' ? { out: answer(cmd[5]) } : answer(cmd[5])
      return new Response(`${out}\n__EXIT_${nonce}:${code}\n`)
    }
    return new Response('unexpected', { status: 500 })
  }
}

test('a Sprite session runs each command under its limit, with the egress policy first and nothing secret sent', async () => {
  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  process.env.SOME_SERVICE_API_KEY = 'test-only-server-credential-value'
  const calls = []
  globalThis.fetch = fakeSprites(calls, script => script.includes('node -v')
    ? 'v22.11.0\nTOKEN=test-only-server-credential-value'
    : { out: 'boom', code: 2 })
  const result = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'node -v', timeout_s: 30 }, { run: 'false', timeout_s: 10 }])
  assert.equal(result.status, 'failed')
  assert.equal(result.sprite_name, 'observable-gpt')
  assert.deepEqual(result.commands.map(c => c.exit_code), [0, 2])
  assert.match(result.commands[0].output_tail, /v22\.11\.0/)
  assert.doesNotMatch(JSON.stringify(result), /test-only-server-credential-value/)
  const order = calls.map(c => `${c.method} ${c.path.split('/').pop()}`)
  assert.ok(order.indexOf('POST network') < order.indexOf('POST exec'))
  const execs = calls.filter(c => c.path.endsWith('/exec'))
  assert.deepEqual(execs.map(c => c.query.getAll('cmd')[4]), ['30', '10'])
  for (const c of execs) {
    assert.match(c.query.getAll('cmd')[5], /cd \/home\/sprite\/lab-session/)
    for (const pair of c.query.getAll('env')) assert.doesNotMatch(pair, /TOKEN|SECRET|KEY/)
  }
  for (const c of calls) assert.equal(c.headers.Authorization, `Bearer ${SPRITES_TOKEN}`)
  assert.equal(result.cost_usd, session.estimateSpriteCost(result.duration_ms))
  assert.equal(session.estimateSpriteCost(3_600_000), 1.3) // an hour at the placeholder rate

  // A command carrying one of the server's credentials is never sent.
  calls.length = 0
  const refused = await session.runSpriteSession('openai/gpt-6-astra', [{ run: 'echo test-only-server-credential-value', timeout_s: 10 }])
  assert.equal(refused.status, 'error')
  assert.match(refused.error, /Refusing to send a server credential/)
  assert.equal(calls.filter(c => c.path.endsWith('/exec')).length, 0)
})

function fakeJobs(calls, { result, startStatus = 200, statuses = ['running', 'done'] } = {}) {
  let polls = 0
  return async (url, options = {}) => {
    const u = new URL(String(url))
    calls.push({ url: u.href, method: options.method || 'GET', headers: options.headers || {}, body: options.body, signal: options.signal })
    if (u.host !== 'jobs.example') return null
    if (u.pathname === '/start') return startStatus === 200 ? new Response(JSON.stringify({ call_id: 'fc-test-1' })) : new Response('no', { status: startStatus })
    const s = statuses[Math.min(polls++, statuses.length - 1)]
    if (s === 'done') return new Response(JSON.stringify({ status: 'done', result }))
    return new Response(JSON.stringify({ status: s }))
  }
}

test('a GPU job is spawned and polled with the token in the header only, and costed from its measured time', async () => {
  Object.assign(process.env, { GPU_JOBS_START_URL: 'https://jobs.example/start', GPU_JOBS_STATUS_URL: 'https://jobs.example/status', GPU_JOBS_TOKEN: JOBS_TOKEN })
  const calls = []
  globalThis.fetch = fakeJobs(calls, { result: { status: 'ok', exit_code: 0, log_tail: 'cuda: True', wall_seconds: 50, run_seconds: 30, gpu: 'A10G', stage: 'run' } })
  const r = await gpu.runGpuJob('import torch\nprint(torch.cuda.is_available())\n', { pollMs: 1 })
  assert.equal(r.status, 'ok')
  assert.equal(r.log_tail, 'cuda: True')
  assert.ok(Math.abs(r.cost_usd - 50 * 0.000306) < 1e-12)
  for (const c of calls) {
    assert.equal(c.headers.Authorization, `Bearer ${JOBS_TOKEN}`)
    assert.doesNotMatch(c.url, new RegExp(JOBS_TOKEN))
    if (c.body) assert.doesNotMatch(c.body, new RegExp(JOBS_TOKEN))
    assert.ok(c.signal instanceof AbortSignal)
  }
  assert.equal(calls.filter(c => c.url.includes('/status')).length, 2)

  // A syntax failure never started a GPU: almost nothing charged.
  globalThis.fetch = fakeJobs([], { result: { status: 'crash', stage: 'syntax', wall_seconds: 0.2 } })
  assert.ok((await gpu.runGpuJob('def(:', { pollMs: 1 })).cost_usd < 0.0001)
  // Not started: nothing charged. Started but lost: the worst case is charged.
  globalThis.fetch = fakeJobs([], { startStatus: 502 })
  assert.equal((await gpu.runGpuJob('print(1)', { pollMs: 1 })).cost_usd, 0)
  globalThis.fetch = fakeJobs([], { statuses: ['running'] })
  const lost = await gpu.runGpuJob('print(1)', { pollMs: 1, maxWaitMs: 20 })
  assert.equal(lost.status, 'failed')
  assert.ok(Math.abs(lost.cost_usd - gpu.GPU_JOB_WORST_CASE_S * 0.000306) < 1e-12)
  // The rate can be set from the current price list.
  process.env.LAB_MODAL_GPU_USD_PER_SECOND = '0.001'
  assert.equal(gpu.estimateGpuCost(10), 0.01)
})

// ===========================================================================
// Lab proposals and pull request text
// ===========================================================================
test('lab proposals only touch source, docs, tests and Modal code, and the client cannot merge', async () => {
  for (const ok of ['src/systems/Thing.ts', 'docs/proposals/idea.md', 'api/_lib/new-tool.ts', 'tests/x.test.mjs', 'modal/note.py']) assert.equal(proposals.isProposalPath(ok), true, ok)
  for (const bad of ['.github/workflows/ci.yml', 'package.json', 'vercel.json', 'src/.env', '.env.example', 'api/_lib/schema.sql',
    'tsconfig.json', 'src/../vercel.json', 'README.md', 'api/secrets.ts', 'requirements-runner.txt', 'modal/requirements.txt', 'public/x.js']) {
    assert.equal(proposals.isProposalPath(bad), false, bad)
  }
  Object.assign(process.env, { LAB_PROPOSALS_GITHUB_TOKEN: LAB_TOKEN, LAB_PROPOSALS_GITHUB_OWNER: 'lab-owner' })
  const repo = proposals.proposalsRepo()
  assert.equal(repo.allowMerge, false)
  assert.equal(repo.repo, 'Observable-Lab')
  globalThis.fetch = async () => { throw new Error('no request may be made') }
  await assert.rejects(githubPr.mergePr(repo, 1, 'x', 'a'.repeat(40)), /never merged by the lab/)
  assert.throws(() => githubPr.assertBranch(repo, 'main'), /branch shapes/)
  assert.throws(() => githubPr.assertBranch(repo, 'model-proposal/epoch-1-../main'), /Refusing branch name/)

  assert.equal(githubPr.quietMentions('thanks @octocat and @org/team, mail a@b.c'), 'thanks `@octocat` and `@org/team`, mail a@b.c')
  const body = contribution.contributionPrBody({
    summary: 'Adds a planner.', author: 'Grok 4.7', testSubagent: true,
    explorers: [{ task: 'Researching task planners', searches: ['HTN planning in agents', 'ReAct loop'], findings: 'Use a bounded loop.\nAsk @someone.', sources: [{ url: 'https://example.org/htn', title: 'HTN' }], model: 'x-ai/grok-4.7', cost: 0 }],
  })
  assert.match(body, /\*\*Task:\*\* Researching task planners/)
  assert.match(body, /- HTN planning in agents\n- ReAct loop/)
  assert.match(body, /> Use a bounded loop\.\n> Ask `@someone`\./)
  assert.match(body, /HTN: https:\/\/example\.org\/htn/)
  assert.match(body, /A test subagent added its own commit/)
})

// ===========================================================================
// A classic epoch with every tool on
// ===========================================================================
const CATALOG = { data: ['anthropic/claude-fable-5.2', 'openai/gpt-6-astra', 'google/gemini-4-hydrogen', 'deepseek/deepseek-v4-pro-0813', 'x-ai/grok-4.7', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash']
  .map(id => ({ id, supported_parameters: ['max_tokens', 'response_format'], top_provider: { max_completion_tokens: 64000 }, pricing: { prompt: '0.000001', completion: '0.000002' } })) }

const say = (model, content, cost) => new Response(JSON.stringify({ model, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost } }))

function epochModels(tools, { verdicts = { exhibit: 'approve', lab_proposal: 'approve' }, systems } = {}) {
  return body => {
    const sys = body.messages[0].content
    systems?.push(sys)
    if (sys.includes('You are the PLANNER')) return say(body.model, { direction: 'planning', rationale: 'r', priority: 3, suggested_focus: 'capabilities' }, 0.02)
    if (sys.includes('You are the EXECUTOR again')) return say(body.model, { responses: [] }, 0.005)
    if (sys.includes('You are the EXECUTOR this epoch')) {
      return say(body.model, {
        mutations: [{ type: 'add', target: 'capabilities', path: 'capabilities[new]', value: { id: 'cap_plan_4', description: 'plans tasks' }, rationale: 'needed' }],
        projected_stability_impact: 0.1, implementation_notes: '', tools,
      }, 0.04)
    }
    if (sys.includes('You are the CHALLENGER')) return say(body.model, { challenges: [], conflicts_with_existing: [], overall_risk: 'low', recommendation: 'proceed' }, 0.015)
    if (sys.includes('You are the REVIEWER')) {
      return say(body.model, { decisions: [{ mutation_index: 0, verdict: 'approve', reason: 'good' }], new_conflicts_detected: [], conflicts_resolved: [], updated_stability_score: 0.6, epoch_summary: 's', tool_verdicts: verdicts }, 0.03)
    }
    if (sys.includes('You are the COMMENTATOR')) return say(body.model, { summary: 's', highlight: 'h', plant_metaphor: 'p', mood: 'growing' }, 0.01)
    if (sys.includes('explore and research BEFORE')) {
      const angle = sys.includes('what can go wrong') ? 'risks' : 'approach'
      return say(body.model, { task: `Researching ${angle}`, search_queries: [`${angle} query`], findings: `Findings about ${angle}.` }, 0.007)
    }
    if (sys.includes('You are a software engineer')) return say(body.model, { files: [{ path: 'src/planner.ts', content: 'export const plan = () => []\n' }], commit_message: 'feat: planner', pr_summary: 'Adds a planner.' }, 0.06)
    if (sys.includes('You are a subagent')) return say(body.model, { files: [{ path: 'tests/planner.test.ts', content: 'test("p", () => {})\n' }], commit_message: 'test: planner' }, 0.008)
    throw new Error(`unexpected prompt: ${sys.slice(0, 80)}`)
  }
}

function fakeWorld({ models, calls }) {
  const sprites = fakeSprites(calls, () => 'ran fine')
  const jobs = fakeJobs(calls, { statuses: ['done'], result: { status: 'ok', exit_code: 0, log_tail: 'tensor ok', wall_seconds: 40, run_seconds: 30, gpu: 'A10G', stage: 'run' } })
  let prNumber = 0
  return async (url, options = {}) => {
    const target = String(url)
    const u = new URL(target)
    const method = options.method || 'GET'
    const body = options.body && typeof options.body === 'string' ? (() => { try { return JSON.parse(options.body) } catch { return options.body } })() : undefined
    if (u.host === 'api.sprites.dev') return sprites(url, options)
    if (u.host === 'jobs.example') return jobs(url, options)
    calls.push({ url: target, method, body, headers: options.headers || {}, signal: options.signal })
    if (target === 'https://openrouter.ai/api/v1/models') return new Response(JSON.stringify(CATALOG))
    if (target === 'https://openrouter.ai/api/v1/chat/completions') return models(body)
    if (u.host !== 'api.github.com') throw new Error(`Unexpected request ${method} ${target}`)
    const p = u.pathname
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(p)) return new Response(JSON.stringify({ default_branch: 'main' }))
    if (method === 'GET' && p.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'b'.repeat(40) } }))
    if (method === 'GET' && p.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'c'.repeat(40) } }))
    if (method === 'GET' && p.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }))
    if (method === 'GET' && p.includes('/contents/')) return new Response('{}', { status: 404 })
    if (method === 'GET' && p.endsWith('/actions/runs')) {
      return new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 9, workflow_id: 101, head_sha: u.searchParams.get('head_sha'), head_repository: { full_name: 'test-owner/AI-Agent' }, event: 'pull_request', status: 'completed', conclusion: 'success' }] }))
    }
    if (method === 'POST' && p.endsWith('/pulls')) { prNumber++; return new Response(JSON.stringify({ number: prNumber, html_url: `https://github.example${p}/${prNumber}` })) }
    if (method === 'GET' && /\/pulls\/\d+$/.test(p)) return new Response(JSON.stringify({ mergeable: true }))
    return new Response('{}')
  }
}

test('an epoch with every tool on: each runs once, is recorded, costed against the cap, and credited to the model', async () => {
  enableEverything()
  const exp = lab.addExperiment()
  const calls = []
  const systems = []
  const tools = {
    subagents: { explore: 2, test: true },
    sprite_session: { purpose: 'check node', commands: [{ run: 'node -v', timeout_s: 20 }] },
    gpu_job: { purpose: 'tensor check', script: 'import torch\nprint(torch.ones(2).sum())\n' },
    exhibit: { slug: 'planner-orrery', exhibit: { ...JAR, title: 'Planner orrery', author_model: 'Definitely Not The Model' } },
    lab_proposal: { title: 'Show tool runs on the desk', summary: 'A short note for the owner about showing tool runs on each desk screen.', files: [{ path: 'docs/proposals/desk-tool-runs.md', content: '# Desk tool runs\n' }] },
    rocket: { launch: true },
  }
  globalThis.fetch = fakeWorld({ models: epochModels(tools, { systems }), calls })
  const result = await runner.runEpoch(exp.id)
  assert.equal(result.success, true)
  const executor = result.newSpec && lab.epochs[0].role_assignments.executor

  // The epoch itself opens nothing: the contribution, exhibit and proposal are
  // queued on its row and run in their own request (epoch-followup.ts).
  assert.equal(calls.some(c => c.method === 'POST' && c.url.endsWith('/pulls')), false)
  assert.equal(lab.epochs[0].followup.status, 'pending')
  assert.equal(lab.epochs[0].followup.contribution_mutation_index, 0)
  assert.equal(lab.epochs[0].followup.deliverables, true)
  // Stage 1 writes the code and opens the PR; stage 2 (a later tick) reads CI,
  // merges, and runs the approved exhibit and proposal.
  const stage1 = await followups.runEpochFollowUp(exp.id)
  assert.equal(stage1.ran, true)
  assert.equal(lab.epochs[0].followup.status, 'awaiting_ci')
  assert.equal(lab.epochs[0].followup.pending.branch, 'epoch-4-capabilities-0')
  assert.equal(calls.some(c => /\/pulls\/\d+\/merge$/.test(c.url)), false) // nothing merged yet
  const followUp = await followups.runEpochFollowUp(exp.id)
  assert.equal(followUp.ran, true)
  assert.equal(lab.epochs[0].followup.status, 'done')
  assert.equal(lab.epochs[0].followup.result.merged, true)
  assert.equal(lab.epochs[0].followup.pending, undefined)
  assert.equal(exp.epoch_in_progress, false)
  const executorName = (await load('api/_lib/types.js')).modelDisplayName(executor)

  // Every tool use is a row, refusals included.
  const byTool = Object.groupBy(lab.toolRuns, r => r.tool)
  assert.equal(byTool.rocket[0].status, 'skipped')
  assert.match(byTool.rocket[0].output_tail, /unknown tool/)
  assert.equal(byTool.sprite_session.length, 1)
  assert.equal(byTool.sprite_session[0].status, 'ok')
  assert.match(byTool.sprite_session[0].output_tail, /\$ node -v\nran fine/)
  assert.equal(byTool.gpu_job[0].status, 'ok')
  assert.match(byTool.gpu_job[0].output_tail, /tensor ok/)
  assert.equal(byTool.subagent_explore.length, 2)
  assert.equal(byTool.subagent_test.length, 1)
  assert.equal(byTool.exhibit[0].status, 'merged')
  assert.equal(byTool.lab_proposal[0].status, 'opened')
  for (const r of lab.toolRuns) assert.equal(r.experiment_id, exp.id)

  // Tool time is on the spend ledger, so the daily cap counts it, and the epoch cost includes it.
  const toolCosts = lab.modelCalls.filter(c => c.model_id.startsWith('tool/'))
  assert.deepEqual(toolCosts.map(c => [c.model_id, c.cost_source]).sort(), [['tool/gpu_job', 'estimate'], ['tool/sprite_session', 'estimate']])
  assert.ok(Math.abs(toolCosts.find(c => c.model_id === 'tool/gpu_job').cost_usd - 40 * 0.000306) < 1e-12)
  const epoch = lab.epochs[0]
  const ledger = lab.modelCalls.filter(c => c.epoch_number === 4).reduce((s, c) => s + c.cost_usd, 0)
  assert.ok(Math.abs(epoch.cost_usd - ledger) < 1e-9)

  // The contribution's PR description carries both explorers' tasks, searches and findings.
  const prs = calls.filter(c => c.method === 'POST' && c.url.endsWith('/pulls'))
  const codePr = prs.find(c => c.body.head === 'epoch-4-capabilities-0')
  assert.match(codePr.body.body, /Researching approach/)
  assert.match(codePr.body.body, /Researching risks/)
  assert.match(codePr.body.body, /- risks query/)
  assert.match(codePr.body.body, /> Findings about approach\./)

  // The exhibit: its own branch and file, author_model filled by the lab, the model as git author.
  const exhibitPr = prs.find(c => c.body.head === 'exhibit/epoch-4-planner-orrery')
  assert.ok(exhibitPr)
  assert.ok(exhibitPr.url.includes('/repos/test-owner/AI-Agent/'))
  const put = calls.find(c => c.method === 'PUT' && c.url.endsWith('/contents/exhibits/planner-orrery/exhibit.json'))
  const written = JSON.parse(Buffer.from(put.body.content, 'base64').toString('utf8'))
  assert.equal(written.author_model, executorName)
  assert.equal(put.body.branch, 'exhibit/epoch-4-planner-orrery')
  assert.match(put.body.author.email, /@observable-lab\.invalid$/)
  assert.equal(put.body.committer.name, 'DervinEvolve')
  assert.match(put.body.message, /Model: .*\nModel-Role: exhibit/)
  assert.ok(calls.some(c => c.method === 'PUT' && /\/repos\/test-owner\/AI-Agent\/pulls\/\d+\/merge$/.test(c.url) && c.body.sha === 'c'.repeat(40)))

  // The lab proposal: the lab repo, its own token, labelled, and never merged.
  const labCalls = calls.filter(c => c.url.includes('/repos/lab-owner/Observable-Lab'))
  assert.ok(labCalls.length > 0)
  for (const c of labCalls) assert.equal(c.headers.Authorization, `Bearer ${LAB_TOKEN}`)
  for (const c of calls.filter(c => c.url.includes('/repos/test-owner/'))) assert.equal(c.headers.Authorization, `Bearer ${AI_TOKEN}`)
  assert.equal(labCalls.some(c => /\/merge$/.test(c.url)), false)
  const label = labCalls.find(c => /\/issues\/\d+\/labels$/.test(c.url))
  assert.deepEqual(label.body, { labels: ['model-proposal'] })
  assert.ok(labCalls.some(c => c.method === 'POST' && c.url.endsWith('/pulls') && c.body.head === 'model-proposal/epoch-4-show-tool-runs-on-the-desk'))

  // The Reviewer was asked to rule; the Commentator was told what really ran.
  const reviewerPrompt = systems.find(s => s.includes('You are the REVIEWER'))
  assert.match(reviewerPrompt, /"planner-orrery".*it meets the version 1 contract/)
  assert.match(reviewerPrompt, /"tool_verdicts"/)
  const commentatorPrompt = systems.find(s => s.includes('You are the COMMENTATOR'))
  assert.match(commentatorPrompt, /Tools used, from the lab's records/)
  assert.match(commentatorPrompt, /ran 1 command\(s\) in its Sprite \(exit codes 0\)/)
  assert.match(commentatorPrompt, /goes to AI-Agent as a pull request/)
  assert.match(commentatorPrompt, /exhibit or lab proposal the Reviewer approved is opened after this epoch/)

  // Every outbound request had a timeout.
  for (const c of calls) assert.ok(c.signal instanceof AbortSignal, `${c.method} ${c.url}`)

  // The public state shows the recent runs, cleaned, and what is switched on.
  lab.toolRuns.push({ id: 'x', experiment_id: exp.id, epoch: 4, model: executor, tool: 'sprite_session', request_summary: 'leak', status: 'ok', exit_code: 0, duration_ms: 5, cost_usd: '0.001', output_tail: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', detail: null, created_at: new Date() })
  const res = response()
  await experimentHandler({ method: 'GET', headers: {}, query: {} }, res)
  assert.equal(res.code, 200)
  assert.ok(res.body.tool_runs.length >= 6)
  assert.doesNotMatch(JSON.stringify(res.body.tool_runs), /ghp_abcdefghijklmnopqrstuvwxyz0123456789/)
  assert.deepEqual(res.body.tools_enabled, ['subagents', 'sprite_session', 'gpu_job', 'exhibit', 'lab_proposal'])
})

test('without the Reviewer\'s approval no exhibit or proposal is opened; a resumed epoch runs no tool twice', async () => {
  enableEverything()
  const exp = lab.addExperiment()
  const calls = []
  const tools = {
    sprite_session: { commands: ['echo once'] },
    exhibit: { slug: 'quiet-jar', exhibit: JAR },
    lab_proposal: { title: 'A proposal', summary: 'Something the owner should read about.', files: [{ path: 'docs/p.md', content: 'x' }] },
  }
  globalThis.fetch = fakeWorld({ models: epochModels(tools, { verdicts: { exhibit: 'maybe' } }), calls })
  await runner.runEpoch(exp.id)
  await followups.runEpochFollowUp(exp.id)
  await followups.runEpochFollowUp(exp.id)
  const skipped = lab.toolRuns.filter(r => r.status === 'skipped').map(r => [r.tool, r.output_tail])
  assert.deepEqual(skipped.sort(), [['exhibit', 'the Reviewer did not approve it'], ['lab_proposal', 'the Reviewer did not approve it']])
  assert.equal(calls.some(c => c.url.includes('exhibit/') || c.url.includes('lab-owner')), false)

  // Resume the same epoch from its stored outputs: the session is not run again.
  const sessions = () => lab.toolRuns.filter(r => r.tool === 'sprite_session').length
  assert.equal(sessions(), 1)
  const epoch = lab.epochs[0]
  delete epoch.completed_at
  delete epoch.commentator_output
  exp.current_epoch = 3
  exp.epoch_in_progress = false
  await runner.runEpoch(exp.id)
  assert.equal(sessions(), 1)
})

test('disabled tools are never called, and limits and the daily cap stop the ones that are on', async () => {
  process.env.LAB_ENABLE_CODE_WRITES = 'true'
  Object.assign(process.env, { LAB_REQUIRED_CI_WORKFLOW_IDS: '101', AI_AGENT_GITHUB_TOKEN: AI_TOKEN, AI_AGENT_GITHUB_OWNER: 'test-owner' })
  let exp = lab.addExperiment()
  let calls = []
  globalThis.fetch = fakeWorld({ models: epochModels({ gpu_job: { script: 'print(1)' }, sprite_session: { commands: ['ls'] } }), calls })
  await runner.runEpoch(exp.id)
  assert.equal(calls.some(c => c.url.includes('jobs.example') || c.host === 'api.sprites.dev'), false)
  assert.deepEqual(lab.toolRuns.filter(r => r.status === 'skipped').map(r => [r.tool, r.output_tail]).sort(),
    [['gpu_job', 'not enabled'], ['sprite_session', 'not enabled']])

  // Daily limit reached: refused before anything starts.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  enableEverything()
  process.env.LAB_GPU_JOBS_PER_DAY = '1'
  lab.toolRuns.push({ experiment_id: 'other', epoch: 1, model: 'm', tool: 'gpu_job', status: 'ok', created_at: new Date() })
  exp = lab.addExperiment()
  calls = []
  globalThis.fetch = fakeWorld({ models: epochModels({ gpu_job: { script: 'print(1)' } }), calls })
  await runner.runEpoch(exp.id)
  assert.equal(calls.some(c => c.url.includes('jobs.example')), false)
  assert.match(lab.toolRuns.find(r => r.experiment_id === exp.id && r.tool === 'gpu_job').output_tail, /daily limit of 1 reached/)

  // The cap: a job whose worst case would pass today's budget does not start.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  enableEverything()
  process.env.LAB_DAILY_BUDGET_USD = '0.2'
  exp = lab.addExperiment()
  calls = []
  globalThis.fetch = fakeWorld({ models: epochModels({ gpu_job: { script: 'print(1)' } }), calls })
  lab.modelCalls.push({ model_id: 'earlier', cost_usd: 0.1, created_at: new Date() })
  await runner.runEpoch(exp.id)
  assert.equal(calls.some(c => c.url.includes('jobs.example')), false)
  assert.match(lab.toolRuns.find(r => r.tool === 'gpu_job').output_tail, /would pass today's budget|daily budget reached/)
})

test('the tool_runs table is created at runtime with the documented columns', async () => {
  const seen = []
  db.handler = text => { seen.push(text); return { rows: [] } }
  // A fresh copy of the module, so the table is created again here.
  const fresh = await import(pathToFileURL(join(build, 'api/_lib/tool-runs-store.js')).href + '?fresh')
  await fresh.recordToolRun({ experimentId: 'e', epoch: 1, model: 'm', tool: 'gpu_job', requestSummary: 's', status: 'ok' })
  const create = seen.find(t => t.startsWith('CREATE TABLE IF NOT EXISTS tool_runs'))
  for (const col of ['experiment_id', 'epoch', 'model', 'tool', 'request_summary', 'status', 'exit_code', 'duration_ms', 'cost_usd', 'output_tail', 'created_at']) {
    assert.match(create, new RegExp(`\\b${col}\\b`))
  }
  // A store failure never throws into the epoch.
  db.handler = () => { throw new Error('db down') }
  await store.recordToolRun({ experimentId: 'e', epoch: 1, model: 'm', tool: 'gpu_job', requestSummary: 's', status: 'ok' })
})

test('docs/EXHIBITS.md and docs/TOOLS.md state the same numbers as the code', () => {
  const ex = readFileSync(join(root, 'docs/EXHIBITS.md'), 'utf8')
  for (const [shape, tris] of Object.entries(exhibits.FIXED_TRIANGLES)) assert.match(ex, new RegExp(`\\| ${shape}[^|]*\\| ${tris} \\|`))
  assert.match(ex, /6,000/)
  const tools = readFileSync(join(root, 'docs/TOOLS.md'), 'utf8')
  for (const flag of ['LAB_ENABLE_SPRITE_SESSIONS', 'LAB_ENABLE_GPU_JOBS', 'LAB_ENABLE_EXHIBITS', 'LAB_ENABLE_LAB_PROPOSALS', 'LAB_PROPOSALS_GITHUB_TOKEN', 'LAB_MODAL_GPU_USD_PER_SECOND']) {
    assert.ok(tools.includes(flag), flag)
  }
  assert.match(tools, /0\.000306/)
  for (const doc of [ex, tools]) assert.doesNotMatch(doc, /—/)
})

// ---------------------------------------------------------------------------
// The Socratic lesson and visitor offers switched off (TUTOR-SPEC section 4):
// the prompts and the public state are exactly what they were before either
// existed. "Before" is the server code of the commit that came before them,
// read from git and run here beside the current code, on the same fakes.
// ---------------------------------------------------------------------------
const BEFORE = '24c797f7ac05f470164b2ee0e9bbcafcba1fc9ca'
function compileBefore() {
  let files
  try {
    files = execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', BEFORE, 'api'], { encoding: 'utf8' }).split('\n').filter(f => f.endsWith('.ts'))
  } catch {
    return null
  }
  const out = join(build, 'before')
  for (const path of files) {
    const source = execFileSync('git', ['-C', root, 'show', `${BEFORE}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
      .outputText.replaceAll(`from '@vercel/postgres'`, `from '${fakePgUrl}'`)
    const destination = join(out, path.replace(/\.ts$/, '.js'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, output)
  }
  return out
}
const beforeDir = compileBefore()

test('with the lesson and visitor offers switched off, the prompts and the public state are exactly what they were before them', { skip: beforeDir ? false : 'git history is not available' }, async () => {
  const old = {
    prompts: await import(pathToFileURL(join(beforeDir, 'api/_lib/prompts.js')).href),
    experiment: (await import(pathToFileURL(join(beforeDir, 'api/experiment/index.js')).href)).default,
  }
  const OFF = { LAB_ENABLE_TINKER_TUTOR: 'false', LAB_ENABLE_VISITOR_OFFERS: 'false' }
  const TINKER = {
    LAB_ENABLE_TINKER: 'true', TINKER_JOBS_START_URL: 'https://tinker.example/start', TINKER_JOBS_STATUS_URL: 'https://tinker.example/status',
    TINKER_JOBS_TOKEN: JOBS_TOKEN, TINKER_API_KEY: 'test-only-tinker-key-00000000000000000', LAB_ENABLE_TRAINED_CHAT: 'true',
    CRON_SECRET: 'test-only-cron-secret-0000000000000000000000', LAB_ENABLE_TINKER_NAMES: 'true',
  }
  const settings = [{ ...OFF }, { ...OFF, everything: true }, { ...OFF, everything: true, ...TINKER }]
  const reviewerSection = p => p.reviewerToolSection({ tinker_train: { line: 'a run' }, tinker_rl: { line: 'an RL run' }, keep_adapter: { line: 'a keep' } })
  globalThis.fetch = async url => { throw new Error(`Unexpected outbound request to ${url}`) }
  for (const setting of settings) {
    process.env = { ...BASE_ENV }
    const { everything, ...env } = setting
    if (everything) enableEverything()
    Object.assign(process.env, env)
    const said = p => ({
      context: p.getSharedContext(4, spec(), []),
      executor: p.ROLE_PROMPTS.executor({ direction: 'x' }),
      reviewer: p.ROLE_PROMPTS.reviewer({ mutations: [] }, { challenges: [] }, undefined, reviewerSection(p)),
      lines: p.toolLines(),
      section: p.executorToolsSection(),
    })
    const now = said(prompts)
    const then = said(old.prompts)
    for (const key of Object.keys(then)) assert.equal(now[key], then[key], `${key} changed with ${JSON.stringify(setting)}`)
    assert.ok(then.context.length > 1000)

    // The public state, from the same stored rows.
    lab = new FakeLab()
    db.handler = (text, values) => lab.handle(text, values)
    lab.addExperiment()
    const a = response()
    await experimentHandler({ method: 'GET', headers: {}, query: {} }, a)
    const b = response()
    await old.experiment({ method: 'GET', headers: {}, query: {} }, b)
    assert.equal(a.code, 200)
    assert.equal(JSON.stringify(a.body), JSON.stringify(b.body), `the public state changed with ${JSON.stringify(setting)}`)
    assert.equal('tutor_lesson' in a.body || 'visitor_offers' in a.body, false)
  }

  // Switched on (the default), the same state gains the two parts and nothing else changes.
  process.env = { ...BASE_ENV }
  enableEverything()
  Object.assign(process.env, TINKER)
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  lab.addExperiment()
  const on = response()
  await experimentHandler({ method: 'GET', headers: {}, query: {} }, on)
  const off = response()
  await old.experiment({ method: 'GET', headers: {}, query: {} }, off)
  const { tutor_lesson: lesson, visitor_offers: offers, tools_enabled: toolsNow, ...rest } = on.body
  const { tools_enabled: toolsThen, ...restThen } = off.body
  assert.deepEqual(lesson, { enabled: true, lesson: null })
  assert.deepEqual(offers, { enabled: true, stored: 0, offered_today: 0, trained_on: 0, taken_back: 0, read_by_owner: 0 })
  assert.deepEqual(toolsNow, [...toolsThen.filter(t => t !== 'live_model' && t !== 'live_trained'), 'tinker_tutor', ...toolsThen.filter(t => t === 'live_model' || t === 'live_trained')])
  assert.equal(JSON.stringify(rest), JSON.stringify(restThen))
})

test('switched on, the models are told of the lesson and the Reviewer is asked to rule on it', () => {
  enableEverything()
  Object.assign(process.env, {
    TINKER_JOBS_START_URL: 'https://tinker.example/start', TINKER_JOBS_STATUS_URL: 'https://tinker.example/status', TINKER_JOBS_TOKEN: JOBS_TOKEN,
    TINKER_API_KEY: 'test-only-tinker-key-00000000000000000',
  })
  const ctx = prompts.getSharedContext(4, spec(), [])
  const exec = prompts.ROLE_PROMPTS.executor({ direction: 'x' })
  assert.match(ctx, /- Socratic lesson: as Executor you may ask for one lesson/)
  assert.match(exec, /"tinker_tutor": \{ "purpose"/)
  assert.match(exec, /A Socratic lesson takes exactly the fields shown/)
  // No training tool is on here, so the note about visitor conversations is not there either.
  assert.doesNotMatch(ctx, /Visitor conversations:/)
  const section = prompts.reviewerToolSection({ tinker_tutor: { line: 'a lesson. The lab counts which answers pass.' } })
  assert.match(section, /- A Socratic lesson: a lesson\. The lab counts which answers pass\.\n/)
  assert.match(section, /Nothing is opened or started without "approve"\./)
})
