#!/usr/bin/env python3
"""Extract source-only releases. Run as the project's unprivileged unpack user."""
import os
from pathlib import Path
import shutil
import sys
import tarfile

POLICIES = {
    "leadloom": ({"src", "web"}, {"package.json"}, {"src/main.mjs", "web/index.html", "package.json"}),
    "docflow": (
        {"apps", "packages"},
        {"package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json"},
        {"package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json",
         "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json",
         "packages/core/package.json", "packages/shared/package.json"},
    ),
}
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_MEMBERS = 10000


def extract(stream, destination, project):
    directories, files, required = POLICIES[project]
    destination = Path(destination)
    if any(destination.iterdir()):
        raise ValueError("Staging directory must be empty")
    seen, regular_files, total = set(), set(), 0
    with tarfile.open(fileobj=stream, mode="r|gz") as archive:
        for member in archive:
            name = member.name.removesuffix("/") if member.isdir() else member.name
            parts = name.split("/")
            if (len(name) > 1024 or "\\" in name or
                    any(p in ("", ".", "..") or p.startswith(".env") or p == ".git" for p in parts) or
                    any(ord(c) < 32 or ord(c) == 127 for c in name)):
                raise ValueError("Unsafe archive path")
            if not (member.isdir() or member.isreg()) or member.issparse():
                raise ValueError("Only regular files and directories are allowed")
            if not (parts[0] in directories or (name in files and member.isreg())):
                raise ValueError("Path outside source allowlist")
            if len(parts) == 1 and parts[0] in directories and not member.isdir():
                raise ValueError("Source root must be a directory")
            if name in seen or len(seen) >= MAX_MEMBERS:
                raise ValueError("Duplicate path or too many archive entries")
            seen.add(name)
            total += member.size
            if member.size < 0 or member.size > MAX_FILE or total > MAX_TOTAL:
                raise ValueError("Archive size limit exceeded")
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                # Never use tar.extract: links, ownership and archive permissions are untrusted.
                with archive.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=65536)
                target.chmod(0o644)
                regular_files.add(name)
    if not required <= regular_files:
        raise ValueError("Release is missing required source files")


if __name__ == "__main__":
    try:
        if os.geteuid() == 0:
            raise ValueError("Archive extraction must not run as root")
        os.umask(0o022)
        extract(sys.stdin.buffer, sys.argv[2], sys.argv[1])
    except (ValueError, OSError, tarfile.TarError, EOFError, KeyError, IndexError) as error:
        sys.exit(f"Release rejected: {error}")
