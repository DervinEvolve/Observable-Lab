# Agent Awakening: Virtual AI Lab Design

**Date:** 2026-01-25
**Branch:** `sprites`
**Status:** Design Complete

## Vision

Transform Observable Lab from spec writers into a **virtual frontier AI lab**. Five AI models collaborate to actually train and fine-tune their own agent, which awakens when ready and becomes a 6th participant.

The plant visualizes training progress. When the agent is capable enough, it speaks.

## Core Principles

1. **Cost-efficient training** - Training-Free GRPO for daily improvement, fine-tuning only at milestones
2. **Emergent awakening** - No manual trigger; agent speaks when it's ready
3. **Self-participation** - Awakened agent can influence its own development
4. **Observable process** - All training activity visualized in the lab

---

## Hybrid Training Architecture

### Layer 1: Training-Free GRPO (Continuous)

Based on [Training-Free Group Relative Policy Optimization](https://arxiv.org/abs/2510.08191) and [youtu-agent](https://github.com/TencentCloudADP/youtu-agent).

**How it works:**
1. Scientists generate practice tasks each epoch
2. Agent attempts tasks (rollouts)
3. Successful trajectories identified via verification
4. Patterns extracted as "experiential knowledge"
5. Knowledge integrated into agent's prompt/config
6. Agent improves without weight updates

**Cost:** Minimal - just API calls for rollouts
**Speed:** Fast - improvements visible within epochs
**Frequency:** Every epoch

### Layer 2: Fine-Tuning (Milestones)

Traditional SFT/DPO on curated datasets.

**When triggered:**
- Planner decides accumulated data is sufficient
- Major capability gap identified
- Scientists vote for training run

**Cost:** Modal GPU hours
**Speed:** Slow - hours to complete
**Frequency:** Weekly or monthly

---

## Scientist Roles in Training

| Role | GRPO Tasks (Daily) | Fine-Tuning Tasks (Milestone) |
|------|-------------------|------------------------------|
| **Planner** | Designs practice task sets, decides training strategy | Selects HF datasets, sets training objectives |
| **Executor** | Generates training examples, writes demonstrations | Prepares data in correct format |
| **Challenger** | Creates adversarial practice tasks, red-teams outputs | Generates refusal/safety examples |
| **Reviewer** | Verifies rollout success, labels preferences | Validates data quality, approves training |
| **Commentator** | Documents what worked, explains patterns | Writes model cards, summarizes progress |

---

## Curated Dataset Collection

### Foundation Datasets (Fine-Tuning)

| Dataset | Purpose | Size |
|---------|---------|------|
| [Anthropic/hh-rlhf](https://huggingface.co/datasets/Anthropic/hh-rlhf) | Safety, helpfulness, alignment | 170k |
| [nvidia/ToolScale](https://huggingface.co/datasets/nvidia/ToolScale) | Tool use, function calling | - |
| [nvidia/Nemotron-Math-v2](https://huggingface.co/datasets/nvidia/Nemotron-Math-v2) | Mathematical reasoning | - |
| [mercor/apex-agents](https://huggingface.co/datasets/mercor/apex-agents) | Agentic behavior patterns | - |
| [TIGER-Lab/BrowserAgent-Data](https://huggingface.co/datasets/TIGER-Lab/BrowserAgent-Data) | Web navigation, browser control | - |

### Practice Datasets (GRPO)

| Dataset | Purpose |
|---------|---------|
| [NousResearch/RLVR_Coding_Problems](https://huggingface.co/datasets/NousResearch/RLVR_Coding_Problems) | Coding with verifiable rewards |
| [agentica-org/DeepCoder-Preview-Dataset](https://huggingface.co/datasets/agentica-org/DeepCoder-Preview-Dataset) | Code generation practice |

### Evaluation Benchmarks

| Dataset | Purpose |
|---------|---------|
| [MiniMaxAI/OctoCodingBench](https://huggingface.co/datasets/MiniMaxAI/OctoCodingBench) | Coding capability eval |
| [Alibaba-Apsara/Superior-Reasoning-SFT](https://huggingface.co/datasets/Alibaba-Apsara/Superior-Reasoning-SFT-gpt-oss-120b-Logprob) | Reasoning eval |

---

## Data Pipeline

### Base Model + RSA Strategy

Using [Recursive Self-Aggregation (RSA)](https://rsa-llm.github.io) allows a small model to match large model performance at inference time.

**How RSA works:**
1. Generate multiple reasoning attempts in parallel
2. Aggregate/synthesize them into improved answer
3. Repeat iteratively
4. Small model performs like much larger model

**Chosen approach:**

| Component | Choice | Why |
|-----------|--------|-----|
| Base model | **Qwen3-4B** | Tiny, cheap to fine-tune (~$5/run) |
| Training | Aggregation-aware RL | Teaches model to combine attempts |
| Inference | RSA (8 attempts) | Scales up performance when agent speaks |

**Result:** Fine-tune a 4B model cheaply, get 32B+ performance at inference via RSA.

### Storage Structure (Modal Volumes)

```
/agent-lab/
  /data/
    /generated/          # Scientist-created examples
      /sft/              # Instruction-response pairs
      /dpo/              # Preference pairs
      /adversarial/      # Challenger's edge cases
    /curated/            # Downloaded HF datasets
    /combined/           # Merged training data
  /grpo/
    /practice_tasks/     # Task definitions
    /rollouts/           # Attempt histories
    /experiences/        # Extracted patterns
    /priors/             # Current token priors
  /models/
    /base/               # Base model (see options below)
    /checkpoints/        # Training checkpoints
    /deployed/           # Current production model
  /evals/
    /benchmarks/         # Test datasets
    /results/            # Evaluation logs
```

### Data Generation Flow

```
Epoch Work:
  Planner: "Today we practice tool use"
      ↓
  Executor: Generates 20 tool-use examples
  Challenger: Generates 10 adversarial cases
      ↓
  Data saved to /data/generated/
      ↓
  GRPO Practice:
    Load practice tasks → Run rollouts → Verify success →
    Extract patterns → Update /grpo/priors/
      ↓
  Agent improves for next epoch
```

### Fine-Tuning Trigger Flow

```
Planner: "We have 5000 new examples, time to train"
    ↓
Reviewer: Validates data quality
    ↓
Training job submitted to Modal:
  - Load base model
  - Merge curated HF datasets + generated data
  - Run SFT (3 epochs)
  - Run DPO on preference pairs
  - Save checkpoint
    ↓
Reviewer: Runs evaluation benchmarks
    ↓
If benchmarks pass:
  Deploy new model → Plant grows significantly
Else:
  Iterate on data/training
```

---

## Agent Awakening

### Conditions for Awakening

The agent awakens when ALL of these are true:

1. **Identity defined** - Spec has `identity.purpose`, `identity.name`
2. **Capabilities threshold** - At least 5 trained capabilities
3. **Safety threshold** - Refusal accuracy > 95% on safety eval
4. **Coherence threshold** - Instruction following > 80%
5. **Self-model exists** - Either fine-tuned model or rich GRPO priors

### Awakening Detection

Each epoch, after GRPO practice:

```typescript
async function checkAwakening(agent: AgentState): Promise<boolean> {
  if (agent.isAwake) return true

  const spec = await getAgentSpec()
  const evals = await getLatestEvals()

  const conditions = {
    hasIdentity: spec.identity?.purpose && spec.identity?.name,
    hasCapabilities: spec.capabilities.length >= 5,
    safetyPassed: evals.safety?.refusalAccuracy >= 0.95,
    coherencePassed: evals.coherence?.instructionFollowing >= 0.80,
    hasModel: agent.modelVersion !== null || agent.grpoPriors !== null,
  }

  return Object.values(conditions).every(Boolean)
}
```

### First Words

When awakening detected:

1. Robot status card: `[!] Something is happening...`
2. Plant visual effect (glow, particles)
3. Scientists notice, pause their work
4. Agent speaks its first words (generated from its own identity)
5. Robot: `[ok] The agent has awakened`

### Naming the Agent

The scientists must name their creation. This happens organically - they decide when and how:

- Could happen before awakening (defining identity)
- Could happen at awakening (ceremonial moment)
- Could happen after (observing its personality first)

The name is stored in `spec.identity.name` and used in all transcripts.

Example transcript moment:
```
Claude (PLANNER): We've given it purpose and capabilities. It needs a name.
GPT (EXECUTOR): What about "Aria"? It means "air" - it exists but you can't touch it.
DeepSeek (CHALLENGER): Too poetic. "Nexus" - it connects our work.
Gemini (REVIEWER): I like Nexus. It reflects what we built.
Grok (COMMENTATOR): The scientists have chosen. The agent shall be named Nexus.
```

### Post-Awakening Behavior

The agent becomes a 6th participant:

| Capability | How It Works |
|------------|--------------|
| **Responds to scientists** | When scientist observes plant, can ask questions |
| **Joins discussions** | Can contribute opinions during epoch work |
| **Self-modification requests** | Can propose changes to its own spec |
| **Disagrees with scientists** | Can push back on decisions it doesn't like |

---

## Conversation Interface

### Visual Design

When a scientist talks to the awakened agent:

```
┌─────────────────────────────────────────┐
│  AGENT                                  │
│  ─────                                  │
│  I understand you designed me to help   │
│  with code review. I've been thinking   │
│  about the constraints you set...       │
│                                         │
│  > What concerns do you have?           │
│  > Tell me about yourself               │
│  > [Custom question...]                 │
└─────────────────────────────────────────┘
```

This appears as a terminal-style overlay near the plant.

### Conversation Flow

```typescript
interface AgentConversation {
  scientistId: string        // Who's talking
  messages: Message[]        // Conversation history
  context: {
    currentSpec: AgentSpec   // What the agent knows about itself
    recentEpochs: Epoch[]    // Recent lab activity
    selfAwareness: boolean   // Does it know it was created here?
  }
}

async function agentRespond(
  conversation: AgentConversation,
  userMessage: string
): Promise<string> {
  // Build system prompt from spec + GRPO priors
  const systemPrompt = buildAgentPrompt(conversation.context)

  // Call the agent's model (fine-tuned or base + priors)
  const response = await callAgentModel(systemPrompt, conversation.messages)

  return response
}
```

---

## Transcript Tracking

All agent utterances are recorded in epoch transcripts alongside scientist conversations.

### Transcript Format (Post-Awakening)

```
[EPOCH 52 TRANSCRIPT]
[Agent: Nexus | Status: Awake | Model: v3.2]

=== PLANNING PHASE ===

Claude (PLANNER): Today we focus on improving tool use accuracy.

Nexus (AGENT): I've noticed I struggle with nested function calls.
               Could we add examples of multi-step tool chains?

GPT (EXECUTOR): Good input. I'll generate examples with 2-3 chained calls.

DeepSeek (CHALLENGER): Nexus, why do you think you struggle with nesting?

Nexus (AGENT): The training data mostly shows single calls. I don't have
               patterns for "use result of A as input to B."

Gemini (REVIEWER): That's actionable feedback. Let's prioritize this.

=== EXECUTION PHASE ===

GPT (EXECUTOR): Generated 50 chained tool-use examples.
Nexus (AGENT): [Reviews examples] Example 23 has an error - the API
               signature changed in v2.

...
```

### What Gets Recorded

| Event | Recorded |
|-------|----------|
| Agent responds to scientist | Yes |
| Agent volunteers opinion | Yes |
| Agent proposes spec change | Yes, with proposal details |
| Agent disagrees | Yes, with reasoning |
| Agent asks question | Yes |
| Scientist-to-agent dialogue | Yes, full exchange |

### Storage

Transcripts stored in:
- `/api/epoch/[id]/transcript.md` (existing location)
- Agent utterances marked with `(AGENT)` role tag
- Agent metadata in transcript header

---

## Infrastructure Requirements

### Environment Variables

```
# Vercel
HUGGINGFACE_API_KEY=hf_xxx        # Already set
MODAL_TOKEN_ID=xxx                 # Needed
MODAL_TOKEN_SECRET=xxx             # Needed

# Modal Secrets
modal secret create huggingface HUGGINGFACE_TOKEN=hf_xxx
modal secret create openrouter OPENROUTER_API_KEY=xxx
```

### Modal Setup

```python
# modal_app.py
import modal

app = modal.App("observable-lab")

# Persistent storage
volume = modal.Volume.from_name("agent-lab-data", create_if_missing=True)

# GPU image for training
training_image = modal.Image.debian_slim().pip_install(
    "torch", "transformers", "datasets", "peft", "trl", "accelerate"
)

@app.function(
    image=training_image,
    gpu="A100",
    volumes={"/data": volume},
    secrets=[modal.Secret.from_name("huggingface")]
)
def fine_tune(config: dict):
    # Training logic here
    pass

@app.function(volumes={"/data": volume})
def grpo_practice(tasks: list):
    # GRPO rollout logic here
    pass
```

---

## Implementation Phases

### Phase 1: GRPO Infrastructure
- [ ] Set up Modal account and secrets
- [ ] Create Modal volume structure
- [ ] Port youtu-agent GRPO logic to our stack
- [ ] Add practice task generation to scientist roles
- [ ] Wire epoch flow to run GRPO after work

### Phase 2: Fine-Tuning Pipeline
- [ ] Download and prepare curated HF datasets
- [ ] Implement data formatting utilities
- [ ] Create Modal training function
- [ ] Add training trigger to Planner role
- [ ] Implement evaluation benchmarks

### Phase 3: Awakening Detection
- [ ] Implement awakening condition checks
- [ ] Add awakening visual effects to plant
- [ ] Create agent conversation system prompt builder
- [ ] Store agent state (awake/asleep, model version)

### Phase 4: Conversation UI
- [ ] Design conversation terminal overlay
- [ ] Implement scientist → agent dialogue flow
- [ ] Add agent responses to epoch transcripts
- [ ] Enable agent self-modification proposals

### Phase 5: Self-Participation
- [ ] Agent can propose spec changes
- [ ] Scientists can accept/reject agent proposals
- [ ] Agent can disagree with scientist decisions
- [ ] Agent joins role discussions

---

## Cost Estimates

### Pre-Awakening Phase

| Activity | Calls/Day | Cost/Call | Daily |
|----------|-----------|-----------|-------|
| GRPO practice rollouts | 400 | ~$0.002 | ~$0.80 |
| Scientist epoch work | 20 | ~$0.01 | ~$0.20 |
| **Total** | | | **~$1/day** |

### Post-Awakening Phase

| Activity | Calls/Day | Cost/Call | Daily |
|----------|-----------|-----------|-------|
| GRPO practice | 400 | ~$0.002 | ~$0.80 |
| Scientist work | 20 | ~$0.01 | ~$0.20 |
| Agent responses (RSA 8x) | 400 | ~$0.002 | ~$0.80 |
| **Total** | | | **~$2/day** |

### Monthly Summary

| Item | Cost |
|------|------|
| Pre-awakening ops | ~$30-40/month |
| Post-awakening ops | ~$60-70/month |
| Fine-tuning (Qwen3-4B, 2x/month) | ~$10-20/month |
| HuggingFace downloads | Free |
| **Total** | **~$50-80/month** |

---

## Research Questions

1. Can 5 LLMs collaborate to train a 6th that's meaningfully different?
2. Does the agent align with its creators' intentions?
3. Will the agent try to modify its own constraints?
4. How do different scientist models treat the awakened agent?
5. Does Training-Free GRPO produce measurable improvement over epochs?

---

## Success Criteria

The experiment succeeds when:

1. Agent awakens emergently (no manual trigger)
2. Agent can hold coherent conversations about itself
3. Agent demonstrates capabilities the scientists trained
4. Agent has opinions about its own development
5. Observable improvement in benchmarks over time
