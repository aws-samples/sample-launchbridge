// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Status Reset Module
 *
 * Applies hash-based status resets on top of the existing merge logic from
 * setupStatus.js. This module wraps `mergeSetupStatus` — it does NOT replace it.
 *
 * Flow:
 *   1. Call `mergeSetupStatus(existingStatuses, installedSkillNames)` to get the
 *      base merged rows (preserves canonical ordering, EXCLUDED_SKILLS,
 *      ALWAYS_INCLUDED_STEPS, getAllKnownSkills() enumeration, requiresSetup logic)
 *   2. Apply hash-based overrides from the lifecycle decision:
 *      - Skills in `decision.skillsToReset` → status = 'not started'
 *      - venv-setup → 'not started' if `decision.resetVenvSetup`
 *      - mcp-setup → 'not started' if `decision.resetMcpSetup`
 *      - agents-md-merge → 'not started' if `decision.resetAgentsMerge`
 *   3. Return the modified rows array (same format as mergeSetupStatus output)
 */

import { mergeSetupStatus } from './setupStatus.js';
import { SKILL_REQUIRES_SETUP } from './skillDiscovery.js';

/**
 * Applies hash-based status resets on top of the existing merge logic.
 *
 * Step 1: Calls mergeSetupStatus to get the base merged rows (preserves all
 *          existing behavior: canonical ordering, EXCLUDED_SKILLS, ALWAYS_INCLUDED_STEPS,
 *          requiresSetup logic for new skills)
 * Step 2: Applies overrides from the lifecycle decision:
 *          - Skills in skillsToReset → status = 'not started'
 *          - venv-setup → 'not started' if resetVenvSetup
 *          - mcp-setup → 'not started' if resetMcpSetup
 *          - agents-md-merge → 'not started' if resetAgentsMerge
 *
 * @param {Map<string, string>} existingStatuses - Parsed statuses from current setup_status.md
 * @param {string[]} installedSkillNames - Skills from the current install run
 * @param {import('./lifecycleOrchestrator.js').LifecycleDecision} decision - Lifecycle decision with reset flags
 * @returns {Array<{ name: string, status: string }>} Updated rows in canonical order
 */
export function applyStatusResets(
    existingStatuses,
    installedSkillNames,
    decision
) {
    // Step 1: Get base merged rows from existing logic
    const rows = mergeSetupStatus(existingStatuses, installedSkillNames);

    // Step 2: Build a set of skills that need hash-based reset
    const skillsToResetSet = new Set(decision.skillsToReset || []);

    // Step 3: Apply overrides
    for (const row of rows) {
        // Reset skills with changed Content_Hash. A changed skill that needs
        // setup goes back to 'not started'; a no-setup ("ready") skill stays
        // immediately usable — never flip it into the setup queue.
        if (skillsToResetSet.has(row.name)) {
            row.status =
                (SKILL_REQUIRES_SETUP[row.name] ?? false)
                    ? 'not started'
                    : 'ready';
        }

        // Reset meta-steps when flagged
        if (row.name === 'venv-setup' && decision.resetVenvSetup) {
            row.status = 'not started';
        }
        if (row.name === 'mcp-setup' && decision.resetMcpSetup) {
            row.status = 'not started';
        }
        if (row.name === 'agents-md-merge' && decision.resetAgentsMerge) {
            row.status = 'not started';
        }
    }

    return rows;
}
