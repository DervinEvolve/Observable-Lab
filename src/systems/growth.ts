// How far the specimen has taken over the room. The backend measures this from
// stored epochs and reports it in GET /api/experiment as `growth`; the room only
// ever draws what that record says. The local simulation never sets it.
//
// Stages: 0 contained seedling, 1 grown inside the dome, 2 pressing on the
// glass, 3 broken out, 4 roots across the floor, 5 climbing walls and desks,
// 6 canopy across the ceiling.

export const GROWTH_STAGES = 6

export interface ExperimentGrowth {
  stage: number // 0..6
  progress: number // 0..1 within the stage
  epochs?: number
  capabilities?: number
  constraints?: number
  behaviors?: number
  stability?: number
  merged_contributions?: number
  contributions_with_passing_tests?: number
  sprite_test_passes?: number
  glass_shattered?: boolean
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Validates the `growth` object of the experiment state. Returns null when absent or malformed. */
export function parseGrowth(raw: unknown): ExperimentGrowth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const stage = num(o.stage)
  if (stage === undefined) return null
  const progress = num(o.progress) ?? 0
  return {
    stage: Math.min(GROWTH_STAGES, Math.max(0, Math.floor(stage))),
    progress: Math.min(1, Math.max(0, progress)),
    epochs: num(o.epochs),
    capabilities: num(o.capabilities),
    constraints: num(o.constraints),
    behaviors: num(o.behaviors),
    stability: num(o.stability),
    merged_contributions: num(o.merged_contributions),
    contributions_with_passing_tests: num(o.contributions_with_passing_tests),
    sprite_test_passes: num(o.sprite_test_passes),
    glass_shattered: o.glass_shattered === true,
  }
}

/** One continuous number for the whole escalation: stage + progress, 0..7. */
export function growthLevel(g: ExperimentGrowth): number {
  return Math.min(GROWTH_STAGES + 1, g.stage + g.progress)
}
