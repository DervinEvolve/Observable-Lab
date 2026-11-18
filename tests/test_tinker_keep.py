"""Keeping a trained adapter in the runner (modal/tinker_jobs.py), tested without Modal or Tinker.

What is checked: a training run saves its weights for download only when the
lab asks; a keep sets the checkpoint's time to live and writes a copy with a
manifest under the adapter's own folder, within its size limit and never
outside it; a failed copy never undoes the keep; an unkeep puts the usual time
to live back and removes the copy only when asked; and the start endpoint
takes a keep only under a keep's name. Tinker and the Volume are fakes behind
the few calls keep_core makes; the folder is a temporary one.
Run: python -m unittest discover -s tests
"""
import io
import json
import os
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_tinker_jobs import KEY, SOURCE, TOKEN, Clock, FakeDeps, M, job, load

RUN = "11111111-2222-3333-4444-555555555555:train:0"
SAMPLER = "tinker://%s/sampler_weights/final" % RUN
EXTERNAL = "tinker://%s/external_weights/final" % RUN
SLUG = "e41-0a1b2c3d"
YEAR = 365 * 86400
MANIFEST = {
    "schema": "observable-lab/kept-adapter/1", "lab_id": "lab/%s" % SLUG, "name": "Brass Finch", "base_model": "Qwen/Qwen3.5-4B",
    "tinker_run_id": RUN, "dataset": {"sha256": "ab" * 32, "examples": 20, "bytes": 900},
    "measured_by_the_lab": {"holdout_loss_before": 2.9, "holdout_loss_after": 1.1},
    "kept_by": "the owner", "kept_reason": "the best one so far", "kept_at": "2026-11-18T12:00:00.000Z",
}
WEIGHTS = {"adapter_config.json": b'{"r": 16}', "adapter_model.safetensors": b"\x00" * 2048}


def keep_job(**changes):
    base = {
        "slug": SLUG, "base_model": "Qwen/Qwen3.5-4B", "sampler_path": SAMPLER, "external_path": EXTERNAL,
        "ttl_seconds": YEAR, "max_bytes": 1024 * 1024, "manifest": dict(MANIFEST),
    }
    base.update(changes)
    return base


def unkeep_job(**changes):
    base = {"slug": SLUG, "sampler_path": SAMPLER, "external_path": EXTERNAL, "ttl_seconds": 14 * 86400, "remove_copy": False}
    base.update(changes)
    return base


class FakeKeep:
    """Tinker's checkpoint calls and the Volume, counting what they are asked to do."""

    def __init__(self, files=None, peft=True, fail_ttl=None, count=37, urls=None):
        self.files = dict(WEIGHTS if files is None else files)
        self.peft = peft
        self.fail_ttl = fail_ttl or set()
        self.count = count
        self.urls = urls
        self.ttls = []
        self.fetched = []
        self.commits = 0

    def secrets(self):
        return [KEY]

    def set_ttl(self, path, ttl_seconds):
        if path in self.fail_ttl:
            raise RuntimeError("404 for %s with key %s" % (path, KEY))
        self.ttls.append((path, ttl_seconds))

    def checkpoint_count(self):
        if self.count == "broken":
            raise RuntimeError("listing is down")
        return self.count

    def external_urls(self, path):
        if self.urls is not None:
            return self.urls
        return {name: "https://signed.example/%s?sig=1" % name for name in self.files}

    def fetch(self, url, target, max_bytes):
        name = url.split("/")[-1].split("?")[0]
        data = self.files[name]
        self.fetched.append((name, max_bytes))
        if len(data) > max_bytes:
            return None
        with open(target, "wb") as out:
            out.write(data)
        return len(data)

    def to_peft(self, base_model, source, target):
        if not self.peft:
            raise RuntimeError("this model family has no PEFT mapping (key %s)" % KEY)
        os.makedirs(target)
        shutil.copy(os.path.join(source, "adapter_model.safetensors"), os.path.join(target, "adapter_model.safetensors"))
        with open(os.path.join(target, "adapter_config.json"), "w") as out:
            json.dump({"peft_type": "LORA", "base_model_name_or_path": base_model}, out)

    def commit(self):
        self.commits += 1


class Folder(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="oblab-kept-test-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def keep(self, j, deps=None, **options):
        deps = deps or FakeKeep(**options)
        logs = []
        result = M.keep_core(j, lambda: deps, root=self.root, clock=Clock(), log=logs.append)
        return result, deps, logs

    def unkeep(self, j, deps=None):
        deps = deps or FakeKeep()
        logs = []
        return M.unkeep_core(j, lambda: deps, root=self.root, clock=Clock(), log=logs.append), deps, logs

    def tree(self):
        out = []
        for base, _, names in os.walk(self.root):
            out.extend(os.path.relpath(os.path.join(base, n), self.root) for n in names)
        return sorted(out)


class ExportAtTrainingTests(unittest.TestCase):
    def run_job(self, j, external=EXTERNAL):
        made = []

        class Deps(FakeDeps):
            def save_external(self, ttl_seconds):
                self.exported = ttl_seconds
                if isinstance(external, Exception):
                    raise external
                return external

        def make(checked):
            made.append(Deps(checked))
            return made[-1]

        return M.run_core(j, make, clock=Clock(), log=lambda _: None), made[0]

    def test_weights_are_saved_for_download_only_when_the_lab_asks(self):
        plain, deps = self.run_job(job())
        self.assertEqual(plain["status"], "ok")
        self.assertNotIn("external_path", plain)
        self.assertNotIn("export_error", plain)
        self.assertFalse(hasattr(deps, "exported"))
        asked, deps = self.run_job(job(export=True))
        self.assertEqual((asked["status"], asked["external_path"]), ("ok", EXTERNAL))
        # Saved with the same time to live as the adapter, so it never outlives it unnoticed.
        self.assertEqual(deps.exported, 14 * 86400)
        off, deps = self.run_job(job(export=False))
        self.assertNotIn("external_path", off)
        self.assertFalse(hasattr(deps, "exported"))

    def test_a_failed_save_for_download_does_not_undo_the_run(self):
        result, _ = self.run_job(job(export=True), external=RuntimeError("storage limit reached, key %s" % KEY))
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["sampler_path"].startswith("tinker://"))
        self.assertNotIn("external_path", result)
        self.assertIn("storage limit reached", result["export_error"])
        self.assertNotIn(KEY, json.dumps(result))
        self.assertEqual(len(result["samples"]), 2)
        # A path that is not downloadable weights is not passed on as one.
        odd, _ = self.run_job(job(export=True), external=SAMPLER)
        self.assertNotIn("external_path", odd)
        self.assertEqual(odd["export_error"], "the weights were not saved for download")

    def test_export_must_be_a_boolean(self):
        self.assertIsNone(M.check_job(job(export=True)))
        self.assertEqual(M.check_job(job(export="yes")), "export must be true or false")


class CheckKeepTests(unittest.TestCase):
    def test_a_well_formed_keep_is_accepted(self):
        self.assertIsNone(M.check_keep(keep_job()))
        self.assertIsNone(M.check_keep(keep_job(external_path=None)))
        self.assertIsNone(M.check_unkeep(unkeep_job()))
        self.assertIsNone(M.check_unkeep(unkeep_job(external_path=None, remove_copy=True)))

    def test_anything_else_is_refused_with_a_reason(self):
        other = "tinker://99999999-0000-0000-0000-000000000000:train:0/external_weights/final"
        cases = [
            (None, "not an object"), ("keep", "not an object"),
            (keep_job(slug="../etc"), "slug"), (keep_job(slug="e41-0A1B2C3D"), "slug"), (keep_job(slug=7), "slug"),
            (keep_job(base_model="someone/else"), "base_model"),
            (keep_job(sampler_path=EXTERNAL), "sampler_path"), (keep_job(sampler_path="tinker://x/weights/final"), "sampler_path"),
            (keep_job(sampler_path="https://example.com/x"), "sampler_path"), (keep_job(sampler_path=SAMPLER + "/../x"), "sampler_path"),
            # The downloadable weights must belong to the same training run as the adapter.
            (keep_job(external_path=other), "external_path"), (keep_job(external_path=SAMPLER), "external_path"),
            (keep_job(ttl_seconds=60), "ttl_seconds"), (keep_job(ttl_seconds=11 * YEAR), "ttl_seconds"), (keep_job(ttl_seconds=1e6), "ttl_seconds"),
            (keep_job(max_bytes=0), "max_bytes"), (keep_job(max_bytes=M.HARD_KEEP_BYTES + 1), "max_bytes"),
            (keep_job(manifest="text"), "manifest"), (keep_job(manifest={"x": "y" * 30000}), "manifest"),
        ]
        for value, word in cases:
            problem = M.check_keep(value)
            self.assertIsNotNone(problem, value)
            self.assertIn(word, problem)
        for value, word in [
            (unkeep_job(slug="x"), "slug"), (unkeep_job(sampler_path=EXTERNAL), "sampler_path"), (unkeep_job(external_path=other), "external_path"),
            (unkeep_job(ttl_seconds=1), "ttl_seconds"), (unkeep_job(remove_copy="yes"), "remove_copy"), ([], "not an object"),
        ]:
            self.assertIn(word, M.check_unkeep(value))

    def test_only_plain_file_names_under_the_adapters_folder_are_written(self):
        for good in ["adapter_model.safetensors", "adapter_config.json", "checkpoint/part-0.safetensors"]:
            self.assertTrue(M.safe_file_name(good), good)
        for bad in ["../x", "/etc/passwd", "a/../../b", ".hidden", "a//b", "", "a b", "x.age", M.MANIFEST_NAME, "a\\b", 7, None,
                    "a/b/c/d/e", "x" * 200]:
            self.assertFalse(M.safe_file_name(bad), bad)

    def test_the_limits_are_the_ones_the_owner_was_told(self):
        self.assertEqual((M.KEPT_VOLUME, M.KEPT_DIR), ("oblab-kept-models", "/kept"))
        self.assertEqual((M.HARD_KEEP_BYTES, M.MAX_KEEP_FILES, M.MAX_KEEP_TTL_S), (4096 * 1024 * 1024, 16, 10 * YEAR))


class KeepTests(Folder):
    def test_a_keep_sets_the_time_to_live_and_writes_a_peft_copy_with_the_manifest(self):
        result, deps, logs = self.keep(keep_job())
        self.assertEqual((result["status"], result["ttl_seconds"], result["checkpoints"]), ("ok", YEAR, 37))
        # The sampler checkpoint is what keeps answering. The downloadable weights are left to expire once copied.
        self.assertEqual(deps.ttls, [(SAMPLER, YEAR)])
        copy = result["copy"]
        self.assertEqual((copy["status"], copy["format"], copy["dir"]), ("ok", "peft", SLUG))
        self.assertEqual([f["path"] for f in copy["files"]], ["adapter_config.json", "adapter_model.safetensors"])
        self.assertEqual(self.tree(), ["%s/adapter_config.json" % SLUG, "%s/adapter_model.safetensors" % SLUG, "%s/%s" % (SLUG, M.MANIFEST_NAME)])
        for f in copy["files"]:
            with open(os.path.join(self.root, SLUG, f["path"]), "rb") as handle:
                data = handle.read()
            self.assertEqual((len(data), M.hashlib.sha256(data).hexdigest()), (f["bytes"], f["sha256"]))
        self.assertEqual(copy["bytes"], sum(f["bytes"] for f in copy["files"]))
        with open(os.path.join(self.root, SLUG, M.MANIFEST_NAME)) as handle:
            manifest = json.load(handle)
        # The lab's record of the run, as it was sent, and what the copy holds.
        for key, value in MANIFEST.items():
            self.assertEqual(manifest[key], value)
        self.assertEqual(manifest["copy"]["format"], "peft")
        self.assertEqual(manifest["copy"]["files"], copy["files"])
        self.assertEqual(manifest["copy"]["source"], EXTERNAL)
        self.assertEqual(deps.commits, 1)
        self.assertNotIn(KEY, json.dumps(result) + json.dumps(logs))

    def test_when_the_conversion_fails_the_exported_files_are_kept_as_they_are(self):
        result, deps, _ = self.keep(keep_job(), peft=False)
        copy = result["copy"]
        self.assertEqual((result["status"], copy["status"], copy["format"]), ("ok", "ok", "tinker"))
        self.assertIn("not converted to PEFT", copy["reason"])
        self.assertNotIn(KEY, json.dumps(result))
        with open(os.path.join(self.root, SLUG, "adapter_config.json"), "rb") as handle:
            self.assertEqual(handle.read(), WEIGHTS["adapter_config.json"])

    def test_an_adapter_with_no_downloadable_weights_is_kept_without_a_copy(self):
        result, deps, _ = self.keep(keep_job(external_path=None))
        self.assertEqual((result["status"], result["copy"]["status"]), ("ok", "none"))
        self.assertIn("before keeping was switched on", result["copy"]["reason"])
        self.assertEqual(deps.ttls, [(SAMPLER, YEAR)])
        self.assertEqual((deps.fetched, self.tree(), deps.commits), ([], [], 0))

    def test_a_copy_over_the_size_limit_is_not_written_and_the_keep_stands(self):
        result, deps, _ = self.keep(keep_job(max_bytes=1000))
        self.assertEqual((result["status"], result["copy"]["status"]), ("ok", "error"))
        self.assertIn("larger than the 1000 bytes", result["copy"]["reason"])
        self.assertEqual(self.tree(), [])
        # The downloadable weights then get the adapter's long life too, so the copy can be made later.
        self.assertEqual(deps.ttls, [(SAMPLER, YEAR), (EXTERNAL, YEAR)])
        self.assertIn("the copy can be made later", result["copy"]["reason"])
        # The limit is on the whole copy: each file is fetched against what is left of it.
        _, deps, _ = self.keep(keep_job(max_bytes=5000), FakeKeep())
        self.assertEqual(deps.fetched, [("adapter_config.json", 5000), ("adapter_model.safetensors", 5000 - len(WEIGHTS["adapter_config.json"]))])

    def test_file_names_and_addresses_from_tinker_are_checked_before_anything_is_written(self):
        for urls, word in [
            ({"../../outside": "https://signed.example/x"}, "will not write"),
            ({"/abs": "https://signed.example/x"}, "will not write"),
            ({"weights.age": "https://signed.example/x"}, "will not write"),
            ({"ok.safetensors": "http://signed.example/x"}, "not https"),
            ({"ok.safetensors": "file:///etc/passwd"}, "not https"),
            ({}, "no files"),
            ({"f%d.bin" % i: "https://signed.example/f" for i in range(17)}, "17 files"),
        ]:
            result, deps, _ = self.keep(keep_job(), urls=urls)
            self.assertEqual((result["status"], result["copy"]["status"]), ("ok", "error"), urls)
            self.assertIn(word, result["copy"]["reason"])
            self.assertEqual((deps.fetched, self.tree()), ([], []))

    def test_a_time_to_live_that_cannot_be_set_means_not_kept(self):
        result, deps, _ = self.keep(keep_job(), fail_ttl={SAMPLER})
        self.assertEqual((result["status"], result["stage"]), ("error", "ttl"))
        self.assertNotIn(KEY, json.dumps(result))
        self.assertEqual((deps.fetched, self.tree()), ([], []))
        # A job that fails the check never reaches Tinker.
        made = []
        refused = M.keep_core(keep_job(ttl_seconds=5), lambda: made.append(1), root=self.root, clock=Clock(), log=lambda _: None)
        self.assertEqual((refused["status"], refused["stage"], made), ("refused", "input", []))

    def test_a_count_that_cannot_be_read_does_not_fail_the_keep(self):
        result, _, _ = self.keep(keep_job(), count="broken")
        self.assertEqual((result["status"], result["checkpoints"], result["copy"]["status"]), ("ok", None, "ok"))

    def test_a_copy_made_before_is_left_as_it_is_and_gets_a_new_manifest(self):
        first, _, _ = self.keep(keep_job())
        again, deps, _ = self.keep(keep_job(external_path=None, manifest=dict(MANIFEST, kept_by="Grok 4.7")))
        self.assertEqual((again["copy"]["status"], again["copy"]["format"]), ("ok", "peft"))
        self.assertEqual(again["copy"]["files"], first["copy"]["files"])
        self.assertEqual(deps.fetched, [])
        with open(os.path.join(self.root, SLUG, M.MANIFEST_NAME)) as handle:
            self.assertEqual(json.load(handle)["kept_by"], "Grok 4.7")

    def test_nothing_half_written_is_left_under_the_adapters_name(self):
        class Breaks(FakeKeep):
            def fetch(self, url, target, max_bytes):
                if "safetensors" in url:
                    raise RuntimeError("connection reset")
                return FakeKeep.fetch(self, url, target, max_bytes)

        result, _, _ = self.keep(keep_job(), Breaks())
        self.assertEqual((result["status"], result["copy"]["status"]), ("ok", "error"))
        self.assertIn("connection reset", result["copy"]["reason"])
        self.assertEqual(self.tree(), [])


class UnkeepTests(Folder):
    def test_an_unkeep_puts_the_usual_time_to_live_back_and_leaves_the_copy(self):
        self.keep(keep_job())
        result, deps, _ = self.unkeep(unkeep_job())
        self.assertEqual((result["status"], result["ttl_seconds"]), ("ok", 14 * 86400))
        self.assertEqual(deps.ttls, [(SAMPLER, 14 * 86400), (EXTERNAL, 14 * 86400)])
        self.assertEqual(result["copy"], {"status": "none", "reason": "The copy on the Volume was left where it is."})
        self.assertEqual(len(self.tree()), 3)
        self.assertEqual(deps.commits, 0)

    def test_the_copy_is_removed_only_when_asked(self):
        self.keep(keep_job())
        result, deps, _ = self.unkeep(unkeep_job(remove_copy=True))
        self.assertEqual(result["copy"]["reason"], "The copy on the Volume was removed.")
        self.assertEqual((self.tree(), deps.commits), ([], 1))
        again, _, _ = self.unkeep(unkeep_job(remove_copy=True))
        self.assertEqual(again["copy"]["reason"], "There was no copy on the Volume to remove.")

    def test_downloadable_weights_that_are_gone_do_not_fail_an_unkeep(self):
        result, deps, _ = self.unkeep(unkeep_job(), FakeKeep(fail_ttl={EXTERNAL}))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(deps.ttls, [(SAMPLER, 14 * 86400)])
        failed, _, _ = self.unkeep(unkeep_job(), FakeKeep(fail_ttl={SAMPLER}))
        self.assertEqual((failed["status"], failed["stage"]), ("error", "ttl"))
        self.assertNotIn(KEY, json.dumps(failed))


class DownloadTests(unittest.TestCase):
    def test_a_download_is_cut_off_at_the_limit_and_leaves_no_file(self):
        folder = tempfile.mkdtemp(prefix="oblab-dl-test-")
        self.addCleanup(shutil.rmtree, folder, True)
        asked = []

        def opener(request, timeout):
            asked.append((request.full_url, timeout))
            return io.BytesIO(b"x" * 3000)

        target = os.path.join(folder, "a.bin")
        self.assertEqual(M.download_capped("https://signed.example/a", target, 4000, opener), 3000)
        self.assertEqual(os.path.getsize(target), 3000)
        self.assertIsNone(M.download_capped("https://signed.example/a", target, 2999, opener))
        self.assertFalse(os.path.exists(target))
        with self.assertRaises(ValueError):
            M.download_capped("http://signed.example/a", target, 4000, opener)
        self.assertEqual(len(asked), 2)


class KeepEndpointTests(unittest.TestCase):
    def test_a_keep_is_started_on_the_function_that_holds_the_volume_and_only_under_a_keeps_name(self):
        trained, kept = [], []
        names = {}

        class Names:
            def get(self, key, default=None):
                return names.get(key, default)

            def put(self, key, value):
                names[key] = value

        m = load({
            "train": SimpleNamespace(spawn=lambda j: trained.append(j) or SimpleNamespace(object_id="fc-train-%d" % len(trained))),
            "keeper": SimpleNamespace(spawn=lambda j: kept.append(j) or SimpleNamespace(object_id="fc-keep-%d" % len(kept))),
            "OutputExpiredError": type("Expired", (Exception,), {}),
            "modal": SimpleNamespace(
                FunctionCall=SimpleNamespace(from_id=lambda call_id: SimpleNamespace(get=lambda timeout: {"status": "ok"})),
                Dict=SimpleNamespace(from_name=lambda name, create_if_missing=False: Names())),
        })
        app = FastAPI()
        app.add_api_route("/start", m.start, methods=["POST"])
        app.add_api_route("/status", m.status, methods=["GET"])
        auth = {"Authorization": "Bearer " + TOKEN}
        keep_id = "k-%s-0011aabb" % SLUG
        with TestClient(app) as client, patch.dict(os.environ, {"JOBS_TOKEN": TOKEN}):
            self.assertEqual(client.post("/start", json={"run_id": keep_id, "keep": keep_job()}).status_code, 401)
            # A keep needs its own name, for that adapter; a training run's name will not do, nor will another adapter's.
            for bad in [None, SLUG, "k-e42-0a1b2c3d-0011aabb", "u-%s-0011aabb" % SLUG, "k-%s" % SLUG, "k-%s-XYZ" % SLUG]:
                body = {"keep": keep_job()} if bad is None else {"run_id": bad, "keep": keep_job()}
                self.assertEqual(client.post("/start", headers=auth, json=body).status_code, 400, bad)
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": keep_id, "keep": keep_job(ttl_seconds=1)}).status_code, 400)
            # One kind of work in one start.
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": keep_id, "keep": keep_job(), "train": job()}).status_code, 400)
            # A training run cannot be started under a keep's name.
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": keep_id, "train": job()}).status_code, 400)
            self.assertEqual((trained, kept), ([], []))

            self.assertEqual(client.post("/start", headers=auth, json={"run_id": keep_id, "keep": keep_job()}).json(), {"call_id": "fc-keep-1"})
            self.assertEqual(kept, [{"action": "keep", "keep": keep_job()}])
            self.assertEqual(trained, [])
            # Sent again: the same call, nothing new. Found by its name, like a run.
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": keep_id, "keep": keep_job()}).json(), {"call_id": "fc-keep-1"})
            self.assertEqual(len(kept), 1)
            self.assertEqual(client.get("/status", headers=auth, params={"run_id": keep_id}).json()["call_id"], "fc-keep-1")

            unkeep_id = "u-%s-0011aabb" % SLUG
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": unkeep_id, "unkeep": unkeep_job(remove_copy=True)}).json(), {"call_id": "fc-keep-2"})
            self.assertEqual(kept[1], {"action": "unkeep", "unkeep": unkeep_job(remove_copy=True)})
            self.assertEqual(client.post("/start", headers=auth, json={"run_id": keep_id, "unkeep": unkeep_job()}).status_code, 400)

    def test_the_keeper_runs_lab_code_only_and_alone_holds_the_volume(self):
        keeper = SOURCE[SOURCE.index("kept_volume = modal.Volume.from_name"):SOURCE.index("# HTTP endpoints for the lab server")]
        self.assertIn('modal.Volume.from_name(KEPT_VOLUME, create_if_missing=True)', keeper)
        self.assertIn("volumes={KEPT_DIR: kept_volume}", keeper)
        self.assertIn("max_containers=1", keeper)
        self.assertIn("retries=0", keeper)
        self.assertEqual(SOURCE.count("volumes="), 1)
        # Nothing in the keep path runs text it was given.
        keep_code = SOURCE[SOURCE.index("# Keeping an adapter: a long time to live"):SOURCE.index("# HTTP endpoints for the lab server")]
        for word in ("subprocess", "eval(", "exec(", "os.system", "trust_remote_code=True"):
            self.assertNotIn(word, keep_code)
        self.assertIn("trust_remote_code=False", keep_code)


if __name__ == "__main__":
    unittest.main()
