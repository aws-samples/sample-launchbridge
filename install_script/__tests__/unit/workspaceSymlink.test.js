// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * checkWorkspace refuses a .lb_workspace, or any directory or file the installer
 * and updater write in it, that is reached through a symlink.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkWorkspace } from '../../lib/pathValidator.js';

describe('checkWorkspace', () => {
    let base;
    let target;
    let outside;
    const ws = (...p) => path.join(target, '.lb_workspace', ...p);

    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-ws-'));
        target = path.join(base, 'target');
        outside = path.join(base, 'outside');
        fs.mkdirSync(target);
        fs.mkdirSync(outside);
    });
    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('accepts a target with no workspace yet', async () => {
        expect(await checkWorkspace(target)).toEqual({ ok: true });
    });

    it('accepts a normal workspace', async () => {
        fs.mkdirSync(ws('config', 'python_deps'), { recursive: true });
        fs.writeFileSync(ws('setup_status.md'), '# status\n');
        fs.writeFileSync(ws('config', 'version_manifest.json'), '{}\n');
        expect(await checkWorkspace(target)).toEqual({ ok: true });
    });

    it('refuses a symlinked .project_artifacts', async () => {
        fs.symlinkSync(outside, path.join(target, '.project_artifacts'));
        const result = await checkWorkspace(target);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('is a symlink');
    });

    it('refuses a symlinked .project_artifacts phase folder', async () => {
        fs.mkdirSync(path.join(target, '.project_artifacts'));
        fs.symlinkSync(
            outside,
            path.join(target, '.project_artifacts', 'pre-project')
        );
        const result = await checkWorkspace(target);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('is a symlink');
    });

    it('refuses a symlinked .lb_workspace', async () => {
        fs.symlinkSync(outside, ws());
        const result = await checkWorkspace(target);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('is a symlink');
    });

    it('refuses a symlinked config directory', async () => {
        fs.mkdirSync(ws(), { recursive: true });
        fs.symlinkSync(outside, ws('config'));
        expect((await checkWorkspace(target)).ok).toBe(false);
    });

    it.each([
        'setup_status.md',
        path.join('config', 'version_manifest.json'),
        path.join('config', 'skill_digests.json'),
        path.join('config', 'python_deps', 'pyproject.toml'),
        path.join('config', 'python_deps', 'constraints.txt'),
    ])('refuses a symlinked %s', async (file) => {
        fs.mkdirSync(path.dirname(ws(file)), { recursive: true });
        const victim = path.join(outside, 'victim');
        fs.writeFileSync(victim, 'keep\n');
        fs.symlinkSync(victim, ws(file));
        const result = await checkWorkspace(target);
        expect(result.ok).toBe(false);
        expect(fs.readFileSync(victim, 'utf8')).toBe('keep\n');
    });

    it('refuses a symlinked subdirectory the installer creates', async () => {
        fs.mkdirSync(ws(), { recursive: true });
        fs.symlinkSync(outside, ws('indexing_and_qa'));
        expect((await checkWorkspace(target)).ok).toBe(false);
    });
});
