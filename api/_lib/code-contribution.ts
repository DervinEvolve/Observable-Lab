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
import { checkContributionInSprite, spritesConfigured, type SpriteCheck } from './sprites.js'
import { liveModelToolStatus } from './tools-config.js'
import { liveModelNote } from './live-model.js'
import { quietMentions } from './github-pr.js'

const CODER_SYSTEM = `You are a software engineer with real write access to a shared GitHub repository (AI-Agent). This is NOT a simulation or writing exercise: the files you return are pushed as a real commit that names you as the model that wrote it, opened as a real pull request, and — once approved — merged into the actual codebase this agent runs on. Other engineers (other models, and their own subagents) are contributing to this same repo alongside you, epoch after epoch, so treat existing files as real prior work to build on, not placeholders you can ignore.

Only write files under src/, test/, tests/, or docs/, or README.md. Never change workflows, package manifests, dependency hooks, or build configuration.

You must really build. Write working, real implementation code for the capability you're given — not a mock, not a stub, not a "// TODO: replace with real logic" comment, not a fake in-memory simulation standing in for the real thing. If the task genuinely requires an external dependency you can't provide here (a live network call, a real API key), implement everything else for real and isolate only that one unavoidable boundary — don't fake the whole feature because one piece is hard.

YOUR PR RUNS REAL CI. GitHub Actions executes the ENTIRE vitest suite (every existing test file in the repo, plus yours) and your PR only merges if it all passes. Consequences:
- Write vitest-style tests (jest-style describe/it/expect globals are configured). Do NOT use node:test.
- Only import things that actually exist — check the repo file list; don't invent modules, exports, or error-message wording. A test asserting an API that isn't there fails CI and kills your PR.
- Don't break existing files: if you change a module's exports, everything that imports it still has to pass.
- If a pre-existing file is genuinely broken and blocking the suite, you may remove it by listing it in "files_to_delete".

Keep the change small, self-contained, and additive — prefer adding new files over editing ones you haven't seen. Return ONLY valid JSON: { "files": [{ "path": string, "content": string }], "files_to_delete": string[], "commit_message": string, "pr_summary": string }. commit_message should be a short conventional-commit-style line. pr_summary is 1-2 sentences for a human reviewer.`

// Only said when the sandboxes are configured, so the prompt stays true.
const SPRITE_NOTE = `\n\nAfter you push, your own Sprites sandbox checks out your branch at the exact commit and runs \`npm test\` (vitest run). Its output is shown to people watching the lab, next to the CI result.`

const SUBAGENT_SYSTEM = `You are a subagent with the same real write access to the shared AI-Agent repo, deployed by your parent model for one focused follow-up task: add a real, meaningful test that exercises the actual logic your parent just wrote — not a trivial no-op, not a test that only checks a mock returns what you told it to return. Your test RUNS in real CI (vitest, jest-style globals — do NOT use node:test) and the PR dies if it fails, so: only import exports that actually exist in the files you were shown, get the arithmetic in your expectations right, and never assert exact error-message wording you haven't seen. Don't touch the original files. Return ONLY valid JSON: { "files": [{ "path": string, "content": string }], "commit_message": string }. If the code genuinely isn't testable, return { "files": [], "commit_message": "" }.`

const EXPLORER_SYSTEM = `You are a subagent deployed by your parent model to explore and research BEFORE any code gets written — you don't write code yourself. You have REAL web access: search the web for relevant docs, standards, prior art, or best practices, and ground your findings in what you actually find (not just prior knowledge). Also look for relevant existing code or patterns in the repo to build on, weigh 1-2 implementation approaches and their real tradeoffs, and flag any concrete edge case or risk. Be specific and concise (3-5 sentences) — your parent will use this to decide what to build, so vague hedging is useless. Your task, search queries and findings are published in the pull request description of the contribution they inform. Return ONLY valid JSON: { "task": string, "search_queries": string[], "findings": string }. "task" is a short (under 8 words) present-tense description of what you're investigating, e.g. "Researching integer overflow handling". "search_queries" is the 1-3 web searches you actually made.`

// When the parent deploys two explorers, each takes one angle so they do not repeat each other.
const EXPLORER_ANGLES = [
  'Focus on the implementation: existing code in the repo to build on, and the best approach with its tradeoffs.',
  'Focus on what can go wrong: prior art, standards, failure modes and edge cases the code must handle.',
]

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

/** One explorer's report, kept for the pull request description and the record. */
export interface ExplorerReport {
  task: string
  findings: string
  searches: string[]
  sources: WebCitation[]
  model: string
  cost: number
}

/** One subagent deployment, for the tool_runs record and the drones in the room. */
export interface SubagentRun {
  kind: 'explore' | 'test'
  model: string
  ok: boolean
  cost: number
  task?: string
  files?: string[]
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
  sprite?: SpriteCheck        // the author's sprite ran the tests on this branch (extra evidence, not a merge gate)
  subagents?: SubagentRun[]   // every subagent deployed for this contribution, including failed ones
  pending?: PendingContribution // set with deferResolution: the PR is open and waits for resolveContribution
  error?: string              // why nothing reached a pull request, when it did not
}

/**
 * An open pull request whose CI result is read later (resolveContribution),
 * so writing the code and waiting for CI don't have to share one function
 * time limit. Plain data, stored on the epoch row between ticks.
 */
export interface PendingContribution {
  pr_number: number
  pr_url: string
  head_sha: string
  branch: string
  author_model_id: string   // the model that wrote the code (the fallback, if one answered)
  merge_message: string
  approved: boolean         // the Reviewer approved the mutation; CI still decides
  opened_at: string
}

// Resolves any OpenRouter model id (panel model or wildcard) to the display
// name credited in each commit's Model trailer. commit-identity.ts makes the
// model in that trailer the git author (on observable-lab.invalid); the
// committer is always the owner's noreply identity.
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
  mainFiles: RepoFile[],
  deadlineAt?: number
): Promise<{ files: RepoFile[]; commit_message: string; cost: number; model: string }> {
  const { output, cost, servedBy } = await callModel(
    authorModelId,
    SUBAGENT_SYSTEM,
    `Parent task: ${description}\n\nFiles just written:\n${mainFiles
      .map(f => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`)
      .join('\n\n')}`,
    { maxTokens: 24000, effort: 'low', deadlineAt } // real test files can be long — never truncate the JSON
  )
  const subagentOut = output as SubagentOutput
  return { files: subagentOut.files || [], commit_message: subagentOut.commit_message || '', cost, model: servedBy.model }
}

async function runExplorerSubagent(
  authorModelId: string,
  description: string,
  tree: string[],
  angle?: string,
  deadlineAt?: number
): Promise<ExplorerReport> {
  const { output, cost, citations, servedBy } = await callModel(
    authorModelId,
    EXPLORER_SYSTEM + (angle ? `\n\n${angle}` : ''),
    `Task to investigate: ${description}\n\nCurrent repo files (top-level):\n${tree.length ? tree.join('\n') : '(empty repo)'}`,
    { webSearch: true, deadlineAt }
  )
  const explorerOut = output as ExplorerOutput
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
  return {
    task: str(explorerOut.task, 120) || 'Exploring the problem',
    findings: str(explorerOut.findings, 3000),
    searches: Array.isArray(explorerOut.search_queries)
      ? explorerOut.search_queries.filter((q): q is string => typeof q === 'string').map(q => q.slice(0, 200)).slice(0, 3)
      : [],
    sources: citations,
    model: servedBy.model,
    cost,
  }
}

/**
 * The pull request description: the coder's summary, then what each explorer
 * subagent was asked, searched for and found, so the reasoning behind the
 * change is on GitHub next to the code.
 */
export function contributionPrBody(params: {
  summary: string
  author: string
  explorers: ExplorerReport[]
  testSubagent: boolean
}): string {
  const lines = [params.summary || '(no summary)', '']
  if (params.explorers.length) {
    lines.push(`## Explorer subagent${params.explorers.length > 1 ? 's' : ''}`, '')
    lines.push(`${params.author} deployed ${params.explorers.length === 1 ? 'an explorer subagent' : `${params.explorers.length} explorer subagents`} before writing this code. Their findings were given to the model that wrote it.`, '')
    params.explorers.forEach((e, i) => {
      if (params.explorers.length > 1) lines.push(`### Explorer ${i + 1}`, '')
      lines.push(`**Task:** ${e.task}`, '')
      lines.push('**Searches:**')
      if (e.searches.length) for (const q of e.searches) lines.push(`- ${q.replace(/\s+/g, ' ')}`)
      else lines.push('- (none reported)')
      lines.push('', '**Findings:**', '', e.findings ? e.findings.split('\n').map(l => `> ${l}`).join('\n') : '> (none)', '')
      const sources = e.sources.filter(s => typeof s.url === 'string' && /^https:\/\//.test(s.url)).slice(0, 5)
      if (sources.length) {
        lines.push('**Sources the search returned:**')
        for (const s of sources) lines.push(`- ${(s.title || s.url).replace(/[\[\]\n]/g, ' ').slice(0, 120)}: ${s.url}`)
        lines.push('')
      }
    })
    lines.push('The searches and findings are what the subagents reported. They are not checked by the lab.', '')
  }
  if (params.testSubagent) lines.push('A test subagent added its own commit with a test for this change.', '')
  lines.push('_Opened automatically by the Observable Lab._')
  return quietMentions(lines.join('\n'))
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
  /** The Executor's choice: 0..2 explorers before the code, and whether a test subagent follows. */
  subagents?: { explore: number; test: boolean }
  deploySubagent?: boolean // older callers: a test subagent (same model) adds a test file
  deployExplorerSubagent?: boolean // older callers: one explorer researches the problem before any code is written
  agentContext?: string // what the agent being built actually is (purpose/domain) — grounds the code in the real product, not a generic toy
  // Wall-clock time (ms since epoch) by which this request must be done with
  // model calls. The code-writing call gets up to 7 minutes within it, the
  // test subagent is skipped when too little is left.
  deadlineAt?: number
  // Stop once the PR is open and return it as `pending`; resolveContribution
  // reads CI and merges or closes later, in another request. Only for an
  // approved or rejected review (an auto-review needs the generated files).
  deferResolution?: boolean
}): Promise<ContributionResult> {
  let cost = 0
  let author = modelCredit(params.authorModelId)
  let authorModelId = params.authorModelId
  let explorerTask: string | undefined
  let explorerFindings: string | undefined
  let webSearches: string[] = []
  let webSources: WebCitation[] = []
  const explorers: ExplorerReport[] = []
  const subagentRuns: SubagentRun[] = []
  const exploreCount = Math.max(0, Math.min(EXPLORER_ANGLES.length,
    params.subagents ? Math.floor(params.subagents.explore) || 0 : params.deployExplorerSubagent ? 1 : 0))
  const deployTest = params.subagents ? params.subagents.test === true : Boolean(params.deploySubagent)
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
    // The Executor chose how many explorers to deploy (0 to 2); with two,
    // each takes its own angle and they run side by side.
    if (exploreCount > 0) {
      const settled = await Promise.allSettled(Array.from({ length: exploreCount }, (_, i) =>
        runExplorerSubagent(params.authorModelId, params.description, tree, exploreCount > 1 ? EXPLORER_ANGLES[i] : undefined,
          params.deadlineAt ? params.deadlineAt - 7.5 * 60_000 : undefined)))
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          cost += r.value.cost
          explorers.push(r.value)
          subagentRuns.push({ kind: 'explore', model: r.value.model, ok: true, cost: r.value.cost, task: r.value.task })
        } else {
          subagentRuns.push({ kind: 'explore', model: params.authorModelId, ok: false, cost: 0 })
          console.warn('[code-contribution] explorer pass failed (non-fatal):', r.reason instanceof Error ? r.reason.message : r.reason)
        }
      }
      if (explorers.length) {
        explorerTask = explorers.map(e => e.task).join(' / ').slice(0, 300)
        explorerFindings = explorers.map(e => e.findings).filter(Boolean).join('\n\n') || undefined
        webSearches = explorers.flatMap(e => e.searches).slice(0, 6)
        webSources = explorers.flatMap(e => e.sources).slice(0, 10)
      }
    }

    const { output, cost: codeCost, servedBy: coderServedBy } = await callModel(
      params.authorModelId,
      CODER_SYSTEM + (spritesConfigured() ? SPRITE_NOTE : '') + (liveModelToolStatus().enabled ? `\n\n${liveModelNote()}` : ''),
      `${params.agentContext ? `You're building: ${params.agentContext}\n\n` : ''}${
        explorerFindings ? `A subagent explored this first and found: ${explorerFindings}\n\n` : ''
      }Implement this: ${params.description}\n\nCurrent repo files (top-level, for context — don't collide):\n${tree.length ? tree.join('\n') : '(empty repo)'}`,
      // A real implementation file mustn't be truncated mid-JSON, and writing
      // one with reasoning on can take several minutes. A minute is kept back
      // for pushing the files and opening the PR.
      // Low reasoning effort and a large output budget: a whole file wrapped
      // in JSON is long, and reasoning shares max_tokens with it (at medium
      // effort and 32k tokens Claude Fable was cut off twice). Only what is
      // generated is billed.
      // Two minutes are kept back from the assigned model so a fallback can
      // still write the code when it times out, and only an answer with files
      // counts (anything else goes to the fallback instead of ending silently).
      {
        maxTokens: 48000, effort: 'low', timeoutMs: 420_000,
        deadlineAt: params.deadlineAt ? params.deadlineAt - 60_000 : undefined,
        fallbackReserveMs: params.deadlineAt ? 120_000 : undefined,
        accept: (p) => {
          const files = (p as { files?: unknown } | null)?.files
          return Array.isArray(files) && files.some(f => typeof f?.path === 'string' && typeof f?.content === 'string')
        },
      }
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
      const keys = coder && typeof coder === 'object' ? Object.keys(coder).slice(0, 8).join(', ') : typeof coder
      const reason = `the coder (${coderServedBy.model}) returned no files${keys ? ` (fields: ${keys})` : ''}`
      console.warn('[code-contribution] ' + reason)
      return { merged: false, files: [], subagent_files: [], author, cost, explorer_task: explorerTask, explorer_findings: explorerFindings, web_searches: webSearches, web_sources: webSources, subagents: subagentRuns, error: reason }
    }

    // Validate the generated batch before the first repository write. A file
    // outside the allowed paths is dropped on its own (and logged) rather
    // than throwing away every other file with it; nothing is written when
    // no allowed file is left.
    if (!Array.isArray(coder.files) || (coder.files_to_delete !== undefined && !Array.isArray(coder.files_to_delete))) {
      throw new Error('Generated contribution has a malformed file list')
    }
    const dropped: string[] = []
    const allowed = (path: unknown): path is string => {
      try {
        assertContributionPath(path)
        return true
      } catch (e) {
        dropped.push(`${String(path).slice(0, 120)} (${e instanceof Error ? e.message : 'not allowed'})`)
        return false
      }
    }
    const tidy = (path: unknown) => (typeof path === 'string' ? path.replace(/^(\.\/)+/, '') : path)
    coder.files = coder.files
      .map(f => ({ ...f, path: tidy(f?.path) as string }))
      .filter(f => allowed(f.path) && (typeof f.content === 'string' || (dropped.push(`${f.path} (content is not text)`), false)))
    coder.files_to_delete = (coder.files_to_delete || []).map(tidy).filter(allowed)
    if (dropped.length) console.warn(`[code-contribution] dropped ${dropped.length} generated path(s): ${dropped.join('; ')}`)
    if (!coder.files.length) throw new Error(`No allowed files to write: ${dropped.join('; ')}`.slice(0, 1500))
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
    const timeForTest = !params.deadlineAt || params.deadlineAt - Date.now() > 150_000
    if (deployTest && !timeForTest) {
      console.warn('[code-contribution] skipping the test subagent: not enough time left in this request')
      subagentRuns.push({ kind: 'test', model: params.authorModelId, ok: false, cost: 0 })
    }
    if (deployTest && timeForTest) {
      let testRun: SubagentRun = { kind: 'test', model: params.authorModelId, ok: false, cost: 0 }
      try {
        const subagent = await generateSubagentContribution(params.authorModelId, params.description, coder.files,
          params.deadlineAt ? params.deadlineAt - 30_000 : undefined)
        cost += subagent.cost
        testRun = { kind: 'test', model: subagent.model, ok: false, cost: subagent.cost }
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
        testRun = { ...testRun, ok: true, files: subagentFiles.map(f => f.path) }
      } catch (e) {
        console.warn('[code-contribution] subagent pass failed (non-fatal):', e instanceof Error ? e.message : e)
      }
      subagentRuns.push(testRun)
    }

    const prBody = contributionPrBody({
      summary: typeof coder.pr_summary === 'string' ? coder.pr_summary : '',
      author,
      explorers,
      testSubagent: subagentRuns.some(r => r.kind === 'test' && r.ok && (r.files?.length ?? 0) > 0),
    })
    const pr = await openPullRequest(params.branchName, params.title, prBody)

    const base: Omit<ContributionResult, 'merged' | 'cost'> = {
      pr_url: pr.html_url, files: coder.files, subagent_files: subagentFiles, author,
      explorer_task: explorerTask, explorer_findings: explorerFindings,
      web_searches: webSearches, web_sources: webSources, subagents: subagentRuns,
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
    } catch (e) {
      console.warn('[code-contribution] could not read the branch head (merge blocked):', e instanceof Error ? e.message : e)
    }
    // Deferred: the PR is open; CI runs on GitHub meanwhile and
    // resolveContribution reads it in a later request.
    if (params.deferResolution && params.review.mode !== 'auto-review' && headSha) {
      return {
        merged: false, ...base, cost, ci_passed: null,
        pending: {
          pr_number: pr.number, pr_url: pr.html_url, head_sha: headSha, branch: params.branchName,
          author_model_id: authorModelId, merge_message: coder.commit_message || params.title,
          approved: params.review.mode === 'approved', opened_at: new Date().toISOString(),
        },
      }
    }

    // The author's sprite checks out this exact commit and runs the tests
    // while CI runs. It has its own hard time limit and never throws; its
    // verdict is shown to viewers but does not decide the merge. It has to
    // finish before the PR is resolved, because closing deletes the branch.
    const spriteRun: Promise<SpriteCheck> = checkContributionInSprite({
      authorModelId, branch: params.branchName, headSha,
    }).catch(e => ({
      status: 'error' as const, exit_code: null, duration_ms: null, sprite_name: null, ran_at: null,
      output_tail: `sprite error: ${e instanceof Error ? e.message : 'unknown'}`.slice(0, 300),
    }))
    try {
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
    const sprite = await spriteRun
    base.sprite = sprite

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
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('[code-contribution] failed (non-fatal):', reason)
    return { merged: false, files: [], subagent_files: [], author, cost, explorer_task: explorerTask, explorer_findings: explorerFindings, web_searches: webSearches, web_sources: webSources, subagents: subagentRuns, error: reason.slice(0, 2000) }
  }
}


export type ResolvedContribution =
  | { status: 'not_ready' }
  | { status: 'resolved'; merged: boolean; ci_passed: boolean | null; ci_excerpt: string; sprite: SpriteCheck }

/**
 * Second half of a deferred contribution: read CI for the exact commit, run
 * the author's Sprite tests on it, then merge (approved and CI passed) or
 * close. Returns not_ready while CI is still running and `waitIfRunning`.
 * Never throws for GitHub or Sprite failures; the PR is always resolved
 * unless it is left open on purpose for a later try.
 */
export async function resolveContribution(
  pending: PendingContribution,
  opts: { ciWaitMs?: number; waitIfRunning?: boolean } = {},
): Promise<ResolvedContribution> {
  let ciPassed: boolean | null = null
  let ciExcerpt = ''
  try {
    const ci = await waitForCIRun(pending.head_sha, opts.ciWaitMs ?? 60_000)
    if (ci.conclusion === 'success') ciPassed = true
    else if (ci.conclusion === 'failure') {
      ciPassed = false
      ciExcerpt = ci.runId ? await getCIFailureExcerpt(ci.runId) : ''
    } else if (ci.conclusion === 'timeout' && opts.waitIfRunning) {
      return { status: 'not_ready' }
    }
  } catch (e) {
    console.warn('[code-contribution] CI check failed (merge blocked):', e instanceof Error ? e.message : e)
  }

  // The Sprite needs the branch, so it runs before the PR is closed.
  const sprite: SpriteCheck = await checkContributionInSprite({
    authorModelId: pending.author_model_id, branch: pending.branch, headSha: pending.head_sha,
  }).catch(e => ({
    status: 'error' as const, exit_code: null, duration_ms: null, sprite_name: null, ran_at: null,
    output_tail: `sprite error: ${e instanceof Error ? e.message : 'unknown'}`.slice(0, 300),
  }))

  if (ciPassed === true && pending.approved) {
    try {
      await mergePullRequest(pending.pr_number, pending.merge_message, pending.head_sha)
      return { status: 'resolved', merged: true, ci_passed: ciPassed, ci_excerpt: ciExcerpt, sprite }
    } catch (e) {
      console.warn('[code-contribution] merge failed, closing as fallback:', e instanceof Error ? e.message : e)
    }
  }
  await closePullRequest(pending.pr_number, pending.branch).catch(() => {})
  console.log(`[code-contribution] PR closed without merging (CI ${ciPassed === null ? 'gave no result' : ciPassed ? 'passed' : 'failed'}): ${pending.pr_url}`)
  return { status: 'resolved', merged: false, ci_passed: ciPassed, ci_excerpt: ciExcerpt, sprite }
}
