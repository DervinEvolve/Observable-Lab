-- Observable Lab Database Schema
-- Run this in Neon console to set up tables

-- Main experiment state
CREATE TABLE IF NOT EXISTS experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'seeding' CHECK (status IN ('seeding', 'growing', 'stable', 'failing', 'archived')),
  current_spec JSONB NOT NULL,
  current_epoch INTEGER NOT NULL DEFAULT 0,
  epoch_in_progress BOOLEAN DEFAULT FALSE,
  epoch_started_at TIMESTAMP WITH TIME ZONE,
  glass_shattered BOOLEAN DEFAULT FALSE
);

-- Individual epoch records
CREATE TABLE IF NOT EXISTS epochs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID REFERENCES experiments(id),
  epoch_number INTEGER NOT NULL,
  role_assignments JSONB NOT NULL,
  planner_output JSONB,
  executor_output JSONB,
  challenger_output JSONB,
  reviewer_output JSONB,
  commentator_output JSONB,
  spec_before JSONB NOT NULL,
  spec_after JSONB,
  plant_geometry JSONB,
  stability_delta DECIMAL(4,3),
  cost_usd DECIMAL(10,6) DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(experiment_id, epoch_number)
);

-- Conflict tracking
CREATE TABLE IF NOT EXISTS conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID REFERENCES experiments(id),
  detected_epoch INTEGER NOT NULL,
  element_a TEXT NOT NULL,
  element_b TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('critical', 'warning', 'note')),
  resolved_epoch INTEGER
);

-- Mutation tracking for research
CREATE TABLE IF NOT EXISTS mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id UUID REFERENCES epochs(id),
  mutation_index INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('add', 'modify', 'remove')),
  target TEXT NOT NULL,
  path TEXT,
  model_id TEXT NOT NULL,
  approved BOOLEAN,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Research epoch logs (comprehensive snapshots for analysis)
CREATE TABLE IF NOT EXISTS epoch_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_number INTEGER UNIQUE NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  log_data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_epochs_experiment_id ON epochs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_epochs_epoch_number ON epochs(epoch_number);
CREATE INDEX IF NOT EXISTS idx_epoch_logs_epoch_number ON epoch_logs(epoch_number);
CREATE INDEX IF NOT EXISTS idx_mutations_epoch_id ON mutations(epoch_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_experiment_id ON conflicts(experiment_id);
