# Phase 4: State Connection Design

## Overview

Connect the Observable Lab frontend to a live backend that orchestrates AI model collaboration. The experiment runs autonomously via cron, with visitors observing through the 3D visualization.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Vercel)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Three.js   │  │ StateManager│  │  TranscriptPanel        │  │
│  │  Lab Scene  │◄─┤  (polling)  │  │  (hidden by default)    │  │
│  │  + Plant    │  │             │  │  - Commentator summary  │  │
│  └─────────────┘  └──────┬──────┘  │  - Expandable transcripts│ │
└──────────────────────────┼─────────└─────────────────────────┘──┘
                           │ GET /api/experiment (15s / 2-3s)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    VERCEL SERVERLESS                             │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐   │
│  │ /api/experiment│  │ /api/epoch/run │  │ Cron: epoch-tick │   │
│  │ (GET state)    │  │ (orchestrator) │  │ (every 5 min)    │   │
│  └───────┬────────┘  └───────┬────────┘  └────────┬─────────┘   │
│          └───────────────────┼────────────────────┘              │
│                              ▼                                   │
│                    ┌─────────────────┐                           │
│                    │ Vercel Postgres │                           │
│                    └────────┬────────┘                           │
└─────────────────────────────┼────────────────────────────────────┘
                              ▼
                    ┌─────────────────┐
                    │   OpenRouter    │
                    │  (5 AI models)  │
                    └─────────────────┘
```

## Database Schema

Tables:
- `experiments` - Current experiment state, spec JSONB
- `epochs` - Full history of each epoch with all model outputs
- `mutations` - Individual spec changes for research queries
- `conflicts` - Detected contradictions and resolutions
- `visitor_sessions` - Track returning visitors

## Polling Strategy

- Default: 15-second intervals
- During `epoch_in_progress === true`: 2-3 second intervals
- StateManager structured for future SSE upgrade

## Dynamic Lab Systems

### 1. Lighting (stability-driven)
| Stability | Lighting |
|-----------|----------|
| > 0.8 | Warm amber (0xFFF5E6, 0.5) |
| 0.5-0.8 | Neutral daylight (0xFFFFFF, 0.4) |
| 0.3-0.5 | Cool dim (0xE8E8F0, 0.3) |
| < 0.3 | Desaturated + red accents (0xD0D0D8, 0.2) |

### 2. Particles (state-driven)
| Condition | Particles |
|-----------|-----------|
| growing + stability > 0.5 | Green spores toward plant |
| growing + stability < 0.5 | Red chaotic |
| stable | Blue orbital |
| default | Warm gold dust up |

### 3. Station Activation (during epochs)
Sequential activation based on epoch progress:
- 0-20%: Planner lamp ON, scientist working
- 20-40%: Executor lamp ON, scientist working
- 40-60%: Challenger red lamp FLARE, scientist working
- 60-80%: Reviewer microscope ON, scientist working
- 80-100%: Commentator lamp ON, scientist working

Active scientist's coat accent color glows.

### 4. Patina (epoch-based aging)
| Epochs | Materials |
|--------|-----------|
| < 10 | Pristine |
| 10-50 | Light wear, dust |
| 50-100 | Aged, wear spots |
| > 100 | Rich patina |

## Procedural Plant

Server computes plant geometry from spec:
- Trunk: identity.purpose clarity
- Branches: capabilities (one per active capability)
- Leaves: behaviors (attached to parent capability branch)
- Roots: constraints (visible through glass base)
- Conflicts: brown spots/wilting at conflict locations

Frontend receives pre-computed geometry, renders with GSAP transitions.

## Transcript Panel

- Hidden by default (subtle icon to open)
- Shows Commentator summaries
- Full transcripts expandable within panel
- Goal: test if observers understand system without text

## File Structure

```
src/
├── shared/types.ts              # Shared types (AgentSpec, Epoch, PlantNode, etc.)
├── api/StateManager.ts          # Polling, state sync
├── systems/
│   ├── LightingController.ts    # Stability-driven lighting
│   ├── ParticleSystem.ts        # State-driven particles
│   └── TranscriptPanel.ts       # Hidden summary panel
├── entities/
│   ├── Plant.ts                 # Renders pre-computed geometry
│   ├── Scientist.ts             # Working animation, coat glow
│   └── Station.ts               # Activation states

server/
├── api/experiment/route.ts      # GET state, POST seed
├── api/epoch/run.ts             # Orchestrator
├── api/epoch/tick.ts            # Cron endpoint
├── lib/
│   ├── db.ts                    # Postgres connection
│   ├── role-rotation.ts         # Shuffled Latin square
│   ├── prompts.ts               # System prompts
│   ├── seed-spec.ts             # Initial spec
│   └── plant-generator.ts       # Spec → geometry
└── migrations/001_initial_schema.sql
```

## Environment Variables

```
OPENROUTER_API_KEY=...
POSTGRES_URL=...
EPOCH_INTERVAL_MINUTES=60
```

## Implementation Order

1. Shared types
2. Database schema + migrations
3. Server lib (db, role-rotation, prompts, seed-spec)
4. Plant generator (server-side)
5. API endpoints
6. StateManager (frontend polling)
7. LightingController
8. ParticleSystem
9. Station activation + scientist animations
10. TranscriptPanel
11. Patina system
12. Integration + testing
