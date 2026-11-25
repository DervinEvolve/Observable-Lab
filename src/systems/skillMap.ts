import type { Cell, CutOffCount, LessonAnswer, LessonQuestions, LessonRecord, PublicLesson, PublicLessonExchange, PublicLessonSubskill, TutorLesson } from '../shared/types'
import { NO_EXPERIMENT, plain } from './practiceBench'

// The skill map chart (src/entities/SkillMapChart.ts) and the lesson panel
// (src/systems/LessonPanel.ts) are drawn from the stored record of the newest
// Socratic lesson (docs/TOOLS.md, "Tinker tutor"), which comes on
// GET /api/experiment as `tutor_lesson` (api/_lib/tinker-tutor-public.ts) and,
// for the panel, on GET /api/experiment/lesson?slug=.
//
// Everything here is pure. It reads the record strictly: a record that is not
// well formed in any part leaves the chart dark and the panel empty, because a
// half read record could show a number the lab never stored. Nothing is
// invented, and nothing is worded as mastery: a pass band is only the share of
// held back answers that passed, as the lab counted it.

/** The lab's own note on what is counted and what is opinion. The same words as api/_lib/tinker-tutor.ts. */
export const TUTOR_MEASURE_NOTE = 'The lab counts which answers pass. The rules, the questions and the teaching text were written by models, and a model approved the rules. Nobody has checked that the rules measure the skill.'
export const BANDS_NOTE = 'Pass bands come from questions held back from teaching.'
export const NO_LESSON = 'No lesson has been taught yet.'
export const CHART_FOOT = 'Held back questions only. Rules written by a model. Counted by the lab.'
export const MEASURED_BY = 'counted by the lab, with rules a model wrote, on questions held back from teaching'
export const ORIGIN_MODELS = 'written by the models'

export const MAX_SUBSKILLS = 10
export const MAX_EXCHANGES = 3

const SLUG = /^e[0-9]{1,6}-[0-9a-f]{8}$/
const STATUSES = ['running', 'ok', 'ended', 'failed', 'error'] as const
const STAGES = ['diagnostic', 'teaching', 'training', 'retest', 'closing', 'done'] as const

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const whole = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The pass band of 1.6 in the spec: from the share of answers that passed, and nothing else. */
export function bandOf(passed: number, total: number): number | null {
  if (!(total > 0)) return null
  const s = passed / total
  if (s === 0) return 0
  if (s < 0.25) return 1
  if (s < 0.5) return 2
  if (s < 0.75) return 3
  if (s < 1) return 4
  return 5
}

class Malformed extends Error {}
const bad = (): never => { throw new Malformed() }

/** A cell, or null when the record says there is none yet. Anything else that is not a whole, consistent cell is malformed. */
function readCell(raw: unknown): Cell | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) return bad()
  const passed = whole(raw.passed, 0, 100000)
  const total = whole(raw.total, 1, 100000)
  const band = whole(raw.band, 0, 5)
  if (passed === null || total === null || band === null || passed > total || bandOf(passed, total) !== band) return bad()
  return { passed, total, band }
}

function readPair(raw: unknown): { passed: number; total: number } | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) return bad()
  const passed = whole(raw.passed, 0, 100000)
  const total = whole(raw.total, 1, 100000)
  if (passed === null || total === null || passed > total) return bad()
  return { passed, total }
}

const text = (v: unknown, max: number): string => plain(v, max) ?? bad()
const maybeText = (v: unknown, max: number): string | null => (v === null || v === undefined ? null : text(v, max))
const count = (v: unknown, hi = 100000): number => whole(v, 0, hi) ?? bad()
const flag = (v: unknown): boolean => (typeof v === 'boolean' ? v : bad())
const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : bad())

function readSubskill(raw: unknown): PublicLessonSubskill {
  const r = obj(raw)
  return {
    name: text(r.name, 40),
    before: readCell(r.before),
    after: readCell(r.after),
    seen_before: readPair(r.seen_before),
    seen_after: readPair(r.seen_after),
    seen_only: flag(r.seen_only),
    got_worse: flag(r.got_worse),
  }
}

function readExchange(raw: unknown): PublicLessonExchange {
  const r = obj(raw)
  return {
    subskill: text(r.subskill, 40),
    question: text(r.question, 300),
    wrong: plain(r.wrong, 300) ?? '',
    guide: text(r.guide, 300),
    reply: plain(r.reply, 300) ?? '',
    answer: plain(r.answer, 300) ?? '',
    passed: flag(r.passed),
  }
}

function readLessonStrict(rawIn: unknown): PublicLesson {
  const r = obj(rawIn)
  const slug = typeof r.slug === 'string' && SLUG.test(r.slug) ? r.slug : bad()
  if (r.kind !== 'tutor') bad()
  const status = STATUSES.find(s => s === r.status) ?? bad()
  const stage = STAGES.find(s => s === r.stage) ?? bad()
  const round = whole(r.round, 1, 2) ?? bad()
  const rounds = whole(r.rounds, 1, 2) ?? bad()
  if (round > rounds) bad()
  const q = obj(r.questions)
  const subskills = Array.isArray(r.subskills) && r.subskills.length <= MAX_SUBSKILLS ? (r.subskills as unknown[]) : bad()
  const overall = obj(r.overall)
  let progress: PublicLesson['progress'] = null
  if (r.progress !== null && r.progress !== undefined) {
    const p = obj(r.progress)
    progress = { graded: count(p.graded), to_grade: count(p.to_grade), taught: count(p.taught), to_teach: count(p.to_teach), seq: count(p.seq, 1e9), updated_at: text(p.updated_at, 40) }
  }
  let teaching: PublicLesson['teaching'] = null
  if (r.teaching !== null && r.teaching !== undefined) {
    const t = obj(r.teaching)
    teaching = { missed: count(t.missed), taught: count(t.taught), solved: count(t.solved), explained: count(t.explained), teacher_failed: count(t.teacher_failed), leaked: count(t.leaked), not_taught: count(t.not_taught), teacher_calls: count(t.teacher_calls), cut_off: t.cut_off === undefined || t.cut_off === null ? 0 : count(t.cut_off) }
  }
  let examples: PublicLesson['examples'] = null
  if (r.examples !== null && r.examples !== undefined) {
    const e = obj(r.examples)
    examples = { kept: count(e.kept), guided: count(e.guided), answer: count(e.answer), explained: count(e.explained), left_out: count(e.left_out), total: count(e.total) }
  }
  let training: PublicLesson['training'] = null
  if (r.training !== null && r.training !== undefined) {
    const t = obj(r.training)
    const loss = (v: unknown): number | null => (v === null || v === undefined ? null : finite(v) ?? bad())
    const steps = (v: unknown): number | null => (v === null || v === undefined ? null : count(v, 100000))
    training = { steps_done: steps(t.steps_done), steps_planned: steps(t.steps_planned), holdout_loss_before: loss(t.holdout_loss_before), holdout_loss_after: loss(t.holdout_loss_after) }
  }
  const f = obj(r.flags)
  const names = (v: unknown, n: number): string[] => (Array.isArray(v) && v.length <= 20 ? v.map(x => text(x, n)) : bad())
  const c = obj(r.cost)
  const money = (v: unknown): number | null => (v === null || v === undefined ? null : (finite(v) !== null && (v as number) >= 0 ? (v as number) : bad()))
  const exchanges = Array.isArray(r.exchanges) && r.exchanges.length <= MAX_EXCHANGES ? r.exchanges.map(readExchange) : bad()
  if (r.measured_by !== MEASURED_BY || r.origin !== ORIGIN_MODELS) bad()
  const lesson: PublicLesson = {
    slug,
    adapter: `lab/${slug}`,
    kind: 'tutor',
    epoch: count(r.epoch, 1_000_000),
    author_model: text(r.author_model, 80),
    author_name: text(r.author_name, 60),
    teacher_model: text(r.teacher_model, 80),
    teacher_name: text(r.teacher_name, 60),
    base_model: text(r.base_model, 80),
    topic: text(r.topic, 48),
    purpose: maybeText(r.purpose, 200),
    status,
    stage,
    round,
    rounds,
    live: flag(r.live),
    questions: { practice: count(q.practice, 1000), held_back: count(q.held_back, 1000), samples: whole(q.samples, 1, 10) ?? bad() },
    subskills: subskills.map(readSubskill),
    overall: { before: readCell(overall.before), after: readCell(overall.after) },
    progress,
    teaching,
    examples,
    training,
    flags: {
      seen_only: flag(f.seen_only),
      too_easy: flag(f.too_easy),
      unanswered: count(f.unanswered),
      cut_short_before: flag(f.cut_short_before),
      rubric_literal: names(f.rubric_literal, 40),
      shared_literals: names(f.shared_literals, 40),
      shared_answers: readSharedAnswers(f.shared_answers),
      within_noise: flag(f.within_noise),
      reasons: names(f.reasons, 300),
      cut_off_fell: f.cut_off_fell === true,
      cut_off: readCutOff(f.cut_off),
    },
    exchanges,
    cost: {
      tinker_estimated_usd: money(c.tinker_estimated_usd),
      tinker_max_usd: money(c.tinker_max_usd) ?? bad(),
      teacher_usd: money(c.teacher_usd) ?? bad(),
      teacher_max_usd: money(c.teacher_max_usd) ?? bad(),
      basis: plain(c.basis, 200) ?? 'an estimate, not a billed amount',
    },
    measured_by: MEASURED_BY,
    origin: ORIGIN_MODELS,
    created_at: text(r.created_at, 40),
    finished_at: maybeText(r.finished_at, 40),
    reason: plain(r.reason, 300),
  }
  const name = plain(r.name, 40)
  if (name) lesson.name = name
  // the chat id is taken only in its exact form; anything else is ignored, never trusted
  if (r.talk === `lab/${slug}`) lesson.talk = r.talk
  const kept = plain(r.kept_until, 40)
  if (kept && Number.isFinite(Date.parse(kept))) lesson.kept_until = kept
  return lesson
}

/** One lesson as the state sends it. Null when any part of it is malformed. */
export function readLesson(raw: unknown): PublicLesson | null {
  try { return readLessonStrict(raw) } catch (e) { if (e instanceof Malformed) return null; throw e }
}

export interface TutorLessonState { enabled: boolean; offReason: string | null; lesson: PublicLesson | null }

/** The `tutor_lesson` part of the state, strictly read. Anything that is not well formed gives a lesson of null (a dark chart). */
export function parseTutorLesson(raw: unknown): TutorLessonState | null {
  if (!isObject(raw)) return null
  const r = raw as Partial<TutorLesson> & Record<string, unknown>
  return { enabled: r.enabled === true, offReason: plain(r.off_reason, 300), lesson: r.lesson === null || r.lesson === undefined ? null : readLesson(r.lesson) }
}

/** GET /api/experiment/lesson?slug=: the lesson plus one list of rule lines a subskill. Null when malformed. */
export function readLessonRecord(raw: unknown): LessonRecord | null {
  const lesson = readLesson(raw)
  if (!lesson || !isObject(raw)) return null
  const rubrics = raw.rubrics
  if (!Array.isArray(rubrics) || rubrics.length > MAX_SUBSKILLS) return null
  const lists: string[][] = []
  for (const list of rubrics) {
    if (!Array.isArray(list) || list.length > 12) return null
    const lines: string[] = []
    for (const line of list) {
      const t = plain(line, 300)
      if (t === null) return null
      lines.push(t)
    }
    lists.push(lines)
  }
  return { ...lesson, rubrics: lists }
}

/** GET /api/experiment/lesson?slug=&subskill=: that subskill's questions. Null when malformed. */
export function readLessonQuestions(raw: unknown): LessonQuestions | null {
  try {
    const r = obj(raw)
    const list = Array.isArray(r.questions) && r.questions.length <= 50 ? (r.questions as unknown[]) : bad()
    const answers = (v: unknown): LessonAnswer[] => {
      if (!Array.isArray(v) || v.length > 10) return bad()
      return v.map(a => { const x = obj(a); return { text: plain(x.text, 300) ?? '', passed: flag(x.passed), cut_short: x.cut_short === true, empty: x.empty === true } })
    }
    return {
      questions: list.map(q => {
        const x = obj(q)
        const a = obj(x.answers)
        if (!Array.isArray(x.turns) || x.turns.length > 6) bad()
        return {
          held_back: flag(x.held_back),
          prompt: text(x.prompt, 400),
          answers: { before: answers(a.before), after: answers(a.after) },
          turns: (x.turns as unknown[]).map(t => {
            const y = obj(t)
            const kind = y.kind === 'guide' || y.kind === 'explain' ? y.kind : bad()
            return {
              kind, state: plain(y.state, 24) ?? '', teacher: plain(y.teacher, 400) ?? '', reply: plain(y.reply, 300) ?? '', answer: plain(y.answer, 300) ?? '', passed: flag(y.passed),
              reply_cut_short: y.reply_cut_short === true, answer_cut_short: y.answer_cut_short === true,
            }
          }),
        }
      }),
    }
  } catch (e) {
    if (e instanceof Malformed) return null
    throw e
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The answers that passed, then the band. Counts first, band second. */
export function cellText(label: string, cell: Cell | null): string {
  if (!cell) return `${label}: not measured yet.`
  return `${label}: ${cell.passed} of ${cell.total} answers passed. Pass band ${cell.band} of 5.`
}

/** "2 to 4", "2" while only the first test exists, or null with none. */
export function bandsText(before: Cell | null, after: Cell | null): string | null {
  if (before && after) return `${before.band} to ${after.band}`
  if (before) return String(before.band)
  if (after) return `After ${after.band}`
  return null
}

/** A change smaller than one pass band is within noise: with six answers one answer can move a count. */
export function withinNoise(before: Cell | null, after: Cell | null): boolean {
  return Boolean(before && after && before.band === after.band)
}

/** The share of answers that passed, 0 to 1, for a bar. */
export function share(cell: Cell | null): number | null {
  return cell ? cell.passed / cell.total : null
}

/** A reason as a sentence. */
function sentence(t: string): string {
  const s = t.trim()
  if (!s) return ''
  const up = s.charAt(0).toUpperCase() + s.slice(1)
  return /[.!?]$/.test(up) ? up : `${up}.`
}

/** "Epoch 41. Written by Claude Fable 5.2. Taught by Grok 4.7. Student: Qwen/Qwen3.5-4B." */
export function headLine(l: PublicLesson): string {
  return `Epoch ${l.epoch}. Written by ${l.author_name}. Taught by ${l.teacher_name}. Student: ${l.base_model}.`
}

/** Where the lesson stands, in words, from the stored record only. */
export function stageLine(l: PublicLesson): string {
  const p = l.progress
  const graded = p ? ` ${p.graded} of ${p.to_grade} answers graded.` : ''
  const reason = l.reason ? ` ${sentence(l.reason)}` : ''
  if (l.status === 'ok') return 'Finished. Pass bands come from questions held back from teaching.'
  if (l.status === 'ended') return `Finished without training.${reason}`
  if (l.status === 'failed' || l.status === 'error') return `The lesson stopped.${reason}`
  switch (l.stage) {
    case 'diagnostic': return `Testing the untrained model.${graded}`
    case 'teaching': return `Teaching.${p ? ` ${p.taught} of ${p.to_teach} missed questions done.` : ''}`
    case 'training': return 'Training on the lesson.'
    case 'retest': return `Testing the trained model.${graded}`
    default: return 'Finishing the lesson.'
  }
}

// ---------------------------------------------------------------------------
// What the chart shows
// ---------------------------------------------------------------------------

export type ChartMode = 'dark' | 'diagnostic' | 'teaching' | 'training' | 'retest' | 'closing' | 'ok' | 'ended' | 'failed'

export interface ChartRow {
  name: string
  before: Cell | null
  after: Cell | null
  seenOnly: boolean
  bands: string | null
}

export interface ChartView {
  mode: ChartMode
  /** The topic, or the blank sheet's words. */
  title: string
  byline: string | null
  rows: ChartRow[]
  stageLine: string
  /** A corner note while the finished lesson is flagged. */
  flagNote: string | null
  /** The lamp is lit and steady only while the lab has heard from the lesson recently. */
  lamp: boolean
  /** Changes when, and only when, something the paper shows changes: the paper is redrawn on it. */
  key: string
}

const DARK_VIEW = (title: string): ChartView => ({ mode: 'dark', title, byline: null, rows: [], stageLine: '', flagNote: null, lamp: false, key: `dark|${title}` })

/** Cut off and empty answer counts of one test, or null when absent or malformed (older records have none). */
function readCutOff(raw: unknown): { before: CutOffCount | null; after: CutOffCount | null } {
  const one = (v: unknown): CutOffCount | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    const cut = whole(o.cut, 0, 100000), empty = whole(o.empty, 0, 100000), graded = whole(o.graded, 1, 100000)
    return cut !== null && empty !== null && graded !== null && cut + empty <= graded ? { cut, empty, graded } : null
  }
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return { before: one(o.before), after: one(o.after) }
}

/**
 * Per subskill, the held back questions that expect a value a practice question also expects (the lab accepts such a
 * lesson and flags it). A record made before the lab counted this has no such field, and anything malformed is left out: empty.
 */
function readSharedAnswers(raw: unknown): PublicLesson['flags']['shared_answers'] {
  if (!Array.isArray(raw)) return []
  const out: PublicLesson['flags']['shared_answers'] = []
  for (const v of raw.slice(0, MAX_SUBSKILLS)) {
    if (!isObject(v)) continue
    const name = plain(v.name, 40), of = whole(v.of, 1, 1000)
    const shared = of === null ? null : whole(v.shared, 1, of)
    if (name !== null && of !== null && shared !== null) out.push({ name, shared, of })
  }
  return out
}

/** The finished chart's corner note: the flags a visitor most needs, in one line (every reason is in the panel). */
export function flagNoteOf(l: Pick<PublicLesson, 'flags'>): string | null {
  // One line on the paper, so the two together are said shortly; the panel has every reason in full.
  // "Many" is said only when the lab flagged many (cut_short_before). Fewer cut off answers after training can be a
  // single answer: it has its own, weaker line, and never takes the place of the within noise note.
  const seen = l.flags.seen_only
  const many = l.flags.cut_short_before
  const fell = l.flags.cut_off_fell
  if (seen && (many || fell)) return 'Flag: better only on questions seen in teaching, and cut off answers.'
  if (seen) return 'Flag: better only on questions seen in teaching.'
  if (many) return 'Flag: many answers were cut off by the token limit.'
  if (l.flags.within_noise) return 'Within noise: the change is smaller than one pass band.'
  if (fell) return 'Flag: fewer answers were cut off after training.'
  // Last, so it never takes the place of a note above: the lab accepted held back questions that expect a value a practice question also expects.
  if (l.flags.shared_answers.length) return 'Flag: some held back questions share an answer with practice.'
  return null
}

/** How a graded answer is marked in the panel: passed, or did not pass with how it ended when the lab stored that. */
export function answerMark(a: Pick<LessonAnswer, 'passed' | 'cut_short' | 'empty'>): string {
  if (a.passed) return 'Passed'
  if (a.cut_short) return 'Did not pass. Cut off by the token limit'
  if (a.empty) return 'Did not pass. No answer text'
  return 'Did not pass'
}

/**
 * The line under the chart's title. The title and the row names are text a
 * model wrote, drawn beside counts the lab made, so the line says whose words
 * they are.
 */
export function chartByline(l: Pick<PublicLesson, 'author_name' | 'teacher_name' | 'epoch'>): string {
  const who = l.author_name === l.teacher_name
    ? `Topic and row names by ${l.author_name}, who also taught.`
    : `Topic and row names by ${l.author_name}. Taught by ${l.teacher_name}.`
  return `${who} Epoch ${l.epoch}.`
}

/** What the paper and the lamp show. No lesson, or no experiment connected: a blank sheet and a dark lamp. */
export function chartView(state: TutorLessonState | null, simulation: boolean): ChartView {
  if (simulation) return DARK_VIEW(`${NO_EXPERIMENT}.`)
  const l = state?.lesson ?? null
  if (!l) return DARK_VIEW(NO_LESSON)
  const mode: ChartMode = l.status === 'ok' ? 'ok'
    : l.status === 'ended' ? 'ended'
    : l.status === 'failed' || l.status === 'error' ? 'failed'
    : l.stage === 'done' ? 'closing'
    : l.stage
  const rows: ChartRow[] = l.subskills.slice(0, MAX_SUBSKILLS).map(s => ({
    name: s.name, before: s.before, after: s.after, seenOnly: s.seen_only, bands: bandsText(s.before, s.after),
  }))
  const view: ChartView = {
    mode,
    title: l.topic,
    byline: chartByline(l),
    rows,
    stageLine: stageLine(l),
    flagNote: l.status === 'ok' ? flagNoteOf(l) : null,
    lamp: l.status === 'running' && l.live,
    key: '',
  }
  view.key = JSON.stringify([view.mode, view.title, view.byline, view.rows, view.stageLine, view.flagNote, view.lamp, l.progress?.seq ?? null])
  return view
}

/** The ticks on a bar's scale: six, from none passed to all passed. */
export const BAR_TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const

// ---------------------------------------------------------------------------
// Where the chart hangs, and where the camera looks when it is shown
// ---------------------------------------------------------------------------

/** The chart's paper is 0.94 by 0.5875 m inside a frame of about 1.0 by 0.65 m; its lower edge is 0.12 m above the bench's back board. */
export const CHART_CENTER_Y = 1.93
/** The camera target's height when the visitor looks at the bench: the chart hangs above the bench's own instruments. */
export const CHART_TARGET_Y = 1.45

/** The bench's camera view with its target lifted so the chart is inside it. */
export function lessonCameraView(view: { position: [number, number, number]; target: [number, number, number] }): { position: [number, number, number]; target: [number, number, number] } {
  return { position: [...view.position], target: [view.target[0], CHART_TARGET_Y, view.target[2]] }
}
