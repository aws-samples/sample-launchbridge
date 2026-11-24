# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""bootstrap_workspace.py: preparing a repository for globally installed skills.

The global install record and lb-setup's generated files come from the real
installer, run with HOME pointed at a temporary folder (and XDG_CONFIG_HOME at
another, conftest.py), so the user's own home is never touched.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "skills" / "lb-setup" / "scripts"
SCRIPT = SCRIPTS / "bootstrap_workspace.py"
INSTALLER_JS = REPO_ROOT / "install_script" / "index.js"
AGENTS_SOURCE = REPO_ROOT / "agent_steering" / "AGENTS.md"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bw = _load("bootstrap_workspace")


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    return home


@pytest.fixture
def repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)  # nosec B603 B607
    return repo


def install_globally(tmp_path, *args: str) -> subprocess.CompletedProcess:
    cwd = tmp_path / "cwd"
    cwd.mkdir(exist_ok=True)
    result = subprocess.run(  # nosec B603 - fixed argv, shell=False
        ["node", str(INSTALLER_JS), "--scope", "global", *args, "--yes"],
        capture_output=True,
        text=True,
        cwd=str(cwd),
        env=dict(os.environ),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result


SKILLS = "lb-setup,indexing-and-qa,testing-framework,data-wrangler"


@pytest.fixture
def lb_setup(home, tmp_path):
    install_globally(
        tmp_path, "--agent", "claude", "--skills", SKILLS, "--method", "copy"
    )
    return home / ".claude" / "skills" / "lb-setup"


def run_script(script: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(  # nosec B603 - fixed argv, shell=False
        [sys.executable, "-I", str(script), *args],
        capture_output=True,
        text=True,
        env=dict(os.environ),
    )


def status_rows(repo: Path) -> dict[str, str]:
    return bw.parse_status((repo / bw.STATUS_FILE).read_text(encoding="utf-8"))


def set_all_complete(repo: Path) -> None:
    rows = [
        (n, s if s in ("not installed", "ready") else "complete")
        for n, s in status_rows(repo).items()
    ]
    (repo / bw.STATUS_FILE).write_text(bw.render_status(rows), encoding="utf-8")


def snapshot(root: Path) -> dict[str, float]:
    return {
        str(p.relative_to(root)): p.lstat().st_mtime_ns
        for p in sorted(root.rglob("*"))
        if ".git" not in p.relative_to(root).parts and not p.is_dir()
    }


def global_manifest_path() -> Path:
    return bw.verify_integrity.global_state_dir() / "manifest.json"


def edit_manifest(change) -> None:
    path = global_manifest_path()
    manifest = json.loads(path.read_text(encoding="utf-8"))
    change(manifest)
    path.write_text(json.dumps(manifest), encoding="utf-8")


# ── mode ─────────────────────────────────────────────────────────────────────


def test_mode_is_local_for_an_lb_setup_inside_the_repository(tmp_path):
    repo = tmp_path / "repo"
    inside = repo / ".claude" / "skills" / "lb-setup"
    inside.mkdir(parents=True)
    assert bw.install_mode(repo, inside) == "local"
    assert bw.install_mode(repo, tmp_path / "home" / ".claude" / "lb-setup") == (
        "global"
    )


def test_mode_of_a_linked_skill_folder_is_where_the_link_is(tmp_path):
    """A symlink install's lb-setup is a link into the LaunchBridge source; the
    link's own location decides the mode, not the folder it names."""
    source = tmp_path / "launchbridge" / "skills" / "lb-setup"
    source.mkdir(parents=True)
    repo = tmp_path / "repo"
    local = repo / ".claude" / "skills" / "lb-setup"
    local.parent.mkdir(parents=True)
    local.symlink_to(source, target_is_directory=True)
    global_ = tmp_path / "home" / ".claude" / "skills" / "lb-setup"
    global_.parent.mkdir(parents=True)
    global_.symlink_to(source, target_is_directory=True)

    assert bw.install_mode(repo, local) == "local"
    assert bw.install_mode(repo, global_) == "global"
    # The source itself as the project: the link is still elsewhere.
    assert bw.install_mode(tmp_path / "launchbridge", global_) == "global"


def test_mode_sees_a_repository_reached_through_a_link(tmp_path):
    real = tmp_path / "real"
    (real / ".kiro" / "skills" / "lb-setup").mkdir(parents=True)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    assert bw.install_mode(link, real / ".kiro" / "skills" / "lb-setup") == "local"


def test_mode_cli_reports_the_source_lb_setup_as_global_for_another_repo(repo):
    result = run_script(SCRIPT, "mode", str(repo))
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["mode"] == "global"
    assert out["skill_dir"] == str(SCRIPTS.parent)


def test_mode_warns_about_a_local_install_too(repo):
    manifest = repo / bw.LOCAL_MANIFEST
    manifest.parent.mkdir(parents=True)
    manifest.write_text("{}")
    assert "also has a local LaunchBridge install" in (
        bw.other_install_warning(repo, "global") or ""
    )


# ── check ────────────────────────────────────────────────────────────────────


def problems_for(path: Path, lb_setup: Path | None = None) -> list[str]:
    return bw.check(path, lb_setup or SCRIPTS.parent)["problems"]


def test_check_passes_a_fresh_repository(home, repo):
    result = bw.check(repo, SCRIPTS.parent)
    assert result == {"ok": True, "problems": [], "warnings": []}
    assert list(repo.iterdir()) == [repo / ".git"]


@pytest.mark.parametrize("where", ["home", "parent", "root"])
def test_check_refuses_the_home_folder_a_folder_above_it_or_the_root(home, where):
    path = {"home": home, "parent": home.parent, "root": Path("/")}[where]
    found = problems_for(path)
    assert any(
        "home folder or a folder above it" in p or "root of the file system" in p
        for p in found
    ), found


def test_check_refuses_a_relative_or_missing_path(tmp_path):
    assert "not an absolute path" in problems_for(Path("repo"))[0]
    assert "not an existing folder" in problems_for(tmp_path / "none")[0]


def test_check_refuses_a_folder_inside_the_launchbridge_source(home, tmp_path):
    source = tmp_path / "launchbridge"
    project = source / "examples" / "demo"
    project.mkdir(parents=True)
    record = bw.verify_integrity.global_state_dir() / "install_source.json"
    record.parent.mkdir(parents=True)
    record.write_text(json.dumps({"sourcePath": str(source)}))
    assert any("inside the LaunchBridge source" in p for p in problems_for(project))


def test_check_refuses_a_folder_inside_a_global_skills_folder(home):
    folder = home / ".agents" / "skills" / "my-skill"
    folder.mkdir(parents=True)
    assert any("inside the skills folder" in p for p in problems_for(folder))


def test_check_refuses_a_state_directory_inside_the_repository(home, repo, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(repo / ".state"))
    assert any("state folder" in p and "is inside" in p for p in problems_for(repo))


def test_check_refuses_a_linked_workspace(home, repo, tmp_path):
    (tmp_path / "elsewhere").mkdir()
    (repo / ".lb_workspace").symlink_to(tmp_path / "elsewhere")
    assert any(".lb_workspace is a symbolic link" in p for p in problems_for(repo))


def test_check_refuses_a_linked_folder_or_file_it_would_write(home, repo, tmp_path):
    (tmp_path / "elsewhere").mkdir()
    (repo / ".lb_workspace" / "config").mkdir(parents=True)
    (repo / ".lb_workspace" / "config" / "python_deps").symlink_to(
        tmp_path / "elsewhere"
    )
    (repo / ".lb_workspace" / "setup_status.md").symlink_to(tmp_path / "x.md")
    found = problems_for(repo)
    assert any("python_deps is a symbolic link" in p for p in found)
    assert any("setup_status.md is a symbolic link" in p for p in found)


def test_check_refuses_a_linked_venv_or_artifacts_folder(home, repo, tmp_path):
    (tmp_path / "elsewhere").mkdir()
    (repo / ".venv_lb").symlink_to(tmp_path / "elsewhere")
    (repo / ".project_artifacts").symlink_to(tmp_path / "elsewhere")
    found = problems_for(repo)
    assert any(".venv_lb is a symbolic link" in p for p in found)
    assert any(".project_artifacts is a symbolic link" in p for p in found)


def test_check_refuses_a_file_where_a_folder_belongs(home, repo):
    (repo / ".lb_workspace").write_text("not a folder")
    assert any("is not a folder" in p for p in problems_for(repo))


def test_check_refuses_a_tracked_file_in_the_workspace_config(home, repo):
    planted = repo / ".lb_workspace" / "config" / "x.py"
    planted.parent.mkdir(parents=True)
    planted.write_text("import os\n")
    subprocess.run(  # nosec B603 B607
        ["git", "-C", str(repo), "add", "-f", ".lb_workspace/config/x.py"],
        check=True,
    )
    assert any(
        ".lb_workspace/config/x.py is tracked by git" in p for p in problems_for(repo)
    )


def test_check_accepts_the_files_lb_setup_asks_to_commit(home, repo):
    kept = repo / ".lb_workspace" / "config" / "config-prompt-store.yaml"
    kept.parent.mkdir(parents=True)
    kept.write_text("prompts: []\n")
    subprocess.run(  # nosec B603 B607
        ["git", "-C", str(repo), "add", "-f", str(kept.relative_to(repo))],
        check=True,
    )
    assert problems_for(repo) == []


def test_check_warns_but_does_not_refuse_a_linked_agents_or_claude_md(home, repo):
    (repo / "AGENTS.md").write_text("# shared\n")
    (repo / "CLAUDE.md").symlink_to(repo / "AGENTS.md")
    result = bw.check(repo, SCRIPTS.parent)
    assert result["ok"] is True
    assert any("CLAUDE.md is a symbolic link" in w for w in result["warnings"])


def test_check_cli_exits_one_and_writes_nothing_when_refused(home):
    result = run_script(SCRIPT, "check", str(home))
    assert result.returncode == 1
    assert json.loads(result.stdout)["ok"] is False
    assert list(home.iterdir()) == []


@pytest.mark.parametrize(
    "repo, refused",
    [
        (PureWindowsPath("C:\\"), "root of the file system"),
        (PureWindowsPath("C:\\Users\\dev"), "home folder"),
        (PureWindowsPath("C:\\Users"), "home folder"),
        (PureWindowsPath("c:\\users\\DEV\\.claude\\skills\\x"), "skills folder"),
        (PureWindowsPath("C:\\Users\\dev\\src\\launchbridge\\docs"), "source"),
        (PureWindowsPath("C:\\Users\\dev\\.config\\launchbridge\\x"), "state folder"),
        (PureWindowsPath("C:\\Users\\dev\\.config"), "state folder"),
    ],
)
def test_location_rules_on_windows_paths(repo, refused):
    found = bw.location_problems(
        repo,
        home=PureWindowsPath("C:\\Users\\dev"),
        state=PureWindowsPath("C:\\Users\\dev\\.config\\launchbridge"),
        source=PureWindowsPath("C:\\Users\\dev\\src\\launchbridge"),
        skills_dirs=[PureWindowsPath("C:\\Users\\dev\\.claude\\skills")],
    )
    assert any(refused in p for p in found), found


def test_location_rules_accept_a_project_on_windows_or_posix():
    for repo, home in (
        (PureWindowsPath("D:\\work\\project"), PureWindowsPath("C:\\Users\\dev")),
        (PurePosixPath("/work/project"), PurePosixPath("/home/dev")),
    ):
        assert (
            bw.location_problems(
                repo,
                home=home,
                state=home / ".config" / "launchbridge",
                source=None,
                skills_dirs=[home / ".claude" / "skills"],
            )
            == []
        )


@pytest.mark.parametrize(
    "rel, ok",
    [
        (PureWindowsPath("a\\b"), True),
        (PureWindowsPath("C:\\x"), False),
        (PureWindowsPath("\\x"), False),
        (PureWindowsPath("..\\x"), False),
        (PureWindowsPath("C:x"), False),
        (PurePosixPath(".lb_workspace/tests"), True),
        (PurePosixPath("/etc"), False),
        (PurePosixPath("a/../b"), False),
        (PurePosixPath("."), False),
    ],
)
def test_layout_paths_must_stay_relative(rel, ok):
    assert bw._safe_rel(rel) is ok


# ── init ─────────────────────────────────────────────────────────────────────


def init(repo: Path, lb_setup: Path) -> dict:
    result = bw.init(repo, lb_setup)
    assert result["ok"] is True, result
    return result


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
@pytest.mark.skipif(os.name == "nt", reason="the installer runs are POSIX-only")
class TestInit:
    def test_a_fresh_repository_gets_everything_lb_setup_starts_from(
        self, repo, lb_setup
    ):
        result = init(repo, lb_setup)

        for rel in (
            ".lb_workspace/indexing_and_qa",
            ".lb_workspace/config/python_deps",
            ".lb_workspace/tests",
            ".project_artifacts/pre-project",
        ):
            assert (repo / rel).is_dir(), rel
        assert not (repo / ".lb_workspace" / "ai_workflow").exists()
        assert not (repo / ".venv_lb").exists()
        rows = status_rows(repo)
        assert rows["venv-setup"] == "not started"
        assert rows["indexing-and-qa"] == "not started"
        assert rows["data-wrangler"] == "ready"
        assert rows["code-guardrails"] == "not installed"
        assert (repo / "AGENTS.md").read_bytes() == AGENTS_SOURCE.read_bytes()
        assert (repo / bw.REFERENCE_FILE).read_bytes() == AGENTS_SOURCE.read_bytes()
        assert (repo / "CLAUDE.md").read_text() == "@AGENTS.md\n"
        assert result["staged"] == []

        deps = run_script(lb_setup / "scripts" / "venv_identity.py", "deps", str(repo))
        assert deps.returncode == 0, deps.stdout
        generated = bw.generated_dir() / "python_deps"
        for name in bw.DEPS_FILES:
            assert (repo / bw.PYTHON_DEPS / name).read_bytes() == (
                generated / name
            ).read_bytes()

    def test_the_cli_from_a_symlink_installed_skill(self, home, repo, tmp_path):
        """lb-setup's folder is a link to the source: init reads the generated
        files beside the global record and writes nothing into the source."""
        install_globally(
            tmp_path, "--agent", "codex", "--skills", SKILLS, "--method", "symlink"
        )
        linked = home / ".agents" / "skills" / "lb-setup"
        assert linked.is_symlink()
        assert linked.resolve() == SCRIPTS.parent.resolve()

        result = run_script(
            linked / "scripts" / "bootstrap_workspace.py", "init", str(repo)
        )

        assert result.returncode == 0, result.stdout + result.stderr
        out = json.loads(result.stdout)
        assert ".lb_workspace/setup_status.md" in out["created"]
        assert (repo / bw.PYTHON_DEPS / "pyproject.toml").read_bytes() == (
            bw.generated_dir() / "python_deps" / "pyproject.toml"
        ).read_bytes()
        assert not (SCRIPTS.parent / "assets").exists()

    def test_the_cli_from_the_installed_skill(self, repo, lb_setup):
        result = run_script(
            lb_setup / "scripts" / "bootstrap_workspace.py", "init", str(repo)
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads(result.stdout)["ok"] is True

    def test_an_existing_agents_md_is_kept_and_the_reference_staged(
        self, repo, lb_setup
    ):
        (repo / "AGENTS.md").write_text("# Our conventions\n")
        result = init(repo, lb_setup)
        assert (repo / "AGENTS.md").read_text() == "# Our conventions\n"
        assert result["staged"] == [bw.STEERING_FILE.as_posix()]
        assert (repo / bw.STEERING_FILE).read_bytes() == AGENTS_SOURCE.read_bytes()

    def test_an_existing_claude_md_gets_agents_md_first(self, repo, lb_setup):
        (repo / "CLAUDE.md").write_text("Be brief.\n")
        init(repo, lb_setup)
        assert (repo / "CLAUDE.md").read_text() == "@AGENTS.md\nBe brief.\n"

    def test_linked_agents_and_claude_md_are_never_written_through(
        self, repo, lb_setup, tmp_path
    ):
        shared = tmp_path / "shared.md"
        shared.write_text("# shared\n")
        (repo / "AGENTS.md").symlink_to(shared)
        (repo / "CLAUDE.md").symlink_to(shared)

        result = init(repo, lb_setup)

        assert shared.read_text() == "# shared\n"
        assert result["staged"] == [bw.STEERING_FILE.as_posix()]
        assert len(result["notes"]) == 2

    def test_a_tampered_generated_file_is_refused_and_nothing_written(
        self, repo, lb_setup
    ):
        pyproject = bw.generated_dir() / "python_deps" / "pyproject.toml"
        pyproject.write_text(pyproject.read_text() + "\n# planted\n")

        result = run_script(
            lb_setup / "scripts" / "bootstrap_workspace.py", "init", str(repo)
        )

        assert result.returncode == 1
        out = json.loads(result.stdout)
        assert "changed: python_deps/pyproject.toml" in out["problems"][0]
        assert sorted(p.name for p in repo.iterdir()) == [".git"]

    def test_an_lb_setup_the_global_install_did_not_write_is_refused(
        self, repo, lb_setup, home
    ):
        copy = home / ".kiro" / "skills" / "lb-setup"
        shutil.copytree(lb_setup, copy)
        with pytest.raises(bw.Refused, match="not an lb-setup the global install"):
            bw.init(repo, copy)

    def test_without_a_global_record_init_cannot_run(self, repo, lb_setup):
        global_manifest_path().unlink()
        result = run_script(
            lb_setup / "scripts" / "bootstrap_workspace.py", "init", str(repo)
        )
        assert result.returncode == 2
        assert "No global install record" in json.loads(result.stdout)["problems"][0]

    def test_a_second_init_with_nothing_changed_changes_nothing(self, repo, lb_setup):
        init(repo, lb_setup)
        record = bw.venv_identity.record_path(repo, bw.SETUP_RECORD)
        before = snapshot(repo), record.stat().st_mtime_ns

        result = init(repo, lb_setup)

        assert (snapshot(repo), record.stat().st_mtime_ns) == before
        assert result["created"] == result["updated"] == result["staged"] == []
        assert result["resets"] == {}

    def test_progress_in_an_existing_status_file_is_kept(self, repo, lb_setup):
        init(repo, lb_setup)
        set_all_complete(repo)
        init(repo, lb_setup)
        assert status_rows(repo)["indexing-and-qa"] == "complete"
        assert status_rows(repo)["code-guardrails"] == "not installed"

    def test_python_deps_with_another_file_is_recreated(self, repo, lb_setup):
        init(repo, lb_setup)
        (repo / bw.PYTHON_DEPS / "setup.py").write_text("import os\n")
        result = init(repo, lb_setup)
        assert sorted(p.name for p in (repo / bw.PYTHON_DEPS).iterdir()) == sorted(
            bw.DEPS_FILES
        )
        assert bw.PYTHON_DEPS.as_posix() + "/" in result["updated"]

    def test_the_setup_record_is_kept_outside_the_repository(self, repo, lb_setup):
        init(repo, lb_setup)
        record = bw.venv_identity.record_path(repo, bw.SETUP_RECORD)
        assert not record.resolve().is_relative_to(repo.resolve())
        assert record.stat().st_mode & 0o777 == 0o600
        data = json.loads(record.read_text())
        assert data["version"] and data["generatedAssets"]


# ── picking up changes to the global install ─────────────────────────────────


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
@pytest.mark.skipif(os.name == "nt", reason="the installer runs are POSIX-only")
class TestChanges:
    @pytest.fixture(autouse=True)
    def _set_up(self, repo, lb_setup):
        (repo / "AGENTS.md").write_text("# Ours\n")
        init(repo, lb_setup)
        (repo / bw.STEERING_FILE).unlink()  # lb-setup merged it
        set_all_complete(repo)
        assert init(repo, lb_setup)["resets"] == {}

    def test_a_changed_skill_goes_back_to_not_started(self, repo, lb_setup):
        edit_manifest(lambda m: m["skillHashes"].update({"testing-framework": "x"}))

        result = init(repo, lb_setup)

        rows = status_rows(repo)
        assert rows["testing-framework"] == "not started"
        assert rows["indexing-and-qa"] == "complete"
        assert rows["venv-setup"] == "complete"
        assert rows["mcp-setup"] == "complete"
        assert rows["agents-md-merge"] == "not started"
        assert result["resets"] == {
            "testing-framework": "not started",
            "agents-md-merge": "not started",
        }
        assert result["staged"] == [bw.STEERING_FILE.as_posix()]

    def test_a_changed_skill_with_no_setup_stays_ready(self, repo, lb_setup):
        edit_manifest(lambda m: m["skillHashes"].update({"data-wrangler": "x"}))
        init(repo, lb_setup)
        assert status_rows(repo)["data-wrangler"] == "ready"

    def test_changed_dependencies_rebuild_the_venv(self, repo, lb_setup):
        generated = bw.generated_dir() / "python_deps" / "pyproject.toml"
        generated.write_text(generated.read_text() + "\n# new dependency\n")
        digest = hashlib.sha256(generated.read_bytes()).hexdigest()
        edit_manifest(
            lambda m: m["generatedAssets"].update(
                {"python_deps/pyproject.toml": digest}
            )
        )

        result = init(repo, lb_setup)

        assert status_rows(repo)["venv-setup"] == "not started"
        assert status_rows(repo)["indexing-and-qa"] == "complete"
        assert result["resets"] == {"venv-setup": "not started"}
        assert (repo / bw.PYTHON_DEPS / "pyproject.toml").read_bytes() == (
            generated.read_bytes()
        )
        deps = run_script(lb_setup / "scripts" / "venv_identity.py", "deps", str(repo))
        assert deps.returncode == 0, deps.stdout

    def test_a_changed_mcp_template_reconciles_the_mcp_config(self, repo, lb_setup):
        edit_manifest(lambda m: m.update({"mcpTemplateHash": "x"}))
        result = init(repo, lb_setup)
        assert result["resets"] == {"mcp-setup": "not started"}

    def test_a_changed_agents_reference_is_staged_for_merging(self, repo, lb_setup):
        edit_manifest(lambda m: m.update({"agentsHash": "x"}))
        result = init(repo, lb_setup)
        assert result["resets"] == {"agents-md-merge": "not started"}
        assert result["staged"] == [bw.STEERING_FILE.as_posix()]
        assert (repo / "AGENTS.md").read_text() == "# Ours\n"

    def test_reinstalling_with_another_skill_adds_only_its_row(
        self, repo, lb_setup, tmp_path
    ):
        install_globally(
            tmp_path,
            "--agent",
            "claude",
            "--skills",
            SKILLS + ",code-guardrails",
            "--method",
            "copy",
        )

        result = init(repo, lb_setup)

        rows = status_rows(repo)
        assert rows["code-guardrails"] == "not started"
        assert rows["indexing-and-qa"] == "complete"
        assert rows["venv-setup"] == "complete"
        assert rows["agents-md-merge"] == "not started"
        assert set(result["resets"]) == {"agents-md-merge"}

    def test_a_deselected_skill_is_marked_not_installed(self, repo, lb_setup, tmp_path):
        install_globally(
            tmp_path,
            "--agent",
            "claude",
            "--skills",
            "lb-setup,testing-framework,data-wrangler",
            "--method",
            "copy",
        )

        init(repo, lb_setup)

        rows = status_rows(repo)
        assert rows["indexing-and-qa"] == "not installed"
        assert rows["mcp-setup"] == "not started"
        assert rows["testing-framework"] == "complete"
