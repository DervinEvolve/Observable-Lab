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
 *  - deliverables (an exhibit, a lab proposal, a Tinker training run, a
 *    request to keep a trained adapter) run after the Reviewer, and only
 *    when the Reviewer approved them in "tool_verdicts".
 *
 * Every use is checked against its per-day limit and today's budget first,
 * stored in tool_runs (refusals as "skipped"), and its estimated cost is
 * written to the spend ledger so LAB_DAILY_BUDGET_USD counts it. A tool that
 * already ran in this epoch (the epoch is being resumed) does not run again.
 * Nothing here throws into the epoch.
 *
 * Public datasets (datasets.ts), while they are on: a request for one is a
 * side tool like a request for weights, a GPU job that names the dataset
 * asked for in the same answer waits for that fetch in the same way, and a
 * Tinker training request that names a shelf dataset has its rows read by
 * the lab's reader after the Reviewer approved it and before anything is
 * estimated, set aside or started.
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
import { pendingModelKeepsToday, tinkerRunsToday } from './tinker-store.js'
import { KEEP_TOOL } from './tinker-keep-request.js'
import { keepAdapter } from './tinker-keep.js'
import {
  DATASETS_TOOL, datasetLabel, datasetRequestSummary, datasetRunCeiling, datasetsReadWaitMs, describeDatasetFetch, describeRows,
  estimateDatasetFetchCost, estimateDatasetReadCost, tinkerRequestFromRows,
  type DatasetFetchResult, type TinkerDatasetRecord, type TinkerDatasetRequest,
} from './datasets.js'
import { readDatasetRows, runDatasetFetch } from './datasets-client.js'
import { tinkerWaitMs, type TinkerRequest } from './tinker.js'

/** The reading of a shelf dataset's rows for a training run is stored under this, apart from the run itself. */
export const DATASET_ROWS_TOOL = 'dataset_rows'

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

/**
 * `countToday` replaces the count of stored tool runs for a tool whose runs
 * are stored late: a Tinker run still training has no tool_runs row yet, so
 * its limit is counted from the runs that were opened.
 */
async function allowed(tool: ToolName, config: ToolConfig, worstCaseUsd: number, countToday: () => Promise<number> = () => toolRunsToday(tool)):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const used = await countToday()
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
    datasets: plan.datasets && !done(DATASETS_TOOL) ? estimateDatasetFetchCost(null) : 0,
  }
  // A tool that has finished (its real cost is on the ledger) or was skipped
  // no longer counts at its worst case. This only matters for a GPU job that
  // waited for its weights: every other check is made at the start, when
  // nothing has finished and the sum is the combined worst case.
  const settled = new Set<keyof typeof worst>()
  const worstCase = () => (settled.has('sprite_session') ? 0 : worst.sprite_session)
    + (settled.has('gpu_job') ? 0 : worst.gpu_job)
    + (settled.has('weights') ? 0 : worst.weights)
    + (settled.has('datasets') ? 0 : worst.datasets)
  const startedAt = Date.now()
  const weightsOn = config.weights.enabled && config.weights.per_day > 0
  const datasetsOn = config.datasets.enabled && config.datasets.per_day > 0

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
  // A public dataset: the lab's fetcher on Modal checks and downloads it. The
  // plan holds a request only while public datasets are on. A GPU job below
  // that names the same repository waits for this, like weights.
  let fetchedData: Promise<DatasetFetchResult | null> = Promise.resolve(null)
  if (plan.datasets && !done(DATASETS_TOOL)) {
    const request = plan.datasets
    const summary = `public dataset ${request.repo}${request.revision === 'main' ? '' : ` at ${request.revision}`}`
    fetchedData = (async () => {
      const ok = await allowed(DATASETS_TOOL, config, worstCase())
      if (!ok.ok) {
        settled.add('datasets')
        out.push(await skip(ctx, DATASETS_TOOL, summary, ok.reason))
        return null
      }
      const result = await runDatasetFetch(request)
      await ledger(ctx, DATASETS_TOOL, result.cost_usd)
      settled.add('datasets')
      const status: ToolRunStatus = result.status === 'ok' ? 'ok' : result.status === 'refused' ? 'failed' : result.status === 'pending' ? 'timeout' : 'error'
      const line = describeDatasetFetch(result)
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: DATASETS_TOOL,
        requestSummary: summary, status, durationMs: result.wall_seconds === null ? null : result.wall_seconds * 1000,
        costUsd: result.cost_usd, outputTail: line,
        detail: {
          repo: result.repo, revision: request.revision, sha: result.sha, license: result.license, size_bytes: result.size_bytes,
          files: result.files, rows: result.rows, data_files: result.data_files, skipped_files: result.skipped_files,
          cached: result.cached, evicted: result.evicted, rule: result.rule ?? null,
          fetched_by: 'the lab\'s own fetcher, without a Hugging Face token; only data files, never code',
        },
      })
      out.push({ tool: DATASETS_TOOL, status, summary: `${name(ctx.executorModelId)} asked for a public dataset: ${line}` })
      return result
    })().catch(e => {
      console.warn(`[Epoch ${ctx.epochNumber}] side tool failed (non-fatal):`, e instanceof Error ? e.message : e)
      settled.add('datasets')
      return null
    })
    tasks.push(fetchedData.then(() => undefined))
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
    // The same for a dataset asked for in this same answer. A job carries a
    // dataset only while public datasets are on.
    const waitsForData = Boolean(job.dataset && plan.datasets && !done(DATASETS_TOOL) && job.dataset.repo === plan.datasets.repo)
    tasks.push((async () => {
      let weights = job.weights
      let dataset = job.dataset
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
      if (waitsForData && dataset) {
        // The same rules as for weights above: the job gets exactly the
        // commit that was just checked, it is not started when that fetch
        // did not end with the dataset on the shelf, and the fetch and the
        // job share the one wait a job always had.
        const fetch = await fetchedData
        if (fetch) {
          if (fetch.status !== 'ok' || !fetch.sha) {
            return void out.push(await skip(ctx, 'gpu_job', summary, `the dataset it names (${dataset.repo}) is not on the shelf: ${describeDatasetFetch(fetch)}`))
          }
          if (!dataset.sha) dataset = { repo: dataset.repo, sha: fetch.sha }
          const waitedMs = Date.now() - startedAt
          const left = gpuWaitAfterFetch(gpuJobWaitMs(), waitedMs)
          if (left === null) {
            return void out.push(await skip(ctx, 'gpu_job', summary, `its dataset (${dataset.repo}) took ${Math.round(waitedMs / 1000)} s to arrive, which leaves too little of this epoch's wait for a job; it is on the shelf now`))
          }
          maxWaitMs = left
        }
      }
      const ok = await allowed('gpu_job', config, worstCase())
      if (!ok.ok) return void out.push(await skip(ctx, 'gpu_job', summary, ok.reason))
      const result = await runGpuJob(job.script, { ...(weights ? { weights } : {}), ...(dataset ? { dataset } : {}), ...(maxWaitMs !== undefined ? { maxWaitMs } : {}) })
      await ledger(ctx, 'gpu_job', result.cost_usd)
      // While public weights are on, every job is labelled from what its
      // sandbox really had mounted. A job whose script never ran (nothing
      // started, or the sandbox could not read its weights) gets no label.
      const started = result.gpu !== null && result.stage !== 'weights' && result.stage !== 'mount' && result.stage !== 'dataset'
      const label = weightsOn && started ? weightsLabel(result.weights) : null
      // A job whose sandbox had a public dataset mounted is labelled with that
      // repository and commit, again from what the controller mounted. Only a
      // job that named one can have one, so nothing is added to any other job.
      const mountedData = datasetsOn && started && dataset && result.dataset ? result.dataset : null
      const dataLabel = mountedData ? datasetLabel(mountedData) : null
      const labels = [label, dataLabel].filter((l): l is string => Boolean(l))
      const shortLabels = [label ? weightsLabel(result.weights, true) : null, mountedData ? datasetLabel(mountedData, true) : null].filter((l): l is string => Boolean(l))
      const status: ToolRunStatus = result.status === 'ok' ? 'ok' : result.status === 'timeout' ? 'timeout' : result.status === 'error' ? 'failed' : 'error'
      await recordToolRun({
        experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: 'gpu_job',
        requestSummary: shortLabels.length ? `${shortLabels.join(', ')}: ${summary}` : summary, status, exitCode: result.exit_code,
        durationMs: result.wall_seconds === null ? null : result.wall_seconds * 1000, costUsd: result.cost_usd,
        outputTail: [result.log_tail, result.error ? `error: ${result.error}` : ''].filter(Boolean).join('\n'),
        detail: {
          gpu: result.gpu, stage: result.stage ?? null, run_seconds: result.run_seconds, script_chars: job.script.length,
          ...(label ? { label, weights: result.weights, output: 'self-reported, unverified' } : {}),
          ...(datasetsOn && dataset ? {
            dataset: mountedData, dataset_asked: dataset.repo,
            ...(dataLabel ? { dataset_label: dataLabel } : {}),
            output: 'self-reported, unverified',
          } : {}),
        },
      })
      out.push({ tool: 'gpu_job', status, summary: `${name(ctx.executorModelId)}'s GPU job${labels.length ? ` (${labels.join(', ')})` : ''}: ${result.status}${result.stage ? ` at stage ${result.stage}` : ''}${result.exit_code !== null ? `, exit ${result.exit_code}` : ''}` })
    })())
  }

  await Promise.all(tasks.map(t => t.catch(e => console.warn(`[Epoch ${ctx.epochNumber}] side tool failed (non-fatal):`, e instanceof Error ? e.message : e))))
  return out
}

export type ToolVerdicts = Partial<Record<'exhibit' | 'lab_proposal' | 'tinker_train' | 'keep_adapter', 'approve' | 'reject'>>

/** The Reviewer's verdicts on tool deliverables; anything but an explicit "approve" is a no. */
export function readToolVerdicts(reviewerOutput: unknown): ToolVerdicts {
  const raw = reviewerOutput && typeof reviewerOutput === 'object' ? (reviewerOutput as Record<string, unknown>).tool_verdicts : undefined
  const out: ToolVerdicts = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of ['exhibit', 'lab_proposal', 'tinker_train', 'keep_adapter'] as const) {
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
  // epoch's one row in tinker_runs is what stops a second run, and the
  // runs-per-day limit is counted from tinker_runs for the same reason.
  if (plan.tinker_train && !done(TINKER_TOOL)) {
    const request = plan.tinker_train
    const summary = tinkerRequestSummary(request.base_model, request.examples.length, request.purpose)
    tasks.push((async () => {
      if (verdicts.tinker_train !== 'approve') return void out.push(await skip(ctx, TINKER_TOOL, summary, 'the Reviewer did not approve it'))
      const ok = await allowed(TINKER_TOOL, config, tinkerWorstCaseUsd(request), () => tinkerRunsToday())
      if (!ok.ok) return void out.push(await skip(ctx, TINKER_TOOL, summary, ok.reason))
      const outcome = await runTinkerTrain(ctx, request)
      if (outcome.status === 'skipped') return void out.push(await skip(ctx, TINKER_TOOL, summary, outcome.summary))
      out.push(outcome)
    })())
  }

  // A Tinker training run on rows of a shelf dataset (datasets.ts). The plan
  // holds one only while public datasets are on, and never beside an inline
  // request. The Reviewer must have approved it. Then the lab's reader reads
  // the rows, and from there it is the run above: the same request shape,
  // checked by the same code, and the budget checked against the estimate
  // made from the rows that were really read.
  if (plan.tinker_train_dataset && !done(TINKER_TOOL)) {
    const asked = plan.tinker_train_dataset
    const summary = datasetRequestSummary(asked)
    tasks.push((async () => {
      if (verdicts.tinker_train !== 'approve') return void out.push(await skip(ctx, TINKER_TOOL, summary, 'the Reviewer did not approve it'))
      // Before the read: the runs-per-day limit, and today's budget against
      // the most the caps would let this run cost plus the read itself.
      const first = await allowed(TINKER_TOOL, config, datasetRunCeiling(asked).max_cost_usd + estimateDatasetReadCost(null), () => tinkerRunsToday())
      if (!first.ok) return void out.push(await skip(ctx, TINKER_TOOL, summary, first.reason))
      // The read and the run share the one wait a training run always had, so
      // the pair holds the follow-up no longer than a run alone did. A run
      // still training when the wait ends is collected by a later tick, as ever.
      const startedAt = Date.now()
      const wait = tinkerWaitMs()
      const resolved = await readDatasetForRun(ctx, asked, Math.min(datasetsReadWaitMs(), wait))
      if ('reason' in resolved) return void out.push(await skip(ctx, TINKER_TOOL, summary, resolved.reason))
      const ok = await allowed(TINKER_TOOL, config, tinkerWorstCaseUsd(resolved.request), () => tinkerRunsToday())
      if (!ok.ok) return void out.push(await skip(ctx, TINKER_TOOL, summary, ok.reason))
      const outcome = await runTinkerTrain(ctx, resolved.request, { dataset: resolved.record, maxWaitMs: Math.max(0, wait - (Date.now() - startedAt)) })
      if (outcome.status === 'skipped') return void out.push(await skip(ctx, TINKER_TOOL, summary, outcome.summary))
      out.push(outcome)
    })())
  }

  // Keeping a trained adapter (tinker-keep.ts). The plan holds a request
  // only while keeping is on. The Reviewer must have approved it; then the
  // requests-per-day limit is checked here, and the number of adapters that
  // may be kept, and the one keep an epoch may ask for, are held by the
  // database when the place is taken. Keeping uses no Tinker tokens, so its
  // worst case is nothing. A keep still going when the wait ends writes its
  // record when a later tick collects it (collectTinkerKeeps), so the limit
  // counts those as well.
  if (plan.keep_adapter && !done(KEEP_TOOL)) {
    const request = plan.keep_adapter
    const summary = `keep adapter lab/${request.slug}: ${request.reason}`
    tasks.push((async () => {
      if (verdicts.keep_adapter !== 'approve') return void out.push(await skip(ctx, KEEP_TOOL, summary, 'the Reviewer did not approve it'))
      const ok = await allowed(KEEP_TOOL, config, 0, async () => (await toolRunsToday(KEEP_TOOL)) + (await pendingModelKeepsToday()))
      if (!ok.ok) return void out.push(await skip(ctx, KEEP_TOOL, summary, ok.reason))
      const outcome = await keepAdapter(request, { by: 'model', modelId: ctx.executorModelId, experimentId: ctx.experimentId, epoch: ctx.epochNumber })
      if (outcome.status === 'skipped') return void out.push(await skip(ctx, KEEP_TOOL, summary, outcome.summary))
      out.push(outcome)
    })())
  }

  await Promise.all(tasks.map(t => t.catch(e => console.warn(`[Epoch ${ctx.epochNumber}] tool deliverable failed (non-fatal):`, e instanceof Error ? e.message : e))))
  return out
}

/**
 * Reads the rows a dataset training request names, through the lab's reader
 * on Modal, and turns them into the request an inline dataset makes. The
 * read is stored as its own tool run (what was read, how many rows were used
 * and left out, and what the read cost), whatever comes of the run. A
 * `reason` means there is no run: the caller stores it against the request.
 */
async function readDatasetForRun(ctx: EpochToolContext, asked: TinkerDatasetRequest, maxWaitMs: number):
  Promise<{ request: TinkerRequest; record: TinkerDatasetRecord } | { reason: string }> {
  const d = asked.dataset
  const rows = await readDatasetRows(d, { maxWaitMs })
  await ledger(ctx, DATASET_ROWS_TOOL, rows.cost_usd)
  const made = tinkerRequestFromRows(asked, rows)
  const line = 'error' in made ? made.error : describeRows(rows)
  const status: ToolRunStatus = 'error' in made
    ? (rows.status === 'pending' ? 'timeout' : rows.status === 'ok' || rows.status === 'refused' ? 'failed' : 'error')
    : 'ok'
  await recordToolRun({
    experimentId: ctx.experimentId, epoch: ctx.epochNumber, model: ctx.executorModelId, tool: DATASET_ROWS_TOOL,
    requestSummary: `rows of ${d.repo}${d.sha ? `@${d.sha.slice(0, 12)}` : ''}${d.file ? ` (${d.file})` : ''} for a Tinker training run`,
    status, durationMs: rows.wall_seconds === null ? null : rows.wall_seconds * 1000, costUsd: rows.cost_usd, outputTail: line,
    detail: {
      repo: rows.repo, sha: rows.sha, license: rows.license, file: rows.file,
      user_column: d.user_column, assistant_column: d.assistant_column, system: d.system !== undefined, limit: d.limit,
      rows_scanned: rows.rows_scanned, rows_used: rows.rows_used, skipped: rows.skipped, stopped: rows.stopped,
      ...('error' in made ? {} : { dataset_sha256: made.request.dataset_sha256, bytes: made.request.dataset_bytes }),
      read_by: 'the lab\'s own reader, with no network and no credentials; the first rows that fit, in file order',
      rule: rows.rule ?? null,
    },
  })
  if ('error' in made) return { reason: made.error }
  return made
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
