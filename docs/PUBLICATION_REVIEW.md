# First publication review — November 1, 2026

Reviewed the main-branch text snapshot at `fd253e185c0cdc31886dcb913b74846269df2c10`. This is a source review and local regression check, not a complete deployment audit or permission to change repository visibility.

## Findings addressed in this branch

- Follow-up review separated intentional autonomous research writes from security controls. Research execution and commits remain available; research GitHub access now uses a dedicated token scoped to that repository. Runner comments no longer claim the writable evaluation file is immutable, and negative/non-finite primary metrics are rejected.

- Vercel operator endpoints accepted anonymous requests that could run models, mutate experiment state, or proxy Sprites commands using a server token. They now require a server-only operator Bearer secret before work begins. The scheduler uses a separate `CRON_SECRET`; both guards fail closed when unconfigured. Debug query mode has the same guard.
- Sprites routes advertised wildcard cross-origin access. Those permissive headers were removed; CORS is not a substitute for authorization.
- The legacy Modal ASGI surface had no application authentication. All routes except the static health check now require a separately configured Bearer credential. Its Vercel client sends that header and fails closed without configuration.
- Research runner status requests put an access token into a URL. Both runner endpoints and the Vercel client now use headers, with constant-time comparison. Invalid status responses no longer appear to be running jobs. Training budget input is finite and bounded.
- Code contributions could merge when CI was missing, timed out, or could not be checked. A successful result is now required, and the check examines all returned workflows rather than only the first. Generated file paths are restricted away from workflows and dependency configuration. Repository writes require explicit opt-in and remain subject to destination-repository permissions.
- A capability link was interpolated directly into HTML. It now accepts only a GitHub pull-request URL with a restricted path shape.
- Kimi's independent review found more persisted model fields interpolated into transcript HTML and attributes. All transcript text/fallback JSON now escapes HTML and quotes; mood, severity and verdict classes use fixed allowlists. Model labels, risk text and data attributes receive the same escaping. A regression exercises the real rendering methods with hostile persisted values.
- Added an API TypeScript check, which was not included in the frontend build. Corrected outdated specification field accesses in the legacy Modal prompts and narrowed unused database helper arguments to supported SQL primitive values.
- Development and preview servers bind to loopback. Ignore rules preserve `.env.example` while excluding local environment files and Python bytecode.
- Applied non-breaking npm advisory fixes. The lockfile now selects Vite 7.3.7 and `@vercel/node` 5.10.2. Some advisory findings remain in the Vercel development-tool dependency tree; no forced downgrade was applied.

## Local validation

The clean locked install, frontend TypeScript/Vite build, and API TypeScript check passed. At the time of this review, eight Node security-test groups covered anonymous route rejection, separate scheduler/operator secrets, header-only runner authentication, CI outcomes, generated path restrictions, default-disabled contribution writes, autonomous research writes with a separate token, a merge pinned to the checked head, and transcript HTML/attribute escaping, and five Python regression tests exercised the actual authentication/runner functions, sandbox creation settings, smoke separation and termination after failed setup without starting compute. The changed Python modules compile. The current counts are in the update below.

The post-update npm production dependency audit reported zero findings. The full development tree still reported 11 findings (4 high and 7 moderate), rooted in Vercel tooling. These are not a clean full dependency audit or a live provider/deployment test.

## Review limits and remaining work

A follow-up common-token/private-key pattern scan covered 435 text blobs across all 162 unique commits reachable from the four original branch heads (main, 3dscientists, sprites, and feature/v2-redesign). No matches were found. All 158 unique trees were retrieved without truncation. This does not cover every possible password, binary-embedded secret, pull-request-only object, or deployed environment, and is not a claim that the repository is secret-free. No tags, releases, or workflow runs were listed at review time.

Read-only requests to the existing deployment still returned HTTP 200 from `/api/experiment/debug`. The protected PR has not been rolled out. Treat live authorization as unresolved until anonymous requests are rejected on each deployed service and old preview.

The draft runner now uses a separate Modal Sandbox per generated training run, with no injected secrets, blocked network, a read-only fresh dataset Volume, CPU/memory limits, a hard lifetime, and termination in a finally block. The controller executes only the reviewed preparation harness. Logs are bounded. Metrics are explicitly marked as unverified experiment stdout and the harness hash is recorded; the disposable harness copy is not an independent evaluator. These settings passed local wiring regressions, but need a real sandbox denial/termination test. The reviewed Research-Lab preparation source is now bundled under `modal/harness`, so the image build no longer depends on a sibling private checkout. Independent evaluation and repeated measurements are still outstanding.

Public observer endpoints expose experiment specifications, outputs, contribution records, and transcripts by design. Ensure that connected experiments contain only material intended for viewers. The MIT repository license and the third-party notices have since been added. Asset origins still need confirmation before distribution (see `THIRD_PARTY_NOTICES.md`); the package `license` field is not a full asset audit. The provider logos whose sources could not be confirmed were later removed (see the second update below).

The deployed viewer was inspected read-only. The README now uses three unedited captures of the current app: room overview, About panel and expanded experiment log. Fullscreen page-only window capture excludes browser tabs and account UI. They show stored epoch 19 and an unfinished epoch 20. No model, Sprites, GitHub contribution or GPU job was triggered for the captures. The current About text and text-only provider labels are visible.

These source guards require new server configuration and coordinated Vercel/Modal rollout. They do not secure existing deployments, old immutable previews, or separately deployed functions until those services are updated. No production deployment, provider credential change, repository merge, or visibility change is part of this draft.

## Update — November 2, 2026

A second review found further issues, fixed on this branch:

- Model output chose part of the AI-Agent branch name, so a target like `x/../main` could reach `DELETE /git/refs/heads/main` when code writes are enabled. Branch names are now built from validated values in two exact shapes, every ref operation refuses anything else before a request, and generated file paths use a strict character set.
- Runner URLs, the Modal workspace and the GitHub owners defaulted to the author's accounts. They are now required and fail closed with a message naming the variable.
- Fallback answers were stored under the assigned model's name. Outputs now record the answering model in `served_by`, and the log shows a fallback marker.
- The `experiment_stdout_unverified` label, dataset and harness hash now reach `results.tsv`, the finding page and commit trailers. The runner stops `train.py` at the budget plus a short grace period instead of budget + 600 s. Independent re-evaluation is still not implemented.
- The no-backend simulation no longer prints made-up commits and builds, and the info panel labels it. The viewer no longer calls operator routes, and `window.lab` is development-only.
- GitHub Actions CI runs the build, API typecheck, Node tests and Python tests with no secrets. The route-auth test discovers routes from `api/` instead of a hand-kept list.
- Modal images are pinned by digest and exact versions; the dataset download is pinned to a revision with a SHA-256 check, whose values the author still has to fill in.

Current local checks: 14 Node security tests, 1 production-bundle test and 9 Python tests pass. The deployment rollout (section above) and the history cleanup (old assets, extra branches, pull-request refs, personal commit metadata) are still outstanding and are not changed by source edits.

## Update — November 2, 2026 (second round)

Owner decisions, applied on this branch:

- Generated commits (AI-Agent contributions and their subagents, North and GLM branches, Research-Lab records) were authored as per-model addresses at `agents.observable-lab.dev` and `lab@observable-lab.dev`, a domain the project does not use. They are now authored and committed as `DervinEvolve <39844362+DervinEvolve@users.noreply.github.com>`, and the model that produced each change is named in `Model:` trailers (with `Model-Fallback-For:` when a fallback answered). A test fails if an `observable-lab.dev` identity reappears in `api/`, `modal/` or the configuration files. Commits already in those repositories keep their old identities; their history is not rewritten.
- The provider logos under `public/logos/` (all with unconfirmed sources, one a hand-drawn imitation) are removed. The hover cards and the experiment log show the plain provider name instead. Three README captures from an earlier build still show the old xAI avatar in the log and need new captures before publication.
- "Hon AI Research" is the author's own project name. The info panel now reads "Hon AI Research, a personal experiment" instead of "by Hon AI Research".

Current local checks: 17 Node security tests, 2 production-bundle tests and 9 Python tests pass.

## Follow-up checks

Vercel dashboard inspection confirmed preview authentication is enabled (Standard Protection), while production remains public. New operator/scheduler and separate research GitHub credentials were absent from the inspected environment-variable inventory. Configuration and coordinated rollout remain pending.

Contribution CI now requires operator-configured numeric workflow IDs and matches the exact head SHA, destination repository, and push/pull-request event. Missing required workflows or unrelated green workflows cannot permit a merge. Destination branch protection still needs verification.

MIT is prepared for original contributions, with separate third-party notices. The Quaternius robot was matched to the creator’s October 2018 archive and CC0 license. The untraced imported drone is replaced with original procedural geometry and removed at the draft tip; its historical objects and the old GLM/MachineMan asset remain publication blockers.

A bounded CPU-only live Modal probe verified the Sandbox settings against the service: the dataset fixture remained readable, writes to its read-only Volume failed, outbound TCP was denied, no checked Modal/provider/database/operator credential variables were injected, and the Sandbox terminated. The probe used an ephemeral Volume, no models and no GPU. The private Research-Lab source is now accessible through the restored CLI; its current preparation code uses TinyStories, while the deployed UI still records older enwik8 context. Full generated training and independent metric validation remain separate checks.


## Current rollout verification

The earlier pending-deployment statements above describe the source-review stage. The guarded build now runs on `observable-lab.vercel.app`. The public viewer is readable, while all 112 missing/wrong-credential operator checks returned the application’s 401 response. Three public read controls and an authorized read-only operator control returned 200. No authorized epoch or GPU training request was sent during these checks.

The research runner’s token was replaced and its guarded endpoints redeployed. Missing/wrong credentials return 401; the current token with deliberately invalid short code returns 400 before compute. A live CPU-only synthetic-data probe completed through the actual controller and Sandbox: expected provider/database/GitHub/operator credentials were absent, outbound TCP was denied, shared data remained readable, and writes to the shared cache failed. A separate CPU test replacing its own log with a device symlink was rejected safely. These checks exposed and resolved controller import, deployed harness-path, and retired Modal filesystem-API problems. The deployment client is pinned in `requirements-runner.txt`. This is execution-isolation evidence, not an independent measurement of model quality.

The unused legacy `observable-lab` Modal app is stopped. The separate guarded research runner remains deployed. Forty-six older Vercel deployments were removed after owner approval. Current production and newer review builds were retained; the remaining ready deployment URLs require Vercel authentication, and the public viewer and private debug control still return 200 and 401 respectively.

The server has separate operator, scheduler, runner, and Research-Lab credentials. The research token is limited to `DervinEvolve/Research-Lab`, with Contents read/write and Metadata read, and expires on December 2, 2026; renew it before the research loop needs it after that date. General AI-Agent contribution writes remain off. The intended autonomous research execution and Research-Lab commits remain configured. The TinyStories revision and checksum pins are filled in.

The fresh repository’s reachable Git history was scanned with Gitleaks’ built-in defaults, without repository ignore overrides; no findings were reported. The original repository and its old objects remain in a separate private archive. That archive has not been made public.

Still open: replace the three older README captures that contain the former provider avatar; independently evaluate generated checkpoints, repeat research runs, and verify destination protections before enabling the separate general code-contribution pipeline. Source publication does not establish reproducible research results.


## Final source-publication check

This snapshot contains only the reviewed current tree. Its public history must not include the original private history or the private preparation commits. The final local publication repository has one root commit, a verified object inventory, no personal author/committer email and no Gitleaks findings. Old imported drones, unconfirmed provider-logo files and the obsolete composed figures are absent. The README retains the three current app captures and an explicitly labelled local-simulation GIF; connected Sprites/subagent recording remains unfinished.

The guarded production and CPU Sandbox verification above still describe the deployed build. This final pass changes documentation and removes unused figures, not executable source. Local build, API/security, bundle and Python results from that reviewed executable source remain applicable. New private GitHub runs have been refused before steps because the account's included compute allowance is exhausted; no passing result is claimed for those runs. Standard public-runner CI should be checked after publication. No public visibility or deployment change is made by this document.

## Sourced provider logos

The provider marks were restored from recorded Commons sources and Cohere's MIT-licensed official toolkit. The hover cards and transcript load these seven local SVG files. Source URLs, declared terms and file hashes are recorded in `PROVIDER_LOGO_SOURCES.json`; required MIT notices are retained. The production-bundle check verifies that every shipped mark is credited, matches its hash and contains no active SVG content or external image links. The old unverified files stay excluded.
