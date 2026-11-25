// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * `launchbridge update` as the CLI runs it: which modules it loads before the
 * pull, and its exit code once the clone is current. The exit-code tests run
 * the CLI from a throwaway clone of the installer, with HOME, USERPROFILE and
 * XDG_CONFIG_HOME pointing at temporary folders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const INDEX = path.join(REPO_ROOT, 'install_script', 'index.js');
const hasGit = spawnSync('git', ['--version']).status === 0;

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
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

describe('launchbridge update module loading', () => {
    it('loads the global sync before the update pulls', () => {
        // Every module the sync runs must be this release's: one first
        // loaded after the pull would be the new release's.
        const text = fs.readFileSync(INDEX, 'utf8');
        const loaded = text.indexOf("'./lib/globalSync.js'");
        const pulled = text.indexOf('await runUpdate(');
        expect(loaded).toBeGreaterThan(0);
        expect(pulled).toBeGreaterThan(0);
        expect(loaded).toBeLessThan(pulled);
    });
});

describe.skipIf(!hasGit || process.platform === 'win32')(
    'launchbridge update exit codes',
    () => {
        let root;
        let clone;
        let home;
        let state;

        beforeEach(() => {
            root = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-update-cmd-'))
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
            fs.writeFileSync(path.join(clone, '.gitignore'), 'node_modules\n');
            git(root, 'init', '-q', '-b', 'main', clone);
            git(clone, 'add', '-A');
            git(clone, 'commit', '-q', '-m', 'launchbridge');
            git(root, 'clone', '-q', '--bare', clone, 'remote.git');
            git(
                clone,
                'remote',
                'add',
                'origin',
                path.join(root, 'remote.git')
            );

            home = path.join(root, 'home');
            state = path.join(root, 'state');
            fs.mkdirSync(home);
        });
        afterEach(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        function update(cwd) {
            return spawnSync(
                process.execPath,
                [path.join(clone, 'install_script', 'index.js'), 'update'],
                {
                    cwd,
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        HOME: home,
                        USERPROFILE: home,
                        XDG_CONFIG_HOME: state,
                        FORCE_COLOR: '0',
                    },
                }
            );
        }

        function folder(name) {
            const dir = path.join(root, name);
            fs.mkdirSync(dir);
            return dir;
        }

        function writeGlobalRecord(fields) {
            const dir = path.join(state, 'launchbridge', 'global');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'manifest.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    scope: 'global',
                    version: '0.0.0',
                    installMethod: 'copy',
                    skills: ['testing-framework'],
                    skillHashes: {},
                    sourcePath: clone,
                    ...fields,
                })
            );
        }

        const CLOSING =
            'Not every install could be brought up to date; see the warnings above.';

        it('exits 0 when there is nothing to sync', () => {
            const run = update(folder('project'));

            expect(run.stdout).toContain('Already up to date');
            expect(run.stdout).toContain('No LaunchBridge install found');
            expect(run.stdout).not.toContain(CLOSING);
            expect(run.status, run.stdout + run.stderr).toBe(0);
        });

        it('exits 1 when this folder’s local install was not updated', () => {
            const project = folder('project');
            fs.mkdirSync(path.join(root, 'elsewhere'));
            fs.symlinkSync(
                path.join(root, 'elsewhere'),
                path.join(project, '.lb_workspace')
            );

            const run = update(project);

            expect(run.stdout).toContain(
                "Not updating this folder's local install"
            );
            expect(run.stdout).toContain(CLOSING);
            expect(run.status, run.stdout + run.stderr).toBe(1);
        });

        it('exits 1 when the global install could not be fully updated', () => {
            fs.writeFileSync(path.join(home, '.kiro'), 'not a folder\n');
            writeGlobalRecord({
                agents: ['kiro'],
                installedTargets: ['.kiro/skills/testing-framework'],
            });

            const run = update(folder('project'));

            expect(run.stdout).toContain('is not a directory');
            expect(run.stdout).toContain(CLOSING);
            expect(run.status, run.stdout + run.stderr).toBe(1);
        });

        it('exits 0 when the global install came from another clone, changing nothing', () => {
            const other = folder('other-clone');
            writeGlobalRecord({
                agents: ['claude'],
                installedTargets: ['.claude/skills/testing-framework'],
                sourcePath: other,
            });

            const run = update(folder('project'));

            expect(run.stdout).toContain(
                `The global install came from ${other}`
            );
            expect(run.stdout).not.toContain('Repositories pick up');
            expect(run.stdout).toContain(
                'This folder has no local LaunchBridge install.'
            );
            expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
            expect(run.status, run.stdout + run.stderr).toBe(0);
        });
    }
);
