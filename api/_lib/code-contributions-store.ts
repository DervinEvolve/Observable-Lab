import { sql } from '@vercel/postgres'
import type { ContributionResult } from './code-contribution.js'
import type { RepoFile } from './github-repo.js'

// Persists real code contributions so the frontend can poll for them and
// stream the actual written code into a model's terminal screen — replacing
// the old fully-fake canned command simulation with what was really written.
// Once per warm instance: the public endpoint calls this on every poll.
let tableReady: Promise<void> | null = null
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = createOrPatchTable().catch(e => {
      tableReady = null
      throw e
    })
  }
  return tableReady
}

async function createOrPatchTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS code_contributions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      experiment_id UUID NOT NULL,
      epoch_number INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      pr_url TEXT,
      merged BOOLEAN NOT NULL,
      files JSONB NOT NULL,
      subagent_files JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_code_contrib_experiment ON code_contributions(experiment_id, epoch_number)`
  // Added after the table already existed in production — patch it in place.
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS explorer_task TEXT`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS explorer_findings TEXT`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS web_searches JSONB DEFAULT '[]'`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS web_sources JSONB DEFAULT '[]'`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS ci_passed BOOLEAN`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS ci_excerpt TEXT`
  // Sprite test run for the contribution's branch (sprites.ts). exit 0 means
  // the tests passed; sprite_ran_at NULL means nothing ran ("not run").
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS sprite_exit_code INTEGER`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS sprite_duration_ms INTEGER`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS sprite_output_tail TEXT`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS sprite_name TEXT`
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS sprite_ran_at TIMESTAMP WITH TIME ZONE`
  // Why the contribution stopped short of a pull request, when it did.
  await sql`ALTER TABLE code_contributions ADD COLUMN IF NOT EXISTS error TEXT`
}

export async function persistContribution(
  experimentId: string,
  epochNumber: number,
  modelId: string,
  branch: string,
  result: ContributionResult
): Promise<void> {
  const sprite = result.sprite
  try {
    await ensureTable()
    await sql`
      INSERT INTO code_contributions (
        experiment_id, epoch_number, model_id, author_name, branch, pr_url, merged, files, subagent_files,
        explorer_task, explorer_findings, web_searches, web_sources, ci_passed, ci_excerpt,
        sprite_exit_code, sprite_duration_ms, sprite_output_tail, sprite_name, sprite_ran_at, error
      ) VALUES (
        ${experimentId}, ${epochNumber}, ${modelId}, ${result.author}, ${branch},
        ${result.pr_url || null}, ${result.merged},
        ${JSON.stringify(result.files)}, ${JSON.stringify(result.subagent_files)},
        ${result.explorer_task || null}, ${result.explorer_findings || null},
        ${JSON.stringify(result.web_searches || [])}, ${JSON.stringify(result.web_sources || [])},
        ${result.ci_passed ?? null}, ${result.ci_excerpt || null},
        ${sprite?.exit_code ?? null}, ${sprite?.duration_ms ?? null}, ${sprite?.output_tail ?? null},
        ${sprite?.sprite_name ?? null}, ${sprite?.ran_at ?? null}, ${result.error ?? null}
      )
    `
  } catch (e) {
    console.warn('[code-contributions-store] persist failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

export interface ContributionRow {
  id: string
  epoch_number: number
  model_id: string
  author_name: string
  branch: string
  pr_url: string | null
  merged: boolean
  files: RepoFile[]
  subagent_files: RepoFile[]
  explorer_task: string | null
  explorer_findings: string | null
  web_searches: string[]
  web_sources: Array<{ url: string; title: string }>
  ci_passed: boolean | null
  ci_excerpt: string | null
  sprite_exit_code: number | null
  sprite_duration_ms: number | null
  sprite_output_tail: string | null
  sprite_name: string | null
  sprite_ran_at: string | null
  error: string | null
  created_at: string
}

// Recent CI failures — injected into the next epoch's shared context so the
// models learn from real runtime errors instead of repeating them.
export async function getRecentCIFailures(experimentId: string, limit = 3): Promise<Array<{ epoch_number: number; author_name: string; branch: string; ci_excerpt: string }>> {
  try {
    await ensureTable()
    const result = await sql`
      SELECT epoch_number, author_name, branch, ci_excerpt
      FROM code_contributions
      WHERE experiment_id = ${experimentId} AND ci_passed = FALSE AND ci_excerpt IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    return result.rows as unknown as Array<{ epoch_number: number; author_name: string; branch: string; ci_excerpt: string }>
  } catch {
    return []
  }
}

export async function getRecentContributions(experimentId: string, sinceEpoch = 0, limit = 20): Promise<ContributionRow[]> {
  try {
    await ensureTable()
    const result = await sql`
      SELECT id, epoch_number, model_id, author_name, branch, pr_url, merged, files, subagent_files,
        explorer_task, explorer_findings, web_searches, web_sources, ci_passed, ci_excerpt,
        sprite_exit_code, sprite_duration_ms, sprite_output_tail, sprite_name, sprite_ran_at, error, created_at
      FROM code_contributions
      WHERE experiment_id = ${experimentId} AND epoch_number >= ${sinceEpoch}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    return result.rows as unknown as ContributionRow[]
  } catch (e) {
    console.warn('[code-contributions-store] read failed (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

export type SpriteRunRow = Pick<ContributionRow,
  'id' | 'epoch_number' | 'model_id' | 'author_name' | 'branch' | 'pr_url' | 'merged' | 'ci_passed' |
  'sprite_exit_code' | 'sprite_duration_ms' | 'sprite_output_tail' | 'sprite_name' | 'sprite_ran_at' | 'created_at'>

// Latest contributions whose branch really ran in a sprite (newest first),
// without file contents: this is what the room polls.
export async function getRecentSpriteRuns(experimentId: string, limit = 5): Promise<SpriteRunRow[]> {
  try {
    await ensureTable()
    const result = await sql`
      SELECT id, epoch_number, model_id, author_name, branch, pr_url, merged, ci_passed,
        sprite_exit_code, sprite_duration_ms, sprite_output_tail, sprite_name, sprite_ran_at, error, created_at
      FROM code_contributions
      WHERE experiment_id = ${experimentId} AND sprite_ran_at IS NOT NULL
      ORDER BY sprite_ran_at DESC
      LIMIT ${limit}
    `
    return result.rows as unknown as SpriteRunRow[]
  } catch (e) {
    console.warn('[code-contributions-store] sprite run read failed (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}
