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
# Keeping an adapter (docs/TOOLS.md, "Keeping a trained adapter"). When the
# lab server asks, `keeper` sets a long time to live on an adapter's sampler
# checkpoint, so it goes on answering, and writes a copy of its LoRA weights
# to the lab's own Modal Volume "oblab-kept-models", in PEFT format when the
# cookbook's conversion works, with the lab's manifest of the run beside it.
# Tinker only lets weights be downloaded that were saved for download by the
# training run itself (save_weights_external), so `train` saves them that way
# when the lab asks for it ("export": true), and an adapter trained without
# that has no copy: its life is extended and the answer says so. `keeper`
# also undoes a keep (the usual time to live again; the copy is removed only
# when asked). It has the Tinker key, like `train`, and runs lab code only.
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
#                          prices, ttl_seconds, samples, sample_max_tokens, label, export?}}  -> {call_id}
#   POST /start   {run_id, keep: {slug, base_model, sampler_path, external_path, ttl_seconds,
#                          max_bytes, manifest}}                                    -> {call_id}
#   POST /start   {run_id, unkeep: {slug, sampler_path, external_path, ttl_seconds, remove_copy}} -> {call_id}
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
#          sampler_path, ttl_seconds, samples: [{prompt, completion}], wall_seconds,
#          external_path? (the weights saved for download, when asked) | export_error?}
#       | {status: refused, stage, reason, tokens, wall_seconds}
#       | {status: error, stage, error, tokens, ..., wall_seconds}
#
# result of a keep or an unkeep:
#         {status: ok, ttl_seconds, checkpoints, wall_seconds,
#          copy: {status: ok, format: peft | tinker, dir, bytes, files: [{path, bytes, sha256}], reason?}
#              | {status: none | error, reason}}
#       | {status: refused | error, stage, reason | error, wall_seconds}
#
# Every import at the top of this file must be installed in every image below,
# and must import on Python 3.9 (the deploying Mac's Modal may run on it). The
# Tinker SDK needs Python 3.11, so it is imported inside TinkerDeps only.

import hashlib
import hmac
import json
import math
import os
import re
import shutil
import tempfile
import time
import urllib.request
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

# Keeping an adapter. The lab server sends the same limits; these hold whatever it sends.
KEPT_VOLUME = "oblab-kept-models"
KEPT_DIR = "/kept"
# The lab's name for one attempt to keep ("k") or unkeep ("u") an adapter.
KEEP_ID_PATTERN = r"[ku]-e[0-9]{1,6}-[0-9a-f]{8}-[0-9a-f]{8}"
SAMPLER_PATH_PATTERN = r"tinker://([A-Za-z0-9][A-Za-z0-9._:-]{0,200})/sampler_weights/[A-Za-z0-9][A-Za-z0-9._-]{0,100}"
EXTERNAL_PATH_PATTERN = r"tinker://([A-Za-z0-9][A-Za-z0-9._:-]{0,200})/external_weights/[A-Za-z0-9][A-Za-z0-9._-]{0,100}"
# Tinker takes a time to live from one hour to ten years.
MAX_KEEP_TTL_S = 10 * 365 * 24 * 3600
# The most one copy may weigh, whatever the lab server sends, and how many files it may hold.
HARD_KEEP_BYTES = 4096 * 1024 * 1024
MAX_KEEP_FILES = 16
MANIFEST_MAX_BYTES = 20000
MANIFEST_NAME = "lab_manifest.json"
KEEP_FILE_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}"
KEEP_TIMEOUT_S = 900
DOWNLOAD_TIMEOUT_S = 300

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
    if "export" in job and not isinstance(job["export"], bool):
        return "export must be true or false"
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
    """Is this a name the lab gives a run, or an attempt to keep or unkeep an adapter?"""
    return isinstance(value, str) and (re.fullmatch(RUN_ID_PATTERN, value) is not None or re.fullmatch(KEEP_ID_PATTERN, value) is not None)


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
    (text, completion tokens); secrets() -> values to scrub from error text;
    and, used only when the job says "export": true, save_external(ttl_seconds)
    -> the path of the weights saved for download.
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

        # The same weights in the form Tinker lets be downloaded, only when the
        # lab asked for them (adapters can be kept). Extra, like the samples: a
        # failure here does not undo a run that trained, was measured and was saved.
        if job.get("export") is True:
            state["stage"] = "export"
            try:
                external = deps.save_external(job["ttl_seconds"])
                if isinstance(external, str) and re.fullmatch(EXTERNAL_PATH_PATTERN, external) is not None:
                    progress["external_path"] = external
                else:
                    progress["export_error"] = "the weights were not saved for download"
            except Exception as exc:  # noqa: BLE001
                progress["export_error"] = scrub(exc, secrets)
                log("saving the weights for download failed: %s" % progress["export_error"])

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

    def save_external(self, ttl_seconds: int) -> str:
        # Not encrypted: the copy goes to the lab's own Volume, read with the lab's own Tinker key.
        return self._client.save_weights_external("final", ttl_seconds=ttl_seconds).result(timeout=CALL_TIMEOUT_S).path

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
# Keeping an adapter: a long time to live on Tinker, and a copy on the lab's Volume
# ---------------------------------------------------------------------------

def _tinker_run(path, pattern) -> Optional[str]:
    """The training run a checkpoint path belongs to, or None when the path is not of that kind."""
    found = re.fullmatch(pattern, path) if isinstance(path, str) and len(path) <= 320 else None
    return found.group(1) if found else None


def check_keep(job) -> Optional[str]:
    """None when this is a keep the runner accepts, else a short reason. Runs nothing."""
    if not isinstance(job, dict):
        return "the keep is not an object"
    if not isinstance(job.get("slug"), str) or re.fullmatch(RUN_ID_PATTERN, job["slug"]) is None:
        return "slug is not an adapter's lab id"
    if job.get("base_model") not in RENDERERS:
        return "base_model is not one this runner trains"
    run = _tinker_run(job.get("sampler_path"), SAMPLER_PATH_PATTERN)
    if run is None:
        return "sampler_path is not a sampler checkpoint"
    external = job.get("external_path")
    if external is not None and _tinker_run(external, EXTERNAL_PATH_PATTERN) != run:
        return "external_path is not the downloadable weights of the same training run"
    ttl = job.get("ttl_seconds")
    if not _is_int(ttl) or ttl < MIN_TTL_S or ttl > MAX_KEEP_TTL_S:
        return "ttl_seconds must be from %d to %d" % (MIN_TTL_S, MAX_KEEP_TTL_S)
    if not _is_int(job.get("max_bytes")) or not (1 <= job["max_bytes"] <= HARD_KEEP_BYTES):
        return "max_bytes must be from 1 to %d" % HARD_KEEP_BYTES
    manifest = job.get("manifest")
    if not isinstance(manifest, dict):
        return "manifest must be an object"
    try:
        size = len(json.dumps(manifest).encode("utf-8"))
    except (TypeError, ValueError):
        return "manifest is not plain data"
    if size > MANIFEST_MAX_BYTES:
        return "manifest holds more than %d bytes" % MANIFEST_MAX_BYTES
    return None


def check_unkeep(job) -> Optional[str]:
    """None when this is an unkeep the runner accepts, else a short reason."""
    if not isinstance(job, dict):
        return "the unkeep is not an object"
    if not isinstance(job.get("slug"), str) or re.fullmatch(RUN_ID_PATTERN, job["slug"]) is None:
        return "slug is not an adapter's lab id"
    run = _tinker_run(job.get("sampler_path"), SAMPLER_PATH_PATTERN)
    if run is None:
        return "sampler_path is not a sampler checkpoint"
    external = job.get("external_path")
    if external is not None and _tinker_run(external, EXTERNAL_PATH_PATTERN) != run:
        return "external_path is not the downloadable weights of the same training run"
    ttl = job.get("ttl_seconds")
    if not _is_int(ttl) or ttl < MIN_TTL_S or ttl > MAX_KEEP_TTL_S:
        return "ttl_seconds must be from %d to %d" % (MIN_TTL_S, MAX_KEEP_TTL_S)
    if not isinstance(job.get("remove_copy"), bool):
        return "remove_copy must be true or false"
    return None


def safe_file_name(name) -> bool:
    """Is this a file path the runner will write under an adapter's folder? No "..", no hidden parts, no encrypted exports."""
    if not isinstance(name, str) or re.fullmatch(KEEP_FILE_PATTERN, name) is None:
        return False
    return ".." not in name and name != MANIFEST_NAME and not name.endswith(".age")


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def list_files(folder: str) -> list:
    """Every file under a folder but the manifest, as {path, bytes, sha256}, sorted by path. Links are not followed."""
    out = []
    for base, dirs, names in os.walk(folder):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(base, d))]
        for name in names:
            full = os.path.join(base, name)
            relative = os.path.relpath(full, folder).replace(os.sep, "/")
            if relative == MANIFEST_NAME or os.path.islink(full) or not os.path.isfile(full):
                continue
            out.append({"path": relative, "bytes": os.path.getsize(full), "sha256": _sha256_file(full)})
    return sorted(out, key=lambda item: item["path"])


def write_manifest(folder: str, manifest: dict, files: list, fmt: str, source, note, clock=time.time) -> None:
    """The lab's manifest of the run, with what the copy holds, beside the weights."""
    body = dict(manifest)
    body.update({
        "copy": {
            "format": fmt, "files": files, "bytes": sum(f["bytes"] for f in files), "source": source,
            "copied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock())), "note": note,
        },
    })
    with open(os.path.join(folder, MANIFEST_NAME), "w", encoding="utf-8") as handle:
        json.dump(body, handle, indent=2, sort_keys=True)
        handle.write("\n")


def copy_weights(job: dict, deps, root: str, scratch: str, clock=time.time, log=print, secrets=()) -> dict:
    """Puts a copy of the adapter's weights under <root>/<slug>/ and says what it did. Never raises.

    A copy already there (the adapter was kept before) is left as it is and
    only its manifest is written again. Otherwise the files Tinker exported
    are downloaded into `scratch`, converted to PEFT when that works, and
    moved into place in one step, so a half-written copy is never left under
    the adapter's name.
    """
    slug = job["slug"]
    final = os.path.join(root, slug)
    try:
        if os.path.isdir(final):
            files = list_files(final)
            if files:
                fmt = "tinker"
                try:
                    with open(os.path.join(final, MANIFEST_NAME), encoding="utf-8") as handle:
                        old = json.load(handle)
                    if isinstance(old, dict) and isinstance(old.get("copy"), dict) and old["copy"].get("format") == "peft":
                        fmt = "peft"
                except Exception:  # noqa: BLE001
                    pass
                note = "the copy made when it was kept before"
                write_manifest(final, job["manifest"], files, fmt, job.get("external_path"), note, clock)
                deps.commit()
                return {"status": "ok", "format": fmt, "dir": slug, "bytes": sum(f["bytes"] for f in files), "files": files, "reason": note}
        external = job.get("external_path")
        if not external:
            return {"status": "none", "reason": "this adapter was trained before keeping was switched on, so Tinker has no downloadable weights for it"}

        urls = deps.external_urls(external)
        if not isinstance(urls, dict) or not urls:
            return {"status": "error", "reason": "Tinker listed no files for the weights"}
        if len(urls) > MAX_KEEP_FILES:
            return {"status": "error", "reason": "Tinker listed %d files and a copy may hold %d" % (len(urls), MAX_KEEP_FILES)}
        for name, url in urls.items():
            if not safe_file_name(name):
                return {"status": "error", "reason": "Tinker listed a file the lab will not write"}
            if not isinstance(url, str) or not url.startswith("https://"):
                return {"status": "error", "reason": "Tinker gave a download address that is not https"}

        raw = os.path.join(scratch, "raw")
        left = int(job["max_bytes"])
        for name in sorted(urls):
            target = os.path.join(raw, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            got = deps.fetch(urls[name], target, left)
            if got is None:
                return {"status": "error", "reason": "the weights are larger than the %d bytes a copy may weigh" % job["max_bytes"]}
            left -= got

        fmt, note, source = "tinker", None, raw
        converted = os.path.join(scratch, "peft")
        try:
            deps.to_peft(job["base_model"], raw, converted)
            if list_files(converted):
                fmt, source = "peft", converted
            else:
                note = "not converted to PEFT: the conversion wrote no files"
        except Exception as exc:  # noqa: BLE001
            note = "not converted to PEFT: %s" % scrub(exc, secrets)
            log(note)
        files = list_files(source)
        if not files or any(not safe_file_name(f["path"]) for f in files) or len(files) > MAX_KEEP_FILES:
            return {"status": "error", "reason": "the copy held no usable files"}
        size = sum(f["bytes"] for f in files)
        if size > job["max_bytes"]:
            return {"status": "error", "reason": "the copy is %d bytes and may weigh %d" % (size, job["max_bytes"])}

        incoming = os.path.join(root, ".incoming-%s-%d" % (slug, int(clock() * 1000)))
        shutil.copytree(source, incoming, symlinks=False)
        write_manifest(incoming, job["manifest"], files, fmt, external, note, clock)
        if os.path.isdir(final):
            shutil.rmtree(final)
        os.replace(incoming, final)
        deps.commit()
        return {"status": "ok", "format": fmt, "dir": slug, "bytes": size, "files": files, "reason": note}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "reason": scrub(exc, secrets)}


def keep_core(job, make_deps, root=KEPT_DIR, clock=time.time, log=print) -> dict:
    """Keeps one adapter, with Tinker and the Volume behind `make_deps`.

    `make_deps()` is called only after the job has been checked. It returns an
    object with: set_ttl(path, ttl_seconds); checkpoint_count() -> how many
    checkpoints the account holds, or None; external_urls(path) -> {file:
    signed url}; fetch(url, target, max_bytes) -> bytes written, or None when
    the file is larger; to_peft(base_model, source, target); commit(); and
    secrets() -> values to scrub from error text.

    The adapter is kept when its time to live was set: that is what keeps it
    answering. The copy is reported beside it and never undoes the keep.
    Never raises.
    """
    started = clock()
    state = {"stage": "input"}
    secrets = []

    def done(result: dict) -> dict:
        result["wall_seconds"] = round(clock() - started, 1)
        return result

    try:
        problem = check_keep(job)
        if problem:
            return done({"status": "refused", "stage": state["stage"], "reason": problem})
        state["stage"] = "client"
        deps = make_deps()
        secrets = list(deps.secrets())

        state["stage"] = "ttl"
        deps.set_ttl(job["sampler_path"], job["ttl_seconds"])
        log("time to live of %s set to %d s" % (job["slug"], job["ttl_seconds"]))

        state["stage"] = "copy"
        scratch = tempfile.mkdtemp(prefix="oblab-keep-")
        try:
            copy = copy_weights(job, deps, root, scratch, clock, log, secrets)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        # The downloadable weights on Tinker are one more stored checkpoint.
        # Once the copy is on the Volume they are left to expire on their own.
        # If the copy failed, they are given the adapter's long life as well,
        # so that the copy can be made later.
        if copy["status"] == "error" and job.get("external_path"):
            try:
                deps.set_ttl(job["external_path"], job["ttl_seconds"])
                copy["reason"] = "%s; the downloadable weights stay on Tinker as long as the adapter, so the copy can be made later" % copy["reason"]
            except Exception as exc:  # noqa: BLE001
                log("could not extend the downloadable weights: %s" % scrub(exc, secrets))

        count = None
        try:
            count = deps.checkpoint_count()
        except Exception as exc:  # noqa: BLE001
            log("could not count checkpoints: %s" % scrub(exc, secrets))
        return done({
            "status": "ok", "ttl_seconds": job["ttl_seconds"], "copy": copy,
            "checkpoints": count if _is_int(count) and count >= 0 else None,
        })
    except Exception as exc:  # noqa: BLE001
        return done({"status": "error", "stage": state["stage"], "error": scrub(exc, secrets)})


def unkeep_core(job, make_deps, root=KEPT_DIR, clock=time.time, log=print) -> dict:
    """Undoes a keep: the usual time to live again, and the copy removed only when asked. Never raises."""
    started = clock()
    state = {"stage": "input"}
    secrets = []

    def done(result: dict) -> dict:
        result["wall_seconds"] = round(clock() - started, 1)
        return result

    try:
        problem = check_unkeep(job)
        if problem:
            return done({"status": "refused", "stage": state["stage"], "reason": problem})
        state["stage"] = "client"
        deps = make_deps()
        secrets = list(deps.secrets())
        state["stage"] = "ttl"
        deps.set_ttl(job["sampler_path"], job["ttl_seconds"])
        if job.get("external_path"):
            # Gone already, or never extended: either way there is nothing to undo.
            try:
                deps.set_ttl(job["external_path"], job["ttl_seconds"])
            except Exception as exc:  # noqa: BLE001
                log("the downloadable weights were not changed: %s" % scrub(exc, secrets))
        state["stage"] = "copy"
        final = os.path.join(root, job["slug"])
        if not job["remove_copy"]:
            reason = "The copy on the Volume was left where it is." if os.path.isdir(final) else "There is no copy on the Volume."
        elif os.path.isdir(final):
            shutil.rmtree(final)
            deps.commit()
            reason = "The copy on the Volume was removed."
        else:
            reason = "There was no copy on the Volume to remove."
        return done({"status": "ok", "ttl_seconds": job["ttl_seconds"], "copy": {"status": "none", "reason": reason}, "checkpoints": None})
    except Exception as exc:  # noqa: BLE001
        return done({"status": "error", "stage": state["stage"], "error": scrub(exc, secrets)})


def download_capped(url: str, target: str, max_bytes: int, opener=None) -> Optional[int]:
    """Downloads one https file to `target`. Returns the bytes written, or None (and no file) when it is larger than max_bytes."""
    if not url.startswith("https://"):
        raise ValueError("not an https address")
    written = 0
    request = urllib.request.Request(url, headers={"User-Agent": "observable-lab-runner"})
    with (opener or urllib.request.urlopen)(request, timeout=DOWNLOAD_TIMEOUT_S) as response, open(target, "wb") as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                out.close()
                os.remove(target)
                return None
            out.write(chunk)
    return written


class KeepDeps:
    """Tinker's checkpoint calls and the Volume, as keep_core and unkeep_core use them. The SDK reads TINKER_API_KEY itself."""

    def __init__(self):
        import tinker

        # A RestClient opens no training session, so keeping costs no tokens.
        self._rest = tinker.RestClient()

    def secrets(self) -> list:
        return [os.environ.get("TINKER_API_KEY", "")]

    def set_ttl(self, path: str, ttl_seconds: int) -> None:
        self._rest.set_checkpoint_ttl_from_tinker_path(path, ttl_seconds).result(timeout=CALL_TIMEOUT_S)

    def checkpoint_count(self) -> Optional[int]:
        response = self._rest.list_user_checkpoints(limit=1).result(timeout=CALL_TIMEOUT_S)
        cursor = getattr(response, "cursor", None)
        total = getattr(cursor, "total_count", None)
        return int(total) if total is not None else None

    def external_urls(self, path: str) -> dict:
        return dict(self._rest.get_external_weights_urls(path).result(timeout=CALL_TIMEOUT_S).urls)

    def fetch(self, url: str, target: str, max_bytes: int) -> Optional[int]:
        return download_capped(url, target, max_bytes)

    def to_peft(self, base_model: str, source: str, target: str) -> None:
        from tinker_cookbook import weights

        # Reads the base model's configuration from Hugging Face (no weights). No code from the repository is run.
        weights.build_lora_adapter(base_model=base_model, adapter_path=source, output_path=target, trust_remote_code=False)

    def commit(self) -> None:
        kept_volume.commit()


kept_volume = modal.Volume.from_name(KEPT_VOLUME, create_if_missing=True)


@app.function(image=train_image, secrets=[modal.Secret.from_name("oblab-tinker-auth")], volumes={KEPT_DIR: kept_volume},
              timeout=KEEP_TIMEOUT_S, retries=0, max_containers=1, cpu=(1, 2), memory=(2048, 8192))
def keeper(job: dict) -> dict:
    """Keeps or unkeeps one adapter. Lab code only; the job is data. One at a time, so two never write the Volume together."""
    kept_volume.reload()
    if isinstance(job, dict) and job.get("action") == "unkeep":
        return unkeep_core(job.get("unkeep"), KeepDeps)
    return keep_core(job.get("keep") if isinstance(job, dict) else None, KeepDeps)


# ---------------------------------------------------------------------------
# HTTP endpoints for the lab server
# ---------------------------------------------------------------------------

def _run_names():
    """The Modal Dict of run name -> call id. None if it cannot even be named; reads and writes are guarded where it is used."""
    try:
        return modal.Dict.from_name(RUNS_DICT, create_if_missing=True)
    except Exception:  # noqa: BLE001
        return None


def read_start(body) -> dict:
    """What a start asks for: {"kind", "job", "run_id"}, or {"problem"} when it is not something this runner starts.

    Exactly one of "train", "keep" and "unkeep". A training run's name is the
    adapter's lab id; a keep's or an unkeep's is "k-" or "u-", that id, and a
    few hex characters, and it is required, so the lab can always find it again.
    """
    if not isinstance(body, dict):
        return {"problem": "the body is not an object"}
    kinds = [k for k in ("train", "keep", "unkeep") if k in body]
    if len(kinds) != 1:
        return {"problem": "the job is not an object" if not kinds else "a start holds one of train, keep and unkeep"}
    kind = kinds[0]
    job = body[kind]
    problem = check_job(job) if kind == "train" else check_keep(job) if kind == "keep" else check_unkeep(job)
    if problem:
        return {"problem": problem}
    run_id = body.get("run_id")
    if kind == "train":
        if run_id is not None and (not isinstance(run_id, str) or re.fullmatch(RUN_ID_PATTERN, run_id) is None):
            return {"problem": "run_id is not a run name"}
    elif not isinstance(run_id, str) or re.fullmatch(KEEP_ID_PATTERN, run_id) is None \
            or not run_id.startswith("%s-%s-" % (kind[0], job["slug"])):
        return {"problem": "run_id is not the name of a keep of that adapter"}
    return {"kind": kind, "job": job, "run_id": run_id}


def _authed(token: str) -> bool:
    expected = os.environ.get("JOBS_TOKEN", "")
    return len(expected.encode()) >= 32 and hmac.compare_digest(token.encode(), ("Bearer %s" % expected).encode())


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-tinker-jobs-auth")])
@modal.fastapi_endpoint(method="POST")
def start(body: dict, request: Request) -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    work = read_start(body)
    if "problem" in work:
        raise HTTPException(status_code=400, detail=work["problem"])
    run_id = work["run_id"]
    if work["kind"] == "train":
        return {"call_id": start_once(run_id, _run_names(), lambda: train.spawn(work["job"]).object_id)}
    # A keep or an unkeep: the same remembered start, on the function that holds the Volume.
    return {"call_id": start_once(run_id, _run_names(), lambda: keeper.spawn({"action": work["kind"], work["kind"]: work["job"]}).object_id)}


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
