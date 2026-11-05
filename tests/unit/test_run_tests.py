# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""A virtualenv found inside the project is only run if the operator made it.

`skills/testing-framework/scripts/run_tests.py` prefers the project's own venv. One
that arrived with the repository's content (tracked, or not gitignored), or that
someone else owns, is skipped. `inq_run_indexing.sh` applies the same rule to
`.venv_lb`.
"""

import importlib.util
import os
import shutil
import subprocess  # nosec B404 - fixed git argv lists, shell=False
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "testing-framework" / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("run_tests", SCRIPTS / "run_tests.py")
run_tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_tests)

INQ_RUN = ROOT / "skills" / "indexing-and-qa" / "scripts" / "inq_run_indexing.sh"
git_required = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")
GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


def git(repo: Path, *args: str) -> None:
    subprocess.run(  # nosec B603 B607 - fixed argv, shell=False
        ["git", "-C", str(repo), *args], check=True, capture_output=True, env=GIT_ENV
    )


def make_venv(path: Path) -> Path:
    (path / "bin").mkdir(parents=True)
    (path / "pyvenv.cfg").write_text("home = /usr/bin\n", encoding="utf-8")
    python = path / "bin" / "python"
    python.write_text("#!/bin/sh\n", encoding="utf-8")
    python.chmod(0o755)
    return python


@git_required
def test_an_ignored_venv_is_used(tmp_path):
    git(tmp_path, "init", "-q")
    (tmp_path / ".gitignore").write_text(".venv/\n", encoding="utf-8")
    python = make_venv(tmp_path / ".venv")
    assert run_tests.find_project_python(tmp_path) == str(python)


@git_required
def test_a_windows_venv_is_found(tmp_path, monkeypatch):
    git(tmp_path, "init", "-q")
    (tmp_path / ".gitignore").write_text(".venv_repo/\n", encoding="utf-8")
    venv = tmp_path / ".venv_repo"
    (venv / "Scripts").mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text("home = C:/Python312\n", encoding="utf-8")
    (venv / "Scripts" / "python.exe").write_text("", encoding="utf-8")
    monkeypatch.setattr(run_tests.os, "name", "nt")
    assert run_tests.find_project_python(tmp_path) == str(
        venv / "Scripts" / "python.exe"
    )


@git_required
def test_a_venv_that_is_not_gitignored_is_skipped(tmp_path, capsys):
    git(tmp_path, "init", "-q")
    make_venv(tmp_path / ".venv")
    assert run_tests.find_project_python(tmp_path) is None
    assert "not gitignored" in capsys.readouterr().err


@git_required
def test_a_tracked_venv_is_skipped(tmp_path):
    git(tmp_path, "init", "-q")
    make_venv(tmp_path / "venv")
    git(tmp_path, "add", "venv")
    (tmp_path / ".gitignore").write_text("venv/\n", encoding="utf-8")
    assert run_tests.venv_problem(tmp_path, tmp_path / "venv") == "tracked by git"


def test_a_directory_without_pyvenv_cfg_is_not_a_venv(tmp_path):
    (tmp_path / "env" / "bin").mkdir(parents=True)
    (tmp_path / "env" / "bin" / "python").write_text("", encoding="utf-8")
    assert "pyvenv.cfg" in run_tests.venv_problem(tmp_path, tmp_path / "env")


@git_required
def test_the_indexing_wrapper_refuses_an_unignored_venv_lb(tmp_path):
    git(tmp_path, "init", "-q")
    make_venv(tmp_path / ".venv_lb")
    result = subprocess.run(  # nosec B603 B607 - fixed argv, shell=False
        ["bash", str(INQ_RUN), str(tmp_path)],
        capture_output=True,
        text=True,
        env=GIT_ENV,
    )
    assert result.returncode == 1
    assert "not gitignored" in result.stdout


@git_required
def test_a_committed_venv_in_another_case_is_refused(tmp_path):
    """On a case-insensitive file system `.VENV/` is the `.venv` folder."""
    git(tmp_path, "init", "-q")
    make_venv(tmp_path / ".VENV")
    git(tmp_path, "add", "-f", ".VENV")
    (tmp_path / ".gitignore").write_text(".venv/\n", encoding="utf-8")
    if not (tmp_path / ".venv").exists():
        pytest.skip("case-sensitive file system")
    assert run_tests.venv_problem(tmp_path, tmp_path / ".venv") == "tracked by git"


def test_ci_make_test_asks_first(tmp_path, monkeypatch, capsys):
    (tmp_path / "Makefile").write_text("test:\n\techo hi\n", encoding="utf-8")
    ran = []
    monkeypatch.setattr(run_tests.subprocess, "run", lambda *a, **k: ran.append(a))
    monkeypatch.setattr(run_tests.sys, "argv", ["run_tests.py", str(tmp_path), "--ci"])
    with pytest.raises(SystemExit) as stop:
        run_tests.main()
    assert stop.value.code == 3 and ran == []
    assert "Ask the user" in capsys.readouterr().err
