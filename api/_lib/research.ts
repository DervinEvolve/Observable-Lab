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
import { modalGpuUsdPerSecond } from './tools-config.js'

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

// Outbound requests give up after these limits so a hung call can't eat the
// epoch's function budget. Polling has its own overall deadline on top.
const GITHUB_TIMEOUT_MS = 30_000
const RUNNER_TIMEOUT_MS = 60_000

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(GITHUB_TIMEOUT_MS),
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
      // The model in the Model: trailer is the author, the owner commits.
      ...labCommitIdentityFields(message),
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
  /**
   * Set only for a run the runner made with its save step in place (a run
   * started with a key while LAB_ENABLE_RESEARCH_TALK was on): the runner's
   * own name for that way of running, "keep-1". Such a run used a copy of
   * the harness with the save block appended, and its wall time includes the
   * save. The field is absent for every other run, so their records are
   * what they always were.
   */
  runner_flow?: string
}

/** The runner's name for a way of running other than the plain one, or undefined. */
export function runnerFlowOf(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(v) ? v : undefined
}

export function provenanceOf(run: Partial<ResearchRunResult> | undefined): ResultProvenance {
  const text = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : null)
  const sha = typeof run?.harness_sha256 === 'string' && /^[0-9a-f]{64}$/.test(run.harness_sha256) ? run.harness_sha256 : null
  const wall = typeof run?.train_wall_seconds === 'number' && Number.isFinite(run.train_wall_seconds) ? run.train_wall_seconds : null
  const flow = runnerFlowOf(run?.runner_flow)
  return {
    // A score with no recorded source is treated as unverified too.
    metrics_source: text(run?.metrics_source) ?? (run?.metrics ? 'experiment_stdout_unverified' : null),
    dataset: text(run?.dataset),
    harness_sha256: sha,
    train_wall_seconds: wall,
    ...(flow ? { runner_flow: flow } : {}),
  }
}

/** Git trailers for a commit that records a research result. */
export function provenanceTrailers(p: ResultProvenance): string {
  return [
    `Metrics-Source: ${p.metrics_source ?? 'none'}`,
    `Dataset: ${p.dataset ?? 'unknown'}`,
    `Harness-SHA256: ${p.harness_sha256 ?? 'unknown'}`,
    `Train-Wall-Seconds: ${p.train_wall_seconds === null ? 'unknown' : p.train_wall_seconds.toFixed(1)}`,
    // Only for a run made with the runner's save step in place.
    ...(p.runner_flow ? [`Runner-Flow: ${p.runner_flow}`] : []),
  ].join('\n')
}

const RESULTS_HEADER_V1 = 'epoch\tcommit\tval_bpb\ttrain_steps\ttrain_seconds\tpeak_vram_mb\tparams_m\tstatus\thypothesis'
const RESULTS_HEADER = `${RESULTS_HEADER_V1}\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds`
// With one more column, runner_flow. A ledger gets it the first time a run
// made with the runner's save step is written (the boundary such a run is),
// and from then on every row has the column: "keep-1" or the like for such a
// run, "-" for a plain one. A ledger that never sees such a run keeps the
// header above and its rows keep thirteen columns.
const RESULTS_HEADER_FLOW = `${RESULTS_HEADER}\trunner_flow`
// With five more columns for the lab's repeat of a run (research-confirm.ts,
// LAB_RESEARCH_CONFIRM): the repeat's score, the mean of the two runs, the
// noise and the margin the verdict used, and the verdict. A ledger gets them
// the first time a row is written while that switch is on, together with the
// runner_flow column if it did not have it yet, so there is one such header.
// From then on every row has nineteen columns; a row whose run was not
// repeated has "-" in the five. A ledger that never sees the switch keeps
// the header it has.
const RESULTS_CONFIRM_COLUMNS = 'repeat_val_bpb\tmean_val_bpb\tnoise_bpb\tmargin_bpb\tconfirm'
export const RESULTS_HEADER_CONFIRM = `${RESULTS_HEADER_FLOW}\t${RESULTS_CONFIRM_COLUMNS}`

/** What the lab's repeat of a run adds to its row in results.tsv. */
export interface ResultConfirmColumns {
  repeat_bpb: number | null
  mean_bpb: number | null
  noise_bpb: number | null
  margin_bpb: number | null
  verdict: 'confirmed' | 'within_noise' | 'not_confirmed'
}

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
  /**
   * Passed only while LAB_RESEARCH_CONFIRM is on: the lab's repeat of this
   * run, or null when the run was not repeated. Left out, the ledger and the
   * row are what they always were.
   */
  confirm?: ResultConfirmColumns | null
}): Promise<boolean> {
  const existing = await getResearchFile('results.tsv')
  let base = existing?.content?.trimEnd() || RESULTS_HEADER
  const newline = base.indexOf('\n')
  const header = (newline === -1 ? base : base.slice(0, newline)).replace(/\r$/, '')
  const rest = newline === -1 ? '' : base.slice(newline)
  const flow = fields.provenance.runner_flow
  let withConfirm = header === RESULTS_HEADER_CONFIRM
  let withFlow = withConfirm || header === RESULTS_HEADER_FLOW
  if (!withFlow && header !== RESULTS_HEADER_V1 && header !== RESULTS_HEADER) throw new Error('results.tsv does not start with a known header; not rewriting it')
  if (!withConfirm && fields.confirm !== undefined) {
    base = RESULTS_HEADER_CONFIRM + rest
    withConfirm = true
    withFlow = true
  } else if (!withFlow && flow) {
    base = RESULTS_HEADER_FLOW + rest
    withFlow = true
  } else if (header === RESULTS_HEADER_V1) base = RESULTS_HEADER + rest
  // The metrics are whatever the generated train.py printed. Only a real
  // number is written; anything else becomes "-", and no cell can carry a tab
  // or a line break, so one epoch can never write a second row.
  const fmt = (v: unknown, digits = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-')
  const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : '-')
  if (!Number.isSafeInteger(fields.epoch) || fields.epoch < 0) throw new Error('appendResultsRow: epoch is not a whole number')
  const row = [
    fields.epoch,
    fields.commit,
    fmt(fields.val_bpb),
    count(fields.train_steps),
    fmt(fields.train_seconds, 1),
    fmt(fields.peak_vram_mb, 0),
    fmt(fields.params_m, 3),
    fields.status,
    fields.hypothesis.replace(/[\t\n\r]/g, ' ').slice(0, 300),
    fields.provenance.metrics_source ?? '-',
    fields.provenance.dataset ?? '-',
    fields.provenance.harness_sha256 ?? '-',
    fmt(fields.provenance.train_wall_seconds, 1),
    ...(withFlow ? [flow ?? '-'] : []),
    ...(withConfirm ? [
      fmt(fields.confirm?.repeat_bpb), fmt(fields.confirm?.mean_bpb), fmt(fields.confirm?.noise_bpb),
      fmt(fields.confirm?.margin_bpb), fields.confirm?.verdict ?? '-',
    ] : []),
  ].map(cell => String(cell).replace(/[\t\n\r]/g, ' ')).join('\t')
  if (base.split('\n').some(line => line.replace(/\r$/, '') === row)) return false
  const unverified = fields.provenance.metrics_source === 'experiment_stdout_unverified' ? ', unverified' : ''
  const repeated = fields.confirm ? `; lab repeat: ${fields.confirm.verdict.replace(/_/g, ' ')}` : ''
  await putResearchFile('results.tsv', base + '\n' + row + '\n',
    `results: epoch ${fields.epoch} — ${fields.status} (val_bpb ${fmt(fields.val_bpb)}${unverified}${repeated})\n\n${provenanceTrailers(fields.provenance)}`,
    existing?.sha)
  return true
}

// The lab's own repeat runs (research-confirm.ts), one row each, in a ledger
// of their own: a repeat is not a model's epoch and has no row in
// results.tsv. `kind` is confirm (the repeat of a run that would have become
// the best; reference is that run's own score, in the same epoch) or control
// (the best train.py run again unchanged; reference is the best on record
// and the epoch it came from). The file is made the first time a repeat is
// written, so a research repository whose lab never repeats a run has none.
// runner_flow is the repeat's own flow, as on results.tsv: a repeat is
// started without a key, so it has no save step and the cell is "-" even
// when the run it repeats (whose row in results.tsv says keep-1) had one.
// A file written before the column existed gets the wider header the next
// time a row is added; its earlier rows are left as they were.
const LAB_REPEATS_HEADER_12 = 'kind\tepoch\ttrain_sha256\tval_bpb\tstatus\treference_bpb\treference_epoch\tmetrics_source\tdataset\tharness_sha256\ttrain_wall_seconds\tcall_id'
const LAB_REPEATS_HEADER = `${LAB_REPEATS_HEADER_12}\trunner_flow`
export const LAB_REPEATS_FILE = 'lab-repeats.tsv'

/**
 * Appends one lab repeat to lab-repeats.tsv. Idempotent like
 * appendResultsRow: the same row is not written twice, and a file that does
 * not start with the lab's header is left alone. Returns false when the row
 * was already there.
 */
export async function appendLabRepeatRow(fields: {
  kind: 'confirm' | 'control'
  epoch: number
  train_sha256: string
  val_bpb: number | null
  status: string
  reference_bpb: number | null
  reference_epoch: number | null
  provenance: ResultProvenance
  call_id: string | null
}): Promise<boolean> {
  if (!Number.isSafeInteger(fields.epoch) || fields.epoch < 0) throw new Error('appendLabRepeatRow: epoch is not a whole number')
  const existing = await getResearchFile(LAB_REPEATS_FILE)
  let base = existing?.content?.trimEnd() || LAB_REPEATS_HEADER
  const [first, ...rest] = base.split('\n')
  if (first.replace(/\r$/, '') === LAB_REPEATS_HEADER_12) base = [LAB_REPEATS_HEADER, ...rest].join('\n')
  else if (first.replace(/\r$/, '') !== LAB_REPEATS_HEADER) throw new Error(`${LAB_REPEATS_FILE} does not start with the lab's header; not rewriting it`)
  const fmt = (v: unknown, digits = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-')
  const word = (v: unknown, pattern: RegExp) => (typeof v === 'string' && pattern.test(v) ? v : '-')
  const row = [
    fields.kind,
    fields.epoch,
    word(fields.train_sha256, /^[0-9a-f]{64}$/),
    fmt(fields.val_bpb),
    word(fields.status, /^[a-z_]{1,20}$/),
    fmt(fields.reference_bpb),
    typeof fields.reference_epoch === 'number' && Number.isSafeInteger(fields.reference_epoch) && fields.reference_epoch >= 0 ? fields.reference_epoch : '-',
    fields.provenance.metrics_source ?? '-',
    fields.provenance.dataset ?? '-',
    fields.provenance.harness_sha256 ?? '-',
    fmt(fields.provenance.train_wall_seconds, 1),
    word(fields.call_id, /^[A-Za-z0-9_-]{1,80}$/),
    fields.provenance.runner_flow ?? '-',
  ].map(cell => String(cell).replace(/[\t\n\r]/g, ' ')).join('\t')
  if (base.split('\n').some(line => line.replace(/\r$/, '') === row)) return false
  const unverified = fields.provenance.metrics_source === 'experiment_stdout_unverified' ? ', unverified' : ''
  const what = fields.kind === 'confirm' ? `repeat of epoch ${fields.epoch}` : `control after epoch ${fields.epoch}`
  await putResearchFile(LAB_REPEATS_FILE, base + '\n' + row + '\n',
    `lab repeat: ${what}, ${word(fields.status, /^[a-z_]{1,20}$/)} (val_bpb ${fmt(fields.val_bpb)}${unverified})\n\n${provenanceTrailers(fields.provenance)}`,
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
  /** One line about the saved model, only for a run that was started with a key (research-talk.ts). */
  checkpointNote?: string
  /** The lab's repeat of this run in one plain line, only for a run it repeated (research-confirm.ts). */
  confirmNote?: string
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
    ? (args.confirmNote
      ? ' (printed by the generated train.py itself; not independently evaluated)'
      : ' (printed by the generated train.py itself; not independently evaluated or repeated)')
    : ''}${
  args.confirmNote
    ? `\n- **Lab repeat:** ${args.confirmNote.replace(/[\r\n]+/g, ' ').slice(0, 600)}. Both scores were printed by the generated train.py and are unverified: a repeat checks luck, not honesty`
    : ''}
- **Dataset:** ${args.provenance.dataset ?? 'unknown'}
- **Harness SHA-256:** ${args.provenance.harness_sha256 ? '`' + args.provenance.harness_sha256 + '`' : 'unknown'}
- **Training wall time (measured by the runner):** ${args.provenance.train_wall_seconds !== null ? args.provenance.train_wall_seconds.toFixed(1) + ' s' : 'unknown'}${
  args.provenance.runner_flow
    ? `\n- **Runner flow:** ${args.provenance.runner_flow} (run with the runner's save step in place: a copy of the harness with the save block appended, and the wall time above includes the save. A boundary for comparing with runs that have no such line)`
    : ''}
${args.checkpointNote ? `- **Saved model:** ${args.checkpointNote.replace(/[\r\n]+/g, ' ').slice(0, 400)}\n` : ''}
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

const WIKI_INDEX_PLACEHOLDER = '_(none yet -- this program has not run an epoch)_'

/**
 * Idempotently appends one concise bullet under `## Current findings` in
 * `wiki/index.md`, replacing the Day-0 placeholder if present. Leaves files
 * without a `## Current findings` section untouched (returns false).
 */
export async function updateWikiIndex(args: {
  epoch: number
  author: string
  verdict: 'keep' | 'revert'
  runStatus: string
  valBpb: number | null
  bestBpb: number
  hypothesis: string
  findingPath: string
  provenance: ResultProvenance
}): Promise<boolean> {
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 0) {
    throw new Error('updateWikiIndex: epoch is not a whole number')
  }
  const existing = await getResearchFile('wiki/index.md')
  if (!existing) return false

  const headingMatch = /^## Current findings[^\n]*$/m.exec(existing.content)
  if (!headingMatch) return false

  const padded = String(args.epoch).padStart(3, '0')
  if (existing.content.includes(`epoch-${padded}`) || existing.content.includes(`**e${args.epoch}**`)) {
    return false
  }

  const bpbText = args.valBpb !== null && Number.isFinite(args.valBpb)
    ? args.valBpb.toFixed(4)
    : `n/a (${args.runStatus})`
  const shortHyp = args.hypothesis.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 140)
  const cleanAuthor = args.author.replace(/[\r\n\t]+/g, ' ').trim()
  const relPath = args.findingPath.replace(/^wiki\//, '')
  const bullet = `- **e${args.epoch}** (${args.verdict.toUpperCase()}, val_bpb ${bpbText}, ${cleanAuthor}): ${shortHyp} — [finding](${relPath})`

  const sectionStart = headingMatch.index + headingMatch[0].length
  const rest = existing.content.slice(sectionStart)
  const nextHeading = /\n## /.exec(rest)
  const sectionBody = nextHeading ? rest.slice(0, nextHeading.index) : rest
  const afterSection = nextHeading ? rest.slice(nextHeading.index) : ''

  const withoutPlaceholder = sectionBody.replace(WIKI_INDEX_PLACEHOLDER, '')
  const trimmedBody = withoutPlaceholder.trimEnd()
  const newSectionBody = trimmedBody.trim() === ''
    ? `\n\n${bullet}\n`
    : `${trimmedBody}\n${bullet}\n`
  const tail = afterSection ? `\n${afterSection.replace(/^\n+/, '')}` : ''
  const updated = existing.content.slice(0, sectionStart) + newSectionBody + tail

  await putResearchFile(
    'wiki/index.md',
    updated,
    `wiki: index epoch ${args.epoch}\n\n${provenanceTrailers(args.provenance)}`,
    existing.sha
  )
  return true
}

// ---------------------------------------------------------------------------
// Modal runner client
// ---------------------------------------------------------------------------

export interface ResearchRunMetrics {
  val_bpb: number
  train_steps?: number
  train_seconds?: number
  peak_vram_mb?: number
  params_m?: number
  tokens_seen?: number
}

/**
 * What the runner says about saving a run's model (research-talk.ts). Only
 * on a result whose run was started with a key, which the lab sends only
 * while LAB_ENABLE_RESEARCH_TALK is on. The save ran in the same process as
 * the generated train.py, so the saved file is as self-reported as the score.
 */
export interface ResearchCheckpoint {
  key: string | null
  saved: boolean
  reason?: string
  bytes?: number
  sha256?: string
  params?: number
  seq_len?: number
  /** What the harness's evaluate_bpb returned for the saved model, seen inside the training process. */
  eval_bpb?: number
  /** How long the save step says it took, timed by itself inside the sandbox. Information only. */
  save_seconds?: number
  collect_seconds?: number
}

function cleanCheckpoint(raw: unknown): ResearchCheckpoint | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const c = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const out: ResearchCheckpoint = {
    key: typeof c.key === 'string' && /^e[0-9]{1,6}-[0-9a-f]{8}$/.test(c.key) ? c.key : null,
    saved: c.saved === true,
  }
  if (typeof c.reason === 'string') out.reason = c.reason.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 300)
  if (typeof c.sha256 === 'string' && /^[0-9a-f]{64}$/.test(c.sha256)) out.sha256 = c.sha256
  for (const key of ['bytes', 'params', 'seq_len', 'eval_bpb', 'save_seconds', 'collect_seconds'] as const) {
    const v = num(c[key])
    if (v !== undefined) out[key] = v
  }
  if (out.key === null || out.sha256 === undefined || out.bytes === undefined) out.saved = false
  return out
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
  train_wall_seconds?: number // measured by the runner around train.py's whole process
  checkpoint?: ResearchCheckpoint // only when the run was started with a key
  runner_flow?: string // only when the runner made the run with its save step in place ("keep-1")
}

/**
 * A run result as the lab will use it. The runner passes on the metrics
 * object the generated train.py printed after checking only val_bpb, so
 * every other value in it can be anything, a string with tabs and line
 * breaks included. Here each metric is kept only when it is a real number
 * (train_steps a whole one) and every other field only when it has the type
 * it should; a run marked ok with no usable val_bpb becomes a crash. Applied
 * to every result that arrives and to every stored result that is read back.
 */
export function sanitizeRunResult(raw: unknown): ResearchRunResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  let status: ResearchRunResult['status'] = r.status === 'ok' || r.status === 'crash' || r.status === 'infra_error' ? r.status : 'infra_error'
  let error = str(r.error)
  let metrics: ResearchRunMetrics | undefined
  const m = r.metrics && typeof r.metrics === 'object' ? r.metrics as Record<string, unknown> : null
  const bpb = num(m?.val_bpb)
  if (m && bpb !== undefined && bpb >= 0) {
    const steps = num(m.train_steps)
    metrics = { val_bpb: bpb }
    if (steps !== undefined && Number.isSafeInteger(steps) && steps >= 0) metrics.train_steps = steps
    for (const key of ['train_seconds', 'peak_vram_mb', 'params_m', 'tokens_seen'] as const) {
      const v = num(m[key])
      if (v !== undefined) metrics[key] = v
    }
  } else if (status === 'ok') {
    status = 'crash'
    error = error ?? 'the run reported no usable val_bpb'
  }
  const out: ResearchRunResult = { status }
  if (metrics) out.metrics = metrics
  if (error !== undefined) out.error = error
  for (const key of ['log_tail', 'gpu', 'stage', 'metrics_source', 'dataset', 'harness_sha256'] as const) {
    const v = str(r[key])
    if (v !== undefined) out[key] = v
  }
  for (const key of ['wall_seconds', 'budget_s', 'train_wall_seconds'] as const) {
    const v = num(r[key])
    if (v !== undefined) out[key] = v
  }
  // Present only on a run that was started with a key (research-talk.ts).
  const checkpoint = status === 'ok' ? cleanCheckpoint(r.checkpoint) : undefined
  if (checkpoint) out.checkpoint = checkpoint
  const flow = runnerFlowOf(r.runner_flow)
  if (flow) out.runner_flow = flow
  return out
}

/**
 * The GPU run was still training when this request stopped waiting for it.
 * Nothing failed: the call id is stored and the next tick collects the result.
 */
export class ResearchRunPendingError extends Error {
  constructor(public readonly callId: string) {
    super(`GPU run still in progress at poll deadline (call ${callId}) — epoch will resume next tick`)
    this.name = 'ResearchRunPendingError'
  }
}

// Seconds charged for a run whose own time never came back: the training
// budget plus the runner's grace for startup and evaluation and a minute for
// the sandbox to start. Errs high.
export const RESEARCH_RUN_OVERHEAD_S = 180

/**
 * What a research run's GPU time is recorded as, in dollars. An estimate:
 * the runner's whole measured time at the Modal GPU rate (tools-config.ts,
 * LAB_MODAL_GPU_USD_PER_SECOND), which counts the CPU-only preparation at
 * the GPU rate too, so it errs high. Modal's bill is not read back.
 */
export function researchGpuCostUsd(run: Pick<ResearchRunResult, 'wall_seconds'> | undefined, budgetS: number): number {
  const wall = run?.wall_seconds
  const seconds = typeof wall === 'number' && Number.isFinite(wall) && wall >= 0 ? wall : budgetS + RESEARCH_RUN_OVERHEAD_S
  return seconds * modalGpuUsdPerSecond()
}

/**
 * `keepKey` is passed only while LAB_ENABLE_RESEARCH_TALK is on: the runner
 * then saves the model this run trains as a candidate under that key
 * (research-talk.ts). Without it the request is the one it always was.
 */
export async function startResearchRun(trainPy: string, budgetS: number, keepKey?: string): Promise<string> {
  const res = await fetch(runnerStartUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runnerToken()}` },
    body: JSON.stringify({ train_py: trainPy, budget_s: budgetS, ...(keepKey ? { keep_key: keepKey } : {}) }),
    signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
  })
  if (!res.ok) throw new RunnerStartRefusedError(`runner start failed: ${res.status}`)
  const data = await res.json()
  if (!data.call_id) throw new RunnerStartRefusedError(`runner start rejected: ${JSON.stringify(data)}`)
  return data.call_id as string
}

/**
 * The runner (or the gateway in front of it) answered a start with an HTTP
 * error, or with no call id: no call was handed back, so the lab takes it
 * that no run was started. Any other failure of startResearchRun (no answer
 * in time, a connection that broke, an answer that cannot be read) says
 * nothing either way: the run may have been started.
 */
export class RunnerStartRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerStartRefusedError'
  }
}

/**
 * `reported` is set on a failure only when the runner itself answered that
 * the call failed or that its result is gone. A failure without it means the
 * status endpoint could not be read (a gateway error, an answer that is not
 * the runner's), which says nothing about the run. Both the lab's own repeats
 * (research-confirm.ts) and awaitResearchRun tell the two apart so a transient
 * status-endpoint error does not discard an in-flight GPU run.
 */
export async function pollResearchRun(callId: string): Promise<
  { status: 'running' } | { status: 'done'; result: ResearchRunResult } | { status: 'failed'; error: string; reported?: true }
> {
  const url = new URL(runnerStatusUrl())
  url.searchParams.set('call_id', callId)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${runnerToken()}` }, signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS) })
  if (!res.ok) return { status: 'failed', error: `status endpoint HTTP ${res.status}` }
  const data = await res.json()
  if (data.status === 'done') return { status: 'done', result: sanitizeRunResult(data.result) }
  if (data.status === 'failed') return { status: 'failed', error: String(data.error || 'unknown'), reported: true }
  if (data.status === 'running') return { status: 'running' }
  return { status: 'failed', error: 'Runner returned an invalid status' }
}

// Poll to completion within a wall budget; null = still running at deadline
// (the caller persists the call_id and a later invocation resumes polling).
// Transient status-endpoint errors (non-reported HTTP/gateway errors or
// network failures) are logged and retried until the deadline instead of
// aborting an in-flight 5-minute GPU run.
export async function awaitResearchRun(
  callId: string,
  maxWaitMs: number,
  pollMs = 15000
): Promise<ResearchRunResult | null> {
  const deadline = Date.now() + maxWaitMs
  let transientFailures = 0
  while (Date.now() < deadline) {
    let s: Awaited<ReturnType<typeof pollResearchRun>> | null = null
    try {
      s = await pollResearchRun(callId)
    } catch (err) {
      transientFailures += 1
      console.warn(
        `[Research] transient poll error for ${callId} (#${transientFailures}):`,
        err instanceof Error ? err.message : err
      )
    }
    if (s) {
      if (s.status === 'done') return s.result
      if (s.status === 'failed') {
        if (s.reported === true) return { status: 'infra_error', error: s.error }
        transientFailures += 1
        console.warn(`[Research] transient status error for ${callId} (#${transientFailures}): ${s.error}`)
      } else {
        transientFailures = 0
      }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise(r => setTimeout(r, Math.min(pollMs, remaining)))
  }
  return null
}

