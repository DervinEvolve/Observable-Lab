# Observable Lab: the public dataset shelf (Modal)
#
# A model's code never gets the network, so it cannot download a dataset.
# What a model may do, when LAB_ENABLE_DATASETS is on, is ask the lab for one
# public Hugging Face DATASET repository by id (docs/TOOLS.md, "Public
# datasets"). This app is the lab's own code for that. Nothing a model wrote
# runs here, and nothing downloaded is ever run, imported or loaded as code.
#
#   fetch_dataset   the only function with the network. It reads the hub's
#                   description of one revision, without a token, and refuses
#                   unless all of this holds:
#                     * public and not gated;
#                     * every license the card states is on the lab's list;
#                     * it has data files of the allowed types (parquet, jsonl,
#                       json, csv, tsv, txt, arrow). Only those are downloaded.
#                       Loading scripts, any .py and every other file are never
#                       downloaded;
#                     * the files to download total at most the size limit;
#                     * it fits on the shelf, where the least recently used
#                       entries are removed to make room and an entry in use
#                       is never removed.
#                   Every file is checked against the hash the hub published.
#                   The fetcher does not parse what it downloads.
#   describe_files  counts rows and reads column names for the manifest.
#   read_rows       reads rows of one file for a Tinker training run and maps
#                   two columns into chat examples.
#                   Both parse files a stranger wrote, so both run with the
#                   network blocked, no secrets, no access to other Modal
#                   resources, the shelf mounted read-only, and a fresh
#                   container for every call.
#
# The shelf is the Modal Volume "oblab-datasets", laid out as
# <org>/<name>/<commit sha>/ with the lab's manifest (_lab_manifest.json)
# beside the files. A GPU job that names a dataset gets that one entry
# mounted read-only at /datasets (modal/gpu_jobs.py); its network stays off.
#
# Deploy:  modal deploy modal/datasets.py   (the exact command is in docs/OPERATIONS.md)
# Secret:  modal secret create oblab-datasets-auth JOBS_TOKEN=<random, 32+ chars>
#          (the same value goes in the lab server's DATASETS_TOKEN)
#
# HTTP API (for the Vercel backend), Authorization: Bearer <JOBS_TOKEN> on both:
#   POST /start   {fetch_dataset: {repo, revision?, limits?}}   -> {call_id}
#   POST /start   {read_rows: {repo, sha?, licenses?, file?, user_column, assistant_column, system?, limit?}} -> {call_id}
#   GET  /status  ?call_id=...   -> {status: running} | {status: done, result} | {status: failed, error}
#
# fetch result: {status: ok, cached, repo, sha, license, size_bytes, files, rows, data_files, skipped_files, evicted, wall_seconds}
#             | {status: refused, rule, reason, wall_seconds}
#             | {status: error, stage, error, wall_seconds}
# read result:  {status: ok, repo, sha, license, file, rows_scanned, rows_used, skipped, stopped, bytes, examples, wall_seconds}
#             | {status: refused, rule, reason, wall_seconds}
#             | {status: error, stage, error, wall_seconds}
#
# Every import at the top of this file must be installed in every image below,
# and must import on Python 3.9 (the deploying Mac's Modal may run on it).
# pyarrow is imported inside the two functions that use it.

import csv
import hashlib
import hmac
import inspect
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

APP_NAME = "oblab-datasets"
VOLUME_NAME = "oblab-datasets"
USE_DICT_NAME = "oblab-datasets-use"   # when each shelf entry was last used
SHELF_DIR = "/shelf"                   # writable; mounted in fetch_dataset only
READ_DIR = "/shelf-ro"                 # read-only; mounted in describe_files and read_rows
MANIFEST_NAME = "_lab_manifest.json"
HUB = "https://huggingface.co"
# Defaults when the lab server sends no limits (it sends its own, from
# LAB_DATASETS_LICENSES, LAB_DATASETS_MAX_GB and LAB_DATASETS_SHELF_GB).
DEFAULT_LICENSES = ("apache-2.0", "mit", "cc-by-4.0", "cc-by-sa-4.0", "cc0-1.0", "odc-by", "bsd-3-clause")
DEFAULT_MAX_GB = 1.0
DEFAULT_SHELF_GB = 20.0
# Ceilings the lab server cannot raise.
HARD_MAX_GB = 20.0
HARD_SHELF_GB = 200.0
FETCH_TIMEOUT_S = 900
READ_TIMEOUT_S = 300
# A shelf entry asked for, read or named by a job this recently is not
# removed to make room: a GPU job that has just found it may be about to
# mount it (its own time limit is 300 s), and a read takes seconds.
IN_USE_S = 300
MAX_DATA_FILES = 200
REPO_ID_PATTERN = r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?"
REVISION_PATTERN = r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?"
SHA_PATTERN = r"[0-9a-f]{40}"
LICENSE_PATTERN = r"[a-z0-9][a-z0-9.+-]{0,39}"
SAFE_PATH_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,5}"
COLUMN_PATTERN = r"[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}"
# The only kinds of file the fetcher downloads, by the end of the file name.
DATA_KINDS = (("parquet", ".parquet"), ("jsonl", ".jsonl"), ("json", ".json"), ("csv", ".csv"), ("tsv", ".tsv"),
              ("txt", ".txt"), ("arrow", ".arrow"))
# The kinds with rows and named columns. A txt file is lines of text: a GPU job may read it, a column mapping cannot.
TABULAR_KINDS = ("parquet", "jsonl", "json", "csv", "tsv", "arrow")

# Reading rows for a Tinker training run. The same numbers as api/_lib/tinker.ts
# (TINKER_MAX_EXAMPLE_BYTES, TINKER_MAX_DATASET_BYTES, TINKER_MIN_EXAMPLES and
# TINKER_MAX_EXAMPLES); tests/datasets.test.mjs holds the two files to each other.
MAX_EXAMPLE_BYTES = 6000
MAX_TOTAL_BYTES = 120_000
MIN_ROWS = 10
MAX_ROWS = 2000
DEFAULT_ROWS = 500
MAX_SYSTEM_BYTES = 2000
# How far into a file the reader looks for rows that fit, and how much of one file it will hold in memory.
MAX_SCAN_ROWS = 50_000
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_FIELD_BYTES = 1024 * 1024
MAX_COLUMNS_LISTED = 40
# Time the reader gives to counting rows of one fetch before it leaves the rest unknown.
DESCRIBE_BUDGET_S = 120
# Characters a training example may not hold (the same set as FORBIDDEN_CHARS in api/_lib/tinker.ts).
FORBIDDEN_TEXT = r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]"
# What JavaScript's trim() removes. A cell that is only these is empty to the lab server too.
BLANK_TEXT = r"[\t\n\x0b\x0c\r \xa0  -     　﻿]*"

app = modal.App(APP_NAME)

datasets_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
datasets_use = modal.Dict.from_name(USE_DICT_NAME, create_if_missing=True)

PYTHON_BASE_IMAGE = "python:3.11.18-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd"

# The fetcher and the two endpoints: no parser of any data format is installed.
web_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install("fastapi[standard]==0.162.0")
# The reader: pyarrow for parquet and arrow files, and fastapi because Modal
# imports this whole module in every container and the top of it imports fastapi.
reader_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install("fastapi==0.162.0", "pyarrow==26.0.1")

# A fresh container for every call of the reader, so it always sees the shelf
# as it is now and nothing is left over from the file before. Modal renamed
# the setting; the deploying machine may have either name.
_FUNCTION_SETTINGS = inspect.signature(modal.App.function).parameters
SINGLE_USE = {"single_use_containers": True} if "single_use_containers" in _FUNCTION_SETTINGS else {"max_inputs": 1}


# ---------------------------------------------------------------------------
# The rules. Plain functions with the network, the clock and the shelf passed
# in, so tests/test_datasets.py runs all of them without Modal.
# ---------------------------------------------------------------------------

def valid_repo_id(repo) -> bool:
    """org/name as Hugging Face spells it, and nothing that could be a path trick."""
    return (isinstance(repo, str) and len(repo) <= 193 and re.fullmatch(REPO_ID_PATTERN, repo) is not None
            and ".." not in repo and "--" not in repo and not repo.lower().endswith(".git"))


def valid_revision(revision) -> bool:
    """A branch or tag name without slashes, or a full commit sha."""
    return (isinstance(revision, str) and re.fullmatch(REVISION_PATTERN, revision) is not None
            and ".." not in revision)


def valid_column(name) -> bool:
    """A top-level column name: letters, digits, underscore, dot, hyphen and space, at most 64 characters."""
    return isinstance(name, str) and re.fullmatch(COLUMN_PATTERN, name) is not None and name == name.strip()


def limits_as_sent(raw) -> dict:
    """The lab server's limits as it wrote them, {licenses?, max_gb?, shelf_gb?}, and no other key.
    They are turned into numbers once, by dataset_limits inside the fetch."""
    raw = raw if isinstance(raw, dict) else {}
    return {key: raw[key] for key in ("licenses", "max_gb", "shelf_gb") if key in raw}


def dataset_limits(raw) -> dict:
    """The limits for one fetch: the lab server's, held under this file's ceilings. 1 GB is 10^9 bytes.

    The default licenses apply only when no list was sent. A list that was sent
    is never widened: if none of its entries is a license id the result is an
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
    """Every license the dataset card states, lower case. The card's field and its license: tags are both read."""
    card = info.get("cardData") if isinstance(info.get("cardData"), dict) else {}
    value = card.get("license")
    names = [n.strip().lower() for n in (value if isinstance(value, list) else [value]) if isinstance(n, str) and n.strip()]
    tags = info.get("tags") if isinstance(info.get("tags"), list) else []
    for tag in tags:
        if isinstance(tag, str) and tag.startswith("license:") and tag[8:].strip():
            names.append(tag[8:].strip().lower())
    return sorted(set(names))


def file_kind(path) -> Optional[str]:
    """parquet, jsonl, json, csv, tsv, txt or arrow by the end of the file name, else None.
    None is every file the fetcher leaves on the hub: loading scripts, any .py, archives, images, the card."""
    if not isinstance(path, str):
        return None
    base = path.rsplit("/", 1)[-1].lower()
    for kind, suffix in DATA_KINDS:
        if base.endswith(suffix) and len(base) > len(suffix):
            return kind
    return None


def check_repo(info, repo, limits) -> dict:
    """Every rule that the hub's own description can answer, before one byte of data is downloaded.

    Returns {"ok": True, repo, sha, license, licenses, size_bytes, files, skipped_files}
    or {"ok": False, rule, reason}. `info` is the hub's JSON for one revision of
    a dataset repository with ?blobs=true, read without a token.
    """
    def no(rule, reason):
        return {"ok": False, "rule": rule, "reason": reason}

    if not isinstance(info, dict):
        return no("hub", "the hub's answer was not a dataset description")
    if info.get("id") != repo:
        other = info.get("id")
        return no("repo", f"the hub calls this dataset {other}; ask for it by that id" if valid_repo_id(other)
                  else "the hub did not confirm this dataset id")
    sha = info.get("sha")
    if not isinstance(sha, str) or re.fullmatch(SHA_PATTERN, sha) is None:
        return no("revision", "the hub did not resolve the revision to a commit")
    if info.get("private") is not False or info.get("disabled") is True:
        return no("not_public", "the dataset is private or disabled")
    if info.get("gated") is not False:
        return no("gated", "the dataset is gated (its terms need an account), and the lab uses no Hugging Face token")
    licenses = repo_licenses(info)
    if not licenses:
        return no("license", "the dataset states no license")
    for name in licenses:
        if name not in limits["licenses"]:
            return no("license", f"license {name[:40]} is not on the lab's list ({', '.join(limits['licenses']) or 'the list is empty'})")
    siblings = info.get("siblings")
    if not isinstance(siblings, list) or not siblings:
        return no("hub", "the hub listed no files")
    for entry in siblings:
        if not isinstance(entry, dict) or not isinstance(entry.get("rfilename"), str):
            return no("hub", "the hub's file list could not be read")
    wanted = [entry for entry in siblings if file_kind(entry["rfilename"]) is not None]
    if not wanted:
        return no("format", "the dataset has no parquet, jsonl, json, csv, tsv, txt or arrow file; the lab downloads "
                            "only those and never runs a loading script")
    if len(wanted) > MAX_DATA_FILES:
        return no("files", f"more than {MAX_DATA_FILES} data files to download")
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
        files.append({"path": path, "kind": file_kind(path), "size": size, "sha256": sha256, "git_sha1": git_sha1})
        total += size
    if total > limits["max_bytes"]:
        return no("size", f"its data files total {total / 1e9:.2f} GB, over the limit of {limits['max_bytes'] / 1e9:g} GB")
    return {"ok": True, "repo": repo, "sha": sha, "license": ", ".join(licenses), "licenses": licenses,
            "size_bytes": total, "files": files, "skipped_files": len(siblings) - len(wanted)}


def valid_manifest(m) -> bool:
    return (isinstance(m, dict) and valid_repo_id(m.get("repo"))
            and isinstance(m.get("sha"), str) and re.fullmatch(SHA_PATTERN, m["sha"]) is not None
            and isinstance(m.get("size_bytes"), int) and not isinstance(m.get("size_bytes"), bool) and m["size_bytes"] >= 0
            and isinstance(m.get("license"), str) and isinstance(m.get("licenses"), list)
            and isinstance(m.get("files"), list))


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
    """Keys of the shelf entries asked for, read or named by a job in the last `window_s` seconds."""
    return {e["key"] for e in entries if now_value - e["last_used"] < window_s}


def clean_description(described, paths) -> dict:
    """What describe_files said about each file, kept only where it has the shape the manifest stores:
    path -> {rows: a count or None, columns: a short list of column names or None}."""
    out = {}
    described = described if isinstance(described, dict) else {}
    for path in paths:
        item = described.get(path) if isinstance(described.get(path), dict) else {}
        rows = item.get("rows")
        rows = rows if isinstance(rows, int) and not isinstance(rows, bool) and 0 <= rows < 10 ** 12 else None
        columns = item.get("columns")
        columns = [c for c in columns if valid_column(c)][:MAX_COLUMNS_LISTED] if isinstance(columns, list) else None
        out[path] = {"rows": rows, "columns": columns or None}
    return out


def data_files_summary(files) -> list:
    """The first few data files of a manifest as the lab server is told about them: path, kind, rows and columns."""
    out = []
    for f in (files if isinstance(files, list) else [])[:12]:
        if isinstance(f, dict) and isinstance(f.get("path"), str):
            out.append({"path": f["path"][:200], "kind": f.get("kind"), "rows": f.get("rows"),
                        "columns": (f.get("columns") or [])[:12] or None})
    return out


def fetch_core(repo, revision, limits, root, hub_info, hub_download, used, now, describe=None) -> dict:
    """One whole fetch. `hub_info(repo, revision) -> (http_status, json or None)`
    and `hub_download(repo, sha, path, dest, declared_size) -> {size, sha256, git_sha1}`
    are the only network; `used` maps "repo@sha" to when it was last used;
    `describe(repo, sha, paths) -> {path: {rows, columns}}` asks the reader,
    which has no network, what the downloaded files hold. Nothing here opens
    a downloaded file to parse it."""
    if not valid_repo_id(repo):
        return {"status": "refused", "rule": "repo", "reason": "the dataset id must be org/name"}
    revision = revision or "main"
    if not valid_revision(revision):
        return {"status": "refused", "rule": "revision", "reason": "the revision must be a branch, tag or commit sha"}
    limits = dataset_limits(limits)
    code, info = hub_info(repo, revision)
    if code in (401, 403, 404):
        return {"status": "refused", "rule": "not_public",
                "reason": "the hub shows no public dataset or revision by that name (a private or gated one "
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
                "size_bytes": manifest["size_bytes"], "files": len(manifest["files"]), "rows": manifest.get("rows"),
                "data_files": data_files_summary(manifest["files"]), "skipped_files": manifest.get("skipped_files"),
                "evicted": []}

    # Entries in use just now are kept. This first plan only stops a download
    # that could not fit; what is removed is decided again after the download,
    # which can take minutes, from what is in use then.
    no_room = {"status": "refused", "rule": "shelf",
               "reason": "it does not fit on the lab's shelf (datasets used in the last few minutes are not removed to make room)"}
    if plan_eviction(entries, checked["size_bytes"], limits["shelf_bytes"], keep=in_use(entries, now())) is None:
        return no_room

    records = []
    try:
        os.makedirs(target, exist_ok=True)
        for f in sorted(checked["files"], key=lambda f: (f["size"], f["path"])):
            dest = os.path.join(target, *f["path"].split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            got = hub_download(repo, sha, f["path"], dest, f["size"])
            if got["size"] != f["size"]:
                raise ValueError(f"{f['path']}: {got['size']} bytes arrived, the hub said {f['size']}")
            if f["sha256"] and got["sha256"] != f["sha256"]:
                raise ValueError(f"{f['path']}: sha256 does not match the hub's")
            if f["git_sha1"] and got["git_sha1"] != f["git_sha1"]:
                raise ValueError(f"{f['path']}: content does not match the hub's blob id")
            records.append({"path": f["path"], "kind": f["kind"], "size": got["size"], "sha256": got["sha256"]})
        records.sort(key=lambda r: r["path"])

        # Rows and column names, from the reader. Its answer is data: only
        # counts and plain column names are kept, and a reader that fails
        # leaves them unknown without failing the fetch.
        paths = [r["path"] for r in records]
        try:
            described = clean_description(describe(repo, sha, paths) if describe else None, paths)
        except Exception:
            described = clean_description(None, paths)
        for r in records:
            r["rows"] = described[r["path"]]["rows"]
            r["columns"] = described[r["path"]]["columns"]
        tabular = [r for r in records if r["kind"] in TABULAR_KINDS]
        rows = sum(r["rows"] for r in tabular) if tabular and all(r["rows"] is not None for r in tabular) else None

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
            "size_bytes": checked["size_bytes"], "files": records, "rows": rows,
            "skipped_files": checked["skipped_files"],
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(fetched)), "fetched_at_unix": fetched,
            "source": f"{HUB}/datasets/{repo}/tree/{sha}", "token_used": False,
            "fetched_by": "observable-lab modal/datasets.py fetch_dataset",
            "note": "Only data files were downloaded. Rows and columns were counted by the lab's reader; null means not counted.",
        }
        # The manifest is written last: an entry counts only once it has one.
        with open(os.path.join(target, MANIFEST_NAME), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=1)
    except Exception as exc:
        shutil.rmtree(target, ignore_errors=True)
        return {"status": "error", "stage": "download", "error": str(exc)[-1500:]}
    touch()
    return {"status": "ok", "cached": False, "repo": repo, "sha": sha, "license": checked["license"],
            "size_bytes": checked["size_bytes"], "files": len(records), "rows": rows,
            "data_files": data_files_summary(records), "skipped_files": checked["skipped_files"], "evicted": evicted}


def shelf_lookup(ref, manifest_at, shas_of) -> dict:
    """Which shelf entry {repo, sha?, licenses?} means: that commit, or the
    newest one fetched for the repository. {"ok": False, error} when it is
    not there."""
    if not isinstance(ref, dict) or not valid_repo_id(ref.get("repo")):
        return {"ok": False, "error": "a dataset must be named as org/name"}
    repo, sha = ref["repo"], ref.get("sha")
    if sha is not None and (not isinstance(sha, str) or re.fullmatch(SHA_PATTERN, sha) is None):
        return {"ok": False, "error": "the dataset commit must be a 40 character sha"}
    candidates = [sha] if sha else [s for s in shas_of(repo) if isinstance(s, str) and re.fullmatch(SHA_PATTERN, s)]
    found = []
    for candidate in candidates[:50]:
        manifest = manifest_at(repo, candidate)
        if valid_manifest(manifest) and manifest["repo"] == repo and manifest["sha"] == candidate:
            found.append(manifest)
    if not found:
        return {"ok": False, "error": f"{repo} is not on the lab's dataset shelf; ask for it with the datasets tool first"}
    manifest = max(found, key=lambda m: m.get("fetched_at_unix") if isinstance(m.get("fetched_at_unix"), (int, float)) else 0)
    allowed = ref.get("licenses")
    if isinstance(allowed, list) and any(name not in allowed for name in manifest["licenses"]):
        return {"ok": False, "error": f"{repo} is on the shelf under a license ({manifest['license'][:60]}) that is no longer on the lab's list"}
    return {"ok": True, "repo": repo, "sha": manifest["sha"], "license": manifest["license"],
            "size_bytes": manifest["size_bytes"], "manifest": manifest}


# ---------------------------------------------------------------------------
# Reading the files. Only describe_files and read_rows use these, and both
# run without the network. Every file is opened as data and nothing else:
# no code in a file is run, and no loader that could run code is used.
# ---------------------------------------------------------------------------

def open_data_file(root, repo, sha, path):
    """The path of one data file of one shelf entry, or None. The file must be
    a regular file inside the entry: no link is followed out of it."""
    if not valid_repo_id(repo) or not isinstance(sha, str) or re.fullmatch(SHA_PATTERN, sha) is None:
        return None
    if not isinstance(path, str) or re.fullmatch(SAFE_PATH_PATTERN, path) is None or ".." in path:
        return None
    entry = os.path.realpath(os.path.join(root, *repo.split("/"), sha))
    full = os.path.join(entry, *path.split("/"))
    if os.path.realpath(full) != full or os.path.islink(full) or not os.path.isfile(full):
        return None
    return full


def _text_lines(full):
    """Lines of a text file as str, each at most MAX_FIELD_BYTES. Bytes that are not UTF-8 become lone surrogates, which no example may hold."""
    with open(full, "r", encoding="utf-8", errors="surrogateescape", newline="") as fh:
        while True:
            line = fh.readline(MAX_FIELD_BYTES + 1)
            if not line:
                return
            if len(line) > MAX_FIELD_BYTES and not line.endswith("\n"):
                # A line too long to be a row: the rest of it is skipped, and the row is reported as unreadable.
                while True:
                    more = fh.readline(MAX_FIELD_BYTES + 1)
                    if not more or more.endswith("\n"):
                        break
                yield None
                continue
            yield line


def iter_rows(full, kind, columns=None):
    """Rows of one data file as dicts, in file order. A row that is not an
    object (or cannot be read) comes out as None. `columns`, when given, are
    the only ones a parquet or arrow file is asked for; a column that is not
    there raises KeyError with its name."""
    if kind == "jsonl":
        for line in _text_lines(full):
            if line is None:
                yield None
                continue
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except (ValueError, RecursionError):
                row = None
            yield row if isinstance(row, dict) else None
    elif kind == "json":
        if os.path.getsize(full) > MAX_JSON_BYTES:
            raise ValueError(f"a .json file over {MAX_JSON_BYTES // (1024 * 1024)} MB is not read (it has to be loaded whole)")
        with open(full, "r", encoding="utf-8", errors="surrogateescape") as fh:
            try:
                data = json.load(fh)
            except RecursionError:
                raise ValueError("the .json file is nested too deeply to read")
        if not isinstance(data, list):
            raise ValueError("the .json file is not a list of rows")
        for row in data:
            yield row if isinstance(row, dict) else None
    elif kind in ("csv", "tsv"):
        csv.field_size_limit(MAX_FIELD_BYTES)
        with open(full, "r", encoding="utf-8", errors="surrogateescape", newline="") as fh:
            reader = csv.reader(fh, delimiter="\t" if kind == "tsv" else ",")
            try:
                header = next(reader)
            except StopIteration:
                return
            if header and header[0].startswith("﻿"):
                header[0] = header[0][1:]
            for name in (columns or []):
                if name not in header:
                    raise KeyError(name)
            while True:
                try:
                    cells = next(reader)
                except StopIteration:
                    return
                except csv.Error:
                    yield None
                    continue
                if not cells:
                    continue
                yield dict(zip(header, cells)) if len(cells) == len(header) else None
    elif kind == "parquet":
        import pyarrow.parquet as pq
        source = pq.ParquetFile(full)
        names = list(source.schema_arrow.names)
        for name in (columns or []):
            if name not in names:
                raise KeyError(name)
        for batch in source.iter_batches(batch_size=256, columns=list(columns) if columns else None):
            for row in batch.to_pylist():
                yield row
    elif kind == "arrow":
        import pyarrow as pa
        with pa.OSFile(full, "rb") as fh:
            try:
                reader = pa.ipc.open_file(fh)
                batches = (reader.get_batch(i) for i in range(reader.num_record_batches))
            except pa.ArrowInvalid:
                fh.seek(0)
                reader = pa.ipc.open_stream(fh)
                batches = iter(reader)
            names = list(reader.schema.names)
            for name in (columns or []):
                if name not in names:
                    raise KeyError(name)
            for batch in batches:
                if columns:
                    batch = batch.select(list(columns))
                for row in batch.to_pylist():
                    yield row
    else:
        raise ValueError("this kind of file has no rows with named columns")


def describe_one(full, kind, deadline, clock=time.time) -> dict:
    """{rows, columns} for one file, each None when it was not found out. Reads; never runs anything."""
    rows, columns = None, None
    if kind == "txt":
        count = 0
        with open(full, "rb") as fh:
            while True:
                chunk = fh.read(4 * 1024 * 1024)
                if not chunk:
                    break
                count += chunk.count(b"\n")
                if clock() > deadline:
                    return {"rows": None, "columns": None}
        return {"rows": count, "columns": None}
    if kind == "parquet":
        import pyarrow.parquet as pq
        source = pq.ParquetFile(full)
        return {"rows": int(source.metadata.num_rows), "columns": [str(n) for n in source.schema_arrow.names]}
    if kind in ("csv", "tsv"):
        # The header names the columns, whether or not a row follows it.
        with open(full, "r", encoding="utf-8", errors="surrogateescape", newline="") as fh:
            try:
                header = next(csv.reader(fh, delimiter="\t" if kind == "tsv" else ","))
            except (StopIteration, csv.Error):
                header = []
        if header and header[0].startswith("\ufeff"):
            header[0] = header[0][1:]
        columns = [str(name) for name in header[:200]] or None
    count = 0
    for row in iter_rows(full, kind):
        if columns is None and isinstance(row, dict):
            columns = [str(k) for k in list(row.keys())[:200]]
        count += 1
        if count % 2048 == 0 and clock() > deadline:
            return {"rows": None, "columns": columns}
    rows = count
    return {"rows": rows, "columns": columns}


def describe_core(root, repo, sha, paths, clock=time.time) -> dict:
    """path -> {rows, columns} for the data files of one download. A file that cannot be read is left unknown."""
    out = {}
    deadline = clock() + DESCRIBE_BUDGET_S
    for path in (paths if isinstance(paths, list) else [])[:MAX_DATA_FILES]:
        kind = file_kind(path)
        full = open_data_file(root, repo, sha, path) if kind else None
        if full is None:
            continue
        try:
            out[path] = describe_one(full, kind, deadline, clock) if clock() <= deadline else {"rows": None, "columns": None}
        except Exception:
            out[path] = {"rows": None, "columns": None}
    return out


def check_read(spec) -> Optional[str]:
    """None when a read request is well formed, else what is wrong with it."""
    if not isinstance(spec, dict):
        return "the read request is not an object"
    extra = [k for k in spec if k not in ("repo", "sha", "licenses", "file", "user_column", "assistant_column", "system", "limit")]
    if extra:
        return "the read request has a field the reader does not know"
    if not valid_repo_id(spec.get("repo")):
        return "the dataset must be named as org/name"
    sha = spec.get("sha")
    if sha is not None and (not isinstance(sha, str) or re.fullmatch(SHA_PATTERN, sha) is None):
        return "the dataset commit must be a 40 character sha"
    if spec.get("licenses") is not None and not isinstance(spec.get("licenses"), list):
        return "licenses is not a list"
    path = spec.get("file")
    if path is not None and (not isinstance(path, str) or re.fullmatch(SAFE_PATH_PATTERN, path) is None or ".." in path):
        return "file is not a path inside the dataset"
    if not valid_column(spec.get("user_column")) or not valid_column(spec.get("assistant_column")):
        return "user_column and assistant_column must be column names"
    if spec["user_column"] == spec["assistant_column"]:
        return "user_column and assistant_column must be different columns"
    system = spec.get("system")
    if system is not None:
        if not isinstance(system, str) or re.fullmatch(BLANK_TEXT, system) is not None:
            return "system must be non-empty text when it is given"
        if re.search(FORBIDDEN_TEXT, system) or len(system.encode("utf-8")) > MAX_SYSTEM_BYTES:
            return f"system holds a control character or more than {MAX_SYSTEM_BYTES} bytes"
    limit = spec.get("limit")
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < MIN_ROWS or limit > MAX_ROWS):
        return f"limit must be a whole number from {MIN_ROWS} to {MAX_ROWS}"
    return None


def map_row(row, user_column, assistant_column, system):
    """One row as a chat example, or the reason it is left out.

    Returns ({"messages": [...]}, bytes of text) or (None, reason). The cell
    text is used exactly as it is in the file: nothing is trimmed or cut to fit.
    """
    if not isinstance(row, dict):
        return None, "not_a_row"
    if user_column not in row or assistant_column not in row:
        return None, "column_missing"
    user, assistant = row[user_column], row[assistant_column]
    if not isinstance(user, str) or not isinstance(assistant, str):
        return None, "not_text"
    if re.fullmatch(BLANK_TEXT, user) is not None or re.fullmatch(BLANK_TEXT, assistant) is not None:
        return None, "empty"
    if re.search(FORBIDDEN_TEXT, user) or re.search(FORBIDDEN_TEXT, assistant):
        return None, "bad_text"
    size = len(user.encode("utf-8")) + len(assistant.encode("utf-8")) + (len(system.encode("utf-8")) if system else 0)
    if size > MAX_EXAMPLE_BYTES:
        return None, "too_long"
    messages = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": user}, {"role": "assistant", "content": assistant}]
    return {"messages": messages}, size


def choose_file(manifest, asked):
    """(file record, None) or (None, why not). With no file named, the entry must hold exactly one file with rows and columns."""
    tabular = [f for f in manifest.get("files") or [] if isinstance(f, dict) and f.get("kind") in TABULAR_KINDS
               and isinstance(f.get("path"), str) and file_kind(f["path"]) == f.get("kind")]
    listed = ", ".join(f["path"] for f in tabular[:20]) + (", ..." if len(tabular) > 20 else "")
    if asked is not None:
        for f in tabular:
            if f["path"] == asked:
                return f, None
        return None, f"{asked[:120]} is not a file with rows and columns in this dataset (it holds: {listed or 'none'})"
    if not tabular:
        return None, "this dataset holds no file with rows and named columns (a txt file has none)"
    if len(tabular) > 1:
        return None, f"this dataset holds {len(tabular)} files with rows; name one with \"file\" (it holds: {listed})"
    return tabular[0], None


def read_rows_core(spec, root, used, now, rows_of=iter_rows) -> dict:
    """Reads rows of one file of one shelf entry and maps two columns into chat examples.

    The first rows that fit are used, in file order. A row is left out, and
    counted by reason, when a cell is missing, not text, empty, holds a
    control character, is over the per-example limit, or repeats an earlier
    row. Reading stops at the row limit, at the total size limit, at the end
    of the file, or after MAX_SCAN_ROWS rows. Nothing is cut to fit.
    """
    problem = check_read(spec)
    if problem:
        return {"status": "refused", "rule": "request", "reason": problem}
    found = shelf_lookup(
        {k: spec[k] for k in ("repo", "sha", "licenses") if spec.get(k) is not None},
        lambda repo, sha: read_manifest(os.path.join(root, *repo.split("/"), sha)),
        lambda repo: sorted(os.listdir(os.path.join(root, *repo.split("/")))) if os.path.isdir(os.path.join(root, *repo.split("/"))) else [],
    )
    if not found["ok"]:
        return {"status": "refused", "rule": "shelf", "reason": found["error"]}
    repo, sha = found["repo"], found["sha"]
    record, why = choose_file(found["manifest"], spec.get("file"))
    if record is None:
        return {"status": "refused", "rule": "file", "reason": why}
    full = open_data_file(root, repo, sha, record["path"])
    if full is None:
        return {"status": "error", "stage": "file", "error": f"{record['path'][:120]} could not be opened on the shelf"}
    try:
        used[f"{repo}@{sha}"] = now()
    except Exception:
        pass  # only the shelf's least-recently-used order depends on it

    user_column, assistant_column = spec["user_column"], spec["assistant_column"]
    system = spec.get("system")
    limit = spec.get("limit") or DEFAULT_ROWS
    examples, seen, skipped = [], set(), {}
    scanned, total, stopped = 0, 0, "end_of_file"
    try:
        for row in rows_of(full, record["kind"], [user_column, assistant_column]):
            if scanned >= MAX_SCAN_ROWS:
                stopped = "scan_limit"
                break
            scanned += 1
            example, size = map_row(row, user_column, assistant_column, system)
            if example is None:
                reason = size  # map_row's second value is the reason when there is no example
                skipped[reason] = skipped.get(reason, 0) + 1
                continue
            mark = hashlib.sha256(json.dumps(example["messages"], ensure_ascii=False).encode("utf-8")).digest()
            if mark in seen:
                skipped["duplicate"] = skipped.get("duplicate", 0) + 1
                continue
            if total + size > MAX_TOTAL_BYTES:
                stopped = "total_bytes"
                break
            seen.add(mark)
            examples.append(example)
            total += size
            if len(examples) >= limit:
                stopped = "limit"
                break
    except KeyError as exc:
        name = str(exc.args[0]) if exc.args else ""
        return {"status": "refused", "rule": "columns",
                "reason": f"{record['path'][:120]} has no column named {name[:64]}"
                          + (f" (its columns: {', '.join((record.get('columns') or [])[:20])})" if record.get("columns") else "")}
    except Exception as exc:
        return {"status": "error", "stage": "read", "error": f"{record['path'][:120]} could not be read: {type(exc).__name__}: {str(exc)[:300]}"}
    # A file whose rows never had the columns is a wrong mapping, not an empty dataset.
    if not examples and scanned and skipped.get("column_missing") == scanned:
        return {"status": "refused", "rule": "columns",
                "reason": f"no row of {record['path'][:120]} has both columns {user_column} and {assistant_column}"}
    return {"status": "ok", "repo": repo, "sha": sha, "license": found["license"], "file": record["path"],
            "rows_scanned": scanned, "rows_used": len(examples), "skipped": skipped, "stopped": stopped,
            "bytes": total, "examples": examples}


# ---------------------------------------------------------------------------
# The network. Only fetch_dataset uses these.
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
    return opener.open(urllib.request.Request(url, headers={"User-Agent": "observable-lab-datasets"}), timeout=timeout)


def hub_info(repo, revision):
    """(HTTP status, the hub's JSON for that revision of a dataset, with file sizes and hashes)."""
    url = f"{HUB}/api/datasets/{repo}/revision/{urllib.parse.quote(revision, safe='')}?blobs=true"
    try:
        with _hub_open(url, 30) as res:
            body = res.read(32 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        return exc.code, None
    if len(body) > 32 * 1024 * 1024:
        raise ValueError("the hub's description of the dataset is too large")
    return 200, json.loads(body)


def hub_download(repo, sha, path, dest, declared_size):
    """Streams one file of one commit to `dest`, hashing as it goes. Stops if
    more arrives than the hub said the file holds."""
    url = f"{HUB}/datasets/{repo}/resolve/{sha}/{urllib.parse.quote(path)}"
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
    """A shelf entry's manifest, read through Modal's API (the endpoints mount no volume)."""
    try:
        return json.loads(b"".join(datasets_volume.read_file(f"{repo}/{sha}/{MANIFEST_NAME}")))
    except Exception:
        return None


def _volume_shas(repo):
    try:
        return [entry.path.rstrip("/").rsplit("/", 1)[-1] for entry in datasets_volume.listdir(repo)]
    except Exception:
        return []


def _describe_remote(repo, sha, paths):
    """Asks the reader about files just downloaded. They are committed first so that its container can see them;
    until the manifest is written they are still not a shelf entry."""
    datasets_volume.commit()
    return describe_files.remote(repo, sha, paths)


@app.function(image=web_image, volumes={SHELF_DIR: datasets_volume}, timeout=FETCH_TIMEOUT_S, retries=0,
              max_containers=1, cpu=(1, 2), memory=(1024, 4096))
def fetch_dataset(repo: str, revision: str = "main", limits: Optional[dict] = None) -> dict:
    """Fetches one public dataset repository onto the shelf, or says why not.

    This is lab code. It is the only function here that downloads anything,
    it holds no credentials, and it never runs, imports or parses what it
    downloads. One container at a time, so two fetches never write the shelf
    together.
    """
    t0 = time.time()
    try:
        datasets_volume.reload()
        result = fetch_core(repo, revision, limits, SHELF_DIR, hub_info, hub_download, datasets_use, time.time, _describe_remote)
        datasets_volume.commit()
    except Exception as exc:
        result = {"status": "error", "stage": "fetcher", "error": str(exc)[-1500:]}
    result["wall_seconds"] = time.time() - t0
    return result


@app.function(image=reader_image, volumes={READ_DIR: datasets_volume.read_only()}, timeout=READ_TIMEOUT_S, retries=0,
              block_network=True, restrict_modal_access=True, cpu=(1, 2), memory=(2048, 8192), **SINGLE_USE)
def describe_files(repo: str, sha: str, paths: list) -> dict:
    """Rows and column names of files the fetcher just downloaded. No network, no secrets, the shelf read-only."""
    try:
        return describe_core(READ_DIR, repo, sha, paths)
    except Exception:
        return {}


@app.function(image=reader_image, volumes={READ_DIR: datasets_volume.read_only()}, timeout=READ_TIMEOUT_S, retries=0,
              block_network=True, restrict_modal_access=True, cpu=(1, 2), memory=(2048, 8192), **SINGLE_USE)
def read_rows(spec: dict) -> dict:
    """Rows of one shelf file as chat examples for a Tinker training run. No network, no secrets, the shelf read-only.

    The Tinker key is not here and never comes here: this function hands the
    examples back to the lab server, which estimates the run's cost from them
    before anything is set aside or started.
    """
    t0 = time.time()
    try:
        result = read_rows_core(spec, READ_DIR, {}, time.time)
    except Exception as exc:
        result = {"status": "error", "stage": "reader", "error": str(exc)[-600:]}
    result["wall_seconds"] = time.time() - t0
    return result


def _authed(token: str) -> bool:
    expected = os.environ.get("JOBS_TOKEN", "")
    return len(expected.encode()) >= 32 and hmac.compare_digest(token.encode(), f"Bearer {expected}".encode())


def pin_read(spec, manifest_at, shas_of, used, now) -> dict:
    """The read request as the reader gets it. The endpoint, which may reach
    Modal's Dict, finds the entry first: it marks it as in use, so a fetch
    running beside the read does not remove it, and names its commit, so the
    reader reads exactly that one. A dataset that is not on the shelf goes on
    unchanged and the reader says so."""
    out = {k: spec[k] for k in ("repo", "sha", "licenses", "file", "user_column", "assistant_column", "system", "limit")
           if spec.get(k) is not None}
    if isinstance(out.get("licenses"), list):
        out["licenses"] = dataset_limits({"licenses": out["licenses"]})["licenses"]
    found = shelf_lookup({k: out[k] for k in ("repo", "sha", "licenses") if k in out}, manifest_at, shas_of)
    if found["ok"]:
        out["sha"] = found["sha"]
        try:
            used[f"{found['repo']}@{found['sha']}"] = now()
        except Exception:
            pass
    return out


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-datasets-auth")])
@modal.fastapi_endpoint(method="POST")
def start(body: dict, request: Request) -> dict:
    if not _authed(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    kinds = [k for k in ("fetch_dataset", "read_rows") if isinstance(body, dict) and k in body]
    if len(kinds) != 1:
        raise HTTPException(status_code=400, detail="a start holds one of fetch_dataset and read_rows")
    if kinds[0] == "fetch_dataset":
        fetch = body["fetch_dataset"]
        if not isinstance(fetch, dict) or not valid_repo_id(fetch.get("repo")):
            raise HTTPException(status_code=400, detail="fetch_dataset needs a dataset id as org/name")
        revision = fetch.get("revision") if fetch.get("revision") is not None else "main"
        if not valid_revision(revision):
            raise HTTPException(status_code=400, detail="revision must be a branch, tag or commit sha")
        call = fetch_dataset.spawn(fetch["repo"], revision, limits_as_sent(fetch.get("limits")))
        return {"call_id": call.object_id}
    spec = body["read_rows"]
    problem = check_read(spec)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    call = read_rows.spawn(pin_read(spec, _volume_manifest, _volume_shas, datasets_use, time.time))
    return {"call_id": call.object_id}


@app.function(image=web_image, secrets=[modal.Secret.from_name("oblab-datasets-auth")])
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
        return {"status": "failed", "error": "the result expired before it was collected"}
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:
        return {"status": "failed", "error": str(e)[-1500:]}
