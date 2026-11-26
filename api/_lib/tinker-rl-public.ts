/**
 * The public record of Tinker RL, for GET /api/experiment (`rl_practice`) and
 * from there the room's practice bench.
 *
 * It is built from the stored run only: what was asked (the rubric in words,
 * the settings), the progress records the runner wrote and the lab stored
 * while the run went, and the result the lab stored when the runner finished.
 * Nothing is simulated. There is no checkpoint path, no split salt and no call
 * id in it, and every text in it is cleaned and cut.
 *
 * While a run is going, the state asks the runner how far it has got, at most
 * once every RL_PROGRESS_REFRESH_MS and with a short timeout, and stores what
 * it is told on the run's row. Collecting the run's result stays with the
 * follow-up and the hourly tick.
 */
import { modelDisplayName } from './types.js'
import { tinkerJobsConfigured, trainedChatStatus } from './tinker.js'
import { pollTinkerJob } from './tinker-client.js'
import {
  RL_PROGRESS_REFRESH_MS, readRlSettings, rlCutOff, rlCutOffFlag, rlHackingFlag, rlHoldoutCount, progressIsLive, publicText, storedRlProgress, tinkerRlStatus,
  type RlPractice, type RlPracticeRun, type RlProgress,
} from './tinker-rl.js'
import { TINKER_PRICE_TABLE_DATE } from './tinker.js'
import { latestRlRun, ORIGIN_MODELS, shownName, type TinkerRunRow } from './tinker-store.js'
import { storeRlProgress } from './tinker-rl-run.js'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const unit = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)

/** The run as visitors may see it. Pure: the row and the moment are all it reads. */
export function publicRlRun(row: TinkerRunRow, now: Date = new Date(), chatOn: boolean = trainedChatStatus().enabled): RlPracticeRun {
  const result = row.result ?? {}
  const record = (row.rl ?? {}) as Record<string, unknown>
  const progress = storedRlProgress(row.progress)
  const settings = readRlSettings(row.settings)
  const total = row.dataset_examples
  const heldOut = num(result.n_holdout) ?? (total >= 8 ? rlHoldoutCount(total) : null)
  const maxReward = unit(record.max_reward) ?? progress?.max_reward ?? unit(result.max_reward) ?? 1
  const before = unit(result.score_before) ?? progress?.score_before ?? null
  const after = unit(result.score_after) ?? progress?.score_after ?? null
  // The stored result first (what the runner returned at the end), then the record it wrote as it went. Either may hold no count.
  const cutBefore = rlCutOff(result.answers_before, result.capped_before) ?? rlCutOff(progress?.answers_before, progress?.capped_before)
  const cutAfter = rlCutOff(result.answers_after, result.capped_after) ?? rlCutOff(progress?.answers_after, progress?.capped_after)
  const means = progress?.means?.length ? progress.means : Array.isArray(result.step_means) ? (result.step_means as unknown[]).filter((x): x is number => unit(x) !== null) : []
  const status = row.status === 'reserved' ? 'running' : row.status
  const lines = Array.isArray(record.rubric_lines) ? (record.rubric_lines as unknown[]).slice(0, 8).map(l => publicText(l, 200)).filter(Boolean) : []
  const estimate = (record.estimate ?? {}) as Record<string, unknown>
  const name = shownName(row)
  const alive = row.status === 'ok' && Boolean(row.expires_at) && Date.parse(row.expires_at as string) > now.getTime()
  return {
    slug: row.slug,
    adapter: `lab/${row.slug}`,
    kind: 'rl',
    author_model: row.model,
    author_name: modelDisplayName(row.model) || row.model.split('/').pop() || row.model,
    epoch: row.epoch,
    base_model: row.base_model,
    task_set: typeof record.task_set === 'string' && record.task_set ? publicText(record.task_set, 48) : null,
    purpose: row.purpose ? publicText(row.purpose, 200) : null,
    ...(name ? { name } : {}),
    status,
    live: progressIsLive(progress, row.status, now),
    tasks: { total, held_out: heldOut, training: heldOut === null ? null : Math.max(0, total - heldOut) },
    rubric: lines,
    max_reward: maxReward,
    settings: 'settings' in settings ? settings.settings : null,
    progress,
    held_out: before !== null || after !== null
      ? { before, after, measured_by: 'the lab', tasks: heldOut }
      : null,
    hacking: rlHackingFlag({ means, maxReward, scoreBefore: before, scoreAfter: after }),
    cut_off: rlCutOffFlag({ before: cutBefore, after: cutAfter }),
    cost: {
      estimated_usd: row.cost_usd,
      max_usd: num(estimate.max_cost_usd) ?? (row.reserved_usd > 0 ? row.reserved_usd : null),
      basis: `an estimate from Tinker's published prices of ${TINKER_PRICE_TABLE_DATE}, not a billed amount`,
    },
    origin: ORIGIN_MODELS,
    ...(alive && chatOn ? { talk: `lab/${row.slug}` } : {}),
    created_at: row.created_at,
    finished_at: row.finished_at,
    reason: row.reason ? publicText(row.reason, 300) : null,
  }
}

let inflight: Promise<RlProgress | null> | null = null

/**
 * Asks the runner how far a run that is still going has got, if the record the
 * lab has is older than RL_PROGRESS_REFRESH_MS, and stores the answer. Never
 * throws, never waits more than a few seconds. The record it returns is the
 * newest one the lab has.
 */
export async function refreshRlProgress(row: TinkerRunRow, now: Date = new Date()): Promise<RlProgress | null> {
  const current = storedRlProgress(row.progress)
  if (row.status !== 'running' || !row.call_id || !tinkerJobsConfigured()) return current
  if (current && now.getTime() - Date.parse(current.updated_at) < RL_PROGRESS_REFRESH_MS) return current
  if (!inflight) {
    inflight = (async () => {
      try {
        const poll = await pollTinkerJob(row.call_id as string, row.slug, 4000)
        if (poll.state === 'running' && poll.progress !== undefined) return await storeRlProgress(row, poll.progress, now)
      } catch {
        // the record that was stored stays
      } finally {
        inflight = null
      }
      return null
    })()
  }
  return (await inflight) ?? current
}

let cached: { at: number; value: RlPractice } | null = null
const CACHE_MS = 4000

/**
 * What the public state says about Tinker RL: whether it is on (and why not),
 * and the newest run. Read at most every few seconds per server instance.
 */
export async function rlPractice(now: Date = new Date()): Promise<RlPractice> {
  if (cached && now.getTime() - cached.at < CACHE_MS && now.getTime() >= cached.at) return cached.value
  const status = tinkerRlStatus()
  let row = await latestRlRun()
  if (row && row.status === 'running') {
    const progress = await refreshRlProgress(row, now)
    if (progress) row = { ...row, progress: progress as unknown as Record<string, unknown> }
  }
  const value: RlPractice = {
    enabled: status.enabled,
    ...(!status.enabled && status.off_reason ? { off_reason: status.off_reason } : {}),
    run: row ? publicRlRun(row, now) : null,
  }
  cached = { at: now.getTime(), value }
  return value
}

/** For tests: forget what was read. */
export function resetRlPracticeCache(): void {
  cached = null
  inflight = null
}
