# Observable Lab

I do these experiments for fun. Observable Lab is a skeuomorphic experiment in observing agent behavior. I'm using familiar physical objects, like a room, desks, characters and a plant, to make the agents' roles and decisions easier to follow.

**Still an experiment.** The research loop, its evaluation and the room's connection to the backend are all unfinished.

<p align="center"><img src="docs/assets/lab-motion.gif" width="880" alt="The real Observable Lab app running its local simulation: scientists walk between desks and a plant, with Simulation: no experiment connected shown in the corner."></p>

*I recorded the room's local simulation for 24 seconds. The scientists' movement and desk activity run in the browser. A recording of connected model, Sprites and subagent work is still on my list.*

## The question

I want to know whether models with different jobs can produce useful criticism and use it in the next round. A longer conversation is easy to produce. I'm interested in whether I can see an assumption get challenged, a weak change get rejected, or an experiment improve for a reason I can check.

The room gives each model a desk. In the middle is a plant representing their shared agent specification: capabilities become branches, constraints become roots, and other parts of the specification affect its appearance. I use the plant to follow changes to the specification. Measuring the resulting agent's capability needs its own evaluation.

## The experiment

There are two loops in the code.

The first grows an **agent specification**. Models propose a direction, work through the proposal, challenge it and decide what to keep. There are five jobs:

- **Planner:** choose a direction or hypothesis.
- **Executor:** propose the change or write the experiment.
- **Challenger:** look for failure cases and weaknesses in the method.
- **Reviewer:** keep, change or reject it.
- **Commentator:** explain what happened to someone watching.

Every model takes each job once in an aligned block of five rounds. The configured panel uses Gemini, DeepSeek, Claude, GPT and Grok through OpenRouter; the model IDs are in [api/_lib/types.ts](api/_lib/types.ts). North and GLM have separate experimental roles. When a call falls back to another model, the log records which model actually answered. Comparisons between models need to account for those fallbacks.

### What the models can do in run 2

In run 2 the specification loop also writes code. With `LAB_ENABLE_CODE_WRITES=true`, at most one approved change per round becomes a pull request to the [AI-Agent](https://github.com/DervinEvolve/AI-Agent) repository, written by that round's Executor. It merges only if the Reviewer approved the change and the repository's tests pass in GitHub Actions for that exact commit. The commits name the model as the author; I'm the committer.

The Executor also gets a small menu of tools. Each one is off unless I've switched it on and given it credentials, and the prompts only describe the ones that are on, so the models aren't told about abilities they don't have:

- **Subagents.** The Executor decides how many explorer subagents (none, one or two) research the change before the code is written, and whether a test subagent adds a test afterwards. The explorers' task, searches and findings go into the pull request description. In the room they're the drones.
- **Sprite sessions.** Each lab's model has its own Sprite, a Linux computer in the cloud, shown as the screen above its desk. The Executor can run up to four shell commands there to try something out or time it. The Sprite can reach GitHub and the usual package registries, holds no credentials, and its output is stored and shown.
- **GPU jobs.** One short Python script on a Modal GPU, with the network blocked, no credentials inside and a 120-second limit. The script has to compile before any GPU time starts.
- **Exhibits.** The Executor can design a small object for the room as a data file. If the Reviewer approves it, it goes to AI-Agent as a pull request, and it appears in the room once it merges.
- **Proposals to this repository.** A model can propose a change to the lab itself. These open as pull requests labelled `model-proposal`, and I review and merge them myself, because this repository deploys the site and its server holds the lab's keys.

Every tool has a daily limit, and what it costs counts against the same daily spending cap as the model calls (`LAB_DAILY_BUDGET_USD`, $15 by default). OpenRouter reports the real cost of each model call; Sprite and GPU time are my estimates from how long they ran. When the cap is reached, the lab pauses until midnight UTC.

What a script prints, in a Sprite or on the GPU, is the model's own report. I store it and show it, but nothing checks it independently. Passing tests in AI-Agent mean the tests the models wrote passed; they don't measure how capable the agent is. I've tested the tool paths against fake services, and recording a connected run that uses them is still on my list. [The tool notes](docs/TOOLS.md) have the limits and setup, and [the exhibit notes](docs/EXHIBITS.md) describe the exhibit format.

### The research loop

The second loop tries **ML research**, influenced by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch). The models choose a hypothesis, write a `train.py`, send it to a Modal GPU runner and review the reported validation score. A kept change can be committed to the separate Research-Lab repository, along with the result and finding page. The loop runs on its own after an experiment is seeded; I read the record afterwards.

Each training run gets a fresh Sandbox. Network access is blocked, credentials stay outside it, and the dataset cache is read-only. The default training budget is 300 seconds, followed by a bounded grace period for startup and evaluation. The controller stops the Sandbox after each run. I tested the isolation with a live CPU run. Independent evaluation of model quality is still unfinished.

## The record so far

<p align="center"><img src="docs/assets/lab-room.png" width="880" alt="Observable Lab displaying stored experiment state, with model role labels, scientists at desks and the specification plant."></p>

*The app showing stored experiment state. The three still captures in this README show epoch 19, with an unfinished epoch 20 in the log. Character movement is drawn locally.*

The older room description names enwik8, and the later research notes describe a move to TinyStories. The early records are missing dataset and evaluation-version details, so I keep those phases separate in the archive. The current preparation harness pins a TinyStories revision and checks its SHA-256; a fresh full GPU run with that setup is still to do.

<p align="center"><img src="docs/assets/experiment-log-expanded.png" width="880" alt="The experiment log records the agents testing a smaller training batch, reviewing its reported score and rejecting the change."></p>

*In this round, the agents tried feeding the model fewer examples at a time during training. It completed more training steps. Its reported test score got worse, so the group rejected the change.*

For this experiment, the goal is to help a small language model predict text more accurately. Each run reports a score for its predictions. **Lower is better.**

The training program calculates and reports its own score. I save that result as an unverified report. I still need a separate checker that loads the saved model, gives it a fixed set of test text and measures the score again.

I also want to run each change several times. That would help me see whether an improvement repeats or came from a lucky run. [The research notes](docs/RESEARCH_NOTES.md#the-two-experiments-in-the-code) describe the scoring and dataset setup in more detail.

## What I'm taking from the early rounds

Looking back through the saved notes, a few things seem worth carrying into the next run:

- **The agents pushed for clearer tests.** [Epoch 13](docs/epochs/notes/epoch-013.md) changed two training-schedule settings and reported a better score. The reviewers asked for the settings to be tested separately. [Epoch 14](docs/epochs/notes/epoch-014.md) changed one setting. Its reported score fell from the previous kept result of 0.7156 to 0.7067, and the Reviewer kept it.
- **The time limit changes the trade-offs.** [Epoch 15](docs/epochs/notes/epoch-015.md) tried a deeper model. It completed 3,298 training steps against the earlier setup's 4,335 within the five-minute target, and reported a worse score. The deeper model also got fewer training steps, so I want to test those effects separately.
- **Their explanations were worth questioning too.** In [epoch 14](docs/epochs/notes/epoch-014.md#challenger-concerns), the Challenger worked through the learning-rate calculation and disputed the Executor's explanation for the improvement. I like being able to see that criticism beside the decision to keep the change.
- **Some model changes gave me candidates to revisit.** In [epoch 9](docs/epochs/notes/epoch-009.md), the group changed an internal building block to SwiGLU, kept the model roughly the same size, and reported a lower score in that single run. I want to check whether that result repeats.
- **Basic code checks matter.** [Epoch 20](docs/epochs/transcripts/epoch-020.md) stopped at a Python syntax error before training began. I want to parse the generated training script before starting a GPU job.

[Read the epoch notes and available conversations](docs/epochs/README.md). There are saved findings for rounds 1–20. For 16–20, I've also archived the individual role outputs in reading order; round 20 ends after the Reviewer. The index includes a short glossary and the original results file.

## Running it again

I'm planning a fresh run soon with updated models. For that run, I want fixed model versions, a clearly recorded dataset, separate checking of the scores and repeated runs for each promising change. I'll keep this early run available alongside the new results.

## Watching the room

<p align="center"><img src="docs/assets/lab-about.png" width="680" alt="The About panel explaining the experiment and the distinction between stored state and simulation."></p>

*Hon AI Research is my project name. The About panel explains how to read the room.*

The room regularly checks for updates to the saved experiment. When I run it locally without a connected experiment, it plays a preview of the scientists moving around and working at their desks. The corner label reads **Simulation: no experiment connected**. That is the mode shown in the GIF.

Each model's Sprite is the screen above its desk. When a model runs commands there, or the tests for its pull request run there, the screen plays back the stored output. A Sprite is created the first time it's needed. I still need to record the full connected flow, including subagent work.

The research loop can save its experiment code and results in the separate Research-Lab repository. The AI-Agent write path described above is on for run 2. It uses a token limited to that one repository, and the generated code only runs in GitHub Actions and in the Sprites, neither of which holds the lab's credentials. [Implementation notes](docs/RESEARCH_NOTES.md) and [Operations](docs/OPERATIONS.md) cover the permissions and setup.

## Run it locally

Node 22 and npm:

```bash
npm ci
npm run dev
```

That opens the room in its local simulation. Connected experiment state needs a database and the server configuration described in [.env.example](.env.example). Starting experiments, manual rounds, Sprites and debug operations require a server-side operator secret; the scheduler has a separate secret. The public viewer has neither.

The app uses Three.js, TypeScript, Vite and GSAP. Vercel serves the API, Postgres holds experiment state, OpenRouter serves model calls, and Modal runs the research jobs. Each service needs its own account, credentials and setup.

[Implementation and research notes](docs/RESEARCH_NOTES.md) cover model fallbacks, scoring, the two write paths, Sandbox limits and all setup options. [Operations](docs/OPERATIONS.md) covers deployment and migrations.

Checks used during development:

```bash
npm run build
npm run check:api
npm run test:security
npm run test:bundle
node --test tests/run2.test.mjs tests/sprites.test.mjs tests/tools.test.mjs
python -m unittest discover -s tests -v
```

The Python checks need [requirements-dev.txt](requirements-dev.txt). They run with local fixtures and mocked providers. Recorded validation results are in [the source review](docs/PUBLICATION_REVIEW.md).

## People, tools and sources

I actively use Codex, Claude, DeepSeek through Hermes, and Kimi to experiment, develop, debug and review this project. I also use DeepSeek through Hermes and Kimi for security audits. These are my development tools; they are separate from the model panel inside the lab.

The human characters, robot and spaceship are from Quaternius packs under CC0. The subagent drone uses original procedural geometry. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records their sources, the research influences, dataset terms and dependency licenses. GSAP is covered by GreenSock's standard license.

MIT for my original contributions: [LICENSE](LICENSE). For private security reports, see [SECURITY.md](SECURITY.md).
