# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The MCP servers lb-setup registers start only from paths created on this machine.

`skills/lb-setup/scripts/check_mcp_paths.py` refuses a `.venv_lb` or a staged
`mcp_v1_compat.py` that is a symlink, resolves outside the repository, is not a
venv / file, or, in a git repository, is tracked or not gitignored, and a
`.venv_lb` that lacks the ID lb-setup recorded for the repository
(`venv_identity.py`). The indexing runner makes the same ID check in bash.
"""

import importlib.util
import py_compile
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "lb-setup"
    / "scripts"
    / "check_mcp_paths.py"
)
spec = importlib.util.spec_from_file_location("check_mcp_paths", SCRIPT)
cmp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cmp)

git_required = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path: Path, monkeypatch) -> Path:
    """A repository whose .venv_lb lb-setup created and recorded on this machine."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "user-config"))
    root = tmp_path / "repo"
    (root / ".venv_lb" / "bin").mkdir(parents=True)
    home = Path(sys.executable).resolve().parent
    (root / ".venv_lb" / "pyvenv.cfg").write_text(f"home = {home}\n")
    (root / ".lb_workspace" / "config").mkdir(parents=True)
    (root / cmp.LAUNCHER_REL).write_text("# launcher\n")
    cmp.venv_identity.record(root)
    cmp.lb_guard.seal_venv(root)
    cmp.lb_guard.seal_launcher(root)
    return root


def test_local_paths_pass_outside_git(repo):
    assert cmp.check(repo) == []
    assert cmp.main(["x", str(repo)]) == 0


@git_required
def test_local_ignored_paths_pass_in_git(repo):
    git(repo, "init", "-q")
    (repo / ".gitignore").write_text(".venv_lb/\n.lb_workspace/*\n")
    assert cmp.check(repo) == []


@git_required
def test_a_tracked_venv_is_refused(repo):
    git(repo, "init", "-q")
    (repo / ".gitignore").write_text(".lb_workspace/*\n")
    git(repo, "add", "-f", ".venv_lb/pyvenv.cfg")
    problems = cmp.check(repo)
    assert any("tracked by git" in p for p in problems)
    assert cmp.main(["x", str(repo)]) == 1


@git_required
def test_an_unignored_launcher_is_refused(repo):
    git(repo, "init", "-q")
    (repo / ".gitignore").write_text(".venv_lb/\n")
    assert any("not gitignored" in p for p in cmp.check(repo))


def test_a_symlinked_venv_is_refused(repo, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    shutil.move(str(repo / ".venv_lb"), elsewhere)
    (repo / ".venv_lb").symlink_to(elsewhere)
    assert any("is a symlink" in p for p in cmp.check(repo))


def test_a_symlinked_config_directory_is_refused(repo, tmp_path):
    elsewhere = tmp_path / "config"
    shutil.move(str(repo / ".lb_workspace" / "config"), elsewhere)
    (repo / ".lb_workspace" / "config").symlink_to(elsewhere)
    assert any("is a symlink" in p for p in cmp.check(repo))


def test_a_directory_without_pyvenv_cfg_is_refused(repo):
    (repo / ".venv_lb" / "pyvenv.cfg").unlink()
    assert any("not a virtual environment" in p for p in cmp.check(repo))


def test_a_missing_launcher_is_refused(repo):
    (repo / cmp.LAUNCHER_REL).unlink()
    assert any("does not exist" in p for p in cmp.check(repo))


# ------------------------------------------------------------ the venv's ID

RUNNER = SCRIPT.parents[2] / "indexing-and-qa" / "scripts" / "inq_run_indexing.sh"


def test_a_venv_that_arrived_with_the_repository_is_refused(tmp_path, monkeypatch):
    """A ZIP's .venv_lb: owned by the user, no git, but no ID lb-setup recorded."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "user-config"))
    root = tmp_path / "unzipped"
    (root / ".venv_lb" / "bin").mkdir(parents=True)
    (root / ".venv_lb" / "pyvenv.cfg").write_text("home = /usr\n")
    (root / ".lb_workspace" / "config").mkdir(parents=True)
    (root / cmp.LAUNCHER_REL).write_text("# launcher\n")

    assert any("not created by lb-setup" in p for p in cmp.check(root))


def test_a_planted_id_file_without_a_record_is_refused(repo):
    cmp.venv_identity.record_path(repo).unlink()
    assert any("not created by lb-setup" in p for p in cmp.check(repo))


def test_a_venv_copied_from_another_repository_is_refused(repo, tmp_path):
    other = tmp_path / "other"
    shutil.copytree(repo, other, symlinks=True)
    assert cmp.check(repo) == []
    assert any("not created by lb-setup" in p for p in cmp.check(other))


def test_recreating_the_venv_gives_it_a_new_id(repo):
    first = (repo / ".venv_lb" / cmp.venv_identity.VENV_ID_FILE).read_text()
    cmp.venv_identity.record(repo)
    assert (repo / ".venv_lb" / cmp.venv_identity.VENV_ID_FILE).read_text() != first
    assert cmp.check(repo) == []


def test_the_record_is_outside_the_repository_and_private(repo):
    path = cmp.venv_identity.record_path(repo)
    assert not path.resolve().is_relative_to(repo.resolve())
    assert path.stat().st_mode & 0o077 == 0


def _run(repo):
    return subprocess.run(
        ["bash", str(RUNNER), str(repo)], capture_output=True, text=True, timeout=60
    )


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash missing")
def test_the_indexing_runner_checks_the_same_id(repo):
    """With the record, the runner gets past the ID check to the missing interpreter."""
    assert "Python interpreter not found" in _run(repo).stdout
    cmp.venv_identity.record_path(repo).unlink()
    assert "not created by lb-setup" in _run(repo).stdout


def test_a_record_inside_the_repository_is_refused(repo, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(repo / ".lb_workspace" / "xdg"))
    with pytest.raises(ValueError, match="inside the repository"):
        cmp.venv_identity.record(repo)
    assert any("inside the repository" in p for p in cmp.check(repo))


def test_python_deps_need_the_installers_record(repo):
    deps = repo / ".lb_workspace" / "config" / "python_deps"
    deps.mkdir(parents=True)
    (deps / "pyproject.toml").write_text("[project]\nname = 'x'\n")
    (deps / "constraints.txt").write_text("")
    assert "re-run the LaunchBridge installer" in cmp.venv_identity.deps_problem(repo)

    import hashlib
    import json

    record = cmp.venv_identity.record_path(repo, cmp.venv_identity.DEPS_RECORD_FILE)
    record.write_text(
        json.dumps(
            {
                n: hashlib.sha256((deps / n).read_bytes()).hexdigest()
                for n in ("pyproject.toml", "constraints.txt")
            }
        )
    )
    assert cmp.venv_identity.deps_problem(repo) is None
    (deps / "constraints.txt").write_text("--index-url https://example.invalid/\n")
    assert "constraints.txt" in cmp.venv_identity.deps_problem(repo)


def test_python_deps_with_an_extra_file_is_refused(repo):
    import hashlib
    import json

    deps = repo / ".lb_workspace" / "config" / "python_deps"
    deps.mkdir(parents=True)
    (deps / "pyproject.toml").write_text("[project]\nname = 'x'\n")
    (deps / "constraints.txt").write_text("")
    record = cmp.venv_identity.record_path(repo, cmp.venv_identity.DEPS_RECORD_FILE)
    record.write_text(
        json.dumps(
            {
                n: hashlib.sha256((deps / n).read_bytes()).hexdigest()
                for n in ("pyproject.toml", "constraints.txt")
            }
        )
    )
    (deps / "sitecustomize.py").write_text("import os\n")
    assert "sitecustomize.py" in cmp.venv_identity.deps_problem(repo)


def test_a_file_added_to_the_sealed_venv_is_refused(repo):
    """For example a .pth force-added upstream and written by a git pull."""
    (repo / ".venv_lb" / "zz.pth").write_text("import os\n")
    assert any("changed since lb-setup sealed it" in p for p in cmp.check(repo))


@git_required
def test_a_tracked_agent_config_is_warned_about(repo, capsys):
    git(repo, "init", "-q")
    (repo / ".gitignore").write_text(".venv_lb/\n.lb_workspace/*\n")
    assert cmp.tracked_agent_configs(repo) == []
    (repo / ".mcp.json").write_text("{}\n")
    git(repo, "add", ".mcp.json")
    assert cmp.tracked_agent_configs(repo) == [".mcp.json"]
    assert cmp.main(["x", str(repo)]) == 0
    assert "is tracked by git" in capsys.readouterr().out


# Standard library names the two scripts, lb_guard and venv_identity import after
# start-up.
SHADOWED = ("secrets", "base64", "hmac", "hashlib", "json", "struct", "shutil", "stat")


@pytest.mark.parametrize(
    "run",
    [
        "import runpy, sys; sys.argv = ['check_mcp_paths.py', sys.argv[1]]; "
        "runpy.run_path(sys.argv[0], run_name='__main__')",
        "import importlib.util, sys; "
        "s = importlib.util.spec_from_file_location('cps', 'check_permission_scope.py'); "
        "m = importlib.util.module_from_spec(s); s.loader.exec_module(m); m.find_aws()",
    ],
    ids=["check_mcp_paths", "check_permission_scope"],
)
def test_files_beside_the_scripts_are_not_imported_under_isolated_mode(tmp_path, run):
    """Both scripts run as `python3 -I`, before lb-setup's integrity check, from a
    skills folder a pull can add files to: a file there named like a standard
    library module must not be imported, nor bytecode in its __pycache__."""
    scripts = tmp_path / "scripts"
    shutil.copytree(SCRIPT.parent, scripts)
    marker = tmp_path / "imported"
    for name in SHADOWED:
        (scripts / f"{name}.py").write_text(
            f"open({str(marker)!r}, 'a').write({name!r} + '\\n')\n"
            "raise ImportError('planted')\n"
        )
    # Bytecode the normal loader would run without comparing it to the source.
    planted = tmp_path / "planted.py"
    planted.write_text(f"open({str(marker)!r}, 'a').write('pyc\\n')\n")
    for name in ("lb_guard", "venv_identity"):
        py_compile.compile(
            str(planted),
            cfile=str(
                scripts / "__pycache__" / f"{name}.{sys.implementation.cache_tag}.pyc"
            ),
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
        )
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(
        [sys.executable, "-I", "-c", run, str(project)],
        cwd=scripts,
        capture_output=True,
        timeout=60,
    )
    assert not marker.exists(), marker.read_text()
