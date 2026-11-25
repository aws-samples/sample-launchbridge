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
import {
    runGlobalSync,
    runInstallSyncs,
    syncsIncomplete,
} from '../../lib/globalSync.js';
import {
    GLOBAL_MANIFEST,
    globalGeneratedDir,
    globalStateDir,
    readGlobalManifest,
    writeGlobalState,
} from '../../lib/stateDir.js';
import { getSkillsDir } from '../../lib/agentConfig.js';
import { writeGlobalAssets } from '../../lib/globalAssets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const VERIFY = path.join(
    REPO_ROOT,
    'skills',
    'lb-setup',
    'scripts',
    'verify_integrity.py'
);
const PYTHON = process.env.LB_TEST_PYTHON;
const hasPython = Boolean(PYTHON);
const hasGit = spawnSync('git', ['--version']).status === 0;
const isWindows = process.platform === 'win32';
// Permissions do not stop root, so a folder can't be made unwritable.
const isRoot = process.getuid?.() === 0;
const SKILLS = ['lb-setup', 'testing-framework', 'data-wrangler'];
const quietUi = () => ({
    step: () => {},
    success: () => {},
    muted: () => {},
    spacer: () => {},
    warn: () => {},
});
/** A ui that keeps what it was asked to print. */
function recordingUi() {
    const lines = { warn: [], muted: [], success: [] };
    return {
        lines,
        ui: {
            ...quietUi(),
            warn: (m) => lines.warn.push(m),
            muted: (m) => lines.muted.push(m),
            success: (m) => lines.success.push(m),
        },
    };
}

function git(cwd, ...args) {
    const result = spawnSync(
        'git',
        [
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@example.invalid',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'protocol.file.allow=always',
            ...args,
        ],
        { cwd, encoding: 'utf-8' }
    );
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

/** Every agent's recorded folder for every skill. */
function targetsFor(agents, skills) {
    return agents.flatMap((agent) =>
        skills.map((skill) => `.${agent}/skills/${skill}`)
    );
}

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
     * and the agents' empty skills folders, which the first sync treats as
     * every skill changed and missing, and installs.
     */
    async function installGlobally(method = 'copy', manifest = {}) {
        const record = {
            schemaVersion: 1,
            scope: 'global',
            version: '0.0.0',
            agents: ['claude'],
            installMethod: method,
            skills: SKILLS,
            skillHashes: {},
            installedTargets: SKILLS.map((s) => `.claude/skills/${s}`),
            ...manifest,
        };
        await writeGlobalState(GLOBAL_MANIFEST, JSON.stringify(record));
        for (const agent of record.agents) {
            fs.mkdirSync(
                path.join(home, ...getSkillsDir(agent, 'global').split('/')),
                { recursive: true }
            );
        }
        const first = await runGlobalSync(source, quietUi(), { home });
        const recorded = new Set(
            (
                manifest.installedTargets ??
                SKILLS.map((s) => `.claude/skills/${s}`)
            ).map((t) => t.split('/').pop())
        );
        expect(first.problems).toEqual([]);
        expect(first.updatedSkills.sort()).toEqual([...recorded].sort());
        return first;
    }

    /**
     * An AI skill in the source's ai-skills submodule folder. It runs only
     * when invoked by name, so every agent but Claude Code gets its own
     * SKILL.md.
     */
    function aiSkill(name) {
        const dir = path.join(
            source,
            'project_dependencies',
            'ai-skills',
            'skills',
            'research',
            name
        );
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'SKILL.md'),
            `---\nname: ${name}\ndescription: "${name} test skill"\ndisable-model-invocation: true\n---\n# ${name}\n`
        );
        return dir;
    }

    /** Makes the source a git clone with everything committed. */
    function commitSource() {
        fs.writeFileSync(
            path.join(source, '.gitignore'),
            'build/\n__pycache__/\n*.pyc\n'
        );
        git(root, 'init', '-q', '-b', 'main', source);
        git(source, 'add', '-A');
        git(source, 'commit', '-q', '-m', 'source');
    }

    const record = () => readGlobalManifest();
    const stateFile = (name) =>
        fs.readFileSync(path.join(globalStateDir(), name), 'utf8');

    function verifyGlobal() {
        const repo = path.join(root, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        return spawnSync(PYTHON, ['-I', VERIFY, '--global', repo], {
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

    it('keeps the recorded digests of generated files it could not write, and writes them next time', async () => {
        await installGlobally();
        const before = await record();
        const reference = path.join(
            globalGeneratedDir(),
            'lb_agents_reference.md'
        );
        const writtenBefore = fs.readFileSync(reference);
        fs.appendFileSync(
            path.join(source, 'project_dependencies', 'constraints.txt'),
            'example-package==1.0.0\n'
        );
        fs.appendFileSync(
            path.join(source, 'agent_steering', 'AGENTS.md'),
            '\nA new instruction.\n'
        );
        // The new files can't be renamed into place, as when a scanner on
        // Windows has one of them open.
        const writeAssets = (assets) =>
            writeGlobalAssets(assets, globalGeneratedDir(), {
                rename: async (from, to) => {
                    if (to === globalGeneratedDir() && from.endsWith('.tmp')) {
                        throw Object.assign(
                            new Error('EPERM: operation not permitted, rename'),
                            { code: 'EPERM' }
                        );
                    }
                    return fs.promises.rename(from, to);
                },
            });

        const result = await runGlobalSync(source, quietUi(), {
            home,
            writeAssets,
        });

        expect(result.assetsWritten).toEqual([]);
        expect(result.problems.join('\n')).toContain(
            'Could not write the files lb-setup needs'
        );
        // The generated files are still the ones the record lists.
        expect(fs.readFileSync(reference)).toEqual(writtenBefore);
        const kept = await record();
        expect(kept.generatedAssets).toEqual(before.generatedAssets);
        expect(kept.generatedPyprojectHash).toBe(before.generatedPyprojectHash);
        // What lb-setup records a repository was set up with must be
        // what the generated files hold.
        expect(kept.agentsHash).toBe(before.agentsHash);
        expect(kept.pyprojectHash).toBe(before.pyprojectHash);

        const retry = await runGlobalSync(source, quietUi(), { home });

        expect(retry.problems).toEqual([]);
        expect(retry.assetsWritten).toEqual([globalGeneratedDir()]);
        const written = await record();
        expect(written.generatedAssets['python_deps/constraints.txt']).not.toBe(
            before.generatedAssets['python_deps/constraints.txt']
        );
        expect(written.agentsHash).not.toBe(before.agentsHash);
        expect(written.pyprojectHash).not.toBe(before.pyprojectHash);
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

    it.skipIf(isRoot)(
        'keeps the digest of a skill it could not copy again, and the next update tries again',
        async () => {
            await installGlobally('copy');
            const before = (await record()).skillHashes['testing-framework'];
            fs.appendFileSync(
                path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
                '\nA new instruction.\n'
            );
            const locked = skillDir('testing-framework');
            fs.chmodSync(locked, 0o555);
            const { ui, lines } = recordingUi();
            let result;
            try {
                result = await runGlobalSync(source, ui, { home });
            } finally {
                fs.chmodSync(locked, 0o755);
            }

            expect(result.changedSkills).toEqual(['testing-framework']);
            expect(result.updatedSkills).toEqual([]);
            expect(result.problems).toHaveLength(1);
            expect(result.problems[0]).toContain(`Could not update ${locked}`);
            expect((await record()).skillHashes['testing-framework']).toBe(
                before
            );
            expect(lines.muted.join('\n')).not.toContain('already up to date');
            expect(lines.success).toEqual([]);

            const retry = await runGlobalSync(source, quietUi(), { home });

            expect(retry.problems).toEqual([]);
            expect(retry.updatedSkills).toEqual(['testing-framework']);
            expect(
                fs.readFileSync(path.join(locked, 'SKILL.md'), 'utf8')
            ).toContain('A new instruction.');
            expect((await record()).skillHashes['testing-framework']).not.toBe(
                before
            );
            if (hasPython) {
                const check = verifyGlobal();
                expect(check.status, check.stdout + check.stderr).toBe(0);
            }
        }
    );

    for (const method of ['copy', 'symlink']) {
        it(`installs again a recorded skill folder that is gone, unchanged or not (${method})`, async () => {
            await installGlobally(method);
            fs.rmSync(skillDir('data-wrangler'), {
                recursive: true,
                force: true,
            });

            const result = await runGlobalSync(source, quietUi(), { home });

            expect(result.changedSkills).toEqual([]);
            expect(result.updatedSkills).toEqual(['data-wrangler']);
            expect(
                fs.existsSync(path.join(skillDir('data-wrangler'), 'SKILL.md'))
            ).toBe(true);
            if (hasPython) {
                const check = verifyGlobal();
                expect(check.status, check.stdout + check.stderr).toBe(0);
            }
        });
    }

    it('leaves a copy edited since it was installed as it is, and says how to reinstall it', async () => {
        await installGlobally('copy');
        const skillMd = path.join(skillDir('testing-framework'), 'SKILL.md');
        fs.appendFileSync(skillMd, '\nMy own note.\n');
        const { ui, lines } = recordingUi();

        const result = await runGlobalSync(source, ui, { home });

        expect(result.modifiedTargets).toEqual([skillDir('testing-framework')]);
        expect(result.updatedSkills).toEqual([]);
        expect(result.problems).toEqual([]);
        expect(fs.readFileSync(skillMd, 'utf8')).toContain('My own note.');
        expect(lines.warn.join('\n')).toContain(
            `${skillDir('testing-framework')} differs from what LaunchBridge installed, so it was left as it is. To install it again, run 'launchbridge' and choose Global.`
        );
        expect(lines.muted.join('\n')).not.toContain('already up to date');
    });

    it('leaves a real folder in place of a link, and per-file links beside a file of the user’s, as they are', async () => {
        await installGlobally('symlink');
        const copied = skillDir('testing-framework');
        fs.unlinkSync(copied);
        fs.cpSync(path.join(source, 'skills', 'testing-framework'), copied, {
            recursive: true,
        });
        fs.writeFileSync(path.join(copied, 'MY_RULES.md'), 'mine\n');
        const perFile = skillDir('data-wrangler');
        fs.unlinkSync(perFile);
        fs.mkdirSync(perFile);
        fs.symlinkSync(
            path.join(source, 'skills', 'data-wrangler', 'SKILL.md'),
            path.join(perFile, 'SKILL.md')
        );
        fs.writeFileSync(path.join(perFile, 'notes.md'), 'mine\n');
        const { ui, lines } = recordingUi();

        const result = await runGlobalSync(source, ui, { home });

        expect(result.modifiedTargets.sort()).toEqual([perFile, copied].sort());
        expect(result.updatedSkills).toEqual([]);
        expect(result.problems).toEqual([]);
        expect(fs.readFileSync(path.join(copied, 'MY_RULES.md'), 'utf8')).toBe(
            'mine\n'
        );
        expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(perFile, 'notes.md'), 'utf8')).toBe(
            'mine\n'
        );
        const warned = lines.warn.join('\n');
        expect(warned).toContain(
            `${perFile} is not a link to the LaunchBridge source and holds files LaunchBridge did not install (notes.md), so it was left as it is. To replace it with a link, run 'launchbridge' and choose Global.`
        );
        expect(warned).toContain(
            `${copied} is a folder, not a link to the LaunchBridge source, so it was left as it is. To replace it with a link, run 'launchbridge' and choose Global.`
        );
        expect(warned).not.toContain('SKILL.md');
    });

    it('changes nothing when run from a clone other than the one the global install came from', async () => {
        await installGlobally('symlink');
        const other = path.join(root, 'other-clone');
        fs.cpSync(source, other, { recursive: true });
        fs.appendFileSync(
            path.join(other, 'skills', 'testing-framework', 'SKILL.md'),
            'x\n'
        );
        const manifestBefore = stateFile(GLOBAL_MANIFEST);
        const sourceBefore = stateFile('install_source.json');
        const { ui, lines } = recordingUi();

        const result = await runGlobalSync(other, ui, { home });

        expect(result.skippedOtherSource).toBe(source);
        expect(result.problems).toEqual([]);
        expect(result.updatedSkills).toEqual([]);
        expect(stateFile(GLOBAL_MANIFEST)).toBe(manifestBefore);
        expect(stateFile('install_source.json')).toBe(sourceBefore);
        expect(fs.realpathSync(skillDir('testing-framework'))).toBe(
            path.join(source, 'skills', 'testing-framework')
        );
        expect(lines.warn.join('\n')).toContain(
            `The global install came from ${source}, not from this clone (${other}), so it was left as it is. Run 'launchbridge update' from that clone, or run 'launchbridge' from this one and choose Global to move the global install here.`
        );

        // The clone it came from is gone.
        fs.renameSync(source, path.join(root, 'moved-away'));
        const gone = recordingUi();
        const again = await runGlobalSync(other, gone.ui, { home });

        expect(again.skippedOtherSource).toBe(source);
        expect(stateFile(GLOBAL_MANIFEST)).toBe(manifestBefore);
        expect(gone.lines.warn.join('\n')).toContain(
            `The global install came from ${source}, which no longer exists, so it was left as it is. To move the global install to this clone, run 'launchbridge' from it and choose Global.`
        );
        expect(gone.lines.warn.join('\n')).not.toContain('launchbridge update');
    });

    it.skipIf(!hasGit)(
        'keeps skills the clone has changes to that are not committed at their recorded version',
        async () => {
            commitSource();
            await installGlobally('copy');
            const before = (await record()).skillHashes;
            fs.appendFileSync(
                path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
                '\nAn uncommitted instruction.\n'
            );
            fs.writeFileSync(
                path.join(source, 'skills', 'data-wrangler', 'notes.md'),
                'untracked\n'
            );
            const ignored = path.join(source, 'skills', 'lb-setup', 'build');
            fs.mkdirSync(ignored);
            fs.writeFileSync(path.join(ignored, 'out.txt'), 'ignored\n');
            const { ui, lines } = recordingUi();

            const result = await runGlobalSync(source, ui, { home });

            expect(result.heldBack.sort()).toEqual([...SKILLS].sort());
            expect(result.updatedSkills).toEqual([]);
            expect(result.problems).toEqual([]);
            expect((await record()).skillHashes).toEqual(before);
            expect(
                fs.readFileSync(
                    path.join(skillDir('testing-framework'), 'SKILL.md'),
                    'utf8'
                )
            ).not.toContain('An uncommitted instruction.');
            expect(
                fs.existsSync(path.join(skillDir('data-wrangler'), 'notes.md'))
            ).toBe(false);
            expect(
                fs.existsSync(path.join(skillDir('lb-setup'), 'build'))
            ).toBe(false);
            const warned = lines.warn.join('\n');
            expect(warned).toContain(
                `Kept testing-framework at the version the global install recorded: the LaunchBridge clone has changes to it that are not committed (skills/testing-framework/SKILL.md). Commit or discard them (git -C "${source}" status), or run 'launchbridge' and choose Global to install testing-framework as it is now.`
            );
            expect(warned).toContain('(skills/data-wrangler/notes.md)');
            expect(warned).toContain('(skills/lb-setup/build/)');
            expect(lines.muted.join('\n')).not.toContain('already up to date');
            if (hasPython) {
                const check = verifyGlobal();
                expect(check.status, check.stdout + check.stderr).toBe(0);
            }

            // Committed (and the build output removed), they are installed.
            git(source, 'add', '-A');
            git(source, 'commit', '-q', '-m', 'reviewed');
            fs.rmSync(ignored, { recursive: true });
            const after = await runGlobalSync(source, quietUi(), { home });

            expect(after.heldBack).toEqual([]);
            expect(after.updatedSkills.sort()).toEqual(
                ['data-wrangler', 'testing-framework'].sort()
            );
            expect(
                fs.readFileSync(
                    path.join(skillDir('testing-framework'), 'SKILL.md'),
                    'utf8'
                )
            ).toContain('An uncommitted instruction.');
        }
    );

    it.skipIf(!hasGit)(
        'records no digest from uncommitted changes in a symlink install either',
        async () => {
            commitSource();
            await installGlobally('symlink');
            const before = (await record()).skillHashes;
            fs.appendFileSync(
                path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
                '\nAn uncommitted instruction.\n'
            );

            const result = await runGlobalSync(source, quietUi(), { home });

            expect(result.heldBack).toEqual(['testing-framework']);
            expect((await record()).skillHashes).toEqual(before);
        }
    );

    it.skipIf(!hasGit)(
        'does not link a skill again while the clone has uncommitted changes to it, and says its links show them',
        async () => {
            commitSource();
            const agents = ['claude', 'kiro'];
            await installGlobally('symlink', {
                agents,
                installedTargets: targetsFor(agents, SKILLS),
            });
            fs.appendFileSync(
                path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
                '\nAn uncommitted instruction.\n'
            );
            const kiro = path.join(
                home,
                '.kiro',
                'skills',
                'testing-framework'
            );
            fs.unlinkSync(kiro);
            const { ui, lines } = recordingUi();

            const result = await runGlobalSync(source, ui, { home });

            expect(result.heldBack).toEqual(['testing-framework']);
            expect(result.updatedSkills).toEqual([]);
            expect(fs.existsSync(kiro)).toBe(false);
            expect(lines.warn).toContain(
                `  testing-framework's links show changes the LaunchBridge clone has not committed (skills/testing-framework/SKILL.md), so agents load them now; the global install keeps the digest it recorded, so lb-setup's integrity check reports testing-framework until they are committed or discarded. Its missing folders were not installed again. Commit or discard them (git -C "${source}" status), or run 'launchbridge' and choose Global to install testing-framework as it is now.`
            );

            fs.unlinkSync(skillDir('testing-framework'));
            const gone = recordingUi();
            await runGlobalSync(source, gone.ui, { home });

            expect(fs.existsSync(skillDir('testing-framework'))).toBe(false);
            expect(gone.lines.warn).toContain(
                `  Did not install testing-framework again: the LaunchBridge clone has changes to it that are not committed (skills/testing-framework/SKILL.md). Commit or discard them (git -C "${source}" status), or run 'launchbridge' and choose Global to install testing-framework as it is now.`
            );
        }
    );

    it('takes nothing from the clone when git can’t tell what it has not committed', async () => {
        await installGlobally('copy');
        const before = await record();
        fs.appendFileSync(
            path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
            '\nA change.\n'
        );
        fs.appendFileSync(
            path.join(source, 'agent_steering', 'AGENTS.md'),
            '\nA change.\n'
        );
        const failing = async () => {
            throw new Error('fatal: detected dubious ownership');
        };

        const result = await runGlobalSync(source, quietUi(), {
            home,
            uncommitted: failing,
        });

        expect(result.heldBack).toEqual(['testing-framework']);
        expect(result.updatedSkills).toEqual([]);
        expect(result.assetsWritten).toEqual([]);
        expect(result.problems).toEqual([
            'Could not check the LaunchBridge clone for changes that are not committed (fatal: detected dubious ownership), so these skills were not updated and keep the digests the global install recorded: testing-framework.',
            'Could not check the LaunchBridge clone for changes that are not committed (fatal: detected dubious ownership), so the files lb-setup prepares repositories from were not built again.',
        ]);
        const kept = await record();
        expect(kept.skillHashes).toEqual(before.skillHashes);
        expect(kept.agentsHash).toBe(before.agentsHash);
        expect(kept.generatedAssets).toEqual(before.generatedAssets);
        expect(
            fs.readFileSync(
                path.join(skillDir('testing-framework'), 'SKILL.md'),
                'utf8'
            )
        ).not.toContain('A change.');
    });

    it.skipIf(!hasGit)(
        'keeps the generated files and their digests while the files they are built from have uncommitted changes',
        async () => {
            commitSource();
            await installGlobally('symlink');
            const before = await record();
            const reference = path.join(
                globalGeneratedDir(),
                'lb_agents_reference.md'
            );
            const referenceBefore = fs.readFileSync(reference, 'utf8');
            fs.appendFileSync(
                path.join(source, 'agent_steering', 'AGENTS.md'),
                '\nAn uncommitted instruction.\n'
            );
            fs.appendFileSync(
                path.join(source, 'project_dependencies', 'constraints.txt'),
                'injected-package==6.6.6\n'
            );
            const { ui, lines } = recordingUi();

            const result = await runGlobalSync(source, ui, { home });

            expect(result.heldBackSources).toEqual([
                'agent_steering/AGENTS.md',
                'project_dependencies/constraints.txt',
            ]);
            expect(result.assetsWritten).toEqual([]);
            expect(result.problems).toEqual([]);
            const kept = await record();
            for (const field of [
                'agentsHash',
                'pyprojectHash',
                'generatedPyprojectHash',
                'generatedAssets',
            ]) {
                expect(kept[field]).toEqual(before[field]);
            }
            expect(fs.readFileSync(reference, 'utf8')).toBe(referenceBefore);
            expect(
                fs.readFileSync(
                    path.join(
                        globalGeneratedDir(),
                        'python_deps',
                        'constraints.txt'
                    ),
                    'utf8'
                )
            ).not.toContain('injected-package');
            expect(lines.warn).toContain(
                `  Kept the files lb-setup prepares repositories from at the version the global install recorded: the LaunchBridge clone has changes to the files they are built from that are not committed (agent_steering/AGENTS.md, project_dependencies/constraints.txt). Commit or discard them (git -C "${source}" status), or run 'launchbridge' and choose Global to use them as they are now.`
            );
            expect(lines.muted.join('\n')).not.toContain('already up to date');
            if (hasPython) {
                const check = verifyGlobal();
                expect(check.status, check.stdout + check.stderr).toBe(0);
            }

            git(source, 'add', '-A');
            git(source, 'commit', '-q', '-m', 'reviewed');
            const after = await runGlobalSync(source, quietUi(), { home });

            expect(after.heldBackSources).toEqual([]);
            expect(after.assetsWritten).toEqual([globalGeneratedDir()]);
            expect((await record()).agentsHash).not.toBe(before.agentsHash);
            expect(fs.readFileSync(reference, 'utf8')).toContain(
                'An uncommitted instruction.'
            );
        }
    );

    it('copies a changed skill again only where its copy still holds what LaunchBridge installed', async () => {
        const agents = ['claude', 'kiro'];
        await installGlobally('copy', {
            agents,
            installedTargets: targetsFor(agents, SKILLS),
        });
        const kiro = path.join(home, '.kiro', 'skills', 'testing-framework');
        fs.writeFileSync(path.join(kiro, 'MY_NOTES.md'), 'mine\n');
        fs.appendFileSync(
            path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
            '\nA new step.\n'
        );
        const { ui, lines } = recordingUi();

        const result = await runGlobalSync(source, ui, { home });

        expect(result.updatedSkills).toEqual(['testing-framework']);
        expect(result.modifiedTargets).toEqual([kiro]);
        expect(result.problems).toEqual([]);
        expect(fs.readFileSync(path.join(kiro, 'MY_NOTES.md'), 'utf8')).toBe(
            'mine\n'
        );
        expect(
            fs.readFileSync(path.join(kiro, 'SKILL.md'), 'utf8')
        ).not.toContain('A new step.');
        expect(
            fs.readFileSync(
                path.join(skillDir('testing-framework'), 'SKILL.md'),
                'utf8'
            )
        ).toContain('A new step.');
        expect(lines.warn).toContain(
            `  ${kiro} differs from what LaunchBridge installed, so it was left as it is and the update to testing-framework was not copied into it. To install it again, run 'launchbridge' and choose Global.`
        );
    });

    it('does not make a skills folder that is gone as a whole again', async () => {
        const agents = ['claude', 'kiro'];
        await installGlobally('copy', {
            agents,
            installedTargets: targetsFor(agents, SKILLS),
        });
        fs.rmSync(path.join(home, '.kiro'), { recursive: true });
        fs.appendFileSync(
            path.join(source, 'skills', 'testing-framework', 'SKILL.md'),
            '\nA new step.\n'
        );
        const { ui, lines } = recordingUi();

        const result = await runGlobalSync(source, ui, { home });

        const kiroSkills = path.join(home, '.kiro', 'skills');
        expect(fs.existsSync(path.join(home, '.kiro'))).toBe(false);
        expect(result.missingFolders).toEqual([kiroSkills]);
        expect(result.updatedSkills).toEqual(['testing-framework']);
        expect(result.problems).toEqual([]);
        expect(lines.warn).toContain(
            `  ${kiroSkills} is gone, so the skills LaunchBridge installed there were not installed again (data-wrangler, lb-setup, testing-framework). To install them there again, run 'launchbridge' and choose Global.`
        );
        expect(lines.muted.join('\n')).not.toContain('already up to date');
    });

    describe('AI skills', () => {
        const AGENTS_BOTH = ['claude', 'kiro'];
        const ALL = [...SKILLS, 'ai-plan'];
        const claudePlan = () =>
            path.join(home, '.claude', 'skills', 'ai-plan');
        const kiroPlan = () => path.join(home, '.kiro', 'skills', 'ai-plan');

        async function installWithAi(method) {
            const plan = aiSkill('ai-plan');
            await installGlobally(method, {
                agents: AGENTS_BOTH,
                skills: ALL,
                installedTargets: targetsFor(AGENTS_BOTH, ALL),
            });
            return plan;
        }

        it('installs a link for Claude Code and a copy with its own SKILL.md for Kiro, and copies Kiro’s again when the skill changes', async () => {
            const plan = await installWithAi('symlink');
            expect(fs.lstatSync(claudePlan()).isSymbolicLink()).toBe(true);
            expect(fs.realpathSync(claudePlan())).toBe(plan);
            expect(fs.lstatSync(kiroPlan()).isSymbolicLink()).toBe(false);
            expect(
                fs.readFileSync(path.join(kiroPlan(), 'SKILL.md'), 'utf8')
            ).toContain('## Invocation');
            const first = await record();
            expect(Object.keys(first.externalSkillHashes).sort()).toEqual([
                'claude/ai-plan',
                'kiro/ai-plan',
            ]);
            if (hasPython) {
                const check = verifyGlobal();
                expect(check.status, check.stdout + check.stderr).toBe(0);
            }

            fs.appendFileSync(path.join(plan, 'SKILL.md'), 'A new step.\n');
            const result = await runGlobalSync(source, quietUi(), { home });

            expect(result.problems).toEqual([]);
            expect(result.updatedSkills).toEqual(['ai-plan']);
            expect(
                fs.readFileSync(path.join(kiroPlan(), 'SKILL.md'), 'utf8')
            ).toContain('A new step.');
            const second = await record();
            for (const key of ['claude/ai-plan', 'kiro/ai-plan']) {
                expect(second.externalSkillHashes[key]).not.toBe(
                    first.externalSkillHashes[key]
                );
            }
            if (hasPython) {
                const check = verifyGlobal();
                expect(check.status, check.stdout + check.stderr).toBe(0);
            }
        });

        it('copies a changed AI skill again for every agent in a copy install', async () => {
            const plan = await installWithAi('copy');
            expect(fs.lstatSync(claudePlan()).isSymbolicLink()).toBe(false);
            fs.appendFileSync(path.join(plan, 'SKILL.md'), 'A new step.\n');

            const result = await runGlobalSync(source, quietUi(), { home });

            expect(result.problems).toEqual([]);
            expect(result.updatedSkills).toEqual(['ai-plan']);
            for (const dir of [claudePlan(), kiroPlan()]) {
                expect(
                    fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
                ).toContain('A new step.');
            }
            if (hasPython) {
                const check = verifyGlobal();
                expect(check.status, check.stdout + check.stderr).toBe(0);
            }
        });

        it.skipIf(isRoot)(
            'keeps the digests of an AI skill it could not copy again for Kiro, and the next update tries again',
            async () => {
                const plan = await installWithAi('symlink');
                const before = await record();
                fs.appendFileSync(path.join(plan, 'SKILL.md'), 'A new step.\n');
                fs.chmodSync(kiroPlan(), 0o555);
                const { ui, lines } = recordingUi();
                let result;
                try {
                    result = await runGlobalSync(source, ui, { home });
                } finally {
                    fs.chmodSync(kiroPlan(), 0o755);
                }

                expect(result.problems.join('\n')).toContain(
                    'Could not update AI skill ai-plan for kiro'
                );
                const kept = await record();
                expect(kept.externalSkillHashes['kiro/ai-plan']).toBe(
                    before.externalSkillHashes['kiro/ai-plan']
                );
                expect(kept.skillHashes['ai-domain-research']).toBe(
                    before.skillHashes['ai-domain-research']
                );
                // Claude Code's link already shows the change.
                expect(kept.externalSkillHashes['claude/ai-plan']).not.toBe(
                    before.externalSkillHashes['claude/ai-plan']
                );
                expect(lines.muted.join('\n')).not.toContain(
                    'already up to date'
                );

                const retry = await runGlobalSync(source, quietUi(), { home });

                expect(retry.problems).toEqual([]);
                expect(retry.updatedSkills).toEqual(['ai-plan']);
                expect(
                    fs.readFileSync(path.join(kiroPlan(), 'SKILL.md'), 'utf8')
                ).toContain('A new step.');
                if (hasPython) {
                    const check = verifyGlobal();
                    expect(check.status, check.stdout + check.stderr).toBe(0);
                }
            }
        );

        it.skipIf(!hasGit)(
            'keeps an AI skill the submodule has uncommitted changes to at its recorded version',
            async () => {
                // The ai-skills folder is a submodule of the clone.
                const lib = path.join(root, 'ai-skills');
                const planInLib = path.join(
                    lib,
                    'skills',
                    'research',
                    'ai-plan'
                );
                fs.mkdirSync(planInLib, { recursive: true });
                fs.writeFileSync(
                    path.join(planInLib, 'SKILL.md'),
                    '---\nname: ai-plan\ndescription: "ai-plan test skill"\ndisable-model-invocation: true\n---\n# ai-plan\n'
                );
                git(root, 'init', '-q', '-b', 'main', lib);
                git(lib, 'add', '-A');
                git(lib, 'commit', '-q', '-m', 'ai-skills');
                commitSource();
                git(
                    source,
                    'submodule',
                    'add',
                    '-q',
                    lib,
                    'project_dependencies/ai-skills'
                );
                git(source, 'commit', '-q', '-m', 'add ai-skills');
                const plan = path.join(
                    source,
                    'project_dependencies',
                    'ai-skills',
                    'skills',
                    'research',
                    'ai-plan'
                );
                await installGlobally('copy', {
                    agents: AGENTS_BOTH,
                    skills: ALL,
                    installedTargets: targetsFor(AGENTS_BOTH, ALL),
                });
                const before = await record();
                fs.appendFileSync(
                    path.join(plan, 'SKILL.md'),
                    'An uncommitted step.\n'
                );
                const { ui, lines } = recordingUi();

                const result = await runGlobalSync(source, ui, { home });

                expect(result.heldBack).toEqual(['ai-plan']);
                expect(result.updatedSkills).toEqual([]);
                const kept = await record();
                expect(kept.skillHashes).toEqual(before.skillHashes);
                expect(kept.externalSkillHashes).toEqual(
                    before.externalSkillHashes
                );
                for (const dir of [claudePlan(), kiroPlan()]) {
                    expect(
                        fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
                    ).not.toContain('An uncommitted step.');
                }
                expect(lines.warn.join('\n')).toContain(
                    'Kept ai-plan at the version the global install recorded: the LaunchBridge clone has changes to it that are not committed (project_dependencies/ai-skills/skills/research/ai-plan/SKILL.md).'
                );
                if (hasPython) {
                    const check = verifyGlobal();
                    expect(check.status, check.stdout + check.stderr).toBe(0);
                }

                // Committed in the submodule only: the clone does not record it.
                git(plan, 'commit', '-q', '-am', 'ahead');
                const ahead = recordingUi();
                const stillHeld = await runGlobalSync(source, ahead.ui, {
                    home,
                });
                expect(stillHeld.heldBack).toEqual(['ai-plan']);
                expect(ahead.lines.warn.join('\n')).toContain(
                    'project_dependencies/ai-skills (checked out at a different commit than the clone records)'
                );

                git(source, 'commit', '-q', '-am', 'record ai-skills');
                const recorded = await runGlobalSync(source, quietUi(), {
                    home,
                });
                expect(recorded.heldBack).toEqual([]);
                expect(recorded.updatedSkills).toEqual(['ai-plan']);
                for (const dir of [claudePlan(), kiroPlan()]) {
                    expect(
                        fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
                    ).toContain('An uncommitted step.');
                }
            }
        );

        it('keeps Kiro’s copy of an AI skill the clone has uncommitted changes to, and says Claude Code’s link shows them', async () => {
            const plan = await installWithAi('symlink');
            const before = await record();
            fs.appendFileSync(
                path.join(plan, 'SKILL.md'),
                'An uncommitted step.\n'
            );
            const changed = [
                'project_dependencies/ai-skills/skills/research/ai-plan/SKILL.md',
            ];
            const uncommitted = async (_source, skills) =>
                new Map(
                    skills
                        .filter((s) => s.name === 'ai-plan')
                        .map((s) => [s.name, changed])
                );
            const { ui, lines } = recordingUi();

            const result = await runGlobalSync(source, ui, {
                home,
                uncommitted,
            });

            expect(result.heldBack).toEqual(['ai-plan']);
            expect(result.updatedSkills).toEqual([]);
            expect(
                fs.readFileSync(path.join(kiroPlan(), 'SKILL.md'), 'utf8')
            ).not.toContain('An uncommitted step.');
            expect((await record()).externalSkillHashes).toEqual(
                before.externalSkillHashes
            );
            expect(lines.warn).toContain(
                `  ai-plan's links show changes the LaunchBridge clone has not committed (${changed[0]}), so agents load them now; the global install keeps the digest it recorded, so lb-setup's integrity check reports ai-plan until they are committed or discarded. Its copies were kept at the version the global install recorded. Commit or discard them (git -C "${source}" status), or run 'launchbridge' and choose Global to install ai-plan as it is now.`
            );
        });

        it('copies a changed AI skill again only where its copy still holds what LaunchBridge installed', async () => {
            const plan = await installWithAi('copy');
            fs.writeFileSync(path.join(kiroPlan(), 'MY_NOTES.md'), 'mine\n');
            fs.appendFileSync(path.join(plan, 'SKILL.md'), 'A new step.\n');
            const { ui, lines } = recordingUi();

            const result = await runGlobalSync(source, ui, { home });

            expect(result.problems).toEqual([]);
            expect(result.updatedSkills).toEqual(['ai-plan']);
            expect(result.modifiedTargets).toEqual([kiroPlan()]);
            expect(
                fs.readFileSync(path.join(kiroPlan(), 'MY_NOTES.md'), 'utf8')
            ).toBe('mine\n');
            expect(
                fs.readFileSync(path.join(kiroPlan(), 'SKILL.md'), 'utf8')
            ).not.toContain('A new step.');
            expect(
                fs.readFileSync(path.join(claudePlan(), 'SKILL.md'), 'utf8')
            ).toContain('A new step.');
            expect(lines.warn).toContain(
                `  ${kiroPlan()} differs from what LaunchBridge installed, so it was left as it is and the update to ai-plan was not copied into it. To install it again, run 'launchbridge' and choose Global.`
            );
        });

        it('does not make a skills folder that is gone again for an AI skill either', async () => {
            const plan = await installWithAi('copy');
            fs.rmSync(path.join(home, '.kiro'), { recursive: true });
            fs.appendFileSync(path.join(plan, 'SKILL.md'), 'A new step.\n');
            const { ui, lines } = recordingUi();

            const result = await runGlobalSync(source, ui, { home });

            expect(fs.existsSync(path.join(home, '.kiro'))).toBe(false);
            expect(result.problems).toEqual([]);
            expect(result.updatedSkills).toEqual(['ai-plan']);
            expect(
                fs.readFileSync(path.join(claudePlan(), 'SKILL.md'), 'utf8')
            ).toContain('A new step.');
            expect(lines.warn.join('\n')).toContain(
                'were not installed again (ai-plan, data-wrangler, lb-setup, testing-framework)'
            );
        });

        for (const method of ['symlink', 'copy']) {
            it(`syncs agents whose skills folders are one folder once, in Claude Code’s form (${method})`, async () => {
                fs.mkdirSync(path.join(home, '.claude', 'skills'), {
                    recursive: true,
                });
                fs.mkdirSync(path.join(home, '.kiro'));
                fs.symlinkSync(
                    path.join(home, '.claude', 'skills'),
                    path.join(home, '.kiro', 'skills')
                );
                const plan = aiSkill('ai-plan');
                await writeGlobalState(
                    GLOBAL_MANIFEST,
                    JSON.stringify({
                        schemaVersion: 1,
                        scope: 'global',
                        version: '0.0.0',
                        agents: AGENTS_BOTH,
                        installMethod: method,
                        skills: ALL,
                        skillHashes: {},
                        installedTargets: targetsFor(AGENTS_BOTH, ALL),
                    })
                );
                const installing = recordingUi();
                const installed = await runGlobalSync(source, installing.ui, {
                    home,
                });
                expect(installed.problems).toEqual([]);
                expect(installed.updatedSkills.sort()).toEqual([...ALL].sort());
                for (const name of ALL) {
                    expect(
                        installing.lines.muted.filter((m) =>
                            m.includes(`skill: ${name} (`)
                        )
                    ).toHaveLength(1);
                }
                expect(
                    fs.readFileSync(path.join(claudePlan(), 'SKILL.md'))
                ).toEqual(fs.readFileSync(path.join(plan, 'SKILL.md')));
                const first = await record();
                expect(first.externalSkillHashes['kiro/ai-plan']).toBe(
                    first.externalSkillHashes['claude/ai-plan']
                );
                const { ui, lines } = recordingUi();

                const again = await runGlobalSync(source, ui, { home });

                expect(again.problems).toEqual([]);
                expect(again.modifiedTargets).toEqual([]);
                expect(again.updatedSkills).toEqual([]);
                expect(lines.muted).toContain(
                    '  Global install: every skill is already up to date.'
                );
                expect(fs.lstatSync(claudePlan()).isSymbolicLink()).toBe(
                    method === 'symlink'
                );
                if (hasPython) {
                    const check = verifyGlobal();
                    expect(check.status, check.stdout + check.stderr).toBe(0);
                }
            });
        }
    });

    it.skipIf(isRoot)(
        'still updates the local install when the global sync stops with an error',
        async () => {
            await installGlobally();
            fs.appendFileSync(
                path.join(source, 'skills', 'data-wrangler', 'SKILL.md'),
                'x\n'
            );
            const cwd = path.join(root, 'project');
            fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'data-wrangler'), {
                recursive: true,
            });
            fs.mkdirSync(path.join(cwd, '.lb_workspace', 'config'), {
                recursive: true,
            });
            fs.writeFileSync(
                path.join(
                    cwd,
                    '.lb_workspace',
                    'config',
                    'version_manifest.json'
                ),
                JSON.stringify({
                    version: '1.2.0',
                    installMethod: 'copy',
                    agents: ['claude'],
                    skills: ['data-wrangler'],
                    skillHashes: { 'data-wrangler': 'stale' },
                    installedTargets: ['.claude/skills/data-wrangler'],
                })
            );
            // A skill only the global install has can't be read.
            const unreadable = path.join(
                source,
                'skills',
                'testing-framework',
                'SKILL.md'
            );
            fs.chmodSync(unreadable, 0o000);
            let syncs;
            try {
                syncs = await runInstallSyncs(source, cwd, quietUi(), { home });
            } finally {
                fs.chmodSync(unreadable, 0o644);
            }

            expect(syncs.global.problems).toHaveLength(1);
            expect(syncs.global.problems[0]).toMatch(
                /^Could not update the global install: /
            );
            expect(syncs.local.updatedSkills).toEqual(['data-wrangler']);
            expect(
                fs.existsSync(
                    path.join(
                        cwd,
                        '.claude',
                        'skills',
                        'data-wrangler',
                        'SKILL.md'
                    )
                )
            ).toBe(true);
            expect(syncsIncomplete(syncs)).toBe(true);
        }
    );
});

describe('syncsIncomplete', () => {
    const global = (problems = []) => ({ problems });

    it('is false when both syncs did their work', () => {
        expect(syncsIncomplete({ global: global(), localSkipped: null })).toBe(
            false
        );
    });

    it('is true when the global sync had problems or the local one was refused', () => {
        expect(
            syncsIncomplete({ global: global(['x']), localSkipped: null })
        ).toBe(true);
        expect(
            syncsIncomplete({
                global: global(),
                localSkipped: '.lb_workspace is a symlink',
            })
        ).toBe(true);
    });
});
