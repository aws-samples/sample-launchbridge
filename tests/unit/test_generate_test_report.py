# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Docstrings from the target repository render as plain text in TEST_REPORT.md."""

import importlib.util
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "testing-framework"
    / "scripts"
    / "generate_test_report.py"
)
spec = importlib.util.spec_from_file_location("generate_test_report", SCRIPT)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def test_html_links_images_and_code_are_inert():
    text = report.md_text("a|b <img src=x> [x](http://e) ![i](y) `c` **d**")
    assert "<" not in text and ">" not in text
    assert "](" not in text.replace("\\](", "")
    assert "\\|" in text and "\\`" in text and "\\*\\*" in text


def test_a_backtick_cannot_close_a_code_span():
    assert report.md_code("a`b.py") == "`a'b.py`"
