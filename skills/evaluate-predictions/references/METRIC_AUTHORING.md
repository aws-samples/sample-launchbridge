<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Custom Metric Authoring Guide

This document defines the contract for writing custom metrics that integrate with the metric library's registry and evaluation pipeline.

## When to Create a Custom Metric

Create a custom metric when the task requires evaluation criteria that the built-in library doesn't cover. Examples:

- **Domain-specific validation** — checking that medical codes follow ICD-10 format, or that generated SQL is syntactically valid
- **Structural conformance** — verifying that output JSON matches an expected schema, or that extracted entities appear in the correct order
- **Composite scoring** — combining multiple signals (e.g., partial credit for multi-part answers where each part contributes to the score)
- **Business logic alignment** — measuring whether recommendations satisfy domain constraints (e.g., budget limits, regulatory requirements)

Do not create a custom metric if a built-in metric already covers the need. Run the list command in SKILL.md A1 first to check what's available.

## File Location

Custom metrics are defined in `.lb_workspace/evaluations/custom_metrics.py`. This single file accumulates custom metrics across evaluation runs. The evaluation runner (`run_metrics.py`) loads it with `--custom-metrics-path` (see SKILL.md A1) — any classes decorated with `@MetricRegistry.register` are discovered at runtime.

Keep the file self-contained: it can import the metric library and installed packages, but not other modules placed next to it, because the commands run with only the metric library on `PYTHONPATH` (so nothing from the repository can replace a library module). Put helper functions in `custom_metrics.py` itself.

Without that option the runner registers only the built-in metrics. When you first need custom metrics, create `.lb_workspace/evaluations/custom_metrics.py` and add your classes.

## Versioning

Do not modify existing custom metric classes — their logic may have been used in previous evaluation runs and changing them would make those results non-reproducible. If the evaluation logic needs to change, create a new class with a version suffix (e.g., `SchemaValidity_v2`). Existing classes may only be changed for bug fixes or non-functional edits (comments, formatting).

A class written for the earlier library interface, `compute(self, predictions, references, *args)` returning one score for the whole dataset, still imports and validates but fails at its first sample, typically with `'EvaluationSample' object is not iterable`. Port it to a new versioned class with the per-sample `compute` described below; its scores can differ from the old ones, and LLM scores are not comparable across this change either. Renaming an LLM metric's `get_evaluation_prompt()` to `rubric()` is a non-functional edit.

## Contract

Every custom metric must:

1. **Inherit from `Metric`** (or `LLMMetric` for LLM-as-judge metrics)
2. **Decorate with `@MetricRegistry.register`**
3. **Implement `compute(self, sample, client) -> float`**, which scores one sample (an `LLMMetric` implements `rubric()` instead, see below)
4. **Set `supported_data_types`** to the list of modalities the metric handles; the engine rejects an input of any other modality before scoring
5. **Declare the inputs it reads** with `InputPolicy` (from `metric_library.core.input_policy`): `reference_policy` defaults to `REQUIRED`, and `prompt_policy` and `context_policy` default to `OMIT`, which drops prompts and context before `compute`. Set `reference_policy = InputPolicy.OMIT` for a reference-free metric, and `OPTIONAL` or `REQUIRED` for each other input the metric reads.
6. **Use a unique name**: the class name, normalized to lowercase letters and digits, must not match a built-in metric or another custom class. The runner registers custom metrics before the built-ins, so a built-in with the same normalized name replaces yours with only a warning on stderr (yours wins instead when the file imports the built-in metrics, for example to subclass one).

```python
from metric_library.core.base import Metric
from metric_library.core.registry import MetricRegistry
from metric_library.core.data import Modality


@MetricRegistry.register
class MetricName(Metric):
    """One-line description of what this metric measures."""

    supported_data_types = [Modality.TEXT]

    def compute(self, sample, client) -> float:
        # Score one sample; the engine aggregates the per-sample scores
        return score
```

### The `compute` Method

The engine calls `compute` once per sample (once per candidate pair of items with the `labels` or `list` matcher) and aggregates the returned scores (their mean by default).

**Parameters:**

| Parameter | Type               | Description                                                                                                                                                                                                                |
| --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sample`  | `EvaluationSample` | One record: `sample.prediction`, `sample.reference` and `sample.prompt` hold one `DataType` each (`None` when the role is not supplied or the metric omits it); `sample.contexts` is a tuple of the record's context items |
| `client`  | `BedrockClient`    | Judge client shared by the samples of one metric; a deterministic metric ignores it                                                                                                                                        |

A record field that holds a non-empty JSON array of scalars (for example, a list of extracted entities) arrives as several items in that role. A `Metric` accepts one item per role unless it declares `prediction_multiplicity` / `reference_multiplicity` and reads the tuples `sample.predictions` / `sample.references`; an `LLMMetric` reads several items as one composite answer by default. When a prompt field holds an array, read the tuple `sample.prompts`, since `sample.prompt` raises (see "Creating Custom Metrics" in `$SKILL_DIR/lib/metric-library/README.md`).

**Accessing raw data:**

- `sample.prediction.get_raw_data()` returns the value as loaded from JSON: for text, a `str`, number, `bool`, `None`, or a `dict` or `list` (an object, an empty array, or an array that holds objects stays one item); for image and video, the file's bytes; for audio, the decoded samples. Text read from a file, such as a prompt file, is the file's content.
- `sample.prediction.get_data()` returns the same value for text from a record, a NumPy array of the words for text read from a file, and the decoded NumPy array for media.
- Coerce with `str(...)` before string operations, and check `isinstance(value, (dict, list))` before parsing JSON.

**Return value:** A finite number for the sample (`int`, `float` or a NumPy float; not `bool`, `None`, NaN or infinity), or `SampleOutput(score, details)` from `metric_library.core.aggregation` to keep per-sample details; of the details, only `reasoning` and `item_scores` reach `data.samples`. For metrics where higher is better (accuracy, F1), return values in `[0.0, 1.0]`; for error metrics (MAE, MSE), return the raw error value. With the `labels` or `list` matcher, the score must be from 0.0 to 1.0. Any other value, or an exception in `compute`, fails that sample and stops the metric: the later samples are skipped and the metric reports `{"error": "sample <id>: ..."}`. To score a value that cannot be parsed instead of failing the metric, return a score for it, such as 0.0.

### Modalities

Set `supported_data_types` to declare what data types your metric handles. Numbers, booleans, `null` and JSON objects load as `Modality.TEXT`. `Metric` defaults to all four modalities and `LLMMetric` to text and image; do not add audio to an `LLMMetric`, since the judge cannot read it:

```python
from metric_library.core.data import Modality

# Available modalities:
# Modality.TEXT, Modality.IMAGE, Modality.AUDIO, Modality.VIDEO
supported_data_types = [Modality.TEXT]  # text only
supported_data_types = [Modality.TEXT, Modality.IMAGE]  # text and image
```

## Example: Structural Validation Metric

A metric that checks whether generated output contains all required sections:

```python
import re
from metric_library.core.base import Metric
from metric_library.core.registry import MetricRegistry
from metric_library.core.data import Modality
from metric_library.core.input_policy import InputPolicy


@MetricRegistry.register
class SectionCompleteness(Metric):
    """Measures whether generated reports contain all required sections."""

    supported_data_types = [Modality.TEXT]
    reference_policy = InputPolicy.OMIT  # reads only the prediction

    REQUIRED_SECTIONS = ["summary", "findings", "recommendations"]

    def compute(self, sample, client) -> float:
        text = str(sample.prediction.get_data()).lower()
        found = sum(
            1 for section in self.REQUIRED_SECTIONS
            if re.search(rf"\b{section}\b", text)
        )
        return found / len(self.REQUIRED_SECTIONS)
```

## Example: LLM-as-Judge Custom Metric

For evaluation criteria that require language understanding, inherit from `LLMMetric` instead. You only need to implement `rubric()`, which returns the evaluation criteria. An `LLMMetric` requires ground truth and reads the prompt and context when they are supplied; set `reference_policy = InputPolicy.OMIT` for a reference-free judge:

```python
from metric_library.core.llm_metric import LLMMetric
from metric_library.core.registry import MetricRegistry
from metric_library.core.data import Modality


@MetricRegistry.register
class DomainTerminologyAccuracy(LLMMetric):
    """Measures whether the response uses domain terminology correctly."""

    supported_data_types = [Modality.TEXT]

    def rubric(self) -> str:
        return (
            "Evaluate whether the candidate response uses domain-specific "
            "terminology correctly compared to the ground truth. Score 1.0 "
            "if all technical terms are used accurately, 0.0 if terminology "
            "is consistently misused, and proportionally for partial accuracy."
        )
```

## Validating Custom Metrics

After adding or modifying custom metrics in `.lb_workspace/evaluations/custom_metrics.py`, always run `validate_metrics.py` before executing the evaluation pipeline. This script checks for Python syntax errors and runs the file's import statements, except optional ones (under `if TYPE_CHECKING:`, or in a `try` whose `except` goes on without the module), catching those issues before they surface as runtime failures in `run_metrics`. It does not run the class bodies, so a class that fails to load or register still passes; confirm registration with the list command in SKILL.md A5.

```bash
PYTHONSAFEPATH=1 PYTHONPATH="$SKILL_DIR/lib/metric-library" \
python3 -I "<skills folder>/lb-setup/scripts/lb_guard.py" exec "<project root>" -- "$SKILL_DIR/lib/metric-library/metric_library/validate_metrics.py" \
  .lb_workspace/evaluations/custom_metrics.py
```

The script outputs JSON:

- **Pass:** `{"ok": true, "errors": []}` — syntax and imports are fine. Confirm registration, then run `metric_library.run_metrics`.
- **Fail:** `{"ok": false, "errors": ["..."]}` — fix the reported errors in `custom_metrics.py` and re-run validation until the output is `ok: true`. The error `The imports did not finish within 5 seconds` means an import was slow or hangs: re-run validation once, and if it fails again, report it to the user. Do not proceed to `run_metrics` until validation passes.

## Using Custom Metrics

After defining custom metrics in `.lb_workspace/evaluations/custom_metrics.py` and confirming they pass validation, include their class names in the `--metrics` argument when running evaluation:

```bash
PYTHONSAFEPATH=1 PYTHONPATH="$SKILL_DIR/lib/metric-library" \
python3 -I "<skills folder>/lb-setup/scripts/lb_guard.py" exec "<project root>" -- -m metric_library.run_metrics \
  --execution-output-path predictions.json \
  --metrics "Accuracy,SectionCompleteness,DomainTerminologyAccuracy" \
  --pred-key "output" \
  --ground-truth-key "expected" \
  --custom-metrics-path .lb_workspace/evaluations/custom_metrics.py \
  --omit-reasoning \
  --output-path "$EVAL_RUN_DIR/eval_results.json"
```

Results are read from that file and merged into `evaluation_manifest.json` by the agent (see SKILL.md A6 for the full command).

The class name (e.g., `SectionCompleteness`) is the metric name used in the `--metrics` list. Name normalization applies — `section_completeness`, `Section-Completeness`, and `SectionCompleteness` all resolve to the same metric.
