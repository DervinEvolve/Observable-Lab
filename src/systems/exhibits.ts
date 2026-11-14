// Exhibits: small objects models design for the room, merged into AI-Agent as
// exhibits/<slug>/exhibit.json (docs/EXHIBITS.md, AI-Agent exhibits/README.md).
// The server reads merged ones from GitHub, checks them and serves them at
// GET /api/experiment/exhibits. The room checks every record again here and
// builds only what passes, with its own builder (src/entities/ExhibitHall.ts).
// An exhibit is data only: nothing in it is ever run, fetched or linked.

export const EXHIBITS_API = '/api/experiment/exhibits'
// served here too until the route above is listed as public (docs/EXHIBITS.md)
export const EXHIBITS_API_FALLBACK = '/api/experiment?view=exhibits'
export const MAX_SHOWN = 8
export const MAX_TRIANGLES = 6000

export const PLACEMENTS = ['pedestal', 'shelf', 'wall', 'ceiling', 'floor'] as const
export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'ring', 'tube'] as const
export const MATERIALS = ['wood', 'brass', 'glass', 'paper', 'stone', 'ceramic', 'leaf', 'light'] as const

export type Placement = (typeof PLACEMENTS)[number]
export type Shape = (typeof SHAPES)[number]
export type MaterialKind = (typeof MATERIALS)[number]
export type Vec3 = [number, number, number]

export interface ExhibitPart {
  shape: Shape
  size: Vec3
  position: Vec3
  rotation?: Vec3
  colour: number
  material: MaterialKind
  repeat?: { count: number; radial?: { radius: number }; linear?: { step: Vec3 } }
  path?: Vec3[]
}

export interface ExhibitData {
  version: 1
  title: string
  description: string
  author_model: string
  placement: Placement
  palette: string[]
  parts: ExhibitPart[]
  animation?: { spin?: number; bob?: number; pulse?: number }
  label?: string
}

export interface ExhibitRecord {
  slug: string
  commit_sha: string
  merged_at: string
  author_model: string
  data: ExhibitData
}

// Triangles per shape at the room's fixed segment counts (ExhibitHall.ts uses
// exactly these): the same table as AI-Agent scripts/exhibits.ts.
export const SEGMENTS = {
  sphere: { width: 16, height: 12 },
  cylinder: { radial: 16 },
  cone: { radial: 16 },
  torus: { radial: 12, tubular: 24 },
  capsule: { cap: 8, radial: 16 },
  ring: { theta: 24 },
  tube: { radial: 8 },
} as const

const FIXED_TRIANGLES: Record<Exclude<Shape, 'tube'>, number> = {
  box: 12,
  sphere: 352,
  cylinder: 64,
  cone: 48,
  torus: 576,
  capsule: 544,
  ring: 48,
}

export function partTriangles(p: ExhibitPart): number {
  const each = p.shape === 'tube' ? SEGMENTS.tube.radial * 2 * Math.max((p.path?.length ?? 0) - 1, 0) : FIXED_TRIANGLES[p.shape]
  return each * (p.repeat?.count ?? 1)
}

export function estimateTriangles(d: { parts: ExhibitPart[] }): number {
  return d.parts.reduce((sum, p) => sum + partTriangles(p), 0)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every(k => keys.includes(k))
// no URLs, no markup, no script-like text anywhere in a record
const BAD_TEXT = /:\/\/|<\s*\/?\s*[a-z!?]|javascript:|data:|vbscript:|\bon[a-z]+\s*=|\bwww\./i

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  // same control and direction-override characters the server refuses
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(v)) return null
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!t || v.length > max || BAD_TEXT.test(t)) return null
  return t
}

function vec3(v: unknown, lo: number, hi: number): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return null
  if (v.some(n => n < lo || n > hi)) return null
  return [v[0], v[1], v[2]]
}

/** The exhibit file, checked against version 1. Returns null on any problem. */
export function validateExhibitData(raw: unknown): ExhibitData | null {
  if (!isObj(raw)) return null
  if (!onlyKeys(raw, ['version', 'title', 'description', 'author_model', 'placement', 'palette', 'parts', 'animation', 'label'])) return null
  if (raw.version !== 1) return null
  const title = text(raw.title, 60)
  const description = text(raw.description, 400)
  const author = typeof raw.author_model === 'string' ? text(raw.author_model, 60) : null
  if (!title || !description || !author) return null
  const label = raw.label === undefined ? undefined : text(raw.label, 40)
  if (label === null) return null
  if (!PLACEMENTS.includes(raw.placement as Placement)) return null
  if (!Array.isArray(raw.palette) || raw.palette.length < 1 || raw.palette.length > 6) return null
  if (!raw.palette.every(c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))) return null
  const palette = raw.palette as string[]

  let animation: ExhibitData['animation']
  if (raw.animation !== undefined) {
    const a = raw.animation
    if (!isObj(a) || !onlyKeys(a, ['spin', 'bob', 'pulse'])) return null
    animation = {}
    for (const [k, max] of [['spin', 1], ['bob', 0.2], ['pulse', 2]] as const) {
      const v = a[k]
      if (v === undefined) continue
      if (!isNum(v) || v < 0 || v > max) return null
      animation[k] = v
    }
  }

  if (!Array.isArray(raw.parts) || raw.parts.length < 1 || raw.parts.length > 64) return null
  const parts: ExhibitPart[] = []
  for (const p of raw.parts) {
    if (!isObj(p) || !onlyKeys(p, ['shape', 'size', 'position', 'rotation', 'colour', 'material', 'repeat', 'path'])) return null
    if (!SHAPES.includes(p.shape as Shape) || !MATERIALS.includes(p.material as MaterialKind)) return null
    const size = vec3(p.size, 0.01, 2)
    const position = vec3(p.position, -1.5, 1.5)
    if (!size || !position) return null
    const rotation = p.rotation === undefined ? undefined : vec3(p.rotation, -7, 7)
    if (rotation === null) return null
    if (!Number.isInteger(p.colour) || (p.colour as number) < 0 || (p.colour as number) >= palette.length) return null
    const part: ExhibitPart = { shape: p.shape as Shape, size, position, colour: p.colour as number, material: p.material as MaterialKind }
    if (rotation) part.rotation = rotation
    if (p.repeat !== undefined) {
      const r = p.repeat
      if (!isObj(r) || !onlyKeys(r, ['count', 'radial', 'linear'])) return null
      if (!Number.isInteger(r.count) || (r.count as number) < 1 || (r.count as number) > 24) return null
      const rep: NonNullable<ExhibitPart['repeat']> = { count: r.count as number }
      if (r.radial !== undefined) {
        if (!isObj(r.radial) || !onlyKeys(r.radial, ['radius']) || !isNum(r.radial.radius) || r.radial.radius < 0 || r.radial.radius > 1.5) return null
        rep.radial = { radius: r.radial.radius }
      }
      if (r.linear !== undefined) {
        if (!isObj(r.linear) || !onlyKeys(r.linear, ['step'])) return null
        const step = vec3(r.linear.step, -1.5, 1.5)
        if (!step) return null
        rep.linear = { step }
      }
      part.repeat = rep
    }
    if (p.shape === 'tube') {
      if (!Array.isArray(p.path) || p.path.length < 2 || p.path.length > 16) return null
      const path: Vec3[] = []
      for (const pt of p.path) {
        const v = vec3(pt, -1.5, 1.5)
        if (!v) return null
        path.push(v)
      }
      part.path = path
    } else if (p.path !== undefined) return null
    parts.push(part)
  }
  const data: ExhibitData = { version: 1, title, description, author_model: author || '', placement: raw.placement as Placement, palette, parts }
  if (animation) data.animation = animation
  if (label) data.label = label
  if (estimateTriangles(data) > MAX_TRIANGLES) return null
  return data
}

/** The endpoint's answer: only records that pass every check. */
export function parseExhibitsResponse(raw: unknown): ExhibitRecord[] {
  const list = isObj(raw) ? raw.exhibits : null
  if (!Array.isArray(list)) return []
  const out: ExhibitRecord[] = []
  const seen = new Set<string>()
  for (const item of list.slice(0, 200)) {
    if (!isObj(item)) continue
    const slug = item.slug
    const sha = item.commit_sha
    const mergedAt = item.merged_at
    const author = text(item.author_model, 60)
    if (typeof slug !== 'string' || !/^[a-z0-9-]{3,40}$/.test(slug) || seen.has(slug)) continue
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) continue
    if (typeof mergedAt !== 'string' || Number.isNaN(Date.parse(mergedAt))) continue
    if (!author) continue
    const data = validateExhibitData(item.data)
    if (!data) continue
    // the lab names the author; whatever the file says is not trusted
    data.author_model = author
    seen.add(slug)
    out.push({ slug, commit_sha: sha, merged_at: mergedAt, author_model: author, data })
  }
  return out
}

/** At most 8: newest merged first, one per model for each placement kind. */
export function selectExhibits(records: ExhibitRecord[]): ExhibitRecord[] {
  const sorted = records.slice().sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
  const taken = new Set<string>()
  const out: ExhibitRecord[] = []
  for (const r of sorted) {
    const key = `${r.author_model}\u0000${r.data.placement}`
    if (taken.has(key)) continue
    taken.add(key)
    out.push(r)
    if (out.length === MAX_SHOWN) break
  }
  return out
}

/** A palette colour pulled into the room's quiet-science range: no neon, no pure black or white. */
export function clampColour(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  let r = ((v >> 16) & 255) / 255
  let g = ((v >> 8) & 255) / 255
  let b = (v & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  const d = max - min
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  s = Math.min(s, 0.55)
  l = Math.min(0.86, Math.max(0.16, l))
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    t = (t + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  ;[r, g, b] = s === 0 ? [l, l, l] : [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
  return [r, g, b]
}

/** Commit link on the specimen repository, or null when either part is unsafe. */
export function commitUrl(repoUrl: string, sha: string): string | null {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repoUrl)) return null
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null
  return `${repoUrl}/commit/${sha}`
}
