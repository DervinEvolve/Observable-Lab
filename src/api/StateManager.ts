import type { ExperimentState } from '../shared/types'

export type StateUpdateCallback = (state: ExperimentState) => void
export type ErrorCallback = (error: Error) => void

interface StateManagerOptions {
  apiBaseUrl?: string
  idlePollingInterval?: number // ms between polls when idle
  activePollingInterval?: number // ms between polls during active epoch
  onStateUpdate?: StateUpdateCallback
  onError?: ErrorCallback
}

export class StateManager {
  private apiBaseUrl: string
  private idlePollingInterval: number
  private activePollingInterval: number
  private onStateUpdate: StateUpdateCallback | null
  private onError: ErrorCallback | null

  private currentState: ExperimentState | null = null
  private pollingTimer: ReturnType<typeof setTimeout> | null = null
  private isPolling: boolean = false

  constructor(options: StateManagerOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl || '/api'
    this.idlePollingInterval = options.idlePollingInterval || 15000 // 15 seconds
    this.activePollingInterval = options.activePollingInterval || 2500 // 2.5 seconds
    this.onStateUpdate = options.onStateUpdate || null
    this.onError = options.onError || null
  }

  // Start polling for state updates
  public startPolling(): void {
    if (this.isPolling) return
    this.isPolling = true
    this.poll()
  }

  // Stop polling
  public stopPolling(): void {
    this.isPolling = false
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer)
      this.pollingTimer = null
    }
  }

  // Get current cached state
  public getState(): ExperimentState | null {
    return this.currentState
  }

  // Set state update callback
  public setOnStateUpdate(callback: StateUpdateCallback): void {
    this.onStateUpdate = callback
    // Immediately call with current state if available
    if (this.currentState) {
      callback(this.currentState)
    }
  }

  // Set error callback
  public setOnError(callback: ErrorCallback): void {
    this.onError = callback
  }

  // Fetch state once (manual fetch)
  public async fetchState(): Promise<ExperimentState | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/experiment`)

      if (response.status === 404) {
        // No active experiment - might need to seed one
        if (import.meta.env.DEV) console.log('No active experiment found')
        return null
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`)
      }

      const state = (await response.json()) as ExperimentState
      this.handleStateUpdate(state)
      return state
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  }

  // Seed a new experiment
  public async seedExperiment(): Promise<string | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/experiment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!response.ok) {
        const data = await response.json()
        if (data.experiment_id) {
          // Already exists
          return data.experiment_id
        }
        throw new Error(data.error || `API error: ${response.status}`)
      }

      const data = await response.json()
      if (import.meta.env.DEV) console.log('Experiment seeded:', data.id)

      // Immediately fetch the new state
      await this.fetchState()

      return data.id
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  }

  // Private: polling loop
  private async poll(): Promise<void> {
    if (!this.isPolling) return

    await this.fetchState()

    // Schedule next poll based on whether epoch is in progress
    const interval = this.currentState?.epoch_in_progress
      ? this.activePollingInterval
      : this.idlePollingInterval

    this.pollingTimer = setTimeout(() => this.poll(), interval)
  }

  // Private: handle state update
  private handleStateUpdate(newState: ExperimentState): void {
    const previousState = this.currentState
    this.currentState = newState

    // Check if state changed meaningfully
    const hasChanged =
      !previousState ||
      previousState.current_epoch !== newState.current_epoch ||
      previousState.epoch_in_progress !== newState.epoch_in_progress ||
      previousState.status !== newState.status ||
      previousState.current_spec.meta.stability_score !==
        newState.current_spec.meta.stability_score

    if (hasChanged && this.onStateUpdate) {
      this.onStateUpdate(newState)
    }

    // Log epoch progress during active epoch (dev only)
    if (import.meta.env.DEV && newState.epoch_in_progress && newState.epoch_progress !== undefined) {
      console.log(`Epoch in progress: ${Math.round(newState.epoch_progress * 100)}%`)
    }
  }

  // Private: handle error
  private handleError(error: Error): void {
    console.error('StateManager error:', error)
    if (this.onError) {
      this.onError(error)
    }
  }

  // Get polling status
  public isCurrentlyPolling(): boolean {
    return this.isPolling
  }

  // Get whether epoch is in progress
  public isEpochInProgress(): boolean {
    return this.currentState?.epoch_in_progress || false
  }

  // Get current epoch progress (0-1) if in progress
  public getEpochProgress(): number | null {
    if (!this.currentState?.epoch_in_progress) return null
    return this.currentState.epoch_progress || 0
  }

  // Get stability score
  public getStabilityScore(): number {
    return this.currentState?.current_spec.meta.stability_score || 0.5
  }

  // Get experiment status
  public getExperimentStatus(): string {
    return this.currentState?.status || 'unknown'
  }

  // Get current epoch number
  public getCurrentEpoch(): number {
    return this.currentState?.current_epoch || 0
  }
}

// Singleton instance for easy access
let stateManagerInstance: StateManager | null = null

export function getStateManager(options?: StateManagerOptions): StateManager {
  if (!stateManagerInstance) {
    stateManagerInstance = new StateManager(options)
  }
  return stateManagerInstance
}
