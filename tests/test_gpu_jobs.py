"""GPU jobs the models choose (modal/gpu_jobs.py), tested without Modal.

Only the function definitions are loaded, with fake Sandbox objects; no GPU,
network or provider is contacted. Run: python -m unittest discover -s tests
"""
import ast
import hmac
import os
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "modal" / "gpu_jobs.py").read_text()
TOKEN = "test-only-jobs-token-000000000000000000"


def functions(names, namespace):
    tree = ast.parse(SOURCE)
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            selected.append(node)
    assert len(selected) == len(names)
    exec(compile(ast.Module(body=selected, type_ignores=[]), "modal/gpu_jobs.py", "exec"), namespace)
    return namespace


def constant(name):
    for node in ast.parse(SOURCE).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(name)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now


class GpuJobSandboxTests(unittest.TestCase):
    def run_job(self, script="print('hello from the gpu')\n", runs_for=3.0, returncode=0, log=b"hello from the gpu\n"):
        clock = Clock()
        created = []

        class Sandbox:
            terminated = False
            writes = {}
            commands = []

            @property
            def filesystem(self):
                return SimpleNamespace(write_text=lambda data, path: self.writes.__setitem__(path, data))

            def exec(self, *args, **kwargs):
                self.commands.append((args, kwargs))
                is_job = args[:2] == ("python", "-c")

                def wait():
                    if is_job:
                        clock.now += min(runs_for, kwargs["timeout"])
                return SimpleNamespace(wait=wait, returncode=returncode if is_job else 0,
                                       stdout=SimpleNamespace(read=lambda: log))

            def terminate(self):
                self.terminated = True

        sb = Sandbox()

        def create(**kwargs):
            created.append(kwargs)
            return sb

        namespace = functions({"run_job", "_check_script"}, {
            "time": clock, "modal": SimpleNamespace(Sandbox=SimpleNamespace(create=create)),
            "app": "test-app", "image": "pinned-image", "GPU_KIND": "test-gpu",
            "JOB_TIMEOUT_S": constant("JOB_TIMEOUT_S"), "MAX_SCRIPT_CHARS": constant("MAX_SCRIPT_CHARS"),
            "SUPERVISOR": "supervisor", "LOG_READER": "reader",
        })
        result = namespace["run_job"](script)
        return result, created, sb

    def test_hard_limit_is_120_seconds(self):
        self.assertEqual(constant("JOB_TIMEOUT_S"), 120)

    def test_job_runs_in_a_sealed_sandbox_and_is_terminated(self):
        result, created, sb = self.run_job()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("hello from the gpu", result["log_tail"])
        self.assertEqual(len(created), 1)
        self.assertIs(created[0]["block_network"], True)
        self.assertEqual(created[0]["secrets"], [])
        self.assertNotIn("volumes", created[0])
        self.assertEqual(created[0]["gpu"], "test-gpu")
        self.assertEqual(created[0]["timeout"], 120 + 60)
        self.assertEqual(set(created[0]["env"]), {"PYTHONUNBUFFERED"})
        job_calls = [kw for args, kw in sb.commands if args[:2] == ("python", "-c")]
        self.assertEqual(job_calls[0]["timeout"], 120)
        self.assertEqual(sb.writes["/tmp/job.py"], "print('hello from the gpu')\n")
        self.assertTrue(sb.terminated)

    def test_syntax_error_never_starts_a_gpu(self):
        result, created, _ = self.run_job(script="def f(:\n    pass\n")
        self.assertEqual((result["status"], result["stage"]), ("crash", "syntax"))
        self.assertIn("SyntaxError", result["error"])
        self.assertEqual(created, [])

    def test_check_never_runs_the_script(self):
        check = functions({"_check_script"}, {})["_check_script"]
        self.assertIsNone(check("raise SystemExit('must not run')\n"))
        self.assertIsInstance(check("return 1\n"), str)

    def test_a_job_that_hits_the_limit_is_a_timeout(self):
        result, _, sb = self.run_job(runs_for=10_000, returncode=124)
        self.assertEqual(result["status"], "timeout")
        self.assertTrue(sb.terminated)

    def test_a_failing_script_reports_its_exit_code(self):
        result, _, _ = self.run_job(returncode=3, log=b"Traceback: boom\n")
        self.assertEqual((result["status"], result["exit_code"]), ("error", 3))

    def test_oversized_or_empty_scripts_are_refused_before_anything_starts(self):
        for script in ["", "   ", "x" * (constant("MAX_SCRIPT_CHARS") + 1), None]:
            result, created, _ = self.run_job(script=script)
            self.assertEqual(result["stage"], "input")
            self.assertEqual(created, [])

    def test_image_uses_the_research_runner_pins(self):
        runner = (ROOT / "modal" / "research_runner.py").read_text()
        for pin in ['torch==2.6.0', 'numpy==2.4.6', 'fastapi[standard]==0.162.0']:
            self.assertIn(pin, runner)
            self.assertIn(pin, SOURCE)
        base = constant("PYTHON_BASE_IMAGE")
        self.assertIn(base, runner)


class GpuJobEndpointTests(unittest.TestCase):
    def test_bearer_token_is_required_and_never_read_from_the_body_or_url(self):
        calls = []

        def spawn(script):
            calls.append(script)
            return SimpleNamespace(object_id="test-call")

        namespace = functions({"_authed", "start", "status"}, {
            "os": os, "hmac": hmac, "Request": Request, "HTTPException": HTTPException,
            "MAX_SCRIPT_CHARS": 20000, "run_job": SimpleNamespace(spawn=spawn),
            "OutputExpiredError": type("Expired", (Exception,), {}),
            "modal": SimpleNamespace(FunctionCall=SimpleNamespace(
                from_id=lambda call_id: SimpleNamespace(get=lambda timeout: (_ for _ in ()).throw(TimeoutError())))),
        })
        app = FastAPI()
        app.add_api_route("/start", namespace["start"], methods=["POST"])
        app.add_api_route("/status", namespace["status"], methods=["GET"])
        auth = {"Authorization": "Bearer " + TOKEN}
        with TestClient(app) as client, patch.dict(os.environ, {"JOBS_TOKEN": TOKEN}):
            self.assertEqual(client.post("/start", json={"script": "print(1)", "token": TOKEN}).status_code, 401)
            self.assertEqual(client.get("/status", params={"call_id": "x", "token": TOKEN}).status_code, 401)
            self.assertEqual(client.post("/start", headers=auth, json={"script": ""}).status_code, 400)
            self.assertEqual(client.post("/start", headers=auth, json={"script": "x" * 20001}).status_code, 400)
            self.assertEqual(calls, [])
            ok = client.post("/start", headers=auth, json={"script": "print(1)"})
            self.assertEqual(ok.json(), {"call_id": "test-call"})
            self.assertEqual(calls, ["print(1)"])
            self.assertEqual(client.get("/status", headers=auth, params={"call_id": "test-call"}).json(), {"status": "running"})
        with TestClient(app) as client, patch.dict(os.environ, {"JOBS_TOKEN": "short"}):
            self.assertEqual(client.post("/start", headers={"Authorization": "Bearer short"}, json={"script": "print(1)"}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
