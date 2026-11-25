// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * writeGlobalAssets replaces the generated folder as a whole: the old set is
 * moved aside until the new one is renamed into place, and moved back when
 * that rename fails, so lb-setup never finds the folder missing because a
 * rename failed (on Windows a scanner holding a handle makes it fail for a
 * moment).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    folderHolds,
    keepPreviousAssetFields,
    RECORDED_ASSET_FIELDS,
    writeGlobalAssets,
} from '../../lib/globalAssets.js';

const isWindows = process.platform === 'win32';

/** A generated set, labelled so two sets differ in every file. */
const assets = (label) =>
    new Map([
        ['python_deps/constraints.txt', Buffer.from(`${label} constraints\n`)],
        ['python_deps/pyproject.toml', Buffer.from(`${label} pyproject\n`)],
        ['setup_status.md', Buffer.from(`${label} status\n`)],
    ]);

/** fs.rename, except that it fails with EPERM where `fails(from, to)`. */
const renameFailing = (fails) => async (from, to) => {
    if (fails(from, to)) {
        throw Object.assign(
            new Error(
                `EPERM: operation not permitted, rename '${from}' -> '${to}'`
            ),
            { code: 'EPERM' }
        );
    }
    return fs.promises.rename(from, to);
};

describe('writeGlobalAssets', () => {
    let root;
    let dir;

    beforeEach(() => {
        root = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'lb-assets-write-'))
        );
        dir = path.join(root, 'global', 'generated');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const besideDir = () => fs.readdirSync(path.dirname(dir)).sort();
    const intoPlace = (from, to) => to === dir && from.endsWith('.tmp');

    it('replaces the old set, leaving nothing else beside it', async () => {
        await writeGlobalAssets(assets('old'), dir);
        await writeGlobalAssets(assets('new'), dir);

        expect(await folderHolds(assets('new'), dir)).toBe(true);
        expect(besideDir()).toEqual(['generated']);
    });

    it('keeps the old set when the new one cannot be renamed into place', async () => {
        await writeGlobalAssets(assets('old'), dir);

        await expect(
            writeGlobalAssets(assets('new'), dir, {
                rename: renameFailing(intoPlace),
            })
        ).rejects.toMatchObject({ code: 'EPERM' });

        expect(await folderHolds(assets('old'), dir)).toBe(true);
        expect(besideDir()).toEqual(['generated']);
    });

    it('changes nothing when the old set cannot be moved aside', async () => {
        await writeGlobalAssets(assets('old'), dir);

        await expect(
            writeGlobalAssets(assets('new'), dir, {
                rename: renameFailing((from) => from === dir),
            })
        ).rejects.toMatchObject({ code: 'EPERM' });

        expect(await folderHolds(assets('old'), dir)).toBe(true);
        expect(besideDir()).toEqual(['generated']);
    });

    it('keeps the old set beside the folder when it cannot be moved back either', async () => {
        await writeGlobalAssets(assets('old'), dir);

        // The error is the failed rename into place, not the one back.
        await expect(
            writeGlobalAssets(assets('new'), dir, {
                rename: renameFailing((from, to) => to === dir),
            })
        ).rejects.toThrow(/\.tmp' -> /);

        const left = besideDir();
        expect(left).toHaveLength(1);
        expect(left[0]).toMatch(/^\.generated\.[0-9a-f]{16}\.old$/);
        expect(
            await folderHolds(
                assets('old'),
                path.join(path.dirname(dir), left[0])
            )
        ).toBe(true);
    });

    it('writes the set where there was none, and removes it when the rename fails', async () => {
        await expect(
            writeGlobalAssets(assets('new'), dir, {
                rename: renameFailing(intoPlace),
            })
        ).rejects.toMatchObject({ code: 'EPERM' });
        expect(besideDir()).toEqual([]);

        await writeGlobalAssets(assets('new'), dir);
        expect(await folderHolds(assets('new'), dir)).toBe(true);
    });

    describe.skipIf(isWindows)('a link at the folder’s path', () => {
        let elsewhere;

        beforeEach(() => {
            elsewhere = path.join(root, 'elsewhere');
            fs.mkdirSync(elsewhere);
            fs.writeFileSync(path.join(elsewhere, 'mine.txt'), 'mine\n');
            fs.mkdirSync(path.dirname(dir), { recursive: true });
            fs.symlinkSync(elsewhere, dir);
        });

        it('is removed, never followed', async () => {
            await writeGlobalAssets(assets('new'), dir);

            expect(fs.lstatSync(dir).isSymbolicLink()).toBe(false);
            expect(await folderHolds(assets('new'), dir)).toBe(true);
            expect(besideDir()).toEqual(['generated']);
            expect(fs.readdirSync(elsewhere)).toEqual(['mine.txt']);
        });

        it('is put back, unfollowed, when the new set cannot be renamed into place', async () => {
            await expect(
                writeGlobalAssets(assets('new'), dir, {
                    rename: renameFailing(intoPlace),
                })
            ).rejects.toMatchObject({ code: 'EPERM' });

            expect(fs.readlinkSync(dir)).toBe(elsewhere);
            expect(besideDir()).toEqual(['generated']);
            expect(fs.readdirSync(elsewhere)).toEqual(['mine.txt']);
        });
    });
});

describe('keepPreviousAssetFields', () => {
    const built = {
        scope: 'global',
        version: '1.3.1',
        skillHashes: { 'lb-setup': 'new-skill' },
        generatedAssets: { 'setup_status.md': 'new-status' },
        generatedPyprojectHash: 'new-pyproject',
        agentsHash: 'new-agents',
        pyprojectHash: 'new-deps',
    };

    it('takes the generated-file fields from the previous record and keeps the rest', () => {
        const previous = {
            scope: 'global',
            version: '1.3.0',
            skillHashes: { 'lb-setup': 'old-skill' },
            generatedAssets: { 'setup_status.md': 'old-status' },
            generatedPyprojectHash: 'old-pyproject',
            agentsHash: 'old-agents',
            pyprojectHash: 'old-deps',
        };
        expect(keepPreviousAssetFields(built, previous)).toEqual({
            scope: 'global',
            version: '1.3.1',
            skillHashes: { 'lb-setup': 'new-skill' },
            generatedAssets: { 'setup_status.md': 'old-status' },
            generatedPyprojectHash: 'old-pyproject',
            agentsHash: 'old-agents',
            pyprojectHash: 'old-deps',
        });
    });

    it('leaves the fields out without a previous record, and does not change its input', () => {
        const kept = keepPreviousAssetFields(built, null);
        for (const field of RECORDED_ASSET_FIELDS) {
            expect(kept).not.toHaveProperty(field);
        }
        expect(kept.skillHashes).toEqual({ 'lb-setup': 'new-skill' });
        expect(built.generatedAssets).toEqual({
            'setup_status.md': 'new-status',
        });
    });

    it('leaves out a field the previous record does not have', () => {
        const kept = keepPreviousAssetFields(built, {
            generatedAssets: { 'setup_status.md': 'old-status' },
        });
        expect(kept.generatedAssets).toEqual({
            'setup_status.md': 'old-status',
        });
        expect(kept).not.toHaveProperty('agentsHash');
        expect(kept).not.toHaveProperty('pyprojectHash');
        expect(kept).not.toHaveProperty('generatedPyprojectHash');
    });
});
