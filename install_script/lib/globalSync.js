// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Global Sync Module
 *
 * After `launchbridge update` has fast-forwarded the LaunchBridge clone, brings
 * a global install (skills in the agents' user-level folders) up to date with
 * it, from the global install record in the user's state directory. It runs
 * only from the clone the record names; from any other, it changes nothing.
 *
 *   1. Native skills: a copy install's skills whose content changed are
 *      copied again, where the copy still holds what LaunchBridge installed.
 *      A symlink install's skill folders are links to the clone, so they
 *      already hold the new content; a link to anything else, or a folder an
 *      older install made of per-file links that holds nothing else, is linked
 *      again. A recorded skill folder that is gone is installed again, unless
 *      the whole skills folder is gone. A folder that differs in any other way
 *      (a copy edited since, a real folder in place of a link) is left as it
 *      is, with a warning: re-running `launchbridge` replaces it.
 *   2. AI skills are brought up to date by their provider the same way.
 *   3. The generated files lb-setup prepares repositories from
 *      (globalAssets.js, in the global state directory) are rebuilt and
 *      rewritten when they differ.
 *   4. The record is rewritten with the new digests of what is now installed.
 *      The record is the only baseline the global install's integrity check
 *      has, so a skill the clone has changes to that are not committed
 *      (sourceChanges.js) keeps its recorded digest and is neither copied nor
 *      linked again, and so do the generated files when the files they are
 *      built from have such changes. When git can't tell, nothing is taken
 *      from the clone's working tree. A skill whose folder could not be
 *      updated keeps its digest too, and so do the generated files when they
 *      could not be written, so the next update tries again.
 *
 * Only skill folders the record lists as installed by LaunchBridge are
 * touched, and agents whose skills folders are one folder are synced once.
 * Skills new in the source are not added: re-running `launchbridge` selects
 * them. Repositories pick the changes up the next time lb-setup runs in them
 * (bootstrap_workspace.py init).
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getSkillsDir } from './agentConfig.js';
import {
    computeContentHash,
    computeDependencySetHash,
    computeFileHash,
    computeSkillHashes,
} from './contentHash.js';
import { getGitCommitHash, readReleaseVersion } from './deliveryDetector.js';
import { externalSkills } from './externalSkillsProvider.js';
import {
    ASSET_SOURCES,
    assetDigests,
    buildGlobalAssets,
    globalAssetsMatch,
    writeGlobalAssets,
} from './globalAssets.js';
import {
    entriesNotInstalled,
    installedLayout,
    installedSkillMatches,
} from './installedContent.js';
import {
    copySkill,
    createSymlink,
    ensureTargetDirectory,
} from './installer.js';
import {
    namesUnder,
    targetKey,
    readInstalledTargets,
} from './installedTargets.js';
import { removePath } from './orphanCleanup.js';
import { safePathJoin } from './pathSanitizer.js';
import { checkGlobalSkillsDirectory, checkWorkspace } from './pathValidator.js';
import { discoverSkills, SKILL_REQUIRES_SETUP } from './skillDiscovery.js';
import { uncommittedSkillChanges } from './sourceChanges.js';
import {
    GLOBAL_MANIFEST,
    globalGeneratedDir,
    readGlobalManifest,
    recordGlobalInstallSource,
    writeGlobalState,
} from './stateDir.js';
import { stripControlCharacters } from './terminalText.js';
import {
    mergeExternalFolderHashes,
    mergeExternalManifestKeys,
    runPostPullSync,
} from './updater.js';

/**
 * @typedef {Object} GlobalSyncResult
 * @property {boolean} skippedNoManifest - There is no global install
 * @property {string | null} skippedOtherSource - The clone the global install
 *   came from, when the sync ran from another one and changed nothing
 * @property {string[]} changedSkills - Native skills whose source changed
 * @property {string[]} updatedSkills - Skills installed again (native and AI)
 * @property {string[]} heldBack - Skills kept at their recorded version
 *   because the clone has changes to them that are not committed, or git could
 *   not tell (native and AI)
 * @property {string[]} modifiedTargets - Skill folders left as they are
 *   because they differ from what LaunchBridge installed
 * @property {string[]} missingFolders - Recorded skills folders that are gone
 *   as a whole, which were not made again
 * @property {string[]} heldBackSources - The files the generated files are
 *   built from that the clone has changes to that are not committed; the
 *   generated files and their digests were kept
 * @property {string[]} assetsWritten - The generated folder, when its files
 *   were written again
 * @property {string[]} problems - What could not be updated
 */

/** @returns {GlobalSyncResult} */
function emptyResult() {
    return {
        skippedNoManifest: false,
        skippedOtherSource: null,
        changedSkills: [],
        updatedSkills: [],
        heldBack: [],
        modifiedTargets: [],
        missingFolders: [],
        heldBackSources: [],
        assetsWritten: [],
        problems: [],
    };
}

/** Up to five names, then how many more. */
function listNames(names) {
    const shown = names.slice(0, 5).map(stripControlCharacters).join(', ');
    return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

/**
 * Brings the global install up to date with the LaunchBridge source.
 *
 * @param {string} sourcePath - LaunchBridge source root (already updated)
 * @param {{ muted: Function, success: Function, warn: Function }} ui
 * @param {{ home?: string, uncommitted?: typeof uncommittedSkillChanges, writeAssets?: typeof writeGlobalAssets }} [options]
 *   The home directory the record's folders are relative to (default
 *   `os.homedir()`), what tells which skills the clone has changes to
 *   that are not committed (default uncommittedSkillChanges), and what writes
 *   the generated files (default writeGlobalAssets)
 * @returns {Promise<GlobalSyncResult>}
 */
export async function runGlobalSync(
    sourcePath,
    ui,
    {
        home = os.homedir(),
        uncommitted = uncommittedSkillChanges,
        writeAssets = writeGlobalAssets,
    } = {}
) {
    const { muted, success, warn } = ui;
    const result = emptyResult();
    const manifest = await readGlobalManifest();
    if (!manifest) {
        return { ...result, skippedNoManifest: true };
    }

    // The record names the clone the global install came from (its links
    // point into it); another clone's update must not move it.
    if (typeof manifest.sourcePath === 'string' && manifest.sourcePath) {
        const recorded = manifest.sourcePath;
        const here = await fs.realpath(sourcePath);
        const there = await fs.realpath(recorded).catch(() => null);
        if (there !== here) {
            const shown = stripControlCharacters(recorded);
            warn(
                there === null
                    ? `  The global install came from ${shown}, which no longer exists, so it was left as it is. To move the global install to this clone, run 'launchbridge' from it and choose Global.`
                    : `  The global install came from ${shown}, not from this clone (${sourcePath}), so it was left as it is. Run 'launchbridge update' from that clone, or run 'launchbridge' from this one and choose Global to move the global install here.`
            );
            return { ...result, skippedOtherSource: recorded };
        }
    }

    const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
    const method = manifest.installMethod;
    const selected = Array.isArray(manifest.skills) ? manifest.skills : [];
    const installed = readInstalledTargets(manifest) ?? new Set();
    const allowedRoot = await fs.realpath(sourcePath);
    const problem = (message) => {
        result.problems.push(message);
        warn(`  ${message}`);
    };
    const leaveAlone = (target, message) => {
        result.modifiedTargets.push(target);
        warn(`  ${message}`);
        return 'modified';
    };
    const commitOrDiscard = `Commit or discard them (git -C "${sourcePath}" status)`;

    /**
     * Which of these skills (or files) the clone has changes to that are not
     * committed, by changed path. When git can't tell, every one of them is
     * taken to have such changes, with no paths, and that is a problem.
     *
     * @param {Array<{ name: string, path: string }>} list
     * @param {string} consequence - What follows when git can't tell
     * @returns {Promise<Map<string, string[] | null>>}
     */
    const findUncommitted = async (list, consequence) => {
        if (list.length === 0) return new Map();
        try {
            return (await uncommitted(sourcePath, list)) ?? new Map();
        } catch (err) {
            problem(
                `Could not check the LaunchBridge clone for changes that are not committed (${err.message}), so ${consequence}`
            );
            return new Map(list.map(({ name }) => [name, null]));
        }
    };
    const notChecked = (names) =>
        `these skills were not updated and keep the digests the global install recorded: ${listNames(names)}.`;

    /**
     * Warns about a skill kept at its recorded version, by what its recorded
     * folders hold now: `live`, links to the clone, which show the changes;
     * `kept`, folders left as they were; `missing`, folders not made again.
     */
    const warnHeld = (
        name,
        paths,
        { live = 0, kept = 0, missing = 0 } = {}
    ) => {
        const changes = listNames(paths);
        const parts = [];
        if (live > 0) {
            parts.push(
                `${name}'s links show changes the LaunchBridge clone has not committed (${changes}), so agents load them now; the global install keeps the digest it recorded, so lb-setup's integrity check reports ${name} until they are committed or discarded.`
            );
            if (kept > 0) {
                parts.push(
                    'Its copies were kept at the version the global install recorded.'
                );
            }
        } else if (kept === 0 && missing > 0) {
            parts.push(
                `Did not install ${name} again: the LaunchBridge clone has changes to it that are not committed (${changes}).`
            );
        } else {
            parts.push(
                `Kept ${name} at the version the global install recorded: the LaunchBridge clone has changes to it that are not committed (${changes}).`
            );
        }
        if (missing > 0 && (live > 0 || kept > 0)) {
            parts.push('Its missing folders were not installed again.');
        }
        parts.push(
            `${commitOrDiscard}, or run 'launchbridge' and choose Global to install ${name} as it is now.`
        );
        warn(`  ${parts.join(' ')}`);
    };

    // ── 1. Native skills ──────────────────────────────────────────────────────
    const nativeSkills = discoverSkills(sourcePath);
    const nativePaths = {};
    for (const name of selected) {
        const skill = nativeSkills.find((s) => s.name === name);
        if (skill) nativePaths[name] = skill.path;
    }
    const newHashes = await computeSkillHashes(nativePaths, { allowedRoot });
    const oldHashes = manifest.skillHashes || {};
    result.changedSkills = Object.keys(newHashes).filter(
        (name) => newHashes[name] !== oldHashes[name]
    );
    const changed = new Set(result.changedSkills);
    // Changed skills held at their recorded version, with their changed paths
    // (null: git could not tell).
    const held = await findUncommitted(
        result.changedSkills.map((name) => ({ name, path: nativePaths[name] })),
        notChecked(result.changedSkills)
    );
    result.heldBack.push(...held.keys());
    /** @type {Map<string, { live: number, kept: number, missing: number }>} */
    const heldState = new Map();
    const noteHeld = (name, what) => {
        if (!heldState.has(name)) {
            heldState.set(name, { live: 0, kept: 0, missing: 0 });
        }
        heldState.get(name)[what] += 1;
        return 'held';
    };

    // One entry per real skills folder, with the paths, as written, that are
    // it (a ~/.kiro/skills linked to ~/.claude/skills is synced once).
    const folders = new Map();
    const checkedDirs = new Set();
    // Skills with a recorded folder that was not brought up to date.
    const failed = new Set();
    for (const agent of agents) {
        let rel;
        try {
            rel = getSkillsDir(agent, 'global');
        } catch {
            continue;
        }
        const dir = safePathJoin(home, ...rel.split('/'));
        if (checkedDirs.has(dir)) continue;
        checkedDirs.add(dir);
        let check;
        try {
            check = await checkGlobalSkillsDirectory(dir, {
                sourcePath,
                home,
            });
        } catch (err) {
            check = { ok: false, reason: err.message };
        }
        if (!check.ok) {
            problem(`Skipped ${dir}: ${check.reason}`);
            namesUnder(installed, home, dir).forEach((name) =>
                failed.add(name)
            );
            continue;
        }
        // A skills folder that is gone as a whole was removed on purpose (an
        // agent uninstalled, say), so it is not made again.
        if (!(await fs.lstat(dir).catch(() => null))) {
            const names = [...namesUnder(installed, home, dir)].filter((name) =>
                selected.includes(name)
            );
            if (names.length > 0) {
                result.missingFolders.push(dir);
                warn(
                    `  ${dir} is gone, so the skills LaunchBridge installed there were not installed again (${listNames(names.sort())}). To install them there again, run 'launchbridge' and choose Global.`
                );
            }
            continue;
        }
        const real = await fs.realpath(dir).catch(() => check.realPath);
        if (!folders.has(real)) folders.set(real, []);
        folders.get(real).push(dir);
    }

    const install =
        method === 'symlink'
            ? (src, dest) => createSymlink(src, dest)
            : (src, dest) =>
                  copySkill(src, dest, {
                      allowedRoot,
                      onSkip: (link, resolved) =>
                          warn(
                              `  Skipped link outside the LaunchBridge source: ${link} -> ${resolved}`
                          ),
                  });
    const reinstall = async (target, name) => {
        try {
            await ensureTargetDirectory(path.dirname(target));
            await removePath(target);
            await install(nativePaths[name], target);
            muted(`  Updated skill: ${name} (${target})`);
            if (!result.updatedSkills.includes(name)) {
                result.updatedSkills.push(name);
            }
            return 'installed';
        } catch (err) {
            problem(`Could not update ${target}: ${err.message}`);
            return 'failed';
        }
    };
    const notLinked = (target, layout, extras) =>
        leaveAlone(
            target,
            `${target} ${layout === 'copy' ? 'is a folder, not a link to the LaunchBridge source' : `is not a link to the LaunchBridge source${extras.length > 0 ? ` and holds files LaunchBridge did not install (${listNames(extras)})` : ''}`}, so it was left as it is. To replace it with a link, run 'launchbridge' and choose Global.`
        );

    /**
     * Brings one recorded skill folder up to date.
     * @returns {Promise<'ok' | 'installed' | 'failed' | 'modified' | 'held'>}
     */
    const syncTarget = async (target, name) => {
        let layout;
        try {
            layout = await installedLayout(target);
        } catch (err) {
            problem(`Could not check ${target}: ${err.message}`);
            return 'failed';
        }
        if (method === 'symlink') {
            if (
                layout === 'link' &&
                (await installedSkillMatches(
                    target,
                    nativePaths[name],
                    sourcePath,
                    { layout: 'link' }
                ))
            ) {
                if (held.has(name)) noteHeld(name, 'live');
                return 'ok';
            }
            if (held.has(name)) {
                return noteHeld(name, layout === null ? 'missing' : 'kept');
            }
            if (layout === null || layout === 'link') {
                return reinstall(target, name);
            }
            if (layout !== 'per-file') return notLinked(target, layout, []);
            let extras;
            try {
                extras = await entriesNotInstalled(target, sourcePath);
            } catch (err) {
                problem(`Could not check ${target}: ${err.message}`);
                return 'failed';
            }
            return extras.length === 0
                ? reinstall(target, name)
                : notLinked(target, layout, extras);
        }
        if (held.has(name)) {
            return noteHeld(name, layout === null ? 'missing' : 'kept');
        }
        if (layout === null) return reinstall(target, name);
        if (
            await installedSkillMatches(target, nativePaths[name], sourcePath, {
                layout: 'copy',
            })
        ) {
            return 'ok';
        }
        // A changed skill's copy is replaced only while it holds what
        // LaunchBridge installed: anything else in it may be the user's.
        if (
            changed.has(name) &&
            layout === 'copy' &&
            oldHashes[name] &&
            (await computeContentHash(target)) === oldHashes[name]
        ) {
            return reinstall(target, name);
        }
        return leaveAlone(
            target,
            `${target} differs from what LaunchBridge installed, so it was left as it is${changed.has(name) ? ` and the update to ${name} was not copied into it` : ''}. To install it again, run 'launchbridge' and choose Global.`
        );
    };

    const followedByLinks = new Set();
    for (const dirs of folders.values()) {
        for (const name of Object.keys(nativePaths)) {
            const target = dirs
                .map((dir) => safePathJoin(dir, name))
                .find((t) => installed.has(targetKey(home, t)));
            if (!target) continue;
            const outcome = await syncTarget(target, name);
            if (outcome === 'failed') failed.add(name);
            if (outcome === 'ok' && changed.has(name) && !held.has(name)) {
                followedByLinks.add(name);
            }
        }
    }
    for (const [name, paths] of held) {
        if (paths) warnHeld(name, paths, heldState.get(name));
    }

    // ── 2. AI skills ──────────────────────────────────────────────────────────
    let external = { newHashes: {}, newFolderHashes: {} };
    try {
        external = await externalSkills.update(
            sourcePath,
            home,
            manifest,
            { muted, success, warn },
            {
                scope: 'global',
                uncommitted: (skills) =>
                    findUncommitted(
                        skills,
                        notChecked(skills.map(({ name }) => name))
                    ),
            }
        );
        for (const name of external.updated) {
            if (!result.updatedSkills.includes(name)) {
                result.updatedSkills.push(name);
            }
        }
        result.problems.push(...external.problems);
        result.modifiedTargets.push(...external.modifiedTargets);
        for (const entry of external.heldBack) {
            result.heldBack.push(entry.name);
            if (entry.paths) warnHeld(entry.name, entry.paths, entry);
        }
    } catch (err) {
        problem(`Could not update the AI skills: ${err.message}`);
    }

    // ── 3. lb-setup's generated files ────────────────────────────────────────
    const hashOrKeep = async (compute, kept) => {
        try {
            return await compute();
        } catch {
            return kept;
        }
    };
    const agentsHash = await hashOrKeep(
        () =>
            computeFileHash(
                path.join(sourcePath, 'agent_steering', 'AGENTS.md')
            ),
        manifest.agentsHash
    );
    const pyprojectHash = await hashOrKeep(
        () => computeDependencySetHash(sourcePath),
        manifest.pyprojectHash
    );
    let assets = null;
    try {
        const externalList = externalSkills.discover(sourcePath, {
            nativeNames: new Set(nativeSkills.map((s) => s.name)),
        });
        assets = buildGlobalAssets({
            sourcePath,
            selectedSkills: selected,
            extraStatusRows: externalSkills.buildStatusRows(
                new Map(),
                selected,
                externalList
            ),
        });
    } catch (err) {
        problem(`Could not build the files lb-setup needs: ${err.message}`);
    }
    // Whether the generated files on disk, and their digests in the record,
    // are the ones built now; anything else keeps what the record has.
    let assetsCurrent = false;
    if (assets) {
        const onDisk = await globalAssetsMatch(assets);
        const recorded =
            JSON.stringify(manifest.generatedAssets ?? null) ===
                JSON.stringify(assetDigests(assets)) &&
            manifest.agentsHash === agentsHash &&
            manifest.pyprojectHash === pyprojectHash;
        if (onDisk && recorded) {
            assetsCurrent = true;
        } else {
            const dirty = await findUncommitted(
                ASSET_SOURCES.map((rel) => ({
                    name: rel,
                    path: path.join(sourcePath, ...rel.split('/')),
                })),
                'the files lb-setup prepares repositories from were not built again.'
            );
            const changes = [...dirty.values()];
            if (changes.length > 0) {
                // When git could not tell, that is already a problem.
                if (!changes.includes(null)) {
                    result.heldBackSources.push(...[...dirty.keys()].sort());
                    warn(
                        `  Kept the files lb-setup prepares repositories from at the version the global install recorded: the LaunchBridge clone has changes to the files they are built from that are not committed (${listNames(changes.flat())}). ${commitOrDiscard}, or run 'launchbridge' and choose Global to use them as they are now.`
                    );
                }
            } else if (onDisk) {
                assetsCurrent = true;
            } else {
                const dir = globalGeneratedDir();
                try {
                    await writeAssets(assets);
                    result.assetsWritten.push(dir);
                    assetsCurrent = true;
                } catch (err) {
                    problem(
                        `Could not write the files lb-setup needs into ${dir}: ${err.message}`
                    );
                }
            }
        }
    }

    // ── 4. The record ─────────────────────────────────────────────────────────
    // lb-setup's MCP template is part of that skill, recorded with it.
    const lbSetupKept = held.has('lb-setup') || failed.has('lb-setup');
    const mcpTemplate = path.join(
        sourcePath,
        'skills',
        'lb-setup',
        'templates',
        'lb_mcp.json'
    );
    let mcpGatedSkills = manifest.mcpGatedSkills;
    if (!lbSetupKept) {
        try {
            const template = JSON.parse(await fs.readFile(mcpTemplate, 'utf8'));
            mcpGatedSkills = Object.values(template.mcpServers || {})
                .filter((server) => server.gatedBySkill)
                .map((server) => server.gatedBySkill)
                .sort();
        } catch {
            // keep the recorded list
        }
    }
    const pyproject = assetsCurrent
        ? assets.get('python_deps/pyproject.toml')
        : undefined;
    const recordedNative = Object.fromEntries(
        Object.entries(newHashes).filter(
            ([name]) => !held.has(name) && !failed.has(name)
        )
    );
    const updated = {
        ...manifest,
        version: await hashOrKeep(
            () => readReleaseVersion(sourcePath),
            manifest.version
        ),
        timestamp: new Date().toISOString(),
        gitCommitHash:
            (await hashOrKeep(() => getGitCommitHash(sourcePath), null)) ||
            manifest.gitCommitHash,
        sourcePath,
        skillHashes: {
            ...oldHashes,
            ...recordedNative,
            ...external.newHashes,
        },
        externalSkillHashes: mergeExternalFolderHashes(
            manifest.externalSkillHashes,
            external.newFolderHashes
        ),
        externalManifestKeys: mergeExternalManifestKeys(
            manifest.externalManifestKeys,
            external.newHashes
        ),
        pyprojectHash: assetsCurrent ? pyprojectHash : manifest.pyprojectHash,
        generatedPyprojectHash: pyproject
            ? crypto.createHash('sha256').update(pyproject).digest('hex')
            : manifest.generatedPyprojectHash,
        mcpTemplateHash: lbSetupKept
            ? manifest.mcpTemplateHash
            : await hashOrKeep(
                  () => computeFileHash(mcpTemplate),
                  manifest.mcpTemplateHash
              ),
        agentsHash: assetsCurrent ? agentsHash : manifest.agentsHash,
        skillRequiresSetup: Object.fromEntries(
            selected
                .filter((s) => Object.hasOwn(SKILL_REQUIRES_SETUP, s))
                .sort()
                .map((s) => [s, SKILL_REQUIRES_SETUP[s]])
        ),
        mcpGatedSkills,
        generatedAssets: assetsCurrent
            ? assetDigests(assets)
            : manifest.generatedAssets,
    };
    await writeGlobalState(
        GLOBAL_MANIFEST,
        JSON.stringify(updated, null, 2) + '\n'
    );
    await recordGlobalInstallSource(sourcePath);

    const linkedOnly = [...followedByLinks].filter(
        (name) => !result.updatedSkills.includes(name)
    );
    if (result.updatedSkills.length > 0) {
        success(
            `Global install: ${result.updatedSkills.length} skill(s) installed again from the updated source.`
        );
    }
    if (linkedOnly.length > 0) {
        muted(
            `  Global install: ${linkedOnly.length} skill(s) changed; their links already show the updated source.`
        );
    }
    if (
        result.updatedSkills.length === 0 &&
        linkedOnly.length === 0 &&
        result.problems.length === 0 &&
        result.heldBack.length === 0 &&
        result.modifiedTargets.length === 0 &&
        result.missingFolders.length === 0 &&
        result.heldBackSources.length === 0
    ) {
        muted('  Global install: every skill is already up to date.');
    }
    if (result.assetsWritten.length > 0) {
        muted('  Regenerated the files lb-setup prepares repositories from.');
    }
    return result;
}

/**
 * What `launchbridge update` does once the clone is updated: the global
 * install, when there is one, and then the current folder's local install,
 * when it has one. The local sync writes into `.lb_workspace`, so it runs only
 * when every path it writes passes checkWorkspace; the global sync runs from
 * any folder, and an error in it is reported as one of its problems rather
 * than stopping the local sync.
 *
 * @param {string} sourcePath - LaunchBridge source root (already updated)
 * @param {string} cwd - The folder `launchbridge update` runs in
 * @param {{ step: Function, success: Function, warn: Function, muted: Function, spacer: Function }} ui
 * @param {{ home?: string, uncommitted?: typeof uncommittedSkillChanges }} [options]
 *   Passed to runGlobalSync
 * @returns {Promise<{ global: GlobalSyncResult, local: object | null,
 *   localSkipped: string | null }>} `localSkipped` says why the local sync
 *   did not run
 */
export async function runInstallSyncs(sourcePath, cwd, ui, options = {}) {
    let global;
    try {
        global = await runGlobalSync(sourcePath, ui, options);
    } catch (err) {
        const message = `Could not update the global install: ${err.message}`;
        ui.warn(`  ${message}`);
        global = { ...emptyResult(), problems: [message] };
    }
    const check = await checkWorkspace(cwd);
    if (!check.ok) {
        return { global, local: null, localSkipped: check.reason };
    }
    const local = await runPostPullSync(sourcePath, cwd, ui);
    return { global, local, localSkipped: null };
}

/**
 * Whether `launchbridge update` left an install it should have updated: the
 * global sync reported problems, or the local install was not updated
 * because its workspace was refused.
 *
 * @param {{ global: GlobalSyncResult, localSkipped: string | null }} syncs -
 *   From runInstallSyncs
 * @returns {boolean}
 */
export function syncsIncomplete({ global, localSkipped }) {
    return global.problems.length > 0 || Boolean(localSkipped);
}
