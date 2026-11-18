/**
 * Scoped keys for the lab model endpoint (live-model.ts), and the record of
 * every call made with one.
 *
 * A key is 256 random bits. The server keeps only its SHA-256 hash, with the
 * experiment, epoch, model and Sprite it was issued to, when it ends, and
 * how much it may do: a number of calls and a number of dollars. It is made
 * when a Sprite session starts and revoked when that session ends.
 *
 * The limits are held by the database, not by this code's own arithmetic:
 * a call is let through by one conditional UPDATE that counts it, checks
 * expiry, revocation and both limits, and takes the key's single in-flight
 * slot, all in the same statement. Postgres re-checks the conditions under
 * the row lock, so two calls arriving together cannot both pass a limit.
 * Because only one call per key runs at a time, the dollar limit (which is
 * only known once a call has been billed) can be passed by one call at most.
 *
 * Both tables are created at runtime, like the other run 2 tables.
 */
import { createHash } from 'node:crypto'
import { sql } from '@vercel/postgres'
import { SCOPED_MODEL_KEY, sanitizeOutput } from './sprites.js'
import { utcDayStart } from './spend.js'
import { LIVE_KEY_MAX_CALLS, LIVE_KEY_MAX_USD, LIVE_UPSTREAM_TIMEOUT_MS, newLiveKeyToken } from './live-model.js'

/** The spend ledger tag for these calls (model_calls.purpose). */
export const LIVE_MODEL_PURPOSE = 'live_model'
/** How long a call may hold a key's one in-flight slot before it is given up as lost. */
export const LIVE_CALL_LEASE_MS = LIVE_UPSTREAM_TIMEOUT_MS + 30_000

let tablesReady: Promise<void> | null = null
export function ensureLiveModelTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS live_model_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token_hash TEXT NOT NULL UNIQUE,
          experiment_id UUID,
          epoch INTEGER,
          model TEXT NOT NULL,
          sprite TEXT NOT NULL,
          issued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          max_calls INTEGER NOT NULL,
          max_usd NUMERIC(12,6) NOT NULL,
          calls_used INTEGER NOT NULL DEFAULT 0,
          usd_used NUMERIC(12,6) NOT NULL DEFAULT 0,
          busy_until TIMESTAMP WITH TIME ZONE,
          revoked BOOLEAN NOT NULL DEFAULT FALSE,
          revoked_at TIMESTAMP WITH TIME ZONE,
          revoke_reason TEXT
        )
      `
      await sql`CREATE INDEX IF NOT EXISTS idx_live_model_keys_sprite ON live_model_keys(sprite, revoked)`
      await sql`
        CREATE TABLE IF NOT EXISTS live_model_calls (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          key_id UUID NOT NULL,
          experiment_id UUID,
          epoch INTEGER,
          issued_to TEXT,
          sprite TEXT,
          model_asked TEXT NOT NULL,
          model_served TEXT,
          status TEXT NOT NULL,
          http_status INTEGER,
          finish_reason TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          cost_source TEXT,
          duration_ms INTEGER,
          detail JSONB
        )
      `
      await sql`CREATE INDEX IF NOT EXISTS idx_live_model_calls_key ON live_model_calls(key_id, created_at)`
    })().catch(e => {
      tablesReady = null
      throw e
    })
  }
  return tablesReady
}

export function hashLiveKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** The key in "Authorization: Bearer <key>", or null when the header is not one well-formed scoped key. */
export function bearerLiveKey(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer ([A-Za-z0-9_]{1,100})$/.exec(header.trim())
  return match && SCOPED_MODEL_KEY.test(match[1]) ? match[1] : null
}

export interface IssuedLiveKey {
  id: string
  /** The key itself. It exists here and in the Sprite's environment, nowhere else. */
  token: string
  expires_at: string
  max_calls: number
  max_usd: number
}

/**
 * Makes a key for one Sprite session. Any key still open for the same Sprite
 * is revoked first: a Sprite holds one session at a time, so an older key
 * can only be one whose session ended without getting to revoke it.
 */
export async function mintLiveModelKey(params: {
  experimentId: string | null
  epoch: number | null
  model: string
  sprite: string
  ttlMs: number
  now?: Date
}): Promise<IssuedLiveKey> {
  const now = params.now ?? new Date()
  await ensureLiveModelTables()
  await sql`
    UPDATE live_model_keys SET revoked = TRUE, revoked_at = ${now.toISOString()}, revoke_reason = ${'replaced by a newer session'}
    WHERE sprite = ${params.sprite} AND revoked = FALSE
  `
  const token = newLiveKeyToken()
  const expiresAt = new Date(now.getTime() + Math.max(1000, params.ttlMs)).toISOString()
  const r = await sql`
    INSERT INTO live_model_keys (token_hash, experiment_id, epoch, model, sprite, issued_at, expires_at, max_calls, max_usd)
    VALUES (${hashLiveKey(token)}, ${params.experimentId}, ${params.epoch}, ${params.model}, ${params.sprite},
      ${now.toISOString()}, ${expiresAt}, ${LIVE_KEY_MAX_CALLS}, ${LIVE_KEY_MAX_USD})
    RETURNING id
  `
  const id = String(r.rows[0]?.id ?? '')
  if (!id) throw new Error('the key could not be stored')
  return { id, token, expires_at: expiresAt, max_calls: LIVE_KEY_MAX_CALLS, max_usd: LIVE_KEY_MAX_USD }
}

export interface LiveKeyGrant {
  ok: true
  id: string
  experiment_id: string | null
  epoch: number | null
  model: string
  sprite: string
  calls_used: number
  max_calls: number
  usd_used: number
  max_usd: number
  expires_at: string
}
/** 401: the key is not (or no longer) a key. 429: it is, and it has reached a limit. */
export type LiveKeyRefusal = { ok: false; status: 401 | 429; reason: string }

function grant(row: Record<string, unknown>): LiveKeyGrant {
  return {
    ok: true,
    id: String(row.id),
    experiment_id: row.experiment_id ? String(row.experiment_id) : null,
    epoch: row.epoch === null || row.epoch === undefined ? null : Number(row.epoch),
    model: String(row.model ?? ''),
    sprite: String(row.sprite ?? ''),
    calls_used: Number(row.calls_used) || 0,
    max_calls: Number(row.max_calls) || 0,
    usd_used: Number(row.usd_used) || 0,
    max_usd: Number(row.max_usd) || 0,
    expires_at: row.expires_at ? new Date(row.expires_at as string).toISOString() : '',
  }
}

/** Why a key cannot be used right now, in a few words. `forCall` adds the limits a call is held to. */
function refusal(row: Record<string, unknown> | undefined, now: Date, forCall: boolean): LiveKeyRefusal | null {
  if (!row) return { ok: false, status: 401, reason: 'unknown key' }
  if (row.revoked) return { ok: false, status: 401, reason: 'this key was revoked: its Sprite session has ended' }
  if (!(new Date(row.expires_at as string).getTime() > now.getTime())) return { ok: false, status: 401, reason: 'this key has expired' }
  if (!forCall) return null
  const g = grant(row)
  if (g.calls_used >= g.max_calls) return { ok: false, status: 429, reason: `this key has used its ${g.max_calls} calls` }
  if (g.usd_used >= g.max_usd) return { ok: false, status: 429, reason: `this key has used its $${g.max_usd.toFixed(2)}` }
  if (row.busy_until && new Date(row.busy_until as string).getTime() > now.getTime()) {
    return { ok: false, status: 429, reason: 'another call with this key is still running: one at a time' }
  }
  return null
}

async function readKey(token: string): Promise<Record<string, unknown> | undefined> {
  const r = await sql`
    SELECT id, experiment_id, epoch, model, sprite, expires_at, max_calls, max_usd, calls_used, usd_used, busy_until, revoked
    FROM live_model_keys WHERE token_hash = ${hashLiveKey(token)}
  `
  return r.rows[0] as Record<string, unknown> | undefined
}

/** Is this a live key? Reads only: nothing is counted. For GET <base>/models. */
export async function checkLiveKey(token: string, now: Date = new Date()): Promise<LiveKeyGrant | LiveKeyRefusal> {
  await ensureLiveModelTables()
  const row = await readKey(token)
  return refusal(row, now, false) ?? grant(row as Record<string, unknown>)
}

/**
 * Lets one call through, or says why not. The UPDATE is the gate: it only
 * touches the row while the key is unrevoked, unexpired, under both limits
 * and idle, and in the same statement it counts the call and takes the
 * in-flight slot. No row back means no call.
 */
export async function reserveLiveCall(token: string, now: Date = new Date()): Promise<LiveKeyGrant | LiveKeyRefusal> {
  await ensureLiveModelTables()
  const nowIso = now.toISOString()
  const leaseIso = new Date(now.getTime() + LIVE_CALL_LEASE_MS).toISOString()
  const r = await sql`
    UPDATE live_model_keys
    SET calls_used = calls_used + 1, busy_until = ${leaseIso}
    WHERE token_hash = ${hashLiveKey(token)}
      AND revoked = FALSE
      AND expires_at > ${nowIso}
      AND calls_used < max_calls
      AND usd_used < max_usd
      AND (busy_until IS NULL OR busy_until <= ${nowIso})
    RETURNING id, experiment_id, epoch, model, sprite, expires_at, max_calls, max_usd, calls_used, usd_used
  `
  if (r.rows[0]) return grant(r.rows[0] as Record<string, unknown>)
  return refusal(await readKey(token), now, true) ?? { ok: false, status: 429, reason: 'this key is busy: try again' }
}

/** Ends a call: adds what it really cost to the key and frees its in-flight slot. */
export async function settleLiveCall(keyId: string, costUsd: number): Promise<void> {
  const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
  await sql`UPDATE live_model_keys SET usd_used = usd_used + ${cost}, busy_until = NULL WHERE id = ${keyId}`
}

/** Revokes a key and reports what it was used for. Never throws; null when the row could not be read. */
export async function revokeLiveKey(keyId: string, reason: string, now: Date = new Date()): Promise<{ calls_used: number; usd_used: number } | null> {
  try {
    await ensureLiveModelTables()
    const r = await sql`
      UPDATE live_model_keys
      SET revoked = TRUE, revoked_at = COALESCE(revoked_at, ${now.toISOString()}), revoke_reason = COALESCE(revoke_reason, ${reason.slice(0, 120)})
      WHERE id = ${keyId}
      RETURNING calls_used, usd_used
    `
    const row = r.rows[0]
    return row ? { calls_used: Number(row.calls_used) || 0, usd_used: Number(row.usd_used) || 0 } : null
  } catch (e) {
    console.warn('[live-model] could not revoke a key:', e instanceof Error ? e.message : e)
    return null
  }
}

/** What the endpoint has cost since 00:00 UTC, from the spend ledger. */
export async function liveModelSpentTodayUsd(now: Date = new Date()): Promise<number> {
  const r = await sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM model_calls
    WHERE purpose = ${LIVE_MODEL_PURPOSE} AND created_at >= ${utcDayStart(now).toISOString()}
  `
  return Number(r.rows[0]?.total) || 0
}

export interface LiveCallRecord {
  key: LiveKeyGrant
  modelAsked: string
  modelServed: string | null
  status: 'ok' | 'upstream_error' | 'timeout' | 'no_answer'
  httpStatus: number | null
  finishReason: string | null
  promptTokens: number
  completionTokens: number
  costUsd: number
  costSource: string
  durationMs: number
  /** Short, cleaned extras: message and tool counts, dropped fields, tool call names, excerpts. */
  detail: Record<string, unknown>
}

const excerpt = (v: unknown, max = 200): string => sanitizeOutput(typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max)

function cleanDetail(detail: Record<string, unknown>): string {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(detail).slice(0, 16)) {
    if (typeof v === 'string') out[k] = excerpt(v)
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map(x => excerpt(String(x), 80))
  }
  return JSON.stringify(out)
}

/** Stores one call as evidence. Never throws: a store failure is logged and the answer still goes out. */
export async function recordLiveCall(rec: LiveCallRecord): Promise<void> {
  try {
    await ensureLiveModelTables()
    await sql`
      INSERT INTO live_model_calls (
        key_id, experiment_id, epoch, issued_to, sprite, model_asked, model_served, status, http_status, finish_reason,
        prompt_tokens, completion_tokens, cost_usd, cost_source, duration_ms, detail
      ) VALUES (
        ${rec.key.id}, ${rec.key.experiment_id}, ${rec.key.epoch}, ${rec.key.model}, ${rec.key.sprite},
        ${rec.modelAsked}, ${rec.modelServed ? excerpt(rec.modelServed, 120) : null}, ${rec.status}, ${rec.httpStatus},
        ${rec.finishReason ? excerpt(rec.finishReason, 40) : null}, ${rec.promptTokens}, ${rec.completionTokens},
        ${Math.max(0, rec.costUsd)}, ${rec.costSource}, ${Math.round(rec.durationMs)}, ${cleanDetail(rec.detail)}
      )
    `
  } catch (e) {
    console.warn('[live-model] could not store a call record:', e instanceof Error ? e.message : e)
  }
}
