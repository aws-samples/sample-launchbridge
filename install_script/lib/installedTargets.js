// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Installed Targets Module
 *
 * Records which skill directories LaunchBridge itself installed in a target
 * repository, as repository-relative paths (e.g. `.claude/skills/testing-framework`).
 * The installer, the updater and orphan cleanup replace or remove only these.
 * A same-named directory LaunchBridge skipped because it was already there is
 * never recorded, so a later run leaves it alone. A recorded directory of a
 * skill no longer selected stays recorded while it is there, until a run
 * removes it.
 *
 * Manifests written before this field existed have no record; callers then
 * fall back to the skill names in the manifest.
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Repository-relative POSIX path of a skill directory, used as the record key.
 *
 * @param {string} targetRepo - Root of the target repository
 * @param {string} skillTargetPath - Absolute path of the skill directory
 * @returns {string}
 */
export function targetKey(targetRepo, skillTargetPath) {
    return path.relative(targetRepo, skillTargetPath).split(path.sep).join('/');
}

/**
 * The recorded skill directories from a manifest, or null when the manifest
 * predates the record.
 *
 * @param {object | null | undefined} manifest
 * @returns {Set<string> | null}
 */
export function readInstalledTargets(manifest) {
    return Array.isArray(manifest?.installedTargets)
        ? new Set(manifest.installedTargets)
        : null;
}

/**
 * Skill names recorded under one skills directory.
 *
 * @param {Set<string>} installed - From readInstalledTargets
 * @param {string} targetRepo - Root of the target repository
 * @param {string} baseTargetPath - Absolute skills directory (e.g. `<repo>/.claude/skills`)
 * @returns {Set<string>}
 */
export function namesUnder(installed, targetRepo, baseTargetPath) {
    const prefix = `${targetKey(targetRepo, baseTargetPath)}/`;
    const names = new Set();
    for (const key of installed) {
        if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            if (rest && !rest.includes('/')) names.add(rest);
        }
    }
    return names;
}

/**
 * Recorded skill directories under one skills directory whose skills are not
 * selected, that are still there: an earlier run left them in place (a --yes
 * run, or the user kept them). When the skills directory can't be read, every
 * such recorded name is returned.
 *
 * @param {Set<string>} installed - From readInstalledTargets
 * @param {string} targetRepo - Root of the target repository
 * @param {string} baseTargetPath - Absolute skills directory
 * @param {Iterable<string>} selectedSkills - The skills selected now
 * @returns {Promise<string[]>} Their names, sorted
 */
export async function recordedOrphans(
    installed,
    targetRepo,
    baseTargetPath,
    selectedSkills
) {
    const selected = new Set(selectedSkills);
    const recorded = [
        ...namesUnder(installed, targetRepo, baseTargetPath),
    ].filter(
        (name) =>
            !selected.has(name) &&
            name !== '.' &&
            name !== '..' &&
            !name.includes('\\')
    );
    if (recorded.length === 0) return [];
    let entries;
    try {
        entries = await fs.readdir(baseTargetPath, { withFileTypes: true });
    } catch (error) {
        return error.code === 'ENOENT' ? [] : recorded.sort();
    }
    const present = new Set(
        entries
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name)
    );
    return recorded.filter((name) => present.has(name)).sort();
}
