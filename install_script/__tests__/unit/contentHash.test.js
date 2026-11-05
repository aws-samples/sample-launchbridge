// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    computeContentHash,
    computeDependencySetHash,
} from '../../lib/contentHash.js';

describe.skipIf(process.platform === 'win32')(
    'computeContentHash link containment',
    () => {
        let root;
        let skill;
        let outside;

        beforeEach(() => {
            const base = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-hash-'))
            );
            root = path.join(base, 'launchbridge');
            skill = path.join(root, 'skills', 'demo');
            outside = path.join(base, 'elsewhere');
            fs.mkdirSync(skill, { recursive: true });
            fs.mkdirSync(path.join(root, 'deps'), { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(skill, 'SKILL.md'), 'skill\n');
            fs.writeFileSync(path.join(root, 'deps', 'lib.py'), 'lib\n');
            fs.writeFileSync(path.join(outside, 'data.txt'), 'data\n');
        });

        afterEach(() => {
            fs.rmSync(path.dirname(root), { recursive: true, force: true });
        });

        const hashWithin = () =>
            computeContentHash(skill, { allowedRoot: root });

        it('still hashes a linked directory inside the source tree', async () => {
            const before = await hashWithin();
            fs.symlinkSync(path.join(root, 'deps'), path.join(skill, 'lib'));

            const after = await hashWithin();

            expect(after).not.toBe(before);
            expect(after).toBe(await computeContentHash(skill));
        });

        it('leaves out links that resolve outside the source tree', async () => {
            const before = await hashWithin();
            fs.symlinkSync(outside, path.join(skill, 'ext-dir'));
            fs.symlinkSync(
                path.join(outside, 'data.txt'),
                path.join(skill, 'data.txt')
            );

            expect(await hashWithin()).toBe(before);
        });

        it('does not treat a sibling sharing the root as a prefix as inside it', async () => {
            const before = await hashWithin();
            const sibling = `${root}-old`;
            fs.mkdirSync(sibling);
            fs.writeFileSync(path.join(sibling, 'file.txt'), 'x\n');
            fs.symlinkSync(sibling, path.join(skill, 'sibling'));

            expect(await hashWithin()).toBe(before);
        });

        it('follows every link without allowedRoot, matching verify_integrity.py', async () => {
            const before = await computeContentHash(skill);
            fs.symlinkSync(
                path.join(outside, 'data.txt'),
                path.join(skill, 'data.txt')
            );

            expect(await computeContentHash(skill)).not.toBe(before);
        });
    }
);

describe('computeDependencySetHash', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-deps-'));
        fs.mkdirSync(path.join(root, 'project_dependencies'));
        fs.writeFileSync(
            path.join(root, 'project_dependencies', 'pyproject.toml'),
            '[project]\nname = "demo"\n'
        );
        fs.writeFileSync(
            path.join(root, 'project_dependencies', 'constraints.txt'),
            'requests==2.32.0\n'
        );
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('changes when only constraints.txt changes', async () => {
        const before = await computeDependencySetHash(root);
        fs.writeFileSync(
            path.join(root, 'project_dependencies', 'constraints.txt'),
            'requests==2.32.5\n'
        );
        expect(await computeDependencySetHash(root)).not.toBe(before);
    });

    it('changes when only pyproject.toml changes', async () => {
        const before = await computeDependencySetHash(root);
        fs.writeFileSync(
            path.join(root, 'project_dependencies', 'pyproject.toml'),
            '[project]\nname = "demo2"\n'
        );
        expect(await computeDependencySetHash(root)).not.toBe(before);
    });

    it('is stable for unchanged files', async () => {
        expect(await computeDependencySetHash(root)).toBe(
            await computeDependencySetHash(root)
        );
    });

    it('throws when constraints.txt is missing', async () => {
        fs.rmSync(path.join(root, 'project_dependencies', 'constraints.txt'));
        await expect(computeDependencySetHash(root)).rejects.toThrow();
    });
});
