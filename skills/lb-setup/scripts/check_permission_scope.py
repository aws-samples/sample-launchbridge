#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Report what the configured AWS identity can actually do, beyond Bedrock inference.

`sts get-caller-identity` proves that credentials resolve; it says nothing about
their scope. LaunchBridge's core skills need only Bedrock inference and create no
AWS resources (the optional features in the README's AWS Credentials section need
more), so a broad profile means that any
prompt injection through indexed repository content, or any compromised package in
`.venv_lb`, inherits whatever that profile can reach.

This script answers the scope question with three strategies, strongest first:

1. `iam:SimulatePrincipalPolicy` over a fixed list of sensitive actions. This is
   the only approach that reports *effective* permissions: IAM evaluates attached
   managed policies, inline policies, permission boundaries and applicable SCPs
   together and returns a decision per action.
2. Policy-document inspection, when simulation is denied. Attached managed, inline
   and (for IAM users) group policies are fetched and searched for an `Allow` on
   `Action: *` with `Resource: *`. This reads what a policy *grants*, so an
   admin-equivalent policy under a custom name is still caught.
3. Policy-name matching, when even reading policy documents is denied. This is the
   weakest signal and is reported as inconclusive, because a name is not a grant.

**Every AWS call this script makes is read-only.** Simulation evaluates policy and
returns a decision; it never performs the action being asked about. The sensitive
action names in `PROBE_ACTIONS` below are inputs to that evaluation, not operations
this script attempts.

The report itself is never written to disk. It names an account ID, a role or user
name and possibly policy names, none of which belong in a delivered repository — so
it goes to stdout for the operator to read, and the caller is responsible for not
redirecting it into a tracked file.

Acknowledging a broad scope. A broad profile is often deliberate on a development
machine, and asking the same question on every setup trains the operator to answer
it without reading. With `--ack-file`, an operator's "continue" is recorded once per
principal, together with the exact categories they were shown. Later runs that find
the same principal with no category beyond those exit 3 instead of 1, so the caller
can report the finding without asking again. A different principal, or any new
category, is not covered and exits 1 as before — widening a profile after it was
accepted is exactly what should be asked about again. The account root user is never
acknowledged. The file stores a SHA-256 of the principal rather than its ARN, and the
profile name; it is the operator's own state, not a secret. `--ack-for-repo` keeps it
outside the repository, in the user's LaunchBridge state directory, so a file that
arrives with a repository can never acknowledge anything.

Usage:
    python3 check_permission_scope.py [--profile NAME] [--json]
                                      [--ack-for-repo DIR | --ack-file PATH]
                                      [--acknowledge]

Exit codes:
    0  scoped as expected — no probed action outside Bedrock is allowed
    1  broad permissions detected — at least one sensitive action is allowed
    2  inconclusive — the identity or its permissions could not be determined
    3  broad, and already acknowledged for this principal and these categories

Exit codes 1 and 3 are warnings, not failures: LaunchBridge cannot change the
operator's IAM, and a broad profile may be a deliberate choice. `lb-setup` reports
the finding and continues.

`--acknowledge` re-runs the check and records whatever it finds, rather than taking
categories from its caller, so an acknowledgement can only ever cover a scope that
was actually measured. The caller is an AI agent: it must pass this flag only after
the operator has answered the question, never on its own initiative.
"""

from __future__ import annotations

import argparse
import datetime
import fnmatch
import hashlib
import json
import os
import re
import subprocess  # nosec B404 - runs the aws CLI with list-form argv, shell=False
import sys
import tempfile
import types
from pathlib import Path

# Actions probed by simulation, grouped by what an attacker gains. Bedrock is
# included as a positive control: if inference is denied, the skills cannot work
# and the operator needs to know that now rather than at first use.
PROBE_ACTIONS = {
    "privilege escalation": [
        "iam:CreateUser",
        "iam:AttachRolePolicy",
        "iam:CreateAccessKey",
        "iam:PutRolePolicy",
    ],
    "lateral movement": ["sts:AssumeRole"],
    "secret access": [
        "secretsmanager:GetSecretValue",
        "ssm:GetParameter",
        "kms:Decrypt",
    ],
    "data access": ["s3:GetObject", "dynamodb:Scan"],
    "data destruction": [
        "s3:DeleteBucket",
        "s3:DeleteObject",
        "dynamodb:DeleteTable",
        "rds:DeleteDBInstance",
        "ec2:TerminateInstances",
    ],
    "audit tampering": ["cloudtrail:StopLogging", "config:DeleteConfigRule"],
}

# What LaunchBridge legitimately needs. An allow here is expected and not reported
# as a finding. The Converse APIs are authorized by these same two actions.
EXPECTED_ACTIONS = [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
]

# Matched against policy names only when no policy document can be read. Present
# for continuity with the older name-based check, and reported as inconclusive.
ADMIN_NAME_PATTERNS = (
    re.compile(r"AdministratorAccess", re.IGNORECASE),
    re.compile(r"FullAccess$", re.IGNORECASE),
    re.compile(r"^PowerUserAccess$", re.IGNORECASE),
)

ASSUMED_ROLE_ARN = re.compile(r"^arn:aws[\w-]*:sts::\d+:assumed-role/([^/]+)/")
USER_ARN = re.compile(r"^arn:aws[\w-]*:iam::\d+:user/(?:.*/)?([^/]+)$")
ROOT_ARN = re.compile(r"^arn:aws[\w-]*:iam::\d+:root$")


class AwsError(Exception):
    """An `aws` invocation failed. `denied` distinguishes authorization failures."""

    def __init__(self, message: str, denied: bool = False) -> None:
        super().__init__(message)
        self.denied = denied


# The repository whose aws CLI must not be used: --ack-for-repo's, else the
# current directory.
TOOL_ROOT: Path | None = None


def find_aws() -> str | None:
    """The aws CLI's absolute path, never one from the repository or the current
    directory (see lb_guard.find_tool; on Windows a bare `aws` is looked up in
    the current directory first)."""
    # Compiled from its source: with this folder on sys.path, any file in it could
    # stand in for a standard library module lb_guard imports, and the normal
    # loader would run a `__pycache__/*.pyc` there without comparing it to the
    # source.
    path = Path(__file__).resolve().parent / "lb_guard.py"
    lb_guard = types.ModuleType("lb_guard")
    lb_guard.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), "exec"), lb_guard.__dict__)  # nosec B102 - LaunchBridge's own module, from source
    return lb_guard.find_tool("aws", TOOL_ROOT or Path.cwd())


def run_aws(args: list[str], profile: str | None) -> object:
    """Run one read-only `aws` command and return its parsed JSON output."""
    aws = find_aws()
    if not aws:
        raise AwsError("the aws CLI is not installed or not on PATH")
    cmd = [aws, *args, "--output", "json"]
    if profile:
        cmd += ["--profile", profile]
    try:
        # cmd is the aws CLI's absolute path, a fixed read-only subcommand and its arguments as separate argv elements; no shell.
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)  # nosec B603 - argv list, shell=False
    except FileNotFoundError:
        raise AwsError("the aws CLI is not installed or not on PATH") from None
    except subprocess.TimeoutExpired:
        raise AwsError(f"aws {' '.join(args[:2])} timed out after 60s") from None
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        denied = bool(
            re.search(
                r"AccessDenied|not authorized|UnauthorizedOperation|"
                r"AuthorizationError|ExplicitDeny",
                stderr,
            )
        )
        raise AwsError(stderr or f"aws exited {proc.returncode}", denied=denied)
    if not proc.stdout.strip():
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise AwsError(f"aws {' '.join(args[:2])} returned non-JSON output") from None


def resolve_identity(profile: str | None) -> dict:
    """Return the caller's identity plus the principal ARN simulation accepts.

    A session ARN (`sts::…:assumed-role/Role/session`) is not a valid simulation
    source; the underlying role ARN is. `get-role` is used rather than string
    surgery because it resolves roles that live under an IAM path.
    """
    ident = run_aws(["sts", "get-caller-identity"], profile)
    if not isinstance(ident, dict) or "Arn" not in ident:
        raise AwsError("get-caller-identity returned no ARN")
    arn = ident["Arn"]
    result = {
        "account": ident.get("Account", ""),
        "arn": arn,
        "principal_type": "unknown",
        "principal_name": "",
        "source_arn": None,
    }

    if ROOT_ARN.match(arn):
        result["principal_type"] = "root"
        result["principal_name"] = "root"
        return result

    match = ASSUMED_ROLE_ARN.match(arn)
    if match:
        role_name = match.group(1)
        result["principal_type"] = "role"
        result["principal_name"] = role_name
        try:
            role = run_aws(["iam", "get-role", "--role-name", role_name], profile)
            result["source_arn"] = role["Role"]["Arn"]
            result["permissions_boundary"] = bool(
                role["Role"].get("PermissionsBoundary")
            )
        except (AwsError, KeyError, TypeError):
            # Cannot read own IAM. Fall back to the conventional role ARN shape,
            # which is correct whenever the role is not under a path.
            result["source_arn"] = f"arn:aws:iam::{result['account']}:role/{role_name}"
        return result

    match = USER_ARN.match(arn)
    if match:
        result["principal_type"] = "user"
        result["principal_name"] = match.group(1)
        result["source_arn"] = arn
        return result

    # Federated or service principals: no simulation source to give IAM.
    return result


MISSING_CONTEXT = "missingContext"


def simulate(source_arn: str, actions: list[str], profile: str | None) -> dict:
    """Map each action to its IAM decision: allowed, explicitDeny or implicitDeny."""
    decisions: dict[str, str] = {}
    # SimulatePrincipalPolicy caps action names per call; batch well under it.
    for start in range(0, len(actions), 20):
        batch = actions[start : start + 20]
        data = run_aws(
            [
                "iam",
                "simulate-principal-policy",
                "--policy-source-arn",
                source_arn,
                "--action-names",
                *batch,
            ],
            profile,
        )
        for entry in (data or {}).get("EvaluationResults", []):
            decision = entry["EvalDecision"]
            if entry.get("MissingContextValues") and decision != "allowed":
                # A policy conditioned on MFA, source IP or region was evaluated
                # without that context, so the deny says nothing.
                decision = MISSING_CONTEXT
            decisions[entry["EvalActionName"]] = decision
    return decisions


def statements(document: object) -> list[dict]:
    """Normalise a policy document's Statement to a list of dicts."""
    if not isinstance(document, dict):
        return []
    raw = document.get("Statement", [])
    if isinstance(raw, dict):
        raw = [raw]
    return [s for s in raw if isinstance(s, dict)]


def grants_wildcard_admin(document: object) -> bool:
    """True when the document allows every action on every resource."""
    for statement in statements(document):
        if statement.get("Effect") != "Allow":
            continue
        if statement.get("Condition"):
            # A conditional wildcard is not unconditional admin; simulation is the
            # right tool for those and this path only runs when it is unavailable.
            continue
        actions = statement.get("Action", [])
        resources = statement.get("Resource", [])
        actions = [actions] if isinstance(actions, str) else actions
        resources = [resources] if isinstance(resources, str) else resources
        if "*" in actions and "*" in resources:
            return True
    return False


def _as_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def inspect_document(document: object) -> tuple[list[dict], list[str]]:
    """Probed actions a policy document allows, and statements it cannot judge.

    Each probe action is matched against the statement's Action patterns the way
    IAM matches them (case-insensitive, `*` and `?` wildcards), so `iam:*` or
    `s3:*` counts. Allow statements that use NotAction or NotResource, and
    conditional grants of a probed action, cannot be evaluated without
    simulation, so they are returned as uncertain rather than treated as scoped.
    """
    findings: list[dict] = []
    uncertain: list[str] = []
    for statement in statements(document):
        if statement.get("Effect") != "Allow":
            continue
        sid = statement.get("Sid") or "unnamed statement"
        if "NotAction" in statement or "NotResource" in statement:
            uncertain.append(f"{sid} uses NotAction or NotResource")
            continue
        patterns = [a.lower() for a in _as_list(statement.get("Action"))]
        resources = _as_list(statement.get("Resource")) or ["*"]
        for category, actions in PROBE_ACTIONS.items():
            for action in actions:
                if not any(
                    fnmatch.fnmatchcase(action.lower(), pat) for pat in patterns
                ):
                    continue
                if statement.get("Condition"):
                    uncertain.append(f"{sid} allows {action} under a condition")
                    continue
                findings.append(
                    {"category": category, "action": action, "resources": resources}
                )
    return findings, uncertain


def collect_policies(
    identity: dict, profile: str | None
) -> tuple[list[dict], list[str]]:
    """List every policy attached to the principal, with its document when readable.

    Covers attached managed policies, inline policies, and — for an IAM user — the
    policies reached through group membership. The older name-based check looked at
    attached managed policies only. Also returns each listing that failed: a policy
    behind a denied listing (AdministratorAccess, say) is not in the result, so the
    result can't be called scoped.
    """
    kind = identity["principal_type"]
    name = identity["principal_name"]
    found: list[dict] = []
    unlisted: list[str] = []

    if kind == "role":
        scopes = [("role", name)]
    elif kind == "user":
        scopes = [("user", name)]
        try:
            groups = run_aws(
                ["iam", "list-groups-for-user", "--user-name", name], profile
            )
            scopes += [
                ("group", g["GroupName"]) for g in (groups or {}).get("Groups", [])
            ]
        except AwsError:
            unlisted.append(f"the groups of user {name}")
    else:
        return found, unlisted

    for scope, scope_name in scopes:
        flag = f"--{scope}-name"
        try:
            attached = run_aws(
                ["iam", f"list-attached-{scope}-policies", flag, scope_name], profile
            )
            key = "AttachedPolicies"
            for policy in (attached or {}).get(key, []):
                found.append(
                    {
                        "source": f"{scope} {scope_name}",
                        "type": "managed",
                        "name": policy["PolicyName"],
                        "document": read_managed_policy(policy["PolicyArn"], profile),
                    }
                )
        except AwsError:
            unlisted.append(f"the managed policies attached to {scope} {scope_name}")

        try:
            inline = run_aws(
                ["iam", f"list-{scope}-policies", flag, scope_name], profile
            )
            for policy_name in (inline or {}).get("PolicyNames", []):
                found.append(
                    {
                        "source": f"{scope} {scope_name}",
                        "type": "inline",
                        "name": policy_name,
                        "document": read_inline_policy(
                            scope, scope_name, policy_name, profile
                        ),
                    }
                )
        except AwsError:
            unlisted.append(f"the inline policies of {scope} {scope_name}")

    return found, unlisted


def read_managed_policy(policy_arn: str, profile: str | None) -> object:
    try:
        meta = run_aws(["iam", "get-policy", "--policy-arn", policy_arn], profile)
        version = meta["Policy"]["DefaultVersionId"]
        data = run_aws(
            [
                "iam",
                "get-policy-version",
                "--policy-arn",
                policy_arn,
                "--version-id",
                version,
            ],
            profile,
        )
        return data["PolicyVersion"]["Document"]
    except (AwsError, KeyError, TypeError):
        return None


def read_inline_policy(
    scope: str, scope_name: str, policy_name: str, profile: str | None
) -> object:
    try:
        data = run_aws(
            [
                "iam",
                f"get-{scope}-policy",
                f"--{scope}-name",
                scope_name,
                "--policy-name",
                policy_name,
            ],
            profile,
        )
        return data["PolicyDocument"]
    except (AwsError, KeyError, TypeError):
        return None


def name_looks_administrative(name: str) -> bool:
    return any(pattern.search(name) for pattern in ADMIN_NAME_PATTERNS)


def assess(profile: str | None) -> dict:
    """Run the strongest available check and return a structured verdict."""
    report: dict = {
        "method": None,
        "findings": [],
        "expected_allowed": [],
        "expected_denied": [],
        "notes": [],
        "verdict": "inconclusive",
    }

    try:
        identity = resolve_identity(profile)
    except AwsError as exc:
        report["notes"].append(f"could not resolve identity: {exc}")
        return report

    report["identity"] = {
        "account": identity["account"],
        "arn": identity["arn"],
        "principal_type": identity["principal_type"],
        "principal_name": identity["principal_name"],
    }

    if identity["principal_type"] == "root":
        report["method"] = "identity"
        report["verdict"] = "broad"
        report["findings"].append(
            {
                "category": "unrestricted",
                "detail": "the account root user has every permission and cannot be scoped",
            }
        )
        return report

    if identity.get("permissions_boundary"):
        report["notes"].append(
            "a permissions boundary is attached; simulation accounts for it"
        )

    # Strategy 1 — effective permissions.
    source_arn = identity.get("source_arn")
    if source_arn:
        probes = [a for group in PROBE_ACTIONS.values() for a in group]
        try:
            decisions = simulate(source_arn, probes + EXPECTED_ACTIONS, profile)
            report["method"] = "simulation"
            for category, actions in PROBE_ACTIONS.items():
                allowed = [a for a in actions if decisions.get(a) == "allowed"]
                if allowed:
                    report["findings"].append(
                        {"category": category, "actions": allowed}
                    )
            report["expected_allowed"] = [
                a for a in EXPECTED_ACTIONS if decisions.get(a) == "allowed"
            ]
            report["expected_denied"] = [
                a
                for a in EXPECTED_ACTIONS
                if decisions.get(a) not in (None, "allowed", MISSING_CONTEXT)
            ]
            unevaluated = [
                a
                for a in probes + EXPECTED_ACTIONS
                if decisions.get(a) in (None, MISSING_CONTEXT)
            ]
            conditional = [
                a
                for a in probes + EXPECTED_ACTIONS
                if decisions.get(a) == MISSING_CONTEXT
            ]
            if conditional:
                report["notes"].append(
                    f"{len(conditional)} actions were denied only for lack of context "
                    "the simulation can't supply (a policy conditioned on MFA, source "
                    "IP or region), so they may be allowed in use"
                )
            if report["findings"]:
                report["verdict"] = "broad"
            elif unevaluated:
                report["notes"].append(
                    f"the simulation returned no decision for {len(unevaluated)} of "
                    f"{len(probes) + len(EXPECTED_ACTIONS)} actions"
                )
                report["verdict"] = "inconclusive"
            else:
                report["verdict"] = "scoped"
            return report
        except AwsError as exc:
            report["notes"].append(
                "simulate-principal-policy unavailable "
                f"({'denied' if exc.denied else exc}); "
                "falling back to policy inspection"
            )

    # Strategy 2 — what the attached policies actually grant.
    policies, unlisted = collect_policies(identity, profile)
    for what in unlisted:
        report["notes"].append(f"could not list {what}")
    if policies:
        readable = [p for p in policies if p["document"] is not None]
        if readable:
            report["method"] = "policy documents"
            uncertain_any = False
            for policy in readable:
                where = (
                    f"{policy['type']} policy {policy['name']} on {policy['source']}"
                )
                if grants_wildcard_admin(policy["document"]):
                    report["findings"].append(
                        {
                            "category": "unrestricted",
                            "detail": f"{where} allows Action:* on Resource:*",
                        }
                    )
                    continue
                matches, uncertain = inspect_document(policy["document"])
                for match in matches:
                    report["findings"].append(
                        {
                            "category": match["category"],
                            "detail": (
                                f"{where} allows {match['action']} on "
                                f"{', '.join(match['resources'])}"
                            ),
                        }
                    )
                for reason in uncertain:
                    uncertain_any = True
                    report["notes"].append(
                        f"{where}: {reason}, which needs simulation to evaluate"
                    )
            unreadable = len(policies) - len(readable)
            if unreadable:
                report["notes"].append(
                    f"{unreadable} of {len(policies)} policy documents were unreadable"
                )
            if report["findings"]:
                report["verdict"] = "broad"
            elif unreadable or uncertain_any or unlisted:
                report["verdict"] = "inconclusive"
            else:
                report["verdict"] = "scoped"
            return report

        # Strategy 3 — names only.
        report["method"] = "policy names"
        for policy in policies:
            if name_looks_administrative(policy["name"]):
                report["findings"].append(
                    {
                        "category": "unrestricted",
                        "detail": (
                            f"{policy['type']} policy {policy['name']} on "
                            f"{policy['source']} is named like an administrative policy"
                        ),
                    }
                )
        report["notes"].append(
            "no policy document could be read, so this is a name match rather than "
            "a permission check; a broadly-scoped policy under a custom name would "
            "not appear here"
        )
        report["verdict"] = "broad" if report["findings"] else "inconclusive"
        return report

    report["notes"].append(
        "the profile cannot simulate its own policies or list them, so its scope "
        "could not be determined; being unable to read its own IAM is itself a sign "
        "it is not administrative"
    )
    return report


ACK_SCHEMA_VERSION = 1
ACK_FILE = "permission_scope_ack.json"


def ack_path_for_repo(repo: str) -> Path:
    """Acknowledgements for one repository, kept in the user's state directory.

    A relative XDG_CONFIG_HOME is ignored, as the XDG spec requires: it would
    resolve against the working directory, which can be the repository itself.
    """
    base = os.environ.get("XDG_CONFIG_HOME", "")
    if not os.path.isabs(base):
        base = str(Path.home() / ".config")
    resolved = str(Path(repo).resolve())
    key = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16]
    return Path(base) / "launchbridge" / "repos" / key / ACK_FILE


def principal_fingerprint(identity: dict) -> str | None:
    """A stable, non-plaintext key for the principal behind a session.

    Built from the account, principal type and name — not the session ARN, whose
    session-name suffix changes on every login and would void each acknowledgement.
    """
    if not identity or not identity.get("principal_name"):
        return None
    key = "\0".join(
        [identity["account"], identity["principal_type"], identity["principal_name"]]
    )
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def finding_categories(report: dict) -> list[str]:
    return sorted({finding["category"] for finding in report["findings"]})


def load_acks(path: Path) -> list[dict]:
    """Read recorded acknowledgements. A missing or unreadable file covers nothing."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, dict) or data.get("version") != ACK_SCHEMA_VERSION:
        return []
    acks = data.get("acknowledgements")
    return [a for a in acks if isinstance(a, dict)] if isinstance(acks, list) else []


def matching_ack(report: dict, acks: list[dict]) -> dict | None:
    """The acknowledgement covering this broad result, if one does.

    Covered means the same principal and no category beyond those acknowledged.
    A narrower scope is still covered; a wider one never is.
    """
    if report["verdict"] != "broad":
        return None
    identity = report.get("identity") or {}
    if identity.get("principal_type") == "root":
        return None
    fingerprint = principal_fingerprint(identity)
    if fingerprint is None:
        return None
    current = set(finding_categories(report))
    for ack in acks:
        accepted = ack.get("categories")
        if ack.get("principal") != fingerprint or not isinstance(accepted, list):
            continue
        if current <= set(accepted):
            return ack
    return None


def write_ack(path: Path, report: dict, profile: str | None) -> dict:
    """Record the operator's acceptance of exactly the scope this run measured."""
    identity = report.get("identity") or {}
    if identity.get("principal_type") == "root":
        raise ValueError(
            "the account root user cannot be scoped, so it is never acknowledged; "
            "use an IAM role or user instead"
        )
    fingerprint = principal_fingerprint(identity)
    if fingerprint is None:
        raise ValueError(
            "the principal could not be identified, so there is nothing to acknowledge"
        )

    ack = {
        "principal": fingerprint,
        "profile": profile or "",
        "categories": finding_categories(report),
        "method": report["method"],
        "acknowledged_at": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat(),
    }
    # One entry per principal: a re-acknowledgement replaces the old scope rather
    # than accumulating, so the file always states what was last accepted.
    acks = [a for a in load_acks(path) if a.get("principal") != fingerprint]
    acks.append(ack)
    payload = {
        "version": ACK_SCHEMA_VERSION,
        "note": (
            "Broad AWS scopes an operator chose to continue with. Local state for "
            "check_permission_scope.py; delete this file to be asked again."
        ),
        "acknowledgements": acks,
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return ack


def print_report(report: dict) -> None:
    identity = report.get("identity")
    if identity:
        print(f"Identity : {identity['arn']}")
        print(f"Account  : {identity['account']}")
    print(f"Method   : {report['method'] or 'none — check did not run'}")
    print("")

    if report["verdict"] == "scoped":
        print("No probed action outside Bedrock inference is allowed.")
    elif report["verdict"] == "broad":
        print("This identity can do considerably more than Bedrock inference:")
        for finding in report["findings"]:
            if "actions" in finding:
                print(f"  {finding['category']}: {', '.join(finding['actions'])}")
            else:
                print(f"  {finding['category']}: {finding['detail']}")
        print("")
        print("Any prompt injection through indexed repository content, or any")
        print("compromised package in .venv_lb, inherits this scope. A least-privilege")
        print(
            "policy ships at skills/lb-setup/templates/bedrock-least-privilege-policy.json;"
        )
        print("consider a dedicated profile scoped to it.")
        ack = report.get("acknowledgement")
        if ack:
            print("")
            print(
                f"ACKNOWLEDGED on {ack['acknowledged_at']} for: "
                f"{', '.join(ack['categories'])}."
            )
            print("No category beyond those was found, so this is not asked again.")
            print("Delete the acknowledgement file to be asked on the next run.")
    else:
        print("The scope of this identity could not be determined.")

    if report["expected_denied"]:
        print("")
        print("Bedrock inference appears to be DENIED for:")
        for action in report["expected_denied"]:
            print(f"  {action}")
        print("LaunchBridge skills will fail until this is granted.")

    for note in report["notes"]:
        print(f"\nNote: {note}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report what the configured AWS identity can do beyond Bedrock."
    )
    parser.add_argument("--profile", help="AWS named profile to check")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    ack = parser.add_mutually_exclusive_group()
    ack.add_argument(
        "--ack-for-repo",
        metavar="DIR",
        help=(
            "keep acknowledgements for this repository in the user's LaunchBridge "
            "state directory, outside the repository; a covered result exits 3 "
            "instead of 1"
        ),
    )
    ack.add_argument(
        "--ack-file",
        help="file of acknowledged broad scopes, at an explicit path",
    )
    parser.add_argument(
        "--acknowledge",
        action="store_true",
        help=(
            "record the scope this run measures as accepted by the operator; pass "
            "only after the operator has chosen to continue"
        ),
    )
    args = parser.parse_args(argv)
    if args.ack_for_repo:
        args.ack_file = str(ack_path_for_repo(args.ack_for_repo))
        if (
            Path(args.ack_file)
            .resolve()
            .is_relative_to(Path(args.ack_for_repo).resolve())
        ):
            parser.error(
                f"{args.ack_file} is inside the repository; the LaunchBridge state "
                "directory (XDG_CONFIG_HOME or ~/.config) must be outside it"
            )

    if args.acknowledge and not args.ack_file:
        parser.error("--acknowledge requires --ack-for-repo or --ack-file")

    global TOOL_ROOT
    TOOL_ROOT = Path(args.ack_for_repo) if args.ack_for_repo else None
    if find_aws() is None:
        message = "the aws CLI is not installed or not on PATH"
        if args.json:
            print(json.dumps({"verdict": "inconclusive", "notes": [message]}, indent=2))
        else:
            print(f"Cannot check permission scope: {message}")
        return 2

    report = assess(args.profile)

    if args.ack_file and report["verdict"] == "broad":
        ack_path = Path(args.ack_file)
        if args.acknowledge:
            try:
                report["acknowledgement"] = write_ack(ack_path, report, args.profile)
            except (ValueError, OSError) as exc:
                report["notes"].append(f"not acknowledged: {exc}")
        else:
            report["acknowledgement"] = matching_ack(report, load_acks(ack_path))
    elif args.acknowledge:
        report["notes"].append(
            f"nothing to acknowledge: the scope is {report['verdict']}, not broad"
        )

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)

    if report["verdict"] == "broad" and report.get("acknowledgement"):
        return 3
    return {"scoped": 0, "broad": 1}.get(report["verdict"], 2)


if __name__ == "__main__":
    sys.exit(main())
