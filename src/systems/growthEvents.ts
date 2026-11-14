// What each step of the growth really was. GET /api/experiment returns
// `growth_events` (docs/GROWTH.md): one record per real event, oldest first,
// at most the newest 400, built on the server from stored records. The room
// grows one piece per event, shaped by that event, so the plant at any moment
// is the sum of what happened.
//
// Everything here is pure, so the same list gives the same plant on every
// screen and every reload.

import { COLORS } from '../scene/colors'
import {
  BACKEND_TO_FRONTEND_MODEL,
  FALLBACK_DISPLAY_NAMES,
  MODEL_DISPLAY_NAMES,
  WILDCARD_ACCENTS,
  WILDCARD_DISPLAY_NAMES,
  WILDCARD_MODELS,
  type FrontendModelId,
  type ModelId,
  type WildcardId,
} from '../shared/types'

export const GROWTH_EVENT_KINDS = ['epoch', 'contribution_merged', 'contribution_rejected', 'tests_failed', 'breakthrough', 'exhibit_merged'] as const
export type GrowthEventKind = (typeof GROWTH_EVENT_KINDS)[number]
export const MAX_GROWTH_EVENTS = 400

export interface GrowthEvent {
  id: string
  kind: GrowthEventKind
  epoch: number
  at: string
  model: string | null
  magnitude: number
  ref: string | null
}

const KINDS = new Set<string>(GROWTH_EVENT_KINDS)

/** Checks the feed. Drops anything malformed, keeps the server's order, keeps the newest 400. */
export function parseGrowthEvents(raw: unknown): GrowthEvent[] {
  if (!Array.isArray(raw)) return []
  const out: GrowthEvent[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(-MAX_GROWTH_EVENTS * 2)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = o.id
    if (typeof id !== 'string' || id.length < 3 || id.length > 120 || seen.has(id)) continue
    if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) continue
    const epoch = typeof o.epoch === 'number' && Number.isFinite(o.epoch) ? Math.max(0, Math.floor(o.epoch)) : null
    if (epoch === null) continue
    const at = typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) ? o.at : null
    if (!at) continue
    const mag = typeof o.magnitude === 'number' && Number.isFinite(o.magnitude) ? Math.min(1, Math.max(0, o.magnitude)) : null
    if (mag === null) continue
    const model = typeof o.model === 'string' && o.model.length > 0 && o.model.length <= 80 ? o.model : null
    const ref = typeof o.ref === 'string' && o.ref.length <= 60 ? o.ref : null
    seen.add(id)
    out.push({ id, kind: o.kind as GrowthEventKind, epoch, at, model, magnitude: mag, ref })
  }
  return out.slice(-MAX_GROWTH_EVENTS)
}

/** Changes whenever the list would grow a different plant. */
export function eventsKey(events: GrowthEvent[]): string {
  let h = 0x811c9dc5
  for (const e of events) h = hashString(e.id + '|' + e.kind + '|' + e.magnitude + '|' + (e.model ?? '') + '|' + e.epoch, h)
  return events.length + ':' + h.toString(36)
}

/** FNV-1a with a final avalanche, so ids that differ by one character still land far apart. */
export function hashString(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** A deterministic random stream (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The random stream one event grows from: the same id always grows the same way. */
export function eventRandom(id: string): () => number {
  return rng(hashString(id))
}

// ---------------------------------------------------------------------------
// When in the arc each event happened. The feed has no stage per event, so the
// room works out the furthest the plant can have been at the time from the
// two gates the feed does show (docs/GROWTH.md): the epoch number, and how
// many merges had landed by then. The record's current level caps both.
// ---------------------------------------------------------------------------

// The Epochs and Tested merges columns of docs/GROWTH.md, stages 0..6
export const STAGE_EPOCHS = [0, 6, 24, 56, 112, 196, 280]
export const STAGE_MERGES = [0, 1, 3, 8, 16, 28, 42]

function levelFrom(table: number[], v: number): number {
  for (let s = table.length - 1; s >= 0; s--) {
    if (v >= table[s]) {
      if (s === table.length - 1) {
        const step = table[s] - table[s - 1]
        return s + Math.min(1, (v - table[s]) / step)
      }
      return s + (v - table[s]) / (table[s + 1] - table[s])
    }
  }
  return 0
}

/**
 * The growth level (0..7) each event belongs to. `mergedTotal` is the
 * record's merged-contribution count, so merges older than the 400 in the
 * feed still count.
 */
export function eventLevels(events: GrowthEvent[], currentLevel: number, mergedTotal = 0): number[] {
  const mergesInFeed = events.filter(e => e.kind === 'contribution_merged').length
  let merges = Math.max(0, mergedTotal - mergesInFeed)
  const cap = Math.max(0, Math.min(7, currentLevel))
  return events.map(e => {
    if (e.kind === 'contribution_merged') merges++
    return Math.min(cap, levelFrom(STAGE_EPOCHS, e.epoch), levelFrom(STAGE_MERGES, merges))
  })
}

// ---------------------------------------------------------------------------
// Whose growth it is
// ---------------------------------------------------------------------------

const PANEL_ORDER: FrontendModelId[] = ['gemini', 'deepseek', 'claude', 'gpt', 'grok']

function frontendFor(model: string): FrontendModelId | null {
  const byId = (BACKEND_TO_FRONTEND_MODEL as Record<string, FrontendModelId>)[model]
  if (byId) return byId
  const entry = (Object.entries(MODEL_DISPLAY_NAMES) as Array<[ModelId, string]>).find(([, name]) => name === model)
  return entry ? BACKEND_TO_FRONTEND_MODEL[entry[0]] : null
}

function wildcardFor(model: string): WildcardId | null {
  for (const k of Object.keys(WILDCARD_MODELS) as WildcardId[]) if (WILDCARD_MODELS[k] === model || WILDCARD_DISPLAY_NAMES[k] === model) return k
  return null
}

// A fallback answers for its own lab, so it takes that lab's colour.
function providerFor(model: string): FrontendModelId | null {
  const id = Object.entries(FALLBACK_DISPLAY_NAMES).find(([, name]) => name === model)?.[0] ?? model
  const lab = id.split('/')[0]
  const map: Record<string, FrontendModelId> = { google: 'gemini', deepseek: 'deepseek', anthropic: 'claude', openai: 'gpt', 'x-ai': 'grok' }
  return map[lab] ?? null
}

/** The CLAUDE.md accent of the model named in an event (display name or id), or null. */
export function accentForModel(model: string | null): number | null {
  if (!model) return null
  const f = frontendFor(model) ?? providerFor(model)
  if (f) return COLORS.models[f]
  const wc = wildcardFor(model)
  return wc ? WILDCARD_ACCENTS[wc] : null
}

/**
 * Which of the five runner families a model's growth follows, and a small
 * offset so a fallback or wildcard sharing a family keeps its own line.
 */
export function lineageOf(model: string | null): { family: number; offset: number } {
  if (!model) return { family: 0, offset: 0.6 }
  const f = frontendFor(model)
  if (f) return { family: PANEL_ORDER.indexOf(f), offset: 0 }
  const p = providerFor(model)
  const h = hashString(model)
  if (p) return { family: PANEL_ORDER.indexOf(p), offset: (h & 1 ? 1 : -1) * 0.45 }
  return { family: h % 5, offset: ((h >>> 8) & 1 ? 1 : -1) * 0.55 }
}
