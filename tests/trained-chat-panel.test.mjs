// The "Talk to what they trained" panel (src/systems/TrainedChatPanel.ts):
// its pure helpers (gauge, accent, request body, reply reading), its colours
// measured against WCAG, its states drawn into a small fake page, and the
// source rules that keep it safe. No browser, no network.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-chat-panel-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')
for (const path of ['src/systems/TrainedChatPanel.ts', 'src/systems/chatOffer.ts', 'src/systems/ResearchStoryBox.ts', 'src/systems/paperTheme.ts']) {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from '([^']+)'/g, (whole, specifier) => specifier.startsWith('.') ? `from '${specifier}.js'` : whole)
  mkdirSync(dirname(join(build, path)), { recursive: true })
  writeFileSync(join(build, path.replace(/\.ts$/, '.js')), output)
}
after(() => rmSync(build, { recursive: true, force: true }))
const load = path => import(pathToFileURL(join(build, path)).href)
const panel = await load('src/systems/TrainedChatPanel.js')
const offer = await load('src/systems/chatOffer.js')
const storyBox = await load('src/systems/ResearchStoryBox.js')
const theme = await load('src/systems/paperTheme.js')
const source = readFileSync(join(root, 'src/systems/TrainedChatPanel.ts'), 'utf8')
const offerSource = readFileSync(join(root, 'src/systems/chatOffer.ts'), 'utf8')

const BASE = 'Qwen/Qwen3.5-4B'
const sft = (over = {}) => ({ slug: 'e41-0a1b2c3d', base_model: BASE, epoch: 41, author_name: 'Claude Fable 5.2', purpose: 'a tiny test run', examples: 20, holdout_examples: 2, holdout_loss_before: 2.9531, holdout_loss_after: 1.1042, expires_at: '2026-12-02T10:00:00.000Z', ...over })
const rl = (over = {}) => sft({ slug: 'e42-0a1b2c3d', kind: 'rl', rl_score_before: 0.25, rl_score_after: 0.75, author_name: 'Grok 4.7', holdout_loss_before: undefined, holdout_loss_after: undefined, ...over })
const view = raw => panel.parseAdapters({ adapters: [raw] })[0]

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test('the gauge is drawn only from two measured numbers, and says which way is better', () => {
  const g = panel.gaugeView(view(sft()))
  assert.deepEqual([g.kind, g.caption], ['sft', 'Lower Is Better'])
  assert.deepEqual(g.rows.map(r => [r.label, r.text]), [['Before', '2.95'], ['After', '1.10']])
  // proportional to the larger of the two: no invented maximum
  assert.equal(g.rows[0].pct, 100)
  assert.ok(Math.abs(g.rows[1].pct - (1.1042 / 2.9531) * 100) < 1e-9)
  assert.equal(g.aria, 'Held-out loss 2.95 before training, 1.10 after. Lower is better. Measured by the lab.')
  // a loss that went up: the longer bar is the "after" one
  const worse = panel.gaugeView(view(sft({ holdout_loss_before: 1, holdout_loss_after: 2 })))
  assert.deepEqual(worse.rows.map(r => r.pct), [50, 100])

  const r = panel.gaugeView(view(rl()))
  assert.deepEqual([r.kind, r.caption], ['rl', 'Higher Is Better'])
  assert.deepEqual(r.rows.map(x => x.pct), [25, 75]) // the real 0 to 1 scale
  assert.equal(r.aria, 'Held-out rubric score 0.25 before training, 0.75 after. Higher is better. Measured by the lab.')

  for (const odd of [sft({ holdout_loss_before: null }), sft({ holdout_loss_after: undefined }), rl({ rl_score_before: null }), rl({ rl_score_after: 'x' })]) {
    const none = panel.gaugeView(view(odd))
    assert.deepEqual([none.kind, none.none, none.rows], ['none', 'No held-out score recorded.', []])
  }
  assert.equal(panel.gaugeView(view(sft({ holdout_loss_before: 0, holdout_loss_after: 0 }))).rows[0].pct, 0)
})

test('the maker mark follows the name: five providers, fallback models by their own name, everyone else neutral', () => {
  assert.equal(panel.accentFor('Gemini 4'), '#4285F4')
  assert.equal(panel.accentFor('DeepSeek V4 Pro'), '#10A37F')
  assert.equal(panel.accentFor('Claude Fable 5.2'), '#D97706')
  assert.equal(panel.accentFor('Claude Sonnet 5.5'), '#D97706')
  assert.equal(panel.accentFor('GPT-6 Astra'), '#412991')
  assert.equal(panel.accentFor('Grok 4.7'), '#1DA1F2')
  for (const other of ['North', 'GLM 5.3', 'a lab model', '', null, undefined]) assert.equal(panel.accentFor(other), panel.ACCENT_NEUTRAL, String(other))
  assert.equal(theme.PAPER_TOKENS['--paper-line'], panel.ACCENT_NEUTRAL)
  assert.match(theme.paperRootCss(), new RegExp(`--paper-line: ${panel.ACCENT_NEUTRAL};`))
})

test('card tags, counters and the shelf signature', () => {
  assert.equal(panel.kindLabel(view(sft())), 'Fine-Tuned')
  assert.equal(panel.kindLabel(view(rl())), 'Practice by Reward')
  assert.equal(panel.kindLabel('story'), 'Story Model')
  assert.equal(panel.turnCounterText(0, 8), 'Question 1 of 8')
  assert.equal(panel.turnCounterText(2, 8), 'Question 3 of 8')
  assert.equal(panel.turnCounterText(8, 8), '8 of 8 used')
  assert.equal(panel.counterVisible(399, 500), false)
  assert.equal(panel.counterVisible(400, 500), true)
  assert.equal(panel.counterVisible(500, 500), true)
  const parts = { adapters: [view(sft())], story: false, chat: true, state: 'ok', compare: true, limits: { maxMessageChars: 500, maxTurns: 8 }, notice: 'x' }
  assert.equal(panel.shelfSignature(parts), panel.shelfSignature({ ...parts, adapters: [view(sft())] }))
  assert.notEqual(panel.shelfSignature(parts), panel.shelfSignature({ ...parts, story: true }))
  assert.notEqual(panel.shelfSignature(parts), panel.shelfSignature({ ...parts, adapters: [view(sft({ name: 'Rootkeeper' }))] }))
  assert.equal(panel.trainedAgoText('2026-11-20T00:00:00Z', Date.parse('2026-11-23T12:00:00Z')), 'Trained 3 days ago.')
  assert.equal(panel.trainedAgoText(undefined, 0), null)
})

test('the list answer is read strictly, including the compare switch and a failed read', () => {
  const list = panel.parseListResponse({ enabled: true, compare_enabled: true, adapters: [sft()], notice: 'Hello.' })
  assert.deepEqual([list.enabled, list.compareEnabled, list.unavailable, list.adapters.length, list.notice], [true, true, false, 1, 'Hello.'])
  for (const odd of ['true', 1, null, undefined, {}]) assert.equal(panel.parseListResponse({ enabled: true, compare_enabled: odd }).compareEnabled, false, String(odd))
  assert.equal(panel.parseListResponse({ enabled: true, adapters: [], unavailable: true }).unavailable, true)
  assert.equal(panel.parseListResponse({ enabled: true, unavailable: 'yes' }).unavailable, false)
  assert.equal(panel.parseListResponse(null).enabled, false)
  assert.equal(panel.parseListResponse({ enabled: false, adapters: [] }).enabled, false)
})

test('the request is the old one when compare is off, and carries the untrained replies when it is on', () => {
  const history = [{ role: 'user', content: 'Hi  there' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Why?' }]
  assert.deepEqual(panel.buildChatBody('e41-0a1b2c3d', history, null), { adapter: 'e41-0a1b2c3d', messages: history })
  assert.equal(JSON.stringify(panel.buildChatBody('e41-0a1b2c3d', history, null)), JSON.stringify({ adapter: 'e41-0a1b2c3d', messages: history }))
  const both = panel.buildChatBody('e41-0a1b2c3d', history, ['Hello there'])
  assert.deepEqual(both, { adapter: 'e41-0a1b2c3d', messages: history, compare: true, base_replies: ['Hello there'] })
  assert.equal(both.base_replies.length, history.filter(t => t.role === 'assistant').length)
  assert.equal(both.messages[0].content, 'Hi  there') // visitor text is never altered
  assert.deepEqual(panel.buildChatBody('e41-0a1b2c3d', [history[0]], []).base_replies, [])
})

test('replies are read strictly: one answer, a pair, half a pair, errors and junk', () => {
  assert.deepEqual(panel.readReply(true, { reply: ' Hi. ', cut_short: true, turns_left: 6 }, false), { kind: 'single', reply: 'Hi.', cutShort: true, turnsLeft: 6 })
  assert.deepEqual(panel.readReply(true, { reply: 'Hi.', turns_left: 'many' }, false), { kind: 'single', reply: 'Hi.', cutShort: false, turnsLeft: null })
  const pair = panel.readReply(true, { compare: true, base_model: BASE, trained: { ok: true, reply: 'A', cut_short: false }, untrained: { ok: true, reply: 'B', cut_short: true }, turns_left: 5 }, true)
  assert.deepEqual(pair, { kind: 'pair', trained: { ok: true, reply: 'A', cutShort: false }, untrained: { ok: true, reply: 'B', cutShort: true }, baseModel: BASE, turnsLeft: 5, commit: true })
  const half = panel.readReply(true, { compare: true, base_model: BASE, trained: { ok: true, reply: 'A' }, untrained: { ok: false, error: 'busy', message: 'Try later.' }, turns_left: 5 }, true)
  assert.equal(half.kind, 'pair')
  assert.equal(half.commit, false)
  assert.deepEqual(half.untrained, { ok: false, message: 'Try later.' })
  // both failed, an HTTP error, a missing or wrong shape
  assert.deepEqual(panel.readReply(true, { compare: true, trained: { ok: false }, untrained: { ok: false } }, true), { kind: 'error', message: null })
  assert.deepEqual(panel.readReply(false, { error: 'rate', message: 'Slow down.' }, false), { kind: 'error', message: 'Slow down.' })
  assert.deepEqual(panel.readReply(false, { message: 'Slow down.' }, true), { kind: 'error', message: 'Slow down.' })
  for (const junk of [null, undefined, 'text', 7, [], {}, { reply: 7 }, { reply: '   ' }]) {
    assert.equal(panel.readReply(true, junk, false).kind, 'error', JSON.stringify(junk))
    assert.equal(panel.readReply(true, junk, true).kind, 'error', JSON.stringify(junk))
  }
  // a plain reply is not accepted as a compare answer
  assert.equal(panel.readReply(true, { reply: 'Hi.' }, true).kind, 'error')
})

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
const token = name => {
  const role = { ink2: 'ink-2', 'wood-edge': 'line', model: 'white' }[name] ?? name
  const m = new RegExp(`--paper-${role}: (#[0-9A-Fa-f]{6});`).exec(theme.paperRootCss())
  assert.ok(m, `token ${name}`)
  return m[1]
}

test('every text pair is at least 4.5 to 1 and every control edge at least 3 to 1, from the stylesheet tokens', () => {
  const t = Object.fromEntries(['surface', 'raised', 'sunk', 'ink', 'ink2', 'brass', 'brass-edge', 'brass-ink', 'wood-edge', 'visitor', 'model', 'danger', 'danger-bg', 'focus'].map(n => [n, token(n)]))
  const text = [
    ['ink', 'surface'], ['ink', 'raised'], ['ink', 'model'], ['ink', 'visitor'], ['ink', 'sunk'], ['ink2', 'surface'], ['ink2', 'raised'],
    ['ink2', 'visitor'], ['ink2', 'sunk'], ['ink', 'brass'], ['brass-ink', 'surface'], ['brass-ink', 'raised'], ['danger', 'surface'],
    ['danger', 'raised'], ['danger', 'danger-bg'], ['ink', 'danger-bg'],
  ]
  for (const [fg, bg] of text) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`)
  const nonText = [['wood-edge', 'surface'], ['wood-edge', 'sunk'], ['brass-edge', 'surface'], ['brass-edge', 'raised'], ['focus', 'surface'], ['focus', 'sunk'], ['brass-edge', 'sunk'], ['ink', 'raised']]
  for (const [fg, bg] of nonText) assert.ok(ratio(t[fg], t[bg]) >= 3, `${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`)
  // the swatch's ink border keeps every maker's shape visible whatever its fill
  for (const name of ['Gemini 4', 'DeepSeek V4 Pro', 'Claude Fable 5.2', 'GPT-6 Astra', 'Grok 4.7']) assert.ok(ratio(t.ink, t.raised) >= 3, name)
  // the toggle's ink on its paper
  assert.ok(ratio('#2B241B', '#FBF9F4') >= 4.5)
  // the numbers the spec states
  assert.ok(Math.abs(ratio(t.ink, t.surface) - 13.7) < 0.1)
  assert.ok(Math.abs(ratio(t['brass-ink'], t.surface) - 6.05) < 0.1)
  assert.ok(Math.abs(ratio(t['brass-edge'], t.surface) - 3.83) < 0.1)
  // brass is never text: a rule that colours text with the brass fill would fail the paper
  assert.ok(ratio(t.brass, t.surface) < 3)
  assert.equal(/[^-]color: var\(--paper-brass\)/.test(panel.PANEL_CSS), false)
  // the panel takes every colour from the shared theme: no hex or rgba literal of its own
  assert.equal(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(panel.PANEL_CSS), false, 'a colour literal in the panel css')
  assert.equal(/--tc-/.test(panel.PANEL_CSS), false)
})

// ---------------------------------------------------------------------------
// A small fake page
// ---------------------------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.handlers = {}; this.parent = null
    this._text = ''; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.inert = false
    this.classList = {
      add: c => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); s.add(c); this.className = [...s].join(' ') },
      remove: c => { this.className = this.className.split(/\s+/).filter(x => x && x !== c).join(' ') },
    }
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join('') }
  set textContent(v) { this._text = String(v); this.children = [] }
  set innerHTML(v) { this._text = ''; this.children = [] }
  appendChild(c) { c.parent = this; this.children.push(c); return c }
  append(...cs) { for (const c of cs) this.appendChild(c) }
  replaceChildren(...cs) { this.children = []; this._text = ''; for (const c of cs) this.appendChild(c) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn) }
  removeEventListener() {}
  focus() { globalThis.document.activeElement = this }
  contains(n) { return n === this || this.children.some(c => c.contains(n)) }
  matches(sel) {
    return sel.split(',').some(part => part.trim().split(/(?=[.[])/).every(p => {
      if (p.startsWith('.')) return this.className.split(/\s+/).includes(p.slice(1))
      if (p.startsWith('[')) return this.attrs[p.slice(1, p.indexOf(']'))] !== undefined
      return p === '' || this.tagName === p.toUpperCase()
    }))
  }
  all(sel, out = []) { for (const c of this.children) { if (c.matches(sel)) out.push(c); c.all(sel, out) } return out }
  querySelectorAll(sel) { return this.all(sel) }
  querySelector(sel) { return this.all(sel)[0] ?? null }
  getClientRects() { return [1] }
  fire(type, event = {}) { for (const fn of this.handlers[type] ?? []) fn({ preventDefault() {}, target: this, ...event }) }
}

async function withPage(run, { list, compare = false } = {}) {
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch }
  const body = new El('body')
  const keys = []
  globalThis.document = {
    createElement: t => new El(t), body, activeElement: null,
    addEventListener(type, fn) { if (type === 'keydown') keys.push(fn) },
    removeEventListener(type, fn) { const i = keys.indexOf(fn); if (i >= 0) keys.splice(i, 1) },
  }
  const timers = []
  globalThis.window = { setInterval: (fn, ms) => { timers.push(ms); return timers.length }, clearInterval() {}, matchMedia: () => ({ matches: false }) }
  const asked = []
  const state = { list: list ?? { enabled: true, compare_enabled: compare, adapters: [sft({ name: 'Rootkeeper' }), rl()], limits: { max_message_chars: 500, max_turns: 8 }, notice: 'A notice.' }, post: null, story: { enabled: true, model: { source: 'epoch', epoch: 3, val_bpb: 0.7, budget_s: 300 }, limits: { max_prompt_chars: 100 } } }
  globalThis.fetch = async (url, options = {}) => {
    asked.push({ method: options.method ?? 'GET', url: String(url), body: options.body ? JSON.parse(options.body) : null })
    const answer = options.method === 'POST' ? state.post(JSON.parse(options.body)) : String(url).endsWith('research-talk') ? state.story : state.list
    return new Response(JSON.stringify(answer.body ?? answer), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  const settle = () => new Promise(r => setTimeout(r, 10))
  const press = (key, target = globalThis.document.activeElement ?? body, extra = {}) => { for (const fn of [...keys]) fn({ key, target, preventDefault() {}, ...extra }) }
  try { return await run({ body, asked, state, timers, settle, press }) } finally {
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.fetch = saved.fetch
  }
}
const click = e => e.fire('click')
const texts = (root, sel) => root.all(sel).map(e => e.textContent)

test('the panel is built as before, but its sheet sits on the page, not in the button\'s container', async () => {
  await withPage(async ({ body, asked, timers, settle }) => {
    const created = []
    const make = globalThis.document.createElement
    globalThis.document.createElement = t => { const e = make(t); created.push(e); return e }
    const p = new panel.TrainedChatPanel()
    assert.equal(created[0].id, 'trained-chat-container')
    assert.equal(created[2].id, 'trained-chat-toggle')
    assert.equal(created[3].id, 'trained-chat-panel')
    assert.equal(created[3].parent, body)
    assert.notEqual(created[3].parent, created[0])
    assert.equal(created[2].parent, created[0])
    assert.equal(created[3].attrs.role, 'dialog')
    assert.equal(created[3].attrs['aria-modal'], 'true')
    assert.equal(created[0].style.display, 'none')
    p.setAvailable(false)
    await settle()
    assert.deepEqual([asked.length, timers.length], [0, 0]) // chat off: no request, no timer
    p.setAvailable(true)
    await settle()
    assert.deepEqual(timers, [120_000])
    assert.equal(created[0].style.display, '')
    assert.equal(created[3].style.display, '')
  })
})

test('a shelf of specimen cards: name, maker, kind, gauge, and the honest tube line', async () => {
  await withPage(async ({ body, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const root = body.querySelector('#trained-chat-panel') ?? body.children.find(c => c.id === 'trained-chat-panel')
    const cards = root.all('.tc-card')
    assert.equal(cards.length, 2)
    assert.equal(texts(root, '.tc-card-title')[0], 'Rootkeeper')
    assert.equal(texts(root, '.tc-card-title')[1], 'lab/e42-0a1b2c3d')
    assert.ok(cards[0].textContent.includes('Trained by Claude Fable 5.2'))
    assert.deepEqual(texts(root, '.tc-tag'), ['Fine-Tuned', 'Practice by Reward'])
    assert.equal(cards[0].getAttribute('aria-pressed'), 'true') // the first is chosen, so the conversation is never empty
    assert.equal(cards[1].getAttribute('aria-pressed'), 'false')
    assert.ok(cards[0].textContent.includes('Lower Is Better'))
    assert.ok(cards[1].textContent.includes('Higher Is Better'))
    assert.equal(cards[0].all('.tc-gauge')[0].getAttribute('role'), 'img')
    assert.equal(root.all('.tc-shelf-count')[0].textContent, '2 models')
    const foot = root.all('.tc-shelf-foot')[0].textContent
    assert.ok(foot.includes('A notice.'))
    assert.ok(foot.includes('speaking tube in the room glows for up to two minutes'))
    // who you are talking to is always on screen
    assert.equal(root.all('.tc-who-title')[0].textContent, 'Rootkeeper')
    assert.equal(root.all('.tc-who-sub')[0].textContent, `Trained by Claude Fable 5.2. Base model ${BASE}.`)
    // the details carry the lab's own lines
    assert.ok(root.all('.tc-details')[0].textContent.includes('Measured by the lab.'))
    // no compare switch unless the server offered it
    assert.equal(root.all('.tc-switch')[0].hidden, true)
  })
})

test('nothing on the shelf is an invitation with no inputs, and a failed read is not called empty', async () => {
  await withPage(async ({ body, state, settle }) => {
    state.list = { enabled: true, adapters: [], limits: {}, notice: 'N.' }
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const root = body.children.find(c => c.id === 'trained-chat-panel')
    assert.ok(root.textContent.includes('Nothing Is on the Shelf Right Now'))
    assert.ok(root.textContent.includes('No trained model is on the shelf. The lab\'s models can train small models. When the lab saves one, it appears here.'))
    assert.equal(root.textContent.includes('no one to talk to'), false)
    assert.equal(root.all('.tc-slot').length, 1) // an outline of an empty slot, marked decorative
    assert.match(root.className, /tc-full-sheet/)
    assert.equal(root.all('.tc-card').length, 0)
    assert.equal(root.all('.tc-shelf-head')[0].style.display, 'none')

    state.list = { enabled: true, adapters: [], unavailable: true }
    p.setAvailable(false); p.setAvailable(true)
    await settle()
    assert.ok(root.textContent.includes('The Shelf Could Not Be Read'))
    assert.ok(root.textContent.includes('Try Again'))
    assert.equal(root.textContent.includes('Nothing Is on the Shelf Right Now'), false)
  })
})

test('the story model is a card; choosing it shows the box and hides the chat', async () => {
  await withPage(async ({ body, state, settle }) => {
    state.list = { enabled: true, adapters: [], limits: {} }
    const p = new panel.TrainedChatPanel()
    // the box's own rules are tested in research-talk.test.mjs; here a stand-in with the same shape shows how the panel mounts it
    let shown = false
    p.attachStory(onChange => {
      const element = new El('div')
      element.className = 'tc-story'
      const title = new El('div'); title.className = 'tc-story-title'; title.textContent = 'Story title'
      element.append(title, new El('input'))
      return { element, isShown: () => shown, refresh() {}, setAvailable(on) { shown = on; onChange() } }
    })
    p.setAvailable(true)
    p.setStoryAvailable(true)
    await settle(); await settle()
    const root = body.children.find(c => c.id === 'trained-chat-panel')
    const cards = root.all('.tc-card')
    assert.equal(cards.length, 1)
    assert.ok(cards[0].textContent.includes('Story Model'))
    assert.ok(cards[0].textContent.includes('Continues a line you write.'))
    assert.match(root.className, /tc-story-chosen/) // the only choice, so it is chosen
    assert.equal(/tc-full-sheet/.test(root.className), false) // and the shelf note sits above it, not instead of it
    assert.ok(root.textContent.includes('No Fine-Tuned Models Right Now'))
    assert.equal(root.all('.tc-slot').length, 0)
    assert.ok(cards[0].textContent.includes('Its score is self-reported.'))
    // one input at a time: the story box has its own, the chat's is hidden by its class
    const slot = root.all('.tc-story-slot')[0]
    assert.equal(slot.all('input').length, 1)
    assert.ok(slot.all('.tc-story-title').length === 1)
    assert.equal(root.all('textarea')[0].parent.parent.parent.className.includes('tc-chatonly'), true)
  })
})

test('compare: both answers count as one turn, half a pair is not kept, and the box keeps its text', async () => {
  await withPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    const replies = []
    p.onReply = at => replies.push(at)
    p.setAvailable(true)
    await settle()
    const root = body.children.find(c => c.id === 'trained-chat-panel')
    const box = root.all('textarea')[0]
    const sw = root.all('.tc-switch')[0]
    assert.equal(sw.hidden, true)
    state.list = { ...state.list, compare_enabled: true }
    p.setAvailable(false); p.setAvailable(true)
    await settle()
    assert.equal(sw.hidden, false)
    assert.equal(sw.getAttribute('role'), 'switch')
    assert.equal(sw.getAttribute('aria-checked'), 'false') // off by default
    assert.equal(root.all('.tc-switch-note')[0].textContent, 'Also asks the untrained model. Uses 2 messages.')
    click(sw)
    assert.equal(sw.getAttribute('aria-checked'), 'true')
    assert.equal(root.all('.tc-send')[0].textContent, 'Ask Both')
    const pair = (n, untrained = { ok: true, reply: `base ${n}` }) => ({ adapter: 'e41-0a1b2c3d', compare: true, base_model: BASE, trained: { ok: true, reply: `trained ${n}` }, untrained, turns_left: 8 - n })

    // a half pair: the good answer stays, nothing is kept, the text is back in the box
    state.post = () => pair(1, { ok: false, error: 'busy', message: 'The model did not answer this time.' })
    box.value = 'First question'
    root.all('form')[0].fire('submit')
    await settle()
    let sent = asked.filter(a => a.method === 'POST')
    assert.deepEqual(sent[0].body, { adapter: 'e41-0a1b2c3d', messages: [{ role: 'user', content: 'First question' }], compare: true, base_replies: [] })
    assert.ok(root.textContent.includes('trained 1'))
    assert.ok(root.textContent.includes('The model did not answer this time.')) // the server's own sentence, under the Untrained label
    assert.ok(root.textContent.includes('Only one answer came back. Ask Again asks only the model that did not answer, and uses one more message.'))
    assert.equal(box.value, 'First question')
    assert.equal(root.all('.tc-again')[0].hidden, false)
    assert.equal(sw.getAttribute('aria-disabled'), 'false') // not committed, so it may still be switched
    assert.equal(replies.length, 1) // the trained side really answered

    // asking again with both answering commits one turn
    // the retry asks only the side that failed, and keeps the answer that came back
    state.post = () => ({ adapter: 'e41-0a1b2c3d', compare: true, base_model: BASE, trained: { ok: false, error: 'skipped', message: 'x' }, untrained: { ok: true, reply: 'base 1' }, turns_left: 7 })
    click(root.all('.tc-again')[0])
    await settle()
    sent = asked.filter(a => a.method === 'POST')
    assert.deepEqual(sent[1].body, { adapter: 'e41-0a1b2c3d', messages: [{ role: 'user', content: 'First question' }], compare: true, base_replies: [], only: 'untrained' })
    assert.ok(root.textContent.includes('trained 1') && root.textContent.includes('base 1'))
    assert.equal(root.all('.tc-ex').length, 1) // the half pair was replaced, not stacked
    assert.equal(root.all('.tc-turns')[0].textContent, 'Question 2 of 8')
    assert.equal(sw.getAttribute('aria-disabled'), 'true')
    assert.ok(root.all('.tc-switch-note')[0].textContent.includes('Locked for this conversation. Start a new one to change it.'))
    assert.equal(root.all('.tc-switch-state')[0].textContent, 'On, locked') // the reason is visible text, not only a dimmed knob
    assert.deepEqual(texts(root, '.tc-who-label').filter(t => /^(Trained|Untrained)/.test(t)), ['Trained: Rootkeeper', `Untrained: ${BASE}`])

    // the next question sends each side its own earlier answer
    state.post = () => pair(2)
    box.value = 'Second question'
    root.all('form')[0].fire('submit')
    await settle()
    sent = asked.filter(a => a.method === 'POST')
    assert.deepEqual(sent[2].body.messages.map(m => m.content), ['First question', 'trained 1', 'Second question'])
    assert.deepEqual(sent[2].body.base_replies, ['base 1'])
    assert.equal(replies.length, 2) // the retry asked only the untrained side, so it was no new trained reply
  }, { compare: false })
})

test('a refused message comes back into the box with the reason, and a normal chat sends the old body', async () => {
  await withPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const root = body.children.find(c => c.id === 'trained-chat-panel')
    const box = root.all('textarea')[0]
    state.post = () => ({ status: 429, body: { error: 'rate', message: 'Please wait a few minutes.' } })
    box.value = 'Hello'
    root.all('form')[0].fire('submit')
    await settle()
    const banner = root.all('.tc-banner')[0]
    assert.equal(banner.hidden, false)
    assert.equal(banner.getAttribute('role'), 'alert')
    assert.equal(banner.textContent, 'Your message was not sent. Please wait a few minutes.')
    // a busy answer did reach the model: the banner does not claim it was not sent
    state.post = () => ({ status: 502, body: { error: 'busy', message: 'The model did not answer this time. Please try again in a moment.' } })
    root.all('form')[0].fire('submit')
    await settle()
    assert.equal(banner.textContent, 'The model did not answer this time. Please try again in a moment. Your text is still in the box.')
    assert.equal(banner.textContent.includes('not sent'), false)
    state.post = () => ({ status: 429, body: { error: 'rate', message: 'Please wait a few minutes.' } })
    root.all('form')[0].fire('submit')
    await settle()
    assert.equal(box.value, 'Hello')
    assert.equal(root.all('.tc-ex').length, 0)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', cut_short: false, turns_left: 7 })
    root.all('form')[0].fire('submit')
    await settle()
    assert.deepEqual(asked.filter(a => a.method === 'POST').at(-1).body, { adapter: 'e41-0a1b2c3d', messages: [{ role: 'user', content: 'Hello' }] })
    assert.equal(banner.hidden, true)
    assert.equal(root.all('.tc-turns')[0].textContent, 'Question 2 of 8')
    assert.deepEqual(texts(root, '.tc-who-label').filter(t => t === 'You' || t === 'Rootkeeper'), ['You', 'Rootkeeper']) // every reply carries the model's name
  })
})

test('server and model text is set as text, never as markup', async () => {
  await withPage(async ({ body, state, settle }) => {
    state.list = { enabled: true, adapters: [sft({ name: '<img src=x onerror=1>', purpose: '<b>x</b>' })], limits: {}, notice: '<script>1</script>' }
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const root = body.children.find(c => c.id === 'trained-chat-panel')
    assert.ok(root.textContent.includes('<img src=x onerror=1>'))
    assert.equal(root.all('img').length + root.all('script').length + root.all('b').length, 0)
  })
})

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------
test('the source keeps its pinned rules, its dash rule, and its safety rules', () => {
  assert.match(source, /#trained-chat-panel textarea \{[^}]*font-family: inherit; font-size: 16px; line-height: 1\.3;/)
  assert.match(source, /\.tc-send, #trained-chat-panel \.tc-new \{[^}]*font-family: inherit; font-size: 13px; font-weight: 600;/)
  assert.match(source, /\.tc-story-input \{[^}]*min-height: 44px;[^}]*font-family: inherit; font-size: 16px;/)
  assert.match(source, /min-height: 44px/)
  assert.match(source, /Replies are not reviewed/)
  assert.ok(source.includes('for (const line of [a.purpose, d.origin, d.label, d.score, d.kept])'))
  const shorthands = [...source.matchAll(/[\s{;]font:\s*([^;}]*)/g)].map(m => m[1].trim())
  assert.ok(shorthands.length >= 2)
  assert.deepEqual(shorthands.filter(v => /\binherit\b/.test(v) && v !== 'inherit'), [])
  assert.equal(/[—–]/.test(source), false)
  assert.equal(/innerHTML\s*=\s*(?!['`])\S/.test(source), false)
  assert.equal([...source.matchAll(/innerHTML\s*=/g)].length, 1) // only the button's static icon
  assert.equal(/localStorage|sessionStorage/.test(source), false)
  assert.equal((source.match(/setInterval\(/g) ?? []).length, 1)
  // the shared theme and the pure offer helpers are the only imports (the second one is a type import); the tests that compile this file also compile both
  assert.deepEqual(source.match(/^import [^]*? from '[^']+'/gm).map(m => m.slice(m.lastIndexOf("'", m.length - 2) + 1, -1)), ['./paperTheme', './chatOffer', './chatOffer'])
  assert.deepEqual(offerSource.match(/^import [^]*? from '[^']+'/gm) ?? [], [])
  for (const needle of ['role", \'dialog\'', 'aria-modal', 'role', 'aria-live', 'z-index: 1080', 'env(safe-area-inset-bottom)', 'prefers-reduced-motion', 'visualViewport', '(pointer: coarse)', 'inert']) {
    assert.ok(source.includes(needle.replace('role", ', '')), needle)
  }
  assert.ok(source.includes("'role', 'switch'"))
  assert.ok(source.includes("'role', 'log'"))
  assert.ok(source.includes("'role', 'dialog'"))
  // the panel is not a child of the 150 container, and the Run Epoch overlap is fixed at its cause
  assert.ok(source.includes('document.body.appendChild(this.panel)'))
  assert.equal(/this\.container\.appendChild\(this\.panel\)/.test(source), false)
  // no motion except the 120ms card wash; reduced motion turns that off too
  assert.equal(/@keyframes|animation:/.test(source), false)
  // the textarea and the story box both keep 16px so a phone does not zoom
  assert.equal(/font-size:\s*1[0-5]px;[^}]*\}[^]*textarea/.test(''), false)
  const css = source.slice(source.indexOf('export const PANEL_CSS'))
  assert.equal(/font-size:\s*(?:[0-9]|1[0-2])(?:\.[0-9]+)?px/.test(css), false, 'text under 13px')
  assert.equal(/font:\s*\d+\s+(?:[0-9]|1[0-2])(?:\.[0-9]+)?px/.test(css), false, 'text under 13px in a font shorthand')
  assert.equal(/small-caps/.test(css), false, 'small caps shrink the letters')
  assert.equal(/backdrop-filter|rgba\(24,22,19/.test(css), false, 'no dark glass')
})

// ---------------------------------------------------------------------------
// Review fixes: a reply never lands in another conversation, a failed refresh
// keeps the screen, a model that leaves the shelf closes its conversation,
// and the pure helpers for the verdict and the date.
// ---------------------------------------------------------------------------
const parts = body => ({
  root: body.children.find(c => c.id === 'trained-chat-panel'),
  toggle: body.children.find(c => c.id === 'trained-chat-container').all('#trained-chat-toggle')[0] ?? body.children.find(c => c.id === 'trained-chat-container').children.find(c => c.id === 'trained-chat-toggle'),
})
const reopen = async (toggle, settle) => { click(toggle); await settle(); click(toggle); await settle() }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('a reply that comes back after the visitor switched models is not drawn into the new conversation', async () => {
  await withPage(async ({ body, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    const heard = []
    p.onReply = at => heard.push(at)
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    const box = root.all('textarea')[0]
    const real = globalThis.fetch
    const gate = deferred()
    globalThis.fetch = (url, options = {}) => (options.method === 'POST' ? gate.promise : real(url, options))
    box.value = 'Question for the first model'
    root.all('form')[0].fire('submit')
    assert.equal(root.all('.tc-send')[0].disabled, true)
    click(root.all('.tc-card')[1]) // the visitor picks another model while the first is still thinking
    assert.equal(root.all('textarea')[0].disabled, false) // the new conversation is usable at once
    assert.equal(root.all('.tc-send')[0].disabled, false)
    gate.resolve(new Response(JSON.stringify({ adapter: 'e41-0a1b2c3d', reply: 'Late reply.', cut_short: false, turns_left: 7 }), { headers: { 'content-type': 'application/json' } }))
    await settle()
    assert.equal(root.textContent.includes('Late reply.'), false)
    assert.equal(root.textContent.includes('Question for the first model'), false)
    assert.equal(root.all('.tc-ex').length, 0)
    assert.equal(root.all('.tc-turns')[0].textContent, 'Question 1 of 8')
    assert.equal(heard.length, 1) // the reply was real, so the room still hears it
    // and the next message carries only the new conversation
    globalThis.fetch = real
    const sent = []
    state.post = b => { sent.push(b); return { adapter: 'e42-0a1b2c3d', reply: 'Fresh.', cut_short: false, turns_left: 7 } }
    root.all('textarea')[0].value = 'Hello second'
    root.all('form')[0].fire('submit')
    await settle()
    assert.deepEqual(sent[0], { adapter: 'e42-0a1b2c3d', messages: [{ role: 'user', content: 'Hello second' }] })
  })
})

test('a failed refresh keeps the conversation on screen; a model that left the shelf closes its conversation', async () => {
  await withPage(async ({ body, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root, toggle } = parts(body)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', cut_short: false, turns_left: 7 })
    root.all('textarea')[0].value = 'Hello'
    root.all('form')[0].fire('submit')
    await settle()
    // the list cannot be read for a moment
    const real = globalThis.fetch
    globalThis.fetch = (url, options = {}) => (options.method === 'POST' || String(url).endsWith('research-talk') ? real(url, options) : Promise.reject(new Error('offline')))
    await reopen(toggle, settle)
    assert.equal(/tc-full-sheet/.test(root.className), false)
    assert.ok(root.textContent.includes('Hi.'))
    assert.equal(root.textContent.includes('The Shelf Could Not Be Read'), false)
    assert.equal(root.all('textarea')[0].disabled, false)
    globalThis.fetch = real
    // the model leaves the shelf (it expired): the words stay, the box closes, and nothing else is chosen for the visitor
    state.list = { ...state.list, adapters: [rl()] }
    await reopen(toggle, settle)
    assert.ok(root.textContent.includes('Hi.'))
    assert.equal(root.all('.tc-info')[0].hidden, false)
    assert.ok(root.all('.tc-info')[0].textContent.startsWith('This model is no longer on the shelf.'))
    assert.equal(root.all('textarea')[0].disabled, true)
    assert.equal(root.all('.tc-card')[0].getAttribute('aria-pressed'), 'false')
    // a new conversation moves on to the first card that is there
    click(root.all('.tc-new')[0])
    assert.equal(root.all('.tc-info')[0].hidden, true)
    assert.equal(root.all('textarea')[0].disabled, false)
    assert.equal(root.all('.tc-card')[0].getAttribute('aria-pressed'), 'true')
  })
})

test('with the chat off and the story on, the story is what is chosen, and nothing dead is left', async () => {
  await withPage(async ({ body, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.attachStory(onChange => {
      const element = new El('div'); element.className = 'tc-story'
      return { element, isShown: () => true, refresh() {}, setAvailable() { onChange() } }
    })
    p.setStoryAvailable(true)
    p.setAvailable(true)
    await settle()
    const { root, toggle } = parts(body)
    assert.equal(/tc-story-chosen/.test(root.className), false) // an adapter is chosen first
    state.list = { enabled: false, adapters: [] }
    await reopen(toggle, settle)
    assert.match(root.className, /tc-chat-off/)
    assert.match(root.className, /tc-story-chosen/)
    assert.deepEqual(root.all('.tc-card').map(c => c.getAttribute('data-slug')), ['story']) // no adapter card is left behind
  })
})

test('"talk to it" ignores a slug that is not on the shelf, and waits for the list when it has not loaded', async () => {
  await withPage(async ({ body, state, settle }) => {
    state.list = { enabled: true, adapters: [sft({ name: 'Rootkeeper' }), rl()], limits: {} }
    const p = new panel.TrainedChatPanel()
    const { root } = (() => ({ root: null }))()
    p.setAvailable(true)
    await settle()
    const panelEl = body.children.find(c => c.id === 'trained-chat-panel')
    p.openWith('e99-deadbeef') // not offered
    assert.match(panelEl.className, /tc-view-shelf/)
    assert.equal(panelEl.all('.tc-card')[0].getAttribute('aria-pressed'), 'true')
    p.openWith('e42-0a1b2c3d')
    assert.match(panelEl.className, /tc-view-chat/)
    assert.equal(panelEl.all('.tc-card')[1].getAttribute('aria-pressed'), 'true')
    void root
  })
  // before the list was read: the choice is kept and applied when the list arrives
  await withPage(async ({ body, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.openWith('e42-0a1b2c3d')
    p.setAvailable(true)
    await settle()
    const panelEl = body.children.find(c => c.id === 'trained-chat-panel')
    assert.equal(panelEl.all('.tc-card')[1].getAttribute('aria-pressed'), 'true')
    assert.match(panelEl.className, /tc-view-chat/)
  })
})

test('a refresh that turns comparing off under a conversation says so and sends one model', async () => {
  await withPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root, toggle } = parts(body)
    state.list = { ...state.list, compare_enabled: true }
    await reopen(toggle, settle)
    click(root.all('.tc-switch')[0])
    assert.equal(root.all('.tc-send')[0].textContent, 'Ask Both')
    state.list = { ...state.list, compare_enabled: false }
    await reopen(toggle, settle)
    assert.equal(root.all('.tc-switch')[0].hidden, true)
    assert.equal(root.all('.tc-send')[0].textContent, 'Send') // the label follows what will really be sent
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'One.', cut_short: false, turns_left: 7 })
    root.all('textarea')[0].value = 'Hi'
    root.all('form')[0].fire('submit')
    await settle()
    assert.equal(asked.filter(a => a.method === 'POST').at(-1).body.compare, undefined)
  })
})

test('a reply that arrives lights a line saying so, and a failed send does not', async () => {
  await withPage(async ({ body, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    const line = root.all('.tc-tube-own')[0]
    assert.equal(line.hidden, true)
    state.post = () => ({ status: 429, body: { message: 'Slow down.' } })
    root.all('textarea')[0].value = 'Hi'
    root.all('form')[0].fire('submit')
    await settle()
    assert.equal(line.hidden, true)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Yes.', cut_short: false, turns_left: 7 })
    root.all('form')[0].fire('submit')
    await settle()
    assert.equal(line.hidden, false)
    assert.equal(line.textContent, 'Your reply lit the speaking tube in the room.')
  })
})

test('the verdict comes from the two stored numbers only, and dates read plainly', () => {
  assert.equal(panel.verdictOf(2.95, 1.1, false), 'Better')
  assert.equal(panel.verdictOf(1, 2, false), 'Worse')
  assert.equal(panel.verdictOf(3.02, 2.88, false), 'Little change') // under 5 percent of the larger number
  assert.equal(panel.verdictOf(0.25, 0.75, true), 'Better')
  assert.equal(panel.verdictOf(0.75, 0.25, true), 'Worse')
  assert.equal(panel.verdictOf(0, 0, true), 'Little change')
  assert.equal(panel.gaugeView(view(sft())).verdict, 'Better')
  assert.equal(panel.gaugeView(view(sft({ holdout_loss_before: 3.02, holdout_loss_after: 2.88 }))).verdict, 'Little change')
  assert.equal(panel.gaugeView(view(rl())).verdict, 'Better')
  assert.ok(panel.gaugeView(view(sft())).explain.startsWith('Loss is how wrong the model was on examples it never trained on.'))
  assert.equal(panel.formatDay('2026-12-01'), '1 Dec 2026')
  assert.equal(panel.formatDay('soon'), 'soon')
  assert.equal(panel.describeAdapter(view(sft())).kept, 'Removed after 2 Dec 2026 unless it is marked to keep.')
  assert.equal(panel.describeAdapter(view(sft({ kept: true, kept_by: 'owner' }))).kept, 'Marked to keep by owner. Stays until 2026-12-02.')
  assert.deepEqual(panel.buildChatBody('e41-0a1b2c3d', [{ role: 'user', content: 'x' }], [], 'untrained'), { adapter: 'e41-0a1b2c3d', messages: [{ role: 'user', content: 'x' }], compare: true, base_replies: [], only: 'untrained' })
})

test('the story box checks the switch again after its request returns', () => {
  const story = readFileSync(join(root, 'src/systems/ResearchStoryBox.ts'), 'utf8')
  const load = story.slice(story.indexOf('private async load()'))
  assert.ok(load.indexOf('await res.json()') < load.indexOf('if (!this.available) return', load.indexOf('await res.json()')))
  assert.ok(load.indexOf('if (!this.available) return', load.indexOf('await res.json()')) < load.indexOf('this.refused = true'))
})

// ---------------------------------------------------------------------------
// Offering a conversation to the lab (spec 2.2 to 2.4): the pure helpers
// ---------------------------------------------------------------------------
const OFFERS = { enabled: true, keep_days: 90, per_day: 3, public_text: false }
const CONSENT = [
  'If you press Offer It, the lab stores this conversation: your messages, the model\'s replies, which model you talked to, and the day. It does not store your address or an account.',
  'The lab\'s AI models may choose to train a small model on it. Anything trained on it is labelled "written by visitors". A model trained on it can repeat parts of it.',
  'The text is not shown on this page or in the lab\'s public record. The record shows only how many conversations were offered. The lab\'s owner can read it. It may be sent to Tinker (Thinking Machines) and Modal to train a small model. Those are companies outside the lab.',
  // the spec's words, with the review's two additions: the published hash of a training set, and that the checks can miss
  'The lab keeps it for 90 days, then deletes it. You can take it back with a code you get after offering. If a model has already trained on it, the stored text is still deleted, but that model cannot unlearn it, and copies in the training services may stay until they delete them. A model trained on it is listed with a hash of its whole training set, a code that identifies the set and shows none of its text.',
  'The lab checks automatically for email addresses, phone numbers, long numbers, links and user names, and refuses a conversation that has one. The checks can miss some. They cannot find names, street addresses or other private details, so do not write them.',
  'Offer only if you are 18 or older.',
  'Until you press Offer It, nothing you write here is kept.',
]

test('the offers block is read strictly: absent, off or odd means no offer button', () => {
  assert.deepEqual(offer.readOffers({ offers: OFFERS }), { keepDays: 90, perDay: 3 })
  assert.deepEqual(panel.parseListResponse({ enabled: true, offers: OFFERS }).offers, { keepDays: 90, perDay: 3 })
  for (const odd of [undefined, null, 'on', 7, [], {}, { ...OFFERS, enabled: false }, { ...OFFERS, enabled: 'true' }, { ...OFFERS, keep_days: '90' }, { ...OFFERS, keep_days: 0 }, { ...OFFERS, keep_days: 1.5 }, { ...OFFERS, keep_days: 99999 }, { ...OFFERS, per_day: -1 }, { ...OFFERS, per_day: null }]) {
    assert.equal(offer.readOffers({ offers: odd }), null, JSON.stringify(odd))
  }
  assert.equal(offer.readOffers(null), null)
  assert.equal(panel.parseListResponse({ enabled: true, adapters: [] }).offers, null)
})

test('the offer body has exactly adapter, messages and receipt; the chat body gains a receipt only when one is held', () => {
  const turns = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello', extra: 1 }]
  const body = offer.buildOfferBody('e41-0a1b2c3d', turns, '2026-11-25.abc')
  assert.deepEqual(Object.keys(body), ['adapter', 'messages', 'receipt'])
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }])
  assert.deepEqual(offer.buildWithdrawBody('ABCD-EFGH-JKMN'), { withdraw: 'ABCD-EFGH-JKMN' })
  const history = [{ role: 'user', content: 'Hi' }]
  assert.deepEqual(panel.buildChatBody('e41-0a1b2c3d', history, null, null, null), { adapter: 'e41-0a1b2c3d', messages: history })
  assert.deepEqual(panel.buildChatBody('e41-0a1b2c3d', history, null, null, 'r1'), { adapter: 'e41-0a1b2c3d', messages: history, receipt: 'r1' })
  assert.deepEqual(panel.buildChatBody('e41-0a1b2c3d', history, ['b'], 'trained', 'r1'), { adapter: 'e41-0a1b2c3d', messages: history, compare: true, base_replies: ['b'], only: 'trained', receipt: 'r1' })
})

test('a receipt is read only as the server gave it, and only the trained side of a compare answer is used', () => {
  assert.equal(offer.readReceipt('2026-11-25.AbC_-123'), '2026-11-25.AbC_-123')
  for (const odd of [undefined, null, '', 7, 'a b', 'x'.repeat(81), 'tab\t']) assert.equal(offer.readReceipt(odd), null, String(odd))
  assert.equal(panel.readReply(true, { reply: 'Hi.', receipt: 'r1' }, false).receipt, 'r1')
  assert.equal('receipt' in panel.readReply(true, { reply: 'Hi.' }, false), false)
  const pair = panel.readReply(true, { compare: true, trained: { ok: true, reply: 'A', receipt: 'r2' }, untrained: { ok: true, reply: 'B' }, turns_left: 3 }, true)
  assert.equal(pair.trained.receipt, 'r2')
  assert.equal('receipt' in pair.untrained, false)
})

test('who can be offered: two to sixteen messages in turn, ending with a reply, with a receipt held', () => {
  const turn = (n, role) => ({ role, content: `m${n}` })
  const convo = n => Array.from({ length: n }, (_, i) => turn(i, i % 2 === 0 ? 'user' : 'assistant'))
  assert.equal(offer.canOffer(convo(2), 'r'), true)
  assert.equal(offer.canOffer(convo(16), 'r'), true)
  assert.equal(offer.canOffer(convo(2), null), false)
  assert.equal(offer.canOffer(convo(0), 'r'), false)
  assert.equal(offer.canOffer(convo(3), 'r'), false) // ends with the visitor
  assert.equal(offer.canOffer(convo(18), 'r'), false)
  assert.equal(offer.canOffer([turn(0, 'assistant'), turn(1, 'user')], 'r'), false)
})

test('the consent text is the spec word for word, with keep_days from the server', () => {
  assert.deepEqual(offer.consentParagraphs(90), CONSENT)
  assert.ok(offer.consentParagraphs(30)[3].startsWith('The lab keeps it for 30 days, then deletes it.'))
  assert.equal(offer.OFFER_HEADING, 'Offer This Conversation')
  assert.equal(offer.OFFER_BUTTON, 'Offer This Conversation to the Lab')
  assert.deepEqual([offer.OFFER_SUBMIT, offer.OFFER_CANCEL, offer.OFFER_COPY, offer.OFFER_TAKE_BACK, offer.TAKE_BACK_OPEN], ['Offer It', 'Not Now', 'Copy Code', 'Take It Back', 'Take Back an Offer'])
  assert.equal(offer.OFFER_DISABLED_NOTE, 'Only a conversation the lab can verify can be offered.')
  // no number is written into the words: the one number differs only by the argument
  assert.equal(offer.consentParagraphs(90).join('|').replace('90', '30'), offer.consentParagraphs(30).join('|'))
  assert.equal(/\b90\b|\b180\b/.test(offerSource), false)
})

test('every consent claim maps to a column of the stored table, and no column is missing from the claims', () => {
  const store = readFileSync(join(root, 'api/_lib/visitor-offers-store.ts'), 'utf8')
  const table = /CREATE TABLE IF NOT EXISTS visitor_offers \(([^]*?)\n\s*\)\n/.exec(store)
  assert.ok(table, 'the CREATE TABLE of visitor_offers')
  const columns = table[1].split('\n').map(l => /^\s*([a-z_0-9]+)\s+[A-Z]/.exec(l)?.[1]).filter(Boolean)
  assert.ok(columns.includes('messages') && columns.includes('adapter_slug') && columns.includes('day'))
  const claimed = new Set(offer.OFFER_CLAIMS.flatMap(c => c.columns))
  for (const c of claimed) assert.ok(columns.includes(c), `claim names a column the table does not have: ${c}`)
  for (const c of columns) assert.ok(claimed.has(c), `column not covered by any claim: ${c}`)
  // the three the consent text names outright
  const stored = offer.OFFER_CLAIMS.find(c => c.text(90).startsWith('If you press Offer It'))
  assert.deepEqual(stored.columns.filter(c => ['messages', 'adapter_slug', 'day'].includes(c)), ['messages', 'adapter_slug', 'day'])
})

test('answers to an offer and to a take back are read strictly', () => {
  const ok = offer.readOfferAnswer(201, { offered: true, code: 'ABCD-EFGH-JKMN', kept_until: '2027-02-23T00:00:00.000Z', message: 'Thank you. The lab stored this conversation.' })
  assert.deepEqual(ok, { kind: 'stored', code: 'ABCD-EFGH-JKMN', keptUntil: '2027-02-23T00:00:00.000Z', message: 'Thank you. The lab stored this conversation.' })
  for (const odd of [{ offered: true }, { offered: true, code: 'short' }, { offered: false, code: 'ABCD-EFGH-JKMN' }, { offered: true, code: 7 }, null, 'x']) {
    assert.equal(offer.readOfferAnswer(201, odd).kind, 'refused', JSON.stringify(odd))
  }
  assert.equal(offer.readOfferAnswer(200, { offered: true, code: 'ABCD-EFGH-JKMN' }).kind, 'refused') // only a 201 is a stored offer
  const screened = offer.readOfferAnswer(422, { error: 'screened', reason: 'email', message: 'This conversation has an email address in it. The lab does not store those. Nothing was kept.' })
  assert.deepEqual([screened.kind, screened.status, screened.error], ['refused', 422, 'screened'])
  assert.equal(screened.message, 'This conversation has an email address in it. The lab does not store those. Nothing was kept.')
  // no sentence from the server: a plain one of the page's own, never a blank
  assert.equal(offer.readOfferAnswer(403, {}).message, 'This conversation cannot be offered. Start a new one and offer that.')
  assert.ok(offer.readOfferAnswer(500, null).message.length > 0)
  assert.deepEqual(offer.readWithdrawAnswer(200, { withdrawn: true, trained_on: true, message: 'Done.' }), { kind: 'withdrawn', trainedOn: true, message: 'Done.' })
  assert.equal(offer.readWithdrawAnswer(200, { withdrawn: true, trained_on: true }).message, offer.OFFER_TRAINED_ON)
  assert.equal(offer.readWithdrawAnswer(200, { withdrawn: true }).message, offer.OFFER_WITHDRAWN)
  assert.equal(offer.readWithdrawAnswer(404, { error: 'unknown_code' }).kind, 'refused')
  assert.equal(offer.readWithdrawAnswer(200, {}).kind, 'refused')
  assert.equal(offer.normalizeCode('abcd efgh-jkmn'), 'ABCD-EFGH-JKMN')
  assert.equal(offer.normalizeCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN')
  for (const odd of ['', 'ABCD-EFGH', 'ABCD-EFGH-JKMN-X', 'ABCD-EFGH-JK!N']) assert.equal(offer.normalizeCode(odd), null, odd)
})

// ---------------------------------------------------------------------------
// The offer flow in the panel
// ---------------------------------------------------------------------------
const withOffers = (over = {}) => ({ enabled: true, compare_enabled: false, adapters: [sft({ name: 'Rootkeeper' }), rl()], limits: { max_message_chars: 500, max_turns: 8 }, notice: 'A notice.', offers: OFFERS, ...over })
const withOfferPage = (run, over = {}) => withPage(run, { list: withOffers(over) })
const offerParts = root => ({
  button: root.all('.tc-offer')[0],
  note: root.all('.tc-offer-note')[0],
  sheet: root.all('.tc-offer-sheet')[0],
  box: root.all('textarea')[0],
  form: root.all('form')[0],
})
const say = async (root, settle, message) => { const { box, form } = offerParts(root); box.value = message; form.fire('submit'); await settle() }
const sheetText = root => root.all('.tc-offer-sheet')[0].textContent
const sheetButton = (root, label) => root.all('.tc-offer-sheet')[0].all('button').find(b => b.textContent === label)
const POSTS = asked => asked.filter(a => a.method === 'POST')
const openPanel = async (body, settle) => {
  const { toggle } = parts(body)
  click(toggle)
  await settle()
}

test('without an offers block there is no offer button, no take back link and no receipt key', async () => {
  await withPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    assert.equal(offerParts(root).button.parent.hidden, true)
    assert.equal(root.all('.tc-takeback').length, 0)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 7, receipt: 'r1' }) // even if a receipt came, nothing is kept or sent
    await say(root, settle, 'Hello')
    await say(root, settle, 'Again')
    assert.deepEqual(Object.keys(POSTS(asked)[1].body), ['adapter', 'messages'])
    assert.equal(offerParts(root).button.parent.hidden, true)
  })
})

test('the offer button is there, disabled with its reason, until the panel holds a receipt for the last reply', async () => {
  await withOfferPage(async ({ body, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    const { button, note } = offerParts(root)
    assert.equal(button.parent.hidden, false)
    assert.equal(button.textContent, 'Offer This Conversation to the Lab')
    assert.equal(button.disabled, true) // no reply yet
    assert.equal(note.hidden, false)
    // the note says why from what the panel holds: nothing sent yet
    assert.equal(note.textContent, 'Send a message first. Then you can offer the conversation.')
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'No receipt.', turns_left: 7 }) // a reply the lab could not chain
    await say(root, settle, 'Hello')
    assert.equal(button.disabled, true)
    assert.equal(note.hidden, false)
    assert.equal(note.textContent, 'Only a conversation the lab can verify can be offered.')
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 6, receipt: 'r2' })
    await say(root, settle, 'Hello again')
    assert.equal(button.disabled, false)
    assert.equal(note.hidden, true)
    assert.equal(button.parent.className.includes('tc-offer-row'), true)
    // the button is in the conversation's foot, after the standing note
    const foot = root.all('.tc-foot')[0]
    const kids = foot.children.map(c => c.className)
    assert.ok(kids.indexOf('tc-offer-row') > kids.indexOf('tc-note'))
  })
})

test('the receipt of the last reply goes with the next message, and is dropped with the conversation or the adapter', async () => {
  await withOfferPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    let n = 0
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: `Reply ${++n}.`, turns_left: 8 - n, receipt: `r${n}` })
    await say(root, settle, 'One')
    assert.deepEqual(Object.keys(POSTS(asked)[0].body), ['adapter', 'messages']) // the first message has nothing to prove
    await say(root, settle, 'Two')
    assert.equal(POSTS(asked)[1].body.receipt, 'r1')
    await say(root, settle, 'Three')
    assert.equal(POSTS(asked)[2].body.receipt, 'r2')
    assert.equal(offerParts(root).button.disabled, false)
    // a new conversation: no receipt, no offer
    click(root.all('.tc-new').find(b => b.textContent === 'New Conversation' && !b.hidden))
    assert.equal(offerParts(root).button.disabled, true)
    await say(root, settle, 'Fresh')
    assert.equal('receipt' in POSTS(asked).at(-1).body, false)
    // another adapter: the receipt of the first is not carried over
    await say(root, settle, 'Fresh two')
    assert.ok(POSTS(asked).at(-1).body.receipt)
    click(root.all('.tc-card')[1])
    assert.equal(offerParts(root).button.disabled, true)
    await say(root, settle, 'Other')
    const last = POSTS(asked).at(-1).body
    assert.equal(last.adapter, 'e42-0a1b2c3d')
    assert.equal('receipt' in last, false)
  })
})

test('a failed send keeps the receipt of the conversation so far', async () => {
  await withOfferPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 7, receipt: 'r1' })
    await say(root, settle, 'One')
    state.post = () => ({ status: 429, body: { error: 'rate', message: 'Slow down.' } })
    await say(root, settle, 'Two')
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 6, receipt: 'r2' })
    await say(root, settle, 'Two')
    assert.equal(POSTS(asked)[1].body.receipt, 'r1')
    assert.equal(POSTS(asked)[2].body.receipt, 'r1')
  })
})

test('compare: only the trained side is offered, with the receipt of its reply', async () => {
  await withOfferPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    click(root.all('.tc-switch')[0])
    const pair = n => ({ adapter: 'e41-0a1b2c3d', compare: true, base_model: BASE, trained: { ok: true, reply: `trained ${n}`, receipt: `t${n}` }, untrained: { ok: true, reply: `base ${n}` }, turns_left: 8 - n })
    state.post = () => pair(1)
    await say(root, settle, 'First')
    state.post = () => pair(2)
    await say(root, settle, 'Second')
    assert.equal(POSTS(asked)[1].body.receipt, 't1')
    click(offerParts(root).button)
    const text = sheetText(root)
    assert.ok(text.includes('Only the trained model\'s side is offered. The untrained answers are not part of it.'))
    assert.equal(text.includes('base 1'), false)
    assert.ok(text.includes('trained 2'))
    state.post = () => ({ status: 201, body: { offered: true, code: 'ABCD-EFGH-JKMN', kept_until: '2027-02-23T00:00:00.000Z', message: 'Thank you. The lab stored this conversation.' } })
    click(sheetButton(root, 'Offer It'))
    await settle()
    const sent = POSTS(asked).at(-1)
    assert.equal(sent.url, '/api/experiment/chat-offer')
    assert.deepEqual(sent.body.messages.map(m => m.content), ['First', 'trained 1', 'Second', 'trained 2'])
    assert.equal(sent.body.receipt, 't2')
  }, { compare_enabled: true })
})

test('the sheet: consent text with keep_days from the server, the exact conversation, focus in and out, Escape', async () => {
  await withOfferPage(async ({ body, state, settle, press }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    await openPanel(body, settle)
    const { root } = parts(body)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'The roots hold the constraints.', turns_left: 7, receipt: 'r1' })
    await say(root, settle, 'What are roots for?')
    const { button, sheet } = offerParts(root)
    assert.equal(sheet.hidden, true)
    button.focus()
    click(button)
    assert.equal(sheet.hidden, false)
    const heading = sheet.all('h2')[0]
    assert.equal(heading.textContent, 'Offer This Conversation')
    assert.equal(globalThis.document.activeElement, heading) // focus moves to the heading
    assert.equal(sheet.all('.tc-offer-card')[0].getAttribute('role'), 'dialog')
    assert.equal(sheet.all('.tc-offer-card')[0].getAttribute('aria-modal'), 'true')
    assert.equal(sheet.all('.tc-offer-card')[0].getAttribute('aria-labelledby'), heading.id)
    const paragraphs = sheet.all('.tc-offer-scroll')[0].all('p').map(e => e.textContent)
    for (const line of CONSENT) assert.ok(paragraphs.includes(line), line)
    // the exact conversation, as it would be stored
    const turns = sheet.all('.tc-offer-turn')
    assert.deepEqual(turns.map(t => t.all('.tc-offer-turn-text')[0].textContent), ['What are roots for?', 'The roots hold the constraints.'])
    assert.deepEqual(turns.map(t => t.all('.tc-who-label')[0].textContent), ['You', 'Rootkeeper'])
    assert.deepEqual(sheet.all('button').map(b => b.textContent), ['Offer It', 'Not Now'])
    // the page behind the sheet cannot be reached while it is open
    assert.equal(root.all('.tc-head')[0].inert, true)
    assert.equal(root.all('.tc-body')[0].inert, true)
    // Escape closes the sheet, not the panel, and focus goes back to the button
    press('Escape', heading)
    assert.equal(sheet.hidden, true)
    assert.equal(root.all('.tc-head')[0].inert, false)
    assert.equal(globalThis.document.activeElement, button)
    assert.match(root.className, /\bopen\b/)
    // Not Now does the same
    click(button)
    click(sheetButton(root, 'Not Now'))
    assert.equal(sheet.hidden, true)
    assert.equal(globalThis.document.activeElement, button)
    // nothing was sent: only the chat message
    assert.equal(sheet.children.length, 0)
    press('Escape', button)
    assert.doesNotMatch(root.className, /\bopen\b/) // with no sheet open, Escape closes the panel as before
  })
})

test('Offer It sends exactly adapter, messages and receipt; a 201 shows the code once and it is not written to any storage', async () => {
  const storage = []
  const saved = { local: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), session: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage') }
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { storage.push(name); throw new Error('storage was touched') } })
  }
  try {
    await withOfferPage(async ({ body, asked, state, settle, press }) => {
      const p = new panel.TrainedChatPanel()
      p.setAvailable(true)
      await settle()
      const { root } = parts(body)
      state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 7, receipt: 'r1' })
      await say(root, settle, 'Hello there')
      const { button, sheet } = offerParts(root)
      click(button)
      state.post = () => ({ status: 201, body: { offered: true, code: 'ABCD-EFGH-JKMN', kept_until: '2027-02-23T00:00:00.000Z', message: 'Thank you. The lab stored this conversation.' } })
      click(sheetButton(root, 'Offer It'))
      await settle()
      const sent = POSTS(asked).at(-1)
      assert.equal(sent.url, '/api/experiment/chat-offer')
      assert.deepEqual(Object.keys(sent.body), ['adapter', 'messages', 'receipt'])
      assert.deepEqual(sent.body, { adapter: 'e41-0a1b2c3d', messages: [{ role: 'user', content: 'Hello there' }, { role: 'assistant', content: 'Hi.' }], receipt: 'r1' })
      const text = sheetText(root)
      assert.ok(text.includes('Thank you. The lab stored this conversation.'))
      assert.ok(text.includes('Your code to take it back:'))
      assert.equal(sheet.all('.tc-offer-code')[0].textContent, 'ABCD-EFGH-JKMN')
      assert.ok(text.includes('Keep it. The lab cannot show it again.'))
      assert.ok(text.includes('The lab keeps the conversation until 23 Feb 2027.'))
      assert.deepEqual(sheet.all('button').map(b => b.textContent), ['Copy Code', 'Take It Back', 'Done'])
      // the button now reads Offered and stays off for this conversation
      assert.equal(button.textContent, 'Offered')
      assert.equal(button.disabled, true)
      // Copy Code
      const written = []
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async t => { written.push(t) } } } })
      click(sheetButton(root, 'Copy Code'))
      await settle()
      assert.deepEqual(written, ['ABCD-EFGH-JKMN'])
      assert.equal(sheet.all('.tc-offer-status')[0].textContent, 'Copied')
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
      click(sheetButton(root, 'Copy Code'))
      await settle()
      assert.ok(sheet.all('.tc-offer-status')[0].textContent.startsWith('The code could not be copied.'))
      delete globalThis.navigator
      // Done closes it, returns focus, and the code is gone from the page
      click(sheetButton(root, 'Done'))
      assert.equal(sheet.hidden, true)
      assert.equal(root.textContent.includes('ABCD-EFGH-JKMN'), false)
      // a further message does not bring the button back
      await say(root, settle, 'More')
      assert.equal(button.disabled, true)
      assert.equal(button.textContent, 'Offered')
      void press
    })
  } finally {
    for (const [name, d] of [['localStorage', saved.local], ['sessionStorage', saved.session]]) {
      if (d) Object.defineProperty(globalThis, name, d)
      else delete globalThis[name]
    }
  }
  assert.deepEqual(storage, [], 'the panel reached for storage')
})

test('a refusal is shown in the sheet as an alert and the conversation stays as it was', async () => {
  await withOfferPage(async ({ body, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 7, receipt: 'r1' })
    await say(root, settle, 'Write to me at a@b.org')
    const { button, sheet } = offerParts(root)
    click(button)
    const message = 'This conversation has an email address in it. The lab does not store those. Nothing was kept.'
    state.post = () => ({ status: 422, body: { error: 'screened', reason: 'email', message } })
    click(sheetButton(root, 'Offer It'))
    await settle()
    const alert = sheet.all('.tc-offer-alert')[0]
    assert.equal(alert.getAttribute('role'), 'alert')
    assert.equal(alert.hidden, false)
    assert.equal(alert.textContent, message)
    assert.equal(sheet.hidden, false)
    assert.equal(sheet.all('.tc-offer-code').length, 0)
    assert.equal(sheetButton(root, 'Offer It').disabled, false) // the visitor may close it or try again
    assert.equal(button.textContent, 'Offer This Conversation to the Lab')
    // the conversation is untouched
    click(sheetButton(root, 'Not Now'))
    assert.ok(root.all('.tc-log')[0].textContent.includes('Write to me at a@b.org'))
    assert.equal(button.disabled, false)
    // a conversation the lab cannot verify: the receipt is let go and the button says why
    click(button)
    state.post = () => ({ status: 403, body: { error: 'not_verified', message: 'This conversation cannot be offered. Start a new one and offer that.' } })
    click(sheetButton(root, 'Offer It'))
    await settle()
    assert.equal(sheet.all('.tc-offer-alert')[0].textContent, 'This conversation cannot be offered. Start a new one and offer that.')
    click(sheetButton(root, 'Not Now'))
    assert.equal(button.disabled, true)
    assert.equal(offerParts(root).note.hidden, false)
    // a lost connection is a plain sentence too
    await say(root, settle, 'x')
  })
})

test('a lost connection while offering says nothing was kept', async () => {
  await withOfferPage(async ({ body, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 7, receipt: 'r1' })
    await say(root, settle, 'Hello')
    click(offerParts(root).button)
    const real = globalThis.fetch
    globalThis.fetch = async () => { throw new TypeError('offline') }
    click(sheetButton(root, 'Offer It'))
    await settle()
    globalThis.fetch = real
    assert.equal(offerParts(root).sheet.all('.tc-offer-alert')[0].textContent, 'The lab could not be reached. Nothing was kept. Check your connection and try again.')
  })
})

test('Take Back an Offer: a one field form in the shelf footer, the code in the body, the answer shown, focus returns', async () => {
  await withOfferPage(async ({ body, asked, state, settle, press }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    await openPanel(body, settle)
    const { root } = parts(body)
    const link = root.all('.tc-takeback')[0]
    assert.equal(link.textContent, 'Take Back an Offer')
    assert.ok(root.all('.tc-shelf-foot')[0].children.includes(link))
    link.focus()
    click(link)
    const sheet = offerParts(root).sheet
    assert.equal(sheet.hidden, false)
    assert.equal(sheet.all('h2')[0].textContent, 'Take Back an Offer')
    assert.equal(sheet.all('input').length, 1)
    assert.equal(sheet.all('label')[0].getAttribute('for'), sheet.all('input')[0].id)
    // a code that cannot be one is refused on the page, with nothing sent
    sheet.all('input')[0].value = 'abc'
    sheet.all('form')[0].fire('submit')
    await settle()
    assert.equal(sheet.all('.tc-offer-alert')[0].textContent, 'That is not a take back code. It has 12 letters and numbers, like XXXX-XXXX-XXXX.')
    assert.equal(POSTS(asked).length, 0)
    // an unknown code
    sheet.all('input')[0].value = 'abcd efgh jkmn'
    state.post = () => ({ status: 404, body: { error: 'unknown_code' } })
    sheet.all('form')[0].fire('submit')
    await settle()
    assert.deepEqual(POSTS(asked).at(-1).body, { withdraw: 'ABCD-EFGH-JKMN' })
    assert.equal(POSTS(asked).at(-1).url, '/api/experiment/chat-offer')
    assert.ok(sheet.all('.tc-offer-alert')[0].textContent.length > 0)
    // taken back after a model trained on it: the server's own sentence
    state.post = () => ({ withdrawn: true, trained_on: true, message: 'Done. The lab deleted the stored text. A model was already trained on it and cannot unlearn it.' })
    sheet.all('form')[0].fire('submit')
    await settle()
    assert.ok(sheetText(root).includes('A model was already trained on it and cannot unlearn it.'))
    assert.deepEqual(sheet.all('button').map(b => b.textContent), ['Done'])
    click(sheetButton(root, 'Done'))
    assert.equal(sheet.hidden, true)
    assert.equal(globalThis.document.activeElement, root.all('.tc-takeback')[0])
    // Escape from the form returns focus to the link too
    click(root.all('.tc-takeback')[0])
    press('Escape', sheet.all('h2')[0])
    assert.equal(sheet.hidden, true)
    assert.equal(globalThis.document.activeElement, root.all('.tc-takeback')[0])
    // and from the answer, after a take back went through: Escape is not held back by the request that finished
    click(root.all('.tc-takeback')[0])
    sheet.all('input')[0].value = 'ABCD-EFGH-JKMN'
    sheet.all('form')[0].fire('submit')
    await settle()
    assert.deepEqual(sheet.all('button').map(b => b.textContent), ['Done'])
    press('Escape', globalThis.document.activeElement)
    assert.equal(sheet.hidden, true)
    assert.equal(globalThis.document.activeElement, root.all('.tc-takeback')[0])
  })
})

test('Take It Back in the code sheet sends the code it holds; a refresh that turns offers off removes the button and the link', async () => {
  await withOfferPage(async ({ body, asked, state, settle }) => {
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', turns_left: 7, receipt: 'r1' })
    await say(root, settle, 'Hello')
    click(offerParts(root).button)
    state.post = () => ({ status: 201, body: { offered: true, code: 'ABCD-EFGH-JKMN', kept_until: '2027-02-23T00:00:00.000Z', message: 'Thank you. The lab stored this conversation.' } })
    click(sheetButton(root, 'Offer It'))
    await settle()
    state.post = () => ({ withdrawn: true, trained_on: false, message: 'Done. The lab deleted the stored text.' })
    click(sheetButton(root, 'Take It Back'))
    await settle()
    assert.deepEqual(POSTS(asked).at(-1).body, { withdraw: 'ABCD-EFGH-JKMN' })
    assert.ok(sheetText(root).includes('Done. The lab deleted the stored text.'))
    assert.equal(sheetText(root).includes('ABCD-EFGH-JKMN'), false)
    click(sheetButton(root, 'Done'))
    // offers go off in the server's next answer: both controls go
    state.list = withOffers({ offers: undefined })
    p.setAvailable(false); p.setAvailable(true)
    await settle()
    assert.equal(root.all('.tc-takeback').length, 0)
    assert.equal(offerParts(root).button.parent.hidden, true)
  })
})

test('the story model never shows the offer button', async () => {
  await withPage(async ({ body, state, settle }) => {
    state.list = withOffers({ adapters: [] })
    const p = new panel.TrainedChatPanel()
    let shown = false
    p.attachStory(onChange => {
      const element = new El('div')
      element.append(new El('input'))
      return { element, isShown: () => shown, refresh() {}, setAvailable(on) { shown = on; onChange() } }
    })
    p.setAvailable(true)
    p.setStoryAvailable(true)
    await settle(); await settle()
    const { root } = parts(body)
    assert.match(root.className, /tc-story-chosen/)
    assert.equal(offerParts(root).button.parent.hidden, true)
  })
})

// ---------------------------------------------------------------------------
// The tutor card (spec 1.11)
// ---------------------------------------------------------------------------
const cell = (passed, total, band) => ({ passed, total, band })
const tutor = (over = {}) => sft({
  slug: 'e51-0a1b2c3d', epoch: 51, kind: 'tutor', author_name: 'GPT-6 Astra', holdout_loss_before: 2.5, holdout_loss_after: 1.5,
  skill_map: {
    topic: 'Reading a rubric', teacher_name: 'Claude Fable 5.2', seen_only: false,
    rows: [
      { name: 'Counting rules', before: cell(1, 6, 1), after: cell(5, 6, 4) },
      { name: 'Edge cases', before: cell(2, 6, 2), after: cell(2, 6, 2) },
      { name: 'Naming', before: cell(0, 6, 0), after: null },
      { name: 'Order', before: cell(3, 6, 3), after: cell(6, 6, 5) },
      { name: 'Units', before: cell(1, 6, 1), after: cell(2, 6, 2) },
      { name: 'Quotes', before: cell(4, 6, 3), after: cell(3, 6, 3) },
    ],
  },
  ...over,
})

test('a skill map is read strictly: cells are whole counts with a band, rows are capped at ten', () => {
  assert.deepEqual(panel.readSkillCell(cell(5, 6, 4)), cell(5, 6, 4))
  for (const odd of [null, 'x', {}, cell(7, 6, 4), cell(1, 0, 0), cell(-1, 6, 0), cell(1.5, 6, 1), cell(1, 6, 6), cell(1, 6, -1), { passed: '1', total: 6, band: 1 }]) assert.equal(panel.readSkillCell(odd), null, JSON.stringify(odd))
  const map = panel.readSkillMap(tutor().skill_map)
  assert.equal(map.rows.length, 6)
  assert.equal(map.rows[2].after, null)
  assert.equal(panel.readSkillMap({ ...tutor().skill_map, rows: [] }), null)
  assert.equal(panel.readSkillMap({ ...tutor().skill_map, topic: '' }), null)
  assert.equal(panel.readSkillMap({ ...tutor().skill_map, rows: Array.from({ length: 14 }, (_, i) => ({ name: `r${i}`, before: cell(1, 6, 1), after: null })) }).rows.length, 10)
  const a = view(tutor())
  assert.equal(a.kind, 'tutor')
  assert.equal(panel.kindLabel(a), 'Taught by Questions')
  assert.equal(panel.gaugeView(a).kind, 'none') // no loss gauge for a lesson
  // an adapter that says tutor with no readable map is still listed, with no invented numbers
  assert.equal(view(tutor({ skill_map: { topic: 't' } })).skillMap, undefined)
  // the overall count comes from rows measured both times, and its words follow the counts
  const sum = panel.skillSummary(a.skillMap)
  assert.deepEqual(sum, { more: true, verdict: 'More Answers Passed', text: 'from 11 of 30 to 18 of 30 answers passed' })
  assert.equal(panel.skillSummary({ ...a.skillMap, rows: [{ name: 'x', before: cell(4, 6, 3), after: cell(3, 6, 3) }] }).verdict, 'Not More Answers Passed')
  assert.equal(panel.skillSummary({ ...a.skillMap, rows: [{ name: 'x', before: cell(4, 6, 3), after: null }] }), null)
  // the lab marked the change within noise: the counts are shown, with no verdict either way
  assert.deepEqual(panel.skillSummary({ ...a.skillMap, withinNoise: true }), { more: false, verdict: 'Within Noise', text: 'from 11 of 30 to 18 of 30 answers passed' })
  assert.equal(panel.readSkillMap({ ...tutor().skill_map, within_noise: true }).withinNoise, true)
  // cut off answers are a flag on the card and in the details, next to the verdict
  assert.deepEqual(panel.skillFlags({ ...a.skillMap, seenOnly: true, cutShort: true }), [
    'Flag: better only on questions seen in teaching.', 'Flag: many answers were cut off by the token limit, so a gain may come from shorter answers.',
  ])
  assert.equal(panel.readSkillMap({ ...tutor().skill_map, cut_short: true }).cutShort, true)
  assert.equal(panel.bandText(a.skillMap.rows[0]), '1 to 4')
  assert.equal(panel.bandText(a.skillMap.rows[2]), '0 before')
  assert.equal(panel.skillSentence(a.skillMap.rows[0]), 'Counting rules. Before: 1 of 6 answers passed. Pass band 1 of 5. After: 5 of 6 answers passed. Pass band 4 of 5.')
  // the shared note is the same words as the server's
  const server = readFileSync(join(root, 'api/_lib/tinker-tutor.ts'), 'utf8')
  const m = /TUTOR_MEASURE_NOTE\s*=\s*\n?\s*'([^']+)'/.exec(server) ?? /TUTOR_MEASURE_NOTE\s*=\s*\n?\s*"([^"]+)"/.exec(server)
  if (m) assert.equal(panel.TUTOR_MEASURE_NOTE, m[1].replace(/\\'/g, '\''))
  assert.equal(panel.TUTOR_MEASURE_NOTE, 'The lab counts which answers pass. The rules, the questions and the teaching text were written by models, and a model approved the rules. Nobody has checked that the rules measure the skill.')
})

test('a lesson is a card on the shelf: tag, pass bands with two bars a row, four rows, the count, the notes', async () => {
  await withPage(async ({ body, state, settle }) => {
    state.list = withOffers({ adapters: [view(tutor()) && tutor(), sft({ name: 'Rootkeeper' })], offers: undefined })
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    const card = root.all('.tc-card')[0]
    assert.equal(card.all('.tc-tag')[0].textContent, 'Taught by Questions')
    assert.ok(card.textContent.includes('Pass Bands, Higher Is Better'))
    const rows = card.all('.tc-skill-row')
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map(r => r.all('.tc-skill-name')[0].textContent), ['Counting rules', 'Edge cases', 'Naming', 'Order'])
    assert.deepEqual(rows.map(r => r.all('.tc-skill-band')[0].textContent), ['1 to 4', '2 to 2', '0 before', '3 to 5'])
    // two bars a row: hatched before, solid after, widths from the counts
    assert.deepEqual(rows[0].all('.tc-bar').map(b => [b.className, b.style.width]), [['tc-bar tc-hatch', '16.7%'], ['tc-bar tc-after', '83.3%']])
    assert.equal(rows[2].all('.tc-bar')[1].style.width, '0%') // not measured after: an empty bar, and the text says so
    assert.ok(rows[0].getAttribute('aria-label').includes('Before: 1 of 6 answers passed. Pass band 1 of 5.'))
    assert.ok(rows[2].getAttribute('aria-label').includes('After: not measured.'))
    assert.ok(card.textContent.includes('and 2 more in Details'))
    assert.ok(card.textContent.includes('More Answers Passed'))
    assert.ok(card.textContent.includes('from 11 of 30 to 18 of 30 answers passed'))
    assert.ok(card.textContent.includes(panel.TUTOR_MEASURE_NOTE))
    assert.ok(card.textContent.includes('Pass bands come from questions held back from teaching.'))
    assert.equal(card.all('.tc-gauge-row').length, 0) // no loss gauge
    assert.equal(card.textContent.includes('Held-Out Loss'), false)
    assert.equal(card.textContent.includes('Flag:'), false)
    // the details carry every row, who taught it, and the note
    const det = root.all('.tc-details')[0].textContent
    assert.ok(det.includes('Taught by Claude Fable 5.2.'))
    assert.ok(det.includes('Units. Before: 1 of 6 answers passed. Pass band 1 of 5. After: 2 of 6 answers passed. Pass band 2 of 5.'))
    assert.ok(det.includes('A lesson on "Reading a rubric" written by GPT-6 Astra, taught by Claude Fable 5.2.'))
    assert.ok(det.includes(panel.TUTOR_MEASURE_NOTE))
    // the other card is still a fine-tune with its gauge
    assert.ok(root.all('.tc-card')[1].textContent.includes('Lower Is Better'))
  })
})

test('a lesson that got better only on questions seen in teaching says so on the card', async () => {
  await withPage(async ({ body, state, settle }) => {
    state.list = { enabled: true, adapters: [tutor({ skill_map: { ...tutor().skill_map, seen_only: true } })], limits: {}, notice: 'N.' }
    const p = new panel.TrainedChatPanel()
    p.setAvailable(true)
    await settle()
    const { root } = parts(body)
    assert.ok(root.all('.tc-card')[0].textContent.includes('Flag: better only on questions seen in teaching.'))
  })
})

test('an adapter trained on visitor conversations says so on its card details, and its origin label is read', () => {
  const a = view(sft({ from_visitors: true, origin: 'written by visitors in chats with lab/e41-0a1b2c3d' }))
  assert.equal(a.fromVisitors, true)
  assert.equal(a.dataOrigin, 'written by visitors in chats with lab/e41-0a1b2c3d')
  const d = panel.describeAdapter(a)
  assert.ok(d.origin.includes('conversations written by visitors'))
  assert.ok(d.origin.includes('No model read them and nobody reviewed them. The lab\'s owner can read them, and each read is counted.'))
  assert.equal(d.origin.includes('Nobody at the lab has read them'), false, 'not true after the owner reads one')
  assert.equal(d.label, 'Data origin: written by visitors in chats with lab/e41-0a1b2c3d.')
  assert.equal(view(sft({ origin: 'written by visitors' })).dataOrigin, 'written by visitors')
  assert.equal(view(sft({ origin: 'written by visitors in chats with lab/not-a-slug' })).dataOrigin, undefined)
  assert.equal(view(sft()).fromVisitors, undefined)
})

test('the offer and lesson code keeps the page rules: text only, no storage, no dash, no motion, no small type', () => {
  for (const src of [source, offerSource]) {
    assert.equal(/[—–]/.test(src), false)
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), false)
    assert.equal(/setTimeout|requestAnimationFrame/.test(src), false)
  }
  assert.equal([...source.matchAll(/innerHTML\s*=/g)].length, 1) // still only the toggle's static icon
  assert.equal(/outerHTML|insertAdjacentHTML|document\.write/.test(source + offerSource), false)
  // every string of the consent text, the buttons and the messages is free of dashes and of the words a button may not use
  const strings = [
    ...offer.consentParagraphs(90), offer.OFFER_BUTTON, offer.OFFER_HEADING, offer.OFFER_DISABLED_NOTE, offer.OFFER_THANKS, offer.OFFER_COPY_FAILED, offer.TAKE_BACK_HELP,
    offer.TAKE_BACK_BAD_CODE, offer.OFFER_UNREACHED, offer.OFFER_TRAINED_ON, offer.OFFER_WITHDRAWN, offer.OFFER_PREVIEW_LABEL, panel.TUTOR_MEASURE_NOTE,
    offer.readOfferAnswer(500, null).message, offer.readWithdrawAnswer(500, null).message, offer.readWithdrawAnswer(404, null).message,
  ]
  for (const s of strings) assert.equal(/[—–]|--/.test(s), false, s)
  // button labels are in Title Case
  for (const label of [offer.OFFER_BUTTON, offer.OFFER_SUBMIT, offer.OFFER_CANCEL, offer.OFFER_COPY, offer.OFFER_TAKE_BACK, offer.TAKE_BACK_OPEN, offer.OFFER_DONE, offer.OFFERED_BUTTON]) {
    for (const w of label.split(' ')) assert.ok(/^[A-Z]/.test(w) || ['to', 'the', 'of', 'an', 'a'].includes(w), label)
  }
  // the sheet's own css: theme tokens only, readable type, 44px targets
  const css = panel.PANEL_CSS
  assert.match(css, /\.tc-offer-sheet \{[^}]*position: absolute; inset: 0;/)
  assert.match(css, /\.tc-offer \{ min-height: 44px;/)
  assert.match(css, /\.tc-offer-go \{ min-height: 44px;/)
  assert.match(css, /\.tc-code-input \{ min-height: 44px;[^}]*font-size: 16px;/)
})

test('the disabled offer button says why, from what the panel holds', () => {
  const t = (role, content) => ({ role, content })
  assert.equal(offer.offerDisabledNote({ turns: [], busy: false, halfPair: false }), 'Send a message first. Then you can offer the conversation.')
  assert.equal(offer.offerDisabledNote({ turns: [t('user', 'Hi')], busy: true, halfPair: false }), 'Wait for the reply. Then you can offer the conversation.')
  assert.equal(offer.offerDisabledNote({ turns: [t('user', 'Hi'), t('assistant', 'Hello')], busy: false, halfPair: true }), 'The trained model did not answer the last message, so this conversation cannot be offered.')
  assert.equal(offer.offerDisabledNote({ turns: [t('user', 'Hi'), t('assistant', 'Hello')], busy: false, halfPair: false }), 'Only a conversation the lab can verify can be offered.')
  for (const s of [offer.OFFER_NOTE_EMPTY, offer.OFFER_NOTE_WAITING, offer.OFFER_NOTE_HALF]) assert.doesNotMatch(s, /[–—]/)
  // an offer answered after the visitor moved to another conversation marks nothing on the new one
  const src = readFileSync(join(root, 'src/systems/TrainedChatPanel.ts'), 'utf8')
  assert.match(src, /const conv = this\.convId[\s\S]{0,1200}if \(conv === this\.convId\) this\.offered = true/)
})

test('"talk to it" with the chat and the story both off does not open a hidden panel', async () => {
  await withPage(async ({ body, settle }) => {
    const p = new panel.TrainedChatPanel()
    await settle()
    p.openWith('e42-0a1b2c3d')
    const panelEl = body.children.find(c => c.id === 'trained-chat-panel')
    assert.doesNotMatch(panelEl.className, /\bopen\b/)
  })
})
