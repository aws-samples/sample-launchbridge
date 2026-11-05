# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Minimal integration test to verify the metric_library submodule is importable."""


def test_metric_library_import():
    """Verify metric_library can be imported from the submodule."""
    from metric_library.core.registry import MetricRegistry
    import metric_library.metrics  # noqa: F401

    assert len(MetricRegistry.metrics) >= 33


def test_basic_metric_computation():
    """Verify a basic metric can be computed end-to-end."""
    from metric_library.core.registry import MetricRegistry
    from metric_library.core.data.text_data import TextData
    import metric_library.metrics  # noqa: F401

    preds = [TextData("A"), TextData("B"), TextData("C")]
    refs = [TextData("A"), TextData("B"), TextData("D")]
    result = MetricRegistry.compute_metric("Accuracy", preds, refs)
    assert 0.0 < result.score <= 1.0
