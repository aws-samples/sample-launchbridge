// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * A target repository whose agent skills directory is a symlink must not let
 * the installer, the updater or the AI-skill refresh delete or overwrite files
 * outside the repository. Orphan cleanup only offers skills the previous
 * install recorded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkSkillsDirectory } from '../../lib/pathValidator.js';
import { findOrphanSkills } from '../../lib/installer.js';
import { runPostPullSync } from '../../lib/updater.js';
import { updateAiSkills } from '../../lib/aiSkills.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const hasAiSubmodule = fs.existsSync(
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

const quietUi = (warnings = []) => ({
    step: () => {},
    success: () => {},
    muted: () => {},
    spacer: () => {},
    warn: (msg) => warnings.push(msg),
});

describe.skipIf(process.platform === 'win32')(
    'symlinked agent skills directory',
    () => {
        let base;
        let repo; // target repository
        let outside; // operator data outside the repository

        beforeEach(() => {
            base = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-skills-link-'))
            );
            repo = path.join(base, 'repo');
            outside = path.join(base, 'operator-data');
            fs.mkdirSync(repo, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
        });
        afterEach(() => {
            fs.rmSync(base, { recursive: true, force: true });
        });

        /** Plants `<repo>/.claude` -> `outside`, with a skill dir holding operator data. */
        function plantLinkedClaudeDir(skillName) {
            const skillDir = path.join(outside, 'skills', skillName);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'keep.txt'), 'operator\n');
            fs.symlinkSync(outside, path.join(repo, '.claude'));
            return path.join(skillDir, 'keep.txt');
        }

        function writeManifest(manifest) {
            const dir = path.join(repo, '.lb_workspace', 'config');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'version_manifest.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    version: '1.1.0',
                    timestamp: '2026-10-01T00:00:00.000Z',
                    ...manifest,
                })
            );
        }

        describe('checkSkillsDirectory', () => {
            it('accepts a real directory and one that does not exist yet', async () => {
                expect(
                    await checkSkillsDirectory(
                        path.join(repo, '.claude', 'skills'),
                        repo
                    )
                ).toEqual({ ok: true });
                fs.mkdirSync(path.join(repo, '.claude', 'skills'), {
                    recursive: true,
                });
                expect(
                    await checkSkillsDirectory(
                        path.join(repo, '.claude', 'skills'),
                        repo
                    )
                ).toEqual({ ok: true });
            });

            it('refuses a symlinked parent component', async () => {
                plantLinkedClaudeDir('demo');
                const result = await checkSkillsDirectory(
                    path.join(repo, '.claude', 'skills'),
                    repo
                );
                expect(result.ok).toBe(false);
                expect(result.reason).toContain('symlink');
            });

            it('refuses a symlinked skills directory', async () => {
                fs.mkdirSync(path.join(repo, '.claude'));
                fs.symlinkSync(outside, path.join(repo, '.claude', 'skills'));
                const result = await checkSkillsDirectory(
                    path.join(repo, '.claude', 'skills'),
                    repo
                );
                expect(result.ok).toBe(false);
            });

            it('refuses a directory outside the root', async () => {
                const result = await checkSkillsDirectory(outside, repo);
                expect(result.ok).toBe(false);
            });
        });

        describe('orphan cleanup (installer)', () => {
            it('offers only skills the previous install recorded', () => {
                const orphans = findOrphanSkills(
                    ['lb-setup', 'old-skill', 'my-own-skill'],
                    ['lb-setup'],
                    new Set(['lb-setup', 'old-skill'])
                );
                expect(orphans).toEqual(['old-skill']);
            });

            it('offers nothing when there is no previous manifest', () => {
                expect(findOrphanSkills(['a', 'b'], [], new Set())).toEqual([]);
            });
        });

        describe('updater copy-mode re-copy', () => {
            it('skips an agent whose skills directory is a symlink', async () => {
                const keep = plantLinkedClaudeDir('testing-framework');
                writeManifest({
                    installMethod: 'copy',
                    agents: ['claude'],
                    skills: ['testing-framework'],
                    skillHashes: { 'testing-framework': 'stale' },
                });
                const warnings = [];

                const result = await runPostPullSync(
                    REPO_ROOT,
                    repo,
                    quietUi(warnings)
                );

                expect(fs.readFileSync(keep, 'utf-8')).toBe('operator\n');
                expect(result.updatedSkills).toEqual([]);
                expect(warnings.join('\n')).toContain('symlink');
            });
        });

        describe.skipIf(!hasAiSubmodule)('AI-skill refresh', () => {
            it('skips an agent whose skills directory is a symlink', async () => {
                const keep = plantLinkedClaudeDir('ai-plan');
                const warnings = [];

                const result = await updateAiSkills(
                    REPO_ROOT,
                    repo,
                    {
                        installMethod: 'copy',
                        agents: ['claude'],
                        skillHashes: { 'ai-domain-research': 'stale' },
                    },
                    quietUi(warnings)
                );

                expect(fs.readFileSync(keep, 'utf-8')).toBe('operator\n');
                expect(result.updated).toEqual([]);
                expect(warnings.join('\n')).toContain('symlink');
            });
        });
    }
);
