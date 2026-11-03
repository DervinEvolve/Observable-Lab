import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

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

test('the production build ships only the credited, passive provider logo assets', () => {
  const root = resolve(dist, '..')
  assert.ok(existsSync(dist), 'run `npm run build` first')
  const records = JSON.parse(readFileSync(new URL('../docs/PROVIDER_LOGO_SOURCES.json', import.meta.url), 'utf8'))
  const expected = records.map(record => record.file.replace('public/logos/', '')).sort()
  assert.equal(expected.length, 7)
  assert.deepEqual(readdirSync(join(root, 'logos')).sort(), expected)
  const text = readdirSync(dist).filter(name => /\.(js|css)$/.test(name)).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')
  for (const record of records) {
    const name = record.file.replace('public/logos/', '')
    assert.match(name, /^[a-z]+\.svg$/)
    assert.ok(record.source.startsWith('https://'))
    assert.ok(record.license_url.startsWith('https://'))
    const bytes = readFileSync(join(root, 'logos', name))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256)
    assert.ok(text.includes(`/logos/${name}`), `${name} is not referenced`)
    const svg = bytes.toString('utf8')
    assert.doesNotMatch(svg, /<\s*(script|foreignObject|iframe|object|embed)\b|<!ENTITY|<!DOCTYPE|\son[a-z]+\s*=/i)
    assert.doesNotMatch(svg, /(?:href\s*=\s*["']\s*(?:https?:|data:|javascript:|\/\/)|@import|url\(\s*["']?\s*(?:https?:|data:|\/\/))/i)
  }
  assert.ok(text.includes('provider-logo'), 'logo avatar style missing')
})
