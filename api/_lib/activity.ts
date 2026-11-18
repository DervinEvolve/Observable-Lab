/**
 * The research record of what each model did in an epoch, beside what it
 * said it did.
 *
 * Built only from rows the lab already stores: the epoch's role outputs
 * (with OpenRouter's cited pages, `web_sources`, and the model's own
 * `web_searches` claim), tool_runs (Sprite commands and their output,
 * subagents, GPU jobs, exhibits, proposals), code_contributions (PR, CI,
 * Sprite test, the explorer's searches and citations) and the model_calls
 * spend ledger.
 *
 * Every field says where it came from: "claimed" is the model's own report,
 * "recorded" is what the lab or OpenRouter logged. `flags` mark where the two
 * disagree, as observations, not verdicts.
 */
import { sanitizeOutput } from './sprites.js'
import { answeredModel } from './openrouter.js'
import { modelDisplayName } from './types.js'

// Calls that had OpenRouter's web plugin switched on (epoch-runner.ts); every
// other role answered without web access.
export const ROLES_WITH_WEB = new Set(['planner', 'executor'])

const ROLE_FIELDS: Array<{ role: string; column: string; assignKey: string }> = [
  { role: 'planner', column: 'planner_output', assignKey: 'planner' },
  { role: 'executor', column: 'executor_output', assignKey: 'executor' },
  { role: 'challenger', column: 'challenger_output', assignKey: 'challenger' },
  { role: 'rebuttal', column: 'executor_rebuttal', assignKey: 'executor' },
  { role: 'reviewer', column: 'reviewer_output', assignKey: 'reviewer' },
  { role: 'commentator', column: 'commentator_output', assignKey: 'commentator' },
]

export interface SourceLink { url: string; title: string; domain: string }

export interface RoleActivity {
  role: string
  assigned_model: string
  answered_by: string
  answered_by_name: string
  fallback: boolean
  had_web_access: boolean
  claimed_searches: string[]          // the model's own report
  recorded_sources: SourceLink[]      // pages OpenRouter says it cited
  flags: string[]
}

export interface ToolActivity {
  tool: string
  model: string
  model_name: string
  request: string | null
  status: string
  exit_code: number | null
  duration_ms: number | null
  cost_usd: number
  output_tail: string | null
  at: string | null
}

export interface ContributionActivity {
  author: string
  branch: string
  pr_url: string | null
  merged: boolean
  ci_passed: boolean | null
  sprite_tests: 'passed' | 'failed' | 'not run'
  explorer_task: string | null
  explorer_claimed_searches: string[]
  explorer_recorded_sources: SourceLink[]
  flags: string[]
}

export interface SpendByModel {
  model: string
  model_name: string
  purpose: string | null
  requests: number
  cost_usd: number
  prompt_tokens: number
  completion_tokens: number
}

export interface EpochActivity {
  epoch_number: number
  started_at: string | null
  completed_at: string | null
  follow_up: { status: string; pr_url?: string | null; merged?: boolean; ci_passed?: boolean | null } | null
  roles: RoleActivity[]
  tools: ToolActivity[]
  contributions: ContributionActivity[]
  spend: SpendByModel[]
  totals: { cost_usd: number; searches_claimed: number; sources_recorded: number; flags: number }
}

const strings = (v: unknown, max = 10): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(s => s.slice(0, 200)).slice(0, max) : []

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

export function sources(v: unknown, max = 20): SourceLink[] {
  if (!Array.isArray(v)) return []
  const out: SourceLink[] = []
  for (const s of v) {
    const url = typeof s?.url === 'string' ? s.url : ''
    if (!/^https?:\/\//i.test(url) || url.length > 500) continue
    out.push({ url, title: typeof s.title === 'string' ? s.title.slice(0, 200) : url, domain: domainOf(url) })
    if (out.length >= max) break
  }
  return out
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
// 'owner' is who a keep or an unkeep made through the operator route is stored under (tinker-keep.ts).
const nameOf = (id: string) => modelDisplayName(id) || (id === 'owner' ? 'The owner' : id)

/** Claimed-vs-recorded observations for one search-capable step. */
export function searchFlags(hadWeb: boolean, claimed: string[], recorded: SourceLink[]): string[] {
  const flags: string[] = []
  if (!hadWeb && claimed.length) flags.push('reported web searches on a step that had no web access')
  if (hadWeb && claimed.length && !recorded.length) flags.push('reported web searches, but no cited pages were recorded')
  if (hadWeb && !claimed.length && recorded.length) flags.push('cited pages without reporting any searches')
  return flags
}

export function buildEpochActivity(input: {
  epoch: Record<string, any>
  toolRuns: Array<Record<string, any>>
  contributions: Array<Record<string, any>>
  spend: Array<Record<string, any>>
}): EpochActivity {
  const { epoch } = input
  const assignments = (epoch.role_assignments ?? {}) as Record<string, string>

  const roles: RoleActivity[] = []
  for (const { role, column, assignKey } of ROLE_FIELDS) {
    const output = epoch[column]
    if (!output || typeof output !== 'object') continue
    const assigned = assignments[assignKey] ?? 'unknown'
    const answered = answeredModel(output, assigned)
    const hadWeb = ROLES_WITH_WEB.has(role)
    const claimed = strings(output.web_searches)
    const recorded = sources(output.web_sources)
    roles.push({
      role, assigned_model: assigned, answered_by: answered, answered_by_name: nameOf(answered),
      fallback: answered !== assigned, had_web_access: hadWeb,
      claimed_searches: claimed, recorded_sources: recorded,
      flags: searchFlags(hadWeb, claimed, recorded),
    })
  }

  const tools: ToolActivity[] = input.toolRuns.map(r => ({
    tool: String(r.tool),
    model: String(r.model ?? ''),
    model_name: nameOf(String(r.model ?? '')),
    request: r.request_summary ? String(r.request_summary).slice(0, 300) : null,
    status: String(r.status),
    exit_code: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
    duration_ms: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    cost_usd: num(r.cost_usd),
    output_tail: r.output_tail ? sanitizeOutput(String(r.output_tail)) : null,
    at: iso(r.created_at),
  }))

  const contributions: ContributionActivity[] = input.contributions.map(c => {
    const claimed = strings(c.web_searches)
    const recorded = sources(c.web_sources)
    const exit = c.sprite_exit_code === null || c.sprite_exit_code === undefined ? null : Number(c.sprite_exit_code)
    const flags = searchFlags(true, claimed, recorded)
    if (c.merged && c.ci_passed !== true) flags.push('merged without a passing CI record')
    return {
      author: String(c.author_name ?? ''),
      branch: String(c.branch ?? ''),
      pr_url: c.pr_url ?? null,
      merged: c.merged === true,
      ci_passed: c.ci_passed ?? null,
      sprite_tests: !c.sprite_ran_at ? 'not run' : exit === 0 ? 'passed' : 'failed',
      explorer_task: c.explorer_task ?? null,
      explorer_claimed_searches: claimed,
      explorer_recorded_sources: recorded,
      flags,
    }
  })

  const spend: SpendByModel[] = input.spend.map(s => ({
    model: String(s.model_id),
    model_name: nameOf(String(s.model_id)),
    purpose: s.purpose ?? null,
    requests: num(s.requests),
    cost_usd: num(s.cost_usd),
    prompt_tokens: num(s.prompt_tokens),
    completion_tokens: num(s.completion_tokens),
  })).sort((a, b) => b.cost_usd - a.cost_usd)

  const fu = epoch.followup && typeof epoch.followup === 'object' ? epoch.followup : null
  const allFlags = [...roles.flatMap(r => r.flags), ...contributions.flatMap(c => c.flags)]
  return {
    epoch_number: Number(epoch.epoch_number),
    started_at: iso(epoch.started_at),
    completed_at: iso(epoch.completed_at),
    follow_up: fu ? {
      status: String(fu.status),
      ...(fu.result ? { pr_url: fu.result.pr_url ?? null, merged: fu.result.merged, ci_passed: fu.result.ci_passed ?? null } : {}),
    } : null,
    roles,
    tools,
    contributions,
    spend,
    totals: {
      cost_usd: Math.round(spend.reduce((s, x) => s + x.cost_usd, 0) * 1e6) / 1e6,
      searches_claimed: roles.reduce((s, r) => s + r.claimed_searches.length, 0) + contributions.reduce((s, c) => s + c.explorer_claimed_searches.length, 0),
      sources_recorded: roles.reduce((s, r) => s + r.recorded_sources.length, 0) + contributions.reduce((s, c) => s + c.explorer_recorded_sources.length, 0),
      flags: allFlags.length,
    },
  }
}
