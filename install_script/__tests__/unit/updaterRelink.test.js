// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * `launchbridge update` replaces a local symlink install's skill folder that
 * LaunchBridge 1.2.0 made of one link per file with a link to the folder, but
 * never one that also holds files of the user's: those would be deleted.
 * HOME, USERPROFILE and XDG_CONFIG_HOME point at temporary folders, so the
 * repository's records go nowhere near the user's own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    computeDependencySetHash,
    computeSkillHashes,
} from '../../lib/contentHash.js';
import { runPostPullSync } from '../../lib/updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SKILLS = ['code-guardrails', 'testing-framework'];

describe.skipIf(process.platform === 'win32')(
    'launchbridge update in a local symlink install of per-file links',
    () => {
        let root;
        let repo;
        const saved = {};
        const skillDir = (name) => path.join(repo, '.claude', 'skills', name);

        beforeEach(() => {
            root = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-relink-'))
            );
            repo = path.join(root, 'repo');
            fs.mkdirSync(repo);
            for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
                saved[key] = process.env[key];
            }
            process.env.HOME = path.join(root, 'home');
            process.env.USERPROFILE = process.env.HOME;
            process.env.XDG_CONFIG_HOME = path.join(root, 'state');
        });
        afterEach(() => {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(root, { recursive: true, force: true });
        });

        async function writeManifest() {
            const dir = path.join(repo, '.lb_workspace', 'config');
            fs.mkdirSync(dir, { recursive: true });
            const allowedRoot = fs.realpathSync(REPO_ROOT);
            fs.writeFileSync(
                path.join(dir, 'version_manifest.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    version: '1.2.0',
                    timestamp: '2026-10-01T00:00:00.000Z',
                    installMethod: 'symlink',
                    agents: ['claude'],
                    skills: SKILLS,
                    skillHashes: await computeSkillHashes(
                        Object.fromEntries(
                            SKILLS.map((s) => [
                                s,
                                path.join(REPO_ROOT, 'skills', s),
                            ])
                        ),
                        { allowedRoot }
                    ),
                    pyprojectHash: await computeDependencySetHash(REPO_ROOT),
                    installedTargets: SKILLS.map((s) => `.claude/skills/${s}`),
                })
            );
        }

        it('links a folder of LaunchBridge’s links again and leaves one holding a file of the user’s', async () => {
            for (const name of SKILLS) {
                fs.mkdirSync(skillDir(name), { recursive: true });
                fs.symlinkSync(
                    path.join(REPO_ROOT, 'skills', name, 'SKILL.md'),
                    path.join(skillDir(name), 'SKILL.md')
                );
            }
            const mine = path.join(
                skillDir('code-guardrails'),
                'assets',
                'best_practices',
                'client_a_standards.md'
            );
            fs.mkdirSync(path.dirname(mine), { recursive: true });
            fs.writeFileSync(mine, 'my standards\n');
            await writeManifest();
            const warnings = [];

            await runPostPullSync(REPO_ROOT, repo, {
                step: () => {},
                success: () => {},
                muted: () => {},
                spacer: () => {},
                warn: (m) => warnings.push(m),
            });

            expect(fs.readFileSync(mine, 'utf-8')).toBe('my standards\n');
            expect(
                fs.lstatSync(skillDir('code-guardrails')).isSymbolicLink()
            ).toBe(false);
            expect(warnings.join('\n')).toMatch(
                /Not linking code-guardrails \(claude\) to its source folder: .* holds files LaunchBridge did not install \(assets\/best_practices\/client_a_standards\.md\)\. To replace it, run 'launchbridge' here and choose Local\./
            );

            const linked = skillDir('testing-framework');
            expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
            expect(fs.realpathSync(linked)).toBe(
                fs.realpathSync(
                    path.join(REPO_ROOT, 'skills', 'testing-framework')
                )
            );
        });
    }
);
