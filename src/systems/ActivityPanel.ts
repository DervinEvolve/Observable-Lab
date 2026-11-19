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
    this.container = document.createElement('div')
    this.container.id = 'activity-panel-container'
    this.container.innerHTML = `
      <style>
        #activity-panel-container { position: fixed; bottom: 76px; right: 20px; z-index: 150; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
        #activity-toggle { width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); border: 1px solid rgba(0,0,0,0.1); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 12px rgba(0,0,0,0.1); transition: all 0.2s ease; }
        #activity-toggle:hover { transform: scale(1.05); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
        #activity-toggle svg { width: 20px; height: 20px; opacity: 0.6; }
        #activity-panel { position: absolute; bottom: 56px; right: 0; width: min(380px, calc(100vw - 40px)); max-height: min(70vh, calc(100vh - 160px)); background: rgba(20,20,20,0.92); backdrop-filter: blur(16px); border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); opacity: 0; transform: translateY(10px) scale(0.95); pointer-events: none; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); overflow: hidden; display: flex; flex-direction: column; }
        #activity-panel.open { opacity: 1; transform: none; pointer-events: auto; }
        #activity-panel .act-head { padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        #activity-panel .act-title { color: #f5f2eb; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; }
        #activity-panel .act-sub { color: rgba(255,255,255,0.4); font-size: 9px; text-transform: uppercase; letter-spacing: 0.8px; }
        #activity-panel .act-nav button { background: rgba(255,255,255,0.08); color: #f5f2eb; border: 0; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
        #activity-panel .act-nav button:disabled { opacity: 0.3; cursor: default; }
        #activity-panel .act-body { overflow-y: auto; padding: 10px 14px 14px; color: rgba(245,242,235,0.85); font-size: 11px; line-height: 1.45; }
        #activity-panel .act-legend { color: rgba(255,255,255,0.45); font-size: 10px; margin-bottom: 10px; }
        #activity-panel .act-role { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
        #activity-panel .act-who { margin-bottom: 4px; }
        #activity-panel .act-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
        #activity-panel .act-role-name { color: rgba(255,255,255,0.45); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 4px; }
        #activity-panel .act-fallback { font-size: 9px; color: #ffb74d; border: 1px solid rgba(255,183,77,0.4); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
        #activity-panel .act-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        #activity-panel .act-label { color: rgba(255,255,255,0.4); font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
        #activity-panel ul { margin: 0; padding-left: 14px; }
        #activity-panel li { margin: 1px 0; word-break: break-word; }
        #activity-panel a { color: #8fc1ff; text-decoration: none; }
        #activity-panel a:hover { text-decoration: underline; }
        #activity-panel .act-domain { color: rgba(255,255,255,0.35); font-size: 9px; margin-left: 3px; }
        #activity-panel .act-none { color: rgba(255,255,255,0.35); font-style: italic; }
        #activity-panel .act-flag { margin-top: 5px; padding: 4px 6px; border-radius: 6px; background: rgba(255,183,77,0.1); color: #ffcc80; font-size: 10px; }
        #activity-panel .act-section { margin: 12px 0 4px; color: #f5f2eb; font-weight: 600; font-size: 11px; }
        #activity-panel .act-tool { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
        #activity-panel .act-status { color: rgba(255,255,255,0.55); }
        #activity-panel .act-request { color: rgba(255,255,255,0.55); margin-top: 2px; }
        #activity-panel .act-output { margin: 4px 0 0; padding: 6px; background: rgba(0,0,0,0.35); border-radius: 6px; font: 10px/1.35 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; color: rgba(245,242,235,0.75); }
        #activity-panel .act-spend { display: flex; flex-wrap: wrap; gap: 4px 10px; color: rgba(255,255,255,0.55); font-size: 10px; }
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
