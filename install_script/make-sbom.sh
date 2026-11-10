#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# make-sbom.sh
# Writes CycloneDX SBOMs for the frozen Python dependency set
# (project_dependencies/requirements.lock.txt) and the installer's npm
# dependencies (package-lock.json at the repository root, runtime only).
#
# Usage: ./install_script/make-sbom.sh [output-dir]   (default: sbom/)
#
# Attach the two files to each release. Requires uv (uvx) and npm (npx).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/sbom}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

uvx --from "cyclonedx-bom==7.5.0" cyclonedx-py requirements \
  --of JSON --output-reproducible -o "$OUT_DIR/python.cdx.json" \
  "$REPO_ROOT/project_dependencies/requirements.lock.txt"

(cd "$REPO_ROOT" \
  && npx --yes "@cyclonedx/cyclonedx-npm@6.0.1" --package-lock-only --omit dev \
    --output-reproducible --output-file "$OUT_DIR/npm.cdx.json")

echo "Wrote $OUT_DIR/python.cdx.json and $OUT_DIR/npm.cdx.json"
