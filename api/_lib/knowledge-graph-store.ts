import { sql } from '@vercel/postgres'
import { buildGraph, type ContributionRowLike, type EpochRowLike, type KnowledgeGraph } from './knowledge-graph.js'

// Loads the knowledge graph of one experiment from the stored epochs and code
// contributions (knowledge-graph.ts builds it). Kept for a minute per
// function instance: the graph only changes when an epoch finishes.

const MAX_EPOCHS = 500
const CACHE_MS = 60_000
let cache: { at: number; experimentId: string; graph: KnowledgeGraph } | null = null

async function rowsOrEmpty(query: Promise<{ rows: Record<string, any>[] }>): Promise<Record<string, any>[]> {
  try {
    return (await query).rows
  } catch {
    return [] // the table doesn't exist yet in this database
  }
}

export async function loadGraph(experimentId: string, fresh = false): Promise<KnowledgeGraph> {
  if (!fresh && cache && cache.experimentId === experimentId && Date.now() - cache.at < CACHE_MS) return cache.graph
  const epochs = (await sql`
    SELECT epoch_number, role_assignments, planner_output, executor_output, challenger_output,
      executor_rebuttal, reviewer_output, commentator_output, spec_after
    FROM epochs WHERE experiment_id = ${experimentId} AND epoch_number > 0 AND completed_at IS NOT NULL
    ORDER BY epoch_number ASC LIMIT ${MAX_EPOCHS}
  `).rows as unknown as EpochRowLike[]
  // The error column arrived later (code-contributions-store.ts adds it); read without it on an older table.
  let contributions = await rowsOrEmpty(sql`
    SELECT epoch_number, model_id, author_name, branch, pr_url, merged, ci_passed, error
    FROM code_contributions WHERE experiment_id = ${experimentId} ORDER BY created_at ASC
  `) as unknown as ContributionRowLike[]
  if (!contributions.length) {
    contributions = await rowsOrEmpty(sql`
      SELECT epoch_number, model_id, author_name, branch, pr_url, merged, ci_passed
      FROM code_contributions WHERE experiment_id = ${experimentId} ORDER BY created_at ASC
    `) as unknown as ContributionRowLike[]
  }
  const graph = buildGraph({ epochs, contributions })
  cache = { at: Date.now(), experimentId, graph }
  return graph
}
