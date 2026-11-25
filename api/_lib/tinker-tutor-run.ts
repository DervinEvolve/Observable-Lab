/**
 * Runs a Socratic lesson the Reviewer approved (tinker-tutor.ts), in slices.
 *
 * A lesson cannot finish inside one request: it is a state machine on a
 * database row (tutor-store.ts), moved forward by the follow-up of the epoch
 * that asked for it and then by the cron route /api/epoch/lesson every ten
 * minutes. Each slice takes the lesson's lease, runs the stage loop until its
 * deadline, writes the public progress record after every batch and gives the
 * lease back.
 *
 *   diagnostic  the untrained base model answers every question twice; the lab grades
 *   teaching    for missed practice questions, the teacher asks one guiding
 *               question at a time, the student replies and answers again,
 *               the lab grades; after the last turn the teacher explains
 *   training    one `train` job on Modal, on the exchanges (tinker-client.ts)
 *   retest      the adapter answers every question twice; the lab grades
 *   (a second round, when asked for and when the money and time allow)
 *   closing     the run row is closed once and its money settled
 *
 * Money. The Tinker part (student calls and training) is set aside whole
 * before anything is sent, as every Tinker run is, and settled at closing to
 * what was measured. The teacher (OpenRouter) is set aside one call at a time
 * on the lesson row, and its real usage.cost goes on the ledger as the call
 * answers. Nothing here throws into the epoch or the route.
 */
import { budgetScopeFor } from './experiment-modes.js'
import type { Rubric, RubricTask } from './rubric.js'
import { buildRequestBody, callModelOnce, getModelCapabilities, type ModelCapabilities } from './openrouter.js'
import { dailyBudgetUsd, refreshEpochCost, researchDailyBudgetUsd, spentTodayUsd, withSpendContext } from './spend.js'
import { TOOL_OUTPUT_TAIL_BYTES, recordToolRun, toolsRunInEpoch, type ToolRunInput, type ToolRunStatus } from './tool-runs-store.js'
import { TINKER_NAME_TOOL } from './tinker-keep-request.js'
import {
  TINKER_ESTIMATE_MARGIN, TINKER_MAX_DATASET_BYTES, TINKER_MAX_EXAMPLE_BYTES, TINKER_PRICE_TABLE_DATE, estimateTinkerRun, isExternalPath, isSamplerPath, newAdapterSlug, newSplitSalt,
  normalizeTinkerRequest, normalizeTinkerResult, tinkerChatCostUsd, tinkerChatWorstCaseUsd, tinkerCostUsd, tinkerDailyUsd, tinkerJobsConfigured,
  tinkerKeepFlag, tinkerNamesFlag, tinkerRunUsd, tinkerSamplingConfigured, tinkerTtlDays, tinkerWaitMs, usdText,
  type TinkerRequest,
} from './tinker.js'
import { callTinkerChat, tinkerChatCharge, type TinkerChatMessage } from './tinker-chat.js'
import { findTinkerCall, startTinkerJob, tinkerJobBody, waitForTinkerJob } from './tinker-client.js'
import { claimAdapterName, getRun, openTinkerTutorRun, reserveTinkerSpend, settleTinkerSpend, shownName, type TinkerRunRow } from './tinker-store.js'
import { TINKER_LOST_AFTER_MS, adapterExpiry, type TinkerOutcome, type TinkerRunContext } from './tinker-run.js'
import {
  TUTOR_ANSWER_TOKENS, TUTOR_CALL_ATTEMPTS, TUTOR_EXPLAIN_SHOWN_BYTES, TUTOR_EXPLAIN_SYSTEM, TUTOR_FIRST_SLICE_MS, TUTOR_GUIDE_SYSTEM, TUTOR_LEASE_MS,
  TUTOR_MAX_AGE_MS, TUTOR_MEASURED_BY, TUTOR_MEASURE_NOTE, TUTOR_MIN_EXAMPLES, TUTOR_PRACTICE_REUSE_DAYS, TUTOR_REPLY_TOKENS, TUTOR_RETRY_LINE, TUTOR_SAMPLES,
  TUTOR_STOP_BEFORE_MS, TUTOR_STUDENT_CONCURRENCY, TUTOR_STUDENT_TIMEOUT_MS, TUTOR_TEACHER_MAX_TOKENS, TUTOR_TEACHER_PROMPT_MAX_BYTES, TUTOR_TEACHER_TIMEOUT_MS,
  TUTOR_TEACH_UNTIL_MS, TUTOR_TEMPERATURE, TUTOR_TEXT_BYTES, TUTOR_TOOL, TUTOR_TRUNCATED_STOP, TUTOR_UNANSWERED_MAX,
  allQuestions, buildExamples, bytesOf, cleanText, cutBytes, estimateTutor, lessonHashes, lessonRecordOf, leakTargets, maxTeacherCalls, missesToTeach,
  modelName, passes, phaseMap, publicCut, readExplanation, readGuide, roundTwoNeedUsd, teacherCeilingUsd, teacherEffort, teacherUserPrompt, teacherWorstUsd,
  testCeilingUsd, tutorFlags, tutorSummary, tutorTeacherModelSetting, tutorTeacherUsd, tinkerTutorPerDay, tinkerTutorStatus,
  type AnswerMark, type Cell, type ExampleCounts, type Miss, type PhaseMap, type TaughtExchange, type TeacherTurnText, type TinkerTutorRequest,
} from './tinker-tutor.js'
import {
  closeAbandonedLessons, closeLessonRun, createLesson, heldHashMatches, loadAnswers, loadTurns, markTeacherCalling, openLessonRows, openTeacherReservedUsd,
  releaseLease, releaseTutorDaySlot, repairLessonOpenings, reserveTeacher, saveAnswer, saveTurnStudent, setClosing, takeTutorDaySlot, setProgress, setStage, setStopReason, setTrain, settleLostTeacherCall, settleTeacher, takeLease,
  unreserveTeacher,
  type AnswerRow, type LessonRow, type LessonStage, type TrainLeg, type TurnRow,
} from './tutor-store.js'

export { tutorRunsToday } from './tutor-store.js'

// ---------------------------------------------------------------------------
// Before a lesson opens
// ---------------------------------------------------------------------------

/**
 * Can a teacher call be held to an exact output limit? Only when the model's
 * catalog entry lists max_tokens or max_completion_tokens: otherwise no limit
 * is sent (openrouter.ts buildRequestBody), and the worst case of a call,
 * which assumes TUTOR_TEACHER_MAX_TOKENS of output, would not bound it.
 */
export function teacherTakesLimit(caps: Pick<ModelCapabilities, 'supported_parameters'> | null): boolean {
  const supported = caps?.supported_parameters ?? ['max_tokens']
  return supported.includes('max_tokens') || supported.includes('max_completion_tokens')
}

/** Who teaches: LAB_TUTOR_TEACHER_MODEL when set, else the model that really answered as Executor. */
export function teacherModelFor(ctx: Pick<TinkerRunContext, 'executorModelId'>): string {
  return tutorTeacherModelSetting() ?? ctx.executorModelId
}

/** The most a lesson could cost the lab, Tinker ceiling and teacher ceiling together, for the checks made before it runs. */
export async function tinkerTutorWorstCaseUsd(request: TinkerTutorRequest, teacherModel: string): Promise<number> {
  const caps = await getModelCapabilities(teacherModel).catch(() => null)
  const teacher = caps?.pricing ? teacherCeilingUsd(request.settings, caps.pricing) : tutorTeacherUsd()
  return estimateTutor(request).max_cost_usd + teacher
}

/**
 * Spec 1.2 check 8: a held back question must not be a held back question of
 * any earlier lesson, nor a practice question of a lesson that closed ok in
 * the last 30 days; a practice question must not be an earlier held back
 * question. Null when none matches.
 */
export async function lessonReuseReason(request: TinkerTutorRequest, now: Date = new Date()): Promise<string | null> {
  const mine = lessonHashes(request)
  const found = await heldHashMatches([...new Set(mine.map(h => h.hash))])
  const recent = now.getTime() - TUTOR_PRACTICE_REUSE_DAYS * 86_400_000
  for (const q of mine) {
    for (const m of found) {
      if (m.hash !== q.hash) continue
      const practiceOfRecentOk = !m.held_back && m.status === 'ok' && m.finished_at !== null && Date.parse(m.finished_at) >= recent
      if (m.held_back) return `${q.where} was a held back question of the lesson at lab/${m.lesson_slug}`
      if (q.held_back && practiceOfRecentOk) return `${q.where} was a practice question of the lesson at lab/${m.lesson_slug}`
    }
  }
  return null
}

/**
 * Runs an approved request. The caller has already checked the Reviewer's
 * verdict, the lessons-per-day limit (tutorRunsToday) and the lab's daily
 * budget; the Tinker caps, the teacher's price and the reuse of earlier
 * questions are checked here. A refusal is `skipped` with its reason for the
 * caller to store.
 */
export async function runTinkerTutor(ctx: TinkerRunContext, request: TinkerTutorRequest, opts: { now?: Date; pollMs?: number; deadlineAt?: number } = {}): Promise<TinkerOutcome> {
  const skipped = (reason: string): TinkerOutcome => ({ tool: TUTOR_TOOL, status: 'skipped', summary: reason })
  const now = opts.now ?? new Date()
  const teacher = teacherModelFor(ctx)
  const caps = await getModelCapabilities(teacher).catch(() => null)
  if (!caps?.pricing) return skipped(`the teacher, ${modelName(teacher)}, has no known price, so it cannot teach`)
  if (!teacherTakesLimit(caps)) return skipped(`the teacher, ${modelName(teacher)}, takes no output limit, so the most a call could cost is not known and it cannot teach`)
  const estimate = estimateTutor(request)
  const runCap = tinkerRunUsd()
  if (estimate.max_cost_usd > runCap) {
    return skipped(`the most its Tinker use could cost (${usdText(estimate.max_cost_usd)}, estimated from published prices) is over the ${usdText(runCap)} a run may cost`)
  }
  let reuse: string | null
  try {
    reuse = await lessonReuseReason(request, now)
  } catch (e) {
    console.warn('[tinker-tutor] could not check earlier lessons:', e instanceof Error ? e.message : e)
    return skipped('the lab could not check the questions against earlier lessons, so nothing was started')
  }
  if (reuse) return skipped(reuse)

  // One of today's places, taken in one statement; it is given back on every refusal below, before any call is sent.
  try {
    if (!(await takeTutorDaySlot(now, tinkerTutorPerDay()))) return skipped(`the lab already gave today's ${tinkerTutorPerDay()} lesson place${tinkerTutorPerDay() === 1 ? '' : 's'} (UTC day)`)
  } catch (e) {
    console.warn('[tinker-tutor] could not count today\'s lessons:', e instanceof Error ? e.message : e)
    return skipped('the lab could not count today\'s lessons, so nothing was started')
  }
  const refusedEarly = async (reason: string): Promise<TinkerOutcome> => {
    await releaseTutorDaySlot(now)
    return skipped(reason)
  }

  let reservation: Awaited<ReturnType<typeof reserveTinkerSpend>>
  try {
    reservation = await reserveTinkerSpend('all', estimate.max_cost_usd, tinkerDailyUsd(), now)
  } catch (e) {
    console.warn('[tinker-tutor] could not set the estimate aside:', e instanceof Error ? e.message : e)
    return refusedEarly('the lab could not check today\'s Tinker spend, so nothing was started')
  }
  if (!reservation.ok) return refusedEarly(`its estimated Tinker cost of ${usdText(estimate.max_cost_usd)} was not set aside: ${reservation.reason}`)

  const teacherCap = tutorTeacherUsd()
  let row: TinkerRunRow | null
  try {
    row = await openTinkerTutorRun({
      experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, assignedModel: ctx.assignedExecutorId,
      slug: newAdapterSlug(ctx.epochNumber), request, lesson: lessonRecordOf(request, teacher, teacherCap), splitSalt: newSplitSalt(),
      spendDay: reservation.day, reservedUsd: reservation.usd,
    })
  } catch (e) {
    await settleTinkerSpend(reservation, 0)
    console.warn('[tinker-tutor] could not open a run:', e instanceof Error ? e.message : e)
    return refusedEarly('the lab could not store the lesson, so nothing was started')
  }
  if (!row) {
    await settleTinkerSpend(reservation, 0)
    return refusedEarly('this epoch already has a Tinker run')
  }

  const budgetScope = await budgetScopeFor(ctx.experimentId).catch(() => 'classic' as const)
  try {
    const lesson = await createLesson({
      runId: row.id, slug: row.slug, request, teacherModel: teacher, teacherCapUsd: teacherCap, budgetScope,
      experimentId: ctx.experimentId, epoch: ctx.epochNumber, spendDay: reservation.day, reservedUsd: reservation.usd,
      hashes: lessonHashes(request).map(h => ({ hash: h.hash, held_back: h.held_back })), now,
    })
    if (!lesson) throw new Error('the lesson row exists already')
  } catch (e) {
    console.warn('[tinker-tutor] could not store the lesson:', e instanceof Error ? e.message : e)
    const reason = 'the lab could not store the lesson, so nothing was started'
    await closeLessonRun({
      runId: row.id, status: 'failed', reason, costUsd: 0, result: { kind: 'tutor', topic: request.topic }, samplerPath: null, expiresAt: null,
      examples: 0, spendDay: reservation.day, reservedUsd: reservation.usd, now,
      ledger: { experimentId: ctx.experimentId, epoch: ctx.epochNumber, assigned: ctx.assignedExecutorId ?? ctx.executorModelId, budgetScope },
    }).catch(() => null)
    return refusedEarly(reason)
  }

  // The display name, while names are on: it never decides the lesson.
  if (tinkerNamesFlag() && request.name) {
    let refused: string | null = null
    try {
      if (!(await claimAdapterName(row.id, request.name))) refused = `"${request.name}" is the name of another adapter that is still alive`
    } catch (e) {
      console.warn('[tinker-tutor] could not store the adapter name:', e instanceof Error ? e.message : e)
      refused = 'the lab could not store the name'
    }
    if (refused) {
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: TINKER_NAME_TOOL,
        requestSummary: `a display name for adapter lab/${row.slug}`, status: 'skipped',
        outputTail: `name refused: ${refused}; the lesson goes on and the adapter has no name`,
      })
    }
  }

  const deadlineAt = opts.deadlineAt ?? Date.now() + Math.min(tinkerWaitMs(), TUTOR_FIRST_SLICE_MS)
  const moved = await advanceTutorLessonsDetailed({ deadlineAt, now, pollMs: opts.pollMs, only: row.id })
  const mine = moved.find(m => m.slug === row!.slug)
  if (mine?.outcome) return mine.outcome
  return {
    tool: TUTOR_TOOL, status: 'started',
    summary: `${modelName(ctx.executorModelId)}'s Socratic lesson is running (at most ${usdText(reservation.usd)} of Tinker use set aside, at most ${usdText(teacherCap)} for the teacher); the lab goes on with it every ten minutes`,
  }
}

// ---------------------------------------------------------------------------
// Slices
// ---------------------------------------------------------------------------

export interface LessonAdvance { slug: string; stage: LessonStage; status: string; outcome?: TinkerOutcome }

/**
 * Moves every open lesson forward, oldest first (at most 2), each under its
 * lease, until the deadline. Never throws. Like collectTinkerRuns it keeps
 * going while the switch is off, so an open lesson is finished and its money
 * settled. With the switch off and nothing configured to run it, it makes no
 * model or runner call, and closes, in one statement, every lesson left open
 * longer than TUTOR_MAX_AGE_MS.
 */
export async function advanceTutorLessons(opts: { deadlineAt: number; now?: Date; pollMs?: number }): Promise<TinkerOutcome[]> {
  const moved = await advanceTutorLessonsDetailed(opts)
  return moved.filter(m => m.outcome).map(m => m.outcome as TinkerOutcome)
}

export async function advanceTutorLessonsDetailed(opts: { deadlineAt: number; now?: Date; pollMs?: number; only?: string }): Promise<LessonAdvance[]> {
  const now = opts.now ?? new Date()
  const runnable = tinkerTutorStatus().enabled || (tinkerJobsConfigured() && tinkerSamplingConfigured())
  if (!runnable) {
    try {
      const reason = 'the lesson was left open and the tool is off'
      const closed = await closeAbandonedLessons(new Date(now.getTime() - TUTOR_MAX_AGE_MS), reason, now)
      for (const c of closed) {
        await refreshEpochCost(c.experiment_id, c.epoch)
        await recordToolRun({
          experimentId: c.experiment_id, epoch: c.epoch, model: c.model, tool: TUTOR_TOOL, requestSummary: `Socratic lesson lab/${c.slug}`,
          status: 'failed', costUsd: c.spent,
          outputTail: `failed: ${reason}; estimated Tinker cost $${c.spent.toFixed(4)} (token counts at Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}, or a training job's whole budget where its result is unknown; not a billed amount); ${TUTOR_MEASURE_NOTE}`,
        })
      }
      return closed.map(c => ({ slug: c.slug, stage: 'done' as const, status: 'failed' }))
    } catch {
      return [] // no lesson table: nothing was ever opened
    }
  }
  if (!opts.only) {
    // What a request that died while opening a lesson left behind: a place of the day, or a run row with no lesson.
    try {
      const repaired = await repairLessonOpenings(now, new Date(now.getTime() - TUTOR_LEASE_MS), NEVER_OPENED)
      // A run row closed here gets its tool run row, as every other way a lesson's run row is closed does, unless the epoch already has one.
      for (const c of repaired.runs) {
        const have = await toolsRunInEpoch(c.experiment_id, c.epoch)
        if (have.has(TUTOR_TOOL) || have.has('*')) continue
        await recordToolRun({
          experimentId: c.experiment_id, epoch: c.epoch, model: c.model, tool: TUTOR_TOOL, requestSummary: `Socratic lesson lab/${c.slug}`,
          status: 'failed', costUsd: 0, outputTail: `failed: ${NEVER_OPENED}; no Tinker use and no teacher call, so no cost`,
        })
      }
    } catch {
      // no lesson tables yet, or the database is away: nothing to repair now
    }
  }
  let rows: LessonRow[]
  try {
    rows = await openLessonRows(2)
  } catch {
    return [] // no lesson table: nothing was ever opened
  }
  const out: LessonAdvance[] = []
  for (const open of rows) {
    if (opts.only && open.run_id !== opts.only) continue
    if (Date.now() > opts.deadlineAt - TUTOR_STOP_BEFORE_MS) break
    try {
      const lesson = await takeLease(open.run_id, now, TUTOR_LEASE_MS)
      if (!lesson) {
        out.push({ slug: open.slug, stage: open.stage, status: 'running' })
        continue
      }
      const slice = new LessonSlice(lesson, opts.deadlineAt, now, opts.pollMs)
      const result = await slice.run()
      if (slice.stage !== 'done') await releaseLease(lesson.run_id)
      out.push({ slug: lesson.slug, stage: slice.stage, status: result.status, ...(result.outcome ? { outcome: result.outcome } : {}) })
    } catch (e) {
      // The lease is left to run out: a reservation the slice held is given back when the lease is taken again.
      console.warn(`[tinker-tutor] the lesson lab/${open.slug} could not move forward (non-fatal):`, e instanceof Error ? e.message : e)
      out.push({ slug: open.slug, stage: open.stage, status: 'running' })
    }
  }
  return out
}

const keyOf = (phase: string, s: number, held: boolean, q: number, sample: number) => `${phase}|${s}|${held ? 1 : 0}|${q}|${sample}`
const turnKey = (round: number, s: number, q: number, turn: number) => `${round}|${s}|${q}|${turn}`

type Step = 'next' | 'paused' | 'closed'

const NEVER_OPENED = 'the lesson was never opened: the request that asked for it stopped first, so nothing was sent'
const NO_MONEY_TEST = 'the Tinker money set aside for the lesson does not cover the rest of a test, so it stopped there'
const NO_MONEY_TEACH = 'the Tinker money set aside does not cover another call to the small model and what training and the retest need, so teaching stopped'

class Stopped extends Error {}

/** One slice of one lesson, under its lease. */
class LessonSlice {
  stage: LessonStage
  private answers = new Map<string, AnswerRow>()
  private turns = new Map<string, TurnRow>()
  private failedThisSlice = new Set<string>()
  private runRow: TinkerRunRow | null = null
  private caps: ModelCapabilities | null = null
  private outcome: TinkerOutcome | undefined
  private finalStatus = 'running'
  private writes = 0

  constructor(private lesson: LessonRow, private deadlineAt: number, private now: Date, private pollMs?: number) {
    this.stage = lesson.stage
  }

  private get request(): TinkerTutorRequest { return this.lesson.request }
  private get age(): number { return this.now.getTime() - Date.parse(this.lesson.created_at) }
  /** May a call be started now? None is started TUTOR_STOP_BEFORE_MS before the slice's deadline; `ms` is the call's own time limit, kept for the record of what each start waits on. */
  private timeFor(_ms: number): boolean { return Date.now() < this.deadlineAt - TUTOR_STOP_BEFORE_MS }

  async run(): Promise<{ status: string; outcome?: TinkerOutcome }> {
    for (const a of await loadAnswers(this.lesson.run_id)) this.answers.set(keyOf(a.phase, a.subskill, a.held_back, a.question, a.sample), a)
    for (const t of await loadTurns(this.lesson.run_id)) this.turns.set(turnKey(t.round, t.subskill, t.question, t.turn), t)
    this.runRow = await getRun(this.lesson.slug)
    if (!this.runRow || this.runRow.status !== 'lesson') {
      // Closed already (by another request, or by the sweep). The close wrote the run row, the money and the ledger in one
      // statement; the epoch's cost is refreshed again, and the lesson's tool run row written when the epoch has none, in
      // case the request that closed it stopped right after.
      if (this.runRow) {
        await refreshEpochCost(this.lesson.experiment_id, this.lesson.epoch)
        const have = await toolsRunInEpoch(this.lesson.experiment_id, this.lesson.epoch)
        if (!have.has(TUTOR_TOOL) && !have.has('*')) {
          const run = this.runRow
          const status = run.status === 'ok' || run.status === 'ended' || run.status === 'error' ? run.status : 'failed'
          await recordToolRun(this.toolRun(run, status, run.reason, run.result ?? { kind: 'tutor', topic: this.request.topic }, run.sampler_path, run.expires_at, run.cost_usd ?? 0).row)
        }
      }
      await setStage(this.lesson.run_id, 'done', this.lesson.round)
      this.stage = 'done'
      return { status: this.runRow?.status ?? 'failed' }
    }
    // A teacher call marked as sent by a request that died is settled first, at the most it could have cost: before any
    // new call is reserved against the teacher's cap, and also when teaching has stopped and would never reach its turn.
    for (const t of [...this.turns.values()]) if (t.state === 'calling') await this.lostCall(t)
    for (let guard = 0; guard < 40; guard++) {
      if (this.age > TUTOR_MAX_AGE_MS && this.stage !== 'closing' && this.stage !== 'done') {
        await this.closeForAge()
        break
      }
      let step: Step
      if (this.stage === 'diagnostic') step = await this.diagnostic()
      else if (this.stage === 'teaching') step = await this.teaching()
      else if (this.stage === 'training') step = await this.training()
      else if (this.stage === 'retest') step = await this.retest()
      else if (this.stage === 'closing') step = await this.closeNormally()
      else break
      if ((this.stage as LessonStage) === 'done') break
      await this.writeProgress()
      if (step !== 'next') break
    }
    return { status: this.finalStatus, ...(this.outcome ? { outcome: this.outcome } : {}) }
  }

  private async moveTo(stage: LessonStage, round: number = this.lesson.round): Promise<void> {
    await setStage(this.lesson.run_id, stage, round)
    this.stage = stage
    this.lesson.stage = stage
    this.lesson.round = round
  }

  // ---- marks -----------------------------------------------------------------

  private marks(): Array<AnswerMark & { answer: string | null }> {
    return [...this.answers.values()].map(a => ({ ...a }))
  }

  private map(phase: string): PhaseMap {
    return phaseMap(this.request, this.marks(), phase)
  }

  private phaseDone(phase: string): boolean {
    const m = this.map(phase)
    return m.graded >= m.to_grade
  }

  private async writeProgress(): Promise<void> {
    const phase = this.stage === 'retest' ? `after${this.lesson.round}` : this.stage === 'diagnostic' ? 'before' : null
    const m = phase ? this.map(phase) : null
    const teach = this.lesson.round === 1 || this.stage === 'diagnostic' ? 'before' : 'after1'
    const taught = this.taughtList(this.lesson.round, teach)
    const done = taught.filter(t => this.missDone(this.lesson.round, t)).length
    const progress = {
      graded: m ? m.graded : 0, to_grade: m ? m.to_grade : allQuestions(this.request).length * TUTOR_SAMPLES,
      taught: this.stage === 'diagnostic' ? 0 : done, to_teach: this.stage === 'diagnostic' ? 0 : taught.length,
      seq: (this.lesson.progress?.seq ?? 0) + 1, updated_at: new Date().toISOString(),
    }
    // Kept before the write is sent: the four calls in flight each write a record, and each takes its own number.
    this.lesson.progress = progress
    await setProgress(this.lesson.run_id, progress)
  }

  // ---- student calls -----------------------------------------------------------

  /**
   * What the student calls not yet in the slice's rows could cost: a call in
   * flight at the most it could cost, and a call that answered at what it was
   * charged until its row is stored and counted by tinkerSpentUsd (stored()).
   * A call is never counted nowhere: without the second part the other calls
   * of a test made their money check while a finished call's row was being written.
   */
  private inFlightUsd = 0
  /** Set when a call to the small model was reported at more than the most the lab estimated it could cost: the lab cannot hold a reported figure, so it stops there. */
  private overCharged: string | null = null

  /** The row of a finished student call is in the slice's maps: its cost is counted there from now on. */
  private stored(costUsd: number): void {
    this.inFlightUsd = Math.max(0, this.inFlightUsd - costUsd)
  }

  /**
   * One call to the small model, only when the money set aside still covers
   * it: what was measured so far, the calls in flight, this call's worst case
   * (a call that may have been served without usage is charged that much) and
   * `keepUsd` for the stages after this one must all fit `reserved_usd`, which
   * is the most the lesson's Tinker use may cost (spec 1.7(a)). Without that,
   * retries charged at their worst case could pass it. The caller calls
   * stored(cost) once the call's row is in the slice's maps.
   */
  private async student(messages: TinkerChatMessage[], maxTokens: number, samplerPath: string | null, keepUsd = 0):
    Promise<{ ok: true; text: string; cutShort: boolean; cost: number; promptTokens: number; completionTokens: number } | { ok: false; cost: number; noMoney?: true }> {
    const base = this.request.base_model
    const worst = tinkerChatWorstCaseUsd(base, messages, maxTokens)
    const held = Math.ceil(worst * 1e6) / 1e6
    if (this.tinkerSpentUsd() + this.inFlightUsd + held + keepUsd > this.lesson.reserved_usd + 1e-9) return { ok: false, cost: 0, noMoney: true }
    this.inFlightUsd += held
    let answer: Awaited<ReturnType<typeof callTinkerChat>>
    try {
      answer = await callTinkerChat({
        ...(samplerPath ? { samplerPath, adapterBase: base } : { baseModel: base }),
        messages, maxTokens, temperature: TUTOR_TEMPERATURE, timeoutMs: TUTOR_STUDENT_TIMEOUT_MS,
      })
    } catch (e) {
      this.inFlightUsd = Math.max(0, this.inFlightUsd - held)
      throw e
    }
    const charge = tinkerChatCharge(answer, (p, c) => tinkerChatCostUsd(base, p, c), worst)
    // Rounded as the row stores it, so the lesson's sum is the sum of its rows.
    const cost = Math.ceil(charge.usd * 1e6) / 1e6
    // Still counted, now at what it was charged, until stored().
    this.inFlightUsd = Math.max(0, this.inFlightUsd - held) + cost
    if (cost > held + 1e-9) {
      this.overCharged ??= `a call to the small model was reported at more than the lab's estimate of the most it could cost (${usdText(cost)} against ${usdText(held)})`
    }
    if (!answer.ok) return { ok: false, cost }
    // Cut off: the service said so, or the answer has text and used the whole limit (an endpoint may end such an answer
    // without saying "length"). An answer with no text at all is counted as empty, as before.
    const text = cleanText(answer.content)
    const cutShort = answer.finishReason === 'length' || (answer.usageKnown && answer.completionTokens >= maxTokens && text.trim() !== '')
    return { ok: true, text, cutShort, cost, promptTokens: answer.promptTokens, completionTokens: answer.completionTokens }
  }

  /** What teaching leaves for the stages after it: this round's training job and one retest, margin included. */
  private keepAfterTeaching(): number {
    const est = estimateTutor(this.request)
    const training = est.parts.training_usd[this.lesson.round - 1] ?? 0
    return Math.ceil(TINKER_ESTIMATE_MARGIN * training * 1e6) / 1e6 + testCeilingUsd(est, this.request.settings.rounds)
  }

  /** Every question asked TUTOR_SAMPLES times, what is missing only. 'next' when the whole test is graded. */
  private async test(phase: string, samplerPath: string | null): Promise<'next' | 'paused' | 'no_money' | 'over'> {
    const todo: Array<{ s: number; held: boolean; q: number; sample: number; prompt: string; rubric: Rubric; task: RubricTask }> = []
    for (const ref of allQuestions(this.request)) {
      for (let sample = 0; sample < TUTOR_SAMPLES; sample++) {
        const key = keyOf(phase, ref.subskill, ref.held_back, ref.question, sample)
        const a = this.answers.get(key)
        if (a && a.status !== 'retry') continue
        if (this.failedThisSlice.has(key)) continue
        todo.push({ s: ref.subskill, held: ref.held_back, q: ref.question, sample, prompt: ref.task.prompt, rubric: this.request.subskills[ref.subskill].rubric, task: ref.task })
      }
    }
    const A = this.request.settings.max_answer_tokens ?? TUTOR_ANSWER_TOKENS.fallback
    let i = 0
    let noMoney = false
    const worker = async () => {
      while (i < todo.length && !noMoney && !this.overCharged && this.timeFor(TUTOR_STUDENT_TIMEOUT_MS)) {
        const item = todo[i++]
        const key = keyOf(phase, item.s, item.held, item.q, item.sample)
        const before = this.answers.get(key)
        const attempts = (before?.attempts ?? 0) + 1
        const got = await this.student([{ role: 'user', content: item.prompt }], A, samplerPath)
        if (!got.ok && got.noMoney) { noMoney = true; break }
        let row: AnswerRow
        if (got.ok) {
          const graded = passes(item.rubric, item.task, got.text)
          row = {
            phase, subskill: item.s, held_back: item.held, question: item.q, sample: item.sample, status: 'ok', attempts,
            answer: cutBytes(got.text, TUTOR_TEXT_BYTES), score: graded.score, passed: graded.passed, cut_short: got.cutShort,
            too_long: bytesOf(got.text) > TUTOR_TEXT_BYTES, prompt_tokens: got.promptTokens, completion_tokens: got.completionTokens,
            cost_usd: (before?.cost_usd ?? 0) + got.cost,
          }
        } else {
          row = {
            phase, subskill: item.s, held_back: item.held, question: item.q, sample: item.sample,
            status: attempts >= TUTOR_CALL_ATTEMPTS ? 'no_answer' : 'retry', attempts, answer: null, score: null, passed: false, cut_short: null,
            too_long: false, prompt_tokens: null, completion_tokens: null, cost_usd: (before?.cost_usd ?? 0) + got.cost,
          }
          if (row.status === 'retry') this.failedThisSlice.add(key)
        }
        await saveAnswer(this.lesson.run_id, row, got.cost)
        this.answers.set(key, row)
        this.stored(got.cost)
        if (++this.writes % TUTOR_STUDENT_CONCURRENCY === 0) await this.writeProgress()
      }
    }
    await Promise.all(Array.from({ length: Math.min(TUTOR_STUDENT_CONCURRENCY, todo.length) }, worker))
    // A reported cost above the most a call could cost stops the test, graded or not: the next call could not be held either.
    if (this.overCharged) return 'over'
    if (this.phaseDone(phase)) return 'next'
    return noMoney ? 'no_money' : 'paused'
  }

  private unansweredShare(phase: string): number {
    const m = this.map(phase)
    return m.to_grade ? m.unanswered / m.to_grade : 0
  }

  // ---- stages ------------------------------------------------------------------

  private async diagnostic(): Promise<Step> {
    const tested = await this.test('before', null)
    if (tested === 'over') return this.finish('failed', `${this.overCharged}, so the test stopped there`)
    if (tested === 'no_money') return this.finish('failed', NO_MONEY_TEST)
    if (tested === 'paused') return 'paused'
    if (this.unansweredShare('before') > TUTOR_UNANSWERED_MAX) {
      return this.finish('failed', 'more than a tenth of the untrained model\'s answers never came from the training service')
    }
    const { missed } = missesToTeach(this.request, this.marks(), 'before')
    if (!missed) return this.finish('ended', 'the untrained model passed every practice question, so there was nothing to teach')
    await this.moveTo('teaching', 1)
    return 'next'
  }

  private studentPathFor(round: number): string | null {
    if (round === 1) return null
    const leg = this.lesson.train.find(l => l.round === round - 1)
    const path = leg?.result?.sampler_path
    return isSamplerPath(path) ? path : null
  }

  private taughtList(round: number, phase: string = round === 1 ? 'before' : 'after1'): Miss[] {
    return missesToTeach(this.request, this.marks(), phase).taught
  }

  private turnsOf(round: number, miss: Pick<Miss, 'subskill' | 'question'>): TurnRow[] {
    return [...this.turns.values()].filter(t => t.round === round && t.subskill === miss.subskill && t.question === miss.question).sort((a, b) => a.turn - b.turn)
  }

  /** Is this miss finished: solved, explained, or every turn used? */
  private missDone(round: number, miss: Pick<Miss, 'subskill' | 'question'>): boolean {
    const turns = this.turnsOf(round, miss)
    if (turns.some(t => t.kind === 'guide' && t.state === 'graded' && t.passed)) return true
    const T = this.request.settings.guiding_turns
    return turns.some(t => t.kind === 'explain' && t.state !== 'calling') && turns.length >= T + 1
  }

  private async teaching(): Promise<Step> {
    const round = this.lesson.round
    const taught = this.taughtList(round)
    let deferred = false
    for (const miss of taught) {
      if (this.missDone(round, miss)) continue
      if (this.lesson.stop_reason) break
      if (this.age > TUTOR_TEACH_UNTIL_MS) {
        await this.stopTeaching('teaching stopped 3 hours after the lesson opened')
        break
      }
      try {
        const r = await this.teachMiss(round, miss)
        if (r === 'paused') return 'paused'
        if (r === 'deferred') deferred = true
      } catch (e) {
        if (!(e instanceof Stopped)) throw e
        break
      }
      await this.writeProgress()
    }
    // A miss whose call failed in this slice is tried again by the next one; training waits for it.
    if (deferred && !this.lesson.stop_reason && this.age <= TUTOR_TEACH_UNTIL_MS) return 'paused'
    await this.moveTo('training', round)
    return 'next'
  }

  private async stopTeaching(reason: string): Promise<void> {
    await setStopReason(this.lesson.run_id, reason)
    this.lesson.stop_reason ??= reason
  }

  /** The dialogue the student has seen for a miss, up to a turn: only turns whose question reached it. */
  private dialogue(round: number, miss: Miss, uptoTurn: number): TinkerChatMessage[] {
    const out: TinkerChatMessage[] = [{ role: 'user', content: miss.task.prompt }, { role: 'assistant', content: miss.wrong }]
    for (const t of this.turnsOf(round, miss)) {
      if (t.turn >= uptoTurn || t.kind !== 'guide' || t.state !== 'graded' || !t.teacher_text || !t.student_reply || !t.student_answer) continue
      out.push({ role: 'user', content: t.teacher_text }, { role: 'assistant', content: t.student_reply }, { role: 'user', content: TUTOR_RETRY_LINE }, { role: 'assistant', content: t.student_answer })
    }
    return out
  }

  private teacherTurnsSoFar(round: number, miss: Miss, uptoTurn: number): TeacherTurnText[] {
    return this.turnsOf(round, miss)
      .filter(t => t.turn < uptoTurn && t.kind === 'guide' && t.state === 'graded' && t.teacher_text)
      .map(t => ({ guide: t.teacher_text, reply: t.student_reply, answer: t.student_answer }))
  }

  /**
   * Teaches one miss as far as it can go now. 'paused' when the slice is out of
   * time; 'deferred' when a call to the small model failed and is tried again
   * by a later slice, so the other misses go on meanwhile.
   */
  private async teachMiss(round: number, miss: Miss): Promise<'done' | 'paused' | 'deferred'> {
    const T = this.request.settings.guiding_turns
    const A = this.request.settings.max_answer_tokens
    const sub = this.request.subskills[miss.subskill]
    const path = this.studentPathFor(round)
    for (let turn = 1; turn <= T; turn++) {
      let row = this.turns.get(turnKey(round, miss.subskill, miss.question, turn))
      if (!row) {
        if (this.lesson.stop_reason) throw new Stopped()
        if (!this.timeFor(TUTOR_TEACHER_TIMEOUT_MS)) return 'paused'
        row = await this.teacherCall(round, miss, turn, 'guide')
      }
      if (row.state === 'calling') row = await this.lostCall(row)
      if (row.state === 'leaked' || row.state === 'no_question') continue
      if (row.state === 'asked') {
        if (!this.timeFor(TUTOR_STUDENT_TIMEOUT_MS)) return 'paused'
        const key = `reply|${turnKey(round, miss.subskill, miss.question, turn)}`
        if (this.failedThisSlice.has(key)) return 'deferred'
        const messages = [...this.dialogue(round, miss, turn), { role: 'user' as const, content: row.teacher_text as string }]
        const got = await this.student(messages, TUTOR_REPLY_TOKENS, path, this.keepAfterTeaching())
        if (!got.ok && got.noMoney) return this.stop(NO_MONEY_TEACH)
        const next: TurnRow = { ...row, attempts: row.attempts + 1 }
        if (got.ok) {
          next.state = 'replied'
          next.student_reply = cutBytes(got.text, TUTOR_TEXT_BYTES)
          if (got.cutShort) next.reply_cut_short = true
          next.too_long = bytesOf(got.text) > TUTOR_TEXT_BYTES
          next.attempts = 0
        } else if (next.attempts >= TUTOR_CALL_ATTEMPTS) {
          Object.assign(next, { state: 'graded', passed: false, fail: 'the training service gave no reply' })
        } else this.failedThisSlice.add(key)
        await saveTurnStudent(this.lesson.run_id, next, got.cost)
        next.cost_usd = row.cost_usd + got.cost
        this.turns.set(turnKey(round, miss.subskill, miss.question, turn), next)
        this.stored(got.cost)
        row = next
        if (this.overCharged) return this.stop(`${this.overCharged}, so teaching stopped`)
        if (row.state === 'asked') return 'deferred'
      }
      if (row.state === 'replied') {
        if (!this.timeFor(TUTOR_STUDENT_TIMEOUT_MS)) return 'paused'
        const key = `retry|${turnKey(round, miss.subskill, miss.question, turn)}`
        if (this.failedThisSlice.has(key)) return 'deferred'
        const messages: TinkerChatMessage[] = [
          ...this.dialogue(round, miss, turn), { role: 'user', content: row.teacher_text as string },
          { role: 'assistant', content: row.student_reply || ' ' }, { role: 'user', content: TUTOR_RETRY_LINE },
        ]
        const got = await this.student(messages, A, path, this.keepAfterTeaching())
        if (!got.ok && got.noMoney) return this.stop(NO_MONEY_TEACH)
        const next: TurnRow = { ...row, attempts: row.attempts + 1 }
        if (got.ok) {
          const graded = passes(sub.rubric, miss.task, got.text)
          Object.assign(next, {
            state: 'graded', student_answer: cutBytes(got.text, TUTOR_TEXT_BYTES), score: graded.score, passed: graded.passed,
            too_long: row.too_long || bytesOf(got.text) > TUTOR_TEXT_BYTES,
            ...(got.cutShort ? { answer_cut_short: true } : {}),
          })
        } else if (next.attempts >= TUTOR_CALL_ATTEMPTS) {
          Object.assign(next, { state: 'graded', passed: false, fail: 'the training service gave no answer' })
        } else this.failedThisSlice.add(key)
        await saveTurnStudent(this.lesson.run_id, next, got.cost)
        next.cost_usd = row.cost_usd + got.cost
        this.turns.set(turnKey(round, miss.subskill, miss.question, turn), next)
        this.stored(got.cost)
        row = next
        if (this.overCharged) return this.stop(`${this.overCharged}, so teaching stopped`)
        if (row.state === 'replied') return 'deferred'
      }
      if (row.state === 'graded' && row.passed) return 'done'
    }
    // Not solved: one more teacher call for an explanation and an answer.
    let ex = this.turns.get(turnKey(round, miss.subskill, miss.question, T + 1))
    if (!ex) {
      if (this.lesson.stop_reason) throw new Stopped()
      if (!this.timeFor(TUTOR_TEACHER_TIMEOUT_MS)) return 'paused'
      ex = await this.teacherCall(round, miss, T + 1, 'explain')
    }
    if (ex.state === 'calling') await this.lostCall(ex)
    return 'done'
  }

  private async lostCall(row: TurnRow): Promise<TurnRow> {
    const settled = await settleLostTeacherCall(this.lesson.run_id, row)
    const next: TurnRow = { ...row, state: 'no_question', fail: 'lost' }
    if (settled) {
      this.lesson.teacher_usd += row.teacher_cost_usd
      this.lesson.teacher_calls += 1
    }
    this.turns.set(turnKey(row.round, row.subskill, row.question, row.turn), next)
    return next
  }

  /**
   * One teacher call, with its money: the daily check, the reservation on the
   * lesson row, the 'calling' mark, the call, and one statement that settles
   * the turn and the money. Throws Stopped when teaching must stop.
   */
  private async teacherCall(round: number, miss: Miss, turn: number, kind: 'guide' | 'explain'): Promise<TurnRow> {
    const id = this.lesson.run_id
    const model = this.lesson.teacher_model
    this.caps ??= await getModelCapabilities(model).catch(() => null)
    const pricing = this.caps?.pricing
    if (!pricing) return this.stop(`the teacher, ${modelName(model)}, has no known price`)
    if (!teacherTakesLimit(this.caps)) return this.stop(`the teacher, ${modelName(model)}, takes no output limit`)
    if (this.lesson.teacher_calls >= maxTeacherCalls(this.request.settings)) return this.stop('the teacher was called as many times as a lesson allows')
    const sub = this.request.subskills[miss.subskill]
    const system = kind === 'guide' ? TUTOR_GUIDE_SYSTEM : TUTOR_EXPLAIN_SYSTEM
    const userPrompt = teacherUserPrompt({ topic: this.request.topic, subskill: sub.name, rubric: sub.rubric, task: miss.task, wrong: miss.wrong, turns: this.teacherTurnsSoFar(round, miss, turn) }, system)
    const effort = teacherEffort(this.caps)
    const body = buildRequestBody(model, this.caps, system, userPrompt, { jsonOnly: true, webSearch: false, effort, exactLimit: TUTOR_TEACHER_MAX_TOKENS })
    const bytes = (body.messages as Array<{ content: string }>).reduce((a, m) => a + bytesOf(m.content), 0)
    const worst = teacherWorstUsd(bytes, pricing)

    // The day's cap: what was spent, what every open lesson has set aside for its teacher, and this call.
    let spent: number, held: number
    try {
      spent = await spentTodayUsd(this.now, this.lesson.budget_scope)
      held = await openTeacherReservedUsd()
    } catch {
      return this.stop('the lab could not read today\'s spend, so teaching stopped')
    }
    const budget = this.lesson.budget_scope === 'research' ? researchDailyBudgetUsd() : dailyBudgetUsd()
    if (spent + held + worst > budget + 1e-12) return this.stop('another teacher call could pass the lab\'s daily budget, so teaching stopped')
    if (!(await reserveTeacher(id, worst))) return this.stop(`another teacher call could pass the lesson's cap of ${usdText(this.lesson.teacher_cap_usd)} for the teacher, so teaching stopped`)
    const key = { round, subskill: miss.subskill, question: miss.question, turn, kind }
    if (!(await markTeacherCalling(id, key, worst))) {
      await unreserveTeacher(id, worst)
      const fresh = (await loadTurns(id)).find(t => t.round === round && t.subskill === miss.subskill && t.question === miss.question && t.turn === turn)
      if (fresh) {
        this.turns.set(turnKey(round, miss.subskill, miss.question, turn), fresh)
        return fresh
      }
      return this.stop('the lab could not mark a teacher call')
    }

    const res = await withSpendContext({ experimentId: this.lesson.experiment_id, epochNumber: this.lesson.epoch, purpose: TUTOR_TOOL, budgetScope: this.lesson.budget_scope }, () =>
      callModelOnce(model, system, userPrompt, { maxTokensExact: TUTOR_TEACHER_MAX_TOKENS, effort, timeoutMs: TUTOR_TEACHER_TIMEOUT_MS }))
    // A billed call counts at what OpenRouter reported; a call that ran out of time may have been billed and counts at the most it could cost.
    const real = res.usage ? res.usage.cost_usd : !res.ok && res.reason === 'timeout' ? worst : 0
    const targets = leakTargets(sub.rubric, miss.task)
    const row: TurnRow = {
      round, subskill: miss.subskill, question: miss.question, turn, kind, state: 'no_question', teacher_text: null, teacher_answer: null,
      teacher_cost_usd: real, student_reply: null, student_answer: null, score: null, passed: false, too_long: false, attempts: 0,
      fail: res.ok ? null : res.reason, cost_usd: 0,
    }
    if (res.ok && kind === 'guide') {
      const g = readGuide(res.parsed, targets)
      if (g.ok) Object.assign(row, { state: 'asked', teacher_text: g.text })
      else Object.assign(row, { state: g.state, teacher_text: g.text, fail: g.why })
    } else if (res.ok) {
      const e = readExplanation(res.parsed, sub.rubric, miss.task, targets)
      Object.assign(row, {
        state: e.passed ? (e.leaked ? 'leaked' : 'explained') : 'explain_failed',
        teacher_text: e.stored, teacher_answer: e.answer, score: e.score, passed: e.passed, fail: e.why,
      })
      if (e.passed && !e.leaked && !e.explanation) row.fail = row.fail ?? 'the explanation was not usable as context'
    }
    const settled = await settleTeacher(id, row, worst, real)
    if (settled) {
      this.lesson.teacher_usd = settled.teacher_usd
      this.lesson.teacher_calls = settled.teacher_calls
    }
    this.turns.set(turnKey(round, miss.subskill, miss.question, turn), row)
    if (real > worst + 1e-9) {
      await this.stopTeaching(`a teacher call cost more than the lab's estimate of the most (${usdText(real)} against ${usdText(worst)})`)
    }
    const truncated = [...this.turns.values()].filter(t => t.fail === 'truncated').length
    if (truncated >= TUTOR_TRUNCATED_STOP) await this.stopTeaching(`teacher answers do not fit ${TUTOR_TEACHER_MAX_TOKENS} tokens`)
    return row
  }

  private async stop(reason: string): Promise<never> {
    await this.stopTeaching(reason)
    throw new Stopped(reason)
  }

  // ---- training --------------------------------------------------------------------

  /** The exchanges of one round, as the examples read them. */
  private exchanges(round: number): TaughtExchange[] {
    const phase = round === 1 ? 'before' : 'after1'
    const out: TaughtExchange[] = []
    for (const miss of this.taughtList(round, phase)) {
      const turns = this.turnsOf(round, miss)
      if (!turns.length) continue
      const wrongRow = [...this.answers.values()].find(a => a.phase === phase && a.subskill === miss.subskill && !a.held_back && a.question === miss.question && a.answer === miss.wrong)
      out.push({
        subskill: miss.subskill, question: miss.question, task: miss.task, wrong: miss.wrong, wrong_too_long: wrongRow?.too_long === true,
        turns: turns.map(t => ({
          kind: t.kind, state: t.state, guide: t.kind === 'guide' ? t.teacher_text : null,
          reply: t.student_reply, answer: t.kind === 'guide' ? t.student_answer : t.teacher_answer,
          passed: t.passed, too_long: t.too_long,
          ...(t.kind === 'explain' ? { explanation: t.state === 'explained' && !t.fail ? t.teacher_text : null } : {}),
        })),
      })
    }
    return out
  }

  /** The training set of a round: kept answers of the diagnostic, then the exchanges of every round so far. */
  examplesFor(round: number): { request: TinkerRequest | null; error: string | null; counts: ExampleCounts } {
    const kept: Array<{ task: RubricTask; answer: string; too_long?: boolean }> = []
    for (const [i, s] of this.request.subskills.entries()) {
      for (const [j, task] of s.practice.entries()) {
        const mine = [...this.answers.values()].filter(a => a.phase === 'before' && a.subskill === i && !a.held_back && a.question === j).sort((a, b) => a.sample - b.sample)
        if (mine.length >= TUTOR_SAMPLES && mine.every(a => a.status === 'ok' && a.passed)) kept.push({ task, answer: mine[0].answer ?? '', too_long: mine[0].too_long })
      }
    }
    const exchanges: TaughtExchange[] = []
    for (let r = 1; r <= round; r++) exchanges.push(...this.exchanges(r))
    const built = buildExamples({ kept, exchanges, maxExampleBytes: TINKER_MAX_EXAMPLE_BYTES, maxDatasetBytes: TINKER_MAX_DATASET_BYTES })
    if (built.examples.length < TUTOR_MIN_EXAMPLES) {
      return { request: null, error: `only ${built.examples.length} usable exchanges came out of the lesson and a run needs ${TUTOR_MIN_EXAMPLES}`, counts: built.counts }
    }
    const s = this.request.settings
    const read = normalizeTinkerRequest({
      purpose: this.request.purpose, base_model: this.request.base_model,
      examples: built.examples.map(e => ({ messages: e.messages })),
      settings: { rank: s.rank, learning_rate: s.learning_rate, epochs: s.epochs, batch_size: s.batch_size },
    }, [this.request.base_model])
    if ('error' in read) return { request: null, error: `the lesson's examples were refused: ${read.error}`, counts: built.counts }
    return { request: read.request, error: null, counts: built.counts }
  }

  private tinkerSpentUsd(): number {
    let total = 0
    for (const a of this.answers.values()) total += a.cost_usd
    for (const t of this.turns.values()) total += t.cost_usd
    // A job whose result is not in yet counts at its whole budget: it may be training.
    for (const leg of this.lesson.train) total += leg.cost_usd ?? (leg.state === 'running' || (leg.state === 'starting' && leg.started_at !== null) ? leg.budget_usd : 0)
    return total
  }

  private async saveLeg(leg: TrainLeg): Promise<void> {
    this.lesson.train = [...this.lesson.train.filter(l => l.round !== leg.round), leg].sort((a, b) => a.round - b.round)
    await setTrain(this.lesson.run_id, this.lesson.train)
  }

  /** A round whose training or retest did not happen: round 1 ends the lesson, round 2 leaves round 1 standing. */
  private async roundFailed(round: number, reason: string, status: 'ended' | 'failed' = 'failed'): Promise<Step> {
    if (round === 1) return this.finish(status, reason)
    this.roundTwoNote = `round 2 did not finish: ${reason}`
    await this.stopTeaching(this.roundTwoNote)
    await this.moveTo('closing', round)
    return 'next'
  }
  /** Why round 2 did not run or did not finish, for the closing record. A later slice reads it from stop_reason. */
  private roundTwoNote: string | null = null

  private async training(): Promise<Step> {
    const round = this.lesson.round
    let leg = this.lesson.train.find(l => l.round === round)
    // A leg stored by an earlier slice and not confirmed started: the runner is asked for it by name before anything is sent.
    const resumed = leg?.state === 'starting'
    let request: TinkerRequest | null = null
    if (!leg || leg.state === 'starting') {
      const built = this.examplesFor(round)
      if (!built.request) return this.roundFailed(round, built.error as string, round === 1 && built.error?.startsWith('only ') ? 'ended' : 'failed')
      request = built.request
      if (!leg) {
        const est = estimateTutor(this.request)
        const budget = Math.floor((this.lesson.reserved_usd - this.tinkerSpentUsd() - testCeilingUsd(est, this.request.settings.rounds)) * 1e6) / 1e6
        const needed = estimateTinkerRun(request).max_cost_usd
        if (needed > budget) return this.roundFailed(round, `the training job could cost ${usdText(needed)} and ${usdText(Math.max(0, budget))} of the money set aside is left for it`)
        leg = {
          round, run_id: round === 1 ? this.lesson.slug : newAdapterSlug(this.lesson.epoch), call_id: null, started_at: null, split_salt: newSplitSalt(),
          examples: request.examples.length, counts: built.counts as unknown as Record<string, number>, sha256: request.dataset_sha256, budget_usd: budget,
          state: 'starting', result: null, cost_usd: null, usage_known: false,
        }
        // Stored before the start, so a slice that dies after it asks the runner by this name and never starts a second job.
        await this.saveLeg(leg)
      }
    }
    if (leg.state === 'starting') {
      if (!this.timeFor(30_000)) return 'paused'
      let callId = leg.call_id ?? (resumed ? await findTinkerCall(leg.run_id) : null)
      if (!callId) {
        const started = await startTinkerJob(tinkerJobBody(request as TinkerRequest, {
          splitSalt: leg.split_salt, budgetUsd: leg.budget_usd, label: `epoch ${this.lesson.epoch} ${this.lesson.slug} tutor r${round}`, runId: leg.run_id,
          ...(tinkerKeepFlag() ? { exportWeights: true } : {}),
        }))
        if (started.ok) callId = started.callId
        else if (started.unconfirmed) {
          callId = await findTinkerCall(leg.run_id)
          if (!callId) {
            // It may be training. The next slice asks the runner for it by name, and the runner starts one job for one name.
            await this.saveLeg({ ...leg, started_at: leg.started_at ?? new Date().toISOString() })
            return 'paused'
          }
        } else {
          await this.saveLeg({ ...leg, state: 'failed', cost_usd: 0, reason: started.error })
          return this.roundFailed(round, `the training job was not started: ${started.error}`)
        }
      }
      leg = { ...leg, call_id: callId, state: 'running', started_at: leg.started_at ?? new Date().toISOString() }
      await this.saveLeg(leg)
    }
    if (leg.state === 'running') {
      const wait = Math.max(0, Math.min(this.deadlineAt - TUTOR_STOP_BEFORE_MS - Date.now(), 300_000))
      const poll = await waitForTinkerJob(leg.call_id as string, wait, this.pollMs)
      if (poll.state !== 'done' && poll.state !== 'failed') {
        if (this.now.getTime() - Date.parse(leg.started_at ?? this.lesson.created_at) <= TINKER_LOST_AFTER_MS) return 'paused'
        leg = { ...leg, state: 'failed', cost_usd: leg.budget_usd, usage_known: false, reason: 'no result long after its time limit' }
      } else {
        const r = poll.state === 'done' ? normalizeTinkerResult(poll.result) : { ...normalizeTinkerResult(null), status: 'failed' as const, reason: `the runner was lost: ${poll.error}` }
        const usageKnown = poll.state === 'done' && r.status !== 'failed'
        const { samples: _samples, ...kept } = r
        const measured = usageKnown ? tinkerCostUsd(this.request.base_model, r.tokens) : leg.budget_usd
        // The runner stops a job before its budget. A report above it is kept as reported (the lab cannot hold a reported
        // figure) and the round stops there, with its own reason, so the record says why the money set aside was passed.
        const over = usageKnown && measured > leg.budget_usd + 1e-6
        leg = {
          ...leg, state: r.status === 'ok' && !over ? 'done' : 'failed', result: kept as unknown as Record<string, unknown>, usage_known: usageKnown,
          cost_usd: measured,
          reason: over ? `the training job reported more use than its budget (${usdText(measured)} against ${usdText(leg.budget_usd)}), so its adapter was not tested` : r.reason,
          ...(over ? { over_budget: true } : {}),
        }
      }
      await this.saveLeg(leg)
    }
    if (leg.state === 'done') {
      await this.moveTo('retest', round)
      return 'next'
    }
    return this.roundFailed(round, `training failed: ${leg.reason ?? 'the runner gave no usable answer'}`)
  }

  private async retest(): Promise<Step> {
    const round = this.lesson.round
    const leg = this.lesson.train.find(l => l.round === round)
    const path = leg?.result?.sampler_path
    if (!isSamplerPath(path)) return this.roundFailed(round, 'the trained adapter has no saved path')
    const phase = `after${round}`
    const tested = await this.test(phase, path)
    if (tested === 'over') return this.roundFailed(round, `${this.overCharged}, so the test stopped there`)
    if (tested === 'no_money') return this.roundFailed(round, NO_MONEY_TEST)
    if (tested === 'paused') return 'paused'
    if (this.unansweredShare(phase) > TUTOR_UNANSWERED_MAX) return this.roundFailed(round, 'more than a tenth of the trained model\'s answers never came from the training service')
    if (round === 1 && this.request.settings.rounds === 2) {
      const reason = await this.roundTwoBlocked()
      if (!reason) {
        await this.moveTo('teaching', 2)
        return 'next'
      }
      this.roundTwoNote = `round 2 did not run: ${reason}`
      await this.stopTeaching(this.roundTwoNote)
    }
    await this.moveTo('closing', round)
    return 'next'
  }

  /** Why a second round does not run, or null when it does. It never reads a held back answer. */
  private async roundTwoBlocked(): Promise<string | null> {
    const seen = this.map('after1').seen_overall
    if (seen && seen.passed >= seen.total) return 'the trained model passed every practice question'
    if (this.lesson.stop_reason) return `teaching had stopped: ${this.lesson.stop_reason}`
    if (this.age >= TUTOR_TEACH_UNTIL_MS) return 'the lesson was older than 3 hours'
    const est = estimateTutor(this.request)
    const left = this.lesson.reserved_usd - this.tinkerSpentUsd()
    if (roundTwoNeedUsd(est, 2) > left) return 'the money set aside does not cover a second round'
    this.caps ??= await getModelCapabilities(this.lesson.teacher_model).catch(() => null)
    if (!this.caps?.pricing) return 'the teacher has no known price'
    const worst = teacherWorstUsd(TUTOR_TEACHER_PROMPT_MAX_BYTES, this.caps.pricing)
    if (this.lesson.teacher_usd + this.lesson.teacher_reserved_usd + worst > this.lesson.teacher_cap_usd) return 'the teacher\'s cap does not cover another call'
    return null
  }

  // ---- closing ------------------------------------------------------------------------

  /** The last round whose retest finished. */
  private finalRound(): number | null {
    for (let r = this.lesson.train.length; r >= 1; r--) {
      const leg = this.lesson.train.find(l => l.round === r)
      if (leg?.state === 'done' && isSamplerPath(leg.result?.sampler_path) && this.phaseDone(`after${r}`) && this.unansweredShare(`after${r}`) <= TUTOR_UNANSWERED_MAX) return r
    }
    return null
  }

  private async closeNormally(): Promise<Step> {
    // A lesson that moved here for a stated reason (and whose slice died before the close) closes with that reason.
    if (this.lesson.close_status) return this.finish(this.lesson.close_status, this.lesson.close_reason)
    const final = this.finalRound()
    if (final === null) return this.finish('failed', 'no test of a trained adapter finished')
    const reason = final < this.request.settings.rounds ? this.roundTwoNote ?? this.lesson.stop_reason ?? 'round 2 did not finish' : this.lesson.stop_reason
    return this.finish('ok', reason)
  }

  private async closeForAge(): Promise<void> {
    const final = this.finalRound()
    if (final !== null) {
      await this.finish('ok', `round ${final + 1} did not finish in 6 hours`)
      return
    }
    await this.finish('failed', `the lesson did not finish in 6 hours (it was at the ${this.stage} stage)`)
  }

  /** The record the run row keeps when the lesson closes. */
  record(final: number | null): Record<string, unknown> {
    const summary = summarizeLesson(this.request, [...this.answers.values()], [...this.turns.values()], this.lesson, final)
    const leg = final ? this.lesson.train.find(l => l.round === final) : null
    return {
      kind: 'tutor', topic: this.request.topic, teacher_model: this.lesson.teacher_model, rounds_done: final ?? 0,
      skill_map: summary.skill_map, overall: summary.overall, flags: summary.flags, teaching: summary.teaching, examples: summary.examples,
      training: this.lesson.train.map(l => ({ round: l.round, ...publicLeg(l) })),
      tokens: sumTokens(this.lesson.train), teacher: { calls: this.lesson.teacher_calls, usd: round6(this.lesson.teacher_usd) },
      teaching_stopped: this.lesson.stop_reason ? publicCut(this.lesson.stop_reason, 300) : null,
      ...(leg && isExternalPath(leg.result?.external_path) ? { external_path: leg.result!.external_path } : {}),
      measured_by: TUTOR_MEASURED_BY,
    }
  }

  private async finish(status: 'ok' | 'ended' | 'failed' | 'error', reason: string | null): Promise<Step> {
    const run = this.runRow as TinkerRunRow
    const final = status === 'ok' ? this.finalRound() : null
    const leg = final ? this.lesson.train.find(l => l.round === final) ?? null : null
    const path = leg && isSamplerPath(leg.result?.sampler_path) ? leg.result!.sampler_path as string : null
    const ttl = typeof leg?.result?.ttl_seconds === 'number' ? leg.result.ttl_seconds as number : tinkerTtlDays() * 86_400
    const expiresAt = path ? adapterExpiry(run.created_at, ttl, this.now) : null
    const cost = Math.round(this.tinkerSpentUsd() * 1e6) / 1e6
    const result = this.record(final)
    const examples = leg?.examples ?? 0
    // The status and reason are stored with the move to 'closing', so a slice that dies before the close below closes the lesson the same way.
    await setClosing(this.lesson.run_id, status, reason)
    this.stage = 'closing'
    this.lesson.stage = 'closing'
    this.lesson.close_status = status
    this.lesson.close_reason = reason
    // One statement: the run row is closed once, the reservation settled and the ledger row written (only by the request that closed it).
    const closed = await closeLessonRun({
      runId: this.lesson.run_id, status, reason, costUsd: cost, result, samplerPath: path, expiresAt, examples,
      spendDay: this.lesson.spend_day, reservedUsd: this.lesson.reserved_usd, now: this.now,
      ledger: { experimentId: this.lesson.experiment_id, epoch: this.lesson.epoch, assigned: run.assigned_model ?? run.model, budgetScope: this.lesson.budget_scope },
    })
    if (closed) {
      await refreshEpochCost(this.lesson.experiment_id, this.lesson.epoch)
      const tool = this.toolRun(run, status, reason, result, path, expiresAt, cost)
      await recordToolRun(tool.row)
      this.outcome = { tool: TUTOR_TOOL, status: tool.row.status, summary: `${modelName(run.model)}'s Socratic lesson: ${tool.line}` }
    }
    await this.moveTo('done')
    this.finalStatus = closed ? status : 'closed'
    return 'closed'
  }

  /**
   * The lesson's tool run row and its one line: written by the request that
   * closed the run, or, when that request stopped before it could, by the
   * next slice from the stored run row (run()).
   */
  private toolRun(run: TinkerRunRow, status: 'ok' | 'ended' | 'failed' | 'error', reason: string | null, result: Record<string, unknown>, path: string | null, expiresAt: string | null, cost: number): { row: ToolRunInput; line: string } {
    const toolStatus: ToolRunStatus = status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'failed'
    const name = shownName(run)
    const line = describeLesson({ status, reason, result, slug: run.slug, base: this.request.base_model, expiresAt, tinkerUsd: cost, teacherUsd: this.lesson.teacher_usd, name })
    return {
      line,
      row: {
        experimentId: this.lesson.experiment_id, epoch: this.lesson.epoch, model: run.model, tool: TUTOR_TOOL,
        requestSummary: tutorSummary(this.request, this.lesson.teacher_model), status: toolStatus, costUsd: cost + this.lesson.teacher_usd, outputTail: line,
        detail: {
          ...result,
          ...(path ? { adapter: `lab/${run.slug}`, expires_at: expiresAt } : {}),
          ...(name ? { name } : {}),
          base_model: this.request.base_model,
          measured: { by: TUTOR_MEASURED_BY },
          split_salt: this.lesson.train.map(l => l.split_salt),
          cost: {
            tinker_estimated_usd: cost, tinker_set_aside_usd: this.lesson.reserved_usd, teacher_usd: round6(this.lesson.teacher_usd), teacher_max_usd: this.lesson.teacher_cap_usd,
            basis: `Tinker use: token counts at Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}, or the most a call could cost where its usage is unknown; an estimate, not a billed amount. The teacher: OpenRouter's reported cost of each call.`,
          },
          ...(reason ? { reason } : {}),
        },
      },
    }
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6

function publicLeg(l: TrainLeg): Record<string, unknown> {
  const r = l.result ?? {}
  const pick = (k: string) => (k in r ? r[k] : null)
  return {
    status: l.state, examples: l.examples, counts: l.counts, sha256: l.sha256, cost_usd: l.cost_usd, usage_known: l.usage_known,
    n_train: pick('n_train'), n_holdout: pick('n_holdout'), steps_planned: pick('steps_planned'), steps_done: pick('steps_done'),
    stopped_early: pick('stopped_early'), holdout_loss_before: pick('holdout_loss_before'), holdout_loss_after: pick('holdout_loss_after'),
    train_loss_first: pick('train_loss_first'), train_loss_last: pick('train_loss_last'), ttl_seconds: pick('ttl_seconds'), wall_seconds: pick('wall_seconds'),
    ...(l.reason ? { reason: publicCut(l.reason, 300) } : {}),
    ...(l.over_budget ? { over_budget: true } : {}),
  }
}

function sumTokens(legs: TrainLeg[]): Record<string, number> {
  const out = { train: 0, eval: 0, sample_prompt: 0, sample_completion: 0 }
  for (const l of legs) {
    const t = (l.result?.tokens ?? {}) as Record<string, unknown>
    for (const k of Object.keys(out) as Array<keyof typeof out>) out[k] += typeof t[k] === 'number' ? t[k] as number : 0
  }
  return out
}

// ---------------------------------------------------------------------------
// The lesson in numbers: shared by closing and the public record
// ---------------------------------------------------------------------------

export interface LessonSummary {
  skill_map: Array<{ name: string; before: Cell | null; after: Cell | null; seen_before: { passed: number; total: number } | null; seen_after: { passed: number; total: number } | null; seen_only: boolean; got_worse: boolean }>
  overall: { before: Cell | null; after: Cell | null }
  flags: ReturnType<typeof tutorFlags>
  /** cut_off: turns of teaching in which the token limit cut off the small model's reply or its answer again. */
  teaching: { missed: number; taught: number; solved: number; explained: number; teacher_failed: number; leaked: number; not_taught: number; teacher_calls: number; cut_off: number }
  examples: { kept: number; guided: number; answer: number; explained: number; left_out: number; total: number } | null
  after_round: number | null
}

/** Counts every number of a lesson from its stored rows. `final` is the round whose test stands, or null for the newest finished one. */
export function summarizeLesson(request: TinkerTutorRequest, answers: AnswerRow[], turns: TurnRow[], lesson: Pick<LessonRow, 'train' | 'teacher_calls'>, final: number | null = null): LessonSummary {
  const marks = answers as Array<AnswerMark & { answer: string | null }>
  const before = phaseMap(request, marks, 'before')
  let round = final
  if (round === null) {
    for (let r = 2; r >= 1; r--) {
      const m = phaseMap(request, marks, `after${r}`)
      if (m.graded > 0) { round = r; break }
    }
  }
  const after = round ? phaseMap(request, marks, `after${round}`) : null
  const teacherFailed = turns.filter(t => t.kind === 'explain' && t.state === 'explain_failed' && t.teacher_answer !== null).length
  const flags = tutorFlags({ request, before, after, marks, teacherFailed, afterPhase: round ? `after${round}` : null })
  let missed = 0, taught = 0, solved = 0, explained = 0, leaked = 0
  for (const r of [1, 2]) {
    const phase = r === 1 ? 'before' : 'after1'
    const ts = turns.filter(t => t.round === r)
    if (r === 2 && !ts.length) continue
    const list = missesToTeach(request, marks, phase)
    missed += list.missed
    for (const m of list.taught) {
      const mine = ts.filter(t => t.subskill === m.subskill && t.question === m.question)
      if (!mine.length) continue
      taught++
      if (mine.some(t => t.kind === 'guide' && t.state === 'graded' && t.passed)) solved++
      else if (mine.some(t => t.kind === 'explain' && t.passed)) explained++
    }
    leaked += ts.filter(t => t.state === 'leaked').length
  }
  const counts = [...lesson.train].sort((a, b) => b.round - a.round)[0]?.counts as Record<string, number> | undefined
  return {
    skill_map: request.subskills.map((s, i) => ({
      name: s.name, before: before.held[i], after: after?.held[i] ?? null, seen_before: before.seen[i], seen_after: after?.seen[i] ?? null,
      seen_only: flags.seen_only_by[i], got_worse: flags.got_worse.includes(s.name),
    })),
    overall: { before: before.overall, after: after?.overall ?? null },
    flags,
    teaching: {
      missed, taught, solved, explained, teacher_failed: teacherFailed, leaked, not_taught: Math.max(0, missed - taught), teacher_calls: lesson.teacher_calls,
      cut_off: turns.filter(t => t.reply_cut_short === true || t.answer_cut_short === true).length,
    },
    examples: counts ? { kept: counts.kept ?? 0, guided: counts.guided ?? 0, answer: counts.answer ?? 0, explained: counts.explained ?? 0, left_out: counts.left_out ?? 0, total: counts.total ?? 0 } : null,
    after_round: round,
  }
}

/**
 * The flags of a tool run line, within `room` bytes: every reason when they
 * fit, or else as many as fit from the front (tutorFlags puts the shared
 * answers reasons last) with the number left to the lesson's record. The
 * store keeps the end of a line that is too long, so without this a lesson
 * with many flags lost the start of its line, where the pass counts are.
 */
function flagsWithin(reasons: string[], room: number): string {
  if (!reasons.length) return ''
  for (let n = reasons.length; n > 0; n--) {
    const left = reasons.length - n
    const text = `; FLAG: ${reasons.slice(0, n).join('; ')}${left ? `; and ${left} more on the lesson's record` : ''}`
    if (Buffer.byteLength(text, 'utf8') <= room) return text
  }
  return `; FLAG: ${reasons.length} on the lesson's record`
}

/** Room kept below the stored length of a tool run line (TOOL_OUTPUT_TAIL_BYTES), for what cleaning the line may add. */
const LINE_MARGIN_BYTES = 96

/**
 * The one line of the tool run (spec 1.9). Says what was counted, by whom, and
 * that the Tinker cost is an estimate. The number of flags stands beside the
 * pass counts: the next epoch's models are given the first 300 characters of
 * this line (recentToolContext), which end before the reasons.
 */
export function describeLesson(input: {
  status: string; reason: string | null; result: Record<string, unknown>; slug: string; base: string; expiresAt: string | null
  tinkerUsd: number; teacherUsd: number; name: string | null
}): string {
  const r = input.result as { overall?: { before: Cell | null; after: Cell | null }; skill_map?: LessonSummary['skill_map']; teaching?: LessonSummary['teaching']; flags?: { reasons?: string[] } }
  const costs = `estimated Tinker cost $${input.tinkerUsd.toFixed(4)} (token counts at Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}, not a billed amount); teacher cost $${input.teacherUsd.toFixed(4)} (OpenRouter's reported cost)`
  const reasons = Array.isArray(r.flags?.reasons) ? r.flags.reasons.filter(x => typeof x === 'string') : []
  const tail = `; ${costs}; ${TUTOR_MEASURE_NOTE}`
  const line = (head: string) => `${head}${flagsWithin(reasons, TOOL_OUTPUT_TAIL_BYTES - LINE_MARGIN_BYTES - Buffer.byteLength(head + tail, 'utf8'))}${tail}`
  if (input.status !== 'ok') return line(`${input.status}: ${input.reason ?? 'unknown'}`)
  const b = r.overall?.before, a = r.overall?.after
  const n = b?.total ?? a?.total ?? 0
  const bands = (r.skill_map ?? []).map(s => `${s.name} ${s.before ? s.before.band : '?'} to ${s.after ? s.after.band : '?'}`).join(', ')
  const t = r.teaching
  const adapter = `adapter lab/${input.slug}${input.name ? ` named "${input.name}"` : ''} on ${input.base}${input.expiresAt ? `, kept until ${input.expiresAt.slice(0, 10)}` : ''}`
  const cut = t?.cut_off ? ` (in ${t.cut_off} turn${t.cut_off === 1 ? '' : 's'} of teaching the token limit cut off the small model's reply or answer)` : ''
  const flagged = reasons.length ? `, with ${reasons.length} flag${reasons.length === 1 ? '' : 's'} on the lesson's record` : ''
  return line(`COUNTED BY THE LAB, with rules a model wrote: held back answers passed: ${b?.passed ?? '?'} of ${n} before, ${a?.passed ?? '?'} of ${n} after${flagged}; pass bands by subskill ${bands}; ${t?.solved ?? 0} of ${t?.missed ?? 0} missed practice questions solved by guiding questions, ${t?.explained ?? 0} explained${cut}; ${adapter}${input.reason ? `; ${input.reason}` : ''}`)
}

/** For the public record: the explanation's shown copy. */
export function shownExplanation(text: string | null): string {
  return text ? publicCut(text, TUTOR_EXPLAIN_SHOWN_BYTES) : ''
}
