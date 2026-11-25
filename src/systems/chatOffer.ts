// Pure helpers for offering a conversation to the lab (spec 2.2 and 2.4), used
// by the trained chat panel. No DOM, no network, no storage.
//
// The panel shows the visitor the exact text the lab will keep before anything
// is sent. That text is written here once, as a list of sentences. Each
// sentence that states what the lab stores or does names the stored column it
// relies on (OFFER_CLAIMS), and a test checks the list against the table
// definition in api/_lib/visitor-offers-store.ts, so the words cannot drift
// from what is kept. Numbers in the text come from the server's `offers`
// block, never from this file.
//
// The take back code is shown once and lives in the panel's memory only.
// Nothing here writes it anywhere.

/** The `offers` block of GET /api/experiment/trained-chat, read strictly. */
export interface OffersInfo {
  keepDays: number
  perDay: number
}

/** Longest receipt the chat route accepts. */
export const RECEIPT_MAX = 80

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/**
 * The offers block of the list answer. Null unless the server says offers are
 * on and sends both numbers. Anything else means no offer button at all.
 */
export function readOffers(raw: unknown): OffersInfo | null {
  const list = raw && typeof raw === 'object' ? (raw as { offers?: unknown }).offers : null
  if (!list || typeof list !== 'object') return null
  const o = list as Record<string, unknown>
  if (o.enabled !== true) return null
  if (!isInt(o.keep_days) || o.keep_days < 1 || o.keep_days > 3650) return null
  if (!isInt(o.per_day) || o.per_day < 0 || o.per_day > 1000) return null
  return { keepDays: o.keep_days, perDay: o.per_day }
}

/** A receipt the server issued, or null. It is only ever passed on as it came. */
export function readReceipt(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= RECEIPT_MAX && /^[\x21-\x7e]+$/.test(v) ? v : null
}

export interface OfferTurn { role: 'user' | 'assistant'; content: string }

/** The body of an offer: exactly these three keys. */
export function buildOfferBody(adapter: string, turns: readonly OfferTurn[], receipt: string): { adapter: string; messages: OfferTurn[]; receipt: string } {
  return { adapter, messages: turns.map(t => ({ role: t.role, content: t.content })), receipt }
}

/** The body of a take back: exactly this one key. */
export function buildWithdrawBody(code: string): { withdraw: string } {
  return { withdraw: code }
}

/**
 * Can this conversation be offered? Two to sixteen messages, alternating from
 * the visitor and ending with a reply, and a receipt held for that last reply.
 */
export function canOffer(turns: readonly OfferTurn[], receipt: string | null): boolean {
  if (!receipt || turns.length < 2 || turns.length > 16 || turns.length % 2 !== 0) return false
  return turns.every((t, i) => t.role === (i % 2 === 0 ? 'user' : 'assistant') && t.content.length > 0)
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

export const OFFER_BUTTON = 'Offer This Conversation to the Lab'
export const OFFERED_BUTTON = 'Offered'
export const OFFER_DISABLED_NOTE = 'Only a conversation the lab can verify can be offered.'
export const OFFER_HEADING = 'Offer This Conversation'
export const OFFER_SUBMIT = 'Offer It'
export const OFFER_CANCEL = 'Not Now'
export const OFFER_SENDING = 'Offering'
export const OFFER_THANKS = 'Thank you. The lab stored this conversation.'
export const OFFER_COPY = 'Copy Code'
export const OFFER_COPIED = 'Copied'
export const OFFER_COPY_FAILED = 'The code could not be copied. Select it and copy it by hand.'
export const OFFER_DONE = 'Done'
export const OFFER_TAKE_BACK = 'Take It Back'
export const OFFER_TAKING_BACK = 'Taking Back'
export const TAKE_BACK_OPEN = 'Take Back an Offer'
export const TAKE_BACK_HEADING = 'Take Back an Offer'
export const TAKE_BACK_LABEL = 'Your Take Back Code'
export const TAKE_BACK_HELP = 'Write the code you got after you offered a conversation. The lab deletes the stored text.'
export const TAKE_BACK_BAD_CODE = 'That is not a take back code. It has 12 letters and numbers, like XXXX-XXXX-XXXX.'
export const OFFER_UNREACHED = 'The lab could not be reached. Nothing was kept. Check your connection and try again.'
export const OFFER_TRAINED_ON = 'Done. The lab deleted the stored text. A model was already trained on it and cannot unlearn it.'
export const OFFER_WITHDRAWN = 'Done. The lab deleted the stored text.'
export const OFFER_PREVIEW_LABEL = 'This is the conversation exactly as the lab would store it.'

/** One sentence of the consent text. `columns` is set on a sentence that says what is stored or done, naming the columns it relies on. */
export interface ConsentSentence {
  text: (keepDays: number) => string
  columns?: readonly string[]
}

const plain = (text: string): ConsentSentence => ({ text: () => text })
const claim = (text: string | ((keepDays: number) => string), columns: readonly string[]): ConsentSentence => ({
  text: typeof text === 'string' ? () => text : text,
  columns,
})

/**
 * The consent text of the sheet, word for word (spec 2.2), one list of
 * sentences for each paragraph. `columns` names what a sentence relies on:
 * the stored columns `messages`, `adapter_slug`, `base_model` and `day` are
 * what is kept; "no address" is the absence of any other column, so it names
 * the bookkeeping columns that hold no text and no identity.
 */
export const CONSENT_PARAGRAPHS: ReadonlyArray<readonly ConsentSentence[]> = [
  [
    claim('If you press Offer It, the lab stores this conversation: your messages, the model\'s replies, which model you talked to, and the day.', ['messages', 'adapter_slug', 'base_model', 'day']),
    claim('It does not store your address or an account.', ['id', 'turns', 'chars', 'transcript_sha256', 'first_user_sha256', 'screen_v']),
  ],
  [
    plain('The lab\'s AI models may choose to train a small model on it.'),
    claim('Anything trained on it is labelled "written by visitors".', ['used_in', 'adapter_from_visitors']),
    plain('A model trained on it can repeat parts of it.'),
  ],
  [
    claim('The text is not shown on this page or in the lab\'s public record. The record shows only how many conversations were offered.', ['status']),
    claim('The lab\'s owner can read it.', ['read_at']),
    plain('It may be sent to Tinker (Thinking Machines) and Modal to train a small model. Those are companies outside the lab.'),
  ],
  [
    claim(days => `The lab keeps it for ${days} days, then deletes it.`, ['expires_at']),
    claim('You can take it back with a code you get after offering.', ['code_sha256']),
    plain('If a model has already trained on it, the stored text is still deleted, but that model cannot unlearn it, and copies in the training services may stay until they delete them.'),
  ],
  [
    plain('The lab checks for email addresses, phone numbers, long numbers, links and user names, and refuses a conversation that has one. It cannot find names, street addresses or other private details, so do not write them.'),
  ],
  [plain('Offer only if you are 18 or older.')],
  [plain('Until you press Offer It, nothing you write here is kept.')],
]

/** Every sentence that states what is stored or done, with the columns it relies on. */
export const OFFER_CLAIMS: ReadonlyArray<{ text: (keepDays: number) => string; columns: readonly string[] }> =
  CONSENT_PARAGRAPHS.flat().filter((s): s is ConsentSentence & { columns: readonly string[] } => s.columns !== undefined)

/** The consent text as paragraphs, with the server's keep_days put in. */
export function consentParagraphs(keepDays: number): string[] {
  return CONSENT_PARAGRAPHS.map(p => p.map(s => s.text(keepDays)).join(' '))
}

// ---------------------------------------------------------------------------
// Reading the answers
// ---------------------------------------------------------------------------

function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** What a refusal says when the server sent no sentence of its own. */
const FALLBACK: Record<number, string> = {
  400: 'This conversation could not be offered.',
  403: 'This conversation cannot be offered. Start a new one and offer that.',
  404: 'This model is no longer on the shelf.',
  409: 'This conversation was already offered.',
  413: 'This conversation is too long to offer.',
  415: 'This conversation could not be offered.',
  422: 'This conversation could not be offered. Nothing was kept.',
  429: 'The lab is not taking more conversations just now.',
  503: 'Offers are not available right now.',
}

export type OfferAnswer =
  | { kind: 'stored'; code: string; keptUntil: string | null; message: string }
  | { kind: 'refused'; status: number; error: string; message: string }

/** A take back code as the server shows it: three groups of four letters and numbers. */
const CODE = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/

/** The answer to an offer, strictly read. A 201 without a well formed code is not a success the visitor can use, so it is an error. */
export function readOfferAnswer(status: number, json: unknown): OfferAnswer {
  const o = json && typeof json === 'object' ? json as Record<string, unknown> : {}
  const message = clean(o.message, 300)
  if (status === 201 && o.offered === true && typeof o.code === 'string' && CODE.test(o.code)) {
    const until = typeof o.kept_until === 'string' && !Number.isNaN(Date.parse(o.kept_until)) ? o.kept_until : null
    return { kind: 'stored', code: o.code, keptUntil: until, message: message ?? OFFER_THANKS }
  }
  const error = typeof o.error === 'string' && /^[a-z_]{1,24}$/.test(o.error) ? o.error : 'unavailable'
  return { kind: 'refused', status, error, message: message ?? FALLBACK[status] ?? 'This conversation could not be offered.' }
}

export type WithdrawAnswer =
  | { kind: 'withdrawn'; trainedOn: boolean; message: string }
  | { kind: 'refused'; status: number; error: string; message: string }

/** The answer to a take back, strictly read. */
export function readWithdrawAnswer(status: number, json: unknown): WithdrawAnswer {
  const o = json && typeof json === 'object' ? json as Record<string, unknown> : {}
  const message = clean(o.message, 300)
  if (status === 200 && o.withdrawn === true) {
    const trainedOn = o.trained_on === true
    return { kind: 'withdrawn', trainedOn, message: message ?? (trainedOn ? OFFER_TRAINED_ON : OFFER_WITHDRAWN) }
  }
  const error = typeof o.error === 'string' && /^[a-z_]{1,24}$/.test(o.error) ? o.error : 'unavailable'
  const fallback = status === 404 ? 'The lab does not know that code. Check it and try again.' : status === 429 ? 'Too many tries today. Please try again tomorrow.' : 'The offer could not be taken back. Try again in a moment.'
  return { kind: 'refused', status, error, message: message ?? fallback }
}

/**
 * A take back code as a visitor may type it: any case, with or without dashes
 * or spaces. Twelve letters and numbers, shown as XXXX-XXXX-XXXX, or null.
 * The server does its own, stricter reading.
 */
export function normalizeCode(raw: string): string | null {
  const flat = raw.toUpperCase().replace(/[\s-]/g, '')
  if (!/^[0-9A-Z]{12}$/.test(flat)) return null
  return `${flat.slice(0, 4)}-${flat.slice(4, 8)}-${flat.slice(8, 12)}`
}
