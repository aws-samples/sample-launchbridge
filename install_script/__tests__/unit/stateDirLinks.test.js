// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The state directory must be outside the repository however it is spelled:
 * an XDG_CONFIG_HOME reached through a link into the repository counts as
 * inside it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeRepoState } from '../../lib/stateDir.js';

describe.skipIf(process.platform === 'win32')('state directory links', () => {
    let base;
    let saved;
    beforeEach(() => {
        base = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'lb-state-'))
        );
        saved = process.env.XDG_CONFIG_HOME;
    });
    afterEach(() => {
        process.env.XDG_CONFIG_HOME = saved;
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('refuses an XDG_CONFIG_HOME that links into the repository', async () => {
        const repo = path.join(base, 'repo');
        fs.mkdirSync(path.join(repo, 'cfg'), { recursive: true });
        fs.symlinkSync(path.join(repo, 'cfg'), path.join(base, 'xdg'));
        process.env.XDG_CONFIG_HOME = path.join(base, 'xdg');
        await expect(writeRepoState(repo, 'x', 'y')).rejects.toThrow(
            /inside the repository/
        );
    });

    it('writes to a state directory outside the repository', async () => {
        const repo = path.join(base, 'repo');
        fs.mkdirSync(repo);
        process.env.XDG_CONFIG_HOME = path.join(base, 'elsewhere');
        const file = await writeRepoState(repo, 'x', 'y');
        expect(fs.readFileSync(file, 'utf-8')).toBe('y');
    });
});
