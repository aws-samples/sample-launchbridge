<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Amazon Bedrock Model Pricing Reference

All prices are per 1M tokens, USD, on-demand standard tier.
Source: [Amazon Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)

> Prices may change. Always verify against the official pricing page before using in production cost reporting.

## Anthropic Claude Models

| Model                                  | Input  | Output | Batch Input | Batch Output | Cache Write (5m) | Cache Write (1h) | Cache Read |
| -------------------------------------- | ------ | ------ | ----------- | ------------ | ---------------- | ---------------- | ---------- |
| Claude Sonnet 4.6                      | $3.00  | $15.00 | $1.50       | $7.50        | $3.75            | $6.00            | $0.30      |
| Claude Sonnet 4.6 - Long Context       | $6.00  | $22.50 | $3.00       | $11.25       | $7.50            | $12.00           | $0.60      |
| Claude Opus 4.6                        | $5.00  | $25.00 | $2.50       | $12.50       | $6.25            | $10.00           | $0.50      |
| Claude Opus 4.6 - Long Context         | $10.00 | $37.50 | $5.00       | $18.75       | $12.50           | $20.00           | $1.00      |
| Claude Opus 4.5                        | $5.00  | $25.00 | $2.50       | $12.50       | $6.25            | $10.00           | $0.50      |
| Claude Haiku 4.5                       | $1.00  | $5.00  | $0.50       | $2.50        | $1.25            | $2.00            | $0.10      |
| Claude Sonnet 4.5                      | $3.00  | $15.00 | $1.50       | $7.50        | $3.75            | $6.00            | $0.30      |
| Claude Sonnet 4.5 - Long Context       | $6.00  | $22.50 | $3.00       | $11.25       | $7.50            | $12.00           | $0.60      |
| Claude Sonnet 4                        | $3.00  | $15.00 | $1.50       | $7.50        | $3.75            | N/A              | $0.30      |
| Claude Sonnet 4 - Long Context         | $6.00  | $22.50 | $3.00       | $11.25       | —                | —                | —          |
| Claude 3.5 Sonnet (Extended Access)    | $6.00  | $30.00 | $3.00       | $15.00       | N/A              | N/A              | N/A        |
| Claude 3.5 Sonnet v2 (Extended Access) | $6.00  | $30.00 | $3.00       | $15.00       | $7.50            | —                | $0.60      |

## Amazon Nova Models

| Model                               | Input  | Output |
| ----------------------------------- | ------ | ------ |
| Amazon Nova Micro                   | $0.035 | $0.14  |
| Amazon Nova Lite                    | $0.06  | $0.24  |
| Amazon Nova Pro                     | $0.80  | $3.20  |
| Amazon Nova Pro (latency optimized) | $1.00  | $4.00  |
| Amazon Nova Premier                 | $2.50  | $12.50 |
| Amazon Nova 2 Lite                  | $0.30  | $2.50  |

### Amazon Nova 2 Multimodal

| Model                 | Input (text) | Input (image) | Input (video) | Input (audio) | Output (text) | Output (image) |
| --------------------- | ------------ | ------------- | ------------- | ------------- | ------------- | -------------- |
| Nova 2 Omni (Preview) | $0.30        | $0.30         | $0.30         | $1.00         | $2.50         | $40.00         |
| Nova 2 Pro (Preview)  | $1.25        | $1.25         | $1.25         | $1.25         | $10.00        | N/A            |

### Nova Cache Pricing

Cache read input tokens are 75% less than on-demand input token price.

## Quick-Reference Pricing Dict (Python)

Use this dict in your monitoring code. Prices are per 1M tokens.
The `cache_write` value uses the 5-minute TTL rate where available.

```python
BEDROCK_PRICING = {
    # Anthropic Claude
    "us.anthropic.claude-sonnet-4-6": {
        "input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75,
    },
    "us.anthropic.claude-opus-4-6-20260612-v1:0": {
        "input": 5.00, "output": 25.00, "cache_read": 0.50, "cache_write": 6.25,
    },
    "us.anthropic.claude-opus-4-5-20251101-v1:0": {
        "input": 5.00, "output": 25.00, "cache_read": 0.50, "cache_write": 6.25,
    },
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
        "input": 1.00, "output": 5.00, "cache_read": 0.10, "cache_write": 1.25,
    },
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
        "input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75,
    },
    "us.anthropic.claude-sonnet-4-20250514-v1:0": {
        "input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75,
    },
    # Amazon Nova
    "us.amazon.nova-micro-v1:0": {
        "input": 0.035, "output": 0.14, "cache_read": 0.035 * 0.25, "cache_write": 0.035,
    },
    "us.amazon.nova-lite-v1:0": {
        "input": 0.06, "output": 0.24, "cache_read": 0.06 * 0.25, "cache_write": 0.06,
    },
    "us.amazon.nova-pro-v1:0": {
        "input": 0.80, "output": 3.20, "cache_read": 0.80 * 0.25, "cache_write": 0.80,
    },
    "us.amazon.nova-premier-v1:0": {
        "input": 2.50, "output": 12.50, "cache_read": 2.50 * 0.25, "cache_write": 2.50,
    },
}
```

> Model IDs are illustrative — always verify the exact model ID string you're using in your Bedrock configuration. The `us.` prefix denotes cross-region inference profiles.
