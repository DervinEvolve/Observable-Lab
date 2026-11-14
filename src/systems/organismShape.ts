// What makes this run's overgrowth its own. The layout of roots, runners and
// canopy is seeded from the experiment id, so every run grows a different
// organism, and the public record shapes it: more capabilities, more climbing
// runners; more constraints, deeper and wider roots; more behaviours, denser
// leaves. Flowers along the vines take the accent colour of the model whose
// merged contribution grew that stretch, in the order the merges landed.
//
// Everything here reads stored facts (the growth record, merged contributions).
// Nothing is invented: a merge whose author we do not know keeps a plain
// cream flower.

import { COLORS } from '../scene/colors'
import { BACKEND_TO_FRONTEND_MODEL, WILDCARD_ACCENTS, WILDCARD_MODELS, type FrontendModelId, type WildcardId } from '../shared/types'

export interface MergeMark {
  model_id: string
  merged_at: string | null
}

export interface OrganismShape {
  seed: number
  capabilities: number
  constraints: number
  behaviors: number
  merges: MergeMark[] // oldest first; may be only the newest of mergedTotal
  mergedTotal: number
}

/** FNV-1a over the id: a stable 32-bit seed per experiment. */
export function seedFromId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/** Merge marks from any stored list: [{ model_id, merged_at }] in any order. */
export function parseMerges(raw: unknown): MergeMark[] {
  if (!Array.isArray(raw)) return []
  const out: MergeMark[] = []
  for (const item of raw.slice(0, 500)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const model = o.model_id ?? o.model ?? o.author_model_id
    if (typeof model !== 'string' || !/^[a-z0-9._:/-]{3,100}$/i.test(model)) continue
    const at = o.merged_at ?? o.created_at
    const iso = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null
    out.push({ model_id: model, merged_at: iso })
  }
  // oldest first; marks without a time keep their place at the front
  return out
    .map((m, i) => ({ m, i, t: m.merged_at ? Date.parse(m.merged_at) : -Infinity }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(x => x.m)
}

export function shapeFrom(experimentId: string, growth: Record<string, unknown> | null, merges: MergeMark[]): OrganismShape {
  const g = growth || {}
  return {
    seed: seedFromId(experimentId || 'observable-lab'),
    capabilities: n(g.capabilities),
    constraints: n(g.constraints),
    behaviors: n(g.behaviors),
    merges,
    mergedTotal: Math.max(n(g.merged_contributions), merges.length),
  }
}

/** Changes only when the organism would actually be built differently. */
export function shapeKey(s: OrganismShape): string {
  return [s.seed, s.capabilities, s.constraints, s.behaviors, s.mergedTotal, s.merges.map(m => m.model_id).join(',')].join('|')
}

/** The CLAUDE.md accent of the model behind an OpenRouter id, or null when it has none. */
export function accentFor(modelId: string): number | null {
  const fid = (BACKEND_TO_FRONTEND_MODEL as Record<string, FrontendModelId>)[modelId]
  if (fid) return COLORS.models[fid]
  const wc = (Object.keys(WILDCARD_MODELS) as WildcardId[]).find(k => WILDCARD_MODELS[k] === modelId)
  return wc ? WILDCARD_ACCENTS[wc] : null
}

/**
 * Colour for each flower, flowers given in growth order. The organism is cut
 * into one stretch per merge, oldest merge nearest the dome; a stretch whose
 * merge we know takes that model's accent, the rest stay null (plain).
 */
export function flowerAccents(flowerCount: number, merges: MergeMark[], mergedTotal: number): Array<number | null> {
  const out: Array<number | null> = new Array(flowerCount).fill(null)
  const total = Math.max(mergedTotal, merges.length)
  if (!flowerCount || !total) return out
  const offset = total - merges.length // known marks are the newest ones
  for (let i = 0; i < flowerCount; i++) {
    const j = Math.min(total - 1, Math.floor((i / flowerCount) * total))
    const k = j - offset
    if (k >= 0 && k < merges.length) out[i] = accentFor(merges[k].model_id)
  }
  return out
}

/** How the record bends the layout. Pure numbers so a test can pin them. */
export function shapeParams(s: OrganismShape) {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return {
    // wall climbers in the whole room (stage 6 needs 20 capabilities -> 20)
    climbers: Math.round(clamp(4 + s.capabilities * 0.8, 4, 26)),
    // side roots per floor runner, their reach and thickness
    sideRoots: Math.round(clamp(1 + s.constraints / 4, 1, 6)),
    rootSpread: clamp(0.7 + s.constraints / 25, 0.7, 1.8),
    rootGirth: clamp(0.8 + s.constraints / 40, 0.8, 1.5),
    boardsPerRun: Math.round(clamp(1 + s.constraints / 8, 1, 3)),
    // leaf spacing divides by this
    leafDensity: clamp(0.6 + s.behaviors / 50, 0.6, 1.7),
  }
}
