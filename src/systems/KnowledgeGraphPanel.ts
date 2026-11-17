// The knowledge graph: who did what to which part of the agent spec, drawn as
// nodes and lines that visitors can search and walk through. The data comes
// from /api/experiment/graph (api/_lib/knowledge-graph.ts), built only from
// the stored record. The models read the same graph as memory each epoch, and
// agents can query the same endpoint (?q=, ?focus=, &depth=).
//
// The picture starts as one bubble per kind of thing (models, epochs,
// capabilities, constraints, behaviors, conflicts, notes, cited sites, code).
// Clicking a bubble opens it into its nodes; clicking a node shows what it is
// and everything it links to, and clicking one of those walks there.

type NodeType = 'model' | 'epoch' | 'capability' | 'constraint' | 'behavior' | 'conflict' | 'source' | 'note' | 'code'

interface GNode { id: string; type: NodeType; label: string; detail: string; epoch: number | null; degree: number; meta: Record<string, string | number | boolean | null> }
interface GEdge { source: string; target: string; kind: string; epoch: number | null; label: string }
interface GCluster { id: NodeType; label: string; count: number }
interface GraphData { nodes: GNode[]; edges: GEdge[]; clusters: GCluster[]; epochs?: number }

interface Body { id: string; x: number; y: number; vx: number; vy: number; r: number; cluster: NodeType; isCluster: boolean; node?: GNode; count?: number }

const TYPE_COLOR: Record<NodeType, string> = {
  model: '#E8E4D9', epoch: '#B5A642', capability: '#7CB342', constraint: '#64B5F6', behavior: '#FFB74D',
  conflict: '#E57373', note: '#C9B79C', source: '#8FC1FF', code: '#B39DDB',
}
const PROVIDER_COLOR: Record<string, string> = {
  google: '#4285F4', deepseek: '#10A37F', anthropic: '#D97706', openai: '#9C8CF0', 'x-ai': '#1DA1F2', 'z-ai': '#B0BEC5', cohere: '#E91E63',
}
const KIND_TEXT: Record<string, [string, string]> = {
  // [as seen from the source, as seen from the target]
  played: ['played a role in', 'had a role played by'], proposed: ['proposed', 'proposed by'], changed: ['changed', 'changed by'],
  removed: ['removed', 'removed by'], challenged: ['challenged', 'challenged by'], conflicts: ['conflicts with', 'in conflict'],
  found_in: ['found in', 'where it was found'], cites: ['cites', 'cited by'], wrote: ['wrote', 'written by'], noted_in: ['noted in', 'notes'],
  mentions: ['mentions', 'mentioned by'], added_in: ['added in', 'added'], built_in: ['built in', 'code'],
}
const REFRESH_MS = 120_000

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const colorOf = (n: GNode): string => (n.type === 'model' ? PROVIDER_COLOR[String(n.detail).split('/')[0]] ?? TYPE_COLOR.model : TYPE_COLOR[n.type])

export class KnowledgeGraphPanel {
  private overlay: HTMLDivElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private side: HTMLDivElement
  private status: HTMLDivElement
  private search: HTMLInputElement
  private results: HTMLDivElement
  private toggle: HTMLButtonElement

  private data: GraphData | null = null
  private byId = new Map<string, GNode>()
  private bodies = new Map<string, Body>()
  private expanded = new Set<NodeType>()
  private selected: string | null = null
  private hovered: string | null = null
  private matches = new Set<string>()
  private view = { x: 0, y: 0, k: 1 }
  private alpha = 0
  private raf = 0
  private loadedAt = 0
  private isOpen = false
  private drag: { mode: 'pan' | 'node'; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null

  constructor() {
    const style = document.createElement('style')
    style.textContent = `
      #kg-toggle { position: fixed; right: 20px; bottom: 132px; z-index: 150; width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); border: 1px solid rgba(0,0,0,0.1); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 12px rgba(0,0,0,0.1); transition: transform 0.2s ease, box-shadow 0.2s ease; }
      #kg-toggle:hover { transform: scale(1.05); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
      #kg-toggle svg { width: 22px; height: 22px; opacity: 0.65; }
      #kg-toggle:focus-visible, #kg-overlay button:focus-visible, #kg-overlay input:focus-visible { outline: 2px solid #FFB74D; outline-offset: 2px; }
      #kg-overlay { position: fixed; inset: 3vh 3vw; z-index: 1100; display: none; grid-template-columns: 1fr minmax(300px, 380px); background: rgba(18,18,20,0.96); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.1); border-radius: 18px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: #F5F2EB; }
      #kg-overlay.open { display: grid; }
      #kg-overlay .kg-stage { position: relative; min-width: 0; }
      #kg-overlay canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
      #kg-overlay canvas.dragging { cursor: grabbing; }
      #kg-overlay .kg-top { position: absolute; left: 0; top: 0; right: 0; padding: 14px 16px 28px; background: linear-gradient(rgba(18,18,20,0.96) 60%, rgba(18,18,20,0)); display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; pointer-events: none; }
      #kg-overlay .kg-title { font-size: 17px; font-weight: 650; letter-spacing: 0.2px; }
      #kg-overlay .kg-sub { font-size: 12px; color: rgba(245,242,235,0.7); margin-top: 3px; max-width: 560px; line-height: 1.45; }
      #kg-overlay .kg-legend { position: absolute; left: 16px; bottom: 14px; display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; color: rgba(245,242,235,0.8); max-width: calc(100% - 200px); }
      #kg-overlay .kg-legend span { display: inline-flex; align-items: center; gap: 5px; }
      #kg-overlay .kg-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      #kg-overlay .kg-zoom { position: absolute; right: 14px; bottom: 14px; display: flex; gap: 6px; }
      #kg-overlay .kg-zoom button, #kg-overlay .kg-actions button { background: rgba(255,255,255,0.08); color: #F5F2EB; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
      #kg-overlay .kg-zoom button:hover, #kg-overlay .kg-actions button:hover { background: rgba(255,255,255,0.16); }
      #kg-overlay .kg-side { border-left: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; min-height: 0; }
      #kg-overlay .kg-searchbar { padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; gap: 8px; }
      #kg-overlay input { flex: 1; min-width: 0; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; color: #F5F2EB; padding: 9px 11px; font-size: 14px; }
      #kg-overlay input::placeholder { color: rgba(245,242,235,0.5); }
      #kg-overlay .kg-close { background: none; border: none; color: rgba(245,242,235,0.8); font-size: 22px; cursor: pointer; padding: 0 4px; }
      #kg-overlay .kg-scroll { overflow: auto; padding: 4px 14px 16px; flex: 1; }
      #kg-overlay .kg-results button, #kg-overlay .kg-links button { display: block; width: 100%; text-align: left; background: none; border: none; border-radius: 8px; color: #F5F2EB; padding: 7px 8px; font-size: 13px; line-height: 1.35; cursor: pointer; }
      #kg-overlay .kg-results button:hover, #kg-overlay .kg-links button:hover { background: rgba(255,255,255,0.08); }
      #kg-overlay .kg-tag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: rgba(245,242,235,0.6); }
      #kg-overlay .kg-h { font-size: 16px; font-weight: 650; margin: 12px 0 4px; line-height: 1.3; word-break: break-word; }
      #kg-overlay .kg-detail { font-size: 13.5px; line-height: 1.55; color: rgba(245,242,235,0.88); white-space: pre-wrap; word-break: break-word; }
      #kg-overlay .kg-section { margin: 16px 0 4px; font-size: 12px; font-weight: 650; color: rgba(245,242,235,0.7); text-transform: uppercase; letter-spacing: 0.6px; }
      #kg-overlay .kg-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
      #kg-overlay .kg-meta { font-size: 12.5px; color: rgba(245,242,235,0.7); margin-top: 4px; }
      #kg-overlay .kg-empty { font-size: 13px; color: rgba(245,242,235,0.65); line-height: 1.5; padding: 10px 0; }
      #kg-overlay .kg-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
      #kg-overlay a { color: #8FC1FF; }
      @media (max-width: 760px) {
        #kg-overlay { inset: 0; border-radius: 0; grid-template-columns: 1fr; grid-template-rows: 55% 45%; }
        #kg-overlay .kg-side { border-left: none; border-top: 1px solid rgba(255,255,255,0.08); }
        #kg-overlay .kg-legend { display: none; }
      }`
    document.head.appendChild(style)

    this.toggle = document.createElement('button')
    this.toggle.id = 'kg-toggle'
    this.toggle.title = 'Knowledge graph: who did what to which part of the agent'
    this.toggle.setAttribute('aria-label', 'Open the knowledge graph')
    this.toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="2.4"/><circle cx="18" cy="5" r="2.4"/><circle cx="12" cy="13" r="2.8"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7 7.3l3.2 3.9M16.2 6.6l-2.6 4.1M10 15l-3.4 2.6M14.6 14.4l2.7 2.3"/></svg>`
    this.toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()))
    document.body.appendChild(this.toggle)

    this.overlay = document.createElement('div')
    this.overlay.id = 'kg-overlay'
    this.overlay.setAttribute('role', 'dialog')
    this.overlay.setAttribute('aria-label', 'Knowledge graph')
    this.overlay.innerHTML = `
      <div class="kg-stage">
        <canvas aria-label="Graph of models, epochs and the parts of the agent spec, with lines for what happened between them. Use the search and the list on the right to explore it by keyboard."></canvas>
        <div class="kg-top"><div><div class="kg-title">Knowledge graph</div>
          <div class="kg-sub">Who proposed, changed or challenged which part of the agent, the conflicts between parts, the notes the models leave each other and the sites they cited. Built from the stored record only. The models read this same graph as memory each epoch.</div></div></div>
        <div class="kg-legend"></div>
        <div class="kg-zoom"><button data-zin aria-label="Zoom in">+</button><button data-zout aria-label="Zoom out">−</button><button data-fit>Fit</button></div>
      </div>
      <div class="kg-side">
        <div class="kg-searchbar"><input type="search" placeholder="Search: memory, MCP, Claude, epoch 12…" aria-label="Search the knowledge graph"><button class="kg-close" aria-label="Close the knowledge graph">×</button></div>
        <div class="kg-scroll"><div class="kg-results"></div><div class="kg-info"><div class="kg-empty">Loading the graph…</div></div></div>
      </div>`
    document.body.appendChild(this.overlay)

    this.canvas = this.overlay.querySelector('canvas') as HTMLCanvasElement
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D
    this.side = this.overlay.querySelector('.kg-info') as HTMLDivElement
    this.status = this.side
    this.results = this.overlay.querySelector('.kg-results') as HTMLDivElement
    this.search = this.overlay.querySelector('input') as HTMLInputElement

    ;(this.overlay.querySelector('.kg-close') as HTMLButtonElement).addEventListener('click', () => this.close())
    ;(this.overlay.querySelector('[data-zin]') as HTMLButtonElement).addEventListener('click', () => this.zoomBy(1.25))
    ;(this.overlay.querySelector('[data-zout]') as HTMLButtonElement).addEventListener('click', () => this.zoomBy(0.8))
    ;(this.overlay.querySelector('[data-fit]') as HTMLButtonElement).addEventListener('click', () => this.fit())
    let t = 0
    this.search.addEventListener('input', () => { window.clearTimeout(t); t = window.setTimeout(() => this.runSearch(), 180) })
    this.search.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const first = this.results.querySelector('button') as HTMLButtonElement | null; first?.click() }
    })
    document.addEventListener('keydown', e => { if (this.isOpen && e.key === 'Escape') this.close() })
    this.bindCanvas()
    window.addEventListener('resize', () => { if (this.isOpen) { this.resize(); this.draw() } })
  }

  open(): void {
    this.isOpen = true
    this.overlay.classList.add('open')
    this.toggle.setAttribute('aria-expanded', 'true')
    this.resize()
    if (!this.data || Date.now() - this.loadedAt > REFRESH_MS) void this.load()
    else this.kick(0.3)
    this.search.focus()
  }

  close(): void {
    this.isOpen = false
    this.overlay.classList.remove('open')
    this.toggle.setAttribute('aria-expanded', 'false')
    cancelAnimationFrame(this.raf)
    this.toggle.focus()
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/experiment/graph')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as GraphData
      this.data = data
      this.loadedAt = Date.now()
      this.byId = new Map(data.nodes.map(n => [n.id, n]))
      this.legend()
      this.layout(true)
      if (this.selected && this.byId.has(this.selected)) this.showNode(this.selected)
      else this.showOverview()
    } catch (e) {
      this.status.innerHTML = `<div class="kg-empty">The graph could not be loaded (${esc(e instanceof Error ? e.message : String(e))}). It is built from the experiment's stored record, so it appears once epochs have run.</div>`
    }
  }

  private legend(): void {
    const el = this.overlay.querySelector('.kg-legend') as HTMLDivElement
    el.innerHTML = (this.data?.clusters ?? []).map(c => `<span><i style="background:${TYPE_COLOR[c.id]}"></i>${esc(c.label)} ${c.count}</span>`).join('')
  }

  // ---- layout: clusters as anchors on a ring, nodes of open clusters around their anchor ----
  private anchor(type: NodeType): { x: number; y: number } {
    const list = this.data?.clusters ?? []
    const i = Math.max(0, list.findIndex(c => c.id === type))
    const a = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2
    const R = 330
    return { x: Math.cos(a) * R, y: Math.sin(a) * R }
  }

  private layout(reset: boolean): void {
    if (!this.data) return
    const keep = new Set<string>()
    for (const c of this.data.clusters) {
      const p = this.anchor(c.id)
      if (this.expanded.has(c.id)) {
        const members = this.data.nodes.filter(n => n.type === c.id)
        members.forEach((n, i) => {
          keep.add(n.id)
          if (!this.bodies.has(n.id) || reset) {
            const a = (i / members.length) * Math.PI * 2
            const rr = 40 + Math.sqrt(members.length) * 14
            this.bodies.set(n.id, { id: n.id, x: p.x + Math.cos(a) * rr, y: p.y + Math.sin(a) * rr, vx: 0, vy: 0, r: 6 + Math.min(10, Math.sqrt(n.degree) * 2.2), cluster: c.id, isCluster: false, node: n })
          } else {
            const b = this.bodies.get(n.id) as Body
            b.node = n
            b.r = 6 + Math.min(10, Math.sqrt(n.degree) * 2.2)
          }
        })
      } else {
        const id = `cluster:${c.id}`
        keep.add(id)
        const b = this.bodies.get(id)
        if (!b || reset) this.bodies.set(id, { id, x: p.x, y: p.y, vx: 0, vy: 0, r: 22 + Math.sqrt(c.count) * 5, cluster: c.id, isCluster: true, count: c.count })
        else { b.count = c.count; b.r = 22 + Math.sqrt(c.count) * 5 }
      }
    }
    for (const id of [...this.bodies.keys()]) if (!keep.has(id)) this.bodies.delete(id)
    if (reset) this.fit(false)
    this.kick(1)
  }

  /** The body an edge end is drawn at: the node if its cluster is open, else its cluster's bubble. */
  private endOf(id: string): Body | undefined {
    const n = this.byId.get(id)
    if (!n) return undefined
    return this.bodies.get(this.expanded.has(n.type) ? id : `cluster:${n.type}`)
  }

  private kick(a: number): void {
    this.alpha = Math.max(this.alpha, a)
    cancelAnimationFrame(this.raf)
    const step = () => {
      if (!this.isOpen) return
      if (this.alpha > 0.01) this.tick()
      this.draw()
      if (this.alpha > 0.01 || this.drag) this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  private tick(): void {
    if (!this.data) return
    const list = [...this.bodies.values()]
    const a = this.alpha
    // Repulsion between every pair (a few hundred bodies at most).
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i], q = list[j]
        let dx = q.x - p.x, dy = q.y - p.y
        let d2 = dx * dx + dy * dy
        if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02 }
        const min = p.r + q.r + 14
        const f = (900 + (d2 < min * min ? 4000 : 0)) / d2
        const d = Math.sqrt(d2)
        p.vx -= (dx / d) * f * a; p.vy -= (dy / d) * f * a
        q.vx += (dx / d) * f * a; q.vy += (dy / d) * f * a
      }
    }
    // Springs along the edges that are drawn.
    for (const e of this.data.edges) {
      const p = this.endOf(e.source), q = this.endOf(e.target)
      if (!p || !q || p === q || p.isCluster || q.isCluster) continue
      const dx = q.x - p.x, dy = q.y - p.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d - 90) * 0.012 * a
      p.vx += (dx / d) * f; p.vy += (dy / d) * f
      q.vx -= (dx / d) * f; q.vy -= (dy / d) * f
    }
    // Each body is pulled toward its cluster's anchor, so the groups stay readable.
    for (const b of list) {
      const p = this.anchor(b.cluster)
      const k = b.isCluster ? 0.05 : 0.012
      b.vx += (p.x - b.x) * k * a
      b.vy += (p.y - b.y) * k * a
      if (this.drag?.mode === 'node' && this.drag.id === b.id) { b.vx = b.vy = 0; continue }
      b.vx *= 0.82; b.vy *= 0.82
      b.x += b.vx; b.y += b.vy
    }
    this.alpha *= 0.985
  }

  // ---- drawing ----
  private resize(): void {
    const r = this.canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = Math.max(1, Math.round(r.width * dpr))
    this.canvas.height = Math.max(1, Math.round(r.height * dpr))
  }

  private toScreen(x: number, y: number): [number, number] {
    const dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width)
    return [(x * this.view.k + this.view.x) * dpr + this.canvas.width / 2, (y * this.view.k + this.view.y) * dpr + this.canvas.height / 2]
  }

  private toWorld(cx: number, cy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    return [((cx - r.left) - r.width / 2 - this.view.x) / this.view.k, ((cy - r.top) - r.height / 2 - this.view.y) / this.view.k]
  }

  private neighbours(id: string): Set<string> {
    const out = new Set<string>()
    for (const e of this.data?.edges ?? []) {
      if (e.source === id) out.add(e.target)
      if (e.target === id) out.add(e.source)
    }
    return out
  }

  private draw(): void {
    const ctx = this.ctx
    const W = this.canvas.width, H = this.canvas.height
    const dpr = W / Math.max(1, this.canvas.getBoundingClientRect().width)
    ctx.clearRect(0, 0, W, H)
    if (!this.data) return
    const focus = this.hovered ?? this.selected
    const near = focus ? this.neighbours(focus) : null
    const lit = (id: string) => !focus || id === focus || near!.has(id)

    // Edges: one line per pair of drawn ends, heavier when several edges share it.
    const pairs = new Map<string, { p: Body; q: Body; n: number; on: boolean; kind: string }>()
    for (const e of this.data.edges) {
      const p = this.endOf(e.source), q = this.endOf(e.target)
      if (!p || !q || p === q) continue
      const key = p.id < q.id ? `${p.id}|${q.id}` : `${q.id}|${p.id}`
      const on = !focus || ((e.source === focus || e.target === focus) && (lit(e.source) && lit(e.target)))
      const cur = pairs.get(key)
      if (cur) { cur.n++; cur.on ||= on } else pairs.set(key, { p, q, n: 1, on, kind: e.kind })
    }
    for (const { p, q, n, on, kind } of pairs.values()) {
      const [x1, y1] = this.toScreen(p.x, p.y), [x2, y2] = this.toScreen(q.x, q.y)
      ctx.strokeStyle = kind === 'conflicts' ? `rgba(229,115,115,${on ? 0.75 : 0.12})` : `rgba(245,242,235,${on ? (focus ? 0.7 : 0.22) : 0.05})`
      ctx.lineWidth = Math.min(6, 0.8 + Math.log2(n + 1)) * dpr * (on && focus ? 1.3 : 1)
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    }

    // Bodies.
    for (const b of this.bodies.values()) {
      const [x, y] = this.toScreen(b.x, b.y)
      const r = b.r * Math.max(0.6, Math.min(1.6, this.view.k)) * dpr
      const on = b.isCluster ? !focus || [...(near ?? [])].some(id => this.byId.get(id)?.type === b.cluster) || this.byId.get(focus)?.type === b.cluster : lit(b.id)
      const color = b.isCluster ? TYPE_COLOR[b.cluster] : colorOf(b.node as GNode)
      ctx.globalAlpha = on ? 1 : 0.22
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = b.isCluster ? `${color}33` : color
      ctx.fill()
      ctx.lineWidth = (b.id === this.selected ? 3 : this.matches.has(b.id) ? 2.5 : b.isCluster ? 2 : 1) * dpr
      ctx.strokeStyle = b.id === this.selected ? '#FFFFFF' : this.matches.has(b.id) ? '#FFD54F' : b.isCluster ? color : 'rgba(0,0,0,0.5)'
      ctx.stroke()
      if (!b.isCluster && b.node?.type === 'conflict' && b.node.meta.resolved !== true) {
        ctx.fillStyle = '#121214'; ctx.font = `700 ${Math.round(r * 1.1)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('!', x, y + dpr)
      }
      // Labels: always for bubbles; for nodes when zoomed in, highlighted, or well connected.
      const showLabel = b.isCluster
        ? on
        : focus
          ? b.id === focus || near!.has(b.id)
          : this.matches.size ? this.matches.has(b.id) : this.view.k > 1.35 || (b.node?.degree ?? 0) >= 7 || b.node?.type === 'model'
      if (showLabel) {
        const text = b.isCluster ? `${this.data.clusters.find(c => c.id === b.cluster)?.label ?? b.cluster}  ${b.count}` : (b.node?.label ?? '')
        const size = (b.isCluster ? 14 : 12) * dpr
        ctx.font = `${b.isCluster ? 650 : 500} ${size}px Inter, -apple-system, sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        const t = text.length > 42 ? `${text.slice(0, 40)}…` : text
        const w = ctx.measureText(t).width
        ctx.fillStyle = 'rgba(18,18,20,0.78)'
        ctx.fillRect(x - w / 2 - 4 * dpr, y + r + 3 * dpr, w + 8 * dpr, size + 6 * dpr)
        ctx.fillStyle = on ? '#F5F2EB' : 'rgba(245,242,235,0.45)'
        ctx.fillText(t, x, y + r + 6 * dpr)
      }
      ctx.globalAlpha = 1
    }
  }

  // ---- interaction ----
  private hit(cx: number, cy: number): Body | null {
    const [wx, wy] = this.toWorld(cx, cy)
    let best: Body | null = null, bd = Infinity
    for (const b of this.bodies.values()) {
      const r = b.r * Math.max(0.6, Math.min(1.6, this.view.k)) / this.view.k + 4 / this.view.k
      const d = Math.hypot(b.x - wx, b.y - wy)
      if (d < r && d < bd) { best = b; bd = d }
    }
    return best
  }

  private bindCanvas(): void {
    const c = this.canvas
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId)
      const b = this.hit(e.clientX, e.clientY)
      this.drag = b && !b.isCluster
        ? { mode: 'node', id: b.id, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, moved: false }
        : { mode: 'pan', id: b?.id, sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false }
      c.classList.add('dragging')
    })
    c.addEventListener('pointermove', e => {
      if (this.drag) {
        if (Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy) > 4) this.drag.moved = true
        if (this.drag.mode === 'pan') {
          this.view.x = this.drag.vx + (e.clientX - this.drag.sx)
          this.view.y = this.drag.vy + (e.clientY - this.drag.sy)
          this.draw()
        } else if (this.drag.moved && this.drag.id) {
          const b = this.bodies.get(this.drag.id)
          if (b) { const [wx, wy] = this.toWorld(e.clientX, e.clientY); b.x = wx; b.y = wy; this.kick(0.25) }
        }
        return
      }
      const b = this.hit(e.clientX, e.clientY)
      const id = b && !b.isCluster ? b.id : null
      c.style.cursor = b ? 'pointer' : 'grab'
      if (id !== this.hovered) { this.hovered = id; this.draw() }
    })
    c.addEventListener('pointerup', e => {
      const d = this.drag
      this.drag = null
      c.classList.remove('dragging')
      if (d && !d.moved) {
        const b = this.hit(e.clientX, e.clientY)
        if (b?.isCluster) this.expand(b.cluster, true)
        else if (b) this.select(b.id, false)
        else { this.selected = null; this.showOverview(); this.draw() }
      }
    })
    c.addEventListener('pointerleave', () => { if (this.hovered) { this.hovered = null; this.draw() } })
    c.addEventListener('wheel', e => {
      e.preventDefault()
      const f = Math.exp(-e.deltaY * 0.0015)
      const r = c.getBoundingClientRect()
      const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2
      const k = Math.max(0.25, Math.min(4, this.view.k * f))
      this.view.x = mx - ((mx - this.view.x) * k) / this.view.k
      this.view.y = my - ((my - this.view.y) * k) / this.view.k
      this.view.k = k
      this.draw()
    }, { passive: false })
  }

  private zoomBy(f: number): void {
    this.view.k = Math.max(0.25, Math.min(4, this.view.k * f))
    this.view.x *= f; this.view.y *= f
    this.draw()
  }

  private fit(redraw = true): void {
    const list = [...this.bodies.values()]
    if (!list.length) return
    const r = this.canvas.getBoundingClientRect()
    const xs = list.map(b => b.x), ys = list.map(b => b.y)
    const w = Math.max(...xs) - Math.min(...xs) + 160, h = Math.max(...ys) - Math.min(...ys) + 160
    const top = r.width < 760 ? 120 : 110 // the title band
    const bottom = r.width < 760 ? 56 : 64 // the legend and the zoom buttons
    this.view.k = Math.max(0.25, Math.min(1.6, Math.min(r.width / w, (r.height - top - bottom) / h)))
    this.view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * this.view.k
    this.view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * this.view.k + (top - bottom) / 2
    if (redraw) this.draw()
  }

  private centerOn(id: string): void {
    const b = this.bodies.get(id)
    if (!b) return
    this.view.k = Math.max(this.view.k, 1.1)
    this.view.x = -b.x * this.view.k
    this.view.y = -b.y * this.view.k
  }

  private expand(type: NodeType, toggle = false): void {
    if (toggle && this.expanded.has(type)) this.expanded.delete(type)
    else this.expanded.add(type)
    this.layout(false)
    if (!this.selected) this.showOverview()
  }

  /** Select a node: open its cluster and its neighbours' clusters, show what it is, and centre on it. */
  select(id: string, center = true): void {
    const n = this.byId.get(id)
    if (!n) return
    this.selected = id
    let changed = !this.expanded.has(n.type)
    this.expanded.add(n.type)
    for (const m of this.neighbours(id)) {
      const t = this.byId.get(m)?.type
      if (t && !this.expanded.has(t) && this.data!.clusters.find(c => c.id === t)!.count <= 60) { this.expanded.add(t); changed = true }
    }
    if (changed) this.layout(false)
    if (center) { for (let i = 0; i < 60 && changed; i++) this.tick(); this.centerOn(id) }
    this.showNode(id)
    this.kick(0.2)
  }

  // ---- side column ----
  private showOverview(): void {
    if (!this.data) return
    const top = [...this.data.nodes].filter(n => !['epoch', 'model'].includes(n.type)).sort((a, b) => b.degree - a.degree).slice(0, 8)
    this.side.innerHTML = `
      <div class="kg-section">What is in it</div>
      <div class="kg-detail">${this.data.nodes.length} things and ${this.data.edges.length} links from ${this.data.epochs ?? 'the'} epochs. Click a bubble to open it, a dot to see what it links to, or search above.</div>
      <div class="kg-section">Most connected</div>
      <div class="kg-links">${top.map(n => this.linkButton(n.id, `${n.degree} links`)).join('')}</div>
      <div class="kg-section">For agents</div>
      <div class="kg-detail">The same graph as JSON: <a href="/api/experiment/graph" target="_blank" rel="noopener">/api/experiment/graph</a>, with <code>?q=</code> to search and <code>?focus=&lt;id&gt;&amp;depth=2</code> to walk it.</div>`
    this.bindLinks(this.side)
  }

  private linkButton(id: string, note: string): string {
    const n = this.byId.get(id)
    if (!n) return ''
    return `<button data-go="${esc(id)}"><span class="kg-dot" style="background:${colorOf(n)}"></span>${esc(n.label)} <span class="kg-tag">${esc(n.type)}${note ? ` · ${esc(note)}` : ''}</span></button>`
  }

  private bindLinks(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(b => b.addEventListener('click', () => this.select(b.dataset.go as string)))
  }

  private showNode(id: string): void {
    const n = this.byId.get(id)
    if (!n || !this.data) return
    const groups = new Map<string, Array<{ id: string; note: string }>>()
    for (const e of this.data.edges) {
      const out = e.source === id, inn = e.target === id
      if (!out && !inn) continue
      const words = KIND_TEXT[e.kind] ?? [e.kind, e.kind]
      const key = out ? words[0] : words[1]
      const other = out ? e.target : e.source
      const note = [e.label, e.epoch ? `epoch ${e.epoch}` : ''].filter(Boolean).join(', ')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push({ id: other, note })
    }
    const meta: string[] = []
    if (n.epoch) meta.push(`epoch ${n.epoch}`)
    if (typeof n.meta.status === 'string') meta.push(n.meta.status)
    if (n.type === 'conflict') meta.push(n.meta.resolved === true ? 'resolved' : 'open')
    if (typeof n.meta.severity === 'string') meta.push(n.meta.severity)
    if (typeof n.meta.element_id === 'string') meta.push(n.meta.element_id)
    const pr = typeof n.meta.pr_url === 'string' && /^https:\/\/github\.com\//.test(n.meta.pr_url) ? n.meta.pr_url : null
    this.side.innerHTML = `
      <div class="kg-h"><span class="kg-dot" style="background:${colorOf(n)}"></span>${esc(n.label)}</div>
      <div class="kg-tag">${esc(n.type)}</div>
      ${meta.length ? `<div class="kg-meta">${esc(meta.join(' · '))}</div>` : ''}
      ${n.detail && n.type !== 'model' ? `<div class="kg-section">What it says</div><div class="kg-detail">${esc(n.detail)}</div>` : ''}
      ${pr ? `<div class="kg-detail"><a href="${esc(pr)}" target="_blank" rel="noopener">Open the pull request</a></div>` : ''}
      ${[...groups.entries()].map(([k, list]) => `<div class="kg-section">${esc(k)} (${list.length})</div><div class="kg-links">${list.slice(0, 40).map(l => this.linkButton(l.id, l.note)).join('')}</div>`).join('') || '<div class="kg-empty">No links yet.</div>'}
      <div class="kg-actions"><button data-back>Overview</button></div>`
    this.bindLinks(this.side)
    this.side.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    ;(this.side.querySelector('[data-back]') as HTMLButtonElement).addEventListener('click', () => { this.selected = null; this.showOverview(); this.draw() })
  }

  /** Search the loaded graph the way the server does: label and id hits count most. */
  private runSearch(): void {
    const q = this.search.value.trim().toLowerCase()
    this.matches.clear()
    if (!q || !this.data) { this.results.innerHTML = ''; this.draw(); return }
    const terms = q.split(/[^a-z0-9_]+/).filter(w => w.length > 1)
    const hits = this.data.nodes.map(n => {
      const head = `${n.label} ${n.id}`.toLowerCase(), body = n.detail.toLowerCase()
      let s = 0
      for (const t of terms) s += (head.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0)
      return { n, s: s + (s && (head.includes(q) || body.includes(q)) ? 4 : 0) }
    }).filter(h => h.s > 0).sort((a, b) => b.s - a.s || b.n.degree - a.n.degree).slice(0, 12)
    for (const h of hits) { this.matches.add(h.n.id); this.expanded.add(h.n.type) }
    this.layout(false)
    this.results.innerHTML = hits.length
      ? `<div class="kg-section">${hits.length} match${hits.length > 1 ? 'es' : ''}</div><div class="kg-links">${hits.map(h => this.linkButton(h.n.id, h.n.epoch ? `epoch ${h.n.epoch}` : '')).join('')}</div>`
      : '<div class="kg-empty">Nothing matches. Try a part of the agent (memory, browser), a model (Claude, Grok) or a site.</div>'
    this.bindLinks(this.results)
  }
}
