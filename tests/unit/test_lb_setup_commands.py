# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The commands lb-setup's SKILL.md tells the agent to run exist.

An instruction naming a subcommand or flag a script does not have makes the
agent improvise; these tests read the commands out of SKILL.md and check each
against the script itself.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL = REPO_ROOT / "skills" / "lb-setup"
SKILL_MD = (SKILL / "SKILL.md").read_text(encoding="utf-8")


def run(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(  # nosec B603 - fixed argv, shell=False
        [sys.executable, "-I", str(SKILL / "scripts" / script), *args],
        capture_output=True,
        text=True,
    )


def test_every_bootstrap_workspace_subcommand_exists():
    named = set(re.findall(r'bootstrap_workspace\.py"\s+(\w[\w-]*)', SKILL_MD))
    usage = run("bootstrap_workspace.py").stderr
    offered = set(
        re.search(r"bootstrap_workspace\.py (\S+)", usage).group(1).split("|")
    )
    assert named, "SKILL.md names no bootstrap_workspace.py command"
    assert {"mode", "init"} <= named
    assert named <= offered, named - offered


def test_every_verify_integrity_flag_exists():
    commands = re.findall(r'verify_integrity\.py"([^`\n]*)', SKILL_MD)
    named = {flag for command in commands for flag in re.findall(r"--[\w-]+", command)}
    named |= set(re.findall(r"`(--[\w-]+)`", SKILL_MD)) & {
        "--global",
        "--write-baseline",
        "--json",
    }
    help_text = run("verify_integrity.py", "--help").stdout
    assert "--global" in named
    for flag in named:
        assert flag in help_text, flag


def test_step_g_comes_before_step_0():
    assert SKILL_MD.index("### Step G:") < SKILL_MD.index("### Step 0:")


def test_step_g_checks_for_its_script_before_running_it():
    """A 1.2 symlink install updated by `launchbridge update` has this SKILL.md
    but no link for bootstrap_workspace.py; the run must stop with the fix."""
    step_g = SKILL_MD[SKILL_MD.index("### Step G:") : SKILL_MD.index("### Step 0:")]
    check = step_g.index('test -f "{skill_dir}/scripts/bootstrap_workspace.py"')
    first_run = step_g.index('python3 -I "{skill_dir}/scripts/bootstrap_workspace.py"')
    assert check < first_run
    assert "hard stop 8" in step_g
    assert "`launchbridge --scope local`" in step_g
    assert "8. This skill's own scripts are missing (Step G item 2)" in SKILL_MD
