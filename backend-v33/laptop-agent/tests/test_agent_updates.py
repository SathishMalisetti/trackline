import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import agent_updates


class Response:
    def __init__(self, payload=None, chunks=()):
        self.payload = payload
        self.chunks = chunks

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload

    def iter_content(self, _chunk_size):
        yield from self.chunks


class Session:
    def __init__(self, responses):
        self.responses = list(responses)

    def get(self, *_args, **_kwargs):
        return self.responses.pop(0)


class AgentUpdateTests(unittest.TestCase):
    def test_versions_parse_and_reject_bad_values(self):
        self.assertEqual(agent_updates.version_tuple("v1.2.3"), (1, 2, 3))
        with self.assertRaises(ValueError):
            agent_updates.version_tuple("latest")

    def test_archive_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "bad.zip"
            stage = Path(temp) / "stage"
            stage.mkdir()
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("../outside.txt", "no")
            with self.assertRaises(ValueError):
                agent_updates._safe_extract(bundle, stage)

    def test_download_checks_release_digest_and_queues_newer_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {"LOCALAPPDATA": temp}
            runtime = Path(temp) / "TracklineAgent" / "runtime" / "TracklineAgent"
            runtime.mkdir(parents=True)
            (runtime / "agent-version.json").write_text(json.dumps({"version": "1.1.3"}))

            archive_path = Path(temp) / "module.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("TracklineAgent/TracklineAgent.exe", "agent executable")
                archive.writestr("TracklineAgent/agent-version.json", json.dumps({"version": "1.1.4"}))
            archive_bytes = archive_path.read_bytes()
            digest = hashlib.sha256(archive_bytes).hexdigest()
            release = {
                "tag_name": "Version1.3",
                "assets": [{
                    "name": agent_updates.ASSET_NAME,
                    "browser_download_url": "https://github.com/example/module.zip",
                    "digest": f"sha256:{digest}",
                }],
            }
            session = Session([Response(release), Response(chunks=[archive_bytes])])

            with patch.dict(os.environ, env), patch.object(agent_updates, "_schedule_swap") as schedule:
                queued = agent_updates.check_for_update(frozen=True, process_id=123, session=session, now=12345)

            self.assertTrue(queued)
            schedule.assert_called_once()
            self.assertEqual(schedule.call_args.args[1], runtime)
            state = json.loads((Path(temp) / "TracklineAgent" / "updates" / "last-check.json").read_text())
            self.assertEqual(state["checked_at"], 12345)

    def test_failed_release_request_does_not_throttle_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {"LOCALAPPDATA": temp}
            session = Session([])
            session.get = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("offline"))
            with patch.dict(os.environ, env):
                self.assertFalse(agent_updates.check_for_update(frozen=True, session=session, now=100))
            self.assertFalse((Path(temp) / "TracklineAgent" / "updates" / "last-check.json").exists())


if __name__ == "__main__":
    unittest.main()
