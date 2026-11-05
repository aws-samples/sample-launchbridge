<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Dashboard Generation Guide

Generates a self-contained offline HTML dashboard from operational metrics run data. Uses interactive Plotly.js charts. No server, no build step — just open the file in a browser.

**Scope:** This dashboard covers operational metrics only (cost, latency, AWS service costs, scaling projections, trends). Prediction and evaluation data are not included — this may be expanded later when dashboarding is promoted to a standalone skill.

## CRITICAL: Context Overflow Prevention

The run data files (CSVs, JSONLs) can be very large. You MUST NOT read full file contents into your context.

**Rules:**

- For CSVs: read only the header row and the first 3–5 data rows (`head -5 <file>`) to understand the schema.
- For JSONL files: read only the first 2–3 lines (`head -3 <file>`) to understand the entry structure.
- NEVER `cat` an entire CSV or JSONL file. If you need row counts, use `wc -l`.
- The Python dashboard script (not you) reads the full data at generation time. Your job is to understand the shape, then generate the script.

## Step 1: Discover Operational Metrics Run Data

Scan `.lb_workspace/operational_metrics/` for timestamped run folders:

```
.lb_workspace/operational_metrics/<YYYY-MM-DD_HHMMSS>/
  ├── cost_per_request.csv        # per-component cost breakdown
  ├── cost_projections.csv        # scaling projections
  ├── latency_breakdown.csv       # per-component latency
  ├── aws_service_costs.csv       # per-service AWS cost breakdown
  ├── assumptions.csv             # documented assumptions
  ├── delta_vs_previous.csv       # (if comparison ran) delta against previous run
  ├── run_comparison.csv          # (if 2+ runs) side-by-side comparison
  ├── trend_analysis.csv          # (if 3+ runs) trend data
  └── operational_metrics_report.md
```

For each run folder:

1. List the CSVs present.
2. For each CSV: read ONLY the header + first 3 rows to learn the column schema.
3. Record: file paths, column names, data types, row counts (`wc -l`).

If no run folders exist, there is nothing to dashboard — inform the user and stop.

## Step 2: Determine Dashboard Panels

Based on what CSVs were discovered, select which panels to include:

| Panel                              | CSV Source                          | Condition             |
| ---------------------------------- | ----------------------------------- | --------------------- |
| Cost breakdown (stacked bar)       | `cost_per_request.csv`              | Any run has this file |
| Latency breakdown (bar)            | `latency_breakdown.csv`             | Any run has this file |
| AWS service costs (horizontal bar) | `aws_service_costs.csv`             | Any run has this file |
| Cost trend (line)                  | `cost_per_request.csv` across runs  | 2+ runs exist         |
| Latency trend (line)               | `latency_breakdown.csv` across runs | 2+ runs exist         |
| Scaling projections (line)         | `cost_projections.csv`              | Any run has this file |

Each panel gets a dropdown or toggle so the user can select which metric/component/run to view.

## Step 3: Generate the Dashboard Script

Before writing anything, run the guard, and stop if it exits non-zero (tell the user to run `lb-setup`): it refuses a symbolic link anywhere under `.lb_workspace/`, which would make the dashboard write outside the repository.

```bash
python3 -I "<skills folder>/lb-setup/scripts/lb_guard.py" check "<project root>"
```

Then generate a Python script at `.lb_workspace/operational_metrics/generate_dashboard.py` using the template at `references/dashboard_template.py` as a starting point. Write it in this session every time, replacing any file already there: a `generate_dashboard.py` you didn't write in this session may have arrived with the repository, and Step 4 runs it with the user's credentials in the environment. Never run one you didn't write.

The script MUST:

1. Import only standard library + Plotly + Pandas.
2. Scan `.lb_workspace/operational_metrics/` for all timestamped run folders.
3. Read all discovered CSVs at runtime (the script reads full files — that's fine, it's Python not LLM context).
4. Build Plotly figures for each panel.
5. Write a single self-contained HTML file with:
   - Plotly.js inlined from the installed `plotly` package (`plotly_script_tag()` in `dashboard_template.py`), never loaded from a CDN; if the bundled `plotly.min.js` is missing, the dashboard is not written
   - All data embedded in the HTML (no external file references)
   - Dropdown controls for metric/run/component selection

Adapt the template based on what data actually exists. Remove panels for missing CSVs. Adjust column names to match the actual CSV schemas discovered in step 1.

**Do NOT hardcode file paths or column names from memory.** Use the schemas discovered in step 1 to parameterize the script.

## Step 4: Install Dependencies and Run

Build a fresh venv outside the repository: nothing may install into
`.venv_lb`, which lb-setup seals, and a venv kept inside the repository could be
one that arrived with it. It is built with `uv` (lb-setup asks the user to
install it) on Python 3.12, the version the constraints are frozen for; the
system `python3` can be older. Install with the frozen constraints, so pandas and
every transitive dependency resolve to the versions `.venv_lb` uses: first run
`python3 -I "<skills folder>/lb-setup/scripts/venv_identity.py" deps "<project root>"`
and stop if it fails. The block reports the first step that failed and removes
the temporary folder either way:

```bash
(
    tmp="$(mktemp -d)" || exit 1
    uv venv --no-config --seed --python 3.12 "$tmp/venv" &&
        "$tmp/venv/bin/python" -I -m pip install --no-cache-dir "plotly==7.1.0" "pandas==3.0.6" \
            -c .lb_workspace/config/python_deps/constraints.txt &&
        "$tmp/venv/bin/python" -I .lb_workspace/operational_metrics/generate_dashboard.py
    status=$?
    rm -rf "${tmp:?}"
    exit "$status"
)
```

On Windows (PowerShell):

```powershell
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
try {
    uv venv --no-config --seed --python 3.12 "$tmp\venv"
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed" }
    & "$tmp\venv\Scripts\python.exe" -I -m pip install --no-cache-dir "plotly==7.1.0" "pandas==3.0.6" -c .lb_workspace\config\python_deps\constraints.txt
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
    & "$tmp\venv\Scripts\python.exe" -I .lb_workspace\operational_metrics\generate_dashboard.py
    if ($LASTEXITCODE -ne 0) { throw "dashboard generation failed" }
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
```

Each run downloads plotly and pandas again (about 20 seconds, and it needs network access): the venv is not kept.

## Step 5: Output

The script produces:

```
.lb_workspace/operational_metrics/
  ├── generate_dashboard.py           # the generation script (rerunnable)
  ├── operational_metrics_dashboard.html  # the self-contained dashboard
  └── <YYYY-MM-DD_HHMMSS>/           # individual run folders (unchanged)
```

The dashboard and generation script live at the top level of `.lb_workspace/operational_metrics/`, alongside the timestamped run folders. This keeps everything in one place.

Inform the user:

> Dashboard generated at `.lb_workspace/operational_metrics/operational_metrics_dashboard.html`. Open it in any browser — no server needed. To regenerate after new runs, run Steps 3 and 4 again (the script needs plotly and pandas, which a plain `python` doesn't have).

## Dashboard Layout Spec

### Header

- Title: "Operational Metrics Dashboard"
- Generated timestamp
- Summary: number of operational metrics runs found

### Section 1: Cost Analysis

- **Cost breakdown** — stacked bar chart, one bar per run, segments per component. Dropdown to switch between per-request and scaled projections.
- **AWS service costs** — horizontal bar chart showing per-service cost breakdown. Dropdown to pick which run to display.
- **Cost trend** (if 2+ runs) — line chart showing total per-request cost across runs. X-axis is run timestamp.

### Section 2: Latency Analysis

- **Latency breakdown** — bar chart, one bar per run, segments per component.
- **Latency trend** (if 2+ runs) — line chart showing total per-request latency across runs.

### Section 3: Token Usage (if 2+ runs)

- **Token trend** — line chart with lines for input tokens, output tokens, cache read tokens across runs.

### Section 4: Scaling Projections

- **Scaling chart** — line chart showing cost at different session scales. Dropdown to pick which run's projections to display.

### Interactivity

- All charts use Plotly's built-in hover tooltips.
- Dropdowns use Plotly `updatemenus` (no custom JavaScript needed).
- Charts are responsive (resize with browser window).

## Key Rules

1. **Never read full data files into LLM context** — head/schema only. The Python script reads the data.
2. **Offline-only** — the HTML must work without internet. Inline Plotly.js.
3. **Rerunnable** — the generation script should work on any future state of `.lb_workspace/operational_metrics/`. New runs automatically appear on next generation.
4. **No hardcoded schemas** — the script should discover column names from CSV headers at runtime.
5. **Graceful degradation** — if a CSV is missing or empty, skip that panel. Don't crash.
6. **Standard library + Plotly + Pandas only** — no other dependencies.
7. **Operational metrics only** — do not scan prediction or evaluation folders. Those will be added when dashboarding is promoted to a standalone skill.
8. **Human-readable timestamps** — folder names use `YYYY-MM-DD_HHMMSS` format but all chart axes, labels, dropdowns, and hover tooltips must display timestamps as `YYYY-MM-DD HH:MM:SS`. Convert at discovery time, not in each chart builder.
9. **Chronological ordering** — runs must be sorted by timestamp (oldest to newest) in all charts. The x-axis on trend/line charts and the bar ordering on bar charts must reflect chronological order. Sort by the raw folder name (lexicographic sort on `YYYY-MM-DD_HHMMSS` is correct) at discovery time.
10. **Surface metadata** — extract and display available metadata (model IDs, agent names, etc.) from the run CSVs. Look for `model`, `model_id`, or `agent` columns in `cost_per_request.csv`. Display this in the dashboard header or as a run summary table showing: timestamp, models used, total cost, total latency. Also include metadata in chart hover tooltips where relevant (e.g., hovering over a run's bar shows which models were used in that run).
