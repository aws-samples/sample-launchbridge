// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
    HOME_REPO_URL,
    NPM_LINK_ARGS,
    ensureHome,
    inspectHome,
    normalizeRemoteUrl,
    prepareHome,
    resolveHome,
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

describe('resolveHome', () => {
    it('defaults to ~/.launchbridge', () => {
        expect(resolveHome({}, '/home/u')).toBe(
            path.join('/home/u', '.launchbridge')
        );
    });

    it('uses an absolute LAUNCHBRIDGE_HOME', () => {
        const dir = path.resolve('/opt/lb');
        expect(resolveHome({ LAUNCHBRIDGE_HOME: dir }, '/home/u')).toBe(dir);
    });

    it('rejects a relative LAUNCHBRIDGE_HOME', () => {
        expect(() =>
            resolveHome({ LAUNCHBRIDGE_HOME: 'lb' }, '/home/u')
        ).toThrow(/absolute/);
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
    it('runs npm ci, then npm link, in the home clone', async () => {
        const calls = [];
        const npm = async (args, cwd) => {
            calls.push({ args: [...args], cwd });
            return { code: 0, stdout: '', stderr: '' };
        };
        expect(await prepareHome('/h', { npm })).toEqual({ linked: true });
        expect(calls).toEqual([
            { args: [...NPM_CI_ARGS], cwd: '/h' },
            { args: [...NPM_LINK_ARGS], cwd: '/h' },
        ]);
    });

    it('fails when npm ci fails', async () => {
        const npm = async () => ({ code: 1, stdout: '', stderr: 'E404\n' });
        await expect(prepareHome('/h', { npm })).rejects.toThrow(
            /npm ci failed.*E404/
        );
    });

    it('reports, without failing, when npm link fails', async () => {
        const npm = async (args) =>
            args[0] === 'link'
                ? { code: 1, stdout: '', stderr: 'EACCES: permission denied\n' }
                : { code: 0, stdout: '', stderr: '' };
        const result = await prepareHome('/h', { npm });
        expect(result.linked).toBe(false);
        expect(result.linkError).toContain('EACCES');
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
        fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', 'initial');
        git(seed, 'push', '-q', 'origin', 'main');
        home = path.join(root, 'home', '.launchbridge');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('clones into a missing home and leaves no temporary folder', async () => {
        expect(await ensureHome(home, { url: remote })).toEqual({
            created: true,
        });
        expect(
            fs.readFileSync(path.join(home, 'skills/demo/SKILL.md'), 'utf-8')
        ).toBe('v1\n');
        expect(git(home, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
        expect(fs.readdirSync(path.dirname(home))).toEqual(['.launchbridge']);
    });

    it('clones into an empty home folder', async () => {
        fs.mkdirSync(home, { recursive: true });
        expect(await ensureHome(home, { url: remote })).toEqual({
            created: true,
        });
        expect(fs.existsSync(path.join(home, '.git'))).toBe(true);
    });

    it('reuses a ready clone, ignoring its node_modules', async () => {
        await ensureHome(home, { url: remote });
        fs.mkdirSync(path.join(home, 'node_modules', 'x'), { recursive: true });
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
        const result = await inspectHome(home, { expectedUrl: remote });
        expect(result.state).toBe('unusable');
        expect(result.reason).toMatch(/other\.git/);
    });

    it('refuses a clone on another branch', async () => {
        await ensureHome(home, { url: remote });
        git(home, 'checkout', '-q', '-b', 'mine');
        await expect(ensureHome(home, { url: remote })).rejects.toThrow(
            /not on the 'main' branch/
        );
    });

    it('refuses a clone with local changes', async () => {
        await ensureHome(home, { url: remote });
        fs.writeFileSync(path.join(home, 'skills/demo/SKILL.md'), 'edited\n');
        await expect(ensureHome(home, { url: remote })).rejects.toThrow(
            /local changes/
        );
    });

    it('cleans up and fails when the clone fails', async () => {
        await expect(
            ensureHome(home, { url: path.join(root, 'missing.git') })
        ).rejects.toThrow(/git clone failed/);
        expect(fs.existsSync(path.dirname(home))).toBe(true);
        expect(fs.readdirSync(path.dirname(home))).toEqual([]);
    });
});
