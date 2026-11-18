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
import json
import secrets

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

if __name__ == "__main__":
    train = modal.Function.from_name("oblab-tinker", "train")
    result = train.remote(job)
    print(json.dumps(result, indent=2))
    tokens = result.get("tokens", {})
    cost = ((tokens.get("train", 0) + tokens.get("eval", 0)) * 0.737
            + tokens.get("sample_prompt", 0) * 0.33 + tokens.get("sample_completion", 0) * 1.005) / 1e6
    print("estimated cost at the published prices: $%.6f (an estimate, not a billed amount)" % cost)
    if result.get("status") == "ok":
        print("held-out loss %.4f -> %.4f on %d examples the runner chose" % (
            result["holdout_loss_before"], result["holdout_loss_after"], result["n_holdout"]))
        print("adapter for the chat check: %s" % result["sampler_path"])
