import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import {
  getRecentContributions,
  getRecentSpriteRuns,
  type ContributionRow,
  type SpriteRunRow,
} from '../_lib/code-contributions-store.js'
import { sanitizeOutput, spriteRunStatus } from '../_lib/sprites.js'

// GET /api/experiment/code-contributions?since_epoch=N
//   Real code (files + content) that scientists/wildcards have actually pushed
//   to AI-Agent, for the frontend to stream into the matching terminal screen.
// GET /api/experiment/code-contributions?sprite_runs=1
//   Only the latest contributions whose branch ran in a sprite, without file
//   contents. The room polls this for the desk terminals.
// Public and read-only. Output text is cleaned again on the way out (ANSI
// codes stripped, anything that looks like a credential replaced).

function spriteView(row: Pick<ContributionRow, 'sprite_exit_code' | 'sprite_duration_ms' | 'sprite_output_tail' | 'sprite_name' | 'sprite_ran_at'>) {
  const exit = row.sprite_exit_code === null || row.sprite_exit_code === undefined ? null : Number(row.sprite_exit_code)
  const ranAt = row.sprite_ran_at ? new Date(row.sprite_ran_at).toISOString() : null
  return {
    status: spriteRunStatus({ sprite_exit_code: exit, sprite_ran_at: ranAt }),
    exit_code: exit,
    duration_ms: row.sprite_duration_ms === null || row.sprite_duration_ms === undefined ? null : Number(row.sprite_duration_ms),
    output_tail: row.sprite_output_tail ? sanitizeOutput(row.sprite_output_tail) : null,
    sprite_name: row.sprite_name,
    ran_at: ranAt,
  }
}

function contributionView(row: ContributionRow) {
  const { sprite_exit_code, sprite_duration_ms, sprite_output_tail, sprite_name, sprite_ran_at, ...rest } = row
  return {
    ...rest,
    ci_excerpt: row.ci_excerpt ? sanitizeOutput(row.ci_excerpt) : null,
    sprite: spriteView({ sprite_exit_code, sprite_duration_ms, sprite_output_tail, sprite_name, sprite_ran_at }),
  }
}

function spriteRunView(row: SpriteRunRow) {
  return {
    id: row.id,
    epoch_number: row.epoch_number,
    model_id: row.model_id,
    author_name: row.author_name,
    branch: row.branch,
    pr_url: row.pr_url,
    merged: row.merged,
    ci_passed: row.ci_passed,
    sprite: spriteView(row),
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const experimentResult = await sql`
      SELECT id FROM experiments WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1
    `
    const experiment = experimentResult.rows[0]
    const spriteRunsOnly = req.query.sprite_runs === '1' || req.query.sprite_runs === 'true'
    // Same for every viewer; a short shared cache keeps polling cheap.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=40')

    if (spriteRunsOnly) {
      const runs = experiment ? await getRecentSpriteRuns(experiment.id, 5) : []
      return res.status(200).json({ sprite_runs: runs.map(spriteRunView) })
    }

    if (!experiment) {
      return res.status(200).json({ contributions: [] })
    }

    const parsed = parseInt((req.query.since_epoch as string) || '0', 10)
    const sinceEpoch = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
    const contributions = await getRecentContributions(experiment.id, sinceEpoch)

    return res.status(200).json({ contributions: contributions.map(contributionView) })
  } catch (error) {
    console.error('[API] Error fetching code contributions:', error instanceof Error ? error.message : error)
    return res.status(500).json({ error: 'Failed to load code contributions' })
  }
}
