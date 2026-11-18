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
# A second check, of the two HTTP endpoints the lab server uses (it starts one
# more run of the same size, so it costs about the same again):
#   TINKER_JOBS_START_URL=... TINKER_JOBS_STATUS_URL=... JOBS_TOKEN=... \
#     uv run --no-project --python 3.12 --with-requirements requirements-runner.txt python modal/tinker_smoke.py endpoints
# It starts a run under a made-up name, sends the same start again (the runner
# must answer with the same call and start nothing new), asks for the run by
# its name (how the lab finds a run whose start answer was lost), and then
# waits for the result. The token is sent in the Authorization header and is
# never printed.
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import modal

COLOURS = ["red", "orange", "yellow", "green", "blue", "indigo", "violet", "brown", "grey", "white",
           "black", "pink", "teal", "gold", "silver", "cyan", "lime", "navy", "plum", "tan"]

job = {
    "base_model": "Qwen/Qwen3.5-4B",
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
    # Qwen/Qwen3.5-4B, US dollars per million tokens, as published on 2026-11-18.
    "prices": {"train": 0.737, "sample": 1.005, "prefill": 0.33},
    "ttl_seconds": 3600,
    "samples": 2,
    "sample_max_tokens": 40,
    "label": "smoke test",
}


def report(result: dict) -> None:
    print(json.dumps(result, indent=2))
    tokens = result.get("tokens", {})
    cost = ((tokens.get("train", 0) + tokens.get("eval", 0)) * 0.737
            + tokens.get("sample_prompt", 0) * 0.33 + tokens.get("sample_completion", 0) * 1.005) / 1e6
    print("estimated cost at the published prices: $%.6f (an estimate, not a billed amount)" % cost)
    if result.get("status") == "ok":
        print("held-out loss %.4f -> %.4f on %d examples the runner chose" % (
            result["holdout_loss_before"], result["holdout_loss_after"], result["n_holdout"]))
        print("adapter for the chat check: %s" % result["sampler_path"])


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


def endpoints() -> int:
    """Checks start and status as the lab server uses them. 0 when everything was as expected."""
    try:
        start_url, status_url, token = (os.environ[k].strip() for k in ("TINKER_JOBS_START_URL", "TINKER_JOBS_STATUS_URL", "JOBS_TOKEN"))
    except KeyError as missing:
        print("set %s first (see docs/OPERATIONS.md, Tinker training, step 4)" % missing)
        return 2
    run_id = "e0-%s" % secrets.token_hex(4)
    by_name = "%s?%s" % (status_url, urllib.parse.urlencode({"run_id": run_id}))
    problems = []

    def expect(what: str, ok: bool, got) -> None:
        print("%s %s: %s" % ("ok  " if ok else "FAIL", what, got))
        if not ok:
            problems.append(what)

    before = call("GET", by_name, token)
    expect("a run that was never started is not known by its name", before.get("status") == "unknown", before)
    first = call("POST", start_url, token, {"run_id": run_id, "train": job})
    call_id = first.get("call_id")
    expect("start answers with a call id", first.get("http") == 200 and isinstance(call_id, str), first)
    if not isinstance(call_id, str):
        return 1
    again = call("POST", start_url, token, {"run_id": run_id, "train": job})
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
        report(answer["result"])
        expect("the run trained, was measured and was saved", answer["result"].get("status") == "ok", answer["result"].get("status"))
    print("endpoints: %s" % ("all as expected" if not problems else "%d problem(s): %s" % (len(problems), "; ".join(problems))))
    return 1 if problems else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["endpoints"]:
        sys.exit(endpoints())
    report(modal.Function.from_name("oblab-tinker", "train").remote(job))
