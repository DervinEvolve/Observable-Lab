// Shared types for Observable Multi-Agent Lab
// Used by both frontend and backend

// ============================================
// Model & Role Types
// ============================================

export const MODELS = [
  'google/gemini-3.5-flash',
  'deepseek/deepseek-v4-pro',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.5',
  'x-ai/grok-4.3',
] as const

export type ModelId = (typeof MODELS)[number]

export const ROLES = ['planner', 'executor', 'challenger', 'reviewer', 'commentator'] as const
export type Role = (typeof ROLES)[number]

export type RoleAssignments = Record<Role, ModelId>

export const MODEL_DISPLAY_NAMES: Record<ModelId, string> = {
  'google/gemini-3.5-flash': 'Gemini',
  'deepseek/deepseek-v4-pro': 'DeepSeek-V4',
  'anthropic/claude-opus-4.8': 'Claude',
  'openai/gpt-5.5': 'GPT-5',
  'x-ai/grok-4.3': 'Grok',
}

// Frontend model IDs (used in Scientist.ts) — map to /models/scientists/<id> assets
export type FrontendModelId = 'gemini' | 'deepseek' | 'claude' | 'gpt' | 'grok'

export const BACKEND_TO_FRONTEND_MODEL: Record<ModelId, FrontendModelId> = {
  'google/gemini-3.5-flash': 'gemini',
  'deepseek/deepseek-v4-pro': 'deepseek',
  'anthropic/claude-opus-4.8': 'claude',
  'openai/gpt-5.5': 'gpt',
  'x-ai/grok-4.3': 'grok',
}

// ============================================
// Wildcard / Experimental Agents (free models)
// ============================================
// The robot mascot is an autonomous R&D "wildcard" — it does NOT take a panel
// role. It runs free coding models in its own Sprites sandbox + git branch, and
// its accepted work shows up as differently-colored leaves on the plant.

export type WildcardId = 'north' | 'nemotron' | 'poolside' | 'glm'

export const WILDCARD_MODELS: Record<WildcardId, string> = {
  north:    'cohere/north-mini-code:free',           // primary: the robot's coding brain
  nemotron: 'nvidia/nemotron-3-ultra-550b-a55b:free',// heavy reasoning (can be fused w/ north)
  poolside: 'poolside/laguna-m.1:free',              // code specialist
  glm:      'z-ai/glm-5.2',                          // generalist (paid, cheap)
}

export const WILDCARD_DISPLAY_NAMES: Record<WildcardId, string> = {
  north:    'North',
  nemotron: 'Nemotron',
  poolside: 'Laguna',
  glm:      'GLM',
}

// Accent colors for wildcard leaves on the plant (distinct from panel-model leaves)
export const WILDCARD_ACCENTS: Record<WildcardId, number> = {
  north:    0x39d98a, // green
  nemotron: 0x76e000, // nvidia lime
  poolside: 0x4cc9f0, // pool blue
  glm:      0xb07cff, // violet
}

// The robot mascot's default brain.
export const ROBOT_WILDCARD: WildcardId = 'north'

// ============================================
// Agent Specification Types
// ============================================

export interface Capability {
  id: string
  description: string
  added_epoch: number
  status: 'active' | 'pruned'
  pruned_epoch?: number
  code_pr_url?: string // Set when this is backed by a real, merged code contribution — renders as a distinct leaf/branch color
}

export interface Constraint {
  id: string
  description: string
  type: 'must' | 'must_not' | 'should' | 'should_not'
  added_epoch: number
  status: 'active' | 'pruned'
  pruned_epoch?: number
}

export interface Behavior {
  id: string
  description: string
  capability_id?: string // Links to parent capability
  trigger?: string
  source?: WildcardId    // Set when contributed by a wildcard agent (e.g. North) — renders as a colored leaf
  added_epoch: number
  status: 'active' | 'pruned'
  pruned_epoch?: number
  code_pr_url?: string // Set when this is backed by a real, merged code contribution — renders as a distinct leaf color
}

export interface Conflict {
  id: string
  element_a: string // Path like "capabilities.cap_1"
  element_b: string
  description: string
  severity: 'critical' | 'warning' | 'note'
  detected_epoch: number
  resolved: boolean
  resolved_epoch?: number
}

export interface AgentSpecification {
  identity: {
    purpose: string
    domain: string | null
  }
  capabilities: Capability[]
  constraints: Constraint[]
  behaviors: Behavior[]
  conflicts: Conflict[]
  meta: {
    stability_score: number // 0-1
    growth_stage: 'seed' | 'sprout' | 'growing' | 'mature' | 'stable'
    total_epochs: number
    total_mutations: number
    total_prunings: number
    // Self-governance: bounded knobs the agents themselves tune via the
    // normal mutation/review pipeline (target: 'experiment_params').
    experiment_params?: {
      epoch_interval_minutes?: number        // 30-180
      north_every_n_epochs?: number          // 1-10
      max_code_contributions_per_epoch?: number // 1-5
    }
    // Research mode (autoresearch pivot): presence of this object switches the
    // epoch pipeline to real GPU experiments on the Research-Lab repo.
    research?: ResearchMeta
  }
}

export interface ResearchMeta {
  baseline_bpb: number     // val_bpb of the untouched scaffold baseline
  best_bpb: number         // best (lowest) val_bpb achieved so far
  best_epoch: number       // epoch that achieved it
  target_bpb: number       // asymptote used to normalize plant stability
  last_run?: {
    epoch: number
    val_bpb: number | null // null when the run crashed
    verdict: 'keep' | 'revert'
    status: string         // ok | crash | infra_error
    hypothesis: string
  }
}

export interface ResearchPlannerOutput {
  hypothesis: string        // ONE falsifiable claim about what will lower val_bpb
  motivation: string        // why, grounded in results/wiki history
  expected_effect: string   // predicted val_bpb direction/magnitude
  remark: string
  reasoning: string
  notebook: string
}

export interface ResearchExecutorOutput {
  train_py: string          // the COMPLETE new train.py file content
  change_summary: string    // what changed and where, a few sentences
  remark: string
  reasoning: string
  notebook: string
}

export interface ResearchReviewerOutput {
  verdict: 'keep' | 'revert'
  reason: string
  remark: string
  reasoning: string
  notebook: string
}

// ============================================
// Epoch Types
// ============================================

export interface PlannerOutput {
  direction: string
  rationale: string
  priority: number
  suggested_focus: 'capabilities' | 'constraints' | 'behaviors' | 'identity'
}

// Runtime copy of the allowed mutation targets. Model output is untyped JSON,
// so anything that uses `target` outside the spec (a branch name, a URL) must
// check it against this list first.
export const MUTATION_TARGETS = ['capabilities', 'constraints', 'behaviors', 'identity', 'experiment_params'] as const
export type MutationTarget = typeof MUTATION_TARGETS[number]

export function isMutationTarget(value: unknown): value is MutationTarget {
  return typeof value === 'string' && (MUTATION_TARGETS as readonly string[]).includes(value)
}

export interface Mutation {
  type: 'add' | 'modify' | 'remove'
  target: MutationTarget
  path: string
  value: Record<string, unknown>
  rationale: string
}

export interface ExecutorOutput {
  mutations: Mutation[]
  projected_stability_impact: number
  implementation_notes: string
}

export interface Challenge {
  mutation_index: number
  issue: string
  severity: 'critical' | 'warning' | 'note'
  example_scenario: string
  suggested_fix?: string
}

export interface ChallengerOutput {
  challenges: Challenge[]
  conflicts_with_existing: Array<{
    new_element: string
    existing_element: string
    conflict_description: string
  }>
  overall_risk: 'low' | 'medium' | 'high'
  recommendation: 'proceed' | 'proceed_with_caution' | 'needs_revision'
}

export interface RebuttalResponse {
  challenge_index: number
  stance: 'defend' | 'concede' | 'revise'
  response: string
  revised_value?: Record<string, unknown>
}

export interface RebuttalOutput {
  responses: RebuttalResponse[]
}

export interface ReviewerDecision {
  mutation_index: number
  verdict: 'approve' | 'reject' | 'modify'
  reason: string
  modified_value?: Record<string, unknown>
  challenger_concern_addressed: boolean
}

export interface ReviewerOutput {
  decisions: ReviewerDecision[]
  new_conflicts_detected: Array<{
    element_a: string
    element_b: string
    description: string
    severity: 'critical' | 'warning'
  }>
  conflicts_resolved: string[]
  updated_stability_score: number
  epoch_summary: string
}

export interface EmergentBehavior {
  observation: string    // What emerged that wasn't in the seed
  source: string         // Which model or phase introduced it
  significance: string   // Why this matters (1 sentence)
}

export interface CommentatorOutput {
  summary: string
  highlight: string
  plant_metaphor: string
  mood: 'thriving' | 'growing' | 'struggling' | 'pruning' | 'stable'
  for_returning_visitors?: string
  emergent_behaviors?: EmergentBehavior[]
}

export interface Epoch {
  id: string
  experiment_id: string
  epoch_number: number
  role_assignments: RoleAssignments
  planner_output?: PlannerOutput
  executor_output?: ExecutorOutput
  challenger_output?: ChallengerOutput
  executor_rebuttal?: RebuttalOutput
  reviewer_output?: ReviewerOutput
  commentator_output?: CommentatorOutput
  research_run?: {
    call_id?: string
    budget_s?: number
    result?: Record<string, unknown>
  }
  spec_before: AgentSpecification
  spec_after?: AgentSpecification
  plant_geometry?: PlantGeometry
  stability_delta?: number
  cost_usd: number
  started_at: string
  completed_at?: string
}

// ============================================
// Plant Geometry Types
// ============================================

export interface PlantNode {
  type: 'trunk' | 'branch' | 'leaf' | 'root'
  position: [number, number, number]
  direction: [number, number, number]
  thickness: number
  length: number
  health: number // 0-1, affects color
  specReference?: string // e.g., "capabilities.cap_1"
  children: PlantNode[]
}

export interface ConflictMarker {
  position: [number, number, number]
  severity: 'critical' | 'warning' | 'note'
  description: string
}

export interface PlantGeometry {
  nodes: PlantNode[]
  conflictMarkers: ConflictMarker[]
  overallHealth: number
  growthStage: string
}

// ============================================
// Experiment State Types
// ============================================

export type ExperimentStatus = 'seeding' | 'growing' | 'stable' | 'failing' | 'archived'

export interface Experiment {
  id: string
  created_at: string
  status: ExperimentStatus
  current_spec: AgentSpecification
  current_epoch: number
  epoch_in_progress: boolean
  glass_shattered?: boolean // True when terrarium glass has shattered (spec matured)
}

// API response for /api/experiment
export interface ExperimentState {
  id: string
  status: ExperimentStatus
  current_epoch: number
  epoch_in_progress: boolean
  epoch_progress?: number // 0-1, how far through current epoch
  current_spec: AgentSpecification
  plant_geometry: PlantGeometry
  recent_epochs: Epoch[]
  role_assignments: RoleAssignments // Next epoch's assignments
  glass_shattered?: boolean // True when terrarium glass has shattered
  repo_commit_count?: number // Real commit count on the AI-Agent repo's main branch
}

// ============================================
// Lighting & Visual State Types
// ============================================

export interface LightingPreset {
  ambient: number // hex color
  intensity: number
  redAccent?: boolean
}

export const LIGHTING_PRESETS: Record<string, LightingPreset> = {
  thriving: { ambient: 0xfff5e6, intensity: 0.5 },
  healthy: { ambient: 0xffffff, intensity: 0.4 },
  struggling: { ambient: 0xe8e8f0, intensity: 0.3 },
  critical: { ambient: 0xd0d0d8, intensity: 0.2, redAccent: true },
}

export type ParticlePreset = 'green_spores' | 'red_chaotic' | 'blue_orbital' | 'gold_dust'

export interface PatinaLevel {
  brassRoughness: number
  woodRoughness: number
  brassColorShift?: number
  dustParticles: boolean
  wearSpots: boolean
}

export const PATINA_LEVELS: Record<string, PatinaLevel> = {
  pristine: { brassRoughness: 0.4, woodRoughness: 0.8, dustParticles: false, wearSpots: false },
  light_wear: { brassRoughness: 0.5, woodRoughness: 0.85, dustParticles: true, wearSpots: false },
  aged: { brassRoughness: 0.6, woodRoughness: 0.9, dustParticles: true, wearSpots: true },
  rich_patina: { brassRoughness: 0.65, woodRoughness: 0.9, brassColorShift: 0x9a8b3c, dustParticles: true, wearSpots: true },
}

// ============================================
// Research Logging Types
// ============================================

export interface EpochLog {
  // Metadata
  epoch_number: number
  timestamp: string              // ISO format
  duration_ms: number            // How long the epoch took

  // Role assignments this epoch
  role_assignments: {
    planner: string              // Model name
    executor: string
    challenger: string
    reviewer: string
    commentator: string
  }

  // Full outputs from each role
  outputs: {
    planner: PlannerOutput
    executor: ExecutorOutput
    challenger: ChallengerOutput
    reviewer: ReviewerOutput
    commentator: CommentatorOutput
  }

  // Specification state AFTER this epoch
  specification_snapshot: AgentSpecification

  // Tracked changes
  mutations_proposed: number
  mutations_approved: number
  mutations_rejected: number
  mutations_modified: number
  prunings_this_epoch: string[]       // IDs of pruned elements
  conflicts_raised: string[]          // New conflict descriptions
  conflicts_resolved: string[]        // Resolved conflict IDs

  // Research data
  emergent_behaviors: EmergentBehavior[]
  stability_score: number
  stability_delta: number
  growth_stage: string

  // Cost tracking
  cost_usd: number
}
