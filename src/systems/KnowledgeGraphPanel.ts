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

type NodeType = 'model' | 'epoch' | 'capability' | 'constraint' | 'behavior' | 'conflict' | 'source' | 'note' | 'code' | 'turn'

interface GNode { id: string; type: NodeType; label: string; detail: string; epoch: number | null; degree: number; meta: Record<string, string | number | boolean | null> }
interface GEdge { source: string; target: string; kind: string; epoch: number | null; label: string }
interface GCluster { id: NodeType; label: string; count: number }
interface Recall { epoch: number; model: string; model_name: string; role: string; question: string; hits: string[] }
interface GraphData { nodes: GNode[]; edges: GEdge[]; clusters: GCluster[]; epochs?: number; recalls?: Recall[] }

interface Body { id: string; x: number; y: number; vx: number; vy: number; r: number; cluster: NodeType; isCluster: boolean; node?: GNode; count?: number }

const TYPE_COLOR: Record<NodeType, string> = {
  model: '#E8E4D9', epoch: '#B5A642', capability: '#7CB342', constraint: '#64B5F6', behavior: '#FFB74D',
  conflict: '#E57373', note: '#C9B79C', source: '#8FC1FF', code: '#B39DDB', turn: '#78C8FF',
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
  said: ['said', 'said by'], said_in: ['said in', 'what was said'],
}
import { PROVIDER_LOGOS } from '../shared/types'

const REFRESH_MS = 120_000
const HOP_MS = 750 // one hop of a recall replay
// The credited provider logos the room already ships (public/logos, sources in docs/PROVIDER_LOGO_SOURCES.json).
const LOGO_SRC = PROVIDER_LOGOS as Record<string, string>
const labOf = (n: GNode): string => String(n.detail).split('/')[0]
// Words that say nothing about what is being looked for (the server's search drops the same).
const COMMON = new Set(['the', 'in', 'on', 'of', 'to', 'and', 'or', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'any', 'did', 'do', 'does', 'what', 'which', 'who', 'how', 'why', 'when', 'where', 'still', 'by', 'it', 'its', 'for', 'with', 'from', 'that', 'this', 'actually', 'about', 'we', 'our', 'us', 'there', 'yet', 'ever', 'so', 'far'])

const ABOUT = 'Who proposed, changed or challenged which part of the agent, the conflicts between parts, the notes the models leave each other and the sites they cited. Built from the stored record only. The models read this same graph as memory each epoch.'

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const colorOf = (n: GNode): string => (n.type === 'model' ? PROVIDER_COLOR[String(n.detail).split('/')[0]] ?? TYPE_COLOR.model : TYPE_COLOR[n.type])

/** Layouts, shared by the stylesheet and the code that frames the graph. */
const STACKED = '(max-width: 760px), (max-width: 1000px) and (orientation: portrait)' // graph on top, list below
const SHORT = '(max-height: 500px) and (min-width: 520px)' // a phone on its side: graph and list side by side, full screen
const COMPACT = `(max-width: 760px), (max-width: 1000px) and (orientation: landscape), ${SHORT}` // a small graph area
/** The arrangement for a small graph area, as CSS for the overlay selected by `o`. */
const compactCss = (o: string, captionWidth: string): string => `
        ${o} .kg-legend, ${o} .kg-sub { display: none; }
        ${o} .kg-about { display: block; }
        ${o} .kg-kinds { display: flex; }
        ${o} .kg-top { padding-top: 12px; padding-bottom: 22px; }
        ${o} .kg-zoom { right: 10px; bottom: 10px; }
        ${o} .kg-searchbar { padding: 10px 12px; }
        /* No room for a title and a caption: while a recall replays, its caption takes the title's place. */
        ${o}.replaying .kg-top { display: none; }
        ${o} .kg-caption { align-self: flex-start; margin: 8px 0 0 12px; max-width: ${captionWidth}; padding: 7px 10px; font-size: 0.78125rem; line-height: 1.4; overflow: hidden; }
        ${o} .kg-caption span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }`
const MIN_K = 0.1
const MAX_K = 4

interface Box { x0: number; y0: number; x1: number; y1: number }
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
/** A bubble or an open cluster's area as drawn; `own` is the cluster it belongs to. */
interface Disc { x: number; y: number; r: number; own: NodeType }
const touches = (b: Box, d: Disc): boolean => {
  const nx = Math.max(b.x0, Math.min(d.x, b.x1)), ny = Math.max(b.y0, Math.min(d.y, b.y1))
  return (nx - d.x) ** 2 + (ny - d.y) ** 2 < d.r * d.r
}
/** Where the i-th of a few large nodes sits: one in the middle, then rings of six, twelve, … one step apart. */
const hexSpot = (i: number, step: number): { x: number; y: number } => {
  if (i === 0) return { x: 0, y: 0 }
  let ring = 1, first = 1
  while (i >= first + 6 * ring) { first += 6 * ring; ring++ }
  const j = i - first, side = Math.floor(j / ring), along = (j % ring) / ring
  const corner = (c: number) => ({ x: Math.cos(-Math.PI / 2 + c * Math.PI / 3) * ring * step, y: Math.sin(-Math.PI / 2 + c * Math.PI / 3) * ring * step })
  const a = corner(side), b = corner(side + 1)
  return { x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along }
}
const hexRings = (count: number): number => { let ring = 0, held = 1; while (held < count) { ring++; held += 6 * ring } return ring }
const MODEL_R = 13 // a model's logo disc, in CSS px at the fitted view (26 px across)

export class KnowledgeGraphPanel {
  private overlay: HTMLDivElement
  private stage: HTMLDivElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private side: HTMLDivElement
  private scroller: HTMLDivElement
  private status: HTMLDivElement
  private search: HTMLInputElement
  private results: HTMLDivElement
  private toggle: HTMLButtonElement
  private closeBtn: HTMLButtonElement

  private data: GraphData | null = null
  private byId = new Map<string, GNode>()
  private bodies = new Map<string, Body>()
  private expanded = new Set<NodeType>()
  private selected: string | null = null
  private hovered: string | null = null
  private matches = new Set<string>()
  private topMatches = new Set<string>() // the best few, the only matches labelled on the canvas
  private view = { x: 0, y: 0, k: 1 }
  private raf = 0
  private loadedAt = 0
  private isOpen = false
  // The recall replay: the path a model's question took through the graph, walked one hop at a time.
  private anim: { path: string[]; start: number; queue: Recall[] } | null = null
  private caption: HTMLDivElement
  // One finger (or the mouse) pans or drags a node; two fingers pinch. Every pointer that is down is in `pointers`.
  private pointers = new Map<number, { x: number; y: number }>()
  private drag: { mode: 'pan' | 'node'; pointer: number; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean; slop: number } | null = null
  private pinch: { a: number; b: number; d0: number; k0: number; wx: number; wy: number } | null = null
  // Everything open() sets up outside the panel's own elements; close() undoes all of it.
  private session: Array<() => void> = []
  private searchTimer = 0
  private openedBy = ''
  // The canvas in CSS pixels, what lies over it (title, caption, buttons, legend), and the room left for the graph.
  private size = { w: 0, h: 0, dpr: 1 }
  private blocked: Box[] = []
  private band = { top: 0, bottom: 0 }
  private tight = false // too little room for the desktop arrangement: the ring flattens to fit and labels shrink
  private coarse = false
  private fontScale = 1
  private framedFor = ''

  constructor() {
    const style = document.createElement('style')
    style.textContent = `
      #kg-toggle { position: fixed; right: 20px; bottom: 132px; z-index: 150; width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); border: 1px solid rgba(0,0,0,0.1); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 12px rgba(0,0,0,0.1); transition: transform 0.2s ease, box-shadow 0.2s ease; touch-action: manipulation; }
      #kg-toggle:hover { transform: scale(1.05); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
      #kg-toggle svg { width: 22px; height: 22px; opacity: 0.65; }
      #kg-toggle:focus-visible, #kg-overlay button:focus-visible, #kg-overlay input:focus-visible { outline: 2px solid #FFB74D; outline-offset: 2px; }
      #kg-overlay { position: fixed; inset: 3vh 3vw; z-index: 1100; display: none; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); grid-template-rows: minmax(0, 1fr); background: rgba(18,18,20,0.96); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.1); border-radius: 18px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: #F5F2EB; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
      #kg-overlay.open { display: grid; }
      #kg-overlay:focus { outline: none; }
      #kg-overlay .kg-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
      #kg-overlay canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
      #kg-overlay canvas.dragging { cursor: grabbing; }
      #kg-overlay .kg-head { position: absolute; left: 0; top: 0; right: 0; display: flex; flex-direction: column; align-items: center; pointer-events: none; }
      #kg-overlay .kg-top { align-self: stretch; padding: 14px 16px 28px; background: linear-gradient(rgba(18,18,20,0.96) 60%, rgba(18,18,20,0)); display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
      #kg-overlay .kg-title { font-size: 1.0625rem; font-weight: 650; letter-spacing: 0.2px; }
      #kg-overlay .kg-sub { font-size: 0.75rem; color: rgba(245,242,235,0.7); margin-top: 3px; max-width: 560px; line-height: 1.45; }
      #kg-overlay .kg-legend { position: absolute; left: 16px; bottom: 14px; display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 0.75rem; color: rgba(245,242,235,0.8); max-width: calc(100% - 200px); pointer-events: none; }
      #kg-overlay .kg-legend span { display: inline-flex; align-items: center; gap: 5px; }
      #kg-overlay .kg-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      #kg-overlay .kg-zoom { position: absolute; right: 14px; bottom: 14px; display: flex; gap: 6px; }
      #kg-overlay .kg-zoom button, #kg-overlay .kg-actions button { background: rgba(255,255,255,0.08); color: #F5F2EB; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; padding: 6px 10px; font-size: 0.8125rem; cursor: pointer; }
      #kg-overlay .kg-zoom button:hover, #kg-overlay .kg-actions button:hover { background: rgba(255,255,255,0.16); }
      #kg-overlay .kg-side { border-left: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      #kg-overlay .kg-searchbar { padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; gap: 8px; }
      #kg-overlay input { flex: 1; min-width: 0; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; color: #F5F2EB; padding: 9px 11px; font-size: 0.875rem; }
      #kg-overlay input::placeholder { color: rgba(245,242,235,0.5); }
      #kg-overlay .kg-close { background: none; border: none; color: rgba(245,242,235,0.8); font-size: 1.375rem; cursor: pointer; padding: 0 4px; }
      #kg-overlay .kg-scroll { overflow: auto; overscroll-behavior: contain; padding: 4px 14px 16px; flex: 1; min-height: 0; }
      #kg-overlay .kg-results button, #kg-overlay .kg-links button { display: block; width: 100%; text-align: left; background: none; border: none; border-radius: 8px; color: #F5F2EB; padding: 7px 8px; font-size: 0.8125rem; line-height: 1.35; cursor: pointer; overflow-wrap: anywhere; }
      #kg-overlay .kg-results button:hover, #kg-overlay .kg-links button:hover { background: rgba(255,255,255,0.08); }
      #kg-overlay .kg-tag { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.6px; color: rgba(245,242,235,0.6); }
      #kg-overlay .kg-h { font-size: 1rem; font-weight: 650; margin: 12px 0 4px; line-height: 1.3; word-break: break-word; }
      #kg-overlay .kg-detail { font-size: 0.84375rem; line-height: 1.55; color: rgba(245,242,235,0.88); white-space: pre-wrap; word-break: break-word; }
      #kg-overlay .kg-section { margin: 16px 0 4px; font-size: 0.75rem; font-weight: 650; color: rgba(245,242,235,0.7); text-transform: uppercase; letter-spacing: 0.6px; overflow-wrap: anywhere; }
      #kg-overlay .kg-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
      #kg-overlay .kg-meta { font-size: 0.78125rem; color: rgba(245,242,235,0.7); margin-top: 4px; overflow-wrap: anywhere; }
      #kg-overlay .kg-empty { font-size: 0.8125rem; color: rgba(245,242,235,0.65); line-height: 1.5; padding: 10px 0; }
      #kg-overlay .kg-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
      #kg-overlay a { color: #8FC1FF; }
      #kg-overlay .kg-caption { margin-top: 1px; max-width: min(640px, max(50%, min(100% - 24px, 360px))); background: rgba(10,12,16,0.9); border: 1px solid rgba(255,213,79,0.45); border-radius: 12px; padding: 9px 13px; font-size: 0.84375rem; line-height: 1.45; color: #F5F2EB; display: none; overflow-wrap: anywhere; }
      #kg-overlay .kg-caption.show { display: block; }
      #kg-overlay .kg-caption b { color: #FFD54F; font-weight: 650; }
      #kg-overlay .kg-recall { display: flex; gap: 8px; align-items: flex-start; }
      #kg-overlay .kg-recall button.kg-play { flex: 0 0 auto; background: rgba(255,213,79,0.14); border: 1px solid rgba(255,213,79,0.45); color: #FFD54F; border-radius: 8px; padding: 4px 8px; font-size: 0.75rem; cursor: pointer; }
      #kg-overlay .kg-recall .kg-q { font-size: 0.8125rem; line-height: 1.4; min-width: 0; overflow-wrap: anywhere; }
      #kg-overlay .kg-js { background: rgba(120,200,255,0.12); border: 1px solid rgba(120,200,255,0.45); color: #78C8FF; border-radius: 8px; padding: 6px 10px; font-size: 0.8125rem; cursor: pointer; margin-top: 10px; }
      /* Shown where the title band has no room for the subtitle and the legend is hidden (phones). */
      #kg-overlay .kg-about, #kg-overlay .kg-kinds { display: none; margin-top: 8px; }
      #kg-overlay .kg-kinds { flex-wrap: wrap; gap: 6px; }
      #kg-overlay .kg-kinds button { display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; border-radius: 22px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); color: #F5F2EB; font-size: 0.8125rem; cursor: pointer; }
      #kg-overlay .kg-kinds button[aria-pressed="true"] { background: rgba(255,255,255,0.18); }
      /* Fingers need 44 px to land on, and a 16 px field so iOS does not zoom the page on focus. */
      @media (pointer: coarse) {
        #kg-overlay .kg-zoom button, #kg-overlay .kg-actions button, #kg-overlay .kg-js, #kg-overlay .kg-recall button.kg-play, #kg-overlay .kg-close { min-width: 44px; min-height: 44px; }
        #kg-overlay .kg-results button, #kg-overlay .kg-links button, #kg-overlay .kg-kinds button { min-height: 44px; }
        #kg-overlay input { min-height: 44px; font-size: 1rem; }
        #kg-overlay .kg-recall { margin-top: 6px; }
      }
      /* Full screen, sized to what is visible: the on-screen keyboard and the browser's bars shrink it. */
      @media ${STACKED}, ${SHORT} {
        #kg-overlay { inset: auto; left: 0; right: 0; top: var(--kg-vt, 0px); height: 100vh; height: var(--kg-vh, 100dvh); border: none; border-radius: 0; background: #121214; backdrop-filter: none; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
      }
      @media ${STACKED} {
        #kg-overlay { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 11fr) minmax(0, 9fr); }
        #kg-overlay .kg-side { border-left: none; border-top: 1px solid rgba(255,255,255,0.08); }
        #kg-overlay .kg-close { position: absolute; z-index: 2; top: calc(env(safe-area-inset-top) + 4px); right: calc(env(safe-area-inset-right) + 4px); min-width: 44px; min-height: 44px; }
        #kg-overlay .kg-top { padding-right: 56px; }
        #kg-overlay .kg-caption { max-width: calc(100% - 24px); }
      }
      /* A small graph area: the subtitle and the legend move into the list, and the title band stays one line. */
      @media ${COMPACT} { ${compactCss('#kg-overlay', 'calc(100% - 24px)')} }
      /* The same where the text is so large that the title and legend leave the graph no room (set in measure()). */
      ${compactCss('#kg-overlay.cramped', 'calc(100% - 72px)')}
      @media (max-width: 760px) {
        #kg-overlay .kg-top { padding-right: 56px; }
        #kg-overlay .kg-caption { max-width: calc(100% - 72px); }
      }
      @media ${SHORT} {
        #kg-overlay { grid-template-columns: minmax(0, 1fr) minmax(260px, 40%); grid-template-rows: minmax(0, 1fr); }
        #kg-overlay .kg-side { border-top: none; border-left: 1px solid rgba(255,255,255,0.08); }
        #kg-overlay .kg-close { position: static; }
        #kg-overlay .kg-top { padding-right: 16px; }
        #kg-overlay .kg-caption { max-width: calc(100% - 24px); }
      }
      /* With the keyboard up there is little height left: give it to the graph and the results. */
      @media (max-height: 420px) and (max-width: 519px) {
        #kg-overlay { grid-template-rows: minmax(0, 2fr) minmax(0, 3fr); }
        #kg-overlay .kg-top, #kg-overlay .kg-zoom { display: none; }
      }
      @media (max-height: 260px) and (min-width: 520px) {
        #kg-overlay .kg-top { display: none; }
        #kg-overlay .kg-searchbar { padding: 4px 10px; }
        #kg-overlay .kg-scroll { padding-top: 0; }
        #kg-overlay .kg-results .kg-section { margin-top: 4px; }
        #kg-overlay .kg-results button { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      }`
    document.head.appendChild(style)

    this.toggle = document.createElement('button')
    this.toggle.id = 'kg-toggle'
    this.toggle.title = 'Knowledge graph: who did what to which part of the agent'
    this.toggle.setAttribute('aria-label', 'Open the knowledge graph')
    this.toggle.setAttribute('aria-haspopup', 'dialog')
    this.toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="2.4"/><circle cx="18" cy="5" r="2.4"/><circle cx="12" cy="13" r="2.8"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7 7.3l3.2 3.9M16.2 6.6l-2.6 4.1M10 15l-3.4 2.6M14.6 14.4l2.7 2.3"/></svg>`
    // A finger that opens the panel must not raise the keyboard, so remember what pressed the button.
    this.toggle.addEventListener('pointerdown', e => { this.openedBy = e.pointerType })
    this.toggle.addEventListener('click', () => { if (this.isOpen) this.close(); else this.open(); this.openedBy = '' })
    document.body.appendChild(this.toggle)

    this.overlay = document.createElement('div')
    this.overlay.id = 'kg-overlay'
    this.overlay.setAttribute('role', 'dialog')
    this.overlay.setAttribute('aria-modal', 'true')
    this.overlay.setAttribute('aria-label', 'Knowledge graph')
    this.overlay.tabIndex = -1
    this.overlay.innerHTML = `
      <div class="kg-stage">
        <canvas aria-label="Graph of models, epochs and the parts of the agent spec, with lines for what happened between them. Use the search and the list on the right to explore it by keyboard."></canvas>
        <div class="kg-head">
          <div class="kg-top"><div class="kg-headtext"><div class="kg-title">Knowledge graph</div>
            <div class="kg-sub">${ABOUT}</div></div></div>
          <div class="kg-caption" aria-live="polite"></div>
        </div>
        <div class="kg-legend"></div>
        <div class="kg-zoom"><button data-zin aria-label="Zoom in">+</button><button data-zout aria-label="Zoom out">−</button><button data-fit>Fit</button></div>
      </div>
      <div class="kg-side">
        <div class="kg-searchbar"><input type="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Search: memory, MCP, Claude, epoch 12…" aria-label="Search the knowledge graph"><button class="kg-close" aria-label="Close the knowledge graph">×</button></div>
        <div class="kg-scroll"><div class="kg-results"></div><div class="kg-info"><div class="kg-empty">Loading the graph…</div></div></div>
      </div>`
    document.body.appendChild(this.overlay)

    this.stage = this.overlay.querySelector('.kg-stage') as HTMLDivElement
    this.canvas = this.overlay.querySelector('canvas') as HTMLCanvasElement
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D
    this.side = this.overlay.querySelector('.kg-info') as HTMLDivElement
    this.scroller = this.overlay.querySelector('.kg-scroll') as HTMLDivElement
    this.status = this.side
    this.results = this.overlay.querySelector('.kg-results') as HTMLDivElement
    this.search = this.overlay.querySelector('input') as HTMLInputElement
    this.caption = this.overlay.querySelector('.kg-caption') as HTMLDivElement
    this.closeBtn = this.overlay.querySelector('.kg-close') as HTMLButtonElement

    this.closeBtn.addEventListener('click', () => this.close())
    ;(this.overlay.querySelector('[data-zin]') as HTMLButtonElement).addEventListener('click', () => this.zoomBy(1.25))
    ;(this.overlay.querySelector('[data-zout]') as HTMLButtonElement).addEventListener('click', () => this.zoomBy(0.8))
    ;(this.overlay.querySelector('[data-fit]') as HTMLButtonElement).addEventListener('click', () => this.fit())
    this.search.addEventListener('input', () => { window.clearTimeout(this.searchTimer); this.searchTimer = window.setTimeout(() => { this.searchTimer = 0; this.runSearch() }, 180) })
    this.search.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const first = this.results.querySelector('button') as HTMLButtonElement | null; first?.click() }
    })
    this.bindCanvas()
    // The J-space readout's way back (its "Knowledge graph" button sends this).
    window.addEventListener('lab:open-graph', () => this.open())
  }

  /** Add a listener for as long as the panel is open; close() removes it. */
  private listen(target: EventTarget, type: string, fn: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options)
    this.session.push(() => target.removeEventListener(type, fn, options))
  }

  open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.overlay.classList.add('open')
    this.toggle.setAttribute('aria-expanded', 'true')

    // Everything behind the dialog is out of reach until it closes (the button stays, to close it).
    for (const el of Array.from(document.body.children)) {
      if (el === this.overlay || el === this.toggle || !(el instanceof HTMLElement) || el.inert) continue
      el.inert = true
      this.session.push(() => { el.inert = false })
    }
    this.listen(document, 'keydown', this.onKey as EventListener)
    this.listen(window, 'resize', this.onResize)
    if (window.visualViewport) {
      this.listen(window.visualViewport, 'resize', this.syncViewport)
      this.listen(window.visualViewport, 'scroll', this.syncViewport)
    }
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(this.onResize)
      ro.observe(this.stage)
      this.session.push(() => ro.disconnect())
    }
    this.syncViewport()
    this.resize()
    if (!this.data || Date.now() - this.loadedAt > REFRESH_MS) void this.load()
    else if (this.framedFor !== this.frameKey()) this.reflow()
    else this.kick()

    // A finger opening the panel should not raise the keyboard over it; a mouse or keyboard goes straight to search.
    const byTouch = this.openedBy ? this.openedBy !== 'mouse' : matchMedia('(hover: none)').matches
    ;(byTouch ? this.overlay : this.search).focus({ preventScroll: true })
  }

  /** The one way out (the x, Escape, the button, Open in J-space): stop everything and give the room back. */
  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.stopReplay()
    this.endGesture()
    this.hovered = null
    if (this.searchTimer) { window.clearTimeout(this.searchTimer); this.searchTimer = 0; this.runSearch() } // keep query and results in step
    for (const undo of this.session.splice(0)) undo()
    this.overlay.classList.remove('open', 'cramped')
    this.overlay.style.removeProperty('--kg-vh')
    this.overlay.style.removeProperty('--kg-vt')
    this.toggle.setAttribute('aria-expanded', 'false')
    this.toggle.focus({ preventScroll: true })
  }

  /** Escape closes; Tab stays inside the dialog. */
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { this.close(); return }
    if (e.key !== 'Tab') return
    const items = [...this.overlay.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length > 0)
    if (!items.length) { e.preventDefault(); return }
    const first = items[0], last = items[items.length - 1]
    const at = document.activeElement
    const outside = !at || at === this.overlay || !this.overlay.contains(at)
    if (e.shiftKey ? outside || at === first : outside || at === last) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    }
  }

  /** Keep the full-screen layouts inside what is actually visible (the keyboard covers the rest). */
  private syncViewport = (): void => {
    const vv = window.visualViewport
    const s = this.overlay.style
    if (vv && Math.abs(vv.scale - 1) < 0.01) {
      s.setProperty('--kg-vh', `${vv.height}px`)
      s.setProperty('--kg-vt', `${vv.offsetTop}px`)
    } else {
      s.removeProperty('--kg-vh')
      s.removeProperty('--kg-vt')
    }
  }

  /** The stage changed size (rotation, keyboard, text size, window): re-size the canvas and reframe at once. */
  private onResize = (): void => {
    if (!this.isOpen) return
    this.syncViewport()
    this.resize()
    if (this.data && this.framedFor !== this.frameKey()) this.reflow()
    else this.draw()
  }

  private frameKey(): string {
    return `${Math.round(this.size.w)}x${Math.round(this.size.h)}/${Math.round(this.band.top)}/${Math.round(this.band.bottom)}`
  }

  /** Lay the graph out for the canvas as it is now, without the glide, and frame it. */
  private reflow(): void {
    if (!this.data || !this.size.w) return
    this.layout(false)
    for (const b of this.bodies.values()) { b.x = b.vx; b.y = b.vy }
    this.fitSoon = false
    if (this.selected && !this.anim && this.bodies.has(this.selected)) this.centerOn(this.selected)
    else this.fit(false)
    this.framedFor = this.frameKey()
    this.draw()
    this.kick()
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
      this.resize() // the legend now has a height
      this.layout(true)
      this.framedFor = this.isOpen ? this.frameKey() : ''
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

  // ---- layout: every cluster keeps its own area on a ring; open clusters pack their nodes inside it ----
  private anchors = new Map<NodeType, { x: number; y: number; r: number }>()
  private logos = new Map<string, HTMLImageElement>()

  /** The lab's logo image for a model node, loaded once; null until it has loaded (the coloured dot shows meanwhile). */
  private logoFor(n: GNode): HTMLImageElement | null {
    const lab = labOf(n)
    const src = LOGO_SRC[lab]
    if (!src) return null
    let img = this.logos.get(lab)
    if (!img) {
      img = new Image()
      img.decoding = 'async'
      img.onload = () => this.draw()
      img.src = src
      this.logos.set(lab, img)
    }
    return img.complete && img.naturalWidth > 0 ? img : null
  }
  // Where each open cluster's name was drawn (CSS px): the pill, and the larger area a finger may land on.
  private hullLabels: Array<{ type: NodeType; pill: Box; reach: Box }> = []

  /** The radius a cluster takes: a bubble when closed, room for all its nodes when open. */
  private clusterRadius(c: GCluster): number {
    if (!this.expanded.has(c.id)) return 22 + 5 * Math.sqrt(c.count)
    if (c.id === 'model') return this.modelStep * (hexRings(c.count) + 0.62)
    return 32 + 19 * Math.sqrt(c.count)
  }
  // World distance between neighbouring model nodes. The models are few and carry logos, so they keep a readable
  // size on screen however small the fitted view is: the step grows as the view shrinks, and they never overlap.
  private modelStep = 36

  private anchor(type: NodeType): { x: number; y: number } {
    return this.anchors.get(type) ?? { x: 0, y: 0 }
  }

  /**
   * Where the clusters sit: around a ring, each taking an arc as wide as it is. `aspect` is the ring's
   * width over its height: 1 is the circle a roomy canvas gets, anything else an ellipse of the same area.
   */
  private ringSpots(sizes: number[], aspect: number): Array<{ x: number; y: number; r: number }> {
    const GAP = 46
    const total = sizes.reduce((t, r) => t + 2 * r + GAP, 0)
    const sx = Math.sqrt(aspect), sy = 1 / sx
    const place = (R: number) => {
      if (aspect === 1) {
        let angle = -Math.PI / 2
        return sizes.map(r => {
          const half = ((r + GAP / 2) / total) * 2 * Math.PI // half of this cluster's share of the full turn
          angle += half
          const at = { x: Math.cos(angle) * R, y: Math.sin(angle) * R, r }
          angle += half
          return at
        })
      }
      // On an ellipse equal angles are not equal distances, so walk its outline and share out its length.
      const N = 360
      const pts: Array<[number, number]> = []
      const cum = [0]
      for (let i = 0; i <= N; i++) {
        const a = -Math.PI / 2 + (i / N) * 2 * Math.PI
        pts.push([Math.cos(a) * R * sx, Math.sin(a) * R * sy])
        if (i) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
      }
      const len = cum[N]
      let at = 0, j = 0
      return sizes.map(r => {
        const half = ((r + GAP / 2) / total) * len
        at += half
        while (j < N - 1 && cum[j + 1] < at) j++
        const t = (at - cum[j]) / (cum[j + 1] - cum[j] || 1)
        const spot = { x: pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, y: pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t, r }
        at += half
        return spot
      })
    }
    // Neighbours on the ring are a chord apart, not an arc (and on an ellipse the far side can be close too):
    // widen the ring until every pair clears.
    let ring = Math.max(250, total / (2 * Math.PI))
    let spots = place(ring)
    for (let tries = 0; tries < 30; tries++) {
      const clash = spots.some((a, i) => spots.some((b, j) => {
        if (j <= i || spots.length < 2) return false
        if (aspect === 1 && j !== i + 1 && !(i === 0 && j === spots.length - 1)) return false
        return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + GAP
      }))
      if (!clash) break
      ring *= 1.08
      spots = place(ring)
    }
    return spots
  }

  /** Room the graph needs beyond the clusters themselves, in screen px: their names above and below. */
  private fitPads(): { x: number; top: number; bottom: number } {
    const open = this.expanded.size > 0, closed = this.expanded.size < (this.data?.clusters.length ?? 0)
    return { x: 10, top: open ? 38 : closed ? 26 : 8, bottom: closed ? 28 : 10 }
  }

  /** The room the graph may use, in canvas CSS px: below the title (and the caption), above the buttons and legend. */
  private freeArea(): { top: number; bottom: number; w: number; h: number } {
    const top = this.tight ? this.band.top + 4 : Math.max(110, this.band.top + 8)
    const bottom = this.tight ? this.band.bottom + 2 : Math.max(64, this.band.bottom + 6)
    return { top, bottom, w: this.size.w, h: Math.max(40, this.size.h - top - bottom) }
  }

  /** Place the clusters around the ring and their nodes in a sunflower. */
  private layout(reset: boolean): void {
    if (!this.data) return
    const list = this.data.clusters
    for (let pass = 0; pass < 6; pass++) {
      const sizes = list.map(c => this.clusterRadius(c))
      let spots = this.ringSpots(sizes, 1)
      if (this.tight && this.size.w) {
        // Little room: flatten (or stand up) the ring to the shape of the space, whichever shape shows it largest.
        const free = this.freeArea(), pad = this.fitPads()
        const scaleOf = (s: typeof spots) => {
          const w = Math.max(...s.map(a => a.x + a.r)) - Math.min(...s.map(a => a.x - a.r))
          const h = Math.max(...s.map(a => a.y + a.r)) - Math.min(...s.map(a => a.y - a.r))
          return Math.min((free.w - 2 * pad.x) / w, (free.h - pad.top - pad.bottom) / h)
        }
        let best = scaleOf(spots)
        for (let i = -8; i <= 8; i++) {
          if (!i) continue
          const s = this.ringSpots(sizes, 1.16 ** i), k = scaleOf(s)
          if (k > best * 1.02) { best = k; spots = s }
        }
      }
      list.forEach((c, i) => this.anchors.set(c.id, spots[i]))
      // Give the open Models cluster the room its logos need at the size this layout will be shown.
      if (!this.expanded.has('model') || !this.size.w) break
      const want = Math.max(36, Math.min(220, (2 * MODEL_R + 6) / (this.frame()?.k ?? 1)))
      if (Math.abs(want - this.modelStep) < this.modelStep * 0.03) break
      this.modelStep = want
    }

    const keep = new Set<string>()
    for (const c of list) {
      const p = this.anchor(c.id)
      if (this.expanded.has(c.id)) {
        // Most connected in the middle, then outward in a sunflower, so the area fills evenly.
        const members = this.data.nodes.filter(n => n.type === c.id).sort((x, y) => y.degree - x.degree || (y.epoch ?? 0) - (x.epoch ?? 0))
        members.forEach((n, i) => {
          keep.add(n.id)
          const rad = 19 * Math.sqrt(i + 0.35)
          const ang = i * 2.39996
          const at = c.id === 'model' ? hexSpot(i, this.modelStep) : { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad }
          const tx = p.x + at.x, ty = p.y + at.y
          const r = n.type === 'model' ? 13 : 5 + Math.min(6, Math.sqrt(n.degree) * 1.4)
          const b = this.bodies.get(n.id)
          if (!b || reset) this.bodies.set(n.id, { id: n.id, x: reset ? tx : p.x, y: reset ? ty : p.y, vx: tx, vy: ty, r, cluster: c.id, isCluster: false, node: n })
          else { b.node = n; b.r = r; b.vx = tx; b.vy = ty }
        })
      } else {
        const id = `cluster:${c.id}`
        keep.add(id)
        const r = 22 + 5 * Math.sqrt(c.count)
        const b = this.bodies.get(id)
        if (!b || reset) this.bodies.set(id, { id, x: p.x, y: p.y, vx: p.x, vy: p.y, r, cluster: c.id, isCluster: true, count: c.count })
        else { b.count = c.count; b.r = r; b.vx = p.x; b.vy = p.y }
      }
    }
    for (const id of [...this.bodies.keys()]) if (!keep.has(id)) this.bodies.delete(id)
    if (reset) this.fit(false)
    else if (!this.selected) this.fitSoon = true
    this.kick()
  }
  private fitSoon = false

  /** The body an edge end is drawn at: the node if its cluster is open, else its cluster's bubble. */
  private endOf(id: string): Body | undefined {
    const n = this.byId.get(id)
    if (!n) return undefined
    return this.bodies.get(this.expanded.has(n.type) ? id : `cluster:${n.type}`)
  }

  /** Ask for a frame. One loop draws everything; it runs only while something moves and only while open. */
  private kick(): void {
    if (this.raf || !this.isOpen) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      if (!this.isOpen) return
      this.stepReplay()
      const moving = this.tick()
      this.draw()
      if (moving || this.drag?.mode === 'node' || this.anim) this.kick()
    })
  }

  /** Glide every body toward its place (kept in vx, vy). Returns whether anything is still moving. */
  private tick(): boolean {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let moving = false
    if (this.fitSoon) { this.fitSoon = false; this.fit(false) }
    for (const b of this.bodies.values()) {
      if (this.drag?.mode === 'node' && this.drag.id === b.id) continue
      const dx = b.vx - b.x, dy = b.vy - b.y
      if (Math.abs(dx) + Math.abs(dy) < 0.3) { b.x = b.vx; b.y = b.vy; continue }
      const k = reduce ? 1 : 0.18
      b.x += dx * k; b.y += dy * k
      moving = true
    }
    return moving
  }

  // ---- drawing ----
  /** Match the canvas's pixels to its box, and measure what lies over it. */
  private resize(): void {
    const r = this.canvas.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return // not laid out (closed)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr))
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
    this.size = { w: r.width, h: r.height, dpr: w / r.width }
    this.coarse = matchMedia('(pointer: coarse)').matches
    this.fontScale = Math.max(1, Math.min(1.6, (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16))
    this.measure()
  }

  /** What is laid over the canvas, read from the page so the graph and its labels keep clear of it. */
  private measure(): void {
    const c = this.canvas.getBoundingClientRect()
    if (c.width < 2 || c.height < 2) return
    const box = (sel: string): Box | null => {
      const el = this.overlay.querySelector(sel)
      const r = el?.getBoundingClientRect()
      if (!r || r.width < 1 || r.height < 1) return null
      const b = { x0: r.left - c.left, y0: r.top - c.top, x1: r.right - c.left, y1: r.bottom - c.top }
      return b.x1 <= 0 || b.y1 <= 0 || b.x0 >= c.width || b.y0 >= c.height ? null : b
    }
    const head = box('.kg-headtext'), cap = box('.kg-caption'), zoom = box('.kg-zoom'), legend = box('.kg-legend'), x = box('.kg-close')
    this.blocked = [head, cap, zoom, legend, x].filter((b): b is Box => !!b)
    const rest = { top: Math.max(head?.y1 ?? 0, x?.y1 ?? 0), bottom: c.height - Math.min(zoom?.y0 ?? c.height, legend?.y0 ?? c.height) }
    // Text so large that the title and the legend leave the graph almost no room: use the small arrangement
    // until the panel closes.
    if (c.height - Math.max(rest.top, cap?.y1 ?? 0) - rest.bottom < 200 && (legend || this.overlay.querySelector('.kg-sub')?.getClientRects().length) && !this.overlay.classList.contains('cramped')) {
      this.overlay.classList.add('cramped')
      this.measure()
      return
    }
    this.band = { top: Math.max(rest.top, cap?.y1 ?? 0), bottom: rest.bottom }
    // Judged without the caption, so a replay starting does not rearrange the graph.
    this.tight = Math.min(c.width, c.height - Math.max(110, rest.top + 8) - Math.max(64, rest.bottom + 6)) < 420
  }

  private toScreen(x: number, y: number): [number, number] {
    const dpr = this.size.dpr
    return [(x * this.view.k + this.view.x) * dpr + this.canvas.width / 2, (y * this.view.k + this.view.y) * dpr + this.canvas.height / 2]
  }

  private toWorld(cx: number, cy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    return [((cx - r.left) - r.width / 2 - this.view.x) / this.view.k, ((cy - r.top) - r.height / 2 - this.view.y) / this.view.k]
  }

  /** How large a body is drawn, in CSS px. Bubbles shrink with the view so they never outgrow the space between them. */
  private drawnRadius(b: Body): number {
    const k = this.view.k
    if (b.isCluster) return Math.max(9, b.r * Math.min(1.6, k))
    // A model keeps its logo readable at any fitted view, and shrinks only when zoomed out so far that two would touch.
    if (b.node?.type === 'model') return Math.max(3, Math.min(MODEL_R * Math.max(1, Math.min(1.6, k)), (this.modelStep * k) / 2 - 2))
    return b.r * Math.max(0.6, Math.min(1.6, k))
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
    if (!this.isOpen || !this.size.w) return
    const ctx = this.ctx
    const W = this.canvas.width, H = this.canvas.height
    const dpr = this.size.dpr
    ctx.clearRect(0, 0, W, H)
    if (!this.data) return
    const focus = this.hovered ?? this.selected
    const near = focus ? this.neighbours(focus) : null
    const lit = (id: string) => !focus || id === focus || near!.has(id)
    const k = this.view.k
    const fs = this.fontScale
    const FONT = 'Inter, -apple-system, sans-serif'
    // Labels keep clear of what is laid over the canvas and of each other; `taken` is in canvas pixels.
    const taken: Box[] = this.blocked.map(b => ({ x0: b.x0 * dpr, y0: b.y0 * dpr, x1: b.x1 * dpr, y1: b.y1 * dpr }))
    const free = (b: Box) => b.y0 >= 0 && b.y1 <= H && !taken.some(o => overlaps(b, o))
    // A cluster's name also keeps off every other cluster's bubble or open area.
    const discs: Disc[] = []
    const logos: Array<Disc & { id: string }> = []
    const clear = (b: Box, own: NodeType) => b.x0 >= 0 && b.x1 <= W && free(b) && !discs.some(d => d.own !== own && touches(b, d))
    const within = (x: number, half: number) => Math.max(half + 2 * dpr, Math.min(W - half - 2 * dpr, x))

    // 1. The open clusters' areas, each with its name and how many it holds (click the name to close it).
    this.hullLabels = []
    const names: Array<{ type: NodeType; text: string; color: string; x: number; top: number; bottom: number; y: number }> = []
    for (const c of this.data.clusters) {
      if (!this.expanded.has(c.id)) continue
      const p = this.anchor(c.id)
      const r = (this.anchors.get(c.id)?.r ?? 40) + 10
      const [x, y] = this.toScreen(p.x, p.y)
      const color = TYPE_COLOR[c.id]
      ctx.beginPath(); ctx.arc(x, y, r * k * dpr, 0, Math.PI * 2)
      ctx.fillStyle = `${color}12`; ctx.fill()
      ctx.strokeStyle = `${color}55`; ctx.lineWidth = 1.5 * dpr; ctx.stroke()
      discs.push({ x, y, r: r * k * dpr, own: c.id })
      names.push({ type: c.id, text: `${c.label}  ${c.count}  ×`, color, x, y, top: y - r * k * dpr, bottom: y + r * k * dpr })
    }

    // 2. Links. At rest, one line between each pair of clusters, as heavy as the links they share;
    //    with a node in focus, its own links to each neighbour (or to the neighbour's closed cluster).
    const bundle = new Map<string, { a: NodeType; b: NodeType; n: number; conflict: number }>()
    for (const e of this.data.edges) {
      const ta = this.byId.get(e.source)?.type, tb = this.byId.get(e.target)?.type
      if (!ta || !tb || ta === tb) continue
      const key = ta < tb ? `${ta}|${tb}` : `${tb}|${ta}`
      const cur = bundle.get(key) ?? { a: ta, b: tb, n: 0, conflict: 0 }
      cur.n++
      if (e.kind === 'conflicts') cur.conflict++
      bundle.set(key, cur)
    }
    for (const { a, b, n, conflict } of bundle.values()) {
      const p = this.anchor(a), q = this.anchor(b)
      const [x1, y1] = this.toScreen(p.x, p.y), [x2, y2] = this.toScreen(q.x, q.y)
      ctx.strokeStyle = conflict > n / 2 ? `rgba(229,115,115,${focus ? 0.08 : 0.4})` : `rgba(245,242,235,${focus ? 0.05 : 0.16})`
      ctx.lineWidth = Math.min(10, 1 + Math.log2(n + 1) * 1.2) * dpr
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    }
    if (focus) {
      const from = this.endOf(focus)
      if (from) {
        const [x1, y1] = this.toScreen(from.x, from.y)
        for (const e of this.data.edges) {
          if (e.source !== focus && e.target !== focus) continue
          const to = this.endOf(e.source === focus ? e.target : e.source)
          if (!to || to === from) continue
          const [x2, y2] = this.toScreen(to.x, to.y)
          ctx.strokeStyle = e.kind === 'conflicts' ? 'rgba(229,115,115,0.85)' : 'rgba(255,255,255,0.7)'
          ctx.lineWidth = 1.6 * dpr
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
        }
      }
    }

    // 3. Bubbles and nodes, then every label on top of them.
    const wanted: Array<{ b: Body; x: number; y: number; r: number; on: boolean }> = []
    const order = [...this.bodies.values()].sort((p, q) => Number(q.id === focus) - Number(p.id === focus) || Number(this.topMatches.has(q.id)) - Number(this.topMatches.has(p.id)))
    for (const b of order) {
      const [x, y] = this.toScreen(b.x, b.y)
      const r = this.drawnRadius(b) * dpr
      const on = b.isCluster ? !focus || [...(near ?? [])].some(id => this.byId.get(id)?.type === b.cluster) || this.byId.get(focus)?.type === b.cluster : lit(b.id)
      const color = b.isCluster ? TYPE_COLOR[b.cluster] : colorOf(b.node as GNode)
      if (b.isCluster) discs.push({ x, y, r, own: b.cluster })
      else if (b.node?.type === 'model') logos.push({ x, y, r: r + 2 * dpr, own: 'model', id: b.id })
      ctx.globalAlpha = on ? 1 : 0.2
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      const logo = !b.isCluster && b.node?.type === 'model' ? this.logoFor(b.node) : null
      ctx.fillStyle = b.isCluster ? `${color}33` : logo ? '#F5F2EB' : color
      ctx.fill()
      if (logo) {
        const s = r * 1.25
        ctx.drawImage(logo, x - s / 2, y - s / 2, s, s)
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = color; ctx.stroke()
      }
      ctx.lineWidth = (b.id === this.selected ? 3 : this.matches.has(b.id) ? 2.5 : b.isCluster ? 2 : 1) * dpr
      ctx.strokeStyle = b.id === this.selected ? '#FFFFFF' : this.matches.has(b.id) ? '#FFD54F' : b.isCluster ? color : 'rgba(0,0,0,0.5)'
      ctx.stroke()
      if (!b.isCluster && b.node?.type === 'conflict' && b.node.meta.resolved !== true && r > 6 * dpr) {
        ctx.fillStyle = '#121214'; ctx.font = `700 ${Math.round(r * 1.1)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('!', x, y + dpr)
      }
      // Labels: always for closed bubbles; for nodes only when they are the focus, its neighbours,
      // search matches, or when zoomed in far enough to have room.
      const showLabel = b.isCluster
        ? on
        : focus
          ? b.id === focus || near!.has(b.id)
          : this.matches.size ? this.topMatches.has(b.id) : k > 1.6 || b.node?.type === 'model'
      if (showLabel) wanted.push({ b, x, y, r, on })
      ctx.globalAlpha = 1
    }

    // 4. Names, in the order they matter: the node in focus, the open clusters, the bubbles (largest first),
    //    then search matches and other nodes. Each takes the first clear place; none is drawn over another.
    const label = (text: string, box: Box, cx: number, size: number, weight: number, fill: string, back: string): void => {
      taken.push(box)
      ctx.font = `${weight} ${size}px ${FONT}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = back
      ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
      ctx.fillStyle = fill
      ctx.fillText(text, cx, (box.y0 + box.y1) / 2)
    }
    const nodeLabel = (w: { b: Body; x: number; y: number; r: number; on: boolean }, forced: boolean): void => {
      const text = w.b.node?.label ?? ''
      const size = 12 * fs * dpr
      ctx.font = `500 ${size}px ${FONT}`
      let t = text.length > 38 ? `${text.slice(0, 36)}…` : text
      while (t.length > 6 && ctx.measureText(t).width > W - 16 * dpr) t = `${t.slice(0, -4)}…`
      const half = ctx.measureText(t).width / 2 + 4 * dpr, tall = size + 6 * dpr
      const cx = within(w.x, half)
      const below: Box = { x0: cx - half, y0: w.y + w.r + 3 * dpr, x1: cx + half, y1: w.y + w.r + 3 * dpr + tall }
      const above: Box = { ...below, y0: w.y - w.r - 3 * dpr - tall, y1: w.y - w.r - 3 * dpr }
      let box: Box | null | undefined
      if (forced) box = [below, above].find(free) ?? (below.y1 <= H ? below : above)
      else if (w.b.node?.type === 'model') {
        // A model's name goes on the outer side of its cluster, and never over another model's logo.
        const [ax, ay] = this.toScreen(this.anchor('model').x, this.anchor('model').y)
        const dx = w.x - ax, dy = w.y - ay
        const right: Box = { x0: w.x + w.r + 4 * dpr, y0: w.y - tall / 2, x1: w.x + w.r + 4 * dpr + 2 * half, y1: w.y + tall / 2 }
        const left: Box = { ...right, x0: w.x - w.r - 4 * dpr - 2 * half, x1: w.x - w.r - 4 * dpr }
        const tries = Math.abs(dx) > Math.abs(dy) * 1.2 ? [dx > 0 ? right : left, dy > 0 ? below : above] : [dy >= 0 ? below : above, dx > 0 ? right : left]
        box = tries.find(c => clear(c, 'model') && !logos.some(d => d.id !== w.b.id && touches(c, d)))
      } else box = free(below) ? below : null
      if (box) label(t, box, (box.x0 + box.x1) / 2, size, 500, w.on ? '#F5F2EB' : 'rgba(245,242,235,0.45)', 'rgba(18,18,20,0.82)')
    }
    const inFocus = wanted.find(w => w.b.id === focus && !w.b.isCluster)
    if (inFocus) nodeLabel(inFocus, true)

    for (const n of names) {
      if (n.bottom < 0 || n.top > H || n.x + (n.bottom - n.top) / 2 < 0 || n.x - (n.bottom - n.top) / 2 > W) continue // out of view
      const size = 13 * fs * dpr
      ctx.font = `650 ${size}px ${FONT}`
      const tall = (this.coarse ? 28 : 20) * fs * dpr
      const hullR = (n.bottom - n.top) / 2
      // Above the area, or below it; in a crowd, across its own top edge or middle; the full name where
      // there is room for it, else the count and the x alone.
      const place = (text: string): { text: string; x: number; pill: Box | undefined } => {
        const half = ctx.measureText(text).width / 2 + 6 * dpr
        const x = within(n.x, half)
        const at = (cy: number): Box => ({ x0: x - half, y0: cy - tall / 2, x1: x + half, y1: cy + tall / 2 })
        const spots = [at(n.top + dpr - tall / 2), at(n.bottom - dpr + tall / 2)]
        if (half <= hullR) spots.push(at(n.top + tall / 2 + 3 * dpr), at(n.y))
        return { text, x, pill: spots.find(b => clear(b, n.type)) }
      }
      const short = n.text.replace(/^.*?(\d+  ×)$/, '$1')
      let name = place(n.text)
      if (!name.pill) name = place(short)
      if (!name.pill) {
        // Zoomed in so far that the area fills the view: anywhere on it that is clear, from its top down.
        const half = ctx.measureText(short).width / 2 + 6 * dpr
        const x = within(n.x, half)
        for (let cy = Math.max(tall / 2, n.top + tall / 2); cy <= Math.min(H - tall / 2, n.bottom - tall / 2) && !name.pill; cy += tall) {
          const at: Box = { x0: x - half, y0: cy - tall / 2, x1: x + half, y1: cy + tall / 2 }
          if (clear(at, n.type)) name = { text: short, x, pill: at }
        }
      }
      if (!name.pill) continue
      const pill = name.pill
      label(name.text, pill, name.x, size, 650, n.color, 'rgba(18,18,20,0.85)')
      const css: Box = { x0: pill.x0 / dpr, y0: pill.y0 / dpr, x1: pill.x1 / dpr, y1: pill.y1 / dpr }
      const grow = this.coarse ? Math.max(0, (44 - (css.y1 - css.y0)) / 2) : 0
      this.hullLabels.push({ type: n.type, pill: css, reach: { x0: css.x0 - 4, y0: css.y0 - grow, x1: css.x1 + 4, y1: css.y1 + grow } })
    }

    const mid = this.toScreen(0, 0)[1]
    const bubbles = wanted.filter(w => w.b.isCluster).sort((p, q) => (q.b.count ?? 0) - (p.b.count ?? 0))
    for (const { b, x, y, r, on } of bubbles) {
      // A bubble's name goes below it, or above, or beside it; with no clear place, only its count is written
      // inside (the legend, or the list of kinds on a phone, names the colour).
      const text = `${this.data.clusters.find(c => c.id === b.cluster)?.label ?? b.cluster}  ${b.count}`
      const size = (this.tight ? 12 : 14) * fs * dpr
      ctx.font = `650 ${size}px ${FONT}`
      const w = ctx.measureText(text).width + 8 * dpr, tall = size + 6 * dpr
      const cx = within(x, w / 2)
      const below: Box = { x0: cx - w / 2, y0: y + r + 3 * dpr, x1: cx + w / 2, y1: y + r + 3 * dpr + tall }
      const above: Box = { ...below, y0: y - r - 3 * dpr - tall, y1: y - r - 3 * dpr }
      const right: Box = { x0: x + r + 3 * dpr, y0: y - tall / 2, x1: x + r + 3 * dpr + w, y1: y + tall / 2 }
      const left: Box = { ...right, x0: x - r - 3 * dpr - w, x1: x - r - 3 * dpr }
      // With little room the name goes on the outer side of the ring first, away from the lines and the other bubbles.
      const tries = this.tight && y < mid ? [above, below, right, left] : [below, above, right, left]
      const box = tries.find(c => clear(c, b.cluster))
      const fill = on ? '#F5F2EB' : 'rgba(245,242,235,0.45)'
      if (box) { label(text, box, (box.x0 + box.x1) / 2, size, 650, fill, 'rgba(18,18,20,0.82)'); continue }
      const n = String(b.count ?? ''), s = 11 * fs * dpr
      ctx.font = `650 ${s}px ${FONT}`
      const half = ctx.measureText(n).width / 2 + 2 * dpr
      const inside: Box = { x0: x - half, y0: y - s / 2 - dpr, x1: x + half, y1: y + s / 2 + dpr }
      if (!free(inside)) continue
      taken.push(inside)
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = fill
      ctx.fillText(n, x, y)
    }

    const rank = (w: { b: Body }) => (this.topMatches.has(w.b.id) ? 0 : 1)
    for (const w of wanted.filter(v => !v.b.isCluster && v !== inFocus).sort((p, q) => rank(p) - rank(q))) nodeLabel(w, false)
    this.drawRecall(dpr)
  }

  /** Where the replay has got to: the hop it is on, and whether it has finished and been held long enough. */
  private replayAt(): { hop: number; elapsed: number; done: boolean; reduce: boolean } | null {
    const a = this.anim
    if (!a) return null
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const elapsed = performance.now() - a.start
    const hop = reduce ? a.path.length - 1 : Math.min(a.path.length - 1, Math.floor(elapsed / HOP_MS))
    return { hop, elapsed, reduce, done: elapsed > (reduce ? 2600 : HOP_MS * (a.path.length - 1) + 1800) }
  }

  /** Hold a finished path a moment, then go on to the next recall in the queue, if any. */
  private stepReplay(): void {
    const a = this.anim
    if (!a || !this.replayAt()?.done) return
    const next = a.queue.shift()
    if (next) this.playRecall(next, a.queue)
    else this.stopReplay()
  }

  /** End the replay: no path, no caption, nothing queued. Closing the panel does this too. */
  private stopReplay(): void {
    if (!this.anim && !this.caption.classList.contains('show')) return
    this.anim = null
    this.caption.classList.remove('show')
    this.overlay.classList.remove('replaying')
    this.caption.textContent = ''
    this.measure()
  }

  /** The recall replay: a gold trail through the nodes already reached, and a pulse travelling to the next. */
  private drawRecall(dpr: number): void {
    const a = this.anim, at = this.replayAt()
    if (!a || !at) return
    const ctx = this.ctx
    const { hop, elapsed, reduce } = at
    const pos = (id: string) => { const b = this.endOf(id) ?? this.bodies.get(id); return b ? this.toScreen(b.x, b.y) : null }
    ctx.lineWidth = 2.5 * dpr
    ctx.strokeStyle = 'rgba(255,213,79,0.85)'
    for (let i = 0; i < hop; i++) {
      const p = pos(a.path[i]), q = pos(a.path[i + 1])
      if (!p || !q) continue
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke()
    }
    for (let i = 0; i <= hop; i++) {
      const p = pos(a.path[i])
      if (!p) continue
      ctx.beginPath(); ctx.arc(p[0], p[1], (i === 0 ? 16 : 13) * dpr, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,213,79,0.9)'; ctx.lineWidth = 2.5 * dpr; ctx.stroke()
    }
    if (!reduce && hop < a.path.length - 1) {
      const p = pos(a.path[hop]), q = pos(a.path[hop + 1])
      if (p && q) {
        const t = (elapsed % HOP_MS) / HOP_MS
        const e = t * t * (3 - 2 * t)
        const x = p[0] + (q[0] - p[0]) * e, y = p[1] + (q[1] - p[1]) * e
        ctx.strokeStyle = 'rgba(255,213,79,0.5)'; ctx.lineWidth = 2 * dpr
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(x, y); ctx.stroke()
        const g = ctx.createRadialGradient(x, y, 0, x, y, 14 * dpr)
        g.addColorStop(0, 'rgba(255,236,150,1)'); g.addColorStop(1, 'rgba(255,213,79,0)')
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 14 * dpr, 0, Math.PI * 2); ctx.fill()
      }
    }
  }

  /** Replay one recall: open the clusters it touches and walk from the model to each node it found. */
  playRecall(r: Recall, queue: Recall[] = []): void {
    if (!this.data || !this.isOpen) return
    const modelId = `model:${r.model}`
    const path = [modelId, ...r.hits].filter(id => this.byId.has(id))
    if (path.length < 2) { const next = queue.shift(); if (next) this.playRecall(next, queue); else this.stopReplay(); return }
    const typeOf = (id: string): NodeType => (this.byId.get(id) as GNode).type
    // On a small canvas the caption is cut to what fits; the side list has the question in full.
    const q = this.tight && r.question.length > 84 ? `${r.question.slice(0, 82).trimEnd()}…` : r.question
    const who = this.tight ? `, epoch ${r.epoch}:` : `${r.role ? ` (${esc(r.role)}, epoch ${r.epoch})` : ` (epoch ${r.epoch})`} asked the lab's memory:`
    this.caption.innerHTML = `<span><b>${esc(r.model_name)}</b>${who} “${esc(q)}”</span>`
    this.caption.classList.add('show')
    this.overlay.classList.add('replaying')
    this.measure()
    // Open the clusters the path touches (on a small canvas, only those), so it can be followed node by node.
    if (this.tight) this.expanded.clear()
    for (const id of path) this.expanded.add(typeOf(id))
    this.layout(false)
    let steps = path
    if (this.tight && (this.frame()?.k ?? 1) < 0.45) {
      // Still too small to tell the nodes apart: keep the clusters closed and walk from bubble to bubble.
      this.expanded.clear()
      this.layout(false)
      const hops = path.filter((id, i) => i === 0 || typeOf(id) !== typeOf(path[i - 1]))
      if (hops.length > 1) steps = hops
    }
    this.anim = { path: steps, start: performance.now(), queue }
    // Frame the whole graph in the room left under the caption, at once, so the path is on screen from its first hop.
    for (const b of this.bodies.values()) { b.x = b.vx; b.y = b.vy }
    this.fitSoon = false
    this.fit(false)
    this.framedFor = this.frameKey()
    this.syncKinds()
    this.kick()
  }

  /** The list of kinds (shown on phones) says which clusters are open. */
  private syncKinds(): void {
    this.side.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(this.expanded.has(b.dataset.kind as NodeType))))
  }

  // ---- interaction ----
  private hit(cx: number, cy: number, touch = false): Body | null {
    const [wx, wy] = this.toWorld(cx, cy)
    const k = this.view.k
    let best: Body | null = null, bd = Infinity
    for (const b of this.bodies.values()) {
      const drawn = this.drawnRadius(b)
      const r = (touch ? Math.max(drawn + 8, b.isCluster ? 22 : 14) : drawn + 4) / k
      const d = Math.hypot(b.x - wx, b.y - wy)
      if (d < r && d < bd) { best = b; bd = d }
    }
    return best
  }

  /** A press that did not move: an open cluster's name closes it, a bubble opens, a dot is selected. */
  private tap(cx: number, cy: number, touch: boolean): void {
    const rect = this.canvas.getBoundingClientRect()
    const lx = cx - rect.left, ly = cy - rect.top
    const inside = (b: Box) => lx >= b.x0 && lx <= b.x1 && ly >= b.y0 && ly <= b.y1
    let label = this.hullLabels.find(h => inside(h.pill))
    const b = label ? null : this.hit(cx, cy, touch)
    // A finger is wider than the name: with nothing else under it, the area around the name counts too.
    if (!label && !b) label = this.hullLabels.filter(h => inside(h.reach)).sort((p, q) => Math.abs((p.pill.y0 + p.pill.y1) / 2 - ly) - Math.abs((q.pill.y0 + q.pill.y1) / 2 - ly))[0]
    if (label) this.expand(label.type, true)
    else if (b?.isCluster) this.expand(b.cluster, true)
    else if (b) this.select(b.id, false)
    else { this.selected = null; this.showOverview(); this.draw() }
  }

  /** Start a two-finger pinch about the point between the fingers. */
  private startPinch(): void {
    const [a, b] = [...this.pointers.keys()]
    const p = this.pointers.get(a)!, q = this.pointers.get(b)!
    const [wx, wy] = this.toWorld((p.x + q.x) / 2, (p.y + q.y) / 2)
    this.pinch = { a, b, d0: Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)), k0: this.view.k, wx, wy }
  }

  /** Drop every pointer and gesture (the panel is closing, or the browser took the touch away). */
  private endGesture(): void {
    for (const id of this.pointers.keys()) { try { this.canvas.releasePointerCapture(id) } catch { /* already released */ } }
    this.pointers.clear()
    this.drag = null
    this.pinch = null
    this.canvas.classList.remove('dragging')
  }

  private bindCanvas(): void {
    const c = this.canvas
    c.addEventListener('pointerdown', e => {
      if (!this.isOpen || (e.pointerType === 'mouse' && e.button !== 0)) return
      try { c.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      c.classList.add('dragging')
      if (this.pointers.size === 1) {
        const touch = e.pointerType !== 'mouse'
        const b = this.hit(e.clientX, e.clientY, touch)
        const base = { pointer: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, slop: touch ? 10 : 4 }
        this.drag = b && !b.isCluster
          ? { ...base, mode: 'node', id: b.id, vx: 0, vy: 0 }
          : { ...base, mode: 'pan', id: b?.id, vx: this.view.x, vy: this.view.y }
      } else if (this.pointers.size === 2) {
        // A second finger turns whatever the first was doing into a pinch (a held node glides back).
        this.drag = null
        this.startPinch()
        this.kick()
      }
    })
    c.addEventListener('pointermove', e => {
      const p = this.pointers.get(e.pointerId)
      if (p) { p.x = e.clientX; p.y = e.clientY }
      if (this.pinch) {
        const a = this.pointers.get(this.pinch.a), b = this.pointers.get(this.pinch.b)
        if (!a || !b || !p) return
        const r = c.getBoundingClientRect()
        const k = Math.max(MIN_K, Math.min(MAX_K, this.pinch.k0 * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d0)))
        // The point that was between the fingers stays between them.
        this.view.k = k
        this.view.x = (a.x + b.x) / 2 - r.left - r.width / 2 - this.pinch.wx * k
        this.view.y = (a.y + b.y) / 2 - r.top - r.height / 2 - this.pinch.wy * k
        this.kick()
        return
      }
      const d = this.drag
      if (d) {
        if (e.pointerId !== d.pointer) return
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > d.slop) d.moved = true
        if (d.mode === 'pan') {
          this.view.x = d.vx + (e.clientX - d.sx)
          this.view.y = d.vy + (e.clientY - d.sy)
          this.kick()
        } else if (d.moved && d.id) {
          const b = this.bodies.get(d.id)
          if (b) { const [wx, wy] = this.toWorld(e.clientX, e.clientY); b.x = wx; b.y = wy; this.kick() }
        }
        return
      }
      if (e.pointerType === 'touch') return // a finger does not hover
      const b = this.hit(e.clientX, e.clientY)
      const id = b && !b.isCluster ? b.id : null
      c.style.cursor = b ? 'pointer' : 'grab'
      if (id !== this.hovered) { this.hovered = id; this.draw() }
    })
    const lift = (e: PointerEvent, cancelled: boolean) => {
      if (!this.pointers.delete(e.pointerId)) return
      if (this.pinch) {
        // One finger left carries on as a pan; it must not count as a tap when it lifts.
        const rest = [...this.pointers.entries()]
        if (rest.length >= 2) this.startPinch()
        else {
          this.pinch = null
          this.drag = rest.length ? { mode: 'pan', pointer: rest[0][0], sx: rest[0][1].x, sy: rest[0][1].y, vx: this.view.x, vy: this.view.y, moved: true, slop: 0 } : null
        }
      } else if (this.drag?.pointer === e.pointerId) {
        const d = this.drag
        this.drag = null
        if (!cancelled && !d.moved) this.tap(e.clientX, e.clientY, e.pointerType !== 'mouse')
      }
      if (!this.pointers.size) c.classList.remove('dragging')
      // Show where things ended up now, not a frame later.
      if (this.isOpen) { this.draw(); this.kick() }
    }
    c.addEventListener('pointerup', e => lift(e, false))
    c.addEventListener('pointercancel', e => lift(e, true))
    c.addEventListener('pointerleave', () => { if (this.hovered) { this.hovered = null; this.draw() } })
    c.addEventListener('wheel', e => {
      e.preventDefault()
      const f = Math.exp(-e.deltaY * 0.0015)
      const r = c.getBoundingClientRect()
      const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2
      const k = Math.max(MIN_K, Math.min(MAX_K, this.view.k * f))
      this.view.x = mx - ((mx - this.view.x) * k) / this.view.k
      this.view.y = my - ((my - this.view.y) * k) / this.view.k
      this.view.k = k
      this.draw()
    }, { passive: false })
  }

  private zoomBy(f: number): void {
    const k = Math.max(MIN_K, Math.min(MAX_K, this.view.k * f))
    const g = k / this.view.k
    this.view.k = k
    this.view.x *= g; this.view.y *= g
    this.draw()
  }

  /** Frame the whole graph in the room the canvas has for it. */
  private fit(redraw = true): void {
    const v = this.frame()
    if (!v) return
    this.view = v
    if (redraw) this.draw()
  }

  /** The view that shows the whole graph in the room the canvas has for it. */
  private frame(): { x: number; y: number; k: number } | null {
    const areas = [...this.anchors.entries()].map(([type, a]) => ({ ...a, r: a.r + (this.expanded.has(type) ? 10 : 0) }))
    if (!areas.length || !this.size.w) return null
    const free = this.freeArea()
    const view = { x: 0, y: 0, k: 1 }
    if (this.tight) {
      // Little room: measure it in screen px, so the names above and below fit whatever the zoom.
      const pad = this.fitPads()
      const x0 = Math.min(...areas.map(a => a.x - a.r)), x1 = Math.max(...areas.map(a => a.x + a.r))
      const y0 = Math.min(...areas.map(a => a.y - a.r)), y1 = Math.max(...areas.map(a => a.y + a.r))
      view.k = Math.max(MIN_K, Math.min(1.6, Math.min((free.w - 2 * pad.x) / (x1 - x0), (free.h - pad.top - pad.bottom) / (y1 - y0))))
      view.x = -((x0 + x1) / 2) * view.k
      view.y = -((y0 + y1) / 2) * view.k + (free.top + pad.top - free.bottom - pad.bottom) / 2
    } else {
      const base = [...this.anchors.values()]
      const xs = base.flatMap(a => [a.x - a.r - 30, a.x + a.r + 30]), ys = base.flatMap(a => [a.y - a.r - 40, a.y + a.r + 40])
      const w = Math.max(...xs) - Math.min(...xs) + 40, h = Math.max(...ys) - Math.min(...ys) + 40
      view.k = Math.max(MIN_K, Math.min(1.6, Math.min(free.w / w, free.h / h)))
      view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k
      view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k + (free.top - free.bottom) / 2
    }
    return view
  }

  /** Bring a node to the middle of the room the canvas has for the graph. */
  private centerOn(id: string): void {
    const b = this.bodies.get(id)
    if (!b) return
    this.view.k = Math.max(this.view.k, 1.1)
    const free = this.freeArea()
    this.view.x = -b.vx * this.view.k
    this.view.y = -b.vy * this.view.k + (this.tight ? (free.top - free.bottom) / 2 : 0)
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
    // Only the node's own cluster opens; its neighbours stay in their clusters (the side list names them all).
    const changed = !this.expanded.has(n.type)
    this.expanded.add(n.type)
    if (changed) this.layout(false)
    if (center) this.centerOn(id)
    this.showNode(id)
    this.kick()
  }

  // ---- side column ----
  private showOverview(): void {
    if (!this.data) return
    const top = [...this.data.nodes].filter(n => !['epoch', 'model'].includes(n.type)).sort((a, b) => b.degree - a.degree).slice(0, 8)
    const press = this.coarse ? 'Tap' : 'Click'
    this.side.innerHTML = `
      <div class="kg-section">What is in it</div>
      <div class="kg-detail">${this.data.nodes.length} things and ${this.data.edges.length} links from ${this.data.epochs ?? 'the'} epochs. ${press} a bubble to open it, a dot to see what it links to, or search above.</div>
      <div class="kg-detail kg-about">${ABOUT}</div>
      <div class="kg-kinds">${this.data.clusters.map(c => `<button data-kind="${c.id}" aria-pressed="${this.expanded.has(c.id)}"><span class="kg-dot" style="background:${TYPE_COLOR[c.id]}"></span>${esc(c.label)} ${c.count}</button>`).join('')}</div>
      ${this.recallSection()}
      <div class="kg-section">Most connected</div>
      <div class="kg-links">${top.map(n => this.linkButton(n.id, `${n.degree} links`)).join('')}</div>
      <div class="kg-section">For agents</div>
      <div class="kg-detail">The same graph as JSON: <a href="/api/experiment/graph" target="_blank" rel="noopener">/api/experiment/graph</a>, with <code>?q=</code> to search and <code>?focus=&lt;id&gt;&amp;depth=2</code> to walk it.</div>`
    this.bindLinks(this.side)
    this.bindRecalls(this.side)
    // Where the legend is hidden (phones), the kinds are listed here; each one opens or closes its cluster.
    this.side.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b => b.addEventListener('click', () => {
      const kind = b.dataset.kind as NodeType
      this.expand(kind, true)
      if (this.selected) b.setAttribute('aria-pressed', String(this.expanded.has(kind)))
      else this.side.querySelector<HTMLButtonElement>(`[data-kind="${kind}"]`)?.focus({ preventScroll: true })
    }))
  }

  private recallSection(): string {
    const list = this.data?.recalls ?? []
    if (!list.length) return '<div class="kg-section">The models\' recalls</div><div class="kg-detail">None yet. When a model asks the lab\'s memory a question, it appears here and you can watch where it went.</div>'
    return `<div class="kg-section">The models' recalls (${list.length})</div>
      <button class="kg-js" data-playall>▶ Watch them recall</button>
      ${list.slice(0, 8).map((r, i) => `<div class="kg-recall"><button class="kg-play" data-play="${i}" aria-label="Replay this recall">▶</button><div class="kg-q"><b>${esc(r.model_name)}</b>, epoch ${r.epoch}: “${esc(r.question)}”</div></div>`).join('')}`
  }

  private bindRecalls(root: HTMLElement): void {
    const list = this.data?.recalls ?? []
    root.querySelector<HTMLButtonElement>('[data-playall]')?.addEventListener('click', () => {
      const queue = [...list].reverse()
      const first = queue.shift()
      if (first) this.playRecall(first, queue)
    })
    root.querySelectorAll<HTMLButtonElement>('[data-play]').forEach(b => b.addEventListener('click', () => this.playRecall(list[Number(b.dataset.play)])))
  }

  /** Ask the room to open J-space with this model's words (main.ts listens for lab:open-jspace). */
  private openJSpace(n: GNode): void {
    let turn = n
    if (n.type === 'model') {
      const turns = (this.data?.nodes ?? []).filter(t => t.type === 'turn' && t.meta.model === n.detail).sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0))
      if (!turns.length) return
      turn = turns[0]
    }
    const [said, reasoning] = turn.detail.split('\nReasoning: ')
    this.close()
    window.dispatchEvent(new CustomEvent('lab:open-jspace', { detail: { model: String(turn.meta.model ?? ''), title: turn.label, remark: said ?? '', reasoning: reasoning ?? '', from: 'graph' } }))
  }

  private linkButton(id: string, note: string): string {
    const n = this.byId.get(id)
    if (!n) return ''
    return `<button data-go="${esc(id)}">${this.markHtml(n, 15)}${esc(n.label)} <span class="kg-tag">${esc(n.type)}${note ? ` · ${esc(note)}` : ''}</span></button>`
  }

  /** A model's credited logo, or the coloured dot every other kind of node uses. */
  private markHtml(n: GNode, size: number): string {
    const src = n.type === 'model' ? LOGO_SRC[labOf(n)] : undefined
    return src
      ? `<img src="${esc(src)}" alt="" width="${size}" height="${size}" style="vertical-align:-${Math.round(size / 4)}px;margin-right:7px;background:#F5F2EB;border-radius:50%;padding:2px;border:2px solid ${colorOf(n)}">`
      : `<span class="kg-dot" style="background:${colorOf(n)}"></span>`
  }

  private bindLinks(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(b => b.addEventListener('click', () => {
      // On a phone the keyboard is still up after a search: put it away so the graph and the node can be seen.
      if (this.coarse && document.activeElement === this.search) this.search.blur()
      this.select(b.dataset.go as string)
    }))
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
      <div class="kg-h">${this.markHtml(n, 22)}${esc(n.label)}</div>
      <div class="kg-tag">${esc(n.type)}</div>
      ${meta.length ? `<div class="kg-meta">${esc(meta.join(' · '))}</div>` : ''}
      ${n.detail && n.type !== 'model' ? `<div class="kg-section">What it says</div><div class="kg-detail">${esc(n.detail)}</div>` : ''}
      ${pr ? `<div class="kg-detail"><a href="${esc(pr)}" target="_blank" rel="noopener">Open the pull request</a></div>` : ''}
      ${n.type === 'turn' || n.type === 'model' ? `<button class="kg-js" data-jspace>◉ Open ${n.type === 'model' ? 'its latest turn' : 'this turn'} in J-space</button>` : ''}
      ${[...groups.entries()].map(([k, list]) => `<div class="kg-section">${esc(k)} (${list.length})</div><div class="kg-links">${list.slice(0, 40).map(l => this.linkButton(l.id, l.note)).join('')}</div>`).join('') || '<div class="kg-empty">No links yet.</div>'}
      <div class="kg-actions"><button data-back>Overview</button></div>`
    this.bindLinks(this.side)
    this.side.querySelector<HTMLButtonElement>('[data-jspace]')?.addEventListener('click', () => this.openJSpace(n))
    // Bring the node's text to the top of the list (only the list scrolls, never the page behind).
    const top = this.side.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop
    this.scroller.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    ;(this.side.querySelector('[data-back]') as HTMLButtonElement).addEventListener('click', () => { this.selected = null; this.showOverview(); this.draw() })
  }

  /** Search the loaded graph the way the server does: label and id hits count most. */
  private runSearch(): void {
    const q = this.search.value.trim().toLowerCase()
    this.matches.clear()
    this.topMatches.clear()
    if (!q || !this.data) { this.results.innerHTML = ''; this.draw(); return }
    const terms = q.split(/[^a-z0-9_]+/).filter(w => w.length > 1 && !COMMON.has(w))
    const hits = this.data.nodes.map(n => {
      const head = `${n.label} ${n.id}`.toLowerCase(), body = n.detail.toLowerCase()
      let s = 0
      for (const t of terms) s += (head.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0)
      return { n, s: s + (s && (head.includes(q) || body.includes(q)) ? 4 : 0) }
    }).filter(h => h.s > 0).sort((a, b) => b.s - a.s || b.n.degree - a.n.degree).slice(0, 12)
    for (const h of hits) { this.matches.add(h.n.id); this.expanded.add(h.n.type) }
    this.topMatches = new Set(hits.slice(0, 6).map(h => h.n.id))
    this.layout(false)
    this.results.innerHTML = hits.length
      ? `<div class="kg-section">${hits.length} match${hits.length > 1 ? 'es' : ''}</div><div class="kg-links">${hits.map(h => this.linkButton(h.n.id, h.n.epoch ? `epoch ${h.n.epoch}` : '')).join('')}</div>`
      : '<div class="kg-empty">Nothing matches. Try a part of the agent (memory, browser), a model (Claude, Grok) or a site.</div>'
    this.bindLinks(this.results)
    this.syncKinds()
    this.scroller.scrollTop = 0 // the results are at the top of the list, whatever was being read before
  }
}
