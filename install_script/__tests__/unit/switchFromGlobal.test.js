// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * A local install in a repository lb-setup prepared for the global install
 * (a status file, no local manifest, and lb-setup's global_setup.json record
 * in the repository's state directory) switches the repository to the local
 * install. The setup done there is kept, except venv-setup when python_deps/
 * changes and agents-md-merge when AGENTS_LB.md is staged. Without the record
 * the same files are an interrupted local install, recovered as before.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { determineLifecycle } from '../../lib/lifecycleOrchestrator.js';
import {
    buildLifecycleReport,
    displayLifecycleReport,
} from '../../lib/reporter.js';
import {
    GLOBAL_SETUP_RECORD,
    buildGlobalAssets,
    preparedForGlobalInstall,
} from '../../lib/globalAssets.js';
import { repoStateDir } from '../../lib/stateDir.js';
import {
    buildMarkdownTable,
    parseSetupStatusContent,
} from '../../lib/setupStatus.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(HERE, '..', '..', 'index.js');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SWITCH =
    'Switching this repository from the global LaunchBridge install to a local one';
const RECOVERY = 'Recovering from interrupted installation...';

/** A temporary repository, with XDG_CONFIG_HOME in the same folder. */
function useRepository(prefix) {
    const ctx = {};
    let saved;
    beforeEach(() => {
        ctx.root = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        );
        ctx.home = path.join(ctx.root, 'home');
        ctx.state = path.join(ctx.root, 'state');
        ctx.repo = path.join(ctx.root, 'repo');
        fs.mkdirSync(ctx.home);
        fs.mkdirSync(ctx.repo);
        saved = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = ctx.state;
    });
    afterEach(() => {
        process.env.XDG_CONFIG_HOME = saved;
        fs.rmSync(ctx.root, { recursive: true, force: true });
    });
    return ctx;
}

/** Writes lb-setup's record of preparing `repo` for the global install. */
function writeSetupRecord(repo, text) {
    const dir = repoStateDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, GLOBAL_SETUP_RECORD), text);
}

describe('determineLifecycle without a local manifest', () => {
    const context = {
        existingManifest: null,
        currentVersion: '1.3.0',
        selectedSkills: ['lb-setup', 'testing-framework'],
        currentHashes: {},
        deliveryMethod: 'git',
        installMethod: 'copy',
        sourcePath: '/launchbridge',
        statusFileExists: true,
    };

    it('switches a repository lb-setup prepared for the global install', () => {
        expect(
            determineLifecycle({
                ...context,
                preparedForGlobal: true,
                pythonDepsChanged: true,
                agentsLbStaged: true,
            })
        ).toMatchObject({
            scenario: 'switch_from_global',
            skillsToInstall: ['lb-setup', 'testing-framework'],
            skillsToReset: [],
            skillsToRemove: [],
            resetVenvSetup: true,
            resetMcpSetup: false,
            resetAgentsMerge: true,
        });
    });

    it('keeps venv-setup and agents-md-merge when the switch changes neither', () => {
        expect(
            determineLifecycle({
                ...context,
                preparedForGlobal: true,
                pythonDepsChanged: false,
                agentsLbStaged: false,
            })
        ).toMatchObject({
            scenario: 'switch_from_global',
            resetVenvSetup: false,
            resetMcpSetup: false,
            resetAgentsMerge: false,
        });
    });

    it('recovers an interrupted local install as before', () => {
        expect(
            determineLifecycle({
                ...context,
                pythonDepsChanged: true,
                agentsLbStaged: true,
            })
        ).toMatchObject({
            scenario: 'interrupt_recovery',
            skillsToInstall: ['lb-setup', 'testing-framework'],
            resetVenvSetup: false,
            resetMcpSetup: false,
            resetAgentsMerge: false,
        });
    });

    it('is a fresh install without a status file', () => {
        expect(
            determineLifecycle({
                ...context,
                statusFileExists: false,
                preparedForGlobal: true,
            }).scenario
        ).toBe('fresh_install');
    });
});

describe('the report of a switch from the global install', () => {
    let output;
    let originalLog;

    beforeEach(() => {
        output = [];
        originalLog = console.log;
        console.log = (...args) => {
            output.push(args.join(' '));
        };
    });

    afterEach(() => {
        console.log = originalLog;
    });

    const results = {
        successful: [{ skillName: 'lb-setup', agent: 'claude' }],
        failed: [],
        skipped: [],
    };
    const decision = (scenario, resets = {}) => ({
        scenario,
        skillsToInstall: ['lb-setup'],
        skillsToReset: [],
        skillsToRemove: [],
        skillsUnchanged: [],
        resetVenvSetup: false,
        resetMcpSetup: false,
        resetAgentsMerge: false,
        ...resets,
    });

    it('says the repository is switched, and what lb-setup sets up again', () => {
        displayLifecycleReport(
            buildLifecycleReport(
                results,
                decision('switch_from_global', {
                    resetVenvSetup: true,
                    resetAgentsMerge: true,
                })
            )
        );
        const text = output.join('\n');
        expect(text).toContain(SWITCH);
        expect(text).not.toContain(RECOVERY);
        expect(text).toContain('Python dependencies changed');
        expect(text).toContain('AGENTS.md updated');
        expect(text).toContain('run the skill "lb-setup"');
    });

    it('still reports an interrupted install as a recovery', () => {
        displayLifecycleReport(
            buildLifecycleReport(results, decision('interrupt_recovery'))
        );
        const text = output.join('\n');
        expect(text).toContain(RECOVERY);
        expect(text).not.toContain(SWITCH);
    });
});

describe('preparedForGlobalInstall', () => {
    const ctx = useRepository('lb-prepared-');

    it('finds the record lb-setup keeps outside the repository', async () => {
        expect(await preparedForGlobalInstall(ctx.repo)).toBe(false);
        writeSetupRecord(ctx.repo, '{"format": 1, "skills": ["lb-setup"]}\n');
        expect(await preparedForGlobalInstall(ctx.repo)).toBe(true);
    });

    it('ignores a record that is not a JSON object', async () => {
        for (const text of ['{', '[]', 'null', '"prepared"']) {
            writeSetupRecord(ctx.repo, text);
            expect(await preparedForGlobalInstall(ctx.repo)).toBe(false);
        }
    });

    it('ignores a record inside the repository', async () => {
        process.env.XDG_CONFIG_HOME = path.join(ctx.repo, '.config');
        writeSetupRecord(ctx.repo, '{"format": 1}\n');
        expect(await preparedForGlobalInstall(ctx.repo)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
        'ignores a record reached through a link into the repository',
        async () => {
            const inside = path.join(ctx.repo, 'state');
            fs.mkdirSync(inside);
            fs.writeFileSync(
                path.join(inside, GLOBAL_SETUP_RECORD),
                '{"format": 1}\n'
            );
            const dir = repoStateDir(ctx.repo);
            fs.mkdirSync(path.dirname(dir), { recursive: true });
            fs.symlinkSync(inside, dir);
            expect(await preparedForGlobalInstall(ctx.repo)).toBe(false);
        }
    );
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit || process.platform === 'win32')(
    'a local install in a repository lb-setup prepared for the global install',
    () => {
        const ctx = useRepository('lb-switch-');
        const selection = ['lb-setup', 'testing-framework'];

        beforeEach(() => {
            spawnSync('git', ['init', '-q', '.'], { cwd: ctx.repo });
        });

        /**
         * What bootstrap_workspace.py init leaves after lb-setup set the
         * repository up for a global install of `skills`, every step done:
         * python_deps/ as that install generated it.
         */
        const prepare = ({ record = true, skills = selection } = {}) => {
            const workspace = path.join(ctx.repo, '.lb_workspace');
            const deps = path.join(workspace, 'config', 'python_deps');
            const generated = buildGlobalAssets({
                sourcePath: REPO_ROOT,
                selectedSkills: skills,
            });
            fs.mkdirSync(deps, { recursive: true });
            for (const name of ['pyproject.toml', 'constraints.txt']) {
                fs.writeFileSync(
                    path.join(deps, name),
                    generated.get(`python_deps/${name}`)
                );
            }
            fs.writeFileSync(
                path.join(workspace, 'setup_status.md'),
                buildMarkdownTable(
                    [
                        'venv-setup',
                        'mcp-setup',
                        'agents-md-merge',
                        'testing-framework',
                    ].map((name) => ({ name, status: 'complete' }))
                )
            );
            fs.copyFileSync(
                path.join(REPO_ROOT, 'agent_steering', 'AGENTS.md'),
                path.join(ctx.repo, 'AGENTS.md')
            );
            if (record) {
                writeSetupRecord(
                    ctx.repo,
                    JSON.stringify({ format: 1, skills }) + '\n'
                );
            }
        };
        const install = (...skills) =>
            spawnSync(
                process.execPath,
                [
                    INSTALLER,
                    '--scope',
                    'local',
                    '--agent',
                    'claude',
                    '--method',
                    'copy',
                    '--skills',
                    skills.join(','),
                    '--yes',
                ],
                {
                    cwd: ctx.repo,
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        HOME: ctx.home,
                        USERPROFILE: ctx.home,
                        XDG_CONFIG_HOME: ctx.state,
                        FORCE_COLOR: '0',
                    },
                }
            );
        const statuses = () =>
            parseSetupStatusContent(
                fs.readFileSync(
                    path.join(ctx.repo, '.lb_workspace', 'setup_status.md'),
                    'utf-8'
                )
            );
        const staged = () =>
            fs.existsSync(
                path.join(ctx.repo, '.lb_workspace', 'steering', 'AGENTS_LB.md')
            );

        it('reports the switch, and keeps venv-setup when python_deps/ stays the same', () => {
            prepare();

            const result = install(...selection);

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain(SWITCH);
            expect(result.stdout).not.toContain(RECOVERY);
            expect(result.stdout).not.toContain('Python dependencies changed');
            const rows = statuses();
            expect(rows.get('venv-setup')).toBe('complete');
            expect(rows.get('mcp-setup')).toBe('complete');
            expect(rows.get('testing-framework')).toBe('complete');
            // AGENTS_LB.md is staged beside the AGENTS.md lb-setup made.
            expect(staged()).toBe(true);
            expect(rows.get('agents-md-merge')).toBe('not started');
        }, 120000);

        it('sets venv-setup up again when python_deps/ changes', () => {
            prepare();

            const result = install(...selection, 'indexing-and-qa');

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain(SWITCH);
            expect(result.stdout).toContain(
                'Python dependencies changed — virtual environment will be rebuilt'
            );
            const rows = statuses();
            expect(rows.get('venv-setup')).toBe('not started');
            expect(rows.get('testing-framework')).toBe('complete');
            expect(
                fs.readFileSync(
                    path.join(
                        ctx.repo,
                        '.lb_workspace',
                        'config',
                        'python_deps',
                        'pyproject.toml'
                    ),
                    'utf-8'
                )
            ).toContain('indexing_and_qa');
        }, 120000);

        it('keeps venv-setup for the same skills given in another order', () => {
            // Two of them have extras: the global install sorted them.
            const skills = ['lb-setup', 'testing-framework', 'indexing-and-qa'];
            prepare({ skills });

            const result = install(...skills);

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain(SWITCH);
            expect(result.stdout).not.toContain('Python dependencies changed');
            expect(statuses().get('venv-setup')).toBe('complete');
        }, 120000);

        it('keeps agents-md-merge when nothing is staged to merge', () => {
            prepare();
            fs.rmSync(path.join(ctx.repo, 'AGENTS.md'));

            const result = install(...selection);

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain(SWITCH);
            expect(staged()).toBe(false);
            expect(statuses().get('agents-md-merge')).toBe('complete');
        }, 120000);

        it('recovers an interrupted local install, without a global setup record, as before', () => {
            prepare({ record: false });

            const result = install(...selection, 'indexing-and-qa');

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain(RECOVERY);
            expect(result.stdout).not.toContain(SWITCH);
            const rows = statuses();
            expect(rows.get('venv-setup')).toBe('complete');
            expect(rows.get('agents-md-merge')).toBe('complete');
        }, 120000);
    }
);
