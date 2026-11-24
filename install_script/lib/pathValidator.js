// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Path Validator Module
 *
 * Validates source and target paths for the skill installer.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { getAgentConfig, getSkillsDir } from './agentConfig.js';
import {
    validatePathWithinBase,
    safePathJoin,
    isPathWithin,
} from './pathSanitizer.js';
import { WORKSPACE_SUBDIRECTORIES, ARTIFACT_STRUCTURE } from './folderSetup.js';
import { realpathOfNearest } from './stateDir.js';

/**
 * @typedef {import('./agentConfig.js').AgentType} Agent
 * @typedef {import('./agentConfig.js').Scope} Scope
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether the path is valid
 * @property {string} [error] - Error message if invalid
 * @property {string} [resolvedPath] - Resolved absolute path if valid
 */

/**
 * Sanitizes and resolves a user-supplied path string. Strips control
 * characters and null bytes, expands a leading `~` to the user's home
 * directory, then resolves to an absolute path. Centralizing this logic
 * keeps the sanitization boundary in one place for static analysis.
 *
 * @param {string} input - Raw user-supplied path
 * @returns {string} Sanitized absolute path
 */
function sanitizeAndResolveUserPath(input) {
    // Strip control characters and null bytes that could enable injection
    const cleaned = input.trim().replace(/[\x00-\x1f\x7f]/g, '');
    // Expand leading ~ to the user's home directory
    const expanded = cleaned.startsWith('~')
        ? safePathJoin(os.homedir(), cleaned.slice(1))
        : cleaned;
    return path.resolve(expanded);
}

/**
 * Validates that the source repository path exists and contains a /skills directory.
 * @param {string} inputPath - Path to validate
 * @returns {ValidationResult}
 */
export function validateSourceRepository(inputPath) {
    if (!inputPath || inputPath.trim() === '') {
        return { valid: false, error: 'Path cannot be empty' };
    }

    const resolvedPath = sanitizeAndResolveUserPath(inputPath);

    // Check if path exists
    if (!fs.existsSync(resolvedPath)) {
        return {
            valid: false,
            error: `Source path does not exist: ${inputPath}`,
        };
    }

    // Check if it's a directory
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
        return {
            valid: false,
            error: `Source path is not a directory: ${inputPath}`,
        };
    }

    // Check if /skills directory exists
    const skillsPath = safePathJoin(resolvedPath, 'skills');
    const skillsValidation = validatePathWithinBase(skillsPath, resolvedPath);
    if (!skillsValidation.valid) {
        return { valid: false, error: skillsValidation.error };
    }
    if (!fs.existsSync(skillsPath)) {
        return {
            valid: false,
            error: 'Source path does not contain a /skills directory',
        };
    }

    const skillsStats = fs.statSync(skillsPath);
    if (!skillsStats.isDirectory()) {
        return {
            valid: false,
            error: 'Source path does not contain a /skills directory',
        };
    }

    return { valid: true, resolvedPath };
}

/**
 * Validates that the target directory is valid.
 * Checks if the path exists and is a directory, or if it can be created.
 *
 * @param {string} targetPath - Path to validate
 * @returns {ValidationResult}
 *
 * Requirements: 9.1
 */
export function validateTargetDirectory(targetPath) {
    if (!targetPath || targetPath.trim() === '') {
        return { valid: false, error: 'Target path cannot be empty' };
    }

    const resolvedPath = sanitizeAndResolveUserPath(targetPath);

    // Check if path exists
    if (fs.existsSync(resolvedPath)) {
        // Check if it's a directory
        try {
            const stats = fs.statSync(resolvedPath);
            if (!stats.isDirectory()) {
                return {
                    valid: false,
                    error: `Target repository is not a valid directory: "${targetPath}". The path exists but is not a directory.`,
                };
            }
        } catch (error) {
            return {
                valid: false,
                error: `Unable to access target repository: "${targetPath}". ${error.message}`,
            };
        }
    }
    // If path doesn't exist, that's okay - we'll create it during installation

    return { valid: true, resolvedPath };
}

/**
 * Checks if the user has write permissions to the specified path.
 * If the path doesn't exist, checks the nearest existing parent directory.
 *
 * @param {string} targetPath - Path to check
 * @returns {ValidationResult}
 *
 * Requirements: 9.2
 */
export function checkWritePermissions(targetPath) {
    if (!targetPath || targetPath.trim() === '') {
        return { valid: false, error: 'Path cannot be empty' };
    }

    const resolvedPath = sanitizeAndResolveUserPath(targetPath);

    // Find the nearest existing directory to check permissions
    let pathToCheck = resolvedPath;
    while (!fs.existsSync(pathToCheck)) {
        const parentPath = path.dirname(pathToCheck);
        if (parentPath === pathToCheck) {
            // Reached root without finding existing directory
            return {
                valid: false,
                error: `Unable to determine write permissions: no accessible parent directory found for "${targetPath}"`,
            };
        }
        pathToCheck = parentPath;
    }

    // Check write permissions on the existing directory
    try {
        fs.accessSync(pathToCheck, fs.constants.W_OK);
        return { valid: true, resolvedPath };
    } catch (error) {
        const suggestion =
            'Check that you own the directory and can write to it. ' +
            "Don't run the installer with sudo or as Administrator: the files it creates would be owned by that account.";

        return {
            valid: false,
            error: `Permission denied: Unable to write to "${pathToCheck}". ${suggestion}`,
        };
    }
}

/**
 * Checks that a path inside the target repository can be written to and
 * deleted from: no path component between `rootPath` and `targetPath` is a
 * symlink, and the real path stays inside the root's real path. Components that
 * do not exist yet are fine (they will be created as real files/directories).
 *
 * @param {string} targetPath - Absolute path to check
 * @param {string} rootPath - Directory it must stay inside (the target repository)
 * @param {{ allowFile?: boolean }} [options] - Accept a regular file as the
 *     last component (directories are always accepted)
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkPathInRoot(targetPath, rootPath, options = {}) {
    const root = path.resolve(rootPath);
    const dir = path.resolve(targetPath);
    const rel = path.relative(root, dir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, reason: `${dir} is not inside ${root}` };
    }

    const parts = rel.split(path.sep);
    let current = root;
    for (const [i, part] of parts.entries()) {
        current = path.join(current, part);
        let stats;
        try {
            stats = await fs.promises.lstat(current);
        } catch (err) {
            if (err.code === 'ENOENT') return { ok: true };
            throw err;
        }
        if (stats.isSymbolicLink()) {
            return { ok: false, reason: `${current} is a symlink` };
        }
        const isLast = i === parts.length - 1;
        if (
            !stats.isDirectory() &&
            !(isLast && options.allowFile && stats.isFile())
        ) {
            return { ok: false, reason: `${current} is not a directory` };
        }
    }

    const [realRoot, realDir] = await Promise.all([
        fs.promises.realpath(root),
        fs.promises.realpath(dir),
    ]);
    const realRel = path.relative(realRoot, realDir);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return { ok: false, reason: `${dir} resolves outside ${root}` };
    }
    return { ok: true };
}

/**
 * Checks that an agent skills directory can be written to and deleted from;
 * see checkPathInRoot.
 *
 * @param {string} skillsDir - Absolute skills directory (e.g. `<repo>/.claude/skills`)
 * @param {string} rootPath - Directory it must stay inside (the target repository)
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export function checkSkillsDirectory(skillsDir, rootPath) {
    return checkPathInRoot(skillsDir, rootPath);
}

/**
 * Checks a user-level (global install) skills directory before anything is
 * written into it or removed from it.
 *
 * Unlike a repository's skills directory, links on the way are allowed: a
 * `~/.claude` that points into a dotfiles repository is a common setup. The
 * directory must still be under the home directory as written, every existing
 * component must be a directory (or a link to one), and its real location must
 * not be inside the LaunchBridge source, whose own skills an install there
 * would overwrite.
 *
 * @param {string} skillsDir - Absolute skills directory (e.g. `~/.claude/skills`)
 * @param {{ sourcePath?: string, home?: string }} [options] - The LaunchBridge
 *     source, and the home directory (default `os.homedir()`)
 * @returns {Promise<{ok: true, realPath: string, linked: boolean} | {ok: false, reason: string}>}
 *     `realPath` is where the directory really is; `linked` is true when a
 *     link on the way makes that differ from the path as written
 */
export async function checkGlobalSkillsDirectory(
    skillsDir,
    { sourcePath, home = os.homedir() } = {}
) {
    const dir = path.resolve(skillsDir);
    const homeDir = path.resolve(home);
    const rel = path.relative(homeDir, dir);
    if (
        rel === '' ||
        rel === '..' ||
        rel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rel)
    ) {
        return {
            ok: false,
            reason: `${dir} is not inside your home directory (${homeDir})`,
        };
    }

    let current = homeDir;
    for (const part of rel.split(path.sep)) {
        current = path.join(current, part);
        let stats;
        try {
            stats = await fs.promises.lstat(current);
        } catch (err) {
            if (err.code === 'ENOENT') break;
            throw err;
        }
        if (stats.isSymbolicLink()) {
            try {
                stats = await fs.promises.stat(current);
            } catch {
                return {
                    ok: false,
                    reason: `${current} is a link to something that does not exist`,
                };
            }
        }
        if (!stats.isDirectory()) {
            return { ok: false, reason: `${current} is not a directory` };
        }
    }

    const realPath = realpathOfNearest(dir);
    if (sourcePath) {
        const realSource = fs.realpathSync(sourcePath);
        if (isPathWithin(realPath, realSource)) {
            return {
                ok: false,
                reason:
                    `${dir} resolves to ${realPath}, inside the LaunchBridge source ` +
                    `(${realSource}); installing there would overwrite the source's own files`,
            };
        }
    }
    const asWritten = path.join(realpathOfNearest(homeDir), rel);
    return { ok: true, realPath, linked: realPath !== asWritten };
}

/** `.lb_workspace` directories the installer and updater write into. */
const WORKSPACE_DIRS = [
    '',
    'config/python_deps',
    'steering',
    ...WORKSPACE_SUBDIRECTORIES,
];

/** Files the installer and updater write inside `.lb_workspace`. */
const WORKSPACE_FILES = [
    'setup_status.md',
    'config/version_manifest.json',
    'config/skill_digests.json',
    'config/python_deps/pyproject.toml',
    'config/python_deps/constraints.txt',
    'steering/AGENTS_LB.md',
];

/**
 * Checks, before any write, that `.lb_workspace` and every directory and file the
 * installer or updater writes in it, and the `.project_artifacts` folders the
 * installer creates, stay inside the target repository and are not reached
 * through a symlink; see checkPathInRoot.
 *
 * @param {string} targetRepo - Root of the target repository
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkWorkspace(targetRepo) {
    const workspace = path.join(targetRepo, '.lb_workspace');
    for (const dir of WORKSPACE_DIRS) {
        const result = await checkPathInRoot(
            path.join(workspace, dir),
            targetRepo
        );
        if (!result.ok) return result;
    }
    for (const file of WORKSPACE_FILES) {
        const result = await checkPathInRoot(
            path.join(workspace, file),
            targetRepo,
            { allowFile: true }
        );
        if (!result.ok) return result;
    }
    const artifacts = path.join(targetRepo, ARTIFACT_STRUCTURE.root);
    for (const dir of ['', ...ARTIFACT_STRUCTURE.subdirectories]) {
        const result = await checkPathInRoot(
            path.join(artifacts, dir),
            targetRepo
        );
        if (!result.ok) return result;
    }
    return { ok: true };
}

/**
 * The absolute user-level skills directory of an agent (a global install).
 *
 * @param {Agent} agent
 * @param {{ home?: string, pathApi?: typeof path }} [options] - The home
 *     directory (default `os.homedir()`, which is `$HOME` on macOS and Linux
 *     and `%USERPROFILE%` on Windows) and the path flavour to join with
 *     (default the platform's; tests pass `path.win32`)
 * @returns {string}
 */
export function globalSkillsDir(
    agent,
    { home = os.homedir(), pathApi = path } = {}
) {
    // The segments come from the fixed agent table, not from user input.
    const segments = getSkillsDir(agent, 'global').split('/');
    // nosemgrep: path-join-resolve-traversal
    return pathApi.join(home, ...segments);
}

/**
 * Resolves the target path for skill installation based on agent, scope, and target repository.
 *
 * Target paths resolve as (see the AGENTS table in agentConfig.js):
 * - Local: `<targetRepo>/<skillsDir>`, e.g. `<targetRepo>/.kiro/skills`
 * - Global: `<home>/<globalSkillsDir>`, e.g. `~/.kiro/skills`, `~/.claude/skills`,
 *   and `~/.agents/skills` for Codex, pi and other agents
 *
 * @param {Agent} agent - The agent type (a key of AGENTS)
 * @param {Scope} scope - The installation scope ('local' or 'global')
 * @param {string} [targetRepo] - The target repository path (local scope only)
 * @returns {string} The resolved target path
 */
export function getTargetPath(agent, scope, targetRepo) {
    const config = getAgentConfig(agent);
    if (!config) {
        throw new Error(`Unknown agent type: ${agent}`);
    }

    if (scope === 'global') {
        return globalSkillsDir(agent);
    }

    // targetRepo comes from process.cwd() — already a trusted absolute path.
    if (!targetRepo || typeof targetRepo !== 'string') {
        throw new Error(
            'Invalid target repository path: must be a non-empty string.'
        );
    }
    const resolvedTargetRepo = sanitizeAndResolveUserPath(targetRepo);
    return safePathJoin(resolvedTargetRepo, getSkillsDir(agent, 'local'));
}
