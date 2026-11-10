// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A packaged copy of LaunchBridge (npx) lacks the symlinks npm pack drops.
 * restorePackedLinks recreates them, never touches an existing entry, and the
 * PACKED_LINKS table matches the symlinks actually committed in the repository.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { PACKED_LINKS, restorePackedLinks } from '../../lib/packedLinks.js';
import { computeContentHash } from '../../lib/contentHash.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

let tmp;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-packed-links-'));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

function writeTarget(root, rel) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, 'a.py'), 'print(1)\n');
    fs.mkdirSync(path.join(root, rel, 'sub'));
    fs.writeFileSync(path.join(root, rel, 'sub', 'b.py'), 'print(2)\n');
}

describe('PACKED_LINKS', () => {
    it('lists exactly the symlinks committed in the repository', () => {
        let out;
        try {
            out = execFileSync('git', ['ls-files', '-s'], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
            });
        } catch {
            return; // not a git checkout (e.g. running from a package)
        }
        const committed = out
            .split('\n')
            .filter((line) => line.startsWith('120000 '))
            .map((line) => line.split('\t')[1])
            .sort();
        expect(Object.keys(PACKED_LINKS).sort()).toEqual(committed);
        for (const [link, target] of Object.entries(PACKED_LINKS)) {
            const actual = fs.readlinkSync(path.join(REPO_ROOT, link));
            const resolved = path.resolve(
                path.dirname(path.join(REPO_ROOT, link)),
                actual
            );
            expect(resolved).toBe(path.join(REPO_ROOT, target));
        }
    });
});

describe('restorePackedLinks', () => {
    const links = { 'skills/s/lib/dep': 'project_dependencies/dep' };

    it('recreates a missing link as a relative symlink to the target', async () => {
        writeTarget(tmp, 'project_dependencies/dep');
        fs.mkdirSync(path.join(tmp, 'skills', 's'), { recursive: true });

        const result = await restorePackedLinks(tmp, links);

        expect(result.restored).toEqual(['skills/s/lib/dep']);
        const linkPath = path.join(tmp, 'skills/s/lib/dep');
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(linkPath)).toBe(
            path.join('..', '..', '..', 'project_dependencies', 'dep')
        );
        expect(
            fs.readFileSync(path.join(linkPath, 'sub', 'b.py'), 'utf8')
        ).toBe('print(2)\n');
    });

    it('hashes the restored skill the same as a clone with the symlink', async () => {
        // "clone": link present
        const clone = path.join(tmp, 'clone');
        writeTarget(clone, 'project_dependencies/dep');
        fs.mkdirSync(path.join(clone, 'skills', 's', 'lib'), {
            recursive: true,
        });
        fs.writeFileSync(path.join(clone, 'skills', 's', 'SKILL.md'), '# s\n');
        fs.symlinkSync(
            path.join('..', '..', '..', 'project_dependencies', 'dep'),
            path.join(clone, 'skills', 's', 'lib', 'dep'),
            'dir'
        );
        // "package": link dropped
        const pkg = path.join(tmp, 'pkg');
        writeTarget(pkg, 'project_dependencies/dep');
        fs.mkdirSync(path.join(pkg, 'skills', 's'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'skills', 's', 'SKILL.md'), '# s\n');

        await restorePackedLinks(pkg, links);

        const hashOf = (root) =>
            computeContentHash(path.join(root, 'skills', 's'), {
                allowedRoot: fs.realpathSync(root),
            });
        expect(await hashOf(pkg)).toBe(await hashOf(clone));
        // and the link content is actually part of the digest
        fs.writeFileSync(path.join(pkg, 'project_dependencies/dep/a.py'), 'x');
        expect(await hashOf(pkg)).not.toBe(await hashOf(clone));
    });

    it('leaves an existing entry alone and is idempotent', async () => {
        writeTarget(tmp, 'project_dependencies/dep');
        fs.mkdirSync(path.join(tmp, 'skills/s/lib/dep'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'skills/s/lib/dep/own.txt'), 'x');

        const first = await restorePackedLinks(tmp, links);
        const second = await restorePackedLinks(tmp, links);

        expect(first).toEqual({ restored: [], copied: [], skipped: [] });
        expect(second).toEqual(first);
        expect(
            fs.lstatSync(path.join(tmp, 'skills/s/lib/dep')).isDirectory()
        ).toBe(true);
        expect(fs.existsSync(path.join(tmp, 'skills/s/lib/dep/own.txt'))).toBe(
            true
        );
    });

    it('skips a link whose target is missing', async () => {
        fs.mkdirSync(path.join(tmp, 'skills', 's'), { recursive: true });

        const result = await restorePackedLinks(tmp, links);

        expect(result).toEqual({
            restored: [],
            copied: [],
            skipped: ['skills/s/lib/dep'],
        });
        expect(fs.existsSync(path.join(tmp, 'skills/s/lib/dep'))).toBe(false);
    });
});
