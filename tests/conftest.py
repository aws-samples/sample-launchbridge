# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
import sys
from pathlib import Path

# Ensure the metric library is importable for all tests
lib_path = str(
    Path(__file__).resolve().parents[1]
    / "skills"
    / "evaluate-predictions"
    / "lib"
    / "metric-library"
)
if lib_path not in sys.path:
    sys.path.insert(0, lib_path)


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_launchbridge_state(monkeypatch, tmp_path_factory):
    """Keep LaunchBridge's per-user state for every test (and for the installer and
    scripts the tests start) in a temporary folder, never ~/.config/launchbridge,
    and the home folder in another: a global install writes into the agents'
    folders there. Tests that need a particular XDG_CONFIG_HOME or home folder set
    their own over these."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path_factory.mktemp("lb-state")))
    home = str(tmp_path_factory.mktemp("home"))
    monkeypatch.setenv("HOME", home)
    monkeypatch.setenv("USERPROFILE", home)
