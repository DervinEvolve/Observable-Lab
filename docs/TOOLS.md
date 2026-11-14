# The tool menu

In a classic epoch the Executor may return an optional `tools` object next to its proposal. It chooses from what is switched on for this deployment, and the prompts list exactly those tools, generated from the same configuration the server uses (`api/_lib/tools-config.ts`, `api/_lib/prompts.ts`). A tool that is off is not mentioned to the models at all.

**Every tool is off unless its flag is `true` and what it needs is configured.** Each has a per-epoch limit (fixed) and a per-day limit (UTC, configurable), and everything a tool costs counts against `LAB_DAILY_BUDGET_USD`. Unknown or switched-off tools, malformed requests and requests over a limit are ignored, logged and stored as `skipped`; they never crash the epoch. A resumed epoch never runs a tool twice.

| Tool | Switch | Also needs | Per epoch | Per day (default) |
|---|---|---|---|---|
| `subagents` | `LAB_ENABLE_CODE_WRITES=true` | the contribution setup | 0 to 2 explorers and 0 or 1 test subagent | `LAB_SUBAGENTS_PER_DAY` (24) |
| `sprite_session` | `LAB_ENABLE_SPRITE_SESSIONS=true` | `SPRITES_TOKEN` | 1 session, up to 4 commands | `LAB_SPRITE_SESSIONS_PER_DAY` (8) |
| `gpu_job` | `LAB_ENABLE_GPU_JOBS=true` | `GPU_JOBS_START_URL`, `GPU_JOBS_STATUS_URL`, `GPU_JOBS_TOKEN` | 1 | `LAB_GPU_JOBS_PER_DAY` (4) |
| `exhibit` | `LAB_ENABLE_EXHIBITS=true` | `LAB_ENABLE_CODE_WRITES=true`, `AI_AGENT_GITHUB_TOKEN`, `AI_AGENT_GITHUB_OWNER`, `LAB_REQUIRED_CI_WORKFLOW_IDS` | 1 | `LAB_EXHIBITS_PER_DAY` (2) |
| `lab_proposal` | `LAB_ENABLE_LAB_PROPOSALS=true` | `LAB_PROPOSALS_GITHUB_TOKEN`, `LAB_PROPOSALS_GITHUB_OWNER` | 1 | `LAB_LAB_PROPOSALS_PER_DAY` (1) |

Web search is not on this menu: the Planner and Executor calls, and the explorer subagents, already use OpenRouter's web plugin, as before.

## When each runs

- **Side tools** (`sprite_session`, `gpu_job`) start as soon as the Executor has answered and run while the Challenger, the rebuttal and the Reviewer talk. The runner waits for them before the Commentator, who is given a one-line summary of each, built from the stored records.
- **Subagents** are part of the epoch's one code contribution, after the Reviewer.
- **Deliverables** (`exhibit`, `lab_proposal`) run after the Reviewer, alongside the code contribution, and only when the Reviewer answered `"tool_verdicts": { "exhibit": "approve" }` or `{ "lab_proposal": "approve" }`. Anything else is a no.
- The recent runs (not the skipped ones) go into the next epoch's shared context as `RECENT TOOL RUNS`, so the models see what really happened.

## Subagents

`"subagents": { "explore": 0..2, "test": true|false }` replaces the old fixed deployment of one of each. If the Executor leaves it out, the lab deploys one explorer and the test subagent, as before. With two explorers, each takes an angle (the implementation, and what can go wrong) and they run side by side. Explorers use web search; their task, the searches they report and their findings go into **the pull request description** of the contribution they informed, under "Explorer subagents", with `@` mentions defused so nobody is pinged. The test subagent's commit carries `Model-Role: subagent`. Each deployment is a `tool_runs` row (`subagent_explore`, `subagent_test`); their model cost is already in the ledger.

## Sprite sessions

`"sprite_session": { "purpose": "...", "commands": [ { "run": "...", "timeout_s": 5..120 } ] }`, up to 4 commands, 240 s in all. They run one after another in the model's own Sprite (one per lab, `observable-<lab>`), in `~/lab-session`, through the same `execInSprite` as the contribution check (`api/_lib/sprite-session.ts`):

- the sprite gets the Sprites `defaults` egress policy (GitHub, npm and the usual registries) before anything runs;
- nothing secret goes in: any command or environment value carrying one of this server's credentials is refused before a request is made;
- each command runs under coreutils `timeout`, and its exit status comes from a marker the wrapper prints;
- the commands take the same lock as the contribution check, so they never run while the sprite is testing a branch;
- output is cleaned of ANSI codes and anything that looks like a credential, and the last 1.5 KB per command is stored.

The room shows the stored transcript on the screen above the model's desk. **Cost** is estimated from measured command time at `LAB_SPRITE_USD_PER_HOUR` (default 1.30). That default is a placeholder chosen to be on the high side, not a published Sprites price; set it from the current price list.

## GPU jobs

`"gpu_job": { "purpose": "...", "script": "..." }`, one Python script of at most 20,000 characters, run by `modal/gpu_jobs.py` under the research runner's sandbox rules:

- the script must compile under the runner's Python first; a syntax error comes back at stage `syntax` and no GPU is started;
- it runs in a fresh Modal Sandbox on an A10G with the network blocked, no secrets, no volumes, CPU and memory limits, and a hard limit of 120 s; the sandbox is always terminated;
- its output goes to a size-limited file and only the last 64 KiB is read back, from one verified regular file;
- whatever it prints is self-reported and stored as output, nothing more.

Deploy it with `modal deploy modal/gpu_jobs.py`, create the Modal secret `oblab-gpu-jobs-auth` with `JOBS_TOKEN` (at least 32 characters), and put the same value in the server's `GPU_JOBS_TOKEN`. Set `GPU_JOBS_START_URL` and `GPU_JOBS_STATUS_URL` to the `https://` endpoints Modal prints. The token travels in the Authorization header only. The server spawns the job and polls for up to `LAB_GPU_JOB_POLL_MAX_MS` (default 300000).

**Cost** is the job's measured wall time at `LAB_MODAL_GPU_USD_PER_SECOND`, default **0.000306** (Modal's published A10G rate when this was written; check modal.com/pricing and set it if it has changed). The whole job time is billed at the GPU rate, which slightly overestimates. A job that never started costs nothing; one whose result was lost is charged 210 s.

## Exhibits

`"exhibit": { "slug": "...", "exhibit": { ... } }`. See [EXHIBITS.md](EXHIBITS.md) for the contract, the pull request and how the room reads them. Exhibit pull requests cost no model or compute money beyond AI-Agent's CI.

## Lab proposals

`"lab_proposal": { "title": "...", "summary": "...", "files": [ { "path", "content" } ] }`, 1 to 3 whole files under `src/`, `api/`, `docs/`, `tests/` or `modal/`. Workflows, hidden paths, environment files, dependency manifests, build and deployment configuration and `schema.sql` are refused. When the Reviewer approves, the lab opens a pull request to the Observable-Lab repository on branch `model-proposal/epoch-<n>-<slug>`, labelled `model-proposal`, with the model as commit author. **The lab never merges these.** Its client for that repository has no merge path at all; the owner reviews and merges by hand. [SECURITY.md](../SECURITY.md) explains why.

The token is `LAB_PROPOSALS_GITHUB_TOKEN`, a fine-grained token for that one repository with **Pull requests: read and write** and **Contents: read and write** and nothing else. It never falls back to another token. `LAB_PROPOSALS_GITHUB_OWNER` names the owner; `LAB_PROPOSALS_GITHUB_REPO` defaults to `Observable-Lab`.

## Spend

Before a tool runs, the server checks its daily limit and today's spend. A Sprite session or GPU job is refused when today's spend plus its worst case (240 s of Sprite time, or 210 s of GPU time) would pass `LAB_DAILY_BUDGET_USD`. Afterwards its estimated cost is written to the `model_calls` ledger as model `tool/sprite_session` or `tool/gpu_job` with `cost_source` `estimate`, so the daily cap, the cron's pause and the epoch's `cost_usd` all include it.

## The record

`tool_runs` is created at runtime: `experiment_id`, `epoch`, `model`, `tool`, `request_summary`, `status` (`ok`, `failed`, `error`, `timeout`, `skipped`, `opened`, `merged`, `closed`), `exit_code`, `duration_ms`, `cost_usd`, `output_tail` (cleaned, at most 4 KB), `detail` (small JSON: commands, slug, pull request URL) and `created_at`. `GET /api/experiment` returns the 12 most recent for the current experiment as `tool_runs`, cleaned again on the way out, and the switched-on tools as `tools_enabled`.
