#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Fix (default) or check the lint and formatting issues that the CI
# `format-lint` job in .github/workflows/ci.yml fails on.
#
#   ./run_lint.sh           auto-fix with ruff and Prettier, then report what is left
#   ./run_lint.sh --check   change nothing; pass or fail the way CI would
#
# Needs python3, npx (Node.js) and git. shellcheck is used if it is installed.
# CI runs this script with --check; keep tool versions here in sync with ci.yml.

set -o pipefail
cd "$(dirname "$0")" || exit 1

RUFF_VERSION="0.8.4"
YAMLLINT_VERSION="1.35.1"
PRETTIER_VERSION="3.8.1"
SHELLCHECK_VERSION="0.10.0"

MODE="fix"
case "${1:-}" in
    "") ;;
    --check) MODE="check" ;;
    -h | --help)
        sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *)
        echo "Usage: $0 [--check]" >&2
        exit 2
        ;;
esac

# Exclusions used by the CI format-lint job.
RUFF_EXCLUDE=".venv,node_modules,.ash,dist,build,infra/cdk.out,tests/targets,project_dependencies,tests/regression/baselines"
PRETTIER_YAML_EXCLUDE='(^|/)(node_modules|\.venv|dist|build|\.ash|docs|tests/targets|tests/regression/baselines|tests/regression/outputs)/|(^|/)(package-lock\.json|tailwind\.config\.js)$'
SHELLCHECK_EXCLUDE='(^|/)(node_modules|\.venv|\.ash|docs|tests/targets)/'
YAMLLINT_CONFIG="{extends: default, rules: {line-length: {max: 200}, document-start: disable, comments: {min-spaces-from-content: 1}}}"

TMP=$(mktemp -d) || exit 1
trap 'rm -rf "$TMP"' EXIT

FAILED=""
fail() { FAILED="$FAILED $1"; }

# Print tracked and new (non-ignored) regular files whose path matches $1 and
# not $2, NUL-separated. This is the set of files CI sees once you commit.
files() {
    git ls-files -z --cached --others --exclude-standard | tr '\0' '\n' | sort -u |
        grep -E "$1" | grep -vE "$2" |
        while IFS= read -r f; do
            if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\0' "$f"; fi
        done
}

# Python tools, pinned to the CI versions.
VENV=".venv_lint"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV" || exit 1
"$VENV/bin/pip" install -q --disable-pip-version-check \
    "ruff==$RUFF_VERSION" "yamllint==$YAMLLINT_VERSION" || exit 1

echo "== ruff =="
if [ "$MODE" = "fix" ]; then
    "$VENV/bin/ruff" check --fix --exclude "$RUFF_EXCLUDE" . || fail ruff-check
    "$VENV/bin/ruff" format --exclude "$RUFF_EXCLUDE" . || fail ruff-format
else
    "$VENV/bin/ruff" check --exclude "$RUFF_EXCLUDE" . || fail ruff-check
    "$VENV/bin/ruff" format --check --exclude "$RUFF_EXCLUDE" . || fail ruff-format
fi

echo "== prettier =="
files '\.(js|jsx|ts|tsx|json|css|md|ya?ml)$' "$PRETTIER_YAML_EXCLUDE" >"$TMP/prettier"
if [ -s "$TMP/prettier" ]; then
    if [ "$MODE" = "fix" ]; then PRETTIER_FLAG="--write"; else PRETTIER_FLAG="--check"; fi
    xargs -0 npx --yes "prettier@$PRETTIER_VERSION" "$PRETTIER_FLAG" --log-level warn \
        <"$TMP/prettier" || fail prettier
fi

echo "== shellcheck =="
if command -v shellcheck >/dev/null 2>&1; then
    INSTALLED=$(shellcheck --version | awk '/^version:/ {print $2}')
    if [ "$INSTALLED" != "$SHELLCHECK_VERSION" ]; then
        echo "note: shellcheck $INSTALLED installed, CI uses $SHELLCHECK_VERSION"
    fi
    files '\.sh$' "$SHELLCHECK_EXCLUDE" >"$TMP/shell"
    if [ -s "$TMP/shell" ]; then
        xargs -0 shellcheck -e SC1091 -f gcc <"$TMP/shell" || fail shellcheck
    fi
else
    echo "shellcheck not installed, skipping (brew install shellcheck)"
fi

echo "== yamllint =="
files '\.ya?ml$' "$PRETTIER_YAML_EXCLUDE" >"$TMP/yaml"
if [ -s "$TMP/yaml" ]; then
    xargs -0 "$VENV/bin/yamllint" -f parsable -d "$YAMLLINT_CONFIG" <"$TMP/yaml" || fail yamllint
fi

echo
if [ -n "$FAILED" ]; then
    echo "Issues left to fix by hand:$FAILED"
    exit 1
elif [ "$MODE" = "fix" ]; then
    echo "Done. Review 'git diff' and commit the changes, since CI checks the commit."
else
    echo "All checks passed."
fi
