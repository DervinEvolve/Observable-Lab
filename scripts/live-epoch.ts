/**
 * Live epoch runner — runs ONE real epoch through the actual pipeline
 * (real models via OpenRouter, the real prompts, the real JSON parsing),
 * with NO database. Proves the live collaboration works and prints the dialogue.
 *
 * Setup:  put your key in observable-lab/.env:   OPENROUTER_API_KEY=sk-or-...
 * Run:    npx tsx scripts/live-epoch.ts
 */
import { readFileSync } from 'node:fs'

// Load .env BEFORE importing the pipeline (openrouter.ts reads the key at module load).
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* no .env — rely on real env */ }

if (!process.env.OPENROUTER_API_KEY) {
  console.error('\n❌ OPENROUTER_API_KEY not set. Put it in observable-lab/.env and re-run.\n')
  process.exit(1)
}

// Dynamic imports so the modules load AFTER the key is in process.env.
const { callModel } = await import('../api/_lib/openrouter.js')
const { getRoleAssignments } = await import('../api/_lib/role-rotation.js')
const { getSharedContext, ROLE_PROMPTS } = await import('../api/_lib/prompts.js')
const { SEED_SPECIFICATION } = await import('../api/_lib/seed-spec.js')
const { MODEL_DISPLAY_NAMES } = await import('../api/_lib/types.js')

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

const epochNumber = 1
const spec = SEED_SPECIFICATION
const assignments = getRoleAssignments(epochNumber)
const ctx = getSharedContext(epochNumber, spec, [])

let totalCost = 0
function turn(role: string, modelId: string, out: Record<string, unknown>, detail?: string) {
  const name = MODEL_DISPLAY_NAMES[modelId as keyof typeof MODEL_DISPLAY_NAMES] || modelId
  console.log('\n' + bold(cyan(`${name}`)) + dim(`  · ${role}  (${modelId})`))
  if (out.remark) console.log('  💬 ' + String(out.remark))
  if (detail) console.log('  ' + dim(detail))
  if (out.reasoning) console.log('  🧠 ' + dim(String(out.reasoning)))
}

console.log(bold(`\n🌱 Observable Lab — LIVE epoch ${epochNumber}`))
console.log(dim(`Seed purpose: "${spec.identity.purpose}"`))
console.log(dim('Models: ' + Object.entries(assignments).map(([r, m]) => `${r}=${MODEL_DISPLAY_NAMES[m as keyof typeof MODEL_DISPLAY_NAMES]}`).join('  ')))

const planner = (await callModel(assignments.planner, ctx + '\n\n' + ROLE_PROMPTS.planner, 'What direction should we take this epoch?'))
totalCost += planner.cost
turn('Planner', assignments.planner, planner.output, `→ ${planner.output.direction}`)

const executor = (await callModel(assignments.executor, ctx + '\n\n' + ROLE_PROMPTS.executor(planner.output), "Implement the planner's direction with concrete mutations."))
totalCost += executor.cost
turn('Executor', assignments.executor, executor.output, `proposed ${executor.output.mutations?.length ?? 0} mutation(s)`)

const challenger = (await callModel(assignments.challenger, ctx + '\n\n' + ROLE_PROMPTS.challenger(executor.output), 'Stress-test the proposed changes. Find weaknesses.'))
totalCost += challenger.cost
turn('Challenger', assignments.challenger, challenger.output, `${challenger.output.challenges?.length ?? 0} concern(s), risk: ${challenger.output.overall_risk}`)

const reviewer = (await callModel(assignments.reviewer, ctx + '\n\n' + ROLE_PROMPTS.reviewer(executor.output, challenger.output), 'Make final decisions on each proposed mutation.'))
totalCost += reviewer.cost
const verdicts = (reviewer.output.decisions ?? []).map((d: { verdict: string }) => d.verdict).join(', ')
turn('Reviewer', assignments.reviewer, reviewer.output, `decisions: ${verdicts || 'none'}`)

const commentator = (await callModel(assignments.commentator, ctx + '\n\n' + ROLE_PROMPTS.commentator({
  planner: planner.output, executor: executor.output, challenger: challenger.output, reviewer: reviewer.output,
}), 'Summarize this epoch for human observers.'))
totalCost += commentator.cost
turn('Commentator', assignments.commentator, commentator.output, `"${commentator.output.summary}"`)

const emergent = commentator.output.emergent_behaviors ?? []
if (emergent.length) {
  console.log(bold('\n✨ Emergent:'))
  for (const e of emergent) console.log('  • ' + e.observation + dim(`  (${e.source})`))
}

console.log(dim(`\n— epoch complete · est. cost $${totalCost.toFixed(4)} —\n`))
