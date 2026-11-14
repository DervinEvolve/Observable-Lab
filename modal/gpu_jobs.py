# Observable Lab: short GPU jobs the models choose (Modal)
#
# A model may ask for one short Python script to run on a GPU during an epoch
# (docs/TOOLS.md, "GPU jobs"). This app runs it under the same rules as the
# research runner (modal/research_runner.py):
#
#   * The script must compile under the runner's own Python before anything
#     else happens. A syntax error comes back at stage "syntax" and no GPU is
#     started.
#   * The script runs in a fresh Modal Sandbox: network blocked, no secrets,
#     no volumes, CPU and memory limits, and a hard time limit of 120 s
#     (JOB_TIMEOUT_S). The sandbox is always terminated afterwards.
#   * Output goes to a size-limited file inside the sandbox, and only its last
#     64 KiB is read back, from one verified regular file.
#   * Whatever the script prints is self-reported. The lab stores it as the
#     job's output and nothing more.
#
# Deploy:  modal deploy modal/gpu_jobs.py
# Secret:  modal secret create oblab-gpu-jobs-auth JOBS_TOKEN=<random, 32+ chars>
#          (the same value goes in the lab server's GPU_JOBS_TOKEN)
#
# HTTP API (for the Vercel backend), Authorization: Bearer <JOBS_TOKEN> on both:
#   POST /start   {script}       -> {call_id}
#   GET  /status  ?call_id=...   -> {status: running} | {status: done, result} | {status: failed, error}
#
# result: {status: ok|error|timeout|crash, stage?, exit_code, log_tail,
#          run_seconds, wall_seconds, gpu}

import hmac
import os
import time

import modal
from fastapi import HTTPException, Request
from modal.exception import OutputExpiredError

APP_NAME = "oblab-gpu-jobs"
GPU_KIND = os.environ.get("OBLAB_JOBS_GPU", "A10G")
# Hard limit for the model's script. A constant, read inside the container;
# change it here and redeploy (the lab server assumes 120 s for its estimate).
JOB_TIMEOUT_S = 120
MAX_SCRIPT_CHARS = 20_000
LOG_LIMIT_BYTES = 4 * 1024 * 1024

app = modal.App(APP_NAME)

# Same pinned base and packages as the research runner's training image, so a
# job sees the same Python and torch the research loop uses.
PYTHON_BASE_IMAGE = "python:3.11.18-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd"

image = (
    modal.Image.from_registry(PYTHON_BASE_IMAGE)
    .apt_install("gcc=4:12.2.0-3", "g++=4:12.2.0-3", "libc6-dev")
    .pip_install("numpy==2.4.6")
    .pip_install("torch==2.6.0", index_url="https://download.pytorch.org/whl/cu124")
)

web_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install("fastapi[standard]==0.162.0")


def _check_script(source: str):
    """None when the script compiles, else a short reason. Never runs it."""
    try:
        compile(source, "job.py", "exec", dont_inherit=True)
    except SyntaxError as exc:
        where = f"line {exc.lineno}" if exc.lineno else "unknown line"
        if exc.offset:
            where += f", column {exc.offset}"
        text = (exc.text or "").strip()[:200]
        return f"{type(exc).__name__}: {exc.msg} ({where})" + (f": {text}" if text else "")
    except (ValueError, RecursionError, MemoryError, OverflowError) as exc:
        return f"{type(exc).__name__}: {str(exc)[:300]}"
    return None


SUPERVISOR = """import resource, subprocess, sys
resource.setrlimit(resource.RLIMIT_FSIZE, (%d, %d))
with open('/tmp/job.log', 'wb') as out:
    p = subprocess.run([sys.executable, '/tmp/job.py'], stdout=out, stderr=out)
sys.exit(p.returncode)
""" % (LOG_LIMIT_BYTES, LOG_LIMIT_BYTES)

LOG_READER = """import os, stat, sys
fd = os.open('/tmp/job.log', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError('job log is not a regular file')
    os.lseek(fd, max(0, info.st_size - 65536), os.SEEK_SET)
    sys.stdout.buffer.write(os.read(fd, 65536))
finally:
    os.close(fd)
"""


@app.function(image=image, timeout=JOB_TIMEOUT_S + 180, retries=0, max_containers=2, cpu=(1, 2), memory=(1024, 4096))
def run_job(script: str) -> dict:
    """Run one job. Returns a result for every outcome; never raises for job failures."""
    t0 = time.time()
    if not isinstance(script, str) or not script.strip() or len(script) > MAX_SCRIPT_CHARS:
        return {"status": "error", "stage": "input", "error": "script missing or too long",
                "exit_code": None, "log_tail": "", "wall_seconds": time.time() - t0, "gpu": None}
    syntax_error = _check_script(script)
    if syntax_error is not None:
        return {"status": "crash", "stage": "syntax",
                "error": f"the script does not compile; no GPU was started. {syntax_error}",
                "exit_code": None, "log_tail": syntax_error, "wall_seconds": time.time() - t0, "gpu": None}

    sb = None
    run_seconds = None
    try:
        sb = modal.Sandbox.create(
            app=app, image=image, gpu=GPU_KIND, timeout=JOB_TIMEOUT_S + 60,
            cpu=(2, 4), memory=(4096, 16384), block_network=True, secrets=[],
            env={"PYTHONUNBUFFERED": "1"}, workdir="/tmp",
        )
        sb.filesystem.write_text(script, "/tmp/job.py")
        t_run = time.time()
        proc = sb.exec("python", "-c", SUPERVISOR, timeout=JOB_TIMEOUT_S)
        proc.wait()
        run_seconds = time.time() - t_run
        log = sb.exec("python", "-I", "-c", LOG_READER, timeout=10, text=False)
        raw = log.stdout.read()
        log.wait()
        if log.returncode != 0:
            raise RuntimeError("could not safely read the job log")
        text = raw.decode("utf-8", errors="replace")
        log_tail = "\n".join(text.splitlines()[-60:])[-4000:]
        if run_seconds >= JOB_TIMEOUT_S - 1:
            return {"status": "timeout", "stage": "run", "exit_code": proc.returncode,
                    "error": f"stopped at the hard limit of {JOB_TIMEOUT_S} s",
                    "log_tail": log_tail, "run_seconds": run_seconds,
                    "wall_seconds": time.time() - t0, "gpu": GPU_KIND}
        return {"status": "ok" if proc.returncode == 0 else "error", "stage": "run",
                "exit_code": proc.returncode, "log_tail": log_tail, "run_seconds": run_seconds,
                "wall_seconds": time.time() - t0, "gpu": GPU_KIND}
    except Exception as exc:
        return {"status": "crash", "stage": "sandbox", "error": str(exc)[-1500:], "exit_code": None,
                "log_tail": "", "run_seconds": run_seconds, "wall_seconds": time.time() - t0, "gpu": GPU_KIND}
    finally:
        if sb is not None:
            sb.terminate()


def _authed(token: str) -> bool:
    expected = os.environ.get("JOBS_TOKEN", "")
    return len(expected.encode()) >= 32 and hmac.compare_digest(token.encode(), f"Bearer {expected}".encode())


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-gpu-jobs-auth")])
@modal.fastapi_endpoint(method="POST")
def start(body: dict, request: Request) -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    script = body.get("script") if isinstance(body, dict) else None
    if not isinstance(script, str) or not script.strip() or len(script) > MAX_SCRIPT_CHARS:
        raise HTTPException(status_code=400, detail="script missing or too long")
    call = run_job.spawn(script)
    return {"call_id": call.object_id}


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-gpu-jobs-auth")])
@modal.fastapi_endpoint(method="GET")
def status(request: Request, call_id: str = "") -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not call_id:
        return {"error": "call_id required"}
    fc = modal.FunctionCall.from_id(call_id)
    try:
        return {"status": "done", "result": fc.get(timeout=0)}
    except OutputExpiredError:
        return {"status": "failed", "error": "job result expired before it was collected"}
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:
        return {"status": "failed", "error": str(e)[-1500:]}
