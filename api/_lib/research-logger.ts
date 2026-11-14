import { sql } from '@vercel/postgres'
import type {
  EpochLog,
  AgentSpecification,
  PlannerOutput,
  ExecutorOutput,
  ChallengerOutput,
  ReviewerOutput,
  CommentatorOutput,
  RoleAssignments,
} from './types.js'
import { modelDisplayName } from './types.js'

// Display names for cleaner logs (the shared map in types.ts).
const MODEL_NAMES = {
  get(id: string): string { return modelDisplayName(id) || id },
}

// epoch_logs used to be keyed on epoch_number alone, so every new experiment
// overwrote the previous one's logs. It is keyed per experiment now; rows
// written before this have a NULL experiment_id and are kept as they are.
let tableReady: Promise<void> | null = null
export function ensureEpochLogsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS epoch_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          experiment_id UUID,
          epoch_number INTEGER NOT NULL,
          timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
          log_data JSONB NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `
      await sql`ALTER TABLE epoch_logs ADD COLUMN IF NOT EXISTS experiment_id UUID`
      await sql`ALTER TABLE epoch_logs DROP CONSTRAINT IF EXISTS epoch_logs_epoch_number_key`
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_epoch_logs_experiment_epoch ON epoch_logs(experiment_id, epoch_number)`
    })().catch(e => {
      tableReady = null
      throw e
    })
  }
  return tableReady
}

interface LogEpochParams {
  experimentId: string
  epochNumber: number
  startTime: Date
  endTime: Date
  roleAssignments: RoleAssignments
  plannerOutput: PlannerOutput
  executorOutput: ExecutorOutput
  challengerOutput: ChallengerOutput
  reviewerOutput: ReviewerOutput
  commentatorOutput: CommentatorOutput
  specBefore: AgentSpecification
  specAfter: AgentSpecification
  totalCost: number
}

export async function logEpochForResearch(params: LogEpochParams): Promise<void> {
  const {
    experimentId,
    epochNumber,
    startTime,
    endTime,
    roleAssignments,
    plannerOutput,
    executorOutput,
    challengerOutput,
    reviewerOutput,
    commentatorOutput,
    specBefore,
    specAfter,
    totalCost,
  } = params

  // Calculate mutation stats
  const decisions = reviewerOutput.decisions || []
  const mutationsApproved = decisions.filter(d => d.verdict === 'approve').length
  const mutationsRejected = decisions.filter(d => d.verdict === 'reject').length
  const mutationsModified = decisions.filter(d => d.verdict === 'modify').length

  // Find prunings this epoch
  const pruningsThisEpoch: string[] = []
  for (const cap of specAfter.capabilities) {
    if (cap.status === 'pruned' && cap.pruned_epoch === epochNumber) {
      pruningsThisEpoch.push(cap.id)
    }
  }
  for (const con of specAfter.constraints) {
    if (con.status === 'pruned' && con.pruned_epoch === epochNumber) {
      pruningsThisEpoch.push(con.id)
    }
  }
  for (const beh of specAfter.behaviors) {
    if (beh.status === 'pruned' && beh.pruned_epoch === epochNumber) {
      pruningsThisEpoch.push(beh.id)
    }
  }

  // Build the complete epoch log
  const epochLog: EpochLog = {
    epoch_number: epochNumber,
    timestamp: endTime.toISOString(),
    duration_ms: endTime.getTime() - startTime.getTime(),

    role_assignments: {
      planner: MODEL_NAMES.get(roleAssignments.planner),
      executor: MODEL_NAMES.get(roleAssignments.executor),
      challenger: MODEL_NAMES.get(roleAssignments.challenger),
      reviewer: MODEL_NAMES.get(roleAssignments.reviewer),
      commentator: MODEL_NAMES.get(roleAssignments.commentator),
    },

    outputs: {
      planner: plannerOutput,
      executor: executorOutput,
      challenger: challengerOutput,
      reviewer: reviewerOutput,
      commentator: commentatorOutput,
    },

    specification_snapshot: specAfter,

    mutations_proposed: executorOutput.mutations?.length || 0,
    mutations_approved: mutationsApproved,
    mutations_rejected: mutationsRejected,
    mutations_modified: mutationsModified,
    prunings_this_epoch: pruningsThisEpoch,
    conflicts_raised: (reviewerOutput.new_conflicts_detected || []).map(c => c.description),
    conflicts_resolved: reviewerOutput.conflicts_resolved || [],

    emergent_behaviors: commentatorOutput.emergent_behaviors || [],
    stability_score: specAfter.meta.stability_score,
    stability_delta: specAfter.meta.stability_score - specBefore.meta.stability_score,
    growth_stage: specAfter.meta.growth_stage,

    cost_usd: totalCost,
  }

  // Store in database
  await ensureEpochLogsTable()
  await sql`
    INSERT INTO epoch_logs (experiment_id, epoch_number, timestamp, log_data)
    VALUES (${experimentId}, ${epochNumber}, ${epochLog.timestamp}, ${JSON.stringify(epochLog)})
    ON CONFLICT (experiment_id, epoch_number) DO UPDATE SET
      timestamp = EXCLUDED.timestamp,
      log_data = EXCLUDED.log_data
  `

  console.log(`[RESEARCH] Epoch ${epochNumber} logged for analysis`)
}

// Export all epoch logs as JSON array (for research export)
export async function exportResearchData(experimentId?: string): Promise<EpochLog[]> {
  await ensureEpochLogsTable()
  const result = experimentId
    ? await sql`SELECT log_data FROM epoch_logs WHERE experiment_id = ${experimentId} ORDER BY epoch_number ASC`
    : await sql`SELECT log_data FROM epoch_logs ORDER BY created_at ASC, epoch_number ASC`
  return result.rows.map(row => row.log_data as EpochLog)
}
