/**
 * What the database holds for the Socratic lesson (tinker-tutor.ts):
 *
 *   tutor_lessons    one row per lesson while it runs and after: its stage,
 *                    the request as read, the teacher and its money (spent,
 *                    and set aside for a call that has not answered), the
 *                    training legs, the public progress record and the lease
 *                    of the slice that is moving it.
 *   tutor_answers    one row per sampled answer of every test: graded by the
 *                    lab, stored as soon as it answers.
 *   tutor_turns      one row per turn of a taught question: the teacher's
 *                    question or explanation, the student's reply and its
 *                    answer again, graded by the lab.
 *
 * The run row itself (tinker_runs, kind 'tutor', status 'lesson' while open)
 * and tutor_held_hashes are made by tinker-store.ts, the only file that alters
 * tinker_runs. This file writes the lesson's hashes when it opens and closes
 * the run row once, in the same statement that settles its Tinker reservation.
 *
 * Every call writes its row as soon as it answers, so a slice that dies loses
 * one call at most. A teacher call is marked 'calling' before it is sent, so a
 * slice that dies during one never sends it again: the turn is counted as used
 * at its worst case cost.
 */
import { sql } from '@vercel/postgres'
import { ensureSpendTable } from './spend.js'
import { ensureTinkerExtras, ensureTinkerTables, utcDay } from './tinker-store.js'
import type { TinkerTutorRequest } from './tinker-tutor.js'

let ready: Promise<void> | null = null
export function ensureTutorTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await ensureTinkerTables()
      await ensureTinkerExtras()
      await sql`
        CREATE TABLE IF NOT EXISTS tutor_lessons (
          run_id UUID PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          stage TEXT NOT NULL,
          round INTEGER NOT NULL DEFAULT 1,
          request JSONB NOT NULL,
          teacher_model TEXT NOT NULL,
          teacher_cap_usd NUMERIC(12,6) NOT NULL,
          teacher_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          teacher_reserved_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          teacher_calls INTEGER NOT NULL DEFAULT 0,
          budget_scope TEXT NOT NULL,
          experiment_id UUID NOT NULL,
          epoch INTEGER NOT NULL,
          spend_day TEXT NOT NULL,
          reserved_usd NUMERIC(12,6) NOT NULL,
          train JSONB NOT NULL DEFAULT '[]',
          train_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          progress JSONB,
          lease_until TIMESTAMP WITH TIME ZONE,
          stop_reason TEXT
        )
      `
      // How a lesson is to close, stored before it moves to 'closing', so a slice that dies there closes it the same way.
      await sql`ALTER TABLE tutor_lessons ADD COLUMN IF NOT EXISTS close_status TEXT`
      await sql`ALTER TABLE tutor_lessons ADD COLUMN IF NOT EXISTS close_reason TEXT`
      await sql`CREATE INDEX IF NOT EXISTS idx_tutor_lessons_open ON tutor_lessons(stage, created_at)`
      // The lessons-per-day limit, held by one conditional statement (two experiments' epochs can run at the same time).
      await sql`CREATE TABLE IF NOT EXISTS tutor_day_slots (day TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)`
      await sql`
        CREATE TABLE IF NOT EXISTS tutor_answers (
          run_id UUID NOT NULL,
          phase TEXT NOT NULL,
          subskill INTEGER NOT NULL,
          held_back BOOLEAN NOT NULL,
          question INTEGER NOT NULL,
          sample INTEGER NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 1,
          answer TEXT,
          score NUMERIC(6,4),
          passed BOOLEAN NOT NULL DEFAULT FALSE,
          cut_short BOOLEAN,
          too_long BOOLEAN NOT NULL DEFAULT FALSE,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          PRIMARY KEY (run_id, phase, subskill, held_back, question, sample)
        )
      `
      await sql`
        CREATE TABLE IF NOT EXISTS tutor_turns (
          run_id UUID NOT NULL,
          round INTEGER NOT NULL,
          subskill INTEGER NOT NULL,
          question INTEGER NOT NULL,
          turn INTEGER NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          teacher_text TEXT,
          teacher_answer TEXT,
          teacher_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          student_reply TEXT,
          student_answer TEXT,
          score NUMERIC(6,4),
          passed BOOLEAN NOT NULL DEFAULT FALSE,
          too_long BOOLEAN NOT NULL DEFAULT FALSE,
          attempts INTEGER NOT NULL DEFAULT 0,
          fail TEXT,
          cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          PRIMARY KEY (run_id, round, subskill, question, turn)
        )
      `
    })().catch(e => {
      ready = null
      throw e
    })
  }
  return ready
}

/** For tests: forget that the tables were made. */
export function resetTutorTables(): void {
  ready = null
}

const usd = (v: number) => (Number.isFinite(v) && v > 0 ? Math.ceil(v * 1e6) / 1e6 : 0)
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
function json<T>(v: unknown, fallback: T): T {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T } catch { return fallback }
  }
  return v === null || v === undefined ? fallback : v as T
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type LessonStage = 'diagnostic' | 'teaching' | 'training' | 'retest' | 'closing' | 'done'

/** One training leg: a `train` job of one round. */
export interface TrainLeg {
  round: number
  /** The job's name at the runner: the lesson's slug for round 1, a second slug for round 2. */
  run_id: string
  call_id: string | null
  started_at: string | null
  split_salt: string
  examples: number
  counts: Record<string, number>
  sha256: string
  budget_usd: number
  state: 'starting' | 'running' | 'done' | 'failed'
  /** normalizeTinkerResult fields without samples. The sampler path stays here, never in the public record. */
  result: Record<string, unknown> | null
  cost_usd: number | null
  usage_known: boolean
  reason?: string | null
}

export interface LessonProgress { graded: number; to_grade: number; taught: number; to_teach: number; seq: number; updated_at: string }

export interface LessonRow {
  run_id: string
  slug: string
  created_at: string
  stage: LessonStage
  round: number
  request: TinkerTutorRequest
  teacher_model: string
  teacher_cap_usd: number
  teacher_usd: number
  teacher_reserved_usd: number
  teacher_calls: number
  budget_scope: 'classic' | 'research'
  experiment_id: string
  epoch: number
  spend_day: string
  reserved_usd: number
  train: TrainLeg[]
  train_usd: number
  progress: LessonProgress | null
  lease_until: string | null
  stop_reason: string | null
  /** Set when the lesson moved to 'closing' for a stated reason; null when closing is to decide from the record. */
  close_status: 'ok' | 'ended' | 'failed' | 'error' | null
  close_reason: string | null
}

export function lessonRow(r: Record<string, unknown>): LessonRow {
  return {
    run_id: String(r.run_id ?? ''),
    slug: String(r.slug ?? ''),
    created_at: iso(r.created_at) ?? '',
    stage: String(r.stage ?? 'diagnostic') as LessonStage,
    round: Number(r.round) || 1,
    request: json<TinkerTutorRequest>(r.request, null as unknown as TinkerTutorRequest),
    teacher_model: String(r.teacher_model ?? ''),
    teacher_cap_usd: num(r.teacher_cap_usd),
    teacher_usd: num(r.teacher_usd),
    teacher_reserved_usd: num(r.teacher_reserved_usd),
    teacher_calls: Number(r.teacher_calls) || 0,
    budget_scope: r.budget_scope === 'research' ? 'research' : 'classic',
    experiment_id: String(r.experiment_id ?? ''),
    epoch: Number(r.epoch) || 0,
    spend_day: String(r.spend_day ?? ''),
    reserved_usd: num(r.reserved_usd),
    train: json<TrainLeg[]>(r.train, []),
    train_usd: num(r.train_usd),
    progress: json<LessonProgress | null>(r.progress, null),
    lease_until: iso(r.lease_until),
    stop_reason: r.stop_reason ? String(r.stop_reason) : null,
    close_status: r.close_status === 'ok' || r.close_status === 'ended' || r.close_status === 'failed' || r.close_status === 'error' ? r.close_status : null,
    close_reason: r.close_reason ? String(r.close_reason) : null,
  }
}

export interface AnswerRow {
  phase: string
  subskill: number
  held_back: boolean
  question: number
  sample: number
  status: 'ok' | 'retry' | 'no_answer'
  attempts: number
  answer: string | null
  score: number | null
  passed: boolean
  cut_short: boolean | null
  /** The answer came back with no text (read from the row: the public reads do not carry every answer's text). */
  empty?: boolean
  too_long: boolean
  prompt_tokens: number | null
  completion_tokens: number | null
  cost_usd: number
}

export function answerRow(r: Record<string, unknown>): AnswerRow {
  return {
    phase: String(r.phase ?? ''),
    subskill: Number(r.subskill) || 0,
    held_back: r.held_back === true,
    question: Number(r.question) || 0,
    sample: Number(r.sample) || 0,
    status: (['ok', 'retry', 'no_answer'].includes(String(r.status)) ? String(r.status) : 'retry') as AnswerRow['status'],
    attempts: Number(r.attempts) || 0,
    answer: typeof r.answer === 'string' ? r.answer : null,
    score: r.score === null || r.score === undefined ? null : num(r.score),
    passed: r.passed === true,
    cut_short: r.cut_short === null || r.cut_short === undefined ? null : r.cut_short === true,
    ...(r.empty === true ? { empty: true } : {}),
    too_long: r.too_long === true,
    prompt_tokens: r.prompt_tokens === null || r.prompt_tokens === undefined ? null : Number(r.prompt_tokens),
    completion_tokens: r.completion_tokens === null || r.completion_tokens === undefined ? null : Number(r.completion_tokens),
    cost_usd: num(r.cost_usd),
  }
}

export type TurnState = 'calling' | 'asked' | 'replied' | 'graded' | 'leaked' | 'no_question' | 'explained' | 'explain_failed'

export interface TurnRow {
  round: number
  subskill: number
  question: number
  turn: number
  kind: 'guide' | 'explain'
  state: TurnState
  teacher_text: string | null
  teacher_answer: string | null
  teacher_cost_usd: number
  student_reply: string | null
  student_answer: string | null
  score: number | null
  passed: boolean
  too_long: boolean
  attempts: number
  fail: string | null
  cost_usd: number
}

export function turnRow(r: Record<string, unknown>): TurnRow {
  return {
    round: Number(r.round) || 1,
    subskill: Number(r.subskill) || 0,
    question: Number(r.question) || 0,
    turn: Number(r.turn) || 1,
    kind: r.kind === 'explain' ? 'explain' : 'guide',
    state: String(r.state ?? 'calling') as TurnState,
    teacher_text: typeof r.teacher_text === 'string' ? r.teacher_text : null,
    teacher_answer: typeof r.teacher_answer === 'string' ? r.teacher_answer : null,
    teacher_cost_usd: num(r.teacher_cost_usd),
    student_reply: typeof r.student_reply === 'string' ? r.student_reply : null,
    student_answer: typeof r.student_answer === 'string' ? r.student_answer : null,
    score: r.score === null || r.score === undefined ? null : num(r.score),
    passed: r.passed === true,
    too_long: r.too_long === true,
    attempts: Number(r.attempts) || 0,
    fail: r.fail ? String(r.fail) : null,
    cost_usd: num(r.cost_usd),
  }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** Earlier lessons' questions that match these hashes, with the state of the lesson that holds them. */
export async function heldHashMatches(hashes: string[]): Promise<Array<{ hash: string; held_back: boolean; lesson_slug: string; status: string | null; finished_at: string | null }>> {
  if (!hashes.length) return []
  await ensureTinkerExtras()
  const r = await sql`
    SELECT h.hash, h.held_back, h.lesson_slug, r.status, r.finished_at
    FROM tutor_held_hashes h LEFT JOIN tinker_runs r ON r.slug = h.lesson_slug
    WHERE h.hash IN (SELECT jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb))
  `
  return r.rows.map(row => ({
    hash: String(row.hash), held_back: row.held_back === true, lesson_slug: String(row.lesson_slug),
    status: row.status ? String(row.status) : null, finished_at: iso(row.finished_at),
  }))
}

/** Writes the lesson row and its question hashes. Throws when it could not. */
export async function createLesson(params: {
  runId: string
  slug: string
  request: TinkerTutorRequest
  teacherModel: string
  teacherCapUsd: number
  budgetScope: 'classic' | 'research'
  experimentId: string
  epoch: number
  spendDay: string
  reservedUsd: number
  hashes: Array<{ hash: string; held_back: boolean }>
  now: Date
}): Promise<LessonRow | null> {
  await ensureTutorTables()
  const r = await sql`
    INSERT INTO tutor_lessons (
      run_id, slug, created_at, stage, round, request, teacher_model, teacher_cap_usd, budget_scope, experiment_id, epoch, spend_day, reserved_usd
    ) VALUES (
      ${params.runId}, ${params.slug}, ${params.now.toISOString()}, ${'diagnostic'}, ${1}, ${JSON.stringify(params.request)}, ${params.teacherModel},
      ${usd(params.teacherCapUsd)}, ${params.budgetScope}, ${params.experimentId}, ${params.epoch}, ${params.spendDay}, ${usd(params.reservedUsd)}
    )
    ON CONFLICT (run_id) DO NOTHING
    RETURNING *
  `
  await sql`
    INSERT INTO tutor_held_hashes (hash, held_back, topic, lesson_slug)
    SELECT x.hash, x.held_back, ${params.request.topic}::text, ${params.slug}::text
    FROM jsonb_to_recordset(${JSON.stringify(params.hashes)}::jsonb) AS x(hash TEXT, held_back BOOLEAN)
    ON CONFLICT DO NOTHING
  `
  return r.rows[0] ? lessonRow(r.rows[0] as Record<string, unknown>) : null
}

// ---------------------------------------------------------------------------
// The worker's statements
// ---------------------------------------------------------------------------

/**
 * Lessons not done yet, oldest first. It only looks, and never creates the
 * tables: a lab that has never opened a lesson gets an empty list (the
 * caller treats a missing table as none).
 */
export async function openLessonRows(limit = 2): Promise<LessonRow[]> {
  const r = await sql`SELECT * FROM tutor_lessons WHERE stage <> 'done' ORDER BY created_at ASC LIMIT ${limit}`
  return r.rows.map(row => lessonRow(row as Record<string, unknown>))
}

/**
 * Takes a lesson's lease for one slice, or null when another request holds
 * it. A lease that ran out belonged to a slice that died: whatever it had set
 * aside for a teacher call that never answered is given back in the same
 * statement (spec 1.7(b)).
 */
export async function takeLease(runId: string, now: Date, leaseMs: number): Promise<LessonRow | null> {
  const until = new Date(now.getTime() + leaseMs).toISOString()
  const r = await sql`
    UPDATE tutor_lessons
    SET teacher_reserved_usd = CASE WHEN lease_until IS NULL THEN teacher_reserved_usd ELSE 0 END, lease_until = ${until}
    WHERE run_id = ${runId} AND (lease_until IS NULL OR lease_until < ${now.toISOString()})
    RETURNING *
  `
  return r.rows[0] ? lessonRow(r.rows[0] as Record<string, unknown>) : null
}

export async function releaseLease(runId: string): Promise<void> {
  await sql`UPDATE tutor_lessons SET lease_until = NULL WHERE run_id = ${runId}`
}

export async function loadAnswers(runId: string): Promise<AnswerRow[]> {
  const r = await sql`SELECT * FROM tutor_answers WHERE run_id = ${runId}`
  return r.rows.map(row => answerRow(row as Record<string, unknown>))
}

export async function loadTurns(runId: string): Promise<TurnRow[]> {
  const r = await sql`SELECT * FROM tutor_turns WHERE run_id = ${runId}`
  return r.rows.map(row => turnRow(row as Record<string, unknown>))
}

/** Stores one answer of a test as soon as it answered (or failed). The cost of every attempt adds up. */
export async function saveAnswer(runId: string, a: AnswerRow, attemptCostUsd: number): Promise<void> {
  await sql`
    INSERT INTO tutor_answers (
      run_id, phase, subskill, held_back, question, sample, status, attempts, answer, score, passed, cut_short, too_long, prompt_tokens, completion_tokens, cost_usd
    ) VALUES (
      ${runId}, ${a.phase}, ${a.subskill}, ${a.held_back}, ${a.question}, ${a.sample}, ${a.status}, ${a.attempts}, ${a.answer}, ${a.score}, ${a.passed},
      ${a.cut_short}, ${a.too_long}, ${a.prompt_tokens}, ${a.completion_tokens}, ${usd(attemptCostUsd)}
    )
    ON CONFLICT (run_id, phase, subskill, held_back, question, sample) DO UPDATE SET
      status = EXCLUDED.status, attempts = EXCLUDED.attempts, answer = EXCLUDED.answer, score = EXCLUDED.score, passed = EXCLUDED.passed,
      cut_short = EXCLUDED.cut_short, too_long = EXCLUDED.too_long, prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens,
      cost_usd = tutor_answers.cost_usd + EXCLUDED.cost_usd
  `
}

/** Stores the student's side of a turn after one of its calls. The cost of every student call adds up. */
export async function saveTurnStudent(runId: string, t: TurnRow, callCostUsd: number): Promise<void> {
  await sql`
    UPDATE tutor_turns
    SET state = ${t.state}, student_reply = ${t.student_reply}, student_answer = ${t.student_answer}, score = ${t.score}, passed = ${t.passed},
      too_long = ${t.too_long}, attempts = ${t.attempts}, fail = ${t.fail}, cost_usd = cost_usd + ${usd(callCostUsd)}
    WHERE run_id = ${runId} AND round = ${t.round} AND subskill = ${t.subskill} AND question = ${t.question} AND turn = ${t.turn}
  `
}

/**
 * Sets the most one teacher call can cost aside on the lesson, or refuses:
 * one statement, so two requests cannot both pass a stale check. No row back
 * means the lesson's teacher cap would be passed.
 */
export async function reserveTeacher(runId: string, worstUsd: number): Promise<boolean> {
  const r = await sql`
    UPDATE tutor_lessons SET teacher_reserved_usd = teacher_reserved_usd + ${usd(worstUsd)}
    WHERE run_id = ${runId} AND teacher_usd + teacher_reserved_usd + ${usd(worstUsd)} <= teacher_cap_usd
    RETURNING teacher_reserved_usd
  `
  return Boolean(r.rows[0])
}

/** Gives back a reservation for a call that was not sent. */
export async function unreserveTeacher(runId: string, worstUsd: number): Promise<void> {
  await sql`UPDATE tutor_lessons SET teacher_reserved_usd = GREATEST(0, teacher_reserved_usd - ${usd(worstUsd)}) WHERE run_id = ${runId}`
}

/** Marks a teacher call as about to be sent. False when the turn already has a row (it was asked before). */
export async function markTeacherCalling(runId: string, key: { round: number; subskill: number; question: number; turn: number; kind: 'guide' | 'explain' }, worstUsd: number): Promise<boolean> {
  const r = await sql`
    INSERT INTO tutor_turns (run_id, round, subskill, question, turn, kind, state, teacher_cost_usd)
    VALUES (${runId}, ${key.round}, ${key.subskill}, ${key.question}, ${key.turn}, ${key.kind}, ${'calling'}, ${usd(worstUsd)})
    ON CONFLICT (run_id, round, subskill, question, turn) DO NOTHING
    RETURNING turn
  `
  return Boolean(r.rows[0])
}

/**
 * After a teacher call (any outcome): the turn's row and the lesson's money
 * in one statement. The reservation is given back, the real cost is added and
 * the call is counted. Only a turn still marked 'calling' is settled, so a
 * call is never counted twice.
 */
export async function settleTeacher(runId: string, t: TurnRow, worstUsd: number, realUsd: number): Promise<{ teacher_usd: number; teacher_calls: number } | null> {
  const r = await sql`
    WITH t AS (
      UPDATE tutor_turns
      SET state = ${t.state}, teacher_text = ${t.teacher_text}, teacher_answer = ${t.teacher_answer}, teacher_cost_usd = ${usd(realUsd)},
        score = ${t.score}, passed = ${t.passed}, fail = ${t.fail}
      WHERE run_id = ${runId} AND round = ${t.round} AND subskill = ${t.subskill} AND question = ${t.question} AND turn = ${t.turn} AND state = 'calling'
      RETURNING run_id
    )
    UPDATE tutor_lessons
    SET teacher_reserved_usd = GREATEST(0, teacher_reserved_usd - ${usd(worstUsd)}), teacher_usd = teacher_usd + ${usd(realUsd)}, teacher_calls = teacher_calls + 1
    WHERE run_id IN (SELECT run_id FROM t)
    RETURNING teacher_usd, teacher_calls
  `
  return r.rows[0] ? { teacher_usd: num(r.rows[0].teacher_usd), teacher_calls: Number(r.rows[0].teacher_calls) || 0 } : null
}

/**
 * A teacher call that was marked as sent by a slice that died before it was
 * settled. It may have been sent and billed, so it is never sent again: the
 * turn is used up and counted at the most it could have cost.
 */
export async function settleLostTeacherCall(runId: string, t: Pick<TurnRow, 'round' | 'subskill' | 'question' | 'turn'>): Promise<boolean> {
  const r = await sql`
    WITH t AS (
      UPDATE tutor_turns SET state = 'no_question', fail = 'lost'
      WHERE run_id = ${runId} AND round = ${t.round} AND subskill = ${t.subskill} AND question = ${t.question} AND turn = ${t.turn} AND state = 'calling'
      RETURNING run_id, teacher_cost_usd
    )
    UPDATE tutor_lessons
    SET teacher_usd = teacher_usd + COALESCE((SELECT SUM(teacher_cost_usd) FROM t), 0), teacher_calls = teacher_calls + 1
    WHERE run_id IN (SELECT run_id FROM t)
    RETURNING teacher_usd
  `
  return Boolean(r.rows[0])
}

/** What all open lessons have set aside for teacher calls that have not answered. */
export async function openTeacherReservedUsd(): Promise<number> {
  const r = await sql`SELECT COALESCE(SUM(teacher_reserved_usd), 0) AS total FROM tutor_lessons WHERE stage <> 'done'`
  return num(r.rows[0]?.total)
}

export async function setStage(runId: string, stage: LessonStage, round: number): Promise<void> {
  await sql`UPDATE tutor_lessons SET stage = ${stage}, round = ${round} WHERE run_id = ${runId}`
}

/** Teaching stopped for this lesson: the first reason is kept. */
/** Moves a lesson to 'closing' with the status and reason it is to close with, in one statement. */
export async function setClosing(runId: string, status: 'ok' | 'ended' | 'failed' | 'error', reason: string | null): Promise<void> {
  await sql`UPDATE tutor_lessons SET stage = 'closing', close_status = ${status}, close_reason = ${reason ? reason.slice(0, 500) : null} WHERE run_id = ${runId}`
}

export async function setStopReason(runId: string, reason: string): Promise<void> {
  await sql`UPDATE tutor_lessons SET stop_reason = ${reason.slice(0, 500)} WHERE run_id = ${runId} AND stop_reason IS NULL`
}

export async function setProgress(runId: string, progress: LessonProgress): Promise<void> {
  await sql`UPDATE tutor_lessons SET progress = ${JSON.stringify(progress)} WHERE run_id = ${runId}`
}

export async function setTrain(runId: string, train: TrainLeg[]): Promise<void> {
  const spent = train.reduce((a, leg) => a + (leg.cost_usd ?? 0), 0)
  await sql`UPDATE tutor_lessons SET train = ${JSON.stringify(train)}, train_usd = ${usd(spent)} WHERE run_id = ${runId}`
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * Closes a lesson's run row, once: only a row still in status 'lesson' is
 * closed, and in the same statement its Tinker reservation is replaced by
 * what was measured. The row comes back only to the caller that closed it.
 */
export async function closeLessonRun(params: {
  runId: string
  status: 'ok' | 'ended' | 'failed' | 'error'
  reason: string | null
  costUsd: number
  result: Record<string, unknown>
  samplerPath: string | null
  expiresAt: string | null
  examples: number
  spendDay: string
  reservedUsd: number
  now: Date
  /** The lesson's line on the lab's spend ledger (tool/tinker_tutor), written in the same statement as the close when it cost anything. */
  ledger: { experimentId: string; epoch: number; assigned: string | null; budgetScope: 'classic' | 'research' }
}): Promise<Record<string, unknown> | null> {
  await ensureSpendTable()
  const cost = usd(params.costUsd)
  const r = await sql`
    WITH closed AS (
      UPDATE tinker_runs
      SET status = ${params.status}, reason = ${params.reason ? params.reason.slice(0, 500) : null}, cost_usd = ${usd(params.costUsd)},
        result = ${JSON.stringify(params.result)}, sampler_path = ${params.samplerPath}, expires_at = ${params.samplerPath ? params.expiresAt : null},
        dataset_examples = ${params.examples}, finished_at = ${params.now.toISOString()}
      WHERE id = ${params.runId} AND status = 'lesson'
      RETURNING *
    ),
    settled AS (
      UPDATE tinker_spend_days
      SET reserved_usd = GREATEST(0, reserved_usd - ${usd(params.reservedUsd)}), spent_usd = spent_usd + ${usd(params.costUsd)}
      WHERE day = ${params.spendDay} AND scope = 'all' AND EXISTS (SELECT 1 FROM closed)
      RETURNING day
    ),
    ledger AS (
      INSERT INTO model_calls (experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, reasoning_tokens, budget_scope)
      SELECT ${params.ledger.experimentId}::uuid, ${params.ledger.epoch}::integer, 'tinker_tutor', 'tool/tinker_tutor', ${params.ledger.assigned}::text, ${cost}::numeric, 'estimate', 0, 0, 0, ${params.ledger.budgetScope === 'research' ? 'research' : null}::text
      FROM closed WHERE ${cost}::numeric > 0
      RETURNING id
    )
    SELECT * FROM closed
  `
  return (r.rows[0] as Record<string, unknown> | undefined) ?? null
}

/**
 * With the tool switched off and nothing configured to run it, an open lesson
 * older than `cutoff` is closed as failed in this one statement: its run row,
 * its Tinker reservation (settled to what its calls were measured at, under
 * the day it was reserved), and its lesson row. Returns the slugs closed.
 */
export async function closeAbandonedLessons(cutoff: Date, reason: string, now: Date): Promise<Array<{ slug: string; experiment_id: string; epoch: number; model: string; spent: number }>> {
  await ensureSpendTable()
  // A training job is counted as the worker counts it (tinker-tutor-run.ts tinkerSpentUsd): at its measured cost, or at its whole
  // budget while it may still be training (running, or starting with a start that was not confirmed).
  const r = await sql`
    WITH old AS (
      SELECT l.run_id, l.slug, l.spend_day, l.reserved_usd, l.experiment_id, l.epoch, l.budget_scope,
        COALESCE((SELECT SUM(a.cost_usd) FROM tutor_answers a WHERE a.run_id = l.run_id), 0)
          + COALESCE((SELECT SUM(t.cost_usd) FROM tutor_turns t WHERE t.run_id = l.run_id), 0)
          + COALESCE((SELECT SUM(CASE
              WHEN leg->>'cost_usd' IS NOT NULL THEN (leg->>'cost_usd')::numeric
              WHEN leg->>'state' = 'running' OR (leg->>'state' = 'starting' AND leg->>'started_at' IS NOT NULL) THEN COALESCE((leg->>'budget_usd')::numeric, 0)
              ELSE 0 END) FROM jsonb_array_elements(l.train) AS leg), 0) AS spent
      FROM tutor_lessons l
      WHERE l.stage <> 'done' AND l.created_at < ${cutoff.toISOString()}
    ),
    closed AS (
      UPDATE tinker_runs r SET status = 'failed', reason = ${reason}, cost_usd = old.spent, finished_at = ${now.toISOString()}
      FROM old WHERE r.id = old.run_id AND r.status = 'lesson'
      RETURNING r.id, r.model, r.assigned_model, old.slug, old.spend_day, old.reserved_usd, old.spent, old.experiment_id, old.epoch, old.budget_scope
    ),
    ledger AS (
      INSERT INTO model_calls (experiment_id, epoch_number, purpose, model_id, assigned_model_id, cost_usd, cost_source, prompt_tokens, completion_tokens, reasoning_tokens, budget_scope)
      SELECT experiment_id, epoch, 'tinker_tutor', 'tool/tinker_tutor', COALESCE(assigned_model, model), spent, 'estimate', 0, 0, 0, CASE WHEN budget_scope = 'research' THEN 'research' ELSE NULL END
      FROM closed WHERE spent > 0
      RETURNING id
    ),
    settled AS (
      UPDATE tinker_spend_days d
      SET reserved_usd = GREATEST(0, d.reserved_usd - s.reserved), spent_usd = d.spent_usd + s.spent
      FROM (SELECT spend_day, SUM(reserved_usd) AS reserved, SUM(spent) AS spent FROM closed GROUP BY spend_day) s
      WHERE d.day = s.spend_day AND d.scope = 'all'
      RETURNING d.day
    ),
    finished AS (
      UPDATE tutor_lessons SET stage = 'done', teacher_reserved_usd = 0, lease_until = NULL, stop_reason = COALESCE(stop_reason, ${reason})
      WHERE run_id IN (SELECT run_id FROM old)
      RETURNING run_id
    )
    SELECT slug, experiment_id, epoch, model, spent FROM closed
  `
  return r.rows.map(row => ({ slug: String(row.slug), experiment_id: String(row.experiment_id), epoch: Number(row.epoch) || 0, model: String(row.model ?? ''), spent: num(row.spent) }))
}

// ---------------------------------------------------------------------------
// Counts and the public record's reads
// ---------------------------------------------------------------------------

/**
 * Takes one of today's lesson places (LAB_TINKER_TUTOR_PER_DAY) in one
 * statement, so two epochs that run at the same time cannot both take the
 * last one. False when the day is full.
 */
export async function takeTutorDaySlot(now: Date, perDay: number): Promise<boolean> {
  if (!(perDay >= 1)) return false
  await ensureTutorTables()
  const r = await sql`
    INSERT INTO tutor_day_slots (day, n) VALUES (${utcDay(now)}, 1)
    ON CONFLICT (day) DO UPDATE SET n = tutor_day_slots.n + 1 WHERE tutor_day_slots.n < ${perDay}
    RETURNING n
  `
  return r.rows.length > 0
}

/** Gives a place back: the lesson was refused before any call was sent. */
export async function releaseTutorDaySlot(now: Date): Promise<void> {
  await sql`UPDATE tutor_day_slots SET n = GREATEST(0, n - 1) WHERE day = ${utcDay(now)}`.catch(() => {})
}

/**
 * Lessons that count toward today's limit (LAB_TINKER_TUTOR_PER_DAY): every
 * lesson opened this UTC day, unless it was refused before any call was sent
 * and cost nothing at all (spec 1.7(c)): no teacher call, no Tinker cost and
 * no student call charged.
 */
export async function tutorRunsToday(now: Date = new Date()): Promise<number> {
  await ensureTutorTables()
  const r = await sql`
    SELECT COUNT(*) AS n FROM tinker_runs r LEFT JOIN tutor_lessons l ON l.run_id = r.id
    WHERE r.kind = 'tutor' AND r.spend_day = ${utcDay(now)}
      AND (r.status IN ('lesson', 'ok') OR COALESCE(r.cost_usd, 0) > 0 OR COALESCE(l.teacher_calls, 0) > 0
        OR EXISTS (SELECT 1 FROM tutor_answers a WHERE a.run_id = r.id AND a.cost_usd > 0)
        OR EXISTS (SELECT 1 FROM tutor_turns t WHERE t.run_id = r.id AND (t.cost_usd > 0 OR t.teacher_cost_usd > 0)))
  `
  return Number(r.rows[0]?.n) || 0
}

/** The slug of the newest lesson, whatever state it is in. Only looks. */
export async function latestLessonSlug(): Promise<string | null> {
  try {
    const r = await sql`SELECT slug FROM tinker_runs WHERE kind = 'tutor' ORDER BY created_at DESC LIMIT 1`
    return r.rows[0] ? String(r.rows[0].slug) : null
  } catch {
    return null
  }
}

/** A lesson's row by its run id, or null. Only looks. */
export async function getLessonRow(runId: string): Promise<LessonRow | null> {
  try {
    const r = await sql`SELECT * FROM tutor_lessons WHERE run_id = ${runId}`
    return r.rows[0] ? lessonRow(r.rows[0] as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** One subskill's answers with their text, for the lesson route. */
export async function subskillAnswers(runId: string, subskill: number): Promise<AnswerRow[]> {
  const r = await sql`SELECT * FROM tutor_answers WHERE run_id = ${runId} AND subskill = ${subskill}`
  return r.rows.map(row => answerRow(row as Record<string, unknown>))
}

/**
 * A lesson's answers for the public record: the marks of every answer, and
 * the text only of practice answers that did not pass (the wrong answers the
 * teaching starts from).
 */
export async function answerMarks(runId: string): Promise<AnswerRow[]> {
  const r = await sql`
    SELECT phase, subskill, held_back, question, sample, status, attempts, passed, cut_short, too_long, cost_usd,
      (status = 'ok' AND (answer IS NULL OR btrim(answer) = '')) AS empty,
      CASE WHEN passed = FALSE AND held_back = FALSE THEN answer ELSE NULL END AS answer
    FROM tutor_answers WHERE run_id = ${runId}
  `
  return r.rows.map(row => answerRow(row as Record<string, unknown>))
}
