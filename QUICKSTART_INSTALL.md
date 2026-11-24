<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# LaunchBridge: Quick Start Install Guide

Get LaunchBridge installed and running in under 5 minutes.

---

## Prerequisites

Before you start, make sure you have:

- **Git**
- **Node.js** v22.13 or higher — [nodejs.org](https://nodejs.org/)
- **Python** 3.12 or higher
- **AWS CLI v2** with at least one profile configured — [install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). Prefer a profile scoped to Bedrock inference: the core skills need nothing more. A starting policy is in `skills/lb-setup/templates/bedrock-least-privilege-policy.json`; the optional features that need more are listed in the README's AWS Credentials section.

---

## Step 1: Install the `launchbridge` command

### Recommended: install with npm

```bash
npm install -g github:aws-samples/sample-launchbridge
```

This installs the `launchbridge` command. The first time you run `launchbridge` (Step 2), it clones LaunchBridge into `~/.launchbridge`, and every later install and `launchbridge update` uses that one clone. It tracks `main` and doesn't verify release signatures; use the clone below if you need that. If you switch Node versions with nvm, run the command again under the new version. See the README's [Option A](README.md#option-a-install-the-command-with-npm-recommended).

### Alternative: clone the repository (development or signed releases)

To use a specific release, check out its tag after cloning (for example `git checkout v1.1.0`), and verify the tag's signature first, as described in [Verifying a release](README.md#verifying-a-release):

```bash
git clone https://github.com/aws-samples/sample-launchbridge.git
cd sample-launchbridge
git -c gpg.ssh.allowedSignersFile=~/.config/launchbridge/allowed_signers verify-tag v1.1.0
git checkout v1.1.0
npm run setup
```

`npm run setup` initializes the git submodules, installs the CLI dependencies from the lockfile, and links the `launchbridge` command globally on your machine.

Clone the repository rather than downloading it as a ZIP: updates need the `.git` folder to fetch later releases. On a release tag, move to a newer release by verifying and checking out its tag, then re-running `launchbridge` in your target project; `launchbridge update` follows a branch and stops on a tag (see [Updating LaunchBridge](README.md#updating-launchbridge)).

---

## Step 2: Install the skills

Run the installer. For the default global install, run it from any folder; for a local install, run it in the repository you want to add LaunchBridge to:

```bash
launchbridge
```

The installer will walk you through a short set of prompts:

1. **Agent** — select your coding agent (e.g. Kiro, Claude Code)
2. **Scope** — **Global** (default) installs the skills in your agent's user-level folder (for example `~/.claude/skills`, or `~/.agents/skills` for Codex), for every project, and changes no repository. **Local** installs them into the current repository only, which then carries its own copy.
3. **Install method** — choose `copy`, or `symlink` to link each skill folder to the LaunchBridge clone so `launchbridge update` changes them in place
4. **Skills** — select which skills to install (select all to get the full suite). This includes the native LaunchBridge skills plus the optional AI skill bundles from the ai-skills library: **AI Spec-Driven Development** (the SDD workflow `/ai-create → /ai-research → /ai-plan → /ai-implement → /ai-archive` + the `ai-workflow` orchestrator), **AI Architecture Decisions**, **AI Agent Context**, **AI Development Process**, **AI Prose Documents** and **AI Software Documentation**.
5. **Confirm** — review the summary and confirm

When it finishes, you'll see a success banner and a note to run `lb-setup`.

For scripted installs, `--scope global|local` skips the scope prompt; see [Non-Interactive CLI Flags](docs/USER_GUIDE.md#non-interactive-cli-flags).

---

## Step 3: Run lb-setup in your agent

Open your coding agent in the project directory and send this prompt:

```
/lb-setup
```

or

```
Initialize LaunchBridge for this project
```

With a global install, do this in each project you want to use LaunchBridge in. The first run in a project checks that the folder is safe to prepare, then creates `.lb_workspace/` there.

`lb-setup` will:

1. Detect that this is a new machine and prompt you to select your AWS profile
2. Build the `.venv_lb` Python environment for LaunchBridge
3. Configure MCP servers
4. Index the codebase
5. Generate governance files
6. Scan configs and prompts
7. Discover existing tests

Progress is tracked in `.lb_workspace/setup_status.md` — if setup is interrupted, just run `lb-setup` again and it will pick up where it left off.

---

## You're done

Once `lb-setup` completes, all skills are ready to use. A good first prompt to try:

```
/indexing-and-qa What is this codebase about?
```

For the full list of skills and how to use them, see [USER_GUIDE.md](docs/USER_GUIDE.md).
