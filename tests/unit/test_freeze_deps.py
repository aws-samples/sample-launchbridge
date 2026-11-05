# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Every install gets exactly the dependency set LaunchBridge froze.

`install_script/freeze_deps.py` rewrites each git dependency in
project_dependencies/pyproject.toml to the commit the lock resolved, and writes the
`name==version` constraints lb-setup installs with. These tests cover that rewriting
without running uv, and check that the committed pins, lock and constraints agree.
"""

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "install_script" / "freeze_deps.py"
spec = importlib.util.spec_from_file_location("freeze_deps", SCRIPT)
freeze = importlib.util.module_from_spec(spec)
spec.loader.exec_module(freeze)

IRIS = (
    "https://github.com/aws-samples/sample-indexed-repository-intelligence-system.git"
)
ASH = "https://github.com/awslabs/automated-security-helper.git"
# Commit IDs only need the 40-hex shape here.
IRIS_SHA = "1" * 40
ASH_SHA = "2" * 40

PYPROJECT = f"""[project]
dependencies = ["pydantic>=2.0.0"]

[project.optional-dependencies]
indexing_and_qa = [
    "iris @ git+{IRIS}@main",
    "requests>=2.32.0",
]
ash_scan_and_fix = [
    "automated-security-helper @ git+{ASH}@v3"
]
"""

LOCK = f"""aiohttp==3.14.5
    # via iris
automated-security-helper @ git+{ASH}@{ASH_SHA}
    # via launchbridge
iris @ git+{IRIS}@{IRIS_SHA}
    # via launchbridge
pydantic==2.11.0
requests==2.32.4 ; python_full_version >= '3.12'
"""


def test_git_refs_are_rewritten_to_the_resolved_commits():
    pinned, pins = freeze.pin_vcs_refs(PYPROJECT, LOCK)

    assert f'"iris @ git+{IRIS}@{IRIS_SHA}"' in pinned
    assert f'"automated-security-helper @ git+{ASH}@{ASH_SHA}"' in pinned
    assert "@main" not in pinned and "@v3" not in pinned
    assert pins == [
        ("iris", "main", IRIS_SHA),
        ("automated-security-helper", "v3", ASH_SHA),
    ]


def test_extras_and_name_spelling_are_preserved():
    text = f'x = ["Sample_Package[extra] @ git+{IRIS}@develop"]'
    lock = f"sample-package[extra] @ git+{IRIS}@{IRIS_SHA}\n"
    pinned, _ = freeze.pin_vcs_refs(text, lock)
    assert pinned == f'x = ["Sample_Package[extra] @ git+{IRIS}@{IRIS_SHA}"]'


def test_a_git_dependency_missing_from_the_lock_fails():
    lock_without_ash = "\n".join(
        line for line in LOCK.splitlines() if "automated" not in line
    )
    with pytest.raises(ValueError, match="automated-security-helper"):
        freeze.pin_vcs_refs(PYPROJECT, lock_without_ash)


def test_a_pin_that_disagrees_with_the_lock_fails():
    text = f'"iris @ git+{IRIS}@{"0" * 40}"'
    with pytest.raises(ValueError, match="pinned to"):
        freeze.pin_vcs_refs(text, LOCK)


def test_constraints_keep_version_pins_and_drop_urls_and_comments():
    constraints = freeze.constraints_from_lock(LOCK)
    assert constraints.splitlines() == [
        "aiohttp==3.14.5",
        "pydantic==2.11.0",
        "requests==2.32.4 ; python_full_version >= '3.12'",
    ]


# ---------------------------------------------------- the committed frozen set

DEPS = SCRIPT.parents[1] / "project_dependencies"


def test_every_git_dependency_in_the_repo_is_pinned_to_a_commit():
    text = (DEPS / "pyproject.toml").read_text(encoding="utf-8")
    refs = [m["ref"] for m in freeze.PYPROJECT_VCS.finditer(text)]
    assert refs, "expected git dependencies in pyproject.toml"
    assert all(freeze.SHA.fullmatch(ref) for ref in refs), refs


def test_the_committed_lock_matches_the_pins():
    """Run install_script/freeze_deps.py project_dependencies if this fails."""
    pyproject = (DEPS / "pyproject.toml").read_text(encoding="utf-8")
    lock = (DEPS / "requirements.lock.txt").read_text(encoding="utf-8")
    pinned, _ = freeze.pin_vcs_refs(pyproject, lock)
    assert pinned == pyproject


def test_the_committed_constraints_come_from_the_lock():
    lock = (DEPS / "requirements.lock.txt").read_text(encoding="utf-8")
    constraints = (DEPS / "constraints.txt").read_text(encoding="utf-8")
    assert constraints == freeze.GENERATED_HEADER + freeze.constraints_from_lock(lock)
    assert " @ " not in constraints
