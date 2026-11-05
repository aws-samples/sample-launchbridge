#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Analyze Python code for testability.

Identifies functions, classes, and modules that could benefit from tests.
Prioritizes by complexity and importance.
"""

import argparse
import ast
import json
import sys
from pathlib import Path


class TestabilityAnalyzer(ast.NodeVisitor):
    """AST visitor to analyze code testability."""

    def __init__(self, file_path: str):
        self.file_path = file_path
        self.functions = []
        self.classes = []
        self.current_class = None

    def visit_FunctionDef(self, node):
        self._analyze_function(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self._analyze_function(node, is_async=True)
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        old_class = self.current_class
        self.current_class = node.name

        methods = []
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if not item.name.startswith("_") or item.name in (
                    "__init__",
                    "__call__",
                ):
                    methods.append(item.name)

        self.classes.append(
            {
                "name": node.name,
                "line": node.lineno,
                "methods": methods,
                "method_count": len(methods),
                "has_init": any(
                    isinstance(n, ast.FunctionDef) and n.name == "__init__"
                    for n in node.body
                ),
            }
        )

        self.generic_visit(node)
        self.current_class = old_class

    def _analyze_function(self, node, is_async=False):
        # Skip private functions (except special methods in classes)
        if node.name.startswith("_") and node.name not in ("__init__", "__call__"):
            return

        # Skip if inside a class (handled separately)
        if self.current_class:
            return

        # Calculate complexity score
        complexity = self._calculate_complexity(node)

        # Check for return statements
        has_return = any(
            isinstance(n, ast.Return) and n.value is not None for n in ast.walk(node)
        )

        # Check for external calls (potential side effects)
        has_side_effects = self._has_side_effects(node)

        # Calculate testability score (higher = more important to test)
        testability_score = complexity
        if has_return:
            testability_score += 2  # Functions with returns are easier to test
        if not has_side_effects:
            testability_score += 1  # Pure functions are easier to test

        self.functions.append(
            {
                "name": node.name,
                "line": node.lineno,
                "is_async": is_async,
                "args": [arg.arg for arg in node.args.args if arg.arg != "self"],
                "complexity": complexity,
                "has_return": has_return,
                "has_side_effects": has_side_effects,
                "testability_score": testability_score,
            }
        )

    def _calculate_complexity(self, node) -> int:
        """Simple cyclomatic complexity approximation."""
        complexity = 1
        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.While, ast.For, ast.ExceptHandler)):
                complexity += 1
            elif isinstance(child, ast.BoolOp):
                complexity += len(child.values) - 1
            elif isinstance(
                child, (ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp)
            ):
                complexity += 1
        return complexity

    def _has_side_effects(self, node) -> bool:
        """Check if function likely has side effects."""
        side_effect_indicators = {
            "print",
            "write",
            "save",
            "delete",
            "remove",
            "update",
            "insert",
            "send",
            "post",
            "put",
        }

        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    if child.func.id.lower() in side_effect_indicators:
                        return True
                elif isinstance(child.func, ast.Attribute):
                    if child.func.attr.lower() in side_effect_indicators:
                        return True
        return False


def analyze_file(file_path: Path) -> dict | None:
    """Analyze a single Python file."""
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(content)

        analyzer = TestabilityAnalyzer(str(file_path))
        analyzer.visit(tree)

        return {
            "path": str(file_path),
            "functions": analyzer.functions,
            "classes": analyzer.classes,
        }
    except SyntaxError as e:
        return {"path": str(file_path), "error": f"Syntax error: {e}"}
    except Exception as e:
        return {"path": str(file_path), "error": str(e)}


def analyze_codebase(root_path: Path) -> list:
    """Analyze all Python files in a codebase."""
    results = []

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
        "tests",
        "test",
        "tests/targets",
        "site-packages",
    }

    skip_patterns = {"test_", "_test.py", "conftest.py", "setup.py"}

    for py_file in root_path.rglob("*.py"):
        # Skip excluded directories
        if any(skip_dir in py_file.parts for skip_dir in skip_dirs):
            continue

        # Skip test files
        if any(pattern in py_file.name for pattern in skip_patterns):
            continue

        result = analyze_file(py_file)
        if result and not result.get("error"):
            if result["functions"] or result["classes"]:
                results.append(result)

    return results


def prioritize_for_testing(analysis: list) -> dict:
    """Prioritize what should be tested first."""

    all_functions = []
    all_classes = []

    for file_result in analysis:
        file_path = file_result["path"]

        for func in file_result.get("functions", []):
            func["file"] = file_path
            all_functions.append(func)

        for cls in file_result.get("classes", []):
            cls["file"] = file_path
            all_classes.append(cls)

    # Sort by testability score (higher first)
    all_functions.sort(key=lambda x: x["testability_score"], reverse=True)
    all_classes.sort(key=lambda x: x["method_count"], reverse=True)

    return {
        "functions": all_functions,
        "classes": all_classes,
        "summary": {
            "total_functions": len(all_functions),
            "total_classes": len(all_classes),
            "files_analyzed": len(analysis),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Analyze code testability")
    parser.add_argument(
        "path", nargs="?", default=".", help="Root path (default: current directory)"
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--top", type=int, default=10, help="Show top N items (default: 10)"
    )
    args = parser.parse_args()

    root_path = Path(args.path).resolve()

    if not root_path.exists():
        print(f"Error: Path does not exist: {root_path}", file=sys.stderr)
        sys.exit(1)

    analysis = analyze_codebase(root_path)
    prioritized = prioritize_for_testing(analysis)

    if args.json:
        print(json.dumps(prioritized, indent=2))
    else:
        print("\n=== Testability Analysis ===\n")
        print(f"Files analyzed: {prioritized['summary']['files_analyzed']}")
        print(f"Functions found: {prioritized['summary']['total_functions']}")
        print(f"Classes found: {prioritized['summary']['total_classes']}")

        if prioritized["functions"]:
            print(f"\n🎯 Top {args.top} functions to test (by priority):\n")
            for i, func in enumerate(prioritized["functions"][: args.top], 1):
                complexity_bar = "●" * min(func["complexity"], 10)
                print(
                    f"  {i}. {func['name']}() - complexity: {complexity_bar} ({func['complexity']})"
                )
                print(f"     File: {func['file']}:{func['line']}")
                print(f"     Args: {', '.join(func['args']) or 'none'}")
                effects = (
                    "has side effects" if func["has_side_effects"] else "pure function"
                )
                returns = "returns value" if func["has_return"] else "no return"
                print(f"     {effects}, {returns}")
                print()

        if prioritized["classes"]:
            print(f"\n🏗️  Top {args.top} classes to test:\n")
            for i, cls in enumerate(prioritized["classes"][: args.top], 1):
                print(f"  {i}. {cls['name']} - {cls['method_count']} methods")
                print(f"     File: {cls['file']}:{cls['line']}")
                if cls["methods"]:
                    print(
                        f"     Methods: {', '.join(cls['methods'][:5])}"
                        + ("..." if len(cls["methods"]) > 5 else "")
                    )
                print()


if __name__ == "__main__":
    main()
