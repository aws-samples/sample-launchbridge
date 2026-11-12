// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Delivery Detector Module
 *
 * Detects the delivery method (git_repo vs bundled) by checking for
 * the presence of a .git/ directory in the LaunchBridge source path.
 * Also provides utilities for reading the git commit hash and release version.
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { safePathJoin } from './pathSanitizer.js';

/**
 * @typedef {'git_repo' | 'bundled'} DeliveryMethod
 */

/**
 * Detects the delivery method by checking for git repository markers.
 * The source is `git_repo` when `.git` is a directory (a normal clone) or a
 * `gitdir:` file (a git worktree, or LaunchBridge checked out as a submodule).
 * Otherwise, for example the package `npm install -g` installs, it is `bundled`.
 *
 * @param {string} sourcePath - Path to the LaunchBridge source
 * @returns {Promise<DeliveryMethod>}
 */
export async function detectDeliveryMethod(sourcePath) {
    const gitPath = safePathJoin(sourcePath, '.git');
    try {
        const stat = await fs.stat(gitPath);
        if (stat.isDirectory()) {
            return 'git_repo';
        }
        if (stat.isFile()) {
            const content = await fs.readFile(gitPath, 'utf-8');
            if (content.startsWith('gitdir:')) {
                return 'git_repo';
            }
        }
        return 'bundled';
    } catch {
        return 'bundled';
    }
}

/**
 * Gets the current git commit hash (short form) if in a git repo.
 * Spawns `git rev-parse --short HEAD` in the source directory.
 *
 * @param {string} sourcePath - Path to the LaunchBridge source
 * @returns {Promise<string | null>} Commit hash or null if not a git repo or command fails
 */
export async function getGitCommitHash(sourcePath) {
    return new Promise((resolve) => {
        // A fixed argument list with no shell, run in LaunchBridge's own clone.
        // nosemgrep: detect-child-process
        const proc = spawn('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: sourcePath,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                resolve(stdout.trim());
            } else {
                resolve(null);
            }
        });

        proc.on('error', () => {
            resolve(null);
        });
    });
}

/**
 * Reads the release version from version.txt in the source root.
 * Parses the first non-whitespace token on the first line as the version number.
 *
 * @param {string} sourcePath - Path to the LaunchBridge source
 * @returns {Promise<string>} Version string (e.g., "1.1.0")
 */
export async function readReleaseVersion(sourcePath) {
    const versionFile = safePathJoin(sourcePath, 'version.txt');
    const content = await fs.readFile(versionFile, 'utf8');
    const firstLine = content.split('\n')[0] || '';
    const version = firstLine.trim().split(/\s+/)[0] || '';
    return version;
}
