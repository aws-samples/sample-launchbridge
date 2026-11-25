<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# LaunchBridge Skills User Guide

This guide covers every skill in the LaunchBridge suite — what it does, how to configure it, how to invoke it, and how to combine skills for real-world workflows. The goal is to help you evolve a delivered codebase from proof-of-concept to a feature-rich, secure, production-ready system using AI-assisted development.

> **New to LaunchBridge?** Start with [README.md](../README.md) for installation instructions, system requirements, and how to run the CLI installer. This guide picks up from where installation ends — it assumes LaunchBridge is already installed in your target codebase.

---

## Table of Contents

1. [Overview](#overview)
2. [Post-Installation Configuration](#post-installation-configuration)
   - [Global or Local Install](#global-or-local-install)
   - [Updating LaunchBridge](#updating-launchbridge)
   - [Changing Skills or Agents](#changing-skills-or-agents)
   - [Platform Support](#platform-support)
   - [Attributing Agent Changes](#attributing-agent-changes)
3. [Skills Reference](#skills-reference)
   - [lb-setup](#lb-setup)
   - [indexing-and-qa](#indexing-and-qa)
   - [code-guardrails](#code-guardrails)
   - [config-prompt-registry](#config-prompt-registry)
   - [testing-framework](#testing-framework)
   - [data-wrangler](#data-wrangler)
   - [generate-predictions](#generate-predictions)
   - [evaluate-predictions](#evaluate-predictions)
   - [comparative-metric-analysis](#comparative-metric-analysis)
   - [operational-metrics](#operational-metrics)
   - [feature-recommendations](#feature-recommendations)
4. [AI Skills (optional add-on)](#ai-skills-optional-add-on)
5. [Workflows & Use Cases](#workflows--use-cases)
   - [Onboarding onto an unfamiliar codebase](#1-onboarding-onto-an-unfamiliar-codebase)
   - [Baseline evaluation of a delivered system](#2-baseline-evaluation-of-a-delivered-system)
   - [Model upgrade with measured impact](#3-model-upgrade-with-measured-impact)
   - [Cost and latency profiling](#4-cost-and-latency-profiling)
   - [Adding tests and improving coverage](#5-adding-tests-and-improving-coverage)
   - [Production readiness assessment](#6-production-readiness-assessment)
   - [Full lifecycle: POC to production](#7-full-lifecycle-poc-to-production)
6. [Artifact Reference](#artifact-reference)

---

## Overview

LaunchBridge is a suite of AI agent skills that install alongside any codebase. Once installed, they give your coding agent persistent understanding of the project and a full set of tools to run, evaluate, govern, and improve it — without re-explaining the codebase every session.

All skill artifacts are written to `.lb_workspace/` (gitignored), keeping the target codebase clean.

> **Note on using `/skill-name` prefixes:** The `/skill-name` prefix (e.g., `/indexing-and-qa`, `/generate-predictions`) is optional. The agent will automatically route to the right skill based on the intent of your prompt. Using the prefix makes the response more predictable by explicitly activating a specific skill — recommended when you want deterministic behavior or are learning which skill handles what. Without the prefix, the agent may also blend multiple skills or use its own built-in tools depending on the question type.

```
Skills:
  lb-setup               → one-shot initialization of all skills
  indexing-and-qa        → codebase & artifact Q&A (foundation)
  code-guardrails        → governance files for agent alignment
  config-prompt-registry → single source of truth for configs & prompts
  testing-framework      → test discovery, creation, and execution
  data-wrangler          → test data preparation and generation
  generate-predictions   → run the repo's model against a dataset
  evaluate-predictions   → score predictions against ground truth
  comparative-metric-analysis → compare metrics across runs (trends, variants, drift)
  operational-metrics    → cost and latency profiling
  feature-recommendations → production readiness & feature roadmap
```

> **Optional AI skills add-on:** Beyond the native skills above, the installer can also add skills from the open-source **ai-skills** library: one bundle per domain, such as **AI Spec-Driven Development** (`/ai-create → /ai-research → /ai-plan → /ai-implement → /ai-archive` + the `ai-workflow` orchestrator), **AI Architecture Decisions**, **AI Agent Context**, **AI Development Process**, **AI Prose Documents** and **AI Software Documentation**. They are agent-agnostic, need no `lb-setup`/AWS/`.venv_lb`, and are covered in [AI Skills (optional add-on)](#ai-skills-optional-add-on) below.

---

## Post-Installation Configuration

This section covers what to verify and configure after running the `launchbridge` CLI installer. For system requirements and installation steps, see [README.md](../README.md).

### Global or Local Install

After you select the agents, the installer asks where to install the skills:

- **Global** (the default) puts the skills in each agent's user-level skills folder, where the agent finds them in every project. The folder you run `launchbridge` from is not changed, so you can run it from anywhere. The first time you run `lb-setup` in a project, it creates `.lb_workspace/` and `.venv_lb` there, after checking that the folder is safe to prepare.
- **Local** puts the skills in the current repository's agent folders and creates `.lb_workspace/` there straight away, as earlier versions did. Choose it when the repository should carry its own skills, for example a delivered codebase that the client keeps using. Anyone who also has a global install for Claude Code or Cline gets the global skills there instead (see **Both installs in one repository** below). In a folder that already has a local install, the agents are pre-selected from it and Local is the default, so a re-run there updates that install.

| Agent       | Global skills folder | Local skills folder |
| ----------- | -------------------- | ------------------- |
| Claude Code | `~/.claude/skills/`  | `.claude/skills/`   |
| Kiro        | `~/.kiro/skills/`    | `.kiro/skills/`     |
| Cline       | `~/.cline/skills/`   | `.cline/skills/`    |
| Roo Code    | `~/.roo/skills/`     | `.roo/skills/`      |
| Codex       | `~/.agents/skills/`  | `.codex/skills/`    |
| Pi          | `~/.agents/skills/`  | `.agents/skills/`   |
| Other       | `~/.agents/skills/`  | `.agents/skills/`   |

On Windows, `~` is your user profile folder (`%USERPROFILE%`). Codex reads user-level skills from `~/.agents/skills/`, not `~/.codex/skills/`.

**What a global install writes.** The installer writes only outside your repositories:

- the skills, in the folders above: copies, or in a symlink install a link from each skill folder to its folder in the LaunchBridge clone (an AI skill is copied for any agent that gets its own `SKILL.md` for it);
- the global install record (version, agents, method, selected skills and every digest) in `~/.config/launchbridge/global/`, or under `$XDG_CONFIG_HOME` when that is an absolute path;
- beside the record, in `generated/`, the files `lb-setup` prepares each project from: the Python dependency files for the skills you selected (`python_deps/pyproject.toml` and `constraints.txt`), a `setup_status.md` template, the list of workspace folders, and a copy of the LaunchBridge `AGENTS.md` reference. They depend only on the skills you selected, so every agent's `lb-setup` uses this one copy.

**An install that did not finish.** Just before a global install replaces or creates a skill folder, it lists that folder in `pending.json`, beside the record. Once the record is written, the file keeps only the folders the install did not finish, and is removed when there are none. A global install stops without installing anything when it can't write there, or can't read a `pending.json` that is there. If the installer is interrupted, or can't write the record (it then exits 1), run `launchbridge` again, choose Global and select the same agents and skills: it treats the folders listed in `pending.json` as LaunchBridge's, so it replaces them, a half-copied one included, even with `--yes`, and records them. Folders of agents or skills that run does not select stay listed, and it names them. Until then, `lb-setup` says there is no global install record, or refuses the `lb-setup` of an agent whose folders the stopped run was installing. A new skill folder whose copy fails is removed rather than left half-copied.

When `lb-setup` first runs in a project, its `bootstrap_workspace.py` refuses the home folder, a folder above it, the file system root, an agent's own folder in your home folder (`~/.claude`, `~/.codex`, `~/.kiro`, `~/.cline`, `~/.roo`, `~/.agents`) or a folder inside one, the LaunchBridge source and the skills folders themselves, and a project that has a local install. It also refuses any LaunchBridge path reached through a symbolic link, and any file git tracks where LaunchBridge runs from. It checks the generated files against the global record, then creates `.lb_workspace/` (with `setup_status.md`, `config/python_deps/` and `config/lb_agents_reference.md`), `.project_artifacts/`, `AGENTS.md` (or, beside an existing one, `.lb_workspace/steering/AGENTS_LB.md` to merge) and `@AGENTS.md` in `CLAUDE.md`. It never writes through a linked `AGENTS.md` or `CLAUDE.md`. Then setup continues as for a local install: `lb-setup` builds and seals `.venv_lb`, configures the MCP servers, and so on.

Whichever install it comes from, `lb-setup` stops in a folder that is not a project (the home folder, a folder above it, the file system root, or an agent's own folder or a folder inside one) and says to open the project's own folder. If `bootstrap_workspace.py` can't read or write a file or folder, `lb-setup` names it and stops; fix that and run `lb-setup` again, and it finishes what the bootstrap began.

**Shared `~/.agents/skills/`.** In a global install, Codex, Pi and other agents share one folder, which holds one copy of each AI skill. That copy is the form of the first of them you select, in the order Codex, Pi, Other, and the installer warns which form the others read. Native LaunchBridge skills are the same for every agent.

**Linked skills folders.** A global skills folder may be reached through a link (for example a `~/.claude` kept in a dotfiles repository), but two selected agents' folders must not be one folder through a link, such as a `~/.kiro/skills` linked to `~/.claude/skills`: the installer refuses and writes nothing. Select one of those agents (the other reads the same skills through the link), or make the folders separate.

**Both installs in one repository.** Keep one install for each repository. Where a repository has a local install and you also have a global one, Claude Code and Cline run the global (personal) skills, and Kiro and Roo Code run the repository's own. The global install's `lb-setup` refuses to prepare a repository that has a local install (`.lb_workspace/config/version_manifest.json`), since it would overwrite that install's setup. So a global install for Claude Code or Cline doesn't combine with a local install you use from those agents: set the repository up with Kiro or Roo Code when its local install is for one of them (the refusal says whether it is), or remove one of the two installs. The installer warns when you install globally from a folder that has a local install, with or without `--scope global`, or locally while a global install exists.

- To move a repository the global install's `lb-setup` prepared to a local install, run `launchbridge --scope local` in it. The installer says it is switching the repository and keeps the setup done there, except that `lb-setup` builds `.venv_lb` again when the Python dependencies change, and walks you through merging `.lb_workspace/steering/AGENTS_LB.md` when the installer stages one. While the global install exists, Claude Code and Cline still run its skills there, and its `lb-setup` refuses the repository now that it has a local install, so run `lb-setup` from Kiro or Roo Code (with the local install for one of them), or remove the global install first.
- To remove a local install, delete the skill folders it installed (`installedTargets` in `.lb_workspace/config/version_manifest.json` lists them, relative to the repository) and then that file. The rest of `.lb_workspace/` holds the repository's own setup; the global install's `lb-setup` takes it over.
- To remove the global install, delete the skill folders it installed (`installedTargets` in `~/.config/launchbridge/global/manifest.json` lists them, relative to your home folder, and after an install that did not finish `pending.json` beside it lists those it did not finish) and then the `~/.config/launchbridge/global/` folder. Without that record, `launchbridge update` leaves the agents' folders alone.

**Integrity.** For a global install, `verify_integrity.py --global "<project>"` checks the skills in your home folders and lb-setup's generated files against the global record; `lb-setup` runs it on every run. When it finds a difference, it says how to fix each kind: missing skills and generated files are restored by `launchbridge update` (except a skill the clone has uncommitted changes to, which waits until they are committed or discarded, and a whole skills folder that is gone, which needs `launchbridge` again with Global); a modified copy needs `launchbridge` again with Global; a modified skill reached through a link is a change in the LaunchBridge clone itself, to check with `git -C <clone> status`. There is no `skill_digests.json` to commit for a global install: the record changes only through `launchbridge` and `launchbridge update`, and `launchbridge update` never records uncommitted changes in the clone, to a skill or to the files the generated files are built from.

### AWS Credentials at Runtime

The `lb-setup` skill writes your selected AWS credentials configuration to `.lb_workspace/config/lb_env` during setup:

```
AWS_AUTH_METHOD=<aws_profile|iam_instance_profile|container_role|env_vars>
AWS_PROFILE=<your-profile>  # only set when AWS_AUTH_METHOD=aws_profile
codebase_abs_path=<your-codebase-path>
```

`lb-setup` auto-detects credentials where possible. If it can't detect them, it prompts you to choose:

| Method                 | When to use                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| `aws_profile`          | Local dev with a named profile in `~/.aws/credentials` or `~/.aws/config`     |
| `iam_instance_profile` | EC2 instance with an attached IAM role                                        |
| `container_role`       | ECS, Fargate, or CodeBuild with a task role                                   |
| `env_vars`             | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` set directly in the environment |

For `aws_profile`, export the profile before running skills:

```bash
if [ -f .lb_workspace/config/lb_env ]; then
  p=$(grep '^AWS_PROFILE=' .lb_workspace/config/lb_env | cut -d= -f2-)
  if [ -n "$p" ]; then export AWS_PROFILE="$p"; fi
else
  echo "lb_env not found - run lb-setup first; AWS_PROFILE left unchanged" >&2
fi
```

Avoid the shorter `export $(grep AWS_PROFILE … | xargs)` form.
If `lb_env` is missing, it runs a bare `export`, which prints your entire shell
environment, credentials included.

For all other methods, no export is needed — credentials are picked up automatically from the environment or metadata service.

If you encounter AWS errors (auth failures, access denied), verify:

1. The auth method in `.lb_workspace/config/lb_env` matches your environment
2. For `aws_profile`: the profile exists in `~/.aws/credentials` or `~/.aws/config`
3. The IAM role or profile has permissions for Bedrock (and any other services used)
4. Bedrock model access is enabled in your account for the configured region

> **Note:** If you move the workspace to a new machine (for example, a fresh clone of the target repository), `lb-setup` will re-validate credentials on startup and prompt you to re-configure if they no longer work. It also detects if the codebase path has changed and resets the affected skills automatically.

### Amazon Bedrock Spend and Logging

The indexing and prompt skills send repository content to Amazon Bedrock under your AWS profile. Two account-level controls are worth setting before the first full index:

- **An AWS Budgets alarm** with a Bedrock service filter. Bedrock has no per-request spend limit, and `indexing-and-qa` refuses an unbounded run (a ceiling of `0`) unless it is started with `--allow-unbounded`; the alarm is the backstop for that case.
- **Bedrock model invocation logging** (Bedrock console → Settings, or `aws bedrock put-model-invocation-logging-configuration`) to CloudWatch Logs or Amazon S3, so you can audit which models were called, when, and with what. The logs contain the prompts, which include repository content: keep them in the same account, encrypt them, and restrict who can read them the way you would the repository itself.

### Recommended Agent Permissions

LaunchBridge skills read repository content that nobody reviewed for this purpose, and an answer built from it can contain text written to look like instructions. The skills tell the agent to treat that content as data, but that is a convention, not an enforcement layer. Running the coding agent in a supervised configuration adds one: the agent asks before it runs a shell command, fetches from the network or calls a tool, and stays inside the project directory.

These settings are recommendations; LaunchBridge does not apply them. Put them in your **user-level** settings rather than in files inside the repository, which the repository itself could change.

They also cover LaunchBridge's consent flags. `--confirm-data-handling`, `--artifact-classification`, `--allow-unbounded`, `check_permission_scope.py --acknowledge`, `verify_integrity.py --write-baseline` (accepts the installed skills as the new baseline) and `run_tests.py --allow-make` (lets the testing skill run your project's `make test`) record a decision that is yours to make: the skills tell the agent to pass them only after you agree in chat, and nothing in the scripts can tell who passed them. With shell commands set to ask, you see each command, including any of these flags, and approve it before it runs.

**What changes for LaunchBridge.** Every skill still works. You approve more steps: `lb-setup`, indexing and testing each run several shell commands, and each one asks first. Runs that would prompt cannot run unattended (`claude -p`, CI, Kiro headless), so keep any scripted use in its own, deliberately looser configuration. Keep the LaunchBridge MCP servers' tools allowed, or every Q&A query will prompt. `lb-setup` lists your profiles with `aws configure list-profiles`, which prints only profile names, and detects a profile's type with `aws configure get <key>`, discarding the output and using only whether the key is set. So it needs no read access to `~/.aws/config` or `~/.aws/credentials`; deny both, since either can hold access keys. `aws configure get` itself prints whatever value it is asked for, `aws_secret_access_key` included, so keep it under "ask" rather than adding it (for example `Bash(aws configure get:*)`) to your allow list.

**Claude Code** — `~/.claude/settings.json` (or managed settings for a team):

```json
{
  "permissions": {
    "defaultMode": "default",
    "ask": ["Bash", "WebFetch", "WebSearch"],
    "deny": [
      "Read(~/.aws/credentials)",
      "Read(~/.aws/config)",
      "Read(~/.ssh/**)",
      "Read(**/.env)",
      "Read(**/*.pem)"
    ],
    "allow": [
      "mcp__launchbridge-qa-server",
      "mcp__aws-documentation-mcp-server"
    ]
  }
}
```

`default` is the supervised mode; avoid `acceptEdits`, `auto`, `dontAsk` and `bypassPermissions` for untrusted repositories. Rules are evaluated deny, then ask, then allow. Don't add `additionalDirectories`. See the [permissions documentation](https://code.claude.com/docs/en/permissions).

**Kiro** — in the IDE, set Settings → Agent → Agent Autonomy to **Supervised**. For both IDE and CLI, add `~/.kiro/settings/permissions.yaml`:

```yaml
rules:
  - capability: shell
    match: ["*"]
    effect: ask
  - capability: fs_write
    match: ["**"]
    effect: ask
  - capability: web_fetch
    match: ["*"]
    effect: ask
  - capability: mcp
    match: ["*"]
    effect: ask
```

Avoid Autopilot and the CLI's `--trust-all-tools` / `/acceptall`. Kiro has no local sandbox for shell commands, so these prompts are the boundary. See [Kiro permissions](https://kiro.dev/docs/permissions/).

**Codex** — `~/.codex/config.toml`:

```toml
sandbox_mode = "workspace-write"
web_search = "disabled"

[sandbox_workspace_write]
network_access = false

[projects."/absolute/path/to/your/repo"]
trust_level = "untrusted"
```

Marking the project untrusted (and leaving `approval_policy` unset) makes every command ask; `approval_policy = "on-request"` instead lets commands the sandbox allows run without asking. Avoid `--yolo` / `--dangerously-bypass-approvals-and-sandbox`, `--sandbox danger-full-access` and `-a never`. See the [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security) documentation.

**Cline** — in the auto-approve settings, leave every _Edit_, _Execute_, _Use the browser_ and _Use MCP servers_ toggle off, and leave _Read all files_ off so files outside the workspace need approval. Keep _YOLO Mode_ (Settings → Features) unchecked, and `"autoApprove": []` for each server in `cline_mcp_settings.json`. Cline has no sandbox. See [Cline auto-approve](https://docs.cline.bot/features/auto-approve).

**Roo Code** — turn auto-approve off (the _Enabled_ toggle in the auto-approve menu by the chat input, or _None_), keep `roo-cline.allowedCommands` empty, and keep `"alwaysAllow": []` for each MCP server. Roo Code has no sandbox. See [Roo Code auto-approving actions](https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions).

**Pi** — Pi does not ask before tool calls and has no built-in sandbox. Approval comes from an extension that gates tool calls (see `examples/extensions/permission-gate.ts` and the tool-call gate in the extensions documentation of the [Pi repository](https://github.com/earendil-works/pi)), and isolation from its sandbox extension or from running Pi in a container. Without those, Pi is not suitable for an untrusted repository.

### Python Environments

LaunchBridge uses two separate Python environments in the target codebase:

| Environment  | Purpose                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `.venv_lb`   | Reserved for LaunchBridge skills — created and managed by `lb-setup`       |
| `.venv_repo` | Your project's own environment — used for running tests, predictions, etc. |

`.venv_lb` is created by `lb-setup` during initialization (Step 0b) using `uv`, which automatically downloads the required Python version from `pyproject.toml` — the host machine does not need that Python version pre-installed. If the venv is missing or the codebase has moved to a new machine, `lb-setup` will recreate it automatically. `.venv_repo` is created automatically by the skills if it doesn't exist.

### MCP Servers

The following MCP servers are configured automatically during `lb-setup`. If a skill reports a tool as unavailable, reconnect MCP servers from the Kiro MCP panel:

| Server                         | Used by                                      |
| ------------------------------ | -------------------------------------------- |
| `launchbridge-qa-server`       | indexing-and-qa                              |
| `aws-documentation-mcp-server` | operational-metrics, feature-recommendations |

All MCP servers are pre-installed into `.venv_lb` during setup — they launch instantly without network downloads at startup.

Both servers run on your machine as your user, over stdio, without a sandbox: they can read and write whatever your account can, and reach the network. LaunchBridge's guard checks `.venv_lb` and the repository's LaunchBridge files before it starts each one, but it doesn't confine them. `launchbridge-qa-server` runs with your AWS credentials, which it needs to call Bedrock. `aws-documentation-mcp-server` fetches public AWS documentation and makes no AWS API call, so the guard starts it without your `AWS_*` environment variables (keys, session token, profile); it can still read files your account can read, such as `~/.aws/`. If you need stronger isolation, run your coding agent in a container or a separate user account.

### Non-Interactive CLI Flags

The `launchbridge` installer supports CLI flags for scripted or non-interactive use:

```bash
launchbridge --scope global --skills all --agent kiro --method copy --yes
```

| Flag                     | Effect                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--skills <list>`        | Comma-separated skill names, category names, or `all` — skips skill selection prompt                                                                                                                                                                                                                                        |
| `--agent <list>`         | Comma-separated agent names (e.g., `kiro`, `claude`) — skips agent selection prompt                                                                                                                                                                                                                                         |
| `--scope global\|local`  | Skips the scope prompt (see [Global or Local Install](#global-or-local-install)). Without it, `--yes` takes the prompt's default: Local in a folder that already has a local install, which it updates, and Global anywhere else. Pass `--scope local` to install into the current repository as earlier versions did       |
| `--method copy\|symlink` | Skips method selection prompt                                                                                                                                                                                                                                                                                               |
| `--yes` / `-y`           | Auto-confirm everything. Replaces skills LaunchBridge installed before; an existing directory it did not install is left unchanged and reported. Skills no longer selected are listed and left in place, still recorded as LaunchBridge's while they hold what it installed; the next interactive run offers to remove them |

When all flags are provided, the installer runs fully non-interactively. Useful for CI pipelines and scripted setups; a script that expects a local install passes `--scope local`.

A flag's value can also follow `=` (`--scope=local`). An unknown argument, or a flag with no value (a trailing `--scope`, or `--scope ""` from an unset variable), stops the installer with an error and exit code 1 before it changes anything. `update` works only as the first argument: `launchbridge update`.

### Updating LaunchBridge

If LaunchBridge was installed via git clone, you can pull the latest changes and sync your skills in one command. For a global install, run it from any folder; for a local install, run it from the **target project folder** (the repo where LaunchBridge is installed). It updates both when you have both. A global install is updated only from the LaunchBridge clone it was installed from: run from any other clone, the command leaves it as it is and names that clone. To move the global install to the clone you are in, run `launchbridge` from it and choose Global.

```bash
launchbridge update
```

First, it fetches the latest changes from the LaunchBridge remote repository, shows the incoming commits and what they change (skill instructions, installer files, submodule pointers), and applies them only after you confirm — the prompt defaults to no. For scripted use, review the preview first, then run `launchbridge update --apply <commit>` with the commit it showed; the update is applied only if it still ends there. `--yes` alone does not apply an update. Only a fast-forward is applied; diverged history is refused. The command follows the branch the clone is on; on a checked-out release tag (a detached HEAD) it stops and shows the tag-based steps in [Updating LaunchBridge](../README.md#updating-launchbridge) instead.

Then, for a global install, it:

1. In a copy install, installs again every skill whose content changed, where its copy still holds what LaunchBridge installed, and any recorded skill folder that is missing. In a symlink install each skill folder is a link to the clone, so it already holds the new content; a missing link, or one that points elsewhere, is linked again, and so is a skill folder an older LaunchBridge made of one link per file, when it holds nothing else. An agent's skills folder that is gone as a whole (you removed the agent, say) is not made again; it says so.
2. Leaves as it is, with a warning, a skill folder that differs from what LaunchBridge installed: in a copy install, an edited copy, or one holding files of yours, whether or not the skill changed; in a symlink install, a real folder, or one holding files LaunchBridge did not install, where a link should be. To replace it, run `launchbridge` again and choose Global.
3. Keeps a skill at the version the global record has, with a warning, while the LaunchBridge clone has changes to it that are not committed: files in the skill's folder that are modified, added, deleted, untracked, ignored, or marked for git not to check (assume-unchanged or skip-worktree), the skill's folder in the clone being a link, or the submodule holding it checked out at a different commit than the clone records. It copies nothing for that skill and makes none of its links again; in a symlink install its links already show the changes, so the warning says agents load them and that `lb-setup`'s integrity check reports the skill until you deal with them. Commit or discard them (`git -C <clone> status`), or, to install the skill as it is, run `launchbridge` again and choose Global. The generated files are kept the same way while `agent_steering/AGENTS.md`, `project_dependencies/pyproject.toml` or `constraints.txt`, which they are built from, have such changes. When git can't tell (it fails, or isn't installed), nothing new is taken from the clone.
4. Regenerates the files in `~/.config/launchbridge/global/generated/` (for example when the frozen dependency set changed) and rewrites the global record with what it installed. A skill it kept back or could not update keeps its recorded digest, and the generated files keep theirs when they were kept back or could not be written, so the next update tries again. The preview you confirmed is the review step for what the update fetched: the new record is the baseline from then on. Commits that reach the clone another way (your own, or a `git pull`) are recorded without a preview.
5. Leaves your repositories alone. Each one picks up the change the next time `lb-setup` runs in it: the rows of changed skills go back to `not started`, `venv-setup` is reset when the dependencies changed, and the new `AGENTS.md` reference is staged for merging.

Skills that are new in LaunchBridge are not added; run `launchbridge` again and choose Global to select them. A skill folder you kept when you deselected its skill is not updated either.

For a local install in the current folder, it then:

1. Re-copies any skills whose content changed (copy installs only — a symlink install's skill folders are links to the clone; one an older LaunchBridge made of one link per file is linked again as a whole, unless it also holds files LaunchBridge did not install: that one is left as it is, with a warning, until you run `launchbridge` in the project and choose Local). If a path it would write in `.lb_workspace/` is a symbolic link, it skips the local install and says so; the global install is still updated.
2. Regenerates the Python dependency config if dependencies changed.
3. Updates the version manifest. The tracked digest baseline is left as it was (or created from the pre-update digests), so lb-setup holds back changed skills until you review them and refresh it with `verify_integrity.py --write-baseline`.

The integrity check (`verify_integrity.py`) detects drift after installation; it doesn't authenticate a change. A commit that changes a skill together with `.lb_workspace/config/skill_digests.json` passes it, so review any diff to the baseline, and to the agents' skills folders, as code. Better still, don't commit the skills folders (`.claude/skills/` and the others): whoever controls them controls your agent's instructions.

The skills' Python scripts also run from those folders, with your AWS credentials, and import the files beside them. A pulled commit can add a file there (a `json.py` beside a script) whether or not you commit the skills folders: git writes a new tracked file into your local install. Before it starts Python, LaunchBridge's guard checks what git tracks in the skill folder it is about to run from. If git tracks files Python can import there but not the skill's `SKILL.md`, a pull added them to your local install, and the guard refuses to start (`lb_guard: not starting Python`). If git tracks the skill's `SKILL.md` as well, because your team commits whole skills folders, it warns (`LaunchBridge warning: this Python may import files that came with the repository`) and starts. Bytecode (`.pyc`) that git tracks outside `__pycache__` is refused either way: Python would run it with no source to review, and LaunchBridge ships none. `verify_integrity.py` also reports such a file, and removes it. Treat that warning, and any change to those folders in a pull, as code to review, or keep the folders out of git (`git rm --cached`) and re-run the installer. If your `.gitignore` covers the skills folders, git overwrites ignored files without asking, so a pull could also replace a skill's `SKILL.md` and get only the warning; run `verify_integrity.py` after pulling.

> **Note:** The update command needs the LaunchBridge clone's `.git` folder. LaunchBridge is distributed only as a git repository; if your copy has no `.git` folder (for example, a downloaded archive), clone the repository again and re-run the installer.

When nothing new was fetched, the command reports "Already up to date" and pulls nothing, but it still brings your installs up to date with the clone as described above (it restores a missing skill, for example).

It exits 1 when it could not bring every install up to date: it had to skip a skills folder, could not replace a skill folder or write the generated files, could not check the clone for changes that are not committed, or skipped the local install; the warnings before the closing message say which. Keeping a skill or the generated files back, leaving a folder as it is (or a skills folder that is gone), and leaving a global install from another clone as it is don't count as failures.

**Why the update asks first.** Nothing between the remote and your agent authenticates the content: pulled `SKILL.md` files become the instructions your agent follows, and pulled scripts run with your AWS credentials. Read the preview, and read the diff (`git -C <launchbridge> diff <from> <to>`) for anything highlighted, before accepting it. For a release, also verify its signed tag (see [Verifying a release](../README.md#verifying-a-release)).

`launchbridge update` keeps the skill and agent selection from your last install. To change it as part of an upgrade, `git pull` (or check out the new release tag) in your LaunchBridge clone, then run `launchbridge` again and select the new set: in your project, choosing Local, for a local install, or from any folder, choosing Global, for a global one; see [Changing Skills or Agents](#changing-skills-or-agents).

After updating, run `lb-setup` in your agent to apply any skill changes.

### Changing Skills or Agents

For a local install, re-run `launchbridge` in your project, choose Local (the default in a folder with a local install, or pass `--scope local`), and change the selection. The installer compares each skill's content hash with the version manifest (`.lb_workspace/config/version_manifest.json`) and changes only what differs; `setup_status.md` then tells lb-setup what to configure on its next run.

For a global install, re-run `launchbridge` from any folder and choose Global: the installer compares against the global record instead, and each repository's `setup_status.md` is updated the next time `lb-setup` runs there (new skills `not started` or `ready`, removed ones `not installed`). The table below describes both; for a global install, read "skills directory" as the global folder in [Global or Local Install](#global-or-local-install).

| You select                                                        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status in `setup_status.md`                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A new skill                                                       | Installed into each selected agent's skills directory                                                                                                                                                                                                                                                                                                                                                                                           | `not started`; configured on the next lb-setup             |
| An installed skill whose files changed (new LaunchBridge version) | Reinstalled                                                                                                                                                                                                                                                                                                                                                                                                                                     | Reset to `not started`; re-configured on the next lb-setup |
| An installed skill whose files are unchanged                      | Skipped                                                                                                                                                                                                                                                                                                                                                                                                                                         | Kept (for example `complete`)                              |
| A skill you no longer select                                      | Listed as an orphan. An interactive run asks whether to remove its directory; `--yes` never removes it, and keeps it recorded, so a later interactive run offers it again and selecting the skill again takes it back. Once a directory left in place differs from what LaunchBridge installs (you changed it), it is yours: it is no longer offered, and selecting the skill again asks before replacing it (`--yes` leaves it and reports it) | `not installed` once removed                               |
| The same selection again, nothing changed                         | "Installation is up to date — no changes needed"; no files touched. If you kept the directories of skills you deselected earlier, an interactive run offers to remove them instead                                                                                                                                                                                                                                                              | Kept                                                       |

Other effects of a re-run:

- If the selected skills need different Python extras, `pyproject.toml` is regenerated and `venv-setup` is reset, so lb-setup rebuilds `.venv_lb`.
- If a removed skill had an MCP server (for example `indexing-and-qa` → `launchbridge-qa-server`) or the MCP template changed, `mcp-setup` is reset and lb-setup updates the agent's MCP config.
- If the steering in `AGENTS.md` changed, `agents-md-merge` is reset and lb-setup asks you to merge it.
- `.lb_workspace/` data (indexes, evaluation results, configs) is never deleted.
- An existing directory with a selected skill's name that LaunchBridge did not install is never replaced without your say: `--yes` leaves it and reports it, an interactive run asks.
- If the LaunchBridge clone has changes to a selected skill that are not committed, the installer names the skill before it asks you to proceed (and in a `--yes` run): it installs and records the skill as it is in the clone. It names `agent_steering/AGENTS.md` and the files in `project_dependencies/` the same way, since lb-setup's `AGENTS.md` reference and Python dependency files are built from them. `git -C <clone> status` shows the changes.

**Agents.** Select every agent you use; skills are installed into each agent's directory and the `.lb_workspace/` state is shared. Deselecting an agent stops managing its directory, but does not delete it or its MCP config; remove those yourself if you no longer need them. If you select that agent again later, skill folders left in its directory that the record no longer lists are treated like folders LaunchBridge did not install: `--yes` leaves them and reports them, and an interactive run asks before replacing each one. lb-setup writes the MCP config for the agent it is running in.

| Agent       | Skills directory  | MCP config written by lb-setup                                                                                                            |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `.claude/skills/` | `.mcp.json`                                                                                                                               |
| Kiro        | `.kiro/skills/`   | `.kiro/settings/mcp.json`                                                                                                                 |
| Codex       | `.codex/skills/`  | `.codex/config.toml` and the user-level `~/.codex/config.toml`                                                                            |
| Cline       | `.cline/skills/`  | the VS Code extension's `cline_mcp_settings.json` (OS-specific `globalStorage` path) and `~/.cline/data/settings/cline_mcp_settings.json` |
| Roo Code    | `.roo/skills/`    | `.roo/mcp.json`                                                                                                                           |
| Pi          | `.agents/skills/` | —                                                                                                                                         |
| Other       | `.agents/skills/` | —                                                                                                                                         |

### Platform Support

The installer is Node.js and works on macOS, Linux and Windows; content hashes use forward-slash paths, so they match across platforms.

- **macOS and Linux:** copy and symlink installs both work.
- **Windows:** copy installs work. A symlink install makes each skill folder a junction, which needs neither Developer Mode nor an Administrator shell. A global install goes under `%USERPROFILE%` (for example `%USERPROFILE%\.kiro\skills`), and its record under `%USERPROFILE%\.config\launchbridge\`. lb-setup runs its scripts with `python` there (`python -I "<skills folder>\lb-setup\scripts\bootstrap_workspace.py" init "<project>"`).
- **Linked skill folders:** a symlink install links each skill folder, never the files in it. Codex skips a skill whose `SKILL.md` alone is a link ([openai/codex#15844](https://github.com/openai/codex/issues/15844)) and loads a linked folder; Claude Code, Roo Code and Pi load linked folders too. Older Kiro IDE and Cline releases don't load skill folders that are links ([kirodotdev/Kiro#6401](https://github.com/kirodotdev/Kiro/issues/6401), [cline/cline#11113](https://github.com/cline/cline/pull/11113)), so a symlink install for Kiro or Cline warns before it installs; if the skills don't appear there, install again with `--method copy`. A skill folder an older LaunchBridge made of one link per file, holding nothing else, is replaced without asking by the next `launchbridge` run (and, for the native skills, by `launchbridge update`). Any other recorded skill folder laid out differently from how the run installs it, such as one that also holds files of yours or a real folder where a link should be, is treated like one whose content differs: an interactive run asks before replacing it, `--yes` replaces it, and `launchbridge update` leaves it as it is. A change of install method replaces every folder without asking.
- **Python:** lb-setup needs [`uv`](https://docs.astral.sh/uv/getting-started/installation/) and asks you to install it if it is missing; `uv` then provides the Python version `requires-python` names, whatever Python the machine has.
- **EC2, containers and cloud IDEs:** lb-setup detects an instance profile or container role for AWS authentication. Use the non-interactive flags where there is no terminal to prompt on. If the project path changes (a new instance, a different workspace path), lb-setup's path check rewrites path-dependent config and rebuilds `.venv_lb`. LaunchBridge keeps its per-repository records (data-handling confirmations, and the ID that marks `.venv_lb` as the one lb-setup built) in `~/.config/launchbridge/`, or under `$XDG_CONFIG_HOME` when that is an absolute path. Where the home directory doesn't persist but the repository does (a container or a cloud IDE), point `XDG_CONFIG_HOME` at persistent storage outside the repository, or lb-setup rebuilds `.venv_lb` and asks for the confirmations again after each restart.

### Attributing Agent Changes

LaunchBridge keeps no log of its own of what the agent edits or runs. The agent
host performs every file edit and shell command itself, and LaunchBridge is not in
that path. To work out afterwards what changed and why, use these records:

| Question                                                  | Where the answer is                                                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What did the agent do in a session?                       | Your agent's own session history. Claude Code keeps a transcript of every tool call under `~/.claude/projects/`; for other agents, see their documentation                                                                 |
| What changed in the repository?                           | Git history. Commit agent work in small, reviewed commits so each change is attributable                                                                                                                                   |
| Did the agent's standing instructions change?             | `.lb_workspace/config/skill_digests.json`, `.lb_workspace/guardrails/` and the config registry are tracked, and `lb-setup` re-checks installed skills on every run                                                         |
| What repository content was sent for indexing, and where? | `.lb_workspace/indexing_and_qa/transmission_log.jsonl` (local, never committed) and the data-handling confirmation in your LaunchBridge state directory (`~/.config/launchbridge/repos/`, outside the repository)          |
| What AWS calls were made with the profile?                | AWS CloudTrail in the account, if a trail is enabled. Bedrock model invocation logging can also record prompts and responses, but it stores the content itself, so weigh that against the engagement's data-handling terms |

These records assume a single developer. Everything local is under that
developer's control and can be edited by them. If several people drive agents in
one repository, or you need attribution that holds up against the person who ran
the agent, use records they cannot rewrite: protected branches and reviewed merges
for code, and CloudTrail for AWS.

---

## Skills Reference

### lb-setup

**What it does:** Meta skill that orchestrates the full LaunchBridge initialization in one go. It runs each sub-skill in sequence and tracks progress in `.lb_workspace/setup_status.md`, so you can resume if setup is interrupted.

**Setup sequence:**

1. MCP server configuration
2. indexing-and-qa (indexes codebase and artifacts)
3. code-guardrails (generates governance files)
4. config-prompt-registry (scans and catalogs configs and prompts)
5. testing-framework (discovers existing tests)

**How to invoke:**

```
Initialize LaunchBridge for this project
```

or

```
/lb-setup
```

After an upgrade (new skill files delivered), use:

```
Update LaunchBridge
```

The skill detects which skills have changed status and only re-runs setup for those.

**Key artifact:** `.lb_workspace/setup_status.md` — tracks which tasks are complete. Resume at any time by invoking lb-setup again.

---

### indexing-and-qa

**What it does:** Indexes the codebase and any engagement artifacts (presentations, reports, meeting notes, videos) into pre-computed LLM summaries. Provides natural-language Q&A over both via the `codebase_artifact_query` tool on the `launchbridge-qa-server` MCP server.

This is the foundation skill — other skills benefit from having the codebase indexed.

**What it sends:** file contents and artifact text go to Amazon Bedrock (and, when you turn them on, Textract and Transcribe) in your account. Before sending, LaunchBridge refuses files that look like they contain credentials. It doesn't detect or redact personal data (PII), so keep personal data out of indexed files and artifacts, or exclude those files, unless the engagement's data-handling terms allow sending it.

**Configuration:** `.lb_workspace/indexing_and_qa/inq_config.yaml`

Key settings:

- `models` — Bedrock model IDs used for summarization
- `region` — AWS region
- `ignore_patterns` — files/folders to exclude from indexing. They also limit Q&A: when the Q&A server answers a question, LaunchBridge's launcher lets IRIS read only files that are in the index, aren't excluded by the current patterns and aren't symbolic links, so a file indexing excluded, such as `.env`, isn't read or sent to Bedrock. A file changed since the last indexing run is read as it is now, without the credential scan, so reindex after changes. Code search is wider: it searches every file the current patterns don't exclude and that isn't a link, including files indexing skipped (larger than `max_file_size`) and files added since the last run, and sends what it finds to the Q&A model without a credential scan; the model chooses the pattern and how much context comes back, which can be whole files. Keep secrets in files the patterns exclude. The launcher also limits the Q&A server to the configured codebase directory: a question about any other directory is refused.
- `artifact_dir` and the `artifact_*` settings — where engagement artifacts are, OCR, and video transcription (`artifact_transcription_enabled`, `artifact_transcribe_s3_bucket`)

Indexing and the Q&A server refuse a config with settings that would send content, read files or run commands outside what you confirmed: another IAM role (`use_super_profile`, `ROLE_ARN`), `web_search`, `context_file`, `bypass_tool_consent`, `include_monitoring`, an enabled `mcp_servers` entry, an `output_dir` outside the codebase, a model without a real AWS region, or a key LaunchBridge doesn't know. The error names each one. IRIS runs with exactly the config LaunchBridge checked: it doesn't re-read the file after the check.

The Q&A server keeps running for your whole agent session, and LaunchBridge checks its files when it starts. Git overwrites an ignored file when a pulled commit tracks the same path, so before each question the server compares git's index and HEAD with its last check. If they changed (after a pull, merge or checkout), it runs the full check again and stops if anything under `.venv_lb/` or the index folder changed. Changes made without git, such as an archive unpacked into the repository, are found only at the next start. The AWS Documentation MCP server also runs for the whole session from `.venv_lb/`, and it isn't rechecked before each call. So **restart the LaunchBridge MCP servers (both of them) after any `git pull` or other change to the repository's files.**

**Engagement artifacts:** Place project documents (PDFs, PPTX, DOCX, XLSX, MP4, MD) in `.project_artifacts/` before running setup. The skill indexes them alongside the codebase.

**How to invoke:**

For broad architecture questions (uses the MCP tool):

```
/indexing-and-qa What is this codebase about? What is the agent architecture?
```

For artifact questions:

```
/indexing-and-qa What were the main topics in the third project meeting?
```

**Reindexing:** The skill automatically reindexes after any file modification to keep summaries current. But you can always use existing Kiro hook "Re-index Codebase & Artifacts" or prompt "Reindex the codebase (and/or) project artifacts" to manually trigger it.

---

### code-guardrails

**What it does:** Generates and maintains governance files that keep the coding agent aligned with your project's architecture, scope, and best practices. For Kiro, these files are automatically loaded via `.kiro/steering/`.

**Outputs (in `.lb_workspace/guardrails/`):**

| File                 | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `project-context.md` | Auto-generated architecture overview, tech stack, conventions |
| `scope.md`           | Interactively defined boundaries — what's in/out of scope     |
| `aws-references.md`  | Links to the AWS Well-Architected lenses (on-demand)          |
| `feature-guide-*.md` | Per-feature implementation guides                             |

**How to invoke:**

```
/code-guardrails Create guardrail files for this project
```

The skill will interactively ask you to define scope and any anticipated features.

**Your own best practices docs:** put them in `.lb_workspace/guardrails/` as `best_practices_<name>.md`, with `inclusion: always` or `inclusion: manual` frontmatter, and re-run the skill. Don't add files to the installed skill's own folder: a global install's skill folder serves every project, and a symlink install's is the LaunchBridge clone, so a file there reaches every project's guardrails. Earlier versions asked for these docs in the skill's `assets/best_practices/`; move any you put there into `.lb_workspace/guardrails/` before you update, since an update can replace the skill folder.

**Updating guardrails:** Re-run the skill after major architectural changes or when adding new features.

---

### config-prompt-registry

**What it does:** Maintains a single YAML registry of every config value (model IDs, temperatures, max tokens, thresholds, feature flags) and prompt template in the codebase. Keeps the registry and source code bidirectionally in sync — change one, the other updates automatically.

**Configuration:** `.lb_workspace/config/config-prompt-store.yaml`

Each entry tracks:

- `current_value` — the live value
- `source_file` and `source_line` — where it lives in the codebase
- `description` — what it controls

**How to invoke:**

View all configs:

```
/config-prompt-registry Show me all the config values in this system
```

Update a value:

```
/config-prompt-registry Update the TEXT_MODEL to us.anthropic.claude-sonnet-4-6
```

After any update, the skill runs `scripts/validate_registry.py` to confirm source code and registry are in sync.

---

### testing-framework

**What it does:** Discovers existing tests, analyzes coverage gaps, creates new unit and functional tests, runs the test suite, and generates a `TEST_REPORT.md`.

**How to invoke:**

Discover and run existing tests:

```
/testing-framework Run the tests and show me the results
```

Analyze coverage:

```
/testing-framework Analyze test coverage and identify gaps
```

Create new tests:

```
/testing-framework Create unit tests for the message agent
```

**Key artifacts:**

- `.lb_workspace/tests/TEST_REPORT.md` — test inventory, coverage, and results
- Tests run in `.venv_repo` (the project's own environment)

---

### data-wrangler

**What it does:** Prepares, discovers, validates, and generates test data for the target repo. Handles data discovery, schema validation, synthetic data generation, and format transformation. Archives each run with a manifest.

**How to invoke:**

Use existing data:

```
/data-wrangler Prepare the data at sample_data/data.json for prediction
```

Generate synthetic data:

```
/data-wrangler Generate 20 synthetic test cases matching the existing data schema
```

**Key artifacts:**

- `.lb_workspace/data/run_{timestamp}/` — prepared data
- `data_manifest.json` — schema, source, record count, validation results

**Handoff:** Automatically hands off to `generate-predictions` when data is ready.

---

### generate-predictions

**What it does:** Executes the repo's entry point against a dataset to produce prediction output files. Handles environment setup, dependency installation, parameter confirmation, and execution metadata logging.

**How to invoke:**

```
/generate-predictions Run the scam detection system against sample_data/data.json
```

The skill will:

1. Identify the entry point (e.g., `run.py`)
2. Confirm parameters (input path, output path) before running
3. Execute in `.venv_repo`
4. Write output and a `prediction_manifest.json`

**Key artifacts:**

- `.lb_workspace/predictions/run_{timestamp}/output.json` — predictions
- `.lb_workspace/predictions/run_{timestamp}/prediction_manifest.json` — execution metadata

**Handoff:** At the end of a run, the agent will typically ask if you want to evaluate the predictions.

---

### evaluate-predictions

**What it does:** Scores prediction output against ground truth using a library of 40+ built-in metrics (accuracy, F1, LLM-judge correctness, helpfulness, completeness, etc.) plus custom deterministic metrics you can author.

**How to invoke:**

```
/evaluate-predictions Evaluate the latest predictions against ground truth
```

The skill will:

1. Read the prediction manifest and inspect the output format
2. Recommend appropriate metrics for the task type
3. Ask for your approval before running
4. Create `custom_metrics.py` if a custom metric is needed
5. Run the evaluation and present results

**Custom metrics:** If the built-in metrics don't capture your task's core behavior (e.g., extracting a classification label from verbose text), the skill can author a custom `Metric` class. If initial scores seem unreliable, ask the agent to improve the metric — per-record extraction with deterministic comparison is more reliable than a single aggregate LLM call.

**Key artifacts:**

- `.lb_workspace/evaluations/run_{timestamp}/evaluation_manifest.json` — metric scores and metadata
- `.lb_workspace/evaluations/custom_metrics.py` — custom metric definitions

---

### comparative-metric-analysis

**What it does:** Compares evaluation metrics across two or more completed evaluation runs and produces an actionable comparison report. It detects how the runs differ (the "axes of variation") and analyzes them accordingly: **trend** (same setup over time → drift/regression tracking), **variant** (one setting changed, e.g. prompt or model → head-to-head comparison), **hybrid** (more than one axis varies → grouped analysis), or **stability** (identical repeats → run-to-run variance, never reported as drift). Before analyzing, it checks whether the runs can support a meaningful comparison and recommends running more or different tests when they can't.

**Prerequisite:** At least two completed evaluation runs under `.lb_workspace/evaluations/`. For scoring a single run, use `evaluate-predictions` instead.

**How to invoke:**

```
/comparative-metric-analysis Compare my last few evaluation runs
```

The skill will:

1. Assess comparability and sufficiency across the available runs, and classify the comparison case
2. Respect metric directionality (e.g., lower-is-better for error metrics)
3. Produce per-metric visualizations (Mermaid charts by default) with companion tables and sample counts
4. Run the case-specific analysis: trend summary + drift detection, variant comparison, grouped hybrid blocks, or stability/variance
5. Recommend next steps, including more/different testing when the data is statistically weak

**Key artifacts:**

- `.lb_workspace/metric_analysis/comparison_{timestamp}.md` — the comparison report, including a Source Runs table referencing the evaluation runs, prediction files, and datasets compared

**Handoff:** `evaluate-predictions` offers to run this skill automatically when two or more completed evaluation runs exist.

---

### operational-metrics

**What it does:** Instruments all GenAI call sites in the codebase, executes the system via `generate-predictions`, captures real token usage and latency from logs, researches AWS Bedrock pricing, and produces cost/latency reports with scaling projections. Automatically compares against previous runs when history exists.

**Important:** Costs are measured from real execution — never estimated. The skill instruments the code, runs it, and reads the actual metrics log.

**How to invoke:**

```
/operational-metrics Profile the cost and latency of this system
```

**Phases:**

1. Discovery — understand the codebase's LLM call patterns
2. Instrumentation — add metrics logging to all LLM call sites
3. Execution — run via `generate-predictions` with `ENABLE_METRICS_LOGGING=true`
4. Parse metrics — read `metrics_log.jsonl` for token counts and latency
5. AWS costs — research current Bedrock pricing via aws-docs MCP
6. Generate docs — produce CSVs, markdown reports, HTML reports
7. Dashboard — build interactive cross-run comparison dashboard

**Key artifacts:**

- `.lb_workspace/operational_metrics/{timestamp}/` — per-run reports
- `cost_report.md` — per-request costs and scaling projections
- `latency_report.md` — p50/p95/p99 latency breakdown
- `dashboard.html` — interactive cross-run trend visualization

---

### feature-recommendations

**What it does:** Analyzes the codebase to assess production readiness across 13 dimensions and identify high-impact feature opportunities. Produces a prioritized roadmap report.

**Production readiness dimensions assessed:**
Security, authentication/authorization, configuration management, error handling, logging/observability, testing coverage, API design, data validation, deployment/infrastructure, performance, resilience/fault tolerance, dependency management, documentation.

**How to invoke:**

```
/feature-recommendations Assess this codebase for production readiness and recommend next features
```

**Output:** `.lb_workspace/feature_recommendations/FEATURE_RECOMMENDATIONS_{timestamp}.md` — a comprehensive report with:

- Production readiness score per dimension
- Prioritized feature opportunities (massive / medium / small impact)
- Recommended implementation roadmap

---

---

## AI Skills (optional add-on)

Beyond the native LaunchBridge skills, the installer can add skills from the open-source **ai-skills** library ([aws-samples/sample-ai-skills](https://github.com/aws-samples/sample-ai-skills), MIT-0). LaunchBridge includes it as the git submodule `project_dependencies/ai-skills`, pinned at v0.6.2. The upstream [documentation](https://github.com/aws-samples/sample-ai-skills/tree/v0.6.2/docs) has one page per skill ([skills reference](https://github.com/aws-samples/sample-ai-skills/tree/v0.6.2/docs/skills)); this section covers how LaunchBridge installs them and how they fit with the native skills.

**Key differences from native skills:** AI skills require **no `lb-setup`, no AWS credentials, and no `.venv_lb`**. They write their artifacts to the project, not to `.lb_workspace/`. `ai-human-docx`, `ai-human-pdf` and `ai-human-xlsx` run bundled Python scripts with [`uv`](https://docs.astral.sh/uv/), which must already be on the machine; the skills never install `uv`, `node` or a package themselves. On first use, `uv` downloads into its cache a Python 3.14 interpreter when none is installed, and the script's pinned packages: none for `ai-human-docx`, XlsxWriter 3.2.9 for `ai-human-xlsx`, and ReportLab, Mistune and PyYAML with their dependencies, at the versions and hashes locked beside the script, for `ai-human-pdf`. When `node` is installed, the first PDF export with a Mermaid diagram also fetches a pinned Mermaid renderer and a headless browser through `npx`, which can take several minutes; without `node`, diagrams are drawn as code blocks.

### 1. Why they are offered

The ai-skills give the agent your project's patterns, constraints and conventions, so its output is consistent from one run to the next.

- **Spec-driven development (SDD).** Feature work grounded in the project's own context: research before planning, a plan before code, artifacts in dated folders under `docs/working/`, and a human review between steps.
- **Decisions and agent context.** An architecture decision log that the plans respect, and the files a coding agent reads (`AGENTS.md`, `CLAUDE.md`, new skills).
- **Development process and documents.** How the repository is developed, issues, merge requests, prose documents for people, and the project's documentation tree.

### 2. What gets installed

The skills are grouped by domain upstream, and each domain LaunchBridge offers is one installer bundle. The library's `release` domain (`ai-scaffold-release`) is not offered; it is available directly from [aws-samples/sample-ai-skills](https://github.com/aws-samples/sample-ai-skills). Domains are independent, and a skill works without the others in its bundle.

| Bundle (`--skills` value)                                       | Installs                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **AI Spec-Driven Development** (`"AI Spec-Driven Development"`) | `ai-create`, `ai-research`, `ai-plan`, `ai-implement`, `ai-archive`, **and** the native `ai-workflow` orchestrator |
| **AI Architecture Decisions** (`"AI Architecture Decisions"`)   | `ai-adr`                                                                                                           |
| **AI Agent Context** (`"AI Agent Context"`)                     | `ai-agent-context`, `ai-make-skill`, `ai-scaffold-agents-md`                                                       |
| **AI Development Process** (`"AI Development Process"`)         | `ai-dev-autopr`, `ai-dev-issue`, `ai-scaffold-dev-context`, `ai-scaffold-dev-templates`                            |
| **AI Prose Documents** (`"AI Prose Documents"`)                 | `ai-human-docx`, `ai-human-draft`, `ai-human-outline`, `ai-human-pdf`, `ai-human-xlsx`                             |
| **AI Software Documentation** (`"AI Software Documentation"`)   | `ai-doc`, `ai-scaffold-docusaurus-site`                                                                            |

Individual skill names (e.g. `--skills ai-plan`) also work; `ai-workflow` is only added with the full AI Spec-Driven Development bundle or by name. Each skill is installed as an Agent Skills directory in each selected agent's skills folder (`.claude/skills/`, `.kiro/skills/`, …). Claude Code gets the skill as published. Agents differ in which frontmatter fields they read and enforce, such as a skill's tool restrictions and whether it runs only when invoked by name, so every other agent gets the same files with its own `SKILL.md`, built at install time the way the ai-skills installer builds it for Kiro, Codex and pi:

| Agent                         | Its `SKILL.md`                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kiro                          | Keeps only the frontmatter fields Kiro reads and states the skill's tool declarations in a `## Tool restrictions` section. An explicit-only skill also gets an `## Invocation` section: run it only when invoked by name |
| Codex                         | Kiro's form without the `## Invocation` section, with commands written `$ai-…`. An explicit-only skill also gets `agents/openai.yaml`, which turns off implicit invocation                                               |
| pi                            | Also keeps `allowed-tools` and `disable-model-invocation` in its frontmatter, states the tool declarations in `## Tool restrictions`, and writes commands as `/skill:ai-…`                                               |
| Cline, Roo Code, other agents | Kiro's form, naming the agent                                                                                                                                                                                            |

pi and other agents share `.agents/skills/`, which holds pi's copy when pi is selected.

| Skill                         | What it does                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai-create`                   | Creates a working folder with a `README.md` identity document for a feature or a document (`docs/working/YYYY-MM-DD-<name>/README.md`)     |
| `ai-research`                 | Researches a codebase or a topic, producing structured findings (`research.md`) that end with a human review block                         |
| `ai-plan`                     | Writes an implementation plan with phases, code samples and testing strategy (`plan.md`), ending with a human review block                 |
| `ai-implement`                | Executes the plan, building the code it specifies                                                                                          |
| `ai-archive`                  | Retires a finished folder into `docs/working/.archive/`                                                                                    |
| `ai-adr`                      | Keeps the architecture decision log: stands it up, then writes records and moves them through propose, accept and decline                  |
| `ai-agent-context`            | Writes agent context documentation (`CLAUDE.md` + `README.md`) for a source directory                                                      |
| `ai-make-skill`               | Writes a new agent skill, from a description or from work already done in the conversation                                                 |
| `ai-scaffold-agents-md`       | Makes `AGENTS.md` the single source of agent context, with a `CLAUDE.md` beside each that imports it                                       |
| `ai-scaffold-dev-context`     | Records how the repository is developed (forge, base branch, verification commands, …) as one block in the root `AGENTS.md` or `CLAUDE.md` |
| `ai-scaffold-dev-templates`   | Writes the repository's issue, merge request and review templates in its forge's format                                                    |
| `ai-dev-issue`                | Files a clear, complete issue in the project's tracker, or a dated markdown file when there is none                                        |
| `ai-dev-autopr`               | Drives a spec, issue or ticket end to end into a merge-ready pull or merge request, including the push                                     |
| `ai-human-outline`            | Turns a document folder into `outline.md`: a heading hierarchy with drafting guidance under every heading                                  |
| `ai-human-draft`              | Turns a document folder into `draft.md`, following `outline.md` and `research.md` when present                                             |
| `ai-human-docx`               | Exports one markdown file to Microsoft Word (`.docx`)                                                                                      |
| `ai-human-pdf`                | Exports one markdown file to a PDF with a cover page and table of contents                                                                 |
| `ai-human-xlsx`               | Exports a markdown file or a working folder to one Microsoft Excel workbook (`.xlsx`)                                                      |
| `ai-doc`                      | Files documentation into the project's docs tree by Diátaxis mode                                                                          |
| `ai-scaffold-docusaurus-site` | Scaffolds a Docusaurus 3 documentation site after a short interview                                                                        |

The working root is `docs/working/` unless an optional root `.ai-skills.toml` sets a string `output_path`. The SDD skills keep a working manifest at `<working root>/README.md`.

### 3. `ai-workflow`, the recommended entry point

`ai-workflow` is a native LaunchBridge skill, installed with the AI Spec-Driven Development bundle. It does not re-implement or edit the SDD skills, and it cannot start them: they are slash-only and deny the `Skill` tool. Instead it:

1. **Prepares inputs.** Optionally ingests an engagement readout (PDF or Word), offers to write `.context/README.md` (objectives, constraints, key terms, references) and to list it in `context_files` of `.ai-skills.toml`, showing you both changes first, and vendors reference artifacts into `.lb_workspace/ai_workflow/references/`.
2. **Recommends a named chain** for your scenario:

   | Chain                           | Sequence                                                                                           |
   | ------------------------------- | -------------------------------------------------------------------------------------------------- |
   | Quick Fix                       | `/ai-create → /ai-implement`                                                                       |
   | Standard Feature                | `/ai-create → /ai-research → /ai-plan → /ai-implement`                                             |
   | Greenfield / Engagement Kickoff | readout, context, references and a small first feature slate, then Standard Feature per slate item |
   | Investigation                   | `/ai-research <topic>` (nothing is built)                                                          |

   Every chain that creates a folder ends with you checking `[x] Complete` in the folder README, then `/ai-archive <name>`.

3. **Prints each command and checks each step.** It gives you the next slash command, waits for you to run it, then checks the artifact that step should have produced and that you resolved the human review block before offering the next command.

**How to invoke:**

```
Start a coding workflow for adding rate limiting to the API
```

Its state (readout, `references/`, `workflow_state.md`) lives in `.lb_workspace/ai_workflow/`, created when the skill is installed.

### 4. How they work with LaunchBridge

- **Context.** The SDD skills read the target's root `README.md`, `AGENTS.md` and `CLAUDE.md`, plus every file listed in `context_files` of an optional root `.ai-skills.toml` (such as the `.context/README.md` that `ai-workflow` writes on request), so LaunchBridge guidance and the project's conventions reach them. Bullets under a `Constraints` heading in any of those files bind `ai-plan` and `ai-implement`; constraints that cannot both hold stop the run until you pick one. Missing context produces a warning, never a stop.
- **Test command.** `ai-implement` runs the `verify` commands that `/ai-scaffold-dev-context` records, then a test command named in `CLAUDE.md`, then the package manifest's.
- **`indexing-and-qa`.** If it is installed and indexed, `ai-workflow` can use it to draft `.context/README.md` from the codebase. The SDD skills cannot call other skills, so they don't query the index themselves.
- **ADR log and graphify.** The SDD skills use an architectural decision record log (`.adr-dir` or `doc/adr`, which `/ai-adr` maintains) and a graphify graph (`graphify-out/graph.json`) when present. Both are optional.

### 5. Invocation notes

The AI skills are slash-only by design. In agents without skill slash commands they may decline intent-based activation; use Claude Code (or another agent with skill slash commands) for the SDD workflow. `ai-workflow` activates by intent in any agent. The installed `SKILL.md` writes commands the way the agent invokes skills: `$ai-plan` in Codex, `/skill:ai-plan` in pi, `/ai-plan` elsewhere.

Each skill declares denied and pre-approved tools in its frontmatter. Claude Code enforces those declarations; for every other agent the installed `SKILL.md` states them as instructions the agent must follow. See the upstream [tool grant bounds](https://github.com/aws-samples/sample-ai-skills/blob/v0.6.2/docs/explanation/tool-grant-bounds.md) page.

### 6. Tracking and updates

Each installed domain is tracked as one group: an `ai-domain-<domain>` row in `setup_status.md` (status `ready`; no setup needed) and a matching group hash in the version manifest, plus one digest per agent and skill for the integrity check. `ai-workflow` has its own native row. `launchbridge update` reinstalls the installed AI skills of every domain whose content changed, by copy or by symlink as before; a bundle you did not install before needs a re-run of `launchbridge`. For a global install it treats them as it does the native skills (see [Updating LaunchBridge](#updating-launchbridge)): it restores a missing one, leaves an edited copy of one that did not change as it is, and keeps one the clone has uncommitted changes to at its recorded version. AI skills you no longer select are left as they are.

**Projects with a `.context/README.md`.** The AI skills read `.context/README.md` only when `context_files` in `.ai-skills.toml` lists it, and take `output_path` only from `.ai-skills.toml`, not from that file's frontmatter. `ai-workflow` offers to move both into `.ai-skills.toml`.

---

## Workflows & Use Cases

### 1. Onboarding onto an unfamiliar codebase

**Goal:** Quickly build a mental model of a delivered system before making any changes.

```
Step 1: /lb-setup                          ← initialize all skills
Step 2: /indexing-and-qa What is this codebase about?
Step 3: /indexing-and-qa What are the main topics from the project meeting on 03/15/2026?
Step 4: /indexing-and-qa What models and config values are used in this system?
Step 5: /code-guardrails Create guardrail files for this project
```

After this workflow you have: indexed codebase + artifacts, governance files loaded into your agent, and a clear picture of the architecture.

---

### 2. Baseline evaluation of a delivered system

**Goal:** Establish a measured quality baseline before making any changes.

```
Step 1: /data-wrangler Prepare the test data at sample_data/data.json
Step 2: /generate-predictions Run the system against the prepared data
Step 3: /evaluate-predictions Evaluate the predictions against ground truth
Step 4: Note the baseline scores — these are your reference point for all future changes
```

---

### 3. Model upgrade with measured impact

**Goal:** Upgrade a model ID and quantify the before/after impact.

```
Step 1: Run baseline evaluation (Workflow 2 above)
Step 2: /config-prompt-registry Update the TEXT_MODEL to <new-model-id>
Step 3: /generate-predictions Run the system with the updated model
Step 4: /evaluate-predictions Evaluate and compare against the baseline
Step 5: Review the delta — confirm the upgrade improved (or didn't regress) quality
```

The config-prompt-registry ensures the model ID is updated in both source code and the registry in one operation.

---

### 4. Cost and latency profiling

**Goal:** Understand the real cost and latency of the system before scaling or productionizing.

```
Step 1: /operational-metrics Profile the cost and latency of this system
Step 2: Review the instrumentation plan — approve the code changes
Step 3: The skill runs the system with metrics logging enabled
Step 4: Review cost_report.md for per-request costs and scaling projections
Step 5: Review latency_report.md for p50/p95/p99 breakdown
Step 6: Open dashboard.html for cross-run trend visualization
```

Run this after any model upgrade or prompt change to track cost/latency impact over time.

---

### 5. Adding tests and improving coverage

**Goal:** Increase confidence in code changes by building out the test suite.

```
Step 1: /testing-framework Discover existing tests and analyze coverage
Step 2: /testing-framework Create unit tests for <component>
Step 3: /testing-framework Run the full test suite and show results
Step 4: Review TEST_REPORT.md for coverage gaps
Step 5: Repeat Steps 2–4 for each under-tested component
```

Run the test suite after every code change to catch regressions early.

---

### 6. Production readiness assessment

**Goal:** Identify gaps between the current POC and a production-ready system.

```
Step 1: /feature-recommendations Assess this codebase for production readiness
Step 2: Review the 13-dimension readiness scores
Step 3: Review the prioritized feature opportunities
Step 4: Use the roadmap to plan your next development sprint
```

Combine with `code-guardrails` to create feature guides for the highest-priority items:

```
/code-guardrails Create a feature guide for adding authentication to this API
```

---

### 7. Full lifecycle: POC to production

This is the end-to-end workflow for evolving a delivered POC into a production-ready system.

**Phase A — Understand**

```
/lb-setup
/indexing-and-qa What is this codebase about?
/feature-recommendations Assess production readiness and recommend next features
```

**Phase B — Establish baseline**

```
/data-wrangler Prepare test data
/generate-predictions Run the system
/evaluate-predictions Evaluate predictions
/operational-metrics Profile cost and latency
```

**Phase C — Govern**

```
/code-guardrails Create guardrail files including scope and feature guides
/testing-framework Discover tests and analyze coverage gaps
```

**Phase D — Improve quality**

```
/config-prompt-registry Update model to latest version
/generate-predictions Re-run with the updated configuration
/evaluate-predictions Compare against baseline
```

**Phase E — Harden**

```
/testing-framework Create tests for all critical paths
/code-guardrails Update guardrails with new security and AWS best practices
/operational-metrics Re-profile after changes to track cost/latency trends
```

**Phase F — Iterate**
Repeat Phases D–E for each feature sprint, using the feature-recommendations roadmap to prioritize work.

---

## Artifact Reference

All artifacts are written to `.lb_workspace/` (gitignored).

| Path                                                      | Created by                  | Contents                                                                                                             |
| --------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `.lb_workspace/setup_status.md`                           | lb-setup                    | Tracks which setup tasks are complete                                                                                |
| `.lb_workspace/config/lb_env`                             | lb-setup                    | AWS auth method, profile, and codebase path (`aws_profile`, `iam_instance_profile`, `container_role`, or `env_vars`) |
| `.lb_workspace/config/version_manifest.json`              | installer                   | Version tracking, per-skill content hashes, delivery method (enables upgrade detection)                              |
| `.lb_workspace/config/lb_agents_reference.md`             | installer                   | Canonical AGENTS.md reference used by lb-setup                                                                       |
| `.lb_workspace/config/python_deps/pyproject.toml`         | installer                   | Python dependency config for `.venv_lb`                                                                              |
| `.lb_workspace/indexing_and_qa/inq_config.yaml`           | indexing-and-qa             | Indexing models, regions, ignore patterns                                                                            |
| `.lb_workspace/guardrails/`                               | code-guardrails             | Project context, scope, best practices, feature guides                                                               |
| `.lb_workspace/config/config-prompt-store.yaml`           | config-prompt-registry      | All config values and prompt templates                                                                               |
| `.lb_workspace/tests/TEST_REPORT.md`                      | testing-framework           | Test inventory, coverage, results                                                                                    |
| `.lb_workspace/data/run_{timestamp}/`                     | data-wrangler               | Prepared data + `data_manifest.json`                                                                                 |
| `.lb_workspace/predictions/run_{timestamp}/`              | generate-predictions        | `output.json` + `prediction_manifest.json`                                                                           |
| `.lb_workspace/evaluations/run_{timestamp}/`              | evaluate-predictions        | `evaluation_manifest.json` + `custom_metrics.py`                                                                     |
| `.lb_workspace/metric_analysis/comparison_{timestamp}.md` | comparative-metric-analysis | Cross-run comparison report (trend/variant/hybrid/stability) with a Source Runs reference table                      |
| `.lb_workspace/operational_metrics/{timestamp}/`          | operational-metrics         | Cost/latency CSVs, markdown reports, HTML dashboard                                                                  |
| `.lb_workspace/feature_recommendations/`                  | feature-recommendations     | `FEATURE_RECOMMENDATIONS_{timestamp}.md`                                                                             |
| `.project_artifacts/`                                     | (user-provided)             | Engagement documents for indexing (PDFs, PPTX, etc.)                                                                 |
