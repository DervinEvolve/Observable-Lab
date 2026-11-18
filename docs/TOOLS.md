# The tool menu

In a classic epoch the Executor may return an optional `tools` object next to its proposal. It chooses from what is switched on for this deployment, and the prompts list exactly those tools, generated from the same configuration the server uses (`api/_lib/tools-config.ts`, `api/_lib/prompts.ts`). A tool that is off is not mentioned to the models at all.

**Every tool is off unless its flag is `true` and what it needs is configured.** Each has a per-epoch limit (fixed) and a per-day limit (UTC, configurable), and everything a tool costs counts against `LAB_DAILY_BUDGET_USD`. Unknown or switched-off tools, malformed requests and requests over a limit are ignored, logged and stored as `skipped`; they never crash the epoch. A resumed epoch never runs a tool twice.

| Tool | Switch | Also needs | Per epoch | Per day (default) |
|---|---|---|---|---|
| `subagents` | `LAB_ENABLE_CODE_WRITES=true` | the contribution setup | 0 to 2 explorers and 0 or 1 test subagent | `LAB_SUBAGENTS_PER_DAY` (24) |
| `sprite_session` | `LAB_ENABLE_SPRITE_SESSIONS=true` | `SPRITES_TOKEN` | 1 session, up to 4 commands | `LAB_SPRITE_SESSIONS_PER_DAY` (8) |
| `gpu_job` | `LAB_ENABLE_GPU_JOBS=true` | `GPU_JOBS_START_URL`, `GPU_JOBS_STATUS_URL`, `GPU_JOBS_TOKEN` | 1 | `LAB_GPU_JOBS_PER_DAY` (4) |
| `weights` | `LAB_ENABLE_WEIGHTS=true` | GPU jobs switched on, and `modal/gpu_jobs.py` deployed from a version that has the fetcher | 1 | `LAB_WEIGHTS_PER_DAY` (2) |
| `exhibit` | `LAB_ENABLE_EXHIBITS=true` | `LAB_ENABLE_CODE_WRITES=true`, `AI_AGENT_GITHUB_TOKEN`, `AI_AGENT_GITHUB_OWNER`, `LAB_REQUIRED_CI_WORKFLOW_IDS` | 1 | `LAB_EXHIBITS_PER_DAY` (2) |
| `lab_proposal` | `LAB_ENABLE_LAB_PROPOSALS=true` | `LAB_PROPOSALS_GITHUB_TOKEN`, `LAB_PROPOSALS_GITHUB_OWNER` | 1 | `LAB_LAB_PROPOSALS_PER_DAY` (1) |

A Sprite session can also come with [the lab model endpoint](#the-lab-model-endpoint) (`LAB_ENABLE_LIVE_MODEL=true`). It is not a tool the Executor asks for, so it is not in this table.

Web search is not on this menu: the Planner and Executor calls, and the explorer subagents, already use OpenRouter's web plugin, as before.

## When each runs

- **Side tools** (`sprite_session`, `gpu_job`, `weights`) start as soon as the Executor has answered and run while the Challenger, the rebuttal and the Reviewer talk. The runner waits for them before the Commentator, who is given a one-line summary of each, built from the stored records. Weights asked for are fetched before that epoch's GPU job starts.
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

## The lab model endpoint

This is not a tool on the menu. It is something a Sprite session comes with when `LAB_ENABLE_LIVE_MODEL=true` (default off), so there is nothing for the Executor to ask for. I added it because the models were building a client for a hosted model and had no model to call. I did not want to hand them my OpenRouter key, so the lab is the host: it serves the endpoint and keeps the key.

While a Sprite session runs, its commands have four more variables: `LAB_MODEL_BASE_URL` and `LAB_MODEL_API_KEY`, and the same two values as `OPENAI_BASE_URL` and `OPENAI_API_KEY`. The base URL is `<origin>/api/live-model/v1`, and it answers two requests in the OpenAI shape:

- `POST <base>/chat/completions` returns one chat completion: `choices[0].message` with `content` and native `tool_calls` (`id`, `type: "function"`, `function.name`, and `function.arguments` always as a string), `finish_reason` and `usage`.
- `GET <base>/models` lists the models it answers for.

**What a request may contain.** The lab builds the request it sends on, field by field, from a short list: `model`, `messages`, `tools`, `tool_choice`, `max_tokens` or `max_completion_tokens` (never more than 4096), and `temperature` and `response_format` when the model's entry in the OpenRouter catalog lists them. Everything else is dropped before the request leaves the server. That is what keeps provider routing, plugins, transforms, fallback model lists and other people's keys out of a call I pay for. The names of dropped fields come back in the `X-Lab-Dropped-Fields` header. Messages are text only, at most 200 of them, and the whole request may be 256 KB. `"stream": true` is refused with a 400, because the endpoint is non-streaming only. The model must be one of `LAB_LIVE_MODEL_IDS` (default `google/gemini-3.8-flash`), spelled exactly. Any other model gets a 400 that names the ones allowed. Two kinds of id can never be on the list, even if I put them there, because they let OpenRouter change what is called: an id with a `:` suffix such as `:online`, and anything under `openrouter/` such as `openrouter/auto`, which picks a model by itself at a price I did not choose.

The body has to be sent with `Content-Type: application/json`. Vercel only reads a body as JSON when the header says so: with no header it reads nothing, and with the form type that Python's `urllib` adds by itself it turns the JSON into something else. Either way the request used to be refused with a message about the wrong thing. Now it gets a 415 that says to send the header, and no call is counted.

One thing travels inside a message besides its text and tool calls: `reasoning_details`. This is the list OpenRouter returns next to an assistant message, and for some models it is not optional. Gemini puts its thought signatures there, and as far as I know it refuses the next request of a tool loop if the assistant turn comes back without them. So the answer carries `reasoning_details` when the model returns them, and an assistant message may bring them back. Both ways the entries are rebuilt from the documented fields (`type`, `id`, `format`, `index`, `text`, `summary`, `data`, `signature`), at most 64 per message, and never cut, because a cut signature no longer verifies. Coming back from the model, the list stops at 128 KB. I have not run a two round tool loop against the real Gemini through this endpoint yet, so that it now passes is my reading of the documentation, not something I watched.

**The key.** A key is 256 random bits with `labk_` in front. The database holds only its SHA-256 hash, with the experiment, epoch, model and Sprite it was issued to. It ends when the session ends, and after 15 minutes at the latest. It allows 20 calls, one at a time, and $0.25. An expired, revoked or unknown key gets a 401 with a short reason. A key that has used its calls or its money, or that already has a call running, gets a 429.

The limits are held by the database. A call is let through by one conditional `UPDATE` that counts it, checks expiry, revocation and both limits, and takes the key's single in-flight slot, all in one statement. Two calls that arrive together cannot both get past a limit. Because only one call per key runs at a time, and what a call costs is only known once it is billed, the dollar limit can be passed by one call at most.

**Getting the key into the Sprite.** This is the one place where something shaped like a credential goes into a Sprite, so the exception is narrow and written down in `api/_lib/sprites.ts`. `execInSprite` has a separate option for it. That option only accepts a value in the scoped key format and an `https` base URL, and the ordinary environment option still refuses any name that looks like a key, these four included. The check that stops this server's own credentials from being sent still runs on every value. Output from the session has the key removed before it is stored.

Every other command the lab runs in a Sprite gets `CI=true`. A command that holds the key does not. The models are told the key is never present in CI, and code that keeps to its fixture whenever `CI` is set would otherwise never call the endpoint. A session that did not get a key runs with `CI=true` as before.

**Egress.** Sprites normally get the Sprites `defaults` policy and nothing else. For the length of a session with the endpoint on, the lab adds one rule that allows its own host, `{ "domain": "<host>", "action": "allow" }`, which is the format in the [Sprites networking documentation](https://docs.fly.io/sprites/concepts/networking). The order matters: the rule is applied first, the lab reads back that the Sprite has it, and only then is a key made. If the Sprite does not confirm the rule, no key is made and the session runs as it does with the endpoint off. When the session ends, the key is revoked and the policy goes back to `defaults`. The [API reference](https://docs.fly.io/sprites/api/network-policy/set-network-policy) documents that both setting and reading the policy answer with the same `{ "rules": [...] }` shape the code reads back. I have not watched this happen on a real Sprite yet.

Two limits of this. The policy works through DNS: a host that is not allowed does not resolve, and an address can be reached only if an allowed host resolved to it. The lab is on Vercel, and Vercel serves many sites from the same addresses, so while the rule is in place a Sprite may be able to reach another Vercel site through those addresses by asking for a different host name. I have not tested whether that works. A custom domain would not change it, because it resolves to the same addresses. The Sprite holds nothing of mine except the scoped key, and the rule is gone when the session ends. The other limit: anything that sets up a Sprite again puts the policy back to `defaults`, so if I run `create`, `create_all` or `setup` on `/api/sprites` while a session is running, the rest of that session cannot reach the endpoint and its record still says a key was offered.

**Spend.** Before a call the lab checks `LAB_DAILY_BUDGET_USD`, then the endpoint's own cap, `LAB_LIVE_MODEL_DAILY_USD` (default 1, UTC day). After it, what OpenRouter reports as `usage.cost` is written to `model_calls` with purpose `live_model`, under the experiment and epoch the key was issued to, and added to the key. No price table is involved. If a response comes back without `usage.cost`, it is recorded as costing nothing with `cost_source` `none`, and the 20 call limit is what bounds it. A call I gave up waiting for (90 s) is recorded as costing nothing too, although OpenRouter may still bill it. A Sprite session's worst case for the budget check includes the key's $0.25.

**The record.** Every call is a row in `live_model_calls`: the key, experiment, epoch, the model and Sprite it was issued to, the model asked for and the one that served, status, token counts, cost and duration, with a 200 character excerpt of the last user message and of the answer and the names of any tools called. Whole conversations are not kept. The session's `tool_runs` row gets `detail.live_model` with whether a key was offered, how many calls it made and what they cost. A call that failed upstream still counts against the key's 20.

The session's stored output ends with one line about the endpoint, for example `lab model endpoint: 2 calls, $0.0200`, or `lab model endpoint: not available in this session, no key was made: ...` with the reason. The models read the end of that output in later rounds, and the Commentator is told the same in the round itself. This matters because the prompt can only say the endpoint is switched on. Whether a session really got a key is decided by the Sprite when it confirms the egress rule.

Revoking a key stops new calls. It does not stop a call that is already with the model: that one finishes and is settled on the revoked key. So when a call is still running as the session ends, the lab waits up to 10 seconds for it before it writes the session's totals. If the call takes longer, `detail.live_model` has `call_in_flight: true`, the output line says the figure is short by one call, and the spend ledger and `live_model_calls` are where the real cost is.

**What the models are told.** One paragraph, and only while the endpoint is switched on for Sprite sessions: the variable names, that a session has them when the lab could open the endpoint for it and that the session's output says so when it could not, the models, the limits, that it is non-streaming and wants a JSON content type, that `reasoning_details` go back with a tool call turn, that CI and the contribution check get no key and keep their localhost fixture, that a session with the key is not given `CI`, and that what a model answers through it is untrusted data. It says nothing about what to do with it.

## GPU jobs

`"gpu_job": { "purpose": "...", "script": "..." }`, one Python script of at most 20,000 characters, run by `modal/gpu_jobs.py` under the research runner's sandbox rules:

- the script must compile under the runner's Python first; a syntax error comes back at stage `syntax` and no GPU is started;
- it runs in a fresh Modal Sandbox on an A10G with the network blocked, no secrets, no volumes (unless it names [public weights](#public-weights), see below), CPU and memory limits, and a hard limit of 120 s; the sandbox is always terminated;
- its output goes to a size-limited file and only the last 64 KiB is read back, from one verified regular file;
- whatever it prints is self-reported and stored as output, nothing more.

Deploy it with `modal deploy modal/gpu_jobs.py`, create the Modal secret `oblab-gpu-jobs-auth` with `JOBS_TOKEN` (at least 32 characters), and put the same value in the server's `GPU_JOBS_TOKEN`. Set `GPU_JOBS_START_URL` and `GPU_JOBS_STATUS_URL` to the `https://` endpoints Modal prints. The token travels in the Authorization header only. The server spawns the job and polls for up to `LAB_GPU_JOB_POLL_MAX_MS` (default 300000).

**Cost** is the job's measured wall time at `LAB_MODAL_GPU_USD_PER_SECOND`, default **0.000306** (Modal's published A10G rate when this was written; check modal.com/pricing and set it if it has changed). The whole job time is billed at the GPU rate, which slightly overestimates. A job that never started costs nothing; one whose result was lost is charged 210 s.

## Public weights

A GPU job's script has no network, and it must stay that way. With a connection it could download a trained model and print a great score as if it had trained one, and the experiment would mean nothing. So a model cannot download anything. What it can do, while `LAB_ENABLE_WEIGHTS=true`, is ask: `"weights": { "repo": "org/name", "revision": "..." }` names one public Hugging Face model repository (the revision is optional and defaults to `main`). My own code fetches it, checks it, and puts it on a shelf. A GPU job that names it, `"gpu_job": { ..., "weights": "org/name" }`, then reads it. Weights asked for in the same answer are fetched before the job that names them starts.

**Who does what.** The request is read strictly by the server (`api/_lib/weights.ts`): the id must be `org/name` in Hugging Face's own spelling, with no slashes, dots or anything else that could be a path. The server sends it to `fetch_weights` in `modal/gpu_jobs.py`, through the same endpoint and token as GPU jobs, with the token in the Authorization header only. `fetch_weights` is lab code. It is the only code in that app that downloads anything, it holds no credentials of any kind, and it never runs, imports or unpickles what it downloads. The model's script still runs in the sandbox with the network blocked.

**What the fetcher checks, in this order, before it downloads any weights.** It asks the public Hugging Face API for that revision, without a token, and gets back a commit sha and the file list. Then:

1. The repository must be public and not gated. No Hugging Face token is used anywhere, so a gated or private repository could not be read anyway; it looks the same as one that does not exist.
2. Every license the model card states must be on my list: `LAB_WEIGHTS_LICENSES`, default apache-2.0, mit, bsd-3-clause, bsd-2-clause, cc-by-4.0. No license stated is a refusal. The defaults apply only when the variable is not set: entries that are not license ids are left out, and a list with no usable entry turns the tool off rather than meaning the defaults.
3. No custom code. A `.py` file anywhere in the repository, or an `auto_map` entry in its config, is a refusal. I never use `trust_remote_code`.
4. It must have safetensors weights. Only safetensors, JSON, `.txt` and the tokenizer model files (`tokenizer.model`, `spiece.model`, `sentencepiece.bpe.model`) are downloaded. `.bin`, `.pt`, `.pkl` and every other kind of file stay on the hub. A repository with only pickle weights is refused.
5. The files to download must total at most `LAB_WEIGHTS_MAX_GB` (default 3, where 1 GB is 10^9 bytes), in at most 64 files with plain paths.

Then it downloads that exact commit, small files first. Every file must be the size the hub said and hash to what the hub published for it (the sha256 for a large file, the git blob id for a small one). Each downloaded config is read again for `auto_map` before the weights are fetched. Anything that does not match removes the whole download.

**The shelf.** The files go to the Modal Volume `oblab-weights` at `<org>/<name>/<commit sha>/`, with a manifest, `_lab_manifest.json`: the repository, the commit, the license, the total size, each file with its size and sha256, when it was fetched, and that no token was used. Weights already on the shelf are not downloaded again, but the rules are checked again each time they are asked for. The shelf holds `LAB_WEIGHTS_SHELF_GB` (default 30). When a new download needs room, the least recently used entries are removed, where use means being asked for or being named by a job. An entry used in the last 300 s is never removed, since a job may be about to mount it; a download that could only fit by removing one is refused (`shelf`).

**What a job sees.** A job that names weights gets that one shelf entry, and nothing else from the shelf, mounted read-only at `/weights` (the same path is in `LAB_WEIGHTS_DIR`). The network stays blocked, there are still no secrets, and the 120 s limit still applies. If the weights are not on the shelf, or their license has since been taken off my list, the job is not started and no GPU time is spent. Before the script is put in the sandbox, the controller reads the manifest at `/weights` from inside it; if that is not the commit it found on the shelf (the entry was removed in between, and Modal mounts an empty directory for a path that is gone), the script is not run and the result is stage `mount`. A job that names no weights has no volume at all, exactly as before.

**The label.** While this is on, every GPU job result is stored with a label: `fine-tuned from <repo>@<commit>` or `from scratch`. It is at the front of the job's `request_summary`, so it shows on the ticket by the gauge and in the activity record, and in full in `detail.label`. The label is built from what the Modal controller reports it mounted, never from what the model asked for or printed, and the controller reports weights only after the sandbox itself has read their manifest. A job whose script never ran has no label. A sandbox with nothing mounted has no network and no files from outside, so `from scratch` holds. What the job prints is still self-reported and unverified, as before.

**Limits to keep in mind.** `fine-tuned from` says which weights the job could read. It does not show that the job used them, or how. The license check reads what the model card says; it does not judge whether the card is right. A refusal comes back with its rule (`gated`, `license`, `custom_code`, `format`, `size`, `not_public`, `repo`, `revision`, `paths`, `files`, `shelf`) and is stored as a `failed` tool run with the reason.

**Waiting.** The server polls a fetch for `LAB_WEIGHTS_POLL_MAX_MS` (default 180000, at most 300000). If it is still running then, it carries on at Modal for up to 900 s, the run is stored as `timeout`, and the job that named those weights is skipped for this epoch. Asking again in a later epoch finds them on the shelf. Only a job that names the repository being fetched waits for it; any other job starts at once. The fetch and the job that waits share the job's own wait (`LAB_GPU_JOB_POLL_MAX_MS`, default 300 s), so if the fetch leaves less than 150 s of it the job is skipped for this epoch too, with the weights already on the shelf.

**Cost.** The fetcher runs on CPU. I charge its measured time at `LAB_MODAL_GPU_USD_PER_SECOND`, the same rate as a GPU job, which is about ten times Modal's listed CPU price, so the estimate errs high. A fetch whose time never came back is charged 960 s. It is written to `model_calls` as `tool/weights`. Storage is separate and not in the ledger: Modal's pricing page listed Volumes at $0.09 per GiB per month with 1 TiB per month free when I read it on 18 November 2026, so a 30 GB shelf costs nothing inside that allowance and about $2.50 a month outside it. Check modal.com/pricing before relying on that.

**What the models are told.** One line in the shared context and a few in the Executor's instructions, only while it is on: what can be asked for, the rules above with my current numbers, that a job reads the weights read-only at `/weights` with the network still off and the 120 s limit, the shelf size, that a fetch and the job that waits for it share one wait, and how results are labelled. It says nothing about which weights to ask for or what to do with them.

The research loop (`modal/research_runner.py`) does not get the shelf. Its kept scores compare runs that all start from nothing, and I did not want to change what those numbers mean.

## Exhibits

`"exhibit": { "slug": "...", "exhibit": { ... } }`. See [EXHIBITS.md](EXHIBITS.md) for the contract, the pull request and how the room reads them. Exhibit pull requests cost no model or compute money beyond AI-Agent's CI.

## Lab proposals

`"lab_proposal": { "title": "...", "summary": "...", "files": [ { "path", "content" } ] }`, 1 to 3 whole files under `src/`, `api/`, `docs/`, `tests/` or `modal/`. Workflows, hidden paths, environment files, dependency manifests, build and deployment configuration and `schema.sql` are refused. When the Reviewer approves, the lab opens a pull request to the Observable-Lab repository on branch `model-proposal/epoch-<n>-<slug>`, labelled `model-proposal`, with the model as commit author. **The lab never merges these.** Its client for that repository has no merge path at all; the owner reviews and merges by hand. [SECURITY.md](../SECURITY.md) explains why.

The token is `LAB_PROPOSALS_GITHUB_TOKEN`, a fine-grained token for that one repository with **Pull requests: read and write** and **Contents: read and write** and nothing else. It never falls back to another token. `LAB_PROPOSALS_GITHUB_OWNER` names the owner; `LAB_PROPOSALS_GITHUB_REPO` defaults to `Observable-Lab`.

## Spend

Before a tool runs, the server checks its daily limit and today's spend. A Sprite session, GPU job or weights fetch is refused when today's spend plus its worst case (240 s of Sprite time, 210 s of GPU time, or 960 s of fetch time) would pass `LAB_DAILY_BUDGET_USD`. Afterwards its estimated cost is written to the `model_calls` ledger as model `tool/sprite_session`, `tool/gpu_job` or `tool/weights` with `cost_source` `estimate`, so the daily cap, the cron's pause and the epoch's `cost_usd` all include it.

## The record

`tool_runs` is created at runtime: `experiment_id`, `epoch`, `model`, `tool`, `request_summary`, `status` (`ok`, `failed`, `error`, `timeout`, `skipped`, `opened`, `merged`, `closed`), `exit_code`, `duration_ms`, `cost_usd`, `output_tail` (cleaned, at most 4 KB), `detail` (small JSON: commands, slug, pull request URL) and `created_at`. `GET /api/experiment` returns the 12 most recent for the current experiment as `tool_runs`, cleaned again on the way out, and the switched-on tools as `tools_enabled`. `tools_enabled` also lists `live_model` while Sprite sessions come with the lab model endpoint.
