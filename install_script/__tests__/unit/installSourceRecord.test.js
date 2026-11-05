// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The LaunchBridge source a repository was installed from is recorded in the
 * user's state directory, where verify_integrity.py reads it: the manifest in
 * the repository can be replaced by a pulled file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    writeManifest,
    INSTALL_SOURCE_RECORD,
} from '../../lib/versionManifest.js';
import { repoStateDir } from '../../lib/stateDir.js';

describe('install source record', () => {
    let repo;
    beforeEach(() => {
        repo = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'lb-source-'))
        );
    });
    afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('is written outside the repository with the manifest', async () => {
        const source = path.join(os.tmpdir(), 'launchbridge-src');
        await writeManifest(repo, { sourcePath: source, skillHashes: {} });
        const record = path.join(repoStateDir(repo), INSTALL_SOURCE_RECORD);
        expect(path.relative(repo, record).startsWith('..')).toBe(true);
        expect(JSON.parse(fs.readFileSync(record, 'utf-8'))).toEqual({
            sourcePath: path.resolve(source),
        });
        expect(fs.statSync(record).mode & 0o077).toBe(0);
    });
});
