"""Run with: python3 scripts/test_deploy_archive.py (no Docker or production access)."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("receiver", Path(__file__).with_name("extract-release.py"))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


def archive(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as output:
        for name, kind, content in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.mode = 0o6777
            if kind == tarfile.REGTYPE:
                member.size = len(content)
            else:
                member.linkname = "/etc/passwd"
            output.addfile(member, io.BytesIO(content))
    data.seek(0)
    return data


class ArchiveTests(unittest.TestCase):
    def valid(self, project):
        return [(name, tarfile.REGTYPE, b"source") for name in sorted(receiver.POLICIES[project][2])]

    def test_valid_releases_and_fixed_permissions(self):
        for project in receiver.POLICIES:
            with self.subTest(project=project), tempfile.TemporaryDirectory() as directory:
                receiver.extract(archive(self.valid(project)), directory, project)
                for name in receiver.POLICIES[project][2]:
                    target = Path(directory, name)
                    self.assertEqual(target.read_bytes(), b"source")
                    self.assertEqual(target.stat().st_mode & 0o7777, 0o644)

    def test_rejects_paths_outside_source_and_secrets(self):
        for project, paths in {
            "leadloom": ["../escaped", "/etc/passwd", "src/../../escaped", "src//bad", "src/./bad",
                         "src\\bad", "src/bad\nname", "src/.env", "src/.git/config", ".env", "data/db",
                         "compose.yaml", "compose.vps.yaml", "Dockerfile", "src"],
            "docflow": ["docker-compose.yml", "docker/Caddyfile", "docker/node.Dockerfile", ".dockerignore",
                        "secrets/key", "apps/../docker/Caddyfile", "apps/.env.local", "packages/.git/config"],
        }.items():
            for path in paths:
                with self.subTest(project=project, path=path), tempfile.TemporaryDirectory() as directory:
                    with self.assertRaises(ValueError):
                        receiver.extract(archive(self.valid(project) + [(path, tarfile.REGTYPE, b"bad")]), directory, project)

    def test_rejects_links_devices_and_fifos(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    receiver.extract(archive(self.valid("leadloom") + [("src/link", kind, b"")]), directory, "leadloom")

    def test_duplicate_and_missing_files(self):
        for entries in [[], self.valid("leadloom") * 2]:
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
                receiver.extract(archive(entries), directory, "leadloom")

    def test_size_and_count_limits(self):
        for limit in ["MAX_FILE", "MAX_TOTAL", "MAX_MEMBERS"]:
            with self.subTest(limit=limit), patch.object(receiver, limit, 1):
                with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
                    receiver.extract(archive(self.valid("leadloom")), directory, "leadloom")

    def test_rejects_corrupt_input_and_nonempty_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(tarfile.TarError):
                receiver.extract(io.BytesIO(b"not a gzip archive"), directory, "leadloom")
            Path(directory, "existing").write_text("keep")
            with self.assertRaises(ValueError):
                receiver.extract(archive(self.valid("leadloom")), directory, "leadloom")
            self.assertEqual(Path(directory, "existing").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
