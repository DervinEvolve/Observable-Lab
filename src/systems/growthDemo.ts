// Development only. Made-up growth events for previewing the overgrowth
// without a backend (?growthDemo=N in main.ts). Imported only from a
// development-only branch, so it never ships. None of this is real data.

import { FALLBACK_DISPLAY_NAMES, MODEL_DISPLAY_NAMES } from '../shared/types'
import { STAGE_EPOCHS, STAGE_MERGES, hashString, rng, type GrowthEvent } from './growthEvents'

const PANEL = Object.values(MODEL_DISPLAY_NAMES)
const FALLBACK = Object.values(FALLBACK_DISPLAY_NAMES)

/** The first n events of a made-up run. The same seed always gives the same list, and a longer list starts with the shorter one. */
export function demoGrowthEvents(n: number, seed = 1): GrowthEvent[] {
  const R = rng(hashString('demo-run-' + seed))
  const out: GrowthEvent[] = []
  const t0 = Date.parse('2026-11-01T00:00:00.000Z')
  const id = (kind: string, epoch: number) => `${kind}:demo-${seed}-${hashString(kind + epoch, seed).toString(16)}`
  let best = 1.2
  for (let epoch = 1; out.length < n; epoch++) {
    const at = new Date(t0 + epoch * 3 * 3600_000).toISOString()
    // the executor rotates; now and then a fallback answers
    let model = PANEL[(epoch * 3 + seed) % PANEL.length]
    if (R() < 0.06) model = FALLBACK[Math.floor(R() * FALLBACK.length)]
    out.push({ id: id('epoch', epoch), kind: 'epoch', epoch, at, model, magnitude: Math.round((0.1 + 0.2 * Math.floor(R() * 5) / 4) * 1000) / 1000, ref: null })
    const roll = R()
    if (roll < 0.34 && out.length < n) {
      const author = PANEL[Math.floor(R() * PANEL.length)]
      const merged = R() < 0.62
      const later = new Date(t0 + epoch * 3 * 3600_000 + 600_000).toISOString()
      if (merged) {
        const tested = R() < 0.8
        out.push({ id: id('contribution', epoch), kind: 'contribution_merged', epoch, at: later, model: author, magnitude: Math.round((0.4 + 0.3 * R() + (tested ? 0.1 : 0)) * 1000) / 1000, ref: `#${10 + epoch}` })
      } else {
        const failed = R() < 0.5
        out.push({ id: id('contribution', epoch), kind: failed ? 'tests_failed' : 'contribution_rejected', epoch, at: later, model: author, magnitude: 0.2, ref: failed ? 'ci failed' : 'rejected' })
      }
    }
    if (R() < 0.025 && out.length < n) {
      const gain = R() * 0.06
      best *= 1 - gain
      out.push({ id: id('research', epoch), kind: 'breakthrough', epoch, at, model, magnitude: Math.round((0.8 + 0.2 * Math.min(1, gain / 0.05)) * 1000) / 1000, ref: 'keep' })
    }
    if (R() < 0.03 && out.length < n) {
      out.push({ id: id('tool', epoch), kind: 'exhibit_merged', epoch, at: new Date(t0 + epoch * 3 * 3600_000 + 1200_000).toISOString(), model: PANEL[Math.floor(R() * PANEL.length)], magnitude: 0.3, ref: null })
    }
  }
  return out.slice(0, n)
}

function levelFrom(table: number[], v: number): number {
  for (let s = table.length - 1; s >= 0; s--) {
    if (v >= table[s]) return s === table.length - 1 ? s + 1 : s + (v - table[s]) / (table[s + 1] - table[s])
  }
  return 0
}

/** A stage the made-up list could plausibly have reached, from its epochs and merges only. */
export function demoGrowthRecord(events: GrowthEvent[]): { stage: number; progress: number; merged: number } {
  const merged = events.filter(e => e.kind === 'contribution_merged').length
  const epochs = events.reduce((m, e) => Math.max(m, e.epoch), 0)
  const level = Math.min(levelFrom(STAGE_EPOCHS, epochs), levelFrom(STAGE_MERGES, merged), 7)
  const stage = Math.min(6, Math.floor(level))
  return { stage, progress: stage === 6 ? 1 : level - stage, merged }
}
