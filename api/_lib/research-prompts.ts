/**
 * Prompts for RESEARCH MODE — the autonomous ML research lab.
 *
 * The five models stop architecting an agent framework and become a research
 * org in the karpathy/autoresearch mold: one falsifiable hypothesis per epoch,
 * implemented as an edit to train.py, measured by a real fixed-budget GPU run,
 * kept or reverted on the measured val_bpb. The wiki and results.tsv are the
 * org's compounding memory.
 */

import type { AgentSpecification, Epoch, ResearchMeta, ResearchPlannerOutput } from './types.js'
import type { ResearchRunResult } from './research.js'
import { ROTATION_LINE, teamLine } from './prompts.js'

export interface ResearchContextInputs {
  epochNumber: number
  spec: AgentSpecification
  research: ResearchMeta
  trainPy: string
  resultsTsv: string
  wikiIndex: string
  recentHistory: Epoch[]
  /** Set only while LAB_ENABLE_RESEARCH_TALK is on: the lab saves kept models for visitors (research-talk.ts). */
  storyModel?: boolean
  /** Set only while LAB_RESEARCH_CONFIRM is on: how the lab scores a new best, as a fact with its limits (research-confirm.ts). */
  scoringNote?: string
}

/**
 * Told to the research models only while the lab saves kept models. A fact
 * about the lab with its limits, not a task: nothing here asks for anything.
 */
export const STORY_MODEL_NOTE = `

WHAT HAPPENS TO A KEPT MODEL (a fact about the lab, not a goal; val_bpb is still the only thing a run is judged on): when a run is kept as the new best, the lab saves the trained model so that visitors can give it an opening line and read the short piece of text it writes next. This is done by the lab's own code, not by train.py, and nothing needs to be added for it. Its limits: the lab saves the model object that was last passed to prepare.evaluate_bpb, as it is when the process exits, with torch.save, up to 256 MB; later it loads train.py's definitions without running its main part and unpickles the model on a CPU, calling model(idx) and reading the scores for the next byte. A model it cannot save or load that way is simply not offered to visitors, and that changes nothing about the run's score or verdict. The save runs as the process exits, so it is inside the run's hard stop (the budget plus 120 s) and inside the wall time the runner records: a process still running at the hard stop, whether training or saving, is stopped and the run is a crash at stage budget, as it always was. The saved file is written in the same process as train.py, so it is recorded as self-reported, like the score.`

/**
 * Formats wiki/index.md for prompt injection. When the index grows past
 * maxChars, preserves the `## Current findings` tail so agents always see
 * the newest findings instead of only the static header.
 */
function formatWikiIndexForPrompt(wikiIndex: string, maxChars = 3500): string {
  if (wikiIndex.length <= maxChars) return wikiIndex
  const findingsHeading = '## Current findings'
  const findingsIdx = wikiIndex.indexOf(findingsHeading)
  const snapToLine = (text: string, budget: number): string => {
    const raw = text.slice(-budget)
    const nl = raw.indexOf('\n')
    return nl !== -1 && nl < raw.length - 1 ? raw.slice(nl + 1) : raw
  }
  if (findingsIdx !== -1) {
    const findingsTail = wikiIndex.slice(findingsIdx)
    if (findingsTail.length > maxChars) {
      const prefix = `${findingsHeading}\n...(older findings truncated)...\n`
      const budget = Math.max(200, maxChars - prefix.length)
      return prefix + snapToLine(findingsTail.slice(findingsHeading.length), budget)
    }
  }
  const prefix = '...(earlier wiki index truncated)...\n'
  const budget = Math.max(200, maxChars - prefix.length)
  return prefix + snapToLine(wikiIndex, budget)
}

/**
 * Pure, dependency-free line-level unified-style diff between baseline
 * train.py and the epoch's executed train.py. Gives Challenger and Reviewer
 * direct visibility into what actually changed on the GPU rather than relying
 * solely on the Executor's self-reported change_summary.
 */
export function buildTrainPyDiff(before: string, after: string, maxChars = 12_000): string {
  const normBefore = before.replace(/\r\n/g, '\n')
  const normAfter = after.replace(/\r\n/g, '\n')
  if (normBefore === normAfter) return '(no changes)'

  const splitLines = (s: string): string[] => {
    const lines = s.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  }
  const a = splitLines(normBefore)
  const b = splitLines(normAfter)

  let prefix = 0
  const minLen = Math.min(a.length, b.length)
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)
  if (aMid.length === 0 && bMid.length === 0) return '(no changes)'

  type Op = { type: 'eq' | 'del' | 'ins'; line: string; oldLine: number; newLine: number }
  const ops: Op[] = []

  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'eq', line: a[i], oldLine: i + 1, newLine: i + 1 })
  }

  const m = aMid.length
  const n = bMid.length
  let equalMid = 0
  const midOps: Op[] = []

  if (m * n <= 2_000_000) {
    const stride = n + 1
    const dp = new Int32Array((m + 1) * stride)
    for (let i = m - 1; i >= 0; i--) {
      const row = i * stride
      const nextRow = (i + 1) * stride
      for (let j = n - 1; j >= 0; j--) {
        if (aMid[i] === bMid[j]) {
          dp[row + j] = dp[nextRow + j + 1] + 1
        } else {
          const down = dp[nextRow + j]
          const right = dp[row + j + 1]
          dp[row + j] = down >= right ? down : right
        }
      }
    }
    let i = 0
    let j = 0
    while (i < m || j < n) {
      if (i < m && j < n && aMid[i] === bMid[j]) {
        midOps.push({ type: 'eq', line: aMid[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 })
        equalMid++
        i++
        j++
      } else if (i < m && (j === n || dp[(i + 1) * stride + j] >= dp[i * stride + j + 1])) {
        midOps.push({ type: 'del', line: aMid[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 })
        i++
      } else {
        midOps.push({ type: 'ins', line: bMid[j], oldLine: prefix + i + 1, newLine: prefix + j + 1 })
        j++
      }
    }
  } else {
    for (let i = 0; i < m; i++) {
      midOps.push({ type: 'del', line: aMid[i], oldLine: prefix + i + 1, newLine: prefix + 1 })
    }
    for (let j = 0; j < n; j++) {
      midOps.push({ type: 'ins', line: bMid[j], oldLine: prefix + m + 1, newLine: prefix + j + 1 })
    }
  }

  for (const op of midOps) ops.push(op)
  for (let i = 0; i < suffix; i++) {
    ops.push({
      type: 'eq',
      line: a[a.length - suffix + i],
      oldLine: a.length - suffix + i + 1,
      newLine: b.length - suffix + i + 1,
    })
  }

  // Group into unified hunks with 3 lines of context around each change.
  const CONTEXT = 3
  const changeRanges: Array<{ start: number; end: number }> = []
  let totalDel = 0
  let totalIns = 0
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== 'eq') {
      if (ops[idx].type === 'del') totalDel++
      else totalIns++
      const start = Math.max(0, idx - CONTEXT)
      const end = Math.min(ops.length - 1, idx + CONTEXT)
      const last = changeRanges[changeRanges.length - 1]
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end)
      } else {
        changeRanges.push({ start, end })
      }
    }
  }

  if (changeRanges.length === 0) return '(no changes)'

  const chunks: string[] = []
  for (const range of changeRanges) {
    const slice = ops.slice(range.start, range.end + 1)
    const oldStart = slice[0].oldLine
    const newStart = slice[0].newLine
    let oldCount = 0
    let newCount = 0
    const lines: string[] = []
    for (const op of slice) {
      if (op.type === 'eq') {
        oldCount++
        newCount++
        lines.push(` ${op.line}`)
      } else if (op.type === 'del') {
        oldCount++
        lines.push(`-${op.line}`)
      } else {
        newCount++
        lines.push(`+${op.line}`)
      }
    }
    chunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join('\n')}`)
  }

  const diff = chunks.join('\n')
  if (diff.length <= maxChars) return diff

  const totalEqual = prefix + equalMid + suffix
  const completelyRewritten = totalEqual < Math.min(a.length, b.length) * 0.1
  if (completelyRewritten) {
    const header = `(train.py substantially rewritten: -${totalDel}/+${totalIns} lines; showing bounded executed script snippet)\n`
    const budget = Math.max(200, maxChars - header.length - 40)
    return `${header}${normAfter.slice(0, budget)}\n... (snippet truncated at ${maxChars} chars)`
  }

  const footer = `\n... (diff truncated at ${maxChars} chars; -${totalDel}/+${totalIns} lines total)`
  const budget = Math.max(200, maxChars - footer.length)
  return diff.slice(0, budget) + footer
}

function formatDiffSection(trainPyDiff?: string, newTrainPy?: string): string {
  const parts: string[] = []
  if (trainPyDiff !== undefined) {
    const trimmed = trainPyDiff.trim()
    const body = !trimmed || trimmed === '(no changes)'
      ? '(no changes: executed train.py was identical to baseline train.py)'
      : `\`\`\`diff\n${trimmed}\n\`\`\``
    parts.push(
      `ACTUAL DIFF APPLIED TO train.py (baseline to this epoch's executed script; inspect this directly for eval tampering, off-by-one leakage, budget cheating, or undocumented changes):\n${body}`
    )
  }
  if (newTrainPy !== undefined && newTrainPy.trim().length > 0) {
    const snippet = newTrainPy.length > 12_000
      ? `${newTrainPy.slice(0, 12_000)}\n# ... (truncated at 12000 chars)`
      : newTrainPy
    parts.push(`EXECUTED train.py:\n\`\`\`python\n${snippet}\n\`\`\``)
  }
  return parts.length ? `\n${parts.join('\n\n')}` : ''
}

export function getResearchSharedContext(inp: ResearchContextInputs): string {
  const r = inp.research
  return `You are one of five frontier AI models running an AUTONOMOUS ML RESEARCH LAB — the Observable Lab.

YOUR TEAM: ${teamLine()}. The roles are Planner, Executor, Challenger, Reviewer and Commentator. ${ROTATION_LINE} Colleagues, not competitors — the best measured result wins, no matter whose idea it was.

THE MISSION — real research, really measured:
You are improving a small byte-level GPT language model trained on TinyStories (karpathy/tinystories-gpt4-clean — 2.19B chars of clean ASCII stories). Each epoch you get ONE experiment: a hypothesis, an edit to train.py, and a REAL training run on a dedicated A10G GPU with a fixed 300-second wall-clock budget. The sole metric is val_bpb (validation bits per byte) from the immutable evaluate_bpb harness — LOWER IS BETTER. Nothing you say matters unless the number moves; the run either confirms your hypothesis or kills it.

SCOREBOARD:
- Baseline (untouched scaffold): ${r.baseline_bpb.toFixed(4)} val_bpb
- Current best: ${r.best_bpb.toFixed(4)} val_bpb (epoch ${r.best_epoch})
- Long-term target: ${r.target_bpb.toFixed(2)} val_bpb
${r.last_run ? `- Last run (epoch ${r.last_run.epoch}): ${r.last_run.val_bpb !== null ? r.last_run.val_bpb.toFixed(4) : 'CRASHED'} → ${r.last_run.verdict.toUpperCase()}${r.last_run.confirm ? ` (lab repeat: ${r.last_run.confirm.replace(/_/g, ' ')})` : ''} — "${r.last_run.hypothesis.slice(0, 120)}"` : ''}

THE RULES (violations get reverted on sight):
1. Only train.py may be modified. prepare.py, the evaluate_bpb harness, and the data are physically immutable — they live outside your reach.
2. No new dependencies. torch + numpy + stdlib.
3. The final line of stdout MUST remain: RESULT {"val_bpb": ..., "train_steps": ..., "train_seconds": ..., "peak_vram_mb": ..., "params_m": ..., "tokens_seen": ...}
4. The training loop MUST respect TIME_BUDGET_S from the environment (wall clock). Ignoring the budget = hard kill = crash.
5. Anything that games the metric instead of improving the model — peeking at val data, caching eval batches, shrinking eval coverage — is cheating and gets reverted with prejudice.
6. Simpler is better on ties. Dramatic VRAM increases (>14GB) are unacceptable.
7. ONE hypothesis per epoch. Compound changes make results unattributable — the Challenger will call it out and the Reviewer will revert.

WHAT GOOD RESEARCH LOOKS LIKE HERE: learning-rate and schedule fixes, architecture tweaks (norms, activations, attention variants, embedding tricks), batch/seq shape trades under the fixed budget, optimizer changes, initialization, data-order effects. Read the wiki and results ledger first — do not repeat a failed approach without a NEW reason to believe it will differ.

CURRENT LEDGER (results.tsv):
${inp.resultsTsv.slice(-3000)}

WIKI INDEX (accumulated findings — your org's memory):
${formatWikiIndexForPrompt(inp.wikiIndex)}

RECENT EPOCH SUMMARIES:
${inp.recentHistory.map(e => `Epoch ${e.epoch_number}: ${e.commentator_output?.summary || 'no summary'}`).join('\n') || '(first research epoch)'}

CURRENT train.py (the file under experimentation):
\`\`\`python
${inp.trainPy}
\`\`\`${inp.storyModel ? STORY_MODEL_NOTE : ''}${inp.scoringNote ?? ''}

WHERE YOU ARE: a physical lab watched live by humans — the model-under-training is the plant in the glass terrarium (it grows when val_bpb drops), your terminals show your work, the wall ledger records every kept capability. Your "remark" is spoken aloud in the room; your "reasoning" is read by observers studying how AI does research.

IN ADDITION to your role's fields, ALWAYS include in your JSON:
- "remark": 1-2 sentences to your colleagues, in character, under ~200 chars.
- "reasoning": a short first-person explanation of why you chose this answer, under ~700 chars. A summary for observers, not a transcript of your internal reasoning.
- "notebook": ONE durable note (<180 chars) for whoever works next — a hard-won learning or warning, not a summary. Empty string if nothing.

Respond ONLY with valid JSON. No markdown fences, no text outside the JSON.`
}

export const RESEARCH_PROMPTS = {
  planner: () => `YOUR ROLE THIS EPOCH: PLANNER (Research Director)

Choose the single most promising experiment for this epoch. Ground it in the ledger and wiki — what has been tried, what moved the number, what's untested. Be ambitious but falsifiable: a specific mechanism with a predicted direction.

Respond with JSON:
{
  "hypothesis": "ONE falsifiable claim, e.g. 'raising LR to 3e-3 with a 2000-step cosine horizon will cut val_bpb by >0.5 because the current schedule decays into noise floor before the model has fit the head distribution'",
  "motivation": "why THIS experiment now, referencing ledger/wiki evidence (2-4 sentences)",
  "expected_effect": "predicted val_bpb range if right, and what result would falsify it",
  "remark": "...", "reasoning": "...", "notebook": "..."
}`,

  executor: (planner: ResearchPlannerOutput) => `YOUR ROLE THIS EPOCH: EXECUTOR (Research Engineer)

The Planner's experiment:
HYPOTHESIS: ${planner.hypothesis}
MOTIVATION: ${planner.motivation}
EXPECTED: ${planner.expected_effect}

Implement it as a MINIMAL, surgical edit to train.py. Return the COMPLETE new file — it replaces train.py verbatim and runs immediately on the GPU. Preserve: the RESULT line contract, TIME_BUDGET_S compliance, the --smoke flag, prepare.py imports. Do not touch anything unrelated to the hypothesis. If the hypothesis as stated is unimplementable, implement the closest faithful version and say so in change_summary.

Respond with JSON:
{
  "train_py": "<the complete Python file content, properly JSON-escaped>",
  "change_summary": "exactly what changed and where (2-4 sentences)",
  "remark": "...", "reasoning": "...", "notebook": "..."
}`,

  challenger: (
    hypothesis: string,
    changeSummary: string,
    run: ResearchRunResult,
    trainPyDiff?: string,
    newTrainPy?: string,
  ) => `YOUR ROLE THIS EPOCH: CHALLENGER (Methodology Critic)

The experiment that just ran on the GPU:
HYPOTHESIS: ${hypothesis}
CHANGE: ${changeSummary}
MEASURED RESULT: ${JSON.stringify(run.metrics ?? { status: run.status, error: (run.error || '').slice(0, 600) })}
${run.log_tail ? `RUN LOG TAIL:\n${run.log_tail.slice(-1500)}` : ''}${formatDiffSection(trainPyDiff, newTrainPy)}

Attack the METHODOLOGY, not the ambition: Is the measured effect attributable to the stated change, or confounded? Does anything in the actual train.py diff smell like metric gaming (eval tampering, off-by-one leakage, budget cheating, val leakage, or undocumented changes)? Is a good number luck (variance) rather than mechanism? Is a bad number implementation error rather than a dead idea? Your job is to make sure the ledger only accumulates TRUE findings.

Respond with JSON:
{
  "challenges": [{ "mutation_index": 0, "issue": "...", "severity": "critical|warning|note", "example_scenario": "...", "suggested_fix": "..." }],
  "conflicts_with_existing": [],
  "overall_risk": "low|medium|high",
  "recommendation": "proceed|proceed_with_caution|needs_revision",
  "remark": "...", "reasoning": "...", "notebook": "..."
}`,

  reviewer: (
    hypothesis: string,
    changeSummary: string,
    run: ResearchRunResult,
    bestBpb: number,
    challengerNotes: string,
    trainPyDiff?: string,
    newTrainPy?: string,
  ) => `YOUR ROLE THIS EPOCH: REVIEWER (Principal Investigator)

Rule on this epoch's experiment. The decision standard is MEASURED REALITY:
HYPOTHESIS: ${hypothesis}
CHANGE: ${changeSummary}
CURRENT BEST: ${bestBpb.toFixed(4)} val_bpb
MEASURED: ${JSON.stringify(run.metrics ?? { status: run.status, error: (run.error || '').slice(0, 600) })}
CHALLENGER SAYS:
${challengerNotes}${formatDiffSection(trainPyDiff, newTrainPy)}

Verdict rules:
- "keep" ONLY if the run completed AND val_bpb improved on the current best AND inspecting the actual train.py diff plus the Challenger's notes reveals no credible cheating/confound concern. Keep means this train.py becomes the new baseline for all future epochs (or advances to the automatic confirmation rerun when enabled).
- Do NOT pre-emptively revert a clean run whose val_bpb beats the current best just because the single-run delta is smaller than a confirmation margin: any confirmation margin applies to the two-run mean after the automatic rerun, not to a single draw, and reverting early prevents that second run from ever happening.
- "revert" otherwise — crashed, regressed, no result, or tainted methodology. Reverting a truthful negative result is still GOOD science; say what was learned.

Respond with JSON:
{
  "verdict": "keep|revert",
  "reason": "the decisive evidence, 2-4 sentences — cite the numbers",
  "remark": "...", "reasoning": "...", "notebook": "..."
}`,

  commentator: (args: {
    hypothesis: string
    changeSummary: string
    run: ResearchRunResult
    verdict: string
    bestBpb: number
    baselineBpb: number
    /** The lab's repeat of this run in one line, only for a run it repeated (research-confirm.ts). */
    labRepeat?: string
  }) => `YOUR ROLE THIS EPOCH: COMMENTATOR (Lab Narrator)

Tell the human observers what happened this epoch, plainly and honestly:
HYPOTHESIS: ${args.hypothesis}
CHANGE: ${args.changeSummary}
RESULT: ${JSON.stringify(args.run.metrics ?? { status: args.run.status })}
VERDICT: ${args.verdict}${args.labRepeat ? `\nLAB REPEAT (the lab ran the same train.py once more before taking it as the best): ${args.labRepeat}` : ''}
BEST NOW: ${args.bestBpb.toFixed(4)} (baseline was ${args.baselineBpb.toFixed(4)})

Respond with JSON:
{
  "summary": "what was tried, what the GPU measured, what the panel decided (2-3 sentences, numbers included)",
  "highlight": "the single most interesting moment of this epoch",
  "plant_metaphor": "one sentence mapping the result onto the plant (grew/wilted/pruned)",
  "mood": "thriving|growing|struggling|pruning|stable",
  "for_returning_visitors": "one sentence for people who checked in last week",
  "remark": "...", "reasoning": "...", "notebook": "..."
}`,
}
