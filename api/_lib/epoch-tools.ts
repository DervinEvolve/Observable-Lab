/**
 * Runs the tools the Executor chose, for epoch-runner.ts.
 *
 * Two phases:
 *  - side tools (a Sprite session, a GPU job, a request for public weights)
 *    start right after the Executor and run while the Challenger, rebuttal
 *    and Reviewer talk; the runner waits for them before the Commentator.
 *    A GPU job that names the weights asked for in the same answer waits for
 *    that fetch, and the two share the one wait a job always had; any other
 *    job starts at once.
 *  - deliverables (an exhibit, a lab proposal, a Tinker training run) run
 *    after the Reviewer, and only when the Reviewer approved them in
 *    "tool_verdicts".
 *
 * Every use is checked against its per-day limit and today's budget first,
 * stored in tool_runs (refusals as "skipped"), and its estimated cost is
 * written to the spend ledger so LAB_DAILY_BUDGET_USD counts it. A tool that
 * already ran in this epoch (the epoch is being resumed) does not run again.
 * Nothing here throws into the epoch.
 */
import { recordModelCall, checkDailyBudget, describeBudget } from './spend.js'
import { modelDisplayName } from './types.js'
import { recordToolRun, toolRunsToday, toolsRunInEpoch, getRecentToolRuns, type ToolRunStatus } from './tool-runs-store.js'
import { liveModelToolStatus, toolConfig, SPRITE_SESSION_TOTAL_MAX_S, type ToolConfig, type ToolName } from './tools-config.js'
import { LIVE_KEY_MAX_USD } from './live-model.js'
import type { ToolPlan } from './tool-requests.js'
import { estimateSpriteCost, liveModelClause, runSpriteSession, sessionTranscript } from './sprite-session.js'
import { GPU_JOB_WORST_CASE_S, estimateGpuCost, gpuJobWaitMs, gpuWaitAfterFetch, runGpuJob, runWeightsFetch } from './gpu-jobs.js'
import { describeFetch, estimateWeightsFetchCost, weightsLabel, type WeightsFetchResult } from './weights.js'
import { contributeExhibit } from './exhibit-contribution.js'
import { openLabProposal } from './lab-proposals.js'
import { TINKER_TOOL } from './tinker.js'
import { runTinkerTrain, tinkerRequestSummary, tinkerWorstCaseUsd } from './tinker-run.js'

export interface EpochToolContext {
  experimentId: string
  epochNumber: number
  executorModelId: string   // the model that asked (the one that answered the Executor call)
  assignedExecutorId: string
  reviewerModelId: string
}

/** One line per tool use, for the Commentator and the logs. Built from what actually happened. */
export interface ToolOutcome {
  tool: string
  /** "started": a training run that is still going; its record is written when its result is collected. */
  status: ToolRunStatus | 'started'
  summary: string
}

const name = (id: string) => modelDisplayName(id) || id.split('/').pop() || id

async function allowed(tool: ToolName, config: ToolConfig, worstCaseUsd: number):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const used = await toolRunsToday(tool)
    if (used >= config[tool].per_day) return { ok: false, reason: `daily limit of ${config[tool].per_day} reached` }
  } catch {
    return { ok: false, reason: 'could not read today\'s tool runs' }
  }
  const budget = await checkDailyBudget()
  if (!budget.allowed) return { ok: false, reason: describeBudget(budget) }
  if (budget.spent_usd !== null && budget.spent_usd + worstCaseUsd > budget.budget_usd) {
    return { ok: false, reason: `its worst case ($${worstCaseUsd.toFixed(2)}) would pass today's budget` }
  }
  return { ok: true }
}

async function skip(ctx: EpochToolContext, tool: string, summary: string, reason: string): Promise<ToolOutcome> {
  console.warn(`[Epoch ${ctx.epochNumber}] tool ${tool} skipped: ${reason}`)
  await recordToolRun({
    experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool,
    requestSummary: summary, status: 'skipped', outputTail: reason,
  })
  return { tool, status: 'skipped', summary: `${tool} not run: ${reason}` }
}

/** Tool time goes on the same ledger as model calls, marked as an estimate. */
async function ledger(ctx: EpochToolContext, tool: string, costUsd: number): Promise<void> {
  if (!(costUsd > 0)) return
  await recordModelCall({
    model: `tool/${tool}`, assigned: ctx.assignedExecutorId, cost_usd: costUsd, cost_source: 'estimate',
    prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
  })
}

/** Stores the requests that were refused while reading the plan (unknown or disabled tools, bad input). */
export async function recordIgnored(ctx: EpochToolContext, plan: ToolPlan): Promise<void> {
  for (const item of plan.ignored.slice(0, 10)) {
    console.warn(`[Epoch ${ctx.epochNumber}] tool request ignored: ${item.tool}: ${item.reason}`)
    await recordToolRun({
      experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: item.tool,
      requestSummary: 'ignored request', status: 'skipped', outputTail: item.reason,
    })
  }
}

export async function alreadyRan(ctx: EpochToolContext): Promise<Set<string>> {
  return toolsRunInEpoch(ctx.experimentId, ctx.epochNumber)
}

export async function runSideTools(ctx: EpochToolContext, plan: ToolPlan, ran: Set<string>): Promise<ToolOutcome[]> {
  const config = toolConfig()
  const out: ToolOutcome[] = []
  const tasks: Promise<void>[] = []
  const done = (tool: string) => ran.has('*') || ran.has(tool)
  // the side tools run at once, so each is checked against their combined worst case
  // a session that comes with a model key can also spend up to that key's limit
  const liveModel = liveModelToolStatus(config).enabled
  const worst = {
    sprite_session: plan.sprite_session && !done('sprite_session') ? estimateSpriteCost(SPRITE_SESSION_TOTAL_MAX_S * 1000) + (liveModel ? LIVE_KEY_MAX_USD : 0) : 0,
    gpu_job: plan.gpu_job && !done('gpu_job') ? estimateGpuCost(GPU_JOB_WORST_CASE_S) : 0,
    weights: plan.weights && !done('weights') ? estimateWeightsFetchCost(null) : 0,
  }
  // A tool that has finished (its real cost is on the ledger) or was skipped
  // no longer counts at its worst case. This only matters for a GPU job that
  // waited for its weights: every other check is made at the start, when
  // nothing has finished and the sum is the combined worst case.
  const settled = new Set<keyof typeof worst>()
  const worstCase = () => (settled.has('sprite_session') ? 0 : worst.sprite_session)
    + (settled.has('gpu_job') ? 0 : worst.gpu_job)
    + (settled.has('weights') ? 0 : worst.weights)
  const startedAt = Date.now()
  const weightsOn = config.weights.enabled && config.weights.per_day > 0

  // Public weights: the lab's fetcher on Modal checks and downloads them.
  // A GPU job below that names the same repository waits for this, so a job
  // can use weights asked for in the same answer.
  let fetched: Promise<WeightsFetchResult | null> = Promise.resolve(null)
  if (plan.weights && !done('weights')) {
    const request = plan.weights
    const summary = `public weights ${request.repo}${request.revision === 'main' ? '' : ` at ${request.revision}`}`
    fetched = (async () => {
      const ok = await allowed('weights', config, worstCase())
      if (!ok.ok) {
        settled.add('weights')
        out.push(await skip(ctx, 'weights', summary, ok.reason))
        return null
      }
      const result = await runWeightsFetch(request)
      await ledger(ctx, 'weights', result.cost_usd)
      settled.add('weights')
      const status: ToolRunStatus = result.status === 'ok' ? 'ok' : result.status === 'refused' ? 'failed' : result.status === 'pending' ? 'timeout' : 'error'
      const line = describeFetch(result)
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: 'weights',
        requestSummary: summary, status, durationMs: result.wall_seconds === null ? null : result.wall_seconds * 1000,
        costUsd: result.cost_usd, outputTail: line,
        detail: {
          repo: result.repo, revision: request.revision, sha: result.sha, license: result.license, size_bytes: result.size_bytes,
          files: result.files, cached: result.cached, evicted: result.evicted, rule: result.rule ?? null,
        },
      })
      out.push({ tool: 'weights', status, summary: `${name(ctx.executorModelId)} asked for public weights: ${line}` })
      return result
    })().catch(e => {
      console.warn(`[Epoch ${ctx.epochNumber}] side tool failed (non-fatal):`, e instanceof Error ? e.message : e)
      settled.add('weights')
      return null
    })
    tasks.push(fetched.then(() => undefined))
  }
  if (plan.sprite_session && !done('sprite_session')) {
    const session = plan.sprite_session
    const summary = `${session.purpose || 'Sprite session'} (${session.commands.length} command${session.commands.length === 1 ? '' : 's'})`
    tasks.push((async () => {
      const ok = await allowed('sprite_session', config, worstCase())
      if (!ok.ok) {
        settled.add('sprite_session')
        return void out.push(await skip(ctx, 'sprite_session', summary, ok.reason))
      }
      const result = await runSpriteSession(ctx.executorModelId, session.commands,
        liveModel ? { liveModel: { experimentId: ctx.experimentId, epoch: ctx.epochNumber } } : {})
      await ledger(ctx, 'sprite_session', result.cost_usd)
      settled.add('sprite_session')
      const last = result.commands[result.commands.length - 1]
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: 'sprite_session',
        requestSummary: summary, status: result.status, exitCode: last?.exit_code ?? null, durationMs: result.duration_ms,
        costUsd: result.cost_usd, outputTail: sessionTranscript(result),
        detail: {
          sprite: result.sprite_name,
          commands: result.commands.map(c => ({ run: c.run, exit_code: c.exit_code, duration_ms: c.duration_ms, timed_out: c.timed_out })),
          // the model calls themselves are in live_model_calls and, with their real cost, in the spend ledger
          ...(result.live_model ? { live_model: result.live_model } : {}),
        },
      })
      const exits = result.commands.map(c => c.exit_code === null ? '?' : String(c.exit_code)).join(', ')
      const modelCalls = liveModelClause(result.live_model)
      out.push({ tool: 'sprite_session', status: result.status, summary: `${name(ctx.executorModelId)} ran ${result.commands.length} command(s) in its Sprite (exit codes ${exits || 'none'})${modelCalls}${result.error ? `; error: ${result.error}` : ''}` })
    })())
  }

  if (plan.gpu_job && !done('gpu_job')) {
    const job = plan.gpu_job
    const summary = job.purpose || 'GPU job'
    // Only a job that names the repository asked for in this same answer
    // waits for that fetch. A job that names other weights, or none, starts
    // at once beside it, as GPU jobs always have.
    const waitsForFetch = Boolean(job.weights && plan.weights && !done('weights') && job.weights.repo === plan.weights.repo)
    tasks.push((async () => {
      let weights = job.weights
      let maxWaitMs: number | undefined
      if (waitsForFetch && weights) {
        // The job gets exactly the commit that was just checked. If that
        // fetch ran and did not end with the weights on the shelf (a rule
        // refused them, or they are still downloading), the job is not
        // started: it was written for weights it would not find, or may no
        // longer have. A request that was not run at all (over its daily
        // limit) leaves it to the Modal controller, which starts the job only
        // if the weights are on the shelf.
        const fetch = await fetched
        if (fetch) {
          if (fetch.status !== 'ok' || !fetch.sha) {
            return void out.push(await skip(ctx, 'gpu_job', summary, `the weights it names (${weights.repo}) are not on the shelf: ${describeFetch(fetch)}`))
          }
          if (!weights.sha) weights = { repo: weights.repo, sha: fetch.sha }
          // The fetch and the job share the one wait a job always had, so the
          // pair holds the epoch no longer than a job alone did. When the
          // fetch used too much of it, the job is not started: its GPU time
          // would be spent on a result this epoch could not collect or count.
          const waitedMs = Date.now() - startedAt
          const left = gpuWaitAfterFetch(gpuJobWaitMs(), waitedMs)
          if (left === null) {
            return void out.push(await skip(ctx, 'gpu_job', summary, `its weights (${weights.repo}) took ${Math.round(waitedMs / 1000)} s to arrive, which leaves too little of this epoch's wait for a job; they are on the shelf now`))
          }
          maxWaitMs = left
        }
      }
      const ok = await allowed('gpu_job', config, worstCase())
      if (!ok.ok) return void out.push(await skip(ctx, 'gpu_job', summary, ok.reason))
      const result = await runGpuJob(job.script, { ...(weights ? { weights } : {}), ...(maxWaitMs !== undefined ? { maxWaitMs } : {}) })
      await ledger(ctx, 'gpu_job', result.cost_usd)
      // While public weights are on, every job is labelled from what its
      // sandbox really had mounted. A job whose script never ran (nothing
      // started, or the sandbox could not read its weights) gets no label.
      const started = result.gpu !== null && result.stage !== 'weights' && result.stage !== 'mount'
      const label = weightsOn && started ? weightsLabel(result.weights) : null
      const status: ToolRunStatus = result.status === 'ok' ? 'ok' : result.status === 'timeout' ? 'timeout' : result.status === 'error' ? 'failed' : 'error'
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: 'gpu_job',
        requestSummary: label ? `${weightsLabel(result.weights, true)}: ${summary}` : summary, status, exitCode: result.exit_code,
        durationMs: result.wall_seconds === null ? null : result.wall_seconds * 1000, costUsd: result.cost_usd,
        outputTail: [result.log_tail, result.error ? `error: ${result.error}` : ''].filter(Boolean).join('\n'),
        detail: {
          gpu: result.gpu, stage: result.stage ?? null, run_seconds: result.run_seconds, script_chars: job.script.length,
          ...(label ? { label, weights: result.weights, output: 'self-reported, unverified' } : {}),
        },
      })
      out.push({ tool: 'gpu_job', status, summary: `${name(ctx.executorModelId)}'s GPU job${label ? ` (${label})` : ''}: ${result.status}${result.stage ? ` at stage ${result.stage}` : ''}${result.exit_code !== null ? `, exit ${result.exit_code}` : ''}` })
    })())
  }

  await Promise.all(tasks.map(t => t.catch(e => console.warn(`[Epoch ${ctx.epochNumber}] side tool failed (non-fatal):`, e instanceof Error ? e.message : e))))
  return out
}

export type ToolVerdicts = Partial<Record<'exhibit' | 'lab_proposal' | 'tinker_train', 'approve' | 'reject'>>

/** The Reviewer's verdicts on tool deliverables; anything but an explicit "approve" is a no. */
export function readToolVerdicts(reviewerOutput: unknown): ToolVerdicts {
  const raw = reviewerOutput && typeof reviewerOutput === 'object' ? (reviewerOutput as Record<string, unknown>).tool_verdicts : undefined
  const out: ToolVerdicts = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of ['exhibit', 'lab_proposal', 'tinker_train'] as const) {
    const v = String((raw as Record<string, unknown>)[key] ?? '').toLowerCase()
    if (v === 'approve' || v === 'reject') out[key] = v
  }
  return out
}

export async function runDeliverables(
  ctx: EpochToolContext, plan: ToolPlan, verdicts: ToolVerdicts, ran: Set<string>, fallbackFor?: string,
): Promise<ToolOutcome[]> {
  const config = toolConfig()
  const out: ToolOutcome[] = []
  const tasks: Promise<void>[] = []
  const done = (tool: string) => ran.has('*') || ran.has(tool)
  const author = name(ctx.executorModelId)
  const reviewer = name(ctx.reviewerModelId)

  if (plan.exhibit && !done('exhibit')) {
    const ex = plan.exhibit
    const summary = `exhibit ${ex.slug}`
    tasks.push((async () => {
      if (verdicts.exhibit !== 'approve') return void out.push(await skip(ctx, 'exhibit', summary, 'the Reviewer did not approve it'))
      const ok = await allowed('exhibit', config, 0)
      if (!ok.ok) return void out.push(await skip(ctx, 'exhibit', summary, ok.reason))
      const r = await contributeExhibit({
        epochNumber: ctx.epochNumber, slug: ex.slug, raw: ex.exhibit, authorName: author,
        authorModelId: ctx.executorModelId, fallbackFor, reviewerName: reviewer,
      })
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: 'exhibit',
        requestSummary: summary, status: r.status, durationMs: r.durationMs,
        outputTail: [r.error, r.ci_excerpt].filter(Boolean).join('\n') || null,
        detail: { slug: r.slug, pr_url: r.pr_url ?? null, ci_passed: r.ci_passed },
      })
      out.push({ tool: 'exhibit', status: r.status, summary: `${author}'s exhibit "${ex.slug}": ${r.status}${r.error ? ` (${r.error})` : ''}` })
    })())
  }

  if (plan.lab_proposal && !done('lab_proposal')) {
    const p = plan.lab_proposal
    const summary = `lab proposal: ${p.title}`
    tasks.push((async () => {
      if (verdicts.lab_proposal !== 'approve') return void out.push(await skip(ctx, 'lab_proposal', summary, 'the Reviewer did not approve it'))
      const ok = await allowed('lab_proposal', config, 0)
      if (!ok.ok) return void out.push(await skip(ctx, 'lab_proposal', summary, ok.reason))
      const r = await openLabProposal({
        epochNumber: ctx.epochNumber, proposal: p, authorName: author, authorModelId: ctx.executorModelId,
        fallbackFor, reviewerName: reviewer,
      })
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: 'lab_proposal',
        requestSummary: summary, status: r.status === 'opened' ? 'opened' : 'error', durationMs: r.durationMs,
        outputTail: r.error ?? null, detail: { pr_url: r.pr_url ?? null, files: p.files.map(f => f.path) },
      })
      out.push({ tool: 'lab_proposal', status: r.status === 'opened' ? 'opened' : 'error', summary: `${author}'s proposal to the lab repository: ${r.status === 'opened' ? 'opened for the owner to review' : `not opened (${r.error})`}` })
    })())
  }

  // A Tinker training run (tinker-run.ts). The Reviewer must have approved
  // it; then the runs-per-day limit and the lab's budget are checked here,
  // against the most the run could cost, and the Tinker caps in tinker-run.
  // A run still training when the wait ends writes its record when a later
  // tick collects it (collectTinkerRuns), so it is not in tool_runs yet; the
  // epoch's one row in tinker_runs is what stops a second run.
  if (plan.tinker_train && !done(TINKER_TOOL)) {
    const request = plan.tinker_train
    const summary = tinkerRequestSummary(request.base_model, request.examples.length, request.purpose)
    tasks.push((async () => {
      if (verdicts.tinker_train !== 'approve') return void out.push(await skip(ctx, TINKER_TOOL, summary, 'the Reviewer did not approve it'))
      const ok = await allowed(TINKER_TOOL, config, tinkerWorstCaseUsd(request))
      if (!ok.ok) return void out.push(await skip(ctx, TINKER_TOOL, summary, ok.reason))
      const outcome = await runTinkerTrain(ctx, request)
      if (outcome.status === 'skipped') return void out.push(await skip(ctx, TINKER_TOOL, summary, outcome.summary))
      out.push(outcome)
    })())
  }

  await Promise.all(tasks.map(t => t.catch(e => console.warn(`[Epoch ${ctx.epochNumber}] tool deliverable failed (non-fatal):`, e instanceof Error ? e.message : e))))
  return out
}

/** How many subagents today's limit still allows, trimming the explorers first. */
export async function subagentAllowance(plan: ToolPlan['subagents']): Promise<{ explore: number; test: boolean; note?: string }> {
  const limit = toolConfig().subagents.per_day
  let used: number
  try {
    used = (await toolRunsToday('subagent_explore')) + (await toolRunsToday('subagent_test'))
  } catch {
    return { explore: 0, test: false, note: 'could not read today\'s subagent runs' }
  }
  let left = Math.max(0, limit - used)
  const test = plan.test && left > 0
  if (test) left--
  const explore = Math.min(plan.explore, left)
  const trimmed = explore < plan.explore || test !== plan.test
  return { explore, test, ...(trimmed ? { note: `daily subagent limit of ${limit}` } : {}) }
}

/** Recent tool results for the next epoch's shared context, from stored records only. */
export async function recentToolContext(experimentId: string): Promise<string> {
  const runs = (await getRecentToolRuns(experimentId, 6)).filter(r => r.status !== 'skipped')
  if (!runs.length) return ''
  return runs.map(r => {
    const tail = (r.output_tail || '').split('\n').slice(-4).join(' | ').slice(0, 300)
    return `- epoch ${r.epoch}, ${name(r.model)}, ${r.tool} (${r.status}${r.exit_code !== null ? `, exit ${r.exit_code}` : ''}): ${r.request_summary || ''}${tail ? ` -> ${tail}` : ''}`
  }).join('\n')
}
