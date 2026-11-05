#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Generate test documentation report.

Creates a markdown report documenting:
- Existing tests found
- Tests that were added
- Total code coverage
- Explanation of what each test does
"""

import argparse
import ast
import json
import sys
from datetime import datetime
from pathlib import Path


def extract_test_info(test_file: Path) -> list[dict]:
    """Extract test function info from a test file."""
    tests = []
    try:
        content = test_file.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(content)

        current_class = None

        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                if node.name.startswith("Test"):
                    current_class = node.name
                    for item in node.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            if item.name.startswith("test_"):
                                tests.append(
                                    {
                                        "name": f"{current_class}.{item.name}",
                                        "docstring": ast.get_docstring(item) or "",
                                        "line": item.lineno,
                                    }
                                )
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith("test_") and node.col_offset == 0:
                    tests.append(
                        {
                            "name": node.name,
                            "docstring": ast.get_docstring(node) or "",
                            "line": node.lineno,
                        }
                    )
    except Exception as e:
        print(f"Warning: Could not parse {test_file}: {e}", file=sys.stderr)

    return tests


_MD_SPECIAL = set("\\`*_{}[]()#+-.!|~")


def md_text(text: str) -> str:
    """Text from the repository, made inert in Markdown: HTML is escaped and
    Markdown syntax (links, images, emphasis, code, table pipes) is backslashed,
    so a docstring renders as the words it contains and nothing more."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "".join("\\" + ch if ch in _MD_SPECIAL else ch for ch in text)


def md_code(text: str) -> str:
    """Repository text inside an inline code span; backticks cannot close it."""
    return "`" + text.replace("`", "'") + "`"


def infer_test_purpose(test_name: str, docstring: str) -> str:
    """Infer what a test is testing based on name and docstring."""
    if docstring:
        return docstring.split("\n")[0].strip()

    # Parse test name to infer purpose
    name = test_name.split(".")[-1]  # Get just the function name
    name = name.replace("test_", "")

    # Common patterns
    if "_returns_" in name:
        parts = name.split("_returns_")
        return f"Verifies that {parts[0].replace('_', ' ')} returns {parts[1].replace('_', ' ')}"
    if "_raises_" in name:
        parts = name.split("_raises_")
        return f"Verifies that {parts[0].replace('_', ' ')} raises {parts[1].replace('_', ' ')}"
    if "_when_" in name:
        parts = name.split("_when_")
        return f"Tests {parts[0].replace('_', ' ')} when {parts[1].replace('_', ' ')}"
    if "_with_" in name:
        parts = name.split("_with_")
        return f"Tests {parts[0].replace('_', ' ')} with {parts[1].replace('_', ' ')}"

    # Default: convert underscores to spaces
    return f"Tests {name.replace('_', ' ')}"


def classify_test_type(rel_path: str) -> str:
    """Classify a test file as unit, functional, or e2e based on its path."""
    parts = rel_path.replace("\\", "/").lower()
    if "/e2e/" in parts or "e2e_" in parts or "_e2e" in parts:
        return "e2e"
    if "/integration/" in parts or "/functional/" in parts:
        return "functional"
    return "unit"


def discover_all_tests(root_path: Path) -> dict:
    """Discover all test files and their tests across the entire project."""
    all_tests = {}

    # Directories to skip entirely
    skip_dirs = {
        ".git",
        ".venv",
        ".venv_lb",
        "node_modules",
        "__pycache__",
        ".aws-sam",
        ".ruff_cache",
        "dist",
        "build",
        ".eggs",
    }

    # First check .lb_workspace/tests for skill-created tests (explicit type mapping)
    ci_test_dirs = {
        "unit": root_path / ".lb_workspace" / "tests" / "unit",
        "functional": root_path / ".lb_workspace" / "tests" / "functional",
        "e2e": root_path / ".lb_workspace" / "tests" / "e2e",
    }
    for test_type, test_dir in ci_test_dirs.items():
        if not test_dir.exists():
            continue
        for pattern in ("test_*.py", "*_test.py"):
            for test_file in test_dir.rglob(pattern):
                rel_path = str(test_file.relative_to(root_path))
                tests = extract_test_info(test_file)
                if tests:
                    all_tests[rel_path] = {"type": test_type, "tests": tests}

    # Then scan the whole project for any other test files
    # Walk manually so we can prune skip_dirs early
    def _iter_test_files(root: Path):
        for entry in root.iterdir():
            if (
                entry.name in skip_dirs
                or entry.name.startswith(".")
                or entry.name.endswith(".egg-info")
            ):
                continue
            if entry.is_dir():
                yield from _iter_test_files(entry)
            elif (
                entry.is_file()
                and (entry.name.startswith("test_") or entry.name.endswith("_test.py"))
                and entry.suffix == ".py"
            ):
                yield entry

    for test_file in _iter_test_files(root_path):
        rel_path = str(test_file.relative_to(root_path))
        if rel_path in all_tests:
            continue
        tests = extract_test_info(test_file)
        if tests:
            all_tests[rel_path] = {
                "type": classify_test_type(rel_path),
                "tests": tests,
            }

    return all_tests


def generate_report(
    root_path: Path,
    existing_tests: dict | None = None,
    added_tests: list[str] | None = None,
    coverage_percent: float | None = None,
) -> str:
    """Generate the markdown report."""

    current_tests = discover_all_tests(root_path)

    lines = [
        "# Test Suite Documentation",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
    ]

    # Summary section
    lines.extend(
        [
            "## Summary",
            "",
        ]
    )

    total_tests = sum(len(f["tests"]) for f in current_tests.values())
    total_files = len(current_tests)

    lines.append(f"- **Total test files:** {total_files}")
    lines.append(f"- **Total test functions:** {total_tests}")

    if coverage_percent is not None:
        lines.append(f"- **Code coverage:** {coverage_percent:.1f}%")

    lines.append("")

    # Tests by type
    by_type = {"unit": [], "functional": [], "e2e": [], "other": []}
    for file_path, info in current_tests.items():
        by_type[info["type"]].append((file_path, info))

    lines.extend(
        [
            "### Tests by Type",
            "",
            "| Type | Files | Tests |",
            "|------|-------|-------|",
        ]
    )

    for test_type in ["unit", "functional", "e2e", "other"]:
        files = by_type[test_type]
        test_count = sum(len(f[1]["tests"]) for f in files)
        if files or test_type != "other":
            lines.append(f"| {test_type.capitalize()} | {len(files)} | {test_count} |")

    lines.append("")

    # Added tests section (if provided)
    if added_tests:
        lines.extend(
            [
                "## Newly Added Tests",
                "",
            ]
        )
        for test_file in added_tests:
            lines.append(f"- `{test_file}`")
        lines.append("")

    # Detailed test documentation
    lines.extend(
        [
            "## Test Details",
            "",
        ]
    )

    for test_type in ["unit", "functional", "e2e", "other"]:
        files = by_type[test_type]
        if not files:
            continue

        lines.extend(
            [
                f"### {test_type.capitalize()} Tests",
                "",
            ]
        )

        for file_path, info in sorted(files):
            lines.extend(
                [
                    f"#### {md_code(file_path)}",
                    "",
                ]
            )

            if info["tests"]:
                lines.append("| Test | Line | Description |")
                lines.append("|------|------|-------------|")

                for test in info["tests"]:
                    purpose = md_text(
                        infer_test_purpose(test["name"], test["docstring"])
                    )
                    lines.append(
                        f"| {md_code(test['name'])} | {test['line']} | {purpose} |"
                    )

                lines.append("")

    # Coverage details (placeholder for integration)
    if coverage_percent is not None:
        lines.extend(
            [
                "## Coverage Details",
                "",
                f"Overall code coverage: **{coverage_percent:.1f}%**",
                "",
                "Run `python scripts/analyze_coverage.py` for detailed file-by-file coverage.",
                "",
            ]
        )

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate test documentation report")
    parser.add_argument(
        "path", nargs="?", default=".", help="Root path (default: current directory)"
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Output file path (default: .lb_workspace/tests/TEST_REPORT.md)",
    )
    parser.add_argument("--added", nargs="*", help="List of newly added test files")
    parser.add_argument("--coverage", type=float, help="Coverage percentage to include")
    parser.add_argument(
        "--json", action="store_true", help="Output as JSON instead of markdown"
    )
    args = parser.parse_args()

    root_path = Path(args.path).resolve()

    if not root_path.exists():
        print(f"Error: Path does not exist: {root_path}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        tests = discover_all_tests(root_path)
        print(json.dumps(tests, indent=2))
    else:
        report = generate_report(
            root_path,
            added_tests=args.added,
            coverage_percent=args.coverage,
        )

        output_path = args.output
        if not output_path:
            output_dir = root_path / ".lb_workspace" / "tests"
            output_dir.mkdir(parents=True, exist_ok=True)
            output_path = output_dir / "TEST_REPORT.md"
        else:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)

        output_path.write_text(report)
        print(f"✅ Test report generated: {output_path}")


if __name__ == "__main__":
    main()
