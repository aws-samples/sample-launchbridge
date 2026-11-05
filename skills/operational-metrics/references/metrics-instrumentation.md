<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Metrics Instrumentation Guide

How to extract token usage and latency from different GenAI frameworks. Each section shows how to log metrics to `metrics_log.jsonl` for cost/latency analysis.

## Common Log Format

All frameworks should log to the same JSONL format so the calculation scripts work uniformly.

All metrics logging MUST be gated behind the `ENABLE_METRICS_LOGGING` environment variable so instrumentation can stay in the codebase permanently without affecting normal operation:

```python
import json
import os

METRICS_ENABLED = os.environ.get("ENABLE_METRICS_LOGGING", "").lower() == "true"

def log_metrics(entry, output_file="metrics_log.jsonl"):
    if not METRICS_ENABLED:
        return
    with open(output_file, "a") as f:
        f.write(json.dumps(entry) + "\n")
```

When running, set the env var: `ENABLE_METRICS_LOGGING=true python <script>`

Each entry should contain:

```json
{
  "agent": "agent_name_or_step",
  "model": "model_id",
  "input_tokens": 1234,
  "output_tokens": 567,
  "cache_read_tokens": 0,
  "cache_write_tokens": 0,
  "latency_ms": 2340,
  "ttfb_ms": 450
}
```

---

## 1. Strands Agents SDK

> Source: [Strands Agents SDK documentation](https://github.com/strands-agents/sdk-python) — AgentResult metrics API, EventLoopMetrics class.

### Core API

Every `agent()` call returns an `AgentResult`. Metrics are on `result.metrics` (an `EventLoopMetrics` object).

**Key accessors:**

| Accessor                                 | Returns       | Description                                                          |
| ---------------------------------------- | ------------- | -------------------------------------------------------------------- |
| `result.metrics.accumulated_usage`       | `dict`        | Aggregated token usage across all cycles and invocations             |
| `result.metrics.accumulated_metrics`     | `dict`        | Aggregated performance metrics (latency)                             |
| `result.metrics.cycle_durations`         | `list[float]` | Wall-clock duration of each event loop cycle (seconds)               |
| `result.metrics.tool_metrics`            | `dict`        | Per-tool execution metrics                                           |
| `result.metrics.agent_invocations`       | `list`        | All invocations (for multi-turn conversations)                       |
| `result.metrics.latest_agent_invocation` | object        | Most recent invocation with `.usage` and `.cycles`                   |
| `result.metrics.get_summary()`           | `dict`        | Full summary dict with cycles, tool_usage, traces, accumulated_usage |

**Fields in `accumulated_usage`:**

| Field                   | Type | Description                                                          |
| ----------------------- | ---- | -------------------------------------------------------------------- |
| `inputTokens`           | int  | Total input tokens sent to the model                                 |
| `outputTokens`          | int  | Total output tokens generated                                        |
| `totalTokens`           | int  | Sum of input + output                                                |
| `cacheReadInputTokens`  | int  | Tokens read from prompt cache (present only when caching is active)  |
| `cacheWriteInputTokens` | int  | Tokens written to prompt cache (present only when caching is active) |

**Fields in `accumulated_metrics`:**

| Field       | Type | Description                         |
| ----------- | ---- | ----------------------------------- |
| `latencyMs` | int  | Total model latency in milliseconds |

### Single agent — basic usage

```python
from strands import Agent

agent = Agent(model="us.anthropic.claude-sonnet-4-5-20250929-v1:0", tools=[...])
result = agent("your query")

# Aggregated usage across all cycles
usage = result.metrics.accumulated_usage

log_metrics({
    "agent": "my_agent",
    "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "input_tokens": usage.get("inputTokens", 0),
    "output_tokens": usage.get("outputTokens", 0),
    "cache_read_tokens": usage.get("cacheReadInputTokens", 0),
    "cache_write_tokens": usage.get("cacheWriteInputTokens", 0),
    "latency_ms": result.metrics.accumulated_metrics.get("latencyMs", 0),
    "ttfb_ms": 0,
})

# Execution time from cycle durations
total_execution_secs = sum(result.metrics.cycle_durations)
print(f"Total execution: {total_execution_secs:.2f}s")

# Tool usage
print(f"Tools used: {list(result.metrics.tool_metrics.keys())}")
```

### Multi-turn conversations

When the same agent is called multiple times (conversation), each call is a separate invocation. Use `agent_invocations` to get per-invocation metrics, or `latest_agent_invocation` for just the last one:

```python
agent = Agent(model="us.anthropic.claude-sonnet-4-5-20250929-v1:0")

result1 = agent("What is 5 + 3?")
result2 = agent("What is the square root of 144?")

# Metrics for the latest invocation only
latest = result2.metrics.latest_agent_invocation
print(f"Latest invocation tokens: {latest.usage}")

# Metrics for ALL invocations (full conversation)
for invocation in result2.metrics.agent_invocations:
    print(f"Invocation usage: {invocation.usage}")
    for cycle in invocation.cycles:
        print(f"  Cycle {cycle.event_loop_cycle_id}: {cycle.usage}")

# Or use accumulated_usage for the grand total across all invocations
total_usage = result2.metrics.accumulated_usage
print(f"Total tokens across all invocations: {total_usage.get('totalTokens', 0)}")
```

**For cost analysis, log per-invocation metrics** so you can see cost progression across turns (later turns use more input tokens due to conversation history):

```python
for i, invocation in enumerate(result.metrics.agent_invocations):
    usage = invocation.usage
    log_metrics({
        "agent": f"my_agent_turn_{i}",
        "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "input_tokens": usage.get("inputTokens", 0),
        "output_tokens": usage.get("outputTokens", 0),
        "cache_read_tokens": usage.get("cacheReadInputTokens", 0),
        "cache_write_tokens": usage.get("cacheWriteInputTokens", 0),
        "latency_ms": 0,  # per-invocation latency not directly available; use cycle_durations
        "ttfb_ms": 0,
    })
```

### Multi-agent (agents-as-tools)

The orchestrator's `result.metrics` only covers its own model calls. Each sub-agent wrapped as a `@tool` returns its own `AgentResult`. Log metrics inside each tool function:

```python
from strands import Agent, tool

@tool
def research_assistant(query: str) -> str:
    """Research tool."""
    agent = Agent(model="us.anthropic.claude-sonnet-4-5-20250929-v1:0", system_prompt="...")
    result = agent(query)

    usage = result.metrics.accumulated_usage
    log_metrics({
        "agent": "research_assistant",
        "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "input_tokens": usage.get("inputTokens", 0),
        "output_tokens": usage.get("outputTokens", 0),
        "cache_read_tokens": usage.get("cacheReadInputTokens", 0),
        "cache_write_tokens": usage.get("cacheWriteInputTokens", 0),
        "latency_ms": result.metrics.accumulated_metrics.get("latencyMs", 0),
        "ttfb_ms": 0,
    })
    return str(result)

# After orchestrator call, log its metrics too
orchestrator = Agent(model="...", tools=[research_assistant])
result = orchestrator("query")

usage = result.metrics.accumulated_usage
log_metrics({
    "agent": "orchestrator",
    "model": "...",
    "input_tokens": usage.get("inputTokens", 0),
    "output_tokens": usage.get("outputTokens", 0),
    "cache_read_tokens": usage.get("cacheReadInputTokens", 0),
    "cache_write_tokens": usage.get("cacheWriteInputTokens", 0),
    "latency_ms": result.metrics.accumulated_metrics.get("latencyMs", 0),
    "ttfb_ms": 0,
})
```

### Multi-agent (Graph / Swarm patterns)

For Strands multi-agent patterns (Graph, Swarm), metrics are accumulated across all nodes:

```python
result = await graph.invoke_async("task")

# Total across all nodes
print(f"Total tokens: {result.accumulated_usage['totalTokens']}")
print(f"Execution time: {result.execution_time}ms")

# Per-node metrics
for node_id, node_result in result.results.items():
    usage = node_result.accumulated_usage
    log_metrics({
        "agent": f"graph_node_{node_id}",
        "model": "unknown",  # extract from node config if available
        "input_tokens": usage.get("inputTokens", 0),
        "output_tokens": usage.get("outputTokens", 0),
        "cache_read_tokens": usage.get("cacheReadInputTokens", 0),
        "cache_write_tokens": usage.get("cacheWriteInputTokens", 0),
        "latency_ms": 0,
        "ttfb_ms": 0,
    })
```

### Full summary (for debugging)

```python
from strands.telemetry.metrics import metrics_to_string

# Human-readable summary
print(metrics_to_string(result.metrics))

# Or as a dict
summary = result.metrics.get_summary()
# Returns: { cycles, tool_usage, traces, accumulated_usage, ... }
```

---

## 2. LangGraph / LangChain

> Source: [LangChain UsageMetadata](https://python.langchain.com/api_reference/core/messages/langchain_core.messages.ai.UsageMetadata.html) — standardized token usage on AIMessage objects.

LangChain exposes token usage through `usage_metadata` on `AIMessage` objects. This is a standardized representation consistent across model providers.

**Fields in `UsageMetadata`:**

| Field                 | Type | Description                                                                |
| --------------------- | ---- | -------------------------------------------------------------------------- |
| `input_tokens`        | int  | Count of input (prompt) tokens                                             |
| `output_tokens`       | int  | Count of output (completion) tokens                                        |
| `total_tokens`        | int  | Sum of input + output                                                      |
| `input_token_details` | dict | Breakdown including `cache_read` and `cache_creation` (provider-dependent) |

**Fields in `input_token_details` (when available):**

| Field            | Type | Description                    |
| ---------------- | ---- | ------------------------------ |
| `cache_read`     | int  | Tokens read from prompt cache  |
| `cache_creation` | int  | Tokens written to prompt cache |

### Option A: Stream mode (preferred for LangGraph)

When streaming with `stream_mode="messages"`, each event is an `AIMessage` or `AIMessageChunk` with `usage_metadata`:

```python
import json, time

for event, metadata in graph.stream(
    {"messages": [("user", "your query")]},
    stream_mode="messages",
):
    if hasattr(event, "usage_metadata") and event.usage_metadata:
        um = event.usage_metadata
        details = um.get("input_token_details", {}) or {}
        log_metrics({
            "agent": metadata.get("langgraph_node", "unknown"),
            "model": event.response_metadata.get("model_id", "unknown"),
            "input_tokens": um.get("input_tokens", 0),
            "output_tokens": um.get("output_tokens", 0),
            "cache_read_tokens": details.get("cache_read", 0),
            "cache_write_tokens": details.get("cache_creation", 0),
            "latency_ms": 0,  # measure wall time separately (see below)
            "ttfb_ms": 0,
        })
```

**Measuring latency with stream mode:** Wrap the stream in a timer:

```python
import time

start = time.time()
for event, metadata in graph.stream(..., stream_mode="messages"):
    if ttfb_ms == 0:
        ttfb_ms = round((time.time() - start) * 1000)
    # ... process events
total_ms = round((time.time() - start) * 1000)
```

### Option B: Callback handler (works for LangChain and LangGraph)

A callback handler captures metrics from every LLM call, including latency:

```python
from langchain_core.callbacks import BaseCallbackHandler
import json, time

class MetricsLogger(BaseCallbackHandler):
    def __init__(self, output_file="metrics_log.jsonl"):
        self.output_file = output_file
        self._start_times = {}

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        self._start_times[run_id] = time.time()

    def on_llm_end(self, response, *, run_id, **kwargs):
        elapsed_ms = (time.time() - self._start_times.pop(run_id, time.time())) * 1000

        usage = {}

        # Check usage_metadata on the generation (preferred — standardized)
        for gen_list in response.generations:
            for gen in gen_list:
                if hasattr(gen, "message") and hasattr(gen.message, "usage_metadata"):
                    um = gen.message.usage_metadata
                    if um:
                        details = um.get("input_token_details", {}) or {}
                        usage = {
                            "input_tokens": um.get("input_tokens", 0),
                            "output_tokens": um.get("output_tokens", 0),
                            "cache_read": details.get("cache_read", 0),
                            "cache_creation": details.get("cache_creation", 0),
                        }

        # Fallback: check llm_output for older providers
        if not usage and response.llm_output:
            raw = response.llm_output.get("usage", response.llm_output.get("token_usage", {}))
            usage = {
                "input_tokens": raw.get("input_tokens", raw.get("prompt_tokens", 0)),
                "output_tokens": raw.get("output_tokens", raw.get("completion_tokens", 0)),
                "cache_read": 0,
                "cache_creation": 0,
            }

        # Extract model ID
        model_id = "unknown"
        if response.llm_output:
            model_id = response.llm_output.get("model_id", response.llm_output.get("model_name", "unknown"))

        entry = {
            "agent": "llm_call",
            "model": model_id,
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cache_read_tokens": usage.get("cache_read", 0),
            "cache_write_tokens": usage.get("cache_creation", 0),
            "latency_ms": round(elapsed_ms),
            "ttfb_ms": 0,
        }

        if not METRICS_ENABLED:
            return
        with open(self.output_file, "a") as f:
            f.write(json.dumps(entry) + "\n")

# Usage with ChatBedrock:
# llm = ChatBedrock(model_id="...", callbacks=[MetricsLogger()])

# Usage with LangGraph:
# graph.invoke(..., config={"callbacks": [MetricsLogger()]})
```

### Option C: Direct access after invoke (simplest for non-streaming)

```python
from langchain_aws import ChatBedrock

llm = ChatBedrock(model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0")

start = time.time()
response = llm.invoke("Hello")
elapsed_ms = round((time.time() - start) * 1000)

if response.usage_metadata:
    um = response.usage_metadata
    details = um.get("input_token_details", {}) or {}
    log_metrics({
        "agent": "direct_langchain",
        "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "input_tokens": um.get("input_tokens", 0),
        "output_tokens": um.get("output_tokens", 0),
        "cache_read_tokens": details.get("cache_read", 0),
        "cache_write_tokens": details.get("cache_creation", 0),
        "latency_ms": elapsed_ms,
        "ttfb_ms": 0,
    })
```

---

## 3. Direct Bedrock Calls (boto3)

> Source: [Amazon Bedrock API Reference — Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [TokenUsage](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html), [ConverseMetrics](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseMetrics.html).

### Converse API response structure

The `converse()` response contains:

| Response field | Type                                                                                                        | Description         |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| `usage`        | [TokenUsage](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html)           | Token counts        |
| `metrics`      | [ConverseMetrics](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseMetrics.html) | Performance metrics |

**TokenUsage fields:**

| Field                   | Type | Required | Description                    |
| ----------------------- | ---- | -------- | ------------------------------ |
| `inputTokens`           | int  | Yes      | Input tokens sent to the model |
| `outputTokens`          | int  | Yes      | Output tokens generated        |
| `totalTokens`           | int  | Yes      | Sum of input + output          |
| `cacheReadInputTokens`  | int  | No       | Tokens read from prompt cache  |
| `cacheWriteInputTokens` | int  | No       | Tokens written to prompt cache |

**ConverseMetrics fields:**

| Field       | Type | Required | Description                                  |
| ----------- | ---- | -------- | -------------------------------------------- |
| `latencyMs` | long | Yes      | Latency of the Converse call in milliseconds |

### Using the Converse API (recommended)

```python
import boto3, json, time

client = boto3.client("bedrock-runtime")

start = time.time()
response = client.converse(
    modelId="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    messages=[{"role": "user", "content": [{"text": "Hello"}]}],
)
wall_time_ms = round((time.time() - start) * 1000)

usage = response.get("usage", {})
metrics = response.get("metrics", {})

log_metrics({
    "agent": "direct_converse",
    "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "input_tokens": usage.get("inputTokens", 0),
    "output_tokens": usage.get("outputTokens", 0),
    "cache_read_tokens": usage.get("cacheReadInputTokens", 0),
    "cache_write_tokens": usage.get("cacheWriteInputTokens", 0),
    "latency_ms": metrics.get("latencyMs", wall_time_ms),
    "ttfb_ms": 0,
})
```

### Using invoke_model (legacy)

For `invoke_model`, token usage is in the response body. Field names are model-specific — Anthropic models use snake_case:

```python
import boto3, json, time

client = boto3.client("bedrock-runtime")

start = time.time()
response = client.invoke_model(
    modelId="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    body=json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 1024,
    }),
)
elapsed_ms = round((time.time() - start) * 1000)

body = json.loads(response["body"].read())
usage = body.get("usage", {})

log_metrics({
    "agent": "direct_invoke",
    "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "input_tokens": usage.get("input_tokens", 0),
    "output_tokens": usage.get("output_tokens", 0),
    "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
    "cache_write_tokens": usage.get("cache_creation_input_tokens", 0),
    "latency_ms": elapsed_ms,
    "ttfb_ms": 0,
})
```

**Important:** Field names differ between APIs:

- Converse API: camelCase (`inputTokens`, `cacheReadInputTokens`)
- invoke_model with Anthropic: snake_case (`input_tokens`, `cache_read_input_tokens`)

Always check the actual response structure for the model you're using.

---

## Quick Reference: Field Name Mapping

| Our JSONL field      | Strands `accumulated_usage`     | LangChain `usage_metadata`           | Bedrock Converse `usage` | Bedrock invoke_model (Anthropic) |
| -------------------- | ------------------------------- | ------------------------------------ | ------------------------ | -------------------------------- |
| `input_tokens`       | `inputTokens`                   | `input_tokens`                       | `inputTokens`            | `input_tokens`                   |
| `output_tokens`      | `outputTokens`                  | `output_tokens`                      | `outputTokens`           | `output_tokens`                  |
| `cache_read_tokens`  | `cacheReadInputTokens`          | `input_token_details.cache_read`     | `cacheReadInputTokens`   | `cache_read_input_tokens`        |
| `cache_write_tokens` | `cacheWriteInputTokens`         | `input_token_details.cache_creation` | `cacheWriteInputTokens`  | `cache_creation_input_tokens`    |
| `latency_ms`         | `accumulated_metrics.latencyMs` | wall time (manual)                   | `metrics.latencyMs`      | wall time (manual)               |
