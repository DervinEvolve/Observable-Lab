// Public weights for GPU jobs (docs/TOOLS.md, "Public weights"): what a model
// may ask for, what the lab sends to its fetcher on Modal, how the answers are
// read, how GPU job results are labelled, and that nothing changes while
// LAB_ENABLE_WEIGHTS is off.
//
// No network, no database, no secrets: fetch answers like the Modal endpoints
// and `@vercel/postgres` is an in-memory fake. The rules the fetcher applies
// (license, gating, file kinds, custom code, size, the shelf) are tested where
// they live, in tests/test_weights.py.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-weights-test-'))
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
const weights = await load('api/_lib/weights.js')
const toolsConfig = await load('api/_lib/tools-config.js')
const requests = await load('api/_lib/tool-requests.js')
const prompts = await load('api/_lib/prompts.js')
const gpu = await load('api/_lib/gpu-jobs.js')
const epochTools = await load('api/_lib/epoch-tools.js')

const MODAL_SOURCE = readFileSync(join(root, 'modal/gpu_jobs.py'), 'utf8')
const JOBS_TOKEN = 'test-only-gpu-jobs-token-00000000000000'
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const EXECUTOR = 'anthropic/claude-fable-5.2'

// ---------------------------------------------------------------------------
// In-memory database: the spend ledger and tool_runs, which is all these paths use.
// ---------------------------------------------------------------------------
class FakeLab {
  constructor() {
    this.modelCalls = []
    this.toolRuns = []
  }

  handle(text, v) {
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }
    if (text.startsWith('INSERT INTO model_calls')) {
      this.modelCalls.push({ model_id: v[3], assigned_model_id: v[4], cost_usd: v[5], cost_source: v[6], created_at: new Date() })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) {
      const since = new Date(v[0])
      return { rows: [{ total: String(this.modelCalls.filter(c => c.created_at >= since).reduce((s, c) => s + c.cost_usd, 0)) }] }
    }
    if (text.startsWith('INSERT INTO tool_runs')) {
      const [experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail] = v
      this.toolRuns.push({ experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail: detail ? JSON.parse(detail) : null, created_at: new Date() })
      return { rows: [] }
    }
    if (text.startsWith('SELECT COUNT(*) AS n FROM tool_runs')) {
      const since = new Date(v[1])
      return { rows: [{ n: this.toolRuns.filter(r => r.tool === v[0] && r.created_at >= since && r.status !== 'skipped').length }] }
    }
    if (text.startsWith('SELECT DISTINCT tool FROM tool_runs')) {
      return { rows: [...new Set(this.toolRuns.filter(r => r.experiment_id === v[0] && r.epoch === v[1]).map(r => r.tool))].map(tool => ({ tool })) }
    }
    return { rows: [] }
  }

  run(tool) {
    return this.toolRuns.find(r => r.tool === tool)
  }
}

let lab
beforeEach(() => {
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  logs = []
  process.env = { ...BASE_ENV }
})

function gpuJobsOn() {
  Object.assign(process.env, {
    LAB_ENABLE_GPU_JOBS: 'true',
    GPU_JOBS_START_URL: 'https://jobs.example/start',
    GPU_JOBS_STATUS_URL: 'https://jobs.example/status',
    GPU_JOBS_TOKEN: JOBS_TOKEN,
  })
}
function weightsOn() {
  gpuJobsOn()
  process.env.LAB_ENABLE_WEIGHTS = 'true'
}

/**
 * The Modal app's two endpoints. `fetchResult` answers a fetch_weights call,
 * `jobResult` a job; either may be a function of the request body. Every
 * request is recorded in `calls` with its parsed body.
 */
function fakeModal(calls, { fetchResult, jobResult, startStatus = 200, pending = [] } = {}) {
  const results = new Map()
  let n = 0
  return async (url, options = {}) => {
    const u = new URL(String(url))
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url: u.href, path: u.pathname, method: options.method || 'GET', headers: options.headers || {}, raw: options.body, body, signal: options.signal })
    assert.equal(u.host, 'jobs.example')
    if (u.pathname === '/start') {
      if (startStatus !== 200) return new Response('no', { status: startStatus })
      const kind = body.fetch_weights ? 'fetch' : 'job'
      const id = `fc-${kind}-${++n}`
      const answer = kind === 'fetch' ? fetchResult : jobResult
      results.set(id, { kind, result: typeof answer === 'function' ? answer(body) : answer })
      return new Response(JSON.stringify({ call_id: id }))
    }
    const call = results.get(u.searchParams.get('call_id'))
    if (pending.includes(call.kind)) return new Response(JSON.stringify({ status: 'running' }))
    return new Response(JSON.stringify({ status: 'done', result: call.result }))
  }
}

const FETCH_OK = { status: 'ok', cached: false, repo: 'acme/tiny-model', sha: SHA, license: 'apache-2.0', size_bytes: 1_500_000_000, files: 4, evicted: [], wall_seconds: 20 }
const jobOk = body => ({
  status: 'ok', stage: 'run', exit_code: 0, log_tail: 'val_loss 0.41', run_seconds: 30, wall_seconds: 40, gpu: 'A10G',
  weights: body.weights ? { repo: body.weights.repo, sha: body.weights.sha ?? OTHER_SHA, license: 'apache-2.0' } : null,
})
const ctx = () => ({ experimentId: 'exp-1', epochNumber: 7, executorModelId: EXECUTOR, assignedExecutorId: EXECUTOR, reviewerModelId: 'openai/gpt-6-astra' })
const plan = tools => requests.planTools(tools, toolsConfig.toolConfig())
const sideTools = tools => epochTools.runSideTools(ctx(), plan(tools), new Set())

// ===========================================================================
// What a model may write
// ===========================================================================
test('a repository id is org/name and nothing else', () => {
  for (const repo of ['acme/tiny-model', 'google/bert_uncased_L-2_H-128_A-2', 'a/b', 'Qwen/Qwen2.5-0.5B', 'x1/y_2.z']) {
    assert.equal(weights.isValidRepoId(repo), true, repo)
  }
  for (const repo of ['gpt2', 'a/b/c', '../x', 'a/..', 'a/b..c', 'a//b', '/a/b', 'a/b/', 'a/b.git', 'a--b/c', ' a/b', 'a/b\n',
    'a/b?x=1', 'a/b#c', 'a/b@main', '-a/b', 'a/b-', 'a/_b', '.a/b', 'a/b c', 'a\\b', 'https://huggingface.co/a/b',
    `a/${'b'.repeat(97)}`, '', null, undefined, 7, ['a/b'], { repo: 'a/b' }, 'a/b\u0000', 'ä/b', 'a/%2e%2e']) {
    assert.equal(weights.isValidRepoId(repo), false, JSON.stringify(repo))
  }
  for (const revision of ['main', 'v1.0', 'release-2', SHA, '1']) assert.equal(weights.isValidRevision(revision), true, revision)
  for (const revision of ['refs/pr/1', '..', 'a..b', '', 'x y', '-x', 'x-', 'main\n', 'a'.repeat(65), null, 3, 'main?download=true']) {
    assert.equal(weights.isValidRevision(revision), false, JSON.stringify(revision))
  }

  // The same patterns on both sides: the lab server and the Modal file.
  const pattern = name => MODAL_SOURCE.match(new RegExp(`^${name} = r"(.*)"$`, 'm'))[1]
  const tsSource = readFileSync(join(root, 'api/_lib/weights.ts'), 'utf8')
  const part = tsSource.match(/const REPO_PART = '(.*)'/)[1]
  assert.equal(pattern('REPO_ID_PATTERN'), `${part}/${part}`)
  assert.ok(tsSource.includes(`const REVISION = /^${pattern('REVISION_PATTERN')}$/`))
  assert.ok(tsSource.includes(`const SHA = /^${pattern('SHA_PATTERN')}$/`))
  const configSource = readFileSync(join(root, 'api/_lib/tools-config.ts'), 'utf8')
  assert.ok(configSource.includes(`const LICENSE_ID = /^${pattern('LICENSE_PATTERN')}$/`))
})

test('a weights request and the weights a job names are read strictly', () => {
  assert.deepEqual(weights.normalizeWeightsRequest({ repo: 'acme/tiny-model' }), { request: { repo: 'acme/tiny-model', revision: 'main' } })
  assert.deepEqual(weights.normalizeWeightsRequest({ repo: 'acme/tiny-model', revision: 'v2', token: 'hf_x', url: 'https://evil.example' }),
    { request: { repo: 'acme/tiny-model', revision: 'v2' } })
  assert.deepEqual(weights.normalizeWeightsRequest({ repo: 'acme/tiny-model', revision: SHA }).request.revision, SHA)
  for (const junk of [null, undefined, 'acme/tiny-model', ['acme/tiny-model'], {}, { repo: 'gpt2' }, { repo: '../../etc/passwd' },
    { repo: 'https://huggingface.co/acme/tiny-model' }, { repo: 'acme/tiny-model', revision: 'refs/pr/1' }, { repo: 'acme/tiny-model', revision: 4 }]) {
    assert.ok('error' in weights.normalizeWeightsRequest(junk), JSON.stringify(junk))
  }

  assert.deepEqual(weights.normalizeWeightsRef('acme/tiny-model'), { ref: { repo: 'acme/tiny-model' } })
  assert.deepEqual(weights.normalizeWeightsRef(`acme/tiny-model@${SHA}`), { ref: { repo: 'acme/tiny-model', sha: SHA } })
  for (const junk of ['gpt2', 'acme/tiny-model@main', `acme/tiny-model@${SHA}@x`, '@' + SHA, { repo: 'acme/tiny-model' }, 5, '', '/weights/acme/tiny-model']) {
    assert.ok('error' in weights.normalizeWeightsRef(junk), JSON.stringify(junk))
  }
})

test('the weights field on a job is optional: left out, null, false or empty all mean a job with no weights', () => {
  weightsOn()
  for (const none of [undefined, null, false, '', '   ', '\n']) {
    const planned = plan({ gpu_job: { purpose: 'tiny MLP', script: 'print(1)', weights: none } })
    assert.deepEqual(planned.gpu_job, { purpose: 'tiny MLP', script: 'print(1)' }, JSON.stringify(none))
    assert.deepEqual(planned.ignored, [], JSON.stringify(none))
  }
  // Anything else that is not an id still drops the job: it was written for weights it cannot have.
  for (const bad of ['none', 'gpt2', 0, true, {}, []]) {
    const planned = plan({ gpu_job: { purpose: 'tiny MLP', script: 'print(1)', weights: bad } })
    assert.equal(planned.gpu_job, undefined, JSON.stringify(bad))
    assert.equal(planned.ignored[0].tool, 'gpu_job')
  }
})

// ===========================================================================
// The flag
// ===========================================================================
test('public weights are off by default, and need GPU jobs as well as their own flag', () => {
  assert.ok(toolsConfig.TOOL_NAMES.includes('weights'))
  assert.equal(toolsConfig.toolConfig().weights.enabled, false)
  assert.match(toolsConfig.toolConfig().weights.off_reason, /LAB_ENABLE_WEIGHTS is not true/)

  process.env.LAB_ENABLE_WEIGHTS = 'true'
  assert.equal(toolsConfig.toolConfig().weights.enabled, false)
  assert.match(toolsConfig.toolConfig().weights.off_reason, /GPU jobs are off/)

  gpuJobsOn()
  process.env.LAB_ENABLE_WEIGHTS = 'yes' // only the exact word "true" switches it on
  assert.equal(toolsConfig.toolConfig().weights.enabled, false)
  assert.deepEqual(toolsConfig.enabledTools(), ['gpu_job'])

  process.env.LAB_ENABLE_WEIGHTS = 'true'
  assert.equal(toolsConfig.toolConfig().weights.enabled, true)
  assert.equal(toolsConfig.toolConfig().weights.per_day, 2)
  assert.deepEqual(toolsConfig.enabledTools(), ['gpu_job', 'weights'])
  process.env.LAB_WEIGHTS_PER_DAY = '0'
  assert.deepEqual(toolsConfig.enabledTools(), ['gpu_job'])
  process.env.LAB_WEIGHTS_PER_DAY = '500'
  assert.equal(toolsConfig.toolConfig().weights.per_day, 20)
  assert.equal(toolsConfig.PER_EPOCH.weights, 1)
})

test('with the flag off nothing changes: no prompt text, no request read, the same job request, no label', async () => {
  gpuJobsOn()
  const context = prompts.toolLines()
  const executor = prompts.executorToolsSection()
  for (const text of [context, executor]) {
    assert.doesNotMatch(text, /weights|Hugging Face|safetensors|from scratch|fine-tuned/i)
  }
  // The GPU job's own lines are the ones the models had before this tool existed.
  assert.ok(context.includes('- GPU jobs on Modal: as Executor you may send one short Python script (Python 3.11 with torch 2.6 and numpy) to run on an A10G GPU. It has no network and no credentials, it is compiled first (a syntax error never starts the GPU), and it is stopped after 120 s. Its output is stored and shown to visitors.'))
  assert.ok(executor.includes('    "gpu_job": { "purpose": "one line", "script": "Python source, at most 20000 characters" }\n'))
  assert.ok(executor.includes('\nThe GPU script runs as job.py with no network and no files from the lab. Print what you want to see; the last part of the output is kept.'))

  // A request for weights is an unavailable tool; a "weights" field on a job is left alone, as any extra field was.
  const planned = plan({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'not even an id' } })
  assert.equal(planned.weights, undefined)
  assert.deepEqual(planned.gpu_job, { purpose: 'probe', script: 'print(1)' })
  assert.deepEqual(planned.ignored, [{ tool: 'weights', reason: 'not enabled' }])

  const calls = []
  globalThis.fetch = fakeModal(calls, { jobResult: jobOk })
  const out = await epochTools.runSideTools(ctx(), planned, new Set())
  const starts = calls.filter(c => c.path === '/start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].raw, JSON.stringify({ script: 'print(1)' })) // byte for byte what was sent before
  const row = lab.run('gpu_job')
  assert.equal(row.request_summary, 'probe')
  assert.deepEqual(Object.keys(row.detail).sort(), ['gpu', 'run_seconds', 'script_chars', 'stage'])
  assert.equal(lab.run('weights'), undefined)
  assert.deepEqual(lab.modelCalls.map(c => c.model_id), ['tool/gpu_job'])
  assert.equal(out.length, 1)
  assert.match(out[0].summary, /'s GPU job: ok at stage run, exit 0$/)
})

// ===========================================================================
// The prompts
// ===========================================================================
test('when it is on the models are told what it does and its limits, and nothing about what to do with it', () => {
  weightsOn()
  const context = prompts.toolLines()
  const line = context.split('\n').find(l => l.startsWith('- Public weights for GPU jobs'))
  assert.ok(line)
  for (const limit of [/public and not gated/, /no Hugging Face account/, /apache-2\.0, mit, bsd-3-clause, bsd-2-clause, cc-by-4\.0/, /safetensors weights/,
    /no \.py file and no auto_map/, /at most 3 GB/, /Only safetensors, JSON, text and tokenizer files are kept/, /read-only, at \/weights/,
    /network stays off/, /stopped after 120 s/, /shelf holds 30 GB/, /least recently used/,
    /labelled "fine-tuned from <repo>@<commit>" or "from scratch"/, /still self-reported/, /not your script/]) {
    assert.match(line, limit)
  }
  const executor = prompts.executorToolsSection()
  assert.match(executor, /"weights": \{ "repo": "org\/name on Hugging Face", "revision": "a branch, tag or commit \(optional\)" \}/)
  assert.match(executor, /"gpu_job": \{ "purpose": "one line", "script": "Python source, at most 20000 characters", "weights": "org\/name of fetched weights \(optional\)" \}/)
  assert.match(executor, /fetched before the GPU job that names them starts/)
  assert.match(executor, /share one wait: if the fetch leaves too little of it, the job is not started and the weights stay on the shelf/)
  // The job's own line no longer says "no files from the lab" flatly: a job that names weights has some.
  assert.match(executor, /runs as job\.py with no network and no files from the lab other than the weights it names \(next paragraph\)\. Print/)
  assert.doesNotMatch(executor, /no files from the lab\./)
  assert.match(executor, /LAB_WEIGHTS_DIR/)
  assert.match(executor, /a job that names none has no \/weights/)
  assert.match(executor, /the job is not started and the reason is stored/)

  // Abilities with limits, never goals: no suggestion of what to fetch or build, and no model or task named.
  const said = `${line}\n${executor.split('\n').filter(l => /weights/i.test(l)).join('\n')}`
  assert.doesNotMatch(said, /\b(should|try|consider|recommend|encourage|ideal|great|useful for|for example|e\.g\.|such as|fine-tune a|distil|benchmark|improve|better|state of the art)\b/i)
  assert.doesNotMatch(said, /\b(bert|gpt2|llama|qwen|mistral|phi|gemma|resnet|whisper)\b/i)
  assert.doesNotMatch(said, /—/)

  // The numbers in the prompt are the owner's settings.
  Object.assign(process.env, { LAB_WEIGHTS_LICENSES: 'mit, Apache-2.0', LAB_WEIGHTS_MAX_GB: '1.5', LAB_WEIGHTS_SHELF_GB: '12' })
  const narrowed = prompts.toolLines()
  assert.match(narrowed, /every license it states is one of apache-2\.0, mit,/)
  assert.match(narrowed, /at most 1\.5 GB/)
  assert.match(narrowed, /shelf holds 12 GB/)
})

test('the limits come from the environment, with the documented defaults and ceilings', () => {
  assert.deepEqual(weights.weightsLimits(), { licenses: ['apache-2.0', 'mit', 'bsd-3-clause', 'bsd-2-clause', 'cc-by-4.0'], max_gb: 3, shelf_gb: 30 })
  Object.assign(process.env, { LAB_WEIGHTS_LICENSES: ' MIT , not a license!, mit,cc0-1.0 ', LAB_WEIGHTS_MAX_GB: '0.5', LAB_WEIGHTS_SHELF_GB: '10' })
  assert.deepEqual(weights.weightsLimits(), { licenses: ['cc0-1.0', 'mit'], max_gb: 0.5, shelf_gb: 10 })
  // A list that is set is never widened to the defaults, however badly it is written.
  Object.assign(process.env, { LAB_WEIGHTS_LICENSES: '!!!, ,', LAB_WEIGHTS_MAX_GB: '-3', LAB_WEIGHTS_SHELF_GB: 'lots' })
  assert.deepEqual(weights.weightsLimits(), { licenses: [], max_gb: 3, shelf_gb: 30 })
  process.env.LAB_WEIGHTS_LICENSES = '   '
  assert.deepEqual(weights.weightsLimits().licenses, ['apache-2.0', 'mit', 'bsd-3-clause', 'bsd-2-clause', 'cc-by-4.0'])
  Object.assign(process.env, { LAB_WEIGHTS_MAX_GB: '9999', LAB_WEIGHTS_SHELF_GB: '99999' })
  assert.deepEqual([weights.weightsLimits().max_gb, weights.weightsLimits().shelf_gb], [20, 500])
  Object.assign(process.env, { LAB_WEIGHTS_MAX_GB: '8', LAB_WEIGHTS_SHELF_GB: '2' })
  assert.equal(weights.weightsLimits().shelf_gb, 8) // the shelf always holds at least one fetch

  // The Modal file has the same defaults, ceilings and time limit.
  const constant = name => MODAL_SOURCE.match(new RegExp(`^${name} = (.*)$`, 'm'))[1]
  assert.equal(constant('DEFAULT_LICENSES'), `(${weights.DEFAULT_WEIGHTS_LICENSES.map(l => `"${l}"`).join(', ')})`)
  assert.equal(Number(constant('DEFAULT_MAX_GB')), weights.DEFAULT_WEIGHTS_MAX_GB)
  assert.equal(Number(constant('DEFAULT_SHELF_GB')), weights.DEFAULT_WEIGHTS_SHELF_GB)
  assert.equal(Number(constant('HARD_MAX_GB')), weights.WEIGHTS_HARD_MAX_GB)
  assert.equal(Number(constant('HARD_SHELF_GB')), weights.WEIGHTS_HARD_SHELF_GB)
  assert.equal(Number(constant('FETCH_TIMEOUT_S')), weights.WEIGHTS_FETCH_MAX_S)
  assert.equal(weights.weightsWaitMs(), 180_000)
  process.env.LAB_WEIGHTS_POLL_MAX_MS = '9999999'
  assert.equal(weights.weightsWaitMs(), 300_000)
})

// ===========================================================================
// The call to the fetcher
// ===========================================================================
test('a fetch is asked for with the token in the header only, the owner\'s limits in the body, and costed from its time', async () => {
  weightsOn()
  process.env.LAB_WEIGHTS_LICENSES = 'mit,apache-2.0'
  const calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK })
  const r = await gpu.runWeightsFetch({ repo: 'acme/tiny-model', revision: 'main' }, { pollMs: 1 })
  assert.equal(r.status, 'ok')
  assert.deepEqual([r.repo, r.sha, r.cached, r.license, r.size_bytes, r.files], ['acme/tiny-model', SHA, false, 'apache-2.0', 1_500_000_000, 4])
  assert.ok(Math.abs(r.cost_usd - 20 * 0.000306) < 1e-12)
  assert.deepEqual(calls[0].body, { fetch_weights: { repo: 'acme/tiny-model', revision: 'main', limits: { licenses: ['apache-2.0', 'mit'], max_gb: 3, shelf_gb: 30 } } })
  assert.equal(calls.length, 2)
  for (const c of calls) {
    assert.equal(c.headers.Authorization, `Bearer ${JOBS_TOKEN}`)
    assert.doesNotMatch(c.url, new RegExp(JOBS_TOKEN))
    if (c.raw) assert.doesNotMatch(c.raw, new RegExp(JOBS_TOKEN))
    assert.ok(c.signal instanceof AbortSignal)
  }
  // No Hugging Face token exists on the lab side at all.
  for (const file of ['api/_lib/weights.ts', 'api/_lib/gpu-jobs.ts']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN/)
  }

  // Not started: nothing charged. Still fetching when the wait ends: "pending", charged at the worst case.
  globalThis.fetch = fakeModal([], { startStatus: 502 })
  const notStarted = await gpu.runWeightsFetch({ repo: 'acme/tiny-model', revision: 'main' }, { pollMs: 1 })
  assert.deepEqual([notStarted.status, notStarted.cost_usd], ['failed', 0])
  globalThis.fetch = fakeModal([], { fetchResult: FETCH_OK, pending: ['fetch'] })
  const slow = await gpu.runWeightsFetch({ repo: 'acme/tiny-model', revision: 'main' }, { pollMs: 1, maxWaitMs: 20 })
  assert.equal(slow.status, 'pending')
  assert.match(slow.error, /it carries on, and asking again later finds it on the shelf/)
  assert.ok(Math.abs(slow.cost_usd - weights.WEIGHTS_FETCH_WORST_CASE_S * 0.000306) < 1e-12)
  assert.equal(weights.WEIGHTS_FETCH_WORST_CASE_S, 960)
})

test('every refusal comes back as a refusal with its rule, and an answer that does not add up is not an ok', () => {
  const asked = { repo: 'acme/tiny-model', revision: 'main' }
  const refusals = {
    gated: 'the repository is gated (its terms need an account), and the lab uses no Hugging Face token',
    license: 'license cc-by-nc-4.0 is not on the lab\'s list (apache-2.0, mit)',
    format: 'the repository has no safetensors weights; pickle formats (.bin, .pt, .pkl) are never downloaded',
    custom_code: 'the repository contains Python code (modeling_x.py); the lab never loads a repository\'s own code',
    size: 'its files total 7.20 GB, over the limit of 3 GB',
    not_public: 'the hub shows no public repository or revision by that name',
    shelf: 'it does not fit on the lab\'s shelf',
  }
  for (const [rule, reason] of Object.entries(refusals)) {
    const r = weights.normalizeFetchResult({ status: 'refused', rule, reason, wall_seconds: 0.6 }, asked)
    assert.deepEqual([r.status, r.rule, r.reason, r.sha], ['refused', rule, reason, null], rule)
    assert.ok(r.cost_usd < 0.001)
    assert.equal(weights.describeFetch(r), `refused (${rule}): ${reason}`)
  }
  const error = weights.normalizeFetchResult({ status: 'error', stage: 'download', error: 'model.safetensors: sha256 does not match the hub\'s', wall_seconds: 12 }, asked)
  assert.equal(error.status, 'error')
  assert.match(weights.describeFetch(error), /^error: model\.safetensors: sha256 does not match/)

  // "ok" must name the repository that was asked for and a full commit sha.
  for (const bad of [{ ...FETCH_OK, repo: 'acme/other' }, { ...FETCH_OK, sha: 'main' }, { ...FETCH_OK, sha: undefined }, { status: 'done' }, null, 'ok', []]) {
    const r = weights.normalizeFetchResult(bad, asked)
    assert.deepEqual([r.status, r.sha], ['failed', null], JSON.stringify(bad))
  }
  const hit = weights.normalizeFetchResult({ ...FETCH_OK, cached: true, wall_seconds: 1, evicted: ['acme/old@' + OTHER_SHA, 5] }, asked)
  assert.equal(weights.describeFetch(hit), `acme/tiny-model@${SHA}: already on the shelf, nothing downloaded; license apache-2.0; removed from the shelf to make room: acme/old@${OTHER_SHA}`)
  assert.equal(weights.describeFetch(weights.normalizeFetchResult(FETCH_OK, asked)), `acme/tiny-model@${SHA}: fetched 4 files, 1.50 GB; license apache-2.0`)
  // Time that never came back is charged at the worst case.
  assert.ok(Math.abs(weights.normalizeFetchResult({ status: 'refused', rule: 'gated', reason: 'x' }, asked).cost_usd - 960 * 0.000306) < 1e-12)
})

// ===========================================================================
// Labels
// ===========================================================================
test('the label is built from what the sandbox had mounted', () => {
  assert.equal(weights.weightsLabel(null), 'from scratch')
  assert.equal(weights.weightsLabel({ repo: 'acme/tiny-model', sha: SHA, license: 'mit' }), `fine-tuned from acme/tiny-model@${SHA}`)
  assert.equal(weights.weightsLabel({ repo: 'acme/tiny-model', sha: SHA, license: 'mit' }, true), 'fine-tuned from acme/tiny-model@aaaaaaaaaaaa')
  assert.deepEqual(weights.normalizeMounted({ repo: 'acme/tiny-model', sha: SHA, license: 'mit', extra: 1 }), { repo: 'acme/tiny-model', sha: SHA, license: 'mit' })
  for (const junk of [null, undefined, 'acme/tiny-model', { repo: 'acme/tiny-model' }, { repo: '../x', sha: SHA }, { repo: 'acme/tiny-model', sha: 'main' }, []]) {
    assert.equal(weights.normalizeMounted(junk), null, JSON.stringify(junk))
  }
  // A job result with a mounted entry the lab cannot read as one counts as nothing mounted.
  assert.equal(gpu.normalizeJobResult({ status: 'ok', weights: { repo: 'x', sha: 'y' } }).weights, null)
  assert.deepEqual(gpu.normalizeJobResult({ status: 'ok', weights: { repo: 'acme/tiny-model', sha: SHA, license: 'mit' } }).weights, { repo: 'acme/tiny-model', sha: SHA, license: 'mit' })
})

test('weights asked for in an epoch are fetched first, and the job that names them is labelled fine-tuned from that commit', async () => {
  weightsOn()
  const calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk })
  const out = await sideTools({
    weights: { repo: 'acme/tiny-model' },
    gpu_job: { purpose: 'probe the last layer', script: 'import torch\nprint(1)\n', weights: 'acme/tiny-model' },
  })

  // The fetch finished before the job was started, and the job got exactly the commit that was checked.
  const order = calls.map(c => (c.path === '/start' ? (c.body.fetch_weights ? 'start fetch' : 'start job') : `status ${new URL(c.url).searchParams.get('call_id')}`))
  assert.deepEqual(order, ['start fetch', 'status fc-fetch-1', 'start job', 'status fc-job-2'])
  const job = calls.find(c => c.path === '/start' && c.body.script)
  assert.deepEqual(job.body, {
    script: 'import torch\nprint(1)\n',
    weights: { repo: 'acme/tiny-model', sha: SHA, licenses: ['apache-2.0', 'mit', 'bsd-3-clause', 'bsd-2-clause', 'cc-by-4.0'] },
  })

  const fetched = lab.run('weights')
  assert.equal(fetched.status, 'ok')
  assert.equal(fetched.model, EXECUTOR)
  assert.equal(fetched.request_summary, 'public weights acme/tiny-model')
  assert.equal(fetched.output_tail, `acme/tiny-model@${SHA}: fetched 4 files, 1.50 GB; license apache-2.0`)
  assert.deepEqual(fetched.detail, { repo: 'acme/tiny-model', revision: 'main', sha: SHA, license: 'apache-2.0', size_bytes: 1_500_000_000, files: 4, cached: false, evicted: [], rule: null })

  const ran = lab.run('gpu_job')
  assert.equal(ran.status, 'ok')
  assert.equal(ran.request_summary, 'fine-tuned from acme/tiny-model@aaaaaaaaaaaa: probe the last layer')
  assert.equal(ran.detail.label, `fine-tuned from acme/tiny-model@${SHA}`)
  assert.deepEqual(ran.detail.weights, { repo: 'acme/tiny-model', sha: SHA, license: 'apache-2.0' })
  assert.equal(ran.detail.output, 'self-reported, unverified')
  assert.equal(ran.output_tail, 'val_loss 0.41')

  // Both are on the spend ledger as estimates, so the daily budget counts them.
  assert.deepEqual(lab.modelCalls.map(c => [c.model_id, c.cost_source]).sort(), [['tool/gpu_job', 'estimate'], ['tool/weights', 'estimate']])
  assert.ok(Math.abs(lab.modelCalls.find(c => c.model_id === 'tool/weights').cost_usd - 20 * 0.000306) < 1e-12)

  // The Commentator's lines come from the same records.
  const said = Object.fromEntries(out.map(o => [o.tool, o.summary]))
  assert.equal(said.weights, `Claude Fable 5.2 asked for public weights: acme/tiny-model@${SHA}: fetched 4 files, 1.50 GB; license apache-2.0`)
  assert.equal(said.gpu_job, `Claude Fable 5.2's GPU job (fine-tuned from acme/tiny-model@${SHA}): ok at stage run, exit 0`)
})

test('a job that names no weights is labelled from scratch, and so is one whose sandbox had none mounted', async () => {
  weightsOn()
  let calls = []
  globalThis.fetch = fakeModal(calls, { jobResult: jobOk })
  let out = await sideTools({ gpu_job: { purpose: 'tiny MLP', script: 'print(1)' } })
  assert.equal(calls[0].raw, JSON.stringify({ script: 'print(1)' }))
  let ran = lab.run('gpu_job')
  assert.equal(ran.request_summary, 'from scratch: tiny MLP')
  assert.equal(ran.detail.label, 'from scratch')
  assert.equal(ran.detail.weights, null)
  assert.match(out[0].summary, /'s GPU job \(from scratch\): ok/)

  // The label never comes from the request. A Modal app that mounted nothing (one deployed
  // before this feature ignores the field) reports no weights, so the result says from scratch.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  calls = []
  globalThis.fetch = fakeModal(calls, { jobResult: { status: 'error', stage: 'run', exit_code: 1, log_tail: 'FileNotFoundError: /weights', wall_seconds: 9, gpu: 'A10G' } })
  out = await sideTools({ gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
  assert.deepEqual(calls[0].body.weights.repo, 'acme/tiny-model')
  ran = lab.run('gpu_job')
  assert.equal(ran.status, 'failed')
  assert.equal(ran.request_summary, 'from scratch: probe')
  assert.equal(ran.detail.label, 'from scratch')

  // Weights already on the shelf from an earlier epoch: no fetch, the controller picks the commit and reports it.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  calls = []
  globalThis.fetch = fakeModal(calls, { jobResult: jobOk })
  await sideTools({ gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
  assert.equal(calls.filter(c => c.path === '/start').length, 1)
  assert.equal(calls[0].body.weights.sha, undefined)
  assert.equal(lab.run('gpu_job').detail.label, `fine-tuned from acme/tiny-model@${OTHER_SHA}`)
  assert.equal(lab.run('weights'), undefined)
})

test('a refused fetch is recorded with its rule, and the job written for those weights does not start', async () => {
  weightsOn()
  for (const [rule, reason] of [
    ['gated', 'the repository is gated (its terms need an account), and the lab uses no Hugging Face token'],
    ['license', 'license cc-by-nc-4.0 is not on the lab\'s list (apache-2.0, bsd-2-clause, bsd-3-clause, cc-by-4.0, mit)'],
    ['format', 'the repository has no safetensors weights; pickle formats (.bin, .pt, .pkl) are never downloaded'],
    ['custom_code', 'its config has an auto_map entry, which needs the repository\'s own code'],
    ['size', 'its files total 7.20 GB, over the limit of 3 GB'],
  ]) {
    lab = new FakeLab()
    db.handler = (text, values) => lab.handle(text, values)
    const calls = []
    globalThis.fetch = fakeModal(calls, { fetchResult: { status: 'refused', rule, reason, wall_seconds: 0.5 }, jobResult: jobOk })
    const out = await sideTools({ weights: { repo: 'acme/tiny-model', revision: 'v2' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
    const fetched = lab.run('weights')
    assert.equal(fetched.status, 'failed', rule)
    assert.equal(fetched.request_summary, 'public weights acme/tiny-model at v2')
    assert.equal(fetched.output_tail, `refused (${rule}): ${reason}`)
    assert.equal(fetched.detail.rule, rule)
    assert.equal(fetched.detail.sha, null)
    // No GPU job was started, and it is stored as skipped with the reason.
    assert.equal(calls.filter(c => c.path === '/start' && c.body.script).length, 0, rule)
    const skipped = lab.run('gpu_job')
    assert.equal(skipped.status, 'skipped')
    assert.match(skipped.output_tail, new RegExp(`^the weights it names \\(acme/tiny-model\\) are not on the shelf: refused \\(${rule}\\)`))
    assert.deepEqual(lab.modelCalls.map(c => c.model_id), ['tool/weights'])
    assert.equal(out.find(o => o.tool === 'gpu_job').status, 'skipped')
  }

  // A job that names different weights, or none, still runs after a refusal.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  const calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: { status: 'refused', rule: 'gated', reason: 'gated', wall_seconds: 0.5 }, jobResult: jobOk })
  await sideTools({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'tiny MLP', script: 'print(1)' } })
  assert.equal(lab.run('gpu_job').request_summary, 'from scratch: tiny MLP')
})

test('weights that are not on the shelf never start a GPU, and a slow fetch does not hold the epoch', async () => {
  weightsOn()
  // The controller found nothing by that name: stage "weights", almost nothing charged, no label.
  let calls = []
  globalThis.fetch = fakeModal(calls, { jobResult: { status: 'error', stage: 'weights', error: 'no GPU was started. acme/absent is not on the lab\'s shelf; ask for it with the weights tool first', exit_code: null, log_tail: '', wall_seconds: 0.4, gpu: null, weights: null } })
  await sideTools({ gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/absent' } })
  let ran = lab.run('gpu_job')
  assert.equal(ran.status, 'failed')
  assert.equal(ran.request_summary, 'probe')
  assert.equal(ran.detail.label, undefined)
  assert.match(ran.output_tail, /not on the lab's shelf/)
  assert.ok(ran.cost_usd < 0.001)

  // Still fetching when the wait ends: recorded as a timeout, and the job for those weights waits for another epoch.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  process.env.LAB_WEIGHTS_POLL_MAX_MS = '20'
  calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk, pending: ['fetch'] })
  await sideTools({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
  assert.equal(lab.run('weights').status, 'timeout')
  assert.match(lab.run('weights').output_tail, /still fetching after 0 s/)
  assert.equal(lab.run('gpu_job').status, 'skipped')
  assert.equal(calls.filter(c => c.path === '/start' && c.body.script).length, 0)

  // A badly named weights field drops the job rather than running it without them.
  const planned = plan({ gpu_job: { purpose: 'probe', script: 'print(1)', weights: '../shelf' } })
  assert.equal(planned.gpu_job, undefined)
  assert.deepEqual(planned.ignored, [{ tool: 'gpu_job', reason: 'weights must be a repository id written as org/name' }])
  assert.deepEqual(plan({ weights: { repo: 'gpt2' } }).ignored, [{ tool: 'weights', reason: 'repo must be a Hugging Face repository id written as org/name' }])
})

test('a misspelt license list turns public weights off, and never means the default list', async () => {
  weightsOn()
  for (const misspelt of ['mit;apache-2.0', 'Apache 2.0', '"mit"', '!!!, ,']) {
    process.env.LAB_WEIGHTS_LICENSES = misspelt
    const config = toolsConfig.toolConfig()
    assert.equal(config.weights.enabled, false, misspelt)
    assert.equal(config.weights.off_reason, 'LAB_WEIGHTS_LICENSES is set but names no license id', misspelt)
    assert.deepEqual(toolsConfig.enabledTools(), ['gpu_job'], misspelt)
    assert.deepEqual(weights.weightsLimits().licenses, [], misspelt)
    assert.doesNotMatch(`${prompts.toolLines()}\n${prompts.executorToolsSection()}`, /weights|Hugging Face/i, misspelt)
  }
  // It is said in the logs, once per value, without printing the value.
  const said = logs.filter(l => /LAB_WEIGHTS_LICENSES/.test(l))
  assert.equal(said.length, 4)
  for (const line of said) {
    assert.match(line, /is set but names no license id .*public weights stay off/)
    assert.doesNotMatch(line, /Apache 2\.0|mit;apache/)
  }
  toolsConfig.toolConfig()
  assert.equal(logs.filter(l => /LAB_WEIGHTS_LICENSES/.test(l)).length, 4)

  // No request reaches Modal, and a job is sent as it is with the switch off.
  const planned = plan({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
  assert.deepEqual(planned.ignored, [{ tool: 'weights', reason: 'not enabled' }])
  const calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk })
  await epochTools.runSideTools(ctx(), planned, new Set())
  assert.deepEqual(calls.filter(c => c.path === '/start').map(c => c.raw), [JSON.stringify({ script: 'print(1)' })])
  assert.equal(lab.run('gpu_job').request_summary, 'probe')

  // A list with some good entries is narrowed to those, stays on, and says how many were left out.
  logs = []
  process.env.LAB_WEIGHTS_LICENSES = 'mit, Apache 2.0, BSD-3-Clause'
  assert.equal(toolsConfig.toolConfig().weights.enabled, true)
  assert.deepEqual(weights.weightsLimits().licenses, ['bsd-3-clause', 'mit'])
  assert.match(prompts.toolLines(), /every license it states is one of bsd-3-clause, mit,/)
  assert.deepEqual(logs.filter(l => /LAB_WEIGHTS_LICENSES/.test(l)), ['[Tools] LAB_WEIGHTS_LICENSES: 1 entry is not a license id and was left out; 2 licenses allowed'])

  // With the switch off the variable is not looked at aloud.
  logs = []
  process.env.LAB_ENABLE_WEIGHTS = 'false'
  process.env.LAB_WEIGHTS_LICENSES = 'nonsense list'
  assert.match(toolsConfig.toolConfig().weights.off_reason, /LAB_ENABLE_WEIGHTS is not true/)
  assert.deepEqual(logs, [])
})

test('a job that does not name the weights being fetched starts at once, beside the fetch', async () => {
  weightsOn()
  process.env.LAB_WEIGHTS_POLL_MAX_MS = '150'
  for (const [named, sent] of [[undefined, undefined], ['', undefined], ['acme/other-model', { repo: 'acme/other-model' }]]) {
    lab = new FakeLab()
    db.handler = (text, values) => lab.handle(text, values)
    const calls = []
    // The fetch never finishes inside its wait; the job answers at once.
    globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk, pending: ['fetch'] })
    const tools = { weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'tiny MLP', script: 'print(1)' } }
    if (named !== undefined) tools.gpu_job.weights = named
    await sideTools(tools)

    const order = calls.map(c => (c.path === '/start' ? (c.body.fetch_weights ? 'start fetch' : 'start job') : `status ${new URL(c.url).searchParams.get('call_id').replace(/-\d+$/, '')}`))
    // The job was started and answered while the fetch was still being waited for.
    assert.ok(order.indexOf('status fc-job') >= 0, JSON.stringify(named))
    assert.ok(order.indexOf('status fc-job') < order.lastIndexOf('status fc-fetch'), `${JSON.stringify(named)}: ${order.join(', ')}`)
    const job = calls.find(c => c.path === '/start' && c.body.script)
    assert.deepEqual(job.body.weights && { repo: job.body.weights.repo, sha: job.body.weights.sha }, sent && { repo: sent.repo, sha: undefined }, JSON.stringify(named))
    assert.equal(lab.run('gpu_job').status, 'ok')
    assert.equal(lab.run('weights').status, 'timeout')
  }
})

/** Runs `fn` with a clock that jumps forward by `jump(call)` milliseconds as each request to Modal is answered. */
async function withJumpingClock(jump, inner, fn) {
  const realNow = Date.now
  let skew = 0
  Date.now = () => realNow() + skew
  globalThis.fetch = async (url, options) => {
    const res = await inner(url, options)
    const u = new URL(String(url))
    skew += jump({ path: u.pathname, id: u.searchParams.get('call_id') || '', body: options?.body ? JSON.parse(options.body) : null }) || 0
    return res
  }
  try { return await fn() } finally { Date.now = realNow }
}

test('a fetch and the job that waits for it share the one wait a job always had', async () => {
  // The rule itself: what is left of the job's wait, or null when a job could not finish in it.
  assert.equal(gpu.gpuJobWaitMs(), 300_000)
  assert.equal(gpu.gpuWaitAfterFetch(300_000, 0), 300_000)
  assert.equal(gpu.gpuWaitAfterFetch(300_000, 100_000), 200_000)
  assert.equal(gpu.gpuWaitAfterFetch(300_000, 150_000), 150_000)
  assert.equal(gpu.gpuWaitAfterFetch(300_000, 150_001), null)
  assert.equal(gpu.gpuWaitAfterFetch(300_000, 400_000), null)
  assert.equal(gpu.gpuWaitAfterFetch(600_000, 300_000), 300_000)
  assert.equal(gpu.gpuWaitAfterFetch(600_000, 450_001), null)   // under the 120 s limit plus startup
  assert.equal(gpu.gpuWaitAfterFetch(100_000, 50_000), 50_000)  // a short configured wait: half of it
  assert.equal(gpu.gpuWaitAfterFetch(100_000, 50_001), null)
  assert.equal(gpu.gpuWaitAfterFetch(300_000, -5), 300_000)
  for (const [fetchWait, jobWait] of [[180_000, 300_000], [300_000, 300_000], [300_000, 600_000]]) {
    // Whatever the two settings, a fetch and its job together never wait longer than the job's own setting.
    for (let waited = 0; waited <= fetchWait; waited += 10_000) {
      const left = gpu.gpuWaitAfterFetch(jobWait, waited)
      assert.ok(left === null || waited + left <= jobWait)
    }
  }
  process.env.LAB_GPU_JOB_POLL_MAX_MS = '9999999'
  assert.equal(gpu.gpuJobWaitMs(), 600_000)
  delete process.env.LAB_GPU_JOB_POLL_MAX_MS

  weightsOn()
  const tools = { weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } }

  // The fetch took 100 s of the 300 s. The job then never answers: the lab gives up 200 s later, not 300 s.
  let calls = []
  await withJumpingClock(
    c => (c.id.startsWith('fc-fetch') ? 100_000 : c.id.startsWith('fc-job') ? 250_000 : 0),
    fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk, pending: ['job'] }),
    () => sideTools(tools),
  )
  assert.equal(lab.run('weights').status, 'ok')
  let ran = lab.run('gpu_job')
  assert.equal(ran.status, 'error')
  assert.equal(ran.output_tail, 'error: no result after 200 s of waiting')
  assert.equal(calls.filter(c => c.path === '/status' && c.url.includes('fc-job')).length, 1)
  // Lost, so charged at the worst case and on the ledger.
  assert.ok(Math.abs(lab.modelCalls.find(c => c.model_id === 'tool/gpu_job').cost_usd - 210 * 0.000306) < 1e-12)

  // The fetch took 160 s: too little is left for a job, so none is started and no GPU time is spent.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  calls = []
  const out = await withJumpingClock(
    c => (c.id.startsWith('fc-fetch') ? 160_000 : 0),
    fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk }),
    () => sideTools(tools),
  )
  assert.equal(lab.run('weights').status, 'ok')
  assert.equal(calls.filter(c => c.path === '/start' && c.body.script).length, 0)
  ran = lab.run('gpu_job')
  assert.equal(ran.status, 'skipped')
  assert.equal(ran.output_tail, 'its weights (acme/tiny-model) took 160 s to arrive, which leaves too little of this epoch\'s wait for a job; they are on the shelf now')
  assert.deepEqual(lab.modelCalls.map(c => c.model_id), ['tool/weights'])
  assert.equal(out.find(o => o.tool === 'gpu_job').status, 'skipped')

  // A job that did not wait for a fetch has its whole wait, as before.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  calls = []
  await withJumpingClock(
    c => (c.id.startsWith('fc-job') ? 350_000 : 0),
    fakeModal(calls, { jobResult: jobOk, pending: ['job'] }),
    () => sideTools({ gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } }),
  )
  assert.equal(lab.run('gpu_job').output_tail, 'error: no result after 300 s of waiting')
})

test('a job that waited for its fetch is checked against the budget without the fetch\'s worst case a second time', async () => {
  weightsOn()
  // Worst cases at the default rate: a fetch 960 s ($0.294), a job 210 s ($0.064). Together $0.358.
  process.env.LAB_DAILY_BUDGET_USD = '0.36'
  let calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk })
  await sideTools({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
  // The fetch cost $0.006 for its 20 s. The job's own worst case fits in what is left, so it runs.
  assert.equal(lab.run('weights').status, 'ok')
  assert.equal(lab.run('gpu_job').status, 'ok')
  assert.deepEqual(lab.modelCalls.map(c => c.model_id), ['tool/weights', 'tool/gpu_job'])

  // Started together, both are still checked against their combined worst case.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  process.env.LAB_DAILY_BUDGET_USD = '0.35'
  calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk })
  await sideTools({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'tiny MLP', script: 'print(1)' } })
  assert.equal(calls.length, 0)
  assert.match(lab.run('weights').output_tail, /its worst case \(\$0\.36\) would pass today's budget/)
  assert.match(lab.run('gpu_job').output_tail, /its worst case \(\$0\.36\) would pass today's budget/)
})

test('a job whose sandbox could not read its weights is charged, stored with the reason, and carries no label', async () => {
  weightsOn()
  const calls = []
  globalThis.fetch = fakeModal(calls, { jobResult: {
    status: 'error', stage: 'mount', error: 'the script was not run. acme/tiny-model could not be read at /weights (it may have just been removed from the shelf); ask for it with the weights tool again',
    exit_code: null, log_tail: '', run_seconds: null, wall_seconds: 25, gpu: 'A10G', weights: null,
  } })
  const out = await sideTools({ gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
  const ran = lab.run('gpu_job')
  assert.equal(ran.status, 'failed')
  assert.equal(ran.request_summary, 'probe') // neither "fine-tuned from" nor "from scratch": the script never ran
  assert.equal(ran.detail.label, undefined)
  assert.equal(ran.detail.stage, 'mount')
  assert.match(ran.output_tail, /the script was not run/)
  assert.ok(Math.abs(ran.cost_usd - 25 * 0.000306) < 1e-12) // a sandbox did start
  assert.match(out[0].summary, /'s GPU job: error at stage mount$/)
  // The Modal file has that stage, and reports weights only after the sandbox has read the manifest.
  assert.match(MODAL_SOURCE, /"stage": "mount"/)
  assert.ok(MODAL_SOURCE.indexOf('if not mount_matches(seen, found["repo"], found["sha"]):') < MODAL_SOURCE.indexOf('mounted = {"repo": found["repo"], "sha": found["sha"], "license": found["license"]}'))
})

test('the daily limit, the budget and a resumed epoch stop a fetch before it starts', async () => {
  weightsOn()
  process.env.LAB_WEIGHTS_PER_DAY = '1'
  lab.toolRuns.push({ experiment_id: 'other', epoch: 1, model: 'm', tool: 'weights', status: 'ok', created_at: new Date() })
  let calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk })
  await sideTools({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } })
  assert.equal(calls.filter(c => c.path === '/start' && c.body.fetch_weights).length, 0)
  assert.match(lab.toolRuns.find(r => r.experiment_id === 'exp-1' && r.tool === 'weights').output_tail, /daily limit of 1 reached/)
  // The job still goes to the controller, which starts it only if those weights are already on the shelf.
  assert.deepEqual(calls.find(c => c.path === '/start').body.weights.repo, 'acme/tiny-model')
  assert.equal(calls.find(c => c.path === '/start').body.weights.sha, undefined)
  assert.equal(lab.run('gpu_job').detail.label, `fine-tuned from acme/tiny-model@${OTHER_SHA}`)

  // The worst case of a fetch (960 s at the job rate) is counted against today's budget before it starts.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  delete process.env.LAB_WEIGHTS_PER_DAY
  process.env.LAB_DAILY_BUDGET_USD = '0.25'
  calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK })
  await sideTools({ weights: { repo: 'acme/tiny-model' } })
  assert.equal(calls.length, 0)
  assert.match(lab.run('weights').output_tail, /would pass today's budget/)

  // An epoch resumed after a timeout does not fetch again.
  lab = new FakeLab()
  db.handler = (text, values) => lab.handle(text, values)
  delete process.env.LAB_DAILY_BUDGET_USD
  calls = []
  globalThis.fetch = fakeModal(calls, { fetchResult: FETCH_OK, jobResult: jobOk })
  await epochTools.runSideTools(ctx(), plan({ weights: { repo: 'acme/tiny-model' }, gpu_job: { purpose: 'probe', script: 'print(1)', weights: 'acme/tiny-model' } }), new Set(['weights']))
  assert.equal(calls.filter(c => c.path === '/start' && c.body.fetch_weights).length, 0)
  assert.equal(calls.filter(c => c.path === '/start' && c.body.script).length, 1)
  assert.equal(lab.run('gpu_job').detail.label, `fine-tuned from acme/tiny-model@${OTHER_SHA}`)
})

// ===========================================================================
// The documents
// ===========================================================================
test('the documents name the switch, the settings and the deploy command', () => {
  const tools = readFileSync(join(root, 'docs/TOOLS.md'), 'utf8')
  const ops = readFileSync(join(root, 'docs/OPERATIONS.md'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  for (const name of ['LAB_ENABLE_WEIGHTS', 'LAB_WEIGHTS_LICENSES', 'LAB_WEIGHTS_MAX_GB', 'LAB_WEIGHTS_SHELF_GB', 'LAB_WEIGHTS_PER_DAY', 'LAB_WEIGHTS_POLL_MAX_MS']) {
    for (const [doc, text] of [['TOOLS.md', tools], ['OPERATIONS.md', ops], ['.env.example', env]]) assert.ok(text.includes(name), `${name} in ${doc}`)
  }
  assert.match(env, /^LAB_ENABLE_WEIGHTS=false$/m)
  assert.ok(ops.includes('modal deploy modal/gpu_jobs.py'))
  assert.ok(ops.includes('oblab-weights'))
  assert.match(tools, /\| `weights` \| `LAB_ENABLE_WEIGHTS=true` \|/)
  assert.match(tools, /apache-2\.0, mit, bsd-3-clause, bsd-2-clause, cc-by-4\.0/)
  // The check by hand has a command for each step it expects a result from, each with its own poll,
  // and the token is cleared only after the last of them.
  const smoke = ops.slice(ops.indexOf('read -s JOBS_TOKEN'), ops.indexOf('unset JOBS_TOKEN'))
  assert.equal((smoke.match(/curl -sS -X POST "\$START"/g) || []).length, 5)
  assert.ok((smoke.match(/curl -sS "\$STATUS\?call_id=/g) || []).length >= 5)
  const withoutWeights = smoke.slice(smoke.indexOf('# d)'), smoke.indexOf('# e)'))
  assert.match(withoutWeights, /-d '\{"script":"import os/)
  assert.doesNotMatch(withoutWeights, /"weights":\{/)
  for (const text of [tools, ops]) {
    const section = text.slice(text.indexOf('## Public weights'))
    assert.ok(section.length > 500)
    assert.doesNotMatch(section.slice(0, section.indexOf('\n## ', 10) > 0 ? section.indexOf('\n## ', 10) : undefined), /—/)
  }
})
