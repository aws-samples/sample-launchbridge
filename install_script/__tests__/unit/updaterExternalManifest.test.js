// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The upgrade path has to keep the manifest verifiable.
 *
 * WHY THIS FILE EXISTS. `verify_integrity.py` checks external (ai-skills) skills
 * from `externalSkillHashes` (`shared/<skill>` digests), because their
 * `skillHashes` keys are `ai-domain-<domain>` GROUP keys that name no
 * directory. A fresh install records those per-folder digests; an upgrade has
 * to carry them forward. If `runPostPullSync` dropped the field — or dropped
 * `externalManifestKeys`, which tells the checker which keys are group keys —
 * the first `git pull` after install would silently return the repository to
 * the behaviour this was written to fix: every AI skill reported as modified
 * or missing. Nothing else in the suite exercises that write.
 *
 * These run against the real source tree (and so the real ai-skills submodule),
 * and skip when the submodule is not initialized.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    computeAiSkillFolderHashes,
    discoverAiSkills,
} from '../../lib/aiSkills.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { runPostPullSync } from '../../lib/updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const AI_SUBMODULE = path.join(REPO_ROOT, 'project_dependencies', 'ai-skills');
const hasSubmodule = fs.existsSync(
    path.join(AI_SUBMODULE, 'skills', 'research', 'ai-plan', 'SKILL.md')
);

const noopUi = {
    step: () => {},
    success: () => {},
    warn: () => {},
    muted: () => {},
    spacer: () => {},
};

const MANIFEST_REL = path.join(
    '.lb_workspace',
    'config',
    'version_manifest.json'
);

const SEEDED_SKILLS = ['ai-plan', 'ai-research'];

describe('runPostPullSync external manifest fields', () => {
    let targetRepo;

    beforeEach(() => {
        targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-upgrade-'));
    });
    afterEach(() => {
        fs.rmSync(targetRepo, { recursive: true, force: true });
    });

    /** Simulates a symlink install of the research domain, with a stale group hash. */
    function seedInstall(extra = {}) {
        const kiroSkills = path.join(targetRepo, '.kiro', 'skills');
        for (const name of SEEDED_SKILLS) {
            fs.mkdirSync(path.join(kiroSkills, name), { recursive: true });
            fs.writeFileSync(
                path.join(kiroSkills, name, 'SKILL.md'),
                `# ${name}\n`
            );
        }
        const config = path.join(targetRepo, '.lb_workspace', 'config');
        fs.mkdirSync(config, { recursive: true });
        const manifest = {
            schemaVersion: 1,
            version: '1.1.0',
            timestamp: '2026-09-28T00:00:00.000Z',
            installMethod: 'symlink',
            agents: ['kiro'],
            skillHashes: { 'ai-domain-research': 'STALE' },
            ...extra,
        };
        fs.writeFileSync(
            path.join(targetRepo, MANIFEST_REL),
            JSON.stringify(manifest, null, 2)
        );
        return manifest;
    }

    function readManifest() {
        return JSON.parse(
            fs.readFileSync(path.join(targetRepo, MANIFEST_REL), 'utf8')
        );
    }

    it.skipIf(!hasSubmodule)(
        'records per-folder digests and group keys the checker can use',
        async () => {
            seedInstall();
            await runPostPullSync(REPO_ROOT, targetRepo, noopUi);
            const manifest = readManifest();

            // Group keys still drive upgrade detection…
            expect(manifest.skillHashes['ai-domain-research']).not.toBe(
                'STALE'
            );
            // …and are declared as keys the checker must not treat as folders.
            expect(manifest.externalManifestKeys).toEqual([
                'ai-domain-research',
            ]);

            // The per-folder digests are the ones verify_integrity.py compares
            // against an installed directory, so they must be the real thing.
            const aiSkills = discoverAiSkills(REPO_ROOT);
            const expected = await computeAiSkillFolderHashes(
                SEEDED_SKILLS,
                aiSkills
            );
            expect(manifest.externalSkillHashes).toEqual(expected);
            expect(Object.keys(manifest.externalSkillHashes).sort()).toEqual([
                'shared/ai-plan',
                'shared/ai-research',
            ]);
            expect(manifest.externalSkillHashes['shared/ai-plan']).toBe(
                await computeContentHash(
                    path.join(AI_SUBMODULE, 'skills', 'research', 'ai-plan')
                )
            );
        }
    );

    it.skipIf(!hasSubmodule)(
        'keeps recorded group keys and digests the update could not see',
        async () => {
            // A skill installed for an agent that is no longer in `agents`
            // still has a digest and group key recorded. Dropping them would
            // leave that skill unverifiable, so the merge only ever adds.
            seedInstall({
                externalSkillHashes: { 'shared/ai-release': 'PRESERVED' },
                externalManifestKeys: [
                    'ai-domain-research',
                    'ai-domain-semantic-release',
                ],
            });
            await runPostPullSync(REPO_ROOT, targetRepo, noopUi);
            const manifest = readManifest();

            expect(manifest.externalSkillHashes['shared/ai-release']).toBe(
                'PRESERVED'
            );
            expect(
                manifest.externalSkillHashes['shared/ai-plan']
            ).toBeDefined();
            expect(manifest.externalManifestKeys).toEqual([
                'ai-domain-research',
                'ai-domain-semantic-release',
            ]);
        }
    );

    it('omits both fields when no external skills are installed', async () => {
        const nativeSkills = path.join(targetRepo, '.kiro', 'skills');
        fs.mkdirSync(path.join(nativeSkills, 'lb-setup'), { recursive: true });
        fs.writeFileSync(
            path.join(nativeSkills, 'lb-setup', 'SKILL.md'),
            '# lb-setup\n'
        );
        const config = path.join(targetRepo, '.lb_workspace', 'config');
        fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(
            path.join(targetRepo, MANIFEST_REL),
            JSON.stringify({
                schemaVersion: 1,
                version: '1.1.0',
                installMethod: 'symlink',
                agents: ['kiro'],
                skillHashes: { 'lb-setup': 'STALE' },
            })
        );

        await runPostPullSync(REPO_ROOT, targetRepo, noopUi);
        const manifest = readManifest();

        // Absent rather than empty: an empty map would read as "checked nothing".
        expect(manifest.externalSkillHashes).toBeUndefined();
        expect(manifest.externalManifestKeys).toBeUndefined();
    });
});
