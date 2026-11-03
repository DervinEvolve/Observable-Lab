/**
 * RESEARCH MODE epoch: one real ML experiment per epoch.
 *
 * Planner (hypothesis) → Executor (new train.py) → GPU RUN (Modal, fixed
 * budget, measured val_bpb) → Challenger (methodology attack) → Reviewer
 * (keep/revert on the NUMBER) → repo effects (train.py commit, results.tsv,
 * wiki finding) → Commentator → spec/plant update.
 *
 * Stage outputs persist into the same epochs columns as classic mode, so the
 * resume-after-timeout machinery and the frontend's group chat keep working.
 * The Modal call_id persists the moment the run starts — if this function
 * dies mid-run, the next tick resumes polling instead of paying for a new run.
 */

import { sql } from '@vercel/postgres'
import { answeredModel, callModel } from './openrouter.js'
import { modelTrailers } from './commit-identity.js'
import { getRoleAssignments } from './role-rotation.js'
import { generatePlantFromSpec } from './plant-generator.js'
import { addNotebookNote, getRecentNotebook } from './notebook.js'
import { getResearchSharedContext, RESEARCH_PROMPTS } from './research-prompts.js'
import {
  appendResultsRow, awaitResearchRun, getResearchFile, pollResearchRun,
  provenanceOf, provenanceTrailers, putResearchFile, startResearchRun, writeFindingPage,
  type ResearchRunResult,
} from './research.js'
import {
  MODEL_DISPLAY_NAMES,
  type AgentSpecification, type ChallengerOutput, type CommentatorOutput,
  type Epoch, type ResearchExecutorOutput, type ResearchMeta,
  type ResearchPlannerOutput, type ResearchReviewerOutput, type RoleAssignments,
} from './types.js'

const RESEARCH_BUDGET_S = Number(process.env.RESEARCH_BUDGET_S || 300)
// Leave headroom inside the 800s function budget for the LLM stages.
const RUN_POLL_MAX_MS = Number(process.env.RESEARCH_RUN_POLL_MAX_MS || 560_000)

function getGrowthStage(spec: AgentSpecification): AgentSpecification['meta']['growth_stage'] {
  const caps = spec.capabilities.filter(c => c.status === 'active').length
  if (caps < 1) return 'seed'
  if (caps < 3) return 'sprout'
  if (caps < 6) return 'growing'
  if (caps < 12) return 'mature'
  return 'stable'
}

// Plant stability = reported research progress toward the target bpb. The
// scores are self-reported by generated code (see provenanceOf in research.ts).
function stabilityFromProgress(r: ResearchMeta): number {
  const span = Math.max(r.baseline_bpb - r.target_bpb, 1e-6)
  const progress = (r.baseline_bpb - r.best_bpb) / span
  return Math.min(0.99, Math.max(0.12, 0.15 + 0.84 * progress))
}

export async function runResearchEpoch(experimentId: string): Promise<{
  success: boolean
  epochNumber: number
  newSpec: AgentSpecification
  commentatorOutput: CommentatorOutput
}> {
  const experimentResult = await sql`SELECT * FROM experiments WHERE id = ${experimentId}`
  const experiment = experimentResult.rows[0]
  if (!experiment) throw new Error('Experiment not found')

  const currentSpec = experiment.current_spec as AgentSpecification
  const research = currentSpec.meta.research
  if (!research) throw new Error('runResearchEpoch called on a non-research experiment')
  const epochNumber = (experiment.current_epoch as number) + 1

  // Resume support: reuse a stuck epoch's persisted stages
  const existingEpochResult = await sql`
    SELECT * FROM epochs WHERE experiment_id = ${experimentId} AND epoch_number = ${epochNumber} LIMIT 1
  `
  const existingEpoch = existingEpochResult.rows[0] as (Epoch & { research_run?: { call_id?: string; result?: ResearchRunResult } }) | undefined
  const specBefore = (existingEpoch?.spec_before as AgentSpecification) || currentSpec
  const roleAssignments: RoleAssignments = (existingEpoch?.role_assignments as RoleAssignments) || getRoleAssignments(epochNumber)

  if (existingEpoch?.completed_at && existingEpoch.spec_after && existingEpoch.commentator_output) {
    return {
      success: true, epochNumber,
      newSpec: existingEpoch.spec_after as AgentSpecification,
      commentatorOutput: existingEpoch.commentator_output as CommentatorOutput,
    }
  }

  await sql`UPDATE experiments SET epoch_in_progress = TRUE, epoch_started_at = NOW() WHERE id = ${experimentId}`

  // --- Assemble research context from the repo (the org's real memory) ---
  const [trainPyFile, resultsFile, wikiIndexFile] = await Promise.all([
    getResearchFile('train.py'),
    getResearchFile('results.tsv'),
    getResearchFile('wiki/index.md'),
  ])
  if (!trainPyFile) throw new Error('Research repo missing train.py')

  const recentResult = await sql`
    SELECT epoch_number, commentator_output FROM epochs
    WHERE experiment_id = ${experimentId} ORDER BY epoch_number DESC LIMIT 3
  `
  let sharedContext = getResearchSharedContext({
    epochNumber,
    spec: specBefore,
    research,
    trainPy: trainPyFile.content,
    resultsTsv: resultsFile?.content ?? '',
    wikiIndex: wikiIndexFile?.content ?? '',
    recentHistory: recentResult.rows as Epoch[],
  })

  const notebook = await getRecentNotebook(experimentId)
  if (notebook.length) {
    sharedContext += `\n\nLAB NOTEBOOK (durable notes from your colleagues — heed the warnings):\n${notebook
      .map(n => `- [e${n.epoch_number} · ${n.author}] ${n.note}`).join('\n')}`
  }

  const ctxFor = (modelId: string) =>
    `You are ${MODEL_DISPLAY_NAMES[modelId as keyof typeof MODEL_DISPLAY_NAMES] || modelId}.\n\n${sharedContext}`

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
  await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS research_run JSONB`

  let totalCost = 0
  const saveNote = async (role: string, modelId: string, output: unknown) => {
    const note = output && typeof output === 'object' ? String((output as Record<string, unknown>).notebook ?? '') : ''
    await addNotebookNote(experimentId, epochNumber, `${role} (${answeredModel(output, modelId).split('/').pop()})`, note)
  }

  try {
    // 1. PLANNER — one falsifiable hypothesis
    let plannerOutput = existingEpoch?.planner_output as unknown as ResearchPlannerOutput | undefined
    if (!plannerOutput?.hypothesis) {
      const { output, cost } = await callModel(
        roleAssignments.planner,
        ctxFor(roleAssignments.planner) + '\n\n' + RESEARCH_PROMPTS.planner(),
        'Propose this epoch\'s experiment.'
      )
      plannerOutput = output as ResearchPlannerOutput
      totalCost += cost
      await sql`UPDATE epochs SET planner_output = ${JSON.stringify(plannerOutput)} WHERE id = ${epochId}`
      await saveNote('Planner', roleAssignments.planner, plannerOutput)
    }

    // 2. EXECUTOR — the complete new train.py
    let executorOutput = existingEpoch?.executor_output as unknown as ResearchExecutorOutput | undefined
    if (!executorOutput?.train_py) {
      const { output, cost } = await callModel(
        roleAssignments.executor,
        ctxFor(roleAssignments.executor) + '\n\n' + RESEARCH_PROMPTS.executor(plannerOutput),
        'Implement the experiment. Return the complete new train.py.',
        { maxTokens: 28000 }
      )
      executorOutput = output as ResearchExecutorOutput
      totalCost += cost
      // Cheap sanity before burning GPU time
      const tp = executorOutput.train_py || ''
      if (!tp.includes('def ') || !tp.includes('RESULT') || tp.length < 2000) {
        throw new Error('Executor produced an implausible train.py (missing contract markers)')
      }
      await sql`UPDATE epochs SET executor_output = ${JSON.stringify(executorOutput)} WHERE id = ${epochId}`
      await saveNote('Executor', roleAssignments.executor, executorOutput)
    }

    // 3. THE RUN — real GPU, fixed budget. call_id persists immediately so a
    // function timeout resumes polling instead of re-running.
    let runResult = existingEpoch?.research_run?.result as ResearchRunResult | undefined
    if (!runResult) {
      let callId = existingEpoch?.research_run?.call_id
      if (!callId) {
        callId = await startResearchRun(executorOutput.train_py, RESEARCH_BUDGET_S)
        await sql`
          UPDATE epochs SET research_run = ${JSON.stringify({ call_id: callId, budget_s: RESEARCH_BUDGET_S })}
          WHERE id = ${epochId}
        `
        console.log(`[Research e${epochNumber}] run started: ${callId}`)
      }
      const awaited = await awaitResearchRun(callId, RUN_POLL_MAX_MS)
      if (awaited === null) {
        // Still training at our polling deadline — bail out cleanly; the next
        // tick reuses the persisted call_id and picks up the result.
        throw new Error(`GPU run still in progress at poll deadline (call ${callId}) — epoch will resume next tick`)
      }
      runResult = awaited
      await sql`
        UPDATE epochs SET research_run = ${JSON.stringify({ call_id: callId, budget_s: RESEARCH_BUDGET_S, result: runResult })}
        WHERE id = ${epochId}
      `
      console.log(`[Research e${epochNumber}] run finished: ${runResult.status} val_bpb=${runResult.metrics?.val_bpb ?? 'n/a'}`)
    }

    // 4. CHALLENGER — attack the methodology with the measured result in hand
    let challengerOutput = existingEpoch?.challenger_output as ChallengerOutput | undefined
    if (!challengerOutput) {
      const { output, cost } = await callModel(
        roleAssignments.challenger,
        ctxFor(roleAssignments.challenger) + '\n\n'
          + RESEARCH_PROMPTS.challenger(plannerOutput.hypothesis, executorOutput.change_summary, runResult),
        'Stress-test this experiment\'s methodology and result.'
      )
      challengerOutput = output as ChallengerOutput
      totalCost += cost
      await sql`UPDATE epochs SET challenger_output = ${JSON.stringify(challengerOutput)} WHERE id = ${epochId}`
      await saveNote('Challenger', roleAssignments.challenger, challengerOutput)
    }

    // 5. REVIEWER — verdict on the number
    const challengerNotes = (challengerOutput.challenges || [])
      .map(c => `- [${c.severity}] ${c.issue}`).join('\n') || '- (no concerns raised)'
    let reviewerOutput = existingEpoch?.reviewer_output as unknown as ResearchReviewerOutput | undefined
    if (!reviewerOutput?.verdict) {
      const { output, cost } = await callModel(
        roleAssignments.reviewer,
        ctxFor(roleAssignments.reviewer) + '\n\n'
          + RESEARCH_PROMPTS.reviewer(plannerOutput.hypothesis, executorOutput.change_summary, runResult, research.best_bpb, challengerNotes),
        'Rule: keep or revert.'
      )
      reviewerOutput = output as ResearchReviewerOutput
      totalCost += cost
      // Hard guard: no result or no improvement → the verdict cannot be keep.
      const measured = runResult.metrics?.val_bpb
      if (reviewerOutput.verdict === 'keep' && (measured === undefined || measured >= research.best_bpb)) {
        reviewerOutput.verdict = 'revert'
        reviewerOutput.reason += ' [SYSTEM: keep overturned — measured val_bpb did not beat the current best.]'
      }
      await sql`UPDATE epochs SET reviewer_output = ${JSON.stringify(reviewerOutput)} WHERE id = ${epochId}`
      await saveNote('Reviewer', roleAssignments.reviewer, reviewerOutput)
    }

    const verdict = reviewerOutput.verdict
    const measuredBpb = runResult.metrics?.val_bpb ?? null
    const provenance = provenanceOf(runResult)
    const unverified = provenance.metrics_source === 'experiment_stdout_unverified' ? ', unverified' : ''

    // 6. REPO EFFECTS — the org's memory is the repo, not the database
    // Credit the model that actually wrote train.py (a fallback model, if one answered).
    // The commit identity is the lab's (commit-identity.ts); the model is a trailer.
    const executorModel = answeredModel(executorOutput, roleAssignments.executor)
    const displayName = (id: string) => MODEL_DISPLAY_NAMES[id as keyof typeof MODEL_DISPLAY_NAMES] || id
    const fallbackFor = executorModel !== roleAssignments.executor ? displayName(roleAssignments.executor) : undefined
    const author = displayName(executorModel) + (fallbackFor ? ` (fallback for ${fallbackFor})` : '')
    try {
      if (verdict === 'keep') {
        await putResearchFile(
          'train.py',
          executorOutput.train_py,
          `e${epochNumber} KEEP (${measuredBpb?.toFixed(4)} bpb${unverified}): ${plannerOutput.hypothesis.slice(0, 100)}\n\n${executorOutput.change_summary}\n\n` +
            `${modelTrailers({ name: displayName(executorModel), id: executorModel, role: 'executor', fallbackFor })}\n${provenanceTrailers(provenance)}`,
          trainPyFile.sha
        )
      }
      await appendResultsRow({
        epoch: epochNumber,
        commit: verdict === 'keep' ? 'merged' : 'reverted',
        val_bpb: measuredBpb,
        train_steps: runResult.metrics?.train_steps ?? null,
        train_seconds: runResult.metrics?.train_seconds ?? null,
        peak_vram_mb: runResult.metrics?.peak_vram_mb ?? null,
        params_m: runResult.metrics?.params_m ?? null,
        status: runResult.status === 'ok' ? (verdict === 'keep' ? 'keep' : 'discard') : 'crash',
        hypothesis: plannerOutput.hypothesis,
        provenance,
      })
      await writeFindingPage({
        epoch: epochNumber,
        author,
        hypothesis: plannerOutput.hypothesis,
        changeSummary: executorOutput.change_summary,
        verdict,
        runStatus: runResult.status,
        valBpb: measuredBpb,
        bestBpb: research.best_bpb,
        reviewReason: reviewerOutput.reason,
        challengerNotes: (challengerOutput.challenges || []).map(c => c.issue),
        provenance,
      })
    } catch (repoErr) {
      console.warn(`[Research e${epochNumber}] repo write failed (non-fatal):`, repoErr instanceof Error ? repoErr.message : repoErr)
    }

    // 7. SPEC UPDATE — the plant tells the truth about research progress
    const newSpec: AgentSpecification = JSON.parse(JSON.stringify(specBefore))
    const newResearch: ResearchMeta = { ...research }
    if (verdict === 'keep' && measuredBpb !== null && measuredBpb < newResearch.best_bpb) {
      newResearch.best_bpb = measuredBpb
      newResearch.best_epoch = epochNumber
      newSpec.capabilities.push({
        id: `finding_e${epochNumber}`,
        description: `${plannerOutput.hypothesis.slice(0, 160)} (val_bpb ${measuredBpb.toFixed(4)}${unverified ? ', self-reported' : ''})`,
        added_epoch: epochNumber,
        status: 'active',
      })
      newSpec.meta.total_mutations = (newSpec.meta.total_mutations ?? 0) + 1
    } else {
      newSpec.meta.total_prunings = (newSpec.meta.total_prunings ?? 0) + 1
    }
    newResearch.last_run = {
      epoch: epochNumber,
      val_bpb: measuredBpb,
      verdict,
      status: runResult.status,
      hypothesis: plannerOutput.hypothesis,
    }
    newSpec.meta.research = newResearch
    newSpec.meta.stability_score = stabilityFromProgress(newResearch)
    newSpec.meta.total_epochs = epochNumber
    newSpec.meta.growth_stage = getGrowthStage(newSpec)

    // 8. COMMENTATOR
    let commentatorOutput = existingEpoch?.commentator_output as CommentatorOutput | undefined
    if (!commentatorOutput) {
      const { output, cost } = await callModel(
        roleAssignments.commentator,
        ctxFor(roleAssignments.commentator) + '\n\n' + RESEARCH_PROMPTS.commentator({
          hypothesis: plannerOutput.hypothesis,
          changeSummary: executorOutput.change_summary,
          run: runResult,
          verdict,
          bestBpb: newResearch.best_bpb,
          baselineBpb: newResearch.baseline_bpb,
        }),
        'Narrate this epoch for the observers.'
      )
      commentatorOutput = output as CommentatorOutput
      totalCost += cost
      await saveNote('Commentator', roleAssignments.commentator, commentatorOutput)
    }

    // 9. Persist epoch + experiment
    const plantGeometry = generatePlantFromSpec(newSpec)
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
    await sql`
      UPDATE experiments SET
        current_spec = ${JSON.stringify(newSpec)},
        current_epoch = ${epochNumber},
        epoch_in_progress = FALSE,
        epoch_started_at = NULL,
        status = 'growing'
      WHERE id = ${experimentId}
    `

    console.log(`[Research e${epochNumber}] ${verdict.toUpperCase()} — best ${newResearch.best_bpb.toFixed(4)} bpb (cost $${totalCost.toFixed(3)})`)
    return { success: true, epochNumber, newSpec, commentatorOutput }
  } catch (error) {
    await sql`
      UPDATE experiments SET epoch_in_progress = FALSE, epoch_started_at = NULL WHERE id = ${experimentId}
    `
    console.error(`[Research e${epochNumber}] failed:`, error instanceof Error ? error.message : error)
    throw error
  }
}

// Re-exported so tick handlers can surface run progress if they want it later.
export { pollResearchRun }
