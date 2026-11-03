# Real-Time Observation Design

**Date:** 2026-01-25
**Branch:** `sprites`
**Status:** Design Complete

## Overview

Transform Observable Lab into a true real-time observation experiment where agent movements and activities are visually tied to what they're actually doing - coding, reviewing, communicating, testing.

## Core Principles

1. **Epoch-driven for cost efficiency** - Work happens during 6-hour epoch cycles
2. **Theatrical pacing** - Stretch visualization to make work feel substantial
3. **Idle behavior preserved** - Between work, scientists wander, observe plant, chat
4. **Robot as announcer** - Floating status card shows lab-wide events

## Visual Feedback System

### Scientist Label Cards

Currently: `Claude | REVIEWER`

During active work: `Claude | REVIEWER | Reviewing PR...`

The third line appears only when the scientist has an active task.

**Task Status Examples:**
- `Writing feature code...`
- `Reviewing PR #3...`
- `Running tests...`
- `Challenging approach...`
- `Summarizing epoch...`

### Indicator States

| Element | Idle/Wandering | Active Work |
|---------|----------------|-------------|
| **Label Card** | Name + Role | Name + Role + Task |
| **Three Dots** | During conversations | Hidden |
| **Thinking Indicator** | Hidden | During processing |
| **Terminal Screen** | Hidden | Visible, streaming |
| **Scientist Position** | Wanders | At desk |

### Robot Status Card

A floating card above the robot announces lab-wide events:

| Event | Display |
|-------|---------|
| Planner active | `🎯 Planning Direction` |
| Executor coding | `💻 Writing Code` |
| Challenger reviewing | `⚠️ Challenging` |
| Reviewer judging | `🔍 Code Review` |
| Commentator narrating | `📝 Summarizing` |
| Tests running | `🧪 Running Tests` |
| Tests pass | `✅ Tests Passed!` |
| Tests fail | `❌ Tests Failed` |
| Code committed | `📦 Committed!` |
| PR created | `🔀 Pull Request` |
| Bug detected | `🐛 Bug Detected` |
| Conflict found | `⚡ Conflict Found` |

The card appears with the event, stays for 3-5 seconds, then fades.

## Epoch Flow

### Idle State (between epochs)
```
Scientists: Wander, observe plant, chat (three dots), return to desks
Robot: Idle animations, occasional wander in zone
Terminals: Hidden
Labels: Name + Role only
Robot Card: Hidden
```

### Active Epoch
```
Sequential role activation:
1. Planner → 2. Executor → 3. Challenger → 4. Reviewer → 5. Commentator

For each role:
1. Scientist already at desk
2. Terminal appears with "Loading context..."
3. Label updates: "Claude | PLANNER | Setting direction..."
4. Robot card shows: "🎯 Planning Direction"
5. Terminal streams output (slow reveal for drama)
6. Work completes
7. Robot celebrates or reacts
8. Robot card shows result: "✅ Direction Set!"
9. Label returns to: "Claude | PLANNER"
10. Terminal fades after delay
11. Next role activates
```

### Theatrical Pacing

Actual LLM calls: ~30 seconds per role
Visual duration: ~3-5 minutes per role

**Techniques:**
- Terminal types output line-by-line (not instant)
- Brief pauses between phases
- Robot reactions add beats
- Status card transitions add rhythm

## Dev Team Dynamics

### Code Reviews
- Reviewer examines Executor's output
- Can approve, reject, or request changes
- Robot card: `🔍 Code Review` → `✅ Approved` or `↩️ Changes Requested`

### Pull Requests
- After Executor commits code
- Robot card: `🔀 Pull Request Created`
- Other scientists can "see" via their terminal showing PR

### Disagreements
Resolution depends on context:
- **Technical disputes** → Run tests, evidence decides
- **Code quality** → Reviewer has authority
- **Direction/scope** → Planner decides
- **Challenges** → Challenger must be addressed

### Shared Awareness
Agents share context via:
- Git log (recent commits)
- AGENTS.md (shared memory file)
- Test status
- Current spec state

## Implementation Phases

### Phase 1: Label Card Task Status
- [ ] Add third line to label card for active task
- [ ] Show/hide based on scientist work state
- [ ] Connect to task orchestrator events

### Phase 2: Robot Status Card
- [ ] Create floating card component above robot
- [ ] Event-driven display system
- [ ] Fade in/out animations
- [ ] Icon + text format

### Phase 3: Terminal Theatrical Pacing
- [ ] Slow line-by-line output streaming
- [ ] "Loading context..." intro phase
- [ ] Result summary display
- [ ] Configurable timing

### Phase 4: Epoch Orchestration
- [ ] Sequential role activation with visual handoffs
- [ ] Connect real Sprites execution to terminals
- [ ] Stream actual code output
- [ ] Git operations (commit, PR)

### Phase 5: Polish
- [ ] Tune timing for best observer experience
- [ ] Robot reaction variety
- [ ] Smooth transitions between phases

## Technical Notes

### Scientist Animations Available
- idle
- standing
- walking
- jump

Limited expressiveness - rely on terminals, labels, and robot for feedback.

### Robot Animations Available
- idle, standing
- jump, thumbsup, yes
- dance, walkjump
- no, death
- punch
- wave

Rich expressiveness - use robot as emotional feedback for lab events.

### Cost Considerations
- Epochs every 6 hours (4 per day)
- ~5 LLM calls per epoch (one per role)
- Sprites execution costs separate
- No work between epochs (idle visualization only)
