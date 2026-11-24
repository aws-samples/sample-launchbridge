// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Global Sync Module
 *
 * After `launchbridge update` has fast-forwarded the LaunchBridge clone, brings
 * a global install (skills in the agents' user-level folders) up to date with
 * it, from the global install record in the user's state directory:
 *
 *   1. Native skills: a copy install's skills whose content changed are
 *      copied again. A symlink install's skill folders are links to the
 *      clone, so they already hold the new content; only one that is not a
 *      link to its folder (an older install linked each file) is linked again.
 *   2. AI skills whose domain changed are reinstalled by their provider.
 *   3. The generated files lb-setup prepares repositories from
 *      (globalAssets.js, in the global state directory) are rebuilt and
 *      rewritten when they differ.
 *   4. The record is rewritten with the new digests.
 *
 * Only skill folders the record lists as installed by LaunchBridge are
 * touched. Skills new in the source are not added: re-running `launchbridge`
 * selects them. Repositories pick the changes up the next time lb-setup runs
 * in them (bootstrap_workspace.py init).
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getSkillsDir } from './agentConfig.js';
import {
    computeDependencySetHash,
    computeFileHash,
    computeSkillHashes,
} from './contentHash.js';
import { getGitCommitHash, readReleaseVersion } from './deliveryDetector.js';
import { externalSkills } from './externalSkillsProvider.js';
import {
    assetDigests,
    buildGlobalAssets,
    globalAssetsMatch,
    writeGlobalAssets,
} from './globalAssets.js';
import { installedLayout, installedSkillMatches } from './installedContent.js';
import {
    copySkill,
    createSymlink,
    ensureTargetDirectory,
} from './installer.js';
import { targetKey, readInstalledTargets } from './installedTargets.js';
import { removePath } from './orphanCleanup.js';
import { safePathJoin } from './pathSanitizer.js';
import { checkGlobalSkillsDirectory } from './pathValidator.js';
import { discoverSkills, SKILL_REQUIRES_SETUP } from './skillDiscovery.js';
import {
    GLOBAL_MANIFEST,
    globalGeneratedDir,
    readGlobalManifest,
    recordGlobalInstallSource,
    writeGlobalState,
} from './stateDir.js';
import {
    mergeExternalFolderHashes,
    mergeExternalManifestKeys,
} from './updater.js';

/**
 * @typedef {Object} GlobalSyncResult
 * @property {boolean} skippedNoManifest - There is no global install
 * @property {string[]} changedSkills - Native skills whose source changed
 * @property {string[]} updatedSkills - Skills reinstalled (native and AI)
 * @property {string[]} assetsWritten - The generated folder, when its files
 *   were written again
 * @property {string[]} problems - What could not be updated
 */

/**
 * Brings the global install up to date with the LaunchBridge source.
 *
 * @param {string} sourcePath - LaunchBridge source root (already updated)
 * @param {{ muted: Function, success: Function, warn: Function }} ui
 * @param {{ home?: string }} [options] - The home directory the record's
 *   folders are relative to (default `os.homedir()`)
 * @returns {Promise<GlobalSyncResult>}
 */
export async function runGlobalSync(
    sourcePath,
    ui,
    { home = os.homedir() } = {}
) {
    const { muted, success, warn } = ui;
    const result = {
        skippedNoManifest: false,
        changedSkills: [],
        updatedSkills: [],
        assetsWritten: [],
        problems: [],
    };
    const manifest = await readGlobalManifest();
    if (!manifest) {
        return { ...result, skippedNoManifest: true };
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

    const dirs = new Map();
    for (const agent of agents) {
        let rel;
        try {
            rel = getSkillsDir(agent, 'global');
        } catch {
            continue;
        }
        const dir = safePathJoin(home, ...rel.split('/'));
        if (dirs.has(dir)) continue;
        const check = await checkGlobalSkillsDirectory(dir, {
            sourcePath,
            home,
        });
        if (!check.ok) {
            problem(`Skipped ${dir}: ${check.reason}`);
            continue;
        }
        dirs.set(dir, agent);
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
    const changed = new Set(result.changedSkills);
    let followedByLinks = 0;
    for (const dir of dirs.keys()) {
        for (const name of Object.keys(nativePaths)) {
            const target = safePathJoin(dir, name);
            if (!installed.has(targetKey(home, target))) continue;
            const layout = await installedLayout(target).catch(() => 'other');
            // A skill folder that is gone is installed again only when its
            // content changed, as in a copy install.
            if (layout === null && !changed.has(name)) continue;
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
                    if (changed.has(name)) followedByLinks++;
                    continue;
                }
            } else if (!changed.has(name)) {
                continue;
            }
            try {
                await ensureTargetDirectory(dir);
                await removePath(target);
                await install(nativePaths[name], target);
                muted(`  Updated skill: ${name} (${target})`);
                if (!result.updatedSkills.includes(name)) {
                    result.updatedSkills.push(name);
                }
            } catch (err) {
                problem(`Could not update ${target}: ${err.message}`);
            }
        }
    }

    // ── 2. AI skills ──────────────────────────────────────────────────────────
    let external = { updated: [], newHashes: {}, newFolderHashes: {} };
    try {
        external = await externalSkills.update(
            sourcePath,
            home,
            manifest,
            { muted, success, warn },
            { scope: 'global' }
        );
        for (const name of external.updated) {
            if (!result.updatedSkills.includes(name)) {
                result.updatedSkills.push(name);
            }
        }
    } catch (err) {
        problem(`Could not update the AI skills: ${err.message}`);
    }

    // ── 3. lb-setup's generated files ────────────────────────────────────────
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
    if (assets && !(await globalAssetsMatch(assets))) {
        const dir = globalGeneratedDir();
        try {
            await writeGlobalAssets(assets);
            result.assetsWritten.push(dir);
        } catch (err) {
            problem(
                `Could not write the files lb-setup needs into ${dir}: ${err.message}`
            );
        }
    }

    // ── 4. The record ─────────────────────────────────────────────────────────
    const hashOrKeep = async (compute, kept) => {
        try {
            return await compute();
        } catch {
            return kept;
        }
    };
    const mcpTemplate = path.join(
        sourcePath,
        'skills',
        'lb-setup',
        'templates',
        'lb_mcp.json'
    );
    let mcpGatedSkills = manifest.mcpGatedSkills;
    try {
        const template = JSON.parse(await fs.readFile(mcpTemplate, 'utf8'));
        mcpGatedSkills = Object.values(template.mcpServers || {})
            .filter((server) => server.gatedBySkill)
            .map((server) => server.gatedBySkill)
            .sort();
    } catch {
        // keep the recorded list
    }
    const pyproject = assets?.get('python_deps/pyproject.toml');
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
        skillHashes: { ...oldHashes, ...newHashes, ...external.newHashes },
        externalSkillHashes: mergeExternalFolderHashes(
            manifest.externalSkillHashes,
            external.newFolderHashes
        ),
        externalManifestKeys: mergeExternalManifestKeys(
            manifest.externalManifestKeys,
            external.newHashes
        ),
        pyprojectHash: await hashOrKeep(
            () => computeDependencySetHash(sourcePath),
            manifest.pyprojectHash
        ),
        generatedPyprojectHash: pyproject
            ? crypto.createHash('sha256').update(pyproject).digest('hex')
            : manifest.generatedPyprojectHash,
        mcpTemplateHash: await hashOrKeep(
            () => computeFileHash(mcpTemplate),
            manifest.mcpTemplateHash
        ),
        agentsHash: await hashOrKeep(
            () =>
                computeFileHash(
                    path.join(sourcePath, 'agent_steering', 'AGENTS.md')
                ),
            manifest.agentsHash
        ),
        skillRequiresSetup: Object.fromEntries(
            selected
                .filter((s) => Object.hasOwn(SKILL_REQUIRES_SETUP, s))
                .sort()
                .map((s) => [s, SKILL_REQUIRES_SETUP[s]])
        ),
        mcpGatedSkills,
        generatedAssets: assets
            ? assetDigests(assets)
            : manifest.generatedAssets,
    };
    await writeGlobalState(
        GLOBAL_MANIFEST,
        JSON.stringify(updated, null, 2) + '\n'
    );
    await recordGlobalInstallSource(sourcePath);

    if (result.updatedSkills.length > 0) {
        success(
            `Global install: ${result.updatedSkills.length} skill(s) installed again from the updated source.`
        );
    } else if (followedByLinks === 0) {
        muted('  Global install: every skill is already up to date.');
    }
    if (followedByLinks > 0) {
        muted(
            `  Global install: ${result.changedSkills.length} skill(s) changed; their links already show the updated source.`
        );
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
 * any folder.
 *
 * @param {string} sourcePath - LaunchBridge source root (already updated)
 * @param {string} cwd - The folder `launchbridge update` runs in
 * @param {{ step: Function, success: Function, warn: Function, muted: Function, spacer: Function }} ui
 * @param {{ home?: string }} [options]
 * @returns {Promise<{ global: GlobalSyncResult, local: object | null,
 *   localSkipped: string | null }>} `localSkipped` says why the local sync
 *   did not run
 */
export async function runInstallSyncs(sourcePath, cwd, ui, { home } = {}) {
    const { checkWorkspace } = await import('./pathValidator.js');
    const { runPostPullSync } = await import('./updater.js');

    const global = await runGlobalSync(sourcePath, ui, { home });
    const check = await checkWorkspace(cwd);
    if (!check.ok) {
        return { global, local: null, localSkipped: check.reason };
    }
    const local = await runPostPullSync(sourcePath, cwd, ui);
    return { global, local, localSkipped: null };
}
