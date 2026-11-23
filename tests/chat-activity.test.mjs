// The room signal: `trained_chat_activity` in GET /api/experiment, built from
// the rows the visitor chat already writes. Counts and times, never text.
//
// No network, no database, no secrets (tests/fixtures/chat-harness.mjs).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { FakeDb, TINKER_KEY, root, setup } from './fixtures/chat-harness.mjs'

const originalEnv = { ...process.env }
const harness = await setup()
after(() => { process.env = originalEnv; harness.cleanup() })
for (const name of Object.keys(process.env)) {
  if (/^(OPENROUTER|POSTGRES|LAB_|AI_AGENT|RESEARCH_|SPRITES|MODAL|EPOCH_|NORTH_|GPU_JOBS|VERCEL|TINKER|CRON_)/.test(name)) delete process.env[name]
}
const BASE_ENV = { ...process.env }
const { load, db } = harness
const store = await load('api/_lib/tinker-store.js')
const activity = await load('api/_lib/trained-chat-activity.js')

let lab
beforeEach(() => {
  process.env = { ...BASE_ENV }
  lab = new FakeDb(store)
  db.handler = (text, values) => lab.handle(text, values)
  activity.resetChatActivityCache()
})
const enableChat = () => Object.assign(process.env, { LAB_ENABLE_TRAINED_CHAT: 'true', TINKER_API_KEY: TINKER_KEY })
const row = (status, at, slug = 'e41-0a1b2c3d') => lab.chatCalls.push({ slug, status, http_status: 200, turns: 3, prompt_chars: 99, prompt_tokens: 20, completion_tokens: 8, cost_usd: 0.0001, duration_ms: 400, created_at: new Date(at) })
const NOW = new Date('2026-11-23T14:03:10.000Z')

test('absent while the chat is off, and nothing is read', async () => {
  row('ok', NOW)
  db.handler = () => { throw new Error('the database must not be touched') }
  assert.equal(await activity.chatActivity(NOW), null)
  process.env.LAB_ENABLE_TRAINED_CHAT = 'true' // no Tinker key: still off
  assert.equal(await activity.chatActivity(NOW), null)
})

test('absent when no answered call was made in the last 24 hours', async () => {
  enableChat()
  assert.equal(await activity.chatActivity(NOW), null)
  row('ok', new Date(NOW.getTime() - 24 * 3600_000 - 1000))
  assert.equal(await activity.chatActivity(NOW), null)
  activity.resetChatActivityCache()
  row('ok', new Date(NOW.getTime() - 23 * 3600_000))
  const a = await activity.chatActivity(NOW)
  assert.equal(a.last.at, new Date(NOW.getTime() - 23 * 3600_000).toISOString())
})

test('the field has exactly the public shape, and counts only answered calls', async () => {
  enableChat()
  row('ok', '2026-11-23T14:01:52.000Z')
  row('ok', '2026-11-23T09:00:00.000Z', 'e30-11112222')
  row('ok', '2026-11-22T23:59:59.000Z') // yesterday (UTC)
  row('upstream', '2026-11-23T14:02:30.000Z')
  row('timeout', '2026-11-23T14:02:40.000Z')
  row('base_ok', '2026-11-23T14:02:50.000Z')
  row('base_upstream', '2026-11-23T14:02:55.000Z')
  const a = await activity.chatActivity(NOW)
  assert.deepEqual(a, { now: '2026-11-23T14:03:10.000Z', today: 2, last: { adapter: 'e41-0a1b2c3d', at: '2026-11-23T14:01:52.000Z' } })
  assert.deepEqual(Object.keys(a), ['now', 'today', 'last'])
  assert.deepEqual(Object.keys(a.last), ['adapter', 'at'])

  // today starts at 00:00 UTC.
  activity.resetChatActivityCache()
  const after = await activity.chatActivity(new Date('2026-11-24T00:00:01.000Z'))
  assert.equal(after.today, 0)
  assert.equal(after.last.at, '2026-11-23T14:01:52.000Z')
})

test('only an answered call lights it: an error, a refusal and an untrained row never do', async () => {
  enableChat()
  row('base_ok', NOW)
  row('upstream', NOW)
  row('timeout', NOW)
  assert.equal(await activity.chatActivity(NOW), null)
  assert.equal(activity.publicChatActivity(null, 3, NOW), null)
  assert.equal(activity.publicChatActivity({ slug: 'not-a-slug', at: NOW }, 3, NOW), null)
})

test('it is read at most every 4 seconds, forgets on reset, and never throws', async () => {
  enableChat()
  row('ok', NOW)
  const count = () => lab.statements.filter(s => s.text.includes('FROM trained_chat_calls')).length
  await activity.chatActivity(NOW)
  const first = count()
  assert.equal(first, 2)
  await activity.chatActivity(new Date(NOW.getTime() + 3900))
  assert.equal(count(), first)
  await activity.chatActivity(new Date(NOW.getTime() + 4100))
  assert.equal(count(), first * 2)
  activity.resetChatActivityCache()
  await activity.chatActivity(new Date(NOW.getTime() + 4200))
  assert.equal(count(), first * 3)

  // The record cannot be read: no field, no throw.
  activity.resetChatActivityCache()
  lab.failChatCalls = true
  assert.equal(await activity.chatActivity(NOW), null)
})

test('nothing about the visitor or the words is in the field', async () => {
  enableChat()
  row('ok', NOW)
  const text = JSON.stringify(await activity.chatActivity(NOW))
  for (const word of ['visitor', 'hash', 'turns', 'cost', 'text', 'message', 'content', 'reply', 'prompt', 'ip', 'agent', 'token', 'usd']) {
    assert.equal(text.toLowerCase().includes(`"${word}`), false, `"${word}" in the field`)
  }
  assert.equal(text.includes('99'), false) // prompt_chars of the row
  // The two reads select only a slug, a time and a count.
  const source = readFileSync(join(root, 'api/_lib/tinker-store.ts'), 'utf8')
  assert.match(source, /SELECT slug, created_at FROM trained_chat_calls WHERE status = 'ok'/)
  assert.match(source, /SELECT COUNT\(\*\) AS n FROM trained_chat_calls WHERE status = 'ok'/)
  assert.equal(/INSERT|UPDATE/.test(readFileSync(join(root, 'api/_lib/trained-chat-activity.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), false)
})

test('the state route adds the field after trained_chat_enabled, keeps that line byte for byte, and survives a failed read', () => {
  const route = readFileSync(join(root, 'api/experiment/index.ts'), 'utf8')
  const enabled = '...(trainedChatStatus().enabled ? { trained_chat_enabled: true } : {}),'
  const field = '...(activity ? { trained_chat_activity: activity } : {}),'
  assert.ok(route.includes(enabled) && route.includes(field))
  assert.ok(route.indexOf(field) > route.indexOf(enabled))
  assert.match(route, /const activity = trainedChatStatus\(\)\.enabled \? await chatActivity\(\)\.catch\(\(\) => null\) : null/)
})

test('docs, env example and the new strings', () => {
  const read = p => readFileSync(join(root, p), 'utf8')
  for (const p of ['docs/OPERATIONS.md', 'docs/TOOLS.md', '.env.example']) assert.ok(read(p).includes('LAB_ENABLE_TRAINED_CHAT_COMPARE'), `${p} does not mention the switch`)
  assert.match(read('docs/OPERATIONS.md'), /Qwen\/Qwen3\.5-4B/)
  assert.ok(read('docs/TOOLS.md').includes('trained_chat_activity'))
  for (const p of ['api/_lib/trained-chat.ts', 'api/_lib/trained-chat-activity.ts']) assert.equal(/[–—]/.test(read(p)), false, `a dash in ${p}`)
})
