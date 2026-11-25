// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Every test file runs with its home folder and LaunchBridge's state
 * directory in a temporary folder (setup/isolateState.js), and so does every
 * process a test starts, so a test that installs never writes into the
 * developer's own home. Tests that run Python run the interpreter python3
 * started before the home folder moved (LB_TEST_PYTHON).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { isPathWithin } from '../../lib/pathSanitizer.js';

const SETUP = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'setup',
    'isolateState.js'
);
// The interpreter the shim below starts.
const probe = spawnSync(
    'python3',
    ['-I', '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf-8' }
);
const python = probe.status === 0 ? probe.stdout.trim() : '';

describe('the test setup', () => {
    it('puts the home folder and the state directory in a temporary folder', () => {
        const root = path.dirname(os.homedir());
        expect(path.basename(root)).toMatch(/^lb-test-/);
        expect(isPathWithin(root, fs.realpathSync(os.tmpdir()))).toBe(true);
        expect(os.homedir()).toBe(path.join(root, 'home'));
        expect(process.env.HOME).toBe(os.homedir());
        expect(process.env.USERPROFILE).toBe(os.homedir());
        expect(process.env.XDG_CONFIG_HOME).toBe(path.join(root, 'state'));
    });

    it('gives the processes a test starts the same home folder', () => {
        const result = spawnSync(
            process.execPath,
            [
                '-e',
                'process.stdout.write(JSON.stringify([require("os").homedir(), process.env.XDG_CONFIG_HOME]))',
            ],
            { encoding: 'utf-8' }
        );

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([
            os.homedir(),
            process.env.XDG_CONFIG_HOME,
        ]);
    });

    it.skipIf(process.platform === 'win32' || !python)(
        'finds Python before it moves the home folder, for a python3 that needs the home folder',
        () => {
            // Like a version manager's shim, it starts Python only with the
            // home folder it was set up in.
            const dir = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-shim-'))
            );
            try {
                const home = path.join(dir, 'home');
                fs.mkdirSync(path.join(home, '.shim'), { recursive: true });
                const shim = path.join(dir, 'bin', 'python3');
                fs.mkdirSync(path.dirname(shim));
                fs.writeFileSync(
                    shim,
                    `#!/bin/sh\n[ -d "$HOME/.shim" ] || exit 126\nexec "${python}" "$@"\n`,
                    { mode: 0o755 }
                );
                const env = {
                    ...process.env,
                    HOME: home,
                    USERPROFILE: home,
                    PATH: `${path.dirname(shim)}${path.delimiter}${process.env.PATH}`,
                    TMPDIR: dir,
                };
                delete env.LB_TEST_PYTHON;

                const result = spawnSync(
                    process.execPath,
                    [
                        '--input-type=module',
                        '-e',
                        `await import(${JSON.stringify(pathToFileURL(SETUP).href)});` +
                            'process.stdout.write(String(process.env.LB_TEST_PYTHON));',
                    ],
                    { encoding: 'utf-8', env }
                );

                expect(result.status, result.stderr).toBe(0);
                const found = result.stdout;
                expect(path.isAbsolute(found), found).toBe(true);
                // This test's home folder has moved: the shim no longer
                // starts, and what the setup found still does.
                expect(spawnSync(shim, ['-c', '']).status).toBe(126);
                expect(spawnSync(found, ['-I', '-c', '']).status).toBe(0);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    );
});
