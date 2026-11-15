import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { buildEpochActivity } from '../_lib/activity.js'

// GET /api/experiment/activity                 the latest epoch
// GET /api/experiment/activity?epoch=N         one epoch
// GET /api/experiment/activity?all=true        every epoch of the run (up to 500), for research export
//
// Public and read-only, like the rest of the observer endpoints: what each
// model did in an epoch (searches it reported beside the pages OpenRouter
// recorded it citing, Sprite commands and their output, its pull request
// and test results, and its real cost), with the places where its own
// account and the record disagree marked as flags. See api/_lib/activity.ts.

const MAX_EPOCHS = 500

async function rowsOrEmpty(query: Promise<{ rows: Record<string, any>[] }>): Promise<Record<string, any>[]> {
  try {
    return (await query).rows
  } catch {
    return [] // the table doesn't exist yet in this database
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const exp = (await sql`
      SELECT id, current_epoch FROM experiments WHERE status <> 'archived' ORDER BY created_at DESC LIMIT 1
    `).rows[0]
    if (!exp) return res.status(404).json({ error: 'No active experiment' })

    const all = req.query.all === 'true' || req.query.all === '1'
    let from: number
    let to: number
    if (all) {
      from = 1
      to = MAX_EPOCHS
    } else {
      const raw = typeof req.query.epoch === 'string' ? req.query.epoch : 'latest'
      const n = raw === 'latest' ? NaN : Number(raw)
      if (raw !== 'latest' && (!Number.isInteger(n) || n < 0)) return res.status(400).json({ error: 'epoch must be a whole number or "latest"' })
      if (raw === 'latest') {
        const latest = (await sql`
          SELECT MAX(epoch_number) AS n FROM epochs WHERE experiment_id = ${exp.id} AND epoch_number > 0
        `).rows[0]
        if (latest?.n === null || latest?.n === undefined) return res.status(200).json({ experiment_id: exp.id, epochs: [] })
        from = to = Number(latest.n)
      } else {
        from = to = n
      }
    }

    const epochs = (await sql`
      SELECT * FROM epochs
      WHERE experiment_id = ${exp.id} AND epoch_number BETWEEN ${from} AND ${to}
      ORDER BY epoch_number ASC
      LIMIT ${MAX_EPOCHS}
    `).rows
    if (!epochs.length && !all) return res.status(404).json({ error: 'No such epoch' })

    const toolRuns = await rowsOrEmpty(sql`
      SELECT epoch, model, tool, request_summary, status, exit_code, duration_ms, cost_usd, output_tail, created_at
      FROM tool_runs WHERE experiment_id = ${exp.id} AND epoch BETWEEN ${from} AND ${to}
      ORDER BY created_at ASC
    `)
    const contributions = await rowsOrEmpty(sql`
      SELECT epoch_number, author_name, branch, pr_url, merged, ci_passed, sprite_exit_code, sprite_ran_at,
        explorer_task, web_searches, web_sources
      FROM code_contributions WHERE experiment_id = ${exp.id} AND epoch_number BETWEEN ${from} AND ${to}
      ORDER BY created_at ASC
    `)
    const spend = await rowsOrEmpty(sql`
      SELECT epoch_number, model_id, purpose, COUNT(*) AS requests, SUM(cost_usd) AS cost_usd,
        SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
      FROM model_calls WHERE experiment_id = ${exp.id} AND epoch_number BETWEEN ${from} AND ${to}
      GROUP BY epoch_number, model_id, purpose
    `)

    const activity = epochs.map(epoch => buildEpochActivity({
      epoch,
      toolRuns: toolRuns.filter(r => Number(r.epoch) === Number(epoch.epoch_number)),
      contributions: contributions.filter(c => Number(c.epoch_number) === Number(epoch.epoch_number)),
      spend: spend.filter(s => Number(s.epoch_number) === Number(epoch.epoch_number)),
    }))

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=40')
    return res.status(200).json({
      experiment_id: exp.id,
      about: '"claimed" fields are the model\'s own report; "recorded" fields were logged by the lab or OpenRouter. Flags mark where they disagree.',
      epochs: activity,
    })
  } catch (error) {
    console.error('[API] Error building the activity record:', error instanceof Error ? error.message : error)
    return res.status(500).json({ error: 'Failed to load the activity record' })
  }
}
