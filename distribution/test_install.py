"""Offline installer tests; temporary fixtures remain in the system temp directory."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile


SCRIPT = Path(__file__).with_name("install.py")
SPEC = importlib.util.spec_from_file_location("standalone_install", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def package(extra=None, change_manifest=None):
    files = {"SKILL.md": b"---\nname: storyboard-workbench\n---\n", "scripts/run.py": b"print('ok')\n"}
    manifest = {
        "schemaVersion": 1,
        "sourceRevision": "test-revision",
        "files": [
            {"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            for name, data in files.items()
        ],
    }
    if change_manifest:
        change_manifest(manifest)
    files["package-manifest.json"] = json.dumps(manifest).encode("utf-8")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        for name, data in files.items():
            bundle.writestr("storyboard-workbench/" + name, data)
        if extra:
            extra(bundle)
    data = stream.getvalue()
    return data, hashlib.sha256(data).hexdigest() + "  storyboard-workbench.zip\n"


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="storyboard-install-test-"))

    def test_install_and_cli_from_stdin(self):
        data, checksum = package()
        archive = self.directory / "storyboard-workbench.zip"
        archive.write_bytes(data)
        Path(str(archive) + ".sha256").write_text(checksum, encoding="ascii")
        destination = self.directory / "skills"
        result = subprocess.run(
            [sys.executable, "-", "--archive", str(archive), "--dest", str(destination)],
            input=SCRIPT.read_text(encoding="ascii"), text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Installed successfully", result.stdout)
        target = destination / installer.PACKAGE
        self.assertEqual((target / "scripts/run.py").read_bytes(), b"print('ok')\n")
        self.assertTrue((target / "SKILL.md").is_file())
        self.assertTrue((target / "package-manifest.json").is_file())

    def test_archive_hash_error_writes_nothing(self):
        data, _ = package()
        with self.assertRaisesRegex(ValueError, "Archive SHA256 mismatch"):
            installer.install(data, "0" * 64, self.directory / "skills")
        self.assertFalse((self.directory / "skills").exists())

    def test_manifest_hash_error_writes_nothing(self):
        data, checksum = package(change_manifest=lambda manifest: manifest["files"][0].update(sha256="0" * 64))
        with self.assertRaisesRegex(ValueError, "File SHA256 mismatch"):
            installer.install(data, checksum, self.directory / "skills")
        self.assertFalse((self.directory / "skills").exists())

    def test_malicious_paths_and_links(self):
        names = [
            "../escape.txt", "/absolute.txt", "other/file.txt",
            "storyboard-workbench/../escape.txt", "storyboard-workbench/C:/escape.txt",
            "storyboard-workbench/dir\\escape.txt", "storyboard-workbench/NUL.txt",
            "storyboard-workbench/alias. ", "storyboard-workbench/SKILL.md/child",
            "storyboard-workbench/skill.MD",
        ]
        for name in names:
            with self.subTest(name=name):
                data, checksum = package(extra=lambda bundle: bundle.writestr(name, b"bad"))
                with self.assertRaises(ValueError):
                    installer.install(data, checksum, self.directory / "skills")
                self.assertFalse((self.directory / "skills").exists())
        link = zipfile.ZipInfo("storyboard-workbench/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        data, checksum = package(extra=lambda bundle: bundle.writestr(link, b"../../escape"))
        with self.assertRaisesRegex(ValueError, "Links"):
            installer.install(data, checksum, self.directory / "skills")

    def test_manifest_file_set(self):
        data, checksum = package(extra=lambda bundle: bundle.writestr("storyboard-workbench/unlisted.txt", b"bad"))
        with self.assertRaisesRegex(ValueError, "file set"):
            installer.install(data, checksum, self.directory / "skills")
        self.assertFalse((self.directory / "skills").exists())

    def test_existing_install_is_preserved(self):
        target = self.directory / installer.PACKAGE
        target.mkdir()
        original = target / "SKILL.md"
        original.write_bytes(b"user-owned content")
        data, checksum = package()
        with self.assertRaisesRegex(ValueError, "already exists"):
            installer.install(data, checksum, self.directory)
        self.assertEqual(original.read_bytes(), b"user-owned content")
        self.assertEqual(list(target.iterdir()), [original])

    def test_write_failure_does_not_publish_skill(self):
        data, checksum = package()
        with mock.patch.object(Path, "open", side_effect=OSError("disk failure")):
            with self.assertRaisesRegex(OSError, "disk failure"):
                installer.install(data, checksum, self.directory)
        self.assertFalse((self.directory / installer.PACKAGE / "SKILL.md").exists())


if __name__ == "__main__":
    unittest.main()
