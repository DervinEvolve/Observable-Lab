# Observable Lab: a smoke test of the Tinker training runner, by hand.
#
# It calls the deployed `train` function of modal/tinker_jobs.py directly with
# my own Modal login, the way the lab server does through HTTP, on a made-up
# dataset of 20 tiny examples. It costs well under one cent at the published
# prices and can never cost more than the 5 cents it sets as the budget. The
# adapter it saves expires after one hour.
#
# Run (after modal/tinker_jobs.py is deployed and both Modal secrets exist):
#   uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py
#
# It prints the runner's result. The Tinker key is not read here and is not
# in the result.
#
# Every check takes a base model, with --model <id> or the environment variable
# TINKER_SMOKE_MODEL (the option wins). The default is Qwen/Qwen3.5-4B; the
# others are the ids of RENDERERS in modal/tinker_jobs.py, for example
#   ... python modal/tinker_smoke.py --model thinkingmachines/Inkling-2-Mini
#   ... python modal/tinker_smoke.py rl --model thinkingmachines/Inkling-2-Mini
# A model that is not in PRICES below is refused before anything is called.
#
# A check of the chat format, for a base model whose renderer takes a thinking
# effort (Inkling 2 Mini), before any run is paid for:
#   uv run ... python modal/tinker_smoke.py render --model thinkingmachines/Inkling-2-Mini
# It calls the deployed `render_check`, which renders one made-up conversation
# the way the runner trains and samples it, with no Tinker call, no key and no
# cost, and prints the prompt it built and six checks: the effort really goes
# in, the sampling prompt is the start of the training example token for token,
# and training weighs only the answer. A renderer or tokenizer that is wrong
# for the model fails it. The training check below (and `keep`) runs it first
# for such a model and stops when it fails.
#
# A second check, of the two HTTP endpoints the lab server uses (it starts one
# more run of the same size, so it costs about the same again):
#   TINKER_JOBS_START_URL=... TINKER_JOBS_STATUS_URL=... JOBS_TOKEN=... \
#     uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py endpoints
# It starts a run under a made-up name, sends the same start again (the runner
# must answer with the same call and start nothing new), asks for the run by
# its name (how the lab finds a run whose start answer was lost), and then
# waits for the result. The token is sent in the Authorization header and is
# never printed.
#
# A check of Tinker RL (docs/TOOLS.md, "Tinker RL"), before it is relied on:
#   uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py rl
# It calls the deployed `train_rl` function with a toy task set of 16 tasks
# ("name a fruit") and a rubric of two rules chosen from the lab's menu (the
# answer is short, and its name starts with a letter from a to m: partial
# credit the base model reaches about half the time), for 4 steps of 2
# tasks with 4 answers each, at most 40 tokens an answer. It prints the mean
# reward of every step, the held-out score before and after (measured with the
# same rubric on tasks the runner held out), and the last progress record the
# room would have drawn the bench from. It costs a few cents at the most and
# can never cost more than the 5 cents it sets as the budget; the adapter it
# saves expires after one hour. Whether the reward moves in so few steps is
# not promised: the check is that every part ran and was measured.
#
# A third check, of keeping an adapter (docs/TOOLS.md, "Keeping a trained
# adapter"), before LAB_ENABLE_TINKER_KEEP is switched on:
#   uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py keep
# It trains the same tiny adapter with its weights also saved for download,
# asks the deployed `keeper` to keep it (a time to live of two hours and a
# copy on the Volume oblab-kept-models under a made-up id), prints what the
# keeper answered, and then unkeeps it and removes the copy again. It costs
# about the same as the first check; the two checkpoints it leaves on Tinker
# expire within the hour.
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import modal

DEFAULT_MODEL = "Qwen/Qwen3.5-4B"
# US dollars per million tokens, as published on 2026-11-25 (api/_lib/tinker.ts, TINKER_PRICES). The cost lines
# below and the budget check of the runner use the prices of the model being tried.
PRICES = {
    "Qwen/Qwen3.5-4B": {"train": 0.737, "sample": 1.005, "prefill": 0.33},
    "Qwen/Qwen3.5-9B": {"train": 1.463, "sample": 0.807, "prefill": 0.30},
    "Qwen/Qwen3.6-35B-A3B": {"train": 1.177, "sample": 1.335, "prefill": 0.45},
    "thinkingmachines/Inkling-2-Mini": {"train": 0.75, "sample": 0.50, "prefill": 0.15},
}
# Renderers that take a thinking effort have a format worth checking by itself (render_check in tinker_jobs.py).
EFFORT_MODELS = ("thinkingmachines/Inkling-2-Mini",)

COLOURS = ["red", "orange", "yellow", "green", "blue", "indigo", "violet", "brown", "grey", "white",
           "black", "pink", "teal", "gold", "silver", "cyan", "lime", "navy", "plum", "tan"]

def train_job(model: str = DEFAULT_MODEL) -> dict:
    return {
        "base_model": model,
        "examples": [
            {"messages": [
                {"role": "user", "content": "What is the lab code for the colour %s?" % colour},
                {"role": "assistant", "content": "The lab code for %s is OL-%03d." % (colour, 100 + 7 * i)},
            ]}
            for i, colour in enumerate(COLOURS)
        ],
        "settings": {"rank": 8, "learning_rate": 2e-4, "epochs": 2, "batch_size": 6},
        "split_salt": secrets.token_hex(16),
        "budget_usd": 0.05,
        "prices": dict(PRICES[model]),
        "ttl_seconds": 3600,
        "samples": 2,
        "sample_max_tokens": 40,
        "label": "smoke test",
    }


job = train_job()


def cost_of(tokens: dict, model: str) -> float:
    price = PRICES[model]
    return ((tokens.get("train", 0) + tokens.get("eval", 0)) * price["train"]
            + tokens.get("sample_prompt", 0) * price["prefill"] + tokens.get("sample_completion", 0) * price["sample"]) / 1e6


def report(result: dict, model: str = DEFAULT_MODEL) -> None:
    print(json.dumps(result, indent=2))
    print("estimated cost at the published prices: $%.6f (an estimate, not a billed amount)" % cost_of(result.get("tokens", {}), model))
    if result.get("status") == "ok":
        print("held-out loss %.4f -> %.4f on %d examples the runner chose" % (
            result["holdout_loss_before"], result["holdout_loss_after"], result["n_holdout"]))
        print("adapter for the chat check: %s" % result["sampler_path"])


def verify_train(result: dict, model: str) -> list:
    """What a run on a model other than the default must show, beyond finishing. Returns the problems.

    The runner trains on 18 made-up answers of the form "The lab code for <colour> is OL-nnn." If the chat format
    were wrong (a reasoning block trained in, or sampled at another effort than trained) the loss would not fall
    or the sampled answers would not be that short direct answer.
    """
    problems = []
    if result.get("status") != "ok":
        return ["the run did not finish: %s %s" % (result.get("status"), result.get("reason") or result.get("error"))]
    if not result["holdout_loss_after"] < result["holdout_loss_before"]:
        problems.append("the held-out loss did not fall (%.4f -> %.4f)" % (result["holdout_loss_before"], result["holdout_loss_after"]))
    samples = result.get("samples") or []
    if not samples:
        problems.append("no sampled answers came back")
    for sample in samples:
        text = sample.get("completion") or ""
        if "OL-" not in text:
            problems.append("a sampled answer is not the trained direct answer: %r" % text[:80])
    return problems


def render(model: str) -> int:
    """Asks the deployed runner to render and judge the chat format of a base model. 0 when every check passed."""
    result = modal.Function.from_name("oblab-tinker", "render_check").remote(model)
    print("renderer %s, effort %s, %s tokens in the generation prompt" % (result.get("renderer"), result.get("effort"), result.get("prompt_tokens")))
    if result.get("prompt_text"):
        print("the generation prompt, decoded:\n%s" % result["prompt_text"])
    for check in result.get("checks", []):
        print("%s %s" % ("ok  " if check["ok"] else "FAIL", check["what"]))
    if result.get("status") == "skipped":
        print("render: nothing to check for %s (%s)" % (model, result.get("reason")))
        return 0
    if result.get("status") != "ok":
        print("render: FAILED %s" % (result.get("reason") or "see the checks above"))
        return 1
    print("render: all checks passed")
    return 0


FRUITS = ["apple", "pear", "plum", "fig", "lime", "kiwi", "peach", "grape", "mango", "melon", "lemon", "cherry", "banana", "orange", "papaya", "guava"]

# A toy with partial credit the base model reaches about half the time, so some groups of answers differ and a
# training step really runs: a short answer earns half, and a name from the first half of the alphabet earns the
# other half. The second rule is arbitrary on purpose. It is here to be learned, not to mean anything.
def rl_job_for(model: str = DEFAULT_MODEL) -> dict:
    return {
        "base_model": model,
        "tasks": [{"prompt": "Name one fruit other than a %s. Answer with the name only." % fruit} for fruit in FRUITS],
        "rubric": {"rules": [
            {"type": "length_between", "weight": 0.5, "min": 1, "max": 12, "scope": "last_line"},
            {"type": "regex_match", "weight": 0.5, "pattern": "^[a-m]", "ignore_case": True, "scope": "last_line"},
        ]},
        "settings": {"rank": 8, "learning_rate": 1e-4, "group_size": 4, "steps": 4, "tasks_per_step": 2, "max_completion_tokens": 40, "loss": "importance_sampling"},
        "split_salt": secrets.token_hex(16),
        "budget_usd": 0.05,
        "prices": dict(PRICES[model]),
        "ttl_seconds": 3600,
        "samples": 2,
        "label": "smoke test rl",
    }


rl_job = rl_job_for()


def rl(model: str = DEFAULT_MODEL) -> int:
    """Runs a tiny RL run on the deployed runner and prints what was measured. 0 when every part ran."""
    if model in EFFORT_MODELS and render(model) != 0:
        print("rl: the chat format check failed, so nothing was run")
        return 1
    run_id = "e0-%s" % secrets.token_hex(4)
    result = modal.Function.from_name("oblab-tinker", "train_rl").remote(dict(rl_job_for(model), run_id=run_id))
    print(json.dumps(result, indent=2))
    tokens = result.get("tokens", {})
    price = PRICES[model]
    cost = (tokens.get("train", 0) * price["train"] + tokens.get("sample_prompt", 0) * price["prefill"] + tokens.get("sample_completion", 0) * price["sample"]) / 1e6
    print("estimated cost at the published prices: $%.6f (an estimate, not a billed amount)" % cost)
    if result.get("status") != "ok":
        print("rl: the run did not finish: %s %s" % (result.get("status"), result.get("reason") or result.get("error")))
        return 1
    for number, mean in enumerate(result.get("step_means", []), 1):
        print("step %d: mean reward %.3f (share at the best score %.2f)" % (number, mean, result["step_frac_max"][number - 1]))
    print("held-out score, measured by the runner with the rubric: %.3f before, %.3f after (best possible %.2f, %d tasks held out)" % (
        result["score_before"], result["score_after"], result["max_reward"], result["n_holdout"]))
    record = None
    try:
        record = json.loads(modal.Dict.from_name("oblab-tinker-progress").get(run_id))
    except Exception as error:  # noqa: BLE001
        print("the progress record could not be read: %s" % type(error).__name__)
    if record:
        print("the last progress record the room would draw from: phase %s, step %s of %s, %d means" % (
            record.get("phase"), record.get("step"), record.get("steps_planned"), len(record.get("means", []))))
    print("steps that trained the model (some answers in a group scored differently): %s of %s" % (result.get("steps_trained"), result.get("steps_done")))
    print("adapter for the chat check: %s" % result["sampler_path"])
    if not result.get("steps_trained"):
        print("rl: no step trained the model, so the training call was not tried; run it again")
        return 1
    print("rl: all parts ran")
    return 0


def call(method: str, url: str, token: str, body=None) -> dict:
    """One request to an endpoint of the runner. Returns {"http": status, ...the JSON answer}."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer %s" % token, "Content-Type": "application/json", "User-Agent": "observable-lab-smoke",
    })
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return dict(json.loads(response.read().decode("utf-8")), http=response.status)
    except urllib.error.HTTPError as error:
        return {"http": error.code, "error": error.read().decode("utf-8", "replace")[:200]}


def endpoints(model: str = DEFAULT_MODEL) -> int:
    """Checks start and status as the lab server uses them. 0 when everything was as expected."""
    try:
        start_url, status_url, token = (os.environ[k].strip() for k in ("TINKER_JOBS_START_URL", "TINKER_JOBS_STATUS_URL", "JOBS_TOKEN"))
    except KeyError as missing:
        print("set %s first (see docs/OPERATIONS.md, Tinker training, step 4)" % missing)
        return 2
    train = train_job(model)
    run_id = "e0-%s" % secrets.token_hex(4)
    by_name = "%s?%s" % (status_url, urllib.parse.urlencode({"run_id": run_id}))
    problems = []

    def expect(what: str, ok: bool, got) -> None:
        print("%s %s: %s" % ("ok  " if ok else "FAIL", what, got))
        if not ok:
            problems.append(what)

    before = call("GET", by_name, token)
    expect("a run that was never started is not known by its name", before.get("status") == "unknown", before)
    first = call("POST", start_url, token, {"run_id": run_id, "train": train})
    call_id = first.get("call_id")
    expect("start answers with a call id", first.get("http") == 200 and isinstance(call_id, str), first)
    if not isinstance(call_id, str):
        return 1
    again = call("POST", start_url, token, {"run_id": run_id, "train": train})
    expect("the same start sent again gives the same call and starts nothing new", again.get("call_id") == call_id, again)
    named = call("GET", by_name, token)
    expect("the run is found by its name", named.get("call_id") == call_id, {k: named.get(k) for k in ("http", "status", "call_id")})
    by_call = "%s?%s" % (status_url, urllib.parse.urlencode({"call_id": call_id}))
    answer = {}
    for _ in range(90):
        answer = call("GET", by_call, token)
        if answer.get("status") != "running":
            break
        time.sleep(10)
    expect("the run finishes", answer.get("status") == "done", {k: answer.get(k) for k in ("http", "status", "error")})
    if isinstance(answer.get("result"), dict):
        report(answer["result"], model)
        expect("the run trained, was measured and was saved", answer["result"].get("status") == "ok", answer["result"].get("status"))
        if model != DEFAULT_MODEL:
            problems_found = verify_train(answer["result"], model)
            expect("the loss fell and the samples are the trained direct answer", not problems_found, problems_found or "yes")
    print("endpoints: %s" % ("all as expected" if not problems else "%d problem(s): %s" % (len(problems), "; ".join(problems))))
    return 1 if problems else 0


def keep(model: str = DEFAULT_MODEL) -> int:
    """Trains with the weights saved for download, keeps the adapter, then unkeeps it and removes the copy. 0 when all was as expected."""
    problems = []

    def expect(what: str, ok: bool, got) -> None:
        print("%s %s: %s" % ("ok  " if ok else "FAIL", what, got))
        if not ok:
            problems.append(what)

    if model in EFFORT_MODELS and render(model) != 0:
        print("keep: the chat format check failed, so nothing was run")
        return 1
    job = train_job(model)
    trained = modal.Function.from_name("oblab-tinker", "train").remote(dict(job, export=True))
    report(trained, model)
    expect("the run trained and was saved", trained.get("status") == "ok", trained.get("status"))
    expect("its weights were also saved for download", isinstance(trained.get("external_path"), str),
           trained.get("external_path") or trained.get("export_error"))
    if trained.get("status") != "ok":
        return 1
    slug = "e0-%s" % secrets.token_hex(4)
    keeper = modal.Function.from_name("oblab-tinker", "keeper")
    kept = keeper.remote({"action": "keep", "keep": {
        "slug": slug, "base_model": job["base_model"], "sampler_path": trained["sampler_path"],
        "external_path": trained.get("external_path"), "ttl_seconds": 7200, "max_bytes": 1024 * 1024 * 1024,
        "manifest": {"schema": "observable-lab/kept-adapter/1", "lab_id": "lab/%s" % slug, "name": None,
                     "base_model": job["base_model"], "kept_by": "the owner", "kept_reason": "smoke test"},
    }})
    print(json.dumps(kept, indent=2))
    copy = kept.get("copy") or {}
    expect("the time to live was set", kept.get("status") == "ok" and kept.get("ttl_seconds") == 7200, kept.get("status"))
    expect("a copy was written to the Volume", copy.get("status") == "ok", copy.get("reason") or copy.get("status"))
    expect("the copy is in PEFT format", copy.get("format") == "peft", copy.get("format"))
    print("checkpoints the account holds now: %s (the free plan allows 100)" % kept.get("checkpoints"))
    if copy.get("status") == "ok":
        print("look at it with: modal volume ls oblab-kept-models %s" % slug)
    undone = keeper.remote({"action": "unkeep", "unkeep": {
        "slug": slug, "sampler_path": trained["sampler_path"], "external_path": trained.get("external_path"),
        "ttl_seconds": 3600, "remove_copy": True,
    }})
    print(json.dumps(undone, indent=2))
    expect("the unkeep put the short time to live back", undone.get("status") == "ok" and undone.get("ttl_seconds") == 3600, undone.get("status"))
    expect("the copy was removed again", (undone.get("copy") or {}).get("reason") in (
        "The copy on the Volume was removed.", "There was no copy on the Volume to remove."), (undone.get("copy") or {}).get("reason"))
    print("keep: %s" % ("all as expected" if not problems else "%d problem(s): %s" % (len(problems), "; ".join(problems))))
    return 1 if problems else 0


def choose_model(args: list) -> tuple:
    """(model, remaining args). --model <id> wins over TINKER_SMOKE_MODEL; the default is Qwen/Qwen3.5-4B. Exits on an unknown model."""
    rest = list(args)
    model = os.environ.get("TINKER_SMOKE_MODEL", "").strip() or DEFAULT_MODEL
    if "--model" in rest:
        at = rest.index("--model")
        if at + 1 >= len(rest):
            sys.exit("--model needs a model id")
        model = rest[at + 1].strip()
        del rest[at:at + 2]
    if model not in PRICES:
        sys.exit("unknown base model %r; the runner trains: %s" % (model, ", ".join(PRICES)))
    return model, rest


def train(model: str = DEFAULT_MODEL) -> int:
    """The plain run: trains, measures, saves and prints. For a model other than the default it also judges the result."""
    if model in EFFORT_MODELS and render(model) != 0:
        print("train: the chat format check failed, so nothing was run")
        return 1
    result = modal.Function.from_name("oblab-tinker", "train").remote(train_job(model))
    report(result, model)
    if model == DEFAULT_MODEL:
        return 0
    problems = verify_train(result, model)
    for problem in problems:
        print("FAIL %s" % problem)
    print("train %s: %s" % (model, "all as expected" if not problems else "%d problem(s)" % len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    chosen, rest = choose_model(sys.argv[1:])
    if rest == ["endpoints"]:
        sys.exit(endpoints(chosen))
    if rest == ["keep"]:
        sys.exit(keep(chosen))
    if rest == ["rl"]:
        sys.exit(rl(chosen))
    if rest == ["render"]:
        sys.exit(render(chosen))
    if rest:
        sys.exit("unknown argument(s) %s; use endpoints, keep, rl, render, or nothing, with --model <id>" % " ".join(rest))
    sys.exit(train(chosen))
