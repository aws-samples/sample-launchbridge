// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Files the installer writes into the target repository (CLAUDE.md, AGENTS.md,
 * the version manifest) are never written through a symlink, and a repository
 * path containing ".." in a directory name is used as given.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { copyClaudeMd } from '../../lib/claudeMd.js';
import { copyAgentsSteering } from '../../lib/agentsSteering.js';
import { writeManifest } from '../../lib/versionManifest.js';

describe.skipIf(process.platform === 'win32')(
    'target-repository writes',
    () => {
        let base;
        let repo;
        let outside;

        beforeEach(() => {
            base = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-target-writes-'))
            );
            repo = path.join(base, 'repo');
            outside = path.join(base, 'operator-data');
            fs.mkdirSync(repo);
            fs.mkdirSync(outside);
        });
        afterEach(() => {
            fs.rmSync(base, { recursive: true, force: true });
        });

        it('refuses a symlinked CLAUDE.md and leaves its target untouched', async () => {
            const victim = path.join(outside, 'profile');
            fs.writeFileSync(victim, 'export PATH=/usr/bin\n');
            fs.symlinkSync(victim, path.join(repo, 'CLAUDE.md'));

            const result = await copyClaudeMd(repo);

            expect(result.status).toBe('error');
            expect(fs.readFileSync(victim, 'utf8')).toBe(
                'export PATH=/usr/bin\n'
            );
        });

        it('refuses a dangling symlinked AGENTS.md instead of creating its target', async () => {
            const victim = path.join(outside, 'created-by-installer.md');
            fs.symlinkSync(victim, path.join(repo, 'AGENTS.md'));

            const result = await copyAgentsSteering(repo);

            expect(result.status).toBe('error');
            expect(fs.existsSync(victim)).toBe(false);
        });

        it('leaves a symlinked AGENTS.md alone and asks for a manual merge', async () => {
            fs.mkdirSync(path.join(repo, 'docs'));
            const shared = path.join(repo, 'docs', 'AGENTS.md');
            fs.writeFileSync(shared, '# team rules\n');
            fs.symlinkSync(shared, path.join(repo, 'AGENTS.md'));

            const result = await copyAgentsSteering(repo);

            expect(result.status).toBe('error');
            expect(result.error).toMatch(/symlink/);
            expect(result.error).toMatch(/AGENTS_LB\.md/);
            expect(result.error).toMatch(/manually/);
            expect(fs.readFileSync(shared, 'utf8')).toBe('# team rules\n');
            expect(
                fs.existsSync(
                    path.join(repo, '.lb_workspace', 'steering', 'AGENTS_LB.md')
                )
            ).toBe(true);
        });

        it('leaves a CLAUDE.md symlinked to AGENTS.md alone', async () => {
            fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# team rules\n');
            fs.symlinkSync('AGENTS.md', path.join(repo, 'CLAUDE.md'));

            const result = await copyClaudeMd(repo);

            expect(result.status).toBe('error');
            expect(result.error).toMatch(/@AGENTS\.md/);
            expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(
                '# team rules\n'
            );
        });

        it('refuses to write the manifest through a symlinked .lb_workspace', async () => {
            fs.symlinkSync(outside, path.join(repo, '.lb_workspace'));

            await expect(
                writeManifest(repo, { version: '1.1.0', skills: [] })
            ).rejects.toThrow(/symlink/);
            expect(fs.readdirSync(outside)).toEqual([]);
        });

        it('writes CLAUDE.md in a repository whose path contains ".."', async () => {
            const dotted = path.join(base, 'a..b', 'repo');
            fs.mkdirSync(dotted, { recursive: true });

            const result = await copyClaudeMd(dotted);

            expect(result.status).toBe('created');
            expect(
                fs.readFileSync(path.join(dotted, 'CLAUDE.md'), 'utf8')
            ).toBe('@AGENTS.md\n');
        });
    }
);
