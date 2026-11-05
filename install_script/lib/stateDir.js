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
 * @param {string} targetRepo
 * @returns {string} The repository's state directory (not created)
 */
export function repoStateDir(targetRepo) {
    const xdg = process.env.XDG_CONFIG_HOME || '';
    const base = path.isAbsolute(xdg)
        ? xdg
        : path.join(os.homedir(), '.config');
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
function realpathOfNearest(target) {
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
