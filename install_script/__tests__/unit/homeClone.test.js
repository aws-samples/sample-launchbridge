// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
    HOME_REPO_URL,
    ensureHome,
    homePath,
    normalizeRemoteUrl,
    prepareHome,
} from '../../lib/homeClone.js';
import { NPM_CI_ARGS } from '../../lib/npmRunner.js';

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('homePath', () => {
    it('is ~/.launchbridge', () => {
        expect(homePath()).toBe(path.join(os.homedir(), '.launchbridge'));
    });
});

describe('normalizeRemoteUrl', () => {
    it('ignores case of the host, a trailing slash and .git', () => {
        expect(
            normalizeRemoteUrl(
                'https://GitHub.com/aws-samples/sample-launchbridge/'
            )
        ).toBe(normalizeRemoteUrl(HOME_REPO_URL));
    });

    it('keeps different repositories different', () => {
        expect(
            normalizeRemoteUrl('https://github.com/someone/sample-launchbridge')
        ).not.toBe(normalizeRemoteUrl(HOME_REPO_URL));
    });
});

describe('prepareHome', () => {
    let home;
    let calls;
    const npm =
        (code = 0, stderr = '') =>
        async (args, cwd) => {
            calls.push({ args: [...args], cwd });
            return { code, stdout: '', stderr };
        };

    beforeEach(() => {
        calls = [];
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-prepare-'));
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('runs npm ci in a clone without node_modules', async () => {
        expect(await prepareHome(home, { npm: npm() })).toEqual({
            installed: true,
        });
        expect(calls).toEqual([{ args: [...NPM_CI_ARGS], cwd: home }]);
    });

    it('leaves a clone that already has node_modules alone', async () => {
        fs.mkdirSync(path.join(home, 'node_modules'));
        expect(await prepareHome(home, { npm: npm() })).toEqual({
            installed: false,
        });
        expect(calls).toEqual([]);
    });

    it('fails when npm ci fails', async () => {
        await expect(
            prepareHome(home, { npm: npm(1, 'npm error code E404\n') })
        ).rejects.toThrow(/npm ci failed.*E404/);
    });
});

describe.skipIf(!hasGit)('ensureHome', () => {
    let root;
    let remote;
    let home;

    beforeEach(() => {
        root = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-'))
        );
        remote = path.join(root, 'remote.git');
        git(root, 'init', '-q', '--bare', '-b', 'main', remote);
        const seed = path.join(root, 'seed');
        git(root, 'clone', '-q', remote, seed);
        git(seed, 'config', 'user.email', 'test@example.com');
        git(seed, 'config', 'user.name', 'Test');
        git(seed, 'config', 'commit.gpgsign', 'false');
        git(seed, 'checkout', '-q', '-b', 'main');
        fs.mkdirSync(path.join(seed, 'skills', 'demo'), { recursive: true });
        fs.writeFileSync(path.join(seed, 'skills', 'demo', 'SKILL.md'), 'v1\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', 'initial');
        git(seed, 'push', '-q', 'origin', 'main');
        home = path.join(root, 'home', '.launchbridge');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('clones main into a missing home and leaves no temporary folder', async () => {
        expect(await ensureHome(home, { url: remote })).toEqual({
            created: true,
        });
        expect(
            fs.readFileSync(path.join(home, 'skills/demo/SKILL.md'), 'utf-8')
        ).toBe('v1\n');
        expect(git(home, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
        expect(fs.readdirSync(path.dirname(home))).toEqual(['.launchbridge']);
    });

    it('reuses an existing clone', async () => {
        await ensureHome(home, { url: remote });
        expect(await ensureHome(home, { url: remote })).toEqual({
            created: false,
        });
    });

    it('refuses a folder that is not a git clone, and leaves it alone', async () => {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'notes.txt'), 'mine\n');
        await expect(ensureHome(home, { url: remote })).rejects.toThrow(
            /not a git clone/
        );
        expect(fs.readFileSync(path.join(home, 'notes.txt'), 'utf-8')).toBe(
            'mine\n'
        );
    });

    it('refuses a clone of another repository', async () => {
        await ensureHome(home, { url: remote });
        git(
            home,
            'remote',
            'set-url',
            'origin',
            'https://example.com/other.git'
        );
        await expect(ensureHome(home, { url: remote })).rejects.toThrow(
            /other\.git/
        );
    });

    it('accepts a clone whose URL the user rewrites with insteadOf', async () => {
        await ensureHome(home, { url: remote });
        git(home, 'config', 'url.ssh://git@example.com/x.insteadOf', remote);
        expect(git(home, 'remote', 'get-url', 'origin')).toBe(
            'ssh://git@example.com/x'
        );
        expect(await ensureHome(home, { url: remote })).toEqual({
            created: false,
        });
    });

    it('cleans up and fails when the clone fails', async () => {
        await expect(
            ensureHome(home, { url: path.join(root, 'missing.git') })
        ).rejects.toThrow(/git clone failed/);
        expect(fs.readdirSync(path.dirname(home))).toEqual([]);
    });
});
