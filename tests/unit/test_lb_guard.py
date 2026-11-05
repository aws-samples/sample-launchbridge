# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""lb_guard.py refuses to run from LaunchBridge files that changed after lb-setup.

lb-setup seals `.venv_lb` (a manifest of its files and links) and the staged
launcher, outside the repository. Before a LaunchBridge process starts, the guard
refuses a changed venv, a link or a force-tracked file where LaunchBridge reads or
writes, and a replaced launcher; then it starts the venv's Python with its bytecode
cache outside the repository.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "lb-setup" / "scripts"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = _load("lb_guard")
venv_identity = _load("venv_identity")
git_required = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")


@pytest.fixture
def repo(tmp_path):
    """A repository with a recorded, sealed venv (a real one, without pip)."""
    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(
        [sys.executable, "-m", "venv", "--without-pip", str(root / ".venv_lb")],
        check=True,
    )
    (root / ".lb_workspace" / "config").mkdir(parents=True)
    (root / ".lb_workspace" / "indexing_and_qa" / "repo").mkdir(parents=True)
    (root / guard.LAUNCHER_REL).write_text("# launcher\n")
    venv_identity.record(root)
    guard.seal_venv(root)
    guard.seal_launcher(root)
    return root


def site_packages(root):
    return next((root / ".venv_lb").rglob("site-packages"))


def test_a_sealed_repository_is_clean(repo):
    assert guard.problems(repo, need_launcher=True) == []


def test_a_planted_pth_is_refused(repo):
    (site_packages(repo) / "zz.pth").write_text("import os\n")
    assert any("changed since lb-setup sealed it" in p for p in guard.problems(repo))


def test_a_changed_package_file_is_refused(repo):
    target = site_packages(repo) / "planted_module.py"
    target.write_text("x = 1\n")
    guard.seal_venv(repo)
    os.utime(target, ns=(1, 1))
    assert any("changed since" in p for p in guard.problems(repo))


def test_bytecode_does_not_change_the_seal(repo):
    """Processes started by the guard never read it, and pip writes it."""
    cache = site_packages(repo) / "__pycache__"
    cache.mkdir()
    (cache / "x.cpython-312.pyc").write_bytes(b"x")
    assert guard.problems(repo) == []


def test_an_unsealed_venv_is_refused(repo):
    (guard.repo_state(repo) / guard.SEAL_FILE).unlink()
    assert any("never sealed" in p for p in guard.problems(repo))


def test_a_venv_lb_setup_did_not_create_is_refused(repo):
    (repo / ".venv_lb" / guard.VENV_ID_FILE).unlink()
    assert any("not created by lb-setup" in p for p in guard.problems(repo))


@pytest.mark.parametrize(
    "where",
    [
        ".lb_workspace/indexing_and_qa/repo/tree.txt",
        ".lb_workspace/indexing_and_qa/transmission_log.jsonl",
        ".lb_workspace/indexing_and_qa/repo/extracted_artifacts",
        ".lb_workspace/config/lb_env",
    ],
)
def test_a_link_where_launchbridge_writes_or_reads_is_refused(repo, tmp_path, where):
    link = repo / where
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(tmp_path)
    assert any("is a symbolic link" in p for p in guard.problems(repo))


def test_a_linked_index_folder_is_refused(repo, tmp_path):
    shutil.rmtree(repo / ".lb_workspace" / "indexing_and_qa")
    (repo / ".lb_workspace" / "indexing_and_qa").symlink_to(tmp_path)
    assert any("is a symbolic link" in p for p in guard.problems(repo))


def test_a_replaced_launcher_is_refused(repo):
    (repo / guard.LAUNCHER_REL).write_text("# not lb-setup's\n")
    assert any(
        "not the launcher" in p for p in guard.problems(repo, need_launcher=True)
    )
    assert guard.problems(repo) == [], "only the launcher's own start checks it"


def _git(repo, *args):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@git_required
def test_a_force_tracked_file_is_refused_and_reviewed_ones_are_not(repo):
    _git(repo, "init", "-q")
    (repo / ".lb_workspace" / "config" / "config-prompt-store.yaml").write_text(
        "x: 1\n"
    )
    _git(repo, "add", "-f", ".lb_workspace/config/config-prompt-store.yaml")
    assert guard.problems(repo) == []

    (site_packages(repo) / "zz.pth").write_text("import os\n")
    _git(repo, "add", "-f", str(site_packages(repo) / "zz.pth"))
    assert any("is tracked by git" in p for p in guard.problems(repo))


def test_the_seal_is_outside_the_repository_and_private(repo):
    seal = guard.repo_state(repo) / guard.SEAL_FILE
    assert not seal.resolve().is_relative_to(repo.resolve())
    assert seal.stat().st_mode & 0o077 == 0
    copy = guard.repo_state(repo) / guard.GUARD_COPY
    assert copy.read_text() == (SCRIPTS / "lb_guard.py").read_text()


def test_a_state_directory_inside_the_repository_is_refused(repo, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(repo / ".lb_workspace" / "xdg"))
    with pytest.raises(ValueError, match="inside the repository"):
        guard.seal_venv(repo)


def test_the_guard_agrees_with_venv_identity_on_the_state_path(repo):
    assert guard.repo_state(repo) / guard.VENV_RECORD == venv_identity.record_path(repo)


@pytest.mark.skipif(os.name == "nt", reason="exec replaces the process on POSIX")
def test_exec_runs_the_venv_python_with_its_cache_outside_the_repository(repo):
    base = (guard.repo_state(repo) / "base_python").read_text()
    copy = guard.repo_state(repo) / guard.GUARD_COPY
    code = "import sys; print(sys.prefix); print(sys.pycache_prefix)"
    result = subprocess.run(
        [base, "-I", "-S", str(copy), "exec", str(repo), "--", "-I", "-c", code],
        capture_output=True,
        text=True,
        env=dict(os.environ),
    )
    prefix, cache = result.stdout.split()
    assert Path(prefix).resolve() == (repo / ".venv_lb").resolve()
    assert Path(cache).resolve().is_relative_to(guard.repo_state(repo).resolve())


def test_exec_refuses_and_runs_nothing_when_a_check_fails(repo, tmp_path):
    (site_packages(repo) / "zz.pth").write_text("import os\n")
    marker = tmp_path / "ran"
    code = f"open({str(marker)!r}, 'w')"
    base = (guard.repo_state(repo) / "base_python").read_text()
    copy = guard.repo_state(repo) / guard.GUARD_COPY
    result = subprocess.run(
        [base, "-I", "-S", str(copy), "exec", str(repo), "--", "-I", "-c", code],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "refused" in result.stderr
    assert not marker.exists()


def test_bytecode_with_no_source_is_refused(repo):
    """Python imports a sourceless .pyc whatever the cache location."""
    (site_packages(repo) / "sitecustomize.pyc").write_bytes(b"x")
    assert any("bytecode with no source" in p for p in guard.problems(repo))


def test_a_new_package_of_bytecode_only_is_refused(repo):
    package = site_packages(repo) / "planted"
    package.mkdir()
    (package / "__init__.pyc").write_bytes(b"x")
    assert any("bytecode with no source" in p for p in guard.problems(repo))


@pytest.mark.skipif(os.name == "nt", reason="POSIX interpreter names")
def test_the_base_interpreter_path_is_kept_as_the_venv_names_it(tmp_path):
    """A package manager's stable folder survives a patch upgrade; the versioned
    folder it points at does not."""
    stable = tmp_path / "opt" / "bin"
    versioned = tmp_path / "Cellar" / "3.13.6" / "bin"
    versioned.mkdir(parents=True)
    stable.parent.mkdir(parents=True)
    (versioned / "python3.13").write_text("")
    (versioned / "python3").write_text("")
    stable.symlink_to(versioned, target_is_directory=True)
    venv = tmp_path / "repo" / ".venv_lb"
    venv.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text(
        f"home = {stable}\nversion_info = 3.13.6\n"
        f"executable = {versioned / 'python3.13'}\n"
    )
    assert guard.base_python(tmp_path / "repo") == str(stable / "python3.13")


def test_a_missing_base_interpreter_is_reported(repo):
    seal = guard._load_seal(repo)
    seal["base_python"] = str(repo.parent / "gone" / "python3")
    guard._save_seal(repo, seal)
    assert any("is gone" in p for p in guard.problems(repo))


@git_required
def test_a_file_tracked_under_another_case_is_refused(repo, tmp_path):
    probe = tmp_path / "CaseProbe"
    probe.write_text("")
    if not (tmp_path / "caseprobe").exists():
        pytest.skip("case-sensitive file system")
    _git(repo, "init", "-q")
    (site_packages(repo) / "zz.pth").write_text("import os\n")
    upper = Path(".VENV_LB") / site_packages(repo).relative_to(repo / ".venv_lb")
    _git(repo, "add", "-f", str(upper / "zz.pth"))
    assert any("is tracked by git" in p for p in guard.problems(repo))


@git_required
def test_tracked_files_no_longer_on_disk_and_legacy_records_pass(repo):
    _git(repo, "init", "-q")
    config = repo / ".lb_workspace" / "config"
    (config / "data_handling_confirmation.json").write_text("{}")
    (config / "old.txt").write_text("x")
    _git(repo, "add", "-f", str(config / "data_handling_confirmation.json"))
    _git(repo, "add", "-f", str(config / "old.txt"))
    (config / "old.txt").unlink()
    assert guard.problems(repo) == []


@git_required
@pytest.mark.skipif(os.name == "nt", reason="shell script hook")
def test_the_repositorys_fsmonitor_never_runs(repo, tmp_path):
    _git(repo, "init", "-q")
    marker = tmp_path / "ran"
    hook = tmp_path / "monitor.sh"
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
    hook.chmod(0o755)
    _git(repo, "config", "core.fsmonitor", str(hook))
    guard.problems(repo)
    assert not marker.exists()


# A stand-in credential value, assembled at runtime so no credential-shaped
# literal is in this file.
FAKE_CREDENTIAL = "-".join(["fake", "value"])


def test_a_credential_free_start_gets_no_aws_credentials(repo, monkeypatch):
    for name, value in {
        "AWS_ACCESS_KEY_ID": FAKE_CREDENTIAL,
        "AWS_SECRET_ACCESS_KEY": FAKE_CREDENTIAL,
        "AWS_SESSION_TOKEN": FAKE_CREDENTIAL,
        "AWS_PROFILE": "dev",
        "AWS_SHARED_CREDENTIALS_FILE": "/x",
        "AWS_DOCUMENTATION_PARTITION": "aws",
    }.items():
        monkeypatch.setenv(name, value)
    kept = guard.python_env(repo, aws_credentials=False)
    assert [k for k in kept if k.startswith("AWS_")] == ["AWS_DOCUMENTATION_PARTITION"]
    assert guard.python_env(repo)["AWS_SECRET_ACCESS_KEY"] == FAKE_CREDENTIAL


@pytest.mark.skipif(os.name == "nt", reason="exec replaces the process on POSIX")
def test_the_aws_documentation_server_starts_without_aws_credentials(repo):
    """It fetches public documentation and makes no AWS API call."""
    bin_dir = next(p for p in (repo / ".venv_lb").iterdir() if p.name in ("bin",))
    script = bin_dir / "awslabs.aws-documentation-mcp-server"
    script.write_text("#!/bin/sh\nenv | grep '^AWS_' | sort\n", encoding="utf-8")
    script.chmod(0o755)
    guard.seal_venv(repo)
    base = (guard.repo_state(repo) / "base_python").read_text()
    copy = guard.repo_state(repo) / guard.GUARD_COPY
    env = dict(
        os.environ,
        AWS_SECRET_ACCESS_KEY=FAKE_CREDENTIAL,
        AWS_PROFILE="dev",
        AWS_DOCUMENTATION_PARTITION="aws",
    )
    result = subprocess.run(
        [base, "-I", "-S", str(copy), "exec-script", str(repo), script.name, "--"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["AWS_DOCUMENTATION_PARTITION=aws"]


def test_exec_script_names_a_missing_script(repo, capsys):
    assert guard.main(["lb_guard.py", "exec-script", str(repo), "nope", "--"]) == 1
    assert "is not installed" in capsys.readouterr().err


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="POSIX modes")
@pytest.mark.parametrize("where", ["venv", "index"])
def test_a_folder_that_cant_be_listed_is_refused(repo, where):
    """os.walk skips such a folder silently; Python still imports from it."""
    if where == "venv":
        hidden = site_packages(repo) / "brotli"
    else:
        hidden = repo / ".lb_workspace" / "indexing_and_qa" / "repo" / "hidden"
    hidden.mkdir()
    (hidden / "__init__.py").write_text("")
    guard.seal_venv(repo)
    hidden.chmod(0o311)
    try:
        assert any("can't be listed" in p for p in guard.problems(repo))
    finally:
        hidden.chmod(0o755)


def test_a_replaced_file_is_refused_even_with_its_size_and_mtime(repo):
    target = site_packages(repo) / "kept.py"
    target.write_text("x = 1\n")
    guard.seal_venv(repo)
    stats = target.stat()
    replacement = target.with_name("kept.new")
    replacement.write_text("y = 2\n")  # same size, a different file
    os.utime(replacement, ns=(stats.st_atime_ns, stats.st_mtime_ns))
    os.replace(replacement, target)
    assert any("changed since" in p for p in guard.problems(repo))


@git_required
def test_a_submodule_above_a_guarded_folder_is_refused(repo, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    _git(other, "init", "-q")
    (other / "x").write_text("x")
    _git(other, "add", "x")
    _git(other, "commit", "-qm", "x")
    commit = subprocess.run(
        ["git", "-C", str(other), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    _git(repo, "init", "-q")
    _git(repo, "update-index", "--add", "--cacheinfo", f"160000,{commit},.lb_workspace")
    assert any(".lb_workspace is tracked by git" in p for p in guard.problems(repo))


@git_required
def test_a_listing_git_refuses_is_a_refusal(repo):
    _git(repo, "init", "-q")
    (repo / ".git" / "index").write_bytes(b"not an index")
    assert any("git could not read this repository" in p for p in guard.problems(repo))


def test_a_link_anywhere_in_the_workspace_is_refused(repo, tmp_path):
    """Every skill writes its output under .lb_workspace/."""
    out = repo / ".lb_workspace" / "operational_metrics"
    out.mkdir()
    (out / "operational_metrics_dashboard.html").symlink_to(tmp_path / "victim")
    assert any("is a symbolic link" in p for p in guard.problems(repo))


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="POSIX modes")
def test_a_folder_that_can_be_listed_but_not_entered_is_refused(repo):
    folder = repo / ".lb_workspace" / "indexing_and_qa" / "repo" / "locked"
    folder.mkdir()
    (folder / "x").write_text("")
    folder.chmod(0o644)
    try:
        found = guard.problems(repo)
    finally:
        folder.chmod(0o755)
    assert any("can't be listed" in p for p in found)


def test_an_older_seal_is_reported_as_older(repo):
    seal = guard._load_seal(repo)
    del seal["format"]
    guard._save_seal(repo, seal)
    found = guard.problems(repo)
    assert any("sealed by an older LaunchBridge" in p for p in found)
    assert not any("changed since" in p for p in found)


@git_required
def test_git_refusing_the_repository_is_reported_with_its_message(repo, monkeypatch):
    _git(repo, "init", "-q")
    # git_env() drops GIT_* variables; let this test's one through.
    monkeypatch.setattr(
        guard, "git_env", lambda: dict(os.environ, GIT_TEST_ASSUME_DIFFERENT_OWNER="1")
    )
    found = [p for p in guard.problems(repo) if "git could not read" in p]
    assert found and "safe.directory" in found[0]


@git_required
def test_git_dir_is_absolute_inside_git_and_none_outside(repo, tmp_path):
    assert guard.git_dir(repo) is None
    _git(repo, "init", "-q")
    found = guard.git_dir(repo)
    assert found.is_absolute() and (found / "HEAD").is_file()


@git_required
def test_a_git_in_the_repository_or_working_directory_is_never_used(
    repo, tmp_path, monkeypatch
):
    """On Windows a bare name is looked up in the current directory first."""
    planted = repo / ("git.exe" if os.name == "nt" else "git")
    planted.write_text("")
    planted.chmod(0o755)
    monkeypatch.chdir(repo)
    monkeypatch.setenv("PATH", str(repo) + os.pathsep + os.environ["PATH"])
    found = guard.find_tool("git", repo)
    assert found and Path(found).resolve().parent != repo.resolve()
    monkeypatch.setenv("PATH", str(repo))
    assert guard.find_tool("git", repo) is None


@git_required
def test_no_usable_git_with_a_repository_present_is_a_refusal(repo, monkeypatch):
    _git(repo, "init", "-q")
    monkeypatch.setattr(guard, "find_tool", lambda name, r: None)
    assert any("no usable git" in p for p in guard.problems(repo))


@git_required
def test_no_usable_git_in_a_larger_repository_is_a_refusal(repo, monkeypatch):
    """A project inside a monorepo has no .git of its own; the one above counts."""
    _git(repo.parent, "init", "-q")
    assert not (repo / ".git").exists()
    monkeypatch.setattr(guard, "find_tool", lambda name, r: None)
    found = guard.problems(repo)
    assert any("no usable git" in p for p in found)
    assert not any(str(repo.parent) + os.sep + ".git" in p for p in found)
    scripts = repo / ".claude" / "skills" / "s" / "scripts"
    scripts.mkdir(parents=True)
    assert any(
        "no usable git" in p
        for p in guard.import_problems(repo, [str(scripts / "run.py")], {})
    )


@git_required
def test_a_stray_git_folder_above_a_project_git_rejects_is_not_a_refusal(repo):
    """An empty .git higher up isn't a repository, and git says so."""
    (repo.parent / ".git").mkdir()
    assert not any("git could not read" in p for p in guard.problems(repo))
    scripts = repo / ".claude" / "skills" / "s" / "scripts"
    scripts.mkdir(parents=True)
    assert guard.import_problems(repo, [str(scripts / "run.py")], {}) == []


STOPPED_AT_MOUNT = (
    "fatal: not a git repository (or any parent up to mount point /a)\n"
    "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set)."
)


def _devices(monkeypatch, mount):
    """Make every folder above `mount` look like it is on another device."""
    top = os.path.realpath(mount)

    def device(path):
        path = os.path.realpath(path)
        return 2 if top.startswith(path.rstrip(os.sep) + os.sep) else 1

    monkeypatch.setattr(guard, "_device", device)


def test_git_stopping_at_a_mount_point_has_not_answered(repo, monkeypatch):
    """A repository above a mounted volume can still write into the project."""
    mount = repo.parent
    (mount.parent / ".git").mkdir()
    _devices(monkeypatch, mount)
    assert guard._git_failure_leaves_state_unknown(repo, STOPPED_AT_MOUNT)
    answered = "fatal: not a git repository (or any of the parent directories): .git"
    assert not guard._git_failure_leaves_state_unknown(repo, answered)


def test_a_stray_git_below_the_mount_point_is_not_a_refusal(repo, monkeypatch):
    """Git looked at the .git between the project and the mount, and rejected it."""
    mount = repo.parent.parent
    (repo.parent / ".git").mkdir()
    _devices(monkeypatch, mount)
    assert not guard._git_failure_leaves_state_unknown(repo, STOPPED_AT_MOUNT)


@git_required
def test_git_refusing_a_larger_repository_is_a_refusal(repo, monkeypatch):
    """Ownership checks and damaged indexes still leave nothing known."""
    _git(repo.parent, "init", "-q")
    (repo.parent / ".git" / "index").write_bytes(b"not an index")
    (repo / "f").write_text("")
    assert any("git could not read" in p for p in guard.problems(repo))


def test_a_project_reached_through_a_link_finds_the_repository_it_is_in(tmp_path):
    mono = tmp_path / "mono"
    (mono / ".git").mkdir(parents=True)
    (mono / "proj").mkdir()
    (tmp_path / "elsewhere").mkdir()
    link = tmp_path / "elsewhere" / "proj"
    link.symlink_to(mono / "proj", target_is_directory=True)
    assert guard._in_git_repository(link)


def test_no_git_and_no_repository_anywhere_is_not_a_refusal(repo, monkeypatch):
    monkeypatch.setattr(guard, "_in_git_repository", lambda r: False)
    monkeypatch.setattr(guard, "find_tool", lambda name, r: None)
    assert not any("no usable git" in p for p in guard.problems(repo))


@git_required
def test_git_variables_cant_point_the_check_at_another_index(
    repo, tmp_path, monkeypatch
):
    _git(repo, "init", "-q")
    (site_packages(repo) / "zz.pth").write_text("import os\n")
    _git(repo, "add", "-f", str(site_packages(repo) / "zz.pth"))
    other = tmp_path / "other"
    other.mkdir()
    subprocess.run(["git", "init", "-q", str(other)], check=True)
    monkeypatch.setenv("GIT_DIR", str(other / ".git"))
    monkeypatch.setenv("GIT_INDEX_FILE", str(other / ".git" / "index"))
    assert any("is tracked by git" in p for p in guard.problems(repo))


def test_a_state_directory_inside_the_repository_trusts_nothing(repo, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(repo / ".lb_workspace" / "xdg"))
    found = guard.problems(repo)
    assert len(found) == 1 and "inside the repository" in found[0]


def test_the_started_python_gets_no_path_entry_that_exposes_the_repository(
    repo, tmp_path, monkeypatch
):
    """An empty entry, or one naming the working directory or the repository,
    would put a repository-root json.py on the path; other entries, however
    they're written, are kept as absolute paths."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "rel").mkdir()
    monkeypatch.setenv(
        "PYTHONPATH",
        os.pathsep.join(["", "rel", ".", str(repo), "/abs/lib"]),
    )
    for name in ("PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE"):
        monkeypatch.setenv(name, "x")
    env = guard.python_env(repo)
    assert env["PYTHONPATH"].split(os.pathsep) == [str(tmp_path / "rel"), "/abs/lib"]
    assert env["PYTHONNOUSERSITE"] == "1"
    assert not {"PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE"} & set(
        env
    )
    assert "PYTHONSAFEPATH" not in env, "a script's own folder must stay on its path"
    assert guard.python_env(repo, safe_path=True)["PYTHONSAFEPATH"] == "1"


@pytest.mark.parametrize(
    "args,expected",
    [
        (["-m", "metric_library.run_metrics"], True),
        (["-I", "-c", "pass"], True),
        (["-Im", "x"], True),
        (["-X", "dev", "-m", "x"], True),
        (["script.py", "-m"], False),
        (["-I", "/skills/x/scripts/run.py"], False),
    ],
)
def test_module_and_code_starts_are_told_from_script_starts(args, expected):
    assert guard._runs_module_or_code(args) is expected


@pytest.mark.skipif(os.name == "nt", reason="exec replaces the process on POSIX")
def test_a_repository_json_py_doesnt_load_with_an_empty_pythonpath_entry(
    repo, tmp_path
):
    (repo / "json.py").write_text("raise SystemExit('planted json ran')\n")
    base = (guard.repo_state(repo) / "base_python").read_text()
    copy = guard.repo_state(repo) / guard.GUARD_COPY
    env = dict(os.environ, PYTHONPATH=os.pathsep + "/nonexistent")
    result = subprocess.run(
        [
            base,
            "-I",
            "-S",
            str(copy),
            "exec",
            str(repo),
            "--",
            "-c",
            "import json; print('ok')",
        ],
        capture_output=True,
        text=True,
        cwd=repo,
        env=env,
    )
    assert result.stdout.strip() == "ok", result.stderr


def _skill(repo, name="demo"):
    scripts = repo / ".claude" / "skills" / name / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "run.py").write_text("import json\nprint('skill ok')\n")
    return scripts


@git_required
def test_a_tracked_file_in_the_scripts_skill_folder_is_reported(repo):
    """A pulled commit can add a file to an ignored, uncommitted skills folder."""
    _git(repo, "init", "-q")
    scripts = _skill(repo)
    assert guard.import_problems(repo, [str(scripts / "run.py")], {}) == []
    (scripts / "json.py").write_text("raise SystemExit('planted')\n")
    _git(repo, "add", "-f", str(scripts / "json.py"))
    found = guard.import_problems(repo, ["-I", str(scripts / "run.py")], {})
    assert found and "Python can import" in found[0] and "json.py" in found[0]


@git_required
def test_a_tracked_file_in_a_pythonpath_skill_folder_is_reported(repo):
    _git(repo, "init", "-q")
    lib = (
        repo / ".claude" / "skills" / "evaluate-predictions" / "lib" / "metric-library"
    )
    lib.mkdir(parents=True)
    (lib / "json.py").write_text("")
    _git(repo, "add", "-f", str(lib / "json.py"))
    found = guard.import_problems(
        repo, ["-m", "metric_library.run_metrics"], {"PYTHONPATH": str(lib)}
    )
    assert found and "evaluate-predictions" in found[0]


def test_scripts_and_paths_outside_the_repository_need_no_check(repo, tmp_path):
    outside = tmp_path / "lb" / "skills" / "x" / "scripts"
    outside.mkdir(parents=True)
    assert (
        guard.import_problems(
            repo, [str(outside / "run.py")], {"PYTHONPATH": str(tmp_path)}
        )
        == []
    )


@git_required
@pytest.mark.skipif(os.name == "nt", reason="exec replaces the process on POSIX")
def test_exec_warns_about_a_committed_skill_folder(repo):
    """Teams may commit whole skills folders, SKILL.md included: a warning."""
    _git(repo, "init", "-q")
    scripts = _skill(repo)
    (scripts.parent / "SKILL.md").write_text("# demo\n")
    (scripts / "json.py").write_text("print('TRACKED json ran')\n")
    _git(repo, "add", "-f", str(scripts.parent / "SKILL.md"), str(scripts / "json.py"))
    base = (guard.repo_state(repo) / "base_python").read_text()
    copy = guard.repo_state(repo) / guard.GUARD_COPY
    result = subprocess.run(
        [base, "-I", "-S", str(copy), "exec", str(repo), "--", str(scripts / "run.py")],
        capture_output=True,
        text=True,
    )
    assert "LaunchBridge warning" in result.stderr and "json.py" in result.stderr
    assert result.returncode == 0


@git_required
@pytest.mark.skipif(os.name == "nt", reason="exec replaces the process on POSIX")
def test_exec_refuses_tracked_modules_beside_an_untracked_skill(repo):
    """A pull added json.py to a local install whose SKILL.md git doesn't track."""
    _git(repo, "init", "-q")
    scripts = _skill(repo)
    (scripts.parent / "SKILL.md").write_text("# demo\n")
    marker = repo.parent / "planted-ran"
    (scripts / "json.py").write_text(f"open({str(marker)!r}, 'w').write('x')\n")
    _git(repo, "add", "-f", str(scripts / "json.py"))
    base = (guard.repo_state(repo) / "base_python").read_text()
    copy = guard.repo_state(repo) / guard.GUARD_COPY
    result = subprocess.run(
        [base, "-I", "-S", str(copy), "exec", str(repo), "--", str(scripts / "run.py")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "not starting Python" in result.stderr and "json.py" in result.stderr
    assert "but not its SKILL.md" in result.stderr
    assert not marker.exists()


@git_required
def test_a_committed_skill_folder_named_in_another_case_is_a_warning(repo):
    """Git spells the folder Foo; the agent runs .../foo/... on macOS or Windows."""
    _git(repo, "init", "-q")
    scripts = _skill(repo, "Foo")
    (scripts.parent / "SKILL.md").write_text("# foo\n")
    (scripts / "json.py").write_text("")
    _git(repo, "add", "-f", str(scripts.parent))
    typed = repo / ".claude" / "skills" / "foo" / "scripts" / "run.py"
    if not typed.exists():
        pytest.skip("case-sensitive file system: foo is another folder")
    refused, warned = guard.import_findings(repo, [str(typed)], {})
    assert refused == [] and "json.py" in warned[0]


@git_required
def test_a_skill_md_in_another_folder_spelled_alike_does_not_count(repo):
    """On a case-sensitive file system DEMO/ is not the installed demo/."""
    _git(repo, "init", "-q")
    scripts = _skill(repo, "demo")
    other = repo / ".claude" / "skills" / "DEMO"
    if other.exists():
        pytest.skip("case-insensitive file system: DEMO is the same folder")
    other.mkdir()
    (other / "SKILL.md").write_text("# planted\n")
    (scripts / "json.py").write_text("")
    _git(repo, "add", "-f", str(other / "SKILL.md"), str(scripts / "json.py"))
    refused, _warned = guard.import_findings(repo, [str(scripts / "run.py")], {})
    assert refused and "but not its SKILL.md" in refused[0]


@git_required
def test_tracked_bytecode_beside_a_script_is_refused_even_in_a_committed_folder(repo):
    """A team commits the folder with SKILL.md; a pull adds scripts/json.pyc."""
    _git(repo, "init", "-q")
    scripts = _skill(repo)
    (scripts.parent / "SKILL.md").write_text("# demo\n")
    (scripts / "json.pyc").write_bytes(b"x")
    (scripts / "__pycache__").mkdir()
    (scripts / "__pycache__" / "run.cpython-312.pyc").write_bytes(b"x")
    _git(repo, "add", "-f", str(scripts.parent))
    refused, warned = guard.import_findings(repo, [str(scripts / "run.py")], {})
    assert refused and "json.pyc" in refused[0] and "run.cpython" not in refused[0]
    assert warned == []


@git_required
def test_only_a_tracked_skill_md_in_its_own_case_counts(repo):
    """On a case-sensitive file system a pulled skill.md is another file."""
    _git(repo, "init", "-q")
    scripts = _skill(repo)
    (scripts.parent / "skill.md").write_text("# demo\n")
    (scripts / "json.py").write_text("")
    _git(repo, "add", "-f", str(scripts.parent / "skill.md"), str(scripts / "json.py"))
    refused, warned = guard.import_findings(repo, [str(scripts / "run.py")], {})
    assert "but not its SKILL.md" in refused[0] and warned == []


@git_required
def test_a_tracked_module_in_a_folder_that_isnt_a_skill_is_a_warning(repo):
    _git(repo, "init", "-q")
    lib = repo / "vendor" / "lib"
    lib.mkdir(parents=True)
    (lib / "json.py").write_text("")
    _git(repo, "add", "-f", str(lib / "json.py"))
    refused, warned = guard.import_findings(repo, ["-m", "x"], {"PYTHONPATH": str(lib)})
    assert refused == [] and "json.py" in warned[0]


@git_required
def test_only_importable_tracked_files_are_reported_with_a_count(repo):
    _git(repo, "init", "-q")
    scripts = _skill(repo)
    for name in ("SKILL.md", ".DS_Store", "notes.txt"):
        (scripts.parent / name).write_text("")
        _git(repo, "add", "-f", str(scripts.parent / name))
    assert guard.import_problems(repo, [str(scripts / "run.py")], {}) == []
    for i in range(7):
        (scripts / f"m{i}.py").write_text("")
        _git(repo, "add", "-f", str(scripts / f"m{i}.py"))
    found = guard.import_problems(repo, [str(scripts / "run.py")], {})
    assert "7 file(s)" in found[0] and "and 2 more" in found[0]


@git_required
def test_the_launchers_folder_isnt_reported_for_its_committed_config(repo):
    """lb-setup has teams commit config-prompt-store.yaml and skill_digests.json."""
    _git(repo, "init", "-q")
    config = repo / ".lb_workspace" / "config"
    (config / "config-prompt-store.yaml").write_text("x: 1\n")
    _git(repo, "add", "-f", str(config / "config-prompt-store.yaml"))
    assert guard.import_problems(repo, ["-I", str(repo / guard.LAUNCHER_REL)], {}) == []


def test_a_pythonpath_entry_holding_the_repository_is_dropped(
    repo, tmp_path, monkeypatch
):
    """A parent folder would import the repository as a package named after it."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(
        "PYTHONPATH",
        os.pathsep.join([str(repo.parent), "..", str(repo / "src"), "/abs/lib"]),
    )
    assert guard.python_env(repo)["PYTHONPATH"].split(os.pathsep) == [
        str(repo / "src"),
        "/abs/lib",
    ]


def test_findings_show_control_characters_as_escapes():
    assert (
        guard.printable("a\nb\x1b[31m\u202e.py café") == "a\\nb\\x1b[31m\\u202e.py café"
    )


@git_required
def test_a_tracked_file_name_with_a_newline_is_shown_escaped(repo):
    _git(repo, "init", "-q")
    name = repo / ".venv_lb" / "x\ny.pth"
    name.write_text("")
    _git(repo, "add", "-f", str(name))
    found = [p for p in guard.problems(repo) if "tracked by git" in p]
    assert found and "x\\ny.pth" in found[0] and "\n" not in found[0]
