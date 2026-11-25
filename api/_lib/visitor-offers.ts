/**
 * Conversations visitors offer to the lab for training
 * (docs/TOOLS.md, "Conversations visitors offer").
 *
 * The visitor chat stores no text. A visitor may press "Offer This
 * Conversation to the Lab", and only then is that conversation stored,
 * labelled as written by visitors, and the lab's models may name those
 * conversations as the data of a Tinker training run.
 *
 * This file is the part with no database and no network in it: the switch
 * and its limits, the receipt that proves a conversation came from the lab's
 * own endpoint, the take back code, the screening, the strict reading of an
 * offer and of a training request that names offers, the examples made from
 * stored offers, and the text the models are told.
 *
 * The receipt. The chat is stateless: the browser sends the whole
 * conversation with every message, so an offered transcript cannot be
 * trusted as sent. Every reply the chat gives carries a receipt, an HMAC over
 * the conversation up to and including that reply, and a reply only gets one
 * when the conversation before it carried a valid receipt too. So a receipt
 * exists only for a conversation in which every reply came from the lab's
 * endpoint, in order. Nothing is stored to do this. The key is derived from
 * LAB_OPERATOR_SECRET and from nothing else: a leaked database URL must not
 * be able to forge receipts, so without that secret no receipt is issued and
 * nothing can be offered.
 *
 * The owner's route. A stored offer can be read and deleted only through
 * POST /api/experiment/visitor-offers, which opens with LAB_OPERATOR_SECRET
 * of at least 32 characters and with nothing else (auth.ts). So offers are on
 * only while that secret is set at that length: the lab stores nothing a
 * visitor gave that its owner could not delete. CRON_SECRET alone does not
 * turn offers on. Taking an offer back and the hourly prune need neither.
 *
 * Import note: trained-chat.ts imports this file and this file imports the
 * chat's message reader from trained-chat.ts. Neither uses the other's
 * exports at module top level, only inside functions, so the cycle is safe
 * in either load order. Keep it that way.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { normaliseText } from './rubric.js'
import {
  TINKER_MAX_DATASET_BYTES, TINKER_MAX_EXAMPLE_BYTES, TINKER_MAX_MESSAGES, TINKER_MAX_STEPS, TINKER_MIN_EXAMPLES, estimateTinkerRun, isAdapterSlug,
  normalizeTinkerRequest, plannedSteps, readSettings, tinkerBaseModels, tinkerNamesFlag, tinkerStatus, trainedChatStatus, usdText,
  type TinkerEstimate, type TinkerExample, type TinkerMessage, type TinkerRequest, type TinkerSettings, type TinkerStatus,
} from './tinker.js'
import { readAdapterName } from './tinker-names.js'
import { ORIGIN_VISITORS, utcDay, type VisitorOffersRecord } from './tinker-store.js'
import { readChatMessages, type ChatRefusal } from './trained-chat.js'

export { ORIGIN_VISITORS }
export type { VisitorOffersRecord }

// ---------------------------------------------------------------------------
// The switch and the limits
// ---------------------------------------------------------------------------

const OFF_VALUES = ['false', '0', 'off', 'no']

/** On unless LAB_ENABLE_VISITOR_OFFERS is false, 0, off or no (spaces and capitals ignored). */
export function visitorOffersFlag(): boolean {
  return !OFF_VALUES.includes((process.env.LAB_ENABLE_VISITOR_OFFERS || '').trim().toLowerCase())
}

/**
 * May the visitor chat answer with an adapter trained on conversations
 * visitors offered? Off unless LAB_TRAINED_CHAT_VISITOR_ADAPTERS is exactly
 * "true", like the dataset switch: no model read that text and nobody reviewed it.
 */
export function visitorAdaptersFlag(): boolean {
  return (process.env.LAB_TRAINED_CHAT_VISITOR_ADAPTERS || '').trim().toLowerCase() === 'true'
}

/**
 * The shortest LAB_OPERATOR_SECRET that turns offers on and that a receipt
 * key is made from: the length requireBearer (auth.ts) asks of it before the
 * owner's read and delete route opens. Every chat reply hands the visitor a
 * receipt made with this key, so a guess of the secret can be tested against
 * one receipt without asking the server: the secret has to be long and random.
 */
export const RECEIPT_SECRET_MIN_CHARS = 32

/**
 * A value the owner can send back in an Authorization header by copying it:
 * visible ASCII characters, with spaces only inside. requireBearer compares
 * the header with the stored value as it is. A space, a tab or a line break
 * at the end of the stored value is dropped from a header on the way (or
 * cannot be sent at all), and a character outside ASCII arrives as other
 * characters, so such a secret answers 401 to every request (checked over
 * real HTTP). A space at the start opens only for a header that carries that
 * extra space after "Bearer ", which a copied value does not.
 */
const SENDABLE_SECRET = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/**
 * Why LAB_OPERATOR_SECRET does not open the owner's read and delete route, or
 * null when it does: requireBearer (auth.ts) asks for 32 characters and then
 * compares the stored value, untrimmed, with what the owner sends.
 */
function ownerSecretProblem(): string | null {
  const secret = process.env.LAB_OPERATOR_SECRET || ''
  if (secret.length < RECEIPT_SECRET_MIN_CHARS) return `LAB_OPERATOR_SECRET is not set with at least ${RECEIPT_SECRET_MIN_CHARS} characters`
  if (!SENDABLE_SECRET.test(secret)) return 'LAB_OPERATOR_SECRET is stored with a space or a line break at an end, or with a character a request header cannot carry'
  return null
}

/**
 * LAB_OPERATOR_SECRET when the owner's read and delete route opens with it,
 * exactly as stored, or ''. CRON_SECRET is not looked at: it does not open
 * that route.
 */
function ownerSecret(): string {
  return ownerSecretProblem() === null ? process.env.LAB_OPERATOR_SECRET || '' : ''
}

/**
 * The key receipts are signed with, or null when LAB_OPERATOR_SECRET is not
 * set at its full length. There is deliberately no CRON_SECRET and no
 * POSTGRES_URL fallback (unlike the chat's visitor hashes): the scheduler's
 * secret does not let the owner delete an offer, and a leaked database URL
 * must not forge receipts.
 */
function receiptKey(): Buffer | null {
  const secret = ownerSecret()
  if (!secret) return null
  return createHash('sha256').update(`visitor-offer|${secret}`, 'utf8').digest()
}

/**
 * Are offers on? The switch, the visitor chat (no chat, no button), and
 * LAB_OPERATOR_SECRET at its full length: it opens the only route the owner
 * can read and delete an offer through, and the receipt key is made from it
 * (no key, no receipt, nothing could be offered). With `models` it also asks
 * that Tinker training is on, for what the models are told. This one answer
 * decides the public state, the chat's Offer button, the offer route, the
 * models' note and the training request form.
 * While off: the chat answers exactly what it answered before this feature,
 * the offer route answers 503 without touching the database, and taking an
 * offer back, the hourly prune and the operator route still work for offers
 * already stored.
 */
export function visitorOffersStatus(opts: { models?: boolean } = {}): TinkerStatus {
  if (!visitorOffersFlag()) return { enabled: false, off_reason: 'LAB_ENABLE_VISITOR_OFFERS is off' }
  const chat = trainedChatStatus()
  if (!chat.enabled) return { enabled: false, off_reason: `the visitor chat is off (${chat.off_reason ?? 'unknown'})` }
  const secretProblem = ownerSecretProblem()
  if (secretProblem) return { enabled: false, off_reason: `${secretProblem}, so the owner could not read or delete an offer and no receipt can be issued` }
  if (opts.models) {
    const tinker = tinkerStatus()
    if (!tinker.enabled) return { enabled: false, off_reason: `Tinker training is off (${tinker.off_reason ?? 'unknown'})` }
  }
  return { enabled: true }
}

/** Messages in one offer: one turn at least, and the chat's own 8 turns at most (16 messages, ending with the reply). */
export const OFFER_MIN_MESSAGES = 2
export const OFFER_MAX_MESSAGES = 16
/** The offer route's body, in bytes of JSON. */
export const OFFER_MAX_BODY_BYTES = 32 * 1024
/** A receipt as the chat accepts it. */
export const RECEIPT_MAX_CHARS = 80
/** Offers one visitor (an address and a browser string) may make in a UTC day, and one address whatever its browser string. */
export const OFFERS_PER_VISITOR_DAY = 3
export const OFFERS_PER_ADDRESS_DAY = 6
/** Offers one adapter may be given in a UTC day, so a popular adapter cannot fill the store. */
export const OFFERS_PER_ADAPTER_DAY = 20
/** Take back tries one address may make in a UTC day. */
export const WITHDRAW_TRIES_PER_DAY = 10
export const DEFAULT_OFFERS_PER_DAY = 100
export const OFFERS_HARD_PER_DAY = 1000
export const DEFAULT_OFFERS_MAX = 2000
export const OFFERS_HARD_MAX = 20_000
export const DEFAULT_OFFERS_DAYS = 180
export const OFFERS_DAYS = { min: 30, max: 365 } as const
/** The version of the screening below, stored on every offer. */
export const OFFER_SCREEN_VERSION = 2
/** A training request that names offers. */
export const OFFERS_RUN_LIMIT = { min: TINKER_MIN_EXAMPLES, max: 500, fallback: 200 } as const
export const OFFERS_MAX_SYSTEM_BYTES = 2000
/** At most this share of a run's conversations may come from one UTC day. */
export const OFFERS_DAY_SHARE = 0.25

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] || '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}
/** All offers the lab takes in a UTC day (LAB_VISITOR_OFFERS_PER_DAY, 0 to 1000). */
export function visitorOffersPerDay(): number {
  return intEnv('LAB_VISITOR_OFFERS_PER_DAY', DEFAULT_OFFERS_PER_DAY, 0, OFFERS_HARD_PER_DAY)
}
/** Offers stored at one time (LAB_VISITOR_OFFERS_MAX, hard 20000). */
export function visitorOffersMax(): number {
  return intEnv('LAB_VISITOR_OFFERS_MAX', DEFAULT_OFFERS_MAX, 0, OFFERS_HARD_MAX)
}
/** Days an offer is kept (LAB_VISITOR_OFFERS_DAYS, 30 to 365). */
export function visitorOffersDays(): number {
  return intEnv('LAB_VISITOR_OFFERS_DAYS', DEFAULT_OFFERS_DAYS, OFFERS_DAYS.min, OFFERS_DAYS.max)
}

/**
 * When an offer made on `day` expires: the end of that UTC day plus the days
 * it is kept. Made from the day alone, so the stored expiry tells no more
 * about when the offer was made than the day does.
 */
export function offerExpiry(day: string, days: number = visitorOffersDays()): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + (days + 1) * 86_400_000).toISOString()
}

/** The block the chat's GET carries while offers are on. Numbers come from here, never from the page. */
export function offersBlock(): { enabled: true; keep_days: number; per_day: number; public_text: false } {
  return { enabled: true, keep_days: visitorOffersDays(), per_day: OFFERS_PER_VISITOR_DAY, public_text: false }
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

export interface OfferMessage { role: 'user' | 'assistant'; content: string }

const sha256hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The conversation as the receipt and the uniqueness of an offer see it. */
export function transcriptCanon(messages: readonly { role: string; content: string }[]): string {
  return JSON.stringify(messages.map(m => [m.role, m.content]))
}
export function transcriptSha256(messages: readonly { role: string; content: string }[]): string {
  return sha256hex(transcriptCanon(messages))
}
/** The hash of the first visitor message, for the one offer per (adapter, first message) rule. */
export function firstUserSha256(messages: readonly { role: string; content: string }[]): string {
  return sha256hex(`first-user|${messages.find(m => m.role === 'user')?.content ?? ''}`)
}

function receiptMac(key: Buffer, slug: string, day: string, messages: readonly { role: string; content: string }[]): string {
  return createHmac('sha256', key).update(`v1|${slug}|${day}|${transcriptSha256(messages)}`, 'utf8').digest('base64url')
}

/**
 * A receipt for a conversation that ends with a reply the lab's endpoint
 * just gave: `messages` as readChatRequest cleaned them, then the reply as
 * returned. null when this server has no receipt key.
 */
export function issueReceipt(slug: string, messages: readonly { role: string; content: string }[], now: Date = new Date()): string | null {
  const key = receiptKey()
  if (!key || !isAdapterSlug(slug)) return null
  const day = utcDay(now)
  return `${day}.${receiptMac(key, slug, day, messages)}`
}

const RECEIPT = /^(\d{4}-\d{2}-\d{2})\.([A-Za-z0-9_-]{43})$/

/** Does this receipt prove `messages` (ending with a reply) for this adapter, made today or yesterday (UTC)? */
export function verifyReceipt(receipt: unknown, slug: string, messages: readonly { role: string; content: string }[], now: Date = new Date()): boolean {
  if (typeof receipt !== 'string' || receipt.length > RECEIPT_MAX_CHARS || !isAdapterSlug(slug)) return false
  const key = receiptKey()
  if (!key) return false
  const m = RECEIPT.exec(receipt)
  if (!m) return false
  const day = m[1]
  if (day !== utcDay(now) && day !== utcDay(new Date(now.getTime() - 86_400_000))) return false
  const expected = Buffer.from(receiptMac(key, slug, day, messages), 'utf8')
  const given = Buffer.from(m[2], 'utf8')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// ---------------------------------------------------------------------------
// The take back code
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Characters of a take back code: 12 of Crockford base32, 60 bits. */
export const OFFER_CODE_CHARS = 12

/** A new take back code, shown once as XXXX-XXXX-XXXX. Only its hash is stored. */
export function newOfferCode(): string {
  let bits = BigInt(`0x${randomBytes(8).toString('hex')}`)
  let out = ''
  for (let i = 0; i < OFFER_CODE_CHARS; i++) {
    out += CROCKFORD[Number(bits & 31n)]
    bits >>= 5n
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`
}

/** Reads a code as a visitor may type it (any case, with or without dashes or spaces, I and L for 1, O for 0). The 12 characters, or null. */
export function readOfferCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  const flat = raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (flat.length !== OFFER_CODE_CHARS || [...flat].some(c => !CROCKFORD.includes(c))) return null
  return flat
}

/** What is stored of a code. */
export function codeSha256(code: string): string {
  return sha256hex(`visitor-offer-code|${code}`)
}

// ---------------------------------------------------------------------------
// Screening (spec 2.6): patterns only, on every message, after NFKC
// ---------------------------------------------------------------------------

export type ScreenReason = 'email' | 'number' | 'link' | 'handle' | 'short' | 'repeat' | 'echo'
export type ScreenResult = { ok: true } | { ok: false; reason: ScreenReason }

/** An address written with an at sign, or with the at sign written out in brackets, in any script. */
const EMAIL = /[\p{L}\p{N}._%+-]+\s?(?:@|\(at\)|\[at\]|\{at\})\s?[\p{L}\p{N}.-]+\.\p{L}{2,}/iu
/** An address with both the at sign and the dot written out: "name at host dot org", "name(at)host(dot)org". */
const EMAIL_WORDS = /[\p{L}\p{N}._%+-]+\s*(?:\(at\)|\[at\]|\{at\}|\sat\s)\s*[\p{L}\p{N}-]+\s*(?:\(dot\)|\[dot\]|\{dot\}|\sdot\s)\s*\p{L}{2,}/iu

/**
 * A run of digit groups with only spaces, brackets, dots, slashes or hyphens
 * (at most four in a row) between them: how one number is written out. A
 * comma, a colon, an operator or a letter ends the run, so a list of years,
 * prices or scores, a sum and a time are separate numbers.
 */
const DIGIT_RUN = /\d(?:[\s().\/-]{0,4}\d)+/g
/** A date written as one: 2026-12-21, 21/12/2026, 21.12.26. Taken out before the digit runs are read. */
const DATE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/.]\d{1,2}[\/.](?:\d{4}|\d{2}))\b/g

/**
 * Nine or more digits written as one number: "(555) 123-4567",
 * "555 - 123 - 4567", "555/123/4567", "+44 (0) 20 7946 0958", card and id
 * numbers. Not counted: a number with a decimal point (3.14159265), a
 * version (131.0.6778.86: dots only, with a one digit part, and not shaped
 * like an IPv4 address), digits counted out one at a time ("1 2 3 4 5 6 7 8 9
 * 10"), and a date. A price or a year does not reach nine digits.
 */
export function hasLongNumber(text: string): boolean {
  for (const m of text.replace(DATE, ' date ').matchAll(DIGIT_RUN)) {
    const run = m[0]
    const groups = run.split(/\D+/)
    if (groups.join('').length < 9) continue
    if (/^\d+\.\d+$/.test(run)) continue
    if (/^[\d.]+$/.test(run) && groups.some(g => g.length === 1) && !(groups.length === 4 && groups.every(g => Number(g) <= 255))) continue
    if (groups.length >= 4 && groups.filter(g => g.length === 1).length >= groups.length - 1) continue
    return true
  }
  return false
}

const LINK = /\b(?:https?:\/\/|www\.)\S+/i
/** An IPv4 address with a port: where something is served. */
const HOST_PORT = /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/
/**
 * A bare domain: a name, a dot and an ending from this list, written in lower
 * case, with nothing that makes it part of code after it (no "(", no further
 * ".name") and no dot or letter before it. Endings that are also everyday or
 * code words (info, top, in, at, it, to, be, me, cc, pl and the like) are not
 * on the list: "logging.info(", "rect.top" and "Yes.It" are not links. Such a
 * domain is still found with a path after it (DOMAIN_PATH).
 */
const DOMAIN = /(?<![\p{L}\p{N}_.-])[A-Za-z0-9-]{2,}(?:\.[A-Za-z0-9-]{2,})*\.(?:com|org|net|edu|gov|io|ai|co|dev|app|ly|gg|xyz|tv|fm|eu|uk|de|fr|nl|ch|es|pt|se|dk|fi|cz|ie|ru|ua|cn|jp|kr|au|nz|ca|us|mx|br|ar|za)(?![\p{L}\p{N}_(]|\.\p{L})/u
/** Any name.ending with a path after it: t.me/name, x.com/name, linktr.ee/name. */
const DOMAIN_PATH = /(?<![\p{L}\p{N}_.\/-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}\/[\p{L}\p{N}_@~-]/u
/** A domain with its dot written out: "example dot com", "example[.]com". */
const DOMAIN_WORDS = /\b[a-z0-9-]{2,}\s*(?:\[dot\]|\(dot\)|\{dot\}|\[\.\]|\(\.\)|\sdot\s)\s*(?:com|org|net|io|co|me|info)\b/i
/** An @ name in any script, after anything that is not a letter, a digit or an underscore (so "twitter:@name" too, and not an email); or a u/name. */
const HANDLE = /(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}_]{3,})|(?:^|[^\p{L}\p{N}_\/])u\/[A-Za-z0-9_-]{3,}/gu
/** Words that follow an @ in code (CSS rules, Python decorators, Java and other annotations, doc tags): not user names. */
const CODE_AT = new Set([
  'media', 'import', 'font', 'keyframes', 'supports', 'charset', 'layer', 'container', 'page', 'namespace',
  'staticmethod', 'classmethod', 'property', 'dataclass', 'abstractmethod', 'pytest', 'functools', 'app', 'click',
  'override', 'deprecated', 'test', 'suppresswarnings', 'functionalinterface', 'nullable', 'nonnull', 'autowired', 'bean', 'entity', 'component', 'injectable', 'input', 'output',
  'param', 'params', 'return', 'returns', 'throws', 'type', 'types', 'see', 'example', 'interface', 'implementation', 'end',
])
function hasHandle(text: string): boolean {
  for (const m of text.matchAll(HANDLE)) if (m[1] === undefined || !CODE_AT.has(m[1].toLowerCase())) return true
  return false
}
/**
 * Characters that print nothing: format characters (zero width spaces and
 * joiners, soft hyphens), marks that only attach to another character
 * (variation selectors, the combining grapheme joiner, keycap marks) and the
 * blank Hangul fillers. Removed before screening.
 */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}ᅟᅠㅤﾠ]/gu
/** Full stops of other scripts, read as a dot. */
const OTHER_DOTS = /[。．｡]/g
/** A decimal digit of any script as 0 to 9: each script's ten digits are in a row, so the place in that row is the value. */
function asciiDigit(d: string): string {
  const cp = d.codePointAt(0) as number
  let start = cp
  while (cp - start < 60 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--
  return String((cp - start) % 10)
}
/** The text as the screening reads it: NFKC, nothing invisible, one kind of dot and one kind of digit. */
export function screenText(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(OTHER_DOTS, '.').replace(/[^\x00-\x7f]/gu, c => (/\p{Nd}/u.test(c) ? asciiDigit(c) : c))
}
/** One character, other than white space, 40 or more times in a row. */
const RUN = /(\S)\1{39,}/u
export const SCREEN_SHORT_CHARS = 12
export const SCREEN_SHORT_WORDS = 3
export const SCREEN_REPEAT_WORD_SHARE = 0.6
export const SCREEN_REPEAT_MIN_WORDS = 10
export const SCREEN_ECHO_JACCARD = 0.8

/** The words of a text, as the screening counts them. */
export function offerWords(text: string): string[] {
  return normaliseText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / (a.size + b.size - both)
}

/**
 * Screens a conversation before it is stored. A match refuses the whole
 * offer: nothing is masked and nothing is kept. It does not understand
 * meaning: it cannot see a name, an address written in words, or abuse.
 */
export function screenOffer(messages: readonly OfferMessage[]): ScreenResult {
  // NFKC first, then everything invisible out: a zero width space or a variation selector must not split an address or a number.
  const all = messages.map(m => ({ role: m.role, text: screenText(m.content) }))
  for (const [reason, test] of [
    ['email', (t: string) => EMAIL.test(t) || EMAIL_WORDS.test(t)],
    ['number', hasLongNumber],
    ['link', (t: string) => LINK.test(t) || HOST_PORT.test(t) || DOMAIN.test(t) || DOMAIN_PATH.test(t) || DOMAIN_WORDS.test(t)],
    ['handle', hasHandle],
  ] as const) {
    if (all.some(m => test(m.text))) return { ok: false, reason }
  }
  const visitor = all.filter(m => m.role === 'user')
  const visitorWords = visitor.flatMap(m => offerWords(m.text))
  const visitorChars = visitor.reduce((n, m) => n + m.text.trim().length, 0)
  if (visitorChars < SCREEN_SHORT_CHARS || new Set(visitorWords).size < SCREEN_SHORT_WORDS) return { ok: false, reason: 'short' }
  if (all.some(m => RUN.test(m.text))) return { ok: false, reason: 'repeat' }
  if (visitorWords.length >= SCREEN_REPEAT_MIN_WORDS) {
    const counts = new Map<string, number>()
    for (const w of visitorWords) counts.set(w, (counts.get(w) ?? 0) + 1)
    if (Math.max(...counts.values()) / visitorWords.length > SCREEN_REPEAT_WORD_SHARE) return { ok: false, reason: 'repeat' }
  }
  const visitorSets = visitor.map(m => new Set(offerWords(m.text)))
  const replies = all.filter(m => m.role === 'assistant')
  const echoes = replies.filter(r => {
    const words = new Set(offerWords(r.text))
    return visitorSets.some(v => jaccard(words, v) >= SCREEN_ECHO_JACCARD)
  }).length
  if (replies.length && echoes > 0 && echoes * 3 >= replies.length) return { ok: false, reason: 'echo' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// What the visitor is told (plain, no dashes)
// ---------------------------------------------------------------------------

export const OFFER_MESSAGES = {
  stored: 'Thank you. The lab stored this conversation.',
  email: 'This conversation has an email address in it. The lab does not store those. Nothing was kept.',
  number: 'This conversation has a phone number or another long number in it. Nothing was kept.',
  link: 'This conversation has a link in it. Nothing was kept.',
  handle: 'This conversation has a user name in it. Nothing was kept.',
  short: 'This conversation is too short to offer.',
  repeat: 'This conversation is mostly repeated text. Nothing was kept.',
  echo: 'In this conversation the model mostly repeated what was written to it. Nothing was kept.',
  adapter_day: 'This model has been offered as many conversations as it can take today. Thank you.',
  day: 'You have offered as many conversations as one visitor may today. Thank you.',
  full: 'The lab is not taking more conversations just now.',
  withdrawn: 'Done. The lab deleted the stored text.',
  withdrawnTrained: 'Done. The lab deleted the stored text. A model was already trained on it and cannot unlearn it.',
  not_verified: 'This conversation cannot be offered. Start a new one and offer that.',
  already_offered: 'This conversation was already offered.',
  gone: 'That model is no longer kept, so the lab cannot take this conversation.',
  unknown_code: 'The lab has no offer with that code.',
  tries: 'That is a lot of tries today. It starts again at 00:00 UTC.',
  off: 'Offering conversations to the lab is switched off.',
  unavailable: 'The lab cannot take this just now. Please try again later.',
} as const

/**
 * The claims of the consent sheet (spec 2.2), each with the stored column it
 * relies on. "no address" relies on the absence of any column that could
 * hold one, so it names none. The sheet's own sentences are in the page's
 * code (src/systems/chatOffer.ts, CONSENT_PARAGRAPHS); this is the server's
 * map from those words to columns. A test checks that every column of the
 * visitor_offers table is accounted for here or in OFFER_BOOKKEEPING_COLUMNS,
 * that every claim names real columns, and that every claim here is, word for
 * word, part of a sentence of the sheet.
 */
export const OFFER_CLAIMS: ReadonlyArray<{ claim: string; columns: readonly string[] }> = [
  { claim: 'the lab stores this conversation: your messages, the model\'s replies', columns: ['messages'] },
  { claim: 'which model you talked to', columns: ['adapter_slug', 'base_model', 'adapter_from_visitors'] },
  { claim: 'and the day', columns: ['day'] },
  { claim: 'It does not store your address or an account.', columns: [] },
  { claim: 'The lab keeps it for {keep_days} days, then deletes it.', columns: ['expires_at', 'status'] },
  { claim: 'You can take it back with a code you get after offering.', columns: ['code_sha256', 'status'] },
  { claim: 'If a model has already trained on it', columns: ['used_in'] },
  { claim: 'The lab\'s owner can read it.', columns: ['read_at'] },
  { claim: 'The lab checks automatically for email addresses, phone numbers, long numbers, links and user names', columns: ['screen_v'] },
]
/**
 * Columns no sentence of the sheet is about: the row's id, and the two hashes
 * of the text that refuse a second offer of the same conversation (they are
 * overwritten when the text is taken back, deleted or expires).
 */
export const OFFER_BOOKKEEPING_COLUMNS: readonly string[] = ['id', 'transcript_sha256', 'first_user_sha256']

// ---------------------------------------------------------------------------
// Reading an offer, or a take back
// ---------------------------------------------------------------------------

export type OfferRequest =
  | { ok: true; kind: 'offer'; adapter: string; messages: OfferMessage[]; turns: number; chars: number; receipt: string }
  | { ok: true; kind: 'withdraw'; code: string }

const OFFER_ORDER = 'Messages must alternate "user" and "assistant", starting with "user" and ending with "assistant".'

/**
 * Reads the offer route's body. Strict: exactly "adapter", "messages" and
 * "receipt" for an offer, exactly "withdraw" for a take back. The messages
 * are read and cleaned by the chat's own reader (readChatMessages), so an
 * offer holds exactly the text the chat would have accepted, and its receipt
 * is checked against that.
 */
export function readOfferRequest(raw: unknown): OfferRequest | ChatRefusal {
  const bad = (message: string, error = 'invalid_request'): ChatRefusal => ({ ok: false, status: 400, error, message })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Send a JSON object with "adapter", "messages" and "receipt".')
  const req = raw as Record<string, unknown>
  const keys = Object.keys(req)
  if (keys.includes('withdraw')) {
    if (keys.length !== 1) return bad('A take back has "withdraw" and nothing else.')
    const code = readOfferCode(req.withdraw)
    if (!code) return bad('That is not a code the lab gives. A code looks like XXXX-XXXX-XXXX.')
    return { ok: true, kind: 'withdraw', code }
  }
  if (keys.length !== 3 || !['adapter', 'messages', 'receipt'].every(k => keys.includes(k))) {
    return bad('An offer has exactly "adapter", "messages" and "receipt".')
  }
  if (!isAdapterSlug(req.adapter)) return bad('"adapter" must be the name of a trained model from the list.')
  if (typeof req.receipt !== 'string' || !req.receipt || req.receipt.length > RECEIPT_MAX_CHARS) return bad('"receipt" must be the receipt the chat gave.')
  const list = req.messages
  if (!Array.isArray(list) || list.length < OFFER_MIN_MESSAGES || list.length > OFFER_MAX_MESSAGES || list.length % 2 !== 0) {
    return bad(`"messages" must hold ${OFFER_MIN_MESSAGES} to ${OFFER_MAX_MESSAGES} messages, ending with a reply.`)
  }
  const read = readChatMessages(list, OFFER_ORDER)
  if (!read.ok) return read
  const messages = read.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  // Half a character (a lone surrogate) or a NUL cannot be stored as JSON: refused here, before anything is counted.
  if (messages.some(m => BROKEN_TEXT.test(m.content))) return bad('This conversation has broken text in it and cannot be offered.')
  return { ok: true, kind: 'offer', adapter: req.adapter, messages, turns: messages.length / 2, chars: read.chars, receipt: req.receipt }
}

/** A surrogate with no partner (half a character), or a NUL. */
// eslint-disable-next-line no-control-regex
const BROKEN_TEXT = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|\u0000/

// ---------------------------------------------------------------------------
// A training request that names offers (spec 2.7)
// ---------------------------------------------------------------------------

export interface TinkerOffersSource {
  /** The adapter slug (without "lab/") whose conversations are asked for, or null for all. */
  adapter: string | null
  limit: number
  system?: string
}
export interface TinkerOffersRequest {
  purpose: string
  base_model: string
  settings: TinkerSettings
  visitor_offers: TinkerOffersSource
  name?: string
  name_refused?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(o).find(k => !allowed.includes(k))
  return extra === undefined ? null : extra.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_'
}
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Does a "tinker_train" request name visitor offers? Only then is it read by this file. */
export function namesVisitorOffers(raw: unknown): boolean {
  return isPlainObject(raw) && raw.visitor_offers !== undefined && raw.visitor_offers !== null
}

/**
 * The conversation messages one example may hold: the runner's message
 * limit, less one for the system message when there is one, and even, so the
 * example ends on a reply. 12 without a system text, 10 with one.
 */
export function offerExampleMessages(system: boolean): number {
  const room = TINKER_MAX_MESSAGES - (system ? 1 : 0)
  return room - (room % 2)
}

/**
 * Reads a "tinker_train" request that names visitor offers. As strict as the
 * inline and the dataset forms: any field the lab does not know and any value
 * out of range is a refusal with a reason. Exactly one of "examples",
 * "dataset" and "visitor_offers" may be given.
 */
export function normalizeOffersRequest(raw: unknown, allowed: string[] = tinkerBaseModels().models): { request: TinkerOffersRequest } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'not an object with "visitor_offers"' }
  const given = ['examples', 'dataset', 'visitor_offers'].filter(k => raw[k] !== undefined && raw[k] !== null)
  if (given.length !== 1) return { error: 'give exactly one of "examples", "dataset" and "visitor_offers"' }
  const names = tinkerNamesFlag()
  const extra = onlyKeys(raw, names ? ['purpose', 'base_model', 'visitor_offers', 'settings', 'name'] : ['purpose', 'base_model', 'visitor_offers', 'settings'])
  if (extra) return { error: `unknown field: ${extra}` }
  if (!allowed.length) return { error: 'no base model is allowed' }
  const base = raw.base_model === undefined || raw.base_model === null || raw.base_model === '' ? allowed[0] : raw.base_model
  if (typeof base !== 'string' || !allowed.includes(base)) return { error: `base_model must be one of: ${allowed.join(', ')}` }
  const checked = readSettings(raw.settings)
  if ('error' in checked) return checked

  const o = raw.visitor_offers
  if (!isPlainObject(o)) return { error: 'visitor_offers is not an object' }
  const unknown = onlyKeys(o, ['adapter', 'limit', 'system'])
  if (unknown) return { error: `visitor_offers has an unknown field: ${unknown}` }
  let adapter: string | null = null
  if (o.adapter !== undefined && o.adapter !== null) {
    const slug = typeof o.adapter === 'string' ? o.adapter.replace(/^lab\//, '') : ''
    if (!isAdapterSlug(slug)) return { error: 'visitor_offers.adapter must be an adapter id like lab/e41-0a1b2c3d' }
    adapter = slug
  }
  const limit = o.limit === undefined || o.limit === null ? OFFERS_RUN_LIMIT.fallback : o.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < OFFERS_RUN_LIMIT.min || limit > OFFERS_RUN_LIMIT.max) {
    return { error: `visitor_offers.limit must be a whole number from ${OFFERS_RUN_LIMIT.min} to ${OFFERS_RUN_LIMIT.max}` }
  }
  let system: string | undefined
  if (o.system !== undefined && o.system !== null) {
    if (typeof o.system !== 'string' || !o.system.trim()) return { error: 'visitor_offers.system must be non-empty text when it is given' }
    if (FORBIDDEN_CHARS.test(o.system) || LONE_SURROGATE.test(o.system)) return { error: 'visitor_offers.system holds a control character or broken text' }
    if (Buffer.byteLength(o.system, 'utf8') > OFFERS_MAX_SYSTEM_BYTES) return { error: `visitor_offers.system holds more than ${OFFERS_MAX_SYSTEM_BYTES} bytes` }
    system = o.system
  }
  // Fewer conversations can only take fewer steps.
  const steps = plannedSteps(limit, checked.settings)
  if (steps > TINKER_MAX_STEPS) {
    return { error: `with ${limit} conversations these settings need ${steps} optimizer steps and a run may take ${TINKER_MAX_STEPS}: lower limit or epochs, or raise batch_size` }
  }
  const purpose = typeof raw.purpose === 'string' ? raw.purpose.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  const named = names && raw.name !== undefined && raw.name !== null && raw.name !== '' ? readAdapterName(raw.name) : null
  return {
    request: {
      purpose, base_model: base, settings: checked.settings,
      visitor_offers: { adapter, limit, ...(system !== undefined ? { system } : {}) },
      ...(named && 'name' in named ? { name: named.name } : {}),
      ...(named && 'error' in named ? { name_refused: named.error } : {}),
    },
  }
}

/**
 * The most a run on offers could cost, before one conversation is read: the
 * estimate for a set at least as heavy, in every part of the estimate, as any
 * set the caps allow. As many conversations as could fit, each with the most
 * messages an example may hold, all the text a run may hold, packed into as
 * few conversations as the per-example cap allows. Modelled on
 * datasetRunCeiling (datasets.ts), with more messages to an example.
 */
export function offersRunCeiling(request: Pick<TinkerOffersRequest, 'base_model' | 'settings' | 'visitor_offers'>): TinkerEstimate {
  const system = request.visitor_offers.system
  const turns = offerExampleMessages(Boolean(system))
  // A conversation holds at least one character in each of two messages.
  const least = (system ? Buffer.byteLength(system, 'utf8') : 0) + 2
  const rows = Math.max(1, Math.min(request.visitor_offers.limit, Math.floor(TINKER_MAX_DATASET_BYTES / least)))
  let left = TINKER_MAX_DATASET_BYTES
  const examples: TinkerExample[] = []
  for (let i = 0; i < rows; i++) {
    const take = Math.min(TINKER_MAX_EXAMPLE_BYTES, left)
    left -= take
    const messages: TinkerMessage[] = system ? [{ role: 'system', content: '' }] : []
    for (let k = 0; k < turns; k++) messages.push({ role: k % 2 === 0 ? 'user' : 'assistant', content: k === 0 ? 'a'.repeat(take) : '' })
    examples.push({ messages })
  }
  return estimateTinkerRun({ base_model: request.base_model, settings: request.settings, examples })
}

/** What an offers request asks for, in one line, for records made before anything is read. */
export function offersRequestSummary(request: TinkerOffersRequest): string {
  const a = request.visitor_offers.adapter
  return `LoRA fine-tune of ${request.base_model} on up to ${request.visitor_offers.limit} conversations visitors offered${a ? ` in chats with lab/${a}` : ''}${request.purpose ? `: ${request.purpose}` : ''}`
}

// ---------------------------------------------------------------------------
// Choosing offers, and the examples made from them
// ---------------------------------------------------------------------------

/** The order offers are read in for a run: by sha256(salt + id), with a salt made up for the run. */
export function offerOrderKey(salt: string, id: string): string {
  return sha256hex(`${salt}${id}`)
}

/**
 * Picks, in the given order, the most items (at most `limit`) such that no
 * UTC day gives more than a quarter of the items picked. Returns their
 * indexes in order. Fewer than four days can give nothing.
 */
export function pickByDay(items: readonly { day: string }[], limit: number): number[] {
  const perDay = new Map<string, number>()
  for (const it of items) perDay.set(it.day, (perDay.get(it.day) ?? 0) + 1)
  for (let n = Math.min(limit, items.length); n > 0; n--) {
    const cap = Math.floor(n * OFFERS_DAY_SHARE)
    let room = 0
    for (const c of perDay.values()) room += Math.min(c, cap)
    if (room < n) continue
    const taken = new Map<string, number>()
    const out: number[] = []
    for (const [i, it] of items.entries()) {
      if (out.length >= n) break
      const t = taken.get(it.day) ?? 0
      if (t >= cap) continue
      taken.set(it.day, t + 1)
      out.push(i)
    }
    return out
  }
  return []
}

/** A stored offer as a run reads it. */
export interface ClaimedOffer { id: string; day: string; messages: unknown }

/**
 * Turns claimed offers (in read order) into the request an inline dataset
 * makes, and the record that goes on the run row. Each conversation is one
 * example: the optional system text, then its messages, cut to the most an
 * example may hold (counted as shortened). One over the per-example size, or
 * the same as an earlier one, is left out and counted. Reading stops at the
 * limit or the total size, and the quarter a day rule is applied to what is
 * left. The examples then go through normalizeTinkerRequest, the checks every
 * dataset gets. `used` are the ids the examples came from; every other
 * claimed id is to be released.
 */
export function offersToTinkerRequest(asked: TinkerOffersRequest, offers: readonly ClaimedOffer[], allowed: string[] = tinkerBaseModels().models):
  { request: TinkerRequest; record: VisitorOffersRecord; used: string[] } | { error: string } {
  const system = asked.visitor_offers.system
  const most = offerExampleMessages(Boolean(system))
  const seen = new Set<string>()
  const kept: Array<{ id: string; day: string; example: TinkerExample; bytes: number; shortened: boolean }> = []
  let tooLong = 0
  let duplicate = 0
  for (const offer of offers) {
    const list = Array.isArray(offer.messages) ? offer.messages : null
    // A stored offer that does not read as a conversation is skipped (it cannot be: the route stores only what it read).
    if (!list || list.length < 2 || list.some((m, i) => !isPlainObject(m) || m.role !== (i % 2 === 0 ? 'user' : 'assistant') || typeof m.content !== 'string' || !m.content.trim())) continue
    const conversation = (list as Array<{ role: 'user' | 'assistant'; content: string }>).slice(0, Math.min(list.length - (list.length % 2), most))
    const messages: TinkerMessage[] = [...(system ? [{ role: 'system' as const, content: system }] : []), ...conversation.map(m => ({ role: m.role, content: m.content }))]
    const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0)
    if (bytes > TINKER_MAX_EXAMPLE_BYTES) { tooLong++; continue }
    const key = sha256hex(JSON.stringify(messages))
    if (seen.has(key)) { duplicate++; continue }
    seen.add(key)
    kept.push({ id: offer.id, day: offer.day, example: { messages }, bytes, shortened: conversation.length < list.length })
  }
  // The limit and the total size, in read order.
  const within: typeof kept = []
  let total = 0
  for (const k of kept) {
    if (within.length >= asked.visitor_offers.limit || total + k.bytes > TINKER_MAX_DATASET_BYTES) break
    within.push(k)
    total += k.bytes
  }
  const picked = pickByDay(within, asked.visitor_offers.limit).map(i => within[i])
  if (picked.length < TINKER_MIN_EXAMPLES) {
    return { error: `only ${picked.length} visitor conversation${picked.length === 1 ? '' : 's'} could be used and a run needs ${TINKER_MIN_EXAMPLES} (at most a quarter may come from one day; ${tooLong} too long, ${duplicate} duplicate)` }
  }
  const checked = normalizeTinkerRequest({
    purpose: asked.purpose, base_model: asked.base_model, examples: picked.map(p => p.example), settings: asked.settings,
    ...(tinkerNamesFlag() && asked.name ? { name: asked.name } : {}),
  }, allowed)
  if ('error' in checked) return { error: `the visitor conversations the lab read did not pass the checks every dataset gets: ${checked.error}` }
  return {
    request: checked.request,
    record: {
      kind: 'visitor_offers', adapter: asked.visitor_offers.adapter ? `lab/${asked.visitor_offers.adapter}` : null, limit: asked.visitor_offers.limit,
      conversations_used: picked.length, shortened: picked.filter(p => p.shortened).length, left_out: { too_long: tooLong, duplicate },
      days: new Set(picked.map(p => p.day)).size, system: Boolean(system), order: 'chosen by a hash the lab made up for this run',
      sha256: checked.request.dataset_sha256,
    },
    used: picked.map(p => p.id),
  }
}

// ---------------------------------------------------------------------------
// What the models are told
// ---------------------------------------------------------------------------

/**
 * One paragraph, appended to the tools list only while offers are on for the
 * models and Tinker training is on (the caller checks). An ability and its
 * limits. `total` is how many offers the lab holds now.
 */
export function visitorOffersNote(opts: { total: number; datasets?: boolean }): string {
  const total = Math.max(0, Math.floor(opts.total))
  // "dataset" is a field of a training request only while the datasets tool is on: named here only then.
  const sources = opts.datasets ? 'Give one of "examples", "dataset" and "visitor_offers".' : 'Give one of "examples" and "visitor_offers".'
  return `Visitor conversations: a visitor of the room may offer a chat they had with a trained adapter to the lab. The lab holds ${total} of them now. A Tinker training request may name them instead of writing its examples: "visitor_offers": { "adapter" (optional, an adapter id), "limit" ${OFFERS_RUN_LIMIT.min} to ${OFFERS_RUN_LIMIT.max}, "system" (optional text, at most ${OFFERS_MAX_SYSTEM_BYTES} bytes) }. ${sources} The lab's own code reads them, not yours, and you never see their text. No model reads them and nobody reviewed them: automatic pattern checks refused conversations with an email address, a phone number, a long number, a user name or a link written in a usual form; the checks can miss some and cannot find names or street addresses. The lab's owner can read them through an operator route, and each read is counted in the public record. Each conversation is one example, its first ${offerExampleMessages(false) / 2} turns at most (${offerExampleMessages(true) / 2} with a system text), and only its last reply is trained on. The lab picks which ones, at most a quarter from any one day. Conversations had with an adapter that was itself trained on visitor conversations are never used. The run then goes on like any other: the same limits, cost estimate, caps and held out slice. Its record says how many conversations were used and nothing of what they said. Everything trained from them is labelled "${ORIGIN_VISITORS}", and such an adapter is not offered in the visitor chat unless the owner allows it.`
}

/**
 * What the Reviewer is told about a training request on offers. `stored` is
 * how many usable offers the lab holds now (for the named adapter when one is
 * named); `runCapUsd` is LAB_TINKER_RUN_USD.
 */
export function visitorOffersReviewFacts(request: TinkerOffersRequest, opts: { stored: number; runCapUsd: number }): { line: string } {
  const o = request.visitor_offers
  const ceiling = offersRunCeiling(request).max_cost_usd
  const s = request.settings
  const systemText = o.system ? ` A system text the Executor wrote (${Buffer.byteLength(o.system, 'utf8')} bytes) is put before every conversation.` : ''
  return {
    line: `a LoRA fine-tune of ${request.base_model} on up to ${o.limit} conversations that visitors of the room offered to the lab${o.adapter ? ` in chats with lab/${o.adapter}` : ''}. The text is not in the Executor's answer: neither you nor the Executor has read it, and nobody reviewed it: automatic pattern checks refused conversations with an email address, a phone number, a long number, a user name or a link written in a usual form; the checks can miss some and cannot find names or street addresses. The lab holds ${Math.max(0, Math.floor(opts.stored))} such conversations now. If you approve, the lab's own code reads them, makes one example of each (at most a quarter from any one day), and checks the result exactly as it checks inline examples.${systemText} Settings: rank ${s.rank}, learning rate ${s.learning_rate}, ${s.epochs} epochs, batch size ${s.batch_size}. The lab's estimate, from published prices, of the most these limits would let it cost is ${usdText(ceiling)} (a run may cost at most ${usdText(opts.runCapUsd)}). Everything trained from them is labelled "${ORIGIN_VISITORS}".`,
  }
}
