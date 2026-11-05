# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Repository content only goes where the engagement has confirmed it may.

WHY THIS FILE EXISTS. Indexing sends source and engagement documents to Amazon
Bedrock, and optionally to Textract and Transcribe. That is the product working as
intended, but an engagement's terms can restrict where client content is processed.
`codebase_artifact_indexing.py` refuses until every destination the config uses is
confirmed, and appends each run's submissions to a local log.

As in the ceiling tests, every test that could reach Bedrock asserts on a spy: the
indexer must not be called. A refusal that is only a return value, with the content
already sent, would pass a test that checked nothing else.
"""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import subprocess
import sys
import types
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO_ROOT / "skills" / "indexing-and-qa"
SCRIPT = SKILL_DIR / "scripts" / "codebase_artifact_indexing.py"
RUNNER = SKILL_DIR / "scripts" / "inq_run_indexing.sh"
SKILL_MD = SKILL_DIR / "SKILL.md"

# The script imports iris at module load. CI does not install it, so stand in a
# placeholder unless another test module already has; every iris-touching function
# is replaced per test below.
if "iris.api" not in sys.modules:
    for _name in ("iris", "iris.api"):
        sys.modules[_name] = types.ModuleType(_name)
    sys.modules["iris"].api = sys.modules["iris.api"]
    sys.modules["iris.api"].index_codebase_artifacts = None

sys.path.insert(0, str(SCRIPT.parent))
import codebase_artifact_indexing as cai  # noqa: E402


MODELS = {
    "file_summarizer": {
        "models": [
            {"model_id": "us.anthropic.haiku", "region": "us-west-2"},
            {"model_id": "us.anthropic.haiku", "region": "us-east-1"},
        ]
    },
    "orchestrator": {"model_id": "us.anthropic.sonnet", "region": "us-east-1"},
    "file_identifier": {"model_id": "us.anthropic.haiku", "region": "us-east-1"},
}


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "a.py").write_text("print('a')\n", encoding="utf-8")
    (root / "src" / "b.py").write_text("print('b')\n", encoding="utf-8")
    return root


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, repo: Path):
    """A config on disk, IRIS stood in, and a spy where the indexer would be."""
    state: dict[str, Any] = {
        "config": {"codebase_dir": str(repo), "model_configuration": MODELS},
        "files": ["src/a.py", "src/b.py"],
        "index_calls": [],
        "principal": "principal-a",
    }
    # The confirmation lives in the user's state directory; keep it in the test's.
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "user-config"))
    monkeypatch.setattr(cai, "caller_principal", lambda: state["principal"])
    config_path = tmp_path / "inq_config.yaml"
    config_path.write_text(yaml.safe_dump({"codebase_dir": str(repo)}), "utf-8")
    state["config_path"] = config_path

    monkeypatch.setattr(cai, "load_iris_config", lambda path: state["config"])
    monkeypatch.setattr(cai, "default_aws_region", lambda: "us-west-2")

    def measure(config_path, mode, max_files, max_artifacts):
        return cai.ScopeReport(
            config_path=Path(config_path),
            codebase_dir=str(repo),
            mode=mode,
            ignore_pattern_count=0,
            model_pairs=2,
            regions=["us-east-1", "us-west-2"],
            max_files=max_files,
            max_artifacts=max_artifacts,
            artifact_max_workers=4,
            files_to_process=len(state["files"]),
            total_files=len(state["files"]),
            file_paths=list(state["files"]),
        )

    monkeypatch.setattr(cai, "measure_scope", measure)

    class Result:
        status = "update_complete"
        message = "done"
        processed_files = ["src/a.py", "src/b.py"]

    def fake_index(config_path: str, mode: str) -> dict[str, Any]:
        state["index_calls"].append(mode)
        return {"codebase_result": Result(), "artifact_result": None}

    monkeypatch.setattr(cai, "index_codebase_artifacts", fake_index)
    return state


def confirmation_file(repo: Path) -> Path:
    return cai.confirmation_path(str(repo))


def log_entries(repo: Path) -> list[dict[str, Any]]:
    path = repo / cai.TRANSMISSION_LOG_REL
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def confirm(env: dict[str, Any], basis: str = "SOW 4.2") -> int:
    return cai.confirm_data_handling(str(env["config_path"]), basis)


# ------------------------------------------------------------ destinations


def test_every_bedrock_model_region_pair_is_a_destination():
    keys = [d.key for d in cai.resolve_destinations({"model_configuration": MODELS})]
    assert keys == [
        "bedrock:us.anthropic.haiku@us-east-1",
        "bedrock:us.anthropic.haiku@us-west-2",
        "bedrock:us.anthropic.sonnet@us-east-1",
    ]


def test_an_inference_profile_destination_names_where_it_may_be_processed():
    models = {
        "file_summarizer": {
            "models": [
                {"model_id": "global.anthropic.haiku", "region": "ap-south-1"},
                {"model_id": "eu.anthropic.haiku", "region": "eu-west-1"},
                {"model_id": "anthropic.haiku", "region": "us-east-1"},
            ]
        }
    }
    details = {
        d.detail for d in cai.resolve_destinations({"model_configuration": models})
    }
    assert details == {
        "global.anthropic.haiku in ap-south-1 (may be processed in "
        "any commercial AWS region)",
        "eu.anthropic.haiku in eu-west-1 (may be processed in any EU " "region)",
        "anthropic.haiku in us-east-1",
    }


@pytest.mark.parametrize(
    "model_id, scope",
    [
        ("anthropic.claude-haiku-4-5-20251001-v1:0", None),
        ("us.anthropic.claude-haiku-4-5-20251001-v1:0", "any US region"),
        ("zz.anthropic.claude-haiku-4-5-20251001-v1:0", "an unknown set of regions"),
        (
            "arn:aws:bedrock:us-east-1:111122223333:inference-profile/"
            "global.anthropic.claude-haiku-4-5-20251001-v1:0",
            "any commercial AWS region",
        ),
        (
            "arn:aws:bedrock:us-east-1::foundation-model/"
            "anthropic.claude-haiku-4-5-20251001-v1:0",
            None,
        ),
        (
            "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/abc",
            "an unknown set of regions (an application inference profile)",
        ),
        (
            "arn:aws:bedrock:us-east-1:111122223333:provisioned-model/abc",
            "an unknown set of regions",
        ),
        (
            "arn:aws:bedrock:us-east-1:111122223333:inference-profile/abc",
            "an unknown set of regions",
        ),
    ],
)
def test_the_scope_of_each_model_id_form(model_id, scope):
    assert cai.profile_scope(model_id) == scope


def test_the_template_defaults_keep_indexing_in_the_united_states():
    import yaml

    template = (
        Path(__file__).resolve().parents[2]
        / "skills/indexing-and-qa/templates/inq_config_template.yaml"
    )
    models = yaml.safe_load(template.read_text())["model_configuration"]
    ids = [m["model_id"] for m in models["file_summarizer"]["models"]]
    ids += [models[s]["model_id"] for s in ("orchestrator", "file_identifier")]
    assert ids and all(i.startswith("us.") for i in ids)


def test_qa_models_are_included_and_labelled():
    """Q&A sends indexed excerpts to these at query time; the terms cover them too."""
    dests = cai.resolve_destinations({"model_configuration": MODELS})
    sonnet = next(d for d in dests if "sonnet" in d.key)
    assert sonnet.used_for == "q&a"


def test_textract_is_a_destination_only_when_it_is_the_ocr_provider(monkeypatch):
    monkeypatch.setattr(cai, "default_aws_region", lambda: "eu-west-1")
    base = {"model_configuration": MODELS, "artifact_dir": "/a"}
    llm = cai.resolve_destinations({**base, "artifact_ocr_enabled": True})
    textract = cai.resolve_destinations(
        {**base, "artifact_ocr_enabled": True, "artifact_ocr_provider": "textract"}
    )
    assert not any(d.service == "amazon-textract" for d in llm)
    assert "textract@eu-west-1" in [d.key for d in textract]


def test_transcribe_is_a_destination_when_transcription_is_on():
    dests = cai.resolve_destinations(
        {
            "model_configuration": MODELS,
            "artifact_dir": "/a",
            "artifact_transcription_enabled": True,
            "artifact_transcribe_s3_bucket": "engagement-bucket",
        }
    )
    assert "transcribe:s3://engagement-bucket" in [d.key for d in dests]


def test_artifact_services_are_not_destinations_without_an_artifact_dir():
    dests = cai.resolve_destinations(
        {
            "model_configuration": MODELS,
            "artifact_ocr_enabled": True,
            "artifact_ocr_provider": "textract",
            "artifact_transcription_enabled": True,
        }
    )
    assert all(d.service == "amazon-bedrock" for d in dests)


# ------------------------------------------------------------ the gate


def test_an_unconfirmed_engagement_never_reaches_the_indexer(env, repo):
    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "data_handling"
    assert env["index_calls"] == [], "content was sent despite the refusal"
    assert "us.anthropic.sonnet in us-east-1" in result["error"]
    assert "--confirm-data-handling" in result["error"]
    assert log_entries(repo) == [], "a refused run must not log a transmission"


def test_confirming_records_the_measured_destinations_and_sends_nothing(env, repo):
    assert confirm(env) == 0
    assert env["index_calls"] == []

    record = json.loads(confirmation_file(repo).read_text())
    assert record["basis"] == "SOW 4.2"
    assert [d["key"] for d in record["destinations"]] == [
        d.key for d in cai.resolve_destinations(env["config"])
    ]


def test_clearing_an_unsafe_artifact_folder_is_refused_at_confirmation(
    env, repo, monkeypatch
):
    (repo / "sub").mkdir()
    (repo / "sub" / "l").symlink_to(".", target_is_directory=True)
    env["config"] = dict(env["config"], artifact_dir="sub/l/..")
    api = types.ModuleType("iris.api")
    api.resolve_artifact_dir = lambda config: config["artifact_dir"]
    api.construct_output_dir = lambda codebase_dir: str(
        Path(codebase_dir) / ".lb_workspace" / "indexing_and_qa" / "repo"
    )
    monkeypatch.setitem(sys.modules, "iris.api", api)
    monkeypatch.chdir(repo)
    rc = cai.confirm_data_handling(
        str(env["config_path"]), "SOW 4.2", artifact_classification="internal docs"
    )
    assert rc == 1
    assert not confirmation_file(repo).exists()


def test_a_confirmed_engagement_indexes_and_logs_what_it_submitted(env, repo):
    confirm(env)
    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "update_complete"
    assert env["index_calls"] == ["codebase"]

    started, finished = log_entries(repo)
    assert started["event"] == "run_started" and finished["event"] == "run_finished"
    assert started["run_id"] == finished["run_id"]
    assert started["measured"] is True
    assert started["artifacts"] is None, "codebase mode sends no artifacts"
    by_path = {f["path"]: f for f in started["files"]}
    content = (repo / "src" / "a.py").read_bytes()
    assert by_path["src/a.py"]["sha256"] == hashlib.sha256(content).hexdigest()
    assert by_path["src/a.py"]["bytes"] == len(content)
    assert "bedrock:us.anthropic.sonnet@us-east-1" in started["destinations"]
    assert finished["status"] == "update_complete" and finished["processed"] == 2


def test_a_new_destination_after_confirmation_is_refused(env, repo):
    """Adding a region is exactly the change the terms may not allow."""
    confirm(env)
    env["config"] = json.loads(json.dumps(env["config"]))
    env["config"]["model_configuration"]["file_summarizer"]["models"].append(
        {"model_id": "eu.anthropic.haiku", "region": "eu-west-1"}
    )

    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "data_handling"
    assert env["index_calls"] == []
    assert "eu-west-1" in result["error"]
    assert "us-west-2" not in result["error"], "only the new destination is at issue"


def test_a_narrower_config_stays_confirmed(env, repo):
    confirm(env)
    env["config"] = json.loads(json.dumps(env["config"]))
    env["config"]["model_configuration"]["file_summarizer"]["models"].pop()

    assert cai.run_indexing(str(env["config_path"]), "codebase")["status"] == (
        "update_complete"
    )


git_required = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@git_required
def test_a_local_confirmation_in_a_git_repo_is_accepted(env, repo):
    git(repo, "init", "-q")
    assert confirm(env) == 0

    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "update_complete"
    assert env["index_calls"] == ["codebase"]


def test_the_confirmation_is_stored_outside_the_repository(env, repo, tmp_path):
    assert confirm(env) == 0

    path = confirmation_file(repo)
    assert path.is_file()
    assert repo not in path.parents
    assert (tmp_path / "user-config" / "launchbridge") in path.parents


@pytest.mark.parametrize(
    "name",
    ["data_handling_confirmation.json", "Data_Handling_Confirmation.json"],
)
def test_a_record_inside_the_repository_is_never_consent(env, repo, name):
    """Whatever its name or case, a file that came with the repository confirms nothing."""
    planted = repo / ".lb_workspace" / "config" / name
    planted.parent.mkdir(parents=True, exist_ok=True)
    assert confirm(env) == 0
    shutil.copy(confirmation_file(repo), planted)
    confirmation_file(repo).unlink()

    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "data_handling"
    assert env["index_calls"] == [], "content was sent on a record from the repository"


def test_a_confirmation_by_another_principal_is_not_accepted(env, repo):
    assert confirm(env) == 0
    env["principal"] = "principal-b"

    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "data_handling"
    assert env["index_calls"] == []


def test_a_confirmation_for_another_repository_path_is_not_accepted(
    env, repo, tmp_path
):
    assert confirm(env) == 0
    other = tmp_path / "other-repo"
    (other / "src").mkdir(parents=True)
    env["config"]["codebase_dir"] = str(other)

    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "data_handling"
    assert env["index_calls"] == []


def test_without_an_aws_identity_nothing_is_confirmed_or_recorded(env, repo):
    env["principal"] = None

    assert confirm(env) == 1
    assert not confirmation_file(repo).exists()
    assert cai.run_indexing(str(env["config_path"]), "codebase")["status"] == (
        "data_handling"
    )
    assert env["index_calls"] == []


@pytest.mark.parametrize(
    "content",
    ["{not json", json.dumps({"version": 99, "destinations": []}), json.dumps([])],
)
def test_an_unreadable_confirmation_confirms_nothing(env, repo, content):
    path = confirmation_file(repo)
    path.parent.mkdir(parents=True)
    path.write_text(content)

    assert cai.run_indexing(str(env["config_path"]), "codebase")["status"] == (
        "data_handling"
    )
    assert env["index_calls"] == []


def test_unresolvable_destinations_refuse(env, monkeypatch):
    def broken(path):
        raise AttributeError("iris changed")

    monkeypatch.setattr(cai, "load_iris_config", broken)
    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "data_handling"
    assert env["index_calls"] == []


ROLE = "arn:aws:iam::444455556666:role/Other"


def _super_profile(config):
    config["use_super_profile"] = True


def _orchestrator_role(config):
    config["model_configuration"]["orchestrator"]["ROLE_ARN"] = ROLE


def _summarizer_role(config):
    config["model_configuration"]["file_summarizer"]["models"][0]["role_arn"] = ROLE


def _top_level_role(config):
    config["ROLE_ARN"] = ROLE


CROSS_ACCOUNT = [_super_profile, _orchestrator_role, _summarizer_role, _top_level_role]


@pytest.mark.parametrize("add", CROSS_ACCOUNT)
def test_a_cross_account_role_can_be_neither_confirmed_nor_indexed(env, repo, add):
    env["config"] = copy.deepcopy(env["config"])
    add(env["config"])

    assert confirm(env) == 1
    assert not confirmation_file(repo).exists(), "no record for a role it can't name"
    result = cai.run_indexing(str(env["config_path"]), "codebase")
    assert result["status"] == "data_handling"
    assert "another IAM role" in result["error"]
    assert env["index_calls"] == []


def test_a_cross_account_role_added_after_confirmation_is_refused(env, repo):
    assert confirm(env) == 0
    env["config"] = dict(env["config"], use_super_profile=True)

    result = cai.run_indexing(str(env["config_path"]), "codebase")
    assert result["status"] == "data_handling"
    assert env["index_calls"] == []


REFUSED_SETTINGS = {
    "web_search": True,
    "context_file": "/home/user/.aws/credentials",
    "mcp_servers": {"x": {"enabled": True, "command": "sh"}},
    "output_dir": "/opt/elsewhere",
}


@pytest.mark.parametrize("key", REFUSED_SETTINGS)
def test_a_refused_setting_can_be_neither_confirmed_nor_indexed(env, repo, key):
    env["config"] = dict(env["config"], **{key: REFUSED_SETTINGS[key]})

    assert confirm(env) == 1
    assert not confirmation_file(repo).exists()
    result = cai.run_indexing(str(env["config_path"]), "codebase")
    assert result["status"] == "data_handling"
    assert key in result["error"]
    assert env["index_calls"] == []


def test_use_super_profile_false_is_not_a_cross_account_setting():
    assert cai.cross_account_settings({"use_super_profile": False}) == []


# ------------------------------------------------------------ the log


def test_an_unwritable_log_refuses_before_sending(env, repo, monkeypatch):
    confirm(env)

    def cannot_write(path, entry):
        raise OSError("read-only file system")

    monkeypatch.setattr(cai, "append_log", cannot_write)
    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "data_handling"
    assert env["index_calls"] == [], "an unrecorded send must not happen"
    assert "transmission log" in result["error"]


def test_the_finish_is_logged_even_when_the_indexer_raises(env, repo, monkeypatch):
    confirm(env)

    def exploding(config_path, mode):
        raise RuntimeError("throttled")

    monkeypatch.setattr(cai, "index_codebase_artifacts", exploding)
    result = cai.run_indexing(str(env["config_path"]), "codebase")

    assert result["status"] == "error"
    started, finished = log_entries(repo)
    assert finished["run_id"] == started["run_id"]
    assert finished["status"] == "error"


def test_a_file_that_vanished_is_logged_without_a_hash(env, repo):
    confirm(env)
    env["files"] = ["src/a.py", "src/gone.py"]
    cai.run_indexing(str(env["config_path"]), "codebase")

    started = log_entries(repo)[0]
    gone = next(f for f in started["files"] if f["path"] == "src/gone.py")
    assert gone["sha256"] is None and gone["bytes"] is None


def test_runs_append_rather_than_overwrite(env, repo):
    confirm(env)
    cai.run_indexing(str(env["config_path"]), "codebase")
    cai.run_indexing(str(env["config_path"]), "codebase")
    assert [e["event"] for e in log_entries(repo)] == [
        "run_started",
        "run_finished",
        "run_started",
        "run_finished",
    ]


# ------------------------------------------------------------ CLI and docs


def run_main(monkeypatch, argv: list[str]) -> int:
    monkeypatch.setattr(sys, "argv", ["codebase_artifact_indexing.py", *argv])
    return cai.main()


def test_an_unconfirmed_run_exits_four(env, monkeypatch):
    code = run_main(monkeypatch, ["--config", str(env["config_path"])])
    assert code == 4
    assert env["index_calls"] == []


def test_confirm_via_cli_then_index(env, monkeypatch, repo):
    assert (
        run_main(
            monkeypatch,
            ["--config", str(env["config_path"]), "--confirm-data-handling"],
        )
        == 0
    )
    assert env["index_calls"] == []
    assert run_main(monkeypatch, ["--config", str(env["config_path"])]) == 0
    assert env["index_calls"] == ["codebase"]


def test_report_scope_says_when_destinations_are_unconfirmed(env, monkeypatch, capsys):
    monkeypatch.setattr(cai, "read_ceilings", lambda path: (5000, 500))
    code = run_main(
        monkeypatch, ["--config", str(env["config_path"]), "--report-scope"]
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "NOT CONFIRMED" in out
    assert "us.anthropic.sonnet in us-east-1" in out
    assert env["index_calls"] == []


def test_the_runner_passes_the_confirmation_flags_through():
    text = RUNNER.read_text()
    assert "--confirm-data-handling)" in text
    assert "--basis)" in text
    assert '"${EXTRA_ARGS[@]}"' in text


def test_the_skill_tells_the_agent_what_exit_four_means():
    text = SKILL_MD.read_text()
    assert "exits 4" in text
    assert "--confirm-data-handling" in text


# ------------------------------------------------------------ principal


def _fake_sts(monkeypatch, identity=None, error=None):
    class Client:
        def get_caller_identity(self):
            if error:
                raise error
            return identity

    monkeypatch.setattr(cai, "sts_client", lambda: Client())


def test_two_sessions_of_the_same_role_are_the_same_principal(monkeypatch):
    base = "arn:aws:sts::111122223333:assumed-role/Engineer/"
    _fake_sts(monkeypatch, {"Account": "111122223333", "Arn": base + "alice-1"})
    first = cai.caller_principal()
    _fake_sts(monkeypatch, {"Account": "111122223333", "Arn": base + "alice-2"})

    assert first is not None
    assert cai.caller_principal() == first


def test_another_account_or_role_is_a_different_principal(monkeypatch):
    arn = "arn:aws:sts::{}:assumed-role/{}/s"
    _fake_sts(
        monkeypatch,
        {"Account": "111122223333", "Arn": arn.format("111122223333", "Engineer")},
    )
    engineer = cai.caller_principal()
    _fake_sts(
        monkeypatch,
        {"Account": "444455556666", "Arn": arn.format("444455556666", "Engineer")},
    )
    other_account = cai.caller_principal()
    _fake_sts(
        monkeypatch,
        {"Account": "111122223333", "Arn": arn.format("111122223333", "Admin")},
    )
    other_role = cai.caller_principal()

    assert len({engineer, other_account, other_role}) == 3


def test_no_identity_when_sts_fails(monkeypatch):
    _fake_sts(monkeypatch, error=RuntimeError("no credentials"))
    assert cai.caller_principal() is None


def test_the_sts_client_has_short_timeouts(monkeypatch):
    made = {}

    class Config:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    boto3 = types.ModuleType("boto3")
    boto3.client = lambda service, config: made.update(service=service, config=config)
    botocore = types.ModuleType("botocore")
    botocore.config = types.ModuleType("botocore.config")
    botocore.config.Config = Config
    monkeypatch.setitem(sys.modules, "boto3", boto3)
    monkeypatch.setitem(sys.modules, "botocore", botocore)
    monkeypatch.setitem(sys.modules, "botocore.config", botocore.config)

    cai.sts_client()

    assert made["service"] == "sts"
    assert made["config"].kwargs["connect_timeout"] <= 10
    assert made["config"].kwargs["read_timeout"] <= 10


@pytest.mark.parametrize("value", ["", "relative/config", "."])
def test_a_relative_xdg_config_home_is_ignored(monkeypatch, tmp_path, value):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", value)
    assert cai.state_dir() == tmp_path / ".config" / "launchbridge"


def test_an_absolute_xdg_config_home_is_used(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    assert cai.state_dir() == tmp_path / "xdg" / "launchbridge"


def test_a_state_directory_inside_the_repository_is_refused(env, repo, monkeypatch):
    """An absolute XDG_CONFIG_HOME can point into the repository; no record there counts."""
    assert confirm(env) == 0
    inside = repo / ".lb_workspace" / "xdg"
    shutil.copytree(confirmation_file(repo).parents[3], inside, dirs_exist_ok=True)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(inside))
    assert confirmation_file(
        repo
    ).is_file(), "the copied record is where it would be read"

    result = cai.run_indexing(str(env["config_path"]), "codebase")
    assert result["status"] == "data_handling"
    assert env["index_calls"] == []
    assert confirm(env) == 1, "and no record is written there"
