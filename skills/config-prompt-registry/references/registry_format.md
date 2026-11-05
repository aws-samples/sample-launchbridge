<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Config Registry Format

The registry file lives at `.lb_workspace/config/config-prompt-store.yaml` in the project root.

**The registry is tracked in git.** It records what configuration and prompts govern the
solution, so changes to it belong in a reviewable diff — `lb-setup` configures `.gitignore`
to keep it out of the `.lb_workspace/` exclusion. Two consequences follow:

- Never write a live secret into `current_value` (see the redaction rule below). A
  committed registry is a committed secret.
- Tell the user to commit the registry after you update it, naming what changed. When
  `lb-setup` is running the sync, add it to its commit list instead of stopping to say so.

## Structure

Two top-level keys: `configs` and `prompts`. Each is a list of items.

### Config Fields

- **name**: Short identifier (e.g. `temperature`, `model_id`)
- **description**: One-line purpose
- **location**: Full file path from project root where the default value is assigned. Optionally include function name if relevant (e.g. `src/api/utils.py::generate_response`). No line numbers.
- **current_value**: Literal default value in source code
- **cli_arg**: `true` if overridable via CLI argument, `false` if hardcoded

### Prompt Fields

- **name**: Short identifier (e.g. `direct_prompt`, `consensus_prompt`)
- **description**: One-line purpose
- **location**: Full file path from project root. Optionally include function name (e.g. `prompt_generator.py::get_direct_prompt`). No line numbers.
- **version**: Integer version number, starting at 1. Increment when the prompt text is intentionally modified. Used for quick change detection alongside the prompt snapshot utility.
- **cli_arg**: `true` if overridable via CLI argument, `false` if hardcoded

## Example

```yaml
configs:
  - name: region_name
    description: AWS region for Bedrock API
    location: api_utils.py
    current_value: us-east-1
    cli_arg: false

  - name: temperature
    description: LLM sampling temperature
    location: utils.py::fully_decode
    current_value: 0
    cli_arg: false

  - name: model_id
    description: Bedrock model identifier
    location: run.py
    # Account ID redacted — the inference-profile ARN identifies infrastructure
    current_value: "arn:aws:bedrock:us-east-1:<account-id>:inference-profile/us.anthropic.claude-sonnet-4-6"
    cli_arg: true

prompts:
  - name: direct_prompt
    description: Simple multiple-choice question prompt
    location: prompt_generator.py::get_direct_prompt
    version: 1
    cli_arg: false

  - name: cot_prompt
    description: Chain-of-thought reasoning prompt
    location: prompt_generator.py::get_cot_prompt
    version: 1
    cli_arg: false
```

## Secret Redaction

`current_value` mirrors a literal from source code, so it can pick up a credential —
an API key, a token, a connection string, a password — as easily as a temperature. The
registry aggregates every such value into one committed file, which makes it a more
attractive target than any single source line.

**Never record a secret value. Record where it comes from instead.**

```yaml
configs:
  # WRONG — a committed credential
  - name: api_key
    description: Third-party API key
    location: src/client.py
    current_value: sk-live-4f9c2a7e1b8d
    cli_arg: false

  # RIGHT — the mechanism, not the value
  - name: api_key
    description: Third-party API key
    location: src/client.py
    current_value: "<redacted: read from env var THIRDPARTY_API_KEY>"
    cli_arg: false
```

Apply the same treatment to anything that identifies infrastructure rather than
configuring behaviour: account IDs, internal hostnames, ARNs containing account numbers,
bucket names, and private repository URLs. Record the shape (`arn:aws:bedrock:<region>:<account-id>:inference-profile/...`),
not the literal.

If you find a real secret hardcoded in source while building the registry, that is a
finding in its own right. Report it to the user with the file and say it should move to an
environment variable or a secrets manager. Do not copy it into the registry in the
meantime.

## Rules

- Never put a live secret in `current_value` — redact it and name its source
- Location must be the full file path from the project root (not just filename)
- For configs, location is where the default value is assigned
- Do not include line numbers — they are error prone
- Optionally include function name with `::` separator when it helps locate the item
- Current value for configs should reflect the actual default value in source code
- Keep descriptions concise — one line max
