#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Discover existing tests in a codebase.

Checks documentation first (README, docs/), then scans for test patterns.
Outputs JSON with discovered tests, their types, and locations.
"""

import argparse
import json
import re
import sys
from pathlib import Path


def find_test_instructions_in_docs(root_path: Path) -> dict:
    """Search README and docs for test-related instructions."""
    instructions = {"found": False, "files": [], "commands": []}

    # Files to check for test instructions
    doc_files = [
        "README.md",
        "README.rst",
        "README.txt",
        "CONTRIBUTING.md",
        "docs/testing.md",
        "docs/TESTING.md",
        "docs/development.md",
        "DEVELOPMENT.md",
    ]

    # Patterns that indicate test commands
    test_command_patterns = [
        r"pytest\s+[\w\-\.\/]+",
        r"python\s+-m\s+pytest",
        r"python\s+-m\s+unittest",
        r"make\s+test",
        r"npm\s+run\s+test",
        r"tox\s*",
    ]

    for doc_file in doc_files:
        doc_path = root_path / doc_file
        if doc_path.exists():
            try:
                content = doc_path.read_text(encoding="utf-8", errors="ignore")
                # Look for test-related sections
                if re.search(
                    r"(?i)(running\s+tests|test\s+suite|how\s+to\s+test|testing)",
                    content,
                ):
                    instructions["found"] = True
                    instructions["files"].append(str(doc_file))

                    # Extract test commands
                    for pattern in test_command_patterns:
                        matches = re.findall(pattern, content)
                        instructions["commands"].extend(matches)
            except (OSError, UnicodeDecodeError):
                # Skip documentation files that cannot be read.
                continue

    instructions["commands"] = list(set(instructions["commands"]))
    return instructions


def classify_test_type(file_path: Path, content: str) -> str:
    """Classify a test file as unit, functional, or e2e."""
    path_str = str(file_path).lower()

    # Check path-based hints
    if "unit" in path_str:
        return "unit"
    if "functional" in path_str or "integration" in path_str:
        return "functional"
    if "e2e" in path_str or "end_to_end" in path_str or "end-to-end" in path_str:
        return "e2e"

    # Check content-based hints
    content_lower = content.lower()

    # E2E indicators
    e2e_indicators = ["selenium", "playwright", "webdriver", "browser", "cypress"]
    if any(ind in content_lower for ind in e2e_indicators):
        return "e2e"

    # Functional/integration indicators
    functional_indicators = [
        "database",
        "api",
        "request",
        "client",
        "server",
        "fixture",
    ]
    functional_count = sum(1 for ind in functional_indicators if ind in content_lower)

    # Unit test indicators (mocking, isolated tests)
    unit_indicators = ["mock", "patch", "unittest.mock", "pytest.mock", "monkeypatch"]
    unit_count = sum(1 for ind in unit_indicators if ind in content_lower)

    if functional_count > unit_count and functional_count >= 2:
        return "functional"

    # Default to unit
    return "unit"


def discover_test_files(root_path: Path) -> list:
    """Find all test files matching common patterns."""
    test_files = []

    # Patterns to match
    patterns = ["test_*.py", "*_test.py"]

    # Directories to skip
    skip_dirs = {
        ".git",
        ".venv",
        ".venv_lb",
        ".venv_lint",
        "venv",
        "node_modules",
        "__pycache__",
        ".tox",
        ".pytest_cache",
        "dist",
        "build",
        ".eggs",
        ".lb_workspace",
        "tests/targets",
        "site-packages",
    }

    for pattern in patterns:
        for test_file in root_path.rglob(pattern):
            # Skip excluded directories
            if any(skip_dir in test_file.parts for skip_dir in skip_dirs):
                continue

            try:
                content = test_file.read_text(encoding="utf-8", errors="ignore")
                test_type = classify_test_type(test_file, content)

                # Count test functions/methods
                test_count = len(re.findall(r"def\s+test_\w+", content))
                test_count += len(re.findall(r"async\s+def\s+test_\w+", content))

                test_files.append(
                    {
                        "path": str(test_file.relative_to(root_path)),
                        "type": test_type,
                        "test_count": test_count,
                    }
                )
            except Exception as e:
                print(f"Warning: Could not read {test_file}: {e}", file=sys.stderr)

    return test_files


def find_test_config(root_path: Path) -> dict:
    """Find test configuration files."""
    config = {
        "pytest_ini": False,
        "pyproject_toml": False,
        "setup_cfg": False,
        "tox_ini": False,
    }

    if (root_path / "pytest.ini").exists():
        config["pytest_ini"] = True
    if (root_path / "pyproject.toml").exists():
        content = (root_path / "pyproject.toml").read_text(
            encoding="utf-8", errors="ignore"
        )
        if "[tool.pytest" in content:
            config["pyproject_toml"] = True
    if (root_path / "setup.cfg").exists():
        content = (root_path / "setup.cfg").read_text(encoding="utf-8", errors="ignore")
        if "[tool:pytest]" in content:
            config["setup_cfg"] = True
    if (root_path / "tox.ini").exists():
        config["tox_ini"] = True

    return config


def main():
    parser = argparse.ArgumentParser(
        description="Discover existing tests in a codebase"
    )
    parser.add_argument(
        "path",
        nargs="?",
        default=".",
        help="Root path to scan (default: current directory)",
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    root_path = Path(args.path).resolve()

    if not root_path.exists():
        print(f"Error: Path does not exist: {root_path}", file=sys.stderr)
        sys.exit(1)

    # Gather all information
    doc_instructions = find_test_instructions_in_docs(root_path)
    test_files = discover_test_files(root_path)
    test_config = find_test_config(root_path)

    # Summarize by type
    summary = {"unit": 0, "functional": 0, "e2e": 0, "total_tests": 0}
    for tf in test_files:
        summary[tf["type"]] += 1
        summary["total_tests"] += tf["test_count"]

    result = {
        "root_path": str(root_path),
        "has_tests": len(test_files) > 0,
        "documentation": doc_instructions,
        "config": test_config,
        "test_files": test_files,
        "summary": summary,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\n=== Test Discovery Report for {root_path} ===\n")

        if doc_instructions["found"]:
            print("📖 Documentation found with test instructions:")
            for f in doc_instructions["files"]:
                print(f"   - {f}")
            if doc_instructions["commands"]:
                print("   Commands found:", ", ".join(doc_instructions["commands"]))
        else:
            print("📖 No test documentation found in README/docs")

        print(f"\n📁 Test files found: {len(test_files)}")
        print(f"   Unit tests: {summary['unit']} files")
        print(f"   Functional tests: {summary['functional']} files")
        print(f"   E2E tests: {summary['e2e']} files")
        print(f"   Total test functions: {summary['total_tests']}")

        if test_files:
            print("\n📋 Test files:")
            for tf in test_files:
                print(f"   [{tf['type']:10}] {tf['path']} ({tf['test_count']} tests)")

        print("\n⚙️  Test configuration:")
        for cfg, found in test_config.items():
            status = "✓" if found else "✗"
            print(f"   {status} {cfg}")


if __name__ == "__main__":
    main()
