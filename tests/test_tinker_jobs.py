"""The Tinker training runner (modal/tinker_jobs.py), tested without Modal or Tinker.

Only the constants and function definitions are loaded, and the training
service is a fake behind the few calls run_core makes; no network, GPU or
provider is contacted. Run: python -m unittest discover -s tests
"""
import ast
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
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "modal" / "tinker_jobs.py").read_text()
TREE = ast.parse(SOURCE)
TOKEN = "test-only-tinker-jobs-token-0000000000000"
KEY = "tml-test-only-not-a-real-tinker-key-0000"


def _uses(node, names):
    return any(isinstance(n, ast.Name) and n.id in names for n in ast.walk(node))


def load(extra=None):
    """The file's constants and functions, without its Modal objects or its Tinker class."""
    namespace = {
        "hashlib": hashlib, "hmac": hmac, "json": json, "math": math, "os": os, "re": re, "shutil": shutil, "tempfile": tempfile,
        "time": time, "urllib": urllib, "Optional": Optional, "HTTPException": HTTPException, "Request": Request,
    }
    selected = []
    for node in ast.parse(SOURCE).body:  # a fresh tree: the decorators are taken off below
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            node.decorator_list = []
            selected.append(node)
        elif isinstance(node, ast.Assign) and not _uses(node.value, {"modal", "app"}):
            selected.append(node)
    exec(compile(ast.Module(body=selected, type_ignores=[]), "modal/tinker_jobs.py", "exec"), namespace)
    # Stand-ins for the Modal objects go in last, over the plain functions of the same name.
    namespace.update(extra or {})
    return SimpleNamespace(**namespace)


M = load()
SALT = "0123456789abcdef0123456789abcdef"
PRICES = {"train": 0.737, "sample": 1.005, "prefill": 0.33}


def example(i):
    return {"messages": [{"role": "user", "content": "Question number %d?" % i}, {"role": "assistant", "content": "Answer number %d." % i}]}


def job(**changes):
    base = {
        "base_model": "Qwen/Qwen3.5-4B", "examples": [example(i) for i in range(20)],
        "settings": {"rank": 16, "learning_rate": 2e-4, "epochs": 2, "batch_size": 8},
        "split_salt": SALT, "budget_usd": 0.05, "prices": dict(PRICES), "ttl_seconds": 14 * 86400,
        "samples": 3, "sample_max_tokens": 120, "label": "test",
    }
    base.update(changes)
    return base


class Clock:
    def __init__(self, step=0.0):
        self.now = 1000.0
        self.step = step

    def __call__(self):
        self.now += self.step
        return self.now


class FakeDeps:
    """A training service that counts what it is asked to do. An example is 10 tokens for each of its messages."""

    def __init__(self, job, tokens_per_message=10, fail_at_step=None, fail_sample=False, loss=3.0):
        self.job = job
        self.tokens_per_message = tokens_per_message
        self.fail_at_step = fail_at_step
        self.fail_sample = fail_sample
        self.loss = loss
        self.forwards = []
        self.trained = []
        self.saved = []
        self.sampled = []

    def secrets(self):
        return [KEY]

    def datum(self, conversation):
        length = self.tokens_per_message * len(conversation)
        text = conversation[-2]["content"]
        # Only the last few positions carry weight, as the last assistant message does.
        return {"text": text, "length": length}, length, [0.0] * (length - 4) + [0.25] * 4

    def prompt(self, conversation):
        return {"prompt": conversation[-1]["content"]}, self.tokens_per_message * len(conversation)

    def _logprobs(self, datums):
        return [[-self.loss] * d["length"] for d in datums]

    def forward(self, datums):
        self.forwards.append([d["text"] for d in datums])
        return self._logprobs(datums)

    def forward_backward(self, datums, learning_rate):
        if self.fail_at_step is not None and len(self.trained) + 1 == self.fail_at_step:
            raise RuntimeError("401 Unauthorized for key %s at step %d" % (KEY, self.fail_at_step))
        self.trained.append(([d["text"] for d in datums], learning_rate))
        out = self._logprobs(datums)
        self.loss *= 0.8
        return out

    def save(self, ttl_seconds):
        self.saved.append(ttl_seconds)
        return "tinker://11111111-2222-3333-4444-555555555555:train:0/sampler_weights/final"

    def sample(self, path, prompt, max_tokens):
        if self.fail_sample:
            raise RuntimeError("sampling is down, key %s" % KEY)
        self.sampled.append((path, prompt["prompt"], max_tokens))
        return "a sampled answer", 7


def run(j, **deps_options):
    made = []

    def make(checked):
        made.append(FakeDeps(checked, **deps_options))
        return made[-1]

    logs = []
    result = M.run_core(j, make, clock=Clock(), log=logs.append)
    return result, (made[0] if made else None), logs


class SplitTests(unittest.TestCase):
    def test_about_a_tenth_is_held_out_with_a_floor_and_a_ceiling(self):
        self.assertEqual([M.holdout_count(n) for n in (10, 20, 21, 30, 199, 2000)], [2, 2, 3, 3, 20, 200])

    def test_the_split_is_fixed_by_the_salt_and_changes_with_it(self):
        train, held = M.split_indexes(200, SALT)
        self.assertEqual((train, held), M.split_indexes(200, SALT))
        self.assertEqual(len(held), 20)
        self.assertEqual(sorted(train + held), list(range(200)))
        self.assertFalse(set(train) & set(held))
        other = M.split_indexes(200, "f" * 32)[1]
        self.assertNotEqual(held, other)
        # Not the first or the last tenth: where an example sits in the request says nothing about its side.
        self.assertNotEqual(held, list(range(20)))
        self.assertNotEqual(held, list(range(180, 200)))
        # Over many salts every position is held out sometimes.
        seen = set()
        for i in range(60):
            seen.update(M.split_indexes(20, hashlib.sha256(str(i).encode()).hexdigest()[:32])[1])
        self.assertEqual(seen, set(range(20)))

    def test_every_epoch_trains_on_each_training_example_once_and_never_on_a_held_out_one(self):
        train, held = M.split_indexes(53, SALT)
        batches = M.plan_batches(train, 8, 3, SALT)
        self.assertEqual(len(batches), math.ceil(len(train) / 8) * 3)
        self.assertTrue(all(1 <= len(b) <= 8 for b in batches))
        per_epoch = math.ceil(len(train) / 8)
        epochs = [sorted(i for b in batches[e * per_epoch:(e + 1) * per_epoch] for i in b) for e in range(3)]
        self.assertEqual(epochs, [train, train, train])
        self.assertFalse(set(i for b in batches for i in b) & set(held))
        self.assertEqual(batches, M.plan_batches(train, 8, 3, SALT))
        self.assertNotEqual(batches[:per_epoch], batches[per_epoch:2 * per_epoch])


class CostTests(unittest.TestCase):
    def test_tokens_are_priced_at_the_published_prices_per_million(self):
        self.assertAlmostEqual(M.cost_usd({"train": 1_000_000}, PRICES), 0.737)
        self.assertAlmostEqual(M.cost_usd({"eval": 1_000_000}, PRICES), 0.737)
        self.assertAlmostEqual(M.cost_usd({"sample_prompt": 1_000_000, "sample_completion": 1_000_000}, PRICES), 0.33 + 1.005)
        self.assertEqual(M.cost_usd({}, PRICES), 0)

    def test_the_plan_counts_every_batch_two_held_out_passes_and_the_samples(self):
        lengths = [10, 20, 30, 40, 50]
        plan = M.planned_tokens(lengths, [[0, 1], [2], [0, 1], [2]], [3, 4], [7, 9], 120)
        self.assertEqual(plan, {"train": 120, "eval": 180, "sample_prompt": 16, "sample_completion": 240})
        self.assertEqual(M.closing_tokens(lengths, [3, 4], [7, 9], 120), {"eval": 90, "sample_prompt": 16, "sample_completion": 240})

    def test_loss_is_the_weighted_mean_per_example_whatever_scale_the_weights_have(self):
        logprobs = [-9.0, -9.0, -1.0, -3.0]
        self.assertAlmostEqual(M.example_loss(logprobs, [0, 0, 1, 1]), 2.0)
        self.assertAlmostEqual(M.example_loss(logprobs, [0, 0, 0.5, 0.5]), 2.0)
        self.assertIsNone(M.example_loss(logprobs, [0, 0, 0, 0]))
        self.assertAlmostEqual(M.mean_loss([1.0, 3.0, None, float("nan")]), 2.0)
        self.assertIsNone(M.mean_loss([None]))


class CheckJobTests(unittest.TestCase):
    def test_a_well_formed_job_is_accepted(self):
        self.assertIsNone(M.check_job(job()))
        with_system = [{"messages": [{"role": "system", "content": "Be brief."}] + example(i)["messages"]} for i in range(20)]
        self.assertIsNone(M.check_job(job(examples=with_system)))

    def test_anything_else_is_refused_with_a_reason(self):
        two = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
        many = [example(i) for i in range(19)]
        cases = [
            (None, "not an object"),
            (job(base_model="openai/gpt-oss-20b"), "base_model"),
            (job(base_model="Qwen/Qwen3.6-27B"), "base_model"),
            (job(examples=[example(i) for i in range(9)]), "10 to 2000"),
            (job(examples=[example(i) for i in range(2001)]), "10 to 2000"),
            (job(examples=many + [{"messages": two, "weight": 3}]), "only \"messages\""),
            (job(examples=many + [{"messages": two[:1]}]), "2 to 12 messages"),
            (job(examples=many + [{"messages": [{"role": "tool", "content": "x"}, two[1]]}]), "role"),
            (job(examples=many + [{"messages": [two[1], two[0]]}]), "alternate"),
            (job(examples=many + [{"messages": two + two[:1]}]), "alternate"),
            (job(examples=many + [{"messages": [{"role": "user", "content": ""}, two[1]]}]), "non-empty"),
            (job(examples=many + [{"messages": [{"role": "user", "content": "q", "name": "n"}, two[1]]}]), "only \"role\""),
            (job(examples=many + [{"messages": [{"role": "user", "content": "x" * 6001}, two[1]]}]), "6000 bytes"),
            (job(examples=[{"messages": [{"role": "user", "content": "%d %s" % (i, "y" * 4500)}, two[1]]} for i in range(30)]), "120000 bytes"),
            (job(settings={"rank": 16, "learning_rate": 2e-4, "epochs": 2}), "settings must hold"),
            (job(settings={"rank": 64, "learning_rate": 2e-4, "epochs": 2, "batch_size": 8}), "rank"),
            (job(settings={"rank": 16, "learning_rate": 1.0, "epochs": 2, "batch_size": 8}), "learning_rate"),
            (job(settings={"rank": 16, "learning_rate": 2e-4, "epochs": 9, "batch_size": 8}), "epochs"),
            (job(settings={"rank": 16, "learning_rate": 2e-4, "epochs": True, "batch_size": 8}), "epochs"),
            (job(settings={"rank": 16, "learning_rate": 2e-4, "epochs": 2, "batch_size": 64}), "batch_size"),
            (job(split_salt="short"), "split_salt"),
            (job(split_salt="Z" * 32), "split_salt"),
            (job(budget_usd=0), "budget_usd"),
            (job(budget_usd=5.01), "budget_usd"),
            (job(budget_usd=float("nan")), "budget_usd"),
            (job(prices={"train": 0.737, "sample": 1.005}), "prices"),
            (job(prices={"train": -1, "sample": 1.005, "prefill": 0.33}), "prices"),
            (job(ttl_seconds=60), "ttl_seconds"),
            (job(ttl_seconds=400 * 86400), "ttl_seconds"),
            (job(samples=50), "samples"),
            (job(sample_max_tokens=5000), "sample_max_tokens"),
            (job(examples=[example(i) for i in range(700)], settings={"rank": 16, "learning_rate": 2e-4, "epochs": 1, "batch_size": 1}), "630 optimizer steps"),
        ]
        for bad, expected in cases:
            problem = M.check_job(bad)
            self.assertIsNotNone(problem, expected)
            self.assertIn(expected, problem)

    def test_the_hard_limits_are_the_ones_the_owner_was_told(self):
        self.assertEqual((M.MAX_EXAMPLES, M.MAX_STEPS, M.HARD_RUN_USD), (2000, 600, 5.0))
        self.assertEqual((M.TRAIN_WALL_S, M.RUN_TIMEOUT_S), (1800, 2700))
        self.assertLess(M.TRAIN_WALL_S, M.RUN_TIMEOUT_S)
        self.assertEqual(sorted(M.RENDERERS), ["Qwen/Qwen3.5-4B", "Qwen/Qwen3.5-9B", "Qwen/Qwen3.6-35B-A3B", "thinkingmachines/Inkling-2-Mini"])

    def test_inkling_2_mini_is_accepted_with_the_one_renderer_tinker_documents_and_nothing_near_it_is(self):
        mini = "thinkingmachines/Inkling-2-Mini"
        self.assertEqual(M.RENDERERS[mini], "tml_v0")
        self.assertIsNone(M.check_job(job(base_model=mini, prices={"train": 0.75, "sample": 0.50, "prefill": 0.15})))
        # Its 256K variant, its free tier, its bigger sibling, the first Inkling and a made-up one are all refused.
        for other in (mini + ":peft:262144", mini + ":peft:65536:free", "thinkingmachines/Inkling-2-Small", "thinkingmachines/Inkling",
                      "thinkingmachines/Inkling-Small", "thinkingmachines/inkling-2-mini", mini + " ", "Qwen/Qwen3.6-27B"):
            self.assertIn("base_model", M.check_job(job(base_model=other)) or "", other)

    def test_a_renderer_that_takes_a_thinking_effort_is_trained_and_sampled_at_none(self):
        self.assertEqual(M.RENDER_EFFORT, {"tml_v0": 0.0})
        # Every renderer is either one without a thinking block (Qwen) or has an effort, so none is left on a default of high.
        for model, name in M.RENDERERS.items():
            self.assertTrue(name in M.RENDER_EFFORT or name.endswith("_disable_thinking"), model)

    def test_a_run_on_inkling_2_mini_is_costed_at_its_own_prices(self):
        prices = {"train": 0.75, "sample": 0.50, "prefill": 0.15}
        result, deps, _ = run(job(base_model="thinkingmachines/Inkling-2-Mini", prices=prices))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["tokens"], {"train": 720, "eval": 80, "sample_prompt": 20, "sample_completion": 14})
        self.assertAlmostEqual(M.cost_usd(result["tokens"], prices), (720 + 80) * 0.75 / 1e6 + 20 * 0.15 / 1e6 + 14 * 0.50 / 1e6, places=9)
        # The same tokens cost more under a made-up higher price, so the prices sent with the job are the ones used.
        self.assertGreater(M.cost_usd(result["tokens"], PRICES), M.cost_usd(result["tokens"], prices))


TAIL_CHECK = "the weights cover the answer and at most 4 format tokens on each side of it"


class RenderCheckTests(unittest.TestCase):
    """judge_render: what a correct renderer passes and what a wrong one fails. Token lists stand in for the real tokenizer."""

    decode = staticmethod(lambda ids: "".join(chr(i) for i in ids))

    def good(self):
        prompt = [1, 2, 3, 4]
        other = [1, 2, 9, 4]
        answer = [ord(c) for c in M.RENDER_CHECK_ANSWER]
        example = prompt + answer + [5]
        weights = [0.0] * len(prompt) + [0.1] * (len(answer) + 1)
        return prompt, other, example, weights

    def failed(self, prompt, other, example, weights):
        return [c["what"] for c in M.judge_render(prompt, other, example, weights, self.decode) if not c["ok"]]

    def test_a_renderer_that_renders_prompt_and_example_alike_passes_every_check(self):
        self.assertEqual(self.failed(*self.good()), [])

    def test_an_effort_that_is_not_sent_fails(self):
        prompt, _, example, weights = self.good()
        self.assertEqual(self.failed(prompt, list(prompt), example, weights), ["a different effort gives a different prompt, so the effort is really sent"])

    def test_training_data_rendered_in_another_format_than_the_prompt_fails(self):
        prompt, other, example, weights = self.good()
        example = [7] + example[1:]  # the example opens differently from the prompt
        self.assertIn("the generation prompt is the start of the training example, token for token", self.failed(prompt, other, example, weights))

    def test_weights_that_reach_into_the_prompt_fail(self):
        prompt, other, example, weights = self.good()
        weights = [0.0, 0.0, 0.1] + weights[3:]
        self.assertIn("training weighs nothing the sampling prompt already holds", self.failed(prompt, other, example, weights))

    def test_training_on_something_other_than_the_answer_fails(self):
        prompt, other, example, weights = self.good()
        example = prompt + [ord(c) for c in "Let me think about this for a long while before I say anything at all. " * 3]
        weights = [0.0] * len(prompt) + [0.1] * (len(example) - len(prompt))
        failed = self.failed(prompt, other, example, weights)
        self.assertIn("the weighted tokens are the answer", failed)
        self.assertIn(TAIL_CHECK, failed)

    def test_format_markers_with_long_names_pass_because_they_are_counted_as_tokens(self):
        # Inkling as the runner really renders it (cookbook 0.7.1): two marker tokens before the answer and two after,
        # 33 and 45 characters when decoded. Judged in characters this failed on the real service on 25 November 2026.
        names = {900: "<|message_model|>", 901: "<|content_text|>", 902: "<|end_message|>", 903: "<|content_model_end_sampling|>"}
        decode = lambda ids: "".join(names.get(i, chr(i)) for i in ids)
        prompt, other, _, _ = self.good()
        answer = [ord(c) for c in M.RENDER_CHECK_ANSWER]
        example = prompt + [900, 901] + answer + [902, 903]
        weights = [0.0] * len(prompt) + [1.0] * (len(answer) + 4)
        self.assertEqual([c["what"] for c in M.judge_render(prompt, other, example, weights, decode) if not c["ok"]], [])
        self.assertEqual(M.answer_edges(example[len(prompt):], decode), (2, 2))

    def test_five_trained_tokens_before_the_answer_fail(self):
        prompt, other, _, _ = self.good()
        answer = [ord(c) for c in M.RENDER_CHECK_ANSWER]
        example = prompt + [ord("x")] * 5 + answer + [5]
        weights = [0.0] * len(prompt) + [0.1] * (len(answer) + 6)
        self.assertEqual(self.failed(prompt, other, example, weights), [TAIL_CHECK])

    def test_the_answer_twice_fails(self):
        prompt, other, _, _ = self.good()
        answer = [ord(c) for c in M.RENDER_CHECK_ANSWER]
        example = prompt + answer + answer + [5]
        weights = [0.0] * len(prompt) + [0.1] * (2 * len(answer) + 1)
        self.assertEqual(self.failed(prompt, other, example, weights), [TAIL_CHECK])

    def test_thirty_extra_trained_format_tokens_fail(self):
        prompt, other, example, weights = self.good()
        example = example + [ord("x")] * 30
        weights = weights + [0.1] * 30
        self.assertIn(TAIL_CHECK, self.failed(prompt, other, example, weights))

    def test_the_wrong_renderer_or_tokenizer_family_fails(self):
        ok = M.judge_family("thinkingmachines/Inkling-2-Mini", "tml_v0", "H200kBaseChatTokenizer")
        self.assertTrue(all(c["ok"] for c in ok))
        wrong_tok = M.judge_family("thinkingmachines/Inkling-2-Mini", "tml_v0", "O200kBaseChatTokenizer")
        self.assertEqual([c["ok"] for c in wrong_tok], [True, False])
        wrong_name = M.judge_family("thinkingmachines/Inkling-2-Mini", "qwen3_5", "H200kBaseChatTokenizer")
        self.assertFalse(wrong_name[0]["ok"])
        self.assertFalse(M.judge_family("thinkingmachines/Inkling-2-Mini", None, None)[0]["ok"])

    def test_a_tokenizer_the_cookbook_hides_is_reported_as_not_checked(self):
        hidden = M.judge_family("thinkingmachines/Inkling-2-Mini", "tml_v0", None)
        self.assertEqual(hidden[1].get("checked"), False)

    def test_an_example_with_no_weight_at_all_fails(self):
        prompt, other, example, weights = self.good()
        self.assertTrue(self.failed(prompt, other, example, [0.0] * len(example)))


class ProbeReportTests(unittest.TestCase):
    """probe_report: how a raw answer is said to have ended. Token lists stand in for the real tokenizer."""

    decode = staticmethod(lambda ids: " ".join(str(i) for i in ids))

    def test_an_answer_that_ends_on_the_stop_token_is_stop_and_one_that_fills_the_cap_is_cap(self):
        report = M.probe_report([
            {"text": "apple", "tokens": [7, 8, 99]},
            {"text": "", "tokens": [1, 2, 3, 4]},
            {"text": "pear", "tokens": [5, 6]},
        ], [99], self.decode, 4)
        self.assertEqual([a["ended"] for a in report["answers"]], ["stop", "cap", "other"])
        self.assertEqual((report["capped"], report["empty"], report["max_tokens"]), (1, 1, 4))
        self.assertEqual(report["answers"][0], {"raw": "7 8 99", "answer": "apple", "tokens": 3, "ended": "stop"})

    def test_an_answer_that_stops_exactly_at_the_cap_is_stop_not_cap(self):
        report = M.probe_report([{"text": "fig", "tokens": [1, 2, 3, 99]}], [99], self.decode, 4)
        self.assertEqual(report["answers"][0]["ended"], "stop")
        self.assertEqual(report["capped"], 0)

    def test_text_stop_sequences_are_left_out_and_no_answers_is_an_empty_report(self):
        report = M.probe_report([{"text": "kiwi", "tokens": [1, 2]}], ["<|im_end|>"], self.decode, 40)
        self.assertEqual(report["answers"][0]["ended"], "other")
        self.assertEqual(M.probe_report([], [99], self.decode, 40), {"max_tokens": 40, "answers": [], "capped": 0, "empty": 0})


class ProbeReachTests(unittest.TestCase):
    """raw_probe holds the Tinker key, so nothing but the owner's own Modal login may start it."""

    def test_nothing_in_the_runner_starts_the_probe_and_the_lab_server_never_names_it(self):
        calls = [n for n in ast.walk(TREE) if isinstance(n, ast.Name) and n.id == "raw_probe"]
        self.assertEqual(calls, [])  # defined once, never called or spawned from the file itself
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for folder in ("api", "src"):
            for base, _, names in os.walk(os.path.join(root, folder)):
                for name in names:
                    if name.endswith((".ts", ".js", ".mjs")):
                        with open(os.path.join(base, name), encoding="utf-8") as handle:
                            self.assertNotIn("raw_probe", handle.read(), name)


class FixedEffortTests(unittest.TestCase):
    """FixedEffortRenderer is a class, which load() leaves out, so it is taken from the tree by itself."""

    @classmethod
    def setUpClass(cls):
        node = next(n for n in ast.parse(SOURCE).body if isinstance(n, ast.ClassDef) and n.name == "FixedEffortRenderer")
        namespace = {}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "modal/tinker_jobs.py", "exec"), namespace)
        cls.Fixed = namespace["FixedEffortRenderer"]

    class Inner:
        tokenizer = "the tokenizer"

        def __init__(self):
            self.calls = []

        def build_generation_prompt(self, messages, role="assistant", prefill=None, effort=0.9):
            self.calls.append(("prompt", effort))
            return "prompt"

        def build_supervised_example(self, messages, train_on_what=None, effort=0.9):
            self.calls.append(("example", effort, train_on_what))
            return "example"

        def get_stop_sequences(self):
            return [99]

    def test_the_effort_is_supplied_to_the_prompt_and_to_the_training_example(self):
        inner = self.Inner()
        renderer = self.Fixed(inner, 0.0)
        renderer.build_generation_prompt([{"role": "user", "content": "x"}])
        renderer.build_supervised_example([], train_on_what="last")
        self.assertEqual(inner.calls, [("prompt", 0.0), ("example", 0.0, "last")])

    def test_an_effort_named_by_the_caller_wins_and_the_rest_passes_through(self):
        inner = self.Inner()
        renderer = self.Fixed(inner, 0.0)
        renderer.build_generation_prompt([], effort=0.9)
        self.assertEqual(inner.calls, [("prompt", 0.9)])
        self.assertEqual((renderer.get_stop_sequences(), renderer.tokenizer, renderer.effort), ([99], "the tokenizer", 0.0))
        with self.assertRaises(AttributeError):
            renderer.not_a_thing


class RunTests(unittest.TestCase):
    def test_a_run_measures_before_and_after_on_the_held_out_examples_and_trains_on_the_rest(self):
        j = job()
        result, deps, logs = run(j)
        train, held = M.split_indexes(20, SALT)
        question = lambda i: j["examples"][i]["messages"][0]["content"]
        self.assertEqual(result["status"], "ok")
        self.assertEqual((result["n_train"], result["n_holdout"], result["steps_planned"], result["steps_done"]), (18, 2, 6, 6))
        self.assertIsNone(result["stopped_early"])
        # Two measurements, each over exactly the held-out examples.
        self.assertEqual(deps.forwards, [[question(i) for i in held]] * 2)
        # Training saw every training example once an epoch, and never a held-out one.
        trained = [text for batch, _ in deps.trained for text in batch]
        self.assertEqual(sorted(trained), sorted([question(i) for i in train] * 2))
        self.assertFalse(set(trained) & set(question(i) for i in held))
        self.assertTrue(all(lr == 2e-4 for _, lr in deps.trained))
        self.assertAlmostEqual(result["holdout_loss_before"], 3.0)
        self.assertAlmostEqual(result["holdout_loss_after"], 3.0 * 0.8 ** 6)
        self.assertAlmostEqual(result["train_loss_first"], 3.0)
        self.assertLess(result["train_loss_last"], result["train_loss_first"])
        # The adapter is saved with the time to live the lab sent, and sampled on held-out prompts only.
        self.assertEqual(deps.saved, [14 * 86400])
        self.assertTrue(result["sampler_path"].startswith("tinker://"))
        self.assertEqual([s[1] for s in deps.sampled], [question(i) for i in held])
        self.assertEqual(result["samples"], [{"prompt": question(i), "completion": "a sampled answer"} for i in held])
        # Every token is counted: 20 tokens an example, 10 a prompt, 7 a completion.
        self.assertEqual(result["tokens"], {"train": 18 * 20 * 2, "eval": 2 * 20 * 2, "sample_prompt": 2 * 10, "sample_completion": 2 * 7})
        self.assertLessEqual(M.cost_usd(result["tokens"], PRICES), j["budget_usd"])
        self.assertNotIn(KEY, json.dumps(result))
        self.assertNotIn(KEY, json.dumps(logs))

    def test_a_job_that_fails_the_check_never_reaches_the_training_service(self):
        result, deps, _ = run(job(base_model="thinkingmachines/Inkling"))
        self.assertEqual((result["status"], result["stage"]), ("refused", "input"))
        self.assertIsNone(deps)
        self.assertEqual(result["tokens"], {"train": 0, "eval": 0, "sample_prompt": 0, "sample_completion": 0})

    def test_a_plan_that_costs_more_than_the_budget_is_refused_before_anything_is_trained(self):
        # 20 examples of 20 tokens: 720 training tokens and 80 for the two measurements at $0.737 a million,
        # plus the samples, is about $0.0009.
        result, deps, _ = run(job(budget_usd=0.0005))
        self.assertEqual((result["status"], result["stage"]), ("refused", "budget"))
        self.assertIn("more than the $0.0005 set aside", result["reason"])
        self.assertEqual((deps.forwards, deps.trained, deps.saved, deps.sampled), ([], [], [], []))
        self.assertEqual(sum(result["tokens"].values()), 0)
        self.assertEqual(run(job(budget_usd=0.001))[0]["status"], "ok")

    def test_real_tokens_decide_not_the_size_of_the_text(self):
        # The same text at 300 tokens a message no longer fits the budget; at 3000 an example is too long.
        result, deps, _ = run(job(budget_usd=0.001), tokens_per_message=300)
        self.assertEqual((result["status"], result["stage"]), ("refused", "budget"))
        result, deps, _ = run(job(budget_usd=5.0), tokens_per_message=3000)
        self.assertEqual((result["status"], result["stage"]), ("refused", "tokens"))
        self.assertIn("6000 tokens and an example may be 4096", result["reason"])
        self.assertEqual(deps.trained, [])

    def test_training_stops_before_the_measured_use_would_pass_the_budget(self):
        # The plan check is what normally stops an expensive run. If it ever let one through, the loop's
        # own count still holds the budget: here the plan is made to look free.
        real = M.planned_tokens
        try:
            M.run_core.__globals__["planned_tokens"] = lambda *a, **k: {"train": 0, "eval": 0, "sample_prompt": 0, "sample_completion": 0}
            result, deps, _ = run(job(budget_usd=0.0005))
        finally:
            M.run_core.__globals__["planned_tokens"] = real
        self.assertEqual(result["status"], "ok")
        self.assertIn("the budget", result["stopped_early"])
        self.assertLess(result["steps_done"], result["steps_planned"])
        self.assertGreater(result["steps_done"], 0)
        # Even stopped early it measured again, saved and sampled, and stayed inside the budget.
        self.assertEqual(len(deps.forwards), 2)
        self.assertEqual(len(deps.saved), 1)
        self.assertLessEqual(M.cost_usd(result["tokens"], PRICES), 0.0005)

    def test_training_stops_at_the_time_limit_and_still_measures_and_saves(self):
        made = []

        def make(checked):
            made.append(FakeDeps(checked))
            return made[-1]

        clock = Clock(step=350.0)  # every look at the clock is 350 s later
        result = M.run_core(job(), make, clock=clock, log=lambda line: None)
        self.assertEqual(result["status"], "ok")
        self.assertIn("time limit of 1800 s", result["stopped_early"])
        self.assertLess(result["steps_done"], 6)
        self.assertEqual(len(made[0].saved), 1)
        self.assertIsNotNone(result["holdout_loss_after"])

    def test_a_failure_part_way_is_reported_with_the_tokens_used_and_without_the_key(self):
        result, deps, logs = run(job(), fail_at_step=3)
        self.assertEqual((result["status"], result["stage"]), ("error", "train"))
        self.assertIn("[redacted]", result["error"])
        self.assertNotIn(KEY, json.dumps(result))
        self.assertEqual(result["steps_done"], 2)
        self.assertAlmostEqual(result["holdout_loss_before"], 3.0)
        self.assertNotIn("sampler_path", result)
        # The step that failed is counted too: its tokens may have been used.
        self.assertEqual(result["tokens"]["eval"], 40)
        self.assertGreater(result["tokens"]["train"], 0)
        self.assertEqual(deps.saved, [])

    def test_a_failed_sample_does_not_undo_a_run_that_trained_and_saved(self):
        result, deps, logs = run(job(), fail_sample=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["samples"], [])
        self.assertTrue(result["sampler_path"].startswith("tinker://"))
        self.assertNotIn(KEY, json.dumps(logs))

    def test_error_text_is_scrubbed_and_cut(self):
        self.assertEqual(M.scrub("bad key %s here" % KEY, [KEY]), "bad key [redacted] here")
        self.assertEqual(len(M.scrub("x" * 5000, [KEY])), 300)
        self.assertEqual(M.scrub("short", ["", "abc"]), "short")


class EndpointTests(unittest.TestCase):
    def test_bearer_token_is_required_and_a_job_is_checked_before_it_is_started(self):
        calls = []

        def spawn(checked):
            calls.append(checked)
            return SimpleNamespace(object_id="test-call")

        m = load({
            "train": SimpleNamespace(spawn=spawn),
            "OutputExpiredError": type("Expired", (Exception,), {}),
            "modal": SimpleNamespace(FunctionCall=SimpleNamespace(
                from_id=lambda call_id: SimpleNamespace(get=lambda timeout: (_ for _ in ()).throw(TimeoutError())))),
        })
        app = FastAPI()
        app.add_api_route("/start", m.start, methods=["POST"])
        app.add_api_route("/status", m.status, methods=["GET"])
        auth = {"Authorization": "Bearer " + TOKEN}
        with TestClient(app) as client, patch.dict(os.environ, {"JOBS_TOKEN": TOKEN}):
            self.assertEqual(client.post("/start", json={"train": job(), "token": TOKEN}).status_code, 401)
            self.assertEqual(client.post("/start", headers={"Authorization": "Bearer wrong"}, json={"train": job()}).status_code, 401)
            self.assertEqual(client.get("/status", params={"call_id": "x", "token": TOKEN}).status_code, 401)
            self.assertEqual(client.post("/start", headers=auth, json={"script": "print(1)"}).status_code, 400)
            self.assertEqual(client.post("/start", headers=auth, json={"train": job(budget_usd=99)}).status_code, 400)
            self.assertEqual(calls, [])
            ok = client.post("/start", headers=auth, json={"train": job()})
            self.assertEqual(ok.json(), {"call_id": "test-call"})
            self.assertEqual(calls, [job()])
            self.assertEqual(client.get("/status", headers=auth, params={"call_id": "test-call"}).json(), {"status": "running", "call_id": "test-call"})
            # With no store of run names at all (this stand-in for Modal has none), a named start still starts.
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": "e41-0a1b2c3d", "train": job()}).json(), {"call_id": "test-call"})
            self.assertEqual(len(calls), 2)
            self.assertEqual(client.get("/status", headers=auth, params={"run_id": "e41-0a1b2c3d"}).json()["status"], "unknown")
        with TestClient(app) as client, patch.dict(os.environ, {"JOBS_TOKEN": "short"}):
            self.assertEqual(client.post("/start", headers={"Authorization": "Bearer short"}, json={"train": job()}).status_code, 401)

    def test_a_run_is_remembered_by_its_name_so_a_lost_answer_can_be_found_and_a_repeat_starts_nothing(self):
        spawned = []
        names = {}

        class Names:
            def get(self, key, default=None):
                return names.get(key, default)

            def put(self, key, value):
                names[key] = value

        def spawn(checked):
            spawned.append(checked)
            return SimpleNamespace(object_id="fc-%d" % len(spawned))

        asked = []

        def from_id(call_id):
            asked.append(call_id)
            return SimpleNamespace(get=lambda timeout: {"status": "ok"} if call_id == "fc-1" else (_ for _ in ()).throw(TimeoutError()))

        m = load({
            "train": SimpleNamespace(spawn=spawn),
            "OutputExpiredError": type("Expired", (Exception,), {}),
            "modal": SimpleNamespace(
                FunctionCall=SimpleNamespace(from_id=from_id),
                Dict=SimpleNamespace(from_name=lambda name, create_if_missing=False: Names() if (name, create_if_missing) == ("oblab-tinker-runs", True) else None)),
        })
        app = FastAPI()
        app.add_api_route("/start", m.start, methods=["POST"])
        app.add_api_route("/status", m.status, methods=["GET"])
        auth = {"Authorization": "Bearer " + TOKEN}
        with TestClient(app) as client, patch.dict(os.environ, {"JOBS_TOKEN": TOKEN}):
            # A name that is not a run name is refused before anything is started.
            for bad in ["", "e41", "../x", 7, ["e41-0a1b2c3d"], "e41-0A1B2C3D", "e41-0a1b2c3d\n"]:
                self.assertEqual(client.post("/start", headers=auth, json={"run_id": bad, "train": job()}).status_code, 400, bad)
            self.assertEqual(spawned, [])
            # Before the run exists, the runner does not know the name, and a lookup needs the token.
            self.assertEqual(client.get("/status", headers=auth, params={"run_id": "e41-0a1b2c3d"}).json(), {"status": "unknown", "error": "no call is known for that run"})
            self.assertEqual(client.get("/status", params={"run_id": "e41-0a1b2c3d"}).status_code, 401)
            # Started once, remembered under its name.
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": "e41-0a1b2c3d", "train": job()}).json(), {"call_id": "fc-1"})
            self.assertEqual(names, {"e41-0a1b2c3d": "fc-1"})
            # The lab never got that answer: it asks by name and is given the call, with its state.
            self.assertEqual(client.get("/status", headers=auth, params={"run_id": "e41-0a1b2c3d"}).json(), {"status": "done", "call_id": "fc-1", "result": {"status": "ok"}})
            # Sent again for the same name: the same call, and nothing new is started.
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": "e41-0a1b2c3d", "train": job()}).json(), {"call_id": "fc-1"})
            self.assertEqual(len(spawned), 1)
            # Another name is another run.
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": "e42-0a1b2c3d", "train": job()}).json(), {"call_id": "fc-2"})
            self.assertEqual(client.get("/status", headers=auth, params={"run_id": "e42-0a1b2c3d"}).json(), {"status": "running", "call_id": "fc-2"})
            # A call id that is not one is not passed to Modal.
            asked.clear()
            self.assertEqual(client.get("/status", headers=auth, params={"call_id": "not a call id!"}).json()["status"], "failed")
            self.assertEqual(asked, [])
            # A name that is not a run name knows nothing, whatever the store holds.
            names["../x"] = "fc-1"
            self.assertEqual(client.get("/status", headers=auth, params={"run_id": "../x"}).json()["status"], "unknown")

    def test_the_store_of_run_names_is_never_a_gate(self):
        log = []

        class Broken:
            def get(self, key, default=None):
                raise RuntimeError("store down")

            def put(self, key, value):
                raise RuntimeError("store down " + KEY)

        # A store that cannot be read or written does not stop a run, and the log line says only what kind of error it was.
        self.assertEqual(M.start_once("e41-0a1b2c3d", Broken(), lambda: "fc-9", log=log.append), "fc-9")
        self.assertEqual(log, ["could not remember the call for run e41-0a1b2c3d: RuntimeError"])
        self.assertIsNone(M.known_call(Broken(), "e41-0a1b2c3d"))
        # No store, or no name: the run starts and nothing is remembered.
        self.assertEqual(M.start_once("e41-0a1b2c3d", None, lambda: "fc-9"), "fc-9")
        store = {}
        names = SimpleNamespace(get=store.get, put=store.__setitem__)
        self.assertEqual(M.start_once(None, names, lambda: "fc-9"), "fc-9")
        self.assertEqual(store, {})
        # A stored value that is not a call id is not handed back as one.
        store["e41-0a1b2c3d"] = {"call": "fc-1"}
        self.assertIsNone(M.known_call(names, "e41-0a1b2c3d"))
        store["e41-0a1b2c3d"] = "fc 1; rm"
        self.assertIsNone(M.known_call(names, "e41-0a1b2c3d"))
        self.assertTrue(M.valid_run_id("e41-0a1b2c3d"))
        self.assertFalse(any(M.valid_run_id(v) for v in ["e-0a1b2c3d", "e41-0a1b2c3", "E41-0a1b2c3d", None, 41]))


class DeployShapeTests(unittest.TestCase):
    def test_the_top_of_the_file_imports_only_what_every_image_and_the_deploying_mac_have(self):
        top = set()
        for node in TREE.body:
            if isinstance(node, ast.Import):
                top.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                top.add((node.module or "").split(".")[0])
        self.assertEqual(top, {"hashlib", "hmac", "json", "math", "os", "re", "shutil", "tempfile", "time", "typing", "unicodedata", "urllib", "modal", "fastapi"})
        # The Tinker SDK needs Python 3.11, so it is imported only inside the three classes that talk to Tinker.
        inside = [n for n in ast.walk(TREE) if isinstance(n, (ast.Import, ast.ImportFrom)) and n not in TREE.body]
        names = set()
        for node in inside:
            names.update([(node.module or "").split(".")[0]] if isinstance(node, ast.ImportFrom) else [a.name.split(".")[0] for a in node.names])
        self.assertEqual(names, {"tinker", "tinker_cookbook", "torch"})  # torch only in the RL class, on the training image
        classes = [n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name in ("TinkerDeps", "TinkerRlDeps", "KeepDeps")]
        self.assertEqual(len(classes), 3)
        within = [n for c in classes for n in ast.walk(c)]
        self.assertTrue(all(any(node is n for n in within) for node in inside))

    def test_every_image_installs_fastapi_and_the_sdk_is_pinned(self):
        train_image = SOURCE[SOURCE.index("train_image = ("):SOURCE.index("web_image = ")]
        web_image = SOURCE[SOURCE.index("web_image = "):SOURCE.index("# Pure parts")]
        self.assertIn('"fastapi==', train_image)
        self.assertIn('"fastapi[standard]==', web_image)
        for pin in ('"tinker==0.39.1"', '"tinker-cookbook==0.7.1"', '"tml-renderers==0.4.2"', '"torch==2.15.0"'):
            self.assertIn(pin, train_image)
        self.assertNotIn("tinker", web_image)

    def test_only_the_four_functions_that_talk_to_tinker_are_given_the_tinker_key(self):
        functions = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.decorator_list]
        secrets = {}
        for node in functions:
            text = " ".join(ast.unparse(d) for d in node.decorator_list)
            secrets[node.name] = sorted(set(re.findall(r"from_name\('([^']+)'\)", text)))
        # `train` and `train_rl` train; `keeper` sets a checkpoint's time to live and copies its weights; `raw_probe` samples a
        # base model for the owner's smoke script. The two web endpoints never have the key.
        self.assertEqual(secrets, {
            "train": ["oblab-tinker-auth"], "train_rl": ["oblab-tinker-auth"], "keeper": ["oblab-tinker-auth"],
            "raw_probe": ["oblab-tinker-auth"],  # started only with the owner's Modal login: see the next test
            "render_check": [],  # renders a made-up conversation: no Tinker call, no key
            "start": ["oblab-tinker-jobs-auth"], "status": ["oblab-tinker-jobs-auth"],
        })
        # The key is named only where error text is scrubbed of it; it is never put in a result or printed.
        reads = [line.strip() for line in SOURCE.splitlines() if "TINKER_API_KEY" in line and "os.environ" in line]
        self.assertEqual(reads, ['return [os.environ.get("TINKER_API_KEY", "")]'] * 3)
        # No "X | None" in a signature: the deploying Mac's Python 3.9 cannot evaluate it.
        annotations = [a for n in ast.walk(TREE) if isinstance(n, (ast.FunctionDef, ast.arg)) for a in [getattr(n, "returns", None), getattr(n, "annotation", None)] if a is not None]
        self.assertFalse(any(isinstance(n, ast.BinOp) for a in annotations for n in ast.walk(a)))

    def test_the_file_compiles_for_the_deploying_python(self):
        compile(SOURCE, "modal/tinker_jobs.py", "exec", dont_inherit=True)
        self.assertEqual(M.APP_NAME, "oblab-tinker")


if __name__ == "__main__":
    unittest.main()
