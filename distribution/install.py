#!/usr/bin/env python3
"""Install the standalone storyboard-workbench release without Git."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


PACKAGE = "storyboard-workbench"
RELEASE_URL = (
    "https://github.com/K1ngq1/Direct-skill/releases/latest/download/"
    "storyboard-workbench.zip"
)
LIBTV_URL = "https://mcp.liblib.tv/mcp"
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


def setup_libtv_mcp():
    """Use the host CLI so Codex owns configuration and account credentials."""
    executable = shutil.which("codex")
    if executable is None:
        raise RuntimeError("Codex CLI is not on PATH. Install it, then run this installer with --mcp-only.")

    def servers():
        result = subprocess.run(
            [executable, "mcp", "list", "--json"], check=True, capture_output=True,
            encoding="utf-8", errors="replace", timeout=30,
        )
        data = json.loads(result.stdout)
        if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
            raise ValueError("Invalid server list from Codex CLI")
        return data

    configured = servers()
    matching = [item for item in configured
                if item.get("transport", {}).get("url", "").rstrip("/") == LIBTV_URL]
    if matching:
        server = next((item for item in matching if item.get("enabled", True)), matching[0])
        name = server.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError("Cannot safely reuse this LibTV server name; existing configuration was preserved.")
        if not server.get("enabled", True):
            raise ValueError("Existing LibTV MCP is disabled; enable it in Codex, then retry --mcp-only.")
        print("Reusing existing LibTV MCP: " + name, flush=True)
    else:
        if any(item.get("name") == "libtv" for item in configured):
            raise ValueError("MCP name 'libtv' already points elsewhere; existing configuration was preserved.")
        name = "libtv"
        print("Registering LibTV MCP: " + LIBTV_URL, flush=True)
        subprocess.run([executable, "mcp", "add", name, "--url", LIBTV_URL], check=True)
        server = next((item for item in servers() if item.get("name") == name), {})

    # Adding an OAuth server may already complete login; do not open it twice.
    if server.get("auth_status") not in ("o_auth", "bearer_token"):
        print("Complete LibTV account authorization in the browser opened by Codex.", flush=True)
        subprocess.run([executable, "mcp", "login", name], check=True)
        server = next((item for item in servers() if item.get("name") == name), {})
    if server.get("auth_status") not in ("o_auth", "bearer_token"):
        raise RuntimeError("LibTV MCP was configured, but Codex did not confirm stored credentials.")
    print("LibTV MCP configured; Codex reports stored account credentials.")
    print("Restart Codex or open a new chat. The first LibTV task must check live readiness with doctor.")


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, help="Skills parent directory")
    parser.add_argument("--archive", type=Path, help="Local ZIP with adjacent .zip.sha256")
    mcp_options = parser.add_mutually_exclusive_group()
    mcp_options.add_argument("--skip-mcp", action="store_true", help="Install Skill files without configuring MCP")
    mcp_options.add_argument("--mcp-only", action="store_true", help="Configure LibTV in Codex without reinstalling the Skill")
    arguments = parser.parse_args(argv)
    if arguments.mcp_only and (arguments.archive is not None or arguments.dest is not None):
        parser.error("--mcp-only cannot be combined with --archive or --dest")
    if arguments.mcp_only:
        return configure_mcp()
    codex_destination = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "skills"
    destination = arguments.dest
    if destination is None:
        destination = codex_destination
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
    print("This installer does not install runtimes or pip packages.")
    if arguments.skip_mcp:
        print("LibTV MCP setup skipped (--skip-mcp).")
    elif destination.expanduser().resolve() != codex_destination.expanduser().resolve():
        print("Custom skills directory: configure MCP in that host; Codex settings were not changed.")
    else:
        return configure_mcp()
    return 0


def configure_mcp():
    try:
        setup_libtv_mcp()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        print("LibTV MCP setup incomplete: " + str(error), file=sys.stderr)
        print("Skill files were not rolled back or overwritten. Retry with --mcp-only after resolving the issue.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
