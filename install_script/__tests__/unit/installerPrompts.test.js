// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The installer as someone at the terminal runs it, without --yes: each answer
 * is typed once its prompt is on the screen. HOME, USERPROFILE and
 * XDG_CONFIG_HOME point at temporary folders, so nothing touches the real
 * home folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { runGlobalSync } from '../../lib/globalSync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(HERE, '..', '..', 'index.js');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const VERIFY = path.join(
    REPO_ROOT,
    'skills',
    'lb-setup',
    'scripts',
    'verify_integrity.py'
);
const hasGit = spawnSync('git', ['--version']).status === 0;
const PYTHON = process.env.LB_TEST_PYTHON;
const hasPython = Boolean(PYTHON);
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

const ENTER = '\r';
const DOWN = '\u001b[B';
const confirm = { prompt: 'Proceed with installation?', keys: `y${ENTER}` };
const decline = { prompt: 'Proceed with installation?', keys: `n${ENTER}` };
const skipConflict = (skill) => ({
    prompt: `How to handle "${skill}"?`,
    keys: `${DOWN}${DOWN}${ENTER}`,
});
// Answered only if the prompt comes, and then it ends the run.
const cancelAnyConflict = {
    prompt: 'How to handle "',
    keys: `${DOWN}${DOWN}${DOWN}${ENTER}`,
};
const orphans = (choice) => ({
    prompt: 'How to handle previously installed skills?',
    keys: choice === 'remove' ? ENTER : `${DOWN}${DOWN}${ENTER}`,
});
const defaultChoice = (prompt) => ({ prompt, keys: ENTER });
// Ctrl-C at the prompt: the run stops there.
const interruptAt = (prompt) => ({ prompt, signal: 'SIGINT' });

/**
 * Runs the installer, typing each answer once its prompt has been printed
 * since the previous answer. A prompt nobody answers would wait for ever, so
 * the run is stopped after a while without output.
 *
 * @param {string[]} args
 * @param {Array<{ prompt: string, keys?: string, signal?: string }>} answers -
 *     In order; one with a signal sends it to the installer instead of typing
 * @param {{ cwd: string, env: object, installer?: string }} options
 * @returns {Promise<{ status: number | null, output: string, answered: number }>}
 */
function runAnswering(args, answers, { cwd, env, installer = INSTALLER }) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [installer, ...args], {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        let unseen = '';
        let answered = 0;
        let idle;
        const watch = () => {
            clearTimeout(idle);
            idle = setTimeout(() => child.kill(), 20000);
        };
        // An answer typed as the installer exits has nowhere to go.
        child.stdin.on('error', () => {});
        child.stdout.on('data', (data) => {
            output += data;
            unseen += data;
            watch();
            while (
                answered < answers.length &&
                unseen.includes(answers[answered].prompt)
            ) {
                const { prompt, keys, signal } = answers[answered];
                unseen = unseen.slice(unseen.indexOf(prompt) + prompt.length);
                answered++;
                setTimeout(() => {
                    if (signal) child.kill(signal);
                    else if (!child.stdin.destroyed) child.stdin.write(keys);
                }, 50);
            }
        });
        child.stderr.on('data', (data) => {
            output += data;
            watch();
        });
        child.on('close', (status) => {
            clearTimeout(idle);
            resolve({ status, output, answered });
        });
        watch();
    });
}

/**
 * What a 1.2.0 symlink install left: a real folder holding one link per
 * source file.
 */
function layOutPerFile(dir, source) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const rel of fs.readdirSync(source, { recursive: true })) {
        if (rel.split(path.sep).includes('__pycache__')) continue;
        const from = path.join(source, rel);
        const to = path.join(dir, rel);
        if (fs.statSync(from).isDirectory()) {
            fs.mkdirSync(to, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.symlinkSync(from, to);
        }
    }
}

describe.skipIf(!hasGit || process.platform === 'win32')(
    'the installer at the terminal',
    () => {
        let root;
        let home;
        let state;
        let cwd;
        let env;
        const saved = {};

        beforeEach(() => {
            root = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-prompts-'))
            );
            home = path.join(root, 'home');
            state = path.join(root, 'state');
            cwd = path.join(root, 'project');
            fs.mkdirSync(home);
            fs.mkdirSync(cwd);
            spawnSync('git', ['init', '-q', '.'], { cwd });
            env = {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                XDG_CONFIG_HOME: state,
                FORCE_COLOR: '0',
            };
            for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
                saved[key] = process.env[key];
            }
            process.env.HOME = home;
            process.env.USERPROFILE = home;
            process.env.XDG_CONFIG_HOME = state;
        });
        afterEach(() => {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(root, { recursive: true, force: true });
        });

        const install = (...args) =>
            spawnSync(process.execPath, [INSTALLER, ...args, '--yes'], {
                cwd,
                encoding: 'utf-8',
                env,
            });
        const answering = (args, answers) =>
            runAnswering(args, answers, { cwd, env });
        const globalRecord = () =>
            JSON.parse(
                fs.readFileSync(
                    path.join(state, 'launchbridge', 'global', 'manifest.json'),
                    'utf-8'
                )
            );
        const localRecord = () =>
            JSON.parse(
                fs.readFileSync(
                    path.join(
                        cwd,
                        '.lb_workspace',
                        'config',
                        'version_manifest.json'
                    ),
                    'utf-8'
                )
            );
        const globalSkill = (name) =>
            path.join(home, '.claude', 'skills', name);
        const source = (name) => path.join(REPO_ROOT, 'skills', name);
        const isLinkToSource = (dir, name) =>
            fs.lstatSync(dir).isSymbolicLink() &&
            fs.realpathSync(dir) === fs.realpathSync(source(name));

        describe('a recorded skill folder laid out another way than this run installs it', () => {
            const SKILLS = 'lb-setup,testing-framework';
            const globalArgs = (method = 'symlink', skills = SKILLS) => [
                '--scope',
                'global',
                '--agent',
                'claude',
                '--skills',
                skills,
                '--method',
                method,
            ];

            it('asks before replacing a real folder that took the place of a link', async () => {
                expect(install(...globalArgs()).status).toBe(0);
                const dir = globalSkill('testing-framework');
                fs.unlinkSync(dir);
                fs.cpSync(source('testing-framework'), dir, {
                    recursive: true,
                });
                fs.writeFileSync(path.join(dir, 'MY_CUSTOM.md'), 'mine\n');

                const run = await answering(globalArgs(), [
                    confirm,
                    skipConflict('testing-framework'),
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.answered).toBe(2);
                expect(run.output).toContain(
                    `Conflict: "testing-framework" already exists at ${dir}.`
                );
                expect(run.output).not.toContain(
                    'laid out the way an older LaunchBridge'
                );
                expect(
                    fs.readFileSync(path.join(dir, 'MY_CUSTOM.md'), 'utf-8')
                ).toBe('mine\n');
                expect(
                    isLinkToSource(globalSkill('lb-setup'), 'lb-setup')
                ).toBe(true);
            }, 120000);

            it('asks before replacing a per-file folder that holds a file LaunchBridge did not install', async () => {
                expect(install(...globalArgs()).status).toBe(0);
                const dir = globalSkill('testing-framework');
                layOutPerFile(dir, source('testing-framework'));
                fs.writeFileSync(path.join(dir, 'OUR_NOTES.md'), 'notes\n');

                const run = await answering(globalArgs(), [
                    confirm,
                    skipConflict('testing-framework'),
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.output).toContain(
                    'Conflict: "testing-framework" already exists'
                );
                expect(run.output).toContain(
                    'Installed skill content differs from this LaunchBridge source, so these are installed again: testing-framework'
                );
                expect(
                    fs.readFileSync(path.join(dir, 'OUR_NOTES.md'), 'utf-8')
                ).toBe('notes\n');
            }, 120000);

            it('replaces a per-file folder of links into the source without asking', async () => {
                expect(install(...globalArgs()).status).toBe(0);
                for (const name of ['lb-setup', 'testing-framework']) {
                    layOutPerFile(globalSkill(name), source(name));
                }

                const run = await answering(globalArgs(), [
                    confirm,
                    cancelAnyConflict,
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.output).not.toContain('Conflict:');
                expect(run.output).toContain(
                    'These skills are laid out the way an older LaunchBridge installed them, so they are installed again: lb-setup, testing-framework'
                );
                for (const name of ['lb-setup', 'testing-framework']) {
                    expect(isLinkToSource(globalSkill(name), name)).toBe(true);
                }
            }, 120000);

            it('replaces every folder without asking when the install method changes', async () => {
                expect(install(...globalArgs('copy')).status).toBe(0);
                fs.writeFileSync(
                    path.join(globalSkill('testing-framework'), 'MINE.md'),
                    'mine\n'
                );

                const run = await answering(globalArgs('symlink'), [
                    confirm,
                    cancelAnyConflict,
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.output).not.toContain('Conflict:');
                expect(run.output).not.toContain('content differs');
                for (const name of ['lb-setup', 'testing-framework']) {
                    expect(isLinkToSource(globalSkill(name), name)).toBe(true);
                }
            }, 120000);

            it('asks about a real folder in place of a link, and replaces a per-file one without asking, when another skill is added', async () => {
                expect(install(...globalArgs()).status).toBe(0);
                const custom = globalSkill('testing-framework');
                fs.unlinkSync(custom);
                fs.cpSync(source('testing-framework'), custom, {
                    recursive: true,
                });
                fs.writeFileSync(path.join(custom, 'MY_CUSTOM.md'), 'mine\n');
                layOutPerFile(globalSkill('lb-setup'), source('lb-setup'));

                const run = await answering(
                    globalArgs('symlink', `${SKILLS},data-wrangler`),
                    [confirm, skipConflict('testing-framework')]
                );

                expect(run.status, run.output).toBe(0);
                expect(run.answered).toBe(2);
                expect(run.output).toContain(
                    'These skills are laid out the way an older LaunchBridge installed them, so they are installed again: lb-setup'
                );
                expect(run.output).toContain(
                    'Installed skill content differs from this LaunchBridge source, so these are installed again: testing-framework'
                );
                expect(run.output).not.toContain('Conflict: "lb-setup"');
                expect(
                    fs.readFileSync(path.join(custom, 'MY_CUSTOM.md'), 'utf-8')
                ).toBe('mine\n');
                expect(
                    isLinkToSource(globalSkill('lb-setup'), 'lb-setup')
                ).toBe(true);
                expect(
                    isLinkToSource(
                        globalSkill('data-wrangler'),
                        'data-wrangler'
                    )
                ).toBe(true);
            }, 120000);

            it('replaces per-file folders without asking on an upgrade from 1.2.0, and asks about one holding a file of the user’s', async () => {
                const localArgs = [
                    '--scope',
                    'local',
                    '--agent',
                    'claude',
                    '--skills',
                    'lb-setup,testing-framework,code-guardrails',
                    '--method',
                    'symlink',
                ];
                expect(install(...localArgs).status).toBe(0);
                const skillsDir = path.join(cwd, '.claude', 'skills');
                for (const name of [
                    'lb-setup',
                    'testing-framework',
                    'code-guardrails',
                ]) {
                    layOutPerFile(path.join(skillsDir, name), source(name));
                }
                const notes = path.join(
                    skillsDir,
                    'code-guardrails',
                    'assets',
                    'best_practices',
                    'client_a_standards.md'
                );
                fs.mkdirSync(path.dirname(notes), { recursive: true });
                fs.writeFileSync(notes, 'ours\n');
                const record = localRecord();
                record.version = '1.2.0';
                fs.writeFileSync(
                    path.join(
                        cwd,
                        '.lb_workspace',
                        'config',
                        'version_manifest.json'
                    ),
                    JSON.stringify(record, null, 2)
                );

                const run = await answering(localArgs, [
                    confirm,
                    skipConflict('code-guardrails'),
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.output).toContain('Upgrading from v1.2.0');
                expect(run.output).toContain(
                    'These skills are laid out the way an older LaunchBridge installed them, so they are installed again: lb-setup, testing-framework'
                );
                expect(run.output).toContain(
                    'Conflict: "code-guardrails" already exists'
                );
                expect(run.output).not.toContain('Conflict: "lb-setup"');
                expect(run.output).not.toContain(
                    'Conflict: "testing-framework"'
                );
                expect(fs.readFileSync(notes, 'utf-8')).toBe('ours\n');
                for (const name of ['lb-setup', 'testing-framework']) {
                    expect(
                        isLinkToSource(path.join(skillsDir, name), name)
                    ).toBe(true);
                }
            }, 120000);
        });

        describe('without --scope', () => {
            const args = ['--skills', 'lb-setup', '--method', 'copy'];
            const scopePrompt = defaultChoice(
                'Install the skills globally or into this repository?'
            );

            it('defaults to Local in a folder with a local install, with its agents pre-checked', async () => {
                expect(
                    install(...args, '--scope', 'local', '--agent', 'kiro')
                        .status
                ).toBe(0);
                expect(
                    install(...args, '--scope', 'global', '--agent', 'codex')
                        .status
                ).toBe(0);

                const run = await answering(args, [
                    defaultChoice('Select the agents to install skills for:'),
                    scopePrompt,
                    confirm,
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.answered).toBe(3);
                expect(run.output).toContain(
                    "From this folder's local install: kiro (pre-selected)"
                );
                expect(run.output).toContain(
                    'This folder already has a local LaunchBridge install, so Local is the default.'
                );
                expect(run.output).toMatch(/Scope\s+Local \(repository\)/);
                expect(run.output).toContain(
                    'lb-setup from the global install refuses to prepare a repository that has a local install'
                );
                expect(localRecord().agents).toEqual(['kiro']);
                expect(fs.existsSync(path.join(home, '.kiro'))).toBe(false);
            }, 120000);

            it('defaults to Global in a folder without a local install', async () => {
                const run = await answering(
                    [...args, '--agent', 'claude'],
                    [scopePrompt, confirm]
                );

                expect(run.status, run.output).toBe(0);
                expect(run.output).toMatch(/Scope\s+Global \(home directory\)/);
                expect(
                    fs.existsSync(
                        path.join(globalSkill('lb-setup'), 'SKILL.md')
                    )
                ).toBe(true);
                expect(fs.readdirSync(cwd)).toEqual(['.git']);
            }, 120000);

            it('warns about a local install when installing globally with --scope global', () => {
                expect(
                    install(...args, '--scope', 'local', '--agent', 'claude')
                        .status
                ).toBe(0);

                const run = install(
                    ...args,
                    '--scope',
                    'global',
                    '--agent',
                    'claude'
                );

                expect(run.status, run.stdout + run.stderr).toBe(0);
                expect(run.stdout).toContain(
                    'This folder also has a local LaunchBridge install.'
                );
            }, 120000);

            it('defaults to Local, and so refuses, where a local install’s workspace is reached through a link', () => {
                expect(
                    install(...args, '--scope', 'local', '--agent', 'claude')
                        .status
                ).toBe(0);
                const moved = path.join(root, 'elsewhere');
                fs.renameSync(path.join(cwd, '.lb_workspace'), moved);
                fs.symlinkSync(moved, path.join(cwd, '.lb_workspace'));

                const run = install(...args, '--agent', 'claude');

                expect(run.status).toBe(1);
                expect(run.stdout + run.stderr).toContain(
                    'Refusing to install:'
                );
                expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
                expect(
                    fs.existsSync(path.join(state, 'launchbridge', 'global'))
                ).toBe(false);
            }, 120000);

            it('updates the local install for --yes in a folder that has one', () => {
                expect(
                    install(...args, '--scope', 'local', '--agent', 'claude')
                        .status
                ).toBe(0);

                const again = install(
                    '--skills',
                    'lb-setup,testing-framework',
                    '--method',
                    'copy',
                    '--agent',
                    'claude'
                );

                expect(again.status, again.stdout + again.stderr).toBe(0);
                expect(again.stdout).toMatch(/Scope\s+Local \(repository\)/);
                expect(localRecord().installedTargets).toContain(
                    '.claude/skills/testing-framework'
                );
                expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
                expect(
                    fs.existsSync(path.join(state, 'launchbridge', 'global'))
                ).toBe(false);
            }, 120000);
        });

        describe('a skill no longer selected', () => {
            const globalArgs = (skills) => [
                '--scope',
                'global',
                '--agent',
                'claude',
                '--skills',
                skills,
                '--method',
                'copy',
            ];

            it('stays recorded when --yes leaves it, is offered on the next interactive run, and is LaunchBridge’s when selected again', async () => {
                expect(
                    install(...globalArgs('lb-setup,testing-framework')).status
                ).toBe(0);

                const narrowed = install(...globalArgs('lb-setup'));

                expect(narrowed.status).toBe(0);
                expect(narrowed.stdout).toContain(
                    'Not removing 1 skill(s) no longer selected'
                );
                expect(narrowed.stdout).not.toMatch(/\d+ removed/);
                expect(globalRecord().skills).toEqual(['lb-setup']);
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                ]);

                const kept = await answering(globalArgs('lb-setup'), [
                    confirm,
                    orphans('skip'),
                ]);

                expect(kept.status, kept.output).toBe(0);
                expect(kept.answered).toBe(2);
                expect(kept.output).toContain(
                    'Found 1 orphaned skill directory not in the current skill list'
                );
                expect(globalRecord().installedTargets).toContain(
                    '.claude/skills/testing-framework'
                );
                expect(fs.existsSync(globalSkill('testing-framework'))).toBe(
                    true
                );

                const again = install(
                    ...globalArgs('lb-setup,testing-framework')
                );

                expect(again.status, again.stdout + again.stderr).toBe(0);
                expect(again.stdout).not.toContain(
                    'was not installed by LaunchBridge'
                );
                expect(globalRecord().skills).toEqual([
                    'lb-setup',
                    'testing-framework',
                ]);
                expect(
                    fs.existsSync(
                        path.join(globalSkill('testing-framework'), 'SKILL.md')
                    )
                ).toBe(true);
                expect(
                    install(...globalArgs('lb-setup,testing-framework')).stdout
                ).toContain('up to date');
            }, 120000);

            it('is treated as the user’s once it differs from what LaunchBridge installs: --yes does not replace it when it is selected again', async () => {
                expect(
                    install(...globalArgs('lb-setup,testing-framework')).status
                ).toBe(0);
                expect(install(...globalArgs('lb-setup')).status).toBe(0);
                const dir = globalSkill('testing-framework');
                fs.writeFileSync(path.join(dir, 'MY_NOTES.md'), 'mine\n');

                const again = install(
                    ...globalArgs('lb-setup,testing-framework')
                );

                expect(again.status).toBe(1);
                expect(again.stdout).toContain(
                    `${dir} was left in place when testing-framework was no longer selected, and differs from what LaunchBridge installs for it, so it is treated as yours from now on: LaunchBridge doesn't remove it, and replaces it only when you say so.`
                );
                expect(again.stdout).toContain(
                    `${dir} was left in place when testing-framework was no longer selected and differs from what LaunchBridge installs for it; left unchanged (--yes never replaces it).`
                );
                expect(
                    fs.readFileSync(path.join(dir, 'MY_NOTES.md'), 'utf8')
                ).toBe('mine\n');
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                ]);
            }, 120000);

            it('is not offered for removal once it differs from what LaunchBridge installs', async () => {
                expect(
                    install(...globalArgs('lb-setup,testing-framework')).status
                ).toBe(0);
                expect(install(...globalArgs('lb-setup')).status).toBe(0);
                const dir = globalSkill('testing-framework');
                fs.appendFileSync(path.join(dir, 'SKILL.md'), '\nMine.\n');

                const run = await answering(globalArgs('lb-setup'), [
                    confirm,
                    cancelAnyConflict,
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.output).not.toContain('orphaned skill director');
                expect(run.output).toContain(
                    `${dir} was left in place when testing-framework was no longer selected`
                );
                expect(
                    fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
                ).toContain('Mine.');
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                ]);
            }, 120000);

            it('still gets a local install’s Python dependency config rewritten when it is kept', async () => {
                const localArgs = (skills) => [
                    '--scope',
                    'local',
                    '--agent',
                    'claude',
                    '--skills',
                    skills,
                    '--method',
                    'copy',
                ];
                expect(
                    install(...localArgs('lb-setup,testing-framework')).status
                ).toBe(0);
                expect(install(...localArgs('lb-setup')).status).toBe(0);
                const deps = path.join(
                    cwd,
                    '.lb_workspace',
                    'config',
                    'python_deps'
                );
                const repos = path.join(state, 'launchbridge', 'repos');
                const [key] = fs.readdirSync(repos);
                const record = path.join(repos, key, 'python_deps.json');
                fs.rmSync(deps, { recursive: true });
                fs.rmSync(record);

                const run = await answering(localArgs('lb-setup'), [
                    confirm,
                    orphans('skip'),
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.answered).toBe(2);
                expect(fs.existsSync(path.join(deps, 'pyproject.toml'))).toBe(
                    true
                );
                expect(fs.existsSync(record)).toBe(true);
            }, 120000);

            it('loses its record once removed, which the report counts', async () => {
                expect(
                    install(...globalArgs('lb-setup,testing-framework')).status
                ).toBe(0);
                expect(install(...globalArgs('lb-setup')).status).toBe(0);

                const run = await answering(globalArgs('lb-setup'), [
                    confirm,
                    orphans('remove'),
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.output).toContain(
                    'Removed orphaned directory: testing-framework'
                );
                expect(run.output).toMatch(/1 removed\s+1 unchanged/);
                expect(fs.existsSync(globalSkill('testing-framework'))).toBe(
                    false
                );
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                ]);
            }, 120000);

            it.skipIf(!hasPython || !hasAiSubmodule)(
                'is left alone, and unchecked, by the integrity check and by launchbridge update',
                async () => {
                    const all = 'lb-setup,testing-framework,ai-plan,ai-create';
                    expect(install(...globalArgs(all)).status).toBe(0);
                    expect(
                        install(...globalArgs('lb-setup,ai-plan')).status
                    ).toBe(0);
                    const before = globalRecord();
                    expect(before.installedTargets).toContain(
                        '.claude/skills/ai-create'
                    );
                    const aiCreate = path.join(
                        globalSkill('ai-create'),
                        'SKILL.md'
                    );
                    const aiCreateBefore = fs.statSync(aiCreate).mtimeMs;

                    const verify = () =>
                        spawnSync(PYTHON, ['-I', VERIFY, '--global', cwd], {
                            encoding: 'utf-8',
                            env,
                        });
                    const checked = verify();
                    expect(
                        checked.status,
                        checked.stdout + checked.stderr
                    ).toBe(0);
                    expect(checked.stdout).toContain('OK');

                    const sync = await runGlobalSync(
                        REPO_ROOT,
                        {
                            muted: () => {},
                            success: () => {},
                            warn: () => {},
                        },
                        { home, uncommitted: async () => new Map() }
                    );

                    expect(sync.problems).toEqual([]);
                    expect(sync.updatedSkills).toEqual([]);
                    const after = globalRecord();
                    expect(after.installedTargets).toEqual(
                        before.installedTargets
                    );
                    expect(after.skillHashes).toEqual(before.skillHashes);
                    expect(after.externalSkillHashes).toEqual(
                        before.externalSkillHashes
                    );
                    expect(fs.statSync(aiCreate).mtimeMs).toBe(aiCreateBefore);
                    expect(verify().status).toBe(0);
                    expect(
                        install(...globalArgs('lb-setup,ai-plan')).stdout
                    ).toContain('up to date');
                },
                120000
            );
        });

        describe('a first global install stopped before it finished', () => {
            const globalArgs = (skills = 'lb-setup,testing-framework') => [
                '--scope',
                'global',
                '--agent',
                'claude,kiro',
                '--skills',
                skills,
                '--method',
                'copy',
            ];
            const skillDir = (dir, name) =>
                path.join(home, dir, 'skills', name);
            const pendingFile = () =>
                path.join(state, 'launchbridge', 'global', 'pending.json');
            const mine = () =>
                path.join(skillDir('.kiro', 'testing-framework'), 'MINE.md');
            const moveMineAway = () =>
                fs.renameSync(
                    path.dirname(mine()),
                    path.join(home, 'my-testing-framework')
                );
            const bootstrap = () =>
                spawnSync(
                    'python3',
                    [
                        '-I',
                        path.join(
                            skillDir('.claude', 'lb-setup'),
                            'scripts',
                            'bootstrap_workspace.py'
                        ),
                        'init',
                        cwd,
                    ],
                    { encoding: 'utf-8', env }
                );
            const verify = () =>
                spawnSync('python3', ['-I', VERIFY, '--global', cwd], {
                    encoding: 'utf-8',
                    env,
                });

            // Kiro already has a testing-framework folder of the user's, so
            // the install asks about it once it has installed the rest, and
            // Ctrl-C there stops it before it writes its record.
            async function stopAtTheLastFolder() {
                fs.mkdirSync(path.dirname(mine()), { recursive: true });
                fs.writeFileSync(mine(), 'mine\n');
                const run = await answering(globalArgs(), [
                    confirm,
                    interruptAt('How to handle "testing-framework"?'),
                ]);
                expect(run.answered, run.output).toBe(2);
                expect(run.status, run.output).not.toBe(0);
                expect(
                    fs.existsSync(
                        path.join(
                            state,
                            'launchbridge',
                            'global',
                            'manifest.json'
                        )
                    )
                ).toBe(false);
            }

            it('is finished by a --yes run, which replaces a half-copied folder and records every folder it installed', async () => {
                await stopAtTheLastFolder();
                expect(
                    JSON.parse(fs.readFileSync(pendingFile(), 'utf-8')).targets
                ).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                    '.kiro/skills/lb-setup',
                ]);
                // What a stop in the middle of a copy leaves.
                const references = path.join(
                    skillDir('.claude', 'testing-framework'),
                    'references'
                );
                fs.rmSync(references, { recursive: true });
                moveMineAway();

                const again = install(...globalArgs());

                expect(again.status, again.stdout + again.stderr).toBe(0);
                expect(again.stdout).toContain(
                    'An earlier global install did not finish'
                );
                expect(again.stdout).not.toContain(
                    'was not installed by LaunchBridge'
                );
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                    '.kiro/skills/lb-setup',
                    '.kiro/skills/testing-framework',
                ]);
                expect(fs.existsSync(pendingFile())).toBe(false);
                expect(fs.readdirSync(references)).toEqual(
                    fs.readdirSync(
                        path.join(source('testing-framework'), 'references')
                    )
                );
            }, 120000);

            it.skipIf(!hasPython)(
                'leaves lb-setup saying there is no global install record until a re-run finishes it',
                async () => {
                    await stopAtTheLastFolder();

                    const refused = bootstrap();
                    expect(
                        refused.status,
                        refused.stdout + refused.stderr
                    ).toBe(2);
                    expect(refused.stdout).toContain(
                        'No global install record'
                    );
                    expect(refused.stdout).toContain(
                        'Install the skills globally with `launchbridge` (choose Global)'
                    );
                    expect(verify().status).toBe(2);

                    moveMineAway();
                    const again = install(...globalArgs());
                    expect(again.status, again.stdout + again.stderr).toBe(0);

                    const prepared = bootstrap();
                    expect(
                        prepared.status,
                        prepared.stdout + prepared.stderr
                    ).toBe(0);
                    expect(JSON.parse(prepared.stdout).ok).toBe(true);
                    const checked = verify();
                    expect(
                        checked.status,
                        checked.stdout + checked.stderr
                    ).toBe(0);
                    expect(checked.stdout).toContain(
                        'every installed skill matches'
                    );
                },
                120000
            );

            it('lists a folder of the user’s before replacing it when told to, so the next run finishes that one too', async () => {
                const theirs = path.join(
                    skillDir('.kiro', 'lb-setup'),
                    'THEIRS.md'
                );
                fs.mkdirSync(path.dirname(theirs), { recursive: true });
                fs.writeFileSync(theirs, 'theirs\n');
                fs.mkdirSync(path.dirname(mine()), { recursive: true });
                fs.writeFileSync(mine(), 'mine\n');

                const run = await answering(globalArgs(), [
                    confirm,
                    defaultChoice('How to handle "lb-setup"?'),
                    interruptAt('How to handle "testing-framework"?'),
                ]);

                expect(run.answered, run.output).toBe(3);
                expect(fs.existsSync(theirs)).toBe(false);
                expect(
                    JSON.parse(fs.readFileSync(pendingFile(), 'utf-8')).targets
                ).toContain('.kiro/skills/lb-setup');

                moveMineAway();
                const again = install(...globalArgs());

                expect(again.status, again.stdout + again.stderr).toBe(0);
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                    '.kiro/skills/lb-setup',
                    '.kiro/skills/testing-framework',
                ]);
            }, 120000);

            it('offers a folder it installed for removal when the next run does not select its skill', async () => {
                await stopAtTheLastFolder();

                const run = await answering(globalArgs('lb-setup'), [
                    confirm,
                    orphans('remove'),
                ]);

                expect(run.status, run.output).toBe(0);
                expect(run.answered).toBe(2);
                expect(run.output).toContain(
                    'Removed orphaned directory: testing-framework'
                );
                expect(
                    fs.existsSync(skillDir('.claude', 'testing-framework'))
                ).toBe(false);
                // The user's own folder is neither offered nor touched.
                expect(fs.readFileSync(mine(), 'utf-8')).toBe('mine\n');
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                    '.kiro/skills/lb-setup',
                ]);
                expect(fs.existsSync(pendingFile())).toBe(false);
            }, 120000);

            it('keeps such a folder recorded, and listed, when a --yes run leaves it', async () => {
                await stopAtTheLastFolder();

                const narrowed = install(...globalArgs('lb-setup'));

                expect(narrowed.status, narrowed.stdout + narrowed.stderr).toBe(
                    0
                );
                expect(narrowed.stdout).toContain(
                    'Not removing 1 skill(s) no longer selected'
                );
                expect(narrowed.stdout).toContain(
                    `These skill folders a global install did not finish may be incomplete: ${skillDir('.claude', 'testing-framework')}.`
                );
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                    '.kiro/skills/lb-setup',
                ]);
                expect(
                    JSON.parse(fs.readFileSync(pendingFile(), 'utf-8')).targets
                ).toEqual(['.claude/skills/testing-framework']);
                expect(fs.readFileSync(mine(), 'utf-8')).toBe('mine\n');
            }, 120000);

            it('lists only the folders it had started on, so a folder made later where it had not got to is not taken over', async () => {
                const theirs = path.join(
                    skillDir('.kiro', 'lb-setup'),
                    'THEIRS.md'
                );
                fs.mkdirSync(path.dirname(theirs), { recursive: true });
                fs.writeFileSync(theirs, 'theirs\n');
                const stopped = await answering(globalArgs(), [
                    confirm,
                    interruptAt('How to handle "lb-setup"?'),
                ]);
                expect(stopped.answered, stopped.output).toBe(2);
                expect(
                    JSON.parse(fs.readFileSync(pendingFile(), 'utf-8')).targets
                ).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                ]);
                // The user's own, where the stopped run would have gone next.
                fs.mkdirSync(path.dirname(mine()), { recursive: true });
                fs.writeFileSync(mine(), 'mine\n');

                const asked = await answering(globalArgs(), [
                    confirm,
                    skipConflict('lb-setup'),
                    skipConflict('testing-framework'),
                ]);

                expect(asked.status, asked.output).toBe(0);
                expect(asked.answered, asked.output).toBe(3);
                expect(fs.readFileSync(mine(), 'utf-8')).toBe('mine\n');

                const yes = install(...globalArgs());

                expect(yes.status, yes.stdout + yes.stderr).toBe(1);
                expect(yes.stdout).toContain(
                    `${skillDir('.kiro', 'testing-framework')} exists and was not installed by LaunchBridge`
                );
                expect(fs.readFileSync(mine(), 'utf-8')).toBe('mine\n');
                expect(globalRecord().installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                ]);
            }, 120000);
        });

        describe('a global re-run stopped before it finished', () => {
            const globalArgs = (
                agent,
                skills = 'lb-setup,testing-framework'
            ) => [
                '--scope',
                'global',
                '--agent',
                agent,
                '--skills',
                skills,
                '--method',
                'copy',
            ];
            const pendingFile = () =>
                path.join(state, 'launchbridge', 'global', 'pending.json');
            const mine = () =>
                path.join(home, '.cline', 'skills', 'lb-setup', 'MINE.md');

            // Claude Code has the skills. The re-run adds Kiro and Cline, which
            // has an lb-setup folder of the user's: the run asks about it once
            // it has installed Kiro's, and Ctrl-C there stops it.
            async function stopAddingAgents() {
                expect(install(...globalArgs('claude')).status).toBe(0);
                fs.mkdirSync(path.dirname(mine()), { recursive: true });
                fs.writeFileSync(mine(), 'mine\n');
                const run = await answering(globalArgs('claude,kiro,cline'), [
                    confirm,
                    interruptAt('How to handle "lb-setup"?'),
                ]);
                expect(run.answered, run.output).toBe(2);
                expect(run.status, run.output).not.toBe(0);
                expect(globalRecord().agents).toEqual(['claude']);
            }

            it('is finished by a --yes run of the same skills, which records the folders it installed', async () => {
                await stopAddingAgents();

                const again = install(...globalArgs('claude,kiro'));

                expect(again.status, again.stdout + again.stderr).toBe(0);
                expect(again.stdout).not.toContain(
                    'was not installed by LaunchBridge'
                );
                const record = globalRecord();
                expect(record.agents).toEqual(['claude', 'kiro']);
                expect(record.installedTargets).toEqual([
                    '.claude/skills/lb-setup',
                    '.claude/skills/testing-framework',
                    '.kiro/skills/lb-setup',
                    '.kiro/skills/testing-framework',
                ]);
                expect(fs.existsSync(pendingFile())).toBe(false);
                expect(fs.readFileSync(mine(), 'utf-8')).toBe('mine\n');
                expect(install(...globalArgs('claude,kiro')).stdout).toContain(
                    'up to date'
                );
            }, 120000);

            it('installs again a folder it left half-copied when the next run changes the selection', async () => {
                await stopAddingAgents();
                const references = path.join(
                    home,
                    '.kiro',
                    'skills',
                    'testing-framework',
                    'references'
                );
                fs.rmSync(references, { recursive: true });

                const again = install(
                    ...globalArgs(
                        'claude,kiro',
                        'lb-setup,testing-framework,feature-recommendations'
                    )
                );

                expect(again.status, again.stdout + again.stderr).toBe(0);
                expect(fs.readdirSync(references)).toEqual(
                    fs.readdirSync(
                        path.join(source('testing-framework'), 'references')
                    )
                );
                expect(globalRecord().installedTargets).toContain(
                    '.kiro/skills/testing-framework'
                );
                expect(fs.existsSync(pendingFile())).toBe(false);
            }, 120000);
        });
    }
);

describe.skipIf(!hasGit || process.platform === 'win32')(
    'a LaunchBridge clone with changes to a skill that are not committed',
    () => {
        let root;
        let clone;
        let env;

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
                    ...args,
                ],
                { cwd, encoding: 'utf-8' }
            );
            if (result.status !== 0) {
                throw new Error(
                    `git ${args.join(' ')} failed: ${result.stderr}`
                );
            }
        }

        beforeEach(() => {
            root = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-dirty-clone-'))
            );
            clone = path.join(root, 'launchbridge');
            for (const rel of [
                'install_script/index.js',
                'install_script/lib',
                'skills/lb-setup',
                'skills/testing-framework',
                'project_dependencies/pyproject.toml',
                'project_dependencies/constraints.txt',
                'agent_steering/AGENTS.md',
                'version.txt',
                'package.json',
            ]) {
                fs.cpSync(path.join(REPO_ROOT, rel), path.join(clone, rel), {
                    recursive: true,
                });
            }
            fs.symlinkSync(
                path.join(REPO_ROOT, 'node_modules'),
                path.join(clone, 'node_modules')
            );
            fs.writeFileSync(
                path.join(clone, '.gitignore'),
                'node_modules\n__pycache__/\n*.pyc\n'
            );
            git(root, 'init', '-q', '-b', 'main', clone);
            git(clone, 'add', '-A');
            git(clone, 'commit', '-q', '-m', 'launchbridge');
            const home = path.join(root, 'home');
            fs.mkdirSync(home);
            fs.mkdirSync(path.join(root, 'project'));
            env = {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                XDG_CONFIG_HOME: path.join(root, 'state'),
                FORCE_COLOR: '0',
            };
        });
        afterEach(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        const args = [
            '--scope',
            'global',
            '--agent',
            'claude',
            '--skills',
            'lb-setup,testing-framework',
            '--method',
            'copy',
        ];
        const WARNING =
            'These skills are installed as they are in the LaunchBridge clone, which has changes to them that are not committed: testing-framework.';
        const run = (answers) =>
            runAnswering(args, answers, {
                cwd: path.join(root, 'project'),
                env,
                installer: path.join(clone, 'install_script', 'index.js'),
            });

        it('names the skills before asking to go on', async () => {
            fs.appendFileSync(
                path.join(clone, 'skills', 'testing-framework', 'SKILL.md'),
                '\nAn uncommitted instruction.\n'
            );

            const declined = await run([decline]);

            expect(declined.status, declined.output).toBe(0);
            expect(declined.output).toContain(WARNING);
            expect(declined.output).toContain(`git -C "${clone}" status`);
            expect(declined.output.indexOf(WARNING)).toBeLessThan(
                declined.output.indexOf('Proceed with installation?')
            );
            expect(fs.readdirSync(env.HOME)).toEqual([]);
        }, 120000);

        it('names the files lb-setup’s reference and dependency files are built from', () => {
            fs.appendFileSync(
                path.join(clone, 'agent_steering', 'AGENTS.md'),
                '\nAn uncommitted instruction.\n'
            );

            const run = spawnSync(
                process.execPath,
                [
                    path.join(clone, 'install_script', 'index.js'),
                    ...args,
                    '--yes',
                ],
                { cwd: path.join(root, 'project'), encoding: 'utf-8', env }
            );

            expect(run.status, run.stdout + run.stderr).toBe(0);
            expect(run.stdout).toContain(
                `lb-setup's AGENTS.md reference and Python dependency files are built from files the LaunchBridge clone has changes to that are not committed: agent_steering/AGENTS.md. To see the changes: git -C "${clone}" status`
            );
            expect(run.stdout).not.toContain(WARNING);
        }, 120000);

        it('names them in a --yes run too, and says nothing for a clean clone', async () => {
            const clean = spawnSync(
                process.execPath,
                [
                    path.join(clone, 'install_script', 'index.js'),
                    ...args,
                    '--yes',
                ],
                { cwd: path.join(root, 'project'), encoding: 'utf-8', env }
            );
            expect(clean.status, clean.stdout + clean.stderr).toBe(0);
            expect(clean.stdout).not.toContain('not committed');

            fs.writeFileSync(
                path.join(clone, 'skills', 'testing-framework', 'NEW.md'),
                'untracked\n'
            );
            const dirty = spawnSync(
                process.execPath,
                [
                    path.join(clone, 'install_script', 'index.js'),
                    ...args,
                    '--yes',
                ],
                { cwd: path.join(root, 'project'), encoding: 'utf-8', env }
            );
            expect(dirty.status, dirty.stdout + dirty.stderr).toBe(0);
            expect(dirty.stdout).toContain(WARNING);
            expect(
                fs.existsSync(
                    path.join(
                        env.HOME,
                        '.claude',
                        'skills',
                        'testing-framework',
                        'NEW.md'
                    )
                )
            ).toBe(true);
        }, 120000);

        it('removes what it copied of a new skill folder when the copy fails part-way', () => {
            fs.symlinkSync(
                'missing',
                path.join(clone, 'skills', 'testing-framework', 'zz-broken')
            );

            const result = spawnSync(
                process.execPath,
                [
                    path.join(clone, 'install_script', 'index.js'),
                    ...args,
                    '--yes',
                ],
                { cwd: path.join(root, 'project'), encoding: 'utf-8', env }
            );

            expect(result.status, result.stdout + result.stderr).toBe(1);
            expect(result.stdout).toContain(WARNING);
            expect(
                fs.readdirSync(path.join(env.HOME, '.claude', 'skills'))
            ).toEqual(['lb-setup']);
            const global = path.join(
                env.XDG_CONFIG_HOME,
                'launchbridge',
                'global'
            );
            expect(
                JSON.parse(
                    fs.readFileSync(path.join(global, 'manifest.json'), 'utf-8')
                ).installedTargets
            ).toEqual(['.claude/skills/lb-setup']);
            expect(fs.existsSync(path.join(global, 'pending.json'))).toBe(
                false
            );
        }, 120000);
    }
);
