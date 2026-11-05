#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Tell whether `.venv_lb` is the one lb-setup created for this repository.

Skills and the Q&A server run `.venv_lb`'s interpreter with the developer's AWS
credentials. A `.venv_lb` that arrives with a repository (a ZIP, or a working tree
copied with it) is owned by the developer and passes the git checks, so ownership
alone can't tell it apart. When lb-setup creates the venv it records a random ID in
two places: inside the venv, and in the user's LaunchBridge state directory, outside
every repository. A venv is lb-setup's only when both match.

It also checks `.lb_workspace/config/python_deps/`, which `.venv_lb` is built
from: the installer records the SHA-256 of the `pyproject.toml` and
`constraints.txt` it writes there in the same state directory, and lb-setup
installs only from files that match (`deps`).

Usage:
    python3 venv_identity.py record <codebase_abs_path>   # right after `uv venv`
    python3 venv_identity.py check <codebase_abs_path>
    python3 venv_identity.py deps <codebase_abs_path>     # before installing

Run it with a Python other than `.venv_lb`'s own. Exit codes: 0 recorded, or the
venv is lb-setup's; 1 it is not (the reason is printed); 2 bad arguments.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

VENV_ID_FILE = ".launchbridge_venv_id"
RECORD_FILE = "venv_id"
DEPS_RECORD_FILE = "python_deps.json"
DEPS_FILES = ("pyproject.toml", "constraints.txt")


def state_dir() -> Path:
    """The user's LaunchBridge state directory, outside every repository.

    A relative XDG_CONFIG_HOME is ignored, as the XDG spec requires: it would
    resolve against the working directory, which can be the repository itself.
    """
    base = os.environ.get("XDG_CONFIG_HOME", "")
    if not os.path.isabs(base):
        base = str(Path.home() / ".config")
    return Path(base) / "launchbridge"


def record_path(codebase_dir: str | Path, name: str = RECORD_FILE) -> Path:
    resolved = str(Path(codebase_dir).resolve())
    key = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16]
    return state_dir() / "repos" / key / name


def deps_problem(codebase_dir: str | Path) -> str | None:
    """Why python_deps/ is not what the installer wrote, or None if it is."""
    deps = Path(codebase_dir) / ".lb_workspace" / "config" / "python_deps"
    record = record_path(codebase_dir, DEPS_RECORD_FILE)
    if record.resolve().is_relative_to(Path(codebase_dir).resolve()):
        return f"the record for {deps} would be inside the repository"
    try:
        expected = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return (
            f"no installer record for {deps} on this machine; re-run the "
            "LaunchBridge installer for this repository"
        )
    try:
        present = sorted(entry.name for entry in deps.iterdir())
    except OSError:
        present = []
    extra = [name for name in present if name not in DEPS_FILES]
    if extra:
        return (
            f"{deps} holds files the installer didn't write ({', '.join(extra)}); "
            "pip would use them while installing. Re-run the installer, which "
            "recreates the folder"
        )
    for name in DEPS_FILES:
        if (deps / name).is_symlink():
            return f"{deps / name} is a symbolic link; re-run the installer"
        try:
            actual = hashlib.sha256((deps / name).read_bytes()).hexdigest()
        except OSError:
            actual = None
        if not isinstance(expected, dict) or actual != expected.get(name):
            return (
                f"{deps / name} is not the file the LaunchBridge installer wrote "
                "(it may have arrived with the repository); re-run the installer"
            )
    return None


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


def record(codebase_dir: str | Path) -> None:
    """Give the venv lb-setup just created a new ID, inside it and in the state."""
    venv = Path(codebase_dir) / ".venv_lb"
    if not (venv / "pyvenv.cfg").is_file():
        raise ValueError(f"{venv} is not a virtual environment (no pyvenv.cfg)")
    record_file = record_path(codebase_dir)
    if record_file.resolve().is_relative_to(Path(codebase_dir).resolve()):
        raise ValueError(
            f"{record_file} is inside the repository; the LaunchBridge state "
            "directory (XDG_CONFIG_HOME or ~/.config) must be outside it"
        )
    venv_id = secrets.token_hex(16)
    _write_private(venv / VENV_ID_FILE, venv_id)
    _write_private(record_file, venv_id)


def problem(codebase_dir: str | Path) -> str | None:
    """Why `.venv_lb` is not lb-setup's for this repository, or None if it is."""
    venv = Path(codebase_dir) / ".venv_lb"
    if record_path(codebase_dir).resolve().is_relative_to(Path(codebase_dir).resolve()):
        return f"the record for {venv} would be inside the repository"
    try:
        in_venv = (venv / VENV_ID_FILE).read_text(encoding="utf-8").strip()
        recorded = record_path(codebase_dir).read_text(encoding="utf-8").strip()
    except OSError:
        in_venv = recorded = ""
    if not in_venv or not secrets.compare_digest(in_venv, recorded):
        return (
            f"{venv} was not created by lb-setup for this repository on this "
            "machine (it may have arrived with the repository)"
        )
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ("record", "check", "deps"):
        print(
            "usage: venv_identity.py record|check|deps <codebase_abs_path>",
            file=sys.stderr,
        )
        return 2
    codebase = Path(argv[2])
    if argv[1] == "deps":
        reason = deps_problem(codebase)
        if reason:
            print(reason)
            return 1
        print("python_deps/ matches what the LaunchBridge installer wrote.")
        return 0
    if argv[1] == "record":
        try:
            record(codebase)
        except (OSError, ValueError) as exc:
            print(f"Could not record .venv_lb: {exc}", file=sys.stderr)
            return 1
        print(
            f"Recorded {codebase / '.venv_lb'} as lb-setup's venv for this repository."
        )
        return 0
    reason = problem(codebase)
    if reason:
        print(reason)
        print("Remove .venv_lb and re-run lb-setup's venv step on this machine.")
        return 1
    print(f"{codebase / '.venv_lb'} is lb-setup's venv for this repository.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
