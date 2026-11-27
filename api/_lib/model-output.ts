/**
 * Model output is untyped JSON. These helpers turn it into values the
 * database CHECK constraints accept (conflict severity, mutation type) and
 * the runner can use safely, so one odd answer can't fail a whole epoch.
 */
import type { Challenge, Mutation, ReviewerDecision } from './types.js'

export type Severity = 'critical' | 'warning' | 'note'
export type MutationType = Mutation['type']

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: 'critical', high: 'critical', severe: 'critical', major: 'critical', blocker: 'critical', error: 'critical',
  warning: 'warning', warn: 'warning', medium: 'warning', moderate: 'warning',
  note: 'note', low: 'note', minor: 'note', info: 'note', informational: 'note', nit: 'note',
}

/** Any severity a model writes, clamped to the conflicts table's CHECK set. Unknown values become "warning". */
export function normalizeSeverity(value: unknown): Severity {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return Object.hasOwn(SEVERITY_ALIASES, key) ? SEVERITY_ALIASES[key] : 'warning'
}

const TYPE_ALIASES: Record<string, MutationType> = {
  add: 'add', create: 'add', insert: 'add', new: 'add', append: 'add',
  modify: 'modify', update: 'modify', edit: 'modify', change: 'modify', replace: 'modify', revise: 'modify',
  remove: 'remove', delete: 'remove', prune: 'remove', drop: 'remove',
}

/** The mutations table's CHECK set, or null when the value can't be mapped (the row is skipped). */
export function normalizeMutationType(value: unknown): MutationType | null {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return Object.hasOwn(TYPE_ALIASES, key) ? TYPE_ALIASES[key] : null
}

/** Plain text for a TEXT column, or null. Objects are kept as compact JSON. */
export function textOrNull(value: unknown, max = 4000): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return null
  }
}

/**
 * The executor's mutations with every field in a usable shape. Indexes are
 * kept (reviewer decisions refer to them); an entry whose type can't be
 * mapped keeps type null and is ignored by apply and by the insert.
 */
export function sanitizeMutations(raw: unknown): Array<Omit<Mutation, 'type'> & { type: MutationType | null }> {
  if (!Array.isArray(raw)) return []
  return raw.map(entry => {
    const m = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    const target = (typeof m.target === 'string' ? m.target.trim() : '') as Mutation['target']
    const path = typeof m.path === 'string' ? m.path : ''
    let value: Record<string, unknown>
    if (m.value && typeof m.value === 'object' && !Array.isArray(m.value)) {
      value = m.value as Record<string, unknown>
    } else if (target === 'identity' && typeof m.value === 'string') {
      const field = path.replace(/^identity\.?/, '').trim()
      value = field === 'domain' ? { domain: m.value } : { purpose: m.value }
    } else {
      value = {}
    }
    return {
      type: normalizeMutationType(m.type),
      target,
      path,
      value,
      rationale: typeof m.rationale === 'string' ? m.rationale : '',
    }
  })
}

/** Reviewer decisions that name a real mutation index and a known verdict. */
export function sanitizeDecisions(raw: unknown, mutationCount: number): ReviewerDecision[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  const out: ReviewerDecision[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const d = entry as Record<string, unknown>
    const index = typeof d.mutation_index === 'number' ? d.mutation_index : Number(d.mutation_index)
    if (!Number.isInteger(index) || index < 0 || index >= mutationCount) continue
    if (seen.has(index)) continue
    const verdict = typeof d.verdict === 'string' ? d.verdict.trim().toLowerCase() : ''
    if (verdict !== 'approve' && verdict !== 'reject' && verdict !== 'modify') continue
    seen.add(index)
    const modified = d.modified_value && typeof d.modified_value === 'object' && !Array.isArray(d.modified_value)
      ? (d.modified_value as Record<string, unknown>)
      : undefined
    out.push({
      mutation_index: index,
      verdict,
      reason: textOrNull(d.reason) ?? '',
      ...(modified ? { modified_value: modified } : {}),
      challenger_concern_addressed: d.challenger_concern_addressed === true,
    })
  }
  return out
}

/** A stability score in 0..1. Strings are parsed; anything else keeps `previous`. */
export function clampStability(value: unknown, previous: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  const base = Number.isFinite(n) ? n : previous
  return Math.min(1, Math.max(0, Number.isFinite(base) ? base : 0.5))
}

// ---------------------------------------------------------------------------
// One code contribution per epoch
// ---------------------------------------------------------------------------

// Code can back a capability, a behavior or a constraint; identity and the
// lab's own parameters have nothing to implement.
const TARGET_VALUE: Record<string, number> = { capabilities: 3, behaviors: 2, constraints: 1 }
const TYPE_VALUE: Record<string, number> = { add: 2, modify: 1 }

export interface ContributionCandidate {
  decision: ReviewerDecision
  mutation: Mutation
  score: number
}

/**
 * The single approved mutation most worth turning into code: new
 * capabilities first, then behaviors, then constraints; additions before
 * modifications; a clean approval over a modified one; minus the
 * Challenger's open concerns on it. Ties go to the earlier mutation.
 * Removals, identity and experiment_params never become code.
 */
export function pickContributionCandidate(
  mutations: ReturnType<typeof sanitizeMutations>,
  decisions: ReviewerDecision[],
  challenges: Challenge[] | unknown
): ContributionCandidate | null {
  const concerns = Array.isArray(challenges) ? (challenges as Challenge[]) : []
  let best: ContributionCandidate | null = null
  for (const decision of decisions) {
    if (decision.verdict === 'reject') continue
    const mutation = mutations[decision.mutation_index]
    if (!mutation || !mutation.type) continue
    const target = TARGET_VALUE[mutation.target]
    const type = TYPE_VALUE[mutation.type]
    if (!target || !type) continue
    let score = target * 10 + type * 3 + (decision.verdict === 'approve' ? 1 : 0)
    if (!decision.challenger_concern_addressed) {
      for (const c of concerns) {
        if (!c || c.mutation_index !== decision.mutation_index) continue
        const sev = normalizeSeverity(c.severity)
        score -= sev === 'critical' ? 8 : sev === 'warning' ? 2 : 0
      }
    }
    if (!best || score > best.score || (score === best.score && decision.mutation_index < best.decision.mutation_index)) {
      best = { decision, mutation: mutation as Mutation, score }
    }
  }
  return best
}
