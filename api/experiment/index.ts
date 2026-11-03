import { requireBearer } from '../_lib/auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { getRoleAssignments } from '../_lib/role-rotation.js'
import { generatePlantFromSpec, generateSeedPlant } from '../_lib/plant-generator.js'
import { SEED_SPECIFICATION } from '../_lib/seed-spec.js'
import { getRepoCommitCount } from '../_lib/github-repo.js'
import type { ExperimentState, Epoch, AgentSpecification } from '../_lib/types.js'

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
      ORDER BY created_at DESC
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
    }

    return res.status(200).json(response)
  } catch (error) {
    console.error('[API] Error fetching experiment:', error)
    return res.status(500).json({ error: 'Failed to load experiment' })
  }
}

// POST /api/experiment - Start a new experiment (seed)
async function handlePost(_req: VercelRequest, res: VercelResponse) {
  try {
    // Check if there's already an active experiment
    const existingResult = await sql`
      SELECT id FROM experiments WHERE status IN ('seeding', 'growing') LIMIT 1
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

