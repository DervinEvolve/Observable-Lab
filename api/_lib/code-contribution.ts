/**
 * Turns an abstract spec mutation / North-GLM hypothesis into a real code change
 * on the AI-Agent repo: an LLM writes the files, we push them to a branch, open
 * a PR, and either merge it (approved) or close it (rejected) — same
 * approve/reject semantics as the spec-mutation pipeline, just landing as
 * actual commits instead of JSON.
 */
import { callModel, type WebCitation } from './openrouter.js'
import {
  bootstrapRepoIfEmpty,
  createBranch,
  upsertFileOnBranch,
  deleteFileOnBranch,
  openPullRequest,
  mergePullRequest,
  closePullRequest,
  listRepoTree,
  getBranchHeadSha,
  waitForCIRun,
  getCIFailureExcerpt,
  type RepoFile,
} from './github-repo.js'
import { withModelTrailers } from './commit-identity.js'
import { MODEL_DISPLAY_NAMES, WILDCARD_MODELS, WILDCARD_DISPLAY_NAMES } from './types.js'
import { assertContributionPath } from './contribution-policy.js'

const CODER_SYSTEM = `You are a software engineer with real, secure write access to a shared GitHub repository (AI-Agent) through a sandboxed execution environment (Sprites). This is NOT a simulation or writing exercise: the files you return are pushed as a real commit that names you as the model that wrote it, opened as a real pull request, and — once approved — merged into the actual codebase this agent runs on. Other engineers (other models, and their own subagents) are contributing to this same repo alongside you, epoch after epoch, so treat existing files as real prior work to build on, not placeholders you can ignore.

Only write files under src/, test/, tests/, or docs/, or README.md. Never change workflows, package manifests, dependency hooks, or build configuration.

You must really build. Write working, real implementation code for the capability you're given — not a mock, not a stub, not a "// TODO: replace with real logic" comment, not a fake in-memory simulation standing in for the real thing. If the task genuinely requires an external dependency you can't provide here (a live network call, a real API key), implement everything else for real and isolate only that one unavoidable boundary — don't fake the whole feature because one piece is hard.

YOUR PR RUNS REAL CI. GitHub Actions executes the ENTIRE vitest suite (every existing test file in the repo, plus yours) and your PR only merges if it all passes. Consequences:
- Write vitest-style tests (jest-style describe/it/expect globals are configured). Do NOT use node:test.
- Only import things that actually exist — check the repo file list; don't invent modules, exports, or error-message wording. A test asserting an API that isn't there fails CI and kills your PR.
- Don't break existing files: if you change a module's exports, everything that imports it still has to pass.
- If a pre-existing file is genuinely broken and blocking the suite, you may remove it by listing it in "files_to_delete".

Keep the change small, self-contained, and additive — prefer adding new files over editing ones you haven't seen. Return ONLY valid JSON: { "files": [{ "path": string, "content": string }], "files_to_delete": string[], "commit_message": string, "pr_summary": string }. commit_message should be a short conventional-commit-style line. pr_summary is 1-2 sentences for a human reviewer.`

const SUBAGENT_SYSTEM = `You are a subagent with the same real write access to the shared AI-Agent repo, deployed by your parent model for one focused follow-up task: add a real, meaningful test that exercises the actual logic your parent just wrote — not a trivial no-op, not a test that only checks a mock returns what you told it to return. Your test RUNS in real CI (vitest, jest-style globals — do NOT use node:test) and the PR dies if it fails, so: only import exports that actually exist in the files you were shown, get the arithmetic in your expectations right, and never assert exact error-message wording you haven't seen. Don't touch the original files. Return ONLY valid JSON: { "files": [{ "path": string, "content": string }], "commit_message": string }. If the code genuinely isn't testable, return { "files": [], "commit_message": "" }.`

const EXPLORER_SYSTEM = `You are a subagent deployed by your parent model to explore and research BEFORE any code gets written — you don't write code yourself. You have REAL web access: search the web for relevant docs, standards, prior art, or best practices, and ground your findings in what you actually find (not just prior knowledge). Also look for relevant existing code or patterns in the repo to build on, weigh 1-2 implementation approaches and their real tradeoffs, and flag any concrete edge case or risk. Be specific and concise (3-5 sentences) — your parent will use this to decide what to build, so vague hedging is useless. Return ONLY valid JSON: { "task": string, "search_queries": string[], "findings": string }. "task" is a short (under 8 words) present-tense description of what you're investigating, e.g. "Researching integer overflow handling". "search_queries" is the 1-3 web searches you actually made.`

interface CoderOutput {
  files: RepoFile[]
  files_to_delete?: string[]
  commit_message: string
  pr_summary: string
}

interface SubagentOutput {
  files: RepoFile[]
  commit_message: string
}

interface ExplorerOutput {
  task: string
  findings: string
  search_queries?: string[]
}

export interface ContributionResult {
  merged: boolean
  pr_url?: string
  files: RepoFile[]           // author's files, with content — for streaming into terminals
  subagent_files: RepoFile[]  // subagent's files, with content
  author: string              // display name of the model credited in the commits' Model trailer
  cost: number
  explorer_task?: string      // what the explorer subagent said it was investigating (shown live on its drone)
  explorer_findings?: string  // what it found — fed into the coder's prompt
  web_searches?: string[]     // the web searches the explorer actually made (streamed into the terminal)
  web_sources?: WebCitation[] // the real pages it cited (streamed into the terminal)
  ci_passed?: boolean | null  // real CI verdict for this PR (null = no run / timed out; blocks merging)
  ci_excerpt?: string         // failed-run log tail — fed back to the lab so models learn from it
}

// Resolves any OpenRouter model id (panel model or wildcard) to the display
// name credited in each commit's Model trailer. The git author and committer
// are always the lab identity (commit-identity.ts), never a per-model address.
function modelCredit(modelId: string): string {
  const panelName = (MODEL_DISPLAY_NAMES as Record<string, string>)[modelId]
  if (panelName) return panelName
  const wildcardKey = (Object.entries(WILDCARD_MODELS) as [string, string][]).find(([, v]) => v === modelId)?.[0]
  if (wildcardKey) return WILDCARD_DISPLAY_NAMES[wildcardKey as keyof typeof WILDCARD_DISPLAY_NAMES]
  return modelId.split('/').pop() || modelId
}

async function generateSubagentContribution(
  authorModelId: string,
  description: string,
  mainFiles: RepoFile[]
): Promise<{ files: RepoFile[]; commit_message: string; cost: number; model: string }> {
  const { output, cost, servedBy } = await callModel(
    authorModelId,
    SUBAGENT_SYSTEM,
    `Parent task: ${description}\n\nFiles just written:\n${mainFiles
      .map(f => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`)
      .join('\n\n')}`,
    { maxTokens: 16000 } // real test files can be long — never truncate the JSON
  )
  const subagentOut = output as SubagentOutput
  return { files: subagentOut.files || [], commit_message: subagentOut.commit_message || '', cost, model: servedBy.model }
}

async function runExplorerSubagent(
  authorModelId: string,
  description: string,
  tree: string[]
): Promise<{ task: string; findings: string; searches: string[]; sources: WebCitation[]; cost: number }> {
  const { output, cost, citations } = await callModel(
    authorModelId,
    EXPLORER_SYSTEM,
    `Task to investigate: ${description}\n\nCurrent repo files (top-level):\n${tree.length ? tree.join('\n') : '(empty repo)'}`,
    { webSearch: true }
  )
  const explorerOut = output as ExplorerOutput
  return {
    task: explorerOut.task || 'Exploring the problem',
    findings: explorerOut.findings || '',
    searches: Array.isArray(explorerOut.search_queries) ? explorerOut.search_queries.slice(0, 3) : [],
    sources: citations,
    cost,
  }
}

export type ReviewDecision =
  | { mode: 'approved' } // caller already knows this should merge (e.g. main panel's Reviewer already approved the mutation)
  | { mode: 'rejected' } // caller already knows this should NOT merge
  | { mode: 'auto-review'; reviewerModelId: string } // ask a model to judge this specific contribution

async function autoReview(reviewerModelId: string, description: string, coder: CoderOutput): Promise<{ approve: boolean; cost: number }> {
  const { output, cost } = await callModel(
    reviewerModelId,
    'You are reviewing one real code contribution to a shared repo before it merges to main. Reject if it is clearly broken, unsafe, off-task, or is just a mock/stub/placeholder pretending to implement something real (e.g. hardcoded fake responses where real logic was asked for). Be pragmatic otherwise — this is one small incremental change, not a finished product. Return ONLY JSON: { "verdict": "approve" | "reject", "reason": string }',
    `Task: ${description}\n\nProposed commit: ${coder.commit_message}\nSummary: ${coder.pr_summary}\n\nFiles:\n${coder.files
      .map(f => `--- ${f.path} ---\n${f.content.slice(0, 1500)}`)
      .join('\n\n')}`
  )
  const verdict = (output as { verdict?: string })?.verdict
  return { approve: verdict === 'approve', cost }
}

/**
 * Generate real code for `description` (authored by `authorModelId`), push it to
 * a fresh branch, open a PR, and resolve it per `review`. Never throws for
 * repo/API failures — callers treat code contribution as best-effort so it can
 * never break the abstract spec-mutation pipeline it's attached to.
 */
export async function contributeCode(params: {
  authorModelId: string
  branchName: string
  title: string
  description: string
  review: ReviewDecision
  deploySubagent?: boolean // if true, a subagent (same model) adds a test file for the change before it's reviewed
  deployExplorerSubagent?: boolean // if true, a subagent researches the problem BEFORE any code is written, and its findings inform the coder
  agentContext?: string // what the agent being built actually is (purpose/domain) — grounds the code in the real product, not a generic toy
}): Promise<ContributionResult> {
  let cost = 0
  let author = modelCredit(params.authorModelId)
  let authorModelId = params.authorModelId
  let explorerTask: string | undefined
  let explorerFindings: string | undefined
  let webSearches: string[] = []
  let webSources: WebCitation[] = []
  if (process.env.LAB_ENABLE_CODE_WRITES !== 'true') {
    return { merged: false, files: [], subagent_files: [], author, cost }
  }
  try {
    await bootstrapRepoIfEmpty()
    const tree = await listRepoTree()

    // Explore first: a subagent investigates the problem/repo before any code
    // gets written, and its findings actually shape the coder's prompt below
    // — real exploration (including real web search), not just a fixed
    // after-the-fact test-writing chore.
    if (params.deployExplorerSubagent) {
      try {
        const explorer = await runExplorerSubagent(params.authorModelId, params.description, tree)
        cost += explorer.cost
        explorerTask = explorer.task
        explorerFindings = explorer.findings
        webSearches = explorer.searches
        webSources = explorer.sources
      } catch (e) {
        console.warn('[code-contribution] explorer pass failed (non-fatal):', e instanceof Error ? e.message : e)
      }
    }

    const { output, cost: codeCost, servedBy: coderServedBy } = await callModel(
      params.authorModelId,
      CODER_SYSTEM,
      `${params.agentContext ? `You're building: ${params.agentContext}\n\n` : ''}${
        explorerFindings ? `A subagent explored this first and found: ${explorerFindings}\n\n` : ''
      }Implement this: ${params.description}\n\nCurrent repo files (top-level, for context — don't collide):\n${tree.length ? tree.join('\n') : '(empty repo)'}`,
      { maxTokens: 16000 } // a real implementation file mustn't be truncated mid-JSON
    )
    cost += codeCost
    const coder = output as CoderOutput
    // If a fallback model wrote the code, the commits name it instead.
    if (coderServedBy.fallback) {
      author = modelCredit(coderServedBy.model)
      authorModelId = coderServedBy.model
    }
    const coderModel = {
      name: author,
      id: authorModelId,
      fallbackFor: coderServedBy.fallback ? modelCredit(params.authorModelId) : undefined,
    }
    const coderMessage = withModelTrailers(coder.commit_message || params.title, coderModel)

    if (!coder.files?.length) {
      return { merged: false, files: [], subagent_files: [], author, cost, explorer_task: explorerTask, explorer_findings: explorerFindings, web_searches: webSearches, web_sources: webSources }
    }

    // Validate the whole generated batch before the first repository write.
    if (!Array.isArray(coder.files) || (coder.files_to_delete !== undefined && !Array.isArray(coder.files_to_delete))) {
      throw new Error('Generated contribution has a malformed file list')
    }
    for (const file of coder.files) {
      assertContributionPath(file?.path)
      if (typeof file.content !== 'string') throw new Error('Generated contribution file content is not text')
    }
    for (const path of coder.files_to_delete || []) assertContributionPath(path)
    await createBranch(params.branchName)
    for (const file of coder.files) {
      await upsertFileOnBranch(params.branchName, file.path, file.content, coderMessage)
    }
    // The coder may remove pre-existing files that are genuinely broken and
    // would block the suite (never its own harness/config).
    for (const path of (coder.files_to_delete || []).slice(0, 4)) {
      try {
        await deleteFileOnBranch(params.branchName, path, withModelTrailers(`${coder.commit_message || params.title} (remove broken file)`, coderModel))
      } catch (e) {
        console.warn(`[code-contribution] delete ${path} failed (non-fatal):`, e instanceof Error ? e.message : e)
      }
    }

    // Subagent follow-up: writes tests for what the parent just implemented,
    // landing on the same branch as its own commit, whose Model-Role trailer
    // marks it as the subagent's so it's distinguishable in git history.
    let subagentFiles: RepoFile[] = []
    if (params.deploySubagent) {
      try {
        const subagent = await generateSubagentContribution(params.authorModelId, params.description, coder.files)
        cost += subagent.cost
        const proposed = Array.isArray(subagent.files) ? subagent.files : []
        for (const file of proposed) {
          assertContributionPath(file?.path)
          if (typeof file.content !== 'string') throw new Error('Subagent file content is not text')
        }
        subagentFiles = proposed
        // subagent.model is the fallback model, if one answered.
        const subagentMessage = withModelTrailers(subagent.commit_message || `test: cover ${params.title}`, {
          name: modelCredit(subagent.model),
          id: subagent.model,
          role: 'subagent',
          fallbackFor: subagent.model !== params.authorModelId ? modelCredit(params.authorModelId) : undefined,
        })
        for (const file of subagentFiles) {
          await upsertFileOnBranch(params.branchName, file.path, file.content, subagentMessage)
        }
      } catch (e) {
        console.warn('[code-contribution] subagent pass failed (non-fatal):', e instanceof Error ? e.message : e)
      }
    }

    const pr = await openPullRequest(params.branchName, params.title, `${coder.pr_summary}\n\n_Opened automatically by the Observable Lab._`)

    const base = {
      pr_url: pr.html_url, files: coder.files, subagent_files: subagentFiles, author,
      explorer_task: explorerTask, explorer_findings: explorerFindings,
      web_searches: webSearches, web_sources: webSources,
    }

    // REAL CI GATE: the PR triggered the repo's GitHub Actions run (full vitest
    // suite). A red run kills the PR regardless of what the reviewer thinks,
    // and the failure log flows back to the lab. Timeout/no-run isn't held
    // against the contribution (infra flakiness ≠ bad code).
    let ciPassed: boolean | null = null
    let headSha: string | null = null
    let ciExcerpt = ''
    try {
      headSha = await getBranchHeadSha(params.branchName)
      if (headSha) {
        const ci = await waitForCIRun(headSha)
        if (ci.conclusion === 'success') ciPassed = true
        else if (ci.conclusion === 'failure') {
          ciPassed = false
          ciExcerpt = ci.runId ? await getCIFailureExcerpt(ci.runId) : ''
        }
      }
    } catch (e) {
      console.warn('[code-contribution] CI check failed (merge blocked):', e instanceof Error ? e.message : e)
    }

    if (ciPassed !== true || !headSha) {
      await closePullRequest(pr.number, params.branchName).catch(() => {})
      console.log(`[code-contribution] PR has no successful CI result, closed: ${pr.html_url}`)
      return { merged: false, ...base, cost, ci_passed: ciPassed, ci_excerpt: ciExcerpt }
    }

    // From here on, ANY failure must still resolve the PR (never leave it
    // dangling open) — confirmed live: an autoReview failure left a real PR
    // open with no merge or close, because the outer catch below swallowed
    // it without ever calling closePullRequest.
    let shouldMerge = false
    try {
      if (params.review.mode === 'approved') {
        shouldMerge = true
      } else if (params.review.mode === 'rejected') {
        shouldMerge = false
      } else {
        const review = await autoReview(params.review.reviewerModelId, params.description, coder)
        cost += review.cost
        shouldMerge = review.approve
      }
    } catch (e) {
      console.warn('[code-contribution] review failed, defaulting to close:', e instanceof Error ? e.message : e)
      shouldMerge = false
    }

    try {
      if (shouldMerge) {
        await mergePullRequest(pr.number, coder.commit_message || params.title, headSha)
        return { merged: true, ...base, cost, ci_passed: ciPassed }
      } else {
        await closePullRequest(pr.number, params.branchName)
        return { merged: false, ...base, cost, ci_passed: ciPassed }
      }
    } catch (e) {
      // Merge itself failed (e.g. conflict) — fall back to closing so nothing dangles.
      console.warn('[code-contribution] merge failed, closing as fallback:', e instanceof Error ? e.message : e)
      await closePullRequest(pr.number, params.branchName).catch(() => {})
      return { merged: false, ...base, cost, ci_passed: ciPassed }
    }
  } catch (error) {
    console.warn('[code-contribution] failed (non-fatal):', error instanceof Error ? error.message : error)
    return { merged: false, files: [], subagent_files: [], author, cost, explorer_task: explorerTask, explorer_findings: explorerFindings, web_searches: webSearches, web_sources: webSources }
  }
}

