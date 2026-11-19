// "Talk to what they trained": a small chat with the adapters the lab's
// models fine-tuned on Tinker (docs/TOOLS.md, "Talking to a trained adapter").
//
// It asks for nothing until the room's own state (GET /api/experiment, which
// the page reads anyway) says the chat is switched on: main.ts passes that on
// through setAvailable. With the chat off, which is the default, the panel
// makes no request at all and shows nothing, not even its button. Once it is
// on, the panel reads GET /api/experiment/trained-chat for the adapters, and
// again every two minutes while the chat stays on. Every number shown
// comes from the lab's record of the run: the base model, the epoch, the
// model that wrote the data, and the held-out loss the lab measured before
// and after training. A message goes to POST /api/experiment/trained-chat,
// which holds the limits (message length, turns, a rate limit per visitor
// and a small daily budget) and answers with a plain sentence when one is
// reached.
//
// An adapter may carry a display name its author gave it, and may be marked
// to keep. Both are labels from the lab's record: the name is shown above the
// lab id, which stays the adapter's identity and is what a message is sent
// to, and a kept adapter gets a small "kept" mark. The server lists kept
// adapters first.
//
// All text from the server and from the model is put on the page as text,
// never as markup.

const API = '/api/experiment/trained-chat'
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
  expiresAt: string | null
  /** The display name its author gave it, when it has one. A label only. */
  name: string | null
  /** Marked to keep, and by whom ("the owner" or a model's name). */
  kept: boolean
  keptBy: string | null
}

export interface ChatLimits { maxMessageChars: number; maxTurns: number }

const SLUG = /^e[0-9]{1,6}-[0-9a-f]{8}$/

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

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
      expiresAt: expires,
      name: text(o.name, 40),
      kept: o.kept === true,
      keptBy: o.kept === true ? text(o.kept_by, 60) : null,
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
 * and `mark` ("kept") only for a kept one.
 */
export function describeAdapter(a: TrainedAdapterView): { title: string; id?: string; mark?: string; origin: string; score: string; kept: string } {
  const score = a.lossBefore !== null && a.lossAfter !== null
    ? `Held-out loss ${a.lossBefore.toFixed(2)} before training, ${a.lossAfter.toFixed(2)} after${a.holdoutExamples ? `, on ${a.holdoutExamples} examples the lab held out` : ''}. Measured by the lab. Lower is better.`
    : 'No held-out score recorded.'
  const until = a.expiresAt ? a.expiresAt.slice(0, 10) : ''
  return {
    title: a.name ?? a.modelId,
    ...(a.name ? { id: a.modelId } : {}),
    ...(a.kept ? { mark: 'kept' } : {}),
    origin: `Epoch ${a.epoch}. Data written by ${a.authorName} (${a.examples} examples). Base model ${a.baseModel}.`,
    score,
    kept: a.kept
      ? `Marked to keep${a.keptBy ? ` by ${a.keptBy}` : ''}.${until ? ` Stays until ${until}.` : ''}`
      : until ? `Kept until ${until}.` : '',
  }
}

interface Turn { role: 'user' | 'assistant'; content: string }

export class TrainedChatPanel {
  private container: HTMLDivElement
  private toggle: HTMLButtonElement
  private panel: HTMLDivElement
  private list: HTMLDivElement
  private log: HTMLDivElement
  private input: HTMLTextAreaElement
  private send: HTMLButtonElement
  private status: HTMLDivElement
  private notice: HTMLDivElement
  private adapters: TrainedAdapterView[] = []
  private limits: ChatLimits = { maxMessageChars: 500, maxTurns: 8 }
  private chosen: string | null = null
  private turns: Turn[] = []
  private busy = false
  private isOpen = false
  /** What the room's state last said about the chat being switched on. */
  private available = false
  private refreshTimer: number | null = null

  constructor() {
    this.container = document.createElement('div')
    this.container.id = 'trained-chat-container'
    this.container.style.display = 'none' // shown only once the server says the chat is on
    const style = document.createElement('style')
    style.textContent = `
      #trained-chat-container { position: fixed; bottom: 188px; right: 20px; z-index: 150; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
      #trained-chat-toggle { width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); border: 1px solid rgba(0,0,0,0.1); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 12px rgba(0,0,0,0.1); transition: transform 0.2s ease, box-shadow 0.2s ease; color: #3a3226; padding: 0; }
      #trained-chat-toggle:hover { transform: scale(1.05); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
      #trained-chat-toggle:focus-visible, #trained-chat-panel button:focus-visible, #trained-chat-panel textarea:focus-visible { outline: 2px solid #B5A642; outline-offset: 2px; }
      #trained-chat-toggle svg { width: 20px; height: 20px; opacity: 0.6; }
      #trained-chat-panel { position: fixed; right: 20px; bottom: 76px; width: min(400px, calc(100vw - 40px)); max-height: min(78vh, calc(100dvh - 96px)); background: rgba(24,22,19,0.95); backdrop-filter: blur(16px); border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); border: 1px solid rgba(181,166,66,0.25); display: none; flex-direction: column; overflow: hidden; z-index: 1090; color: rgba(245,242,235,0.88); font-size: 12px; line-height: 1.45; }
      #trained-chat-panel.open { display: flex; }
      #trained-chat-panel .tc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 6px 6px 14px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      #trained-chat-panel .tc-title { color: #f5f2eb; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; }
      #trained-chat-panel .tc-close { width: 44px; height: 44px; background: none; border: 0; color: rgba(245,242,235,0.7); font-size: 20px; cursor: pointer; border-radius: 10px; }
      #trained-chat-panel .tc-body { overflow-y: auto; padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 10px; }
      #trained-chat-panel .tc-notice { padding: 8px 10px; border-radius: 8px; background: rgba(181,166,66,0.12); border: 1px solid rgba(181,166,66,0.3); color: #e8dfb0; font-size: 12px; }
      #trained-chat-panel .tc-adapter { display: block; width: 100%; min-height: 44px; text-align: left; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: inherit; cursor: pointer; font: inherit; }
      #trained-chat-panel .tc-adapter[aria-pressed="true"] { border-color: #B5A642; background: rgba(181,166,66,0.14); }
      #trained-chat-panel .tc-adapter b { color: #f5f2eb; font: 12px/1.3 ui-monospace, Menlo, monospace; word-break: break-all; }
      #trained-chat-panel .tc-adapter b.tc-name { font: 600 13px/1.3 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; word-break: break-word; }
      #trained-chat-panel .tc-adapter span { display: block; color: rgba(245,242,235,0.62); font-size: 11px; margin-top: 2px; }
      #trained-chat-panel .tc-adapter span.tc-id { font: 11px/1.3 ui-monospace, Menlo, monospace; word-break: break-all; }
      #trained-chat-panel .tc-adapter i.tc-kept { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px; border: 1px solid rgba(181,166,66,0.6); color: #e8dfb0; font: 600 10px/16px 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; letter-spacing: 0.4px; text-transform: uppercase; vertical-align: 1px; }
      #trained-chat-panel .tc-adapters { display: flex; flex-direction: column; gap: 6px; }
      #trained-chat-panel .tc-empty { color: rgba(245,242,235,0.5); font-style: italic; }
      #trained-chat-panel .tc-log { display: flex; flex-direction: column; gap: 6px; }
      #trained-chat-panel .tc-msg { padding: 7px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; max-width: 92%; }
      #trained-chat-panel .tc-msg.user { align-self: flex-end; background: rgba(139,115,85,0.4); color: #f5f2eb; }
      #trained-chat-panel .tc-msg.assistant { align-self: flex-start; background: rgba(255,255,255,0.07); }
      #trained-chat-panel .tc-status { color: #ffcc80; font-size: 11px; min-height: 16px; }
      #trained-chat-panel .tc-form { display: flex; gap: 8px; align-items: flex-end; padding: 10px 14px 12px; border-top: 1px solid rgba(255,255,255,0.08); }
      #trained-chat-panel textarea { flex: 1; min-height: 44px; max-height: 120px; resize: none; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: #f5f2eb; padding: 10px; font-family: inherit; font-size: 16px; line-height: 1.3; }
      #trained-chat-panel .tc-send, #trained-chat-panel .tc-new { min-width: 44px; min-height: 44px; padding: 0 14px; border-radius: 10px; border: 1px solid rgba(181,166,66,0.5); background: rgba(181,166,66,0.2); color: #f5f2eb; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600; }
      #trained-chat-panel .tc-new { background: none; border-color: rgba(255,255,255,0.15); font-weight: 400; align-self: flex-start; }
      #trained-chat-panel button:disabled { opacity: 0.4; cursor: default; }
      @media (max-width: 760px) {
        #trained-chat-panel { right: 10px; left: 10px; width: auto; bottom: 10px; max-height: calc(100dvh - 20px); }
      }
      @media (prefers-reduced-motion: reduce) { #trained-chat-toggle { transition: none; } }
    `
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

    this.panel = document.createElement('div')
    this.panel.id = 'trained-chat-panel'
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-label', 'Talk to what they trained')
    this.panel.innerHTML = `
      <div class="tc-head"><div class="tc-title">Talk to what they trained</div><button type="button" class="tc-close" aria-label="Close">&times;</button></div>
      <div class="tc-body">
        <div class="tc-notice"></div>
        <div class="tc-adapters"></div>
        <div class="tc-log" aria-live="polite"></div>
        <button type="button" class="tc-new">New conversation</button>
        <div class="tc-status" role="status"></div>
      </div>
      <form class="tc-form">
        <textarea rows="1" aria-label="Your message" placeholder="Write a message"></textarea>
        <button type="submit" class="tc-send">Send</button>
      </form>`
    this.container.appendChild(this.panel)
    this.notice = this.panel.querySelector('.tc-notice') as HTMLDivElement
    this.list = this.panel.querySelector('.tc-adapters') as HTMLDivElement
    this.log = this.panel.querySelector('.tc-log') as HTMLDivElement
    this.status = this.panel.querySelector('.tc-status') as HTMLDivElement
    this.input = this.panel.querySelector('textarea') as HTMLTextAreaElement
    this.send = this.panel.querySelector('.tc-send') as HTMLButtonElement
    this.notice.textContent = 'A small model fine-tuned by the lab\'s AI models on data they wrote. Replies are not reviewed.'
    ;(this.panel.querySelector('.tc-close') as HTMLButtonElement).addEventListener('click', () => this.close())
    ;(this.panel.querySelector('.tc-new') as HTMLButtonElement).addEventListener('click', () => this.reset())
    ;(this.panel.querySelector('form') as HTMLFormElement).addEventListener('submit', e => {
      e.preventDefault()
      void this.submit()
    })
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void this.submit()
      }
      if (e.key === 'Escape') this.close()
    })
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
      this.close()
      this.container.style.display = 'none'
    }
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  private open(): void {
    this.isOpen = true
    this.panel.classList.add('open')
    this.toggle.setAttribute('aria-expanded', 'true')
    void this.load()
    this.input.focus()
  }

  private close(): void {
    this.isOpen = false
    this.panel.classList.remove('open')
    this.toggle.setAttribute('aria-expanded', 'false')
  }

  private reset(): void {
    this.turns = []
    this.log.replaceChildren()
    this.status.textContent = ''
    this.refreshForm()
  }

  /** Reads what can be talked to. With the chat off, or no backend, the button stays hidden. */
  private async load(): Promise<void> {
    if (!this.available) return
    try {
      const res = await fetch(API, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json() as { enabled?: unknown; notice?: unknown }
      if (data.enabled !== true) {
        // The route itself says the chat is off: stop asking. It is asked
        // again only after the room's state has said off and then on again.
        this.stopRefresh()
        this.close()
        this.container.style.display = 'none'
        return
      }
      this.container.style.display = ''
      this.adapters = parseAdapters(data)
      this.limits = parseLimits(data)
      const notice = text(data.notice, 300)
      if (notice) this.notice.textContent = notice
      if (this.chosen && !this.adapters.some(a => a.slug === this.chosen)) {
        this.chosen = null
        this.reset()
      }
      if (!this.chosen && this.adapters.length) this.chosen = this.adapters[0].slug
      this.renderAdapters()
      this.refreshForm()
    } catch {
      if (!this.isOpen) this.container.style.display = 'none'
    }
  }

  private renderAdapters(): void {
    this.list.replaceChildren()
    if (!this.adapters.length) {
      const empty = document.createElement('div')
      empty.className = 'tc-empty'
      empty.textContent = 'Nothing has been trained yet, or what was trained has expired. When a model trains one, it appears here.'
      this.list.appendChild(empty)
      return
    }
    for (const a of this.adapters) {
      const d = describeAdapter(a)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tc-adapter'
      button.setAttribute('aria-pressed', String(a.slug === this.chosen))
      const title = document.createElement('b')
      title.textContent = d.title
      if (d.id) title.className = 'tc-name'
      button.appendChild(title)
      if (d.mark) {
        const mark = document.createElement('i')
        mark.className = 'tc-kept'
        mark.textContent = d.mark
        button.appendChild(mark)
      }
      if (d.id) {
        const id = document.createElement('span')
        id.className = 'tc-id'
        id.textContent = d.id
        button.appendChild(id)
      }
      for (const line of [a.purpose, d.origin, d.score, d.kept]) {
        if (!line) continue
        const span = document.createElement('span')
        span.textContent = line
        button.appendChild(span)
      }
      button.addEventListener('click', () => {
        if (this.chosen === a.slug) return
        this.chosen = a.slug
        this.reset()
        this.renderAdapters()
      })
      this.list.appendChild(button)
    }
  }

  /** Says something under the conversation and keeps it in view. */
  private note(message: string): void {
    this.status.textContent = message
    if (message) this.status.scrollIntoView({ block: 'nearest' })
  }

  private turnsUsed(): number {
    return this.turns.filter(t => t.role === 'user').length
  }

  private refreshForm(): void {
    const full = this.turnsUsed() >= this.limits.maxTurns
    this.input.maxLength = this.limits.maxMessageChars
    this.input.disabled = this.busy || !this.chosen || full
    this.send.disabled = this.busy || !this.chosen || full
    if (full && !this.status.textContent) this.note(`This conversation has reached its ${this.limits.maxTurns} turns. Start a new one to keep going.`)
  }

  private addMessage(turn: Turn): void {
    const el = document.createElement('div')
    el.className = `tc-msg ${turn.role}`
    el.textContent = turn.content
    this.log.appendChild(el)
    el.scrollIntoView({ block: 'nearest' })
  }

  private async submit(): Promise<void> {
    const message = this.input.value.trim()
    if (!message || this.busy || !this.chosen || this.turnsUsed() >= this.limits.maxTurns) return
    const adapter = this.chosen
    const history = [...this.turns, { role: 'user' as const, content: message.slice(0, this.limits.maxMessageChars) }]
    this.busy = true
    this.addMessage(history[history.length - 1])
    this.note('Waiting for the model')
    this.input.value = ''
    this.refreshForm()
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ adapter, messages: history }),
      })
      const data = await res.json().catch(() => ({})) as { reply?: unknown; message?: unknown; cut_short?: unknown }
      const reply = text(data.reply, 1200)
      if (!res.ok || !reply) {
        // The visitor's message stays on screen but is not kept in the conversation, so it can be sent again.
        this.log.lastElementChild?.remove()
        this.input.value = message
        this.note(text(data.message, 300) ?? 'The chat is not available just now. Please try again later.')
        return
      }
      this.turns = [...history, { role: 'assistant', content: reply }]
      this.addMessage({ role: 'assistant', content: reply })
      this.note(data.cut_short === true ? 'The reply was cut at its length limit.' : '')
    } catch {
      this.log.lastElementChild?.remove()
      this.input.value = message
      this.note('The chat is not available just now. Please try again later.')
    } finally {
      this.busy = false
      this.refreshForm()
      if (this.isOpen && !this.input.disabled) this.input.focus()
    }
  }
}
