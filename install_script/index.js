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
import os from 'os';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync from 'fs';
import chalk from 'chalk';

import { buildPythonDepsFiles, runVenvSetup } from './lib/venvSetup.js';

import {
    promptForAgents,
    defaultScope,
    promptForScope,
    resolveScope,
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
    skillLayout,
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
    linkedFoldersWarning,
} from './lib/reporter.js';
import { decideUpdate, parseApplyCommit } from './lib/updateDecision.js';
import { parseCLIFlags } from './lib/cliFlags.js';
import { decideExistingSkillPath } from './lib/conflictDecision.js';
import { removePath, cleanupOrphanSkills } from './lib/orphanCleanup.js';
import { stripControlCharacters } from './lib/terminalText.js';
import {
    getTargetPath as getTargetPathFromValidator,
    validateTargetDirectory,
    checkWritePermissions,
    checkSkillsDirectory,
    checkGlobalSkillsDirectory,
    checkWorkspace,
} from './lib/pathValidator.js';
import {
    GLOBAL_MANIFEST,
    GLOBAL_PENDING,
    globalGeneratedDir,
    globalStateDir,
    readGlobalManifest,
    readGlobalPending,
    recordGlobalInstallSource,
    removeGlobalPending,
    writeGlobalPending,
    writeGlobalState,
} from './lib/stateDir.js';
import { SKILL_REQUIRES_SETUP } from './lib/skillDiscovery.js';
import {
    ASSET_SOURCES,
    assetDigests,
    buildGlobalAssets,
    folderHolds,
    globalAssetsMatch,
    keepPreviousAssetFields,
    preparedForGlobalInstall,
    writeGlobalAssets,
} from './lib/globalAssets.js';
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
import {
    entriesNotInstalled,
    installedLayout,
    installedSkillMatches,
} from './lib/installedContent.js';
import { readManifest, writeManifest } from './lib/versionManifest.js';
import {
    targetKey,
    readInstalledTargets,
    namesUnder,
    recordedOrphans,
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
// Loaded before `launchbridge update` pulls: a module first loaded after the
// pull would be the new release's, linked to this release's modules.
import { runInstallSyncs, syncsIncomplete } from './lib/globalSync.js';
import { applyStatusResets } from './lib/statusReset.js';
import {
    parseSetupStatusContent,
    buildMarkdownTable,
} from './lib/setupStatus.js';
import { uncommittedSkillChanges } from './lib/sourceChanges.js';

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
 * Exits 0 on success (including "declined"), 1 on failure: the update itself
 * failed, or afterwards the global install could not be fully updated, this
 * folder's local install was not updated because its workspace was refused,
 * or the sync stopped with an error.
 */
async function runUpdateCommand() {
    const { runUpdate } = await import('./lib/updater.js');
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

    // Post-pull sync: the global install, when there is one (skills in the
    // agents' user-level folders), then this folder's local install, when it
    // has one: re-copy changed skills and regenerate the Python dependency
    // config where needed.
    spacer();
    let incomplete = false;
    try {
        const syncs = await runInstallSyncs(sourcePath, targetRepo, {
            step,
            success,
            warn,
            muted,
            spacer,
        });
        incomplete = syncsIncomplete(syncs);
        if (
            !syncs.global.skippedNoManifest &&
            !syncs.global.skippedOtherSource
        ) {
            muted(
                '  Repositories pick up the global changes the next time lb-setup runs in them.'
            );
            spacer();
        }
        const syncResult = syncs.local ?? { skippedNoManifest: true };

        if (syncs.localSkipped) {
            warn(
                `Not updating this folder's local install: ${syncs.localSkipped}`
            );
        } else if (syncResult.skippedNoManifest) {
            muted(
                syncs.global.skippedNoManifest
                    ? 'No LaunchBridge install found here or globally — skipping skill sync.'
                    : 'This folder has no local LaunchBridge install.'
            );
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
        incomplete = true;
    }

    spacer();
    if (incomplete) {
        uiError(
            'Not every install could be brought up to date; see the warnings above.'
        );
        spacer();
        process.exit(1);
    }
    process.exit(0);
}

/**
 * Validates CLI flag values and resolves them to usable selections.
 * Exits with code 1 and a clear error message if any flag value is invalid.
 *
 * @param {import('./lib/cliFlags.js').CLIFlags} flags - From parseCLIFlags
 * @param {import('./lib/skillDiscovery.js').Skill[]} availableSkills - Discovered skills from source
 * @param {import('./lib/skillDiscovery.js').SkillCategory[]} [categories] - Categories to resolve against (defaults to SKILL_CATEGORIES)
 * @returns {{ agents: string[]|null, scope: 'local'|'global'|null, method: string|null, skills: string[]|null, yes: boolean }}
 */
function validateAndResolveFlags(
    flags,
    availableSkills,
    categories = SKILL_CATEGORIES
) {
    const resolved = {
        agents: null,
        scope: null,
        method: null,
        skills: null,
        yes: flags.yes,
    };

    // Validate --scope
    if (flags.scope !== null) {
        if (flags.scope !== 'global' && flags.scope !== 'local') {
            console.error(
                `Invalid scope: '${flags.scope}'. Use 'global' or 'local'.`
            );
            process.exit(1);
        }
        resolved.scope = flags.scope;
    }

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
    if (flags.method !== null) {
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
 * Runs when launchbridge is an npm package (`npm install -g`) rather
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
    // An npm package (npm install -g) hands over to ~/.launchbridge,
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

    // CLI flags for non-interactive operation; `update` reads its own above.
    const cliFlags = parseCLIFlags(process.argv.slice(2));
    if (cliFlags.error) {
        console.error(cliFlags.error);
        process.exit(1);
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

    const resolvedFlags = validateAndResolveFlags(
        cliFlags.flags,
        availableSkills,
        allCategories
    );

    // Step 3: Get user selections (skip prompts when flags are provided)
    step(1, 'Configure Installation');

    // Get target repository path (current working directory)
    const targetRepository = process.cwd();

    // A local install writes into .lb_workspace, and every write there must
    // land inside the target repository. Checked now and refused once the
    // scope is known; a global install writes nothing into this folder.
    const workspaceCheck =
        resolvedFlags.scope === 'global'
            ? { ok: false, reason: 'not checked for a global install' }
            : await checkWorkspace(targetRepository);
    const localManifest = workspaceCheck.ok
        ? await readManifest(targetRepository)
        : null;
    const globalManifest = await readGlobalManifest();
    // A local install counts even where its workspace is refused (or not
    // checked, for --scope global): Local stays the default there, and
    // choosing it is refused with the reason.
    const hasLocalInstall =
        Boolean(localManifest) ||
        fsSync.existsSync(
            path.join(
                targetRepository,
                '.lb_workspace',
                'config',
                'version_manifest.json'
            )
        );

    // The agents prompt comes before the scope prompt, so it is pre-checked
    // from the manifest of the scope given by flag, or else of the default
    // scope: this folder's local install when it has one, else the global one.
    const existingInstalls = {
        localInstall: hasLocalInstall,
        globalInstall: Boolean(globalManifest),
    };
    const agentsFrom = resolvedFlags.scope ?? defaultScope(existingInstalls);
    const manifestAgents =
        (agentsFrom === 'local' ? localManifest : globalManifest)?.agents ??
        null;
    const agents = resolvedFlags.agents
        ? resolvedFlags.agents
        : await promptForAgents(manifestAgents, { from: agentsFrom });
    const scope = await resolveScope(
        resolvedFlags,
        () => promptForScope(agents, existingInstalls),
        existingInstalls
    );
    if (scope === 'local' && !workspaceCheck.ok) {
        uiError(`Refusing to install: ${workspaceCheck.reason}`);
        process.exit(1);
    }
    // Skill directory records are keyed relative to this root: the target
    // repository for a local install, the home directory for a global one.
    const installRoot = scope === 'global' ? os.homedir() : targetRepository;
    const readScopeManifest = () =>
        scope === 'global'
            ? readGlobalManifest()
            : readManifest(targetRepository);
    const bothInstalls =
        'Where both exist, Claude Code and Cline run the global skills, and Kiro and Roo Code the local ones. ' +
        'lb-setup from the global install refuses to prepare a repository that has a local install, ' +
        'so keep one of them for this repository.';
    if (scope === 'global' && hasLocalInstall) {
        warn(
            `This folder also has a local LaunchBridge install. ${bothInstalls}`
        );
    } else if (scope === 'local' && globalManifest) {
        warn(`A global LaunchBridge install exists too. ${bothInstalls}`);
    }

    // The existing manifest for this scope pre-populates the skill selection
    const existingManifestForPrompts =
        scope === 'global' ? globalManifest : localManifest;
    const manifestSkills =
        Array.isArray(existingManifestForPrompts?.skills) &&
        existingManifestForPrompts.skills.length > 0
            ? existingManifestForPrompts.skills
            : existingManifestForPrompts?.skillHashes
              ? Object.keys(existingManifestForPrompts.skillHashes)
              : null;

    const method = resolvedFlags.method
        ? resolvedFlags.method
        : await promptForMethod();
    const linkedFolders = linkedFoldersWarning(method, agents);
    if (linkedFolders) warn(linkedFolders);
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

    // The skill folders a global install that did not finish (it was
    // interrupted, or could not write its record) had started on. Those that
    // exist are LaunchBridge's, as recorded ones are, until a run finishes
    // them.
    let unfinishedRun = null;
    if (scope === 'global') {
        try {
            unfinishedRun = await readGlobalPending();
        } catch (err) {
            const hint =
                err.code === 'EACCES' || err.code === 'EPERM'
                    ? ` ${PERMISSION_HINT}`
                    : '';
            uiError(
                `Cannot read ${path.join(globalStateDir(), GLOBAL_PENDING)}, the list of skill folders an earlier global install did not finish: ${err.message}. Nothing was installed; fix or remove that file and run the installer again.${hint}`
            );
            process.exit(1);
        }
    }
    /** @type {Set<string>} */
    const unfinishedTargets = new Set();
    for (const key of unfinishedRun ?? []) {
        const exists = await pathExists(
            path.join(installRoot, ...key.split('/'))
        ).catch(() => false);
        if (exists) unfinishedTargets.add(key);
    }
    const recordedTargets = readInstalledTargets(existingManifestForPrompts);
    // A folder only such a run had started on did not exist before it, or
    // the user said to replace it, so it is replaced without asking.
    const isUnrecordedUnfinished = (skillTargetPath) => {
        const key = targetKey(installRoot, skillTargetPath);
        return unfinishedTargets.has(key) && !recordedTargets?.has(key);
    };

    // Skill directories LaunchBridge installed, recorded per directory. A
    // manifest from before this record falls back to the skill names above.
    const priorTargets =
        recordedTargets || unfinishedTargets.size > 0
            ? new Set([...(recordedTargets ?? []), ...unfinishedTargets])
            : null;
    const wasInstalledByLaunchBridge = (skillTargetPath, skillName) =>
        priorTargets
            ? priorTargets.has(targetKey(installRoot, skillTargetPath))
            : (manifestSkills ?? []).includes(skillName) ||
              priorExternalNames.includes(skillName);
    // Existing directories this run left alone because LaunchBridge did not
    // install them; they are never recorded as installed.
    const foreignTargets = new Set();

    // Every agent's skills directory for this scope, checked before anything
    // is written. A global install's directories are under the home directory
    // and may be reached through links (a ~/.claude kept in a dotfiles
    // repository), but never into the LaunchBridge source.
    const targets = [];
    /** @type {Map<string, string>} Each global skills folder's real location */
    const realDirs = new Map();
    for (const agent of agents) {
        const dir = getTargetPathFromValidator(agent, scope, targetRepository);
        if (scope === 'global') {
            const check = await checkGlobalSkillsDirectory(dir, {
                sourcePath,
            });
            if (!check.ok) {
                uiError(`Refusing to install for ${agent}: ${check.reason}`);
                process.exit(1);
            }
            targets.push({
                agent,
                path: dir,
                realPath: check.linked ? check.realPath : undefined,
            });
            realDirs.set(dir, check.realPath);
        } else {
            targets.push({ agent, path: dir });
        }
    }
    const skillsDirs = [...new Set(targets.map((t) => t.path))];

    // Two agents' skills folders that are one folder through a link would
    // each install into it, and each treat what the other installed as not
    // LaunchBridge's. Agents that name the same folder (Codex, pi and other
    // agents in ~/.agents/skills) share it as one.
    const firstDirAt = new Map();
    for (const [dir, real] of realDirs) {
        const other = firstDirAt.get(real);
        if (other === undefined) {
            firstDirAt.set(real, dir);
            continue;
        }
        const agentsAt = (d) =>
            targets
                .filter((t) => t.path === d)
                .map((t) => AGENTS[t.agent]?.displayName ?? t.agent)
                .join(' and ');
        uiError(
            `Refusing to install: ${other} (${agentsAt(other)}) and ${dir} (${agentsAt(dir)}) are the same folder (${real}), through a link. ` +
                `Select ${agentsAt(other)} or ${agentsAt(dir)}, not both (the other reads the same skills through the link), or make the two folders separate.`
        );
        process.exit(1);
    }

    // In a global install Codex, pi and other agents share ~/.agents/skills,
    // which holds one agent's copy of each AI skill.
    if (
        scope === 'global' &&
        selectedSkills.some((s) =>
            externalSkills.ownsSkill(s, externalSkillList)
        )
    ) {
        for (const { dir, owner, others } of externalSkills.sharedDirectories(
            agents,
            scope
        )) {
            const label = (name) => AGENTS[name]?.displayName ?? name;
            warn(
                `~/${dir} is shared by ${[owner, ...others].map(label).join(', ')}. ` +
                    `It holds ${label(owner)}'s form of the AI skills, which ` +
                    `${others.map(label).join(' and ')} will read too.`
            );
        }
    }

    // Build selections object
    const selections = {
        agents,
        scope,
        method,
        sourcePath,
        skills: selectedSkills,
        targets,
    };

    // Step 4: Show summary and get confirmation
    spacer();
    const summary = displaySummary(selections);

    // What this run takes from the clone's working tree that the clone has
    // not committed: the selected skills, and the files lb-setup's AGENTS.md
    // reference and Python dependency files are built from.
    let uncommitted = null;
    try {
        uncommitted = await uncommittedSkillChanges(sourcePath, [
            ...availableSkills
                .filter((s) => selectedSkills.includes(s.name))
                .map((s) => ({ name: s.name, path: s.path })),
            ...ASSET_SOURCES.map((rel) => ({
                name: rel,
                path: path.join(sourcePath, ...rel.split('/')),
            })),
        ]);
    } catch (err) {
        spacer();
        warn(
            `Could not check the LaunchBridge clone for changes that are not committed: ${err.message}`
        );
    }
    const uncommittedNames = selectedSkills.filter((name) =>
        uncommitted?.has(name)
    );
    const uncommittedSources = ASSET_SOURCES.filter((rel) =>
        uncommitted?.has(rel)
    );
    if (uncommittedNames.length > 0 || uncommittedSources.length > 0) {
        const parts = [];
        if (uncommittedNames.length > 0) {
            parts.push(
                `These skills are installed as they are in the LaunchBridge clone, which has changes to them that are not committed: ${uncommittedNames.join(', ')}.`
            );
        }
        if (uncommittedSources.length > 0) {
            parts.push(
                uncommittedNames.length > 0
                    ? `lb-setup's AGENTS.md reference and Python dependency files are built from files with such changes too: ${uncommittedSources.join(', ')}.`
                    : `lb-setup's AGENTS.md reference and Python dependency files are built from files the LaunchBridge clone has changes to that are not committed: ${uncommittedSources.join(', ')}.`
            );
        }
        parts.push(`To see the changes: git -C "${sourcePath}" status`);
        spacer();
        warn(parts.join(' '));
    }
    if (unfinishedTargets.size > 0) {
        spacer();
        warn(
            "An earlier global install did not finish. The skill folders it had started on are LaunchBridge's, and this run finishes those of the agents and skills you selected."
        );
    }

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

    success(
        scope === 'global'
            ? 'Skills folders validated.'
            : 'Target repository validated.'
    );

    // A global install generates, into the global state directory, the files
    // a local install writes into the repository; lb-setup copies them into
    // each repository it prepares. Built before anything is installed, so a
    // source that cannot produce them changes nothing.
    let globalAssets = null;
    let globalAssetDigests = null;
    if (scope === 'global') {
        try {
            globalAssets = buildGlobalAssets({
                sourcePath,
                selectedSkills,
                extraStatusRows: externalSkills.buildStatusRows(
                    new Map(),
                    selectedSkills,
                    externalSkillList
                ),
            });
            globalAssetDigests = assetDigests(globalAssets);
        } catch (err) {
            uiError(`Cannot prepare the files lb-setup needs: ${err.message}`);
            process.exit(1);
        }
    }

    // ── Lifecycle Detection ───────────────────────────────────────────────────
    // Determine what changed since the last install to decide what to skip/install.
    // If lifecycle detection fails, fall back to installing everything (old behavior).
    let lifecycleDecision = null;
    let lifecycleError = null;
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
    let mcpGatedSkills = [];
    // The skill folders the install loop writes when only some agents' copies
    // need it, e.g. an agent added on a re-run. A copy LaunchBridge installed
    // that is already up to date is then left alone, without asking about it.
    // null: every selected agent's copy of each skill in skillsToInstall.
    /** @type {Set<string> | null} */
    let pendingTargets = null;
    // The install method differs from the one this scope's install recorded.
    const methodChanged =
        existingManifestForPrompts?.installMethod != null &&
        existingManifestForPrompts.installMethod !== method;
    // Skill folders LaunchBridge installed the way an older symlink install
    // did (a real folder of per-file links) that hold nothing else; they are
    // replaced without asking, as after a change of install method. A folder
    // laid out any other way than this run installs it is asked about, as
    // one whose content differs is.
    /** @type {Set<string>} */
    const relayoutTargets = new Set();
    // Skill folders a re-run found holding what this source installs there,
    // by targetKey: one an unfinished run had started on needs nothing more.
    /** @type {Set<string>} */
    const matchingTargets = new Set();
    // How this run installs a skill for an agent (installer.js skillLayout),
    // and the files the installer writes into that agent's copy of an AI skill.
    const layoutFor = (agent, skillName) => {
        const external = externalSkills.ownsSkill(skillName, externalSkillList)
            ? externalSkillList.find((s) => s.name === skillName)
            : undefined;
        const ownFiles = external
            ? externalSkills.agentFiles(external, agent, agents, scope)
            : undefined;
        return { layout: skillLayout(method, ownFiles), ownFiles };
    };
    /**
     * Whether a recorded skill folder is laid out the way an older symlink
     * install made it, holding nothing LaunchBridge did not put there.
     * @param {string} skillTargetPath
     * @param {Map<string, Buffer> | undefined} ownFiles - From layoutFor
     */
    const isOlderLayout = async (skillTargetPath, ownFiles) => {
        try {
            return (
                (await installedLayout(skillTargetPath)) === 'per-file' &&
                (
                    await entriesNotInstalled(skillTargetPath, sourcePath, {
                        ownFiles: ownFiles ? [...ownFiles.keys()] : [],
                    })
                ).length === 0
            );
        } catch {
            return false;
        }
    };
    const warnRelaidOut = (names) => {
        if (names.size > 0) {
            warn(
                `These skills are laid out the way an older LaunchBridge installed them, so they are installed again: ${[...names].join(', ')}`
            );
        }
    };
    const warnContentDiffers = (names) => {
        if (names.size > 0) {
            warn(
                `Installed skill content differs from this LaunchBridge source, so these are installed again: ${[...names].join(', ')}`
            );
        }
    };

    // A recorded folder an earlier run left in place when its skill was no
    // longer selected stays LaunchBridge's (to remove, or to take back when
    // the skill is selected again) only while it holds what this source
    // installs there. One that differs may hold the user's own changes, so
    // from now on it is treated as theirs: never removed, and replaced only
    // when they say so. A folder a run that did not finish had started on
    // may be incomplete, so it stays LaunchBridge's.
    /** @type {Set<string>} */
    const handedOver = new Set();
    if (priorTargets) {
        const previouslySelected = new Set(
            manifestSkills
                ? externalSkills.expandManifestKeys(
                      manifestSkills,
                      priorExternalNames,
                      externalSkillList
                  )
                : []
        );
        const sourceDirOf = (name) =>
            externalSkills.ownsSkill(name, externalSkillList)
                ? externalSkillList.find((s) => s.name === name)?.path
                : availableSkills.find((s) => s.name === name)?.path;
        for (const base of skillsDirs) {
            const sharing = targets.filter((t) => t.path === base);
            for (const name of await recordedOrphans(
                priorTargets,
                installRoot,
                base,
                previouslySelected
            )) {
                const target = path.join(base, name);
                if (unfinishedTargets.has(targetKey(installRoot, target))) {
                    continue;
                }
                const sourceDir = sourceDirOf(name);
                let pristine = false;
                for (const { agent } of sourceDir ? sharing : []) {
                    const { ownFiles } = layoutFor(agent, name);
                    if (
                        await installedSkillMatches(
                            target,
                            sourceDir,
                            sourcePath,
                            { overrides: ownFiles }
                        )
                    ) {
                        pristine = true;
                        break;
                    }
                }
                if (pristine) continue;
                priorTargets.delete(targetKey(installRoot, target));
                handedOver.add(target);
                const [shownTarget, shownName] = [target, name].map(
                    stripControlCharacters
                );
                warn(
                    sourceDir
                        ? `${shownTarget} was left in place when ${shownName} was no longer selected, and differs from what LaunchBridge installs for it, so it is treated as yours from now on: LaunchBridge doesn't remove it, and replaces it only when you say so.`
                        : `${shownTarget} was left in place when ${shownName} was no longer selected, and this LaunchBridge source no longer has ${shownName}, so it is treated as yours from now on: LaunchBridge doesn't remove it, and replaces it only when you say so.`
                );
            }
        }
    }

    try {
        deliveryMethod = await detectDeliveryMethod(sourcePath);
        currentVersion = await readReleaseVersion(sourcePath);
        gitCommitHash = await getGitCommitHash(sourcePath);
        const existingManifest = await readScopeManifest();

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
            { allowedRoot: hashAllowedRoot, scope }
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

        // Check if setup_status.md exists (a global install has none)
        const statusFileExists =
            scope === 'local' &&
            fsSync.existsSync(
                path.join(targetRepository, '.lb_workspace', 'setup_status.md')
            );

        // A repository lb-setup prepared for the global install has a status
        // file and no local manifest, as one whose first local install was
        // interrupted has; lb-setup's record of preparing it tells them apart.
        const preparedForGlobal =
            statusFileExists &&
            !existingManifest &&
            (await preparedForGlobalInstall(targetRepository));
        let pythonDepsChanged = false;
        let agentsLbStaged = false;
        if (preparedForGlobal) {
            const workspace = path.join(targetRepository, '.lb_workspace');
            const holdsDeps = async (skills) => {
                const deps = buildPythonDepsFiles(sourcePath, skills);
                return folderHolds(
                    new Map([
                        ['constraints.txt', deps.constraints],
                        ['pyproject.toml', Buffer.from(deps.pyproject, 'utf8')],
                    ]),
                    path.join(workspace, 'config', 'python_deps')
                );
            };
            // lb-setup copied python_deps/ from the global install's generated
            // files, built from the selection sorted (buildGlobalAssets); this
            // install writes the same dependencies in selection order.
            try {
                pythonDepsChanged = !(
                    (await holdsDeps(selectedSkills)) ||
                    (await holdsDeps([...new Set(selectedSkills)].sort()))
                );
            } catch {
                pythonDepsChanged = true;
            }
            // copyAgentsSteering stages AGENTS_LB.md beside an AGENTS.md (or
            // a link there), and keeps one that is pending.
            for (const file of [
                path.join(targetRepository, 'AGENTS.md'),
                path.join(workspace, 'steering', 'AGENTS_LB.md'),
            ]) {
                if (await pathExists(file)) agentsLbStaged = true;
            }
        }

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
            // A global install's pyproject is the one in lb-setup's generated
            // files (built from the sorted selection).
            const newHash =
                scope === 'global'
                    ? globalAssetDigests['python_deps/pyproject.toml']
                    : crypto
                          .createHash('sha256')
                          .update(newContent)
                          .digest('hex');
            newGeneratedPyprojectHash = newHash;

            if (existingManifest && existingManifest.generatedPyprojectHash) {
                // Compare against the hash stored at last install time (before lb-setup rewrites)
                generatedPyprojectChanged =
                    existingManifest.generatedPyprojectHash !== newHash;
            } else if (scope === 'global') {
                // No stored hash: the global assets are regenerated
                generatedPyprojectChanged = true;
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
            preparedForGlobal,
            pythonDepsChanged,
            agentsLbStaged,
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
        // is nothing to do; one that differs, or is laid out the way an older
        // version installed it, is installed again. An interactive run also
        // offers to remove a recorded folder of a skill no longer selected.
        if (lifecycleDecision.scenario === 'idempotent_rerun') {
            const missingSkills = new Set();
            const changedSkills = new Set();
            const relaidSkills = new Set();
            const neededTargets = new Set();
            const needs = (skillName, skillTargetPath) => {
                missingSkills.add(skillName);
                neededTargets.add(skillTargetPath);
            };
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
                        needs(skillName, skillTargetPath);
                        continue;
                    }
                    // A linked skills folder on the way is left to the full install
                    // path, whose directory checks refuse it, rather than compared
                    // (the comparison removes bytecode, which would then be outside
                    // the repository). A global install's folders may be linked;
                    // checkGlobalSkillsDirectory has already accepted them.
                    let linkedParent = false;
                    if (scope === 'local') {
                        const parts = path
                            .relative(targetRepository, baseTargetPath)
                            .split(path.sep);
                        let walked = targetRepository;
                        for (const part of parts) {
                            walked = path.join(walked, part);
                            if (fsSync.lstatSync(walked).isSymbolicLink()) {
                                linkedParent = true;
                                break;
                            }
                        }
                    }
                    if (linkedParent) {
                        needs(skillName, skillTargetPath);
                        continue;
                    }
                    // A same-named folder LaunchBridge didn't install is the
                    // user's: the comparison below removes bytecode from it, so
                    // leave it to the full install path's ownership check.
                    if (
                        !wasInstalledByLaunchBridge(skillTargetPath, skillName)
                    ) {
                        needs(skillName, skillTargetPath);
                        continue;
                    }
                    const native = nativeSkillPaths[skillName];
                    const sourceDir =
                        native ??
                        externalSkillList.find((s) => s.name === skillName)
                            ?.path;
                    // An AI skill's copy for any agent but Claude Code holds
                    // the files the installer wrote for that agent, and is a
                    // copy in a symlink install too.
                    const { layout, ownFiles } = layoutFor(agent, skillName);
                    if (
                        (await installedLayout(skillTargetPath)) !== layout &&
                        (await isOlderLayout(skillTargetPath, ownFiles))
                    ) {
                        relaidSkills.add(skillName);
                        relayoutTargets.add(skillTargetPath);
                        needs(skillName, skillTargetPath);
                        continue;
                    }
                    if (
                        !(await installedSkillMatches(
                            skillTargetPath,
                            sourceDir,
                            sourcePath,
                            { overrides: ownFiles, layout }
                        ))
                    ) {
                        changedSkills.add(skillName);
                        needs(skillName, skillTargetPath);
                    } else {
                        matchingTargets.add(
                            targetKey(installRoot, skillTargetPath)
                        );
                    }
                }
            }
            warnRelaidOut(relaidSkills);
            warnContentDiffers(changedSkills);
            // A global install's generated files are kept once, in the state
            // directory; they are written again when they or their record
            // differ from what this source builds.
            let assetsStale = false;
            if (scope === 'global' && globalAssets) {
                assetsStale =
                    !(await globalAssetsMatch(globalAssets)) ||
                    JSON.stringify(existingManifest.generatedAssets ?? null) !==
                        JSON.stringify(globalAssetDigests);
                if (assetsStale) {
                    warn(
                        `The files lb-setup prepares repositories from (${globalGeneratedDir()}) are missing or out of date; they are written again.`
                    );
                }
            }

            // A --yes run removes no orphan, so only an interactive one goes
            // on to offer them.
            let orphansToOffer = false;
            if (!resolvedFlags.yes && priorTargets) {
                for (const base of skillsDirs) {
                    const orphans = await recordedOrphans(
                        priorTargets,
                        installRoot,
                        base,
                        selectedSkills
                    );
                    if (orphans.length > 0) orphansToOffer = true;
                }
            }

            if (missingSkills.size === 0 && !assetsStale) {
                // Nothing to install. The Python dependency config and its record
                // are still rewritten from this source: the record lives outside
                // the repository and is missing after a move, on a new machine or
                // with a fresh home directory, and lb-setup asks for an installer
                // run to restore it.
                if (scope === 'local') {
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
                }
            }
            // A folder handed over above is dropped from the record, and the
            // folders a run that did not finish had started on are added to
            // it or kept listed, which only a run that goes on does.
            if (
                missingSkills.size === 0 &&
                !assetsStale &&
                !orphansToOffer &&
                handedOver.size === 0 &&
                !unfinishedRun
            ) {
                const emptyReport = {
                    successful: [],
                    failed: [],
                    skipped: [],
                };
                const lifecycleReport = buildLifecycleReport(
                    emptyReport,
                    lifecycleDecision,
                    { scope }
                );
                spacer();
                displayLifecycleReport(lifecycleReport);
                process.exit(0);
            }

            // Some agents are missing skills on disk — promote to incremental_update
            // so the install loop runs for the missing skills, in only the
            // folders that need them (none, when only the generated files, the
            // orphan cleanup or the record do).
            pendingTargets = neededTargets;
            lifecycleDecision = {
                ...lifecycleDecision,
                scenario: 'incremental_update',
                skillsToInstall: [...missingSkills],
                skillsUnchanged: selectedSkills.filter(
                    (s) => !missingSkills.has(s)
                ),
            };
        } else if (
            lifecycleDecision.scenario === 'incremental_update' ||
            lifecycleDecision.scenario === 'release_upgrade'
        ) {
            // The decision compares hashes, not agents: an agent added in this
            // run also needs the skills that did not change, but only in its
            // own folder, and an unchanged skill laid out another way than
            // this run installs it is installed again (see relayoutTargets
            // for when that is asked about). A same-named folder
            // LaunchBridge didn't install goes to the install loop, whose
            // ownership check skips it or asks, and so does one a run that
            // did not finish had started on, which may be incomplete.
            const toInstall = new Set(lifecycleDecision.skillsToInstall);
            const extra = new Set();
            const neededTargets = new Set();
            const relaidSkills = new Set();
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
                    const recorded =
                        fsSync.existsSync(skillTargetPath) &&
                        wasInstalledByLaunchBridge(skillTargetPath, skillName);
                    const { layout, ownFiles } = layoutFor(agent, skillName);
                    const laidOutOtherwise =
                        recorded &&
                        (await installedLayout(skillTargetPath)) !== layout;
                    // After a change of install method every folder is
                    // laid out otherwise, and replaced without asking.
                    if (laidOutOtherwise && !methodChanged) {
                        if (await isOlderLayout(skillTargetPath, ownFiles)) {
                            relaidSkills.add(skillName);
                            relayoutTargets.add(skillTargetPath);
                        } else {
                            changedSkills.add(skillName);
                        }
                    }
                    if (toInstall.has(skillName)) {
                        neededTargets.add(skillTargetPath);
                    } else if (
                        !recorded ||
                        laidOutOtherwise ||
                        unfinishedTargets.has(
                            targetKey(installRoot, skillTargetPath)
                        )
                    ) {
                        neededTargets.add(skillTargetPath);
                        extra.add(skillName);
                    }
                }
            }
            warnRelaidOut(relaidSkills);
            warnContentDiffers(changedSkills);
            if (extra.size > 0) {
                pendingTargets = neededTargets;
                lifecycleDecision = {
                    ...lifecycleDecision,
                    skillsToInstall: [...toInstall, ...extra],
                    skillsUnchanged: lifecycleDecision.skillsUnchanged.filter(
                        (s) => !extra.has(s)
                    ),
                };
            }
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
    } catch (err) {
        // If lifecycle detection fails, fall back to existing behavior (install everything)
        lifecycleDecision = null;
        lifecycleError = err;
    }

    // Determine which skills to install in the per-agent loop
    // If lifecycle detection succeeded, filter to only skillsToInstall; otherwise install all
    const allSelectedSkills = [...selectedSkills];
    const skillsForInstallLoop = lifecycleDecision
        ? selectedSkills.filter((s) =>
              lifecycleDecision.skillsToInstall.includes(s)
          )
        : selectedSkills;

    // A global install lists beside its record each skill folder it starts
    // to replace or create, just before it does (in the loop below), so a run
    // that stops before its record is written leaves those LaunchBridge's,
    // and no others. The list first holds what an unfinished run left, and
    // writing it before anything is installed shows the folder can be written.
    /** @type {Set<string>} */
    const pendingKeys = new Set(unfinishedTargets);
    if (scope === 'global') {
        try {
            await writeGlobalPending(pendingKeys);
        } catch (err) {
            const hint =
                err.code === 'EACCES' || err.code === 'EPERM'
                    ? ` ${PERMISSION_HINT}`
                    : '';
            uiError(
                `Cannot write the global install record in ${globalStateDir()}: ${err.message}. Nothing was installed; fix that and run the installer again.${hint}`
            );
            process.exit(1);
        }
    }

    step(3, 'Installing Skills');
    spacer();

    // Step 5: Execute installation for each agent and skill combination
    /** @type {import('./lib/installer.js').InstallationResult[]} */
    const results = [];
    let cancelAll = false;
    // Auto-overwrite without prompting when the install method changed (symlink→copy or vice versa).
    // The user already confirmed the new method at the selection step, so re-prompting for each
    // skill conflict would be confusing and could leave a mix of symlinks and copies on disk.
    let overwriteAll = resolvedFlags.yes || methodChanged ? true : false;
    // Track which target paths have already been scanned for orphans so that
    // agents sharing the same skillsDir (e.g. cline/codex/cursor all use
    // .agents/skills) don't trigger the same prompt multiple times.
    const handledOrphanPaths = new Set();
    // Track whether any skill directories were removed (orphan cleanup), so the
    // workspace/status refresh runs even on removal-only runs with no installs.
    let orphansRemoved = false;
    /** @type {string[]} The skill of each folder the orphan cleanup removed */
    const removedOrphans = [];

    // Copy mode follows links inside skills only when they stay in the source tree.
    const copyAllowedRoot = await fs.realpath(sourcePath);

    /** @type {Map<string, object>} The result each skill folder got this run */
    const outcomeByTarget = new Map();
    const needsInstall = (skillTargetPath) =>
        pendingTargets === null || pendingTargets.has(skillTargetPath);

    for (const agent of agents) {
        if (cancelAll) break;
        const agentResultsStart = results.length;

        // Get the base target path for this agent and scope
        const baseTargetPath = getTargetPathFromValidator(
            agent,
            scope,
            targetRepository
        );

        // Refuse a skills directory reached through a symlink: writes and the
        // orphan cleanup below would land outside the target repository. A
        // global install's directory is checked against the home directory
        // and the LaunchBridge source instead.
        const checkDirectory = (dir) =>
            scope === 'global'
                ? checkGlobalSkillsDirectory(dir, { sourcePath })
                : checkSkillsDirectory(dir, targetRepository);
        const dirCheck = await checkDirectory(baseTargetPath);
        if (!dirCheck.ok) {
            const errorMessage = `Refusing to use ${baseTargetPath}: ${dirCheck.reason}`;
            console.error(`Error for ${agent}: ${errorMessage}`);
            for (const skillName of skillsForInstallLoop.filter((s) =>
                needsInstall(path.join(baseTargetPath, s))
            )) {
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
            for (const skillName of skillsForInstallLoop.filter((s) =>
                needsInstall(path.join(baseTargetPath, s))
            )) {
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
                    targetRepository: installRoot,
                    selectedSkills,
                    previouslyInstalled: priorTargets
                        ? namesUnder(priorTargets, installRoot, baseTargetPath)
                        : previouslyInstalledSkills,
                    yes: resolvedFlags.yes,
                    prompt: promptForOrphanResolution,
                    onWarn: warn,
                    checkDirectory,
                });
                if (orphanResult.action === 'cancel') {
                    cancelAll = true;
                    break;
                }
                for (const orphan of orphanResult.removed) {
                    orphansRemoved = true;
                    removedOrphans.push(orphan);
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
            // This agent's copy is up to date (another agent's is not).
            if (!needsInstall(path.join(baseTargetPath, skillName))) continue;

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
            // Agents that share a skills folder (pi and other agents, and in a
            // global install Codex too) get one copy: the outcome for the
            // first of them stands for the rest.
            const earlier = outcomeByTarget.get(skillTargetPath);
            if (earlier) {
                results.push({ ...earlier, agent });
                displayProgress(
                    skillName,
                    agent,
                    earlier.success && !earlier.error ? 'success' : 'skipped'
                );
                continue;
            }
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
                    overwriteAll:
                        overwriteAll ||
                        (previouslyInstalled &&
                            (relayoutTargets.has(skillTargetPath) ||
                                isUnrecordedUnfinished(skillTargetPath))),
                    yes: resolvedFlags.yes,
                    previouslyInstalled,
                });
                if (decision === 'skip') {
                    foreignTargets.add(targetKey(installRoot, skillTargetPath));
                    const reason = handedOver.has(skillTargetPath)
                        ? `${skillTargetPath} was left in place when ${skillName} was no longer selected and differs from what LaunchBridge installs for it; left unchanged (--yes never replaces it).`
                        : `${skillTargetPath} exists and was not installed by LaunchBridge; left unchanged (--yes never replaces it).`;
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
                        : await promptForConflictResolution(
                              skillName,
                              skillTargetPath
                          );

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
                            targetKey(installRoot, skillTargetPath)
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
            }

            // Listed before it is replaced or created (see pendingKeys); a
            // folder of someone else's the user said to replace is
            // LaunchBridge's from now on.
            const key = targetKey(installRoot, skillTargetPath);
            if (scope === 'global' && !pendingKeys.has(key)) {
                try {
                    await writeGlobalPending([...pendingKeys, key]);
                    pendingKeys.add(key);
                } catch (error) {
                    const reason = `${skillTargetPath} was not ${exists ? 'replaced' : 'installed'}: the global install record in ${globalStateDir()} could not be written: ${error.message}`;
                    warn(reason);
                    results.push({
                        skillName,
                        agent,
                        success: false,
                        error: reason,
                        targetPath: skillTargetPath,
                    });
                    displayProgress(skillName, agent, 'failure');
                    continue;
                }
            }

            if (exists) {
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

            // Install the skill: a link to its folder, or a copy (a copy install,
            // or a folder the installer writes files of its own into).
            const { layout } = layoutFor(agent, skillName);
            let created = false;
            try {
                if (layout === 'link') {
                    await createSymlink(skillSourcePath, skillTargetPath);
                    created = true;
                } else {
                    await copySkill(skillSourcePath, skillTargetPath, {
                        allowedRoot: copyAllowedRoot,
                        onSkip: (src, resolved) =>
                            warn(
                                `Skipped link outside the LaunchBridge source: ${src} -> ${resolved}`
                            ),
                        onCreate: () => {
                            created = true;
                        },
                    });
                }
                if (externalSkills.ownsSkill(skillName, externalSkillList)) {
                    await externalSkills.adaptForAgent(
                        skill,
                        agent,
                        skillTargetPath,
                        agents,
                        scope
                    );
                }

                results.push({
                    skillName,
                    agent,
                    success: true,
                    targetPath: skillTargetPath,
                    layout,
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
                    if (!errorMessage.includes(PERMISSION_HINT)) {
                        errorMessage += ` ${PERMISSION_HINT}`;
                    }
                }

                // A global install's skill folders serve every repository, so
                // what it made of one that wasn't there is removed rather
                // than left for the agents to load. When it made nothing,
                // whatever is there now is someone else's.
                if (scope === 'global' && !exists && created) {
                    try {
                        await removePath(skillTargetPath);
                    } catch (removeError) {
                        const left = `Could not remove the partly installed ${skillTargetPath}: ${removeError.message}`;
                        warn(left);
                        errorMessage += ` ${left}`;
                    }
                } else if (scope === 'global' && !exists) {
                    pendingKeys.delete(key);
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

        for (const result of results.slice(agentResultsStart)) {
            if (!outcomeByTarget.has(result.targetPath)) {
                outcomeByTarget.set(result.targetPath, result);
            }
        }
    }

    // Step 6: Verify all installations
    spacer();
    const verificationResults = results.map((result) =>
        verifyInstallation(result, method)
    );

    // Update results based on verification. A folder this run skipped was
    // not installed by it, so it is not checked as an install.
    for (let i = 0; i < results.length; i++) {
        if (
            results[i].success &&
            !results[i].error &&
            !verificationResults[i].verified
        ) {
            results[i].success = false;
            results[i].error =
                verificationResults[i].error || 'Verification failed';
        }
    }

    // A global install's generated files, which lb-setup copies into each
    // repository it prepares: one copy for every agent, in the global state
    // directory beside the install record, when it is not already there.
    let assetsFailed = false;
    if (
        scope === 'global' &&
        globalAssets &&
        !(await globalAssetsMatch(globalAssets))
    ) {
        try {
            await writeGlobalAssets(globalAssets);
        } catch (err) {
            assetsFailed = true;
            warn(
                `Could not write the files lb-setup needs into ${globalGeneratedDir()}: ${err.message}. Fix that and run the installer again.`
            );
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
    // A global install writes nothing into the current folder: lb-setup
    // creates .lb_workspace in each repository it is run in.
    if (scope === 'local' && workspaceNeedsUpdate) {
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
    // A global install's pending.json changes here only once its record is
    // written.
    let recordFailed = false;
    if (lifecycleDecision && currentVersion) {
        try {
            // Record the skill directories LaunchBridge now owns: those this
            // run installed, plus earlier ones still present and not skipped,
            // including those of skills no longer selected that were left in
            // place, so a later run can still remove them or take them back.
            const installedNow = new Set(
                results
                    .filter((r) => r.success && !r.error?.includes('Skipped'))
                    .map((r) => targetKey(installRoot, r.targetPath))
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
                    const key = targetKey(installRoot, skillPath);
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
            if (priorTargets) {
                for (const base of skillsDirs) {
                    for (const name of await recordedOrphans(
                        priorTargets,
                        installRoot,
                        base,
                        allSelectedSkills
                    )) {
                        installedTargets.add(
                            targetKey(installRoot, path.join(base, name))
                        );
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
            if (scope === 'global') {
                // Kept in the user's state directory, never in a repository.
                // `skills` lists every selected skill by name, and lb-setup
                // reads the rest when it prepares a repository.
                const globalManifestOut = {
                    schemaVersion: 1,
                    scope: 'global',
                    ...newManifest,
                    skills: [...allSelectedSkills].sort(),
                    skillRequiresSetup: Object.fromEntries(
                        allSelectedSkills
                            .filter((s) =>
                                Object.hasOwn(SKILL_REQUIRES_SETUP, s)
                            )
                            .sort()
                            .map((s) => [s, SKILL_REQUIRES_SETUP[s]])
                    ),
                    mcpGatedSkills: [...mcpGatedSkills].sort(),
                    generatedAssets: globalAssetDigests,
                    generatedPyprojectHash:
                        globalAssetDigests?.['python_deps/pyproject.toml'] ??
                        newManifest.generatedPyprojectHash,
                };
                await writeGlobalState(
                    GLOBAL_MANIFEST,
                    JSON.stringify(
                        assetsFailed
                            ? keepPreviousAssetFields(
                                  globalManifestOut,
                                  globalManifest
                              )
                            : globalManifestOut,
                        null,
                        2
                    ) + '\n'
                );
                await recordGlobalInstallSource(sourcePath);
                // A listed folder stays listed until a run installs it, or
                // finds it holding what it installs there, or it is gone:
                // its agent or skill may not be selected now, or its install
                // may have failed part-way.
                const unfinished = [];
                for (const key of [...pendingKeys].sort()) {
                    if (
                        !installedNow.has(key) &&
                        !matchingTargets.has(key) &&
                        (await pathExists(
                            path.join(installRoot, ...key.split('/'))
                        ).catch(() => false))
                    ) {
                        unfinished.push(key);
                    }
                }
                if (unfinished.length > 0) {
                    await writeGlobalPending(unfinished);
                    const shown = unfinished.map((key) =>
                        stripControlCharacters(
                            path.join(installRoot, ...key.split('/'))
                        )
                    );
                    warn(
                        `These skill folders a global install did not finish may be incomplete: ${shown.join(', ')}. They stay LaunchBridge's, listed in ${path.join(globalStateDir(), GLOBAL_PENDING)}: run the installer again with their agents and skills selected to finish them, or remove them.`
                    );
                } else {
                    await removeGlobalPending();
                }
            } else {
                await writeManifest(targetRepository, newManifest);
            }
        } catch (err) {
            if (scope === 'global') recordFailed = true;
            warn(
                scope === 'global'
                    ? `Could not write the global install record: ${err.message}. Fix that and run the installer again.`
                    : 'Could not write version manifest.'
            );
        }
    } else if (scope === 'global') {
        recordFailed = true;
        warn(
            `Could not write the global install record: ${lifecycleError?.message ?? 'version.txt names no release version'}. Fix that and run the installer again.`
        );
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
        const lifecycleReport = buildLifecycleReport(
            report,
            lifecycleDecision,
            { scope, removed: removedOrphans }
        );
        displayLifecycleReport(lifecycleReport);
    } else {
        displayFinalReport(report);
    }

    // Step 8: Exit with appropriate code
    const exitCode = assetsFailed || recordFailed ? 1 : getExitCode(report);
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
