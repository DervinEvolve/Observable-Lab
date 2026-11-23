// The visitor chat's "compare with untrained" (LAB_ENABLE_TRAINED_CHAT_COMPARE):
// the request it accepts, the two calls it makes, what each costs and where it
// is counted, what is stored, and that the caps hold on every path.
//
// No network, no database, no secrets (tests/fixtures/chat-harness.mjs).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { BASE, FakeDb, SAMPLER, TINKER_KEY, completion, response, root, setup } from './fixtures/chat-harness.mjs'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const quiet = { warn: console.warn, log: console.log, error: console.error }
const harness = await setup()
after(() => {
  process.env = originalEnv
  globalThis.fetch = originalFetch
  Object.assign(console, quiet)
  harness.cleanup()
})
for (const name of Object.keys(process.env)) {
  if (/^(OPENROUTER|POSTGRES|LAB_|AI_AGENT|RESEARCH_|SPRITES|MODAL|EPOCH_|NORTH_|GPU_JOBS|VERCEL|TINKER|CRON_)/.test(name)) delete process.env[name]
}
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-placeholder-0000'
process.env.LAB_ENABLE_TINKER_RL = 'false'
const BASE_ENV = { ...process.env }

let logs = []
const capture = (...args) => logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = capture
console.log = capture
console.error = capture

const { load, db } = harness
const tinker = await load('api/_lib/tinker.js')
const store = await load('api/_lib/tinker-store.js')
const tinkerChat = await load('api/_lib/tinker-chat.js')
const trainedChat = await load('api/_lib/trained-chat.js')
const { default: chatRoute } = await load('api/experiment/trained-chat.js')

let lab
beforeEach(() => {
  process.env = { ...BASE_ENV }
  logs = []
  lab = new FakeDb(store)
  db.handler = (text, values) => lab.handle(text, values)
  globalThis.fetch = async url => { throw new Error(`Unexpected outbound request to ${url}`) }
})

function enableChat(extra = {}) {
  Object.assign(process.env, { LAB_ENABLE_TRAINED_CHAT: 'true', TINKER_API_KEY: TINKER_KEY, CRON_SECRET: 'test-only-scheduler-secret-0000000000', ...extra })
}
let ipCounter = 0
const freshIp = () => `198.51.100.${(++ipCounter % 250) + 1}`
const IP = '203.0.113.77'
const TEXT = 'a private thought about marmalade'
async function visit(body, { ip = IP, method = 'POST' } = {}) {
  const res = response()
  await chatRoute({ method, headers: { 'content-type': 'application/json', 'x-real-ip': ip, 'user-agent': 'TestBrowser/1.0' }, query: {}, body }, res)
  return res
}
const ask = (slug, text = TEXT, history = [], baseReplies = null) => ({
  adapter: slug, messages: [...history, { role: 'user', content: text }], ...(baseReplies ? { compare: true, base_replies: baseReplies } : {}),
})
const compareAsk = (slug, text = TEXT) => ask(slug, text, [], [])

/** fetch that answers like Tinker. `answer(request, isBase)` decides each reply. */
function fakeTinker(sent, answer = () => completion()) {
  return async (url, options = {}) => {
    assert.equal(String(url), tinkerChat.TINKER_CHAT_URL)
    const body = JSON.parse(options.body)
    const request = { headers: options.headers, body, isBase: body.model !== SAMPLER, started: Date.now() }
    sent.push(request)
    const out = await answer(request, request.isBase)
    request.ended = Date.now()
    return out instanceof Response ? out : new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } })
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })

test('the compare switch is on unless the owner says false, 0, off or no', () => {
  delete process.env.LAB_ENABLE_TRAINED_CHAT_COMPARE
  assert.equal(tinker.trainedChatCompareFlag(), true)
  for (const v of ['true', ' TRUE ', 'yes', '1', 'on', '']) {
    process.env.LAB_ENABLE_TRAINED_CHAT_COMPARE = v
    assert.equal(tinker.trainedChatCompareFlag(), true, `"${v}" should leave it on`)
  }
  for (const v of ['false', '0', 'off', 'NO', ' False ', 'Off']) {
    process.env.LAB_ENABLE_TRAINED_CHAT_COMPARE = v
    assert.equal(tinker.trainedChatCompareFlag(), false, `"${v}" should switch it off`)
  }
})

test('GET says whether compare is available, and the disabled and unavailable bodies are unchanged', async () => {
  // Chat off: exactly what it always said.
  const off = await visit(undefined, { method: 'GET' })
  assert.deepEqual(off.body, { enabled: false, adapters: [] })

  enableChat()
  const slug = lab.addAdapter()
  const on = await visit(undefined, { method: 'GET' })
  assert.equal(on.body.compare_enabled, true)
  assert.deepEqual(on.body.limits, { max_message_chars: 500, max_turns: 8, max_reply_tokens: 200 })
  assert.equal(on.body.adapters[0].slug, slug)
  assert.equal(JSON.stringify(on.body).includes('tinker://'), false)

  process.env.LAB_ENABLE_TRAINED_CHAT_COMPARE = 'false'
  const noCompare = await visit(undefined, { method: 'GET' })
  assert.equal(noCompare.body.compare_enabled, false)
  assert.equal(noCompare.body.enabled, true)

  // The list cannot be read: the same body as before, with no compare field.
  db.handler = (text, values) => { if (text.startsWith('SELECT * FROM tinker_runs WHERE status')) throw new Error('down'); return lab.handle(text, values) }
  const broken = await visit(undefined, { method: 'GET' })
  assert.equal(broken.body.unavailable, true)
  assert.equal('compare_enabled' in broken.body, false)
})

test('readChatRequest: the old shape is unchanged and the two new keys are strict', () => {
  const read = trainedChat.readChatRequest
  const slug = 'e41-0a1b2c3d'
  const u = content => ({ role: 'user', content })
  const a = content => ({ role: 'assistant', content })
  const plain = read({ adapter: slug, messages: [u('Hi')] })
  assert.deepEqual([plain.ok, plain.compare, plain.baseMessages, plain.baseChars, plain.turns, plain.chars], [true, false, [], 0, 1, 2])
  assert.equal(read({ adapter: slug, messages: [u('Hi')], compare: false }).ok, true)
  assert.equal(read({ adapter: slug, messages: [u('Hi')], compare: false }).compare, false)

  const refusal = (raw, error = 'invalid_request') => { const r = read(raw); assert.equal(r.ok, false, JSON.stringify(raw)); assert.deepEqual([r.status, r.error], [400, error]); return r.message }
  assert.equal(refusal({ adapter: slug, messages: [u('Hi')], compare: 'yes', base_replies: [] }), 'compare must be true or false.')
  assert.equal(refusal({ adapter: slug, messages: [u('Hi')], compare: 1 }), 'compare must be true or false.')
  assert.equal(refusal({ adapter: slug, messages: [u('Hi')], base_replies: [] }), 'base_replies is only accepted with compare.')
  assert.equal(refusal({ adapter: slug, messages: [u('Hi')], compare: false, base_replies: [] }), 'base_replies is only accepted with compare.')
  // A model named in the request is an unknown key, so the visitor cannot choose what is called.
  refusal({ adapter: slug, messages: [u('Hi')], compare: true, base_replies: [], model: 'Qwen/Qwen3.5-9B' })
  refusal({ adapter: slug, messages: [u('Hi')], compare: true, base_replies: [], base_model: 'Qwen/Qwen3.5-9B' })
  // Wrong length, missing, not an array, not strings, blank.
  const two = [u('one'), a('first'), u('two')]
  for (const bad of [[], ['x', 'y'], undefined, 'x', [5], [''], ['   ']]) {
    refusal({ adapter: slug, messages: two, compare: true, ...(bad === undefined ? {} : { base_replies: bad }) })
  }
  refusal({ adapter: slug, messages: [u('Hi')], compare: true, base_replies: ['extra'] })
  // Too long.
  refusal({ adapter: slug, messages: two, compare: true, base_replies: ['x'.repeat(trainedChat.TRAINED_CHAT_MAX_REPLY_CHARS + 1)] }, 'too_long')
  assert.equal(read({ adapter: slug, messages: two, compare: true, base_replies: ['x'.repeat(trainedChat.TRAINED_CHAT_MAX_REPLY_CHARS)] }).ok, true)
  // Unknown extra keys are still refused.
  refusal({ adapter: slug, messages: [u('Hi')], extra: true })

  // The untrained history is the same user texts with the untrained side's own replies between them.
  const full = read({ adapter: slug, messages: [u('one'), a('trained first'), u('two'), a('trained second'), u('three')], compare: true, base_replies: ['base first\u0001', 'base second'] })
  assert.equal(full.ok, true)
  assert.deepEqual(full.baseMessages, [u('one'), a('base first'), u('two'), a('base second'), u('three')])
  assert.deepEqual(full.baseMessages.filter(m => m.role === 'user'), full.messages.filter(m => m.role === 'user'))
  assert.equal(full.baseChars, full.baseMessages.reduce((s, m) => s + m.content.length, 0))
  assert.equal(full.compare, true)
})

test('the base call differs from the adapter call only in the model, and only a priced base model is ever sent', async () => {
  const messages = [{ role: 'user', content: 'hi' }]
  const adapterBody = tinkerChat.tinkerChatBody({ samplerPath: SAMPLER, messages, maxTokens: 200, temperature: 0.7, timeoutMs: 1 })
  assert.deepEqual(adapterBody, { model: SAMPLER, messages, max_completion_tokens: 200, temperature: 0.7, reasoning_effort: false })
  const baseBody = tinkerChat.tinkerChatBody({ baseModel: BASE, messages, maxTokens: 200, temperature: 0.7, timeoutMs: 1 })
  assert.deepEqual(baseBody, { ...adapterBody, model: BASE })

  process.env.TINKER_API_KEY = TINKER_KEY
  const sent = []
  globalThis.fetch = fakeTinker(sent)
  const input = { messages, maxTokens: 200, temperature: 0.7, timeoutMs: 1000 }
  for (const bad of [{ baseModel: 'gpt-4' }, { baseModel: '' }, { baseModel: 'constructor' }, { baseModel: '__proto__' }, { baseModel: SAMPLER }, { baseModel: BASE, samplerPath: SAMPLER }, {}, { samplerPath: BASE }]) {
    const r = await tinkerChat.callTinkerChat({ ...input, ...bad })
    assert.deepEqual([r.ok, r.kind, r.maybeServed], [false, 'not_configured', false], JSON.stringify(bad))
  }
  assert.equal(sent.length, 0)
  assert.equal((await tinkerChat.callTinkerChat({ ...input, baseModel: BASE })).ok, true)
  assert.equal(sent[0].body.model, BASE)
  assert.equal((await tinkerChat.callTinkerChat({ ...input, samplerPath: SAMPLER })).ok, true)
  assert.equal(sent[1].body.model, SAMPLER)
})

test('a comparison calls both models at once with the right bodies, and never lets one side stop the other', async () => {
  enableChat()
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent, async (_r, isBase) => { await sleep(60); return completion({ content: isBase ? 'Base says hello.' : 'Trained says hello.' }) })
  const history = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'trained earlier' }]
  const res = await visit({ adapter: slug, messages: [...history, { role: 'user', content: 'two' }], compare: true, base_replies: ['base earlier'] })
  assert.equal(res.code, 200)
  assert.equal(sent.length, 2)
  const trained = sent.find(s => !s.isBase)
  const base = sent.find(s => s.isBase)
  // Overlap: each started before the other finished.
  assert.ok(trained.started < base.ended && base.started < trained.ended, 'the two calls did not run together')
  assert.deepEqual(trained.body, { model: SAMPLER, messages: [...history, { role: 'user', content: 'two' }], max_completion_tokens: 200, temperature: 0.7, reasoning_effort: false })
  assert.deepEqual(base.body, { ...trained.body, model: BASE, messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'base earlier' }, { role: 'user', content: 'two' }] })
  assert.equal(base.headers.Authorization, `Bearer ${TINKER_KEY}`)

  // A timeout on the untrained side does not stop the trained answer, and the other way round.
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => { if (isBase) throw timeout(); return completion({ content: 'Trained alone.' }) })
  const a = await visit(compareAsk(slug), { ip: freshIp() })
  assert.equal(a.code, 200)
  assert.deepEqual([a.body.trained.ok, a.body.trained.reply, a.body.untrained.ok], [true, 'Trained alone.', false])
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => { if (!isBase) throw timeout(); return completion({ content: 'Base alone.' }) })
  const b = await visit(compareAsk(slug), { ip: freshIp() })
  assert.deepEqual([b.code, b.body.trained.ok, b.body.untrained.ok, b.body.untrained.reply], [200, false, true, 'Base alone.'])
})

test('response shapes: a normal turn is unchanged, a pair, a half pair and a failed pair', async () => {
  enableChat()
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => completion({ content: isBase ? '  Base reply.  ' : '  Trained reply.  ' }))

  const plain = await visit(ask(slug), { ip: freshIp() })
  assert.deepEqual(plain.body, { adapter: slug, reply: 'Trained reply.', cut_short: false, turns_left: 7 })
  assert.deepEqual(Object.keys(plain.body), ['adapter', 'reply', 'cut_short', 'turns_left'])

  const pair = await visit(compareAsk(slug), { ip: freshIp() })
  assert.equal(pair.code, 200)
  assert.deepEqual(pair.body, {
    adapter: slug, compare: true, base_model: BASE,
    trained: { ok: true, reply: 'Trained reply.', cut_short: false }, untrained: { ok: true, reply: 'Base reply.', cut_short: false }, turns_left: 7,
  })
  // Turn two of a comparison: turns_left follows the turn, as for a normal one.
  const second = await visit(ask(slug, 'two', [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a' }], ['b']), { ip: freshIp() })
  assert.equal(second.body.turns_left, 6)

  // The untrained side is cut short and cleaned like the trained one.
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => completion({ content: isBase ? `x ${TINKER_KEY} ${'z'.repeat(3000)}` : '', finish_reason: isBase ? 'length' : 'stop' }))
  const cut = await visit(compareAsk(slug), { ip: freshIp() })
  assert.equal(cut.body.untrained.reply.length, trainedChat.TRAINED_CHAT_MAX_REPLY_CHARS)
  assert.equal(cut.body.untrained.reply.includes(TINKER_KEY), false)
  assert.equal(cut.body.untrained.cut_short, true)
  assert.equal(cut.body.trained.reply, '(the model gave an empty reply)')

  // One side fails: HTTP 200, the good answer stays, the failed side has the plain busy message.
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => (isBase ? new Response('{"error":{"message":"overloaded"}}', { status: 503 }) : completion()))
  const half = await visit(compareAsk(slug), { ip: freshIp() })
  assert.equal(half.code, 200)
  assert.deepEqual(half.body.untrained, { ok: false, error: 'busy', message: 'The untrained model did not answer. It may not be available.' })
  assert.equal(half.body.trained.ok, true)

  // Both fail: the old failure shape, 502, or 504 when both timed out.
  globalThis.fetch = fakeTinker(sent, () => new Response('{}', { status: 500 }))
  const both = await visit(compareAsk(slug), { ip: freshIp() })
  assert.deepEqual([both.code, both.body], [502, { error: 'busy', message: 'The model did not answer this time. Please try again in a moment.' }])
  globalThis.fetch = async () => { throw timeout() }
  const slow = await visit(compareAsk(slug), { ip: freshIp() })
  assert.deepEqual([slow.code, slow.body.error], [504, 'busy'])
  // One timed out and one refused: not both timeouts, so 502.
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => { if (isBase) throw refused(); throw timeout() })
  assert.equal((await visit(compareAsk(slug), { ip: freshIp() })).code, 502)
})

test('with the switch off a comparison is refused before anything is counted or spent, and a normal turn is as before', async () => {
  enableChat({ LAB_ENABLE_TRAINED_CHAT_COMPARE: 'off' })
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent)
  const refusedCompare = await visit(compareAsk(slug), { ip: freshIp() })
  assert.deepEqual([refusedCompare.code, refusedCompare.body], [403, { error: 'compare_off', message: 'Comparing with the untrained model is switched off.' }])
  assert.equal(lab.rate.size, 0)
  assert.equal(lab.spendDays.size, 0)
  assert.deepEqual([sent.length, lab.chatCalls.length, lab.modelCalls.length], [0, 0, 0])
  const normal = await visit(ask(slug), { ip: freshIp() })
  assert.deepEqual(normal.body, { adapter: slug, reply: 'Answer number 3.', cut_short: false, turns_left: 7 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].isBase, false)
  // The larger body size belongs to a comparison only.
  const big = { adapter: slug, messages: [{ role: 'user', content: 'x'.repeat(100) }], pad: 'y'.repeat(trainedChat.TRAINED_CHAT_MAX_BODY_BYTES) }
  assert.equal((await visit(big)).code, 413)
  process.env.LAB_ENABLE_TRAINED_CHAT_COMPARE = 'true'
  assert.equal((await visit({ ...big, compare: true, base_replies: [] })).code, 400) // within 28 KiB, so read, then refused for the unknown key
  assert.equal((await visit({ ...big, pad: 'y'.repeat(trainedChat.TRAINED_CHAT_COMPARE_MAX_BODY_BYTES), compare: true, base_replies: [] })).code, 413)
})

test('a comparison counts as two messages, and a refusal on the second is a rate refusal', async () => {
  enableChat()
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent)
  const address = store.addressHash(IP)
  const day = `d:${store.utcDay()}`
  await visit(ask(slug))
  assert.equal(lab.rate.get(`${address}|${day}`), 1)
  await visit(compareAsk(slug))
  assert.equal(lab.rate.get(`${address}|${day}`), 3)
  // An address with one message of the window left is refused on the second pass, with no call made.
  for (const key of [...lab.rate.keys()]) lab.rate.delete(key)
  const windowKey = `${address}|w:${Math.floor(Date.now() / 1000 / trainedChat.TRAINED_CHAT_WINDOW_S)}`
  lab.rate.set(windowKey, trainedChat.TRAINED_CHAT_ADDRESS_PER_WINDOW - 1)
  sent.length = 0
  lab.spendDays.clear()
  const limited = await visit(compareAsk(slug))
  assert.deepEqual([limited.code, limited.body.error, limited.headers['Retry-After']], [429, 'rate', '600'])
  assert.equal(sent.length, 0)
  assert.equal(lab.spendDays.size, 0)
  // A single message with the same room left still goes through.
  for (const key of [...lab.rate.keys()]) lab.rate.delete(key)
  lab.rate.set(windowKey, trainedChat.TRAINED_CHAT_ADDRESS_PER_WINDOW - 1)
  assert.equal((await visit(ask(slug))).code, 200)
  // One visitor (an address with one browser string) can ask only half as many comparisons as questions.
  for (const key of [...lab.rate.keys()]) lab.rate.delete(key)
  sent.length = 0
  for (let i = 0; i < trainedChat.TRAINED_CHAT_PER_WINDOW / 2; i++) assert.equal((await visit(compareAsk(slug, `q${i}`))).code, 200)
  assert.equal((await visit(compareAsk(slug, 'one more'))).code, 429)
  assert.equal(sent.length, trainedChat.TRAINED_CHAT_PER_WINDOW)
})

test('money: both calls are set aside under both caps first, charged by the usual rules, and settled once with the sum', async () => {
  enableChat()
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent)
  const reserved = () => lab.statements.filter(s => s.text.startsWith('UPDATE tinker_spend_days SET reserved_usd = reserved_usd + ?'))
  const settled = () => lab.statements.filter(s => s.text.startsWith('UPDATE tinker_spend_days SET reserved_usd = GREATEST(0, reserved_usd - ?)'))
  const history = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'trained earlier reply' }]
  const body = { adapter: slug, messages: [...history, { role: 'user', content: 'two' }], compare: true, base_replies: ['a rather different untrained reply'] }
  const req = trainedChat.readChatRequest(body)
  const worstT = tinker.tinkerChatWorstCaseUsd(BASE, req.messages, 200)
  const worstB = tinker.tinkerChatWorstCaseUsd(BASE, req.baseMessages, 200)
  assert.notEqual(worstT, worstB)

  const res = await visit(body)
  assert.equal(res.code, 200)
  const holds = reserved().map(s => [s.values[2], s.values[0]])
  assert.deepEqual(holds.map(h => h[0]), ['chat', 'all'])
  for (const [, amount] of holds) assert.ok(Math.abs(amount - (worstT + worstB)) < 2e-6 && amount >= worstT + worstB - 1e-12, 'the hold is not the worst case of both calls')
  const measured = tinker.tinkerChatCostUsd(BASE, 20, 8)
  // One settlement per scope, with the same sum, and nothing left set aside.
  assert.equal(settled().length, 2)
  for (const s of settled()) assert.ok(Math.abs(s.values[1] - 2 * measured) < 3e-6, `settled ${s.values[1]}`)
  for (const scope of ['chat', 'all']) {
    assert.equal(lab.spend(scope).reserved_usd, 0)
    assert.ok(Math.abs(lab.spend(scope).spent_usd - 2 * measured) < 3e-6)
  }

  // Both answer without usable counts: each call is counted at its own worst case.
  lab.spendDays.clear()
  lab.modelCalls = []
  globalThis.fetch = fakeTinker(sent, () => { const c = completion(); delete c.usage; return c })
  assert.equal((await visit(body, { ip: freshIp() })).code, 200)
  assert.ok(Math.abs(lab.spend('chat').spent_usd - (worstT + worstB)) < 3e-6)
  assert.equal(lab.spend('chat').reserved_usd, 0)

  // The untrained call certainly was not served (an error status): it costs 0 and the trained reply is kept.
  lab.spendDays.clear()
  lab.modelCalls = []
  lab.chatCalls = []
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => (isBase ? new Response('{"error":{"message":"no such model"}}', { status: 404 }) : completion()))
  const half = await visit(body, { ip: freshIp() })
  assert.deepEqual([half.code, half.body.trained.ok, half.body.untrained.ok], [200, true, false])
  assert.ok(Math.abs(lab.spend('all').spent_usd - measured) < 2e-6, 'a failed base call must not be charged, and the trained one only once')
  assert.deepEqual(lab.modelCalls.map(c => c.model_id), [`lab/${slug}`])
  assert.deepEqual(lab.chatCalls.map(c => [c.status, c.cost_usd > 0]), [['ok', true], ['base_upstream', false]])
  assert.equal(lab.spend('all').reserved_usd, 0)

  // The untrained call may have been served (a timeout): counted at its worst case; the trained reply is kept.
  lab.spendDays.clear()
  lab.modelCalls = []
  lab.chatCalls = []
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => { if (isBase) throw timeout(); return completion() })
  assert.equal((await visit(body, { ip: freshIp() })).body.trained.ok, true)
  assert.ok(Math.abs(lab.spend('chat').spent_usd - (measured + worstB)) < 3e-6)
  assert.deepEqual(lab.chatCalls.map(c => c.status), ['ok', 'base_timeout'])

  // Both fail for certain: nothing is counted and nothing is left set aside.
  lab.spendDays.clear()
  lab.modelCalls = []
  globalThis.fetch = async () => { throw refused() }
  assert.equal((await visit(body, { ip: freshIp() })).code, 502)
  for (const scope of ['chat', 'all']) assert.deepEqual([lab.spend(scope).spent_usd, lab.spend(scope).reserved_usd], [0, 0])
})

test('money: a budget that covers one reply but not two refuses the comparison, makes no call, and never passes a cap', async () => {
  const slug = lab.addAdapter()
  const body = compareAsk(slug)
  const req = trainedChat.readChatRequest(body)
  const worstOne = tinker.tinkerChatWorstCaseUsd(BASE, req.messages, 200)
  const worstTwo = worstOne + tinker.tinkerChatWorstCaseUsd(BASE, req.baseMessages, 200)
  const sent = []
  globalThis.fetch = fakeTinker(sent)

  // The chat's own cap holds one worst case but not two.
  enableChat({ LAB_TINKER_CHAT_DAILY_USD: String(worstOne * 1.5) })
  const refusedChat = await visit(body, { ip: freshIp() })
  assert.deepEqual([refusedChat.code, refusedChat.body.error], [429, 'budget'])
  assert.equal(refusedChat.body.message, "The lab's chat budget for today can cover one reply but may not cover two. Turn off the comparison to ask one question, or try again after 00:00 UTC.")
  assert.equal(sent.length, 0)
  assert.deepEqual([lab.spend('chat').reserved_usd, lab.spend('all').reserved_usd], [0, 0])
  // A normal question still fits under the very same cap.
  assert.equal((await visit(ask(slug), { ip: freshIp() })).code, 200)

  // The whole Tinker cap holds one but not two: the chat hold is given back.
  lab.spendDays.clear()
  sent.length = 0
  process.env.LAB_TINKER_CHAT_DAILY_USD = '1'
  process.env.LAB_TINKER_DAILY_USD = String(worstOne * 1.5)
  const refusedAll = await visit(body, { ip: freshIp() })
  assert.deepEqual([refusedAll.code, refusedAll.body.error], [429, 'budget'])
  assert.equal(lab.spend('chat').reserved_usd, 0)
  assert.equal(lab.spend('all').reserved_usd, 0)
  assert.equal(sent.length, 0)

  // Many comparisons against a cap that holds three of them: never past the cap, then refused.
  lab.spendDays.clear()
  const cap = worstTwo * 3 + 1e-6
  process.env.LAB_TINKER_CHAT_DAILY_USD = String(cap)
  process.env.LAB_TINKER_DAILY_USD = String(cap)
  // Every call is counted at its worst case here, the most the caps ever have to hold.
  globalThis.fetch = fakeTinker(sent, () => { const c = completion(); delete c.usage; return c })
  const codes = []
  for (let i = 0; i < 6; i++) {
    codes.push((await visit(body, { ip: freshIp() })).code)
    for (const scope of ['chat', 'all']) {
      const row = lab.spend(scope)
      assert.ok(row.spent_usd + row.reserved_usd <= cap + 1e-9, `${scope} passed its cap`)
      assert.equal(row.reserved_usd, 0)
    }
  }
  assert.deepEqual(codes, [200, 200, 200, 429, 429, 429])
  assert.equal(sent.length, 6)

  // The lab's own daily budget gates a comparison first, as for any call.
  lab.spendDays.clear()
  delete process.env.LAB_TINKER_CHAT_DAILY_USD
  delete process.env.LAB_TINKER_DAILY_USD
  lab.modelCalls.push({ purpose: 'epoch', cost_usd: 15, created_at: new Date() })
  sent.length = 0
  const lab15 = await visit(body, { ip: freshIp() })
  assert.deepEqual([lab15.code, lab15.body.error], [429, 'budget'])
  assert.equal(sent.length, 0)
})

test('a comparison leaves two ledger rows and two count rows, and no text anywhere', async () => {
  enableChat()
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => completion({ content: isBase ? 'untrained secret reply' : 'trained secret reply' }))
  const history = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'trained earlier' }]
  const res = await visit({ adapter: slug, messages: [...history, { role: 'user', content: TEXT }], compare: true, base_replies: ['untrained earlier'] })
  assert.equal(res.code, 200)
  assert.deepEqual(lab.modelCalls.map(c => [c.experiment_id, c.epoch_number, c.purpose, c.model_id, c.assigned_model_id, c.cost_source]), [
    [null, null, 'trained_chat', `lab/${slug}`, `tinker:${BASE}`, 'estimate'],
    [null, null, 'trained_chat', BASE, `tinker:${BASE}`, 'estimate'],
  ])
  assert.deepEqual(lab.chatCalls.map(c => [c.slug, c.status, c.turns, c.prompt_tokens, c.completion_tokens]), [[slug, 'ok', 2, 20, 8], [slug, 'base_ok', 2, 20, 8]])
  assert.ok(lab.chatCalls[0].cost_usd > 0 && lab.chatCalls[1].cost_usd > 0)
  // The count rows hold characters of what each side was sent, not what was said.
  assert.equal(lab.chatCalls[0].prompt_chars, 'one'.length + 'trained earlier'.length + TEXT.length)
  assert.equal(lab.chatCalls[1].prompt_chars, 'one'.length + 'untrained earlier'.length + TEXT.length)
  const kept = JSON.stringify([lab.statements.map(s => s.values), lab.chatCalls, lab.modelCalls, [...lab.rate.keys()], logs])
  for (const secret of [TEXT, 'marmalade', 'trained secret reply', 'untrained secret reply', 'untrained earlier', IP, 'TestBrowser', TINKER_KEY]) {
    assert.equal(kept.includes(secret), false, `"${secret}" was stored or logged`)
  }
  // The log carries kinds and statuses only, one line per failed side.
  logs = []
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => (isBase ? new Response(`{"error":{"message":"bad ${TEXT}"}}`, { status: 400 }) : completion()))
  await visit(compareAsk(slug), { ip: freshIp() })
  assert.deepEqual(logs, ['[trained-chat] no untrained reply (upstream, 400)'])
  assert.equal(logs.join('').includes(TEXT), false)
})

test('source: only tinker-chat.ts reads the Tinker key, and the new visitor strings have no dash', () => {
  const reads = []
  const scan = dir => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) scan(p)
      else if (p.endsWith('.ts') && /process\.env\.TINKER_API_KEY/.test(readFileSync(join(root, p), 'utf8'))) reads.push(p.replaceAll('\\', '/'))
    }
  }
  scan('api')
  assert.deepEqual(reads, ['api/_lib/tinker-chat.ts'])
  const source = readFileSync(join(root, 'api/_lib/trained-chat.ts'), 'utf8')
  const strings = source.match(/(?:budgetCompare|compareOff): '[^\n]*'/g) ?? []
  assert.equal(strings.length, 2)
  for (const s of strings) assert.equal(/[–—]/.test(s), false)
  assert.equal(/[–—]/.test(source), false, 'a dash in trained-chat.ts')
})

// ---- review fixes: retrying one side, the budget edge, the index and pruning ----

const rateTotal = () => [...lab.rate.entries()].filter(([k]) => k.includes('|w:')).reduce((n, [, c]) => n + c, 0)

test('retrying one side asks only that side, counts one message and sets aside only that side', async () => {
  enableChat()
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent, (_r, isBase) => completion({ content: isBase ? 'Base again.' : 'Trained again.' }))
  const only = (side, extra = {}) => ({ ...compareAsk(slug), only: side, ...extra })

  const a = await visit(only('untrained'), { ip: freshIp() })
  assert.equal(a.code, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].isBase, true)
  assert.deepEqual(a.body.untrained, { ok: true, reply: 'Base again.', cut_short: false })
  assert.equal(a.body.trained.ok, false)
  assert.equal(a.body.trained.error, 'skipped')
  // One message counted at the address and one at the visitor, not two each.
  assert.equal(rateTotal(), 2) // the ten minute window, address and visitor, one pass
  assert.deepEqual(lab.chatCalls.map(c => c.status), ['base_ok'])

  sent.length = 0
  const b = await visit(only('trained'), { ip: freshIp() })
  assert.equal(b.code, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].isBase, false)
  assert.equal(b.body.trained.reply, 'Trained again.')
  assert.equal(b.body.untrained.error, 'skipped')
  assert.deepEqual(lab.chatCalls.map(c => c.status), ['base_ok', 'ok'])

  // A retry that fails says so with the untrained message and counts like a call.
  globalThis.fetch = fakeTinker(sent, () => new Response('{"error":{"message":"no such model"}}', { status: 404 }))
  const c = await visit(only('untrained'), { ip: freshIp() })
  assert.deepEqual([c.code, c.body.message], [502, 'The untrained model did not answer. It may not be available.'])
})

test('"only" is accepted only with compare, and only with a known side', async () => {
  enableChat()
  const slug = lab.addAdapter()
  const read = trainedChat.readChatRequest
  assert.equal(read({ adapter: slug, messages: [{ role: 'user', content: 'x' }], only: 'trained' }).ok, false)
  assert.equal(read({ adapter: slug, messages: [{ role: 'user', content: 'x' }], compare: true, base_replies: [], only: 'both' }).ok, false)
  assert.equal(read({ adapter: slug, messages: [{ role: 'user', content: 'x' }], compare: true, base_replies: [], only: 'trained' }).only, 'trained')
  assert.equal(read({ adapter: slug, messages: [{ role: 'user', content: 'x' }], compare: true, base_replies: [] }).only, null)
})

test('the lab budget check asks that the call\'s worst case still fits, so parallel calls at the edge are refused', async () => {
  enableChat({ LAB_DAILY_BUDGET_USD: '1' })
  const slug = lab.addAdapter()
  const sent = []
  globalThis.fetch = fakeTinker(sent)
  // $0.0000001 left: the old check (spent >= budget) let this through.
  lab.modelCalls.push({ cost_usd: 0.9999999, created_at: new Date() })
  const r = await visit(compareAsk(slug), { ip: freshIp() })
  assert.equal(r.code, 429)
  assert.equal(sent.length, 0)
  assert.equal(lab.chatCalls.length, 0)
})

test('the room signal reads use an index, and call rows older than thirty days are pruned', async () => {
  enableChat()
  // The tables are made once per process, so read the statement from the source.
  assert.match(readFileSync(join(root, 'api/_lib/tinker-store.ts'), 'utf8'), /CREATE INDEX IF NOT EXISTS idx_trained_chat_calls_ok ON trained_chat_calls\(created_at DESC\) WHERE status = 'ok'/)
  const day = 86400_000
  lab.chatCalls.push({ slug: 'e1-00000000', status: 'ok', created_at: new Date(Date.now() - 31 * day) }, { slug: 'e2-00000000', status: 'ok', created_at: new Date(Date.now() - 29 * day) })
  await store.pruneVisitorCounts(new Date())
  assert.deepEqual(lab.chatCalls.map(c => c.slug), ['e2-00000000'])
})
