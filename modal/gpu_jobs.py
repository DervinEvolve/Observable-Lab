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
# Public weights (docs/TOOLS.md, "Public weights"). A model's script never gets
# the network, so it cannot download anything. Instead a model may ask for one
# public Hugging Face repository, and fetch_weights below, which is lab code
# and never runs anything a model wrote, downloads it onto a shelf (the Modal
# Volume "oblab-weights") after checking it:
#
#   * public and not gated; no Hugging Face token is used anywhere;
#   * a license on the allowlist;
#   * no custom code: any *.py file or an "auto_map" entry is a refusal;
#   * safetensors weights present; only safetensors, JSON, text and tokenizer
#     files are downloaded (never .bin, .pt, .pkl or .py);
#   * total size under the limit, every file checked against the hash the hub
#     published for it.
#
#   A job that names weights gets that one shelf entry mounted read-only at
#   /weights. Its network stays blocked. A job that names none gets no volume,
#   exactly as before. The job's result says which weights were mounted, and
#   the controller reads the entry's manifest inside the sandbox before the
#   script runs, so a result never names weights the job could not read.
#
# Deploy:  modal deploy modal/gpu_jobs.py
# Secret:  modal secret create oblab-gpu-jobs-auth JOBS_TOKEN=<random, 32+ chars>
#          (the same value goes in the lab server's GPU_JOBS_TOKEN)
#
# HTTP API (for the Vercel backend), Authorization: Bearer <JOBS_TOKEN> on both:
#   POST /start   {script, weights?: {repo, sha?, licenses?}}        -> {call_id}
#   POST /start   {fetch_weights: {repo, revision?, limits?}}        -> {call_id}
#   GET  /status  ?call_id=...   -> {status: running} | {status: done, result} | {status: failed, error}
#
# job result:   {status: ok|error|timeout|crash, stage?, exit_code, log_tail,
#                run_seconds, wall_seconds, gpu, weights: null | {repo, sha, license}}
#               stage "weights": the named weights are not on the shelf, no GPU started;
#               stage "mount": the sandbox could not read them, the script was not run
# fetch result: {status: ok, cached, repo, sha, license, size_bytes, files, evicted, wall_seconds}
#             | {status: refused, rule, reason, wall_seconds}
#             | {status: error, stage, error, wall_seconds}

import hashlib
import hmac
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional  # the deploying Mac may run Python 3.9, which has no "X | None"

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

# Public weights. The shelf is one Modal Volume laid out as
# <org>/<name>/<commit sha>/ with the lab's manifest beside the files.
WEIGHTS_VOLUME_NAME = "oblab-weights"
WEIGHTS_USE_DICT_NAME = "oblab-weights-use"   # when each shelf entry was last used
SHELF_DIR = "/shelf"                          # writable; mounted in fetch_weights only
WEIGHTS_MOUNT = "/weights"                    # read-only; one entry, in a job's sandbox
MANIFEST_NAME = "_lab_manifest.json"
HUB = "https://huggingface.co"
# Defaults when the lab server sends no limits (it sends its own, from
# LAB_WEIGHTS_LICENSES, LAB_WEIGHTS_MAX_GB and LAB_WEIGHTS_SHELF_GB).
DEFAULT_LICENSES = ("apache-2.0", "mit", "bsd-3-clause", "bsd-2-clause", "cc-by-4.0")
DEFAULT_MAX_GB = 3.0
DEFAULT_SHELF_GB = 30.0
# Ceilings the lab server cannot raise.
HARD_MAX_GB = 20.0
HARD_SHELF_GB = 500.0
FETCH_TIMEOUT_S = 900
# A shelf entry asked for or named by a job this recently is not removed to
# make room: a job that has just found it may be about to mount it. This is
# run_job's own time limit (JOB_TIMEOUT_S + 180).
IN_USE_S = 300
MAX_WEIGHT_FILES = 64
MAX_JSON_CHECK_BYTES = 32 * 1024 * 1024
REPO_ID_PATTERN = r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?"
REVISION_PATTERN = r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?"
SHA_PATTERN = r"[0-9a-f]{40}"
LICENSE_PATTERN = r"[a-z0-9][a-z0-9.+-]{0,39}"
SAFE_PATH_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}"
ALLOWED_SUFFIXES = (".safetensors", ".json", ".txt")
TOKENIZER_FILES = ("tokenizer.model", "spiece.model", "sentencepiece.bpe.model")

app = modal.App(APP_NAME)

weights_volume = modal.Volume.from_name(WEIGHTS_VOLUME_NAME, create_if_missing=True)
weights_use = modal.Dict.from_name(WEIGHTS_USE_DICT_NAME, create_if_missing=True)

# Same pinned base and packages as the research runner's training image, so a
# job sees the same Python and torch the research loop uses.
PYTHON_BASE_IMAGE = "python:3.11.18-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd"

image = (
    modal.Image.from_registry(PYTHON_BASE_IMAGE)
    .apt_install("gcc=4:12.2.0-3", "g++=4:12.2.0-3", "libc6-dev")
    .pip_install("numpy==2.4.6")
    .pip_install("torch==2.6.0", index_url="https://download.pytorch.org/whl/cu124")
    # Modal imports this whole module in run_job's container too, and the top of
    # the file imports fastapi: without this line run_job never started.
    .pip_install("fastapi==0.162.0")
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

# Run inside the sandbox, before the model's script exists there: prints the
# repository and commit that the manifest of the mounted shelf entry names.
WEIGHTS_CHECK = """import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    m = json.load(f)
print(json.dumps({'repo': m.get('repo'), 'sha': m.get('sha')}))
"""


# ---------------------------------------------------------------------------
# Public weights: the rules. Plain functions with the network, the clock and
# the shelf passed in, so tests/test_weights.py runs all of them without Modal.
# ---------------------------------------------------------------------------

def valid_repo_id(repo) -> bool:
    """org/name as Hugging Face spells it, and nothing that could be a path trick."""
    return (isinstance(repo, str) and len(repo) <= 193 and re.fullmatch(REPO_ID_PATTERN, repo) is not None
            and ".." not in repo and "--" not in repo and not repo.lower().endswith(".git"))


def valid_revision(revision) -> bool:
    """A branch or tag name without slashes, or a full commit sha."""
    return (isinstance(revision, str) and re.fullmatch(REVISION_PATTERN, revision) is not None
            and ".." not in revision)


def limits_as_sent(raw) -> dict:
    """The lab server's limits as it wrote them, {licenses?, max_gb?, shelf_gb?}, and no other key.
    This is what start hands to fetch_weights. They are turned into numbers once, by weights_limits
    inside the fetch: weights_limits reads max_gb and shelf_gb, so running it over its own output
    would put the defaults back."""
    raw = raw if isinstance(raw, dict) else {}
    return {key: raw[key] for key in ("licenses", "max_gb", "shelf_gb") if key in raw}


def weights_limits(raw) -> dict:
    """The limits for one fetch: the lab server's, held under this file's ceilings. 1 GB is 10^9 bytes.

    `raw` is {licenses?, max_gb?, shelf_gb?} as the lab server sent it. The
    default licenses apply only when no list was sent. A list that was sent is
    never widened: if none of its entries is a license id the result is an
    empty list, and every repository is refused.
    """
    raw = raw if isinstance(raw, dict) else {}
    listed = isinstance(raw.get("licenses"), (list, tuple))
    names = []
    if listed:
        for item in raw["licenses"][:40]:
            if isinstance(item, str) and re.fullmatch(LICENSE_PATTERN, item.strip().lower()):
                names.append(item.strip().lower())

    def gb(key, default, ceiling):
        v = raw.get(key)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v <= 0:
            return default
        return min(float(v), ceiling)

    max_gb = gb("max_gb", DEFAULT_MAX_GB, HARD_MAX_GB)
    shelf_gb = max(gb("shelf_gb", DEFAULT_SHELF_GB, HARD_SHELF_GB), max_gb)
    return {"licenses": sorted(set(names)) if listed else list(DEFAULT_LICENSES),
            "max_bytes": int(max_gb * 1e9), "shelf_bytes": int(shelf_gb * 1e9)}


def repo_licenses(info) -> list:
    """Every license the model card states, lower case. The card's field and its license: tags are both read."""
    card = info.get("cardData") if isinstance(info.get("cardData"), dict) else {}
    value = card.get("license")
    names = [n.strip().lower() for n in (value if isinstance(value, list) else [value]) if isinstance(n, str) and n.strip()]
    tags = info.get("tags") if isinstance(info.get("tags"), list) else []
    for tag in tags:
        if isinstance(tag, str) and tag.startswith("license:") and tag[8:].strip():
            names.append(tag[8:].strip().lower())
    return sorted(set(names))


def has_auto_map(value, depth=0) -> bool:
    """True when a config names code of its own to load (transformers' auto_map)."""
    if depth > 3:
        return False
    if isinstance(value, dict):
        return "auto_map" in value or any(has_auto_map(v, depth + 1) for v in value.values())
    return False


def wanted_file(path) -> bool:
    """The only kinds of file the fetcher downloads: safetensors, JSON, text and tokenizer models."""
    base = path.rsplit("/", 1)[-1].lower()
    return base.endswith(ALLOWED_SUFFIXES) or base in TOKENIZER_FILES


def check_repo(info, repo, limits) -> dict:
    """Every rule that the hub's own description can answer, before one byte of weights is downloaded.

    Returns {"ok": True, repo, sha, license, licenses, size_bytes, files} or
    {"ok": False, rule, reason}. `info` is the hub's JSON for one revision
    with ?blobs=true, read without a token.
    """
    def no(rule, reason):
        return {"ok": False, "rule": rule, "reason": reason}

    if not isinstance(info, dict):
        return no("hub", "the hub's answer was not a model description")
    if info.get("id") != repo:
        other = info.get("id")
        return no("repo", f"the hub calls this repository {other}; ask for it by that id" if valid_repo_id(other)
                  else "the hub did not confirm this repository id")
    sha = info.get("sha")
    if not isinstance(sha, str) or re.fullmatch(SHA_PATTERN, sha) is None:
        return no("revision", "the hub did not resolve the revision to a commit")
    if info.get("private") is not False or info.get("disabled") is True:
        return no("not_public", "the repository is private or disabled")
    if info.get("gated") is not False:
        return no("gated", "the repository is gated (its terms need an account), and the lab uses no Hugging Face token")
    licenses = repo_licenses(info)
    if not licenses:
        return no("license", "the repository states no license")
    for name in licenses:
        if name not in limits["licenses"]:
            return no("license", f"license {name[:40]} is not on the lab's list ({', '.join(limits['licenses']) or 'the list is empty'})")
    siblings = info.get("siblings")
    if not isinstance(siblings, list) or not siblings:
        return no("hub", "the hub listed no files")
    for entry in siblings:
        if not isinstance(entry, dict) or not isinstance(entry.get("rfilename"), str):
            return no("hub", "the hub's file list could not be read")
    for entry in siblings:
        if entry["rfilename"].lower().endswith(".py"):
            return no("custom_code", f"the repository contains Python code ({entry['rfilename'][:80]}); "
                                     "the lab never loads a repository's own code")
    if has_auto_map(info.get("config")):
        return no("custom_code", "its config has an auto_map entry, which needs the repository's own code")
    wanted = [entry for entry in siblings if wanted_file(entry["rfilename"])]
    if not any(entry["rfilename"].lower().endswith(".safetensors") for entry in wanted):
        return no("format", "the repository has no safetensors weights; pickle formats (.bin, .pt, .pkl) are never downloaded")
    if len(wanted) > MAX_WEIGHT_FILES:
        return no("files", f"more than {MAX_WEIGHT_FILES} files to download")
    files = []
    total = 0
    for entry in wanted:
        path = entry["rfilename"]
        if re.fullmatch(SAFE_PATH_PATTERN, path) is None or ".." in path:
            return no("paths", f"a file path the lab does not accept: {path[:80]}")
        lfs = entry.get("lfs") if isinstance(entry.get("lfs"), dict) else None
        size = (lfs or entry).get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            return no("size", f"the hub reported no size for {path[:80]}")
        # What the downloaded bytes must hash to: the LFS sha256, or for a
        # small file kept in git, its git blob id.
        sha256 = lfs.get("sha256") if lfs else None
        git_sha1 = None if lfs else entry.get("blobId")
        if lfs and (not isinstance(sha256, str) or re.fullmatch(r"[0-9a-f]{64}", sha256) is None):
            return no("hub", f"the hub published no sha256 for {path[:80]}")
        if not lfs and (not isinstance(git_sha1, str) or re.fullmatch(SHA_PATTERN, git_sha1) is None):
            return no("hub", f"the hub published no blob id for {path[:80]}")
        files.append({"path": path, "size": size, "sha256": sha256, "git_sha1": git_sha1})
        total += size
    if total > limits["max_bytes"]:
        return no("size", f"its files total {total / 1e9:.2f} GB, over the limit of {limits['max_bytes'] / 1e9:g} GB")
    return {"ok": True, "repo": repo, "sha": sha, "license": ", ".join(licenses), "licenses": licenses,
            "size_bytes": total, "files": files}


def valid_manifest(m) -> bool:
    return (isinstance(m, dict) and valid_repo_id(m.get("repo"))
            and isinstance(m.get("sha"), str) and re.fullmatch(SHA_PATTERN, m["sha"]) is not None
            and isinstance(m.get("size_bytes"), int) and not isinstance(m.get("size_bytes"), bool) and m["size_bytes"] >= 0
            and isinstance(m.get("license"), str) and isinstance(m.get("licenses"), list))


def read_manifest(directory):
    """The lab's manifest for one shelf entry, or None. An entry without one was never finished."""
    try:
        with open(os.path.join(directory, MANIFEST_NAME), "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        return None
    return manifest if valid_manifest(manifest) else None


def shelf_scan(root, used=None):
    """(entries, strays). Entries are finished downloads, as {key, dir, repo, sha, size_bytes, last_used};
    strays are <org>/<name>/<sha> directories with no manifest of their own (a fetch that stopped half way)."""
    entries, strays = [], []

    def subdirs(path):
        try:
            return sorted(e.name for e in os.scandir(path) if e.is_dir(follow_symlinks=False) and e.name[:1] not in "._")
        except OSError:
            return []

    for org in subdirs(root):
        for name in subdirs(os.path.join(root, org)):
            for sha in subdirs(os.path.join(root, org, name)):
                directory = os.path.join(root, org, name, sha)
                manifest = read_manifest(directory)
                if manifest is None or manifest["repo"] != f"{org}/{name}" or manifest["sha"] != sha:
                    strays.append(directory)
                    continue
                key = f"{org}/{name}@{sha}"
                last = manifest.get("fetched_at_unix")
                last = float(last) if isinstance(last, (int, float)) and not isinstance(last, bool) else 0.0
                try:
                    seen = used.get(key) if used is not None else None
                except Exception:
                    seen = None
                if isinstance(seen, (int, float)) and not isinstance(seen, bool):
                    last = max(last, float(seen))
                entries.append({"key": key, "dir": directory, "repo": manifest["repo"], "sha": sha,
                                "size_bytes": manifest["size_bytes"], "last_used": last})
    return entries, strays


def plan_eviction(entries, need_bytes, cap_bytes, keep=()):
    """Which shelf entries to remove, least recently used first, so that what
    stays plus `need_bytes` fits under `cap_bytes`. [] when it already fits;
    None when it cannot fit even with everything else gone."""
    if need_bytes > cap_bytes:
        return None
    total = sum(e["size_bytes"] for e in entries)
    out = []
    for e in sorted(entries, key=lambda e: (e["last_used"], e["key"])):
        if total + need_bytes <= cap_bytes:
            break
        if e["key"] in keep:
            continue
        out.append(e["key"])
        total -= e["size_bytes"]
    return out if total + need_bytes <= cap_bytes else None


def in_use(entries, now_value, window_s=IN_USE_S) -> set:
    """Keys of the shelf entries asked for or named by a job in the last `window_s` seconds."""
    return {e["key"] for e in entries if now_value - e["last_used"] < window_s}


def mount_matches(output, repo, sha) -> bool:
    """True when what WEIGHTS_CHECK printed inside the sandbox names this repository and commit."""
    try:
        seen = json.loads(output)
    except (TypeError, ValueError):
        return False
    return isinstance(seen, dict) and seen.get("repo") == repo and seen.get("sha") == sha


def fetch_core(repo, revision, limits, root, hub_info, hub_download, used, now) -> dict:
    """One whole fetch. `hub_info(repo, revision) -> (http_status, json or None)`
    and `hub_download(repo, sha, path, dest, declared_size) -> {size, sha256, git_sha1}`
    are the only network; `used` maps "repo@sha" to when it was last used."""
    if not valid_repo_id(repo):
        return {"status": "refused", "rule": "repo", "reason": "the repository id must be org/name"}
    revision = revision or "main"
    if not valid_revision(revision):
        return {"status": "refused", "rule": "revision", "reason": "the revision must be a branch, tag or commit sha"}
    limits = weights_limits(limits)
    code, info = hub_info(repo, revision)
    if code in (401, 403, 404):
        return {"status": "refused", "rule": "not_public",
                "reason": "the hub shows no public repository or revision by that name (a private or gated one "
                          "looks the same without a token, and the lab uses none)"}
    if code != 200:
        return {"status": "error", "stage": "hub", "error": f"the hub answered HTTP {code}"}
    checked = check_repo(info, repo, limits)
    if not checked["ok"]:
        return {"status": "refused", "rule": checked["rule"], "reason": checked["reason"]}

    sha = checked["sha"]
    key = f"{repo}@{sha}"
    target = os.path.join(root, *repo.split("/"), sha)

    def touch():
        try:
            used[key] = now()
        except Exception:
            pass

    entries, strays = shelf_scan(root, used)
    for directory in strays:
        shutil.rmtree(directory, ignore_errors=True)
    if any(e["key"] == key for e in entries):
        manifest = read_manifest(target)
        touch()
        return {"status": "ok", "cached": True, "repo": repo, "sha": sha, "license": manifest["license"],
                "size_bytes": manifest["size_bytes"], "files": len(manifest.get("files") or []), "evicted": []}

    # Entries in use just now are kept. This first plan only stops a download
    # that could not fit; what is removed is decided again after the download,
    # which can take minutes, from what is in use then.
    no_room = {"status": "refused", "rule": "shelf",
               "reason": "it does not fit on the lab's shelf (weights used in the last few minutes are not removed to make room)"}
    if plan_eviction(entries, checked["size_bytes"], limits["shelf_bytes"], keep=in_use(entries, now())) is None:
        return no_room

    records = []
    try:
        os.makedirs(target, exist_ok=True)
        # Small files first, so a config that names its own code stops the
        # fetch before any weights are downloaded.
        for f in sorted(checked["files"], key=lambda f: (f["path"].lower().endswith(".safetensors"), f["path"])):
            dest = os.path.join(target, *f["path"].split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            got = hub_download(repo, sha, f["path"], dest, f["size"])
            if got["size"] != f["size"]:
                raise ValueError(f"{f['path']}: {got['size']} bytes arrived, the hub said {f['size']}")
            if f["sha256"] and got["sha256"] != f["sha256"]:
                raise ValueError(f"{f['path']}: sha256 does not match the hub's")
            if f["git_sha1"] and got["git_sha1"] != f["git_sha1"]:
                raise ValueError(f"{f['path']}: content does not match the hub's blob id")
            base = f["path"].rsplit("/", 1)[-1].lower()
            if base.endswith(".json") and "config" in base and f["size"] <= MAX_JSON_CHECK_BYTES:
                try:
                    with open(dest, "r", encoding="utf-8") as fh:
                        parsed = json.load(fh)
                except (OSError, ValueError):
                    parsed = None
                if has_auto_map(parsed):
                    shutil.rmtree(target, ignore_errors=True)
                    return {"status": "refused", "rule": "custom_code",
                            "reason": f"{f['path'][:80]} has an auto_map entry, which needs the repository's own code"}
            records.append({"path": f["path"], "size": got["size"], "sha256": got["sha256"]})

        entries = [e for e in shelf_scan(root, used)[0] if e["key"] != key]
        evict = plan_eviction(entries, checked["size_bytes"], limits["shelf_bytes"], keep=in_use(entries, now()))
        if evict is None:
            shutil.rmtree(target, ignore_errors=True)
            return no_room
        evicted = []
        for e in entries:
            if e["key"] in evict:
                shutil.rmtree(e["dir"])
                evicted.append(e["key"])
                try:
                    used.pop(e["key"], None)
                except Exception:
                    pass
        fetched = now()
        manifest = {
            "repo": repo, "sha": sha, "revision_asked": revision,
            "license": checked["license"], "licenses": checked["licenses"],
            "size_bytes": checked["size_bytes"], "files": records,
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(fetched)), "fetched_at_unix": fetched,
            "source": f"{HUB}/{repo}/tree/{sha}", "token_used": False,
            "fetched_by": "observable-lab modal/gpu_jobs.py fetch_weights",
        }
        # The manifest is written last: an entry counts only once it has one.
        with open(os.path.join(target, MANIFEST_NAME), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=1)
    except Exception as exc:
        shutil.rmtree(target, ignore_errors=True)
        return {"status": "error", "stage": "download", "error": str(exc)[-1500:]}
    touch()
    return {"status": "ok", "cached": False, "repo": repo, "sha": sha, "license": checked["license"],
            "size_bytes": checked["size_bytes"], "files": len(records), "evicted": evicted}


def shelf_lookup(ref, manifest_at, shas_of) -> dict:
    """Which shelf entry a job means by {repo, sha?, licenses?}: that commit, or
    the newest one fetched for the repository. {"ok": False, error} when it is
    not there (the job is then not started)."""
    if not isinstance(ref, dict) or not valid_repo_id(ref.get("repo")):
        return {"ok": False, "error": "weights must name a repository as org/name"}
    repo, sha = ref["repo"], ref.get("sha")
    if sha is not None and (not isinstance(sha, str) or re.fullmatch(SHA_PATTERN, sha) is None):
        return {"ok": False, "error": "the weights commit must be a 40 character sha"}
    candidates = [sha] if sha else [s for s in shas_of(repo) if isinstance(s, str) and re.fullmatch(SHA_PATTERN, s)]
    found = []
    for candidate in candidates[:50]:
        manifest = manifest_at(repo, candidate)
        if valid_manifest(manifest) and manifest["repo"] == repo and manifest["sha"] == candidate:
            found.append(manifest)
    if not found:
        return {"ok": False, "error": f"{repo} is not on the lab's shelf; ask for it with the weights tool first"}
    manifest = max(found, key=lambda m: m.get("fetched_at_unix") if isinstance(m.get("fetched_at_unix"), (int, float)) else 0)
    allowed = ref.get("licenses")
    if isinstance(allowed, list) and any(name not in allowed for name in manifest["licenses"]):
        return {"ok": False, "error": f"{repo} is on the shelf under a license ({manifest['license'][:60]}) that is no longer on the lab's list"}
    return {"ok": True, "repo": repo, "sha": manifest["sha"], "license": manifest["license"], "size_bytes": manifest["size_bytes"]}


# ---------------------------------------------------------------------------
# Public weights: the network and the shelf. Only fetch_weights uses these.
# ---------------------------------------------------------------------------

def hub_host_ok(url) -> bool:
    """HTTPS to huggingface.co or one of its download hosts, and nowhere else."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    return (parts.scheme == "https" and parts.username is None and port in (None, 443)
            and (host == "huggingface.co" or host.endswith(".huggingface.co") or host.endswith(".hf.co")))


class _HubOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to another Hugging Face host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not hub_host_ok(newurl):
            raise urllib.error.HTTPError(req.full_url, code, "redirect to a host that is not Hugging Face", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _hub_open(url, timeout):
    if not hub_host_ok(url):
        raise ValueError("not a Hugging Face URL")
    opener = urllib.request.build_opener(_HubOnlyRedirects)
    # No Authorization header, here or anywhere: the fetcher reads only what
    # anyone can read without an account.
    return opener.open(urllib.request.Request(url, headers={"User-Agent": "observable-lab-weights"}), timeout=timeout)


def hub_info(repo, revision):
    """(HTTP status, the hub's JSON for that revision with file sizes and hashes)."""
    url = f"{HUB}/api/models/{repo}/revision/{urllib.parse.quote(revision, safe='')}?blobs=true"
    try:
        with _hub_open(url, 30) as res:
            body = res.read(16 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        return exc.code, None
    if len(body) > 16 * 1024 * 1024:
        raise ValueError("the hub's description of the repository is too large")
    return 200, json.loads(body)


def hub_download(repo, sha, path, dest, declared_size):
    """Streams one file of one commit to `dest`, hashing as it goes. Stops if
    more arrives than the hub said the file holds."""
    url = f"{HUB}/{repo}/resolve/{sha}/{urllib.parse.quote(path)}"
    sha256 = hashlib.sha256()
    git_sha1 = hashlib.sha1(b"blob %d\0" % declared_size)
    size = 0
    with _hub_open(url, 60) as res, open(dest, "wb") as out:
        while True:
            chunk = res.read(4 * 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > declared_size:
                raise ValueError(f"{path}: more bytes arrived than the hub said it holds")
            sha256.update(chunk)
            git_sha1.update(chunk)
            out.write(chunk)
    return {"size": size, "sha256": sha256.hexdigest(), "git_sha1": git_sha1.hexdigest()}


def _volume_manifest(repo, sha):
    """A shelf entry's manifest, read through Modal's API (the controller mounts no volume)."""
    try:
        return json.loads(b"".join(weights_volume.read_file(f"{repo}/{sha}/{MANIFEST_NAME}")))
    except Exception:
        return None


def _volume_shas(repo):
    try:
        return [entry.path.rstrip("/").rsplit("/", 1)[-1] for entry in weights_volume.listdir(repo)]
    except Exception:
        return []


@app.function(image=web_image, volumes={SHELF_DIR: weights_volume}, timeout=FETCH_TIMEOUT_S, retries=0,
              max_containers=1, cpu=(1, 2), memory=(1024, 4096))
def fetch_weights(repo: str, revision: str = "main", limits: Optional[dict] = None) -> dict:
    """Fetches one public repository onto the shelf, or says why not.

    This is lab code. It is the only function here that downloads anything,
    it holds no credentials, and it never runs or imports what it downloads.
    One container at a time, so two fetches never write the shelf together.
    """
    t0 = time.time()
    try:
        weights_volume.reload()
        result = fetch_core(repo, revision, limits, SHELF_DIR, hub_info, hub_download, weights_use, time.time)
        weights_volume.commit()
    except Exception as exc:
        result = {"status": "error", "stage": "fetcher", "error": str(exc)[-1500:]}
    result["wall_seconds"] = time.time() - t0
    return result


@app.function(image=image, timeout=JOB_TIMEOUT_S + 180, retries=0, max_containers=2, cpu=(1, 2), memory=(1024, 4096))
def run_job(script: str, weights: Optional[dict] = None) -> dict:
    """Run one job. Returns a result for every outcome; never raises for job failures.

    `weights` is {repo, sha?, licenses?} when the job names public weights
    from the shelf. Every result says what was mounted: "weights" is
    {repo, sha, license}, or None when the sandbox had no volume at all.
    """
    t0 = time.time()
    if not isinstance(script, str) or not script.strip() or len(script) > MAX_SCRIPT_CHARS:
        return {"status": "error", "stage": "input", "error": "script missing or too long",
                "exit_code": None, "log_tail": "", "wall_seconds": time.time() - t0, "gpu": None, "weights": None}
    syntax_error = _check_script(script)
    if syntax_error is not None:
        return {"status": "crash", "stage": "syntax",
                "error": f"the script does not compile; no GPU was started. {syntax_error}",
                "exit_code": None, "log_tail": syntax_error, "wall_seconds": time.time() - t0, "gpu": None, "weights": None}

    # Named weights: found on the shelf before any GPU starts, and then that
    # one entry (nothing else on the shelf) is mounted read-only. Without a
    # name the sandbox is created exactly as before, with no volume.
    # `mounted` is what every result reports. It stays None until the sandbox
    # itself has read that entry's manifest (below).
    mounted = None
    found = None
    sandbox_extra = {}
    sandbox_env = {"PYTHONUNBUFFERED": "1"}
    if weights is not None:
        found = shelf_lookup(weights, _volume_manifest, _volume_shas)
        if not found["ok"]:
            return {"status": "error", "stage": "weights", "error": f"no GPU was started. {found['error']}",
                    "exit_code": None, "log_tail": "", "wall_seconds": time.time() - t0, "gpu": None, "weights": None}
        sandbox_extra = {"volumes": {WEIGHTS_MOUNT: weights_volume.with_mount_options(
            read_only=True, sub_path=f"/{found['repo']}/{found['sha']}")}}
        sandbox_env["LAB_WEIGHTS_DIR"] = WEIGHTS_MOUNT
        try:
            weights_use[f"{found['repo']}@{found['sha']}"] = time.time()
        except Exception:
            pass  # only the shelf's least-recently-used order depends on it

    sb = None
    run_seconds = None
    try:
        sb = modal.Sandbox.create(
            app=app, image=image, gpu=GPU_KIND, timeout=JOB_TIMEOUT_S + 60,
            cpu=(2, 4), memory=(4096, 16384), block_network=True, secrets=[],
            env=sandbox_env, workdir="/tmp", **sandbox_extra,
        )
        if found is not None:
            # The entry was found through the API a moment ago. Modal creates
            # an empty directory when a sub_path is not there, so if the entry
            # was removed in between, /weights is empty. Read its manifest
            # here, before the model's script is in the sandbox, and do not
            # run the script (or report any weights) unless it is that commit.
            seen = ""
            try:
                check = sb.exec("python", "-I", "-c", WEIGHTS_CHECK, f"{WEIGHTS_MOUNT}/{MANIFEST_NAME}", timeout=20)
                seen = check.stdout.read()
                check.wait()
                if check.returncode != 0:
                    seen = ""
            except Exception:
                seen = ""
            if not mount_matches(seen, found["repo"], found["sha"]):
                return {"status": "error", "stage": "mount",
                        "error": f"the script was not run. {found['repo']} could not be read at {WEIGHTS_MOUNT} "
                                 "(it may have just been removed from the shelf); ask for it with the weights tool again",
                        "exit_code": None, "log_tail": "", "run_seconds": None,
                        "wall_seconds": time.time() - t0, "gpu": GPU_KIND, "weights": None}
            mounted = {"repo": found["repo"], "sha": found["sha"], "license": found["license"]}
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
                    "wall_seconds": time.time() - t0, "gpu": GPU_KIND, "weights": mounted}
        return {"status": "ok" if proc.returncode == 0 else "error", "stage": "run",
                "exit_code": proc.returncode, "log_tail": log_tail, "run_seconds": run_seconds,
                "wall_seconds": time.time() - t0, "gpu": GPU_KIND, "weights": mounted}
    except Exception as exc:
        return {"status": "crash", "stage": "sandbox", "error": str(exc)[-1500:], "exit_code": None,
                "log_tail": "", "run_seconds": run_seconds, "wall_seconds": time.time() - t0, "gpu": GPU_KIND,
                "weights": mounted}
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
    fetch = body.get("fetch_weights") if isinstance(body, dict) else None
    if fetch is not None:
        # A request to fetch public weights. It starts the lab's own fetcher
        # and no job, so it must not come with a script.
        if not isinstance(fetch, dict) or body.get("script") is not None or not valid_repo_id(fetch.get("repo")):
            raise HTTPException(status_code=400, detail="fetch_weights needs a repository id as org/name and no script")
        revision = fetch.get("revision") if fetch.get("revision") is not None else "main"
        if not valid_revision(revision):
            raise HTTPException(status_code=400, detail="revision must be a branch, tag or commit sha")
        call = fetch_weights.spawn(fetch["repo"], revision, limits_as_sent(fetch.get("limits")))
        return {"call_id": call.object_id}
    script = body.get("script") if isinstance(body, dict) else None
    if not isinstance(script, str) or not script.strip() or len(script) > MAX_SCRIPT_CHARS:
        raise HTTPException(status_code=400, detail="script missing or too long")
    weights = body.get("weights")
    if weights is None:
        call = run_job.spawn(script)
        return {"call_id": call.object_id}
    sha = weights.get("sha") if isinstance(weights, dict) else None
    if (not isinstance(weights, dict) or not valid_repo_id(weights.get("repo"))
            or (sha is not None and (not isinstance(sha, str) or re.fullmatch(SHA_PATTERN, sha) is None))):
        raise HTTPException(status_code=400, detail="weights needs a repository id as org/name and, if given, a 40 character commit sha")
    ref = {"repo": weights["repo"]}
    if sha is not None:
        ref["sha"] = sha
    if isinstance(weights.get("licenses"), list):
        ref["licenses"] = weights_limits({"licenses": weights["licenses"]})["licenses"]
    call = run_job.spawn(script, ref)
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
