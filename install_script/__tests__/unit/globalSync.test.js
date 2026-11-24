// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * `launchbridge update` brings a global install up to date with the updated
 * LaunchBridge clone. A copy of the source in a temporary folder stands in for
 * the clone, so its skills can change; HOME and XDG_CONFIG_HOME point at
 * temporary folders, so the user's own home is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { runGlobalSync, runInstallSyncs } from '../../lib/globalSync.js';
import {
    GLOBAL_MANIFEST,
    globalGeneratedDir,
    globalStateDir,
    readGlobalManifest,
    writeGlobalState,
} from '../../lib/stateDir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const VERIFY = path.join(
    REPO_ROOT,
    'skills',
    'lb-setup',
    'scripts',
    'verify_integrity.py'
);
const hasPython = spawnSync('python3', ['--version']).status === 0;
const isWindows = process.platform === 'win32';
const SKILLS = ['lb-setup', 'testing-framework', 'data-wrangler'];
const quietUi = () => ({
    step: () => {},
    success: () => {},
    muted: () => {},
    spacer: () => {},
    warn: () => {},
});

describe.skipIf(isWindows)('runGlobalSync', () => {
    let root;
    let home;
    let source;
    const saved = {};

    beforeEach(() => {
        root = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'lb-gsync-'))
        );
        home = path.join(root, 'home');
        fs.mkdirSync(home);
        for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
            saved[key] = process.env[key];
        }
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        process.env.XDG_CONFIG_HOME = path.join(root, 'state');

        source = path.join(root, 'launchbridge');
        for (const rel of [
            ...SKILLS.map((s) => `skills/${s}`),
            'project_dependencies/pyproject.toml',
            'project_dependencies/constraints.txt',
            'agent_steering/AGENTS.md',
            'version.txt',
        ]) {
            fs.cpSync(path.join(REPO_ROOT, rel), path.join(source, rel), {
                recursive: true,
            });
        }
    });
    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    const skillDir = (name) => path.join(home, '.claude', 'skills', name);

    /**
     * A global install of SKILLS for Claude Code: a record with no digests,
     * which the first sync treats as every skill changed and installs.
     */
    async function installGlobally(method = 'copy', manifest = {}) {
        await writeGlobalState(
            GLOBAL_MANIFEST,
            JSON.stringify({
                schemaVersion: 1,
                scope: 'global',
                version: '0.0.0',
                agents: ['claude'],
                installMethod: method,
                skills: SKILLS,
                skillHashes: {},
                installedTargets: SKILLS.map((s) => `.claude/skills/${s}`),
                ...manifest,
            })
        );
        const first = await runGlobalSync(source, quietUi(), { home });
        const recorded = (
            manifest.installedTargets ??
            SKILLS.map((s) => `.claude/skills/${s}`)
        ).map((t) => t.split('/').pop());
        expect(first.problems).toEqual([]);
        expect(first.updatedSkills.sort()).toEqual(recorded.sort());
        return first;
    }

    function verifyGlobal() {
        const repo = path.join(root, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        return spawnSync('python3', ['-I', VERIFY, '--global', repo], {
            encoding: 'utf-8',
            env: { ...process.env },
        });
    }

    it('does nothing without a global install', async () => {
        expect(
            (await runGlobalSync(source, quietUi(), { home })).skippedNoManifest
        ).toBe(true);
        expect(fs.existsSync(globalStateDir())).toBe(false);
    });

    it('installs, writes the generated files, and records the digests', async () => {
        const first = await installGlobally();
        expect(first.assetsWritten).toEqual([globalGeneratedDir()]);
        const manifest = await readGlobalManifest();
        expect(Object.keys(manifest.skillHashes).sort()).toEqual(
            [...SKILLS].sort()
        );
        expect(Object.keys(manifest.generatedAssets)).toHaveLength(5);
        expect(manifest.sourcePath).toBe(source);
        // Read from the source's version.txt, replacing the old record's.
        expect(manifest.version).not.toBe('0.0.0');
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
        if (hasPython) {
            const check = verifyGlobal();
            expect(check.status, check.stdout + check.stderr).toBe(0);
        }
    });

    it('changes nothing when the source did not change', async () => {
        await installGlobally();
        const skillMd = path.join(skillDir('testing-framework'), 'SKILL.md');
        const before = fs.statSync(skillMd).mtimeMs;

        const again = await runGlobalSync(source, quietUi(), { home });

        expect(again.changedSkills).toEqual([]);
        expect(again.updatedSkills).toEqual([]);
        expect(again.assetsWritten).toEqual([]);
        expect(fs.statSync(skillMd).mtimeMs).toBe(before);
    });

    it('installs a changed skill again in a copy install, and the check passes', async () => {
        await installGlobally('copy');
        const changed = path.join(
            source,
            'skills',
            'testing-framework',
            'SKILL.md'
        );
        fs.appendFileSync(changed, '\nA new instruction.\n');

        const result = await runGlobalSync(source, quietUi(), { home });

        expect(result.changedSkills).toEqual(['testing-framework']);
        expect(result.updatedSkills).toEqual(['testing-framework']);
        expect(
            fs.readFileSync(
                path.join(skillDir('testing-framework'), 'SKILL.md'),
                'utf8'
            )
        ).toContain('A new instruction.');
        if (hasPython) {
            const check = verifyGlobal();
            expect(check.status, check.stdout + check.stderr).toBe(0);
        }
    });

    it('shows a file a skill gained through its link in a symlink install, installing nothing', async () => {
        await installGlobally('symlink');
        const linked = skillDir('testing-framework');
        expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
        const inode = fs.lstatSync(linked).ino;
        const added = path.join(
            source,
            'skills',
            'testing-framework',
            'references',
            'added.md'
        );
        fs.mkdirSync(path.dirname(added), { recursive: true });
        fs.writeFileSync(added, '# added\n');

        const result = await runGlobalSync(source, quietUi(), { home });

        expect(result.changedSkills).toEqual(['testing-framework']);
        expect(result.updatedSkills).toEqual([]);
        expect(fs.lstatSync(linked).ino).toBe(inode);
        expect(
            fs.readFileSync(path.join(linked, 'references', 'added.md'), 'utf8')
        ).toBe('# added\n');
        // lb-setup's generated files are real files beside the record, and
        // nothing was written into the source.
        expect(
            fs
                .lstatSync(path.join(globalGeneratedDir(), 'setup_status.md'))
                .isFile()
        ).toBe(true);
        expect(
            fs.existsSync(path.join(source, 'skills', 'lb-setup', 'assets'))
        ).toBe(false);
        if (hasPython) {
            const check = verifyGlobal();
            expect(check.status, check.stdout + check.stderr).toBe(0);
        }
    });

    it('links again a skill folder an older symlink install made of per-file links', async () => {
        await installGlobally('symlink');
        const dir = skillDir('testing-framework');
        const from = path.join(source, 'skills', 'testing-framework');
        fs.unlinkSync(dir);
        fs.mkdirSync(dir);
        fs.symlinkSync(path.join(from, 'SKILL.md'), path.join(dir, 'SKILL.md'));

        const result = await runGlobalSync(source, quietUi(), { home });

        expect(result.problems).toEqual([]);
        expect(result.updatedSkills).toEqual(['testing-framework']);
        expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(dir)).toBe(from);
        expect(fs.existsSync(path.join(from, 'SKILL.md'))).toBe(true);
    });

    it('regenerates the files lb-setup needs when the frozen constraints change', async () => {
        await installGlobally();
        const before = (await readGlobalManifest()).generatedAssets;
        fs.appendFileSync(
            path.join(source, 'project_dependencies', 'constraints.txt'),
            'example-package==1.0.0\n'
        );

        const result = await runGlobalSync(source, quietUi(), { home });

        expect(result.assetsWritten).toEqual([globalGeneratedDir()]);
        const after = (await readGlobalManifest()).generatedAssets;
        expect(after['python_deps/constraints.txt']).not.toBe(
            before['python_deps/constraints.txt']
        );
        expect(
            fs.readFileSync(
                path.join(
                    globalGeneratedDir(),
                    'python_deps',
                    'constraints.txt'
                ),
                'utf8'
            )
        ).toContain('example-package==1.0.0');
        if (hasPython) {
            const check = verifyGlobal();
            expect(check.status, check.stdout + check.stderr).toBe(0);
        }
    });

    it('leaves a folder the record does not list alone', async () => {
        await installGlobally('copy', {
            installedTargets: ['.claude/skills/lb-setup'],
        });
        // The first sync installed only what the record lists.
        expect(fs.existsSync(skillDir('testing-framework'))).toBe(false);
        fs.mkdirSync(skillDir('testing-framework'));
        fs.writeFileSync(
            path.join(skillDir('testing-framework'), 'MINE.md'),
            'mine\n'
        );
        fs.appendFileSync(
            path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
            'x\n'
        );

        await runGlobalSync(source, quietUi(), { home });

        expect(fs.readdirSync(skillDir('testing-framework'))).toEqual([
            'MINE.md',
        ]);
    });

    it('runs from a folder with no local install', async () => {
        await installGlobally();
        const cwd = path.join(root, 'somewhere');
        fs.mkdirSync(cwd);
        fs.appendFileSync(
            path.join(source, 'skills', 'data-wrangler', 'SKILL.md'),
            'x\n'
        );

        const syncs = await runInstallSyncs(source, cwd, quietUi(), { home });

        expect(syncs.global.updatedSkills).toEqual(['data-wrangler']);
        expect(syncs.localSkipped).toBeNull();
        expect(syncs.local.skippedNoManifest).toBe(true);
        expect(fs.readdirSync(cwd)).toEqual([]);
    });

    it('still updates the global install when the local one is refused', async () => {
        await installGlobally();
        const cwd = path.join(root, 'repo-with-link');
        fs.mkdirSync(cwd);
        fs.mkdirSync(path.join(root, 'elsewhere'));
        fs.symlinkSync(
            path.join(root, 'elsewhere'),
            path.join(cwd, '.lb_workspace')
        );
        fs.appendFileSync(
            path.join(source, 'skills', 'data-wrangler', 'SKILL.md'),
            'x\n'
        );

        const syncs = await runInstallSyncs(source, cwd, quietUi(), { home });

        expect(syncs.global.updatedSkills).toEqual(['data-wrangler']);
        expect(syncs.local).toBeNull();
        expect(syncs.localSkipped).toContain('is a symlink');
        expect(fs.readdirSync(path.join(root, 'elsewhere'))).toEqual([]);
    });
});
