// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Native LaunchBridge skills and the pinned ai-skills submodule must not share
 * a skill name. Discovery would keep the native one and skip the external one
 * with a warning; this test catches that before a release ships it.
 *
 * Runs against the real source tree and skips when the submodule is not
 * initialized.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverAiSkills } from '../../lib/aiSkills.js';
import { discoverSkills } from '../../lib/skillDiscovery.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const hasSubmodule = fs.existsSync(
    path.join(
        REPO_ROOT,
        'project_dependencies',
        'ai-skills',
        'skills',
        'research',
        'ai-plan',
        'SKILL.md'
    )
);

describe('native vs ai-skills names', () => {
    it.skipIf(!hasSubmodule)(
        'no native skill name appears in the ai-skills submodule',
        () => {
            const nativeNames = new Set(
                discoverSkills(REPO_ROOT).map((s) => s.name)
            );
            const upstreamNames = discoverAiSkills(REPO_ROOT).map(
                (s) => s.name
            );
            expect(upstreamNames.length).toBeGreaterThan(0);
            expect(upstreamNames.filter((n) => nativeNames.has(n))).toEqual([]);
        }
    );

    it.skipIf(!hasSubmodule)(
        'discovery with the native names reports no warnings',
        () => {
            const nativeNames = new Set(
                discoverSkills(REPO_ROOT).map((s) => s.name)
            );
            const warnings = [];
            const skills = discoverAiSkills(REPO_ROOT, {
                nativeNames,
                onWarn: (m) => warnings.push(m),
            });
            expect(warnings).toEqual([]);
            expect(skills.map((s) => s.name)).toEqual(
                expect.arrayContaining([
                    'ai-archive',
                    'ai-create',
                    'ai-implement',
                    'ai-plan',
                    'ai-research',
                ])
            );
            expect(skills.map((s) => s.name)).not.toContain('ai-release');
        }
    );
});
