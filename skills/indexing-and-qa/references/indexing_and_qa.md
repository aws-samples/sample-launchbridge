<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# LaunchBridge Package Reference

Reference documentation for the `iris` Python package (IRIS — Indexed Repository Intelligence System) used by the `indexing-and-qa` skill.

## Package Installation

The package is installed from its public GitHub repository into `.venv_lb` in the target
codebase. The `indexing_and_qa` extra in `project_dependencies/pyproject.toml` pins it
to a commit, so every install gets the same IRIS code. To update it, change the ref to
`@main`, run `install_script/freeze_deps.py project_dependencies`, review the diff, and
commit. When installing by hand, use the commit pinned there:

```bash
pip install "iris @ git+https://github.com/aws-samples/sample-indexed-repository-intelligence-system.git@<commit pinned in project_dependencies/pyproject.toml>" \
  -c .lb_workspace/config/python_deps/constraints.txt
```

Install it only from this URL. An **unrelated** project already occupies the name `iris`
on PyPI, so a bare `pip install iris` fetches third-party code that has nothing to do
with IRIS.

## Python API

### `index_codebase_artifacts()` — Unified Indexing (Codebase + Artifacts)

Indexes the codebase and/or engagement artifacts. If `artifact_dir` is not configured, only codebase indexing runs.

```python
from iris.api import index_codebase_artifacts

result = index_codebase_artifacts(config_path="/path/to/inq_config.yaml", mode="both")
```

The `mode` parameter controls what gets indexed:

- `"codebase"` — index source code only
- `"artifact"` — index engagement artifacts only
- `"both"` — index both codebase and artifacts

**Returns:**

```python
{
    "codebase_result": {
        "status": "update_complete",  # or "no_op", "error"
        "message": "...",
        "processed_files": [...]
    },
    "artifact_result": {              # None if artifact_dir not configured
        "status": "update_complete",  # or "no_op", "error"
        "message": "...",
        "processed_artifacts": [...],
        "knowledge_base_path": "...",
        "knowledge_base_size": 12345,
        "total_artifacts": 42
    }
}
```

**What it does:**

1. Based on `mode`, runs codebase indexing via `generate_context()` and/or artifact indexing via `generate_artifact_context()`
2. Codebase pipeline: scans files, detects changes via hash comparison, summarizes new/modified files using AWS Bedrock Claude models in parallel
3. Artifact pipeline: discovers supported files, extracts text in parallel, saves per-artifact `.md` files under `extracted_artifacts/`, summarizes via LLM
4. Both pipelines are incremental — only changed files are re-processed

## Supported Artifact Formats

| Format                         | Extractor                 | Notes                                              |
| ------------------------------ | ------------------------- | -------------------------------------------------- |
| `.pptx`                        | python-pptx               | Slides text + speaker notes                        |
| `.docx`                        | python-docx               | Paragraph text                                     |
| `.xlsx`                        | openpyxl                  | All sheets, row-by-row cell data                   |
| `.pdf`                         | pdfplumber                | Text extraction, optional OCR for image-only pages |
| `.md`, `.txt`                  | Built-in                  | Prefixed with source filename                      |
| `.mp4`, `.mov`, `.avi`, `.mkv` | AWS Transcribe (optional) | Metadata-only if transcription disabled            |

## Storage Layout

### Codebase Index

Paths below reflect the LaunchBridge config (`output_dir: .lb_workspace/indexing_and_qa`). When the package runs standalone without that setting, it defaults to `.iris_cache` instead.

```
{codebase_dir}/.lb_workspace/indexing_and_qa/{codebase_name}/
├── codebase_overview.json    # Main index with file summaries
├── file_hashes.json          # For change detection
├── codebase_metadata.json    # Timestamps, stats
├── file_paths.txt            # List of indexed files
├── tree.txt                  # Directory tree
└── logs/                     # Indexing logs
    └── YYYYMMDD_HHMMSS.log
```

### Artifact Index

```
{codebase_dir}/.lb_workspace/indexing_and_qa/{codebase_name}/
├── artifact_overview.json          # Artifact summaries and metadata
├── artifact_file_hashes.json       # For artifact change detection
├── knowledge_base.md               # Optional assembled KB for human review
└── extracted_artifacts/            # Per-artifact extracted text (mirrors user's folder layout)
    └── ...                         # .md files matching source artifact paths
```

Per-artifact `.md` files under `extracted_artifacts/` are the primary retrieval source at query time. The optional `knowledge_base.md` is a convenience output for human review and is not used for retrieval.

## MCP Server Integration

`lb-setup` registers the MCP server from its template (`skills/lb-setup/templates/lb_mcp.json`) into the agent's MCP configuration, for example `{codebase_path}/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "launchbridge-qa-server": {
      "command": "<base interpreter that lb_guard.py paths prints>",
      "args": [
        "-I",
        "-S",
        "<lb_guard.py in the state directory, from lb_guard.py paths>",
        "exec",
        "{codebase_path}",
        "--",
        "-I",
        "{codebase_path}/.lb_workspace/config/mcp_v1_compat.py",
        "iris_mcp",
        "--config",
        "{codebase_path}/.lb_workspace/indexing_and_qa/inq_config.yaml"
      ],
      "timeout": 300000,
      "disabled": false
    }
  }
}
```

**Key Points:**

- MCP server starts through LaunchBridge's guard (`lb_guard.py`, which refuses unless `.venv_lb` and the launcher are as lb-setup sealed them), in the `.venv_lb` virtual environment, through LaunchBridge's launcher (`mcp_v1_compat.py`), which refuses to start it unless `mcp_enabled_tools` is exactly `[codebase_artifact_query]`, the Q&A models are covered by the data-handling confirmation, and no other IAM role is configured (`use_super_profile`, `ROLE_ARN`), and limits the query tool to the config's `codebase_dir`. Don't point the agent at `.venv_lb/bin/iris_mcp` or the launcher directly: that skips those checks (the launcher refuses a start that didn't come through the guard).
- Config path points to the codebase's `inq_config.yaml`
- Server name is `launchbridge-qa-server`
- 5-minute timeout for long-running queries

### MCP Tool: `codebase_artifact_query`

The primary MCP tool for Q&A. Uses an orchestrator agent that automatically routes queries to the right context.

**Parameters:**

- `query` (string, required): The question about the codebase and/or artifacts
- `codebase_dir` (string, required): Absolute path to the indexed codebase
- `artifact_dir` (string, optional): Absolute path to artifacts directory — falls back to `artifact_dir` in config if empty

**How routing works:**

The orchestrator agent decides which retrieval tools to invoke based on the query:

- Codebase questions → invokes `file_retrieval_agent`
- Artifact questions → invokes `artifact_retrieval_agent`
- Cross-domain questions → invokes both

The `artifact_retrieval_agent` uses a router to identify only the most relevant artifacts for the query, avoiding context window overflow.

**Tool Usage Examples:**

```
User: "What does main.py do?"
  → orchestrator routes to file_retrieval_agent
  → Returns: AI-generated answer with relevant code context

User: "What was discussed in the kickoff meeting?"
  → orchestrator routes to artifact_retrieval_agent
  → Returns: AI-generated answer with relevant artifact content

User: "Is there code matching what was discussed in the design doc?"
  → orchestrator routes to both agents
  → Returns: consolidated answer spanning code and artifacts
```

**Note:** Requires indexing to be run first. If `artifact_dir` is not configured and no `artifact_overview.json` exists, the agent will only use the codebase retrieval tool.

## Configuration File

Both indexing and Q&A require a `inq_config.yaml` file at `{codebase_path}/.lb_workspace/indexing_and_qa/inq_config.yaml`.

### Core Settings

```yaml
# Required: Absolute path to codebase
codebase_dir: /absolute/path/to/codebase

# Required: Output directory (relative to codebase_dir)
output_dir: .lb_workspace/indexing_and_qa

# Required: AWS Bedrock model configurations
model_configuration:
  file_summarizer:
    # Multiple model-region pairs for parallel processing
    models:
      - model_id: us.anthropic.claude-haiku-4-5-20251001-v1:0
        region: us-west-2
      - model_id: us.anthropic.claude-haiku-4-5-20251001-v1:0
        region: us-east-1
      # Add 3-10 pairs for faster indexing

  orchestrator:
    model_id: us.anthropic.claude-sonnet-4-6
    region: us-east-1

  file_identifier:
    model_id: us.anthropic.claude-haiku-4-5-20251001-v1:0
    region: us-east-2

# Optional: Files/directories to ignore
ignore_patterns:
  - "node_modules/"
  - ".git/"
  - "__pycache__/"
  - "*.pyc"
  - ".venv/"
  - "build/"
  - "dist/"

# MCP tools to enable
mcp_enabled_tools:
  - codebase_artifact_query
```

### Artifact Settings (all optional)

```yaml
# Path to engagement artifacts directory (default: .project_artifacts relative to codebase_dir)
artifact_dir: .project_artifacts

# Maximum file size for extraction (bytes). Default: 30MB
artifact_max_file_size: 30000000

# Maximum file size for video files (bytes). Default: 300MB
artifact_video_max_file_size: 300000000

# Number of parallel extraction/summarization workers. Default: 4
artifact_max_workers: 4

# Generate assembled knowledge_base.md for human review. Default: false
artifact_generate_knowledge_base: false

# Enable OCR for image-only PDF pages. Default: true
artifact_ocr_enabled: true

# OCR provider: "llm" (Claude via Bedrock) or "textract". Default: llm
artifact_ocr_provider: llm

# Maximum pages to OCR per run (0 = unlimited). Default: 50
artifact_ocr_max_pages: 50

# Video transcription — disabled by default (requires S3 bucket for temporary upload)
artifact_transcription_enabled: false
artifact_transcribe_s3_bucket: ""
```

## AWS Bedrock Requirements

### Models Used

| Component       | Model             | Purpose                                         |
| --------------- | ----------------- | ----------------------------------------------- |
| File Summarizer | Claude Haiku 4.5  | Fast parallel file and artifact summarization   |
| Orchestrator    | Claude Sonnet 4.6 | Agent-based query routing and answer generation |
| File Identifier | Claude Haiku 4.5  | Quick relevant file/artifact selection          |

### Required AWS Permissions

- `bedrock:InvokeModel` for all model IDs in config
- Model access enabled in AWS Bedrock console for all regions
- (Optional) `textract:DetectDocumentText` if using Textract OCR
- (Optional) for video transcription: `transcribe:StartTranscriptionJob`, `transcribe:GetTranscriptionJob` and `transcribe:DeleteTranscriptionJob`, plus `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` scoped to the transcription bucket and prefix (for example `arn:aws:s3:::<bucket>/<prefix>/*`). IRIS uploads each video, polls the job, then deletes the object and the job; without the `Get` and `Delete` permissions the poll fails and the uploaded video stays in the bucket. These actions are outside the least-privilege template, so `check_permission_scope.py` reports the profile as broader than inference; that is expected when transcription is enabled. Add an S3 lifecycle rule that expires objects under the prefix, so a failed run cannot leave repository video behind.

### Performance Tips

**Codebase Indexing:**

- Add 3-10 model-region pairs to `file_summarizer.models` for faster indexing
- More pairs = faster parallel processing
- Typical times: 50 files (~2 min), 500 files (~10 min), 5000 files (~60 min)

**Artifact Indexing:**

- Artifact extraction is parallelized with `artifact_max_workers` (default: 4)
- LLM summarization reuses the `file_summarizer` model pool
- OCR adds ~2-5 seconds per image-only PDF page
- Video transcription: billed per minute of audio at Amazon Transcribe rates (current prices by Region: https://aws.amazon.com/transcribe/pricing/); takes about 10-15 minutes per hour of video

**Q&A:**

- Typical query time: 10-20 seconds
- File/artifact identification: 2-5 seconds
- Response generation: 5-15 seconds

## Common Issues & Solutions

| Issue                            | Solution                                                                |
| -------------------------------- | ----------------------------------------------------------------------- |
| `Config file not found`          | Run `inq_config_setup.sh` first                                         |
| `Virtual environment not found`  | Ensure `.venv_lb` exists with package installed                         |
| `codebase_dir not specified`     | Set `codebase_dir` in config to absolute path                           |
| `No codebase overview available` | Run indexing with `--mode codebase` first                               |
| `No artifact overview available` | Ensure `artifact_dir` is set, run indexing with `--mode artifact`       |
| `No supported artifacts found`   | Check file extensions match supported formats                           |
| `AWS credentials not found`      | Configure AWS CLI: `aws configure`                                      |
| `Model access denied`            | Request model access in AWS Bedrock console                             |
| `Indexing takes too long`        | Add more model-region pairs to config                                   |
| `MCP server not responding`      | Check timeout setting, verify config path                               |
| `OCR not working`                | Set `artifact_ocr_enabled: true`, check Bedrock/Textract permissions    |
| `Video transcription fails`      | Check S3 bucket, Transcribe permissions, and region config              |
| `Context window overflow`        | Router selects only relevant artifacts; reduce artifact count if needed |

## Verification Commands

**Check if config exists:**

```bash
cat {codebase_dir}/.lb_workspace/indexing_and_qa/inq_config.yaml
```

**Check if codebase is indexed:**

```bash
ls {codebase_dir}/.lb_workspace/indexing_and_qa/{codebase_name}/codebase_overview.json
```

**Check if artifacts are indexed:**

```bash
ls {codebase_dir}/.lb_workspace/indexing_and_qa/{codebase_name}/artifact_overview.json
```

**Check extracted artifacts:**

```bash
ls {codebase_dir}/.lb_workspace/indexing_and_qa/{codebase_name}/extracted_artifacts/
```

**Check indexing logs:**

```bash
tail -f {codebase_dir}/.lb_workspace/indexing_and_qa/{codebase_name}/logs/*.log
```

**Test AWS access:**

```bash
aws bedrock list-foundation-models --region us-west-2
```

**Check the MCP servers' local files:**

```bash
python3 -I {codebase_dir}/<skills folder>/lb-setup/scripts/lb_guard.py check {codebase_dir}
```

**Check MCP config:**

```bash
cat {codebase_dir}/.kiro/settings/mcp.json
```
