import { NOTHING_PRACTISED, NO_EXPERIMENT, benchView, curvePoints, plain, rewardColor, scoreText, type Practice, type PracticeRun } from './practiceBench'

// The practice bench's record, opened by clicking or tapping the bench in the
// room. It shows what the lab stored about the newest Tinker RL run: the task
// set, the rubric in words, the steps and the reward curve, the held-out score
// before and after (measured by the lab), the cost estimate, a few short
// sample answers, the reward-hacking flag, and a way to talk to the adapter
// when it can be talked to. Every text is put on the page as text, never as
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

/** A reason as a sentence: a capital letter first and a full stop last. */
export function sentence(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const up = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(up) ? up : `${up}.`
}

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
    line.setAttribute('stroke', 'rgba(245,242,235,0.14)')
    svg.appendChild(line)
  }
  for (const [i, label] of [[0, '1'], [4, '0']] as const) {
    const t = document.createElementNS(SVG, 'text')
    t.setAttribute('x', '2'); t.setAttribute('y', String(my + ((h - 2 * my) * i) / 4 + 4))
    t.setAttribute('fill', 'rgba(245,242,235,0.5)'); t.setAttribute('font-size', '10')
    t.textContent = label
    svg.appendChild(t)
  }
  const pts = curvePoints({ curve: share, curveSteps: steps })
  const at = (p: { x: number; y: number }): [number, number] => [mx + p.x * (w - mx - 6), h - my - p.y * (h - 2 * my)]
  if (pts.length) {
    const path = document.createElementNS(SVG, 'polyline')
    path.setAttribute('points', pts.map(p => at(p).map(n => n.toFixed(1)).join(',')).join(' '))
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#64b5f6'); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    for (const p of pts) {
      const [x, y] = at(p)
      const c = document.createElementNS(SVG, 'circle')
      c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1)); c.setAttribute('r', '3'); c.setAttribute('fill', '#64b5f6')
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
  private lastFocus: HTMLElement | null = null

  /** `onTalk` is called with the adapter's lab id when the visitor chooses to talk to it. */
  constructor(private onTalk: (modelId: string) => void) {
    this.container = el('div')
    this.container.id = 'practice-bench-container'
    const style = document.createElement('style')
    style.textContent = `
      #practice-bench-panel { position: fixed; left: 20px; bottom: 76px; width: min(420px, calc(100vw - 40px)); max-height: min(78vh, calc(100dvh - 250px)); background: rgba(24,22,19,0.95); backdrop-filter: blur(16px); border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); border: 1px solid rgba(181,166,66,0.25); display: none; flex-direction: column; overflow: hidden; z-index: 1090; color: rgba(245,242,235,0.88); font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12px; line-height: 1.45; }
      #practice-bench-panel.open { display: flex; }
      #practice-bench-panel .pb-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 6px 6px 16px; border-bottom: 1px solid rgba(181,166,66,0.2); }
      #practice-bench-panel .pb-title { font-family: Georgia, serif; font-size: 15px; font-weight: 600; color: #b5a642; }
      #practice-bench-panel .pb-close { width: 44px; height: 44px; border: 0; background: transparent; color: rgba(245,242,235,0.7); font-size: 24px; cursor: pointer; border-radius: 8px; }
      #practice-bench-panel .pb-close:hover, #practice-bench-panel .pb-close:focus-visible { color: #f5f2eb; background: rgba(245,242,235,0.08); outline: none; }
      #practice-bench-panel .pb-body { overflow-y: auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
      #practice-bench-panel h3 { margin: 0 0 4px; font-family: Georgia, serif; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(181,166,66,0.9); }
      #practice-bench-panel p { margin: 0; }
      #practice-bench-panel ul { margin: 0; padding-left: 16px; }
      #practice-bench-panel li { margin: 2px 0; }
      #practice-bench-panel .pb-muted { color: rgba(245,242,235,0.55); }
      #practice-bench-panel .pb-row { display: flex; justify-content: space-between; gap: 12px; }
      #practice-bench-panel .pb-row b { font-weight: 600; text-align: right; }
      #practice-bench-panel .pb-curve { width: 100%; height: auto; max-height: 130px; background: rgba(245,242,235,0.04); border-radius: 8px; }
      #practice-bench-panel .pb-flag { border: 1px solid #e57373; border-radius: 8px; padding: 8px 10px; background: rgba(229,115,115,0.1); }
      #practice-bench-panel .pb-flag b { color: #e57373; }
      #practice-bench-panel .pb-sample { border-left: 3px solid var(--pb-reward, #ffb74d); padding: 2px 0 2px 8px; margin: 6px 0; }
      #practice-bench-panel .pb-sample i { color: rgba(245,242,235,0.55); font-style: normal; }
      #practice-bench-panel .pb-talk { min-height: 44px; border-radius: 10px; border: 1px solid rgba(181,166,66,0.5); background: rgba(181,166,66,0.16); color: #f5f2eb; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 0 16px; }
      #practice-bench-panel .pb-talk:hover, #practice-bench-panel .pb-talk:focus-visible { background: rgba(181,166,66,0.3); outline: none; }
      @media (max-width: 760px) { #practice-bench-panel { left: 8px; right: 8px; width: auto; bottom: 8px; max-height: calc(100dvh - 16px); } }
    `
    this.container.appendChild(style)
    this.panel = el('div')
    this.panel.id = 'practice-bench-panel'
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-label', 'The practice bench')
    const head = el('div', 'pb-head')
    head.appendChild(el('div', 'pb-title', 'The practice bench'))
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

  private render(): void {
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
      flag.appendChild(el('b', undefined, 'Reward hacking flag. '))
      flag.appendChild(document.createTextNode(`The lab noticed a sign that the reward may be easier to earn than the rubric means. ${run.hacking.reasons.map(sentence).join(' ')} It blocks nothing; it is recorded here.`))
      this.body.appendChild(flag)
    }

    const total = run.tasks.total
    this.body.appendChild(this.section('Task set',
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
    if (s) {
      stepRows.appendChild(this.row('Answers per task', String(s.groupSize)))
      stepRows.appendChild(this.row('Tasks per step', String(s.tasksPerStep)))
      stepRows.appendChild(this.row('Longest answer', `${s.maxCompletionTokens} tokens`))
      stepRows.appendChild(this.row('Loss, learning rate', `${s.loss}, ${s.learningRate}`))
    }
    this.body.appendChild(this.section('Steps', stepRows))

    this.body.appendChild(this.section('Reward per step', curveSvg(view.curve, steps),
      el('p', 'pb-muted', 'Mean reward of each step as a share of the best score. This is the reward the run trained on, reported by the runner while it trained. It is not a measure of what the model learned.')))

    const held = el('div')
    held.appendChild(this.row('Before training', scoreText(view.before)))
    held.appendChild(this.row('After training', scoreText(view.after)))
    this.body.appendChild(this.section('Held-out score, measured by the lab', held,
      el('p', 'pb-muted', `Mean rubric score on tasks the model never trained on${run.heldOut?.tasks ? ` (${run.heldOut.tasks} tasks)` : ''}, from 0 to 1. Higher is better.`)))

    const cost = el('div')
    cost.appendChild(this.row('Estimated cost', dollars(run.cost.estimatedUsd)))
    if (run.cost.maxUsd !== null) cost.appendChild(this.row('Set aside as the most it could cost', dollars(run.cost.maxUsd)))
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
      this.body.appendChild(this.section('Sample attempts', box, el('p', 'pb-muted', 'Short, cut samples of what the model answered. The model wrote them; the lab did not review them.')))
    }

    if (run.talk) {
      const talk = el('button', 'pb-talk', 'Talk to the trained model')
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
