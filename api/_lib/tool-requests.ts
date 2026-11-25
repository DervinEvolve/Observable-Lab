/**
 * Reads the optional "tools" object the Executor returns with its proposal
 * and turns it into what the lab will actually do. Only tools that are on
 * (tools-config.ts) and well formed are kept; everything else is listed in
 * `ignored` with a reason, logged, and stored as a skipped tool run. Nothing
 * here throws on model output.
 */
import { PER_EPOCH, TOOL_NAMES, type ToolConfig } from './tools-config.js'
import { normalizeSessionCommands, type SessionCommand } from './sprite-session.js'
import { normalizeGpuScript } from './gpu-jobs.js'
import { normalizeWeightsRef, normalizeWeightsRequest, type WeightsRef, type WeightsRequest } from './weights.js'
import { isValidSlug } from './exhibits.js'
import { normalizeProposal, type ProposalRequest } from './lab-proposals.js'
import { normalizeTinkerRequest, type TinkerRequest } from './tinker.js'
import { normalizeTinkerRlRequest, type TinkerRlRequest } from './tinker-rl.js'
import { KEEP_TOOL, TINKER_NAME_TOOL, normalizeKeepRequest, type KeepRequest } from './tinker-keep-request.js'
import {
  DATASETS_TOOL, namesDataset, normalizeDatasetRef, normalizeDatasetRequest, normalizeTinkerDatasetRequest,
  type DatasetRef, type DatasetRequest, type TinkerDatasetRequest,
} from './datasets.js'

/** What the contribution gets when the Executor does not choose: one explorer and the test writer, as before. */
export const DEFAULT_SUBAGENTS = { explore: 1, test: true } as const

export interface ToolPlan {
  subagents: { explore: number; test: boolean; chosen: boolean }
  sprite_session?: { purpose: string; commands: SessionCommand[] }
  gpu_job?: { purpose: string; script: string; weights?: WeightsRef; dataset?: DatasetRef }
  weights?: WeightsRequest
  /** A public dataset asked for (datasets.ts). Only while public datasets are on. */
  datasets?: DatasetRequest
  exhibit?: { slug: string; exhibit: unknown }
  lab_proposal?: ProposalRequest
  tinker_train?: TinkerRequest
  /** A Tinker RL request (tinker-rl.ts). An epoch has one Tinker run, so it never stands beside tinker_train. */
  tinker_rl?: TinkerRlRequest
  /**
   * A Tinker training request that names a shelf dataset instead of writing
   * its examples (datasets.ts). Only while public datasets are on, and never
   * together with tinker_train: it becomes one once the lab has read the rows.
   */
  tinker_train_dataset?: TinkerDatasetRequest
  keep_adapter?: KeepRequest
  ignored: Array<{ tool: string; reason: string }>
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export function planTools(raw: unknown, config: ToolConfig): ToolPlan {
  const plan: ToolPlan = { subagents: { ...DEFAULT_SUBAGENTS, chosen: false }, ignored: [] }
  if (raw === undefined || raw === null) return plan
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    plan.ignored.push({ tool: 'tools', reason: 'not an object' })
    return plan
  }
  const req = raw as Record<string, unknown>
  const keepOn = config.keep_adapter.enabled && config.keep_adapter.per_day > 0
  // Public datasets (datasets.ts). While they are off the key is an unknown
  // tool, a "dataset" on a GPU job is an extra field left alone, and a
  // "dataset" on a training request is an unknown field, all as they always were.
  const datasetsOn = config.datasets.enabled && config.datasets.per_day > 0
  // The Socratic lesson (tinker-tutor.ts): while it is off its key is an unknown tool, as it was before it existed.
  const tutorOn = config.tinker_tutor.enabled && config.tinker_tutor.per_day > 0
  for (const key of Object.keys(req)) {
    const known = (TOOL_NAMES as readonly string[]).includes(key) && (key !== KEEP_TOOL || keepOn) && (key !== DATASETS_TOOL || datasetsOn)
      && (key !== 'tinker_tutor' || tutorOn)
    if (!known) plan.ignored.push({ tool: key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_', reason: 'unknown tool' })
  }
  const off = (tool: (typeof TOOL_NAMES)[number]) => {
    if (req[tool] === undefined || req[tool] === null || req[tool] === false) return true
    if (!config[tool].enabled || config[tool].per_day <= 0) {
      plan.ignored.push({ tool, reason: 'not enabled' })
      return true
    }
    return false
  }

  if (!off('subagents')) {
    const s = req.subagents as Record<string, unknown>
    if (typeof s !== 'object' || Array.isArray(s)) plan.ignored.push({ tool: 'subagents', reason: 'not an object' })
    else {
      const explore = Number(s.explore)
      plan.subagents = {
        explore: Number.isInteger(explore) ? Math.max(0, Math.min(PER_EPOCH.explorers, explore)) : DEFAULT_SUBAGENTS.explore,
        test: typeof s.test === 'boolean' ? s.test : DEFAULT_SUBAGENTS.test,
        chosen: true,
      }
      if (Number.isInteger(explore) && explore > PER_EPOCH.explorers) {
        plan.ignored.push({ tool: 'subagents', reason: `explore capped at ${PER_EPOCH.explorers}` })
      }
    }
  }

  if (!off('sprite_session')) {
    const s = req.sprite_session as Record<string, unknown>
    const { commands, dropped } = normalizeSessionCommands(s && typeof s === 'object' ? s.commands : undefined)
    for (const d of dropped) plan.ignored.push({ tool: 'sprite_session', reason: d })
    if (commands.length) plan.sprite_session = { purpose: text(s.purpose, 200), commands }
    else plan.ignored.push({ tool: 'sprite_session', reason: 'no usable commands' })
  }

  if (!off('gpu_job')) {
    const g = req.gpu_job as Record<string, unknown>
    const checked = normalizeGpuScript(g && typeof g === 'object' ? g.script : undefined)
    // "weights" on a job is read only while public weights are on; otherwise
    // the field is left alone, as any extra field always was. The field is
    // optional, so an empty string means none, like leaving it out.
    const given = g && typeof g === 'object' ? g.weights : undefined
    const none = given === undefined || given === null || given === false || (typeof given === 'string' && !given.trim())
    const named = config.weights.enabled && config.weights.per_day > 0 && !none ? normalizeWeightsRef(given) : null
    // "dataset" on a job, the same way, read only while public datasets are on.
    const givenData = datasetsOn && g && typeof g === 'object' ? g.dataset : undefined
    const noData = givenData === undefined || givenData === null || givenData === false || (typeof givenData === 'string' && !givenData.trim())
    const namedData = !noData ? normalizeDatasetRef(givenData) : null
    if ('error' in checked) plan.ignored.push({ tool: 'gpu_job', reason: checked.error })
    // A script written for weights it cannot have would only burn GPU time.
    else if (named && 'error' in named) plan.ignored.push({ tool: 'gpu_job', reason: named.error })
    else if (namedData && 'error' in namedData) plan.ignored.push({ tool: 'gpu_job', reason: namedData.error })
    else plan.gpu_job = { purpose: text(g.purpose, 200), script: checked.script, ...(named ? { weights: named.ref } : {}), ...(namedData ? { dataset: namedData.ref } : {}) }
  }

  if (!off('weights')) {
    const checked = normalizeWeightsRequest(req.weights)
    if ('error' in checked) plan.ignored.push({ tool: 'weights', reason: checked.error })
    else plan.weights = checked.request
  }

  if (!off('exhibit')) {
    const e = req.exhibit as Record<string, unknown>
    const slug = e && typeof e === 'object' ? e.slug : undefined
    if (!isValidSlug(slug)) plan.ignored.push({ tool: 'exhibit', reason: 'slug must be 3 to 40 of a-z, 0-9 and -' })
    else if (!e.exhibit || typeof e.exhibit !== 'object') plan.ignored.push({ tool: 'exhibit', reason: 'no exhibit object' })
    else plan.exhibit = { slug, exhibit: e.exhibit }
  }

  if (!off('lab_proposal')) {
    const checked = normalizeProposal(req.lab_proposal)
    if ('error' in checked) plan.ignored.push({ tool: 'lab_proposal', reason: checked.error })
    else plan.lab_proposal = checked.proposal
  }

  // Asked once: a request for a tool that is off is recorded once.
  const tinkerOff = off('tinker_train')
  if (!tinkerOff && datasetsOn && namesDataset(req.tinker_train)) {
    // A training request that names a shelf dataset instead of writing its
    // examples. As strict as the inline form, and the same rule for a name.
    const checked = normalizeTinkerDatasetRequest(req.tinker_train)
    if ('error' in checked) plan.ignored.push({ tool: 'tinker_train', reason: checked.error })
    else {
      plan.tinker_train_dataset = checked.request
      if (checked.request.name_refused) {
        plan.ignored.push({ tool: TINKER_NAME_TOOL, reason: `name refused: ${checked.request.name_refused}; the run stands and the adapter gets no name` })
      }
    }
  } else if (!tinkerOff) {
    // Strict: a request that is not exactly what the lab accepts is refused whole, with the reason.
    const checked = normalizeTinkerRequest(req.tinker_train)
    if ('error' in checked) plan.ignored.push({ tool: 'tinker_train', reason: checked.error })
    else {
      plan.tinker_train = checked.request
      // A name that broke a rule is refused on its own, under its own tool
      // name, and the run stands without one. (Stored under "tinker_train"
      // it would read as the epoch's run having been dealt with.)
      if (checked.request.name_refused) {
        plan.ignored.push({ tool: TINKER_NAME_TOOL, reason: `name refused: ${checked.request.name_refused}; the run stands and the adapter gets no name` })
      }
    }
  }

  // Tinker RL (tinker-rl.ts). An epoch has one Tinker run of either kind: when
  // the answer asks for both, the training run keeps its place and the RL
  // request is refused with that reason.
  const rlOff = off('tinker_rl')
  if (!rlOff) {
    if (plan.tinker_train || plan.tinker_train_dataset || (req.tinker_train !== undefined && req.tinker_train !== null && req.tinker_train !== false && config.tinker_train.enabled && config.tinker_train.per_day > 0)) {
      plan.ignored.push({ tool: 'tinker_rl', reason: 'an epoch has one Tinker run and this answer also asks for tinker_train' })
    } else {
      const checked = normalizeTinkerRlRequest(req.tinker_rl)
      if ('error' in checked) plan.ignored.push({ tool: 'tinker_rl', reason: checked.error })
      else {
        plan.tinker_rl = checked.request
        if (checked.request.name_refused) {
          plan.ignored.push({ tool: TINKER_NAME_TOOL, reason: `name refused: ${checked.request.name_refused}; the run stands and the adapter gets no name` })
        }
      }
    }
  }

  // Keeping a trained adapter (tinker-keep.ts). While it is off the key is
  // an unknown tool, as it always was.
  if (keepOn && req[KEEP_TOOL] !== undefined && req[KEEP_TOOL] !== null && req[KEEP_TOOL] !== false) {
    const checked = normalizeKeepRequest(req[KEEP_TOOL])
    if ('error' in checked) plan.ignored.push({ tool: KEEP_TOOL, reason: checked.error })
    else plan.keep_adapter = checked.request
  }

  // A public dataset for the lab's shelf (datasets.ts), only while it is on.
  if (datasetsOn && req[DATASETS_TOOL] !== undefined && req[DATASETS_TOOL] !== null && req[DATASETS_TOOL] !== false) {
    const checked = normalizeDatasetRequest(req[DATASETS_TOOL])
    if ('error' in checked) plan.ignored.push({ tool: DATASETS_TOOL, reason: checked.error })
    else plan.datasets = checked.request
  }
  return plan
}
