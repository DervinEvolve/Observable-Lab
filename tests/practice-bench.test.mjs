// The practice bench (src/entities/PracticeBench.ts) and what it is drawn from
// (src/systems/practiceBench.ts, src/systems/PracticeBenchPanel.ts): the pure
// state mapping for idle, sampling, scored and done, the strict reading of the
// record, the colour of a jar, and the bench's cost in triangles and draw
// calls against the room's budget. No browser and no GPU: the geometry is
// real three.js, the canvases are stubs.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-bench-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')
for (const path of ['src/systems/practiceBench.ts', 'src/entities/PracticeBench.ts', 'src/scene/colors.ts']) {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${specifier}.js'`)
  mkdirSync(dirname(join(build, path)), { recursive: true })
  writeFileSync(join(build, path.replace(/\.ts$/, '.js')), output)
}
after(() => rmSync(build, { recursive: true, force: true }))

// A canvas that accepts every drawing call and remembers the text it was asked to write.
const written = []
const context = new Proxy({}, {
  get: (target, name) => {
    if (name === 'fillText') return text => written.push(String(text))
    if (name === 'measureText') return text => ({ width: String(text).length * 8 })
    if (name === 'createLinearGradient') return () => ({ addColorStop() {} })
    return typeof target[name] === 'undefined' ? () => {} : target[name]
  },
  set: (target, name, value) => { target[name] = value; return true },
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context, style: {} }) }

const logic = await import(pathToFileURL(join(build, 'src/systems/practiceBench.js')).href)
const { PracticeBench } = await import(pathToFileURL(join(build, 'src/entities/PracticeBench.js')).href)

const SLUG = 'e41-0a1b2c3d'
function run(over = {}) {
  return {
    slug: SLUG, author_name: 'Claude Fable 5.2', epoch: 41, base_model: 'Qwen/Qwen3-8B', task_set: 'Short sums', purpose: 'Practise adding',
    status: 'running', live: true, tasks: { total: 40, held_out: 6, training: 34 }, rubric: ['exact_match: the last line equals the expected value (weight 1)'],
    max_reward: 1, settings: { steps: 10, group_size: 4, tasks_per_step: 4, max_completion_tokens: 128, loss: 'importance_sampling', learning_rate: 4e-5, rank: 16 },
    progress: { phase: 'sampling', step: 3, steps_planned: 10, group_size: 4, tasks_per_step: 4, max_reward: 1, means: [0.1, 0.25, 0.5], frac_max: [0, 0.1, 0.3], attempts: [], samples: [], score_before: 0.2, score_after: null },
    held_out: { before: 0.2, after: null, measured_by: 'the lab', tasks: 6 },
    hacking: { flag: false, reasons: [] }, cost: { estimated_usd: 0.02, max_usd: 0.3, basis: 'an estimate' }, origin: 'written by the models',
    created_at: '2026-11-19T10:00:00.000Z', finished_at: null, reason: null, ...over,
  }
}
const practice = r => logic.parsePractice({ enabled: true, run: r })

test('with no run, or while no experiment is connected, the bench is dark and still', () => {
  for (const view of [logic.benchView(null, false), logic.benchView(practice(null), false), logic.benchView(practice(run()), true)]) {
    assert.equal(view.mode, 'dark')
    assert.equal(view.animated, false)
    assert.deepEqual(view.jars, [])
    assert.equal(view.plate.title, 'Nothing has been practised yet')
    assert.equal(view.plate.author, null)
    assert.equal(view.hacking, false)
    assert.equal(logic.lampState(view, false), 'off')
    assert.equal(logic.penPoint(view), null)
  }
})

test('a run being sampled shows amber jars, one per answer in the group, and moves', () => {
  const view = logic.benchView(practice(run()), false)
  assert.equal(view.mode, 'sampling')
  assert.equal(view.animated, true)
  assert.equal(view.jars.length, 4)
  assert.ok(view.jars.every(j => j.fill === 'amber'))
  assert.deepEqual([view.step, view.steps], [3, 10])
  assert.deepEqual(view.curve, [0.1, 0.25, 0.5])
  assert.deepEqual(view.plate, { title: 'Short sums', author: 'Claude Fable 5.2' })
  assert.equal(logic.stepLabel(view.step, view.steps), 'step 3 of 10')
})

test('after a step is scored each jar shows the reward of its answer, and the group is capped at 16 jars', () => {
  const scored = run({ progress: { ...run().progress, phase: 'scored', attempts: [0, 0.5, 1, 0.25] } })
  const view = logic.benchView(practice(scored), false)
  assert.equal(view.mode, 'scored')
  assert.deepEqual(view.jars.map(j => [j.fill, j.share]), [['scored', 0], ['scored', 0.5], ['scored', 1], ['scored', 0.25]])
  const wide = run({ settings: { ...run().settings, group_size: 16 }, progress: { ...run().progress, group_size: 16, phase: 'sampling' } })
  assert.equal(logic.benchView(practice(wide), false).jars.length, 16)
  // a share is the reward over the best the rubric allows
  const half = run({ max_reward: 0.5, progress: { ...run().progress, max_reward: 0.5, phase: 'scored', attempts: [0.5, 0.25, 0, 0] } })
  assert.deepEqual(logic.benchView(practice(half), false).jars.slice(0, 2).map(j => j.share), [1, 0.5])
})

test('a finished run is shown at rest with both held-out scores, and a run nobody has heard from rests too', () => {
  const finished = run({
    status: 'ok', live: false, finished_at: '2026-11-19T10:09:00.000Z',
    progress: { ...run().progress, phase: 'done', step: 10, means: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.6, 0.7, 0.7, 0.8], attempts: [1, 1, 0.5, 0], score_before: 0.2, score_after: 0.6 },
    held_out: { before: 0.2, after: 0.6, measured_by: 'the lab', tasks: 6 },
  })
  const view = logic.benchView(practice(finished), false)
  assert.equal(view.mode, 'done')
  assert.equal(view.animated, false)
  assert.deepEqual([view.before, view.after], [0.2, 0.6])
  assert.equal(view.curve.length, 10)
  assert.equal(view.jars.length, 4)
  const stale = logic.benchView(practice(run({ live: false })), false)
  assert.equal(stale.mode, 'resting')
  assert.equal(stale.animated, false)
  const failed = logic.benchView(practice(run({ status: 'failed', live: false, reason: 'the runner was lost' })), false)
  assert.equal(failed.mode, 'failed')
  assert.equal(failed.animated, false)
})

test('the pen is where the last recorded mean is, and nowhere before there is one', () => {
  const view = logic.benchView(practice(run()), false)
  const pen = logic.penPoint(view)
  assert.equal(pen.y, 0.5)
  assert.ok(pen.x > 0 && pen.x < 1)
  assert.equal(logic.curvePoints(view).length, 3)
  const none = logic.benchView(practice(run({ progress: { ...run().progress, step: 0, means: [], frac_max: [] } })), false)
  assert.equal(logic.penPoint(none), null)
  // every point of a curve over the planned steps stays on the paper
  for (const p of logic.curvePoints({ curve: Array(30).fill(1), curveSteps: 30 })) assert.ok(p.x > 0 && p.x < 1 && p.y <= 1)
})

test('the tell-tale lamp is lit only while the flag is set, and steady for reduced motion', () => {
  const flagged = logic.benchView(practice(run({ hacking: { flag: true, reasons: ['early'] } })), false)
  assert.equal(flagged.hacking, true)
  assert.equal(logic.lampState(flagged, false), 'blink')
  assert.equal(logic.lampState(flagged, true), 'on')
  assert.equal(logic.lampState(logic.benchView(practice(run()), false), false), 'off')
})

test('a jar goes from red through amber to green with its share of the best reward', () => {
  assert.equal(logic.rewardColor(0), 0xe57373)
  assert.equal(logic.rewardColor(0.5), 0xffb74d)
  assert.equal(logic.rewardColor(1), 0x7cb342)
  assert.equal(logic.rewardColor(-3), 0xe57373)
  assert.equal(logic.rewardColor(NaN), 0xe57373)
  const quarter = logic.rewardColor(0.25)
  assert.ok(((quarter >> 16) & 255) > 0xe5 - 0x20 && ((quarter >> 8) & 255) > 0x73 && ((quarter >> 8) & 255) < 0xb7)
  assert.equal(logic.rewardShare(0.3, 0), 0)
  assert.equal(logic.rewardShare(2, 1), 1)
})

test('the record is read strictly: a malformed run leaves the bench dark, and long or odd text is cut', () => {
  assert.equal(logic.parsePractice(null), null)
  assert.equal(logic.parsePractice('x'), null)
  assert.equal(logic.parsePractice({ enabled: true, run: { slug: '../etc', status: 'ok' } }).run, null)
  const odd = practice(run({ task_set: 'a\u0000b'.repeat(40), progress: { ...run().progress, means: [2] } }))
  assert.equal(odd.run.progress, null, 'a mean outside 0..1 drops the progress, not the run')
  assert.ok(odd.run.taskSet.length <= 48 && !odd.run.taskSet.includes('\u0000'))
  const samples = practice(run({ progress: { ...run().progress, samples: [{ prompt: 'p'.repeat(500), completion: '<img src=x onerror=alert(1)>', reward: 0.5 }, { prompt: 'x', completion: 'y', reward: 7 }] } }))
  assert.equal(samples.run.progress.samples.length, 1)
  assert.equal(samples.run.progress.samples[0].prompt.length, 100)
  // a talk link is only the run's own lab id
  assert.equal(practice(run({ talk: `lab/${SLUG}` })).run.talk, `lab/${SLUG}`)
  assert.equal(practice(run({ talk: 'lab/other' })).run.talk, null)
  assert.equal(logic.parsePractice({ enabled: false, off_reason: 'TINKER_JOBS_START_URL is not set', run: null }).offReason, 'TINKER_JOBS_START_URL is not set')
})

test('the bench stays inside its share of the room budget, and does nothing while it rests', () => {
  const bench = new PracticeBench()
  const dark = bench.stats()
  assert.ok(dark.drawCalls <= 8, `${dark.drawCalls} draw calls in the dark`)
  // the worst case: a run with sixteen answers to a group, so the pen is out and all sixteen jars stand
  const sixteen = run({ settings: { ...run().settings, group_size: 16 }, progress: { ...run().progress, group_size: 16 } })
  bench.setPractice(practice(sixteen), false)
  const worst = bench.stats()
  assert.equal(bench.shells.count, 16)
  console.log(`practice bench: ${worst.drawCalls} draw calls and ${worst.triangles} triangles with all 16 jars standing; ${dark.drawCalls} and ${dark.triangles} dark`)
  assert.ok(worst.drawCalls <= 8, `${worst.drawCalls} draw calls`)
  assert.ok(worst.triangles < 4000, `${worst.triangles} triangles`)
  // a run with a group of 4 stands 4 jars
  bench.setPractice(practice(run()), false)
  assert.equal(bench.shells.count, 4)
  assert.equal(bench.liquid.count, 4)
  assert.ok(bench.stats().triangles < worst.triangles)
  // the jars take the colours of the rewards the record holds
  const scored = run({ progress: { ...run().progress, phase: 'scored', attempts: [0, 1, 0.5, 1] } })
  bench.setPractice(practice(scored), false)
  bench.update(0.016)
  const c = bench.liquid.instanceColor.array
  const hex = i => (Math.round(c[i * 3] * 255) << 16) | (Math.round(c[i * 3 + 1] * 255) << 8) | Math.round(c[i * 3 + 2] * 255)
  assert.equal(hex(1), hex(3))
  assert.notEqual(hex(0), hex(1))
  // dark again once the room says no experiment is connected
  bench.setPractice(practice(run()), true)
  assert.equal(bench.shells.count, 0)
  assert.equal(bench.view.mode, 'dark')
  bench.dispose()
})

test('the plate says what the record says, and nothing else', () => {
  written.length = 0
  const bench = new PracticeBench()
  assert.ok(written.some(t => t === 'Nothing has been practised yet'))
  written.length = 0
  bench.setPractice(practice(run()), false)
  bench.update(0.016)
  assert.ok(written.includes('Short sums') && written.includes('by Claude Fable 5.2'))
  assert.ok(written.filter(t => t === 'measured by the lab').length === 2)
  assert.ok(written.includes('step 3 of 10'))
  assert.ok(written.every(t => !t.includes('—')), 'no em dashes on the bench')
  bench.dispose()
})

test('the visitor panel writes every text as text and has no em dash of its own', () => {
  const source = readFileSync(join(root, 'src/systems/PracticeBenchPanel.ts'), 'utf8')
  assert.ok(!source.includes('innerHTML'), 'the panel never writes markup')
  assert.ok(!source.includes('—'))
  for (const file of ['src/systems/practiceBench.ts', 'src/entities/PracticeBench.ts']) assert.ok(!readFileSync(join(root, file), 'utf8').includes('—'), file)
})

test('the camera view of the bench stays inside the orbit limits, inside the room, with the bench facing it', async () => {
  const { BENCH_ANGLE_DEG, BENCH_RADIUS } = await import(pathToFileURL(join(build, 'src/entities/PracticeBench.js')).href)
  const view = logic.benchCameraView(BENCH_ANGLE_DEG, BENCH_RADIUS)
  const [px, py, pz] = view.position
  const [tx, ty, tz] = view.target
  const distance = Math.hypot(px - tx, py - ty, pz - tz)
  // OrbitControls in main.ts: distance 6 to 15, polar angle 30 to 82 degrees. Outside them it would push the camera back on the next frame.
  assert.ok(distance >= 6 && distance <= 15, `distance ${distance}`)
  const polar = Math.acos((py - ty) / distance)
  assert.ok(polar >= Math.PI / 6 && polar <= Math.PI / 2.2, `polar ${polar}`)
  // inside the ring of desks (radius 5.5) and clear of the plant at the middle
  const r = Math.hypot(px, pz)
  assert.ok(r > 3 && r < 5, `radius ${r}`)
  // the bench's front faces the middle of the room, so the camera is on its front side
  const a = (BENCH_ANGLE_DEG * Math.PI) / 180
  const front = [-Math.cos(a), -Math.sin(a)]
  assert.ok(front[0] * (px - tx) + front[1] * (pz - tz) > 0)
  // the target is the bench itself
  assert.ok(Math.abs(Math.hypot(tx, tz) - BENCH_RADIUS) < 1e-9)
})
