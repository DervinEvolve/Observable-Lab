/**
 * Two kinds of experiment, and which one a request means.
 *
 * An experiment is in research mode when its spec carries `meta.research`
 * (the ML research loop, research-epoch.ts); every other experiment is a
 * classic one (five models grow the agent spec). The mode is read from the
 * stored spec, so no column or migration is involved. In SQL it is always
 * the same expression:
 *
 *   jsonb_typeof(current_spec->'meta'->'research') = 'object'              research
 *   jsonb_typeof(current_spec->'meta'->'research') IS DISTINCT FROM 'object'  classic
 *
 * The room, the graph and the operator routes all mean the classic
 * experiment. They pick "the newest active classic experiment, or the newest
 * active one when there is no classic": with one active experiment that is
 * the same row as before, and with research running beside run 2 it stays
 * run 2. The ordering is written out in each query because the SQL tag takes
 * no fragments:
 *
 *   ORDER BY (jsonb_typeof(current_spec->'meta'->'research') IS NOT DISTINCT FROM 'object'), created_at DESC
 *
 * LAB_RESEARCH_ALONGSIDE (off unless "true") lets one research experiment
 * run beside the classic one: the tick advances both, and each has its own
 * daily cap (spend.ts).
 */
import { sql } from '@vercel/postgres'

export type ExperimentMode = 'classic' | 'research'

/** Research beside the classic experiment: on only when the flag is exactly "true". */
export function researchAlongside(): boolean {
  return (process.env.LAB_RESEARCH_ALONGSIDE || '').trim().toLowerCase() === 'true'
}

/** The stored mode of one experiment. An unknown id reads as classic. */
export async function experimentMode(experimentId: string): Promise<ExperimentMode> {
  const r = await sql`
    SELECT jsonb_typeof(current_spec->'meta'->'research') AS research FROM experiments WHERE id = ${experimentId}
  `
  return r.rows[0]?.research === 'object' ? 'research' : 'classic'
}

/**
 * Which daily cap an experiment's work counts against, and so which mark its
 * ledger rows get (spend.ts). With the flag off there is one cap, nothing is
 * marked and no lookup is made.
 */
export async function budgetScopeFor(experimentId: string): Promise<ExperimentMode> {
  return researchAlongside() ? experimentMode(experimentId) : 'classic'
}

/** The newest active experiment of one mode, if any. */
export async function activeExperimentId(mode: ExperimentMode): Promise<string | null> {
  const r = mode === 'research'
    ? await sql`
      SELECT id FROM experiments
      WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') = 'object'
      ORDER BY created_at DESC LIMIT 1
    `
    : await sql`
      SELECT id FROM experiments
      WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') IS DISTINCT FROM 'object'
      ORDER BY created_at DESC LIMIT 1
    `
  return (r.rows[0]?.id as string | undefined) ?? null
}

export type TickSlot = 'primary' | ExperimentMode

/**
 * The experiment a tick advances, with the time its last epoch ended.
 * `primary` is what the tick has always run; `classic` and `research` are
 * the two slots when research runs alongside.
 */
export async function loadTickExperiment(slot: TickSlot): Promise<Record<string, any> | null> {
  const r = slot === 'research'
    ? await sql`
      SELECT e.*,
        (SELECT completed_at FROM epochs WHERE experiment_id = e.id ORDER BY epoch_number DESC LIMIT 1) as last_epoch_at
      FROM experiments e
      WHERE e.status <> 'archived' AND jsonb_typeof(e.current_spec->'meta'->'research') = 'object'
      ORDER BY e.created_at DESC
      LIMIT 1
    `
    : slot === 'classic'
    ? await sql`
      SELECT e.*,
        (SELECT completed_at FROM epochs WHERE experiment_id = e.id ORDER BY epoch_number DESC LIMIT 1) as last_epoch_at
      FROM experiments e
      WHERE e.status <> 'archived' AND jsonb_typeof(e.current_spec->'meta'->'research') IS DISTINCT FROM 'object'
      ORDER BY e.created_at DESC
      LIMIT 1
    `
    : await sql`
      SELECT e.*,
        (SELECT completed_at FROM epochs WHERE experiment_id = e.id ORDER BY epoch_number DESC LIMIT 1) as last_epoch_at
      FROM experiments e
      WHERE e.status <> 'archived'
      ORDER BY (jsonb_typeof(e.current_spec->'meta'->'research') IS NOT DISTINCT FROM 'object'), e.created_at DESC
      LIMIT 1
    `
  return r.rows[0] ?? null
}
