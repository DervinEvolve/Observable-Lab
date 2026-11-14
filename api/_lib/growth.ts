/**
 * How far the specimen has taken over the room, computed from stored facts
 * only: completed epochs, the current specification, and code contributions
 * that really merged with passing tests. The room draws exactly what this
 * says (src/systems/growth.ts). docs/GROWTH.md explains the table.
 */
import { sql } from '@vercel/postgres'
import type { AgentSpecification, ExperimentGrowthRecord } from './types.js'

export interface GrowthFacts {
  epochs: number
  capabilities: number            // active
  constraints: number             // active
  behaviors: number               // active
  stability: number               // 0..1
  merged_contributions: number
  contributions_with_passing_tests: number // merged, and CI passed or the author's Sprite exited 0
  sprite_test_passes: number      // any contribution whose Sprite test run exited 0
  stored_glass_shattered: boolean // experiments.glass_shattered
}

export interface StageRequirement {
  stage: number
  meaning: string
  epochs: number
  spec_elements: number     // active capabilities + constraints + behaviors
  capabilities: number
  constraints: number
  stability: number
  tested_merges: number     // contributions_with_passing_tests
}

// Every row must be met in full to reach that stage. Each one needs merged,
// tested code and a healthy specification, never epochs alone. At the
// default cadence (an epoch every 3 hours, 8 a day) the epoch minimums alone
// are about 1, 3, 7, 14, 24 and 35 days; at most one contribution can merge
// per epoch, so the code minimums are slower in practice. Sprite passes are
// reported but are not a gate: a merge with passing CI is tested code, and
// growth must not stall in a deployment without Sprites.
export const GROWTH_THRESHOLDS: readonly StageRequirement[] = Object.freeze([
  { stage: 1, meaning: 'grown inside the dome',              epochs: 6,   spec_elements: 4,  capabilities: 1,  constraints: 0,  stability: 0.40, tested_merges: 1 },
  { stage: 2, meaning: 'pressing on the glass, with cracks', epochs: 24,  spec_elements: 12, capabilities: 4,  constraints: 2,  stability: 0.50, tested_merges: 3 },
  { stage: 3, meaning: 'broken out',                         epochs: 56,  spec_elements: 24, capabilities: 8,  constraints: 4,  stability: 0.55, tested_merges: 8 },
  { stage: 4, meaning: 'roots and vines across the floor',   epochs: 112, spec_elements: 36, capabilities: 12, constraints: 6,  stability: 0.60, tested_merges: 16 },
  { stage: 5, meaning: 'climbing walls and desks',           epochs: 196, spec_elements: 48, capabilities: 16, constraints: 8,  stability: 0.65, tested_merges: 28 },
  { stage: 6, meaning: 'canopy across the ceiling',          epochs: 280, spec_elements: 60, capabilities: 20, constraints: 10, stability: 0.70, tested_merges: 42 },
])

export const MAX_GROWTH_STAGE = 6
export const BREAKOUT_STAGE = 3

const ZERO_ROW = { epochs: 0, spec_elements: 0, capabilities: 0, constraints: 0, stability: 0, tested_merges: 0 }
type Gate = keyof typeof ZERO_ROW

function measure(f: GrowthFacts): Record<Gate, number> {
  return {
    epochs: f.epochs,
    spec_elements: f.capabilities + f.constraints + f.behaviors,
    capabilities: f.capabilities,
    constraints: f.constraints,
    stability: f.stability,
    tested_merges: f.contributions_with_passing_tests,
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0))
const nonNegative = (n: unknown) => {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** Stage, progress within it, and the facts behind them. Pure. */
export function computeGrowth(raw: GrowthFacts): ExperimentGrowthRecord {
  const facts: GrowthFacts = {
    epochs: nonNegative(raw.epochs),
    capabilities: nonNegative(raw.capabilities),
    constraints: nonNegative(raw.constraints),
    behaviors: nonNegative(raw.behaviors),
    stability: clamp01(Number(raw.stability)),
    merged_contributions: nonNegative(raw.merged_contributions),
    contributions_with_passing_tests: nonNegative(raw.contributions_with_passing_tests),
    sprite_test_passes: nonNegative(raw.sprite_test_passes),
    stored_glass_shattered: raw.stored_glass_shattered === true,
  }
  const have = measure(facts)
  const gates = Object.keys(ZERO_ROW) as Gate[]

  let stage = 0
  for (const row of GROWTH_THRESHOLDS) {
    if (gates.every(g => have[g] >= row[g])) stage = row.stage
    else break
  }

  // Progress toward the next stage is the slowest gate's share of the way
  // from this stage's row to the next one.
  let progress = 1
  if (stage < MAX_GROWTH_STAGE) {
    const from = stage === 0 ? ZERO_ROW : GROWTH_THRESHOLDS[stage - 1]
    const to = GROWTH_THRESHOLDS[stage]
    progress = Math.min(...gates.map(g => {
      const span = to[g] - from[g]
      if (span <= 0) return have[g] >= to[g] ? 1 : 0
      return clamp01((have[g] - from[g]) / span)
    }))
    // Not all gates met means not there yet, however close.
    progress = Math.min(progress, 0.999)
  }

  return {
    stage,
    progress: Math.round(progress * 1000) / 1000,
    epochs: facts.epochs,
    capabilities: facts.capabilities,
    constraints: facts.constraints,
    behaviors: facts.behaviors,
    stability: Math.round(facts.stability * 1000) / 1000,
    merged_contributions: facts.merged_contributions,
    contributions_with_passing_tests: facts.contributions_with_passing_tests,
    sprite_test_passes: facts.sprite_test_passes,
    glass_shattered: facts.stored_glass_shattered || stage >= BREAKOUT_STAGE,
  }
}

// ---------------------------------------------------------------------------
// Reading the facts
// ---------------------------------------------------------------------------

export interface ContributionCounts {
  merged: number
  tested: number
  sprite: number
}

const countsCache = new Map<string, { at: number; counts: ContributionCounts }>()
const COUNTS_TTL_MS = 60_000

/** Contribution counts for an experiment. Zeros when the table isn't there yet. */
export async function contributionCounts(experimentId: string): Promise<ContributionCounts> {
  const cached = countsCache.get(experimentId)
  if (cached && Date.now() - cached.at < COUNTS_TTL_MS) return cached.counts
  let counts: ContributionCounts = { merged: 0, tested: 0, sprite: 0 }
  try {
    const r = await sql`
      SELECT
        COUNT(*) FILTER (WHERE merged) AS merged,
        COUNT(*) FILTER (WHERE merged AND (ci_passed IS TRUE OR (sprite_ran_at IS NOT NULL AND sprite_exit_code = 0))) AS tested,
        COUNT(*) FILTER (WHERE sprite_ran_at IS NOT NULL AND sprite_exit_code = 0) AS sprite
      FROM code_contributions
      WHERE experiment_id = ${experimentId}
    `
    const row = r.rows[0] ?? {}
    counts = { merged: Number(row.merged) || 0, tested: Number(row.tested) || 0, sprite: Number(row.sprite) || 0 }
  } catch {
    // An older table without the sprite columns: merges with passing CI still count.
    try {
      const r = await sql`
        SELECT COUNT(*) FILTER (WHERE merged) AS merged,
          COUNT(*) FILTER (WHERE merged AND ci_passed IS TRUE) AS tested
        FROM code_contributions WHERE experiment_id = ${experimentId}
      `
      const row = r.rows[0] ?? {}
      counts = { merged: Number(row.merged) || 0, tested: Number(row.tested) || 0, sprite: 0 }
    } catch {
      // no contributions table yet
    }
  }
  countsCache.set(experimentId, { at: Date.now(), counts })
  return counts
}

/** Facts for one experiment row (as selected from `experiments`). */
export async function growthFactsFor(experiment: {
  id: string
  current_epoch?: number
  current_spec?: AgentSpecification
  glass_shattered?: boolean | null
}): Promise<GrowthFacts> {
  const spec = experiment.current_spec
  const active = <T extends { status?: string }>(items: T[] | undefined) =>
    Array.isArray(items) ? items.filter(i => i?.status === 'active').length : 0
  const counts = await contributionCounts(experiment.id)
  return {
    epochs: Number(experiment.current_epoch) || 0,
    capabilities: active(spec?.capabilities),
    constraints: active(spec?.constraints),
    behaviors: active(spec?.behaviors),
    stability: Number(spec?.meta?.stability_score) || 0,
    merged_contributions: counts.merged,
    contributions_with_passing_tests: counts.tested,
    sprite_test_passes: counts.sprite,
    stored_glass_shattered: experiment.glass_shattered === true,
  }
}

/**
 * After an epoch: once the record reaches the breakout stage, store the
 * broken glass so it stays broken even if stability dips later. Never throws.
 */
export async function persistGlassIfBrokenOut(experimentId: string): Promise<void> {
  try {
    countsCache.delete(experimentId)
    const r = await sql`SELECT id, current_epoch, current_spec, glass_shattered FROM experiments WHERE id = ${experimentId}`
    const exp = r.rows[0]
    if (!exp || exp.glass_shattered === true) return
    const growth = computeGrowth(await growthFactsFor(exp as Parameters<typeof growthFactsFor>[0]))
    if (growth.stage >= BREAKOUT_STAGE) {
      await sql`UPDATE experiments SET glass_shattered = TRUE WHERE id = ${experimentId}`
      console.log(`[growth] experiment ${experimentId} reached stage ${growth.stage}; glass stored as broken`)
    }
  } catch (e) {
    console.warn('[growth] could not store the glass state (non-fatal):', e instanceof Error ? e.message : e)
  }
}

// ---------------------------------------------------------------------------
// The three repositories behind the room
// ---------------------------------------------------------------------------

const DEFAULT_OWNER = 'DervinEvolve'

function githubName(value: string | undefined, fallback: string): string {
  const v = (value || '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v) && !v.includes('..') ? v : fallback
}

export function repoLinks(): { lab: string; specimen: string; research: string } {
  const owner = githubName(process.env.AI_AGENT_GITHUB_OWNER, DEFAULT_OWNER)
  const researchOwner = githubName(process.env.RESEARCH_GITHUB_OWNER, owner)
  return {
    lab: `https://github.com/${owner}/Observable-Lab`,
    specimen: `https://github.com/${owner}/${githubName(process.env.AI_AGENT_GITHUB_REPO, 'AI-Agent')}`,
    research: `https://github.com/${researchOwner}/${githubName(process.env.RESEARCH_GITHUB_REPO, 'Research-Lab')}`,
  }
}
