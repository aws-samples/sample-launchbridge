// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
    runUpdate,
    summarizeIncomingChanges,
    writeBaselineIfMissing,
    BASELINE_FIELDS,
} from '../../lib/updater.js';

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

function commitFile(repo, relPath, content, message) {
    const full = path.join(repo, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    git(repo, 'add', relPath);
    git(repo, 'commit', '-q', '-m', message);
}

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit)('runUpdate review gate', () => {
    let root;
    let source; // the operator's LaunchBridge checkout
    let upstream; // a second clone standing in for the publisher

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-update-'));
        const remote = path.join(root, 'remote.git');
        git(root, 'init', '-q', '--bare', '-b', 'main', remote);

        upstream = path.join(root, 'upstream');
        git(root, 'clone', '-q', remote, upstream);
        for (const repo of [upstream]) {
            git(repo, 'config', 'user.email', 'test@example.com');
            git(repo, 'config', 'user.name', 'Test');
            git(repo, 'config', 'commit.gpgsign', 'false');
        }
        git(upstream, 'checkout', '-q', '-b', 'main');
        commitFile(upstream, 'skills/demo/SKILL.md', 'v1\n', 'initial');
        git(upstream, 'push', '-q', 'origin', 'main');

        source = path.join(root, 'source');
        git(root, 'clone', '-q', remote, source);
        git(source, 'config', 'user.email', 'test@example.com');
        git(source, 'config', 'user.name', 'Test');
        git(source, 'config', 'commit.gpgsign', 'false');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function publish(relPath, content, message) {
        commitFile(upstream, relPath, content, message);
        git(upstream, 'push', '-q', 'origin', 'main');
    }

    it('reports up to date without asking when nothing is new', async () => {
        let asked = false;
        const result = await runUpdate(source, {
            confirm: async () => {
                asked = true;
                return true;
            },
        });

        expect(result.alreadyCurrent).toBe(true);
        expect(asked).toBe(false);
    });

    it('applies nothing when the operator declines', async () => {
        const before = git(source, 'rev-parse', 'HEAD');
        publish('skills/demo/SKILL.md', 'v2\n', 'change instructions');

        const result = await runUpdate(source, { confirm: async () => false });

        expect(result.declined).toBe(true);
        expect(git(source, 'rev-parse', 'HEAD')).toBe(before);
        expect(
            fs.readFileSync(path.join(source, 'skills/demo/SKILL.md'), 'utf-8')
        ).toBe('v1\n');
    });

    it('applies nothing when no confirm callback is given', async () => {
        const before = git(source, 'rev-parse', 'HEAD');
        publish('skills/demo/SKILL.md', 'v2\n', 'change instructions');

        const result = await runUpdate(source);

        expect(result.declined).toBe(true);
        expect(git(source, 'rev-parse', 'HEAD')).toBe(before);
    });

    it('shows the incoming commits and changed instructions before applying', async () => {
        publish('skills/demo/SKILL.md', 'v2\n', 'change instructions');
        const expected = git(upstream, 'rev-parse', 'HEAD');
        let seen;

        const result = await runUpdate(source, {
            confirm: async (preview) => {
                seen = preview;
                return true;
            },
        });

        expect(seen.commits.map((c) => c.subject)).toEqual([
            'change instructions',
        ]);
        expect(seen.changes.skillInstructions).toEqual(['demo']);
        expect(seen.to).toBe(expected);
        expect(result.alreadyCurrent).toBe(false);
        expect(git(source, 'rev-parse', 'HEAD')).toBe(expected);
    });

    it('applies exactly the previewed commit even if the remote moves meanwhile', async () => {
        publish('skills/demo/SKILL.md', 'v2\n', 'previewed change');
        const previewed = git(upstream, 'rev-parse', 'HEAD');

        await runUpdate(source, {
            confirm: async () => {
                // Lands on the remote after the preview was built.
                publish('skills/demo/SKILL.md', 'v3\n', 'later change');
                return true;
            },
        });

        expect(git(source, 'rev-parse', 'HEAD')).toBe(previewed);
    });

    it('refuses to merge when the local branch has diverged', async () => {
        commitFile(source, 'local.txt', 'mine\n', 'local work');
        publish('skills/demo/SKILL.md', 'v2\n', 'remote work');
        const before = git(source, 'rev-parse', 'HEAD');

        await expect(
            runUpdate(source, { confirm: async () => true })
        ).rejects.toThrow(/only fast-forwards/);
        expect(git(source, 'rev-parse', 'HEAD')).toBe(before);
    });

    it('refuses on a checked-out release tag instead of offering the branch tip', async () => {
        git(upstream, 'tag', 'v1.0.0');
        git(upstream, 'push', '-q', 'origin', 'v1.0.0');
        publish('skills/demo/SKILL.md', 'v2\n', 'unreleased change');
        git(source, 'fetch', '-q', '--tags', 'origin');
        git(source, 'checkout', '-q', 'v1.0.0');
        const before = git(source, 'rev-parse', 'HEAD');
        let asked = false;

        await expect(
            runUpdate(source, {
                confirm: async () => {
                    asked = true;
                    return true;
                },
            })
        ).rejects.toThrow(
            /release tag v1\.0\.0, not on a branch[\s\S]*verify-tag/
        );
        expect(asked).toBe(false);
        expect(git(source, 'rev-parse', 'HEAD')).toBe(before);
    });

    it('refuses on a detached HEAD that is not a tag', async () => {
        publish('skills/demo/SKILL.md', 'v2\n', 'remote work');
        git(source, 'checkout', '-q', '--detach');

        await expect(
            runUpdate(source, { confirm: async () => true })
        ).rejects.toThrow(/a detached HEAD, not on a branch/);
    });
});

describe('summarizeIncomingChanges', () => {
    it('separates instructions, installer code, steering and submodule pointers', () => {
        const changes = summarizeIncomingChanges([
            'skills/lb-setup/SKILL.md',
            'skills/lb-setup/scripts/verify_integrity.py',
            'skills/indexing-and-qa/references/notes.md',
            'install_script/lib/updater.js',
            'agent_steering/AGENTS.md',
            'project_dependencies/ai-skills',
            'project_dependencies/pyproject.toml',
            'README.md',
        ]);

        expect(changes.skillInstructions).toEqual(['lb-setup']);
        expect(changes.skills).toEqual(['indexing-and-qa', 'lb-setup']);
        expect(changes.installer).toEqual(['install_script/lib/updater.js']);
        expect(changes.steering).toEqual(['agent_steering/AGENTS.md']);
        expect(changes.submodules).toEqual(['project_dependencies/ai-skills']);
        expect(changes.scripts).toEqual([
            'skills/lb-setup/scripts/verify_integrity.py',
            'install_script/lib/updater.js',
        ]);
        expect(changes.other).toEqual([
            'project_dependencies/pyproject.toml',
            'README.md',
        ]);
    });
});

describe('writeBaselineIfMissing', () => {
    let target;
    const baselinePath = () =>
        path.join(target, '.lb_workspace', 'config', 'skill_digests.json');
    const manifest = {
        version: '1.0.0',
        timestamp: '2026-01-01T00:00:00.000Z',
        installMethod: 'copy',
        agents: ['claude'],
        skillHashes: { demo: 'old-digest' },
        sourcePath: '/Users/someone/launchbridge',
        gitCommitHash: 'abc1234',
        deliveryMethod: 'git_repo',
    };

    beforeEach(() => {
        target = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-baseline-'));
    });
    afterEach(() => {
        fs.rmSync(target, { recursive: true, force: true });
    });

    it('pins the pre-update digests and leaves out machine detail', async () => {
        expect(await writeBaselineIfMissing(target, manifest)).toBe(true);

        const written = JSON.parse(fs.readFileSync(baselinePath(), 'utf-8'));
        expect(written.skillHashes).toEqual({ demo: 'old-digest' });
        expect(written).not.toHaveProperty('sourcePath');
        expect(written).not.toHaveProperty('gitCommitHash');
        expect(written).not.toHaveProperty('deliveryMethod');
        for (const key of Object.keys(written)) {
            expect([...BASELINE_FIELDS, 'note']).toContain(key);
        }
    });

    it('never moves an existing baseline forward', async () => {
        fs.mkdirSync(path.dirname(baselinePath()), { recursive: true });
        fs.writeFileSync(
            baselinePath(),
            '{"skillHashes":{"demo":"reviewed"}}\n'
        );

        expect(await writeBaselineIfMissing(target, manifest)).toBe(false);
        expect(fs.readFileSync(baselinePath(), 'utf-8')).toBe(
            '{"skillHashes":{"demo":"reviewed"}}\n'
        );
    });
});
