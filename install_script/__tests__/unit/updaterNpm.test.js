// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { runUpdate } from '../../lib/updater.js';
import { NPM_CI_ARGS, needsNpmInstall } from '../../lib/npmRunner.js';

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

function configure(repo) {
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
}

function commitFile(repo, relPath, content, message) {
    const full = path.join(repo, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    git(repo, 'add', relPath);
    git(repo, 'commit', '-q', '-m', message);
}

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('needsNpmInstall', () => {
    it('is true when the manifest or lockfile changed', () => {
        expect(needsNpmInstall(['package.json'])).toBe(true);
        expect(
            needsNpmInstall(['skills/a/SKILL.md', 'package-lock.json'])
        ).toBe(true);
    });

    it('ignores other package.json files and unrelated paths', () => {
        expect(needsNpmInstall(['skills/a/package.json'])).toBe(false);
        expect(needsNpmInstall(['README.md'])).toBe(false);
        expect(needsNpmInstall([])).toBe(false);
    });
});

describe.skipIf(!hasGit)('runUpdate reinstalls npm packages', () => {
    let root;
    let source;
    let upstream;
    let calls;

    const recordingNpm =
        (code = 0, stderr = '') =>
        async (args, cwd) => {
            calls.push({ args: [...args], cwd });
            return { code, stdout: '', stderr };
        };

    beforeEach(() => {
        calls = [];
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-update-npm-'));
        const remote = path.join(root, 'remote.git');
        git(root, 'init', '-q', '--bare', '-b', 'main', remote);
        upstream = path.join(root, 'upstream');
        git(root, 'clone', '-q', remote, upstream);
        configure(upstream);
        git(upstream, 'checkout', '-q', '-b', 'main');
        commitFile(upstream, 'package-lock.json', '{"v":1}\n', 'initial');
        git(upstream, 'push', '-q', 'origin', 'main');
        source = path.join(root, 'source');
        git(root, 'clone', '-q', remote, source);
        configure(source);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function publish(relPath, content, message) {
        commitFile(upstream, relPath, content, message);
        git(upstream, 'push', '-q', 'origin', 'main');
    }

    it('runs npm ci in the clone when the lockfile changed', async () => {
        publish('package-lock.json', '{"v":2}\n', 'bump a dependency');

        const result = await runUpdate(source, {
            confirm: async () => true,
            npm: recordingNpm(),
        });

        expect(calls).toEqual([{ args: [...NPM_CI_ARGS], cwd: source }]);
        expect(result.npmInstalled).toBe(true);
        expect(result.npmError).toBeUndefined();
    });

    it('does not run npm when only other files changed', async () => {
        publish('skills/demo/SKILL.md', 'v2\n', 'change a skill');

        const result = await runUpdate(source, {
            confirm: async () => true,
            npm: recordingNpm(),
        });

        expect(calls).toEqual([]);
        expect(result.npmInstalled).toBeUndefined();
    });

    it('does not run npm when the update is declined', async () => {
        publish('package.json', '{}\n', 'change the manifest');

        await runUpdate(source, {
            confirm: async () => false,
            npm: recordingNpm(),
        });

        expect(calls).toEqual([]);
    });

    it('reports a failed npm ci after applying the update', async () => {
        publish('package-lock.json', '{"v":2}\n', 'bump a dependency');
        const expected = git(upstream, 'rev-parse', 'HEAD');

        const result = await runUpdate(source, {
            confirm: async () => true,
            npm: recordingNpm(1, 'npm error code E404\n'),
        });

        expect(git(source, 'rev-parse', 'HEAD')).toBe(expected);
        expect(result.npmInstalled).toBeUndefined();
        expect(result.npmError).toContain('E404');
        expect(result.npmError).toContain(source);
    });
});
