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
  MODEL_DISPLAY_NAMES,
} from './types.js'

// Display names for cleaner logs
const MODEL_NAMES: Record<string, string> = {
  'google/gemini-3.5-flash': 'Gemini 3.5 Flash',
  'deepseek/deepseek-v4-pro': 'DeepSeek-V4',
  'anthropic/claude-opus-4.8': 'Claude Opus 4.8',
  'openai/gpt-5.5': 'GPT-5.5',
  'x-ai/grok-4.3': 'Grok 4.3',
}

interface LogEpochParams {
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
      planner: MODEL_NAMES[roleAssignments.planner] || roleAssignments.planner,
      executor: MODEL_NAMES[roleAssignments.executor] || roleAssignments.executor,
      challenger: MODEL_NAMES[roleAssignments.challenger] || roleAssignments.challenger,
      reviewer: MODEL_NAMES[roleAssignments.reviewer] || roleAssignments.reviewer,
      commentator: MODEL_NAMES[roleAssignments.commentator] || roleAssignments.commentator,
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
  await sql`
    INSERT INTO epoch_logs (epoch_number, timestamp, log_data)
    VALUES (${epochNumber}, ${epochLog.timestamp}, ${JSON.stringify(epochLog)})
    ON CONFLICT (epoch_number) DO UPDATE SET
      timestamp = EXCLUDED.timestamp,
      log_data = EXCLUDED.log_data
  `

  console.log(`[RESEARCH] Epoch ${epochNumber} logged for analysis`)
}

// Export all epoch logs as JSON array (for research export)
export async function exportResearchData(): Promise<EpochLog[]> {
  const result = await sql`
    SELECT log_data FROM epoch_logs ORDER BY epoch_number ASC
  `
  return result.rows.map(row => row.log_data as EpochLog)
}
