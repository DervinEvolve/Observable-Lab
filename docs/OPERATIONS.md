# Operator setup

The browser is an observer. Server credentials must not be placed in `VITE_*` variables, browser storage, query strings, screenshots, or repository files.

Copy `.env.example` for local server configuration. Vite alone does not serve the Vercel API or load a connected experiment. Set up Vercel's Node functions and Postgres separately, review `api/_lib/schema.sql` and the later table-creation helpers against the target database, and use a disposable database for migration testing. Do not assume the older `vercel-server/` scaffold is the current deployment entry point.

## Run 2: spend, cadence and the model panel

**Model panel.** One model per lab: Gemini 4, DeepSeek V4 Pro, Claude Fable 5.2, GPT-6 Astra and Grok 4.7, with North and GLM 5.3 as wildcards and `anthropic/claude-sonnet-5.5` then `google/gemini-3.8-flash` as fallbacks (`api/_lib/types.ts`). Before a call the server reads OpenRouter's public model list (https://openrouter.ai/api/v1/models, no key, cached for six hours, with a built-in snapshot when it can't be read) and sends each model only the parameters it lists in `supported_parameters`. Reasoning effort is `medium`, or the nearest level a model offers when it has no `medium` (DeepSeek V4 Pro and GLM 5.3 get `low`). `max_tokens` is 16000 for an ordinary answer, doubled when reasoning is on, and capped at the model's own output limit.

**Real cost.** Every OpenRouter response is billed at its `usage.cost`, which OpenRouter returns on every response (its older `usage: { include: true }` flag is deprecated and has no effect, so it isn't sent). Each billed response, including retries, fallbacks, code contributions and North runs, is a row in the `model_calls` table with its experiment, epoch, model, cost and token counts. An epoch's `cost_usd`, `prompt_tokens` and `completion_tokens` are that epoch's ledger totals. If a response ever lacks `usage.cost`, its tokens are priced from the model list and the row is marked `estimate`.

**Daily budget.** `LAB_DAILY_BUDGET_USD` (default 15) is compared with the sum of `model_calls.cost_usd` since 00:00 UTC. It is checked before an epoch starts, before the epoch's code contribution, and before a North run. When it is reached:

- the cron tick skips and logs `[CRON] Skipping epoch N: daily budget reached ($x of $y spent today, UTC; resumes <next UTC midnight>)`;
- `POST /api/epoch/run` and `POST /api/north/run` answer 429;
- `GET /api/experiment` shows `"run_state": "paused: daily budget reached"` with `resumes_at`, until the next UTC day.

An epoch that is already running finishes; the check is at the start. If the ledger can't be read, nothing new starts. The cap is a backstop for this lab, not a replacement for a credit limit on the OpenRouter key itself.

**Cadence.** `EPOCH_INTERVAL_MINUTES` defaults to 180 and is measured from the end of the last epoch. The cron runs hourly, so the tick allows 10 minutes of tolerance: an epoch that ended at 12:08 runs again at 15:00. The agents can still set their own interval between 30 and 180 minutes through `experiment_params`. `EPOCH_STALE_MINUTES` (default 50) is how long a running epoch may hold its claim before the tick treats it as dead and clears it.

**One epoch at a time.** Starting an epoch is a single conditional update (`epoch_in_progress` flips only if it was not already set), shared by the cron and `POST /api/epoch/run`, so the two can never run at once. Whatever way an epoch ends, the claim is released. The tick and manual run always pick the newest experiment that is not archived; experiments in `failing` keep running so they can recover, and the public state says `failing: stability below 0.2, epochs continue`.

**Code contributions.** Run 2 turns them on with `LAB_ENABLE_CODE_WRITES=true`. At most one per epoch: the approved mutation most worth backing with code (new capabilities first, then behaviors, then constraints; additions before changes; less if the Challenger left an open critical concern). It is written by that epoch's Executor, with the explorer and test subagents the Executor chose, merges only when the trusted CI workflows pass, and also runs in the author's Sprite when `SPRITES_TOKEN` is set. The explorers' task, searches and findings are written into the pull request description.

**The tool menu.** The Executor may also choose a Sprite session, a GPU job on Modal, an exhibit for the room or a proposal to this repository. Each is off unless its flag and credentials are set (`LAB_ENABLE_SPRITE_SESSIONS`, `LAB_ENABLE_GPU_JOBS`, `LAB_ENABLE_EXHIBITS`, `LAB_ENABLE_LAB_PROPOSALS`, all default false), has per-epoch and per-day limits, and is described to the models only while it is on. Sprite and GPU time is estimated from measured duration and written to `model_calls` as `tool/sprite_session` or `tool/gpu_job` with `cost_source = 'estimate'`, so the daily budget counts it; a tool whose worst case would pass today's budget does not start. Details, rates and setup: [TOOLS.md](TOOLS.md) and [EXHIBITS.md](EXHIBITS.md).

**Timing.** Sprite sessions (at most 240 s of commands) and GPU jobs (polled for at most `LAB_GPU_JOB_POLL_MAX_MS`, default 300 s) run while the Challenger, rebuttal and Reviewer are answering; the exhibit pull request waits on AI-Agent's CI alongside the code contribution. Keep these limits in mind against the 800 s function limit: an epoch that runs out of time resumes on the next tick from its stored outputs and does not run a tool twice.

**Commit authors.** Commits to AI-Agent and Research-Lab are authored by the model that wrote them, as `<display name> <<slug>@observable-lab.invalid>` (for example `Claude Fable 5.2 <claude-fable-5-2@observable-lab.invalid>`), and committed by `DervinEvolve <39844362+DervinEvolve@users.noreply.github.com>`. `.invalid` is reserved and can never be registered.

**Timeouts.** OpenRouter calls give up after 240 s (`OPENROUTER_TIMEOUT_MS`), the model list after 15 s, GitHub requests after 30 s, research runner requests after 60 s and Modal requests after 60 s. A research epoch polls its GPU run for at most `RESEARCH_RUN_POLL_MAX_MS` (default 400000 ms) and resumes on the next tick.

### Run 2 database changes

These are made at runtime, like the earlier table-creation helpers, and are also in `api/_lib/schema.sql` for a fresh database:

- `model_calls`: new table, the spend ledger (`api/_lib/spend.ts`).
- `epoch_logs`: gains `experiment_id`; the old global `UNIQUE(epoch_number)` constraint (`epoch_logs_epoch_number_key`) is dropped and replaced by a unique index on `(experiment_id, epoch_number)`, so a new experiment no longer overwrites older logs. Older rows keep a NULL `experiment_id`. If your database named that constraint differently, drop it by hand.
- `epochs`: gains `prompt_tokens` and `completion_tokens`.
- `conflicts`: gains `spec_conflict_id`, the id the specification uses, so a resolved conflict updates its row.
- `tool_runs`: new table, one row per tool use the Executor chose, including refused ones (`api/_lib/tool-runs-store.ts`, [TOOLS.md](TOOLS.md#the-record)). Created at runtime; it is not in `schema.sql`, whose owner may add it.

### Starting run 2

On a test database first. `POST /api/experiment/reset?confirm=true&mode=classic` (operator) archives every experiment that is not archived, clears their epoch flags, creates the run 2 tables, and seeds a fresh classic experiment at epoch 0. `mode=research` seeds the ML research lab the same way, now or later. `POST /api/experiment` refuses while any experiment is active, whatever its status. An epoch still running on an archived experiment finishes into the archived row and cannot make it active again.

The first epoch after a reset waits one interval from the seed, like every other epoch; `POST /api/epoch/run` starts it at once.

## Vercel route authorization

- Set `LAB_OPERATOR_SECRET` to a random server-side value of at least 32 characters. Operator clients send it as `Authorization: Bearer <value>`.
- Set a different random `CRON_SECRET`, also at least 32 characters. `/api/epoch/tick` accepts this credential only. [Vercel Cron sends the configured secret in the Authorization header](https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- Missing or short configuration returns 503. Missing or incorrect authorization returns 401 before database, model, Sprites, or compute work.
- The guard covers manual epochs, clearing stuck epochs, seeding/resetting/patching experiments, the persisted glass state, debug views, North runs, and all Sprites routes. `?confirm=true` remains an extra action check; it is not authentication.
- Ordinary experiment state (now including recent `tool_runs`, cleaned of anything that looks like a credential), merged exhibits (`GET /api/experiment?view=exhibits`), contribution records, and wildcard transcripts remain public observer endpoints. Review their contents before using private research or code in a connected deployment. Only put material intended for viewers in that experiment.

The anonymous viewer no longer calls operator routes: it does not persist the glass state or load Sprites status, and the `window.lab` and console debug helpers exist only in development builds. Use a separate trusted operator client; do not solve a 401 by embedding the operator secret in the browser. The browser's glass animation still plays locally without persisting its state.

## Modal endpoints

For the legacy `modal/web_endpoints.py` ASGI app, create the Modal secret `observable-lab-web-auth` containing `MODAL_API_TOKEN`, and set the same value in the Vercel server environment. It must contain at least 32 characters. All paths except `GET /health` require Bearer authorization. See [Modal's web function authentication guidance](https://modal.com/docs/guide/webhooks).

Set `MODAL_WORKSPACE` (and `MODAL_APP_NAME` if the app is not named `observable-lab`) in the Vercel environment. The client has no workspace default and refuses to call Modal while it is empty.

For `modal/research_runner.py`, set `RESEARCH_RUNNER_START_URL` and `RESEARCH_RUNNER_STATUS_URL` to the `https://` endpoints Modal prints for your own deployment; there are no defaults. Keep `RUNNER_TOKEN` in the `oblab-runner-auth` Modal secret and its matching value in Vercel's `RESEARCH_RUNNER_TOKEN`. Both start and status requests now use Authorization headers. They no longer accept tokens in the request body or URL. Replace any token previously used in a URL because request logs may retain it. Runner requests reject non-finite or out-of-range training budgets; the allowed range is 30–600 seconds, with 300 as the default.

Deploy the runner and Vercel client together. Old clients that send query/body tokens will stop working after the runner update. No credentials or deployed services are changed by merging source alone.

## Generated code

Autonomous research runs and updates to the research repository are intentional. The operator and scheduler authentication protects who can trigger that loop. Research GitHub access uses a separate `RESEARCH_GITHUB_TOKEN`, scoped only to the research repository; it no longer falls back to the contribution token. The research repository owner comes from `RESEARCH_GITHUB_OWNER`, or `AI_AGENT_GITHUB_OWNER` when that is empty; the contribution repository owner from `AI_AGENT_GITHUB_OWNER`. Neither has a built-in default. Configure this token before rolling out the updated client.

`LAB_ENABLE_CODE_WRITES` defaults to disabled. Explicitly enabling it allows contributions to a dedicated configured repository. Use a fine-grained token scoped to that repository and the required Contents, Pull requests, and Actions permissions. Review the separate research-repository access too; one broad personal token is not an appropriate substitute.

Generated changes may target source, tests, and documentation, or `README.md`. They may not change workflows, dependency manifests, hidden paths, or build configuration. Set `LAB_REQUIRED_CI_WORKFLOW_IDS` to the numeric IDs of the trusted test workflows in that repository. Each configured workflow must report success for the exact proposed SHA and destination repository on a push or pull-request event. An unrelated green workflow does not satisfy the gate. All matching CI runs must finish successfully; missing, failed, cancelled, or incomplete CI blocks merging. Also configure required checks and branch protection on the destination repository. This application check cannot replace those server-side controls or make generated tests trustworthy.

The merge request includes the checked head SHA, so a later branch update cannot silently substitute an unchecked commit.

The research controller runs only the reviewed preparation harness. It uses a new `oblab-research-data-v2` Volume so previously writable caches are not reused. Each experiment runs in a fresh Modal Sandbox with no secrets, network blocked, a read-only data Volume, CPU/memory limits, and a hard lifetime. `train.py` is stopped at the training budget plus `TRAIN_GRACE_S` (120 s, a constant in `modal/research_runner.py`; change it there and redeploy); a stopped run, or one that reports more training time than the budget, returns a crash at stage `budget` instead of a score. Sandboxes are terminated on success and failure. Generated training code can change its own disposable harness copy and report arbitrary metrics; those scores are explicitly marked `experiment_stdout_unverified`, and that label, the dataset label, the harness SHA-256 and the measured training wall time are written into `results.tsv` (four extra columns, added to an older header automatically), the finding page and commit trailers. Independent checkpoint evaluation is not implemented and remains necessary before a score is treated as measured. Autonomous experiment execution and research commits remain enabled by their existing configuration.

The reviewed preparation source is bundled at `modal/harness/prepare.py`, originating from Research-Lab blob `c33f69057b59a9a9785a2ec77715cb47f2ea1412`. Its image copy is built from this checkout and the controller records its SHA-256 in each result. It prepares TinyStories data; smoke preparation uses synthetic data. Review harness and dataset changes separately from generated training code. Install the deployment client with `python -m pip install -r requirements-runner.txt` (Modal SDK 1.6.3). The runner uses the supported Sandbox filesystem API; the old `Sandbox.open()` API is retired. Verify network denial, cache write denial, no injected credentials, and process termination in a test deployment before rolling out the runner.

For `modal/gpu_jobs.py` (the GPU job tool), create the Modal secret `oblab-gpu-jobs-auth` containing `JOBS_TOKEN` (at least 32 characters), put the same value in Vercel's `GPU_JOBS_TOKEN`, deploy with `modal deploy modal/gpu_jobs.py`, and set `GPU_JOBS_START_URL` and `GPU_JOBS_STATUS_URL` to the endpoints Modal prints. It uses the research runner's pinned base image and packages. Verify in a test deployment that a job cannot reach the network and sees no credentials, and that a job is stopped at 120 s, before turning on `LAB_ENABLE_GPU_JOBS`.

## Model proposals to this repository

`LAB_ENABLE_LAB_PROPOSALS` (default false) lets a model propose a change to this repository. Proposals arrive as pull requests labelled `model-proposal`, authored by the model on `observable-lab.invalid`, using `LAB_PROPOSALS_GITHUB_TOKEN`: a separate fine-grained token for this one repository with Pull requests and Contents read/write only. Create the `model-proposal` label first. The lab never merges them. Review each like an outside contribution; see [SECURITY.md](../SECURITY.md).

## Rollout verification

Before enabling a deployment, verify that anonymous requests to operator routes return 401 (or 503 when unconfigured), that the scheduler accepts only its own credential, and that authorized work reaches the intended test environment. Check provider spend limits and the actual contents of public observer responses. Build and local regression tests do not verify deployed access controls.

The Modal images in `modal/research_runner.py` and `modal/app.py` use a digest-pinned `python:3.11.18-slim-bookworm` base and exact package versions. Rebuild and smoke-test after changing any of them. The dataset download in `modal/harness/prepare.py` uses `DATASET_REVISION` and `DATASET_SHA256`; real preparation refuses to download until both are set, and a pinned revision prepares into its own cache directory.

Smoke preparation uses `/cache/smoke`; research preparation uses `/cache/research`. Synthetic smoke bins cannot become the production dataset merely by existing first. Results record the dataset label and bundled harness hash; neither field independently validates the model-reported score.
