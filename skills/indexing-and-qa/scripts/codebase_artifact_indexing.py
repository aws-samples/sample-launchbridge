#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Codebase and artifact indexing script.

Usage:
    python codebase_artifact_indexing.py --config /path/to/inq_config.yaml --mode codebase
    python codebase_artifact_indexing.py --config /path/to/inq_config.yaml --mode artifact
    python codebase_artifact_indexing.py --config /path/to/inq_config.yaml --mode both
"""

import argparse
import datetime
import hashlib
import importlib
import json
import logging
import os
import re
import sys
import tempfile
import uuid
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Suppress urllib3/chardet version mismatch warning from requests
warnings.filterwarnings("ignore", message="urllib3.*doesn't match a supported version")

try:
    from iris.api import index_codebase_artifacts
except ImportError:
    print(
        "Error: iris package not found. Re-run lb-setup, which installs it into "
        ".venv_lb from the frozen constraints.txt.",
        file=sys.stderr,
    )
    sys.exit(1)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
log = logging.getLogger(__name__)


class WithholdFileContent(logging.Filter):
    """Keep file content out of the log.

    When a Bedrock call fails, IRIS logs the whole file it was summarizing
    ("src_str value: ..."). The log goes to stderr, which the coding agent reads
    and sends to its model provider, a destination no confirmation names.
    """

    _CONTENT = re.compile(r"src_str value: .*?(?=\n[a-z_]+ length: |\Z)", re.S)

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "src_str value:" in message:
            record.msg = self._CONTENT.sub(
                "src_str value: <withheld: the file's content>", message
            )
            record.args = ()
        return True


for _handler in logging.getLogger().handlers:
    _handler.addFilter(WithholdFileContent())

VALID_MODES = ("codebase", "artifact", "both")

# Ceiling on how much one invocation may send to Bedrock.
#
# Indexing issues at least one model call per file, at a concurrency equal to the
# number of model-region pairs configured. IRIS has no request cap, no spend cap
# and no throttle of its own -- its ThreadPoolExecutor takes max_workers but no
# ceiling on queue length -- and Bedrock enforces no per-request spend limit. So
# the only place a bound can be applied without forking an upstream dependency is
# here, before the call is made.
#
# These are LaunchBridge keys, not IRIS keys. IRIS deep-merges the config and
# ignores keys it does not recognise, so they travel in inq_config.yaml harmlessly.
#
# The defaults are set to catch a mistake, not to second-guess a deliberate large
# index: a wrong codebase_dir, or an ignore_patterns list that stopped matching
# after a repo restructure. A real engagement repo that genuinely exceeds them
# raises the value in config -- which is a durable, reviewable edit rather than a
# flag the calling agent could add to its own command line.
MAX_FILES_KEY = "lb_max_files_per_run"
MAX_ARTIFACTS_KEY = "lb_max_artifacts_per_run"
DEFAULT_MAX_FILES = 5000
DEFAULT_MAX_ARTIFACTS = 500

# Where repository content goes, confirmed once per engagement.
#
# Sending repository content to Bedrock is the product working as intended, and the
# customer's own account is the processing boundary. What the engagement's terms may
# restrict is *where*: which regions, which model providers, which other AWS services.
#
# So indexing refuses until someone has confirmed the exact set of destinations the
# configuration uses, and every run appends what it submitted to a local log. A run
# that sends project artifacts also needs the confirmation to record that those
# artifacts are cleared for the target account's data classification. The
# confirmation is consent given by the person running indexing, so it is stored
# outside the repository, in the user's LaunchBridge state directory, keyed to the
# repository's path and bound to the AWS account and principal that confirmed it.
# Nothing inside the repository can count as consent, whatever its name. The log is
# local too: it lists file paths and hashes, is per-machine, and grows with every run.
#
# Like the ceiling, there is no flag that skips the check. Confirming is a separate,
# explicit command that records what it measures, never what its caller asserts.
DATA_HANDLING_FILE = "data_handling_confirmation.json"
TRANSMISSION_LOG_REL = (
    Path(".lb_workspace") / "indexing_and_qa" / "transmission_log.jsonl"
)
DATA_HANDLING_VERSION = 1

# High-confidence credential patterns. A file to be sent that matches one is not
# sent: the run is refused and the file named, so the operator can remove the
# secret or add the file to ignore_patterns. Only the first SECRET_SCAN_MAX_BYTES
# of a codebase file are read; artifacts are read up to the size IRIS sends, and
# DOCX, PPTX, XLSX and PDF artifacts as the text IRIS extracts from them.
SECRET_PATTERNS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    ("private key", re.compile(rb"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")),
    # [ ] keeps this line from matching itself (the scan reads this file too).
    ("PGP private key", re.compile(rb"-----BEGIN PGP PRIVATE KEY[ ]BLOCK-----")),
    ("PuTTY private key", re.compile(rb"PuTTY-User-Key-File-\d+:")),
    ("AWS access key ID", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    (
        "AWS secret access key",
        re.compile(
            rb"(?i)aws_?secret_?access_?key[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9/+]{40}"
        ),
    ),
    ("GitHub token", re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{36,}")),
    ("Slack token", re.compile(rb"\bxox[abpors]-[A-Za-z0-9-]{10,}")),
    ("GitHub token", re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{60,}")),
    ("GitLab token", re.compile(rb"\bglpat-[A-Za-z0-9_-]{20,}")),
    ("Stripe secret key", re.compile(rb"\b[sr]k_live_[A-Za-z0-9]{20,}")),
    ("Google API key", re.compile(rb"\bAIza[0-9A-Za-z_-]{35}")),
    ("OpenAI API key", re.compile(rb"\bsk-proj-[A-Za-z0-9_-]{40,}")),
    (
        "Slack webhook",
        re.compile(
            rb"https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+"
        ),
    ),
    (
        "password in a URL",
        # Placeholders that make up the whole password are left out:
        # documentation and templates are full of `user:password@`, `${PASS}`,
        # `$(PASS)`, `$pass`, `<pw>`, `{{pw}}`, `{pw}`, `%(pw)s` and `%{pw}`, alone
        # or in a row. A `$` name in mixed case (`$Ummer2024`) reads as a real
        # password. A real password may hold any of those characters.
        # The look-ahead bounds the work at each `scheme://user:` to the 128
        # characters a password can have, and the two `$name` forms can't match
        # the same text, so no input makes the placeholder check backtrack.
        re.compile(
            rb"(?i)\b[a-z][a-z0-9+.-]{1,20}://[^\s/:@'\"]{0,64}:"
            rb"(?=[^\s/@'\"]{3,128}@)"
            rb"(?!(?:password|passwd|pass|pwd|secret|changeme|example|x+|\*+"
            rb"|(?:\$\{[^}\s@]*\}|\$\([^)\s@]*\)|(?-i:\$[A-Z_][A-Z0-9_]*|\$(?=[0-9_]*[a-z])[a-z_][a-z0-9_]*)|<[^>\s@]*>"
            rb"|\{\{[^}\s@]*\}\}|\{[^}\s@]*\}|%\([^)\s@]*\)s|%\{[^}\s@]*\})+)@)"
            rb"[^\s/@'\"]{3,128}@(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)"
        ),
    ),
)
# AWS's documented example credentials, common in docs and tests. Assembled from
# parts so this file holds no credential-shaped literal of its own.
SECRET_EXAMPLES = (
    b"AKIA" + b"IOSFODNN7" + b"EXAMPLE",
    b"wJalrXUtnFEMI" + b"/K7MDENG/" + b"bPxRfiCY" + b"EXAMPLEKEY",
)
SECRET_SCAN_MAX_BYTES = 5 * 1024 * 1024


@dataclass
class ScopeReport:
    """What one run would send to Bedrock, measured as IRIS itself resolves it."""

    config_path: Path
    codebase_dir: str
    mode: str
    ignore_pattern_count: int
    model_pairs: int
    regions: list[str]
    max_files: int
    max_artifacts: int
    artifact_max_workers: int
    # None means "this mode does not touch that half of the pipeline".
    files_to_process: int | None = None
    total_files: int | None = None
    artifact_dir: str | None = None
    artifacts_to_process: int | None = None
    total_artifacts: int | None = None
    # The paths themselves, for the transmission log.
    file_paths: list[str] = field(default_factory=list)
    artifact_paths: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Destination:
    """One place repository content is sent. `key` is what confirmation compares."""

    key: str
    service: str
    detail: str
    used_for: str

    def as_dict(self) -> dict[str, str]:
        return {
            "key": self.key,
            "service": self.service,
            "detail": self.detail,
            "used_for": self.used_for,
        }


def default_aws_region() -> str:
    """The region a client created without one would use; Textract is created so."""
    try:
        import boto3

        return boto3.session.Session().region_name or "unresolved"
    except Exception:
        return "unresolved"


def _role_arn_paths(value: Any, path: str) -> list[str]:
    if isinstance(value, dict):
        found = []
        for key, item in value.items():
            where = f"{path}.{key}" if path else str(key)
            if str(key).lower() == "role_arn":
                found.append(where)
            found += _role_arn_paths(item, where)
        return found
    if isinstance(value, list):
        return [
            p
            for i, item in enumerate(value)
            for p in _role_arn_paths(item, f"{path}[{i}]")
        ]
    return []


def cross_account_settings(config: dict[str, Any]) -> list[str]:
    """Settings that send Bedrock calls through another IAM role.

    With `use_super_profile`, IRIS's orchestrator assumes the configured ROLE_ARN,
    which can be in another AWS account, and calls Bedrock as that role in
    us-east-1. A destination key names a model and a region, not an account, so a
    confirmation could not cover it.
    """
    found = ["use_super_profile"] if config.get("use_super_profile") else []
    return found + _role_arn_paths(config, "")


# Top-level settings IRIS (at the pinned commit) or LaunchBridge reads, and two that
# older LaunchBridge templates wrote and nothing reads. Any other key is refused, so a
# setting a later IRIS version adds is reviewed before LaunchBridge runs with it.
KNOWN_CONFIG_KEYS = frozenset(
    {
        "artifact_dir",
        "artifact_generate_knowledge_base",
        "artifact_max_file_size",
        "artifact_max_workers",
        "artifact_ocr_enabled",
        "artifact_ocr_max_pages",
        "artifact_ocr_provider",
        "artifact_transcribe_s3_bucket",
        "artifact_transcription_enabled",
        "artifact_video_max_file_size",
        "bypass_tool_consent",
        "cache_ttl",
        "codebase_dir",
        "context_file",
        "context_window_size",
        "conversation_history_filename",
        "enable_prompt_caching",
        "file_editing",
        "file_retrieval",
        "guardrail_id",
        "guardrail_version",
        "ignore_patterns",
        "include_monitoring",
        "lb_max_artifacts_per_run",
        "lb_max_files_per_run",
        "max_file_size",
        "max_notebook_size",
        "mcp_enabled_tools",
        "mcp_servers",
        "model_configuration",
        "output_dir",
        "prompt_optimization",
        "use_super_profile",
        "web_search",
    }
)

# Settings that would make IRIS send content, read files, write logs or let tools act
# beyond what the data-handling confirmation covers, with why. Each must be unset or
# false in the user's file, and is forced to its safe value before IRIS runs, so
# IRIS's own template defaults (web_search and bypass_tool_consent are true there)
# never apply.
SAFE_SETTINGS = {
    "web_search": (False, "sends model-written queries to a web search service"),
    "context_file": ("", "adds a file the index never scanned to every prompt"),
    "bypass_tool_consent": (False, "lets tools act without asking"),
    "include_monitoring": (False, "writes full tool output to log files"),
}

_AWS_REGION = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d{1,2}$")


def _model_entries(config: dict[str, Any]) -> list[tuple[str, Any]]:
    models = config.get("model_configuration")
    if not isinstance(models, dict):
        return []
    entries = []
    summarizer = models.get("file_summarizer")
    if isinstance(summarizer, dict) and "models" in summarizer:
        listed = summarizer["models"]
        if isinstance(listed, list):
            entries += [
                (f"file_summarizer.models[{i}]", m) for i, m in enumerate(listed)
            ]
        else:
            entries.append(("file_summarizer.models", listed))
    for section in ("orchestrator", "file_identifier"):
        if section in models:
            entries.append((section, models[section]))
    return entries


def unsafe_settings(config: dict[str, Any]) -> list[str]:
    """Every setting in `config` that LaunchBridge refuses, each with the reason."""
    problems = [
        f"{where}: sends Bedrock calls through another IAM role, possibly in "
        "another AWS account"
        for where in cross_account_settings(config)
    ]
    problems += [
        f"{key}: not a setting LaunchBridge allows"
        for key in sorted(str(k) for k in config if k not in KNOWN_CONFIG_KEYS)
    ]
    for key, (_safe, reason) in SAFE_SETTINGS.items():
        if config.get(key):
            problems.append(f"{key}: {reason}")
    servers = config.get("mcp_servers")
    if isinstance(servers, dict):
        for name, server in servers.items():
            if not isinstance(server, dict):
                problems.append(f"mcp_servers.{name}: must be a mapping")
            elif server.get("enabled"):
                problems.append(
                    f"mcp_servers.{name}.enabled: starts a command and gives its "
                    "tools to the Q&A model"
                )
    elif servers:
        problems.append("mcp_servers: must be a mapping")
    codebase, output = config.get("codebase_dir"), config.get("output_dir")
    if "output_dir" in config and not (isinstance(output, str) and output.strip()):
        # IRIS reads an empty value as the codebase itself, where nothing checks
        # the index for links or tracked files.
        problems.append("output_dir: must name a folder")
    elif codebase and output:
        root = Path(str(codebase)).resolve()
        if not (root / str(output)).resolve().is_relative_to(root):
            problems.append("output_dir: outside codebase_dir")
    for where, entry in _model_entries(config):
        if not (
            isinstance(entry, dict)
            and isinstance(entry.get("model_id"), str)
            and entry["model_id"]
            and isinstance(entry.get("region"), str)
            and _AWS_REGION.fullmatch(entry["region"])
        ):
            problems.append(
                f"model_configuration.{where}: needs a model_id and an AWS region "
                "such as us-east-1"
            )
    return problems


def force_safe_settings(config: dict[str, Any]) -> dict[str, Any]:
    """`config` with every SAFE_SETTINGS key at its safe value and MCP servers off."""
    safe = dict(config)
    safe.update({key: value for key, (value, _reason) in SAFE_SETTINGS.items()})
    servers = safe.get("mcp_servers")
    if isinstance(servers, dict):
        safe["mcp_servers"] = {
            name: dict(server, enabled=False) if isinstance(server, dict) else server
            for name, server in servers.items()
        }
    return safe


def pin_iris_config(config: dict[str, Any], config_path: Any) -> None:
    """Keep IRIS on `config` for the rest of this process.

    IRIS calls set_config_path() again when it starts, which clears its cache, so
    it would re-read the file: an edit made after the checks, or IRIS's own merge
    of the file, would then run in place of the config that was checked. Every
    reference to set_config_path in a loaded IRIS module is replaced by one that
    keeps `config` and refuses any other path.
    """
    from iris.utils import utils as iris_utils

    pinned = Path(config_path).resolve()
    current = iris_utils.set_config_path
    original = getattr(current, "_lb_original", current)

    def set_config_path(path: Any) -> None:
        if Path(path).resolve() != pinned:
            raise ValueError(
                f"IRIS was asked to load {path}; this process runs with {pinned} only"
            )
        iris_utils._config_path_override = pinned
        iris_utils._cached_config = config

    set_config_path._lb_original = original  # type: ignore[attr-defined]
    for name, module in list(sys.modules.items()):
        if module is None or name.split(".")[0] not in ("iris", "iris_mcp"):
            continue
        held = vars(module).get("set_config_path")
        if held is original or getattr(held, "_lb_original", None) is original:
            setattr(module, "set_config_path", set_config_path)
    iris_utils._config_path_override = pinned
    iris_utils._cached_config = config


def other_repository(config: dict[str, Any], config_path: Any) -> str | None:
    """Why codebase_dir is not the repository holding the config, or None.

    inq_config.yaml lives at <repository>/.lb_workspace/indexing_and_qa/, and the
    confirmation, the ceilings and the log apply to the directory it names, so a
    codebase_dir anywhere else (a parent folder, another repository) is refused.
    """
    named = config.get("codebase_dir")
    if not named or not Path(str(named)).is_absolute():
        return f"codebase_dir ({named}) must be the repository's absolute path"
    repo = Path(str(named)).resolve()
    expected = repo / ".lb_workspace" / "indexing_and_qa" / "inq_config.yaml"
    if Path(str(config_path)).resolve() != expected:
        return (
            f"codebase_dir ({named}) is not the repository this inq_config.yaml "
            f"belongs to; the config must be at {expected}, through no symbolic link"
        )
    return None


class UnsafeConfig(ValueError):
    """The config has settings LaunchBridge refuses (see unsafe_settings)."""


def refuse_other_repository(config: dict[str, Any], config_path: Any) -> None:
    problem = other_repository(config, config_path)
    if problem:
        raise UnsafeConfig(problem + ". Set it to that repository's path.")


def refuse_unsafe(config: dict[str, Any]) -> None:
    problems = unsafe_settings(config)
    if problems:
        raise UnsafeConfig(
            "the config has settings LaunchBridge refuses, because they would send "
            "content, read files or run commands outside what the data-handling "
            "confirmation covers: " + "; ".join(problems) + ". Remove or correct "
            "them in inq_config.yaml."
        )


# Where Bedrock may process a request for a cross-region inference profile,
# named by the model ID's prefix.
PROFILE_SCOPES = {
    "us": "any US region",
    "us-gov": "any AWS GovCloud (US) region",
    "eu": "any EU region",
    "apac": "any Asia Pacific region",
    "jp": "any Japan region",
    "au": "any Australia region",
    "ca": "any Canada region",
    "global": "any commercial AWS region",
}


def profile_scope(model_id: str) -> str | None:
    """Where a request for `model_id` may be processed: None for one region's
    model (`provider.model`), the geography for a cross-region inference
    profile (`us.provider.model`, also as an inference-profile ARN), and
    "an unknown set of regions" when that can't be told from the ID."""
    name = model_id
    if model_id.startswith("arn:"):
        # arn:partition:service:region:account:resource; model IDs hold ":" too.
        kind, _, name = model_id.split(":", 5)[-1].partition("/")
        if kind == "foundation-model":
            return None
        if kind == "application-inference-profile":
            return "an unknown set of regions (an application inference profile)"
        if kind != "inference-profile" or name.count(".") < 2:
            return "an unknown set of regions"
    parts = name.split(".")
    if len(parts) < 3:
        return None
    return PROFILE_SCOPES.get(parts[0].lower(), "an unknown set of regions")


def resolve_destinations(config: dict[str, Any]) -> list[Destination]:
    """Every destination the merged IRIS config sends content to, indexing and Q&A.

    Q&A destinations (orchestrator, file_identifier) are included even though this
    script only indexes: the confirmation is about the engagement's configuration,
    and Q&A sends indexed excerpts to those models at query time. A config with a
    setting LaunchBridge refuses (unsafe_settings) raises UnsafeConfig, so it can be
    neither confirmed nor run.
    """
    refuse_unsafe(config)
    models = config.get("model_configuration") or {}
    found: dict[str, Destination] = {}

    def bedrock(entry: Any, used_for: str) -> None:
        if not isinstance(entry, dict) or not entry.get("model_id"):
            return
        model_id, region = str(entry["model_id"]), str(entry.get("region") or "")
        key = f"bedrock:{model_id}@{region}"
        if key not in found:
            scope = profile_scope(model_id)
            detail = f"{model_id} in {region}" + (
                f" (may be processed in {scope})" if scope else ""
            )
            found[key] = Destination(key, "amazon-bedrock", detail, used_for)

    # file_summarizer models also serve artifact summaries, LLM OCR and video frames.
    for entry in (models.get("file_summarizer") or {}).get("models") or []:
        bedrock(entry, "indexing")
    for section in ("orchestrator", "file_identifier"):
        bedrock(models.get(section), "q&a")

    if config.get("artifact_dir"):
        if (
            config.get("artifact_ocr_enabled", False)
            and str(config.get("artifact_ocr_provider", "llm")).lower() == "textract"
        ):
            region = default_aws_region()
            key = f"textract@{region}"
            found[key] = Destination(
                key, "amazon-textract", f"default AWS region ({region})", "artifact OCR"
            )
        if config.get("artifact_transcription_enabled", False):
            bucket = str(config.get("artifact_transcribe_s3_bucket") or "")
            key = f"transcribe:s3://{bucket}"
            found[key] = Destination(
                key,
                "amazon-transcribe",
                f"via s3://{bucket}, in that bucket's region",
                "video transcription",
            )

    return sorted(found.values(), key=lambda d: d.key)


def state_dir() -> Path:
    """The user's LaunchBridge state directory, outside every repository.

    A relative XDG_CONFIG_HOME is ignored, as the XDG spec requires: it would
    resolve against the working directory, which can be the repository itself.
    """
    base = os.environ.get("XDG_CONFIG_HOME", "")
    if not os.path.isabs(base):
        base = str(Path.home() / ".config")
    return Path(base) / "launchbridge"


def repo_state_dir(codebase_dir: str) -> Path:
    """Per-repository state, keyed to the repository's resolved path."""
    resolved = str(Path(codebase_dir).resolve())
    key = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16]
    return state_dir() / "repos" / key


def confirmation_path(codebase_dir: str) -> Path:
    return repo_state_dir(codebase_dir) / DATA_HANDLING_FILE


def sts_client() -> Any:
    """An STS client with short timeouts, so an unreachable endpoint fails quickly."""
    import boto3
    from botocore.config import Config

    config = Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 2})
    return boto3.client("sts", config=config)


_ASSUMED_ROLE_ARN = re.compile(r"^arn:aws[\w-]*:sts::\d{12}:assumed-role/([^/]+)/")


def caller_principal() -> str | None:
    """A stable fingerprint of the AWS account and principal of this session.

    An assumed role is identified by its role name, not the session ARN, whose
    session suffix changes on every login. None when the identity cannot be read,
    in which case no confirmation matches.
    """
    try:
        ident = sts_client().get_caller_identity()
    except Exception:
        log.debug("get-caller-identity failed:", exc_info=True)
        return None
    account, arn = ident.get("Account") or "", ident.get("Arn") or ""
    if not account or not arn:
        return None
    match = _ASSUMED_ROLE_ARN.match(arn)
    principal = f"role/{match.group(1)}" if match else arn
    return hashlib.sha256(f"{account}\0{principal}".encode("utf-8")).hexdigest()


def load_confirmation(
    path: Path, principal: str | None, codebase_dir: str
) -> dict[str, Any] | None:
    """The recorded confirmation, or None.

    An unreadable file confirms nothing, and neither does one made by a different
    AWS account or principal, or for a different repository path, or when the
    current principal cannot be identified, or one stored inside the repository
    (an absolute XDG_CONFIG_HOME can point there).
    """
    if principal is None:
        return None
    if Path(path).resolve().is_relative_to(Path(codebase_dir).resolve()):
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("version") != DATA_HANDLING_VERSION:
        return None
    if not isinstance(data.get("destinations"), list):
        return None
    if data.get("principal") != principal:
        return None
    if data.get("codebase_dir") != str(Path(codebase_dir).resolve()):
        return None
    return data


def unconfirmed_destinations(
    destinations: list[Destination], confirmation: dict[str, Any] | None
) -> list[Destination]:
    """Destinations the confirmation does not cover. A narrower set stays covered."""
    confirmed = set()
    if confirmation:
        confirmed = {
            d.get("key") for d in confirmation["destinations"] if isinstance(d, dict)
        }
    return [d for d in destinations if d.key not in confirmed]


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_confirmation(
    path: Path,
    destinations: list[Destination],
    basis: str,
    artifact_classification: str = "",
    *,
    principal: str,
    codebase_dir: str,
    artifact_dir: str = "",
) -> dict[str, Any]:
    """Record that these destinations are permitted. Replaces any earlier record.

    Refuses (ValueError) to write the record inside the repository.

    `artifact_classification`, when given, records that the project artifacts are
    cleared for the target account's data classification (the operator's words,
    e.g. "Internal, cleared by the engagement lead"). Artifact runs require it.
    """
    if Path(path).resolve().is_relative_to(Path(codebase_dir).resolve()):
        raise ValueError(
            f"{path} is inside the repository; the LaunchBridge state directory "
            "(XDG_CONFIG_HOME or ~/.config) must be outside it"
        )
    record = {
        "version": DATA_HANDLING_VERSION,
        "note": (
            "Destinations this engagement's data-handling terms permit repository "
            "content to be sent to. Written by codebase_artifact_indexing.py "
            "--confirm-data-handling after the user confirmed them, for this "
            "repository and this AWS account and principal; indexing refuses any "
            "destination not listed."
        ),
        "codebase_dir": str(Path(codebase_dir).resolve()),
        "principal": principal,
        "confirmed_at": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat(),
        "basis": basis,
        "destinations": [d.as_dict() for d in destinations],
    }
    if artifact_classification:
        record["artifact_classification"] = artifact_classification
        record["artifact_dir"] = (
            str(Path(artifact_dir).resolve()) if artifact_dir else ""
        )
    _atomic_write(path, json.dumps(record, indent=2) + "\n")
    return record


def artifacts_cleared(confirmation: dict[str, Any] | None, artifact_dir: Any) -> bool:
    """Whether the confirmation clears the artifacts in this artifact folder.

    The clearance names the folder it was given for, so pointing artifact_dir at
    another folder needs the user's answer again.
    """
    confirmation = confirmation or {}
    return bool(
        artifact_dir
        and confirmation.get("artifact_classification")
        and confirmation.get("artifact_dir") == str(Path(str(artifact_dir)).resolve())
    )


def format_destinations(destinations: list[Destination]) -> list[str]:
    return [f"  - {d.service}: {d.detail}  [{d.used_for}]" for d in destinations]


def format_unconfirmed(
    config_path: Path, codebase_dir: str, missing: list[Destination]
) -> str:
    return "\n".join(
        [
            f"Refusing to index: content from {codebase_dir} would be sent to",
            "destinations this engagement has not confirmed are permitted by its",
            "data-handling terms.",
            *format_destinations(missing),
            "",
            "Ask the user whether the engagement's terms allow each destination above.",
            "If they do, record it (this measures the config; it sends nothing):",
            f"  codebase_artifact_indexing.py --config {config_path} "
            "--confirm-data-handling",
            f"The record is written to {confirmation_path(codebase_dir)}, outside the",
            "repository, for this repository and the current AWS account and principal.",
            "If they do not, remove those destinations from model_configuration (or",
            "the artifact OCR / transcription settings) and run again.",
        ]
    )


def file_digest(path: Path) -> tuple[str | None, int | None]:
    """SHA-256 and size, or (None, None) if the file vanished since listing."""
    try:
        hasher = hashlib.sha256()
        size = 0
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                hasher.update(block)
                size += len(block)
        return hasher.hexdigest(), size
    except OSError:
        return None, None


def _entries(paths: list[str], root: str | None) -> list[dict[str, Any]]:
    out = []
    for rel in paths:
        full = Path(rel) if Path(rel).is_absolute() or not root else Path(root) / rel
        digest, size = file_digest(full)
        out.append({"path": rel, "sha256": digest, "bytes": size})
    return out


def _scan_views(data: bytes) -> list[bytes]:
    """The bytes as read and, when they look like UTF-16 text, that text as UTF-8.

    IRIS detects a file's encoding before it sends the text, so a UTF-16 file
    (Windows PowerShell's default for `>`) reaches Bedrock as readable text even
    though its bytes, with a NUL between characters, match no pattern.
    """
    views = [data]
    if data[:2] in (b"\xff\xfe", b"\xfe\xff") or b"\x00" in data[:4096]:
        for encoding, width in (
            ("utf-32", 4),
            ("utf-32-le", 4),
            ("utf-32-be", 4),
            ("utf-16", 2),
            ("utf-16-le", 2),
            ("utf-16-be", 2),
        ):
            try:
                whole = data[: len(data) // width * width]
                views.append(whole.decode(encoding).encode("utf-8"))
            except UnicodeDecodeError:
                continue
    return views


def _notebook_text(path: Path) -> bytes | None:
    """A notebook as IRIS sends it: the whole file, every key and string in it,
    with only the outputs IRIS removes (PNG and JPEG under a cell output's data)
    left out.

    IRIS reads the whole notebook, so a cell after more than SECRET_SCAN_MAX_BYTES
    of plots is still sent, and JSON escaping hides a quoted key from the byte
    patterns.
    """
    try:
        notebook = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None
    # IRIS's remove_images_from_notebook, step for step: it stops at the first
    # output it can't handle and sends the rest of the notebook unchanged.
    try:
        for cell in notebook["cells"]:
            if "outputs" in cell:
                for output in cell["outputs"]:
                    if "data" in output:
                        if "image/png" in output["data"]:
                            output["data"]["image/png"] = ""
                        if "image/jpeg" in output["data"]:
                            output["data"]["image/jpeg"] = ""
    except Exception:  # nosec B110 - IRIS catches everything here too
        pass
    strings: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, str):
            strings.append(value)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for name, item in value.items():
                strings.append(str(name))
                walk(item)

    walk(notebook)
    # Also the text IRIS sends, json.dumps of what is left.
    return "\n".join(strings).encode("utf-8") + b"\n" + json.dumps(notebook).encode()


def _decoded_as_iris_would(data: bytes) -> bytes | None:
    """Non-UTF-8 text decoded with the encoding IRIS detects (EBCDIC, for one),
    as UTF-8; None for UTF-8 text or when chardet isn't available."""
    try:
        data.decode("utf-8")
        return None
    except UnicodeDecodeError:
        pass
    try:
        import chardet
    except ImportError:
        return None
    encoding = chardet.detect(data)["encoding"] or "latin-1"
    try:
        return data.decode(encoding, errors="replace").encode("utf-8")
    except LookupError:
        return None


def _extracted_text(path: Path) -> bytes | None:
    """The text IRIS extracts from a DOCX, PPTX, XLSX or PDF artifact (with OCR
    off, so nothing leaves the machine), as UTF-8; None for other files or when
    the extractor can't read it. The container's bytes are compressed, so the
    patterns can't see a key in a paragraph, a slide's notes or a cell."""
    names = {
        ".docx": "extract_from_docx",
        ".pptx": "extract_from_pptx",
        ".xlsx": "extract_from_xlsx",
        ".pdf": "extract_from_pdf",
    }
    name = names.get(path.suffix.lower())
    if name is None:
        return None
    try:
        extractors = importlib.import_module("iris.artifacts.artifact_extractors")
        extract = getattr(extractors, name)
        text = (
            extract(path)
            if name == "extract_from_xlsx"
            else extract(path, ocr_enabled=False)
        )
    except Exception:  # IRIS sends nothing it can't extract either
        log.debug("Could not extract %s for the credential scan", path, exc_info=True)
        return None
    return str(text).encode("utf-8")


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def scan_for_secrets(
    paths: list[str],
    root: str | None,
    max_bytes: int = SECRET_SCAN_MAX_BYTES,
    documents: bool = False,
    extract_max_bytes: int | None = None,
) -> list[tuple[str, str]]:
    """(path, kind) for each file that appears to contain a credential.

    Reads up to `max_bytes` of each file: artifacts are scanned up to the size
    IRIS sends whole (artifact_max_file_size), and with `documents` the text
    IRIS extracts from Office and PDF artifacts too, for files no larger than
    `extract_max_bytes`: IRIS skips larger artifacts, and extracting them costs
    memory and time for nothing.
    """
    hits = []
    for rel in paths:
        full = Path(rel) if Path(rel).is_absolute() or not root else Path(root) / rel
        try:
            with open(full, "rb") as handle:
                data = handle.read(max_bytes)
        except OSError:
            continue
        views = _scan_views(data)
        decoded = _decoded_as_iris_would(data)
        if decoded is not None:
            views.append(decoded)
        if full.suffix.lower() == ".ipynb":
            text = _notebook_text(full)
            if text is not None:
                views.append(text)
        if documents and (
            extract_max_bytes is None or _size(full) <= extract_max_bytes
        ):
            text = _extracted_text(full)
            if text is not None:
                views.append(text)
        for kind, pattern in SECRET_PATTERNS:
            if any(
                not any(example in m.group(0) for example in SECRET_EXAMPLES)
                for view in views
                for m in pattern.finditer(view)
            ):
                hits.append((rel, kind))
                break
    return hits


def format_secret_refusal(config_path: Path, hits: list[tuple[str, str]]) -> str:
    return "\n".join(
        [
            "Refusing to index: these files appear to contain credentials and would",
            "be sent to Amazon Bedrock:",
            *(f"  - {path}  ({kind})" for path, kind in hits),
            "",
            "Remove the secret from the file, or add the file to ignore_patterns in",
            f"{config_path}, then run again.",
        ]
    )


def unbounded_ceilings(mode: str, max_files: int, max_artifacts: int) -> list[str]:
    """Ceilings set to 0 that apply to this mode."""
    off = []
    if mode in ("codebase", "both") and max_files == 0:
        off.append(MAX_FILES_KEY)
    if mode in ("artifact", "both") and max_artifacts == 0:
        off.append(MAX_ARTIFACTS_KEY)
    return off


def transmission_log_path(codebase_dir: str) -> Path:
    return Path(codebase_dir) / TRANSMISSION_LOG_REL


def append_log(path: Path, entry: dict[str, Any]) -> None:
    """Append one JSON line. Raises on failure: an unrecorded send must not happen."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def now_iso() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    )


# IRIS modules that read the config once, when they are imported, and keep that copy.
# They are imported before set_config_path() can run, so each one holds IRIS's
# packaged template instead of the user's config. bind_iris_config() replaces them.
IRIS_CAPTURED_CONFIGS = (
    ("iris.summarize.file_summarizer", "_DEFAULT_CONFIG"),
    ("iris.agents.file_retrieval_agent", "_DEFAULT_CONFIG"),
    ("iris.agents.artifact_retrieval_agent", "_DEFAULT_CONFIG"),
    ("iris.agents.code_search_tool", "_DEFAULT_CONFIG"),
    ("iris.file_system.file_utils", "CONFIG"),
)


class IrisConfigMismatch(RuntimeError):
    """An IRIS module holds a config other than the one this run resolved."""


def _stale_iris_configs(merged: dict[str, Any]) -> list[str]:
    """Every loaded IRIS module attribute holding a config other than `merged`.

    Looks at all loaded `iris.*` and `iris_mcp.*` modules, not only the known ones, so a capture
    added by a later IRIS version is caught instead of silently used.
    """
    models = merged.get("model_configuration")
    stale = []
    for name, module in list(sys.modules.items()):
        if module is None or name.split(".")[0] not in ("iris", "iris_mcp"):
            continue
        for attr, value in list(vars(module).items()):
            if not isinstance(value, dict) or value is merged or value is models:
                continue
            if "model_configuration" in value or {
                "file_summarizer",
                "file_identifier",
            } & set(value):
                stale.append(f"{name}.{attr}")
    return sorted(stale)


def bind_iris_config(user_config: dict[str, Any]) -> dict[str, Any]:
    """Make IRIS run with exactly `user_config` over its packaged defaults.

    Refuses (UnsafeConfig) a file with a setting LaunchBridge doesn't allow, builds
    the merged config with IRIS's own template and merge, forces the SAFE_SETTINGS,
    points every captured copy and IRIS's config cache at it, and refuses
    (IrisConfigMismatch) if any IRIS module still holds a different config. The
    returned object is the one IRIS uses, so destinations read from it are the ones
    content is sent to.
    """
    import importlib

    from iris.utils import utils as iris_utils

    refuse_unsafe(user_config)
    merged = force_safe_settings(
        iris_utils.deep_merge(iris_utils.load_template_config(), user_config)
    )
    refuse_unsafe(merged)
    for name, attr in IRIS_CAPTURED_CONFIGS:
        module = importlib.import_module(name)
        if hasattr(module, attr):
            setattr(module, attr, merged)
    iris_utils._cached_config = merged
    stale = _stale_iris_configs(merged)
    if stale:
        raise IrisConfigMismatch(
            "IRIS holds a config other than the one this run resolved, so it could "
            "send repository content to models or regions that were not confirmed: "
            + ", ".join(stale)
        )
    return merged


def _bound_config(config_path: Path) -> dict[str, Any]:
    """Read the config through IRIS, bind it (bind_iris_config) and pin IRIS to it.

    Once pinned, IRIS's set_config_path keeps the bound object, so a later call in
    this process (the scope measurement, then IRIS's own run) gets the config the
    gate checked rather than re-reading the file.
    """
    from iris.api import load_default_config, set_config_path

    set_config_path(config_path)
    config = bind_iris_config(load_default_config())
    refuse_other_repository(config, config_path)
    pin_iris_config(config, config_path)
    return config


def load_iris_config(config_path: Path) -> dict[str, Any]:
    """The config exactly as IRIS will run with it: the user's file over IRIS's
    packaged defaults, bound into IRIS (see bind_iris_config)."""
    config = _bound_config(config_path)
    if not config.get("codebase_dir"):
        raise ValueError("codebase_dir must be specified in the config file")
    return config


def _read_cap(config: dict[str, Any], key: str, default: int) -> int:
    """Read one ceiling, rejecting values that would silently disable it."""
    raw = config.get(key, default)
    if raw is None or isinstance(raw, bool) or not isinstance(raw, (int, str)):
        raise ValueError(
            f"{key} must be a whole number (0 disables the ceiling), not {raw!r}."
        )
    try:
        cap = int(raw)
    except ValueError:
        raise ValueError(
            f"{key} must be a whole number (0 disables the ceiling), not {raw!r}."
        ) from None
    if cap < 0:
        raise ValueError(f"{key} must be 0 or greater, not {cap}.")
    return cap


def read_ceilings(config_path: Path) -> tuple[int, int]:
    """Read both ceilings straight from the YAML, touching no iris code.

    Read independently of measure_scope on purpose. These are LaunchBridge keys that
    only ever appear in the user's own config, so no merge is needed, and a bad value
    is reported as such rather than as a measurement failure. A ceiling of 0 does not
    bypass measurement: a run that cannot be measured is refused either way.

    Raises ValueError for a malformed value rather than falling back to the default,
    because a typo'd ceiling should not quietly become a different ceiling.
    """
    import yaml

    with open(config_path, encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        raise ValueError(f"{config_path} does not contain a YAML mapping.")
    return (
        _read_cap(config, MAX_FILES_KEY, DEFAULT_MAX_FILES),
        _read_cap(config, MAX_ARTIFACTS_KEY, DEFAULT_MAX_ARTIFACTS),
    )


def measure_scope(
    config_path: Path, mode: str, max_files: int, max_artifacts: int
) -> ScopeReport:
    """Count what this run would summarize, without summarizing anything.

    Deliberately reuses IRIS's own resolution -- the bound config (_bound_config),
    construct_output_dir, get_ignore_patterns, get_files_to_process -- rather than
    approximating it with a file-count heuristic. An independent estimate drifts from
    the real ignore_patterns as soon as either side changes, and a ceiling that is
    checked against the wrong number is worse than no ceiling.

    get_files_to_process and get_artifacts_to_process read the filesystem and compare
    against the cached hashes. The codebase half writes no hashes back, so a later
    real run still sees its work. The artifact half drops deleted artifacts from
    IRIS's artifact cache and overview, which can only make a later run do the same
    or more. Both (re)write the output directory's file_paths.txt and tree.txt, which
    the real run overwrites.

    Raises on any failure. Callers must refuse to index rather than continue: an
    unmeasurable run is an unbounded run.
    """
    from iris.api import (
        construct_output_dir,
        get_ignore_patterns,
        resolve_artifact_dir,
    )
    from iris.artifacts.artifact_file_management import get_artifacts_to_process
    from iris.file_system.file_management import get_files_to_process

    config = _bound_config(config_path)

    codebase_dir = config.get("codebase_dir")
    if not codebase_dir:
        raise ValueError("codebase_dir must be specified in the config file")

    models = (
        config.get("model_configuration", {}).get("file_summarizer", {}).get("models")
        or []
    )
    regions = sorted({str(m.get("region")) for m in models if m.get("region")})

    output_dir = construct_output_dir(codebase_dir=codebase_dir)
    problem = output_dir_problem(codebase_dir, output_dir)
    if problem:
        raise ValueError(problem)
    ignore_patterns = get_ignore_patterns(codebase_dir) or []
    links = codebase_links(codebase_dir, ignore_patterns) if mode != "artifact" else []
    if links:
        shown = ", ".join(links[:20]) + (" ..." if len(links) > 20 else "")
        raise ValueError(
            f"links indexing would follow out of the repository or around the ignore "
            f"patterns: {shown}. Add them to ignore_patterns in inq_config.yaml, or "
            "replace them with the files themselves."
        )

    report = ScopeReport(
        config_path=config_path,
        codebase_dir=str(codebase_dir),
        mode=mode,
        ignore_pattern_count=len(ignore_patterns),
        model_pairs=len(models),
        regions=regions,
        max_files=max_files,
        max_artifacts=max_artifacts,
        artifact_max_workers=int(config.get("artifact_max_workers", 4)),
    )

    if mode in ("both", "codebase"):
        files = get_files_to_process(
            codebase_dir=codebase_dir,
            output_dir=output_dir,
            ignore_patterns=ignore_patterns,
        )
        report.files_to_process = len(files.files_to_process)
        report.total_files = files.total_files
        report.file_paths = list(files.files_to_process)

    if mode in ("both", "artifact"):
        artifact_dir = resolve_artifact_dir(config)
        report.artifact_dir = artifact_dir
        if artifact_dir:
            problem = artifact_dir_problem(codebase_dir, artifact_dir, output_dir)
            if problem:
                raise ValueError(problem)
            # Shown and confirmed as the folder IRIS will actually read.
            report.artifact_dir = str(Path(artifact_dir).expanduser().resolve())
            artifacts = get_artifacts_to_process(
                artifact_dir=artifact_dir,
                output_dir=output_dir,
            )
            outside = artifacts_outside(artifact_dir, artifacts.artifact_paths or [])
            if outside:
                raise ValueError(
                    f"artifacts that are symbolic links or resolve outside {artifact_dir}: "
                    + ", ".join(outside)
                    + ". Replace them with the files themselves, or remove them."
                )
            to_process = list(artifacts.artifacts_to_process)
            if artifact_settings_changed(config, output_dir):
                # IRIS re-processes every artifact when its processing settings
                # (OCR, transcription, size limits) changed since the last run.
                to_process = list(artifacts.artifact_paths or [])
            report.artifacts_to_process = len(to_process)
            report.total_artifacts = artifacts.total_artifacts
            report.artifact_paths = to_process

    return report


def codebase_links(codebase_dir: Any, ignore_patterns: list[str]) -> list[str]:
    """Links in the repository that indexing would follow out of it, or around
    the ignore patterns.

    IRIS walks the codebase following links and applies the ignore patterns to
    the path it reached a file by, not to where the file is. So a link is refused
    when it points outside the repository, at an ignored file or folder, at a
    folder that contains it (a loop), or at a folder holding a file the ignore
    patterns exclude at its own path but not under the link. A link to a file or
    folder in the repository that is indexed anyway is fine. Paths the ignore
    patterns exclude are not walked.
    """
    import pathspec

    root = Path(str(codebase_dir)).resolve()
    spec = pathspec.PathSpec.from_lines("gitignore", ignore_patterns or [])
    found = []
    names: dict = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        here = Path(directory)
        kept = []
        for name in dirs:
            rel = (here / name).relative_to(root).as_posix()
            if not spec.match_file(rel + "/"):
                kept.append(name)
        dirs[:] = kept
        for name in dirs + files:
            path = here / name
            rel = path.relative_to(root).as_posix()
            if not path.is_symlink() or spec.match_file(rel):
                continue
            if _link_problem(path, rel, root, spec, names):
                found.append(rel)
    return sorted(found)


def _on_disk_name(root: Path, target: Path, cache: dict) -> str | None:
    """target's path under root, spelled as the folders hold it, or None if a
    folder on the way can't be listed.

    resolve() keeps a link's own spelling, so on a case-insensitive or
    normalization-insensitive file system `notes.txt -> CREDENTIALS.JSON` (or
    an NFD spelling of an NFC name) resolves to a name the ignore patterns,
    which match exactly as IRIS does, don't see. Each part is matched to the
    folder's entry for the same file (device and inode); listings are cached in
    `cache` for one walk.
    """
    parts = []
    here = root
    for part in target.relative_to(root).parts:
        if here not in cache:
            try:
                entries = {}
                for name in os.listdir(here):
                    info = os.lstat(here / name)
                    entries.setdefault((info.st_dev, info.st_ino), []).append(name)
                cache[here] = entries
            except OSError:
                cache[here] = None
        entries = cache[here]
        if entries is None:
            return None
        try:
            info = os.lstat(here / part)
        except OSError:
            return None
        names = entries.get((info.st_dev, info.st_ino), [])
        if part in names:
            name = part
        elif len(names) == 1:
            name = names[0]
        else:
            return None  # hard links under several names, or none: undecidable
        parts.append(name)
        here = here / name
    return "/".join(parts)


def _link_problem(
    path: Path, rel: str, root: Path, spec: Any, cache: dict | None = None
) -> bool:
    target = path.resolve()
    if not target.is_relative_to(root):
        return True
    target_rel = _on_disk_name(root, target, {} if cache is None else cache)
    if target_rel is None:
        return True
    if not target.is_dir():
        return bool(spec.match_file(target_rel))
    if target == root or spec.match_file(target_rel + "/"):
        return True
    if path.parent.resolve().is_relative_to(target):
        return True
    for directory, dirs, files in os.walk(target, followlinks=False):
        sub = Path(directory).relative_to(target).as_posix()
        if any((Path(directory) / name).is_symlink() for name in dirs):
            # IRIS follows that one too: a link to a folder holding a link back
            # loops until the OS stops it, and nested links reach paths this
            # check doesn't see.
            return True
        for name in dirs + files:
            inner = name if sub == "." else f"{sub}/{name}"
            if spec.match_file(f"{target_rel}/{inner}") and not spec.match_file(
                f"{rel}/{inner}"
            ):
                return True
    return False


def artifact_dir_problem(
    codebase_dir: Any, artifact_dir: Any, output_dir: Any = None
) -> str | None:
    """Why the artifact folder is unsafe, or None.

    IRIS reads artifact_dir as given (relative to the working directory), and
    applies no ignore patterns to it, so it may not be or hold the codebase or
    the index folder: every file there, ignored or not, would be sent. IRIS
    doesn't expand `~`, so a leading `~` names a folder called `~`. A folder
    named inside the repository must resolve inside it through no symbolic link:
    a link that arrived with the repository could point it at the user's own
    documents. A folder named outside the repository is the user's explicit
    choice, and it is the resolved path that is shown and confirmed.
    """
    if str(artifact_dir).startswith("~"):
        return (
            f"the artifact folder {artifact_dir} starts with ~, which IRIS doesn't "
            "expand; give the full path"
        )
    if ".." in Path(str(artifact_dir)).parts:
        # The operating system follows a link before `..`, while abspath removes
        # `..` as text, so `sub/link/..` could name the repository itself.
        return (
            f"the artifact folder {artifact_dir} has a `..` component; give the "
            "folder's path without one"
        )
    root = Path(str(codebase_dir)).resolve()
    named = Path(os.path.abspath(Path(str(artifact_dir))))
    real = named.resolve()
    held = [root] + ([Path(str(output_dir)).resolve()] if output_dir else [])
    for folder in held:
        if folder == real or folder.is_relative_to(real):
            return (
                f"the artifact folder {artifact_dir} is or holds {folder}; IRIS "
                "would send every file there, ignored or not. Use a folder of "
                "project documents only, such as .project_artifacts"
            )
    if named != root and not named.is_relative_to(root):
        return None
    if not real.is_relative_to(root):
        return (
            f"the artifact folder {artifact_dir} resolves outside {root}. Replace "
            "the link with the folder itself."
        )
    for part in [named, *named.parents]:
        if part == root or not part.is_relative_to(root):
            break
        if part.is_symlink():
            return (
                f"the artifact folder goes through a symbolic link: {part}. "
                "Replace the link with the folder itself."
            )
    return None


def artifacts_outside(artifact_dir: Any, artifact_paths: list[str]) -> list[str]:
    """Artifacts that are symbolic links or resolve outside the artifact folder.

    IRIS's discovery follows a link to a file and sends its target, so a link in
    the folder would send a file the user never cleared.
    """
    root = Path(str(artifact_dir)).resolve()
    bad = []
    for rel in artifact_paths:
        path = Path(str(artifact_dir)) / rel
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            bad.append(str(rel))
    return bad


def artifact_settings_changed(config: dict[str, Any], output_dir: Any) -> bool:
    """Whether IRIS will re-process every artifact because its settings changed.

    True when it can't be told, so an unknown state counts every artifact.
    """
    try:
        from iris.artifacts.artifact_cache_manager import ArtifactCacheManager
        from iris.generate_artifact_context import (
            _artifact_processing_config_fingerprint,
        )

        fingerprint = _artifact_processing_config_fingerprint(config)
        return bool(
            ArtifactCacheManager(output_dir).processing_config_has_changed(fingerprint)
        )
    except Exception:
        log.debug("Could not read IRIS's artifact settings fingerprint:", exc_info=True)
        return True


def output_dir_problem(codebase_dir: Any, output_dir: Any) -> str | None:
    """Why IRIS's output folder is unsafe to write to, or None.

    It must resolve inside the repository, through no symbolic link, and hold no
    link: a link at `<output_dir>/<repository name>`, or at a file IRIS writes
    there (tree.txt, file_paths.txt), would send the index somewhere else.
    """
    root = Path(str(codebase_dir)).resolve()
    out = Path(str(output_dir))
    if not out.resolve().is_relative_to(root):
        return f"IRIS's output folder {out} resolves outside {root}"
    probe = out if out.is_absolute() else Path(str(codebase_dir)) / out
    for part in [probe, *probe.parents]:
        if part.resolve() == root or not part.resolve().is_relative_to(root):
            break
        if part.is_symlink():
            return f"IRIS's output folder goes through a symbolic link: {part}"
    if probe.is_dir():
        unreadable: list[str] = []
        walk = os.walk(
            probe, followlinks=False, onerror=lambda e: unreadable.append(e.filename)
        )
        for directory, dirs, files in walk:
            for name in dirs + files:
                try:
                    linked = (Path(directory) / name).is_symlink()
                except OSError:  # in a folder that can be listed, not entered
                    unreadable.append(directory)
                    continue
                if linked:
                    return (
                        "IRIS's output folder holds a symbolic link, which IRIS "
                        f"would write through: {Path(directory) / name}"
                    )
        if unreadable:
            # IRIS opens its files there by name, so it would write through a
            # link this walk couldn't see.
            return f"IRIS's output folder holds a folder that can't be listed: {unreadable[0]}"
    return None


def format_scope_report(report: ScopeReport) -> str:
    """Render the scope numbers for a human deciding whether to spend the money."""
    lines = [
        f"Indexing scope for {report.codebase_dir} (mode={report.mode})",
    ]

    if report.files_to_process is None:
        lines.append("  Codebase:    not indexed in this mode")
    else:
        ceiling = (
            "ceiling disabled"
            if report.max_files == 0
            else f"ceiling {report.max_files} ({MAX_FILES_KEY})"
        )
        lines.append(
            f"  Codebase:    {report.files_to_process} file(s) to summarize "
            f"of {report.total_files} non-ignored "
            f"({report.ignore_pattern_count} ignore patterns) -- {ceiling}"
        )

    if report.artifacts_to_process is None:
        detail = (
            "not indexed in this mode"
            if report.mode == "codebase"
            else "artifact_dir is not configured, so artifacts are skipped"
        )
        lines.append(f"  Artifacts:   {detail}")
    else:
        ceiling = (
            "ceiling disabled"
            if report.max_artifacts == 0
            else f"ceiling {report.max_artifacts} ({MAX_ARTIFACTS_KEY})"
        )
        lines.append(
            f"  Artifacts:   {report.artifacts_to_process} artifact(s) to summarize "
            f"of {report.total_artifacts} discovered -- {ceiling}"
        )
        lines.append(
            f"               up to {report.artifact_max_workers} concurrent "
            f"(artifact_max_workers)"
        )

    lines.append(
        f"  Concurrency: {report.model_pairs} model-region pair(s)"
        + (f" across {', '.join(report.regions)}" if report.regions else "")
    )
    lines.append(
        "  Every file to summarize is at least one Bedrock call, and every region "
        "listed above receives repository content."
    )
    lines.append(
        "  Bedrock has no per-request spend limit. Set an AWS Budgets alarm with a "
        "Bedrock service filter before a large run."
    )
    return "\n".join(lines)


def check_scope_ceiling(report: ScopeReport) -> list[str]:
    """Return one line per exceeded ceiling. Empty means the run is within bounds.

    A cap of 0 is the documented way to switch a ceiling off, so it is skipped here
    rather than treated as "no files allowed".
    """
    exceeded = []
    if (
        report.max_files
        and report.files_to_process is not None
        and report.files_to_process > report.max_files
    ):
        exceeded.append(
            f"{report.files_to_process} files to summarize exceeds "
            f"{MAX_FILES_KEY}={report.max_files}"
        )
    if (
        report.max_artifacts
        and report.artifacts_to_process is not None
        and report.artifacts_to_process > report.max_artifacts
    ):
        exceeded.append(
            f"{report.artifacts_to_process} artifacts to summarize exceeds "
            f"{MAX_ARTIFACTS_KEY}={report.max_artifacts}"
        )
    return exceeded


def format_refusal(report: ScopeReport, exceeded: list[str]) -> str:
    """Explain the refusal, what usually causes it, and how to override it."""
    return "\n".join(
        [
            "Refusing to index: this run is larger than the configured ceiling.",
            *(f"  - {item}" for item in exceeded),
            "",
            format_scope_report(report),
            "",
            "If that scope is not what you expected, check codebase_dir and",
            "ignore_patterns first -- an unexpectedly large count usually means the",
            "wrong directory, or an ignore list that stopped matching the repository.",
            "",
            "If it is what you expected, raise the ceiling in",
            f"  {report.config_path}",
            f"or set {MAX_FILES_KEY}: 0 to remove it entirely. Trimming",
            "model_configuration.file_summarizer.models lowers concurrency but not the",
            "number of calls, so it does not change this check.",
        ]
    )


def disabled_ceiling_notice(report: ScopeReport) -> str | None:
    """Name any ceiling that is switched off, so an unbounded run is never quiet."""
    off = []
    if report.files_to_process is not None and report.max_files == 0:
        off.append(MAX_FILES_KEY)
    if report.artifacts_to_process is not None and report.max_artifacts == 0:
        off.append(MAX_ARTIFACTS_KEY)
    if not off:
        return None
    return (
        f"{' and '.join(off)} is set to 0: this run has no ceiling on how much it "
        "will send to Bedrock."
    )


def sanitize_for_log(error: Exception) -> str:
    """Sanitize error messages for safe logging."""
    error_str = str(error)
    sensitive_patterns = ["password", "token", "key", "secret"]
    for pattern in sensitive_patterns:
        if pattern.lower() in error_str.lower():
            return f"{type(error).__name__}: [Sensitive information redacted]"
    return error_str


def get_safe_error_type(error: Exception) -> str:
    """Get error type name safely."""
    return type(error).__name__


def validate_config_file(config_path: Path) -> None:
    """Validate config file exists and is readable."""
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")
    if not config_path.is_file():
        raise ValueError(f"Config path is not a file: {config_path}")
    if config_path.suffix not in [".yaml", ".yml"]:
        log.warning(f"Config file has unexpected extension: {config_path.suffix}")


def summarize_result(mode: str, result: dict[str, Any]) -> dict[str, Any]:
    """Collapse index_codebase_artifacts' per-half results into one outcome."""
    # result is a dict: {"codebase_result": ..., "artifact_result": ...}
    codebase_result = result.get("codebase_result")
    artifact_result = result.get("artifact_result")

    if mode == "codebase":
        r = codebase_result
        if r is None:
            return {"status": "error", "error": "Codebase indexing returned no result"}
        return {
            "status": r.status,
            "message": r.message,
            "processed_files": r.processed_files or [],
        }

    if mode == "artifact":
        r = artifact_result
        if r is None:
            return {"status": "error", "error": "Artifact indexing returned no result"}
        return {
            "status": r.status,
            "message": r.message,
            "processed_files": r.processed_artifacts or [],
        }

    cb_status = codebase_result.status if codebase_result else "no_op"
    ar_status = artifact_result.status if artifact_result else "no_op"
    cb_files = (codebase_result.processed_files or []) if codebase_result else []
    ar_files = (artifact_result.processed_artifacts or []) if artifact_result else []

    # Worst status wins
    if cb_status == "error" or ar_status == "error":
        status = "error"
    elif cb_status == "update_complete" or ar_status == "update_complete":
        status = "update_complete"
    else:
        status = "no_op"

    return {
        "status": status,
        "message": (
            f"Codebase: {cb_status} ({len(cb_files)} files) | "
            f"Artifacts: {ar_status} ({len(ar_files)} artifacts)"
        ),
        "processed_files": cb_files + ar_files,
    }


def run_indexing(
    config_path: str, mode: str, allow_unbounded: bool = False
) -> dict[str, Any]:
    """
    Run codebase and/or artifact indexing.

    index_codebase_artifacts(config_path, mode) returns::

        {
            "codebase_result": ContextGenerationResult | None,
            "artifact_result": ArtifactContextResult | None,
        }

    - ContextGenerationResult: .status, .message, .processed_files
    - ArtifactContextResult:   .status, .message, .processed_artifacts

    Before anything is sent, in order: every destination the config uses must be
    confirmed for this engagement, the run must be within its ceiling (a ceiling of
    0 needs `allow_unbounded`), artifacts must be confirmed as cleared for the
    account's data classification, the files must pass the credential scan, and
    what the run is about to submit must be appended to the transmission log. Any
    of these can refuse the call.

    Args:
        config_path: Path to the configuration YAML file
        mode: One of 'codebase', 'artifact', or 'both'
        allow_unbounded: Run even though a ceiling that applies is set to 0

    Returns:
        Dictionary with status, message, and processed files. A status of
        'refused' or 'data_handling' means nothing was sent to Bedrock.
    """
    try:
        config_file = Path(config_path).resolve()
        validate_config_file(config_file)
        config_str = str(config_file)

        log.info(f"Starting indexing (mode={mode}) with config: {config_file}")

        # 1. Where the content would go must be confirmed for this engagement.
        try:
            iris_config = load_iris_config(config_file)
            codebase_dir = str(iris_config["codebase_dir"])
            destinations = resolve_destinations(iris_config)
        except Exception as e:
            log.debug("Destination resolution failed:", exc_info=True)
            return {
                "status": "data_handling",
                "error": (
                    "Refusing to index: could not determine where this run would send "
                    f"repository content ({get_safe_error_type(e)}: "
                    f"{sanitize_for_log(e)})."
                ),
            }
        confirmation = load_confirmation(
            confirmation_path(codebase_dir), caller_principal(), codebase_dir
        )
        missing = unconfirmed_destinations(destinations, confirmation)
        if missing:
            return {
                "status": "data_handling",
                "error": format_unconfirmed(config_file, codebase_dir, missing),
            }

        # 2. Measure before spending.
        try:
            max_files, max_artifacts = read_ceilings(config_file)
        except (ValueError, OSError) as e:
            return {
                "status": "refused",
                "error": f"Refusing to index: {sanitize_for_log(e)}",
            }

        off = unbounded_ceilings(mode, max_files, max_artifacts)
        if off and not allow_unbounded:
            return {
                "status": "refused",
                "error": (
                    f"Refusing to index: {' and '.join(off)} is 0 in {config_file}, "
                    "which removes the ceiling on how much this run sends to Bedrock.\n"
                    "Set a number, or, to run without a ceiling on purpose, start the "
                    "run with --allow-unbounded (and keep an AWS Budgets alarm on the "
                    "account)."
                ),
            }
        if off:
            log.warning(
                "%s is 0 and --allow-unbounded was given: this run has no ceiling on "
                "how much it will send to Bedrock.",
                " and ".join(off),
            )

        # The file list is also what the credential scan and the transmission log
        # need, so a run that cannot be measured is not started.
        try:
            report = measure_scope(config_file, mode, max_files, max_artifacts)
        except Exception as e:
            error_type = get_safe_error_type(e)
            log.debug("Scope measurement failed:", exc_info=True)
            return {
                "status": "refused",
                "error": (
                    "Refusing to index: could not list the files this run would "
                    "send to Bedrock "
                    f"({error_type}: {sanitize_for_log(e)}).\n"
                    "Fix the config or the iris installation, then run again."
                ),
            }

        # Checked before logging the report: format_refusal embeds it, and
        # printing the same numbers twice buries the one line that matters.
        exceeded = check_scope_ceiling(report)
        if exceeded:
            return {"status": "refused", "error": format_refusal(report, exceeded)}

        log.info("Scope check:\n%s", format_scope_report(report))
        notice = disabled_ceiling_notice(report)
        if notice:
            log.warning(notice)

        # Artifacts are engagement documents; sending them needs a recorded
        # confirmation that they are cleared for this account's classification.
        if report.artifacts_to_process and not artifacts_cleared(
            confirmation, report.artifact_dir
        ):
            return {
                "status": "data_handling",
                "error": "\n".join(
                    [
                        "Refusing to index artifacts: the data-handling confirmation "
                        "does not record that the project artifacts in "
                        f"{report.artifact_dir} are cleared for this AWS account's "
                        "data classification.",
                        "Ask the user to confirm it, then record their answer:",
                        f"  codebase_artifact_indexing.py --config {config_file} "
                        '--confirm-data-handling --artifact-classification "<their words>"',
                    ]
                ),
            }

        # Artifacts are sent whole up to artifact_max_file_size, so they are scanned
        # whole up to that size too.
        artifact_max = int(iris_config.get("artifact_max_file_size") or 30_000_000)
        artifact_limit = max(SECRET_SCAN_MAX_BYTES, artifact_max)
        hits = scan_for_secrets(report.file_paths, codebase_dir) + scan_for_secrets(
            report.artifact_paths,
            report.artifact_dir,
            artifact_limit,
            documents=True,
            extract_max_bytes=artifact_max,
        )
        if hits:
            return {
                "status": "data_handling",
                "error": format_secret_refusal(config_file, hits),
            }

        # 3. Record what is about to be submitted, before submitting it.
        log_path = transmission_log_path(codebase_dir)
        run_id = str(uuid.uuid4())
        started = {
            "event": "run_started",
            "run_id": run_id,
            "at": now_iso(),
            "mode": mode,
            "destinations": [d.key for d in destinations],
            "measured": report is not None,
            # None, not [], for a half this run does not touch or could not list:
            # an empty list would claim "nothing was sent" when nothing was checked.
            "files": (
                _entries(report.file_paths, codebase_dir)
                if report and report.files_to_process is not None
                else None
            ),
            "artifact_dir": report.artifact_dir if report else None,
            "artifacts": (
                _entries(report.artifact_paths, report.artifact_dir)
                if report and report.artifacts_to_process is not None
                else None
            ),
        }
        try:
            append_log(log_path, started)
        except OSError as e:
            return {
                "status": "data_handling",
                "error": (
                    f"Refusing to index: could not write the transmission log at "
                    f"{log_path} ({sanitize_for_log(e)}). A run whose submissions "
                    "cannot be recorded is not started."
                ),
            }

        # Pre-set so the finish entry is written even when the indexer raises.
        outcome: dict[str, Any] = {"status": "error", "processed_files": []}
        try:
            outcome = summarize_result(
                mode, index_codebase_artifacts(config_path=config_str, mode=mode)
            )
        finally:
            try:
                append_log(
                    log_path,
                    {
                        "event": "run_finished",
                        "run_id": run_id,
                        "at": now_iso(),
                        "status": outcome["status"],
                        "processed": len(outcome.get("processed_files") or []),
                    },
                )
            except OSError as e:
                # The content has already gone; the run_started entry records what
                # was submitted. Say so rather than fail a completed run.
                log.warning(
                    "Could not record the end of this run in %s (%s); the start "
                    "entry lists what was submitted.",
                    log_path,
                    sanitize_for_log(e),
                )

        return outcome

    except FileNotFoundError as e:
        safe_error = sanitize_for_log(e)
        log.error(f"File not found: {safe_error}")
        return {"status": "error", "error": safe_error}

    except Exception as e:
        safe_error = sanitize_for_log(e)
        error_type = get_safe_error_type(e)
        log.error(f"Error during indexing: {error_type} - {safe_error}")
        log.debug("Full traceback:", exc_info=True)
        return {"status": "error", "error": f"{error_type}: {safe_error}"}


def report_scope(config_path: str, mode: str) -> int:
    """Print what a run would index and exit, without indexing anything."""
    try:
        config_file = Path(config_path).resolve()
        validate_config_file(config_file)
        max_files, max_artifacts = read_ceilings(config_file)
        report = measure_scope(config_file, mode, max_files, max_artifacts)
    except Exception as e:
        log.error(
            f"Could not measure scope: {get_safe_error_type(e)} - "
            f"{sanitize_for_log(e)}"
        )
        log.debug("Full traceback:", exc_info=True)
        return 1

    print(format_scope_report(report))

    # Where it would go, and whether that has been confirmed for this engagement.
    try:
        iris_config = load_iris_config(config_file)
        destinations = resolve_destinations(iris_config)
        codebase_dir = str(iris_config["codebase_dir"])
        confirmation = load_confirmation(
            confirmation_path(codebase_dir), caller_principal(), codebase_dir
        )
        missing = unconfirmed_destinations(destinations, confirmation)
        print("\nDestinations (repository content is sent to each):")
        print("\n".join(format_destinations(destinations)))
        if report.artifacts_to_process and not artifacts_cleared(
            confirmation, report.artifact_dir
        ):
            print(
                f"\nArtifacts in {report.artifact_dir} are NOT recorded as cleared "
                "for this account's data "
                "classification; an artifact run will refuse (exit 4) until "
                "--confirm-data-handling --artifact-classification records it."
            )
        if missing:
            print(
                f"\nNOT CONFIRMED for this engagement: {len(missing)} of "
                f"{len(destinations)}. Indexing will refuse (exit 4) until the user "
                "confirms them and --confirm-data-handling records it."
            )
        else:
            print("\nAll destinations are confirmed for this engagement.")
    except Exception as e:
        print(f"\nCould not resolve destinations: {sanitize_for_log(e)}")

    notice = disabled_ceiling_notice(report)
    if notice:
        print(f"\nWARNING: {notice}")

    exceeded = check_scope_ceiling(report)
    if exceeded:
        print("\nThis run would be refused:")
        for item in exceeded:
            print(f"  - {item}")
        print(f"Raise the ceiling in {config_file} to index it.")

    # Reporting scope succeeded even when the scope is over the ceiling -- the
    # refusal belongs to the indexing run, not to the question about it.
    return 0


def confirm_data_handling(
    config_path: str, basis: str, artifact_classification: str = ""
) -> int:
    """Record that the configured destinations are permitted. Sends nothing.

    Records what the config actually resolves to, not a list supplied by the caller,
    so a confirmation can never cover more than the user was shown. The caller is an
    AI agent: run this only after the user has confirmed the destinations.
    """
    try:
        config_file = Path(config_path).resolve()
        validate_config_file(config_file)
        iris_config = load_iris_config(config_file)
        destinations = resolve_destinations(iris_config)
        if not destinations:
            log.error("The config names no destinations; there is nothing to confirm.")
            return 1
        codebase_dir = str(iris_config["codebase_dir"])
        principal = caller_principal()
        if principal is None:
            log.error(
                "Could not identify the AWS account and principal "
                "(sts get-caller-identity failed), so the confirmation cannot be "
                "recorded. Check the AWS profile and try again."
            )
            return 1
        artifact_dir = ""
        if artifact_classification:
            from iris.api import construct_output_dir, resolve_artifact_dir

            artifact_dir = resolve_artifact_dir(iris_config) or ""
            if not artifact_dir:
                log.error(
                    "artifact_dir is not set to an existing folder, so there are no "
                    "project artifacts to clear."
                )
                return 1
            # Refused here as it would be at run time, so nothing unsafe is cleared.
            problem = artifact_dir_problem(
                codebase_dir,
                artifact_dir,
                construct_output_dir(codebase_dir=codebase_dir),
            )
            if problem:
                log.error(problem)
                return 1
        path = confirmation_path(codebase_dir)
        write_confirmation(
            path,
            destinations,
            basis,
            artifact_classification,
            principal=principal,
            codebase_dir=codebase_dir,
            artifact_dir=artifact_dir,
        )
    except Exception as e:
        log.error(
            f"Could not record the confirmation: {get_safe_error_type(e)} - "
            f"{sanitize_for_log(e)}"
        )
        return 1

    print(f"Recorded: content from {codebase_dir} may be sent to")
    print("\n".join(format_destinations(destinations)))
    if artifact_classification:
        print(
            f"Project artifacts in {Path(artifact_dir).resolve()} cleared as: "
            f"{artifact_classification}"
        )
    print(
        f"\nWritten to {path}, outside the repository, for this AWS account and principal."
    )
    return 0


def main() -> int:
    """Main entry point for CLI usage."""
    parser = argparse.ArgumentParser(
        description="Index a codebase and/or engagement artifacts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --config config.yaml --mode codebase
  %(prog)s --config config.yaml --mode artifact
  %(prog)s --config config.yaml --mode both
  %(prog)s --config config.yaml --mode both --report-scope
  %(prog)s --config config.yaml --confirm-data-handling --basis "SOW 4.2"
  %(prog)s --config config.yaml --confirm-data-handling --basis "SOW 4.2" \\
      --artifact-classification "Internal; cleared by the engagement lead"

Exit codes:
  0  indexed, or nothing to do, or scope reported, or confirmation recorded
  1  indexing failed
  3  refused: the run exceeds the configured ceiling, a ceiling is 0 without
     --allow-unbounded, or its size could not be measured. Nothing was sent.
  4  refused: a destination is not confirmed for this engagement, artifacts are
     not recorded as cleared for the account's data classification, a file to
     be sent appears to contain a credential, or the transmission log could not
     be written. Nothing was sent to Bedrock.
        """,
    )
    parser.add_argument(
        "--config",
        required=True,
        help="Path to configuration YAML file",
    )
    parser.add_argument(
        "--mode",
        choices=VALID_MODES,
        default="codebase",
        help="Indexing mode: codebase (default), artifact, or both",
    )
    parser.add_argument(
        "--report-scope",
        action="store_true",
        help=(
            "Report how many files and artifacts this run would summarize, the "
            "concurrency and the regions involved, then exit without indexing"
        ),
    )
    parser.add_argument(
        "--confirm-data-handling",
        action="store_true",
        help=(
            "Record that this engagement's data-handling terms permit every "
            "destination the config sends content to, then exit without indexing. "
            "Run only after the user has confirmed them."
        ),
    )
    parser.add_argument(
        "--basis",
        default="",
        help=(
            "With --confirm-data-handling: what the permission rests on, e.g. a "
            "contract clause. Stored in the confirmation record, outside the repository"
        ),
    )
    parser.add_argument(
        "--artifact-classification",
        default="",
        help=(
            "With --confirm-data-handling: record that the project artifacts are "
            "cleared for the target account's data classification, in the user's "
            "words. Required before artifacts are indexed"
        ),
    )
    parser.add_argument(
        "--allow-unbounded",
        action="store_true",
        help=(
            "Run even though a ceiling that applies to this mode is set to 0. "
            "Without it, a 0 ceiling refuses the run"
        ),
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
        # Their DEBUG output holds request bodies: the prompts, with file content.
        # IRIS's own DEBUG output holds the models' raw responses.
        for name in ("iris", "botocore", "urllib3", "strands"):
            logging.getLogger(name).setLevel(logging.INFO)

    if args.confirm_data_handling:
        return confirm_data_handling(
            args.config, args.basis, args.artifact_classification
        )

    if args.report_scope:
        return report_scope(args.config, args.mode)

    result = run_indexing(args.config, args.mode, args.allow_unbounded)

    if result["status"] in ["success", "update_complete", "no_op"]:
        log.info(result["message"])
        if result.get("processed_files"):
            log.info(f"Processed {len(result['processed_files'])} files")
        return 0
    elif result["status"] == "refused":
        # Distinct from a failure: nothing was sent to Bedrock, and the fix is a
        # config decision rather than a bug to debug.
        log.error(result["error"])
        return 3
    elif result["status"] == "data_handling":
        # Also nothing sent. The fix is the user's decision about where content may
        # go, or a log location that cannot be written -- never a retry.
        log.error(result["error"])
        return 4
    else:
        log.error(f"Indexing failed: {result.get('error', 'Unknown error')}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
