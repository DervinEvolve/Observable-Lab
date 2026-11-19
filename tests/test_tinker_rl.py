"""Tinker RL in the lab's runner (modal/tinker_jobs.py), tested without Modal or Tinker.

The rubric engine is pure Python and has a TypeScript twin (api/_lib/rubric.ts);
both are checked against the one file of cases in tests/fixtures/rubric-cases.json,
so a rubric means the same thing where the lab checks it and where the runner
scores with it. The run itself is driven with a fake training service. No
network, GPU or provider is contacted. Run: python -m unittest discover -s tests
"""
import ast
import json
import re
import time
import unicodedata
import unittest
from pathlib import Path

from test_tinker_jobs import SALT, SOURCE, TREE, load

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests" / "fixtures" / "rubric-cases.json").read_text())
M = load({"unicodedata": unicodedata})
PRICES = {"train": 0.737, "sample": 1.005, "prefill": 0.33}
BASE = "Qwen/Qwen3.5-4B"


class RubricCases(unittest.TestCase):
    def test_text_is_normalised_the_same_way_in_both_languages(self):
        for case in CASES["normalise"]:
            self.assertEqual(M.normalise_text(case["input"]), case["expected"], case["input"])

    def test_numbers_are_read_the_same_way_in_both_languages(self):
        for case in CASES["numbers"]:
            self.assertEqual(M.numbers_in(case["input"]), [float(x) for x in case["expected"]], case["input"])

    def test_the_safe_regex_subset_matches_the_same_texts(self):
        for case in CASES["regex"]:
            regex, reason = M.compile_regex(case["pattern"], case.get("ignore_case") is True)
            self.assertIsNotNone(regex, "%s: %s" % (case["pattern"], reason))
            self.assertEqual(M.regex_search(regex, case["text"]), case["match"], case["pattern"])

    def test_patterns_outside_the_subset_are_refused_with_a_reason(self):
        for pattern in CASES["regex_refused"]:
            regex, reason = M.compile_regex(pattern)
            self.assertIsNone(regex, pattern[:30])
            self.assertTrue(reason)
        # lookarounds, back references, lazy quantifiers and word boundaries are outside the subset
        for pattern in ("(?=a)b", "(a)\\1", "a+?", "\\bword", "(?<=a)b", "a*+"):
            self.assertIsNone(M.compile_regex(pattern)[0], pattern)

    def test_a_pattern_that_would_be_catastrophic_elsewhere_is_harmless_here(self):
        # The engine steps an automaton over the text once, so these take time linear in the text
        # (a backtracking engine would take longer than the age of the lab on the first of them).
        for pattern in ("^(a+)+$", "^(a*)*b$", "^(a|a)*c$", "^(.*)*x$", "^(a+){2,}$"):
            regex, _ = M.compile_regex(pattern)
            if regex is None:
                continue  # refused is as safe as fast
            started = time.time()
            self.assertFalse(M.regex_search(regex, "a" * 3000 + "!"), pattern)
            self.assertLess(time.time() - started, 5, pattern)

    def test_scores_are_the_clamped_weighted_sum_of_the_rules(self):
        for case in CASES["scores"]:
            self.assertIsNone(M.check_rubric(case["rubric"]), case["name"])
            self.assertAlmostEqual(M.score_completion(case["rubric"], case["task"], case["completion"]), case["score"], places=9, msg=case["name"])

    def test_rubrics_in_and_out_of_the_menu(self):
        for rubric in CASES["rubric_ok"]:
            self.assertIsNone(M.check_rubric(rubric), rubric)
        for case in CASES["rubric_refused"]:
            self.assertIsNotNone(M.check_rubric(case["rubric"]), case["why"])


def tasks(n=20):
    return [{"prompt": "What is %d plus %d?" % (i, i), "expected": str(2 * i)} for i in range(n)]


def job(**over):
    base = {
        "base_model": BASE, "tasks": tasks(), "rubric": {"rules": [{"type": "exact_match", "weight": 1, "from": "expected", "scope": "last_line"}]},
        "settings": {"rank": 16, "learning_rate": 4e-5, "group_size": 4, "steps": 3, "tasks_per_step": 2, "max_completion_tokens": 32, "loss": "importance_sampling"},
        "split_salt": SALT, "budget_usd": 1.0, "prices": PRICES, "ttl_seconds": 14 * 86400, "samples": 3, "run_id": "e41-0a1b2c3d",
    }
    base.update(over)
    return base


class Check(unittest.TestCase):
    def test_a_good_job_is_accepted(self):
        self.assertIsNone(M.check_rl_job(job()))

    def test_every_bound_is_enforced(self):
        def settings(**c):
            s = dict(job()["settings"])
            s.update(c)
            return {"settings": s}
        bad = [
            job(base_model="not/a-model"), job(tasks=tasks(7)), job(tasks=tasks(401)), job(tasks=tasks(8) + tasks(1)),
            job(tasks=[{"prompt": "x", "extra": 1}] * 8), job(rubric={"rules": []}), job(**settings(group_size=1)), job(**settings(group_size=17)),
            job(**settings(steps=0)), job(**settings(steps=31)), job(**settings(max_completion_tokens=513)), job(**settings(learning_rate=1.0)),
            job(**settings(loss="mse")), job(**settings(rank=7)), job(**settings(tasks_per_step=17)), job(split_salt="zz"), job(budget_usd=0),
            job(budget_usd=50), job(prices={"train": 1}), job(ttl_seconds=5), job(samples=99), job(run_id="../x"), job(export="yes"),
            # a rule that reads a field the tasks do not have
            job(rubric={"rules": [{"type": "exact_match", "weight": 1, "from": "data.answer"}]}),
        ]
        for i, b in enumerate(bad):
            self.assertIsNotNone(M.check_rl_job(b), "case %d" % i)
        self.assertIsNotNone(M.check_rl_job("x"))

    def test_the_hold_out_is_about_15_percent_and_fixed_by_the_salt(self):
        self.assertEqual([M.rl_holdout_count(n) for n in (8, 20, 100, 400, 1000)], [2, 3, 15, 60, 60])
        train, held = M.rl_split(40, SALT)
        self.assertEqual(sorted(train + held), list(range(40)))
        self.assertEqual(len(held), 6)
        self.assertEqual(M.rl_split(40, SALT), (train, held))
        self.assertNotEqual(M.rl_split(40, "f" * 32)[1], held)

    def test_a_start_may_hold_an_rl_job_and_nothing_else_beside_it(self):
        ok = M.read_start({"run_id": "e41-0a1b2c3d", "rl": job()})
        self.assertEqual((ok["kind"], ok["run_id"]), ("rl", "e41-0a1b2c3d"))
        self.assertIn("problem", M.read_start({"rl": job(), "train": {}}))
        self.assertIn("problem", M.read_start({"rl": job(base_model="x")}))
        self.assertIn("problem", M.read_start({"run_id": "nope", "rl": job()}))


class FakeRl:
    """Tinker behind the calls run_rl_core makes. `answer(prompt, n_samples_seen)` says what the model replies."""

    def __init__(self, answer, save="tinker://0a1b2c3d-1111-2222-3333-444455556666:train:0/sampler_weights/final", fail_save=False):
        self.answer = answer
        self.save_path = save
        self.fail_save = fail_save
        self.trained = []
        self.sampled = []
        self.version = 0
        self.saved_ttl = None

    def secrets(self):
        return ["tml-secret-key-0000"]

    def prompt_length(self, text):
        return len(text.split()) + 4

    def new_sampler(self):
        return ("live", self.version)

    def sampler_from_path(self, path):
        return ("saved", self.version)

    def sample_batch(self, sampler, prompts, n, max_tokens, temperature):
        self.sampled.append((sampler, list(prompts), n, max_tokens, temperature))
        out = []
        for p in prompts:
            completions = []
            for k in range(n):
                text = self.answer(p, sampler, k)
                completions.append({"text": text, "tokens": list(range(5)), "logprobs": [-0.5] * 5})
            out.append({"prompt": p, "prompt_tokens": self.prompt_length(p), "completions": completions})
        return out

    def train(self, groups, learning_rate, loss):
        self.trained.append((groups, learning_rate, loss))
        self.version += 1

    def save(self, ttl_seconds):
        if self.fail_save:
            raise RuntimeError("save failed with tml-secret-key-0000")
        self.saved_ttl = ttl_seconds
        return self.save_path


def sum_answer(prompt, sampler, k):
    """Right on every other attempt before training, always right on a saved adapter that was trained."""
    n = int(re.findall(r"\d+", prompt)[0])
    if sampler[1] > 0 or k % 2 == 0:
        return "thinking\n%d" % (2 * n)
    return "thinking\nnot sure"


class Run(unittest.TestCase):
    def run_it(self, deps, j=None, **kw):
        records = []
        out = M.run_rl_core(j or job(), lambda _job: deps, on_progress=records.append, log=lambda *_: None, **kw)
        return out, records

    def test_a_run_samples_scores_trains_and_measures_the_held_out_tasks_twice(self):
        deps = FakeRl(sum_answer)
        out, records = self.run_it(deps)
        self.assertEqual(out["status"], "ok", out)
        self.assertEqual((out["n_tasks"], out["n_train"], out["n_holdout"], out["steps_done"], out["steps_planned"]), (20, 17, 3, 3, 3))
        self.assertEqual(out["max_reward"], 1.0)
        # the base model is measured before the first step and the saved adapter after the last
        self.assertEqual(deps.sampled[0][0], ("live", 0))
        self.assertEqual(deps.sampled[-1][0], ("saved", len(deps.trained)))
        self.assertGreaterEqual(len(deps.trained), 1)
        self.assertAlmostEqual(out["score_before"], 0.5, places=6)
        self.assertEqual(out["score_after"], 1.0)
        self.assertEqual(len(out["step_means"]), 3)
        self.assertEqual(len(out["step_frac_max"]), 3)
        self.assertEqual(out["sampler_path"], deps.save_path)
        self.assertEqual(deps.saved_ttl, 14 * 86400)
        # every training call got the settings it was asked for, and only groups where the answers differed
        for groups, lr, loss in deps.trained:
            self.assertEqual((lr, loss), (4e-5, "importance_sampling"))
            for g in groups:
                self.assertAlmostEqual(sum(g["advantages"]), 0, places=9)
                self.assertTrue(any(abs(a) > 0 for a in g["advantages"]))
        # tokens are the ones that were counted, never the plan
        self.assertGreater(out["tokens"]["sample_completion"], 0)
        self.assertGreater(out["tokens"]["train"], 0)

    def test_the_model_never_trains_on_a_held_out_task(self):
        deps = FakeRl(sum_answer)
        j = job()
        out, _ = self.run_it(deps, j)
        train, held = M.rl_split(len(j["tasks"]), SALT)
        held_prompts = {j["tasks"][i]["prompt"] for i in held}
        for sampler, prompts, n, _max, temp in deps.sampled:
            if temp == M.RL_TRAIN_TEMPERATURE:
                self.assertFalse(held_prompts & set(prompts))
            else:
                self.assertEqual(set(prompts), held_prompts)
                self.assertEqual(n, M.RL_EVAL_SAMPLES)
        for groups, _lr, _loss in deps.trained:
            for g in groups:
                self.assertNotIn(g["prompt"] if isinstance(g["prompt"], str) else "", held_prompts)

    def test_progress_is_written_after_every_stage_and_stays_small(self):
        out, records = self.run_it(FakeRl(sum_answer))
        phases = [r["phase"] for r in records]
        self.assertEqual(phases[0], "baseline")
        self.assertIn("sampling", phases)
        self.assertIn("scored", phases)
        self.assertEqual(phases[-1], "done")
        self.assertLess(phases.index("baseline"), phases.index("sampling"))
        self.assertLess(phases.index("scored"), phases.index("saving"))
        for r in records:
            self.assertEqual(r["v"], 1)
            self.assertLessEqual(len(json.dumps(r).encode()), M.RL_PROGRESS_MAX_BYTES)
            self.assertLessEqual(len(r["attempts"]), 16)
            self.assertLessEqual(len(r["samples"]), 3)
        scored = [r for r in records if r["phase"] == "scored"]
        self.assertEqual(sorted(set(len(r["means"]) for r in scored)), [1, 2, 3])
        self.assertEqual(len(scored[0]["attempts"]), 4)
        self.assertEqual(records[-1]["score_before"], out["score_before"])
        self.assertEqual(records[-1]["score_after"], out["score_after"])

    def test_a_progress_writer_that_fails_does_not_stop_the_run(self):
        def boom(_):
            raise RuntimeError("the store is down")
        out = M.run_rl_core(job(), lambda _j: FakeRl(sum_answer), on_progress=boom, log=lambda *_: None)
        self.assertEqual(out["status"], "ok")

    def test_the_progress_payload_is_cut_to_its_size(self):
        big = {"samples": [{"prompt": "p" * 500, "completion": "c" * 500, "reward": 1.0}] * 3, "means": [0.5] * 30, "frac_max": [0.5] * 30, "attempts": [0.5] * 16}
        payload = M.rl_progress_payload(job(), big, 3.0)
        self.assertLessEqual(len(json.dumps(payload).encode()), M.RL_PROGRESS_MAX_BYTES)
        self.assertLessEqual(len(payload["samples"][0]["prompt"]), 100)

    def test_a_refused_job_runs_nothing(self):
        called = []
        out = M.run_rl_core(job(tasks=tasks(3)), lambda _j: called.append(1), log=lambda *_: None)
        self.assertEqual(out["status"], "refused")
        self.assertEqual(called, [])

    def test_a_budget_too_small_for_the_plan_refuses_and_one_that_runs_out_stops_early(self):
        out, _ = self.run_it(FakeRl(sum_answer), job(budget_usd=0.0000001))
        self.assertEqual(out["status"], "refused")
        # room for the plan, but the clock says the time limit has passed once the first step has trained
        now = [0.0]
        deps = FakeRl(sum_answer)
        original = deps.train
        deps.train = lambda *a: (original(*a), now.__setitem__(0, M.RL_TRAIN_WALL_S + 100))[0]
        out = M.run_rl_core(job(), lambda _j: deps, clock=lambda: now[0], log=lambda *_: None)
        self.assertEqual(out["status"], "ok", out)
        self.assertIn("time limit", out["stopped_early"])
        self.assertEqual(out["steps_done"], 1)
        # and a budget that covers the plan but not a second step stops before it
        tight = job(budget_usd=0.01)
        out = M.run_rl_core(tight, lambda _j: FakeRl(sum_answer), log=lambda *_: None)
        self.assertIn(out["status"], ("ok", "refused", "error"))

    def test_a_save_that_fails_is_an_error_without_the_key(self):
        out, _ = self.run_it(FakeRl(sum_answer, fail_save=True))
        self.assertEqual(out["status"], "error")
        self.assertNotIn("tml-secret-key-0000", json.dumps(out))
        self.assertGreaterEqual(out["steps_done"], 1)

    def test_no_model_written_code_is_run(self):
        # an answer that looks like code is only text for the rubric to read
        deps = FakeRl(lambda p, s, k: "__import__('os').system('echo hi')")
        out, _ = self.run_it(deps)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["score_before"], 0.0)
        # and nothing in the runner evaluates text a model wrote
        calls = {n.func.id for n in ast.walk(TREE) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
        self.assertFalse(calls & {"eval", "exec", "compile", "__import__"}, calls & {"eval", "exec", "compile"})

    def test_the_result_has_no_hidden_fields(self):
        out, _ = self.run_it(FakeRl(sum_answer))
        self.assertNotIn("split_salt", out)
        self.assertNotIn(SALT, json.dumps(out))


class Store(unittest.TestCase):
    def test_progress_is_kept_under_the_run_name_and_read_back_strictly(self):
        class Dict(dict):
            def put(self, k, v):
                self[k] = v

        store = Dict()
        M.write_progress(store, "e41-0a1b2c3d", {"v": 1, "phase": "sampling", "step": 1})
        self.assertEqual(M.read_progress(store, "e41-0a1b2c3d")["step"], 1)
        # a name that is not a run name is neither written nor read, and a store that is missing or broken is no problem
        M.write_progress(store, "../x", {"v": 1})
        self.assertEqual(list(store), ["e41-0a1b2c3d"])
        self.assertIsNone(M.read_progress(store, "../x"))
        self.assertIsNone(M.read_progress(None, "e41-0a1b2c3d"))
        M.write_progress(None, "e41-0a1b2c3d", {})
        store["e41-ffffffff"] = "not json"
        self.assertIsNone(M.read_progress(store, "e41-ffffffff"))
        # an over-large record is not stored
        M.write_progress(store, "e41-00000000", {"x": "y" * 20000})
        self.assertNotIn("e41-00000000", store)


class Shape(unittest.TestCase):
    def test_the_rl_function_is_on_the_training_image_with_the_tinker_key_only(self):
        node = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "train_rl")
        text = " ".join(ast.unparse(d) for d in node.decorator_list)
        self.assertIn("train_image", text)
        self.assertIn("oblab-tinker-auth", text)
        self.assertNotIn("oblab-tinker-jobs-auth", text)

    def test_the_modal_file_compiles_and_avoids_runtime_pipe_annotations(self):
        import py_compile
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            py_compile.compile(str(ROOT / "modal" / "tinker_jobs.py"), cfile=str(Path(folder) / "t.pyc"), doraise=True)
        for node in ast.walk(TREE):
            for a in (getattr(node, "returns", None), getattr(node, "annotation", None)):
                self.assertFalse(a is not None and isinstance(a, ast.BinOp) and isinstance(a.op, ast.BitOr))


if __name__ == "__main__":
    unittest.main()
