/**
 * The work that comes after an epoch's Reviewer, run in its own request.
 *
 * An epoch's five roles already use most of Vercel's 800 s function limit
 * with reasoning on, and the code contribution (explorer subagent, code,
 * test subagent, CI, the author's Sprite) can take as long again. So the
 * epoch records what is left to do on its row (`followup`, written by
 * epoch-runner.ts) and finishes with the Commentator; this module does the
 * rest on a later tick:
 *   - the one code contribution, for the mutation the epoch picked;
 *   - any exhibit or lab proposal the Reviewer approved.
 *
 * It takes the same claim as an epoch (one thing at a time per experiment),
 * checks the daily budget first, and records its model calls in the spend
 * ledger under the epoch it belongs to, so the epoch's cost includes it.
 */
import { sql } from '@vercel/postgres'
import { contributeCode } from './code-contribution.js'
import { contributionBranchName } from './branch-names.js'
import { persistContribution } from './code-contributions-store.js'
import { addNotebookNote } from './notebook.js'
import { claimEpoch, releaseEpoch } from './epoch-claim.js'
import { checkDailyBudget, describeBudget, epochSpend, withSpendContext } from './spend.js'
import { pickContributionCandidate, sanitizeDecisions, sanitizeMutations } from './model-output.js'
import { answeredModel } from './openrouter.js'
import { modelDisplayName } from './types.js'
import type { AgentSpecification, ChallengerOutput, ExecutorOutput, Mutation, ReviewerOutput, RoleAssignments } from './types.js'
import { toolConfig } from './tools-config.js'
import { planTools } from './tool-requests.js'
import { recordToolRun } from './tool-runs-store.js'
import { alreadyRan, readToolVerdicts, runDeliverables, subagentAllowance, type EpochToolContext } from './epoch-tools.js'
import { findMutatedSpecItem } from './epoch-runner.js'

export type FollowUpStatus = 'none' | 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/** Stored on epochs.followup. */
export interface EpochFollowUp {
  status: FollowUpStatus
  contribution_mutation_index: number | null
  deliverables: boolean
  queued_at: string
  started_at?: string
  finished_at?: string
  result?: {
    pr_url?: string | null
    merged?: boolean
    ci_passed?: boolean | null
    deliverables?: Array<{ tool: string; status: string; summary: string }>
    note?: string
  }
}

export type FollowUpRun =
  | { ran: false; reason: string; epoch_number?: number }
  | { ran: true; epoch_number: number; status: FollowUpStatus; result: EpochFollowUp['result'] }

/** The oldest finished epoch of this experiment whose follow-up is still waiting, if any. */
export async function pendingFollowUp(experimentId: string): Promise<{ epochNumber: number } | null> {
  try {
    await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS followup JSONB`
    const r = await sql`
      SELECT epoch_number FROM epochs
      WHERE experiment_id = ${experimentId}
        AND spec_after IS NOT NULL
        AND followup->>'status' = 'pending'
      ORDER BY epoch_number ASC
      LIMIT 1
    `
    return r.rows[0] ? { epochNumber: Number(r.rows[0].epoch_number) } : null
  } catch {
    return null
  }
}

async function saveFollowUp(epochId: string, followup: EpochFollowUp): Promise<void> {
  await sql`UPDATE epochs SET followup = ${JSON.stringify(followup)} WHERE id = ${epochId}`
}

/**
 * Runs the oldest pending follow-up of an experiment. Never throws for the
 * work itself; returns what happened. Does nothing when there is none, when
 * today's budget is spent, or when an epoch holds the claim.
 */
export async function runEpochFollowUp(experimentId: string): Promise<FollowUpRun> {
  const pending = await pendingFollowUp(experimentId)
  if (!pending) return { ran: false, reason: 'nothing pending' }

  const budget = await checkDailyBudget()
  if (!budget.allowed) {
    console.warn(`[Follow-up] Not running epoch ${pending.epochNumber}'s follow-up: ${describeBudget(budget)}`)
    return { ran: false, reason: budget.reason ?? 'daily budget reached', epoch_number: pending.epochNumber }
  }
  if (!(await claimEpoch(experimentId))) return { ran: false, reason: 'an epoch is in progress', epoch_number: pending.epochNumber }

  return withSpendContext({ experimentId, epochNumber: pending.epochNumber, purpose: 'followup' }, async () => {
    try {
      return await runClaimed(experimentId, pending.epochNumber)
    } finally {
      await releaseEpoch(experimentId).catch(e =>
        console.error('[Follow-up] could not release the claim:', e instanceof Error ? e.message : e))
    }
  })
}

async function runClaimed(experimentId: string, epochNumber: number): Promise<FollowUpRun> {
  const r = await sql`SELECT * FROM epochs WHERE experiment_id = ${experimentId} AND epoch_number = ${epochNumber} LIMIT 1`
  const epoch = r.rows[0]
  const followup = epoch?.followup as EpochFollowUp | undefined
  if (!epoch || followup?.status !== 'pending') return { ran: false, reason: 'nothing pending', epoch_number: epochNumber }

  const epochId = epoch.id as string
  const state: EpochFollowUp = { ...followup, status: 'running', started_at: new Date().toISOString() }
  // Marked before the work, so a request that dies part way is not retried
  // forever (its branch may already exist). It shows as "running" with a
  // start time in the activity record.
  await saveFollowUp(epochId, state)

  const roles = epoch.role_assignments as RoleAssignments
  const executorOutput = (epoch.executor_output ?? {}) as ExecutorOutput
  const reviewerOutput = (epoch.reviewer_output ?? {}) as ReviewerOutput
  const challengerOutput = (epoch.challenger_output ?? {}) as ChallengerOutput
  const result: NonNullable<EpochFollowUp['result']> = {}
  let failed = false

  // The code contribution, for the same mutation the epoch picked.
  if (followup.contribution_mutation_index !== null) {
    try {
      const mutations = sanitizeMutations(executorOutput.mutations)
      const decisions = sanitizeDecisions(reviewerOutput.decisions, mutations.length)
      const candidate = pickContributionCandidate(mutations, decisions, challengerOutput.challenges)
      if (!candidate || candidate.decision.mutation_index !== followup.contribution_mutation_index) {
        result.note = 'the queued mutation is no longer an approved candidate'
      } else {
        const { mutation, decision } = candidate
        const spec = epoch.spec_after as AgentSpecification
        const agentContext = `${spec?.identity?.purpose || 'An autonomous agent'}${spec?.identity?.domain ? ` (domain: ${spec.identity.domain})` : ''}`
        const branchName = contributionBranchName(epochNumber, mutation.target, decision.mutation_index)
        const plan = planTools((executorOutput as unknown as Record<string, unknown>).tools, toolConfig())
        const chosen = plan.subagents ?? { explore: 1, test: true, chosen: false }
        const subagents = await subagentAllowance(chosen)
        if (subagents.note) console.warn(`[Follow-up ${epochNumber}] subagents trimmed: ${subagents.note}`)
        const contribution = await contributeCode({
          authorModelId: roles.executor,
          branchName,
          title: `Epoch ${epochNumber}: ${mutation.target}: ${mutation.path}`,
          description: `${mutation.rationale}\n\nSpec field: ${mutation.target}.${mutation.path}\nProposed value: ${JSON.stringify(decision.modified_value ?? mutation.value)}`,
          review: { mode: 'approved' }, // the Reviewer approved this mutation
          subagents: { explore: subagents.explore, test: subagents.test },
          agentContext,
        })
        for (const run of contribution.subagents ?? []) {
          await recordToolRun({
            experimentId, epoch: epochNumber, model: run.model, tool: run.kind === 'explore' ? 'subagent_explore' : 'subagent_test',
            requestSummary: run.kind === 'explore' ? (run.task || 'explore') : `test for ${branchName}`,
            status: run.ok ? 'ok' : 'error', costUsd: run.cost,
            detail: { branch: branchName, pr_url: contribution.pr_url ?? null, chosen_by_executor: chosen.chosen, files: run.files ?? [] },
          })
        }
        await persistContribution(experimentId, epochNumber, roles.executor, branchName, contribution)
        result.pr_url = contribution.pr_url ?? null
        result.merged = contribution.merged
        result.ci_passed = contribution.ci_passed ?? null
        if (contribution.merged) {
          console.log(`[Follow-up ${epochNumber}] Code contribution merged: ${contribution.pr_url}`)
          await tagMergedItem(experimentId, epochId, mutation as Mutation, decision, contribution.pr_url)
        } else if (contribution.ci_passed === false) {
          console.log(`[Follow-up ${epochNumber}] Code contribution failed CI: ${contribution.pr_url}`)
          const firstError = (contribution.ci_excerpt || '').split('\n').find(l => /FAIL|Error/.test(l))?.slice(0, 180) || 'see CI logs'
          await addNotebookNote(experimentId, epochNumber, 'CI (system)',
            `PR "${mutation.target}: ${mutation.path}" FAILED the test suite and was closed. ${firstError}`)
        }
      }
    } catch (e) {
      failed = true
      result.note = `contribution failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`
      console.warn(`[Follow-up ${epochNumber}] Code contribution failed:`, e instanceof Error ? e.message : e)
    }
  }

  // Exhibit and lab proposal, only those the Reviewer approved (runDeliverables checks).
  if (followup.deliverables) {
    try {
      const executorModel = answeredModel(executorOutput, roles.executor)
      const ctx: EpochToolContext = {
        experimentId, epochNumber, executorModelId: executorModel,
        assignedExecutorId: roles.executor, reviewerModelId: roles.reviewer,
      }
      const plan = planTools((executorOutput as unknown as Record<string, unknown>).tools, toolConfig())
      const outcomes = await runDeliverables(ctx, plan, readToolVerdicts(reviewerOutput), await alreadyRan(ctx),
        executorModel !== roles.executor ? (modelDisplayName(roles.executor) || roles.executor) : undefined)
      result.deliverables = outcomes
    } catch (e) {
      failed = true
      console.warn(`[Follow-up ${epochNumber}] deliverables failed:`, e instanceof Error ? e.message : e)
    }
  }

  // The epoch's cost now includes the follow-up's calls (same ledger key).
  const ledger = await epochSpend(experimentId, epochNumber)
  if (ledger) {
    await sql`
      UPDATE epochs SET cost_usd = ${ledger.cost_usd}, prompt_tokens = ${ledger.prompt_tokens}, completion_tokens = ${ledger.completion_tokens}
      WHERE id = ${epochId}
    `.catch(() => {})
  }

  const status: FollowUpStatus = failed ? 'failed' : 'done'
  await saveFollowUp(epochId, { ...state, status, finished_at: new Date().toISOString(), result })
  return { ran: true, epoch_number: epochNumber, status, result }
}

// A merged PR tags the leaf it backs, in the current spec (the plant draws it
// in the "real code" colour) and in the epoch's own spec_after.
async function tagMergedItem(
  experimentId: string, epochId: string, mutation: Mutation,
  decision: Parameters<typeof findMutatedSpecItem>[2], prUrl: string | undefined,
): Promise<void> {
  if (!prUrl) return
  try {
    const exp = (await sql`SELECT current_spec FROM experiments WHERE id = ${experimentId}`).rows[0]
    const spec = exp?.current_spec as AgentSpecification | undefined
    const item = spec ? findMutatedSpecItem(spec, mutation, decision) : null
    if (spec && item) {
      item.code_pr_url = prUrl
      await sql`UPDATE experiments SET current_spec = ${JSON.stringify(spec)} WHERE id = ${experimentId} AND status <> 'archived'`
    }
    const ep = (await sql`SELECT spec_after FROM epochs WHERE id = ${epochId}`).rows[0]
    const after = ep?.spec_after as AgentSpecification | undefined
    const epochItem = after ? findMutatedSpecItem(after, mutation, decision) : null
    if (after && epochItem) {
      epochItem.code_pr_url = prUrl
      await sql`UPDATE epochs SET spec_after = ${JSON.stringify(after)} WHERE id = ${epochId}`
    }
  } catch (e) {
    console.warn('[Follow-up] could not tag the merged leaf:', e instanceof Error ? e.message : e)
  }
}
