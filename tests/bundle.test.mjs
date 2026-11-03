import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Run after `npm run build`. Checks the production bundle the public viewer gets.
const dist = resolve(import.meta.dirname, '..', 'dist', 'assets')

test('the production bundle has no debug console object, fake build output, or anonymous operator calls', () => {
  assert.ok(existsSync(dist), 'run `npm run build` first')
  const js = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')
  assert.ok(js.length > 0, 'no JavaScript in dist/assets')
  for (const banned of ['window.lab', 'lab.exec(', '9f2c1a', 'build passed', '/api/experiment/shatter', '/api/epoch/run']) {
    assert.equal(js.includes(banned), false, `production bundle contains ${banned}`)
  }
  assert.ok(js.includes('Simulation: no experiment connected'), 'simulation marker missing')
})

test('the production build ships no provider logos and references none', () => {
  const root = resolve(dist, '..')
  assert.ok(existsSync(dist), 'run `npm run build` first')
  assert.equal(existsSync(join(root, 'logos')), false, 'dist/logos exists')
  const text = readdirSync(dist).filter(name => /\.(js|css)$/.test(name)).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')
  assert.equal(text.includes('/logos/'), false, 'bundle references /logos/')
  assert.ok(text.includes('provider-name'), 'provider name label missing')
})
