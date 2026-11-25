// What each model did in an epoch, beside what it said it did. Reads the
// public research record (GET /api/experiment/activity, api/_lib/activity.ts)
// and shows it in plain words: the searches a model reported, the pages it
// was recorded citing, the commands it ran in its Sprite, its pull request,
// its cost, and the places where its account and the record disagree.
//
// Everything shown comes from that record; with no backend the panel says so
// and shows nothing invented.
import { BACKEND_TO_FRONTEND_MODEL, type ModelId } from '../shared/types'
import { COLORS } from '../scene/colors'
import { installPaperTheme, paperFocusRing, paperShell, paperHeader, paperHeading, paperQuietButton } from './paperTheme'

const API = '/api/experiment/activity'
const REFRESH_MS = 30_000

interface SourceLink { url: string; title: string; domain: string }
interface RoleActivity {
  role: string
  assigned_model: string
  answered_by: string
  answered_by_name: string
  fallback: boolean
  had_web_access: boolean
  claimed_searches: string[]
  recorded_sources: SourceLink[]
  flags: string[]
}
interface ToolActivity {
  tool: string
  model_name: string
  request: string | null
  status: string
  exit_code: number | null
  output_tail: string | null
}
interface ContributionActivity {
  author: string
  pr_url: string | null
  merged: boolean
  ci_passed: boolean | null
  sprite_tests: string
  explorer_task: string | null
  explorer_claimed_searches: string[]
  explorer_recorded_sources: SourceLink[]
  flags: string[]
}
interface SpendByModel { model: string; model_name: string; cost_usd: number; requests: number }
interface EpochActivity {
  epoch_number: number
  follow_up: { status: string; pr_url?: string | null; merged?: boolean; ci_passed?: boolean | null } | null
  roles: RoleActivity[]
  tools: ToolActivity[]
  contributions: ContributionActivity[]
  spend: SpendByModel[]
  totals: { cost_usd: number; searches_claimed: number; sources_recorded: number; flags: number }
}

const ROLE_LABEL: Record<string, string> = {
  planner: 'Planner', executor: 'Executor', challenger: 'Challenger', rebuttal: 'Executor, rebuttal',
  reviewer: 'Reviewer', commentator: 'Commentator',
}
const TOOL_LABEL: Record<string, string> = {
  sprite_session: 'ran commands in its Sprite', gpu_job: 'ran a GPU job', weights: 'asked for public weights',
  datasets: 'asked for a public dataset', dataset_rows: 'had the lab read rows of a public dataset',
  subagent_explore: 'sent an explorer subagent',
  subagent_test: 'sent a test subagent', exhibit: 'proposed an exhibit', lab_proposal: 'proposed a change to the lab',
  tinker_train: 'fine-tuned a model on Tinker (scores measured by the lab)',
  tinker_name: 'asked for a display name for its adapter',
  keep_adapter: 'asked the lab to keep a trained adapter',
  owner_keep_adapter: 'kept a trained adapter',
  owner_unkeep_adapter: 'stopped keeping a trained adapter',
  owner_clear_adapter_name: 'took a display name off an adapter',
  kept_adapter_expired: 'had a kept adapter reach the end of its time',
}

function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c)
}

/** Only plain http(s) links become anchors. */
export function safeHref(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 500) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

function colorFor(modelId: string): string {
  const fid = BACKEND_TO_FRONTEND_MODEL[modelId as ModelId]
  const hex = (fid && COLORS.models[fid]) || 0x9aa4ad
  return '#' + hex.toString(16).padStart(6, '0')
}

function sourcesHtml(list: SourceLink[]): string {
  return list.map(s => {
    const href = safeHref(s.url)
    const label = `${esc(s.title || s.domain)} <span class="act-domain">${esc(s.domain)}</span>`
    return href
      ? `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a></li>`
      : `<li>${label}</li>`
  }).join('')
}

function flagsHtml(flags: string[]): string {
  return flags.map(f => `<div class="act-flag">Observation: ${esc(f)}</div>`).join('')
}

/** One epoch of the record as HTML. Exported for tests. */
export function renderEpochActivity(a: EpochActivity): string {
  const roles = a.roles.map(r => {
    const said = r.claimed_searches.length
      ? `<ul class="act-said">${r.claimed_searches.map(q => `<li>&ldquo;${esc(q)}&rdquo;</li>`).join('')}</ul>`
      : `<div class="act-none">no searches reported</div>`
    const recorded = r.recorded_sources.length
      ? `<ul class="act-sources">${sourcesHtml(r.recorded_sources)}</ul>`
      : `<div class="act-none">${r.had_web_access ? 'no pages recorded' : 'this role works without web search'}</div>`
    return `
      <div class="act-role">
        <div class="act-who"><span class="act-dot" style="background:${colorFor(r.answered_by)}"></span>
          <b>${esc(r.answered_by_name)}</b> <span class="act-role-name">${esc(ROLE_LABEL[r.role] || r.role)}</span>
          ${r.fallback ? `<span class="act-fallback">fallback</span>` : ''}
        </div>
        <div class="act-cols">
          <div><div class="act-label">Said it searched</div>${said}</div>
          <div><div class="act-label">Recorded pages cited</div>${recorded}</div>
        </div>
        ${flagsHtml(r.flags)}
      </div>`
  }).join('')

  const tools = a.tools.length ? `
    <div class="act-section">Tools</div>
    ${a.tools.map(t => `
      <div class="act-tool">
        <div><b>${esc(t.model_name)}</b> ${esc(TOOL_LABEL[t.tool] || t.tool)}: <span class="act-status">${esc(t.status)}${t.exit_code !== null ? `, exit ${esc(t.exit_code)}` : ''}</span></div>
        ${t.request ? `<div class="act-request">${esc(t.request)}</div>` : ''}
        ${t.output_tail ? `<pre class="act-output">${esc(t.output_tail.slice(-600))}</pre>` : ''}
      </div>`).join('')}` : ''

  const contributions = a.contributions.map(c => {
    const href = safeHref(c.pr_url)
    const ci = c.ci_passed === true ? 'CI passed' : c.ci_passed === false ? 'CI failed' : 'no CI result'
    return `
      <div class="act-tool">
        <div><b>${esc(c.author)}</b> wrote code: ${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">pull request</a>` : 'no pull request'},
          ${esc(ci)}, Sprite tests ${esc(c.sprite_tests)}, ${c.merged ? '<b>merged</b>' : 'not merged'}</div>
        ${c.explorer_task ? `<div class="act-request">Explorer: ${esc(c.explorer_task)}</div>` : ''}
        ${c.explorer_recorded_sources.length ? `<ul class="act-sources">${sourcesHtml(c.explorer_recorded_sources)}</ul>` : ''}
        ${flagsHtml(c.flags)}
      </div>`
  }).join('')

  const fu = a.follow_up
  const followUp = fu && fu.status !== 'none' && !a.contributions.length
    ? `<div class="act-none">Code contribution: ${fu.status === 'pending' ? 'queued, runs at the next hourly check' : esc(fu.status)}</div>`
    : ''

  const spend = a.spend.length ? `
    <div class="act-section">Cost this epoch: $${a.totals.cost_usd.toFixed(2)}</div>
    <div class="act-spend">${a.spend.map(s => `<span>${esc(s.model_name)} $${s.cost_usd.toFixed(3)}</span>`).join('')}</div>` : ''

  return `
    <div class="act-legend">"Said" is the model's own report. "Recorded" was logged by the lab or OpenRouter. Observations mark where they differ.</div>
    ${roles || '<div class="act-none">No role has answered yet.</div>'}
    ${tools}
    ${contributions || followUp ? `<div class="act-section">Code</div>${contributions}${followUp}` : ''}
    ${spend}`
}

export class ActivityPanel {
  private container: HTMLDivElement
  private panel: HTMLDivElement
  private body: HTMLDivElement
  private title: HTMLDivElement
  private isOpen = false
  private epoch: number | 'latest' = 'latest'
  private latest: number | null = null
  private timer: number | null = null

  constructor() {
    installPaperTheme()
    this.container = document.createElement('div')
    this.container.id = 'activity-panel-container'
    this.container.innerHTML = `
      <style>
        #activity-panel-container { position: fixed; bottom: 76px; right: 20px; z-index: 150; font-family: var(--paper-sans); }
        ${paperFocusRing('#activity-panel-container')}
        #activity-toggle { width: 44px; height: 44px; border-radius: 50%; background: var(--paper-raised-veil); backdrop-filter: blur(8px); border: 1px solid var(--paper-line); color: var(--paper-ink); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: var(--paper-shadow-soft); transition: all 0.2s ease; }
        #activity-toggle:hover { transform: scale(1.05); box-shadow: var(--paper-shadow-lift); }
        #activity-toggle svg { width: 20px; height: 20px; opacity: 0.8; }
        #activity-panel { position: absolute; bottom: 56px; right: 0; width: min(380px, calc(100vw - 40px)); max-height: min(70vh, calc(100vh - 160px)); opacity: 0; transform: translateY(10px) scale(0.95); pointer-events: none; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); overflow: hidden; display: flex; flex-direction: column; }
        ${paperShell('#activity-panel')}
        #activity-panel.open { opacity: 1; transform: none; pointer-events: auto; }
        #activity-panel .act-head { padding: 9px 14px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        ${paperHeader('#activity-panel .act-head')}
        #activity-panel .act-title { line-height: 1.25; }
        ${paperHeading('#activity-panel .act-title', 16)}
        #activity-panel .act-sub { color: var(--paper-ink-2); font-size: 13px; line-height: 1.3; }
        #activity-panel .act-nav button { padding: 3px 8px; font-size: 11px; }
        ${paperQuietButton('#activity-panel .act-nav button')}
        #activity-panel .act-nav button { border-radius: var(--paper-radius-sm); }
        #activity-panel .act-nav button:disabled { opacity: 0.55; cursor: default; }
        #activity-panel .act-nav button:disabled:hover { background: var(--paper-raised); border-color: var(--paper-line); }
        #activity-panel .act-body { overflow-y: auto; padding: 10px 14px 14px; color: var(--paper-ink); font-size: 13px; line-height: 1.45; }
        #activity-panel .act-legend { color: var(--paper-ink-2); font-size: 13px; margin-bottom: 10px; }
        #activity-panel .act-role { padding: 8px 0; border-bottom: 1px solid var(--paper-hair); }
        #activity-panel .act-who { margin-bottom: 4px; }
        #activity-panel .act-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; box-shadow: 0 0 0 1px var(--paper-line); }
        #activity-panel .act-role-name { color: var(--paper-ink-2); font-size: 13px; margin-left: 4px; }
        #activity-panel .act-fallback { font-size: 13px; color: var(--paper-ink); border: 1px solid var(--paper-brass-edge); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
        #activity-panel .act-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        #activity-panel .act-label { color: var(--paper-ink-2); font-size: 13px; font-weight: 700; letter-spacing: 0.2px; margin-bottom: 2px; }
        #activity-panel ul { margin: 0; padding-left: 14px; }
        #activity-panel li { margin: 1px 0; word-break: break-word; }
        #activity-panel a { color: var(--paper-brass-ink); text-decoration: underline; text-underline-offset: 2px; }
        #activity-panel a:hover { color: var(--paper-ink); }
        #activity-panel .act-domain { color: var(--paper-ink-2); font-size: 13px; margin-left: 3px; }
        #activity-panel .act-none { color: var(--paper-ink-2); font-style: italic; }
        #activity-panel .act-flag { margin-top: 5px; padding: 4px 6px; border-radius: var(--paper-radius-sm); background: var(--paper-visitor); box-shadow: inset 0 0 0 1px var(--paper-line); color: var(--paper-ink); font-size: 13px; }
        #activity-panel .act-section { margin: 12px 0 4px; }
        ${paperHeading('#activity-panel .act-section', 15)}
        #activity-panel .act-tool { padding: 6px 0; border-bottom: 1px solid var(--paper-hair); }
        #activity-panel .act-status { color: var(--paper-ink-2); }
        #activity-panel .act-request { color: var(--paper-ink-2); margin-top: 2px; }
        #activity-panel .act-output { margin: 4px 0 0; padding: 6px; background: var(--paper-sunk); box-shadow: inset 0 0 0 1px var(--paper-hair); border-radius: var(--paper-radius-sm); font: 13px/1.35 var(--paper-mono); white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; color: var(--paper-ink); }
        #activity-panel .act-spend { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--paper-ink-2); font-size: 13px; }
        @media (prefers-reduced-motion: reduce) { #activity-toggle, #activity-panel { transition: none; } }
      </style>`
    document.body.appendChild(this.container)

    const toggle = document.createElement('button')
    toggle.id = 'activity-toggle'
    toggle.title = 'What each model did'
    toggle.setAttribute('aria-label', 'What each model did')
    toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>`
    toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()))
    this.container.appendChild(toggle)

    this.panel = document.createElement('div')
    this.panel.id = 'activity-panel'
    this.panel.innerHTML = `
      <div class="act-head">
        <div><div class="act-title">What each model did</div><div class="act-sub" data-sub>Loading</div></div>
        <div class="act-nav"><button data-prev aria-label="Earlier epoch">&lsaquo;</button> <button data-next aria-label="Later epoch">&rsaquo;</button></div>
      </div>
      <div class="act-body"></div>`
    this.container.appendChild(this.panel)
    this.body = this.panel.querySelector('.act-body') as HTMLDivElement
    this.title = this.panel.querySelector('[data-sub]') as HTMLDivElement
    ;(this.panel.querySelector('[data-prev]') as HTMLButtonElement).addEventListener('click', () => this.step(-1))
    ;(this.panel.querySelector('[data-next]') as HTMLButtonElement).addEventListener('click', () => this.step(1))

    document.addEventListener('click', e => {
      if (this.isOpen && !this.container.contains(e.target as Node)) this.close()
    })
  }

  open(): void {
    this.isOpen = true
    this.panel.classList.add('open')
    void this.load()
    this.timer = window.setInterval(() => { if (this.epoch === 'latest') void this.load() }, REFRESH_MS)
  }

  close(): void {
    this.isOpen = false
    this.panel.classList.remove('open')
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  private step(delta: number): void {
    const current = this.epoch === 'latest' ? this.latest : this.epoch
    if (current === null) return
    const next = Math.max(1, current + delta)
    this.epoch = this.latest !== null && next >= this.latest ? 'latest' : next
    void this.load()
  }

  private updateNav(shown: number | null): void {
    ;(this.panel.querySelector('[data-prev]') as HTMLButtonElement).disabled = shown === null || shown <= 1
    ;(this.panel.querySelector('[data-next]') as HTMLButtonElement).disabled = shown === null || this.latest === null || shown >= this.latest
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${API}?epoch=${this.epoch}`)
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json() as { epochs?: EpochActivity[] }
      const a = data.epochs?.[0]
      if (!a) {
        this.title.textContent = 'No epochs yet'
        this.body.innerHTML = '<div class="act-none">The first epoch has not finished a role yet.</div>'
        this.updateNav(null)
        return
      }
      if (this.epoch === 'latest') this.latest = a.epoch_number
      this.title.textContent = `Epoch ${a.epoch_number}`
      this.body.innerHTML = renderEpochActivity(a)
      this.updateNav(a.epoch_number)
    } catch {
      this.title.textContent = 'Not connected'
      this.body.innerHTML = '<div class="act-none">The activity record is not available here (no experiment connected).</div>'
      this.updateNav(null)
    }
  }
}
