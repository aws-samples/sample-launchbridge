# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""CI canary: runs a caller-supplied string through a shell (bandit B602)."""

import subprocess


def run(command: str) -> int:
    return subprocess.call(command, shell=True)
