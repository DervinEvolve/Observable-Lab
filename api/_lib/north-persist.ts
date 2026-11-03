import { sql } from '@vercel/postgres'
import { runNorthExperiment, type NorthResult } from './north-runner.js'
import { generatePlantFromSpec } from './plant-generator.js'
import { contributeCode } from './code-contribution.js'
import { persistContribution } from './code-contributions-store.js'
import { addNotebookNote } from './notebook.js'
import { getRoleAssignments } from './role-rotation.js'
import { northBranchName } from './branch-names.js'
import { WILDCARD_MODELS, type AgentSpecification } from './types.js'

// Runs one North (+ optional GLM pairing) experiment against the given
// experiment's current spec, grafts the result on as a green leaf, and
// persists everything. Shared by the manual endpoint (api/north/run.ts)
// and the automatic periodic trigger inside the epoch cron (api/epoch/tick.ts).
export async function runAndPersistNorth(
  experimentId: string,
  currentSpec: AgentSpecification,
  epochNumber: number,
  recentDirection?: string
): Promise<NorthResult> {
  const result = await runNorthExperiment(currentSpec, { epochNumber, recentDirection })

  const newSpec: AgentSpecification = JSON.parse(JSON.stringify(currentSpec))
  newSpec.behaviors.push(result.contribution)
  newSpec.meta.total_mutations++

  const plantGeometry = generatePlantFromSpec(newSpec)

  await sql`
    UPDATE experiments SET current_spec = ${JSON.stringify(newSpec)} WHERE id = ${experimentId}
  `

  try {
    // Production never had this table — inserts were silently skipped and
    // North/GLM's actual dialogue was dropped. Create it on first use, same
    // pattern as code-contributions-store.
    await sql`
      CREATE TABLE IF NOT EXISTS transcripts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        experiment_id UUID NOT NULL,
        epoch_number INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        model_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `
    for (const entry of result.transcript) {
      await sql`
        INSERT INTO transcripts (experiment_id, epoch_number, speaker, model_id, text, source)
        VALUES (${experimentId}, ${epochNumber}, ${entry.speaker}, ${entry.model}, ${entry.text}, 'north')
      `
    }
  } catch (e) {
    console.warn('[North] transcript persist skipped:', e instanceof Error ? e.message : e)
  }

  // Give North's (or North+GLM's) contribution a real code change on the
  // AI-Agent repo. When GLM paired on this experiment, GLM is credited as the
  // actual author of the code — this is its own real contribution, not just
  // advice North summarized. No panel Reviewer exists for wildcard runs, so a
  // quick auto-review (the current epoch's assigned Reviewer model) decides
  // whether it merges — same approve/reject gate as the main pipeline.
  const pairedWithGlm = result.toolsUsed.includes('glm')
  try {
    const reviewerModelId = getRoleAssignments(epochNumber).reviewer
    const authorModelId = pairedWithGlm ? WILDCARD_MODELS.glm : WILDCARD_MODELS.north
    const branchName = northBranchName(epochNumber, pairedWithGlm)
    const codeResult = await contributeCode({
      authorModelId,
      branchName,
      title: `${pairedWithGlm ? 'North+GLM' : 'North'} wildcard experiment (epoch ${epochNumber}): ${result.hypothesis}`,
      description: `${result.hypothesis}\n\nContribution: ${result.contribution.description}${
        result.contribution.trigger ? `\nTrigger: ${result.contribution.trigger}` : ''
      }`,
      review: { mode: 'auto-review', reviewerModelId },
      deploySubagent: true, // a subagent writes a test for this contribution too
      deployExplorerSubagent: true, // a subagent researches the problem first, findings inform the code
      agentContext: `${currentSpec.identity.purpose || 'An autonomous agent'}${
        currentSpec.identity.domain ? ` (domain: ${currentSpec.identity.domain})` : ''
      }`,
    })
    await persistContribution(experimentId, epochNumber, authorModelId, branchName, codeResult)
    if (codeResult.ci_passed === false) {
      const firstError = (codeResult.ci_excerpt || '').split('\n').find(l => /FAIL|Error/.test(l))?.slice(0, 180) || 'see CI logs'
      await addNotebookNote(experimentId, epochNumber, 'CI (system)',
        `${pairedWithGlm ? 'North+GLM' : 'North'} wildcard PR FAILED the test suite and was closed. ${firstError}`)
    }
    if (codeResult.merged) {
      console.log(`[North] Code contribution merged: ${codeResult.pr_url}`)
      // Tag the leaf this PR backs (result.contribution is the same object
      // reference already pushed into newSpec.behaviors above) and persist
      // the tag — the plant renders it in a distinct "real code" color.
      result.contribution.code_pr_url = codeResult.pr_url
      await sql`
        UPDATE experiments SET current_spec = ${JSON.stringify(newSpec)} WHERE id = ${experimentId}
      `
    }
  } catch (e) {
    console.warn('[North] Code contribution failed (non-fatal):', e instanceof Error ? e.message : e)
  }

  return result
}
