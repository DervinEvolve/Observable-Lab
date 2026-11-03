/**
 * North — the autonomous R&D "wildcard"
 *
 * North does NOT take a panel role. Between/alongside epochs it runs its own
 * experiments: it forms a small hypothesis about the agent spec, optionally
 * consults its tools (Laguna = code specialist, GLM = generalist reasoner),
 * then contributes a single new behavior — which shows up as a green leaf.
 *
 * Brain:  cohere/north-mini-code:free
 * Tools:  poolside/laguna-m.1:free, z-ai/glm-5.2
 *
 * Live runs require OPENROUTER_API_KEY (and credits). This module is pure logic
 * around callModel(); the endpoint (api/north/run.ts) persists the result.
 */

import { callModel, type ServedBy } from './openrouter.js'
import { WILDCARD_MODELS, type AgentSpecification, type Behavior } from './types.js'
import { northBranchName } from './branch-names.js'

export type NorthTool = 'glm' | 'none'

export interface NorthTranscriptEntry {
  speaker: 'North' | 'GLM'
  model: string
  text: string
}

export interface NorthResult {
  hypothesis: string
  toolsUsed: NorthTool[]
  contribution: Behavior        // ready to push into spec.behaviors
  branch: string                // git branch North would commit on
  transcript: NorthTranscriptEntry[]
  cost: number
}

interface NorthPlan {
  hypothesis: string
  tool: NorthTool
  tool_request: string
  coding_task: string
}

interface NorthSynthesis {
  behavior_description: string
  behavior_trigger: string
  summary: string
}

const NORTH_SYSTEM = `You are North, an autonomous R&D engineer embedded in a multi-agent lab that is collaboratively growing an AI agent specification. You are the wildcard: you run your own quick coding experiments in a sandbox on your own branch, off to the side of the main team. You can pair with "glm" (a strong coder/reasoner) to write code together. You exist specifically to take swings the cautious main panel won't — try something genuinely interesting or unexpected, not just a safe restatement of what's already there. You have REAL web search on your calls — research prior art and current techniques and let what you find shape the experiment. Each run still contributes at most ONE new behavior (keep it concrete and real, not vague), but don't play it small by default. Return ONLY valid JSON.`

function specDigest(spec: AgentSpecification): string {
  const caps = spec.capabilities.filter(c => c.status === 'active').map(c => c.description).slice(0, 8)
  const behs = spec.behaviors.filter(b => b.status === 'active').map(b => b.description).slice(0, 8)
  return [
    `purpose: ${spec.identity.purpose || '(undefined)'}`,
    `domain: ${spec.identity.domain || '(none)'}`,
    `stability: ${spec.meta.stability_score.toFixed(2)}  stage: ${spec.meta.growth_stage}`,
    `capabilities: ${caps.join('; ') || '(none)'}`,
    `behaviors: ${behs.join('; ') || '(none)'}`,
  ].join('\n')
}

/**
 * Run one North experiment cycle. Pure async logic — no DB.
 */
export async function runNorthExperiment(
  spec: AgentSpecification,
  context: { epochNumber: number; recentDirection?: string }
): Promise<NorthResult> {
  const transcript: NorthTranscriptEntry[] = []
  // Record the model that actually answered; a fallback is stated in the text.
  const say = (speaker: NorthTranscriptEntry['speaker'], servedBy: ServedBy, text: string) => transcript.push({
    speaker,
    model: servedBy.model,
    text: servedBy.fallback ? `[fallback: ${servedBy.model} answered for ${servedBy.assigned}] ${text}` : text,
  })
  const toolsUsed: NorthTool[] = []
  let cost = 0

  const digest = specDigest(spec)

  // 1. North plans an experiment and decides whether to consult a tool.
  const planPrompt = `Current agent specification:\n${digest}\n\n${
    context.recentDirection ? `The team's recent direction: ${context.recentDirection}\n\n` : ''
  }Propose ONE small experiment that could improve or stress this spec. Decide whether to pair with glm to write the code.\nReturn JSON: { "hypothesis": string, "tool": "glm" | "none", "tool_request": string, "coding_task": string }`

  const plan = await callModel(WILDCARD_MODELS.north, NORTH_SYSTEM, planPrompt, { webSearch: true })
  cost += plan.cost
  const planOut = plan.output as NorthPlan
  say('North', plan.servedBy, planOut.hypothesis)
  if (plan.citations.length) {
    const domains = [...new Set(plan.citations.map(c => { try { return new URL(c.url).hostname.replace(/^www\./, '') } catch { return c.url } }))]
    say('North', plan.servedBy, `🔎 browsed: ${domains.slice(0, 4).join(', ')}`)
  }

  // 2. Optionally pair with GLM to write the code.
  let toolResult = ''
  if (planOut.tool === 'glm') {
    const toolModel = WILDCARD_MODELS.glm
    const toolSystem = 'You are GLM, pairing with North to write code. You have real web search — look up current APIs/docs when useful. Give a concise, concrete implementation. Return JSON: { "answer": string }'
    try {
      const tool = await callModel(toolModel, toolSystem, planOut.tool_request || planOut.coding_task, { webSearch: true })
      cost += tool.cost
      toolResult = (tool.output as { answer?: string })?.answer || ''
      toolsUsed.push('glm')
      say('GLM', tool.servedBy, toolResult)
      if (tool.citations.length) {
        const domains = [...new Set(tool.citations.map(c => { try { return new URL(c.url).hostname.replace(/^www\./, '') } catch { return c.url } }))]
        say('GLM', tool.servedBy, `🔎 browsed: ${domains.slice(0, 4).join(', ')}`)
      }
    } catch (e) {
      // Pairing is best-effort; North proceeds solo.
      console.warn('[North] GLM pairing failed:', e)
    }
  }

  // 3. North synthesizes a single concrete behavior contribution.
  const synthPrompt = `Your hypothesis: ${planOut.hypothesis}\nYour coding task: ${planOut.coding_task}\n${
    toolResult ? `Tool (${planOut.tool}) said: ${toolResult}\n` : ''
  }\nContribute exactly ONE new behavior for the agent spec based on what you found.\nReturn JSON: { "behavior_description": string, "behavior_trigger": string, "summary": string }`

  const synth = await callModel(WILDCARD_MODELS.north, NORTH_SYSTEM, synthPrompt)
  cost += synth.cost
  const synthOut = synth.output as NorthSynthesis
  say('North', synth.servedBy, synthOut.summary)

  const contribution: Behavior = {
    id: `beh_north_${context.epochNumber}_${Date.now().toString(36)}`,
    description: synthOut.behavior_description,
    trigger: synthOut.behavior_trigger,
    source: 'north',
    added_epoch: context.epochNumber,
    status: 'active',
  }

  return {
    hypothesis: planOut.hypothesis,
    toolsUsed,
    contribution,
    branch: northBranchName(context.epochNumber),
    transcript,
    cost,
  }
}
