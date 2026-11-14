/**
 * Reads merged exhibits from AI-Agent's default branch for the room.
 *
 * AI-Agent is public, so this needs no token; when AI_AGENT_GITHUB_TOKEN is
 * set it is sent to api.github.com only, to get the higher rate limit. Every
 * file is validated again here (a file on main that fails the contract is
 * left out and logged), and the result is cached for about 10 minutes per
 * warm instance. A missing exhibits/ folder, an empty repository or a
 * GitHub outage gives an empty list (or the last good list), never an error.
 *
 * author_model comes from the git record: when the commit that last changed
 * the file is authored on observable-lab.invalid, that author's name is used,
 * whatever the file says. Files the owner committed directly keep theirs.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireGitHubName } from './config.js'
import { MODEL_AUTHOR_DOMAIN } from './commit-identity.js'
import { MAX_FILE_BYTES, isExhibitPath, selectForRoom, validateExhibit, type Exhibit, type MergedExhibit } from './exhibits.js'

const API_BASE = 'https://api.github.com'
const TIMEOUT_MS = 15_000
export const EXHIBITS_CACHE_MS = 10 * 60 * 1000
const MAX_FILES = 64

interface FileMeta { commit_sha: string; merged_at: string; author_model: string; data: Exhibit }

let cache: { at: number; exhibits: MergedExhibit[] } | null = null
// Blob sha -> what was read for it. A blob never changes, so this can live as long as the instance.
const byBlob = new Map<string, FileMeta | null>()

export function resetExhibitsCache(): void {
  cache = null
  byBlob.clear()
}

async function gh(path: string): Promise<Response> {
  const token = (process.env.AI_AGENT_GITHUB_TOKEN || '').trim()
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

async function readOne(repoPath: string, branch: string, path: string, blobSha: string): Promise<FileMeta | null> {
  const blob = await gh(`${repoPath}/git/blobs/${blobSha}`)
  if (!blob.ok) throw new Error(`blob ${path}: ${blob.status}`)
  const b = await blob.json() as { content?: unknown; encoding?: unknown; size?: unknown }
  if (typeof b.size === 'number' && b.size > MAX_FILE_BYTES) {
    console.warn(`[exhibits] ${path} is larger than ${MAX_FILE_BYTES} bytes; not shown`)
    return null
  }
  if (b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error(`blob ${path}: unexpected encoding`)
  const text = Buffer.from(b.content, 'base64').toString('utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return null
  let data: unknown
  try { data = JSON.parse(text) } catch {
    console.warn(`[exhibits] ${path} is not valid JSON; not shown`)
    return null
  }
  const errors = validateExhibit(data)
  if (errors.length) {
    console.warn(`[exhibits] ${path} does not meet the contract; not shown: ${errors.slice(0, 3).join('; ')}`)
    return null
  }
  const exhibit = data as Exhibit

  const commits = await gh(`${repoPath}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`)
  if (!commits.ok) throw new Error(`commits ${path}: ${commits.status}`)
  const list = await commits.json() as Array<{ sha?: unknown; commit?: { author?: { name?: unknown; email?: unknown; date?: unknown }; committer?: { date?: unknown } } }>
  const c = Array.isArray(list) ? list[0] : undefined
  const commitSha = typeof c?.sha === 'string' && /^[0-9a-f]{40}$/.test(c.sha) ? c.sha : ''
  if (!commitSha) return null
  const authorEmail = typeof c?.commit?.author?.email === 'string' ? c.commit.author.email : ''
  const authorName = typeof c?.commit?.author?.name === 'string' ? c.commit.author.name.slice(0, 60) : ''
  const authorModel = authorEmail.endsWith(`@${MODEL_AUTHOR_DOMAIN}`) && authorName ? authorName : exhibit.author_model

  let mergedAt = typeof c?.commit?.committer?.date === 'string' ? c.commit.committer.date : ''
  const pulls = await gh(`${repoPath}/commits/${commitSha}/pulls`).catch(() => null)
  if (pulls?.ok) {
    const prs = await pulls.json() as Array<{ merged_at?: unknown }>
    const merged = Array.isArray(prs) ? prs.map(p => p.merged_at).find((m): m is string => typeof m === 'string') : undefined
    if (merged) mergedAt = merged
  }
  if (!mergedAt || Number.isNaN(Date.parse(mergedAt))) mergedAt = new Date(0).toISOString()
  return { commit_sha: commitSha, merged_at: new Date(mergedAt).toISOString(), author_model: authorModel, data: { ...exhibit, author_model: authorModel } }
}

/** Every valid merged exhibit on the default branch (not yet narrowed for the room). */
export async function readMergedExhibits(): Promise<MergedExhibit[]> {
  const owner = requireGitHubName('AI_AGENT_GITHUB_OWNER', 'reading exhibits')
  const repo = requireGitHubName('AI_AGENT_GITHUB_REPO', 'reading exhibits', 'AI-Agent')
  const repoPath = `/repos/${owner}/${repo}`

  const meta = await gh(repoPath)
  if (!meta.ok) throw new Error(`repository: ${meta.status}`)
  const branch = String((await meta.json() as { default_branch?: unknown }).default_branch || 'main')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch)) throw new Error('unexpected default branch name')

  const tree = await gh(`${repoPath}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
  // 404: no branch yet; 409: empty repository. Nothing to show either way.
  if (tree.status === 404 || tree.status === 409) return []
  if (!tree.ok) throw new Error(`tree: ${tree.status}`)
  const entries = ((await tree.json() as { tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown }> }).tree || [])
    .filter(t => t.type === 'blob' && isExhibitPath(t.path) && typeof t.sha === 'string' && /^[0-9a-f]{40}$/.test(t.sha))
    .slice(0, MAX_FILES) as Array<{ path: string; sha: string }>

  const out: MergedExhibit[] = []
  for (const entry of entries) {
    const slug = entry.path.split('/')[1]
    let meta2 = byBlob.get(entry.sha)
    if (meta2 === undefined) {
      try {
        meta2 = await readOne(repoPath, branch, entry.path, entry.sha)
        byBlob.set(entry.sha, meta2)
      } catch (e) {
        console.warn(`[exhibits] could not read ${entry.path}:`, e instanceof Error ? e.message : e)
        continue // try again next refresh
      }
    }
    if (meta2) out.push({ slug, ...meta2 })
  }
  return out
}

/** What GET /api/experiment/exhibits serves: cached, validated, narrowed for the room. */
export async function getRoomExhibits(now = Date.now()): Promise<MergedExhibit[]> {
  if (cache && now - cache.at < EXHIBITS_CACHE_MS) return cache.exhibits
  try {
    const exhibits = selectForRoom(await readMergedExhibits())
    cache = { at: now, exhibits }
    return exhibits
  } catch (e) {
    console.warn('[exhibits] read failed; serving the last good list:', e instanceof Error ? e.message : e)
    // Keep the old list but try again in a minute rather than ten.
    cache = { at: now - EXHIBITS_CACHE_MS + 60_000, exhibits: cache?.exhibits ?? [] }
    return cache.exhibits
  }
}

/**
 * The public handler: GET only, { exhibits: [...] }, never an error status
 * for a GitHub problem (the room just shows nothing new).
 */
export async function exhibitsHandler(req: Pick<VercelRequest, 'method'>, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const exhibits = await getRoomExhibits()
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=120, stale-while-revalidate=600')
    return res.status(200).json({
      exhibits: exhibits.map(e => ({ slug: e.slug, commit_sha: e.commit_sha, merged_at: e.merged_at, author_model: e.author_model, data: e.data })),
    })
  } catch (error) {
    console.error('[API] Error reading exhibits:', error instanceof Error ? error.message : error)
    return res.status(200).json({ exhibits: [] })
  }
}
