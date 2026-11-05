// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The installer records the skill directories it installed, and replaces or
 * removes only those. A same-named directory it skipped under --yes stays the
 * user's on every later run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
    targetKey,
    readInstalledTargets,
    namesUnder,
} from '../../lib/installedTargets.js';
import { runPostPullSync } from '../../lib/updater.js';
import { updateAiSkills } from '../../lib/aiSkills.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(HERE, '../../index.js');
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
const quietUi = () => ({
    step: () => {},
    success: () => {},
    muted: () => {},
    spacer: () => {},
    warn: () => {},
});

describe('installedTargets helpers', () => {
    it('keys a skill directory by its repository-relative POSIX path', () => {
        const repo = path.join(os.tmpdir(), 'repo');
        expect(
            targetKey(repo, path.join(repo, '.claude', 'skills', 'demo'))
        ).toBe('.claude/skills/demo');
    });

    it('returns null for a manifest without the record', () => {
        expect(readInstalledTargets({ skillHashes: {} })).toBeNull();
        expect(readInstalledTargets(null)).toBeNull();
    });

    it('lists only the names directly under one skills directory', () => {
        const repo = path.join(os.tmpdir(), 'repo');
        const installed = new Set([
            '.claude/skills/a',
            '.claude/skills/b',
            '.kiro/skills/c',
            '.claude/skills/a/nested',
        ]);
        expect([
            ...namesUnder(
                installed,
                repo,
                path.join(repo, '.claude', 'skills')
            ),
        ]).toEqual(['a', 'b']);
    });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit || process.platform === 'win32')(
    'installer --yes runs keep a skipped directory',
    () => {
        let target;
        const userFile = () =>
            path.join(
                target,
                '.claude',
                'skills',
                'testing-framework',
                'MINE.md'
            );
        const manifest = () =>
            JSON.parse(
                fs.readFileSync(
                    path.join(
                        target,
                        '.lb_workspace',
                        'config',
                        'version_manifest.json'
                    ),
                    'utf-8'
                )
            );
        const install = (...args) =>
            spawnSync(
                process.execPath,
                [INSTALLER, '--yes', '--agent', 'claude', ...args],
                { cwd: target, encoding: 'utf-8' }
            );

        beforeEach(() => {
            target = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-targets-'))
            );
            spawnSync('git', ['init', '-q', '.'], { cwd: target });
            fs.mkdirSync(path.dirname(userFile()), { recursive: true });
            fs.writeFileSync(userFile(), 'my own skill\n');
        });
        afterEach(() => {
            fs.rmSync(target, { recursive: true, force: true });
        });

        it('skips it, does not record it, and keeps it on a second run that changes the method', () => {
            const skills = ['--skills', 'testing-framework,code-guardrails'];
            const first = install('--method', 'copy', ...skills);
            expect(first.stdout + first.stderr).toContain(
                'was not installed by LaunchBridge'
            );
            expect(manifest().installedTargets).toContain(
                '.claude/skills/code-guardrails'
            );
            expect(manifest().installedTargets).not.toContain(
                '.claude/skills/testing-framework'
            );

            install('--method', 'symlink', ...skills);
            expect(fs.readFileSync(userFile(), 'utf-8')).toBe('my own skill\n');
            expect(manifest().installedTargets).not.toContain(
                '.claude/skills/testing-framework'
            );
        }, 60000);

        it('leaves its bytecode alone on a re-run that has nothing to do', () => {
            const skills = ['--skills', 'testing-framework,code-guardrails'];
            install('--method', 'copy', ...skills);
            const cache = path.join(
                path.dirname(userFile()),
                '__pycache__',
                'mine.cpython-312.pyc'
            );
            fs.mkdirSync(path.dirname(cache), { recursive: true });
            fs.writeFileSync(cache, 'x');
            install('--method', 'copy', ...skills);
            expect(fs.existsSync(cache)).toBe(true);
            expect(fs.readFileSync(userFile(), 'utf-8')).toBe('my own skill\n');
        }, 60000);

        it('leaves it in place when the skill is later deselected', () => {
            install(
                '--method',
                'copy',
                '--skills',
                'testing-framework,code-guardrails'
            );
            install('--method', 'copy', '--skills', 'code-guardrails');
            expect(fs.existsSync(userFile())).toBe(true);
        }, 60000);
    }
);

describe.skipIf(process.platform === 'win32')(
    'updater replaces only recorded skill directories',
    () => {
        let repo;
        const skillDir = (name) => path.join(repo, '.claude', 'skills', name);

        beforeEach(() => {
            repo = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-targets-upd-'))
            );
        });
        afterEach(() => {
            fs.rmSync(repo, { recursive: true, force: true });
        });

        function writeManifest(manifest) {
            const dir = path.join(repo, '.lb_workspace', 'config');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'version_manifest.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    version: '1.1.0',
                    timestamp: '2026-10-01T00:00:00.000Z',
                    installMethod: 'copy',
                    agents: ['claude'],
                    ...manifest,
                })
            );
        }

        it('re-copies a recorded skill and leaves an unrecorded same-named one', async () => {
            fs.mkdirSync(skillDir('testing-framework'), { recursive: true });
            fs.writeFileSync(
                path.join(skillDir('testing-framework'), 'MINE.md'),
                'mine\n'
            );
            fs.mkdirSync(skillDir('code-guardrails'), { recursive: true });
            writeManifest({
                skills: ['testing-framework', 'code-guardrails'],
                skillHashes: {
                    'testing-framework': 'stale',
                    'code-guardrails': 'stale',
                },
                installedTargets: ['.claude/skills/code-guardrails'],
            });

            const result = await runPostPullSync(REPO_ROOT, repo, quietUi());

            expect(
                fs.readFileSync(
                    path.join(skillDir('testing-framework'), 'MINE.md'),
                    'utf-8'
                )
            ).toBe('mine\n');
            expect(result.updatedSkills).toEqual(['code-guardrails']);
            expect(
                fs.existsSync(
                    path.join(skillDir('code-guardrails'), 'SKILL.md')
                )
            ).toBe(true);
        });

        it.skipIf(!hasAiSubmodule)(
            'does not refresh an unrecorded directory named like an AI skill',
            async () => {
                fs.mkdirSync(skillDir('ai-plan'), { recursive: true });
                fs.writeFileSync(
                    path.join(skillDir('ai-plan'), 'MINE.md'),
                    'mine\n'
                );
                const manifest = {
                    installMethod: 'copy',
                    agents: ['claude'],
                    skillHashes: { 'ai-domain-research': 'stale' },
                    installedTargets: [],
                };

                const result = await updateAiSkills(
                    REPO_ROOT,
                    repo,
                    manifest,
                    quietUi()
                );

                expect(result.updated).toEqual([]);
                expect(
                    fs.readFileSync(
                        path.join(skillDir('ai-plan'), 'MINE.md'),
                        'utf-8'
                    )
                ).toBe('mine\n');
            }
        );
    }
);
