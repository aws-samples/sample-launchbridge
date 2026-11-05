// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Points LaunchBridge's per-user state directory at a temporary folder for every
 * test, and for installer processes the tests start, so a test run never writes
 * into the developer's own ~/.config/launchbridge.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lb-test-state-')
);
