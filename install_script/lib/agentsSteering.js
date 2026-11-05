// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Agents Steering Setup
 *
 * Copies AGENTS.md from agent_steering/ into the target repository root.
 * If AGENTS.md already exists at the root, copies as .lb_workspace/steering/AGENTS_LB.md
 * and prompts the user to manually merge the contents.
 * Skips if .lb_workspace/steering/AGENTS_LB.md already exists.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { validatePathWithinBase, safePathJoin } from './pathSanitizer.js';
import { checkPathInRoot } from './pathValidator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_AGENTS_MD = path.resolve(
    __dirname,
    '../../agent_steering/AGENTS.md'
);
const AGENTS_MD = 'AGENTS.md';
const AGENTS_lb_MD = path.join('.lb_workspace', 'steering', 'AGENTS_LB.md');
const AGENTS_REFERENCE_MD = path.join(
    '.lb_workspace',
    'config',
    'lb_agents_reference.md'
);

/**
 * @typedef {Object} AgentsSteeringResult
 * @property {'copied' | 'copied_as_lb' | 'skipped' | 'error'} status
 * @property {string} [message] - User-facing message for non-error statuses
 * @property {string} [error]
 */

/**
 * Copies AGENTS.md into the target repository.
 *
 * @param {string} targetRepository - Root path of the target repository
 * @returns {Promise<AgentsSteeringResult>}
 */
export async function copyAgentsSteering(targetRepository) {
    // The target is the folder the user named; every path below is a fixed
    // name joined with safePathJoin and checked to stay inside it.
    // nosemgrep: path-join-resolve-traversal
    const resolvedBase = path.resolve(targetRepository);
    const destAgentsMd = safePathJoin(resolvedBase, AGENTS_MD);
    const destAgentsLpMd = safePathJoin(resolvedBase, AGENTS_lb_MD);

    // Validate the destination paths are within the target repository. The
    // LaunchBridge-owned copies must not be reached through a symlink; a
    // symlinked AGENTS.md is handled below.
    const destReference = safePathJoin(resolvedBase, AGENTS_REFERENCE_MD);
    for (const destPath of [destAgentsMd, destAgentsLpMd, destReference]) {
        const { valid, error } = validatePathWithinBase(destPath, resolvedBase);
        if (!valid) {
            return { status: 'error', error };
        }
    }
    for (const destPath of [destAgentsLpMd, destReference]) {
        const placement = await checkPathInRoot(destPath, resolvedBase, {
            allowFile: true,
        });
        if (!placement.ok) {
            return {
                status: 'error',
                error: `Refusing to write ${path.relative(resolvedBase, destPath)}: ${placement.reason}`,
            };
        }
    }

    try {
        await fs.access(SOURCE_AGENTS_MD);
    } catch {
        return {
            status: 'error',
            error: 'Source AGENTS.md not found in agent_steering/.',
        };
    }

    // A symlinked AGENTS.md (even a dangling one) is never written: it could
    // point anywhere. LaunchBridge's version goes to AGENTS_LB.md, and the user
    // merges it into the file the link points to.
    let agentsMdIsSymlink = false;
    try {
        agentsMdIsSymlink = (await fs.lstat(destAgentsMd)).isSymbolicLink();
    } catch {
        // doesn't exist
    }
    if (agentsMdIsSymlink) {
        try {
            await fs.mkdir(path.dirname(destReference), { recursive: true });
            await fs.copyFile(SOURCE_AGENTS_MD, destReference);
            await fs.mkdir(path.dirname(destAgentsLpMd), { recursive: true });
            await fs.copyFile(SOURCE_AGENTS_MD, destAgentsLpMd);
        } catch (err) {
            return {
                status: 'error',
                error: `AGENTS.md is a symlink and was not modified, and AGENTS_LB.md could not be written: ${err.message}`,
            };
        }
        return {
            status: 'error',
            error:
                'AGENTS.md is a symlink, so LaunchBridge did not modify it. ' +
                'Merge .lb_workspace/steering/AGENTS_LB.md into the file AGENTS.md points to manually.',
        };
    }

    // Always copy the canonical AGENTS.md to .lb_workspace/config/lb_agents_reference.md
    // so lb-setup can use it as a reference regardless of install method (copy vs
    // symlink). This comes first: lb-setup treats the reference as canonical, so a
    // copy that arrived with the repository must never survive a run.
    try {
        await fs.mkdir(path.dirname(destReference), { recursive: true });
        await fs.copyFile(SOURCE_AGENTS_MD, destReference);
    } catch {
        // Non-fatal — lb-setup will fall back to working without the reference
    }

    // A pending .lb_workspace/steering/AGENTS_LB.md is kept only if it is this
    // source's version; any other content (an older release, or a file that arrived
    // with the repository) is replaced, because lb-setup merges it into AGENTS.md as
    // LaunchBridge's own instructions.
    try {
        const pending = await fs.readFile(destAgentsLpMd);
        if (pending.equals(await fs.readFile(SOURCE_AGENTS_MD))) {
            return { status: 'skipped' };
        }
        await fs.copyFile(SOURCE_AGENTS_MD, destAgentsLpMd);
        return {
            status: 'copied_as_lb',
            message:
                '.lb_workspace/steering/AGENTS_LB.md did not match this LaunchBridge version and was replaced. Merge it with lb-setup.',
        };
    } catch (err) {
        if (err.code !== 'ENOENT') {
            return {
                status: 'error',
                error: `could not check .lb_workspace/steering/AGENTS_LB.md: ${err.message}`,
            };
        }
    }

    // Check if AGENTS.md already exists in target root
    let agentsMdExists = false;
    try {
        await fs.access(destAgentsMd);
        agentsMdExists = true;
    } catch {
        // doesn't exist
    }

    if (agentsMdExists) {
        // Ensure .lb_workspace/steering/ exists before copying
        await fs.mkdir(path.dirname(destAgentsLpMd), { recursive: true });
        await fs.copyFile(SOURCE_AGENTS_MD, destAgentsLpMd);
        return {
            status: 'copied_as_lb',
            message: `AGENTS.md exists — saved new version as .lb_workspace/steering/AGENTS_LB.md. Merge manually or use lb-setup.`,
        };
    }

    await fs.copyFile(SOURCE_AGENTS_MD, destAgentsMd);
    return { status: 'copied' };
}
