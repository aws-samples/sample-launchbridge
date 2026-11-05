# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The codebase path is written into inq_config.yaml as data, whatever it contains."""

import shutil
import subprocess  # nosec B404 - fixed argv, shell=False
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "indexing-and-qa"
    / "scripts"
    / "inq_config_setup.sh"
)


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash missing")
def test_a_hostile_path_cannot_add_config_keys(tmp_path):
    codebase = tmp_path / 'a"b|c\\d\nweb_search: true'
    codebase.mkdir()

    result = subprocess.run(  # nosec B603 B607 - fixed argv, shell=False
        ["bash", str(SCRIPT), str(codebase)], capture_output=True, text=True
    )

    assert result.returncode == 0, result.stderr
    config = codebase / ".lb_workspace" / "indexing_and_qa" / "inq_config.yaml"
    data = yaml.safe_load(config.read_text(encoding="utf-8"))
    assert data["codebase_dir"] == str(codebase)
    assert data["web_search"] is False
