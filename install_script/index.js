#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Skill Installer CLI
 *
 * A CLI tool for installing agent skills from the launchbridge
 * repository into target repositories. Supports Kiro and Claude Code agents
 * with local/global installation scope and symlink/copy methods.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync from 'fs';
import chalk from 'chalk';

import { runVenvSetup } from './lib/venvSetup.js';

import {
    promptForAgents,
    promptForSkillCategories,
    promptForMethod,
    promptForConfirmation,
    promptForConflictResolution,
    promptForOrphanResolution,
} from './lib/promptManager.js';
import {
    discoverSkills,
    SKILL_CATEGORIES,
    resolveSkillsFromCategories,
    resolveAllSkills,
} from './lib/skillDiscovery.js';
// External (non-native) skills integration — single seam; see module header.
import { externalSkills } from './lib/externalSkillsProvider.js';
import { AGENTS } from './lib/agentConfig.js';
import {
    ensureTargetDirectory,
    createSymlink,
    copySkill,
    PERMISSION_HINT,
} from './lib/installer.js';
import { verifyInstallation } from './lib/verifier.js';
import {
    displaySummary,
    displayProgress,
    displayFinalReport,
    getExitCode,
    buildLifecycleReport,
    displayLifecycleReport,
} from './lib/reporter.js';
import { decideUpdate, parseApplyCommit } from './lib/updateDecision.js';
import { decideExistingSkillPath } from './lib/conflictDecision.js';
import { removePath, cleanupOrphanSkills } from './lib/orphanCleanup.js';
import { stripControlCharacters } from './lib/terminalText.js';
import {
    getTargetPath as getTargetPathFromValidator,
    validateTargetDirectory,
    checkWritePermissions,
    checkSkillsDirectory,
    checkWorkspace,
} from './lib/pathValidator.js';
import {
    step,
    success,
    warn,
    error as uiError,
    muted,
    spacer,
} from './lib/ui.js';
import {
    computeSkillHashes,
    computeFileHash,
    computeDependencySetHash,
} from './lib/contentHash.js';
import { installedSkillMatches } from './lib/installedContent.js';
import { readManifest, writeManifest } from './lib/versionManifest.js';
import {
    targetKey,
    readInstalledTargets,
    namesUnder,
} from './lib/installedTargets.js';
import {
    detectDeliveryMethod,
    getGitCommitHash,
    readReleaseVersion,
} from './lib/deliveryDetector.js';
import {
    HANDOVER_ENV,
    ensureHome,
    handOver,
    homePath,
    prepareHome,
} from './lib/homeClone.js';
import { determineLifecycle } from './lib/lifecycleOrchestrator.js';
import { applyStatusResets } from './lib/statusReset.js';
import {
    parseSetupStatusContent,
    buildMarkdownTable,
} from './lib/setupStatus.js';

/**
 * Prints what an update would change before it is applied: the incoming
 * commits, and skill instructions, installer files, steering and submodule
 * pointers by name.
 *
 * @param {object} preview - The preview returned by `runUpdate`
 */
function displayUpdatePreview(preview) {
    const { commits, changes, changedPaths, from, to, branch } = preview;
    const short = (sha) => sha.slice(0, 12);
    // Commit metadata and paths come from the remote.
    const clean = stripControlCharacters;

    console.log(
        `  ${commits.length} incoming commit(s) on '${clean(branch)}' (${short(from)}..${short(to)}), ` +
            `${changedPaths.length} file(s) changed:`
    );
    const shown = commits.slice(0, 20);
    for (const c of shown) {
        console.log(
            chalk.dim(
                `    ${clean(c.hash)}  ${clean(c.date)}  ${clean(c.author)}  ${clean(c.subject)}`
            )
        );
    }
    if (commits.length > shown.length) {
        console.log(
            chalk.dim(`    … and ${commits.length - shown.length} more`)
        );
    }
    spacer();

    const list = (label, items, highlight = false) => {
        if (!items.length) return;
        const line = `  ${label} (${items.length}): ${items.map(clean).join(', ')}`;
        console.log(highlight ? chalk.yellow(line) : line);
    };
    list('Skill instructions (SKILL.md)', changes.skillInstructions, true);
    list(
        'Skills with other changes',
        changes.skills.filter((s) => !changes.skillInstructions.includes(s))
    );
    list('Installer files', changes.installer, true);
    list('Agent steering', changes.steering, true);
    list(
        'Submodule pointers (their content is not in this diff)',
        changes.submodules,
        true
    );
    if (changes.scripts.length) {
        console.log(`  Executable scripts touched: ${changes.scripts.length}`);
    }
    if (changes.other.length) {
        console.log(`  Other files: ${changes.other.length}`);
    }
    spacer();
    muted(
        `  Full diff: git -C "${preview.sourcePath}" diff ${short(from)} ${short(to)}`
    );
    spacer();
}

/**
 * Runs the `update` subcommand: fetches the latest changes from the remote git
 * repo, shows what they change, and applies them only once confirmed.
 *
 * For scripted use, `--apply <commit>` applies the update only if it ends at
 * the commit a previous preview showed. `--yes` alone, or no terminal to ask
 * on, prints the preview and applies nothing.
 *
 * Exits 0 on success (including "declined"), 1 on failure.
 */
async function runUpdateCommand() {
    const { runUpdate, runPostPullSync } = await import('./lib/updater.js');
    const { promptForUpdateConfirmation } =
        await import('./lib/promptManager.js');
    const {
        step,
        success,
        error: uiError,
        spacer,
        muted,
        warn,
    } = await import('./lib/ui.js');

    showLogo();

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(scriptDir, '..');
    const targetRepo = process.cwd();
    const updateArgs = process.argv.slice(3);

    // Every write into .lb_workspace below must land inside the target repository.
    const workspaceCheck = await checkWorkspace(targetRepo);
    if (!workspaceCheck.ok) {
        uiError(`Refusing to update: ${workspaceCheck.reason}`);
        process.exit(1);
    }
    const autoConfirm = updateArgs.some(
        (arg) => arg === '--yes' || arg === '-y'
    );
    const applyCommit = parseApplyCommit(updateArgs);

    step(1, 'Updating LaunchBridge');
    spacer();
    muted(`Repository: ${sourcePath}`);
    spacer();

    const confirm = async (preview) => {
        displayUpdatePreview({ ...preview, sourcePath });
        const decision = decideUpdate(preview, {
            yes: autoConfirm,
            applyCommit,
            isTTY: process.stdin.isTTY,
        });
        if (decision.action === 'prompt') {
            return promptForUpdateConfirmation();
        }
        if (decision.action === 'apply') {
            muted(decision.message);
            return true;
        }
        warn(decision.message);
        return false;
    };

    try {
        const {
            alreadyCurrent,
            declined,
            preview,
            branch,
            submoduleWarning,
            npmInstalled,
            npmError,
        } = await runUpdate(sourcePath, { confirm });
        if (alreadyCurrent) {
            success(`Already up to date (branch '${branch}').`);
        } else if (declined) {
            muted('Update not applied. Nothing was changed.');
            spacer();
            process.exit(0);
        } else {
            success(
                `LaunchBridge updated from branch '${branch}' ` +
                    `(${preview.commits.length} commit(s)).`
            );
        }
        if (submoduleWarning) {
            warn(submoduleWarning);
        }
        if (npmInstalled) {
            muted("Reinstalled the CLI's npm packages (npm ci).");
        }
        if (npmError) {
            uiError(
                `The update was applied, but its npm packages could not be installed.\n` +
                    `${npmError}\n` +
                    `Run 'npm ci' in ${sourcePath} before using launchbridge again.`
            );
            process.exit(1);
        }
    } catch (err) {
        uiError(`Update failed: ${err.message}`);
        process.exit(1);
    }

    // Post-pull sync: re-copy changed skills (copy installs) and regenerate pyproject if needed
    spacer();
    try {
        const syncResult = await runPostPullSync(sourcePath, targetRepo, {
            step,
            success,
            warn,
            muted,
            spacer,
        });

        if (syncResult.skippedNoManifest) {
            muted('No version manifest found — skipping skill sync.');
        } else if (syncResult.changedSkills?.length) {
            spacer();
            warn(
                `${syncResult.changedSkills.length} skill(s) changed. lb-setup's integrity ` +
                    'check will hold them back until the change is reviewed and the ' +
                    'digest baseline refreshed (verify_integrity.py --write-baseline).'
            );
            if (syncResult.baselineCreated) {
                muted(
                    '  Recorded the pre-update digests in ' +
                        '.lb_workspace/config/skill_digests.json — commit it.'
                );
            }
        }
    } catch (err) {
        warn(`Post-pull sync encountered an error: ${err.message}`);
    }

    spacer();
    process.exit(0);
}

/**
 * Parses CLI flags from process.argv for non-interactive operation.
 *
 * Supported flags:
 *   --skills <list>   Comma-separated skill names, category names, or 'all'
 *   --agent <list>    Comma-separated agent names (e.g., kiro, claude)
 *   --method <value>  'copy' or 'symlink'
 *   --yes / -y        Auto-confirm all prompts
 *
 * @returns {{ skills: string|null, agent: string|null, method: string|null, yes: boolean }}
 */
function parseCLIFlags() {
    const args = process.argv.slice(2);
    const flags = { skills: null, agent: null, method: null, yes: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--skills' && args[i + 1]) {
            flags.skills = args[++i];
        } else if (args[i] === '--agent' && args[i + 1]) {
            flags.agent = args[++i];
        } else if (args[i] === '--method' && args[i + 1]) {
            flags.method = args[++i];
        } else if (args[i] === '--yes' || args[i] === '-y') {
            flags.yes = true;
        }
    }
    return flags;
}

/**
 * Validates CLI flag values and resolves them to usable selections.
 * Exits with code 1 and a clear error message if any flag value is invalid.
 *
 * @param {{ skills: string|null, agent: string|null, method: string|null, yes: boolean }} flags
 * @param {import('./lib/skillDiscovery.js').Skill[]} availableSkills - Discovered skills from source
 * @param {import('./lib/skillDiscovery.js').SkillCategory[]} [categories] - Categories to resolve against (defaults to SKILL_CATEGORIES)
 * @returns {{ agents: string[]|null, method: string|null, skills: string[]|null, yes: boolean }}
 */
function validateAndResolveFlags(
    flags,
    availableSkills,
    categories = SKILL_CATEGORIES
) {
    const resolved = {
        agents: null,
        method: null,
        skills: null,
        yes: flags.yes,
    };

    // Validate --agent
    if (flags.agent) {
        const agentNames = flags.agent
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean);
        const validAgents = Object.keys(AGENTS);
        for (const name of agentNames) {
            if (!validAgents.includes(name)) {
                console.error(
                    `Unknown agent: '${name}'. Available: ${validAgents.join(', ')}`
                );
                process.exit(1);
            }
        }
        resolved.agents = agentNames;
    }

    // Validate --method
    if (flags.method) {
        if (flags.method !== 'copy' && flags.method !== 'symlink') {
            console.error(
                `Invalid method: '${flags.method}'. Use 'copy' or 'symlink'.`
            );
            process.exit(1);
        }
        resolved.method = flags.method;
    }

    // Validate --skills
    if (flags.skills) {
        if (flags.skills === 'all') {
            resolved.skills = resolveAllSkills(categories);
        } else {
            const parts = flags.skills
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const availableSkillNames = availableSkills.map((s) => s.name);
            const categoryNames = categories.map((c) => c.name);
            const resolvedSkillSet = new Set();

            for (const part of parts) {
                if (categoryNames.includes(part)) {
                    // Resolve as category name
                    const categorySkills = resolveSkillsFromCategories(
                        [part],
                        categories
                    );
                    for (const s of categorySkills) {
                        resolvedSkillSet.add(s);
                    }
                } else if (availableSkillNames.includes(part)) {
                    // Resolve as direct skill name
                    resolvedSkillSet.add(part);
                } else {
                    console.error(
                        `Unknown skill: '${part}'. Available skills: ${availableSkillNames.join(', ')}`
                    );
                    process.exit(1);
                }
            }

            // Always include required skills
            for (const category of categories) {
                if (category.required) {
                    for (const skill of category.skills) {
                        resolvedSkillSet.add(skill);
                    }
                }
            }

            resolved.skills = [...resolvedSkillSet];
        }
    }

    return resolved;
}

/**
 * Checks if a target path already exists (file, directory, or symlink).
 * @param {string} targetPath - Path to check
 * @returns {Promise<boolean>} True if path exists
 */
async function pathExists(targetPath) {
    try {
        await fs.lstat(targetPath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

const logo = [
    '',
    ' ██╗      █████╗ ██╗   ██╗███╗   ██╗ ██████╗██╗  ██╗██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗',
    ' ██║     ██╔══██╗██║   ██║████╗  ██║██╔════╝██║  ██║██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝',
    ' ██║     ███████║██║   ██║██╔██╗ ██║██║     ███████║██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  ',
    ' ██║     ██╔══██║██║   ██║██║╚██╗██║██║     ██╔══██║██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  ',
    ' ███████╗██║  ██║╚██████╔╝██║ ╚████║╚██████╗██║  ██║██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗',
    ' ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝',
    ' ══════════════════════════════════╡  A G E N T   S K I L L S  ╞════════════════════════════════',
    '',
];

function showLogo() {
    const gradient = [
        '#FF6000',
        '#FF6D00',
        '#FF7A00',
        '#FF8700',
        '#FF9400',
        '#FFA000',
        '#FFAA00',
        '#1394cb',
    ];

    console.log();
    logo.forEach((line, i) => {
        const color = gradient[Math.min(i, gradient.length - 1)];
        console.log(chalk.hex(color)(line));
    });
    console.log('');
}

/**
 * Runs when launchbridge is an npm package (`npm install -g`, or npx) rather
 * than a clone: makes sure ~/.launchbridge is a clone of LaunchBridge, then
 * runs that clone's installer with the same arguments and exits with its exit
 * code. Target repositories therefore always install from the clone, and
 * `launchbridge update` updates it.
 *
 * @returns {Promise<never>}
 */
async function bootstrapFromPackage() {
    if (process.env[HANDOVER_ENV]) {
        // The folder handed over to is not a clone: never loop.
        uiError(
            `${homePath()} is not a git clone of LaunchBridge. Remove it and run launchbridge again.`
        );
        process.exit(1);
    }
    const home = homePath();
    try {
        const { created } = await ensureHome(home);
        await prepareHome(home);
        if (created) {
            success(`Cloned LaunchBridge into ${home}`);
            spacer();
        }
    } catch (err) {
        uiError(err.message);
        process.exit(1);
    }
    process.exit(await handOver(home, process.argv.slice(2)));
}

/**
 * Main CLI orchestrator function.
 * Wires all components together and handles the complete installation flow.
 */
async function main() {
    // An npm package (npm install -g, or npx) hands over to ~/.launchbridge,
    // which has .git, real symlinks and launchbridge update.
    const scriptRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..'
    );
    if ((await detectDeliveryMethod(scriptRoot)) === 'bundled') {
        await bootstrapFromPackage();
    }

    // Dispatch subcommands before running the default install flow
    const subcommand = process.argv[2];
    if (subcommand === 'update') {
        await runUpdateCommand();
        return; // runUpdateCommand calls process.exit(), but return for clarity
    }

    showLogo();
    console.log('This tool will help you install the LaunchBridge Skills\n');

    // Step 1: Auto-detect source path (parent directory of install_script)
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(scriptDir, '..');

    // Validate the source path has a skills directory
    const { validateSourceRepository } = await import('./lib/pathValidator.js');
    const sourceValidation = validateSourceRepository(sourcePath);
    if (!sourceValidation.valid) {
        uiError(sourceValidation.error);
        uiError(
            'The script must be run from within the launchbridge repository.'
        );
        process.exit(1);
    }

    // Step 2: Discover available skills — native LaunchBridge skills plus any
    // external skills (e.g. the ai-skills submodule) via the provider seam.
    // Native names win a collision: an external skill with a native name is
    // skipped (with a warning) during discovery.
    const lbSkills = discoverSkills(sourcePath);
    const nativeNames = new Set(lbSkills.map((s) => s.name));
    const externalSkillList = externalSkills.discover(sourcePath, {
        nativeNames,
        onWarn: warn,
    });
    const availableSkills = [...lbSkills, ...externalSkillList];
    if (availableSkills.length === 0) {
        uiError('No valid skills found in the source repository.');
        process.exit(1);
    }

    // Combined category list: native categories plus external bundles. The
    // external provider decides its own grouping (one bundle per ai-skills
    // domain) and appends native companions it bundles (e.g. the
    // ai-workflow orchestrator with the research domain).
    const externalCategories = externalSkills.buildCategories(
        externalSkillList,
        nativeNames
    );
    const allCategories = [...SKILL_CATEGORIES, ...externalCategories];

    // Parse CLI flags for non-interactive operation
    const cliFlags = parseCLIFlags();
    const resolvedFlags = validateAndResolveFlags(
        cliFlags,
        availableSkills,
        allCategories
    );

    // Step 3: Get user selections (skip prompts when flags are provided)
    step(1, 'Configure Installation');

    // Get target repository path (current working directory)
    const targetRepository = process.cwd();

    // Every write into .lb_workspace below must land inside the target repository.
    const workspaceCheck = await checkWorkspace(targetRepository);
    if (!workspaceCheck.ok) {
        uiError(`Refusing to install: ${workspaceCheck.reason}`);
        process.exit(1);
    }

    // Read existing manifest to pre-populate agent and skill selections
    const existingManifestForPrompts = await readManifest(targetRepository);
    const manifestAgents = existingManifestForPrompts?.agents ?? null;
    const manifestSkills =
        Array.isArray(existingManifestForPrompts?.skills) &&
        existingManifestForPrompts.skills.length > 0
            ? existingManifestForPrompts.skills
            : existingManifestForPrompts?.skillHashes
              ? Object.keys(existingManifestForPrompts.skillHashes)
              : null;

    const agents = resolvedFlags.agents
        ? resolvedFlags.agents
        : await promptForAgents(manifestAgents);
    const method = resolvedFlags.method
        ? resolvedFlags.method
        : await promptForMethod();
    // The manifest stores external skills as group keys (ai-domain-<domain>),
    // but the prompt pre-checks categories by member skill name. Expand group
    // keys to the external skills the last install actually recorded (their
    // `<agent>/<name>` digests, `shared/<name>` in older manifests), so a
    // partial install does not pre-check the whole bundle.
    const priorExternalNames = [
        ...new Set(
            Object.keys(existingManifestForPrompts?.externalSkillHashes ?? {})
                .filter((key) => key.includes('/'))
                .map((key) => key.slice(key.indexOf('/') + 1))
        ),
    ];
    const selectedSkills = resolvedFlags.skills
        ? resolvedFlags.skills
        : await promptForSkillCategories(
              manifestSkills
                  ? externalSkills.expandManifestKeys(
                        manifestSkills,
                        priorExternalNames,
                        externalSkillList
                    )
                  : null,
              allCategories
          );
    const scope = 'local';

    // Skill directories the previous install recorded. Orphan cleanup only
    // offers these, so a directory LaunchBridge did not install is never removed.
    const previouslyInstalledSkills = new Set(
        manifestSkills
            ? externalSkills.expandManifestKeys(
                  manifestSkills,
                  externalSkillList.map((s) => s.name),
                  externalSkillList
              )
            : []
    );

    // Skill directories LaunchBridge installed, recorded per directory. A
    // manifest from before this record falls back to the skill names above.
    const priorTargets = readInstalledTargets(existingManifestForPrompts);
    const wasInstalledByLaunchBridge = (skillTargetPath, skillName) =>
        priorTargets
            ? priorTargets.has(targetKey(targetRepository, skillTargetPath))
            : (manifestSkills ?? []).includes(skillName) ||
              priorExternalNames.includes(skillName);
    // Existing directories this run left alone because LaunchBridge did not
    // install them; they are never recorded as installed.
    const foreignTargets = new Set();

    // Build selections object
    const selections = {
        agents,
        scope,
        method,
        sourcePath,
        skills: selectedSkills,
    };

    // Step 4: Show summary and get confirmation
    spacer();
    const summary = displaySummary(selections);

    let confirmed;
    if (resolvedFlags.yes) {
        confirmed = true;
    } else {
        confirmed = await promptForConfirmation(summary);
    }

    if (!confirmed) {
        spacer();
        muted('Installation cancelled.');
        process.exit(0);
    }

    step(2, 'Validating');
    spacer();

    if (scope === 'local') {
        const targetValidation = validateTargetDirectory(targetRepository);
        if (!targetValidation.valid) {
            uiError(targetValidation.error);
            process.exit(1);
        }
    }

    // Check write permissions for each agent's target path
    for (const agent of agents) {
        const baseTargetPath = getTargetPathFromValidator(
            agent,
            scope,
            targetRepository
        );
        const permissionCheck = checkWritePermissions(baseTargetPath);
        if (!permissionCheck.valid) {
            uiError(permissionCheck.error);
            process.exit(1);
        }
    }

    success('Target repository validated.');

    // ── Lifecycle Detection ───────────────────────────────────────────────────
    // Determine what changed since the last install to decide what to skip/install.
    // If lifecycle detection fails, fall back to installing everything (old behavior).
    let lifecycleDecision = null;
    let currentVersion = null;
    let deliveryMethod = null;
    let gitCommitHash = null;
    let currentHashes = {};
    let currentExternalFolderHashes = {};
    let currentExternalManifestKeys = [];
    let currentPyprojectHash = null;
    let currentMcpTemplateHash = null;
    let currentAgentsHash = null;
    let newGeneratedPyprojectHash = null;

    try {
        deliveryMethod = await detectDeliveryMethod(sourcePath);
        currentVersion = await readReleaseVersion(sourcePath);
        gitCommitHash = await getGitCommitHash(sourcePath);
        const existingManifest = await readManifest(targetRepository);

        // Build skillPaths map from availableSkills filtered to selectedSkills.
        // Native skills are hashed individually (keyed by skill name); external
        // skills are hashed at the GROUP level by their provider, so the
        // manifest keyspace mixes skill names and group ids.
        const nativeSkillPaths = {};
        for (const skillName of selectedSkills) {
            const skill = availableSkills.find((s) => s.name === skillName);
            if (
                skill &&
                !externalSkills.ownsSkill(skillName, externalSkillList)
            ) {
                nativeSkillPaths[skillName] = skill.path;
            }
        }
        const hashAllowedRoot = await fs.realpath(sourcePath);
        const nativeHashes = await computeSkillHashes(nativeSkillPaths, {
            allowedRoot: hashAllowedRoot,
        });
        const externalHashes = await externalSkills.computeHashes(
            selectedSkills,
            externalSkillList,
            { allowedRoot: hashAllowedRoot }
        );

        currentHashes = { ...nativeHashes, ...externalHashes };

        // Recorded separately because a group hash cannot be verified against an
        // installed directory: it spans every selected skill in a domain, so no
        // single installed folder reproduces it. verify_integrity.py needs one
        // digest per installed folder, `<agent>/<skill>`, because the agents
        // receive different SKILL.md files; it skips the group keys below.
        currentExternalFolderHashes = await externalSkills.computeFolderHashes(
            selectedSkills,
            externalSkillList,
            agents,
            { allowedRoot: hashAllowedRoot }
        );
        // Which skillHashes keys belong to the external provider (the
        // ai-domain-* group keys), recorded so the checker need not infer it.
        currentExternalManifestKeys = Object.keys(externalHashes).sort();

        // Manifest/lifecycle keyspace: external skills collapse to group ids.
        const manifestSelected = externalSkills.toManifestKeys(
            selectedSkills,
            externalSkillList
        );

        // Compute hashes for meta-files (wrap in try/catch, use null if file doesn't exist)
        try {
            currentPyprojectHash = await computeDependencySetHash(sourcePath);
        } catch {
            currentPyprojectHash = null;
        }

        try {
            currentMcpTemplateHash = await computeFileHash(
                path.join(
                    sourcePath,
                    'skills',
                    'lb-setup',
                    'templates',
                    'lb_mcp.json'
                )
            );
        } catch {
            currentMcpTemplateHash = null;
        }

        try {
            currentAgentsHash = await computeFileHash(
                path.join(sourcePath, 'agent_steering', 'AGENTS.md')
            );
        } catch {
            currentAgentsHash = null;
        }

        // Check if setup_status.md exists
        const statusFileExists = fsSync.existsSync(
            path.join(targetRepository, '.lb_workspace', 'setup_status.md')
        );

        // Check if the generated pyproject.toml would change
        // Compare the hash of what we'd generate NOW against the hash stored in the
        // manifest from the LAST install, rather than hashing the file on disk, which
        // lb-setup may have edited since.
        let generatedPyprojectChanged = false;
        try {
            const { buildPyprojectContent, readDependenciesFromToml } =
                await import('./lib/venvSetup.js');
            const tomlDeps = readDependenciesFromToml(sourcePath);
            const requiresPythonMatch = fsSync
                .readFileSync(
                    path.join(
                        sourcePath,
                        'project_dependencies',
                        'pyproject.toml'
                    ),
                    'utf8'
                )
                .match(/requires-python\s*=\s*"([^"]+)"/);
            const requiresPython = requiresPythonMatch
                ? requiresPythonMatch[1]
                : '>=3.12';
            const newContent = buildPyprojectContent(
                selectedSkills,
                requiresPython,
                tomlDeps
            );
            const crypto = await import('crypto');
            const newHash = crypto
                .createHash('sha256')
                .update(newContent)
                .digest('hex');
            newGeneratedPyprojectHash = newHash;

            if (existingManifest && existingManifest.generatedPyprojectHash) {
                // Compare against the hash stored at last install time (before lb-setup rewrites)
                generatedPyprojectChanged =
                    existingManifest.generatedPyprojectHash !== newHash;
            } else {
                // No stored hash — check if the file exists at all
                const generatedPyprojectPath = path.join(
                    targetRepository,
                    '.lb_workspace',
                    'config',
                    'python_deps',
                    'pyproject.toml'
                );
                generatedPyprojectChanged = !fsSync.existsSync(
                    generatedPyprojectPath
                );
            }
        } catch {
            // If we can't determine, assume changed to be safe
            generatedPyprojectChanged = true;
        }

        // Read MCP-gated skills from the template (source of truth)
        let mcpGatedSkills = [];
        try {
            const mcpTemplatePath = path.join(
                sourcePath,
                'skills',
                'lb-setup',
                'templates',
                'lb_mcp.json'
            );
            const mcpTemplate = JSON.parse(
                fsSync.readFileSync(mcpTemplatePath, 'utf8')
            );
            mcpGatedSkills = Object.values(mcpTemplate.mcpServers || {})
                .filter((server) => server.gatedBySkill)
                .map((server) => server.gatedBySkill);
        } catch {
            // Fallback: empty list (mcp-setup won't be reset based on skill changes)
        }

        lifecycleDecision = determineLifecycle({
            existingManifest,
            currentVersion,
            selectedSkills: manifestSelected,
            currentHashes,
            deliveryMethod,
            installMethod: method,
            sourcePath,
            gitCommitHash,
            currentPyprojectHash,
            currentMcpTemplateHash,
            currentAgentsHash,
            statusFileExists,
            generatedPyprojectChanged,
            mcpGatedSkills,
        });

        // Translate the lifecycle decision from the manifest keyspace (which
        // uses external group ids) back to actual skill names so the install
        // loop, status writer, and reporter all operate on real skills.
        // External group ids expand to the selected skills in that group.
        // `skillsToRemove` stays in the manifest keyspace — its keys come from
        // the OLD manifest and may not map to the current selection; on-disk
        // orphan removal is handled separately by the per-agent orphan scan.
        if (lifecycleDecision) {
            lifecycleDecision = {
                ...lifecycleDecision,
                skillsToInstall: externalSkills.expandManifestKeys(
                    lifecycleDecision.skillsToInstall,
                    selectedSkills,
                    externalSkillList
                ),
                skillsToReset: externalSkills.expandManifestKeys(
                    lifecycleDecision.skillsToReset,
                    selectedSkills,
                    externalSkillList
                ),
                skillsUnchanged: externalSkills.expandManifestKeys(
                    lifecycleDecision.skillsUnchanged,
                    selectedSkills,
                    externalSkillList
                ),
            };
        }

        // For idempotent_rerun: check whether every selected agent actually has
        // the skills on disk before short-circuiting. A new agent (e.g. cursor)
        // added on a second run will have an empty target directory even though
        // the source hashes haven't changed, so we must still install for it.
        // The manifest's hashes come from the target repository, so a re-run also
        // compares each installed directory with this source before deciding there
        // is nothing to do; one that differs is installed again.
        if (lifecycleDecision.scenario === 'idempotent_rerun') {
            const missingSkills = new Set();
            const changedSkills = new Set();
            for (const agent of agents) {
                const baseTargetPath = getTargetPathFromValidator(
                    agent,
                    scope,
                    targetRepository
                );
                for (const skillName of selectedSkills) {
                    const skillTargetPath = path.join(
                        baseTargetPath,
                        skillName
                    );
                    if (!fsSync.existsSync(skillTargetPath)) {
                        missingSkills.add(skillName);
                        continue;
                    }
                    // A linked skills folder on the way is left to the full install
                    // path, whose directory checks refuse it, rather than compared
                    // (the comparison removes bytecode, which would then be outside
                    // the repository).
                    const parts = path
                        .relative(targetRepository, baseTargetPath)
                        .split(path.sep);
                    let walked = targetRepository;
                    let linkedParent = false;
                    for (const part of parts) {
                        walked = path.join(walked, part);
                        if (fsSync.lstatSync(walked).isSymbolicLink()) {
                            linkedParent = true;
                            break;
                        }
                    }
                    if (linkedParent) {
                        missingSkills.add(skillName);
                        continue;
                    }
                    // A same-named folder LaunchBridge didn't install is the
                    // user's: the comparison below removes bytecode from it, so
                    // leave it to the full install path's ownership check.
                    if (
                        !wasInstalledByLaunchBridge(skillTargetPath, skillName)
                    ) {
                        missingSkills.add(skillName);
                        continue;
                    }
                    const native = nativeSkillPaths[skillName];
                    const sourceDir =
                        native ??
                        externalSkillList.find((s) => s.name === skillName)
                            ?.path;
                    if (
                        !(await installedSkillMatches(
                            skillTargetPath,
                            sourceDir,
                            sourcePath
                        ))
                    ) {
                        changedSkills.add(skillName);
                        missingSkills.add(skillName);
                    }
                }
            }
            if (changedSkills.size > 0) {
                warn(
                    `Installed skill content differs from this LaunchBridge source, so these are installed again: ${[...changedSkills].join(', ')}`
                );
            }

            if (missingSkills.size === 0) {
                // Nothing to install. The Python dependency config and its record
                // are still rewritten from this source: the record lives outside
                // the repository and is missing after a move, on a new machine or
                // with a fresh home directory, and lb-setup asks for an installer
                // run to restore it.
                const venv = await runVenvSetup(
                    targetRepository,
                    sourcePath,
                    selectedSkills
                );
                if (!venv.ok) {
                    warn(
                        `Could not write the Python dependency config to .lb_workspace/config/python_deps/: ${venv.error}`
                    );
                }
                const emptyReport = {
                    successful: [],
                    failed: [],
                    skipped: [],
                };
                const lifecycleReport = buildLifecycleReport(
                    emptyReport,
                    lifecycleDecision
                );
                spacer();
                displayLifecycleReport(lifecycleReport);
                process.exit(0);
            }

            // Some agents are missing skills on disk — promote to incremental_update
            // so the install loop runs for the missing skills.
            lifecycleDecision = {
                ...lifecycleDecision,
                scenario: 'incremental_update',
                skillsToInstall: [...missingSkills],
                skillsUnchanged: selectedSkills.filter(
                    (s) => !missingSkills.has(s)
                ),
            };
        }

        // Display warnings before installation proceeds (Task 11.6)
        if (
            lifecycleDecision.warnings &&
            lifecycleDecision.warnings.length > 0
        ) {
            for (const warning of lifecycleDecision.warnings) {
                warn(warning);
            }
            spacer();
        }
    } catch {
        // If lifecycle detection fails, fall back to existing behavior (install everything)
        lifecycleDecision = null;
    }

    // Determine which skills to install in the per-agent loop
    // If lifecycle detection succeeded, filter to only skillsToInstall; otherwise install all
    const allSelectedSkills = [...selectedSkills];
    const skillsForInstallLoop = lifecycleDecision
        ? selectedSkills.filter((s) =>
              lifecycleDecision.skillsToInstall.includes(s)
          )
        : selectedSkills;

    step(3, 'Installing Skills');
    spacer();

    // Step 5: Execute installation for each agent and skill combination
    /** @type {import('./lib/installer.js').InstallationResult[]} */
    const results = [];
    let cancelAll = false;
    // Auto-overwrite without prompting when the install method changed (symlink→copy or vice versa).
    // The user already confirmed the new method at the selection step, so re-prompting for each
    // skill conflict would be confusing and could leave a mix of symlinks and copies on disk.
    const methodChanged =
        existingManifestForPrompts?.installMethod != null &&
        existingManifestForPrompts.installMethod !== method;
    let overwriteAll = resolvedFlags.yes || methodChanged ? true : false;
    // Track which target paths have already been scanned for orphans so that
    // agents sharing the same skillsDir (e.g. cline/codex/cursor all use
    // .agents/skills) don't trigger the same prompt multiple times.
    const handledOrphanPaths = new Set();
    // Track whether any skill directories were removed (orphan cleanup), so the
    // workspace/status refresh runs even on removal-only runs with no installs.
    let orphansRemoved = false;

    // Copy mode follows links inside skills only when they stay in the source tree.
    const copyAllowedRoot = await fs.realpath(sourcePath);

    for (const agent of agents) {
        if (cancelAll) break;

        // Get the base target path for this agent and scope
        const baseTargetPath = getTargetPathFromValidator(
            agent,
            scope,
            targetRepository
        );

        // Refuse a skills directory reached through a symlink: writes and the
        // orphan cleanup below would land outside the target repository.
        const dirCheck = await checkSkillsDirectory(
            baseTargetPath,
            targetRepository
        );
        if (!dirCheck.ok) {
            const errorMessage = `Refusing to use ${baseTargetPath}: ${dirCheck.reason}`;
            console.error(`Error for ${agent}: ${errorMessage}`);
            for (const skillName of skillsForInstallLoop) {
                results.push({
                    skillName,
                    agent,
                    success: false,
                    error: errorMessage,
                    targetPath: path.join(baseTargetPath, skillName),
                });
            }
            continue;
        }

        // Ensure the target directory exists
        try {
            await ensureTargetDirectory(baseTargetPath);
        } catch (error) {
            // Format error message with helpful suggestions
            let errorMessage = error.message;

            // Add platform-specific suggestions for permission errors
            if (
                error.code === 'EACCES' ||
                error.code === 'EPERM' ||
                errorMessage.includes('Permission denied')
            ) {
                if (!errorMessage.includes(PERMISSION_HINT)) {
                    errorMessage += ` ${PERMISSION_HINT}`;
                }
            }

            console.error(
                `Error creating target directory for ${agent}: ${errorMessage}`
            );
            // Mark all skills for this agent as failed but continue with other agents (error resilience - Requirement 9.4)
            for (const skillName of skillsForInstallLoop) {
                results.push({
                    skillName,
                    agent,
                    success: false,
                    error: `Failed to create target directory: ${errorMessage}`,
                    targetPath: path.join(baseTargetPath, skillName),
                });
            }
            continue;
        }

        // Check for orphaned skill directories (exist in target but not in current skill list).
        // Skip if this path was already handled by a previous agent (shared skillsDir).
        if (!handledOrphanPaths.has(baseTargetPath)) {
            handledOrphanPaths.add(baseTargetPath);
            try {
                const orphanResult = await cleanupOrphanSkills({
                    baseTargetPath,
                    targetRepository,
                    selectedSkills,
                    previouslyInstalled: priorTargets
                        ? namesUnder(
                              priorTargets,
                              targetRepository,
                              baseTargetPath
                          )
                        : previouslyInstalledSkills,
                    yes: resolvedFlags.yes,
                    prompt: promptForOrphanResolution,
                    onWarn: warn,
                });
                if (orphanResult.action === 'cancel') {
                    cancelAll = true;
                    break;
                }
                for (const orphan of orphanResult.removed) {
                    orphansRemoved = true;
                    muted(`Removed orphaned directory: ${orphan}`);
                }
                if (orphanResult.removed.length) spacer();
            } catch (error) {
                // Non-fatal — if we can't scan, just proceed with installation
                if (error.code !== 'ENOENT') {
                    console.warn(
                        `Warning: Could not scan for orphaned skills in ${baseTargetPath}: ${error.message}`
                    );
                }
            }
        }

        for (const skillName of skillsForInstallLoop) {
            if (cancelAll) break;

            // Find the skill object to get its source path
            const skill = availableSkills.find((s) => s.name === skillName);
            if (!skill) {
                results.push({
                    skillName,
                    agent,
                    success: false,
                    error: 'Skill not found in available skills',
                    targetPath: path.join(baseTargetPath, skillName),
                });
                continue;
            }

            // Resolve the source path. External skills (e.g. AI skills) are
            // resolved by their provider (the same folder for every agent,
            // whose own files adaptForAgent writes after the install);
            // native skills use their single discovered path.
            const skillSourcePath = externalSkills.ownsSkill(
                skillName,
                externalSkillList
            )
                ? externalSkills.resolveSource(skill)
                : skill.path;
            const skillTargetPath = path.join(baseTargetPath, skillName);
            const exists = await pathExists(skillTargetPath);
            if (exists) {
                let resolution;

                // Only a directory the previous install recorded is replaced
                // without asking; a same-named directory of the user's own is not.
                const previouslyInstalled = wasInstalledByLaunchBridge(
                    skillTargetPath,
                    skillName
                );
                const decision = decideExistingSkillPath({
                    overwriteAll,
                    yes: resolvedFlags.yes,
                    previouslyInstalled,
                });
                if (decision === 'skip') {
                    foreignTargets.add(
                        targetKey(targetRepository, skillTargetPath)
                    );
                    const reason = `${skillTargetPath} exists and was not installed by LaunchBridge; left unchanged (--yes never replaces it).`;
                    warn(reason);
                    results.push({
                        skillName,
                        agent,
                        success: false,
                        error: reason,
                        targetPath: skillTargetPath,
                    });
                    displayProgress(skillName, agent, 'skipped');
                    continue;
                }
                resolution =
                    decision === 'overwrite'
                        ? 'overwrite'
                        : await promptForConflictResolution(skillName);

                if (resolution === 'cancel') {
                    cancelAll = true;
                    results.push({
                        skillName,
                        agent,
                        success: false,
                        error: 'Installation cancelled by user',
                        targetPath: skillTargetPath,
                    });
                    displayProgress(skillName, agent, 'skipped');
                    break;
                }

                if (resolution === 'skip') {
                    if (!previouslyInstalled) {
                        foreignTargets.add(
                            targetKey(targetRepository, skillTargetPath)
                        );
                    }
                    results.push({
                        skillName,
                        agent,
                        success: true,
                        error: 'Skipped by user',
                        targetPath: skillTargetPath,
                    });
                    displayProgress(skillName, agent, 'skipped');
                    continue;
                }

                if (resolution === 'overwriteAll') {
                    overwriteAll = true;
                }

                // resolution === 'overwrite' or 'overwriteAll'
                try {
                    await removePath(skillTargetPath);
                } catch (error) {
                    results.push({
                        skillName,
                        agent,
                        success: false,
                        error: `Failed to remove existing path: ${error.message}`,
                        targetPath: skillTargetPath,
                    });
                    displayProgress(skillName, agent, 'failure');
                    continue;
                }
            }

            // Install the skill
            try {
                if (method === 'symlink') {
                    await createSymlink(skillSourcePath, skillTargetPath);
                } else {
                    await copySkill(skillSourcePath, skillTargetPath, {
                        allowedRoot: copyAllowedRoot,
                        onSkip: (src, resolved) =>
                            warn(
                                `Skipped link outside the LaunchBridge source: ${src} -> ${resolved}`
                            ),
                    });
                }
                if (externalSkills.ownsSkill(skillName, externalSkillList)) {
                    await externalSkills.adaptForAgent(
                        skill,
                        agent,
                        skillTargetPath,
                        agents
                    );
                }

                results.push({
                    skillName,
                    agent,
                    success: true,
                    targetPath: skillTargetPath,
                });
                displayProgress(skillName, agent, 'success');
            } catch (error) {
                // Format error message with helpful suggestions
                let errorMessage = error.message;

                // Add platform-specific suggestions for permission errors
                if (
                    error.code === 'EACCES' ||
                    error.code === 'EPERM' ||
                    errorMessage.includes('Permission denied') ||
                    errorMessage.includes('EPERM')
                ) {
                    if (process.platform === 'win32' && method === 'symlink') {
                        // Windows symlink-specific suggestion (already in installer.js, but ensure it's clear)
                        if (!errorMessage.includes('Developer Mode')) {
                            errorMessage +=
                                '\nOn Windows, symlinks require Developer Mode; or install with --method copy, which needs no symlinks.';
                        }
                    } else if (!errorMessage.includes(PERMISSION_HINT)) {
                        errorMessage += ` ${PERMISSION_HINT}`;
                    }
                }

                results.push({
                    skillName,
                    agent,
                    success: false,
                    error: errorMessage,
                    targetPath: skillTargetPath,
                });
                displayProgress(skillName, agent, 'failure');
                // Continue with remaining skills (error resilience - Requirement 9.4)
            }
        }
    }

    // Step 6: Verify all installations
    spacer();
    const verificationResults = results.map((result) =>
        verifyInstallation(result, method)
    );

    // Update results based on verification
    for (let i = 0; i < results.length; i++) {
        if (results[i].success && !verificationResults[i].verified) {
            results[i].success = false;
            results[i].error =
                verificationResults[i].error || 'Verification failed';
        }
    }

    // Step 6.5: Run folder setup to create .ci-extension structure
    const successfulInstalls = results.filter(
        (r) => r.success && !r.error?.includes('Skipped')
    );
    // Refresh the workspace (folder structure, setup_status.md, deps) when
    // anything was installed OR removed. Removal-only runs must still update
    // setup_status.md so removed skills flip to "not installed".
    const removalsOccurred =
        orphansRemoved ||
        (lifecycleDecision && lifecycleDecision.skillsToRemove.length > 0);
    const workspaceNeedsUpdate =
        successfulInstalls.length > 0 || removalsOccurred;
    let venvWarning = null;
    if (workspaceNeedsUpdate) {
        step(4, 'Environment Setup');
        spacer();

        const { runFolderSetup } = await import('./lib/folderSetup.js');
        await runFolderSetup(targetRepository, allSelectedSkills);
        spacer();

        // Write setup_status.md — use lifecycle-aware status resets if available
        const installedSkillNames = [
            ...new Set(successfulInstalls.map((r) => r.skillName)),
        ];

        if (lifecycleDecision) {
            // Task 11.2: Lifecycle-aware status writing
            const statusFilePath = path.join(
                targetRepository,
                '.lb_workspace',
                'setup_status.md'
            );
            let existingStatuses = new Map();
            let fileExists = false;

            try {
                const existingContent = await fs.readFile(
                    statusFilePath,
                    'utf8'
                );
                existingStatuses = parseSetupStatusContent(existingContent);
                fileExists = true;
            } catch {
                // File doesn't exist — start fresh
            }

            try {
                const rows = applyStatusResets(
                    existingStatuses,
                    allSelectedSkills,
                    lifecycleDecision
                );
                // Append group-level rows for external skills (provider-owned).
                const externalRows = externalSkills.buildStatusRows(
                    existingStatuses,
                    allSelectedSkills,
                    externalSkillList
                );
                const content = buildMarkdownTable([...rows, ...externalRows]);
                await fs.writeFile(statusFilePath, content, 'utf8');
                if (fileExists) {
                    success(
                        'setup_status.md updated — newly added skills are queued for setup.'
                    );
                } else {
                    success('setup_status.md created.');
                }
            } catch (err) {
                warn(`Could not write setup_status.md: ${err.message}`);
            }
        } else {
            // Fallback: use existing writeSetupStatus when lifecycle detection failed
            const { writeSetupStatus } = await import('./lib/setupStatus.js');
            const statusResult = await writeSetupStatus(
                targetRepository,
                installedSkillNames,
                (existing, installed) =>
                    externalSkills.buildStatusRows(
                        existing,
                        installed,
                        externalSkillList
                    )
            );
            if (statusResult.status === 'created') {
                success('setup_status.md created.');
            } else if (statusResult.status === 'merged') {
                success(
                    'setup_status.md updated — newly added skills are queued for setup.'
                );
            } else if (statusResult.status === 'error') {
                warn(`Could not write setup_status.md: ${statusResult.error}`);
            }
        }

        // Step 6.6: Set up Python virtual environment and install dependencies
        const venv = await runVenvSetup(
            targetRepository,
            sourcePath,
            allSelectedSkills
        );
        if (!venv.ok) {
            venvWarning = `Could not write the Python dependency config to .lb_workspace/config/python_deps/: ${venv.error} Fix that and re-run the installer before running lb-setup.`;
        }

        // Step 6.7: Copy AGENTS.md into the target repository
        const { copyAgentsSteering } = await import('./lib/agentsSteering.js');
        const agentsResult = await copyAgentsSteering(targetRepository);
        if (agentsResult.status === 'copied') {
            success('AGENTS.md copied to target repository.');
        } else if (agentsResult.status === 'copied_as_lb') {
            warn(agentsResult.message);
        } else if (agentsResult.status === 'error') {
            warn(`Could not copy AGENTS.md: ${agentsResult.error}`);
        }

        // Step 6.8: Copy CLAUDE.md into the target repository
        const { copyClaudeMd } = await import('./lib/claudeMd.js');
        const claudeResult = await copyClaudeMd(targetRepository);
        if (
            claudeResult.status === 'created' ||
            claudeResult.status === 'updated'
        ) {
            success(claudeResult.message);
        } else if (claudeResult.status === 'error') {
            warn(`Could not copy CLAUDE.md: ${claudeResult.error}`);
        }
    }

    // Task 11.3: Write Version_Manifest — always runs when lifecycle detection
    // succeeded, regardless of whether any skills were installed in this run.
    // This ensures removed/orphaned skills are dropped from skillHashes even
    // when the remaining selected skills were all unchanged (no files installed).
    if (lifecycleDecision && currentVersion) {
        try {
            // Record the skill directories LaunchBridge now owns: those this
            // run installed, plus earlier ones still present and not skipped.
            const installedNow = new Set(
                results
                    .filter((r) => r.success && !r.error?.includes('Skipped'))
                    .map((r) => targetKey(targetRepository, r.targetPath))
            );
            const installedTargets = new Set();
            for (const agent of agents) {
                const base = getTargetPathFromValidator(
                    agent,
                    scope,
                    targetRepository
                );
                for (const skillName of allSelectedSkills) {
                    const skillPath = path.join(base, skillName);
                    const key = targetKey(targetRepository, skillPath);
                    if (
                        installedNow.has(key) ||
                        (!foreignTargets.has(key) &&
                            wasInstalledByLaunchBridge(skillPath, skillName) &&
                            (await pathExists(skillPath)))
                    ) {
                        installedTargets.add(key);
                    }
                }
            }
            const newManifest = {
                version: currentVersion,
                timestamp: new Date().toISOString(),
                deliveryMethod,
                agents,
                installMethod: method,
                gitCommitHash: gitCommitHash || undefined,
                sourcePath,
                skillHashes: currentHashes,
                installedTargets: [...installedTargets].sort(),
                externalSkillHashes: currentExternalManifestKeys.length
                    ? currentExternalFolderHashes
                    : undefined,
                externalManifestKeys: currentExternalManifestKeys.length
                    ? currentExternalManifestKeys
                    : undefined,
                pyprojectHash: currentPyprojectHash || undefined,
                mcpTemplateHash: currentMcpTemplateHash || undefined,
                agentsHash: currentAgentsHash || undefined,
                generatedPyprojectHash: newGeneratedPyprojectHash || undefined,
            };
            await writeManifest(targetRepository, newManifest);
        } catch {
            warn('Could not write version manifest.');
        }
    }

    // Step 7: Build and display final report
    const report = {
        successful: results.filter(
            (r) => r.success && !r.error?.includes('Skipped')
        ),
        failed: results.filter(
            (r) => !r.success && !r.error?.includes('cancelled')
        ),
        skipped: results.filter(
            (r) =>
                r.error?.includes('Skipped') || r.error?.includes('cancelled')
        ),
        warnings: venvWarning ? [venvWarning] : [],
    };

    spacer();

    // Task 11.4: Use lifecycle-aware reporting when available
    if (lifecycleDecision) {
        const lifecycleReport = buildLifecycleReport(report, lifecycleDecision);
        displayLifecycleReport(lifecycleReport);
    } else {
        displayFinalReport(report);
    }

    // Step 8: Exit with appropriate code
    const exitCode = getExitCode(report);
    process.exit(exitCode);
}

main().catch((error) => {
    let errorMessage = error.message;

    if (
        error.code === 'EACCES' ||
        error.code === 'EPERM' ||
        errorMessage.includes('Permission denied') ||
        errorMessage.includes('EPERM')
    ) {
        if (!errorMessage.includes(PERMISSION_HINT)) {
            errorMessage += ` ${PERMISSION_HINT}`;
        }
    }

    import('./lib/ui.js')
        .then(({ error: uiErr }) => {
            uiErr(errorMessage);
            process.exit(1);
        })
        .catch(() => {
            console.error('Error:', errorMessage);
            process.exit(1);
        });
});
