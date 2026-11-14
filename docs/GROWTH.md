# How the specimen takes over the room

The plant in the glass dome stands for the agent specification the models are growing. In run 2 it can also outgrow the dome and spread through the room. How far it has spread is a **growth stage** from 0 to 6, plus a **progress** value from 0 to 1 within that stage.

The server works the stage out from stored facts only, every time `GET /api/experiment` is called, and returns it as `growth`. The room draws what that record says (`src/systems/growth.ts`, `src/entities/Overgrowth.ts`). Nothing in the browser decides how far the plant has grown, and the local simulation never sets a stage.

The code is `api/_lib/growth.ts`. The table below is its `GROWTH_THRESHOLDS` constant, and a test checks that this page and the code agree.

## Stages

| Stage | Meaning | Epochs | Spec elements | Capabilities | Constraints | Stability | Tested merges |
|---|---|---|---|---|---|---|---|
| 0 | contained seedling | 0 | 0 | 0 | 0 | 0 | 0 |
| 1 | grown inside the dome | 6 | 4 | 1 | 0 | 0.4 | 1 |
| 2 | pressing on the glass, with cracks | 24 | 12 | 4 | 2 | 0.5 | 3 |
| 3 | broken out (the glass shatters) | 56 | 24 | 8 | 4 | 0.55 | 8 |
| 4 | roots and vines across the floor | 112 | 36 | 12 | 6 | 0.6 | 16 |
| 5 | climbing walls and desks | 196 | 48 | 16 | 8 | 0.65 | 28 |
| 6 | canopy across the ceiling, room overgrown | 280 | 60 | 20 | 10 | 0.7 | 42 |

A stage is reached only when **every** number in its row is met, and only after every row above it is met too. The columns:

- **Epochs:** completed epochs of the current experiment (`current_epoch`).
- **Spec elements:** active capabilities, constraints and behaviors added together. Pruned ones don't count.
- **Capabilities** and **Constraints:** active ones of each.
- **Stability:** the specification's current `stability_score`, 0 to 1. This is the health check: a big but incoherent specification does not grow.
- **Tested merges:** code contributions to AI-Agent that merged and whose tests passed, either in the repository's CI or in the author model's Sprite (exit code 0).

## Why it is slow

Growth is meant to take weeks. At the default cadence of one epoch every 3 hours (8 a day), the epoch minimums alone come to about 1, 3, 7, 14, 24 and 35 days for stages 1 to 6. The code minimums are slower still: at most one contribution is made per epoch, it only counts once it merges with passing tests, and the daily spending cap can pause the lab.

Epochs on their own never move the plant. A run with a thousand epochs and no merged, tested code stays at stage 0, and so does a run with plenty of merged code but a stability score below the row's minimum. Sprite test passes are reported in `growth.sprite_test_passes` but are not a requirement, so a deployment without Sprites can still grow on CI results.

## Progress within a stage

`progress` is how far the slowest requirement has moved from this stage's row toward the next one. For example, the record below is at stage 2. It has 40 of the 56 epochs needed for stage 3 (half of the way from 24) but only 4 of the 8 tested merges (one fifth of the way from 3), so progress is 0.2: the merges are furthest behind. It stays below 1 until the next stage is actually reached. At stage 6 it is 1.

## Going backwards, and the glass

The stage is recomputed from the current facts each time, so it can go down: if stability drops or capabilities are pruned, the overgrowth recedes. The glass is the exception. When a completed epoch leaves the record at stage 3 or higher, the server stores `glass_shattered = true` on the experiment, and from then on `growth.glass_shattered` stays true even if the stage later drops below 3.

## The fields

`GET /api/experiment` returns:

```json
"growth": {
  "stage": 2,
  "progress": 0.2,
  "epochs": 40,
  "capabilities": 6,
  "constraints": 3,
  "behaviors": 13,
  "stability": 0.58,
  "merged_contributions": 5,
  "contributions_with_passing_tests": 4,
  "sprite_test_passes": 2,
  "glass_shattered": false
}
```

`merged_contributions` counts every merged contribution, `contributions_with_passing_tests` counts those whose tests passed in CI or in the Sprite, and `sprite_test_passes` counts every contribution, merged or not, whose Sprite run exited 0.
