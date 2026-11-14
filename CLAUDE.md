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

The current IDs live in `api/_lib/types.ts` and `src/shared/types.ts`. Run 2 uses the newest flagship from each lab, exactly one model per lab (the room has five provider desks):

| Model ID | Display name | Provider | Price per 1M tokens (in / out) | Personality |
|-------|------|----------|------|-------------|
| `google/gemini-4-hydrogen` | Gemini 4 | Google | $1.50 / $7.50 | Exploratory, multimodal |
| `deepseek/deepseek-v4-pro-0813` | DeepSeek V4 Pro | DeepSeek | about $0.66 / $1.98 first-party | Methodical, structured |
| `anthropic/claude-fable-5.2` | Claude Fable 5.2 | Anthropic | $8 / $40 | Safety-conscious, nuanced |
| `openai/gpt-6-astra` | GPT-6 Astra | OpenAI | $10 / $50 | Agentic, general-purpose |
| `x-ai/grok-4.7` | Grok 4.7 | xAI | $2 / $6 | Edgy, adversarial |

Wildcards outside the rotation: North `cohere/north-mini-code:free` (free) and GLM 5.3 `z-ai/glm-5.3-prime` ($2.80 / $8.80). Fallbacks, in order, when an assigned model gives no usable answer: `anthropic/claude-sonnet-5.5`, then `google/gemini-3.8-flash`.

Prices are what the models cost when they were chosen. Spend is never computed from this table: every call records OpenRouter's real `usage.cost` (`api/_lib/openrouter.ts`, `api/_lib/spend.ts`). Each model is sent only the request parameters its entry in https://openrouter.ai/api/v1/models lists in `supported_parameters` (Anthropic and OpenAI take no `temperature`, North takes no `response_format`), with reasoning effort `medium`, or the nearest level a model lists when it has no `medium`.

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

See `.env.example` and `docs/OPERATIONS.md`. The ones that shape a run: `OPENROUTER_API_KEY`, `POSTGRES_URL`, `LAB_DAILY_BUDGET_USD` (default 15), `EPOCH_INTERVAL_MINUTES` (default 180), `EPOCH_STALE_MINUTES` (default 50), `LAB_ENABLE_CODE_WRITES`.

---

## Attribution Conventions

- Show model providers as plain text names (the shared map in `src/shared/types.ts`). Do not add provider logos; the earlier ones had no confirmed source and were removed.
- Commits the lab writes to other repositories (AI-Agent contributions, their subagents, the North and GLM wildcards, and Research-Lab records) follow `api/_lib/commit-identity.ts`:
  - **Author:** the model that produced the change, by its display name, with an address on the reserved, never-registrable `.invalid` domain: `<display name> <<slug>@observable-lab.invalid>`, where the slug is the display name lowercased with every run of other characters turned into `-`. Example: `Claude Fable 5.2 <claude-fable-5-2@observable-lab.invalid>`. A fallback model is the author under its own display name.
  - **Committer:** always the owner, `DervinEvolve <39844362+DervinEvolve@users.noreply.github.com>`.
  - **Trailers:** keep `Model:`, `Model-Role:` and `Model-Fallback-For:`. The author is read from the `Model:` trailer, so the trailers stay the record of who wrote what. A commit with no `Model:` trailer (bootstrap files, ledger rows) is authored by the owner.
  - Use no other e-mail domain. `.invalid` is reserved (RFC 2606), so these addresses can never reach a mailbox. Merge commits use whatever identity the GitHub token belongs to.
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
