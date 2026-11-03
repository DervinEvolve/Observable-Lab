# Operator setup

The browser is an observer. Server credentials must not be placed in `VITE_*` variables, browser storage, query strings, screenshots, or repository files.

Copy `.env.example` for local server configuration. Vite alone does not serve the Vercel API or load a connected experiment. Set up Vercel's Node functions and Postgres separately, review `api/_lib/schema.sql` and the later table-creation helpers against the target database, and use a disposable database for migration testing. Do not assume the older `vercel-server/` scaffold is the current deployment entry point.

## Vercel route authorization

- Set `LAB_OPERATOR_SECRET` to a random server-side value of at least 32 characters. Operator clients send it as `Authorization: Bearer <value>`.
- Set a different random `CRON_SECRET`, also at least 32 characters. `/api/epoch/tick` accepts this credential only. [Vercel Cron sends the configured secret in the Authorization header](https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- Missing or short configuration returns 503. Missing or incorrect authorization returns 401 before database, model, Sprites, or compute work.
- The guard covers manual epochs, clearing stuck epochs, seeding/resetting/patching experiments, the persisted glass state, debug views, North runs, and all Sprites routes. `?confirm=true` remains an extra action check; it is not authentication.
- Ordinary experiment state, contribution records, and wildcard transcripts remain public observer endpoints. Review their contents before using private research or code in a connected deployment. Only put material intended for viewers in that experiment.

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

## Rollout verification

Before enabling a deployment, verify that anonymous requests to operator routes return 401 (or 503 when unconfigured), that the scheduler accepts only its own credential, and that authorized work reaches the intended test environment. Check provider spend limits and the actual contents of public observer responses. Build and local regression tests do not verify deployed access controls.

The Modal images in `modal/research_runner.py` and `modal/app.py` use a digest-pinned `python:3.11.18-slim-bookworm` base and exact package versions. Rebuild and smoke-test after changing any of them. The dataset download in `modal/harness/prepare.py` uses `DATASET_REVISION` and `DATASET_SHA256`; real preparation refuses to download until both are set, and a pinned revision prepares into its own cache directory.

Smoke preparation uses `/cache/smoke`; research preparation uses `/cache/research`. Synthetic smoke bins cannot become the production dataset merely by existing first. Results record the dataset label and bundled harness hash; neither field independently validates the model-reported score.
