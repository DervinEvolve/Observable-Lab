import { MODELS, ROLES, type Role, type ModelId, type RoleAssignments } from './types.js'

// Pre-generated shuffled rotation schedules
// Each cycle of 5 epochs: every model plays every role exactly once
// Different shuffle per cycle to avoid predictability
const SCHEDULES = [
  // Cycle 1 (epochs 0-4)
  [[0, 1, 2, 3, 4], [1, 2, 3, 4, 0], [2, 3, 4, 0, 1], [3, 4, 0, 1, 2], [4, 0, 1, 2, 3]],
  // Cycle 2 (epochs 5-9)
  [[2, 4, 0, 1, 3], [4, 0, 1, 3, 2], [0, 1, 3, 2, 4], [1, 3, 2, 4, 0], [3, 2, 4, 0, 1]],
  // Cycle 3 (epochs 10-14)
  [[4, 1, 3, 0, 2], [1, 3, 0, 2, 4], [3, 0, 2, 4, 1], [0, 2, 4, 1, 3], [2, 4, 1, 3, 0]],
  // Cycle 4 (epochs 15-19)
  [[1, 0, 4, 2, 3], [0, 4, 2, 3, 1], [4, 2, 3, 1, 0], [2, 3, 1, 0, 4], [3, 1, 0, 4, 2]],
  // Cycle 5 (epochs 20-24) - then repeats from cycle 1
  [[3, 2, 1, 4, 0], [2, 1, 4, 0, 3], [1, 4, 0, 3, 2], [4, 0, 3, 2, 1], [0, 3, 2, 1, 4]],
]

export function getRoleAssignments(epochNumber: number): RoleAssignments {
  const cycleIndex = Math.floor(epochNumber / 5) % 5
  const epochInCycle = epochNumber % 5
  const assignment = SCHEDULES[cycleIndex][epochInCycle]

  return Object.fromEntries(
    ROLES.map((role, i) => [role, MODELS[assignment[i]]])
  ) as RoleAssignments
}

// Get which model is assigned to a specific role this epoch
export function getModelForRole(epochNumber: number, role: Role): ModelId {
  const assignments = getRoleAssignments(epochNumber)
  return assignments[role]
}

// Get which role a specific model has this epoch
export function getRoleForModel(epochNumber: number, modelId: ModelId): Role | null {
  const assignments = getRoleAssignments(epochNumber)
  for (const [role, model] of Object.entries(assignments)) {
    if (model === modelId) {
      return role as Role
    }
  }
  return null
}

// Get the order of activation for station sequencing during an epoch
export function getActivationOrder(epochNumber: number): Array<{ role: Role; modelId: ModelId }> {
  const assignments = getRoleAssignments(epochNumber)
  return [
    { role: 'planner', modelId: assignments.planner },
    { role: 'executor', modelId: assignments.executor },
    { role: 'challenger', modelId: assignments.challenger },
    { role: 'reviewer', modelId: assignments.reviewer },
    { role: 'commentator', modelId: assignments.commentator },
  ]
}
