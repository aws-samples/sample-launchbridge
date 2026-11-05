// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Nothing installs into .venv_lb after lb-setup seals it, so an update whose
 * regenerated python_deps/pyproject.toml asks for more (a skill gained an
 * extra) must send lb-setup back to rebuilding the venv, even when the source
 * dependency set did not change.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPostPullSync } from '../../lib/updater.js';
import { computeDependencySetHash } from '../../lib/contentHash.js';
import { buildMarkdownTable } from '../../lib/setupStatus.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const quietUi = () => ({
    step: () => {},
    success: () => {},
    muted: () => {},
    spacer: () => {},
    warn: () => {},
});

describe.skipIf(process.platform === 'win32')(
    'updater and the venv-setup row',
    () => {
        let repo;
        const config = () => path.join(repo, '.lb_workspace', 'config');
        const status = () =>
            fs.readFileSync(
                path.join(repo, '.lb_workspace', 'setup_status.md'),
                'utf-8'
            );

        beforeEach(async () => {
            repo = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-venv-reset-'))
            );
            fs.mkdirSync(path.join(config(), 'python_deps'), {
                recursive: true,
            });
            fs.writeFileSync(
                path.join(config(), 'python_deps', 'pyproject.toml'),
                '# built before the media extra\n'
            );
            fs.writeFileSync(
                path.join(repo, '.lb_workspace', 'setup_status.md'),
                buildMarkdownTable([
                    { name: 'venv-setup', status: 'complete' },
                    { name: 'mcp-setup', status: 'complete' },
                    { name: 'agents-md-merge', status: 'complete' },
                    { name: 'evaluate-predictions', status: 'complete' },
                ])
            );
            fs.writeFileSync(
                path.join(config(), 'version_manifest.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    version: '1.1.0',
                    timestamp: '2026-10-01T00:00:00.000Z',
                    installMethod: 'copy',
                    agents: ['claude'],
                    skillHashes: { 'evaluate-predictions': 'stale' },
                    installedTargets: ['.claude/skills/evaluate-predictions'],
                    pyprojectHash: await computeDependencySetHash(REPO_ROOT),
                })
            );
        });
        afterEach(() => {
            fs.rmSync(repo, { recursive: true, force: true });
        });

        it('resets venv-setup when the generated dependencies changed', async () => {
            await runPostPullSync(REPO_ROOT, repo, quietUi());

            expect(
                fs.readFileSync(
                    path.join(config(), 'python_deps', 'pyproject.toml'),
                    'utf-8'
                )
            ).toContain('eval_toolkit_media');
            expect(status()).toMatch(/\|\s+venv-setup\s+\|\s+not started\s+\|/);
            const manifest = JSON.parse(
                fs.readFileSync(
                    path.join(config(), 'version_manifest.json'),
                    'utf-8'
                )
            );
            expect(manifest.generatedPyprojectHash).toMatch(/^[0-9a-f]{64}$/);
        }, 60000);
    }
);
