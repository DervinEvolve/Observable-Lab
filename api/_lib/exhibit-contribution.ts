/**
 * Delivers an exhibit the Executor designed and the Reviewer approved: one
 * pull request to AI-Agent that adds exhibits/<slug>/exhibit.json and
 * nothing else. It merges only when AI-Agent's trusted CI workflows pass for
 * the exact commit (that CI runs AI-Agent's own exhibit check), and is closed
 * otherwise. The commit is authored by the model, committed by the owner.
 */
import { requireGitHubName } from './config.js'
import { withModelTrailers } from './commit-identity.js'
import { getCIFailureExcerpt, waitForCIRun } from './github-repo.js'
import {
  EXHIBIT_BRANCH_RE, branchHead, closePr, createBranch, deleteBranch, defaultBranch, mergePr, openPr, putFile, quietMentions, type PrRepo,
} from './github-pr.js'
import { exhibitPath, isExhibitPath, prepareExhibit, type Exhibit } from './exhibits.js'

export function exhibitsRepo(): PrRepo {
  return {
    owner: requireGitHubName('AI_AGENT_GITHUB_OWNER', 'exhibit pull requests'),
    repo: requireGitHubName('AI_AGENT_GITHUB_REPO', 'exhibit pull requests', 'AI-Agent'),
    token: (process.env.AI_AGENT_GITHUB_TOKEN || '').trim(),
    branchRe: EXHIBIT_BRANCH_RE,
    allowMerge: true,
  }
}

export function exhibitBranchName(epochNumber: number, slug: string): string {
  if (!Number.isSafeInteger(epochNumber) || epochNumber < 0 || epochNumber > 999_999_999) throw new Error('bad epoch')
  const name = `exhibit/epoch-${epochNumber}-${slug}`
  if (!EXHIBIT_BRANCH_RE.test(name)) throw new Error('bad exhibit branch')
  return name
}

export interface ExhibitResult {
  status: 'merged' | 'closed' | 'error'
  slug: string
  pr_url?: string
  ci_passed: boolean | null
  ci_excerpt?: string
  error?: string
  durationMs: number
}

export async function contributeExhibit(params: {
  epochNumber: number
  slug: string
  raw: unknown                // the exhibit object from the Executor
  authorName: string          // display name of the model that answered
  authorModelId: string
  fallbackFor?: string
  reviewerName: string
}): Promise<ExhibitResult> {
  const started = Date.now()
  const done = (r: Omit<ExhibitResult, 'durationMs' | 'slug'>): ExhibitResult => ({ ...r, slug: params.slug, durationMs: Date.now() - started })
  let prepared: { exhibit: Exhibit; json: string }
  try {
    const p = prepareExhibit(params.raw, params.authorName)
    if (!p.ok) return done({ status: 'error', ci_passed: null, error: `does not meet the exhibit contract: ${p.errors.slice(0, 3).join('; ')}` })
    prepared = p
  } catch (e) {
    return done({ status: 'error', ci_passed: null, error: e instanceof Error ? e.message : 'invalid exhibit' })
  }

  const repo = exhibitsRepo()
  const path = exhibitPath(params.slug)
  if (!isExhibitPath(path)) return done({ status: 'error', ci_passed: null, error: 'bad exhibit path' })
  const branch = exhibitBranchName(params.epochNumber, params.slug)
  let pr: { number: number; html_url: string } | null = null
  try {
    const base = await defaultBranch(repo)
    // A slug already on the default branch belongs to an earlier exhibit.
    const taken = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${encodeURIComponent(base.name)}`, {
      headers: { Authorization: `Bearer ${repo.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    })
    if (taken.ok) return done({ status: 'error', ci_passed: null, error: `an exhibit named ${params.slug} already exists` })

    await createBranch(repo, branch, base.sha)
    const message = withModelTrailers(`exhibit: add ${params.slug}`, {
      name: params.authorName, id: params.authorModelId, role: 'exhibit', fallbackFor: params.fallbackFor,
    })
    await putFile(repo, branch, path, prepared.json, message)
    const e = prepared.exhibit
    pr = await openPr(repo, branch, base.name, `Exhibit: ${e.title}`, quietMentions([
      `${params.authorName} designed this exhibit for the Observable Lab room, and ${params.reviewerName} approved it as Reviewer in epoch ${params.epochNumber}.`,
      '',
      `> ${e.description.replace(/\n+/g, ' ')}`,
      '',
      `- Placement: ${e.placement}`,
      `- Parts: ${e.parts.length}`,
      `- File: \`${path}\` (data only, checked against the version 1 exhibit contract before this pull request was opened)`,
      '',
      'It merges only if the repository CI passes for this exact commit.',
      '',
      '_Opened automatically by the Observable Lab._',
    ].join('\n')))

    const headSha = await branchHead(repo, branch)
    if (!headSha) {
      await closePr(repo, pr.number, branch)
      return done({ status: 'closed', pr_url: pr.html_url, ci_passed: null, error: 'could not read the branch head' })
    }
    const ci = await waitForCIRun(headSha)
    if (ci.conclusion !== 'success') {
      const excerpt = ci.conclusion === 'failure' && ci.runId ? await getCIFailureExcerpt(ci.runId) : ''
      await closePr(repo, pr.number, branch)
      return done({ status: 'closed', pr_url: pr.html_url, ci_passed: ci.conclusion === 'failure' ? false : null, ci_excerpt: excerpt })
    }
    try {
      await mergePr(repo, pr.number, `exhibit: add ${params.slug}`, headSha)
      return done({ status: 'merged', pr_url: pr.html_url, ci_passed: true })
    } catch (err) {
      await closePr(repo, pr.number, branch)
      return done({ status: 'closed', pr_url: pr.html_url, ci_passed: true, error: err instanceof Error ? err.message : 'merge failed' })
    }
  } catch (err) {
    if (pr) await closePr(repo, pr.number, branch).catch(() => {})
    else await deleteBranch(repo, branch).catch(() => {})
    return done({ status: 'error', pr_url: pr?.html_url, ci_passed: null, error: err instanceof Error ? err.message : 'exhibit failed' })
  }
}
