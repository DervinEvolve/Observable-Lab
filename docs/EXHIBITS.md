# Exhibits

An exhibit is a small object a model designs for the room: something for a shelf, a pedestal, a wall, the floor or the ceiling. It is stored in the specimen repository (AI-Agent) as data, reviewed like any other change, and the room only draws what the merged file says. This page is the contract shared by the lab server, AI-Agent's own check and the room.

## Where it lives

`exhibits/<slug>/exhibit.json` in AI-Agent, one file per folder and nothing else in it. The slug is 3 to 40 characters of `a-z`, `0-9` and `-`.

The file is **data only**. No scripts, no URLs, no external assets, no markup. Any string that looks like a URL (`://`, `www.`, `data:`, `javascript:`), a tag (`<...`) or an event handler (`onload=`) is rejected, and so is any key the contract does not name.

## Version 1

| Field | Rule |
|---|---|
| `version` | the number 1 |
| `title` | text, 1 to 60 characters |
| `description` | text, 1 to 400 characters |
| `author_model` | the model's display name, up to 60 characters. **Filled in by the lab, never taken from the model.** |
| `placement` | `pedestal`, `shelf`, `wall`, `ceiling` or `floor` |
| `palette` | 1 to 6 colours as `#rrggbb` |
| `parts` | 1 to 64 parts (below) |
| `animation` (optional) | `spin` 0 to 1 rad/s, `bob` 0 to 0.2 m, `pulse` 0 to 2 Hz |
| `label` (optional) | text, up to 40 characters |

A part:

| Field | Rule |
|---|---|
| `shape` | `box`, `sphere`, `cylinder`, `cone`, `torus`, `capsule`, `ring` or `tube` |
| `size` | `[x, y, z]`, each 0.01 to 2.0 metres |
| `position` | `[x, y, z]`, each -1.5 to 1.5 |
| `rotation` (optional) | `[x, y, z]` radians, each -7 to 7 |
| `colour` | an index into `palette` |
| `material` | `wood`, `brass`, `glass`, `paper`, `stone`, `ceramic`, `leaf` or `light` |
| `repeat` (optional) | `count` 1 to 24, with `radial: { radius }` (0 to 1.5) and/or `linear: { step: [x, y, z] }` (each -1.5 to 1.5) |
| `path` | tubes only, and required for them: 2 to 16 `[x, y, z]` points, each -1.5 to 1.5 |

The whole file is at most 32 KiB.

## Triangle budget

One exhibit may cost at most **6,000** triangles, estimated at the room's fixed segment counts and multiplied by `repeat.count`:

| Shape | Triangles each |
|---|---|
| box | 12 |
| sphere (16 x 12) | 352 |
| cylinder (16 radial) | 64 |
| cone (16 radial) | 48 |
| torus (12 x 24) | 576 |
| capsule (8 x 16) | 544 |
| ring (24) | 48 |
| tube (8 radial) | 16 for each path segment |

Cone and capsule are counted a little high on purpose, so the estimate is never lower than what the room draws. The room shows at most **8** exhibits at once: the newest merged first, and at most one per model for each placement kind. That keeps the exhibits within 48,000 triangles in the worst case.

## How one gets made

1. In an epoch's Executor step, when `LAB_ENABLE_EXHIBITS=true` (see [TOOLS.md](TOOLS.md)), the model may add `"exhibit": { "slug", "exhibit": {...} }` to its `tools`.
2. The lab replaces `author_model` with the display name of the model that actually answered, and checks the result against this contract (`api/_lib/exhibits.ts`). The Reviewer is told whether it passed.
3. Only if the Reviewer answers `"tool_verdicts": { "exhibit": "approve" }` does the lab open a pull request to AI-Agent on branch `exhibit/epoch-<n>-<slug>` that adds the one file. The commit is authored by the model on `observable-lab.invalid`, committed by the owner, with `Model:` and `Model-Role: exhibit` trailers.
4. It merges only when AI-Agent's trusted CI workflows (`LAB_REQUIRED_CI_WORKFLOW_IDS`) pass for that exact commit. AI-Agent's CI runs its own copy of the check (`scripts/exhibits.ts`, `tests/exhibits.test.ts`). Otherwise the pull request is closed. A slug that already exists on the default branch is refused.

Every attempt, merged, closed or refused, is a row in `tool_runs` (tool `exhibit`).

## How the room gets them

The lab server reads AI-Agent's default branch through the GitHub API (`api/_lib/exhibits-reader.ts`): one tree listing, then each `exhibits/*/exhibit.json` blob, the commit that last changed it, and the pull request it was merged in. It needs no token because AI-Agent is public; if `AI_AGENT_GITHUB_TOKEN` is set it is sent to api.github.com only, for the higher rate limit. Each file is validated again; one that fails is left out and logged. A missing `exhibits/` folder, an empty repository or a GitHub outage gives an empty list (or the last good one). Results are cached for about 10 minutes per server instance.

`author_model` comes from the git record: when the commit that last changed the file is authored on `observable-lab.invalid`, that author's name is served, whatever the file says. A file the owner committed directly (the lab's own specimen jar) keeps its own value.

The response body is:

```json
{ "exhibits": [ { "slug": "specimen-jar", "commit_sha": "<40 hex>", "merged_at": "<ISO time>", "author_model": "Observable Lab", "data": { "version": 1, "...": "..." } } ] }
```

### Where to fetch it

The contract path is `GET /api/experiment/exhibits`. A new public route also needs its entry in the public route list in `tests/security.test.mjs`, which only the owner changes, so until that is done the same body is served at **`GET /api/experiment?view=exhibits`** (public, no credentials). Once the owner adds `'experiment/exhibits': ['GET']` to that list, the route file `api/experiment/exhibits.ts` is two lines:

```ts
import { exhibitsHandler } from '../_lib/exhibits-reader.js'
export default exhibitsHandler
```

## Changing the contract

Change `api/_lib/exhibits.ts`, AI-Agent's `scripts/exhibits.ts` and `exhibits/schema.json`, the room's renderer and this page together. `tests/tools.test.mjs` checks that this page states the same triangle table as the code.
