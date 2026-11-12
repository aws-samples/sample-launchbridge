// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * npm Runner Module
 *
 * Runs npm in LaunchBridge's own clone: `npm ci` on the first run of an npm
 * install (in ~/.launchbridge) and after an update changes the CLI's packages.
 * Arguments are fixed lists built by LaunchBridge, never user input.
 */

import { spawn } from 'child_process';

/** Arguments for a lockfile install that runs no package scripts. */
export const NPM_CI_ARGS = Object.freeze([
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
]);

/** Paths whose change means the clone's node_modules must be reinstalled. */
export const NPM_MANIFEST_PATHS = Object.freeze([
    'package.json',
    'package-lock.json',
]);

/**
 * Runs npm with the given arguments in `cwd`.
 *
 * On Windows npm is `npm.cmd`, which Node can only start through a shell; the
 * arguments are fixed by the callers in this package, so no user input reaches
 * that shell.
 *
 * @param {readonly string[]} args - npm arguments
 * @param {string} cwd - Working directory
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runNpm(args, cwd) {
    return new Promise((resolve) => {
        const windows = process.platform === 'win32';
        // nosemgrep: detect-child-process
        const proc = spawn(windows ? 'npm.cmd' : 'npm', [...args], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: windows,
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.on('close', (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });
        proc.on('error', (err) => {
            resolve({ code: 1, stdout: '', stderr: err.message });
        });
    });
}

/**
 * Whether an update touching `changedPaths` needs `npm ci` in the clone.
 *
 * @param {string[]} changedPaths - Repo-relative paths
 * @returns {boolean}
 */
export function needsNpmInstall(changedPaths) {
    return changedPaths.some((p) => NPM_MANIFEST_PATHS.includes(p));
}
