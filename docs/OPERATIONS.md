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
- Only lines shaped exactly like the lab's own rows are read: 9, 13, 14 or 19 columns (the last two from the runner flow column and the lab's repeat columns, described further down), an epoch number of at most six digits, `merged` or `reverted`, a score with four decimals or `-`, and `keep`, `discard` or `crash`.
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

- `/api/experiment/trained-chat` is public by design: it is the visitor chat with adapters the models trained ([Tinker training](#tinker-training)). While `LAB_ENABLE_TRAINED_CHAT` is off, which is the default, a GET says `{"enabled":false,"adapters":[]}` and a POST answers 503, and neither touches the database or the network. When it is on it is the one public route that spends money, so it has a rate limit per address, a tighter one per visitor (an address with a browser string), and its own small daily cap. The room's page calls it only after `GET /api/experiment` has said the chat is on, so with the chat off it gets no traffic from visitors' pages. While the chat is on, `GET /api/experiment` also carries `trained_chat_activity` (when someone last got an answer, and how many today), read from the existing `trained_chat_calls` rows with two small queries at most every 4 seconds per server instance and never written to. The table gets one partial index (`idx_trained_chat_calls_ok`, created with the table) and its rows are deleted after 30 days.

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

**Compare with untrained: run this once first.** The chat's comparison asks the base model by its own id instead of the adapter's path. I have not been able to confirm that Tinker's endpoint accepts a base model id here, so I check it before leaving the switch on:

```
read -s TINKER_API_KEY
curl -sS https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions \
  -H "Authorization: Bearer $TINKER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model": "Qwen/Qwen3.5-4B", "messages": [{"role": "user", "content": "Say hello."}], "max_completion_tokens": 20, "reasoning_effort": false}'
unset TINKER_API_KEY
```

If it answers with a `chat.completion`, `LAB_ENABLE_TRAINED_CHAT_COMPARE` can stay as it is (on). If Tinker refuses the base id (a 4xx), I set `LAB_ENABLE_TRAINED_CHAT_COMPARE=false` in Vercel and redeploy: `GET /api/experiment/trained-chat` then says `compare_enabled: false` and the page hides the switch. Nothing else changes, and there is no other server to redeploy. If the switch is left on and Tinker refuses at call time, the untrained side shows a plain error, costs nothing (an error status is a call that was not served), and the trained answer still shows. A comparison uses the chat's daily cap twice as fast: it counts as two messages and sets aside both calls' worst case.

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
| `LAB_TINKER_BASE_MODELS` | `Qwen/Qwen3.5-4B` | Comma separated, from `Qwen/Qwen3.5-4B`, `Qwen/Qwen3.5-9B`, `Qwen/Qwen3.6-35B-A3B`, `thinkingmachines/Inkling-2-Mini`. Anything else is left out; a list with nothing usable turns the tool off. The last one needs its own steps first: [Adding Inkling 2 Mini](#adding-inkling-2-mini-as-a-base-model). |
| `LAB_TINKER_RUN_USD` | 2 | The most one run may cost, by the estimate. Never more than 5. |
| `LAB_TINKER_DAILY_USD` | 10 | The most all Tinker use may cost per UTC day, by the estimate: runs, adapter calls through the lab model endpoint, and visitor chat. Never more than 50. |
| `LAB_TINKER_PER_DAY` | 2 | Runs per UTC day, 0 to 10. |
| `LAB_TINKER_TTL_DAYS` | 14 | How long an adapter is kept, 1 to 30 days. |
| `LAB_TINKER_POLL_MAX_MS` | 300000 | How long the follow-up waits for a run, at most 480000. A run still going is collected by a later tick. |
| `TINKER_API_KEY` | none | The Tinker key, Sensitive, Production. Needed only for the next two switches. |
| `LAB_ENABLE_LIVE_TRAINED` | false | Kept adapters answer on the lab model endpoint as `lab/<name>`. Needs `LAB_ENABLE_LIVE_MODEL=true` and `TINKER_API_KEY`. |
| `LAB_ENABLE_TRAINED_CHAT` | false | The visitor chat in the room. Needs `TINKER_API_KEY`. |
| `LAB_TRAINED_CHAT_DATASET_ADAPTERS` | false | Whether that chat also offers adapters trained on rows of a public dataset ([Public datasets](#public-datasets)). Nobody has read those rows, so it is off unless I say so. |
| `LAB_ENABLE_TRAINED_CHAT_COMPARE` | on | "Compare With Untrained" in that chat. On unless `false`, `0`, `off` or `no`. Run the probe above ("Compare with untrained: run this once first") once; if it fails, set this to `false`. An error status from Tinker is a call that was not served and costs nothing, but a timeout is still charged at its worst case. |
| `LAB_TINKER_CHAT_DAILY_USD` | 1 | The most all visitor chat may cost per UTC day, by the estimate, inside the $10. Never more than 10. |

I turn them on one at a time: `LAB_ENABLE_TINKER` first, then the two chat switches whenever I choose. Nobody reviews an adapter before it can be talked to; every finished adapter is listed until it expires (or for good once kept), and the chat says beside every reply that replies are not reviewed.

**Vercel functions.** The visitor chat is one new function, `api/experiment/trained-chat.ts` (the project now has 19; `vercel.json` gives it 60 s). With the chat off nothing calls it: the room's page learns from `GET /api/experiment`, which it reads anyway, whether the chat is on, and only then calls the chat route. Adapters on the lab model endpoint use the existing function and its `/models` rewrite. The tick collects finished runs inside the existing cron function, once per tick, before it advances any experiment.

**What I check after turning the tool on.**

- `GET /api/experiment` lists `tinker_train` in `tools_enabled`.
- After the first approved request, the `tool_runs` row with tool `tinker_train` has the dataset hash, both held-out losses under `detail.measured`, the estimated cost under `detail.cost`, and the adapter's name. A request that was refused is a `skipped` row with the reason.
- `SELECT status, slug, base_model, reserved_usd, cost_usd, expires_at FROM tinker_runs ORDER BY created_at DESC` shows every run, and `SELECT * FROM tinker_spend_days ORDER BY day DESC` shows what was set aside and spent per day. `reserved_usd` goes back to 0 once a run is collected. A row that stays `reserved` or `running` for more than about an hour means the tick is not collecting.
- `modal dict items oblab-tinker-runs` lists each run's name (its `slug`) with the call Modal started for it.
- With the visitor chat on, `curl -s https://<host>/api/experiment/trained-chat` says `"enabled": true` and lists the kept adapters, and `GET /api/experiment` carries `"trained_chat_enabled": true`. With it off the first call says `{"enabled":false,"adapters":[]}`, the state has no such field, and a visitor's page never calls the chat route.

**The estimate against the bill.** The ledger's Tinker rows are my estimate. The bill is Tinker's: `tinker billing usage <start> <end>` (two UTC hour timestamps), or the console, some hours later. I compare the two after the first few runs. If the bill is higher than the ledger, the price table in `api/_lib/tinker.ts` is out of date (Tinker's current one is at tinker-docs.thinkingmachines.ai/tinker/models.json) and needs the new numbers; the runner is sent the prices with every request, so that is a Vercel redeploy and no Modal deploy.

**Things I know are not checked from the development machine.** It cannot reach Modal or Tinker, so nothing has run there. What was checked: the runner file parses on Python 3.9 (it is deployed on 3.12); its whole flow ran locally against the real Tinker cookbook 0.6.1 and the real Qwen3.5 tokenizer, with only the training service replaced by a stand-in; and the SDK calls it makes match the signatures of the installed `tinker` 0.39.1. What steps 3 and 4 are the first real test of: the image build, the Modal secret reaching the function, a real training client, the loss values Tinker returns, the save with a time to live, and sampling. The second smoke test in step 4 is the first real test of the two HTTP endpoints starting a run on Modal, and of the Modal Dict that remembers which call was started under a run's name. The chat call in step 4 is the first real test that Tinker's OpenAI-compatible endpoint serves a LoRA checkpoint by its path and takes `"reasoning_effort": false` for these base models; its documentation says both, and says the endpoint is in beta.

**Turning it off.** Set `LAB_ENABLE_TINKER` to anything but `true` and redeploy: the models are no longer told about it and requests are ignored, so nothing new starts. I leave `TINKER_JOBS_START_URL`, `TINKER_JOBS_STATUS_URL` and `TINKER_JOBS_TOKEN` in place for at least an hour after that. A run already training carries on at Modal, and while those three are set the tick keeps collecting it: it only asks the runner about runs that were already started and closes their rows, so the run's record is written, its estimated cost reaches `model_calls` and the daily budget, and a finished adapter is recorded. This also covers a run whose experiment has been archived or replaced in the meantime. `SELECT count(*) FROM tinker_runs WHERE status IN ('reserved', 'running')` says when nothing is open any more; after that the three values can go too. If I remove them while a run is open and the switch is off, that run stays open and its cost is in Tinker's billing only, so I do not do that. (With the switch still on and the runner's address gone, an open run is closed after about an hour at the whole amount set aside.)

`LAB_ENABLE_TRAINED_CHAT` and `LAB_ENABLE_LIVE_TRAINED` turn off the same way: the panel's button disappears and pages stop calling the chat route, the chat route answers 503, and the lab model endpoint refuses `lab/` models like any unknown model. To stop everything at once, delete `TINKER_API_KEY` in Vercel and the `oblab-tinker-auth` secret in Modal, or revoke the key in the Tinker console. `modal app stop oblab-tinker` takes the runner down. Adapters expire by themselves; `tinker checkpoint list` and `tinker checkpoint delete` (or the console) remove them sooner.

## Adding Inkling 2 Mini as a base model

Inkling 2 Mini (`thinkingmachines/Inkling-2-Mini`, Thinking Machines, released 20 November 2026) is a looped transformer: a mixture of experts with 26.4B parameters, 5.4B active per token, a 64K context, and Tinker type "Hybrid + Vision". It is one more entry on the list of base models for both Tinker training and Tinker RL. The code knows it, but nothing changes until I add it to `LAB_TINKER_BASE_MODELS` (one exception: with names on, an adapter name that holds the whole word "Inkling" is refused from now on, allowlist or not, as it would look like a real model): the default list is still `Qwen/Qwen3.5-4B` alone, and the models are told no more than the list they have. Nothing in the prompts says to use it.

| Base model | Train | Sample | Prefill | Chat format the runner uses | Tinker type |
|---|---|---|---|---|---|
| `Qwen/Qwen3.5-4B` (default) | $0.737 | $1.005 | $0.33 | `qwen3_5_disable_thinking` | Hybrid + Vision, dense |
| `Qwen/Qwen3.5-9B` | $1.463 | $0.807 | $0.30 | `qwen3_5_disable_thinking` | Hybrid + Vision, dense |
| `Qwen/Qwen3.6-35B-A3B` | $1.177 | $1.335 | $0.45 | `qwen3_5_disable_thinking` | Hybrid + Vision, MoE |
| `thinkingmachines/Inkling-2-Mini` | $0.75 | $0.50 | $0.15 | `tml_v0` at thinking effort 0.0 | Hybrid + Vision, MoE |

Dollars per million tokens, read from `https://tinker-docs.thinkingmachines.ai/tinker/models.json` on 25 November 2026. I re-read all four rows that day and the three Qwen rows still matched, so the table date in `api/_lib/tinker.ts` is now 25 November. Two other Inkling 2 Mini entries are in Tinker's table and are deliberately not in the lab's: the 256K-context one (`...:peft:262144`, train $1.50) and a free-tier one (`...:peft:65536:free`). An id that is not exactly `thinkingmachines/Inkling-2-Mini` is left out of the list and refused in a request. The cached prefill price ($0.015) is not used: estimates apply the full prefill price, so they err high.

**The chat format, and what I found.** Tinker's cookbook has one renderer for the Inkling models, `tml_v0` (`TmlV0Renderer`, from the `tml-renderers` package). It has no "disable thinking" variant like the Qwen ones. It conditions the model on a "thinking effort", a number from 0.0 up to but not including 1.0, and renders it as a system message before the first non-system message. Without a number it uses 0.9, "high". Tinker's thinking-effort page names 0.0 "none" and says that it conditions the model toward no reasoning and is not a hard guarantee. The runner uses 0.0 for training and for sampling, the closest thing to the Qwen setting. Two details matter and are handled in `modal/tinker_jobs.py`:

- The cookbook's generic data helper (the one the runner uses) renders every training example at the default 0.9. If the runner trained at 0.9 and sampled at 0.0, or the other way round, the model would be asked at a prefix it never saw trained. The runner wraps the renderer (`FixedEffortRenderer`) so that training examples and sampling prompts both carry 0.0.
- The renderer needs the cookbook's own tokenizer for Inkling models, not the training client's Hugging Face one, which it refuses. The runner uses the cookbook's `get_tokenizer` for this model only; the Qwen path is as it was. The cookbook release the runner used before (0.6.1) mapped Inkling 2 Mini to the tokenizer of the first Inkling and would have trained on wrong tokens. 0.7.1 (20 November) maps it to the Inkling 2 tokenizer, so the pin is now `tinker-cookbook==0.7.1`.

The chat on kept adapters and the "compare with untrained" call ask Tinker's OpenAI-compatible endpoint for an answer without reasoning. For Qwen that is `"reasoning_effort": false`. A Thinking Machines model takes a level name or a number, and a boolean it does not take is an HTTP 400, so for Inkling the lab sends `"reasoning_effort": "none"` (0.0, the same level it trained at).

**Steps, in this order.** Each one costs nothing or a few cents, and each can stop me before the next.

1. Redeploy the runner. It is the same file; `render_check` is a new function in it, so this is needed even if the app is already deployed:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/tinker_jobs.py
```

Because this deploy also moves the runner to `tinker-cookbook==0.7.1`, I run the two Qwen smokes from Tinker training and Tinker RL again right after it (`python modal/tinker_smoke.py` and `python modal/tinker_smoke.py rl`, no `--model`), before any model asks for a run. They are the check that the Qwen path still works on the new release.

2. Check the chat format first. No Tinker call, no key, no cost. It renders one made-up conversation the way the runner trains and samples it and prints the prompt it built and eight checks. Six test that sampling and training render the same way (the effort really goes into the prompt; the sampling prompt is the start of the training example token for token; training weighs nothing the prompt already holds, and nothing but the answer, with at most a short end marker after it). Two test the family: the cookbook recommends `tml_v0` for the model, and the tokenizer the renderer wraps is the h200k one that Inkling 2 uses. If this cookbook version does not expose the tokenizer class, that line says `not checked` and passes; only the paid step 3 then shows that the tokens are right:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py render --model thinkingmachines/Inkling-2-Mini
```

What I expect: eight lines that start with `ok` and `render: all checks passed`. A renderer name that is wrong for the model, or a tokenizer of the wrong family, fails here with the check that broke. Step 3 is still the proof that the tokens are right: loss must fall and the samples must hold `OL-`. The next two commands run this check first and refuse to start a paid run when it fails. I also read the two printed texts. The prompt should hold a thinking-effort message and end after the user's question. What training weighs should be the model's own message header, the answer, the end of the message and the token sampling stops on, and nothing else: `<|message_model|><|content_text|>The lab code for red is OL-100.<|end_message|><|content_model_end_sampling|>`. The check counts format around the answer in tokens, at most four on each side. Its first version counted characters, and on 25 November 2026 it failed on the real runner for that reason alone, because one Inkling marker is a single token with a long name. The format it printed was the right one.

3. The tiny training smoke on this model. Same 20 made-up examples as step 4 of Tinker training, the budget is still 5 cents, and at Inkling's prices it costs well under one cent:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py --model thinkingmachines/Inkling-2-Mini
```

For this model the smoke also judges the result, because the examples all answer in one form (`The lab code for <colour> is OL-nnn.`): the held-out loss must fall, and every sampled answer must hold `OL-`. If the format were wrong (reasoning trained in, or sampled at another effort than trained) the answers would be thinking text or empty and it prints `FAIL`. It ends with `train thinkingmachines/Inkling-2-Mini: all as expected` and exits 0.

4. The RL smoke on this model (a few cents at most, capped at 5 cents):

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py rl --model thinkingmachines/Inkling-2-Mini
```

It runs the format check first. On 25 November 2026 this run finished with every part working, but it used about 18 times the answer tokens the same run uses on Qwen (1,672 against 92), and every answer that did not earn the full reward earned exactly zero. My reading then was that Inkling thinks before it answers even at effort 0, and that the cap of 40 tokens an answer cut some answers off before any answer was written. The raw command below confirmed it on 26 November. With a runner that has the counting, the `rl` check also prints, for every step, how many answers reached the token limit and the mean tokens an answer used, and for the held-out answers before and after how many were graded and how many reached the limit. A runner deployed before that prints none of these lines.

The raw command asks the untrained model one of the smoke's questions eight times, four at a cap of 40 tokens and four at 400, and prints every token it wrote. Then it asks Tinker's chat endpoint the same question twice (well under one cent in all):

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py raw --model thinkingmachines/Inkling-2-Mini
```

It calls `raw_probe`, a function of the runner that holds the Tinker key like the training functions do. No web endpoint starts it and the lab server never names it, so only my own Modal login can run it.

**What the probe of 26 November 2026 showed.** Runner at commit `cbacb5b`, `tinker-cookbook` 0.7.1, renderer `tml_v0`, effort 0.0, temperature 1.0, the question "Name one fruit other than a fig. Answer with the name only." The eight answers are kept as they were printed in `tests/fixtures/inkling-raw-probe-2026-11-26.json`.

- Inkling 2 Mini writes a thinking passage before its answer even at "Thinking effort level: 0". At a cap of 400 tokens all four answers finished, in 38, 42, 38 and 53 tokens, of which the answer itself was one word: 34 to 49 tokens of thinking on a one word question. The token limit counts them.
- At a cap of 40 tokens all four answers ran to the cap. One had finished thinking and written `apple`. Three ended inside the thinking passage.
- For those three the runner of that day returned the raw thinking text, markers included, as the answer (`'<|message_model|><|content_thinking|>The user wants one fruit...'`), and the rubric graded that text. The line "no answer read: 0 of 4" was therefore wrong for 3 of the 4.
- The same day, the training smoke on Inkling (20 made-up examples, 6 steps) took the held-out loss from 3.5119 to 0.4345, and the two sampled answers of the trained adapter were "The lab code for orange is OL-123." and "The lab code for cyan is OL-213.", 28 completion tokens for the two together. So the trained adapter wrote no thinking passage. Training weighs only the answer placed directly after the user's message, so this is what it teaches. An untrained and a trained answer of Inkling therefore differ in more than what the adapter learned.
- The RL smoke on Inkling that step 4 above describes, which I ran on 25 November with the runner of that day (cap 40, group 4, 2 tasks a step, 4 steps), had step means 0.625, 0.25, 0.625 and 0.75, each equal to the share at the best score, so every answer that was not perfect scored exactly 0. Held-out was 1.0 before and after, and it used 1,672 completion tokens where Qwen used 92.

**What changed in the runner because of it.** The answer the runner reads is now the text the model wrote as its answer and nothing else (`read_completion`). For Inkling it takes the text parts the cookbook's parser gives. Where the cookbook hands back the raw decoded text because the tokens stop in the middle of a message, the runner asks the renderer's own parser piece by piece and keeps only the pieces that are text, so an answer that ended inside its thinking reads as `''` and one cut off in the middle of its text reads as the part it wrote. If that parser cannot be asked (a cookbook release that hides it), the answer is empty rather than raw text. The parser reads a control token that the model writes inside an answer it did not close, such as the stop token straight after the answer with no end of message marker, or the header of a new message, as text that holds the marker's name. The runner asks the tokenizer whether a token is a control token and ends the answer at the first one it meets in the answer text, so neither the marker nor what follows it (which may be a thinking passage) is graded. A marker's name that the model types out as plain characters is ordinary tokens and stays in the answer. None of the eight answers has this shape, so I do not know how often Inkling writes it. Qwen reads exactly as before. This was run on the development machine on the real tokenizer and renderer, with the eight answers above turned back into tokens: the three that were raw thinking now read `''`, the other five read `apple` or `Apple`, and no cut of any of them at any token gives thinking or a marker. It has not been run against Tinker itself; the raw command after the redeploy is that test. The same eight answers are tests in `tests/test_tinker_reading.py`: once on a stand-in tokenizer, which always runs, and once on the real one, which is skipped with its reason where the Tinker cookbook is not installed. The supervised training samples and the practice runs both use this reading. Practice runs also count the answers that reached the limit ([TOOLS.md](TOOLS.md#tinker-rl)).

With the new runner the raw command prints each answer as `[cap, 40 tokens, no answer text began] answer read: ''` or `[stop, 38 tokens, 35 before the answer] answer read: 'apple'`, and the summary line for the answers above is "ran to the cap without finishing: 4 of 4; no answer read: 3 of 4". The number before the answer counts every token up to the first token of answer text, the two markers that open the answer included, so for the four finished answers it is 35 to 50. That is one more than the 34 to 49 above, which leaves out the marker that opens the answer text. A Qwen answer shows 0. An answer is counted as having run to the cap when it used the whole limit and its last token is not the stop token. That includes the second answer at 40 tokens above: its text `apple` and its end of message marker are there and only the stop token did not fit.

**The chat endpoint part, and how to read it.** The visitor chat, Compare With Untrained and the Socratic lesson's student calls do not sample through the runner. The lab server calls Tinker's OpenAI-compatible chat endpoint (`api/_lib/tinker-chat.ts`), with `"reasoning_effort": "none"` for Inkling. Until I run this, nobody has seen what that returns for Inkling. After the sampling part, `raw_probe` sends the same question to that endpoint for the untrained base model, once with `max_completion_tokens` 40 and once with 400, built the way `tinker-chat.ts` builds its request: the same address, the same fields in the same order, the same rule for `reasoning_effort`. `tests/fixtures/chat-probe-request.json` holds the request both must build, and a Python test and a Node test each compare their side with it, so the two cannot drift apart unnoticed. For each call the script prints:

- `HTTP 200, finish_reason "..."`. Whether a cap that falls inside the thinking is reported as `length`.
- `content (...)`: the content exactly as returned, with what kind of value it was (text and its length, or `null`, or a list). Empty content at 40 and `apple` at 400 would mean the thinking is counted and not returned. Thinking text or markers in the content would mean the visitor chat and the lesson show and grade it.
- `other fields on the message` and `other fields on the choice`: the name of every other field and what kind of value it holds, not the value. A separate reasoning field would show here, with its length.
- `usage`: every number in the usage object, and those one level down. `completion_tokens` near 38 for a one word answer would mean the thinking is counted. A `reasoning_tokens` entry would say how much of it.

A call that fails prints `FAILED: HTTP <status>, <reason>` with the reason cleaned of the key, and the sampling part above it stays as it was. The key is trimmed before it is sent, as the lab server trims it, so a key stored with a line break after it is not refused as a header. Every text this part reports has the key taken out before the text is cut to its length, so a cut cannot leave the start of the key standing. The raw check still exits 0 then, because finding out what the endpoint does is what this part is for. An HTTP 400 here would mean the endpoint does not take `"reasoning_effort": "none"` for the base id, which step 5 below also tests. A runner deployed before this part existed prints "chat endpoint: this runner did not try it". The cost line covers the sampling part only; the chat part is two more short calls.

**None of this takes effect until I redeploy the runner.** The reading, the counting and the chat endpoint part are all in `modal/tinker_jobs.py`, and the runner on Modal is only replaced by the deploy command in step 1. The lab server works with either runner: from an old one it reads no counts and shows none. The order matters for one thing. While Inkling is on `LAB_TINKER_BASE_MODELS`, the lab server tells the models that the lab's runner reads an answer whose limit falls inside the thinking passage as empty. That is true of the new runner only, so I deploy the runner before, or together with, the lab server. After the deploy I run the raw command once and read both parts, and I update the note the models read for the lesson (`inklingThinkingFacts` in `api/_lib/tinker.ts`), which today says that the chat endpoint has not been measured.

`keep` and `endpoints` take `--model` too. `TINKER_SMOKE_MODEL=thinkingmachines/Inkling-2-Mini` in the environment does the same as the option, and the option wins. Without either, every check runs on `Qwen/Qwen3.5-4B` as before. A model that is not in the table above stops the script before anything is called.

5. The chat call on Inkling. Same as "What I expect" in step 4 of Tinker training, with the adapter path from step 3 and `"reasoning_effort": "none"` in place of `false`. For the comparison, ask the base model by its id:

```
read -s TINKER_API_KEY
curl -sS https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions \
  -H "Authorization: Bearer $TINKER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model": "thinkingmachines/Inkling-2-Mini", "messages": [{"role": "user", "content": "Say hello."}], "max_completion_tokens": 20, "reasoning_effort": "none"}'
unset TINKER_API_KEY
```

6. In Vercel, set `LAB_TINKER_BASE_MODELS` for Production to the value below and redeploy. Keep `Qwen/Qwen3.5-4B` first: the first entry is the default for a request that names no model. This is the only step that lets a model choose it:

```
Qwen/Qwen3.5-4B,thinkingmachines/Inkling-2-Mini
```

To take it off again, set the variable back to `Qwen/Qwen3.5-4B` (or remove it) and redeploy. An adapter already trained on Inkling 2 Mini stays listed until it expires; its record keeps its base model, and the chat cost for it is still estimated at Inkling's prices.

**What a run on it costs.** At the same text sizes it is close to `Qwen/Qwen3.5-4B`, since training is the larger part and both are about $0.74 to $0.75 per million tokens: 200 two-line examples for 2 epochs set aside about 6 cents, a full 120000 bytes in a few hundred examples for 3 epochs about $0.39, and the most the limits allow at all, 2000 examples of 12 very short messages for 3 epochs, about $1.01, under the $2 a run may cost. Sampling and prefill are cheaper than on `Qwen/Qwen3.5-4B`, so a chat call costs less. All of these are estimates, as everywhere in Tinker.

**Not checked from the development machine, and so what these steps are the first real test of.** It cannot reach Tinker or Modal. What was checked: the runner parses on Python 3.9 and its tests pass with a stand-in for Tinker; the cookbook 0.7.1 and `tml-renderers` 0.4.2 sources were read, not run; the prices, the renderer name and the effort levels are from Tinker's published table and documentation. What was not: that the image builds with `tinker-cookbook==0.7.1` beside `tinker==0.39.1` and `transformers==5.23.0`; that `render_check` passes on the real tokenizer (the eight checks test that it agrees with itself and is the right family; only step 3 tests the tokens); that the model learns the made-up codes at effort 0.0; that Tinker's endpoint takes `"reasoning_effort": "none"` for an adapter and for the base id, and what it returns for Inkling's thinking (the chat endpoint part of the raw command is the first test of both); and the save with a time to live and the sampling for this model. Since 26 November 2026 the reading of answers has been run on the real tokenizer and renderer from the development machine, on the eight real answers of the probe; the chat endpoint part has only been run against a stand-in for HTTP. Keeping an adapter as a PEFT copy (`LAB_ENABLE_TINKER_KEEP`) reads the base model's repository on Hugging Face and converts with the cookbook's own `build_lora_adapter`; whether that works for Inkling 2 Mini is not known. If it does not, the keep fails with a reason in its record and the adapter stays on Tinker until it expires. I run `python modal/tinker_smoke.py keep --model thinkingmachines/Inkling-2-Mini` (same command prefix as above) once before I rely on it.

## Tinker RL

Tinker RL is on by default. `LAB_ENABLE_TINKER_RL` is on unless it is `false`, `0`, `off` or `no` (any capitals). It needs the same things Tinker training needs, apart from that switch: `TINKER_JOBS_START_URL`, `TINKER_JOBS_STATUS_URL` and `TINKER_JOBS_TOKEN`, a base model on `LAB_TINKER_BASE_MODELS`, and non-zero `LAB_TINKER_RUN_USD` and `LAB_TINKER_DAILY_USD`. It uses those two caps, so training and RL share one daily amount. If one of them is missing the tool is off and says which one: the server logs a line starting `[Tools] Tinker RL is on by default and is off here:` once, and `GET /api/experiment` has `rl_practice.off_reason`. What it does, checks and records is in [TOOLS.md](TOOLS.md#tinker-rl).

What it adds to the environment, besides the switch:

- `LAB_TINKER_RL_PER_DAY` (default 2, 0 to 10): RL runs opened per UTC day. It counts apart from `LAB_TINKER_PER_DAY`, though both draw on the same dollars.

**Redeploy the runner.** RL is a new function in `modal/tinker_jobs.py` (`train_rl`), the start endpoint now accepts an `rl` job, and the status endpoint can say how far a run has got. So the file has to be deployed again before an RL run can work. From this repository:

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/tinker_jobs.py
```

The two endpoint URLs do not change, and the two Modal secrets are the ones already there (`oblab-tinker-auth` goes to `train`, `train_rl` and `keeper`, and since 25 November 2026 to `raw_probe`, which only my own Modal login can start, and nothing else). The first deploy rebuilds nothing big: `train_rl` uses the training image that is already built. It also keeps a second small Modal Dict, `oblab-tinker-progress`, of each run's latest progress record. It creates it the first time it is used; there is nothing to set up. If the Dict cannot be read or written, runs go on and the room just has no live view of them. Until the runner is redeployed, an RL request is refused by the runner with a reason, costs nothing, and the room shows the stored refusal.

**Smoke test, before any model relies on it.** This calls the deployed `train_rl` directly with my Modal login on a toy task set (16 tasks that ask for the name of a fruit, a rubric that gives half for a short answer and half for a name that starts with a letter from a to m, so the base model earns partial credit about half the time and some groups of answers differ), 4 steps of 2 tasks with 4 answers each, at most 40 tokens an answer. Its budget is 5 cents and the runner cannot pass it; at the published prices it should cost well under a cent, and it costs cents at the very most. The adapter it saves expires after an hour.

```
uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py rl
```

What I expect: `"status": "ok"`, `n_train` 13 and `n_holdout` 3 (16 tasks, 15% rounded up held out, at least 2), `steps_done` 4, one line per step with the mean reward and the share of answers at the best score, a line with the held-out score before and after (the runner measured both, with the rubric, on tasks it held out), the last progress record read back from the Dict, and a line saying how many steps trained the model (at least one: a step where every answer in every group scored the same trains nothing, and a run with no such step ends as an error and saves no adapter), and a `sampler_path` that starts with `tinker://`. Whether the reward goes up in four steps is not promised, and a run where it does not is still a pass: what I am checking is that every part ran and was measured. If it says `"status": "error"` with `"stage": "client"`, the Modal secret or the Tinker balance is the first thing to check. The result never contains the key. If the progress line says the record could not be read, the Dict is the thing to look at (`modal dict list`), and the room will not draw a run live until it works.

**Looking at it in the room.** The practice bench is between the crates and the Executor's desk. With no RL run on record it is dark and its plate says that nothing has been practised yet. After a run it shows the record: click it for the panel. While a run is going it follows the progress record and rests again when the runner has not written a new progress record for six minutes. Asking the runner again for a record the lab already has does not count as news, so a stuck runner cannot keep the bench moving. In the simulation (no experiment connected) it stays dark.

**Turning it off.** Set `LAB_ENABLE_TINKER_RL=false` in Vercel (Production) and redeploy. The tool then disappears from what the models are told, and a request for it is stored as not enabled. A run that is already going is still collected, settled and recorded, and its adapter stays until it expires. To stop all Tinker use, also unset `TINKER_JOBS_TOKEN`; the hourly collection only asks the runner and closes rows, and it keeps doing that while the address and token are set.

## The Socratic lesson

The Socratic lesson is on by default. `LAB_ENABLE_TINKER_TUTOR` is on unless it is `false`, `0`, `off` or `no` (any capitals). What it does, checks and records is in [TOOLS.md](TOOLS.md#the-socratic-lesson). It needs no new Modal deploy and no new secret: the training leg is a `train` job that the runner already runs, the small model's answers go through the same Tinker endpoint the visitor chat uses, and the teacher is an ordinary OpenRouter call. It does need the same things Tinker training needs apart from that switch: `TINKER_JOBS_START_URL`, `TINKER_JOBS_STATUS_URL`, `TINKER_JOBS_TOKEN`, `TINKER_API_KEY` on the server, a base model on `LAB_TINKER_BASE_MODELS`, and non-zero `LAB_TINKER_RUN_USD` and `LAB_TINKER_DAILY_USD`. If one of them is missing the tool is off and says which one: the server logs a line starting `[Tools] the Socratic lesson is on by default and is off here:` once per reason (and nothing when I switched it off on purpose), and `GET /api/experiment` has `tutor_lesson.off_reason`. **Because it is on by default, it is live as soon as this code is deployed to a place where all of that is set. To deploy dark, set `LAB_ENABLE_TINKER_TUTOR=false` in Vercel before the first deploy.**

| Variable | Default | What it does |
|---|---|---|
| `LAB_ENABLE_TINKER_TUTOR` | on | The switch. Off only for `false`, `0`, `off` or `no`. |
| `LAB_TINKER_TUTOR_PER_DAY` | 1 | Lessons a UTC day, 0 to 5. A lesson counts unless it was refused before any call was sent at no cost. It counts apart from `LAB_TINKER_PER_DAY` and `LAB_TINKER_RL_PER_DAY`, though all three draw on the same dollars and an epoch has one Tinker run of any kind. |
| `LAB_TUTOR_TEACHER_USD` | 1 | The most one lesson's teacher calls may cost, in OpenRouter's reported dollars. Hard ceiling 3. 0 turns the tool off. Counted in `LAB_DAILY_BUDGET_USD`. |
| `LAB_TUTOR_TEACHER_MODEL` | empty | One fixed teacher, an OpenRouter id the lab knows a price for (the five in the rotation, the two fallbacks, the two wildcards). Empty: the model that answered as Executor in that epoch teaches. A value the lab does not know turns the tool off with that reason. |

The Tinker part of a lesson uses `LAB_TINKER_RUN_USD` (default $2, the most one lesson's Tinker use may be estimated at) and `LAB_TINKER_DAILY_USD` (default $10 a UTC day), shared with training and RL. A large two round lesson is refused at $2; I raise the run cap only if I want those. With the defaults one lesson counts for at most about $3 of a $15 day ($2 Tinker, $1 teacher).

**When `LAB_DAILY_BUDGET_USD` sees a lesson.** The teacher's calls reach the ledger as each one answers. The Tinker part reaches it once, as one `tool/tinker_tutor` row written by the statement that closes the lesson, as every Tinker training run's does. So while a lesson runs (up to 6 hours), the daily budget check does not count its open Tinker reservation, and other work can spend the day meanwhile; and a lesson that closes after 00:00 UTC is charged to the new day. The Tinker caps hold the whole reservation from the start. I have left this as it is for every Tinker run; if it matters, the fix is to count `tinker_spend_days.reserved_usd` in the daily check.

**The lessons-per-day count** is held by one conditional statement on `tutor_day_slots` (one row a UTC day, with the time a place was last taken), so two epochs that run at the same time (the classic and the research experiment) cannot both take the last place. A lesson refused before any call was sent gives its place back.

**A request that dies while a lesson is being opened.** Opening is four statements: the day's place, the Tinker money set aside, the run row, and the lesson row with its question hashes (one statement, so a lesson row never exists without its hashes). A request that dies between them leaves something behind, and the cron route repairs two of the three cases at the start of each call, once what it finds is older than a lease (14 minutes, longer than a request can live):

- a place taken with no lesson for it: the day's places are set back to the number of its lessons (rows in `tutor_lessons` for that day), so another lesson can run that day;
- a run row of a lesson (`kind` `tutor`, `status` `lesson`) with no row in `tutor_lessons`: it is closed as `failed` at no cost with the reason `the lesson was never opened: the request that asked for it stopped first, so nothing was sent`, the Tinker money it set aside is given back under its day, and a `tool_runs` row (`tinker_tutor`, `failed`, no cost) is written for it unless the epoch already has one.

The third case is not repaired: the request died after the Tinker money was set aside and before the run row was written. Then `tinker_spend_days.reserved_usd` for that day holds an amount no run row accounts for, at most `LAB_TINKER_RUN_USD`, and the day's Tinker cap has that much less room until 00:00 UTC. Every Tinker run opens this way (set aside, then the row), so this is not new with lessons. To see it: `SELECT d.day, d.reserved_usd, (SELECT COALESCE(SUM(reserved_usd), 0) FROM tinker_runs r WHERE r.spend_day = d.day AND r.finished_at IS NULL) AS open_runs FROM tinker_spend_days d WHERE d.scope = 'all' ORDER BY d.day DESC LIMIT 3`. When `reserved_usd` is above `open_runs` and nothing is opening, the difference is such a leftover; it goes away with the day.

**The cron entry.** `vercel.json` now has a second cron: `/api/epoch/lesson` every 10 minutes, and gives the function `maxDuration` 800 (each call works for up to 700 seconds). It is a new function, so the project now has 26 in all (the four new routes are `api/epoch/lesson.ts`, `api/experiment/lesson.ts`, `api/experiment/chat-offer.ts` and `api/experiment/visitor-offers.ts`); I check that this fits my Vercel plan before I deploy. Like the tick it takes `CRON_SECRET` only, and answers 401 to anything else before it reads anything. With no open lesson a call makes three statements: the two repairs above and one read. Without this entry a lesson only gets its first slice, in the epoch's follow-up, and then waits; the page shows it as not live and it is closed after 6 hours. After deploying, I confirm the second entry appears under the project's Cron Jobs.

**Reading a lesson, and a stuck one.**

- `GET /api/experiment` has `tutor_lesson`. For an open lesson look at `lesson.stage` (`diagnostic`, `teaching`, `training`, `retest`, `closing`, `done`), `lesson.round`, `lesson.live` (true while the progress record is under 15 minutes old), `lesson.progress` (`graded` of `to_grade`, `taught` of `to_teach`, `seq` and `updated_at`) and `lesson.cost`. Slices are 10 minutes apart and `live` allows 15, so a healthy lesson stays live between slices: `live: false` on an open lesson means no slice has written progress for 15 minutes, which is the first sign that the cron is not running. `GET /api/experiment/lesson?slug=<slug>` has the record and its rubrics, and `&subskill=<n>` the questions, answers and turns of one subskill.
- A lesson whose `progress.updated_at` is older than about 25 minutes while its stage is not `done` is stuck. The usual causes: the cron entry is missing or failing (look at the Cron Jobs log for `/api/epoch/lesson`), `CRON_SECRET` is wrong, the runner or Tinker is not answering (the lesson waits and retries each slice), or a request died and its lease (14 minutes) has not run out yet. A call that fails is tried again in a later slice up to 3 times and then stored as no answer; more than 10% of any test unanswered fails the lesson.
- In the database: `SELECT slug, stage, round, lease_until, teacher_calls, teacher_usd, teacher_reserved_usd, teacher_cap_usd, stop_reason, progress->>'updated_at' AS last FROM tutor_lessons ORDER BY created_at DESC LIMIT 5`. A `teacher_reserved_usd` above 0 with a `lease_until` in the past is a reservation left by a request that died; the next slice sets it to 0 in the statement that takes the lease (with `lease_until` NULL the lease was given back in order and the amount is kept). A turn in `tutor_turns` with `state` `calling` is a teacher call such a request had marked as sent: the next slice settles it first, at the most it could have cost, on the lesson and as an `estimate` row on the ledger, and never sends it again. `stop_reason` holds the first reason teaching stopped: the teacher's cap, the lab's daily budget, the day's spend could not be read, the teacher has no known price or takes no output limit, the teacher was called as many times as a lesson allows, three truncated teacher answers, a teacher call that cost more than its worst case, a call to the small model reported at more than its worst case, the Tinker money set aside does not cover another call and what training and the retest need, or 3 hours since the lesson opened. The same column also holds why a second round did not run or did not finish (`round 2 did not run: ...`, `round 2 did not finish: ...`), which is not about teaching.
- To move one now, I call the route by hand (the secret is read without echo and is not left in the shell):

```
read -s CRON_SECRET
HOST='https://...my deployment...'
curl -sS "$HOST/api/epoch/lesson" -H "Authorization: Bearer $CRON_SECRET"
unset CRON_SECRET
```

It answers `{ "lessons": [ { "slug", "stage", "status" } ] }`. A lesson another request holds the lease on is listed as `running` and left alone.

**Stopping a lesson.** Teaching ends by itself 3 hours after the lesson opened and any lesson still open after 6 hours is closed (`ok` if a retest finished, otherwise `failed`) with its money settled. **There is no stop button.** Setting `LAB_ENABLE_TINKER_TUTOR=false` stops new lessons and removes the tool from the prompts, but an open lesson is still carried on and settled while `TINKER_JOBS_*` and `TINKER_API_KEY` are set, as an open Tinker run is. To make the worker stop calling anything, I unset `TINKER_JOBS_TOKEN` (or `TINKER_API_KEY`) as well and redeploy: from then on the cron route makes no model or runner call, and it closes any lesson that is more than 6 hours old as `failed` with the reason `the lesson was left open and the tool is off`, settling its reservation. A lesson younger than 6 hours stays open until it reaches that age. If I need one gone sooner, that is a manual database change that I have not written down because I have not tried it.

**What I check after the first lesson.**

1. `GET /api/experiment` has `tutor_lesson` with a lesson, and the chart on the wall above the practice bench shows its topic and rows. The lamp is lit only while the lesson is live.
2. `lesson.questions` and `lesson.subskills` match what the Executor wrote (the counts, the subskill names), and `lesson.cost` has two figures: the Tinker estimate (labelled an estimate) and the teacher's cost as OpenRouter reported it.
3. The `tool_runs` row for tool `tinker_tutor`, and the ledger rows `tool/tinker_tutor` and, for the teacher, the model's own rows under purpose `tinker_tutor`.
4. No teacher call carried a held back question. This is tested against a fake; to look at a real lesson I read `tutor_turns.teacher_text` and compare it with the held back questions in the request.
5. The adapter appears in "Talk to what they trained" with a skill map card, and the held out loss is stored.
6. Once, before the first lesson, that Tinker's endpoint answers for the untrained base model: the chat's "Compare With Untrained" makes the same call. If it does not, a lesson does not fail at its first call. Every question is tried in three slices, so it fails in its third slice, about 20 minutes later by cron, with the reason stored. That costs nothing when Tinker answers with an error; a call that times out is charged its worst case. And the lesson keeps that day's place, so with the default of 1 no other lesson runs that UTC day.

**Not checked from the development machine.** It cannot reach Tinker, Modal or OpenRouter, so no lesson has run for real. Everything ran against fakes: the whole lesson loop (the tests drive `runTinkerTutor` and the stage machine with a fake Tinker endpoint, a fake OpenRouter and a fake runner), the request checks, the money and its reservations, the public record and the chart and panel (the page was read from stubbed `/api` routes). What only a real deployment proves:

- that the SQL runs on the deployed Postgres. In the second check of this code the lesson's statements were run on a throwaway local PostgreSQL 16 by the checker, and the ones added after it (the repair of an interrupted opening, the settling of a lost teacher call with its ledger row, the day's place with its time, a turn's cut off marks) by the fix. None of it has run on the provider's database behind `@vercel/postgres`;
- that Tinker's endpoint answers for an untrained base model and for an adapter with the `reasoning_effort` the base model needs (the lesson passes the base model with the adapter so the same form is used for both);
- that each teacher model accepts the request the lab builds (JSON mode, an exact output limit, the lowest reasoning effort it lists) and that a real call's cost stays under the lab's worst case;
- that a whole lesson goes from the Reviewer's approval through every stage to its closing: the epoch path was tested up to a refusal, and the lesson itself was tested directly;
- that Vercel's cron runs the entry every 10 minutes and honours `maxDuration` 800;
- that the runner's training leg works for examples with up to 10 messages (the limit is 12);
- how the room looks with a real record: the chart and panel were drawn from records I wrote by hand, and the draw call figures are from a development build with nothing connected.

I have not run a lesson, so I do not know whether one teaches a model anything. The pass bands are counts of answers that met rules a model wrote.

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

**Things I know are not checked from the development machine.** It cannot reach Modal or Tinker, so no adapter has been kept for real. What was checked: the runner file parses on Python 3.9 (it is deployed on 3.12); the SDK calls the keeper makes (`set_checkpoint_ttl_from_tinker_path`, `get_external_weights_urls`, `list_user_checkpoints`, `save_weights_external`) match the signatures of the installed `tinker` 0.39.1 and Tinker's documentation as I read it on 18 November 2026; the reading of the base model's config and safetensors headers ran against the real Hugging Face repositories of all three base models (a second or two, about 100 KB on disk for the 4B model, instead of 9 GB); and the cookbook's real `build_lora_adapter` 0.6.1 converted an adapter I made up, with the weight names I believe Tinker uses, against those headers. What step 2 is the first real test of: that Tinker saves external weights for my account at all, what files that export really holds and how its weights are named, the signed download, the conversion of a real export, the Volume mount and its commit, and the time to live being changed on a sampler checkpoint. Not checked anywhere yet: that the stub files the conversion reads (the real length with only the header written) take no room in a Modal container the way they do on my machine. If they did take room the conversion would fail and the copy would be stored as Tinker exported it, with the reason. I have also not loaded a kept copy into `peft` or vLLM, and whether `list_user_checkpoints` counts the whole organisation or only my key's user is not something the documentation settles, so I read the stored number as "at least".

**Turning it off.** Set `LAB_ENABLE_TINKER_KEEP` to anything but `true` and redeploy: the models are no longer told about it, `keep_adapter` is an unknown tool again, runs stop saving weights for download, and the operator route refuses a new keep. Adapters that are already kept stay kept and keep answering until their time runs out; they are listed in the chat in the ordinary order without the mark. A keep that was still going when I switched off keeps its place until the switch is on again, and so does a kept adapter that expires in the meantime; no money is tied to either. I can still unkeep through the operator route with the switch off. `LAB_ENABLE_TINKER_NAMES` turns off the same way: `name` is an unknown field again, and names already given are shown nowhere but stay in the database, so turning it back on shows them again. To empty the Volume: `modal volume rm -r oblab-kept-models <lab id>` for one adapter, or `modal volume delete oblab-kept-models` for all of it.

## Visitor offers

Visitors of the room can offer a conversation they had with a trained model to the lab. What it does, stores and checks is in [TOOLS.md](TOOLS.md#conversations-visitors-offer). It is on by default wherever the visitor chat is on: `LAB_ENABLE_VISITOR_OFFERS` is on unless it is `false`, `0`, `off` or `no` (any capitals). It also needs `LAB_OPERATOR_SECRET`, at least 32 characters long: the operator route below opens with that secret and nothing else, and receipts are signed with a key derived from it (and from nothing else; there is no `CRON_SECRET` and no database URL fallback). **Without `LAB_OPERATOR_SECRET` at that length offers are off, even when `CRON_SECRET` is set**, because I could not read or delete what visitors gave: `GET /api/experiment` reports them off, the chat answers exactly as it did before (no offers block, so no Offer button, and no receipt), `POST /api/experiment/chat-offer` answers 503 `off` without storing or counting anything, and the models are told nothing about offers. `visitorOffersStatus()` gives the reason: `LAB_OPERATOR_SECRET is not set with at least 32 characters, so the owner could not read or delete an offer and no receipt can be issued`. **The secret must also be stored exactly as I send it.** The operator route compares the header with the stored value as it is, and a header loses a space or a line break at its end on the way, so a secret pasted into Vercel with a trailing line break or space answers 401 to every request I can send. The same holds for a character outside plain ASCII, and a space at the start opens only for a header with that extra space in it. Offers are off for such a secret, and the reason then reads `LAB_OPERATOR_SECRET is stored with a space or a line break at an end, or with a character a request header cannot carry, so the owner could not read or delete an offer and no receipt can be issued`. A space inside the secret is fine. If I remove or shorten the secret later, offers go off at once; a take back with a code and the hourly deletion of expired text keep working for what is already stored, and the delete commands below work again when the secret is back. Every chat reply hands the visitor a receipt, a keyed hash, so a guess of the secret can be tested against one receipt offline: the secret must be long and random. **To deploy dark, set `LAB_ENABLE_VISITOR_OFFERS=false` in Vercel before the first deploy.** No Modal deploy and no new secret: the runner is sent a normal training job.

| Variable | Default | What it does |
|---|---|---|
| `LAB_ENABLE_VISITOR_OFFERS` | on | The switch. Off only for `false`, `0`, `off` or `no`. |
| `LAB_VISITOR_OFFERS_DAYS` | 180 | Days an offer is kept after the end of the day it was made, 30 to 365. Then its text is deleted. |
| `LAB_VISITOR_OFFERS_MAX` | 2000 | Offers stored at one time, hard 20000. When full, new offers get 429 `full`. |
| `LAB_VISITOR_OFFERS_PER_DAY` | 100 | Offers accepted a UTC day from everyone, 0 to 1000. 0 takes none (the route answers 429 `full`); `LAB_ENABLE_VISITOR_OFFERS=false` is the off switch. |
| `LAB_TRAINED_CHAT_VISITOR_ADAPTERS` | false | Exactly `true` lets the visitor chat list and answer for an adapter trained on visitor offers. Off, such an adapter is not listed and a message to it is refused. The lab model endpoint (`LAB_ENABLE_LIVE_TRAINED`, behind a scoped key) is not the visitor chat and does not read this switch: it lists and serves such an adapter, and its description says it was trained on conversations written by visitors. I leave it off: no model read that text and nobody reviewed it. |

The limits that have no variable: 3 offers a day for a visitor (an address with a browser string) and 6 for an address, 20 a day for one adapter, one stored offer for each (adapter, first visitor message), 10 take back tries a day for an address. The all-offers and per-adapter day caps are counted in `visitor_offer_caps` (a day, a name and a count, no time); the hourly prune deletes rows older than two days. They are in `api/_lib/visitor-offers.ts`.

**What happens by itself.** The hourly tick deletes the text of offers past their days and leaves the row as a count, deletes day cap rows older than two days, and then runs `VACUUM FULL visitor_offers`, so that text set to NULL (taken back, deleted or expired) also leaves the table's files within the hour. A plain `VACUUM` does not do that: it only marks the space of the old row version as free, and the bytes stay readable in the file until a later row is written over them. On a local PostgreSQL 16 the text of 10 of 12 deleted conversations was still in the table's file after a plain `VACUUM`, and of 0 of 12 after `VACUUM FULL`, which writes the live rows into a new file and drops the old one. It holds a lock on this one table while it runs (a moment, for a table this small), and an offer or a take back made in that moment waits for it. It also writes the whole table to the write ahead log each hour, which counts toward the provider's history size. If the database refuses the statement the tick logs `[visitor-offers] could not rewrite the offers table; deleted text stays in its file until new rows are written over it` and goes on. I ran that statement on a throwaway local PostgreSQL 16 through the `@vercel/postgres` pool, and not on the provider's database, so after the first tick I look for that line in the log. The database's own history (write ahead log, point in time restore) and the blocks of the dropped file can hold deleted text for as long as the provider keeps them, and nothing here reaches them; in my local test the write ahead log still held it. An offer past its expiry is not read, claimed or counted even if a tick is missed: every read carries `expires_at > NOW()`. The tick runs whether offers are on or off, so the deletion holds after I switch them off. On a lab that never had offers it creates `visitor_offers` and `visitor_offer_caps`, both empty, and, where they are missing, the Tinker and chat tables they sit beside (`tinker_runs`, `tinker_spend_days`, `trained_chat_rate`, `trained_chat_calls`) with their indexes. A `visitor_offers` table made before the size columns were dropped loses `turns` and `chars` the first time the tables are made ready. The tables are created on first use otherwise.

**The operator route.** `POST /api/experiment/visitor-offers`, `Authorization: Bearer <LAB_OPERATOR_SECRET>`. With no `LAB_OPERATOR_SECRET` of at least 32 characters it answers 503 `Operator access is not configured` (`CRON_SECRET` does not open it), and in that state offers are off, so nothing new is stored that I could not delete; with one, any other bearer gets 401. If my own bearer gets 401, I look at how the secret is stored: a line break or a space at its end does that, and offers are off while it is so (see above). Both come before anything is read. It works whether the offers switch is on or off. It is a POST, even for a read, and has no GET, so a prefetch or a cache cannot count as a read. **Every read sets `read_at` on each row it returns, and the public record counts those rows (`read_by_owner`).** I read only when I need to.

```
read -s LAB_OPERATOR_SECRET
HOST='https://...my deployment...'
# Read up to 20 stored offers, newest day first. This counts as a read of each one.
curl -sS -X POST "$HOST/api/experiment/visitor-offers" -H "Authorization: Bearer $LAB_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' -d '{"action": "read", "limit": 20}'
# The next page: offers from days before this one.
curl -sS -X POST "$HOST/api/experiment/visitor-offers" -H "Authorization: Bearer $LAB_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' -d '{"action": "read", "limit": 20, "before": "2026-11-20"}'
# Delete one offer's text. The id is the one the read returned.
curl -sS -X POST "$HOST/api/experiment/visitor-offers?confirm=true" -H "Authorization: Bearer $LAB_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' -d '{"action": "delete", "id": "00000000-0000-0000-0000-000000000000"}'
unset LAB_OPERATOR_SECRET
```

A read answers `{ offers, count }`, each offer with its id, day, adapter, base model, messages, status, which runs claimed it, `read_at` and expiry. `delete` and `delete_all` need `?confirm=true` and answer `{ deleted: n }`.

**Deleting everything.** Delete the text of every offer, now:

```
read -s LAB_OPERATOR_SECRET
HOST='https://...my deployment...'
curl -sS -X POST "$HOST/api/experiment/visitor-offers?confirm=true" -H "Authorization: Bearer $LAB_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' -d '{"action": "delete_all"}'
unset LAB_OPERATOR_SECRET
```

It sets the text to NULL and the status to `deleted` on every row that still has text, and leaves the rows as counts. To remove the rows as well I drop the table (`DROP TABLE visitor_offers`), which also removes the take back codes' hashes, so nobody can take an offer back afterwards (there is nothing left to take back). To stop new offers I also set `LAB_ENABLE_VISITOR_OFFERS=false`. Deleting does not reach what has left the lab: a run that claimed an offer may already have sent it to the training runner, and a model trained on it cannot unlearn it. Which runs claimed an offer is in its `used_in` column; the run's own row has `dataset_source`, with counts only.

**A claim left behind.** When a run on offers is being set up, the offers it will read are marked with a temporary `claim-<salt>` token in `used_in`, and that is replaced with the run's slug once the job has been sent, or removed if the job is never started. If the function dies in between, the token stays. A take back of such an offer then answers `trained_on: true`, which errs on the safe side. Nothing cleans these tokens.

**If I want to know what a visitor will see.** I read the sheet once as a visitor on a phone, with offers on and a conversation with a trained model: the consent text, the number of days it names (it comes from `LAB_VISITOR_OFFERS_DAYS`), the code after offering and the take back form in the shelf's footer. I also decide whether the room needs a privacy line elsewhere, because the lab now stores text a person wrote.

**What the checks do not do.** The automatic screening refuses a conversation with an email address, a long number, a link, a user name, too little text, repeated text, or a model that mostly repeated the visitor. It does not understand meaning, so it does not find names, street addresses written in words, other private details or abuse. No model reads an offer. If something private or abusive gets in, the only people who can see it are me through this route, and the services that receive a training run on it. The consent text says so and asks visitors not to offer anything private.

**The logs.** The lab's own code writes no message text to the Vercel logs: the offer and operator routes log fixed sentences only, and a test captures everything the lab's code logs through a full offer and a full run on offers and checks that no offered text is in it. I read the runner, `modal/tinker_jobs.py`, for lines that print example text and found none: its log lines print numbers, counts, step losses or an exception passed through `scrub()`. One thing I could not rule out on the runner's side: when a training job raises, the last 300 characters of the exception become the run's `error`, and Tinker's tokenizer could quote an input in its message. So the lab does not keep the runner's free text for a run on offers: a failure is stored with the fixed reason "the runner failed; its message is not shown for runs on visitor conversations", an export error with a fixed sentence, the note on an early stop only when it is one of the runner's own three limit sentences, and the stage only when it is one of the runner's stage names. Tests feed a fake runner answer that quotes a message in each of those fields and check that none of it reaches the run row or the tool run. The runner's own log on Modal is not changed by this.

**Not checked from the development machine.** Everything ran against fakes: the receipts, the screening, the limits, the claim and release SQL (in the tests a small in-memory fake of the database; in the second check the offer statements, the expiry condition, the dropping of the old size columns and the hourly `VACUUM FULL` were also run on a throwaway local PostgreSQL 16, not on the provider's database), a complete run on offers through the epoch (it asks the fake runner for 0 samples and nothing offered appears in the run row, the tool run, the adapter, the outcome or the logs), and the sheet and the take back form in a browser from stubbed routes. What only a real deployment proves: that the runner really takes `samples: 0` (its validation allows 0 to its maximum; I read it, I did not run it); that a real chat reply gets a receipt that a real offer verifies, end to end; that the take back code is accepted from a phone's keyboard; and how the consent sheet reads on my own phone. Whether anyone will offer anything, and what they will write, I do not know.

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

## Scoring research results

Two switches, both default false, and neither needs anything deployed on Modal: this change does not touch `modal/research_runner.py` or any other Modal file, so I redeploy nothing there. What each does and why is in the README, under "How the lab scores results".

| Variable | Default | What it is |
|---|---|---|
| `LAB_RESEARCH_CONFIRM` | false | The switch for the research loop: repeat a run before it becomes the best, and measure the noise. |
| `LAB_RESEARCH_MIN_MARGIN` | 0.002 | The least a new best has to beat the old one by, in val_bpb, 0 to 1. It is the whole margin until the noise is measured. |
| `LAB_RESEARCH_MAX_MARGIN` | 0.05 | The most the margin may ever be, in val_bpb, 0 to 1. A value below the floor counts as the floor. |
| `LAB_RESEARCH_CONTROL_EVERY` | 10 | The most research epochs between two control runs, 1 to 1000. |
| `LAB_TINKER_ORIGIN_LABELS` | false | The switch for the data origin labels on Tinker runs and adapters. |

With both off nothing changes: the research epoch sends the same requests and statements as before, the prompts are the same, `results.tsv` keeps its header, the adapter lists have no new field, and `/api/experiment/scoring` says both are off without reading the database.

### Confirm before best (`LAB_RESEARCH_CONFIRM`)

**What happens in an epoch.** Planner, Executor, the GPU run, Challenger and Reviewer are as before. Then, only when the Reviewer said keep and the run's `val_bpb` is below the best:

1. The lab checks the day's cap again (`LAB_RESEARCH_DAILY_BUDGET_USD` beside run 2, `LAB_DAILY_BUDGET_USD` otherwise), because the epoch's own run may have used up what was left when the tick began. If the cap is reached, or the spend ledger cannot be read, no repeat is started. The candidate is not thrown away: the epoch stops there with the Reviewer's keep stored, the tick answers `Skipped: research daily budget reached` (`Skipped: daily budget reached` when research is not beside run 2) like any budget pause, and the same epoch repeats the run when the cap resets at midnight UTC.
2. It starts the same `train.py` again through `RESEARCH_RUNNER_START_URL`, with the same budget and no key. With `LAB_ENABLE_RESEARCH_TALK` on, the epoch's own run was started with a key and so had the runner's save step (`runner_flow keep-1`); the repeat does not, and the verdict line ends with `the first run had the runner's save step (runner_flow keep-1) and the lab's repeat did not`. Its row goes into the new table `research_repeats` before the runner is asked (status `starting`, no call id), and the call id is written on it as soon as the runner hands it back. It is not started later than 680 s into the request, counted from when the tick or the manual route began, so the start and the write of its call id fit in the function's time; past that the epoch answers like a run still in progress and the next tick starts the repeat early in its request.
3. It waits for the result while the request has time: never past 410 s into the request (the function's 800 s, less one Commentator call at its full `OPENROUTER_TIMEOUT_MS`, 240 s unless I set it, less 150 s for the repository and database writes), and never longer than `RESEARCH_RUN_POLL_MAX_MS`. The wait is counted from before the budget check and the start, so their time comes out of it. It asks the runner at least once however late it is. If the repeat is still training, the epoch answers `GPU run still in progress; resumes next tick`, exactly as it does for its own run, and the next hourly tick picks the same call up. So an epoch that finds a candidate for the best usually finishes one tick later than it used to. One epoch has one repeat row at most, and a row is never started a second time. If the runner answers a start with an HTTP error or without a call id, nothing was started: the row is removed and the next tick tries again. If it does not answer at all (a timeout, a broken connection), or the function is stopped before the call id is written, the run may have been started and nothing can ask about it: the row stays `starting`, and once the request that wrote it is certainly over (860 s) the next epoch closes it as `lost`, charged at the full estimate, and the candidate is `not_confirmed`.
4. Only the runner's own answer ends a repeat. If the status endpoint answers with an HTTP error or not at all (a 502 while the Modal endpoint restarts, say), the lab knows nothing about the run, so it counts as still training and is asked about again at the next tick. A repeat that is still unanswered three hours after it started is given up as `lost`.
5. The verdict is worked out: `confirmed` when the mean of the two scores beats the best by more than the margin, `within_noise` when it does not, `not_confirmed` when the repeat gave no score (it crashed, the runner says the call failed, or it was lost). The margin is `max(2 x noise, LAB_RESEARCH_MIN_MARGIN)`, never more than `LAB_RESEARCH_MAX_MARGIN`, and the noise counts only once at least three repeated scores exist. The noise used here leaves out the pair being judged, so a `train.py` cannot lower its own bar by printing the same number twice; the verdict line says `not counting this run's own two scores`, and the pair counts for later epochs. "More than" is decided at four decimal places, the precision the record shows, so the two numbers in the recorded line are the two that were compared.
6. The verdict, with every number it used, is stored on the epoch's row as `research_run.confirm`. When it is not `confirmed`, the Reviewer's stored verdict is changed to `revert` and its reason gets a note that starts `[LAB: keep not taken.`, the same way the lab already overturns a keep whose score did not beat the best.
7. A confirmed run is committed as before, and the best is recorded as the mean of the two runs (`best_bpb` in the spec, and the capability's description says "mean of two runs"). The commit message of `train.py` names the repeat and the mean.

**Control runs.** After an epoch has finished, the lab may start one more run of the `train.py` that holds the best score, unchanged. It does this after the first three research epochs with the switch on, so the noise is measured within about three epochs, and after that when `LAB_RESEARCH_CONTROL_EVERY` epochs have passed since the last one. Never two for one epoch, and none while one is still running, so a tick starts one at most. None is started once the day's cap is reached (`LAB_RESEARCH_DAILY_BUDGET_USD` beside run 2, `LAB_DAILY_BUDGET_USD` otherwise). I start it at the end of the epoch on purpose: the runner trains one run at a time (`max_containers=1`), and a control started earlier would make the epoch's own run wait. It is not started later than 680 s into a request either, counted from when the tick began (time spent collecting Tinker runs counts), so that starting it and writing its call id fit in the function's time; a control skipped for that is tried after the next epoch. Its row is written before the runner is asked, as for a confirmation, and one whose call id was never written is closed as `lost` at the full estimate by the next epoch. The next research epoch asks the runner for the result once, at its start. A control whose call the runner says failed or no longer has, or that is still unanswered three hours after it started, is closed as `lost`. A status endpoint that cannot be read closes nothing: the control stays open, no second one is started beside it, and the next epoch asks again. If I run research epochs back to back by hand (`POST /api/epoch/run?mode=research`), the next epoch's run may queue behind a control for a few minutes.

**The noise.** Scores are grouped by the SHA-256 of the `train.py` that printed them, over the newest 30 finished repeats. A confirmation gives its group two scores, a control one. Groups with one score say nothing and are left out. Each group gives one spread: the median distance of its scores from the group's own middle score, times a factor for the group's size that turns it into a standard deviation (for a pair, 2 x 1.0483, so a pair counts as half its distance times 2 x 1.0483, exactly as before; for 3 to 10 scores, factors from a simulation of normal scores; above that 1.4826 x (1 + 1.2 / k)). The noise is the median of those spreads, each counted once for every score in its group, so every run counts once. A confirmation pair is picked because its first run was low, so pairs make the estimate a little larger than controls alone would; that errs toward not keeping.

**Why a median and a ceiling.** Every score the noise is measured from is printed by a `train.py` the models wrote. With a pooled variance, one pair far apart (a file that prints a random number, or a run that diverged inside the time budget) would have set the margin to several val_bpb for dozens of epochs, and no real improvement could have become the best. With a median of spreads, one wild pair is one spread among the others, and one wild score among three or more controls of the best file (a control that diverged) is one distance from that file's middle among the others, so it does not set the file's spread. (When the noise was the median of the distances between every two scores of a file, one wild control out of three was in two of the three distances and set the margin to the ceiling.) If wild pairs ever outnumber the quiet ones, the ceiling holds: the margin is never above `LAB_RESEARCH_MAX_MARGIN`. When that happens the verdict line says `margin: the ceiling of 0.0500, because twice the measured noise of ... is above it`, the stored verdict has `margin_basis: "ceiling"`, and `/api/experiment/scoring` shows `"margin_basis": "ceiling"`. If I see that, I look at `lab-repeats.tsv` for the file whose two scores are far apart.

**What it costs.** Each repeat is one GPU run of `RESEARCH_BUDGET_S`, about seven minutes and about 13 cents at my GPU rate. There is at most one confirmation and one control per research epoch. Neither is started once the day's cap is reached. Their GPU time is written to the spend ledger as `tool/research_gpu_repeat` and `tool/research_gpu_control`, the same estimate as the epoch's own run and under the same condition: only while `LAB_RESEARCH_ALONGSIDE` is on, where it counts under `LAB_RESEARCH_DAILY_BUDGET_USD`. A repeat or control that is still open is not on the ledger yet, so whenever the lab decides whether it may start a repeat, a control, or an epoch's own run while one of them is open, it counts each open one at the full estimate (`RESEARCH_BUDGET_S` plus 180 s at the GPU rate); three runs can no longer be in flight under a cap that has room for one. With research not running alongside, the lab records no GPU time at all, for epochs or for repeats, as before. A control's cost is written when its result is collected, at the start of the next research epoch.

**Database.** One table, made the first time a research epoch runs with the switch on: `research_repeats` (`experiment_id`, `epoch_number`, `kind` confirm or control, `train_sha256`, `reference_bpb`, `reference_epoch`, `call_id`, `status` (`starting`, `running`, then `ok`, `crash`, `infra_error` or `lost`), `val_bpb`, `result`, `cost_usd`, `ledger_written`, `finished_at`), with one confirmation and one control per epoch at most. Nothing is added to `epochs`: the verdict lives inside the `research_run` JSON an epoch already has. The research spec gains `meta.research.scoring` (noise, sample count, the margin with its floor, its ceiling and which of them it is, last verdict, last control) and `last_run.confirm`.

**The research repository.** `results.tsv` gets five more columns the first time a row is written with the switch on: `repeat_val_bpb`, `mean_val_bpb`, `noise_bpb`, `margin_bpb` and `confirm`. If the ledger did not have the `runner_flow` column yet it gets that too, so there is one new header, with nineteen columns. Earlier rows are not rewritten. A run that was not repeated has `-` in the five. The finding page of a repeated run gets a "Lab repeat" line. A new file, `lab-repeats.tsv`, gets one row per finished repeat (confirmations and controls), committed by me with no model as author, because no model wrote it. Its last column, `runner_flow`, is the repeat's own flow: `-`, because repeats are started without a key, even when the run it repeats has `keep-1` in its `results.tsv` row. A file written before that column existed gets the thirteen-column header the next time a row is added, and its earlier rows are left as they were.

**Public state.** `GET /api/experiment?mode=research` carries `current_spec.meta.research.scoring`, the `research` field of `GET /api/experiment` carries `scoring` once there is one, and `GET /api/experiment/scoring` gives the margin with its floor, its ceiling and which of them it is now (`margin_basis`), the noise with its sample count, the last verdict and the newest twelve repeats. None of them has a dollar amount.

**Vercel functions.** One new function, `api/experiment/scoring.ts` (the project now has 26; it needs no entry in `vercel.json`, because it only reads two tables and answers). It is public and read-only, like the other observer routes, and with both switches off it reads nothing.

**What I check after turning it on.**

- `curl -sS "$HOST/api/experiment/scoring"` says `"research": {"enabled": true, ...}` with `"noise_state": "noise not yet measured"` and `margin_bpb` equal to the floor.
- After the next research epoch: the tick's log has `control run of the best train.py started`, and `SELECT epoch_number, kind, status, val_bpb, reference_bpb, call_id FROM research_repeats ORDER BY id DESC LIMIT 10` shows a control that is `running`.
- After the epoch after that: the control is `ok` with a `val_bpb` near the best, `results.tsv` has the nineteen-column header, and `lab-repeats.tsv` exists in Research-Lab.
- After three controls: `noise_bpb` is a number and `noise_samples` is 3 or more. If twice that noise is far above the floor, the floor was too low for this model; if it is far below, the floor is what decides. `margin_basis` says which: `noise`, `floor`, or `ceiling`.
- The first time the Reviewer keeps a run: the log has `lab repeat started`, then on that tick or the next `lab repeat: confirmed: ...` or `within noise: ...`, the epoch's row has `research_run.confirm`, and the finding page has the "Lab repeat" line.

**What I have and have not run.** The arithmetic, the scheduling, the ledger columns and a whole research epoch with a repeat (confirmed, within noise, crashed, still training at the end of the wait, a status endpoint that answers 502, and a cap reached before the repeat) run in the tests against a fake runner, a fake GitHub and an in-memory database. I have not run it against the real runner on Modal, the real Postgres or the real research repository. Untested there: the `CREATE TABLE`, two runs queued on the runner one after another, and how large the real noise is. The first three controls are that test.

**Turning it off.** Set `LAB_RESEARCH_CONFIRM` to anything but `true` and redeploy. From the next epoch a run below the best is kept on one run again, the models are no longer told about repeats, and no control starts. I switch it off between research epochs: an epoch that was waiting for its repeat when the switch went off carries on with the Reviewer's verdict as stored. While the switch is off nothing collects a repeat or a control that was still running, so its 13 cents are not on the ledger. If I switch it on again, the next research epoch closes both kinds first, a control and a confirmation whose epoch ended without it, and writes their GPU time to the ledger then; one that is more than three hours old is closed as `lost` at the full estimate. `results.tsv` keeps the wider header and later rows have `-` in the five columns; the last `scoring` stays in the spec with the epoch it was written at. The table can stay.

### Data origin labels (`LAB_TINKER_ORIGIN_LABELS`)

With it on, every Tinker training run and adapter is labelled by where its examples came from: `written by the models` when a model wrote them into its request, or `public dataset <repository>@<commit>` when the lab read them from the dataset shelf. The label is worked out from the run's row (it has a stored `dataset_source` only for a shelf dataset, stored before anything is sent to the runner, and a run whose source could not be stored is closed without being started), so it covers the runs made before the switch too and needs no new column. It appears as `origin` on each adapter in `GET /api/experiment/trained-chat` and the operator's `GET /api/experiment/trained-adapters`; as a "Data origin" line under the adapter in the chat panel; at the end of the stored line of a training run in `tool_runs` and in its `detail.dataset.origin`; and as a summary in `GET /api/experiment/scoring`: for each origin, the number of runs that reached the runner, how many finished with both losses measured, and the median held-out loss before and after training, from the newest 500 runs. A row that was opened and closed before anything was sent to the runner (the runner said no, the dataset source could not be stored, the start was never confirmed) trained on nothing and is not counted under either origin. It changes nothing about what a model may train on, and whether a dataset adapter is offered in the visitor chat is still `LAB_TRAINED_CHAT_DATASET_ADAPTERS`.

To check: `curl -sS "$HOST/api/experiment/scoring"` has `"tinker_origin": {"enabled": true, "origins": [...]}` with two rows. With no training run yet both rows have `runs: 0`. To turn it off, set it to anything but `true` and redeploy; nothing was stored, so nothing is left behind.

## Model proposals to this repository

`LAB_ENABLE_LAB_PROPOSALS` (default false) lets a model propose a change to this repository. Proposals arrive as pull requests labelled `model-proposal`, authored by the model on `observable-lab.invalid`, using `LAB_PROPOSALS_GITHUB_TOKEN`: a separate fine-grained token for this one repository with Pull requests and Contents read/write only. Create the `model-proposal` label first. The lab never merges them. Review each like an outside contribution; see [SECURITY.md](../SECURITY.md).

## Rollout verification

Before enabling a deployment, verify that anonymous requests to operator routes return 401 (or 503 when unconfigured), that the scheduler accepts only its own credential, and that authorized work reaches the intended test environment. Check provider spend limits and the actual contents of public observer responses. Build and local regression tests do not verify deployed access controls.

The Modal images in `modal/research_runner.py` and `modal/app.py` use a digest-pinned `python:3.11.18-slim-bookworm` base and exact package versions. Rebuild and smoke-test after changing any of them. The dataset download in `modal/harness/prepare.py` uses `DATASET_REVISION` and `DATASET_SHA256`; real preparation refuses to download until both are set, and a pinned revision prepares into its own cache directory.

Smoke preparation uses `/cache/smoke`; research preparation uses `/cache/research`. Synthetic smoke bins cannot become the production dataset merely by existing first. Results record the dataset label and bundled harness hash; neither field independently validates the model-reported score.
