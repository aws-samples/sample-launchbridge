# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Fail CI when a test skipped because something CI is meant to provide is missing.

Several test modules skip themselves when a binary, the ai-skills submodule or
an optional Python package is absent. Locally that is a convenience; in CI it
means a whole group of tests never ran while the job still passed. Other skips
are expected on some platforms (case-sensitive file systems, running as root)
and are left alone.

    python -I tests/check_required_skips.py report.xml
"""

import sys
import xml.etree.ElementTree as ET

# Skip messages that mean the CI environment is incomplete. Keep these in step
# with the skip reasons in tests/unit/.
REQUIRED = (
    "could not import",  # pytest.importorskip: mcp, plotly, pandas, yaml, chardet
    "git missing",
    "bash missing",
    "node is not installed",
    "ai-skills submodule is not initialized",
)


def main(path: str) -> int:
    bad = []
    for case in ET.parse(path).getroot().iter("testcase"):
        for skipped in case.iter("skipped"):
            # A module-level skip (importorskip at import time) puts only
            # "collection skipped" in message; the reason is in the text.
            message = f"{skipped.get('message') or ''} {skipped.text or ''}".strip()
            if any(reason in message for reason in REQUIRED):
                name = f"{case.get('classname', '')}::{case.get('name', '')}"
                bad.append(f"{name}: {message}")
    if bad:
        print(f"{len(bad)} test(s) skipped because CI is missing something they need:")
        for line in bad:
            print(f"  {line}")
        return 1
    print("No test skipped for a missing CI requirement.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: check_required_skips.py <junit-report.xml>")
    sys.exit(main(sys.argv[1]))
