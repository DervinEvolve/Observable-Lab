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

/** What the contribution gets when the Executor does not choose: one explorer and the test writer, as before. */
export const DEFAULT_SUBAGENTS = { explore: 1, test: true } as const

export interface ToolPlan {
  subagents: { explore: number; test: boolean; chosen: boolean }
  sprite_session?: { purpose: string; commands: SessionCommand[] }
  gpu_job?: { purpose: string; script: string; weights?: WeightsRef }
  weights?: WeightsRequest
  exhibit?: { slug: string; exhibit: unknown }
  lab_proposal?: ProposalRequest
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
  for (const key of Object.keys(req)) {
    if (!(TOOL_NAMES as readonly string[]).includes(key)) plan.ignored.push({ tool: key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_', reason: 'unknown tool' })
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
    // the field is left alone, as any extra field always was.
    const named = config.weights.enabled && config.weights.per_day > 0 && g && typeof g === 'object' && g.weights !== undefined && g.weights !== null && g.weights !== false
      ? normalizeWeightsRef(g.weights) : null
    if ('error' in checked) plan.ignored.push({ tool: 'gpu_job', reason: checked.error })
    // A script written for weights it cannot have would only burn GPU time.
    else if (named && 'error' in named) plan.ignored.push({ tool: 'gpu_job', reason: named.error })
    else plan.gpu_job = { purpose: text(g.purpose, 200), script: checked.script, ...(named ? { weights: named.ref } : {}) }
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
  return plan
}
