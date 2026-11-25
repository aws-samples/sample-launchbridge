#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Check a repository's LaunchBridge files before anything runs from them.

`.venv_lb/` and `.lb_workspace/` live inside the repository, so files can arrive
with it, or with a later `git pull` of a commit that force-added them: a `.pth`
file in the venv runs whenever its Python starts (even with -I), a link in the
index folder makes IRIS write outside the repository, and a replaced launcher runs
before any of its checks. After lb-setup builds the venv and stages the launcher,
it seals them here: a manifest of the venv (every file's path, size, mtime and
inode; every link's target), the venv's base interpreter, and the launcher's
SHA-256, in the user's state directory outside every repository. Before a
LaunchBridge process starts, this script refuses if:

- the venv was not recorded by lb-setup (venv_identity.py), differs from the seal,
  holds bytecode with no source, or its base interpreter is gone;
- `.lb_workspace/` holds a symbolic link (every skill writes its output there) or
  a folder that can't be listed;
- `.venv_lb/`, `.lb_workspace/config/` or `.lb_workspace/indexing_and_qa/` holds a
  file tracked by git (other than the tracked config files), or a submodule
  reaches into them, or git can't read the repository to tell;
- the staged launcher is not the one lb-setup staged.

Git matches names case-insensitively for ASCII letters only, so a tracked path
spelled with a Unicode letter a case-insensitive file system folds to ASCII (the
Kelvin sign for `k`, the long s for `s`) is not seen as tracked. It can only add files that don't exist
yet, and every file LaunchBridge reads there is checked on its own.

`exec` then starts the venv's Python with the bytecode cache in the state directory
(`-X pycache_prefix`), so no `__pycache__` in the repository is ever read.
Before it does, it looks at what git tracks in the installed skill folder the
script or a PYTHONPATH entry is in: the script's folder comes first on the path,
so a file a pulled commit added there would be imported. Tracked importable files
in a skill folder whose SKILL.md git doesn't track were added to a local install
by a pull, and are refused. Teams may commit whole skills folders on purpose, so
tracked files beside a tracked SKILL.md, or in a folder that isn't a skill's, are
reported for review and Python starts. Tracked bytecode outside __pycache__ is
refused in any of these folders: Python would run it with no source to review,
and LaunchBridge ships none.

These checks run when a process starts. Git overwrites an ignored file when a
pulled commit tracks the same path, so a `git pull` while a long-running server
is up can change `.venv_lb/` after its checks. The Q&A launcher therefore records
the repository's git state (`git_dir`) and runs these checks again before a
question when the index or HEAD has changed since. A change made without git (an
archive unpacked into the repository while a server runs) is found at the next
start. The AWS Documentation MCP server, also long-running and started from
`.venv_lb/`, and indexing runs are not rechecked: restart the LaunchBridge MCP
servers after changing the repository's files.

Run it with an interpreter outside the repository: `python3 -I` for the checks, and
the sealed base interpreter with `-I -S` (no site, so no `.pth` runs) for `exec`.

Usage:
    lb_guard.py seal-venv <repo>         # after lb-setup installs .venv_lb
    lb_guard.py seal-launcher <repo>     # after lb-setup stages the launcher
    lb_guard.py check <repo>
    lb_guard.py paths <repo>             # base interpreter and staged guard, as JSON
    lb_guard.py exec <repo> -- ARGS...   # check, then run .venv_lb's Python with ARGS
    lb_guard.py exec-script <repo> NAME -- ARGS...   # check, then run a venv script

Exit codes: 0 sealed / clean / printed; 1 refused (each reason printed to stderr);
2 bad arguments. `exec` returns the started program's exit code.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import stat
import subprocess
import sys
from pathlib import Path

VENV = ".venv_lb"
VENV_ID_FILE = ".launchbridge_venv_id"
VENV_RECORD = "venv_id"
SEAL_FILE = "venv_seal.json"
# Bumped when the manifest's contents change (2: inodes), so an older seal is
# reported as older, not as a changed venv.
SEAL_FORMAT = 2
GUARD_COPY = "lb_guard.py"
WORKSPACE = Path(".lb_workspace")
LAUNCHER_REL = WORKSPACE / "config" / "mcp_v1_compat.py"
# Folders LaunchBridge runs from or writes into, where a link or a tracked file
# can only have arrived with the repository.
GUARDED = (
    Path(VENV),
    Path(".lb_workspace") / "config",
    Path(".lb_workspace") / "indexing_and_qa",
)
# Files lb-setup asks the user to commit (see its .gitignore block), and two that
# older installs had users commit and nothing reads any more (the records now
# live in the state directory).
TRACKED_OK = {
    ".lb_workspace/config/config-prompt-store.yaml",
    ".lb_workspace/config/skill_digests.json",
    ".lb_workspace/config/data_handling_confirmation.json",
    ".lb_workspace/config/permission_scope_ack.json",
}


def state_dir() -> Path:
    """The user's LaunchBridge state directory, outside every repository.

    A relative XDG_CONFIG_HOME is ignored, as the XDG spec requires: it would
    resolve against the working directory, which can be the repository itself.
    """
    base = os.environ.get("XDG_CONFIG_HOME", "")
    if not os.path.isabs(base):
        base = str(Path.home() / ".config")
    return Path(base) / "launchbridge"


def repo_state(repo: Path) -> Path:
    resolved = str(Path(repo).resolve())
    key = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16]
    return state_dir() / "repos" / key


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


def _is_bytecode(name: str) -> bool:
    lower = name.lower()
    return lower == "__pycache__" or lower.endswith(".pyc")


def _walk(top: Path, unreadable: list[str]):
    """os.walk without following links, noting every folder it can't list.

    os.walk skips such a folder silently, and Python still imports from one it
    can enter: an archive can unpack a folder with mode 0o311.
    """
    return os.walk(
        top, followlinks=False, onerror=lambda error: unreadable.append(error.filename)
    )


def scan_venv(repo: Path) -> tuple[str, list[str], list[str]]:
    """(manifest, sourceless bytecode, unreadable folders) for the venv.

    The manifest is a SHA-256 over every entry's path, size, mtime and inode, or
    its link target. The bytecode cache is left out: every LaunchBridge process
    runs with its cache in the state directory (`exec`), so none reads it, and
    pip writes it at install time. A `.pyc` outside it is listed instead: Python
    imports one with no `.py` beside it whatever the cache location, and pip
    never installs one.
    """
    root = Path(repo) / VENV
    hasher = hashlib.sha256()
    sourceless: list[str] = []
    unreadable: list[str] = []
    for directory, dirs, files in _walk(root, unreadable):
        here = Path(directory)
        if here.name.lower() == "__pycache__":
            continue
        dirs[:] = sorted(d for d in dirs if not _is_bytecode(d))
        for name in sorted(dirs + files):
            path = here / name
            rel = path.relative_to(root).as_posix()
            if name.lower().endswith(".pyc") and name in files:
                sourceless.append(str(path))
            if rel == VENV_ID_FILE or _is_bytecode(name):
                continue
            try:
                stats = os.lstat(path)
                link = os.readlink(path) if path.is_symlink() else None
            except OSError:
                unreadable.append(str(path))  # a folder that can't be entered
                continue
            if link is not None:
                entry = f"L\0{rel}\0{link}"
            elif stat.S_ISDIR(stats.st_mode):
                continue
            else:
                entry = (
                    f"F\0{rel}\0{stats.st_size}\0{stats.st_mtime_ns}\0{stats.st_ino}"
                )
            hasher.update(entry.encode("utf-8", "surrogateescape") + b"\n")
    return hasher.hexdigest(), sorted(sourceless), sorted(unreadable)


def venv_manifest(repo: Path) -> str:
    return scan_venv(repo)[0]


def sourceless_bytecode(repo: Path) -> list[str]:
    return scan_venv(repo)[1]


def venv_python(repo: Path) -> Path:
    scripts = "Scripts" if os.name == "nt" else "bin"
    name = "python.exe" if os.name == "nt" else "python"
    return Path(repo) / VENV / scripts / name


def base_python(repo: Path) -> str:
    """The interpreter the venv was built from (outside the repository).

    The path in the venv's `home` is kept as it is, not resolved: a package
    manager's stable path (Homebrew's `opt/`) survives a patch upgrade, the
    versioned folder it points at does not. The venv's own minor version is
    tried first, so an older `python3` in the same folder is not picked.
    """
    cfg = Path(repo) / VENV / "pyvenv.cfg"
    values = {}
    for line in cfg.read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        values[key.strip().lower()] = value.strip()
    version = values.get("version_info") or values.get("version") or ""
    minor = ".".join(version.split(".")[:2])
    homes = [Path(values["home"])] if values.get("home") else []
    if values.get("executable"):
        homes.append(Path(values["executable"]).parent)
    if os.name == "nt":
        names = ["python.exe"]
    else:
        names = ([f"python{minor}"] if minor else []) + ["python3", "python"]
    for home in homes:
        for name in names:
            if (home / name).is_file():
                return str(home / name)
    raise ValueError(f"pyvenv.cfg names no usable interpreter in {homes}")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_seal(repo: Path) -> dict:
    try:
        seal = json.loads((repo_state(repo) / SEAL_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return seal if isinstance(seal, dict) else {}


def _save_seal(repo: Path, seal: dict) -> None:
    target = repo_state(repo) / SEAL_FILE
    if target.resolve().is_relative_to(Path(repo).resolve()):
        raise ValueError(
            f"{target} is inside the repository; the LaunchBridge state directory "
            "(XDG_CONFIG_HOME or ~/.config) must be outside it"
        )
    _write_private(target, json.dumps(seal, indent=2) + "\n")
    # The MCP servers run this file from the state directory, outside the
    # repository, so a change to the repository can't change the guard.
    _write_private(
        repo_state(repo) / GUARD_COPY, Path(__file__).read_text(encoding="utf-8")
    )
    (repo_state(repo) / "base_python").write_text(
        seal.get("base_python", ""), encoding="utf-8"
    )


def seal_venv(repo: Path) -> dict:
    repo = Path(repo)
    seal = _load_seal(repo)
    seal["base_python"] = base_python(repo)
    seal["venv_manifest"] = venv_manifest(repo)
    seal["format"] = SEAL_FORMAT
    _save_seal(repo, seal)
    return seal


def seal_launcher(repo: Path) -> dict:
    repo = Path(repo)
    seal = _load_seal(repo)
    try:
        seal["base_python"] = base_python(repo)
    except (OSError, ValueError, KeyError):
        pass  # problems() reports a missing interpreter
    seal["launcher_sha256"] = _sha256(repo / LAUNCHER_REL)
    _save_seal(repo, seal)
    return seal


def find_tool(name: str, repo: Path) -> str | None:
    """The absolute path of `name` on PATH, never one from the repository.

    On Windows a bare name is looked up in the current directory first (by
    shutil.which before Python 3.12 and by CreateProcess), and MCP hosts start
    servers in the project root, so a committed git.cmd would run. PATH is
    searched entry by entry instead, skipping an entry that isn't absolute, is
    the current directory or is inside the repository.
    """
    if os.name == "nt":
        os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    cwd = Path.cwd().resolve()
    root = Path(repo).resolve()
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry or not os.path.isabs(entry):
            continue
        folder = Path(entry).resolve()
        if folder == cwd or folder.is_relative_to(root):
            continue
        found = shutil.which(name, path=entry)
        if found and os.path.isabs(found):
            if not Path(found).resolve().is_relative_to(root):
                return found
    return None


def git_env() -> dict[str, str]:
    """The environment for LaunchBridge's own git calls: none of git's GIT_*
    variables, which could point it at another index or work tree, and git's
    messages untranslated, so a "not a git repository" answer can be read."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env.update(LC_ALL="C", LANGUAGE="")
    return env


def _in_git_repository(repo: Path) -> bool:
    """Whether the repository or a folder above it has a `.git`, as git itself
    looks for one (a project inside a larger repository has none of its own).
    Only whether each `.git` exists is checked; nothing in it is read. Both the
    path as given and the folder it resolves to count, since a project reached
    through a link sits in another tree."""
    folders = {Path(os.path.abspath(repo)), Path(os.path.realpath(repo))}
    return any(
        os.path.lexists(f / ".git")
        for folder in folders
        for f in (folder, *folder.parents)
    )


def _git_failure_leaves_state_unknown(repo: Path, message: str) -> bool:
    """Whether a git call that failed leaves unknown what the repository tracks.

    With its own .git, any failure does (a damaged index, an ownership check).
    A .git only in a folder above counts unless git, having looked, answered
    that this is not a repository: a stray or empty `.git` higher up is not one.
    Git that stopped looking at a mount point hasn't answered for the folders
    beyond it: a repository above the mount can still write into the project.
    """
    if os.path.lexists(Path(repo) / ".git"):
        return True
    if not _in_git_repository(repo):
        return False
    if "not a git repository" not in message:
        return True
    if "Stopping at filesystem boundary" in message:
        return _git_beyond_mount(repo)
    return False


def _git_beyond_mount(repo: Path) -> bool:
    """Whether a `.git` exists in a folder above the mount point the repository
    is under, where git stops looking (only whether each exists is checked)."""
    folder = Path(os.path.realpath(repo))
    try:
        device = _device(folder)
        beyond = False
        for parent in folder.parents:
            beyond = beyond or _device(parent) != device
            if beyond and os.path.lexists(parent / ".git"):
                return True
    except OSError:
        return True
    return False


def _device(path: Path) -> int:
    return os.stat(path).st_dev


def _git_tracked(repo: Path) -> tuple[list[str] | None, str]:
    """(tracked paths in the guarded folders, or None if unknown; git's error)."""
    git = find_tool("git", repo)
    if not git:
        if _in_git_repository(repo):
            return None, (
                "no usable git outside the repository on PATH; install git or "
                "add its folder to PATH"
            )
        return [], ""  # no git and no repository: nothing here is tracked or pulled
    try:
        # The repository's own config can name programs git runs while it reads
        # the index (core.fsmonitor); none may run here.
        base = [git, "-c", "core.fsmonitor=false", "-C", str(repo)]
        inside = subprocess.run(  # nosec B603 - fixed git argv, shell=False
            [*base, "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            timeout=30,
            env=git_env(),
        )
        if inside.returncode != 0:
            # Not a repository, unless git refused to read one (a damaged index,
            # an ownership check): then nothing is known.
            if _git_failure_leaves_state_unknown(repo, inside.stderr):
                return None, inside.stderr.strip()
            return [], ""
        listed = subprocess.run(  # nosec B603 - fixed git argv, shell=False
            # Case-insensitively: on macOS and Windows a pulled `.VENV_LB/x.pth`
            # lands in `.venv_lb/`. With stages, so a submodule shows up.
            [
                *base,
                "ls-files",
                "-s",
                "-z",
                "--",
                f":(icase){VENV}",
                ":(icase).lb_workspace",
            ],
            capture_output=True,
            timeout=30,
            env=git_env(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return None, str(exc)
    if listed.returncode != 0:
        return None, os.fsdecode(listed.stderr).strip()
    tracked = []
    for raw in listed.stdout.split(b"\0"):
        info, _, path = os.fsdecode(raw).partition("\t")
        if not path:
            continue
        if info.startswith("160000 "):
            # A submodule at or above a guarded folder checks files out into it
            # that the index of this repository doesn't list.
            folded = path.casefold().rstrip("/")
            if any(
                g.as_posix().casefold().startswith(folded + "/")
                or folded == g.as_posix().casefold()
                or folded.startswith(g.as_posix().casefold() + "/")
                for g in GUARDED
            ):
                tracked.append(path)
            continue
        folded = path.casefold()
        if any(folded.startswith(g.as_posix().casefold() + "/") for g in GUARDED):
            tracked.append(path)
    return tracked, ""


def git_dir(repo: Path) -> Path | None:
    """The repository's git directory, absolute, or None outside a git repository.

    A pull, merge or checkout that writes into the working tree rewrites the
    index there, so watching its index and HEAD tells when to check again.
    """
    git = find_tool("git", repo)
    if not git:
        return None
    try:
        out = subprocess.run(  # nosec B603 - fixed git argv, shell=False
            [
                git,
                "-c",
                "core.fsmonitor=false",
                "-C",
                str(repo),
                "rev-parse",
                "--absolute-git-dir",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env=git_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    return Path(out.stdout.strip())


def printable(text: str) -> str:
    """`text` with control and format characters (newlines, escapes, bidi marks)
    written as escapes: the file names in a finding come from the repository, and
    an agent or terminal shows them."""
    return "".join(c if c.isprintable() else repr(c)[1:-1] for c in text)


def problems(repo: Path, *, need_launcher: bool = False) -> list[str]:
    """Every reason not to run from this repository's LaunchBridge files, with
    file names made printable."""
    return [printable(p) for p in _problems(repo, need_launcher=need_launcher)]


def _problems(repo: Path, *, need_launcher: bool = False) -> list[str]:
    repo = Path(repo)
    found: list[str] = []
    venv = repo / VENV
    if repo_state(repo).resolve().is_relative_to(repo.resolve()):
        # Its seal and records would be the repository's own.
        return [
            f"the LaunchBridge state directory {repo_state(repo)} is inside the "
            "repository; set XDG_CONFIG_HOME to a folder outside it"
        ]

    # 1. lb-setup's own venv (the ID it recorded when it created it).
    try:
        in_venv = (venv / VENV_ID_FILE).read_text(encoding="utf-8").strip()
        recorded = (repo_state(repo) / VENV_RECORD).read_text(encoding="utf-8").strip()
    except OSError:
        in_venv = recorded = ""
    if not in_venv or not secrets.compare_digest(in_venv, recorded):
        found.append(
            f"{venv} was not created by lb-setup for this repository on this machine"
        )

    # 2. Its contents as lb-setup sealed them, and the interpreter it was built from.
    seal = _load_seal(repo)
    if seal.get("base_python") and not Path(seal["base_python"]).is_file():
        found.append(
            f"the Python {venv} was built from ({seal['base_python']}) is gone, "
            "for example after a Python upgrade"
        )
    manifest, sourceless, unreadable = (
        scan_venv(repo) if venv.is_dir() else ("", [], [])
    )
    for path in sourceless:
        found.append(f"{path} is bytecode with no source, which Python would run")
    if not seal.get("venv_manifest"):
        found.append(f"{venv} was never sealed by lb-setup on this machine")
    elif seal.get("format") != SEAL_FORMAT:
        found.append(
            f"{venv} was sealed by an older LaunchBridge, which recorded less; "
            "lb-setup rebuilds and seals it once"
        )
    elif venv.is_dir() and manifest != seal["venv_manifest"]:
        found.append(
            f"{venv} changed since lb-setup sealed it (a file was added, removed or "
            "modified, for example by a git pull or an unpacked archive)"
        )

    # 3. No links in .lb_workspace/ (every skill writes its output there), and
    #    nothing force-tracked in the folders LaunchBridge runs from. The venv's
    #    own links are covered by the manifest above.
    workspace = repo / WORKSPACE
    if workspace.is_symlink():
        found.append(f"{workspace} is a symbolic link")
    elif workspace.is_dir():
        for directory, dirs, files in _walk(workspace, unreadable):
            for name in dirs + files:
                path = Path(directory) / name
                try:
                    linked = path.is_symlink()
                except OSError:
                    unreadable.append(str(path))
                    continue
                if linked:
                    found.append(f"{path} is a symbolic link")
    for path in unreadable:
        found.append(f"{path} is a folder that can't be listed, so it can't be checked")
    tracked, git_error = _git_tracked(repo)
    if tracked is None:
        hint = (
            " If git reports dubious ownership, the repository belongs to another "
            "user: add it with `git config --global --add safe.directory <path>` "
            "only if you trust it."
            if "safe.directory" in git_error or "dubious ownership" in git_error
            else ""
        )
        found.append(
            "git could not read this repository to check for tracked LaunchBridge "
            f"files ({git_error or 'no output'}); rebuilding won't help.{hint}"
        )
    else:
        for path in tracked:
            # A file deleted from the working tree (`git rm --cached` pending)
            # is not there to run or be written through.
            if path not in TRACKED_OK and os.path.lexists(repo / path):
                found.append(
                    f"{path} is tracked by git; LaunchBridge files there must be local"
                )

    # 4. The launcher lb-setup staged.
    if need_launcher:
        launcher = repo / LAUNCHER_REL
        try:
            actual = _sha256(launcher)
        except OSError:
            actual = None
        if not seal.get("launcher_sha256") or actual != seal["launcher_sha256"]:
            found.append(f"{launcher} is not the launcher lb-setup staged")
    return found


# Console scripts that make no AWS API call, started without the developer's AWS_*
# environment variables (keys, session token, profile). Files under ~/.aws stay
# readable to them, as to any process of the user's. The AWS Documentation MCP
# server fetches public documentation and reads only its own
# AWS_DOCUMENTATION_* settings.
CREDENTIAL_FREE_SCRIPTS = frozenset({"awslabs.aws-documentation-mcp-server"})


def python_env(
    repo: Path, safe_path: bool = False, aws_credentials: bool = True
) -> dict[str, str]:
    """The environment for a program the guard starts.

    Python reads these variables when it starts. A user's PYTHONPATH with an
    empty entry (`export PYTHONPATH=$PYTHONPATH:/x` when it was unset) puts the
    working directory, the repository, on the path, so a repository-root json.py
    would load: empty entries, and entries that are or contain the working
    directory or the repository (a parent folder would import the repository as
    a package named after its folder), are dropped. Other entries are kept, made
    absolute, such as the metric library's folder however it was written (exec
    warns when git tracks importable files in them, and refuses for an installed
    skill folder whose SKILL.md git doesn't track; see import_findings). The user site
    isn't read. With `safe_path`
    (a `-m` or `-c` start, which puts the working directory on the path)
    PYTHONSAFEPATH keeps it off; a script start puts the script's own folder,
    the skill's, there instead, which the skills' sibling imports need.
    Without `aws_credentials`, every AWS_* variable but AWS_DOCUMENTATION_* is
    left out (keys, session token, profile, credential and config file paths).
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE")
    }
    exposed = (Path.cwd().resolve(), Path(repo).resolve())
    entries = [
        os.path.abspath(entry)
        for entry in env.get("PYTHONPATH", "").split(os.pathsep)
        if entry
        and not any(folder.is_relative_to(Path(entry).resolve()) for folder in exposed)
    ]
    if entries:
        env["PYTHONPATH"] = os.pathsep.join(entries)
    else:
        env.pop("PYTHONPATH", None)
    if safe_path:
        env["PYTHONSAFEPATH"] = "1"
    if not aws_credentials:
        env = {
            key: value
            for key, value in env.items()
            if not key.upper().startswith("AWS_")
            or key.upper().startswith("AWS_DOCUMENTATION_")
        }
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONPYCACHEPREFIX"] = str(repo_state(repo) / "pycache")
    return env


def _script_of(args: list[str]) -> str | None:
    """The script Python's arguments run, or None for -m, -c, - and no script."""
    takes_value = {"-X", "-W", "--check-hash-based-pycs"}
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg in takes_value:
            skip = True
            continue
        if arg == "-" or (
            arg.startswith("-") and not arg.startswith("--") and arg[-1] in "mc"
        ):
            return None
        if not arg.startswith("-"):
            return arg
    return None


def _skill_root(path: Path, repo: Path) -> Path:
    """The installed skill folder (`<agent>/skills/<name>`) holding `path`, or
    the path itself when it isn't in one."""
    for part in [path, *path.parents]:
        if part == repo or not part.is_relative_to(repo):
            break
        if part.parent.name.lower() == "skills":
            return part
    return path


# What Python can import from a folder on its path (a package is found through its
# __init__.py).
IMPORTABLE = (".py", ".pyc", ".pyw", ".pth", ".so", ".pyd", ".zip", ".egg")


def import_problems(repo: Path, args: list[str], env: dict[str, str]) -> list[str]:
    """Every finding of import_findings, refusals first."""
    refused, warned = import_findings(repo, args, env)
    return refused + warned


def _tracks_skill_md(repo: Path, root: Path, listed: list[str]) -> bool:
    """Whether git tracks the SKILL.md of the skill folder `root`.

    The file name must be exactly SKILL.md, the file the agent reads: on a
    case-sensitive file system a pulled `skill.md` is another file. Git may spell
    the folder in another case than the path Python was given (macOS, Windows),
    so its folder counts when it is the same folder on disk.
    """
    for path in listed:
        folder, _, name = path.rpartition("/")
        if (
            name != "SKILL.md"
            or folder.lower() != root.relative_to(repo).as_posix().lower()
        ):
            continue
        try:
            if os.path.samefile(repo / folder, root):
                return True
        except OSError:
            continue
    return False


def import_findings(
    repo: Path, args: list[str], env: dict[str, str]
) -> tuple[list[str], list[str]]:
    """Files the repository supplies that the Python about to start may import,
    as (refused, warned).

    A script start puts the script's own folder first on the path, and
    PYTHONPATH entries come next. For a skill those are inside the repository
    (`.claude/skills/<skill>/…`): a file git tracks there, such as a `json.py`
    a pulled commit added beside the script, would be imported. This lists
    what git tracks in the installed skill folder of the script and of any
    PYTHONPATH entry inside the repository.

    In a skill folder whose SKILL.md git doesn't track, tracked importable
    files mean a pulled commit added them to a local install: that is refused.
    A team that commits its skills folders tracks SKILL.md too, so there, and in
    a folder that isn't a skill's, the files are reported for review instead.

    A global install's skill folders are in the user's home folder, outside the
    repository, so nothing here looks at them: no commit to the repository can
    change them. verify_integrity.py --global checks them against the global
    install record instead.
    """
    repo = Path(repo).resolve()
    folders = []
    script = _script_of(args)
    if script:
        folders.append(Path(os.path.abspath(script)).resolve().parent)
    for entry in env.get("PYTHONPATH", "").split(os.pathsep):
        if entry:
            folders.append(Path(entry).resolve())
    sealed = (repo / LAUNCHER_REL).parent  # the launcher's folder: checked by its seal
    roots = sorted(
        {
            _skill_root(f, repo)
            for f in folders
            if f.is_relative_to(repo) and f != repo and f != sealed
        }
    )
    if not roots:
        return [], []
    git = find_tool("git", repo)
    if not git:
        if _in_git_repository(repo):
            return [], [
                "no usable git outside the repository on PATH (install git or add its "
                "folder to PATH) to check " + ", ".join(map(str, roots))
            ]
        return [], []
    refused: list[str] = []
    found: list[str] = []
    for root in roots:
        rel = root.relative_to(repo).as_posix()
        try:
            listed = subprocess.run(  # nosec B603 - fixed git argv, shell=False
                [
                    git,
                    "-c",
                    "core.fsmonitor=false",
                    "-C",
                    str(repo),
                    "ls-files",
                    "-z",
                    "--",
                    f":(icase){rel}",
                ],
                capture_output=True,
                timeout=30,
                env=git_env(),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            found.append(f"git could not check {root} ({exc})")
            continue
        if listed.returncode != 0:
            if _git_failure_leaves_state_unknown(repo, os.fsdecode(listed.stderr)):
                found.append(f"git could not check {root}")
            continue
        listed_paths = [os.fsdecode(p) for p in listed.stdout.split(b"\0") if p]
        tracked = [p for p in listed_paths if p.lower().endswith(IMPORTABLE)]
        # Python writes bytecode only into __pycache__, and LaunchBridge ships
        # none: a tracked .pyc elsewhere runs with no source to review.
        sourceless = [
            p
            for p in tracked
            if p.lower().endswith(".pyc")
            and "__pycache__" not in p.lower().split("/")
            and os.path.lexists(repo / p)
        ]
        if sourceless:
            refused.append(
                f"git tracks bytecode with no source in {root} "
                f"({', '.join(sourceless[:5])}); Python would run it in place of a "
                "module"
            )
            continue
        if tracked:
            more = f", and {len(tracked) - 5} more" if len(tracked) > 5 else ""
            names = f"({', '.join(tracked[:5])}{more})"
            if root.parent.name.lower() == "skills" and not _tracks_skill_md(
                repo, root, listed_paths
            ):
                refused.append(
                    f"git tracks {len(tracked)} file(s) Python can import in {root} "
                    f"{names} but not its SKILL.md, so a pulled commit added them to "
                    "this local install"
                )
            else:
                found.append(
                    f"git tracks {len(tracked)} file(s) Python can import in {root} "
                    f"{names}"
                )
    return [printable(r) for r in refused], [printable(f) for f in found]


def _runs_module_or_code(args: list[str]) -> bool:
    """Whether Python's arguments run `-m module` or `-c code` (which put the
    working directory on the path) rather than a script."""
    takes_value = {"-X", "-W", "--check-hash-based-pycs"}
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg in ("-m", "-c") or (
            arg.startswith("-") and not arg.startswith("--") and arg[-1] in "mc"
        ):
            return True
        if arg in takes_value:
            skip = True
            continue
        if not arg.startswith("-") or arg == "-":
            return False
    return False


def _run(
    repo: Path,
    program: list[str],
    safe_path: bool = False,
    aws_credentials: bool = True,
) -> int:
    env = python_env(repo, safe_path, aws_credentials)
    if os.name == "nt":
        return subprocess.run(program, env=env).returncode  # nosec B603 - checked venv program
    os.execve(program[0], program, env)  # nosec B606 - checked venv program
    return 1  # not reached


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__.split("Usage:")[1].split("Exit codes")[0], file=sys.stderr)
        return 2
    command, repo = argv[1], Path(argv[2]).resolve()
    try:
        if command == "seal-venv":
            seal_venv(repo)
            print(f"Sealed {repo / VENV} for this repository.")
            return 0
        if command == "seal-launcher":
            seal_launcher(repo)
            print(f"Sealed {repo / LAUNCHER_REL} for this repository.")
            return 0
        if command == "paths":
            seal = _load_seal(repo)
            print(
                json.dumps(
                    {
                        "base_python": seal.get("base_python", ""),
                        "guard": str(repo_state(repo) / GUARD_COPY),
                    }
                )
            )
            return 0
    except (OSError, ValueError, KeyError) as exc:
        print(f"lb_guard: {command} failed: {exc}", file=sys.stderr)
        return 1

    if command not in ("check", "exec", "exec-script"):
        print(f"lb_guard: unknown command {command}", file=sys.stderr)
        return 2
    rest = argv[3:]
    script = None
    if command == "exec-script":
        if not rest:
            return 2
        script, rest = rest[0], rest[1:]
    if command != "check":
        if not rest or rest[0] != "--":
            print(
                "lb_guard: expected -- before the program's arguments", file=sys.stderr
            )
            return 2
        rest = rest[1:]

    launcher_needed = command == "exec" and any(
        Path(a).name == LAUNCHER_REL.name for a in rest
    )
    found = problems(repo, need_launcher=launcher_needed)
    if found:
        print(
            "LaunchBridge refused to run from this repository's files:", file=sys.stderr
        )
        for reason in found:
            print(f"  - {reason}", file=sys.stderr)
        print(
            "Run lb-setup on this machine, which rebuilds and seals them.",
            file=sys.stderr,
        )
        return 1
    if command == "check":
        print(f"{repo}: LaunchBridge's local files are as lb-setup left them.")
        return 0

    python = venv_python(repo)
    cache = repo_state(repo) / "pycache"
    if script is not None:
        if "/" in script or "\\" in script or script.startswith("."):
            print(f"lb_guard: {script} is not a venv script name", file=sys.stderr)
            return 2
        if os.name == "nt" and not script.lower().endswith(".exe"):
            script += ".exe"
        if not (python.parent / script).is_file():
            print(
                f"lb_guard: {script} is not installed in {python.parent}; run "
                "lb-setup for the skill that provides it",
                file=sys.stderr,
            )
            return 1
        program = [str(python.parent / script), *rest]
        safe = False
    else:
        program = [str(python), "-X", f"pycache_prefix={cache}", *rest]
        safe = _runs_module_or_code(rest)
    refused, found = import_findings(
        repo, rest if script is None else [], python_env(repo, safe)
    )
    if refused:
        print(
            "lb_guard: not starting Python: it would import files that came with "
            "the repository:",
            file=sys.stderr,
        )
        for reason in refused:
            print(f"  - {reason}", file=sys.stderr)
        print(
            "Review those files as code. If you didn't add them, remove them "
            "(git rm --cached, then delete them), run verify_integrity.py and "
            "re-run the LaunchBridge installer.",
            file=sys.stderr,
        )
        return 1
    if found:
        print(
            "LaunchBridge warning: this Python may import files that came with the "
            "repository:",
            file=sys.stderr,
        )
        for reason in found:
            print(f"  - {reason}", file=sys.stderr)
        in_skills = any("/skills/" in reason.replace("\\", "/") for reason in found)
        advice = (
            "keep the repository's skills folders out of git (git rm --cached) and "
            "re-run the LaunchBridge installer, or install the skills globally "
            "(`launchbridge`, Global), where no pull can change them"
            if in_skills
            else "remove that folder from PYTHONPATH"
        )
        print(
            "Code there runs with your AWS credentials. Review every change to these "
            f"files as code, or {advice}.",
            file=sys.stderr,
        )
    name = (script or "").lower().removesuffix(".exe")
    return _run(
        repo, program, safe, aws_credentials=name not in CREDENTIAL_FREE_SCRIPTS
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv))
