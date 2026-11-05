#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Unified test runner for the Python testing framework.

Supports running all tests, specific test types, or individual test files.
Integrates with CI configurations when available.
"""

import argparse
import os
import subprocess  # nosec B404 - subprocess is required to invoke pytest; commands are list-form with shell=False
import sys
from pathlib import Path


def find_ci_test_command(root_path: Path) -> str | None:
    """Check CI configs for existing test commands."""

    # Check GitLab CI
    gitlab_ci = root_path / ".gitlab-ci.yml"
    if gitlab_ci.exists():
        content = gitlab_ci.read_text(encoding="utf-8", errors="ignore")
        if "pytest" in content:
            return "pytest"

    # Check GitHub Actions
    workflows_dir = root_path / ".github" / "workflows"
    if workflows_dir.exists():
        for workflow in workflows_dir.glob("*.yml"):
            content = workflow.read_text(encoding="utf-8", errors="ignore")
            if "pytest" in content:
                return "pytest"

    # Check Makefile
    makefile = root_path / "Makefile"
    if makefile.exists():
        content = makefile.read_text(encoding="utf-8", errors="ignore")
        if "test:" in content:
            return "make test"

    return None


def _git(root_path: Path, *args: str) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(  # nosec B603 B607 - fixed git argv, shell=False
            # core.fsmonitor off: the repository's config names no program here.
            ["git", "-c", "core.fsmonitor=false", "-C", str(root_path), *args],
            capture_output=True,
            text=True,
            timeout=30,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def venv_problem(root_path: Path, venv_dir: Path) -> str | None:
    """Why a venv inside the project should not be run, or None if it can be.

    It must be a real venv, owned by the current user, and, in a git repository,
    neither tracked nor un-ignored: a venv that arrived with the repository's
    content would run whatever it contains with the operator's credentials.
    """
    if not (venv_dir / "pyvenv.cfg").is_file():
        return "not a virtual environment (no pyvenv.cfg)"
    if hasattr(os, "getuid") and venv_dir.stat().st_uid != os.getuid():
        return "not owned by the current user"
    inside = _git(root_path, "rev-parse", "--is-inside-work-tree")
    if inside is None or inside.returncode != 0:
        return None
    rel = venv_dir.relative_to(root_path).as_posix()
    # Case-insensitively: on macOS and Windows a committed `.VENV/` is the same
    # folder as `.venv`, and a case-sensitive listing misses it.
    tracked = _git(root_path, "ls-files", "-s", "-z", "--", f":(icase){rel}")
    if tracked is None or tracked.returncode != 0:
        return "git could not list its tracked files"
    if tracked.stdout.strip("\0"):
        return "tracked by git"
    ignored = _git(root_path, "check-ignore", "-q", rel)
    if ignored is not None and ignored.returncode != 0:
        return "not gitignored"
    return None


NO_PROJECT_VENV = (
    "No usable project virtual environment, so the project's tests were not run. "
    "Create one with testing-framework's environment step (it asks first); the "
    "tests never run in LaunchBridge's own .venv_lb."
)


def find_project_python(root_path: Path) -> str | None:
    """The project's own virtual environment Python, or None if there is none.

    Priority follows AGENTS.md: use the project's own venv, never .venv_lb (which
    is reserved for the LaunchBridge skills suite, and whose credentials and
    packages the project's tests and conftest must not get). A venv that fails
    venv_problem() is skipped with a warning.
    """
    scripts, name = ("Scripts", "python.exe") if os.name == "nt" else ("bin", "python")
    venv_candidates = [
        root_path / venv / scripts / name
        for venv in ("venv_repo", ".venv_repo", ".venv", "venv", "env", ".env")
    ]
    for candidate in venv_candidates:
        if candidate.exists():
            venv_dir = candidate.parent.parent
            problem = venv_problem(root_path, venv_dir)
            if problem:
                print(
                    f"Warning: not using {venv_dir}: {problem}.",
                    file=sys.stderr,
                )
                continue
            return str(candidate)
    return None


def run_tests(
    root_path: Path,
    test_type: str | None = None,
    test_path: str | None = None,
    verbose: bool = False,
    coverage: bool = False,
    fail_fast: bool = False,
) -> int:
    """Run tests with pytest."""

    python = find_project_python(root_path)
    if python is None:
        print(f"Error: {NO_PROJECT_VENV}", file=sys.stderr)
        return 2
    cmd = [python, "-m", "pytest"]
    paths: list[str] = []

    # Determine test path
    if test_path:
        paths.append(test_path)
    elif test_type:
        # Look for type-specific test directories
        type_paths = [
            f".lb_workspace/tests/{test_type}",
            f"tests/{test_type}",
            f"test/{test_type}",
        ]
        for tp in type_paths:
            if (root_path / tp).exists():
                paths.append(tp)
                break
        else:
            print(f"Warning: No {test_type} test directory found, running all tests")

    # Add options
    if verbose:
        cmd.append("-v")
    else:
        cmd.append("-q")

    if coverage:
        cmd.extend(["--cov", ".", "--cov-report", "term-missing"])

    if fail_fast:
        cmd.append("-x")

    # Add color output
    cmd.append("--color=yes")

    # Paths go after "--" so one that starts with "-" is not read as an option.
    if paths:
        cmd.extend(["--", *paths])

    print(f"Running: {' '.join(cmd)}")
    print("-" * 50)

    print(f"Using Python: {python}")
    try:
        # cmd is a fixed list of pytest options followed by "--" and the test
        # paths. shell=False is explicit.
        result = subprocess.run(cmd, cwd=root_path, shell=False)  # nosec B603 - argv list, shell=False
        return result.returncode
    except FileNotFoundError:
        print(
            f"Error: pytest not found. Install with: {python} -m pip install pytest==9.1.1",
            file=sys.stderr,
        )
        return 1


def main():
    parser = argparse.ArgumentParser(
        description="Run Python tests",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                    # Run all tests
  %(prog)s --type unit        # Run only unit tests
  %(prog)s --type functional  # Run only functional tests
  %(prog)s --path tests/test_api.py  # Run specific test file
  %(prog)s --coverage         # Run with coverage report
  %(prog)s --fail-fast        # Stop on first failure
        """,
    )
    parser.add_argument(
        "path", nargs="?", default=".", help="Root path (default: current directory)"
    )
    parser.add_argument(
        "--type", "-t", choices=["unit", "functional", "e2e"], help="Test type to run"
    )
    parser.add_argument(
        "--path", "-p", dest="test_path", help="Specific test file or directory"
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument(
        "--coverage", "-c", action="store_true", help="Run with coverage"
    )
    parser.add_argument(
        "--fail-fast", "-x", action="store_true", help="Stop on first failure"
    )
    parser.add_argument(
        "--ci",
        action="store_true",
        help="Run the tests the way the project's CI does (pytest in the project's "
        "venv, or make test with --allow-make)",
    )
    parser.add_argument(
        "--allow-make",
        action="store_true",
        help="With --ci, run `make test` when that is what the CI runs (only after "
        "the user agreed: the Makefile decides what it runs)",
    )
    args = parser.parse_args()

    root_path = Path(args.path).resolve()

    if not root_path.exists():
        print(f"Error: Path does not exist: {root_path}", file=sys.stderr)
        sys.exit(1)

    # Check for CI command if requested
    if args.ci:
        ci_cmd = find_ci_test_command(root_path)
        if ci_cmd == "make test" and not args.allow_make:
            # The repository's Makefile decides what `make test` runs.
            print(
                "The project's CI runs `make test`, which runs whatever its Makefile "
                "says. Ask the user before running it, then add --allow-make.",
                file=sys.stderr,
            )
            sys.exit(3)
        if ci_cmd == "make test":
            print("Using CI test command: make test")
            # find_ci_test_command returns one of two hardcoded literal
            # strings ("pytest" or "make test"), never a value from a file.
            result = subprocess.run(  # nosec B603 - hardcoded literal command, shell=False
                ["make", "test"], cwd=root_path, shell=False
            )
            sys.exit(result.returncode)
        # "pytest": the project's own Python, as for any other run below.

    exit_code = run_tests(
        root_path,
        test_type=args.type,
        test_path=args.test_path,
        verbose=args.verbose,
        coverage=args.coverage,
        fail_fast=args.fail_fast,
    )

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
