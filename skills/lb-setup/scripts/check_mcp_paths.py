# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Check the repository-local paths LaunchBridge's MCP servers start from.

lb-setup registers MCP servers that the guard (lb_guard.py) starts from
`.venv_lb/` and the launcher `.lb_workspace/config/mcp_v1_compat.py`, both inside
the target repository. The agent starts them with the developer's credentials, so they must
be the ones lb-setup created on this machine: owned by the current user, inside
the repository and not reached through a symlink, and, in a git repository,
neither tracked nor un-ignored, which would mean they arrived with the
repository's content. The venv must also carry the ID lb-setup recorded for this
repository outside it (venv_identity.py), which a venv that arrived in a ZIP or a
copied working tree doesn't.

Usage:
    python3 check_mcp_paths.py <codebase_abs_path>

Exit codes: 0 all paths pass; 1 a path fails (each reason is printed);
2 bad arguments.
"""

from __future__ import annotations

import os
import subprocess
import sys
import types
from pathlib import Path


def _load_sibling(name: str) -> types.ModuleType:
    """The module `name`.py beside this script, compiled from its source. Putting
    this folder on sys.path would let any file in it stand in for a standard
    library module these modules import, and the normal loader would run a
    `__pycache__/*.pyc` there without comparing it to the source."""
    path = Path(__file__).resolve().parent / f"{name}.py"
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)  # nosec B102 - LaunchBridge's own module, from source
    return module


lb_guard = _load_sibling("lb_guard")
venv_identity = _load_sibling("venv_identity")

VENV_REL = Path(".venv_lb")
LAUNCHER_REL = Path(".lb_workspace") / "config" / "mcp_v1_compat.py"


def _git(root: Path, *args: str) -> subprocess.CompletedProcess | None:
    git = lb_guard.find_tool("git", root)  # never a git from the repository
    if not git:
        return None
    try:
        return subprocess.run(  # nosec B603 - fixed git argv, shell=False
            # core.fsmonitor off: the repository's config names no program here.
            [git, "-c", "core.fsmonitor=false", *args],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=30,
            env=lb_guard.git_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return None


def path_problem(root: Path, rel: Path, *, is_venv: bool) -> str | None:
    """Why `root / rel` should not be started by the agent, or None if it can be."""
    path = root / rel
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            return f"{current} is a symlink"
    if not path.exists():
        return f"{path} does not exist"
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return f"{path} resolves outside {root}"
    if is_venv:
        if not (path / "pyvenv.cfg").is_file():
            return f"{path} is not a virtual environment (no pyvenv.cfg)"
    elif not path.is_file():
        return f"{path} is not a file"
    if hasattr(os, "getuid") and path.stat().st_uid != os.getuid():
        return f"{path} is not owned by the current user"

    inside = _git(root, "rev-parse", "--is-inside-work-tree")
    if inside is None or inside.returncode != 0:
        return None
    tracked = _git(root, "ls-files", "--", rel.as_posix())
    if tracked is not None and tracked.stdout.strip():
        return f"{path} is tracked by git"
    ignored = _git(root, "check-ignore", "-q", rel.as_posix())
    if ignored is not None and ignored.returncode != 0:
        return f"{path} is not gitignored"
    return None


def check(root: Path) -> list[str]:
    """Every problem with the MCP servers' repository-local paths."""
    venv = path_problem(root, VENV_REL, is_venv=True)
    problems = [
        venv or venv_identity.problem(root),
        path_problem(root, LAUNCHER_REL, is_venv=False),
    ]
    problems = [p for p in problems if p]
    if not problems:
        # The guard's checks, as the servers will meet them at start: the venv and
        # the launcher as lb-setup sealed them, no links or tracked files.
        problems = lb_guard.problems(root, need_launcher=True)
    return problems


# The project-level agent configs lb-setup writes LaunchBridge's MCP entries to.
AGENT_CONFIGS = (
    ".mcp.json",
    ".kiro/settings/mcp.json",
    ".roo/mcp.json",
    ".codex/config.toml",
)


def tracked_agent_configs(root: Path) -> list[str]:
    """Agent configs here that git tracks.

    lb-setup builds LaunchBridge's entries in them from its template. In a
    tracked file, a later pull can change an entry's command, and a host that
    approved the server by name starts the new command without the guard.
    """
    listed = _git(
        root, "ls-files", "-z", "--", *[f":(icase){p}" for p in AGENT_CONFIGS]
    )
    if listed is None or listed.returncode != 0:
        return []
    return [p for p in listed.stdout.split("\0") if p]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: check_mcp_paths.py <codebase_abs_path>", file=sys.stderr)
        return 2
    root = Path(argv[1])
    if not root.is_dir():
        print(f"{root} is not a directory", file=sys.stderr)
        return 2
    problems = check(root)
    if problems:
        print("Refusing to register MCP servers that start from:")
        for problem in problems:
            print(f"  - {problem}")
        print(
            "Recreate .venv_lb with lb-setup's venv step, and re-stage the launcher, "
            "on this machine; make sure both are gitignored and not committed."
        )
        return 1
    print(
        "MCP server paths OK: .venv_lb and the staged launcher are local to this machine."
    )
    for path in tracked_agent_configs(root):
        print(
            f"Warning: {path} is tracked by git. A pull can change the LaunchBridge "
            "entries in it, and an agent that approved the server by name would start "
            "the changed command without the guard. Keep it untracked, or review "
            "every change to it as code and re-run lb-setup after a pull that changes it."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
