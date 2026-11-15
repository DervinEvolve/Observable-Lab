/**
 * The work that comes after an epoch's Reviewer, run in requests of its own.
 *
 * An epoch's five roles already use most of Vercel's 800 s function limit
 * with reasoning on, and a code contribution (explorers, code, test, CI,
 * the author's Sprite) can take as long again. So the epoch records what is
 * left to do on its row (`followup`, written by epoch-runner.ts) and
 * finishes with the Commentator. Later ticks do the rest in two stages:
 *
 *   pending      stage 1: explorers, code, test subagent, push, open the PR.
 *                Model calls run against a deadline inside this request.
 *   awaiting_ci  stage 2 (a later tick): read CI for the exact commit, run
 *                the author's Sprite tests, merge or close; then any exhibit
 *                or lab proposal the Reviewer approved.
 *   done | failed
 *
 * CI runs on GitHub between the two stages, so no request waits for it.
 * Each stage takes the same claim as an epoch (one thing at a time), checks
 * the daily budget first, and records its model calls under the epoch, so
 * the epoch's cost includes them.
 */
import { sql } from '@vercel/postgres'
import { contributeCode, resolveContribution, type ContributionResult, type PendingContribution } from './code-contribution.js'
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

export type FollowUpStatus = 'none' | 'pending' | 'running' | 'awaiting_ci' | 'done' | 'skipped' | 'failed'

// Stage 1 stops starting model work this long after it began, leaving time
// to push, open the PR and save inside the 800 s limit.
export const STAGE1_BUDGET_MS = 690_000
// Stage 2 keeps waiting for CI that is still running, at most this long
// after the PR opened; after that the PR is closed as "no CI result".
export const CI_WAIT_LIMIT_MS = 3 * 60 * 60 * 1000
// A stage that has been "running" this long died with its request.
const STUCK_AFTER_MS = 30 * 60 * 1000
export const MAX_RETRIES = 1

/** Stored on epochs.followup. */
export interface EpochFollowUp {
  status: FollowUpStatus
  contribution_mutation_index: number | null
  deliverables: boolean
  queued_at: string
  started_at?: string
  finished_at?: string
  stage?: 1 | 2
  retries?: number
  pending?: PendingContribution          // the open PR, between the stages
  contribution?: ContributionResult     // what stage 1 produced, completed by stage 2
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

/** The oldest finished epoch of this experiment with follow-up work waiting, if any. */
export async function pendingFollowUp(experimentId: string): Promise<{ epochNumber: number } | null> {
  try {
    await sql`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS followup JSONB`
    const r = await sql`
      SELECT epoch_number FROM epochs
      WHERE experiment_id = ${experimentId}
        AND spec_after IS NOT NULL
        AND followup->>'status' IN ('pending', 'awaiting_ci')
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
 * Puts an epoch's follow-up back in the queue once, when it ended without
 * opening a pull request (or died while running). Returns why it can't
 * when it can't.
 */
export async function requeueFollowUp(experimentId: string, epochNumber: number): Promise<{ ok: boolean; reason?: string }> {
  const r = await sql`SELECT id, followup FROM epochs WHERE experiment_id = ${experimentId} AND epoch_number = ${epochNumber} LIMIT 1`
  const row = r.rows[0]
  const f = row?.followup as EpochFollowUp | undefined
  if (!row || !f) return { ok: false, reason: 'no follow-up for that epoch' }
  if ((f.retries ?? 0) >= MAX_RETRIES) return { ok: false, reason: 'already retried' }
  const stuck = f.status === 'running' && f.started_at && Date.now() - new Date(f.started_at).getTime() > STUCK_AFTER_MS
  const noPr = (f.status === 'done' || f.status === 'failed') && !f.result?.pr_url
  if (!stuck && !noPr) return { ok: false, reason: `nothing to retry (status ${f.status}${f.result?.pr_url ? ', a PR was opened' : ''})` }
  const next: EpochFollowUp = {
    status: 'pending', contribution_mutation_index: f.contribution_mutation_index, deliverables: f.deliverables,
    queued_at: new Date().toISOString(), retries: (f.retries ?? 0) + 1,
  }
  await saveFollowUp(row.id as string, next)
  return { ok: true }
}

/**
 * Runs the next stage of the oldest waiting follow-up. Never throws for the
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
  if (!epoch || (followup?.status !== 'pending' && followup?.status !== 'awaiting_ci')) {
    return { ran: false, reason: 'nothing pending', epoch_number: epochNumber }
  }
  return followup.status === 'pending'
    ? stageOne(experimentId, epochNumber, epoch, followup)
    : stageTwo(experimentId, epochNumber, epoch, followup)
}

// Stage 1: write the code and open the PR, within a deadline.
async function stageOne(experimentId: string, epochNumber: number, epoch: Record<string, any>, followup: EpochFollowUp): Promise<FollowUpRun> {
  const epochId = epoch.id as string
  const startedAt = Date.now()
  const deadlineAt = startedAt + STAGE1_BUDGET_MS
  // Marked before the work, so a request that dies part way is not retried
  // by itself (it can be retried once by hand, see requeueFollowUp).
  const state: EpochFollowUp = { ...followup, status: 'running', stage: 1, started_at: new Date(startedAt).toISOString() }
  await saveFollowUp(epochId, state)

  const roles = epoch.role_assignments as RoleAssignments
  const executorOutput = (epoch.executor_output ?? {}) as ExecutorOutput
  const reviewerOutput = (epoch.reviewer_output ?? {}) as ReviewerOutput
  const challengerOutput = (epoch.challenger_output ?? {}) as ChallengerOutput
  const result: NonNullable<EpochFollowUp['result']> = {}
  let pendingPr: PendingContribution | undefined
  let contribution: ContributionResult | undefined
  let failed = false

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
        contribution = await contributeCode({
          authorModelId: roles.executor,
          branchName,
          title: `Epoch ${epochNumber}: ${mutation.target}: ${mutation.path}`,
          description: `${mutation.rationale}\n\nSpec field: ${mutation.target}.${mutation.path}\nProposed value: ${JSON.stringify(decision.modified_value ?? mutation.value)}`,
          review: { mode: 'approved' }, // the Reviewer approved this mutation
          subagents: { explore: subagents.explore, test: subagents.test },
          agentContext,
          deadlineAt,
          deferResolution: true,
        })
        for (const run of contribution.subagents ?? []) {
          await recordToolRun({
            experimentId, epoch: epochNumber, model: run.model, tool: run.kind === 'explore' ? 'subagent_explore' : 'subagent_test',
            requestSummary: run.kind === 'explore' ? (run.task || 'explore') : `test for ${branchName}`,
            status: run.ok ? 'ok' : 'error', costUsd: run.cost,
            detail: { branch: branchName, pr_url: contribution.pr_url ?? null, chosen_by_executor: chosen.chosen, files: run.files ?? [] },
          })
        }
        pendingPr = contribution.pending
        result.pr_url = contribution.pr_url ?? null
        if (!pendingPr) {
          // No PR was opened (no usable files, or a GitHub error): record it now.
          result.merged = false
          result.note = contribution.files.length ? 'the pull request could not be opened' : 'the model returned no usable files'
          await persistContribution(experimentId, epochNumber, roles.executor, branchName, contribution)
        }
      }
    } catch (e) {
      failed = true
      result.note = `contribution failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`
      console.warn(`[Follow-up ${epochNumber}] Code contribution failed:`, e instanceof Error ? e.message : e)
    }
  }

  await updateEpochCost(experimentId, epochNumber, epochId)
  const next: FollowUpStatus = pendingPr || followup.deliverables ? 'awaiting_ci' : failed ? 'failed' : 'done'
  await saveFollowUp(epochId, {
    ...state, status: next, stage: next === 'awaiting_ci' ? 2 : 1,
    ...(next === 'awaiting_ci' ? {} : { finished_at: new Date().toISOString() }),
    pending: pendingPr,
    contribution: pendingPr ? withoutLargeFiles(contribution) : undefined,
    result,
  })
  console.log(`[Follow-up ${epochNumber}] stage 1 ${next}${result.pr_url ? `: ${result.pr_url}` : ''}${result.note ? ` (${result.note})` : ''}`)
  return { ran: true, epoch_number: epochNumber, status: next, result }
}

// Stage 2: read CI, run the Sprite tests, merge or close; then deliverables.
async function stageTwo(experimentId: string, epochNumber: number, epoch: Record<string, any>, followup: EpochFollowUp): Promise<FollowUpRun> {
  const epochId = epoch.id as string
  const roles = epoch.role_assignments as RoleAssignments
  const executorOutput = (epoch.executor_output ?? {}) as ExecutorOutput
  const reviewerOutput = (epoch.reviewer_output ?? {}) as ReviewerOutput
  const result: NonNullable<EpochFollowUp['result']> = { ...(followup.result ?? {}) }
  let failed = false

  if (followup.pending) {
    const pending = followup.pending
    try {
      const age = Date.now() - new Date(pending.opened_at).getTime()
      const resolved = await resolveContribution(pending, { ciWaitMs: 60_000, waitIfRunning: age < CI_WAIT_LIMIT_MS })
      if (resolved.status === 'not_ready') {
        console.log(`[Follow-up ${epochNumber}] CI still running for ${pending.pr_url}; trying again next tick`)
        return { ran: true, epoch_number: epochNumber, status: 'awaiting_ci', result }
      }
      result.merged = resolved.merged
      result.ci_passed = resolved.ci_passed
      const final: ContributionResult = {
        ...(followup.contribution ?? { files: [], subagent_files: [], author: modelDisplayName(pending.author_model_id) || pending.author_model_id, cost: 0 }),
        merged: resolved.merged, ci_passed: resolved.ci_passed, ci_excerpt: resolved.ci_excerpt, sprite: resolved.sprite,
        pr_url: pending.pr_url, pending: undefined,
      }
      await persistContribution(experimentId, epochNumber, roles.executor, pending.branch, final)
      const mutations = sanitizeMutations(executorOutput.mutations)
      const decisions = sanitizeDecisions(reviewerOutput.decisions, mutations.length)
      const index = followup.contribution_mutation_index
      const mutation = index !== null ? mutations[index] : undefined
      const decision = decisions.find(d => d.mutation_index === index)
      if (resolved.merged && mutation?.type && decision) {
        console.log(`[Follow-up ${epochNumber}] Code contribution merged: ${pending.pr_url}`)
        await tagMergedItem(experimentId, epochId, mutation as Mutation, decision, pending.pr_url)
      } else if (resolved.ci_passed === false && mutation) {
        console.log(`[Follow-up ${epochNumber}] Code contribution failed CI: ${pending.pr_url}`)
        const firstError = (resolved.ci_excerpt || '').split('\n').find(l => /FAIL|Error/.test(l))?.slice(0, 180) || 'see CI logs'
        await addNotebookNote(experimentId, epochNumber, 'CI (system)',
          `PR "${mutation.target}: ${mutation.path}" FAILED the test suite and was closed. ${firstError}`)
      }
    } catch (e) {
      failed = true
      result.note = `resolving the pull request failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`
      console.warn(`[Follow-up ${epochNumber}] resolve failed:`, e instanceof Error ? e.message : e)
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
      result.deliverables = await runDeliverables(ctx, plan, readToolVerdicts(reviewerOutput), await alreadyRan(ctx),
        executorModel !== roles.executor ? (modelDisplayName(roles.executor) || roles.executor) : undefined)
    } catch (e) {
      failed = true
      console.warn(`[Follow-up ${epochNumber}] deliverables failed:`, e instanceof Error ? e.message : e)
    }
  }

  await updateEpochCost(experimentId, epochNumber, epochId)
  const status: FollowUpStatus = failed ? 'failed' : 'done'
  await saveFollowUp(epochId, {
    ...followup, status, stage: 2, finished_at: new Date().toISOString(),
    pending: undefined, contribution: undefined, result,
  })
  console.log(`[Follow-up ${epochNumber}] stage 2 ${status}${result.merged ? ': merged' : ''}`)
  return { ran: true, epoch_number: epochNumber, status, result }
}

// The epoch's cost includes its follow-up calls (same ledger key).
async function updateEpochCost(experimentId: string, epochNumber: number, epochId: string): Promise<void> {
  const ledger = await epochSpend(experimentId, epochNumber)
  if (!ledger) return
  await sql`
    UPDATE epochs SET cost_usd = ${ledger.cost_usd}, prompt_tokens = ${ledger.prompt_tokens}, completion_tokens = ${ledger.completion_tokens}
    WHERE id = ${epochId}
  `.catch(() => {})
}

// Between the stages the row only needs the file names; the contents are
// on the PR branch. Keeps the epoch row small.
function withoutLargeFiles(c: ContributionResult | undefined): ContributionResult | undefined {
  if (!c) return undefined
  const trim = (files: ContributionResult['files']) => files.map(f => ({ path: f.path, content: f.content.length > 20_000 ? f.content.slice(0, 20_000) : f.content }))
  return { ...c, files: trim(c.files), subagent_files: trim(c.subagent_files), pending: undefined }
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
