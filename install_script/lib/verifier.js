// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Verification Module
 *
 * Verifies installation success.
 */

import fs from 'node:fs';

/**
 * @typedef {Object} VerificationResult
 * @property {string} skillName - Name of the skill
 * @property {import('./promptManager.js').Agent} agent - Target agent
 * @property {boolean} verified - Whether verification passed
 * @property {string} [error] - Error message if failed
 */

/**
 * Verifies an installation result.
 * @param {import('./installer.js').InstallationResult} result - Installation result
 * @param {import('./promptManager.js').Method} method - Installation method used
 * @returns {VerificationResult}
 */
export function verifyInstallation(result, method) {
    // If installation already failed, return verified=false with the original error
    if (!result.success) {
        return {
            skillName: result.skillName,
            agent: result.agent,
            verified: false,
            error: result.error || 'Installation failed',
        };
    }

    // Delegate to appropriate verification method based on installation method
    let verified = false;
    let error;

    if (method === 'symlink') {
        verified = verifySymlink(result.targetPath);
        if (!verified) {
            error = `Symlink verification failed for ${result.targetPath}`;
        }
    } else if (method === 'copy') {
        verified = verifySkillFiles(result.targetPath);
        if (!verified) {
            error = `Skill files verification failed for ${result.targetPath}`;
        }
    } else {
        error = `Unknown installation method: ${method}`;
    }

    return {
        skillName: result.skillName,
        agent: result.agent,
        verified,
        ...(error && { error }),
    };
}

/**
 * Verifies that a symlink installation is valid.
 * With the new approach, we create real directories with symlinked files inside.
 * @param {string} skillPath - Path to the skill directory
 * @returns {boolean}
 */
export function verifySymlink(skillPath) {
    try {
        // 1. Check that the path exists and is a directory
        const stats = fs.lstatSync(skillPath);
        if (!stats.isDirectory()) {
            return false;
        }

        // 2. Verify that SKILL.md exists and is a symlink
        const skillMdPath = `${skillPath}/SKILL.md`;
        if (!fs.existsSync(skillMdPath)) {
            return false;
        }

        const skillMdStats = fs.lstatSync(skillMdPath);
        if (!skillMdStats.isSymbolicLink()) {
            return false;
        }

        // 3. Verify the symlink target is accessible (file exists and readable)
        fs.statSync(skillMdPath);
        fs.accessSync(skillMdPath, fs.constants.R_OK);

        return true;
    } catch (error) {
        // Handle errors gracefully - return false on any error
        return false;
    }
}

/**
 * Verifies that skill files exist.
 * Checks that the path is a directory and contains a readable SKILL.md file.
 * @param {string} skillPath - Path to the skill directory
 * @returns {boolean}
 */
export function verifySkillFiles(skillPath) {
    try {
        // 1. Check that the path exists and is a directory
        if (!skillPath) {
            return false;
        }

        const stats = fs.statSync(skillPath);
        if (!stats.isDirectory()) {
            return false;
        }

        // 2. Verify that SKILL.md file exists within the directory
        const skillMdPath = `${skillPath}/SKILL.md`;

        // Check if SKILL.md exists
        if (!fs.existsSync(skillMdPath)) {
            return false;
        }

        // 3. Check that SKILL.md is readable (not empty or corrupted)
        const skillMdStats = fs.statSync(skillMdPath);
        if (!skillMdStats.isFile()) {
            return false;
        }

        // Verify file is readable by attempting to read it
        // Also check it's not empty (size > 0)
        if (skillMdStats.size === 0) {
            return false;
        }

        // Try to read the file to ensure it's accessible
        fs.accessSync(skillMdPath, fs.constants.R_OK);

        // 4. All checks passed
        return true;
    } catch (error) {
        // 5. Handle errors gracefully - return false on any error
        return false;
    }
}
