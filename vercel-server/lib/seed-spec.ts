import type { AgentSpecification } from '../../src/shared/types'

// The initial specification to seed a new experiment
// Minimal - lets the models decide what this agent should become
export const SEED_SPECIFICATION: AgentSpecification = {
  identity: {
    purpose: 'An AI agent',
    domain: null, // Let the models decide
  },
  capabilities: [],
  constraints: [],
  behaviors: [],
  conflicts: [],
  meta: {
    stability_score: 0.5, // Neutral starting point
    growth_stage: 'seed',
    total_epochs: 0,
    total_mutations: 0,
    total_prunings: 0,
  },
}

// Helper to determine experiment status from spec
export function getExperimentStatus(spec: AgentSpecification): 'seeding' | 'growing' | 'stable' | 'failing' {
  if (spec.meta.stability_score >= 0.9) return 'stable'
  if (spec.meta.stability_score < 0.2) return 'failing'
  if (spec.capabilities.length === 0) return 'seeding'
  return 'growing'
}

// Helper to determine growth stage from spec metrics
export function getGrowthStage(spec: AgentSpecification): AgentSpecification['meta']['growth_stage'] {
  const { capabilities, constraints, behaviors } = spec
  const total = capabilities.length + constraints.length + behaviors.length

  if (total === 0) return 'seed'
  if (total < 5) return 'sprout'
  if (total < 15) return 'growing'
  if (spec.meta.stability_score >= 0.8) return 'stable'
  return 'mature'
}
