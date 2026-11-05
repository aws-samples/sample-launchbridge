// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Installation Executor Module
 *
 * Executes the actual installation operations.
 */

import fs from 'fs/promises';
import { isPathWithin } from './pathSanitizer.js';

/** Advice appended to permission errors. */
export const PERMISSION_HINT =
    "Check that you own the directory and can write to it. Don't run the installer with sudo or as Administrator: the files it creates would be owned by that account.";

/**
 * Creates a directory structure with symlinked files from source to target.
 * Creates real directories but symlinks individual files, allowing tools
 * that don't follow directory symlinks to still access the content.
 *
 * NOTE: Kiro IDE's tool validation rejects symlinked files (lstat sees
 * "symlink" not "file"), and directory-level symlinks are skipped by skill
 * discovery (Dirent.isDirectory() returns false for symlinks). Users
 * hitting this should use copy mode as a workaround.
 * See: https://github.com/kirodotdev/Kiro/issues/6401
 *
 * @param {string} source - Source path (the skill directory to link to)
 * @param {string} target - Target path (where the structure will be created)
 * @returns {Promise<void>}
 * @throws {Error} If target already exists or symlink creation fails
 *
 * Requirements: 3.2, 7.2, 7.4, 9.3
 */
export async function createSymlink(source, target) {
    // Check if target already exists
    try {
        await fs.lstat(target);
        // If we get here, target exists (file, directory, or symlink)
        throw new Error(
            `Target path already exists: "${target}". ` +
                `Please remove the existing file/directory or use the conflict resolution prompt.`
        );
    } catch (error) {
        // ENOENT means target doesn't exist, which is what we want
        if (error.code === 'ENOENT') {
            // Target doesn't exist, proceed with symlink creation
        } else if (error.code === 'EACCES' || error.code === 'EPERM') {
            // Permission denied when checking target - can't create symlink here
            throw new Error(
                `Permission denied: Unable to access target path "${target}". ` +
                    PERMISSION_HINT
            );
        } else if (error.message.includes('Target path already exists')) {
            // Re-throw our custom error
            throw error;
        } else {
            // Re-throw other unexpected errors
            throw new Error(
                `Failed to check target path "${target}": ${error.message}`
            );
        }
    }

    // Create directory structure with symlinked files
    await createSymlinkDirectory(source, target);
}

/**
 * Recursively creates a directory structure with symlinked files.
 * Creates real directories but symlinks individual files.
 *
 * @param {string} source - Source directory path
 * @param {string} target - Target directory path
 * @returns {Promise<void>}
 */
async function createSymlinkDirectory(source, target) {
    // Get source directory stats to preserve permissions
    const sourceStats = await fs.stat(source);

    // Create target directory with same permissions as source
    try {
        // Permission bits only: setuid, setgid and sticky bits are not copied.
        await fs.mkdir(target, { mode: sourceStats.mode & 0o777 });
    } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(
                `Permission denied: Unable to create directory "${target}". ` +
                    PERMISSION_HINT
            );
        }
        throw new Error(
            `Failed to create directory "${target}": ${error.message}`
        );
    }

    // Read directory contents
    const entries = await fs.readdir(source, { withFileTypes: true });

    // Process each entry
    for (const entry of entries) {
        const sourcePath = `${source}/${entry.name}`;
        const targetPath = `${target}/${entry.name}`;

        if (entry.isDirectory()) {
            // Recursively create subdirectory structure
            await createSymlinkDirectory(sourcePath, targetPath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            // Symlink individual files
            await createFileSymlink(sourcePath, targetPath);
        }
        // Skip other types (sockets, devices, etc.)
    }
}

/**
 * Creates a symbolic link for a single file.
 *
 * @param {string} source - Source file path
 * @param {string} target - Target symlink path
 * @returns {Promise<void>}
 */
async function createFileSymlink(source, target) {
    try {
        await fs.symlink(source, target, 'file');
    } catch (error) {
        // Handle Windows symlink permission issues
        if (error.code === 'EPERM' && process.platform === 'win32') {
            throw new Error(
                `Symlink creation failed due to insufficient permissions. ` +
                    `On Windows, you need to either:\n` +
                    `  1. Enable Developer Mode in Windows Settings > Update & Security > For developers\n` +
                    `  2. Install with --method copy instead, which needs no symlinks\n` +
                    `Original error: ${error.message}`
            );
        }

        // Handle other permission errors
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(
                `Permission denied: Unable to create symlink at "${target}". ` +
                    PERMISSION_HINT
            );
        }

        // Re-throw other errors with context
        throw new Error(
            `Failed to create symlink from "${source}" to "${target}": ${error.message}`
        );
    }
}

/**
 * Copies a skill directory from source to target recursively.
 * Preserves file permissions during copy.
 *
 * Symlinks inside the skill are followed only when their real path stays inside
 * `allowedRoot` (the LaunchBridge source tree), so linked content such as
 * evaluate-predictions' lib/metric-library is copied while a link to anywhere
 * else is skipped and reported through `onSkip`. Without `allowedRoot`, no link
 * is followed. A directory already copied, by real path, is not entered again.
 *
 * @param {string} source - Source path (the skill directory to copy from)
 * @param {string} target - Target path (where the skill will be copied to)
 * @param {{ allowedRoot?: string, onSkip?: (src: string, resolved: string) => void }} [options]
 *     `allowedRoot` must be a real (symlink-resolved) path.
 * @returns {Promise<void>}
 * @throws {Error} If target already exists or copy operation fails
 *
 * Requirements: 3.3, 7.3, 7.4
 */
export async function copySkill(source, target, options = {}) {
    // Check if target already exists
    try {
        await fs.lstat(target);
        // If we get here, target exists (file, directory, or symlink)
        throw new Error(
            `Target path already exists: "${target}". ` +
                `Please remove the existing file/directory or use the conflict resolution prompt.`
        );
    } catch (error) {
        // ENOENT means target doesn't exist, which is what we want
        if (error.code === 'ENOENT') {
            // Target doesn't exist, proceed with copy
        } else if (error.code === 'EACCES' || error.code === 'EPERM') {
            // Permission denied when checking target
            throw new Error(
                `Permission denied: Unable to access target path "${target}". ` +
                    PERMISSION_HINT
            );
        } else if (error.message.includes('Target path already exists')) {
            // Re-throw our custom error
            throw error;
        } else {
            // Re-throw other unexpected errors
            throw new Error(
                `Failed to check target path "${target}": ${error.message}`
            );
        }
    }

    // Verify source exists and is a directory
    try {
        const sourceStats = await fs.stat(source);
        if (!sourceStats.isDirectory()) {
            throw new Error(
                `Source path is not a directory: "${source}". ` +
                    `copySkill expects a directory as the source.`
            );
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Source path does not exist: "${source}".`);
        }
        if (error.message.includes('Source path')) {
            throw error;
        }
        throw new Error(
            `Failed to access source path "${source}": ${error.message}`
        );
    }

    // Recursively copy the directory
    await copyDirectoryRecursive(source, target, {
        allowedRoot: options.allowedRoot,
        onSkip: options.onSkip,
        visited: new Set(),
    });
}

/**
 * Recursively copies a directory and its contents.
 * Preserves file permissions.
 *
 * @param {string} source - Source directory path
 * @param {string} target - Target directory path
 * @param {{ allowedRoot?: string, onSkip?: Function, visited: Set<string> }} ctx
 * @returns {Promise<void>}
 */
async function copyDirectoryRecursive(source, target, ctx) {
    const realSource = await fs.realpath(source);
    if (ctx.visited.has(realSource)) {
        return;
    }
    ctx.visited.add(realSource);

    // Get source directory stats to preserve permissions
    const sourceStats = await fs.stat(source);

    // Create target directory with same permissions as source
    try {
        // Permission bits only: setuid, setgid and sticky bits are not copied.
        await fs.mkdir(target, { mode: sourceStats.mode & 0o777 });
    } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(
                `Permission denied: Unable to create directory "${target}". ` +
                    PERMISSION_HINT
            );
        }
        throw new Error(
            `Failed to create directory "${target}": ${error.message}`
        );
    }

    // Read directory contents
    const entries = await fs.readdir(source, { withFileTypes: true });

    // Process each entry
    for (const entry of entries) {
        const sourcePath = `${source}/${entry.name}`;
        const targetPath = `${target}/${entry.name}`;

        if (entry.isDirectory()) {
            // Recursively copy subdirectory
            await copyDirectoryRecursive(sourcePath, targetPath, ctx);
        } else if (entry.isFile()) {
            // Copy file with preserved permissions
            await copyFileWithPermissions(sourcePath, targetPath);
        } else if (entry.isSymbolicLink()) {
            // Copy what the link points to, if it stays inside allowedRoot
            await copySymlink(sourcePath, targetPath, ctx);
        }
        // Skip other types (sockets, devices, etc.)
    }
}

/**
 * Copies a file while preserving its permissions.
 *
 * @param {string} source - Source file path
 * @param {string} target - Target file path
 * @returns {Promise<void>}
 */
async function copyFileWithPermissions(source, target) {
    try {
        // Get source file stats for permissions
        const sourceStats = await fs.stat(source);

        // Copy file content
        await fs.copyFile(source, target);

        // Preserve the permission bits only, without setuid/setgid/sticky
        await fs.chmod(target, sourceStats.mode & 0o777);
    } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(
                `Permission denied: Unable to copy file "${source}" to "${target}". ` +
                    PERMISSION_HINT
            );
        }
        throw new Error(
            `Failed to copy file "${source}" to "${target}": ${error.message}`
        );
    }
}

/**
 * Copies a symbolic link by resolving it and copying the target contents.
 * In copy mode the installation must be self-contained, so relative symlinks
 * (which would break at the destination) are resolved and their targets are
 * copied as real files/directories instead.
 *
 * Links whose real path is outside `ctx.allowedRoot` are not copied.
 *
 * @param {string} source - Source symlink path
 * @param {string} target - Target path (will be a real file or directory, not a symlink)
 * @param {{ allowedRoot?: string, onSkip?: Function, visited: Set<string> }} ctx
 * @returns {Promise<void>}
 */
async function copySymlink(source, target, ctx) {
    try {
        // Resolve the symlink to its real path
        const realPath = await fs.realpath(source);
        if (!ctx.allowedRoot || !isPathWithin(realPath, ctx.allowedRoot)) {
            ctx.onSkip?.(source, realPath);
            return;
        }
        const realStats = await fs.stat(realPath);

        if (realStats.isDirectory()) {
            await copyDirectoryRecursive(realPath, target, ctx);
        } else {
            await copyFileWithPermissions(realPath, target);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(
                `Broken symlink: "${source}" points to a target that does not exist. ` +
                    `Verify the symlink target is valid before copying.`
            );
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(
                `Permission denied: Unable to resolve or copy symlink "${source}" to "${target}". ` +
                    PERMISSION_HINT
            );
        }
        throw new Error(
            `Failed to copy symlink "${source}" to "${target}": ${error.message}`
        );
    }
}

/**
 * Ensures a target directory exists, creating it recursively if needed.
 * Handles permission errors gracefully with descriptive error messages.
 * This function is idempotent - calling it multiple times is safe.
 *
 * @param {string} targetPath - Path to the directory to ensure exists
 * @returns {Promise<void>}
 * @throws {Error} If directory creation fails due to permissions or other errors
 *
 * Requirements: 7.1, 9.2
 */
export async function ensureTargetDirectory(targetPath) {
    try {
        // Create directory recursively if it doesn't exist
        // recursive: true makes this idempotent - no error if directory already exists
        await fs.mkdir(targetPath, { recursive: true });
    } catch (error) {
        // Handle permission errors with descriptive messages
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(
                `Permission denied: Unable to create directory "${targetPath}". ` +
                    PERMISSION_HINT
            );
        }

        // Handle read-only file system
        if (error.code === 'EROFS') {
            throw new Error(
                `Read-only file system: Unable to create directory "${targetPath}". ` +
                    `The target location is on a read-only file system.`
            );
        }

        // Handle path too long
        if (error.code === 'ENAMETOOLONG') {
            throw new Error(
                `Path too long: Unable to create directory "${targetPath}". ` +
                    `The path exceeds the maximum allowed length.`
            );
        }

        // Handle invalid path characters (Windows)
        if (error.code === 'EINVAL') {
            throw new Error(
                `Invalid path: Unable to create directory "${targetPath}". ` +
                    `The path contains invalid characters.`
            );
        }

        // Re-throw other errors with context
        throw new Error(
            `Failed to create directory "${targetPath}": ${error.message}`
        );
    }
}

/**
 * Lists skill directories that are no longer selected and that the previous
 * install recorded. A directory LaunchBridge did not install is never returned,
 * so it is never offered for removal.
 *
 * @param {string[]} existingDirs - Entry names found in the agent skills directory
 * @param {Iterable<string>} selectedSkills - Skills selected for this install
 * @param {Set<string>} previouslyInstalled - Skill names the previous manifest recorded
 * @returns {string[]}
 */
export function findOrphanSkills(
    existingDirs,
    selectedSkills,
    previouslyInstalled
) {
    const selected = new Set(selectedSkills);
    return existingDirs.filter(
        (name) => !selected.has(name) && previouslyInstalled.has(name)
    );
}
