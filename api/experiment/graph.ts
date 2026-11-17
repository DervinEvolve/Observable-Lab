import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from '@vercel/postgres'
import { neighbourhood, searchGraph } from '../_lib/knowledge-graph.js'
import { loadGraph } from '../_lib/knowledge-graph-store.js'

// GET /api/experiment/graph                    the whole knowledge graph of the run
// GET /api/experiment/graph?q=memory           the best matches and what they link to
// GET /api/experiment/graph?focus=el:cap_x_3   one node and its neighbours (depth 1 to 3)
//
// Public and read-only. Built from the stored epochs and code contributions
// only (api/_lib/knowledge-graph.ts): the same graph the models read as
// memory in each epoch.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const exp = (await sql`
      SELECT id FROM experiments WHERE status <> 'archived' ORDER BY created_at DESC LIMIT 1
    `).rows[0]
    if (!exp) return res.status(404).json({ error: 'No active experiment' })
    const graph = await loadGraph(exp.id)

    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : ''
    const focus = typeof req.query.focus === 'string' ? req.query.focus.slice(0, 160) : ''
    const depth = Math.max(1, Math.min(3, Number(req.query.depth) || 1))
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=60')

    if (q) {
      const hits = searchGraph(graph, q, 12)
      const part = neighbourhood(graph, hits.map(h => h.node.id), depth, 120)
      return res.status(200).json({ experiment_id: exp.id, query: q, matches: hits.map(h => ({ id: h.node.id, score: Math.round(h.score * 10) / 10 })), ...part, clusters: graph.clusters })
    }
    if (focus) {
      if (!graph.nodes.some(n => n.id === focus)) return res.status(404).json({ error: 'No such node' })
      return res.status(200).json({ experiment_id: exp.id, focus, ...neighbourhood(graph, [focus], depth, 120), clusters: graph.clusters })
    }
    return res.status(200).json({ experiment_id: exp.id, epochs: graph.epochs, nodes: graph.nodes, edges: graph.edges, clusters: graph.clusters })
  } catch (error) {
    console.error('[API] Error building the knowledge graph:', error instanceof Error ? error.message : error)
    return res.status(500).json({ error: 'Failed to build the knowledge graph' })
  }
}
