#!/usr/bin/env python3
"""Install the standalone storyboard-workbench release without Git."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import urllib.request
import zipfile


PACKAGE = "storyboard-workbench"
RELEASE_URL = (
    "https://github.com/K1ngq1/Direct-skill/releases/latest/download/"
    "storyboard-workbench.zip"
)
HASH_PATTERN = re.compile(r"[0-9a-fA-F]{64}")
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {
    prefix + str(number) for prefix in ("COM", "LPT") for number in range(1, 10)
}


def safe_path(name):
    """Require one portable relative path, without normalization aliases."""
    if not isinstance(name, str) or not name:
        raise ValueError("Invalid empty archive path")
    parts = name.split("/")
    for part in parts:
        if (
            not part
            or part in (".", "..")
            or part.endswith((".", " "))
            or any(ord(char) < 32 or char in '\\:<>"|?*' for char in part)
            or part.split(".", 1)[0].upper() in WINDOWS_RESERVED
        ):
            raise ValueError("Unsafe archive path: " + repr(name))
    return name


def verify_package(archive, checksum):
    tokens = checksum.split()
    if not tokens or not HASH_PATTERN.fullmatch(tokens[0]):
        raise ValueError("Invalid SHA256 sidecar")
    if hashlib.sha256(archive).hexdigest() != tokens[0].lower():
        raise ValueError("Archive SHA256 mismatch")

    files = {}
    paths = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        for entry in bundle.infolist():
            if entry.orig_filename != entry.filename:
                raise ValueError("Invalid archive path")
            name = safe_path(entry.filename[:-1] if entry.is_dir() else entry.filename)
            if name != PACKAGE and not name.startswith(PACKAGE + "/"):
                raise ValueError("ZIP must contain only the " + PACKAGE + " directory")
            key = name.casefold()
            if key in paths:
                raise ValueError("Duplicate archive path: " + name)
            paths[key] = name
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("Links and special files are not allowed: " + name)
            if entry.is_dir():
                if kind == stat.S_IFREG:
                    raise ValueError("Invalid directory entry: " + name)
                continue
            if kind == stat.S_IFDIR or name == PACKAGE:
                raise ValueError("Invalid file entry: " + name)
            files[name[len(PACKAGE) + 1:]] = bundle.read(entry)

    file_keys = {(PACKAGE + "/" + name).casefold() for name in files}
    for name in paths.values():
        parts = name.split("/")
        if any("/".join(parts[:index]).casefold() in file_keys
               for index in range(1, len(parts))):
            raise ValueError("File conflicts with a parent directory: " + name)
    for name in paths.values():
        parts = name.split("/")
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            existing = paths.get(prefix.casefold())
            if existing is not None and existing != prefix:
                raise ValueError("Inconsistent path casing: " + name)

    if "SKILL.md" not in files or "package-manifest.json" not in files:
        raise ValueError("Package requires SKILL.md and package-manifest.json")
    manifest = json.loads(files["package-manifest.json"].decode("utf-8"))
    if (
        not isinstance(manifest, dict)
        or type(manifest.get("schemaVersion")) is not int
        or manifest["schemaVersion"] != 1
        or not isinstance(manifest.get("sourceRevision"), str)
        or not manifest["sourceRevision"].strip()
        or not isinstance(manifest.get("files"), list)
    ):
        raise ValueError("Invalid package manifest")
    listed = set()
    for item in manifest["files"]:
        if not isinstance(item, dict):
            raise ValueError("Invalid manifest file entry")
        name = safe_path(item.get("path"))
        if name == "package-manifest.json" or name.casefold() in listed:
            raise ValueError("Duplicate or self-referencing manifest path: " + name)
        listed.add(name.casefold())
        digest = item.get("sha256")
        size = item.get("bytes")
        if not isinstance(digest, str) or not HASH_PATTERN.fullmatch(digest):
            raise ValueError("Invalid file SHA256: " + name)
        if type(size) is not int or size < 0:
            raise ValueError("Invalid file size: " + name)
        content = files.get(name)
        if content is None or len(content) != size:
            raise ValueError("Missing file or size mismatch: " + name)
        if hashlib.sha256(content).hexdigest() != digest.lower():
            raise ValueError("File SHA256 mismatch: " + name)
    expected = {name.casefold() for name in files if name != "package-manifest.json"}
    if listed != expected:
        raise ValueError("Manifest file set does not match the ZIP")
    return files


def install(archive, checksum, destination):
    files = verify_package(archive, checksum)
    target = Path(destination).expanduser().absolute() / PACKAGE
    if os.path.lexists(target):
        raise ValueError("Installation already exists; refusing to overwrite: " + str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    for name, content in files.items():
        if name == "SKILL.md":
            continue
        path = target.joinpath(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(content)

    # Publish the discovery entry only after every other file is installed.
    handle, temporary = tempfile.mkstemp(prefix=".skill-", suffix=".tmp", dir=target)
    try:
        with os.fdopen(handle, "wb") as output:
            output.write(files["SKILL.md"])
        os.replace(temporary, target / "SKILL.md")
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
    return target


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, help="Skills parent directory")
    parser.add_argument("--archive", type=Path, help="Local ZIP with adjacent .zip.sha256")
    arguments = parser.parse_args(argv)
    destination = arguments.dest
    if destination is None:
        destination = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "skills"
    try:
        if arguments.archive is not None:
            archive = arguments.archive.read_bytes()
            checksum = Path(str(arguments.archive) + ".sha256").read_text(encoding="ascii")
        else:
            with urllib.request.urlopen(RELEASE_URL, timeout=60) as response:
                archive = response.read()
            with urllib.request.urlopen(RELEASE_URL + ".sha256", timeout=60) as response:
                checksum = response.read().decode("ascii")
        target = install(archive, checksum, destination)
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
        print("Installation failed: " + str(error), file=sys.stderr)
        print("Existing installations were not overwritten. A partial new directory may remain.",
              file=sys.stderr)
        return 1
    print("Installed successfully: " + str(target))
    print("Runtime prerequisites: Python 3.10+, Node.js 20+, and openpyxl.")
    print("This installer does not install runtimes, pip packages, or change other settings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
