// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * A symlink install makes skill folders links, which older Kiro IDE and
 * Cline releases don't load. The installer says so before it installs, and
 * points at --method copy; it says nothing for a copy install or for agents
 * that load linked folders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { linkedFoldersWarning } from '../../lib/reporter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(HERE, '..', '..', 'index.js');
const LINKS = "don't load skill folders that are links";

describe('linkedFoldersWarning', () => {
    it('names Kiro and Cline for a symlink install', () => {
        expect(
            linkedFoldersWarning('symlink', ['claude', 'kiro', 'cline'])
        ).toBe(
            "Older Kiro and Cline releases don't load skill folders that are links, which is what a symlink install makes. " +
                "If the skills don't appear in Kiro or Cline, install again with --method copy."
        );
        expect(linkedFoldersWarning('symlink', ['kiro'])).toBe(
            "Older Kiro releases don't load skill folders that are links, which is what a symlink install makes. " +
                "If the skills don't appear in Kiro, install again with --method copy."
        );
        expect(linkedFoldersWarning('symlink', ['codex', 'cline'])).toBe(
            "Older Cline releases don't load skill folders that are links, which is what a symlink install makes. " +
                "If the skills don't appear in Cline, install again with --method copy."
        );
    });

    it('says nothing for a copy install', () => {
        expect(linkedFoldersWarning('copy', ['kiro', 'cline'])).toBeNull();
    });

    it('says nothing for agents that load linked skill folders', () => {
        expect(
            linkedFoldersWarning('symlink', [
                'claude',
                'codex',
                'roo',
                'pi',
                'other',
            ])
        ).toBeNull();
    });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit || process.platform === 'win32')(
    'the installer’s warning for a symlink install',
    () => {
        let root;
        let home;
        let state;
        let repo;

        beforeEach(() => {
            root = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-linked-folders-'))
            );
            home = path.join(root, 'home');
            state = path.join(root, 'state');
            repo = path.join(root, 'repo');
            fs.mkdirSync(home);
            fs.mkdirSync(repo);
            spawnSync('git', ['init', '-q', '.'], { cwd: repo });
        });

        afterEach(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        const install = (...args) =>
            spawnSync(
                process.execPath,
                [INSTALLER, '--skills', 'lb-setup', '--yes', ...args],
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

        it('is given for Kiro before the summary', () => {
            const result = install(
                '--scope',
                'local',
                '--agent',
                'kiro',
                '--method',
                'symlink'
            );

            expect(result.status, result.stdout + result.stderr).toBe(0);
            const warning = result.stdout.indexOf(
                `Older Kiro releases ${LINKS}`
            );
            expect(warning).toBeGreaterThan(-1);
            expect(warning).toBeLessThan(
                result.stdout.indexOf('Installation Summary')
            );
            expect(result.stdout).toContain('install again with --method copy');
        }, 120000);

        it('is given for Cline in a global install', () => {
            const result = install(
                '--scope',
                'global',
                '--agent',
                'cline',
                '--method',
                'symlink'
            );

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain(`Older Cline releases ${LINKS}`);
        }, 120000);

        it('is not given for a copy install', () => {
            const result = install(
                '--scope',
                'local',
                '--agent',
                'kiro,cline',
                '--method',
                'copy'
            );

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).not.toContain(LINKS);
        }, 120000);

        it('is not given for Claude Code', () => {
            const result = install(
                '--scope',
                'local',
                '--agent',
                'claude',
                '--method',
                'symlink'
            );

            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).not.toContain(LINKS);
        }, 120000);
    }
);
