# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The scope ceiling is the only thing that bounds what one indexing run spends.

WHY THIS FILE EXISTS. Indexing issues at least one Amazon Bedrock call per file, with
one concurrent worker per configured model-region pair. IRIS caps neither the request
count nor the spend, Bedrock enforces no per-request spend limit, and the caller is an
AI agent running on a developer's workstation with that developer's own credentials. The
pre-flight in `skills/indexing-and-qa/scripts/codebase_artifact_indexing.py` is the
whole bound, so the failure that matters is not a wrong count — it is any path where the
run proceeds anyway: a measurement error treated as "no problem found", a malformed
ceiling quietly replaced by the default, a cap that stops being checked because the mode
changed shape.

Every test that could plausibly reach Bedrock asserts on a spy: the indexer must not be
called. A test that only checked the return value would pass while the money was spent.

iris is a heavyweight optional dependency that CI does not install, and the script exits
at import time without it, so the module is imported against the stubs installed below.
Only this test module touches iris, so shadowing it in sys.modules affects nothing else.
"""

from __future__ import annotations

import os
import sys
import json
import logging
import types
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO_ROOT / "skills" / "indexing-and-qa"
SCRIPT = SKILL_DIR / "scripts" / "codebase_artifact_indexing.py"
TEMPLATE = SKILL_DIR / "templates" / "inq_config_template.yaml"
SKILL_MD = SKILL_DIR / "SKILL.md"


def _stub(name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    sys.modules[name] = module
    return module


_iris = _stub("iris")
_iris_api = _stub("iris.api")
_iris_artifacts = _stub("iris.artifacts")
_iris_artifact_fm = _stub("iris.artifacts.artifact_file_management")
_iris_fs = _stub("iris.file_system")
_iris_file_mgmt = _stub("iris.file_system.file_management")
_iris.api = _iris_api
_iris.artifacts = _iris_artifacts
_iris.file_system = _iris_fs
_iris_artifacts.artifact_file_management = _iris_artifact_fm
_iris_fs.file_management = _iris_file_mgmt


def _unconfigured(*args: Any, **kwargs: Any):
    raise AssertionError("the test did not configure this iris stub")


for _name in (
    "index_codebase_artifacts",
    "set_config_path",
    "load_default_config",
    "construct_output_dir",
    "get_ignore_patterns",
    "resolve_artifact_dir",
):
    setattr(_iris_api, _name, _unconfigured)
_iris_file_mgmt.get_files_to_process = _unconfigured
_iris_artifact_fm.get_artifacts_to_process = _unconfigured

sys.path.insert(0, str(SCRIPT.parent))
import codebase_artifact_indexing as cai  # noqa: E402

# The autouse fixture below stubs this out; its own test uses the real one.
REAL_ARTIFACT_SETTINGS_CHANGED = cai.artifact_settings_changed


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


class FilesResult:
    """Stands in for iris's FilesToProcessResult."""

    def __init__(self, files_to_process: list[str], total_files: int) -> None:
        self.files_to_process = files_to_process
        self.total_files = total_files


class ArtifactsResult:
    """Stands in for iris's ArtifactsToProcessResult."""

    def __init__(
        self,
        artifacts_to_process: list[str],
        total_artifacts: int,
        artifact_paths: list[str] | None = None,
    ) -> None:
        self.artifacts_to_process = artifacts_to_process
        self.total_artifacts = total_artifacts
        self.artifact_paths = (
            artifact_paths if artifact_paths is not None else list(artifacts_to_process)
        )


DEFAULT_MODELS = {
    "file_summarizer": {
        "models": [
            {"model_id": "m", "region": "us-west-2"},
            {"model_id": "m", "region": "eu-west-1"},
        ]
    }
}


def write_config(tmp_path: Path, **overrides: Any) -> Path:
    """A config file on disk, because read_ceilings deliberately parses the real YAML."""
    config: dict[str, Any] = {
        "codebase_dir": str(tmp_path / "repo"),
        "output_dir": ".lb_workspace/indexing_and_qa",
        "model_configuration": DEFAULT_MODELS,
    }
    config.update(overrides)
    path = tmp_path / "inq_config.yaml"
    path.write_text(yaml.safe_dump(config), encoding="utf-8")
    return path


def fake_iris(
    monkeypatch: pytest.MonkeyPatch,
    *,
    config: dict[str, Any] | None = None,
    files: FilesResult | None = None,
    artifacts: ArtifactsResult | None = None,
    artifact_dir: str | None = None,
    ignore_patterns: list[str] | None = None,
) -> dict[str, Any]:
    """Point the iris stubs at canned answers and record how they were called."""
    config = config if config is not None else {"codebase_dir": "/repo"}
    calls: dict[str, Any] = {}

    def record(key: str, value: Any) -> None:
        calls.setdefault(key, []).append(value)

    monkeypatch.setattr(
        _iris_api, "set_config_path", lambda p: record("set_config_path", p)
    )
    monkeypatch.setattr(_iris_api, "load_default_config", lambda: config)
    monkeypatch.setattr(
        _iris_api,
        "construct_output_dir",
        lambda codebase_dir: f"{codebase_dir}/.out",
    )
    monkeypatch.setattr(
        _iris_api,
        "get_ignore_patterns",
        lambda codebase_dir: (
            ignore_patterns if ignore_patterns is not None else ["node_modules/"]
        ),
    )
    monkeypatch.setattr(_iris_api, "resolve_artifact_dir", lambda cfg: artifact_dir)

    def files_to_process(**kwargs: Any) -> FilesResult:
        record("get_files_to_process", kwargs)
        if files is None:
            raise AssertionError("get_files_to_process should not have been called")
        return files

    def artifacts_to_process(**kwargs: Any) -> ArtifactsResult:
        record("get_artifacts_to_process", kwargs)
        if artifacts is None:
            raise AssertionError("get_artifacts_to_process should not have been called")
        return artifacts

    monkeypatch.setattr(_iris_file_mgmt, "get_files_to_process", files_to_process)
    monkeypatch.setattr(
        _iris_artifact_fm, "get_artifacts_to_process", artifacts_to_process
    )
    return calls


@pytest.fixture(autouse=True)
def data_handling_satisfied(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Hold the data-handling gate open so these tests exercise the ceiling alone.

    The gate runs before the ceiling and has its own module,
    test_indexing_data_handling.py. Here every destination counts as confirmed, the
    artifacts count as cleared, and the transmission log is captured in memory
    rather than written under /repo.
    """
    entries: list[dict[str, Any]] = []
    monkeypatch.setattr(cai, "load_iris_config", lambda path: {"codebase_dir": "/repo"})
    monkeypatch.setattr(cai, "unconfirmed_destinations", lambda dests, conf: [])
    monkeypatch.setattr(
        cai, "load_confirmation", lambda *args: {"artifact_classification": "cleared"}
    )
    monkeypatch.setattr(cai, "append_log", lambda path, entry: entries.append(entry))
    monkeypatch.setattr(cai, "caller_principal", lambda: "principal-a")
    # IRIS is stood in here; binding its config is tested in test_iris_config_binding.py.
    monkeypatch.setattr(cai, "bind_iris_config", lambda config: config)
    monkeypatch.setattr(cai, "pin_iris_config", lambda *args: None)
    # These tests keep their configs outside <repo>/.lb_workspace/indexing_and_qa/;
    # the repository and artifact-settings checks have their own tests below.
    monkeypatch.setattr(cai, "refuse_other_repository", lambda *args: None)
    monkeypatch.setattr(cai, "artifact_settings_changed", lambda *args: False)
    return entries


def index_spy(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Replace the indexer with a recorder. Every call here would cost real money."""
    calls: list[dict[str, Any]] = []

    def fake_index(config_path: str, mode: str) -> dict[str, Any]:
        calls.append({"config_path": config_path, "mode": mode})
        return {"codebase_result": None, "artifact_result": None}

    monkeypatch.setattr(cai, "index_codebase_artifacts", fake_index)
    return calls


def report(**overrides: Any) -> cai.ScopeReport:
    fields: dict[str, Any] = {
        "config_path": Path("/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"),
        "codebase_dir": "/repo",
        "mode": "both",
        "ignore_pattern_count": 45,
        "model_pairs": 10,
        "regions": ["eu-west-1", "us-west-2"],
        "max_files": cai.DEFAULT_MAX_FILES,
        "max_artifacts": cai.DEFAULT_MAX_ARTIFACTS,
        "artifact_max_workers": 4,
        "files_to_process": 100,
        "total_files": 100,
        "artifact_dir": "/repo/.project_artifacts",
        "artifacts_to_process": 10,
        "total_artifacts": 10,
    }
    fields.update(overrides)
    return cai.ScopeReport(**fields)


# --------------------------------------------------------------------------
# Reading the ceilings
# --------------------------------------------------------------------------


def test_a_config_naming_no_ceiling_still_gets_one(tmp_path: Path):
    """Every existing installed config predates these keys and must still be bounded."""
    assert cai.read_ceilings(write_config(tmp_path)) == (
        cai.DEFAULT_MAX_FILES,
        cai.DEFAULT_MAX_ARTIFACTS,
    )


def test_configured_ceilings_are_used(tmp_path: Path):
    config = write_config(
        tmp_path, lb_max_files_per_run=12000, lb_max_artifacts_per_run=42
    )
    assert cai.read_ceilings(config) == (12000, 42)


def test_zero_is_accepted_as_the_documented_escape_hatch(tmp_path: Path):
    config = write_config(tmp_path, lb_max_files_per_run=0, lb_max_artifacts_per_run=0)
    assert cai.read_ceilings(config) == (0, 0)


def test_a_malformed_ceiling_is_rejected_rather_than_defaulted(tmp_path: Path):
    """Falling back to the default would apply a limit the operator never wrote."""
    config = write_config(tmp_path, lb_max_files_per_run="lots")
    with pytest.raises(ValueError, match="lb_max_files_per_run"):
        cai.read_ceilings(config)


def test_a_negative_ceiling_is_rejected(tmp_path: Path):
    config = write_config(tmp_path, lb_max_files_per_run=-1)
    with pytest.raises(ValueError, match="0 or greater"):
        cai.read_ceilings(config)


def test_a_boolean_is_not_read_as_a_ceiling_of_one(tmp_path: Path):
    """`lb_max_files_per_run: true` is a mistake; int(True) would make it a 1-file cap."""
    config = write_config(tmp_path, lb_max_files_per_run=True)
    with pytest.raises(ValueError, match="whole number"):
        cai.read_ceilings(config)


def test_a_null_ceiling_is_rejected(tmp_path: Path):
    config = write_config(tmp_path, lb_max_artifacts_per_run=None)
    with pytest.raises(ValueError, match="lb_max_artifacts_per_run"):
        cai.read_ceilings(config)


# --------------------------------------------------------------------------
# Applying the ceilings
# --------------------------------------------------------------------------


def test_a_run_within_the_ceiling_is_not_flagged():
    assert cai.check_scope_ceiling(report(files_to_process=4999, max_files=5000)) == []


def test_a_run_exactly_at_the_ceiling_is_allowed():
    """The ceiling is a maximum, not a forbidden value."""
    assert cai.check_scope_ceiling(report(files_to_process=5000, max_files=5000)) == []


def test_one_file_over_the_ceiling_is_flagged():
    exceeded = cai.check_scope_ceiling(report(files_to_process=5001, max_files=5000))
    assert len(exceeded) == 1
    assert "5001" in exceeded[0] and "5000" in exceeded[0]
    assert cai.MAX_FILES_KEY in exceeded[0]


def test_the_artifact_ceiling_is_checked_separately():
    exceeded = cai.check_scope_ceiling(
        report(files_to_process=1, artifacts_to_process=501, max_artifacts=500)
    )
    assert len(exceeded) == 1
    assert cai.MAX_ARTIFACTS_KEY in exceeded[0]


def test_both_ceilings_can_be_exceeded_at_once():
    exceeded = cai.check_scope_ceiling(
        report(files_to_process=9999, artifacts_to_process=999)
    )
    assert len(exceeded) == 2


def test_a_ceiling_of_zero_permits_any_size():
    """0 means "no ceiling", not "no files"."""
    assert cai.check_scope_ceiling(report(files_to_process=10**6, max_files=0)) == []


def test_a_half_measured_run_is_only_checked_against_what_it_measured():
    """mode=codebase never counts artifacts, so the artifact cap cannot fire."""
    unmeasured = report(
        mode="codebase",
        artifacts_to_process=None,
        total_artifacts=None,
        max_artifacts=1,
    )
    assert cai.check_scope_ceiling(unmeasured) == []


# --------------------------------------------------------------------------
# What the operator is told
# --------------------------------------------------------------------------


def test_the_refusal_names_the_numbers_the_levers_and_the_override():
    text = cai.format_refusal(
        report(files_to_process=9000), ["9000 files to summarize exceeds x=5000"]
    )
    assert "Refusing to index" in text
    assert "9000" in text
    assert "codebase_dir" in text and "ignore_patterns" in text
    assert str(report().config_path) in text
    assert f"{cai.MAX_FILES_KEY}: 0" in text
    # Trimming the model list is the obvious-looking fix and the wrong one: it lowers
    # concurrency, not the number of calls. Saying so prevents a pointless edit.
    assert "does not change this check" in text


def test_the_scope_report_names_the_regions_that_receive_repository_content():
    text = cai.format_scope_report(report())
    assert "eu-west-1" in text and "us-west-2" in text
    assert "10 model-region pair" in text
    assert "Budgets" in text


def test_the_scope_report_distinguishes_unconfigured_artifacts_from_a_skipped_mode():
    skipped = cai.format_scope_report(
        report(mode="codebase", artifacts_to_process=None)
    )
    assert "not indexed in this mode" in skipped

    unconfigured = cai.format_scope_report(
        report(mode="both", artifacts_to_process=None)
    )
    assert "artifact_dir is not configured" in unconfigured


def test_a_disabled_ceiling_is_announced():
    assert cai.disabled_ceiling_notice(report(max_files=0)) is not None
    assert cai.MAX_FILES_KEY in cai.disabled_ceiling_notice(report(max_files=0))
    assert cai.disabled_ceiling_notice(report()) is None


def test_a_disabled_ceiling_is_not_announced_for_a_half_the_run_does_not_touch():
    """Warning about the artifact cap during a codebase-only run is noise."""
    quiet = report(mode="codebase", artifacts_to_process=None, max_artifacts=0)
    assert cai.disabled_ceiling_notice(quiet) is None


# --------------------------------------------------------------------------
# Measuring
# --------------------------------------------------------------------------


def test_the_count_is_the_files_to_be_summarized_not_the_repository_size(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """An incremental re-index of 3 changed files must not be judged as 900."""
    fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo", "model_configuration": DEFAULT_MODELS},
        files=FilesResult(["a", "b", "c"], total_files=900),
    )
    measured = cai.measure_scope(tmp_path / "c.yaml", "codebase", 5000, 500)
    assert measured.files_to_process == 3
    assert measured.total_files == 900


def test_measurement_uses_the_config_and_ignore_patterns_iris_itself_resolves(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """A count derived from a separate heuristic drifts from the real ignore list."""
    calls = fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo", "model_configuration": DEFAULT_MODELS},
        files=FilesResult([], total_files=0),
        ignore_patterns=["node_modules/", "dist/", "vendor/"],
    )
    config_path = tmp_path / "c.yaml"
    measured = cai.measure_scope(config_path, "codebase", 5000, 500)

    assert calls["set_config_path"] == [config_path]
    passed = calls["get_files_to_process"][0]
    assert passed["ignore_patterns"] == ["node_modules/", "dist/", "vendor/"]
    assert passed["output_dir"] == "/repo/.out"
    assert measured.ignore_pattern_count == 3
    assert measured.model_pairs == 2
    assert measured.regions == ["eu-west-1", "us-west-2"]


def test_artifacts_are_not_measured_when_no_artifact_dir_is_configured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo"},
        files=FilesResult([], total_files=0),
        artifact_dir=None,
        artifacts=None,  # would raise if called
    )
    measured = cai.measure_scope(tmp_path / "c.yaml", "both", 5000, 500)
    assert measured.artifacts_to_process is None
    assert measured.artifact_dir is None


def test_codebase_mode_does_not_touch_the_artifact_helpers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    calls = fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo"},
        files=FilesResult([], total_files=0),
        artifact_dir="/repo/.project_artifacts",
        artifacts=None,  # would raise if called
    )
    cai.measure_scope(tmp_path / "c.yaml", "codebase", 5000, 500)
    assert "get_artifacts_to_process" not in calls


def test_a_config_without_codebase_dir_cannot_be_measured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    fake_iris(monkeypatch, config={})
    with pytest.raises(ValueError, match="codebase_dir"):
        cai.measure_scope(tmp_path / "c.yaml", "codebase", 5000, 500)


# --------------------------------------------------------------------------
# Refusing to spend
# --------------------------------------------------------------------------


def test_an_over_ceiling_run_never_reaches_the_indexer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    spy = index_spy(monkeypatch)
    fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo"},
        files=FilesResult(["f"] * 11, total_files=11),
    )
    config = write_config(tmp_path, lb_max_files_per_run=10)

    result = cai.run_indexing(str(config), "codebase")

    assert result["status"] == "refused"
    assert spy == [], "indexing ran despite the refusal"
    assert "11 files to summarize exceeds" in result["error"]


def test_a_within_ceiling_run_proceeds_to_the_indexer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    spy = index_spy(monkeypatch)
    fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo"},
        files=FilesResult(["f"] * 5, total_files=5),
    )
    config = write_config(tmp_path, lb_max_files_per_run=10)

    result = cai.run_indexing(str(config), "codebase")

    assert len(spy) == 1
    assert spy[0]["mode"] == "codebase"
    # The stub returns no codebase_result, which run_indexing reports as an error.
    # What matters here is that the ceiling let the call through.
    assert result["status"] == "error"


def test_a_measurement_that_fails_refuses_instead_of_indexing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """iris tracks a moving ref: "could not evaluate the ceiling" must not become
    "the ceiling did not apply"."""
    spy = index_spy(monkeypatch)

    def broken(*args: Any, **kwargs: Any):
        raise AttributeError("module 'iris.api' has no attribute 'get_ignore_patterns'")

    monkeypatch.setattr(cai, "measure_scope", broken)
    config = write_config(tmp_path)

    result = cai.run_indexing(str(config), "codebase")

    assert result["status"] == "refused"
    assert spy == []
    assert "could not list the files" in result["error"]
    # The refusal names what to fix, not a setting that skips the check.
    assert "Fix the config or the iris installation" in result["error"]


def test_ceilings_at_zero_still_refuse_when_measurement_is_broken(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Without a file list there is nothing to scan for credentials or to log."""
    spy = index_spy(monkeypatch)

    def broken(*args: Any, **kwargs: Any):
        raise AttributeError("module 'iris.api' has no attribute 'get_ignore_patterns'")

    monkeypatch.setattr(cai, "measure_scope", broken)
    config = write_config(tmp_path, lb_max_files_per_run=0, lb_max_artifacts_per_run=0)

    result = cai.run_indexing(str(config), "codebase", allow_unbounded=True)

    assert result["status"] == "refused"
    assert spy == []


def test_a_zero_ceiling_refuses_without_allow_unbounded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """0 alone no longer means unlimited: the run must also ask for it."""
    spy = index_spy(monkeypatch)
    config = write_config(tmp_path, lb_max_files_per_run=0)

    result = cai.run_indexing(str(config), "codebase")

    assert result["status"] == "refused"
    assert spy == []
    assert cai.MAX_FILES_KEY in result["error"]
    assert "--allow-unbounded" in result["error"]


def test_a_zero_ceiling_for_the_other_half_needs_no_flag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """A codebase run is not held up by the artifact ceiling being 0."""
    spy = index_spy(monkeypatch)
    fake_iris(monkeypatch, files=FilesResult(["f"] * 3, total_files=3))
    config = write_config(tmp_path, lb_max_artifacts_per_run=0)

    cai.run_indexing(str(config), "codebase")

    assert len(spy) == 1


def test_allow_unbounded_runs_with_a_zero_ceiling(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    spy = index_spy(monkeypatch)
    fake_iris(monkeypatch, files=FilesResult(["f"] * 9000, total_files=9000))
    config = write_config(tmp_path, lb_max_files_per_run=0)

    cai.run_indexing(str(config), "codebase", allow_unbounded=True)

    assert len(spy) == 1


def test_one_ceiling_at_zero_still_measures(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Disabling the file cap must not silently disable the artifact cap too."""
    spy = index_spy(monkeypatch)
    fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo"},
        files=FilesResult(["f"] * 99, total_files=99),
        artifact_dir="/artifacts",
        artifacts=ArtifactsResult(["a"] * 7, total_artifacts=7),
    )
    config = write_config(tmp_path, lb_max_files_per_run=0, lb_max_artifacts_per_run=5)

    result = cai.run_indexing(str(config), "both", allow_unbounded=True)

    assert result["status"] == "refused"
    assert spy == []
    assert cai.MAX_ARTIFACTS_KEY in result["error"]


def test_a_malformed_ceiling_refuses_without_indexing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    spy = index_spy(monkeypatch)
    config = write_config(tmp_path, lb_max_files_per_run="5,000")

    result = cai.run_indexing(str(config), "codebase")

    assert result["status"] == "refused"
    assert spy == []


def test_a_refusal_does_not_echo_credential_bearing_error_text(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """The refusal is logged and often pasted into a chat transcript."""
    index_spy(monkeypatch)

    def leaky(*args: Any, **kwargs: Any):
        raise RuntimeError("bad aws_secret_access_key=AKIAIOSFODNN7EXAMPLE")

    monkeypatch.setattr(cai, "measure_scope", leaky)

    result = cai.run_indexing(str(write_config(tmp_path)), "codebase")

    assert result["status"] == "refused"
    assert "AKIAIOSFODNN7EXAMPLE" not in result["error"]


# --------------------------------------------------------------------------
# Exit codes and the report mode
# --------------------------------------------------------------------------


def run_main(monkeypatch: pytest.MonkeyPatch, argv: list[str]) -> int:
    monkeypatch.setattr(sys, "argv", ["codebase_artifact_indexing.py", *argv])
    return cai.main()


def test_a_refusal_exits_three_not_one(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A distinct code so a caller can tell "too big" from "broken"."""
    monkeypatch.setattr(
        cai,
        "run_indexing",
        lambda config, mode, allow_unbounded=False: {
            "status": "refused",
            "error": "too big",
        },
    )
    config = write_config(tmp_path)
    assert run_main(monkeypatch, ["--config", str(config)]) == 3


def test_a_successful_run_still_exits_zero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setattr(
        cai,
        "run_indexing",
        lambda config, mode, allow_unbounded=False: {
            "status": "update_complete",
            "message": "done",
            "processed_files": ["a"],
        },
    )
    assert run_main(monkeypatch, ["--config", str(write_config(tmp_path))]) == 0


def test_a_failure_still_exits_one(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(
        cai,
        "run_indexing",
        lambda config, mode, allow_unbounded=False: {
            "status": "error",
            "error": "boom",
        },
    )
    assert run_main(monkeypatch, ["--config", str(write_config(tmp_path))]) == 1


def test_report_scope_reports_without_indexing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    spy = index_spy(monkeypatch)
    fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo", "model_configuration": DEFAULT_MODELS},
        files=FilesResult(["f"] * 562, total_files=562),
    )

    code = run_main(
        monkeypatch,
        [
            "--config",
            str(write_config(tmp_path)),
            "--mode",
            "codebase",
            "--report-scope",
        ],
    )

    assert code == 0
    assert spy == [], "--report-scope indexed the repository"
    assert "562" in capsys.readouterr().out


def test_report_scope_says_when_the_run_would_be_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """Asking how big a run is succeeds even when the answer is "too big to run"."""
    index_spy(monkeypatch)
    fake_iris(
        monkeypatch,
        config={"codebase_dir": "/repo"},
        files=FilesResult(["f"] * 50, total_files=50),
    )
    config = write_config(tmp_path, lb_max_files_per_run=10)

    code = run_main(
        monkeypatch, ["--config", str(config), "--mode", "codebase", "--report-scope"]
    )

    assert code == 0
    assert "would be refused" in capsys.readouterr().out


def test_report_scope_fails_when_scope_cannot_be_measured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    def broken(*args: Any, **kwargs: Any):
        raise RuntimeError("no")

    monkeypatch.setattr(cai, "measure_scope", broken)
    code = run_main(
        monkeypatch, ["--config", str(write_config(tmp_path)), "--report-scope"]
    )
    assert code == 1


# --------------------------------------------------------------------------
# The ceiling has to be documented where it is configured
# --------------------------------------------------------------------------


def test_the_template_ships_both_ceilings_at_the_scripts_defaults():
    """A default that lives in two places drifts; this is the cheap guard."""
    config = yaml.safe_load(TEMPLATE.read_text(encoding="utf-8"))
    assert config[cai.MAX_FILES_KEY] == cai.DEFAULT_MAX_FILES
    assert config[cai.MAX_ARTIFACTS_KEY] == cai.DEFAULT_MAX_ARTIFACTS


def test_the_template_explains_how_to_remove_the_ceiling():
    text = TEMPLATE.read_text(encoding="utf-8")
    assert "--report-scope" in text
    assert "Set to 0 to remove a ceiling" in text
    assert "--allow-unbounded" in text


def test_the_skill_tells_the_agent_what_exit_three_means():
    """The agent reading SKILL.md must not treat a refusal as a bug to work around."""
    text = SKILL_MD.read_text(encoding="utf-8")
    assert "--report-scope" in text
    assert "exits 3" in text
    assert cai.MAX_FILES_KEY in text
    assert "Do not work around this by editing the config" in text


def test_the_runner_passes_report_scope_through():
    runner = (SKILL_DIR / "scripts" / "inq_run_indexing.sh").read_text(encoding="utf-8")
    assert "--report-scope" in runner
    assert "$REPORT_SCOPE" in runner


# ------------------------------------------------- credential scan and artifacts

# Built at runtime so this file holds no credential-shaped literal of its own.
FAKE_KEY_ID = "AKIA" + "Q7ZT3M5N8P2R4W6Y"
FAKE_PRIVATE_KEY = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIE\n"


def test_the_scan_finds_keys_and_tokens(tmp_path: Path):
    (tmp_path / "id").write_text(FAKE_PRIVATE_KEY, encoding="utf-8")
    (tmp_path / "settings.py").write_text(f'KEY = "{FAKE_KEY_ID}"\n', encoding="utf-8")
    (tmp_path / "ci.yml").write_text(
        "token: gh" + "p_" + "a" * 36 + "\n", encoding="utf-8"
    )
    (tmp_path / "clean.py").write_text("print('hello')\n", encoding="utf-8")

    hits = cai.scan_for_secrets(
        ["id", "settings.py", "ci.yml", "clean.py"], str(tmp_path)
    )

    assert hits == [
        ("id", "private key"),
        ("settings.py", "AWS access key ID"),
        ("ci.yml", "GitHub token"),
    ]


@pytest.mark.parametrize("encoding", ["utf-16", "utf-16-le", "utf-16-be"])
def test_the_scan_finds_a_key_in_utf16_text(tmp_path: Path, encoding):
    """PowerShell 5's `>` writes UTF-16; IRIS decodes it before sending."""
    (tmp_path / "env.txt").write_bytes(
        f"AWS_ACCESS_KEY_ID={FAKE_KEY_ID}\n".encode(encoding)
    )
    assert cai.scan_for_secrets(["env.txt"], str(tmp_path)) == [
        ("env.txt", "AWS access key ID")
    ]


@pytest.mark.parametrize("encoding", ["utf-32", "utf-32-le"])
def test_the_scan_finds_a_key_in_utf32_text(tmp_path: Path, encoding):
    (tmp_path / "notes.txt").write_bytes(f"key={FAKE_KEY_ID}\n".encode(encoding))
    assert cai.scan_for_secrets(["notes.txt"], str(tmp_path)) == [
        ("notes.txt", "AWS access key ID")
    ]


def test_the_scan_reads_a_whole_notebook_as_iris_does(tmp_path: Path):
    """IRIS drops image outputs, so a key after 5 MB of plots is still sent."""
    plot = {"output_type": "display_data", "data": {"image/png": "A" * 6_000_000}}
    cell = {"cell_type": "code", "source": [f'key = "{FAKE_KEY_ID}"\n'], "outputs": []}
    notebook = {"cells": [{"cell_type": "code", "source": [], "outputs": [plot]}, cell]}
    (tmp_path / "analysis.ipynb").write_text(json.dumps(notebook), encoding="utf-8")
    assert cai.scan_for_secrets(["analysis.ipynb"], str(tmp_path)) == [
        ("analysis.ipynb", "AWS access key ID")
    ]


def test_binary_data_with_nul_bytes_is_not_a_hit(tmp_path: Path):
    (tmp_path / "blob.bin").write_bytes(bytes(range(256)) * 64)
    assert cai.scan_for_secrets(["blob.bin"], str(tmp_path)) == []


def test_the_scan_ignores_aws_documentation_examples(tmp_path: Path):
    (tmp_path / "README.md").write_text(
        "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n"
        "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
        encoding="utf-8",
    )
    assert cai.scan_for_secrets(["README.md"], str(tmp_path)) == []


def test_a_file_with_a_credential_is_never_sent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    spy = index_spy(monkeypatch)
    secret = tmp_path / "deploy.sh"
    secret.write_text(f"export AWS_ACCESS_KEY_ID={FAKE_KEY_ID}\n", encoding="utf-8")
    fake_iris(monkeypatch, files=FilesResult([str(secret)], total_files=1))
    config = write_config(tmp_path)

    result = cai.run_indexing(str(config), "codebase")

    assert result["status"] == "data_handling"
    assert spy == []
    assert str(secret) in result["error"]
    assert "ignore_patterns" in result["error"]


def test_artifacts_need_a_recorded_classification(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    spy = index_spy(monkeypatch)
    monkeypatch.setattr(cai, "load_confirmation", lambda *args: {"destinations": []})
    fake_iris(
        monkeypatch,
        artifact_dir="/artifacts",
        artifacts=ArtifactsResult(["a.pdf"], total_artifacts=1),
    )
    config = write_config(tmp_path)

    result = cai.run_indexing(str(config), "artifact")

    assert result["status"] == "data_handling"
    assert spy == []
    assert "--artifact-classification" in result["error"]


@pytest.mark.parametrize(
    "cleared_for, runs",
    [("/artifacts", True), ("/other-artifacts", False), (None, False)],
)
def test_the_classification_clears_only_the_folder_it_was_given_for(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, cleared_for, runs
):
    spy = index_spy(monkeypatch)
    record = {"destinations": [], "artifact_classification": "Internal"}
    if cleared_for:
        record["artifact_dir"] = str(Path(cleared_for).resolve())
    monkeypatch.setattr(cai, "load_confirmation", lambda *args: record)
    fake_iris(
        monkeypatch,
        artifact_dir="/artifacts",
        artifacts=ArtifactsResult(["a.pdf"], total_artifacts=1),
    )

    result = cai.run_indexing(str(write_config(tmp_path)), "artifact")

    assert (len(spy) == 1) is runs
    if not runs:
        assert result["status"] == "data_handling"
        assert "/artifacts" in result["error"]


def test_a_codebase_run_needs_no_artifact_classification(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    spy = index_spy(monkeypatch)
    monkeypatch.setattr(cai, "load_confirmation", lambda *args: {"destinations": []})
    fake_iris(monkeypatch, files=FilesResult(["f"], total_files=1))
    config = write_config(tmp_path)

    cai.run_indexing(str(config), "codebase")

    assert len(spy) == 1


def test_the_classification_is_recorded_with_the_confirmation(tmp_path: Path):
    path = tmp_path / "data_handling_confirmation.json"
    cai.write_confirmation(
        path,
        [],
        "SOW 4.2",
        "Internal; cleared by the lead",
        principal="principal-a",
        codebase_dir=str(tmp_path / "repo"),
    )
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["artifact_classification"] == "Internal; cleared by the lead"


def test_the_classification_records_the_artifact_folder(tmp_path: Path):
    path = tmp_path / "data_handling_confirmation.json"
    folder = tmp_path / "artifacts"
    folder.mkdir()
    cai.write_confirmation(
        path,
        [],
        "SOW 4.2",
        "Internal",
        principal="principal-a",
        codebase_dir=str(tmp_path / "repo"),
        artifact_dir=str(folder),
    )
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["artifact_dir"] == str(folder.resolve())
    assert cai.artifacts_cleared(record, folder)
    assert not cai.artifacts_cleared(record, tmp_path)


# --------------------------------------------------------------------------
# What the measurement must not miss
# --------------------------------------------------------------------------


def test_a_linked_artifact_is_refused(tmp_path: Path):
    folder = tmp_path / "artifacts"
    folder.mkdir()
    (folder / "deck.pdf").write_bytes(b"%PDF")
    (tmp_path / "secret.txt").write_text("x")
    (folder / "notes.md").symlink_to(tmp_path / "secret.txt")
    assert cai.artifacts_outside(folder, ["deck.pdf", "notes.md"]) == ["notes.md"]


def test_every_artifact_counts_when_iris_will_reprocess_them(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    fake_iris(
        monkeypatch,
        artifact_dir=str(tmp_path),
        artifacts=ArtifactsResult(
            [], total_artifacts=3, artifact_paths=["a", "b", "c"]
        ),
        files=FilesResult([], total_files=0),
    )
    monkeypatch.setattr(cai, "artifacts_outside", lambda *args: [])
    monkeypatch.setattr(cai, "artifact_settings_changed", lambda *args: True)

    measured = cai.measure_scope(tmp_path / "c.yaml", "artifact", 5000, 500)

    assert measured.artifacts_to_process == 3
    assert measured.artifact_paths == ["a", "b", "c"]


def test_an_unknown_artifact_settings_state_counts_as_changed(tmp_path: Path):
    """Without IRIS's fingerprint to compare, assume every artifact is re-sent."""
    assert REAL_ARTIFACT_SETTINGS_CHANGED({}, tmp_path) is True


def test_the_output_folder_must_stay_in_the_repository(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / ".lb_workspace" / "indexing_and_qa").mkdir(parents=True)
    out = repo / ".lb_workspace" / "indexing_and_qa" / "repo"
    assert cai.output_dir_problem(repo, out) is None

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    out.symlink_to(elsewhere, target_is_directory=True)
    assert "outside" in cai.output_dir_problem(repo, out)


def test_a_link_inside_the_repository_on_the_output_path_is_refused(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "real").mkdir(parents=True)
    (repo / "link").symlink_to(repo / "real", target_is_directory=True)
    assert "symbolic link" in cai.output_dir_problem(repo, repo / "link" / "repo")


@pytest.mark.parametrize(
    "codebase_dir, refused",
    [
        ("{repo}", False),
        ("{repo}/.", False),
        ("{repo}/..", True),
        ("/", True),
        ("{other}", True),
    ],
)
def test_codebase_dir_must_be_the_repository_holding_the_config(
    tmp_path: Path, codebase_dir, refused
):
    repo = tmp_path / "repo"
    config = repo / ".lb_workspace" / "indexing_and_qa" / "inq_config.yaml"
    config.parent.mkdir(parents=True)
    named = codebase_dir.format(repo=repo, other=tmp_path / "other")
    assert (
        cai.other_repository({"codebase_dir": named}, config) is not None
    ) is refused


def test_a_region_with_a_trailing_newline_is_refused():
    entry = {"model_id": "m", "region": "us-east-1\n"}
    config = {"model_configuration": {"orchestrator": entry}}
    assert cai.unsafe_settings(config)


def test_a_linked_config_folder_with_a_relative_codebase_dir_is_refused(tmp_path: Path):
    """The demonstrated bypass: .lb_workspace/indexing_and_qa -> ../a, codebase_dir '..'."""
    repo = tmp_path / "parent" / "repo"
    (repo / ".lb_workspace").mkdir(parents=True)
    (repo / "a").mkdir()
    (repo / ".lb_workspace" / "indexing_and_qa").symlink_to(
        repo / "a", target_is_directory=True
    )
    config = repo / ".lb_workspace" / "indexing_and_qa" / "inq_config.yaml"
    assert cai.other_repository({"codebase_dir": ".."}, config) is not None
    assert cai.other_repository({"codebase_dir": str(repo)}, config) is not None


def test_a_linked_artifact_folder_inside_the_repository_is_refused(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    documents = tmp_path / "Documents"
    documents.mkdir()
    (repo / ".project_artifacts").symlink_to(documents, target_is_directory=True)
    assert "outside" in cai.artifact_dir_problem(repo, repo / ".project_artifacts")

    (repo / "real" / "artifacts").mkdir(parents=True)
    (repo / "linked").symlink_to(repo / "real", target_is_directory=True)
    assert "symbolic link" in cai.artifact_dir_problem(
        repo, repo / "linked" / "artifacts"
    )


def test_an_artifact_folder_named_inside_or_outside_is_otherwise_allowed(
    tmp_path: Path,
):
    repo = tmp_path / "repo"
    (repo / ".project_artifacts").mkdir(parents=True)
    elsewhere = tmp_path / "engagement-docs"
    elsewhere.mkdir()
    assert cai.artifact_dir_problem(repo, repo / ".project_artifacts") is None
    assert cai.artifact_dir_problem(repo, elsewhere) is None


def test_the_notebook_scan_reads_outputs_iris_keeps(tmp_path: Path):
    """IRIS removes only PNG and JPEG outputs; an SVG output is sent."""
    plot = {"output_type": "display_data", "data": {"image/png": "A" * 6_000_000}}
    svg = {
        "output_type": "display_data",
        "data": {"image/svg+xml": [f"<text>{FAKE_KEY_ID}</text>"]},
    }
    notebook = {"cells": [{"cell_type": "code", "source": [], "outputs": [plot, svg]}]}
    (tmp_path / "plots.ipynb").write_text(json.dumps(notebook), encoding="utf-8")
    assert cai.scan_for_secrets(["plots.ipynb"], str(tmp_path)) == [
        ("plots.ipynb", "AWS access key ID")
    ]


def test_a_failed_summary_never_logs_the_file(caplog):
    """IRIS logs the whole file when a Bedrock call fails; the filter withholds it."""
    message = (
        "call_bedrock failed for file src/app.py\nModel: m\nRegion: us-east-1\n"
        "src_str type: <class 'str'>\nsrc_str value: 'SECRET FILE TEXT\\nmore'\n"
        "dynamic_message length: 10\nstatic_message length: 5\nError: X: y"
    )
    record = logging.LogRecord(
        "iris.summarize.file_summarizer", logging.ERROR, "", 0, message, (), None
    )
    cai.WithholdFileContent().filter(record)
    text = record.getMessage()
    assert "SECRET FILE TEXT" not in text
    assert "withheld" in text and "src/app.py" in text and "Error: X: y" in text


def test_indexing_refuses_links_out_of_the_repository(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "app.py").write_text("x = 1\n")
    home = tmp_path / "home"
    home.mkdir()
    (repo / "notes").symlink_to(home, target_is_directory=True)
    (repo / "private").mkdir()
    (repo / "pub").symlink_to(repo / "private", target_is_directory=True)
    (tmp_path / "secret.txt").write_text("s")
    (repo / "secret.txt").symlink_to(tmp_path / "secret.txt")
    (repo / "docs").mkdir()
    (repo / "docs" / "readme.md").symlink_to(repo / "src" / "app.py")  # inside: fine
    (repo / "node_modules").mkdir()
    (repo / "node_modules" / ".bin").symlink_to(home, target_is_directory=True)

    assert cai.codebase_links(repo, ["node_modules/", "private/"]) == [
        "notes",
        "pub",
        "secret.txt",
    ]


def test_a_link_that_would_send_an_ignored_file_is_refused(tmp_path: Path):
    """IRIS applies the ignore patterns to the path it reached a file by."""
    repo = tmp_path / "repo"
    (repo / "deploy").mkdir(parents=True)
    (repo / ".env").write_text("DB_PASSWORD=x\n")
    (repo / "deploy" / "notes.txt").symlink_to(repo / ".env")
    (repo / "secrets").mkdir()
    (repo / "secrets" / "k.txt").write_text("k")
    (repo / "src").mkdir()
    (repo / "src" / "conf").mkdir()
    (repo / "src" / "conf" / "local.cfg").write_text("c")
    (repo / "mirror").symlink_to(repo / "src", target_is_directory=True)
    (repo / "loop").mkdir()
    (repo / "loop" / "up").symlink_to(repo / "loop", target_is_directory=True)
    patterns = [".env", "/secrets/", "/src/conf/local.cfg"]
    assert cai.codebase_links(repo, patterns) == [
        "deploy/notes.txt",
        "loop/up",
        "mirror",
    ]


def test_links_to_indexed_folders_in_the_repository_pass(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "src" / "api").mkdir(parents=True)
    (repo / "src" / "api" / "v1.py").write_text("x = 1\n")
    (repo / "docs").mkdir()
    (repo / "docs" / "api").symlink_to(repo / "src" / "api", target_is_directory=True)
    (repo / "env" / "lib").mkdir(parents=True)
    (repo / "env" / "lib64").symlink_to(repo / "env" / "lib", target_is_directory=True)
    assert cai.codebase_links(repo, [".env"]) == []


def test_a_link_inside_the_output_folder_is_refused(tmp_path: Path):
    """IRIS writes tree.txt and file_paths.txt through a link it finds there."""
    repo = tmp_path / "repo"
    out = repo / "idx" / "repo"
    out.mkdir(parents=True)
    assert cai.output_dir_problem(repo, out) is None
    (tmp_path / "victim").write_text("v")
    (out / "tree.txt").symlink_to(tmp_path / "victim")
    assert "holds a symbolic link" in cai.output_dir_problem(repo, out)


def test_the_notebook_scan_stops_where_iris_does(tmp_path: Path):
    """IRIS's image removal stops at an output it can't handle, so a later image
    is sent: the scan must read it."""
    odd = {"output_type": "display_data", "data": ["image/png"]}
    image = {"output_type": "display_data", "data": {"image/png": f"{FAKE_KEY_ID}"}}
    notebook = {
        "cells": [
            {"cell_type": "code", "source": [], "outputs": [odd]},
            {"cell_type": "code", "source": [], "outputs": [image]},
        ]
    }
    (tmp_path / "n.ipynb").write_text(json.dumps(notebook), encoding="utf-8")
    assert cai.scan_for_secrets(["n.ipynb"], str(tmp_path)) == [
        ("n.ipynb", "AWS access key ID")
    ]


def test_a_repository_without_such_links_passes(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "app.py").write_text("x = 1\n")
    assert cai.codebase_links(repo, []) == []


def test_the_notebook_scan_reads_keys_and_metadata(tmp_path: Path):
    notebook = {
        "cells": [],
        "metadata": {FAKE_KEY_ID: "x", "image/png": f"token {FAKE_KEY_ID}"},
    }
    (tmp_path / "meta.ipynb").write_text(json.dumps(notebook), encoding="utf-8")
    assert cai.scan_for_secrets(["meta.ipynb"], str(tmp_path)) == [
        ("meta.ipynb", "AWS access key ID")
    ]


def test_a_large_text_artifact_is_scanned_to_the_limit_given(tmp_path: Path):
    (tmp_path / "notes.txt").write_bytes(
        b"x" * 6_000_000 + f"\n{FAKE_KEY_ID}\n".encode()
    )
    assert cai.scan_for_secrets(["notes.txt"], str(tmp_path)) == []
    assert cai.scan_for_secrets(["notes.txt"], str(tmp_path), 30_000_000) == [
        ("notes.txt", "AWS access key ID")
    ]


@pytest.mark.parametrize("encoding", ["cp500", "cp037"])
def test_non_utf8_text_is_scanned_as_iris_decodes_it(tmp_path: Path, encoding):
    """IRIS decodes non-UTF-8 files with chardet's guess (EBCDIC here) and sends
    the text; the scan decodes them the same way."""
    chardet = pytest.importorskip("chardet")
    text = (
        "//PAYROLL  JOB (ACCT),'NIGHTLY RUN',CLASS=A,MSGCLASS=X\n"
        "//STEP1    EXEC PGM=IEFBR14\n//* credentials for the transfer step\n"
        f"//SYSIN    DD *\n  AWS_ACCESS_KEY_ID={FAKE_KEY_ID}\n  REGION=US-EAST-1\n/*\n"
    )
    data = text.encode(encoding)
    iris_reads = data.decode(chardet.detect(data)["encoding"], errors="replace")
    assert FAKE_KEY_ID in iris_reads, "the sample is one IRIS would send readable"
    (tmp_path / "payroll.jcl").write_bytes(data)
    assert cai.scan_for_secrets(["payroll.jcl"], str(tmp_path)) == [
        ("payroll.jcl", "AWS access key ID")
    ]


def test_a_link_to_an_ignored_file_spelled_in_another_case_is_refused(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "credentials.json").write_text("{}")
    if not (repo / "CREDENTIALS.JSON").exists():
        pytest.skip("case-sensitive file system")
    (repo / "notes.txt").symlink_to(repo / "CREDENTIALS.JSON")
    (repo / "node_modules").mkdir()
    (repo / "lib").symlink_to(repo / "Node_Modules", target_is_directory=True)
    assert cai.codebase_links(repo, ["credentials.json", "node_modules/"]) == [
        "lib",
        "notes.txt",
    ]


@pytest.mark.skipif(
    sys.platform == "win32" or os.geteuid() == 0,
    reason="POSIX modes; root ignores them",
)
@pytest.mark.parametrize("mode", [0o311, 0o644])
def test_an_output_folder_that_cant_be_listed_is_refused(tmp_path: Path, mode):
    repo = tmp_path / "repo"
    hidden = repo / "idx" / "repo" / "sub"
    hidden.mkdir(parents=True)
    (hidden / "tree.txt").write_text("")
    hidden.chmod(mode)
    try:
        assert "can't be listed" in cai.output_dir_problem(repo, repo / "idx" / "repo")
    finally:
        hidden.chmod(0o755)


def test_a_link_spelling_an_ignored_name_in_another_unicode_form_is_refused(
    tmp_path: Path,
):
    import unicodedata

    repo = tmp_path / "repo"
    repo.mkdir()
    nfc = unicodedata.normalize("NFC", "café.env")
    nfd = unicodedata.normalize("NFD", "café.env")
    (repo / nfc).write_text("x")
    if not (repo / nfd).exists() or nfd in os.listdir(repo):
        pytest.skip("file system doesn't fold Unicode normalization")
    (repo / "notes.txt").symlink_to(repo / nfd)
    assert cai.codebase_links(repo, [nfc]) == ["notes.txt"]


# Assembled at runtime so this file holds no credential-shaped literal.
NEW_FORMAT_KEYS = {
    "GitHub token": "github" + "_pat_" + "A1b2" * 16,
    "GitLab token": "gl" + "pat-" + "Zx9_" * 6,
    "Stripe secret key": "sk" + "_live_" + "Q8w7E6r5T4y3U2i1O0p9",
    "Google API key": "AI" + "za" + "B7c6D5e4" * 4 + "F3g",
    "OpenAI API key": "sk-" + "proj-" + "Ab3_" * 12,
    "PGP private key": "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----",
    "PuTTY private key": "PuTTY-User-" + "Key-File-3: ssh-ed25519",
    "Slack webhook": "https://hooks.slack.com/services/"
    + "T0A1B2C3D/B4E5F6G7H/"
    + "x" * 24,
    "password in a URL": "postgres://admin:" + "Wq8!zr0Tq" + "@db.internal:5432/app",
}

# Real passwords may hold characters placeholders use; assembled at runtime too.
URL_PASSWORDS = [
    "postgres://admin:" + "Pa$$w0rd" + "@db.example.com/app",
    "redis://:" + "s3cr3tpw" + "@cache.example.com:6379",
    "mysql://app:" + "%41bcdefgh" + "@db.example.com",
    "https://svc:" + "pw0rd123" + "@[2001:db8::1]:5432/x",
    "amqp://svc:" + "{abc}def" + "@mq.example.com",
    "postgres://admin:" + "$Ummer2024" + "@db.example.com",
]


@pytest.mark.parametrize("url", URL_PASSWORDS)
def test_a_password_in_a_url_is_found_whatever_it_holds(tmp_path: Path, url):
    (tmp_path / "settings.py").write_text(f"DB = {url!r}\n")
    assert cai.scan_for_secrets(["settings.py"], str(tmp_path)) == [
        ("settings.py", "password in a URL")
    ]


@pytest.mark.parametrize("kind", sorted(NEW_FORMAT_KEYS))
def test_the_scan_finds_more_credential_formats(tmp_path: Path, kind):
    (tmp_path / "f.txt").write_text(f"value = {NEW_FORMAT_KEYS[kind]}\n")
    assert cai.scan_for_secrets(["f.txt"], str(tmp_path)) == [("f.txt", kind)]


@pytest.mark.parametrize(
    "text",
    [
        "postgres://user:" + "password" + "@localhost/db",
        "https://user:" + "${TOKEN}" + "@example.com",
        "mysql://root:" + "<password>" + "@db",
        "redis://:" + "$REDIS_PASSWORD" + "@cache",
        "postgres://u:" + "{{db_pass}}" + "@h",
        "postgres://u:" + "{password}" + "@h",
        "postgres://u:" + "%(password)s" + "@h",
        "postgres://u:" + "${DB_PASSWORD:-x}" + "@h",
        "mysql://root:" + "$(DB_PASS)" + "@db",
        "redis://:" + "$password" + "@cache",
        "postgres://u:" + "%{pw}" + "@h",
        "postgres://u:" + "${A}${B}" + "@h",
        "postgres://u:" + "{a}{b}" + "@h",
        "https://host:" + "8080/path" + "@x",
        "see https://docs.aws.amazon.com/x and user@example.com",
    ],
)
def test_placeholder_passwords_in_urls_pass(tmp_path: Path, text):
    (tmp_path / "README.md").write_text(text + "\n")
    assert cai.scan_for_secrets(["README.md"], str(tmp_path)) == []


@pytest.mark.parametrize(
    "text",
    [
        # Many `scheme://user:` starts, none followed by an `@`.
        "ab://:{" * 30_000,
        # `$` names that each placeholder form could take, then no `@` in reach.
        "pg://u:" + "$_" * 40 + "!@h",
    ],
    ids=["many-starts", "ambiguous-names"],
)
def test_the_url_password_scan_stays_fast_on_hostile_text(tmp_path: Path, text):
    import time

    (tmp_path / "f.txt").write_text(text + "\n")
    started = time.monotonic()
    cai.scan_for_secrets(["f.txt"], str(tmp_path))
    assert time.monotonic() - started < 1.0


def test_office_and_pdf_artifacts_are_scanned_as_iris_extracts_them(
    tmp_path: Path, monkeypatch
):
    """The container is compressed; IRIS sends the extracted text."""
    extractors = types.ModuleType("iris.artifacts.artifact_extractors")
    extracted = f"# Source: deck.pptx\nSpeaker notes: key {FAKE_KEY_ID}\n"
    extractors.extract_from_pptx = lambda path, ocr_enabled=False: extracted
    extractors.extract_from_docx = lambda path, ocr_enabled=False: "plain"
    monkeypatch.setitem(sys.modules, extractors.__name__, extractors)
    (tmp_path / "deck.pptx").write_bytes(b"PK\x03\x04 compressed")
    (tmp_path / "memo.docx").write_bytes(b"PK\x03\x04 compressed")
    paths = ["deck.pptx", "memo.docx"]
    assert cai.scan_for_secrets(paths, str(tmp_path)) == []
    assert cai.scan_for_secrets(paths, str(tmp_path), documents=True) == [
        ("deck.pptx", "AWS access key ID")
    ]


def test_artifacts_iris_skips_for_size_are_not_extracted(tmp_path: Path, monkeypatch):
    extractors = types.ModuleType("iris.artifacts.artifact_extractors")
    calls = []
    extractors.extract_from_docx = (
        lambda path, ocr_enabled=False: calls.append(Path(path).name) or ""
    )
    monkeypatch.setitem(sys.modules, extractors.__name__, extractors)
    (tmp_path / "small.docx").write_bytes(b"PK" + b"x" * 10)
    (tmp_path / "large.docx").write_bytes(b"PK" + b"x" * 100)
    paths = ["small.docx", "large.docx"]
    cai.scan_for_secrets(paths, str(tmp_path), documents=True, extract_max_bytes=50)
    assert calls == ["small.docx"]


def test_a_two_link_cycle_is_refused(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "A").mkdir(parents=True)
    (repo / "B").mkdir()
    (repo / "A" / "f.py").write_text("")
    (repo / "A" / "l1").symlink_to(repo / "B", target_is_directory=True)
    (repo / "B" / "l2").symlink_to(repo / "A", target_is_directory=True)
    assert cai.codebase_links(repo, []) == ["A/l1", "B/l2"]


@pytest.mark.parametrize("which", ["root", "parent", "output"])
def test_an_artifact_folder_holding_the_codebase_or_index_is_refused(
    tmp_path: Path, which
):
    repo = tmp_path / "repo"
    out = repo / ".lb_workspace" / "indexing_and_qa" / "repo"
    out.mkdir(parents=True)
    folder = {"root": repo, "parent": tmp_path, "output": repo / ".lb_workspace"}[which]
    assert "is or holds" in cai.artifact_dir_problem(repo, folder, out)
    (repo / ".project_artifacts").mkdir()
    assert cai.artifact_dir_problem(repo, repo / ".project_artifacts", out) is None


def test_an_artifact_folder_starting_with_a_tilde_is_refused(tmp_path: Path):
    assert "doesn't expand" in cai.artifact_dir_problem(tmp_path, "~/docs")


def test_an_artifact_folder_with_a_dotdot_through_a_link_is_refused(
    tmp_path: Path, monkeypatch
):
    """With sub/l -> sub, the OS reads sub/l/.. as the repository itself."""
    repo = tmp_path / "repo"
    (repo / "sub").mkdir(parents=True)
    (repo / "sub" / "l").symlink_to(".", target_is_directory=True)
    monkeypatch.chdir(repo)
    assert os.path.samefile("sub/l/..", repo)
    for value in ("sub/l/..", str(repo / "sub" / "l" / ".."), "docs/../docs"):
        assert "`..` component" in cai.artifact_dir_problem(repo, value)
    (repo / ".project_artifacts").mkdir()
    assert cai.artifact_dir_problem(repo, ".project_artifacts") is None
