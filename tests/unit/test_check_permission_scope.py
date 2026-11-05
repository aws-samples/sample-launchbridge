# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The permission-scope check must not go quiet when a strategy is unavailable.

WHY THIS FILE EXISTS. `skills/lb-setup/scripts/check_permission_scope.py` is the only
thing that tells an operator their AWS profile can do far more than Bedrock inference.
It has three fallback strategies, and the failure mode that matters is not a crash — it
is reporting "scoped" when the check simply could not see anything. Every test below
pins a case where a weaker or absent signal must produce `inconclusive` or `broad`
rather than a clean bill of health.

No test contacts AWS. `run_aws` is replaced with a table of canned responses keyed by
the leading arguments, so the argv the script would have sent is asserted too — a
strategy that silently stops calling `simulate-principal-policy` fails here.
"""

from __future__ import annotations

import json
import subprocess  # nosec B404 - fixed argv lists, shell=False, no user input
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "skills" / "lb-setup" / "scripts" / "check_permission_scope.py"

sys.path.insert(0, str(SCRIPT.parent))
import check_permission_scope as cps  # noqa: E402

ACCOUNT = "111122223333"
ROLE_SESSION_ARN = f"arn:aws:sts::{ACCOUNT}:assumed-role/DevRole/alice"
ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/DevRole"
USER_ARN = f"arn:aws:iam::{ACCOUNT}:user/alice"

ADMIN_DOCUMENT = {
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}],
}
BEDROCK_DOCUMENT = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["bedrock:InvokeModel"],
            "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        }
    ],
}


class FakeAws:
    """Answers `run_aws` from a table, and records every argv it was asked for."""

    def __init__(self, responses: dict[tuple[str, ...], object]) -> None:
        self.responses = responses
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], profile: str | None) -> object:
        self.calls.append(list(args))
        for prefix, value in self.responses.items():
            if tuple(args[: len(prefix)]) == prefix:
                if isinstance(value, cps.AwsError):
                    raise value
                return value
        raise cps.AwsError(f"unstubbed call: {' '.join(args)}", denied=True)

    def called(self, *prefix: str) -> bool:
        return any(tuple(c[: len(prefix)]) == prefix for c in self.calls)


def identity_response(arn: str) -> dict:
    return {"Arn": arn, "Account": ACCOUNT, "UserId": "AIDAEXAMPLE"}


def simulate_response(decisions: dict[str, str]) -> dict:
    return {
        "EvaluationResults": [
            {"EvalActionName": action, "EvalDecision": decision}
            for action, decision in decisions.items()
        ]
    }


def all_denied_except(allowed: list[str]) -> dict:
    probes = [a for group in cps.PROBE_ACTIONS.values() for a in group]
    everything = probes + cps.EXPECTED_ACTIONS
    return {a: ("allowed" if a in allowed else "implicitDeny") for a in everything}


@pytest.fixture
def stub(monkeypatch):
    def install(responses):
        fake = FakeAws(responses)
        monkeypatch.setattr(cps, "run_aws", fake)
        return fake

    return install


# --- Strategy 1: simulation ------------------------------------------------


def test_scoped_profile_reports_scoped(stub):
    fake = stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): simulate_response(
                all_denied_except(cps.EXPECTED_ACTIONS)
            ),
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "scoped"
    assert report["method"] == "simulation"
    assert report["findings"] == []
    assert report["expected_allowed"] == cps.EXPECTED_ACTIONS
    assert fake.called("iam", "simulate-principal-policy")


def test_admin_profile_reports_every_category(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): simulate_response(
                {
                    a: "allowed"
                    for a in [
                        *(x for g in cps.PROBE_ACTIONS.values() for x in g),
                        *cps.EXPECTED_ACTIONS,
                    ]
                }
            ),
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "broad"
    assert {f["category"] for f in report["findings"]} == set(cps.PROBE_ACTIONS)


def test_single_allowed_action_is_enough_to_be_broad(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): simulate_response(
                all_denied_except([*cps.EXPECTED_ACTIONS, "s3:DeleteBucket"])
            ),
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "broad"
    assert report["findings"] == [
        {"category": "data destruction", "actions": ["s3:DeleteBucket"]}
    ]


def test_denied_bedrock_is_reported_even_when_scoped(stub):
    """A profile with no Bedrock access passes the scope test but cannot run skills."""
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): simulate_response(
                all_denied_except([])
            ),
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "scoped"
    assert report["expected_denied"] == cps.EXPECTED_ACTIONS


def test_explicit_deny_is_not_counted_as_allowed(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): simulate_response(
                {
                    **all_denied_except(cps.EXPECTED_ACTIONS),
                    "s3:DeleteBucket": "explicitDeny",
                }
            ),
        }
    )
    assert cps.assess(None)["verdict"] == "scoped"


def test_session_arn_is_translated_to_the_role_arn(stub):
    """Simulation rejects a session ARN, so the role ARN must be resolved first."""
    fake = stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {
                "Role": {"Arn": f"arn:aws:iam::{ACCOUNT}:role/team/DevRole"}
            },
            ("iam", "simulate-principal-policy"): simulate_response(
                all_denied_except(cps.EXPECTED_ACTIONS)
            ),
        }
    )
    cps.assess(None)
    simulate_call = next(
        c for c in fake.calls if c[:2] == ["iam", "simulate-principal-policy"]
    )
    # The path-qualified ARN get-role returned, not the session ARN or a guess.
    assert f"arn:aws:iam::{ACCOUNT}:role/team/DevRole" in simulate_call
    assert ROLE_SESSION_ARN not in simulate_call


def test_unreadable_get_role_falls_back_to_the_conventional_role_arn(stub):
    fake = stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): cps.AwsError("AccessDenied", denied=True),
            ("iam", "simulate-principal-policy"): simulate_response(
                all_denied_except(cps.EXPECTED_ACTIONS)
            ),
        }
    )
    assert cps.assess(None)["verdict"] == "scoped"
    simulate_call = next(
        c for c in fake.calls if c[:2] == ["iam", "simulate-principal-policy"]
    )
    assert ROLE_ARN in simulate_call


def test_probe_actions_are_batched_under_the_api_limit(stub):
    fake = stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): simulate_response(
                all_denied_except(cps.EXPECTED_ACTIONS)
            ),
        }
    )
    cps.assess(None)
    for call in fake.calls:
        if call[:2] == ["iam", "simulate-principal-policy"]:
            actions = call[call.index("--action-names") + 1 :]
            assert 0 < len(actions) <= 20


# --- Strategy 2: policy documents -----------------------------------------


def test_custom_named_admin_policy_is_caught_by_document_inspection(stub):
    """The defect the old name-based check had: an admin grant under a benign name."""
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {
                "AttachedPolicies": [
                    {
                        "PolicyName": "TeamBaseline",
                        "PolicyArn": f"arn:aws:iam::{ACCOUNT}:policy/TeamBaseline",
                    }
                ]
            },
            ("iam", "list-role-policies"): {"PolicyNames": []},
            ("iam", "get-policy"): {"Policy": {"DefaultVersionId": "v3"}},
            ("iam", "get-policy-version"): {
                "PolicyVersion": {"Document": ADMIN_DOCUMENT}
            },
        }
    )
    report = cps.assess(None)
    assert report["method"] == "policy documents"
    assert report["verdict"] == "broad"
    assert "TeamBaseline" in report["findings"][0]["detail"]


def test_inline_policies_are_inspected(stub):
    """Inline policies were invisible to the check this script replaces."""
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {"AttachedPolicies": []},
            ("iam", "list-role-policies"): {"PolicyNames": ["legacy-escape-hatch"]},
            ("iam", "get-role-policy"): {"PolicyDocument": ADMIN_DOCUMENT},
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "broad"
    assert "legacy-escape-hatch" in report["findings"][0]["detail"]
    assert "inline" in report["findings"][0]["detail"]


def test_group_policies_are_inspected_for_users(stub):
    fake = stub(
        {
            ("sts", "get-caller-identity"): identity_response(USER_ARN),
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-groups-for-user"): {"Groups": [{"GroupName": "developers"}]},
            ("iam", "list-attached-user-policies"): {"AttachedPolicies": []},
            ("iam", "list-user-policies"): {"PolicyNames": []},
            ("iam", "list-attached-group-policies"): {"AttachedPolicies": []},
            ("iam", "list-group-policies"): {"PolicyNames": ["group-admin"]},
            ("iam", "get-group-policy"): {"PolicyDocument": ADMIN_DOCUMENT},
        }
    )
    report = cps.assess(None)
    assert fake.called("iam", "list-groups-for-user")
    assert report["verdict"] == "broad"
    assert "group developers" in report["findings"][0]["detail"]


def test_scoped_policy_document_reports_scoped(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {"AttachedPolicies": []},
            ("iam", "list-role-policies"): {"PolicyNames": ["bedrock-only"]},
            ("iam", "get-role-policy"): {"PolicyDocument": BEDROCK_DOCUMENT},
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "scoped"
    assert report["findings"] == []


def test_partially_readable_policies_cannot_report_scoped(stub):
    """A clean result over half the policies is not a clean result."""
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {
                "AttachedPolicies": [
                    {
                        "PolicyName": "Readable",
                        "PolicyArn": f"arn:aws:iam::{ACCOUNT}:policy/Readable",
                    }
                ]
            },
            ("iam", "list-role-policies"): {"PolicyNames": ["opaque"]},
            ("iam", "get-policy"): {"Policy": {"DefaultVersionId": "v1"}},
            ("iam", "get-policy-version"): {
                "PolicyVersion": {"Document": BEDROCK_DOCUMENT}
            },
            ("iam", "get-role-policy"): cps.AwsError("AccessDenied", denied=True),
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "inconclusive"
    assert any("unreadable" in note for note in report["notes"])


def test_conditional_wildcard_is_not_treated_as_unconditional_admin():
    conditional = {
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "*",
                "Resource": "*",
                "Condition": {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}},
            }
        ]
    }
    assert not cps.grants_wildcard_admin(conditional)
    assert cps.grants_wildcard_admin(ADMIN_DOCUMENT)


def test_wildcard_admin_recognised_in_list_and_string_forms():
    as_lists = {"Statement": [{"Effect": "Allow", "Action": ["*"], "Resource": ["*"]}]}
    deny_only = {"Statement": [{"Effect": "Deny", "Action": "*", "Resource": "*"}]}
    assert cps.grants_wildcard_admin(as_lists)
    assert not cps.grants_wildcard_admin(deny_only)
    assert not cps.grants_wildcard_admin(None)
    assert not cps.grants_wildcard_admin({"Statement": {"Effect": "Allow"}})


def test_service_wildcards_are_matched_against_the_probes():
    findings, uncertain = cps.inspect_document(
        {
            "Statement": [
                {"Effect": "Allow", "Action": "IAM:*", "Resource": "*"},
                {
                    "Effect": "Allow",
                    "Action": ["s3:Get*"],
                    "Resource": "arn:aws:s3:::b/*",
                },
            ]
        }
    )
    actions = {f["action"] for f in findings}
    assert {"iam:CreateUser", "iam:AttachRolePolicy", "s3:GetObject"} <= actions
    assert "s3:DeleteBucket" not in actions
    assert uncertain == []


def test_notaction_and_conditional_grants_are_uncertain_not_scoped():
    findings, uncertain = cps.inspect_document(
        {
            "Statement": [
                {
                    "Sid": "Broad",
                    "Effect": "Allow",
                    "NotAction": "iam:*",
                    "Resource": "*",
                },
                {
                    "Sid": "OnlyFromVpn",
                    "Effect": "Allow",
                    "Action": "s3:*",
                    "Resource": "*",
                    "Condition": {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}},
                },
            ]
        }
    )
    assert findings == []
    assert any("Broad" in u and "NotAction" in u for u in uncertain)
    assert any("OnlyFromVpn" in u for u in uncertain)


def test_a_service_wildcard_policy_reports_broad_not_scoped(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {"AttachedPolicies": []},
            ("iam", "list-role-policies"): {"PolicyNames": ["iam-admin"]},
            ("iam", "get-role-policy"): {
                "PolicyDocument": {
                    "Statement": [
                        {"Effect": "Allow", "Action": "iam:*", "Resource": "*"}
                    ]
                }
            },
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "broad"
    assert any(f["category"] == "privilege escalation" for f in report["findings"])


def test_a_notaction_policy_reports_inconclusive(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {"AttachedPolicies": []},
            ("iam", "list-role-policies"): {"PolicyNames": ["all-but-iam"]},
            ("iam", "get-role-policy"): {
                "PolicyDocument": {
                    "Statement": [
                        {"Effect": "Allow", "NotAction": "iam:*", "Resource": "*"}
                    ]
                }
            },
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "inconclusive"


# --- Strategy 3: names, and the no-signal case -----------------------------


def test_name_matching_never_reports_scoped(stub):
    """A name match cannot prove scope, so a clean name list stays inconclusive."""
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {
                "AttachedPolicies": [
                    {
                        "PolicyName": "SomeTeamPolicy",
                        "PolicyArn": f"arn:aws:iam::{ACCOUNT}:policy/SomeTeamPolicy",
                    }
                ]
            },
            ("iam", "list-role-policies"): {"PolicyNames": []},
            ("iam", "get-policy"): cps.AwsError("AccessDenied", denied=True),
        }
    )
    report = cps.assess(None)
    assert report["method"] == "policy names"
    assert report["verdict"] == "inconclusive"
    assert report["findings"] == []


def test_administrative_names_are_still_flagged_when_documents_are_unreadable(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): {
                "AttachedPolicies": [
                    {
                        "PolicyName": "AdministratorAccess",
                        "PolicyArn": "arn:aws:iam::aws:policy/AdministratorAccess",
                    }
                ]
            },
            ("iam", "list-role-policies"): {"PolicyNames": []},
            ("iam", "get-policy"): cps.AwsError("AccessDenied", denied=True),
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "broad"
    assert "AdministratorAccess" in report["findings"][0]["detail"]


@pytest.mark.parametrize(
    "name,expected",
    [
        ("AdministratorAccess", True),
        ("AmazonS3FullAccess", True),
        ("PowerUserAccess", True),
        ("AmazonBedrockReadOnly", False),
        ("FullAccessAuditTrail", False),
        ("PowerUserAccessBoundary", False),
    ],
)
def test_name_patterns(name, expected):
    assert cps.name_looks_administrative(name) is expected


def test_no_readable_signal_at_all_is_inconclusive(stub):
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): cps.AwsError("AccessDenied", denied=True),
            ("iam", "simulate-principal-policy"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-attached-role-policies"): cps.AwsError(
                "AccessDenied", denied=True
            ),
            ("iam", "list-role-policies"): cps.AwsError("AccessDenied", denied=True),
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "inconclusive"
    assert report["findings"] == []


def test_unresolvable_identity_is_inconclusive(stub):
    stub({("sts", "get-caller-identity"): cps.AwsError("ExpiredToken")})
    report = cps.assess(None)
    assert report["verdict"] == "inconclusive"
    assert "identity" not in report


def test_federated_principal_has_no_simulation_source(stub):
    """A federated ARN cannot be simulated or enumerated; it must not read as scoped."""
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(
                f"arn:aws:sts::{ACCOUNT}:federated-user/alice"
            )
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "inconclusive"
    assert report["identity"]["principal_type"] == "unknown"


def test_root_is_reported_without_any_iam_call(stub):
    fake = stub(
        {
            ("sts", "get-caller-identity"): identity_response(
                f"arn:aws:iam::{ACCOUNT}:root"
            )
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "broad"
    assert report["method"] == "identity"
    assert not any(c[0] == "iam" for c in fake.calls)


# --- Exit codes and CLI ----------------------------------------------------


@pytest.mark.parametrize(
    "verdict,code", [("scoped", 0), ("broad", 1), ("inconclusive", 2)]
)
def test_exit_codes(monkeypatch, capsys, verdict, code):
    monkeypatch.setattr(cps, "find_aws", lambda: "/usr/bin/aws")
    monkeypatch.setattr(
        cps,
        "assess",
        lambda _: {
            "verdict": verdict,
            "method": "simulation",
            "findings": [],
            "expected_denied": [],
            "notes": [],
        },
    )
    assert cps.main([]) == code
    capsys.readouterr()


def test_missing_aws_cli_exits_two(monkeypatch, capsys):
    monkeypatch.setattr(cps, "find_aws", lambda: None)
    assert cps.main([]) == 2
    assert "aws CLI" in capsys.readouterr().out


def test_json_output_is_parseable(monkeypatch, capsys):
    monkeypatch.setattr(cps, "find_aws", lambda: "/usr/bin/aws")
    monkeypatch.setattr(
        cps,
        "assess",
        lambda _: {
            "verdict": "broad",
            "method": "simulation",
            "findings": [{"category": "data access", "actions": ["s3:GetObject"]}],
            "expected_denied": [],
            "notes": [],
        },
    )
    assert cps.main(["--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["findings"][0]["actions"] == ["s3:GetObject"]


def test_profile_is_passed_through_to_every_call(monkeypatch):
    seen: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        seen.append(cmd)
        return subprocess.CompletedProcess(
            cmd, 0, json.dumps(identity_response(ROLE_SESSION_ARN)), ""
        )

    # run_aws looks the CLI up first; CI has none installed.
    monkeypatch.setattr(cps, "find_aws", lambda: "/usr/bin/aws")
    monkeypatch.setattr(cps.subprocess, "run", fake_run)
    cps.resolve_identity("engagement")
    assert len(seen) >= 2  # get-caller-identity, then get-role
    for cmd in seen:
        assert cmd[-2:] == ["--profile", "engagement"]


def test_run_aws_marks_authorization_failures_as_denied(monkeypatch):
    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(
            cmd, 254, "", "An error occurred (AccessDenied) when calling ..."
        )

    # run_aws looks the CLI up first; CI has none installed.
    monkeypatch.setattr(cps, "find_aws", lambda: "/usr/bin/aws")
    monkeypatch.setattr(cps.subprocess, "run", fake_run)
    with pytest.raises(cps.AwsError) as excinfo:
        cps.run_aws(["iam", "simulate-principal-policy"], None)
    assert excinfo.value.denied is True


def test_run_aws_does_not_mark_other_failures_as_denied(monkeypatch):
    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 255, "", "Could not connect")

    # run_aws looks the CLI up first; CI has none installed.
    monkeypatch.setattr(cps, "find_aws", lambda: "/usr/bin/aws")
    monkeypatch.setattr(cps.subprocess, "run", fake_run)
    with pytest.raises(cps.AwsError) as excinfo:
        cps.run_aws(["sts", "get-caller-identity"], None)
    assert excinfo.value.denied is False


def test_script_only_issues_read_only_aws_calls():
    """A probe action name must never become an operation the script performs."""
    source = SCRIPT.read_text()
    mutating = [
        '"create-',
        '"delete-',
        '"put-',
        '"attach-',
        '"detach-',
        '"update-',
        '"terminate-',
        '"invoke-model',
    ]
    for fragment in mutating:
        assert fragment not in source, f"{fragment} suggests a non-read-only call"


# --- Acknowledging a broad scope --------------------------------------------
#
# The operator can accept a broad profile once, so setup stops asking the same
# question on every run. What must never happen is the acknowledgement covering
# more than the operator was shown: a different principal, or a category that
# appeared after they said yes.


def broad_report(categories, principal_name="DevRole", principal_type="role"):
    return {
        "verdict": "broad",
        "method": "simulation",
        "identity": {
            "account": ACCOUNT,
            "arn": ROLE_SESSION_ARN,
            "principal_type": principal_type,
            "principal_name": principal_name,
        },
        "findings": [{"category": c, "actions": ["x:Y"]} for c in categories],
        "expected_denied": [],
        "notes": [],
    }


@pytest.fixture
def cli(monkeypatch, capsys):
    """Run main() against a canned assessment that can change between runs."""
    state = {"report": None}
    monkeypatch.setattr(cps, "find_aws", lambda: "/usr/bin/aws")
    # A fresh copy each run: main() mutates the report it is given.
    monkeypatch.setattr(
        cps, "assess", lambda _: json.loads(json.dumps(state["report"]))
    )

    def run(report, *args):
        state["report"] = report
        code = cps.main(list(args))
        return code, capsys.readouterr().out

    return run


def test_broad_without_an_ack_file_still_exits_one(cli):
    code, _ = cli(broad_report(["data access"]))
    assert code == 1


def test_first_broad_run_with_an_ack_file_still_asks(cli, tmp_path):
    ack = tmp_path / "ack.json"
    code, _ = cli(broad_report(["data access"]), "--ack-file", str(ack))
    assert code == 1
    assert not ack.exists(), "checking must never write an acknowledgement"


def test_acknowledged_scope_is_not_asked_again(cli, tmp_path):
    ack = tmp_path / "ack.json"
    report = broad_report(["data access", "secret access"])

    code, out = cli(report, "--ack-file", str(ack), "--acknowledge")
    assert code == 3
    assert "ACKNOWLEDGED" in out

    code, out = cli(report, "--ack-file", str(ack))
    assert code == 3
    assert "not asked again" in out


def test_a_new_category_is_asked_about_again(cli, tmp_path):
    """Widening a profile after it was accepted is exactly what must be raised."""
    ack = tmp_path / "ack.json"
    cli(broad_report(["data access"]), "--ack-file", str(ack), "--acknowledge")

    code, _ = cli(
        broad_report(["data access", "privilege escalation"]), "--ack-file", str(ack)
    )
    assert code == 1


def test_a_narrower_scope_stays_covered(cli, tmp_path):
    ack = tmp_path / "ack.json"
    cli(
        broad_report(["data access", "secret access"]),
        "--ack-file",
        str(ack),
        "--acknowledge",
    )
    code, _ = cli(broad_report(["data access"]), "--ack-file", str(ack))
    assert code == 3


def test_a_different_principal_is_not_covered(cli, tmp_path):
    ack = tmp_path / "ack.json"
    cli(broad_report(["data access"]), "--ack-file", str(ack), "--acknowledge")

    code, _ = cli(
        broad_report(["data access"], principal_name="OtherRole"),
        "--ack-file",
        str(ack),
    )
    assert code == 1


def test_a_new_session_of_the_same_role_is_still_covered(cli, tmp_path):
    """The session-name suffix changes every login; the principal does not."""
    ack = tmp_path / "ack.json"
    first = broad_report(["data access"])
    cli(first, "--ack-file", str(ack), "--acknowledge")

    later = broad_report(["data access"])
    later["identity"]["arn"] = f"arn:aws:sts::{ACCOUNT}:assumed-role/DevRole/bob"
    code, _ = cli(later, "--ack-file", str(ack))
    assert code == 3


def test_root_is_never_acknowledged(cli, tmp_path):
    ack = tmp_path / "ack.json"
    root = broad_report(["unrestricted"], principal_name="root", principal_type="root")

    code, out = cli(root, "--ack-file", str(ack), "--acknowledge")
    assert code == 1
    assert "never acknowledged" in out
    assert not ack.exists()


def test_acknowledging_a_scoped_profile_records_nothing(cli, tmp_path):
    ack = tmp_path / "ack.json"
    scoped = {**broad_report([]), "verdict": "scoped"}
    code, out = cli(scoped, "--ack-file", str(ack), "--acknowledge")
    assert code == 0
    assert "nothing to acknowledge" in out
    assert not ack.exists()


def test_inconclusive_is_never_covered_by_an_ack(cli, tmp_path):
    """An ack accepts a measured scope; an unmeasured one has nothing to match."""
    ack = tmp_path / "ack.json"
    cli(broad_report(["data access"]), "--ack-file", str(ack), "--acknowledge")
    unknown = {**broad_report([]), "verdict": "inconclusive"}
    code, _ = cli(unknown, "--ack-file", str(ack))
    assert code == 2


def test_acknowledge_requires_an_ack_file(cli):
    with pytest.raises(SystemExit):
        cli(broad_report(["data access"]), "--acknowledge")


def test_a_corrupt_ack_file_covers_nothing(cli, tmp_path):
    ack = tmp_path / "ack.json"
    ack.write_text("{not json", encoding="utf-8")
    code, _ = cli(broad_report(["data access"]), "--ack-file", str(ack))
    assert code == 1


def test_reacknowledging_replaces_rather_than_accumulates(cli, tmp_path):
    ack = tmp_path / "ack.json"
    cli(broad_report(["data access"]), "--ack-file", str(ack), "--acknowledge")
    cli(broad_report(["secret access"]), "--ack-file", str(ack), "--acknowledge")

    entries = json.loads(ack.read_text())["acknowledgements"]
    assert len(entries) == 1
    assert entries[0]["categories"] == ["secret access"]
    # The narrower old scope was replaced, so it is no longer covered on its own.
    code, _ = cli(broad_report(["data access"]), "--ack-file", str(ack))
    assert code == 1


def test_ack_file_holds_no_account_id_or_arn(cli, tmp_path):
    ack = tmp_path / "ack.json"
    cli(broad_report(["data access"]), "--ack-file", str(ack), "--acknowledge")
    text = ack.read_text()
    assert ACCOUNT not in text
    assert "arn:" not in text
    assert "DevRole" not in text


def test_ack_for_repo_keeps_acknowledgements_outside_the_repository(
    cli, tmp_path, monkeypatch
):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "user-config"))
    repo = tmp_path / "repo"
    repo.mkdir()
    report = broad_report(["data access"])

    code, _ = cli(report, "--ack-for-repo", str(repo), "--acknowledge")
    assert code == 3

    path = cps.ack_path_for_repo(str(repo))
    assert path.is_file()
    assert repo not in path.parents
    assert (tmp_path / "user-config" / "launchbridge") in path.parents
    code, _ = cli(report, "--ack-for-repo", str(repo))
    assert code == 3


def test_an_ack_file_inside_the_repository_acknowledges_nothing(
    cli, tmp_path, monkeypatch
):
    """With --ack-for-repo, a file that arrived with the repository is never read."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "user-config"))
    repo = tmp_path / "repo"
    planted = repo / ".lb_workspace" / "config" / "permission_scope_ack.json"
    report = broad_report(["data access"])
    cli(report, "--ack-file", str(planted), "--acknowledge")
    assert planted.is_file()

    code, _ = cli(report, "--ack-for-repo", str(repo))
    assert code == 1


def test_ack_for_repo_differs_per_repository(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "user-config"))
    assert cps.ack_path_for_repo(str(tmp_path / "a")) != cps.ack_path_for_repo(
        str(tmp_path / "b")
    )


def test_ack_for_repo_and_ack_file_are_exclusive(cli, tmp_path):
    with pytest.raises(SystemExit):
        cli(
            broad_report(["data access"]),
            "--ack-for-repo",
            str(tmp_path),
            "--ack-file",
            str(tmp_path / "x.json"),
        )


@pytest.mark.parametrize("value", ["", "relative/config", "."])
def test_a_relative_xdg_config_home_is_ignored(monkeypatch, tmp_path, value):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_CONFIG_HOME", value)
    path = cps.ack_path_for_repo(str(tmp_path / "repo"))
    assert path.is_relative_to(tmp_path / "home" / ".config" / "launchbridge")


def test_an_acknowledgement_path_inside_the_repository_is_refused(
    monkeypatch, tmp_path, capsys
):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(repo / ".lb_workspace"))
    with pytest.raises(SystemExit):
        cps.main(["--ack-for-repo", str(repo), "--acknowledge"])
    assert "inside the repository" in capsys.readouterr().err


def test_a_denied_policy_listing_is_never_scoped(stub):
    """Simulation denied, and the attached-policy listing too, would hide
    AdministratorAccess; one readable harmless inline policy must not read as scoped."""
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): cps.AwsError("denied", denied=True),
            ("iam", "list-attached-role-policies"): cps.AwsError("denied", denied=True),
            ("iam", "list-role-policies"): {"PolicyNames": ["bedrock"]},
            ("iam", "get-role-policy"): {"PolicyDocument": BEDROCK_DOCUMENT},
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "inconclusive"
    assert any("could not list" in n for n in report["notes"])


def test_a_simulation_that_skips_actions_is_not_scoped(stub):
    decisions = all_denied_except([])
    decisions.pop(cps.EXPECTED_ACTIONS[0])
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): simulate_response(decisions),
        }
    )
    assert cps.assess(None)["verdict"] == "inconclusive"


def test_a_deny_that_needed_missing_context_is_not_scoped(stub):
    """An admin policy conditioned on MFA is denied in a simulation without MFA."""
    response = simulate_response(all_denied_except([]))
    for entry in response["EvaluationResults"]:
        entry["MissingContextValues"] = ["aws:MultiFactorAuthPresent"]
    stub(
        {
            ("sts", "get-caller-identity"): identity_response(ROLE_SESSION_ARN),
            ("iam", "get-role"): {"Role": {"Arn": ROLE_ARN}},
            ("iam", "simulate-principal-policy"): response,
        }
    )
    report = cps.assess(None)
    assert report["verdict"] == "inconclusive"
    assert any("lack of context" in note for note in report["notes"])
