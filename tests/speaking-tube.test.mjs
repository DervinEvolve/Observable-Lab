// The Commentator's speaking tube (src/systems/speakingTube.ts,
// src/entities/SpeakingTubeGlow.ts): that it lights only from a real stored
// chat time, how it fades, that it is dark with no record, with the chat off,
// in a simulation and when the last chat is old, and what it costs the room
// in triangles and draw calls. No browser and no GPU: the geometry is real
// three.js, the canvas is a stub.
import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const build = mkdtempSync(join(tmpdir(), 'observable-tube-test-'))
symlinkSync(join(root, 'node_modules'), join(build, 'node_modules'))
writeFileSync(join(build, 'package.json'), '{"type":"module"}')
for (const path of ['src/systems/speakingTube.ts', 'src/entities/SpeakingTubeGlow.ts', 'src/entities/Station.ts', 'src/scene/colors.ts']) {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${specifier}.js'`)
  mkdirSync(dirname(join(build, path)), { recursive: true })
  writeFileSync(join(build, path.replace(/\.ts$/, '.js')), output)
}
after(() => { mock.restoreAll(); rmSync(build, { recursive: true, force: true }) })

const context = new Proxy({}, {
  get: (target, name) => {
    if (name === 'createRadialGradient' || name === 'createLinearGradient') return () => ({ addColorStop() {} })
    return typeof target[name] === 'undefined' ? () => {} : target[name]
  },
  set: (target, name, value) => { target[name] = value; return true },
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context, style: {} }) }

const THREE = await import(pathToFileURL(join(build, 'node_modules/three/build/three.module.js')).href)
const logic = await import(pathToFileURL(join(build, 'src/systems/speakingTube.js')).href)
const { SpeakingTubeGlow } = await import(pathToFileURL(join(build, 'src/entities/SpeakingTubeGlow.js')).href)
const { createAllStations } = await import(pathToFileURL(join(build, 'src/entities/Station.js')).href)
const mainSource = readFileSync(join(root, 'src/main.ts'), 'utf8')

const NOW = Date.parse('2026-11-23T14:03:10.000Z')
const field = (over = {}) => ({ now: '2026-11-23T14:03:10.000Z', today: 7, last: { adapter: 'e41-0a1b2c3d', at: '2026-11-23T14:01:52.000Z' }, ...over })

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------
test('the public field is read strictly: anything malformed leaves the tube dark', () => {
  const ok = logic.parseChatActivity(field())
  assert.deepEqual(ok, { serverNowMs: NOW, today: 7, adapter: 'e41-0a1b2c3d', atMs: Date.parse('2026-11-23T14:01:52.000Z') })
  const bad = [
    undefined, null, 'x', 7, [], {}, field({ now: 'soon' }), field({ now: 5 }), field({ today: -1 }), field({ today: 1.5 }), field({ today: '7' }),
    field({ last: null }), field({ last: [] }), field({ last: { adapter: 'e41-0a1b2c3d' } }), field({ last: { at: '2026-11-23T14:01:52.000Z' } }),
    field({ last: { adapter: '<img>', at: '2026-11-23T14:01:52.000Z' } }), field({ last: { adapter: 'e41-0a1b2c3d', at: 'yesterday' } }),
    { last: { last: field().last }, now: field().now, today: 1 }, { now: field().now, today: 1, last: { adapter: { slug: 'e41-0a1b2c3d' }, at: field().last.at } },
  ]
  for (const raw of bad) assert.equal(logic.parseChatActivity(raw), null, JSON.stringify(raw))
})

test('the glow is steady for 90 seconds, falls in a line to nothing at 120, and a reduced-motion glow steps instead', () => {
  assert.equal(logic.tubeGlow(null, false), 0)
  assert.equal(logic.tubeGlow(null, true), 0)
  assert.equal(logic.tubeGlow(Number.NaN, false), 0)
  for (const age of [0, 1, 45, 90]) assert.equal(logic.tubeGlow(age, false), 1, String(age))
  assert.equal(logic.tubeGlow(105, false), 0.5)
  assert.ok(Math.abs(logic.tubeGlow(100, false) - 2 / 3) < 1e-12)
  for (const age of [120, 121, 3600]) assert.equal(logic.tubeGlow(age, false), 0, String(age))
  // never rising with age
  let last = 2
  for (let age = 0; age <= 130; age += 0.5) { const g = logic.tubeGlow(age, false); assert.ok(g <= last); last = g }
  // reduced motion: a step, never between
  for (let age = 0; age <= 130; age += 0.5) assert.ok([0, 1].includes(logic.tubeGlow(age, true)), String(age))
  assert.equal(logic.tubeGlow(119.9, true), 1)
  assert.equal(logic.tubeGlow(120, true), 0)
  assert.equal(logic.tubeGlow(-5, false), 1) // a clock a little ahead is a fresh reply, not a negative age
})

test('age is the server\'s age at receipt plus the time since, and the newer of two events wins', () => {
  const a = logic.parseChatActivity(field())
  assert.equal(logic.activityAge(a, 1000, 1000), 78) // 14:03:10 minus 14:01:52
  assert.equal(logic.activityAge(a, 1000, 13000), 90)
  assert.equal(logic.activityAge({ ...a, atMs: a.serverNowMs + 5000 }, 0, 0), 0)
  assert.equal(logic.newestAge(78, 3), 3)
  assert.equal(logic.newestAge(null, 3), 3)
  assert.equal(logic.newestAge(78, null), 78)
  assert.equal(logic.newestAge(null, null), null)
})

test('the tube\'s mouth is where the Commentator\'s real tube is', () => {
  const stations = createAllStations()
  const desk = stations.getObjectByName('station_commentator')
  stations.updateMatrixWorld(true)
  const world = desk.localToWorld(new THREE.Vector3(-0.65, 1.17, -0.1))
  const mouth = logic.tubeMouthPosition()
  assert.ok(Math.abs(world.x - mouth.x) < 1e-9 && Math.abs(world.y - mouth.y) < 1e-9 && Math.abs(world.z - mouth.z) < 1e-9, JSON.stringify([world, mouth]))
})

// ---------------------------------------------------------------------------
// The room object
// ---------------------------------------------------------------------------
let perf = 0
let wall = NOW
mock.method(performance, 'now', () => perf)
mock.method(Date, 'now', () => wall)
const at = seconds => { perf = seconds * 1000; wall = NOW + seconds * 1000 }
function fresh() {
  at(0)
  const tube = new SpeakingTubeGlow()
  return tube
}
const lit = tube => tube.sprite.visible && tube.sprite.material.opacity > 0

test('the tube is dark with no record, with the chat off, in a simulation, and when the last chat is old', () => {
  const tube = fresh()
  assert.equal(lit(tube), false)
  assert.equal(tube.sprite.visible, false)
  // no record
  tube.setChatOn(true)
  tube.setActivity(null, false)
  tube.update(0.016)
  assert.equal(lit(tube), false)
  // chat off, even with a record
  tube.setChatOn(false)
  tube.setActivity(logic.parseChatActivity(field()), false)
  tube.update(0.016)
  assert.equal(lit(tube), false)
  // a simulation (no experiment connected)
  tube.setChatOn(true)
  tube.setActivity(logic.parseChatActivity(field()), true)
  tube.update(0.016)
  assert.equal(lit(tube), false)
  // an old last chat: 5 minutes before the server built the field
  tube.setActivity(logic.parseChatActivity(field({ last: { adapter: 'e41-0a1b2c3d', at: '2026-11-23T13:58:10.000Z' } })), false)
  tube.update(0.016)
  assert.equal(lit(tube), false)
  // and malformed state is nothing
  tube.setActivity(logic.parseChatActivity({ now: 'x' }), false)
  assert.equal(lit(tube), false)
  // a visitor's own reply while the chat is off does not light it either
  tube.setChatOn(false)
  tube.noteOwnReply(Date.now())
  assert.equal(lit(tube), false)
})

test('a real record lights it, it fades with the age of that record, and it goes dark when the record gets old', () => {
  const tube = fresh()
  tube.setChatOn(true)
  tube.setActivity(logic.parseChatActivity(field()), false) // 78 seconds old when received
  assert.equal(lit(tube), true)
  assert.equal(tube.sprite.material.opacity, 0.9)
  at(12) // 90 seconds old now
  tube.update(0.016)
  assert.equal(tube.glow(), 1)
  at(27) // 105
  tube.update(0.016)
  assert.ok(Math.abs(tube.sprite.material.opacity - 0.45) < 1e-9)
  at(42) // 120
  tube.update(0.016)
  assert.equal(lit(tube), false)
  assert.equal(tube.sprite.visible, false)
  // the same record arriving again on the next poll does not restart the clock
  tube.setActivity(logic.parseChatActivity(field()), false)
  assert.equal(lit(tube), false)
  // a newer record does
  tube.setActivity(logic.parseChatActivity(field({ now: '2026-11-23T14:06:00.000Z', last: { adapter: 'e41-0a1b2c3d', at: '2026-11-23T14:05:50.000Z' } })), false)
  assert.equal(lit(tube), true)
})

test('this visitor\'s own real reply lights it at once, and the newer of own and server wins', () => {
  const tube = fresh()
  tube.setChatOn(true)
  at(0)
  tube.noteOwnReply(Date.now())
  assert.equal(tube.glow(), 1)
  at(100)
  tube.update(0.016)
  assert.ok(tube.glow() < 1 && tube.glow() > 0)
  // an older server record does not dim a newer own reply
  tube.setActivity(logic.parseChatActivity(field({ now: new Date(Date.now()).toISOString(), last: { adapter: 'e41-0a1b2c3d', at: new Date(Date.now() - 118_000).toISOString() } })), false)
  assert.ok(Math.abs(tube.glow() - (20 / 30)) < 1e-6)
  // turning the chat off forgets both
  tube.setChatOn(false)
  assert.equal(lit(tube), false)
  tube.setChatOn(true)
  assert.equal(lit(tube), false)
  // a junk time is ignored
  tube.noteOwnReply(Number.NaN)
  assert.equal(lit(tube), false)
})

test('reduced motion holds a steady glow and then steps to nothing', () => {
  const tube = fresh()
  tube.setChatOn(true)
  tube.setReducedMotion(true)
  tube.setActivity(logic.parseChatActivity(field({ last: { adapter: 'e41-0a1b2c3d', at: '2026-11-23T14:01:10.000Z' } })), false) // 120s...
  assert.equal(lit(tube), false)
  tube.setActivity(logic.parseChatActivity(field({ last: { adapter: 'e41-0a1b2c3d', at: '2026-11-23T14:01:30.000Z' } })), false) // 100s
  assert.equal(tube.sprite.material.opacity, 0.9)
  at(19) // 119 s
  tube.update(0.016)
  assert.equal(tube.sprite.material.opacity, 0.9)
  at(21)
  tube.update(0.016)
  assert.equal(lit(tube), false)
})

test('it costs nothing at rest and at most one draw call and two triangles when lit', () => {
  const count = group => {
    let calls = 0
    let triangles = 0
    group.traverse(o => {
      if (!o.visible || !(o.isMesh || o.isSprite)) return
      calls += 1
      triangles += o.isSprite ? 2 : (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3
    })
    return { calls, triangles }
  }
  const scene = new THREE.Scene()
  const tube = fresh()
  scene.add(tube.sprite)
  assert.deepEqual(count(scene), { calls: 0, triangles: 0 })
  tube.setChatOn(true)
  tube.noteOwnReply(Date.now())
  const lit1 = count(scene)
  assert.deepEqual(lit1, { calls: 1, triangles: 2 })
  assert.equal(tube.sprite.material.blending, THREE.AdditiveBlending)
  assert.equal(tube.sprite.material.depthWrite, false)
  assert.ok(tube.sprite.material.map.image.width === 64 && tube.sprite.material.map.image.height === 64)
  let lights = 0
  scene.traverse(o => { if (o.isLight) lights += 1 })
  assert.equal(lights, 0)
  assert.equal(tube.sprite.userData.inspect, undefined)
  // measured against the room's budget (CLAUDE.md): 70,000 triangles, and the room measured 48,228 without this
  assert.ok(48_228 + lit1.triangles < 70_000)
})

test('nothing about it is driven by a timer or by chance, and the page wires it only to real events', () => {
  for (const file of ['src/systems/speakingTube.ts', 'src/entities/SpeakingTubeGlow.ts']) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.equal(/setInterval|setTimeout|Math\.random|requestAnimationFrame/.test(source), false, file)
    assert.equal(/[—–]/.test(source), false, file)
  }
  // added to the scene itself, never to a group that is merged
  assert.match(mainSource, /this\.scene\.add\(this\.speakingTube\.sprite\)/)
  assert.equal(/room_fixed[^]{0,300}speakingTube|speakingTube[^]{0,300}fixed\.add/.test(mainSource), false)
  // fed by the state's field and by the panel's real reply, nothing else
  assert.match(mainSource, /this\.trainedChat\.onReply = at => this\.speakingTube\?\.noteOwnReply\(at\)/)
  assert.match(mainSource, /parseChatActivity\(\(state as unknown as \{ trained_chat_activity\?: unknown \}\)\.trained_chat_activity\)/)
  assert.equal((mainSource.match(/noteOwnReply\(/g) ?? []).length, 1)
  // the debug hook lives in the development block, which the production bundle drops
  const dev = mainSource.indexOf('if (import.meta.env.DEV) (window as any).lab = {')
  const hook = mainSource.indexOf('speakingTube: this.speakingTube,')
  assert.ok(dev > 0 && hook > dev && hook - dev < 3000)
  assert.equal(mainSource.indexOf('window.lab.speakingTube'), -1)
})
