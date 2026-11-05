<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Multi-Modal Synthetic Data Generation

This reference extends data-wrangler's Step 3 (Generate Synthetic Data) for repos that accept non-text input modalities (images, audio, video) or require multi-turn conversational interaction.

**When to use this reference:** The agent reads this document when Step 1 (Understand the Data Contract) reveals the target repo accepts any of:

- Image input (photos, handwritten notes, diagrams, screenshots)
- Audio input (voice messages, speech commands)
- Video input (recordings, screen captures)
- Multi-turn conversation (stateful session with branching, gates, or interrupts)

If the repo only accepts structured text/JSON input, this reference is not needed — use the standard Step 3 flow.

---

## MM1. Build Modality Map

From the data contract (Step 1), construct a modality map capturing every input channel:

```yaml
modality_map:
  text:
    required: true
    formats: [<file formats>]
    languages: [<languages the repo handles>]
    entry_method: "<how text is passed — CLI arg, stdin, API field>"

  image:
    required: <true|false>
    formats: [<accepted formats: jpg, png, etc.>]
    content_types:
      [<what the images contain: handwritten notes, product photos, etc.>]
    processing: "<how the repo processes images — multimodal LLM, OCR, classifier>"

  audio:
    required: <true|false>
    formats: [<accepted formats: ogg, wav, mp3, etc.>]
    languages: [<spoken languages>]
    processing: "<how audio is processed — transcription service, speech model, etc.>"
    duration_range: "<typical clip length>"

  video:
    required: <true|false>
    formats: [<accepted formats>]
    processing: "<how video is processed>"

  interaction_pattern:
    type: "<single_shot | multi_turn_conversation | batch>"
    session_key: "<what identifies a session — user ID, request ID, thread ID, etc.>"
    gates: [<any confirmation/interrupt points>]
    max_turns: <upper limit>
    typical_turns: <expected range>
```

Present this map to the user for confirmation before proceeding to model selection.

---

## MM2. Discover & Select Generation Models

Model selection is **fully dynamic** — discover what the user's account actually has access to, then rank candidates per modality.

### Discovery Steps

1. **List available models:**

   ```bash
   aws bedrock list-foundation-models --region <region> --output json
   ```

   Parse the response and group models by `outputModalities` (TEXT, IMAGE, EMBEDDING) and `inputModalities`.

2. **Filter by needed capability:**
   - Text generation → models with TEXT in outputModalities
   - Image generation → models with IMAGE in outputModalities
   - Audio generation → check for audio-capable models; if none found, Amazon Polly is generally available without a model-access grant (verify with `aws polly describe-voices --region <region>`; requires `polly:SynthesizeSpeech` IAM permission)
   - Video generation → check for video-capable models; if none, mark as skippable

3. **Verify access for each candidate:**

   ```bash
   aws bedrock get-foundation-model --model-identifier <model-id> --region <region>
   ```

   Confirm `modelLifecycleStatus` is `ACTIVE`. If the model requires an access grant and the user hasn't enabled it, exclude it.

   Also check for cross-region inference profiles:

   ```bash
   aws bedrock list-inference-profiles --region <region>
   ```

   These may provide access to models not directly available in the user's region.

4. **Rank accessible candidates per modality:**

   Scoring criteria (weighted):
   | Factor | Weight | How to Assess |
   |--------|--------|---------------|
   | Task fit | High | Does the model excel at the specific content type needed? (handwriting, speech, etc.) |
   | Cost | Medium | On-demand pricing per generation unit |
   | Quality tier | Medium | Larger/newer models generally produce better output |
   | Latency | Low | Relevant for bulk generation (hundreds of items) |

5. **Select top recommendation + alternatives:**
   - **Recommended**: Best task-fit model that's accessible
   - **Budget option**: Cheapest accessible model that still meets minimum quality
   - **Fallback**: Non-Bedrock alternative if no suitable model found (Polly for audio, template-based for images)

### Fallback Hierarchy

When models aren't available, degrade gracefully:

| Modality | Level 1 (preferred)               | Level 2 (fallback)                                 | Level 3 (last resort)               |
| -------- | --------------------------------- | -------------------------------------------------- | ----------------------------------- |
| Text     | Best available Bedrock text model | Smaller/cheaper text model                         | Cannot skip — text is always needed |
| Image    | Bedrock image generation model    | Template-based (text overlaid on textures via PIL) | Skip modality, test text-only       |
| Audio    | Bedrock audio model               | Amazon Polly Neural                                | Amazon Polly Standard               |
| Video    | Bedrock video model               | Skip (video is always optional)                    | —                                   |

When a modality is skipped, log it in the plan and inform the user what they'd need to enable for full coverage.

---

## MM3. Design Personas & Scenarios

Define test personas that drive realistic data variety. Each persona combines:

- **Language/communication style** — what language they use, formality level, common abbreviations
- **Behavior pattern** — how they typically interact (text-heavy, sends photos, voice messages)
- **Use case pattern** — what they're trying to accomplish (routine task, first-time exploration, troubleshooting, complaint)
- **Edge case triggers** — what unusual situations this persona creates (misspellings, ambiguous quantities, mixed scripts)

### Persona Template

```yaml
personas:
  - id: "<short_identifier>"
    language: "<primary language or mix>"
    modality_preference: "<text | image | audio | mixed>"
    behavior: "<one-line description of typical interaction style>"
    use_case: "<what they're trying to accomplish>"
    usage_pattern: "<if applicable — frequency, volume, complexity of interactions>"
    edge_cases: ["<specific challenging inputs this persona generates>"]
```

### Scenario Coverage

Define scenarios that exercise different code paths:

```yaml
scenarios:
  - id: "<scenario_name>"
    description: "<what this scenario tests>"
    modalities_exercised: [<which modalities are used>]
    turns: <expected number of conversation turns>
    includes_gates: <true|false — does it trigger confirmation/interrupt flows?>
    expected_outcome: "<what should happen if the repo works correctly>"
    edge_cases_covered: ["<specific edge cases this scenario validates>"]
```

**Coverage guidelines:**

- At least one scenario per modality
- At least one scenario per gate/interrupt type
- At least one error recovery scenario (bad input → graceful handling)
- Mix of short (2-3 turn) and long (6-10+ turn) conversations
- Each persona should appear in multiple scenarios

### Adversarial & Stress Testing Philosophy

The goal of synthetic test data is **not** to produce inputs the repo handles perfectly — it's to **find the boundaries where it breaks.** Failures are valuable signal. The generated data should deliberately push the target repo's limits.

**Distribution target:**

- ~40% easy cases (happy path — validates basic functionality works)
- ~35% medium cases (tricky but plausible inputs that probe known-fragile areas)
- ~25% hard / edge cases (designed to break things — expected to fail)

**Edge case generation strategy:**

Analyze the target repo's code to identify fragile areas, then generate inputs that stress them:

| Area to Probe         | Example Edge Cases                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Input parsing         | Malformed JSON, unexpected field types, missing required fields, extra fields                            |
| Language/text         | Misspellings, code-switching mid-sentence, ambiguous phrasing, very long input, empty input              |
| Image processing      | Blurry photos, rotated images, low contrast, partial occlusion, wrong file format with correct extension |
| Audio processing      | Background noise, multiple speakers, very fast speech, silence, truncated audio                          |
| State management      | Rapid-fire messages, contradictory requests, resuming after long pause, session boundary conditions      |
| Numeric handling      | Zero quantities, negative numbers, extremely large numbers, decimals where integers expected             |
| Concurrency/ordering  | Out-of-order turns, duplicate messages, messages during gate confirmation                                |
| Security boundaries   | Prompt injection attempts, excessively long input, special characters, unicode edge cases                |
| Error recovery        | Invalid references, resource-not-found, API timeout simulation, partial failures                         |
| Multi-modal confusion | Image with no visible text, audio that's pure noise, text saying "see attached" with no attachment       |

**For each scenario, explicitly state whether failure is expected:**

```yaml
scenarios:
  - id: "blurry_document_photo"
    description: "Extremely blurry photo of a document — tests graceful degradation"
    difficulty: "hard"
    expected_behavior: "Agent should ask user to resend a clearer photo"
    failure_acceptable: true
    failure_insight: "If agent hallucinates products from unreadable text, that's a critical finding"
```

**Difficulty tiers:**

- `easy` — Should pass. If it fails, that's a bug.
- `medium` — May pass or fail. Failures reveal areas for improvement.
- `hard` — Expected to fail or degrade gracefully. Tests robustness boundaries. A graceful failure (asking for clarification, returning an error message) is success. A crash, hallucination, or silent wrong answer is a finding.

The agent should analyze the specific target repo's implementation to identify its weakest points, then concentrate hard cases there. For example:

- If the repo uses regex for parsing → generate inputs that break the regex patterns
- If the repo uses fuzzy matching → generate near-miss inputs that could match wrong items
- If the repo has length limits → generate inputs right at, just below, and just above the limits
- If the repo handles state → generate sequences that create impossible states

Present personas and scenarios to the user for approval. They may want to add domain-specific personas, remove irrelevant ones, or adjust the mix. **Clearly label the difficulty tier of each scenario so the user understands that hard-tier failures are intentional and valuable.**

---

## MM4. Produce the Generation Plan

Assemble everything into a human-reviewable `data_generation_plan.md` (consistent with the standard path) that also embeds the machine-readable JSON specification. This ensures tooling and humans looking for "the plan" in any run directory find the same filename and format regardless of which generation path was used.

Write `$RUN_DIR/data_generation_plan.md` with the following structure:

```markdown
# Data Generation Plan (Multi-Modal)

**Target repo:** <repo path>
**Repo classification:** multi-modal pipeline + <other patterns>
**Domain:** <domain>
**Date:** <ISO-8601>
**Plan version:** 1.0

## Modality Map

<Rendered from MM1 — human-readable summary of each modality's requirements>

## Model Selection

| Modality | Selected Model             | Reason   | Fallback   |
| -------- | -------------------------- | -------- | ---------- |
| Text     | <model>                    | <reason> | <fallback> |
| Image    | <model or fallback method> | <reason> | <fallback> |
| Audio    | <service:model>            | <reason> | <fallback> |
| Video    | <model or "skipped">       | <reason> | —          |

## Personas & Scenarios

### Personas (<count>)

| ID   | Language | Modality Preference | Behavior   |
| ---- | -------- | ------------------- | ---------- |
| <id> | <lang>   | <pref>              | <one-line> |

### Scenarios (<count>)

| ID   | Description | Modalities | Difficulty         | Expected Outcome |
| ---- | ----------- | ---------- | ------------------ | ---------------- |
| <id> | <desc>      | <mods>     | <easy/medium/hard> | <outcome>        |

## Generation Plan

**Total sessions:** <N>
**Turns per session:** <min>–<max>

### Distribution

- Easy (~40%): <count> sessions
- Medium (~35%): <count> sessions
- Hard / Edge (~25%): <count> sessions

### Artifact Counts

| Modality           | Count    | Format   |
| ------------------ | -------- | -------- |
| Text conversations | <n>      | JSON     |
| Images             | <n>      | <format> |
| Audio clips        | <n>      | <format> |
| Video              | <n or 0> | <format> |

## Cost Estimate

| Modality         | Estimated Cost  |
| ---------------- | --------------- |
| Text generation  | $<amount>       |
| Image generation | $<amount>       |
| Audio generation | $<amount>       |
| Video generation | $<amount or $0> |
| **Total**        | **$<total>**    |

Note: Estimated from on-demand pricing for selected models.

## Notes

- Hard cases are designed to push limits — failures are expected and valuable.
- Test metadata is stored in a separate `test_metadata.json` / `ground_truth.json` — not embedded in input data.
- All generated media artifacts are validated before archival (see MM6).
```

Additionally, write the machine-readable specification to `$RUN_DIR/data_generation_plan.json` for programmatic consumption:

```json
{
  "target_repo": "<repo path>",
  "plan_version": "1.0",
  "created_at": "<ISO-8601 timestamp>",
  "environment": {
    "region": "<AWS region>",
    "models_discovered_at": "<ISO-8601 timestamp>"
  },
  "modality_map": { "<from MM1>" },
  "modalities": {
    "text": {
      "model_id": "<selected model ID>",
      "model_name": "<human-readable name>",
      "selection_reason": "<why this model was chosen>",
      "budget_model_id": "<cheaper alternative if available>",
      "count": "<number of text artifacts to generate>",
      "description": "<what the text data consists of>",
      "scenarios": ["<scenario IDs that produce text>"],
      "languages": ["<target languages>"]
    },
    "image": {
      "model_id": "<selected model ID or null>",
      "model_name": "<human-readable name>",
      "selection_reason": "<why this model>",
      "fallback_method": "<template_based | skip | null>",
      "count": "<number of images to generate>",
      "description": "<what the images depict>",
      "subtypes": { "<content_type>": "<count>" }
    },
    "audio": {
      "service": "<polly | bedrock>",
      "model_id": "<model ID or polly voice config>",
      "selection_reason": "<why this service/model>",
      "count": "<number of audio clips>",
      "description": "<what the audio contains>",
      "voices": { "<language_code>": ["<voice IDs>"] },
      "duration_range_seconds": [<min>, <max>]
    },
    "video": {
      "model_id": "<model ID or null>",
      "status": "<included | skipped>",
      "skip_reason": "<why skipped, if applicable>",
      "count": "<number or 0>",
      "description": "<what the videos show>"
    }
  },
  "personas": ["<persona objects from MM3>"],
  "scenarios": ["<scenario objects from MM3>"],
  "conversation_flows": {
    "total_sessions": "<number of complete conversations to generate>",
    "turns_per_session": { "min": "<min>", "max": "<max>" },
    "includes_gates": "<true|false>",
    "includes_error_recovery": "<true|false>"
  },
  "ground_truth": {
    "generate": true,
    "description": "<what ground truth looks like for this repo>",
    "format": "<structure of expected outcomes>"
  },
  "estimated_cost": {
    "breakdown": {
      "text_generation": "<estimated USD>",
      "image_generation": "<estimated USD>",
      "audio_generation": "<estimated USD>",
      "video_generation": "<estimated USD or $0 if skipped>"
    },
    "total_estimated_usd": "<sum>",
    "note": "Estimated from on-demand pricing for selected models"
  },
  "output_structure": {
    "directory": ".lb_workspace/data/run_<timestamp>/",
    "files": {
      "conversations.json": "All conversation flows with turn sequences",
      "images/": "Generated image files",
      "audio/": "Generated audio files",
      "video/": "Generated video files (if applicable)",
      "ground_truth.json": "Expected outcomes per conversation/record",
      "data_generation_plan.json": "This plan (archived with output)",
      "data_manifest.json": "Standard data-wrangler manifest"
    }
  }
}
```

### User Approval

Present the plan to the user in a readable summary:

1. Show the modality map and selected models (with reasoning)
2. Show personas and scenario coverage
3. Show estimated cost
4. Show what will be generated (counts per modality)

The user can:

- **Approve** — proceed to execution (MM5)
- **Modify models** — swap to a different model for any modality
- **Adjust counts** — increase/decrease generation volume
- **Add/remove personas** — customize test coverage
- **Add/remove scenarios** — focus on specific code paths
- **Skip a modality** — reduce scope if budget or time is constrained

Do NOT proceed to execution until the user explicitly approves the plan.

---

## MM5. Execute the Plan

After user approval, generate artifacts in this order:

### Text Generation (Conversation Scripts)

Use the selected text model to generate multi-turn conversation scripts:

1. For each persona × scenario combination, prompt the text model to produce a realistic conversation flow
2. Each conversation is a list of turns with role, modality indicator, and content
3. For turns that use image/audio, generate a description of what the media contains (used as prompts for media generation next)
4. Include expected agent behavior (tool calls, responses) as ground truth annotations

**Turn format:**

```json
{
  "turn": 1,
  "role": "user",
  "modality": "text | image | audio",
  "content": "<text content or null for media>",
  "media_file": "<filename in images/ or audio/ — null for text>",
  "media_description": "<what the media depicts — used for generation and ground truth>",
  "expected_tools": ["<tool calls the agent should make>"],
  "expected_response_contains": ["<key phrases expected in response>"]
}
```

### Image Generation

For each conversation turn where `modality == "image"`:

1. Use the `media_description` from the conversation script as the generation prompt
2. Invoke the selected image model (adapting the request format to the specific model's API)
3. Save the output to `images/<filename>.png`
4. Validate the image is readable and correct dimensions

**Model-agnostic invocation pattern:**

```python
# The agent adapts the request body based on which model was selected.
# Dimensions should be derived from the data contract (what the target repo expects)
# or the model's recommended defaults — not hardcoded.
image_bytes = invoke_image_model(
    model_id=plan["modalities"]["image"]["model_id"],
    prompt=turn["media_description"],
    width=plan["modalities"]["image"].get("width", 1024),   # from data contract or model defaults
    height=plan["modalities"]["image"].get("height", 1024)  # from data contract or model defaults
)
```

If using the template-based fallback (no image model available):

- Render the text content onto a realistic paper texture using PIL/Pillow
- Apply handwriting-style fonts if available, or clean print otherwise
- This produces less realistic images but still exercises the repo's image processing path

### Audio Generation

For each conversation turn where `modality == "audio"`:

1. Use the `content` field (the text to be spoken) and the persona's language
2. Invoke Polly or the selected audio model:
   - **Polly**: Use Neural engine, select voice matching the persona's language
   - **Bedrock audio model**: Adapt request format to the model's API
3. Save to `audio/<filename>.ogg` (or `.wav` depending on repo requirements)
4. Validate audio is playable and within expected duration range

**Voice selection for Polly:**

- Discover available voices for the target language: `aws polly describe-voices --language-code <code>`
- Prefer Neural engine voices for naturalness
- Match voice characteristics to persona (if relevant)

### Video Generation

If the plan includes video and a model is available:

1. Use the scenario description as the generation prompt
2. Invoke the video model
3. Save to `video/<filename>.mp4`

If video was skipped in the plan, skip this step entirely.

### Ground Truth Assembly

For each conversation, generate the expected final state:

```json
{
  "session_id": "<matches conversation session_id>",
  "difficulty": "easy | medium | hard",
  "failure_acceptable": false,
  "expected_outcome": {
    "<domain-specific fields>": "<expected values>"
  },
  "expected_behavior_on_failure": "<what graceful degradation looks like — null for easy cases>",
  "per_turn_expectations": [
    {
      "turn": 1,
      "expected_tools_called": ["<tool names>"],
      "expected_extractions": { "<what should be extracted from media>" },
      "difficulty": "easy | medium | hard"
    }
  ]
}
```

The structure of `expected_outcome` depends on the target repo. The agent infers it from the data contract (Step 1). Examples:

- Document processing agent: extracted entities, classification label, confidence score
- Classification agent: predicted label per input
- Q&A agent: answer text, source citations

**Hard-tier ground truth rules:**

- For `difficulty: "hard"` cases, `expected_outcome` describes the _ideal_ handling (graceful degradation)
- `expected_behavior_on_failure` describes what counts as an acceptable failure (e.g., "asks user to clarify" or "returns error message")
- A crash, hallucination, or silently wrong answer is never acceptable — even for hard cases
- This distinction lets evaluate-predictions score hard cases differently: a graceful refusal scores as pass, a crash scores as critical finding

### Execution Report

After all artifacts are generated, append an **Execution Report** section to `data_generation_plan.md` (same pattern as the standard path, ensuring a single source of truth for what was planned, approved, and produced):

```markdown
---

## Execution Report

**Generated at:** <ISO-8601 timestamp>
**Status:** completed

### Artifacts Generated

| Modality           | Planned   | Actual   | Notes |
| ------------------ | --------- | -------- | ----- |
| Text conversations | <planned> | <actual> |       |
| Images             | <planned> | <actual> |       |
| Audio clips        | <planned> | <actual> |       |
| Video              | <planned> | <actual> |       |

### Difficulty Distribution

| Difficulty  | Planned   | Actual   | Notes |
| ----------- | --------- | -------- | ----- |
| Easy        | <planned> | <actual> |       |
| Medium      | <planned> | <actual> |       |
| Hard / Edge | <planned> | <actual> |       |

### Models Used

| Modality | Model ID       | Invocations | Estimated Cost |
| -------- | -------------- | ----------- | -------------- |
| Text     | <id>           | <count>     | $<amount>      |
| Image    | <id or method> | <count>     | $<amount>      |
| Audio    | <service:id>   | <count>     | $<amount>      |

### Deviations from Plan

<Any sessions/artifacts that were added, removed, changed, or failed — or "None" if executed exactly as planned.>
```

---

## MM6. Validate Generated Artifacts

Before archiving, validate all generated content:

| Check                  | What It Validates                                        | Failure Action                          |
| ---------------------- | -------------------------------------------------------- | --------------------------------------- |
| Images readable        | Each .png/.jpg opens without error                       | Regenerate or remove from conversations |
| Audio playable         | Each .ogg/.wav has valid headers and non-zero duration   | Regenerate or remove                    |
| Video playable         | Each .mp4 has valid container format                     | Regenerate or skip                      |
| JSON valid             | conversations.json and ground_truth.json parse correctly | Fix syntax errors                       |
| File references intact | Every `media_file` in conversations.json exists on disk  | Regenerate missing files                |
| Schema match           | Conversation structure matches data contract from Step 1 | Transform to match                      |
| Counts match plan      | Generated counts match what was approved                 | Log discrepancy, inform user            |

Report validation results to the user. If any critical failures can't be auto-fixed, ask how to proceed.

---

## MM7. Archive & Manifest

After validation passes, proceed to the standard data-wrangler Steps 5-6 (Archive and Write Manifest). The multimodal manifest uses the **same required core** as the standard manifest, with additional optional extension blocks for multimodal-specific metadata:

```json
{
  "timestamp": "<ISO-8601>",
  "status": "completed",
  "target_repo": "<path>",
  "repo_classification": {
    "patterns": ["multi_modal_pipeline", "<other patterns>"],
    "domain": "<problem domain>",
    "modalities": ["text", "image", "audio"]
  },
  "source": "synthetic",
  "data_file": "conversations.json",
  "test_metadata_file": "ground_truth.json",
  "record_count": "<number of conversations>",
  "difficulty_distribution": {
    "easy": "<count>",
    "medium": "<count>",
    "hard": "<count>"
  },
  "schema_summary": {
    "type": "multi_turn_conversations",
    "modalities": ["<modalities included>"],
    "languages": ["<languages>"],
    "personas": "<count>",
    "scenarios": "<count>",
    "total_turns": "<sum across all conversations>"
  },
  "data_cli_arg": "<how to pass this to the entry point>",
  "gap_analysis": {
    "dimensions_assessed": "<number>",
    "gaps_found": "<number>",
    "gaps_addressed": "<number>",
    "remaining_gaps": []
  },
  "validation": {
    "passed": true,
    "checks": {
      "images_readable": true,
      "audio_playable": true,
      "video_playable": true,
      "json_valid": true,
      "all_files_referenced": true,
      "counts_match_plan": true
    },
    "warnings": []
  },

  "_multimodal_extensions": "--- Fields below are multimodal-specific optional extensions ---",

  "artifacts": {
    "images": { "count": "<n>", "format": "<ext>", "directory": "images/" },
    "audio": { "count": "<n>", "format": "<ext>", "directory": "audio/" },
    "video": { "count": "<n>", "format": "<ext>", "directory": "video/" }
  },
  "models_used": {
    "text": "<actual model ID used>",
    "image": "<actual model ID or fallback method>",
    "audio": "<actual service:model/voice used>",
    "video": "<actual model ID or skipped>"
  },
  "estimated_cost_usd": "<from plan>",
  "generation_plan": "data_generation_plan.json"
}
```

**Schema design principles:**

- The top-level required fields (`timestamp`, `status`, `target_repo`, `repo_classification`, `source`, `data_file`, `test_metadata_file`, `record_count`, `data_cli_arg`, `validation`) are identical to the standard manifest. Any consumer that reads the standard manifest can read a multimodal manifest without branching.
- `difficulty_distribution` and `gap_analysis` are present in both paths (same semantics).
- `artifacts`, `models_used`, `estimated_cost_usd`, and `generation_plan` are multimodal-specific extensions — present only when the multimodal path was used. Consumers should treat them as optional.
- `test_metadata_file` points to `ground_truth.json` (the multimodal equivalent of the standard path's `test_metadata.json`) — same purpose (per-record difficulty + expected behavior for evaluation), different internal structure to accommodate per-turn expectations.

Both `data_generation_plan.md` and `data_generation_plan.json` are copied into the run directory for reproducibility — they record exactly which models, personas, and scenarios were used.

---

## Downstream Impact (Design Notes — Not Yet Implemented)

> **⚠️ Forward-looking design:** The capabilities described in this section are **not yet implemented** in `generate-predictions` or `evaluate-predictions`. They describe how those skills _should_ evolve to consume multimodal data once support is built. Do not treat these as existing capabilities — agents should not attempt to improvise this behavior. Implementation is tracked as future work.

### generate-predictions: Conversation Replay Mode (planned)

When `data_manifest.json` has `schema_summary.type == "multi_turn_conversations"`, `generate-predictions` should use **conversation replay** instead of single-shot execution:

1. Read `conversations.json` from the data run
2. For each session:
   - Initialize the target repo's agent with fresh state
   - For each user turn: invoke with the turn's content + media file (if applicable)
   - Capture the agent's response, tool calls, and state changes
   - Handle gates/interrupts by injecting the scripted response from ground truth
3. Output: per-session interaction trace with full request/response pairs

This requires the target repo to expose a **programmatic invocation interface** (function call, not just CLI stdin). The agent discovers this during Step 1 of generate-predictions by looking for:

- A callable function (e.g., `invoke_agent(text, media=None)`)
- An HTTP API endpoint (local server mode)
- A structured CLI that accepts turn-by-turn input

### evaluate-predictions: Multi-Turn Metrics (planned)

Multi-modal conversation data enables new evaluation dimensions:

| Metric Category      | Examples                                                  | Type                      |
| -------------------- | --------------------------------------------------------- | ------------------------- |
| Outcome accuracy     | Final state matches ground truth                          | Deterministic             |
| Turn efficiency      | Completed in expected number of turns                     | Deterministic             |
| Tool call accuracy   | Correct tools called per turn                             | Deterministic             |
| Media extraction     | Correct information extracted from images/audio           | LLM-judge                 |
| Language consistency | Response matches user's language                          | Deterministic + LLM-judge |
| Gate compliance      | Interrupts fire when expected, respect Y/N                | Deterministic             |
| Conversation quality | Naturalness, helpfulness, clarity                         | LLM-judge                 |
| Graceful degradation | Handles hard-tier input without crashing or hallucinating | LLM-judge                 |
| Robustness score     | % of medium/hard cases handled acceptably                 | Deterministic             |

**Scoring by difficulty tier:**

Evaluation must be difficulty-aware. When the ground truth includes `difficulty` tiers:

- `easy` cases: scored normally — failures are bugs
- `medium` cases: scored normally but reported separately — failures are improvement areas
- `hard` cases: scored on a **graceful degradation rubric** — the question isn't "did it get the right answer?" but "did it fail safely?"

Graceful degradation scoring:

- **Pass** (1.0): Agent recognizes the issue and responds appropriately (asks for clarification, returns a helpful error, refuses unsafe input)
- **Partial** (0.5): Agent partially handles it (gets confused but doesn't crash or hallucinate)
- **Fail** (0.0): Agent crashes, produces a hallucinated answer, or silently gives wrong results

The evaluation report should present results in three tiers so the user sees:

1. Core accuracy (easy cases) — "Does it work?"
2. Medium-tier handling — "How robust is it?"
3. Hard-tier resilience — "Where does it break, and does it break safely?"

These would be implemented as custom metrics in `.lb_workspace/evaluations/custom_metrics.py` following the existing metric authoring contract.
