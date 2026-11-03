import type { AgentSpecification } from './types.js'

// The initial specification to seed a new experiment.
// Anchored to the mission — a blank "autonomous agent" let earlier runs
// collapse into a narrow calculator; the seed now names the real goal so the
// team builds toward the frontier from epoch 0.
export const SEED_SPECIFICATION: AgentSpecification = {
  identity: {
    purpose: 'To be a genuinely state-of-the-art, general-purpose AI agent — one that plans, uses tools, reasons over long multi-step tasks, remembers, retrieves knowledge, writes and runs code, catches its own mistakes, and improves.',
    domain: 'general-purpose autonomous agent (frontier-capable)',
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

// RESEARCH MODE seed: the autonomous ML research lab. Presence of
// meta.research routes every epoch through the research pipeline (real GPU
// experiments on the Research-Lab repo, measured val_bpb verdicts).
// baseline_bpb = the measured result of the untouched scaffold (A10G, 300s).
export const RESEARCH_SEED_SPECIFICATION: AgentSpecification = {
  identity: {
    purpose: 'To autonomously advance a real byte-level GPT language model \u2014 drive validation bits-per-byte on TinyStories as low as possible under a fixed 300-second single-GPU training budget, through disciplined, cumulative, honestly-measured experimental research.',
    domain: 'autonomous ML research lab (TinyStories byte-level LM)',
  },
  capabilities: [],
  constraints: [],
  behaviors: [],
  conflicts: [],
  meta: {
    stability_score: 0.15,
    growth_stage: 'seed',
    total_epochs: 0,
    total_mutations: 0,
    total_prunings: 0,
    research: {
      baseline_bpb: 0.7236,
      best_bpb: 0.7236,
      best_epoch: 0,
      target_bpb: 0.35,
    },
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
