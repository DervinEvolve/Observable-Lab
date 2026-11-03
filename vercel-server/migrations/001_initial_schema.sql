-- Observable Multi-Agent Lab - Initial Schema
-- Run this against Vercel Postgres

-- Experiments table
CREATE TABLE experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP DEFAULT NOW(),
  status TEXT CHECK (status IN ('seeding', 'growing', 'stable', 'failing', 'archived')),
  current_spec JSONB NOT NULL,
  current_epoch INTEGER DEFAULT 0,
  epoch_in_progress BOOLEAN DEFAULT FALSE,
  epoch_started_at TIMESTAMP
);

-- Epochs table (the research gold)
CREATE TABLE epochs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID REFERENCES experiments(id) ON DELETE CASCADE,
  epoch_number INTEGER NOT NULL,

  -- Role assignments this epoch
  role_assignments JSONB NOT NULL,
  -- { planner: "google/gemini-2.0-flash-exp", executor: "deepseek/deepseek-chat", ... }

  -- Model outputs
  planner_output JSONB,
  executor_output JSONB,
  challenger_output JSONB,
  reviewer_output JSONB,
  commentator_output JSONB,

  -- Spec snapshots
  spec_before JSONB NOT NULL,
  spec_after JSONB,
  stability_delta FLOAT,

  -- Plant geometry (pre-computed for frontend)
  plant_geometry JSONB,

  -- Metadata
  cost_usd FLOAT DEFAULT 0,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  UNIQUE(experiment_id, epoch_number)
);

-- Mutations table (for research queries)
CREATE TABLE mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id UUID REFERENCES epochs(id) ON DELETE CASCADE,
  mutation_index INTEGER,
  type TEXT CHECK (type IN ('add', 'modify', 'remove')),
  target TEXT, -- 'capabilities', 'constraints', 'behaviors', 'identity'
  path TEXT,   -- 'capabilities[2]', 'constraints.safety'
  model_id TEXT NOT NULL, -- Which model proposed this (executor)
  approved BOOLEAN,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Conflicts table
CREATE TABLE conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID REFERENCES experiments(id) ON DELETE CASCADE,
  detected_epoch INTEGER NOT NULL,
  resolved_epoch INTEGER,
  element_a TEXT NOT NULL,
  element_b TEXT NOT NULL,
  description TEXT,
  severity TEXT CHECK (severity IN ('critical', 'warning', 'note')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Visitor sessions (for "since your last visit" feature)
CREATE TABLE visitor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  last_seen_epoch INTEGER DEFAULT 0,
  visit_count INTEGER DEFAULT 1,
  first_visit TIMESTAMP DEFAULT NOW(),
  last_visit TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Indexes for research queries
-- ============================================

-- Epoch queries
CREATE INDEX idx_epochs_experiment ON epochs(experiment_id);
CREATE INDEX idx_epochs_number ON epochs(epoch_number);
CREATE INDEX idx_epochs_completed ON epochs(completed_at);

-- Mutation queries (research: which models propose what?)
CREATE INDEX idx_mutations_epoch ON mutations(epoch_id);
CREATE INDEX idx_mutations_model ON mutations(model_id);
CREATE INDEX idx_mutations_type ON mutations(type);
CREATE INDEX idx_mutations_approved ON mutations(approved);
CREATE INDEX idx_mutations_target ON mutations(target);

-- Conflict queries (research: conflict patterns)
CREATE INDEX idx_conflicts_experiment ON conflicts(experiment_id);
CREATE INDEX idx_conflicts_unresolved ON conflicts(experiment_id) WHERE resolved_epoch IS NULL;
CREATE INDEX idx_conflicts_severity ON conflicts(severity);

-- Active experiment lookup
CREATE INDEX idx_experiments_status ON experiments(status) WHERE status IN ('seeding', 'growing');

-- ============================================
-- Research query examples (for reference)
-- ============================================

-- Model behavior by role:
-- SELECT m.model_id, m.approved, COUNT(*)
-- FROM mutations m
-- JOIN epochs e ON m.epoch_id = e.id
-- GROUP BY m.model_id, m.approved;

-- Conflict patterns over time:
-- SELECT detected_epoch, COUNT(*), AVG(CASE WHEN resolved_epoch IS NOT NULL THEN resolved_epoch - detected_epoch END) as avg_resolution_time
-- FROM conflicts
-- GROUP BY detected_epoch;

-- Capability lifecycle:
-- SELECT path, type, epoch_number, approved
-- FROM mutations m
-- JOIN epochs e ON m.epoch_id = e.id
-- WHERE target = 'capabilities'
-- ORDER BY epoch_number;
