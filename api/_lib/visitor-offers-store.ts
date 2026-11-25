/**
 * What the database holds for conversations visitors offer (visitor-offers.ts).
 *
 *   visitor_offers   one row per offer: the UTC day, the adapter, the
 *                    conversation (NULL once taken back, deleted or expired),
 *                    hashes for uniqueness and for the take back code, the
 *                    runs that read it, when the owner first read it, and when
 *                    it expires. Nothing that identifies a sender: no address,
 *                    no hash of one, no browser string, no time of day, and
 *                    no size (no turn or character count, which the chat's
 *                    own per reply call rows could be matched against).
 *                    Once the text is taken back, deleted or expired, the
 *                    row's hashes of that text are overwritten too.
 *
 * The per visitor limits are counted in the chat's existing trained_chat_rate
 * table (tinker-store.ts), by the chat's own daily keyed hashes, under the
 * buckets od:<day> (offers) and ow:<day> (take back tries). Those rows hold a
 * count and are pruned after 48 hours as before; they carry no offer id, but
 * they do have a time of their own (created_at). The all-offers and
 * per-adapter day caps are counted in visitor_offer_caps, which holds a day,
 * a name and a count, and no time.
 *
 * No function here logs or throws text a visitor wrote. Errors are reported
 * by the callers with a fixed line.
 */
import { sql } from '@vercel/postgres'
import { isAdapterSlug, tinkerBaseModels } from './tinker.js'
import { ensureTinkerTables, utcDay } from './tinker-store.js'
import {
  OFFER_SCREEN_VERSION, offerOrderKey, offersToTinkerRequest, pickByDay, visitorOffersStatus,
  type ClaimedOffer, type OfferMessage, type TinkerOffersRequest, type VisitorOffersRecord,
} from './visitor-offers.js'
import type { TinkerRequest } from './tinker.js'

let tablesReady: Promise<void> | null = null
/** Creates the offers table and its indexes. The cached promise resets on failure. */
export function ensureOfferTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await ensureTinkerTables()
      await sql`
        CREATE TABLE IF NOT EXISTS visitor_offers (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          day TEXT NOT NULL,
          adapter_slug TEXT NOT NULL,
          base_model TEXT NOT NULL,
          messages JSONB,
          transcript_sha256 TEXT NOT NULL UNIQUE,
          code_sha256 TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          screen_v INTEGER NOT NULL DEFAULT 1,
          first_user_sha256 TEXT NOT NULL,
          adapter_from_visitors BOOLEAN NOT NULL DEFAULT FALSE,
          used_in JSONB NOT NULL DEFAULT '[]',
          read_at TIMESTAMP WITH TIME ZONE,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
      `
      // A table made before the size columns were dropped still has them, NOT NULL: no insert writes them any more.
      await sql`ALTER TABLE visitor_offers DROP COLUMN IF EXISTS turns`
      await sql`ALTER TABLE visitor_offers DROP COLUMN IF EXISTS chars`
      await sql`CREATE INDEX IF NOT EXISTS idx_visitor_offers_live ON visitor_offers(status, adapter_slug, day)`
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_visitor_offers_prompt ON visitor_offers(adapter_slug, first_user_sha256) WHERE status = 'stored'`
      // The day caps of all offers and of one adapter: a count a day and nothing else, so no row records when an offer came.
      await sql`CREATE TABLE IF NOT EXISTS visitor_offer_caps (day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name))`
    })().catch(e => {
      tablesReady = null
      throw e
    })
  }
  return tablesReady
}

const num = (v: unknown) => Number(v) || 0

/**
 * How many offers are stored (not taken back, deleted or expired) now. An
 * offer past its expires_at is not counted, read or claimed, whether or not
 * the hourly prune has reached it yet: every read below carries the same
 * condition.
 */
export async function storedOfferCount(adapter: string | null = null): Promise<number> {
  await ensureOfferTables()
  const r = adapter
    ? await sql`SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored' AND expires_at > NOW() AND adapter_slug = ${adapter}`
    : await sql`SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored' AND expires_at > NOW()`
  return num(r.rows[0]?.n)
}

/**
 * Offers a run could read now: stored, and not made in a chat with an
 * adapter that was itself trained on offers. For what the models and the
 * Reviewer are told.
 */
export async function usableOfferCount(adapter: string | null = null): Promise<number> {
  await ensureOfferTables()
  const r = adapter
    ? await sql`SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored' AND expires_at > NOW() AND adapter_from_visitors = FALSE AND messages IS NOT NULL AND adapter_slug = ${adapter}`
    : await sql`SELECT COUNT(*) AS n FROM visitor_offers WHERE status = 'stored' AND expires_at > NOW() AND adapter_from_visitors = FALSE AND messages IS NOT NULL`
  return num(r.rows[0]?.n)
}

/**
 * The count of usable offers the epoch runner puts in the models' tools list,
 * or null when the visitor note is not to be added: while Tinker training is
 * off for the models (`trainOn` false), while offers are off for the models
 * (then the database is not read at all), or when the count cannot be read.
 * This is the one gate of that note.
 */
export async function offersCountForPrompt(trainOn: boolean): Promise<number | null> {
  if (!trainOn || !visitorOffersStatus({ models: true }).enabled) return null
  return usableOfferCount().catch(() => null)
}

export interface NewOffer {
  day: string
  adapter: string
  baseModel: string
  messages: OfferMessage[]
  transcriptSha256: string
  codeSha256: string
  firstUserSha256: string
  adapterFromVisitors: boolean
  expiresAt: string
}

/**
 * Stores one offer. 'duplicate' when the same transcript, or a stored offer
 * with the same adapter and first message, is already there (the unique
 * index and constraint decide, in the same statement). Only these columns
 * are written; there is no created_at.
 */
export async function insertOffer(offer: NewOffer): Promise<'stored' | 'duplicate'> {
  await ensureOfferTables()
  const r = await sql`
    INSERT INTO visitor_offers (day, adapter_slug, base_model, messages, transcript_sha256, code_sha256, status, screen_v, first_user_sha256, adapter_from_visitors, expires_at)
    VALUES (${offer.day}, ${offer.adapter}, ${offer.baseModel}, ${JSON.stringify(offer.messages)}::jsonb, ${offer.transcriptSha256}, ${offer.codeSha256}, ${'stored'}, ${OFFER_SCREEN_VERSION}, ${offer.firstUserSha256}, ${offer.adapterFromVisitors}, ${offer.expiresAt})
    ON CONFLICT DO NOTHING
    RETURNING id
  `
  return r.rows[0] ? 'stored' : 'duplicate'
}

/**
 * Takes an offer back by the hash of its code: one statement nulls the text
 * and reads whether a run has claimed it. A claim is made in one statement
 * too (readOffersForRun), so the two cannot interleave: either the claim came
 * first and this answers trained_on, or this came first and the claim skips
 * the row. An offer already taken back, deleted or expired is found again,
 * and its status is kept.
 */
export async function withdrawOffer(codeHash: string): Promise<{ found: false } | { found: true; trained_on: boolean }> {
  await ensureOfferTables()
  const r = await sql`
    UPDATE visitor_offers
    SET messages = NULL, status = CASE WHEN status = 'stored' THEN 'withdrawn' ELSE status END,
      transcript_sha256 = 'removed:' || id::text, first_user_sha256 = 'removed:' || id::text
    WHERE code_sha256 = ${codeHash}
    RETURNING used_in
  `
  const row = r.rows[0]
  if (!row) return { found: false }
  const used = typeof row.used_in === 'string' ? JSON.parse(row.used_in) : row.used_in
  return { found: true, trained_on: Array.isArray(used) && used.length > 0 }
}

const asRows = (rows: unknown[]) => rows as Array<Record<string, unknown>>

/**
 * Reads the offers for a run that named them, and claims them, before the
 * run starts. The text is read only by the claim: one UPDATE that adds
 * `claim` to used_in and returns the messages, for rows still stored. So a
 * take back cannot fall between reading the text and marking it as read.
 *
 * The order is sha256(salt + id) with a salt made up for the run, so which
 * offers are read cannot be steered by a sender. Which ids to claim is chosen
 * first from ids and days only (no text), with at most a quarter from any one
 * UTC day. After the claim the examples are made (visitor-offers.ts); every
 * claimed offer that did not become an example is released at once. When no
 * run can be made, all are released.
 *
 * `claim` is what goes into used_in: the run's slug when the caller knows it,
 * or a token the caller then turns into the slug with markOffersUsed once the
 * start is confirmed (or releases with markOffersUsed(claim, null)).
 */
export async function readOffersForRun(asked: TinkerOffersRequest, salt: string, claim: string, allowed: string[] = tinkerBaseModels().models):
  Promise<{ ok: true; request: TinkerRequest; record: VisitorOffersRecord; used: string[] } | { ok: false; error: string }> {
  await ensureOfferTables()
  const adapter = asked.visitor_offers.adapter
  const found = adapter
    ? await sql`SELECT id, day FROM visitor_offers WHERE status = 'stored' AND expires_at > NOW() AND adapter_from_visitors = FALSE AND messages IS NOT NULL AND adapter_slug = ${adapter}`
    : await sql`SELECT id, day FROM visitor_offers WHERE status = 'stored' AND expires_at > NOW() AND adapter_from_visitors = FALSE AND messages IS NOT NULL`
  const candidates = asRows(found.rows)
    .map(r => ({ id: String(r.id), day: String(r.day), key: offerOrderKey(salt, String(r.id)) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const chosen = pickByDay(candidates, asked.visitor_offers.limit).map(i => candidates[i].id)
  if (chosen.length === 0) return { ok: false, error: `the lab holds no visitor conversations a run could use${adapter ? ` in chats with lab/${adapter}` : ''} (at most a quarter may come from one day)` }

  const claimed = await sql`
    UPDATE visitor_offers SET used_in = used_in || to_jsonb(${claim}::text)
    WHERE id::text = ANY(string_to_array(${chosen.join(',')}, ',')) AND status = 'stored' AND expires_at > NOW() AND adapter_from_visitors = FALSE AND messages IS NOT NULL
    RETURNING id, day, messages
  `
  const order = new Map(chosen.map((id, i) => [id, i]))
  const offers: ClaimedOffer[] = asRows(claimed.rows)
    .map(r => ({ id: String(r.id), day: String(r.day), messages: typeof r.messages === 'string' ? JSON.parse(r.messages) : r.messages }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const built = offersToTinkerRequest(asked, offers, allowed)
  const used = 'error' in built ? [] : built.used
  const unused = offers.map(o => o.id).filter(id => !used.includes(id))
  if (unused.length) await releaseClaim(claim, unused)
  if ('error' in built) return { ok: false, error: built.error }
  return { ok: true, request: built.request, record: built.record, used }
}

async function releaseClaim(claim: string, ids: string[] | null): Promise<void> {
  if (ids) {
    await sql`UPDATE visitor_offers SET used_in = used_in - ${claim}::text WHERE id::text = ANY(string_to_array(${ids.join(',')}, ','))`
  } else {
    await sql`UPDATE visitor_offers SET used_in = used_in - ${claim}::text WHERE used_in ? ${claim}::text`
  }
}

/**
 * After the run's start: `slug` replaces the claim on every offer that holds
 * it (when the claim was already the slug, nothing changes). With `slug` null
 * the start was refused or never confirmed, and the claim is released.
 */
export async function markOffersUsed(claim: string, slug: string | null): Promise<void> {
  await ensureOfferTables()
  if (slug === null) return releaseClaim(claim, null)
  if (slug === claim) return
  await sql`
    UPDATE visitor_offers SET used_in = (used_in - ${claim}::text) || to_jsonb(${slug}::text)
    WHERE used_in ? ${claim}::text
  `
}

/** The public counts (spec 2.9). Counts only. */
export interface VisitorOffersCounts {
  enabled: boolean
  stored: number
  offered_today: number
  trained_on: number
  taken_back: number
  read_by_owner: number
}

/**
 * The counts for the public record. `createTables: false` only looks, for a
 * server where offers are off: the caller treats a failure (no such table)
 * as no rows.
 */
export async function offersCounts(now: Date = new Date(), opts: { createTables?: boolean } = {}): Promise<VisitorOffersCounts> {
  if (opts.createTables !== false) await ensureOfferTables()
  const r = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'stored' AND expires_at > NOW()) AS stored,
      COUNT(*) FILTER (WHERE day = ${utcDay(now)}) AS offered_today,
      COUNT(*) FILTER (WHERE used_in <> '[]'::jsonb) AS trained_on,
      COUNT(*) FILTER (WHERE status = 'withdrawn') AS taken_back,
      COUNT(*) FILTER (WHERE read_at IS NOT NULL) AS read_by_owner
    FROM visitor_offers
  `
  const row = r.rows[0] ?? {}
  return {
    enabled: visitorOffersStatus().enabled,
    stored: num(row.stored), offered_today: num(row.offered_today), trained_on: num(row.trained_on),
    taken_back: num(row.taken_back), read_by_owner: num(row.read_by_owner),
  }
}

/**
 * Expiry: every stored offer past its time has its text set to NULL and its
 * status to 'expired'; the row stays as a count. Called once per hourly tick.
 * Never throws.
 */
export async function pruneOffers(now: Date = new Date()): Promise<number> {
  try {
    await ensureOfferTables()
    const r = await sql`
      UPDATE visitor_offers SET messages = NULL, status = 'expired', transcript_sha256 = 'removed:' || id::text, first_user_sha256 = 'removed:' || id::text
      WHERE status = 'stored' AND expires_at < ${now.toISOString()}
      RETURNING id
    `
    // The day caps are needed for today only; yesterday's is kept for a day as the rate rows are.
    await sql`DELETE FROM visitor_offer_caps WHERE day < ${utcDay(new Date(now.getTime() - 2 * 86_400_000))}`
    await vacuumOffers()
    return r.rows.length
  } catch {
    console.warn('[visitor-offers] could not expire old offers')
    return 0
  }
}

/**
 * Setting the text to NULL leaves the old row version, text included, in the
 * table's file until Postgres vacuums it, and on a small table autovacuum can
 * wait a long time (50 dead rows plus a fifth of the table). So the hourly
 * prune vacuums the table itself: text taken back, deleted or expired is out
 * of the table file within the hour. The database's own history (write ahead
 * log, point in time restore) is not touched by this. Never throws: a
 * database that refuses the statement is logged with a fixed line.
 */
export async function vacuumOffers(): Promise<boolean> {
  try {
    await sql`VACUUM visitor_offers`
    return true
  } catch {
    console.warn('[visitor-offers] could not vacuum the offers table; deleted text stays in its file until the database vacuums it')
    return false
  }
}

// ---------------------------------------------------------------------------
// The owner's route (api/experiment/visitor-offers.ts)
// ---------------------------------------------------------------------------

export interface OwnerOfferRow {
  id: string
  day: string
  adapter_slug: string
  base_model: string
  messages: unknown
  /** Counted from the text when it is read: the row stores no size. */
  turns: number
  chars: number
  status: string
  used_in: unknown
  adapter_from_visitors: boolean
  read_at: string | null
  expires_at: string | null
}

/**
 * Returns stored offers with their text, newest day first, and sets read_at
 * on each row returned (the first read only), in the same statement, so a
 * row cannot be returned without being counted as read.
 */
export async function ownerReadOffers(opts: { limit: number; beforeDay: string | null }): Promise<OwnerOfferRow[]> {
  await ensureOfferTables()
  const before = opts.beforeDay ?? ''
  const r = await sql`
    UPDATE visitor_offers SET read_at = COALESCE(read_at, NOW())
    WHERE id IN (
      SELECT id FROM visitor_offers
      WHERE messages IS NOT NULL AND expires_at > NOW() AND (${before} = '' OR day < ${before})
      ORDER BY day DESC, id DESC
      LIMIT ${opts.limit}
    )
    RETURNING id, day, adapter_slug, base_model, messages, status, used_in, adapter_from_visitors, read_at, expires_at
  `
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null)
  const size = (m: unknown) => {
    const list = Array.isArray(m) ? m as Array<{ content?: unknown }> : []
    return { turns: Math.floor(list.length / 2), chars: list.reduce((a, x) => a + (typeof x?.content === 'string' ? x.content.length : 0), 0) }
  }
  return asRows(r.rows).map(row => ({
    id: String(row.id), day: String(row.day), adapter_slug: String(row.adapter_slug), base_model: String(row.base_model),
    messages: typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages,
    ...size(typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages),
    status: String(row.status), used_in: typeof row.used_in === 'string' ? JSON.parse(row.used_in) : row.used_in,
    adapter_from_visitors: row.adapter_from_visitors === true, read_at: iso(row.read_at), expires_at: iso(row.expires_at),
  })).sort((a, b) => (a.day === b.day ? (a.id < b.id ? 1 : -1) : a.day < b.day ? 1 : -1))
}

/** Deletes one offer's text (the row stays as a count). False when there was no text to delete. */
export async function ownerDeleteOffer(id: string): Promise<boolean> {
  await ensureOfferTables()
  const r = await sql`UPDATE visitor_offers SET messages = NULL, status = 'deleted', transcript_sha256 = 'removed:' || id::text, first_user_sha256 = 'removed:' || id::text WHERE id::text = ${id} AND messages IS NOT NULL RETURNING id`
  return r.rows.length > 0
}

/** Deletes the text of every offer that still has some. The rows stay as counts. */
export async function ownerDeleteAllOffers(): Promise<number> {
  await ensureOfferTables()
  const r = await sql`UPDATE visitor_offers SET messages = NULL, status = 'deleted', transcript_sha256 = 'removed:' || id::text, first_user_sha256 = 'removed:' || id::text WHERE messages IS NOT NULL RETURNING id`
  return r.rows.length
}

/** A uuid as the database writes one. */
export function isOfferId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
}

/** Not a hash of anyone: the names the all-offers and per-adapter day caps are counted under in visitor_offer_caps. */
export function capCounterName(kind: 'all' | 'adapter', adapter = ''): string {
  return kind === 'all' ? 'visitor-offers|all' : `visitor-offers|adapter|${isAdapterSlug(adapter) ? adapter : 'unknown'}`
}

/**
 * Takes one place of a day cap in one statement. False when the day is full,
 * and always for a limit below 1 (a limit of 0 takes nothing). The row holds
 * the day, the name and the count: no time.
 */
export async function countOfferCap(name: string, day: string, limit: number): Promise<boolean> {
  if (!(limit >= 1)) return false
  await ensureOfferTables()
  const r = await sql`
    INSERT INTO visitor_offer_caps (day, name, n) VALUES (${day}, ${name}, 1)
    ON CONFLICT (day, name) DO UPDATE SET n = visitor_offer_caps.n + 1 WHERE visitor_offer_caps.n < ${limit}
    RETURNING n
  `
  return r.rows.length > 0
}
