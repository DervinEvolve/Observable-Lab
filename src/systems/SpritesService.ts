import { getTaskOrchestrator, Task, TaskType } from './TaskOrchestrator'

// Backend API endpoint (proxies to Sprites API with auth)
const BACKEND_API = '/api/sprites'
const EXEC_API = '/api/sprites/exec'

// Model to Sprite mapping - each AI model gets its own container
export type ModelId = 'claude' | 'gpt' | 'gemini' | 'grok' | 'deepseek'

// Sprite container status
export type SpriteStatus = 'creating' | 'ready' | 'running' | 'hibernating' | 'not_created' | 'error'

interface SpriteInfo {
  name: string
  status: SpriteStatus
  url?: string
}

// Sprites activity events
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
  exitCode?: number
}

// Stream callbacks
type StreamCallback = (event: StreamOutputEvent) => void

// Event callbacks
type ActivityCallback = (event: SpritesActivityEvent) => void

export class SpritesService {
  private sprites: Map<ModelId, SpriteInfo> = new Map()
  private activityCallbacks: ActivityCallback[] = []
  private streamCallbacks: StreamCallback[] = []
  private activeStreams: Map<ModelId, AbortController> = new Map()
  private initialized: boolean = false
  private repoUrl: string = ''

  // Task type to Sprite command mapping
  private static TASK_COMMANDS: Partial<Record<TaskType, string[]>> = {
    implement_feature: ['git pull', 'npm run build'],
    write_test: ['git pull', 'npm test'],
    fix_bug: ['git pull', 'npm run build', 'npm test'],
    refactor: ['git pull', 'npm run lint', 'npm run build'],
  }

  constructor() {
    // Public viewers carry no operator token. Protected operations require a separate operator client.
  }

  setRepoUrl(url: string): void {
    this.repoUrl = url
    console.log(`[SpritesService] Repository URL set: ${url}`)
  }

  onActivity(callback: ActivityCallback): () => void {
    this.activityCallbacks.push(callback)
    return () => {
      const index = this.activityCallbacks.indexOf(callback)
      if (index !== -1) {
        this.activityCallbacks.splice(index, 1)
      }
    }
  }

  private emitActivity(event: SpritesActivityEvent): void {
    this.activityCallbacks.forEach(cb => cb(event))
  }

  // Subscribe to streaming output events
  onStreamOutput(callback: StreamCallback): () => void {
    this.streamCallbacks.push(callback)
    return () => {
      const index = this.streamCallbacks.indexOf(callback)
      if (index !== -1) {
        this.streamCallbacks.splice(index, 1)
      }
    }
  }

  private emitStreamOutput(event: StreamOutputEvent): void {
    this.streamCallbacks.forEach(cb => cb(event))
  }

  // Execute a command in a sprite with streaming output
  async executeCommand(modelId: ModelId, command: string): Promise<void> {
    const sprite = this.sprites.get(modelId)
    console.log(`[SpritesService] Executing on ${modelId}: ${command}`)

    // Cancel any existing stream for this model
    const existingController = this.activeStreams.get(modelId)
    if (existingController) {
      existingController.abort()
    }

    const controller = new AbortController()
    this.activeStreams.set(modelId, controller)

    // Emit activity event for visualization
    this.emitActivity({
      type: 'writing',
      spriteId: sprite?.name || `observable-${modelId}`,
      message: command,
    })

    try {
      const response = await fetch(EXEC_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, command }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const error = await response.json()
        this.emitStreamOutput({
          type: 'error',
          modelId,
          text: error.error || 'Failed to execute command',
        })
        return
      }

      // Read the SSE stream
      const reader = response.body?.getReader()
      if (!reader) {
        this.emitStreamOutput({
          type: 'error',
          modelId,
          text: 'No response body',
        })
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events from buffer
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              this.emitStreamOutput({ ...data, modelId })

              // Update activity based on output
              if (data.type === 'output' && data.text) {
                this.emitActivity({
                  type: 'writing',
                  spriteId: sprite?.name || `observable-${modelId}`,
                  output: data.text,
                })
              } else if (data.type === 'error' && data.text) {
                this.emitActivity({
                  type: 'error',
                  spriteId: sprite?.name || `observable-${modelId}`,
                  message: data.text,
                })
              } else if (data.type === 'done') {
                this.emitActivity({
                  type: 'idle',
                  spriteId: sprite?.name || `observable-${modelId}`,
                })
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error(`[SpritesService] Execution error:`, error)
        this.emitStreamOutput({
          type: 'error',
          modelId,
          text: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    } finally {
      this.activeStreams.delete(modelId)
    }
  }

  // Cancel any active stream for a model
  cancelExecution(modelId: ModelId): void {
    const controller = this.activeStreams.get(modelId)
    if (controller) {
      controller.abort()
      this.activeStreams.delete(modelId)
      console.log(`[SpritesService] Cancelled execution for ${modelId}`)
    }
  }

  // Check if service is configured (backend handles token)
  isConfigured(): boolean {
    return true // Backend will return error if not configured
  }

  // Initialize sprites by fetching status from backend
  async initializeSprites(): Promise<void> {
    try {
      const response = await fetch(BACKEND_API)
      if (!response.ok) {
        const error = await response.json()
        console.warn('[SpritesService] Backend not configured:', error.error)
        return
      }

      const data = await response.json()
      const spritesData = data.sprites as Record<string, SpriteInfo>

      for (const [modelId, info] of Object.entries(spritesData)) {
        this.sprites.set(modelId as ModelId, info)
      }

      this.initialized = true
      console.log('[SpritesService] Sprites status loaded:', Object.keys(spritesData))

      // Check if any sprites need to be created
      const notCreated = Object.entries(spritesData).filter(([, info]) => info.status === 'not_created')
      if (notCreated.length > 0) {
        console.log(`[SpritesService] ${notCreated.length} sprites need to be created`)
      }
    } catch (error) {
      console.error('[SpritesService] Failed to initialize:', error)
    }
  }

  // Create all sprites via backend
  async createAllSprites(): Promise<boolean> {
    try {
      const response = await fetch(BACKEND_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_all' }),
      })

      if (!response.ok) {
        const error = await response.json()
        console.error('[SpritesService] Failed to create sprites:', error)
        return false
      }

      const data = await response.json()
      console.log('[SpritesService] Sprites creation result:', data.results)

      // Refresh status
      await this.initializeSprites()
      return true
    } catch (error) {
      console.error('[SpritesService] Error creating sprites:', error)
      return false
    }
  }

  // Simulate task execution (emits activity events for visualization)
  // Actual execution happens in backend during epochs
  simulateTaskExecution(task: Task, modelId: ModelId): void {
    const sprite = this.sprites.get(modelId)
    if (!sprite) {
      console.warn(`[SpritesService] No sprite for model ${modelId}`)
      return
    }

    const commands = SpritesService.TASK_COMMANDS[task.type] || ['processing']
    const orchestrator = getTaskOrchestrator()

    // Start the task
    orchestrator.startTask(task.id)

    // Emit activity events to drive visualizations
    let commandIndex = 0
    const executeNext = () => {
      if (commandIndex >= commands.length) {
        // Task completed
        this.emitActivity({
          type: 'committing',
          spriteId: sprite.name,
          taskId: task.id,
        })

        setTimeout(() => {
          this.emitActivity({
            type: 'idle',
            spriteId: sprite.name,
            taskId: task.id,
          })
          orchestrator.completeTask(task.id)
        }, 1500)
        return
      }

      const command = commands[commandIndex]
      const progress = (commandIndex + 1) / commands.length
      orchestrator.reportProgress(task.id, progress)

      // Determine activity type
      let activityType: SpritesActivityEvent['type'] = 'writing'
      if (command.includes('test')) activityType = 'testing'
      else if (command.includes('git pull')) activityType = 'reading'
      else if (command.includes('lint')) activityType = 'reading'

      this.emitActivity({
        type: activityType,
        spriteId: sprite.name,
        taskId: task.id,
        message: command,
      })

      commandIndex++
      // Simulate command execution time (2-5 seconds per command)
      setTimeout(executeNext, 2000 + Math.random() * 3000)
    }

    // Start execution
    this.emitActivity({
      type: 'reading',
      spriteId: sprite.name,
      taskId: task.id,
      message: 'Starting task...',
    })

    setTimeout(executeNext, 1000)
  }

  // Fail a task (for error scenarios)
  failTask(task: Task, modelId: ModelId, error: string): void {
    const sprite = this.sprites.get(modelId)
    const orchestrator = getTaskOrchestrator()

    this.emitActivity({
      type: 'error',
      spriteId: sprite?.name || `observable-${modelId}`,
      taskId: task.id,
      message: error,
    })

    orchestrator.failTask(task.id, error)

    setTimeout(() => {
      this.emitActivity({
        type: 'idle',
        spriteId: sprite?.name || `observable-${modelId}`,
        taskId: task.id,
      })
    }, 3000)
  }

  // Get sprite status for UI
  getSpriteStatus(modelId: ModelId): SpriteStatus {
    return this.sprites.get(modelId)?.status || 'not_created'
  }

  // Get all sprite statuses
  getAllStatuses(): Record<ModelId, SpriteStatus> {
    const statuses: Partial<Record<ModelId, SpriteStatus>> = {}
    const models: ModelId[] = ['claude', 'gpt', 'gemini', 'grok', 'deepseek']

    models.forEach(model => {
      statuses[model] = this.getSpriteStatus(model)
    })

    return statuses as Record<ModelId, SpriteStatus>
  }

  // Check if initialized
  isInitialized(): boolean {
    return this.initialized
  }

  // Get repo URL
  getRepoUrl(): string {
    return this.repoUrl
  }
}

// Singleton instance
let serviceInstance: SpritesService | null = null

export function getSpritesService(): SpritesService {
  if (!serviceInstance) {
    serviceInstance = new SpritesService()
  }
  return serviceInstance
}

