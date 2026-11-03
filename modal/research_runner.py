# Observable Lab — research training runner (Modal)
#
# Runs one fixed-budget training experiment on a dedicated GPU and returns the
# measured result. The contract mirrors karpathy/autoresearch:
#
#   * Trusted preparation runs before generated code, in the controller.
#   * Each train.py runs in a fresh Modal Sandbox: no secrets, no network,
#     a read-only data Volume, and a bounded lifetime. It cannot write back
#     into the controller or the shared dataset.
#   * RESULT remains a self-reported metric. The sandbox protects execution;
#     it does not independently validate a model or its reported score.
#   * TIME_BUDGET is enforced twice: train.py's own wall-clock check, and a
#     hard stop here at budget + TRAIN_GRACE_S (startup, compile, evaluation).
#     A run that hits the hard stop, or reports more training time than the
#     budget allows, is returned as a crash at stage "budget", never as a score.
#
# Deploy:  modal deploy modal/research_runner.py
# Secrets: modal secret create oblab-runner-auth RUNNER_TOKEN=<random>
# Data:    trusted preparation populates a new persistent read-only training dataset.
#
# HTTP API (for the Vercel backend):
#   Authorization: Bearer <RUNNER_TOKEN> on both endpoints
#   POST /start   {train_py, budget_s?, smoke?} -> {call_id}
#   GET  /status  ?call_id=...                 -> {status} | {status, result}
#
# Training takes ~6-9 min wall clock (budget + startup + eval), longer than a
# Vercel function may wait — hence spawn + poll instead of a sync call.

import json
import os
import subprocess
import sys
import time
import hmac
import math
import hashlib

import modal
from fastapi import HTTPException, Request

APP_NAME = "oblab-research-runner"
GPU_KIND = os.environ.get("OBLAB_RUNNER_GPU", "A10G")  # fixed per deployment: comparability
DEFAULT_BUDGET_S = 300.0
MAX_BUDGET_S = 600.0
# Time allowed beyond the training budget for interpreter start, model build,
# compilation and the final evaluation. Kept small on purpose: a generated
# train.py that ignores the budget is stopped instead of running for minutes.
# A constant (not an environment variable) because it is read inside the Modal
# container; change it here and redeploy. Keep it at or below 300 s, which the
# controller timeout below allows for.
TRAIN_GRACE_S = 120
# Self-reported train_seconds may overshoot the budget by one optimiser step.
REPORTED_TRAIN_TOLERANCE_S = 10.0
PREPARE_TIMEOUT_S = 600
# Controller lifetime: prepare + the longest allowed run + grace + sandbox
# setup and teardown. Must exceed the sum, or a valid run surfaces as infra_error.
HARD_TIMEOUT_S = int(PREPARE_TIMEOUT_S + MAX_BUDGET_S + 300 + 180)

app = modal.App(APP_NAME)

here = os.path.dirname(os.path.abspath(__file__))
prepare_path = os.path.join(here, "harness", "prepare.py")
# Modal imports this module under /root in deployed containers. The reviewed
# harness is baked into the image under /harness rather than next to the module.
if not os.path.isfile(prepare_path) and os.path.isfile("/harness/prepare.py"):
    prepare_path = "/harness/prepare.py"

# Images are pinned so a redeploy builds the same environment: the base by
# digest (official python:3.11.18-slim-bookworm multi-arch index, resolved
# 2026-11-02) and every package by exact version. Change these deliberately
# and record the change; the GPU results are only comparable within one image.
PYTHON_BASE_IMAGE = "python:3.11.18-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd"

image = (
    modal.Image.from_registry(PYTHON_BASE_IMAGE)
    .pip_install("numpy==2.4.6", "requests==2.34.2", "pyarrow==26.0.0")
    .pip_install("torch==2.6.0", index_url="https://download.pytorch.org/whl/cu124")
    # Modal imports this whole module in the controller as well as the endpoints.
    .pip_install("fastapi==0.162.0")
    .add_local_file(prepare_path, "/harness/prepare.py", copy=True)
)

cache = modal.Volume.from_name("oblab-research-data-v2", create_if_missing=True)

# Endpoint functions need fastapi; keep their image tiny (no torch).
web_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install("fastapi[standard]==0.162.0")


@app.function(
    image=image,
    timeout=HARD_TIMEOUT_S,
    volumes={"/cache": cache},
    retries=0,
    max_containers=1,
    cpu=(2, 4),
    memory=(4096, 8192),
)
def run_experiment(train_py: str, budget_s: float = DEFAULT_BUDGET_S, smoke: bool = False) -> dict:
    """Run one experiment; returns a structured result, never raises for
    experiment-level failures (crash IS a result the reviewer needs)."""
    t0 = time.time()
    workdir = "/work"
    os.makedirs(workdir, exist_ok=True)

    # Only the reviewed harness runs in this credential-bearing controller.
    # Use a new cache namespace so old writable experiment caches are not reused.
    env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
           "HOME": "/tmp", "RESEARCH_CACHE": "/cache/smoke" if smoke else "/cache/research",
           "TIME_BUDGET_S": str(20 if smoke else budget_s)}
    prep_cmd = [sys.executable, "/harness/prepare.py"] + (["--smoke"] if smoke else [])
    try:
        prep = subprocess.run(prep_cmd, cwd=workdir, env=env, timeout=PREPARE_TIMEOUT_S,
                              capture_output=True, text=True)
    except subprocess.TimeoutExpired:
        return {"status": "infra_error", "stage": "prepare", "error": "prepare timed out"}
    if prep.returncode != 0:
        return {"status": "infra_error", "stage": "prepare",
                "error": (prep.stderr or prep.stdout)[-2000:]}
    cache.commit()
    with open("/harness/prepare.py", "rb") as f:
        harness_sha256 = hashlib.sha256(f.read()).hexdigest()

    # Hard stop for train.py itself; the Sandbox lives a little longer so the
    # log can still be read after the process is stopped.
    train_timeout = 180 if smoke else int(budget_s + TRAIN_GRACE_S)
    train_seconds_wall = None
    sb = None
    try:
        sb = modal.Sandbox.create(
            app=app, image=image, gpu=None if smoke else GPU_KIND, timeout=train_timeout + 60,
            cpu=(2, 4), memory=(8192, 32768), block_network=True, secrets=[],
            env={"RESEARCH_CACHE": env["RESEARCH_CACHE"], "TIME_BUDGET_S": env["TIME_BUDGET_S"]},
            volumes={"/cache": cache.read_only()}, workdir="/tmp",
        )
        sb.filesystem.write_text(train_py, "/tmp/train.py")
        # The copy is for the existing train.py import contract. It is disposable
        # and must not be mistaken for an independently protected evaluator.
        setup = sb.exec("cp", "/harness/prepare.py", "/tmp/prepare.py", timeout=30)
        setup.wait()
        if setup.returncode != 0:
            raise RuntimeError("Sandbox harness setup failed")
        # Keep output out of the controller's unbounded PIPE buffers. The hard
        # file limit is inherited by train.py; the controller reads only a tail.
        supervisor = """import resource, subprocess, sys
resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
with open('/tmp/train.log', 'wb') as out:
    p = subprocess.run([sys.executable, '/tmp/train.py'] + sys.argv[1:], stdout=out, stderr=out)
sys.exit(p.returncode)
"""
        t_train = time.time()
        proc = sb.exec("python", "-c", supervisor, *(["--smoke"] if smoke else []),
                       timeout=train_timeout)
        proc.wait()
        train_seconds_wall = time.time() - t_train
        # Generated code can replace the log path. Refuse symlinks/devices and
        # read at most 64 KiB from one verified file descriptor inside the sandbox.
        log_reader = """import os, stat, sys
fd = os.open('/tmp/train.log', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError('train log is not a regular file')
    os.lseek(fd, max(0, info.st_size - 65536), os.SEEK_SET)
    sys.stdout.buffer.write(os.read(fd, 65536))
finally:
    os.close(fd)
"""
        log = sb.exec("python", "-I", "-c", log_reader, timeout=10, text=False)
        raw_log = log.stdout.read()
        log.wait()
        if log.returncode != 0:
            raise RuntimeError("Could not safely read the experiment log")
        stdout = raw_log.decode("utf-8", errors="replace")[-65536:]
        log_tail = "\n".join(stdout.splitlines()[-40:])[-4000:]
        if train_seconds_wall >= train_timeout - 1:
            return {"status": "crash", "stage": "budget",
                    "error": f"train.py was stopped at the hard limit of {train_timeout} s "
                             f"(budget {budget_s:g} s + {TRAIN_GRACE_S} s grace)",
                    "log_tail": log_tail, "train_wall_seconds": train_seconds_wall,
                    "wall_seconds": time.time() - t0}
        if proc.returncode != 0:
            return {"status": "crash", "stage": "train", "error": log_tail[-2500:],
                    "log_tail": log_tail, "wall_seconds": time.time() - t0}
    except Exception as exc:
        return {"status": "crash", "stage": "sandbox", "error": str(exc)[-1500:],
                "wall_seconds": time.time() - t0}
    finally:
        if sb is not None:
            sb.terminate()

    # 3) parse the single RESULT line contract
    result_line = None
    for line in reversed(stdout.splitlines()):
        if line.startswith("RESULT "):
            result_line = line[len("RESULT "):]
            break
    if result_line is None:
        return {
            "status": "crash", "stage": "parse",
            "error": "no RESULT line in output — train.py broke the output contract",
            "log_tail": log_tail,
            "wall_seconds": time.time() - t0,
        }
    try:
        metrics = json.loads(result_line)
        val_bpb = float(metrics["val_bpb"])
        if not math.isfinite(val_bpb) or val_bpb < 0:
            raise ValueError(f"non-finite val_bpb: {val_bpb}")
        reported_train_s = metrics.get("train_seconds")
    except Exception as e:
        return {
            "status": "crash", "stage": "parse",
            "error": f"RESULT line invalid: {e}",
            "log_tail": log_tail,
            "wall_seconds": time.time() - t0,
        }

    # The score is self-reported; at least refuse runs that say they trained
    # longer than the budget allowed (one optimiser step of overshoot is fine).
    limit_s = (20 if smoke else budget_s) + REPORTED_TRAIN_TOLERANCE_S
    if isinstance(reported_train_s, (int, float)) and not isinstance(reported_train_s, bool) \
            and (not math.isfinite(reported_train_s) or reported_train_s > limit_s):
        return {
            "status": "crash", "stage": "budget",
            "error": f"reported train_seconds {reported_train_s} exceeds the {budget_s:g} s budget",
            "log_tail": log_tail, "train_wall_seconds": train_seconds_wall,
            "wall_seconds": time.time() - t0,
        }

    return {
        "status": "ok",
        "metrics": metrics,
        "metrics_source": "experiment_stdout_unverified",
        "dataset": "synthetic_smoke" if smoke else "tinystories_gpt4_clean",
        "harness_sha256": harness_sha256,
        "budget_s": 20 if smoke else budget_s,
        "train_wall_seconds": train_seconds_wall,
        "gpu": "cpu-smoke" if smoke else GPU_KIND,
        "log_tail": log_tail,
        "wall_seconds": time.time() - t0,
    }


# ---------------------------------------------------------------------------
# HTTP surface for the Vercel backend: spawn + poll (runs outlast HTTP limits)
# ---------------------------------------------------------------------------

def _authed(token: str) -> bool:
    expected = os.environ.get("RUNNER_TOKEN", "")
    return len(expected.encode()) >= 32 and hmac.compare_digest(token.encode(), f"Bearer {expected}".encode())


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-runner-auth")])
@modal.fastapi_endpoint(method="POST")
def start(body: dict, request: Request) -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    train_py = body.get("train_py")
    if not isinstance(train_py, str) or len(train_py) < 100 or len(train_py) > 400_000:
        raise HTTPException(status_code=400, detail="train_py missing or implausible size")
    try:
        budget_s = float(body.get("budget_s", DEFAULT_BUDGET_S))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid budget_s")
    if not math.isfinite(budget_s) or not 30 <= budget_s <= MAX_BUDGET_S:
        raise HTTPException(status_code=400, detail="budget_s must be between 30 and 600 seconds")
    call = run_experiment.spawn(
        train_py,
        budget_s,
        bool(body.get("smoke", False)),
    )
    return {"call_id": call.object_id}


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-runner-auth")])
@modal.fastapi_endpoint(method="GET")
def status(request: Request, call_id: str = "") -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not call_id:
        return {"error": "call_id required"}
    fc = modal.FunctionCall.from_id(call_id)
    try:
        result = fc.get(timeout=0)
        return {"status": "done", "result": result}
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:
        return {"status": "failed", "error": str(e)[-1500:]}

