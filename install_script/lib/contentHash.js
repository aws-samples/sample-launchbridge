// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Content Hash Module
 *
 * Computes deterministic SHA-256 hashes of directory contents for change
 * detection. Files are sorted by relative path (forward-slash normalized)
 * before hashing to ensure platform-independent determinism.
 *
 * Excluded from hashing: .DS_Store, __pycache__/, *.pyc and .git/
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { isPathWithin, safePathJoin } from './pathSanitizer.js';

/**
 * Patterns to exclude from content hashing.
 * @type {string[]}
 */
const EXCLUDED_NAMES = ['.DS_Store', '__pycache__', '.git'];

/**
 * Returns true if a file or directory should be excluded from hashing.
 * @param {string} name - The base name of the file or directory
 * @returns {boolean}
 */
function isExcluded(name) {
    if (EXCLUDED_NAMES.includes(name)) {
        return true;
    }
    if (name.endsWith('.pyc')) {
        return true;
    }
    return false;
}

/**
 * Recursively enumerates all files in a directory, excluding ignored patterns.
 * @param {string} dirPath - Absolute path to the directory
 * @param {string} [relativeTo] - Base path for computing relative paths
 * @param {string} [allowedRoot] - Real path symlinks must resolve inside; see computeContentHash
 * @param {Set<string>} [ancestors] - Real paths of the directories being walked;
 *     a link back to one of them (a cycle) is skipped
 * @returns {Promise<string[]>} Array of relative file paths (forward-slash normalized)
 */
async function listFilesRecursive(
    dirPath,
    relativeTo = dirPath,
    allowedRoot,
    ancestors = new Set()
) {
    const results = [];
    let entries;
    let here;
    try {
        here = new Set(ancestors).add(await fs.realpath(dirPath));
    } catch {
        return results;
    }

    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (isExcluded(entry.name)) {
            continue;
        }

        const fullPath = safePathJoin(dirPath, entry.name);

        if (entry.isDirectory()) {
            const nested = await listFilesRecursive(
                fullPath,
                relativeTo,
                allowedRoot,
                here
            );
            results.push(...nested);
        } else if (entry.isFile()) {
            const relativePath = path
                .relative(relativeTo, fullPath)
                .replace(/\\/g, '/');
            results.push(relativePath);
        } else if (entry.isSymbolicLink()) {
            // Follow symlinks — resolve the real path and stat it to
            // determine whether it's a directory or file. This ensures
            // symlinked content (e.g. metric-library) is included in
            // the skill hash.
            try {
                const realPath = await fs.realpath(fullPath);
                // Skip links that resolve outside allowedRoot.
                if (allowedRoot && !isPathWithin(realPath, allowedRoot)) {
                    continue;
                }
                if (here.has(realPath)) {
                    continue;
                }
                const stat = await fs.stat(realPath);
                if (stat.isDirectory()) {
                    // Recurse into the resolved directory but compute
                    // relative paths against the *symlink location*
                    // (fullPath), not the skill root. This keeps paths
                    // like "lib/metric-library/file.py" instead of
                    // producing "../../project_dependencies/..." which
                    // would escape the skill directory.
                    const nested = await listFilesRecursive(
                        realPath,
                        realPath,
                        allowedRoot,
                        here
                    );
                    // Prefix each nested path with the symlink's
                    // relative location within the skill tree.
                    const symlinkRel = path
                        .relative(relativeTo, fullPath)
                        .replace(/\\/g, '/');
                    for (const nestedPath of nested) {
                        results.push(`${symlinkRel}/${nestedPath}`);
                    }
                } else if (stat.isFile()) {
                    const relativePath = path
                        .relative(relativeTo, fullPath)
                        .replace(/\\/g, '/');
                    results.push(relativePath);
                }
            } catch {
                // Broken symlink — skip
            }
        }
    }

    return results;
}

/**
 * Computes a deterministic SHA-256 hash of all file contents in a directory.
 * Files are sorted by relative path (forward-slash normalized) before hashing
 * to ensure platform-independent determinism.
 *
 * Symlinks are followed so linked content (e.g. lib/metric-library) is hashed.
 * With `allowedRoot` (the real path of the LaunchBridge source), links that
 * resolve outside it are skipped. Without it every link is followed, matching
 * verify_integrity.py; for a skill with no outside links both give the same hash.
 *
 * `overrides` gives the bytes of files as installed, by relative path: a
 * listed file's bytes are replaced and any other path is added. The result is
 * the hash of the directory as installed with those files (an AI skill's own
 * SKILL.md for an agent, and Codex's agents/openai.yaml).
 *
 * @param {string} dirPath - Absolute path to the skill directory
 * @param {{ allowedRoot?: string, overrides?: Map<string, Buffer> }} [options]
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 */
export async function computeContentHash(
    dirPath,
    { allowedRoot, overrides } = {}
) {
    const relativePaths = await listFilesRecursive(
        dirPath,
        dirPath,
        allowedRoot
    );
    for (const relPath of overrides?.keys() ?? []) {
        if (!relativePaths.includes(relPath)) {
            relativePaths.push(relPath);
        }
    }
    const sortedPaths = relativePaths.sort();

    const hasher = crypto.createHash('sha256');

    for (const relPath of sortedPaths) {
        const content =
            overrides?.get(relPath) ??
            (await fs.readFile(safePathJoin(dirPath, relPath)));
        hasher.update(relPath + '\0');
        hasher.update(content);
    }

    return hasher.digest('hex');
}

/**
 * Computes Content_Hashes for multiple skill directories.
 * @param {Record<string, string>} skillPaths - Map of skill name → source directory path
 * @param {{ allowedRoot?: string }} [options] - Passed to computeContentHash
 * @returns {Promise<Record<string, string>>} Map of skill name → Content_Hash
 */
export async function computeSkillHashes(skillPaths, options = {}) {
    const result = {};

    for (const [name, dirPath] of Object.entries(skillPaths)) {
        result[name] = await computeContentHash(dirPath, options);
    }

    return result;
}

/**
 * Computes a hash of a single file's contents.
 * Used for pyproject.toml, MCP template, and AGENTS.md change detection.
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 */
export async function computeFileHash(filePath) {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Computes one hash over the Python dependency set in project_dependencies/:
 * pyproject.toml and the frozen constraints.txt. A change to either one,
 * including a re-freeze that changes only constraints.txt, changes the hash.
 * @param {string} sourcePath - LaunchBridge source root
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 * @throws if either file cannot be read
 */
export async function computeDependencySetHash(sourcePath) {
    const hash = crypto.createHash('sha256');
    for (const name of ['pyproject.toml', 'constraints.txt']) {
        const content = await fs.readFile(
            safePathJoin(sourcePath, 'project_dependencies', name)
        );
        hash.update(`${name}\0${content.length}\0`);
        hash.update(content);
    }
    return hash.digest('hex');
}
