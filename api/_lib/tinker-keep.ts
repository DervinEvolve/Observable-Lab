/**
 * Keeping a trained adapter (docs/TOOLS.md, "Keeping a trained adapter").
 *
 * An adapter normally expires LAB_TINKER_TTL_DAYS after it was trained. When
 * LAB_ENABLE_TINKER_KEEP is on, an adapter can be marked to keep in two ways:
 * the owner asks through the operator route (api/experiment/trained-adapters.ts),
 * or a model asks with the "keep_adapter" tool and the Reviewer approves it.
 * At most LAB_TINKER_KEEP_MAX adapters are kept at one time, and one epoch
 * may ask for one. Only the owner can unkeep. A keep lasts as long as the
 * life it sets on Tinker (LAB_TINKER_KEEP_DAYS): when that has run out the
 * adapter is gone like any other, its place is given back and the record
 * says so. The copy on the Volume stays.
 *
 * Keeping does two things, both done by the lab's own runner on Modal
 * (modal/tinker_jobs.py), which is the only place the training key lives:
 *
 *   1. The adapter's sampler checkpoint on Tinker gets a long time to live
 *      (LAB_TINKER_KEEP_DAYS from the day it is kept), so the lab model
 *      endpoint and the visitor chat keep answering for it.
 *   2. A copy of its LoRA weights is written to the lab's own Modal Volume
 *      (oblab-kept-models), in PEFT format when the conversion works, with a
 *      manifest of the run. Tinker only lets weights be downloaded that were
 *      saved for download while the run was open, so a copy exists only for
 *      adapters trained while keeping was on. For an older adapter step 1 is
 *      done alone and the record says there is no copy.
 *
 * The order: check the adapter is alive; take a place among the kept (the
 * database holds the cap, tinker-store.ts); start the runner; wait a short
 * while. When the runner answers, the keep is closed and stored as evidence
 * in tool_runs. A keep still going when the wait ends is collected by a
 * later tick. A keep that fails gives its place back.
 *
 * No Tinker tokens are used and nothing here is priced: the caps are the
 * number of kept adapters and the size of a copy. Nothing here throws into
 * an epoch.
 */
import { randomBytes } from 'node:crypto'
import { recordToolRun, type ToolRunStatus } from './tool-runs-store.js'
import { modelDisplayName } from './types.js'
import {
  TINKER_KEEP_WAIT_MS, isSamplerPath, tinkerJobsConfigured, tinkerKeepDays, tinkerKeepFlag, tinkerKeepMax, tinkerKeepMaxMb, tinkerKeepStatus,
  tinkerTtlDays,
} from './tinker.js'
import { KEEP_EXPIRED_TOOL, KEEP_TOOL, OWNER_KEEP_TOOL, OWNER_NAME_TOOL, OWNER_UNKEEP_TOOL, type KeepRequest } from './tinker-keep-request.js'
import {
  findTinkerCall, keepJobId, pollTinkerJob, startTinkerJob, tinkerKeepBody, tinkerUnkeepBody, waitForTinkerJob, type TinkerPoll,
} from './tinker-client.js'
import { adapterExpiry } from './tinker-run.js'
import {
  KEPT_BY_OWNER, claimKeepSlot, clearAdapterName, externalPathOf, finishKeep, getKeep, getRun, keptByName, listAdapters, listKeeps, markKeepStarted, openKeeps,
  publicAdapter, releaseExpiredKeeps, releaseKeep, setAdapterExpiry, shownName,
  type KeepRow, type TinkerRunRow, type TrainedAdapter,
} from './tinker-store.js'

/** The Modal Volume the copies are written to (KEPT_VOLUME in modal/tinker_jobs.py). */
export const KEPT_VOLUME = 'oblab-kept-models'

/** Who asked for a keep: the owner, or a model in an epoch. */
export type KeepWho = { by: 'owner' } | { by: 'model'; modelId: string; experimentId: string; epoch: number }

export interface KeepOutcome {
  tool: string
  /** "started": the runner is still working; the record is written when its answer is collected. */
  status: ToolRunStatus | 'started'
  summary: string
}

const who = (keptBy: string) => keptByName(keptBy)
const modelName = (id: string) => modelDisplayName(id) || id.split('/').pop() || id

/** An adapter as the record names it: its lab id, and its display name when it has one. */
export function adapterLabel(run: Pick<TinkerRunRow, 'slug' | 'display_name'>): string {
  const name = shownName(run)
  return `lab/${run.slug}${name ? ` ("${name}")` : ''}`
}

function isAlive(run: TinkerRunRow | null, now: Date): run is TinkerRunRow & { sampler_path: string; expires_at: string } {
  return Boolean(run && run.status === 'ok' && isSamplerPath(run.sampler_path) && run.expires_at && Date.parse(run.expires_at) > now.getTime())
}

/** The run id inside a checkpoint path ("tinker://<run id>/sampler_weights/final"). */
function tinkerRunId(path: string | null): string | null {
  const m = /^tinker:\/\/([^/]+)\//.exec(path ?? '')
  return m ? m[1] : null
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The manifest written beside a kept copy: the lab's own record of the run.
 * Every value comes from the stored run; the one line a requester wrote is
 * the reason.
 */
export function keepManifest(run: TinkerRunRow, keep: Pick<KeepRow, 'kept_by' | 'reason' | 'requested_at'>): Record<string, unknown> {
  const result = run.result ?? {}
  return {
    schema: 'observable-lab/kept-adapter/1',
    lab_id: `lab/${run.slug}`,
    name: shownName(run),
    base_model: run.base_model,
    tinker_run_id: tinkerRunId(run.sampler_path),
    sampler_path: run.sampler_path,
    external_path: externalPathOf(run),
    epoch: run.epoch,
    author_model: run.model,
    purpose: run.purpose,
    dataset: { sha256: run.dataset_sha256, examples: run.dataset_examples, bytes: run.dataset_bytes },
    settings: run.settings,
    measured_by_the_lab: {
      what: 'mean cross-entropy per trained token on examples the lab held out; lower is better',
      holdout_examples: num(result.n_holdout), train_examples: num(result.n_train),
      holdout_loss_before: num(result.holdout_loss_before), holdout_loss_after: num(result.holdout_loss_after),
    },
    trained_at: run.created_at,
    kept_by: who(keep.kept_by),
    kept_reason: keep.reason,
    kept_at: keep.requested_at,
  }
}

// ---------------------------------------------------------------------------
// What the runner answers
// ---------------------------------------------------------------------------

export interface KeepFile { path: string; bytes: number; sha256: string }
export interface KeepCopy {
  /** ok: a copy is on the Volume. none: there was nothing to copy. error: copying failed. */
  status: 'ok' | 'none' | 'error'
  reason: string | null
  /** "peft": converted to PEFT. "tinker": the files as Tinker exported them (conversion did not work). */
  format: string | null
  dir: string | null
  bytes: number | null
  files: KeepFile[]
}
export interface KeepResult {
  /** ok: the time to live was set. Anything else: the adapter was not kept. */
  status: 'ok' | 'refused' | 'error' | 'failed'
  stage: string | null
  reason: string | null
  ttl_seconds: number | null
  copy: KeepCopy
  /** How many checkpoints the lab's Tinker account holds, when the runner could count them. */
  checkpoints: number | null
  wall_seconds: number | null
}

const short = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const SHA256 = /^[0-9a-f]{64}$/
const COPY_DIR = /^e[0-9]{1,6}-[0-9a-f]{8}$/

function plain(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

/** Reads the runner's answer to a keep or an unkeep. An "ok" with no time to live is not an ok. */
export function normalizeKeepResult(raw: unknown): KeepResult {
  const r = plain(raw)
  const c = plain(r.copy)
  const files: KeepFile[] = []
  for (const f of Array.isArray(c.files) ? c.files.slice(0, 16) : []) {
    const o = plain(f)
    const bytes = count(o.bytes)
    if (typeof o.path === 'string' && FILE_PATH.test(o.path) && !o.path.includes('..') && bytes !== null && typeof o.sha256 === 'string' && SHA256.test(o.sha256)) {
      files.push({ path: o.path, bytes, sha256: o.sha256 })
    }
  }
  const copied = c.status === 'ok' && typeof c.dir === 'string' && COPY_DIR.test(c.dir) && files.length > 0
  const copy: KeepCopy = copied
    ? { status: 'ok', reason: short(c.reason, 300) || null, format: short(c.format, 20) || null, dir: c.dir as string, bytes: count(c.bytes), files }
    : {
      status: c.status === 'none' ? 'none' : 'error',
      reason: short(c.reason, 300) || (c.status === 'ok' ? 'the runner named no files' : c.status === 'none' ? 'nothing to copy' : 'the copy failed'),
      format: null, dir: null, bytes: null, files: [],
    }
  const base: KeepResult = {
    status: 'failed', stage: short(r.stage, 30) || null, reason: null, ttl_seconds: count(r.ttl_seconds), copy,
    checkpoints: count(r.checkpoints), wall_seconds: num(r.wall_seconds),
  }
  if (r.status === 'refused') return { ...base, status: 'refused', reason: short(r.reason, 400) || 'refused' }
  if (r.status === 'error') return { ...base, status: 'error', reason: short(r.error, 400) || short(r.reason, 400) || 'the runner failed' }
  if (r.status !== 'ok') return { ...base, reason: 'the runner gave no usable answer' }
  if (!base.ttl_seconds) return { ...base, reason: 'the runner did not say the time to live was set' }
  return { ...base, status: 'ok' }
}

const megabytes = (bytes: number | null) => (bytes === null ? '?' : (bytes / 1e6).toFixed(1))

/** What happened to the copy, in words. */
export function describeCopy(copy: KeepCopy): string {
  if (copy.status === 'ok') {
    const format = copy.format === 'peft' ? 'PEFT format' : 'the files as Tinker exported them, not converted to PEFT'
    return `a copy of its LoRA weights is on the lab's Volume ${KEPT_VOLUME} under ${copy.dir}/ (${copy.files.length} file${copy.files.length === 1 ? '' : 's'}, ${megabytes(copy.bytes)} MB, ${format}${copy.reason ? `: ${copy.reason}` : ''})`
  }
  return `no copy of its weights was made: ${copy.reason ?? 'unknown'}`
}

// ---------------------------------------------------------------------------
// Keeping
// ---------------------------------------------------------------------------

/** Where a keep's record is stored: the epoch that asked, or the adapter's own epoch when the owner asked. */
function recordPlace(keep: KeepRow, run: TinkerRunRow) {
  return { experimentId: keep.experiment_id ?? run.experiment_id, epoch: keep.epoch ?? run.epoch, model: keep.kept_by }
}

const toolOf = (keptBy: string) => (keptBy === KEPT_BY_OWNER ? OWNER_KEEP_TOOL : KEEP_TOOL)

/**
 * Closes a keep with what the runner answered and stores the evidence. null
 * when another request closed the same keep first.
 */
async function completeKeep(keep: KeepRow, run: TinkerRunRow, poll: Extract<TinkerPoll, { state: 'done' | 'failed' }>): Promise<KeepOutcome | null> {
  const result = poll.state === 'done'
    ? normalizeKeepResult(poll.result)
    : { ...normalizeKeepResult(null), reason: `the runner was lost: ${poll.error}` }
  const tool = toolOf(keep.kept_by)
  const place = recordPlace(keep, run)
  const label = adapterLabel(run)
  const requestSummary = `keep ${label}: ${keep.reason ?? ''}`
  const durationMs = result.wall_seconds === null ? null : result.wall_seconds * 1000

  if (result.status !== 'ok' || !result.ttl_seconds) {
    const released = await releaseKeep(keep.slug, 'pending')
    if (!released) return null
    const reason = `${result.stage ? `at ${result.stage}: ` : ''}${result.reason ?? 'unknown'}`
    // A runner that answered says whether it set the time to live. One that
    // was lost says nothing, and may have set it before it stopped: the lab's
    // record then ends before Tinker's copy does. The record says so, since
    // a checkpoint left on Tinker counts against the account's storage.
    const lost = poll.state === 'failed'
    const until = (run.expires_at ?? '').slice(0, 10)
    const after = lost
      ? `in the lab's record it still expires on ${until}. The runner may have set the long time to live on Tinker before it was lost; if it did, the checkpoint stays on Tinker after the lab stops offering it. Keeping it again settles it, or the owner can set its time to live by hand`
      : `it still expires on ${until}`
    await recordToolRun({
      ...place, tool, requestSummary, status: 'error', durationMs,
      outputTail: `not kept: ${reason}; its place was given back and ${after}`,
      detail: {
        adapter: `lab/${run.slug}`, ...(shownName(run) ? { name: shownName(run) } : {}), kept_by: who(keep.kept_by), reason,
        ...(lost ? { tinker_time_to_live: 'unknown: the runner was lost' } : {}),
      },
    })
    return { tool, status: 'error', summary: `${label} was not kept: ${reason}` }
  }

  // Tinker counts the time to live from the moment the runner set it. The
  // keep's row was written before the runner was asked, so an expiry counted
  // from it is never after Tinker's.
  const expiresAt = adapterExpiry(keep.requested_at, result.ttl_seconds)
  const detail = {
    adapter: `lab/${run.slug}`,
    ...(shownName(run) ? { name: shownName(run) } : {}),
    kept_by: who(keep.kept_by),
    reason: keep.reason,
    kept_until: expiresAt,
    tinker: { ttl_seconds: result.ttl_seconds, checkpoints_in_account: result.checkpoints },
    copy: result.copy.status === 'ok'
      ? { status: 'ok', volume: KEPT_VOLUME, dir: result.copy.dir, format: result.copy.format, bytes: result.copy.bytes, files: result.copy.files, note: result.copy.reason }
      : { status: result.copy.status, reason: result.copy.reason },
    base_model: run.base_model,
    dataset_sha256: run.dataset_sha256,
  }
  const closed = await finishKeep(keep.slug, detail, expiresAt)
  if (!closed) return null
  // How many checkpoints the lab's Tinker key holds, when the runner could count them: Tinker stores 100 (or 100 GB) for free,
  // and past that a training session is stopped, so the number is part of the record of every keep.
  const held = result.checkpoints === null ? '' : `; the lab's Tinker key now holds ${result.checkpoints} checkpoint${result.checkpoints === 1 ? '' : 's'} (Tinker stores 100, or 100 GB, for free)`
  const line = `kept until ${expiresAt.slice(0, 10)} (its time to live on Tinker was set to ${Math.round(result.ttl_seconds / 86400)} days); ${describeCopy(result.copy)}${held}`
  await recordToolRun({ ...place, tool, requestSummary, status: 'ok', durationMs, outputTail: line, detail })
  return { tool, status: 'ok', summary: `${who(keep.kept_by)} kept ${label}: ${line}` }
}

/**
 * Marks an adapter to keep. The caller has checked who is asking (the
 * operator secret, or the Reviewer's approval and the per-day limit). A
 * refusal comes back as `skipped` with its reason, for the caller to store.
 */
export async function keepAdapter(request: KeepRequest, asker: KeepWho, opts: { maxWaitMs?: number; pollMs?: number } = {}): Promise<KeepOutcome> {
  const tool = asker.by === 'owner' ? OWNER_KEEP_TOOL : KEEP_TOOL
  const skipped = (reason: string): KeepOutcome => ({ tool, status: 'skipped', summary: reason })
  if (!tinkerKeepStatus().enabled) return skipped('keeping adapters is switched off')

  const now = new Date()
  let run: TinkerRunRow | null
  try {
    run = await getRun(request.slug)
  } catch (e) {
    console.warn('[tinker-keep] could not read the adapter:', e instanceof Error ? e.message : e)
    return skipped('the lab could not read its adapters, so nothing was changed')
  }
  if (!isAlive(run, now)) return skipped(`no trained adapter lab/${request.slug} is alive (adapters expire)`)

  // A place held by a kept adapter that has since expired is free again.
  await releaseExpired(now)

  const jobId = keepJobId('k', run.slug, randomBytes(4).toString('hex'))
  let claim: Awaited<ReturnType<typeof claimKeepSlot>>
  try {
    claim = await claimKeepSlot({
      slug: run.slug, keptBy: asker.by === 'owner' ? KEPT_BY_OWNER : asker.modelId, reason: request.reason,
      experimentId: asker.by === 'owner' ? null : asker.experimentId, epoch: asker.by === 'owner' ? null : asker.epoch,
      jobId, max: tinkerKeepMax(),
    })
  } catch (e) {
    console.warn('[tinker-keep] could not take a place:', e instanceof Error ? e.message : e)
    return skipped('the lab could not store the keep, so nothing was changed')
  }
  if (!claim.ok) return skipped(claim.reason)
  const keep = claim.row
  const label = adapterLabel(run)

  let started = await startTinkerJob(tinkerKeepBody({
    jobId, slug: run.slug, baseModel: run.base_model, samplerPath: run.sampler_path, externalPath: externalPathOf(run),
    ttlSeconds: tinkerKeepDays() * 24 * 60 * 60, maxBytes: tinkerKeepMaxMb() * 1024 * 1024, manifest: keepManifest(run, keep),
  }))
  if (!started.ok && started.unconfirmed) {
    const found = await findTinkerCall(jobId)
    if (found) started = { ok: true, callId: found }
  }
  if (!started.ok && started.unconfirmed) {
    // Nothing settles whether the runner started. The place stays taken; a
    // later tick asks the runner by name, and gives the place back if the
    // start is still unknown (collectTinkerKeeps).
    return { tool, status: 'error', summary: `keeping ${label}: ${started.error}; the lab asks the runner again at a later hourly check` }
  }
  if (!started.ok) {
    const released = await releaseKeep(keep.slug, 'pending').catch(() => null)
    if (released) {
      await recordToolRun({
        ...recordPlace(keep, run), tool, requestSummary: `keep ${label}: ${keep.reason ?? ''}`, status: 'error',
        outputTail: `not kept: ${started.error}; its place was given back`,
        detail: { adapter: `lab/${run.slug}`, kept_by: who(keep.kept_by), reason: started.error },
      })
    }
    return { tool, status: 'error', summary: `${label} was not kept: ${started.error}` }
  }
  await markKeepStarted(keep.slug, started.callId).catch(e =>
    console.warn('[tinker-keep] could not store the call id:', e instanceof Error ? e.message : e))

  const poll = await waitForTinkerJob(started.callId, opts.maxWaitMs ?? TINKER_KEEP_WAIT_MS, opts.pollMs ?? 5_000)
  if (poll.state === 'done' || poll.state === 'failed') {
    const outcome = await completeKeep({ ...keep, call_id: started.callId }, run, poll)
    if (outcome) return outcome
  }
  return { tool, status: 'started', summary: `keeping ${label} has started; the lab collects the result at a later hourly check` }
}

/**
 * A keep the runner has not answered for this long after it was asked for is
 * given up and its place given back. The keeper itself is stopped after 15
 * minutes, so this is not how long a keep may take: it is how long the lab
 * goes on asking. The tick comes once an hour and a keep asked for during an
 * epoch is most of an hour old at the first one, so anything under an hour
 * would let one status call that did not answer settle a keep that in fact
 * worked, with its year on Tinker set and nothing in the lab's record. Three
 * hours is at least three ticks. A runner that says the keep failed, or that
 * its result has expired, is believed at once.
 */
export const KEEP_LOST_AFTER_MS = 3 * 60 * 60 * 1000
/**
 * A keep with no call id this long after it was asked for never started as
 * far as the lab can tell. The runner is asked for the call by the keep's
 * name on every tick until then, and "no call known" is also what one failed
 * request looks like, so this is long enough for two ticks.
 */
export const KEEP_UNCONFIRMED_AFTER_MS = 90 * 60 * 1000
/** The most time one tick spends asking the runner about pending keeps. */
export const KEEP_COLLECT_BUDGET_MS = 30_000

/**
 * Gives back the places of kept adapters whose time on Tinker has run out,
 * and stores that each one did. The copy on the Volume is not touched. Never
 * throws.
 */
export async function releaseExpired(now: Date = new Date()): Promise<KeepOutcome[]> {
  const out: KeepOutcome[] = []
  try {
    for (const keep of await releaseExpiredKeeps(now)) {
      const run = await getRun(keep.slug).catch(() => null)
      if (!run) continue
      const label = adapterLabel(run)
      const copied = plain(plain(keep.detail).copy).status === 'ok'
      const line = `no longer kept: its time on Tinker ended on ${(run.expires_at ?? '').slice(0, 10)}, so it has expired like any other adapter and its place among the kept was given back. ${copied ? `The copy of its weights on the lab's Volume ${KEPT_VOLUME} stays.` : 'There was no copy of its weights.'}`
      await recordToolRun({
        experimentId: run.experiment_id, epoch: run.epoch, model: keep.kept_by, tool: KEEP_EXPIRED_TOOL,
        requestSummary: `kept adapter ${label} reached the end of its time on Tinker`, status: 'ok', outputTail: line,
        detail: { adapter: `lab/${run.slug}`, expired_at: run.expires_at, was_kept_by: who(keep.kept_by), was_kept_at: keep.kept_at, copy_stays: copied },
      })
      out.push({ tool: KEEP_EXPIRED_TOOL, status: 'ok', summary: `${label} is ${line}` })
      console.log(`[tinker-keep] lab/${keep.slug} expired and gave its place back`)
    }
  } catch (e) {
    console.warn('[tinker-keep] could not release expired keeps (non-fatal):', e instanceof Error ? e.message : e)
  }
  return out
}

/**
 * Collects the keeps that were still going when their request ended, and
 * gives back the places of kept adapters that have expired. Called
 * once on every tick. With LAB_ENABLE_TINKER_KEEP off it does nothing at
 * all: no query and no request. (A keep left pending when the switch was
 * turned off keeps its place until the switch is on again; no money is tied
 * to it.) Never throws.
 */
export async function collectTinkerKeeps(now: Date = new Date()): Promise<KeepOutcome[]> {
  if (!tinkerKeepFlag() || !tinkerJobsConfigured()) return []
  const out: KeepOutcome[] = []
  try {
    const giveUpAt = Date.now() + KEEP_COLLECT_BUDGET_MS
    const open = await openKeeps()
    out.push(...await releaseExpired(now))
    for (const keep of open) {
      if (Date.now() > giveUpAt) break
      const run = await getRun(keep.slug)
      if (!run) {
        await releaseKeep(keep.slug, 'pending')
        continue
      }
      const age = now.getTime() - new Date(keep.requested_at).getTime()
      let callId = keep.call_id
      if (!callId) {
        callId = await findTinkerCall(keep.job_id)
        if (callId) await markKeepStarted(keep.slug, callId).catch(() => {})
      }
      let settled: Extract<TinkerPoll, { state: 'done' | 'failed' }> | null
      if (!callId) {
        settled = age < KEEP_UNCONFIRMED_AFTER_MS ? null : { state: 'failed', error: 'its start was never confirmed' }
      } else {
        const poll = await pollTinkerJob(callId)
        settled = poll.state === 'done' || poll.state === 'failed' ? poll
          : age > KEEP_LOST_AFTER_MS ? { state: 'failed', error: 'no answer long after its time limit' } : null
      }
      if (!settled) continue
      const outcome = await completeKeep({ ...keep, call_id: callId }, run, settled)
      if (outcome) {
        out.push(outcome)
        console.log(`[tinker-keep] collected the keep of lab/${keep.slug}: ${outcome.status}`)
      }
    }
  } catch (e) {
    console.warn('[tinker-keep] could not collect keeps (non-fatal):', e instanceof Error ? e.message : e)
  }
  return out
}

// ---------------------------------------------------------------------------
// Unkeeping (the owner only)
// ---------------------------------------------------------------------------

export interface UnkeepOutcome {
  ok: boolean
  status: 'unkept' | 'not_kept' | 'pending' | 'failed'
  message: string
  expires_at?: string
}

/**
 * Takes the keep mark off an adapter. The runner sets the checkpoint's time
 * to live on Tinker back to the usual LAB_TINKER_TTL_DAYS, counted from now,
 * and removes the copy only when `removeCopy` is set. The mark is taken off
 * only once the runner has answered, so a call that times out changes
 * nothing in the lab's record and can simply be made again (setting a time
 * to live twice is harmless). With no runner configured the mark is taken
 * off in the lab's record alone and the answer says Tinker was not told.
 *
 * This works whether or not LAB_ENABLE_TINKER_KEEP is on, so the owner can
 * always undo a keep.
 */
export async function unkeepAdapter(slug: string, opts: { removeCopy?: boolean; maxWaitMs?: number; pollMs?: number } = {}): Promise<UnkeepOutcome> {
  let keep: KeepRow | null
  let run: TinkerRunRow | null
  try {
    // With keeping switched off the table is only looked at, never created: a lab that never kept anything has none.
    keep = tinkerKeepFlag() ? await getKeep(slug) : await getKeep(slug, { createTables: false }).catch(() => null)
    run = keep ? await getRun(slug) : null
  } catch (e) {
    console.warn('[tinker-keep] could not read the keep:', e instanceof Error ? e.message : e)
    return { ok: false, status: 'failed', message: 'The lab could not read its kept adapters. Nothing was changed.' }
  }
  if (!keep) return { ok: false, status: 'not_kept', message: `lab/${slug} is not kept.` }
  if (keep.status !== 'kept') return { ok: false, status: 'pending', message: `lab/${slug} is still being kept. Try again once that has finished.` }

  const startedAt = new Date()
  const ttlSeconds = tinkerTtlDays() * 24 * 60 * 60
  // An adapter whose kept time has already run out is gone from Tinker: there
  // is no time to live to set, and asking would fail. Its place is given back
  // in the lab's record and nothing else is touched.
  const alive = isAlive(run, startedAt)
  let told = 'Tinker was not told: no runner is configured, so set its time to live by hand (tinker checkpoint set-ttl).'
  let copyNote = 'The copy on the Volume was left where it is.'
  if (!alive) {
    told = 'It had already expired, so Tinker was not asked to change anything.'
    copyNote = opts.removeCopy === true
      ? `Any copy on the Volume was left where it is; remove it with: modal volume rm -r ${KEPT_VOLUME} ${slug}`
      : 'Any copy on the Volume was left where it is.'
  } else if (tinkerJobsConfigured() && run && isSamplerPath(run.sampler_path)) {
    const jobId = keepJobId('u', slug, randomBytes(4).toString('hex'))
    const started = await startTinkerJob(tinkerUnkeepBody({
      jobId, slug, samplerPath: run.sampler_path, externalPath: externalPathOf(run), ttlSeconds, removeCopy: opts.removeCopy === true,
    }))
    if (!started.ok) return { ok: false, status: 'failed', message: `The runner did not start (${started.error}). Nothing was changed; call again.` }
    const poll = await waitForTinkerJob(started.callId, opts.maxWaitMs ?? TINKER_KEEP_WAIT_MS, opts.pollMs ?? 5_000)
    if (poll.state !== 'done') {
      return { ok: false, status: 'failed', message: `The runner has not answered${poll.state === 'failed' ? ` (${poll.error})` : ' yet'}. Nothing was changed in the lab's record; call again.` }
    }
    const result = normalizeKeepResult(poll.result)
    if (result.status !== 'ok') {
      return { ok: false, status: 'failed', message: `The runner could not set the time to live (${result.reason ?? 'unknown'}). Nothing was changed; call again.` }
    }
    told = `Its time to live on Tinker was set to ${Math.round(ttlSeconds / 86400)} days from now.`
    if (opts.removeCopy === true) copyNote = short(plain(plain(poll.result).copy).reason, 200) || 'The copy on the Volume was removed.'
  }

  const released = await releaseKeep(slug, 'kept').catch(() => null)
  if (!released) return { ok: false, status: 'not_kept', message: `lab/${slug} is not kept any more.` }
  // An adapter that is alive gets the usual life from now. One that had expired keeps the date it expired on.
  const expiresAt = alive ? adapterExpiry(startedAt.toISOString(), ttlSeconds, startedAt) : run?.expires_at ?? startedAt.toISOString()
  if (alive) {
    await setAdapterExpiry(slug, expiresAt).catch(e =>
      console.warn('[tinker-keep] could not set the expiry after an unkeep:', e instanceof Error ? e.message : e))
  }
  const when = alive ? `it now expires on ${expiresAt.slice(0, 10)}` : `it expired on ${expiresAt.slice(0, 10)}`
  if (run) {
    await recordToolRun({
      experimentId: run.experiment_id, epoch: run.epoch, model: KEPT_BY_OWNER, tool: OWNER_UNKEEP_TOOL,
      requestSummary: `unkeep ${adapterLabel(run)}`, status: 'ok',
      outputTail: `no longer kept; ${when}. ${told} ${copyNote}`,
      detail: { adapter: `lab/${slug}`, expires_at: expiresAt, was_kept_by: who(released.kept_by), was_kept_at: released.kept_at },
    })
  }
  return { ok: true, status: 'unkept', message: `lab/${slug} is no longer kept; ${when}. ${told} ${copyNote}`, expires_at: expiresAt }
}

/**
 * Takes an adapter's display name away (the owner's route), and stores that
 * it was done. The adapter, its id and its record of training are not
 * touched. With names switched off and never used there is nothing to take.
 */
export async function removeAdapterName(slug: string): Promise<{ ok: boolean; message: string }> {
  const run = await getRun(slug)
  if (!run || !run.display_name) return { ok: false, message: `lab/${slug} has no display name.` }
  const cleared = await clearAdapterName(slug)
  if (!cleared) return { ok: false, message: `lab/${slug} has no display name.` }
  await recordToolRun({
    experimentId: run.experiment_id, epoch: run.epoch, model: KEPT_BY_OWNER, tool: OWNER_NAME_TOOL,
    requestSummary: `take the display name off lab/${slug}`, status: 'ok',
    outputTail: 'the display name was removed by the owner; the adapter is still addressed by its lab id',
    detail: { adapter: `lab/${slug}` },
  })
  return { ok: true, message: `lab/${slug} has no display name any more.` }
}

// ---------------------------------------------------------------------------
// What the owner's route shows
// ---------------------------------------------------------------------------

export interface KeepOverview {
  enabled: boolean
  off_reason?: string
  kept: number
  pending: number
  max: number
  adapters: TrainedAdapter[]
  keeps: Array<Pick<KeepRow, 'slot' | 'slug' | 'status' | 'reason' | 'requested_at' | 'kept_at' | 'detail'> & { kept_by: string }>
}

/** Every adapter that is alive, and every place that is taken, for the owner. */
export async function keepOverview(now: Date = new Date()): Promise<KeepOverview> {
  const status = tinkerKeepStatus()
  // With keeping switched off the table is only looked at, never created.
  const keeps = tinkerKeepFlag() ? await listKeeps() : await listKeeps({ createTables: false }).catch(() => [])
  const bySlug = new Map(keeps.map(k => [k.slug, k]))
  const adapters = (await listAdapters(now, 50)).map(t => t.adapter)
  // With the switch off the list above carries no keep marks; add them here so the owner still sees what is kept.
  const marked: TrainedAdapter[] = []
  for (const adapter of adapters) {
    const keep = bySlug.get(adapter.slug)
    if (adapter.kept || !keep || keep.status !== 'kept') marked.push(adapter)
    else {
      const run = await getRun(adapter.slug)
      marked.push(run ? publicAdapter(run, keep) : adapter)
    }
  }
  return {
    enabled: status.enabled, ...(status.off_reason ? { off_reason: status.off_reason } : {}),
    kept: keeps.filter(k => k.status === 'kept').length, pending: keeps.filter(k => k.status === 'pending').length, max: tinkerKeepMax(),
    adapters: marked,
    keeps: keeps.map(k => ({ slot: k.slot, slug: k.slug, status: k.status, kept_by: who(k.kept_by), reason: k.reason, requested_at: k.requested_at, kept_at: k.kept_at, detail: k.detail })),
  }
}

// ---------------------------------------------------------------------------
// What the models are told
// ---------------------------------------------------------------------------

function adapterFacts(a: TrainedAdapter): string {
  const loss = a.holdout_loss_before !== null && a.holdout_loss_after !== null
    ? `LAB-MEASURED held-out loss ${a.holdout_loss_before.toFixed(4)} before training, ${a.holdout_loss_after.toFixed(4)} after${a.holdout_examples ? `, on ${a.holdout_examples} held-out examples` : ''}`
    : 'no held-out score recorded'
  const kept = a.kept ? `, KEPT by ${a.kept_by ?? 'someone'}` : ''
  return `${a.model_id}${a.name ? ` "${a.name}"` : ''}: trained in epoch ${a.epoch} by ${a.author_name} on ${a.examples} examples, base model ${a.base_model}; ${loss}; ${a.expires_at ? `alive until ${a.expires_at.slice(0, 10)}` : 'no expiry recorded'}${kept}`
}

/**
 * The adapters alive now, one line each, for the shared context. Built from
 * the lab's stored runs only. Empty while keeping is off, when none is
 * alive, or when they cannot be read.
 */
export async function adaptersContext(now: Date = new Date()): Promise<string> {
  if (!tinkerKeepStatus().enabled) return ''
  try {
    const adapters = (await listAdapters(now, 20)).map(t => t.adapter)
    if (!adapters.length) return ''
    const kept = adapters.filter(a => a.kept).length
    return `${adapters.map(a => `- ${adapterFacts(a)}`).join('\n')}\n${kept} of ${tinkerKeepMax()} places for kept adapters are taken.`
  } catch (e) {
    console.warn('[tinker-keep] could not list adapters for the context (non-fatal):', e instanceof Error ? e.message : e)
    return ''
  }
}

/** What the Reviewer is told about a keep request: the lab's own record of that adapter, and how many places are left. */
export async function keepReviewFacts(request: KeepRequest, asker: { modelId: string }, now: Date = new Date()): Promise<{ line: string }> {
  const asked = `${modelName(asker.modelId)} asks the lab to mark adapter lab/${request.slug} as kept, with the reason: "${request.reason}"`
  try {
    const run = await getRun(request.slug)
    if (!isAlive(run, now)) return { line: `${asked}. The lab's record: no adapter with that id is alive, so nothing would be kept` }
    const keeps = await listKeeps()
    const taken = keeps.length
    const already = keeps.find(k => k.slug === run.slug)
    const facts = adapterFacts(publicAdapter(run, already ?? null))
    const copy = externalPathOf(run) ? 'a copy of its weights can be stored' : 'no copy of its weights can be stored (it was trained before keeping was switched on), so only its life would be extended'
    const places = already ? 'it is already kept or being kept, so the request would be refused' : `${taken} of ${tinkerKeepMax()} places are taken`
    return { line: `${asked}. The lab's record of it: ${facts}. If you approve, it stays on Tinker for ${tinkerKeepDays()} days from now and ${copy}; ${places}` }
  } catch (e) {
    console.warn('[tinker-keep] could not read the adapter for the Reviewer (non-fatal):', e instanceof Error ? e.message : e)
    return { line: `${asked}. The lab could not read its record of that adapter just now` }
  }
}
