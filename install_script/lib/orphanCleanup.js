// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Orphan Cleanup Module
 *
 * Finds and removes skill directories the previous install created that are no
 * longer selected. Only names the previous manifest recorded are candidates, a
 * non-interactive (--yes) run never removes anything, and a symlinked orphan is
 * unlinked rather than followed, so nothing outside the skills directory is
 * deleted.
 */

import fs from 'fs/promises';
import path from 'path';
import { findOrphanSkills } from './installer.js';
import { checkSkillsDirectory } from './pathValidator.js';

/**
 * Removes a file, symlink or directory. A symlink is unlinked, never followed.
 * A path that does not exist is ignored.
 *
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
export async function removePath(targetPath) {
    try {
        const stats = await fs.lstat(targetPath);
        if (stats.isSymbolicLink() || stats.isFile()) {
            await fs.unlink(targetPath);
        } else if (stats.isDirectory()) {
            await fs.rm(targetPath, { recursive: true, force: true });
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

/**
 * @param {object} options
 * @param {string} options.baseTargetPath - The agent's skills directory
 * @param {string} options.targetRepository - Root the skills directory must stay inside
 * @param {string[]} options.selectedSkills - Skills selected in this run
 * @param {Set<string>} options.previouslyInstalled - Skills the previous manifest recorded
 * @param {boolean} [options.yes] - Non-interactive run: list orphans, remove nothing
 * @param {(orphans: string[], dir: string) => Promise<{action: string, names?: string[]}>} options.prompt
 * @param {(message: string) => void} [options.onWarn]
 * @returns {Promise<{action: 'none' | 'skip' | 'cancel' | 'remove' | 'refused', removed: string[]}>}
 */
export async function cleanupOrphanSkills({
    baseTargetPath,
    targetRepository,
    selectedSkills,
    previouslyInstalled,
    yes = false,
    prompt,
    onWarn = () => {},
}) {
    const dirCheck = await checkSkillsDirectory(
        baseTargetPath,
        targetRepository
    );
    if (!dirCheck.ok) {
        onWarn(
            `Not scanning ${baseTargetPath} for orphans: ${dirCheck.reason}`
        );
        return { action: 'refused', removed: [] };
    }

    const existingEntries = await fs.readdir(baseTargetPath, {
        withFileTypes: true,
    });
    const existingDirs = existingEntries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
    const orphans = findOrphanSkills(
        existingDirs,
        selectedSkills,
        previouslyInstalled
    );
    if (orphans.length === 0) {
        return { action: 'none', removed: [] };
    }

    if (yes) {
        onWarn(
            `Not removing ${orphans.length} skill(s) no longer selected in ${baseTargetPath} (--yes): ${orphans.join(', ')}. Re-run without --yes to remove them.`
        );
        return { action: 'skip', removed: [] };
    }

    const result = await prompt(orphans, baseTargetPath);
    if (result.action !== 'remove' || !result.names?.length) {
        return {
            action: result.action === 'cancel' ? 'cancel' : 'skip',
            removed: [],
        };
    }

    const removed = [];
    for (const orphan of result.names) {
        if (!orphans.includes(orphan)) continue;
        await removePath(path.join(baseTargetPath, orphan));
        removed.push(orphan);
    }
    return { action: 'remove', removed };
}
