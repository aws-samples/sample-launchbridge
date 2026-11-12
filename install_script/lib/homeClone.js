// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Home Clone Module
 *
 * When the installer runs from a packaged copy (for example
 * `npx github:aws-samples/sample-launchbridge`), it sets up one permanent clone
 * of LaunchBridge per machine and hands over to it, so target repositories can
 * symlink to a copy that `launchbridge update` keeps current.
 *
 * The clone lives at `$LAUNCHBRIDGE_HOME` (absolute) or `~/.launchbridge`, and
 * holds the git working tree and its node_modules only. Per-machine state stays
 * in `~/.config/launchbridge/` (stateDir.js). An existing folder is used only
 * when it is a clean clone of the expected repository on `main`; anything else
 * is reported and left untouched.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { NPM_CI_ARGS, runNpm } from './npmRunner.js';

/** The repository the home clone tracks. Not configurable on purpose. */
export const HOME_REPO_URL =
    'https://github.com/aws-samples/sample-launchbridge.git';

/** The branch the home clone tracks; it only ever holds released code. */
export const HOME_BRANCH = 'main';

/** Set in the hand-over child so a clone never bootstraps again. */
export const HANDOVER_ENV = 'LAUNCHBRIDGE_HANDOVER';

/** Arguments for `npm link` in the home clone. */
export const NPM_LINK_ARGS = Object.freeze([
    'link',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
]);

// Variables that would point git at some other repository than the one in cwd
// (for example when npx runs inside a git hook). Git's own config variables,
// such as GIT_CONFIG_COUNT, are kept.
const REPO_SELECTING_GIT_VARS = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
];

function gitEnv() {
    const env = { ...process.env };
    for (const name of REPO_SELECTING_GIT_VARS) {
        delete env[name];
    }
    // Never stop for a credential prompt: the repository is public.
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
}

/**
 * Runs git with an argument list (no shell).
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runGit(args, cwd) {
    return new Promise((resolve) => {
        // nosemgrep: detect-child-process
        const proc = spawn('git', args, {
            cwd,
            env: gitEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => {
            stdout += d.toString();
        });
        proc.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        proc.on('close', (code) =>
            resolve({ code: code ?? 1, stdout, stderr })
        );
        proc.on('error', (err) =>
            resolve({ code: 1, stdout: '', stderr: err.message })
        );
    });
}

/**
 * Whether git can be run at all.
 *
 * @param {typeof runGit} [git]
 * @returns {Promise<boolean>}
 */
export async function gitAvailable(git = runGit) {
    const result = await git(['--version'], os.tmpdir());
    return result.code === 0;
}

/**
 * The home clone's location.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homedir]
 * @returns {string}
 * @throws {Error} When LAUNCHBRIDGE_HOME is set but not absolute
 */
export function resolveHome(env = process.env, homedir = os.homedir()) {
    const configured = env.LAUNCHBRIDGE_HOME;
    if (configured) {
        if (!path.isAbsolute(configured)) {
            throw new Error(
                `LAUNCHBRIDGE_HOME must be an absolute path, not '${configured}'.`
            );
        }
        return path.resolve(configured);
    }
    return path.join(homedir, '.launchbridge');
}

/**
 * Normalizes a git remote URL for comparison: lower-case host, no trailing
 * slash or `.git`.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeRemoteUrl(url) {
    let u = url
        .trim()
        .replace(/\/+$/, '')
        .replace(/\.git$/, '');
    const m = u.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
    if (m) {
        u = `${m[1].toLowerCase()}${m[2].toLowerCase()}${m[3] || ''}`;
    }
    return u;
}

/**
 * Describes the home folder.
 *
 * @param {string} home
 * @param {{ git?: typeof runGit, expectedUrl?: string }} [options]
 * @returns {Promise<{ state: 'missing' } | { state: 'empty' } | { state: 'ready' } | { state: 'unusable', reason: string }>}
 */
export async function inspectHome(
    home,
    { git = runGit, expectedUrl = HOME_REPO_URL } = {}
) {
    let stat;
    try {
        stat = await fs.stat(home);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { state: 'missing' };
        }
        return { state: 'unusable', reason: `it can't be read (${err.code}).` };
    }
    if (!stat.isDirectory()) {
        return { state: 'unusable', reason: 'it is not a folder.' };
    }
    const entries = await fs.readdir(home);
    if (entries.length === 0) {
        return { state: 'empty' };
    }
    if (!entries.includes('.git')) {
        return {
            state: 'unusable',
            reason: 'it is not a git clone of LaunchBridge.',
        };
    }

    const top = await git(['rev-parse', '--show-toplevel'], home);
    if (
        top.code !== 0 ||
        path.resolve(top.stdout.trim()) !== (await fs.realpath(home))
    ) {
        return {
            state: 'unusable',
            reason: 'it is not the top of a git clone.',
        };
    }

    const origin = await git(['remote', 'get-url', 'origin'], home);
    if (origin.code !== 0) {
        return { state: 'unusable', reason: "it has no 'origin' remote." };
    }
    if (normalizeRemoteUrl(origin.stdout) !== normalizeRemoteUrl(expectedUrl)) {
        return {
            state: 'unusable',
            reason: `its 'origin' is ${origin.stdout.trim()}, not ${expectedUrl}.`,
        };
    }

    const branch = await git(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        home
    );
    if (branch.code !== 0 || branch.stdout.trim() !== HOME_BRANCH) {
        return {
            state: 'unusable',
            reason: `it is not on the '${HOME_BRANCH}' branch.`,
        };
    }

    const status = await git(['status', '--porcelain'], home);
    if (status.code !== 0) {
        return {
            state: 'unusable',
            reason: `git status failed: ${status.stderr.trim()}`,
        };
    }
    if (status.stdout.trim()) {
        return {
            state: 'unusable',
            reason: 'it has local changes (see git status in that folder).',
        };
    }
    return { state: 'ready' };
}

/**
 * Clones the repository into `home`: into a temporary sibling first, then
 * renamed into place, so an interrupted clone never leaves a half-made home.
 *
 * @param {string} home
 * @param {{ git?: typeof runGit, url?: string }} [options]
 * @returns {Promise<void>}
 */
export async function cloneHome(
    home,
    { git = runGit, url = HOME_REPO_URL } = {}
) {
    const parent = path.dirname(home);
    await fs.mkdir(parent, { recursive: true });
    const temp = path.join(
        parent,
        `${path.basename(home)}.tmp-${crypto.randomBytes(4).toString('hex')}`
    );
    const clone = await git(
        [
            'clone',
            '--quiet',
            '--recurse-submodules',
            '--branch',
            HOME_BRANCH,
            url,
            temp,
        ],
        parent
    );
    if (clone.code !== 0) {
        await fs.rm(temp, { recursive: true, force: true });
        throw new Error(`git clone failed: ${clone.stderr.trim()}`);
    }

    try {
        await fs.rmdir(home); // an empty placeholder folder, if there is one
    } catch {
        // missing, or not empty: the rename below decides
    }
    try {
        await fs.rename(temp, home);
    } catch (err) {
        await fs.rm(temp, { recursive: true, force: true });
        if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
            // Another run created it meanwhile; the caller re-inspects it.
            return;
        }
        throw err;
    }
}

/**
 * Makes `home` a ready clone: clones it when missing or empty, refuses when it
 * is something else.
 *
 * @param {string} home
 * @param {{ git?: typeof runGit, url?: string }} [options]
 * @returns {Promise<{ created: boolean }>}
 * @throws {Error} When the folder exists but can't be used
 */
export async function ensureHome(
    home,
    { git = runGit, url = HOME_REPO_URL } = {}
) {
    const before = await inspectHome(home, { git, expectedUrl: url });
    if (before.state === 'ready') {
        return { created: false };
    }
    if (before.state === 'unusable') {
        throw new Error(
            `${home} can't be used as the LaunchBridge home: ${before.reason}\n` +
                'Move or fix that folder, or set LAUNCHBRIDGE_HOME to another absolute path.'
        );
    }
    await cloneHome(home, { git, url });
    const after = await inspectHome(home, { git, expectedUrl: url });
    if (after.state !== 'ready') {
        throw new Error(
            `${home} was not usable after cloning: ${after.reason || after.state}`
        );
    }
    return { created: true };
}

/**
 * Installs the CLI's npm packages in the home clone and links the
 * `launchbridge` command. A failed link is not fatal: the caller prints how to
 * run the CLI without it.
 *
 * @param {string} home
 * @param {{ npm?: typeof runNpm }} [options]
 * @returns {Promise<{ linked: boolean, linkError?: string }>}
 * @throws {Error} When `npm ci` fails
 */
export async function prepareHome(home, { npm = runNpm } = {}) {
    const install = await npm(NPM_CI_ARGS, home);
    if (install.code !== 0) {
        throw new Error(
            `npm ci failed in ${home}: ${lastLines(install.stderr)}`
        );
    }
    const link = await npm(NPM_LINK_ARGS, home);
    if (link.code !== 0) {
        return { linked: false, linkError: lastLines(link.stderr) };
    }
    return { linked: true };
}

function lastLines(text) {
    return text.trim().split('\n').slice(-3).join(' ') || 'unknown error';
}

/**
 * Runs the home clone's installer with the same arguments, working directory
 * and terminal, and resolves with its exit code.
 *
 * @param {string} home
 * @param {string[]} args - Arguments after the script path
 * @returns {Promise<number>}
 */
export function handOver(home, args) {
    return new Promise((resolve) => {
        const entry = path.join(home, 'install_script', 'index.js');
        // nosemgrep: detect-child-process
        const proc = spawn(process.execPath, [entry, ...args], {
            stdio: 'inherit',
            env: { ...process.env, [HANDOVER_ENV]: '1' },
        });
        proc.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
        proc.on('error', () => resolve(1));
    });
}
