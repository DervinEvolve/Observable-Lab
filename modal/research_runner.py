# Observable Lab — research training runner (Modal)
#
# Runs one fixed-budget training experiment on a dedicated GPU and returns the
# measured result. The contract mirrors karpathy/autoresearch:
#
#   * Before anything else, train.py must compile under the runner's own
#     Python. A syntax error comes back as a crash at stage "syntax" without
#     preparing data or starting a GPU (run 1 spent epoch 20 on one).
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
#   POST /models {action: "info" | "promote" | "sample", ...}   (see below)
#
# Training takes ~6-9 min wall clock (budget + startup + eval), longer than a
# Vercel function may wait — hence spawn + poll instead of a sync call.
#
# Keeping a model so visitors can ask it for a story (off unless the lab sends
# keep_key with /start, which it does only with LAB_ENABLE_RESEARCH_TALK=true):
#
#   * train.py saves nothing itself, and its model is usually a local variable
#     that is gone when the script ends. The one place reviewed code sees the
#     model is prepare.evaluate_bpb. For a run that may be kept, the sandbox's
#     disposable copy of prepare.py gets a fixed block appended (KEEP_HOOK): it
#     remembers the last model evaluate_bpb scored and, when the interpreter
#     exits, writes torch.save(model) next to the log in 4 MiB parts. The
#     reviewed harness file, its hash, the image, the way train.py is started,
#     its limits and the hard stop are the same as without it.
#   * That save runs in the same process as the generated code, so the saved
#     file is as self-reported as the score. The controller copies it out
#     through a bounded reader and stores it, with the train.py that made it
#     and a manifest, on the Volume oblab-research-models as a candidate.
#   * The lab promotes a candidate when the Reviewer keeps the run. Only then
#     is it sampled, and only in a fresh Sandbox with no network, no secrets,
#     CPU only, and that one model directory mounted read-only. Loading the
#     model means running model-written code (train.py's definitions and a
#     pickle), which is why it never happens anywhere else.
#   * Run a training and keep its model by hand (the owner, to have a model
#     to talk to before the loop next improves):
#       modal run modal/research_runner.py::keep_current --train-py /path/to/train.py

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
import hmac
import math
import hashlib

import modal
from fastapi import HTTPException, Request
from modal.exception import OutputExpiredError

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
# The last 300 s are for copying a kept model out of the sandbox (KEEP_COLLECT_S
# and the write to the Volume). A run that keeps nothing never uses them.
HARD_TIMEOUT_S = int(PREPARE_TIMEOUT_S + MAX_BUDGET_S + 300 + 180 + 300)

# --- keeping a model, and asking it for a story -----------------------------
MODELS_VOLUME_NAME = "oblab-research-models"
MODELS_ROOT = "/research-models"   # the Volume, in the controller and the store function
MODEL_MOUNT = "/model"             # one kept model, read-only, in a sampling sandbox
KEEP_DIR = "/tmp/oblab-keep"       # where the save step writes, inside the training sandbox
KEEP_PART_BYTES = 4 * 1024 * 1024  # under the 8 MiB file limit train.py runs with
KEEP_MAX_BYTES = 256 * 1024 * 1024 # a saved model larger than this is not kept
KEEP_READ_PARTS = 8                # parts copied out per reader call (32 MiB)
KEEP_COLLECT_S = 240               # extra sandbox lifetime for copying the parts out
KEEP_CUT_BEFORE_LIMIT_S = 2        # the save step is cut this long before train.py's hard stop
KEPT_MAX = 3                       # promoted models kept on the Volume
CANDIDATES_MAX = 3                 # unpromoted saves kept on the Volume
CANDIDATE_TTL_S = 3 * 24 * 3600
KEY_PATTERN = r"(?:e[0-9]{1,6}|owner|smoke)-[0-9a-f]{8}"
PROMPT_MAX_CHARS = 200
DEFAULT_PROMPT = "Once upon a time"
SAMPLE_DEFAULT_NEW = 200           # new bytes (the model's tokens are single bytes)
SAMPLE_HARD_NEW = 500
SAMPLE_CHECK_NEW = 64
SAMPLE_GENERATE_S = 40             # the sampler stops writing after this long
SAMPLE_EXEC_S = 60                 # loading and writing together, inside the sandbox
SAMPLE_SANDBOX_S = 120
SAMPLE_FN_TIMEOUT_S = 180
SAMPLE_TEMPERATURE = 0.8
SAMPLE_TOP_K = 40

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

# Compilers: torch.compile hands GPU kernels to Triton, which builds a small C
# launcher with the system C compiler on first use, and on CPU (the --smoke
# check) Inductor needs a C++ compiler. The slim base has neither, so every
# compiled train.py crashed at its first forward pass (run 1, epochs 21
# onwards). gcc and g++ are the bookworm meta packages, fixed at 4:12.2.0-3 for
# the whole release; libc6-dev has to match the base image's libc6 exactly, so
# apt picks it. Adding these changed the image: results from before and after
# are not comparable, which is why run 2 starts from a fresh baseline run.
image = (
    modal.Image.from_registry(PYTHON_BASE_IMAGE)
    .apt_install("gcc=4:12.2.0-3", "g++=4:12.2.0-3", "libc6-dev")
    .pip_install("numpy==2.4.6", "requests==2.34.2", "pyarrow==26.0.0")
    .pip_install("torch==2.6.0", index_url="https://download.pytorch.org/whl/cu124")
    # Modal imports this whole module in the controller as well as the endpoints.
    .pip_install("fastapi==0.162.0")
    .add_local_file(prepare_path, "/harness/prepare.py", copy=True)
)

cache = modal.Volume.from_name("oblab-research-data-v2", create_if_missing=True)
# Saved models (see "Keeping a model" above). The training sandbox never gets
# this Volume; a sampling sandbox gets one kept model's directory, read-only.
model_store = modal.Volume.from_name(MODELS_VOLUME_NAME, create_if_missing=True)

# Endpoint functions need fastapi; keep their image tiny (no torch).
web_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install("fastapi[standard]==0.162.0")


def _check_train_py(source: str):
    """None when train.py compiles, else a short reason.

    compile() parses and builds bytecode without running anything, so this is
    safe on generated code. It runs in the controller, which uses the same
    image (and so the same Python) as the training sandbox.
    """
    try:
        compile(source, "train.py", "exec", dont_inherit=True)
    except SyntaxError as exc:  # also IndentationError and TabError
        where = f"line {exc.lineno}" if exc.lineno else "unknown line"
        if exc.offset:
            where += f", column {exc.offset}"
        text = (exc.text or "").strip()[:200]
        return f"{type(exc).__name__}: {exc.msg} ({where})" + (f": {text}" if text else "")
    except (ValueError, RecursionError, MemoryError, OverflowError) as exc:
        # null bytes, nesting too deep for the parser, and similar
        return f"{type(exc).__name__}: {str(exc)[:300]}"
    return None


# ---------------------------------------------------------------------------
# Keeping a model. The four scripts below are fixed text written by the
# controller into a sandbox; none of them takes anything from generated code.
# The plain functions after them have the sandbox and the Volume passed in, so
# tests/test_research_talk.py runs all of them without Modal.
# ---------------------------------------------------------------------------

# Appended to the sandbox's disposable copy of prepare.py, and only for a run
# that may be kept. It changes nothing train.py can measure: evaluate_bpb
# returns what it returned before, and the one thing held on to is a reference
# to the last model it scored (so that model is not freed before the exit).
KEEP_HOOK = r'''


# ---------------------------------------------------------------------------
# Appended by the research runner to this disposable copy only, for a run whose
# model may be kept. The reviewed file above is unchanged. This remembers the
# last model evaluate_bpb scored and, when the interpreter exits, writes that
# model next to the log in small parts. It prints nothing and never raises.
# ---------------------------------------------------------------------------
def _oblab_keep_install():
    import atexit, functools, hashlib, io, json, multiprocessing, os, time, warnings

    owner = os.getpid()
    keep_dir = "__KEEP_DIR__"
    part_bytes = __PART_BYTES__
    max_bytes = __MAX_BYTES__
    seen = {"model": None, "calls": 0, "bpb": None, "seq_len": None}
    scored = evaluate_bpb

    @functools.wraps(scored)
    def evaluate_bpb_keeping(model, *args, **kwargs):
        value = scored(model, *args, **kwargs)
        try:
            seen["model"] = model
            seen["calls"] += 1
            seen["bpb"] = float(value)
            seen["seq_len"] = int(kwargs.get("seq_len", args[2] if len(args) > 2 else MAX_SEQ_LEN))
        except Exception:
            pass
        return value

    globals()["evaluate_bpb"] = evaluate_bpb_keeping

    def write(name, data):
        with open(os.path.join(keep_dir, name), "wb") as f:
            f.write(data)

    def save():
        # Only the process that runs train.py saves. A worker process (a data
        # loader's, say) that was forked from it, or that imported this module
        # again, must not write the marker or anything else.
        if os.getpid() != owner or multiprocessing.parent_process() is not None:
            return
        status = {"saved": False}
        started = time.time()
        try:
            os.makedirs(keep_dir, exist_ok=True)
            # Tells the supervisor that train.py itself is over and what
            # follows is the save step.
            write("train-done", b"")
            model = seen["model"]
            if model is None:
                status["reason"] = "prepare.evaluate_bpb was never called, so there was no model to save"
                return
            import torch
            module = getattr(model, "_orig_mod", model)
            if not isinstance(module, torch.nn.Module):
                status["reason"] = "what evaluate_bpb scored is not a torch module"
                return
            params = sum(p.numel() for p in module.parameters())
            tensors = list(module.parameters()) + list(module.buffers())
            size = sum(t.numel() * t.element_size() for t in tensors)
            if size > max_bytes:
                status["reason"] = "the model's tensors take %d bytes, more than the %d that are kept" % (size, max_bytes)
                return
            buf = io.BytesIO()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                torch.save(module, buf)
            data = buf.getbuffer()
            if len(data) > max_bytes:
                status["reason"] = "the saved model is %d bytes, more than the %d that are kept" % (len(data), max_bytes)
                return
            digest = hashlib.sha256(data).hexdigest()
            parts = 0
            for start in range(0, len(data), part_bytes):
                write("part-%05d" % parts, data[start:start + part_bytes])
                parts += 1
            status.update(
                saved=True, bytes=len(data), parts=parts, sha256=digest, params=int(params),
                seq_len=seen["seq_len"], eval_calls=seen["calls"], eval_bpb=seen["bpb"],
                module=type(module).__name__[:80], torch=str(torch.__version__)[:40],
                save_seconds=round(time.time() - started, 3),
            )
        except BaseException as exc:
            status = {"saved": False, "reason": "the save step failed: %s: %s" % (type(exc).__name__, str(exc)[:300])}
        finally:
            try:
                write("status.json", json.dumps(status).encode("utf-8"))
            except BaseException:
                pass

    atexit.register(save)


_oblab_keep_install()
del _oblab_keep_install
'''.replace("__KEEP_DIR__", KEEP_DIR).replace("__PART_BYTES__", str(KEEP_PART_BYTES)).replace("__MAX_BYTES__", str(KEEP_MAX_BYTES))

# The supervisor of a run that may be kept. It starts train.py exactly as the
# other one does (same command, same file limit, same log). The difference is
# that it knows when train.py is over and the save step has begun (the marker
# file), so it can cut a save that is still writing shortly before the hard
# stop and still let the run count. It never stops train.py itself: a train.py
# that runs to the hard stop is stopped by the same timeout as before.
KEEP_SUPERVISOR = """import json, os, resource, subprocess, sys, time
cut_at = float(sys.argv[1])
mark = '%s/train-done'
resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
t0 = time.monotonic()
done = None
cut = False
with open('/tmp/train.log', 'wb') as out:
    p = subprocess.Popen([sys.executable, '/tmp/train.py'] + sys.argv[2:], stdout=out, stderr=out)
    while True:
        rc = p.poll()
        now = time.monotonic() - t0
        if done is None and os.path.lexists(mark):
            done = now
        if rc is not None:
            break
        if done is not None and now >= cut_at:
            p.kill()
            p.wait()
            cut = True
            break
        time.sleep(0.05)
total = time.monotonic() - t0
print('OBLAB_KEEP ' + json.dumps({'train_done_s': done, 'total_s': total, 'cut': cut, 'rc': p.returncode}))
sys.exit(0 if cut else p.returncode)
""" % KEEP_DIR

# Copies what the save step wrote out of the training sandbox. Like the log
# reader: no symlinks, regular files only, and never more than the size named.
KEEP_READER = """import os, stat, sys
base = '%s'
def read(name, limit):
    fd = os.open(os.path.join(base, name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise RuntimeError('not a regular file of the expected size')
        chunks, left = [], info.st_size
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        return b''.join(chunks)
    finally:
        os.close(fd)
if sys.argv[1] == 'status':
    sys.stdout.buffer.write(read('status.json', 4096))
else:
    first, count, limit = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    for i in range(first, first + count):
        sys.stdout.buffer.write(read('part-%%05d' %% i, limit))
""" % KEEP_DIR

# Runs inside a sampling sandbox. It loads the kept train.py's definitions
# without running its main part, unpickles the model next to them, and writes
# up to max_new bytes after the prompt. Everything it loads is model-written,
# so the controller trusts nothing it prints: it takes the bytes, keeps the
# printable ones and cuts them to length.
SAMPLER = r'''import base64, json, os, sys, time

def _oblab_sample():
    b64, js, osm, clock, system = base64, json, os, time, sys
    started = clock.time()
    real_out = osm.dup(1)
    devnull = osm.open(osm.devnull, osm.O_WRONLY)
    osm.dup2(devnull, 1)
    osm.dup2(devnull, 2)
    stage = "request"

    def finish(result):
        try:
            osm.write(real_out, ("\nOBLAB_SAMPLE " + js.dumps(result) + "\n").encode("utf-8"))
        finally:
            osm._exit(0)

    try:
        with open("/tmp/request.json", "r", encoding="utf-8") as f:
            req = js.load(f)
        model_dir = "__MODEL_MOUNT__"
        with open(osm.path.join(model_dir, "manifest.json"), "r", encoding="utf-8") as f:
            manifest = js.load(f)
        if manifest.get("key") != req["key"]:
            raise RuntimeError("that model is not there")
        prompt = list(b64.b64decode(req["prompt_b64"]))[:2048] or [10]
        max_new = max(1, min(int(req["max_new"]), __HARD_NEW__))
        window = max(8, min(int(manifest.get("seq_len") or 256), 4096))
        osm.environ["TIME_BUDGET_S"] = str(manifest.get("budget_s") or 300)
        osm.environ.setdefault("RESEARCH_CACHE", "/cache/research")

        stage = "definitions"
        system.path.insert(0, "/harness")
        system.argv = ["train.py"]
        import runpy
        defs = runpy.run_path(osm.path.join(model_dir, "train.py"), run_name="oblab_train_defs")
        main = system.modules["__main__"]
        for name, value in defs.items():
            if not name.startswith("__"):
                setattr(main, name, value)

        stage = "load"
        import torch
        # One thread: the forward passes are small, and more threads than the
        # sandbox has cores made each one many times slower when I tried it.
        torch.set_num_threads(1)
        model = torch.load(osm.path.join(model_dir, "model.pt"), map_location="cpu", weights_only=False)
        model.eval()
        loaded = clock.time()

        stage = "generate"
        allowed = torch.full((256,), float("-inf"))
        allowed[10] = 0.0
        allowed[32:127] = 0.0
        generator = torch.Generator().manual_seed(int(req["seed"]) % (2 ** 31))

        def next_scores(ids):
            idx = torch.tensor([ids], dtype=torch.long)
            try:
                out = model(idx)
            except TypeError:
                out = model(idx, idx)
            scores = out[0] if isinstance(out, (tuple, list)) else out
            if not torch.is_tensor(scores):
                out = model(idx, idx)
                scores = out[0] if isinstance(out, (tuple, list)) else out
            if not torch.is_tensor(scores) or scores.shape[-1] < 256:
                raise RuntimeError("the model gives no score for each next byte")
            scores = scores.float()
            while scores.dim() > 1:
                scores = scores[-1] if scores.dim() == 2 else scores[0]
            return scores[:256]

        ids = list(prompt)
        new = []
        stopped = "limit"
        deadline = clock.time() + float(req["seconds"])
        with torch.no_grad():
            while len(new) < max_new:
                if clock.time() > deadline:
                    stopped = "time"
                    break
                scores = next_scores(ids[-window:]) / __TEMPERATURE__ + allowed
                kth = torch.topk(scores, __TOP_K__).values[-1]
                scores[scores < kth] = float("-inf")
                probs = torch.softmax(scores, dim=-1)
                token = int(torch.multinomial(probs, 1, generator=generator))
                ids.append(token)
                new.append(token)
                # Stories in the training text are separated by an empty line.
                if len(new) >= 2 and new[-1] == 10 and new[-2] == 10:
                    stopped = "end"
                    break
        finish({"ok": True, "new_b64": b64.b64encode(bytes(new)).decode("ascii"), "stopped": stopped,
                "load_seconds": round(loaded - started, 2), "generate_seconds": round(clock.time() - loaded, 2)})
    except BaseException as exc:
        finish({"ok": False, "stage": stage, "error": "%s: %s" % (type(exc).__name__, str(exc)[:300])})

_oblab_sample()
'''.replace("__MODEL_MOUNT__", MODEL_MOUNT).replace("__HARD_NEW__", str(SAMPLE_HARD_NEW)) \
    .replace("__TEMPERATURE__", str(SAMPLE_TEMPERATURE)).replace("__TOP_K__", str(SAMPLE_TOP_K))


def valid_key(key) -> bool:
    return isinstance(key, str) and re.fullmatch(KEY_PATTERN, key) is not None


def plain(text, limit=300) -> str:
    """Printable ASCII on one line. For anything a sandbox said."""
    if not isinstance(text, str):
        return ""
    return " ".join("".join(ch if 32 <= ord(ch) <= 126 else " " for ch in text[:4 * limit]).split())[:limit]


def clean_prompt(text) -> str:
    """One line of printable ASCII, at most PROMPT_MAX_CHARS. Empty means the default opening."""
    return plain(text, PROMPT_MAX_CHARS) or DEFAULT_PROMPT


def clean_story(raw, limit) -> str:
    """The bytes a sampling sandbox returned, as text: printable ASCII and line breaks, cut to `limit` bytes."""
    if not isinstance(raw, (bytes, bytearray)):
        return ""
    return "".join(chr(b) for b in bytes(raw)[:max(0, int(limit))] if b == 10 or 32 <= b <= 126)


def keep_report(output):
    """What the keeping supervisor printed, or None when it printed nothing usable."""
    text = output.decode("utf-8", errors="replace") if isinstance(output, (bytes, bytearray)) else str(output or "")
    for line in reversed(text.splitlines()):
        if line.startswith("OBLAB_KEEP "):
            try:
                r = json.loads(line[len("OBLAB_KEEP "):])
            except ValueError:
                return None
            if not isinstance(r, dict):
                return None
            num = lambda v: float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 else None
            return {"train_done_s": num(r.get("train_done_s")), "total_s": num(r.get("total_s")), "cut": r.get("cut") is True}
    return None


def keep_status(raw) -> dict:
    """What the save step reported, with every field checked. It ran next to
    generated code, so nothing in it is taken on trust: a count is a count, a
    hash is 64 hex characters, and text is cut and made plain."""
    try:
        s = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    except (ValueError, AttributeError, TypeError):
        return {"saved": False, "reason": "the save step left no readable report (the process may have ended before it ran)"}
    if not isinstance(s, dict):
        return {"saved": False, "reason": "the save step left no readable report"}
    count = lambda v, top: v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= top else None
    if s.get("saved") is not True:
        return {"saved": False, "reason": plain(s.get("reason")) or "the save step did not save a model"}
    size, parts = count(s.get("bytes"), KEEP_MAX_BYTES), count(s.get("parts"), KEEP_MAX_BYTES // KEEP_PART_BYTES + 1)
    sha = s.get("sha256")
    if not size or not parts or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha) \
            or parts != -(-size // KEEP_PART_BYTES):
        return {"saved": False, "reason": "the save step's report does not add up"}
    bpb = s.get("eval_bpb")
    return {
        "saved": True, "bytes": size, "parts": parts, "sha256": sha,
        "params": count(s.get("params"), 10 ** 12), "seq_len": count(s.get("seq_len"), 10 ** 6),
        "eval_calls": count(s.get("eval_calls"), 10 ** 9),
        "eval_bpb": float(bpb) if isinstance(bpb, (int, float)) and not isinstance(bpb, bool) and math.isfinite(bpb) and bpb >= 0 else None,
        "module": plain(s.get("module"), 80) or None, "torch": plain(s.get("torch"), 40) or None,
    }


def collect_checkpoint(sb) -> tuple:
    """Copies a saved model out of the training sandbox. Returns (report, bytes or None)."""
    status = sb.exec("python", "-I", "-c", KEEP_READER, "status", timeout=20, text=False)
    raw = status.stdout.read()
    status.wait()
    report = keep_status(raw if status.returncode == 0 else b"")
    if not report["saved"]:
        return report, None
    pieces = []
    for first in range(0, report["parts"], KEEP_READ_PARTS):
        count = min(KEEP_READ_PARTS, report["parts"] - first)
        reader = sb.exec("python", "-I", "-c", KEEP_READER, "parts", str(first), str(count), str(KEEP_PART_BYTES),
                         timeout=120, text=False)
        piece = reader.stdout.read()
        reader.wait()
        if reader.returncode != 0 or len(piece) > count * KEEP_PART_BYTES:
            return {"saved": False, "reason": "the saved model could not be read out of the sandbox"}, None
        pieces.append(piece)
    blob = b"".join(pieces)
    if len(blob) != report["bytes"] or hashlib.sha256(blob).hexdigest() != report["sha256"]:
        return {"saved": False, "reason": "the saved model did not arrive whole"}, None
    return report, blob


def key_epoch(key):
    m = re.fullmatch(r"e([0-9]{1,6})-[0-9a-f]{8}", key)
    return int(m.group(1)) if m else None


def build_manifest(key, report, result, train_py, now) -> dict:
    """What is written beside a saved model. `result` is the run's ok result."""
    metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
    number = lambda v: float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None
    return {
        "format": 1, "key": key, "saved_at": int(now),
        "source": "epoch" if key_epoch(key) is not None else ("smoke" if key.startswith("smoke-") else "owner_rerun"),
        "epoch": key_epoch(key),
        "dataset": result.get("dataset"), "gpu": result.get("gpu"), "budget_s": number(result.get("budget_s")),
        # Printed by the generated train.py itself.
        "val_bpb": number(metrics.get("val_bpb")), "params_m": number(metrics.get("params_m")),
        "metrics_source": result.get("metrics_source"),
        # What the harness's evaluate_bpb returned for the saved model, seen
        # inside the same process as the generated code: not independent either.
        "eval_bpb_seen_by_harness": report.get("eval_bpb"), "eval_calls": report.get("eval_calls"),
        "params": report.get("params"), "seq_len": report.get("seq_len"), "module": report.get("module"),
        "torch": report.get("torch"),
        "model_bytes": report["bytes"], "model_sha256": report["sha256"],
        "train_py_sha256": hashlib.sha256(train_py.encode("utf-8")).hexdigest(),
        "harness_sha256": result.get("harness_sha256"),
        "weights_format": "torch.save of the whole module (a pickle). It loads only next to its train.py, "
                          "and both are model-written, so load it in a sandbox with no network.",
    }


def _write_file(path, data):
    with open(path, "wb") as f:
        f.write(data)


def read_manifest(directory):
    """The manifest of one saved model, or None when it is not a whole one."""
    try:
        with open(os.path.join(directory, "manifest.json"), "r", encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(m, dict) or m.get("format") != 1 or not valid_key(m.get("key")) \
            or m.get("key") != os.path.basename(directory) \
            or not os.path.isfile(os.path.join(directory, "train.py")):
        return None
    # The manifest is written last, and the model beside it must be the size
    # it names: a directory caught half written is not a model.
    try:
        if os.path.getsize(os.path.join(directory, "model.pt")) != m.get("model_bytes"):
            return None
    except OSError:
        return None
    return m


def _saved(root, area) -> list:
    """Whole saved models in one area, newest first."""
    base = os.path.join(root, area)
    found = []
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return []
    for name in names:
        if valid_key(name):
            m = read_manifest(os.path.join(base, name))
            if m is not None:
                found.append(m)
    stamp = lambda m: m.get("promoted_at") or m.get("saved_at") or 0
    return sorted(found, key=lambda m: (stamp(m) if isinstance(stamp(m), (int, float)) else 0, m["key"]), reverse=True)


def _remove(root, area, key):
    if valid_key(key) and area in ("candidates", "kept"):
        shutil.rmtree(os.path.join(root, area, key), ignore_errors=True)


def prune(root, now) -> list:
    """Keeps the newest KEPT_MAX promoted models and a few recent candidates. Returns what was removed."""
    removed = []
    for extra in _saved(root, "kept")[KEPT_MAX:]:
        _remove(root, "kept", extra["key"])
        removed.append("kept/" + extra["key"])
    for i, m in enumerate(_saved(root, "candidates")):
        age = now - (m.get("saved_at") or 0) if isinstance(m.get("saved_at"), (int, float)) else CANDIDATE_TTL_S + 1
        if i >= CANDIDATES_MAX or age > CANDIDATE_TTL_S:
            _remove(root, "candidates", m["key"])
            removed.append("candidates/" + m["key"])
    return removed


def store_candidate(root, key, train_py, blob, manifest, now) -> None:
    """Writes one saved model as a candidate. A second save under the same key replaces the first."""
    directory = os.path.join(root, "candidates", key)
    shutil.rmtree(directory, ignore_errors=True)
    os.makedirs(directory, exist_ok=True)
    _write_file(os.path.join(directory, "model.pt"), blob)
    _write_file(os.path.join(directory, "train.py"), train_py.encode("utf-8"))
    _write_file(os.path.join(directory, "manifest.json"), json.dumps(manifest, indent=1).encode("utf-8"))
    prune(root, now)


def promote(root, key, now) -> dict:
    """Moves a candidate to the kept models: the lab calls this when the
    Reviewer keeps the run. Doing it twice is the same as doing it once."""
    if not valid_key(key):
        return {"ok": False, "error": "not a model key"}
    kept_dir = os.path.join(root, "kept", key)
    kept = read_manifest(kept_dir)
    if kept is not None:
        return {"ok": True, "already": True, "model": public_manifest(kept, read_check(kept_dir))}
    candidate_dir = os.path.join(root, "candidates", key)
    m = read_manifest(candidate_dir)
    if m is None:
        return {"ok": False, "error": "no saved model under that key (it was not saved, or it has been cleared away)"}
    if m.get("source") == "smoke" or m.get("dataset") != "tinystories_gpt4_clean":
        return {"ok": False, "error": "a smoke run's model is never kept"}
    shutil.rmtree(kept_dir, ignore_errors=True)
    os.makedirs(kept_dir, exist_ok=True)
    for name in ("model.pt", "train.py"):
        shutil.copyfile(os.path.join(candidate_dir, name), os.path.join(kept_dir, name))
    m["promoted_at"] = int(now)
    _write_file(os.path.join(kept_dir, "manifest.json"), json.dumps(m, indent=1).encode("utf-8"))
    _remove(root, "candidates", key)
    removed = prune(root, now)
    return {"ok": True, "already": False, "model": public_manifest(m, None), "removed": removed}


def read_check(directory):
    """The result of the lab's own sample of a kept model, if it has run."""
    try:
        with open(os.path.join(directory, "check.json"), "r", encoding="utf-8") as f:
            c = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(c, dict) or not isinstance(c.get("ok"), bool):
        return None
    return {"ok": c["ok"], "reason": plain(c.get("reason")) or None, "sample": clean_story(str(c.get("sample") or "").encode("ascii", "ignore"), 400) or None,
            "checked_at": c.get("checked_at") if isinstance(c.get("checked_at"), (int, float)) else None}


def public_manifest(m, check) -> dict:
    """The fields of a manifest the lab is told, plus the sample check."""
    keys = ("key", "source", "epoch", "saved_at", "promoted_at", "dataset", "gpu", "budget_s", "val_bpb", "params_m",
            "metrics_source", "eval_bpb_seen_by_harness", "params", "seq_len", "module", "model_bytes", "model_sha256",
            "train_py_sha256", "harness_sha256")
    out = {k: m.get(k) for k in keys}
    out["check"] = check
    return out


def models_info(root) -> list:
    """The kept models, newest first, each with its sample check (None while it has not run)."""
    return [public_manifest(m, read_check(os.path.join(root, "kept", m["key"]))) for m in _saved(root, "kept")]


def sample_result(output, prompt, max_new) -> dict:
    """Turns what a sampling sandbox printed into what the lab returns. Only
    the new bytes are taken from the sandbox, cut to max_new and made plain;
    the prompt is the one the controller sent."""
    text = output.decode("utf-8", errors="replace") if isinstance(output, (bytes, bytearray)) else str(output or "")
    for line in reversed(text.splitlines()):
        if not line.startswith("OBLAB_SAMPLE "):
            continue
        try:
            r = json.loads(line[len("OBLAB_SAMPLE "):])
        except ValueError:
            break
        if not isinstance(r, dict):
            break
        if r.get("ok") is not True:
            stage = r.get("stage") if r.get("stage") in ("request", "definitions", "load", "generate") else "sandbox"
            return {"status": "error", "stage": stage, "error": plain(r.get("error")) or "the model could not be sampled"}
        try:
            new = base64.b64decode(str(r.get("new_b64") or ""), validate=True)
        except ValueError:
            break
        story = clean_story(new, max_new)
        stopped = r.get("stopped") if r.get("stopped") in ("end", "limit", "time") else "limit"
        return {"status": "ok", "prompt": prompt, "continuation": story, "text": prompt + story,
                "new_bytes": len(story), "stopped": stopped}
    return {"status": "error", "stage": "sandbox", "error": "the sampling sandbox returned nothing usable"}


def sample_in_sandbox(create_sandbox, key, prompt, max_new, seed) -> dict:
    """Asks one saved model for a story inside a sandbox made by `create_sandbox`
    (no network, no secrets, that model's directory read-only at MODEL_MOUNT).
    Returns a result for every outcome and always ends the sandbox."""
    t0 = time.time()
    sb = None
    try:
        sb = create_sandbox()
        request = {"key": key, "prompt_b64": base64.b64encode(prompt.encode("ascii", "ignore")).decode("ascii"),
                   "max_new": int(max_new), "seconds": SAMPLE_GENERATE_S, "seed": int(seed)}
        sb.filesystem.write_text(json.dumps(request), "/tmp/request.json")
        sb.filesystem.write_text(SAMPLER, "/tmp/oblab_sample.py")
        t_exec = time.time()
        proc = sb.exec("python", "-I", "/tmp/oblab_sample.py", timeout=SAMPLE_EXEC_S, text=False)
        output = proc.stdout.read()
        proc.wait()
        result = sample_result(output, prompt, max_new)
        if result.get("stage") == "sandbox" and time.time() - t_exec >= SAMPLE_EXEC_S - 1:
            result = {"status": "error", "stage": "timeout",
                      "error": f"loading and writing took more than the {SAMPLE_EXEC_S} s allowed"}
    except Exception as exc:
        result = {"status": "error", "stage": "sandbox", "error": plain(str(exc)) or "the sampling sandbox failed"}
    finally:
        if sb is not None:
            try:
                sb.terminate()
            except Exception:
                pass
    result["seconds"] = round(time.time() - t0, 2)
    return result


@app.function(
    image=image,
    timeout=HARD_TIMEOUT_S,
    volumes={"/cache": cache, MODELS_ROOT: model_store},
    retries=0,
    max_containers=1,
    cpu=(2, 4),
    memory=(4096, 8192),
)
def run_experiment(train_py: str, budget_s: float = DEFAULT_BUDGET_S, smoke: bool = False, keep_key=None) -> dict:
    """Run one experiment; returns a structured result, never raises for
    experiment-level failures (crash IS a result the reviewer needs).

    `keep_key` is set when the model this run trains may be kept ("Keeping a
    model" at the top of this file). Without it nothing below differs from a
    runner that has no such thing. With it, an ok result also carries
    "checkpoint": {"key", "saved", ...} saying whether a model was saved as a
    candidate and, if not, why. Keeping never changes the run's own outcome.
    """
    t0 = time.time()
    keep = None
    if keep_key is not None:
        keep = {"key": keep_key if valid_key(keep_key) else None, "saved": False}
        if keep["key"] is None:
            keep["reason"] = "the key the lab sent is not a model key"
    keeping = keep is not None and keep["key"] is not None
    kept_blob = None
    syntax_error = _check_train_py(train_py)
    if syntax_error is not None:
        return {"status": "crash", "stage": "syntax",
                "error": f"train.py does not compile; no data prepared and no GPU started. {syntax_error}",
                "log_tail": syntax_error, "wall_seconds": time.time() - t0}
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
            app=app, image=image, gpu=None if smoke else GPU_KIND,
            timeout=train_timeout + 60 + (KEEP_COLLECT_S if keeping else 0),
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
        if keeping:
            # The disposable copy, with the save step appended. /harness/prepare.py
            # and the hash reported for it are the reviewed file, as always.
            with open("/harness/prepare.py", "rb") as f:
                sb.filesystem.write_text(f.read().decode("utf-8") + KEEP_HOOK, "/tmp/prepare.py")
        # Keep output out of the controller's unbounded PIPE buffers. The hard
        # file limit is inherited by train.py; the controller reads only a tail.
        supervisor = """import resource, subprocess, sys
resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
with open('/tmp/train.log', 'wb') as out:
    p = subprocess.run([sys.executable, '/tmp/train.py'] + sys.argv[1:], stdout=out, stderr=out)
sys.exit(p.returncode)
"""
        t_train = time.time()
        if keeping:
            # Same command, limits and hard stop for train.py. This supervisor
            # also knows when train.py is over and the save step has begun.
            proc = sb.exec("python", "-c", KEEP_SUPERVISOR, str(train_timeout - KEEP_CUT_BEFORE_LIMIT_S),
                           *(["--smoke"] if smoke else []), timeout=train_timeout)
        else:
            proc = sb.exec("python", "-c", supervisor, *(["--smoke"] if smoke else []),
                           timeout=train_timeout)
        proc.wait()
        train_seconds_wall = time.time() - t_train
        if keeping:
            # The time the save step took is not training time. It is taken off
            # the measured wall time, so that number means what it meant before.
            phases = keep_report(proc.stdout.read())
            if phases is not None and phases["train_done_s"] is not None and phases["total_s"] is not None:
                keep["save_seconds"] = round(max(0.0, phases["total_s"] - phases["train_done_s"]), 3)
                train_seconds_wall = max(0.0, train_seconds_wall - keep["save_seconds"])
                if phases["cut"]:
                    keep["reason"] = "the save step was cut short at the hard limit for the run"
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
        if keeping and "reason" not in keep and any(line.startswith("RESULT ") for line in stdout.splitlines()):
            # Copy the saved model out while the sandbox is still there. It is
            # stored only if the run turns out ok below. A failure here is a
            # missing checkpoint, never a failed run.
            try:
                t_collect = time.time()
                report, kept_blob = collect_checkpoint(sb)
                keep.update({k: v for k, v in report.items() if k != "saved"})
                keep["collect_seconds"] = round(time.time() - t_collect, 2)
            except Exception as exc:
                kept_blob = None
                keep["reason"] = "the saved model could not be copied out: " + plain(str(exc), 200)
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

    result = {
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
    if keep is not None:
        if kept_blob is not None:
            # The run is ok: store what was copied out as a candidate. The lab
            # promotes it if the Reviewer keeps the run; otherwise it is cleared
            # away with the older candidates.
            try:
                model_store.reload()
                store_candidate(MODELS_ROOT, keep["key"], train_py, kept_blob,
                                build_manifest(keep["key"], keep, result, train_py, time.time()), time.time())
                model_store.commit()
                keep["saved"] = True
            except Exception as exc:
                keep["reason"] = "the saved model could not be stored: " + plain(str(exc), 200)
        elif "reason" not in keep:
            keep["reason"] = "no model was saved"
        result["checkpoint"] = keep
        result["wall_seconds"] = time.time() - t0
    return result


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
    keep_key = body.get("keep_key")
    if keep_key is not None:
        # Sent only by a lab with LAB_ENABLE_RESEARCH_TALK on: this run's model
        # may be kept. Without it the call below is the one it always was.
        if not isinstance(keep_key, str) or key_epoch(keep_key) is None:
            raise HTTPException(status_code=400, detail="Invalid keep_key")
        call = run_experiment.spawn(train_py, budget_s, bool(body.get("smoke", False)), keep_key)
        return {"call_id": call.object_id}
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
    except OutputExpiredError:
        # The call's result is gone (Modal keeps outputs for a limited time).
        # Polling it again can never succeed, so the epoch must record it.
        return {"status": "failed", "error": "run result expired before it was collected"}
    except TimeoutError:
        # Modal raises the built-in TimeoutError while the call is still running.
        return {"status": "running"}
    except Exception as e:
        return {"status": "failed", "error": str(e)[-1500:]}


# ---------------------------------------------------------------------------
# Kept models: the store, and asking one for a story
# ---------------------------------------------------------------------------

@app.function(image=web_image, volumes={MODELS_ROOT: model_store}, timeout=120, retries=0, max_containers=1)
def store_op(action: str, key: str = "", check: bool = True) -> dict:
    """The two things done to the store outside a run: list the kept models,
    and promote a candidate. One container at a time, so two promotions
    cannot clear each other's files away. `check` False leaves the sample of
    a newly kept model to the caller (the owner's command waits for it)."""
    model_store.reload()
    if action == "info":
        return {"models": models_info(MODELS_ROOT)}
    if action == "promote":
        result = promote(MODELS_ROOT, key, time.time())
        model_store.commit()
        if check and result.get("ok") and not result.get("already"):
            # The lab's own sample of the model it just kept. Until this has
            # run and worked, the model is not offered to visitors.
            sample_story.spawn(key, "", SAMPLE_CHECK_NEW, "kept", True)
        return result
    return {"ok": False, "error": "unknown action"}


@app.function(image=image, volumes={MODELS_ROOT: model_store}, timeout=SAMPLE_FN_TIMEOUT_S, retries=0,
              max_containers=2, cpu=(1, 2), memory=(1024, 4096))
def sample_story(key: str, prompt: str = "", max_new: int = SAMPLE_DEFAULT_NEW, area: str = "kept",
                 record_check: bool = False) -> dict:
    """Ask one saved model for a story. This controller only starts the
    sandbox and cleans what comes back; the model is loaded and run inside
    the sandbox: no network, no secrets, CPU only, and nothing mounted but
    that model's own directory, read-only."""
    if not valid_key(key) or area not in ("kept", "candidates"):
        return {"status": "error", "stage": "input", "error": "not a model key"}
    text = clean_prompt(prompt)
    try:
        count = max(1, min(int(max_new), SAMPLE_HARD_NEW))
    except (TypeError, ValueError):
        count = SAMPLE_DEFAULT_NEW

    def create_sandbox():
        return modal.Sandbox.create(
            app=app, image=image, gpu=None, timeout=SAMPLE_SANDBOX_S, cpu=(1, 2), memory=(2048, 8192),
            block_network=True, secrets=[], env={"PYTHONUNBUFFERED": "1"}, workdir="/tmp",
            volumes={MODEL_MOUNT: model_store.with_mount_options(read_only=True, sub_path=f"/{area}/{key}")},
        )

    result = sample_in_sandbox(create_sandbox, key, text, count, int.from_bytes(os.urandom(4), "big"))
    result["key"] = key
    if record_check and area == "kept":
        check = {"ok": result["status"] == "ok" and result.get("new_bytes", 0) > 0, "checked_at": int(time.time()),
                 "seconds": result.get("seconds"),
                 "reason": None if result["status"] == "ok" else f"{result.get('stage')}: {result.get('error')}",
                 "sample": result.get("text") if result["status"] == "ok" else None}
        if result["status"] == "ok" and not check["ok"]:
            check["reason"] = "the model wrote nothing"
        try:
            model_store.reload()
            directory = os.path.join(MODELS_ROOT, "kept", key)
            if read_manifest(directory) is not None:
                _write_file(os.path.join(directory, "check.json"), json.dumps(check, indent=1).encode("utf-8"))
                model_store.commit()
        except Exception as exc:
            result["check_error"] = plain(str(exc), 200)
    return result


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-runner-auth")], timeout=SAMPLE_FN_TIMEOUT_S + 20)
@modal.fastapi_endpoint(method="POST")
def models(body: dict, request: Request) -> dict:
    """For the Vercel backend, with the same token as /start:
         {action: "info"}                           -> {models: [...]}  kept models, newest first
         {action: "promote", key}                   -> {ok, model} | {ok: false, error}
         {action: "sample", key, prompt?, max_new?} -> {status: "ok", text, ...} | {status: "error", stage, error}
    A sample waits for its sandbox, about ten seconds to a minute."""
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    action = body.get("action")
    if action == "info":
        return store_op.remote("info")
    key = body.get("key")
    if not valid_key(key):
        raise HTTPException(status_code=400, detail="Invalid key")
    if action == "promote":
        return store_op.remote("promote", key)
    if action == "sample":
        prompt = body.get("prompt", "")
        if not isinstance(prompt, str) or len(prompt) > 4 * PROMPT_MAX_CHARS:
            raise HTTPException(status_code=400, detail="Invalid prompt")
        max_new = body.get("max_new", SAMPLE_DEFAULT_NEW)
        if isinstance(max_new, bool) or not isinstance(max_new, int) or not 1 <= max_new <= SAMPLE_HARD_NEW:
            raise HTTPException(status_code=400, detail="Invalid max_new")
        return sample_story.remote(key, prompt, max_new)
    raise HTTPException(status_code=400, detail="Unknown action")


@app.local_entrypoint()
def keep_current(train_py: str, smoke: bool = False, budget_s: float = DEFAULT_BUDGET_S):
    """The owner's way to have a model to talk to before the loop next
    improves: train one train.py once and keep its model.

        modal run modal/research_runner.py::keep_current --train-py /path/to/Research-Lab/train.py

    A real training run (a GPU for the budget, 300 s by default). It is not an
    epoch: nothing is written to the ledger, and the kept model's manifest
    says "owner_rerun". With --smoke it trains the tiny CPU model on synthetic
    bytes, samples it once as a check of the whole path, and keeps nothing.
    """
    with open(train_py, "r", encoding="utf-8") as f:
        source = f.read()
    key = ("smoke-" if smoke else "owner-") + os.urandom(4).hex()
    print(f"training {train_py} as {key} ...")
    result = run_experiment.remote(source, budget_s, smoke, key)
    print(json.dumps({k: v for k, v in result.items() if k != "log_tail"}, indent=2))
    if result.get("status") != "ok" or not (result.get("checkpoint") or {}).get("saved"):
        print("no model was saved; see the result above")
        return
    if smoke:
        print(json.dumps(sample_story.remote(key, "", SAMPLE_CHECK_NEW, "candidates"), indent=2))
        return
    promoted = store_op.remote("promote", key, False)
    print(json.dumps(promoted, indent=2))
    if not promoted.get("ok"):
        return
    # The lab's own sample of the kept model. It is waited for here, because
    # a function started and left behind would stop with this command.
    print(json.dumps(sample_story.remote(key, "", SAMPLE_CHECK_NEW, "kept", True), indent=2))
    print("List the kept models with:  modal run modal/research_runner.py::list_kept")


@app.local_entrypoint()
def list_kept():
    """Print the kept models and their sample checks."""
    print(json.dumps(store_op.remote("info"), indent=2))

