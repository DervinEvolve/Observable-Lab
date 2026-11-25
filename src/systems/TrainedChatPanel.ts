// "Talk to what they trained": a chat with the adapters the lab's models
// fine-tuned on Tinker (docs/TOOLS.md, "Talking to a trained adapter").
//
// It looks like the rest of the room: warm paper, ink and brass. Each trained
// model is a specimen card on a shelf, with a before and after gauge made from
// the held-out score the lab measured. The conversation reads like letters on
// the Commentator's desk. On a wide screen the shelf and the conversation sit
// side by side and scroll on their own; on a phone they are two views of one
// full-height sheet.
//
// It asks for nothing until the room's own state (GET /api/experiment, which
// the page reads anyway) says the chat is switched on: main.ts passes that on
// through setAvailable. With the chat off, which is the default, the panel
// makes no request at all and shows nothing, not even its button. Once it is
// on, the panel reads GET /api/experiment/trained-chat for the adapters, and
// again every two minutes while the chat stays on. Every number shown
// comes from the lab's record of the run: the base model, the epoch, the
// model that wrote the data, and the held-out score the lab measured before
// and after training. A message goes to POST /api/experiment/trained-chat,
// which holds the limits (message length, turns, a rate limit per visitor
// and a small daily budget) and answers with a plain sentence when one is
// reached.
//
// When the server offers it (compare_enabled), a switch asks the untrained
// base model the same question and shows both answers side by side. Both
// answers must come back for a question to count as a turn.
//
// An adapter may carry a display name its author gave it, and may be marked
// to keep. Both are labels from the lab's record. The server lists kept
// adapters first. An adapter trained on rows of a public dataset says so in
// its details: the dataset's name, and that nobody at the lab has read those
// rows.
//
// The panel can also hold the story box of the research loop's best kept
// model (ResearchStoryBox.ts), which has its own switch and its own route.
// main.ts attaches it. It is a card on the shelf; choosing it puts the box in
// the conversation pane. The panel's button is on the page while either is on;
// with only the story box on, the chat's own parts are hidden.
//
// The panel reports each real reply through onReply, so the room's speaking
// tube can glow. Nothing here animates to suggest a model is working.
//
// When the server's GET answer carries an offers block (visitor offers on),
// the conversation view gets one more button: "Offer This Conversation to the
// Lab". It is enabled only while the panel holds the receipt of the last reply
// (see chatOffer.ts and spec 2.2): a conversation the lab's own endpoint gave,
// in order. Pressing it opens a sheet with the consent text and the exact
// conversation; only "Offer It" sends anything. The take back code lives in
// this panel's memory and nowhere else. Without an offers block none of this
// exists on the page.
//
// An adapter made by a Socratic lesson (kind 'tutor') is a card with its skill
// map: pass bands before and after, counted by the lab on questions held back
// from teaching, with the note that the rules were written by models.
//
// All text from the server and from the model is put on the page as text,
// never as markup.

import {
  PAPER_TOKENS, installPaperTheme, paperCard, paperCardSelected, paperFocusRing, paperHeader, paperHeading, paperInput,
  paperPrimaryButton, paperQuietButton, paperShell, paperTag,
} from './paperTheme'
import {
  OFFERED_BUTTON, OFFER_BUTTON, OFFER_CANCEL, OFFER_COPIED, OFFER_COPY, OFFER_COPY_FAILED, OFFER_DISABLED_NOTE, OFFER_DONE, OFFER_HEADING, offerDisabledNote,
  OFFER_PREVIEW_LABEL, OFFER_SENDING, OFFER_SUBMIT, OFFER_TAKE_BACK, OFFER_TAKING_BACK, OFFER_THANKS, OFFER_UNREACHED, TAKE_BACK_BAD_CODE,
  TAKE_BACK_HEADING, TAKE_BACK_HELP, TAKE_BACK_LABEL, TAKE_BACK_OPEN, buildOfferBody, buildWithdrawBody, canOffer, consentParagraphs,
  normalizeCode, readOfferAnswer, readOffers, readReceipt, readWithdrawAnswer,
} from './chatOffer'
import type { OffersInfo } from './chatOffer'

const API = '/api/experiment/trained-chat'
const OFFER_API = '/api/experiment/chat-offer'
const REFRESH_MS = 120_000

export interface TrainedAdapterView {
  slug: string
  modelId: string
  baseModel: string
  epoch: number
  authorName: string
  purpose: string | null
  examples: number
  holdoutExamples: number | null
  lossBefore: number | null
  lossAfter: number | null
  /** Present for an adapter made by Tinker RL ('rl': its "examples" are tasks and its scores are rubric scores, higher is better) or by a Socratic lesson ('tutor': a skill map, no loss gauge). */
  kind?: 'rl' | 'tutor'
  /** Only for kind 'tutor', when the server's record can be read. */
  skillMap?: SkillMapView
  /** Trained on conversations visitors offered to the lab. */
  fromVisitors?: true
  scoreBefore?: number | null
  scoreAfter?: number | null
  expiresAt: string | null
  /** When the lab stored it, if the server says. */
  createdAt?: string
  /** The display name its author gave it, when it has one. A label only. */
  name: string | null
  /** Marked to keep, and by whom ("the owner" or a model's name). */
  kept: boolean
  keptBy: string | null
  /** "org/name" of the public dataset its examples were read from, when they were not written by a model. */
  dataFrom: string | null
  /**
   * The lab's label for where its training examples came from: "written by
   * the models" or "public dataset org/name@commit". Only when the server
   * sends one (LAB_TINKER_ORIGIN_LABELS).
   */
  dataOrigin?: string
}

/** One cell of a skill map: answers that passed of answers asked, and the pass band from 0 to 5. All counted by the lab. */
export interface SkillCell { passed: number; total: number; band: number }
export interface SkillRowView { name: string; before: SkillCell | null; after: SkillCell | null }
export interface SkillMapView { topic: string; teacherName: string; rows: SkillRowView[]; seenOnly: boolean; withinNoise?: boolean; cutShort?: boolean; cutOffFell?: boolean }

/** One sentence list, the same on every surface that shows a lesson (api/_lib/tinker-tutor.ts holds the same words; a test compares them). */
export const TUTOR_MEASURE_NOTE = 'The lab counts which answers pass. The rules, the questions and the teaching text were written by models, and a model approved the rules. Nobody has checked that the rules measure the skill.'
export const TUTOR_BANDS_NOTE = 'Pass bands come from questions held back from teaching.'

export interface ChatLimits { maxMessageChars: number; maxTurns: number }

/** What the panel needs of a second section it can hold (the story box). */
export interface PanelSection {
  readonly element: HTMLElement
  /** Is the section on the page? */
  isShown(): boolean
  setAvailable(on: boolean): void
  /** Called when the panel is opened. */
  refresh(): void
}

const SLUG = /^e[0-9]{1,6}-[0-9a-f]{8}$/
/** "org/name@commit", as the server names the public dataset an adapter was trained on. */
const DATA_FROM = /^([A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96})@[0-9a-f]{40}$/
/** The two origin labels the server sends. Anything else is not shown. */
const DATA_ORIGIN = /^(?:written by the models|written by visitors(?: in chats with lab\/e[0-9]{1,6}-[0-9a-f]{8})?|public dataset (?:[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}@[0-9a-f]{40}|\(its stored source cannot be read\)))$/

/** A dataset origin with its commit shortened to twelve characters, for a narrow panel. */
function shortOrigin(origin: string): string {
  return origin.replace(/@([0-9a-f]{12})[0-9a-f]{28}$/, '@$1')
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A cell of a skill map: whole counts, at least one answer, no more passed than asked, a band from 0 to 5. Anything else is not a cell. */
export function readSkillCell(raw: unknown): SkillCell | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const { passed, total, band } = o
  if (typeof passed !== 'number' || typeof total !== 'number' || typeof band !== 'number') return null
  if (!Number.isInteger(passed) || !Number.isInteger(total) || !Number.isInteger(band)) return null
  if (total < 1 || total > 100_000 || passed < 0 || passed > total || band < 0 || band > 5) return null
  return { passed, total, band }
}

/** The skill map of a lesson adapter, strictly read: at most 10 rows. Null when the topic or the rows cannot be read. */
export function readSkillMap(raw: unknown): SkillMapView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const topic = text(o.topic, 120)
  const teacherName = text(o.teacher_name, 60)
  if (!topic || !teacherName || !Array.isArray(o.rows)) return null
  const rows: SkillRowView[] = []
  for (const item of o.rows.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const name = text(r.name, 60)
    if (!name) continue
    rows.push({ name, before: readSkillCell(r.before), after: readSkillCell(r.after) })
  }
  if (rows.length === 0) return null
  return { topic, teacherName, rows, seenOnly: o.seen_only === true, withinNoise: o.within_noise === true, cutShort: o.cut_short === true, cutOffFell: o.cut_off_fell === true }
}

/** The adapters in a GET answer, strictly read: anything that is not a well formed adapter is left out. */
export function parseAdapters(raw: unknown): TrainedAdapterView[] {
  const list = raw && typeof raw === 'object' ? (raw as { adapters?: unknown }).adapters : null
  if (!Array.isArray(list)) return []
  const out: TrainedAdapterView[] = []
  for (const item of list.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.slug !== 'string' || !SLUG.test(o.slug)) continue
    const base = text(o.base_model, 80)
    const epoch = num(o.epoch)
    if (!base || epoch === null) continue
    const expires = typeof o.expires_at === 'string' && !Number.isNaN(Date.parse(o.expires_at)) ? o.expires_at : null
    const origin = typeof o.origin === 'string' && DATA_ORIGIN.test(o.origin) ? o.origin : null
    const skillMap = o.kind === 'tutor' ? readSkillMap(o.skill_map) : null
    out.push({
      slug: o.slug,
      modelId: `lab/${o.slug}`,
      baseModel: base,
      epoch,
      authorName: text(o.author_name, 60) ?? 'a lab model',
      purpose: text(o.purpose, 160),
      examples: num(o.examples) ?? 0,
      holdoutExamples: num(o.holdout_examples),
      lossBefore: num(o.holdout_loss_before),
      lossAfter: num(o.holdout_loss_after),
      ...(o.kind === 'rl' ? { kind: 'rl' as const, scoreBefore: num(o.rl_score_before), scoreAfter: num(o.rl_score_after) } : {}),
      ...(o.kind === 'tutor' ? { kind: 'tutor' as const, ...(skillMap ? { skillMap } : {}) } : {}),
      ...(o.from_visitors === true ? { fromVisitors: true as const } : {}),
      expiresAt: expires,
      ...(typeof o.created_at === 'string' && !Number.isNaN(Date.parse(o.created_at)) ? { createdAt: o.created_at } : {}),
      name: text(o.name, 40),
      kept: o.kept === true,
      keptBy: o.kept === true ? text(o.kept_by, 60) : null,
      dataFrom: typeof o.data_from === 'string' ? DATA_FROM.exec(o.data_from)?.[1] ?? null : null,
      ...(origin ? { dataOrigin: origin } : {}),
    })
  }
  return out
}

/** The limits in a GET answer, or the ones the server uses when it sends none. */
export function parseLimits(raw: unknown): ChatLimits {
  const l = raw && typeof raw === 'object' ? (raw as { limits?: Record<string, unknown> }).limits : null
  const chars = num(l?.max_message_chars)
  const turns = num(l?.max_turns)
  return {
    maxMessageChars: chars !== null && chars >= 1 && chars <= 4000 ? Math.floor(chars) : 500,
    maxTurns: turns !== null && turns >= 1 && turns <= 50 ? Math.floor(turns) : 8,
  }
}

/**
 * The lines shown for one adapter: where it came from, and the score the lab
 * measured. A named adapter is titled by its name with its lab id under it;
 * an unnamed one by its lab id alone. `id` is there only for a named adapter
 * and `mark` ("kept") only for a kept one. `label` is the lab's data origin
 * label, there only when the server sent one.
 */
export function describeAdapter(a: TrainedAdapterView): { title: string; id?: string; mark?: string; origin: string; label?: string; score: string; kept: string } {
  const lesson = a.kind === 'tutor' ? skillSummary(a.skillMap) : null
  const score = a.kind === 'tutor'
    ? lesson
      ? `Pass bands come from questions held back from teaching: ${lesson.text}. Counted by the lab.`
      : 'No held-out score recorded.'
    : a.kind === 'rl'
    ? a.scoreBefore != null && a.scoreAfter != null
      ? `Held-out rubric score ${a.scoreBefore.toFixed(2)} before training, ${a.scoreAfter.toFixed(2)} after${a.holdoutExamples ? `, on ${a.holdoutExamples} tasks the lab held out` : ''}. Measured by the lab. Higher is better.`
      : 'No held-out score recorded.'
    : a.lossBefore !== null && a.lossAfter !== null
    ? `Held-out loss ${a.lossBefore.toFixed(2)} before training, ${a.lossAfter.toFixed(2)} after${a.holdoutExamples ? `, on ${a.holdoutExamples} examples the lab held out` : ''}. Measured by the lab. Lower is better.`
    : 'No held-out score recorded.'
  const until = a.expiresAt ? a.expiresAt.slice(0, 10) : ''
  return {
    title: a.name ?? a.modelId,
    ...(a.name ? { id: a.modelId } : {}),
    ...(a.kept ? { mark: 'kept' } : {}),
    origin: a.kind === 'tutor'
      ? `Epoch ${a.epoch}. A lesson${a.skillMap ? ` on "${a.skillMap.topic}"` : ''} written by ${a.authorName}${a.skillMap ? `, taught by ${a.skillMap.teacherName}` : ''}. Base model ${a.baseModel}.`
      : a.kind === 'rl'
      ? `Epoch ${a.epoch}. Practice by Reward (reinforcement learning) on ${a.examples} tasks and a rubric written by ${a.authorName}. Base model ${a.baseModel}.`
      : a.fromVisitors
      ? `Epoch ${a.epoch}. Trained on ${a.examples} conversations written by visitors, in a run ${a.authorName} asked for. No model read them and nobody reviewed them. The lab's owner can read them, and each read is counted. Base model ${a.baseModel}.`
      : a.dataFrom
      ? `Epoch ${a.epoch}. Trained on ${a.examples} rows of the public dataset ${a.dataFrom}, chosen by ${a.authorName}. Nobody at the lab has read those rows. Base model ${a.baseModel}.`
      : `Epoch ${a.epoch}. Data written by ${a.authorName} (${a.examples} examples). Base model ${a.baseModel}.`,
    ...(a.dataOrigin ? { label: `Data origin: ${shortOrigin(a.dataOrigin)}.` } : {}),
    score,
    kept: a.kept
      ? `Marked to keep${a.keptBy ? ` by ${a.keptBy}` : ''}.${until ? ` Stays until ${until}.` : ''}`
      : until ? `Removed after ${formatDay(until)} unless it is marked to keep.` : '',
  }
}

/** "3 to 5", or what is known of a row that has only one side measured. */
export function bandText(row: SkillRowView): string {
  if (row.before && row.after) return `${row.before.band} to ${row.after.band}`
  if (row.before) return `${row.before.band} before`
  if (row.after) return `${row.after.band} after`
  return 'Not measured'
}

const cellSentence = (label: 'Before' | 'After', c: SkillCell | null) =>
  c ? `${label}: ${c.passed} of ${c.total} answers passed. Pass band ${c.band} of 5.` : `${label}: not measured.`

/** One row as a sentence, for the details and for a screen reader. */
export function skillSentence(row: SkillRowView): string {
  return `${row.name}. ${cellSentence('Before', row.before)} ${cellSentence('After', row.after)}`
}

/**
 * The lesson's overall held back counts, from the rows that were measured
 * before and after. "More Answers Passed" only when the share that passed went
 * up. Null when no row has both.
 */
export function skillSummary(map: SkillMapView | undefined): { more: boolean; verdict: string; text: string } | null {
  if (!map) return null
  let bp = 0, bt = 0, ap = 0, at = 0
  for (const r of map.rows) {
    if (!r.before || !r.after) continue
    bp += r.before.passed; bt += r.before.total; ap += r.after.passed; at += r.after.total
  }
  if (bt === 0 || at === 0) return null
  const counts = `from ${bp} of ${bt} to ${ap} of ${at} answers passed`
  // The lab marks a change smaller than one pass band as within noise: then the counts are shown with no verdict.
  if (map.withinNoise) return { more: false, verdict: 'Within Noise', text: counts }
  const more = ap * bt > bp * at
  return { more, verdict: more ? 'More Answers Passed' : 'Not More Answers Passed', text: counts }
}

/** The flags a lesson adapter's card and details show, as the lab recorded them. */
export function skillFlags(map: SkillMapView): string[] {
  const out: string[] = []
  if (map.seenOnly) out.push('Flag: better only on questions seen in teaching.')
  // "Many" only when the lab flagged many; fewer after training can be a single answer and has its own sentence.
  if (map.cutShort) out.push('Flag: many answers were cut off by the token limit, so a gain may come from shorter answers.')
  else if (map.cutOffFell) out.push('Flag: fewer answers were cut off by the token limit after training, so part of a gain may come from shorter answers.')
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-12-01" as "1 Dec 2026". Anything else is returned as it came. */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : iso
}

// ---------------------------------------------------------------------------
// Pure helpers for the shelf, the gauge and the request. No DOM here.
// ---------------------------------------------------------------------------

/** What the chat route's GET answer says, strictly read. */
export interface ChatList {
  enabled: boolean
  /** The route could not read the list: say so, never "nothing has been trained". */
  unavailable: boolean
  compareEnabled: boolean
  adapters: TrainedAdapterView[]
  limits: ChatLimits
  notice: string | null
  /** Present only when the server says visitor offers are on. Without it there is no offer button. */
  offers: OffersInfo | null
}

export function parseListResponse(raw: unknown): ChatList {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    enabled: o.enabled === true,
    unavailable: o.unavailable === true,
    compareEnabled: o.compare_enabled === true,
    adapters: parseAdapters(o),
    limits: parseLimits(o),
    notice: text(o.notice, 300),
    offers: readOffers(o),
  }
}

/** The word on a card's tag: how the model was made. */
export function kindLabel(a: TrainedAdapterView | 'story'): string {
  if (a === 'story') return 'Story Model'
  if (a.kind === 'tutor') return 'Taught by Questions'
  return a.kind === 'rl' ? 'Practice by Reward' : 'Fine-Tuned'
}

/** Neutral mark colour for a maker with no accent: the wood edge. */
export const ACCENT_NEUTRAL = PAPER_TOKENS['--paper-line']
const ACCENTS: Array<[string, string]> = [
  ['gemini', '#4285F4'], ['deepseek', '#10A37F'], ['claude', '#D97706'], ['gpt', '#412991'], ['grok', '#1DA1F2'],
]
/** The room's accent for a maker, by name. A fallback model follows its own name. Anything else is neutral. */
export function accentFor(authorName: string | null | undefined): string {
  const name = (authorName ?? '').trim().toLowerCase()
  for (const [prefix, colour] of ACCENTS) if (name.startsWith(prefix)) return colour
  return ACCENT_NEUTRAL
}

export interface GaugeView {
  kind: 'sft' | 'rl' | 'none'
  heading: string
  caption: string
  /** One plain sentence on what the number is. */
  explain: string
  /** "Better", "Worse" or "Little change", from the two stored numbers only. Empty for kind 'none'. */
  verdict: string
  rows: Array<{ label: 'Before' | 'After'; value: number; text: string; pct: number }>
  aria: string
  /** Only for kind 'none'. */
  none: string
}

/** A change smaller than this share of the larger number is called "Little change". */
export const LITTLE_CHANGE = 0.05

/** Better, Worse or Little change, from the two stored numbers and which way is better. */
export function verdictOf(before: number, after: number, higherIsBetter: boolean): string {
  const top = Math.max(Math.abs(before), Math.abs(after))
  if (top === 0 || Math.abs(after - before) / top < LITTLE_CHANGE) return 'Little change'
  return (after > before) === higherIsBetter ? 'Better' : 'Worse'
}

/**
 * The before and after gauge of a card. It exists only when the lab measured
 * both numbers. Loss bars are proportional to the larger of the two (a
 * comparison, with no invented maximum); a reward score is on its real 0 to 1
 * scale.
 */
export function gaugeView(a: TrainedAdapterView): GaugeView {
  const none: GaugeView = { kind: 'none', heading: '', caption: '', explain: '', verdict: '', rows: [], aria: '', none: 'No held-out score recorded.' }
  if (a.kind === 'tutor') return none // a lesson shows its skill map, not a loss
  const rl = a.kind === 'rl'
  const before = rl ? a.scoreBefore ?? null : a.lossBefore
  const after = rl ? a.scoreAfter ?? null : a.lossAfter
  if (before === null || after === null) return none
  const clamp = (n: number) => Math.max(0, Math.min(100, n))
  if (rl) {
    return {
      kind: 'rl', heading: 'Held-Out Score', caption: 'Higher Is Better', none: '',
      explain: 'Score from a rubric written by a lab model, on tasks held out of training. Measured by the lab.',
      verdict: verdictOf(before, after, true),
      rows: [
        { label: 'Before', value: before, text: before.toFixed(2), pct: clamp(before * 100) },
        { label: 'After', value: after, text: after.toFixed(2), pct: clamp(after * 100) },
      ],
      aria: `Held-out rubric score ${before.toFixed(2)} before training, ${after.toFixed(2)} after. Higher is better. Measured by the lab.`,
    }
  }
  const top = Math.max(before, after)
  const pct = (v: number) => (top > 0 ? clamp((v / top) * 100) : 0)
  return {
    kind: 'sft', heading: 'Held-Out Loss', caption: 'Lower Is Better', none: '',
    explain: 'Loss is how wrong the model was on examples it never trained on. Measured by the lab.',
    verdict: verdictOf(before, after, false),
    rows: [
      { label: 'Before', value: before, text: before.toFixed(2), pct: pct(before) },
      { label: 'After', value: after, text: after.toFixed(2), pct: pct(after) },
    ],
    aria: `Held-out loss ${before.toFixed(2)} before training, ${after.toFixed(2)} after. Lower is better. Measured by the lab.`,
  }
}

/** A string that changes when anything the shelf draws changes, so a refresh can skip an identical redraw. */
export function shelfSignature(parts: { adapters: TrainedAdapterView[]; story: boolean; chat: boolean; state: string; compare: boolean; limits: ChatLimits; notice: string | null }): string {
  return JSON.stringify(parts)
}

/** "Question 3 of 8" is the question the next message will be; once all are used it says so. */
export function turnCounterText(used: number, max: number): string {
  return used >= max ? `${max} of ${max} used` : `Question ${used + 1} of ${max}`
}

/** The character counter shows from 80 percent of the limit. */
export function counterVisible(length: number, limit: number): boolean {
  return limit > 0 && length >= Math.ceil(limit * 0.8)
}

/** What the visitor's box holds in compare mode: the untrained side's earlier answers. Null means a normal chat. */
export function buildChatBody(adapter: string, history: Turn[], baseReplies: string[] | null, only?: 'trained' | 'untrained' | null, receipt?: string | null): Record<string, unknown> {
  const messages = history.map(t => ({ role: t.role, content: t.content }))
  // The receipt of the conversation so far goes with the next message, only when the panel holds one.
  const proof = receipt ? { receipt } : {}
  if (baseReplies === null) return { adapter, messages, ...proof }
  return { adapter, messages, compare: true, base_replies: [...baseReplies], ...(only ? { only } : {}), ...proof }
}

/** A reply may carry a receipt, only when the server issued one. */
export type ReplySide = { ok: true; reply: string; cutShort: boolean; receipt?: string } | { ok: false; message: string | null }
export type ReadReply =
  | { kind: 'error'; message: string | null }
  | { kind: 'single'; reply: string; cutShort: boolean; turnsLeft: number | null; receipt?: string }
  | { kind: 'pair'; trained: ReplySide; untrained: ReplySide; baseModel: string | null; turnsLeft: number | null; commit: boolean }

function readSide(v: unknown): ReplySide {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : {}
  const reply = o.ok === true ? text(o.reply, 1200) : null
  const receipt = readReceipt(o.receipt)
  if (reply) return { ok: true, reply, cutShort: o.cut_short === true, ...(receipt ? { receipt } : {}) }
  return { ok: false, message: text(o.message, 300) }
}

/**
 * The answer to a message, strictly read. `ok` is the HTTP result. Anything
 * that does not match the server's shapes is an error, never a throw.
 */
export function readReply(ok: boolean, json: unknown, compare: boolean): ReadReply {
  const o = json && typeof json === 'object' ? json as Record<string, unknown> : {}
  const message = text(o.message, 300)
  if (!ok) return { kind: 'error', message }
  const left = num(o.turns_left)
  const turnsLeft = left !== null && Number.isInteger(left) && left >= 0 && left <= 50 ? left : null
  if (!compare) {
    const reply = text(o.reply, 1200)
    const receipt = readReceipt(o.receipt)
    return reply ? { kind: 'single', reply, cutShort: o.cut_short === true, turnsLeft, ...(receipt ? { receipt } : {}) } : { kind: 'error', message }
  }
  if (o.compare !== true) return { kind: 'error', message }
  const trained = readSide(o.trained)
  const untrained = readSide(o.untrained)
  if (!trained.ok && !untrained.ok) return { kind: 'error', message: trained.message ?? untrained.message ?? message }
  return { kind: 'pair', trained, untrained, baseModel: text(o.base_model, 80), turnsLeft, commit: trained.ok && untrained.ok }
}

/** A line for the details: "Trained N days ago." from the record's created_at, when the server sends one. */
export function trainedAgoText(createdAt: string | undefined, nowMs: number): string | null {
  if (!createdAt) return null
  const t = Date.parse(createdAt)
  if (Number.isNaN(t) || t > nowMs) return null
  const days = Math.floor((nowMs - t) / 86_400_000)
  return days === 0 ? 'Trained today.' : `Trained ${days} ${days === 1 ? 'day' : 'days'} ago.`
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface Turn { role: 'user' | 'assistant'; content: string }

/** The server stops waiting for a model after this long (TRAINED_CHAT_TIMEOUT_MS in api/_lib/tinker-chat.ts). */
const SERVER_WAIT_SECONDS = 45
const STORY = 'story'
const WIDE = '(max-width: 760px)'
const TUBE_LINE = 'The speaking tube in the room glows for up to two minutes after a trained model answers anyone.'
const OWN_TUBE_LINE = 'Your reply lit the speaking tube in the room.'
const CLOSED_LINE = 'This model is no longer on the shelf. Your conversation stays here. Start a new one to talk to another model.'
const HALF_NOTE = 'Only one answer came back. Ask Again asks only the model that did not answer, and uses one more message.'
const COMPARE_DROPPED = 'Comparing with the untrained model was switched off. Your next question goes to one model.'

export const PANEL_CSS = `
      #trained-chat-container { position: fixed; bottom: 188px; right: 20px; z-index: 150; font-family: var(--paper-sans); }
      #trained-chat-toggle { width: 44px; height: 44px; border-radius: 50%; background: var(--paper-raised-veil); border: 1px solid var(--paper-line); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: var(--paper-shadow-soft); transition: transform 0.2s ease, box-shadow 0.2s ease; color: var(--paper-ink); padding: 0; }
      #trained-chat-toggle:hover { transform: scale(1.05); box-shadow: var(--paper-shadow-lift); }
      #trained-chat-toggle:focus-visible { outline: 2px solid var(--paper-focus); outline-offset: 2px; }
      #trained-chat-toggle svg { width: 20px; height: 20px; opacity: 0.8; }
      #trained-chat-panel { position: fixed; right: 76px; bottom: 20px; width: min(880px, calc(100vw - 96px)); height: min(720px, calc(100dvh - 40px)); box-sizing: border-box; display: none; flex-direction: column; overflow: hidden; z-index: 1080; }
      ${paperShell('#trained-chat-panel')}
      #trained-chat-panel.open { display: flex; }
      #trained-chat-panel *, #trained-chat-panel *::before, #trained-chat-panel *::after { box-sizing: border-box; }
      ${paperFocusRing('#trained-chat-panel')}
      #trained-chat-panel button { font-family: inherit; color: var(--paper-ink); }
      #trained-chat-panel .tc-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 52px; padding: 2px 4px 2px 18px; }
      ${paperHeader('#trained-chat-panel .tc-head')}
      ${paperHeading('#trained-chat-panel .tc-title', 17)}
      #trained-chat-panel .tc-close { width: 44px; height: 44px; background: none; border: 0; font-size: 24px; line-height: 1; cursor: pointer; border-radius: var(--paper-radius); }
      #trained-chat-panel .tc-close:hover { background: var(--paper-sunk); }
      #trained-chat-panel .tc-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 272px minmax(0, 1fr); }
      #trained-chat-panel .tc-shelf { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 14px 14px 16px; background: var(--paper-sunk); border-right: 1px solid var(--paper-line); }
      #trained-chat-panel .tc-shelf-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      #trained-chat-panel .tc-shelf-title { font-family: var(--paper-serif); font-size: 15px; font-weight: 700; }
      #trained-chat-panel .tc-shelf-count { font-size: 13px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-cards { display: flex; flex-direction: column; gap: 8px; }
      #trained-chat-panel .tc-card { display: flex; flex-direction: column; gap: 5px; width: 100%; min-height: 76px; padding: 10px 12px 10px 14px; text-align: left; font-size: 13px; line-height: 1.35; position: relative; }
      ${paperCard('#trained-chat-panel .tc-card')}
      ${paperCardSelected('#trained-chat-panel .tc-card[aria-pressed="true"]')}
      #trained-chat-panel .tc-card[aria-pressed="true"] { padding: 9px 11px 9px 13px; }
      #trained-chat-panel .tc-card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      #trained-chat-panel .tc-card-title { font-family: var(--paper-serif); font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
      #trained-chat-panel .tc-card-title.tc-mono { font: 600 13px/1.3 var(--paper-mono); }
      #trained-chat-panel .tc-kept { flex: none; padding: 0 7px; border-radius: 9px; border: 1px solid var(--paper-brass-edge); background: var(--paper-brass); color: var(--paper-ink); font: 600 13px/18px var(--paper-sans); }
      #trained-chat-panel .tc-maker { display: flex; align-items: center; gap: 7px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-swatch { flex: none; width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--paper-ink); }
      #trained-chat-panel .tc-tag { align-self: flex-start; }
      ${paperTag('#trained-chat-panel .tc-tag')}
      #trained-chat-panel .tc-gauge { display: flex; flex-direction: column; gap: 3px; margin-top: 2px; font-size: 13px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-gauge-head { display: flex; justify-content: space-between; gap: 6px; }
      #trained-chat-panel .tc-gauge-row { display: grid; grid-template-columns: 48px 1fr 40px; align-items: center; gap: 6px; }
      #trained-chat-panel .tc-track { position: relative; height: 8px; background: var(--paper-sunk); border: 1px solid var(--paper-line); border-radius: 4px; overflow: hidden; }
      #trained-chat-panel .tc-bar { height: 100%; background: var(--paper-bar); }
      #trained-chat-panel .tc-bar.tc-after { background: var(--paper-brass-edge); }
      #trained-chat-panel .tc-tick { position: absolute; top: -1px; bottom: -1px; width: 2px; margin-left: -1px; background: var(--paper-ink); }
      #trained-chat-panel .tc-verdict { display: flex; flex-wrap: wrap; gap: 0 6px; margin-top: 2px; color: var(--paper-ink); }
      #trained-chat-panel .tc-verdict-word { font-weight: 700; }
      #trained-chat-panel .tc-explain { margin: 2px 0 0; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-gauge-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--paper-ink); }
      #trained-chat-panel .tc-shelf-foot { margin-top: auto; padding-top: 6px; border-top: 1px solid var(--paper-hair); font-size: 13px; color: var(--paper-ink-2); display: flex; flex-direction: column; gap: 6px; }
      #trained-chat-panel .tc-shelf-foot p, #trained-chat-panel .tc-sheet p { margin: 0; }
      #trained-chat-panel .tc-sheet { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; padding: 28px 24px; max-width: 520px; }
      #trained-chat-panel .tc-sheet h2 { margin: 0; font-family: var(--paper-serif); font-size: 18px; font-weight: 700; }
      #trained-chat-panel .tc-shelf .tc-sheet { padding: 4px 0 0; max-width: none; font-size: 14px; }
      #trained-chat-panel .tc-shelf .tc-sheet h2 { font-size: 15px; }
      #trained-chat-panel.tc-full-sheet .tc-body { grid-template-columns: minmax(0, 1fr); }
      #trained-chat-panel.tc-full-sheet .tc-shelf { background: var(--paper-surface); border-right: 0; }
      #trained-chat-panel.tc-full-sheet .tc-conv, #trained-chat-panel.tc-full-sheet .tc-shelf-head, #trained-chat-panel.tc-full-sheet .tc-cards { display: none; }
      #trained-chat-panel.tc-full-sheet .tc-sheet-host { margin: 20px 0 0; display: flex; flex-direction: column; align-items: center; gap: 16px; }
      #trained-chat-panel .tc-slot { display: flex; align-items: center; justify-content: center; width: 100%; max-width: 300px; min-height: 76px; border: 1px dashed var(--paper-line); border-radius: var(--paper-radius); color: var(--paper-ink-2); font-size: 13px; }
      #trained-chat-panel.tc-full-sheet .tc-shelf .tc-sheet { padding: 28px 24px; max-width: 480px; align-items: center; text-align: center; font-size: 15px; }
      #trained-chat-panel.tc-full-sheet .tc-shelf .tc-sheet h2 { font-size: 20px; }
      #trained-chat-panel.tc-full-sheet .tc-shelf-foot { margin-top: 0; }
      #trained-chat-panel .tc-conv { min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--paper-surface); }
      #trained-chat-panel .tc-conv-head { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-height: 56px; padding: 8px 14px; background: var(--paper-raised); border-bottom: 1px solid var(--paper-hair); }
      #trained-chat-panel .tc-who { flex: 1 1 220px; min-width: 0; }
      #trained-chat-panel .tc-who-title { display: flex; align-items: center; gap: 7px; font-family: var(--paper-serif); font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
      #trained-chat-panel .tc-who-sub { font-size: 13px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      #trained-chat-panel .tc-btn, #trained-chat-panel .tc-back { min-height: 44px; padding: 0 12px; font-size: 14px; }
      ${paperQuietButton('#trained-chat-panel .tc-btn, #trained-chat-panel .tc-back')}
      #trained-chat-panel .tc-btn.tc-link { background: none; border-color: transparent; color: var(--paper-brass-ink); text-decoration: underline; text-underline-offset: 3px; }
      #trained-chat-panel .tc-btn.tc-link:hover { background: var(--paper-sunk); }
      #trained-chat-panel .tc-back { display: none; }
      #trained-chat-panel .tc-switch { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 10px; background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: var(--paper-radius); font-size: 14px; font-weight: 600; cursor: pointer; }
      #trained-chat-panel .tc-switch[aria-disabled="true"] { cursor: default; background: var(--paper-sunk); }
      #trained-chat-panel .tc-switch-state { font-size: 13px; font-weight: 600; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-switch-knob { position: relative; flex: none; width: 34px; height: 18px; border-radius: 9px; border: 1.5px solid var(--paper-line); background: var(--paper-sunk); }
      #trained-chat-panel .tc-switch-knob::after { content: ''; position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%; background: var(--paper-line); }
      #trained-chat-panel .tc-switch[aria-checked="true"] .tc-switch-knob { background: var(--paper-brass); border-color: var(--paper-brass-edge); }
      #trained-chat-panel .tc-switch[aria-checked="true"] .tc-switch-knob::after { left: 17px; background: var(--paper-ink); }
      #trained-chat-panel .tc-switch-note { flex: none; margin: 0; padding: 6px 14px; font-size: 13px; color: var(--paper-ink-2); border-bottom: 1px solid var(--paper-hair); background: var(--paper-surface); }
      #trained-chat-panel .tc-details { flex: none; max-height: 34%; overflow-y: auto; padding: 8px 14px; background: var(--paper-raised); border-bottom: 1px solid var(--paper-hair); }
      #trained-chat-panel [hidden] { display: none !important; }
      #trained-chat-panel .tc-det-maker { display: none; }
      #trained-chat-panel .tc-details p { margin: 0 0 6px; font-size: 13px; color: var(--paper-ink); }
      #trained-chat-panel .tc-log { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 16px 16px 12px; }
      #trained-chat-panel .tc-log-empty { margin: auto; max-width: 360px; text-align: center; color: var(--paper-ink-2); font-size: 14px; }
      #trained-chat-panel .tc-ex { display: flex; flex-direction: column; gap: 8px; }
      #trained-chat-panel .tc-who-label { font-size: 13px; letter-spacing: 0.2px; font-weight: 700; color: var(--paper-ink-2); margin-bottom: 2px; }
      #trained-chat-panel .tc-slip { align-self: flex-end; max-width: 85%; }
      #trained-chat-panel .tc-slip .tc-who-label { text-align: right; }
      #trained-chat-panel .tc-msg { padding: 9px 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15px; line-height: 1.5; }
      #trained-chat-panel .tc-msg.user { background: var(--paper-visitor); border: 1px solid var(--paper-line); border-radius: 10px 10px 2px 10px; }
      #trained-chat-panel .tc-msg.assistant { background: var(--paper-white); border: 1px solid var(--paper-line); border-left-width: 3px; border-radius: 2px 10px 10px 10px; }
      #trained-chat-panel .tc-msg.wait { background: transparent; border: 1px dashed var(--paper-line); border-radius: 2px 10px 10px 10px; color: var(--paper-ink-2); font-size: 14px; }
      #trained-chat-panel .tc-msg.failed { background: var(--paper-danger-bg); border: 1px solid var(--paper-danger); border-radius: 2px 10px 10px 10px; color: var(--paper-danger); font-size: 14px; }
      #trained-chat-panel .tc-sheet-wrap { align-self: flex-start; max-width: 92%; min-width: 0; }
      #trained-chat-panel .tc-pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
      #trained-chat-panel .tc-pair .tc-sheet-wrap { max-width: none; width: 100%; }
      #trained-chat-panel .tc-pair.tc-two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #trained-chat-panel .tc-sheet-wrap.tc-untrained .tc-msg.assistant { background: var(--paper-sunk); border: 1px dashed var(--paper-line); border-left: 3px solid var(--paper-line); }
      #trained-chat-panel .tc-fine { font-size: 13px; color: var(--paper-ink-2); margin-top: 3px; }
      #trained-chat-panel .tc-story-slot { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
      #trained-chat-panel:not(.tc-story-chosen) .tc-story-slot, #trained-chat-panel.tc-story-chosen .tc-chatonly { display: none; }
      #trained-chat-panel.tc-chat-off .tc-shelf { display: none; }
      #trained-chat-panel.tc-chat-off .tc-body { grid-template-columns: minmax(0, 1fr); }
      #trained-chat-panel.tc-chat-off .tc-back { display: none; }
      #trained-chat-panel .tc-foot { flex: none; padding: 8px 14px 10px; background: var(--paper-raised); border-top: 1px solid var(--paper-line); }
      #trained-chat-panel .tc-info { margin: 0 0 8px; }
      #trained-chat-panel .tc-tube-own { margin: 6px 0 0; font-size: 13px; color: var(--paper-brass-ink); }
      #trained-chat-panel .tc-banner { margin: 0 0 8px; padding: 8px 10px; border: 1px solid var(--paper-danger); border-radius: var(--paper-radius-sm); background: var(--paper-danger-bg); color: var(--paper-danger); font-size: 14px; }
      #trained-chat-panel .tc-form { display: flex; flex-direction: column; gap: 6px; }
      #trained-chat-panel .tc-input-row { display: flex; gap: 8px; align-items: flex-end; }
      #trained-chat-panel textarea { flex: 1; min-height: 44px; max-height: 130px; resize: none; padding: 10px; font-family: inherit; font-size: 16px; line-height: 1.3; }
      #trained-chat-panel .tc-meta { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-count.tc-over { color: var(--paper-danger); font-weight: 600; }
      #trained-chat-panel .tc-limit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; }
      #trained-chat-panel .tc-limit p { margin: 0; flex: 1 1 200px; }
      #trained-chat-panel .tc-note { margin: 6px 0 0; font-size: 13px; color: var(--paper-ink-2); }
      .tc-send, #trained-chat-panel .tc-new { min-width: 44px; min-height: 44px; padding: 0 14px; font-family: inherit; font-size: 13px; font-weight: 600; }
      ${paperPrimaryButton('.tc-send, #trained-chat-panel .tc-new')}
      #trained-chat-panel .tc-send, #trained-chat-panel .tc-new, #trained-chat-panel .tc-again { font-size: 15px; color: var(--paper-ink); }
      #trained-chat-panel .tc-new { background: var(--paper-raised); border-color: var(--paper-line); font-size: 14px; font-weight: 600; }
      #trained-chat-panel .tc-again { min-height: 44px; padding: 0 12px; border-radius: var(--paper-radius); border: 1px solid var(--paper-line); background: var(--paper-raised); font-weight: 600; cursor: pointer; }
      #trained-chat-panel button:disabled, #trained-chat-panel textarea:disabled { opacity: 0.55; cursor: default; }
      #trained-chat-panel .tc-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      #trained-chat-panel .tc-story { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
      #trained-chat-panel .tc-story-title { font-family: var(--paper-serif); font-size: 16px; font-weight: 700; color: var(--paper-ink); }
      #trained-chat-panel .tc-story-about, #trained-chat-panel .tc-story-note { color: var(--paper-ink-2); font-size: 14px; }
      #trained-chat-panel .tc-notice { padding: 8px 10px; border-radius: var(--paper-radius-sm); background: var(--paper-visitor); border: 1px solid var(--paper-line); color: var(--paper-ink); font-size: 13px; }
      #trained-chat-panel .tc-story-form { display: flex; gap: 8px; }
      #trained-chat-panel .tc-story-input { flex: 1; min-width: 0; min-height: 44px; padding: 0 10px; font-family: inherit; font-size: 16px; }
      ${paperInput('#trained-chat-panel textarea, #trained-chat-panel .tc-story-input, #trained-chat-panel .tc-code-input')}
      #trained-chat-panel .tc-story-text { padding: 10px 12px; border-radius: 2px 10px 10px 10px; background: var(--paper-white); border: 1px solid var(--paper-line); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15px; line-height: 1.5; }
      #trained-chat-panel .tc-story .tc-status { color: var(--paper-ink-2); font-size: 13px; min-height: 0; }
      #trained-chat-panel .tc-skill { gap: 5px; }
      #trained-chat-panel .tc-skill-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; align-items: center; padding: 4px 0 0; border-top: 1px solid var(--paper-hair); }
      #trained-chat-panel .tc-skill-name { grid-column: 1 / -1; font-weight: 600; color: var(--paper-ink); overflow-wrap: anywhere; }
      #trained-chat-panel .tc-skill-bars { display: flex; flex-direction: column; gap: 3px; }
      #trained-chat-panel .tc-bar.tc-hatch { background: repeating-linear-gradient(135deg, var(--paper-bar) 0, var(--paper-bar) 3px, var(--paper-sunk) 3px, var(--paper-sunk) 6px); }
      #trained-chat-panel .tc-skill-band { font-variant-numeric: tabular-nums; color: var(--paper-ink); text-align: right; }
      #trained-chat-panel .tc-skill-key { display: flex; flex-wrap: wrap; gap: 0 10px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-skill-flag { margin: 2px 0 0; color: var(--paper-danger); font-weight: 600; }
      #trained-chat-panel .tc-offer-row { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 8px; }
      #trained-chat-panel .tc-offer-note { margin: 0; font-size: 13px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-offer { min-height: 44px; padding: 0 14px; font-size: 14px; font-weight: 600; }
      #trained-chat-panel .tc-takeback { align-self: flex-start; }
      #trained-chat-panel .tc-offer-sheet { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--paper-raised-veil); }
      #trained-chat-panel .tc-offer-card { display: flex; flex-direction: column; width: min(580px, 100%); max-height: 100%; background: var(--paper-surface); border: 1px solid var(--paper-line); border-radius: var(--paper-radius); box-shadow: var(--paper-shadow-soft); overflow: hidden; }
      #trained-chat-panel .tc-offer-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 18px 8px; display: flex; flex-direction: column; gap: 10px; font-size: 15px; line-height: 1.45; }
      #trained-chat-panel .tc-offer-scroll p { margin: 0; }
      #trained-chat-panel .tc-offer-title { margin: 0; font-family: var(--paper-serif); font-size: 19px; font-weight: 700; }
      #trained-chat-panel .tc-offer-conv { flex: none; min-height: 88px; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; background: var(--paper-white); border: 1px solid var(--paper-line); border-radius: var(--paper-radius-sm); }
      #trained-chat-panel .tc-offer-turn { display: flex; flex-direction: column; gap: 1px; }
      #trained-chat-panel .tc-offer-turn-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.4; }
      #trained-chat-panel .tc-offer-code { padding: 8px 10px; font: 700 20px/1.3 var(--paper-mono); letter-spacing: 0.08em; background: var(--paper-white); border: 1px solid var(--paper-line); border-radius: var(--paper-radius-sm); user-select: all; overflow-wrap: anywhere; }
      #trained-chat-panel .tc-offer-actions { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 18px 14px; border-top: 1px solid var(--paper-hair); background: var(--paper-raised); }
      #trained-chat-panel .tc-offer-alert { flex: 1 1 100%; margin: 0; padding: 8px 10px; border: 1px solid var(--paper-danger); border-radius: var(--paper-radius-sm); background: var(--paper-danger-bg); color: var(--paper-danger); font-size: 14px; }
      #trained-chat-panel .tc-offer-status { flex: 1 1 100%; margin: 0; font-size: 13px; color: var(--paper-ink-2); }
      #trained-chat-panel .tc-offer-go { min-height: 44px; padding: 0 14px; font-family: inherit; font-size: 15px; font-weight: 600; }
      ${paperPrimaryButton('#trained-chat-panel .tc-offer-go')}
      #trained-chat-panel .tc-offer-go { color: var(--paper-ink); }
      #trained-chat-panel .tc-code-input { min-height: 44px; padding: 0 10px; font-family: inherit; font-size: 16px; text-transform: uppercase; }
      #trained-chat-panel .tc-offer-label { font-weight: 700; font-size: 14px; }
      @media (max-width: 760px) {
        #trained-chat-panel { inset: 0; right: 0; bottom: 0; width: 100%; height: 100dvh; border-radius: 0; border: 0; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
        #trained-chat-panel .tc-body { grid-template-columns: minmax(0, 1fr); }
        #trained-chat-panel.tc-view-shelf .tc-conv { display: none; }
        #trained-chat-panel.tc-view-chat .tc-shelf { display: none; }
        #trained-chat-panel.tc-view-chat.tc-full-sheet .tc-shelf { display: flex; }
        #trained-chat-panel .tc-shelf { border-right: 0; }
        #trained-chat-panel .tc-back { display: inline-block; }
        #trained-chat-panel .tc-pair.tc-two { grid-template-columns: minmax(0, 1fr); }
        #trained-chat-panel .tc-slip { max-width: 92%; }
        #trained-chat-panel .tc-conv-head { gap: 4px 8px; padding: 6px 12px 8px; }
        #trained-chat-panel .tc-controls { display: contents; }
        #trained-chat-panel .tc-back { order: 1; }
        #trained-chat-panel .tc-controls .tc-new { order: 2; margin-left: auto; }
        #trained-chat-panel .tc-who { order: 3; flex: 1 1 140px; min-width: 140px; }
        #trained-chat-panel .tc-det-maker { display: block; }
        #trained-chat-panel .tc-who-sub { display: none; }
        #trained-chat-panel .tc-controls .tc-btn { order: 3; }
        #trained-chat-panel .tc-controls .tc-switch { order: 4; flex-basis: 100%; justify-content: space-between; }
        #trained-chat-panel .tc-switch-note { padding: 4px 12px; }
        #trained-chat-panel .tc-sheet { padding: 24px 18px; }
        #trained-chat-panel .tc-offer { width: 100%; }
        #trained-chat-panel .tc-offer-sheet { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
        #trained-chat-panel .tc-offer-card { width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; }
        #trained-chat-panel .tc-offer-conv { max-height: 30dvh; }
        #trained-chat-panel .tc-offer-actions .tc-btn, #trained-chat-panel .tc-offer-actions .tc-offer-go { flex: 1 1 140px; }
      }
      #trained-chat-panel.tc-short .tc-back, #trained-chat-panel.tc-short .tc-controls .tc-new, #trained-chat-panel.tc-short .tc-controls .tc-btn, #trained-chat-panel.tc-short .tc-who-sub, #trained-chat-panel.tc-short .tc-switch-note, #trained-chat-panel.tc-short .tc-details, #trained-chat-panel.tc-short .tc-note, #trained-chat-panel.tc-short .tc-tube-own, #trained-chat-panel.tc-short .tc-log-empty { display: none; }
      #trained-chat-panel.tc-short .tc-offer-row { display: none; }
      #trained-chat-panel.tc-short .tc-conv-head { min-height: 0; padding-top: 4px; padding-bottom: 4px; }
      @media (max-height: 560px) {
        #trained-chat-panel .tc-switch-note, #trained-chat-panel .tc-who-sub, #trained-chat-panel .tc-note, #trained-chat-panel .tc-log-empty { display: none; }
        #trained-chat-panel .tc-head { min-height: 44px; }
        #trained-chat-panel .tc-details { max-height: 25%; }
      }
      @media (prefers-reduced-motion: reduce) { #trained-chat-toggle, #trained-chat-panel .tc-card { transition: none; } }
    `

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (content !== undefined) e.textContent = content
  return e
}

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export class TrainedChatPanel {
  private container: HTMLDivElement
  private toggle: HTMLButtonElement
  private panel: HTMLDivElement
  private shelf: HTMLElement
  private shelfHead: HTMLDivElement
  private shelfCount: HTMLSpanElement
  private cards: HTMLDivElement
  private shelfSheet: HTMLDivElement
  private shelfFoot: HTMLDivElement
  private conv: HTMLElement
  private backButton: HTMLButtonElement
  private whoTitle: HTMLDivElement
  private whoSub: HTMLDivElement
  private detailsButton: HTMLButtonElement
  private details: HTMLDivElement
  private switchButton: HTMLButtonElement
  private switchNote: HTMLParagraphElement
  private newButton: HTMLButtonElement
  private log: HTMLDivElement
  private storySlot: HTMLDivElement
  private banner: HTMLDivElement
  private form: HTMLFormElement
  private input: HTMLTextAreaElement
  private send: HTMLButtonElement
  private again: HTMLButtonElement
  private counter: HTMLSpanElement
  private turnLabel: HTMLSpanElement
  private limitRow: HTMLDivElement
  private inputRow: HTMLDivElement
  private meta: HTMLDivElement
  private statusLine: HTMLDivElement
  private infoLine: HTMLParagraphElement
  private tubeOwn: HTMLParagraphElement
  private switchState: HTMLSpanElement
  private headBar: HTMLDivElement
  private bodyBox: HTMLDivElement
  private offerRow: HTMLDivElement
  private offerButton: HTMLButtonElement
  private offerNote: HTMLParagraphElement
  private sheet: HTMLDivElement
  private sheetAlert: HTMLParagraphElement | null = null
  private sheetStatus: HTMLParagraphElement | null = null
  private sheetButtons: HTMLButtonElement[] = []
  private sheetHeading: HTMLElement | null = null

  /** The offers block of the last GET answer. Null means offers are off: no button, no receipt, no take back link. */
  private offers: OffersInfo | null = null
  /** The receipt of the last reply of the trained side, in memory only. Dropped with the conversation or the adapter. */
  private receipt: string | null = null
  /** This conversation was offered (or the lab said it already holds it). */
  private offered = false
  /**
   * The take back code of the offer of the conversation on screen, in this panel's memory only and dropped with the
   * conversation. It is kept past the sheet so that a take back with this code, from the sheet or typed later, can
   * put the button back; it is never shown again. Null when this conversation was not offered from this panel.
   */
  private offeredCode: string | null = null
  /** What the sheet is showing, if it is open. */
  private sheetMode: 'offer' | 'withdraw' | null = null
  private sheetBusy = false
  private sheetToken = 0
  private sheetInert: Array<() => void> = []
  /** The take back code from a 201, in this panel's memory only, until the sheet closes. */
  private offerCode: string | null = null

  private adapters: TrainedAdapterView[] = []
  private limits: ChatLimits = { maxMessageChars: 500, maxTurns: 8 }
  private notice: string | null = null
  private compareEnabled = false
  /** 'ok', 'unavailable' (the route could not read the list) or 'error' (the request failed). */
  private loadState: 'ok' | 'unavailable' | 'error' = 'ok'
  private chosen: string | null = null
  /** The trained side's conversation, in the shape the server wants. */
  private turns: Turn[] = []
  /** The untrained side's earlier answers (compare only). */
  private baseReplies: string[] = []
  private serverTurnsLeft: number | null = null
  private compareOn = false
  /** Elements of the exchange that is not yet part of the conversation (waiting, or half answered). */
  private openBlock: HTMLElement | null = null
  private halfPair = false
  /** The answers of a half pair that did come back, so a retry asks only the side that failed. */
  private held: { message: string; trained: ReplySide | null; untrained: ReplySide | null } | null = null
  /** Counts conversations: a reply that comes back to an older one is not drawn into the current one. */
  private convId = 0
  /** The adapter of a conversation that was under way when it left the shelf. */
  private retired: TrainedAdapterView | null = null
  /** A slug the practice bench asked for before the list was read. */
  private pendingSlug: string | null = null
  private returnFocus: HTMLElement | null = null
  /** The visitor chose a card themselves. Until then, the first model on the shelf is chosen for them. */
  private picked = false
  /** Set when a refresh switched comparing off under a conversation that had it on. */
  private compareDropped = false
  private busy = false
  private isOpen = false
  /** What the room's state last said about the chat being switched on. */
  private available = false
  private refreshTimer: number | null = null
  /** True while the chat route itself has said the chat is on. */
  private chatShown = false
  private story: PanelSection | null = null
  private signature = ''
  private undoInert: Array<() => void> = []
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private viewportHandler: (() => void) | null = null
  /** Called once with the time (ms) of every real reply from a trained model. The page uses it for the room's cue. */
  onReply?: (at: number) => void

  constructor() {
    this.container = document.createElement('div')
    this.container.id = 'trained-chat-container'
    this.container.style.display = 'none' // shown only once the server says the chat is on
    const style = document.createElement('style')
    style.textContent = PANEL_CSS
    this.container.appendChild(style)
    document.body.appendChild(this.container)

    this.toggle = document.createElement('button')
    this.toggle.id = 'trained-chat-toggle'
    this.toggle.type = 'button'
    this.toggle.title = 'Talk to what they trained'
    this.toggle.setAttribute('aria-label', 'Talk to what they trained')
    this.toggle.setAttribute('aria-expanded', 'false')
    this.toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>'
    this.toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()))
    this.container.appendChild(this.toggle)

    // The panel sits on the page itself, not in the toggle's container: the container's own
    // stacking level (150) would keep it under the dev button and other panels.
    this.panel = document.createElement('div')
    this.panel.id = 'trained-chat-panel'
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-modal', 'true')
    this.panel.setAttribute('aria-label', 'Talk to what they trained')
    this.panel.setAttribute('tabindex', '-1')
    this.panel.classList.add('tc-view-shelf')
    this.panel.style.display = 'none'
    document.body.appendChild(this.panel)

    // Header
    const head = el('div', 'tc-head')
    head.appendChild(el('div', 'tc-title', 'Talk to What They Trained'))
    const close = el('button', 'tc-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.addEventListener('click', () => this.close())
    head.appendChild(close)
    this.panel.appendChild(head)
    this.headBar = head

    const body = el('div', 'tc-body')
    this.panel.appendChild(body)
    this.bodyBox = body

    // Shelf column
    this.shelf = el('aside', 'tc-shelf')
    this.shelf.setAttribute('aria-label', 'On the shelf')
    this.shelfHead = el('div', 'tc-shelf-head')
    this.shelfHead.appendChild(el('div', 'tc-shelf-title', 'On the Shelf'))
    this.shelfCount = el('span', 'tc-shelf-count')
    this.shelfHead.appendChild(this.shelfCount)
    this.cards = el('div', 'tc-cards')
    this.shelfSheet = el('div', 'tc-sheet-host')
    this.shelfFoot = el('div', 'tc-shelf-foot')
    this.shelf.append(this.shelfHead, this.shelfSheet, this.cards, this.shelfFoot)
    body.appendChild(this.shelf)

    // Conversation column
    this.conv = el('section', 'tc-conv')
    this.conv.setAttribute('aria-label', 'Conversation')
    const convHead = el('div', 'tc-conv-head')
    this.backButton = el('button', 'tc-back', 'Back to Shelf')
    this.backButton.type = 'button'
    this.backButton.addEventListener('click', () => {
      this.panel.classList.remove('tc-view-chat')
      this.panel.classList.add('tc-view-shelf')
      this.focusFirstCard()
    })
    convHead.appendChild(this.backButton)
    const who = el('div', 'tc-who')
    this.whoTitle = el('div', 'tc-who-title')
    this.whoSub = el('div', 'tc-who-sub')
    who.append(this.whoTitle, this.whoSub)
    convHead.appendChild(who)
    const controls = el('div', 'tc-controls tc-chatonly')
    this.detailsButton = el('button', 'tc-btn tc-link', 'Details')
    this.detailsButton.type = 'button'
    this.detailsButton.setAttribute('aria-expanded', 'false')
    this.detailsButton.setAttribute('aria-controls', 'trained-chat-details')
    this.detailsButton.addEventListener('click', () => {
      const open = this.details.hidden
      this.details.hidden = !open
      this.detailsButton.setAttribute('aria-expanded', String(open))
    })
    this.switchButton = el('button', 'tc-switch')
    this.switchButton.type = 'button'
    this.switchButton.setAttribute('role', 'switch')
    this.switchButton.setAttribute('aria-checked', 'false')
    this.switchButton.appendChild(el('span', 'tc-switch-label', 'Compare With Untrained'))
    this.switchState = el('span', 'tc-switch-state')
    this.switchButton.appendChild(this.switchState)
    this.switchButton.appendChild(el('span', 'tc-switch-knob'))
    this.switchButton.addEventListener('click', () => this.flipCompare())
    this.switchButton.hidden = true
    this.newButton = el('button', 'tc-new', 'New Conversation')
    this.newButton.type = 'button'
    this.newButton.hidden = true
    this.newButton.addEventListener('click', () => this.newConversation())
    controls.append(this.detailsButton, this.switchButton, this.newButton)
    convHead.appendChild(controls)
    this.switchNote = el('p', 'tc-switch-note tc-chatonly')
    this.switchNote.hidden = true
    this.details = el('div', 'tc-details tc-chatonly')
    this.details.id = 'trained-chat-details'
    this.details.hidden = true
    this.log = el('div', 'tc-log tc-chatonly')
    this.log.setAttribute('role', 'log')
    this.log.setAttribute('aria-live', 'polite')
    this.log.setAttribute('aria-relevant', 'additions')
    this.log.setAttribute('aria-label', 'Conversation')
    this.storySlot = el('div', 'tc-story-slot')

    const foot = el('div', 'tc-foot tc-chatonly')
    this.banner = el('div', 'tc-banner')
    this.banner.setAttribute('role', 'alert')
    this.banner.hidden = true
    this.form = el('form', 'tc-form')
    this.inputRow = el('div', 'tc-input-row')
    this.input = el('textarea')
    this.input.rows = 2
    this.input.setAttribute('aria-label', 'Your message')
    this.input.placeholder = 'Write a message'
    this.send = el('button', 'tc-send', 'Send')
    this.send.type = 'submit'
    this.again = el('button', 'tc-again', 'Ask Again')
    this.again.type = 'button'
    this.again.hidden = true
    this.again.addEventListener('click', () => void this.submit())
    this.inputRow.append(this.input, this.again, this.send)
    this.meta = el('div', 'tc-meta')
    this.turnLabel = el('span', 'tc-turns')
    this.counter = el('span', 'tc-count')
    this.meta.append(this.counter, this.turnLabel)
    this.form.append(this.inputRow, this.meta)
    this.limitRow = el('div', 'tc-limit')
    this.limitRow.hidden = true
    this.limitRow.appendChild(el('p', undefined, 'This conversation has used all its turns. Start a new one to keep going.'))
    const again = el('button', 'tc-new', 'New Conversation')
    again.type = 'button'
    again.addEventListener('click', () => this.newConversation())
    this.limitRow.appendChild(again)
    const standing = el('p', 'tc-note', 'Replies are not reviewed. They come from small models and can be wrong.')
    this.infoLine = el('p', 'tc-notice tc-info')
    this.infoLine.hidden = true
    this.tubeOwn = el('p', 'tc-tube-own')
    this.tubeOwn.hidden = true
    this.offerRow = el('div', 'tc-offer-row')
    this.offerRow.hidden = true
    this.offerButton = el('button', 'tc-btn tc-offer', OFFER_BUTTON)
    this.offerButton.type = 'button'
    this.offerButton.disabled = true
    this.offerButton.addEventListener('click', () => this.openOfferSheet())
    this.offerNote = el('p', 'tc-offer-note', OFFER_DISABLED_NOTE)
    this.offerRow.append(this.offerButton, this.offerNote)
    foot.append(this.banner, this.infoLine, this.form, this.limitRow, standing, this.offerRow, this.tubeOwn)
    this.statusLine = el('div', 'tc-sr')
    this.statusLine.setAttribute('role', 'status')

    this.conv.append(convHead, this.switchNote, this.details, this.log, this.storySlot, foot, this.statusLine)
    body.appendChild(this.conv)

    // The sheet for offering a conversation or taking an offer back. It sits inside the panel, over everything else in it.
    this.sheet = el('div', 'tc-offer-sheet')
    this.sheet.hidden = true
    this.panel.appendChild(this.sheet)

    this.form.addEventListener('submit', e => {
      e.preventDefault()
      void this.submit()
    })
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        void this.submit()
      }
    })
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto'
      this.input.style.height = `${Math.min(this.input.scrollHeight, 130)}px`
      if (!this.banner.hidden) this.clearBanner()
      this.refreshMeta()
    })
    installPaperTheme() // the shared tokens on :root, once for the whole page
  }

  /**
   * Told by the page what the room's state says: is the visitor chat switched
   * on? Only a change does anything. Turning on reads the adapters and starts
   * the two minute refresh; turning off stops it and hides the panel. Until
   * this is called with true, the panel never calls its route.
   */
  setAvailable(on: boolean): void {
    if (on === this.available) return
    this.available = on
    if (on) {
      void this.load()
      this.refreshTimer = window.setInterval(() => void this.load(), REFRESH_MS)
    } else {
      this.stopRefresh()
      this.chatShown = false
      this.dropChat()
      this.sync()
    }
  }

  /** The chat went off: forget the adapters, the conversation and the choice, so nothing dead stays on screen. */
  private dropChat(): void {
    this.adapters = []
    this.compareEnabled = false
    this.pendingSlug = null
    this.offers = null
    if (this.sheetMode !== null && !this.sheetBusy) this.closeSheet(false)
    if (this.chosen !== STORY) this.chosen = null
    this.reset()
  }

  /**
   * Puts the story box in the panel. `make` is given the function to call
   * whenever the section starts or stops being shown. The section stays
   * hidden, and asks for nothing, until it is switched on. It shows in the
   * conversation pane when its card on the shelf is chosen.
   */
  attachStory(make: (onChange: () => void) => PanelSection): void {
    if (this.story) return
    this.story = make(() => this.sync())
    this.storySlot.appendChild(this.story.element)
  }

  /**
   * Told by the page what the room's state says about stories from the
   * research loop's kept model. The story box does the rest, and asks for
   * nothing until this is called with true.
   */
  setStoryAvailable(on: boolean): void {
    this.story?.setAvailable(on)
  }

  /**
   * The button is on the page while the chat or the story box is. With
   * neither, the panel is closed and hidden; with only the story box, the
   * chat's own parts are hidden.
   */
  private sync(): void {
    const any = this.chatShown || this.story?.isShown() === true
    if (this.chatShown) this.panel.classList.remove('tc-chat-off')
    else this.panel.classList.add('tc-chat-off')
    if (!any) this.close()
    this.container.style.display = any ? '' : 'none'
    this.panel.style.display = any ? '' : 'none'
    this.renderAll()
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  /**
   * Opens the panel with one adapter chosen, as the practice bench's "talk to
   * it" does. A slug that is not on the shelf is ignored and the shelf shows.
   * Before the list is read, the slug is kept and checked when it arrives.
   */
  openWith(slug: string): void {
    // Neither the chat nor the story box is on: the panel is hidden, and opening it would leave the page inert.
    // The choice is kept, and applied when the list arrives, as before the list was read.
    if (!this.chatShown && this.story?.isShown() !== true) {
      if (SLUG.test(slug)) this.pendingSlug = slug
      return
    }
    if (!this.isOpen) this.returnFocus = (document.activeElement as HTMLElement | null) ?? null
    const loaded = this.chatShown && this.loadState === 'ok'
    if (!SLUG.test(slug) || (loaded && !this.adapters.some(a => a.slug === slug))) {
      this.open()
      return
    }
    if (!loaded) this.pendingSlug = slug
    else this.pick(slug)
    this.open()
    if (this.isOpen && loaded && !this.coarse()) this.input.focus?.()
  }

  /** Chooses an adapter that is on the shelf and shows its conversation. */
  private pick(slug: string): void {
    this.picked = true
    if (this.chosen !== slug) {
      this.chosen = slug
      this.reset()
    }
    this.renderAll(true)
    this.panel.classList.remove('tc-view-shelf')
    this.panel.classList.add('tc-view-chat')
  }

  private coarse(): boolean {
    return window.matchMedia?.('(pointer: coarse)')?.matches === true
  }

  private open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.panel.classList.add('open')
    this.toggle.setAttribute('aria-expanded', 'true')
    void this.load()
    this.story?.refresh()
    this.trapOn()
    // A phone gets focus on the sheet, not the box, so the keyboard does not jump up.
    if (this.coarse()) this.panel.focus?.()
    else if (this.chatShown && this.chosen && this.chosen !== STORY && !this.input.disabled) this.input.focus?.()
    else this.focusFirstCard()
    // A sheet that was open when the panel was closed is still there: its heading takes focus.
    if (this.sheetMode !== null) this.sheetHeading?.focus?.()
    // Nothing to focus (an empty or failed shelf): the sheet itself, so Escape and Tab work from the first key press.
    if (!(this.panel.contains?.(document.activeElement) === true)) this.panel.focus?.()
  }

  private close(): void {
    const wasOpen = this.isOpen
    this.isOpen = false
    this.panel.classList.remove('open')
    this.toggle.setAttribute('aria-expanded', 'false')
    this.trapOff()
    if (wasOpen) {
      const back = this.returnFocus
      this.returnFocus = null
      // Back to what opened the panel, when it is still on the page; else the panel's button.
      if (back && back !== document.body && document.body?.contains?.(back) !== false) back.focus?.()
      else this.toggle.focus?.()
    }
  }

  /** While open: everything else on the page is inert, Tab stays inside, Escape closes, a phone keyboard shrinks the sheet. */
  private trapOn(): void {
    this.trapOff()
    const kids = Array.from(document.body?.children ?? []) as HTMLElement[]
    for (const kid of kids) {
      if (kid === this.panel || kid === this.container || kid.id === 'kg-overlay' || kid.tagName === 'SCRIPT' || kid.tagName === 'STYLE') continue
      if (kid.inert) continue
      kid.inert = true
      this.undoInert.push(() => { kid.inert = false })
    }
    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as Node | null
      const inside = !!target && (this.panel.contains?.(target) === true || target === document.body || target === this.toggle)
      // While the offer sheet is open it holds the keyboard: Escape closes it (not the panel), Tab stays inside it.
      const scope: HTMLElement = this.sheetMode !== null ? this.sheet : this.panel
      if (e.key === 'Escape' && inside) {
        e.preventDefault()
        if (this.sheetMode !== null) {
          if (!this.sheetBusy) this.closeSheet(true)
        } else this.close()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(scope.querySelectorAll(FOCUSABLE) as NodeListOf<HTMLElement>).filter(n => n.getClientRects?.().length)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === scope || active === this.sheetHeading || !scope.contains?.(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !scope.contains?.(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', this.keyHandler)
    const vv = window.visualViewport
    if (vv) {
      this.viewportHandler = () => {
        if (window.matchMedia?.(WIDE)?.matches) {
          this.panel.style.height = `${vv.height}px`
          // With the soft keyboard up there is little room: the conversation keeps the space.
          if (vv.height < 480) this.panel.classList.add('tc-short')
          else this.panel.classList.remove('tc-short')
          this.log.scrollTop = this.log.scrollHeight
        } else {
          this.panel.style.height = ''
          this.panel.classList.remove('tc-short')
        }
      }
      vv.addEventListener('resize', this.viewportHandler)
      this.viewportHandler()
    }
  }

  private trapOff(): void {
    for (const undo of this.undoInert) undo()
    this.undoInert = []
    if (this.keyHandler) document.removeEventListener?.('keydown', this.keyHandler)
    this.keyHandler = null
    if (this.viewportHandler) {
      window.visualViewport?.removeEventListener('resize', this.viewportHandler)
      this.panel.style.height = ''
      this.panel.classList.remove('tc-short')
    }
    this.viewportHandler = null
  }

  private focusFirstCard(): void {
    const first = this.shelf.querySelector?.('button') as HTMLElement | null
    first?.focus?.()
  }

  private reset(): void {
    this.convId++
    this.busy = false
    this.retired = null
    this.held = null
    this.compareDropped = false
    this.tubeOwn.hidden = true
    // A new conversation, or another model: the receipt and the offer belong to the old one.
    this.receipt = null
    this.offered = false
    this.offeredCode = null
    if (this.sheetMode === 'offer' && !this.sheetBusy) this.closeSheet(false)
    this.turns = []
    this.baseReplies = []
    this.serverTurnsLeft = null
    this.compareOn = false
    this.openBlock = null
    this.halfPair = false
    this.log.replaceChildren()
    this.statusLine.textContent = ''
    this.clearBanner()
    this.input.value = ''
    this.input.style.height = ''
  }

  /** Starts a fresh conversation. One that was with a model no longer on the shelf moves on to the first card. */
  private newConversation(): void {
    const gone = this.retired !== null
    this.reset()
    if (gone) this.chosen = null
    this.signature = ''
    this.renderAll(true)
    if (!this.coarse()) this.input.focus?.()
  }

  private clearBanner(): void {
    this.banner.hidden = true
    this.banner.textContent = ''
  }

  /**
   * `sent` is true when the message did reach the model (a busy answer): then
   * the banner does not say it was not sent. A refusal or a lost connection
   * did not send it.
   */
  private showBanner(message: string | null, sent = false): void {
    if (sent) this.banner.textContent = `${message ?? 'No reply came back.'} Your text is still in the box.`
    else this.banner.textContent = `Your message was not sent. ${message ?? 'The lab could not be reached. Check your connection and try again.'}`
    this.banner.hidden = false
  }

  /** Reads what can be talked to. With the chat off, or no backend, the button stays hidden. */
  private async load(): Promise<void> {
    if (!this.available) return
    try {
      const res = await fetch(API, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      const list = parseListResponse(await res.json())
      // The room may have said "off" while the request was out.
      if (!this.available) return
      if (!list.enabled) {
        // The route itself says the chat is off: stop asking. It is asked
        // again only after the room's state has said off and then on again.
        this.stopRefresh()
        this.chatShown = false
        this.dropChat()
        this.sync()
        return
      }
      const before = this.current()
      // The story box was chosen only because nothing else was there yet: a model on the shelf comes first.
      if (this.chosen === STORY && !this.picked && list.adapters.length > 0) this.chosen = null
      this.chatShown = true
      this.loadState = list.unavailable ? 'unavailable' : 'ok'
      this.adapters = list.adapters
      this.limits = list.limits
      this.notice = list.notice
      this.offers = list.offers
      if (!list.offers) this.receipt = null
      this.compareEnabled = list.compareEnabled
      if (!list.compareEnabled && this.compareOn) {
        this.compareOn = false
        this.compareDropped = this.committedTurns() > 0 || this.halfPair
        this.held = null
      }
      if (this.chosen && this.chosen !== STORY && !this.adapters.some(a => a.slug === this.chosen)) {
        if ((this.committedTurns() > 0 || this.busy || this.halfPair) && before) {
          // A conversation is under way: it stays on screen, closed, and the visitor decides what is next.
          this.retired = before
        } else {
          this.chosen = null
          this.reset()
        }
      }
      if (this.pendingSlug) {
        const want = this.pendingSlug
        this.pendingSlug = null
        if (this.adapters.some(a => a.slug === want)) {
          this.sync()
          this.pick(want)
          if (this.isOpen && !this.coarse()) this.input.focus?.()
          return
        }
      }
      this.sync()
    } catch {
      // One failed refresh must not take away a conversation that is on screen.
      if (this.chatShown && this.loadState === 'ok') return
      if (!this.isOpen) {
        this.chatShown = false
        this.sync()
      } else {
        this.loadState = 'error'
        this.renderAll()
      }
    }
  }

  private storyShown(): boolean {
    return this.story?.isShown() === true
  }

  private current(): TrainedAdapterView | null {
    if (!this.chosen || this.chosen === STORY) return null
    return this.adapters.find(a => a.slug === this.chosen) ?? (this.retired?.slug === this.chosen ? this.retired : null)
  }

  /** The conversation is with an adapter that is on the shelf now. */
  private canChat(): boolean {
    return this.chatShown && this.loadState === 'ok' && this.retired === null && this.current() !== null
  }

  private renderAll(force = false): void {
    // The first chosen card: kept first, then newest, as the server lists them.
    if (!this.chatShown) {
      // With the chat off, only the story box can be on screen.
      this.chosen = this.storyShown() ? STORY : null
    } else if (!this.chosen || (this.chosen === STORY && !this.storyShown())) {
      this.chosen = this.adapters[0]?.slug ?? (this.storyShown() ? STORY : null)
    }
    const signature = shelfSignature({
      adapters: this.adapters, story: this.storyShown(), chat: this.chatShown, state: this.loadState,
      compare: this.compareEnabled, limits: this.limits, notice: this.notice,
    }) + `|${this.chosen}|${this.retired?.slug ?? ''}|${this.offers ? `${this.offers.keepDays}/${this.offers.perDay}` : '-'}`
    if (!force && signature === this.signature) return
    this.signature = signature
    this.renderShelf()
    this.renderConversation()
  }

  private renderShelf(): void {
    const activeSlug = (document.activeElement as HTMLElement | null)?.getAttribute?.('data-slug') ?? null
    const sheetFocus = this.shelfSheet.contains?.(document.activeElement) === true
    this.cards.replaceChildren()
    this.shelfSheet.replaceChildren()
    this.shelfFoot.replaceChildren()
    const story = this.storyShown()
    const chat = this.chatShown
    const sheet = (heading: string, paragraphs: string[], retry: boolean) => {
      const box = el('div', 'tc-sheet')
      box.appendChild(el('h2', undefined, heading))
      for (const p of paragraphs) box.appendChild(el('p', undefined, p))
      if (retry) {
        const b = el('button', 'tc-btn', 'Try Again')
        b.type = 'button'
        b.addEventListener('click', () => void this.load())
        box.appendChild(b)
      }
      this.shelfSheet.appendChild(box)
    }
    const failed = chat && this.loadState !== 'ok'
    const empty = chat && !failed && this.adapters.length === 0
    this.panel.classList.remove('tc-full-sheet')
    if (failed) {
      sheet('The Shelf Could Not Be Read', ['Please try again in a moment.'], true)
      if (!story) this.panel.classList.add('tc-full-sheet')
    } else if (empty) {
      sheet(story ? 'No Fine-Tuned Models Right Now' : 'Nothing Is on the Shelf Right Now', [
        'No trained model is on the shelf. The lab\'s models can train small models. When the lab saves one, it appears here.',
      ], false)
      if (!story) {
        const slot = el('div', 'tc-slot', 'Empty Slot')
        slot.setAttribute('aria-hidden', 'true')
        this.shelfSheet.appendChild(slot)
        this.panel.classList.add('tc-full-sheet')
      }
    }
    const list = chat && !failed ? this.adapters : []
    this.shelfHead.style.display = chat && !failed && !empty ? '' : 'none'
    this.shelfCount.textContent = `${list.length} ${list.length === 1 ? 'model' : 'models'}`
    for (const a of list) this.cards.appendChild(this.adapterCard(a))
    if (story) this.cards.appendChild(this.storyCard())
    if (chat) {
      if (this.notice) this.shelfFoot.appendChild(el('p', undefined, this.notice))
      this.shelfFoot.appendChild(el('p', undefined, TUBE_LINE))
      if (this.offers) {
        const back = el('button', 'tc-btn tc-link tc-takeback', TAKE_BACK_OPEN)
        back.type = 'button'
        back.addEventListener('click', () => this.openWithdrawSheet())
        this.shelfFoot.appendChild(back)
      }
    }
    // A redrawn "Try Again" must not drop focus on the page body.
    if (sheetFocus) (this.shelfSheet.querySelector?.('button') as HTMLElement | null)?.focus?.()
    if (activeSlug) {
      const again = Array.from(this.cards.querySelectorAll?.('button') ?? []).find(b => (b as HTMLElement).getAttribute('data-slug') === activeSlug) as HTMLElement | undefined
      again?.focus?.()
    }
  }

  private makerRow(authorName: string): HTMLDivElement {
    const row = el('div', 'tc-maker')
    const swatch = el('span', 'tc-swatch')
    swatch.style.background = accentFor(authorName)
    swatch.setAttribute('aria-hidden', 'true')
    row.append(swatch, el('span', undefined, `Trained by ${authorName}`))
    return row
  }

  private adapterCard(a: TrainedAdapterView): HTMLButtonElement {
    const d = describeAdapter(a)
    const card = el('button', 'tc-card')
    card.type = 'button'
    card.setAttribute('data-slug', a.slug)
    card.setAttribute('aria-pressed', String(a.slug === this.chosen))
    const top = el('div', 'tc-card-top')
    top.appendChild(el('span', a.name ? 'tc-card-title' : 'tc-card-title tc-mono', d.title))
    if (d.mark) top.appendChild(el('span', 'tc-kept', 'Kept'))
    card.appendChild(top)
    card.appendChild(this.makerRow(a.authorName))
    card.appendChild(el('span', 'tc-tag', kindLabel(a)))
    card.appendChild(this.gaugeNode(a))
    card.addEventListener('click', () => this.choose(a.slug))
    return card
  }

  private storyCard(): HTMLButtonElement {
    const card = el('button', 'tc-card')
    card.type = 'button'
    card.setAttribute('data-slug', STORY)
    card.setAttribute('aria-pressed', String(this.chosen === STORY))
    const top = el('div', 'tc-card-top')
    top.appendChild(el('span', 'tc-card-title', 'The Research Loop\'s Story Model'))
    card.appendChild(top)
    card.appendChild(el('div', 'tc-maker', 'Continues a line you write.'))
    card.appendChild(el('div', 'tc-explain', 'A tiny model the research loop trained from scratch. Its score is self-reported.'))
    card.appendChild(el('span', 'tc-tag', kindLabel('story')))
    card.addEventListener('click', () => this.choose(STORY))
    return card
  }

  /** The card of a lesson: up to four skill rows with a before and an after bar, then the overall count and the honest notes. */
  private skillNode(a: TrainedAdapterView): HTMLElement {
    const map = a.skillMap
    if (!map) return el('div', 'tc-gauge', 'No held-out score recorded.')
    const box = el('div', 'tc-gauge tc-skill')
    box.appendChild(el('div', 'tc-gauge-head', 'Pass Bands, Higher Is Better'))
    box.appendChild(el('div', 'tc-skill-key', 'Hatched bar: before. Solid bar: after.'))
    const shown = map.rows.slice(0, 4)
    for (const row of shown) {
      const line = el('div', 'tc-skill-row')
      line.setAttribute('role', 'group')
      line.setAttribute('aria-label', skillSentence(row))
      line.appendChild(el('span', 'tc-skill-name', row.name))
      const bars = el('div', 'tc-skill-bars')
      bars.setAttribute('aria-hidden', 'true')
      for (const [cell, cls] of [[row.before, 'tc-bar tc-hatch'], [row.after, 'tc-bar tc-after']] as const) {
        const track = el('div', 'tc-track')
        const bar = el('div', cls)
        bar.style.width = `${cell ? ((cell.passed / cell.total) * 100).toFixed(1) : '0'}%`
        track.appendChild(bar)
        bars.appendChild(track)
      }
      line.append(bars, el('span', 'tc-skill-band', bandText(row)))
      box.appendChild(line)
    }
    if (map.rows.length > shown.length) box.appendChild(el('div', undefined, `and ${map.rows.length - shown.length} more in Details`))
    const sum = skillSummary(map)
    if (sum) {
      const verdict = el('div', 'tc-verdict')
      verdict.append(el('span', 'tc-verdict-word', sum.verdict), el('span', undefined, sum.text))
      box.appendChild(verdict)
    }
    for (const flag of skillFlags(map)) box.appendChild(el('p', 'tc-skill-flag', flag))
    box.appendChild(el('p', 'tc-explain', `${TUTOR_BANDS_NOTE} ${TUTOR_MEASURE_NOTE}`))
    return box
  }

  private gaugeNode(a: TrainedAdapterView): HTMLElement {
    if (a.kind === 'tutor') return this.skillNode(a)
    const g = gaugeView(a)
    if (g.kind === 'none') return el('div', 'tc-gauge', g.none)
    const box = el('div', 'tc-gauge')
    box.setAttribute('role', 'img')
    box.setAttribute('aria-label', `${g.aria} ${g.verdict}.`)
    const head = el('div', 'tc-gauge-head')
    head.append(el('span', undefined, g.heading), el('span', undefined, `${g.caption} ${g.kind === 'rl' ? '\u2191' : '\u2193'}`))
    box.appendChild(head)
    const beforePct = g.rows[0]?.pct ?? 0
    for (const row of g.rows) {
      const line = el('div', 'tc-gauge-row')
      const track = el('div', 'tc-track')
      const bar = el('div', row.label === 'After' ? 'tc-bar tc-after' : 'tc-bar')
      bar.style.width = `${row.pct.toFixed(1)}%`
      track.appendChild(bar)
      // On the After track, a tick marks where Before was, so the gap is what you see.
      if (row.label === 'After') {
        const tick = el('div', 'tc-tick')
        tick.style.left = `${beforePct.toFixed(1)}%`
        track.appendChild(tick)
      }
      line.append(el('span', undefined, row.label), track, el('span', 'tc-gauge-num', row.text))
      box.appendChild(line)
    }
    const verdict = el('div', 'tc-verdict')
    verdict.append(el('span', 'tc-verdict-word', g.verdict), el('span', undefined, `from ${g.rows[0].text} to ${g.rows[1].text}`))
    box.append(verdict, el('p', 'tc-explain', g.explain))
    return box
  }

  private choose(slug: string): void {
    if (this.chosen !== slug) {
      this.chosen = slug
      this.reset()
    }
    this.pendingSlug = null
    this.picked = true
    this.signature = ''
    this.renderAll(true)
    this.panel.classList.remove('tc-view-shelf')
    this.panel.classList.add('tc-view-chat')
    if (this.coarse()) this.panel.focus?.()
    else if (slug === STORY) (this.storySlot.querySelector?.('input') as HTMLElement | null)?.focus?.()
    else this.input.focus?.()
  }

  private renderConversation(): void {
    const a = this.current()
    const storyChosen = this.chosen === STORY
    if (storyChosen) this.panel.classList.add('tc-story-chosen')
    else this.panel.classList.remove('tc-story-chosen')
    this.whoTitle.replaceChildren()
    this.whoSub.textContent = ''
    this.details.replaceChildren()
    if (storyChosen) {
      this.whoTitle.textContent = 'Story Model'
      this.offerRow.hidden = true
      return
    }
    if (!a || !(this.canChat() || this.retired !== null)) {
      this.whoTitle.textContent = ''
      this.switchNote.hidden = true
      this.switchButton.hidden = true
      this.infoLine.hidden = true
      this.offerRow.hidden = true
      return
    }
    const d = describeAdapter(a)
    const swatch = el('span', 'tc-swatch')
    swatch.style.background = accentFor(a.authorName)
    swatch.setAttribute('aria-hidden', 'true')
    this.whoTitle.append(swatch, el('span', undefined, d.title))
    this.whoSub.textContent = `Trained by ${a.authorName}. Base model ${a.baseModel}.`
    // On a phone the line under the name is hidden, so the details carry it.
    this.details.appendChild(el('p', 'tc-det-maker', `Trained by ${a.authorName}. Base model ${a.baseModel}.`))
    for (const line of [a.purpose, d.origin, d.label, d.score, d.kept]) {
      if (!line) continue
      this.details.appendChild(el('p', undefined, line))
    }
    const ago = trainedAgoText(a.createdAt, Date.now())
    if (ago) this.details.appendChild(el('p', undefined, ago))
    if (a.kind === 'tutor' && a.skillMap) {
      this.details.appendChild(el('p', undefined, `Taught by ${a.skillMap.teacherName}.`))
      for (const row of a.skillMap.rows) this.details.appendChild(el('p', undefined, skillSentence(row)))
      for (const flag of skillFlags(a.skillMap)) this.details.appendChild(el('p', undefined, flag))
      this.details.appendChild(el('p', undefined, `${TUTOR_BANDS_NOTE} ${TUTOR_MEASURE_NOTE}`))
    }
    this.refreshCompare()
    this.refreshForm()
    this.showHint()
  }

  /** The invitation in an empty conversation. */
  private showHint(): void {
    const a = this.current()
    if (!a || this.committedTurns() > 0 || this.openBlock || this.log.querySelector?.('.tc-log-empty') || this.log.querySelector?.('.tc-ex')) return
    this.log.appendChild(el('p', 'tc-log-empty', `Write a message to ${describeAdapter(a).title} below. It answers when you send it.`))
  }

  private committedTurns(): number {
    return this.turns.filter(t => t.role === 'user').length
  }

  private turnsUsed(): number {
    return this.serverTurnsLeft !== null ? Math.max(0, this.limits.maxTurns - this.serverTurnsLeft) : this.committedTurns()
  }

  private refreshCompare(): void {
    const a = this.current()
    const show = this.compareEnabled && a !== null && this.retired === null
    this.switchButton.hidden = !show
    this.switchNote.hidden = !show
    this.refreshInfo()
    if (!show || !a) return
    const locked = this.committedTurns() > 0
    this.switchButton.setAttribute('aria-checked', String(this.compareOn))
    this.switchButton.setAttribute('aria-disabled', String(locked))
    this.switchState.textContent = locked ? `${this.compareOn ? 'On' : 'Off'}, locked` : this.compareOn ? 'On' : 'Off'
    this.switchNote.textContent = locked
      ? 'Locked for this conversation. Start a new one to change it.'
      : 'Also asks the untrained model. Uses 2 messages.'
  }

  /** The one line above the box that explains why the conversation has changed under the visitor. */
  private refreshInfo(): void {
    const text = this.retired !== null ? CLOSED_LINE : this.compareDropped ? COMPARE_DROPPED : ''
    this.infoLine.textContent = text
    this.infoLine.hidden = text === ''
  }

  private flipCompare(): void {
    if (this.busy || this.committedTurns() > 0) return
    this.compareOn = !this.compareOn
    this.compareDropped = false
    this.held = null
    if (this.halfPair) this.discardOpenBlock()
    this.refreshCompare()
    this.refreshForm()
  }

  private discardOpenBlock(): void {
    this.openBlock?.remove()
    this.openBlock = null
    this.halfPair = false
  }

  /** One side of a pair, as a sheet of paper. */
  private sideSheet(a: TrainedAdapterView, title: string, trained: boolean, r: ReplySide, base: string): HTMLElement {
    const label = trained ? `Trained: ${title}` : `Untrained: ${base}`
    return r.ok
      ? this.sheetFor(label, r.reply, { accent: trained ? accentFor(a.authorName) : undefined, untrained: !trained, cut: r.cutShort })
      : this.sheetFor(label, r.message ?? (trained ? 'The trained model did not answer.' : 'The untrained model did not answer. It may not be available.'), { failed: true, untrained: !trained })
  }

  private refreshMeta(): void {
    const limit = this.limits.maxMessageChars
    const length = this.input.value?.length ?? 0
    const show = counterVisible(length, limit)
    this.counter.textContent = show ? `${length} of ${limit}` : ''
    if (length >= limit) this.counter.classList.add('tc-over')
    else this.counter.classList.remove('tc-over')
    this.turnLabel.textContent = turnCounterText(this.turnsUsed(), this.limits.maxTurns)
  }

  private refreshForm(): void {
    const full = this.turnsUsed() >= this.limits.maxTurns
    const ok = this.canChat()
    this.input.maxLength = this.limits.maxMessageChars
    this.input.disabled = this.busy || !ok
    this.send.disabled = this.busy || !ok
    this.send.textContent = this.busy ? 'Sending' : this.compareOn && this.compareEnabled ? 'Ask Both' : 'Send'
    this.newButton.hidden = this.committedTurns() === 0 && !this.halfPair
    this.again.hidden = !this.halfPair
    this.again.disabled = this.busy
    this.form.style.display = full ? 'none' : ''
    this.limitRow.hidden = !full
    this.refreshMeta()
    this.refreshOffer()
  }

  private scrollEnd(): void {
    this.log.scrollTop = this.log.scrollHeight
  }

  private slip(content: string): HTMLElement {
    const wrap = el('div', 'tc-slip')
    wrap.appendChild(el('div', 'tc-who-label', 'You'))
    wrap.appendChild(el('div', 'tc-msg user', content))
    return wrap
  }

  private sheetFor(label: string, content: string, opts: { accent?: string; untrained?: boolean; failed?: boolean; cut?: boolean; wait?: boolean }): HTMLElement {
    const wrap = el('div', opts.untrained ? 'tc-sheet-wrap tc-untrained' : 'tc-sheet-wrap')
    wrap.appendChild(el('div', 'tc-who-label', label))
    const msg = el('div', opts.failed ? 'tc-msg failed' : opts.wait ? 'tc-msg wait' : 'tc-msg assistant', content)
    if (opts.accent && !opts.failed && !opts.wait) msg.style.borderLeftColor = opts.accent
    wrap.appendChild(msg)
    if (opts.cut) wrap.appendChild(el('div', 'tc-fine', 'The reply was cut at its length limit.'))
    return wrap
  }

  private async submit(): Promise<void> {
    const message = this.input.value.trim()
    const a = this.current()
    if (message && !this.busy && !this.canChat()) {
      // The shelf could not be read, or this model has left it: say so, never fail in silence.
      this.showBanner('The chat is not available right now. Try again in a moment.')
      return
    }
    if (!message || this.busy || !a || !this.canChat() || this.committedTurns() >= this.limits.maxTurns) return
    // Asking again after a half pair asks only the side that failed, when the question is unchanged.
    const text1 = message.slice(0, this.limits.maxMessageChars)
    const held = this.halfPair && this.held && this.held.message === text1 ? this.held : null
    if (this.halfPair) this.discardOpenBlock()
    if (!held) this.held = null
    this.clearBanner()
    this.log.querySelector?.('.tc-log-empty')?.remove()
    const compare = this.compareOn && this.compareEnabled
    const only: 'trained' | 'untrained' | null = compare && held ? (held.trained ? 'untrained' : 'trained') : null
    const history: Turn[] = [...this.turns, { role: 'user', content: text1 }]
    const title = describeAdapter(a).title
    const conv = this.convId
    this.busy = true
    const block = el('div', 'tc-ex')
    block.appendChild(this.slip(text1))
    const waitingFor = only === 'untrained' ? `the untrained ${a.baseModel}` : only === 'trained' ? title : compare ? `${title} and the untrained ${a.baseModel}` : title
    block.appendChild(this.sheetFor(
      title,
      `Waiting for ${waitingFor}. The server stops waiting after ${SERVER_WAIT_SECONDS} seconds.`,
      { wait: true },
    ))
    this.log.appendChild(block)
    this.openBlock = block
    this.scrollEnd()
    this.statusLine.textContent = `Waiting for ${waitingFor}`
    this.input.value = ''
    this.input.style.height = ''
    this.refreshForm()
    // Is this still the conversation the question was asked in?
    const current = () => conv === this.convId
    const fail = (why: string | null, sent: boolean) => {
      if (!current()) return
      this.discardOpenBlock()
      this.input.value = message
      this.statusLine.textContent = ''
      this.showBanner(why, sent)
      if (held) {
        // The side that answered stays on screen beside the failure.
        const pair = el('div', 'tc-pair tc-two')
        const failed: ReplySide = { ok: false, message: why }
        pair.append(
          this.sideSheet(a, title, true, only === 'untrained' ? held.trained ?? failed : failed, a.baseModel),
          this.sideSheet(a, title, false, only === 'trained' ? held.untrained ?? failed : failed, a.baseModel),
        )
        const redo = el('div', 'tc-ex')
        redo.append(this.slip(text1), pair, el('div', 'tc-fine', HALF_NOTE))
        this.log.appendChild(redo)
        this.openBlock = redo
        this.halfPair = true
        this.scrollEnd()
      } else this.showHint()
    }
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildChatBody(a.slug, history, compare ? this.baseReplies : null, only, this.offers ? this.receipt : null)),
      })
      const json = await res.json().catch(() => ({}))
      const read = readReply(res.ok, json, compare)
      if (!current()) {
        // The visitor moved on while this was out. The reply is real, so the room still hears it, but it is not drawn here.
        if ((read.kind === 'single') || (read.kind === 'pair' && read.trained.ok && only !== 'untrained')) this.onReply?.(Date.now())
        return
      }
      if (read.kind === 'error') {
        const busy = !res.ok && (json as { error?: unknown } | null)?.error === 'busy'
        fail(read.message, busy)
      } else if (read.kind === 'single') {
        this.turns = [...history, { role: 'assistant', content: read.reply }]
        this.receipt = this.offers ? read.receipt ?? null : null
        this.serverTurnsLeft = read.turnsLeft
        block.replaceChildren(this.slip(text1), this.sheetFor(title, read.reply, { accent: accentFor(a.authorName), cut: read.cutShort }))
        this.openBlock = null
        this.statusLine.textContent = 'Reply received'
        this.noteTube()
        this.onReply?.(Date.now())
      } else {
        // A retry of one side: the other side is the answer held from the first try.
        const trainedSide: ReplySide = only === 'untrained' && held?.trained ? held.trained : read.trained
        const untrainedSide: ReplySide = only === 'trained' && held?.untrained ? held.untrained : read.untrained
        const pair = el('div', 'tc-pair tc-two')
        pair.append(
          this.sideSheet(a, title, true, trainedSide, a.baseModel),
          this.sideSheet(a, title, false, untrainedSide, read.baseModel ?? a.baseModel),
        )
        block.replaceChildren(this.slip(text1), pair)
        if (trainedSide.ok && untrainedSide.ok) {
          this.turns = [...history, { role: 'assistant', content: trainedSide.reply }]
          this.receipt = this.offers ? trainedSide.receipt ?? null : null
          this.baseReplies = [...this.baseReplies, untrainedSide.reply]
          this.serverTurnsLeft = read.turnsLeft
          this.openBlock = null
          this.halfPair = false
          this.held = null
          this.statusLine.textContent = 'Both replies received'
        } else {
          // Only one side answered: its answer stays, nothing is kept in the conversation, and the question can be asked again.
          this.halfPair = true
          this.held = { message: text1, trained: trainedSide.ok ? trainedSide : null, untrained: untrainedSide.ok ? untrainedSide : null }
          this.input.value = message
          block.appendChild(el('div', 'tc-fine', HALF_NOTE))
          this.statusLine.textContent = 'Only one answer came back'
        }
        if (only !== 'untrained' && read.trained.ok) {
          this.noteTube()
          this.onReply?.(Date.now())
        }
      }
    } catch {
      fail(null, false)
    } finally {
      if (current()) {
        this.busy = false
        this.refreshCompare()
        this.refreshForm()
        this.scrollEnd()
        if (this.isOpen && !this.input.disabled && !this.coarse()) this.input.focus?.()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Offering a conversation, and taking an offer back (spec 2.2)
  // -------------------------------------------------------------------------

  /** Shows or hides the offer button, and says why it is disabled. Absent unless the server's GET answered offers. */
  private refreshOffer(): void {
    const show = this.offers !== null && this.chatShown && this.chosen !== STORY && this.canChat()
    this.offerRow.hidden = !show
    if (!show) return
    const ready = canOffer(this.turns, this.receipt) && !this.busy && !this.halfPair
    this.offerButton.textContent = this.offered ? OFFERED_BUTTON : OFFER_BUTTON
    this.offerButton.disabled = this.offered || !ready
    this.offerNote.hidden = this.offered || ready
    this.offerNote.textContent = offerDisabledNote({ turns: this.turns, busy: this.busy, halfPair: this.halfPair })
  }

  /** Opens the sheet over the panel and moves focus to its heading. */
  private showSheet(mode: 'offer' | 'withdraw'): void {
    this.sheetMode = mode
    this.sheetBusy = false
    this.sheet.hidden = false
    if (this.sheetInert.length === 0) {
      for (const part of [this.headBar, this.bodyBox]) {
        part.inert = true
        this.sheetInert.push(() => { part.inert = false })
      }
    }
  }

  /** Closes the sheet and forgets what it held, the take back code included. Focus goes back to the button that opened it. */
  private closeSheet(returnFocus: boolean): void {
    const mode = this.sheetMode
    this.sheetMode = null
    this.sheetBusy = false
    this.sheetToken++
    this.offerCode = null
    this.sheetAlert = null
    this.sheetStatus = null
    this.sheetButtons = []
    this.sheetHeading = null
    this.sheet.hidden = true
    this.sheet.replaceChildren()
    for (const undo of this.sheetInert) undo()
    this.sheetInert = []
    if (!returnFocus || !mode) return
    const opener = mode === 'offer' ? this.offerButton : (this.shelfFoot.querySelector?.('.tc-takeback') as HTMLElement | null)
    opener?.focus?.()
    if (document.activeElement !== opener) this.panel.focus?.()
  }

  /** Builds the sheet's frame: a heading, a scrolling body and a row of actions. Returns the parts to fill. */
  private sheetFrame(title: string): { scroll: HTMLDivElement; actions: HTMLDivElement } {
    this.sheet.replaceChildren()
    const card = el('div', 'tc-offer-card')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    const heading = el('h2', 'tc-offer-title', title)
    heading.id = 'trained-chat-offer-title'
    heading.setAttribute('tabindex', '-1')
    card.setAttribute('aria-labelledby', heading.id)
    const scroll = el('div', 'tc-offer-scroll')
    scroll.appendChild(heading)
    const actions = el('div', 'tc-offer-actions')
    this.sheetAlert = el('p', 'tc-offer-alert')
    this.sheetAlert.setAttribute('role', 'alert')
    this.sheetAlert.hidden = true
    this.sheetStatus = el('p', 'tc-offer-status')
    this.sheetStatus.setAttribute('role', 'status')
    this.sheetStatus.hidden = true
    actions.append(this.sheetAlert, this.sheetStatus)
    card.append(scroll, actions)
    this.sheet.appendChild(card)
    this.sheetHeading = heading
    this.sheetButtons = []
    return { scroll, actions }
  }

  private sheetButton(parent: HTMLElement, label: string, className: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', className, label)
    b.type = 'button'
    b.addEventListener('click', onClick)
    parent.appendChild(b)
    this.sheetButtons.push(b)
    return b
  }

  private setSheetBusy(busy: boolean, go?: HTMLButtonElement, label?: string, busyLabel?: string): void {
    this.sheetBusy = busy
    for (const b of this.sheetButtons) b.disabled = busy
    if (go && label && busyLabel) go.textContent = busy ? busyLabel : label
  }

  private showSheetAlert(message: string): void {
    if (!this.sheetAlert) return
    this.sheetAlert.textContent = message
    this.sheetAlert.hidden = false
  }

  private showSheetStatus(message: string): void {
    if (!this.sheetStatus) return
    this.sheetStatus.textContent = message
    this.sheetStatus.hidden = false
  }

  /** The consent text and the exact conversation, with "Offer It" and "Not Now". */
  private openOfferSheet(): void {
    const a = this.current()
    if (!this.offers || !a || !this.receipt || !canOffer(this.turns, this.receipt) || this.offered) return
    this.showSheet('offer')
    const { scroll, actions } = this.sheetFrame(OFFER_HEADING)
    for (const paragraph of consentParagraphs(this.offers.keepDays)) scroll.appendChild(el('p', undefined, paragraph))
    scroll.appendChild(el('p', 'tc-offer-label', OFFER_PREVIEW_LABEL))
    if (this.compareOn) scroll.appendChild(el('p', undefined, 'Only the trained model\'s side is offered. The untrained answers are not part of it.'))
    const conv = el('div', 'tc-offer-conv')
    conv.setAttribute('role', 'region')
    conv.setAttribute('aria-label', 'The conversation that would be stored')
    conv.setAttribute('tabindex', '0')
    const title = describeAdapter(a).title
    for (const t of this.turns) {
      const turn = el('div', 'tc-offer-turn')
      turn.append(el('div', 'tc-who-label', t.role === 'user' ? 'You' : title), el('div', 'tc-offer-turn-text', t.content))
      conv.appendChild(turn)
    }
    scroll.appendChild(conv)
    const go = this.sheetButton(actions, OFFER_SUBMIT, 'tc-offer-go', () => void this.sendOffer(go))
    this.sheetButton(actions, OFFER_CANCEL, 'tc-btn', () => this.closeSheet(true))
    this.sheetHeading?.focus?.()
  }

  private async sendOffer(go: HTMLButtonElement): Promise<void> {
    const a = this.current()
    const receipt = this.receipt
    if (this.sheetBusy || this.sheetMode !== 'offer' || !a || !receipt) return
    if (this.sheetAlert) this.sheetAlert.hidden = true
    this.setSheetBusy(true, go, OFFER_SUBMIT, OFFER_SENDING)
    const token = ++this.sheetToken
    // The conversation this offer is for: if the visitor moved to another one meanwhile, the answer still shows its code, but marks nothing on the new one.
    const conv = this.convId
    let answer: ReturnType<typeof readOfferAnswer>
    try {
      const res = await fetch(OFFER_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildOfferBody(a.slug, this.turns, receipt)),
      })
      answer = readOfferAnswer(res.status, await res.json().catch(() => ({})))
    } catch {
      answer = { kind: 'refused', status: 0, error: 'unavailable', message: OFFER_UNREACHED }
    }
    if (token !== this.sheetToken || this.sheetMode !== 'offer') return
    this.sheetBusy = false
    if (answer.kind === 'stored') {
      if (conv === this.convId) this.offered = true
      // Kept with the conversation, so that a take back with this code can put the button back.
      if (conv === this.convId) this.offeredCode = normalizeCode(answer.code) ?? answer.code
      this.offerCode = answer.code
      this.showStored(answer.code, answer.keptUntil, answer.message)
      this.refreshOffer()
      return
    }
    this.setSheetBusy(false, go, OFFER_SUBMIT, OFFER_SENDING)
    // The lab cannot verify this conversation any more: the button says so, and the receipt is let go.
    if (answer.error === 'not_verified' && conv === this.convId) this.receipt = null
    // The lab already holds this conversation: it cannot be offered a second time.
    if (answer.error === 'already_offered' && conv === this.convId) this.offered = true
    this.showSheetAlert(answer.message)
    this.refreshOffer()
  }

  /** After a 201: the code, shown once, with Copy Code, Take It Back and Done. */
  private showStored(code: string, keptUntil: string | null, message: string): void {
    const { scroll, actions } = this.sheetFrame(OFFER_HEADING)
    scroll.appendChild(el('p', undefined, message === OFFER_THANKS ? message : `${OFFER_THANKS} ${message}`.trim()))
    scroll.appendChild(el('p', undefined, 'Your code to take it back:'))
    const shown = el('div', 'tc-offer-code', code)
    shown.setAttribute('aria-label', `Your take back code: ${code.split('').join(' ')}`)
    scroll.appendChild(shown)
    scroll.appendChild(el('p', undefined, 'Keep it. The lab cannot show it again.'))
    if (keptUntil) scroll.appendChild(el('p', undefined, `The lab keeps the conversation until ${formatDay(keptUntil.slice(0, 10))}.`))
    this.sheetButton(actions, OFFER_COPY, 'tc-btn', () => void this.copyCode())
    const back = this.sheetButton(actions, OFFER_TAKE_BACK, 'tc-btn', () => void this.sendWithdraw(code, back))
    this.sheetButton(actions, OFFER_DONE, 'tc-offer-go', () => this.closeSheet(true))
    this.sheetHeading?.focus?.()
  }

  private async copyCode(): Promise<void> {
    const code = this.offerCode
    if (!code) return
    try {
      const clip = globalThis.navigator?.clipboard
      if (!clip?.writeText) throw new Error('no clipboard')
      await clip.writeText(code)
      this.showSheetStatus(OFFER_COPIED)
    } catch {
      this.showSheetStatus(OFFER_COPY_FAILED)
    }
  }

  /** The one field form, from the shelf's footer. */
  private openWithdrawSheet(): void {
    if (!this.offers) return
    this.showSheet('withdraw')
    const { scroll, actions } = this.sheetFrame(TAKE_BACK_HEADING)
    scroll.appendChild(el('p', undefined, TAKE_BACK_HELP))
    const form = el('form', 'tc-offer-form')
    const label = el('label', 'tc-offer-label', TAKE_BACK_LABEL)
    const input = el('input', 'tc-code-input')
    input.type = 'text'
    input.id = 'trained-chat-take-back'
    label.setAttribute('for', input.id)
    input.maxLength = 24
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('autocapitalize', 'characters')
    input.setAttribute('aria-describedby', 'trained-chat-offer-title')
    input.placeholder = 'XXXX-XXXX-XXXX'
    form.style.display = 'flex'
    form.style.flexDirection = 'column'
    form.style.gap = '6px'
    form.append(label, input)
    scroll.appendChild(form)
    const go = this.sheetButton(actions, OFFER_TAKE_BACK, 'tc-offer-go', () => void submitCode())
    this.sheetButton(actions, OFFER_CANCEL, 'tc-btn', () => this.closeSheet(true))
    const submitCode = async () => {
      if (this.sheetAlert) this.sheetAlert.hidden = true
      const code = normalizeCode(input.value ?? '')
      if (!code) {
        this.showSheetAlert(TAKE_BACK_BAD_CODE)
        input.focus?.()
        return
      }
      await this.sendWithdraw(code, go)
    }
    form.addEventListener('submit', e => {
      e.preventDefault()
      void submitCode()
    })
    this.sheetHeading?.focus?.()
  }

  private async sendWithdraw(code: string, go: HTMLButtonElement): Promise<void> {
    if (this.sheetBusy || this.sheetMode === null) return
    const mode = this.sheetMode
    if (this.sheetAlert) this.sheetAlert.hidden = true
    this.setSheetBusy(true, go, OFFER_TAKE_BACK, OFFER_TAKING_BACK)
    const token = ++this.sheetToken
    let answer: ReturnType<typeof readWithdrawAnswer>
    try {
      const res = await fetch(OFFER_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildWithdrawBody(code)),
      })
      answer = readWithdrawAnswer(res.status, await res.json().catch(() => ({})))
    } catch {
      answer = { kind: 'refused', status: 0, error: 'unavailable', message: 'The lab could not be reached. Try again in a moment.' }
    }
    // The take back went through for the code of the conversation on screen: the lab no longer holds it, so its button
    // goes back to its normal state, whether or not the sheet that asked is still open. A code that belongs to some
    // other conversation (typed, or from an offer made before the visitor moved on) changes nothing on screen.
    if (answer.kind !== 'refused' && this.offeredCode !== null && (normalizeCode(code) ?? code) === this.offeredCode) {
      this.offered = false
      this.offeredCode = null
      this.refreshOffer()
    }
    if (token !== this.sheetToken || this.sheetMode !== mode) return
    this.sheetBusy = false
    if (answer.kind === 'refused') {
      this.setSheetBusy(false, go, OFFER_TAKE_BACK, OFFER_TAKING_BACK)
      this.showSheetAlert(answer.message)
      return
    }
    this.offerCode = null
    const { scroll, actions } = this.sheetFrame(mode === 'offer' ? OFFER_HEADING : TAKE_BACK_HEADING)
    scroll.appendChild(el('p', undefined, answer.message))
    this.sheetButton(actions, OFFER_DONE, 'tc-offer-go', () => this.closeSheet(true))
    this.sheetHeading?.focus?.()
  }

  /** The visitor's own reply really arrived, so the room's tube was told: say so, once, in the conversation's foot. */
  private noteTube(): void {
    this.tubeOwn.textContent = OWN_TUBE_LINE
    this.tubeOwn.hidden = false
  }
}
