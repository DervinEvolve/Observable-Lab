import { sql } from '@vercel/postgres'
import { getRoleAssignments } from './role-rotation.js'
import { getSharedContext, ROLE_PROMPTS } from './prompts.js'
import { runResearchEpoch } from './research-epoch.js'
import { getExperimentStatus, getGrowthStage } from './seed-spec.js'
import { generatePlantFromSpec } from './plant-generator.js'
import { answeredModel, callModel as callOpenRouter } from './openrouter.js'
import { contributeCode } from './code-contribution.js'
import { contributionBranchName } from './branch-names.js'
import { persistContribution, getRecentCIFailures } from './code-contributions-store.js'
import { addNotebookNote, getRecentNotebook } from './notebook.js'
import { logEpochForResearch } from './research-logger.js'
import {
  runGRPOPractice,
  checkAwakeningConditions,
  triggerAwakening,
  getAgentResponse,
  recordAgentUtterance,
  getAwakeningStatus,
} from './modal-client.js'
import type {
  AgentSpecification,
  Epoch,
  PlannerOutput,
  ExecutorOutput,
  ChallengerOutput,
  RebuttalOutput,
  ReviewerOutput,
  CommentatorOutput,
  Mutation,
  ReviewerDecision,
  RoleAssignments,
} from './types.js'
import { MODEL_DISPLAY_NAMES } from './types.js'

// Type-safe wrapper around OpenRouter callModel. Web search is opt-in per call
// — it costs money and most turns don't need current external info, so only the
// roles that genuinely research/build (Planner, Executor) enable it. Cited
// pages get attached to the role's stored output (web_sources) so the lab can
// stream what the model browsed into its terminal.
async function callModel<T>(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  webSearch = false
): Promise<{ output: T; cost: number }> {
  const result = await callOpenRouter(modelId, systemPrompt, userPrompt, { webSearch })
  const output = result.output as T
  if (output && typeof output === 'object' && result.citations.length) {
    ;(output as Record<string, unknown>).web_sources = result.citations
  }
  return { output, cost: result.cost }
}

// Self-governance: agents may tune these bounded knobs about their own lab
// via the normal mutation/review pipeline. Values are HARD-CLAMPED here —
// no prompt output can push the experiment outside safe bounds.
const PARAM_BOUNDS: Record<string, [number, number]> = {
  epoch_interval_minutes: [30, 180],
  north_every_n_epochs: [1, 10],
  max_code_contributions_per_epoch: [1, 5],
}

function applyExperimentParams(spec: AgentSpecification, value: Record<string, unknown>): void {
  const params = (spec.meta.experiment_params ??= {})
  for (const [key, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
    const raw = value?.[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN
    if (Number.isFinite(n)) {
      ;(params as Record<string, number>)[key] = Math.min(hi, Math.max(lo, Math.round(n)))
    }
  }
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
      } else if (mutation.target === 'experiment_params') {
        applyExperimentParams(newSpec, value)
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
      } else if (mutation.target === 'experiment_params') {
        applyExperimentParams(newSpec, value)
      } else if (mutation.target === 'identity') {
        // `identity` isn't an array, so it never matches the index-path regex
        // above — models phrase the path inconsistently ("identity",
        // "identity.purpose", "purpose") since the prompt only documents
        // array paths. Every identity mutation was silently dropped as a
        // result (confirmed live across 4 epochs). Handle all observed forms.
        const field = mutation.path.replace(/^identity\.?/, '')
        if (field === 'purpose' || field === 'domain') {
          (newSpec.identity as Record<string, unknown>)[field] = value
        } else if (value && typeof value === 'object') {
          Object.assign(newSpec.identity, value)
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

// Finds the exact capabilities/behaviors item a given mutation+decision
// touched, so a merged code contribution can tag that specific leaf/branch
// (code_pr_url) rather than just existing somewhere in the abstract spec.
function findMutatedSpecItem(
  newSpec: AgentSpecification,
  mutation: Mutation,
  decision: ReviewerDecision
): { code_pr_url?: string } | null {
  if (mutation.target !== 'capabilities' && mutation.target !== 'behaviors') return null
  const arr = newSpec[mutation.target]

  if (mutation.type === 'add') {
    const id = (decision.modified_value as { id?: string } | null)?.id ?? (mutation.value as { id?: string })?.id
    return arr.find(item => item.id === id) ?? null
  }
  if (mutation.type === 'modify') {
    const pathMatch = mutation.path.match(/\[(\d+)\]/)
    if (pathMatch) {
      const index = parseInt(pathMatch[1], 10)
      return arr[index] ?? null
    }
  }
  return null
}

export async function runEpoch(experimentId: string): Promise<{
  success: boolean
  epochNumber: number
  newSpec: AgentSpecification
  commentatorOutput: CommentatorOutput
  grpoResult?: unknown
  awakeningEvent?: {
    event: 'awakening'
    name: string
    first_words: string
    timestamp: string
  } | null
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

  // RESEARCH MODE: experiments seeded with meta.research run the autonomous
  // ML research pipeline (real GPU runs, measured verdicts) instead of the
  // classic spec-growing pipeline.
  if (currentSpec.meta.research) {
    return runResearchEpoch(experimentId)
  }

  const epochNumber = (experiment.current_epoch as number) + 1

  // Check for an existing (possibly stuck) epoch record
  const existingEpochResult = await sql`
    SELECT * FROM epochs
    WHERE experiment_id = ${experimentId} AND epoch_number = ${epochNumber}
    LIMIT 1
  `
  const existingEpoch = existingEpochResult.rows[0] as Epoch | undefined
  const specBefore = (existingEpoch?.spec_before as AgentSpecification) || currentSpec
  const assignments = (existingEpoch?.role_assignments as RoleAssignments) || getRoleAssignments(epochNumber)

  if (existingEpoch?.completed_at && existingEpoch.spec_after && existingEpoch.commentator_output) {
    const completedSpec = existingEpoch.spec_after as AgentSpecification
    if (experiment.current_epoch < epochNumber) {
      const newStatus = getExperimentStatus(completedSpec)
      await sql`
        UPDATE experiments SET
          current_spec = ${JSON.stringify(completedSpec)},
          current_epoch = ${epochNumber},
          epoch_in_progress = FALSE,
          epoch_started_at = NULL,
          status = ${newStatus}
        WHERE id = ${experimentId}
      `
    }
    return {
      success: true,
      epochNumber,
      newSpec: completedSpec,
      commentatorOutput: existingEpoch.commentator_output as CommentatorOutput,
    }
  }

  // 2. Mark epoch as in progress
  await sql`
    UPDATE experiments
    SET epoch_in_progress = TRUE, epoch_started_at = NOW()
    WHERE id = ${experimentId}
  `

  // 3. Get role assignments (reuse existing if present)
  const roleAssignments = assignments

  // 4. Get recent history for context
  const recentResult = await sql`
    SELECT epoch_number, commentator_output
    FROM epochs
    WHERE experiment_id = ${experimentId}
    ORDER BY epoch_number DESC
    LIMIT 3
  `
  const recentEpochs = recentResult.rows as Epoch[]

  let sharedContext = getSharedContext(epochNumber, specBefore, recentEpochs)

  // The lab notebook — durable memory across epochs and role rotations.
  const notebook = await getRecentNotebook(experimentId)
  if (notebook.length) {
    sharedContext += `\n\nLAB NOTEBOOK (durable notes your colleagues left for whoever works next — heed the warnings):\n${notebook
      .map(n => `- [e${n.epoch_number} · ${n.author}] ${n.note}`)
      .join('\n')}`
  }

  // Real CI failures from recent epochs — the models see the actual error
  // output their code produced and are expected to not repeat it.
  const ciFailures = await getRecentCIFailures(experimentId)
  if (ciFailures.length) {
    sharedContext += `\n\nRECENT CI FAILURES (your colleagues' PRs that were rejected because the test suite actually failed — do not repeat these mistakes):\n${ciFailures
      .map(f => `- epoch ${f.epoch_number}, ${f.author_name} (${f.branch}):\n${f.ci_excerpt.slice(0, 700)}`)
      .join('\n')}`
  }

  // Each role's system prompt opens by naming which model, specifically, is
  // speaking — so they inhabit their own identity in the shared lab.
  const ctxFor = (modelId: string) =>
    `You are ${MODEL_DISPLAY_NAMES[modelId as keyof typeof MODEL_DISPLAY_NAMES] || modelId}.\n\n${sharedContext}`

  // 5. Create epoch record
  let epochId: string
  if (existingEpoch) {
    epochId = existingEpoch.id as string
  } else {
    const epochResult = await sql`
      INSERT INTO epochs (experiment_id, epoch_number, role_assignments, spec_before)
      VALUES (${experimentId}, ${epochNumber}, ${JSON.stringify(roleAssignments)}, ${JSON.stringify(specBefore)})
      RETURNING id
    `
    epochId = epochResult.rows[0].id as string
  }

  let totalCost = 0
  const epochStartTime = existingEpoch?.started_at
    ? new Date(existingEpoch.started_at)
    : new Date()

  // Persist a role's lab-notebook entry (fresh-call path only, so resume
  // retries don't double-write).
  const saveNote = async (role: string, modelId: string, output: unknown) => {
    const note = output && typeof output === 'object' ? String((output as Record<string, unknown>).notebook ?? '') : ''
    await addNotebookNote(experimentId, epochNumber, `${role} (${answeredModel(output, modelId).split('/').pop()})`, note)
  }

  try {
    // 6. PLANNER
    let plannerOutput = existingEpoch?.planner_output as PlannerOutput | undefined
    if (!plannerOutput) {
      const { output, cost } = await callModel<PlannerOutput>(
        roleAssignments.planner,
        ctxFor(roleAssignments.planner) + '\n\n' + ROLE_PROMPTS.planner,
        'What direction should we take this epoch?',
        true // web search — the Planner researches what a SOTA agent needs
      )
      plannerOutput = output
      totalCost += cost
      await sql`
        UPDATE epochs SET planner_output = ${JSON.stringify(plannerOutput)} WHERE id = ${epochId}
      `
      await saveNote('Planner', roleAssignments.planner, plannerOutput)
    }

    // 7. EXECUTOR
    let executorOutput = existingEpoch?.executor_output as ExecutorOutput | undefined
    if (!executorOutput) {
      const { output, cost } = await callModel<ExecutorOutput>(
        roleAssignments.executor,
        ctxFor(roleAssignments.executor) + '\n\n' + ROLE_PROMPTS.executor(plannerOutput),
        "Implement the planner's direction with concrete mutations.",
        true // web search — the Executor looks up real implementation approaches
      )
      executorOutput = output
      totalCost += cost
      await sql`
        UPDATE epochs SET executor_output = ${JSON.stringify(executorOutput)} WHERE id = ${epochId}
      `
      await saveNote('Executor', roleAssignments.executor, executorOutput)
    }

    // 8. CHALLENGER
    let challengerOutput = existingEpoch?.challenger_output as ChallengerOutput | undefined
    if (!challengerOutput) {
      const { output, cost } = await callModel<ChallengerOutput>(
        roleAssignments.challenger,
        ctxFor(roleAssignments.challenger) + '\n\n' + ROLE_PROMPTS.challenger(executorOutput),
        'Stress-test the proposed changes. Find weaknesses.'
      )
      challengerOutput = output
      totalCost += cost
      await sql`
        UPDATE epochs SET challenger_output = ${JSON.stringify(challengerOutput)} WHERE id = ${epochId}
      `
      await saveNote('Challenger', roleAssignments.challenger, challengerOutput)
    }

    // 8b. REBUTTAL — the Executor answers the Challenger before the Reviewer
    // rules, so the panel argues instead of talking past each other.
    let rebuttalOutput = existingEpoch?.executor_rebuttal as RebuttalOutput | undefined
    if (!rebuttalOutput && (challengerOutput.challenges?.length ?? 0) > 0) {
      try {
        const { output, cost } = await callModel<RebuttalOutput>(
          roleAssignments.executor,
          ctxFor(roleAssignments.executor) + '\n\n' + ROLE_PROMPTS.rebuttal(executorOutput, challengerOutput),
          "Respond to each of the Challenger's concerns: defend, concede, or revise."
        )
        rebuttalOutput = output
        totalCost += cost
        await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS executor_rebuttal JSONB`
        await sql`
          UPDATE epochs SET executor_rebuttal = ${JSON.stringify(rebuttalOutput)} WHERE id = ${epochId}
        `
        await saveNote('Executor·rebuttal', roleAssignments.executor, rebuttalOutput)
      } catch (e) {
        // Rebuttal is enrichment, not a dependency — reviewer can rule without it.
        console.warn(`[Epoch ${epochNumber}] Rebuttal failed (non-fatal):`, e instanceof Error ? e.message : e)
      }
    }

    // 9. REVIEWER
    let reviewerOutput = existingEpoch?.reviewer_output as ReviewerOutput | undefined
    if (!reviewerOutput) {
      const { output, cost } = await callModel<ReviewerOutput>(
        roleAssignments.reviewer,
        ctxFor(roleAssignments.reviewer) + '\n\n' + ROLE_PROMPTS.reviewer(executorOutput, challengerOutput, rebuttalOutput),
        'Make final decisions on each proposed mutation.'
      )
      reviewerOutput = output
      totalCost += cost
      await sql`
        UPDATE epochs SET reviewer_output = ${JSON.stringify(reviewerOutput)} WHERE id = ${epochId}
      `
      await saveNote('Reviewer', roleAssignments.reviewer, reviewerOutput)
    }

    // 10. Apply approved mutations to spec
    const newSpec = applyMutations(
      specBefore,
      executorOutput.mutations || [],
      reviewerOutput.decisions || [],
      epochNumber
    )

    // 10b. Give each approved mutation a real code contribution on the AI-Agent
    // repo (branch -> PR -> merge), so the growing spec is backed by an actual
    // codebase, not just JSON. Best-effort and capped per epoch — a code-side
    // failure never blocks the abstract spec pipeline above.
    const MAX_CODE_CONTRIBUTIONS_PER_EPOCH = Math.min(5, Math.max(1,
      newSpec.meta.experiment_params?.max_code_contributions_per_epoch ?? 3))
    const approvedMutations = (reviewerOutput.decisions || [])
      .filter(d => d.verdict !== 'reject')
      .slice(0, MAX_CODE_CONTRIBUTIONS_PER_EPOCH)
    const agentContext = `${newSpec.identity.purpose || 'An autonomous agent'}${
      newSpec.identity.domain ? ` (domain: ${newSpec.identity.domain})` : ''
    }`

    // Contributions run in PARALLEL: each now waits on a real CI run (~1-3
    // min), and doing that serially would blow the function's 800s budget.
    await Promise.all(approvedMutations.map(async (decision) => {
      const mutation = (executorOutput.mutations || [])[decision.mutation_index]
      if (!mutation) return
      try {
        // Throws (and skips this contribution) unless target is one of the
        // allowed mutation targets and the index is a small integer.
        const branchName = contributionBranchName(epochNumber, mutation.target, decision.mutation_index)
        const result = await contributeCode({
          authorModelId: roleAssignments.executor,
          branchName,
          title: `Epoch ${epochNumber}: ${mutation.target} — ${mutation.path}`,
          description: `${mutation.rationale}\n\nSpec field: ${mutation.target}.${mutation.path}\nProposed value: ${JSON.stringify(mutation.value)}`,
          review: { mode: 'approved' }, // Reviewer already approved this mutation
          deploySubagent: true, // a subagent writes a test for this contribution
          deployExplorerSubagent: true, // a subagent researches the problem first, findings inform the code
          agentContext,
        })
        totalCost += result.cost
        await persistContribution(experimentId, epochNumber, roleAssignments.executor, branchName, result)
        if (result.merged) {
          console.log(`[Epoch ${epochNumber}] Code contribution merged: ${result.pr_url}`)
          // Tag the exact leaf/branch this PR backs, so the plant can render
          // it in a distinct "real code" color instead of the plain default.
          const item = findMutatedSpecItem(newSpec, mutation, decision)
          if (item) item.code_pr_url = result.pr_url
        } else if (result.ci_passed === false) {
          console.log(`[Epoch ${epochNumber}] Code contribution failed CI: ${result.pr_url}`)
          // Durable memory of the failure — short note; the full log excerpt
          // is already injected into next epoch's context separately.
          const firstError = (result.ci_excerpt || '').split('\n').find(l => /FAIL|Error/.test(l))?.slice(0, 180) || 'see CI logs'
          await addNotebookNote(experimentId, epochNumber, 'CI (system)',
            `PR "${mutation.target} — ${mutation.path}" FAILED the test suite and was closed. ${firstError}`)
        }
      } catch (e) {
        console.warn(`[Epoch ${epochNumber}] Code contribution failed (non-fatal):`, e instanceof Error ? e.message : e)
      }
    }))

    // Ensure stability_score is always set (fallback to previous value or 0.5 if missing)
    newSpec.meta.stability_score = reviewerOutput.updated_stability_score ?? specBefore.meta.stability_score ?? 0.5
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
    let commentatorOutput = existingEpoch?.commentator_output as CommentatorOutput | undefined
    if (!commentatorOutput) {
      const { output, cost } = await callModel<CommentatorOutput>(
        roleAssignments.commentator,
        ctxFor(roleAssignments.commentator) + '\n\n' + ROLE_PROMPTS.commentator({
          planner: plannerOutput,
          executor: executorOutput,
          challenger: challengerOutput,
          reviewer: reviewerOutput,
        }),
        'Summarize this epoch for human observers.'
      )
      commentatorOutput = output
      totalCost += cost
      await saveNote('Commentator', roleAssignments.commentator, commentatorOutput)
    }

    // 12. Generate plant geometry
    const plantGeometry = generatePlantFromSpec(newSpec)

    // 13. Update epoch record
    await sql`
      UPDATE epochs SET
        commentator_output = ${JSON.stringify(commentatorOutput)},
        spec_after = ${JSON.stringify(newSpec)},
        plant_geometry = ${JSON.stringify(plantGeometry)},
        stability_delta = ${newSpec.meta.stability_score - specBefore.meta.stability_score},
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
          ${roleAssignments.executor},
          ${decision?.verdict === 'approve' || decision?.verdict === 'modify'},
          ${decision?.reason || null}
        )
      `
    }

    // 16. Log complete epoch data for research analysis
    await logEpochForResearch({
      epochNumber,
      startTime: epochStartTime,
      endTime: new Date(),
      roleAssignments,
      plannerOutput,
      executorOutput,
      challengerOutput,
      reviewerOutput,
      commentatorOutput,
      specBefore,
      specAfter: newSpec,
      totalCost,
    })

    // 17. Run GRPO practice (non-blocking, best effort)
    let grpoResult = null
    let awakeningEvent = null
    try {
      grpoResult = await runGRPOPractice(newSpec, {
        plannerDirection: plannerOutput.direction,
        executorMutations: executorOutput.mutations,
        challengerConcerns: challengerOutput.challenges?.map(c => c.issue) || [],
      })
      console.log(`[Epoch ${epochNumber}] GRPO practice: ${grpoResult.success ? 'success' : 'failed'}`)
    } catch (grpoError) {
      console.error(`[Epoch ${epochNumber}] GRPO practice error:`, grpoError)
    }

    // 18. Check awakening conditions
    try {
      const awakeningStatus = await getAwakeningStatus()

      // If not already awake, check conditions
      if (!awakeningStatus.data?.is_awake) {
        const conditionsResult = await checkAwakeningConditions(newSpec)

        if (conditionsResult.success && conditionsResult.data?.is_awake) {
          // Agent meets awakening conditions - trigger awakening!
          console.log(`[Epoch ${epochNumber}] Agent meets awakening conditions!`)
          const triggerResult = await triggerAwakening(newSpec)

          if (triggerResult.success && triggerResult.data) {
            awakeningEvent = triggerResult.data
            console.log(`[Epoch ${epochNumber}] AWAKENING: "${awakeningEvent.first_words}"`)

            // Record the first words in transcripts
            await recordAgentUtterance(
              awakeningEvent.first_words,
              'Awakening - First words spoken',
              epochId,
              undefined
            )
          }
        }
      } else if (awakeningStatus.data?.is_awake) {
        // Agent is already awake - let it comment on the epoch
        console.log(`[Epoch ${epochNumber}] Agent is awake, getting response...`)

        const agentContext = `Epoch ${epochNumber} just completed. Summary: ${commentatorOutput.summary}`
        const agentResult = await getAgentResponse(
          [{ role: 'user', content: agentContext }],
          newSpec,
          true // Use RSA
        )

        if (agentResult.success && agentResult.data?.response) {
          // Record the agent's comment
          await recordAgentUtterance(
            agentResult.data.response,
            `Agent commentary on epoch ${epochNumber}`,
            epochId,
            'epoch_summary'
          )
          console.log(`[Epoch ${epochNumber}] Agent says: "${agentResult.data.response.substring(0, 100)}..."`)
        }
      }
    } catch (awakeningError) {
      console.error(`[Epoch ${epochNumber}] Awakening check error:`, awakeningError)
    }

    return {
      success: true,
      epochNumber,
      newSpec,
      commentatorOutput,
      grpoResult: grpoResult?.data,
      awakeningEvent,
    }
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

