// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The installer's orphan cleanup, end to end on real directories: only skills the
 * previous install recorded are removed, --yes removes nothing, a symlinked orphan
 * is unlinked without touching what it points to, and a symlinked skills
 * directory is not scanned at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupOrphanSkills } from '../../lib/orphanCleanup.js';

describe.skipIf(process.platform === 'win32')('cleanupOrphanSkills', () => {
    let base;
    let repo;
    let skills;
    let outside;
    const removeAll = async (orphans) => ({ action: 'remove', names: orphans });

    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-orphans-'));
        repo = path.join(base, 'repo');
        skills = path.join(repo, '.claude', 'skills');
        outside = path.join(base, 'outside');
        fs.mkdirSync(skills, { recursive: true });
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep\n');
        for (const name of ['kept', 'dropped']) {
            fs.mkdirSync(path.join(skills, name));
            fs.writeFileSync(path.join(skills, name, 'SKILL.md'), '# s\n');
        }
        fs.mkdirSync(path.join(skills, 'users-own'));
        fs.symlinkSync(outside, path.join(skills, 'linked'));
    });
    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    const run = (overrides = {}) =>
        cleanupOrphanSkills({
            baseTargetPath: skills,
            targetRepository: repo,
            selectedSkills: ['kept'],
            previouslyInstalled: new Set(['kept', 'dropped', 'linked']),
            prompt: removeAll,
            ...overrides,
        });

    it('removes only previously installed skills that are no longer selected', async () => {
        const result = await run();
        expect(result.action).toBe('remove');
        expect(result.removed.sort()).toEqual(['dropped', 'linked']);
        expect(fs.existsSync(path.join(skills, 'dropped'))).toBe(false);
        expect(fs.existsSync(path.join(skills, 'kept', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(skills, 'users-own'))).toBe(true);
    });

    it('unlinks a symlinked orphan and leaves its target untouched', async () => {
        await run();
        expect(fs.existsSync(path.join(skills, 'linked'))).toBe(false);
        expect(
            fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')
        ).toBe('keep\n');
    });

    it('removes nothing under --yes', async () => {
        const warnings = [];
        const result = await run({
            yes: true,
            onWarn: (m) => warnings.push(m),
            prompt: () => {
                throw new Error('must not prompt');
            },
        });
        expect(result.action).toBe('skip');
        expect(fs.existsSync(path.join(skills, 'dropped'))).toBe(true);
        expect(warnings[0]).toContain('Not removing');
    });

    it('does not remove a name the prompt adds that is not an orphan', async () => {
        const result = await run({
            prompt: async () => ({ action: 'remove', names: ['users-own'] }),
        });
        expect(result.removed).toEqual([]);
        expect(fs.existsSync(path.join(skills, 'users-own'))).toBe(true);
    });

    it('does not scan a skills directory reached through a symlink', async () => {
        const realSkills = path.join(outside, 'skills');
        fs.mkdirSync(path.join(realSkills, 'dropped'), { recursive: true });
        fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true });
        fs.mkdirSync(path.join(repo, '.claude'));
        fs.symlinkSync(realSkills, skills);

        const result = await run();
        expect(result.action).toBe('refused');
        expect(fs.existsSync(path.join(realSkills, 'dropped'))).toBe(true);
    });
});
