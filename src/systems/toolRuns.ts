// Stored tool runs: what the models really did with their tools, as the
// backend recorded it (docs/TOOLS.md, the `tool_runs` table). The room plays
// each finished run once:
//   - a Sprite session: its stored transcript on the model's desk screen,
//     like the Sprite test runs (SpritesService);
//   - a GPU job: the compute corner lights up and the job's last output line
//     goes on the ticket beside its gauge (TrainingRig.showJob);
//   - an explorer subagent: a drone carrying the explorer's own task text.
// Skipped requests and runs still going are not shown, and nothing here is
// simulated. The rows come on GET /api/experiment as `tool_runs` (the 12
// most recent, newest first).

import { BACKEND_TO_FRONTEND_MODEL, modelDisplayName, type FrontendModelId } from '../shared/types'

export type ToolRunKind = 'sprite_session' | 'gpu_job' | 'explorer'

export interface ToolRun {
  id: string
  kind: ToolRunKind
  modelId: string // OpenRouter id
  modelName: string // display name (fallbacks and wildcards included)
  desk: FrontendModelId | null // the panel desk, when the model has one
  at: string // when it was stored
  status: string // as stored: ok, failed, error, timeout
  summary: string | null // what was asked, in the model's words (request_summary)
  // sprite session
  spriteName?: string
  command?: string // the first command, shown as the session's prompt line
  output?: string // the stored transcript
  exitCode?: number | null
  durationMs?: number | null
  // gpu job
  resultLine?: string
  // explorer
  task?: string
}

const KIND_ALIASES: Record<string, ToolRunKind> = {
  sprite_session: 'sprite_session',
  gpu_job: 'gpu_job',
  subagent_explore: 'explorer',
}

// Control characters and ANSI codes out; length capped. The server cleans
// output too; this keeps the room safe if it ever does not.
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Finished, stored runs only; anything incomplete, skipped or unknown is dropped. */
export function parseToolRuns(raw: unknown): ToolRun[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { tool_runs?: unknown }).tool_runs : null
  if (!Array.isArray(list)) return []
  const out: ToolRun[] = []
  for (const item of list.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = o.id
    const tool = o.tool
    const modelId = o.model
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue
    if (typeof tool !== 'string' || !Object.hasOwn(KIND_ALIASES, tool)) continue
    if (typeof modelId !== 'string' || !/^[a-z0-9._:/-]{3,100}$/i.test(modelId)) continue
    const at = o.created_at
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue
    const status = typeof o.status === 'string' ? o.status : ''
    if (!['ok', 'failed', 'error', 'timeout'].includes(status)) continue
    const kind = KIND_ALIASES[tool]
    const detail = o.detail && typeof o.detail === 'object' && !Array.isArray(o.detail) ? (o.detail as Record<string, unknown>) : {}
    const exit = o.exit_code
    const dur = o.duration_ms
    const run: ToolRun = {
      id,
      kind,
      modelId,
      modelName: modelDisplayName(modelId) || modelId,
      desk: (BACKEND_TO_FRONTEND_MODEL as Record<string, FrontendModelId>)[modelId] ?? null,
      at,
      status,
      summary: cleanText(o.request_summary, 160),
      exitCode: typeof exit === 'number' && Number.isInteger(exit) ? exit : null,
      durationMs: typeof dur === 'number' && Number.isFinite(dur) ? dur : null,
    }
    if (kind === 'sprite_session') {
      const output = cleanText(o.output_tail, 4000)
      if (!output) continue
      run.output = output
      const commands = Array.isArray(detail.commands) ? detail.commands : []
      const first = commands[0] && typeof commands[0] === 'object' ? cleanText((commands[0] as Record<string, unknown>).run, 160) : null
      run.command = first ?? run.summary ?? 'sprite session'
      const sprite = cleanText(detail.sprite, 60)
      run.spriteName = sprite && /^[a-z0-9-]+$/.test(sprite) ? sprite : run.desk ? `observable-${run.desk}` : 'sprite'
    } else if (kind === 'gpu_job') {
      // the result line is the last thing the job printed (self-reported),
      // or the stored error when it printed nothing
      const tail = cleanText(o.output_tail, 4000)
      const last = tail?.split('\n').map(l => l.trim()).filter(Boolean).pop()
      const line = cleanText(last, 200)
      if (!line) continue
      run.resultLine = line
    } else {
      const task = run.summary
      if (!task || task === 'explore') continue
      run.task = task
    }
    out.push(run)
  }
  return out
}

type Handler = (run: ToolRun) => void

export class ToolRunsService {
  private seen = new Set<string>()
  private first = true
  constructor(private handlers: Partial<Record<ToolRunKind, Handler>>) {}

  /** Plays runs not seen yet. On the first answer, only the newest of each kind. */
  accept(runs: ToolRun[]): void {
    const fresh = runs.filter(r => !this.seen.has(r.id))
    fresh.forEach(r => this.seen.add(r.id))
    const sorted = fresh.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) // oldest first
    let play = sorted
    if (this.first) {
      const newest = new Map<ToolRunKind, ToolRun>()
      for (const r of sorted) newest.set(r.kind, r)
      play = [...newest.values()]
    }
    this.first = false
    play.forEach((r, i) => window.setTimeout(() => this.handlers[r.kind]?.(r), i * 4000))
  }
}
