#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Validates the config-prompt-store.yaml registry file.

Checks:
- Valid YAML syntax
- Required top-level keys (configs, prompts)
- Required fields per config entry (name, description, location, current_value, cli_arg)
- Required fields per prompt entry (name, description, location, cli_arg)
- cli_arg is boolean
- version (if present) is a positive integer
- No duplicate names

Usage:
    python validate_registry.py <path-to-yaml>
"""

import sys
import yaml


def validate(path):
    # Parse YAML
    try:
        with open(path, "r") as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        print(f"FAIL: Invalid YAML syntax: {e}")
        return False
    except FileNotFoundError:
        print(f"FAIL: File not found: {path}")
        return False

    if not isinstance(data, dict):
        print("FAIL: Root must be a YAML mapping")
        return False

    errors = []

    # Check top-level keys
    for key in ["configs", "prompts"]:
        if key not in data:
            errors.append(f"Missing top-level key: '{key}'")
        elif not isinstance(data[key], list):
            errors.append(f"'{key}' must be a list")

    if errors:
        for e in errors:
            print(f"FAIL: {e}")
        return False

    # Validate configs
    config_required = {"name", "description", "location", "current_value", "cli_arg"}
    config_names = set()
    for i, entry in enumerate(data.get("configs", [])):
        if not isinstance(entry, dict):
            errors.append(f"configs[{i}]: must be a mapping")
            continue
        missing = config_required - set(entry.keys())
        if missing:
            errors.append(
                f"configs[{i}] ({entry.get('name', '?')}): missing fields: {missing}"
            )
        if "cli_arg" in entry and not isinstance(entry["cli_arg"], bool):
            errors.append(
                f"configs[{i}] ({entry.get('name', '?')}): cli_arg must be boolean"
            )
        name = entry.get("name")
        if name and name in config_names:
            errors.append(f"configs[{i}]: duplicate name '{name}'")
        if name:
            config_names.add(name)

    # Validate prompts
    prompt_required = {"name", "description", "location", "cli_arg"}
    prompt_names = set()
    for i, entry in enumerate(data.get("prompts", [])):
        if not isinstance(entry, dict):
            errors.append(f"prompts[{i}]: must be a mapping")
            continue
        missing = prompt_required - set(entry.keys())
        if missing:
            errors.append(
                f"prompts[{i}] ({entry.get('name', '?')}): missing fields: {missing}"
            )
        if "cli_arg" in entry and not isinstance(entry["cli_arg"], bool):
            errors.append(
                f"prompts[{i}] ({entry.get('name', '?')}): cli_arg must be boolean"
            )
        # version is optional, but if present it must be a positive integer.
        # bool is a subclass of int, so reject it explicitly.
        if "version" in entry:
            version = entry["version"]
            if isinstance(version, bool) or not isinstance(version, int) or version < 1:
                errors.append(
                    f"prompts[{i}] ({entry.get('name', '?')}): version must be a positive integer"
                )
        name = entry.get("name")
        if name and name in prompt_names:
            errors.append(f"prompts[{i}]: duplicate name '{name}'")
        if name:
            prompt_names.add(name)

    if errors:
        for e in errors:
            print(f"FAIL: {e}")
        return False

    print(
        f"OK: {len(data.get('configs', []))} configs, {len(data.get('prompts', []))} prompts validated"
    )
    return True


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python validate_registry.py <path-to-yaml>")
        sys.exit(1)
    success = validate(sys.argv[1])
    sys.exit(0 if success else 1)
