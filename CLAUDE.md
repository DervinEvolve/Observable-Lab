# Observable Multi-Agent Lab

## What Is This?

A **browser-based 3D research environment** where visitors observe five AI models (from different labs) collaborating to cultivate an agent specification. The experiment runs continuously—models rotate roles every epoch, and the results persist over time.

This is an experiment: we don't know what the models will produce. The stored epochs are the record. Room animation, and the labelled simulation that plays when no experiment is connected, are not evidence of model work. Scores in the ML research loop are self-reported by generated code and marked unverified.

---

## Core Concept

Five frontier AI models take turns in five roles, working together to grow an "agent specification" visualized as a plant:

| Role | What They Do |
|------|--------------|
| **Planner** | Sets direction: "What should we explore next?" |
| **Executor** | Implements: "Here's how that capability would work" |
| **Challenger** | Attacks: "Here's how this could fail" |
| **Reviewer** | Judges: "Approve, reject, or modify" |
| **Commentator** | Narrates: "Here's what happened" (for visitors) |

Roles change every epoch. In each aligned block of five epochs (0–4, 5–9, …) every model plays every role once (`api/_lib/role-rotation.ts`). When an assigned model fails, a fallback model answers and the stored output records it in `served_by`.

---

## The Five Models (via OpenRouter)

The current IDs live in `api/_lib/types.ts` and `src/shared/types.ts`:

| Model ID | Provider | Personality |
|-------|----------|-------------|
| `google/gemini-3.5-flash` | Google | Exploratory, multimodal |
| `deepseek/deepseek-v4-pro` | DeepSeek | Methodical, structured |
| `anthropic/claude-opus-4.8` | Anthropic | Safety-conscious, nuanced |
| `openai/gpt-5.5` | OpenAI | Agentic, general-purpose |
| `x-ai/grok-4.3` | xAI | Edgy, adversarial |

---

## Tech Stack

**Frontend:**
- Three.js (3D visualization)
- TypeScript
- Vite
- GSAP (animations)

**Backend:**
- Node.js or Cloudflare Workers
- PostgreSQL or D1 (state persistence)
- OpenRouter API (unified model access)
- WebSocket or polling for real-time updates

**Deployment:**
- Vercel (frontend)
- Serverless functions (epoch orchestration)

---

## Visual Aesthetic: "Quiet Science"

**NOT:** Cyberpunk, neon, sterile white, corporate tech
**YES:** Academic research lab, warm wood + brass + glass, instruments with patina

### Color Palette
```
Structure:     Wood #8B7355, Brass #B5A642, Glass #E8E4D9, Walls #F5F2EB
States:        Healthy #7CB342, Working #FFB74D, Blocked #E57373, Stable #64B5F6
Model Accents: Gemini #4285F4, DeepSeek #10A37F, Claude #D97706, GPT #412991, Grok #1DA1F2
```

---

## The Plant = The Agent Spec

The central plant visualizes the agent specification being cultivated:

| Spec Element | Plant Part |
|--------------|------------|
| `identity.purpose` | Trunk (thickness = clarity) |
| `capabilities[]` | Branches |
| `constraints[]` | Roots (visible through glass base) |
| `behaviors[]` | Leaves |
| `conflicts[]` | Brown spots, wilting, stress lines |
| `stability_score` | Overall posture |

---

## The Five Stations

Each scientist works at a station that reflects their role:

1. **Planner Station** — Slate board with chalk marks
2. **Executor Station** — Workbench with tools and specimen jars
3. **Reviewer Station** — Brass microscope
4. **Challenger Station** — Red warning lamp and stress gauges
5. **Commentator Station** — Writing desk with journal and speaking tube

---

## Dynamic State Changes

**Lighting changes with experiment health:**
- Thriving (>0.8): Warm golden hour
- Healthy (0.5-0.8): Neutral daylight
- Struggling (0.3-0.5): Cool, dim
- Critical (<0.3): Desaturated, red accents

**Particles change with state:**
- Healthy: Warm dust motes drifting up
- Growing: Green spores flowing toward plant
- Conflicted: Red particles, chaotic movement
- Stable: Blue particles orbiting plant

---

## Key Files to Create

```
observable-lab/
├── CLAUDE.md                 # This file
├── docs/
│   ├── architecture.md       # Full system design
│   ├── visual-design.md      # Detailed aesthetics
│   └── threejs-spec.md       # Code patterns
├── src/
│   ├── scene/                # Three.js scene setup
│   ├── entities/             # Plant, stations, scientists
│   ├── systems/              # State, animation, particles
│   └── api/                  # OpenRouter integration
├── public/
│   ├── models/               # GLTF assets
│   └── textures/             # Material textures
└── server/
    ├── epoch-orchestrator.ts # Runs inference loop
    └── state-manager.ts      # Persists experiment state
```

---

## Build Order

### Phase 1: Static Lab
- [ ] Vite + Three.js project setup
- [ ] Lab geometry (floor, walls, ambient)
- [ ] Five station props (simplified)
- [ ] Camera controls (limited orbit)
- [ ] Basic lighting

### Phase 2: Plant System
- [ ] Procedural plant generation
- [ ] Growth stages (seed → stable)
- [ ] Health visualization
- [ ] Gentle sway animation

### Phase 3: Scientists
- [ ] Simple humanoid figures
- [ ] Station assignment
- [ ] Idle/working animations
- [ ] Role-swap transitions (coat color change)

### Phase 4: State Connection
- [ ] Backend API for experiment state
- [ ] WebSocket/polling updates
- [ ] State-driven visual changes
- [ ] Epoch transition sequences

### Phase 5: Model Integration
- [ ] OpenRouter model router
- [ ] Epoch orchestrator (5-role pipeline)
- [ ] Role rotation logic
- [ ] Cost tracking

### Phase 6: Polish
- [ ] Ambient particles
- [ ] Sound design
- [ ] Visitor return experience
- [ ] Performance optimization

---

## Performance Budget

```
Triangles:    <70,000 total
Draw calls:   <100
Textures:     <100MB VRAM
Frame rate:   60fps on mid-range hardware
```

---

## API Endpoints Needed

```
GET  /api/experiment          # Current state
GET  /api/experiment/history  # Epoch history
POST /api/experiment/seed     # Start new experiment
WS   /api/experiment/stream   # Real-time updates
```

---

## Environment Variables

```
OPENROUTER_API_KEY=...
DATABASE_URL=...
```

---

## Attribution Conventions

- Show model providers as plain text names (the shared map in `src/shared/types.ts`). Do not add provider logos; the earlier ones had no confirmed source and were removed.
- Commits the lab writes to other repositories use the identity in `api/_lib/commit-identity.ts` (the owner's GitHub noreply address). Name the model that produced a change in the `Model:` trailers, never as the git author, and do not invent e-mail domains.
- "Hon AI Research" is the owner's personal experiment name, not an organisation.

---

## Reference Docs

See `/docs/` for detailed specifications:
- `architecture.md` — Full system design, model rotation, database schema
- `visual-design.md` — Aesthetic direction, station designs, event sequences
- `threejs-spec.md` — Code patterns, materials, animations, performance

---

## Research Questions This Experiment Explores

1. Do multi-model systems converge or diverge over time?
2. Which model's "values" dominate when there are conflicts?
3. Can observers accurately predict experiment outcomes?
4. Does the skeuomorphic interface improve understanding vs. logs?
5. What does "stable" mean for an agent spec, and is it achievable?
