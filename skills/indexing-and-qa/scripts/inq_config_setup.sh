#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Setup LaunchBridge config for a codebase

# The script will:
# 1. Set codebase_dir to the absolute codebase path
# 2. Set output_dir to the specified relative path (or default .lb_workspace/indexing_and_qa)
# 3. Create the config at {codebase_path}/{output_path}/inq_config.yaml

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <codebase_absolute_path> [output_relative_path]"
    echo "  output_relative_path: Optional, default is .lb_workspace/indexing_and_qa"
    exit 1
fi

CODEBASE_PATH="$1"
OUTPUT_PATH="${2:-.lb_workspace/indexing_and_qa}"

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

# The output folder is a path inside the repository: no leading "./" or trailing
# "/", not absolute, and no ".." component.
while [[ "$OUTPUT_PATH" == ./* ]]; do OUTPUT_PATH="${OUTPUT_PATH#./}"; done
while [[ "$OUTPUT_PATH" == */ ]]; do OUTPUT_PATH="${OUTPUT_PATH%/}"; done
if [[ -z "$OUTPUT_PATH" || "$OUTPUT_PATH" == /* || "/$OUTPUT_PATH/" == */../* ]]; then
    echo "Error: the output path must be a folder inside the repository, without '..': $OUTPUT_PATH"
    exit 1
fi

# Create target directory
TARGET_DIR="$CODEBASE_PATH/$OUTPUT_PATH"
# Refuse a symbolic link on the way before creating anything, since mkdir -p
# would follow it.
CHECK_PATH="$CODEBASE_PATH"
IFS='/' read -ra PARTS <<< "$OUTPUT_PATH"
for PART in "${PARTS[@]}"; do
    [ -z "$PART" ] && continue
    CHECK_PATH="$CHECK_PATH/$PART"
    if [ -L "$CHECK_PATH" ]; then
        echo "Error: $CHECK_PATH is a symbolic link. Remove it and run again."
        exit 1
    fi
done
mkdir -p "$TARGET_DIR"

# Write only inside the repository, through no symbolic link: an .lb_workspace/
# that arrived with the repository could point the config at a file elsewhere.
if [ "$(cd -P "$TARGET_DIR" && pwd -P)" != "$(cd -P "$CODEBASE_PATH" && pwd -P)/$OUTPUT_PATH" ]; then
    echo "Error: $TARGET_DIR is outside the repository, or reached through a symbolic link. Remove the link and run again."
    exit 1
fi

# Get script directory to find template
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="$SCRIPT_DIR/../templates/inq_config_template.yaml"

# Validate template exists
if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "Error: Template file not found: $TEMPLATE_FILE"
    exit 1
fi

# Copy and update config
TARGET_FILE="$TARGET_DIR/inq_config.yaml"

if [ -L "$TARGET_FILE" ]; then
    echo "Error: $TARGET_FILE is a symbolic link. Remove it and run again."
    exit 1
fi

# Backup existing config if it exists
if [ -f "$TARGET_FILE" ]; then
    BACKUP_FILE="$TARGET_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$TARGET_FILE" "$BACKUP_FILE"
    echo "✓ Existing config backed up to: $BACKUP_FILE"
fi

cp "$TEMPLATE_FILE" "$TARGET_FILE"

# Set codebase_dir and output_dir. Each value is written as a JSON string, which
# is also a valid YAML double-quoted scalar, so any path (quotes, backslashes,
# newlines) is written as data and cannot change the rest of the file.
python3 -I - "$TARGET_FILE" "$CODEBASE_PATH" "$OUTPUT_PATH" <<'PYEOF'
import json, pathlib, re, sys

path, codebase, output = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text(encoding="utf-8")
for key, value in (("codebase_dir", codebase), ("output_dir", output)):
    line = f"{key}: {json.dumps(value)}"
    text, n = re.subn(rf"^{key}:.*$", lambda _m: line, text, count=1, flags=re.M)
    if n != 1:
        sys.exit(f"Error: {key} not found in {path}")
path.write_text(text, encoding="utf-8")
PYEOF

echo "✓ Config created: $TARGET_FILE"
echo "✓ Codebase directory set to: $CODEBASE_PATH"
echo "✓ Output directory set to: $OUTPUT_PATH"
