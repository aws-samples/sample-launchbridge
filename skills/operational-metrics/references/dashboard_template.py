# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Operational Metrics Dashboard Generator

Scans .lb_workspace/operational_metrics/ for timestamped run data,
then produces a single self-contained HTML dashboard with interactive
Plotly charts.

Usage:
    python generate_dashboard.py [--workspace-root <path>] [--output <path>]

Defaults:
    --workspace-root .
    --output .lb_workspace/operational_metrics/operational_metrics_dashboard.html

Scope: Operational metrics only (cost, latency, AWS service costs,
scaling projections, trends). Prediction and evaluation data are not
included — this may be expanded later.
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

try:
    import pandas as pd
    import plotly.graph_objects as go
    import plotly.offline as pyo
except ImportError:
    print(
        'Missing dependencies. Install with: pip install "plotly==7.1.0" "pandas==3.0.6"'
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _format_timestamp(raw: str) -> str:
    """Convert folder timestamp (YYYY-MM-DD_HHMMSS) to human-readable (YYYY-MM-DD HH:MM:SS)."""
    # e.g. "2026-04-03_110757" -> "2026-04-03 11:07:57"
    try:
        date_part, time_part = raw.split("_", 1)
        if len(time_part) == 6 and time_part.isdigit():
            return f"{date_part} {time_part[:2]}:{time_part[2:4]}:{time_part[4:6]}"
    except (ValueError, IndexError):
        pass
    return raw


def discover_opmetrics_runs(workspace: Path) -> list[dict]:
    """Find all operational metrics run directories and read their CSVs."""
    om_dir = workspace / ".lb_workspace" / "operational_metrics"
    runs = []
    if not om_dir.exists():
        return runs
    for run_dir in sorted(om_dir.iterdir()):
        if not run_dir.is_dir():
            continue
        # Skip non-timestamped dirs
        if run_dir.name.startswith("."):
            continue
        run_data = {
            "timestamp": _format_timestamp(run_dir.name),
            "_raw_timestamp": run_dir.name,
            "_run_dir": str(run_dir),
        }
        for csv_name in [
            "cost_per_request.csv",
            "cost_projections.csv",
            "latency_breakdown.csv",
            "aws_service_costs.csv",
            "assumptions.csv",
            "delta_vs_previous.csv",
            "run_comparison.csv",
            "trend_analysis.csv",
        ]:
            csv_path = run_dir / csv_name
            if csv_path.exists():
                try:
                    run_data[csv_name] = pd.read_csv(csv_path)
                except (OSError, ValueError, pd.errors.ParserError):
                    # Skip files that cannot be read or parsed; the dashboard
                    # will simply omit charts for missing data.
                    continue
        runs.append(run_data)
    return runs


# ---------------------------------------------------------------------------
# Chart builders
# ---------------------------------------------------------------------------


def build_cost_chart(runs: list[dict]) -> go.Figure | None:
    """Stacked bar chart of per-request cost across runs."""
    frames = []
    for run in runs:
        df = run.get("cost_per_request.csv")
        if df is not None and "cost_usd" in df.columns:
            df = df.copy()
            df["run"] = run["timestamp"]
            frames.append(df)
    if not frames:
        return None

    combined = pd.concat(frames, ignore_index=True)
    agent_col = "agent" if "agent" in combined.columns else combined.columns[0]

    fig = go.Figure()
    for agent in combined[agent_col].unique():
        subset = combined[combined[agent_col] == agent]
        fig.add_trace(go.Bar(name=str(agent), x=subset["run"], y=subset["cost_usd"]))
    fig.update_layout(
        barmode="stack",
        title="Per-Request Cost by Component",
        xaxis_title="Run",
        yaxis_title="Cost (USD)",
        legend_title="Component",
    )
    return fig


def build_latency_chart(runs: list[dict]) -> go.Figure | None:
    """Stacked bar chart of per-request latency across runs."""
    frames = []
    for run in runs:
        df = run.get("latency_breakdown.csv")
        if df is not None and "latency_ms" in df.columns:
            df = df.copy()
            df["run"] = run["timestamp"]
            frames.append(df)
    if not frames:
        return None

    combined = pd.concat(frames, ignore_index=True)
    agent_col = "agent" if "agent" in combined.columns else combined.columns[0]

    fig = go.Figure()
    for agent in combined[agent_col].unique():
        subset = combined[combined[agent_col] == agent]
        fig.add_trace(go.Bar(name=str(agent), x=subset["run"], y=subset["latency_ms"]))
    fig.update_layout(
        barmode="stack",
        title="Per-Request Latency by Component",
        xaxis_title="Run",
        yaxis_title="Latency (ms)",
        legend_title="Component",
    )
    return fig


def build_aws_service_costs_chart(runs: list[dict]) -> go.Figure | None:
    """Horizontal bar chart of per-service AWS cost breakdown with run dropdown."""
    figures_data = []
    for run in runs:
        df = run.get("aws_service_costs.csv")
        if df is not None and len(df) > 0:
            figures_data.append((run["timestamp"], df))
    if not figures_data:
        return None

    sample_df = figures_data[0][1]
    service_col = "service" if "service" in sample_df.columns else sample_df.columns[0]
    cost_col = None
    for candidate in ["cost_per_request_usd", "cost_per_session_usd", "cost_usd"]:
        if candidate in sample_df.columns:
            cost_col = candidate
            break
    if cost_col is None:
        for col in sample_df.columns:
            if sample_df[col].dtype in ("float64", "int64"):
                cost_col = col
                break
    if cost_col is None:
        return None

    fig = go.Figure()
    buttons = []
    for i, (ts, df) in enumerate(figures_data):
        fig.add_trace(
            go.Bar(
                y=df[service_col],
                x=df[cost_col],
                name=ts,
                orientation="h",
                visible=(i == 0),
            )
        )
        vis = [False] * len(figures_data)
        vis[i] = True
        buttons.append(dict(label=ts, method="update", args=[{"visible": vis}]))

    fig.update_layout(
        title="AWS Service Costs per Request",
        xaxis_title="Cost (USD)",
        yaxis_title="Service",
        updatemenus=[
            dict(
                type="dropdown",
                direction="down",
                x=0.0,
                xanchor="left",
                y=1.15,
                yanchor="top",
                buttons=buttons,
            )
        ]
        if len(figures_data) > 1
        else [],
    )
    return fig


def build_trend_chart(runs: list[dict]) -> go.Figure | None:
    """Line chart of key metrics across runs (cost, latency, tokens)."""
    if len(runs) < 2:
        return None

    timestamps, costs, latencies, in_tokens, out_tokens = [], [], [], [], []
    for run in runs:
        df = run.get("cost_per_request.csv")
        if df is None:
            continue
        timestamps.append(run["timestamp"])
        costs.append(df["cost_usd"].sum() if "cost_usd" in df.columns else 0)
        latencies.append(df["latency_ms"].sum() if "latency_ms" in df.columns else 0)
        in_tokens.append(
            df["input_tokens"].sum() if "input_tokens" in df.columns else 0
        )
        out_tokens.append(
            df["output_tokens"].sum() if "output_tokens" in df.columns else 0
        )

    if not timestamps:
        return None

    fig = go.Figure()
    fig.add_trace(
        go.Scatter(x=timestamps, y=costs, name="Total Cost (USD)", mode="lines+markers")
    )
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=latencies,
            name="Total Latency (ms)",
            mode="lines+markers",
            visible=False,
        )
    )
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=in_tokens,
            name="Input Tokens",
            mode="lines+markers",
            visible=False,
        )
    )
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=out_tokens,
            name="Output Tokens",
            mode="lines+markers",
            visible=False,
        )
    )

    buttons = [
        dict(
            label="Cost (USD)",
            method="update",
            args=[
                {"visible": [True, False, False, False]},
                {"yaxis": {"title": "Cost (USD)"}},
            ],
        ),
        dict(
            label="Latency (ms)",
            method="update",
            args=[
                {"visible": [False, True, False, False]},
                {"yaxis": {"title": "Latency (ms)"}},
            ],
        ),
        dict(
            label="Input Tokens",
            method="update",
            args=[
                {"visible": [False, False, True, False]},
                {"yaxis": {"title": "Input Tokens"}},
            ],
        ),
        dict(
            label="Output Tokens",
            method="update",
            args=[
                {"visible": [False, False, False, True]},
                {"yaxis": {"title": "Output Tokens"}},
            ],
        ),
    ]
    fig.update_layout(
        title="Operational Metrics Trend",
        xaxis_title="Run",
        yaxis_title="Cost (USD)",
        updatemenus=[
            dict(
                type="dropdown",
                direction="down",
                x=0.0,
                xanchor="left",
                y=1.15,
                yanchor="top",
                buttons=buttons,
            )
        ],
    )
    return fig


def build_scaling_chart(runs: list[dict]) -> go.Figure | None:
    """Line chart of cost projections at different session scales."""
    figures_data = []
    for run in runs:
        df = run.get("cost_projections.csv")
        if df is not None and "sessions" in df.columns and "est_cost_usd" in df.columns:
            figures_data.append((run["timestamp"], df))
    if not figures_data:
        return None

    fig = go.Figure()
    buttons = []
    for i, (ts, df) in enumerate(figures_data):
        fig.add_trace(
            go.Scatter(
                x=df["sessions"],
                y=df["est_cost_usd"],
                name=ts,
                mode="lines+markers",
                visible=(i == 0),
            )
        )
        vis = [False] * len(figures_data)
        vis[i] = True
        buttons.append(dict(label=ts, method="update", args=[{"visible": vis}]))

    fig.update_layout(
        title="Scaling Projections",
        xaxis_title="Sessions",
        yaxis_title="Estimated Cost (USD)",
        xaxis_type="log",
        updatemenus=[
            dict(
                type="dropdown",
                direction="down",
                x=0.0,
                xanchor="left",
                y=1.15,
                yanchor="top",
                buttons=buttons,
            )
        ],
    )
    return fig


# ---------------------------------------------------------------------------
# HTML assembly
# ---------------------------------------------------------------------------

DASHBOARD_CSS = """
<style>
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        margin: 0; padding: 20px; background: #f5f6fa; color: #2d3436;
    }
    .header {
        background: #2d3436; color: #fff; padding: 24px 32px;
        border-radius: 8px; margin-bottom: 24px;
    }
    .header h1 { margin: 0 0 8px 0; font-size: 24px; }
    .header p { margin: 0; opacity: 0.8; font-size: 14px; }
    .section { background: #fff; padding: 24px; border-radius: 8px; margin-bottom: 16px; }
    .section h2 { margin: 0 0 16px 0; font-size: 18px; }
    .chart-container { margin: 16px 0; }
    .footer { text-align: center; padding: 16px; font-size: 12px; opacity: 0.6; }
</style>
"""


def plotly_script_tag(package_dir: Path | None = None) -> str:
    """The plotly.js bundled with the installed plotly package, as an inline script.

    The report must not load script from a CDN: it holds cost data and is meant to
    be self-contained. The file ships inside every plotly install, so a missing one
    means a broken installation, and the dashboard is not written.
    """
    if package_dir is None:
        import plotly

        package_dir = Path(plotly.__file__).parent
    js_path = package_dir / "package_data" / "plotly.min.js"
    if not js_path.is_file():
        raise RuntimeError(
            f"plotly.min.js not found at {js_path}; reinstall plotly "
            '(pip install "plotly==7.1.0").'
        )
    return f"<script>{js_path.read_text(encoding='utf-8')}</script>"


def assemble_dashboard(runs: list[dict], output_path: Path) -> None:
    """Build the operational metrics HTML dashboard and write to output_path."""

    sections = []

    # --- Cost Analysis ---
    cost_panels = []
    cost_fig = build_cost_chart(runs)
    if cost_fig:
        cost_panels.append(
            pyo.plot(cost_fig, output_type="div", include_plotlyjs=False)
        )
    aws_fig = build_aws_service_costs_chart(runs)
    if aws_fig:
        cost_panels.append(pyo.plot(aws_fig, output_type="div", include_plotlyjs=False))
    if cost_panels:
        content = "\n".join(
            f'<div class="chart-container">{p}</div>' for p in cost_panels
        )
        sections.append(f'<div class="section"><h2>Cost Analysis</h2>{content}</div>')

    # --- Latency Analysis ---
    latency_fig = build_latency_chart(runs)
    if latency_fig:
        div = pyo.plot(latency_fig, output_type="div", include_plotlyjs=False)
        sections.append(
            f'<div class="section"><h2>Latency Analysis</h2><div class="chart-container">{div}</div></div>'
        )

    # --- Trends (cost, latency, tokens) ---
    trend_fig = build_trend_chart(runs)
    if trend_fig:
        div = pyo.plot(trend_fig, output_type="div", include_plotlyjs=False)
        sections.append(
            f'<div class="section"><h2>Trends</h2><div class="chart-container">{div}</div></div>'
        )

    # --- Scaling Projections ---
    scaling_fig = build_scaling_chart(runs)
    if scaling_fig:
        div = pyo.plot(scaling_fig, output_type="div", include_plotlyjs=False)
        sections.append(
            f'<div class="section"><h2>Scaling Projections</h2><div class="chart-container">{div}</div></div>'
        )

    if not sections:
        print("No chart data found. Dashboard not generated.")
        return

    # --- Plotly.js inline (never from a CDN) ---
    try:
        plotly_script = plotly_script_tag()
    except RuntimeError as err:
        print(f"Dashboard not generated: {err}")
        return

    summary = f"{len(runs)} operational metrics run(s)"
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Operational Metrics Dashboard</title>
    {DASHBOARD_CSS}
    {plotly_script}
</head>
<body>
    <div class="header">
        <h1>Operational Metrics Dashboard</h1>
        <p>{summary} &mdash; Generated {datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")}</p>
    </div>
    {"".join(sections)}
    <div class="footer">
        Generated by operational-metrics skill &mdash; open in any browser, no server needed.
    </div>
</body>
</html>"""

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.is_symlink():
        # A link that arrived with the repository would send the dashboard
        # somewhere else.
        raise SystemExit(f"Refusing to write through the symbolic link {output_path}")
    output_path.write_text(html, encoding="utf-8")
    print(f"Dashboard written to {output_path}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Generate Operational Metrics Dashboard"
    )
    parser.add_argument("--workspace-root", default=".", help="Path to workspace root")
    parser.add_argument("--output", default=None, help="Output HTML path")
    args = parser.parse_args()

    workspace = Path(args.workspace_root).resolve()
    output = (
        Path(args.output)
        if args.output
        else workspace
        / ".lb_workspace"
        / "operational_metrics"
        / "operational_metrics_dashboard.html"
    )

    print("Discovering operational metrics run data...")
    runs = discover_opmetrics_runs(workspace)

    if not runs:
        print(
            "No operational metrics runs found in .lb_workspace/operational_metrics/. Nothing to dashboard."
        )
        sys.exit(0)

    print(f"Found {len(runs)} operational metrics run(s).")
    assemble_dashboard(runs, output)


if __name__ == "__main__":
    main()
