# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""No internal identifier reaches the published tree unnoticed.

WHY THIS FILE EXISTS. Secret scanners look for credentials. They do not look for the
identifiers that disclose where a project came from: a real AWS account ID in an ARN,
an internal git host in a clone URL, the name of an internal tool in a README.
ASH's detect-secrets does not flag these, so this test sweeps for them on every run.

It scans every tracked file — `git ls-files`, so it sees exactly what is published and
not the gigabytes of ignored local state beside it. It fails rather than skips when git
is missing, because a guard that silently does not run is how the original gap stayed
open.

KNOWN is the reviewed list of occurrences that are allowed for now. Each entry names the
file, the exact text, and why it is tolerated. An entry that no longer matches anything
fails too, so the list cannot quietly outlive the thing it excuses.
"""

from __future__ import annotations

import re
import shutil
import subprocess  # nosec B404 - fixed argv lists, shell=False, no user input
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
THIS_FILE = Path(__file__).resolve().relative_to(REPO_ROOT).as_posix()

# AWS's documented example account IDs. Anything else in an account position is
# treated as real.
PLACEHOLDER_ACCOUNTS = frozenset(
    {"123456789012", "111122223333", "444455556666", "000000000000", "012345678901"}
)

# A 12-digit number is an account ID only in a position that says so. Bare 12-digit
# numbers are too common (timestamps, sizes) to flag on their own.
ACCOUNT_PATTERNS = (
    # arn:aws:iam::123456789012:role/x, arn:aws-us-gov:s3:us-east-1:123456789012:...
    re.compile(r"arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12})"),
    # 123456789012.dkr.ecr.us-east-1.amazonaws.com
    re.compile(r"\b(\d{12})\.dkr\.ecr\."),
    # account_id = "123456789012", "AccountId": "123456789012", --account-id 1234...
    re.compile(r"account[_-]?id[\"'\s]*[:=\s]\s*[\"']?(\d{12})\b", re.IGNORECASE),
    # "Account": "123456789012" (sts get-caller-identity output)
    re.compile(r"\"Account\"\s*:\s*\"(\d{12})\""),
)

# Internal hosts and internal tool names. Public AWS and Amazon domains
# (aws.amazon.com, docs.aws.amazon.com, www.amazon.com, amazonaws.com) are not here.
INTERNAL_PATTERNS = (
    re.compile(r"\bcode\.aws\.dev\b", re.IGNORECASE),
    re.compile(r"\bgitlab\.aws\.dev\b", re.IGNORECASE),
    re.compile(r"\b[\w-]+\.amazon\.dev\b", re.IGNORECASE),
    re.compile(r"\ba2z\.com\b", re.IGNORECASE),
    re.compile(r"\bcorp\.amazon\.com\b", re.IGNORECASE),
    re.compile(r"\bcode\.amazon\.com\b", re.IGNORECASE),
    re.compile(r"\bw\.amazon\.com\b", re.IGNORECASE),
    re.compile(r"\bisengard", re.IGNORECASE),
    re.compile(r"\bmidway\.(?:amazon|a2z)", re.IGNORECASE),
    re.compile(r"\bnpmpm\b", re.IGNORECASE),
)

# (path, exact text on the line, reason). Reviewed 2026-09-29.
KNOWN: tuple[tuple[str, str, str], ...] = ()


def scan_text(path: str, text: str) -> list[tuple[str, int, str, str]]:
    """Return (path, line number, kind, matched text) for every finding in one file."""
    findings = []
    for number, line in enumerate(text.splitlines(), start=1):
        for pattern in ACCOUNT_PATTERNS:
            for match in pattern.finditer(line):
                if match.group(1) not in PLACEHOLDER_ACCOUNTS:
                    findings.append((path, number, "account id", match.group(1)))
        for pattern in INTERNAL_PATTERNS:
            for match in pattern.finditer(line):
                findings.append((path, number, "internal identifier", match.group(0)))
    return findings


def is_known(path: str, line: str) -> bool:
    return any(path == kpath and ktext in line for kpath, ktext, _ in KNOWN)


def tracked_files() -> list[str]:
    if shutil.which("git") is None:
        pytest.fail(
            "git is required: this guard scans exactly what `git ls-files` publishes"
        )
    result = subprocess.run(  # nosec B603 - fixed argv, shell=False
        ["git", "ls-files", "-z"],
        capture_output=True,
        check=True,
        cwd=REPO_ROOT,
    )
    return [p for p in result.stdout.decode("utf-8").split("\0") if p]


def read_text(path: str) -> str | None:
    """Tracked text content, or None for binaries and files missing from the tree."""
    full = REPO_ROOT / path
    try:
        data = full.read_bytes()
    except OSError:
        return None  # tracked but deleted locally; git status will show it
    if b"\0" in data[:8192]:
        return None
    return data.decode("utf-8", errors="replace")


def repository_findings() -> tuple[list[tuple[str, int, str, str]], set[int]]:
    """All unexcused findings, and the indexes of KNOWN entries that matched."""
    unexcused = []
    used: set[int] = set()
    for path in tracked_files():
        if path == THIS_FILE:
            continue  # the patterns above would match themselves
        text = read_text(path)
        if text is None:
            continue
        lines = text.splitlines()
        for finding in scan_text(path, text):
            line = lines[finding[1] - 1]
            matched = [
                i for i, (kp, kt, _) in enumerate(KNOWN) if kp == path and kt in line
            ]
            if matched:
                used.update(matched)
            else:
                unexcused.append(finding)
    return unexcused, used


# ------------------------------------------------------------- the guard itself


def test_no_unreviewed_internal_identifier_is_tracked():
    unexcused, _ = repository_findings()
    report = "\n".join(f"  {p}:{n}  {kind}: {text}" for p, n, kind, text in unexcused)
    assert not unexcused, (
        "Internal identifiers in tracked files. Replace real account IDs with "
        "123456789012 and remove internal hosts or tool names; if one must stay, add "
        "it to KNOWN with its reason:\n" + report
    )


def test_every_known_exception_still_matches():
    """An exception whose text is gone is excusing nothing and must be removed."""
    _, used = repository_findings()
    stale = [
        f"  {KNOWN[i][0]}: {KNOWN[i][1]}" for i in range(len(KNOWN)) if i not in used
    ]
    assert not stale, "KNOWN entries no longer match anything:\n" + "\n".join(stale)


# ----------------------------------------------------------- the rules have teeth

# A 12-digit value that is not one of AWS's documented placeholders. Built at
# runtime so this file holds no account-ID-shaped literal of its own.
FAKE_ACCOUNT = "9182" + "73645546"


@pytest.mark.parametrize(
    "line",
    [
        f'role = "arn:aws:iam::{FAKE_ACCOUNT}:role/Admin"',
        f"image: {FAKE_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/app:latest",
        f'account_id = "{FAKE_ACCOUNT}"',
        f'{{"Account": "{FAKE_ACCOUNT}", "Arn": "x"}}',
        f"--account-id {FAKE_ACCOUNT}",
        f'"AccountId": "{FAKE_ACCOUNT}"',
        f"arn:aws-us-gov:s3:us-gov-west-1:{FAKE_ACCOUNT}:bucket",
    ],
)
def test_real_account_ids_are_caught(line):
    assert scan_text("x", line), line


@pytest.mark.parametrize(
    "line",
    [
        'role = "arn:aws:iam::123456789012:role/Admin"',
        "arn:aws:sts::111122223333:assumed-role/DevRole/alice",
        "timestamp 173512345678 in ms",
        "arn:aws:s3:::my-bucket/key",
        "https://docs.aws.amazon.com/cli/latest/userguide/",
        "https://www.amazon.com",
        "If the write fails midway, the file is left untouched.",
    ],
)
def test_placeholders_and_public_text_pass(line):
    assert not scan_text("x", line), line


def host(*labels: str) -> str:
    """A hostname built at runtime, so this file holds no internal hostname literal."""
    return ".".join(labels)


@pytest.mark.parametrize(
    "line",
    [
        f"git clone ssh://git@{host('ssh', 'code', 'aws', 'dev')}/group/repo.git",
        f"see https://{host('code', 'amazon', 'com')}/packages/Thing",
        f"https://{host('w', 'amazon', 'com')}/bin/view/Team",
        "isen" + "gardcli assume 1 --role Admin",
        f"https://{host('midway', 'amazon', 'com')}/login",
        f"https://{host('tools', 'a2z', 'com')}/x",
        f"https://{host('npmpm', 'corp', 'amazon', 'com')}/pkg/x",
        f"https://{host('gitlab', 'aws', 'dev')}/group/repo",
        f"https://{host('portal', 'amazon', 'dev')}/",
    ],
)
def test_internal_identifiers_are_caught(line):
    assert scan_text("x", line), line


def test_known_exceptions_are_exact_not_file_wide(monkeypatch):
    """A second internal URL in an excused file is still a finding."""
    path, text = (
        "project_dependencies/pyproject.toml",
        f"git+ssh://git@{host('ssh', 'code', 'aws', 'dev')}/",
    )
    monkeypatch.setitem(globals(), "KNOWN", ((path, text, "sample entry"),))
    assert is_known(path, f"x = '{text}group/repo.git'")
    assert not is_known(
        path, f"x = 'https://{host('code', 'amazon', 'com')}/packages/Other'"
    )
    assert not is_known("some/other/file.toml", f"x = '{text}'")
