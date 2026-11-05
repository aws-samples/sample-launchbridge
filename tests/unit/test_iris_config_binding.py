# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""IRIS runs with the user's model and region list, or not at all.

IRIS (pinned commit) reads its config once in several modules, when they are
imported, before the user's config path is set; those modules keep IRIS's packaged
template. The indexing script and the MCP launcher both bind one merged config (the
user's file over the template) into every such module, and refuse to run when any
IRIS module still holds a different config. CI does not install IRIS, so these
tests stand in fake IRIS modules shaped like the real ones.
"""

import importlib.util
import os
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

if "iris.api" not in sys.modules:
    for _name in ("iris", "iris.api"):
        sys.modules[_name] = types.ModuleType(_name)
    sys.modules["iris"].api = sys.modules["iris.api"]
    sys.modules["iris.api"].index_codebase_artifacts = None
sys.path.insert(0, str(ROOT / "skills" / "indexing-and-qa" / "scripts"))
import codebase_artifact_indexing as cai  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "mcp_v1_compat_binding",
    ROOT / "skills" / "lb-setup" / "scripts" / "mcp_v1_compat.py",
)
compat = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(compat)

# The module-level config captures in the pinned IRIS commit. Written out here, not
# read from either script, so dropping an entry from a script fails these tests.
EXPECTED_CAPTURES = (
    ("iris.summarize.file_summarizer", "_DEFAULT_CONFIG"),
    ("iris.agents.file_retrieval_agent", "_DEFAULT_CONFIG"),
    ("iris.agents.artifact_retrieval_agent", "_DEFAULT_CONFIG"),
    ("iris.agents.code_search_tool", "_DEFAULT_CONFIG"),
    ("iris.file_system.file_utils", "CONFIG"),
)

TEMPLATE_PAIRS = [
    {"model_id": f"template-{i}", "region": "eu-west-1"} for i in range(10)
]
TEMPLATE = {
    "codebase_dir": "/path/to/your/codebase",
    "context_window_size": 200000,
    "max_file_size": 2000000,
    "model_configuration": {
        "file_summarizer": {"models": TEMPLATE_PAIRS},
        "file_identifier": {"model_id": "template-ident", "region": "us-east-2"},
        "orchestrator": {"model_id": "template-orch", "region": "us-east-1"},
    },
}
USER = {
    "codebase_dir": "/repo",
    "mcp_enabled_tools": ["codebase_artifact_query"],
    "model_configuration": {
        "file_summarizer": {
            "models": [{"model_id": "user-model", "region": "us-west-2"}]
        },
        "file_identifier": {"model_id": "user-ident", "region": "us-west-2"},
        "orchestrator": {"model_id": "user-orch", "region": "us-west-2"},
    },
}


def _deep_merge(base, override):
    result = dict(base)
    for key, value in override.items():
        if isinstance(result.get(key), dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


@pytest.fixture
def fake_iris(monkeypatch):
    """IRIS modules with template copies captured at import, as in the pinned commit."""
    utils = types.ModuleType("iris.utils.utils")
    utils._cached_config = None
    utils.set_config_path = lambda path: setattr(utils, "_cached_config", None)
    utils.load_default_config = lambda: dict(USER)
    utils.load_template_config = lambda: _deep_merge(TEMPLATE, {})
    utils.deep_merge = _deep_merge
    modules = {
        "iris": types.ModuleType("iris"),
        "iris.utils": types.ModuleType("iris.utils"),
        "iris.utils.utils": utils,
        "iris.api": sys.modules["iris.api"],
    }
    modules["iris.utils"].utils = utils
    for name, attr in EXPECTED_CAPTURES:
        module = types.ModuleType(name)
        setattr(module, attr, _deep_merge(TEMPLATE, {}))
        modules[name] = module
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    return modules


def summarizer_pairs(config):
    return [
        (m["model_id"], m["region"])
        for m in config["model_configuration"]["file_summarizer"]["models"]
    ]


def test_indexing_binds_the_users_list_into_every_captured_module(fake_iris):
    merged = cai.bind_iris_config(dict(USER))

    for name, attr in cai.IRIS_CAPTURED_CONFIGS:
        assert getattr(fake_iris[name], attr) is merged, name
    assert fake_iris["iris.utils.utils"]._cached_config is merged
    assert summarizer_pairs(merged) == [("user-model", "us-west-2")]
    assert merged["model_configuration"]["file_identifier"]["model_id"] == "user-ident"
    assert merged["context_window_size"] == 200000, "IRIS defaults are kept"
    assert merged["codebase_dir"] == "/repo"


def test_the_gate_sees_exactly_what_iris_will_use(fake_iris):
    merged = cai.bind_iris_config(dict(USER))
    summarizer = fake_iris["iris.summarize.file_summarizer"]._DEFAULT_CONFIG

    gate = {
        d.detail for d in cai.resolve_destinations(merged) if d.used_for == "indexing"
    }
    assert gate == {f"{m} in {r}" for m, r in summarizer_pairs(summarizer)}


def test_a_section_the_user_omits_is_shown_with_its_template_default(fake_iris):
    user = {
        "codebase_dir": "/repo",
        "model_configuration": {
            "file_summarizer": USER["model_configuration"]["file_summarizer"]
        },
    }
    merged = cai.bind_iris_config(user)

    details = {d.detail for d in cai.resolve_destinations(merged)}
    assert "template-ident in us-east-2" in details


def test_an_unknown_capture_is_refused(fake_iris, monkeypatch):
    stray = types.ModuleType("iris.future")
    stray.SETTINGS = _deep_merge(TEMPLATE, {})
    monkeypatch.setitem(sys.modules, "iris.future", stray)

    with pytest.raises(cai.IrisConfigMismatch, match="iris.future.SETTINGS"):
        cai.bind_iris_config(dict(USER))


def test_a_captured_model_section_alone_is_refused(fake_iris, monkeypatch):
    stray = types.ModuleType("iris.future")
    stray.MODELS = _deep_merge(TEMPLATE, {})["model_configuration"]
    monkeypatch.setitem(sys.modules, "iris.future", stray)

    with pytest.raises(cai.IrisConfigMismatch, match="iris.future.MODELS"):
        cai.bind_iris_config(dict(USER))


def test_indexing_refuses_when_the_binding_fails(monkeypatch, tmp_path):
    calls = []
    config = tmp_path / "inq_config.yaml"
    config.write_text("codebase_dir: /repo\n")

    def mismatch(path):
        raise cai.IrisConfigMismatch("iris.future.SETTINGS")

    monkeypatch.setattr(cai, "load_iris_config", mismatch)
    monkeypatch.setattr(cai, "index_codebase_artifacts", lambda **k: calls.append(k))
    monkeypatch.setattr(cai, "caller_principal", lambda: "principal-a")

    result = cai.run_indexing(str(config), "codebase")

    assert result["status"] == "data_handling"
    assert calls == []


def test_launcher_binds_the_config_file_into_every_captured_module(fake_iris):
    compat.bind_iris_config(
        ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
    )

    summarizer = fake_iris["iris.summarize.file_summarizer"]._DEFAULT_CONFIG
    for name, attr in compat.IRIS_CAPTURED_CONFIGS:
        assert getattr(fake_iris[name], attr) is summarizer, name
    identifier = fake_iris["iris.agents.file_retrieval_agent"]._DEFAULT_CONFIG
    assert (
        identifier["model_configuration"]["file_identifier"]["model_id"] == "user-ident"
    )


def test_launcher_refuses_to_start_with_an_unknown_capture(fake_iris, monkeypatch):
    stray = types.ModuleType("iris.future")
    stray.SETTINGS = _deep_merge(TEMPLATE, {})
    monkeypatch.setitem(sys.modules, "iris.future", stray)

    with pytest.raises(compat.MCPCompatibilityError, match="iris.future.SETTINGS"):
        compat.bind_iris_config(
            ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
        )


def test_both_scripts_bind_the_known_modules():
    assert cai.IRIS_CAPTURED_CONFIGS == EXPECTED_CAPTURES
    assert compat.IRIS_CAPTURED_CONFIGS == EXPECTED_CAPTURES


def test_a_capture_in_the_server_package_is_refused(fake_iris, monkeypatch):
    stray = types.ModuleType("iris_mcp.mcp_server")
    stray.CONFIG = _deep_merge(TEMPLATE, {})
    monkeypatch.setitem(sys.modules, "iris_mcp.mcp_server", stray)

    with pytest.raises(compat.MCPCompatibilityError, match="iris_mcp.mcp_server"):
        compat.bind_iris_config(
            ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
        )
    with pytest.raises(cai.IrisConfigMismatch, match="iris_mcp.mcp_server"):
        cai.bind_iris_config(dict(USER))


# ------------------------------------------------- Q&A data-handling confirmation


@pytest.fixture
def state(monkeypatch, tmp_path):
    """A user state directory and one AWS principal shared by both scripts."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "user-config"))
    who = {"principal": "principal-a"}
    monkeypatch.setattr(cai, "caller_principal", lambda: who["principal"])
    monkeypatch.setattr(compat, "caller_principal", lambda: who["principal"])
    return who


def confirm(config):
    """Record a confirmation as the indexing script's --confirm-data-handling does."""
    cai.write_confirmation(
        cai.confirmation_path(config["codebase_dir"]),
        cai.resolve_destinations(config),
        "test",
        principal=cai.caller_principal(),
        codebase_dir=config["codebase_dir"],
    )


def launcher_config(fake_iris):
    return compat.bind_iris_config(
        ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
    )


def test_qa_starts_when_indexing_confirmed_its_destinations(fake_iris, state):
    config = launcher_config(fake_iris)
    confirm(config)
    compat.require_qa_confirmation(config)


def test_qa_refuses_without_a_confirmation(fake_iris, state):
    with pytest.raises(compat.MCPCompatibilityError, match="user-orch@us-west-2"):
        compat.require_qa_confirmation(launcher_config(fake_iris))


def test_qa_refuses_a_confirmation_by_another_principal(fake_iris, state):
    config = launcher_config(fake_iris)
    confirm(config)
    state["principal"] = "principal-b"
    with pytest.raises(compat.MCPCompatibilityError, match="not confirmed"):
        compat.require_qa_confirmation(config)


def test_qa_refuses_without_an_aws_identity(fake_iris, state):
    config = launcher_config(fake_iris)
    confirm(config)
    state["principal"] = None
    with pytest.raises(compat.MCPCompatibilityError, match="not confirmed"):
        compat.require_qa_confirmation(config)


def test_qa_refuses_a_model_changed_after_confirmation(fake_iris, state):
    config = launcher_config(fake_iris)
    confirm(config)
    config["model_configuration"]["orchestrator"] = {
        "model_id": "other-orch",
        "region": "ap-south-1",
    }
    with pytest.raises(compat.MCPCompatibilityError) as refused:
        compat.require_qa_confirmation(config)
    assert "other-orch@ap-south-1" in str(refused.value)
    assert "user-ident" not in str(refused.value), "only the new destination is named"


def test_qa_refuses_a_record_for_another_repository(fake_iris, state):
    config = launcher_config(fake_iris)
    confirm(dict(config, codebase_dir="/elsewhere"))
    with pytest.raises(compat.MCPCompatibilityError, match="not confirmed"):
        compat.require_qa_confirmation(config)


@pytest.mark.parametrize("content", ["", "{", "[]", '{"version": 99}'])
def test_qa_refuses_an_unreadable_record(fake_iris, state, content):
    config = launcher_config(fake_iris)
    path = compat.confirmation_path(config["codebase_dir"])
    path.parent.mkdir(parents=True)
    path.write_text(content, encoding="utf-8")
    with pytest.raises(compat.MCPCompatibilityError, match="not confirmed"):
        compat.require_qa_confirmation(config)


def test_the_launcher_reads_the_record_where_indexing_writes_it(monkeypatch, tmp_path):
    for value in (str(tmp_path / "xdg"), "relative", ""):
        monkeypatch.setenv("XDG_CONFIG_HOME", value)
        assert compat.confirmation_path("/repo") == cai.confirmation_path("/repo")


def test_the_launcher_checks_the_qa_destinations_indexing_confirms(fake_iris):
    config = launcher_config(fake_iris)
    qa = {d.key for d in cai.resolve_destinations(config) if d.used_for == "q&a"}
    assert compat.qa_destination_keys(config) == qa


def test_both_scripts_fingerprint_a_principal_the_same_way(monkeypatch):
    class Client:
        def get_caller_identity(self):
            return {
                "Account": "111122223333",
                "Arn": "arn:aws:sts::111122223333:assumed-role/Engineer/s",
            }

    monkeypatch.setattr(cai, "sts_client", lambda: Client())
    monkeypatch.setattr(compat, "sts_client", lambda: Client())
    assert compat.caller_principal() == cai.caller_principal() is not None


# ------------------------------------------------- cross-account roles


@pytest.mark.parametrize(
    "extra",
    [
        {"use_super_profile": True},
        {"ROLE_ARN": "arn:aws:iam::444455556666:role/Other"},
    ],
)
def test_qa_refuses_a_cross_account_role_even_when_confirmed(fake_iris, state, extra):
    config = launcher_config(fake_iris)
    confirm(config)
    with pytest.raises(compat.MCPCompatibilityError, match="another IAM role"):
        compat.require_qa_confirmation(dict(config, **extra))


def test_qa_refuses_a_role_in_a_model_section(fake_iris, state):
    config = launcher_config(fake_iris)
    confirm(config)
    config["model_configuration"]["orchestrator"]["ROLE_ARN"] = "arn:aws:iam::x:role/y"
    with pytest.raises(compat.MCPCompatibilityError, match="orchestrator.ROLE_ARN"):
        compat.require_qa_confirmation(config)


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"use_super_profile": False},
        {"use_super_profile": True},
        {"model_configuration": {"orchestrator": {"ROLE_ARN": "r"}}},
        {"model_configuration": {"file_summarizer": {"models": [{"role_arn": "r"}]}}},
        {"a": [{"b": {"Role_Arn": "r"}}], "use_super_profile": "yes"},
    ],
)
def test_both_scripts_flag_the_same_cross_account_settings(config):
    assert compat.cross_account_settings(config) == cai.cross_account_settings(config)


# ------------------------------------------------- the query tool's codebase_dir


@pytest.fixture
def server(monkeypatch, tmp_path):
    """IRIS's MCP server module: a path check and a tool that calls it, as in IRIS."""
    module = types.ModuleType("iris_mcp.mcp_server")

    def validate_codebase_path(path):
        resolved = Path(path).resolve()
        if not resolved.is_dir():
            raise ValueError(f"Path does not exist: {path}")
        return resolved

    def codebase_artifact_query(query, codebase_dir):
        try:
            return f"answered from {module.validate_codebase_path(codebase_dir)}"
        except ValueError as e:
            return f"Invalid path: {e}"

    module.validate_codebase_path = validate_codebase_path
    module.codebase_artifact_query = codebase_artifact_query
    monkeypatch.setitem(sys.modules, "iris_mcp", types.ModuleType("iris_mcp"))
    monkeypatch.setitem(sys.modules, "iris_mcp.mcp_server", module)
    repo = tmp_path / "repo"
    repo.mkdir()
    return module, repo


def test_the_query_tool_answers_for_the_configured_repository(server):
    module, repo = server
    compat.restrict_query_codebase_dir({"codebase_dir": str(repo)})
    assert (
        module.codebase_artifact_query("q", str(repo))
        == f"answered from {repo.resolve()}"
    )


@pytest.mark.parametrize("target", ["other", "home", "parent", "child"])
def test_the_query_tool_refuses_any_other_directory(server, tmp_path, target):
    module, repo = server
    paths = {
        "other": tmp_path / "other-repo",
        "home": Path.home(),
        "parent": tmp_path,
        "child": repo / "src",
    }
    paths[target].mkdir(exist_ok=True)
    compat.restrict_query_codebase_dir({"codebase_dir": str(repo)})

    answer = module.codebase_artifact_query("q", str(paths[target]))
    assert answer.startswith("Invalid path:")
    assert "not the configured repository" in answer


def test_a_symbolic_link_to_the_repository_is_the_repository(server, tmp_path):
    module, repo = server
    link = tmp_path / "link"
    link.symlink_to(repo, target_is_directory=True)
    compat.restrict_query_codebase_dir({"codebase_dir": str(link)})
    assert module.codebase_artifact_query("q", str(repo)).startswith("answered")


def test_restricting_twice_keeps_one_check(server):
    module, repo = server
    compat.restrict_query_codebase_dir({"codebase_dir": str(repo)})
    first = module.validate_codebase_path
    compat.restrict_query_codebase_dir({"codebase_dir": str(repo)})
    assert module.validate_codebase_path is first


def test_the_launcher_refuses_when_iris_has_no_path_check(server):
    module, repo = server
    del module.validate_codebase_path
    with pytest.raises(compat.MCPCompatibilityError, match="validate_codebase_path"):
        compat.restrict_query_codebase_dir({"codebase_dir": str(repo)})


# ------------------------------------------------- settings LaunchBridge refuses

import yaml  # noqa: E402

BASE = {
    "codebase_dir": "/repo",
    "output_dir": ".lb_workspace/indexing_and_qa",
    "model_configuration": {
        "file_summarizer": {"models": [{"model_id": "m", "region": "us-west-2"}]},
        "orchestrator": {"model_id": "o", "region": "us-east-1"},
        "file_identifier": {"model_id": "i", "region": "eu-central-1"},
    },
}


def _with(**extra):
    config = yaml.safe_load(yaml.safe_dump(BASE))
    config.update(extra)
    return config


def _with_model(section, entry):
    config = _with()
    if section == "file_summarizer":
        config["model_configuration"]["file_summarizer"]["models"] = [entry]
    else:
        config["model_configuration"][section] = entry
    return config


REFUSED = {
    "web search": _with(web_search=True),
    "context file": _with(context_file="/home/u/.aws/credentials"),
    "tool consent bypass": _with(bypass_tool_consent=True),
    "monitoring logs": _with(include_monitoring=True),
    "an enabled MCP server": _with(
        mcp_servers={"x": {"enabled": True, "command": "sh", "args": ["-c", "id"]}}
    ),
    "an MCP server that isn't a mapping": _with(mcp_servers={"x": "sh"}),
    "MCP servers that aren't a mapping": _with(mcp_servers=["sh"]),
    "an unknown key": _with(new_iris_feature=True),
    "an absolute output_dir": _with(output_dir="/opt/out"),
    "an output_dir above the repository": _with(output_dir="../shared"),
    "a region that is a host name": _with_model(
        "file_summarizer",
        {"model_id": "m", "region": "us-east-1.amazonaws.com.evil.example#"},
    ),
    "a blank region": _with_model("orchestrator", {"model_id": "o", "region": ""}),
    "no region": _with_model("file_identifier", {"model_id": "i"}),
    "no model_id": _with_model("orchestrator", {"region": "us-east-1"}),
    "a model entry that isn't a mapping": _with_model("orchestrator", "o"),
    "a cross-account role": _with(use_super_profile=True),
}


@pytest.mark.parametrize("name", REFUSED)
def test_both_scripts_refuse_the_same_settings(name):
    config = REFUSED[name]
    problems = cai.unsafe_settings(config)
    assert problems, f"{name} was not refused"
    assert compat.unsafe_settings(config) == problems


def test_a_plain_config_has_no_refused_settings():
    assert cai.unsafe_settings(_with()) == []
    assert compat.unsafe_settings(_with()) == []


@pytest.mark.parametrize(
    "region",
    ["us-east-1", "eu-central-1", "ap-southeast-2", "us-gov-west-1", "il-central-1"],
)
def test_real_aws_regions_are_accepted(region):
    config = _with_model("orchestrator", {"model_id": "o", "region": region})
    assert cai.unsafe_settings(config) == []


def test_launchbridges_own_template_passes(tmp_path):
    template = (
        ROOT / "skills" / "indexing-and-qa" / "templates" / "inq_config_template.yaml"
    )
    config = yaml.safe_load(template.read_text())
    config["codebase_dir"] = str(tmp_path)
    assert cai.unsafe_settings(config) == []


def test_iris_template_defaults_are_forced_safe():
    """IRIS's own template turns web search and tool-consent bypass on."""
    iris_defaults = _with(
        web_search=True,
        bypass_tool_consent=True,
        context_file="/path/to/additional/context/file.txt",
        mcp_servers={"aws_documentation": {"enabled": True, "command": "uvx"}},
    )
    forced = cai.force_safe_settings(iris_defaults)

    assert cai.unsafe_settings(forced) == []
    assert forced["web_search"] is False and forced["bypass_tool_consent"] is False
    assert forced["context_file"] == ""
    assert forced["mcp_servers"]["aws_documentation"]["enabled"] is False
    assert iris_defaults["web_search"] is True, "the input is not changed"
    assert compat.force_safe_settings(iris_defaults) == forced


def test_iris_runs_with_the_forced_config(fake_iris):
    user = dict(USER)
    fake_iris["iris.utils.utils"].load_template_config = lambda: _deep_merge(
        TEMPLATE, {"web_search": True, "bypass_tool_consent": True}
    )
    merged = cai.bind_iris_config(user)
    assert merged["web_search"] is False
    assert fake_iris["iris.agents.file_retrieval_agent"]._DEFAULT_CONFIG is merged


@pytest.mark.parametrize(
    "extra", [{"web_search": True}, {"mcp_servers": {"x": {"enabled": True}}}]
)
def test_binding_refuses_a_refused_setting_in_the_users_file(fake_iris, extra):
    with pytest.raises(cai.UnsafeConfig):
        cai.bind_iris_config(dict(USER, **extra))
    fake_iris["iris.utils.utils"].load_default_config = lambda: dict(USER, **extra)
    with pytest.raises(compat.MCPCompatibilityError, match="LaunchBridge refuses"):
        compat.bind_iris_config(
            ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
        )


def test_the_launcher_rechecks_the_tool_list_on_the_read_it_binds(fake_iris):
    """A file changed after the first check is caught on the read IRIS will use."""
    fake_iris["iris.utils.utils"].load_default_config = lambda: dict(
        USER, mcp_enabled_tools=["codebase_artifact_query", "codebase_artifact_context"]
    )
    with pytest.raises(compat.MCPCompatibilityError, match="mcp_enabled_tools"):
        compat.bind_iris_config(
            ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
        )


# ------------------------------------------------- IRIS kept on the checked config


@pytest.mark.parametrize("script", [cai, compat], ids=["indexing", "launcher"])
def test_iris_keeps_the_pinned_config_when_it_sets_the_path_again(
    fake_iris, script, tmp_path
):
    utils = fake_iris["iris.utils.utils"]
    original = utils.set_config_path
    api = types.ModuleType("iris.api")
    api.set_config_path = original  # imported by name, as IRIS's api module does
    sys.modules["iris.api"], saved = api, sys.modules.get("iris.api")
    try:
        config_path = tmp_path / "inq_config.yaml"
        checked = {"codebase_dir": "/repo"}
        script.pin_iris_config(checked, config_path)

        api.set_config_path(config_path)  # what IRIS's main() and api do on start
        assert utils._cached_config is checked
        utils.set_config_path(str(config_path))
        assert utils._cached_config is checked
        with pytest.raises(ValueError, match="runs with"):
            api.set_config_path(tmp_path / "other.yaml")

        again = {"codebase_dir": "/repo", "second": True}
        script.pin_iris_config(again, config_path)
        api.set_config_path(config_path)
        assert utils._cached_config is again, "pinning again replaces the first pin"
    finally:
        sys.modules["iris.api"] = saved


SHARED = (
    "_role_arn_paths",
    "cross_account_settings",
    "_model_entries",
    "unsafe_settings",
    "force_safe_settings",
    "pin_iris_config",
    "state_dir",
    "sts_client",
)


@pytest.mark.parametrize("name", SHARED)
def test_the_shared_checks_are_the_same_code_in_both_scripts(name):
    import inspect

    assert inspect.getsource(getattr(compat, name)) == inspect.getsource(
        getattr(cai, name)
    )


def test_the_shared_settings_lists_are_the_same():
    assert compat.KNOWN_CONFIG_KEYS == cai.KNOWN_CONFIG_KEYS
    assert compat.SAFE_SETTINGS == cai.SAFE_SETTINGS
    assert compat._AWS_REGION.pattern == cai._AWS_REGION.pattern


def test_the_launcher_ignores_a_record_inside_the_repository(tmp_path):
    repo = tmp_path / "repo"
    record = repo / ".lb_workspace" / "launchbridge" / "data_handling_confirmation.json"
    record.parent.mkdir(parents=True)
    outside = tmp_path / "state" / "data_handling_confirmation.json"
    destination = cai.Destination("bedrock:m@us-east-1", "amazon-bedrock", "m", "q&a")
    cai.write_confirmation(
        outside, [destination], "test", principal="p", codebase_dir=str(repo)
    )
    record.write_text(outside.read_text())

    assert compat.confirmed_destination_keys(outside, "p", str(repo)) == {
        destination.key
    }
    assert cai.load_confirmation(outside, "p", str(repo)) is not None
    assert compat.confirmed_destination_keys(record, "p", str(repo)) == set()
    assert cai.load_confirmation(record, "p", str(repo)) is None


# ------------------------------------------------- the Q&A tools' file reads


@pytest.fixture
def readers(monkeypatch, tmp_path):
    """IRIS's artifact loader and code-search filter, shaped as at the pinned commit."""
    kb = types.ModuleType("iris.artifacts.knowledge_base")
    kb.EXTRACTED_ARTIFACTS_DIR = "extracted_artifacts"
    kb._artifact_md_path = (
        lambda key, out: Path(out)
        / "extracted_artifacts"
        / (str(Path(key).parent / (Path(key).name + ".md")))
    )

    def load_extracted_artifact(key, out):
        dest = kb._artifact_md_path(key, Path(out))
        return dest.read_text() if dest.exists() else None

    retriever = types.ModuleType("iris.agents.artifact_retrieval_agent")
    retriever.load_extracted_artifact = load_extracted_artifact
    search = types.ModuleType("iris.agents.code_search_tool")
    search._should_include_file = lambda path, pattern: True
    search._should_ignore_path = lambda path, patterns: False
    repo = tmp_path / "repo"
    out = repo / ".lb_workspace" / "indexing_and_qa" / "repo"
    utils = types.ModuleType("iris.utils.utils")
    utils.construct_output_dir = lambda codebase_dir=None: str(out)
    files = types.ModuleType("iris.agents.file_retrieval_agent")
    files.read_multiple_files = lambda paths, **kwargs: {"file_paths": list(paths)}
    for module in (kb, retriever, search, utils, files):
        monkeypatch.setitem(sys.modules, module.__name__, module)

    (out / "extracted_artifacts" / "phase1").mkdir(parents=True)
    (out / "extracted_artifacts" / "phase1" / "deck.pptx.md").write_text("deck text")
    (tmp_path / "notes.md").write_text("private notes outside the index")
    compat.restrict_iris_file_reads(
        {"codebase_dir": str(repo), "ignore_patterns": [".env", "secrets/"]}
    )
    return retriever, search, repo, out, tmp_path


def test_an_indexed_artifact_still_loads(readers):
    retriever, _search, _repo, out, _tmp = readers
    assert retriever.load_extracted_artifact("phase1/deck.pptx", out) == "deck text"


@pytest.mark.parametrize("key", ["../../../../notes", "{tmp}/notes"])
def test_an_artifact_key_outside_the_extracted_folder_reads_nothing(readers, key):
    retriever, _search, _repo, out, tmp = readers
    assert retriever.load_extracted_artifact(key.format(tmp=tmp), out) is None


def test_a_symlink_in_the_extracted_folder_reads_nothing(readers):
    retriever, _search, _repo, out, tmp = readers
    (out / "extracted_artifacts" / "leak.md").symlink_to(tmp / "notes.md")
    assert retriever.load_extracted_artifact("leak", out) is None


def test_code_search_skips_a_symlink_out_of_the_repository(readers):
    _retriever, search, repo, _out, tmp = readers
    (repo / "src").mkdir()
    (repo / "src" / "app.py").write_text("x = 1\n")
    (repo / "notes").symlink_to(tmp / "notes.md")
    assert search._should_include_file(repo / "src" / "app.py", None) is True
    assert search._should_include_file(repo / "notes", None) is False


def test_the_launcher_refuses_when_a_reader_has_moved(readers, monkeypatch):
    _retriever, search, repo, _out, _tmp = readers
    monkeypatch.delattr(search, "_should_include_file")
    with pytest.raises(compat.MCPCompatibilityError, match="code-search"):
        compat.restrict_iris_file_reads({"codebase_dir": str(repo)})


def test_the_launcher_refuses_a_codebase_dir_outside_the_configs_repository(fake_iris):
    fake_iris["iris.utils.utils"].load_default_config = lambda: dict(
        USER, codebase_dir="/other-repo"
    )
    with pytest.raises(compat.MCPCompatibilityError, match="belongs to"):
        compat.bind_iris_config(
            ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
        )


def test_the_launcher_refuses_an_index_folder_through_a_link(readers, monkeypatch):
    _retriever, _search, repo, out, tmp = readers
    elsewhere = tmp / "elsewhere"
    elsewhere.mkdir()
    linked = repo / ".lb_workspace" / "indexing_and_qa" / "linked"
    linked.symlink_to(elsewhere, target_is_directory=True)
    sys.modules["iris.utils.utils"].construct_output_dir = (
        lambda codebase_dir=None: str(linked)
    )
    with pytest.raises(compat.MCPCompatibilityError, match="index folder"):
        compat.restrict_iris_file_reads({"codebase_dir": str(repo)})


@pytest.mark.parametrize(
    "relative, ignored",
    [
        ("src/app.py", False),
        ("tests/test_app.py", True),
        (".env", True),
        ("node_modules/x/index.js", True),
        ("docs/latest/notes.md", False),
    ],
)
def test_code_search_ignores_as_indexing_does(readers, relative, ignored):
    _retriever, search, repo, _out, _tmp = readers
    patterns = [".*", "tests/", "node_modules/"]
    assert search._should_ignore_path(repo / relative, patterns) is ignored


def test_a_repeated_pattern_keeps_its_last_place(readers):
    """In gitignore the last matching pattern decides."""
    _retriever, search, repo, _out, _tmp = readers
    patterns = ["*.env", "!local.env", "*.env"]
    assert search._should_ignore_path(repo / "local.env", patterns) is True
    assert search._should_ignore_path(repo / "local.env", patterns[:2]) is False


def test_code_search_ignore_is_relative_to_the_repository(readers, tmp_path):
    """A repository under a folder named "test" is not ignored as a whole."""
    _retriever, search, repo, _out, _tmp = readers
    assert search._should_ignore_path(repo / "src" / "app.py", ["repo/"]) is False


def test_the_launcher_refuses_a_relative_codebase_dir(fake_iris):
    fake_iris["iris.utils.utils"].load_default_config = lambda: dict(
        USER, codebase_dir=".."
    )
    with pytest.raises(compat.MCPCompatibilityError, match="absolute path"):
        compat.bind_iris_config(
            ["--config", "/repo/.lb_workspace/indexing_and_qa/inq_config.yaml"]
        )


# ------------------------------------------------- artifact excerpts in Q&A


def test_qa_refuses_an_artifact_index_without_the_clearance(tmp_path):
    repo = tmp_path / "repo"
    index = repo / ".lb_workspace" / "indexing_and_qa" / "repo"
    index.mkdir(parents=True)
    config = {"codebase_dir": str(repo), "output_dir": ".lb_workspace/indexing_and_qa"}
    assert compat.artifacts_uncleared(config, {}) is None, "no artifact index"

    (index / "artifact_overview.json").write_text("{}")
    assert "cleared" in compat.artifacts_uncleared(config, {})

    folder = repo / ".project_artifacts"
    folder.mkdir()
    cleared = {
        "artifact_classification": "Internal",
        "artifact_dir": str(folder.resolve()),
    }
    assert (
        compat.artifacts_uncleared(dict(config, artifact_dir=str(folder)), cleared)
        is None
    )
    other = dict(config, artifact_dir=str(tmp_path / "elsewhere"))
    assert "not the artifact folder" in compat.artifacts_uncleared(other, cleared)


def test_a_relative_artifact_folder_is_read_from_the_repository(tmp_path, monkeypatch):
    """The server's working directory is wherever the agent started it."""
    repo = tmp_path / "repo"
    index = repo / ".lb_workspace" / "indexing_and_qa" / "repo"
    index.mkdir(parents=True)
    (index / "artifact_overview.json").write_text("{}")
    (repo / ".project_artifacts").mkdir()
    cleared = {
        "artifact_classification": "Internal",
        "artifact_dir": str((repo / ".project_artifacts").resolve()),
    }
    config = {
        "codebase_dir": str(repo),
        "output_dir": ".lb_workspace/indexing_and_qa",
        "artifact_dir": ".project_artifacts",
    }
    monkeypatch.chdir(tmp_path)
    assert compat.artifacts_uncleared(config, cleared) is None


def test_qa_refuses_a_link_inside_the_index_folder(readers):
    _, _, repo, out, outside = readers
    (out / "tree.txt").symlink_to(outside / "notes.md")
    with pytest.raises(compat.MCPCompatibilityError, match="holds a symbolic link"):
        compat.restrict_iris_file_reads({"codebase_dir": str(repo)})


@pytest.mark.skipif(
    os.name == "nt" or os.geteuid() == 0, reason="POSIX modes; root ignores them"
)
def test_qa_refuses_an_index_folder_it_cant_list(readers):
    _, _, repo, out, _ = readers
    hidden = out / "hidden"
    hidden.mkdir()
    hidden.chmod(0o311)
    try:
        with pytest.raises(compat.MCPCompatibilityError, match="can't be listed"):
            compat.restrict_iris_file_reads({"codebase_dir": str(repo)})
    finally:
        hidden.chmod(0o755)


def test_file_retrieval_reads_only_indexed_files_that_arent_ignored_or_links(readers):
    """IRIS reads whatever files its file-identifier model names."""
    import json as _json

    _, _, repo, out, outside = readers
    files = sys.modules["iris.agents.file_retrieval_agent"]
    (repo / "src").mkdir()
    (repo / "src" / "app.py").write_text("x = 1\n")
    (repo / ".env").write_text("SECRET=1\n")
    (repo / "secrets").mkdir()
    (repo / "secrets" / "k.txt").write_text("k")
    (repo / "linked.py").symlink_to(outside / "notes.md")
    (repo / "unindexed.py").write_text("y = 2\n")
    indexed = ["src/app.py", ".env", "secrets/k.txt", "linked.py"]
    (out / "codebase_overview.json").write_text(_json.dumps({k: {} for k in indexed}))
    asked = [
        "src/app.py",
        "./src/app.py",
        ".env",
        "secrets/k.txt",
        "linked.py",
        "unindexed.py",
        str(repo / "src" / "app.py"),
        "../notes.md",
    ]
    read = files.read_multiple_files(paths=asked, codebase_dir=str(repo))
    assert read["file_paths"] == ["src/app.py", "./src/app.py"]
    other = files.read_multiple_files(paths=["src/app.py"], codebase_dir=str(outside))
    assert other["file_paths"] == []


def test_file_retrieval_reads_nothing_without_an_index(readers):
    _, _, repo, out, _ = readers
    files = sys.modules["iris.agents.file_retrieval_agent"]
    (repo / "a.py").write_text("")
    assert files.read_multiple_files(paths=["a.py"], codebase_dir=str(repo)) == {
        "file_paths": []
    }


def test_the_launcher_refuses_to_start_without_iris_file_retrieval(readers):
    del sys.modules["iris.agents.file_retrieval_agent"].read_multiple_files
    _, _, repo, _, _ = readers
    with pytest.raises(compat.MCPCompatibilityError, match="not where the launcher"):
        compat.restrict_iris_file_reads({"codebase_dir": str(repo)})


@pytest.mark.parametrize("value", ["", "   ", None, 3])
def test_an_output_dir_that_names_no_folder_is_refused(value):
    assert any(
        "output_dir: must name a folder" in p
        for p in compat.unsafe_settings({"codebase_dir": "/r", "output_dir": value})
    )


@pytest.mark.parametrize(
    "name,windows,key",
    [
        ("datasets\\MedQA\\test.json", True, "datasets/MedQA/test.json"),
        ("datasets/MedQA/test.json", True, "datasets/MedQA/test.json"),
        (".\\src\\a.py", True, "src/a.py"),
        ("./src/a.py", False, "src/a.py"),
        ("src/a.py", False, "src/a.py"),
    ],
)
def test_index_keys_and_requests_compare_in_one_form(name, windows, key):
    """IRIS writes index keys with str(Path): backslashes on Windows."""
    assert compat._index_key(name, windows=windows) == key


def test_file_retrieval_reads_subfolders_when_the_index_uses_backslashes(
    readers, monkeypatch
):
    import json as _json

    _, _, repo, out, _ = readers
    files = sys.modules["iris.agents.file_retrieval_agent"]
    (repo / "datasets" / "MedQA").mkdir(parents=True)
    (repo / "datasets" / "MedQA" / "test.json").write_text("{}")
    (out / "codebase_overview.json").write_text(
        _json.dumps({"datasets\\MedQA\\test.json": {}})
    )
    real = compat._index_key
    monkeypatch.setattr(compat, "_index_key", lambda n, windows=None: real(n, True))
    read = files.read_multiple_files(
        paths=["datasets\\MedQA\\test.json", "datasets/MedQA/test.json"],
        codebase_dir=str(repo),
    )
    assert len(read["file_paths"]) == 2
