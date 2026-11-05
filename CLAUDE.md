<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

@AGENTS.md

# LaunchBridge

Read `agent_steering/AGENTS.md` for full project context, skill descriptions, and cross-skill workflows.

## Skills

Skills are in `skills/`. Each subdirectory has a `SKILL.md` with detailed instructions. Load a skill when its description matches the user's request.

The optional **AI skills** come from the public `ai-skills` git submodule at `project_dependencies/ai-skills` ([aws-samples/sample-ai-skills](https://github.com/aws-samples/sample-ai-skills), v0.3.4) and are offered by the installer as the **AI Spec-Driven Development** bundle (`ai-create`, `ai-research`, `ai-plan`, `ai-implement`, `ai-archive`). The library's `ai-release` skill is not offered. The native **`ai-workflow`** skill (in `skills/`) orchestrates the SDD skills and is bundled with AI Spec-Driven Development. AI skills need no `lb-setup`, MCP, or `.venv_lb`. See `agent_steering/AGENTS.md` (`## AI Skills`).

## Key Conventions

- All skill artifacts go under `.lb_workspace/` (gitignored).
- The metric library and ai-skills are git submodules under `project_dependencies/` (`metric-library`, `ai-skills`; metric-library is the public [aws-samples/sample-metric-library](https://github.com/aws-samples/sample-metric-library) repo, ai-skills the public `sample-ai-skills` repo, skills under `skills/<domain>/<skill>/`).
- After cloning: `git submodule update --init --recursive`.
