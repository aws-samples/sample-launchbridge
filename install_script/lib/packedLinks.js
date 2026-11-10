// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Packed Links Module
 *
 * The LaunchBridge git clone contains symlinks that point from a skill into
 * `project_dependencies/` (shared content such as the metric-library). `npm
 * pack`, and therefore `npx github:aws-samples/sample-launchbridge`, ships the
 * link targets but drops the links themselves. When the installer runs from
 * such a packaged copy (delivery method `bundled`), this module recreates the
 * links inside the package's own source tree so the rest of the installer
 * (copying, hashing, integrity baselines) sees the same tree a clone has.
 *
 * Where a symlink cannot be created (Windows without Developer Mode), the
 * target directory is copied instead; the resulting tree hashes the same
 * because content hashing follows links.
 */

import fs from 'fs/promises';
import path from 'path';
import { safePathJoin } from './pathSanitizer.js';

/**
 * Symlinks in the git clone that `npm pack` does not ship, as
 * `{ linkPath: linkTarget }`, both relative to the LaunchBridge source root.
 * Keep in sync with the repository: `git ls-files -s | grep ^120000`.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PACKED_LINKS = Object.freeze({
    'skills/evaluate-predictions/lib/metric-library':
        'project_dependencies/metric-library',
});

/**
 * Recreates missing packed links under `sourcePath`.
 *
 * Only acts when the link path is absent and its target exists; an existing
 * entry of any kind is left alone, so a clone is never modified.
 *
 * @param {string} sourcePath - LaunchBridge source root
 * @param {Readonly<Record<string, string>>} [links] - override for tests
 * @returns {Promise<{ restored: string[], copied: string[], skipped: string[] }>}
 */
export async function restorePackedLinks(sourcePath, links = PACKED_LINKS) {
    const result = { restored: [], copied: [], skipped: [] };

    for (const [linkRel, targetRel] of Object.entries(links)) {
        const linkPath = safePathJoin(sourcePath, linkRel);
        const targetPath = safePathJoin(sourcePath, targetRel);

        if (await exists(linkPath)) {
            continue;
        }
        if (!(await isDirectory(targetPath))) {
            result.skipped.push(linkRel);
            continue;
        }

        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        const relativeTarget = path.relative(
            path.dirname(linkPath),
            targetPath
        );
        try {
            await fs.symlink(relativeTarget, linkPath, 'dir');
            result.restored.push(linkRel);
        } catch (err) {
            if (err.code !== 'EPERM' && err.code !== 'EACCES') {
                throw err;
            }
            await fs.cp(targetPath, linkPath, { recursive: true });
            result.copied.push(linkRel);
        }
    }

    return result;
}

async function exists(p) {
    try {
        await fs.lstat(p);
        return true;
    } catch {
        return false;
    }
}

async function isDirectory(p) {
    try {
        return (await fs.stat(p)).isDirectory();
    } catch {
        return false;
    }
}
