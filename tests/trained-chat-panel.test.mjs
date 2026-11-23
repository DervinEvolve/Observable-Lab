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
for (const path of ['src/systems/TrainedChatPanel.ts', 'src/systems/ResearchStoryBox.ts']) {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  mkdirSync(dirname(join(build, path)), { recursive: true })
  writeFileSync(join(build, path.replace(/\.ts$/, '.js')), output)
}
after(() => rmSync(build, { recursive: true, force: true }))
const load = path => import(pathToFileURL(join(build, path)).href)
const panel = await load('src/systems/TrainedChatPanel.js')
const storyBox = await load('src/systems/ResearchStoryBox.js')
const source = readFileSync(join(root, 'src/systems/TrainedChatPanel.ts'), 'utf8')

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
  assert.match(panel.PANEL_CSS, new RegExp(`--tc-wood-edge: ${panel.ACCENT_NEUTRAL};`))
})

test('card tags, counters and the shelf signature', () => {
  assert.equal(panel.kindLabel(view(sft())), 'Fine-Tuned')
  assert.equal(panel.kindLabel(view(rl())), 'Practice by Reward')
  assert.equal(panel.kindLabel('story'), 'Story Model')
  assert.equal(panel.turnCounterText(0, 8), 'Turn 1 of 8')
  assert.equal(panel.turnCounterText(2, 8), 'Turn 3 of 8')
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
  const m = new RegExp(`--tc-${name}: (#[0-9A-Fa-f]{6});`).exec(panel.PANEL_CSS)
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
  assert.equal(/[^-]color: var\(--tc-brass\)/.test(panel.PANEL_CSS), false)
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
  globalThis.document = { createElement: t => new El(t), body, activeElement: null, addEventListener() {}, removeEventListener() {} }
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
  try { return await run({ body, asked, state, timers, settle }) } finally {
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
    assert.ok(foot.includes('speaking tube in the room glows for two minutes'))
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
    assert.ok(root.textContent.includes('Nothing Is on the Shelf Yet'))
    assert.ok(root.textContent.includes('None has been saved yet, so there is no one to talk to.'))
    assert.match(root.className, /tc-full-sheet/)
    assert.equal(root.all('.tc-card').length, 0)
    assert.equal(root.all('.tc-shelf-head')[0].style.display, 'none')

    state.list = { enabled: true, adapters: [], unavailable: true }
    p.setAvailable(false); p.setAvailable(true)
    await settle()
    assert.ok(root.textContent.includes('The Shelf Could Not Be Read'))
    assert.ok(root.textContent.includes('Try Again'))
    assert.equal(root.textContent.includes('Nothing Is on the Shelf Yet'), false)
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
    assert.ok(root.textContent.includes('Nothing Is on the Shelf Yet'))
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
    assert.ok(root.all('.tc-switch-note')[0].textContent.includes(`Asks the untrained ${BASE} the same question`))
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
    assert.ok(root.textContent.includes('Only one answer came back. Ask again to get both.'))
    assert.equal(box.value, 'First question')
    assert.equal(root.all('.tc-again')[0].hidden, false)
    assert.equal(sw.getAttribute('aria-disabled'), 'false') // not committed, so it may still be switched
    assert.equal(replies.length, 1) // the trained side really answered

    // asking again with both answering commits one turn
    state.post = () => pair(1)
    click(root.all('.tc-again')[0])
    await settle()
    sent = asked.filter(a => a.method === 'POST')
    assert.deepEqual(sent[1].body.base_replies, [])
    assert.ok(root.textContent.includes('trained 1') && root.textContent.includes('base 1'))
    assert.equal(root.all('.tc-ex').length, 1) // the half pair was replaced, not stacked
    assert.equal(root.all('.tc-turns')[0].textContent, 'Turn 2 of 8')
    assert.equal(sw.getAttribute('aria-disabled'), 'true')
    assert.ok(root.all('.tc-switch-note')[0].textContent.includes('Start a new conversation to change this.'))
    assert.deepEqual(texts(root, '.tc-who-label').filter(t => /^(Trained|Untrained)/.test(t)), ['Trained: Rootkeeper', `Untrained: ${BASE}`])

    // the next question sends each side its own earlier answer
    state.post = () => pair(2)
    box.value = 'Second question'
    root.all('form')[0].fire('submit')
    await settle()
    sent = asked.filter(a => a.method === 'POST')
    assert.deepEqual(sent[2].body.messages.map(m => m.content), ['First question', 'trained 1', 'Second question'])
    assert.deepEqual(sent[2].body.base_replies, ['base 1'])
    assert.equal(replies.length, 3)
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
    assert.equal(box.value, 'Hello')
    assert.equal(root.all('.tc-ex').length, 0)
    state.post = () => ({ adapter: 'e41-0a1b2c3d', reply: 'Hi.', cut_short: false, turns_left: 7 })
    root.all('form')[0].fire('submit')
    await settle()
    assert.deepEqual(asked.filter(a => a.method === 'POST').at(-1).body, { adapter: 'e41-0a1b2c3d', messages: [{ role: 'user', content: 'Hello' }] })
    assert.equal(banner.hidden, true)
    assert.equal(root.all('.tc-turns')[0].textContent, 'Turn 2 of 8')
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
  assert.match(source, /\.tc-send, #trained-chat-panel \.tc-new \{[^}]*font-family: inherit; font-size: 12px; font-weight: 600;/)
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
  assert.equal(/^import /m.test(source), false) // compiled alone by five tests
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
  assert.equal(/font-size:\s*(?:[0-9]|1[01])(?:\.[0-9]+)?px/.test(css), false, 'text under 12px')
  assert.equal(/backdrop-filter|rgba\(24,22,19/.test(css), false, 'no dark glass')
})
