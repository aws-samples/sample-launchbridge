// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Home Clone Module
 *
 * When `launchbridge` runs from an npm package (`npm install -g
 * github:aws-samples/sample-launchbridge`, or npx) instead of a clone, it uses
 * one permanent clone of LaunchBridge in `~/.launchbridge`: cloned on the first
 * run, then handed over to on every run. Target repositories symlink to that
 * clone, and `launchbridge update` (which runs inside it) keeps it current, so
 * one update reaches every repository.
 *
 * The clone holds the git working tree and its node_modules only; per-machine
 * state stays in `~/.config/launchbridge/` (stateDir.js). An existing
 * `~/.launchbridge` is used only when it is a clone of this repository;
 * anything else is reported and left untouched.
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

// Variables that would point git at some other repository than the one in cwd
// (for example when launchbridge runs inside a git hook). Git's own config
// variables, such as GIT_CONFIG_COUNT, are kept.
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

/** The home clone's location: `~/.launchbridge`. */
export function homePath() {
    return path.join(os.homedir(), '.launchbridge');
}

/**
 * Normalizes a git remote URL for comparison: lower-case scheme and host, no
 * trailing slash or `.git`.
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

async function exists(p) {
    try {
        await fs.lstat(p);
        return true;
    } catch {
        return false;
    }
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
    if ((await git(['--version'], os.tmpdir())).code !== 0) {
        throw new Error(
            'LaunchBridge needs git to set up ~/.launchbridge. Install git and run launchbridge again.'
        );
    }
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
        await fs.rename(temp, home);
    } catch (err) {
        await fs.rm(temp, { recursive: true, force: true });
        throw err;
    }
}

/**
 * Makes sure `home` is a clone of this repository, cloning it when missing.
 *
 * @param {string} home
 * @param {{ git?: typeof runGit, url?: string }} [options]
 * @returns {Promise<{ created: boolean }>}
 * @throws {Error} When the folder exists but is not a clone of this repository
 */
export async function ensureHome(
    home,
    { git = runGit, url = HOME_REPO_URL } = {}
) {
    if (!(await exists(home))) {
        await cloneHome(home, { git, url });
        return { created: true };
    }

    const refuse = (reason) =>
        new Error(
            `${home} can't be used for LaunchBridge: ${reason}\n` +
                'Move or remove that folder, then run launchbridge again.'
        );
    if (!(await exists(path.join(home, '.git')))) {
        throw refuse('it is not a git clone of LaunchBridge.');
    }
    // The stored URL, not `git remote get-url`: that applies the user's
    // url.<base>.insteadOf rewrites (for example HTTPS to SSH), which would
    // make a correct clone look like one of another repository.
    const origin = await git(['config', '--get', 'remote.origin.url'], home);
    if (origin.code !== 0) {
        throw refuse("it has no 'origin' remote.");
    }
    if (normalizeRemoteUrl(origin.stdout) !== normalizeRemoteUrl(url)) {
        throw refuse(`it is a clone of ${origin.stdout.trim()}, not ${url}.`);
    }
    return { created: false };
}

/**
 * Installs the CLI's npm packages in the home clone when it has none yet (the
 * first run). Later changes are installed by `launchbridge update`.
 *
 * @param {string} home
 * @param {{ npm?: typeof runNpm }} [options]
 * @returns {Promise<{ installed: boolean }>}
 * @throws {Error} When `npm ci` fails
 */
export async function prepareHome(home, { npm = runNpm } = {}) {
    if (await exists(path.join(home, 'node_modules'))) {
        return { installed: false };
    }
    const install = await npm(NPM_CI_ARGS, home);
    if (install.code !== 0) {
        const detail =
            install.stderr.trim().split('\n').slice(-3).join(' ') ||
            'unknown error';
        throw new Error(`npm ci failed in ${home}: ${detail}`);
    }
    return { installed: true };
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
