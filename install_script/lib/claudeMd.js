// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * CLAUDE.md Setup
 *
 * Ensures CLAUDE.md exists in the target repository root and contains "@AGENTS.md".
 * - If CLAUDE.md doesn't exist: creates it with just "@AGENTS.md"
 * - If CLAUDE.md exists but doesn't contain "@AGENTS.md": appends it
 * - If CLAUDE.md already contains "@AGENTS.md": skips
 */

import fs from 'fs/promises';
import path from 'path';
import { validatePathWithinBase, safePathJoin } from './pathSanitizer.js';
import { checkPathInRoot } from './pathValidator.js';

const AGENTS_MD_REF = '@AGENTS.md';
const CLAUDE_MD = 'CLAUDE.md';

/**
 * @typedef {Object} ClaudeMdResult
 * @property {'created' | 'updated' | 'skipped' | 'error'} status
 * @property {string} [message]
 * @property {string} [error]
 */

/**
 * Ensures CLAUDE.md in the target repository contains "@AGENTS.md".
 *
 * @param {string} targetRepository - Root path of the target repository
 * @returns {Promise<ClaudeMdResult>}
 */
export async function copyClaudeMd(targetRepository) {
    // The target is the folder the user named; the file name is fixed, joined
    // with safePathJoin and checked by validatePathWithinBase.
    // nosemgrep: path-join-resolve-traversal
    const resolvedBase = path.resolve(targetRepository);
    const destClaudeMd = safePathJoin(resolvedBase, CLAUDE_MD);

    const { valid, error } = validatePathWithinBase(destClaudeMd, resolvedBase);
    if (!valid) {
        return { status: 'error', error };
    }
    // Never write through a symlinked CLAUDE.md (even a dangling one): it could
    // point anywhere.
    const placement = await checkPathInRoot(destClaudeMd, resolvedBase, {
        allowFile: true,
    });
    if (!placement.ok) {
        return {
            status: 'error',
            error:
                `CLAUDE.md is a symlink, so LaunchBridge did not modify it (${placement.reason}). ` +
                'Add @AGENTS.md to the file it points to manually, and merge ' +
                '.lb_workspace/steering/AGENTS_LB.md into AGENTS.md if that file exists.',
        };
    }

    let existing = null;
    try {
        existing = await fs.readFile(destClaudeMd, 'utf8');
    } catch {
        // file doesn't exist
    }

    if (existing === null) {
        await fs.writeFile(destClaudeMd, `${AGENTS_MD_REF}\n`);
        return {
            status: 'created',
            message: `Created CLAUDE.md with ${AGENTS_MD_REF}`,
        };
    }

    if (existing.includes(AGENTS_MD_REF)) {
        return { status: 'skipped' };
    }

    await fs.writeFile(destClaudeMd, `${AGENTS_MD_REF}\n${existing}`);
    return {
        status: 'updated',
        message: `Added ${AGENTS_MD_REF} to existing CLAUDE.md`,
    };
}
