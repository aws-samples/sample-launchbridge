#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Unified setup: runs config, hooks (Kiro only), and MCP setup in one call.
#
# Usage: inq_setup.sh <codebase_absolute_path> [--skip-hooks]
#   --skip-hooks: Skip Kiro hook installation (for non-Kiro agents)

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <codebase_absolute_path> [--skip-hooks]"
    exit 1
fi

CODEBASE_PATH="$1"
SKIP_HOOKS=false
if [ "$2" = "--skip-hooks" ]; then
    SKIP_HOOKS=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Config setup
bash "$SCRIPT_DIR/inq_config_setup.sh" "$CODEBASE_PATH"

# 2. Hook setup (Kiro only)
if [ "$SKIP_HOOKS" = false ]; then
    bash "$SCRIPT_DIR/inq_hook_setup.sh" "$CODEBASE_PATH"
else
    echo "⏭ Skipping hook installation (--skip-hooks)"
fi


echo ""
echo "✓ Setup complete for: $CODEBASE_PATH"
