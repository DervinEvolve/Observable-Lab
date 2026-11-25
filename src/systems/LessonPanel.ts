import type { LessonQuestions, LessonRecord, PublicLesson } from '../shared/types'
import { installPaperTheme, paperFocusRing, paperHeader, paperHeading, paperPrimaryButton, paperQuietButton, paperShell } from './paperTheme'
import { dollars } from './PracticeBenchPanel'
import { NO_EXPERIMENT } from './practiceBench'
import {
  answerMark,
  BANDS_NOTE, NO_LESSON, TUTOR_MEASURE_NOTE, bandsText, cellText, headLine, readLessonQuestions, readLessonRecord, share, stageLine, withinNoise,
  type TutorLessonState,
} from './skillMap'

// The lesson's record, opened by clicking or tapping the skill map chart in the
// room. It shows what the lab stored about the newest Socratic lesson: the
// skill map, how every answer was graded, what the teacher asked, the
// training, the cost, and a way to talk to the trained model when it can be
// talked to. Every text is put on the page as text, never as markup. The
// panel's body comes from the room's state at once; the full record (rubric
// lines and every graded answer) is read from GET /api/experiment/lesson when
// it is opened, and again only when the state says the lesson changed.
//
// Words used: a count of answers that passed, then a pass band. The lab never
// calls a band mastery: it is the share of held back answers that passed, and
// the rules were written by a model.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
const LESSON_API = '/api/experiment/lesson'

/** A reason as a sentence: a capital letter first and a full stop last. */
function sentence(t: string): string {
  const s = t.trim()
  if (!s) return ''
  const up = s.charAt(0).toUpperCase() + s.slice(1)
  return /[.!?]$/.test(up) ? up : `${up}.`
}

/** The teaching counts in words, with the right singular and plural. */
export function teachingText(t: { missed: number; taught: number; solved: number; explained: number; teacher_failed: number }): string {
  const q = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  return `${q(t.missed, 'practice question was', 'practice questions were')} missed. ${t.taught} ${t.taught === 1 ? 'was' : 'were'} taught. ${t.solved} ${t.solved === 1 ? 'was' : 'were'} solved after guiding questions. ${t.explained} needed the teacher to explain. ${t.teacher_failed === 1 ? '1 time' : `${t.teacher_failed} times`} the teacher's own answer did not pass.`
}

/** "5 of 6" style date: a plain date for the head of the page. */
function dateText(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}

/** What changes while the lesson goes on: the panel asks for the full record again only when this changes. */
export function lessonKey(l: PublicLesson | null): string {
  return l ? [l.slug, l.status, l.stage, l.round, l.live, l.progress?.seq ?? ''].join('|') : ''
}

export interface LessonPanelOptions {
  /** Where the record is read from. Defaults to the page's own fetch. */
  fetch?: typeof fetch
}

export class LessonPanel {
  private container: HTMLDivElement
  private panel: HTMLDivElement
  private body: HTMLDivElement
  private status: HTMLParagraphElement
  private isOpen = false
  private state: TutorLessonState | null = null
  private simulation = true
  private record: LessonRecord | null = null
  private recordKey = ''
  private loading: 'idle' | 'loading' | 'failed' = 'idle'
  private questions = new Map<number, LessonQuestions | 'loading' | 'failed'>()
  private openRows = new Set<number>()
  private lastFocus: HTMLElement | null = null
  private undoInert: Array<() => void> = []
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private token = 0
  private readonly fetchImpl: typeof fetch | null

  /** `onTalk` is called with the adapter's lab id ("lab/<slug>") when the visitor chooses to talk to it. */
  constructor(private onTalk: (modelId: string) => void, options: LessonPanelOptions = {}) {
    installPaperTheme()
    this.fetchImpl = options.fetch ?? null
    this.container = el('div')
    this.container.id = 'lesson-panel-container'
    const style = document.createElement('style')
    style.textContent = `
      ${paperShell('#lesson-panel')}
      #lesson-panel { position: fixed; left: 20px; bottom: 76px; width: min(460px, calc(100vw - 40px)); max-height: min(82vh, calc(100dvh - 120px)); display: none; flex-direction: column; overflow: hidden; z-index: 1090; font-size: 14px; line-height: 1.45; }
      #lesson-panel.open { display: flex; }
      #lesson-panel .lp-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 6px 6px 16px; }
      ${paperHeader('#lesson-panel .lp-head')}
      ${paperHeading('#lesson-panel .lp-title', 17)}
      #lesson-panel .lp-close { width: 44px; height: 44px; border: 0; background: transparent; color: var(--paper-ink-2); font-size: 24px; cursor: pointer; border-radius: var(--paper-radius-sm); }
      #lesson-panel .lp-close:hover { color: var(--paper-ink); background: var(--paper-sunk); }
      ${paperFocusRing('#lesson-panel')}
      #lesson-panel .lp-status { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      #lesson-panel .lp-body { overflow-y: auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 14px; }
      #lesson-panel h3 { margin: 0 0 4px; }
      ${paperHeading('#lesson-panel h3', 15)}
      #lesson-panel p { margin: 0; overflow-wrap: anywhere; }
      #lesson-panel ul { margin: 0; padding-left: 16px; }
      #lesson-panel li { margin: 2px 0; overflow-wrap: anywhere; }
      #lesson-panel .lp-muted { color: var(--paper-ink-2); }
      #lesson-panel .lp-topic { font-weight: 600; font-size: 16px; }
      #lesson-panel .lp-flag { border: 1px solid var(--paper-danger); border-radius: var(--paper-radius-sm); padding: 8px 10px; background: var(--paper-danger-bg); color: var(--paper-ink); }
      #lesson-panel .lp-flag b { color: var(--paper-danger); }
      #lesson-panel .lp-skill { margin: 6px 0; }
      #lesson-panel .lp-row { display: block; width: 100%; min-height: 44px; text-align: left; font: inherit; font-size: 14px; padding: 8px 10px; }
      ${paperQuietButton('#lesson-panel .lp-row')}
      #lesson-panel .lp-row b { display: block; font-family: var(--paper-serif); font-size: 15px; }
      #lesson-panel .lp-row span { display: block; font-weight: 400; }
      #lesson-panel .lp-row .lp-small { color: var(--paper-ink-2); }
      #lesson-panel .lp-bars { display: grid; gap: 3px; margin: 4px 0; }
      #lesson-panel .lp-track { height: 10px; background: var(--paper-sunk); border: 1px solid var(--paper-line); border-radius: 2px; overflow: hidden; }
      #lesson-panel .lp-fill { height: 100%; background: var(--paper-brass); border-right: 2px solid var(--paper-brass-edge); }
      #lesson-panel .lp-fill.before { background: repeating-linear-gradient(135deg, var(--paper-sunk) 0 4px, var(--paper-bar) 4px 6px); border-right-color: var(--paper-bar); }
      #lesson-panel .lp-detail { border-left: 3px solid var(--paper-hair); margin: 4px 0 8px 8px; padding: 2px 0 2px 10px; display: flex; flex-direction: column; gap: 10px; }
      #lesson-panel .lp-q { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
      #lesson-panel .lp-label { font-weight: 600; }
      #lesson-panel .lp-line { border-left: 3px solid var(--paper-line); padding: 1px 0 1px 8px; }
      #lesson-panel .lp-line.pass { border-left-color: var(--paper-ok); }
      #lesson-panel .lp-line.fail { border-left-color: var(--paper-blocked); }
      #lesson-panel .lp-mark { font-weight: 600; }
      #lesson-panel .lp-id { font-family: var(--paper-mono); overflow-wrap: anywhere; }
      #lesson-panel .lp-action { min-height: 44px; font: inherit; font-size: 14px; font-weight: 600; padding: 0 16px; align-self: flex-start; }
      ${paperPrimaryButton('#lesson-panel .lp-talk')}
      ${paperQuietButton('#lesson-panel .lp-again')}
      #lesson-panel .lp-talk:hover, #lesson-panel .lp-talk:active { border-color: var(--paper-ink); }
      @media (max-width: 760px) { #lesson-panel { left: 8px; right: 8px; width: auto; bottom: 8px; max-height: calc(100dvh - 16px); } }
    `
    this.container.appendChild(style)
    this.panel = el('div')
    this.panel.id = 'lesson-panel'
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-modal', 'true')
    this.panel.setAttribute('aria-label', 'The Lesson')
    this.panel.tabIndex = -1
    const head = el('div', 'lp-head')
    head.appendChild(el('div', 'lp-title', 'The Lesson'))
    const close = el('button', 'lp-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.addEventListener('click', () => this.close())
    head.appendChild(close)
    this.body = el('div', 'lp-body')
    // Only the stage line is announced when it changes; the record below is read at the visitor's pace.
    this.status = el('p', 'lp-status')
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.panel.append(head, this.status, this.body)
    this.container.appendChild(this.panel)
    document.body.appendChild(this.container)
    this.render()
  }

  /** What the room's state says about the newest lesson, and whether no experiment is connected. */
  public setLesson(state: TutorLessonState | null, simulation: boolean): void {
    const was = lessonKey(this.state?.lesson ?? null)
    this.state = state
    this.simulation = simulation
    if (!this.isOpen) return
    if (lessonKey(state?.lesson ?? null) !== was) void this.loadRecord()
    else this.render()
  }

  public get open(): boolean { return this.isOpen }

  public show(): void {
    if (this.isOpen) return
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.isOpen = true
    this.render()
    this.panel.classList.add('open')
    this.trapOn()
    ;(this.panel.querySelector('.lp-close') as HTMLButtonElement).focus()
    void this.loadRecord()
  }

  public close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.token++
    this.panel.classList.remove('open')
    this.trapOff()
    const back = this.lastFocus
    this.lastFocus = null
    if (back && back !== document.body && document.body?.contains?.(back) !== false) back.focus?.()
  }

  // ------------------------------------------------------------------ reading

  private get lesson(): PublicLesson | null {
    return this.simulation ? null : this.state?.lesson ?? null
  }

  private async get(url: string): Promise<unknown> {
    const f = this.fetchImpl ?? globalThis.fetch
    const res = await f(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error('not ok')
    return res.json()
  }

  private async loadRecord(): Promise<void> {
    const lesson = this.lesson
    const key = lessonKey(lesson)
    if (!lesson || this.recordKey === key && this.record) { this.render(); return }
    const mine = ++this.token
    this.loading = 'loading'
    this.questions.clear()
    this.render()
    try {
      const rec = readLessonRecord(await this.get(`${LESSON_API}?slug=${encodeURIComponent(lesson.slug)}`))
      if (mine !== this.token) return
      if (!rec || rec.slug !== lesson.slug) throw new Error('malformed')
      this.record = rec
      this.recordKey = key
      this.loading = 'idle'
    } catch {
      if (mine !== this.token) return
      this.record = null
      this.recordKey = ''
      this.loading = 'failed'
    }
    this.render()
    for (const i of [...this.openRows]) void this.loadQuestions(i)
  }

  private async loadQuestions(i: number): Promise<void> {
    const lesson = this.lesson
    if (!lesson || this.questions.has(i)) return
    const mine = this.token
    this.questions.set(i, 'loading')
    this.render()
    try {
      const q = readLessonQuestions(await this.get(`${LESSON_API}?slug=${encodeURIComponent(lesson.slug)}&subskill=${i}`))
      if (mine !== this.token) return
      this.questions.set(i, q ?? 'failed')
    } catch {
      if (mine !== this.token) return
      this.questions.set(i, 'failed')
    }
    this.render()
  }

  // ------------------------------------------------------------------ drawing

  private section(title: string, ...children: Array<Node | null>): HTMLElement {
    const s = el('section')
    s.appendChild(el('h3', undefined, title))
    for (const c of children) if (c) s.appendChild(c)
    return s
  }

  private bar(frac: number | null, before: boolean): HTMLElement {
    const track = el('div', 'lp-track')
    if (frac !== null) {
      const fill = el('div', before ? 'lp-fill before' : 'lp-fill')
      fill.style.width = `${Math.round(frac * 100)}%`
      track.appendChild(fill)
    }
    return track
  }

  private skillRow(l: PublicLesson, i: number, rubric: string[] | null): HTMLElement {
    const s = l.subskills[i]
    const wrap = el('div', 'lp-skill')
    const row = el('button', 'lp-row')
    row.type = 'button'
    row.setAttribute('aria-expanded', this.openRows.has(i) ? 'true' : 'false')
    row.appendChild(el('b', undefined, s.name))
    const bands = bandsText(s.before, s.after)
    const bars = el('div', 'lp-bars')
    bars.setAttribute('aria-hidden', 'true')
    bars.append(this.bar(share(s.before), true), this.bar(share(s.after), false))
    row.appendChild(bars)
    row.appendChild(el('span', undefined, cellText('Before', s.before)))
    row.appendChild(el('span', undefined, `${cellText('After', s.after)}${withinNoise(s.before, s.after) ? ' Within noise.' : ''}`))
    if (bands) row.appendChild(el('span', 'lp-small', `Pass bands: ${bands}.`))
    if (s.seen_before || s.seen_after) {
      const b = s.seen_before ? `${s.seen_before.passed} of ${s.seen_before.total} before` : 'not measured before'
      const a = s.seen_after ? `${s.seen_after.passed} of ${s.seen_after.total} after` : 'not measured after'
      row.appendChild(el('span', 'lp-small', `On questions used in teaching: ${b}, ${a}.`))
    }
    if (s.got_worse) row.appendChild(el('span', 'lp-small', 'A held back score fell.'))
    row.addEventListener('click', () => {
      if (this.openRows.has(i)) this.openRows.delete(i)
      else { this.openRows.add(i); void this.loadQuestions(i) }
      this.render()
    })
    wrap.appendChild(row)
    if (this.openRows.has(i)) wrap.appendChild(this.detail(i, rubric))
    return wrap
  }

  private mark(a: { passed: boolean; cut_short?: boolean; empty?: boolean }): HTMLElement {
    return el('span', 'lp-mark', answerMark({ passed: a.passed, cut_short: a.cut_short === true, empty: a.empty === true }))
  }

  private answerLine(label: string, text: string, passed: boolean | null, how: { cut_short?: boolean; empty?: boolean } = {}): HTMLElement {
    const line = el('div', passed === null ? 'lp-line' : `lp-line ${passed ? 'pass' : 'fail'}`)
    line.appendChild(el('span', 'lp-muted', `${label}: `))
    line.appendChild(document.createTextNode(text || '(empty)'))
    if (passed !== null) { line.appendChild(document.createTextNode(' ')); line.appendChild(this.mark({ passed, ...how })) }
    return line
  }

  private detail(i: number, rubric: string[] | null): HTMLElement {
    const box = el('div', 'lp-detail')
    const q = this.questions.get(i)
    if (q === undefined || q === 'loading') { box.appendChild(el('p', 'lp-muted', 'Loading the questions.')); return box }
    if (q === 'failed') {
      box.appendChild(el('p', 'lp-muted', 'The questions could not be loaded.'))
      const again = el('button', 'lp-action lp-again', 'Try Again')
      again.type = 'button'
      again.addEventListener('click', () => { this.questions.delete(i); void this.loadQuestions(i) })
      box.appendChild(again)
      return box
    }
    if (!q.questions.length) box.appendChild(el('p', 'lp-muted', 'No questions are stored for this subskill yet.'))
    for (const item of q.questions) {
      const wrap = el('div', 'lp-q')
      wrap.appendChild(el('div', 'lp-label', item.held_back ? 'Held back question' : 'Practice question'))
      wrap.appendChild(el('p', undefined, item.prompt))
      item.answers.before.forEach((a, k) => wrap.appendChild(this.answerLine(`Before, answer ${k + 1}`, a.text, a.passed, a)))
      item.answers.after.forEach((a, k) => wrap.appendChild(this.answerLine(`After, answer ${k + 1}`, a.text, a.passed, a)))
      for (const t of item.turns) {
        if (t.kind === 'guide') {
          if (t.state === 'leaked') wrap.appendChild(this.answerLine('The teacher asked', 'The question was left out because it gave away a value the rules look for.', null))
          else if (t.state === 'no_question') wrap.appendChild(this.answerLine('The teacher asked', 'The teacher gave no usable question.', null))
          else {
            wrap.appendChild(this.answerLine('The teacher asked', t.teacher, null))
            if (t.reply) wrap.appendChild(this.answerLine('It replied', t.reply, null))
            if (t.answer) wrap.appendChild(this.answerLine('It answered again', t.answer, t.passed))
          }
        } else {
          if (t.teacher) wrap.appendChild(this.answerLine('The teacher explained', t.teacher, null))
          if (t.answer) wrap.appendChild(this.answerLine("The teacher's answer", t.answer, t.passed))
        }
      }
      box.appendChild(wrap)
    }
    if (rubric?.length) {
      const list = el('ul')
      for (const rule of rubric) list.appendChild(el('li', undefined, rule))
      box.append(el('div', 'lp-label', 'Rules for this subskill'), list)
    }
    return box
  }

  /** Redraws the body. The scroll position and the focused row stay where they were. */
  private render(): void {
    const keep = this.body.scrollTop
    const rows = Array.from(this.body.querySelectorAll('.lp-row')) as HTMLElement[]
    const focused = rows.indexOf(document.activeElement as HTMLElement)
    this.draw()
    this.body.scrollTop = keep
    if (focused >= 0) (this.body.querySelectorAll('.lp-row')[focused] as HTMLElement | undefined)?.focus?.()
  }

  private draw(): void {
    this.body.replaceChildren()
    const l = this.lesson
    const said = this.simulation || !l ? '' : stageLine(l)
    if (this.status.textContent !== said) this.status.textContent = said
    if (this.simulation) {
      this.body.appendChild(el('p', undefined, `${NO_EXPERIMENT}. The chart stays blank: nothing on it is model work.`))
      return
    }
    if (!l) {
      this.body.appendChild(el('p', undefined, NO_LESSON))
      this.body.appendChild(el('p', 'lp-muted', this.state && !this.state.enabled
        ? `Lessons are off here${this.state.offReason ? `: ${this.state.offReason}` : ''}.`
        : 'When a model asks for a Socratic lesson and the Reviewer approves it, the chart on the wall shows it here as it goes.'))
      return
    }
    const rec = this.record && this.record.slug === l.slug ? this.record : null

    // 1. head
    const head = el('div')
    head.appendChild(el('p', 'lp-topic', l.name ?? l.topic))
    if (l.name) head.appendChild(el('p', 'lp-muted', `Topic: ${l.topic}.`))
    head.appendChild(el('p', 'lp-muted', headLine(l)))
    if (l.purpose) head.appendChild(el('p', 'lp-muted', l.purpose))
    head.appendChild(el('p', undefined, stageLine(l)))
    this.body.appendChild(head)
    if (this.loading === 'loading' && !rec) this.body.appendChild(el('p', 'lp-muted', 'Loading the full record.'))
    if (this.loading === 'failed') {
      this.body.appendChild(el('p', 'lp-muted', 'The full record could not be loaded. What the room already knew is below.'))
      const again = el('button', 'lp-action lp-again', 'Try Again')
      again.type = 'button'
      again.addEventListener('click', () => { this.recordKey = ''; void this.loadRecord() })
      this.body.appendChild(again)
    }

    // 2. flags
    // The server's reasons are complete: the rubric_literal and shared_literals sentences are among them.
    const noticed: string[] = l.flags.reasons.map(sentence)
    if (noticed.length) {
      const flag = el('div', 'lp-flag')
      flag.appendChild(el('b', undefined, 'The lab noticed'))
      const list = el('ul')
      for (const n of noticed) list.appendChild(el('li', undefined, n))
      flag.appendChild(list)
      this.body.appendChild(flag)
    }

    // 3. skill map
    if (l.subskills.length) {
      const box = el('div')
      const o = l.overall
      if (o.before || o.after) {
        const parts = [o.before ? `${o.before.passed} of ${o.before.total} before` : null, o.after ? `${o.after.passed} of ${o.after.total} after` : null].filter(Boolean)
        box.appendChild(el('p', undefined, `Held back answers passed, all subskills: ${parts.join(', ')}.`))
      }
      box.appendChild(el('p', 'lp-muted', `${BANDS_NOTE} Open a row to read every graded answer.`))
      l.subskills.forEach((_, i) => box.appendChild(this.skillRow(l, i, rec?.rubrics[i] ?? null)))
      this.body.appendChild(this.section('Skill Map', box))
    }

    // 4. how it was graded
    const graded = el('div')
    graded.appendChild(el('p', undefined, `The lab asked every question ${l.questions.samples} times and graded each answer with rules a lab model wrote. An answer passes when it meets every rule. Pass bands come only from held back questions, whose text the teacher's calls never contained. ${TUTOR_MEASURE_NOTE}`))
    if (rec) {
      rec.rubrics.forEach((rules, i) => {
        if (!rules.length || !l.subskills[i]) return
        const list = el('ul')
        for (const r of rules) list.appendChild(el('li', undefined, r))
        graded.append(el('p', 'lp-label', l.subskills[i].name), list)
      })
    }
    this.body.appendChild(this.section('How It Was Graded', graded))

    // 5. teaching
    if (l.teaching) {
      const t = l.teaching
      const box = el('div')
      box.appendChild(el('p', undefined, teachingText(t)))
      for (const ex of l.exchanges) {
        const item = el('div', 'lp-q')
        item.appendChild(el('div', 'lp-label', ex.subskill))
        item.appendChild(this.answerLine('Question', ex.question, null))
        item.appendChild(this.answerLine('Its answer', ex.wrong, null))
        item.appendChild(this.answerLine('The teacher asked', ex.guide, null))
        item.appendChild(this.answerLine('It replied', ex.reply, null))
        item.appendChild(this.answerLine('It answered again', ex.answer, ex.passed))
        box.appendChild(item)
      }
      if (l.exchanges.length) box.appendChild(el('p', 'lp-muted', 'The teacher\'s questions and the replies were written by models. Nobody reviewed them.'))
      this.body.appendChild(this.section('Teaching', box))
    }

    // 6. training
    if (l.examples || l.training) {
      const box = el('div')
      if (l.examples) {
        const e = l.examples
        box.appendChild(el('p', undefined, `${e.total} training ${e.total === 1 ? 'example' : 'examples'}: ${e.kept} kept as they were, ${e.guided} with the guiding questions, ${e.answer} direct answers, ${e.explained} explained by the teacher. ${e.left_out} left out.`))
      }
      const t = l.training
      if (t && t.steps_done !== null && t.steps_planned !== null) box.appendChild(el('p', undefined, `Steps: ${t.steps_done} of ${t.steps_planned}.`))
      if (t && t.holdout_loss_before !== null && t.holdout_loss_after !== null) {
        box.appendChild(el('p', undefined, `Loss on examples the lab held out: ${t.holdout_loss_before.toFixed(2)} before, ${t.holdout_loss_after.toFixed(2)} after. Lower is better.`))
      }
      this.body.appendChild(this.section('Training', box))
    }

    // 7. cost
    const cost = el('div')
    cost.appendChild(el('p', undefined, l.cost.tinker_estimated_usd === null
      ? `Tinker use: not known yet. At most ${dollars(l.cost.tinker_max_usd)} was set aside.`
      : `Tinker use: about ${dollars(l.cost.tinker_estimated_usd)}, estimated from published prices. At most ${dollars(l.cost.tinker_max_usd)} was set aside.`))
    cost.appendChild(el('p', undefined, `The teacher: ${dollars(l.cost.teacher_usd)}, as OpenRouter reported it. The cap was ${dollars(l.cost.teacher_max_usd)}.`))
    cost.appendChild(el('p', 'lp-muted', l.cost.basis))
    this.body.appendChild(this.section('Cost', cost))

    // 8. the trained model
    if (l.status === 'ok' || l.talk) {
      const box = el('div')
      box.appendChild(el('p', 'lp-id', l.adapter))
      const made = dateText(l.finished_at)
      if (made) box.appendChild(el('p', 'lp-muted', `Finished ${made}.`))
      if (l.talk) {
        const talk = el('button', 'lp-action lp-talk', 'Talk to It')
        talk.type = 'button'
        const id = l.talk
        talk.addEventListener('click', () => { this.close(); this.onTalk(id) })
        box.appendChild(talk)
      }
      this.body.appendChild(this.section('The Trained Model', box))
    }
  }

  // -------------------------------------------------------------------- focus

  /** While open: everything else on the page is inert, Tab stays inside, Escape closes. */
  private trapOn(): void {
    this.trapOff()
    const kids = Array.from(document.body?.children ?? []) as HTMLElement[]
    for (const kid of kids) {
      if (kid === this.container || kid.tagName === 'SCRIPT' || kid.tagName === 'STYLE') continue
      if (kid.inert) continue
      kid.inert = true
      this.undoInert.push(() => { kid.inert = false })
    }
    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as Node | null
      const inside = !!target && (this.panel.contains?.(target) === true || target === document.body)
      if (e.key === 'Escape' && inside) {
        e.preventDefault()
        this.close()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(this.panel.querySelectorAll(FOCUSABLE) as NodeListOf<HTMLElement>).filter(n => n.getClientRects?.().length)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === this.panel || !this.panel.contains?.(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !this.panel.contains?.(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', this.keyHandler)
  }

  private trapOff(): void {
    for (const undo of this.undoInert) undo()
    this.undoInert = []
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler)
    this.keyHandler = null
  }

  public dispose(): void {
    this.trapOff()
    this.token++
    this.container.remove()
  }
}
