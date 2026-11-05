// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Lifecycle Orchestrator Module
 *
 * The main decision engine that determines which lifecycle path to follow
 * based on the existing Version_Manifest, current source state, and user
 * selections. Produces a LifecycleDecision that drives all downstream
 * actions (installation, status resets, manifest updates).
 */

import { diffManifests } from './versionManifest.js';

/**
 * @typedef {'fresh_install' | 'idempotent_rerun' | 'incremental_update' | 'release_upgrade' | 'interrupt_recovery'} LifecycleScenario
 */

/**
 * @typedef {Object} LifecycleDecision
 * @property {LifecycleScenario} scenario
 * @property {string[]} skillsToInstall - Skills that need file installation (new + changed)
 * @property {string[]} skillsToReset - Skills whose status should be reset to 'not started'
 * @property {string[]} skillsToRemove - Orphaned skills to prompt for removal
 * @property {string[]} skillsUnchanged - Skills with matching hashes (skip installation)
 * @property {boolean} resetVenvSetup - Whether venv-setup should be reset
 * @property {boolean} resetMcpSetup - Whether mcp-setup should be reset
 * @property {boolean} resetAgentsMerge - Whether agents-md-merge should be reset
 * @property {boolean} regeneratePyproject - Whether pyproject.toml needs regeneration
 * @property {boolean} updateAgentsMd - Whether AGENTS.md needs updating
 * @property {string} [upgradeFromVersion] - Previous version (for upgrade reporting)
 * @property {string} [upgradeToVersion] - New version (for upgrade reporting)
 * @property {string[]} [warnings] - Non-fatal warnings to surface (e.g., bundled + symlink)
 */

/**
 * Determines the lifecycle scenario and required actions.
 *
 * Decision logic:
 * 1. No manifest + no status file → fresh_install
 * 2. No manifest + status file exists → interrupt_recovery
 * 3. Manifest exists + version differs → release_upgrade
 * 4. Manifest exists + version same + method changed → incremental_update (reinstall all)
 * 5. Manifest exists + version same + all hashes match + same skills + same method → idempotent_rerun
 * 6. Manifest exists + version same + any difference → incremental_update
 *
 * @param {Object} context
 * @param {import('./versionManifest.js').VersionManifest | null} context.existingManifest
 * @param {string} context.currentVersion
 * @param {string[]} context.selectedSkills
 * @param {Record<string, string>} context.currentHashes - Hashes computed from source
 * @param {string} context.deliveryMethod
 * @param {string} context.installMethod
 * @param {string} context.sourcePath
 * @param {string} [context.gitCommitHash]
 * @param {string} [context.currentPyprojectHash]
 * @param {string} [context.currentMcpTemplateHash]
 * @param {string} [context.currentAgentsHash]
 * @param {boolean} [context.statusFileExists] - Whether setup_status.md exists in target
 * @param {boolean} [context.generatedPyprojectChanged] - Whether the generated pyproject.toml content differs from the previously installed version
 * @param {string[]} [context.mcpGatedSkills] - Skills that have associated MCP servers (read from lb_mcp.json template)
 * @returns {LifecycleDecision}
 */
export function determineLifecycle(context) {
    const {
        existingManifest,
        currentVersion,
        selectedSkills,
        currentHashes,
        deliveryMethod,
        installMethod,
        sourcePath,
        gitCommitHash,
        currentPyprojectHash,
        currentMcpTemplateHash,
        currentAgentsHash,
        statusFileExists,
        generatedPyprojectChanged,
        mcpGatedSkills = [],
    } = context;

    const warnings = [];

    // Bundled + symlink warning
    if (deliveryMethod === 'bundled' && installMethod === 'symlink') {
        warnings.push(
            'Symlink mode with bundled delivery is risky — if the source folder is replaced during an upgrade, all symlinks will break. Consider using copy mode instead.'
        );
    }

    // Case 1: No manifest exists
    if (!existingManifest) {
        if (statusFileExists) {
            // Interrupt recovery: status file exists but no manifest
            return {
                scenario: 'interrupt_recovery',
                skillsToInstall: [...selectedSkills],
                skillsToReset: [],
                skillsToRemove: [],
                skillsUnchanged: [],
                resetVenvSetup: false,
                resetMcpSetup: false,
                resetAgentsMerge: false,
                regeneratePyproject: true,
                updateAgentsMd: true,
                warnings,
            };
        }

        // Fresh install: no manifest, no status file
        return {
            scenario: 'fresh_install',
            skillsToInstall: [...selectedSkills],
            skillsToReset: [],
            skillsToRemove: [],
            skillsUnchanged: [],
            resetVenvSetup: false,
            resetMcpSetup: false,
            resetAgentsMerge: false,
            regeneratePyproject: true,
            updateAgentsMd: true,
            warnings,
        };
    }

    // Build a "current" manifest-like object for diffManifests
    const currentManifestLike = {
        version: currentVersion,
        skillHashes: {},
        installMethod,
        sourcePath,
        pyprojectHash: currentPyprojectHash || null,
        mcpTemplateHash: currentMcpTemplateHash || null,
        agentsHash: currentAgentsHash || null,
    };

    // Populate skillHashes only for selected skills
    for (const skill of selectedSkills) {
        if (currentHashes[skill] !== undefined) {
            currentManifestLike.skillHashes[skill] = currentHashes[skill];
        }
    }

    const diff = diffManifests(existingManifest, currentManifestLike);

    // Case 3: Release upgrade (version differs)
    if (diff.isVersionUpgrade) {
        // For upgrades, all changed + added skills need installation
        const skillsToInstall = [...diff.changedSkills, ...diff.addedSkills];
        // Changed skills need status reset
        const skillsToReset = [...diff.changedSkills];

        // MCP reset: if template changed or MCP-gated skills added/removed
        const mcpSkillAdded = diff.addedSkills.some((s) =>
            mcpGatedSkills.includes(s)
        );
        const mcpSkillRemoved = diff.removedSkills.some((s) =>
            mcpGatedSkills.includes(s)
        );

        return {
            scenario: 'release_upgrade',
            skillsToInstall,
            skillsToReset,
            skillsToRemove: [...diff.removedSkills],
            skillsUnchanged: [...diff.unchangedSkills],
            resetVenvSetup: generatedPyprojectChanged || false,
            resetMcpSetup:
                diff.mcpTemplateChanged || mcpSkillAdded || mcpSkillRemoved,
            resetAgentsMerge: true,
            regeneratePyproject: true,
            updateAgentsMd: true,
            upgradeFromVersion: existingManifest.version,
            upgradeToVersion: currentVersion,
            warnings,
        };
    }

    // Case 4: Method changed (symlink↔copy) — forces reinstall of all skills
    if (diff.methodChanged) {
        const mcpSkillAdded = diff.addedSkills.some((s) =>
            mcpGatedSkills.includes(s)
        );
        const mcpSkillRemoved = diff.removedSkills.some((s) =>
            mcpGatedSkills.includes(s)
        );

        return {
            scenario: 'incremental_update',
            skillsToInstall: [...selectedSkills],
            skillsToReset: [...diff.changedSkills],
            skillsToRemove: [...diff.removedSkills],
            skillsUnchanged: [],
            resetVenvSetup: generatedPyprojectChanged || false,
            resetMcpSetup:
                diff.mcpTemplateChanged || mcpSkillAdded || mcpSkillRemoved,
            resetAgentsMerge: true,
            regeneratePyproject: true,
            updateAgentsMd: true,
            warnings,
        };
    }

    // Case 5: Idempotent re-run — same version, same skills, all hashes match, same method
    const hasNoChanges =
        diff.changedSkills.length === 0 &&
        diff.addedSkills.length === 0 &&
        diff.removedSkills.length === 0 &&
        !diff.pyprojectChanged &&
        !diff.mcpTemplateChanged &&
        !diff.agentsChanged;

    if (hasNoChanges) {
        return {
            scenario: 'idempotent_rerun',
            skillsToInstall: [],
            skillsToReset: [],
            skillsToRemove: [],
            skillsUnchanged: [...diff.unchangedSkills],
            resetVenvSetup: false,
            resetMcpSetup: false,
            resetAgentsMerge: false,
            regeneratePyproject: false,
            updateAgentsMd: false,
            warnings,
        };
    }

    // Case 6: Incremental update — same version but something changed
    const skillsToInstall = [...diff.changedSkills, ...diff.addedSkills];
    const skillsToReset = [...diff.changedSkills];

    const mcpSkillAdded = diff.addedSkills.some((s) =>
        mcpGatedSkills.includes(s)
    );
    const mcpSkillRemoved = diff.removedSkills.some((s) =>
        mcpGatedSkills.includes(s)
    );

    return {
        scenario: 'incremental_update',
        skillsToInstall,
        skillsToReset,
        skillsToRemove: [...diff.removedSkills],
        skillsUnchanged: [...diff.unchangedSkills],
        resetVenvSetup: generatedPyprojectChanged || false,
        resetMcpSetup:
            diff.mcpTemplateChanged || mcpSkillAdded || mcpSkillRemoved,
        resetAgentsMerge: true,
        regeneratePyproject: true,
        updateAgentsMd: true,
        warnings,
    };
}
