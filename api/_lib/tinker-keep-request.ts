/**
 * What a model may write to ask for a trained adapter to be kept
 * (docs/TOOLS.md, "Keeping a trained adapter"), and the two tool names the
 * naming and keeping features store their records under. No database and no
 * network in this file; the keeping itself is in tinker-keep.ts.
 */
import { LAB_ADAPTER_PREFIX, isAdapterSlug } from './tinker.js'

/** The tool a model asks with, and the name its record is stored under. */
export const KEEP_TOOL = 'keep_adapter'
/** The owner's keep and unkeep, done through the operator route, are stored under these. */
export const OWNER_KEEP_TOOL = 'owner_keep_adapter'
export const OWNER_UNKEEP_TOOL = 'owner_unkeep_adapter'
/**
 * The tool a refused display name is stored under. Not "tinker_train": a row
 * under that name would read as the epoch's training run having been dealt
 * with, and the run would not start.
 */
export const TINKER_NAME_TOOL = 'tinker_name'

export const KEEP_REASON_MAX = 200

export interface KeepRequest {
  /** The adapter's lab id without the "lab/" prefix. */
  slug: string
  /** One line: why this one. Stored and shown with the adapter. */
  reason: string
}

/** The slug in "lab/e41-0a1b2c3d" or "e41-0a1b2c3d", or null. */
export function keepSlugOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const id = v.trim()
  const slug = id.startsWith(LAB_ADAPTER_PREFIX) ? id.slice(LAB_ADAPTER_PREFIX.length) : id
  return isAdapterSlug(slug) ? slug : null
}

/**
 * Reads what was written under "keep_adapter". Strict, like a training
 * request: exactly "adapter" and "reason", the adapter by its lab id, the
 * reason one line of text. Anything else is a refusal with the reason.
 */
export function normalizeKeepRequest(raw: unknown): { request: KeepRequest } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object with "adapter" and "reason"' }
  const req = raw as Record<string, unknown>
  const extra = Object.keys(req).find(k => k !== 'adapter' && k !== 'reason')
  if (extra !== undefined) return { error: `unknown field: ${extra.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_'}` }
  const slug = keepSlugOf(req.adapter)
  if (!slug) return { error: 'adapter must be the lab id of a trained adapter, like lab/e41-0a1b2c3d' }
  if (typeof req.reason !== 'string') return { error: 'reason must be one line of text' }
  const reason = req.reason.replace(/\s+/g, ' ').trim()
  if (!reason) return { error: 'reason must be one line of text' }
  if (reason.length > KEEP_REASON_MAX) return { error: `reason may be at most ${KEEP_REASON_MAX} characters` }
  return { request: { slug, reason } }
}
