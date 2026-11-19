/**
 * How far the specimen has taken over the room, computed from stored facts
 * only: completed epochs, the current specification, and code contributions
 * that really merged with passing tests. The room draws exactly what this
 * says (src/systems/growth.ts). docs/GROWTH.md explains the table.
 */
import { sql } from '@vercel/postgres'
import type { AgentSpecification, ExperimentGrowthRecord } from './types.js'
import { modelDisplayName } from './types.js'

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
    eventsCache.delete(experimentId)
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
// Growth events: what really happened, one record each, for the room to grow
// from. docs/GROWTH.md has the contract. The stage above says how far the
// plant has got; these say what each step of it was. Stored records only.
// ---------------------------------------------------------------------------

export type GrowthEventKind =
  | 'epoch' | 'contribution_merged' | 'contribution_rejected' | 'tests_failed' | 'breakthrough' | 'exhibit_merged'

export interface GrowthEvent {
  id: string               // 'epoch:<id>', 'contribution:<id>', 'research:<id>', 'tool:<id>'
  kind: GrowthEventKind
  epoch: number
  at: string               // ISO time
  model: string | null     // display name of the model behind it
  magnitude: number        // 0..1
  ref: string | null       // PR number, verdict or reason; short
}

export const MAX_GROWTH_EVENTS = 400

// Magnitudes. All deterministic, all from stored numbers, all rounded to 3
// places so the same records always give the same feed.
//   ordinary epoch        0.1 to 0.3, by how many mutations were approved (4 or more is full)
//   merged contribution   0.4 to 0.8: 0.4, up to 0.3 more by lines written (400 lines is full),
//                         and 0.1 more when its tests passed in CI or the Sprite
//   rejected / tests failed  0.2 (a bud that withers: setbacks show too)
//   breakthrough          0.8 to 1.0, by the relative improvement (5% better than the best is full)
//   merged exhibit        0.3
export const SETBACK_MAGNITUDE = 0.2
export const EXHIBIT_MAGNITUDE = 0.3
const round3 = (n: number) => Math.round(n * 1000) / 1000

export function epochMagnitude(approvedMutations: number): number {
  return round3(0.1 + 0.2 * clamp01(nonNegative(approvedMutations) / 4))
}

export function contributionMagnitude(linesChanged: number, testsPassed: boolean): number {
  return round3(0.4 + 0.3 * clamp01(nonNegative(linesChanged) / 400) + (testsPassed ? 0.1 : 0))
}

export function breakthroughMagnitude(previousBest: number, newBest: number): number {
  if (!(previousBest > 0) || !Number.isFinite(newBest)) return 0.8
  return round3(0.8 + 0.2 * clamp01((previousBest - newBest) / previousBest / 0.05))
}

export interface EpochEventRow {
  id: string
  epoch_number: number
  completed_at: string | Date | null
  assigned_executor?: string | null  // role_assignments.executor
  executor_served_by?: unknown       // executor_output.served_by
  decisions?: unknown                // reviewer_output.decisions
  review_verdict?: string | null     // research reviewer_output.verdict
  run_status?: string | null         // research_run.result.status
  val_bpb?: number | string | null   // research_run.result.metrics.val_bpb
  confirm_verdict?: string | null    // research_run.confirm.verdict: only for a run the lab repeated (research-confirm.ts)
  confirm_mean_bpb?: number | string | null // research_run.confirm.mean_bpb: the mean of the two runs
}

export interface ContributionEventRow {
  id: string
  epoch_number: number
  model_id: string
  pr_url?: string | null
  merged: boolean
  ci_passed?: boolean | null
  sprite_ran_at?: string | Date | null
  sprite_exit_code?: number | null
  lines_changed?: number | string | null
  created_at: string | Date | null
}

export interface ExhibitEventRow {
  id: string
  epoch: number
  model: string
  created_at: string | Date | null
}

function nameOf(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return modelDisplayName(modelId) || modelId.split('/').pop() || null
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const t = new Date(value)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

const KIND_ORDER: Record<GrowthEventKind, number> = {
  epoch: 0, contribution_merged: 1, contribution_rejected: 1, tests_failed: 1, exhibit_merged: 2, breakthrough: 3,
}

/**
 * Turns the stored rows into the feed: oldest first, at most the newest 400.
 * `truncated` says the epoch rows are only the newest window, so the best
 * score before the window is unknown and its first KEEP is not judged.
 * `baselineBpb` is the research baseline (current_spec.meta.research), if any.
 */
export function buildGrowthEvents(input: {
  epochs: EpochEventRow[]
  contributions: ContributionEventRow[]
  exhibits: ExhibitEventRow[]
  baselineBpb?: number | null
  truncated?: boolean
}): GrowthEvent[] {
  const events: GrowthEvent[] = []

  // Epochs in order, so the running best score is the one at the time.
  const epochs = input.epochs.slice().sort((a, b) => a.epoch_number - b.epoch_number)
  let best: number | null = !input.truncated && Number.isFinite(Number(input.baselineBpb)) && Number(input.baselineBpb) > 0
    ? Number(input.baselineBpb) : null
  for (const e of epochs) {
    const at = iso(e.completed_at)
    if (!at || !(e.epoch_number > 0)) continue // epoch 0 is the seed, not work
    // A fallback model that answered is the one credited, as answeredModel() in openrouter.ts does.
    const served = e.executor_served_by as { fallback?: boolean; model?: unknown } | null | undefined
    const model = nameOf(served?.fallback && typeof served.model === 'string' && served.model ? served.model : e.assigned_executor)
    const decisions = Array.isArray(e.decisions) ? e.decisions as Array<{ verdict?: string }> : []
    const kept = e.review_verdict === 'keep'
    const approved = kept ? 2 : decisions.filter(d => d?.verdict === 'approve' || d?.verdict === 'modify').length
    events.push({ id: `epoch:${e.id}`, kind: 'epoch', epoch: e.epoch_number, at, model, magnitude: epochMagnitude(approved), ref: e.review_verdict === 'keep' || e.review_verdict === 'revert' ? e.review_verdict : null })

    const printed = e.val_bpb === null || e.val_bpb === undefined ? NaN : Number(e.val_bpb)
    // A run the lab repeated and confirmed is on the record, and is the best
    // later runs had to beat, at the mean of its two runs, not at its first score.
    const mean = e.confirm_verdict === 'confirmed' && e.confirm_mean_bpb !== null && e.confirm_mean_bpb !== undefined && e.confirm_mean_bpb !== ''
      ? Number(e.confirm_mean_bpb) : NaN
    const measured = Number.isFinite(printed) && Number.isFinite(mean) ? mean : printed
    if (kept && e.run_status === 'ok' && Number.isFinite(measured)) {
      if (best !== null && measured < best) {
        events.push({ id: `research:${e.id}`, kind: 'breakthrough', epoch: e.epoch_number, at, model, magnitude: breakthroughMagnitude(best, measured), ref: 'keep' })
      }
      if (best === null || measured < best) best = measured
    }
  }

  for (const c of input.contributions) {
    const at = iso(c.created_at)
    if (!at) continue
    const spriteFailed = !!c.sprite_ran_at && c.sprite_exit_code !== null && c.sprite_exit_code !== undefined && c.sprite_exit_code !== 0
    const tested = c.ci_passed === true || (!!c.sprite_ran_at && c.sprite_exit_code === 0)
    const model = nameOf(c.model_id)
    const base = { id: `contribution:${c.id}`, epoch: c.epoch_number, at, model }
    if (c.merged) {
      const pr = String(c.pr_url || '').match(/\/pull\/(\d{1,9})/)
      events.push({ ...base, kind: 'contribution_merged', magnitude: contributionMagnitude(Number(c.lines_changed) || 0, tested), ref: pr ? `#${pr[1]}` : null })
    } else if (c.ci_passed === false || spriteFailed) {
      events.push({ ...base, kind: 'tests_failed', magnitude: SETBACK_MAGNITUDE, ref: c.ci_passed === false ? 'ci failed' : 'sprite failed' })
    } else if (c.pr_url) {
      // only a change that really became a pull request and was turned down counts as a setback;
      // a row with no pull request (code writes off, no files, an error) never happened in GitHub
      events.push({ ...base, kind: 'contribution_rejected', magnitude: SETBACK_MAGNITUDE, ref: 'rejected' })
    }
  }

  for (const x of input.exhibits) {
    const at = iso(x.created_at)
    if (!at) continue
    events.push({ id: `tool:${x.id}`, kind: 'exhibit_merged', epoch: x.epoch, at, model: nameOf(x.model), magnitude: EXHIBIT_MAGNITUDE, ref: null })
  }

  events.sort((a, b) =>
    Date.parse(a.at) - Date.parse(b.at) || a.epoch - b.epoch || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return events.slice(-MAX_GROWTH_EVENTS)
}

const eventsCache = new Map<string, { at: number; events: GrowthEvent[] }>()
const EVENTS_TTL_MS = 60_000
export function resetGrowthEventsCache(): void { eventsCache.clear() }

/** The feed for one experiment: three indexed, limited queries, cached a minute. Never throws. */
export async function growthEventsFor(experiment: { id: string; current_spec?: AgentSpecification }): Promise<GrowthEvent[]> {
  const cached = eventsCache.get(experiment.id)
  if (cached && Date.now() - cached.at < EVENTS_TTL_MS) return cached.events
  const id = experiment.id
  let epochs: EpochEventRow[] = []
  let contributions: ContributionEventRow[] = []
  let exhibits: ExhibitEventRow[] = []
  try {
    try {
      const r = await sql`
        SELECT id, epoch_number, completed_at, role_assignments->>'executor' AS assigned_executor,
          executor_output->'served_by' AS executor_served_by, reviewer_output->'decisions' AS decisions,
          reviewer_output->>'verdict' AS review_verdict, research_run->'result'->>'status' AS run_status,
          research_run->'result'->'metrics'->>'val_bpb' AS val_bpb,
          research_run->'confirm'->>'verdict' AS confirm_verdict, research_run->'confirm'->>'mean_bpb' AS confirm_mean_bpb
        FROM epochs WHERE experiment_id = ${id} AND completed_at IS NOT NULL
        ORDER BY epoch_number DESC LIMIT ${MAX_GROWTH_EVENTS}
      `
      epochs = r.rows as EpochEventRow[]
    } catch {
      // No research_run column yet (a classic-only database).
      const r = await sql`
        SELECT id, epoch_number, completed_at, role_assignments->>'executor' AS assigned_executor,
          executor_output->'served_by' AS executor_served_by, reviewer_output->'decisions' AS decisions
        FROM epochs WHERE experiment_id = ${id} AND completed_at IS NOT NULL
        ORDER BY epoch_number DESC LIMIT ${MAX_GROWTH_EVENTS}
      `
      epochs = r.rows as EpochEventRow[]
    }
  } catch (e) {
    console.warn('[growth] could not read epochs for the growth events:', e instanceof Error ? e.message : e)
  }
  // Lines written: every line of every file the author and subagent pushed.
  try {
    try {
      const r = await sql`
        SELECT id, epoch_number, model_id, pr_url, merged, ci_passed, sprite_ran_at, sprite_exit_code, created_at,
          (SELECT COALESCE(SUM(LENGTH(f->>'content') - LENGTH(REPLACE(f->>'content', chr(10), '')) + 1), 0)
           FROM jsonb_array_elements(files || COALESCE(subagent_files, '[]'::jsonb)) AS f) AS lines_changed
        FROM code_contributions WHERE experiment_id = ${id}
        ORDER BY epoch_number DESC, created_at DESC LIMIT ${MAX_GROWTH_EVENTS}
      `
      contributions = r.rows as ContributionEventRow[]
    } catch {
      // An older table without the sprite columns.
      const r = await sql`
        SELECT id, epoch_number, model_id, pr_url, merged, ci_passed, created_at,
          (SELECT COALESCE(SUM(LENGTH(f->>'content') - LENGTH(REPLACE(f->>'content', chr(10), '')) + 1), 0)
           FROM jsonb_array_elements(files || COALESCE(subagent_files, '[]'::jsonb)) AS f) AS lines_changed
        FROM code_contributions WHERE experiment_id = ${id}
        ORDER BY epoch_number DESC, created_at DESC LIMIT ${MAX_GROWTH_EVENTS}
      `
      contributions = r.rows as ContributionEventRow[]
    }
  } catch {
    // no contributions table yet
  }
  try {
    const r = await sql`
      SELECT id, epoch, model, created_at FROM tool_runs
      WHERE experiment_id = ${id} AND tool = 'exhibit' AND status = 'merged'
      ORDER BY epoch DESC LIMIT ${MAX_GROWTH_EVENTS}
    `
    exhibits = r.rows as ExhibitEventRow[]
  } catch {
    // no tool_runs table yet
  }
  const baseline = Number(experiment.current_spec?.meta?.research?.baseline_bpb)
  const events = buildGrowthEvents({
    epochs, contributions, exhibits,
    baselineBpb: Number.isFinite(baseline) ? baseline : null,
    truncated: epochs.length >= MAX_GROWTH_EVENTS,
  })
  eventsCache.set(id, { at: Date.now(), events })
  return events
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
