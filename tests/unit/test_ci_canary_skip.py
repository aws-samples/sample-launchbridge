# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""CI canary: pytest passes, but the module skips for a missing import.

tests/check_required_skips.py should fail the python-tests job on it.
"""

import pytest

pytest.importorskip("ci_canary_module_that_does_not_exist")


def test_never_runs():
    assert True
