// Sprites in the room.
//
// Each model has its own sandbox (a "sprite"). When a model's code
// contribution is pushed to AI-Agent, its sprite checks out that commit and
// runs the repository's tests on the server (api/_lib/sprites.ts). This
// service polls the public contributions endpoint for those results and plays
// the real output tail, with a pass or fail line, onto the author's desk
// terminal through the stream events main.ts already wires to TerminalScreen.
//
// Nothing is shown unless a real run came back with an exit status: no
// simulated commands, no placeholder output.

// Public, read-only: latest contributions that ran in a sprite.
const RUNS_API = '/api/experiment/code-contributions?sprite_runs=1'
// Operator route (needs the operator credential); development helper only.
const EXEC_API = '/api/sprites/exec'

const POLL_MS = 60_000
const IDLE_POLL_MS = 5 * 60_000   // backend missing or not answering JSON
const FRESH_DELAY_MS = 20_000     // let the code-writing session on the same screen finish first
const LINE_MS = 140
const HOLD_MS = 30_000            // keep the verdict on screen before the scientist leaves
const MAX_LINES = 14

// Panel models with a desk terminal. North and GLM have sprites too, but no desk.
export type ModelId = 'claude' | 'gpt' | 'gemini' | 'grok' | 'deepseek'
const DESK_MODELS: readonly ModelId[] = ['claude', 'gpt', 'gemini', 'grok', 'deepseek']

// Sprites activity events (robot reactions)
export interface SpritesActivityEvent {
  type: 'writing' | 'reading' | 'testing' | 'committing' | 'idle' | 'error'
  spriteId: string
  taskId?: string
  message?: string
  output?: string
}

// Streaming output events for terminal display
export interface StreamOutputEvent {
  type: 'start' | 'output' | 'error' | 'exit' | 'done'
  modelId: ModelId
  text?: string
  command?: string
  exitCode?: number | null
}

type StreamCallback = (event: StreamOutputEvent) => void
type ActivityCallback = (event: SpritesActivityEvent) => void

/** One real sprite test run, as the public endpoint reports it. */
export interface SpriteRun {
  id: string
  modelId: ModelId
  spriteName: string
  branch: string
  passed: boolean
  exitCode: number
  durationMs: number | null
  outputTail: string
  ranAt: string
}

/** Keep only runs that really happened and belong to a desk model. */
export function parseSpriteRuns(data: unknown): SpriteRun[] {
  const list = (data as { sprite_runs?: unknown })?.sprite_runs
  if (!Array.isArray(list)) return []
  const runs: SpriteRun[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const sprite = row.sprite as Record<string, unknown> | undefined
    if (!sprite || typeof row.id !== 'string' || typeof row.branch !== 'string') continue
    const name = sprite.sprite_name
    const exit = sprite.exit_code
    const tail = sprite.output_tail
    const ranAt = sprite.ran_at
    const match = typeof name === 'string' ? /^observable-([a-z]+)$/.exec(name) : null
    const modelId = match?.[1] as ModelId | undefined
    if (!modelId || !DESK_MODELS.includes(modelId)) continue
    if (typeof exit !== 'number' || !Number.isInteger(exit)) continue
    if (typeof tail !== 'string' || !tail.trim() || typeof ranAt !== 'string' || Number.isNaN(Date.parse(ranAt))) continue
    if (sprite.status !== 'passed' && sprite.status !== 'failed') continue
    runs.push({
      id: row.id,
      modelId,
      spriteName: name as string,
      branch: row.branch,
      passed: exit === 0,
      exitCode: exit,
      durationMs: typeof sprite.duration_ms === 'number' ? sprite.duration_ms : null,
      outputTail: tail,
      ranAt,
    })
  }
  return runs
}

const seconds = (ms: number | null) => (ms === null ? '' : ` in ${Math.max(1, Math.round(ms / 1000))} s`)

function shortTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** The lines a terminal shows for one run: where it ran, the real tail, then the verdict. */
export function terminalLinesForRun(run: SpriteRun): Array<{ text: string; type: 'output' | 'error' }> {
  const tail = run.outputTail
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.trim().length > 0)
    .slice(-MAX_LINES)
    .map(line => (line.length > 120 ? `${line.slice(0, 119)}…` : line))
  return [
    { text: `# ${run.spriteName}  ${run.branch}  ${shortTime(run.ranAt)}`, type: 'output' },
    ...tail.map(text => ({ text, type: 'output' as const })),
    run.passed
      ? { text: `✓ PASS  tests passed${seconds(run.durationMs)}`, type: 'output' }
      : { text: `✗ FAIL  exit ${run.exitCode}${seconds(run.durationMs)}`, type: 'error' },
  ]
}

export class SpritesService {
  private activityCallbacks: ActivityCallback[] = []
  private streamCallbacks: StreamCallback[] = []
  private activeStreams: Map<ModelId, AbortController> = new Map()
  private repoUrl: string = ''

  private pollTimer: number | null = null
  private polling = false
  private firstPoll = true
  private seenRuns: Set<string> = new Set()
  private queue: Array<{ run: SpriteRun; notBefore: number }> = []
  private playing = false

  setRepoUrl(url: string): void {
    this.repoUrl = url
  }

  getRepoUrl(): string {
    return this.repoUrl
  }

  onActivity(callback: ActivityCallback): () => void {
    this.activityCallbacks.push(callback)
    return () => {
      const index = this.activityCallbacks.indexOf(callback)
      if (index !== -1) this.activityCallbacks.splice(index, 1)
    }
  }

  private emitActivity(event: SpritesActivityEvent): void {
    this.activityCallbacks.forEach(cb => cb(event))
  }

  // Subscribe to terminal output. The first subscriber starts polling for
  // real sprite runs, so the room needs no extra wiring.
  onStreamOutput(callback: StreamCallback): () => void {
    this.streamCallbacks.push(callback)
    this.startRunPolling()
    return () => {
      const index = this.streamCallbacks.indexOf(callback)
      if (index !== -1) this.streamCallbacks.splice(index, 1)
      if (this.streamCallbacks.length === 0) this.stopRunPolling()
    }
  }

  private emitStreamOutput(event: StreamOutputEvent): void {
    this.streamCallbacks.forEach(cb => cb(event))
  }

  // ---- real sprite runs ----

  startRunPolling(): void {
    if (this.polling || typeof window === 'undefined') return
    this.polling = true
    document.addEventListener('visibilitychange', this.onVisibility)
    this.schedulePoll(1500)
  }

  stopRunPolling(): void {
    this.polling = false
    document.removeEventListener('visibilitychange', this.onVisibility)
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private onVisibility = (): void => {
    if (this.polling && !document.hidden) this.schedulePoll(1000)
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = window.setTimeout(() => void this.pollRuns(), delayMs)
  }

  private async pollRuns(): Promise<void> {
    if (!this.polling) return
    if (document.hidden) {
      this.schedulePoll(POLL_MS)
      return
    }
    let next = POLL_MS
    try {
      const response = await fetch(RUNS_API, { headers: { Accept: 'application/json' } })
      const isJson = (response.headers.get('content-type') || '').includes('json')
      if (!response.ok || !isJson) {
        next = IDLE_POLL_MS // no backend here (for example the plain Vite dev server)
      } else {
        this.acceptRuns(parseSpriteRuns(await response.json()))
      }
    } catch {
      next = IDLE_POLL_MS
    }
    this.schedulePoll(next)
  }

  /** Queue runs not shown yet. On the first answer only the newest run plays. */
  acceptRuns(runs: SpriteRun[]): void {
    const fresh = runs.filter(run => !this.seenRuns.has(run.id))
    fresh.forEach(run => this.seenRuns.add(run.id))
    if (!fresh.length) {
      this.firstPoll = false
      return
    }
    const now = Date.now()
    const toPlay = this.firstPoll ? fresh.slice(0, 1) : fresh.slice().reverse() // oldest first
    for (const run of toPlay) {
      this.queue.push({ run, notBefore: this.firstPoll ? now : now + FRESH_DELAY_MS })
    }
    this.firstPoll = false
    void this.playQueue()
  }

  private async playQueue(): Promise<void> {
    if (this.playing) return
    this.playing = true
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!
        const wait = item.notBefore - Date.now()
        if (wait > 0) await sleep(wait)
        await this.playRun(item.run)
      }
    } finally {
      this.playing = false
    }
  }

  private async playRun(run: SpriteRun): Promise<void> {
    const { modelId } = run
    this.emitActivity({ type: 'testing', spriteId: run.spriteName, message: 'npm test' })
    this.emitStreamOutput({ type: 'start', modelId, command: 'npm test' })
    for (const line of terminalLinesForRun(run)) {
      await sleep(LINE_MS)
      this.emitStreamOutput({ type: line.type, modelId, text: line.text })
    }
    this.emitStreamOutput({ type: 'exit', modelId, exitCode: run.exitCode })
    if (!run.passed) {
      this.emitActivity({ type: 'error', spriteId: run.spriteName, message: `tests failed (exit ${run.exitCode})` })
    }
    await sleep(HOLD_MS)
    this.emitStreamOutput({ type: 'done', modelId })
    this.emitActivity({ type: 'idle', spriteId: run.spriteName })
  }

  // ---- operator helper (development builds only call this) ----

  // Run a command in a sprite through the operator route. Without the
  // operator credential the route answers 401, which is shown as an error.
  async executeCommand(modelId: ModelId, command: string): Promise<void> {
    this.activeStreams.get(modelId)?.abort()
    const controller = new AbortController()
    this.activeStreams.set(modelId, controller)
    const spriteId = `observable-${modelId}`

    try {
      const response = await fetch(EXEC_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, command }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => null) as { error?: string } | null
        this.emitStreamOutput({ type: 'error', modelId, text: error?.error || `Request failed (${response.status})` })
        this.emitStreamOutput({ type: 'done', modelId })
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let data: { type?: string; text?: string; command?: string; exitCode?: number | null }
          try { data = JSON.parse(line.slice(6)) } catch { continue }
          if (data.type !== 'start' && data.type !== 'output' && data.type !== 'error' && data.type !== 'exit' && data.type !== 'done') continue
          this.emitStreamOutput({ type: data.type, modelId, text: data.text, command: data.command, exitCode: data.exitCode })
          if (data.type === 'error') this.emitActivity({ type: 'error', spriteId, message: data.text })
          if (data.type === 'done') this.emitActivity({ type: 'idle', spriteId })
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.emitStreamOutput({ type: 'error', modelId, text: error instanceof Error ? error.message : 'Unknown error' })
        this.emitStreamOutput({ type: 'done', modelId })
      }
    } finally {
      this.activeStreams.delete(modelId)
    }
  }

  cancelExecution(modelId: ModelId): void {
    this.activeStreams.get(modelId)?.abort()
    this.activeStreams.delete(modelId)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

// Singleton instance
let serviceInstance: SpritesService | null = null

export function getSpritesService(): SpritesService {
  if (!serviceInstance) {
    serviceInstance = new SpritesService()
  }
  return serviceInstance
}
