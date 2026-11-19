import { sql } from '@vercel/postgres'
import { getRoleAssignments } from './role-rotation.js'
import { getSharedContext, reviewerToolSection, tinkerDatasetReviewFacts, tinkerReviewFacts, ROLE_PROMPTS } from './prompts.js'
import { runResearchEpoch } from './research-epoch.js'
import { getExperimentStatus, getGrowthStage } from './seed-spec.js'
import { generatePlantFromSpec } from './plant-generator.js'
import { answeredModel, callModel as callOpenRouter } from './openrouter.js'
import { getRecentCIFailures } from './code-contributions-store.js'
import type { EpochFollowUp } from './epoch-followup.js'
import { addNotebookNote, getRecentNotebook } from './notebook.js'
import { memorySummary, recall, recallHits, recallQuestions } from './knowledge-graph.js'
import { loadGraph } from './knowledge-graph-store.js'
import { recordToolRun } from './tool-runs-store.js'
import { logEpochForResearch } from './research-logger.js'
import { claimEpoch, releaseEpoch, EpochBusyError } from './epoch-claim.js'
import { budgetScopeFor } from './experiment-modes.js'
import {
  BudgetPausedError, checkDailyBudget, describeBudget, epochSpend, setSpendEpoch, withSpendContext,
} from './spend.js'
import {
  clampStability, normalizeSeverity, pickContributionCandidate, sanitizeDecisions, sanitizeMutations, textOrNull,
} from './model-output.js'
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
import { MODEL_DISPLAY_NAMES, modelDisplayName } from './types.js'
import { toolConfig } from './tools-config.js'
import { planTools, type ToolPlan } from './tool-requests.js'
import { prepareExhibit } from './exhibits.js'
import { adaptersContext, keepReviewFacts } from './tinker-keep.js'
import {
  alreadyRan, recentToolContext, recordIgnored, runSideTools,
  type EpochToolContext, type ToolOutcome,
} from './epoch-tools.js'

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
): Promise<{ output: T; cost: number; tokens: { prompt: number; completion: number } }> {
  const result = await callOpenRouter(modelId, systemPrompt, userPrompt, { webSearch })
  const output = result.output as T
  if (output && typeof output === 'object' && result.citations.length) {
    ;(output as Record<string, unknown>).web_sources = result.citations
  }
  return {
    output,
    cost: result.cost,
    tokens: { prompt: result.usage?.prompt_tokens ?? 0, completion: result.usage?.completion_tokens ?? 0 },
  }
}

// Self-governance: agents may tune these bounded knobs about their own lab
// via the normal mutation/review pipeline. Values are HARD-CLAMPED here —
// no prompt output can push the experiment outside safe bounds.
// Code contributions are capped at one per epoch in code, so there is no
// knob for that here.
const PARAM_BOUNDS: Record<string, [number, number]> = {
  epoch_interval_minutes: [30, 180],
  north_every_n_epochs: [1, 10],
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
      const pathMatch = (mutation.path || '').match(/(\w+)\[(\d+)\]/)
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
        const field = (mutation.path || '').replace(/^identity\.?/, '')
        if (field === 'purpose' || field === 'domain') {
          (newSpec.identity as Record<string, unknown>)[field] = value
        } else if (value && typeof value === 'object') {
          Object.assign(newSpec.identity, value)
        }
      }
      newSpec.meta.total_mutations++
    } else if (mutation.type === 'remove') {
      // Mark as pruned rather than deleting
      const pathMatch = (mutation.path || '').match(/(\w+)\.(\w+)/)
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
export function findMutatedSpecItem(
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
    const pathMatch = (mutation.path || '').match(/\[(\d+)\]/)
    if (pathMatch) {
      const index = parseInt(pathMatch[1], 10)
      return arr[index] ?? null
    }
  }
  return null
}

export interface EpochRunResult {
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
}

/**
 * Runs the next epoch of an experiment. Checks the daily budget, then
 * claims the epoch atomically (throws EpochBusyError when another request
 * holds it, BudgetPausedError when today's spend has reached the cap).
 * Every model call inside is written to the spend ledger under this
 * experiment and epoch. The claim is released however the epoch ends.
 */
export async function runEpoch(experimentId: string): Promise<EpochRunResult> {
  // One cap for everything, or research's own cap when it runs alongside
  // (spend.ts). The rows this epoch writes carry the cap it started under.
  const budgetScope = await budgetScopeFor(experimentId)
  const budget = await checkDailyBudget(new Date(), budgetScope)
  if (!budget.allowed) {
    console.warn(`[Epoch] Not starting an epoch for ${experimentId}: ${describeBudget(budget)}`)
    throw new BudgetPausedError(budget)
  }
  if (!(await claimEpoch(experimentId))) throw new EpochBusyError(experimentId)
  return withSpendContext({ experimentId, purpose: 'epoch', budgetScope }, async () => {
    try {
      return await runClaimedEpoch(experimentId)
    } catch (error) {
      await releaseEpoch(experimentId).catch(e =>
        console.error('[Epoch] could not release the epoch claim:', e instanceof Error ? e.message : e))
      throw error
    }
  })
}

async function runClaimedEpoch(experimentId: string): Promise<EpochRunResult> {
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
    setSpendEpoch((experiment.current_epoch as number) + 1)
    return runResearchEpoch(experimentId)
  }

  const epochNumber = (experiment.current_epoch as number) + 1
  setSpendEpoch(epochNumber)

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
        WHERE id = ${experimentId} AND status <> 'archived'
      `
    } else {
      await releaseEpoch(experimentId)
    }
    return {
      success: true,
      epochNumber,
      newSpec: completedSpec,
      commentatorOutput: existingEpoch.commentator_output as CommentatorOutput,
    }
  }

  // 2. The epoch was claimed by runEpoch before anything else happened.

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

  // What the models' own tools did recently (Sprite sessions, GPU jobs,
  // exhibits, proposals), from the stored tool_runs records only.
  const toolHistory = await recentToolContext(experimentId).catch(() => '')
  if (toolHistory) {
    sharedContext += `\n\nRECENT TOOL RUNS (what really ran, from the lab's records):\n${toolHistory}`
  }

  // The trained adapters that are alive, only while they can be kept
  // (LAB_ENABLE_TINKER_KEEP): a request to keep one names it by its lab id,
  // so the ids have to be in front of the models. From the lab's stored runs
  // only. With keeping off this adds nothing and reads nothing.
  const adapters = await adaptersContext()
  if (adapters) {
    sharedContext += `\n\nTRAINED ADAPTERS (alive now, from the lab's records; scores were measured by the lab):\n${adapters}`
  }

  // The lab's knowledge graph (knowledge-graph.ts): a few lines of memory for
  // every role, and answers to the recall questions each role may ask, added
  // to the context of the roles that speak after it. Built from stored rows
  // only; if it cannot be built, the epoch goes on without it.
  const graph = await loadGraph(experimentId, true).catch((e) => {
    console.warn(`[Epoch ${epochNumber}] knowledge graph unavailable (non-fatal):`, e instanceof Error ? e.message : e)
    return null
  })
  const memory = graph ? memorySummary(graph, epochNumber - 1) : ''
  if (memory) {
    sharedContext += `\n\nLAB MEMORY (from the lab's knowledge graph of the stored record; ask it more with "recall"):\n${memory}`
  }
  const answerRecall = async (role: string, modelId: string, output: unknown, fresh: boolean) => {
    if (!graph) return
    const questions = recallQuestions(output)
    if (!questions.length) return
    const who = answeredModel(output, modelId)
    const answers = questions.map(q => `Q: ${q}\n${recall(graph, q)}`).join('\n')
    sharedContext += `\n\nMEMORY RECALL (the ${role} asked the lab's record; answers for everyone who speaks after them):\n${answers}`
    if (fresh) {
      await recordToolRun({
        experimentId, epoch: epochNumber, model: who, tool: 'recall',
        requestSummary: questions.join(' | '), status: 'ok', durationMs: 0, costUsd: 0,
        outputTail: answers, detail: { role, questions, hits: questions.map(q => recallHits(graph, q)) },
      })
    }
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
  const tokens = { prompt: 0, completion: 0 }
  const addUsage = (cost: number, t: { prompt: number; completion: number }) => {
    totalCost += cost
    tokens.prompt += t.prompt
    tokens.completion += t.completion
  }
  const epochStartTime = existingEpoch?.started_at
    ? new Date(existingEpoch.started_at)
    : new Date()

  // Persist a role's lab-notebook entry (fresh-call path only, so resume
  // retries don't double-write).
  const saveNote = async (role: string, modelId: string, output: unknown) => {
    const note = output && typeof output === 'object' ? String((output as Record<string, unknown>).notebook ?? '') : ''
    await addNotebookNote(experimentId, epochNumber, `${role} (${answeredModel(output, modelId).split('/').pop()})`, note)
  }

  // Tools the Executor chooses (tools-config.ts, epoch-tools.ts). Side tools
  // start after the Executor and are awaited before the Commentator.
  let sideTools: Promise<ToolOutcome[]> = Promise.resolve([])
  let toolPlan: ToolPlan | null = null
  let toolCtx: EpochToolContext | null = null
  let toolsAlreadyRun: Set<string> = new Set()

  try {
    // 6. PLANNER
    let plannerOutput = existingEpoch?.planner_output as PlannerOutput | undefined
    if (!plannerOutput) {
      const { output, cost, tokens: used } = await callModel<PlannerOutput>(
        roleAssignments.planner,
        ctxFor(roleAssignments.planner) + '\n\n' + ROLE_PROMPTS.planner,
        'What direction should we take this epoch?',
        true // web search — the Planner researches what a SOTA agent needs
      )
      plannerOutput = output
      addUsage(cost, used)
      await sql`
        UPDATE epochs SET planner_output = ${JSON.stringify(plannerOutput)} WHERE id = ${epochId}
      `
      await saveNote('Planner', roleAssignments.planner, plannerOutput)
      await answerRecall('Planner', roleAssignments.planner, plannerOutput, true)
    } else {
      await answerRecall('Planner', roleAssignments.planner, plannerOutput, false)
    }

    // 7. EXECUTOR
    let executorOutput = existingEpoch?.executor_output as ExecutorOutput | undefined
    const executorWasStored = Boolean(executorOutput)
    if (!executorOutput) {
      const { output, cost, tokens: used } = await callModel<ExecutorOutput>(
        roleAssignments.executor,
        ctxFor(roleAssignments.executor) + '\n\n' + ROLE_PROMPTS.executor(plannerOutput),
        "Implement the planner's direction with concrete mutations.",
        true // web search — the Executor looks up real implementation approaches
      )
      executorOutput = output
      addUsage(cost, used)
      await sql`
        UPDATE epochs SET executor_output = ${JSON.stringify(executorOutput)} WHERE id = ${epochId}
      `
      await saveNote('Executor', roleAssignments.executor, executorOutput)
      await answerRecall('Executor', roleAssignments.executor, executorOutput, true)
    } else {
      await answerRecall('Executor', roleAssignments.executor, executorOutput, false)
    }

    // 7b. The Executor's tool choices. Unknown or switched-off tools are
    // ignored and recorded; the ones that remain run within their limits.
    const executorModel = answeredModel(executorOutput, roleAssignments.executor)
    toolCtx = {
      experimentId, epochNumber, executorModelId: executorModel,
      assignedExecutorId: roleAssignments.executor, reviewerModelId: roleAssignments.reviewer,
    }
    toolPlan = planTools((executorOutput as unknown as Record<string, unknown>).tools, toolConfig())
    toolsAlreadyRun = await alreadyRan(toolCtx)
    if (!executorWasStored) await recordIgnored(toolCtx, toolPlan)
    sideTools = runSideTools(toolCtx, toolPlan, toolsAlreadyRun)

    // 8. CHALLENGER
    let challengerOutput = existingEpoch?.challenger_output as ChallengerOutput | undefined
    if (!challengerOutput) {
      const { output, cost, tokens: used } = await callModel<ChallengerOutput>(
        roleAssignments.challenger,
        ctxFor(roleAssignments.challenger) + '\n\n' + ROLE_PROMPTS.challenger(executorOutput),
        'Stress-test the proposed changes. Find weaknesses.'
      )
      challengerOutput = output
      addUsage(cost, used)
      await sql`
        UPDATE epochs SET challenger_output = ${JSON.stringify(challengerOutput)} WHERE id = ${epochId}
      `
      await saveNote('Challenger', roleAssignments.challenger, challengerOutput)
      await answerRecall('Challenger', roleAssignments.challenger, challengerOutput, true)
    } else {
      await answerRecall('Challenger', roleAssignments.challenger, challengerOutput, false)
    }

    // 8b. REBUTTAL — the Executor answers the Challenger before the Reviewer
    // rules, so the panel argues instead of talking past each other.
    let rebuttalOutput = existingEpoch?.executor_rebuttal as RebuttalOutput | undefined
    if (!rebuttalOutput && (challengerOutput.challenges?.length ?? 0) > 0) {
      try {
        const { output, cost, tokens: used } = await callModel<RebuttalOutput>(
          roleAssignments.executor,
          ctxFor(roleAssignments.executor) + '\n\n' + ROLE_PROMPTS.rebuttal(executorOutput, challengerOutput),
          "Respond to each of the Challenger's concerns: defend, concede, or revise."
        )
        rebuttalOutput = output
        addUsage(cost, used)
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
      const { output, cost, tokens: used } = await callModel<ReviewerOutput>(
        roleAssignments.reviewer,
        ctxFor(roleAssignments.reviewer) + '\n\n' + ROLE_PROMPTS.reviewer(executorOutput, challengerOutput, rebuttalOutput, reviewerToolSection({
          exhibit: toolPlan?.exhibit ? {
            slug: toolPlan.exhibit.slug,
            check: (() => {
              const checked = prepareExhibit(toolPlan.exhibit.exhibit, modelDisplayName(executorModel) || executorModel)
              return checked.ok ? 'it meets the version 1 contract' : `it does NOT meet the contract and will not be opened (${checked.errors.slice(0, 3).join('; ')})`
            })(),
          } : undefined,
          lab_proposal: toolPlan?.lab_proposal ? { title: toolPlan.lab_proposal.title, files: toolPlan.lab_proposal.files.map(f => f.path) } : undefined,
          // A training request names a shelf dataset only while public datasets are on (tool-requests.ts).
          tinker_train: toolPlan?.tinker_train ? tinkerReviewFacts(toolPlan.tinker_train)
            : toolPlan?.tinker_train_dataset ? tinkerDatasetReviewFacts(toolPlan.tinker_train_dataset) : undefined,
          keep_adapter: toolPlan?.keep_adapter ? await keepReviewFacts(toolPlan.keep_adapter, { modelId: executorModel }) : undefined,
        })),
        'Make final decisions on each proposed mutation.'
      )
      reviewerOutput = output
      addUsage(cost, used)
      await sql`
        UPDATE epochs SET reviewer_output = ${JSON.stringify(reviewerOutput)} WHERE id = ${epochId}
      `
      await saveNote('Reviewer', roleAssignments.reviewer, reviewerOutput)
      await answerRecall('Reviewer', roleAssignments.reviewer, reviewerOutput, true)
    }

    // 10. Apply approved mutations to spec. Model output is untyped JSON:
    // the mutations and decisions are put into a usable shape first, keeping
    // the indexes the decisions refer to.
    const mutations = sanitizeMutations(executorOutput.mutations)
    const decisions = sanitizeDecisions(reviewerOutput.decisions, mutations.length)
    // An entry whose type couldn't be mapped matches no branch and is skipped.
    const newSpec = applyMutations(specBefore, mutations as unknown as Mutation[], decisions, epochNumber)

    // 10b. Post-review work: the one code contribution (the approved mutation
    // most worth backing with code) and any exhibit or lab proposal the
    // Reviewer approved. It does not run here. With reasoning on, the five
    // roles already use most of the 800 s function limit, and the
    // contribution (explorer, code, test, CI, Sprite) can take as long again,
    // so doing both in one request overran it. It is queued on the epoch row
    // and runs in its own request on the next tick (epoch-followup.ts).
    const candidate = pickContributionCandidate(mutations, decisions, challengerOutput.challenges)
    const hasDeliverables = Boolean(toolPlan && (toolPlan.exhibit || toolPlan.lab_proposal || toolPlan.tinker_train || toolPlan.tinker_train_dataset || toolPlan.keep_adapter))
    const followup: EpochFollowUp = {
      status: candidate || hasDeliverables ? 'pending' : 'none',
      contribution_mutation_index: candidate ? candidate.decision.mutation_index : null,
      deliverables: hasDeliverables,
      queued_at: new Date().toISOString(),
    }
    // A resumed epoch whose follow-up already started keeps that record.
    const prior = (existingEpoch as { followup?: EpochFollowUp } | undefined)?.followup
    await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS followup JSONB`
    if (!prior || prior.status === 'pending' || prior.status === 'none') {
      await sql`UPDATE epochs SET followup = ${JSON.stringify(followup)} WHERE id = ${epochId}`
    }

    const toolOutcomes: Array<{ tool: string; status: string; summary: string }> = [...(await sideTools)]
    if (candidate) {
      toolOutcomes.push({
        tool: 'code_contribution', status: 'queued',
        summary: `after this epoch, the approved ${candidate.mutation.target} change goes to AI-Agent as a pull request; CI decides the merge`,
      })
    }
    if (hasDeliverables) {
      toolOutcomes.push({
        tool: 'deliverables', status: 'queued',
        summary: (toolPlan?.tinker_train || toolPlan?.tinker_train_dataset
          ? 'any exhibit or lab proposal the Reviewer approved is opened after this epoch, and an approved Tinker training run is started then'
          : 'any exhibit or lab proposal the Reviewer approved is opened after this epoch')
          + (toolPlan?.keep_adapter ? '; an approved request to keep a trained adapter is carried out then too' : ''),
      })
    }

    // Always a number in 0..1 (a string or 85 from a model would break the
    // DECIMAL(4,3) stability_delta column and the lighting).
    newSpec.meta.stability_score = clampStability(reviewerOutput.updated_stability_score, specBefore.meta.stability_score ?? 0.5)
    newSpec.meta.total_epochs = epochNumber
    newSpec.meta.growth_stage = getGrowthStage(newSpec)

    // Conflicts: the spec keeps its own ids; the conflicts table row carries
    // that id too, so a later "resolved" can find the row.
    await sql`ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS spec_conflict_id TEXT`
    const newConflicts = Array.isArray(reviewerOutput.new_conflicts_detected) ? reviewerOutput.new_conflicts_detected : []
    for (const raw of newConflicts) {
      if (!raw || typeof raw !== 'object') continue
      const conflict = {
        id: `conflict_${epochNumber}_${newSpec.conflicts.length}`,
        element_a: textOrNull(raw.element_a, 300) ?? 'unspecified',
        element_b: textOrNull(raw.element_b, 300) ?? 'unspecified',
        description: textOrNull(raw.description, 2000) ?? '(no description)',
        severity: normalizeSeverity(raw.severity),
      }
      newSpec.conflicts.push({ ...conflict, detected_epoch: epochNumber, resolved: false })
      await sql`
        INSERT INTO conflicts (experiment_id, detected_epoch, element_a, element_b, description, severity, spec_conflict_id)
        VALUES (${experimentId}, ${epochNumber}, ${conflict.element_a}, ${conflict.element_b}, ${conflict.description}, ${conflict.severity}, ${conflict.id})
      `
    }

    // Mark resolved conflicts. The reviewer names spec conflict ids; rows
    // written before spec_conflict_id existed are matched on their fields.
    const resolvedIds = Array.isArray(reviewerOutput.conflicts_resolved)
      ? reviewerOutput.conflicts_resolved.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
      : []
    for (const conflictId of resolvedIds) {
      const conflict = newSpec.conflicts.find(c => c.id === conflictId)
      if (!conflict || conflict.resolved) continue
      conflict.resolved = true
      conflict.resolved_epoch = epochNumber
      await sql`
        UPDATE conflicts SET resolved_epoch = ${epochNumber}
        WHERE experiment_id = ${experimentId}
          AND resolved_epoch IS NULL
          AND (
            spec_conflict_id = ${conflictId}
            OR (spec_conflict_id IS NULL
              AND detected_epoch = ${conflict.detected_epoch}
              AND element_a = ${conflict.element_a}
              AND element_b = ${conflict.element_b})
          )
      `
    }

    // 11. COMMENTATOR
    let commentatorOutput = existingEpoch?.commentator_output as CommentatorOutput | undefined
    if (!commentatorOutput) {
      const { output, cost, tokens: used } = await callModel<CommentatorOutput>(
        roleAssignments.commentator,
        ctxFor(roleAssignments.commentator) + '\n\n' + ROLE_PROMPTS.commentator({
          planner: plannerOutput,
          executor: executorOutput,
          challenger: challengerOutput,
          reviewer: reviewerOutput,
          tools: toolOutcomes,
        }),
        'Summarize this epoch for human observers.'
      )
      commentatorOutput = output
      addUsage(cost, used)
      await saveNote('Commentator', roleAssignments.commentator, commentatorOutput)
    }

    // 12. Generate plant geometry
    const plantGeometry = generatePlantFromSpec(newSpec)

    // 13. Update epoch record. The cost is the ledger's total for this epoch:
    // every billed attempt, retries, fallbacks, the contribution, and calls
    // from earlier attempts at this same epoch. The in-memory total is the
    // floor in case the ledger couldn't be read.
    const ledger = await epochSpend(experimentId, epochNumber)
    const epochCost = Math.max(ledger?.cost_usd ?? 0, totalCost)
    const promptTokens = Math.max(ledger?.prompt_tokens ?? 0, tokens.prompt)
    const completionTokens = Math.max(ledger?.completion_tokens ?? 0, tokens.completion)
    await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER`
    await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS completion_tokens INTEGER`
    await sql`
      UPDATE epochs SET
        commentator_output = ${JSON.stringify(commentatorOutput)},
        spec_after = ${JSON.stringify(newSpec)},
        plant_geometry = ${JSON.stringify(plantGeometry)},
        stability_delta = ${newSpec.meta.stability_score - specBefore.meta.stability_score},
        cost_usd = ${epochCost},
        prompt_tokens = ${promptTokens},
        completion_tokens = ${completionTokens},
        completed_at = NOW()
      WHERE id = ${epochId}
    `
    console.log(`[Epoch ${epochNumber}] cost $${epochCost.toFixed(4)} (${promptTokens} prompt / ${completionTokens} completion tokens)`)

    // 14. Update experiment
    const newStatus = getExperimentStatus(newSpec)
    await sql`
      UPDATE experiments SET
        current_spec = ${JSON.stringify(newSpec)},
        current_epoch = ${epochNumber},
        epoch_in_progress = FALSE,
        epoch_started_at = NULL,
        status = ${newStatus}
      WHERE id = ${experimentId} AND status <> 'archived'
    `

    // 15. Record mutations for research. Rows whose type can't be mapped to
    // the table's CHECK set are skipped rather than failing the epoch.
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i]
      if (!mutation.type) {
        console.warn(`[Epoch ${epochNumber}] mutation ${i} has an unknown type; not recorded`)
        continue
      }
      const decision = decisions.find(d => d.mutation_index === i)

      await sql`
        INSERT INTO mutations (epoch_id, mutation_index, type, target, path, model_id, approved, reason)
        VALUES (
          ${epochId},
          ${i},
          ${mutation.type},
          ${mutation.target || 'unknown'},
          ${mutation.path || null},
          ${roleAssignments.executor},
          ${decision?.verdict === 'approve' || decision?.verdict === 'modify'},
          ${textOrNull(decision?.reason)}
        )
      `
    }

    // 16. Log complete epoch data for research analysis. A logging failure
    // must not undo an epoch that is already stored.
    await logEpochForResearch({
      experimentId,
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
      totalCost: epochCost,
    }).catch(e => console.warn(`[Epoch ${epochNumber}] research log failed (non-fatal):`, e instanceof Error ? e.message : e))

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
    // Mark epoch as failed but don't lose partial data. Its partial cost
    // stays in the ledger and counts toward today's budget.
    await sql`
      UPDATE epochs SET completed_at = NOW() WHERE id = ${epochId}
    `.catch(() => {})
    await releaseEpoch(experimentId)
    throw error
  }
}

