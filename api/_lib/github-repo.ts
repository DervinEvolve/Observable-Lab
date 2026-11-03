/**
 * Minimal GitHub REST client for the AI-Agent repo — the shared codebase that
 * scientists, wildcards (North/GLM), and their subagents contribute real code to.
 *
 * Auth: AI_AGENT_GITHUB_TOKEN, a fine-grained PAT scoped to ONLY this one repo
 * (Contents: read/write, Pull requests: read/write). Never use a broader token
 * here — this module is driven by LLM output and must not be able to reach
 * any other repository.
 */

import { labCommitIdentityFields } from './commit-identity.js'
import { assertManagedBranchName, encodeRefPath } from './branch-names.js'
import { requireGitHubName } from './config.js'

const API_BASE = 'https://api.github.com'
const DEFAULT_BRANCH = 'main'

// The owner has no default: an unset value fails instead of pointing this
// deployment's token at another account's repository.
function repoFullName(): string {
  const owner = requireGitHubName('AI_AGENT_GITHUB_OWNER', 'the AI-Agent contribution repository')
  const repo = requireGitHubName('AI_AGENT_GITHUB_REPO', 'the AI-Agent contribution repository', 'AI-Agent')
  return `${owner}/${repo}`
}
const repoPath = () => `/repos/${repoFullName()}`

function token(): string {
  const t = process.env.AI_AGENT_GITHUB_TOKEN
  if (!t) throw new Error('AI_AGENT_GITHUB_TOKEN not configured')
  return t
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  return res
}

export interface RepoFile {
  path: string
  content: string
}

// Total commits on the default branch, read from the Link header's rel="last"
// page with per_page=1 (no history walk). Cached ~2 min per warm serverless
// instance so viewer polling doesn't hammer GitHub.
let commitCountCache: { count: number; ts: number } | null = null
export async function getRepoCommitCount(): Promise<number | null> {
  if (commitCountCache && Date.now() - commitCountCache.ts < 120000) {
    return commitCountCache.count
  }
  try {
    const res = await gh(`${repoPath()}/commits?sha=${DEFAULT_BRANCH}&per_page=1`)
    if (!res.ok) return commitCountCache?.count ?? null
    const link = res.headers.get('link')
    let count: number
    if (link) {
      const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/)
      count = m ? parseInt(m[1], 10) : 1
    } else {
      // no Link header → the whole history fits on one page
      count = ((await res.json()) as unknown[]).length
    }
    commitCountCache = { count, ts: Date.now() }
    return count
  } catch {
    return commitCountCache?.count ?? null
  }
}

// SHA of the default branch's HEAD, or null if the branch/repo has no commits yet.
export async function getDefaultBranchSha(): Promise<string | null> {
  const res = await gh(`${repoPath()}/git/ref/heads/${DEFAULT_BRANCH}`)
  // 404 = branch doesn't exist; 409 = "Git Repository is empty" (GitHub's response
  // for a repo with zero commits) — both mean "nothing to branch from yet".
  if (res.status === 404 || res.status === 409) return null
  if (!res.ok) throw new Error(`getDefaultBranchSha failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.object.sha as string
}

// Lightweight top-level file listing for the default branch (best-effort; empty if repo has no commits yet).
export async function listRepoTree(): Promise<string[]> {
  const sha = await getDefaultBranchSha()
  if (!sha) return []
  const res = await gh(`${repoPath()}/git/trees/${sha}?recursive=1`)
  if (!res.ok) return []
  const data = await res.json()
  return (data.tree || []).map((t: { path: string }) => t.path).slice(0, 200)
}

// One-time scaffold for a brand-new empty repo. Safe to call every time — no-ops if main already exists.
export async function bootstrapRepoIfEmpty(): Promise<void> {
  const sha = await getDefaultBranchSha()
  if (sha) return // already has history

  await putFileOnBranch(
    DEFAULT_BRANCH,
    'README.md',
    '# AI-Agent\n\nAn agent implementation grown epoch-by-epoch by the Observable Lab — ' +
      'scientists, wildcards, and their subagents each contribute real, reviewed code here.\n',
    'chore: bootstrap repo'
  )
  await putFileOnBranch(
    DEFAULT_BRANCH,
    'package.json',
    JSON.stringify({ name: 'ai-agent', private: true, version: '0.0.0', type: 'module' }, null, 2) + '\n',
    'chore: bootstrap repo'
  )
}

// Only the lab's own epoch-/north/ branches can be deleted; `main` and any
// other name are refused before a request is made (the validation error is
// not swallowed, only network failures of the best-effort delete are).
export async function deleteBranch(branchName: string): Promise<void> {
  assertManagedBranchName(branchName)
  if (branchName === DEFAULT_BRANCH) throw new Error('Refusing to delete the default branch')
  await gh(`${repoPath()}/git/refs/heads/${encodeRefPath(branchName)}`, { method: 'DELETE' }).catch(() => {})
}

export async function createBranch(branchName: string): Promise<void> {
  assertManagedBranchName(branchName)
  const sha = await getDefaultBranchSha()
  if (!sha) throw new Error('Cannot branch — default branch has no commits yet')

  // Branch names can repeat across separate runs (e.g. north/exp-<epoch> when
  // North fires more than once in an epoch). Reusing a stale branch as-is
  // silently carries forward already-merged history, producing an unmergeable
  // PR later — confirmed live (mergeable_state: "dirty"). Always start fresh
  // from the current main HEAD instead of tolerating a pre-existing ref.
  await deleteBranch(branchName)

  const res = await gh(`${repoPath()}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  })
  if (!res.ok) {
    throw new Error(`createBranch failed: ${res.status} ${await res.text()}`)
  }
}

export async function getBranchHeadSha(branchName: string): Promise<string | null> {
  assertManagedBranchName(branchName)
  const res = await gh(`${repoPath()}/git/ref/heads/${encodeRefPath(branchName)}`)
  if (!res.ok) return null
  const data = await res.json()
  return data.object.sha as string
}

// ---- CI (GitHub Actions) ----
// Agent PRs trigger the repo's CI workflow; a contribution only merges if the
// suite passes. Reads go through the Actions API (PAT has Actions: read).

export type CIVerdict = { conclusion: 'success' | 'failure' | 'timeout' | 'none'; runId?: number }

// Poll for the workflow run on this head SHA until it completes (or we hit the
// serverless time budget). 'none' = no run appeared (workflow missing/disabled).
export async function waitForCIRun(headSha: string, timeoutMs = 180000, pollMs = 10000): Promise<CIVerdict> {
  const configured = (process.env.LAB_REQUIRED_CI_WORKFLOW_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!configured.length || configured.some(id => !/^[1-9]\d*$/.test(id))) {
    throw new Error('LAB_REQUIRED_CI_WORKFLOW_IDS must name the trusted destination CI workflows')
  }
  const required = new Set(configured.map(Number))
  const deadline = Date.now() + timeoutMs
  let runId: number | undefined
  while (Date.now() < deadline) {
    const res = await gh(`${repoPath()}/actions/runs?head_sha=${headSha}&per_page=100`)
    if (res.ok) {
      const data = await res.json()
      // A green unrelated workflow must not stand in for the actual test suite.
      // IDs are chosen by the operator, outside generated contributions.
      const runs = (data.workflow_runs || []).filter((run: {
        head_sha: string; head_repository?: { full_name?: string }; event: string
      }) => run.head_sha === headSha && run.head_repository?.full_name === `${repoFullName()}` &&
        ['push', 'pull_request'].includes(run.event))
      if (runs.length > 0) {
        runId = runs[0].id
        const failed = runs.find((run: { status: string; conclusion: string }) =>
          run.status === 'completed' && run.conclusion !== 'success')
        if (failed) return { conclusion: 'failure', runId: failed.id }
        if (data.total_count <= 100 && [...required].every(id => runs.some((run: { workflow_id: number }) => run.workflow_id === id)) && runs.every((run: { status: string; conclusion: string }) =>
          run.status === 'completed' && run.conclusion === 'success')) {
          return { conclusion: 'success', runId }
        }
      }
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  return { conclusion: runId ? 'timeout' : 'none', runId }
}

// Tail of the failed job's log, filtered to the useful lines — fed back to the
// lab so models learn from real runtime failures instead of imagined ones.
export async function getCIFailureExcerpt(runId: number): Promise<string> {
  try {
    const jobsRes = await gh(`${repoPath()}/actions/runs/${runId}/jobs`)
    if (!jobsRes.ok) return ''
    const jobs = await jobsRes.json()
    const failed = (jobs.jobs || []).find((j: { conclusion: string }) => j.conclusion === 'failure')
    if (!failed) return ''
    const logRes = await gh(`${repoPath()}/actions/jobs/${failed.id}/logs`)
    if (!logRes.ok) return ''
    const text = await logRes.text()
    const lines = text.split('\n').map(l =>
      l.replace(/^[^Z]*Z /, '')            // strip timestamps
        .replace(/\u001b\[[0-9;]*m/g, '') // strip ANSI color codes
    )
    const interesting = lines.filter(l => /FAIL|AssertionError|Error:|expected|✗|×|Tests {2}/.test(l))
    return (interesting.length ? interesting : lines).slice(-30).join('\n').slice(0, 3000)
  } catch {
    return ''
  }
}

export async function deleteFileOnBranch(
  branch: string,
  path: string,
  message: string
): Promise<void> {
  assertManagedBranchName(branch)
  const sha = await getFileSha(branch, path)
  if (!sha) return // nothing to delete
  const res = await gh(`${repoPath()}/contents/${encodeURIComponent(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch, ...labCommitIdentityFields() }),
  })
  if (!res.ok) throw new Error(`deleteFile(${path}) failed: ${res.status} ${await res.text()}`)
}

async function getFileSha(branch: string, path: string): Promise<string | undefined> {
  const res = await gh(`${repoPath()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`)
  if (!res.ok) return undefined
  const data = await res.json()
  return data.sha as string | undefined
}

// Generated contributions may only write to the lab's own branches.
export async function upsertFileOnBranch(
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  assertManagedBranchName(branch)
  await putFileOnBranch(branch, path, content, message)
}

// Internal: also used by bootstrapRepoIfEmpty to seed the default branch.
async function putFileOnBranch(
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  const existingSha = await getFileSha(branch, path)
  const res = await gh(`${repoPath()}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
      // Every lab commit uses the owner's noreply identity; the model that
      // wrote the change is named in the message trailers (commit-identity.ts).
      ...labCommitIdentityFields(),
    }),
  })
  if (!res.ok) throw new Error(`upsertFile(${path}) failed: ${res.status} ${await res.text()}`)
}

export interface OpenedPR {
  number: number
  html_url: string
}

export async function openPullRequest(branch: string, title: string, body: string): Promise<OpenedPR> {
  assertManagedBranchName(branch)
  const res = await gh(`${repoPath()}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, head: branch, base: DEFAULT_BRANCH, body }),
  })
  if (!res.ok) throw new Error(`openPullRequest failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return { number: data.number, html_url: data.html_url }
}

// GitHub computes a PR's mergeability asynchronously right after it's opened —
// `mergeable` is null for a brief window. Merging immediately can fail purely
// because that computation hadn't finished yet (confirmed live: 2 of 3 real
// contributions in one epoch closed instead of merging for exactly this
// reason). Poll briefly before deciding.
async function waitForMergeable(prNumber: number, maxAttempts = 5, delayMs = 1500): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await gh(`${repoPath()}/pulls/${prNumber}`)
    if (res.ok) {
      const data = await res.json()
      if (data.mergeable !== null) return data.mergeable === true
    }
    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  return false // GitHub never finished computing it in time — treat as not mergeable
}

export async function mergePullRequest(prNumber: number, commitMessage: string, checkedHeadSha: string): Promise<void> {
  const mergeable = await waitForMergeable(prNumber)
  if (!mergeable) {
    throw new Error(`mergePullRequest: PR #${prNumber} is not mergeable (conflict, or GitHub hadn't finished computing it)`)
  }
  // A real merge (not squash) so each contribution's own commits, with the
  // Model trailers naming who wrote them, survive on main instead of being
  // flattened into one commit.
  const res = await gh(`${repoPath()}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'merge', commit_title: commitMessage, sha: checkedHeadSha }),
  })
  if (!res.ok) throw new Error(`mergePullRequest failed: ${res.status} ${await res.text()}`)
}

export async function closePullRequest(prNumber: number, branch: string): Promise<void> {
  await gh(`${repoPath()}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  }).catch(() => {})
  await deleteBranch(branch) // best-effort cleanup — not fatal if it fails
}

