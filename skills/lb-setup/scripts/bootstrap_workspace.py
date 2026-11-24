#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Prepare a repository for globally installed LaunchBridge skills.

A local install (`launchbridge`, Local) writes `.lb_workspace/` and the files
lb-setup starts from into the repository it runs in. A global install puts the
skills in each agent's user-level skills folder and changes no repository, so
lb-setup does that part itself, the first time it runs in a repository, from
the files the installer generated for every agent's lb-setup, beside the global
install record (`<state>/launchbridge/global/generated/`, see
install_script/lib/globalAssets.js):

    mode   whether this lb-setup is the repository's own (local) or a global one
    check  whether the repository is safe to prepare (writes nothing)
    init   check, then create what the repository needs

`init` verifies the generated files against the global install record (in the
user's state directory, outside every repository) before using any of them, and
creates, without writing through a symbolic link:

    .lb_workspace/ and its folders, .project_artifacts/ and its folders
    .lb_workspace/setup_status.md         from the template, merged with an existing one
    .lb_workspace/config/python_deps/     pyproject.toml and constraints.txt, with
                                          their SHA-256 recorded outside the repository
    .lb_workspace/config/lb_agents_reference.md
    AGENTS.md (when missing), or .lb_workspace/steering/AGENTS_LB.md to merge
    CLAUDE.md with @AGENTS.md

It keeps what it set the repository up with in the repository's state folder
(`global_setup.json`), and on a later `init` resets the setup_status.md rows
that a change to the global install affects. It never creates or trusts
`.venv_lb`: lb-setup builds and seals that (lb_guard.py).

Usage:
    python3 -I bootstrap_workspace.py mode  <codebase_abs_path>
    python3 -I bootstrap_workspace.py check <codebase_abs_path>
    python3 -I bootstrap_workspace.py init  <codebase_abs_path>

Output is one JSON object on stdout. Exit codes: 0 OK; 1 refused (the reasons
are in "problems", and nothing was written); 2 the command could not run (bad
arguments, no global install record).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import sys
import types
from pathlib import Path, PurePath


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
verify_integrity = _load_sibling("verify_integrity")

WORKSPACE = Path(".lb_workspace")
ARTIFACTS = Path(".project_artifacts")
VENV = Path(".venv_lb")
CONFIG = WORKSPACE / "config"
PYTHON_DEPS = CONFIG / "python_deps"
STATUS_FILE = WORKSPACE / "setup_status.md"
REFERENCE_FILE = CONFIG / "lb_agents_reference.md"
STEERING_FILE = WORKSPACE / "steering" / "AGENTS_LB.md"
LOCAL_MANIFEST = CONFIG / "version_manifest.json"
AGENTS_MD = Path("AGENTS.md")
CLAUDE_MD = Path("CLAUDE.md")
AGENTS_MD_REF = "@AGENTS.md"
DEPS_FILES = ("pyproject.toml", "constraints.txt")
SETUP_RECORD = "global_setup.json"
RECORD_FORMAT = 1
# The fields of the global install record a repository's setup depends on.
RECORD_FIELDS = (
    "version",
    "skills",
    "skillHashes",
    "externalManifestKeys",
    "generatedAssets",
    "pyprojectHash",
    "mcpTemplateHash",
    "agentsHash",
    "mcpGatedSkills",
)
META_STEPS = ("venv-setup", "mcp-setup", "agents-md-merge")
STATUS_WIDTH = len("not installed")
STATUS_ROW = re.compile(r"^\|\s+(\S+)\s+\|\s+(.+?)\s+\|$")

# Every folder this script may create, in order, besides the ones in
# workspace_layout.json, and every file it may write.
FIXED_DIRS = (WORKSPACE, CONFIG, PYTHON_DEPS, WORKSPACE / "steering")
WRITTEN_FILES = (
    STATUS_FILE,
    REFERENCE_FILE,
    PYTHON_DEPS / "pyproject.toml",
    PYTHON_DEPS / "constraints.txt",
    STEERING_FILE,
)


class Refused(Exception):
    """A reason not to prepare the repository."""


class CannotRun(Exception):
    """Nothing to prepare the repository from (no global install record)."""


# ── where things are ─────────────────────────────────────────────────────────


def skill_dir() -> Path:
    """The lb-setup skill folder this script runs from, as installed: in a
    symlink install the skill folder is a link into the LaunchBridge source,
    so its path is not resolved."""
    return Path(os.path.abspath(__file__)).parent.parent


def _inside(path: PurePath, root: PurePath) -> bool:
    """Whether `path` is `root` or under it (lexically: pass resolved paths).
    On Windows, PurePath compares without case."""
    try:
        return path == root or path.is_relative_to(root)
    except (TypeError, ValueError):
        return False


def install_mode(repo: Path, lb_setup: Path | None = None) -> str:
    """'local' when this lb-setup is installed in the repository, else 'global'.

    Both the paths as given and as resolved count: a project opened through a
    link (macOS' /tmp) names the same folders. Only the skills folder is
    resolved, not the skill folder: in a symlink install that is a link to the
    LaunchBridge source, which says nothing about where the skill is installed.
    """
    lb_setup = Path(os.path.abspath(lb_setup or skill_dir()))
    pairs = (
        (lb_setup, Path(os.path.abspath(repo))),
        (
            Path(os.path.realpath(lb_setup.parent)) / lb_setup.name,
            Path(os.path.realpath(repo)),
        ),
    )
    return "local" if any(_inside(s, r) for s, r in pairs) else "global"


def other_install_warning(repo: Path, mode: str) -> str | None:
    """A note when the repository has the other kind of install too."""
    if mode == "global" and (repo / LOCAL_MANIFEST).is_file():
        return (
            "This repository also has a local LaunchBridge install. Where both "
            "exist, Claude Code runs the global skills and Kiro and Roo Code run "
            "the local ones; keep one of them for this repository."
        )
    if (
        mode == "local"
        and (
            verify_integrity.global_state_dir() / verify_integrity.GLOBAL_MANIFEST
        ).is_file()
    ):
        return (
            "A global LaunchBridge install exists too. Where both exist, Claude "
            "Code runs the global skills and Kiro and Roo Code run the local ones."
        )
    return None


def generated_dir() -> Path:
    """The files the global install generated, one copy for every agent."""
    return verify_integrity.global_generated_dir()


def _layout_dirs() -> list[Path]:
    """The folders workspace_layout.json lists, as repository-relative paths.
    Read only to know what to check; init uses it after verifying it."""
    try:
        layout = json.loads(
            (generated_dir() / "workspace_layout.json").read_text(encoding="utf-8")
        )
        dirs: list[Path] = []
        for key in ("workspace", "artifacts"):
            part = layout[key]
            root = Path(str(part["root"]))
            dirs.append(root)
            dirs.extend(root / str(sub) for sub in part["subdirectories"])
    except (OSError, ValueError, KeyError, TypeError):
        return []
    return dirs


def _safe_rel(rel: PurePath) -> bool:
    """A plain relative path: no root or drive, no `..`, no empty part."""
    return (
        bool(rel.parts)
        and not rel.is_absolute()
        and not rel.drive
        and not rel.root
        and all(part not in ("", ".", "..") for part in rel.parts)
    )


# ── check ────────────────────────────────────────────────────────────────────


def path_problem(repo: Path, rel: Path, *, allow_file: bool = False) -> str | None:
    """Why `repo / rel` can't be written to: a component is a link, or a
    component before the last is not a folder. Missing components are fine."""
    current = repo
    parts = rel.parts
    for i, part in enumerate(parts):
        current = current / part
        try:
            stats = current.lstat()
        except FileNotFoundError:
            return None
        except OSError as exc:
            return f"{current} can't be read ({exc.strerror})"
        if os.path.islink(current) or verify_integrity._is_junction(current):
            return f"{current} is a symbolic link"
        last = i == len(parts) - 1
        if not stat.S_ISDIR(stats.st_mode) and not (
            last and allow_file and stat.S_ISREG(stats.st_mode)
        ):
            return f"{current} is not a {'file' if last and allow_file else 'folder'}"
    return None


def location_problems(
    repo: PurePath,
    *,
    home: PurePath,
    state: PurePath,
    source: PurePath | None,
    skills_dirs: list[PurePath],
) -> list[str]:
    """Why a folder, given by its resolved path, is not a project to prepare:
    the file system's root, the home folder or one above it, or a folder inside
    the LaunchBridge source, its state folder or a user-level skills folder (or
    one holding the state folder)."""
    found = []
    if repo.parent == repo:
        found.append(f"{repo} is the root of the file system, not a project")
    if repo == home or _inside(home, repo):
        found.append(
            f"{repo} is your home folder or a folder above it, not a project; "
            "open the project's own folder"
        )
    if source is not None and _inside(repo, source):
        found.append(f"{repo} is inside the LaunchBridge source ({source})")
    if _inside(repo, state):
        found.append(f"{repo} is inside the LaunchBridge state folder ({state})")
    elif _inside(state, repo):
        found.append(
            f"the LaunchBridge state folder {state} is inside {repo}; set "
            "XDG_CONFIG_HOME to a folder outside it"
        )
    for skills in skills_dirs:
        if _inside(repo, skills):
            found.append(f"{repo} is inside the skills folder {skills}")
    return found


def check(repo_arg: str | Path, lb_setup: Path | None = None) -> dict:
    """Every reason not to prepare the repository, and notes worth showing."""
    lb_setup = lb_setup or skill_dir()
    problems: list[str] = []
    warnings: list[str] = []
    repo = Path(repo_arg)

    if not repo.is_absolute():
        return {"ok": False, "problems": [f"{repo} is not an absolute path"]}
    if not repo.is_dir():
        return {"ok": False, "problems": [f"{repo} is not an existing folder"]}
    if hasattr(os, "getuid") and repo.stat().st_uid != os.getuid():
        problems.append(f"{repo} is not owned by the current user")
    source = verify_integrity.global_install_source()
    problems += location_problems(
        Path(os.path.realpath(repo)),
        home=Path(os.path.realpath(Path.home())),
        state=Path(os.path.realpath(verify_integrity.state_base() / "launchbridge")),
        source=Path(os.path.realpath(source)) if source else None,
        skills_dirs=[
            Path(os.path.realpath(Path.home() / rel))
            for rel in sorted(set(verify_integrity.AGENT_GLOBAL_SKILLS_DIRS.values()))
        ],
    )

    dirs = [*FIXED_DIRS, *_layout_dirs(), ARTIFACTS, VENV]
    for rel in dirs:
        if not _safe_rel(rel):
            problems.append(f"workspace_layout.json names {rel}, outside {repo}")
            continue
        found = path_problem(repo, rel)
        if found:
            problems.append(found)
    for rel in WRITTEN_FILES:
        found = path_problem(repo, rel, allow_file=True)
        if found:
            problems.append(found)
    for rel in (AGENTS_MD, CLAUDE_MD):
        path = repo / rel
        if os.path.islink(path):
            warnings.append(
                f"{path} is a symbolic link, so LaunchBridge won't change it; "
                "make the change it asks for in the file it points to"
            )
        elif path.exists() and not path.is_file():
            problems.append(f"{path} is not a file")

    tracked, git_error = lb_guard._git_tracked(repo)
    if tracked is None:
        problems.append(
            "git could not read this repository to check for tracked LaunchBridge "
            f"files ({git_error or 'no output'})"
        )
    else:
        for path in tracked:
            if path not in lb_guard.TRACKED_OK and os.path.lexists(repo / path):
                problems.append(
                    f"{path} is tracked by git; LaunchBridge files there must be local"
                )

    if not problems:
        note = other_install_warning(repo, install_mode(repo, lb_setup))
        if note:
            warnings.append(note)
    problems = list(dict.fromkeys(lb_guard.printable(p) for p in problems))
    return {
        "ok": not problems,
        "problems": problems,
        "warnings": [lb_guard.printable(w) for w in warnings],
    }


# ── init ─────────────────────────────────────────────────────────────────────


def _write_file(path: Path, data: bytes) -> None:
    """Writes `data` as a new regular file at `path`, never through a link: an
    existing regular file is removed first, and the open refuses anything that
    is already there."""
    if os.path.lexists(path):
        if os.path.islink(path) or not path.is_file():
            raise Refused(f"{path} is not a regular file")
        path.unlink()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o644)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)


def _read(path: Path) -> bytes | None:
    try:
        if os.path.islink(path) or not path.is_file():
            return None
        return path.read_bytes()
    except OSError:
        return None


def _ensure_dir(repo: Path, rel: Path, created: list[str]) -> None:
    current = repo
    for part in rel.parts:
        current = current / part
        if os.path.islink(current):
            raise Refused(f"{current} is a symbolic link")
        if not current.exists():
            current.mkdir()
            created.append(current.relative_to(repo).as_posix() + "/")
        elif not current.is_dir():
            raise Refused(f"{current} is not a folder")


def parse_status(text: str) -> dict[str, str]:
    """Rows of setup_status.md, by name (as setupStatus.js reads them)."""
    rows: dict[str, str] = {}
    for line in text.split("\n"):
        match = STATUS_ROW.match(line)
        if match:
            name, status = match.group(1).strip(), match.group(2).strip()
            if name not in ("Skill", "Skill / Task") and not set(name) <= {"-"}:
                rows[name] = status
    return rows


def render_status(rows: list[tuple[str, str]]) -> str:
    """setup_status.md for `rows`, byte for byte as setupStatus.js writes it."""
    width = max([len(name) for name, _ in rows] + [len("Skill / Task")])
    lines = [
        "# LaunchBridge Setup Status",
        "",
        f"| {'Skill / Task'.ljust(width)} | {'Status'.ljust(STATUS_WIDTH)} |",
        f"| {'-' * width} | {'-' * STATUS_WIDTH} |",
        *(f"| {n.ljust(width)} | {s.ljust(STATUS_WIDTH)} |" for n, s in rows),
        "",
    ]
    return "\n".join(lines)


def merge_status(
    existing: dict[str, str], template: list[tuple[str, str]]
) -> list[tuple[str, str]]:
    """The template's rows, keeping the progress an existing file records:
    a meta-step keeps its status; a skill outside the selection is
    `not installed`; a selected skill keeps a status other than `not installed`."""
    rows = []
    for name, status in template:
        current = existing.get(name)
        if name in META_STEPS:
            rows.append((name, current or status))
        elif status == "not installed":
            rows.append((name, status))
        elif current and current != "not installed":
            rows.append((name, current))
        else:
            rows.append((name, status))
    return rows


def status_resets(previous: dict, manifest: dict) -> dict[str, str]:
    """The rows a change to the global install since the last init resets."""
    resets: dict[str, str] = {}
    before = previous.get("skillHashes") or {}
    now = manifest.get("skillHashes") or {}
    external = set(manifest.get("externalManifestKeys") or [])
    requires = manifest.get("skillRequiresSetup") or {}
    changed = [k for k in now if k in before and before[k] != now[k]]
    for key in changed:
        if key == "lb-setup":
            continue
        if key in external:
            resets[key] = "ready"
        else:
            resets[key] = "not started" if requires.get(key) else "ready"

    assets_before = previous.get("generatedAssets") or {}
    assets_now = manifest.get("generatedAssets") or {}
    if any(
        assets_before.get(f"python_deps/{n}") != assets_now.get(f"python_deps/{n}")
        for n in DEPS_FILES
    ):
        resets["venv-setup"] = "not started"

    gated = set(manifest.get("mcpGatedSkills") or [])
    selection_change = set(previous.get("skills") or []) ^ set(
        manifest.get("skills") or []
    )
    if previous.get("mcpTemplateHash") != manifest.get("mcpTemplateHash") or (
        selection_change & gated
    ):
        resets["mcp-setup"] = "not started"
    if (
        changed
        or selection_change
        or previous.get("agentsHash") != manifest.get("agentsHash")
    ):
        resets["agents-md-merge"] = "not started"
    return resets


def _setup_record(manifest: dict) -> dict:
    return {
        "format": RECORD_FORMAT,
        **{key: manifest.get(key) for key in RECORD_FIELDS},
    }


def load_manifest(repo: Path, lb_setup: Path) -> dict:
    """The global install record, once the generated files beside it match it
    and it lists this lb-setup as one it installed."""
    try:
        manifest, _ = verify_integrity.load_global_manifest(repo)
    except FileNotFoundError as exc:
        raise CannotRun(str(exc)) from exc
    except (ValueError, json.JSONDecodeError, OSError) as exc:
        raise Refused(str(exc)) from exc
    home = Path(os.path.abspath(Path.home()))
    try:
        rel = Path(os.path.abspath(lb_setup)).relative_to(home).as_posix()
    except ValueError:
        rel = None
    targets = manifest.get("installedTargets")
    if isinstance(targets, list) and rel not in targets:
        raise Refused(
            f"{lb_setup} is not an lb-setup the global install put there; run "
            "`launchbridge` again and choose Global"
        )
    problem = verify_integrity.check_generated_assets(manifest.get("generatedAssets"))
    if problem:
        raise Refused(
            f"the files lb-setup prepares the repository from are not what the "
            f"global install wrote ({problem}); run `launchbridge update`, or "
            "`launchbridge` again and choose Global"
        )
    return manifest


def init(repo: Path, lb_setup: Path | None = None) -> dict:
    """Prepare the repository; see the module docstring."""
    lb_setup = lb_setup or skill_dir()
    checked = check(repo, lb_setup)
    if not checked["ok"]:
        return {**checked, "created": [], "updated": [], "staged": []}
    warnings = list(checked["warnings"])
    manifest = load_manifest(repo, lb_setup)
    assets = generated_dir()
    created: list[str] = []
    updated: list[str] = []
    staged: list[str] = []
    notes: list[str] = []

    def put(rel: Path, data: bytes) -> bool:
        path = repo / rel
        if _read(path) == data:
            return False
        existed = os.path.lexists(path)
        _write_file(path, data)
        (updated if existed else created).append(rel.as_posix())
        return True

    # 1. Folders.
    layout = json.loads((assets / "workspace_layout.json").read_text(encoding="utf-8"))
    for rel in FIXED_DIRS[:2]:
        _ensure_dir(repo, rel, created)
    for key in ("workspace", "artifacts"):
        root = Path(str(layout[key]["root"]))
        for rel in [root, *(root / str(s) for s in layout[key]["subdirectories"])]:
            if not _safe_rel(rel):
                raise Refused(f"workspace_layout.json names {rel}, outside {repo}")
            _ensure_dir(repo, rel, created)

    # 2. The status table, with what changed since the last init reset.
    record_path = venv_identity.record_path(repo, SETUP_RECORD)
    try:
        previous = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = None
    template = list(
        parse_status((assets / "setup_status.md").read_text(encoding="utf-8")).items()
    )
    existing_text = _read(repo / STATUS_FILE)
    if existing_text is None:
        rows = template
    else:
        rows = merge_status(parse_status(existing_text.decode("utf-8")), template)
    resets: dict[str, str] = {}
    changes = status_resets(previous, manifest) if isinstance(previous, dict) else {}
    if existing_text is not None:
        rows = [
            (n, changes[n] if n in changes and s != "not installed" else s)
            for n, s in rows
        ]
        resets = {n: s for n, s in changes.items() if dict(rows).get(n) == s}
    put(STATUS_FILE, render_status(rows).encode("utf-8"))

    # 3. python_deps, recreated when it is not exactly the generated files, and
    #    its record outside the repository (what venv_identity.py deps checks).
    deps = {n: (assets / "python_deps" / n).read_bytes() for n in DEPS_FILES}
    deps_dir = repo / PYTHON_DEPS
    present = sorted(p.name for p in deps_dir.iterdir()) if deps_dir.is_dir() else []
    if present != sorted(DEPS_FILES) or any(
        _read(deps_dir / n) != data for n, data in deps.items()
    ):
        if deps_dir.exists():
            shutil.rmtree(deps_dir)
            updated.append(PYTHON_DEPS.as_posix() + "/")
        else:
            created.append(PYTHON_DEPS.as_posix() + "/")
        deps_dir.mkdir()
        for name, data in deps.items():
            _write_file(deps_dir / name, data)
    deps_record = (
        json.dumps(
            {n: hashlib.sha256(data).hexdigest() for n, data in deps.items()},
            indent=2,
        )
        + "\n"
    )
    record_file = venv_identity.record_path(repo, venv_identity.DEPS_RECORD_FILE)
    if _read(record_file) != deps_record.encode("utf-8"):
        venv_identity._write_private(record_file, deps_record)

    # 4. The AGENTS.md reference, AGENTS.md itself, and CLAUDE.md.
    reference = (assets / "lb_agents_reference.md").read_bytes()
    put(REFERENCE_FILE, reference)
    agents_md = repo / AGENTS_MD
    # As a local install's updater does: on the first setup, and after the
    # reference or the skills changed, an existing AGENTS.md gets the new
    # reference staged beside it for lb-setup to merge.
    reference_changed = not isinstance(previous, dict) or "agents-md-merge" in changes
    pending = _read(repo / STEERING_FILE)
    if os.path.islink(agents_md):
        _ensure_dir(repo, STEERING_FILE.parent, created)
        if put(STEERING_FILE, reference):
            staged.append(STEERING_FILE.as_posix())
        notes.append(
            "AGENTS.md is a symbolic link, so it was not changed. Merge "
            f"{STEERING_FILE.as_posix()} into the file it points to."
        )
    elif not agents_md.exists():
        put(AGENTS_MD, reference)
    elif pending is not None and pending != reference:
        # A pending copy is LaunchBridge's own instructions once merged: one
        # that isn't this version's (older, or arrived with the repository)
        # is replaced.
        put(STEERING_FILE, reference)
        staged.append(STEERING_FILE.as_posix())
    elif pending is None and reference_changed and _read(agents_md) != reference:
        _ensure_dir(repo, STEERING_FILE.parent, created)
        put(STEERING_FILE, reference)
        staged.append(STEERING_FILE.as_posix())
    if staged and "agents-md-merge" in dict(rows):
        if dict(rows)["agents-md-merge"] != "not started":
            rows = [
                (n, "not started" if n == "agents-md-merge" else s) for n, s in rows
            ]
            resets["agents-md-merge"] = "not started"
            put(STATUS_FILE, render_status(rows).encode("utf-8"))

    claude_md = repo / CLAUDE_MD
    if os.path.islink(claude_md):
        notes.append(
            f"CLAUDE.md is a symbolic link, so it was not changed. Add "
            f"{AGENTS_MD_REF} to the file it points to."
        )
    else:
        text = _read(claude_md)
        if text is None:
            put(CLAUDE_MD, f"{AGENTS_MD_REF}\n".encode("utf-8"))
        elif AGENTS_MD_REF.encode("utf-8") not in text:
            put(CLAUDE_MD, f"{AGENTS_MD_REF}\n".encode("utf-8") + text)

    # 5. What this repository was set up with.
    record = json.dumps(_setup_record(manifest), indent=2, sort_keys=True) + "\n"
    if _read(record_path) != record.encode("utf-8"):
        venv_identity._write_private(record_path, record)

    return {
        "ok": True,
        "problems": [],
        "warnings": warnings,
        "created": created,
        "updated": updated,
        "staged": staged,
        "resets": resets,
        "notes": notes,
        "version": manifest.get("version"),
    }


# ── command line ─────────────────────────────────────────────────────────────


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ("mode", "check", "init"):
        print(
            "usage: bootstrap_workspace.py mode|check|init <codebase_abs_path>",
            file=sys.stderr,
        )
        return 2
    command, repo = argv[1], Path(argv[2])
    try:
        if command == "mode":
            if not repo.is_dir():
                print(f"{repo} is not an existing folder", file=sys.stderr)
                return 2
            mode = install_mode(repo)
            note = other_install_warning(repo, mode)
            result = {
                "mode": mode,
                "skill_dir": str(skill_dir()),
                "repo": str(repo),
                "warnings": [note] if note else [],
            }
            print(json.dumps(result, indent=2))
            return 0
        if command == "check":
            result = check(repo)
            print(json.dumps(result, indent=2))
            return 0 if result["ok"] else 1
        try:
            result = init(repo)
        except CannotRun as exc:
            print(
                json.dumps(
                    {"ok": False, "problems": [lb_guard.printable(str(exc))]},
                    indent=2,
                )
            )
            return 2
        except Refused as exc:
            result = {"ok": False, "problems": [lb_guard.printable(str(exc))]}
        print(json.dumps(result, indent=2))
        return 0 if result["ok"] else 1
    except OSError as exc:
        print(f"bootstrap_workspace: {command} failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
