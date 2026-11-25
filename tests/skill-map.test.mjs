// The skill map chart (src/entities/SkillMapChart.ts), the lesson panel
// (src/systems/LessonPanel.ts) and what both are drawn from
// (src/systems/skillMap.ts): the strict reading of the stored lesson, the
// pass bands, the words for every state, the chart's cost in draw calls and
// triangles, the panel drawn into a small fake page, and the source rules
// that keep both safe. No browser and no GPU: the geometry is real three.js,
// the canvas is a stub, and the fake page has just what the panel uses.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-skill-map-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')
const FILES = [
  'src/systems/skillMap.ts', 'src/systems/practiceBench.ts', 'src/systems/PracticeBenchPanel.ts', 'src/systems/paperTheme.ts', 'src/systems/LessonPanel.ts',
  'src/entities/SkillMapChart.ts', 'src/entities/PracticeBench.ts', 'src/scene/colors.ts',
]
for (const path of FILES) {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${specifier}.js'`)
  mkdirSync(dirname(join(build, path)), { recursive: true })
  writeFileSync(join(build, path.replace(/\.ts$/, '.js')), output)
}
{
  // The state manager reads import.meta.env (Vite); here it is empty.
  const path = 'src/api/StateManager.ts'
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8').replace(/import\.meta\.env\.DEV/g, 'false'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  mkdirSync(dirname(join(build, path)), { recursive: true })
  writeFileSync(join(build, path.replace(/\.ts$/, '.js')), output)
}
after(() => rmSync(build, { recursive: true, force: true }))
const load = path => import(pathToFileURL(join(build, path)).href)
const logic = await load('src/systems/skillMap.js')
const theme = await load('src/systems/paperTheme.js')
const { SkillMapChart } = await load('src/entities/SkillMapChart.js')
const { PracticeBench, BENCH_ANGLE_DEG, BENCH_RADIUS } = await load('src/entities/PracticeBench.js')
const { LessonPanel, lessonKey, teachingText } = await load('src/systems/LessonPanel.js')
const read = path => readFileSync(join(root, path), 'utf8')

// ---------------------------------------------------------------------------
// A lesson as the server sends it
// ---------------------------------------------------------------------------
const band = (p, t) => { const s = p / t; return s === 0 ? 0 : s < 0.25 ? 1 : s < 0.5 ? 2 : s < 0.75 ? 3 : s < 1 ? 4 : 5 }
const cell = (p, t = 6) => ({ passed: p, total: t, band: band(p, t) })
const SLUG = 'e41-0a1b2c3d'
function sub(name, b, a, over = {}) {
  return { name, before: b === null ? null : cell(b), after: a === null ? null : cell(a), seen_before: { passed: 3, total: 6 }, seen_after: a === null ? null : { passed: 5, total: 6 }, seen_only: false, got_worse: false, ...over }
}
function lesson(over = {}) {
  return {
    slug: SLUG, adapter: `lab/${SLUG}`, kind: 'tutor', epoch: 41, author_model: 'x-ai/grok-4.7', author_name: 'Grok 4.7', teacher_model: 'x-ai/grok-4.7', teacher_name: 'Grok 4.7',
    base_model: 'Qwen/Qwen3.5-4B', topic: 'Arithmetic habits', purpose: 'Careful sums', status: 'running', stage: 'diagnostic', round: 1, rounds: 1, live: true,
    questions: { practice: 12, held_back: 12, samples: 2 },
    subskills: [sub('Carrying digits', 2, null), sub('Reading the question', 3, null), sub('Units', null, null), sub('Checking', null, null)],
    overall: { before: null, after: null },
    progress: { graded: 24, to_grade: 48, taught: 0, to_teach: 0, seq: 3, updated_at: '2026-11-25T10:00:00.000Z' },
    teaching: null, examples: null, training: null,
    flags: { seen_only: false, too_easy: false, unanswered: 0, cut_short_before: false, rubric_literal: [], shared_literals: [], within_noise: false, reasons: [] },
    exchanges: [], cost: { tinker_estimated_usd: null, tinker_max_usd: 0.31, teacher_usd: 0, teacher_max_usd: 1, basis: 'an estimate, not a billed amount' },
    measured_by: logic.MEASURED_BY, origin: 'written by the models',
    created_at: '2026-11-25T09:00:00.000Z', finished_at: null, reason: null, ...over,
  }
}
const finished = (over = {}) => lesson({
  status: 'ok', stage: 'done', live: false, finished_at: '2026-11-25T11:00:00.000Z', talk: `lab/${SLUG}`,
  subskills: [sub('Carrying digits', 2, 5), sub('Reading the question', 3, 3), sub('Units', 1, 4, { seen_only: true }), sub('Checking', 4, 4)],
  overall: { before: cell(10, 24), after: cell(16, 24) },
  teaching: { missed: 1, taught: 1, solved: 1, explained: 0, teacher_failed: 1, leaked: 0, not_taught: 0, teacher_calls: 3 },
  examples: { kept: 6, guided: 4, answer: 5, explained: 2, left_out: 1, total: 17 },
  training: { steps_done: 8, steps_planned: 8, holdout_loss_before: 2.4311, holdout_loss_after: 1.2087 },
  exchanges: [{ subskill: 'Units', question: 'Round 3.456 to one place.', wrong: '3.4', guide: 'Which digit decides?', reply: 'The 5.', answer: '3.5', passed: true }],
  // as the server sends it (tinker-tutor.ts tutorFlags): the literal-rubric sentence is one of the reasons
  flags: { seen_only: true, too_easy: false, unanswered: 0, cut_short_before: false, rubric_literal: ['Units'], shared_literals: [], within_noise: false, reasons: ['it got better on questions used in teaching but hardly on held back ones', 'Units: every rule checks a fixed phrase, so a gain may be the phrase'] },
  cost: { tinker_estimated_usd: 0.04, tinker_max_usd: 0.31, teacher_usd: 0.07, teacher_max_usd: 1, basis: 'an estimate, not a billed amount' },
  ...over,
})
const state = l => logic.parseTutorLesson({ enabled: true, lesson: l })
const view = l => logic.chartView(state(l), false)

// ---------------------------------------------------------------------------
// The pass band and the words
// ---------------------------------------------------------------------------
test('the pass band comes from the share of answers that passed and nothing else', () => {
  for (const total of [6, 8, 12]) {
    const bands = Array.from({ length: total + 1 }, (_, p) => logic.bandOf(p, total))
    assert.equal(bands[0], 0)
    assert.equal(bands[total], 5)
    assert.deepEqual([...bands].sort((a, b) => a - b), bands, `monotone for ${total}`)
    for (let p = 0; p <= total; p++) {
      const s = p / total
      assert.equal(bands[p], s === 0 ? 0 : s < 0.25 ? 1 : s < 0.5 ? 2 : s < 0.75 ? 3 : s < 1 ? 4 : 5, `${p} of ${total}`)
    }
  }
  assert.deepEqual([[1, 6], [2, 6], [3, 6], [5, 6], [6, 6]].map(([p, t]) => logic.bandOf(p, t)), [1, 2, 3, 4, 5])
  assert.deepEqual([[1, 8], [2, 8], [6, 8]].map(([p, t]) => logic.bandOf(p, t)), [1, 2, 4]) // 2 of 8 is exactly 0.25, which is band 2; 6 of 8 is exactly 0.75, which is band 4
  assert.equal(logic.bandOf(0, 0), null)
})

test('a count is shown first and the band second, with no word for mastery anywhere', () => {
  assert.equal(logic.cellText('Before', cell(5)), 'Before: 5 of 6 answers passed. Pass band 4 of 5.')
  assert.equal(logic.cellText('After', null), 'After: not measured yet.')
  assert.equal(logic.bandsText(cell(2), cell(5)), '2 to 4')
  assert.equal(logic.bandsText(cell(2), null), '2')
  assert.equal(logic.bandsText(null, null), null)
  assert.equal(logic.withinNoise(cell(2), cell(2)), true) // a changed count in the same band
  assert.equal(logic.withinNoise(cell(2), cell(3)), false) // 2 of 6 is band 2 and 3 of 6 is band 3: a whole band
  assert.equal(logic.withinNoise(cell(1, 6), cell(2, 6)), false)
  assert.equal(logic.withinNoise(cell(2), null), false)
  for (const file of ['src/systems/skillMap.ts', 'src/systems/LessonPanel.ts', 'src/entities/SkillMapChart.ts']) {
    assert.doesNotMatch(read(file).replace(/^\s*\/\/.*$/gm, ''), /\bmaster(y|ed|s)?\b|can teach it/i, file)
  }
})

// ---------------------------------------------------------------------------
// Strict reading: a record that is not well formed leaves the chart dark
// ---------------------------------------------------------------------------
test('a well formed lesson is read, cleaned and kept', () => {
  const s = state(lesson({ topic: '  Arithmetic \u0007habits  ', talk: `lab/${SLUG}`, name: 'Steady Sums' }))
  assert.equal(s.enabled, true)
  assert.equal(s.lesson.slug, SLUG)
  assert.equal(s.lesson.adapter, `lab/${SLUG}`)
  assert.equal(s.lesson.topic, 'Arithmetic habits')
  assert.equal(s.lesson.name, 'Steady Sums')
  assert.equal(s.lesson.talk, `lab/${SLUG}`)
  assert.deepEqual(s.lesson.subskills[0].before, cell(2))
  assert.equal(s.lesson.subskills[2].before, null)
  assert.equal(logic.parseTutorLesson({ enabled: true, lesson: null }).lesson, null)
  assert.equal(logic.parseTutorLesson({ enabled: false, off_reason: 'TINKER_API_KEY is not set on this server' }).offReason, 'TINKER_API_KEY is not set on this server')
  // a long text is cut, and the chat id is only taken in its exact form
  assert.ok(state(lesson({ purpose: 'x'.repeat(500) })).lesson.purpose.length <= 200)
  assert.equal(state(lesson({ talk: 'lab/e41-ffffffff' })).lesson.talk, undefined)
  assert.equal(state(lesson({ talk: SLUG })).lesson.talk, undefined)
})

test('any malformed part leaves the lesson dark, and nothing is half read', () => {
  const bads = {
    'not an object': 'x', 'array': [],
    'slug': lesson({ slug: 'e41-XYZ' }), 'kind': lesson({ kind: 'rl' }), 'status': lesson({ status: 'lesson' }), 'stage': lesson({ stage: 'later' }),
    'round past rounds': lesson({ round: 2, rounds: 1 }), 'rounds': lesson({ rounds: 3 }), 'live not a boolean': lesson({ live: 'yes' }),
    'no topic': lesson({ topic: '   ' }), 'no teacher name': lesson({ teacher_name: undefined }),
    'measured_by changed': lesson({ measured_by: 'verified by the lab' }), 'origin changed': lesson({ origin: 'written by visitors' }),
    'too many subskills': lesson({ subskills: Array.from({ length: 11 }, (_, i) => sub(`S${i}`, 1, null)) }),
    'subskills not a list': lesson({ subskills: {} }),
    'cell with a band that is not the share': lesson({ subskills: [{ ...sub('A', 2, null), before: { passed: 2, total: 6, band: 5 } }] }),
    'cell with passed above total': lesson({ subskills: [{ ...sub('A', 2, null), before: { passed: 7, total: 6, band: 5 } }] }),
    'cell with a fraction': lesson({ subskills: [{ ...sub('A', 2, null), before: { passed: 2.5, total: 6, band: 3 } }] }),
    'cell with zero total': lesson({ subskills: [{ ...sub('A', 2, null), before: { passed: 0, total: 0, band: 0 } }] }),
    'cell as a string': lesson({ subskills: [{ ...sub('A', 2, null), after: '3 of 6' }] }),
    'overall cell malformed': lesson({ overall: { before: { passed: 1 }, after: null } }),
    'flag not a boolean': lesson({ subskills: [{ ...sub('A', 2, null), seen_only: 'no' }] }),
    'progress malformed': lesson({ progress: { graded: -1, to_grade: 5, taught: 0, to_teach: 0, seq: 1, updated_at: 'x' } }),
    'too many exchanges': lesson({ exchanges: Array.from({ length: 4 }, () => ({ subskill: 'a', question: 'q', wrong: '', guide: 'g', reply: '', answer: '', passed: false })) }),
    'cost without a cap': lesson({ cost: { tinker_estimated_usd: null, tinker_max_usd: 'x', teacher_usd: 0, teacher_max_usd: 1, basis: '' } }),
    'negative money': lesson({ cost: { tinker_estimated_usd: -1, tinker_max_usd: 1, teacher_usd: 0, teacher_max_usd: 1, basis: '' } }),
    'flags missing': lesson({ flags: undefined }),
  }
  for (const [name, raw] of Object.entries(bads)) {
    const s = logic.parseTutorLesson({ enabled: true, lesson: raw })
    assert.equal(s.lesson, null, name)
    const v = logic.chartView(s, false)
    assert.equal(v.mode, 'dark', name)
    assert.equal(v.lamp, false, name)
    assert.deepEqual(v.rows, [], name)
  }
  assert.equal(logic.parseTutorLesson(null), null)
  assert.equal(logic.parseTutorLesson('x'), null)
  assert.equal(logic.parseTutorLesson([]), null)
})

test('the full record and the questions are read as strictly', () => {
  const rec = logic.readLessonRecord({ ...lesson(), rubrics: [['a rule'], [], ['b rule', 'c rule'], []] })
  assert.deepEqual(rec.rubrics, [['a rule'], [], ['b rule', 'c rule'], []])
  assert.equal(rec.slug, SLUG)
  for (const bad of [{ ...lesson() }, { ...lesson(), rubrics: 'x' }, { ...lesson(), rubrics: [['ok', 3]] }, { ...lesson(), rubrics: [[]], status: 'nope' }, { ...lesson({ slug: 'bad' }), rubrics: [] }]) {
    assert.equal(logic.readLessonRecord(bad), null, JSON.stringify(bad).slice(0, 60))
  }
  const q = { questions: [{ held_back: true, prompt: 'What is 2 plus 2?', answers: { before: [{ text: '5', passed: false }], after: [{ text: '4', passed: true }] }, turns: [{ kind: 'guide', state: 'graded', teacher: 'What is 2?', reply: '2', answer: '4', passed: true }] }] }
  assert.equal(logic.readLessonQuestions(q).questions[0].turns[0].kind, 'guide')
  for (const bad of [null, {}, { questions: 'x' }, { questions: [{ held_back: 'y', prompt: 'p', answers: { before: [], after: [] }, turns: [] }] },
    { questions: [{ held_back: true, prompt: '', answers: { before: [], after: [] }, turns: [] }] },
    { questions: [{ held_back: true, prompt: 'p', answers: { before: [{ text: 'a' }], after: [] }, turns: [] }] },
    { questions: [{ held_back: true, prompt: 'p', answers: { before: [], after: [] }, turns: [{ kind: 'shout', state: 'x', teacher: '', reply: '', answer: '', passed: true }] }] }]) {
    assert.equal(logic.readLessonQuestions(bad), null, JSON.stringify(bad).slice(0, 70))
  }
})

// ---------------------------------------------------------------------------
// What the chart shows in each state of spec 1.11
// ---------------------------------------------------------------------------
test('the chart has a words and a lamp for every state, and the lamp is lit only while the lesson is live', () => {
  const nothing = logic.chartView(null, false)
  assert.deepEqual([nothing.mode, nothing.title, nothing.lamp], ['dark', 'No lesson has been taught yet.', false])
  assert.equal(logic.chartView({ enabled: false, offReason: 'x', lesson: null }, false).title, 'No lesson has been taught yet.')
  assert.equal(logic.chartView(state(lesson()), true).title, 'No experiment is connected.') // a simulation: blank, dark, even with a lesson in hand
  assert.equal(logic.chartView(state(lesson()), true).lamp, false)

  const d = view(lesson())
  assert.deepEqual([d.mode, d.stageLine, d.lamp], ['diagnostic', 'Testing the untrained model. 24 of 48 answers graded.', true])
  assert.deepEqual(d.rows.map(r => [r.name, r.bands]), [['Carrying digits', '2'], ['Reading the question', '3'], ['Units', null], ['Checking', null]])
  assert.equal(d.byline, 'Topic and row names by Grok 4.7, who also taught. Epoch 41.')
  assert.equal(d.title, 'Arithmetic habits')
  assert.equal(view(lesson({ live: false })).lamp, false) // open but between slices: the last stage line, a dark lamp
  assert.equal(view(lesson({ live: false })).stageLine, d.stageLine)

  const t = view(lesson({ stage: 'teaching', progress: { graded: 48, to_grade: 48, taught: 3, to_teach: 7, seq: 9, updated_at: 'x' } }))
  assert.deepEqual([t.mode, t.stageLine], ['teaching', 'Teaching. 3 of 7 missed questions done.'])
  assert.equal(view(lesson({ stage: 'training' })).stageLine, 'Training on the lesson.')
  const r = view(lesson({ stage: 'retest', progress: { graded: 10, to_grade: 96, taught: 7, to_teach: 7, seq: 30, updated_at: 'x' } }))
  assert.deepEqual([r.mode, r.stageLine], ['retest', 'Testing the trained model. 10 of 96 answers graded.'])
  assert.equal(view(lesson({ stage: 'closing' })).mode, 'closing')
  assert.equal(view(lesson({ stage: 'done' })).mode, 'closing')

  const ok = view(finished())
  assert.deepEqual([ok.mode, ok.stageLine, ok.lamp, ok.flagNote], ['ok', 'Finished. Pass bands come from questions held back from teaching.', false, 'Flag: better only on questions seen in teaching.'])
  assert.deepEqual(ok.rows.map(r => r.bands), ['2 to 4', '3 to 3', '1 to 3', '3 to 3'])
  assert.deepEqual(ok.rows.map(r => r.seenOnly), [false, false, true, false])
  assert.equal(view(finished({ flags: { ...finished().flags, seen_only: false } })).flagNote, null)

  const ended = view(lesson({ status: 'ended', stage: 'done', live: false, reason: 'the untrained model passed every practice question, so there was nothing to teach' }))
  assert.deepEqual([ended.mode, ended.stageLine, ended.lamp], ['ended', 'Finished without training. The untrained model passed every practice question, so there was nothing to teach.', false])
  for (const status of ['failed', 'error']) {
    const f = view(lesson({ status, stage: 'teaching', live: false, reason: 'the lesson did not finish in 6 hours' }))
    assert.deepEqual([f.mode, f.stageLine, f.lamp], ['failed', 'The lesson stopped. The lesson did not finish in 6 hours.', false])
  }
  assert.equal(view(lesson({ status: 'failed', reason: null })).stageLine, 'The lesson stopped.')
  // a finished lesson never claims to be live, even if the record says so
  assert.equal(view(finished({ live: true })).lamp, false)
})

test('the chart redraws on a change of what it shows and on nothing else', () => {
  const a = view(lesson())
  assert.equal(a.key, view(lesson()).key)
  assert.equal(a.key, view(lesson({ created_at: '2026-11-26T00:00:00.000Z', cost: { ...lesson().cost, teacher_usd: 0.5 } })).key) // a figure the paper does not show
  for (const changed of [
    lesson({ progress: { ...lesson().progress, seq: 4 } }),
    lesson({ live: false }), lesson({ stage: 'teaching' }), lesson({ topic: 'Other' }),
    lesson({ subskills: [sub('Carrying digits', 3, null), ...lesson().subskills.slice(1)] }),
  ]) assert.notEqual(view(changed).key, a.key)
})

test('the chart hangs where the bench stands and its camera target lifts to include it', () => {
  assert.ok(logic.CHART_CENTER_Y > 1.5 + 0.12 + 0.3 && logic.CHART_CENTER_Y < 2.4) // above the bench's back board
  const v = logic.lessonCameraView({ position: [1, 4, 2], target: [3, 1, 4] })
  assert.deepEqual(v, { position: [1, 4, 2], target: [3, logic.CHART_TARGET_Y, 4] })
  assert.ok(logic.CHART_TARGET_Y > 1)
})

// ---------------------------------------------------------------------------
// The chart as an object: cost, placement, redraws, nothing that moves
// ---------------------------------------------------------------------------
const written = []
let draws = 0
const context = new Proxy({}, {
  get: (target, name) => {
    if (name === 'fillText') return t => { written.push(String(t)) }
    if (name === 'fillRect') return () => { draws++ }
    if (name === 'measureText') return t => ({ width: String(t).length * 9 })
    if (name === 'createLinearGradient') return () => ({ addColorStop() {} })
    return typeof target[name] === 'undefined' ? () => {} : target[name]
  },
  set: (target, name, value) => { target[name] = value; return true },
})
const savedDocument = globalThis.document
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context, style: {} }) }
after(() => { globalThis.document = savedDocument })

test('the chart costs 3 draw calls and about 100 triangles, in every state', () => {
  const chart = new SkillMapChart()
  const s = chart.stats()
  assert.deepEqual(s.drawCalls, 3)
  assert.ok(s.triangles > 60 && s.triangles <= 120, `triangles ${s.triangles}`)
  chart.setLesson(state(finished()), false)
  chart.update(0)
  assert.deepEqual(chart.stats(), s) // the cost does not depend on what it shows
  assert.deepEqual(chart.group.userData.inspect, { kind: 'lesson' })
  // it hangs on the same ray as the bench, with the same turn, against the wall behind it
  const bench = new PracticeBench(BENCH_ANGLE_DEG, BENCH_RADIUS)
  assert.deepEqual(chart.group.position.toArray(), bench.group.position.toArray())
  assert.equal(chart.group.rotation.y, bench.group.rotation.y)
  chart.dispose()
  bench.dispose()
})

test('the paper says what the record says and the lamp follows the record only', () => {
  const chart = new SkillMapChart()
  const lampColor = () => chart.lampMat.color.getHex()
  chart.update(0)
  assert.ok(written.includes('No experiment is connected.'))
  const off = lampColor()
  written.length = 0
  chart.setLesson(state(lesson()), false)
  chart.update(0)
  assert.ok(written.includes('Arithmetic habits'))
  assert.ok(written.includes('Topic and row names by Grok 4.7, who also taught. Epoch 41.'))
  assert.ok(written.includes('Testing the untrained model. 24 of 48 answers graded.'))
  assert.ok(written.includes(logic.CHART_FOOT))
  assert.ok(written.includes('2') && written.includes('3'))
  assert.notEqual(lampColor(), off) // live: lit
  const lit = lampColor()
  chart.update(0.016); chart.update(0.016)
  assert.equal(lampColor(), lit) // steady: it never blinks or pulses
  written.length = 0
  chart.setLesson(state(finished()), false)
  chart.update(0)
  assert.equal(lampColor(), off)
  assert.ok(written.includes('Flag: better only on questions seen in teaching.'))
  assert.ok(written.includes('2 to 4') && written.includes('1 to 3'))
  assert.ok(written.includes(logic.CHART_FOOT))
  // each row has its own name, and a long stage line is kept to the paper
  chart.setLesson(state(lesson({ status: 'failed', live: false, reason: 'x '.repeat(200) })), false)
  chart.update(0)
  chart.dispose()
})

test('the paper is redrawn only when the record changes, and nothing moves in between', () => {
  const chart = new SkillMapChart()
  chart.setLesson(state(lesson()), false)
  chart.update(0)
  const before = draws
  for (let i = 0; i < 20; i++) chart.update(1 / 60)
  chart.setLesson(state(lesson()), false) // the same record again
  chart.update(1 / 60)
  assert.equal(draws, before)
  chart.setLesson(state(lesson({ progress: { ...lesson().progress, seq: 4 } })), false)
  chart.update(1 / 60)
  assert.ok(draws > before)
  // the position and the turn of the group never change from frame to frame
  const p = chart.group.position.toArray()
  const r = chart.group.rotation.y
  for (let i = 0; i < 5; i++) chart.update(1)
  assert.deepEqual([chart.group.position.toArray(), chart.group.rotation.y], [p, r])
  const src = read('src/entities/SkillMapChart.ts')
  assert.doesNotMatch(src, /setInterval|setTimeout|requestAnimationFrame|Math\.random|Date\.now/)
  chart.dispose()
})

test('a ten subskill lesson with long names fits the paper: names are cut, never the rows', () => {
  const chart = new SkillMapChart()
  const names = Array.from({ length: 10 }, (_, i) => `Subskill number ${i + 1} with a name that is far too long to fit`.slice(0, 40))
  const l = finished({ subskills: names.map((n, i) => sub(n, (i % 5) + 1, Math.min(6, (i % 5) + 2))) })
  written.length = 0
  chart.setLesson(state(l), false)
  chart.update(0)
  assert.equal(chart.current.rows.length, 10)
  assert.ok(written.filter(t => t.endsWith('…')).length >= 1)
  chart.dispose()
})

// ---------------------------------------------------------------------------
// The panel, in a small fake page
// ---------------------------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.handlers = {}; this.parent = null
    this._text = ''; this.className = ''; this.disabled = false; this.inert = false; this.tabIndex = 0; this.scrollTop = 0; this.id = ''
    this.classList = {
      add: c => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); s.add(c); this.className = [...s].join(' ') },
      remove: c => { this.className = this.className.split(/\s+/).filter(x => x && x !== c).join(' ') },
    }
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join('') }
  set textContent(v) { this._text = String(v); this.children = [] }
  appendChild(c) { c.parent = this; this.children.push(c); return c }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? Object.assign(new El('#text'), { _text: c }) : c) }
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
  all(sel, out = []) {
    for (const c of this.children) {
      // the panel's focusable list: every button that is not disabled
      const hit = sel.startsWith('button:not') ? c.tagName === 'BUTTON' && !c.disabled : c.matches(sel)
      if (hit) out.push(c)
      c.all(sel, out)
    }
    return out
  }
  querySelectorAll(sel) { return this.all(sel) }
  querySelector(sel) { return this.all(sel)[0] ?? null }
  getClientRects() { return [1] }
  fire(type, event = {}) { for (const fn of this.handlers[type] ?? []) fn({ preventDefault() {}, target: this, ...event }) }
}
class TextNode extends El { constructor(t) { super('#text'); this._text = t } }

async function withPage(run, { record, questions, failRecord = false } = {}) {
  const saved = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement }
  globalThis.HTMLElement = El
  const body = new El('body')
  const keyHandlers = []
  const doc = {
    createElement: t => new El(t), createTextNode: t => new TextNode(t), body, activeElement: null,
    addEventListener: (type, fn) => { if (type === 'keydown') keyHandlers.push(fn) },
    removeEventListener: (type, fn) => { const i = keyHandlers.indexOf(fn); if (i >= 0) keyHandlers.splice(i, 1) },
  }
  globalThis.document = doc
  globalThis.window = { matchMedia: () => ({ matches: false }) }
  const asked = []
  const fetchStub = async url => {
    asked.push(String(url))
    const u = new URL(String(url), 'http://x')
    if (u.searchParams.has('subskill')) return new Response(JSON.stringify(questions ?? { questions: [] }), { status: 200 })
    if (failRecord) return new Response('{}', { status: 500 })
    return new Response(JSON.stringify(record ?? { ...finished(), rubrics: [['contains: the last line has the number (weight 1)'], [], [], []] }), { status: 200 })
  }
  const settle = () => new Promise(r => setTimeout(r, 10))
  const press = (key, extra = {}) => { for (const fn of [...keyHandlers]) fn({ key, preventDefault() {}, target: doc.activeElement ?? body, ...extra }) }
  try { return await run({ body, asked, fetchStub, settle, press, keyHandlers }) } finally {
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.HTMLElement = saved.HTMLElement
  }
}
const box = body => body.children.find(c => c.id === 'lesson-panel-container')
const texts = (root, sel) => root.all(sel).map(e => e.textContent)

test('the panel asks for nothing until it is opened, then reads the full record once', async () => {
  await withPage(async ({ body, asked, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    await settle()
    assert.deepEqual(asked, [])
    p.show()
    await settle()
    assert.deepEqual(asked, [`/api/experiment/lesson?slug=${SLUG}`])
    const panel = box(body).children.find(c => c.id === 'lesson-panel')
    assert.equal(panel.attrs.role, 'dialog')
    assert.equal(panel.attrs['aria-modal'], 'true')
    assert.equal(panel.attrs['aria-label'], 'The Lesson')
    const all = panel.textContent
    for (const want of [
      'Arithmetic habits', 'Epoch 41. Written by Grok 4.7. Taught by Grok 4.7. Student: Qwen/Qwen3.5-4B.', 'Skill Map', 'How It Was Graded', 'Teaching', 'Training', 'Cost', 'The Trained Model', 'The lab noticed',
      'Before: 2 of 6 answers passed. Pass band 2 of 5.', 'After: 5 of 6 answers passed. Pass band 4 of 5.', 'Pass bands: 2 to 4.', 'After: 4 of 6 answers passed. Pass band 3 of 5.',
      'Within noise.', 'Held back answers passed, all subskills: 10 of 24 before, 16 of 24 after.',
      logic.TUTOR_MEASURE_NOTE, logic.BANDS_NOTE, 'contains: the last line has the number (weight 1)',
      'Units: every rule checks a fixed phrase, so a gain may be the phrase.',
      '17 training examples: 6 kept as they were, 4 with the guiding questions, 5 direct answers, 2 explained by the teacher. 1 left out.',
      'Loss on examples the lab held out: 2.43 before, 1.21 after. Lower is better.',
      'Tinker use: about $0.04, estimated from published prices. At most $0.31 was set aside.', "The teacher: $0.07, as OpenRouter reported it. The cap was $1.00.",
      'The teacher asked', 'It answered again', 'The teacher\'s questions and the replies were written by models. Nobody reviewed them.',
    ]) assert.ok(all.includes(want), want)
    assert.equal(all.split('every rule checks a fixed phrase').length - 1, 1, 'each flag sentence is shown once')
    // only the stage line is a live region: a redraw does not announce the whole record again
    const status = body.all('.lp-status')
    assert.equal(status.length, 1)
    assert.equal(status[0].attrs['aria-live'], 'polite')
    assert.equal(body.all('.lp-body')[0].attrs['aria-live'], undefined)
    assert.doesNotMatch(all, /[–—]/)
  })
})

test('Talk to It is there only when the record has the chat id, and it opens the chat on that adapter', async () => {
  await withPage(async ({ body, fetchStub, settle }) => {
    const talked = []
    const p = new LessonPanel(id => talked.push(id), { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    p.show()
    await settle()
    const button = body.all('.lp-talk')[0]
    assert.equal(button.textContent, 'Talk to It')
    button.fire('click')
    assert.deepEqual(talked, [`lab/${SLUG}`])
    assert.equal(p.open, false) // the chat takes over
    // no chat id: no button
    p.setLesson(state(finished({ talk: undefined })), false)
    p.show()
    await settle()
    assert.equal(body.all('.lp-talk').length, 0)
    p.close()
  })
})

test('opening a row reads that subskill\'s questions, and every graded answer shows its mark as text', async () => {
  const questions = { questions: [
    { held_back: true, prompt: 'What is 128 plus 395?', answers: { before: [{ text: '513', passed: false }], after: [{ text: '<img src=x onerror=alert(1)>', passed: true }] }, turns: [] },
    { held_back: false, prompt: 'What is 3 minus 8?', answers: { before: [{ text: '5', passed: false }], after: [{ text: '5', passed: false }] }, turns: [
      { kind: 'guide', state: 'leaked', teacher: '', reply: '', answer: '', passed: false }, { kind: 'explain', state: 'explained', teacher: 'Below zero.', reply: '', answer: 'It is minus 5.', passed: true }] },
  ] }
  await withPage(async ({ body, asked, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    p.show()
    await settle()
    const rows = body.all('.lp-row')
    assert.equal(rows.length, 4)
    assert.equal(rows[0].attrs['aria-expanded'], 'false')
    rows[0].fire('click')
    await settle()
    assert.ok(asked.includes(`/api/experiment/lesson?slug=${SLUG}&subskill=0`))
    assert.equal(body.all('.lp-row')[0].attrs['aria-expanded'], 'true')
    const detail = body.all('.lp-detail')[0].textContent
    for (const want of ['Held back question', 'Practice question', 'What is 128 plus 395?', 'Before, answer 1: 513', 'Did not pass', 'Passed', '<img src=x onerror=alert(1)>',
      'The question was left out because it gave away a value the rules look for.', 'The teacher explained', 'Below zero.', "The teacher's answer"]) assert.ok(detail.includes(want), want)
    assert.equal(body.all('img').length, 0)
    body.all('.lp-row')[0].fire('click')
    assert.equal(body.all('.lp-detail').length, 0)
    p.close()
  }, { questions })
})

test('a record that cannot be read is said so, with Try Again, and what the room knew is still shown', async () => {
  await withPage(async ({ body, asked, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    p.show()
    await settle()
    const all = box(body).textContent
    assert.ok(all.includes('The full record could not be loaded.'))
    assert.ok(all.includes('Arithmetic habits'))
    assert.deepEqual(texts(body, '.lp-again'), ['Try Again'])
    p.close()
  }, { failRecord: true })
  await withPage(async ({ body, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    p.show()
    await settle()
    assert.ok(box(body).textContent.includes('The full record could not be loaded.')) // a record for another lesson is not shown
    p.close()
  }, { record: { ...finished({ slug: 'e42-0a1b2c3d' }), rubrics: [] } })
})

test('with no lesson or no experiment the panel says so, and asks for nothing', async () => {
  await withPage(async ({ body, asked, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(null, true)
    p.show()
    await settle()
    assert.ok(box(body).textContent.includes('No experiment is connected. The chart stays blank: nothing on it is model work.'))
    p.setLesson({ enabled: false, offReason: 'TINKER_API_KEY is not set on this server', lesson: null }, false)
    assert.ok(box(body).textContent.includes('No lesson has been taught yet.'))
    assert.ok(box(body).textContent.includes('Lessons are off here: TINKER_API_KEY is not set on this server.'))
    p.setLesson({ enabled: true, offReason: null, lesson: null }, false)
    assert.ok(box(body).textContent.includes('When a model asks for a Socratic lesson'))
    assert.deepEqual(asked, [])
    p.close()
  })
})

test('a new record while the panel is open is read again, once, and not otherwise', async () => {
  await withPage(async ({ asked, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(lesson()), false)
    p.show()
    await settle()
    assert.equal(asked.length, 1)
    p.setLesson(state(lesson()), false) // the same record
    await settle()
    assert.equal(asked.length, 1)
    p.setLesson(state(lesson({ progress: { ...lesson().progress, seq: 4 } })), false)
    await settle()
    assert.equal(asked.length, 2)
    assert.equal(lessonKey(null), '')
    assert.notEqual(lessonKey(lesson().seq), lessonKey(lesson()))
    p.close()
  })
})

test('the panel is modal: the page is inert behind it, Tab stays inside, Escape closes and focus goes back', async () => {
  await withPage(async ({ body, fetchStub, settle, press, keyHandlers }) => {
    const other = new El('div')
    body.appendChild(other)
    const opener = new El('button')
    body.appendChild(opener)
    opener.focus()
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    p.show()
    await settle()
    assert.equal(other.inert, true)
    assert.equal(opener.inert, true)
    assert.equal(keyHandlers.length, 1)
    const panel = body.children.find(c => c.id === 'lesson-panel-container').children.find(c => c.id === 'lesson-panel')
    const focusable = panel.all('button:not([disabled])')
    assert.equal(document.activeElement, focusable[0]) // the close button first
    // Tab from the last control goes to the first; Shift+Tab from the first goes to the last
    focusable[focusable.length - 1].focus()
    press('Tab')
    assert.equal(document.activeElement, focusable[0])
    press('Tab', { shiftKey: true })
    assert.equal(document.activeElement, focusable[focusable.length - 1])
    // focus that has left the panel is brought back
    opener.focus()
    press('Tab')
    assert.equal(document.activeElement, focusable[0])
    press('Escape')
    assert.equal(p.open, false)
    assert.equal(other.inert, false)
    assert.equal(opener.inert, false)
    assert.equal(keyHandlers.length, 0)
    assert.equal(document.activeElement, opener)
    p.show()
    p.dispose()
    assert.equal(keyHandlers.length, 0)
  })
})

test('the teaching counts read as plain sentences with the right number', () => {
  assert.equal(teachingText({ missed: 9, taught: 7, solved: 4, explained: 2, teacher_failed: 1 }), "9 practice questions were missed. 7 were taught. 4 were solved after guiding questions. 2 needed the teacher to explain. 1 time the teacher's own answer did not pass.")
  assert.equal(teachingText({ missed: 1, taught: 1, solved: 1, explained: 0, teacher_failed: 0 }), "1 practice question was missed. 1 was taught. 1 was solved after guiding questions. 0 needed the teacher to explain. 0 times the teacher's own answer did not pass.")
})

// ---------------------------------------------------------------------------
// Source rules
// ---------------------------------------------------------------------------
test('server text is only ever written as text, nothing is faked with a timer, and no dash is in what a visitor reads', () => {
  for (const file of ['src/systems/skillMap.ts', 'src/systems/LessonPanel.ts', 'src/entities/SkillMapChart.ts']) {
    const src = read(file)
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, file)
    assert.doesNotMatch(src, /[–—]/, `${file} has an en or em dash`)
  }
  for (const file of ['src/systems/LessonPanel.ts', 'src/entities/SkillMapChart.ts']) {
    assert.doesNotMatch(read(file), /setInterval|requestAnimationFrame/, file)
  }
  assert.doesNotMatch(read('src/systems/skillMap.ts'), /^import .*api\//m)
})

test('the panel takes its look from the shared paper theme: no hex colour of its own, type of 13px or more', () => {
  const css = read('src/systems/LessonPanel.ts')
  assert.doesNotMatch(css.replace(/^\s*\/\/.*$/gm, ''), /#[0-9a-fA-F]{3,8}\b/)
  assert.match(css, /installPaperTheme\(\)/)
  const sizes = [...css.matchAll(/font-size: (\d+)px/g)].map(m => Number(m[1]))
  assert.ok(sizes.length > 0 && sizes.every(n => n >= 13), sizes.join(','))
  // the chart's paper takes every colour from the theme's roles; the frame from the room's palette
  const chart = read('src/entities/SkillMapChart.ts')
  assert.doesNotMatch(chart.replace(/^\s*\/\/.*$/gm, '').replace(/0x3a2523/, ''), /#[0-9a-fA-F]{3,8}\b/)
  const fonts = [...chart.matchAll(/(\d+)px (Georgia|"Courier New")/g)].map(m => Number(m[1]))
  assert.ok(fonts.every(n => n >= 22), `chart fonts ${fonts.join(',')} (canvas pixels on a 1024 wide sheet that is 1 m wide)`)
  assert.ok(theme.PAPER_TOKENS['--paper-brass'])
})

test('every visitor string is written in plain English: Title Case buttons, no em or en dash, the one shared measure note', () => {
  const src = read('src/systems/LessonPanel.ts')
  for (const label of ['Talk to It', 'Try Again', 'The Lesson', 'Skill Map', 'How It Was Graded', 'The Trained Model']) assert.ok(src.includes(`'${label}'`), label)
  assert.equal(logic.TUTOR_MEASURE_NOTE, 'The lab counts which answers pass. The rules, the questions and the teaching text were written by models, and a model approved the rules. Nobody has checked that the rules measure the skill.')
  assert.equal(logic.CHART_FOOT, 'Held back questions only. Rules written by a model. Counted by the lab.')
  // every constant sentence ends in a full stop
  for (const s of [logic.NO_LESSON, logic.CHART_FOOT, logic.BANDS_NOTE, logic.TUTOR_MEASURE_NOTE]) assert.match(s, /\.$/)
})

test('a lesson that moves between epochs reaches the chart and the panel at the next poll', async () => {
  const { StateManager } = await load('src/api/StateManager.js')
  const base = { current_epoch: 41, epoch_in_progress: false, status: 'running', current_spec: { meta: { stability_score: 0.5 } } }
  let answer = { ...base, tutor_lesson: { enabled: true, lesson: lesson({ stage: 'teaching', live: true }) } }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(answer)) })
  try {
    const states = [], records = []
    const m = new StateManager({ onStateUpdate: s => states.push(s), onRecordUpdate: s => records.push(s) })
    await m.fetchState()
    assert.equal(states.length, 1)
    // the same epoch, the same lesson: nothing is told
    await m.fetchState()
    assert.equal(states.length + records.length, 1)
    // the same epoch, the lesson finished: the record views are told, the epoch views are not
    answer = { ...base, tutor_lesson: { enabled: true, lesson: finished() } }
    await m.fetchState()
    assert.equal(states.length, 1)
    assert.equal(records.length, 1)
    const chart = state(records[0].tutor_lesson.lesson)
    assert.equal(chart.lesson.status, 'ok')
    assert.equal(logic.chartView(chart, false).lamp, false, 'a finished lesson leaves the lamp dark')
    // a practice run moving is seen the same way
    answer = { ...answer, rl_practice: { slug: 'x' } }
    await m.fetchState()
    assert.equal(records.length, 2)
  } finally {
    globalThis.fetch = realFetch
  }
  // and main.ts sends those records to the chart and the panel
  const main = read('src/main.ts')
  assert.match(main, /onRecordUpdate: \(state\) => this\.applySideRecords\(state\)/)
  assert.match(main, /private applySideRecords[\s\S]{0,800}this\.skillMap\?\.setLesson\(lesson, false\)[\s\S]{0,80}this\.lessonPanel\?\.setLesson\(lesson, false\)/)
})

test('a cut off or empty answer is marked as such, and the finished chart names cut offs and noise in its corner note', () => {
  assert.equal(logic.answerMark({ passed: true, cut_short: false, empty: false }), 'Passed')
  assert.equal(logic.answerMark({ passed: false, cut_short: true, empty: false }), 'Did not pass. Cut off by the token limit')
  assert.equal(logic.answerMark({ passed: false, cut_short: false, empty: true }), 'Did not pass. No answer text')
  assert.equal(logic.answerMark({ passed: false, cut_short: false, empty: false }), 'Did not pass')
  const f = over => finished({ flags: { ...finished().flags, seen_only: false, ...over } })
  assert.equal(view(f({ cut_short_before: true })).flagNote, 'Flag: many answers were cut off by the token limit.')
  assert.equal(view(f({ seen_only: true, cut_off_fell: true })).flagNote, 'Flag: better only on questions seen in teaching, and cut off answers.')
  assert.equal(view(f({ seen_only: true })).flagNote, 'Flag: better only on questions seen in teaching.')
  assert.equal(view(f({ within_noise: true })).flagNote, 'Within noise: the change is smaller than one pass band.')
  assert.equal(view(f({})).flagNote, null)
  // the counts are read when present and left out when malformed
  const read = state(f({ cut_off: { before: { cut: 3, empty: 1, graded: 48 }, after: { cut: 9, empty: 0, graded: 4 } } })).lesson.flags.cut_off
  assert.deepEqual(read, { before: { cut: 3, empty: 1, graded: 48 }, after: null })
  // the answers of a question say how each ended
  const q = logic.readLessonQuestions({ questions: [{ held_back: true, prompt: 'p', answers: { before: [{ text: '', passed: false, cut_short: true, empty: false }], after: [] }, turns: [] }] })
  assert.deepEqual(q.questions[0].answers.before[0], { text: '', passed: false, cut_short: true, empty: false })
})

test('the lesson can be opened from the page, not only by aiming at the chart: an About button that keyboard and touch reach', () => {
  const ui = read('src/systems/UIOverlay.ts')
  assert.match(ui, /<button type="button" class="info-bench-button" id="info-lesson-button">Open the Lesson<\/button>/)
  assert.match(ui, /querySelector\('#info-lesson-button'\)\?\.addEventListener\('click', \(\) => this\.onOpenLesson\?\.\(\)\)/)
  assert.match(ui, /The framed sheet on the wall above the bench is the skill map of the newest Socratic lesson/)
  assert.match(read('src/main.ts'), /this\.uiOverlay\.onOpenLesson = \(\) => this\.lessonPanel\?\.show\(\)/)
})

// ---------------------------------------------------------------------------
// The second review: a reader keeps their place, and model text is labelled
// ---------------------------------------------------------------------------
const turnQuestions = { questions: [
  { held_back: false, prompt: 'What is 3 minus 8?', answers: { before: [{ text: '5', passed: false }], after: [{ text: 'minus 5', passed: true }] }, turns: [
    { kind: 'guide', state: 'graded', teacher: 'Which number is larger?', reply: 'Let me think about the', answer: 'It is 5 because', passed: false, reply_cut_short: true, answer_cut_short: true },
    { kind: 'guide', state: 'graded', teacher: 'What is below zero?', reply: 'A negative number.', answer: 'minus 5', passed: true },
  ] },
] }

test('a change in the lesson while a row is open never empties the row or moves the reader: the answers stay until the new ones arrive, and focus comes back without scrolling', async () => {
  const focusCalls = []
  const realFocus = El.prototype.focus
  El.prototype.focus = function (options) { focusCalls.push({ cls: this.className, options }); realFocus.call(this) }
  try {
    await withPage(async ({ body, asked, fetchStub, settle }) => {
      // the fetches of the test are held back until released, so the page can be read while they are on their way
      let release = () => {}
      let hold = false
      const slow = async url => { if (hold) await new Promise(r => { release = r }); return fetchStub(url) }
      const p = new LessonPanel(() => {}, { fetch: slow })
      const open = lesson({ stage: 'teaching', teaching: { missed: 2, taught: 1, solved: 0, explained: 0, teacher_failed: 0, leaked: 0, not_taught: 0, teacher_calls: 2 } })
      p.setLesson(state(open), false)
      p.show()
      await settle()
      body.all('.lp-row')[0].fire('click')
      await settle()
      assert.ok(body.all('.lp-detail')[0].textContent.includes('Which number is larger?'))
      // the reader's focus is on the open row, and they have scrolled down to its answers
      body.all('.lp-row')[0].focus()
      const scroller = body.all('.lp-body')[0]
      scroller.scrollTop = 861
      const before = asked.length
      focusCalls.length = 0
      hold = true
      // the next poll: the lesson moved on (a new progress record)
      p.setLesson(state(lesson({ ...open, progress: { ...open.progress, seq: 4, taught: 1, to_teach: 2 } })), false)
      // while the new record is on its way the open row still shows its answers
      assert.equal(body.all('.lp-detail')[0].textContent.includes('Loading the questions.'), false, 'the open row was emptied')
      assert.ok(body.all('.lp-detail')[0].textContent.includes('Which number is larger?'))
      assert.equal(scroller.scrollTop, 861)
      assert.equal(document.activeElement, body.all('.lp-row')[0], 'focus is on the same row')
      assert.ok(focusCalls.length > 0 && focusCalls.every(c => c.options?.preventScroll === true), `focus was put back with scrolling: ${JSON.stringify(focusCalls)}`)
      hold = false
      release()
      await settle()
      release()
      await settle()
      assert.deepEqual(asked.slice(before), [`/api/experiment/lesson?slug=${SLUG}`, `/api/experiment/lesson?slug=${SLUG}&subskill=0`], 'the record and the open row are read once each')
      assert.ok(body.all('.lp-detail')[0].textContent.includes('Which number is larger?'))
      assert.equal(scroller.scrollTop, 861)
      p.close()
    }, { questions: turnQuestions, record: { ...lesson({ stage: 'teaching' }), rubrics: [[], [], [], []] } })
  } finally {
    El.prototype.focus = realFocus
  }
})

test('the same record again redraws nothing, in the lesson panel and in the practice bench panel, so focus inside either is kept', async () => {
  await withPage(async ({ body, asked, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    p.show()
    await settle()
    const talk = body.all('.lp-talk')[0]
    talk.focus()
    const nodes = [...body.all('.lp-body')[0].children]
    // only the practice record changed: the room hands the lesson panel the same lesson again
    p.setLesson(state(finished()), false)
    p.setLesson(state(finished()), false)
    await settle()
    assert.deepEqual(body.all('.lp-body')[0].children, nodes, 'the body was rebuilt')
    assert.equal(document.activeElement, talk)
    assert.equal(asked.length, 1)
    // a real change redraws, and focus goes back to the same control, not to the page
    p.setLesson(state(finished({ reason: 'round 2 did not run: the trained model passed every practice question' })), false)
    await settle()
    assert.notEqual(body.all('.lp-talk')[0], talk)
    assert.equal(document.activeElement, body.all('.lp-talk')[0], 'focus is on Talk to It again')
    p.close()
  })
  const { PracticeBenchPanel } = await load('src/systems/PracticeBenchPanel.js')
  await withPage(async ({ body }) => {
    const panel = new PracticeBenchPanel(() => {})
    panel.setPractice(null, false)
    panel.show()
    const shown = [...body.all('.pb-body')[0].children]
    panel.setPractice(null, false)
    assert.deepEqual(body.all('.pb-body')[0].children, shown, 'the same record again must not rebuild the body')
    panel.setPractice({ enabled: false, offReason: 'off here', run: null }, false)
    assert.notDeepEqual(body.all('.pb-body')[0].children, shown)
    panel.close()
  })
  // the helper both panels use puts focus back on the same control without scrolling
  const src = read('src/systems/paperTheme.ts')
  assert.match(src, /again\?\.focus\?\.\(\{ preventScroll: true \}\)/)
  for (const file of ['src/systems/LessonPanel.ts', 'src/systems/PracticeBenchPanel.ts']) assert.match(read(file), /redrawInPlace\(this\.body, \(\) => this\.draw\(\)\)/)
})

test('the About card opens from the keyboard, and while it is collapsed nothing inside it can take focus', () => {
  const ui = read('src/systems/UIOverlay.ts')
  assert.match(ui, /<button type="button" class="info-toggle \$\{toggleClass\}" id="info-about-toggle" aria-expanded="\$\{this\.isInfoExpanded \? 'true' : 'false'\}" aria-controls="info-about-content">/)
  assert.doesNotMatch(ui, /<div class="info-toggle/)
  assert.match(ui, /toggle\.setAttribute\('aria-expanded', this\.isInfoExpanded \? 'true' : 'false'\)/)
  const collapsed = ui.slice(ui.indexOf('.info-content {'), ui.indexOf('.info-content.expanded {'))
  assert.match(collapsed, /visibility: hidden;/)
  const expanded = ui.slice(ui.indexOf('.info-content.expanded {'), ui.indexOf('.info-divider {'))
  assert.match(expanded, /visibility: visible;/)
  assert.match(ui, /\.info-toggle:focus-visible \{\s*outline: 2px solid var\(--paper-ink\);/)
})

test('"many" is said only when the lab flagged many cut off answers, and fewer after training never replaces the within noise note', () => {
  const f = over => finished({ flags: { ...finished().flags, seen_only: false, ...over } })
  assert.equal(view(f({ cut_off_fell: true })).flagNote, 'Flag: fewer answers were cut off after training.')
  assert.equal(view(f({ cut_off_fell: true, within_noise: true })).flagNote, 'Within noise: the change is smaller than one pass band.')
  assert.equal(view(f({ cut_short_before: true, cut_off_fell: true, within_noise: true })).flagNote, 'Flag: many answers were cut off by the token limit.')
})

test('text a model wrote is labelled as the author\'s where it stands beside the lab\'s counts, and the panel says until when the model is kept', async () => {
  assert.equal(logic.chartByline({ author_name: 'Gemini 4', teacher_name: 'DeepSeek V4 Pro', epoch: 7 }), 'Topic and row names by Gemini 4. Taught by DeepSeek V4 Pro. Epoch 7.')
  assert.equal(logic.chartByline({ author_name: 'Grok 4.7', teacher_name: 'Grok 4.7', epoch: 41 }), 'Topic and row names by Grok 4.7, who also taught. Epoch 41.')
  await withPage(async ({ body, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished({ purpose: 'Checked by the lab: every held back answer passed', kept_until: '2026-12-09T10:00:00.000Z' })), false)
    p.show()
    await settle()
    const all = box(body).textContent
    assert.ok(all.includes('Purpose, in the author\'s words: Checked by the lab: every held back answer passed'))
    assert.ok(all.includes('The topic above and the subskill names below are the author\'s words.'))
    assert.ok(all.includes('Kept until 2026-12-09.'))
    assert.equal(all.includes('Finished 2026-11-25.'), false)
    p.setLesson(state(finished({ name: 'Rootkeeper' })), false)
    await settle()
    const named = box(body).textContent
    assert.ok(named.includes('Topic, as the author named it: Arithmetic habits.'))
    assert.ok(named.includes('Finished 2026-11-25.'), 'a record with no kept until date says when the lesson finished')
    p.close()
  })
  // a date that is not one is left out
  assert.equal(state(finished({ kept_until: 'soon' })).lesson.kept_until, undefined)
})

test('a reply or an answer the token limit cut off in teaching is marked in the open row and counted in the teaching line', async () => {
  const read2 = logic.readLessonQuestions(turnQuestions)
  assert.deepEqual(read2.questions[0].turns.map(t => [t.reply_cut_short, t.answer_cut_short]), [[true, true], [false, false]])
  assert.equal(teachingText({ missed: 2, taught: 2, solved: 1, explained: 1, teacher_failed: 0, cut_off: 3 }).endsWith('In 3 turns of teaching the token limit cut off the small model\'s reply or answer.'), true)
  assert.equal(teachingText({ missed: 2, taught: 2, solved: 1, explained: 1, teacher_failed: 0, cut_off: 1 }).endsWith('In 1 turn of teaching the token limit cut off the small model\'s reply or answer.'), true)
  assert.doesNotMatch(teachingText({ missed: 2, taught: 2, solved: 1, explained: 1, teacher_failed: 0 }), /cut off/)
  assert.equal(state(finished({ teaching: { ...finished().teaching, cut_off: 4 } })).lesson.teaching.cut_off, 4)
  assert.equal(state(finished()).lesson.teaching.cut_off, 0, 'an older record has no count')
  await withPage(async ({ body, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(finished()), false)
    p.show()
    await settle()
    body.all('.lp-row')[0].fire('click')
    await settle()
    const lines = body.all('.lp-detail')[0].all('.lp-line').map(l => l.textContent)
    assert.ok(lines.includes('It replied: Let me think about the Cut off by the token limit'), lines.join(' | '))
    assert.ok(lines.includes('It answered again: It is 5 because Did not pass. Cut off by the token limit'), lines.join(' | '))
    assert.ok(lines.includes('It replied: A negative number.'))
    assert.ok(lines.includes('It answered again: minus 5 Passed'))
    p.close()
  }, { questions: turnQuestions })
})

test('held back questions that share an answer with practice are carried on the record, said once in the panel, and noted on the chart only when nothing above it is', async () => {
  const sentence = 'Units: 2 of 3 held back questions expect a value that a practice question also expects, or that a rubric gives as a fixed value, so passing them may be recall of a taught answer'
  const flagged = over => finished({ flags: { ...finished().flags, seen_only: false, rubric_literal: [], shared_answers: [{ name: 'Units', shared: 2, of: 3 }], reasons: [sentence], ...over } })
  // the record is read strictly where it is present, and an older record without the field has none
  assert.deepEqual(state(flagged()).lesson.flags.shared_answers, [{ name: 'Units', shared: 2, of: 3 }])
  assert.deepEqual(state(finished()).lesson.flags.shared_answers, [], 'an older record has no such field')
  assert.deepEqual(state(flagged({ shared_answers: 'yes' })).lesson.flags.shared_answers, [])
  assert.deepEqual(state(flagged({ shared_answers: [{ name: 'Units', shared: 4, of: 3 }, { name: 'Checking', shared: 0, of: 3 }, { name: 7, shared: 1, of: 3 }, null, { name: 'Carrying digits', shared: 1, of: 3 }] })).lesson.flags.shared_answers, [{ name: 'Carrying digits', shared: 1, of: 3 }])
  // the chart's one line: it stands alone, and every other note comes before it
  const NOTE = 'Flag: some held back questions share an answer with practice.'
  assert.equal(view(flagged()).flagNote, NOTE)
  assert.equal(view(flagged({ cut_off_fell: true })).flagNote, 'Flag: fewer answers were cut off after training.')
  assert.equal(view(flagged({ within_noise: true })).flagNote, 'Within noise: the change is smaller than one pass band.')
  assert.equal(view(flagged({ cut_short_before: true })).flagNote, 'Flag: many answers were cut off by the token limit.')
  assert.equal(view(flagged({ seen_only: true })).flagNote, 'Flag: better only on questions seen in teaching.')
  assert.equal(view(finished({ flags: { ...finished().flags, seen_only: false } })).flagNote, null)
  assert.ok(NOTE.length <= 'Flag: better only on questions seen in teaching, and cut off answers.'.length, 'no longer than the longest note the paper already holds')
  assert.equal(/[–—]/.test(NOTE), false)
  // the panel prints the server's reason once, as a sentence
  await withPage(async ({ body, fetchStub, settle }) => {
    const p = new LessonPanel(() => {}, { fetch: fetchStub })
    p.setLesson(state(flagged()), false)
    p.show()
    await settle()
    const all = box(body).children.find(c => c.id === 'lesson-panel').textContent
    assert.ok(all.includes(`${sentence}.`))
    assert.equal(all.split('recall of a taught answer').length - 1, 1, 'the sentence is shown once')
    p.close()
  }, { record: { ...flagged(), rubrics: [[], [], [], []] } })
})
