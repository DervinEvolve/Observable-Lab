import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { getRoleAssignments } from '../_lib/role-rotation.js'
import { generatePlantFromSpec, generateSeedPlant } from '../_lib/plant-generator.js'
import { SEED_SPECIFICATION } from '../_lib/seed-spec.js'
import { getRepoCommitCount } from '../_lib/github-repo.js'
import type { ExperimentState, Epoch, AgentSpecification } from '../_lib/types.js'
import { checkDailyBudget, describeRunState, type BudgetStatus } from '../_lib/spend.js'
import { computeGrowth, growthEventsFor, growthFactsFor, repoLinks } from '../_lib/growth.js'
import { getRecentToolRuns } from '../_lib/tool-runs-store.js'
import { enabledTools } from '../_lib/tools-config.js'
import { trainedChatStatus } from '../_lib/tinker.js'
import { exhibitsHandler } from '../_lib/exhibits-reader.js'
import { researchAlongside } from '../_lib/experiment-modes.js'
import { researchRunState, researchSummary } from '../_lib/research-alongside.js'

// Viewers poll this endpoint; the budget is read at most once a minute per instance.
let budgetCache: { at: number; status: BudgetStatus } | null = null
async function cachedBudget(): Promise<BudgetStatus | null> {
  if (budgetCache && Date.now() - budgetCache.at < 60_000) return budgetCache.status
  try {
    const status = await checkDailyBudget()
    budgetCache = { at: Date.now(), status }
    return status
  } catch {
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if ((req.method === 'POST' || req.query.debug === 'true') && !requireBearer(req, res)) return

  // Debug mode - check database state (v2)
  if (req.query.debug === 'true') {
    console.log('[DEBUG] Debug mode triggered')
    return handleDebug(res)
  }

  // Version check
  if (req.query.version === 'true') {
    return res.status(200).json({ version: 'v2-debug', timestamp: Date.now() })
  }

  // GET /api/experiment?view=exhibits: the merged exhibits for the room
  // (docs/EXHIBITS.md). Same body the contract's /api/experiment/exhibits
  // route describes; that route needs its entry in the public route list
  // before it can exist, so it is served from here meanwhile.
  if (req.method === 'GET' && req.query.view === 'exhibits') {
    return exhibitsHandler(req, res)
  }

  // GET /api/experiment?mode=research: the research experiment's own state
  // (it can run beside the classic one, see LAB_RESEARCH_ALONGSIDE). Without
  // the parameter this endpoint is the classic experiment, as always.
  if (req.method === 'GET' && req.query.mode === 'research') {
    return handleGetResearch(res)
  }

  if (req.method === 'GET') {
    return handleGet(req, res)
  } else if (req.method === 'POST') {
    return handlePost(req, res)
  } else {
    return res.status(405).json({ error: 'Method not allowed' })
  }
}

// Debug handler to check database state
async function handleDebug(res: VercelResponse) {
  try {
    const experimentsResult = await sql`
      SELECT id, status, current_epoch, created_at, glass_shattered
      FROM experiments
      ORDER BY created_at DESC
      LIMIT 10
    `

    const epochsResult = await sql`
      SELECT experiment_id, COUNT(*) as epoch_count, MAX(epoch_number) as max_epoch
      FROM epochs
      GROUP BY experiment_id
    `

    return res.status(200).json({
      experiments: experimentsResult.rows,
      epoch_stats: epochsResult.rows,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[DEBUG] Error:', error)
    return res.status(500).json({
      error: 'Database query failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

// GET /api/experiment - Returns current state for frontend polling
async function handleGet(_req: VercelRequest, res: VercelResponse) {
  try {
    const experimentResult = await sql`
      SELECT e.*,
        (SELECT json_agg(ep.* ORDER BY ep.epoch_number DESC)
         FROM (SELECT * FROM epochs WHERE experiment_id = e.id ORDER BY epoch_number DESC LIMIT 5) ep
        ) as recent_epochs
      FROM experiments e
      WHERE e.status != 'archived'
      ORDER BY (jsonb_typeof(e.current_spec->'meta'->'research') IS NOT DISTINCT FROM 'object'), e.created_at DESC
      LIMIT 1
    `

    if (!experimentResult.rows[0]) {
      return res.status(404).json({ error: 'No active experiment' })
    }

    const exp = experimentResult.rows[0]
    const currentSpec = exp.current_spec as AgentSpecification

    // Calculate epoch progress if in progress
    let epochProgress: number | undefined
    if (exp.epoch_in_progress && exp.epoch_started_at) {
      const startTime = new Date(exp.epoch_started_at).getTime()
      const elapsed = Date.now() - startTime
      const estimatedDuration = 120000 // 2 minutes estimated epoch duration
      epochProgress = Math.min(elapsed / estimatedDuration, 0.95) // Cap at 95% until complete
    }

    // Get or compute plant geometry
    let plantGeometry = null
    if (exp.recent_epochs && exp.recent_epochs.length > 0) {
      // Use pre-computed geometry from latest completed epoch
      const latestEpoch = exp.recent_epochs.find((e: Epoch) => e.plant_geometry)
      plantGeometry = latestEpoch?.plant_geometry
    }
    if (!plantGeometry) {
      // Compute from current spec
      plantGeometry = generatePlantFromSpec(currentSpec)
    }

    // Real commit count from the AI-Agent repo (cached; null on GitHub errors)
    const repoCommitCount = await getRepoCommitCount()

    // Plain run state, and how far the specimen has taken over the room,
    // both from stored facts only.
    const runState = describeRunState(exp as { status: string; epoch_in_progress?: boolean | null }, await cachedBudget())
    const growth = computeGrowth(await growthFactsFor(exp as Parameters<typeof growthFactsFor>[0]))
    // What the models' tools really did (Sprite sessions, GPU jobs, subagents,
    // exhibits, proposals), cleaned of anything that looks like a credential.
    const toolRuns = await getRecentToolRuns(exp.id as string, 12)
    // What each step of the growth really was (docs/GROWTH.md), from stored records.
    const growthEvents = await growthEventsFor({ id: exp.id as string, current_spec: currentSpec })

    const response: ExperimentState = {
      id: exp.id,
      status: exp.status,
      current_epoch: exp.current_epoch,
      epoch_in_progress: exp.epoch_in_progress,
      epoch_progress: epochProgress,
      current_spec: currentSpec,
      plant_geometry: plantGeometry,
      recent_epochs: exp.recent_epochs || [],
      role_assignments: getRoleAssignments(exp.current_epoch + 1),
      glass_shattered: exp.glass_shattered || false,
      ...(repoCommitCount !== null ? { repo_commit_count: repoCommitCount } : {}),
      ...runState,
      growth,
      repos: repoLinks(),
    }

    // Research running beside this experiment, in brief (only with the flag on,
    // and only when this is not the research experiment itself).
    const research = researchAlongside() && !currentSpec.meta.research ? await researchSummary() : null

    return res.status(200).json({
      ...response, growth_events: growthEvents, tool_runs: toolRuns, tools_enabled: enabledTools(),
      // Present only while the visitor chat with trained adapters is switched
      // on. The room's chat panel calls its own route only after seeing this.
      ...(trainedChatStatus().enabled ? { trained_chat_enabled: true } : {}),
      ...(research ? { research } : {}),
    })
  } catch (error) {
    console.error('[API] Error fetching experiment:', error)
    return res.status(500).json({ error: 'Failed to load experiment' })
  }
}

// GET /api/experiment?mode=research - The active research experiment, in the
// same shape as the classic state minus what only the specimen has (growth,
// tool runs, the commit count). Like the classic state it carries no budget
// or spend totals; each recent epoch has its cost_usd, as it does there.
async function handleGetResearch(res: VercelResponse) {
  try {
    const experimentResult = await sql`
      SELECT e.*,
        (SELECT json_agg(ep.* ORDER BY ep.epoch_number DESC)
         FROM (SELECT * FROM epochs WHERE experiment_id = e.id ORDER BY epoch_number DESC LIMIT 5) ep
        ) as recent_epochs
      FROM experiments e
      WHERE e.status != 'archived' AND jsonb_typeof(e.current_spec->'meta'->'research') = 'object'
      ORDER BY e.created_at DESC
      LIMIT 1
    `
    const exp = experimentResult.rows[0]
    if (!exp) {
      return res.status(404).json({ error: 'No active research experiment' })
    }
    const currentSpec = exp.current_spec as AgentSpecification
    const recent = (exp.recent_epochs || []) as Epoch[]

    let epochProgress: number | undefined
    if (exp.epoch_in_progress && exp.epoch_started_at) {
      // A research epoch is mostly its GPU run: about ten minutes end to end.
      epochProgress = Math.min((Date.now() - new Date(exp.epoch_started_at).getTime()) / 600000, 0.95)
    }
    const plantGeometry = recent.find(e => e.plant_geometry)?.plant_geometry ?? generatePlantFromSpec(currentSpec)
    const runState = await researchRunState(exp as { status: string; epoch_in_progress?: boolean | null })

    const response: ExperimentState = {
      id: exp.id,
      status: exp.status,
      current_epoch: exp.current_epoch,
      epoch_in_progress: exp.epoch_in_progress,
      epoch_progress: epochProgress,
      current_spec: currentSpec,
      plant_geometry: plantGeometry,
      recent_epochs: recent,
      role_assignments: getRoleAssignments(exp.current_epoch + 1),
      ...runState,
      repos: repoLinks(),
    }
    return res.status(200).json({ mode: 'research', alongside: researchAlongside(), ...response })
  } catch (error) {
    console.error('[API] Error fetching the research experiment:', error)
    return res.status(500).json({ error: 'Failed to load experiment' })
  }
}

// POST /api/experiment - Start a new experiment (seed)
async function handlePost(_req: VercelRequest, res: VercelResponse) {
  try {
    // Refuse while any experiment is active (seeding, growing, stable or
    // failing). /api/experiment/reset archives the old one first. With
    // research running alongside, only another classic experiment is in the way.
    const existingResult = researchAlongside()
      ? await sql`
        SELECT id FROM experiments
        WHERE status <> 'archived' AND jsonb_typeof(current_spec->'meta'->'research') IS DISTINCT FROM 'object'
        ORDER BY created_at DESC LIMIT 1
      `
      : await sql`
      SELECT id FROM experiments WHERE status <> 'archived' ORDER BY created_at DESC LIMIT 1
    `

    if (existingResult.rows[0]) {
      return res.status(400).json({
        error: 'Active experiment already exists',
        experiment_id: existingResult.rows[0].id,
      })
    }

    // Create new experiment with seed specification
    const plantGeometry = generateSeedPlant()

    const result = await sql`
      INSERT INTO experiments (status, current_spec, current_epoch)
      VALUES ('seeding', ${JSON.stringify(SEED_SPECIFICATION)}, 0)
      RETURNING id
    `

    const experimentId = result.rows[0].id

    // Create initial epoch record (epoch 0)
    await sql`
      INSERT INTO epochs (
        experiment_id,
        epoch_number,
        role_assignments,
        spec_before,
        spec_after,
        plant_geometry,
        completed_at
      )
      VALUES (
        ${experimentId},
        0,
        ${JSON.stringify(getRoleAssignments(0))},
        ${JSON.stringify(SEED_SPECIFICATION)},
        ${JSON.stringify(SEED_SPECIFICATION)},
        ${JSON.stringify(plantGeometry)},
        NOW()
      )
    `

    return res.status(201).json({
      id: experimentId,
      message: 'Experiment seeded successfully',
    })
  } catch (error) {
    console.error('[API] Error creating experiment:', error)
    return res.status(500).json({ error: 'Failed to create experiment' })
  }
}

