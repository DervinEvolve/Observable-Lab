/**
 * How the lab scores results, as public JSON: GET /api/experiment/scoring.
 * Read-only, no dollar amounts.
 *
 *   research        Only with LAB_RESEARCH_CONFIRM on: the margin a new best
 *                   has to clear (with its floor and ceiling, and which of
 *                   them it is now), the run-to-run noise the lab has measured
 *                   with its sample count, the last verdict, and the lab's
 *                   newest repeat runs (research-confirm.ts).
 *   tinker_origin   Only with LAB_TINKER_ORIGIN_LABELS on: per origin of the
 *                   training examples ("written by the models", "public
 *                   dataset"), how many runs there were and the median
 *                   held-out loss before and after training (tinker-store.ts).
 *
 * With both switches off it says so and touches neither the database nor
 * the network. It never creates a table. Each part is kept for a minute per
 * server instance.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import {
  loadRepeats, noiseFromRepeats, marginFor, publicRepeat, researchConfirmEnabled, researchControlEvery, researchMaxMargin, researchMinMargin,
  type MarginBasis,
  type PublicRepeat,
} from './research-confirm.js'
import { tinkerOriginFlag } from './tinker.js'
import { originSummary, type OriginSummary } from './tinker-store.js'
import type { ResearchScoring } from './types.js'

const ABOUT = {
  research: 'Every val_bpb here was printed by the generated train.py and is unverified. A repeat by the lab tells a lucky run from one that repeats; it does not check that a score is honest.',
  tinker_origin: 'Held-out loss is measured by the lab on examples it held out. The origin says where the training examples came from; it is a label, not a judgement.',
}

interface ResearchPart {
  enabled: true
  min_margin_bpb: number
  /** The ceiling: the margin is never more than this, whatever the noise. */
  max_margin_bpb: number
  control_every_epochs: number
  /** null when no research experiment is active. */
  experiment_id: string | null
  noise_bpb: number | null
  noise_samples: number
  noise_state: string
  margin_bpb: number
  /** noise: twice the measured noise. floor: the floor. ceiling: twice the noise is above the ceiling, which was used. */
  margin_basis: MarginBasis
  last_verdict: ResearchScoring['last_verdict'] | null
  repeats: PublicRepeat[]
}

const CACHE_MS = 60_000
let researchCache: { at: number; part: ResearchPart } | null = null
let originCache: { at: number; origins: OriginSummary[] } | null = null

async function researchPart(): Promise<ResearchPart> {
  if (researchCache && Date.now() - researchCache.at < CACHE_MS) return researchCache.part
  const minMargin = researchMinMargin()
  const maxMargin = researchMaxMargin()
  const exp = (await sql`
    SELECT id, current_spec->'meta'->'research' AS research FROM experiments
    WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object'
    ORDER BY created_at DESC LIMIT 1
  `).rows[0]
  const rows = exp ? await loadRepeats(exp.id as string, { createTable: false }).catch(() => []) : []
  const noise = noiseFromRepeats(rows)
  const margin = marginFor(noise, minMargin, maxMargin)
  const scoring = (exp?.research as { scoring?: ResearchScoring } | null | undefined)?.scoring
  const part: ResearchPart = {
    enabled: true,
    min_margin_bpb: minMargin,
    max_margin_bpb: Math.max(minMargin, maxMargin),
    control_every_epochs: researchControlEvery(),
    experiment_id: exp ? String(exp.id) : null,
    noise_bpb: noise.noise_bpb,
    noise_samples: noise.samples,
    noise_state: noise.noise_bpb === null ? 'noise not yet measured' : 'measured from repeated runs of the same train.py',
    margin_bpb: margin.margin_bpb,
    margin_basis: margin.basis,
    last_verdict: scoring?.last_verdict ?? null,
    repeats: rows.slice(0, 12).map(publicRepeat),
  }
  researchCache = { at: Date.now(), part }
  return part
}

async function origins(): Promise<OriginSummary[]> {
  if (originCache && Date.now() - originCache.at < CACHE_MS) return originCache.origins
  const list = await originSummary()
  originCache = { at: Date.now(), origins: list }
  return list
}

export async function handleScoring(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const confirmOn = researchConfirmEnabled()
  const originOn = tinkerOriginFlag()
  if (!confirmOn && !originOn) {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60')
    return res.status(200).json({ research: { enabled: false }, tinker_origin: { enabled: false } })
  }
  let research: ResearchPart | { enabled: false } | { enabled: true; unavailable: true } = { enabled: false }
  if (confirmOn) {
    try {
      research = await researchPart()
    } catch (e) {
      console.warn('[scoring] could not read the research scoring state:', e instanceof Error ? e.message : e)
      research = { enabled: true, unavailable: true }
    }
  }
  let tinkerOrigin: { enabled: false } | { enabled: true; origins: OriginSummary[] } | { enabled: true; unavailable: true } = { enabled: false }
  if (originOn) {
    try {
      tinkerOrigin = { enabled: true, origins: await origins() }
    } catch (e) {
      console.warn('[scoring] could not read the origin summary:', e instanceof Error ? e.message : e)
      tinkerOrigin = { enabled: true, unavailable: true }
    }
  }
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=60')
  return res.status(200).json({
    about: { ...(confirmOn ? { research: ABOUT.research } : {}), ...(originOn ? { tinker_origin: ABOUT.tinker_origin } : {}) },
    research,
    tinker_origin: tinkerOrigin,
  })
}

/** For tests: forget what was cached. */
export function resetScoringCache(): void {
  researchCache = null
  originCache = null
}
