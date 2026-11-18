# Observable Lab: Tinker training runs the models ask for (Modal)
#
# A model may ask for one LoRA fine-tuning run on Tinker, the training service
# from Thinking Machines (docs/TOOLS.md, "Tinker training"). The model writes
# the training data and a few bounded settings into its answer, the Reviewer
# approves it, and the lab server sends it here. Everything that happens next
# is this file's own code. Nothing a model wrote is ever executed: its answer
# is data.
#
#   * The request is checked again here: base model, examples, settings, the
#     budget and the prices the lab sent.
#   * The dataset is split by a hash of a value the lab makes up for the run
#     (split_salt), about a tenth held out. The model wrote its request before
#     that value existed, so it cannot know which examples are held out.
#   * Real tokens are counted before anything is trained. A plan that would
#     cost more than the budget, at the published prices, is refused.
#   * The base model's loss on the held-out examples is measured, then the
#     adapter is trained, then the same loss is measured again. Those two
#     numbers are measured by the lab. They are not reported by a model.
#   * Training stops early at the step limit, at the time limit, or when the
#     tokens counted so far, plus what the last measurement and the samples
#     still need, would pass the budget.
#   * The adapter is saved for sampling with a time to live, and a few
#     completions are sampled on held-out prompts.
#
# Money. Tinker reports no cost with a call and its billing page lags by
# hours, so the lab counts tokens and prices them at Tinker's published
# prices. Every dollar figure here is that estimate.
#
# The Tinker API key. It lives in the Modal secret "oblab-tinker-auth" and is
# given to `train` only. The Tinker SDK reads it from the environment. This
# file never reads it into a result, a log line or an error: error text is
# scrubbed of it before it is returned. The two HTTP endpoints do not have
# that secret at all; they hold only the token the lab server calls them with.
#
# Deploy (from a Mac, see docs/OPERATIONS.md):
#   uv run --no-project --python 3.12 --with-requirements requirements-runner.txt modal deploy modal/tinker_jobs.py
# Secrets:
#   modal secret create oblab-tinker-auth TINKER_API_KEY=<the Tinker key>
#   modal secret create oblab-tinker-jobs-auth JOBS_TOKEN=<random, 32+ chars>
#          (the same value goes in the lab server's TINKER_JOBS_TOKEN)
#
# HTTP API (for the Vercel backend), Authorization: Bearer <JOBS_TOKEN> on both:
#   POST /start   {run_id, train: {base_model, examples, settings, split_salt, budget_usd,
#                          prices, ttl_seconds, samples, sample_max_tokens, label}}  -> {call_id}
#   GET  /status  ?call_id=...  -> {status: running} | {status: done, result} | {status: failed, error}
#   GET  /status  ?run_id=...   -> the same for the call started under that name, with its call_id,
#                                  or {status: unknown} when no call is known for it
#
# run_id is the lab's own name for a run (optional). The call started for a
# name is remembered in the Modal Dict "oblab-tinker-runs", so the lab can
# find a run whose start answer never reached it, and a start repeated for a
# name that already has a call returns that call and starts nothing. The Dict
# is a convenience and never a gate: if it cannot be read or written the run
# starts all the same, and the lab then treats a lost answer as a run that may
# be training.
#
# result: {status: ok, n_train, n_holdout, steps_planned, steps_done, stopped_early,
#          holdout_loss_before, holdout_loss_after, train_loss_first, train_loss_last,
#          tokens: {train, eval, sample_prompt, sample_completion},
#          sampler_path, ttl_seconds, samples: [{prompt, completion}], wall_seconds}
#       | {status: refused, stage, reason, tokens, wall_seconds}
#       | {status: error, stage, error, tokens, ..., wall_seconds}
#
# Every import at the top of this file must be installed in every image below,
# and must import on Python 3.9 (the deploying Mac's Modal may run on it). The
# Tinker SDK needs Python 3.11, so it is imported inside TinkerDeps only.

import hashlib
import hmac
import math
import os
import re
import time
from typing import Optional  # the deploying Mac may run Python 3.9, which has no "X | None"

import modal
from fastapi import HTTPException, Request
from modal.exception import OutputExpiredError

APP_NAME = "oblab-tinker"

# The base models this runner will train, and the chat format each is trained
# and sampled in: the cookbook's renderer without the thinking block, so the
# adapter answers directly. The lab server has the same three ids with their
# prices (api/_lib/tinker.ts). Any other base model is refused.
RENDERERS = {
    "Qwen/Qwen3.5-4B": "qwen3_5_disable_thinking",
    "Qwen/Qwen3.5-9B": "qwen3_5_disable_thinking",
    "Qwen/Qwen3.6-35B-A3B": "qwen3_5_disable_thinking",
}

# Limits. The lab server checks the same ones before it sends a request; these
# are the ones that hold whatever it sends.
MIN_EXAMPLES = 10
MAX_EXAMPLES = 2000
MAX_MESSAGES = 12
MAX_EXAMPLE_BYTES = 6000
MAX_DATASET_BYTES = 120_000
MAX_EXAMPLE_TOKENS = 4096
MAX_STEPS = 600
RANKS = (8, 16, 32)
LEARNING_RATE = (1e-5, 5e-4)
EPOCHS = (1, 3)
BATCH_SIZE = (1, 16)
HOLDOUT_FRACTION = 0.1
HOLDOUT_MIN = 2
HOLDOUT_MAX = 200
EVAL_BATCH = 16
MAX_SAMPLES = 5
MAX_SAMPLE_TOKENS = 256
SAMPLE_TEMPERATURE = 0.3
# The most one run may cost, whatever budget the lab server sends.
HARD_RUN_USD = 5.0
MIN_TTL_S = 3600
MAX_TTL_S = 30 * 24 * 3600
# Time. Training stops starting new steps after TRAIN_WALL_S; the rest of
# RUN_TIMEOUT_S is for the last measurement, the save and the samples.
TRAIN_WALL_S = 1800
RUN_TIMEOUT_S = 2700
CALL_TIMEOUT_S = 600
SALT_PATTERN = r"[0-9a-f]{16,64}"
# The lab's name for a run (its adapter name), and a Modal call id as stored under it.
RUN_ID_PATTERN = r"e[0-9]{1,6}-[0-9a-f]{8}"
CALL_ID_PATTERN = r"[A-Za-z0-9_-]{1,100}"
RUNS_DICT = "oblab-tinker-runs"
ROLES = ("system", "user", "assistant")

app = modal.App(APP_NAME)

PYTHON_BASE_IMAGE = "python:3.11.18-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd"

# The Tinker SDK and its cookbook (renderers and the supervised datum helper).
# torch comes from the CPU index: the cookbook imports it, nothing here runs a
# model locally. fastapi is here because the top of this file imports it and
# Modal loads the whole module in this container too.
train_image = (
    modal.Image.from_registry(PYTHON_BASE_IMAGE)
    .pip_install("torch==2.15.0", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install(
        "tinker==0.39.1",
        "tinker-cookbook==0.6.1",
        "tml-renderers==0.4.2",
        "transformers==5.23.0",
        "numpy==2.4.6",
    )
    .pip_install("fastapi==0.162.0")
)

web_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install("fastapi[standard]==0.162.0")


# ---------------------------------------------------------------------------
# Pure parts: the request, the split, the plan, the cost, the loss
# ---------------------------------------------------------------------------

def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def holdout_count(n: int) -> int:
    """How many of n examples are held out: about a tenth, at least 2, at most 200."""
    return min(HOLDOUT_MAX, max(HOLDOUT_MIN, int(math.ceil(n * HOLDOUT_FRACTION))))


def check_example(example) -> Optional[str]:
    """None when the example is a well formed chat conversation, else why not."""
    if not isinstance(example, dict) or set(example.keys()) != {"messages"}:
        return "an example must be an object with only \"messages\""
    messages = example["messages"]
    if not isinstance(messages, list) or len(messages) < 2 or len(messages) > MAX_MESSAGES:
        return "an example must hold 2 to %d messages" % MAX_MESSAGES
    size = 0
    for message in messages:
        if not isinstance(message, dict) or set(message.keys()) != {"role", "content"}:
            return "a message must be an object with only \"role\" and \"content\""
        if message["role"] not in ROLES:
            return "a role must be system, user or assistant"
        content = message["content"]
        if not isinstance(content, str) or not content.strip():
            return "content must be non-empty text"
        try:
            size += len(content.encode("utf-8"))
        except UnicodeEncodeError:
            return "content holds broken text"
    turns = messages[1:] if messages[0]["role"] == "system" else messages
    if len(turns) < 2 or len(turns) % 2 != 0:
        return "messages must alternate user and assistant and end with the assistant"
    for i, message in enumerate(turns):
        if message["role"] != ("user" if i % 2 == 0 else "assistant"):
            return "messages must alternate user and assistant and end with the assistant"
    if size > MAX_EXAMPLE_BYTES:
        return "an example holds more than %d bytes of text" % MAX_EXAMPLE_BYTES
    return None


def check_job(job) -> Optional[str]:
    """None when the job is one this runner accepts, else a short reason. Runs nothing."""
    if not isinstance(job, dict):
        return "the job is not an object"
    if job.get("base_model") not in RENDERERS:
        return "base_model is not one this runner trains"
    examples = job.get("examples")
    if not isinstance(examples, list) or len(examples) < MIN_EXAMPLES or len(examples) > MAX_EXAMPLES:
        return "examples must hold %d to %d conversations" % (MIN_EXAMPLES, MAX_EXAMPLES)
    total = 0
    for i, example in enumerate(examples):
        problem = check_example(example)
        if problem:
            return "examples[%d]: %s" % (i, problem)
        total += sum(len(m["content"].encode("utf-8")) for m in example["messages"])
    if total > MAX_DATASET_BYTES:
        return "the dataset holds more than %d bytes of text" % MAX_DATASET_BYTES
    settings = job.get("settings")
    if not isinstance(settings, dict) or set(settings.keys()) != {"rank", "learning_rate", "epochs", "batch_size"}:
        return "settings must hold rank, learning_rate, epochs and batch_size"
    if not _is_int(settings["rank"]) or settings["rank"] not in RANKS:
        return "rank must be one of %s" % ", ".join(str(r) for r in RANKS)
    if not _is_number(settings["learning_rate"]) or not (LEARNING_RATE[0] <= settings["learning_rate"] <= LEARNING_RATE[1]):
        return "learning_rate is out of range"
    if not _is_int(settings["epochs"]) or not (EPOCHS[0] <= settings["epochs"] <= EPOCHS[1]):
        return "epochs is out of range"
    if not _is_int(settings["batch_size"]) or not (BATCH_SIZE[0] <= settings["batch_size"] <= BATCH_SIZE[1]):
        return "batch_size is out of range"
    salt = job.get("split_salt")
    if not isinstance(salt, str) or re.fullmatch(SALT_PATTERN, salt) is None:
        return "split_salt must be 16 to 64 hex characters"
    budget = job.get("budget_usd")
    if not _is_number(budget) or budget <= 0 or budget > HARD_RUN_USD:
        return "budget_usd must be above 0 and at most %s" % HARD_RUN_USD
    prices = job.get("prices")
    if not isinstance(prices, dict) or any(not _is_number(prices.get(k)) or prices.get(k) <= 0 for k in ("train", "sample", "prefill")):
        return "prices must hold train, sample and prefill, each above 0"
    ttl = job.get("ttl_seconds")
    if not _is_int(ttl) or ttl < MIN_TTL_S or ttl > MAX_TTL_S:
        return "ttl_seconds must be from %d to %d" % (MIN_TTL_S, MAX_TTL_S)
    if not _is_int(job.get("samples")) or not (0 <= job["samples"] <= MAX_SAMPLES):
        return "samples must be from 0 to %d" % MAX_SAMPLES
    if not _is_int(job.get("sample_max_tokens")) or not (1 <= job["sample_max_tokens"] <= MAX_SAMPLE_TOKENS):
        return "sample_max_tokens must be from 1 to %d" % MAX_SAMPLE_TOKENS
    steps = int(math.ceil((len(examples) - holdout_count(len(examples))) / float(settings["batch_size"]))) * settings["epochs"]
    if steps > MAX_STEPS:
        return "these settings need %d optimizer steps and a run may take %d" % (steps, MAX_STEPS)
    return None


def _order(n: int, salt: str, tag: str) -> list:
    """The numbers 0..n-1 in an order fixed by the salt: sorted by a hash of salt, tag and index."""
    return sorted(range(n), key=lambda i: hashlib.sha256(("%s:%s:%d" % (salt, tag, i)).encode("utf-8")).hexdigest())


def split_indexes(n: int, salt: str):
    """(train indexes, held-out indexes). Deterministic for a salt; a different salt gives a different split."""
    order = _order(n, salt, "split")
    k = holdout_count(n)
    return sorted(order[k:]), sorted(order[:k])


def plan_batches(train: list, batch_size: int, epochs: int, salt: str) -> list:
    """Batches of example indexes, epoch after epoch, each epoch in its own order fixed by the salt."""
    batches = []
    for epoch in range(epochs):
        shuffled = [train[i] for i in _order(len(train), salt, "epoch%d" % epoch)]
        for start in range(0, len(shuffled), batch_size):
            batches.append(shuffled[start:start + batch_size])
    return batches


def cost_usd(tokens: dict, prices: dict) -> float:
    """What token counts cost at the published prices (US dollars per million tokens). An estimate, not a bill."""
    return ((tokens.get("train", 0) + tokens.get("eval", 0)) * prices["train"]
            + tokens.get("sample_prompt", 0) * prices["prefill"]
            + tokens.get("sample_completion", 0) * prices["sample"]) / 1e6


def closing_tokens(lengths: list, holdout: list, prompt_lengths: list, sample_max_tokens: int) -> dict:
    """Tokens the last measurement and the samples take, whatever happens before them."""
    return {
        "eval": sum(lengths[i] for i in holdout),
        "sample_prompt": sum(prompt_lengths),
        "sample_completion": sample_max_tokens * len(prompt_lengths),
    }


def planned_tokens(lengths: list, batches: list, holdout: list, prompt_lengths: list, sample_max_tokens: int) -> dict:
    """Tokens the whole plan takes: every training batch, two passes over the held-out slice, and the samples."""
    closing = closing_tokens(lengths, holdout, prompt_lengths, sample_max_tokens)
    return {
        "train": sum(lengths[i] for batch in batches for i in batch),
        "eval": 2 * closing["eval"],
        "sample_prompt": closing["sample_prompt"],
        "sample_completion": closing["sample_completion"],
    }


def example_loss(logprobs: list, weights: list) -> Optional[float]:
    """Mean cross-entropy per trained token of one example: minus the weighted mean log probability."""
    total = 0.0
    weight = 0.0
    for logprob, w in zip(logprobs, weights):
        if w:
            total += -float(logprob) * float(w)
            weight += float(w)
    return total / weight if weight > 0 else None


def mean_loss(losses: list) -> Optional[float]:
    """The mean over examples, each counted once."""
    kept = [x for x in losses if x is not None and math.isfinite(x)]
    return sum(kept) / len(kept) if kept else None


def valid_run_id(value) -> bool:
    """Is this a name the lab gives a run?"""
    return isinstance(value, str) and re.fullmatch(RUN_ID_PATTERN, value) is not None


def known_call(names, run_id) -> Optional[str]:
    """The call already started under a run's name, or None. A store that fails knows nothing."""
    if names is None or not valid_run_id(run_id):
        return None
    try:
        value = names.get(run_id)
    except Exception:  # noqa: BLE001
        return None
    return value if isinstance(value, str) and re.fullmatch(CALL_ID_PATTERN, value) is not None else None


def start_once(run_id, names, spawn, log=print) -> str:
    """Starts a run and returns its call id; for a name that already has a call, returns that call and starts nothing.

    `names` maps a run's name to its call id (a Modal Dict, or None). It is
    never a gate: a store that cannot be read or written does not stop the run.
    """
    known = known_call(names, run_id)
    if known:
        return known
    call_id = spawn()
    if names is not None and valid_run_id(run_id):
        try:
            names.put(run_id, call_id)
        except Exception as exc:  # noqa: BLE001
            log("could not remember the call for run %s: %s" % (run_id, type(exc).__name__))
    return call_id


def scrub(text, secrets=()) -> str:
    """Error text with any of the given secret values taken out, cut to its last 300 characters."""
    out = str(text)
    for secret in secrets:
        if secret and len(secret) >= 8:
            out = out.replace(secret, "[redacted]")
    return out[-300:]


def _short(text, limit: int) -> str:
    return " ".join(str(text).split())[:limit]


def run_core(job, make_deps, clock=time.time, log=print) -> dict:
    """The whole run, with the training service behind `make_deps`.

    `make_deps(job)` is called only after the job has been checked. It returns
    an object with: datum(conversation) -> (datum, tokens, weights);
    prompt(conversation) -> (prompt, tokens); forward(datums) -> logprobs per
    datum; forward_backward(datums, learning_rate) -> logprobs per datum;
    save(ttl_seconds) -> sampler path; sample(path, prompt, max_tokens) ->
    (text, completion tokens); secrets() -> values to scrub from error text.
    Never raises: a failure is returned as {"status": "error"}.
    """
    started = clock()
    tokens = {"train": 0, "eval": 0, "sample_prompt": 0, "sample_completion": 0}
    state = {"stage": "input"}
    progress = {}
    secrets = []

    def done(result: dict) -> dict:
        out = dict(progress)
        out.update(result)
        out["tokens"] = dict(tokens)
        out["wall_seconds"] = round(clock() - started, 1)
        return out

    def refused(reason: str) -> dict:
        return done({"status": "refused", "stage": state["stage"], "reason": reason})

    try:
        problem = check_job(job)
        if problem:
            return refused(problem)
        examples = job["examples"]
        settings = job["settings"]
        prices = job["prices"]
        budget = float(job["budget_usd"])
        train, holdout = split_indexes(len(examples), job["split_salt"])
        progress.update({"n_train": len(train), "n_holdout": len(holdout)})

        state["stage"] = "client"
        deps = make_deps(job)
        secrets = list(deps.secrets())

        # Real tokens, before anything is trained.
        state["stage"] = "tokens"
        datums, lengths, weights = [], [], []
        for i, example in enumerate(examples):
            datum, length, w = deps.datum(example["messages"])
            if length > MAX_EXAMPLE_TOKENS:
                return refused("examples[%d] is %d tokens and an example may be %d" % (i, length, MAX_EXAMPLE_TOKENS))
            if not any(w):
                return refused("examples[%d] has nothing to train on" % i)
            datums.append(datum)
            lengths.append(length)
            weights.append(w)
        sample_at = holdout[:job["samples"]]
        prompts = [deps.prompt(examples[i]["messages"][:-1]) for i in sample_at]
        prompt_lengths = [p[1] for p in prompts]

        state["stage"] = "budget"
        batches = plan_batches(train, settings["batch_size"], settings["epochs"], job["split_salt"])
        progress["steps_planned"] = len(batches)
        plan = planned_tokens(lengths, batches, holdout, prompt_lengths, job["sample_max_tokens"])
        plan_cost = cost_usd(plan, prices)
        if plan_cost > budget:
            return refused("the tokenized plan costs $%.4f at the published prices, more than the $%.4f set aside" % (plan_cost, budget))
        closing = closing_tokens(lengths, holdout, prompt_lengths, job["sample_max_tokens"])

        def measure() -> Optional[float]:
            losses = []
            for start in range(0, len(holdout), EVAL_BATCH):
                chunk = holdout[start:start + EVAL_BATCH]
                tokens["eval"] += sum(lengths[i] for i in chunk)
                outputs = deps.forward([datums[i] for i in chunk])
                losses.extend(example_loss(lp, weights[i]) for lp, i in zip(outputs, chunk))
            return mean_loss(losses)

        state["stage"] = "baseline"
        before = measure()
        if before is None:
            return done({"status": "error", "stage": state["stage"], "error": "the held-out loss could not be measured"})
        progress["holdout_loss_before"] = before
        log("held-out loss before training: %.4f on %d examples" % (before, len(holdout)))

        state["stage"] = "train"
        steps = 0
        stopped = None
        progress["steps_done"] = 0
        for batch in batches:
            if steps >= MAX_STEPS:
                stopped = "the step limit of %d" % MAX_STEPS
                break
            if clock() - started > TRAIN_WALL_S:
                stopped = "the time limit of %d s for training" % TRAIN_WALL_S
                break
            need = sum(lengths[i] for i in batch)
            ahead = dict(tokens)
            ahead["train"] += need
            for key in closing:
                ahead[key] += closing[key]
            if cost_usd(ahead, prices) > budget:
                stopped = "the budget: one more step would pass the $%.4f set aside" % budget
                break
            tokens["train"] += need
            outputs = deps.forward_backward([datums[i] for i in batch], settings["learning_rate"])
            loss = mean_loss([example_loss(lp, weights[i]) for lp, i in zip(outputs, batch)])
            steps += 1
            progress["steps_done"] = steps
            if loss is not None:
                if "train_loss_first" not in progress:
                    progress["train_loss_first"] = loss
                progress["train_loss_last"] = loss
            if steps == 1 or steps % 10 == 0:
                log("step %d of %d: train loss %s" % (steps, len(batches), "%.4f" % loss if loss is not None else "unknown"))
        progress["stopped_early"] = stopped
        if steps == 0:
            return done({"status": "error", "stage": state["stage"], "error": "no training step was done (%s)" % (stopped or "nothing to train")})

        state["stage"] = "measure"
        after = measure()
        if after is None:
            return done({"status": "error", "stage": state["stage"], "error": "the held-out loss could not be measured after training"})
        progress["holdout_loss_after"] = after
        log("held-out loss after training: %.4f" % after)

        state["stage"] = "save"
        path = deps.save(job["ttl_seconds"])
        if not isinstance(path, str) or not path.startswith("tinker://"):
            return done({"status": "error", "stage": state["stage"], "error": "the adapter was not saved"})
        progress["sampler_path"] = path
        progress["ttl_seconds"] = job["ttl_seconds"]

        # Samples are extra: a failure here does not undo a run that trained, was measured and was saved.
        state["stage"] = "sample"
        samples = []
        for i, (prompt, prompt_tokens) in zip(sample_at, prompts):
            try:
                tokens["sample_prompt"] += prompt_tokens
                text, used = deps.sample(path, prompt, job["sample_max_tokens"])
                tokens["sample_completion"] += int(used)
                question = [m["content"] for m in examples[i]["messages"] if m["role"] == "user"][-1]
                samples.append({"prompt": _short(question, 300), "completion": _short(text, 600)})
            except Exception as exc:  # noqa: BLE001
                log("a sample failed: %s" % scrub(exc, secrets))
                break
        return done({"status": "ok", "samples": samples})
    except Exception as exc:  # noqa: BLE001
        return done({"status": "error", "stage": state["stage"], "error": scrub(exc, secrets)})


# ---------------------------------------------------------------------------
# The training service, as run_core uses it
# ---------------------------------------------------------------------------

class TinkerDeps:
    """Tinker behind the few calls run_core makes. The SDK reads TINKER_API_KEY from the environment itself."""

    def __init__(self, job: dict):
        import tinker
        from tinker_cookbook.renderers import TrainOnWhat, get_renderer, get_text_content
        from tinker_cookbook.supervised.data import conversation_to_datum

        self._tinker = tinker
        self._train_on = TrainOnWhat.LAST_ASSISTANT_MESSAGE
        self._to_datum = conversation_to_datum
        self._text = get_text_content
        self._client = self.open_client(job)
        self._renderer = get_renderer(RENDERERS[job["base_model"]], self.tokenizer())
        self._sampler = None

    def open_client(self, job: dict):
        service = self._tinker.ServiceClient()
        return service.create_lora_training_client(
            base_model=job["base_model"], rank=job["settings"]["rank"],
            user_metadata={"source": "observable-lab", "label": _short(job.get("label", ""), 80)},
        ).result(timeout=CALL_TIMEOUT_S)

    def tokenizer(self):
        return self._client.get_tokenizer()

    def secrets(self) -> list:
        return [os.environ.get("TINKER_API_KEY", "")]

    def datum(self, conversation: list):
        # Nothing is cut to fit: max_length is off and run_core refuses an example that is too long.
        datum = self._to_datum(conversation, self._renderer, max_length=None, train_on_what=self._train_on)
        return datum, int(datum.model_input.length), [float(w) for w in datum.loss_fn_inputs["weights"].tolist()]

    def prompt(self, conversation: list):
        prompt = self._renderer.build_generation_prompt(conversation)
        return prompt, int(prompt.length)

    def forward(self, datums: list) -> list:
        result = self._client.forward(datums, "cross_entropy").result(timeout=CALL_TIMEOUT_S)
        return [out["logprobs"].tolist() for out in result.loss_fn_outputs]

    def forward_backward(self, datums: list, learning_rate: float) -> list:
        # Both are submitted before either is waited for, as Tinker's own loop does.
        gradients = self._client.forward_backward(datums, "cross_entropy")
        update = self._client.optim_step(self._tinker.AdamParams(learning_rate=learning_rate))
        result = gradients.result(timeout=CALL_TIMEOUT_S)
        update.result(timeout=CALL_TIMEOUT_S)
        return [out["logprobs"].tolist() for out in result.loss_fn_outputs]

    def save(self, ttl_seconds: int) -> str:
        return self._client.save_weights_for_sampler("final", ttl_seconds=ttl_seconds).result(timeout=CALL_TIMEOUT_S).path

    def sample(self, path: str, prompt, max_tokens: int):
        if self._sampler is None:
            self._sampler = self._client.create_sampling_client(path).result(timeout=CALL_TIMEOUT_S)
        params = self._tinker.SamplingParams(
            max_tokens=max_tokens, temperature=SAMPLE_TEMPERATURE, stop=self._renderer.get_stop_sequences(),
        )
        result = self._sampler.sample(prompt=prompt, num_samples=1, sampling_params=params).result(timeout=CALL_TIMEOUT_S)
        sampled = list(result.sequences[0].tokens)
        message, _ = self._renderer.parse_response(sampled)
        return self._text(message), len(sampled)


@app.function(image=train_image, secrets=[modal.Secret.from_name("oblab-tinker-auth")], timeout=RUN_TIMEOUT_S, retries=0,
              max_containers=2, cpu=(1, 2), memory=(2048, 8192))
def train(job: dict) -> dict:
    """One fine-tuning run. Lab code only; the job is data. The result never carries the Tinker key."""
    return run_core(job, TinkerDeps)


# ---------------------------------------------------------------------------
# HTTP endpoints for the lab server
# ---------------------------------------------------------------------------

def _run_names():
    """The Modal Dict of run name -> call id. None if it cannot even be named; reads and writes are guarded where it is used."""
    try:
        return modal.Dict.from_name(RUNS_DICT, create_if_missing=True)
    except Exception:  # noqa: BLE001
        return None


def _authed(token: str) -> bool:
    expected = os.environ.get("JOBS_TOKEN", "")
    return len(expected.encode()) >= 32 and hmac.compare_digest(token.encode(), ("Bearer %s" % expected).encode())


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-tinker-jobs-auth")])
@modal.fastapi_endpoint(method="POST")
def start(body: dict, request: Request) -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    job = body.get("train") if isinstance(body, dict) else None
    problem = check_job(job)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    run_id = body.get("run_id")
    if run_id is not None and not valid_run_id(run_id):
        raise HTTPException(status_code=400, detail="run_id is not a run name")
    return {"call_id": start_once(run_id, _run_names(), lambda: train.spawn(job).object_id)}


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-tinker-jobs-auth")])
@modal.fastapi_endpoint(method="GET")
def status(request: Request, call_id: str = "", run_id: str = "") -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not call_id and run_id:
        # Asked by the run's name: the lab never got the call id.
        call_id = known_call(_run_names(), run_id) or ""
        if not call_id:
            return {"status": "unknown", "error": "no call is known for that run"}
    if not call_id:
        return {"error": "call_id required"}
    if re.fullmatch(CALL_ID_PATTERN, call_id) is None:
        return {"status": "failed", "error": "that is not a call id"}
    try:
        fc = modal.FunctionCall.from_id(call_id)
        return {"status": "done", "call_id": call_id, "result": fc.get(timeout=0)}
    except OutputExpiredError:
        return {"status": "failed", "call_id": call_id, "error": "the run's result expired before it was collected"}
    except TimeoutError:
        return {"status": "running", "call_id": call_id}
    except Exception as e:  # noqa: BLE001
        return {"status": "failed", "call_id": call_id, "error": str(e)[-300:]}
