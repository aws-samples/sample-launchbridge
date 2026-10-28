<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

@AGENTS.md

# LaunchBridge

Read `agent_steering/AGENTS.md` for full project context, skill descriptions, and cross-skill workflows.

## Skills

Skills are in `skills/`. Each subdirectory has a `SKILL.md` with detailed instructions. Load a skill when its description matches the user's request.

The optional **AI skills** come from the public `ai-skills` git submodule at `project_dependencies/ai-skills` ([aws-samples/sample-ai-skills](https://github.com/aws-samples/sample-ai-skills), v0.6.2) and are offered by the installer as one bundle per upstream domain: **AI Spec-Driven Development** (`ai-create`, `ai-research`, `ai-plan`, `ai-implement`, `ai-archive`), **AI Architecture Decisions** (`ai-adr`), **AI Agent Context** (`ai-agent-context`, `ai-scaffold-agents-md`, `ai-make-skill`), **AI Development Process** (`ai-scaffold-dev-context`, `ai-scaffold-dev-templates`, `ai-dev-issue`, `ai-dev-autopr`), **AI Prose Documents** (`ai-human-outline`, `ai-human-draft`, `ai-human-docx`, `ai-human-pdf`, `ai-human-xlsx`) and **AI Software Documentation** (`ai-doc`, `ai-scaffold-docusaurus-site`). The library's `release` domain (`ai-scaffold-release`) is not offered. Claude Code gets each skill as published; every other agent gets its own `SKILL.md`, built at install time the way the ai-skills installer builds it for Kiro, Codex and pi (`adaptSkillMd` in `install_script/lib/aiSkills.js`): Codex's also comes with `agents/openai.yaml` for an explicit-only skill, and Cline, Roo Code and other agents get the Kiro form, naming the agent. The native **`ai-workflow`** skill (in `skills/`) orchestrates the SDD skills and is bundled with AI Spec-Driven Development. AI skills need no `lb-setup`, MCP, or `.venv_lb`; `ai-human-docx`, `ai-human-pdf` and `ai-human-xlsx` need `uv`, which downloads Python 3.14 and their pinned packages on first use. See `agent_steering/AGENTS.md` (`## AI Skills`).

## Key Conventions

- All skill artifacts go under `.lb_workspace/` (gitignored).
- The metric library and ai-skills are git submodules under `project_dependencies/` (`metric-library`, `ai-skills`; metric-library is the public [aws-samples/sample-metric-library](https://github.com/aws-samples/sample-metric-library) repo, ai-skills the public `sample-ai-skills` repo, skills under `skills/<domain>/<skill>/`).
- After cloning: `git submodule update --init --recursive`.
