/**
 * Research-Lab integration: the autonomous ML research bench.
 *
 * Two responsibilities:
 *  1. GitHub I/O against the Research-Lab repo (train.py, results.tsv, wiki/)
 *     — autonomous commits are intentional. Model verdicts and reported metrics
 *     are experimental evidence, not independent evaluation or a security boundary.
 *  2. Modal runner client: start a fixed-budget training run with the
 *     agent-authored train.py, poll until the measured result comes back.
 *
 * Uses a separate RESEARCH_GITHUB_TOKEN scoped to the research repository.
 */

import { requireGitHubName, requireHttpsUrl } from './config.js'
import { labCommitIdentityFields, modelTrailers } from './commit-identity.js'

const API_BASE = 'https://api.github.com'
const BRANCH = 'main'

// No defaults: an unset owner or runner URL fails here instead of sending
// this deployment's tokens and generated code to another account.
const repoPath = () => {
  const owner = requireGitHubName('RESEARCH_GITHUB_OWNER', 'the research repository',
    (process.env.AI_AGENT_GITHUB_OWNER || '').trim() || undefined)
  const repo = requireGitHubName('RESEARCH_GITHUB_REPO', 'the research repository', 'Research-Lab')
  return `/repos/${owner}/${repo}`
}
const runnerStartUrl = () => requireHttpsUrl('RESEARCH_RUNNER_START_URL', 'the research runner')
const runnerStatusUrl = () => requireHttpsUrl('RESEARCH_RUNNER_STATUS_URL', 'the research runner')

function ghToken(): string {
  const t = process.env.RESEARCH_GITHUB_TOKEN
  if (!t) throw new Error('RESEARCH_GITHUB_TOKEN not configured')
  return t
}

function runnerToken(): string {
  const t = process.env.RESEARCH_RUNNER_TOKEN
  if (!t) throw new Error('RESEARCH_RUNNER_TOKEN not configured')
  return t
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

// ---------------------------------------------------------------------------
// Repo I/O
// ---------------------------------------------------------------------------

// The contents API only inlines files up to 1 MB. Asking for the "object"
// media type keeps the sha and size in the answer for larger files (content
// comes back empty with encoding "none"), and those are then read through the
// git blobs API, which serves up to 100 MB. A file that has bytes but decodes
// to fewer is an error, never an empty string: an empty ledger read would let
// appendResultsRow rewrite results.tsv as a single row.
async function readBlob(path: string, sha: string): Promise<string> {
  const res = await gh(`${repoPath()}/git/blobs/${encodeURIComponent(sha)}`)
  if (!res.ok) throw new Error(`getResearchFile(${path}) blob read failed: ${res.status}`)
  const blob = await res.json()
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error(`getResearchFile(${path}) blob came back without base64 content`)
  }
  const bytes = Buffer.from(blob.content, 'base64')
  if (typeof blob.size === 'number' && bytes.length !== blob.size) {
    throw new Error(`getResearchFile(${path}) blob read ${bytes.length} of ${blob.size} bytes`)
  }
  return bytes.toString('utf-8')
}

export async function getResearchFile(path: string): Promise<{ content: string; sha: string } | null> {
  const res = await gh(`${repoPath()}/contents/${path}?ref=${BRANCH}`, {
    headers: { Accept: 'application/vnd.github.object+json' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`getResearchFile(${path}) failed: ${res.status}`)
  const data = await res.json()
  if (data?.type !== undefined && data.type !== 'file') throw new Error(`getResearchFile(${path}) is not a file`)
  if (typeof data?.sha !== 'string' || !data.sha) throw new Error(`getResearchFile(${path}) answered without a sha`)
  const size = typeof data.size === 'number' ? data.size : null
  const inline = typeof data.content === 'string' && data.encoding !== 'none' ? Buffer.from(data.content, 'base64') : null
  if (inline && (size === null || inline.length === size)) {
    return { content: inline.toString('utf-8'), sha: data.sha as string }
  }
  return { content: await readBlob(path, data.sha), sha: data.sha as string }
}

export async function putResearchFile(
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<void> {
  const res = await gh(`${repoPath()}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
      // The owner's noreply identity; models are named in message trailers.
      ...labCommitIdentityFields(),
    }),
  })
  if (!res.ok) throw new Error(`putResearchFile(${path}) failed: ${res.status} ${await res.text()}`)
}

// Where a score came from. The runner labels every score it parses from the
// generated train.py's own output "experiment_stdout_unverified"; that label,
// the dataset and the harness hash travel with the score into every record.
export interface ResultProvenance {
  metrics_source: string | null
  dataset: string | null
  harness_sha256: string | null
  train_wall_seconds: number | null
}

export function provenanceOf(run: Partial<ResearchRunResult> | undefined): ResultProvenance {
  const text = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : null)
  const sha = typeof run?.harness_sha256 === 'string' && /^[0-9a-f]{64}$/.test(run.harness_sha256) ? run.harness_sha256 : null
  const wall = typeof run?.train_wall_seconds === 'number' && Number.isFinite(run.train_wall_seconds) ? run.train_wall_seconds : null
  return {
    // A score with no recorded source is treated as unverified too.
    metrics_source: text(run?.metrics_source) ?? (run?.metrics ? 'experiment_stdout_unverified' : null),
    dataset: text(run?.dataset),
    harness_sha256: sha,
    train_wall_seconds: wall,
  }
}

/** Git trailers for a commit that records a research result. */
export function provenanceTrailers(p: ResultProvenance): string {
  return [
    `Metrics-Source: ${p.metrics_source ?? 'none'}`,
    `Dataset: ${p.dataset ?? 'unknown'}`,
    `Harness-SHA256: ${p.harness_sha256 ?? 'unknown'}`,
    `Train-Wall-Seconds: ${p.train_wall_seconds === null ? 'unknown' : p.train_wall_seconds.toFixed(1)}`,
  ].join('\n')
}

const RESULTS_HEADER_V1 = 'epoch\tcommit\tval_bpb\ttrain_steps\ttrain_seconds\tpeak_vram_mb\tparams_m\tstatus\thypothesis'
const RESULTS_HEADER = `${RESULTS_HEADER_V1}\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds`

// Append one row to results.tsv (read-modify-write; single writer per epoch).
// Older ledgers get the provenance columns added to their header; their
// earlier rows simply have no values in those columns.
//
// Idempotent: an epoch that is retried after its repository writes already
// went through rebuilds exactly the same row from its saved outputs, and that
// row is not appended twice. Run 1's ledger got 2,326 rows for epoch 20 this
// way. A ledger whose first line is not a known header is left alone.
// Returns false when the row was already there.
export async function appendResultsRow(fields: {
  epoch: number
  commit: string
  val_bpb: number | null
  train_steps: number | null
  train_seconds: number | null
  peak_vram_mb: number | null
  params_m: number | null
  status: 'keep' | 'discard' | 'crash'
  hypothesis: string
  provenance: ResultProvenance
}): Promise<boolean> {
  const existing = await getResearchFile('results.tsv')
  let base = existing?.content?.trimEnd() || RESULTS_HEADER
  const newline = base.indexOf('\n')
  const header = (newline === -1 ? base : base.slice(0, newline)).replace(/\r$/, '')
  if (header === RESULTS_HEADER_V1) base = RESULTS_HEADER + (newline === -1 ? '' : base.slice(newline))
  else if (header !== RESULTS_HEADER) throw new Error('results.tsv does not start with a known header; not rewriting it')
  const fmt = (v: number | null, digits = 4) => (v === null || v === undefined ? '-' : v.toFixed(digits))
  const row = [
    fields.epoch,
    fields.commit,
    fmt(fields.val_bpb),
    fields.train_steps ?? '-',
    fmt(fields.train_seconds, 1),
    fmt(fields.peak_vram_mb, 0),
    fmt(fields.params_m, 3),
    fields.status,
    fields.hypothesis.replace(/[\t\n\r]/g, ' ').slice(0, 300),
    fields.provenance.metrics_source ?? '-',
    fields.provenance.dataset ?? '-',
    fields.provenance.harness_sha256 ?? '-',
    fmt(fields.provenance.train_wall_seconds, 1),
  ].join('\t')
  if (base.split('\n').some(line => line.replace(/\r$/, '') === row)) return false
  const unverified = fields.provenance.metrics_source === 'experiment_stdout_unverified' ? ', unverified' : ''
  await putResearchFile('results.tsv', base + '\n' + row + '\n',
    `results: epoch ${fields.epoch} — ${fields.status} (val_bpb ${fmt(fields.val_bpb)}${unverified})\n\n${provenanceTrailers(fields.provenance)}`,
    existing?.sha)
  return true
}

// Marks which experiment wrote a finding page (an HTML comment, invisible
// when GitHub renders the page).
const EXPERIMENT_MARKER = /<!-- oblab-experiment: ([A-Za-z0-9_-]{1,64}) -->/

// Auto-generated finding page: the durable record of one experiment.
//
// Epoch numbers restart with every experiment, so wiki/findings/epoch-NNN.md
// can already hold another experiment's page. That page is never overwritten:
// - the same page again (a retried epoch) is a no-op;
// - a page marked with this experimentId is updated in place;
// - anything else sends the new page to epoch-NNN-<first 8 of experimentId>.md,
//   and if that is taken too, or no experimentId was given, the write is refused.
// Returns the path written, or null when the page was already there unchanged.
export async function writeFindingPage(args: {
  epoch: number
  author: string
  hypothesis: string
  changeSummary: string
  verdict: 'keep' | 'revert'
  runStatus: string
  valBpb: number | null
  bestBpb: number
  reviewReason: string
  challengerNotes: string[]
  provenance: ResultProvenance
  experimentId?: string
}): Promise<string | null> {
  const experimentId = args.experimentId?.trim() || undefined
  if (experimentId && !/^[A-Za-z0-9_-]{1,64}$/.test(experimentId)) throw new Error('writeFindingPage: invalid experimentId')
  const stem = `wiki/findings/epoch-${String(args.epoch).padStart(3, '0')}`
  const delta = args.valBpb !== null ? (args.valBpb - args.bestBpb).toFixed(4) : 'n/a'
  const content = `# Epoch ${args.epoch}: ${args.hypothesis.slice(0, 90)}

- **Author:** ${args.author}
- **Verdict:** ${args.verdict.toUpperCase()} (run: ${args.runStatus})
- **val_bpb:** ${args.valBpb !== null ? args.valBpb.toFixed(4) : 'no result'} (Δ vs best-at-time: ${delta})
- **Score source:** ${args.provenance.metrics_source ?? 'none'}${
  args.provenance.metrics_source === 'experiment_stdout_unverified'
    ? ' (printed by the generated train.py itself; not independently evaluated or repeated)'
    : ''}
- **Dataset:** ${args.provenance.dataset ?? 'unknown'}
- **Harness SHA-256:** ${args.provenance.harness_sha256 ? '`' + args.provenance.harness_sha256 + '`' : 'unknown'}
- **Training wall time (measured by the runner):** ${args.provenance.train_wall_seconds !== null ? args.provenance.train_wall_seconds.toFixed(1) + ' s' : 'unknown'}

## Hypothesis
${args.hypothesis}

## Change
${args.changeSummary}

## Review
${args.reviewReason}

${args.challengerNotes.length ? `## Challenger concerns\n${args.challengerNotes.map(c => `- ${c}`).join('\n')}\n` : ''}
*Ledger: results.tsv, epoch ${args.epoch}.*
${experimentId ? `\n<!-- oblab-experiment: ${experimentId} -->\n` : ''}`
  const message = `wiki: finding for epoch ${args.epoch}\n\n${modelTrailers({ name: args.author })}\n${provenanceTrailers(args.provenance)}`
  const candidates = [`${stem}.md`, ...(experimentId ? [`${stem}-${experimentId.slice(0, 8)}.md`] : [])]
  for (const path of candidates) {
    const existing = await getResearchFile(path)
    if (!existing) {
      await putResearchFile(path, content, message)
      return path
    }
    if (existing.content === content) return null
    const owner = existing.content.match(EXPERIMENT_MARKER)?.[1]
    if (experimentId && owner === experimentId) {
      await putResearchFile(path, content, message, existing.sha)
      return path
    }
  }
  throw new Error(`writeFindingPage: ${stem}.md already holds a page from another experiment; not overwriting it`)
}

// ---------------------------------------------------------------------------
// Modal runner client
// ---------------------------------------------------------------------------

export interface ResearchRunMetrics {
  val_bpb: number
  train_steps: number
  train_seconds: number
  peak_vram_mb: number
  params_m: number
  tokens_seen: number
}

export interface ResearchRunResult {
  status: 'ok' | 'crash' | 'infra_error'
  metrics?: ResearchRunMetrics
  error?: string
  log_tail?: string
  gpu?: string
  wall_seconds?: number
  stage?: string
  metrics_source?: string     // 'experiment_stdout_unverified' for every parsed score
  dataset?: string
  harness_sha256?: string
  budget_s?: number
  train_wall_seconds?: number // measured by the runner around train.py
}

export async function startResearchRun(trainPy: string, budgetS: number): Promise<string> {
  const res = await fetch(runnerStartUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runnerToken()}` },
    body: JSON.stringify({ train_py: trainPy, budget_s: budgetS }),
  })
  if (!res.ok) throw new Error(`runner start failed: ${res.status}`)
  const data = await res.json()
  if (!data.call_id) throw new Error(`runner start rejected: ${JSON.stringify(data)}`)
  return data.call_id as string
}

export async function pollResearchRun(callId: string): Promise<
  { status: 'running' } | { status: 'done'; result: ResearchRunResult } | { status: 'failed'; error: string }
> {
  const url = new URL(runnerStatusUrl())
  url.searchParams.set('call_id', callId)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${runnerToken()}` } })
  if (!res.ok) return { status: 'failed', error: `status endpoint HTTP ${res.status}` }
  const data = await res.json()
  if (data.status === 'done') return { status: 'done', result: data.result as ResearchRunResult }
  if (data.status === 'failed') return { status: 'failed', error: String(data.error || 'unknown') }
  if (data.status === 'running') return { status: 'running' }
  return { status: 'failed', error: 'Runner returned an invalid status' }
}

// Poll to completion within a wall budget; null = still running at deadline
// (the caller persists the call_id and a later invocation resumes polling).
export async function awaitResearchRun(
  callId: string,
  maxWaitMs: number,
  pollMs = 15000
): Promise<ResearchRunResult | null> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const s = await pollResearchRun(callId)
    if (s.status === 'done') return s.result
    if (s.status === 'failed') return { status: 'infra_error', error: s.error }
    await new Promise(r => setTimeout(r, pollMs))
  }
  return null
}

