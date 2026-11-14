/**
 * Proposals to the room's own repository (Observable-Lab). Off unless
 * LAB_ENABLE_LAB_PROPOSALS is "true" and a separate fine-grained token is
 * set (LAB_PROPOSALS_GITHUB_TOKEN: Pull requests and Contents on that one
 * repository, nothing else; it never falls back to another token).
 *
 * A proposal is a pull request labelled "model-proposal". The lab never
 * merges it: there is no merge call in this path at all (its PrRepo has
 * allowMerge false). This repository deploys to production and its server
 * holds the lab's credentials, so only the owner merges (SECURITY.md).
 */
import { requireGitHubName } from './config.js'
import { withModelTrailers } from './commit-identity.js'
import {
  PROPOSAL_BRANCH_RE, addLabels, closePr, createBranch, defaultBranch, deleteBranch, openPr, putFile, quietMentions, type PrRepo,
} from './github-pr.js'

export const PROPOSAL_LABEL = 'model-proposal'
export const PROPOSAL_MAX_FILES = 3
export const PROPOSAL_MAX_FILE_CHARS = 40_000

export function proposalsRepo(): PrRepo {
  return {
    owner: requireGitHubName('LAB_PROPOSALS_GITHUB_OWNER', 'lab proposals'),
    repo: requireGitHubName('LAB_PROPOSALS_GITHUB_REPO', 'lab proposals', 'Observable-Lab'),
    token: (process.env.LAB_PROPOSALS_GITHUB_TOKEN || '').trim(),
    branchRe: PROPOSAL_BRANCH_RE,
    allowMerge: false,
  }
}

/**
 * Paths a proposal may touch: source, API, docs, tests and Modal code. Never
 * workflows, hidden paths, environment files, dependency manifests or build
 * and deployment configuration.
 */
export function isProposalPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
  const parts = path.split('/')
  if (!parts.every(p => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && !p.includes('..'))) return false
  if (!['src', 'api', 'docs', 'tests', 'modal'].includes(parts[0]) || parts.length < 2) return false
  if (!/\.(ts|tsx|js|mjs|md|py|css|txt)$/.test(path)) return false
  if (/(^|\/)(package(-lock)?\.json|requirements[^/]*\.txt|tsconfig[^/]*|vite\.config\.[a-z]+|vercel\.json|schema\.sql)$/i.test(path)) return false
  if (/secret|credential|\.env/i.test(path)) return false
  return true
}

export function slugFromTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return slug.length >= 3 ? slug : 'proposal'
}

export interface ProposalRequest {
  title: string
  summary: string
  files: Array<{ path: string; content: string }>
}

export function normalizeProposal(raw: unknown): { proposal: ProposalRequest } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' }
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim().slice(0, 100) : ''
  const summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, 4000) : ''
  if (title.length < 5) return { error: 'title missing' }
  if (summary.length < 20) return { error: 'summary missing' }
  if (!Array.isArray(r.files) || r.files.length < 1 || r.files.length > PROPOSAL_MAX_FILES) return { error: `1 to ${PROPOSAL_MAX_FILES} files` }
  const files: ProposalRequest['files'] = []
  for (const f of r.files) {
    const path = f && typeof f === 'object' ? (f as Record<string, unknown>).path : undefined
    const content = f && typeof f === 'object' ? (f as Record<string, unknown>).content : undefined
    if (!isProposalPath(path)) return { error: `path not allowed: ${String(path).slice(0, 80)}` }
    if (typeof content !== 'string' || content.length > PROPOSAL_MAX_FILE_CHARS) return { error: `content of ${path} missing or too long` }
    files.push({ path, content })
  }
  return { proposal: { title, summary, files } }
}

export interface ProposalResult {
  status: 'opened' | 'error'
  pr_url?: string
  branch?: string
  error?: string
  durationMs: number
}

/** Opens the labelled pull request. Never merges, never throws. */
export async function openLabProposal(params: {
  epochNumber: number
  proposal: ProposalRequest
  authorName: string
  authorModelId: string
  fallbackFor?: string
  reviewerName: string
}): Promise<ProposalResult> {
  const started = Date.now()
  const done = (r: Omit<ProposalResult, 'durationMs'>): ProposalResult => ({ ...r, durationMs: Date.now() - started })
  const branch = `model-proposal/epoch-${params.epochNumber}-${slugFromTitle(params.proposal.title)}`
  let repo: PrRepo
  try {
    repo = proposalsRepo()
    if (!repo.token) return done({ status: 'error', error: 'LAB_PROPOSALS_GITHUB_TOKEN is not set' })
    if (!PROPOSAL_BRANCH_RE.test(branch)) return done({ status: 'error', error: 'bad branch name' })
  } catch (e) {
    return done({ status: 'error', error: e instanceof Error ? e.message : 'not configured' })
  }
  let prNumber: number | null = null
  try {
    const base = await defaultBranch(repo)
    await createBranch(repo, branch, base.sha)
    const message = withModelTrailers(`proposal: ${params.proposal.title}`, {
      name: params.authorName, id: params.authorModelId, role: 'lab-proposal', fallbackFor: params.fallbackFor,
    })
    for (const f of params.proposal.files) await putFile(repo, branch, f.path, f.content, message)
    const pr = await openPr(repo, branch, base.name, `Model proposal: ${params.proposal.title}`, quietMentions([
      `${params.authorName} proposed this change to the lab itself during epoch ${params.epochNumber}, and ${params.reviewerName} approved opening it as Reviewer.`,
      '',
      params.proposal.summary,
      '',
      '---',
      'The lab never merges model proposals. This repository deploys to production and its server holds the lab\'s credentials, so only the owner reviews and merges (SECURITY.md).',
      '',
      '_Opened automatically by the Observable Lab._',
    ].join('\n')))
    prNumber = pr.number
    await addLabels(repo, pr.number, [PROPOSAL_LABEL])
    return done({ status: 'opened', pr_url: pr.html_url, branch })
  } catch (e) {
    // An unlabelled proposal must not stay open: close it rather than leave it looking like ordinary work.
    if (prNumber !== null) await closePr(repo, prNumber, branch).catch(() => {})
    else await deleteBranch(repo, branch).catch(() => {})
    return done({ status: 'error', error: e instanceof Error ? e.message.slice(0, 300) : 'proposal failed' })
  }
}
