// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The installer's options: an argument it does not know, or an option given
 * no value, stops it with a message rather than being ignored, so a mistyped
 * or empty --scope never leaves a --yes run to install somewhere else.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseCLIFlags } from '../../lib/cliFlags.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(HERE, '..', '..', 'index.js');

const NONE = {
    skills: null,
    agent: null,
    scope: null,
    method: null,
    yes: false,
};

describe('parseCLIFlags', () => {
    it('reads each option with its value as the next argument', () => {
        expect(
            parseCLIFlags([
                '--skills',
                'lb-setup,testing-framework',
                '--agent',
                'claude,kiro',
                '--scope',
                'local',
                '--method',
                'copy',
                '--yes',
            ])
        ).toEqual({
            flags: {
                skills: 'lb-setup,testing-framework',
                agent: 'claude,kiro',
                scope: 'local',
                method: 'copy',
                yes: true,
            },
            error: null,
        });
    });

    it('reads a value given after =', () => {
        expect(
            parseCLIFlags([
                '--scope=local',
                '--skills=all',
                '--agent=claude',
                '--method=symlink',
                '-y',
            ]).flags
        ).toEqual({
            skills: 'all',
            agent: 'claude',
            scope: 'local',
            method: 'symlink',
            yes: true,
        });
    });

    it('reads no options as none given', () => {
        expect(parseCLIFlags([])).toEqual({ flags: NONE, error: null });
    });

    it('refuses an option with an empty value', () => {
        for (const args of [
            ['--scope', ''],
            ['--scope='],
            ['--scope', ' '],
            ['--skills', ','],
            ['--agent', ' , '],
        ]) {
            const { flags, error } = parseCLIFlags(args);
            expect(flags, args.join(' ')).toBeNull();
            expect(error).toMatch(/^--(scope|skills|agent) needs a value: /);
        }
    });

    it('refuses an option with no value after it', () => {
        expect(parseCLIFlags(['--yes', '--scope']).error).toBe(
            "--scope needs a value: 'global' or 'local'."
        );
        expect(parseCLIFlags(['--method', '--yes']).error).toBe(
            "--method needs a value: 'copy' or 'symlink'."
        );
        expect(parseCLIFlags(['--agent', '-y']).error).toBe(
            '--agent needs a value: agent names separated by commas.'
        );
        expect(parseCLIFlags(['--skills']).error).toBe(
            "--skills needs a value: skill or category names separated by commas, or 'all'."
        );
    });

    it('refuses an argument it does not know', () => {
        for (const arg of ['--scop', '--yes=1', '-x', 'local', '--=local']) {
            expect(parseCLIFlags(['--yes', arg, 'local'])).toEqual({
                flags: null,
                error: `Unknown option: '${arg}'. Use --skills, --agent, --scope, --method or --yes.`,
            });
        }
    });

    it('says the update command comes first', () => {
        expect(parseCLIFlags(['--yes', 'update']).error).toBe(
            "'update' must come first: launchbridge update"
        );
    });

    it('shows an unknown argument without its control characters', () => {
        expect(parseCLIFlags(['--sc\u001b[2Jope']).error).toBe(
            "Unknown option: '--sc[2Jope'. Use --skills, --agent, --scope, --method or --yes."
        );
    });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit || process.platform === 'win32')(
    'the installer’s options on the command line',
    () => {
        /**
         * Runs the installer in a new git repository, with HOME, USERPROFILE
         * and XDG_CONFIG_HOME in temporary folders, and lists what it wrote.
         */
        const run = (...args) => {
            const root = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-cli-flags-'))
            );
            const home = path.join(root, 'home');
            const repo = path.join(root, 'repo');
            const state = path.join(root, 'state');
            fs.mkdirSync(home);
            fs.mkdirSync(repo);
            spawnSync('git', ['init', '-q', '.'], { cwd: repo });
            try {
                const result = spawnSync(
                    process.execPath,
                    [INSTALLER, ...args],
                    {
                        cwd: repo,
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
                return {
                    ...result,
                    inHome: fs.readdirSync(home).sort(),
                    inRepo: fs
                        .readdirSync(repo)
                        .filter((name) => name !== '.git')
                        .sort(),
                    stateWritten: fs.existsSync(state),
                };
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        };
        const common = [
            '--agent',
            'claude',
            '--skills',
            'lb-setup',
            '--method',
            'copy',
            '--yes',
        ];

        it.each([
            [['--scope', ''], "--scope needs a value: 'global' or 'local'."],
            [['--scope'], "--scope needs a value: 'global' or 'local'."],
            [
                ['--scop', 'local'],
                "Unknown option: '--scop'. Use --skills, --agent, --scope, --method or --yes.",
            ],
            [
                ['--scope=local', '--force'],
                "Unknown option: '--force'. Use --skills, --agent, --scope, --method or --yes.",
            ],
        ])(
            'exits 1 with a message for %j, writing nothing',
            (args, message) => {
                const result = run(...common, ...args);
                expect(result.status, result.stdout + result.stderr).toBe(1);
                expect(result.stderr.trim()).toBe(message);
                expect(result.inHome).toEqual([]);
                expect(result.inRepo).toEqual([]);
                expect(result.stateWritten).toBe(false);
            },
            60000
        );

        it('installs into the repository for --scope=local', () => {
            const result = run(...common, '--scope=local');
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toMatch(/Scope\s+Local \(repository\)/);
            expect(result.inRepo).toContain('.claude');
            expect(result.inRepo).toContain('.lb_workspace');
            expect(result.inHome).toEqual([]);
        }, 60000);
    }
);
