"""The by-hand smoke test (modal/tinker_smoke.py), tested with a fake Modal. Nothing is called. Run: python -m unittest discover -s tests"""
import contextlib
import importlib.util
import io
import re
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MINI = "thinkingmachines/Inkling-2-Mini"


class FakeFunction:
    calls = []
    answers = {}

    def __init__(self, name):
        self.name = name

    @classmethod
    def from_name(cls, app, name):
        return cls(name)

    def remote(self, arg):
        FakeFunction.calls.append((self.name, arg))
        answer = FakeFunction.answers[self.name]
        return answer(arg) if callable(answer) else answer


def load():
    fake = types.ModuleType("modal")
    fake.Function = FakeFunction
    with patch.dict(sys.modules, {"modal": fake}):
        spec = importlib.util.spec_from_file_location("tinker_smoke_under_test", ROOT / "modal" / "tinker_smoke.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


S = load()
GOOD_CHECKS = [{"what": "w%d" % i, "ok": True} for i in range(6)]
OK_RENDER = {"status": "ok", "renderer": "tml_v0", "effort": 0.0, "prompt_tokens": 9, "prompt_text": "PROMPT", "checks": GOOD_CHECKS}
OK_RUN = {"status": "ok", "holdout_loss_before": 3.0, "holdout_loss_after": 1.0, "n_holdout": 2, "sampler_path": "tinker://x/sampler_weights/final",
          "tokens": {"train": 1000, "eval": 100, "sample_prompt": 20, "sample_completion": 30},
          "samples": [{"prompt": "p", "completion": "The lab code for red is OL-100."}] * 2}


def quiet(fn, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = fn(*args)
    return code, out.getvalue()


class Setup(unittest.TestCase):
    def setUp(self):
        FakeFunction.calls = []
        FakeFunction.answers = {"render_check": OK_RENDER, "train": OK_RUN}


class ModelChoice(Setup):
    def test_the_default_is_qwen_and_the_environment_and_the_option_choose_in_that_order(self):
        with patch.dict("os.environ", {}, clear=False):
            for key in ("TINKER_SMOKE_MODEL",):
                __import__("os").environ.pop(key, None)
            self.assertEqual(S.choose_model([]), ("Qwen/Qwen3.5-4B", []))
            self.assertEqual(S.choose_model(["rl"]), ("Qwen/Qwen3.5-4B", ["rl"]))
        with patch.dict("os.environ", {"TINKER_SMOKE_MODEL": MINI}):
            self.assertEqual(S.choose_model(["keep"]), (MINI, ["keep"]))
            self.assertEqual(S.choose_model(["--model", "Qwen/Qwen3.5-9B", "rl"]), ("Qwen/Qwen3.5-9B", ["rl"]))

    def test_an_unknown_model_or_a_missing_value_stops_before_anything_is_called(self):
        for args in (["--model", MINI + ":peft:262144"], ["--model", "Qwen/Qwen3.6-27B"], ["--model"]):
            with self.assertRaises(SystemExit):
                S.choose_model(args)
        self.assertEqual(FakeFunction.calls, [])

    def test_the_prices_here_are_the_ones_of_the_runner_and_of_the_lab_server(self):
        runner = (ROOT / "modal" / "tinker_jobs.py").read_text()
        ids = set(re.findall(r'^    "([^"]+)": "[a-z0-9_]+",$', runner[runner.index("RENDERERS = {"):runner.index("RENDER_EFFORT = {")], re.M))
        self.assertEqual(set(S.PRICES), ids)
        server = (ROOT / "api" / "_lib" / "tinker.ts").read_text()
        for model, price in S.PRICES.items():
            row = re.search(r"'%s': \{ train: ([0-9.]+), sample: ([0-9.]+), prefill: ([0-9.]+) \}" % re.escape(model), server)
            self.assertIsNotNone(row, model)
            self.assertEqual(tuple(float(x) for x in row.groups()), (price["train"], price["sample"], price["prefill"]), model)


class RenderCheck(Setup):
    def test_a_good_format_passes_and_prints_the_prompt(self):
        code, out = quiet(S.render, MINI)
        self.assertEqual(code, 0)
        self.assertIn("PROMPT", out)
        self.assertEqual(FakeFunction.calls, [("render_check", MINI)])

    def test_a_wrong_renderer_fails_the_smoke(self):
        bad = dict(OK_RENDER, status="failed", checks=GOOD_CHECKS[:2] + [{"what": "the generation prompt is the start of the training example, token for token", "ok": False}])
        FakeFunction.answers["render_check"] = bad
        code, out = quiet(S.render, MINI)
        self.assertEqual(code, 1)
        self.assertIn("FAIL the generation prompt is the start", out)

    def test_a_renderer_that_could_not_even_load_fails_it_too(self):
        FakeFunction.answers["render_check"] = {"status": "failed", "renderer": "tml_v0", "reason": "TypeError: tml_v0 needs an Inkling tokenizer"}
        self.assertEqual(quiet(S.render, MINI)[0], 1)


class TrainSmoke(Setup):
    def test_the_default_model_is_run_as_it_always_was_and_not_judged_further(self):
        code, _ = quiet(S.train, S.DEFAULT_MODEL)
        self.assertEqual(code, 0)
        self.assertEqual([c[0] for c in FakeFunction.calls], ["train"])
        self.assertEqual(FakeFunction.calls[0][1]["base_model"], "Qwen/Qwen3.5-4B")
        self.assertEqual(FakeFunction.calls[0][1]["prices"], {"train": 0.737, "sample": 1.005, "prefill": 0.33})

    def test_inkling_is_checked_first_then_trained_with_its_own_prices_and_judged(self):
        code, out = quiet(S.train, MINI)
        self.assertEqual(code, 0, out)
        self.assertEqual([c[0] for c in FakeFunction.calls], ["render_check", "train"])
        sent = FakeFunction.calls[1][1]
        self.assertEqual((sent["base_model"], sent["prices"], sent["budget_usd"]), (MINI, {"train": 0.75, "sample": 0.50, "prefill": 0.15}, 0.05))

    def test_a_failed_format_check_stops_before_a_paid_run(self):
        FakeFunction.answers["render_check"] = dict(OK_RENDER, status="failed")
        code, _ = quiet(S.train, MINI)
        self.assertEqual(code, 1)
        self.assertEqual([c[0] for c in FakeFunction.calls], ["render_check"])

    def test_a_run_whose_loss_did_not_fall_or_whose_answers_are_not_direct_fails(self):
        self.assertEqual(S.verify_train(OK_RUN, MINI), [])
        self.assertEqual(len(S.verify_train(dict(OK_RUN, holdout_loss_after=3.5), MINI)), 1)
        thinking = dict(OK_RUN, samples=[{"prompt": "p", "completion": "Let me think. The user asks for a code, so"}] * 2)
        self.assertEqual(len(S.verify_train(thinking, MINI)), 2)
        self.assertEqual(len(S.verify_train(dict(OK_RUN, samples=[]), MINI)), 1)
        self.assertEqual(len(S.verify_train({"status": "refused", "reason": "x"}, MINI)), 1)
        FakeFunction.answers["train"] = dict(OK_RUN, samples=[{"prompt": "p", "completion": ""}] * 2)
        self.assertEqual(quiet(S.train, MINI)[0], 1)


class RlSmoke(Setup):
    def test_the_rl_check_takes_the_model_and_its_prices(self):
        FakeFunction.answers["train_rl"] = {"status": "ok", "tokens": {}, "step_means": [], "step_frac_max": [], "score_before": 0.1, "score_after": 0.2,
                                            "max_reward": 1.0, "n_holdout": 2, "steps_trained": 0, "steps_done": 4, "sampler_path": "tinker://x/sampler_weights/final"}
        quiet(S.rl, MINI)
        self.assertEqual([c[0] for c in FakeFunction.calls[:2]], ["render_check", "train_rl"])
        sent = FakeFunction.calls[1][1]
        self.assertEqual((sent["base_model"], sent["prices"]), (MINI, {"train": 0.75, "sample": 0.50, "prefill": 0.15}))
        self.assertEqual(S.rl_job["base_model"], "Qwen/Qwen3.5-4B")


if __name__ == "__main__":
    unittest.main()
