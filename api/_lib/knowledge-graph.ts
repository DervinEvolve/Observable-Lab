/**
 * The lab's knowledge graph: who did what to which part of the agent spec,
 * built only from records the lab already stores (the epochs' role outputs,
 * the spec, code contributions). Nothing here is generated; every node and
 * edge points back at a stored row.
 *
 * Nodes are the things the models work on and with: the models themselves,
 * epochs, the spec's capabilities, constraints and behaviors, conflicts
 * between them, the pages they cited (by site), the notebook notes they left
 * for each other and the code they wrote. Edges are what happened between
 * them: proposed, changed, removed (with the Reviewer's verdict), challenged,
 * conflicts with, cites, wrote, mentions.
 *
 * Two readers: visitors see it as a picture they can search and walk through
 * (src/systems/KnowledgeGraphPanel.ts), and the models use it as memory
 * (memorySummary and recall, added to each epoch's shared context).
 */
import { sanitizeOutput } from './sprites.js'
import { modelDisplayName } from './types.js'

export type NodeType = 'model' | 'epoch' | 'capability' | 'constraint' | 'behavior' | 'conflict' | 'source' | 'note' | 'code'

export interface GraphNode {
  id: string
  type: NodeType
  label: string
  detail: string
  epoch: number | null
  degree: number
  meta: Record<string, string | number | boolean | null>
}

export type EdgeKind =
  | 'played' | 'proposed' | 'changed' | 'removed' | 'challenged' | 'conflicts' | 'found_in'
  | 'cites' | 'wrote' | 'noted_in' | 'mentions' | 'added_in' | 'built_in'

export interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
  epoch: number | null
  label: string
}

export interface GraphCluster { id: NodeType; label: string; count: number }

export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  clusters: GraphCluster[]
  epochs: number
}

export interface EpochRowLike {
  epoch_number: number | string
  role_assignments?: unknown
  planner_output?: unknown
  executor_output?: unknown
  challenger_output?: unknown
  executor_rebuttal?: unknown
  reviewer_output?: unknown
  commentator_output?: unknown
  spec_after?: unknown
}

export interface ContributionRowLike {
  epoch_number: number | string
  model_id?: string | null
  author_name?: string | null
  branch?: string | null
  pr_url?: string | null
  merged?: boolean | null
  ci_passed?: boolean | null
  error?: string | null
}

export const CLUSTER_LABELS: Record<NodeType, string> = {
  model: 'Models', epoch: 'Epochs', capability: 'Capabilities', constraint: 'Constraints', behavior: 'Behaviors',
  conflict: 'Conflicts', source: 'Cited sites', note: 'Notebook notes', code: 'Code',
}
const ORDER: NodeType[] = ['model', 'epoch', 'capability', 'constraint', 'behavior', 'conflict', 'note', 'source', 'code']

const ROLES: Array<{ role: string; column: keyof EpochRowLike; assign: string }> = [
  { role: 'planner', column: 'planner_output', assign: 'planner' },
  { role: 'executor', column: 'executor_output', assign: 'executor' },
  { role: 'challenger', column: 'challenger_output', assign: 'challenger' },
  { role: 'rebuttal', column: 'executor_rebuttal', assign: 'executor' },
  { role: 'reviewer', column: 'reviewer_output', assign: 'reviewer' },
  { role: 'commentator', column: 'commentator_output', assign: 'commentator' },
]

const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return {} } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const clean = (v: unknown, max = 600): string => (typeof v === 'string' ? sanitizeOutput(v).replace(/\s+/g, ' ').trim().slice(0, max) : '')
const ELEMENT_ID = /\b(?:cap|con|beh)_[a-z0-9_]{2,80}\b/g

function elementType(id: string): NodeType | null {
  if (id.startsWith('cap_')) return 'capability'
  if (id.startsWith('con_')) return 'constraint'
  if (id.startsWith('beh_')) return 'behavior'
  return null
}

/** The model that answered a stored output (the fallback when one stepped in). */
function answered(output: Record<string, unknown>, assigned: string): string {
  const s = obj(output.served_by)
  return s.fallback === true && typeof s.model === 'string' && s.model ? s.model : assigned
}

/** A readable name for a spec element id: cap_tool_registry_1 -> "tool registry". */
function prettyId(id: string): string {
  return id.replace(/^(cap|con|beh)_/, '').replace(/_\d+$/, '').replace(/_/g, ' ')
}

/** Which spec element a mutation is about: its value's id, or the id in its path. */
function mutationElement(m: Record<string, unknown>): string | null {
  const value = obj(m.value)
  if (typeof value.id === 'string' && elementType(value.id)) return value.id
  const path = typeof m.path === 'string' ? m.path : ''
  const inPath = path.match(/\[(?:"|')?((?:cap|con|beh)_[a-z0-9_]+)/)
  if (inPath) return inPath[1]
  const anywhere = path.match(ELEMENT_ID)
  return anywhere ? anywhere[0] : null
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

export function buildGraph(input: { epochs: EpochRowLike[]; contributions?: ContributionRowLike[] }): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const edgeKeys = new Set<string>()

  const node = (id: string, type: NodeType, label: string, detail = '', epoch: number | null = null, meta: GraphNode['meta'] = {}): GraphNode => {
    let n = nodes.get(id)
    if (!n) {
      n = { id, type, label: label.slice(0, 120), detail, epoch, degree: 0, meta }
      nodes.set(id, n)
    } else {
      if (detail && detail.length > n.detail.length) n.detail = detail
      Object.assign(n.meta, meta)
    }
    return n
  }
  const edge = (source: string, target: string, kind: EdgeKind, epoch: number | null, label = '') => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return
    const key = `${source}|${target}|${kind}|${epoch ?? ''}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ source, target, kind, epoch, label: label.slice(0, 80) })
  }
  const model = (id: string) => node(`model:${id}`, 'model', modelDisplayName(id) ?? id.split('/').pop() ?? id, id)
  const element = (id: string, epoch: number | null) => {
    const type = elementType(id)
    return type ? node(`el:${id}`, type, prettyId(id), '', epoch, { element_id: id }) : null
  }

  const epochs = [...input.epochs]
    .map(e => ({ ...e, n: Number(e.epoch_number) }))
    .filter(e => Number.isFinite(e.n) && e.n > 0)
    .sort((a, b) => a.n - b.n)

  // The spec as it stands after the latest epoch: every element and conflict, with its text.
  const latest = epochs.length ? obj(epochs[epochs.length - 1].spec_after) : {}
  for (const key of ['capabilities', 'constraints', 'behaviors'] as const) {
    for (const raw of arr(latest[key])) {
      const el = obj(raw)
      if (typeof el.id !== 'string') continue
      const added = Number(el.added_epoch)
      const text = clean(el.description, 500) || clean(Array.isArray(el.interface) ? el.interface.join(' ') : el.interface, 500)
      const n = element(el.id, Number.isFinite(added) ? added : null)
      if (n) {
        n.detail = text
        n.meta.status = typeof el.status === 'string' ? el.status : null
      }
    }
  }

  for (const e of epochs) {
    const ep = node(`epoch:${e.n}`, 'epoch', `Epoch ${e.n}`, '', e.n)
    const assign = obj(e.role_assignments)
    const outputs: Record<string, Record<string, unknown>> = {}
    for (const r of ROLES) {
      const out = obj(e[r.column])
      if (!Object.keys(out).length) continue
      outputs[r.role] = out
      const assigned = typeof assign[r.assign] === 'string' ? (assign[r.assign] as string) : ''
      if (!assigned) continue
      const who = answered(out, assigned)
      const m = model(who)
      if (r.role !== 'rebuttal') edge(m.id, ep.id, 'played', e.n, r.role)

      // Notebook notes: the memory the models leave each other.
      const note = clean(out.notebook, 500)
      if (note) {
        const nn = node(`note:${e.n}:${r.role}`, 'note', `${r.role}'s note, epoch ${e.n}`, note, e.n, { role: r.role, model: who })
        edge(m.id, nn.id, 'wrote', e.n, 'note')
        edge(nn.id, ep.id, 'noted_in', e.n)
        for (const id of new Set(note.match(ELEMENT_ID) ?? [])) {
          const el = element(id, null)
          if (el) edge(nn.id, el.id, 'mentions', e.n)
        }
      }
      // Pages the model was recorded citing, grouped by site.
      for (const s of arr(out.web_sources)) {
        const url = typeof obj(s).url === 'string' ? (obj(s).url as string) : ''
        const domain = /^https?:\/\//i.test(url) ? domainOf(url) : ''
        if (!domain) continue
        const sn = node(`src:${domain}`, 'source', domain, '', e.n)
        const title = clean(obj(s).title, 140)
        if (title && !sn.detail.includes(title) && sn.detail.length < 900) sn.detail = sn.detail ? `${sn.detail} · ${title}` : title
        edge(m.id, sn.id, 'cites', e.n, r.role)
      }
      if (r.role === 'commentator') ep.detail = clean(out.summary, 500) || clean(out.highlight, 500)
    }

    // Mutations, with the Reviewer's verdict on each.
    const executor = outputs.executor ?? {}
    const verdicts = new Map<number, string>()
    for (const d of arr(outputs.reviewer?.decisions)) {
      const dd = obj(d)
      if (typeof dd.mutation_index === 'number' && typeof dd.verdict === 'string') verdicts.set(dd.mutation_index, dd.verdict)
    }
    const executorId = typeof assign.executor === 'string' ? answered(executor, assign.executor as string) : ''
    const touched = new Map<number, string>()
    arr(executor.mutations).forEach((raw, i) => {
      const mu = obj(raw)
      const id = mutationElement(mu)
      if (!id || !executorId) return
      const el = element(id, mu.type === 'add' ? e.n : null)
      if (!el) return
      touched.set(i, el.id)
      const value = obj(mu.value)
      if (!el.detail) el.detail = clean(value.description, 500) || clean(mu.rationale, 500)
      const kind: EdgeKind = mu.type === 'add' ? 'proposed' : mu.type === 'remove' ? 'removed' : 'changed'
      edge(model(executorId).id, el.id, kind, e.n, verdicts.get(i) ?? 'no verdict')
      if (mu.type === 'add') edge(el.id, ep.id, 'added_in', e.n)
    })
    // The Challenger's challenges, against the elements they were about.
    const challengerId = typeof assign.challenger === 'string' && outputs.challenger ? answered(outputs.challenger, assign.challenger as string) : ''
    for (const c of arr(outputs.challenger?.challenges)) {
      const cc = obj(c)
      const target = typeof cc.mutation_index === 'number' ? touched.get(cc.mutation_index) : undefined
      if (target && challengerId) edge(model(challengerId).id, target, 'challenged', e.n, typeof cc.severity === 'string' ? cc.severity : '')
    }
  }

  // Conflicts between elements, as the spec records them.
  for (const raw of arr(latest.conflicts)) {
    const c = obj(raw)
    if (typeof c.id !== 'string') continue
    const found = Number(c.id.match(/^conflict_(\d+)_/)?.[1])
    const cn = node(`conflict:${c.id}`, 'conflict', clean(c.description, 90) || c.id, clean(c.description, 600),
      Number.isFinite(found) ? found : null, { resolved: c.resolved === true, severity: typeof c.severity === 'string' ? c.severity : null })
    for (const side of [c.element_a, c.element_b]) {
      const id = typeof side === 'string' ? side.match(ELEMENT_ID)?.[0] : undefined
      const el = id ? element(id, null) : null
      if (el) edge(cn.id, el.id, 'conflicts', cn.epoch, c.resolved === true ? 'resolved' : 'open')
    }
    if (cn.epoch !== null && nodes.has(`epoch:${cn.epoch}`)) edge(cn.id, `epoch:${cn.epoch}`, 'found_in', cn.epoch)
  }

  // Elements that name other elements in their own text.
  for (const n of [...nodes.values()]) {
    if (!['capability', 'constraint', 'behavior'].includes(n.type)) continue
    for (const id of new Set(n.detail.match(ELEMENT_ID) ?? [])) {
      if (id !== n.meta.element_id && nodes.has(`el:${id}`)) edge(n.id, `el:${id}`, 'mentions', null)
    }
  }

  // Code the models wrote for the specimen repo.
  for (const c of input.contributions ?? []) {
    const n = Number(c.epoch_number)
    if (!Number.isFinite(n) || !c.branch) continue
    const status = c.merged ? 'merged' : c.pr_url ? (c.ci_passed === false ? 'CI failed' : 'not merged') : 'no pull request'
    const why = clean(c.error ?? '', 300)
    const detail = `Code for the AI-Agent repo, epoch ${n}${c.author_name ? `, by ${c.author_name}` : ''}: ${c.merged ? 'merged into main' : c.pr_url ? `pull request ${c.pr_url}, not merged${c.ci_passed === false ? ' (CI failed)' : ''}` : 'no pull request was opened'}.${why ? ` Why: ${why}` : ''}`
    const cn = node(`code:${n}:${c.branch}`, 'code', `${c.branch} (${status})`, detail, n,
      { merged: c.merged === true, pr_url: c.pr_url ?? null, author: c.author_name ?? null })
    if (c.model_id) edge(model(c.model_id).id, cn.id, 'wrote', n, 'code')
    if (nodes.has(`epoch:${n}`)) edge(cn.id, `epoch:${n}`, 'built_in', n)
  }

  for (const ed of edges) {
    nodes.get(ed.source)!.degree++
    nodes.get(ed.target)!.degree++
  }
  const list = [...nodes.values()].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || b.degree - a.degree || a.id.localeCompare(b.id))
  const clusters = ORDER.map(t => ({ id: t, label: CLUSTER_LABELS[t], count: list.filter(n => n.type === t).length })).filter(c => c.count > 0)
  return { nodes: list, edges, clusters, epochs: epochs.length }
}

// Words that say nothing about what is being looked for.
const COMMON = new Set(['the', 'in', 'on', 'of', 'to', 'and', 'or', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'any', 'did', 'do', 'does', 'what', 'which', 'who', 'how', 'why', 'when', 'where', 'still', 'by', 'it', 'its', 'for', 'with', 'from', 'that', 'this', 'actually', 'about', 'we', 'our', 'us', 'there', 'yet', 'ever', 'so', 'far'])
const words = (q: string): string[] => q.toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length > 1 && !COMMON.has(w))

/** Nodes that match a query, best first: label and id hits count three times a hit in the text. */
export function searchGraph(g: KnowledgeGraph, q: string, limit = 12): Array<{ node: GraphNode; score: number }> {
  const terms = words(q)
  if (!terms.length) return []
  const phrase = q.toLowerCase().trim()
  const codeQuestion = /\b(merg\w*|pull requests?|prs?|ci|branch\w*|commit\w*|repo\w*|landed)\b/.test(phrase)
  const hits: Array<{ node: GraphNode; score: number }> = []
  for (const n of g.nodes) {
    const head = `${n.label} ${n.id}`.toLowerCase()
    const body = n.detail.toLowerCase()
    let score = 0
    let all = true
    for (const t of terms) {
      const h = head.includes(t) ? 3 : 0
      const b = body.includes(t) ? 1 : 0
      if (!h && !b) all = false
      score += h + b
    }
    if (!score) continue
    if (all) score += terms.length
    if (phrase.length > 3 && (head.includes(phrase) || body.includes(phrase))) score += 4
    // A question about merges, pull requests, CI or the repo is about the code records: those first, newest first.
    if (codeQuestion && n.type === 'code') score += 6 + (n.epoch ?? 0) / 1000
    hits.push({ node: n, score: score + Math.min(2, n.degree / 10) })
  }
  return hits.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, limit)
}

/** The nodes within `depth` steps of the seeds (seeds first), and the edges among them. */
export function neighbourhood(g: KnowledgeGraph, seeds: string[], depth = 1, maxNodes = 80): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  const keep = new Set<string>(seeds.filter(s => byId.has(s)))
  let frontier = [...keep]
  for (let d = 0; d < depth && frontier.length && keep.size < maxNodes; d++) {
    const next: string[] = []
    for (const e of g.edges) {
      for (const [a, b] of [[e.source, e.target], [e.target, e.source]] as const) {
        if (frontier.includes(a) && !keep.has(b) && keep.size < maxNodes) {
          keep.add(b)
          next.push(b)
        }
      }
    }
    frontier = next
  }
  return {
    nodes: [...keep].map(id => byId.get(id)!),
    edges: g.edges.filter(e => keep.has(e.source) && keep.has(e.target)),
  }
}

const KIND_TEXT: Record<EdgeKind, string> = {
  played: 'played', proposed: 'proposed', changed: 'changed', removed: 'removed', challenged: 'challenged',
  conflicts: 'conflicts with', found_in: 'found in', cites: 'cites', wrote: 'wrote', noted_in: 'noted in',
  mentions: 'mentions', added_in: 'added in', built_in: 'built in',
}

function linksOf(g: KnowledgeGraph, id: string, max: number): string[] {
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  const out: string[] = []
  for (const e of g.edges) {
    if (out.length >= max) break
    const name = (n?: GraphNode) => (n ? (n.meta.element_id as string | undefined) ?? n.label.slice(0, 60) : '?')
    if (e.source === id) out.push(`${KIND_TEXT[e.kind]} ${name(byId.get(e.target))}${e.label ? ` (${e.label})` : ''}${e.epoch ? ` e${e.epoch}` : ''}`)
    else if (e.target === id) out.push(`${name(byId.get(e.source))} ${KIND_TEXT[e.kind]} it${e.label ? ` (${e.label})` : ''}${e.epoch ? ` e${e.epoch}` : ''}`)
  }
  return out
}

/** A compact answer to one recall question, for a model's prompt. */
export function recall(g: KnowledgeGraph, q: string, limit = 4): string {
  const hits = searchGraph(g, q, limit)
  if (!hits.length) return `  (nothing in the lab's record matches "${q.slice(0, 80)}")`
  return hits.map(({ node: n }) => {
    const where = n.epoch ? `, e${n.epoch}` : ''
    const links = linksOf(g, n.id, 4)
    return `  - [${n.type}${where}] ${n.label}${n.meta.element_id ? ` (${n.meta.element_id})` : ''}: ${n.detail.slice(0, 220)}${links.length ? `\n    links: ${links.join('; ')}` : ''}`
  }).join('\n')
}

/** The few lines of memory every role gets each epoch: the most connected elements, who changed what lately, open conflicts. */
export function memorySummary(g: KnowledgeGraph, latestEpoch: number): string {
  const elements = g.nodes.filter(n => n.type === 'capability' || n.type === 'constraint' || n.type === 'behavior')
  if (!elements.length) return ''
  const hubs = [...elements].sort((a, b) => b.degree - a.degree).slice(0, 6)
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  const recent = g.edges
    .filter(e => ['proposed', 'changed', 'removed'].includes(e.kind) && e.epoch !== null && e.epoch > latestEpoch - 3)
    .slice(-8)
    .map(e => `e${e.epoch}: ${byId.get(e.source)?.label} ${KIND_TEXT[e.kind]} ${byId.get(e.target)?.meta.element_id ?? byId.get(e.target)?.label} (${e.label})`)
  const open = g.nodes.filter(n => n.type === 'conflict' && n.meta.resolved !== true).slice(0, 5)
  const code = g.nodes.filter(n => n.type === 'code')
  const merged = code.filter(n => n.meta.merged === true).length
  const prs = code.filter(n => typeof n.meta.pr_url === 'string' && n.meta.pr_url).length
  const lastWhy = [...code].sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0)).find(n => n.meta.merged !== true && n.detail.includes(' Why: '))
  const codeLine = code.length
    ? `Code for the AI-Agent repo: ${code.length} attempts, ${prs} opened a pull request, ${merged} merged.${lastWhy ? ` Latest failure (e${lastWhy.epoch}): ${lastWhy.detail.split(' Why: ')[1].slice(0, 200)}` : ''}`
    : ''
  return [
    'Most connected parts of the spec: ' + hubs.map(h => `${h.meta.element_id} (${h.degree} links)`).join(', ') + '.',
    recent.length ? 'Recent changes:\n' + recent.map(r => `- ${r}`).join('\n') : '',
    open.length ? 'Open conflicts:\n' + open.map(c => `- ${c.detail.slice(0, 200)}`).join('\n') : '',
    codeLine,
  ].filter(Boolean).join('\n')
}

/** The recall questions a role asked in its output: up to three short strings. */
export function recallQuestions(output: unknown): string[] {
  const r = obj(output).recall
  const list = Array.isArray(r) ? r : typeof r === 'string' ? [r] : []
  return list.filter((q): q is string => typeof q === 'string' && q.trim().length > 1).map(q => q.replace(/\s+/g, ' ').trim().slice(0, 120)).slice(0, 3)
}
