<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# LaunchBridge: Quick Start Install Guide

Get LaunchBridge installed from its git repository and running in under 5 minutes.

---

## Prerequisites

Before you start, make sure you have:

- **Git**
- **Node.js** v22.13 or higher — [nodejs.org](https://nodejs.org/)
- **Python** 3.12 or higher
- **AWS CLI v2** with at least one profile configured — [install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). Prefer a profile scoped to Bedrock inference: the core skills need nothing more. A starting policy is in `skills/lb-setup/templates/bedrock-least-privilege-policy.json`; the optional features that need more are listed in the README's AWS Credentials section.

---

## Step 1: Clone and install

To use a specific release, check out its tag after cloning (for example `git checkout v1.1.0`), and verify the tag's signature first, as described in [Verifying a release](README.md#verifying-a-release):

```bash
git clone https://github.com/aws-samples/sample-launchbridge.git
cd sample-launchbridge
git -c gpg.ssh.allowedSignersFile=~/.config/launchbridge/allowed_signers verify-tag v1.1.0
git checkout v1.1.0
npm run setup
```

`npm run setup` initializes the git submodules, installs the CLI dependencies from the lockfile, and links the `launchbridge` command globally on your machine.

**Shortcut without a clone.** You can skip this step and run a release straight from GitHub inside your target project: `npx --yes github:aws-samples/sample-launchbridge#v1.1.0`. This always installs with the `copy` method, cannot verify the release signature, and has no `launchbridge update`; to move to a newer release, run it again with the new tag. See the README's [Option A](README.md#option-a-run-the-installer-with-npx-no-clone).

Clone the repository rather than downloading it as a ZIP: updates need the `.git` folder to fetch later releases. On a release tag, move to a newer release by verifying and checking out its tag, then re-running `launchbridge` in your target project; `launchbridge update` follows a branch and stops on a tag (see [Updating LaunchBridge](README.md#updating-launchbridge)).

---

## Step 2: Install skills into your project

Navigate to the repository you want to add LaunchBridge to, then run the installer:

```bash
cd /path/to/your-project
launchbridge
```

The installer will walk you through a short set of prompts:

1. **Agent** — select your coding agent (e.g. Kiro, Claude Code)
2. **Install method** — choose `copy` (recommended for Kiro) or `symlink`
3. **Skills** — select which skills to install (select all to get the full suite). This includes the native LaunchBridge skills plus the optional AI skill bundles from the ai-skills library: **AI Spec-Driven Development** (the SDD workflow `/ai-create → /ai-research → /ai-plan → /ai-implement → /ai-archive` + the `ai-workflow` orchestrator), **AI Architecture Decisions**, **AI Agent Context**, **AI Development Process**, **AI Prose Documents** and **AI Software Documentation**.
4. **Confirm** — review the summary and confirm

When it finishes, you'll see a success banner and a note to run `lb-setup`.

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
