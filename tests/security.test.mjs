import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// Execute the actual API modules without creating a database or using a provider.
const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-api-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')
function compile(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) compile(path)
    else if (path.endsWith('.ts')) {
      const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText
      const destination = join(build, path.replace(/\.ts$/, '.js'))
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, output)
    }
  }
}
compile('api')
for (const path of ['src/systems/TranscriptPanel.ts', 'src/shared/types.ts', 'src/scene/colors.ts']) {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from '([^']+)'/g, (whole, specifier) => specifier.startsWith('.') ? `from '${specifier}.js'` : whole)
  const destination = join(build, path.replace(/\.ts$/, '.js'))
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, output)
}
const load = path => import(pathToFileURL(join(build, path)).href)
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
after(() => {
  process.env = originalEnv
  globalThis.fetch = originalFetch
  rmSync(build, { recursive: true, force: true })
})
const operator = 'test-only-operator-secret-0000000000000000'
const cron = 'test-only-scheduler-secret-000000000000000'
process.env.LAB_OPERATOR_SECRET = operator
process.env.CRON_SECRET = cron
process.env.AI_AGENT_GITHUB_TOKEN = 'test-only-not-a-provider-token'
process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'
process.env.RESEARCH_RUNNER_TOKEN = 'test-only-runner-token'
process.env.RESEARCH_RUNNER_START_URL = 'https://runner.example/start'
process.env.RESEARCH_RUNNER_STATUS_URL = 'https://runner.example/status'
delete process.env.OPENROUTER_API_KEY
delete process.env.POSTGRES_URL
delete process.env.LAB_ENABLE_CODE_WRITES

function response() {
  return {
    code: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}

// Every file under api/ outside _lib is a Vercel route. Routes are discovered
// from the filesystem, so a new route is checked without editing this test.
// Only the observer endpoints below may answer anonymous requests.
const PUBLIC_ROUTES = {
  'experiment/index': ['GET'],              // without ?debug=true
  'experiment/code-contributions': ['GET'],
  'experiment/wildcard-transcripts': ['GET'],
}
function discoverRoutes(directory = 'api') {
  const found = []
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '_lib') found.push(...discoverRoutes(path))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(path.slice('api/'.length).replace(/\.ts$/, '').split(/[\\/]/).join('/'))
    }
  }
  return found.sort()
}

test('anonymous operator requests stop before database, model, or compute work', async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected outbound request') }
  const routes = discoverRoutes()
  for (const known of ['epoch/run', 'epoch/tick', 'experiment/shatter', 'north/run', 'sprites/exec', 'sprites/index']) {
    assert.ok(routes.includes(known), `route discovery missed ${known}`)
  }
  for (const route of Object.keys(PUBLIC_ROUTES)) assert.ok(routes.includes(route), `public allowlist names a missing route: ${route}`)
  const cases = []
  for (const route of routes) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const isPublic = (PUBLIC_ROUTES[route] || []).includes(method)
      if (!isPublic) cases.push({ route, method, query: {}, allowed: route in PUBLIC_ROUTES ? [401, 405] : [401] })
    }
  }
  cases.push({ route: 'experiment/index', method: 'GET', query: { debug: 'true' }, allowed: [401] })
  for (const { route, method, query, allowed } of cases) {
    const { default: handler } = await load(`api/${route}.js`)
    for (const authorization of [undefined, 'Bearer wrong', [`Bearer ${operator}`]]) {
      const res = response()
      await handler({ method, headers: { authorization }, query, body: {} }, res)
      assert.ok(allowed.includes(res.code), `${route} ${method} ${JSON.stringify(query)}: anonymous request got ${res.code}`)
      if (res.code === 401) assert.equal(res.headers['Cache-Control'], 'no-store')
    }
  }
})

test('missing configuration fails closed and scheduler/operator secrets are separate', async () => {
  const { requireBearer } = await load('api/_lib/auth.js')
  const request = token => ({ headers: { authorization: `Bearer ${token}` } })
  delete process.env.LAB_OPERATOR_SECRET
  let res = response()
  assert.equal(requireBearer(request(operator), res), false)
  assert.equal(res.code, 503)
  process.env.LAB_OPERATOR_SECRET = operator
  assert.equal(requireBearer(request(operator), response()), true)
  assert.equal(requireBearer(request(cron), response()), false)
  assert.equal(requireBearer(request(cron), response(), 'CRON_SECRET'), true)
  assert.equal(requireBearer(request(operator), response(), 'CRON_SECRET'), false)
})

test('runner requests keep credentials out of URLs and reject unknown statuses', async () => {
  process.env.RESEARCH_RUNNER_TOKEN = 'test-only-runner-token'
  process.env.RESEARCH_RUNNER_START_URL = 'https://runner.example/start'
  process.env.RESEARCH_RUNNER_STATUS_URL = 'https://runner.example/status'
  const { startResearchRun, pollResearchRun } = await load('api/_lib/research.js')
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify(String(url).includes('/start') ? { call_id: 'example-call' } : { error: 'unauthorized' }))
  }
  assert.equal(await startResearchRun('example training source', 300), 'example-call')
  assert.equal((await pollResearchRun('example-call')).status, 'failed')
  for (const { url, options } of calls) {
    assert.equal(url.includes('token'), false)
    assert.equal(options.headers.Authorization, 'Bearer test-only-runner-token')
    assert.equal((options.body || '').includes('test-only-runner-token'), false)
  }
})

test('all returned workflows must succeed, and unavailable CI never reports success', async () => {
  const { waitForCIRun } = await load('api/_lib/github-repo.js')
  const run = (id, conclusion, status = 'completed') => ({ id, workflow_id: id, conclusion, status, head_sha: 'test-head', head_repository: { full_name: 'test-owner/AI-Agent' }, event: 'pull_request' })
  const check = async runs => {
    globalThis.fetch = async () => new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }))
    return waitForCIRun('test-head', 5, 0)
  }
  delete process.env.LAB_REQUIRED_CI_WORKFLOW_IDS
  await assert.rejects(check([run(1, 'success')]), /LAB_REQUIRED_CI_WORKFLOW_IDS/)
  process.env.LAB_REQUIRED_CI_WORKFLOW_IDS = '1,2'
  assert.equal((await check([run(3, 'success')])).conclusion, 'timeout')
  assert.equal((await check([{ ...run(1, 'success'), head_sha: 'other-sha' }])).conclusion, 'none')
  assert.equal((await check([{ ...run(1, 'success'), head_repository: { full_name: 'attacker/fork' } }])).conclusion, 'none')
  assert.equal((await check([{ ...run(1, 'success'), event: 'workflow_dispatch' }])).conclusion, 'none')
  assert.equal((await check([run(1, 'success')])).conclusion, 'timeout')
  assert.equal((await check([run(1, 'success'), run(2, 'success')])).conclusion, 'success')
  assert.equal((await check([run(1, 'success'), run(2, 'failure')])).conclusion, 'failure')
  assert.equal((await check([run(1, 'success'), run(2, null, 'in_progress')])).conclusion, 'timeout')
  assert.equal((await check([])).conclusion, 'none')
})

test('autonomous research writes remain available using a separate repository token', async () => {
  const { putResearchFile } = await load('api/_lib/research.js')
  delete process.env.RESEARCH_GITHUB_TOKEN
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected request') }
  await assert.rejects(putResearchFile('train.py', '# test experiment', 'test'), /RESEARCH_GITHUB_TOKEN/)
  assert.equal(calls, 0)
  process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
  let sent
  globalThis.fetch = async (url, options) => { sent = { url, options }; return new Response('{}') }
  await putResearchFile('train.py', '# test experiment', 'test', 'previous-file-sha')
  assert.equal(sent.options.method, 'PUT')
  assert.equal(sent.options.headers.Authorization, 'Bearer test-only-research-repository-token')
  assert.equal(JSON.parse(sent.options.body).branch, 'main')
})

test('generated code cannot alter workflow or dependency files, and writes require opt-in', async () => {
  const { assertContributionPath } = await load('api/_lib/contribution-policy.js')
  for (const path of ['.github/workflows/ci.yml', 'package.json', 'src/../package.json', 'tests/.env', 'src\\payload.ts', '/src/a.ts']) {
    assert.throws(() => assertContributionPath(path), undefined, path)
  }
  for (const path of ['src/agent.ts', 'tests/agent.test.ts', 'docs/experiment.md', 'README.md']) {
    assert.doesNotThrow(() => assertContributionPath(path))
  }
  globalThis.fetch = async () => { throw new Error('Writes must remain disabled') }
  const { contributeCode } = await load('api/_lib/code-contribution.js')
  const result = await contributeCode({ authorModelId: 'test-model', branchName: 'test', title: 'test', description: 'test', review: { mode: 'approved' } })
  assert.equal(result.merged, false)
  assert.equal(result.cost, 0)
})

test('the merge request pins the commit that was checked', async () => {
  const { mergePullRequest } = await load('api/_lib/github-repo.js')
  let mergeBody
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/merge')) {
      mergeBody = JSON.parse(options.body)
      return new Response('{}')
    }
    return new Response('{"mergeable":true}')
  }
  await mergePullRequest(7, 'test contribution', 'checked-commit-sha')
  assert.equal(mergeBody.sha, 'checked-commit-sha')
})

test('persisted model text stays text in transcript bodies and attributes', async () => {
  const { TranscriptPanel } = await load('src/systems/TranscriptPanel.js')
  // Exercise the actual rendering methods without constructing the surrounding UI.
  const panel = Object.create(TranscriptPanel.prototype)
  panel.wildcardTurns = []
  const payload = '\"><img src=x onerror="globalThis.xss=1">'
  const outputs = {
    planner: { direction: payload, rationale: payload, suggested_focus: payload },
    executor: { mutations: [{ type: payload, target: payload, rationale: payload }] },
    challenger: { challenges: [{ issue: payload, severity: payload, suggested_fix: payload }], overall_risk: payload, recommendation: payload },
    reviewer: { decisions: [{ verdict: payload, reason: payload }], epoch_summary: payload },
    rebuttal: { text: payload },
  }
  for (const [role, output] of Object.entries(outputs)) {
    const html = panel.formatOutput(role, output)
    assert.equal(html.includes('<img src=x'), false, role)
    assert.equal(html.includes('<script'), false, role)
    assert.equal(html.includes('&lt;img'), true, role)
  }
  assert.match(panel.formatOutput('challenger', outputs.challenger), /class="challenge-item note"/)
  assert.match(panel.formatOutput('reviewer', outputs.reviewer), /class="decision-item reject"/)
  const html = panel.renderEpoch({
    id: payload, epoch_number: 1, role_assignments: { planner: payload, challenger: payload, reviewer: payload },
    planner_output: outputs.planner, challenger_output: outputs.challenger, reviewer_output: outputs.reviewer,
    commentator_output: { mood: payload, summary: payload, plant_metaphor: payload },
  })
  assert.equal(html.includes('<img src=x'), false)
  assert.match(html, /class="epoch-mood stable"/)
  assert.match(html, /data-epoch-id="&quot;&gt;&lt;img/)
})

test('model-chosen mutation targets cannot traverse GitHub ref paths', async () => {
  const { contributionBranchName, northBranchName, assertManagedBranchName } = await load('api/_lib/branch-names.js')
  assert.equal(contributionBranchName(7, 'capabilities', 0), 'epoch-7-capabilities-0')
  assert.equal(contributionBranchName(12, 'experiment_params', 3), 'epoch-12-experiment_params-3')
  assert.equal(northBranchName(4), 'north/exp-4')
  assert.equal(northBranchName(4, true), 'north/exp-4-glm')
  for (const target of ['x/../main', 'x/../main#', '../main', 'main', 'capabilities/../../main', '-capabilities', 'Capabilities', '', null, 7, { toString: () => 'capabilities' }]) {
    assert.throws(() => contributionBranchName(7, target, 0), /Refusing branch name/, String(target))
  }
  for (const index of [-1, 1.5, 1000, '0', '0/../main', NaN, null]) {
    assert.throws(() => contributionBranchName(7, 'capabilities', index), /Refusing branch name/, String(index))
  }
  for (const name of ['main', 'epoch-7-x/../main-0', 'epoch-7-capabilities-0/../main', '-epoch-7-capabilities-0',
    'north//exp-1', 'north/exp-1/', 'north/../main', 'refs/heads/main', 'epoch-7-capabilities-0.lock', 'epoch-07-capabilities-0',
    'epoch-7-capabilities-0#', 'epoch-7-capabilities-0?x=1', 'epoch-7-capabilities-0 ', 'north/exp-1-glm-glm']) {
    assert.throws(() => assertManagedBranchName(name), /Refusing branch name/, name)
  }
})

test('branch operations refuse anything but the lab branch shapes before any request', async () => {
  const github = await load('api/_lib/github-repo.js')
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || 'GET' })
    if (String(url).includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'base-sha' } }))
    return new Response('{}')
  }
  for (const name of ['epoch-7-x/../main-0', 'epoch-7-x/../main#-0', 'main', 'feature', '../main', '-x']) {
    await assert.rejects(github.createBranch(name), /Refusing branch name/, name)
    await assert.rejects(github.deleteBranch(name), /Refusing branch name/, name)
    await assert.rejects(github.getBranchHeadSha(name), /Refusing branch name/, name)
    await assert.rejects(github.upsertFileOnBranch(name, 'src/a.ts', 'x', 'test'), /Refusing branch name/, name)
    await assert.rejects(github.deleteFileOnBranch(name, 'src/a.ts', 'test'), /Refusing branch name/, name)
    await assert.rejects(github.openPullRequest(name, 'title', 'body'), /Refusing branch name/, name)
  }
  assert.deepEqual(requests, [])

  await github.createBranch('epoch-7-capabilities-0')
  await github.deleteBranch('north/exp-3-glm')
  const deletes = requests.filter(r => r.method === 'DELETE').map(r => new URL(r.url).pathname)
  assert.equal(deletes.length, 2)
  assert.match(deletes[0], /\/git\/refs\/heads\/epoch-7-capabilities-0$/)
  assert.match(deletes[1], /\/git\/refs\/heads\/north\/exp-3-glm$/)
  assert.equal(deletes.some(path => path.endsWith('/heads/main')), false)
  const created = requests.find(r => r.method === 'POST')
  assert.ok(created, 'branch creation request was sent')
})

test('generated file paths are plain strings in the allowed directories', async () => {
  const { assertContributionPath } = await load('api/_lib/contribution-policy.js')
  for (const path of [undefined, null, 42, ['src/a.ts'], 'src/a b.ts', 'src/%2e%2e/package.json', 'src/..x/a.ts',
    'src/a.ts?ref=main', 'src/a.ts#x', 'src//a.ts', 'src/-a.ts', `src/${'a'.repeat(200)}.ts`]) {
    assert.throws(() => assertContributionPath(path), undefined, String(path))
  }
})

test('unset endpoints and owners fail closed with a clear message and no request', async () => {
  const saved = {}
  for (const name of ['RESEARCH_RUNNER_START_URL', 'RESEARCH_RUNNER_STATUS_URL', 'AI_AGENT_GITHUB_OWNER',
    'RESEARCH_GITHUB_OWNER', 'MODAL_WORKSPACE', 'MODAL_API_TOKEN']) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected outbound request') }
  try {
    process.env.RESEARCH_RUNNER_TOKEN = 'test-only-runner-token'
    process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
    const research = await load('api/_lib/research.js')
    await assert.rejects(research.startResearchRun('example training source', 300), /RESEARCH_RUNNER_START_URL is not set/)
    await assert.rejects(research.pollResearchRun('example-call'), /RESEARCH_RUNNER_STATUS_URL is not set/)
    await assert.rejects(research.getResearchFile('train.py'), /RESEARCH_GITHUB_OWNER is not set/)
    process.env.RESEARCH_RUNNER_START_URL = 'http://runner.example/start'
    await assert.rejects(research.startResearchRun('example training source', 300), /must be an https:\/\/ URL/)
    process.env.RESEARCH_RUNNER_START_URL = 'https://runner.example/start?token=x'
    await assert.rejects(research.startResearchRun('example training source', 300), /without credentials or a query string/)

    const github = await load('api/_lib/github-repo.js')
    await assert.rejects(github.getDefaultBranchSha(), /AI_AGENT_GITHUB_OWNER is not set/)
    await assert.rejects(github.createBranch('epoch-1-capabilities-0'), /AI_AGENT_GITHUB_OWNER is not set/)
    process.env.AI_AGENT_GITHUB_OWNER = '../other'
    await assert.rejects(github.getDefaultBranchSha(), /not a valid GitHub owner/)

    process.env.MODAL_API_TOKEN = 'test-only-modal-token-00000000000000000'
    const modal = await load('api/_lib/modal-client.js')
    const status = await modal.getAwakeningStatus()
    assert.equal(status.success, false)
    assert.match(status.error, /MODAL_WORKSPACE is not set/)
    assert.equal(calls, 0)

    process.env.MODAL_WORKSPACE = 'test-workspace'
    let sentTo
    globalThis.fetch = async url => { sentTo = String(url); return new Response('{}') }
    await modal.getAwakeningStatus()
    assert.equal(new URL(sentTo).hostname, 'test-workspace--observable-lab-web.modal.run')
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('a fallback answer records and shows the model that actually answered', async () => {
  process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder'
  // A fresh module instance picks up the placeholder key read at load time.
  const { callModel, answeredModel } = await import(pathToFileURL(join(build, 'api/_lib/openrouter.js')).href + '?fallback-test')
  delete process.env.OPENROUTER_API_KEY
  const requested = []
  globalThis.fetch = async (url, options) => {
    const { model } = JSON.parse(options.body)
    requested.push(model)
    if (model === 'x-ai/grok-4.3') return new Response('unavailable', { status: 503 })
    return new Response(JSON.stringify({ model, choices: [{ message: { content: '{"verdict":"keep"}' } }], usage: { total_tokens: 10 } }))
  }
  const { output, servedBy } = await callModel('x-ai/grok-4.3', 'system', 'user')
  assert.deepEqual(requested, ['x-ai/grok-4.3', 'x-ai/grok-4.3', 'x-ai/grok-4.3', 'anthropic/claude-opus-4.8'])
  assert.deepEqual(servedBy, { model: 'anthropic/claude-opus-4.8', assigned: 'x-ai/grok-4.3', fallback: true, reported: 'anthropic/claude-opus-4.8' })
  assert.deepEqual(output.served_by, servedBy)
  assert.equal(answeredModel(output, 'x-ai/grok-4.3'), 'anthropic/claude-opus-4.8')

  requested.length = 0
  const direct = await callModel('openai/gpt-5.5', 'system', 'user')
  assert.deepEqual(requested, ['openai/gpt-5.5'])
  assert.equal(direct.servedBy.fallback, false)
  assert.equal(answeredModel(direct.output, 'openai/gpt-5.5'), 'openai/gpt-5.5')

  const { TranscriptPanel } = await load('src/systems/TranscriptPanel.js')
  const panel = Object.create(TranscriptPanel.prototype)
  panel.wildcardTurns = []
  const html = panel.renderEpoch({
    id: 'epoch-test', epoch_number: 3,
    role_assignments: { planner: 'openai/gpt-5.5', executor: 'openai/gpt-5.5', challenger: 'openai/gpt-5.5', reviewer: 'x-ai/grok-4.3', commentator: 'openai/gpt-5.5' },
    reviewer_output: { decisions: [{ mutation_index: 0, verdict: 'approve', reason: 'ok' }], epoch_summary: 'summary', remark: 'kept', served_by: servedBy },
    commentator_output: { mood: 'stable', summary: 'summary', plant_metaphor: 'growth' },
  })
  assert.match(html, /class="chat-name"[^>]*>Claude</)
  assert.match(html, /fallback for Grok/)
  // The avatar identifies the actual fallback provider with a local, credited mark.
  assert.match(html, /<img src="\/logos\/claude\.svg" alt="Anthropic logo"/)
  assert.doesNotMatch(html, /src="\/logos\/xai\.svg"/)
  const { providerLogoForModel } = await load('src/shared/types.js')
  assert.equal(providerLogoForModel('anthropic/a-versioned-fallback'), '/logos/claude.svg')
  for (const unknown of [undefined, null, {}, '__proto__/x', 'constructor/x', 'https://attacker.example/icon.svg', 'unknown/model']) {
    assert.equal(providerLogoForModel(unknown), undefined)
  }
})

test('research records carry the unverified label, dataset and harness hash', async () => {
  process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
  const research = await load('api/_lib/research.js')
  const harness = 'a'.repeat(64)
  const provenance = research.provenanceOf({
    status: 'ok', metrics: { val_bpb: 0.7 }, metrics_source: 'experiment_stdout_unverified',
    dataset: 'tinystories_gpt4_clean', harness_sha256: harness, train_wall_seconds: 351.25,
  })
  assert.deepEqual(provenance, { metrics_source: 'experiment_stdout_unverified', dataset: 'tinystories_gpt4_clean', harness_sha256: harness, train_wall_seconds: 351.25 })
  assert.equal(research.provenanceOf({ status: 'ok', metrics: { val_bpb: 0.7 } }).metrics_source, 'experiment_stdout_unverified')
  assert.equal(research.provenanceOf({ status: 'ok', metrics: {}, harness_sha256: 'not-a-hash', dataset: 'x\ty' }).harness_sha256, null)

  const oldLedger = 'epoch\tcommit\tval_bpb\ttrain_steps\ttrain_seconds\tpeak_vram_mb\tparams_m\tstatus\thypothesis\n1\tmerged\t0.7236\t10\t300.0\t1\t1.000\tkeep\tbaseline\n'
  const puts = []
  globalThis.fetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'PUT') { puts.push({ url: String(url), body: JSON.parse(options.body) }); return new Response('{}') }
    if (String(url).includes('results.tsv')) return new Response(JSON.stringify({ content: Buffer.from(oldLedger).toString('base64'), sha: 'ledger-sha' }))
    return new Response('{}', { status: 404 })
  }
  await research.appendResultsRow({ epoch: 2, commit: 'merged', val_bpb: 0.7, train_steps: 10, train_seconds: 299, peak_vram_mb: 1, params_m: 1, status: 'keep', hypothesis: 'h', provenance })
  const ledger = Buffer.from(puts[0].body.content, 'base64').toString('utf8').trimEnd().split('\n')
  assert.match(ledger[0], /\thypothesis\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds$/)
  assert.equal(ledger[1].split('\t').length, 9)
  assert.deepEqual(ledger[2].split('\t').slice(9), ['experiment_stdout_unverified', 'tinystories_gpt4_clean', harness, '351.3'])
  assert.match(puts[0].body.message, /unverified\)/)
  assert.match(puts[0].body.message, new RegExp(`Harness-SHA256: ${harness}`))

  await research.writeFindingPage({ epoch: 2, author: 'Claude', hypothesis: 'h', changeSummary: 'c', verdict: 'keep', runStatus: 'ok', valBpb: 0.7, bestBpb: 0.72, reviewReason: 'r', challengerNotes: [], provenance })
  const page = Buffer.from(puts[1].body.content, 'base64').toString('utf8')
  assert.match(page, /Score source:\*\* experiment_stdout_unverified \(printed by the generated train\.py itself/)
  assert.match(page, /Dataset:\*\* tinystories_gpt4_clean/)
  assert.match(page, new RegExp(harness))
  assert.match(puts[1].body.message, /Metrics-Source: experiment_stdout_unverified/)
})

const NOREPLY = { name: 'DervinEvolve', email: '39844362+DervinEvolve@users.noreply.github.com' }

test('no generated-commit identity uses the observable-lab.dev domain', () => {
  const offenders = []
  const scan = path => {
    if (!existsSync(join(root, path))) return
    const entries = readdirSync(join(root, path), { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = join(entry.parentPath ?? entry.path, entry.name)
      if (/observable-lab\.dev/i.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(root.length + 1))
    }
  }
  for (const directory of ['api', 'modal', 'vercel-server', 'scripts', '.github']) scan(directory)
  for (const file of ['.env.example', 'vercel.json', 'package.json', 'tsconfig.json', 'tsconfig.api.json', 'vite.config.ts', 'requirements-dev.txt']) {
    if (existsSync(join(root, file)) && /observable-lab\.dev/i.test(readFileSync(join(root, file), 'utf8'))) offenders.push(file)
  }
  assert.deepEqual(offenders, [])
})

test('research commits use the noreply identity and name the model in a trailer', async () => {
  process.env.RESEARCH_GITHUB_TOKEN = 'test-only-research-repository-token'
  const research = await load('api/_lib/research.js')
  const puts = []
  globalThis.fetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'PUT') { puts.push(JSON.parse(options.body)); return new Response('{}') }
    return new Response('{}', { status: 404 })
  }
  await research.putResearchFile('train.py', '# test experiment', 'e1 KEEP\n\nModel: Claude (anthropic/claude-opus-4.8)')
  assert.deepEqual(puts[0].author, NOREPLY)
  assert.deepEqual(puts[0].committer, NOREPLY)
  const provenance = research.provenanceOf({ status: 'ok', metrics: { val_bpb: 0.7 } })
  await research.writeFindingPage({ epoch: 4, author: 'Claude', hypothesis: 'h', changeSummary: 'c', verdict: 'keep', runStatus: 'ok', valBpb: 0.7, bestBpb: 0.72, reviewReason: 'r', challengerNotes: [], provenance })
  assert.deepEqual(puts[1].author, NOREPLY)
  assert.match(puts[1].message, /\n\nModel: Claude\nMetrics-Source: /)
})

test('contribution commits use the noreply identity and credit the answering model in trailers', async () => {
  // A private copy of the compiled modules, so openrouter.js reads the placeholder key at load time.
  const copy = join(build, 'identity-test')
  cpSync(join(build, 'api'), join(copy, 'api'), { recursive: true })
  process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder'
  process.env.LAB_ENABLE_CODE_WRITES = 'true'
  delete process.env.LAB_REQUIRED_CI_WORKFLOW_IDS
  const { contributeCode } = await import(pathToFileURL(join(copy, 'api/_lib/code-contribution.js')).href)
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const method = options.method || 'GET'
    requests.push({ url: target, method, body: options.body ? String(options.body) : '' })
    if (target.includes('openrouter.ai')) {
      const { model } = JSON.parse(options.body)
      if (model === 'x-ai/grok-4.3') return new Response('unavailable', { status: 503 })
      const content = JSON.stringify({ files: [{ path: 'src/agent.ts', content: 'export const x = 1\n' }], commit_message: 'feat: add x', pr_summary: 'adds x' })
      return new Response(JSON.stringify({ model, choices: [{ message: { content } }], usage: { total_tokens: 10 } }))
    }
    if (method === 'GET' && target.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'base-sha' } }))
    if (method === 'GET' && target.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }))
    if (method === 'GET' && target.includes('/contents/')) return new Response('{}', { status: 404 })
    if (method === 'POST' && target.endsWith('/pulls')) return new Response(JSON.stringify({ number: 5, html_url: 'https://github.example/pr/5' }))
    return new Response('{}')
  }
  try {
    const result = await contributeCode({ authorModelId: 'x-ai/grok-4.3', branchName: 'epoch-7-capabilities-0', title: 'add x', description: 'add x', review: { mode: 'approved' } })
    assert.equal(result.merged, false) // no trusted CI workflow configured, so the PR is closed
    assert.equal(result.author, 'Claude')
    const puts = requests.filter(r => r.method === 'PUT' && r.url.includes('/contents/')).map(r => JSON.parse(r.body))
    assert.equal(puts.length, 1)
    assert.deepEqual(puts[0].author, NOREPLY)
    assert.deepEqual(puts[0].committer, NOREPLY)
    assert.equal(puts[0].message, 'feat: add x\n\nModel: Claude (anthropic/claude-opus-4.8)\nModel-Fallback-For: Grok')
    assert.equal(requests.some(r => /observable-lab\.dev/.test(r.body)), false)
  } finally {
    delete process.env.OPENROUTER_API_KEY
    delete process.env.LAB_ENABLE_CODE_WRITES
  }
})
