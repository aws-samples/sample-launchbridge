// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectDeliveryMethod } from '../../lib/deliveryDetector.js';

describe('detectDeliveryMethod', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-delivery-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('treats a .git directory as a git clone', async () => {
        fs.mkdirSync(path.join(dir, '.git'));
        expect(await detectDeliveryMethod(dir)).toBe('git_repo');
    });

    it('treats a gitdir: file as a git clone (worktree or submodule)', async () => {
        fs.writeFileSync(
            path.join(dir, '.git'),
            'gitdir: /somewhere/.git/worktrees/wt\n'
        );
        expect(await detectDeliveryMethod(dir)).toBe('git_repo');
    });

    it('treats a .git file without gitdir: as a packaged copy', async () => {
        fs.writeFileSync(path.join(dir, '.git'), 'not a pointer\n');
        expect(await detectDeliveryMethod(dir)).toBe('bundled');
    });

    it('treats a missing .git as a packaged copy', async () => {
        expect(await detectDeliveryMethod(dir)).toBe('bundled');
    });
});
