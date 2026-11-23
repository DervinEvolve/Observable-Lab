/**
 * What the public state says about the visitor chat, for the room's speaking
 * tube (`trained_chat_activity` in GET /api/experiment).
 *
 * It is built from rows the chat already writes (trained_chat_calls, status
 * 'ok' only): which adapter answered last, when, and how many answers there
 * were today (UTC). There is no new table, column or write. No message text,
 * no visitor hash, no turn count and no cost is in it, and an error, a refusal
 * or an untrained comparison row never counts. It is absent unless the chat is
 * on and an answer was given in the last 24 hours.
 *
 * Read at most every few seconds per server instance, and it never throws.
 */
import { isAdapterSlug, trainedChatStatus } from './tinker.js'
import { chatCallsToday, latestChatCall } from './tinker-store.js'

export interface ChatActivity {
  /** The server's clock when this was built, so the page can measure age without trusting its own. */
  now: string
  today: number
  last: { adapter: string; at: string }
}

const CACHE_MS = 4000
const WINDOW_MS = 24 * 60 * 60 * 1000

/** Pure: the field as visitors may see it, or null. */
export function publicChatActivity(last: { slug: string; at: Date } | null, today: number, now: Date): ChatActivity | null {
  if (!last || !isAdapterSlug(last.slug)) return null
  const age = now.getTime() - last.at.getTime()
  if (!Number.isFinite(age) || age > WINDOW_MS) return null
  return {
    now: now.toISOString(),
    today: Number.isInteger(today) && today >= 0 ? today : 0,
    last: { adapter: last.slug, at: last.at.toISOString() },
  }
}

let cached: { at: number; value: ChatActivity | null } | null = null

/** The field, or null while the chat is off, nothing was answered lately, or the record cannot be read. */
export async function chatActivity(now: Date = new Date()): Promise<ChatActivity | null> {
  if (!trainedChatStatus().enabled) return null
  if (cached && now.getTime() - cached.at < CACHE_MS && now.getTime() >= cached.at) return cached.value
  let value: ChatActivity | null = null
  try {
    const last = await latestChatCall()
    value = last ? publicChatActivity(last, await chatCallsToday(now), now) : null
  } catch {
    value = null
  }
  cached = { at: now.getTime(), value }
  return value
}

/** For tests: forget what was read. */
export function resetChatActivityCache(): void {
  cached = null
}
