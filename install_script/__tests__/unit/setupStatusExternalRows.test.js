// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The installer's lifecycle-fallback branch hands writeSetupStatus a closure
 * that binds the discovered external skill list to the provider's
 * buildStatusRows. writeSetupStatus calls that callback with two arguments
 * only, so a bare method reference would lose the list and emit no AI rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeSetupStatus } from '../../lib/setupStatus.js';
import { externalSkills } from '../../lib/externalSkillsProvider.js';

describe('writeSetupStatus with external status rows', () => {
    let tmpRepo;

    beforeEach(() => {
        tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-status-'));
        fs.mkdirSync(path.join(tmpRepo, '.lb_workspace'), { recursive: true });
    });
    afterEach(() => {
        fs.rmSync(tmpRepo, { recursive: true, force: true });
    });

    it('writes an ai-domain-research row marked ready', async () => {
        const fakeList = [
            {
                name: 'ai-plan',
                domain: 'research',
                group: 'ai-domain-research',
                isAiSkill: true,
                path: path.join(tmpRepo, 'src', 'ai-plan'),
            },
        ];

        const result = await writeSetupStatus(tmpRepo, ['ai-plan'], (e, i) =>
            externalSkills.buildStatusRows(e, i, fakeList)
        );
        expect(result.status).toBe('created');

        const content = fs.readFileSync(
            path.join(tmpRepo, '.lb_workspace', 'setup_status.md'),
            'utf8'
        );
        expect(content).toMatch(/\|\s*ai-domain-research\s*\|\s*ready\s*\|/);
    });
});
