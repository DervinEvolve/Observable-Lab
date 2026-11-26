// Tinker RL (LAB_ENABLE_TINKER_RL, on by default): what a model may ask for, the
// rubric engine, the cost estimate and the caps, the progress the room is
// drawn from, the reward-hacking flag, the public record, and the whole run
// against a fake runner. The rubric engine is checked against the same file of
// cases as its Python twin (tests/test_tinker_rl.py).
//
// No network, no database, no secrets: fetch answers like the lab's runner on
// Modal, and `@vercel/postgres` is an in-memory fake that understands the
// queries these paths make, including the conditional UPDATE that holds the
// daily caps.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-tinker-rl-test-'))
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
for (const path of ['src/systems/TrainedChatPanel.ts', 'src/systems/chatOffer.ts', 'src/systems/paperTheme.ts', 'src/systems/toolRuns.ts', 'src/shared/types.ts']) {
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
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder-0000'
const JOBS_TOKEN = 'test-only-tinker-jobs-token-000000000000'
const BASE_ENV = { ...process.env }

let logs = []
const capture = (...args) => logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = capture
console.log = capture
console.error = capture

const load = path => import(pathToFileURL(join(build, path)).href)
const { db } = await load('fake-postgres.js')
const tinker = await load('api/_lib/tinker.js')
const rl = await load('api/_lib/tinker-rl.js')
const rlRun = await load('api/_lib/tinker-rl-run.js')
const rlPublic = await load('api/_lib/tinker-rl-public.js')
const rubric = await load('api/_lib/rubric.js')
const store = await load('api/_lib/tinker-store.js')
const runs = await load('api/_lib/tinker-run.js')
const toolsConfig = await load('api/_lib/tools-config.js')
const toolRequests = await load('api/_lib/tool-requests.js')
const epochTools = await load('api/_lib/epoch-tools.js')
const prompts = await load('api/_lib/prompts.js')
const panel = await load('src/systems/TrainedChatPanel.js')
const roomRuns = await load('src/systems/toolRuns.js')

const cases = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'rubric-cases.json'), 'utf8'))

// ===========================================================================
// The rubric engine: the same cases as the Python twin
// ===========================================================================
test('the rubric engine gives the answers in the shared file of cases', () => {
  for (const c of cases.normalise) assert.equal(rubric.normaliseText(c.input), c.expected, JSON.stringify(c.input))
  for (const c of cases.numbers) assert.deepEqual(rubric.numbersIn(c.input), c.expected, c.input)
  for (const c of cases.regex) {
    const x = rubric.compileRegex(c.pattern, c.ignore_case === true)
    assert.ok('regex' in x, `${c.pattern}: ${x.error}`)
    assert.equal(rubric.regexSearch(x.regex, c.text.repeat(c.repeat ?? 1) + (c.suffix ?? '')), c.match, c.pattern.slice(0, 40))
  }
  for (const pattern of cases.regex_refused) {
    const x = rubric.compileRegex(pattern)
    assert.ok('error' in x && x.error, `refused: ${pattern.slice(0, 30)}`)
  }
  for (const c of cases.scores) {
    const n = rubric.normalizeRubric(c.rubric)
    assert.ok('rubric' in n, `${c.name}: ${n.error}`)
    assert.ok(Math.abs(rubric.scoreCompletion(n.rubric, c.task, c.completion) - c.score) < 1e-9, c.name)
  }
  for (const r of cases.rubric_ok) assert.ok('rubric' in rubric.normalizeRubric(r), JSON.stringify(r).slice(0, 80))
  for (const c of cases.rubric_refused) {
    const n = rubric.normalizeRubric(c.rubric)
    assert.ok('error' in n && n.error, c.why)
  }
})

test('a pattern that makes a backtracking engine run for ever is harmless or refused, never slow', () => {
  for (const pattern of ['^(a+)+$', '^(a*)*b$', '^(a|a)*c$', '^(.*)*x$', '^(a+){2,}$']) {
    const x = rubric.compileRegex(pattern)
    if (!('regex' in x)) continue
    const started = Date.now()
    assert.equal(rubric.regexSearch(x.regex, 'a'.repeat(3000) + '!'), false, pattern)
    assert.ok(Date.now() - started < 3000, pattern)
  }
  for (const pattern of ['(?=a)b', '(a)\\1', 'a+?', '\\bword', '(?<=a)b', 'a*+']) assert.ok('error' in rubric.compileRegex(pattern), pattern)
  assert.ok('error' in rubric.compileRegex('a'.repeat(rubric.RUBRIC_REGEX_MAX_LEN + 1)))
})

// ===========================================================================
// The switch
// ===========================================================================
const START_URL = 'https://lab--oblab-tinker-start.modal.example/'
const STATUS_URL = 'https://lab--oblab-tinker-status.modal.example/'
function configure(extra = {}) {
  Object.assign(process.env, { TINKER_JOBS_START_URL: START_URL, TINKER_JOBS_STATUS_URL: STATUS_URL, TINKER_JOBS_TOKEN: JOBS_TOKEN, ...extra })
}

let lab
beforeEach(() => {
  process.env = { ...BASE_ENV }
  logs = []
  lab = new FakeDb()
  db.handler = (text, values) => lab.handle(text, values)
  globalThis.fetch = async url => { throw new Error(`Unexpected outbound request to ${url}`) }
  rlPublic.resetRlPracticeCache()
})

test('the switch is on unless it is explicitly false-like, and says why when something it needs is missing', () => {
  // unset, empty, or anything that is not a false-like word: on
  for (const value of [undefined, '', 'true', 'TRUE', ' yes ', '1', 'on', 'enabled', 'maybe']) {
    if (value === undefined) delete process.env.LAB_ENABLE_TINKER_RL
    else process.env.LAB_ENABLE_TINKER_RL = value
    assert.equal(rl.tinkerRlFlag(), true, `value ${JSON.stringify(value)}`)
  }
  for (const value of ['false', 'FALSE', ' False ', '0', 'off', 'OFF', 'no', ' No ']) {
    process.env.LAB_ENABLE_TINKER_RL = value
    assert.equal(rl.tinkerRlFlag(), false, `value ${JSON.stringify(value)}`)
    configure()
    assert.deepEqual(rl.tinkerRlStatus(), { enabled: false, off_reason: 'LAB_ENABLE_TINKER_RL is switched off' })
  }
  process.env = { ...BASE_ENV }
  // on by default, but it needs the training runner: without it, it says what is missing
  const missing = rl.tinkerRlStatus()
  assert.equal(missing.enabled, false)
  assert.match(missing.off_reason, /TINKER_JOBS_START_URL/)
  configure()
  assert.deepEqual(rl.tinkerRlStatus(), { enabled: true })
  // it does not need Tinker training's own switch
  assert.equal(tinker.tinkerStatus().enabled, false)
  assert.equal(toolsConfig.toolConfig().tinker_rl.enabled, true)
  assert.ok(toolsConfig.enabledTools().includes('tinker_rl'))
  // and its own dollar settings are Tinker training's
  configure({ LAB_TINKER_RUN_USD: '0' })
  assert.match(rl.tinkerRlStatus().off_reason, /LAB_TINKER_RUN_USD or LAB_TINKER_DAILY_USD is 0/)
  process.env.LAB_ENABLE_TINKER_RL = 'false'
  assert.equal(toolsConfig.toolConfig().tinker_rl.enabled, false)
  assert.ok(!toolsConfig.enabledTools().includes('tinker_rl'))
})

test('the runs per day have a limit of their own', () => {
  assert.equal(rl.tinkerRlPerDay(), 2)
  for (const [value, expected] of [['5', 5], ['0', 0], ['99', 10], ['-3', 0], ['x', 2], ['1.5', 2]]) {
    process.env.LAB_TINKER_RL_PER_DAY = value
    assert.equal(rl.tinkerRlPerDay(), expected, value)
  }
})

// ===========================================================================
// What a model may ask for
// ===========================================================================
const BASE = tinker.tinkerBaseModels().models[0]
const task = i => ({ prompt: `What is ${i} plus ${i}? Give the number on the last line.`, expected: String(2 * i) })
const tasks = (n = 20) => Array.from({ length: n }, (_, i) => task(i))
const RUBRIC = { rules: [{ type: 'exact_match', weight: 0.7, from: 'expected', scope: 'last_line' }, { type: 'length_between', weight: 0.3, min: 1, max: 400 }] }
const ask = (extra = {}) => ({ purpose: 'practise adding', task_set: 'Short sums', tasks: tasks(), rubric: RUBRIC, ...extra })
const ok = raw => {
  const checked = rl.normalizeTinkerRlRequest(raw)
  assert.ok('request' in checked, checked.error)
  return checked.request
}
const refused = raw => {
  const checked = rl.normalizeTinkerRlRequest(raw)
  assert.ok('error' in checked, 'it should have been refused')
  return checked.error
}

test('a good request is read with the defaults filled in, and the data and the rubric are fingerprinted', () => {
  const request = ok(ask())
  assert.equal(request.base_model, BASE)
  assert.deepEqual(request.settings, { rank: 16, learning_rate: 4e-5, group_size: 8, steps: 10, tasks_per_step: 4, max_completion_tokens: 256, loss: 'importance_sampling' })
  assert.equal(request.tasks.length, 20)
  assert.equal(request.task_set, 'Short sums')
  assert.match(request.dataset_sha256, /^[0-9a-f]{64}$/)
  assert.equal(ok(ask()).dataset_sha256, request.dataset_sha256)
  assert.notEqual(ok(ask({ rubric: { rules: [{ type: 'contains', weight: 1, any: ['x'] }] } })).dataset_sha256, request.dataset_sha256)
  const wide = ok(ask({ settings: { group_size: 16, steps: 30, tasks_per_step: 16, max_completion_tokens: 512, learning_rate: 5e-4, rank: 32, loss: 'ppo' } }))
  assert.deepEqual([wide.settings.group_size, wide.settings.steps, wide.settings.loss], [16, 30, 'ppo'])
})

test('every way a request can be wrong is refused whole, with a reason', () => {
  const reason = (extra, pattern) => assert.match(refused(ask(extra)), pattern)
  assert.match(rl.normalizeTinkerRlRequest(null).error, /not an object/)
  assert.match(rl.normalizeTinkerRlRequest([]).error, /not an object/)
  reason({ unknown: 1 }, /unknown field: unknown/)
  reason({ base_model: 'nobody/model' }, /base_model must be one of/)
  reason({ tasks: tasks(7) }, /tasks must hold 8 to 400/)
  reason({ tasks: tasks(401) }, /tasks must hold 8 to 400/)
  reason({ tasks: 'x' }, /tasks is not a list/)
  reason({ tasks: [...tasks(8).slice(0, 7), { prompt: '' }] }, /tasks\[7\]/)
  reason({ tasks: [...tasks(8).slice(0, 7), { prompt: 'x', extra: 1 }] }, /tasks\[7\]/)
  reason({ tasks: [...tasks(8).slice(0, 7), task(0)] }, /same prompt/)
  reason({ tasks: tasks(8).map(t => ({ ...t, prompt: t.prompt + 'x'.repeat(1600) })) }, /1500 bytes|bytes/)
  reason({ rubric: null }, /rubric/)
  reason({ rubric: { rules: [] } }, /1 to 8 rules/)
  reason({ rubric: { rules: [{ type: 'run_code', weight: 1 }] } }, /run_code|type/)
  reason({ rubric: { rules: [{ type: 'contains', weight: 0.7, any: ['a'] }, { type: 'contains', weight: 0.7, any: ['b'] }] } }, /add up to/)
  reason({ rubric: { rules: [{ type: 'regex_match', weight: 1, pattern: '(?=a)b' }] } }, /regex_match|pattern|lookaround/i)
  reason({ rubric: { rules: [{ type: 'exact_match', weight: 1, from: 'data.answer' }] } }, /data\.answer/)
  reason({ settings: { group_size: 1 } }, /group_size/)
  reason({ settings: { group_size: 17 } }, /group_size/)
  reason({ settings: { group_size: 2.5 } }, /group_size/)
  reason({ settings: { steps: 0 } }, /steps/)
  reason({ settings: { steps: 31 } }, /steps/)
  reason({ settings: { tasks_per_step: 17 } }, /tasks_per_step/)
  reason({ settings: { max_completion_tokens: 513 } }, /max_completion_tokens/)
  reason({ settings: { max_completion_tokens: 15 } }, /max_completion_tokens/)
  reason({ settings: { learning_rate: 1 } }, /learning_rate/)
  reason({ settings: { learning_rate: 0 } }, /learning_rate/)
  reason({ settings: { rank: 7 } }, /rank/)
  reason({ settings: { loss: 'mse' } }, /loss must be one of importance_sampling, ppo, cispo/)
  reason({ settings: { code: 'x' } }, /unknown field/)
  reason({ settings: 'fast' }, /settings is not an object/)
  reason({ task_set: '<b>sums</b>' }, /task_set/)
  reason({ task_set: 'x'.repeat(49) }, /task_set/)
  // the text of all the tasks together is bounded
  reason({ tasks: Array.from({ length: 100 }, (_, i) => ({ prompt: `${i} ` + 'p'.repeat(1400), expected: 'e'.repeat(300) })) }, /bytes of text/)
})

test('the display name follows the names rules, and only while names are on', () => {
  assert.match(refused(ask({ name: 'Adder' })), /unknown field: name/)
  process.env.LAB_ENABLE_TINKER_NAMES = 'true'
  assert.equal(ok(ask({ name: 'Adder' })).name, 'Adder')
  const bad = ok(ask({ name: '<script>' }))
  assert.equal(bad.name, undefined)
  assert.ok(bad.name_refused)
})

test('a model that asks for a rule it has no data for, or for code, gets no run', () => {
  assert.match(refused(ask({ rubric: { rules: [{ type: 'number_close', weight: 1, from: 'data.target', tolerance: 1 }] } })), /data\.target/)
  assert.match(refused(ask({ rubric: { rules: [{ type: 'exact_match', weight: 1, value: 'x', code: 'os.system("x")' }] } })), /code|unknown|field/i)
  assert.match(refused(ask({ rubric: 'def reward(x): return 1' })), /rubric/)
})

// ===========================================================================
// The cost before starting, and the caps
// ===========================================================================
test('the estimate is the most the run could cost, grows with every setting, and stays under the per-run cap at its smallest and largest sensible sizes', () => {
  const small = rl.estimateTinkerRl(ok(ask({ settings: { steps: 2, group_size: 2, tasks_per_step: 1, max_completion_tokens: 32 } })))
  const normal = rl.estimateTinkerRl(ok(ask()))
  assert.ok(small.max_cost_usd > 0 && small.max_cost_usd < normal.max_cost_usd)
  assert.equal(normal.holdout, 3)
  assert.equal(normal.train_tasks, 17)
  assert.equal(normal.attempts, 10 * 4 * 8)
  for (const [key, value] of [['steps', 20], ['group_size', 16], ['tasks_per_step', 8], ['max_completion_tokens', 512]]) {
    const more = rl.estimateTinkerRl(ok(ask({ settings: { [key]: value } })))
    assert.ok(more.max_cost_usd > normal.max_cost_usd, key)
  }
  // it counts the sampled answers at their longest, plus what the prompts take, plus training, plus both held-out scorings, with a margin
  const request = ok(ask())
  const s = request.settings
  const longest = Math.max(...request.tasks.map(rl.estimateTaskTokens))
  assert.ok(normal.max_cost_usd >= tinker.tinkerCostUsd(request.base_model, {
    train: 0, eval: 0, sample_prompt: s.steps * s.tasks_per_step * longest * 0.5, sample_completion: s.steps * s.tasks_per_step * s.group_size * s.max_completion_tokens,
  }))
  assert.equal(rl.tinkerRlJobBody(request, { splitSalt: 'ab'.repeat(16), budgetUsd: 1, label: 'x', runId: 'e41-0a1b2c3d' }).run_id, 'e41-0a1b2c3d')
  // the biggest run a model may ask for is over the default per-run cap, so it is refused before anything is set aside
  const biggest = ok(ask({ tasks: tasks(400), settings: { steps: 30, group_size: 16, tasks_per_step: 16, max_completion_tokens: 512 } }))
  assert.ok(rl.estimateTinkerRl(biggest).max_cost_usd > tinker.tinkerRunUsd())
})

test('money is set aside atomically and settled to the measured tokens, in the same table as a training run', async () => {
  const a = await store.reserveTinkerSpend('all', 4, 10)
  assert.deepEqual([a.ok, a.usd], [true, 4])
  assert.equal((await store.reserveTinkerSpend('all', 4, 10)).ok, true)
  assert.deepEqual(await store.reserveTinkerSpend('all', 4, 10), { ok: false, reason: "it would pass today's cap of $10.00 (UTC)" })
  await store.settleTinkerSpend(a, 0.5)
  assert.deepEqual(await store.tinkerSpendToday('all'), { spent_usd: 0.5, reserved_usd: 4 })
  assert.ok(lab.statements.some(s => s.text.startsWith('UPDATE tinker_spend_days SET reserved_usd = reserved_usd + ?')))
})

const CTX = { experimentId: 'exp-1', epochNumber: 41, executorModelId: 'anthropic/claude-fable-5.2', assignedExecutorId: 'anthropic/claude-fable-5.2', reviewerModelId: 'openai/gpt-6-astra' }
const planFor = raw => toolRequests.planTools({ tinker_rl: raw }, toolsConfig.toolConfig())
const deliver = (plan, verdicts = { tinker_rl: 'approve' }, ctx = CTX) => epochTools.runDeliverables(ctx, plan, verdicts, new Set())

const SAMPLER = 'tinker://0a1b2c3d-1111-2222-3333-444455556666:train:0/sampler_weights/final'
const runnerOk = (extra = {}) => ({
  status: 'ok', kind: 'rl', n_tasks: 20, n_train: 17, n_holdout: 3, steps_planned: 10, steps_done: 10, stopped_early: null, max_reward: 1,
  score_before: 0.25, score_after: 0.75, train_score_first: 0.2, train_score_last: 0.7,
  step_means: [0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7], step_frac_max: [0, 0, 0.1, 0.1, 0.2, 0.3, 0.3, 0.4, 0.5, 0.6],
  tokens: { train: 40000, eval: 0, sample_prompt: 9000, sample_completion: 30000 }, sampler_path: SAMPLER, ttl_seconds: 14 * 86400,
  samples: [{ prompt: 'What is 3 plus 3?', completion: '6', reward: 1 }], wall_seconds: 300.5, ...extra,
})
const progressRecord = (extra = {}) => ({
  v: 1, phase: 'scored', step: 3, steps_planned: 10, group_size: 8, tasks_per_step: 4, max_reward: 1, means: [0.2, 0.25, 0.3], frac_max: [0, 0, 0.1],
  attempts: [0, 0, 1, 0.3, 0.7, 0, 1, 0.5], samples: [{ prompt: 'What is 3 plus 3?', completion: '6', reward: 1 }], score_before: 0.25, score_after: null, wall_seconds: 61, steps_trained: 2, seq: 7, ...extra,
})

/** fetch that answers like the runner's two endpoints; `statuses` are served in order and the last repeats. */
function fakeRunner(sent, statuses = [{ status: 'done', result: runnerOk() }], start = { call_id: 'fc-rl-1' }) {
  let polls = 0
  return async (url, options = {}) => {
    const u = String(url)
    if (u === START_URL) {
      const body = JSON.parse(options.body)
      sent.push({ kind: 'start', raw: options.body, body })
      return new Response(JSON.stringify(start), { headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith(STATUS_URL) && new URL(u).searchParams.has('call_id')) {
      sent.push({ kind: 'status', url: u })
      return new Response(JSON.stringify(statuses[Math.min(polls++, statuses.length - 1)]), { headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected outbound request to ${u}`)
  }
}

test('a request over the per-run cap, or over the daily cap, is refused before anything is started, and nothing is left set aside', async () => {
  configure({ LAB_TINKER_RUN_USD: '0.0001' })
  const plan = planFor(ask())
  assert.ok(plan.tinker_rl)
  let sent = []
  globalThis.fetch = fakeRunner(sent)
  let out = await deliver(plan)
  assert.equal(out[0].status, 'skipped')
  assert.match(out[0].summary, /over the \$0\.00 a run may cost|a run may cost/)
  assert.deepEqual(sent, [])
  assert.equal(lab.tinkerRuns.length, 0)
  assert.equal(lab.spend('all').reserved_usd, 0)
  // under the run cap but not under the day's
  const estimate = rl.estimateTinkerRl(plan.tinker_rl).max_cost_usd
  configure({ LAB_TINKER_RUN_USD: '2', LAB_TINKER_DAILY_USD: String(estimate * 1.5) })
  lab.spendDays.set(`${store.utcDay()}|all`, { day: store.utcDay(), scope: 'all', reserved_usd: estimate, spent_usd: 0 })
  out = await deliver(plan)
  assert.equal(out[0].status, 'skipped')
  assert.match(out[0].summary, /was not set aside: it would pass today's cap/)
  assert.deepEqual(sent, [])
  assert.equal(lab.tinkerRuns.length, 0)
})

// ===========================================================================
// What the models see
// ===========================================================================
test('the request is planned only while the tool is on, and an epoch has one Tinker run of either kind', () => {
  configure()
  const plan = planFor(ask())
  assert.ok(plan.tinker_rl)
  assert.equal(plan.tinker_rl.tasks.length, 20)
  // both kinds in one answer: the training run keeps its place (when training is on; with it off, the RL request stands)
  assert.ok(toolRequests.planTools({ tinker_rl: ask(), tinker_train: { purpose: 'x', examples: [] } }, toolsConfig.toolConfig()).tinker_rl)
  process.env.LAB_ENABLE_TINKER = 'true'
  const both = toolRequests.planTools({ tinker_rl: ask(), tinker_train: { purpose: 'x', examples: [] } }, toolsConfig.toolConfig())
  assert.ok(!both.tinker_rl)
  assert.ok(both.ignored.some(i => i.tool === 'tinker_rl' && /one Tinker run/.test(i.reason)))
  delete process.env.LAB_ENABLE_TINKER
  // a bad request is a stored refusal and no run
  const bad = planFor(ask({ settings: { steps: 99 } }))
  assert.ok(!bad.tinker_rl)
  assert.ok(bad.ignored.some(i => i.tool === 'tinker_rl' && /steps/.test(i.reason)))
  // off: an unknown tool, as it always was
  process.env.LAB_ENABLE_TINKER_RL = 'off'
  const off = planFor(ask())
  assert.ok(!off.tinker_rl)
  assert.ok(off.ignored.some(i => i.tool === 'tinker_rl'))
})

test('the models are told what the tool does and where its limits are, and nothing about what to build', () => {
  configure()
  const config = toolsConfig.toolConfig()
  const lines = prompts.toolLines(config)
  const line = lines.split('\n').find(l => l.includes('Tinker RL'))
  assert.ok(line, 'the tool line')
  for (const part of ['exact_match', 'contains', 'not_contains', 'number_close', 'regex_match', 'json_valid', 'length_between', 'group_size', 'holds out', 'measured by the lab', '0.95', 'a flag blocks nothing', 'no code', 'weighted sum']) {
    assert.ok(line.includes(part), `the note says ${part}`)
  }
  assert.ok(line.includes(`$${tinker.tinkerRunUsd().toFixed(2)} a run`) && line.includes('estimates'))
  for (const forbidden of [/you should (?:build|train|make)/i, /we want you to/i, /try to (?:build|make|train)/i, /\bgoal\b/i, /cool/i]) assert.ok(!forbidden.test(line), String(forbidden))
  assert.ok(!line.includes('—'), 'no em dash')
  const section = prompts.executorToolsSection(config)
  assert.match(section, /"tinker_rl": \{/)
  assert.match(section, /A Tinker RL request takes exactly the fields shown/)
  assert.ok(!section.includes('—'))
  assert.ok(!prompts.toolLines({ ...config, tinker_rl: { ...config.tinker_rl, enabled: false } }).includes('Tinker RL'))
  const facts = prompts.tinkerRlReviewFacts(ok(ask())).line
  assert.match(facts, /rubric/)
  assert.match(facts, /the most it could cost/)
  assert.match(prompts.reviewerToolSection({ tinker_rl: { line: facts } }), /"tinker_rl": "approve" \| "reject"/)
})

test('a verdict other than an explicit approve is a no, and the tool is a named verdict key', () => {
  assert.deepEqual(epochTools.readToolVerdicts({ tool_verdicts: { tinker_rl: 'APPROVE' } }), { tinker_rl: 'approve' })
  assert.deepEqual(epochTools.readToolVerdicts({ tool_verdicts: { tinker_rl: 'yes' } }), {})
})

// ===========================================================================
// Progress and the flag
// ===========================================================================
test('the progress the runner writes is read strictly and bounded', () => {
  const p = rl.readRlProgress(progressRecord(), new Date('2026-11-19T10:00:00Z'))
  assert.equal(p.step, 3)
  assert.deepEqual(p.means, [0.2, 0.25, 0.3])
  assert.equal(p.updated_at, '2026-11-19T10:00:00.000Z')
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= rl.RL_PROGRESS_MAX_BYTES)
  // a field out of range drops the whole record: the bench shows nothing rather than a guess
  for (const bad of [
    { v: 2 }, { phase: 'dreaming' }, { step: 11 }, { step: -1 }, { group_size: 17 }, { group_size: 1 }, { means: [1.5] }, { means: [NaN] },
    { means: Array(31).fill(0.5) }, { attempts: Array(17).fill(0.5) }, { max_reward: 'x' }, { steps_planned: 0 }, { score_before: 2 }, { samples: 'x' },
    { samples: [{ prompt: 'p', completion: 'c', reward: 5 }] }, { means: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.9, 0.9], steps_planned: 10 },
  ]) assert.equal(rl.readRlProgress(progressRecord(bad)), null, JSON.stringify(bad).slice(0, 60))
  assert.equal(rl.readRlProgress('x'), null)
  assert.equal(rl.readRlProgress(null), null)
  // samples are cleaned and cut, and go first when the record is too large
  const wild = rl.readRlProgress(progressRecord({ samples: [1, 2, 3, 4].map(() => ({ prompt: 'p\u0000'.repeat(300), completion: '<img src=x onerror=1>'.repeat(50), reward: 0.5 })) }))
  assert.equal(wild.samples.length, 3)
  assert.ok(wild.samples.every(s => s.prompt.length <= 100 && s.completion.length <= 160 && !s.prompt.includes('\u0000')))
  assert.ok(Buffer.byteLength(JSON.stringify(wild)) <= rl.RL_PROGRESS_MAX_BYTES)
  // a stored record comes back the same way
  assert.deepEqual(rl.storedRlProgress(JSON.stringify(p)), p)
  assert.deepEqual(rl.storedRlProgress(p), p)
  assert.equal(rl.storedRlProgress('not json'), null)
  assert.equal(rl.storedRlProgress({ ...p, step: 99 }), null)
})

test('a run is live only while the lab has heard from the runner recently', () => {
  const now = new Date('2026-11-19T10:10:00Z')
  const fresh = rl.readRlProgress(progressRecord(), new Date('2026-11-19T10:08:00Z'))
  assert.equal(rl.progressIsLive(fresh, 'running', now), true)
  assert.equal(rl.progressIsLive(fresh, 'reserved', now), true)
  assert.equal(rl.progressIsLive(fresh, 'ok', now), false)
  assert.equal(rl.progressIsLive(fresh, 'failed', now), false)
  assert.equal(rl.progressIsLive(fresh, 'running', new Date('2026-11-19T10:30:00Z')), false)
  assert.equal(rl.progressIsLive(null, 'running', now), false)
  assert.equal(rl.progressIsLive({ ...fresh, phase: 'done' }, 'running', now), false)
})

test('asking again for a record the lab already holds does not make a run look alive, and an older record never replaces a newer one', async () => {
  const t0 = new Date('2026-11-19T10:00:00Z')
  const later = new Date('2026-11-19T10:20:00Z')
  const a = rl.readRlProgress(progressRecord(), t0)
  assert.equal(a.seq, 7)
  assert.equal(a.steps_trained, 2)
  // the same record again, 20 minutes on: not new
  const again = rl.readRlProgress(progressRecord(), later)
  assert.equal(rl.isNewerProgress(again, a), false)
  assert.equal(rl.isNewerProgress(rl.readRlProgress(progressRecord({ seq: 8 }), later), a), true)
  assert.equal(rl.isNewerProgress(rl.readRlProgress(progressRecord({ seq: 6 }), later), a), false)
  // a runner without a counter: new only when something in the record differs
  const bare = rl.readRlProgress({ ...progressRecord(), seq: undefined }, t0)
  assert.equal(bare.seq, null)
  assert.equal(rl.isNewerProgress(rl.readRlProgress({ ...progressRecord(), seq: undefined }, later), bare), false)
  assert.equal(rl.isNewerProgress(rl.readRlProgress({ ...progressRecord({ step: 4, means: [0.2, 0.25, 0.3, 0.4], frac_max: [0, 0, 0.1, 0.1] }), seq: undefined }, later), bare), true)
  assert.equal(rl.readRlProgress(progressRecord({ seq: -1 })), null)
  assert.equal(rl.readRlProgress(progressRecord({ steps_trained: 99 })), null)

  // through the store: the lab asks again and again and the time stays the time it was first told
  configure({ LAB_TINKER_POLL_MAX_MS: '1' })
  const plan = planFor(ask())
  globalThis.fetch = fakeRunner([], [{ status: 'running', call_id: 'fc-rl-1', progress: progressRecord() }])
  await rlRun.runTinkerRl(CTX, plan.tinker_rl, { maxWaitMs: 1, pollMs: 1 })
  const row = lab.tinkerRuns[0]
  assert.equal(rl.storedRlProgress(row.progress).seq, 7)
  const firstTime = rl.storedRlProgress(row.progress).updated_at
  await new Promise(r => setTimeout(r, 5))
  for (let i = 0; i < 3; i++) await rlRun.storeRlProgress({ id: row.id, progress: row.progress }, progressRecord(), new Date())
  assert.equal(rl.storedRlProgress(row.progress).updated_at, firstTime, 'the same record again is not stored again')
  // a late older record, from a caller that holds an old row, does not replace the newer one
  await rlRun.storeRlProgress({ id: row.id, progress: null }, progressRecord({ seq: 9, step: 4, means: [0.2, 0.25, 0.3, 0.4], frac_max: [0, 0, 0.1, 0.1] }))
  await rlRun.storeRlProgress({ id: row.id, progress: null }, progressRecord({ seq: 8 }))
  const kept = rl.storedRlProgress(row.progress)
  assert.equal(kept.seq, 9)
  assert.equal(kept.step, 4)
  // a record that moved on (seq 10) is stored and is live
  const moved = await rlRun.storeRlProgress({ id: row.id, progress: row.progress }, progressRecord({ seq: 10, step: 5, means: [0.2, 0.25, 0.3, 0.4, 0.5], frac_max: [0, 0, 0.1, 0.1, 0.1] }))
  assert.equal(moved.seq, 10)
  assert.equal(rl.progressIsLive(rl.storedRlProgress(row.progress), 'running', new Date()), true)
})

test('the reward-hacking flag: a mean at 95% of the best within 3 steps, or a held-out gain far short of the training gain; it blocks nothing', () => {
  const flag = input => rl.rlHackingFlag({ maxReward: 1, scoreBefore: null, scoreAfter: null, ...input })
  assert.equal(flag({ means: [0.2, 0.3, 0.4, 0.5] }).flag, false)
  assert.equal(flag({ means: [0.96] }).flag, true)
  assert.equal(flag({ means: [0.5, 0.95] }).flag, true)
  assert.equal(flag({ means: [0.2, 0.3, 0.949] }).flag, false)
  assert.equal(flag({ means: [0.2, 0.3, 0.95] }).flag, true)
  assert.equal(flag({ means: [0.2, 0.3, 0.4, 0.97] }).flag, false, 'the early window is the first 3 steps')
  // relative to the best the rubric allows
  assert.equal(flag({ means: [0.48], maxReward: 0.5 }).flag, true)
  assert.equal(flag({ means: [0.4], maxReward: 0.5 }).flag, false)
  // the gap rule: from 6 steps, a training gain of 0.15 or more and a held-out gain under 40% of it
  const rising = [0.1, 0.1, 0.1, 0.3, 0.4, 0.5]
  assert.equal(flag({ means: rising, scoreBefore: 0.3, scoreAfter: 0.31 }).flag, true)
  assert.equal(flag({ means: rising, scoreBefore: 0.3, scoreAfter: 0.5 }).flag, false)
  assert.equal(flag({ means: rising, scoreBefore: 0.3, scoreAfter: 0.2 }).flag, true)
  assert.equal(flag({ means: rising.slice(0, 5), scoreBefore: 0.3, scoreAfter: 0.3 }).flag, false, 'needs 6 steps')
  assert.equal(flag({ means: [0.5, 0.5, 0.5, 0.5, 0.5, 0.55], scoreBefore: 0.3, scoreAfter: 0.3 }).flag, false, 'a small training gain is not a gap')
  assert.equal(flag({ means: rising }).flag, false, 'no held-out score, no gap rule')
  assert.ok(flag({ means: [0.99] }).reasons[0].length > 20)
})

// ===========================================================================
// The whole run, and the public record
// ===========================================================================
class FakeDb {
  constructor() {
    this.spendDays = new Map()
    this.tinkerRuns = []
    this.toolRuns = []
    this.modelCalls = []
    this.statements = []
    this.nextId = 1
  }

  uuid() { return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}` }

  spend(scope, day = store.utcDay()) { return this.spendDays.get(`${day}|${scope}`) ?? { reserved_usd: 0, spent_usd: 0 } }

  handle(text, v) {
    this.statements.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, created_at: new Date() })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE experiment_id = ? AND epoch_number = ?')) return { rows: [{ cost_usd: 0, prompt_tokens: 0, completion_tokens: 0 }] }
    if (text.startsWith('UPDATE epochs SET cost_usd')) return { rows: [] }
    if (text.includes('FROM model_calls WHERE purpose = ? AND created_at >= ?')) return { rows: [{ total: 0 }] }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) return { rows: [{ total: 0 }] }
    if (text.startsWith('INSERT INTO tool_runs')) {
      const [experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail] = v
      this.toolRuns.push({ id: this.uuid(), experiment_id, epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, detail: detail ? JSON.parse(detail) : null })
      return { rows: [] }
    }
    if (text.startsWith('SELECT COUNT(*) AS n FROM tool_runs WHERE tool = ?')) return { rows: [{ n: 0 }] }
    if (text.startsWith('SELECT DISTINCT tool FROM tool_runs')) return { rows: [] }
    if (text.startsWith('SELECT jsonb_typeof')) return { rows: [] }
    if (text.startsWith('INSERT INTO tinker_spend_days (day, scope) VALUES (?, ?) ON CONFLICT')) {
      const key = `${v[0]}|${v[1]}`
      if (!this.spendDays.has(key)) this.spendDays.set(key, { day: v[0], scope: v[1], reserved_usd: 0, spent_usd: 0 })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE tinker_spend_days SET reserved_usd = reserved_usd + ?')) {
      assert.ok(text.includes('WHERE day = ? AND scope = ? AND spent_usd + reserved_usd + ? <= ?'), 'the reserve statement lost its cap condition')
      const [amount, day, scope, again, cap] = v
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
    if (text.startsWith('INSERT INTO tinker_runs')) {
      assert.ok(text.includes('ON CONFLICT (experiment_id, epoch) DO NOTHING'), 'a run must be unique per epoch')
      assert.ok(text.includes('kind, rl'), 'an RL run is stored with its kind and record')
      const [experiment_id, epoch, model, assigned_model, slug, base_model, purpose, dataset_sha256, dataset_examples, dataset_bytes, settings, split_salt, status, spend_day, reserved_usd, kind, rlRecord] = v
      if (this.tinkerRuns.some(r => r.experiment_id === experiment_id && r.epoch === epoch)) return { rows: [] }
      const row = {
        id: this.uuid(), created_at: new Date().toISOString(), experiment_id, epoch, model, assigned_model, slug, base_model, purpose, dataset_sha256,
        dataset_examples, dataset_bytes, settings, split_salt, status, reason: null, call_id: null, spend_day, reserved_usd, cost_usd: null,
        result: null, sampler_path: null, expires_at: null, finished_at: null, kind, rl: rlRecord, progress: null, display_name: null,
      }
      this.tinkerRuns.push(row)
      return { rows: [{ ...row }] }
    }
    if (text.startsWith('UPDATE tinker_runs SET status = ?, call_id = ? WHERE id = ? AND status = ?')) {
      const row = this.tinkerRuns.find(r => r.id === v[2] && r.status === v[3])
      if (row) Object.assign(row, { status: v[0], call_id: v[1] })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE tinker_runs SET progress = ? WHERE id = ? AND status IN')) {
      const row = this.tinkerRuns.find(r => r.id === v[1] && (r.status === 'reserved' || r.status === 'running'))
      // the same guard as the SQL: a record whose counter is not above the stored one does not replace it
      const seq = v[2]
      const storedSeq = row && row.progress ? (typeof row.progress === 'string' ? JSON.parse(row.progress) : row.progress).seq : undefined
      if (row && (seq === null || seq === undefined || !row.progress || storedSeq === undefined || storedSeq === null || Number(storedSeq) < Number(seq))) row.progress = v[0]
      return { rows: [] }
    }
    if (text.startsWith('UPDATE tinker_runs SET status = ?, reason = ?, cost_usd = ?, result = ?, progress = COALESCE(')) {
      assert.ok(text.includes("AND status IN ('reserved', 'running')"), 'a run may be closed only once')
      const [status, reason, cost_usd, result, progress, sampler_path, expires_at, id] = v
      const row = this.tinkerRuns.find(r => r.id === id && (r.status === 'reserved' || r.status === 'running'))
      if (!row) return { rows: [] }
      Object.assign(row, { status, reason, cost_usd, result, sampler_path, expires_at, finished_at: new Date().toISOString(), progress: progress ?? row.progress })
      return { rows: [{ ...row }] }
    }
    if (text.startsWith("SELECT * FROM tinker_runs WHERE status IN ('reserved', 'running') ORDER BY created_at ASC LIMIT 5")) {
      return { rows: this.tinkerRuns.filter(r => r.status === 'reserved' || r.status === 'running').slice(0, 5).map(r => ({ ...r })) }
    }
    if (text.startsWith("SELECT * FROM tinker_runs WHERE kind = 'rl' ORDER BY created_at DESC LIMIT 1")) {
      const rows = this.tinkerRuns.filter(r => r.kind === 'rl')
      return { rows: rows.length ? [{ ...rows[rows.length - 1] }] : [] }
    }
    if (text.startsWith('SELECT COUNT(*) AS n FROM tinker_runs WHERE spend_day = ?')) {
      const rlOnly = text.includes("AND kind = 'rl'")
      assert.ok(rlOnly || text.includes('AND kind IS NULL'), 'the count must say which kind it counts')
      const counted = this.tinkerRuns.filter(r => r.spend_day === v[0] && (['reserved', 'running', 'ok'].includes(r.status) || Number(r.cost_usd) > 0) && (rlOnly ? r.kind === 'rl' : (r.kind ?? null) === null))
      return { rows: [{ n: counted.length }] }
    }
    if (text.startsWith('UPDATE tinker_runs SET name_key = NULL')) return { rows: [] }
    if (text.startsWith('UPDATE tinker_runs SET display_name = ?')) {
      const row = this.tinkerRuns.find(r => r.id === v[2])
      if (row) Object.assign(row, { display_name: v[0], name_key: v[1] })
      return { rows: row ? [{ id: row.id }] : [] }
    }
    throw new Error(`unexpected query: ${text.slice(0, 160)}`)
  }
}

test('a run is reserved, started, followed step by step, and settled at the tokens the runner counted', async () => {
  configure({ LAB_TINKER_RL_PER_DAY: '3', LAB_TINKER_POLL_MAX_MS: '5000' })
  const plan = planFor(ask())
  const estimate = rl.estimateTinkerRl(plan.tinker_rl).max_cost_usd
  const measured = tinker.tinkerCostUsd(plan.tinker_rl.base_model, runnerOk().tokens)
  assert.ok(measured < estimate, 'the estimate is a ceiling')
  const sent = []
  const midway = { status: 'running', call_id: 'fc-rl-1', progress: progressRecord() }
  globalThis.fetch = fakeRunner(sent, [midway, midway, { status: 'done', result: runnerOk() }])
  const out = await rlRun.runTinkerRl(CTX, plan.tinker_rl, { maxWaitMs: 20_000, pollMs: 1 })
  assert.equal(out.status, 'ok', out.summary)
  assert.match(out.summary, /LAB-MEASURED held-out rubric score 0\.250 before training, 0\.750 after/)
  assert.match(out.summary, /estimated cost/)
  // what was sent: the run's own name, the tasks and rubric as data, the settings, a salt the model did not choose
  const start = sent.find(s => s.kind === 'start').body
  assert.equal(start.run_id, lab.tinkerRuns[0].slug)
  assert.deepEqual(Object.keys(start.rl).sort(), ['base_model', 'budget_usd', 'label', 'prices', 'rubric', 'samples', 'settings', 'split_salt', 'tasks', 'ttl_seconds'])
  assert.match(start.rl.split_salt, /^[0-9a-f]{32,64}$/)
  assert.ok(Math.abs(start.rl.budget_usd - estimate) < 1e-9)
  assert.ok(!JSON.stringify(start).includes(JOBS_TOKEN))
  // the progress was stored while it went, and the row ends as a finished RL run
  const row = lab.tinkerRuns[0]
  assert.equal(row.kind, 'rl')
  assert.equal(row.status, 'ok')
  assert.equal(row.sampler_path, SAMPLER)
  assert.ok(row.expires_at && Date.parse(row.expires_at) > Date.now() + 13 * 86400_000)
  const stored = rl.storedRlProgress(row.progress)
  assert.equal(stored.phase, 'done')
  assert.equal(stored.step, 10)
  assert.deepEqual(stored.means, runnerOk().step_means)
  assert.ok(sent.filter(s => s.kind === 'status').length >= 3)
  assert.ok(sent.filter(s => s.kind === 'status').every(s => new URL(s.url).searchParams.get('run_id') === row.slug || new URL(s.url).searchParams.get('call_id') === 'fc-rl-1'))
  // money: the estimate was set aside, then replaced by the measured tokens
  assert.equal(lab.spend('all').reserved_usd, 0)
  assert.ok(Math.abs(lab.spend('all').spent_usd - measured) < 1e-9)
  assert.equal(row.cost_usd, measured)
  assert.equal(lab.modelCalls.length, 1)
  assert.equal(lab.modelCalls[0].cost_source, 'estimate')
  // the evidence: a tool run that says what was measured, by whom, and that cost is an estimate
  const evidence = lab.toolRuns.find(t => t.tool === 'tinker_rl')
  assert.equal(evidence.status, 'ok')
  assert.equal(evidence.detail.kind, 'rl')
  assert.equal(evidence.detail.measured.score_before, 0.25)
  assert.equal(evidence.detail.measured.score_after, 0.75)
  assert.match(evidence.detail.measured.by, /the lab/)
  assert.match(evidence.detail.cost.basis, /estimate, not a billed amount/)
  assert.equal(evidence.detail.reward_hacking.flag, false)
  // the room plays it as a line on the ticket by the training rig
  const parsed = roomRuns.parseToolRuns([{ id: 'a', tool: 'tinker_rl', model: CTX.executorModelId, status: 'ok', created_at: new Date().toISOString(), request_summary: 'x', output_tail: evidence.output_tail, detail: evidence.detail }])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].kind, 'tinker_rl')
  assert.equal(parsed[0].resultLine, 'held-out score 0.25 to 0.75, measured by the lab')
  // a second run in the same epoch is refused, whatever its kind
  const again = await rlRun.runTinkerRl(CTX, plan.tinker_rl, { maxWaitMs: 1, pollMs: 1 })
  assert.equal(again.status, 'skipped')
  assert.match(again.summary, /already has a Tinker run/)
  assert.equal(lab.spend('all').reserved_usd, 0)
})

test('a run still going when the wait ends is collected by a later tick, and an unreadable progress record is dropped without harm', async () => {
  configure({ LAB_TINKER_POLL_MAX_MS: '1' })
  const plan = planFor(ask())
  const sent = []
  const garbled = { status: 'running', call_id: 'fc-rl-1', progress: { v: 1, phase: 'sampling', step: 99 } }
  globalThis.fetch = fakeRunner(sent, [garbled])
  const out = await rlRun.runTinkerRl(CTX, plan.tinker_rl, { maxWaitMs: 1, pollMs: 1 })
  assert.equal(out.status, 'started')
  const row = lab.tinkerRuns[0]
  assert.equal(row.status, 'running')
  assert.equal(row.progress, null)
  assert.ok(lab.spend('all').reserved_usd > 0)
  // the hourly tick asks again, stores the progress the runner gives now, and closes the run when it is done
  globalThis.fetch = fakeRunner(sent, [{ status: 'running', call_id: 'fc-rl-1', progress: progressRecord() }])
  assert.deepEqual(await runs.collectTinkerRuns(), [])
  assert.equal(rl.storedRlProgress(row.progress).step, 3)
  globalThis.fetch = fakeRunner(sent, [{ status: 'done', result: runnerOk() }])
  const closed = await runs.collectTinkerRuns()
  assert.deepEqual(closed.map(o => [o.tool, o.status]), [['tinker_rl', 'ok']])
  assert.equal(row.status, 'ok')
  assert.equal(lab.spend('all').reserved_usd, 0)
})

test('a run the runner refuses or loses settles correctly: a refusal costs what it measured, a lost run counts what was set aside', async () => {
  configure({ LAB_TINKER_POLL_MAX_MS: '1' })
  let plan = planFor(ask())
  globalThis.fetch = fakeRunner([], [{ status: 'done', result: { status: 'refused', reason: 'tasks[3] is too long', stage: 'tokens', tokens: { train: 0, eval: 0, sample_prompt: 0, sample_completion: 0 } } }])
  let out = await rlRun.runTinkerRl(CTX, plan.tinker_rl, { maxWaitMs: 1000, pollMs: 1 })
  assert.equal(out.status, 'failed')
  assert.match(out.summary, /refused by the runner/)
  assert.equal(lab.tinkerRuns[0].status, 'refused')
  assert.equal(lab.tinkerRuns[0].sampler_path, null)
  assert.equal(lab.spend('all').reserved_usd, 0)
  assert.equal(lab.spend('all').spent_usd, 0)
  // a result that says ok but has no saved adapter or no held-out scores is not an ok
  plan = planFor(ask())
  globalThis.fetch = fakeRunner([], [{ status: 'done', result: runnerOk({ sampler_path: 'tinker://x' }) }])
  out = await rlRun.runTinkerRl({ ...CTX, epochNumber: 42 }, plan.tinker_rl, { maxWaitMs: 1000, pollMs: 1 })
  assert.notEqual(out.status, 'ok')
  assert.equal(lab.tinkerRuns[1].sampler_path, null)
  // the runner is gone: what was set aside is what it cost
  globalThis.fetch = fakeRunner([], [{ status: 'failed', error: 'the run expired' }])
  const spentBefore = lab.spend('all').spent_usd
  out = await rlRun.runTinkerRl({ ...CTX, epochNumber: 43 }, plan.tinker_rl, { maxWaitMs: 1000, pollMs: 1 })
  assert.equal(out.status, 'error')
  assert.equal(lab.tinkerRuns[2].cost_usd, lab.tinkerRuns[2].reserved_usd)
  assert.ok(lab.spend('all').spent_usd > spentBefore)
  assert.equal(lab.spend('all').reserved_usd, 0)
})

test('the Reviewer must approve, and a run past the runs per day is refused with its reason stored', async () => {
  configure({ LAB_TINKER_RL_PER_DAY: '1' })
  const plan = planFor(ask())
  globalThis.fetch = fakeRunner([])
  let out = await deliver(plan, {})
  assert.equal(out[0].status, 'skipped')
  assert.match(out[0].summary, /Reviewer did not approve/)
  assert.equal(lab.tinkerRuns.length, 0)
  out = await deliver(plan, { tinker_rl: 'reject' })
  assert.equal(out[0].status, 'skipped')
  out = await deliver(plan)
  assert.notEqual(out[0].status, 'skipped')
  out = await deliver(plan, undefined, { ...CTX, epochNumber: 42 })
  assert.equal(out[0].status, 'skipped')
  assert.match(out[0].summary, /daily limit of 1 reached/)
  assert.equal(lab.tinkerRuns.length, 1)
})

test('the public record has the run and its progress, and no secret: no checkpoint, salt or call id', async () => {
  configure({ LAB_ENABLE_TINKER_NAMES: 'true' })
  const sent = []
  globalThis.fetch = fakeRunner(sent, [{ status: 'running', call_id: 'fc-rl-1', progress: progressRecord({ samples: [{ prompt: '<b>hi</b>', completion: 'x'.repeat(900), reward: 0.5 }] }) }])
  await rlRun.runTinkerRl(CTX, planFor(ask({ name: 'Adder' })).tinker_rl, { maxWaitMs: 1, pollMs: 1 })
  rlPublic.resetRlPracticeCache()
  let state = await rlPublic.rlPractice()
  assert.equal(state.enabled, true)
  const run = state.run
  assert.deepEqual(Object.keys(run).sort(), [
    'adapter', 'author_model', 'author_name', 'base_model', 'cost', 'created_at', 'cut_off', 'epoch', 'finished_at', 'hacking', 'held_out', 'kind', 'live', 'max_reward',
    'name', 'origin', 'progress', 'purpose', 'reason', 'rubric', 'settings', 'slug', 'status', 'task_set', 'tasks',
  ].sort())
  assert.equal(run.kind, 'rl')
  assert.equal(run.status, 'running')
  assert.equal(run.live, true)
  assert.equal(run.author_name, 'Claude Fable 5.2')
  assert.equal(run.task_set, 'Short sums')
  assert.deepEqual(run.tasks, { total: 20, held_out: 3, training: 17 })
  assert.equal(run.origin, 'written by the models')
  assert.ok(run.rubric.length === 2 && run.rubric.every(l => typeof l === 'string' && l.length <= 200))
  assert.equal(run.progress.step, 3)
  assert.ok(run.progress.samples[0].completion.length <= 160)
  assert.deepEqual(run.held_out, { before: 0.25, after: null, measured_by: 'the lab', tasks: 3 })
  assert.equal(run.hacking.flag, false)
  assert.match(run.cost.basis, /estimate/)
  assert.equal(run.talk, undefined, 'a run that is not finished has no adapter to talk to')
  const text = JSON.stringify(state)
  assert.ok(!text.includes('tinker://') && !text.includes(lab.tinkerRuns[0].split_salt) && !text.includes('fc-rl-1') && !text.includes(JOBS_TOKEN))
  assert.ok(!text.includes('—'))
  // finished: the held-out scores are the lab's, the adapter can be talked to while the visitor chat is on
  const row = lab.tinkerRuns[0]
  globalThis.fetch = fakeRunner(sent, [{ status: 'done', result: runnerOk() }])
  await runs.collectTinkerRuns()
  process.env.LAB_ENABLE_TRAINED_CHAT = 'true'
  process.env.LAB_ENABLE_LIVE_TRAINED = 'true'
  rlPublic.resetRlPracticeCache()
  state = await rlPublic.rlPractice()
  assert.equal(state.run.status, 'ok')
  assert.equal(state.run.live, false)
  assert.deepEqual(state.run.held_out, { before: 0.25, after: 0.75, measured_by: 'the lab', tasks: 3 })
  assert.equal(state.run.name, 'Adder')
  assert.equal(state.run.hacking.flag, false)
  const talkable = rlPublic.publicRlRun(row, new Date(), true)
  assert.equal(talkable.talk, `lab/${row.slug}`)
  assert.equal(rlPublic.publicRlRun(row, new Date(Date.now() + 30 * 86400_000), true).talk, undefined, 'an expired adapter cannot be talked to')
  assert.equal(rlPublic.publicRlRun(row, new Date(), false).talk, undefined)
  assert.ok(!JSON.stringify(state).includes('tinker://'))
})

test('with no run, or Tinker RL off, the public state says so and carries no run', async () => {
  configure()
  assert.deepEqual(await rlPublic.rlPractice(), { enabled: true, run: null })
  rlPublic.resetRlPracticeCache()
  process.env.LAB_ENABLE_TINKER_RL = 'false'
  assert.deepEqual(await rlPublic.rlPractice(), { enabled: false, off_reason: 'LAB_ENABLE_TINKER_RL is switched off', run: null })
  rlPublic.resetRlPracticeCache()
  delete process.env.LAB_ENABLE_TINKER_RL
  delete process.env.TINKER_JOBS_TOKEN
  const state = await rlPublic.rlPractice()
  assert.equal(state.enabled, false)
  assert.match(state.off_reason, /TINKER_JOBS_START_URL, TINKER_JOBS_STATUS_URL or TINKER_JOBS_TOKEN/)
  // a database that fails knows no run, and the state still answers
  rlPublic.resetRlPracticeCache()
  db.handler = () => { throw new Error('database down') }
  assert.deepEqual((await rlPublic.rlPractice()).run, null)
})

test('a run flagged for reward hacking says so in its record, and nothing stops', async () => {
  configure()
  const flagged = runnerOk({ step_means: [0.97, 0.98, 0.99, 0.99, 1, 1, 1, 1, 1, 1], step_frac_max: Array(10).fill(0.9), score_before: 0.5, score_after: 0.5 })
  globalThis.fetch = fakeRunner([], [{ status: 'done', result: flagged }])
  const out = await rlRun.runTinkerRl(CTX, planFor(ask()).tinker_rl, { maxWaitMs: 1000, pollMs: 1 })
  assert.equal(out.status, 'ok')
  assert.match(out.summary, /FLAG: the reward may be gamed/)
  const evidence = lab.toolRuns.find(t => t.tool === 'tinker_rl')
  assert.equal(evidence.detail.reward_hacking.flag, true)
  assert.ok(evidence.detail.reward_hacking.reasons.length >= 1)
  assert.equal(lab.tinkerRuns[0].status, 'ok', 'the adapter is kept and can be talked to')
  rlPublic.resetRlPracticeCache()
  assert.equal((await rlPublic.rlPractice()).run.hacking.flag, true)
})

// ===========================================================================
// The visitor chat
// ===========================================================================
test('the visitor chat lists an RL adapter with its rubric scores, higher is better', () => {
  const [adapter] = panel.parseAdapters({ adapters: [{
    slug: 'e41-0a1b2c3d', base_model: 'Qwen/Qwen3.5-4B', epoch: 41, author_name: 'Claude Fable 5.2', examples: 20, holdout_examples: 3,
    kind: 'rl', rl_score_before: 0.25, rl_score_after: 0.75, expires_at: '2026-12-01T00:00:00.000Z',
  }] })
  assert.equal(adapter.kind, 'rl')
  const d = panel.describeAdapter(adapter)
  assert.match(d.score, /Held-out rubric score 0\.25 before training, 0\.75 after, on 3 tasks the lab held out\. Measured by the lab\. Higher is better\./)
  assert.match(d.origin, /Practice by Reward \(reinforcement learning\) on 20 tasks and a rubric written by Claude Fable 5\.2/)
  assert.ok(!d.score.includes('loss'))
})

// ===========================================================================
// Inkling 2 Mini as a base model for RL, once the owner has added it to the list
// ===========================================================================
const MINI = 'thinkingmachines/Inkling-2-Mini'

test('an RL request may name Inkling 2 Mini only while it is on the list, and is estimated at its prices', () => {
  const both = ['Qwen/Qwen3.5-4B', MINI]
  const read = rl.normalizeTinkerRlRequest(ask({ base_model: MINI }), both)
  assert.ok('request' in read, read.error)
  assert.equal(read.request.base_model, MINI)
  // The default list does not hold it, and neither an unknown id nor a variant of it gets through a list that does.
  assert.match(rl.normalizeTinkerRlRequest(ask({ base_model: MINI })).error, /base_model must be one of: Qwen\/Qwen3\.5-4B/)
  for (const id of [`${MINI}:peft:262144`, 'thinkingmachines/Inkling-2-Small', 'made/up-model']) {
    assert.match(rl.normalizeTinkerRlRequest(ask({ base_model: id }), both).error, /base_model must be one of/, id)
  }
  // The estimate is computed from the model's own prices, and the largest request still sits under the per-run cap.
  const estimate = rl.estimateTinkerRl(read.request)
  assert.notEqual(estimate.max_cost_usd, rl.estimateTinkerRl(ok(ask())).max_cost_usd)
  const price = tinker.TINKER_PRICES[MINI]
  assert.ok(estimate.max_cost_usd >= tinker.tinkerCostUsd(MINI, { train: 1, eval: 0, sample_prompt: 0, sample_completion: 0 }) && price.train === 0.75)
  const biggest = rl.normalizeTinkerRlRequest(ask({ base_model: MINI, settings: { steps: 30, group_size: 16, tasks_per_step: 16, max_completion_tokens: 512 } }), both)
  assert.ok('request' in biggest, biggest.error)
  assert.ok(rl.estimateTinkerRl(biggest.request).max_cost_usd > 0)
})

// ===========================================================================
// Answers the token limit cut off: the counts, the flag, the record
// ===========================================================================
const COUNTS = { capped: [4, 0, 2], mean_tokens: [38.5, 12, 20.25], answers_before: 6, capped_before: 3 }

test('the counts of cut off answers in a progress record are read strictly: present, absent, malformed, out of bounds', () => {
  // present
  const p = rl.readRlProgress(progressRecord(COUNTS))
  assert.deepEqual(p.capped, [4, 0, 2])
  assert.deepEqual(p.mean_tokens, [38.5, 12, 20.3], 'a mean is kept to one decimal')
  assert.deepEqual([p.answers_before, p.capped_before, p.answers_after, p.capped_after], [6, 3, null, null])
  const done = rl.readRlProgress(progressRecord({ ...COUNTS, answers_after: 6, capped_after: 0 }))
  assert.deepEqual([done.answers_after, done.capped_after], [6, 0])
  // absent: a runner deployed before the counting existed reads exactly as it did, with "not said" in the new places
  const old = rl.readRlProgress(progressRecord())
  assert.deepEqual([old.capped, old.mean_tokens, old.answers_before, old.capped_before, old.answers_after, old.capped_after], [null, null, null, null, null, null])
  assert.deepEqual({ ...old, capped: undefined, mean_tokens: undefined, answers_before: undefined, capped_before: undefined, answers_after: undefined, capped_after: undefined, updated_at: '' },
    { ...p, capped: undefined, mean_tokens: undefined, answers_before: undefined, capped_before: undefined, answers_after: undefined, capped_after: undefined, updated_at: '' })
  // explicit nulls are "not said" too (this is how the lab's own stored record carries them)
  assert.equal(rl.readRlProgress(progressRecord({ capped: null, mean_tokens: null, answers_before: null, capped_before: null })).capped, null)
  // how many were graded, without how many were cut off, says nothing about the limit
  const half = rl.readRlProgress(progressRecord({ answers_before: 6 }))
  assert.deepEqual([half.answers_before, half.capped_before], [6, null])
  // the largest values a run can send are accepted
  const top = rl.readRlProgress(progressRecord({ group_size: 16, tasks_per_step: 16, attempts: [], capped: [256, 256, 256], mean_tokens: [512, 512, 512], answers_before: 120, capped_before: 120, answers_after: 120, capped_after: 120 }))
  assert.deepEqual([top.capped[0], top.mean_tokens[0], top.answers_after, top.capped_after], [256, 512, 120, 120])
  // malformed or out of bounds: the whole record is dropped, as for every other field
  for (const bad of [
    { capped: 'x' }, { capped: [4, 0] }, { capped: [4, 0, 2, 1] }, { capped: [4, 0, 2.5] }, { capped: [4, 0, -1] }, { capped: [4, 0, 33] }, { capped: [4, 0, '2'] }, { capped: {} },
    { mean_tokens: [38.5, 12] }, { mean_tokens: [38.5, 12, 513] }, { mean_tokens: [38.5, 12, -1] }, { mean_tokens: [38.5, 12, NaN] }, { mean_tokens: [38.5, 12, '20'] }, { mean_tokens: 7 },
    { answers_before: 121 }, { answers_before: -1 }, { answers_before: 2.5 }, { answers_before: '6' }, { capped_before: 7 }, { capped_before: -1 }, { capped_before: 1.5 },
    { answers_before: undefined, capped_before: 3 }, { answers_after: 6, capped_after: 7 }, { answers_after: 'x', capped_after: 0 }, { capped_after: 1 },
  ]) assert.equal(rl.readRlProgress(progressRecord({ ...COUNTS, ...bad })), null, JSON.stringify(bad))
  // the stored record comes back the same, counts and all, and stays inside its size at its largest
  assert.deepEqual(rl.storedRlProgress(JSON.stringify(p)), p)
  assert.deepEqual(rl.storedRlProgress(JSON.stringify(old)), old)
  const big = rl.readRlProgress(progressRecord({ step: 30, steps_planned: 30, group_size: 16, tasks_per_step: 16, means: Array(30).fill(0.5), frac_max: Array(30).fill(0.5), attempts: Array(16).fill(0.5),
    capped: Array(30).fill(256), mean_tokens: Array(30).fill(511.9), answers_before: 120, capped_before: 120, answers_after: 120, capped_after: 120 }))
  assert.ok(big && Buffer.byteLength(JSON.stringify(big)) <= rl.RL_PROGRESS_MAX_BYTES)
})

test('a new progress record with counts is newer than the one stored and an old lab would have read it too', () => {
  const stored = rl.readRlProgress(progressRecord({ seq: 7 }))
  const next = rl.readRlProgress(progressRecord({ ...COUNTS, seq: 8 }))
  assert.equal(rl.isNewerProgress(next, stored), true)
  // what an older build of the lab keeps of a new runner's record: every field it knows, none it does not
  const known = ['v', 'phase', 'step', 'steps_planned', 'group_size', 'tasks_per_step', 'max_reward', 'means', 'frac_max', 'attempts', 'samples', 'score_before', 'score_after', 'wall_seconds', 'steps_trained', 'seq']
  const asOldLabSees = Object.fromEntries(Object.entries(progressRecord(COUNTS)).filter(([k]) => known.includes(k)))
  assert.deepEqual({ ...rl.readRlProgress(asOldLabSees), updated_at: '' }, { ...rl.readRlProgress(progressRecord()), updated_at: '' })
})

test('the counts in the runner result are read strictly and a result without them is as before', () => {
  const full = rl.normalizeRlResult(runnerOk({ step_capped: [8, 4, 0, 0, 0, 0, 0, 0, 0, 0], step_mean_tokens: [40, 38.25, 12, 12, 12, 12, 12, 12, 12, 11.96], answers_before: 6, capped_before: 4, answers_after: 6, capped_after: 0 }))
  assert.equal(full.status, 'ok')
  assert.deepEqual(full.step_capped, [8, 4, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(full.step_mean_tokens, [40, 38.3, 12, 12, 12, 12, 12, 12, 12, 12])
  assert.deepEqual([full.answers_before, full.capped_before, full.answers_after, full.capped_after], [6, 4, 6, 0])
  // absent
  const old = rl.normalizeRlResult(runnerOk())
  assert.equal(old.status, 'ok')
  assert.deepEqual([old.step_capped, old.step_mean_tokens, old.answers_before, old.capped_before, old.answers_after, old.capped_after], [null, null, null, null, null, null])
  assert.deepEqual({ ...old, step_capped: 0, step_mean_tokens: 0 }, { ...full, step_capped: 0, step_mean_tokens: 0, answers_before: null, capped_before: null, answers_after: null, capped_after: null })
  // malformed or out of bounds: that count is "not said"; the run is still the run (its scores and its adapter are not thrown away)
  for (const [bad, field] of [
    [{ step_capped: [8, 4] }, 'step_capped'], [{ step_capped: Array(10).fill(257) }, 'step_capped'], [{ step_capped: Array(10).fill(0.5) }, 'step_capped'], [{ step_capped: 'x' }, 'step_capped'],
    [{ step_capped: Array(10).fill(-1) }, 'step_capped'], [{ step_mean_tokens: Array(10).fill(513) }, 'step_mean_tokens'], [{ step_mean_tokens: Array(9).fill(12) }, 'step_mean_tokens'],
    [{ step_mean_tokens: Array(10).fill('12') }, 'step_mean_tokens'], [{ capped_before: 7 }, 'capped_before'], [{ answers_before: 121 }, 'capped_before'], [{ answers_before: 121 }, 'answers_before'],
    [{ capped_after: -1 }, 'capped_after'], [{ answers_after: 2.5 }, 'answers_after'], [{ answers_before: null, capped_before: 2 }, 'capped_before'],
  ]) {
    const read = rl.normalizeRlResult(runnerOk({ step_capped: Array(10).fill(0), step_mean_tokens: Array(10).fill(12), answers_before: 6, capped_before: 4, answers_after: 6, capped_after: 0, ...bad }))
    assert.equal(read.status, 'ok', JSON.stringify(bad))
    assert.equal(read[field], null, `${JSON.stringify(bad)} leaves ${field} unsaid`)
  }
  // a run that failed part way keeps the counts it had
  const failed = rl.normalizeRlResult({ status: 'error', stage: 'train', error: 'x', step_means: [0.2], step_frac_max: [0], step_capped: [8], step_mean_tokens: [40], answers_before: 6, capped_before: 6, tokens: {} })
  assert.deepEqual([failed.status, failed.step_capped, failed.capped_before, failed.answers_after], ['error', [8], 6, null])
})

test('the cut off flag: more than a fifth of the untrained held-out answers at the limit, or fewer after than before; it blocks nothing', () => {
  const flag = (before, after) => rl.rlCutOffFlag({ before, after })
  const c = (capped, graded) => ({ capped, graded })
  assert.equal(rl.RL_CUT_SHARE, 0.2)
  // nothing counted, or nothing cut off: no flag
  assert.deepEqual(flag(null, null), { flag: false, cut_short_before: false, cut_off_fell: false, reasons: [], before: null, after: null })
  assert.equal(flag(c(0, 6), c(0, 6)).flag, false)
  assert.equal(flag(null, c(3, 6)).flag, false, 'without a count before training there is nothing to compare')
  // exactly a fifth is not more than a fifth; one more is
  assert.equal(flag(c(2, 10), c(2, 10)).flag, false)
  const many = flag(c(3, 10), c(3, 10))
  assert.deepEqual([many.flag, many.cut_short_before, many.cut_off_fell], [true, true, false])
  assert.deepEqual(many.reasons, ['many untrained held-out answers reached the token limit without finishing (3 of 10), so a change in the held-out score may come from answers no longer being cut off'])
  // the count fell: said once, by the stronger reason when both hold
  const fell = flag(c(1, 10), c(0, 10))
  assert.deepEqual([fell.flag, fell.cut_short_before, fell.cut_off_fell], [true, false, true])
  assert.deepEqual(fell.reasons, ['fewer held-out answers reached the token limit without finishing after training (1 of 10 before, 0 of 10 after), so part of a change in the held-out score may come from answers no longer being cut off'])
  const both = flag(c(6, 6), c(0, 6))
  assert.deepEqual([both.flag, both.cut_short_before, both.cut_off_fell, both.reasons.length], [true, true, true, 1])
  assert.match(both.reasons[0], /^many untrained held-out answers .*\(6 of 6\)/)
  // more cut off after than before is not this flag
  assert.equal(flag(c(1, 10), c(2, 10)).flag, false)
  // before training only (a run still going, or one that failed before its second scoring): the first sign can already be said,
  // and with no score after training the reason does not speak of a change in the score
  const early = flag(c(5, 6), null)
  assert.deepEqual([early.flag, early.cut_short_before, early.cut_off_fell], [true, true, false])
  assert.deepEqual(early.reasons, ['many untrained held-out answers reached the token limit without finishing (5 of 6), so the held-out score before training may be low because answers were cut off'])
  // the reasons say what is counted (an answer whose text was whole is counted too when its stop token did not fit)
  for (const reason of [...many.reasons, ...fell.reasons, ...early.reasons]) assert.ok(/reached the token limit without finishing/.test(reason) && !/were cut off by the token limit/.test(reason))
  // the counts are compared as shares, so a different number graded does not make a fall by itself
  assert.equal(flag(c(1, 10), c(1, 10)).flag, false)
  assert.equal(flag(c(2, 20), c(1, 10)).flag, false)
  // rlCutOff makes the pair only from two numbers that fit together
  assert.deepEqual(rl.rlCutOff(6, 3), { graded: 6, capped: 3 })
  for (const [a, b] of [[null, null], [6, null], [null, 3], [6, 7], [0, 0], ['6', 3], [121, 3], [6, -1], [6, 1.5]]) assert.equal(rl.rlCutOff(a, b), null, `${a} ${b}`)
  // the two tools say the same thing the same way: the lesson's words for the same two signs (tinker-tutor.ts, tutorFlags)
  const tutorSource = readFileSync(join(root, 'api/_lib/tinker-tutor.ts'), 'utf8')
  assert.ok(tutorSource.includes('many untrained answers were cut off by the token limit or came back empty ('))
  assert.ok(tutorSource.includes('fewer answers were cut off by the token limit or came back empty after training ('))
  for (const reason of [...many.reasons, ...fell.reasons]) assert.ok(!/[—–]/.test(reason))
})

test('the tool run line and the stored record say what was cut off only where something was, and carry the flag', async () => {
  const hacking = { flag: false, reasons: [] }
  const line = (extra = {}) => rl.describeTinkerRl(rl.normalizeRlResult(runnerOk(extra)), 'Qwen/Qwen3.5-4B', 'e3-0a1b2c3d', 0.05, '2026-12-10T00:00:00Z', null, hacking)
  const plain = line()
  // a runner that sends no count, and a run with nothing cut off, read word for word the same
  assert.equal(line({ answers_before: 6, capped_before: 0, answers_after: 6, capped_after: 0 }), plain)
  assert.ok(!/token limit|cut off/.test(plain))
  const cut = line({ answers_before: 6, capped_before: 4, answers_after: 6, capped_after: 0 })
  assert.match(cut, /on 3 tasks the lab held out; held-out answers that reached the token limit without finishing: 4 of 6 before training, 0 of 6 after; 10 of 10 steps/)
  assert.match(cut, /; FLAG: a change in the held-out score may come from answers no longer being cut off \(see the record\); adapter lab\/e3-0a1b2c3d/)
  const small = line({ answers_before: 10, capped_before: 1, answers_after: 10, capped_after: 1 })
  assert.match(small, /1 of 10 before training, 1 of 10 after/)
  assert.ok(!small.includes('FLAG'), 'counted and shown, and not flagged: a tenth, and it did not fall')
  // the whole run: the count reaches the stored result, the evidence, the public record and the final progress
  configure()
  const counted = runnerOk({ step_capped: [8, 4, 0, 0, 0, 0, 0, 0, 0, 0], step_mean_tokens: [40, 38, 12, 12, 12, 12, 12, 12, 12, 12], answers_before: 6, capped_before: 4, answers_after: 6, capped_after: 0 })
  globalThis.fetch = fakeRunner([], [{ status: 'done', result: counted }])
  const out = await rlRun.runTinkerRl(CTX, planFor(ask()).tinker_rl, { maxWaitMs: 1000, pollMs: 1 })
  assert.equal(out.status, 'ok', 'a flag blocks nothing')
  assert.match(out.summary, /FLAG: a change in the held-out score may come from answers no longer being cut off/)
  const evidence = lab.toolRuns.find(t => t.tool === 'tinker_rl')
  assert.equal(evidence.detail.cut_off.flag, true)
  assert.deepEqual([evidence.detail.cut_off.before, evidence.detail.cut_off.after], [{ graded: 6, capped: 4 }, { graded: 6, capped: 0 }])
  assert.deepEqual([evidence.detail.measured.answers_before, evidence.detail.measured.reached_token_limit_before, evidence.detail.measured.reached_token_limit_after], [6, 4, 0])
  assert.deepEqual(evidence.detail.training.answers_at_token_limit_per_step, [8, 4, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(evidence.detail.reward_hacking.flag, false, 'the two flags are separate')
  const row = lab.tinkerRuns[0]
  const storedResult = typeof row.result === 'string' ? JSON.parse(row.result) : row.result
  assert.deepEqual([storedResult.step_capped.length, storedResult.capped_before, storedResult.answers_after], [10, 4, 6])
  rlPublic.resetRlPracticeCache()
  const run = (await rlPublic.rlPractice()).run
  assert.equal(run.status, 'ok')
  assert.deepEqual(run.cut_off, {
    flag: true, cut_short_before: true, cut_off_fell: true,
    reasons: ['many untrained held-out answers reached the token limit without finishing (4 of 6), so a change in the held-out score may come from answers no longer being cut off'],
    before: { graded: 6, capped: 4 }, after: { graded: 6, capped: 0 },
  })
  assert.deepEqual(run.progress.capped, [8, 4, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(run.progress.mean_tokens.slice(0, 3), [40, 38, 12])
  assert.deepEqual([run.progress.answers_before, run.progress.capped_before, run.progress.answers_after, run.progress.capped_after], [6, 4, 6, 0])
  assert.equal(run.hacking.flag, false)
})

test('a run that fails because every answer reached the token limit says so in its line and its record, without speaking of a change in the score', async () => {
  // What the corrected reading makes likely on Inkling with a small limit: every answer reads as empty, every reward in a
  // group is equal, no step trains, and the runner returns an error with the counts still in its result.
  const noStep = 'no step trained the model: in every step every answer to a task earned the same reward, so there was nothing to learn from'
  const failed = {
    status: 'error', stage: 'train', error: noStep, n_tasks: 20, n_train: 17, n_holdout: 3, steps_planned: 4, steps_done: 4, steps_trained: 0, max_reward: 1,
    score_before: 0, step_means: [0, 0, 0, 0], step_frac_max: [0, 0, 0, 0], step_capped: [16, 16, 16, 16], step_mean_tokens: [40, 40, 40, 40],
    answers_before: 6, capped_before: 6, tokens: { train: 0, eval: 0, sample_prompt: 900, sample_completion: 2800 },
  }
  const hacking = { flag: false, reasons: [] }
  const read = rl.normalizeRlResult(failed)
  assert.equal(read.status, 'error')
  // the line itself, with and without the number of answers a step samples
  assert.equal(rl.describeTinkerRl(read, 'Qwen/Qwen3.5-4B', null, 0.001, null, null, hacking, undefined, 16),
    `error at train: ${noStep}; answers that reached the token limit without finishing: 6 of 6 held-out before training, 16 of 16 in the last step (step 4); estimated cost $0.0010 (token counts at Tinker's published prices of ${tinker.TINKER_PRICE_TABLE_DATE}, not a billed amount)`)
  assert.match(rl.describeTinkerRl(read, 'Qwen/Qwen3.5-4B', null, 0.001, null, null, hacking), /6 of 6 held-out before training, 16 in the last step \(step 4\); estimated cost/)
  // a failed or refused run with nothing counted, or nothing at the limit, reads word for word as it did
  const plainError = rl.normalizeRlResult({ status: 'error', stage: 'train', error: noStep, tokens: {} })
  const asBefore = `error at train: ${noStep}; estimated cost $0.0010 (token counts at Tinker's published prices of ${tinker.TINKER_PRICE_TABLE_DATE}, not a billed amount)`
  assert.equal(rl.describeTinkerRl(plainError, 'Qwen/Qwen3.5-4B', null, 0.001, null, null, hacking, undefined, 16), asBefore)
  assert.equal(rl.describeTinkerRl(rl.normalizeRlResult({ ...failed, step_capped: [0, 0, 0, 0], capped_before: 0 }), 'Qwen/Qwen3.5-4B', null, 0.001, null, null, hacking, undefined, 16), asBefore)
  assert.equal(rl.rlCutOffClause(plainError), '')
  const refused = rl.normalizeRlResult({ status: 'refused', stage: 'tokens', reason: 'tasks[3] is too long', tokens: {} })
  assert.match(rl.describeTinkerRl(refused, 'Qwen/Qwen3.5-4B', null, 0, null, null, hacking), /^refused by the runner \(tokens\): tasks\[3\] is too long; estimated cost/)
  assert.match(rl.describeTinkerRl(rl.normalizeRlResult({ status: 'refused', stage: 'train', reason: 'stopped', tokens: {}, answers_before: 6, capped_before: 2 }), 'Qwen/Qwen3.5-4B', null, 0, null, null, hacking),
    /^refused by the runner \(train\): stopped; answers that reached the token limit without finishing: 2 of 6 held-out before training; estimated cost/)
  // the whole run: the line the models read next epoch, the stored evidence and the public record
  configure()
  globalThis.fetch = fakeRunner([], [{ status: 'done', result: failed }])
  const out = await rlRun.runTinkerRl(CTX, planFor(ask({ settings: { group_size: 8, tasks_per_step: 2, steps: 4 } })).tinker_rl, { maxWaitMs: 1000, pollMs: 1 })
  assert.equal(out.status, 'error')
  assert.match(out.summary, /nothing to learn from; answers that reached the token limit without finishing: 6 of 6 held-out before training, 16 of 16 in the last step \(step 4\); estimated cost/)
  assert.ok(!/a change in the held-out score/.test(out.summary))
  const evidence = lab.toolRuns.find(t => t.tool === 'tinker_rl')
  assert.deepEqual(evidence.detail.cut_off.reasons, ['many untrained held-out answers reached the token limit without finishing (6 of 6), so the held-out score before training may be low because answers were cut off'])
  rlPublic.resetRlPracticeCache()
  const run = (await rlPublic.rlPractice()).run
  assert.deepEqual([run.cut_off.flag, run.cut_off.before, run.cut_off.after], [true, { graded: 6, capped: 6 }, null])
  assert.ok(run.cut_off.reasons.every(r => !/a change in the held-out score/.test(r)), 'a run with no score after training has no change to explain')
  assert.deepEqual(run.progress.capped, [16, 16, 16, 16])
})

test('a finished run whose step counts do not fit its own settings keeps its record, with those counts unsaid', () => {
  const row = { settings: { group_size: 4, tasks_per_step: 2 } }
  // 20 is a count some run could have (at most 256), and more than the 8 answers a step of this run samples
  const odd = rl.normalizeRlResult(runnerOk({ step_capped: [20, 8, 0, 0, 0, 0, 0, 0, 0, 0], step_mean_tokens: Array(10).fill(12), answers_before: 6, capped_before: 4, answers_after: 6, capped_after: 0 }))
  assert.deepEqual([odd.status, odd.step_capped[0]], ['ok', 20])
  const kept = rlRun.finalRlProgress(row, odd)
  assert.ok(kept, 'the finished record is not dropped over one count')
  assert.equal(kept.capped, null)
  assert.deepEqual([kept.phase, kept.means.length, kept.mean_tokens.length, kept.answers_before, kept.capped_before, kept.capped_after], ['done', 10, 10, 6, 4, 0])
  // counts that fit are kept as they were
  const fits = rlRun.finalRlProgress(row, rl.normalizeRlResult(runnerOk({ step_capped: [8, 4, 0, 0, 0, 0, 0, 0, 0, 0] })))
  assert.deepEqual(fits.capped, [8, 4, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(rlRun.finalRlProgress(row, rl.normalizeRlResult(runnerOk())).capped, null)
})

test('the public record of a run from a runner that sends no counts has an empty cut off part, and one still going shows what it has', async () => {
  configure()
  globalThis.fetch = fakeRunner([], [{ status: 'done', result: runnerOk() }])
  await rlRun.runTinkerRl(CTX, planFor(ask()).tinker_rl, { maxWaitMs: 1000, pollMs: 1 })
  rlPublic.resetRlPracticeCache()
  const old = (await rlPublic.rlPractice()).run
  assert.deepEqual(old.cut_off, { flag: false, cut_short_before: false, cut_off_fell: false, reasons: [], before: null, after: null })
  assert.deepEqual([old.progress.capped, old.progress.mean_tokens], [null, null])
  // a run that is still going: the counts of the baseline are already in its progress record
  const row = { ...lab.tinkerRuns[0], status: 'running', result: null, progress: rl.readRlProgress(progressRecord({ ...COUNTS, answers_before: 6, capped_before: 5 })) }
  const going = rlPublic.publicRlRun(row, new Date(), false)
  assert.deepEqual([going.cut_off.flag, going.cut_off.before, going.cut_off.after], [true, { graded: 6, capped: 5 }, null])
  assert.deepEqual(going.progress.capped, [4, 0, 2])
})

// ===========================================================================
// What the models are told about Inkling's thinking passage
// ===========================================================================
const INKLING_MEASURED = 'Measured on 26 November 2026, on one question at the lowest thinking effort: of eight answers the lab sampled from the untrained thinkingmachines/Inkling-2-Mini, the four that finished each began with a thinking passage of 34 to 49 tokens before a one word answer; max_completion_tokens counts that passage. The lab\'s runner reads an answer whose limit falls inside the passage as empty, and in the lab\'s one test, a Tinker training run, an adapter of that model trained on written examples answered with no thinking passage; the lab has not measured this for an adapter from an RL run, so a before and after comparison on it may also compare thinking with not thinking.'

test('the RL note and the Reviewer\'s line carry the measured Inkling facts only while Inkling is offered', () => {
  configure()
  const without = rl.tinkerRlNote({ perDay: 2 })
  assert.ok(!/Inkling|26 November|thinking/.test(without), 'a lab without Inkling reads what it read before')
  process.env.LAB_TINKER_BASE_MODELS = `Qwen/Qwen3.5-4B,${MINI}`
  const withIt = rl.tinkerRlNote({ perDay: 2 })
  assert.ok(withIt.includes(` ${INKLING_MEASURED} A request that breaks any of this is refused whole`))
  // nothing else in the paragraph moved: taking the sentences and the model's name out gives the old paragraph
  assert.equal(withIt.replace(` ${INKLING_MEASURED}`, '').replace(`, ${MINI}`, ''), without)
  assert.equal(rl.tinkerRlNote({ perDay: 2, names: true, chat: true }).split(INKLING_MEASURED).length, 2, 'said once')
  // what was measured that day is one sentence; how the runner reads a cut answer is not part of the measurement
  const [measuredSentence, rest] = INKLING_MEASURED.split('. ')
  assert.equal(INKLING_MEASURED.split('. ').length, 2, 'two sentences')
  assert.ok(measuredSentence.startsWith('Measured on 26 November 2026') && !/empty|runner/.test(measuredSentence))
  assert.ok(rest.startsWith('The lab\'s runner reads an answer whose limit falls inside the passage as empty'))
  // the one test was a training run on written examples, not an RL run: the note says so and does not state the consequence as a fact
  for (const part of ['in the lab\'s one test, a Tinker training run,', 'the lab has not measured this for an adapter from an RL run', 'may also compare thinking with not thinking']) assert.ok(rest.includes(part), part)
  assert.ok(!/it also compares/.test(INKLING_MEASURED))
  // a fact with its date and its size; no setting is recommended and no model is ranked
  for (const steer of [/\bprefer\b/i, /\bavoid\b/i, /\bshould\b/i, /\brecommend/i, /\bbetter\b/i, /\bworse\b/i, /\buse at least\b/i, /\bset max_completion_tokens\b/i, /\binstead of Inkling\b/i, /\bchoose\b/i, /[—–]/]) {
    assert.ok(!steer.test(INKLING_MEASURED), String(steer))
  }
  // the Reviewer: only for a request on Inkling, and the line still ends where the section closes it
  const both = ['Qwen/Qwen3.5-4B', MINI]
  const onInkling = prompts.tinkerRlReviewFacts(rl.normalizeTinkerRlRequest(ask({ base_model: MINI }), both).request).line
  assert.ok(onInkling.endsWith(`is for you to judge. ${INKLING_MEASURED.replace(/\.$/, '')}`))
  assert.ok(prompts.reviewerToolSection({ tinker_rl: { line: onInkling } }).includes('thinking with not thinking.\n'))
  const onQwen = prompts.tinkerRlReviewFacts(ok(ask())).line
  assert.ok(!/Inkling-2-Mini wrote|26 November/.test(onQwen), 'a request on another base model is told nothing of it')
  assert.ok(onQwen.endsWith('is for you to judge'))
  // the same request line with Inkling no longer offered: nothing is said
  delete process.env.LAB_TINKER_BASE_MODELS
  assert.ok(!/26 November/.test(prompts.tinkerRlReviewFacts(rl.normalizeTinkerRlRequest(ask({ base_model: MINI }), both).request).line))
  assert.equal(tinker.inklingThinkingFacts('rl'), '')
  process.env.LAB_TINKER_BASE_MODELS = MINI
  assert.equal(tinker.inklingThinkingFacts('rl'), INKLING_MEASURED)
  assert.equal(tinker.inklingThinkingFacts('rl', 'Qwen/Qwen3.5-4B'), '')
  assert.equal(tinker.inklingReviewFacts('rl', 'Qwen/Qwen3.5-4B'), '')
  // the whole tool line the Executor reads, through the prompt builder
  const line = prompts.toolLines(toolsConfig.toolConfig()).split('\n').find(l => l.includes('Tinker RL'))
  assert.ok(line.includes(INKLING_MEASURED))
})

// ===========================================================================
// The owner's probe of the chat endpoint builds the request this server builds
// ===========================================================================
test('the raw probe in the runner and tinker-chat.ts build the same request for an untrained base model', async () => {
  const chat = await load('api/_lib/tinker-chat.js')
  const shared = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'chat-probe-request.json'), 'utf8'))
  assert.equal(chat.TINKER_CHAT_URL, shared.url)
  assert.deepEqual([...new Set(shared.cases.map(c => c.base_model))].sort(), Object.keys(tinker.TINKER_PRICES).sort(), 'every base model the lab prices is in the shared cases')
  for (const c of shared.cases) {
    const body = chat.tinkerChatBody({ baseModel: c.base_model, messages: [{ role: 'user', content: shared.prompt }], maxTokens: c.max_tokens, temperature: shared.temperature, timeoutMs: 1 })
    assert.deepEqual(body, c.body, `${c.base_model} at ${c.max_tokens}`)
    assert.deepEqual(Object.keys(body), Object.keys(c.body), 'the same fields in the same order')
    assert.equal(JSON.stringify(body), JSON.stringify(c.body))
    assert.equal(body.reasoning_effort, chat.tinkerReasoningEffort(c.base_model))
  }
  assert.equal(shared.cases.find(c => c.base_model === MINI).body.reasoning_effort, 'none')
  assert.equal(shared.cases.find(c => c.base_model === 'Qwen/Qwen3.5-4B').body.reasoning_effort, false)
  // what really leaves this server for such a call is that body, to that address, with the key in the header only
  process.env.TINKER_API_KEY = 'tml-test-only-not-a-real-tinker-key-0000'
  const sent = []
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), options })
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'apple' } }], usage: { prompt_tokens: 31, completion_tokens: 38 } }), { headers: { 'content-type': 'application/json' } })
  }
  const first = shared.cases[0]
  await chat.callTinkerChat({ baseModel: first.base_model, messages: [{ role: 'user', content: shared.prompt }], maxTokens: first.max_tokens, temperature: shared.temperature, timeoutMs: 1000 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, shared.url)
  assert.equal(sent[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(sent[0].options.body), first.body)
  assert.deepEqual(sent[0].options.headers, { Authorization: 'Bearer tml-test-only-not-a-real-tinker-key-0000', 'Content-Type': 'application/json' })
  // the runner's side of the same file: its address, its two limits, its prompt and its rule are the ones in the shared cases
  const runner = readFileSync(join(root, 'modal', 'tinker_jobs.py'), 'utf8')
  assert.ok(runner.includes(`TINKER_CHAT_URL = "${shared.url}"`))
  assert.ok(runner.includes(`RAW_PROBE_PROMPT = "${shared.prompt}"`))
  assert.ok(runner.includes(`RAW_PROBE_CAPS = (${shared.caps.join(', ')})`))
  assert.ok(runner.includes(`RAW_PROBE_TEMPERATURE = ${shared.temperature.toFixed(1)}`))
  assert.ok(runner.includes('return "none" if isinstance(base_model, str) and base_model in RENDERERS and base_model.startswith("thinkingmachines/") else False'))
  assert.ok(runner.includes('headers={**CHAT_PROBE_HEADERS, "Authorization": "Bearer %s" % key, "Content-Type": "application/json"}'))
  // The lab server names two headers and leaves the rest to Node's fetch, which adds these four. The probe sends the same
  // four, because Python's own User-Agent was refused with HTTP 403 "error code: 1010" on 26 November 2026. If the server
  // ever sets a User-Agent of its own, this fails and the probe must follow.
  assert.ok(runner.includes('CHAT_PROBE_HEADERS = {"Accept": "*/*", "Accept-Language": "*", "Sec-Fetch-Mode": "cors", "User-Agent": "node"}'))
  const server = readFileSync(join(root, 'api', '_lib', 'tinker-chat.ts'), 'utf8')
  assert.ok(server.includes("headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },"))
  assert.equal(/user-agent/i.test(server), false)
  // the ids the runner trains are the ids this server prices, so "a model the lab prices" means the same on both sides
  const renderers = [...runner.matchAll(/^    "([A-Za-z0-9./-]+)": "[a-z0-9_]+",$/gm)].map(m => m[1])
  assert.deepEqual(renderers.sort(), Object.keys(tinker.TINKER_PRICES).sort())
  // and nothing on this server or the page names the probe
  for (const file of [...readdirSync(join(root, 'api', '_lib')).map(f => join('api', '_lib', f)), 'modal/web_endpoints.py']) {
    assert.ok(!readFileSync(join(root, file), 'utf8').includes('raw_probe'), file)
  }
})
