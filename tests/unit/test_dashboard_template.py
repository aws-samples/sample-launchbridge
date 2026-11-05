# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The operational-metrics dashboard inlines plotly.js and never loads it from a CDN."""

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("plotly")
pytest.importorskip("pandas")

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "operational-metrics"
    / "references"
    / "dashboard_template.py"
)
spec = importlib.util.spec_from_file_location("dashboard_template", SCRIPT)
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


def test_the_bundled_script_is_inlined(tmp_path):
    (tmp_path / "package_data").mkdir()
    (tmp_path / "package_data" / "plotly.min.js").write_text("/*plotly*/", "utf-8")
    assert dashboard.plotly_script_tag(tmp_path) == "<script>/*plotly*/</script>"


def test_a_missing_bundle_fails_instead_of_using_a_cdn(tmp_path):
    with pytest.raises(RuntimeError, match="reinstall plotly"):
        dashboard.plotly_script_tag(tmp_path)


def test_no_cdn_url_remains_in_the_template():
    assert "cdn.plot.ly" not in SCRIPT.read_text(encoding="utf-8")
