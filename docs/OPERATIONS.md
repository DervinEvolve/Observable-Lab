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

**One epoch at a time.** Starting an epoch is a single conditional update (`epoch_in_progress` flips only if it was not already set), shared by the cron and `POST /api/epoch/run`, so the two can never run at once. Whatever way an epoch ends, the claim is released. The tick and manual run pick the newest classic experiment that is not archived, or the newest one of any kind when there is no classic one (with a single active experiment that is the same row either way; see [Research beside run 2](#research-beside-run-2)); experiments in `failing` keep running so they can recover, and the public state says `failing: stability below 0.2, epochs continue`.

**Code contributions.** Run 2 turns them on with `LAB_ENABLE_CODE_WRITES=true`. At most one per epoch: the approved mutation most worth backing with code (new capabilities first, then behaviors, then constraints; additions before changes; less if the Challenger left an open critical concern). It is written by that epoch's Executor, with the explorer and test subagents the Executor chose, merges only when the trusted CI workflows pass, and also runs in the author's Sprite when `SPRITES_TOKEN` is set. The explorers' task, searches and findings are written into the pull request description.

**Follow-up step.** With reasoning on, an epoch's five roles already use most of Vercel's 800 s function limit, and the contribution (explorer, code, test, CI, Sprite) can take as long again, so one request could not do both. The epoch now finishes with the Commentator and records what is left on its row (`epochs.followup`: the contribution's mutation, and whether an exhibit or lab proposal waits on the Reviewer's approval). The next cron tick runs that follow-up in its own request before any new epoch; with a 180-minute interval there are two idle ticks between epochs, so the cadence does not change. It takes the same claim as an epoch, checks the daily budget first, and its model calls count toward the epoch's cost. On a preview (no cron), run it by hand with `POST /api/epoch/run?step=followup`. The follow-up runs in two stages on separate ticks: stage 1 writes the code against a deadline inside its own request (the code-writing call gets up to 7 minutes; the test subagent is skipped if time is short) and opens the PR; stage 2 reads CI for that exact commit, runs the author's Sprite tests, and merges or closes, then opens any exhibit or proposal the Reviewer approved. CI runs on GitHub in between, so no request waits for it; stage 2 keeps waiting for CI that is still running for up to 3 hours. A model call that times out goes straight to the fallback instead of retrying the same model. A follow-up that ends without a PR, or dies part way and stays `running`, is not retried by itself; retry it once with `POST /api/epoch/run?step=followup&retry=<epoch>`.

**The tool menu.** The Executor may also choose a Sprite session, a GPU job on Modal, an exhibit for the room or a proposal to this repository. Each is off unless its flag and credentials are set (`LAB_ENABLE_SPRITE_SESSIONS`, `LAB_ENABLE_GPU_JOBS`, `LAB_ENABLE_EXHIBITS`, `LAB_ENABLE_LAB_PROPOSALS`, all default false), has per-epoch and per-day limits, and is described to the models only while it is on. Sprite and GPU time is estimated from measured duration and written to `model_calls` as `tool/sprite_session` or `tool/gpu_job` with `cost_source = 'estimate'`, so the daily budget counts it; a tool whose worst case would pass today's budget does not start. Details, rates and setup: [TOOLS.md](TOOLS.md) and [EXHIBITS.md](EXHIBITS.md). Public weights for GPU jobs (`LAB_ENABLE_WEIGHTS`, default false) are one more tool on this menu; how to turn them on is under [Public weights for GPU jobs](#public-weights-for-gpu-jobs).

**Timing.** Sprite sessions (at most 240 s of commands) and GPU jobs (polled for at most `LAB_GPU_JOB_POLL_MAX_MS`, default 300 s) run while the Challenger, rebuttal and Reviewer are answering; the exhibit pull request waits on AI-Agent's CI alongside the code contribution. Keep these limits in mind against the 800 s function limit: an epoch that runs out of time resumes on the next tick from its stored outputs and does not run a tool twice.

**Research record.** `GET /api/experiment/activity` (public, read-only) shows what each model did in the latest epoch: per role, the searches the model reported beside the pages OpenRouter recorded it citing; each Sprite command and its output; subagents, GPU jobs, exhibits and proposals; the pull request with its CI and Sprite results; and the real cost per model from `model_calls`. Where a model's account and the record disagree (searches reported on a step without web access, searches with no cited page, a merge without a passing CI record), the entry carries a flag. `?epoch=N` gives one epoch, `?all=true` the whole run for analysis. It is built from rows the lab already stores; nothing extra is collected.

**Commit authors.** Commits to AI-Agent and Research-Lab are authored by the model that wrote them, as `<display name> <<slug>@observable-lab.invalid>` (for example `Claude Fable 5.2 <claude-fable-5-2@observable-lab.invalid>`), and committed by `DervinEvolve <39844362+DervinEvolve@users.noreply.github.com>`. `.invalid` is reserved and can never be registered.

**Timeouts.** OpenRouter calls give up after 240 s (`OPENROUTER_TIMEOUT_MS`), the model list after 15 s, GitHub requests after 30 s, research runner requests after 60 s and Modal requests after 60 s. A research epoch polls its GPU run for at most `RESEARCH_RUN_POLL_MAX_MS` (default 400000 ms) and resumes on the next tick.

### Run 2 database changes

These are made at runtime, like the earlier table-creation helpers, and are also in `api/_lib/schema.sql` for a fresh database:

- `model_calls`: new table, the spend ledger (`api/_lib/spend.ts`). It later gained `budget_scope` (see [Research beside run 2](#research-beside-run-2)).
- `epoch_logs`: gains `experiment_id`; the old global `UNIQUE(epoch_number)` constraint (`epoch_logs_epoch_number_key`) is dropped and replaced by a unique index on `(experiment_id, epoch_number)`, so a new experiment no longer overwrites older logs. Older rows keep a NULL `experiment_id`. If your database named that constraint differently, drop it by hand.
- `epochs`: gains `prompt_tokens` and `completion_tokens`.
- `conflicts`: gains `spec_conflict_id`, the id the specification uses, so a resolved conflict updates its row.
- `tool_runs`: new table, one row per tool use the Executor chose, including refused ones (`api/_lib/tool-runs-store.ts`, [TOOLS.md](TOOLS.md#the-record)). Created at runtime; it is not in `schema.sql`, whose owner may add it.
- `live_model_keys` and `live_model_calls`: new tables for the lab model endpoint (`api/_lib/live-model-keys.ts`). They are created the first time a key is made or checked, so they do not exist while `LAB_ENABLE_LIVE_MODEL` is off. They are not in `schema.sql` either.
- `tinker_runs`, `tinker_spend_days`, `trained_chat_rate` and `trained_chat_calls`: new tables for Tinker training and the chat with trained adapters (`api/_lib/tinker-store.ts`, [Tinker training](#tinker-training)). They are created the first time one of those is used, so they do not exist while all three Tinker switches are off. They are not in `schema.sql` either.

### Starting run 2

On a test database first. `POST /api/experiment/reset?confirm=true&mode=classic` (operator) archives every experiment that is not archived, clears their epoch flags, creates the run 2 tables, and seeds a fresh classic experiment at epoch 0. `mode=research` seeds the ML research lab the same way, now or later. `POST /api/experiment` refuses while any experiment is active, whatever its status. An epoch still running on an archived experiment finishes into the archived row and cannot make it active again.

The first epoch after a reset waits one interval from the seed, like every other epoch; `POST /api/epoch/run` starts it at once.

## Research beside run 2

Until now the lab ran one experiment at a time: either a classic one (five models grow the agent spec, code goes to AI-Agent) or the ML research loop (one GPU run per epoch, results and wiki pages go to Research-Lab). I archived the research experiment at epoch 77 when I seeded run 2. With `LAB_RESEARCH_ALONGSIDE=true` the research experiment runs again beside run 2. The flag is off by default, and while it is off the tick, the budget and the public state are what they were.

**What counts as which.** An experiment is a research experiment when its stored spec has `meta.research`; every other experiment is classic. At most one of each kind is active. The database gains two nullable columns for this, both added at runtime the way the lab's other columns were: `model_calls.budget_scope` (which cap a row was spent under, see Budgets; added the first time the spend ledger is used after the deploy, flag on or off, and left empty while the flag is off) and `epochs.resumed_at` (when a request last picked an unfinished research epoch up again; added and written only while the flag is on).

**The tick.** The hourly cron (`/api/epoch/tick`) advances both in the same request, at the same time. Each has its own claim (`epoch_in_progress` on its own row), its own stale limit, its own follow-ups and its own cadence measured from its own last epoch. If one fails, is busy or is over its cap, the other still gets its turn. The answer carries the classic result at the top level, as before, and the research result under `research`; the request answers 500 if either side failed, so the failure shows in the logs. A research GPU run that is still training when the request stops waiting for it (`RESEARCH_RUN_POLL_MAX_MS`) is not a failure: the research part answers `GPU run still in progress; resumes next tick`, the request stays 200, and the next tick collects the result from the stored call id. North and the glass belong to the classic experiment only. A request that hits Vercel's 800 s limit ends both; each resumes from its stored outputs on the next tick, as it does today.

**How research starts again.** When the flag is on and no research experiment is active, the tick brings one back:

1. It reads `results.tsv` in the research repository for the last epoch number. If the file cannot be read, nothing starts and the next tick tries again.
2. It reactivates the newest archived research experiment. I chose this over seeding a new one because everything that experiment owns is keyed by its id (its epochs, its notebook, its spec with the best score so far) and its next epoch is simply `current_epoch + 1`, so setting its status back to `growing` is nearly the whole change. For the experiment that stopped at 77 the next epoch is 78, the next ledger row is 78 and the next wiki page is `epoch-078.md`.
3. An epoch that was running when the experiment was archived finishes into the archived row, and its last write (the one that advances the experiment) is skipped for an archived experiment. So before reactivating, a finished epoch above `current_epoch` is taken over: the experiment gets that epoch's spec (best score, last run, finding) and its number.
4. If `results.tsv` is still ahead after that (a row was written but the epoch never finished), `current_epoch` is raised to the ledger's last epoch, so a number is never used twice. If one of those rows was kept, its score becomes the best score to beat, because `train.py` in the repository is that epoch's; without this a worse run could be kept over it. Kept rows at or before the experiment's own epoch are left alone: they are already in its spec, or were set aside by a re-baseline.
5. Only if the database holds no research experiment at all does it seed a new one. That one starts at the ledger's last epoch and takes the best kept score from the ledger, so numbering still carries on.

The classic experiment is never read or written by any of this. A GPU call that was still open when the experiment was archived is collected if it is less than six days old (Modal keeps results for about a week); an older one is forgotten and the epoch starts a fresh run. If a request was still working on an epoch of the archived experiment within the last `EPOCH_STALE_MINUTES` (it made the epoch's row, or picked it up again and stamped `resumed_at`), the tick waits, so the same epoch is never run twice at once.

**How far the ledger is trusted.** `results.tsv` is written by the lab, but the numbers in it begin as whatever the generated `train.py` printed, so I do not let it steer the experiment freely:

- What a run reports is cleaned when it arrives and again when a stored result is read: a metric is kept only if it is a real number, and the row writer puts `-` for anything else and strips tabs and line breaks from every cell. One epoch can only ever write one row. (Before this, `train_steps` went into the row as printed, so a crafted value could have added a second row with any epoch number.)
- Only lines shaped exactly like the lab's own rows are read: 9 or 13 columns, an epoch number of at most six digits, `merged` or `reverted`, a score with four decimals or `-`, and `keep`, `discard` or `crash`.
- The ledger may be at most 2 epochs ahead of the archived experiment. In normal work it is 1 at most. If it is further ahead, nothing is reactivated; every tick logs `[Research] not starting research: results.tsv is at epoch N, more than 2 past the experiment's M` and the tick's answer carries the same reason under `research.activation`. I then have to look: either remove the bad rows from `results.tsv`, or, if the ledger is right and the database is behind, raise the archived experiment's `current_epoch` by hand.
- A kept score below the spec's `target_bpb` is not taken as the best score. `POST /api/experiment/patch-research` sets the baseline by hand if that is ever wrong.

**Budgets.** Research has its own daily cap, `LAB_RESEARCH_DAILY_BUDGET_USD` (default 40). Every ledger row already carries its experiment; it now also says which cap it was spent under. While the flag is on, everything the research experiment spends is written with `budget_scope = 'research'`: its model calls, plus an estimate of each GPU run written as `tool/research_gpu_run` with `cost_source = 'estimate'` (the runner's measured time at `LAB_MODAL_GPU_USD_PER_SECOND`, or the whole training budget plus 180 s when the time never came back). Before this flag the research loop did not record its GPU time at all, and with the flag off it still does not. Then:

- the research cap counts the rows marked `research`, and nothing else;
- `LAB_DAILY_BUDGET_USD` (default 15) counts every other row: the classic experiment, its follow-ups, tools, North, the lab model endpoint, and any row with no experiment.

The mark stays on the row. So if I turn the flag off in the middle of a day, what research spent under its own cap is not moved onto run 2's $15, and run 2 does not pause for money it never spent. A database where the flag was never on has no marked rows, so its one cap counts every row exactly as before. Old rows need no backfill. Over its cap, an experiment waits until the next UTC midnight and the other is not affected. Research then shows `"run_state": "paused: research daily budget reached"` with `resumes_at`, the tick logs `[CRON research] Skipping epoch N: research daily budget reached (...)`, and `POST /api/epoch/run?mode=research` answers 429.

**Public state.** `GET /api/experiment` is the classic experiment, unchanged. While the flag is on and a research experiment is active it gains one field, `research`: the research experiment's id, epoch, run state, whether a GPU run is open, and its baseline, best and target scores with the last run. `GET /api/experiment?mode=research` is the research experiment's full state in the same shape (spec, plant, last five epochs, run state), without the parts only the specimen has. Neither carries budget or spend totals. The `research` field has no dollar amounts at all; the full research state lists each recent epoch's `cost_usd` (the GPU estimate included), the same way the classic state always has. The knowledge graph, the activity record, the code contributions, the transcripts and the operator routes all mean the classic experiment, even if the research row is the newer one, so the classic graph and memory never pick up research rows; the research loop does not read the graph.

**In the room.** The room is run 2's. While a research GPU run is open the training rack works (lamps and fan), but no pulses travel from the rack to the terrarium, because that run is not training the plant in the room; and the gauge shows the research experiment's best score under the label `SEPARATE RESEARCH`. Pulses still flow for a GPU job the run 2 models start themselves, and when the experiment in the room is itself a research experiment.

**By hand.** `POST /api/epoch/run?mode=research` (operator) runs the next research epoch now, and answers 400 while the flag is off and 202 when the GPU run is still training at the end of the wait; without `mode` it is the classic experiment. `POST /api/experiment/patch-research` re-baselines the research experiment. `POST /api/experiment/reset` still archives every experiment, research included, and seeds a new classic one at epoch 0: it ends run 2. With the flag on, the next tick reactivates the research experiment and carries on. `reset?mode=research` is refused with 409 while the flag is on: it would end run 2 and start research again at epoch 0, on top of the rows and pages already in the research repository. `POST /api/experiment` (seed a classic experiment) is refused only by another active classic experiment while the flag is on.

**Turning it off.** Set the flag to anything but `true` and redeploy. The research experiment stays active but nothing advances it, and its state reads `paused: research alongside is off`. Run 2 goes on under `LAB_DAILY_BUDGET_USD`, which keeps counting only the rows that were not spent under the research cap. To archive the research experiment as well, call `POST /api/experiment/patch-research?confirm=true&archive=true` (operator, no body) after the flag is off. It archives the research experiment only and leaves run 2 alone; it answers 409 while the flag is on, because the next tick would bring the experiment straight back. Do not use the reset for this: the reset ends run 2 too. Turning the flag on again later brings the same research experiment back at its next epoch.

**To turn it on.** The research runner on Modal and its Vercel variables are already what the research loop needs (`RESEARCH_RUNNER_START_URL`, `RESEARCH_RUNNER_STATUS_URL`, `RESEARCH_RUNNER_TOKEN`, `RESEARCH_GITHUB_TOKEN`, `RESEARCH_GITHUB_OWNER`); this change does not touch `modal/research_runner.py`, so no Modal deploy is needed for it. In Vercel set `LAB_RESEARCH_ALONGSIDE=true` and, if 40 is not what I want, `LAB_RESEARCH_DAILY_BUDGET_USD`, then redeploy. The next tick logs `[Research] reactivated experiment <id>; next epoch 78` and starts epoch 78 in the same request. Check `GET /api/experiment?mode=research` and that `GET /api/experiment` still shows run 2.

## Vercel route authorization

- Set `LAB_OPERATOR_SECRET` to a random server-side value of at least 32 characters. Operator clients send it as `Authorization: Bearer <value>`.
- Set a different random `CRON_SECRET`, also at least 32 characters. `/api/epoch/tick` accepts this credential only. [Vercel Cron sends the configured secret in the Authorization header](https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- Missing or short configuration returns 503. Missing or incorrect authorization returns 401 before database, model, Sprites, or compute work.
- The guard covers manual epochs, clearing stuck epochs, seeding/resetting/patching experiments, the persisted glass state, debug views, North runs, and all Sprites routes. `?confirm=true` remains an extra action check; it is not authentication.
- Ordinary experiment state (now including recent `tool_runs`, cleaned of anything that looks like a credential), merged exhibits (`GET /api/experiment?view=exhibits`), contribution records, and wildcard transcripts remain public observer endpoints. Review their contents before using private research or code in a connected deployment. Only put material intended for viewers in that experiment.

- `/api/experiment/trained-chat` is public by design: it is the visitor chat with adapters the models trained ([Tinker training](#tinker-training)). While `LAB_ENABLE_TRAINED_CHAT` is off, which is the default, a GET says `{"enabled":false,"adapters":[]}` and a POST answers 503, and neither touches the database or the network. When it is on it is the one public route that spends money, so it has a rate limit per address, a tighter one per visitor (an address with a browser string), and its own small daily cap. The room's page calls it only after `GET /api/experiment` has said the chat is on, so with the chat off it gets no traffic from visitors' pages.

- `/api/live-model/v1/chat/completions` (and `/api/live-model/v1/models`, which `vercel.json` rewrites to it) is neither a public route nor an operator route. It takes a scoped key that the lab makes for one Sprite session. While `LAB_ENABLE_LIVE_MODEL` is off it answers 503 to everyone. When it is on it answers 401 to anything that is not a live scoped key, and that includes the operator secret.

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

**Deploy with the pinned Modal.** Modal runs the deploying computer's Modal library inside every container, so deploy with the version in `requirements-runner.txt` (1.6.3, which needs Python 3.10 or newer). On a Mac whose Python is 3.9, an older Modal gets used without warning and the weights mount fails (`'Volume' object has no attribute 'with_mount_options'`). With [uv](https://docs.astral.sh/uv/) installed, deploy any of the apps like this, from the repository folder:

```bash
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/gpu_jobs.py
```

For `modal/gpu_jobs.py` (the GPU job tool), create the Modal secret `oblab-gpu-jobs-auth` containing `JOBS_TOKEN` (at least 32 characters), put the same value in Vercel's `GPU_JOBS_TOKEN`, deploy with `modal deploy modal/gpu_jobs.py`, and set `GPU_JOBS_START_URL` and `GPU_JOBS_STATUS_URL` to the endpoints Modal prints. It uses the research runner's pinned base image and packages. Verify in a test deployment that a job cannot reach the network and sees no credentials, and that a job is stopped at 120 s, before turning on `LAB_ENABLE_GPU_JOBS`. The same file holds the fetcher for public weights; see [Public weights for GPU jobs](#public-weights-for-gpu-jobs).

## Public weights for GPU jobs

`LAB_ENABLE_WEIGHTS` (default false) lets the Executor ask for one public Hugging Face model repository per epoch. My own fetcher on Modal checks it and downloads it; a GPU job that names it reads it read-only at `/weights`, with the network still blocked. What it checks and why is in [TOOLS.md](TOOLS.md#public-weights). With the flag off nothing changes: no prompt text, no request to Modal, and a GPU job is sent exactly as before.

The fetcher is part of `modal/gpu_jobs.py`, so it uses the GPU jobs endpoints and token that are already set (`GPU_JOBS_START_URL`, `GPU_JOBS_STATUS_URL`, `GPU_JOBS_TOKEN`). There is no new URL, token or Modal secret, and no Hugging Face token anywhere. `modal/research_runner.py` is not changed and does not need a deploy.

**1. Deploy the Modal app from my Mac.** The version deployed on 18 November has no fetcher, so this step comes first. From this repository:

```
python -m pip install -r requirements-runner.txt
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/gpu_jobs.py
```

The first deploy creates the Volume `oblab-weights` (the shelf) and the Dict `oblab-weights-use` (when each entry was last used). The two endpoint URLs stay the same, because the app and function names have not changed. If Modal prints different ones, put them in Vercel.

**2. Check it by hand before any model can use it.** These calls go straight to the Modal endpoints. The token is read into a shell variable without being shown or saved in the shell history.

```
read -s JOBS_TOKEN
START=https://dervinevolve--oblab-gpu-jobs-start.us-east.modal.run
STATUS=https://dervinevolve--oblab-gpu-jobs-status.us-east.modal.run

# a) Fetch a small public model (about 18 MB, apache-2.0, safetensors).
curl -sS -X POST "$START" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fetch_weights":{"repo":"google/bert_uncased_L-2_H-128_A-2"}}'
# prints {"call_id":"fc-..."}; poll it until status is "done". Every call below prints its own
# call_id, and each is polled the same way with that id:
curl -sS "$STATUS?call_id=fc-..." -H "Authorization: Bearer $JOBS_TOKEN"

# b) A gated repository must be refused.
curl -sS -X POST "$START" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fetch_weights":{"repo":"meta-llama/Llama-2-7b-hf"}}'
curl -sS "$STATUS?call_id=fc-..." -H "Authorization: Bearer $JOBS_TOKEN"

# c) A job that names the weights: it must see them, fail to write, and have no network.
curl -sS -X POST "$START" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"weights":{"repo":"google/bert_uncased_L-2_H-128_A-2"},"script":"import os, urllib.request\nprint(sorted(os.listdir(\"/weights\")))\ntry:\n    open(\"/weights/x\", \"w\")\n    print(\"WRITABLE\")\nexcept OSError as e:\n    print(\"read-only:\", e)\ntry:\n    urllib.request.urlopen(\"https://huggingface.co\", timeout=5)\n    print(\"NETWORK OPEN\")\nexcept Exception as e:\n    print(\"network blocked:\", type(e).__name__)\n"}'
curl -sS "$STATUS?call_id=fc-..." -H "Authorization: Bearer $JOBS_TOKEN"

# d) The same script without "weights": there must be no /weights at all.
#    This is the path every GPU job takes today, so it also shows the redeploy left plain jobs working.
curl -sS -X POST "$START" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"script":"import os, urllib.request\nprint(sorted(os.listdir(\"/weights\")))\ntry:\n    open(\"/weights/x\", \"w\")\n    print(\"WRITABLE\")\nexcept OSError as e:\n    print(\"read-only:\", e)\ntry:\n    urllib.request.urlopen(\"https://huggingface.co\", timeout=5)\n    print(\"NETWORK OPEN\")\nexcept Exception as e:\n    print(\"network blocked:\", type(e).__name__)\n"}'
curl -sS "$STATUS?call_id=fc-..." -H "Authorization: Bearer $JOBS_TOKEN"

# e) My limits reach the fetcher: with a 0.01 GB limit the same small model is refused for its size.
curl -sS -X POST "$START" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fetch_weights":{"repo":"google/bert_uncased_L-2_H-128_A-2","limits":{"max_gb":0.01}}}'
curl -sS "$STATUS?call_id=fc-..." -H "Authorization: Bearer $JOBS_TOKEN"

unset JOBS_TOKEN
modal volume ls oblab-weights google/bert_uncased_L-2_H-128_A-2
```

What I expect: (a) ends with `"status":"ok","cached":false` and a 40 character `sha`, and asking again gives `"cached":true`; (b) ends with `"status":"refused","rule":"gated"`; (c) prints `['_lab_manifest.json', 'config.json', 'model.safetensors', 'vocab.txt']`, a `read-only:` line and a `network blocked:` line, and its result has `"weights":{"repo":"google/bert_uncased_L-2_H-128_A-2",...}`; (d) ends with `"status":"error","stage":"run"`, a `FileNotFoundError` for `/weights` in its `log_tail`, and `"weights":null`; (e) ends with `"status":"refused","rule":"size"`, which shows a limit sent with a request is the one the fetcher applies. If (c) prints `WRITABLE` or `NETWORK OPEN`, or the job in (c) fails at stage `sandbox` or `mount`, or (d) ends at any stage but `run`, leave the flag off. If (d) is the one that fails, plain GPU jobs are broken too: deploy `modal/gpu_jobs.py` from the commit before this feature again.

I ran the fetcher's rules and its download and hash checks against the live Hugging Face API from a development machine, and that model passed while a gated one, one with custom code and one with only pickle weights were refused. I have not run any of this on Modal: the fetch function itself, the Volume, and above all the read-only mount of one shelf entry into a sandbox (`with_mount_options(read_only=True, sub_path=...)`, which the Modal SDK 1.6.3 has) are untested there. Step 2 is that test.

**3. Turn it on in Vercel.** Set `LAB_ENABLE_WEIGHTS=true` for Production and redeploy. `LAB_ENABLE_GPU_JOBS` must be `true` as well, which it is. The other settings are optional:

| Variable | Default | What it does |
|---|---|---|
| `LAB_ENABLE_WEIGHTS` | false | The switch. Only the exact value `true` turns it on. |
| `LAB_WEIGHTS_PER_DAY` | 2 | Requests per UTC day, 0 to 20. A shelf hit and a refusal count; a skipped request does not. |
| `LAB_WEIGHTS_LICENSES` | apache-2.0, mit, bsd-3-clause, bsd-2-clause, cc-by-4.0 | Comma separated license ids as Hugging Face writes them (lower case, like `apache-2.0`). The defaults apply only when it is not set. An entry that is not an id is left out, and if none is left the tool is off; it never falls back to the defaults. |
| `LAB_WEIGHTS_MAX_GB` | 3 | Largest download, in GB of 10^9 bytes. The Modal side never allows more than 20. |
| `LAB_WEIGHTS_SHELF_GB` | 30 | Size of the shelf before the least recently used entries are removed. Never more than 500. |
| `LAB_WEIGHTS_POLL_MAX_MS` | 180000 | How long an epoch waits for a fetch, at most 300000. |

These limits are read by the server and sent to the fetcher with each request, so changing one needs a Vercel redeploy and no Modal deploy. The next epoch's prompts show the new numbers.

**A license list I wrote wrongly.** If `LAB_WEIGHTS_LICENSES` is set and nothing in it is a license id (for example `mit;apache-2.0` or `Apache 2.0`), public weights stay off, the models are told nothing about them, and the function log says `LAB_WEIGHTS_LICENSES is set but names no license id`. If only some entries are wrong, the list is the good ones and the log says how many were left out. The Modal side does the same with the list it is sent: a list that was sent is never widened.

**Timing.** Only a GPU job that names the repository asked for in the same answer waits for that fetch. Any other job starts at once, beside the fetch, as GPU jobs always have. A job that does wait shares its own wait with the fetch: together they get `LAB_GPU_JOB_POLL_MAX_MS` (default 300 s), not that plus the fetch's wait. If the fetch leaves less than 150 s of it (or less than half of it, when I have set it under 300 s), the job is not started, it is stored as skipped with the reason, and the weights are on the shelf for a later epoch. So this tool does not make the side tools hold an epoch longer than a GPU job alone already could.

What that does not fix, because it was already so before this tool: a GPU job's row and its spend are written when its result comes back. If Vercel stops the function at 800 s while a job is still running, Modal bills that job, nothing is written to `model_calls`, and the resumed epoch starts the job again. The default 300 s wait leaves room for the roles; raising `LAB_GPU_JOB_POLL_MAX_MS` towards its 600 s ceiling makes this possible.

**Spend.** A fetch is written to `model_calls` as `tool/weights`, an estimate from its measured time at `LAB_MODAL_GPU_USD_PER_SECOND` (about ten times Modal's CPU price, so it errs high), and counts against `LAB_DAILY_BUDGET_USD`. Its worst case, 960 s or about $0.29, is checked against the budget before it starts. Volume storage is billed by Modal and is not in the ledger. Modal's pricing page listed Volumes at $0.09 per GiB per month with 1 TiB per month free when I read it on 18 November 2026; I have not checked what my account is actually billed.

**Weights in use are not evicted.** An entry that was fetched, asked for or named by a job in the last 300 s is not removed to make room, because a job may be about to mount it. A fetch that could only fit by removing one is refused with rule `shelf`. As a second check, a job's controller reads the manifest inside the sandbox before the script is put there; if it is not the commit it found on the shelf, the script is not run and the result is stage `mount` with no weights named (the sandbox's seconds are charged).

**The shelf by hand.** `modal volume ls oblab-weights` lists it. `modal volume rm -r oblab-weights <org>/<name>` removes one repository, and `modal volume delete oblab-weights` removes everything (the next deploy creates an empty one). Narrowing `LAB_WEIGHTS_LICENSES` does not delete what is already there, but a job that names weights whose license is no longer on the list is not started.

**Turning it off.** Set `LAB_ENABLE_WEIGHTS` to anything but `true` and redeploy Vercel. The models are no longer told about it, requests for weights are ignored, and GPU jobs get no volume and no label. The shelf stays where it is until I delete it.

## The lab model endpoint

`LAB_ENABLE_LIVE_MODEL` (default false) lets code that a model runs in its own Sprite session make a real model call. I am the host: the lab serves an OpenAI-compatible endpoint at `<origin>/api/live-model/v1`, and it forwards the call to OpenRouter with my key. The models never see that key. What they get is a scoped key that the lab makes for one Sprite session and takes away when the session ends. [TOOLS.md](TOOLS.md#the-lab-model-endpoint) has the details of what a key can do and what a request may contain.

To turn it on I set these in Vercel and redeploy:

| Variable | Value |
|---|---|
| `LAB_ENABLE_LIVE_MODEL` | `true` |
| `LAB_PUBLIC_ORIGIN` | the lab's public address, `https://<host>` with no path. I can leave it empty and the lab uses the production domain Vercel reports in `VERCEL_PROJECT_PRODUCTION_URL`. |
| `LAB_LIVE_MODEL_IDS` | optional. The models it answers for, comma separated. Default `google/gemini-3.8-flash`. An id with a `:` suffix or under `openrouter/` (such as `openrouter/auto`) is left out, because those let OpenRouter choose what is called. |
| `LAB_LIVE_MODEL_DAILY_USD` | optional. What the endpoint may spend per UTC day. Default `1`. |

It also needs what is already set for run 2: `OPENROUTER_API_KEY`, `LAB_ENABLE_SPRITE_SESSIONS=true` and `SPRITES_TOKEN`. Nothing changes on Modal, and there is nothing to deploy there.

To turn it off I set `LAB_ENABLE_LIVE_MODEL` to anything but `true`. The route goes back to 503, no key is made, and the prompts stop mentioning it. Keys that were already issued stop working too, because the route is closed before a key is even looked at.

What I check after turning it on:

- `curl -i https://<host>/api/live-model/v1/models` with no key answers 401, not 404 and not 503. A 404 means the rewrite in `vercel.json` did not deploy. A 503 means a setting is missing, and the message says whether it is the switch or the configuration.
- The same request with `Authorization: Bearer <LAB_OPERATOR_SECRET>` also answers 401. The operator secret is not a key for this route.
- After the next epoch with a Sprite session, the `tool_runs` row for that session has `detail.live_model`. `offered: true` means the Sprite accepted the extra egress rule and got a key. `offered: false` comes with a note that says why, and the session's stored output ends with the same note.
- If the first session says `offered: false`, I turn the switch off again until I have fixed the cause. While the switch is on the prompts tell the models the endpoint exists. Each session's output does tell them when it got no key, but a setup where no session can get one is just noise for them.
- `SELECT purpose, SUM(cost_usd) FROM model_calls WHERE purpose = 'live_model' GROUP BY 1` shows what the endpoint has cost, and `live_model_calls` has one row per call.

Things I know are not checked from my machine: I have not watched a real Sprite accept the extra egress rule or call the endpoint. The rule format comes from the Sprites networking documentation, and the shape of the answer the code reads back comes from the Sprites API reference. The code refuses to make a key unless the Sprite's answer shows the rule in place, so the worst case is a session without a key, not a key without a rule. I have also not run a tool loop of more than one round against the real model through the endpoint.

Two things to keep in mind while it is on:

- I do not run `create`, `create_all` or `setup` on `/api/sprites` while an epoch's Sprite session is running. Setting a Sprite up again puts its egress policy back to `defaults`, which takes the lab's host away from the running session. Its remaining calls then fail, and the record still says `offered: true`.
- The egress rule works through DNS, and the lab's host resolves to addresses Vercel shares between many sites. While a session has the rule, code in the Sprite may be able to reach another Vercel site through those addresses. I have not tested that, and a custom domain would not change it. [TOOLS.md](TOOLS.md#the-lab-model-endpoint) has the detail.

## Tinker training

`LAB_ENABLE_TINKER` (default false) lets the Executor ask for one LoRA fine-tuning run on [Tinker](https://tinker-docs.thinkingmachines.ai/) on data it writes into its answer; the Reviewer approves it and my own runner on Modal does it. `LAB_ENABLE_LIVE_TRAINED` and `LAB_ENABLE_TRAINED_CHAT` (both default false) let a trained adapter be talked to, by the models through the lab model endpoint and by visitors in the room. What each does, checks and records is in [TOOLS.md](TOOLS.md#tinker-training). With all three off nothing changes: the prompts, the routes and the tick behave as before, and nothing calls Modal or Tinker. The one exception is deliberate: after I switch the training tool off, the tick still collects runs that were already started for as long as the runner's address and token are set (see "Turning it off" below). On a server that never had those set, the tick makes no query and no request for any of this.

I approved Tinker fine-tuning with chat at $2 a run and $10 a UTC day. Those are the defaults.

**Where the Tinker key lives.** In exactly two places, under exactly these names:

1. The Modal secret `oblab-tinker-auth`, key `TINKER_API_KEY`. Only the training function in `modal/tinker_jobs.py` is given it.
2. The Vercel environment variable `TINKER_API_KEY`, marked Sensitive, Production only. One file reads it, `api/_lib/tinker-chat.ts`, to call Tinker's OpenAI-compatible endpoint for the lab model endpoint and the visitor chat.

Tinker has no scoped keys and no per-key spending limit, and its terms do not allow handing a key on. So the key is never sent to a Sprite, a GPU job, a prompt, a response, a log or a record, and the guard that stops server credentials leaving (`assertNoSecrets`) treats it as one. The caps below are the lab's own, held in the database.

**1. Tinker.** Create the account and organisation at tinker-console.thinkingmachines.ai, add a prepaid balance (requests are refused until the organisation has one; $10 covers many runs at these sizes), and create an API key. I keep the balance small: it is the one limit Tinker itself enforces.

**2. Modal secrets.** From my Mac. `read -s` keeps the values out of the shell history.

```
read -s TINKER_API_KEY
modal secret create oblab-tinker-auth TINKER_API_KEY="$TINKER_API_KEY"
JOBS_TOKEN=$(openssl rand -hex 32)
modal secret create oblab-tinker-jobs-auth JOBS_TOKEN="$JOBS_TOKEN"
echo "$JOBS_TOKEN"   # this one goes in Vercel as TINKER_JOBS_TOKEN
unset TINKER_API_KEY
```

`JOBS_TOKEN` is not the Tinker key. It only lets the lab server reach the runner's two endpoints, which do not have the Tinker secret at all.

**3. Deploy the runner.** From this repository:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/tinker_jobs.py
```

This creates the app `oblab-tinker` with three functions: `train` (the run), and the `start` and `status` endpoints. Modal prints the two endpoint URLs; they go in Vercel as `TINKER_JOBS_START_URL` and `TINKER_JOBS_STATUS_URL`. The first deploy builds the training image (the Tinker SDK 0.39.1, its cookbook 0.6.1 and CPU torch), which takes a few minutes.

The `start` endpoint also keeps a small Modal Dict, `oblab-tinker-runs`, of which call it started under each run's name. It creates the Dict itself the first time it is used; there is nothing to set up. The lab server uses it to find a run whose start answer never arrived. If the Dict cannot be read or written, runs start all the same.

**4. Smoke test, before any model can use it.** This calls the deployed `train` function directly with my Modal login on 20 made-up examples. On a development machine the same job counted about 1,400 tokens, a tenth of a cent at the published prices; its budget is 5 cents and the runner cannot pass it. The adapter it saves expires after an hour.

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py
```

What I expect: `"status": "ok"`, `n_train` 18 and `n_holdout` 2, `steps_done` 6, a `holdout_loss_after` well below `holdout_loss_before`, a `sampler_path` that starts with `tinker://` and contains `/sampler_weights/`, and two samples. If it says `"status": "error"` with `"stage": "client"`, the Modal secret or the Tinker balance is the first thing to check. The result never contains the key.

Then the chat path, against the adapter the smoke test just saved (its path is the last line it prints):

```
read -s TINKER_API_KEY
ADAPTER='tinker://...the sampler_path printed above...'
curl -sS https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions \
  -H "Authorization: Bearer $TINKER_API_KEY" -H "Content-Type: application/json" \
  -d "{\"model\": \"$ADAPTER\", \"messages\": [{\"role\": \"user\", \"content\": \"What is the lab code for the colour teal?\"}], \"max_completion_tokens\": 40, \"reasoning_effort\": false}"
unset TINKER_API_KEY
```

What I expect: a `chat.completion` whose `choices[0].message.content` is a short direct answer (the trained code for teal is OL-184, if teal was not one of the two held-out examples the adapter should know it), no `reasoning_content` to speak of, and a `usage` with `prompt_tokens` and `completion_tokens`. This is the call the server makes for both chat switches, so if it fails here they stay off.

Last, the endpoints. These are shell variables on my Mac for this check only; the same three values go into Vercel in step 5. The two URLs are the ones Modal printed in step 3, and the token is the one from step 2.

```
TINKER_JOBS_START_URL='https://...the start URL Modal printed...'
TINKER_JOBS_STATUS_URL='https://...the status URL Modal printed...'
read -s JOBS_TOKEN
# start: no token, then a token with a body that is not a job
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$TINKER_JOBS_START_URL" -H 'Content-Type: application/json' -d '{}'                                      # 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$TINKER_JOBS_START_URL" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' -d '{}'  # 400
# status: no token, then a call that does not exist, then a run name that was never started
curl -sS -o /dev/null -w '%{http_code}\n' "$TINKER_JOBS_STATUS_URL?call_id=fc-none"                                                                           # 401
curl -sS -H "Authorization: Bearer $JOBS_TOKEN" "$TINKER_JOBS_STATUS_URL?call_id=fc-none"; echo        # {"status":"failed","call_id":"fc-none","error":"..."}
curl -sS -H "Authorization: Bearer $JOBS_TOKEN" "$TINKER_JOBS_STATUS_URL?run_id=e0-00000000"; echo     # {"status":"unknown","error":"no call is known for that run"}
```

If a curl prints `000` or says the URL has no host, the variable above it is empty. Those five calls start nothing and cost nothing.

Then one real run through the endpoints, the way the lab server does it. This starts a second run of the same 20 examples, so it costs about a tenth of a cent again:

```
TINKER_JOBS_START_URL="$TINKER_JOBS_START_URL" TINKER_JOBS_STATUS_URL="$TINKER_JOBS_STATUS_URL" JOBS_TOKEN="$JOBS_TOKEN" \
  uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py endpoints
unset JOBS_TOKEN
```

It starts a run under a made-up name, sends the same start a second time, asks for the run by its name, and waits for the result. What I expect: six lines that start with `ok`, the result as in the first smoke test, and `endpoints: all as expected`. A `FAIL` on "the same start sent again gives the same call" or on "the run is found by its name" means the Modal Dict is not working. Training still works without it, but a start whose answer is lost is then charged the whole amount set aside, so I would rather know. The token is sent in a header and is never printed.

**5. Vercel.** Set these for Production and redeploy:

| Variable | Default | What it does |
|---|---|---|
| `LAB_ENABLE_TINKER` | false | The training tool. Only the exact value `true` turns it on, and only with the three settings below. |
| `TINKER_JOBS_START_URL`, `TINKER_JOBS_STATUS_URL` | none | The two URLs Modal printed in step 3. https only. |
| `TINKER_JOBS_TOKEN` | none | The `JOBS_TOKEN` from step 2. Sensitive. |
| `LAB_TINKER_BASE_MODELS` | `Qwen/Qwen3.5-4B` | Comma separated, from `Qwen/Qwen3.5-4B`, `Qwen/Qwen3.5-9B`, `Qwen/Qwen3.6-35B-A3B`. Anything else is left out; a list with nothing usable turns the tool off. |
| `LAB_TINKER_RUN_USD` | 2 | The most one run may cost, by the estimate. Never more than 5. |
| `LAB_TINKER_DAILY_USD` | 10 | The most all Tinker use may cost per UTC day, by the estimate: runs, adapter calls through the lab model endpoint, and visitor chat. Never more than 50. |
| `LAB_TINKER_PER_DAY` | 2 | Runs per UTC day, 0 to 10. |
| `LAB_TINKER_TTL_DAYS` | 14 | How long an adapter is kept, 1 to 30 days. |
| `LAB_TINKER_POLL_MAX_MS` | 300000 | How long the follow-up waits for a run, at most 480000. A run still going is collected by a later tick. |
| `TINKER_API_KEY` | none | The Tinker key, Sensitive, Production. Needed only for the next two switches. |
| `LAB_ENABLE_LIVE_TRAINED` | false | Kept adapters answer on the lab model endpoint as `lab/<name>`. Needs `LAB_ENABLE_LIVE_MODEL=true` and `TINKER_API_KEY`. |
| `LAB_ENABLE_TRAINED_CHAT` | false | The visitor chat in the room. Needs `TINKER_API_KEY`. |
| `LAB_TINKER_CHAT_DAILY_USD` | 1 | The most all visitor chat may cost per UTC day, by the estimate, inside the $10. Never more than 10. |

I turn them on one at a time: `LAB_ENABLE_TINKER` first, and the two chat switches only after a model's run has left a kept adapter and I have read its samples.

**Vercel functions.** The visitor chat is one new function, `api/experiment/trained-chat.ts` (the project now has 19; `vercel.json` gives it 60 s). With the chat off nothing calls it: the room's page learns from `GET /api/experiment`, which it reads anyway, whether the chat is on, and only then calls the chat route. Adapters on the lab model endpoint use the existing function and its `/models` rewrite. The tick collects finished runs inside the existing cron function, once per tick, before it advances any experiment.

**What I check after turning the tool on.**

- `GET /api/experiment` lists `tinker_train` in `tools_enabled`.
- After the first approved request, the `tool_runs` row with tool `tinker_train` has the dataset hash, both held-out losses under `detail.measured`, the estimated cost under `detail.cost`, and the adapter's name. A request that was refused is a `skipped` row with the reason.
- `SELECT status, slug, base_model, reserved_usd, cost_usd, expires_at FROM tinker_runs ORDER BY created_at DESC` shows every run, and `SELECT * FROM tinker_spend_days ORDER BY day DESC` shows what was set aside and spent per day. `reserved_usd` goes back to 0 once a run is collected. A row that stays `reserved` or `running` for more than about an hour means the tick is not collecting.
- `modal dict items oblab-tinker-runs` lists each run's name (its `slug`) with the call Modal started for it.
- With the visitor chat on, `curl -s https://<host>/api/experiment/trained-chat` says `"enabled": true` and lists the kept adapters, and `GET /api/experiment` carries `"trained_chat_enabled": true`. With it off the first call says `{"enabled":false,"adapters":[]}`, the state has no such field, and a visitor's page never calls the chat route.

**The estimate against the bill.** The ledger's Tinker rows are my estimate. The bill is Tinker's: `tinker billing usage <start> <end>` (two UTC hour timestamps), or the console, some hours later. I compare the two after the first few runs. If the bill is higher than the ledger, the price table in `api/_lib/tinker.ts` is out of date (Tinker's current one is at tinker-docs.thinkingmachines.ai/tinker/models.json) and needs the new numbers; the runner is sent the prices with every request, so that is a Vercel redeploy and no Modal deploy.

**Things I know are not checked from the development machine.** It cannot reach Modal or Tinker, so nothing has run there. What was checked: the runner file compiles and imports on Python 3.9; its whole flow ran locally against the real Tinker cookbook 0.6.1 and the real Qwen3.5 tokenizer, with only the training service replaced by a stand-in; and the SDK calls it makes match the signatures of the installed `tinker` 0.39.1. What steps 3 and 4 are the first real test of: the image build, the Modal secret reaching the function, a real training client, the loss values Tinker returns, the save with a time to live, and sampling. The second smoke test in step 4 is the first real test of the two HTTP endpoints starting a run on Modal, and of the Modal Dict that remembers which call was started under a run's name. The chat call in step 4 is the first real test that Tinker's OpenAI-compatible endpoint serves a LoRA checkpoint by its path and takes `"reasoning_effort": false` for these base models; its documentation says both, and says the endpoint is in beta.

**Turning it off.** Set `LAB_ENABLE_TINKER` to anything but `true` and redeploy: the models are no longer told about it and requests are ignored, so nothing new starts. I leave `TINKER_JOBS_START_URL`, `TINKER_JOBS_STATUS_URL` and `TINKER_JOBS_TOKEN` in place for at least an hour after that. A run already training carries on at Modal, and while those three are set the tick keeps collecting it: it only asks the runner about runs that were already started and closes their rows, so the run's record is written, its estimated cost reaches `model_calls` and the daily budget, and a finished adapter is recorded. This also covers a run whose experiment has been archived or replaced in the meantime. `SELECT count(*) FROM tinker_runs WHERE status IN ('reserved', 'running')` says when nothing is open any more; after that the three values can go too. If I remove them while a run is open and the switch is off, that run stays open and its cost is in Tinker's billing only, so I do not do that. (With the switch still on and the runner's address gone, an open run is closed after about an hour at the whole amount set aside.)

`LAB_ENABLE_TRAINED_CHAT` and `LAB_ENABLE_LIVE_TRAINED` turn off the same way: the panel's button disappears and pages stop calling the chat route, the chat route answers 503, and the lab model endpoint refuses `lab/` models like any unknown model. To stop everything at once, delete `TINKER_API_KEY` in Vercel and the `oblab-tinker-auth` secret in Modal, or revoke the key in the Tinker console. `modal app stop oblab-tinker` takes the runner down. Adapters expire by themselves; `tinker checkpoint list` and `tinker checkpoint delete` (or the console) remove them sooner.

## Model proposals to this repository

`LAB_ENABLE_LAB_PROPOSALS` (default false) lets a model propose a change to this repository. Proposals arrive as pull requests labelled `model-proposal`, authored by the model on `observable-lab.invalid`, using `LAB_PROPOSALS_GITHUB_TOKEN`: a separate fine-grained token for this one repository with Pull requests and Contents read/write only. Create the `model-proposal` label first. The lab never merges them. Review each like an outside contribution; see [SECURITY.md](../SECURITY.md).

## Rollout verification

Before enabling a deployment, verify that anonymous requests to operator routes return 401 (or 503 when unconfigured), that the scheduler accepts only its own credential, and that authorized work reaches the intended test environment. Check provider spend limits and the actual contents of public observer responses. Build and local regression tests do not verify deployed access controls.

The Modal images in `modal/research_runner.py` and `modal/app.py` use a digest-pinned `python:3.11.18-slim-bookworm` base and exact package versions. Rebuild and smoke-test after changing any of them. The dataset download in `modal/harness/prepare.py` uses `DATASET_REVISION` and `DATASET_SHA256`; real preparation refuses to download until both are set, and a pinned revision prepares into its own cache directory.

Smoke preparation uses `/cache/smoke`; research preparation uses `/cache/research`. Synthetic smoke bins cannot become the production dataset merely by existing first. Results record the dataset label and bundled harness hash; neither field independently validates the model-reported score.
