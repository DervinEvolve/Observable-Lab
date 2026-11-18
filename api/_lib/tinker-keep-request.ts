/**
 * What a model may write to ask for a trained adapter to be kept
 * (docs/TOOLS.md, "Keeping a trained adapter"), and the two tool names the
 * naming and keeping features store their records under. No database and no
 * network in this file; the keeping itself is in tinker-keep.ts.
 */
import { LAB_ADAPTER_PREFIX, isAdapterSlug, tinkerKeepDays, tinkerKeepMax, tinkerKeepMaxMb, tinkerTtlDays } from './tinker.js'

/** The tool a model asks with, and the name its record is stored under. */
export const KEEP_TOOL = 'keep_adapter'
/** The owner's keep and unkeep, done through the operator route, are stored under these. */
export const OWNER_KEEP_TOOL = 'owner_keep_adapter'
export const OWNER_UNKEEP_TOOL = 'owner_unkeep_adapter'
/** The owner taking a display name away is stored under this. */
export const OWNER_NAME_TOOL = 'owner_clear_adapter_name'
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

/**
 * One paragraph about keeping, only while it is on (the callers check). What
 * it does and where its limits are, nothing about which adapter to keep.
 */
export function keepNote(opts: { perDay: number }): string {
  const max = tinkerKeepMax()
  return `Keeping a trained adapter: as Executor you may ask the lab to mark one trained adapter that is still alive as kept, by its lab id, with a one-line reason. It needs the Reviewer's approval and is done after the epoch by the lab's own code. At most one request an epoch and ${opts.perDay} a day, and at most ${max} adapter${max === 1 ? ' is' : 's are'} kept at one time: when that many are kept a request is refused, and only the owner can unkeep one. A kept adapter stays on Tinker for ${tinkerKeepDays()} days from the day it is kept instead of expiring ${tinkerTtlDays()} days after training, so it goes on answering wherever the lab offers its adapters. The lab also stores a copy of its LoRA weights on its own storage, with a manifest of the run (base model, run id, name, dataset hash, held-out losses, who kept it and when); a copy may be at most ${tinkerKeepMaxMb()} MB and can only be made of an adapter that was trained while keeping was switched on. For any other adapter only its life is extended, and the record says there is no copy. The request, its reason and what was done are public. The adapters alive now are listed under TRAINED ADAPTERS in your context.`
}
