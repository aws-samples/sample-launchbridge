// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Installed Content Module
 *
 * Tells whether an installed skill directory still holds what this LaunchBridge
 * source would install. The version manifest records the source's hashes, but the
 * manifest lives in the target repository and can arrive with it, so a re-run
 * compares the installed directories themselves before deciding there is nothing
 * to do.
 *
 * Both install methods are compared entry by entry against the source: a copy
 * install's files must have the source files' bytes, and a symlink install's
 * per-file links must point at the matching source files. Python bytecode in the
 * installed directory (`__pycache__/`, `*.pyc`) is removed first: Python would
 * run it in place of the scripts, and it is never part of what is installed.
 */

import fs from 'fs/promises';
import path from 'path';

/** Names that are never compared (the source may hold them; nothing installs them). */
const IGNORED = new Set(['.DS_Store']);

/** Case-insensitively: macOS and Windows load `__PyCache__/X.PYC` too. */
function isBytecode(name) {
    const lower = name.toLowerCase();
    return lower === '__pycache__' || lower.endsWith('.pyc');
}

/**
 * Removes Python bytecode from an installed skill directory, without following
 * links (a link is removed, never its target).
 * @param {string} dir
 */
export async function removeInstalledBytecode(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (isBytecode(entry.name)) {
            await fs.rm(full, { recursive: true, force: true });
        } else if (entry.isDirectory()) {
            await removeInstalledBytecode(full);
        }
    }
}

/**
 * Relative paths of the files under `dir`, sorted. A link to a file counts as a
 * file; a link to a directory is followed (the source has some, such as
 * evaluate-predictions' lib/metric-library, and a copy install holds the real
 * tree), with each directory visited once.
 */
async function listFiles(dir, base = dir, seen = new Set()) {
    const real = await fs.realpath(dir);
    if (seen.has(real)) return [];
    seen.add(real);
    const files = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (IGNORED.has(entry.name) || isBytecode(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const isDir =
            entry.isDirectory() ||
            (entry.isSymbolicLink() &&
                (await fs.stat(full).catch(() => null))?.isDirectory());
        if (isDir) {
            files.push(...(await listFiles(full, base, seen)));
        } else {
            files.push(path.relative(base, full));
        }
    }
    return files.sort();
}

/**
 * Every link under `dir`, without following any, resolved.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function linkTargets(dir) {
    const targets = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
            targets.push(await fs.realpath(full).catch(() => full));
        } else if (entry.isDirectory()) {
            targets.push(...(await linkTargets(full)));
        }
    }
    return targets;
}

/**
 * @param {string} targetPath - Installed skill directory (or a link to one)
 * @param {string | undefined} sourcePath - The skill's directory in this source
 * @param {string} [sourceRoot] - The LaunchBridge source; every link in the
 *   installed directory must resolve inside it (default: `sourcePath`)
 * @returns {Promise<boolean>} true when the installed directory holds exactly the
 *   source's files: identical copies, or links to the matching source files
 */
export async function installedSkillMatches(
    targetPath,
    sourcePath,
    sourceRoot = sourcePath
) {
    if (!sourcePath) return false;
    try {
        const stats = await fs.lstat(targetPath);
        const sourceReal = await fs.realpath(sourcePath);
        if (stats.isSymbolicLink()) {
            return (await fs.realpath(targetPath)) === sourceReal;
        }
        if (!stats.isDirectory()) return false;

        // A link elsewhere (a folder in the repository holding planted bytecode
        // or scripts) would be followed below and its contents trusted.
        const root = await fs.realpath(sourceRoot);
        for (const target of await linkTargets(targetPath)) {
            const relative = path.relative(root, target);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                return false;
            }
        }

        await removeInstalledBytecode(targetPath);
        const [installed, expected] = await Promise.all([
            listFiles(targetPath),
            listFiles(sourceReal),
        ]);
        if (installed.join('\0') !== expected.join('\0')) return false;

        for (const rel of installed) {
            const target = path.join(targetPath, rel);
            const source = path.join(sourceReal, rel);
            if ((await fs.lstat(target)).isSymbolicLink()) {
                if (
                    (await fs.realpath(target)) !== (await fs.realpath(source))
                ) {
                    return false;
                }
            } else {
                const [a, b] = await Promise.all([
                    fs.readFile(target),
                    fs.readFile(source),
                ]);
                if (!a.equals(b)) return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}
