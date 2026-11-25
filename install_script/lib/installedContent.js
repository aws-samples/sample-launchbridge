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
 * A symlink install's skill folder must be a link to the source folder. A copy
 * is compared entry by entry against the source: its files must have the
 * source files' bytes (an older symlink install's per-file links must point at
 * the matching source files). Python bytecode in a copied directory
 * (`__pycache__/`, `*.pyc`) is removed first: Python would run it in place of
 * the scripts, and it is never part of what is installed. A linked folder is
 * never changed: it is the LaunchBridge source itself.
 *
 * A folder an older symlink install made of one link per file is replaced by
 * a link to its source folder only when it holds nothing LaunchBridge did not
 * put there (entriesNotInstalled): anything else in it would be deleted with
 * it.
 */

import fs from 'fs/promises';
import path from 'path';
import { isPathWithin } from './pathSanitizer.js';

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
 * How an installed skill folder is laid out, without following it: `link` (a
 * symbolic link or junction, as a symlink install makes), `copy` (a real
 * folder holding no links), `per-file` (a real folder holding links, as an
 * older symlink install made: one link per file), `other` (not a folder), or
 * null when nothing is there.
 *
 * @param {string} targetPath
 * @returns {Promise<'link' | 'copy' | 'per-file' | 'other' | null>}
 */
export async function installedLayout(targetPath) {
    let stats;
    try {
        stats = await fs.lstat(targetPath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (stats.isSymbolicLink()) return 'link';
    if (!stats.isDirectory()) return 'other';
    return (await linkTargets(targetPath)).length > 0 ? 'per-file' : 'copy';
}

/**
 * Where a link points, resolved through links, without needing its target to
 * exist: a link whose target is gone resolves through its nearest existing
 * ancestor.
 * @param {string} link
 * @returns {Promise<string>}
 */
async function resolveLink(link) {
    try {
        return await fs.realpath(link);
    } catch {
        let existing = path.resolve(
            path.dirname(link),
            await fs.readlink(link)
        );
        const rest = [];
        for (;;) {
            try {
                return path.join(await fs.realpath(existing), ...rest);
            } catch {
                const parent = path.dirname(existing);
                if (parent === existing) return path.join(existing, ...rest);
                rest.unshift(path.basename(existing));
                existing = parent;
            }
        }
    }
}

/**
 * What a skill folder laid out the way LaunchBridge 1.2.0 installed it (a
 * real folder whose files are links; installedLayout `per-file`) holds besides
 * what LaunchBridge put there, so that replacing it with a link to its source
 * folder loses nothing when the list is empty.
 *
 * LaunchBridge put there: folders, links that resolve inside the LaunchBridge
 * source (a link whose target is gone counts when the target was inside it),
 * and regular files at the paths the installer writes itself for the agent
 * (`ownFiles`), whatever their bytes. Python bytecode (`__pycache__/`,
 * `*.pyc`) and `.DS_Store` are not counted either. Every other entry is
 * listed. No link is followed.
 *
 * @param {string} targetPath - The installed skill folder (a real folder)
 * @param {string} sourceRoot - The LaunchBridge source
 * @param {{ ownFiles?: Iterable<string> }} [options] - POSIX relative paths
 *   of the files the installer writes into this agent's copy of the skill (an
 *   AI skill's SKILL.md, and Codex's agents/openai.yaml: the keys of
 *   agentFilesFor); none for a native skill
 * @returns {Promise<string[]>} The entries LaunchBridge did not install, by
 *   POSIX path relative to the folder, sorted; empty when there are none
 * @throws {Error} When `targetPath` is not a real folder, or can't be read
 */
export async function entriesNotInstalled(
    targetPath,
    sourceRoot,
    { ownFiles = [] } = {}
) {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`${targetPath} is not a folder`);
    }
    const root = await fs.realpath(sourceRoot);
    const own = new Set(ownFiles);
    const found = [];
    const walk = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (IGNORED.has(entry.name) || isBytecode(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const rel = path
                .relative(targetPath, full)
                .split(path.sep)
                .join('/');
            if (entry.isSymbolicLink()) {
                if (!isPathWithin(await resolveLink(full), root)) {
                    found.push(rel);
                }
            } else if (entry.isDirectory()) {
                await walk(full);
            } else if (!(entry.isFile() && own.has(rel))) {
                found.push(rel);
            }
        }
    };
    await walk(targetPath);
    return found.sort();
}

/**
 * @param {string} targetPath - Installed skill directory (or a link to one)
 * @param {string | undefined} sourcePath - The skill's directory in this source
 * @param {string} [sourceRoot] - The LaunchBridge source; every link in the
 *   installed directory must resolve inside it (default: `sourcePath`)
 * @param {{ overrides?: Map<string, Buffer>, layout?: 'link' | 'copy' }} [options]
 *   `overrides`: files the installer writes itself in place of (or beside) the
 *   source's, by POSIX relative path: an AI skill's SKILL.md for every agent
 *   but Claude Code, and Codex's agents/openai.yaml. Each must be a regular
 *   file holding exactly these bytes. `layout`: how this run installs the
 *   skill (installer.js skillLayout); an installed folder laid out the other
 *   way doesn't match. Without it, either way matches.
 * @returns {Promise<boolean>} true when the installed directory holds exactly the
 *   source's files: a link to the source folder, identical copies, or (an
 *   older symlink install) links to the matching source files
 */
export async function installedSkillMatches(
    targetPath,
    sourcePath,
    sourceRoot = sourcePath,
    { overrides, layout } = {}
) {
    if (!sourcePath) return false;
    try {
        const stats = await fs.lstat(targetPath);
        const sourceReal = await fs.realpath(sourcePath);
        if (stats.isSymbolicLink()) {
            if (layout === 'copy') return false;
            return (await fs.realpath(targetPath)) === sourceReal;
        }
        if (!stats.isDirectory() || layout === 'link') return false;

        // A link elsewhere (a folder in the repository holding planted bytecode
        // or scripts) would be followed below and its contents trusted. A
        // copy holds no links at all.
        const root = await fs.realpath(sourceRoot);
        const links = await linkTargets(targetPath);
        if (layout === 'copy' && links.length > 0) return false;
        for (const target of links) {
            const relative = path.relative(root, target);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                return false;
            }
        }

        await removeInstalledBytecode(targetPath);
        const own = new Map(
            [...(overrides ?? new Map())].map(([rel, bytes]) => [
                path.join(...rel.split('/')),
                bytes,
            ])
        );
        const [installed, fromSource] = await Promise.all([
            listFiles(targetPath),
            listFiles(sourceReal),
        ]);
        const expected = [...new Set([...fromSource, ...own.keys()])].sort();
        if (installed.join('\0') !== expected.join('\0')) return false;

        for (const rel of installed) {
            const target = path.join(targetPath, rel);
            const source = path.join(sourceReal, rel);
            if (own.has(rel)) {
                const stats = await fs.lstat(target);
                if (!stats.isFile()) return false;
                if (!(await fs.readFile(target)).equals(own.get(rel))) {
                    return false;
                }
                continue;
            }
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
