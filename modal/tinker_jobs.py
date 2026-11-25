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
import unicodedata
import urllib.request
from typing import Optional  # the deploying Mac may run Python 3.9, which has no "X | None"

import modal
from fastapi import HTTPException, Request
from modal.exception import OutputExpiredError

APP_NAME = "oblab-tinker"

# The base models this runner will train, and the chat format each is trained
# and sampled in. For the Qwen models it is the cookbook's renderer without
# the thinking block, so the adapter answers directly. Inkling 2 Mini has one
# renderer, "tml_v0", with no switch for thinking; it takes a thinking effort
# from 0.0 to just under 1.0 instead (RENDER_EFFORT below). The lab server has
# the same four ids with their prices (api/_lib/tinker.ts). Any other base
# model is refused.
RENDERERS = {
    "Qwen/Qwen3.5-4B": "qwen3_5_disable_thinking",
    "Qwen/Qwen3.5-9B": "qwen3_5_disable_thinking",
    "Qwen/Qwen3.6-35B-A3B": "qwen3_5_disable_thinking",
    "thinkingmachines/Inkling-2-Mini": "tml_v0",
}

# The tokenizer class each effort-taking renderer must wrap (tinker-cookbook 0.7.x, tml-renderers). Inkling 2 uses h200k.
TOKENIZER_CLASS = {"tml_v0": "H200kBaseChatTokenizer"}

# Renderers that take a thinking effort, and the one the runner uses for both
# training and sampling. 0.0 is the "none" level of Tinker's thinking-effort
# page: the model is conditioned toward no reasoning (it is not a hard
# guarantee). The cookbook's generic data builders render at its default of
# 0.9, so the runner passes the effort itself (FixedEffortRenderer): training
# and sampling must show the model the same prefix.
RENDER_EFFORT = {"tml_v0": 0.0}

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
# Converting a copy to PEFT needs the base model's config and the names and
# shapes of its weights, never the weights. The runner reads those from the
# public Hugging Face repository: config.json, and the header of each
# safetensors file. A header is a few hundred KB; the weights are gigabytes.
HF_HOST = "https://huggingface.co"
HF_TIMEOUT_S = 60
HF_REVISION_PATTERN = r"[0-9a-f]{40}"
BASE_SHARD_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.safetensors"
BASE_LISTING_MAX_BYTES = 8 * 1024 * 1024
BASE_CONFIG_MAX_BYTES = 1024 * 1024
BASE_HEADERS_MAX_BYTES = 64 * 1024 * 1024
BASE_MAX_SHARDS = 200

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
        "tinker-cookbook==0.7.1",
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


# ---------------------------------------------------------------------------
# The rubric engine for RL runs (the twin of api/_lib/rubric.ts)
#
# A rubric is a short list of rules from a fixed menu, each with a weight. A
# rule gives 0 or 1; the score is the weighted sum clamped to [0, 1]. The two
# languages are checked against one file of cases (tests/fixtures/rubric-cases.json).
# regex_match uses a small automaton the lab compiles itself and steps once per
# character, so no pattern can make it run long. Nothing a model wrote is run.
# These are functions and constants only, so the tests can load them alone.
# ---------------------------------------------------------------------------

RUBRIC_TYPES = ("exact_match", "contains", "not_contains", "number_close", "regex_match", "json_valid", "length_between")
RUBRIC_MAX_RULES = 8
RUBRIC_STRING_MAX = 200
RUBRIC_LIST_MAX = 20
RUBRIC_REGEX_MAX_LEN = 120
RUBRIC_REGEX_MAX_STATES = 120
# Calls the compiler may make while it counts a pattern's repeats out, however small the program stays.
RUBRIC_REGEX_MAX_EMITS = 2000
# Steps the matcher may take on one text. Past it the rule scores 0, the same in the TypeScript twin.
RUBRIC_REGEX_MAX_WORK = 100000
RUBRIC_MAX_REGEX_RULES = 3
RUBRIC_REPEAT_MAX = 16
RUBRIC_TEXT_MAX = 4000
RUBRIC_LENGTH_MAX = 4000
RUBRIC_TOLERANCE_MAX = 1e9
RUBRIC_JSON_TYPES = ("object", "array", "string", "number", "integer", "boolean", "null")
RUBRIC_WS = (32, 9, 10, 11, 12, 13)
DATA_KEY_PATTERN = r"[A-Za-z0-9_]{1,24}"
_RX_DIGIT = ((48, 57),)
_RX_WORD = ((48, 57), (65, 90), (95, 95), (97, 122))
_RX_SPACE = ((9, 13), (32, 32))
_RX_PUNCT_ESCAPES = "\\/.-()[]{}*+?|^$"


def rubric_strip(text: str) -> str:
    """Strips space, tab, newline, vertical tab, form feed and carriage return from both ends, and nothing else."""
    a = 0
    b = len(text)
    while a < b and ord(text[a]) in RUBRIC_WS:
        a += 1
    while b > a and ord(text[b - 1]) in RUBRIC_WS:
        b -= 1
    return text[a:b]


def ascii_lower(text: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in text)


def _nfkc(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


def normalise_text(text: str) -> str:
    """Whitespace runs to one space, quotes and ending punctuation off both ends, ASCII letters lower case."""
    flat = []
    space = False
    for c in _nfkc(text):
        if ord(c) in RUBRIC_WS:
            space = True
            continue
        if space and flat:
            flat.append(" ")
        space = False
        flat.append(c)
    a = 0
    b = len(flat)
    while a < b and flat[a] in "\"'`":
        a += 1
    while b > a and flat[b - 1] in "\"'`.,;:!?":
        b -= 1
    return rubric_strip(ascii_lower("".join(flat[a:b])))


def scope_text(text: str, scope) -> str:
    whole = rubric_strip(text)
    if not scope or scope == "whole":
        return whole
    lines = [rubric_strip(line) for line in whole.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    return lines[0] if scope == "first_line" else lines[-1]


def _is_digit(text: str, i: int) -> bool:
    return 0 <= i < len(text) and "0" <= text[i] <= "9"


def numbers_in(text: str) -> list:
    """The numbers in a text, in order. Same reading as numbersIn in api/_lib/rubric.ts."""
    out = []
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        start = i
        signed = False
        if c in "+-" and (_is_digit(text, i + 1) or (i + 1 < n and text[i + 1] == "." and _is_digit(text, i + 2))):
            before = text[i - 1] if i > 0 else ""
            glued = before != "" and (("0" <= before <= "9") or before == "." or ("A" <= before <= "Z") or ("a" <= before <= "z"))
            if glued:
                i += 1
                continue
            signed = True
            i += 1
        elif not _is_digit(text, i) and not (c == "." and _is_digit(text, i + 1)):
            i += 1
            continue
        digits = ""
        run = 0
        grouped = False
        while True:
            if _is_digit(text, i):
                digits += text[i]
                run += 1
                i += 1
                continue
            if (i < n and text[i] == "," and run >= 1 and (run == 3 if grouped else run <= 3)
                    and _is_digit(text, i + 1) and _is_digit(text, i + 2) and _is_digit(text, i + 3) and not _is_digit(text, i + 4)):
                digits += text[i + 1:i + 4]
                i += 4
                grouped = True
                run = 3
                continue
            break
        fraction = ""
        if i < n and text[i] == "." and _is_digit(text, i + 1):
            i += 1
            while _is_digit(text, i):
                fraction += text[i]
                i += 1
        value = float("%s%s" % (digits or "0", "." + fraction if fraction else ""))
        if math.isfinite(value):
            out.append(-value if signed and text[start] == "-" else value)
    return out


def _can_be_empty(n) -> bool:
    """Can this part match without using up a character? A repeat of such a part would do work for nothing, so it is refused."""
    kind = n[0]
    if kind in ("char", "any", "class"):
        return False
    if kind in ("bol", "eol"):
        return True
    if kind == "cat":
        return all(_can_be_empty(part) for part in n[1])
    if kind == "alt":
        return any(_can_be_empty(option) for option in n[1])
    return n[2] == 0 or _can_be_empty(n[1])  # rep


def compile_regex(pattern: str, ignore_case: bool = False):
    """(program, None) for a pattern in the safe subset, or (None, reason). The program is a list of tuples."""
    if not isinstance(pattern, str) or not pattern:
        return None, "the pattern is empty"
    p = [ord(c) for c in pattern]
    if len(p) > RUBRIC_REGEX_MAX_LEN:
        return None, "the pattern is longer than %d characters" % RUBRIC_REGEX_MAX_LEN
    state = {"pos": 0}

    class _Bad(Exception):
        pass

    def fail(reason):
        raise _Bad(reason)

    def fold(c):
        return c + 32 if ignore_case and 65 <= c <= 90 else c

    def peek(offset=0):
        k = state["pos"] + offset
        return p[k] if 0 <= k < len(p) else None

    def escape_in(in_class):
        state["pos"] += 1
        c = peek()
        if c is None:
            fail("the pattern ends with a backslash")
        state["pos"] += 1
        ch = chr(c)
        if ch == "d":
            return ("ranges", _RX_DIGIT, False)
        if ch == "w":
            return ("ranges", _RX_WORD, False)
        if ch == "s":
            return ("ranges", _RX_SPACE, False)
        if ch in "DWS":
            if in_class:
                fail("\\%s is not allowed inside [ ]" % ch)
            return ("ranges", _RX_DIGIT if ch == "D" else _RX_WORD if ch == "W" else _RX_SPACE, True)
        if ch == "n":
            return ("char", 10)
        if ch == "t":
            return ("char", 9)
        if ch == "r":
            return ("char", 13)
        if ch in _RX_PUNCT_ESCAPES:
            return ("char", c)
        return fail("\\%s is not supported (use \\d \\w \\s, \\n \\t \\r, or a backslash before a punctuation mark)" % ch)

    def parse_class():
        state["pos"] += 1
        negate = False
        if peek() == 94:
            negate = True
            state["pos"] += 1
        ranges = []
        first = True
        while True:
            c = peek()
            if c is None:
                fail("a [ has no closing ]")
            if c == 93 and not first:
                state["pos"] += 1
                break
            first = False
            if c == 92:
                e = escape_in(True)
                if e[0] == "ranges":
                    ranges.extend(e[1])
                    continue
                lo = e[1]
            else:
                lo = c
                state["pos"] += 1
            if peek() == 45 and peek(1) is not None and peek(1) != 93:
                state["pos"] += 1
                if peek() == 92:
                    e = escape_in(True)
                    if e[0] == "ranges":
                        fail("a range cannot end in \\d, \\w or \\s")
                    hi = e[1]
                else:
                    hi = peek()
                    state["pos"] += 1
                if hi < lo:
                    fail("a range in [ ] runs backwards")
                ranges.append((fold(lo), fold(hi)))
            else:
                ranges.append((fold(lo), fold(lo)))
        return ("class", tuple(ranges), negate)

    def parse_atom():
        c = peek()
        if c == 40:
            state["pos"] += 1
            if peek() == 63:
                if peek(1) == 58:
                    state["pos"] += 2
                else:
                    fail("(? groups other than (?: are not supported (no lookarounds, no named groups)")
            inner = parse_alt()
            if peek() != 41:
                fail("a ( has no closing )")
            state["pos"] += 1
            return inner
        if c == 91:
            return parse_class()
        if c == 46:
            state["pos"] += 1
            return ("any",)
        if c == 94:
            state["pos"] += 1
            return ("bol",)
        if c == 36:
            state["pos"] += 1
            return ("eol",)
        if c == 92:
            e = escape_in(False)
            return ("class", tuple(e[1]), e[2]) if e[0] == "ranges" else ("char", fold(e[1]))
        if c in (42, 43, 63):
            fail("a quantifier has nothing before it")
        if c == 123:
            fail("{ must be written \\{ unless it starts a repeat after something")
        state["pos"] += 1
        return ("char", fold(c))

    def parse_number():
        s = ""
        while peek() is not None and 48 <= peek() <= 57:
            s += chr(peek())
            state["pos"] += 1
        return int(s) if s else None

    def parse_seq():
        parts = []
        while peek() is not None and peek() != 124 and peek() != 41:
            atom = parse_atom()
            q = peek()
            quantified = False
            lo = hi = None
            if q == 42:
                lo, hi = 0, None
                state["pos"] += 1
                quantified = True
            elif q == 43:
                lo, hi = 1, None
                state["pos"] += 1
                quantified = True
            elif q == 63:
                lo, hi = 0, 1
                state["pos"] += 1
                quantified = True
            elif q == 123:
                state["pos"] += 1
                lo = parse_number()
                if lo is None:
                    fail("a repeat needs a number: {3}, {2,5} or {2,}")
                if peek() == 44:
                    state["pos"] += 1
                    hi = parse_number()
                else:
                    hi = lo
                if peek() != 125:
                    fail("a repeat is not closed with }")
                state["pos"] += 1
                quantified = True
                if lo > RUBRIC_REPEAT_MAX or (hi is not None and hi > RUBRIC_REPEAT_MAX):
                    fail("a repeat may count to at most %d" % RUBRIC_REPEAT_MAX)
                if hi is not None and hi < lo:
                    fail("a repeat runs backwards")
            if quantified:
                if atom[0] in ("bol", "eol"):
                    fail("a quantifier cannot follow ^ or $")
                if peek() in (63, 43, 42):
                    fail("lazy and possessive quantifiers are not supported")
                if _can_be_empty(atom):
                    fail("a repeat cannot follow something that can match no characters, such as an empty group or (a*)")
                atom = ("rep", atom, lo, hi)
            parts.append(atom)
        return ("cat", tuple(parts))

    def parse_alt():
        options = [parse_seq()]
        while peek() == 124:
            state["pos"] += 1
            options.append(parse_seq())
        return options[0] if len(options) == 1 else ("alt", tuple(options))

    try:
        ast = parse_alt()
        if state["pos"] < len(p):
            fail("a ) has no opening (" if p[state["pos"]] == 41 else "the pattern could not be read")
        program = []
        too_big = "the pattern needs more than %d steps once its repeats are counted out" % RUBRIC_REGEX_MAX_STATES

        emits = [0]

        def emit(n):
            emits[0] += 1
            if emits[0] > RUBRIC_REGEX_MAX_EMITS:
                fail("the pattern is too large once its repeats are counted out")
            if len(program) > RUBRIC_REGEX_MAX_STATES:
                fail(too_big)
            kind = n[0]
            if kind == "char":
                program.append(["char", n[1]])
            elif kind == "any":
                program.append(["any"])
            elif kind == "class":
                program.append(["class", n[1], n[2]])
            elif kind == "bol":
                program.append(["bol"])
            elif kind == "eol":
                program.append(["eol"])
            elif kind == "cat":
                for part in n[1]:
                    emit(part)
            elif kind == "alt":
                jumps = []
                options = n[1]
                for k, option in enumerate(options):
                    if k < len(options) - 1:
                        split = len(program)
                        program.append(["split", split + 1, -1])
                        emit(option)
                        jumps.append(len(program))
                        program.append(["jmp", -1])
                        program[split][2] = len(program)
                    else:
                        emit(option)
                for j in jumps:
                    program[j][1] = len(program)
            else:  # rep
                node, lo, hi = n[1], n[2], n[3]
                for _ in range(lo):
                    emit(node)
                if hi is None:
                    split = len(program)
                    program.append(["split", split + 1, -1])
                    emit(node)
                    program.append(["jmp", split])
                    program[split][2] = len(program)
                else:
                    splits = []
                    for _ in range(lo, hi):
                        splits.append(len(program))
                        program.append(["split", len(program) + 1, -1])
                        emit(node)
                    for s in splits:
                        program[s][2] = len(program)

        emit(ast)
        program.append(["match"])
        if len(program) > RUBRIC_REGEX_MAX_STATES:
            fail(too_big)
        return {"program": program, "ignore_case": bool(ignore_case)}, None
    except _Bad as exc:
        return None, str(exc)


def regex_search(regex, text: str) -> bool:
    """Does the pattern match anywhere in the text? Stepped once per character.

    Every instruction visited counts as one step; past RUBRIC_REGEX_MAX_WORK steps
    the answer is no match. The walk is in a fixed order (lists, not sets) so the
    TypeScript twin counts exactly the same steps.
    """
    prog = regex["program"]
    chars = [ord(c) for c in (ascii_lower(text) if regex["ignore_case"] else text)]
    n = len(chars)
    seen = [0] * len(prog)
    listed = [0] * len(prog)
    stamp = [0]
    work = [0]

    def add(target, gen, start, at):
        """1 for a match, 0 for none, -1 when the step limit was passed."""
        stamp[0] += 1
        mark = stamp[0]
        stack = [start]
        while stack:
            pc = stack.pop()
            if seen[pc] == mark:
                continue
            seen[pc] = mark
            work[0] += 1
            if work[0] > RUBRIC_REGEX_MAX_WORK:
                return -1
            op = prog[pc]
            kind = op[0]
            if kind == "jmp":
                stack.append(op[1])
            elif kind == "split":
                stack.append(op[2])
                stack.append(op[1])
            elif kind == "bol":
                if at == 0:
                    stack.append(pc + 1)
            elif kind == "eol":
                if at == n:
                    stack.append(pc + 1)
            elif kind == "match":
                return 1
            elif listed[pc] != gen:
                listed[pc] = gen
                target.append(pc)
        return 0

    current = []
    for at in range(n + 1):
        gen = at + 1
        first = add(current, gen, 0, at)
        if first != 0:
            return first == 1
        if at == n:
            break
        c = chars[at]
        nxt = []
        for pc in current:
            work[0] += 1
            if work[0] > RUBRIC_REGEX_MAX_WORK:
                return False
            op = prog[pc]
            kind = op[0]
            if kind == "char":
                ok = op[1] == c
            elif kind == "any":
                ok = c != 10
            else:  # class
                inside = any(lo <= c <= hi for lo, hi in op[1])
                ok = inside != op[2]
            if ok:
                r = add(nxt, gen + 1, pc + 1, at + 1)
                if r != 0:
                    return r == 1
        current = nxt
    return False


def json_text(text: str) -> str:
    t = rubric_strip(text)
    if not t.startswith("```"):
        return t
    lines = t.split("\n")
    lines.pop(0)
    body = rubric_strip("\n".join(lines))
    if body.endswith("```"):
        body = rubric_strip(body[:-3])
    return body


def _reject_constant(name):
    raise ValueError("not JSON: %s" % name)


def parse_json(text: str):
    """(True, value) or (False, None). No NaN, no Infinity, nothing but one value."""
    try:
        return True, json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return False, None


def _is_json_integer(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and math.floor(value) == value


def schema_accepts(value, schema) -> bool:
    kind = schema.get("type")
    if kind is not None:
        if kind == "object":
            ok = isinstance(value, dict)
        elif kind == "array":
            ok = isinstance(value, list)
        elif kind == "string":
            ok = isinstance(value, str)
        elif kind == "number":
            ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        elif kind == "integer":
            ok = _is_json_integer(value)
        elif kind == "boolean":
            ok = isinstance(value, bool)
        else:
            ok = value is None
        if not ok:
            return False
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                return False
        for key, sub in (schema.get("properties") or {}).items():
            if key in value and not schema_accepts(value[key], sub):
                return False
    elif schema.get("required"):
        return False
    if isinstance(value, list) and schema.get("items"):
        for item in value:
            if not schema_accepts(item, schema["items"]):
                return False
    return True


def _plain_string(value, maximum=RUBRIC_STRING_MAX) -> bool:
    if not isinstance(value, str) or not value or len(value) > maximum:
        return False
    for c in value:
        o = ord(c)
        if o < 32 and o not in (9, 10, 13) or o == 127 or 0xD800 <= o <= 0xDFFF:
            return False
    return True


def _check_schema(raw, depth, nodes):
    """None when the schema is in the subset, else a reason."""
    if not isinstance(raw, dict):
        return "a schema must be an object"
    if depth > 4:
        return "a schema may nest at most 4 deep"
    nodes[0] += 1
    if nodes[0] > 30:
        return "a schema may hold at most 30 parts"
    if any(k not in ("type", "required", "properties", "items") for k in raw):
        return "a schema may only use type, required, properties and items"
    if "type" in raw and raw["type"] not in RUBRIC_JSON_TYPES:
        return "schema type is not one of the allowed types"
    if "required" in raw:
        req = raw["required"]
        if not isinstance(req, list) or len(req) > RUBRIC_LIST_MAX or any(not isinstance(k, str) or re.fullmatch(DATA_KEY_PATTERN, k) is None for k in req):
            return "schema required must be a list of names"
    if "properties" in raw:
        props = raw["properties"]
        if not isinstance(props, dict) or len(props) > RUBRIC_LIST_MAX:
            return "schema properties must be an object"
        for k, v in props.items():
            if re.fullmatch(DATA_KEY_PATTERN, k) is None:
                return "a property name may hold only letters, digits and underscores"
            problem = _check_schema(v, depth + 1, nodes)
            if problem:
                return problem
    if "items" in raw:
        problem = _check_schema(raw["items"], depth + 1, nodes)
        if problem:
            return problem
    return None


def _rule_problem(rule, where):
    """None when one rule is well formed, else why not. Rules arrive already shaped by the lab server; this holds whatever it sends."""
    if not isinstance(rule, dict):
        return "%s is not an object" % where
    kind = rule.get("type")
    if kind not in RUBRIC_TYPES:
        return "%s: type is not one of the rubric types" % where
    weight = rule.get("weight")
    if not _is_number(weight) or weight <= 0 or weight > 1:
        return "%s: weight must be above 0 and at most 1" % where
    allowed = {
        "exact_match": ("value", "from", "scope"),
        "contains": ("any", "all", "from", "value", "ignore_case", "scope"),
        "not_contains": ("any", "all", "from", "value", "ignore_case", "scope"),
        "number_close": ("value", "from", "tolerance", "relative", "pick", "scope"),
        "regex_match": ("pattern", "ignore_case", "scope"),
        "json_valid": ("schema",),
        "length_between": ("min", "max", "scope"),
    }[kind]
    for key in rule:
        if key not in ("type", "weight") and key not in allowed:
            return "%s: %s has no field %s" % (where, kind, _short(key, 30))
    if "scope" in rule and rule["scope"] not in ("whole", "first_line", "last_line"):
        return "%s: scope must be whole, first_line or last_line" % where
    if "from" in rule:
        source = rule["from"]
        if source != "expected" and not (isinstance(source, str) and source.startswith("data.") and re.fullmatch(DATA_KEY_PATTERN, source[5:]) is not None):
            return "%s: from must be expected or data.<name>" % where
    if kind in ("exact_match", "number_close"):
        if ("value" in rule) == ("from" in rule):
            return "%s: give either value or from" % where
        if "value" in rule:
            if kind == "number_close" and not _is_number(rule["value"]):
                return "%s: value must be a number" % where
            if kind == "exact_match" and not _plain_string(rule["value"]):
                return "%s: value must be text" % where
    if kind in ("contains", "not_contains"):
        given = [k for k in ("any", "all", "from", "value") if k in rule]
        if len(given) != 1:
            return "%s: give exactly one of any, all, value or from" % where
        if kind == "not_contains" and given[0] == "all":
            return "%s: not_contains takes any, value or from" % where
        if given[0] in ("any", "all"):
            items = rule[given[0]]
            if not isinstance(items, list) or not (1 <= len(items) <= RUBRIC_LIST_MAX) or any(not _plain_string(s) for s in items):
                return "%s: %s must be a list of 1 to %d strings" % (where, given[0], RUBRIC_LIST_MAX)
        elif given[0] == "value" and not _plain_string(rule["value"]):
            return "%s: value must be text" % where
        if "ignore_case" in rule and not isinstance(rule["ignore_case"], bool):
            return "%s: ignore_case must be true or false" % where
    if kind == "number_close":
        if "tolerance" in rule and (not _is_number(rule["tolerance"]) or rule["tolerance"] < 0 or rule["tolerance"] > RUBRIC_TOLERANCE_MAX):
            return "%s: tolerance is out of range" % where
        if "relative" in rule and not isinstance(rule["relative"], bool):
            return "%s: relative must be true or false" % where
        if "pick" in rule and rule["pick"] not in ("first", "last"):
            return "%s: pick must be first or last" % where
    if kind == "regex_match":
        if "ignore_case" in rule and not isinstance(rule["ignore_case"], bool):
            return "%s: ignore_case must be true or false" % where
        compiled, reason = compile_regex(rule.get("pattern"), rule.get("ignore_case") is True)
        if compiled is None:
            return "%s: %s" % (where, reason)
    if kind == "json_valid" and "schema" in rule:
        problem = _check_schema(rule["schema"], 1, [0])
        if problem:
            return "%s: %s" % (where, problem)
    if kind == "length_between":
        for key in ("min", "max"):
            if key in rule and (not _is_int(rule[key]) or rule[key] < 0 or rule[key] > RUBRIC_LENGTH_MAX):
                return "%s: %s must be a whole number from 0 to %d" % (where, key, RUBRIC_LENGTH_MAX)
        if "min" not in rule and "max" not in rule:
            return "%s: give min, max or both" % where
        if "min" in rule and "max" in rule and rule["min"] > rule["max"]:
            return "%s: min is above max" % where
    return None


def check_rubric(rubric):
    """None when the rubric is one this runner scores, else a short reason."""
    if not isinstance(rubric, dict) or set(rubric.keys()) != {"rules"}:
        return "the rubric must be an object with only rules"
    rules = rubric["rules"]
    if not isinstance(rules, list) or not (1 <= len(rules) <= RUBRIC_MAX_RULES):
        return "the rubric must hold 1 to %d rules" % RUBRIC_MAX_RULES
    total = 0.0
    regex_rules = 0
    for i, rule in enumerate(rules):
        problem = _rule_problem(rule, "rubric.rules[%d]" % i)
        if problem:
            return problem
        if rule.get("type") == "regex_match":
            regex_rules += 1
            if regex_rules > RUBRIC_MAX_REGEX_RULES:
                return "rubric.rules may hold at most %d regex_match rules" % RUBRIC_MAX_REGEX_RULES
        total += rule["weight"]
    if total > 1 + 1e-9:
        return "the rubric weights add up to more than 1"
    return None


def rubric_max(rubric) -> float:
    total = sum(rule["weight"] for rule in rubric["rules"])
    return math.floor(min(1.0, total) * 1e6 + 0.5) / 1e6


def _rule_target(rule, task):
    if rule.get("from") == "expected":
        return task.get("expected")
    if "from" in rule:
        return (task.get("data") or {}).get(rule["from"][5:])
    return rule.get("value")


def _rule_fold(rule, text: str) -> str:
    return _nfkc(text) if rule.get("ignore_case") is False else ascii_lower(_nfkc(text))


def score_rule(rule, task, completion: str, cache=None) -> int:
    """One rule on one completion: 0 or 1. `cache` holds compiled patterns."""
    clipped = completion[:RUBRIC_TEXT_MAX]
    text = scope_text(clipped, rule.get("scope"))
    kind = rule["type"]
    if kind == "exact_match":
        target = _rule_target(rule, task)
        return 1 if target is not None and normalise_text(text) == normalise_text(str(target)) else 0
    if kind in ("contains", "not_contains"):
        hay = _rule_fold(rule, text)
        if "any" in rule:
            wanted = rule["any"]
        elif "all" in rule:
            wanted = rule["all"]
        else:
            target = _rule_target(rule, task)
            if target is None:
                return 0
            wanted = [str(target)]
        found = [_rule_fold(rule, s) in hay for s in wanted]
        if kind == "not_contains":
            return 0 if any(found) else 1
        return 1 if (all(found) if "all" in rule else any(found)) else 0
    if kind == "number_close":
        target = _rule_target(rule, task)
        if target is None:
            return 0
        if isinstance(target, (int, float)) and not isinstance(target, bool):
            want = float(target)
        else:
            found_target = numbers_in(str(target))
            if not found_target:
                return 0
            want = found_target[0]
        got = numbers_in(text)
        if not got:
            return 0
        x = got[0] if rule.get("pick") == "first" else got[-1]
        tolerance = rule.get("tolerance", 1e-6) * (abs(want) if rule.get("relative") else 1)
        return 1 if abs(x - want) <= tolerance else 0
    if kind == "regex_match":
        key = (rule["pattern"], rule.get("ignore_case") is True)
        store = cache if cache is not None else {}
        if key not in store:
            store[key] = compile_regex(rule["pattern"], rule.get("ignore_case") is True)[0]
        return 1 if store[key] is not None and regex_search(store[key], text) else 0
    if kind == "json_valid":
        ok, value = parse_json(json_text(clipped))
        if not ok:
            return 0
        return 1 if "schema" not in rule or schema_accepts(value, rule["schema"]) else 0
    n = len(text)
    return 1 if ("min" not in rule or n >= rule["min"]) and ("max" not in rule or n <= rule["max"]) else 0


def score_completion(rubric, task, completion: str, cache=None) -> float:
    """The weighted sum of the rules, clamped to [0, 1], to six places."""
    total = 0.0
    for rule in rubric["rules"]:
        total += rule["weight"] * score_rule(rule, task, completion, cache)
    clamped = min(1.0, max(0.0, total))
    return math.floor(clamped * 1e6 + 0.5) / 1e6


# ---------------------------------------------------------------------------
# Reinforcement learning with a rubric (Tinker RL, docs/TOOLS.md)
#
# A model writes a set of tasks and a rubric as data. This file's own code:
# holds out about 15% of the tasks by a hash of the run's salt; samples the base
# model on them and scores the answers with the rubric engine above (the lab's
# measurement of the base); then, for each step, samples `group_size` answers to
# each of a few training tasks, scores them, centres the scores inside each
# group (GRPO, as in Tinker's own tutorial), and takes one gradient step with one
# of Tinker's built-in RL losses; then saves the adapter for sampling and scores
# the held-out tasks again on the adapter as it was saved.
#
# The score of an attempt is the rubric's, computed here. A model's code never
# runs. Every dollar figure is tokens counted here times Tinker's published
# prices: an estimate. After each step the runner writes a small progress record
# (the room's practice bench draws from it and from nothing else).
# ---------------------------------------------------------------------------

RL_MIN_TASKS = 8
RL_MAX_TASKS = 400
RL_TASK_PROMPT_MAX_BYTES = 1500
RL_TASK_VALUE_MAX = 400
RL_MAX_TASK_BYTES = 120000
RL_GROUP_SIZE = (2, 16)
RL_STEPS = (1, 30)
RL_TASKS_PER_STEP = (1, 16)
RL_COMPLETION_TOKENS = (16, 512)
RL_LEARNING_RATE = (5e-6, 5e-4)
RL_LOSSES = ("importance_sampling", "ppo", "cispo")
RL_HOLDOUT_FRACTION = 0.15
RL_HOLDOUT_MIN = 2
RL_HOLDOUT_MAX = 60
RL_EVAL_SAMPLES = 2
RL_EVAL_TEMPERATURE = 0.3
RL_TRAIN_TEMPERATURE = 1.0
RL_TRAIN_WALL_S = 1500
RL_MAX_PROMPT_TOKENS = 1024
RL_PROGRESS_MAX_BYTES = 6000
RL_SAMPLE_KEEP = 3
RL_SETTINGS_KEYS = ("rank", "learning_rate", "group_size", "steps", "tasks_per_step", "max_completion_tokens", "loss")
PROGRESS_DICT = "oblab-tinker-progress"


def rl_holdout_count(n: int) -> int:
    """How many of n tasks are held out: about 15%, at least 2, at most 60."""
    return min(RL_HOLDOUT_MAX, max(RL_HOLDOUT_MIN, int(math.ceil(n * RL_HOLDOUT_FRACTION))))


def rl_split(n: int, salt: str):
    """(training indexes, held-out indexes). Fixed by the salt, which the lab makes up after the request was written."""
    order = _order(n, salt, "rl-split")
    k = rl_holdout_count(n)
    return sorted(order[k:]), sorted(order[:k])


def rl_step_tasks(train: list, step: int, per_step: int, salt: str) -> list:
    """The training tasks of one step: a walk through the training tasks in an order fixed by the salt, round and round."""
    order = [train[i] for i in _order(len(train), salt, "rl-steps")]
    count = min(per_step, len(order))
    return [order[(step * count + j) % len(order)] for j in range(count)]


def rubric_fits_tasks(rubric, tasks):
    """None when every task carries what the rubric reads from it, else why not."""
    for r, rule in enumerate(rubric["rules"]):
        source = rule.get("from")
        if not source:
            continue
        for i, task in enumerate(tasks):
            have = task.get("expected") if source == "expected" else (task.get("data") or {}).get(source[5:])
            if have is None:
                return "rubric.rules[%d] reads %s and tasks[%d] has none" % (r, source, i)
    return None


def check_rl_task(task, where):
    if not isinstance(task, dict) or "prompt" not in task or any(k not in ("prompt", "expected", "data") for k in task):
        return "%s must be an object with prompt, and optionally expected and data" % where
    prompt = task["prompt"]
    if not isinstance(prompt, str) or not prompt.strip():
        return "%s: prompt must be non-empty text" % where
    if len(prompt.encode("utf-8")) > RL_TASK_PROMPT_MAX_BYTES:
        return "%s: prompt holds more than %d bytes" % (where, RL_TASK_PROMPT_MAX_BYTES)
    if "expected" in task and (not _plain_string(task["expected"], RL_TASK_VALUE_MAX) or not task["expected"].strip()):
        return "%s: expected must be text" % where
    if "data" in task:
        data = task["data"]
        if not isinstance(data, dict) or not (1 <= len(data) <= 8):
            return "%s: data must be an object of 1 to 8 entries" % where
        for k, v in data.items():
            if re.fullmatch(DATA_KEY_PATTERN, k) is None:
                return "%s: a data name is not allowed" % where
            if not (_is_int(v) or _plain_string(v, RL_TASK_VALUE_MAX)):
                return "%s: data.%s must be a whole number or text" % (where, _short(k, 24))
    return None


def check_rl_job(job):
    """None when the job is one this runner accepts, else a short reason. Runs nothing."""
    if not isinstance(job, dict):
        return "the job is not an object"
    if job.get("base_model") not in RENDERERS:
        return "base_model is not one this runner trains"
    tasks = job.get("tasks")
    if not isinstance(tasks, list) or not (RL_MIN_TASKS <= len(tasks) <= RL_MAX_TASKS):
        return "tasks must hold %d to %d tasks" % (RL_MIN_TASKS, RL_MAX_TASKS)
    seen = set()
    total = 0
    for i, task in enumerate(tasks):
        problem = check_rl_task(task, "tasks[%d]" % i)
        if problem:
            return problem
        if task["prompt"] in seen:
            return "tasks[%d] has the same prompt as an earlier task" % i
        seen.add(task["prompt"])
        total += len(task["prompt"].encode("utf-8")) + len(str(task.get("expected", "")).encode("utf-8"))
    if total > RL_MAX_TASK_BYTES:
        return "the tasks hold more than %d bytes of text" % RL_MAX_TASK_BYTES
    problem = check_rubric(job.get("rubric"))
    if problem:
        return problem
    problem = rubric_fits_tasks(job["rubric"], tasks)
    if problem:
        return problem
    settings = job.get("settings")
    if not isinstance(settings, dict) or set(settings.keys()) != set(RL_SETTINGS_KEYS):
        return "settings must hold %s" % ", ".join(RL_SETTINGS_KEYS)
    if not _is_int(settings["rank"]) or settings["rank"] not in RANKS:
        return "rank must be one of %s" % ", ".join(str(r) for r in RANKS)
    if not _is_number(settings["learning_rate"]) or not (RL_LEARNING_RATE[0] <= settings["learning_rate"] <= RL_LEARNING_RATE[1]):
        return "learning_rate is out of range"
    for key, bounds in (("group_size", RL_GROUP_SIZE), ("steps", RL_STEPS), ("tasks_per_step", RL_TASKS_PER_STEP), ("max_completion_tokens", RL_COMPLETION_TOKENS)):
        if not _is_int(settings[key]) or not (bounds[0] <= settings[key] <= bounds[1]):
            return "%s must be a whole number from %d to %d" % (key, bounds[0], bounds[1])
    if settings["loss"] not in RL_LOSSES:
        return "loss must be one of %s" % ", ".join(RL_LOSSES)
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
    if "export" in job and not isinstance(job["export"], bool):
        return "export must be true or false"
    run_id = job.get("run_id")
    if run_id is not None and (not isinstance(run_id, str) or re.fullmatch(RUN_ID_PATTERN, run_id) is None):
        return "run_id is not a run name"
    return None


def rl_plan_tokens(train_lengths: list, held_lengths: list, settings: dict) -> dict:
    """The most tokens a whole run could use: every step at its longest, and two scorings of the held-out tasks."""
    per_step = min(settings["tasks_per_step"], len(train_lengths))
    top = sum(sorted(train_lengths, reverse=True)[:per_step])
    group = settings["group_size"]
    ceiling = settings["max_completion_tokens"]
    steps = settings["steps"]
    closing = rl_closing_tokens(held_lengths, settings)
    return {
        "train": steps * (group * top + per_step * group * ceiling),
        "eval": 0,
        "sample_prompt": steps * top + 2 * closing["sample_prompt"],
        "sample_completion": steps * per_step * group * ceiling + 2 * closing["sample_completion"],
    }


def rl_closing_tokens(held_lengths: list, settings: dict) -> dict:
    """Tokens one scoring of the held-out tasks takes at the most."""
    return {
        "train": 0,
        "eval": 0,
        "sample_prompt": sum(held_lengths),
        "sample_completion": len(held_lengths) * RL_EVAL_SAMPLES * settings["max_completion_tokens"],
    }


def rl_step_tokens(train_lengths: list, settings: dict) -> dict:
    """Tokens one step takes at the most."""
    per_step = min(settings["tasks_per_step"], len(train_lengths))
    top = sum(sorted(train_lengths, reverse=True)[:per_step])
    group = settings["group_size"]
    ceiling = settings["max_completion_tokens"]
    return {
        "train": group * top + per_step * group * ceiling,
        "eval": 0,
        "sample_prompt": top,
        "sample_completion": per_step * group * ceiling,
    }


def _add_tokens(a: dict, b: dict) -> dict:
    return dict((k, a.get(k, 0) + b.get(k, 0)) for k in ("train", "eval", "sample_prompt", "sample_completion"))


def rl_progress_payload(job, live: dict, wall: float) -> dict:
    """What the lab polls while a run goes: small, and nothing in it but what was measured. Cut to fit RL_PROGRESS_MAX_BYTES."""
    settings = job["settings"]
    payload = {
        "v": 1,
        "phase": live.get("phase", "starting"),
        "step": int(live.get("step", 0)),
        "steps_planned": int(live.get("steps_planned", settings["steps"])),
        "group_size": settings["group_size"],
        "tasks_per_step": int(live.get("tasks_per_step", settings["tasks_per_step"])),
        "max_reward": live.get("max_reward"),
        "means": [round(float(x), 4) for x in live.get("means", [])][:RL_STEPS[1]],
        "frac_max": [round(float(x), 4) for x in live.get("frac_max", [])][:RL_STEPS[1]],
        "attempts": [round(float(x), 4) for x in live.get("attempts", [])][:RL_GROUP_SIZE[1]],
        "samples": [
            {"prompt": _short(s.get("prompt", ""), 100), "completion": _short(s.get("completion", ""), 160), "reward": round(float(s.get("reward", 0)), 4)}
            for s in live.get("samples", [])[:RL_SAMPLE_KEEP]
        ],
        "score_before": live.get("score_before"),
        "score_after": live.get("score_after"),
        "steps_trained": int(live.get("steps_trained", 0)),
        "seq": int(live.get("seq", 0)),
        "wall_seconds": round(wall, 1),
    }
    while len(json.dumps(payload).encode("utf-8")) > RL_PROGRESS_MAX_BYTES and payload["samples"]:
        payload["samples"].pop()
    return payload


def run_rl_core(job, make_deps, clock=time.time, log=print, on_progress=None) -> dict:
    """The whole RL run, with the training service behind `make_deps`. Never raises: a failure is returned as {"status": "error"}.

    `make_deps(job)` is called only after the job has been checked. It returns an
    object with: prompt_length(text) -> tokens; new_sampler() -> a sampler of the
    weights as they are now; sampler_from_path(path); sample_batch(sampler,
    prompts, n, max_tokens, temperature) -> per prompt {prompt, prompt_tokens,
    completions: [{text, tokens, logprobs}]}; train(groups, learning_rate, loss)
    with groups [{prompt, completions, advantages}]; save(ttl_seconds) -> sampler
    path; secrets(); and, only when the job says "export": true, save_external(ttl_seconds).
    """
    started = clock()
    tokens = {"train": 0, "eval": 0, "sample_prompt": 0, "sample_completion": 0}
    state = {"stage": "input"}
    progress = {}
    secrets = []
    live = {"phase": "starting", "step": 0, "means": [], "frac_max": [], "attempts": [], "samples": [], "score_before": None, "score_after": None, "steps_trained": 0, "seq": 0}

    def done(result: dict) -> dict:
        out = dict(progress)
        out.update(result)
        out["tokens"] = dict(tokens)
        out["wall_seconds"] = round(clock() - started, 1)
        return out

    def refused(reason: str) -> dict:
        return done({"status": "refused", "stage": state["stage"], "reason": reason})

    def emit(**changes) -> None:
        live.update(changes)
        live["seq"] = live.get("seq", 0) + 1  # the lab tells a record that moved from one it already has by this number
        if on_progress is not None:
            try:
                on_progress(rl_progress_payload(job, live, clock() - started))
            except Exception as exc:  # noqa: BLE001
                log("progress could not be written: %s" % type(exc).__name__)

    try:
        problem = check_rl_job(job)
        if problem:
            return refused(problem)
        tasks = job["tasks"]
        rubric = job["rubric"]
        settings = job["settings"]
        prices = job["prices"]
        budget = float(job["budget_usd"])
        salt = job["split_salt"]
        ceiling = settings["max_completion_tokens"]
        group = settings["group_size"]
        max_reward = rubric_max(rubric)
        patterns = {}
        train, holdout = rl_split(len(tasks), salt)
        progress.update({"kind": "rl", "n_tasks": len(tasks), "n_train": len(train), "n_holdout": len(holdout), "max_reward": max_reward})
        live["max_reward"] = max_reward
        live["tasks_per_step"] = min(settings["tasks_per_step"], len(train))

        state["stage"] = "client"
        deps = make_deps(job)
        secrets = list(deps.secrets())

        state["stage"] = "tokens"
        lengths = [deps.prompt_length(t["prompt"]) for t in tasks]
        for i, length in enumerate(lengths):
            if length > RL_MAX_PROMPT_TOKENS:
                return refused("tasks[%d] is %d tokens and a task may be %d" % (i, length, RL_MAX_PROMPT_TOKENS))
        train_lengths = [lengths[i] for i in train]
        held_lengths = [lengths[i] for i in holdout]

        state["stage"] = "budget"
        steps_planned = settings["steps"]
        progress["steps_planned"] = steps_planned
        live["steps_planned"] = steps_planned
        plan = rl_plan_tokens(train_lengths, held_lengths, settings)
        plan_cost = cost_usd(plan, prices)
        if plan_cost > budget:
            return refused("the tokenized plan costs $%.4f at the published prices, more than the $%.4f set aside" % (plan_cost, budget))
        closing = rl_closing_tokens(held_lengths, settings)
        one_step = rl_step_tokens(train_lengths, settings)

        class _TimeUp(Exception):
            pass

        def attempts_of(sampler, indexes, count, temperature, deadline=None):
            """Samples `count` answers to each task and scores them. Returns (rewards per task, results).

            Every token is counted before anything is scored. With a `deadline` (seconds since the run began) scoring
            stops when it is passed, so a rubric that is slow to score cannot hold a step past the time limit.
            """
            results = deps.sample_batch(sampler, [tasks[i]["prompt"] for i in indexes], count, ceiling, temperature)
            for result in results:
                tokens["sample_prompt"] += int(result["prompt_tokens"])
                tokens["sample_completion"] += sum(len(c["tokens"]) for c in result["completions"])
            rewards = []
            for i, result in zip(indexes, results):
                if deadline is not None and clock() - started > deadline:
                    raise _TimeUp()
                rewards.append([score_completion(rubric, tasks[i], c["text"], patterns) for c in result["completions"]])
            return rewards, results

        def measure(sampler):
            rewards, results = attempts_of(sampler, holdout, RL_EVAL_SAMPLES, RL_EVAL_TEMPERATURE)
            flat = [r for per_task in rewards for r in per_task]
            if not flat:
                return None, []
            shown = []
            for i, per_task, result in zip(holdout, rewards, results):
                if per_task and len(shown) < max(job["samples"], 0):
                    shown.append({"prompt": _short(tasks[i]["prompt"], 300), "completion": _short(result["completions"][0]["text"], 600), "reward": per_task[0]})
            return sum(flat) / len(flat), shown

        state["stage"] = "baseline"
        emit(phase="baseline")
        sampler = deps.new_sampler()
        before, _ = measure(sampler)
        if before is None:
            return done({"status": "error", "stage": state["stage"], "error": "the held-out score could not be measured"})
        progress["score_before"] = round(before, 6)
        emit(score_before=round(before, 6))
        log("held-out score before training: %.4f on %d tasks (best possible %.2f)" % (before, len(holdout), max_reward))

        state["stage"] = "train"
        steps = 0
        stopped = None
        progress["steps_done"] = 0
        progress["steps_trained"] = 0
        trained = 0
        first_mean = None
        last_mean = None
        for step in range(steps_planned):
            if clock() - started > RL_TRAIN_WALL_S:
                stopped = "the time limit of %d s for training" % RL_TRAIN_WALL_S
                break
            ahead = _add_tokens(_add_tokens(tokens, one_step), closing)
            if cost_usd(ahead, prices) > budget:
                stopped = "the budget: one more step would pass the $%.4f set aside" % budget
                break
            indexes = rl_step_tasks(train, step, settings["tasks_per_step"], salt)
            emit(phase="sampling", attempts=[])
            if step > 0:
                sampler = deps.new_sampler()
            try:
                rewards, results = attempts_of(sampler, indexes, group, RL_TRAIN_TEMPERATURE, RL_TRAIN_WALL_S)
            except _TimeUp:
                stopped = "the time limit of %d s for training (scoring the answers of a step was taking too long)" % RL_TRAIN_WALL_S
                break
            flat = [r for per_task in rewards for r in per_task]
            mean = sum(flat) / len(flat)
            at_max = sum(1 for r in flat if r >= max_reward - 1e-9) / float(len(flat))
            kept = []
            for per_task, result in zip(rewards, results):
                centre = sum(per_task) / len(per_task)
                advantages = [r - centre for r in per_task]
                if all(abs(a) < 1e-12 for a in advantages):
                    continue  # every answer scored the same: nothing to learn from
                kept.append({"prompt": result["prompt"], "prompt_tokens": result["prompt_tokens"], "completions": result["completions"], "advantages": advantages})
            seen = []
            for i, per_task, result in zip(indexes, rewards, results):
                seen.append({"prompt": _short(tasks[i]["prompt"], 100), "completion": _short(result["completions"][0]["text"], 160), "reward": per_task[0]})
            emit(phase="scored", step=steps, attempts=list(rewards[0]), samples=seen,
                 means=live["means"] + [mean], frac_max=live["frac_max"] + [at_max])
            if kept:
                for g in kept:
                    tokens["train"] += int(g["prompt_tokens"]) * len(g["completions"]) + sum(len(c["tokens"]) for c in g["completions"])
                deps.train(kept, settings["learning_rate"], settings["loss"])
                trained += 1
                progress["steps_trained"] = trained
                live["steps_trained"] = trained
            steps += 1
            progress["steps_done"] = steps
            if first_mean is None:
                first_mean = mean
            last_mean = mean
            emit(step=steps)
            log("step %d of %d: mean reward %.4f, %d%% at the best score, %d of %d groups taught something" % (
                steps, steps_planned, mean, round(100 * at_max), len(kept), len(rewards)))
        progress["stopped_early"] = stopped
        progress["step_means"] = [round(x, 4) for x in live["means"]]
        progress["step_frac_max"] = [round(x, 4) for x in live["frac_max"]]
        if steps == 0:
            return done({"status": "error", "stage": state["stage"], "error": "no training step was done (%s)" % (stopped or "nothing to train")})
        progress["train_score_first"] = round(first_mean, 6)
        progress["train_score_last"] = round(last_mean, 6)
        if trained == 0:
            # Nothing was learned from, so what would be saved is the base model: it is not offered as a trained adapter.
            return done({"status": "error", "stage": state["stage"], "error": "no step trained the model: in every step every answer to a task earned the same reward, so there was nothing to learn from"})

        state["stage"] = "save"
        emit(phase="saving")
        path = deps.save(job["ttl_seconds"])
        if not isinstance(path, str) or not path.startswith("tinker://"):
            return done({"status": "error", "stage": state["stage"], "error": "the adapter was not saved"})
        progress["sampler_path"] = path
        progress["ttl_seconds"] = job["ttl_seconds"]

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

        # The held-out tasks again, on the adapter as it was saved: what a visitor will talk to.
        state["stage"] = "measure"
        emit(phase="measuring")
        saved = deps.sampler_from_path(path)
        after, shown = measure(saved)
        if after is None:
            return done({"status": "error", "stage": state["stage"], "error": "the held-out score could not be measured after training"})
        progress["score_after"] = round(after, 6)
        log("held-out score after training: %.4f" % after)
        emit(phase="done", score_after=round(after, 6), attempts=[], samples=shown if shown else live["samples"])
        return done({"status": "ok", "samples": shown})
    except Exception as exc:  # noqa: BLE001
        return done({"status": "error", "stage": state["stage"], "error": scrub(exc, secrets)})


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


class FixedEffortRenderer:
    """A cookbook renderer that takes a thinking effort (tml_v0) with the effort fixed.

    The cookbook's supervised data helper calls build_supervised_example
    without an effort, which renders at the default of 0.9. This wrapper
    supplies the runner's effort unless a call names one, for the generation
    prompt and the training example alike, and passes everything else
    (stop sequences, parsing, the tokenizer) to the renderer it wraps.
    """

    def __init__(self, renderer, effort: float):
        self._renderer = renderer
        self.effort = effort

    def build_generation_prompt(self, messages, *args, **kwargs):
        kwargs.setdefault("effort", self.effort)
        return self._renderer.build_generation_prompt(messages, *args, **kwargs)

    def build_supervised_example(self, messages, *args, **kwargs):
        kwargs.setdefault("effort", self.effort)
        return self._renderer.build_supervised_example(messages, *args, **kwargs)

    def __getattr__(self, name):
        if name in ("_renderer", "effort"):
            raise AttributeError(name)
        return getattr(self._renderer, name)


RENDER_CHECK_USER = "What is the lab code for the colour red?"
RENDER_CHECK_ANSWER = "The lab code for red is OL-100."


def judge_render(prompt, other_prompt, example, weights, decode) -> list:
    """The checks of one renderer, from token lists. Returns [{"what", "ok"}]. Touches nothing.

    `prompt`: the generation prompt for RENDER_CHECK_USER at the runner's
    effort. `other_prompt`: the same at a different effort. `example` and
    `weights`: the training example for the same question with RENDER_CHECK_ANSWER,
    one weight per token. `decode`: token ids to text.
    """
    weighted = [i for i, w in enumerate(weights) if w > 0]
    first = weighted[0] if weighted else -1
    trained_text = decode([example[i] for i in weighted]) if weighted else ""
    # Judged on text, not on a token count compared with a character count: the answer, then at most a short end marker.
    at = trained_text.rfind(RENDER_CHECK_ANSWER)
    tail_ok = at >= 0 and len(trained_text) - at - len(RENDER_CHECK_ANSWER) <= 16 and len(trained_text[:at]) <= 16
    return [
        {"what": "the generation prompt is not empty", "ok": len(prompt) > 0},
        {"what": "a different effort gives a different prompt, so the effort is really sent", "ok": list(prompt) != list(other_prompt)},
        {"what": "the generation prompt is the start of the training example, token for token", "ok": len(prompt) > 0 and list(example[:len(prompt)]) == list(prompt)},
        {"what": "training weighs nothing the sampling prompt already holds", "ok": first >= len(prompt) > 0},
        {"what": "the weighted tokens are the answer", "ok": RENDER_CHECK_ANSWER in trained_text},
        {"what": "the weights cover the answer and no more than a little format after it", "ok": tail_ok},
    ]


def judge_family(base_model: str, recommended, tokenizer_class) -> list:
    """Checks that the renderer and tokenizer are the ones made for this model, not only that they agree with each other.

    `recommended`: the cookbook's recommended renderer name for the model (None if it could not be read).
    `tokenizer_class`: the class name of the tokenizer the renderer wraps (None if this cookbook version hides it).
    A value that could not be read is reported as not checked, never as a pass.
    """
    want = RENDERERS[base_model]
    checks = [{"what": "the cookbook recommends this renderer for the model", "ok": recommended == want}]
    wanted_tokenizer = TOKENIZER_CLASS.get(want)
    if wanted_tokenizer:
        if tokenizer_class is None:
            checks.append({"what": "the tokenizer is the model's own family (not checked: this cookbook version does not expose it)", "ok": True, "checked": False})
        else:
            checks.append({"what": "the tokenizer is the model's own family", "ok": tokenizer_class == wanted_tokenizer})
    return checks


# ---------------------------------------------------------------------------
# The training service, as run_core uses it
# ---------------------------------------------------------------------------

class TinkerDeps:
    """Tinker behind the few calls run_core makes. The SDK reads TINKER_API_KEY from the environment itself."""

    def __init__(self, job: dict):
        import tinker
        from tinker_cookbook.renderers import TrainOnWhat, get_text_content
        from tinker_cookbook.supervised.data import conversation_to_datum

        self._tinker = tinker
        self._train_on = TrainOnWhat.LAST_ASSISTANT_MESSAGE
        self._to_datum = conversation_to_datum
        self._text = get_text_content
        self._client = self.open_client(job)
        self._renderer = self.open_renderer(job["base_model"], self.tokenizer)
        self._sampler = None

    @staticmethod
    def open_renderer(base_model: str, sdk_tokenizer):
        """The chat format for a base model. `sdk_tokenizer` is a function that returns the training client's tokenizer.

        A renderer that takes a thinking effort (Inkling) needs the cookbook's own tokenizer for the model, which
        wraps tml-renderers; the client's tokenizer is a Hugging Face one and the renderer refuses it. The tokens
        are the same ones either way. The Qwen renderers keep using the client's tokenizer, as they always did.
        """
        from tinker_cookbook.renderers import get_renderer

        name = RENDERERS[base_model]
        if name not in RENDER_EFFORT:
            return get_renderer(name, sdk_tokenizer())
        from tinker_cookbook.tokenizer_utils import get_tokenizer

        return FixedEffortRenderer(get_renderer(name, get_tokenizer(base_model)), RENDER_EFFORT[name])

    @staticmethod
    def check_render(base_model: str) -> dict:
        """Renders one made-up conversation for a base model and judges the result. No Tinker call, no key, no cost."""
        from tinker_cookbook.renderers import TrainOnWhat

        name = RENDERERS[base_model]
        if name not in RENDER_EFFORT:
            return {"status": "skipped", "renderer": name, "reason": "this renderer has no thinking effort to check"}
        renderer = TinkerDeps.open_renderer(base_model, None)
        question = [{"role": "user", "content": RENDER_CHECK_USER}]
        prompt = renderer.build_generation_prompt(question)
        other = renderer.build_generation_prompt(question, effort=0.9)
        example, weights = renderer.build_supervised_example(
            question + [{"role": "assistant", "content": RENDER_CHECK_ANSWER}], train_on_what=TrainOnWhat.LAST_ASSISTANT_MESSAGE)
        decode = renderer.tokenizer.decode
        checks = judge_render(prompt.to_ints(), other.to_ints(), example.to_ints(), [float(w) for w in weights.tolist()], decode)
        try:
            from tinker_cookbook.model_info import get_recommended_renderer_name
            recommended = get_recommended_renderer_name(base_model)
        except Exception:
            recommended = None
        inner = getattr(getattr(renderer, "_renderer", None), "_tml_tokenizer", None)
        checks += judge_family(base_model, recommended, type(inner).__name__ if inner is not None else None)
        return {
            "status": "ok" if all(c["ok"] for c in checks) else "failed", "renderer": name, "effort": renderer.effort,
            "prompt_tokens": int(prompt.length), "prompt_text": decode(prompt.to_ints()), "checks": checks,
        }

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


@app.function(image=train_image, timeout=300, retries=0, cpu=(1, 2), memory=(2048, 4096))
def render_check(base_model: str) -> dict:
    """Renders a made-up conversation in the chat format a base model is trained in and judges it. Makes no Tinker call and holds no key."""
    if base_model not in RENDERERS:
        return {"status": "refused", "reason": "base_model is not one this runner trains"}
    try:
        return TinkerDeps.check_render(base_model)
    except Exception as error:  # noqa: BLE001
        return {"status": "failed", "renderer": RENDERERS[base_model], "reason": "%s: %s" % (type(error).__name__, str(error)[:300])}


class TinkerRlDeps:
    """Tinker behind the calls run_rl_core makes. The SDK reads TINKER_API_KEY from the environment itself."""

    def __init__(self, job: dict):
        import tinker
        import torch
        from tinker_cookbook.renderers import get_text_content

        self._tinker = tinker
        self._torch = torch
        self._text = get_text_content
        service = tinker.ServiceClient()
        self._client = service.create_lora_training_client(
            base_model=job["base_model"], rank=job["settings"]["rank"],
            user_metadata={"source": "observable-lab", "kind": "rl", "label": _short(job.get("label", ""), 80)},
        ).result(timeout=CALL_TIMEOUT_S)
        self._renderer = TinkerDeps.open_renderer(job["base_model"], self._client.get_tokenizer)
        self._stop = self._renderer.get_stop_sequences()

    def secrets(self) -> list:
        return [os.environ.get("TINKER_API_KEY", "")]

    def _prompt(self, text: str):
        return self._renderer.build_generation_prompt([{"role": "user", "content": text}])

    def prompt_length(self, text: str) -> int:
        return int(self._prompt(text).length)

    def new_sampler(self):
        # A sampler of the weights as they are now, as Tinker's own RL tutorial makes one for every step.
        return self._client.save_weights_and_get_sampling_client().result(timeout=CALL_TIMEOUT_S)

    def sampler_from_path(self, path: str):
        return self._client.create_sampling_client(path).result(timeout=CALL_TIMEOUT_S)

    def sample_batch(self, sampler, prompts: list, n: int, max_tokens: int, temperature: float) -> list:
        params = self._tinker.SamplingParams(max_tokens=max_tokens, temperature=temperature, stop=self._stop)
        # Every request is sent before any is waited for.
        pending = []
        for text in prompts:
            prompt = self._prompt(text)
            pending.append((prompt, sampler.sample(prompt=prompt, num_samples=n, sampling_params=params)))
        out = []
        for prompt, future in pending:
            result = future.result(timeout=CALL_TIMEOUT_S)
            completions = []
            for sequence in result.sequences:
                sampled = [int(t) for t in sequence.tokens]
                message, _ = self._renderer.parse_response(sampled)
                completions.append({"text": self._text(message), "tokens": sampled, "logprobs": [float(x) for x in sequence.logprobs]})
            out.append({"prompt": prompt, "prompt_tokens": int(prompt.length), "completions": completions})
        return out

    def train(self, groups: list, learning_rate: float, loss: str) -> None:
        tinker = self._tinker
        datums = []
        for g in groups:
            prompt = g["prompt"]
            ob_len = int(prompt.length) - 1
            for completion, advantage in zip(g["completions"], g["advantages"]):
                sampled = completion["tokens"]
                if not sampled:
                    continue
                model_input = prompt.append(tinker.EncodedTextChunk(tokens=sampled[:-1]))
                datums.append(tinker.Datum(
                    model_input=model_input,
                    loss_fn_inputs={
                        "target_tokens": tinker.TensorData.from_torch(self._torch.tensor([0] * ob_len + sampled)),
                        "logprobs": tinker.TensorData.from_torch(self._torch.tensor([0.0] * ob_len + completion["logprobs"])),
                        "advantages": tinker.TensorData.from_torch(self._torch.tensor([0.0] * ob_len + [advantage] * (int(model_input.length) - ob_len))),
                    },
                ))
        if not datums:
            return
        # Both are submitted before either is waited for, as Tinker's own loop does.
        gradients = self._client.forward_backward(datums, loss_fn=loss)
        update = self._client.optim_step(tinker.AdamParams(learning_rate=learning_rate, beta1=0.9, beta2=0.95))
        gradients.result(timeout=CALL_TIMEOUT_S)
        update.result(timeout=CALL_TIMEOUT_S)

    def save(self, ttl_seconds: int) -> str:
        return self._client.save_weights_for_sampler("final", ttl_seconds=ttl_seconds).result(timeout=CALL_TIMEOUT_S).path

    def save_external(self, ttl_seconds: int) -> str:
        return self._client.save_weights_external("final", ttl_seconds=ttl_seconds).result(timeout=CALL_TIMEOUT_S).path


def progress_store():
    """The Modal Dict of run name -> the run's latest progress record. None if it cannot even be named; reads and writes are guarded where it is used."""
    try:
        return modal.Dict.from_name(PROGRESS_DICT, create_if_missing=True)
    except Exception:  # noqa: BLE001
        return None


def write_progress(store, run_id, payload: dict) -> None:
    """Stores a progress record under a run's name. Never a gate: a store that fails costs the room its live view, not the run."""
    if store is None or not isinstance(run_id, str) or re.fullmatch(RUN_ID_PATTERN, run_id) is None:
        return
    try:
        text = json.dumps(payload)
        if len(text.encode("utf-8")) <= RL_PROGRESS_MAX_BYTES + 1000:
            store.put(run_id, text)
    except Exception:  # noqa: BLE001
        pass


def read_progress(store, run_id):
    """The latest progress record of a run, or None. A store that fails knows nothing."""
    if store is None or not isinstance(run_id, str) or re.fullmatch(RUN_ID_PATTERN, run_id) is None:
        return None
    try:
        value = store.get(run_id)
        record = json.loads(value) if isinstance(value, str) else None
    except Exception:  # noqa: BLE001
        return None
    return record if isinstance(record, dict) else None


@app.function(image=train_image, secrets=[modal.Secret.from_name("oblab-tinker-auth")], timeout=RUN_TIMEOUT_S, retries=0,
              max_containers=2, cpu=(1, 2), memory=(2048, 8192))
def train_rl(job: dict) -> dict:
    """One RL run. Lab code only; the job is data. The result never carries the Tinker key."""
    store = progress_store()
    run_id = job.get("run_id") if isinstance(job, dict) else None
    return run_rl_core(job, TinkerRlDeps, on_progress=lambda payload: write_progress(store, run_id, payload))


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


def write_manifest(folder: str, manifest: dict, files: list, fmt: str, source, note, clock=time.time, revision=None) -> None:
    """The lab's manifest of the run, with what the copy holds, beside the weights.

    `revision` is the base model revision on Hugging Face whose weight names a
    PEFT copy was converted against, when the conversion said which.
    """
    body = dict(manifest)
    body.update({
        "copy": {
            "format": fmt, "files": files, "bytes": sum(f["bytes"] for f in files), "source": source,
            "copied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock())), "note": note,
        },
    })
    if isinstance(revision, str) and re.fullmatch(HF_REVISION_PATTERN, revision) is not None:
        body["copy"]["base_model_revision"] = revision
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

        fmt, note, source, revision = "tinker", None, raw, None
        converted = os.path.join(scratch, "peft")
        try:
            revision = deps.to_peft(job["base_model"], raw, converted)
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

        # A folder left half written by a runner that was stopped is cleared
        # first. Only one keep runs at a time, so none of them is in use.
        for name in os.listdir(root):
            if name.startswith(".incoming-"):
                shutil.rmtree(os.path.join(root, name), ignore_errors=True)
        incoming = os.path.join(root, ".incoming-%s-%d" % (slug, int(clock() * 1000)))
        shutil.copytree(source, incoming, symlinks=False)
        write_manifest(incoming, job["manifest"], files, fmt, external, note, clock, revision if fmt == "peft" else None)
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
    the file is larger; to_peft(base_model, source, target) -> the base model
    revision the conversion read, or None; commit(); and secrets() -> values
    to scrub from error text.

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


def read_https(url: str, max_bytes: int, first: Optional[int] = None, opener=None) -> bytes:
    """Reads an https address, at most max_bytes of it. With `first`, reads exactly max_bytes starting at that byte.

    A range must be answered as a range (206, starting where it was asked
    to): a server that sends the whole file instead is not read. Redirects
    are followed, as Hugging Face sends its files from another host, but only
    to https. Raises on anything else.
    """
    if not url.startswith("https://"):
        raise ValueError("not an https address")
    headers = {"User-Agent": "observable-lab-runner"}
    if first is not None:
        headers["Range"] = "bytes=%d-%d" % (first, first + max_bytes - 1)
    request = urllib.request.Request(url, headers=headers)
    with (opener or urllib.request.urlopen)(request, timeout=HF_TIMEOUT_S) as response:
        if not str(response.geturl()).startswith("https://"):
            raise ValueError("redirected to an address that is not https")
        if first is not None:
            content_range = str(response.headers.get("Content-Range", ""))
            if response.status != 206 or not content_range.startswith("bytes %d-" % first):
                raise ValueError("the server did not answer with the byte range asked for")
        data = response.read(max_bytes + 1)
    if first is not None and len(data) != max_bytes:
        raise ValueError("the server sent %d bytes of a range of %d" % (len(data), max_bytes))
    if len(data) > max_bytes:
        raise ValueError("more than %d bytes" % max_bytes)
    return data


def base_model_headers(base_model: str, folder: str, read=read_https) -> str:
    """Writes what a PEFT conversion reads of a base model into `folder`, without its weights. Returns the revision read.

    The folder gets the repository's config.json and, for each safetensors
    file at its top, a file of the same name and the same length that holds
    the real header (the names, types and shapes of the weights) and nothing
    after it: the rest is a hole, which takes no room on disk. The cookbook's
    conversion opens these to list names and shapes and never reads a weight.
    Everything is read at one revision, the one the listing names.
    """
    if base_model not in RENDERERS:
        raise ValueError("base_model is not one this runner trains")
    listing = json.loads(read("%s/api/models/%s?blobs=true" % (HF_HOST, base_model), BASE_LISTING_MAX_BYTES).decode("utf-8"))
    revision = listing.get("sha") if isinstance(listing, dict) else None
    if not isinstance(revision, str) or re.fullmatch(HF_REVISION_PATTERN, revision) is None:
        raise ValueError("Hugging Face named no revision for the base model")
    shards = []
    for item in listing.get("siblings") or []:
        name = item.get("rfilename") if isinstance(item, dict) else None
        if isinstance(name, str) and re.fullmatch(BASE_SHARD_PATTERN, name) is not None:
            if not _is_int(item.get("size")) or item["size"] < 8:
                raise ValueError("Hugging Face gave no size for %s" % name)
            shards.append((name, item["size"]))
    if not shards or len(shards) > BASE_MAX_SHARDS:
        raise ValueError("the base model has %d safetensors files at its top" % len(shards))
    resolve = "%s/%s/resolve/%s/" % (HF_HOST, base_model, revision)

    config = read(resolve + "config.json", BASE_CONFIG_MAX_BYTES)
    if not isinstance(json.loads(config.decode("utf-8")), dict):
        raise ValueError("the base model's config.json is not an object")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "config.json"), "wb") as out:
        out.write(config)

    left = BASE_HEADERS_MAX_BYTES
    for name, size in sorted(shards):
        length = int.from_bytes(read(resolve + name, 8, first=0), "little")
        if length < 2 or 8 + length > size or length > left:
            raise ValueError("the header of %s is %d bytes, more than the lab reads" % (name, length))
        left -= length
        header = read(resolve + name, length, first=8)
        if not isinstance(json.loads(header.decode("utf-8")), dict):
            raise ValueError("the header of %s is not an object" % name)
        target = os.path.join(folder, name)
        with open(target, "wb") as out:
            out.write(length.to_bytes(8, "little"))
            out.write(header)
        os.truncate(target, size)
    return revision


def name_base_model(folder: str, base_model: str) -> None:
    """Puts the base model's real name in a converted adapter's config, where the conversion wrote the folder it read from."""
    path = os.path.join(folder, "adapter_config.json")
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
    if not isinstance(config, dict):
        raise ValueError("the converted adapter_config.json is not an object")
    config["base_model_name_or_path"] = base_model
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")


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

    def to_peft(self, base_model: str, source: str, target: str) -> Optional[str]:
        from tinker_cookbook import weights

        # The cookbook's conversion, given a base model's name, downloads the
        # whole repository, weights and all (gigabytes). It reads only the
        # config and the names and shapes of the weights, so it is given a
        # folder that holds just those (base_model_headers). No code from the
        # repository is run. Returns the base model revision that was read.
        stub = tempfile.mkdtemp(prefix="oblab-base-")
        try:
            revision = base_model_headers(base_model, stub)
            weights.build_lora_adapter(base_model=stub, adapter_path=source, output_path=target, trust_remote_code=False)
            name_base_model(target, base_model)
            return revision
        finally:
            shutil.rmtree(stub, ignore_errors=True)

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
    kinds = [k for k in ("train", "rl", "keep", "unkeep") if k in body]
    if len(kinds) != 1:
        return {"problem": "the job is not an object" if not kinds else "a start holds one of train, rl, keep and unkeep"}
    kind = kinds[0]
    job = body[kind]
    problem = check_job(job) if kind == "train" else check_rl_job(job) if kind == "rl" else check_keep(job) if kind == "keep" else check_unkeep(job)
    if problem:
        return {"problem": problem}
    run_id = body.get("run_id")
    if kind in ("train", "rl"):
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
    if work["kind"] == "rl":
        # The run's name goes into the job too, so the runner can write its progress under it.
        return {"call_id": start_once(run_id, _run_names(), lambda: train_rl.spawn(dict(work["job"], run_id=run_id)).object_id)}
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
        # A run that reports as it goes (RL) is asked for by its name too, and says how far it has got.
        record = read_progress(progress_store(), run_id) if run_id else None
        return {"status": "running", "call_id": call_id, **({"progress": record} if record else {})}
    except Exception as e:  # noqa: BLE001
        return {"status": "failed", "call_id": call_id, "error": str(e)[-300:]}
