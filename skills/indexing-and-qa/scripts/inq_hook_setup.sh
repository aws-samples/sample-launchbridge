#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Setup Kiro hooks for codebase re-indexing

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <codebase_absolute_path>"
    exit 1
fi

CODEBASE_PATH="$1"

# Validate input is absolute path
if [[ ! "$CODEBASE_PATH" = /* ]]; then
    echo "Error: Path must be absolute (start with /)"
    exit 1
fi

# Validate codebase directory exists
if [ ! -d "$CODEBASE_PATH" ]; then
    echo "Error: Codebase directory does not exist: $CODEBASE_PATH"
    exit 1
fi

# Create target directory
TARGET_DIR="$CODEBASE_PATH/.kiro/hooks"
# Refuse a symbolic link on the way before creating anything, since mkdir -p
# would follow it.
CHECK_PATH="$CODEBASE_PATH"
IFS='/' read -ra PARTS <<< ".kiro/hooks"
for PART in "${PARTS[@]}"; do
    [ -z "$PART" ] && continue
    CHECK_PATH="$CHECK_PATH/$PART"
    if [ -L "$CHECK_PATH" ]; then
        echo "Error: $CHECK_PATH is a symbolic link. Remove it and run again."
        exit 1
    fi
done
mkdir -p "$TARGET_DIR"

# Write only inside the repository, through no symbolic link: a .kiro/ that
# arrived with the repository could point the copies at files elsewhere.
if [ "$(cd -P "$TARGET_DIR" && pwd -P)" != "$(cd -P "$CODEBASE_PATH" && pwd -P)/.kiro/hooks" ]; then
    echo "Error: $TARGET_DIR is, or is reached through, a symbolic link. Remove the link and run again."
    exit 1
fi

# Get script directory to find templates
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../templates"

# Copy all inq_reindex hook templates
COPIED=0
for hook_file in "$TEMPLATE_DIR"/inq_reindex*.kiro.hook; do
    if [ -f "$hook_file" ]; then
        FILENAME=$(basename "$hook_file")
        if [ -L "$TARGET_DIR/$FILENAME" ]; then
            echo "Error: $TARGET_DIR/$FILENAME is a symbolic link. Remove it and run again."
            exit 1
        fi
        cp "$hook_file" "$TARGET_DIR/$FILENAME"
        echo "✓ Copied: $FILENAME"
        COPIED=$((COPIED + 1))
    fi
done

if [ $COPIED -eq 0 ]; then
    echo "Warning: No hook templates found in $TEMPLATE_DIR"
    exit 1
fi

echo ""
echo "✓ $COPIED hook(s) installed to: $TARGET_DIR"
echo "✓ Reload Kiro window to activate hooks"
