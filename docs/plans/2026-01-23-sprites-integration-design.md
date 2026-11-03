# Sprites Integration Design

**Date:** 2026-01-23
**Branch:** `sprites`
**Status:** In Progress

## Overview

Extend Observable Lab so that the AI scientists don't just cultivate a specification—they also build the agent as working code using Sprites.dev sandboxes.

## Core Concept

**"The Lab Builds What It Designs"**

Two parallel systems:
1. **Specification Evolution** (existing) - Epochs mutate the spec
2. **Code Evolution** (new) - Sprites execute real code tasks derived from the spec

## Architecture

### Sprites Setup

Each AI model gets its own persistent Sprite container, all connected to a shared "AI Agent" repo:

```
┌─────────────────────────────────────────────────┐
│                 "AI Agent" Repo                  │
│            (hosted on GitHub)                    │
└─────────────────────────────────────────────────┘
        ▲           ▲           ▲           ▲           ▲
   ┌────┴───┐  ┌────┴───┐  ┌────┴───┐  ┌────┴───┐  ┌────┴───┐
   │ Claude │  │  GPT   │  │ Gemini │  │  Grok  │  │DeepSeek│
   │ Sprite │  │ Sprite │  │ Sprite │  │ Sprite │  │ Sprite │
   └────────┘  └────────┘  └────────┘  └────────┘  └────────┘
```

### Shared Awareness System

Agents share context via:
- Git log (last 10 commits)
- File tree (current structure)
- Open tasks
- Test status
- **AGENTS.md** - shared memory file agents read AND write

### Task Flow

```
Spec Change (epoch)
       │
       ▼
Task Generated ──────► Task Queue
       │
       ▼
Assigned by Role ────► Scientist receives task
       │
       ▼
Sprite Executes ─────► Activity events stream
       │
       ▼
Scientist Behavior ──► Walks to desk, works, reacts
       │
       ▼
Completion ──────────► Commit, update AGENTS.md, next
```

## Visual Components

### Hovering Screens (4 stations)

Abstract "living blueprint" visualization above each desk (except whiteboard/Planner station):
- Executor, Reviewer, Challenger, Commentator stations get screens
- Planner station keeps whiteboard only
- Screens only appear when agent is actively coding (hidden when idle)
- Aligned with desk orientation, facing scientist

**Visual Elements:**

| Activity | Visualization |
|----------|---------------|
| Writing code | Particles flowing into forming geometric blocks |
| Reading files | Gentle pulse/glow on existing block structures |
| Running tests | Ripples emanating outward, green/red color wash |
| Git commit | Blocks solidify, brief golden flash |
| Error/failure | Red particles scatter, blocks shake |
| Idle | Screen hidden (fades out) |

### Robot Mascot

**Model:** `/public/models/scientists/code/Robot.gltf`

**Constraints:**
- Scaled to ~45% of scientist scale (0.0018 vs 0.004)
- Territory: Beside planner desk (X: 1.2-2.8, Z: -5.5 to -3.5)
- Faces center (plant) when idle
- No collision with scientists

**Animations (14 available):**

| Code Event | Robot Animation |
|------------|-----------------|
| Idle, code healthy | `Robot_Idle` / `Robot_Standing` |
| Tests pass | `Robot_Jump` + `Robot_ThumbsUp` |
| All tests pass | `Robot_Dance` |
| Tests fail | `Robot_No` |
| Build broken | `Robot_Death` |
| Bug being fixed | `Robot_Punch` |
| PR merged | `Robot_Yes` + `Robot_ThumbsUp` |
| Epoch start | `Robot_Wave` |
| Moving | `Robot_Walking` |
| Big milestone | `Robot_WalkJump` + `Robot_Dance` |

## Scientist Behavior Updates

### Task-Driven Behavior

| Task Event | Scientist Behavior |
|------------|-------------------|
| Task assigned | Walk to desk, work animation |
| Writing code | Working animation, screen particles flow |
| Processing | Hovering indicator above label |
| Tests pass | Eureka animation |
| Tests fail | Frustrated animation |
| Need review | Walk to Reviewer station, converse |
| Blocked | Walk to relevant colleague, converse |
| Task complete | Return to idle pool |

### Idle Behavior (unchanged)

Between tasks, scientists still wander, observe plant, have spontaneous conversations.

## Implementation Phases

### Phase 1: Branch Setup & Robot Mascot ✅
- [x] Create `sprites` branch
- [x] Add Robot entity (scaled, positioned near planner)
- [x] Wire robot animations to placeholder events

### Phase 2: Hovering Screens ✅
- [x] Create AbstractScreen component
- [x] Add to 4 stations (executor, reviewer, challenger, commentator)
- [x] Build particle/block animation system

### Phase 3: Sprites Integration ✅
- [x] Set up Sprites account and 5 containers (user has account)
- [x] Create "AI Agent" repo (https://github.com/DervinEvolve/AI-Agent.git)
- [x] Build Task Orchestrator service
- [x] Build SpritesService for API integration
- [x] Wire activity events to screen visuals
- [ ] Implement AGENTS.md shared context
- [ ] Configure SPRITES_TOKEN environment variable

### Phase 4: Task Generation ✅
- [x] Connect spec changes to task creation
- [x] Build task queue system
- [x] Map epoch roles to task types

### Phase 5: Behavior Wiring ✅
- [x] Connect task events to scientist behaviors
- [x] Connect task events to screen activities
- [x] Add thinking indicator (rotating dots above scientist)
- [x] Wire robot reactions to task completion/failure

### Phase 6: Polish ✅
- [x] Task-type specific visual feedback
- [x] Different robot celebrations per task type
- [ ] Performance optimization (if needed)
- [ ] Testing with live Sprites containers
