import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// Sprites client, contribution checks and the room's playback, run against
// fake Sprites, GitHub and OpenRouter APIs. No network, no keys, no database.
const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-sprites-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')
function transpile(path, fixImports = false) {
  let output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  if (fixImports) output = output.replace(/from '(\.[^']+)'/g, (whole, specifier) => (specifier.endsWith('.js') ? whole : `from '${specifier}.js'`))
  const destination = join(build, path.replace(/\.ts$/, '.js'))
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, output)
}
function compile(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) compile(path)
    else if (path.endsWith('.ts')) transpile(path)
  }
}
compile('api')
transpile('src/systems/SpritesService.ts', true)
transpile('src/entities/TerminalScreen.ts', true)
const load = path => import(pathToFileURL(join(build, path)).href)

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
after(() => {
  process.env = originalEnv
  globalThis.fetch = originalFetch
  rmSync(build, { recursive: true, force: true })
})

const SPRITES_TOKEN = 'test-org/test-id/test-only-sprites-secret'
const GITHUB_TOKEN = 'test-only-github-token-value-0000'
process.env.AI_AGENT_GITHUB_TOKEN = GITHUB_TOKEN
process.env.AI_AGENT_GITHUB_OWNER = 'test-owner'
delete process.env.AI_AGENT_GITHUB_REPO
delete process.env.AI_AGENT_REPO
delete process.env.SPRITES_TOKEN
delete process.env.OPENROUTER_API_KEY
delete process.env.POSTGRES_URL
delete process.env.LAB_ENABLE_CODE_WRITES

const HEAD = 'a'.repeat(40)

// A fake Sprites API. `exec` decides what the exec endpoint answers; it gets
// the parsed query and the per-call marker nonce from the wrapper script.
function fakeSprites({ exists = true, status = 'warm', exec, calls }) {
  let present = exists
  return async (url, options = {}) => {
    const u = new URL(String(url))
    const method = options.method || 'GET'
    calls.push({ host: u.host, path: u.pathname, method, query: u.searchParams, headers: options.headers || {}, body: options.body })
    if (u.host !== 'api.sprites.dev') return null
    if (method === 'GET' && /^\/v1\/sprites\/[^/]+$/.test(u.pathname)) {
      if (!present) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ name: u.pathname.split('/').pop(), status }), { headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST' && u.pathname === '/v1/sprites') {
      present = true
      return new Response(JSON.stringify({ name: JSON.parse(options.body).name, status: 'cold' }), { status: 201 })
    }
    if (method === 'POST' && u.pathname.endsWith('/policy/network')) return new Response(options.body)
    if (method === 'POST' && u.pathname.endsWith('/exec')) {
      const nonce = /__EXIT_([0-9a-f]+):/.exec(u.searchParams.getAll('cmd')[2] || '')?.[1]
      return exec(u.searchParams, nonce)
    }
    if (method === 'DELETE') return new Response('', { status: 204 })
    return new Response('unexpected', { status: 500 })
  }
}

test('model ids map to one sprite per lab, plus North and GLM', async () => {
  const { spriteKeyForModel, spriteName } = await load('api/_lib/sprites.js')
  const { WILDCARD_MODELS } = await load('api/_lib/types.js')
  assert.equal(spriteKeyForModel('google/gemini-4-hydrogen'), 'gemini')
  assert.equal(spriteKeyForModel('deepseek/deepseek-v4-pro-0813'), 'deepseek')
  assert.equal(spriteKeyForModel('anthropic/claude-fable-5.2'), 'claude')
  assert.equal(spriteKeyForModel('anthropic/claude-sonnet-5.5'), 'claude')
  assert.equal(spriteKeyForModel('openai/gpt-6-astra'), 'gpt')
  assert.equal(spriteKeyForModel('x-ai/grok-4.7'), 'grok')
  assert.equal(spriteKeyForModel(WILDCARD_MODELS.north), 'north')
  assert.equal(spriteKeyForModel(WILDCARD_MODELS.glm), 'glm')
  assert.equal(spriteKeyForModel('glm'), 'glm')
  assert.equal(spriteKeyForModel('someone/else'), null)
  assert.equal(spriteName('glm'), 'observable-glm')
})

test('without SPRITES_TOKEN a contribution check is recorded as not run and nothing is called', async () => {
  const { checkContributionInSprite } = await load('api/_lib/sprites.js')
  delete process.env.SPRITES_TOKEN
  globalThis.fetch = async () => { throw new Error('Unexpected outbound request') }
  const check = await checkContributionInSprite({ authorModelId: 'anthropic/claude-fable-5.2', branch: 'epoch-7-capabilities-0', headSha: HEAD })
  assert.equal(check.status, 'not_run')
  assert.equal(check.exit_code, null)
  assert.equal(check.ran_at, null)
  assert.match(check.output_tail, /^not run: /)
})

test('a missing sprite is created, gets the defaults network policy, and the token stays in the header', async () => {
  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  const { ensureSprite } = await load('api/_lib/sprites.js')
  const calls = []
  globalThis.fetch = fakeSprites({ exists: false, calls, exec: () => new Response('') })
  const info = await ensureSprite('north')
  assert.equal(info.name, 'observable-north')
  assert.equal(info.created, true)
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
    'GET /v1/sprites/observable-north',
    'POST /v1/sprites',
    'GET /v1/sprites/observable-north',
    'POST /v1/sprites/observable-north/policy/network',
  ])
  assert.deepEqual(JSON.parse(calls[1].body), { name: 'observable-north' })
  assert.deepEqual(JSON.parse(calls[3].body), { rules: [{ include: 'defaults' }] })
  for (const call of calls) {
    assert.equal(call.headers.Authorization, `Bearer ${SPRITES_TOKEN}`)
    assert.equal(call.query.toString().includes('test-only-sprites-secret'), false)
  }
})

test('sprite status maps to cold, warm, running, not_created or error', async () => {
  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  const { getSpriteStatus } = await load('api/_lib/sprites.js')
  const answer = (status, body) => { globalThis.fetch = async () => new Response(body, { status }) }
  answer(200, '{"status":"running"}'); assert.equal((await getSpriteStatus('gpt')).status, 'running')
  answer(200, '{"status":"cold"}'); assert.equal((await getSpriteStatus('gpt')).status, 'cold')
  answer(404, 'nope'); assert.equal((await getSpriteStatus('gpt')).status, 'not_created')
  answer(500, 'boom'); assert.equal((await getSpriteStatus('gpt')).status, 'error')
  answer(200, '{"status":"mystery"}'); assert.equal((await getSpriteStatus('gpt')).status, 'error')
  globalThis.fetch = async () => { throw new Error('network down') }
  assert.equal((await getSpriteStatus('gpt')).status, 'error')
})

test('exec sends cmd as repeated query params and reads the exit status from its own marker', async () => {
  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  const { execInSprite } = await load('api/_lib/sprites.js')
  const calls = []
  let reply
  globalThis.fetch = fakeSprites({ calls, exec: (_query, nonce) => reply(nonce) })

  // Plain text body with the marker.
  reply = nonce => new Response(`hello\nworld\n__EXIT_${nonce}:0\n`, { headers: { 'content-type': 'text/plain' } })
  let result = await execInSprite('claude', 'echo hello; echo world', { dir: '/home/sprite', env: { BRANCH: 'epoch-1-capabilities-0' }, timeoutS: 30 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, 'hello\nworld')
  const call = calls.at(-1)
  assert.equal(call.method, 'POST')
  assert.equal(call.path, '/v1/sprites/observable-claude/exec')
  assert.equal(call.body, undefined)
  const cmd = call.query.getAll('cmd')
  assert.equal(cmd.length, 6)
  assert.deepEqual([cmd[0], cmd[1], cmd[3], cmd[4], cmd[5]], ['/bin/sh', '-c', 'lab-exec', '30', 'echo hello; echo world'])
  assert.equal(call.query.get('path'), '/bin/sh')
  assert.equal(call.query.get('dir'), '/home/sprite')
  assert.ok(call.query.getAll('env').includes('BRANCH=epoch-1-capabilities-0'))
  assert.ok(call.query.getAll('env').includes('CI=true'))

  // JSON body: the marker wins over the wrapper's own exit code.
  reply = nonce => new Response(JSON.stringify({ stdout: `out\n__EXIT_${nonce}:3`, stderr: '', exit_code: 0 }), { headers: { 'content-type': 'application/json' } })
  result = await execInSprite('claude', 'false')
  assert.equal(result.exitCode, 3)
  assert.equal(result.output, 'out')

  // No marker: a zero proves nothing, a non-zero still means failure.
  reply = () => new Response(JSON.stringify({ stdout: 'cut off', exit_code: 0 }), { headers: { 'content-type': 'application/json' } })
  assert.equal((await execInSprite('claude', 'x')).exitCode, null)
  reply = () => new Response(JSON.stringify({ output: 'killed', exitCode: 137 }), { headers: { 'content-type': 'application/json' } })
  result = await execInSprite('claude', 'x')
  assert.equal(result.exitCode, 137)
  assert.equal(result.timedOut, false) // killed long before the limit: not a timeout
  reply = nonce => new Response(`slow\n__EXIT_${nonce}:124`)
  result = await execInSprite('claude', 'sleep 999', { timeoutS: 5 })
  assert.equal(result.exitCode, 124)
  assert.equal(result.timedOut, true)
  reply = () => new Response('plain text, no marker')
  assert.equal((await execInSprite('claude', 'x')).exitCode, null)

  // A marker printed by the command itself (wrong nonce) is ignored.
  reply = nonce => new Response(`__EXIT_0123456789abcdef:0\nreal failure\n__EXIT_${nonce}:1`)
  result = await execInSprite('claude', 'x')
  assert.equal(result.exitCode, 1)

  // Output is capped to its tail.
  reply = nonce => new Response(`${'line\n'.repeat(5000)}last line\n__EXIT_${nonce}:0`)
  result = await execInSprite('claude', 'x', { maxOutputBytes: 1000 })
  assert.ok(Buffer.byteLength(result.output) <= 1000)
  assert.ok(result.output.endsWith('last line'))
  assert.equal(result.truncated, true)

  // API error.
  reply = () => new Response('sprite exploded', { status: 500 })
  await assert.rejects(execInSprite('claude', 'x'), /HTTP 500/)
})

test('a server credential is never sent into a sprite', async () => {
  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  const { execInSprite } = await load('api/_lib/sprites.js')
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('') }
  await assert.rejects(execInSprite('gpt', `echo ${GITHUB_TOKEN}`), /server credential/)
  await assert.rejects(execInSprite('gpt', 'env', { env: { X: SPRITES_TOKEN } }), /server credential/)
  await assert.rejects(execInSprite('gpt', 'env', { env: { GITHUB_TOKEN: 'anything' } }), /Refusing env name/)
  assert.equal(calls, 0)
})

test('output shown to viewers has no ANSI codes and nothing that looks like a token', async () => {
  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  const { sanitizeOutput } = await load('api/_lib/sprites.js')
  const sha = 'b'.repeat(40)
  const text = [
    '\u001b[32m✓\u001b[39m src/a.test.ts (3 tests) 5ms',
    `token from env: ${GITHUB_TOKEN}`,
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'key sk-or-v1-0123456789abcdef0123456789abcdef',
    'Authorization: Bearer abcdefghijklmnop1234',
    'OPENROUTER_API_KEY=supersecretvalue',
    'db postgres://user:pass@host:5432/db',
    'clone https://user:hunter2@github.com/x/y.git',
    'random Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c',
    `commit ${sha}`,
    ` Test Files  45 passed (45)\r\n      Tests  399 passed (399)`,
  ].join('\n')
  const out = sanitizeOutput(text)
  assert.equal(/\u001b/.test(out), false)
  assert.equal(out.includes('\r'), false)
  for (const secret of [GITHUB_TOKEN, 'ghp_abc', 'github_pat_11', 'sk-or-v1', 'abcdefghijklmnop1234', 'supersecretvalue', 'user:pass', 'hunter2', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c']) {
    assert.equal(out.includes(secret), false, secret)
  }
  assert.ok(out.includes('✓ src/a.test.ts (3 tests) 5ms'))
  assert.ok(out.includes(`commit ${sha}`))
  assert.ok(out.includes('Tests  399 passed (399)'))
})

// One full contribution against fake OpenRouter, GitHub and Sprites APIs.
async function runContribution({ spriteExec, ciConclusion = 'success', spritesToken = SPRITES_TOKEN }) {
  const copy = join(build, `contribution-${Math.random().toString(16).slice(2)}`)
  cpSync(join(build, 'api'), join(copy, 'api'), { recursive: true })
  process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder'
  process.env.LAB_ENABLE_CODE_WRITES = 'true'
  process.env.LAB_REQUIRED_CI_WORKFLOW_IDS = '11'
  if (spritesToken) process.env.SPRITES_TOKEN = spritesToken
  else delete process.env.SPRITES_TOKEN
  const { contributeCode } = await import(pathToFileURL(join(copy, 'api/_lib/code-contribution.js')).href)
  const calls = []
  const sprites = fakeSprites({ calls, exec: spriteExec })
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const method = options.method || 'GET'
    const fromSprites = await sprites(url, options)
    if (fromSprites) return fromSprites
    if (target.includes('openrouter.ai')) {
      const { model } = JSON.parse(options.body)
      const content = JSON.stringify({ files: [{ path: 'src/agent.ts', content: 'export const x = 1\n' }], commit_message: 'feat: add x', pr_summary: 'adds x' })
      return new Response(JSON.stringify({ model, choices: [{ message: { content } }], usage: { total_tokens: 10 } }))
    }
    if (method === 'GET' && target.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'base-sha' } }))
    if (method === 'GET' && target.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: HEAD } }))
    if (method === 'GET' && target.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }))
    if (method === 'GET' && target.includes('/contents/')) return new Response('{}', { status: 404 })
    if (method === 'POST' && target.endsWith('/pulls')) return new Response(JSON.stringify({ number: 5, html_url: 'https://github.example/pr/5' }))
    if (method === 'GET' && target.includes('/actions/runs?')) {
      return new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99, workflow_id: 11, status: 'completed', conclusion: ciConclusion, head_sha: HEAD, head_repository: { full_name: 'test-owner/AI-Agent' }, event: 'pull_request' }] }))
    }
    if (method === 'GET' && target.includes('/actions/runs/99/jobs')) return new Response(JSON.stringify({ jobs: [] }))
    if (method === 'GET' && target.endsWith('/pulls/5')) return new Response(JSON.stringify({ mergeable: true }))
    return new Response('{}')
  }
  try {
    const result = await contributeCode({ authorModelId: 'anthropic/claude-fable-5.2', branchName: 'epoch-7-capabilities-0', title: 'add x', description: 'add x', review: { mode: 'approved' } })
    return { result, calls }
  } finally {
    delete process.env.OPENROUTER_API_KEY
    delete process.env.LAB_ENABLE_CODE_WRITES
    delete process.env.LAB_REQUIRED_CI_WORKFLOW_IDS
  }
}

const isSpriteExec = c => c.host === 'api.sprites.dev' && c.path.endsWith('/exec')
const isPrResolution = c => c.host === 'api.github.com' && (c.path.endsWith('/merge') || (c.method === 'PATCH' && c.path.endsWith('/pulls/5')))

test('a pushed contribution is tested in the author model\'s sprite before the PR is resolved', async () => {
  const { result, calls } = await runContribution({
    spriteExec: (_q, nonce) => new Response(`epoch-7-capabilities-0 at aaaaaaa\n \u001b[32m✓\u001b[39m src/agent.test.ts (1 test)\n Test Files  1 passed (1)\n__EXIT_${nonce}:0\n`),
  })
  assert.equal(result.merged, true)
  assert.equal(result.ci_passed, true)
  assert.equal(result.sprite.status, 'passed')
  assert.equal(result.sprite.exit_code, 0)
  assert.equal(result.sprite.sprite_name, 'observable-claude')
  assert.ok(result.sprite.ran_at)
  assert.equal(typeof result.sprite.duration_ms, 'number')
  assert.match(result.sprite.output_tail, /✓ src\/agent\.test\.ts/)
  assert.equal(/\u001b/.test(result.sprite.output_tail), false)

  const exec = calls.find(isSpriteExec)
  assert.ok(exec, 'the sprite ran the check')
  const env = exec.query.getAll('env')
  assert.ok(env.includes('BRANCH=epoch-7-capabilities-0'))
  assert.ok(env.includes(`HEAD_SHA=${HEAD}`))
  assert.ok(env.includes('REPO_URL=https://github.com/test-owner/AI-Agent.git'))
  assert.match(exec.query.getAll('cmd')[5], /npm test/)
  assert.ok(calls.indexOf(exec) < calls.findIndex(isPrResolution), 'the check ran before the branch could be deleted')
  // Nothing sent to Sprites carries the GitHub token; nothing sent to GitHub carries the Sprites token.
  for (const call of calls) {
    const sent = `${call.query} ${call.body || ''} ${JSON.stringify(call.headers)}`
    if (call.host === 'api.sprites.dev') assert.equal(sent.includes(GITHUB_TOKEN), false)
    else assert.equal(sent.includes(SPRITES_TOKEN), false)
  }
})

test('a failing sprite run is recorded but CI alone decides the merge', async () => {
  const { result } = await runContribution({
    spriteExec: (_q, nonce) => new Response(` FAIL  src/agent.test.ts\nAssertionError: expected 1 to be 2\n__EXIT_${nonce}:1`),
  })
  assert.equal(result.merged, true)
  assert.equal(result.sprite.status, 'failed')
  assert.equal(result.sprite.exit_code, 1)

  const red = await runContribution({ ciConclusion: 'failure', spriteExec: (_q, nonce) => new Response(`ok\n__EXIT_${nonce}:0`) })
  assert.equal(red.result.merged, false)
  assert.equal(red.result.sprite.status, 'passed')
})

test('a broken sprite or a missing token never blocks the contribution', async () => {
  const broken = await runContribution({ spriteExec: () => new Response('internal error', { status: 500 }) })
  assert.equal(broken.result.merged, true)
  assert.equal(broken.result.sprite.status, 'error')
  assert.equal(broken.result.sprite.exit_code, null)
  assert.match(broken.result.sprite.output_tail, /^sprite error: /)

  const unset = await runContribution({ spritesToken: null, spriteExec: () => { throw new Error('must not run') } })
  assert.equal(unset.result.merged, true)
  assert.equal(unset.result.sprite.status, 'not_run')
  assert.equal(unset.calls.some(c => c.host === 'api.sprites.dev'), false)
})

test('stored rows read as passed, failed, error or not run', async () => {
  const { spriteRunStatus } = await load('api/_lib/sprites.js')
  assert.equal(spriteRunStatus({ sprite_exit_code: 0, sprite_ran_at: '2026-11-13T10:00:00Z' }), 'passed')
  assert.equal(spriteRunStatus({ sprite_exit_code: 2, sprite_ran_at: '2026-11-13T10:00:00Z' }), 'failed')
  assert.equal(spriteRunStatus({ sprite_exit_code: null, sprite_ran_at: '2026-11-13T10:00:00Z' }), 'error')
  assert.equal(spriteRunStatus({ sprite_exit_code: null, sprite_ran_at: null }), 'not_run')
})

test('operator sprite routes still refuse anonymous requests before any Sprites call', async () => {
  process.env.LAB_OPERATOR_SECRET = 'test-only-operator-secret-0000000000000000'
  process.env.SPRITES_TOKEN = SPRITES_TOKEN
  globalThis.fetch = async () => { throw new Error('Unexpected outbound request') }
  for (const route of ['api/sprites/index.js', 'api/sprites/exec.js']) {
    const { default: handler } = await load(route)
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(c) { this.code = c; return this }, json() { return this }, end() { return this } }
      await handler({ method, headers: {}, query: {}, body: { action: 'exec', modelId: 'claude', command: 'id' } }, res)
      assert.equal(res.code, 401, `${route} ${method}`)
    }
  }
})

test('the room only plays real runs from desk models, with a clear verdict line', async () => {
  const { parseSpriteRuns, terminalLinesForRun } = await load('src/systems/SpritesService.js')
  const run = (over = {}, sprite = {}) => ({
    id: 'r1', branch: 'epoch-7-capabilities-0', ...over,
    sprite: { status: 'passed', exit_code: 0, duration_ms: 41_500, output_tail: ' ✓ src/a.test.ts (2 tests)\n\n Test Files  1 passed (1)', sprite_name: 'observable-claude', ran_at: '2026-11-13T14:02:00.000Z', ...sprite },
  })
  const runs = parseSpriteRuns({ sprite_runs: [
    run(),
    run({ id: 'north' }, { sprite_name: 'observable-north' }),
    run({ id: 'not-run' }, { status: 'not_run', exit_code: null, ran_at: null }),
    run({ id: 'error' }, { status: 'error', exit_code: null }),
    run({ id: 'empty' }, { output_tail: '   ' }),
    run({ id: 'fail' }, { status: 'failed', exit_code: 1, sprite_name: 'observable-grok' }),
  ] })
  assert.deepEqual(runs.map(r => r.id), ['r1', 'fail'])
  assert.deepEqual(parseSpriteRuns(null), [])
  assert.deepEqual(parseSpriteRuns({ sprite_runs: 'x' }), [])

  const pass = terminalLinesForRun(runs[0])
  assert.equal(pass[0].text, '# observable-claude  epoch-7-capabilities-0  2026-11-13 14:02 UTC')
  assert.deepEqual(pass.slice(1, -1).map(l => l.text), [' ✓ src/a.test.ts (2 tests)', ' Test Files  1 passed (1)'])
  assert.deepEqual(pass.at(-1), { text: '✓ PASS  tests passed in 42 s', type: 'output' })
  const fail = terminalLinesForRun(runs[1])
  assert.deepEqual(fail.at(-1), { text: '✗ FAIL  exit 1 in 42 s', type: 'error' })

  const { toneOf } = await load('src/entities/TerminalScreen.js')
  assert.equal(toneOf('✓ PASS  tests passed in 42 s'), 'success')
  assert.equal(toneOf(' × adds numbers'), 'error')
  assert.equal(toneOf(' FAIL  src/a.test.ts'), 'error')
  assert.equal(toneOf('# simulation: no experiment connected'), 'normal')
})
