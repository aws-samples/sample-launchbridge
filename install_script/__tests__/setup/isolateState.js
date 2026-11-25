// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Points LaunchBridge's per-user state directory and the home folder at a
 * temporary folder for every test, and for installer processes the tests
 * start, so a test run never writes into the developer's own
 * ~/.config/launchbridge or into an agent's skills folder in their home (an
 * installer run with --yes and no --scope installs there). A test that needs
 * a particular home sets its own.
 *
 * Tests that run Python run LB_TEST_PYTHON, the interpreter python3 starts,
 * found before the home folder moves: python3 can be a version manager's shim
 * that finds its interpreter through the home folder. It is empty when there
 * is no python3.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

if (process.env.LB_TEST_PYTHON === undefined) {
    const found = spawnSync(
        'python3',
        ['-I', '-c', 'import sys; print(sys.executable)'],
        { encoding: 'utf-8' }
    );
    process.env.LB_TEST_PYTHON = found.status === 0 ? found.stdout.trim() : '';
}

const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lb-test-'))
);
const home = path.join(root, 'home');
const state = path.join(root, 'state');
fs.mkdirSync(home);
fs.mkdirSync(state);

process.env.XDG_CONFIG_HOME = state;
process.env.HOME = home;
process.env.USERPROFILE = home;

// In a worker thread (vitest's threads pool) os.homedir() ignores HOME set
// here, so the tests would run against the real home folder.
if (os.homedir() !== home) {
    throw new Error(
        `The tests could not move the home folder to ${home} (os.homedir() is ${os.homedir()}). Run them in vitest's forks pool, the default.`
    );
}
