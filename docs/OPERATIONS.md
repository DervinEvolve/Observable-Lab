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

- `/api/experiment/trained-adapters` is an operator route: `Authorization: Bearer <LAB_OPERATOR_SECRET>` on every call, 401 before anything is read otherwise, and `?confirm=true` on a POST as well. It is where I look at the trained adapters and keep or unkeep one, or take a display name away ([Naming and keeping trained adapters](#naming-and-keeping-trained-adapters)). Nothing a model writes reaches it.

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

The research controller runs only the reviewed preparation harness. It uses a new `oblab-research-data-v2` Volume so previously writable caches are not reused. Each experiment runs in a fresh Modal Sandbox with no secrets, network blocked, a read-only data Volume, CPU/memory limits, and a hard lifetime. `train.py` is stopped at the training budget plus `TRAIN_GRACE_S` (120 s, a constant in `modal/research_runner.py`; change it there and redeploy); a stopped run, or one that reports more training time than the budget, returns a crash at stage `budget` instead of a score. Sandboxes are terminated on success and failure. Generated training code can change its own disposable harness copy and report arbitrary metrics; those scores are explicitly marked `experiment_stdout_unverified`, and that label, the dataset label, the harness SHA-256 and the measured training wall time are written into `results.tsv` (four extra columns, added to an older header automatically), the finding page and commit trailers. A run made with the runner's save step (only while `LAB_ENABLE_RESEARCH_TALK` is on, see [Stories from the research model](#stories-from-the-research-model)) is also marked `runner_flow` `keep-1` in all three; the hard stop and the crash at stage `budget` are the same for it. Independent checkpoint evaluation is not implemented and remains necessary before a score is treated as measured. Autonomous experiment execution and research commits remain enabled by their existing configuration.

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

## Public datasets

`LAB_ENABLE_DATASETS` (default false) lets the Executor ask for one public Hugging Face dataset repository per epoch. My own fetcher on Modal checks it and downloads its data files onto a shelf. A GPU job that names it reads it read-only at `/datasets` with the network still blocked, and a Tinker training request may take its examples from two columns of one of its files instead of writing them inline. What is checked, and why, is in [TOOLS.md](TOOLS.md#public-datasets). With the flag off nothing changes: no prompt text, no request to Modal, a GPU job and a training run are sent exactly as before, `"datasets"` in an answer is an unknown tool and `"dataset"` in a training request is an unknown field.

It needs GPU jobs or Tinker training switched on, since those are the two things that can read a dataset. With neither on, the tool stays off and says so in the log. There is no Hugging Face token anywhere, and the Tinker key is not part of this: the reader has no secret at all, and `modal/tinker_jobs.py` is not changed and needs no deploy.

**What exists after these steps.** One new Modal app, `oblab-datasets` (`modal/datasets.py`), with five functions: `fetch_dataset` (the only one with the network), `describe_files` and `read_rows` (no network, no secrets, the shelf read-only), and the `start` and `status` endpoints. One new Volume, `oblab-datasets` (the shelf), and one new Dict, `oblab-datasets-use` (when each entry was last used). One new Modal secret, `oblab-datasets-auth`, holding `JOBS_TOKEN`, which only lets the lab server reach the two endpoints. `modal/gpu_jobs.py` changes too: it can now mount one shelf entry in a job's sandbox, and it has one more function, `build_data_image`, which nothing calls and which does nothing (see step 2).

**1. The Modal secret.** From my Mac:

```
JOBS_TOKEN=$(openssl rand -hex 32)
modal secret create oblab-datasets-auth JOBS_TOKEN="$JOBS_TOKEN"
echo "$JOBS_TOKEN"   # this one goes in Vercel as DATASETS_TOKEN
unset JOBS_TOKEN
```

**2. Deploy the two Modal apps.** From this repository. The datasets app first, because it creates the Volume the GPU jobs app only looks up:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/datasets.py
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/gpu_jobs.py
```

The first prints two endpoint URLs; they go in Vercel as `DATASETS_START_URL` and `DATASETS_STATUS_URL`. Its first deploy builds the reader's image (pyarrow 26.0.1). The second keeps the GPU jobs URLs it had; its first deploy builds one more image, the GPU job image with pyarrow added, which only a job that names a dataset runs in. A plain GPU job, and one that names weights, run in the image they always had.

Modal builds an image at deploy only when a function of the app uses it, and a job's sandbox is not a function. That is what `build_data_image` is for: it is a function on the pyarrow image with no GPU, no secrets and no volumes, it returns `True` and nothing calls it, and because it is there the deploy builds the image. Without it the first job that named a dataset would build the pyarrow layer inside its own 300 s, and could come back as a timeout that looks like a broken mount. The deploy's output lists `build_data_image` beside `fetch_weights`, `run_job`, `start` and `status`; if it does not, the image was not built, and check (g) below should be run twice and judged on the second run.

**3. Check it by hand before any model can use it.** These calls go straight to the Modal endpoints. Each token is read into a shell variable without being shown or saved in the shell history. The two URLs in the first block are the ones the deploy printed.

```
read -s DATASETS_TOKEN
DSTART=https://...the start URL modal/datasets.py printed...
DSTATUS=https://...the status URL modal/datasets.py printed...

# a) Fetch a small public dataset (one 8 MB .json file, cc-by-4.0).
curl -sS -X POST "$DSTART" -H "Authorization: Bearer $DATASETS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fetch_dataset":{"repo":"sahil2801/CodeAlpaca-20k"}}'
# prints {"call_id":"fc-..."}; poll it until status is "done". Every call below prints its own
# call_id, and each is polled the same way with that id:
curl -sS "$DSTATUS?call_id=fc-..." -H "Authorization: Bearer $DATASETS_TOKEN"

# b) A dataset under a license that is not on my list must be refused.
curl -sS -X POST "$DSTART" -H "Authorization: Bearer $DATASETS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fetch_dataset":{"repo":"HuggingFaceH4/no_robots"}}'
curl -sS "$DSTATUS?call_id=fc-..." -H "Authorization: Bearer $DATASETS_TOKEN"

# c) A gated dataset must be refused.
curl -sS -X POST "$DSTART" -H "Authorization: Bearer $DATASETS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fetch_dataset":{"repo":"mozilla-foundation/common_voice_11_0"}}'
curl -sS "$DSTATUS?call_id=fc-..." -H "Authorization: Bearer $DATASETS_TOKEN"

# d) My limits reach the fetcher: with a 0.001 GB limit the same small dataset is refused for its size.
curl -sS -X POST "$DSTART" -H "Authorization: Bearer $DATASETS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fetch_dataset":{"repo":"sahil2801/CodeAlpaca-20k","limits":{"max_gb":0.001}}}'
curl -sS "$DSTATUS?call_id=fc-..." -H "Authorization: Bearer $DATASETS_TOKEN"

# e) The reader: 20 rows, two columns mapped into chat examples.
curl -sS -X POST "$DSTART" -H "Authorization: Bearer $DATASETS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"read_rows":{"repo":"sahil2801/CodeAlpaca-20k","user_column":"instruction","assistant_column":"output","limit":20}}'
curl -sS "$DSTATUS?call_id=fc-..." -H "Authorization: Bearer $DATASETS_TOKEN"

# f) A column that is not there must be refused, not guessed.
curl -sS -X POST "$DSTART" -H "Authorization: Bearer $DATASETS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"read_rows":{"repo":"sahil2801/CodeAlpaca-20k","user_column":"prompt","assistant_column":"output","limit":20}}'
curl -sS "$DSTATUS?call_id=fc-..." -H "Authorization: Bearer $DATASETS_TOKEN"
unset DATASETS_TOKEN

read -s JOBS_TOKEN
START=https://dervinevolve--oblab-gpu-jobs-start.us-east.modal.run
STATUS=https://dervinevolve--oblab-gpu-jobs-status.us-east.modal.run

# g) A GPU job that names the dataset: it must see it, fail to write, and have no network.
curl -sS -X POST "$START" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"dataset":{"repo":"sahil2801/CodeAlpaca-20k"},"script":"import json, os, urllib.request\nprint(sorted(os.listdir(\"/datasets\")))\nprint(len(json.load(open(\"/datasets/code_alpaca_20k.json\"))), \"rows\")\ntry:\n    open(\"/datasets/x\", \"w\")\n    print(\"WRITABLE\")\nexcept OSError as e:\n    print(\"read-only:\", e)\ntry:\n    urllib.request.urlopen(\"https://huggingface.co\", timeout=5)\n    print(\"NETWORK OPEN\")\nexcept Exception as e:\n    print(\"network blocked:\", type(e).__name__)\n"}'
curl -sS "$STATUS?call_id=fc-..." -H "Authorization: Bearer $JOBS_TOKEN"

# h) A plain job, with no dataset: there must be no /datasets at all.
#    This is the path every GPU job takes today, so it also shows the redeploy left plain jobs working.
curl -sS -X POST "$START" -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"script":"import os\nprint(os.path.exists(\"/datasets\"), os.path.exists(\"/weights\"))\n"}'
curl -sS "$STATUS?call_id=fc-..." -H "Authorization: Bearer $JOBS_TOKEN"

unset JOBS_TOKEN
modal volume ls oblab-datasets sahil2801/CodeAlpaca-20k
```

What I expect: (a) ends with `"status":"ok","cached":false`, a 40 character `sha`, `"files":1`, `"rows":20022` and a `data_files` entry with the columns `instruction`, `input` and `output`; asking again gives `"cached":true`. (b) ends with `"status":"refused","rule":"license"`. (c) ends with `"status":"refused","rule":"not_public"`, because without a token a gated dataset looks like one that is not there. (d) ends with `"status":"refused","rule":"size"`. (e) ends with `"status":"ok","rows_used":20,"stopped":"limit"` and 20 examples, each a user message and an assistant message. (f) ends with `"status":"refused","rule":"columns"`. (g) prints `['_lab_manifest.json', 'code_alpaca_20k.json']`, `20022 rows`, a `read-only:` line and a `network blocked:` line, and its result has `"dataset":{"repo":"sahil2801/CodeAlpaca-20k",...}`. (h) prints `False False`, ends with `"status":"ok"` and has no `dataset` field at all.

If (g) prints `WRITABLE` or `NETWORK OPEN`, or fails at stage `sandbox` or `mount`, leave the flag off. If (h) fails, plain GPU jobs are broken too: deploy `modal/gpu_jobs.py` from the commit before this feature again. If (a) is `ok` but its `rows` is null, or (e) fails at stage `reader`, the reader's two settings are the first thing to look at (see the next paragraph).

**What I have and have not run.** I ran the fetcher's rules, its download and hash checks, the row counting and the column mapping against the live Hugging Face API from a development machine, without Modal: the dataset in (a) was fetched and read, and the ones in (b) and (c) were refused as written above. I have not run any of this on Modal. Untested there: the fetch function and the Volume; the fetcher calling `describe_files` after a commit; the reader functions running with `block_network=True`, `restrict_modal_access=True` and one container per call (if Modal refuses a function with those settings, or the reader cannot return its result under them, remove `restrict_modal_access=True` from the two decorators in `modal/datasets.py` first and say so here); the read-only mount of one dataset entry into a GPU job's sandbox; the second sandbox image with pyarrow; and that the deploy builds that image because of `build_data_image` (it is how Modal treats every function's image, but I have not watched this deploy do it). Step 3 is that test.

**4. Turn it on in Vercel.** Set these for Production and redeploy:

| Variable | Default | What it does |
|---|---|---|
| `LAB_ENABLE_DATASETS` | false | The switch. Only the exact value `true` turns it on. |
| `DATASETS_START_URL` | none | The `start` endpoint Modal printed for `modal/datasets.py`. An `https://` URL with no query string. |
| `DATASETS_STATUS_URL` | none | The `status` endpoint. |
| `DATASETS_TOKEN` | none | The value from step 1. Mark it Sensitive. |
| `LAB_DATASETS_PER_DAY` | 2 | Requests for a dataset per UTC day, 0 to 20. A shelf hit and a refusal count; a skipped request does not. |
| `LAB_DATASETS_LICENSES` | apache-2.0, mit, cc-by-4.0, cc-by-sa-4.0, cc0-1.0, odc-by, bsd-3-clause | Comma separated license ids as Hugging Face writes them. The defaults apply only when it is not set. An entry that is not an id is left out, and if none is left the tool is off; it never falls back to the defaults. |
| `LAB_DATASETS_MAX_GB` | 1 | Largest download, in GB of 10^9 bytes. The Modal side never allows more than 20. |
| `LAB_DATASETS_SHELF_GB` | 20 | Size of the shelf before the least recently used entries are removed. Never more than 200. |
| `LAB_DATASETS_POLL_MAX_MS` | 180000 | How long an epoch waits for a fetch, at most 300000. |
| `LAB_DATASETS_READ_POLL_MAX_MS` | 150000 | How long the follow-up waits for the reader before a training run on a dataset is given up, at most 240000. |
| `LAB_TRAINED_CHAT_DATASET_ADAPTERS` | false | Whether the visitor chat may offer an adapter trained on dataset rows. Leave it off unless I have looked at the dataset myself: see below. |

The limits are read by the server and sent to the fetcher with each request, so changing one needs a Vercel redeploy and no Modal deploy. The next epoch's prompts show the new numbers. The row limits for a training run (6,000 bytes an example, 120,000 in all, 10 to 2,000 rows) are not settings: they are the Tinker tool's own limits, written in `api/_lib/tinker.ts` and again in `modal/datasets.py`, and a test holds the two files to each other.

**Reads per day.** There is no setting for it: a UTC day holds as many reads of dataset rows as `LAB_TINKER_PER_DAY` allows training runs (default 2). A read counts whether or not a run came of it, because a read that is refused opens no run and would otherwise never be counted while still costing Modal time. `SELECT epoch, status, output_tail FROM tool_runs WHERE tool = 'dataset_rows' AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'` shows today's.

**Adapters trained on a dataset and the visitor chat.** The Reviewer approves a dataset run without seeing a row, and I have not read the rows either. So while `LAB_ENABLE_TRAINED_CHAT` is on, such an adapter is left off the chat's list and a message that names it gets 404 `not_offered`. `SELECT slug, dataset_source FROM tinker_runs WHERE dataset_source IS NOT NULL AND status = 'ok'` lists them. `LAB_TRAINED_CHAT_DATASET_ADAPTERS=true` offers all of them at once, with the dataset named beside each and a notice that nobody at the lab has read those rows; there is no switch for a single adapter. Before I set it I look at the dataset on the hub, for every adapter in that list. Setting it back to anything else takes them off the list again at the next request.

**What a refusal may say.** The reason for a refusal is stored and the next epoch's models read it, so it must not carry text a dataset's author chose. The fetcher and the reader never repeat a name that failed its check (a file path, a license that is not shaped like a license id, a parser's message about a file), and `api/_lib/weights.ts` (`plainLine`) keeps only letters, digits, spaces and plain punctuation of anything they say. The same goes for the weights fetcher. If I change a message in `modal/datasets.py` or `modal/gpu_jobs.py`, it must not quote `rfilename`, a card field or an exception's text.

**Spend.** A fetch is written to `model_calls` as `tool/datasets` and a read for a training run as `tool/dataset_rows`, both estimates from measured time at `LAB_MODAL_GPU_USD_PER_SECOND` (about ten times Modal's CPU price, so they err high), and both count against `LAB_DAILY_BUDGET_USD`. A fetch's worst case, 960 s or about $0.29, is checked against the budget before it starts. A training run on a dataset is checked twice: before the read, against the most the limits would let such a run cost plus the read; and after it, against the estimate made from the rows that were really read. That second estimate is what is set aside under `LAB_TINKER_DAILY_USD`, and a run over `LAB_TINKER_RUN_USD` is refused, exactly as for inline examples. Volume storage is billed by Modal and is not in the ledger.

**The database.** The first training run on a dataset adds one column, `tinker_runs.dataset_source` (JSONB). Nothing else changes, and a lab that never trains on a dataset never has it.

**A dataset in use is not evicted.** An entry that was fetched, asked for, read or named by a job in the last 300 s is not removed to make room. A fetch that could only fit by removing one is refused with rule `shelf`.

**The shelf by hand.** `modal volume ls oblab-datasets` lists it, and `modal volume get oblab-datasets <org>/<name>/<sha>/_lab_manifest.json -` prints one manifest. `modal volume rm -r oblab-datasets <org>/<name>` removes one dataset, and `modal volume delete oblab-datasets` removes everything (the next deploy of `modal/datasets.py` creates an empty one). Narrowing `LAB_DATASETS_LICENSES` does not delete what is already there, but a job or a training run that names a dataset whose license is no longer on the list is not started.

**Turning it off.** Set `LAB_ENABLE_DATASETS` to anything but `true` and redeploy Vercel. The models are no longer told about it, requests for datasets are ignored, GPU jobs get no `/datasets`, and a training request that names a dataset is refused as an unknown field. Adapters already trained on a dataset keep their record, and stay out of the visitor chat unless `LAB_TRAINED_CHAT_DATASET_ADAPTERS` is `true`. The shelf stays where it is until I delete it.

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
| `LAB_TRAINED_CHAT_DATASET_ADAPTERS` | false | Whether that chat also offers adapters trained on rows of a public dataset ([Public datasets](#public-datasets)). Nobody has read those rows, so it is off unless I say so. |
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

## Naming and keeping trained adapters

Two more switches on top of [Tinker training](#tinker-training), both default false and independent of each other. `LAB_ENABLE_TINKER_NAMES` lets a training request carry a display name for its adapter. `LAB_ENABLE_TINKER_KEEP` lets an adapter be marked kept, by a model with the Reviewer's approval or by me, so that it stays on Tinker for a year instead of two weeks and a copy of its weights is written to my own Modal Volume. What each does, checks and records is in [TOOLS.md](TOOLS.md#naming-a-trained-adapter). With both off nothing changes: the prompts, the requests to the runner, the routes' answers and the tick are as before, and the database gets no new table or column.

**Names need nothing but the switch.** Set `LAB_ENABLE_TINKER_NAMES=true` in Vercel and redeploy. No Modal deploy, no new secret. The first run that carries a name adds two columns to `tinker_runs` (`display_name`, `name_key`) and a unique index, by itself.

**Keeping needs the runner redeployed first.** In this order:

**1. Redeploy the runner.** The keeper is a new function in the same file, so it is the same command as before, from this repository:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/tinker_jobs.py
```

The app `oblab-tinker` now has four functions: `train`, `keeper`, and the `start` and `status` endpoints. The deploy creates the Modal Volume `oblab-kept-models` by itself (`create_if_missing`), mounted in `keeper` only. `keeper` is given the same Modal secret as `train`, `oblab-tinker-auth`, because setting a checkpoint's time to live and downloading its weights both need the Tinker key; the two endpoints still have only `oblab-tinker-jobs-auth`. There is no new secret and the endpoint URLs do not change. The image is the same, so nothing is rebuilt.

An old runner is safe with the new server and the other way round. An old runner ignores the request to save weights for download, so runs train as before and their adapters can be kept without a copy; it refuses a keep outright, and the lab gives the place back and stores why. But there would be no copies, so I deploy before I switch keeping on.

**2. Smoke test of keeping, before any model can use it.** This calls the deployed `train` and `keeper` directly with my Modal login:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py keep
```

It trains the same 20 made-up examples as the first smoke test, this time with the weights also saved for download; asks `keeper` to keep the result under a made-up id with a time to live of two hours and a copy on the Volume; prints what the keeper answered; and then unkeeps it and removes the copy again. It costs about a tenth of a cent, like the first one, and the two checkpoints it leaves on Tinker expire within the hour.

What I expect: seven lines that start with `ok`, among them "its weights were also saved for download", "the time to live was set", "a copy was written to the Volume" and "the copy is in PEFT format", then `keep: all as expected`. The keeper's answer names two files, `adapter_config.json` and `adapter_model.safetensors`, with sizes and SHA-256, and how many checkpoints my Tinker key holds. What a `FAIL` means:

- on "its weights were also saved for download": Tinker did not save external weights for this account. An older line in Tinker's changelog says downloads of external weights need to be enabled for an organisation; if the reason printed says so, I ask Tinker. Keeping still works without it, as a longer life with no copy.
- on "a copy was written to the Volume": the reason printed says which step failed (the list of files, a download, the size limit, the Volume).
- on "the copy is in PEFT format" alone: the copy is there as Tinker exported it and the conversion failed; the reason says why. The files are usable later, so this does not block switching on, but I want to know.

**3. Vercel.** Set these for Production and redeploy:

| Variable | Default | What it does |
|---|---|---|
| `LAB_ENABLE_TINKER_NAMES` | false | A training request may carry a display name. Only the exact value `true` turns it on. Needs nothing else. |
| `LAB_ENABLE_TINKER_KEEP` | false | Adapters can be kept, by a model with the Reviewer's approval and by me through the operator route. Only the exact value `true`, and only with the three `TINKER_JOBS_*` settings. Training itself need not be on: adapters trained earlier can still be kept. While it is on, every training run also saves its weights for download. |
| `LAB_TINKER_KEEP_MAX` | 10 | How many adapters may be kept at one time, mine and the models' together. 0 to 40; 0 turns keeping off. |
| `LAB_TINKER_KEEPS_PER_DAY` | 2 | How many keep requests from models are carried out per UTC day, 0 to 10. An epoch may ask for one. Mine are not counted here. |
| `LAB_TINKER_KEEP_DAYS` | 365 | How long a kept adapter stays on Tinker, counted from the day it is kept. 30 to 3650. |
| `LAB_TINKER_KEEP_MAX_MB` | 1024 | The most one copy on the Volume may weigh. 1 to 4096. |

There is no new secret in Vercel. Keeping does not use `TINKER_API_KEY` on the server; only the runner touches Tinker for it.

**Vercel functions.** One new function, `api/experiment/trained-adapters.ts` (the project now has 20; `vercel.json` gives it 120 s, because a keep waits up to 45 seconds for the runner). Nothing calls it but me. The tick collects keeps that were still going, and gives back the places of kept adapters that have expired, inside the existing cron function.

**4. Using the operator route.** The secret is the same `LAB_OPERATOR_SECRET` as for the other operator routes.

```
read -s LAB_OPERATOR_SECRET
HOST='https://...my deployment...'
# What is alive, what is kept, by whom, and how many places are taken. Changes nothing.
curl -sS "$HOST/api/experiment/trained-adapters" -H "Authorization: Bearer $LAB_OPERATOR_SECRET"
# Keep one. The reason is optional and public.
curl -sS -X POST "$HOST/api/experiment/trained-adapters?confirm=true" -H "Authorization: Bearer $LAB_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' -d '{"action": "keep", "adapter": "lab/e41-0a1b2c3d", "reason": "the lowest held-out loss so far"}'
# Unkeep it again. The copy on the Volume stays unless remove_copy is true.
curl -sS -X POST "$HOST/api/experiment/trained-adapters?confirm=true" -H "Authorization: Bearer $LAB_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' -d '{"action": "unkeep", "adapter": "lab/e41-0a1b2c3d", "remove_copy": false}'
# Take a display name away. The adapter itself is not touched.
curl -sS -X POST "$HOST/api/experiment/trained-adapters?confirm=true" -H "Authorization: Bearer $LAB_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' -d '{"action": "clear_name", "adapter": "lab/e41-0a1b2c3d"}'
unset LAB_OPERATOR_SECRET
```

What a keep answers: 200 with `"status": "ok"` and a sentence saying until when it is kept and what happened to the copy; 202 with `"status": "started"` when the runner had not answered within 45 seconds (the next tick collects it, and the GET shows it as pending until then); 409 with `"status": "refused"` and the reason when nothing was changed (not alive, already kept, every place taken, keeping switched off); 502 when the runner failed, with the place given back. An unkeep answers 200, 404 when the adapter is not kept, 409 while a keep of it is still going, or 502 when the runner did not answer, in which case nothing was changed and I call again. Unkeeping and taking a name away work with the switches off, so I can always undo.

**5. What I check after turning keeping on.**

- `GET /api/experiment` lists `keep_adapter` in `tools_enabled`, and the GET above says `"enabled": true` with `"max"` as I set it.
- The next training run's `tool_runs` row has `detail.external_path`, a path with `/external_weights/` in it. If it has `detail.export_error` instead, that adapter can be kept without a copy only, and the reason is there.
- After the first keep, the `tool_runs` row (tool `keep_adapter`, or `owner_keep_adapter` for mine) has `detail.kept_until`, `detail.tinker.ttl_seconds`, `detail.tinker.checkpoints_in_account` and `detail.copy` with the folder, the format and each file's SHA-256. The visitor chat lists that adapter first with its "kept" mark.
- The copy itself:

  ```
  modal volume ls oblab-kept-models
  modal volume ls oblab-kept-models e41-0a1b2c3d
  modal volume get oblab-kept-models e41-0a1b2c3d/lab_manifest.json -
  ```

  The folder holds `adapter_config.json`, `adapter_model.safetensors` and `lab_manifest.json`. To use a copy I download the folder (`modal volume get oblab-kept-models e41-0a1b2c3d ./e41-0a1b2c3d`) and load it on the base model the manifest names, for example with `peft` (`PeftModel.from_pretrained(base, "./e41-0a1b2c3d")`) or vLLM (`--enable-lora --lora-modules name=./e41-0a1b2c3d`). A manifest that says `"format": "tinker"` means the files are as Tinker exported them; `tinker_cookbook.weights.build_lora_adapter(base_model=..., adapter_path=..., output_path=...)` converts them.
- `SELECT slot, slug, status, kept_by, reason, requested_at, kept_at FROM tinker_keeps ORDER BY slot` shows every place that is taken. A keep that outlasts its request leaves `pending` at the next tick. While the runner cannot be reached the lab goes on asking for up to three hours before it gives the place back, so a row still `pending` after about four hours means the tick is not collecting.
- Tinker's side: `tinker checkpoint list` shows the kept adapter's sampler checkpoint with its new expiry, and `tinker billing checkpoint-storage` shows how much of the free 100 checkpoints and 100 GB is used (it can lag an hour or two). Each keep also stores the number of checkpoints my key held at that moment.

**Checkpoint storage.** Tinker stores 100 checkpoints or 100 GB per organisation for free, and past either it stops a training session after one last save. While keeping is on, every run leaves two checkpoints instead of one until they expire (the adapter for sampling, and its weights for download), and each kept adapter holds one for `LAB_TINKER_KEEP_DAYS` (a year). A kept adapter whose copy failed holds two for that long: the runner gives the downloadable checkpoint the same long life, so that the copy can still be made. With my defaults that is at most 2 runs x 14 days x 2 = 56, plus 10 kept, or 20 if every copy failed, so 76 at the worst, plus the few from smoke tests. If I raise `LAB_TINKER_PER_DAY` I lower `LAB_TINKER_TTL_DAYS` so that runs a day x days x 2, plus 2 x `LAB_TINKER_KEEP_MAX`, stays well under 100. A keep whose record says the copy failed (`detail.copy.status` is `error`) is the one holding two. Once downloads work again I unkeep it and keep it again: the unkeep sets both checkpoints back to the usual `LAB_TINKER_TTL_DAYS`, and the new keep makes the copy and extends the adapter alone. `tinker checkpoint delete tinker://<run>/external_weights/final` removes a downloadable checkpoint I no longer need; once a copy is on the Volume the downloadable one is not needed any more.

**When a kept adapter runs out.** A keep lasts `LAB_TINKER_KEEP_DAYS` from the day it is kept. After that the adapter expires on Tinker like any other, the lab stops offering it, the next tick gives its place back and stores a `kept_adapter_expired` row. The copy on the Volume stays. To keep one longer I unkeep it and keep it again before that date. If I unkeep one that has already expired, the lab only frees the place; a copy I no longer want goes with `modal volume rm -r oblab-kept-models <lab id>`.

**If a keep is recorded as lost.** A row that says "the runner was lost" also says the time to live on Tinker is unknown: the runner may have set the year before it stopped. I keep the adapter again (that sets it properly and reuses or makes the copy), or set it back by hand with `tinker checkpoint set-ttl tinker://<run>/sampler_weights/final --ttl 1209600`.

**Things I know are not checked from the development machine.** It cannot reach Modal or Tinker, so no adapter has been kept for real. What was checked: the runner file compiles and imports on Python 3.9; the SDK calls the keeper makes (`set_checkpoint_ttl_from_tinker_path`, `get_external_weights_urls`, `list_user_checkpoints`, `save_weights_external`) match the signatures of the installed `tinker` 0.39.1 and Tinker's documentation as I read it on 18 November 2026; the reading of the base model's config and safetensors headers ran against the real Hugging Face repositories of all three base models (a second or two, about 100 KB on disk for the 4B model, instead of 9 GB); and the cookbook's real `build_lora_adapter` 0.6.1 converted an adapter I made up, with the weight names I believe Tinker uses, against those headers. What step 2 is the first real test of: that Tinker saves external weights for my account at all, what files that export really holds and how its weights are named, the signed download, the conversion of a real export, the Volume mount and its commit, and the time to live being changed on a sampler checkpoint. Not checked anywhere yet: that the stub files the conversion reads (the real length with only the header written) take no room in a Modal container the way they do on my machine. If they did take room the conversion would fail and the copy would be stored as Tinker exported it, with the reason. I have also not loaded a kept copy into `peft` or vLLM, and whether `list_user_checkpoints` counts the whole organisation or only my key's user is not something the documentation settles, so I read the stored number as "at least".

**Turning it off.** Set `LAB_ENABLE_TINKER_KEEP` to anything but `true` and redeploy: the models are no longer told about it, `keep_adapter` is an unknown tool again, runs stop saving weights for download, and the operator route refuses a new keep. Adapters that are already kept stay kept and keep answering until their time runs out; they are listed in the chat in the ordinary order without the mark. A keep that was still going when I switched off keeps its place until the switch is on again, and so does a kept adapter that expires in the meantime; no money is tied to either. I can still unkeep through the operator route with the switch off. `LAB_ENABLE_TINKER_NAMES` turns off the same way: `name` is an unknown field again, and names already given are shown nowhere but stay in the database, so turning it back on shows them again. To empty the Volume: `modal volume rm -r oblab-kept-models <lab id>` for one adapter, or `modal volume delete oblab-kept-models` for all of it.

## Stories from the research model

One switch, `LAB_ENABLE_RESEARCH_TALK`, default false. With it on, the research loop has the runner save the model each run trains, a run kept as the new best has its model promoted, and visitors can ask that model for a short story in the "Talk to what they trained" panel. What it does, checks and records is in [TOOLS.md](TOOLS.md#the-research-model-talks). With it off nothing changes: the request that starts a run, the prompts, the routes' answers and the database are as before.

It needs the research runner redeployed first. In this order:

**1. Redeploy the runner.** Same file, same command as before, from this repository:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/research_runner.py
```

The app `oblab-research-runner` now has seven functions: `run_experiment`, the `start` and `status` endpoints, and four new ones, `kept_info` (lists the kept models), `store_op` (promotes one), `sample_story` (starts a sampling sandbox) and the `models` endpoint. Modal prints a third URL, for `models`; it goes in Vercel as `RESEARCH_RUNNER_MODELS_URL`. The deploy creates the Modal Volume `oblab-research-models` by itself (`create_if_missing`). There is no new secret: `models` uses `oblab-runner-auth`, like `start` and `status`, and their URLs do not change. The two images are defined exactly as they were, so I expect nothing to be rebuilt; sampling reuses the training image.

**This redeploy is a boundary for the research scores, and I write it down as one.** What I changed and did not change, so that the note is accurate:

- A run started without a key (which is every run while the switch is off) goes through the same code as before: same image, same supervisor, same limits, same result. The only differences in the deployed app are that the controller function now also has the models Volume mounted, which it does not touch, and that its own time limit is 300 seconds longer (1980 instead of 1680), which matters only to a controller that hangs.
- A run started with a key trains in the same image, from the same supervisor and command, under the same 8 MB file limit, the same budget and the same hard stop. It is not the same in two ways: the sandbox's disposable copy of `prepare.py` has a block appended that wraps `evaluate_bpb` and holds one reference to the last model scored; and at exit the process spends a second or so writing the model. None of that is training, but it is a change to the flow around it, and it shows in two numbers. The "training wall time (measured by the runner)" is the life of the whole process, so for these runs it includes the save. And the save is inside the hard stop: a process still saving when the budget plus 120 s is up is stopped and the run is a crash at stage `budget`, exactly as one still training would be. Nothing the sandbox writes is asked when training "really" ended, because the generated code could write that too.
- The boundary is in the record itself, not only in this note. The runner puts `runner_flow: "keep-1"` on every result of a run that had the save step. From there it goes into the commit trailers (`Runner-Flow: keep-1`), the finding page ("Runner flow") and `results.tsv`, which gets a fourteenth column, `runner_flow`, the first time such a run is written. Rows from then on have `keep-1` or `-`; earlier rows are not rewritten. Runs without the mark are plain runs, whatever the switch said at the time: an old runner ignores the key and marks nothing.

An old runner is safe with the new server: it ignores the key, the run trains as before, and the epoch records that the runner said nothing about a saved model. A new runner is safe with an old server, which never sends a key.

**2. Check the whole path cheaply, before any GPU.** This trains the tiny CPU model on synthetic bytes (about 20 seconds of training, no GPU), saves it, and asks it for 64 bytes in a sampling sandbox. Nothing is promoted; the saved candidate is cleared away with the other old candidates within three days. Any `train.py` the loop has written will do; I use the current one from my Research-Lab checkout:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal run modal/research_runner.py::keep_current --train-py ../Research-Lab/train.py --smoke
```

What I expect: the run's result with `"status": "ok"` and `"checkpoint": {"key": "smoke-...", "saved": true, ...}`, then a second object with `"status": "ok"` and a `"text"` that starts with "Once upon a time" and goes on in nonsense (the model saw twenty seconds of random bytes). If `saved` is false the `reason` beside it says which step failed. If the second object says `"stage": "definitions"` or `"load"`, the model was saved but could not be loaded again, and the error says why.

**3. Have a model to talk to now, without waiting for the loop to improve (optional).** The loop keeps a run only when it beats its best, which can take days. This trains the current `train.py` once more and keeps that model. It is a real run: a GPU for the 300-second budget, about seven minutes in all, about 13 cents at my GPU rate.

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal run modal/research_runner.py::keep_current --train-py ../Research-Lab/train.py
```

It is not an epoch. Nothing is written to the ledger or the research repository, the manifest says `"source": "owner_rerun"`, and the room labels it "The research loop's training code, run once more by the owner". Its `val_bpb` is that one run's own, which will differ a little from the ledger's best because runs vary. The command promotes the model, then samples it once and prints that story (the same check the lab makes by itself when the loop's own run is kept). Afterwards, and at any time, this lists what is kept:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal run modal/research_runner.py::list_kept
```

A kept model with `"check": {"ok": true, ...}` is one visitors can ask. `"check": null` means the sample has not finished; `"ok": false` comes with the reason.

**4. Vercel settings, then redeploy the lab.**

| Variable | Default | What it is |
|---|---|---|
| `LAB_ENABLE_RESEARCH_TALK` | false | The switch. |
| `RESEARCH_RUNNER_MODELS_URL` | none | The `https://` URL Modal printed for `models`. Without it the switch does nothing. |
| `LAB_RESEARCH_TALK_DAILY` | 200 | Stories for all visitors in one UTC day, 0 to 2000. 0 closes the story box and keeps the saving on. |
| `LAB_RESEARCH_TALK_MAX_NEW` | 200 | New bytes in one story, 20 to 500. The model's tokens are single bytes. |
| `LAB_RESEARCH_TALK_USD_PER_STORY` | 0.005 | What one story is written to the spend ledger as, 0 to 0.25. A flat estimate that I believe errs high; Modal's bill is not read back. |

At the defaults the most stories can add to a day's ledger is $1. The per-visitor limits are fixed in `api/_lib/research-talk.ts`. There is no new secret in Vercel.

**Vercel functions.** One new function, `api/experiment/research-talk.ts` (the project now has 21; `vercel.json` gives it 120 s, because a story waits for a sandbox to start, load the model and write, and the server gives up after 105). With the switch off nothing calls it: the room's page learns from `GET /api/experiment` whether stories are on, and only then calls the route.

**Database.** Three tables, made the first time the route is read or a story is asked for while the switch is on: `research_talk_rate` (counts under keyed hashes), `research_talk_calls` (one row of counts per story, no text) and `research_talk_state` (one row: the runner's list of kept models and when it was last read, so that all server instances together ask the runner at most once a minute). Nothing is added to `epochs`; the key, the runner's report on the saved model and the promotion live inside the `research_run` JSON an epoch already has.

**5. What I check after turning it on.**

- `GET /api/experiment` has `research_talk_enabled: true`.
- `curl -sS "$HOST/api/experiment/research-talk"` says `"enabled": true` and names the model with its epoch and `val_bpb`, or `"model": null` when nothing has been kept yet.
- A story:

  ```
  curl -sS -X POST "$HOST/api/experiment/research-talk" -H 'Content-Type: application/json' -d '{"prompt": "Once upon a time there was a fox"}'
  ```

  The first one after a quiet spell takes up to a minute (a container and then a sandbox have to start); the next ones about ten to twenty seconds.
- The next research epoch's row: `research_run.keep_key` is `e<epoch>-<first 8 of the experiment id>`, and once the run is back `research_run.result.checkpoint.saved` is true with a size and SHA-256, or false with a `reason`. If the run is kept as the new best, `research_run.promotion.ok` is true and the finding page has a "Saved model" line. If the runner did not answer in 45 seconds, `promotion.ok` is false with no `refused` beside it, and the lab asks again at the start of the next research epochs (up to 6 times in all, `promotion.attempts` counts them); `list_kept` shows whether the model arrived.
- That run's result has `runner_flow: "keep-1"`, its row in `results.tsv` ends in `keep-1` under a header that now ends in `runner_flow`, and its commits carry `Runner-Flow: keep-1`. If they do not, the runner was not redeployed.
- `result.train_wall_seconds` of these runs includes the save (`result.checkpoint.save_seconds` is what the save says it took, for information). If it comes close to the budget plus 120 s, runs are at risk of being stopped while saving and I should look at how long the save takes on the GPU before leaving this on.
- The run takes a little longer than before, the time it takes to copy the model out of the sandbox (I expect ten to thirty seconds for a 40 MB model, but I have not measured it on Modal). `result.checkpoint.collect_seconds` says how long it was. A run that used to come back just inside the 400 seconds one request waits may now be collected by the next hourly tick instead.
- `modal volume ls oblab-research-models kept` and `modal volume get oblab-research-models kept/<key>/manifest.json -`.
- `SELECT created_at, model_key, status, stage, prompt_chars, new_bytes, stopped, duration_ms FROM research_talk_calls ORDER BY created_at DESC LIMIT 20`.

**What I have and have not run.** On a development machine with the same torch version (2.6.0, CPU): the appended block, the runner's supervisor, the reader and the sampler, run for real on the loop's current `train.py` in smoke mode and on a small model in the tests. The model was saved, copied, stored, promoted and asked for text; a `train.py` with no main guard and a run that never calls `evaluate_bpb` fail the way the documents say. A model of the loop's real size (about 11 million parameters) wrote 200 bytes in under six seconds on one CPU thread there. I have not run any of this on Modal. Untested there: the deploy itself; copying tens of megabytes out of a sandbox through a command's output; the save at exit on a GPU model that was compiled with `torch.compile`, and how long it takes there (it now counts inside the hard stop); reading a sampling sandbox's output piece by piece; the write to the Volume and its commit; mounting one kept model's directory into a sandbox with `sub_path`; how long a sampling sandbox takes to start; and the `models` endpoint waiting on `sample_story`. Step 2 is the first real test of most of it, step 3 of the GPU part.

**Turning it off.** Set `LAB_ENABLE_RESEARCH_TALK` to anything but `true` and redeploy: runs are started without a key again, the models are no longer told about it, the story box disappears and the route says it is off. Kept models stay on the Volume and are offered again if I switch it back on. The runner can stay as deployed; without a key it does what it did before. To empty the Volume: `modal volume rm -r oblab-research-models kept/<key>` for one model, or `modal volume delete oblab-research-models` for all of it.

## Model proposals to this repository

`LAB_ENABLE_LAB_PROPOSALS` (default false) lets a model propose a change to this repository. Proposals arrive as pull requests labelled `model-proposal`, authored by the model on `observable-lab.invalid`, using `LAB_PROPOSALS_GITHUB_TOKEN`: a separate fine-grained token for this one repository with Pull requests and Contents read/write only. Create the `model-proposal` label first. The lab never merges them. Review each like an outside contribution; see [SECURITY.md](../SECURITY.md).

## Rollout verification

Before enabling a deployment, verify that anonymous requests to operator routes return 401 (or 503 when unconfigured), that the scheduler accepts only its own credential, and that authorized work reaches the intended test environment. Check provider spend limits and the actual contents of public observer responses. Build and local regression tests do not verify deployed access controls.

The Modal images in `modal/research_runner.py` and `modal/app.py` use a digest-pinned `python:3.11.18-slim-bookworm` base and exact package versions. Rebuild and smoke-test after changing any of them. The dataset download in `modal/harness/prepare.py` uses `DATASET_REVISION` and `DATASET_SHA256`; real preparation refuses to download until both are set, and a pinned revision prepares into its own cache directory.

Smoke preparation uses `/cache/smoke`; research preparation uses `/cache/research`. Synthetic smoke bins cannot become the production dataset merely by existing first. Results record the dataset label and bundled harness hash; neither field independently validates the model-reported score.
