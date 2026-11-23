// A small harness for the visitor chat tests (trained-chat-compare*, chat-activity*):
// compiles api/ to a temp dir, swaps @vercel/postgres for an in-memory fake that
// understands the queries the chat makes, and offers a fake Tinker endpoint.
// No network, no database, no secrets.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

export const root = resolve(import.meta.dirname, '..', '..')
export const BASE = 'Qwen/Qwen3.5-4B'
export const SAMPLER = 'tinker://0a1b2c3d-1111-2222-3333-444455556666:train:0/sampler_weights/final'
export const TINKER_KEY = 'tml-test-only-tinker-placeholder-0000'

export async function setup() {
  const build = mkdtempSync(join(tmpdir(), 'observable-chat-test-'))
  symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
  writeFileSync(join(build, 'package.json'), '{"type":"module"}')
  const fakePg = join(build, 'fake-postgres.js')
  writeFileSync(fakePg, `
export const db = { handler: null }
export function sql(strings, ...values) {
  const text = (Array.isArray(strings) ? strings.join('?') : String(strings)).replace(/\\s+/g, ' ').trim()
  return (async () => (db.handler ? await db.handler(text, values) : undefined) ?? { rows: [] })()
}
`)
  const fakePgUrl = pathToFileURL(fakePg).href
  const compile = directory => {
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
  const load = path => import(pathToFileURL(join(build, path)).href)
  const { db } = await import(fakePgUrl)
  return { build, load, db, cleanup: () => rmSync(build, { recursive: true, force: true }) }
}

/** An in-memory stand-in for the tables the chat touches. */
export class FakeDb {
  constructor(store) {
    this.store = store
    this.nextId = 1
    this.modelCalls = []
    this.spendDays = new Map()
    this.tinkerRuns = []
    this.rate = new Map()
    this.chatCalls = []
    this.statements = []
    this.failChatCalls = false
  }

  spend(scope, day = this.store.utcDay()) {
    return this.spendDays.get(`${day}|${scope}`) ?? { reserved_usd: 0, spent_usd: 0 }
  }

  addAdapter({ slug = 'e41-0a1b2c3d', base = BASE } = {}) {
    this.tinkerRuns.push({
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`, created_at: new Date().toISOString(), experiment_id: 'exp-1', epoch: 41,
      model: 'anthropic/claude-fable-5.2', assigned_model: 'anthropic/claude-fable-5.2', slug, base_model: base, purpose: 'a tiny test run',
      dataset_sha256: 'a'.repeat(64), dataset_examples: 20, dataset_bytes: 700, settings: JSON.stringify({ rank: 16, learning_rate: 0.0002, epochs: 2, batch_size: 8 }),
      split_salt: 'ab'.repeat(16), status: 'ok', reason: null, call_id: 'fc-test-1', spend_day: this.store.utcDay(), reserved_usd: 0.01, cost_usd: 0.001,
      result: JSON.stringify({ n_holdout: 2, n_train: 18, holdout_loss_before: 2.9531, holdout_loss_after: 1.1042 }),
      sampler_path: SAMPLER, expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
    })
    return slug
  }

  handle(text, v) {
    this.statements.push({ text, values: v })
    if (/^(CREATE|ALTER|DROP)\b/.test(text)) return { rows: [] }
    if (text.startsWith('INSERT INTO model_calls')) {
      const [experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens] = v
      this.modelCalls.push({ experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, created_at: new Date() })
      return { rows: [] }
    }
    if (text.includes('FROM model_calls WHERE created_at >= ?')) {
      return { rows: [{ total: this.modelCalls.filter(c => c.created_at >= new Date(v[0])).reduce((s, c) => s + Number(c.cost_usd), 0) }] }
    }
    if (text.startsWith('INSERT INTO tinker_spend_days (day, scope) VALUES (?, ?) ON CONFLICT (day, scope) DO NOTHING')) {
      const key = `${v[0]}|${v[1]}`
      if (!this.spendDays.has(key)) this.spendDays.set(key, { day: v[0], scope: v[1], reserved_usd: 0, spent_usd: 0 })
      return { rows: [] }
    }
    if (text.startsWith('UPDATE tinker_spend_days SET reserved_usd = reserved_usd + ?')) {
      const [amount, day, scope, , cap] = v
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
    if (text.startsWith('SELECT * FROM tinker_runs WHERE status = ? AND sampler_path IS NOT NULL AND expires_at > ?')) {
      return { rows: this.tinkerRuns.filter(r => r.status === v[0] && r.sampler_path && new Date(r.expires_at) > new Date(v[1])).slice().reverse().map(r => ({ ...r })) }
    }
    if (text.startsWith('SELECT * FROM tinker_runs WHERE slug = ?')) {
      const row = this.tinkerRuns.find(r => r.slug === v[0])
      return { rows: row ? [{ ...row }] : [] }
    }
    if (text.startsWith('INSERT INTO trained_chat_rate (visitor, bucket, n) VALUES (?, ?, 1)')) {
      const [visitor, bucket, limit] = v
      const key = `${visitor}|${bucket}`
      const n = this.rate.get(key)
      if (n === undefined) { this.rate.set(key, 1); return { rows: [{ n: 1 }] } }
      if (!(n < limit)) return { rows: [] }
      this.rate.set(key, n + 1)
      return { rows: [{ n: n + 1 }] }
    }
    if (text.startsWith('DELETE FROM trained_chat_rate')) return { rows: [] }
    if (text.startsWith('INSERT INTO trained_chat_calls')) {
      const [slug, status, http_status, turns, prompt_chars, prompt_tokens, completion_tokens, cost_usd, duration_ms] = v
      this.chatCalls.push({ slug, status, http_status, turns, prompt_chars, prompt_tokens, completion_tokens, cost_usd, duration_ms, created_at: new Date() })
      return { rows: [] }
    }
    // The room signal's two reads.
    if (text.startsWith("SELECT slug, created_at FROM trained_chat_calls WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1")) {
      if (this.failChatCalls) throw new Error('chat calls table down')
      const ok = this.chatCalls.filter(c => c.status === 'ok').sort((a, b) => b.created_at - a.created_at)
      return { rows: ok[0] ? [{ slug: ok[0].slug, created_at: ok[0].created_at }] : [] }
    }
    if (text.startsWith("SELECT COUNT(*) AS n FROM trained_chat_calls WHERE status = 'ok' AND created_at >= ?")) {
      if (this.failChatCalls) throw new Error('chat calls table down')
      return { rows: [{ n: String(this.chatCalls.filter(c => c.status === 'ok' && c.created_at >= new Date(v[0])).length) }] }
    }
    throw new Error(`unexpected query: ${text.slice(0, 140)}`)
  }
}

export function response() {
  return {
    code: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}

/** A Tinker completion body, as the OpenAI-compatible endpoint answers. */
export const completion = ({ content = 'Answer number 3.', prompt_tokens = 20, completion_tokens = 8, finish_reason = 'stop' } = {}) => ({
  id: 'chatcmpl-test', object: 'chat.completion', created: 1794500000, model: SAMPLER,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
  usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
})
