import { installPaperTheme, paperFocusRing, paperHeader, paperHeading, paperPrimaryButton, paperShell, redrawInPlace } from './paperTheme'
import {
  CUT_OFF_FLAG_LABEL, NOTHING_PRACTISED, NO_EXPERIMENT, benchView, curvePoints, cutOffFlagText, heldOutCutOffRows, plain, rewardColor, scoreText, sentence, stepCutOffRows,
  type Practice, type PracticeRun,
} from './practiceBench'

// The practice bench's record, opened by clicking or tapping the bench in the
// room. It shows what the lab stored about the newest Tinker RL run: the task
// set, the rubric in words, the steps and the reward curve, the held-out score
// before and after (measured by the lab), the cost estimate, a few short
// sample answers, the reward-hacking flag, how many answers the token limit
// cut off (shown only where some were) with the lab's flag for that, and a way
// to talk to the adapter when it can be talked to. Every text is put on the page as text, never as
// markup. While a run is going the panel is redrawn when the state changes.
//
// With no experiment connected it says so, and nothing else. With no run on
// record it says that nothing has been practised yet.

const SVG = 'http://www.w3.org/2000/svg'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** "$0.04", or "under $0.01". */
export function dollars(v: number | null): string {
  if (v === null) return 'not known'
  return v > 0 && v < 0.01 ? 'under $0.01' : `$${v.toFixed(2)}`
}

export { sentence }

/** The words for where a run stands, from the stored record only. */
export function runStatusLine(run: PracticeRun): string {
  const p = run.progress
  if (run.live && p) {
    if (p.phase === 'baseline') return 'Running: the lab is measuring the base model on the held-out tasks.'
    if (p.phase === 'measuring') return 'Running: the lab is measuring the trained model on the held-out tasks.'
    if (p.phase === 'saving') return 'Running: saving the adapter.'
    return `Running: step ${p.step} of ${p.stepsPlanned}.`
  }
  if (run.status === 'ok') return 'Finished. The held-out scores below were measured by the lab.'
  if (run.status === 'running' || run.status === 'reserved') return 'Not heard from recently. The record below is the last the lab stored.'
  return `Did not finish${run.reason ? `: ${run.reason}` : '.'}`
}

function curveSvg(share: number[], steps: number): SVGSVGElement {
  const w = 300
  const h = 110
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', share.length ? `Mean reward per step: ${share.map(s => s.toFixed(2)).join(', ')}` : 'No steps recorded yet')
  svg.classList.add('pb-curve')
  const mx = 26
  const my = 10
  for (let i = 0; i <= 4; i++) {
    const y = my + ((h - 2 * my) * i) / 4
    const line = document.createElementNS(SVG, 'line')
    line.setAttribute('x1', String(mx)); line.setAttribute('x2', String(w - 6)); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y))
    line.setAttribute('class', 'pb-grid')
    svg.appendChild(line)
  }
  for (const [i, label] of [[0, '1'], [4, '0']] as const) {
    const t = document.createElementNS(SVG, 'text')
    t.setAttribute('x', '2'); t.setAttribute('y', String(my + ((h - 2 * my) * i) / 4 + 4))
    t.setAttribute('class', 'pb-axis')
    t.textContent = label
    svg.appendChild(t)
  }
  const pts = curvePoints({ curve: share, curveSteps: steps })
  const at = (p: { x: number; y: number }): [number, number] => [mx + p.x * (w - mx - 6), h - my - p.y * (h - 2 * my)]
  if (pts.length) {
    const path = document.createElementNS(SVG, 'polyline')
    path.setAttribute('points', pts.map(p => at(p).map(n => n.toFixed(1)).join(',')).join(' '))
    path.setAttribute('class', 'pb-line'); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    for (const p of pts) {
      const [x, y] = at(p)
      const c = document.createElementNS(SVG, 'circle')
      c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1)); c.setAttribute('r', '3'); c.setAttribute('class', 'pb-dot')
      svg.appendChild(c)
    }
  }
  return svg
}

export class PracticeBenchPanel {
  private container: HTMLDivElement
  private panel: HTMLDivElement
  private body: HTMLDivElement
  private isOpen = false
  private practice: Practice | null = null
  private simulation = true
  /** What was last given to setPractice, as text: the same record again changes nothing on the page. */
  private given = JSON.stringify([null, true])
  private lastFocus: HTMLElement | null = null

  /** `onTalk` is called with the adapter's lab id when the visitor chooses to talk to it. */
  constructor(private onTalk: (modelId: string) => void) {
    installPaperTheme()
    this.container = el('div')
    this.container.id = 'practice-bench-container'
    const style = document.createElement('style')
    style.textContent = `
      ${paperShell('#practice-bench-panel')}
      #practice-bench-panel { position: fixed; left: 20px; bottom: 76px; width: min(420px, calc(100vw - 40px)); max-height: min(78vh, calc(100dvh - 250px)); display: none; flex-direction: column; overflow: hidden; z-index: 1090; font-size: 13px; line-height: 1.45; }
      #practice-bench-panel.open { display: flex; }
      #practice-bench-panel .pb-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 6px 6px 16px; }
      ${paperHeader('#practice-bench-panel .pb-head')}
      ${paperHeading('#practice-bench-panel .pb-title', 17)}
      #practice-bench-panel .pb-close { width: 44px; height: 44px; border: 0; background: transparent; color: var(--paper-ink-2); font-size: 24px; cursor: pointer; border-radius: var(--paper-radius-sm); }
      #practice-bench-panel .pb-close:hover { color: var(--paper-ink); background: var(--paper-sunk); }
      ${paperFocusRing('#practice-bench-panel')}
      #practice-bench-panel .pb-body { overflow-y: auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
      #practice-bench-panel h3 { margin: 0 0 4px; }
      ${paperHeading('#practice-bench-panel h3', 15)}
      #practice-bench-panel p { margin: 0; }
      #practice-bench-panel ul { margin: 0; padding-left: 16px; }
      #practice-bench-panel li { margin: 2px 0; }
      #practice-bench-panel .pb-muted { color: var(--paper-ink-2); }
      #practice-bench-panel .pb-row { display: flex; justify-content: space-between; gap: 12px; }
      #practice-bench-panel .pb-row b { font-weight: 600; text-align: right; color: var(--paper-ink); }
      #practice-bench-panel .pb-curve { width: 100%; height: auto; max-height: 130px; background: var(--paper-sunk); border-radius: var(--paper-radius-sm); }
      #practice-bench-panel .pb-grid { stroke: var(--paper-line); stroke-opacity: 0.35; }
      #practice-bench-panel .pb-axis { fill: var(--paper-ink-2); font-size: 13px; }
      #practice-bench-panel .pb-line { stroke: var(--paper-ink); }
      #practice-bench-panel .pb-dot { fill: var(--paper-ink); }
      #practice-bench-panel .pb-flag { border: 1px solid var(--paper-danger); border-radius: var(--paper-radius-sm); padding: 8px 10px; background: var(--paper-danger-bg); color: var(--paper-ink); }
      #practice-bench-panel .pb-flag b { color: var(--paper-danger); }
      #practice-bench-panel .pb-sample { border-left: 3px solid var(--pb-reward, var(--paper-line)); border-left-color: color-mix(in srgb, var(--pb-reward, var(--paper-line)) 65%, var(--paper-ink)); padding: 2px 0 2px 8px; margin: 6px 0; }
      #practice-bench-panel .pb-sample i { color: var(--paper-ink-2); font-style: normal; }
      #practice-bench-panel .pb-talk { min-height: 44px; font: inherit; font-size: 13px; font-weight: 600; padding: 0 16px; }
      ${paperPrimaryButton('#practice-bench-panel .pb-talk')}
      #practice-bench-panel .pb-talk:hover, #practice-bench-panel .pb-talk:active { border-color: var(--paper-ink); }
      @media (max-width: 760px) { #practice-bench-panel { left: 8px; right: 8px; width: auto; bottom: 8px; max-height: calc(100dvh - 16px); } }
    `
    this.container.appendChild(style)
    this.panel = el('div')
    this.panel.id = 'practice-bench-panel'
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-label', 'The Practice Bench')
    const head = el('div', 'pb-head')
    head.appendChild(el('div', 'pb-title', 'The Practice Bench'))
    const close = el('button', 'pb-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.addEventListener('click', () => this.close())
    head.appendChild(close)
    this.body = el('div', 'pb-body')
    this.body.setAttribute('aria-live', 'polite')
    this.panel.append(head, this.body)
    this.container.appendChild(this.panel)
    document.body.appendChild(this.container)
    this.panel.addEventListener('keydown', e => { if (e.key === 'Escape') this.close() })
    this.render()
  }

  /** What the room's state says about Tinker RL, and whether no experiment is connected. */
  public setPractice(practice: Practice | null, simulation: boolean): void {
    // The same record again (another record of the room changed, or nothing did): nothing is redrawn, so a reader keeps
    // their place and their keyboard focus.
    const given = JSON.stringify([practice, simulation])
    if (given === this.given) return
    this.given = given
    this.practice = practice
    this.simulation = simulation
    if (this.isOpen) this.render()
  }

  public get open(): boolean { return this.isOpen }

  public show(): void {
    if (this.isOpen) return
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.isOpen = true
    this.render()
    this.panel.classList.add('open')
    ;(this.panel.querySelector('.pb-close') as HTMLButtonElement).focus()
  }

  public close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.panel.classList.remove('open')
    this.lastFocus?.focus?.()
  }

  private section(title: string, ...children: Array<Node | null>): HTMLElement {
    const s = el('section')
    s.appendChild(el('h3', undefined, title))
    for (const c of children) if (c) s.appendChild(c)
    return s
  }

  private row(label: string, value: string): HTMLElement {
    const r = el('div', 'pb-row')
    r.append(el('span', 'pb-muted', label), el('b', undefined, value))
    return r
  }

  /** Redraws the body. The scroll position and the focused control stay where they were. */
  private render(): void {
    redrawInPlace(this.body, () => this.draw())
  }

  private draw(): void {
    this.body.replaceChildren()
    const practice = this.practice
    if (this.simulation) {
      this.body.appendChild(el('p', undefined, `${NO_EXPERIMENT}. The bench stays idle: nothing on it is model work.`))
      return
    }
    const run = practice?.run ?? null
    if (!run) {
      this.body.appendChild(el('p', undefined, `${NOTHING_PRACTISED}.`))
      this.body.appendChild(el('p', 'pb-muted', practice && !practice.enabled
        ? `Tinker RL is off here${practice.offReason ? `: ${practice.offReason}` : ''}.`
        : 'When a model asks for a reinforcement-learning run and the Reviewer approves it, the bench draws it here as it goes.'))
      return
    }
    const view = benchView(practice, false)
    const title = run.name ?? run.taskSet ?? `Epoch ${run.epoch} practice`
    const head = el('div')
    head.appendChild(el('p', undefined, title)).style.fontWeight = '600'
    head.appendChild(el('p', 'pb-muted', `Epoch ${run.epoch}, asked for by ${run.authorName}. Base model ${run.baseModel}.`))
    if (run.purpose) head.appendChild(el('p', 'pb-muted', run.purpose))
    head.appendChild(el('p', undefined, runStatusLine(run)))
    this.body.appendChild(head)

    if (run.hacking.flag) {
      const flag = el('div', 'pb-flag')
      flag.appendChild(el('b', undefined, 'Reward Hacking Flag. '))
      flag.appendChild(document.createTextNode(`The lab noticed a sign that the reward may be easier to earn than the rubric means. ${run.hacking.reasons.map(sentence).join(' ')} It blocks nothing; it is recorded here.`))
      this.body.appendChild(flag)
    }
    const cutOffText = cutOffFlagText(run)
    if (cutOffText) {
      const flag = el('div', 'pb-flag')
      flag.appendChild(el('b', undefined, `${CUT_OFF_FLAG_LABEL} `))
      flag.appendChild(document.createTextNode(cutOffText))
      this.body.appendChild(flag)
    }

    const total = run.tasks.total
    this.body.appendChild(this.section('Task Set',
      el('p', undefined, `${total} tasks${run.taskSet ? `, "${run.taskSet}"` : ''}. ${run.tasks.heldOut !== null ? `The lab held out ${run.tasks.heldOut} of them, chosen after the request so nobody could know which, and trained on ${run.tasks.training ?? total - run.tasks.heldOut}.` : ''}`),
      el('p', 'pb-muted', `Data origin: ${run.origin}.`)))

    if (run.rubric.length) {
      const list = el('ul')
      for (const rule of run.rubric) list.appendChild(el('li', undefined, rule))
      this.body.appendChild(this.section('Rubric', list, el('p', 'pb-muted', 'Each rule gives 0 or 1. The reward is the weighted sum, from 0 to 1, computed by the lab\'s own code. No model-written code runs.')))
    }

    const s = run.settings
    const steps = view.steps
    const stepRows = el('div')
    stepRows.appendChild(this.row('Steps', steps > 0 ? `${view.step} of ${steps}` : 'none yet'))
    const trained = run.progress?.stepsTrained ?? null
    if (trained !== null && steps > 0) stepRows.appendChild(this.row('Steps That Trained The Model', `${trained} of ${view.step}`))
    if (s) {
      stepRows.appendChild(this.row('Answers Per Task', String(s.groupSize)))
      stepRows.appendChild(this.row('Tasks Per Step', String(s.tasksPerStep)))
      stepRows.appendChild(this.row('Longest Answer', `${s.maxCompletionTokens} tokens`))
      stepRows.appendChild(this.row('Loss, Learning Rate', `${s.loss}, ${s.learningRate}`))
    }
    for (const r of stepCutOffRows(run)) stepRows.appendChild(this.row(r.label, r.value))
    this.body.appendChild(this.section('Steps', stepRows))

    this.body.appendChild(this.section('Reward Per Step', curveSvg(view.curve, steps),
      el('p', 'pb-muted', 'Mean reward of each step as a share of the best score. This is the reward the run trained on, reported by the runner while it trained. It is not a measure of what the model learned.')))

    const held = el('div')
    held.appendChild(this.row('Before Training', scoreText(view.before)))
    held.appendChild(this.row('After Training', scoreText(view.after)))
    for (const r of heldOutCutOffRows(run)) held.appendChild(this.row(r.label, r.value))
    this.body.appendChild(this.section('Held-Out Score, Measured By The Lab', held,
      el('p', 'pb-muted', `Mean rubric score on tasks the model never trained on${run.heldOut?.tasks ? ` (${run.heldOut.tasks} tasks)` : ''}, from 0 to 1. Higher is better.`)))

    const cost = el('div')
    cost.appendChild(this.row('Estimated Cost', dollars(run.cost.estimatedUsd)))
    if (run.cost.maxUsd !== null) cost.appendChild(this.row('Set Aside As The Most It Could Cost', dollars(run.cost.maxUsd)))
    this.body.appendChild(this.section('Cost', cost, el('p', 'pb-muted', run.cost.basis)))

    const samples = run.progress?.samples ?? []
    if (samples.length) {
      const box = el('div')
      for (const sample of samples) {
        const item = el('div', 'pb-sample')
        item.style.setProperty('--pb-reward', `#${rewardColor(sample.reward / (run.progress?.maxReward ?? 1)).toString(16).padStart(6, '0')}`)
        item.appendChild(el('div', undefined, plain(sample.prompt, 100) ?? ''))
        item.appendChild(el('div', undefined, plain(sample.completion, 160) ?? '(empty)'))
        item.appendChild(el('i', undefined, `reward ${sample.reward.toFixed(2)}`))
        box.appendChild(item)
      }
      this.body.appendChild(this.section('Sample Attempts', box, el('p', 'pb-muted', 'Short, cut samples of what the model answered. The model wrote them; the lab did not review them.')))
    }

    if (run.talk) {
      const talk = el('button', 'pb-talk', 'Talk To The Trained Model')
      talk.type = 'button'
      const id = run.talk
      talk.addEventListener('click', () => { this.close(); this.onTalk(id) })
      this.body.appendChild(talk)
    }
  }

  public dispose(): void {
    this.container.remove()
  }
}
