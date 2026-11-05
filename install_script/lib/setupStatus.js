// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Setup Status Module
 *
 * Generates .lb_workspace/setup_status.md after installation.
 * Installed skills are marked "not started", uninstalled known skills are
 * marked "not installed" so lb-setup knows to skip them without guessing.
 *
 * If setup_status.md already exists, it is merged with the new install:
 *   - Existing rows keep their current status (preserves agent progress)
 *   - Newly installed skills are added as "not started" or "ready"
 *   - Skills no longer installed are flipped to "not installed"
 *   - Always-included meta-steps (mcp-setup, agents-md-merge) are preserved as-is
 */

import fs from 'fs/promises';
import path from 'path';
import { SKILL_CATEGORIES, SKILL_REQUIRES_SETUP } from './skillDiscovery.js';
import { safePathJoin } from './pathSanitizer.js';

const STATUS_FILE_PATH = path.join('.lb_workspace', 'setup_status.md');

/**
 * Meta-steps that lb-setup always runs, not tied to any installable skill.
 * Always included with status "not started".
 *
 * @type {string[]}
 */
const ALWAYS_INCLUDED_STEPS = ['venv-setup', 'mcp-setup', 'agents-md-merge'];

/**
 * Skills excluded from the status table even if installed.
 * lb-setup is the orchestrator — it doesn't track its own status.
 *
 * @type {Set<string>}
 */
const EXCLUDED_SKILLS = new Set(['lb-setup']);

/**
 * Returns all known installable skill names from SKILL_CATEGORIES,
 * excluding the ones in EXCLUDED_SKILLS, mapped to whether they require setup.
 * Uses the per-skill SKILL_REQUIRES_SETUP map for accurate status assignment.
 *
 * @returns {Array<{ name: string, requiresSetup: boolean }>}
 */
function getAllKnownSkills() {
    const seen = new Set();
    const result = [];

    for (const category of SKILL_CATEGORIES) {
        for (const name of category.skills) {
            if (!EXCLUDED_SKILLS.has(name) && !seen.has(name)) {
                seen.add(name);
                result.push({
                    name,
                    requiresSetup: SKILL_REQUIRES_SETUP[name] ?? false,
                });
            }
        }
    }

    return result;
}

/**
 * Parses an existing setup_status.md and returns a map of skill name → status.
 *
 * @param {string} content - Raw markdown content of the existing file
 * @returns {Map<string, string>} Map of skill/step name to its current status
 */
export function parseSetupStatusContent(content) {
    const statusMap = new Map();
    for (const line of content.split('\n')) {
        // Match table data rows: | skill-name | status |
        const match = line.match(/^\|\s+(\S+)\s+\|\s+(.+?)\s+\|$/);
        if (match) {
            const name = match[1].trim();
            const status = match[2].trim();
            // Skip the header row and the `| --- | --- |` divider row
            if (
                name !== 'Skill' &&
                name !== 'Skill / Task' &&
                !/^-+$/.test(name)
            ) {
                statusMap.set(name, status);
            }
        }
    }
    return statusMap;
}

/**
 * Merges an existing status map with the new install set.
 * Rules:
 *   - Always-included meta-steps: keep existing status if present, else "not started"
 *   - Skills still installed with real progress: keep existing status
 *   - Newly installed skills (or previously uninstalled): reset to "not started" or "ready"
 *   - Skills no longer installed: set to "not installed"
 *
 * @param {Map<string, string>} existingStatuses - Parsed statuses from the current file
 * @param {string[]} installedSkillNames - Skills from the new install run
 * @returns {Array<{ name: string, status: string }>} Merged rows in canonical order
 */
export function mergeSetupStatus(existingStatuses, installedSkillNames) {
    const installedSet = new Set(
        installedSkillNames.filter((n) => !EXCLUDED_SKILLS.has(n))
    );
    const allKnown = getAllKnownSkills();

    return [
        // Meta-steps: preserve existing status, default to "not started"
        ...ALWAYS_INCLUDED_STEPS.map((name) => ({
            name,
            status: existingStatuses.get(name) ?? 'not started',
        })),
        // All known skills: merge existing status with new install set
        ...allKnown.map(({ name, requiresSetup }) => {
            if (installedSet.has(name)) {
                const existing = existingStatuses.get(name);
                if (existing && existing !== 'not installed') {
                    // Skill was already present and has real progress — keep it
                    return { name, status: existing };
                }
                // Newly added skill (or was previously uninstalled) — reset to start
                return {
                    name,
                    status: requiresSetup ? 'not started' : 'ready',
                };
            }
            // Not in this install — mark as not installed
            return { name, status: 'not installed' };
        }),
    ];
}

/**
 * Renders a rows array into the setup_status.md markdown table format.
 *
 * @param {Array<{ name: string, status: string }>} rows
 * @returns {string} Markdown content
 */
export function buildMarkdownTable(rows) {
    const labelWidth = Math.max(
        ...rows.map((r) => r.name.length),
        'Skill / Task'.length
    );
    const statusWidth = 'not installed'.length; // widest status value

    const header = `| ${'Skill / Task'.padEnd(labelWidth)} | ${'Status'.padEnd(statusWidth)} |`;
    const divider = `| ${'-'.repeat(labelWidth)} | ${'-'.repeat(statusWidth)} |`;
    const dataRows = rows.map(
        (r) =>
            `| ${r.name.padEnd(labelWidth)} | ${r.status.padEnd(statusWidth)} |`
    );

    return [
        '# LaunchBridge Setup Status',
        '',
        header,
        divider,
        ...dataRows,
        '',
    ].join('\n');
}

/**
 * Builds the markdown content for a fresh setup_status.md (no existing file).
 * Skills that require setup → "not started"
 * Skills that are ready immediately → "ready"
 * Known-but-not-installed skills → "not installed"
 *
 * @param {string[]} installedSkillNames - Skill directory names that were successfully installed
 * @returns {string} Markdown content
 */
export function buildSetupStatusContent(installedSkillNames) {
    const rows = mergeSetupStatus(new Map(), installedSkillNames);
    return buildMarkdownTable(rows);
}

/**
 * Writes setup_status.md into .lb_workspace/ inside the target repository.
 * If the file already exists, merges the new install set into it:
 *   - Completed/in-progress skills keep their status
 *   - Newly added skills are set to "not started" or "ready"
 *   - Skills removed from this install are set to "not installed"
 *
 * @param {string} targetRepository - Root path of the target repository
 * @param {string[]} installedSkillNames - Skill directory names that were successfully installed
 * @param {((existingStatuses: Map<string,string>, installedSkillNames: string[]) => Array<{name: string, status: string}>)|null} [buildExtraRows]
 *   Optional callback contributing extra rows (e.g. external/grouped skills) appended after native rows
 * @returns {Promise<{ status: 'created' | 'merged' | 'error', filePath: string, error?: string }>}
 */
export async function writeSetupStatus(
    targetRepository,
    installedSkillNames,
    buildExtraRows = null
) {
    const filePath = safePathJoin(targetRepository, STATUS_FILE_PATH);

    let existingStatuses = new Map();
    let fileExists = false;

    try {
        const existing = await fs.readFile(filePath, 'utf8');
        existingStatuses = parseSetupStatusContent(existing);
        fileExists = true;
    } catch {
        // File doesn't exist — start fresh
    }

    try {
        const rows = mergeSetupStatus(existingStatuses, installedSkillNames);
        const extraRows = buildExtraRows
            ? buildExtraRows(existingStatuses, installedSkillNames)
            : [];
        const content = buildMarkdownTable([...rows, ...extraRows]);
        await fs.writeFile(filePath, content, 'utf8');
        return { status: fileExists ? 'merged' : 'created', filePath };
    } catch (err) {
        return { status: 'error', filePath, error: err.message };
    }
}
