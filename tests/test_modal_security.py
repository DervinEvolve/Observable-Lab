"""Test the actual endpoint functions without importing Modal's deployment objects.

Run with FastAPI and httpx installed: python -m unittest discover -s tests
Only function definitions are loaded; no volume, GPU, or provider is contacted.
"""
import ast
import hmac
import hashlib
import io
import json
import subprocess
import time
import math
import os
import re
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "test-only-modal-token-00000000000000000"


def functions(path, names, namespace):
    tree = ast.parse((ROOT / path).read_text())
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            selected.append(node)
    assert len(selected) == len(names)
    exec(compile(ast.Module(body=selected, type_ignores=[]), path, "exec"), namespace)
    return namespace


class ModalAuthorizationTests(unittest.TestCase):
    def test_asgi_authentication_precedes_work(self):
        namespace = functions("modal/web_endpoints.py", {"require_operator"}, {
            "os": os, "hmac": hmac, "Request": Request, "JSONResponse": JSONResponse,
        })
        app = FastAPI()
        app.middleware("http")(namespace["require_operator"])
        calls = []

        @app.get("/probe")
        def probe():
            calls.append(True)
            return {"ok": True}

        @app.get("/health")
        def health():
            return {"status": "healthy"}

        with TestClient(app) as client, patch.dict(os.environ, {"MODAL_API_TOKEN": ""}):
            self.assertEqual(client.get("/probe").status_code, 503)
            self.assertEqual(client.get("/health").status_code, 200)
            os.environ["MODAL_API_TOKEN"] = TOKEN
            self.assertEqual(client.get("/probe").status_code, 401)
            self.assertEqual(client.get("/probe?token=" + TOKEN).status_code, 401)
            self.assertEqual(calls, [])
            result = client.get("/probe", headers={"Authorization": "Bearer " + TOKEN})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers["Cache-Control"], "no-store")
            self.assertEqual(len(calls), 1)

    def test_runner_rejects_url_body_tokens_and_invalid_budgets(self):
        calls = []
        def spawn(*args):
            calls.append(args)
            return SimpleNamespace(object_id="test-call")
        namespace = functions("modal/research_runner.py", {"_authed", "start", "status"}, {
            "os": os, "hmac": hmac, "math": math, "Request": Request,
            "HTTPException": HTTPException, "DEFAULT_BUDGET_S": 300, "MAX_BUDGET_S": 600,
            "run_experiment": SimpleNamespace(spawn=spawn),
        })
        app = FastAPI()
        app.add_api_route("/start", namespace["start"], methods=["POST"])
        app.add_api_route("/status", namespace["status"], methods=["GET"])
        body = {"train_py": "# test code\n" * 20}
        auth = {"Authorization": "Bearer " + TOKEN}
        with TestClient(app) as client, patch.dict(os.environ, {"RUNNER_TOKEN": TOKEN}):
            self.assertEqual(client.post("/start", json={**body, "token": TOKEN}).status_code, 401)
            self.assertEqual(client.get("/status", params={"token": TOKEN}).status_code, 401)
            for budget in [-1, 0, 601, "nan", "inf", "invalid", None]:
                self.assertEqual(client.post("/start", headers=auth,
                                            json={**body, "budget_s": budget}).status_code, 400)
            self.assertEqual(calls, [])
            self.assertEqual(client.post("/start", json=body, headers=auth).status_code, 200)
            self.assertEqual(calls[0][1], 300)


class Clock:
    """Deterministic stand-in for the time module; process waits advance it."""
    def __init__(self):
        self.now = 1000.0
    def time(self):
        return self.now


class ResearchIsolationTests(unittest.TestCase):
    GRACE = 120

    def run_sandbox(self, fail_setup=False, smoke=False, result=b'RESULT {"val_bpb": 0.75}\n',
                    train_runs_for=5.0, budget_s=300):
        clock = Clock()
        class Cache:
            committed = False
            def commit(self): self.committed = True
            def read_only(self): return "read-only-dataset"
        class Sandbox:
            terminated = False
            writes = {}
            commands = []
            @property
            def filesystem(self):
                return SimpleNamespace(
                    write_text=lambda data, path: self.writes.__setitem__(path, data),
                    read_bytes=lambda path: result,
                )
            def open(self, *args, **kwargs):
                raise NotImplementedError("Modal has retired the legacy filesystem API")
            def exec(self, *args, **kwargs):
                self.commands.append((args, kwargs))
                is_train = args[:2] == ("python", "-c")
                def wait():
                    if is_train:
                        clock.now += min(train_runs_for, kwargs["timeout"])
                return SimpleNamespace(wait=wait, returncode=1 if fail_setup else 0,
                                       stdout=SimpleNamespace(read=lambda: result))
            def terminate(self): self.terminated = True
        sb = Sandbox()
        creates = []
        def create(**kwargs):
            creates.append(kwargs)
            return sb
        cache = Cache()
        namespace = functions("modal/research_runner.py", {"run_experiment", "_check_train_py"}, {
            "os": SimpleNamespace(makedirs=lambda *a, **k: None,
                                  environ={"PATH": "/usr/bin", "SECRET_SENTINEL": "must-not-pass"}),
            "time": clock, "subprocess": subprocess, "sys": SimpleNamespace(executable="python"),
            "modal": SimpleNamespace(Sandbox=SimpleNamespace(create=create)),
            "cache": cache, "app": "test-app", "image": "reviewed-image",
            "GPU_KIND": "test-gpu", "DEFAULT_BUDGET_S": 300, "TRAIN_GRACE_S": self.GRACE,
            "PREPARE_TIMEOUT_S": 600, "REPORTED_TRAIN_TOLERANCE_S": 10.0,
            "hashlib": hashlib, "json": json, "math": math,
        })
        with patch("subprocess.run", return_value=SimpleNamespace(returncode=0)), \
             patch("builtins.open", return_value=io.BytesIO(b"reviewed harness")):
            result = namespace["run_experiment"]("# arbitrary generated code", budget_s, smoke=smoke)
        self.assertTrue(cache.committed)
        self.assertTrue(sb.terminated)
        self.assertEqual(creates[0]["secrets"], [])
        self.assertIs(creates[0]["block_network"], True)
        self.assertEqual(creates[0]["volumes"], {"/cache": "read-only-dataset"})
        self.assertNotIn("SECRET_SENTINEL", creates[0]["env"])
        train_limit = 180 if smoke else budget_s + self.GRACE
        self.assertEqual(creates[0]["timeout"], train_limit + 60)
        train_calls = [kw for args, kw in sb.commands if args[:2] == ("python", "-c")]
        if not fail_setup:
            self.assertEqual(train_calls[0]["timeout"], train_limit)
        self.assertEqual(creates[0]["env"]["RESEARCH_CACHE"], "/cache/smoke" if smoke else "/cache/research")
        self.assertEqual(creates[0]["gpu"], None if smoke else "test-gpu")
        self.assertEqual(sb.writes["/tmp/train.py"], "# arbitrary generated code")
        return result

    def test_generated_code_has_separate_sandbox_and_no_shared_write_access(self):
        result = self.run_sandbox()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["metrics_source"], "experiment_stdout_unverified")
        self.assertEqual(result["metrics"]["val_bpb"], 0.75)
        self.assertEqual(result["harness_sha256"], hashlib.sha256(b"reviewed harness").hexdigest())

    def test_smoke_data_and_compute_are_separate_from_research(self):
        result = self.run_sandbox(smoke=True)
        self.assertEqual(result["dataset"], "synthetic_smoke")
        self.assertEqual(result["gpu"], "cpu-smoke")

    def test_budget_is_enforced_at_budget_plus_grace(self):
        result = self.run_sandbox(train_runs_for=10_000)
        self.assertEqual(result["status"], "crash")
        self.assertEqual(result["stage"], "budget")
        self.assertNotIn("metrics", result)

    def test_reported_training_time_over_budget_is_not_a_score(self):
        result = self.run_sandbox(result=b'RESULT {"val_bpb": 0.5, "train_seconds": 900}\n')
        self.assertEqual(result["status"], "crash")
        self.assertEqual(result["stage"], "budget")
        ok = self.run_sandbox(result=b'RESULT {"val_bpb": 0.5, "train_seconds": 301.2}\n')
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(ok["budget_s"], 300)

    def test_failed_setup_terminates_sandbox(self):
        result = self.run_sandbox(fail_setup=True)
        self.assertEqual(result["status"], "crash")
        self.assertEqual(result["stage"], "sandbox")


class SyntaxCheckTests(unittest.TestCase):
    """train.py must compile before data preparation or a GPU is touched."""

    def load(self):
        prepared, created = [], []
        namespace = functions("modal/research_runner.py", {"run_experiment", "_check_train_py"}, {
            "os": SimpleNamespace(makedirs=lambda *a, **k: None, environ={"PATH": "/usr/bin"}),
            "time": Clock(), "subprocess": SimpleNamespace(run=lambda *a, **k: prepared.append(a)),
            "sys": SimpleNamespace(executable="python"),
            "modal": SimpleNamespace(Sandbox=SimpleNamespace(create=lambda **k: created.append(k))),
            "cache": None, "app": "test-app", "image": "reviewed-image", "GPU_KIND": "test-gpu",
            "DEFAULT_BUDGET_S": 300, "TRAIN_GRACE_S": 120, "PREPARE_TIMEOUT_S": 600,
            "REPORTED_TRAIN_TOLERANCE_S": 10.0, "hashlib": hashlib, "json": json, "math": math,
        })
        return namespace, prepared, created

    def test_syntax_error_is_a_crash_before_any_preparation_or_gpu(self):
        namespace, prepared, created = self.load()
        # The shape of run 1's epoch 20 failure: an unterminated string literal.
        source = "def train():\n    print('RESULT {}\n" + "x = 1\n" * 50
        result = namespace["run_experiment"](source, 300)
        self.assertEqual(result["status"], "crash")
        self.assertEqual(result["stage"], "syntax")
        self.assertIn("SyntaxError", result["error"])
        self.assertIn("line 2", result["error"])
        self.assertNotIn("metrics", result)
        self.assertEqual(prepared, [])
        self.assertEqual(created, [])

    def test_smoke_runs_are_checked_too(self):
        namespace, prepared, created = self.load()
        result = namespace["run_experiment"]("if True:\nprint('x')\n", 300, smoke=True)
        self.assertEqual((result["status"], result["stage"]), ("crash", "syntax"))
        self.assertIn("IndentationError", result["error"])
        self.assertEqual((prepared, created), ([], []))

    def test_check_accepts_valid_code_and_never_runs_it(self):
        namespace, _, _ = self.load()
        check = namespace["_check_train_py"]
        self.assertIsNone(check("raise SystemExit('this must not run')\n"))
        self.assertIsNone(check((ROOT / "modal" / "harness" / "prepare.py").read_text()))

    def test_check_reports_compile_errors_beyond_parsing(self):
        check = self.load()[0]["_check_train_py"]
        for source in ["return 1\n", "def f():\n    nonlocal x\n", "x = 1\0\n", "(" * 5000 + ")" * 5000]:
            reason = check(source)
            self.assertIsInstance(reason, str, source[:20])
            self.assertLess(len(reason), 600)


class StatusTests(unittest.TestCase):
    def status_for(self, outcome):
        class Expired(Exception):
            pass
        def get(timeout):
            if isinstance(outcome, BaseException):
                raise outcome
            if outcome == "expired":
                raise Expired()
            return outcome
        namespace = functions("modal/research_runner.py", {"_authed", "status"}, {
            "os": os, "hmac": hmac, "Request": Request, "HTTPException": HTTPException,
            "OutputExpiredError": Expired,
            "modal": SimpleNamespace(FunctionCall=SimpleNamespace(from_id=lambda call_id: SimpleNamespace(get=get))),
        })
        request = SimpleNamespace(headers={"authorization": "Bearer " + TOKEN})
        with patch.dict(os.environ, {"RUNNER_TOKEN": TOKEN}):
            return namespace["status"](request, call_id="test-call")

    def test_running_done_expired_and_failed(self):
        self.assertEqual(self.status_for(TimeoutError()), {"status": "running"})
        self.assertEqual(self.status_for({"status": "ok"}), {"status": "done", "result": {"status": "ok"}})
        self.assertEqual(self.status_for("expired")["status"], "failed")
        self.assertEqual(self.status_for(RuntimeError("boom"))["status"], "failed")


class RunnerPinTests(unittest.TestCase):
    def test_runner_images_use_the_deploy_client_pins(self):
        pins = {}
        for line in (ROOT / "requirements-runner.txt").read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                name, version = line.split("==")
                pins[name] = version
        runner = (ROOT / "modal" / "research_runner.py").read_text()
        self.assertEqual(set(pins), {"modal", "fastapi"})
        # Both images install the same FastAPI the deploy client loads locally.
        self.assertEqual(runner.count(f'fastapi=={pins["fastapi"]}'), 1)
        self.assertEqual(runner.count(f'fastapi[standard]=={pins["fastapi"]}'), 1)
        self.assertNotRegex(runner, r"fastapi(\[standard\])?==(?!" + re.escape(pins["fastapi"]) + ")")
        # Triton needs a C compiler in the training image.
        self.assertIn('.apt_install("gcc=', runner)


class DatasetPinTests(unittest.TestCase):
    PAYLOAD = b"pinned parquet bytes"

    def load(self, revision, sha256, payload=PAYLOAD):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *exc): return False
            def raise_for_status(self): pass
            def iter_content(self, chunk_size): yield payload
        requested = []
        def get(url, **kwargs):
            requested.append(url)
            return FakeResponse()
        import re, sys as real_sys
        namespace = functions("modal/harness/prepare.py", {"_dataset_url", "_download_parquet"}, {
            "re": re, "hashlib": hashlib, "sys": real_sys, "Path": Path,
            "DATASET_REPO": "karpathy/tinystories-gpt4-clean", "DATASET_FILE": "tinystories_gpt4_clean.parquet",
            "DATASET_REVISION": revision, "DATASET_SHA256": sha256,
        })
        return namespace, requested, SimpleNamespace(get=get)

    def test_unpinned_dataset_is_not_downloaded(self):
        import tempfile
        namespace, requested, fake = self.load("", "")
        with tempfile.TemporaryDirectory() as tmp, patch.dict("sys.modules", {"requests": fake}):
            dest = Path(tmp) / "data.parquet"
            with self.assertRaises(RuntimeError):
                namespace["_download_parquet"](dest)
            self.assertFalse(dest.exists())
        self.assertEqual(requested, [])

    def test_download_uses_the_pinned_revision_and_checks_the_hash(self):
        import tempfile
        revision = "0123456789abcdef0123456789abcdef01234567"
        good = hashlib.sha256(self.PAYLOAD).hexdigest()
        namespace, requested, fake = self.load(revision, good)
        with tempfile.TemporaryDirectory() as tmp, patch.dict("sys.modules", {"requests": fake}):
            dest = Path(tmp) / "data.parquet"
            namespace["_download_parquet"](dest)
            self.assertEqual(dest.read_bytes(), self.PAYLOAD)
        self.assertEqual(requested, [f"https://huggingface.co/datasets/karpathy/tinystories-gpt4-clean/resolve/{revision}/tinystories_gpt4_clean.parquet"])

        namespace, _, fake = self.load(revision, "f" * 64)
        with tempfile.TemporaryDirectory() as tmp, patch.dict("sys.modules", {"requests": fake}):
            dest = Path(tmp) / "data.parquet"
            with self.assertRaises(RuntimeError):
                namespace["_download_parquet"](dest)
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_suffix(".part").exists())


if __name__ == "__main__":
    unittest.main()
