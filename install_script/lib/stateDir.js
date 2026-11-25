// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * State Directory Module
 *
 * The user's per-repository LaunchBridge state directory, outside every
 * repository: `$XDG_CONFIG_HOME/launchbridge/repos/<key>` (an absolute
 * XDG_CONFIG_HOME only) or `~/.config/launchbridge/repos/<key>`, where `<key>` is
 * the first 16 hex digits of the SHA-256 of the repository's resolved path. The
 * skills' Python scripts derive the same path (lb-setup/scripts/venv_identity.py).
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

/**
 * The folder every LaunchBridge state directory lives in: an absolute
 * `$XDG_CONFIG_HOME`, otherwise `~/.config` (a relative XDG_CONFIG_HOME is
 * ignored, as the XDG spec requires).
 * @returns {string}
 */
function stateBase() {
    const xdg = process.env.XDG_CONFIG_HOME || '';
    return path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
}

/**
 * @param {string} targetRepo
 * @returns {string} The repository's state directory (not created)
 */
export function repoStateDir(targetRepo) {
    const base = stateBase();
    const resolved = fsSync.realpathSync(targetRepo);
    const key = crypto
        .createHash('sha256')
        .update(resolved, 'utf8')
        .digest('hex')
        .slice(0, 16);
    return path.join(base, 'launchbridge', 'repos', key);
}

/**
 * `target` with its nearest existing ancestor resolved through links.
 * @param {string} target - absolute path
 * @returns {string}
 */
export function realpathOfNearest(target) {
    let existing = target;
    const rest = [];
    while (!fsSync.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        rest.unshift(path.basename(existing));
        existing = parent;
    }
    return path.join(fsSync.realpathSync(existing), ...rest);
}

/**
 * Writes `name` in the repository's state directory, readable by the user only.
 * Refuses a state directory inside the repository.
 * @param {string} targetRepo
 * @param {string} name
 * @param {string} text
 */
export async function writeRepoState(targetRepo, name, text) {
    const dir = repoStateDir(targetRepo);
    const repo = fsSync.realpathSync(targetRepo);
    // Resolved through links: the folder may not exist yet, so its nearest
    // existing ancestor is resolved and the rest appended.
    const relative = path.relative(repo, realpathOfNearest(path.resolve(dir)));
    const outside =
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative);
    if (!outside) {
        throw new Error(
            `${dir} is inside the repository; the LaunchBridge state directory (XDG_CONFIG_HOME or ~/.config) must be outside it`
        );
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    await fs.writeFile(file, text, { mode: 0o600 });
    await fs.chmod(file, 0o600);
    return file;
}

// ── Global install record ─────────────────────────────────────────────────────

/** The global install manifest, in the global state directory. */
export const GLOBAL_MANIFEST = 'manifest.json';

/** The LaunchBridge source the global install came from. */
export const GLOBAL_INSTALL_SOURCE = 'install_source.json';

/**
 * The skill folders a global install has started on and not finished
 * (writeGlobalPending).
 */
export const GLOBAL_PENDING = 'pending.json';

/** File names writeGlobalState accepts. */
const GLOBAL_STATE_FILES = new Set([
    GLOBAL_MANIFEST,
    GLOBAL_INSTALL_SOURCE,
    GLOBAL_PENDING,
]);

/**
 * The global install's state directory, `<state base>/launchbridge/global`,
 * beside the per-repository `repos/` folder. The skills' Python scripts derive
 * the same path (lb-setup/scripts/bootstrap_workspace.py, verify_integrity.py).
 * @returns {string} (not created)
 */
export function globalStateDir() {
    return path.join(stateBase(), 'launchbridge', 'global');
}

/** The folder in the global state directory the generated files go in. */
export const GLOBAL_GENERATED_DIR = 'generated';

/**
 * Where a global install keeps the files lb-setup prepares each repository
 * from (globalAssets.js): `<global state dir>/generated`, one copy for every
 * agent. The skills' Python scripts derive the same path
 * (verify_integrity.global_generated_dir).
 * @returns {string} (not created)
 */
export function globalGeneratedDir() {
    return path.join(globalStateDir(), GLOBAL_GENERATED_DIR);
}

/**
 * Writes one of the global state files atomically (a temporary file renamed
 * into place), readable by the user only, in a folder only the user can enter.
 * @param {string} name - GLOBAL_MANIFEST, GLOBAL_INSTALL_SOURCE or GLOBAL_PENDING
 * @param {string} text
 * @returns {Promise<string>} The file written
 */
export async function writeGlobalState(name, text) {
    if (!GLOBAL_STATE_FILES.has(name)) {
        throw new Error(`Unknown global state file: ${name}`);
    }
    const dir = globalStateDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const file = path.join(dir, name);
    const temp = path.join(
        dir,
        `.${name}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    try {
        await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' });
        await fs.chmod(temp, 0o600);
        await fs.rename(temp, file);
    } catch (err) {
        await fs.rm(temp, { force: true });
        throw err;
    }
    return file;
}

/**
 * The global install manifest, or null when there is none or it is not one
 * (unreadable, invalid JSON, or missing the fields every manifest has).
 * @returns {Promise<object|null>}
 */
export async function readGlobalManifest() {
    try {
        const parsed = JSON.parse(
            await fs.readFile(
                path.join(globalStateDir(), GLOBAL_MANIFEST),
                'utf8'
            )
        );
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            parsed.scope !== 'global' ||
            typeof parsed.version !== 'string' ||
            typeof parsed.skillHashes !== 'object' ||
            parsed.skillHashes === null
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Records the LaunchBridge source the global install came from. verify_integrity
 * --global checks a symlink install's links against it.
 * @param {string} sourcePath
 */
export async function recordGlobalInstallSource(sourcePath) {
    await writeGlobalState(
        GLOBAL_INSTALL_SOURCE,
        JSON.stringify({ sourcePath: path.resolve(sourcePath) }) + '\n'
    );
}

/**
 * Lists the skill folders a global install has started to create or replace,
 * as keys relative to the home directory (installedTargets.js targetKey). The
 * install adds each folder before it touches it, and keeps those it did not
 * finish listed once its record is written, so the next run still knows which
 * folders are LaunchBridge's.
 * @param {Iterable<string>} targets
 */
export async function writeGlobalPending(targets) {
    await writeGlobalState(
        GLOBAL_PENDING,
        JSON.stringify({ targets: [...new Set(targets)].sort() }, null, 2) +
            '\n'
    );
}

/**
 * The skill folders a global install that did not finish listed in
 * pending.json, or null when there is no such file.
 * @returns {Promise<Set<string> | null>}
 * @throws {Error} When the file can't be read or is not such a list: the
 *     folders it lists would otherwise be taken for someone else's
 */
export async function readGlobalPending() {
    let text;
    try {
        text = await fs.readFile(
            path.join(globalStateDir(), GLOBAL_PENDING),
            'utf8'
        );
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    const { targets } = JSON.parse(text) ?? {};
    if (!Array.isArray(targets)) {
        throw new Error('it has no "targets" list');
    }
    return new Set(targets.filter((key) => typeof key === 'string'));
}

/** Removes pending.json, once no folder it lists is left unfinished. */
export async function removeGlobalPending() {
    await fs.rm(path.join(globalStateDir(), GLOBAL_PENDING), { force: true });
}
