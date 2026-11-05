// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { copyDirRecursive } from '../../lib/updater.js';

describe.skipIf(process.platform === 'win32')(
    'copyDirRecursive link containment',
    () => {
        let root; // stands in for the LaunchBridge source tree
        let outside; // a directory outside the source tree
        let target;
        let skill;

        beforeEach(() => {
            const base = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-copy-'))
            );
            root = path.join(base, 'launchbridge');
            outside = path.join(base, 'elsewhere');
            target = path.join(base, 'target', 'demo');
            skill = path.join(root, 'skills', 'demo');
            fs.mkdirSync(skill, { recursive: true });
            fs.mkdirSync(path.join(root, 'project_dependencies', 'lib'), {
                recursive: true,
            });
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(skill, 'SKILL.md'), 'skill\n');
            fs.writeFileSync(
                path.join(root, 'project_dependencies', 'lib', 'm.py'),
                'lib\n'
            );
            fs.writeFileSync(path.join(outside, 'data.txt'), 'data\n');
        });

        afterEach(() => {
            fs.rmSync(path.dirname(root), { recursive: true, force: true });
        });

        const has = (rel) => fs.existsSync(path.join(target, rel));

        it('copies a linked directory that resolves inside the source tree', async () => {
            fs.symlinkSync(
                path.join(root, 'project_dependencies', 'lib'),
                path.join(skill, 'lib')
            );

            await copyDirRecursive(skill, target, { allowedRoot: root });

            expect(
                fs.readFileSync(path.join(target, 'lib', 'm.py'), 'utf-8')
            ).toBe('lib\n');
            expect(
                fs.lstatSync(path.join(target, 'lib')).isSymbolicLink()
            ).toBe(false);
        });

        it('skips and reports links that resolve outside the source tree', async () => {
            fs.symlinkSync(outside, path.join(skill, 'ext-dir'));
            fs.symlinkSync(
                path.join(outside, 'data.txt'),
                path.join(skill, 'ext-file')
            );
            const skipped = [];

            await copyDirRecursive(skill, target, {
                allowedRoot: root,
                onSkip: (src) => skipped.push(path.basename(src)),
            });

            expect(has('SKILL.md')).toBe(true);
            expect(has('ext-dir')).toBe(false);
            expect(has('ext-file')).toBe(false);
            expect(skipped.sort()).toEqual(['ext-dir', 'ext-file']);
        });

        it('does not treat a sibling sharing the root as a prefix as inside it', async () => {
            const sibling = `${root}-old`;
            fs.mkdirSync(sibling);
            fs.writeFileSync(path.join(sibling, 'file.txt'), 'x\n');
            fs.symlinkSync(sibling, path.join(skill, 'sibling'));

            await copyDirRecursive(skill, target, { allowedRoot: root });

            expect(has('sibling')).toBe(false);
        });

        it('terminates on a link back up its own tree', async () => {
            fs.symlinkSync(skill, path.join(skill, 'loop'));

            await copyDirRecursive(skill, target, { allowedRoot: root });

            expect(has('SKILL.md')).toBe(true);
        });

        it('follows no links at all without an allowedRoot', async () => {
            fs.symlinkSync(
                path.join(root, 'project_dependencies', 'lib'),
                path.join(skill, 'lib')
            );

            await copyDirRecursive(skill, target);

            expect(has('SKILL.md')).toBe(true);
            expect(has('lib')).toBe(false);
        });
    }
);
