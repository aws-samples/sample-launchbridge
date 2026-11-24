// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Global Assets Module
 *
 * A global install leaves every repository untouched, so the files a local
 * install writes into a repository's `.lb_workspace/` are generated once into
 * the global state directory instead, at `<state>/launchbridge/global/generated/`
 * (stateDir.js globalGeneratedDir), beside the global install record. Every
 * agent's lb-setup copies them into each repository it prepares
 * (scripts/bootstrap_workspace.py):
 *
 *   python_deps/pyproject.toml   scoped to the selected skills (venvSetup.js)
 *   python_deps/constraints.txt  the frozen dependency set
 *   setup_status.md              the status table for the selected skills
 *   workspace_layout.json        the folders to create (folderSetup.js)
 *   lb_agents_reference.md       agent_steering/AGENTS.md
 *
 * They are built with the same functions a local install uses, from the
 * source and the selection only, so one copy serves every agent. The global
 * manifest records each file's SHA-256, and lb-setup checks the folder
 * against it (verify_integrity.check_generated_assets).
 *
 * They are kept out of the installed skills because a symlink install's
 * lb-setup is a link to the LaunchBridge source: files written into it would
 * land in the source.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { safePathJoin } from './pathSanitizer.js';
import { buildPythonDepsFiles } from './venvSetup.js';
import { mergeSetupStatus, buildMarkdownTable } from './setupStatus.js';
import { workspaceLayout } from './folderSetup.js';
import { globalGeneratedDir } from './stateDir.js';

/** Format of workspace_layout.json, read by bootstrap_workspace.py. */
export const WORKSPACE_LAYOUT_FORMAT = 1;

/**
 * Builds the generated files for a global install's selection.
 *
 * @param {object} options
 * @param {string} options.sourcePath - LaunchBridge source root
 * @param {string[]} options.selectedSkills - Every selected skill
 * @param {Array<{ name: string, status: string }>} [options.extraStatusRows] -
 *   Rows external skill sources add to setup_status.md (the ai-domain rows)
 * @returns {Map<string, Buffer>} File bytes by POSIX path relative to the
 *   generated folder, sorted by path
 * @throws {Error} When a source file is missing (constraints.txt, AGENTS.md)
 */
export function buildGlobalAssets({
    sourcePath,
    selectedSkills: selection,
    extraStatusRows = [],
}) {
    // One order for a selection, however it was chosen: the installer has it
    // in prompt order and the global record keeps it sorted, and the files
    // (the pyproject's extras) must come out the same from both.
    const selectedSkills = [...new Set(selection)].sort();
    const deps = buildPythonDepsFiles(sourcePath, selectedSkills);
    const agentsPath = safePathJoin(sourcePath, 'agent_steering', 'AGENTS.md');
    if (!fsSync.existsSync(agentsPath)) {
        throw new Error(
            'agent_steering/AGENTS.md is missing from the LaunchBridge source.'
        );
    }
    const status = buildMarkdownTable([
        ...mergeSetupStatus(new Map(), selectedSkills),
        ...extraStatusRows,
    ]);
    const layout = {
        format: WORKSPACE_LAYOUT_FORMAT,
        ...workspaceLayout(selectedSkills),
    };

    return new Map(
        [
            ['lb_agents_reference.md', fsSync.readFileSync(agentsPath)],
            ['python_deps/constraints.txt', Buffer.from(deps.constraints)],
            ['python_deps/pyproject.toml', Buffer.from(deps.pyproject, 'utf8')],
            ['setup_status.md', Buffer.from(status, 'utf8')],
            [
                'workspace_layout.json',
                Buffer.from(JSON.stringify(layout, null, 2) + '\n', 'utf8'),
            ],
        ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
}

/**
 * The SHA-256 of every generated file, as the global manifest records them.
 *
 * @param {Map<string, Buffer>} assets
 * @returns {Record<string, string>}
 */
export function assetDigests(assets) {
    return Object.fromEntries(
        [...assets].map(([rel, bytes]) => [
            rel,
            crypto.createHash('sha256').update(bytes).digest('hex'),
        ])
    );
}

/**
 * Regular files under `dir` by POSIX relative path, or null when something
 * other than folders and regular files is there.
 *
 * @param {string} dir
 * @returns {Promise<string[] | null>}
 */
async function listRegularFiles(dir, base = dir) {
    const files = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await listRegularFiles(full, base);
            if (nested === null) return null;
            files.push(...nested);
        } else if (entry.isFile()) {
            files.push(path.relative(base, full).split(path.sep).join('/'));
        } else {
            return null;
        }
    }
    return files.sort();
}

/**
 * Whether the generated folder holds exactly these files: no other file, no
 * link, and each file's bytes as built. The folder itself must be a real
 * folder.
 *
 * @param {Map<string, Buffer>} assets
 * @param {string} [dir] - The generated folder (default globalGeneratedDir())
 * @returns {Promise<boolean>}
 */
export async function globalAssetsMatch(assets, dir = globalGeneratedDir()) {
    try {
        if (!(await fs.lstat(dir)).isDirectory()) return false;
        const files = await listRegularFiles(dir);
        if (files === null) return false;
        if (files.join('\0') !== [...assets.keys()].join('\0')) return false;
        for (const [rel, bytes] of assets) {
            const onDisk = await fs.readFile(
                safePathJoin(dir, ...rel.split('/'))
            );
            if (!onDisk.equals(bytes)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Writes the generated files, replacing whatever the generated folder held.
 * They are written into a new folder beside it, which is then renamed into
 * place, so lb-setup never reads a half-written set. Folders are readable by
 * the user only (0700) and files too (0600), as the rest of the state
 * directory is. A link at the folder's path is removed, never written through.
 *
 * @param {Map<string, Buffer>} assets
 * @param {string} [dir] - The generated folder (default globalGeneratedDir())
 * @returns {Promise<void>}
 */
export async function writeGlobalAssets(assets, dir = globalGeneratedDir()) {
    const parent = path.dirname(dir);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.chmod(parent, 0o700);
    const temp = path.join(
        parent,
        `.${path.basename(dir)}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    await fs.mkdir(temp, { mode: 0o700 });
    try {
        for (const [rel, bytes] of assets) {
            const parts = rel.split('/');
            if (parts.length > 1) {
                await fs.mkdir(safePathJoin(temp, ...parts.slice(0, -1)), {
                    recursive: true,
                    mode: 0o700,
                });
            }
            const file = safePathJoin(temp, ...parts);
            await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
            await fs.chmod(file, 0o600);
        }
        // fs.rm removes a link itself, never what it points to.
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(temp, dir);
    } catch (err) {
        await fs.rm(temp, { recursive: true, force: true });
        throw err;
    }
}
