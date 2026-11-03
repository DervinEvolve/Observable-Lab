import type { StationRole } from '../scene/colors'

// Simple browser-compatible event emitter
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventCallback = (...args: any[]) => void

class SimpleEventEmitter {
  private listeners: Map<string, EventCallback[]> = new Map()

  on(event: string, callback: EventCallback): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event)!.push(callback)
    return this
  }

  off(event: string, callback: EventCallback): this {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      const index = callbacks.indexOf(callback)
      if (index !== -1) {
        callbacks.splice(index, 1)
      }
    }
    return this
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, ...args: any[]): boolean {
    const callbacks = this.listeners.get(event)
    if (callbacks && callbacks.length > 0) {
      callbacks.forEach(cb => cb(...args))
      return true
    }
    return false
  }
}

// Task types that can be derived from spec changes
export type TaskType =
  | 'implement_feature'
  | 'write_test'
  | 'fix_bug'
  | 'review_code'
  | 'refactor'
  | 'document'
  | 'challenge_design'
  | 'plan_architecture'

// Task priority levels
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'

// Task status
export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'failed'

// A task in the system
export interface Task {
  id: string
  type: TaskType
  title: string
  description: string
  priority: TaskPriority
  status: TaskStatus
  assignedRole: StationRole | null
  assignedModel: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  blockedBy: string | null
  relatedSpecItem: string | null // Reference to capability/behavior/constraint
  spriteSessionId: string | null // Future: Sprites.dev session
}

// Events emitted by the orchestrator
export interface TaskEvents {
  'task:created': (task: Task) => void
  'task:assigned': (task: Task) => void
  'task:started': (task: Task) => void
  'task:progress': (task: Task, progress: number) => void
  'task:blocked': (task: Task, reason: string) => void
  'task:completed': (task: Task) => void
  'task:failed': (task: Task, error: string) => void
}

// Role to task type mapping
const ROLE_TASK_TYPES: Record<StationRole, TaskType[]> = {
  planner: ['plan_architecture', 'document'],
  executor: ['implement_feature', 'fix_bug', 'refactor'],
  reviewer: ['review_code', 'document'],
  challenger: ['challenge_design', 'write_test'],
  commentator: ['document'],
}

// Generate unique task ID
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

export class TaskOrchestrator extends SimpleEventEmitter {
  private tasks: Map<string, Task> = new Map()
  private taskQueue: string[] = [] // Task IDs in priority order
  private activeTasksByRole: Map<StationRole, string | null> = new Map()

  constructor() {
    super()
    // Initialize role tracking
    const roles: StationRole[] = ['planner', 'executor', 'reviewer', 'challenger', 'commentator']
    roles.forEach(role => this.activeTasksByRole.set(role, null))
  }

  // Create a new task from a spec change
  createTask(params: {
    type: TaskType
    title: string
    description: string
    priority?: TaskPriority
    relatedSpecItem?: string
  }): Task {
    const task: Task = {
      id: generateTaskId(),
      type: params.type,
      title: params.title,
      description: params.description,
      priority: params.priority || 'medium',
      status: 'pending',
      assignedRole: null,
      assignedModel: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      blockedBy: null,
      relatedSpecItem: params.relatedSpecItem || null,
      spriteSessionId: null,
    }

    this.tasks.set(task.id, task)
    this.insertIntoQueue(task)
    this.emit('task:created', task)

    if (import.meta.env.DEV) {
      console.log(`[TaskOrchestrator] Task created: ${task.title}`)
    }

    return task
  }

  // Insert task into queue based on priority
  private insertIntoQueue(task: Task): void {
    const priorityOrder: TaskPriority[] = ['critical', 'high', 'medium', 'low']
    const taskPriorityIndex = priorityOrder.indexOf(task.priority)

    let insertIndex = this.taskQueue.length
    for (let i = 0; i < this.taskQueue.length; i++) {
      const existingTask = this.tasks.get(this.taskQueue[i])
      if (existingTask) {
        const existingPriorityIndex = priorityOrder.indexOf(existingTask.priority)
        if (taskPriorityIndex < existingPriorityIndex) {
          insertIndex = i
          break
        }
      }
    }

    this.taskQueue.splice(insertIndex, 0, task.id)
  }

  // Assign a task to a role
  assignTask(taskId: string, role: StationRole, modelId?: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    // Check if role can handle this task type
    if (!ROLE_TASK_TYPES[role].includes(task.type)) {
      if (import.meta.env.DEV) {
        console.warn(`[TaskOrchestrator] Role ${role} cannot handle task type ${task.type}`)
      }
      return false
    }

    // Check if role already has an active task
    if (this.activeTasksByRole.get(role)) {
      if (import.meta.env.DEV) {
        console.warn(`[TaskOrchestrator] Role ${role} already has an active task`)
      }
      return false
    }

    task.assignedRole = role
    task.assignedModel = modelId || null
    task.status = 'assigned'
    this.activeTasksByRole.set(role, taskId)
    this.emit('task:assigned', task)

    if (import.meta.env.DEV) {
      console.log(`[TaskOrchestrator] Task assigned: ${task.title} -> ${role}`)
    }

    return true
  }

  // Start working on a task
  startTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'assigned') return false

    task.status = 'in_progress'
    task.startedAt = new Date()
    this.emit('task:started', task)

    if (import.meta.env.DEV) {
      console.log(`[TaskOrchestrator] Task started: ${task.title}`)
    }

    return true
  }

  // Report progress on a task
  reportProgress(taskId: string, progress: number): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'in_progress') return

    this.emit('task:progress', task, Math.min(1, Math.max(0, progress)))
  }

  // Mark task as blocked
  blockTask(taskId: string, reason: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'in_progress') return false

    task.status = 'blocked'
    task.blockedBy = reason
    this.emit('task:blocked', task, reason)

    if (import.meta.env.DEV) {
      console.log(`[TaskOrchestrator] Task blocked: ${task.title} - ${reason}`)
    }

    return true
  }

  // Complete a task
  completeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    task.status = 'completed'
    task.completedAt = new Date()

    // Remove from queue and active tasks
    this.taskQueue = this.taskQueue.filter(id => id !== taskId)
    if (task.assignedRole) {
      this.activeTasksByRole.set(task.assignedRole, null)
    }

    this.emit('task:completed', task)

    if (import.meta.env.DEV) {
      console.log(`[TaskOrchestrator] Task completed: ${task.title}`)
    }

    return true
  }

  // Fail a task
  failTask(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    task.status = 'failed'
    task.completedAt = new Date()

    // Remove from queue and active tasks
    this.taskQueue = this.taskQueue.filter(id => id !== taskId)
    if (task.assignedRole) {
      this.activeTasksByRole.set(task.assignedRole, null)
    }

    this.emit('task:failed', task, error)

    if (import.meta.env.DEV) {
      console.log(`[TaskOrchestrator] Task failed: ${task.title} - ${error}`)
    }

    return true
  }

  // Get next available task for a role
  getNextTaskForRole(role: StationRole): Task | null {
    // Role already has an active task
    if (this.activeTasksByRole.get(role)) return null

    // Find first task in queue that this role can handle
    for (const taskId of this.taskQueue) {
      const task = this.tasks.get(taskId)
      if (task && task.status === 'pending' && ROLE_TASK_TYPES[role].includes(task.type)) {
        return task
      }
    }

    return null
  }

  // Get active task for a role
  getActiveTaskForRole(role: StationRole): Task | null {
    const taskId = this.activeTasksByRole.get(role)
    return taskId ? this.tasks.get(taskId) || null : null
  }

  // Get all tasks
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values())
  }

  // Get pending tasks
  getPendingTasks(): Task[] {
    return this.taskQueue
      .map(id => this.tasks.get(id))
      .filter((task): task is Task => task !== undefined && task.status === 'pending')
  }

  // Create tasks from spec change (called after epoch)
  createTasksFromSpecChange(change: {
    type: 'capability' | 'behavior' | 'constraint' | 'conflict'
    action: 'added' | 'modified' | 'resolved'
    item: { id: string; name: string; description?: string }
  }): Task[] {
    const tasks: Task[] = []

    switch (change.type) {
      case 'capability':
        if (change.action === 'added') {
          // New capability needs implementation
          tasks.push(this.createTask({
            type: 'implement_feature',
            title: `Implement: ${change.item.name}`,
            description: change.item.description || `Implement the ${change.item.name} capability`,
            priority: 'high',
            relatedSpecItem: change.item.id,
          }))
          // Also needs tests
          tasks.push(this.createTask({
            type: 'write_test',
            title: `Test: ${change.item.name}`,
            description: `Write tests for the ${change.item.name} capability`,
            priority: 'medium',
            relatedSpecItem: change.item.id,
          }))
        }
        break

      case 'behavior':
        if (change.action === 'added' || change.action === 'modified') {
          tasks.push(this.createTask({
            type: 'implement_feature',
            title: `Implement behavior: ${change.item.name}`,
            description: change.item.description || `Implement the ${change.item.name} behavior`,
            priority: 'medium',
            relatedSpecItem: change.item.id,
          }))
        }
        break

      case 'conflict':
        if (change.action === 'added') {
          // Conflict needs review and design challenge
          tasks.push(this.createTask({
            type: 'challenge_design',
            title: `Resolve conflict: ${change.item.name}`,
            description: change.item.description || `Investigate and propose resolution for conflict`,
            priority: 'high',
            relatedSpecItem: change.item.id,
          }))
        }
        break
    }

    return tasks
  }

  // Clear all tasks (for testing)
  clearAll(): void {
    this.tasks.clear()
    this.taskQueue = []
    const roles: StationRole[] = ['planner', 'executor', 'reviewer', 'challenger', 'commentator']
    roles.forEach(role => this.activeTasksByRole.set(role, null))
  }
}

// Singleton instance
let orchestratorInstance: TaskOrchestrator | null = null

export function getTaskOrchestrator(): TaskOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new TaskOrchestrator()
  }
  return orchestratorInstance
}
