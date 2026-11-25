// A short story from the research loop's best kept model: one section of the
// "Talk to what they trained" panel (docs/TOOLS.md, "The research model talks").
//
// It asks for nothing until the room's own state (GET /api/experiment, which
// the page reads anyway) says stories are switched on: main.ts passes that on
// through the panel. With stories off, which is the default, this section
// makes no request and shows nothing. Once on, it reads
// GET /api/experiment/research-talk for the model that can be asked, when it
// is switched on and each time the panel is opened. A line goes to
// POST /api/experiment/research-talk, which holds the limits (one line, a
// fixed length of story, a rate limit per visitor and a number of stories a
// day) and answers with a plain sentence when one is reached.
//
// The numbers shown come from the lab's record of the run that trained the
// model. Its score was printed by the model-written training code itself, so
// the heading says "self-reported".
//
// All text from the server and from the model is put on the page as text,
// never as markup.

const API = '/api/experiment/research-talk'

export interface StoryModelView {
  /** "epoch" for a run the loop kept, "owner_rerun" for one the owner trained by hand. */
  source: 'epoch' | 'owner_rerun'
  epoch: number | null
  valBpb: number | null
  paramsM: number | null
  budgetS: number | null
}

export interface StoryInfo {
  model: StoryModelView | null
  /** The loop's best is from this later epoch, and its model could not be saved or loaded. */
  bestEpoch: number | null
  /** The newest kept model, when it is not the one that talks. */
  newest: { epoch: number | null; checked: boolean } | null
  maxPromptChars: number
  defaultPrompt: string
  notice: string | null
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max) : t
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const wholeEpoch = (v: unknown) => {
  const n = num(v)
  return n !== null && Number.isInteger(n) && n >= 0 && n < 1e6 ? n : null
}

/** A GET answer, strictly read: anything that is not what the server sends is left out. */
export function parseStoryInfo(raw: unknown): StoryInfo {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const m = o.model && typeof o.model === 'object' ? o.model as Record<string, unknown> : null
  const limits = o.limits && typeof o.limits === 'object' ? o.limits as Record<string, unknown> : null
  const newest = o.newest && typeof o.newest === 'object' ? o.newest as Record<string, unknown> : null
  const chars = num(limits?.max_prompt_chars)
  const bpb = num(m?.val_bpb)
  const params = num(m?.params_m)
  const budget = num(m?.budget_s)
  return {
    model: m && (m.source === 'epoch' || m.source === 'owner_rerun') ? {
      source: m.source,
      epoch: m.source === 'epoch' ? wholeEpoch(m.epoch) : null,
      valBpb: bpb !== null && bpb >= 0 && bpb < 100 ? bpb : null,
      paramsM: params !== null && params > 0 && params < 1e5 ? params : null,
      budgetS: budget !== null && budget > 0 && budget <= 3600 ? budget : null,
    } : null,
    bestEpoch: wholeEpoch(o.best_epoch),
    newest: newest ? { epoch: wholeEpoch(newest.epoch), checked: newest.checked === true } : null,
    maxPromptChars: chars !== null && chars >= 1 && chars <= 1000 ? Math.floor(chars) : 200,
    defaultPrompt: text(o.default_prompt, 80) ?? 'Once upon a time',
    notice: text(o.notice, 300),
  }
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 1) return `${Math.round(seconds)} seconds`
  const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  return `${words[m] ?? m} ${m === 1 ? 'minute' : 'minutes'}`
}

/**
 * The lines shown above the story box: which model this is and where its
 * score came from, what kind of model it is, and a note when the loop's
 * current best is not the model that talks.
 */
export function describeStoryModel(info: StoryInfo): { title: string; about: string; note: string } {
  const m = info.model
  if (!m) {
    return {
      title: 'The research loop\'s best story model',
      about: info.newest && !info.newest.checked
        ? 'A model has just been saved and the lab is trying it out. It can be asked for a story in a minute or two.'
        : info.newest
          ? 'The lab saved a model but could not load it again to write, so there is nothing to ask yet. The next run the research loop keeps as its best will be saved too.'
          : 'No story model has been saved yet. The next run the research loop keeps as its best will be saved.',
      note: '',
    }
  }
  const score = m.valBpb !== null ? `val_bpb ${m.valBpb.toFixed(4)}, self-reported` : 'no score recorded'
  // "Best" only while it is: once the loop has kept a later run, this one is not.
  const surpassed = info.bestEpoch !== null && m.epoch !== null && info.bestEpoch > m.epoch
  const title = m.source === 'epoch' && m.epoch !== null
    ? `The research loop's ${surpassed ? '' : 'best '}story model (epoch ${m.epoch}, ${score})`
    : `The research loop's training code, run once more by the owner (${score})`
  const size = m.paramsM !== null ? ` It has about ${m.paramsM < 10 ? m.paramsM.toFixed(1) : Math.round(m.paramsM)} million parameters and reads and writes one byte at a time.` : ''
  const about = `A tiny model trained from scratch on children's stories in ${m.budgetS !== null ? minutes(m.budgetS) : 'a few minutes'}. It only writes story-like text.${size}`
  let note = ''
  // The newest kept model has not had the lab's own sample yet. When it is
  // the loop's new best, that is why an older model still answers: it has
  // not failed, it is being tried.
  const trying = info.newest !== null && !info.newest.checked
  if (surpassed && trying && info.newest?.epoch === info.bestEpoch) {
    note = `The loop has since kept a better run (epoch ${info.bestEpoch}). Its model has just been saved and the lab is trying it out, so for a minute or two this one still answers.`
  } else if (surpassed) {
    note = `The loop has since kept a better run (epoch ${info.bestEpoch}). The lab has not been able to save that model and load it again, so this is the last one it could.`
  } else if (info.newest && !info.newest.checked) {
    note = 'A newer model has just been saved and the lab is trying it out.'
  }
  return { title, about, note }
}

export class ResearchStoryBox {
  /** The section itself. The panel puts it in its body. */
  readonly element: HTMLDivElement
  private title: HTMLDivElement
  private about: HTMLDivElement
  private noticeEl: HTMLDivElement
  private noteEl: HTMLDivElement
  private form: HTMLFormElement
  private input: HTMLInputElement
  private button: HTMLButtonElement
  private story: HTMLDivElement
  private status: HTMLDivElement
  private info: StoryInfo = parseStoryInfo(null)
  private busy = false
  /** What the room's state last said about stories being switched on. */
  private available = false
  /** True once the route itself has said stories are on. */
  private shown = false
  /** True once the route itself has said stories are off: it is not asked again until the state changes. */
  private refused = false

  /** `onChange` is called whenever the section starts or stops being shown. */
  constructor(private onChange: () => void = () => {}) {
    this.element = document.createElement('div')
    this.element.className = 'tc-story'
    this.element.style.display = 'none'
    this.element.innerHTML = `
      <div class="tc-story-title"></div>
      <div class="tc-story-about"></div>
      <div class="tc-notice tc-story-notice"></div>
      <div class="tc-story-note"></div>
      <form class="tc-story-form">
        <input type="text" class="tc-story-input" aria-label="An opening line for the story" autocomplete="off">
        <button type="submit" class="tc-send tc-story-send">Write</button>
      </form>
      <div class="tc-story-text" aria-live="polite"></div>
      <div class="tc-status tc-story-status" role="status"></div>`
    this.title = this.element.querySelector('.tc-story-title') as HTMLDivElement
    this.about = this.element.querySelector('.tc-story-about') as HTMLDivElement
    this.noticeEl = this.element.querySelector('.tc-story-notice') as HTMLDivElement
    this.noteEl = this.element.querySelector('.tc-story-note') as HTMLDivElement
    this.form = this.element.querySelector('form') as HTMLFormElement
    this.input = this.element.querySelector('input') as HTMLInputElement
    this.button = this.element.querySelector('button') as HTMLButtonElement
    this.story = this.element.querySelector('.tc-story-text') as HTMLDivElement
    this.status = this.element.querySelector('.tc-story-status') as HTMLDivElement
    this.story.style.display = 'none'
    this.form.addEventListener('submit', e => {
      e.preventDefault()
      void this.submit()
    })
  }

  /** Is the section on the page? The panel shows its button while this or the chat is. */
  isShown(): boolean {
    return this.shown
  }

  /**
   * Told what the room's state says: are stories switched on? Only a change
   * does anything. Until this is called with true, the section never calls
   * its route.
   */
  setAvailable(on: boolean): void {
    if (on === this.available) return
    this.available = on
    this.refused = false
    if (on) void this.load()
    else this.hide()
  }

  /** Reads the model again. The panel calls this when it is opened. */
  refresh(): void {
    if (this.available && !this.refused && !this.busy) void this.load()
  }

  private hide(): void {
    if (!this.shown && this.element.style.display === 'none') return
    this.shown = false
    this.element.style.display = 'none'
    this.onChange()
  }

  private async load(): Promise<void> {
    if (!this.available) return
    try {
      const res = await fetch(API, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json() as { enabled?: unknown }
      // The room may have said "off" while the request was out: do not show the box again.
      if (!this.available) return
      if (data.enabled !== true) {
        // The route itself says stories are off: stop asking. It is asked
        // again only after the room's state has said off and then on again.
        this.refused = true
        this.hide()
        return
      }
      this.info = parseStoryInfo(data)
      this.render()
      if (!this.shown) {
        this.shown = true
        this.element.style.display = ''
        this.onChange()
      }
    } catch {
      // Left as it was: shown with what was last read, or not shown at all.
    }
  }

  private render(): void {
    const d = describeStoryModel(this.info)
    this.title.textContent = d.title
    this.about.textContent = d.about
    this.noticeEl.textContent = this.info.notice ?? 'Nobody reviews what it writes.'
    this.noticeEl.style.display = this.info.model ? '' : 'none'
    this.noteEl.textContent = d.note
    this.noteEl.style.display = d.note ? '' : 'none'
    this.form.style.display = this.info.model ? '' : 'none'
    if (!this.info.model) {
      // Nothing to ask any more: an earlier story and its status go with the box.
      this.story.textContent = ''
      this.story.style.display = 'none'
      this.status.textContent = ''
    }
    this.input.maxLength = this.info.maxPromptChars
    this.input.placeholder = this.info.defaultPrompt
    this.refreshForm()
  }

  private refreshForm(): void {
    this.input.disabled = this.busy
    this.button.disabled = this.busy || !this.info.model
  }

  private async submit(): Promise<void> {
    if (this.busy || !this.info.model) return
    const prompt = this.input.value.replace(/\s+/g, ' ').trim().slice(0, this.info.maxPromptChars)
    this.busy = true
    this.status.textContent = 'The model is being loaded to write. This can take up to a minute.'
    this.refreshForm()
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json().catch(() => ({})) as { story?: unknown; message?: unknown; stopped?: unknown; continuation?: unknown }
      const story = text(data.story, 1200)
      if (!res.ok || !story) {
        this.status.textContent = text(data.message, 300) ?? 'Stories are not available just now. Please try again later.'
        return
      }
      this.story.textContent = story
      this.story.style.display = ''
      this.status.textContent = data.continuation === '' ? 'The model added nothing this time. Try again, or try another line.'
        : data.stopped === 'end' ? '' : data.stopped === 'time'
          ? 'The model ran out of time before it finished.'
          : 'The story was cut at its length limit.'
    } catch {
      this.status.textContent = 'Stories are not available just now. Please try again later.'
    } finally {
      this.busy = false
      this.refreshForm()
    }
  }
}
