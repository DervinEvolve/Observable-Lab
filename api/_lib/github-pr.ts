/**
 * A small GitHub pull request client for the two tool paths that are not
 * code contributions:
 *
 *   exhibits:       AI-Agent, AI_AGENT_GITHUB_TOKEN, branches exhibit/epoch-<n>-<slug>
 *   lab proposals:  Observable-Lab, LAB_PROPOSALS_GITHUB_TOKEN, branches
 *                   model-proposal/epoch-<n>-<slug>, and no merge at all
 *
 * github-repo.ts only accepts the contribution branch shapes, so this keeps
 * its own, equally strict, shapes. Every ref and path is checked before a
 * request is made, every request has a timeout, and the commits carry the
 * same identity rules as everything else the lab writes (model author on
 * observable-lab.invalid, owner as committer).
 */
import { assertSafeRefName, encodeRefPath } from './branch-names.js'
import { labCommitIdentityFields } from './commit-identity.js'

const API_BASE = 'https://api.github.com'
const TIMEOUT_MS = 30_000

export const EXHIBIT_BRANCH_RE = /^exhibit\/epoch-(0|[1-9]\d{0,8})-[a-z0-9-]{3,40}$/
export const PROPOSAL_BRANCH_RE = /^model-proposal\/epoch-(0|[1-9]\d{0,8})-[a-z0-9-]{3,40}$/

export interface PrRepo {
  owner: string
  repo: string
  token: string
  branchRe: RegExp
  /** False for lab proposals: the owner merges those by hand. */
  allowMerge: boolean
}

function assertName(value: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) || value.includes('..')) throw new Error(`${what} is not a valid GitHub name`)
}

export function assertBranch(repo: PrRepo, branch: unknown): asserts branch is string {
  assertSafeRefName(branch)
  if (!repo.branchRe.test(branch)) throw new Error('Refusing branch name: not one of this tool\'s branch shapes')
}

async function gh(repo: PrRepo, path: string, init: RequestInit = {}): Promise<Response> {
  assertName(repo.owner, 'owner')
  assertName(repo.repo, 'repository')
  if (!repo.token) throw new Error('GitHub token is not configured for this tool')
  return fetch(`${API_BASE}/repos/${repo.owner}/${repo.repo}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${repo.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

async function fail(res: Response, what: string): Promise<Error> {
  let body = ''
  try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200) } catch { /* ignore */ }
  return new Error(`${what} failed: ${res.status}${body ? ` ${body}` : ''}`)
}

export async function defaultBranch(repo: PrRepo): Promise<{ name: string; sha: string }> {
  const meta = await gh(repo, '')
  if (!meta.ok) throw await fail(meta, 'read repository')
  const name = String((await meta.json() as { default_branch?: unknown }).default_branch || 'main')
  assertSafeRefName(name)
  const ref = await gh(repo, `/git/ref/heads/${encodeRefPath(name)}`)
  if (!ref.ok) throw await fail(ref, 'read default branch')
  const sha = String((await ref.json() as { object?: { sha?: unknown } }).object?.sha || '')
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('default branch has no commit')
  return { name, sha }
}

export async function deleteBranch(repo: PrRepo, branch: string): Promise<void> {
  assertBranch(repo, branch)
  await gh(repo, `/git/refs/heads/${encodeRefPath(branch)}`, { method: 'DELETE' }).catch(() => {})
}

/** A fresh branch at `sha`; a leftover branch of the same name is removed first. */
export async function createBranch(repo: PrRepo, branch: string, sha: string): Promise<void> {
  assertBranch(repo, branch)
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('createBranch needs a commit sha')
  await deleteBranch(repo, branch)
  const res = await gh(repo, '/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) })
  if (!res.ok) throw await fail(res, 'create branch')
}

export async function branchHead(repo: PrRepo, branch: string): Promise<string | null> {
  assertBranch(repo, branch)
  const res = await gh(repo, `/git/ref/heads/${encodeRefPath(branch)}`)
  if (!res.ok) return null
  const sha = String((await res.json() as { object?: { sha?: unknown } }).object?.sha || '')
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

/** Each path segment must be plain; the caller decides which paths are allowed at all. */
export function encodeContentPath(path: string): string {
  const parts = path.split('/')
  if (!path || path.length > 200 || !parts.every(p => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && !p.includes('..'))) {
    throw new Error('Refusing file path')
  }
  return parts.map(encodeURIComponent).join('/')
}

export async function putFile(repo: PrRepo, branch: string, path: string, content: string, message: string): Promise<void> {
  assertBranch(repo, branch)
  const encoded = encodeContentPath(path)
  const existing = await gh(repo, `/contents/${encoded}?ref=${encodeURIComponent(branch)}`)
  const sha = existing.ok ? ((await existing.json() as { sha?: unknown }).sha as string | undefined) : undefined
  const res = await gh(repo, `/contents/${encoded}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(typeof sha === 'string' ? { sha } : {}),
      ...labCommitIdentityFields(message),
    }),
  })
  if (!res.ok) throw await fail(res, `write ${path}`)
}

export interface OpenedPr { number: number; html_url: string }

export async function openPr(repo: PrRepo, branch: string, base: string, title: string, body: string): Promise<OpenedPr> {
  assertBranch(repo, branch)
  assertSafeRefName(base)
  const res = await gh(repo, '/pulls', {
    method: 'POST',
    body: JSON.stringify({ title: title.slice(0, 200), head: branch, base, body: body.slice(0, 60_000) }),
  })
  if (!res.ok) throw await fail(res, 'open pull request')
  const data = await res.json() as { number?: unknown; html_url?: unknown }
  if (typeof data.number !== 'number' || typeof data.html_url !== 'string') throw new Error('open pull request: unexpected response')
  return { number: data.number, html_url: data.html_url }
}

export async function addLabels(repo: PrRepo, prNumber: number, labels: string[]): Promise<void> {
  const res = await gh(repo, `/issues/${Math.floor(prNumber)}/labels`, { method: 'POST', body: JSON.stringify({ labels }) })
  if (!res.ok) throw await fail(res, 'label pull request')
}

export async function closePr(repo: PrRepo, prNumber: number, branch: string): Promise<void> {
  await gh(repo, `/pulls/${Math.floor(prNumber)}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }).catch(() => {})
  await deleteBranch(repo, branch).catch(() => {})
}

/** Merge pinned to the checked sha. Refused outright for a repo that does not allow it. */
export async function mergePr(repo: PrRepo, prNumber: number, title: string, checkedSha: string): Promise<void> {
  if (!repo.allowMerge) throw new Error('This repository is never merged by the lab')
  if (!/^[0-9a-f]{40}$/.test(checkedSha)) throw new Error('merge needs the checked sha')
  // GitHub works mergeability out a moment after the pull request opens.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await gh(repo, `/pulls/${Math.floor(prNumber)}`)
    if (res.ok) {
      const mergeable = (await res.json() as { mergeable?: unknown }).mergeable
      if (mergeable === false) throw new Error(`pull request #${prNumber} is not mergeable`)
      if (mergeable === true) break
    }
    if (attempt === 4) throw new Error(`pull request #${prNumber}: mergeability unknown`)
    await new Promise(r => setTimeout(r, 1500))
  }
  const res = await gh(repo, `/pulls/${Math.floor(prNumber)}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'merge', commit_title: title.slice(0, 200), sha: checkedSha }),
  })
  if (!res.ok) throw await fail(res, 'merge pull request')
}

/** Pull request descriptions are public: model text must not ping anyone on GitHub. */
export function quietMentions(text: string): string {
  return text.replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9._-]+)?)/g, '$1`@$2`')
}
