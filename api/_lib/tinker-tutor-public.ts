/**
 * The public record of the Socratic lesson: `tutor_lesson` on GET
 * /api/experiment (tutorLesson), and the full record of one lesson on GET
 * /api/experiment/lesson (lessonRecordBySlug, lessonQuestionsBySlug).
 *
 * Built from stored rows only: the run row, the lesson row, and the graded
 * answers and turns the worker stored. It never calls the runner or a model.
 * There is no checkpoint path, no split salt and no call id in it, and every
 * text in it is cleaned and cut on the server.
 */
import { describeRubric } from './rubric.js'
import { TINKER_PRICE_TABLE_DATE, isAdapterSlug, trainedChatStatus } from './tinker.js'
import { ORIGIN_MODELS, getRun, shownName, type TinkerRunRow } from './tinker-store.js'
import {
  TUTOR_EXPLAIN_SHOWN_BYTES, TUTOR_LIVE_MS, TUTOR_MAX_REASONS, TUTOR_MEASURED_BY, TUTOR_SAMPLES, TUTOR_SUBSKILLS, allQuestions, missesToTeach, modelName, publicCut, tinkerTutorStatus,
  type Cell, type CutOff, type TinkerTutorRequest,
} from './tinker-tutor.js'
import { summarizeLesson } from './tinker-tutor-run.js'
import { answerMarks, getLessonRow, latestLessonSlug, loadTurns, subskillAnswers, type AnswerRow, type LessonRow, type TurnRow } from './tutor-store.js'

export type { Cell } from './tinker-tutor.js'

type Count = { passed: number; total: number }

export interface PublicLesson {
  slug: string
  adapter: string
  kind: 'tutor'
  epoch: number
  author_model: string
  author_name: string
  teacher_model: string
  teacher_name: string
  base_model: string
  topic: string
  purpose: string | null
  name?: string
  status: 'running' | 'ok' | 'ended' | 'failed' | 'error'
  stage: 'diagnostic' | 'teaching' | 'training' | 'retest' | 'closing' | 'done'
  round: number
  rounds: number
  live: boolean
  questions: { practice: number; held_back: number; samples: number }
  subskills: Array<{ name: string; before: Cell | null; after: Cell | null; seen_before: Count | null; seen_after: Count | null; seen_only: boolean; got_worse: boolean }>
  overall: { before: Cell | null; after: Cell | null }
  progress: { graded: number; to_grade: number; taught: number; to_teach: number; seq: number; updated_at: string } | null
  teaching: { missed: number; taught: number; solved: number; explained: number; teacher_failed: number; leaked: number; not_taught: number; teacher_calls: number; cut_off: number } | null
  examples: { kept: number; guided: number; answer: number; explained: number; left_out: number; total: number } | null
  training: { steps_done: number | null; steps_planned: number | null; holdout_loss_before: number | null; holdout_loss_after: number | null } | null
  flags: {
    seen_only: boolean; too_easy: boolean; unanswered: number; cut_short_before: boolean; rubric_literal: string[]; shared_literals: string[]; within_noise: boolean; reasons: string[]
    /** Per subskill: held back questions that expect a value a practice question also expects, or that a rubric gives as a fixed value. Empty for a lesson stored before the lab counted this. */
    shared_answers: Array<{ name: string; shared: number; of: number }>
    cut_off_fell: boolean; cut_off: { before: CutOff | null; after: CutOff | null }
  }
  exchanges: Array<{ subskill: string; question: string; wrong: string; guide: string; reply: string; answer: string; passed: boolean }>
  cost: { tinker_estimated_usd: number | null; tinker_max_usd: number; teacher_usd: number; teacher_max_usd: number; basis: string }
  measured_by: typeof TUTOR_MEASURED_BY
  origin: typeof ORIGIN_MODELS
  talk?: string
  /** Until when the trained adapter is kept, for a lesson that closed ok with one. */
  kept_until?: string
  created_at: string
  finished_at: string | null
  reason: string | null
}

export interface TutorLesson { enabled: boolean; off_reason?: string; lesson: PublicLesson | null }

export interface LessonRecord extends PublicLesson { rubrics: string[][] }

export interface LessonQuestions {
  questions: Array<{
    held_back: boolean
    prompt: string
    /** cut_short: the token limit cut the answer off; empty: it came back with no text. Both are graded as they stand. */
    answers: { before: Array<{ text: string; passed: boolean; cut_short: boolean; empty: boolean }>; after: Array<{ text: string; passed: boolean; cut_short: boolean; empty: boolean }> }
    /** reply_cut_short and answer_cut_short: the token limit cut the small model's reply to a guiding question, or its answer again, off. */
    turns: Array<{ kind: 'guide' | 'explain'; state: string; teacher: string; reply: string; answer: string; passed: boolean; reply_cut_short: boolean; answer_cut_short: boolean }>
  }>
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The round whose test stands for a lesson that has closed, as its stored
 * result says (rounds_done): when a second round failed in its retest, round
 * 1's adapter stands and round 2's partial answers are not the lesson's
 * "after". Null while the lesson is open, or when no round finished.
 */
export function standingRound(run: Pick<TinkerRunRow, 'status' | 'result'>): number | null {
  if (run.status === 'lesson') return null
  const done = run.result?.rounds_done
  return done === 1 || done === 2 ? done : null
}
const STATUSES = ['ok', 'ended', 'failed', 'error'] as const
const STAGES = ['diagnostic', 'teaching', 'training', 'retest', 'closing', 'done'] as const

/** The lesson as visitors may see it. Pure: the rows and the moment are all it reads. */
export function publicLesson(run: TinkerRunRow, lesson: LessonRow | null, answers: AnswerRow[], turns: TurnRow[], now: Date = new Date(), chatOn: boolean = trainedChatStatus().enabled): PublicLesson | null {
  const request: TinkerTutorRequest | null = lesson?.request ?? null
  if (!request || !Array.isArray(request.subskills)) return null
  const open = run.status === 'lesson'
  const summary = summarizeLesson(request, answers, turns, { train: lesson?.train ?? [], teacher_calls: lesson?.teacher_calls ?? 0 }, standingRound(run))
  const stage = open ? (STAGES as readonly string[]).includes(lesson?.stage ?? '') ? lesson!.stage : 'diagnostic' : 'done'
  const status = open ? 'running' : (STATUSES as readonly string[]).includes(run.status) ? run.status as PublicLesson['status'] : 'failed'
  const p = lesson?.progress
  const progress = p && typeof p.seq === 'number' && typeof p.updated_at === 'string' && !Number.isNaN(Date.parse(p.updated_at))
    ? { graded: p.graded | 0, to_grade: p.to_grade | 0, taught: p.taught | 0, to_teach: p.to_teach | 0, seq: p.seq | 0, updated_at: new Date(p.updated_at).toISOString() }
    : null
  const leg = [...(lesson?.train ?? [])].filter(l => l.result).sort((a, b) => b.round - a.round)[0]
  const alive = run.status === 'ok' && Boolean(run.expires_at) && Date.parse(run.expires_at as string) > now.getTime()
  const name = shownName(run)
  const questions = allQuestions(request)
  return {
    slug: run.slug,
    adapter: `lab/${run.slug}`,
    kind: 'tutor',
    epoch: run.epoch,
    author_model: run.model,
    author_name: modelName(run.model),
    teacher_model: lesson?.teacher_model ?? '',
    teacher_name: lesson ? modelName(lesson.teacher_model) : '',
    base_model: run.base_model,
    topic: publicCut(request.topic, 48),
    purpose: run.purpose ? publicCut(run.purpose, 200) : null,
    ...(name ? { name } : {}),
    status,
    stage: stage as PublicLesson['stage'],
    round: lesson?.round ?? 1,
    rounds: request.settings?.rounds ?? 1,
    live: open && progress !== null && now.getTime() - Date.parse(progress.updated_at) <= TUTOR_LIVE_MS,
    questions: { practice: questions.filter(q => !q.held_back).length, held_back: questions.filter(q => q.held_back).length, samples: TUTOR_SAMPLES },
    subskills: summary.skill_map.slice(0, TUTOR_SUBSKILLS.max).map(s => ({ ...s, name: publicCut(s.name, 40) })),
    overall: summary.overall,
    progress,
    teaching: stage === 'diagnostic' && open ? null : summary.teaching,
    examples: summary.examples,
    training: leg ? {
      steps_done: num(leg.result?.steps_done), steps_planned: num(leg.result?.steps_planned),
      holdout_loss_before: num(leg.result?.holdout_loss_before), holdout_loss_after: num(leg.result?.holdout_loss_after),
    } : null,
    flags: {
      seen_only: summary.flags.seen_only, too_easy: summary.flags.too_easy, unanswered: summary.flags.unanswered, cut_short_before: summary.flags.cut_short_before,
      rubric_literal: summary.flags.rubric_literal.map(n => publicCut(n, 40)), shared_literals: summary.flags.shared_literals.map(n => publicCut(n, 40)),
      shared_answers: summary.flags.shared_answers.slice(0, TUTOR_SUBSKILLS.max).map(e => ({ name: publicCut(e.name, 40), shared: e.shared, of: e.of })),
      within_noise: summary.flags.within_noise, reasons: summary.flags.reasons.slice(0, TUTOR_MAX_REASONS).map(r => publicCut(r, 300)),
      cut_off_fell: summary.flags.cut_off_fell, cut_off: summary.flags.cut_off,
    },
    exchanges: exchangesOf(request, answers, turns),
    cost: {
      tinker_estimated_usd: open ? null : run.cost_usd,
      tinker_max_usd: run.reserved_usd,
      teacher_usd: Math.round((lesson?.teacher_usd ?? 0) * 1e6) / 1e6,
      teacher_max_usd: lesson?.teacher_cap_usd ?? 0,
      basis: `Tinker use is an estimate from Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}, not a billed amount; the teacher's cost is what OpenRouter reported`,
    },
    measured_by: TUTOR_MEASURED_BY,
    origin: ORIGIN_MODELS,
    ...(alive && chatOn ? { talk: `lab/${run.slug}` } : {}),
    ...(run.status === 'ok' && run.expires_at ? { kept_until: run.expires_at } : {}),
    created_at: run.created_at,
    finished_at: run.finished_at,
    reason: run.reason ? publicCut(run.reason, 300) : null,
  }
}

/** Up to 3 taught questions with their last guiding turn the student answered, each text cut to 300 bytes. */
function exchangesOf(request: TinkerTutorRequest, answers: AnswerRow[], turns: TurnRow[]): PublicLesson['exchanges'] {
  const out: PublicLesson['exchanges'] = []
  for (const miss of missesToTeach(request, answers, 'before').taught) {
    if (out.length >= 3) break
    const graded = turns.filter(t => t.round === 1 && t.subskill === miss.subskill && t.question === miss.question && t.kind === 'guide' && t.state === 'graded' && t.teacher_text)
      .sort((a, b) => b.turn - a.turn)[0]
    if (!graded) continue
    out.push({
      subskill: publicCut(request.subskills[miss.subskill].name, 40), question: publicCut(miss.task.prompt, 300), wrong: publicCut(miss.wrong, 300),
      guide: publicCut(graded.teacher_text, 300), reply: publicCut(graded.student_reply, 300), answer: publicCut(graded.student_answer, 300), passed: graded.passed,
    })
  }
  return out
}

/** The newest lesson's rows, or null. Only looks. */
async function lessonRows(slug: string): Promise<{ run: TinkerRunRow; lesson: LessonRow | null; answers: AnswerRow[]; turns: TurnRow[] } | null> {
  const run = await getRun(slug)
  if (!run || run.kind !== 'tutor') return null
  const lesson = await getLessonRow(run.id)
  const answers = lesson ? await answerMarks(run.id).catch(() => []) : []
  const turns = lesson ? await loadTurns(run.id).catch(() => []) : []
  return { run, lesson, answers, turns }
}

let cached: { at: number; value: TutorLesson } | null = null
const CACHE_MS = 4000

/**
 * What the public state says about the Socratic lesson: whether it is on (and
 * why not), and the newest lesson. Read at most every few seconds per server
 * instance. Null when the tool is off and no lesson exists (the field is then
 * left out of the state).
 */
export async function tutorLesson(now: Date = new Date()): Promise<TutorLesson | null> {
  if (cached && now.getTime() - cached.at < CACHE_MS && now.getTime() >= cached.at) return cached.value
  const status = tinkerTutorStatus()
  const slug = await latestLessonSlug()
  let lesson: PublicLesson | null = null
  if (slug) {
    try {
      const rows = await lessonRows(slug)
      if (rows) lesson = publicLesson(rows.run, rows.lesson, rows.answers, rows.turns, now)
    } catch (e) {
      console.warn('[tinker-tutor] could not read the newest lesson:', e instanceof Error ? e.message : e)
    }
  }
  if (!status.enabled && !lesson) return null
  const value: TutorLesson = { enabled: status.enabled, ...(!status.enabled && status.off_reason ? { off_reason: status.off_reason } : {}), lesson }
  cached = { at: now.getTime(), value }
  return value
}

export function resetTutorLessonCache(): void {
  cached = null
}

/** The full record of one lesson: the public lesson and its rubrics in words. Null when there is no such lesson. */
export async function lessonRecordBySlug(slug: string, now: Date = new Date()): Promise<LessonRecord | null> {
  if (!isAdapterSlug(slug)) return null
  const rows = await lessonRows(slug)
  if (!rows) return null
  const lesson = publicLesson(rows.run, rows.lesson, rows.answers, rows.turns, now)
  if (!lesson || !rows.lesson) return null
  return { ...lesson, rubrics: rows.lesson.request.subskills.map(s => describeRubric(s.rubric).slice(0, 8).map(l => publicCut(l, 200))) }
}

const shownState = (s: string) => (s === 'calling' ? 'asked' : s)

/** One subskill's questions with every graded answer and every turn. 'bad_index' for an index the lesson does not have; null for no such lesson. */
export async function lessonQuestionsBySlug(slug: string, subskill: number): Promise<LessonQuestions | 'bad_index' | null> {
  if (!isAdapterSlug(slug)) return null
  const run = await getRun(slug)
  if (!run || run.kind !== 'tutor') return null
  const lesson = await getLessonRow(run.id)
  if (!lesson?.request?.subskills) return null
  const s = lesson.request.subskills[subskill]
  if (!s || !Number.isInteger(subskill) || subskill < 0) return 'bad_index'
  const answers = await subskillAnswers(run.id, subskill)
  const turns = (await loadTurns(run.id)).filter(t => t.subskill === subskill)
  const stands = standingRound(run)
  const afterPhase = stands ? `after${stands}` : ['after2', 'after1'].find(p => answers.some(a => a.phase === p)) ?? 'after1'
  const answersOf = (held: boolean, q: number, phase: string) => answers
    .filter(a => a.phase === phase && a.held_back === held && a.question === q && (a.status === 'ok' || a.status === 'no_answer'))
    .sort((a, b) => a.sample - b.sample)
    .map(a => ({
      text: publicCut(a.answer ?? '', 300), passed: a.passed,
      // how the answer ended, as the lab stored it: cut off by the token limit, or no text at all
      cut_short: a.cut_short === true, empty: a.status === 'ok' && a.cut_short !== true && !(a.answer ?? '').trim(),
    }))
  const list: LessonQuestions['questions'] = []
  for (const [held, tasks] of [[false, s.practice], [true, s.held_back]] as const) {
    for (const [q, task] of tasks.entries()) {
      if (list.length >= 50) break
      list.push({
        held_back: held,
        prompt: publicCut(task.prompt, 400),
        answers: { before: answersOf(held, q, 'before'), after: answersOf(held, q, afterPhase) },
        turns: held ? [] : turns.filter(t => t.question === q).sort((a, b) => a.round - b.round || a.turn - b.turn).map(t => ({
          kind: t.kind, state: shownState(t.state),
          teacher: publicCut(t.teacher_text ?? '', t.kind === 'explain' ? TUTOR_EXPLAIN_SHOWN_BYTES : 400),
          reply: publicCut(t.student_reply ?? '', 300),
          answer: publicCut((t.kind === 'explain' ? t.teacher_answer : t.student_answer) ?? '', 300),
          passed: t.passed,
          reply_cut_short: t.reply_cut_short === true, answer_cut_short: t.kind === 'guide' && t.answer_cut_short === true,
        })),
      })
    }
  }
  return { questions: list }
}
