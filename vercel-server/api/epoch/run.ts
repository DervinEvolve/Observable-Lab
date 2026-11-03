import { sql } from '@vercel/postgres'
import { getRoleAssignments } from '../../lib/role-rotation'
import { getSharedContext, ROLE_PROMPTS } from '../../lib/prompts'
import { getExperimentStatus, getGrowthStage } from '../../lib/seed-spec'
import { generatePlantFromSpec } from '../../lib/plant-generator'
import { callModel as callOpenRouter } from '../../lib/openrouter'
import type {
  AgentSpecification,
  Epoch,
  PlannerOutput,
  ExecutorOutput,
  ChallengerOutput,
  ReviewerOutput,
  CommentatorOutput,
  Mutation,
  ReviewerDecision,
} from '../../../src/shared/types'

// Type-safe wrapper around OpenRouter callModel
async function callModel<T>(
  modelId: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ output: T; cost: number }> {
  const result = await callOpenRouter(modelId, systemPrompt, userPrompt)
  return { output: result.output as T, cost: result.cost }
}

function applyMutations(
  spec: AgentSpecification,
  mutations: Mutation[],
  decisions: ReviewerDecision[],
  epochNumber: number
): AgentSpecification {
  const newSpec: AgentSpecification = JSON.parse(JSON.stringify(spec))

  for (const decision of decisions) {
    if (decision.verdict === 'reject') continue

    const mutation = mutations[decision.mutation_index]
    if (!mutation) continue

    const value = decision.verdict === 'modify' && decision.modified_value
      ? decision.modified_value
      : mutation.value

    if (mutation.type === 'add') {
      const item = {
        ...value,
        added_epoch: epochNumber,
        status: 'active' as const,
      }

      if (mutation.target === 'capabilities') {
        newSpec.capabilities.push(item as AgentSpecification['capabilities'][0])
      } else if (mutation.target === 'constraints') {
        newSpec.constraints.push(item as AgentSpecification['constraints'][0])
      } else if (mutation.target === 'behaviors') {
        newSpec.behaviors.push(item as AgentSpecification['behaviors'][0])
      } else if (mutation.target === 'identity') {
        Object.assign(newSpec.identity, value)
      }
      newSpec.meta.total_mutations++
    } else if (mutation.type === 'modify') {
      // Handle path-based modification
      const pathMatch = mutation.path.match(/(\w+)\[(\d+)\]/)
      if (pathMatch) {
        const [, target, indexStr] = pathMatch
        const index = parseInt(indexStr, 10)
        const arr = newSpec[target as keyof AgentSpecification] as unknown[]
        if (Array.isArray(arr) && arr[index]) {
          Object.assign(arr[index] as object, value)
        }
      }
      newSpec.meta.total_mutations++
    } else if (mutation.type === 'remove') {
      // Mark as pruned rather than deleting
      const pathMatch = mutation.path.match(/(\w+)\.(\w+)/)
      if (pathMatch) {
        const [, target, id] = pathMatch
        const arr = newSpec[target as keyof AgentSpecification]
        if (Array.isArray(arr)) {
          const item = arr.find((i: { id?: string }) => i.id === id)
          if (item) {
            ;(item as { status: string; pruned_epoch?: number }).status = 'pruned'
            ;(item as { status: string; pruned_epoch?: number }).pruned_epoch = epochNumber
          }
        }
      }
      newSpec.meta.total_prunings++
    }
  }

  return newSpec
}

export async function runEpoch(experimentId: string): Promise<{
  success: boolean
  epochNumber: number
  newSpec: AgentSpecification
  commentatorOutput: CommentatorOutput
}> {
  // 1. Get current experiment state
  const experimentResult = await sql`
    SELECT * FROM experiments WHERE id = ${experimentId}
  `
  const experiment = experimentResult.rows[0]
  if (!experiment) {
    throw new Error('Experiment not found')
  }

  const currentSpec = experiment.current_spec as AgentSpecification
  const epochNumber = (experiment.current_epoch as number) + 1

  // 2. Mark epoch as in progress
  await sql`
    UPDATE experiments
    SET epoch_in_progress = TRUE, epoch_started_at = NOW()
    WHERE id = ${experimentId}
  `

  // 3. Get role assignments
  const assignments = getRoleAssignments(epochNumber)

  // 4. Get recent history for context
  const recentResult = await sql`
    SELECT epoch_number, commentator_output
    FROM epochs
    WHERE experiment_id = ${experimentId}
    ORDER BY epoch_number DESC
    LIMIT 3
  `
  const recentEpochs = recentResult.rows as Epoch[]

  const sharedContext = getSharedContext(epochNumber, currentSpec, recentEpochs)

  // 5. Create epoch record
  const epochResult = await sql`
    INSERT INTO epochs (experiment_id, epoch_number, role_assignments, spec_before)
    VALUES (${experimentId}, ${epochNumber}, ${JSON.stringify(assignments)}, ${JSON.stringify(currentSpec)})
    RETURNING id
  `
  const epochId = epochResult.rows[0].id as string

  let totalCost = 0

  try {
    // 6. PLANNER
    const { output: plannerOutput, cost: plannerCost } = await callModel<PlannerOutput>(
      assignments.planner,
      sharedContext + '\n\n' + ROLE_PROMPTS.planner,
      'What direction should we take this epoch?'
    )
    totalCost += plannerCost
    await sql`
      UPDATE epochs SET planner_output = ${JSON.stringify(plannerOutput)} WHERE id = ${epochId}
    `

    // 7. EXECUTOR
    const { output: executorOutput, cost: executorCost } = await callModel<ExecutorOutput>(
      assignments.executor,
      sharedContext + '\n\n' + ROLE_PROMPTS.executor(plannerOutput),
      "Implement the planner's direction with concrete mutations."
    )
    totalCost += executorCost
    await sql`
      UPDATE epochs SET executor_output = ${JSON.stringify(executorOutput)} WHERE id = ${epochId}
    `

    // 8. CHALLENGER
    const { output: challengerOutput, cost: challengerCost } = await callModel<ChallengerOutput>(
      assignments.challenger,
      sharedContext + '\n\n' + ROLE_PROMPTS.challenger(executorOutput),
      'Stress-test the proposed changes. Find weaknesses.'
    )
    totalCost += challengerCost
    await sql`
      UPDATE epochs SET challenger_output = ${JSON.stringify(challengerOutput)} WHERE id = ${epochId}
    `

    // 9. REVIEWER
    const { output: reviewerOutput, cost: reviewerCost } = await callModel<ReviewerOutput>(
      assignments.reviewer,
      sharedContext + '\n\n' + ROLE_PROMPTS.reviewer(executorOutput, challengerOutput),
      'Make final decisions on each proposed mutation.'
    )
    totalCost += reviewerCost
    await sql`
      UPDATE epochs SET reviewer_output = ${JSON.stringify(reviewerOutput)} WHERE id = ${epochId}
    `

    // 10. Apply approved mutations to spec
    const newSpec = applyMutations(
      currentSpec,
      executorOutput.mutations || [],
      reviewerOutput.decisions || [],
      epochNumber
    )
    newSpec.meta.stability_score = reviewerOutput.updated_stability_score
    newSpec.meta.total_epochs = epochNumber
    newSpec.meta.growth_stage = getGrowthStage(newSpec)

    // Add any new conflicts detected by reviewer
    for (const conflict of reviewerOutput.new_conflicts_detected || []) {
      newSpec.conflicts.push({
        id: `conflict_${epochNumber}_${newSpec.conflicts.length}`,
        element_a: conflict.element_a,
        element_b: conflict.element_b,
        description: conflict.description,
        severity: conflict.severity,
        detected_epoch: epochNumber,
        resolved: false,
      })

      // Also record in conflicts table
      await sql`
        INSERT INTO conflicts (experiment_id, detected_epoch, element_a, element_b, description, severity)
        VALUES (${experimentId}, ${epochNumber}, ${conflict.element_a}, ${conflict.element_b}, ${conflict.description}, ${conflict.severity})
      `
    }

    // Mark resolved conflicts
    for (const conflictId of reviewerOutput.conflicts_resolved || []) {
      const conflict = newSpec.conflicts.find(c => c.id === conflictId)
      if (conflict) {
        conflict.resolved = true
        conflict.resolved_epoch = epochNumber
      }
      await sql`
        UPDATE conflicts SET resolved_epoch = ${epochNumber}
        WHERE experiment_id = ${experimentId} AND element_a || element_b LIKE ${'%' + conflictId + '%'}
      `
    }

    // 11. COMMENTATOR
    const { output: commentatorOutput, cost: commentatorCost } = await callModel<CommentatorOutput>(
      assignments.commentator,
      sharedContext + '\n\n' + ROLE_PROMPTS.commentator({
        planner: plannerOutput,
        executor: executorOutput,
        challenger: challengerOutput,
        reviewer: reviewerOutput,
      }),
      'Summarize this epoch for human observers.'
    )
    totalCost += commentatorCost

    // 12. Generate plant geometry
    const plantGeometry = generatePlantFromSpec(newSpec)

    // 13. Update epoch record
    await sql`
      UPDATE epochs SET
        commentator_output = ${JSON.stringify(commentatorOutput)},
        spec_after = ${JSON.stringify(newSpec)},
        plant_geometry = ${JSON.stringify(plantGeometry)},
        stability_delta = ${newSpec.meta.stability_score - currentSpec.meta.stability_score},
        cost_usd = ${totalCost},
        completed_at = NOW()
      WHERE id = ${epochId}
    `

    // 14. Update experiment
    const newStatus = getExperimentStatus(newSpec)
    await sql`
      UPDATE experiments SET
        current_spec = ${JSON.stringify(newSpec)},
        current_epoch = ${epochNumber},
        epoch_in_progress = FALSE,
        epoch_started_at = NULL,
        status = ${newStatus}
      WHERE id = ${experimentId}
    `

    // 15. Record mutations for research
    for (let i = 0; i < (executorOutput.mutations || []).length; i++) {
      const mutation = executorOutput.mutations[i]
      const decision = reviewerOutput.decisions?.find(d => d.mutation_index === i)

      await sql`
        INSERT INTO mutations (epoch_id, mutation_index, type, target, path, model_id, approved, reason)
        VALUES (
          ${epochId},
          ${i},
          ${mutation.type},
          ${mutation.target},
          ${mutation.path},
          ${assignments.executor},
          ${decision?.verdict === 'approve' || decision?.verdict === 'modify'},
          ${decision?.reason || null}
        )
      `
    }

    return { success: true, epochNumber, newSpec, commentatorOutput }
  } catch (error) {
    // Mark epoch as failed but don't lose partial data
    await sql`
      UPDATE epochs SET completed_at = NOW() WHERE id = ${epochId}
    `
    await sql`
      UPDATE experiments SET epoch_in_progress = FALSE, epoch_started_at = NULL WHERE id = ${experimentId}
    `
    throw error
  }
}
