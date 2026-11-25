// Conversations visitors offer to the lab (api/_lib/visitor-offers.ts, spec Part 2):
// the switch, the receipt chain in the chat, the offer route and every answer it
// gives, the screening, what is and is not stored, taking an offer back, expiry,
// reading offers for a run (the one-statement claim), the owner's route, the
// consent claims, and the text the models are told.
//
// No network, no database, no secrets (tests/fixtures/chat-harness.mjs).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const offers = await load('api/_lib/visitor-offers.js')
const offerStore = await load('api/_lib/visitor-offers-store.js')
const { default: chatRoute } = await load('api/experiment/trained-chat.js')
const { default: offerRoute } = await load('api/experiment/chat-offer.js')
const { default: ownerRoute } = await load('api/experiment/visitor-offers.js')

const OPERATOR = 'test-only-operator-secret-000000000000000000'
const CRON = 'test-only-scheduler-secret-0000000000'
const SLUG = 'e41-0a1b2c3d'
const VISITOR_SLUG = 'e42-0b1c2d3e'
const IP = '203.0.113.77'
const UA = 'TestBrowser/1.0'

/** The fake database: the chat's tables (FakeDb) and visitor_offers. */
class OfferDb extends FakeDb {
  constructor(storeModule) {
    super(storeModule)
    this.offers = []
    this.offerInserts = []
    this.failOffers = false
    this.nextOffer = 1
  }

  seedOffer({ day = '2026-11-20', adapter = SLUG, messages, fromVisitors = false, status = 'stored', code = null } = {}) {
    const id = `10000000-0000-4000-8000-${String(this.nextOffer++).padStart(12, '0')}`
    this.offers.push({
      id, day, adapter_slug: adapter, base_model: BASE, messages: messages ?? convo(id), turns: 1, chars: 10, transcript_sha256: `t-${id}`,
      code_sha256: code ?? `c-${id}`, status, screen_v: 1, first_user_sha256: `f-${id}`, adapter_from_visitors: fromVisitors, used_in: [], read_at: null,
      expires_at: '2027-06-01T00:00:00.000Z',
    })
    return id
  }

  usable(adapter) {
    return this.offers.filter(o => o.status === 'stored' && !o.adapter_from_visitors && o.messages !== null && (adapter === undefined || o.adapter_slug === adapter))
  }

  handle(text, v) {
    if (!/visitor_offers/.test(text) || /^(CREATE|ALTER)\b/.test(text)) return super.handle(text, v)
    this.statements.push({ text, values: v })
    if (this.failOffers) throw new Error('offers table down')
    const ids = csv => new Set(String(csv).split(','))
    if (text === "SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored'") return { rows: [{ n: String(this.offers.filter(o => o.status === 'stored').length) }] }
    if (text === "SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored' AND adapter_slug = ?") return { rows: [{ n: String(this.offers.filter(o => o.status === 'stored' && o.adapter_slug === v[0]).length) }] }
    if (text === "SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored' AND adapter_from_visitors = FALSE AND messages IS NOT NULL") return { rows: [{ n: String(this.usable().length) }] }
    if (text === "SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored' AND adapter_from_visitors = FALSE AND messages IS NOT NULL AND adapter_slug = ?") return { rows: [{ n: String(this.usable(v[0]).length) }] }
    if (text.startsWith('INSERT INTO visitor_offers (day, adapter_slug, base_model, messages, turns, chars, transcript_sha256, code_sha256, status, screen_v, first_user_sha256, adapter_from_visitors, expires_at) VALUES')) {
      this.offerInserts.push({ text, values: v })
      const [day, adapter_slug, base_model, messages, turns, chars, transcript_sha256, code_sha256, status, screen_v, first_user_sha256, adapter_from_visitors, expires_at] = v
      const clash = this.offers.some(o => o.transcript_sha256 === transcript_sha256 || o.code_sha256 === code_sha256 ||
        (o.status === 'stored' && status === 'stored' && o.adapter_slug === adapter_slug && o.first_user_sha256 === first_user_sha256))
      if (clash) return { rows: [] }
      const id = `20000000-0000-4000-8000-${String(this.nextOffer++).padStart(12, '0')}`
      this.offers.push({ id, day, adapter_slug, base_model, messages: JSON.parse(messages), turns, chars, transcript_sha256, code_sha256, status, screen_v, first_user_sha256, adapter_from_visitors, used_in: [], read_at: null, expires_at })
      return { rows: [{ id }] }
    }
    if (text.startsWith("UPDATE visitor_offers SET messages = NULL, status = CASE WHEN status = 'stored' THEN 'withdrawn' ELSE status END WHERE code_sha256 = ? RETURNING used_in")) {
      const o = this.offers.find(x => x.code_sha256 === v[0])
      if (!o) return { rows: [] }
      o.messages = null
      if (o.status === 'stored') o.status = 'withdrawn'
      return { rows: [{ used_in: [...o.used_in] }] }
    }
    if (text.startsWith("SELECT id, day FROM visitor_offers WHERE status = 'stored' AND adapter_from_visitors = FALSE AND messages IS NOT NULL")) {
      return { rows: this.usable(text.endsWith('adapter_slug = ?') ? v[0] : undefined).map(o => ({ id: o.id, day: o.day })) }
    }
    if (text.startsWith("UPDATE visitor_offers SET used_in = used_in || to_jsonb(?::text) WHERE id::text = ANY(string_to_array(?, ',')) AND status = 'stored' AND adapter_from_visitors = FALSE AND messages IS NOT NULL RETURNING id, day, messages")) {
      const want = ids(v[1])
      const rows = []
      for (const o of this.usable()) {
        if (!want.has(o.id)) continue
        o.used_in = [...o.used_in, v[0]]
        rows.push({ id: o.id, day: o.day, messages: o.messages })
      }
      return { rows: rows.reverse() }
    }
    if (text.startsWith("UPDATE visitor_offers SET used_in = used_in - ?::text WHERE id::text = ANY(string_to_array(?, ','))")) {
      const want = ids(v[1])
      for (const o of this.offers) if (want.has(o.id)) o.used_in = o.used_in.filter(x => x !== v[0])
      return { rows: [] }
    }
    if (text === 'UPDATE visitor_offers SET used_in = used_in - ?::text WHERE used_in ? ?::text') {
      for (const o of this.offers) if (o.used_in.includes(v[1])) o.used_in = o.used_in.filter(x => x !== v[0])
      return { rows: [] }
    }
    if (text === 'UPDATE visitor_offers SET used_in = (used_in - ?::text) || to_jsonb(?::text) WHERE used_in ? ?::text') {
      for (const o of this.offers) if (o.used_in.includes(v[2])) o.used_in = [...o.used_in.filter(x => x !== v[0]), v[1]]
      return { rows: [] }
    }
    if (text.startsWith('SELECT COUNT(*) FILTER')) {
      return { rows: [{
        stored: this.offers.filter(o => o.status === 'stored').length, offered_today: this.offers.filter(o => o.day === v[0]).length,
        trained_on: this.offers.filter(o => o.used_in.length).length, taken_back: this.offers.filter(o => o.status === 'withdrawn').length,
        read_by_owner: this.offers.filter(o => o.read_at).length,
      }] }
    }
    if (text.startsWith("UPDATE visitor_offers SET messages = NULL, status = 'expired' WHERE status = 'stored' AND expires_at < ? RETURNING id")) {
      const rows = []
      for (const o of this.offers) if (o.status === 'stored' && new Date(o.expires_at) < new Date(v[0])) { o.messages = null; o.status = 'expired'; rows.push({ id: o.id }) }
      return { rows }
    }
    if (text.startsWith('UPDATE visitor_offers SET read_at = COALESCE(read_at, NOW()) WHERE id IN ( SELECT id FROM visitor_offers WHERE messages IS NOT NULL')) {
      const [before, , limit] = v
      const pick = this.offers.filter(o => o.messages !== null && (before === '' || o.day < before))
        .sort((a, b) => (a.day === b.day ? (a.id < b.id ? 1 : -1) : a.day < b.day ? 1 : -1)).slice(0, limit)
      for (const o of pick) o.read_at ??= new Date().toISOString()
      return { rows: pick.map(o => ({ ...o })) }
    }
    if (text === "UPDATE visitor_offers SET messages = NULL, status = 'deleted' WHERE id::text = ? AND messages IS NOT NULL RETURNING id") {
      const o = this.offers.find(x => x.id === v[0] && x.messages !== null)
      if (!o) return { rows: [] }
      o.messages = null
      o.status = 'deleted'
      return { rows: [{ id: o.id }] }
    }
    if (text === "UPDATE visitor_offers SET messages = NULL, status = 'deleted' WHERE messages IS NOT NULL RETURNING id") {
      const rows = []
      for (const o of this.offers) if (o.messages !== null) { o.messages = null; o.status = 'deleted'; rows.push({ id: o.id }) }
      return { rows }
    }
    throw new Error(`unexpected offers query: ${text.slice(0, 160)}`)
  }
}

/** A plain conversation that passes the screening. */
function convo(tag = 'x', turns = 1, opts = {}) {
  const out = []
  for (let t = 0; t < turns; t++) {
    out.push({ role: 'user', content: opts.user?.(t) ?? `Tell me about marmalade and oranges, part ${tag} ${t} please` })
    out.push({ role: 'assistant', content: opts.reply?.(t) ?? `Seville oranges give a bitter jam that sets well with sugar and lemon (${tag} ${t}).` })
  }
  return out
}

let lab
let replyCount = 0
beforeEach(() => {
  process.env = { ...BASE_ENV }
  logs = []
  lab = new OfferDb(store)
  db.handler = (text, values) => lab.handle(text, values)
  globalThis.fetch = async url => { throw new Error(`Unexpected outbound request to ${url}`) }
})

function enableChat(extra = {}) {
  Object.assign(process.env, { LAB_ENABLE_TRAINED_CHAT: 'true', TINKER_API_KEY: TINKER_KEY, CRON_SECRET: CRON, ...extra })
}
/** fetch that answers like Tinker, with a new reply every call. */
function fakeTinker(sent = [], answer = () => completion({ content: `A warm reply about gardens and the weather today, number ${++replyCount}.` })) {
  return async (url, options = {}) => {
    assert.equal(String(url), tinkerChat.TINKER_CHAT_URL)
    const body = JSON.parse(options.body)
    sent.push(body)
    const out = await answer(body, body.model !== SAMPLER)
    return out instanceof Response ? out : new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } })
  }
}
async function chat(body, { ip = IP, method = 'POST' } = {}) {
  const res = response()
  await chatRoute({ method, headers: { 'content-type': 'application/json', 'x-real-ip': ip, 'user-agent': UA }, query: {}, body }, res)
  return res
}
async function offer(body, { ip = IP, ua = UA, method = 'POST', contentType = 'application/json' } = {}) {
  const res = response()
  await offerRoute({ method, headers: { 'content-type': contentType, 'x-real-ip': ip, 'user-agent': ua }, query: {}, body }, res)
  return res
}
async function owner(body, { method = 'POST', query = {}, auth = `Bearer ${OPERATOR}` } = {}) {
  const res = response()
  await ownerRoute({ method, headers: { ...(auth === 'none' ? {} : { authorization: auth }), 'content-type': 'application/json' }, query, body }, res)
  return res
}
/** A conversation, offered with a receipt the lab signed for it. */
const signed = (messages, slug = SLUG, now = new Date()) => ({ adapter: slug, messages, receipt: offers.issueReceipt(slug, messages, now) })
let ipCounter = 0
const freshIp = () => `198.51.100.${(++ipCounter % 250) + 1}`

/** Talks to the chat turn by turn, sending back each receipt. */
async function converse(slug, texts) {
  let messages = []
  let receipt
  const answers = []
  for (const text of texts) {
    const body = { adapter: slug, messages: [...messages, { role: 'user', content: text }], ...(receipt ? { receipt } : {}) }
    const res = await chat(body)
    assert.equal(res.code, 200, JSON.stringify(res.body))
    answers.push(res.body)
    messages = [...body.messages, { role: 'assistant', content: res.body.reply }]
    receipt = res.body.receipt
  }
  return { messages, receipt, answers }
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

test('the switch is on unless false, 0, off or no, with spaces and capitals; the status needs the chat and a receipt key', () => {
  for (const value of [undefined, '', 'true', 'yes', '1', 'anything']) {
    if (value === undefined) delete process.env.LAB_ENABLE_VISITOR_OFFERS
    else process.env.LAB_ENABLE_VISITOR_OFFERS = value
    assert.equal(offers.visitorOffersFlag(), true, String(value))
  }
  for (const value of [' False ', '0', 'OFF', 'no', ' NO']) {
    process.env.LAB_ENABLE_VISITOR_OFFERS = value
    assert.equal(offers.visitorOffersFlag(), false, value)
  }
  delete process.env.LAB_ENABLE_VISITOR_OFFERS
  assert.match(offers.visitorOffersStatus().off_reason, /visitor chat is off/)
  enableChat()
  assert.deepEqual(offers.visitorOffersStatus(), { enabled: true })
  assert.match(offers.visitorOffersStatus({ models: true }).off_reason, /Tinker training is off/)
  process.env.LAB_ENABLE_VISITOR_OFFERS = 'off'
  assert.match(offers.visitorOffersStatus().off_reason, /LAB_ENABLE_VISITOR_OFFERS/)
  // The visitor adapter switch is read as exactly "true", like the dataset one.
  for (const [value, on] of [[undefined, false], ['1', false], ['yes', false], ['true', true], [' TRUE ', true]]) {
    if (value === undefined) delete process.env.LAB_TRAINED_CHAT_VISITOR_ADAPTERS
    else process.env.LAB_TRAINED_CHAT_VISITOR_ADAPTERS = value
    assert.equal(offers.visitorAdaptersFlag(), on, String(value))
  }
})

test('no receipt key without LAB_OPERATOR_SECRET or CRON_SECRET: never from POSTGRES_URL', async () => {
  enableChat({ POSTGRES_URL: 'postgres://test-only:placeholder@localhost/db' })
  delete process.env.CRON_SECRET
  delete process.env.LAB_OPERATOR_SECRET
  const messages = convo('k')
  assert.equal(offers.issueReceipt(SLUG, messages), null)
  assert.equal(offers.visitorOffersStatus().enabled, false)
  assert.match(offers.visitorOffersStatus().off_reason, /LAB_OPERATOR_SECRET nor CRON_SECRET/)
  // A receipt made with the database URL as the key does not verify either.
  process.env.CRON_SECRET = process.env.POSTGRES_URL
  const forged = offers.issueReceipt(SLUG, messages)
  delete process.env.CRON_SECRET
  assert.equal(offers.verifyReceipt(forged, SLUG, messages), false)
  // And the chat issues none and refuses "receipt" as an unknown key.
  lab.addAdapter({ slug: SLUG })
  globalThis.fetch = fakeTinker()
  const res = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Hello there, tell me about jam' }] })
  assert.equal(res.code, 200)
  assert.equal('receipt' in res.body, false)
  const refused = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Hello there' }], receipt: 'x' })
  assert.equal(refused.code, 400)
  // The source has no POSTGRES_URL in the receipt key.
  const source = readFileSync(join(root, 'api/_lib/visitor-offers.ts'), 'utf8')
  const keyFn = source.slice(source.indexOf('function receiptKey()'), source.indexOf('export function visitorOffersStatus'))
  assert.equal(keyFn.includes('POSTGRES_URL'), false)
})

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

test('the receipt: a chain of turns verifies; a changed reply, slug, day or a cut receipt does not', () => {
  enableChat()
  const now = new Date('2026-11-25T12:00:00Z')
  const one = convo('r', 1)
  const r1 = offers.issueReceipt(SLUG, one, now)
  assert.match(r1, /^2026-11-25\.[A-Za-z0-9_-]{43}$/)
  assert.ok(r1.length <= offers.RECEIPT_MAX_CHARS)
  assert.equal(offers.verifyReceipt(r1, SLUG, one, now), true)
  // Yesterday's receipt still verifies; the day before does not.
  assert.equal(offers.verifyReceipt(r1, SLUG, one, new Date('2026-11-26T23:59:00Z')), true)
  assert.equal(offers.verifyReceipt(r1, SLUG, one, new Date('2026-11-27T00:01:00Z')), false)
  // A receipt dated in the future (a changed day) does not verify.
  assert.equal(offers.verifyReceipt(r1.replace('2026-11-25', '2026-11-24'), SLUG, one, now), false)
  // A changed earlier reply, a changed slug, a cut receipt, a longer one.
  const changed = [one[0], { role: 'assistant', content: `${one[1].content} And something else.` }]
  assert.equal(offers.verifyReceipt(r1, SLUG, changed, now), false)
  assert.equal(offers.verifyReceipt(r1, 'e41-0a1b2c3e', one, now), false)
  assert.equal(offers.verifyReceipt(r1.slice(0, -1), SLUG, one, now), false)
  assert.equal(offers.verifyReceipt(`${r1}A`, SLUG, one, now), false)
  assert.equal(offers.verifyReceipt(42, SLUG, one, now), false)
  assert.equal(offers.verifyReceipt(`${r1}${'A'.repeat(80)}`, SLUG, one, now), false)
  // A different key does not verify.
  process.env.LAB_OPERATOR_SECRET = OPERATOR
  assert.equal(offers.verifyReceipt(r1, SLUG, one, now), false)
})

test('in the chat: the first turn gets a receipt, a chained turn gets one, a broken chain gets none', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  globalThis.fetch = fakeTinker()
  const { messages, receipt, answers } = await converse(SLUG, ['Tell me about marmalade please', 'And what about lemon curd then'])
  assert.ok(answers[0].receipt)
  assert.ok(receipt)
  assert.equal(offers.verifyReceipt(receipt, SLUG, messages), true)
  // The second turn with no receipt: the reply comes, with no receipt.
  const noChain = await chat({ adapter: SLUG, messages: [...messages.slice(0, 2), { role: 'user', content: 'Something else now' }] })
  assert.equal(noChain.code, 200)
  assert.equal('receipt' in noChain.body, false)
  // A changed earlier reply breaks the chain.
  const forged = [messages[0], { role: 'assistant', content: 'A reply the model never gave.' }, { role: 'user', content: 'Go on then' }]
  const broken = await chat({ adapter: SLUG, messages: forged, receipt: answers[0].receipt })
  assert.equal(broken.code, 200)
  assert.equal('receipt' in broken.body, false)
  // A malformed receipt is refused as a bad request.
  const bad = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Hi' }], receipt: 'r'.repeat(81) })
  assert.equal(bad.code, 400)
  // No receipt when the adapter did not answer.
  globalThis.fetch = fakeTinker([], () => new Response('busy', { status: 500 }))
  const busy = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Hello' }] })
  assert.equal(busy.code, 502)
  assert.equal('receipt' in busy.body, false)
})

test('in a comparison only the trained reply carries a receipt, and a retry of the untrained side has none', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  globalThis.fetch = fakeTinker()
  const res = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Tell me about marmalade' }], compare: true, base_replies: [] })
  assert.equal(res.code, 200)
  assert.ok(res.body.trained.receipt)
  assert.equal('receipt' in res.body.untrained, false)
  assert.equal(offers.verifyReceipt(res.body.trained.receipt, SLUG, [{ role: 'user', content: 'Tell me about marmalade' }, { role: 'assistant', content: res.body.trained.reply }]), true)
  const retry = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Tell me about marmalade' }], compare: true, base_replies: [], only: 'untrained' })
  assert.equal(retry.code, 200)
  assert.equal(JSON.stringify(retry.body).includes('receipt'), false)
})

test('with the switch off the chat answers byte for byte as before: no offers block, no receipt, and "receipt" is an unknown key', async () => {
  lab.addAdapter({ slug: SLUG })
  const run = async () => {
    replyCount = 0
    globalThis.fetch = fakeTinker()
    const get = await chat({}, { method: 'GET' })
    const one = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Tell me about marmalade' }] })
    replyCount = 10
    const pair = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Tell me about marmalade' }], compare: true, base_replies: [] })
    const withReceipt = await chat({ adapter: SLUG, messages: [{ role: 'user', content: 'Hello' }], receipt: 'x' })
    return { get, one, pair, withReceipt }
  }
  enableChat({ LAB_ENABLE_VISITOR_OFFERS: ' Off ' })
  const off = await run()
  assert.deepEqual(Object.keys(off.get.body), ['enabled', 'adapters', 'limits', 'notice', 'compare_enabled'])
  assert.equal(off.get.body.notice, trainedChat.TRAINED_CHAT_NOTICE)
  assert.equal(JSON.stringify(off.one.body), `{"adapter":"${SLUG}","reply":"A warm reply about gardens and the weather today, number 1.","cut_short":false,"turns_left":7}`)
  assert.deepEqual(Object.keys(off.pair.body.trained), ['ok', 'reply', 'cut_short'])
  assert.deepEqual(off.withReceipt.body, { error: 'invalid_request', message: 'Only "adapter", "messages", "compare", "base_replies" and "only" are accepted.' })

  // Switched on, the same requests give the same answers plus the new keys, and nothing else differs.
  process.env.LAB_ENABLE_VISITOR_OFFERS = 'true'
  const on = await run()
  const { offers: block, ...getRest } = on.get.body
  assert.deepEqual(block, { enabled: true, keep_days: 180, per_day: 3, public_text: false })
  assert.equal(JSON.stringify(getRest), JSON.stringify(off.get.body))
  const { receipt, ...oneRest } = on.one.body
  assert.ok(receipt)
  assert.equal(JSON.stringify(oneRest), JSON.stringify(off.one.body))
  const { receipt: pairReceipt, ...trainedRest } = on.pair.body.trained
  assert.ok(pairReceipt)
  assert.equal(JSON.stringify({ ...on.pair.body, trained: trainedRest }), JSON.stringify(off.pair.body))
  assert.equal(on.withReceipt.code, 200)
})

test('the offers block takes its numbers from the server switches, clamped', async () => {
  enableChat({ LAB_VISITOR_OFFERS_DAYS: '10' })
  assert.equal(offers.offersBlock().keep_days, 30)
  process.env.LAB_VISITOR_OFFERS_DAYS = '999'
  assert.equal(offers.offersBlock().keep_days, 365)
  process.env.LAB_VISITOR_OFFERS_DAYS = '90'
  const res = await chat({}, { method: 'GET' })
  assert.deepEqual(res.body.offers, { enabled: true, keep_days: 90, per_day: 3, public_text: false })
  process.env.LAB_VISITOR_OFFERS_MAX = '99999'
  assert.equal(offers.visitorOffersMax(), offers.OFFERS_HARD_MAX)
  process.env.LAB_VISITOR_OFFERS_PER_DAY = '5000'
  assert.equal(offers.visitorOffersPerDay(), 1000)
})

// ---------------------------------------------------------------------------
// The offer route
// ---------------------------------------------------------------------------

test('a whole visit: talk, offer with the last receipt, get a code shown once, take it back', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  globalThis.fetch = fakeTinker()
  const { messages, receipt } = await converse(SLUG, ['Tell me about marmalade please', 'And what about lemon curd then'])
  const res = await offer({ adapter: SLUG, messages, receipt })
  assert.equal(res.code, 201, JSON.stringify(res.body))
  assert.deepEqual(Object.keys(res.body), ['offered', 'code', 'kept_until', 'message'])
  assert.match(res.body.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.equal(res.body.message, 'Thank you. The lab stored this conversation.')
  assert.equal(res.headers['Cache-Control'], 'no-store')
  // The expiry is made from the day alone: the end of today plus 180 days.
  const day = store.utcDay()
  assert.equal(res.body.kept_until, new Date(Date.parse(`${day}T00:00:00Z`) + 181 * 86_400_000).toISOString())
  const row = lab.offers[0]
  assert.deepEqual(row.messages, messages)
  assert.equal(row.status, 'stored')
  assert.equal(row.turns, 2)
  assert.equal(row.day, day)
  assert.equal(row.adapter_from_visitors, false)
  // Only the code's hash is stored.
  assert.equal(JSON.stringify(lab.offers).includes(res.body.code), false)
  assert.equal(row.code_sha256, offers.codeSha256(offers.readOfferCode(res.body.code)))

  // Take it back, with the code typed in lower case and without dashes.
  const back = await offer({ withdraw: res.body.code.toLowerCase().replace(/-/g, '') })
  assert.equal(back.code, 200)
  assert.deepEqual(back.body, { withdrawn: true, trained_on: false, message: 'Done. The lab deleted the stored text.' })
  assert.equal(row.messages, null)
  assert.equal(row.status, 'withdrawn')
  assert.equal(lab.offers.length, 1, 'the row is kept as a count')
  // A second take back finds it again and keeps its status.
  assert.equal((await offer({ withdraw: res.body.code })).code, 200)
  assert.equal(row.status, 'withdrawn')
  // An unknown code.
  assert.deepEqual((await offer({ withdraw: 'ZZZZ-ZZZZ-ZZZZ' })).body, { error: 'unknown_code', message: 'The lab has no offer with that code.' })
  // Logs never carry what was written.
  for (const text of messages.map(m => m.content)) assert.equal(logs.join('\n').includes(text), false)
})

test('the offer route answers every status of its table', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  // 405, 415, 413, 400 (JSON and shape).
  assert.equal((await offer({}, { method: 'GET' })).code, 405)
  assert.equal((await offer(signed(convo('a')), { contentType: 'text/plain' })).code, 415)
  assert.equal((await offer({ ...signed(convo('a')), messages: [{ role: 'user', content: 'x'.repeat(40_000) }, { role: 'assistant', content: 'y' }] })).code, 413)
  const badJson = response()
  await offerRoute({ method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': IP }, query: {}, body: '{not json' }, badJson)
  assert.equal(badJson.code, 400)
  for (const body of [
    [], 'text', { adapter: SLUG, messages: convo('a') },
    { ...signed(convo('a')), extra: 1 },
    { ...signed(convo('a')), adapter: 'not a slug' },
    { ...signed(convo('a')), messages: convo('a').slice(0, 1) },
    { ...signed(convo('a')), messages: [...convo('a'), { role: 'user', content: 'and more' }] },
    { ...signed(convo('a')), messages: convo('a', 9) },
    { ...signed(convo('a')), messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] },
    { ...signed(convo('a')), messages: [{ role: 'user', content: 'x'.repeat(501) }, { role: 'assistant', content: 'b' }] },
    { ...signed(convo('a')), receipt: 5 },
    { withdraw: 'not a code' }, { withdraw: 'ZZZZ-ZZZZ-ZZZZ', extra: 1 },
  ]) {
    const res = await offer(body)
    assert.equal(res.code, 400, JSON.stringify(body).slice(0, 80))
    assert.ok(['invalid_request', 'too_long'].includes(res.body.error))
  }
  assert.equal(lab.offers.length, 0)
  // 403: no receipt that verifies.
  const old = signed(convo('b'), SLUG, new Date(Date.now() - 2 * 86_400_000))
  assert.deepEqual((await offer(old)).body, { error: 'not_verified', message: 'This conversation cannot be offered. Start a new one and offer that.' })
  const forgedReply = { ...signed(convo('b')), messages: [convo('b')[0], { role: 'assistant', content: 'Words the model never said at all.' }] }
  assert.equal((await offer(forgedReply)).code, 403)
  assert.equal((await offer({ ...signed(convo('b')), adapter: 'e41-0a1b2c3e' })).code, 403)
  // 404: no run with that slug.
  assert.equal((await offer(signed(convo('c'), 'e77-77777777'), { ip: freshIp() })).body.error, 'gone')
  // 201, then 409 for the same transcript, and for the same first message with other replies.
  assert.equal((await offer(signed(convo('d')), { ip: freshIp() })).code, 201)
  assert.deepEqual((await offer(signed(convo('d')), { ip: freshIp() })).body, { error: 'already_offered', message: 'This conversation was already offered.' })
  const sameFirst = [convo('d')[0], { role: 'assistant', content: 'A different reply about apricots and plums in summer.' }]
  assert.equal((await offer(signed(sameFirst), { ip: freshIp() })).code, 409)
  // 422 for each screen reason, and nothing kept.
  const before = lab.offers.length
  for (const [reason, text] of [['email', 'write to me at name (at) host.org about jam'], ['number', 'call me on 555 123 4567 tonight'], ['link', 'see www.jam for the recipe'], ['handle', 'find me as @jamlover on the forum'], ['short', 'hi']]) {
    const res = await offer(signed([{ role: 'user', content: text }, { role: 'assistant', content: 'Here is a reply about something quite different.' }]), { ip: freshIp() })
    assert.equal(res.code, 422, reason)
    assert.equal(res.body.error, 'screened')
    assert.equal(res.body.reason, reason)
    assert.equal(res.body.message, offers.OFFER_MESSAGES[reason])
  }
  assert.equal(lab.offers.length, before)
  // 503 unavailable when the database fails, with a fixed log line.
  lab.failOffers = true
  const down = await offer(signed(convo('e')), { ip: freshIp() })
  assert.deepEqual(down.body, { error: 'unavailable', message: 'The lab cannot take this just now. Please try again later.' })
  assert.equal(down.code, 503)
  assert.equal(logs.some(l => l.includes(convo('e')[0].content)), false)
})

test('switched off: an offer gets 503 without touching the database, a take back still works', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  const made = await offer(signed(convo('off')))
  assert.equal(made.code, 201)
  process.env.LAB_ENABLE_VISITOR_OFFERS = 'no'
  const count = lab.statements.length
  const res = await offer(signed(convo('off2')))
  assert.deepEqual(res.body, { error: 'off', message: 'Offering conversations to the lab is switched off.' })
  assert.equal(res.code, 503)
  assert.equal(lab.statements.length, count, 'no statement was sent')
  assert.equal((await offer({ withdraw: made.body.code })).body.withdrawn, true)
})

test('the limits: 3 a visitor, 6 an address, the store full, the day full, 20 an adapter, 10 take back tries', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  let n = 0
  const next = () => signed(convo(`lim${++n}`))
  for (let i = 0; i < 3; i++) assert.equal((await offer(next())).code, 201)
  assert.deepEqual((await offer(next())).body, { error: 'day', message: 'You have offered as many conversations as one visitor may today. Thank you.' })
  // Another browser string at the same address gets further, until the address limit of 6 holds.
  // The refused fourth try was counted for the address (as a refused chat message is), so 2 more pass.
  for (let i = 0; i < 2; i++) assert.equal((await offer(next(), { ua: 'Other/2' })).code, 201)
  assert.equal((await offer(next(), { ua: 'Third/3' })).body.error, 'day')
  assert.equal(lab.offers.length, 5)

  // Stored at one time.
  process.env.LAB_VISITOR_OFFERS_MAX = '5'
  assert.deepEqual((await offer(next(), { ip: freshIp() })).body, { error: 'full', message: 'The lab is not taking more conversations just now.' })
  process.env.LAB_VISITOR_OFFERS_MAX = '2000'
  // All offers a day: the counter holds today's 5; a cap of 6 lets one more in.
  process.env.LAB_VISITOR_OFFERS_PER_DAY = '6'
  assert.equal((await offer(next(), { ip: freshIp() })).code, 201)
  assert.equal((await offer(next(), { ip: freshIp() })).body.error, 'full')
  process.env.LAB_VISITOR_OFFERS_PER_DAY = '1000'
  // One adapter a day: 20.
  for (let i = lab.offers.length; i < 20; i++) assert.equal((await offer(next(), { ip: freshIp() })).code, 201)
  assert.deepEqual((await offer(next(), { ip: freshIp() })).body, { error: 'adapter_day', message: 'This model has been offered as many conversations as it can take today. Thank you.' })
  // Ten take back tries a day from one address.
  for (let i = 0; i < 10; i++) assert.equal((await offer({ withdraw: 'ZZZZ-ZZZZ-ZZZZ' }, { ip: '192.0.2.9' })).code, 404)
  const tries = await offer({ withdraw: 'ZZZZ-ZZZZ-ZZZZ' }, { ip: '192.0.2.9' })
  assert.equal(tries.code, 429)
})

test('nothing identifying is written on or beside an offer', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  const ip = '203.0.113.200'
  const ua = 'VeryDistinctiveBrowser/9.9 (an exact build string)'
  assert.equal((await offer(signed(convo('id')), { ip, ua })).code, 201)
  const secrets = [ip, ua, store.addressHash(ip), store.visitorHash(ip, ua), store.addressNetwork(ip)]
  assert.equal(lab.offerInserts.length, 1)
  for (const { text, values } of lab.statements.filter(s => s.text.includes('visitor_offers'))) {
    const all = `${text} ${JSON.stringify(values)}`
    for (const s of secrets) assert.equal(all.includes(s), false, `an offer statement holds ${s}`)
  }
  const insert = lab.offerInserts[0].text
  assert.equal(/created_at|address|agent|ip\b|session|cookie/i.test(insert), false)
  // The table has no such column either.
  const source = readFileSync(join(root, 'api/_lib/visitor-offers-store.ts'), 'utf8')
  const table = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS visitor_offers ('), source.indexOf('CREATE INDEX IF NOT EXISTS idx_visitor_offers_live'))
  assert.equal(/created_at|address|agent|session|cookie/i.test(table), false)
  // The per visitor counts are in the chat's rate table, by its hashes, under od: buckets.
  assert.ok([...lab.rate.keys()].some(k => k.startsWith(`${store.addressHash(ip)}|od:`)))
})

test('every claim of the consent text maps to a column, and every column is accounted for', () => {
  const source = readFileSync(join(root, 'api/_lib/visitor-offers-store.ts'), 'utf8')
  const table = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS visitor_offers ('), source.indexOf('CREATE INDEX IF NOT EXISTS idx_visitor_offers_live'))
  const lines = table.split('\n')
  const columns = lines.slice(1, lines.findIndex(l => l.trim() === ')')).map(l => l.trim().split(/\s+/)[0])
  for (const c of columns) assert.match(c, /^[a-z_0-9]+$/)
  assert.ok(columns.length >= 16)
  const claimed = new Set([...offers.OFFER_CLAIMS.flatMap(c => c.columns), ...offers.OFFER_BOOKKEEPING_COLUMNS])
  for (const column of columns) assert.ok(claimed.has(column), `no claim covers ${column}`)
  for (const column of claimed) assert.ok(columns.includes(column), `a claim names ${column}, which is not a column`)
  assert.ok(offers.OFFER_CLAIMS.some(c => /does not store your address/.test(c.claim) && c.columns.length === 0))
})

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

test('the screening patterns, each with cases that match and cases that pass', () => {
  const one = (user, reply = 'A quiet answer about the garden and the rain today.') => offers.screenOffer([{ role: 'user', content: user }, { role: 'assistant', content: reply }])
  const fine = 'How do I make a good bitter marmalade at home'
  assert.deepEqual(one(fine), { ok: true })
  const cases = {
    email: ['mail me at jane.doe@example.org now', 'write to name (at) host.org please', 'it is name [at] host.org ok', 'ｊａｎｅ＠ｅｘａｍｐｌｅ．ｏｒｇ full width'],
    number: ['call +44 20 7946 0958 tonight', 'my number is 555 123 4567 ok', 'the id is 123456789 here', 'card 4111-1111-1111-1111 stop'],
    link: ['see https://jam.test/x for it', 'go to www.recipes for jam', 'the site jamrecipes.com has it', 'ask at shop.co please'],
    handle: ['follow @jamlover for more', '@cook_42 knows the answer'],
  }
  for (const [reason, list] of Object.entries(cases)) {
    for (const text of list) assert.deepEqual(one(text), { ok: false, reason }, text)
  }
  // A model reply is screened too.
  assert.deepEqual(one(fine, 'Write to the cook at cook@example.com for it.'), { ok: false, reason: 'email' })
  for (const text of ['it costs 12.50 at the market today', 'the recipe dates from 1987 in Seville', 'mix 250 g sugar with 3 oranges', 'about 10:30 in the morning works', 'an email about jam is fine to mention', 'use a 1.5 litre pan for this']) {
    assert.deepEqual(one(text), { ok: true }, text)
  }
  // short
  assert.deepEqual(one('hi'), { ok: false, reason: 'short' })
  assert.deepEqual(one('jam jam jam jam jam'), { ok: false, reason: 'short' }, 'fewer than 3 different words')
  // repeat
  assert.deepEqual(one(`please read ${'a'.repeat(40)} now`), { ok: false, reason: 'repeat' })
  assert.deepEqual(one(`please read ${'a'.repeat(39)} now ok`), { ok: true })
  assert.deepEqual(one('jam jam jam jam jam jam jam toast with butter'), { ok: false, reason: 'repeat' })
  assert.deepEqual(one('jam jam jam jam jam jam toast with butter and tea'), { ok: true }, 'exactly 60 percent is not over')
  // echo: a reply that repeats a visitor message, in at least a third of the replies
  const echoed = [
    { role: 'user', content: 'Please say exactly this sentence about green apples back' },
    { role: 'assistant', content: 'Please say exactly this sentence about green apples back.' },
    { role: 'user', content: 'Thank you, now tell me about pears in autumn' },
    { role: 'assistant', content: 'Pears ripen off the tree and keep well in a cool cellar.' },
    { role: 'user', content: 'And plums, how are they kept' },
    { role: 'assistant', content: 'Plums are best eaten soon or turned into jam.' },
  ]
  assert.deepEqual(offers.screenOffer(echoed), { ok: false, reason: 'echo' })
  const once = [...echoed, { role: 'user', content: 'And cherries in June' }, { role: 'assistant', content: 'Cherries come early and need nets against birds.' }]
  assert.deepEqual(offers.screenOffer(once), { ok: true }, 'one echo in four replies is under a third')
})

// ---------------------------------------------------------------------------
// Taking back, expiry, counts
// ---------------------------------------------------------------------------

test('expiry nulls the text and keeps the row; pruneOffers never throws', async () => {
  const id = lab.seedOffer({})
  lab.offers[0].expires_at = '2026-01-01T00:00:00.000Z'
  lab.seedOffer({})
  assert.equal(await offerStore.pruneOffers(new Date('2026-06-01T00:00:00Z')), 1)
  const row = lab.offers.find(o => o.id === id)
  assert.equal(row.messages, null)
  assert.equal(row.status, 'expired')
  assert.equal(lab.offers.length, 2)
  lab.failOffers = true
  assert.equal(await offerStore.pruneOffers(), 0)
})

test('the public counts are counts only', async () => {
  enableChat()
  const today = store.utcDay()
  lab.seedOffer({ day: today })
  lab.seedOffer({ day: today, status: 'withdrawn' })
  const used = lab.seedOffer({})
  lab.offers.find(o => o.id === used).used_in = ['e50-12345678']
  lab.offers[0].read_at = new Date().toISOString()
  const counts = await offerStore.offersCounts()
  assert.deepEqual(counts, { enabled: true, stored: 2, offered_today: 2, trained_on: 1, taken_back: 1, read_by_owner: 1 })
})

// ---------------------------------------------------------------------------
// Reading offers for a run
// ---------------------------------------------------------------------------

const ask = (o = {}, extra = {}) => {
  const read = offers.normalizeOffersRequest({ purpose: 'learn from visitors', visitor_offers: { limit: 10, ...o }, ...extra }, [BASE])
  assert.ok('request' in read, JSON.stringify(read))
  return read.request
}
const days = n => Array.from({ length: n }, (_, i) => `2026-11-${String(10 + i).padStart(2, '0')}`)
function seedDays(dayCount, perDay, opts = {}) {
  const ids = []
  for (const day of days(dayCount)) for (let i = 0; i < perDay; i++) ids.push(lab.seedOffer({ day, ...opts }))
  return ids
}

test('a run reads offers by a salted order, at most a quarter from one day, and claims them in one UPDATE ... RETURNING', async () => {
  seedDays(8, 5)
  const fromVisitors = seedDays(2, 3, { fromVisitors: true })
  const a = await offerStore.readOffersForRun(ask(), 'salt-one', 'claim-1')
  assert.equal(a.ok, true, a.error)
  assert.equal(a.used.length, 10)
  assert.equal(a.request.examples.length, 10)
  // At most a quarter of the run from any one day.
  const byDay = new Map()
  for (const id of a.used) { const d = lab.offers.find(o => o.id === id).day; byDay.set(d, (byDay.get(d) ?? 0) + 1) }
  assert.ok(Math.max(...byDay.values()) <= 2)
  assert.equal(a.record.days, byDay.size)
  // Never an offer made with an adapter trained on offers.
  for (const id of fromVisitors) assert.equal(a.used.includes(id), false)
  // The claim: only the used ones hold it.
  for (const o of lab.offers) assert.equal(o.used_in.includes('claim-1'), a.used.includes(o.id))
  // The text was read by exactly one statement, an UPDATE that marks it in the same breath.
  const readers = lab.statements.filter(s => /visitor_offers/.test(s.text) && (/RETURNING .*\bmessages\b/.test(s.text) || /\bmessages\b/.test(/^SELECT (.*?) FROM/.exec(s.text)?.[1] ?? '')))
  assert.equal(readers.length, 1)
  assert.match(readers[0].text, /^UPDATE visitor_offers SET used_in = used_in \|\| to_jsonb\(\?::text\) WHERE .* RETURNING id, day, messages$/)
  // The record holds counts and no text.
  assert.deepEqual(Object.keys(a.record).sort(), ['adapter', 'conversations_used', 'days', 'kind', 'left_out', 'limit', 'order', 'sha256', 'shortened', 'system'])
  assert.equal(a.record.kind, 'visitor_offers')
  assert.equal(a.record.order, 'chosen by a hash the lab made up for this run')
  assert.equal(a.record.sha256, a.request.dataset_sha256)
  for (const o of lab.offers) assert.equal(JSON.stringify(a.record).includes(o.messages?.[0]?.content ?? '\u0000'), false)

  // Same salt, same choice; another salt, another one. Insertion order does not decide.
  for (const o of lab.offers) o.used_in = []
  const again = await offerStore.readOffersForRun(ask(), 'salt-one', 'claim-2')
  assert.deepEqual(again.used, a.used)
  for (const o of lab.offers) o.used_in = []
  const other = await offerStore.readOffersForRun(ask(), 'salt-two', 'claim-3')
  assert.notDeepEqual(new Set(other.used), new Set(a.used))
  lab.offers.reverse()
  for (const o of lab.offers) o.used_in = []
  const reversed = await offerStore.readOffersForRun(ask(), 'salt-one', 'claim-4')
  assert.deepEqual(reversed.used, a.used)
})

test('the quarter a day rule refuses a run that would lean on too few days, and releases every claim', async () => {
  seedDays(4, 10)
  const r = await offerStore.readOffersForRun(ask(), 'salt', 'claim-q')
  assert.equal(r.ok, false)
  assert.match(r.error, /only 8 visitor conversations could be used and a run needs 10/)
  assert.equal(lab.offers.some(o => o.used_in.length), false)
  assert.deepEqual(offers.pickByDay(days(5).flatMap(d => Array(3).fill({ day: d })), 12).length, 12)
  assert.deepEqual(offers.pickByDay(days(3).flatMap(d => Array(9).fill({ day: d })), 20), [])
})

test('the example builder: 12 messages at most (10 with a system text), too long and duplicates left out and counted', async () => {
  const long = convo('long', 8, { user: t => `${'word '.repeat(70)}${t}`, reply: t => `${'answer '.repeat(140)}${t}` })
  const shared = convo('dup', 6)
  const dupA = [...shared, { role: 'user', content: 'one ending of the talk' }, { role: 'assistant', content: 'One reply to end it.' }]
  const dupB = [...shared, { role: 'user', content: 'another ending of the talk' }, { role: 'assistant', content: 'Another reply to end it.' }]
  const rows = [
    { id: 'x-long', day: '2026-11-01', messages: long },
    { id: 'x-dupa', day: '2026-11-02', messages: dupA },
    { id: 'x-dupb', day: '2026-11-03', messages: dupB },
    ...days(6).flatMap((d, i) => [0, 1].map(k => ({ id: `x-${i}-${k}`, day: d, messages: convo(`${i}${k}`, 8) }))),
  ]
  const built = offers.offersToTinkerRequest(ask({ limit: 12 }), rows, [BASE])
  assert.ok('request' in built, built.error)
  assert.equal(built.record.left_out.too_long, 1)
  assert.equal(built.record.left_out.duplicate, 1)
  assert.equal(built.used.includes('x-long'), false)
  assert.equal(built.used.includes('x-dupb'), false)
  for (const e of built.request.examples) assert.ok(e.messages.length <= 12 && e.messages.at(-1).role === 'assistant')
  assert.equal(built.record.shortened, built.used.length, 'every used conversation had 7 or 8 turns')
  assert.equal(built.record.conversations_used, built.used.length)
  // With a system text: the system message, then 10 at most.
  const sys = offers.offersToTinkerRequest(ask({ limit: 12, system: 'You are a kind cook.' }), rows, [BASE])
  assert.ok('request' in sys, sys.error)
  for (const e of sys.request.examples) {
    assert.equal(e.messages[0].role, 'system')
    assert.ok(e.messages.length <= 11)
  }
  assert.equal(sys.record.system, true)
  // Fewer than 10: refused with the reason.
  const few = offers.offersToTinkerRequest(ask(), rows.slice(0, 6), [BASE])
  assert.match(few.error, /run needs 10/)
})

test('a take back after a claim answers trained_on: true, and markOffersUsed turns the claim into the slug or releases it', async () => {
  enableChat()
  seedDays(8, 2)
  const code = offers.newOfferCode()
  const id = lab.seedOffer({ day: '2026-11-30', code: offers.codeSha256(offers.readOfferCode(code)) })
  const r = await offerStore.readOffersForRun(ask({ limit: 17 }), 'salt', 'claim-t')
  assert.equal(r.ok, true, r.error)
  assert.ok(r.used.includes(id), 'the coded offer was claimed')
  const back = await offer({ withdraw: code })
  assert.deepEqual(back.body, { withdrawn: true, trained_on: true, message: 'Done. The lab deleted the stored text. A model was already trained on it and cannot unlearn it.' })
  assert.equal(lab.offers.find(o => o.id === id).messages, null)

  await offerStore.markOffersUsed('claim-t', 'e50-12345678')
  for (const o of lab.offers) {
    assert.equal(o.used_in.includes('claim-t'), false)
    assert.equal(o.used_in.includes('e50-12345678'), r.used.includes(o.id))
  }
  // A start that was never confirmed releases the claim.
  for (const o of lab.offers) o.used_in = []
  lab.offers.forEach(o => { if (o.status === 'stored' || o.id === id) { o.status = 'stored'; o.messages ??= convo(o.id) } })
  const r2 = await offerStore.readOffersForRun(ask({ limit: 16 }), 'salt-2', 'claim-u')
  assert.equal(r2.ok, true, r2.error)
  await offerStore.markOffersUsed('claim-u', null)
  assert.equal(lab.offers.some(o => o.used_in.length), false)
})

test('offers made with an adapter trained on offers are stored but never read for a run', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  lab.addAdapter({ slug: VISITOR_SLUG })
  lab.tinkerRuns.at(-1).dataset_source = JSON.stringify({ kind: 'visitor_offers', adapter: null })
  assert.equal((await offer(signed(convo('v'), VISITOR_SLUG))).code, 201)
  assert.equal(lab.offers[0].adapter_from_visitors, true)
  seedDays(8, 2)
  const r = await offerStore.readOffersForRun(ask({ limit: 16 }), 'salt', 'claim-v')
  assert.equal(r.used.includes(lab.offers[0].id), false)
  assert.equal(await offerStore.usableOfferCount(), 16)
})

// ---------------------------------------------------------------------------
// The chat list, the label
// ---------------------------------------------------------------------------

test('chatOffers hides an adapter trained on offers unless its switch is on, and the notice then says so', async () => {
  enableChat()
  lab.addAdapter({ slug: SLUG })
  lab.addAdapter({ slug: VISITOR_SLUG })
  lab.tinkerRuns.at(-1).dataset_source = JSON.stringify({ kind: 'visitor_offers', adapter: `lab/${SLUG}` })
  assert.equal(trainedChat.chatOffers({ from_visitors: true }), false)
  assert.equal(trainedChat.chatOffers({}), true)
  const list = await chat({}, { method: 'GET' })
  assert.deepEqual(list.body.adapters.map(a => a.slug), [SLUG])
  assert.equal(list.body.notice, trainedChat.TRAINED_CHAT_NOTICE)
  globalThis.fetch = fakeTinker()
  assert.equal((await chat({ adapter: VISITOR_SLUG, messages: [{ role: 'user', content: 'Hello' }] })).body.error, 'not_offered')
  // The dataset switch does not let it through.
  process.env.LAB_TRAINED_CHAT_DATASET_ADAPTERS = 'true'
  assert.equal(trainedChat.chatOffers({ from_visitors: true }), false)
  process.env.LAB_TRAINED_CHAT_VISITOR_ADAPTERS = 'true'
  const shown = await chat({}, { method: 'GET' })
  assert.deepEqual(shown.body.adapters.map(a => a.slug).sort(), [SLUG, VISITOR_SLUG].sort())
  assert.equal(shown.body.notice, 'Small models fine-tuned by the lab\'s AI models. Some were trained on conversations written by visitors that nobody at the lab has read. Replies are not reviewed.')
  assert.equal((await chat({ adapter: VISITOR_SLUG, messages: [{ role: 'user', content: 'Hello' }] })).code, 200)
  assert.equal(trainedChat.chatNotice([{ from_dataset: true }, { from_visitors: true }]), trainedChat.TRAINED_CHAT_NOTICE_DATASETS_VISITORS)
})

test('the origin label shows with LAB_TINKER_ORIGIN_LABELS off', () => {
  delete process.env.LAB_TINKER_ORIGIN_LABELS
  assert.equal(offers.ORIGIN_VISITORS, 'written by visitors')
  assert.equal(store.dataOrigin({ dataset_source: { kind: 'visitor_offers', adapter: `lab/${SLUG}` } }), `written by visitors in chats with lab/${SLUG}`)
  assert.equal(store.dataOrigin({ dataset_source: { kind: 'visitor_offers', adapter: null } }), 'written by visitors')
})

// ---------------------------------------------------------------------------
// The owner's route
// ---------------------------------------------------------------------------

test('the owner\'s route: bearer first, POST only, a read returns text and sets read_at, deletes need confirm', async () => {
  process.env.LAB_OPERATOR_SECRET = OPERATOR
  const a = lab.seedOffer({ day: '2026-11-20' })
  const b = lab.seedOffer({ day: '2026-11-21' })
  lab.seedOffer({ day: '2026-11-19', status: 'withdrawn' })
  lab.offers.at(-1).messages = null
  for (const auth of ['none', 'Bearer wrong', [`Bearer ${OPERATOR}`]]) {
    for (const method of ['GET', 'POST']) {
      const res = await owner({ action: 'read' }, { auth, method })
      assert.equal(res.code, 401)
      assert.equal(res.headers['Cache-Control'], 'no-store')
    }
  }
  assert.equal(lab.offers.some(o => o.read_at), false)
  assert.equal((await owner({ action: 'read' }, { method: 'GET' })).code, 405)
  assert.equal(lab.offers.some(o => o.read_at), false, 'a GET reads nothing')
  const read = await owner({ action: 'read', limit: 1 })
  assert.equal(read.code, 200)
  assert.deepEqual(read.body.offers.map(o => o.id), [b])
  assert.ok(Array.isArray(read.body.offers[0].messages))
  assert.ok(lab.offers.find(o => o.id === b).read_at)
  assert.equal(lab.offers.find(o => o.id === a).read_at, null)
  const older = await owner({ action: 'read', before: '2026-11-21T00:00:00Z' })
  assert.deepEqual(older.body.offers.map(o => o.id), [a])
  assert.equal((await offerStore.offersCounts()).read_by_owner, 2)
  for (const body of [{ action: 'read', limit: 0 }, { action: 'read', limit: 101 }, { action: 'read', extra: 1 }, { action: 'read', before: 'soon' }, { action: 'nope' }, []]) {
    assert.equal((await owner(body)).code, 400, JSON.stringify(body))
  }
  assert.equal((await owner({ action: 'delete', id: a })).code, 400, 'needs ?confirm=true')
  assert.deepEqual((await owner({ action: 'delete', id: a }, { query: { confirm: 'true' } })).body, { deleted: 1 })
  assert.equal(lab.offers.find(o => o.id === a).messages, null)
  assert.equal(lab.offers.find(o => o.id === a).status, 'deleted')
  assert.equal((await owner({ action: 'delete_all' })).code, 400)
  assert.deepEqual((await owner({ action: 'delete_all' }, { query: { confirm: 'true' } })).body, { deleted: 1 })
  assert.equal(lab.offers.length, 3, 'rows are kept as counts')
  assert.equal(lab.offers.some(o => o.messages !== null), false)
})

// ---------------------------------------------------------------------------
// What the models are told, and the request they write
// ---------------------------------------------------------------------------

test('a training request that names offers is read strictly', () => {
  const read = raw => offers.normalizeOffersRequest(raw, [BASE])
  const good = read({ purpose: '  learn  ', visitor_offers: { adapter: `lab/${SLUG}`, limit: 50, system: 'Be brief.' } })
  assert.deepEqual(good.request.visitor_offers, { adapter: SLUG, limit: 50, system: 'Be brief.' })
  assert.equal(good.request.purpose, 'learn')
  assert.equal(good.request.base_model, BASE)
  assert.equal(read({ visitor_offers: {} }).request.visitor_offers.limit, 200)
  assert.equal(read({ visitor_offers: { adapter: SLUG } }).request.visitor_offers.adapter, SLUG)
  for (const [raw, pattern] of [
    [{ visitor_offers: { limit: 9 } }, /10 to 500/], [{ visitor_offers: { limit: 501 } }, /10 to 500/], [{ visitor_offers: { limit: 10.5 } }, /10 to 500/],
    [{ visitor_offers: { other: 1 } }, /unknown field: other/], [{ visitor_offers: {}, extra: 1 }, /unknown field: extra/],
    [{ visitor_offers: {}, examples: [] }, /exactly one/], [{ visitor_offers: {}, dataset: {} }, /exactly one/], [{}, /exactly one/],
    [{ visitor_offers: { adapter: 'nope' } }, /adapter id/], [{ visitor_offers: { system: 'x'.repeat(2001) } }, /2000 bytes/],
    [{ visitor_offers: { system: 'a\u0001b' } }, /control character/], [{ visitor_offers: {}, base_model: 'other/model' }, /base_model/],
    [{ visitor_offers: { limit: 500 }, settings: { batch_size: 1, epochs: 3 } }, /optimizer steps/], [{ visitor_offers: [] }, /not an object/],
  ]) assert.match(read(raw).error ?? '', pattern, JSON.stringify(raw))
  assert.equal(offers.namesVisitorOffers({ visitor_offers: {} }), true)
  assert.equal(offers.namesVisitorOffers({ examples: [] }), false)
  assert.match(offers.offersRequestSummary(good.request), /up to 50 conversations visitors offered in chats with lab\/e41-0a1b2c3d: learn$/)
})

test('the ceiling is at least the estimate of any set the reader can build', () => {
  const asked = ask({ limit: 12, system: 'You are a kind cook who answers briefly.' })
  const rows = days(6).flatMap((d, i) => [0, 1].map(k => ({ id: `c-${i}-${k}`, day: d, messages: convo(`${i}${k}`, 8, { user: t => `${i}${k}${t} ${'u'.repeat(400)}`, reply: t => `${i}${k}${t} ${'r'.repeat(400)}` }) })))
  const built = offers.offersToTinkerRequest(asked, rows, [BASE])
  assert.ok('request' in built, built.error)
  assert.ok(offers.offersRunCeiling(asked).max_cost_usd >= tinker.estimateTinkerRun(built.request).max_cost_usd)
  assert.equal(offers.offerExampleMessages(false), 12)
  assert.equal(offers.offerExampleMessages(true), 10)
})

test('the note and the review facts: the counts, the limits, and no encouragement', () => {
  const note = offers.visitorOffersNote({ total: 37 })
  assert.match(note, /The lab holds 37 of them now/)
  assert.match(note, /"limit" 10 to 500/)
  assert.match(note, /at most a quarter from any one day/)
  assert.match(note, /first 6 turns at most \(5 with a system text\)/)
  assert.match(note, /labelled "written by visitors"/)
  // One number about how many there are, and none per adapter.
  assert.equal(note.includes(SLUG), false)
  assert.equal(/\b(should|try|consider|recommend|great|best|improve)\b/i.test(note), false)
  assert.equal(/\b(room shows|chart|shelf|screen of)\b/i.test(note.replace('a visitor of the room', '')), false)
  const facts = offers.visitorOffersReviewFacts(ask({ adapter: SLUG, limit: 40 }), { stored: 55, runCapUsd: 2 }).line
  assert.match(facts, /on up to 40 conversations that visitors of the room offered to the lab in chats with lab\/e41-0a1b2c3d/)
  assert.match(facts, /The lab holds 55 such conversations now/)
  assert.match(facts, /neither you nor the Executor has read it/)
  assert.match(facts, /a run may cost at most \$2\.00/)
  assert.equal(/\b(should|try|consider|recommend|great|best|improve)\b/i.test(facts), false)
})

test('visitor facing text is plain: no em or en dash anywhere a visitor reads', () => {
  const texts = [...Object.values(offers.OFFER_MESSAGES), trainedChat.TRAINED_CHAT_NOTICE_VISITORS, trainedChat.TRAINED_CHAT_NOTICE_DATASETS_VISITORS, ...offers.OFFER_CLAIMS.map(c => c.claim)]
  for (const text of texts) assert.equal(/[–—]/.test(text), false, text)
})

test('no log call in the offer files prints anything but a fixed line', () => {
  for (const file of ['api/_lib/visitor-offers.ts', 'api/_lib/visitor-offers-store.ts', 'api/experiment/chat-offer.ts', 'api/experiment/visitor-offers.ts']) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const call of source.matchAll(/console\.(log|warn|error|info|debug)\(([^)]*)\)/g)) {
      assert.match(call[2], /^'[^'$`]*'$/, `${file}: ${call[0]}`)
    }
  }
})

test('take back codes: 12 characters of Crockford base32, read leniently, hashed', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const code = offers.newOfferCode()
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    seen.add(code)
  }
  assert.equal(seen.size, 200)
  assert.equal(offers.readOfferCode('abcd-efgh-jkmn'), 'ABCDEFGHJKMN')
  assert.equal(offers.readOfferCode('o0il 1111 2222'), '001111112222')
  assert.equal(offers.readOfferCode('ABCD-EFGH-JKMU'), null)
  assert.equal(offers.readOfferCode('ABCD-EFGH'), null)
  assert.equal(offers.codeSha256('ABCDEFGHJKMN').length, 64)
})
