#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Verify installed LaunchBridge skill files against the recorded digests.

The installer writes `.lb_workspace/config/version_manifest.json`, which records a
SHA-256 content hash per skill directory as it was at install time. Nothing
re-checks those digests afterwards, so a later edit to an installed `SKILL.md` —
the standing instructions the agent reloads every session — leaves no trace. This
script closes that gap: it recomputes each installed skill's content hash and
reports any that no longer match.

It detects drift after installation; it doesn't authenticate a change. A commit
that changes a skill together with `skill_digests.json` passes, which is why the
baseline is tracked: review any diff to it, and to the agents' skills folders,
as code. Better still, keep the skills folders out of the repository's history:
whoever controls them already controls the agent's instructions.

It is deliberately self-contained (Python standard library only, no `.venv_lb`)
and lives inside the `lb-setup` skill, which is installed into the target
repository or into the user's home folders. That means it still runs when the
LaunchBridge source tree or distribution bundle is long gone.

A digest baseline is kept at `.lb_workspace/config/skill_digests.json` and is
tracked in git, so rewriting it to cover a tampered skill shows up as a reviewable
diff. It is derived from the install manifest but deliberately omits
`sourcePath`: the manifest records the absolute path of the LaunchBridge source at
install time, which would put the installing engineer's home directory into the
client repository's history. `version_manifest.json` stays untracked and is only
used as a fallback baseline when no `skill_digests.json` exists yet.

A global install (`launchbridge`, Global) puts the skills in each agent's
user-level skills folder (`~/.claude/skills`, `~/.agents/skills`, …) and keeps
its record outside every repository, in the user's state directory
(`<state>/launchbridge/global/manifest.json`). `--global` checks those folders
against that record, which is the only baseline for them: the installer and
`launchbridge update` change it, and nothing writes a `skill_digests.json` for
it. Beside the record, `<state>/launchbridge/global/generated/` holds the files
the installer generates for its selection, which lb-setup prepares each
repository from; they are checked file by file against the record's
`generatedAssets` digests.

A symlink install makes each skill folder one link (a junction on Windows) to
its folder in the LaunchBridge source the installer recorded; the link is
checked, and then the folder it names is hashed. An older symlink install made
a real folder of per-file links, which is still checked link by link.

Usage:
    python3 verify_integrity.py <target_repo_abs_path> [--json]
    python3 verify_integrity.py <target_repo_abs_path> --write-baseline
    python3 verify_integrity.py <target_repo_abs_path> --global [--json]

Exit codes:
    0  every installed skill matches the baseline
    1  at least one skill is modified or missing
    2  the check could not run (no baseline, unreadable, bad arguments)

The hash algorithm mirrors `install_script/lib/contentHash.js` exactly: files are
enumerated recursively, symlinks are followed, `.DS_Store`, `__pycache__`, `.git`
and `*.pyc` are skipped, relative paths are forward-slash normalised and
sorted, and each file contributes
`<relative-path>\\0<bytes>` to a single SHA-256 stream.
`tests/unit/test_verify_integrity.py` asserts the two implementations agree for
that per-directory hash, and separately that this script reads the manifest's
keyspace the way the installer writes it.

The keyspace is the part that is easy to get wrong. `skillHashes` mixes two kinds
of key: a native skill's own name, and an external (ai-skills) GROUP key
(`ai-domain-<domain>`) whose hash covers every selected skill in that domain.
Treating a group key as a directory name reports the whole domain as missing.
Group keys are therefore skipped here and the external skills behind them are
verified from `externalSkillHashes`, which records one `<agent>/<skill>` digest
per installed folder: Claude Code receives each folder unchanged and every other
agent receives it with an adapted SKILL.md, so the digests differ by agent and
each is checked in that agent's skills directory. Older installs recorded one
`shared/<skill>` digest for every agent; those are checked in every agent's
skills directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

EXCLUDED_NAMES = {".DS_Store", "__pycache__", ".git"}

# The folder in the global state directory that holds the files a global
# install generates for its selection, checked against the global manifest's
# `generatedAssets` digests. Mirrors GLOBAL_GENERATED_DIR in
# install_script/lib/stateDir.js.
GENERATED_DIR = "generated"

# Mirrors install_script/lib/agentConfig.js — agent name to skills directory,
# relative to the project root (a local install, `skillsDir`) and to the
# user's home directory (a global install, `globalSkillsDir`).
# `tests/unit/test_verify_integrity.py` asserts both tables match the JS.
AGENT_SKILLS_DIRS = {
    "claude": ".claude/skills",
    "cline": ".cline/skills",
    "codex": ".codex/skills",
    "kiro": ".kiro/skills",
    "pi": ".agents/skills",
    "roo": ".roo/skills",
    "other": ".agents/skills",
}
AGENT_GLOBAL_SKILLS_DIRS = {
    "claude": ".claude/skills",
    "cline": ".cline/skills",
    "codex": ".agents/skills",
    "kiro": ".kiro/skills",
    "pi": ".agents/skills",
    "roo": ".roo/skills",
    "other": ".agents/skills",
}

MANIFEST_REL_PATH = ".lb_workspace/config/version_manifest.json"
INSTALL_SOURCE_RECORD = "install_source.json"
GLOBAL_MANIFEST = "manifest.json"
# What lb-setup last prepared a repository with from a global install, in the
# repository's state folder (bootstrap_workspace.py init writes it).
GLOBAL_SETUP_RECORD = "global_setup.json"
BASELINE_REL_PATH = ".lb_workspace/config/skill_digests.json"
AGENTS_REFERENCE_REL_PATH = ".lb_workspace/config/lb_agents_reference.md"

# Copied from the install manifest into the tracked baseline. sourcePath,
# gitCommitHash and deliveryMethod are deliberately excluded — they describe the
# machine that ran the installer, not what was installed.
BASELINE_FIELDS = (
    "version",
    "timestamp",
    "installMethod",
    "agents",
    "skillHashes",
    "externalSkillHashes",
    "externalManifestKeys",
    "agentsHash",
)

# External (ai-skills submodule) keys in `skillHashes` are GROUP hashes: one
# digest covering every selected skill in a domain. No installed directory
# reproduces one, so they cannot be verified as folders — the installer records
# per-folder digests in `externalSkillHashes` for that, and the group keys are
# skipped here.
#
# Mirrors AI_GROUP_PREFIX in install_script/lib/aiSkills.js. Only used when the
# manifest carries no `externalManifestKeys` list: the external keys are then the
# `skillHashes` keys starting with this prefix.
# `tests/unit/test_verify_integrity.py` asserts this matches the JS.
EXTERNAL_GROUP_PREFIX = "ai-domain-"

# A skill directory name as the installer writes it.
SKILL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def remove_bytecode(directory: Path) -> int:
    """Delete Python bytecode under an installed skill directory; return how many.

    Bytecode is excluded from the digests, but Python runs a `.pyc` in place of
    (or without) the script beside it, and a cached file that arrived with the
    repository can't be told from one Python wrote. Links are removed, never
    followed: a link _stray_link accepts points into the LaunchBridge source,
    whose files (bytecode included) are the user's own and may be read-only.
    """
    removed = 0
    for entry in list(directory.iterdir()):
        name = entry.name.lower()  # macOS and Windows load __PyCache__/X.PYC too
        linked = entry.is_symlink() or _is_junction(entry)
        if name == "__pycache__" or name.endswith(".pyc"):
            if entry.is_dir() and not linked:
                shutil.rmtree(entry)
            else:
                entry.unlink()
            removed += 1
        elif entry.is_dir() and not linked:
            removed += remove_bytecode(entry)
    return removed


def sourceless_bytecode(directory: Path, prefix: str = "") -> list[str]:
    """`.pyc` files outside `__pycache__` under `directory`, relative to it.

    Python writes bytecode only into `__pycache__`; a `.pyc` beside a script is
    loaded with no source at all, and LaunchBridge ships none, so one that is
    there came from somewhere else. Links are not followed.
    """
    found: list[str] = []
    for entry in sorted(directory.iterdir()):
        name = entry.name.lower()
        linked = entry.is_symlink() or _is_junction(entry)
        if name == "__pycache__":
            continue
        if name.endswith(".pyc"):
            found.append(prefix + entry.name)
        elif entry.is_dir() and not linked:
            found += sourceless_bytecode(entry, f"{prefix}{entry.name}/")
    return found


def _stray_link(
    installed: Path,
    repo: Path,
    method: str | None,
    source_root: str | None = None,
    root_label: str = "the repository",
) -> str | None:
    """A link in an installed skill that LaunchBridge would not have made.

    The skills folder above a skill is never a link. A copy install holds no
    links. A symlink install makes the skill folder one link to the folder of
    the same name in the LaunchBridge source (_stray_folder_link). An older
    symlink install made a real folder that links `<skill>/<path>` to the same
    path in one source skill folder outside the repository, so each link must
    resolve to where its own text says (no `..` through another link), every
    link must name the same source folder, and that folder must be inside the
    LaunchBridge source the install manifest records, when it records one. A
    link swapped for one to another folder (holding the same files plus
    bytecode) fails one of these.
    """
    for part in installed.parents:
        if part == repo or not part.is_relative_to(repo):
            break
        if part.is_symlink() or _is_junction(part):
            return f"not checked: {part} is a link"
    if installed.is_symlink() or _is_junction(installed):
        return _stray_folder_link(installed, repo, method, source_root, root_label)
    source = None
    for directory, dirs, files in os.walk(installed, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if not (path.is_symlink() or _is_junction(path)):
                continue
            if method == "copy":
                return f"not checked: {path} is a link in a copy install"
            try:
                target = path.resolve(strict=True)
                text = _link_text(path)
            except (OSError, RuntimeError):
                return f"not checked: {path} is a link that doesn't resolve"
            if _inside(target, repo):
                return f"not checked: {path} links inside {root_label} ({target})"
            named = os.path.normpath(os.path.join(directory, text))
            posix = named.replace(os.sep, "/")
            suffix = "/" + installed.name + "/" + path.relative_to(installed).as_posix()
            stray = (
                f"not checked: {path} links to {named}, not the matching file in "
                "the LaunchBridge source"
            )
            if not posix.endswith(suffix) or not _same(named, target):
                return stray
            here = posix[: -len(suffix)]
            if source is not None and here != source:
                return stray
            if source_root and not _inside(Path(here).resolve(), Path(source_root)):
                return stray
            source = here
    return None


def _stray_folder_link(
    installed: Path,
    repo: Path,
    method: str | None,
    source_root: str | None,
    root_label: str,
) -> str | None:
    """Why a skill folder that is a link is not one a symlink install makes, or
    None: it must be a symlink install, resolve to where its own text says (no
    `..` through another link), name a folder of the skill's own name outside
    `repo`, inside the LaunchBridge source the installer recorded when it
    recorded one. The files in that folder are the source's own."""
    if method == "copy":
        return f"not checked: {installed} is a link in a copy install"
    try:
        target = installed.resolve(strict=True)
        text = _link_text(installed)
    except (OSError, RuntimeError):
        return f"not checked: {installed} is a link that doesn't resolve"
    if not target.is_dir():
        return f"not checked: {installed} links to {target}, which is not a folder"
    if _inside(target, repo):
        return f"not checked: {installed} links inside {root_label} ({target})"
    named = os.path.normpath(os.path.join(installed.parent, text))
    if (
        Path(named).name != installed.name
        or not _same(named, target)
        or (source_root and not _inside(target, Path(source_root)))
    ):
        return (
            f"not checked: {installed} links to {named}, not the "
            f"{installed.name} folder in the LaunchBridge source"
        )
    return None


def _link_text(path: Path) -> str:
    r"""A link's target as written, without Windows' `\\?\` prefix (Node writes
    absolute targets that way; resolve() drops it)."""
    text = os.readlink(path)
    if text.startswith("\\\\?\\UNC\\"):
        return "\\\\" + text[8:]
    if text.startswith("\\\\?\\"):
        return text[4:]
    return text


def _same(a: str | Path, b: str | Path) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _inside(path: Path, root: Path) -> bool:
    """Whether path is root or under it, by file identity: a path spelled
    another way (macOS' /System/Volumes/Data) names the same folders."""
    return any(_same(part, root) for part in [path, *path.parents])


def _work_tree(path: Path, clone: str | None) -> str | None:
    """The git work tree in the LaunchBridge clone that holds `path`: one of its
    submodules (a folder with its own `.git`), or the clone itself."""
    if not clone:
        return None
    try:
        top = Path(clone).resolve()
        current = path.resolve()
    except (OSError, RuntimeError):
        return clone
    if not current.is_relative_to(top):
        return clone
    while current != top:
        if os.path.lexists(current / ".git"):
            return str(current)
        current = current.parent
    return clone


def _is_junction(path: Path) -> bool:
    is_junction = getattr(os.path, "isjunction", None)  # Python 3.12+
    return bool(is_junction and is_junction(path))


def is_excluded(name: str) -> bool:
    return name in EXCLUDED_NAMES or name.endswith(".pyc")


def list_files_recursive(
    dir_path: Path,
    relative_to: Path | None = None,
    _ancestors: frozenset[Path] = frozenset(),
) -> list[str]:
    """Enumerate files under dir_path as forward-slash relative paths.

    Symlinks are followed. A symlinked directory contributes paths prefixed with
    the symlink's own location, so a link at `lib/metric-library` yields
    `lib/metric-library/<file>` rather than a path that escapes the skill root.
    A link to a directory already being walked (a cycle) is skipped, matching
    the Node implementation.
    """
    if relative_to is None:
        relative_to = dir_path
    try:
        ancestors = _ancestors | {dir_path.resolve()}
    except OSError:
        return []

    results: list[str] = []
    try:
        entries = list(os.scandir(dir_path))
    except OSError:
        return results

    for entry in entries:
        if is_excluded(entry.name):
            continue

        full_path = Path(entry.path)

        # Check is_symlink first: Node's Dirent reflects lstat, so a symlink to a
        # directory is reported as a symlink and not as a directory.
        if entry.is_symlink():
            try:
                real_path = full_path.resolve(strict=True)
                if real_path in ancestors:
                    continue
                if real_path.is_dir():
                    nested = list_files_recursive(real_path, real_path, ancestors)
                    symlink_rel = full_path.relative_to(relative_to).as_posix()
                    results.extend(f"{symlink_rel}/{n}" for n in nested)
                elif real_path.is_file():
                    results.append(full_path.relative_to(relative_to).as_posix())
            except (OSError, ValueError):
                # Broken symlink — skip, matching the Node implementation.
                continue
        elif entry.is_dir(follow_symlinks=False):
            results.extend(list_files_recursive(full_path, relative_to, ancestors))
        elif entry.is_file(follow_symlinks=False):
            results.append(full_path.relative_to(relative_to).as_posix())

    return results


def compute_content_hash(dir_path: Path) -> str:
    """SHA-256 over every file in dir_path, keyed by sorted relative path."""
    hasher = hashlib.sha256()
    for rel_path in sorted(list_files_recursive(dir_path)):
        with open(dir_path / rel_path, "rb") as handle:
            content = handle.read()
        hasher.update(rel_path.encode("utf-8") + b"\0")
        hasher.update(content)
    return hasher.hexdigest()


def compute_file_hash(file_path: Path) -> str:
    with open(file_path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def state_base() -> Path:
    """The folder LaunchBridge's state directory is in: an absolute
    XDG_CONFIG_HOME, otherwise ~/.config (a relative one is ignored, as the XDG
    spec requires)."""
    base = os.environ.get("XDG_CONFIG_HOME", "")
    if not os.path.isabs(base):
        base = str(Path.home() / ".config")
    return Path(base)


def global_state_dir() -> Path:
    """The global install's record, beside the per-repository ones (mirrors
    globalStateDir in install_script/lib/stateDir.js)."""
    return state_base() / "launchbridge" / "global"


def global_generated_dir() -> Path:
    """The files a global install generates for lb-setup, one copy for every
    agent (mirrors globalGeneratedDir in install_script/lib/stateDir.js)."""
    return global_state_dir() / GENERATED_DIR


def repo_state_dir(target_repo: Path) -> Path:
    """The repository's folder in the user's state directory, outside every
    repository (mirrors repoStateDir in install_script/lib/stateDir.js)."""
    key = hashlib.sha256(str(target_repo.resolve()).encode("utf-8")).hexdigest()[:16]
    return state_base() / "launchbridge" / "repos" / key


def _read_source_record(record: Path) -> str | None:
    try:
        value = json.loads(record.read_text(encoding="utf-8")).get("sourcePath")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def install_source(target_repo: Path) -> str | None:
    """The LaunchBridge source the installer recorded for this repository, in
    the user's state directory. The install manifest's own sourcePath is in the
    repository, where a pulled file can replace it, so it isn't used."""
    return _read_source_record(repo_state_dir(target_repo) / INSTALL_SOURCE_RECORD)


def global_setup_record(target_repo: Path) -> dict | None:
    """What lb-setup last prepared the repository with from the global install,
    or None when it has not (or the record is unreadable, or resolves inside
    the repository, where it could have arrived with it)."""
    path = repo_state_dir(target_repo) / GLOBAL_SETUP_RECORD
    try:
        if path.resolve().is_relative_to(target_repo.resolve()):
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RuntimeError):
        return None
    return data if isinstance(data, dict) else None


def global_install_source() -> str | None:
    """The LaunchBridge source the global install came from."""
    return _read_source_record(global_state_dir() / INSTALL_SOURCE_RECORD)


def load_global_manifest(target_repo: Path) -> tuple[dict, str]:
    """The global install record and where it is.

    It is the only baseline for a global install: the installer and
    `launchbridge update` write it, outside every repository. A record that
    resolves inside the repository (an XDG_CONFIG_HOME pointing there) could
    have arrived with it, so it is refused.
    """
    directory = global_state_dir()
    if directory.resolve().is_relative_to(target_repo.resolve()):
        raise ValueError(
            f"the LaunchBridge state directory {directory} is inside the "
            "repository; set XDG_CONFIG_HOME to a folder outside it"
        )
    path = directory / GLOBAL_MANIFEST
    if not path.is_file():
        raise FileNotFoundError(
            f"No global install record at {path}. Install the skills globally "
            "with `launchbridge` (choose Global), or check the repository's own "
            "install without --global."
        )
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or data.get("scope") != "global":
        raise ValueError(f"{path} is not a global install record.")
    if not (data.get("skillHashes") or {}):
        raise ValueError(
            f"{path} records no skill hashes, so there is nothing to verify "
            "against. Run `launchbridge` again to rewrite it."
        )
    return data, str(path)


def check_generated_assets(
    expected: object, directory: Path | None = None
) -> str | None:
    """Why the generated folder (default global_generated_dir()) is not
    exactly what the global install wrote, or None when it is: a real folder
    holding the same set of regular files, no links, each with the recorded
    SHA-256. A .DS_Store file, which Finder writes into a folder it shows, is
    not counted (a link of that name is)."""
    if not isinstance(expected, dict) or not expected:
        return (
            "the global install record lists no generated files; run "
            "`launchbridge` again to write them"
        )
    directory = directory or global_generated_dir()
    if directory.is_symlink() or _is_junction(directory):
        return f"{directory} is a link"
    if not directory.is_dir():
        return f"{directory} is missing"
    found: dict[str, str] = {}
    for current, dirs, files in os.walk(directory, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(current) / name
            if path.is_symlink() or _is_junction(path):
                return f"{path} is a link"
            if name in files and not path.is_file():
                return f"{path} is not a regular file"
        for name in files:
            if name == ".DS_Store":
                continue
            path = Path(current) / name
            found[path.relative_to(directory).as_posix()] = compute_file_hash(path)
    extra = sorted(set(found) - set(expected))
    missing = sorted(set(expected) - set(found))
    changed = sorted(k for k in expected if k in found and found[k] != expected[k])
    problems = []
    if extra:
        problems.append("not written by the installer: " + ", ".join(extra))
    if missing:
        problems.append("missing: " + ", ".join(missing))
    if changed:
        problems.append("changed: " + ", ".join(changed))
    return "; ".join(problems) or None


def load_baseline(target_repo: Path) -> tuple[dict, str]:
    """Return the digest baseline and the relative path it came from.

    The tracked `skill_digests.json` wins over the untracked install manifest: it
    is the copy whose tampering a code review would catch.
    """
    for rel_path in (BASELINE_REL_PATH, MANIFEST_REL_PATH):
        path = target_repo / rel_path
        if not path.is_file():
            continue
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        if not (data.get("skillHashes") or {}):
            raise ValueError(
                f"{rel_path} records no skill hashes, so there is nothing to "
                "verify against. Reinstall LaunchBridge to regenerate it."
            )
        return data, rel_path

    raise FileNotFoundError(
        f"No digest baseline at {BASELINE_REL_PATH} or {MANIFEST_REL_PATH}. "
        "Nothing to verify against — reinstall LaunchBridge to create one."
    )


def write_baseline(target_repo: Path) -> Path:
    """Derive the tracked baseline from the install manifest, dropping local paths."""
    manifest_path = target_repo / MANIFEST_REL_PATH
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"No install manifest at {MANIFEST_REL_PATH}; cannot derive a baseline."
        )

    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)

    if not (manifest.get("skillHashes") or {}):
        raise ValueError(f"{MANIFEST_REL_PATH} records no skill hashes.")

    baseline = {key: manifest[key] for key in BASELINE_FIELDS if key in manifest}
    baseline["note"] = (
        "Digest baseline for installed LaunchBridge skills. Tracked in git so that "
        "an edit to a SKILL.md, or to this file, appears in a reviewable diff. "
        "Regenerate only when intentionally upgrading LaunchBridge."
    )

    baseline_path = target_repo / BASELINE_REL_PATH
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline_path.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    return baseline_path


def verify(target_repo: Path, scope: str = "local") -> dict:
    """Recompute installed digests and compare them to the baseline.

    `scope` "local" checks the skills installed in the repository against its
    baseline; "global" checks the skills in the user's home folders against the
    global install record (the repository is used only for its copy of the
    AGENTS.md reference, when lb-setup has made one).
    """
    global_scope = scope == "global"
    if global_scope:
        manifest, baseline_source = load_global_manifest(target_repo)
        source_root = global_install_source()
        root = Path.home()
        dirs_table = AGENT_GLOBAL_SKILLS_DIRS
        agents = [a for a in manifest.get("agents") or [] if isinstance(a, str)]
        recorded = manifest.get("installedTargets")
        installed_targets = (
            {str(t) for t in recorded} if isinstance(recorded, list) else None
        )
    else:
        manifest, baseline_source = load_baseline(target_repo)
        source_root = install_source(target_repo)
        root = target_repo
        dirs_table = AGENT_SKILLS_DIRS
        installed_targets = None
        # Older manifests predate the `agents` field. Fall back to probing every
        # known skills directory so the check still runs rather than silently
        # verifying nothing.
        agents = manifest.get("agents") or [
            name
            for name, rel in AGENT_SKILLS_DIRS.items()
            if (target_repo / rel).is_dir()
        ]
    skill_hashes = manifest["skillHashes"]

    # External skills are keyed by group in skill_hashes and must be verified from
    # externalSkillHashes instead. Prefer the recorded key list; without one, the
    # external keys are the `ai-domain-*` group keys.
    recorded_external_keys = manifest.get("externalManifestKeys")
    if isinstance(recorded_external_keys, list):
        external_keys = {str(key) for key in recorded_external_keys}
    else:
        external_keys = {
            key for key in skill_hashes if str(key).startswith(EXTERNAL_GROUP_PREFIX)
        }
    external_hashes = manifest.get("externalSkillHashes") or {}
    # `<agent>/<skill>`: what that agent received. `shared/<skill>`: one digest
    # for every agent, as older installs recorded it.
    shared_hashes: dict[str, str] = {}
    agent_hashes: dict[str, dict[str, str]] = {}
    for key, value in external_hashes.items():
        prefix, separator, skill_name = str(key).partition("/")
        if not separator or not skill_name:
            continue
        if prefix == "shared":
            shared_hashes[skill_name] = value
        elif prefix in AGENT_SKILLS_DIRS:
            agent_hashes.setdefault(prefix, {})[skill_name] = value

    matched: list[str] = []
    modified: list[dict] = []
    missing: list[str] = []
    # External skills whose per-folder digest was never recorded. Reported
    # separately: nothing is known to be wrong with them, but nothing was checked
    # either, and a blind spot must not be presented as a clean result.
    unverifiable: list[dict] = []
    checked_dirs = 0
    bytecode = [0]

    def kind(value: str, installed: Path | None = None) -> dict:
        """In a global check, what a modified entry is, which decides its fix:
        `link`, a skill folder linked to its folder in the LaunchBridge source
        (with the git work tree it is in, the clone or a submodule of it);
        `folder`, any other skill folder; `generated`, the generated files."""
        if not global_scope:
            return {}
        if value == "link" and installed is not None:
            return {"kind": value, "work_tree": _work_tree(installed, source_root)}
        return {"kind": value}

    def check(
        skills_dir: Path, skills_dir_rel: str, skill_name: str, expected: str
    ) -> None:
        shown_dir = f"~/{skills_dir_rel}" if global_scope else skills_dir_rel
        location = f"{shown_dir}/{skill_name}"
        # Names come from the manifest; one that is not a plain directory name
        # could point the check outside the skills directory.
        if not SKILL_NAME.fullmatch(skill_name) or ".." in skill_name:
            modified.append(
                {
                    "location": location,
                    "expected": expected,
                    "actual": "not checked: invalid skill name in the manifest",
                    **kind("folder"),
                }
            )
            return
        installed = skills_dir / skill_name
        if not installed.is_dir():
            missing.append(location)
            return
        # A user-level skills folder can hold the user's own skills: a folder
        # the global install skipped because it was already there is theirs.
        if (
            installed_targets is not None
            and f"{skills_dir_rel}/{skill_name}" not in installed_targets
        ):
            unverifiable.append(
                {
                    "skills_dir": shown_dir,
                    "manifest_keys": [skill_name],
                    "label": "a folder LaunchBridge did not install",
                    "reason": (
                        "a folder of that name was already there when the skills "
                        "were installed, so it was left alone; the agent loads it "
                        "in place of LaunchBridge's skill"
                    ),
                }
            )
            return
        stray = _stray_link(
            installed,
            skills_dir if global_scope else target_repo,
            manifest.get("installMethod"),
            source_root,
            "the skills folder" if global_scope else "the repository",
        )
        if stray:
            modified.append(
                {
                    "location": location,
                    "expected": expected,
                    "actual": stray,
                    **kind("folder"),
                }
            )
            return
        # A linked skill folder is the LaunchBridge source itself: its bytecode
        # is the user's own and is left there (a .pyc with no source is still
        # reported).
        linked = installed.is_symlink() or _is_junction(installed)
        sourceless = sourceless_bytecode(installed)
        if not linked:
            bytecode[0] += remove_bytecode(installed)
        if sourceless:
            modified.append(
                {
                    "location": location,
                    "expected": expected,
                    "actual": (
                        "bytecode with no source (left where it is, in the "
                        "LaunchBridge clone; review where it came from): "
                        if linked
                        else "bytecode with no source (removed, review where it "
                        "came from): "
                    )
                    + ", ".join(sourceless),
                    **(kind("link", installed) if linked else kind("folder")),
                    **({"sourceless": sourceless} if global_scope and linked else {}),
                }
            )
            return
        actual = compute_content_hash(installed)
        if actual == expected:
            matched.append(location)
        else:
            modified.append(
                {
                    "location": location,
                    "expected": expected,
                    "actual": actual,
                    **(kind("link", installed) if linked else kind("folder")),
                }
            )

    for agent in agents:
        skills_dir_rel = dirs_table.get(agent)
        if skills_dir_rel is None:
            continue
        skills_dir = root / skills_dir_rel
        if not skills_dir.is_dir():
            continue
        checked_dirs += 1

        for skill_name, expected in sorted(skill_hashes.items()):
            if skill_name in external_keys:
                continue
            check(skills_dir, skills_dir_rel, skill_name, expected)

        own_hashes = {**shared_hashes, **agent_hashes.get(agent, {})}
        for skill_name, expected in sorted(own_hashes.items()):
            check(skills_dir, skills_dir_rel, skill_name, expected)

        # External domains recorded as installed with no per-folder digest behind
        # them. The group hash cannot stand in, so these went unchecked.
        if external_keys and not own_hashes:
            unverifiable.append(
                {
                    "skills_dir": (
                        f"~/{skills_dir_rel}" if global_scope else skills_dir_rel
                    ),
                    "manifest_keys": sorted(external_keys),
                    "reason": (
                        "the baseline records only a group hash for these external "
                        "skill domains, and a group hash covers several skills, so "
                        "no installed directory reproduces it. Re-run the installer "
                        "to record per-folder digests, then refresh the baseline "
                        "with --write-baseline."
                    ),
                }
            )

    # The files a global install generated for lb-setup, kept once beside its
    # record, are what lb-setup prepares each repository from.
    if global_scope:
        generated_dir = global_generated_dir()
        problem = check_generated_assets(manifest.get("generatedAssets"))
        if problem:
            modified.append(
                {
                    "location": str(generated_dir),
                    "expected": "the files the global install generated",
                    "actual": problem,
                    **kind("generated"),
                }
            )

    # The canonical AGENTS.md copy is written verbatim by the installer, so it is
    # safe to digest. The root AGENTS.md is deliberately NOT checked: the user may
    # legitimately merge their own content into it, which would false-positive.
    # In a global install lb-setup copies it into the repository when it
    # prepares it, so there is none before the first lb-setup run, and an update
    # of the global install leaves it as it was until lb-setup runs there again:
    # one that matches what lb-setup last prepared the repository with is stale.
    agents_reference = {"status": "not_recorded"}
    expected_agents_hash = manifest.get("agentsHash")
    reference_path = target_repo / AGENTS_REFERENCE_REL_PATH
    if expected_agents_hash:
        if not reference_path.is_file():
            agents_reference = {
                "status": "not_present" if global_scope else "missing",
                "path": AGENTS_REFERENCE_REL_PATH,
            }
        else:
            actual_agents_hash = compute_file_hash(reference_path)
            if actual_agents_hash == expected_agents_hash:
                status = "matched"
            elif global_scope and actual_agents_hash == (
                global_setup_record(target_repo) or {}
            ).get("agentsHash"):
                status = "stale"
            else:
                status = "modified"
            agents_reference = {
                "status": status,
                "path": AGENTS_REFERENCE_REL_PATH,
                "expected": expected_agents_hash,
                "actual": actual_agents_hash,
            }

    return {
        "scope": "global" if global_scope else "local",
        # Every skill a global install selected, by name (the record's `skills`).
        "installed_skills": (
            [s for s in manifest.get("skills") or [] if isinstance(s, str)]
            if global_scope
            else None
        ),
        "baseline_source": baseline_source,
        # The LaunchBridge clone a global install came from (install_source.json).
        "install_source": source_root if global_scope else None,
        "manifest_version": manifest.get("version"),
        "manifest_timestamp": manifest.get("timestamp"),
        "install_method": manifest.get("installMethod"),
        "agents_checked": agents,
        "skills_dirs_checked": checked_dirs,
        "matched": matched,
        "modified": modified,
        "missing": missing,
        "unverifiable": unverifiable,
        "bytecode_removed": bytecode[0],
        "agents_reference": agents_reference,
        # Unverifiable entries do not fail the check: nothing is known to differ.
        # They are printed prominently instead, because an unchecked skill is not
        # the same as a verified one and the text must not imply otherwise.
        "ok": not modified and not missing and checked_dirs > 0,
    }


REFERENCE_OK = ("matched", "not_recorded", "not_present", "stale")


def global_remedies(report: dict) -> list[str]:
    """What fixes each kind of difference a global check found."""
    found: dict[str, list[str]] = {}
    # Links by the git work tree their change is in (None: the clone, or not
    # known), and those whose only difference is bytecode with no source.
    linked: dict[str | None, list[str]] = {}
    bytecode: list[str] = []
    clone = report.get("install_source")
    for item in report["modified"]:
        kind = item.get("kind", "folder")
        if kind == "link" and item.get("sourceless"):
            bytecode.append(item["location"])
            continue
        found.setdefault(kind, []).append(item["location"])
        if kind == "link":
            tree = item.get("work_tree")
            linked.setdefault(None if tree == clone else tree, []).append(
                item["location"]
            )
    remedies = []
    if report["missing"]:
        remedies.append(
            "Missing skills: run `launchbridge update`, or `launchbridge` again "
            "and choose Global, to restore them (`launchbridge update` leaves out "
            "a skill the LaunchBridge clone has changes to that are not committed)."
        )
    if not report["skills_dirs_checked"]:
        remedies.append(
            "No skills folder: run `launchbridge` again and choose Global to "
            "install the skills again (`launchbridge update` doesn't make a skills "
            "folder that is gone)."
        )
    if "folder" in found:
        remedies.append(
            f"Modified skill folders ({', '.join(found['folder'])}): run "
            "`launchbridge` again and choose Global to reinstall them; "
            "`launchbridge update` does not replace a modified copy."
        )
    if None in linked:
        git = f'git -C "{clone}"' if clone else "git -C <your LaunchBridge clone>"
        remedies.append(
            f"Modified skill links ({', '.join(linked[None])}): each links into "
            f"the LaunchBridge clone{f' at {clone}' if clone else ''}, so the "
            f"change is in that clone. Check it with `{git} status`. Discard "
            f"changes you didn't make (`{git} checkout -- <paths>`, and remove "
            "untracked files you didn't add), or, when they are intended, run "
            "`launchbridge` and choose Global to accept them."
        )
    for tree, locations in sorted((t, v) for t, v in linked.items() if t):
        rel = Path(os.path.relpath(tree, Path(clone).resolve())).as_posix()
        remedies.append(
            f"Modified skill links ({', '.join(locations)}): each links into "
            f"{tree}, a submodule of the LaunchBridge clone, so the change is in "
            f'that submodule. Check it with `git -C "{tree}" status`. Discard '
            f'changes you didn\'t make (`git -C "{tree}" checkout -- <paths>`, '
            "and remove untracked files you didn't add; when the clone's status "
            f'shows the submodule at a different commit, `git -C "{clone}" '
            f"submodule update -- {rel}` puts it back), or, when they are "
            "intended, run `launchbridge` and choose Global to accept them."
        )
    if bytecode:
        remedies.append(
            f"Bytecode with no source in linked skill folders ({', '.join(bytecode)}): "
            "the .pyc files listed above are in the LaunchBridge clone, and Python "
            "would run them with no source to review. Check where they came from, "
            "then delete them from the clone."
        )
    if "generated" in found:
        remedies.append(
            "Generated files: run `launchbridge update`, or `launchbridge` again "
            "and choose Global, to write them again."
        )
    if report["agents_reference"]["status"] == "modified":
        remedies.append(
            f"{report['agents_reference']['path']}: lb-setup replaces it with the "
            "global install's copy the next time it runs in this repository."
        )
    return remedies


def print_report(report: dict) -> None:
    print("LaunchBridge skill integrity check")
    if report.get("scope") == "global":
        print("  install scope    : global (skills in your home folders)")
    print(f"  baseline         : {report['baseline_source']}")
    print(f"  manifest version : {report['manifest_version']}")
    print(f"  installed        : {report['manifest_timestamp']}")
    print(f"  install method   : {report['install_method']}")
    print(f"  agents checked   : {', '.join(report['agents_checked']) or 'none'}")
    print(f"  matched          : {len(report['matched'])}")
    print(f"  modified         : {len(report['modified'])}")
    print(f"  missing          : {len(report['missing'])}")
    if report.get("unverifiable"):
        print(f"  unverifiable     : {len(report['unverifiable'])}")
    if report.get("bytecode_removed"):
        print(f"  bytecode removed : {report['bytecode_removed']}")

    if report["skills_dirs_checked"] == 0:
        print(
            "\nNo installed skills directory was found for any recorded agent. "
            "Nothing was verified — treat this as a failed check, not a pass."
        )

    for item in report["modified"]:
        print(f"\nMODIFIED  {item['location']}")
        print(f"  expected {item['expected']}")
        print(f"  actual   {item['actual']}")

    for location in report["missing"]:
        print(f"\nMISSING   {location}")

    for item in report.get("unverifiable", []):
        keys = ", ".join(item["manifest_keys"])
        label = item.get("label", "external skills")
        print(f"\nNOT CHECKED  {item['skills_dir']} — {label}: {keys}")
        print(f"  {item['reason']}")

    reference = report["agents_reference"]
    if reference["status"] == "modified":
        print(f"\nMODIFIED  {reference['path']} (canonical AGENTS.md copy)")
        print(f"  expected {reference['expected']}")
        print(f"  actual   {reference['actual']}")
    elif reference["status"] == "missing":
        print(f"\nMISSING   {reference['path']} (canonical AGENTS.md copy)")
    elif reference["status"] == "not_present":
        print(
            f"\nNOTE  {reference['path']} is not in this repository yet; lb-setup "
            "copies it there when it prepares the repository."
        )
    elif reference["status"] == "stale":
        print(
            f"\nNOTE  {reference['path']} is stale: the global install was updated "
            "since lb-setup last ran in this repository, and lb-setup refreshes it "
            "the next time it runs here."
        )

    if report["ok"] and reference["status"] in REFERENCE_OK:
        if report.get("unverifiable"):
            print(
                "\nOK, WITH A GAP — every skill that could be checked matches the "
                "digest recorded at install, but the skills listed above were not "
                "checked at all. Do not read this as a clean result for them."
            )
        else:
            print(
                "\nOK — every installed skill matches the digest recorded at install."
            )
    elif report.get("scope") == "global":
        print(
            "\nFAILED — the instructions the agent loads no longer match what was "
            "installed globally. Review the differences before running any skill: "
            "either the skills were changed outside `launchbridge` and `launchbridge "
            "update`, or the files were edited after install."
        )
        for remedy in global_remedies(report):
            print(f"  {remedy}")
    else:
        print(
            "\nFAILED — the instructions the agent loads no longer match what was "
            "installed. Review the differences before running any skill: either an "
            "upgrade was installed without refreshing the manifest, or the files "
            "were edited after install."
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify installed LaunchBridge skills against the install manifest."
    )
    parser.add_argument("target_repo", help="Absolute path to the target repository")
    parser.add_argument(
        "--json", action="store_true", help="Emit the report as JSON instead of text"
    )
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help=(
            "Derive the tracked digest baseline from the install manifest and exit. "
            "Run this once after installing or upgrading, then commit the result."
        ),
    )
    parser.add_argument(
        "--global",
        dest="global_scope",
        action="store_true",
        help=(
            "Check the skills installed globally, in your home folders, against "
            "the global install record instead of the repository's own install."
        ),
    )
    args = parser.parse_args()

    target_repo = Path(args.target_repo)
    if not target_repo.is_dir():
        print(f"Error: not a directory: {target_repo}", file=sys.stderr)
        return 2

    if args.write_baseline and args.global_scope:
        print(
            "Error: --write-baseline does not apply to a global install. Its "
            "baseline is the global install record, which only `launchbridge` and "
            "`launchbridge update` change.",
            file=sys.stderr,
        )
        return 2

    if args.write_baseline:
        try:
            written = write_baseline(target_repo)
        except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError) as err:
            print(f"Error: {err}", file=sys.stderr)
            return 2
        print(f"Wrote digest baseline: {BASELINE_REL_PATH}")
        print(f"  {written}")
        print("Commit this file so later edits to it are visible in review.")
        return 0

    try:
        report = verify(target_repo, "global" if args.global_scope else "local")
    except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError) as err:
        print(f"Error: {err}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)

    reference_ok = report["agents_reference"]["status"] in REFERENCE_OK
    return 0 if (report["ok"] and reference_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
