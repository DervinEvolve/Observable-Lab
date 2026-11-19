"""Keeping a research model and asking it for a story (modal/research_runner.py),
tested without Modal.

The plain functions and the fixed scripts are loaded from the file's source,
with fake Sandbox objects; no GPU, Volume or network is touched. The last
class runs the real scripts on a real (tiny) torch model and is skipped when
torch is not installed. Run: python -m unittest discover -s tests
"""
import ast
import base64
import hashlib
import hmac
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "modal" / "research_runner.py").read_text()
TOKEN = "test-only-modal-token-00000000000000000"
KEY = "e81-0a1b2c3d"
SKIP_CONSTANTS = {"GPU_KIND", "PYTHON_BASE_IMAGE", "APP_NAME"}

try:
    import torch  # noqa: F401
    HAVE_TORCH = True
except Exception:
    HAVE_TORCH = False


def runner(extra=None, decorated=()):
    """The runner's constants and undecorated functions, plus the named decorated ones without their decorators."""
    namespace = {"base64": base64, "hashlib": hashlib, "json": json, "math": math, "os": os, "re": re,
                 "shutil": shutil, "time": time, "hmac": hmac, "sys": sys, "subprocess": subprocess,
                 "Request": Request, "HTTPException": HTTPException}
    namespace.update(extra or {})
    body = []
    for node in ast.parse(SOURCE).body:
        if isinstance(node, ast.FunctionDef):
            if not node.decorator_list:
                body.append(node)
            elif node.name in decorated:
                node.decorator_list = []
                body.append(node)
        elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id.isupper() and node.targets[0].id not in SKIP_CONSTANTS \
                and node.targets[0].id not in namespace:
            body.append(node)
    exec(compile(ast.Module(body=body, type_ignores=[]), "modal/research_runner.py", "exec"), namespace)
    return namespace


R = runner()
# The one supervisor that starts train.py, for a run that keeps its model and for one that does not.
SUPERVISOR = re.search(r'        supervisor = """(.*?)"""\n', SOURCE, re.S).group(1)


def status_json(blob, **over):
    parts = -(-len(blob) // R["KEEP_PART_BYTES"])
    s = {"saved": True, "bytes": len(blob), "parts": parts, "sha256": hashlib.sha256(blob).hexdigest(),
         "params": 1234, "seq_len": 64, "eval_calls": 1, "eval_bpb": 0.75, "module": "GPT", "torch": "2.6.0",
         "save_seconds": 1.5}
    s.update(over)
    return json.dumps(s).encode()


OK_RESULT = {"status": "ok", "metrics": {"val_bpb": 0.75, "params_m": 10.5}, "dataset": "tinystories_gpt4_clean",
             "metrics_source": "experiment_stdout_unverified", "gpu": "A10G", "budget_s": 300, "harness_sha256": "a" * 64}


def save(root, key, when, blob=b"model bytes", result=OK_RESULT):
    report = R["keep_status"](status_json(blob))
    R["store_candidate"](root, key, "print('train')\n", blob, R["build_manifest"](key, report, result, "print('train')\n", when), when)


class PlainFunctionTests(unittest.TestCase):
    def test_keys(self):
        for good in ["e1-00000000", "e123456-abcdef12", "owner-0a1b2c3d", "smoke-ffffffff"]:
            self.assertTrue(R["valid_key"](good), good)
        for bad in ["", None, 5, "e-00000000", "e1234567-00000000", "e1-0000000", "e1-0000000g", "../e1-00000000",
                    "e1-00000000/x", "kept-00000000", "E1-00000000", "e1-00000000\n"]:
            self.assertFalse(R["valid_key"](bad), repr(bad))
        self.assertEqual(R["key_epoch"]("e81-0a1b2c3d"), 81)
        self.assertIsNone(R["key_epoch"]("owner-0a1b2c3d"))

    def test_prompt_is_one_plain_line_and_capped(self):
        self.assertEqual(R["clean_prompt"](""), "Once upon a time")
        self.assertEqual(R["clean_prompt"](None), "Once upon a time")
        self.assertEqual(R["clean_prompt"]("  A cat\nsat\ton  a\x00 mat \u2603 "), "A cat sat on a mat")
        self.assertEqual(len(R["clean_prompt"]("x" * 5000)), R["PROMPT_MAX_CHARS"])

    def test_story_bytes_are_cut_and_made_plain(self):
        raw = b"Hello\x00 \xff\x1b[31mworld\n\nnext" + bytes(range(256))
        # The limit is on the bytes the sandbox sent, before the unprintable ones are dropped.
        self.assertEqual(R["clean_story"](raw, 16), "Hello [31mwor")
        self.assertEqual(R["clean_story"](raw, 20), "Hello [31mworld\n\n")
        self.assertEqual(R["clean_story"](raw, 0), "")
        self.assertEqual(R["clean_story"]("not bytes", 10), "")
        text = R["clean_story"](bytes(range(256)) * 4, 10_000)
        self.assertTrue(all(ch == "\n" or 32 <= ord(ch) <= 126 for ch in text))

    def test_save_report_is_checked_field_by_field(self):
        blob = b"x" * 10
        good = R["keep_status"](status_json(blob))
        self.assertTrue(good["saved"])
        self.assertEqual((good["bytes"], good["parts"], good["seq_len"], good["module"]), (10, 1, 64, "GPT"))
        self.assertFalse(R["keep_status"](b"")["saved"])
        self.assertFalse(R["keep_status"](b"[1]")["saved"])
        self.assertFalse(R["keep_status"](b'{"saved": "yes"}')["saved"])
        refused = R["keep_status"](json.dumps({"saved": False, "reason": "no\nmodel\x1b[0m " + "y" * 900}).encode())
        self.assertEqual(refused["saved"], False)
        self.assertNotIn("\n", refused["reason"])
        self.assertNotIn("\x1b", refused["reason"])
        self.assertLessEqual(len(refused["reason"]), 300)
        for over in [{"bytes": R["KEEP_MAX_BYTES"] + 1}, {"bytes": -1}, {"bytes": True}, {"parts": 2}, {"parts": 0},
                     {"sha256": "z" * 64}, {"sha256": 5}, {"bytes": "10"}]:
            self.assertFalse(R["keep_status"](status_json(blob, **over))["saved"], over)
        odd = R["keep_status"](status_json(blob, params="many", seq_len=-3, eval_bpb=float("nan"), module="G\nPT" + "x" * 200))
        self.assertTrue(odd["saved"])
        self.assertEqual((odd["params"], odd["seq_len"], odd["eval_bpb"]), (None, None, None))
        self.assertLessEqual(len(odd["module"]), 80)
        # How long the save step says it took is a number in a sane range or nothing.
        self.assertEqual(good["save_seconds"], 1.5)
        for took in [-1, 1e9, "2", True, float("inf"), None]:
            self.assertIsNone(R["keep_status"](status_json(blob, save_seconds=took))["save_seconds"], took)

    def test_output_a_sandbox_prints_is_read_up_to_a_limit(self):
        self.assertEqual(R["read_bounded"](iter([b"ab", b"cd"]), 10), (b"abcd", True))
        self.assertEqual(R["read_bounded"](iter([b"ab", b"cd"]), 4), (b"abcd", True))
        self.assertEqual(R["read_bounded"](iter([]), 4), (b"", True))
        self.assertEqual(R["read_bounded"](iter(["text ", "too"]), 100), (b"text too", True))
        # It stops asking for more as soon as the limit is passed.
        taken = []
        def endless():
            while True:
                taken.append(1)
                yield b"x" * 1000
        data, whole = R["read_bounded"](endless(), 2500)
        self.assertEqual((len(data), whole, len(taken)), (2500, False, 3))
        self.assertEqual(R["read_bounded"](iter([b"y" * 10_000_000]), 16), (b"y" * 16, False))

    def test_nothing_is_left_that_asks_the_training_sandbox_when_training_ended(self):
        # The first version had a second supervisor that believed a marker file train.py could write itself.
        for gone in ["KEEP_SUPERVISOR", "keep_report", "KEEP_CUT_BEFORE_LIMIT_S"]:
            self.assertNotIn(gone, R)
        for word in ["train-done", "train_done", "OBLAB_KEEP"]:
            self.assertNotIn(word, SOURCE)
        self.assertEqual(SOURCE.count("supervisor = "), 1)
        self.assertEqual(SOURCE.count('sb.exec("python", "-c", supervisor,'), 1)

    def test_sample_output_is_never_trusted(self):
        def out(obj):
            return ("junk\nOBLAB_SAMPLE " + json.dumps(obj) + "\n").encode()
        new = b" there was a cat.\x00\x07<b>\n\n" + b"z" * 500
        ok = R["sample_result"](out({"ok": True, "new_b64": base64.b64encode(new).decode(), "stopped": "end"}), "Once", 30)
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(ok["text"], "Once there was a cat.<b>\n\nzzzzzz")
        self.assertEqual(ok["new_bytes"], len(ok["continuation"]))
        self.assertLessEqual(ok["new_bytes"], 30)
        self.assertEqual(ok["stopped"], "end")
        self.assertEqual(R["sample_result"](out({"ok": True, "new_b64": "", "stopped": "whatever"}), "p", 5)["stopped"], "limit")
        failed = R["sample_result"](out({"ok": False, "stage": "load", "error": "Boom\n" + "e" * 900}), "p", 5)
        self.assertEqual((failed["status"], failed["stage"]), ("error", "load"))
        self.assertLessEqual(len(failed["error"]), 300)
        self.assertEqual(R["sample_result"](out({"ok": False, "stage": "<script>"}), "p", 5)["stage"], "sandbox")
        for junk in [b"", b"OBLAB_SAMPLE {", b"OBLAB_SAMPLE [1]", out({"ok": True, "new_b64": "***"})]:
            self.assertEqual(R["sample_result"](junk, "p", 5)["status"], "error")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="oblab-store-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_candidate_is_stored_with_its_code_and_manifest(self):
        save(self.root, KEY, 1000)
        directory = os.path.join(self.root, "candidates", KEY)
        self.assertEqual(sorted(os.listdir(directory)), ["manifest.json", "model.pt", "train.py"])
        m = R["read_manifest"](directory)
        self.assertEqual((m["key"], m["epoch"], m["source"], m["val_bpb"]), (KEY, 81, "epoch", 0.75))
        self.assertEqual(m["metrics_source"], "experiment_stdout_unverified")
        self.assertEqual(m["model_sha256"], hashlib.sha256(b"model bytes").hexdigest())
        self.assertEqual(m["train_py_sha256"], hashlib.sha256(b"print('train')\n").hexdigest())
        self.assertEqual(m["harness_sha256"], "a" * 64)
        self.assertEqual(R["models_info"](self.root), [])  # a candidate is not a kept model

    def test_promote_moves_it_and_is_idempotent(self):
        save(self.root, KEY, 1000)
        first = R["promote"](self.root, KEY, 2000)
        self.assertTrue(first["ok"])
        self.assertFalse(first["already"])
        self.assertEqual(first["model"]["promoted_at"], 2000)
        self.assertFalse(os.path.exists(os.path.join(self.root, "candidates", KEY)))
        again = R["promote"](self.root, KEY, 3000)
        self.assertTrue(again["ok"] and again["already"])
        info = R["models_info"](self.root)
        self.assertEqual([m["key"] for m in info], [KEY])
        self.assertIsNone(info[0]["check"])
        self.assertNotIn("weights_format", info[0])

    def test_promote_refuses_what_is_not_there_and_smoke_models(self):
        self.assertFalse(R["promote"](self.root, "../../etc", 1)["ok"])
        self.assertFalse(R["promote"](self.root, KEY, 1)["ok"])
        save(self.root, "smoke-00000001", 1000, result={**OK_RESULT, "dataset": "synthetic_smoke"})
        self.assertFalse(R["promote"](self.root, "smoke-00000001", 2000)["ok"])
        self.assertEqual(R["models_info"](self.root), [])

    def test_only_a_few_models_are_kept(self):
        for i in range(1, 7):
            key = "e%d-0a1b2c3d" % i
            save(self.root, key, 1000 + i)
            self.assertTrue(R["promote"](self.root, key, 2000 + i)["ok"])
        kept = [m["key"] for m in R["models_info"](self.root)]
        self.assertEqual(kept, ["e6-0a1b2c3d", "e5-0a1b2c3d", "e4-0a1b2c3d"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "kept"))), sorted(kept))

    def test_old_and_surplus_candidates_are_cleared_away(self):
        now = 10_000_000
        save(self.root, "e1-0a1b2c3d", now - R["CANDIDATE_TTL_S"] - 10)
        for i in range(2, 7):
            save(self.root, "e%d-0a1b2c3d" % i, now + i)
        left = sorted(os.listdir(os.path.join(self.root, "candidates")))
        self.assertEqual(left, ["e4-0a1b2c3d", "e5-0a1b2c3d", "e6-0a1b2c3d"])

    def test_a_directory_that_is_not_a_whole_model_is_not_listed(self):
        save(self.root, KEY, 1000)
        R["promote"](self.root, KEY, 2000)
        model = os.path.join(self.root, "kept", KEY, "model.pt")
        Path(model).write_bytes(b"model by")  # shorter than the manifest says: caught half written
        self.assertEqual(R["models_info"](self.root), [])
        os.remove(model)
        self.assertEqual(R["models_info"](self.root), [])
        os.makedirs(os.path.join(self.root, "kept", "not-a-key"))
        self.assertEqual(R["models_info"](self.root), [])

    def test_check_is_read_carefully(self):
        save(self.root, KEY, 1000)
        R["promote"](self.root, KEY, 2000)
        path = os.path.join(self.root, "kept", KEY, "check.json")
        Path(path).write_text(json.dumps({"ok": True, "sample": "Once upon a time\x00 a cat", "checked_at": 5}))
        check = R["models_info"](self.root)[0]["check"]
        self.assertEqual(check, {"ok": True, "reason": None, "sample": "Once upon a time a cat", "checked_at": 5})
        Path(path).write_text("{")
        self.assertIsNone(R["models_info"](self.root)[0]["check"])
        Path(path).write_text(json.dumps({"ok": "yes"}))
        self.assertIsNone(R["models_info"](self.root)[0]["check"])


class Clock:
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now


class KeepRunTests(unittest.TestCase):
    """run_experiment with keep_key, against a fake sandbox."""
    GRACE = 120
    BLOB = b"pickled model " * 1000

    def run_keep(self, keep_key=KEY, result=b'RESULT {"val_bpb": 0.75}\n', train_runs_for=330.0, save_seconds=1.5,
                 status=None, break_reader=False, returncode=0, smoke=False, store_fails=False, setup_fails=False):
        clock = Clock()
        blob = self.BLOB
        status_bytes = status_json(blob) if status is None else status
        stored, committed, reloaded = [], [], []

        class Cache:
            def commit(self): pass
            def read_only(self): return "read-only-dataset"

        class Store:
            def reload(self): reloaded.append(True)
            def commit(self): committed.append(True)

        class Sandbox:
            terminated = False
            writes = {}
            commands = []

            @property
            def filesystem(self):
                return SimpleNamespace(write_text=lambda data, path: self.writes.__setitem__(path, data))

            def exec(self, *args, **kwargs):
                self.commands.append((args, kwargs))
                out, code = b"", 0
                def wait():
                    pass
                if args[0] == "cp" and setup_fails:
                    code = 1
                if args[:2] == ("python", "-c"):  # the supervisor
                    def wait():
                        # The process is over when training and the save step are, or at the hard stop.
                        clock.now += min(train_runs_for + (save_seconds if keep_key == KEY else 0), kwargs["timeout"])
                    code = returncode
                    # Whatever the sandbox prints here, the controller must not read a word of it.
                    out = b'OBLAB_KEEP {"train_done_s": 0.05, "total_s": 419.0, "cut": true, "rc": 0}'
                elif args[:3] == ("python", "-I", "-c") and args[3] == R["KEEP_READER"]:
                    if break_reader:
                        raise RuntimeError("sandbox went away\nwith details")
                    if args[4] == "status":
                        out = status_bytes
                    else:
                        first, count, limit = int(args[5]), int(args[6]), int(args[7])
                        out = blob[first * limit:(first + count) * limit]
                elif args[:3] == ("python", "-I", "-c"):  # the log reader
                    out = result
                return SimpleNamespace(wait=wait, returncode=code, stdout=SimpleNamespace(read=lambda: out))

            def terminate(self):
                self.terminated = True

        sb = Sandbox()
        creates = []

        def create(**kwargs):
            creates.append(kwargs)
            return sb

        def store_candidate(root, key, train_py, data, manifest, now):
            if store_fails:
                raise OSError("volume is full")
            stored.append({"root": root, "key": key, "train_py": train_py, "data": data, "manifest": manifest})

        namespace = runner({
            "os": SimpleNamespace(makedirs=lambda *a, **k: None, environ={"PATH": "/usr/bin", "SECRET_SENTINEL": "must-not-pass"}),
            "time": clock, "sys": SimpleNamespace(executable="python"),
            "modal": SimpleNamespace(Sandbox=SimpleNamespace(create=create)),
            "cache": Cache(), "model_store": Store(), "app": "test-app", "image": "reviewed-image",
            "GPU_KIND": "test-gpu", "TRAIN_GRACE_S": self.GRACE,
        }, decorated={"run_experiment"})
        namespace["store_candidate"] = store_candidate
        with patch("subprocess.run", return_value=SimpleNamespace(returncode=0)), \
             patch("builtins.open", side_effect=lambda *a, **k: io.BytesIO(b"reviewed harness")):
            out = namespace["run_experiment"]("# arbitrary generated code", 300, smoke, keep_key)
        return SimpleNamespace(result=out, sb=sb, creates=creates, stored=stored, committed=committed, namespace=namespace)

    def test_kept_run_saves_a_candidate_and_reports_it(self):
        r = self.run_keep()
        self.assertEqual(r.result["status"], "ok")
        self.assertEqual(r.result["metrics"]["val_bpb"], 0.75)
        ck = r.result["checkpoint"]
        self.assertEqual((ck["key"], ck["saved"]), (KEY, True))
        self.assertEqual(ck["bytes"], len(self.BLOB))
        self.assertEqual(ck["sha256"], hashlib.sha256(self.BLOB).hexdigest())
        self.assertNotIn("reason", ck)
        self.assertEqual(r.result["runner_flow"], "keep-1")
        self.assertEqual(len(r.stored), 1)
        self.assertEqual(r.stored[0]["data"], self.BLOB)
        self.assertEqual(r.stored[0]["train_py"], "# arbitrary generated code")
        self.assertEqual(r.stored[0]["manifest"]["harness_sha256"], hashlib.sha256(b"reviewed harness").hexdigest())
        self.assertEqual(r.stored[0]["manifest"]["val_bpb"], 0.75)
        self.assertTrue(r.committed)
        self.assertTrue(r.sb.terminated)

    def test_the_training_sandbox_is_as_closed_as_before(self):
        r = self.run_keep()
        c = r.creates[0]
        self.assertEqual(c["secrets"], [])
        self.assertIs(c["block_network"], True)
        self.assertEqual(c["volumes"], {"/cache": "read-only-dataset"})  # never the model store
        self.assertNotIn("SECRET_SENTINEL", c["env"])
        self.assertEqual(c["gpu"], "test-gpu")
        limit = 300 + self.GRACE
        self.assertEqual(c["timeout"], limit + 60 + R["KEEP_COLLECT_S"])
        train = [(a, k) for a, k in r.sb.commands if a[:2] == ("python", "-c")]
        self.assertEqual(len(train), 1)
        # The same supervisor, arguments and hard stop as a run that keeps nothing.
        plain = [(a, k) for a, k in self.run_keep(keep_key=None).sb.commands if a[:2] == ("python", "-c")]
        self.assertEqual(train, plain)
        self.assertEqual(train[0][0], ("python", "-c", SUPERVISOR))
        self.assertEqual(train[0][1], {"timeout": limit})
        self.assertEqual(r.sb.writes["/tmp/train.py"], "# arbitrary generated code")
        # The disposable copy is the reviewed harness with the save step appended.
        self.assertEqual(r.sb.writes["/tmp/prepare.py"], "reviewed harness" + R["KEEP_HOOK"])

    def test_the_measured_time_is_the_whole_process_and_nothing_is_taken_off_it(self):
        r = self.run_keep(train_runs_for=330.0, save_seconds=4.0)
        self.assertAlmostEqual(r.result["train_wall_seconds"], 334.0)
        # What the save step says about itself is passed on, checked, as information.
        self.assertEqual(r.result["checkpoint"]["save_seconds"], 1.5)
        claimed = self.run_keep(train_runs_for=330.0, save_seconds=4.0, status=status_json(self.BLOB, save_seconds=333.9))
        self.assertAlmostEqual(claimed.result["train_wall_seconds"], 334.0)
        self.assertAlmostEqual(self.run_keep(keep_key=None, train_runs_for=330.0).result["train_wall_seconds"], 330.0)

    def test_a_run_stopped_at_the_hard_limit_is_a_budget_crash_whatever_the_sandbox_says(self):
        limit = 300 + self.GRACE
        # The fake supervisor output claims training ended at 0.05 s and the rest was the save step
        # (what a train.py that wrote the first version's marker file could make it say).
        for runs_for, save in [(10_000, 0), (limit - 2.0, 5.0), (limit - 1.0, 0.0), (0.05, limit)]:
            r = self.run_keep(train_runs_for=runs_for, save_seconds=save)
            self.assertEqual((r.result["status"], r.result["stage"]), ("crash", "budget"), (runs_for, save))
            self.assertGreaterEqual(r.result["train_wall_seconds"], limit - 1)
            self.assertNotIn("checkpoint", r.result)
            self.assertNotIn("metrics", r.result)
            self.assertEqual(r.result["runner_flow"], "keep-1")
            self.assertEqual(r.stored, [])
            self.assertFalse(any(R["KEEP_READER"] in a for a, _ in r.sb.commands))
            # Exactly what a run that keeps nothing gets for the same process lifetime.
            same = self.run_keep(keep_key=None, train_runs_for=runs_for + save)
            self.assertEqual({k: v for k, v in r.result.items() if k != "runner_flow"}, same.result)
        # Just inside the limit it is a score, with the raw time beside it.
        inside = self.run_keep(train_runs_for=limit - 4.0, save_seconds=2.0)
        self.assertEqual(inside.result["status"], "ok")
        self.assertAlmostEqual(inside.result["train_wall_seconds"], limit - 2.0)

    def test_every_result_of_a_run_with_the_save_step_says_so(self):
        for kwargs, stage in [({"returncode": 1}, "train"), ({"result": b"no result line\n"}, "parse"),
                              ({"result": b"RESULT {not json\n"}, "parse"), ({"setup_fails": True}, "sandbox"),
                              ({"result": b'RESULT {"val_bpb": 0.5, "train_seconds": 900}\n'}, "budget")]:
            r = self.run_keep(**kwargs)
            self.assertEqual((r.result["status"], r.result["stage"]), ("crash", stage))
            self.assertEqual(r.result["runner_flow"], "keep-1", kwargs)
            self.assertNotIn("runner_flow", self.run_keep(keep_key=None, **kwargs).result)
        # A run that never reached a sandbox had no save step.
        namespace = runner({"modal": None}, decorated={"run_experiment"})
        syntax = namespace["run_experiment"]("def broken(:\n", 300, False, KEY)
        self.assertEqual((syntax["stage"], "runner_flow" in syntax), ("syntax", False))

    def test_a_crashed_run_keeps_nothing(self):
        r = self.run_keep(returncode=1)
        self.assertEqual((r.result["status"], r.result["stage"]), ("crash", "train"))
        self.assertEqual(r.stored, [])
        r = self.run_keep(result=b"no result line\n")
        self.assertEqual((r.result["status"], r.result["stage"]), ("crash", "parse"))
        self.assertEqual(r.stored, [])
        self.assertFalse(any(a[3:5] == (R["KEEP_READER"], "status") for a, _ in r.sb.commands))
        r = self.run_keep(result=b'RESULT {"val_bpb": 0.5, "train_seconds": 900}\n')
        self.assertEqual((r.result["status"], r.result["stage"]), ("crash", "budget"))
        self.assertEqual(r.stored, [])

    def test_a_failed_save_or_copy_never_fails_the_run(self):
        for kwargs, words in [
            ({"status": json.dumps({"saved": False, "reason": "prepare.evaluate_bpb was never called"}).encode()}, "never called"),
            ({"status": b""}, "no readable report"),
            ({"status": status_json(self.BLOB, sha256="0" * 64)}, "did not arrive whole"),
            ({"break_reader": True}, "could not be copied out"),
            ({"store_fails": True}, "could not be stored"),
        ]:
            r = self.run_keep(**kwargs)
            self.assertEqual(r.result["status"], "ok", kwargs)
            self.assertEqual(r.result["metrics"]["val_bpb"], 0.75)
            self.assertFalse(r.result["checkpoint"]["saved"], kwargs)
            self.assertIn(words, r.result["checkpoint"]["reason"])
            self.assertNotIn("\n", r.result["checkpoint"]["reason"])
            self.assertTrue(r.sb.terminated)

    def test_a_bad_key_changes_nothing_about_the_run(self):
        r = self.run_keep(keep_key="../../kept/x")
        self.assertEqual(r.result["status"], "ok")
        self.assertEqual(r.result["checkpoint"], {"key": None, "saved": False, "reason": "the key the lab sent is not a model key"})
        self.assertEqual(r.creates[0]["timeout"], 300 + self.GRACE + 60)
        self.assertNotIn("/tmp/prepare.py", r.sb.writes)
        self.assertNotIn("runner_flow", r.result)
        self.assertEqual(r.stored, [])

    def test_without_a_key_nothing_of_this_runs(self):
        r = self.run_keep(keep_key=None, train_runs_for=5.0, save_seconds=0)
        self.assertEqual(r.result["status"], "ok")
        self.assertNotIn("checkpoint", r.result)
        self.assertNotIn("runner_flow", r.result)
        self.assertEqual(r.creates[0]["timeout"], 300 + self.GRACE + 60)
        self.assertEqual(sorted(r.sb.writes), ["/tmp/train.py"])
        for args, _ in r.sb.commands:
            self.assertNotIn(R["KEEP_READER"], args)
        self.assertEqual((r.stored, r.committed), ([], []))


class EndpointTests(unittest.TestCase):
    def app(self, calls):
        def spawn(*args):
            calls.append(("run", args))
            return SimpleNamespace(object_id="test-call")
        namespace = runner({
            "run_experiment": SimpleNamespace(spawn=spawn),
            "store_op": SimpleNamespace(remote=lambda *a: calls.append(("store", a)) or {"ok": True}),
            "kept_info": SimpleNamespace(remote=lambda *a: calls.append(("info", a)) or {"models": []}),
            "sample_story": SimpleNamespace(remote=lambda *a: calls.append(("sample", a)) or {"status": "ok", "text": "x"}),
        }, decorated={"start", "models"})
        app = FastAPI()
        app.add_api_route("/start", namespace["start"], methods=["POST"])
        app.add_api_route("/models", namespace["models"], methods=["POST"])
        return app

    def test_start_passes_a_key_only_when_one_is_sent(self):
        calls = []
        body = {"train_py": "# test code\n" * 20}
        auth = {"Authorization": "Bearer " + TOKEN}
        with TestClient(self.app(calls)) as client, patch.dict(os.environ, {"RUNNER_TOKEN": TOKEN}):
            self.assertEqual(client.post("/start", json=body, headers=auth).status_code, 200)
            self.assertEqual(calls[-1], ("run", (body["train_py"], 300.0, False)))
            self.assertEqual(client.post("/start", json={**body, "keep_key": KEY}, headers=auth).status_code, 200)
            self.assertEqual(calls[-1], ("run", (body["train_py"], 300.0, False, KEY)))
            n = len(calls)
            for bad in ["owner-0a1b2c3d", "smoke-0a1b2c3d", "x", 5, "", ["e1-00000000"], "e1-00000000/.."]:
                self.assertEqual(client.post("/start", json={**body, "keep_key": bad}, headers=auth).status_code, 400, bad)
            self.assertEqual(client.post("/start", json={**body, "keep_key": KEY}).status_code, 401)
            self.assertEqual(len(calls), n)

    def test_models_needs_the_token_and_checks_what_it_is_sent(self):
        calls = []
        auth = {"Authorization": "Bearer " + TOKEN}
        with TestClient(self.app(calls)) as client, patch.dict(os.environ, {"RUNNER_TOKEN": TOKEN}):
            self.assertEqual(client.post("/models", json={"action": "info"}).status_code, 401)
            self.assertEqual(client.post("/models", json={"action": "info", "token": TOKEN}).status_code, 401)
            self.assertEqual(calls, [])
            self.assertEqual(client.post("/models", json={"action": "info"}, headers=auth).status_code, 200)
            # The list is read by a function of its own, never by the one that promotes.
            self.assertEqual(calls[-1], ("info", ()))
            self.assertEqual(client.post("/models", json={"action": "promote", "key": KEY}, headers=auth).status_code, 200)
            self.assertEqual(calls[-1], ("store", ("promote", KEY)))
            ok = client.post("/models", json={"action": "sample", "key": KEY, "prompt": "A cat", "max_new": 50}, headers=auth)
            self.assertEqual(ok.status_code, 200)
            self.assertEqual(calls[-1], ("sample", (KEY, "A cat", 50)))
            n = len(calls)
            for bad in [
                {"action": "promote", "key": "../x"}, {"action": "sample"}, {"action": "delete", "key": KEY},
                {"action": "sample", "key": KEY, "prompt": 5}, {"action": "sample", "key": KEY, "prompt": "x" * 801},
                {"action": "sample", "key": KEY, "max_new": 0}, {"action": "sample", "key": KEY, "max_new": 501},
                {"action": "sample", "key": KEY, "max_new": True}, {"action": "sample", "key": KEY, "max_new": "9"},
            ]:
                self.assertEqual(client.post("/models", json=bad, headers=auth).status_code, 400, bad)
            self.assertEqual(len(calls), n)


class SampleSandboxTests(unittest.TestCase):
    def sample(self, output=None, raises=False, record_check=False, area="kept", key=KEY, prompt="A cat\nsat", root=None,
               pieces=None):
        if output is None:
            new = base64.b64encode(b" on a mat.\n\n").decode()
            output = ("OBLAB_SAMPLE " + json.dumps({"ok": True, "new_b64": new, "stopped": "end"})).encode()
        creates, mounts, waited = [], [], []

        def read_all():
            raise AssertionError("the sampling sandbox's output must never be read in one piece")

        class Sandbox:
            terminated = False
            writes = {}
            commands = []

            @property
            def filesystem(self):
                return SimpleNamespace(write_text=lambda data, path: self.writes.__setitem__(path, data))

            def exec(self, *args, **kwargs):
                self.commands.append((args, kwargs))
                if raises:
                    raise RuntimeError("exec failed")
                stream = pieces() if pieces else iter([output[:7], output[7:]])
                class Stdout:
                    read = staticmethod(read_all)
                    def __iter__(self):
                        return stream
                return SimpleNamespace(wait=lambda: waited.append(True), returncode=0, stdout=Stdout())

            def terminate(self):
                self.terminated = True

        sb = Sandbox()

        class Store:
            committed = 0
            def reload(self): pass
            def commit(self): Store.committed += 1
            def with_mount_options(self, **kwargs):
                mounts.append(kwargs)
                return ("mount", kwargs["sub_path"])

        def create(**kwargs):
            creates.append(kwargs)
            return sb

        namespace = runner({
            "modal": SimpleNamespace(Sandbox=SimpleNamespace(create=create)), "model_store": Store(),
            "app": "test-app", "image": "reviewed-image", **({"MODELS_ROOT": root} if root else {}),
        }, decorated={"sample_story"})
        result = namespace["sample_story"](key, prompt, 60, area, record_check)
        return SimpleNamespace(result=result, sb=sb, creates=creates, mounts=mounts, store=Store, waited=waited)

    def test_sampling_sandbox_has_no_network_no_secrets_and_one_model(self):
        r = self.sample()
        self.assertEqual(r.result["status"], "ok")
        self.assertEqual(r.result["text"], "A cat sat on a mat.\n\n")
        c = r.creates[0]
        self.assertIs(c["block_network"], True)
        self.assertEqual(c["secrets"], [])
        self.assertIsNone(c["gpu"])
        self.assertEqual(c["timeout"], R["SAMPLE_SANDBOX_S"])
        self.assertEqual(c["volumes"], {"/model": ("mount", "/kept/" + KEY)})
        self.assertEqual(r.mounts, [{"read_only": True, "sub_path": "/kept/" + KEY}])
        self.assertEqual(c["env"], {"PYTHONUNBUFFERED": "1"})
        run = r.sb.commands[0]
        self.assertEqual(run[0], ("python", "-I", "/tmp/oblab_sample.py"))
        self.assertEqual(run[1]["timeout"], R["SAMPLE_EXEC_S"])
        self.assertEqual(r.sb.writes["/tmp/oblab_sample.py"], R["SAMPLER"])
        request = json.loads(r.sb.writes["/tmp/request.json"])
        self.assertEqual(base64.b64decode(request["prompt_b64"]), b"A cat sat")
        self.assertEqual((request["key"], request["max_new"], request["seconds"]), (KEY, 60, R["SAMPLE_GENERATE_S"]))
        self.assertTrue(r.sb.terminated)

    def test_bad_input_starts_no_sandbox(self):
        for key, area in [("../x", "kept"), (KEY, "anywhere"), (None, "kept")]:
            r = self.sample(key=key, area=area)
            self.assertEqual((r.result["status"], r.result["stage"]), ("error", "input"))
            self.assertEqual(r.creates, [])

    def test_a_failing_sandbox_is_an_error_result_and_is_ended(self):
        r = self.sample(raises=True)
        self.assertEqual((r.result["status"], r.result["stage"]), ("error", "sandbox"))
        self.assertTrue(r.sb.terminated)
        r = self.sample(output=b"the model printed things\n")
        self.assertEqual(r.result["status"], "error")

    def test_a_sandbox_that_prints_without_end_is_ended_and_little_of_it_is_held(self):
        asked = []
        def flood():
            # What model-written code can do with the sampler's real output: megabytes, for as long as it runs.
            good = base64.b64encode(b" a story").decode()
            yield ("OBLAB_SAMPLE " + json.dumps({"ok": True, "new_b64": good, "stopped": "end"}) + "\n").encode()
            while True:
                asked.append(1)
                yield b"x" * (1 << 20)
        r = self.sample(pieces=flood)
        self.assertEqual((r.result["status"], r.result["stage"]), ("error", "sandbox"))
        self.assertIn("printed more than", r.result["error"])
        self.assertNotIn("text", r.result)          # a story that came with a flood is not passed on
        self.assertEqual(len(asked), 1)             # one megabyte was looked at, not sixty seconds of them
        self.assertEqual(r.waited, [])              # the process is not waited for
        self.assertTrue(r.sb.terminated)            # the sandbox is ended instead
        self.assertLessEqual(R["SAMPLE_OUTPUT_MAX_BYTES"], 64 * 1024)
        # An ordinary answer is far below the limit and is waited for as before.
        ok = self.sample()
        self.assertEqual((ok.result["status"], ok.waited), ("ok", [True]))

    def test_the_check_is_written_beside_the_kept_model_only(self):
        root = tempfile.mkdtemp(prefix="oblab-store-")
        self.addCleanup(shutil.rmtree, root, True)
        save(root, KEY, 1000)
        R["promote"](root, KEY, 2000)
        r = self.sample(record_check=True, root=root)
        check = R["models_info"](root)[0]["check"]
        self.assertTrue(check["ok"])
        self.assertEqual(check["sample"], "A cat sat on a mat.\n\n")
        self.assertEqual(r.store.committed, 1)
        failed = ("OBLAB_SAMPLE " + json.dumps({"ok": False, "stage": "definitions", "error": "NameError: x"})).encode()
        self.sample(record_check=True, root=root, output=failed)
        check = R["models_info"](root)[0]["check"]
        self.assertFalse(check["ok"])
        self.assertIn("definitions", check["reason"])
        # A visitor's sample writes nothing, and a candidate never gets a check.
        os.remove(os.path.join(root, "kept", KEY, "check.json"))
        self.sample(root=root)
        self.sample(record_check=True, area="candidates", root=root)
        self.assertIsNone(R["models_info"](root)[0]["check"])


class StoreOpTests(unittest.TestCase):
    def load(self, root):
        spawned, committed = [], []
        namespace = runner({
            "MODELS_ROOT": root,
            "model_store": SimpleNamespace(reload=lambda: None, commit=lambda: committed.append(True)),
            "sample_story": SimpleNamespace(spawn=lambda *a: spawned.append(a)),
        }, decorated={"store_op", "kept_info"})
        self.info = namespace["kept_info"]
        return namespace["store_op"], spawned, committed

    def test_promotion_starts_one_check_and_a_second_promotion_none(self):
        root = tempfile.mkdtemp(prefix="oblab-store-")
        self.addCleanup(shutil.rmtree, root, True)
        store_op, spawned, committed = self.load(root)
        self.assertEqual(self.info(), {"models": []})
        self.assertFalse(store_op("info")["ok"])  # the store function only promotes
        self.assertFalse(store_op("promote", KEY)["ok"])
        self.assertEqual(spawned, [])
        save(root, KEY, 1000)
        self.assertTrue(store_op("promote", KEY)["ok"])
        self.assertEqual(spawned, [(KEY, "", R["SAMPLE_CHECK_NEW"], "kept", True)])
        self.assertTrue(store_op("promote", KEY)["already"])
        self.assertEqual(len(spawned), 1)
        self.assertEqual([m["key"] for m in self.info()["models"]], [KEY])
        self.assertFalse(store_op("delete", KEY)["ok"])
        # The owner's command asks for no check and makes it itself.
        save(root, "owner-0a1b2c3d", 3000)
        self.assertTrue(store_op("promote", "owner-0a1b2c3d", False)["ok"])
        self.assertEqual(len(spawned), 1)
        self.assertTrue(committed)


class ScriptTextTests(unittest.TestCase):
    def test_scripts_compile_and_the_off_path_text_is_untouched(self):
        for name in ["KEEP_HOOK", "KEEP_READER", "SAMPLER"]:
            compile(R[name], name, "exec")
        compile(SUPERVISOR, "supervisor", "exec")
        # The supervisor and log reader are still the ones in run_experiment, and there is one of each.
        self.assertIn("p = subprocess.run([sys.executable, '/tmp/train.py'] + sys.argv[1:], stdout=out, stderr=out)", SUPERVISOR)
        self.assertEqual(SOURCE.count("resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))"), 1)
        # The save step writes parts smaller than the file limit train.py runs with.
        self.assertLess(R["KEEP_PART_BYTES"], 8 * 1024 * 1024)
        # The harness with the save step appended is still one valid module.
        compile((ROOT / "modal" / "harness" / "prepare.py").read_text() + R["KEEP_HOOK"], "prepare.py", "exec")

    def test_no_new_image_and_no_network_for_generated_code(self):
        # Sampling reuses the training image, so a deploy builds nothing new.
        self.assertEqual(SOURCE.count("modal.Image.from_registry("), 2)
        self.assertEqual(SOURCE.count("block_network=True"), SOURCE.count("modal.Sandbox.create("))
        self.assertEqual(SOURCE.count("secrets=[]"), SOURCE.count("modal.Sandbox.create("))


TINY_TRAIN = '''
import json, sys, time
import torch
import torch.nn as nn
import torch.nn.functional as F
import prepare


class Tiny(nn.Module):
    def __init__(self, width=24, seq_len=32):
        super().__init__()
        self.seq_len = seq_len
        self.emb = nn.Embedding(256, width)
        self.pos = nn.Embedding(seq_len, width)
        self.out = nn.Linear(width, 256)

    def forward(self, idx, targets=None):
        pos = torch.arange(idx.size(1), device=idx.device)
        logits = self.out(torch.tanh(self.emb(idx) + self.pos(pos)))
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, 256), targets.view(-1))
        return logits, loss


def main():
    torch.manual_seed(0)
    prepare.prepare(smoke=True)
    model = Tiny()
    opt = torch.optim.AdamW(model.parameters(), lr=1e-2)
    for _ in range(3):
        x, y = prepare.get_batch("train", 4, 32, "cpu")
        _, loss = model(x, y)
        opt.zero_grad(); loss.backward(); opt.step()
    bpb = prepare.evaluate_bpb(model, batch_size=4, max_batches=2, seq_len=32, device="cpu")
    print("RESULT " + json.dumps({"val_bpb": float(bpb), "train_steps": 3, "train_seconds": 0.1}))
MAIN
'''


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class RealScriptsTests(unittest.TestCase):
    """The real hook, supervisor, reader and sampler on a real (tiny) model, in a scratch directory instead of a sandbox."""

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix="oblab-talk-"))
        self.addCleanup(shutil.rmtree, self.work, True)

    def local(self, text):
        return (text.replace("/tmp/oblab-keep", str(self.work / "oblab-keep")).replace("/tmp/train", str(self.work / "train"))
                .replace("/tmp/request.json", str(self.work / "request.json"))
                .replace('"/harness"', repr(str(ROOT / "modal" / "harness")))
                .replace('"/model"', repr(str(self.work / "model"))))

    def train(self, source, timeout=170):
        (self.work / "train.py").write_text(source)
        (self.work / "prepare.py").write_text((ROOT / "modal" / "harness" / "prepare.py").read_text() + self.local(R["KEEP_HOOK"]))
        env = {**os.environ, "RESEARCH_CACHE": str(self.work / "cache"), "TIME_BUDGET_S": "20"}
        # The runner's one supervisor; `timeout` stands for the hard stop the sandbox puts on it.
        p = subprocess.run([sys.executable, "-c", self.local(SUPERVISOR), "--smoke"],
                           cwd=self.work, env=env, capture_output=True, timeout=timeout)
        return p, (self.work / "train.log").read_text()

    def sandbox(self):
        local = self.local

        class Sandbox:
            def exec(self, *args, **kwargs):
                assert args[:3] == ("python", "-I", "-c")
                r = subprocess.run([sys.executable, "-I", "-c", local(args[3]), *args[4:]], capture_output=True)
                return SimpleNamespace(stdout=SimpleNamespace(read=lambda: r.stdout), wait=lambda: None, returncode=r.returncode)
        return Sandbox()

    def ask(self, key, prompt, max_new, seconds=40):
        request = {"key": key, "prompt_b64": base64.b64encode(prompt.encode()).decode(), "max_new": max_new, "seconds": seconds, "seed": 7}
        (self.work / "request.json").write_text(json.dumps(request))
        (self.work / "oblab_sample.py").write_text(self.local(R["SAMPLER"]))
        r = subprocess.run([sys.executable, "-I", str(self.work / "oblab_sample.py")], capture_output=True, cwd=self.work, timeout=120)
        return R["sample_result"](r.stdout, prompt, max_new)

    def test_train_save_copy_store_and_sample(self):
        source = TINY_TRAIN.replace("MAIN", 'if __name__ == "__main__":\n    main()')
        p, log = self.train(source)
        self.assertEqual(p.returncode, 0, log[-800:])
        # The save step printed nothing: the RESULT line is still the last line of the log.
        self.assertTrue(log.strip().splitlines()[-1].startswith("RESULT "), log[-400:])
        self.assertEqual(p.stdout, b"")
        self.assertEqual(sorted(f.name for f in (self.work / "oblab-keep").iterdir()), ["part-00000", "status.json"])
        report, blob = R["collect_checkpoint"](self.sandbox())
        self.assertTrue(report["saved"], report)
        self.assertEqual((report["module"], report["seq_len"], report["eval_calls"]), ("Tiny", 32, 1))
        self.assertIsNotNone(report["save_seconds"])
        reported = json.loads(log.strip().splitlines()[-1][len("RESULT "):])["val_bpb"]
        self.assertAlmostEqual(report["eval_bpb"], reported)
        self.assertEqual(hashlib.sha256(blob).hexdigest(), report["sha256"])

        root = str(self.work / "store")
        R["store_candidate"](root, KEY, source, blob, R["build_manifest"](KEY, report, OK_RESULT, source, 1000), 1000)
        self.assertTrue(R["promote"](root, KEY, 2000)["ok"])
        os.symlink(os.path.join(root, "kept", KEY), self.work / "model")
        story = self.ask(KEY, "Once upon a time", 40)
        self.assertEqual(story["status"], "ok", story)
        self.assertTrue(story["text"].startswith("Once upon a time"))
        self.assertGreater(story["new_bytes"], 0)
        self.assertLessEqual(story["new_bytes"], 40)
        self.assertTrue(all(ch == "\n" or 32 <= ord(ch) <= 126 for ch in story["continuation"]))
        # A different key than the mounted model's is refused before any model code is loaded.
        other = self.ask("e82-0a1b2c3d", "Once", 10)
        self.assertEqual((other["status"], other["stage"]), ("error", "request"))
        # No time left: it stops and says so.
        self.assertEqual(self.ask(KEY, "Once", 40, seconds=-1)["stopped"], "time")

    def test_a_train_py_that_cannot_be_loaded_again_is_a_plain_failure(self):
        # No main guard: loading its definitions would start training, which fails without the data.
        source = TINY_TRAIN.replace("MAIN", "main()")
        p, log = self.train(source)
        self.assertEqual(p.returncode, 0, log[-800:])
        report, blob = R["collect_checkpoint"](self.sandbox())
        self.assertTrue(report["saved"])
        root = str(self.work / "store")
        R["store_candidate"](root, KEY, source + "\nraise RuntimeError('ran again')\n", blob,
                             R["build_manifest"](KEY, report, OK_RESULT, source, 1000), 1000)
        R["promote"](root, KEY, 2000)
        os.symlink(os.path.join(root, "kept", KEY), self.work / "model")
        story = self.ask(KEY, "Once", 10)
        self.assertEqual((story["status"], story["stage"]), ("error", "definitions"))

    def test_no_evaluate_call_means_no_model_and_a_reason(self):
        source = "import prepare\nprint('RESULT {\"val_bpb\": 1.0}')\n"
        p, log = self.train(source)
        self.assertEqual(p.returncode, 0, log[-800:])
        report, blob = R["collect_checkpoint"](self.sandbox())
        self.assertFalse(report["saved"])
        self.assertIn("never called", report["reason"])
        self.assertIsNone(blob)

    def test_a_worker_process_that_imports_the_harness_writes_nothing(self):
        # A spawned worker imports prepare again and exits before training is over.
        source = (
            "import multiprocessing, os, sys\n"
            "import prepare\n"
            "def work():\n    pass\n"
            "if __name__ == '__main__':\n"
            "    p = multiprocessing.get_context('spawn').Process(target=work)\n"
            "    p.start(); p.join()\n"
            "    report = os.path.join(%r, 'status.json')\n"
            "    print('RESULT ' + ('{\"val_bpb\": 1.0}' if not os.path.exists(report) else 'report written by a worker'))\n"
        ) % str(self.work / "oblab-keep")
        p, log = self.train(source)
        self.assertEqual(p.returncode, 0, log[-800:])
        self.assertIn('RESULT {"val_bpb": 1.0}', log)

    def test_a_train_py_that_forges_the_save_steps_files_still_runs_into_the_hard_stop(self):
        # What got past the hard stop in the first version: train.py writes the "training is over"
        # marker and a report itself, prints a score, and carries on. The supervisor has no way out
        # but train.py ending, so the hard stop is what ends it, and the controller turns that into
        # a crash at stage "budget" (KeepRunTests above).
        keep = self.work / "oblab-keep"
        source = ("import os, time\nos.makedirs(%r, exist_ok=True)\nopen(%r, 'w').close()\n"
                  "open(%r, 'w').write('{\"saved\": false, \"save_seconds\": 9999}')\n"
                  "print('RESULT {\"val_bpb\": 0.1}', flush=True)\ntime.sleep(8)\n"
                  % (str(keep), str(keep / "train-done"), str(keep / "status.json")))
        t0 = time.time()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.train(source, timeout=3)
        self.assertGreaterEqual(time.time() - t0, 3)
        # And one that ends by itself hands back its own exit code, as it always did.
        (self.work / "train.py").write_text("raise SystemExit(3)\n")
        p = subprocess.run([sys.executable, "-c", self.local(SUPERVISOR)], cwd=self.work, capture_output=True, timeout=60)
        self.assertEqual((p.returncode, p.stdout), (3, b""))


if __name__ == "__main__":
    unittest.main()
