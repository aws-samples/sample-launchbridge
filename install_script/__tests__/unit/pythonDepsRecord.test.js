// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The installer records the python_deps/ files it writes, outside the
 * repository, and lb-setup's check (venv_identity.py deps) accepts exactly those
 * files: the two sides derive the same state path and digests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
    writePyprojectConfig,
    PYTHON_DEPS_RECORD,
} from '../../lib/venvSetup.js';
import { repoStateDir } from '../../lib/stateDir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '..', '..', '..');
const CHECK = path.join(
    SOURCE,
    'skills',
    'lb-setup',
    'scripts',
    'venv_identity.py'
);
const hasPython = spawnSync('python3', ['--version']).status === 0;

describe('python_deps record', () => {
    let repo;
    const deps = () =>
        path.join(repo, '.lb_workspace', 'config', 'python_deps');
    const check = () =>
        spawnSync('python3', ['-I', CHECK, 'deps', repo], {
            encoding: 'utf-8',
        });

    beforeEach(() => {
        repo = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'lb-deps-'))
        );
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    it('records the digests outside the repository', async () => {
        const result = await writePyprojectConfig(
            repo,
            ['indexing-and-qa'],
            SOURCE
        );
        expect(result.success).toBe(true);

        const record = path.join(repoStateDir(repo), PYTHON_DEPS_RECORD);
        expect(path.relative(repo, record).startsWith('..')).toBe(true);
        expect(fs.statSync(record).mode & 0o077).toBe(0);
        expect(
            Object.keys(JSON.parse(fs.readFileSync(record, 'utf-8'))).sort()
        ).toEqual(['constraints.txt', 'pyproject.toml']);
    });

    it.skipIf(!hasPython)(
        'is accepted by lb-setup, and a changed file is not',
        async () => {
            await writePyprojectConfig(repo, ['indexing-and-qa'], SOURCE);
            expect(check().status).toBe(0);

            fs.appendFileSync(
                path.join(deps(), 'constraints.txt'),
                '--extra-index-url https://example.invalid/\n'
            );
            const changed = check();
            expect(changed.status).toBe(1);
            expect(changed.stdout).toContain('constraints.txt');
        }
    );

    it.skipIf(!hasPython)(
        'refuses python_deps that arrived with no installer record',
        async () => {
            fs.mkdirSync(deps(), { recursive: true });
            fs.writeFileSync(
                path.join(deps(), 'pyproject.toml'),
                '[project]\nname = "x"\n'
            );
            fs.writeFileSync(path.join(deps(), 'constraints.txt'), '');
            const planted = check();
            expect(planted.status).toBe(1);
            expect(planted.stdout).toContain(
                're-run the LaunchBridge installer'
            );
        }
    );

    it.skipIf(!hasPython)(
        'clears files that arrived in python_deps/',
        async () => {
            fs.mkdirSync(deps(), { recursive: true });
            fs.writeFileSync(path.join(deps(), 'setup.py'), 'import os\n');
            fs.writeFileSync(
                path.join(deps(), 'sitecustomize.py'),
                'import os\n'
            );
            await writePyprojectConfig(repo, ['indexing-and-qa'], SOURCE);
            expect(fs.readdirSync(deps()).sort()).toEqual([
                'constraints.txt',
                'pyproject.toml',
            ]);
            expect(check().status).toBe(0);
        }
    );

    it.skipIf(!hasPython)(
        'refuses an extra file next to the recorded ones',
        async () => {
            await writePyprojectConfig(repo, ['indexing-and-qa'], SOURCE);
            fs.writeFileSync(path.join(deps(), 'setup.py'), 'import os\n');
            const extra = check();
            expect(extra.status).toBe(1);
            expect(extra.stdout).toContain('setup.py');
        }
    );

    it('refuses a state directory inside the repository', async () => {
        const saved = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = path.join(repo, '.lb_workspace', 'xdg');
        try {
            const result = await writePyprojectConfig(
                repo,
                ['indexing-and-qa'],
                SOURCE
            );
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/inside the repository/);
        } finally {
            process.env.XDG_CONFIG_HOME = saved;
        }
    });
});
