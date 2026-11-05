#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Analyze test coverage for a Python codebase.

Runs pytest with coverage and generates a detailed report.
"""

import argparse
import json
import shutil
import subprocess  # nosec B404 - subprocess is required to invoke pytest; commands are list-form with shell=False
import sys
import tempfile
from pathlib import Path

from run_tests import NO_PROJECT_VENV, find_project_python


def run_coverage(
    root_path: Path, test_path: str | None = None, source_path: str | None = None
) -> dict:
    """Run pytest with coverage and return results."""

    # The JSON report goes to a fresh temporary directory, so a coverage.json
    # left in the project is neither read nor deleted.
    report_dir = Path(tempfile.mkdtemp(prefix="lb-coverage-"))
    coverage_file = report_dir / "coverage.json"

    # Build pytest command. Options use the `--opt=value` form and the test path
    # goes after "--", so a value starting with "-" is not read as an option.
    python = find_project_python(root_path)
    if python is None:
        shutil.rmtree(report_dir, ignore_errors=True)
        return {
            "success": False,
            "coverage_percent": 0,
            "files": [],
            "uncovered_lines": {},
            "error": NO_PROJECT_VENV,
        }
    cmd = [python, "-m", "pytest"]
    cmd.append(f"--cov={source_path or '.'}")
    cmd.append(f"--cov-report=json:{coverage_file}")
    cmd.append("--cov-report=term-missing")
    cmd.append("-q")
    if test_path:
        cmd.extend(["--", test_path])

    result = {
        "success": False,
        "coverage_percent": 0,
        "files": [],
        "uncovered_lines": {},
        "error": None,
    }

    try:
        # cmd is a fixed list of pytest options; the caller's paths are passed
        # as option values or after "--", never through a shell.
        proc = subprocess.run(  # nosec B603 - argv list, shell=False
            cmd,
            cwd=root_path,
            capture_output=True,
            text=True,
            timeout=300,
            shell=False,
        )

        # Parse the report if pytest wrote one
        if coverage_file.exists():
            try:
                with open(coverage_file, encoding="utf-8") as f:
                    cov_data = json.load(f)
            except json.JSONDecodeError as e:
                result["error"] = f"Failed to parse coverage report: {e}"
                return result

            result["success"] = True
            result["coverage_percent"] = cov_data.get("totals", {}).get(
                "percent_covered", 0
            )

            for file_path, file_data in cov_data.get("files", {}).items():
                file_info = {
                    "path": file_path,
                    "covered_lines": file_data.get("summary", {}).get(
                        "covered_lines", 0
                    ),
                    "total_lines": file_data.get("summary", {}).get(
                        "num_statements", 0
                    ),
                    "percent": file_data.get("summary", {}).get("percent_covered", 0),
                    "missing_lines": file_data.get("missing_lines", []),
                }
                result["files"].append(file_info)

                if file_info["missing_lines"]:
                    result["uncovered_lines"][file_path] = file_info["missing_lines"]

            # Sort by coverage (lowest first)
            result["files"].sort(key=lambda x: x["percent"])

        else:
            result["error"] = (
                proc.stderr or proc.stdout or "Coverage report not generated"
            )

    except subprocess.TimeoutExpired:
        result["error"] = "Test execution timed out after 5 minutes"
    except FileNotFoundError:
        result["error"] = (
            "pytest not found. Install with: pip install pytest==9.1.1 pytest-cov==7.1.0"
        )
    except Exception as e:
        result["error"] = str(e)
    finally:
        shutil.rmtree(report_dir, ignore_errors=True)

    return result


def main():
    parser = argparse.ArgumentParser(description="Analyze test coverage")
    parser.add_argument(
        "path", nargs="?", default=".", help="Root path (default: current directory)"
    )
    parser.add_argument("--test-path", help="Specific test path to run")
    parser.add_argument("--source", help="Source directory to measure coverage for")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--min-coverage",
        type=float,
        default=0,
        help="Minimum coverage threshold (exit 1 if below)",
    )
    args = parser.parse_args()

    root_path = Path(args.path).resolve()

    if not root_path.exists():
        print(f"Error: Path does not exist: {root_path}", file=sys.stderr)
        sys.exit(1)

    result = run_coverage(root_path, args.test_path, args.source)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["error"]:
            print(f"❌ Error: {result['error']}")
            sys.exit(1)

        print("\n=== Coverage Report ===\n")
        print(f"Overall coverage: {result['coverage_percent']:.1f}%")

        if result["files"]:
            print("\n📊 Coverage by file (sorted by coverage):\n")
            for f in result["files"]:
                bar_len = int(f["percent"] / 5)
                bar = "█" * bar_len + "░" * (20 - bar_len)
                print(f"  {f['percent']:5.1f}% {bar} {f['path']}")
                if f["missing_lines"] and len(f["missing_lines"]) <= 10:
                    print(f"         Missing lines: {f['missing_lines']}")

        print("\n📈 Summary:")
        print(f"   Files analyzed: {len(result['files'])}")
        print(f"   Total coverage: {result['coverage_percent']:.1f}%")

        if args.min_coverage and result["coverage_percent"] < args.min_coverage:
            print(
                f"\n⚠️  Coverage {result['coverage_percent']:.1f}% is below threshold {args.min_coverage}%"
            )
            sys.exit(1)


if __name__ == "__main__":
    main()
