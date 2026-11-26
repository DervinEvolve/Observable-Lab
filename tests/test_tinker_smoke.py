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

    def test_the_counts_of_cut_off_answers_are_printed_when_the_runner_sends_them_and_not_made_up_when_it_does_not(self):
        run = {"status": "ok", "tokens": {}, "step_means": [0.5, 0.75], "step_frac_max": [0.5, 0.75], "score_before": 0.1, "score_after": 0.2,
               "max_reward": 1.0, "n_holdout": 3, "steps_trained": 1, "steps_done": 2, "sampler_path": "tinker://x/sampler_weights/final"}
        FakeFunction.answers["train_rl"] = dict(run, step_capped=[6, 0], step_mean_tokens=[38.5, 12.0], answers_before=6, capped_before=4, answers_after=6, capped_after=0)
        _, text = quiet(S.rl, "Qwen/Qwen3.5-4B")
        self.assertIn("step 1: mean reward 0.500 (share at the best score 0.50); 6 of 8 answers reached the token limit; 38.5 tokens an answer on average", text)
        self.assertIn("held-out answers before training: 6 graded, 4 of them reached the token limit without finishing", text)
        self.assertIn("held-out answers after training: 6 graded, 0 of them reached the token limit without finishing", text)
        FakeFunction.answers["train_rl"] = run  # a runner deployed before the counting existed
        _, text = quiet(S.rl, "Qwen/Qwen3.5-4B")
        self.assertIn("step 1: mean reward 0.500 (share at the best score 0.50)\n", text)
        self.assertNotIn("reached the token limit", text)


def probe_answer(ended, tokens, answer, before, raw="RAW"):
    return {"raw": raw, "answer": answer, "tokens": tokens, "ended": ended, "before_answer": before}


RAW_RESULT = {
    "status": "ok", "base_model": MINI, "renderer": "tml_v0", "prompt": "Name one fruit other than a fig. Answer with the name only.", "temperature": 1.0,
    "reports": [
        {"max_tokens": 40, "capped": 4, "empty": 3, "answers": [probe_answer("cap", 40, "", 40), probe_answer("cap", 40, "apple", 38), probe_answer("cap", 40, "", 40), probe_answer("cap", 40, "", 40)]},
        {"max_tokens": 400, "capped": 0, "empty": 0, "answers": [probe_answer("stop", 38, "apple", 35), probe_answer("stop", 53, "Apple", 50)]},
    ],
}
CHAT_CALL = {"status": "ok", "max_tokens": 40, "http_status": 200, "finish_reason": "length", "content": "", "content_is": "text of 0 characters", "content_cut": False,
             "message_fields": [{"name": "reasoning_content", "holds": "text of 120 characters"}, {"name": "role", "holds": "text of 9 characters"}],
             "choice_fields": [], "usage": {"completion_tokens": 40, "prompt_tokens": 31}}
CHAT_REQUEST = {"url": "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions", "reasoning_effort": "none", "temperature": 1.0}


class RawSmoke(Setup):
    def test_the_cases_of_26_november_print_with_no_answer_read_for_three_of_four(self):
        FakeFunction.answers["raw_probe"] = dict(RAW_RESULT, chat={"status": "ok", "request": CHAT_REQUEST, "calls": [CHAT_CALL, dict(CHAT_CALL, max_tokens=400, finish_reason="stop", content="apple", content_is="text of 5 characters")]})
        code, text = quiet(S.raw, MINI)
        self.assertEqual(code, 0)
        self.assertEqual(FakeFunction.calls, [("raw_probe", MINI)])
        self.assertIn("[cap, 40 tokens, no answer text began] answer read: \'\'", text)
        self.assertIn("[cap, 40 tokens, 38 before the answer] answer read: \'apple\'", text)
        self.assertIn("[stop, 38 tokens, 35 before the answer] answer read: \'apple\'", text)
        self.assertIn("ran to the cap without finishing: 4 of 4; no answer read: 3 of 4", text)
        self.assertIn("ran to the cap without finishing: 0 of 2; no answer read: 0 of 2", text)
        # the chat endpoint part, plainly
        self.assertIn('POST %s with reasoning_effort "none", temperature 1.0' % CHAT_REQUEST["url"], text)
        self.assertIn("--- max_completion_tokens 40\nHTTP 200, finish_reason \"length\"\ncontent (text of 0 characters): \'\'", text)
        self.assertIn("other fields on the message: reasoning_content (text of 120 characters); role (text of 9 characters)", text)
        self.assertIn("other fields on the choice: none", text)
        self.assertIn("usage: completion_tokens 40, prompt_tokens 31", text)
        self.assertIn("content (text of 5 characters): \'apple\'", text)
        self.assertTrue(text.rstrip().endswith("raw: done"))

    def test_a_chat_part_that_failed_is_printed_and_the_sampling_part_still_is(self):
        failed = {"status": "failed", "request": CHAT_REQUEST, "calls": [{"status": "failed", "max_tokens": 40, "http_status": 400, "reason": "HTTP 400 reasoning_effort is not taken"}, CHAT_CALL]}
        FakeFunction.answers["raw_probe"] = dict(RAW_RESULT, chat=failed)
        code, text = quiet(S.raw, MINI)
        self.assertEqual(code, 0, "finding out what the endpoint does is what the part is for")
        self.assertIn("no answer read: 3 of 4", text)
        self.assertIn("--- max_completion_tokens 40\nFAILED: HTTP 400, HTTP 400 reasoning_effort is not taken", text)
        self.assertIn("finish_reason \"length\"", text)
        FakeFunction.answers["raw_probe"] = dict(RAW_RESULT, chat={"status": "failed", "request": CHAT_REQUEST, "reason": "no Tinker key in this container", "calls": []})
        self.assertIn("chat endpoint: FAILED no Tinker key in this container", quiet(S.raw, MINI)[1])

    def test_a_runner_deployed_before_this_part_existed_prints_as_it_did_and_says_what_is_missing(self):
        old = {"status": "ok", "base_model": "Qwen/Qwen3.5-4B", "renderer": "qwen3_5_disable_thinking", "prompt": "p", "temperature": 1.0,
               "reports": [{"max_tokens": 40, "capped": 0, "empty": 0, "answers": [{"raw": "apple<|im_end|>", "answer": "apple", "tokens": 2, "ended": "stop"}]}]}
        FakeFunction.answers["raw_probe"] = old
        code, text = quiet(S.raw, "Qwen/Qwen3.5-4B")
        self.assertEqual(code, 0)
        self.assertIn("[stop, 2 tokens] answer read: \'apple\'", text)
        self.assertIn("chat endpoint: this runner did not try it", text)
        FakeFunction.answers["raw_probe"] = {"status": "failed", "reason": "RuntimeError while opening the Tinker client"}
        self.assertEqual(quiet(S.raw, MINI)[0], 1)

    def test_a_model_that_does_not_think_shows_zero_tokens_before_its_answer(self):
        self.assertEqual(S.answer_line(probe_answer("stop", 2, "apple", 0)), "[stop, 2 tokens, 0 before the answer] answer read: \'apple\'")
        self.assertEqual(S.answer_line(probe_answer("stop", 1, "", 0)), "[stop, 1 tokens, 0 before the answer] answer read: \'\'")
        self.assertEqual(S.answer_line(probe_answer("cap", 40, "", None)), "[cap, 40 tokens] answer read: \'\'")


if __name__ == "__main__":
    unittest.main()
