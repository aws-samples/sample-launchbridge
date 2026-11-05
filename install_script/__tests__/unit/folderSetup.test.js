// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for the Folder Setup module — focused on skill-conditional dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createFolderStructure } from '../../lib/folderSetup.js';

describe('folderSetup — skill-conditional directories', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-folder-'));
    });
    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const exists = (rel) => fs.existsSync(path.join(tempDir, rel));

    it('creates ai_workflow dirs when ai-workflow is installed', async () => {
        const result = await createFolderStructure(tempDir, ['ai-workflow']);
        expect(result.success).toBe(true);
        expect(exists('.lb_workspace/ai_workflow')).toBe(true);
        expect(exists('.lb_workspace/ai_workflow/references')).toBe(true);
        // the SDD skills write their artifacts under docs/working, not here
        expect(exists('.lb_workspace/ai_workflow/specs')).toBe(false);
    });

    it('does NOT create ai_workflow dirs when the skill is absent', async () => {
        const result = await createFolderStructure(tempDir, [
            'code-guardrails',
        ]);
        expect(result.success).toBe(true);
        // baseline workspace still created
        expect(exists('.lb_workspace/config')).toBe(true);
        // conditional dir absent
        expect(exists('.lb_workspace/ai_workflow')).toBe(false);
    });

    it('defaults to no conditional dirs when no skills are passed', async () => {
        const result = await createFolderStructure(tempDir);
        expect(result.success).toBe(true);
        expect(exists('.lb_workspace/ai_workflow')).toBe(false);
    });
});
