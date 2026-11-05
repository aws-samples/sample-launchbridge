#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Run codebase and/or artifact indexing
#
# Usage:
#   inq_run_indexing.sh <codebase_absolute_path> [--mode <codebase|artifact|both>]
#                                                [--report-scope] [--allow-unbounded]
#                                                [--confirm-data-handling [--basis TEXT]
#                                                 [--artifact-classification TEXT]]
#
# Modes:
#   codebase - Index codebase only (default)
#   artifact - Index engagement artifacts only
#   both     - Index codebase and artifacts in one pass
#
# --report-scope reports how much the run would send to Amazon Bedrock, and where,
# and exits without indexing.
#
# --allow-unbounded lets a run go ahead when a ceiling in inq_config.yaml is 0.
#
# --confirm-data-handling records that the engagement's terms permit every
# destination the config uses, and exits without indexing. With
# --artifact-classification it also records that the project artifacts are cleared
# for the target account's data classification, which artifact runs require. Run it
# only after the user has confirmed them.
#
# Exit codes: 0 indexed, reported or confirmed, 1 failed, 3 refused because the run
# exceeds the ceiling in inq_config.yaml (or a ceiling is 0 without
# --allow-unbounded), 4 refused because a destination or the artifacts'
# classification is not confirmed, a file to be sent appears to contain a
# credential, or the transmission log could not be written. On 3 and 4 nothing was
# sent to Bedrock.

set -e

USAGE="Usage: $0 <codebase_absolute_path> [--mode <codebase|artifact|both>] [--report-scope] [--allow-unbounded] [--confirm-data-handling [--basis TEXT] [--artifact-classification TEXT]]"

if [ -z "$1" ]; then
    echo "$USAGE"
    exit 1
fi

CODEBASE_PATH="$1"
MODE="codebase"  # default mode
REPORT_SCOPE=""
EXTRA_ARGS=()

# Parse optional flags
shift
while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)
            if [ -z "$2" ]; then
                echo "Error: --mode requires a value (codebase, artifact, or both)"
                exit 1
            fi
            MODE="$2"
            shift 2
            ;;
        --report-scope)
            REPORT_SCOPE="--report-scope"
            shift
            ;;
        --confirm-data-handling)
            EXTRA_ARGS+=("--confirm-data-handling")
            shift
            ;;
        --basis)
            if [ -z "$2" ]; then
                echo "Error: --basis requires a value"
                exit 1
            fi
            EXTRA_ARGS+=("--basis" "$2")
            shift 2
            ;;
        --artifact-classification)
            if [ -z "$2" ]; then
                echo "Error: --artifact-classification requires a value"
                exit 1
            fi
            EXTRA_ARGS+=("--artifact-classification" "$2")
            shift 2
            ;;
        --allow-unbounded)
            EXTRA_ARGS+=("--allow-unbounded")
            shift
            ;;
        *)
            echo "Error: Unknown argument: $1"
            echo "$USAGE"
            exit 1
            ;;
    esac
done

# Validate mode
if [[ "$MODE" != "codebase" && "$MODE" != "artifact" && "$MODE" != "both" ]]; then
    echo "Error: Invalid mode '$MODE'. Must be one of: codebase, artifact, both"
    exit 1
fi

# Validate input is absolute path
if [[ ! "$CODEBASE_PATH" = /* ]]; then
    echo "Error: Path must be absolute (start with /)"
    echo "$USAGE"
    exit 1
fi

# Validate codebase directory exists
if [ ! -d "$CODEBASE_PATH" ]; then
    echo "Error: Codebase directory does not exist: $CODEBASE_PATH"
    exit 1
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate Python interpreter from virtual environment
# Use the venv's Python directly rather than relying on `source activate`,
# which is unreliable in non-interactive and agent-driven subprocess contexts.
VENV_PATH="$CODEBASE_PATH/.venv_lb"
if [ ! -d "$VENV_PATH" ]; then
    echo "Error: Virtual environment not found at: $VENV_PATH"
    exit 1
fi

# The interpreter runs with the operator's AWS credentials, so it must be one the
# operator created: a real venv, owned by them, and not part of the repository's
# content (lb-setup gitignores .venv_lb/).
if [ ! -f "$VENV_PATH/pyvenv.cfg" ]; then
    echo "Error: $VENV_PATH is not a virtual environment (no pyvenv.cfg). Re-run lb-setup."
    exit 1
fi
if [ ! -O "$VENV_PATH" ]; then
    echo "Error: $VENV_PATH is not owned by the current user. Remove it and re-run lb-setup."
    exit 1
fi
if git -c core.fsmonitor=false -C "$CODEBASE_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -n "$(git -c core.fsmonitor=false -C "$CODEBASE_PATH" ls-files -- .venv_lb | head -n 1)" ]; then
        echo "Error: .venv_lb is tracked by git in $CODEBASE_PATH. Remove it from the repository and re-run lb-setup."
        exit 1
    fi
    IGNORED=0
    git -c core.fsmonitor=false -C "$CODEBASE_PATH" check-ignore -q .venv_lb || IGNORED=$?
    if [ "$IGNORED" -gt 1 ]; then
        echo "Error: git could not read the repository in $CODEBASE_PATH (git check-ignore exited $IGNORED). Run 'git status' there to see why; rebuilding won't help."
        exit 1
    fi
    if [ "$IGNORED" -eq 1 ]; then
        echo "Error: .venv_lb is not gitignored in $CODEBASE_PATH. Add '.venv_lb/' to .gitignore (lb-setup does this) and run again."
        exit 1
    fi
fi

# It must also be the venv lb-setup created for this repository: lb-setup writes a
# random ID inside it and the same ID to the user's LaunchBridge state directory,
# outside every repository (lb-setup/scripts/venv_identity.py). A .venv_lb that
# arrived with the repository, in a ZIP or a copied working tree, has no match.
LB_STATE_BASE="${XDG_CONFIG_HOME:-}"
case "$LB_STATE_BASE" in
    /*) ;;
    *) LB_STATE_BASE="$HOME/.config" ;;
esac
REPO_REAL="$(cd -P "$CODEBASE_PATH" && pwd -P)"
if command -v sha256sum >/dev/null 2>&1; then
    REPO_KEY="$(printf '%s' "$REPO_REAL" | sha256sum | cut -c1-16)"
elif command -v shasum >/dev/null 2>&1; then
    REPO_KEY="$(printf '%s' "$REPO_REAL" | shasum -a 256 | cut -c1-16)"
else
    echo "Error: neither sha256sum nor shasum is installed, so the .venv_lb record can't be checked. Install one (coreutils or perl) and run again."
    exit 1
fi
VENV_RECORD="$LB_STATE_BASE/launchbridge/repos/$REPO_KEY/venv_id"
if [ ! -s "$VENV_PATH/.launchbridge_venv_id" ] || [ ! -f "$VENV_RECORD" ] ||
    ! cmp -s "$VENV_PATH/.launchbridge_venv_id" "$VENV_RECORD"; then
    echo "Error: $VENV_PATH was not created by lb-setup for this repository on this machine (it may have arrived with the repository). Remove it and re-run lb-setup."
    exit 1
fi

PYTHON="$VENV_PATH/bin/python"
if [ ! -f "$PYTHON" ]; then
    SEALED_PYTHON="$(cat "$LB_STATE_BASE/launchbridge/repos/$REPO_KEY/base_python" 2>/dev/null || true)"
    if [ -n "$SEALED_PYTHON" ] && [ ! -x "$SEALED_PYTHON" ]; then
        echo "Error: the Python $VENV_PATH was built from ($SEALED_PYTHON) is gone, for example after a Python upgrade. Run lb-setup, which rebuilds $VENV_PATH."
    else
        echo "Error: Python interpreter not found at: $PYTHON"
    fi
    exit 1
fi

# Run indexing
CONFIG_PATH="$CODEBASE_PATH/.lb_workspace/indexing_and_qa/inq_config.yaml"
if [ ! -f "$CONFIG_PATH" ]; then
    echo "Error: Config file not found at: $CONFIG_PATH"
    exit 1
fi

if [ -n "$REPORT_SCOPE" ]; then
    echo "Reporting indexing scope for '$MODE' mode (nothing will be indexed)..."
else
    echo "Running indexing in '$MODE' mode..."
fi

# Unquoted on purpose: $REPORT_SCOPE is either empty or the literal flag, and
# quoting it would pass an empty argument that argparse rejects.
# shellcheck disable=SC2086
# Start the indexing script through the guard lb-setup sealed, run by the venv's
# base interpreter (outside the repository) with -I -S, so nothing in the
# repository runs first. The guard refuses if .venv_lb changed since lb-setup
# sealed it, or if a link or a force-tracked file sits where LaunchBridge reads
# or writes (a link in the index folder would make IRIS write outside the
# repository); then it runs the script in .venv_lb's Python with its bytecode
# cache outside the repository.
STATE_DIR="$LB_STATE_BASE/launchbridge/repos/$REPO_KEY"
GUARD="$STATE_DIR/lb_guard.py"
BASE_PYTHON="$(cat "$STATE_DIR/base_python" 2>/dev/null || true)"
if [ ! -f "$GUARD" ] || [ -z "$BASE_PYTHON" ]; then
    echo "Error: $VENV_PATH has not been sealed by lb-setup on this machine. Run lb-setup."
    exit 1
fi
if [ ! -x "$BASE_PYTHON" ]; then
    echo "Error: the Python $VENV_PATH was built from ($BASE_PYTHON) is gone, for example after a Python upgrade. Run lb-setup, which rebuilds $VENV_PATH."
    exit 1
fi
# From the repository, so a relative artifact_dir names the same folder here as
# in the Q&A server and in the data-handling confirmation.
cd "$REPO_REAL" || exit 1
"$BASE_PYTHON" -I -S "$GUARD" exec "$REPO_REAL" -- -I "$SCRIPT_DIR/codebase_artifact_indexing.py" --config "$REPO_REAL/.lb_workspace/indexing_and_qa/inq_config.yaml" --mode "$MODE" $REPORT_SCOPE "${EXTRA_ARGS[@]}"
