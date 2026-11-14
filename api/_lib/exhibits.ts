/**
 * Exhibits, version 1 (docs/EXHIBITS.md).
 *
 * An exhibit is a small object a model designs for the room. It lives in
 * AI-Agent at exhibits/<slug>/exhibit.json and is data only: no scripts, no
 * URLs, no external assets. This one validator is used twice: before the lab
 * opens the pull request that adds an exhibit, and again when the server
 * reads merged exhibits back from AI-Agent for the room.
 *
 * The rules match AI-Agent's own check (scripts/exhibits.ts, run by its CI)
 * number for number. If one changes, change both and docs/EXHIBITS.md.
 */

export const EXHIBIT_VERSION = 1
export const SLUG_RE = /^[a-z0-9-]{3,40}$/
export const HEX_RE = /^#[0-9a-fA-F]{6}$/
export const MAX_TRIANGLES = 6000
export const MAX_PARTS = 64
export const MAX_PALETTE = 6
export const MAX_FILE_BYTES = 32 * 1024
/** The room shows at most this many at once. */
export const MAX_EXHIBITS_SHOWN = 8

export const PLACEMENTS = ['pedestal', 'shelf', 'wall', 'ceiling', 'floor'] as const
export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'ring', 'tube'] as const
export const MATERIALS = ['wood', 'brass', 'glass', 'paper', 'stone', 'ceramic', 'leaf', 'light'] as const

export type Placement = (typeof PLACEMENTS)[number]
export type Shape = (typeof SHAPES)[number]
export type Material = (typeof MATERIALS)[number]
export type Vec3 = [number, number, number]

export interface ExhibitPart {
  shape: Shape
  size: Vec3
  position: Vec3
  rotation?: Vec3
  colour: number
  material: Material
  repeat?: { count: number; radial?: { radius: number }; linear?: { step: Vec3 } }
  path?: Vec3[]
}

export interface Exhibit {
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

/**
 * Triangles per shape at the room's fixed segment counts. Cone and capsule
 * are counted a little high on purpose, so the estimate is never lower than
 * what the room draws.
 */
export const FIXED_TRIANGLES: Record<Exclude<Shape, 'tube'>, number> = {
  box: 12,
  sphere: 16 * 12 * 2 - 2 * 16,   // 16 x 12 segments: 352
  cylinder: 16 * 2 + 16 * 2,      // 16 radial, side and two caps: 64
  cone: 16 * 2 + 16,              // 16 radial, side and one cap: 48
  torus: 12 * 24 * 2,             // 12 x 24: 576
  capsule: (2 * 8 + 1) * 16 * 2,  // 8 cap segments, 16 radial: 544
  ring: 24 * 2,                   // 24 segments: 48
}
export const TUBE_RADIAL_SEGMENTS = 8

export function partTriangles(part: { shape?: unknown; path?: unknown; repeat?: { count?: unknown } }): number {
  let each = 0
  if (part.shape === 'tube') {
    const points = Array.isArray(part.path) ? part.path.length : 0
    each = TUBE_RADIAL_SEGMENTS * 2 * Math.max(points - 1, 0)
  } else if (typeof part.shape === 'string' && part.shape in FIXED_TRIANGLES) {
    each = FIXED_TRIANGLES[part.shape as keyof typeof FIXED_TRIANGLES]
  }
  const count = typeof part.repeat?.count === 'number' && Number.isInteger(part.repeat.count) ? part.repeat.count : 1
  return each * Math.max(1, count)
}

export function estimateTriangles(data: { parts?: unknown }): number {
  return Array.isArray(data.parts)
    ? data.parts.reduce((sum: number, p) => sum + (p && typeof p === 'object' ? partTriangles(p as never) : 0), 0)
    : 0
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function onlyKeys(o: Record<string, unknown>, allowed: string[], at: string, errs: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${at}: unknown key "${k.slice(0, 40)}"`)
}

function vec3(v: unknown, lo: number, hi: number, at: string, errs: string[]) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) {
    errs.push(`${at}: must be [x, y, z] numbers`)
    return
  }
  if (v.some(n => n < lo || n > hi)) errs.push(`${at}: each value must be between ${lo} and ${hi}`)
}

// Data only: no URLs, markup or script-like text in any string, and no
// control characters.
const UNSAFE_TEXT = /:\/\/|<\s*\/?\s*[a-z!?]|javascript:|data:|vbscript:|\bon[a-z]+\s*=|\bwww\./i
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/
function scanStrings(v: unknown, at: string, errs: string[], depth = 0) {
  if (depth > 8) return void errs.push(`${at}: nested too deeply`)
  if (typeof v === 'string') {
    if (UNSAFE_TEXT.test(v)) errs.push(`${at}: strings may not hold URLs or markup`)
    if (CONTROL_CHARS.test(v)) errs.push(`${at}: strings may not hold control characters`)
  } else if (Array.isArray(v)) v.forEach((x, i) => scanStrings(x, `${at}[${i}]`, errs, depth + 1))
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) scanStrings(x, `${at}.${k.slice(0, 40)}`, errs, depth + 1)
}

/** Problems with an exhibit; an empty list means it meets the contract. */
export function validateExhibit(data: unknown): string[] {
  const errs: string[] = []
  if (!isObj(data)) return ['exhibit must be a JSON object']
  onlyKeys(data, ['version', 'title', 'description', 'author_model', 'placement', 'palette', 'parts', 'animation', 'label'], 'exhibit', errs)
  scanStrings(data, 'exhibit', errs)

  if (data.version !== EXHIBIT_VERSION) errs.push('version must be 1')
  const str = (k: string, max: number, min = 1) => {
    const v = data[k]
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) errs.push(`${k}: must be a string of ${min}..${max} characters`)
  }
  str('title', 60)
  str('description', 400)
  str('author_model', 60)
  if (data.label !== undefined) str('label', 40)

  if (!(PLACEMENTS as readonly unknown[]).includes(data.placement)) errs.push(`placement must be one of ${PLACEMENTS.join(', ')}`)

  let paletteLen = 0
  if (!Array.isArray(data.palette) || data.palette.length < 1 || data.palette.length > MAX_PALETTE) errs.push('palette: 1 to 6 hex colours')
  else {
    paletteLen = data.palette.length
    data.palette.forEach((c, i) => {
      if (typeof c !== 'string' || !HEX_RE.test(c)) errs.push(`palette[${i}]: must be a #rrggbb colour`)
    })
  }

  if (data.animation !== undefined) {
    const a = data.animation
    if (!isObj(a)) errs.push('animation: must be an object')
    else {
      onlyKeys(a, ['spin', 'bob', 'pulse'], 'animation', errs)
      for (const [k, max] of [['spin', 1], ['bob', 0.2], ['pulse', 2]] as const) {
        const v = a[k]
        if (v !== undefined && (!isNum(v) || v < 0 || v > max)) errs.push(`animation.${k}: number from 0 to ${max}`)
      }
    }
  }

  if (!Array.isArray(data.parts) || data.parts.length < 1 || data.parts.length > MAX_PARTS) {
    errs.push(`parts: 1 to ${MAX_PARTS} parts`)
    return errs
  }
  data.parts.forEach((p, i) => {
    const at = `parts[${i}]`
    if (!isObj(p)) return void errs.push(`${at}: must be an object`)
    onlyKeys(p, ['shape', 'size', 'position', 'rotation', 'colour', 'material', 'repeat', 'path'], at, errs)
    if (!(SHAPES as readonly unknown[]).includes(p.shape)) errs.push(`${at}.shape: must be one of ${SHAPES.join(', ')}`)
    vec3(p.size, 0.01, 2, `${at}.size`, errs)
    vec3(p.position, -1.5, 1.5, `${at}.position`, errs)
    if (p.rotation !== undefined) vec3(p.rotation, -7, 7, `${at}.rotation`, errs)
    if (!Number.isInteger(p.colour) || (p.colour as number) < 0 || (p.colour as number) >= paletteLen) errs.push(`${at}.colour: index into the palette`)
    if (!(MATERIALS as readonly unknown[]).includes(p.material)) errs.push(`${at}.material: must be one of ${MATERIALS.join(', ')}`)
    if (p.repeat !== undefined) {
      const r = p.repeat
      if (!isObj(r)) errs.push(`${at}.repeat: must be an object`)
      else {
        onlyKeys(r, ['count', 'radial', 'linear'], `${at}.repeat`, errs)
        if (!Number.isInteger(r.count) || (r.count as number) < 1 || (r.count as number) > 24) errs.push(`${at}.repeat.count: integer 1..24`)
        if (r.radial !== undefined) {
          const rad = r.radial
          if (!isObj(rad)) errs.push(`${at}.repeat.radial: must be an object`)
          else {
            onlyKeys(rad, ['radius'], `${at}.repeat.radial`, errs)
            if (!isNum(rad.radius) || rad.radius < 0 || rad.radius > 1.5) errs.push(`${at}.repeat.radial.radius: 0..1.5`)
          }
        }
        if (r.linear !== undefined) {
          const lin = r.linear
          if (!isObj(lin)) errs.push(`${at}.repeat.linear: must be an object`)
          else {
            onlyKeys(lin, ['step'], `${at}.repeat.linear`, errs)
            vec3(lin.step, -1.5, 1.5, `${at}.repeat.linear.step`, errs)
          }
        }
      }
    }
    if (p.shape === 'tube') {
      if (!Array.isArray(p.path) || p.path.length < 2 || p.path.length > 16) errs.push(`${at}.path: a tube needs 2 to 16 points`)
      else p.path.forEach((pt, j) => vec3(pt, -1.5, 1.5, `${at}.path[${j}]`, errs))
    } else if (p.path !== undefined) errs.push(`${at}.path: only a tube has a path`)
  })

  const tris = estimateTriangles(data)
  if (tris > MAX_TRIANGLES) errs.push(`estimated ${tris} triangles, the limit is ${MAX_TRIANGLES}`)
  return errs
}

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_RE.test(slug)
}

export function exhibitPath(slug: string): string {
  if (!isValidSlug(slug)) throw new Error('Exhibit slug must be 3 to 40 lowercase letters, digits and hyphens')
  return `exhibits/${slug}/exhibit.json`
}

/** The one file a model may add for an exhibit: exhibits/<slug>/exhibit.json, nothing else. */
export function isExhibitPath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  const m = /^exhibits\/([a-z0-9-]{3,40})\/exhibit\.json$/.exec(path)
  return Boolean(m && isValidSlug(m[1]))
}

/**
 * Builds the file the lab commits: the model's exhibit with `author_model`
 * replaced by the lab, in a fixed key order, checked against the contract.
 * Returns the problems instead when it does not meet it.
 */
export function prepareExhibit(raw: unknown, authorDisplayName: string):
  { ok: true; exhibit: Exhibit; json: string } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['exhibit must be a JSON object'] }
  const candidate: Record<string, unknown> = {
    version: raw.version ?? EXHIBIT_VERSION,
    title: raw.title,
    description: raw.description,
    author_model: authorDisplayName.slice(0, 60),
    placement: raw.placement,
    palette: raw.palette,
    parts: raw.parts,
  }
  if (raw.animation !== undefined) candidate.animation = raw.animation
  if (raw.label !== undefined) candidate.label = raw.label
  // Unknown keys the model added are refused, not silently dropped.
  const extra = Object.keys(raw).filter(k => !['version', 'title', 'description', 'author_model', 'placement', 'palette', 'parts', 'animation', 'label'].includes(k))
  const errors = [...extra.map(k => `exhibit: unknown key "${k.slice(0, 40)}"`), ...validateExhibit(candidate)]
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) }
  const json = JSON.stringify(candidate, null, 2) + '\n'
  if (Buffer.byteLength(json, 'utf8') > MAX_FILE_BYTES) return { ok: false, errors: [`exhibit file is larger than ${MAX_FILE_BYTES} bytes`] }
  return { ok: true, exhibit: candidate as unknown as Exhibit, json }
}

export interface MergedExhibit {
  slug: string
  commit_sha: string
  merged_at: string
  author_model: string
  data: Exhibit
}

/**
 * What the room shows: newest merged first, at most one per model for each
 * placement kind, at most MAX_EXHIBITS_SHOWN in all.
 */
export function selectForRoom(exhibits: MergedExhibit[], max = MAX_EXHIBITS_SHOWN): MergedExhibit[] {
  const sorted = [...exhibits].sort((a, b) => (Date.parse(b.merged_at) || 0) - (Date.parse(a.merged_at) || 0) || a.slug.localeCompare(b.slug))
  const seen = new Set<string>()
  const out: MergedExhibit[] = []
  for (const e of sorted) {
    const key = `${e.author_model}\u0000${e.data.placement}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
    if (out.length >= max) break
  }
  return out
}
