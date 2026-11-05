// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Update Decision Module
 *
 * Decides whether `launchbridge update` applies the update it has just
 * previewed. An update is applied only after someone has seen it: either they
 * confirm at the prompt, or, for scripted use, they pass the commit the preview
 * named with `--apply <commit>`. `--yes` alone never applies an update.
 */

// At least 12 hex characters, so a short prefix cannot match an unintended commit.
const MIN_COMMIT_ID_LENGTH = 12;
const COMMIT_ID = new RegExp(`^[0-9a-f]{${MIN_COMMIT_ID_LENGTH},40}$`, 'i');

/**
 * @param {{ to: string }} preview - The preview returned by runUpdate
 * @param {{ yes?: boolean, applyCommit?: string | null, isTTY?: boolean }} options
 * @returns {{ action: 'apply' | 'prompt' | 'decline', message?: string }}
 */
export function decideUpdate(preview, { yes, applyCommit, isTTY } = {}) {
    const target = preview.to.slice(0, 12);
    const howTo = `run 'launchbridge update --apply ${target}'`;

    if (applyCommit) {
        if (!COMMIT_ID.test(applyCommit)) {
            return {
                action: 'decline',
                message: `--apply needs at least the first ${MIN_COMMIT_ID_LENGTH} characters of the commit id the preview shows, not '${applyCommit}'.`,
            };
        }
        if (preview.to.toLowerCase().startsWith(applyCommit.toLowerCase())) {
            return {
                action: 'apply',
                message: `Applying the reviewed update to ${target}.`,
            };
        }
        return {
            action: 'decline',
            message: `The update now ends at ${target}, not ${applyCommit}. Review the changes above, then ${howTo}.`,
        };
    }
    if (yes) {
        return {
            action: 'decline',
            message: `--yes does not apply an update without review. Review the changes above, then ${howTo}.`,
        };
    }
    if (!isTTY) {
        return {
            action: 'decline',
            message: `No terminal to confirm on. Review the changes above, then ${howTo}.`,
        };
    }
    return { action: 'prompt' };
}

/**
 * Reads `--apply <commit>` or `--apply=<commit>` from update arguments.
 * @param {string[]} args
 * @returns {string | null}
 */
export function parseApplyCommit(args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--apply') {
            return args[i + 1] ?? '';
        }
        if (args[i].startsWith('--apply=')) {
            return args[i].slice('--apply='.length);
        }
    }
    return null;
}
