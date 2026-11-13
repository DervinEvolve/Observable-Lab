// The three GitHub repositories behind the room. The backend reports them in
// GET /api/experiment as `repos`; with no backend the room falls back to the
// owner's public repository addresses below. Only github.com https links are
// accepted, so a bad value from the API can never become some other link.

export type RepoKey = 'ai_agent' | 'observable_lab' | 'research_lab'

export interface RepoLink {
  key: RepoKey
  name: string // repository name as shown, taken from the URL
  url: string
  blurb: string // what the repo holds, in plain words
}

export const REPO_ORDER: RepoKey[] = ['ai_agent', 'observable_lab', 'research_lab']

const FALLBACK_URLS: Record<RepoKey, string> = {
  ai_agent: 'https://github.com/DervinEvolve/AI-Agent',
  observable_lab: 'https://github.com/DervinEvolve/Observable-Lab',
  research_lab: 'https://github.com/DervinEvolve/Research-Lab',
}

const BLURBS: Record<RepoKey, string> = {
  ai_agent: 'the specimen. Code the models write and test.',
  observable_lab: "this room's own code.",
  research_lab: 'training runs and findings.',
}

// Accepted spellings for each key in the API payload.
const ALIASES: Record<RepoKey, string[]> = {
  ai_agent: ['ai_agent', 'aiAgent', 'AI-Agent', 'specimen', 'agent'],
  observable_lab: ['observable_lab', 'observableLab', 'Observable-Lab', 'lab'],
  research_lab: ['research_lab', 'researchLab', 'Research-Lab', 'research'],
}

/** Returns a clean https://github.com/<owner>/<repo> URL, or null. */
export function cleanGithubUrl(value: unknown): string | null {
  let raw: unknown = value
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    raw = o.url ?? o.html_url
  }
  if (typeof raw !== 'string' || raw.length > 200) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.port) return null
  const m = u.pathname.replace(/\.git$/, '').match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/)
  if (!m || m[2] === '.' || m[2] === '..') return null
  return `https://github.com/${m[1]}/${m[2]}`
}

function linkFor(key: RepoKey, url: string): RepoLink {
  const name = url.split('/').pop() || key
  return { key, name, url, blurb: BLURBS[key] }
}

export function defaultRepoLinks(): RepoLink[] {
  return REPO_ORDER.map(k => linkFor(k, FALLBACK_URLS[k]))
}

/** Reads the `repos` object of the experiment state; missing or bad entries fall back. */
export function repoLinksFrom(repos: unknown): RepoLink[] {
  const src = repos && typeof repos === 'object' && !Array.isArray(repos) ? (repos as Record<string, unknown>) : {}
  return REPO_ORDER.map(key => {
    for (const alias of ALIASES[key]) {
      if (!Object.hasOwn(src, alias)) continue
      const url = cleanGithubUrl(src[alias])
      if (url) return linkFor(key, url)
    }
    return linkFor(key, FALLBACK_URLS[key])
  })
}

export function githubRepoTooltip(link: RepoLink): string {
  return `${link.name}: ${link.blurb}`
}
