// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * External Skills Provider
 *
 * Single integration seam between the LaunchBridge installer and *external*
 * skill sources (skills that do not live under <root>/skills and are not part
 * of the native LaunchBridge skill set). Today the only external source is the
 * `ai-skills` git submodule.
 *
 * The installer's core flow (index.js) stays agnostic: it calls the small set
 * of hooks below at well-defined points (discover → categories → source path →
 * hashes → manifest keyspace → status rows). Every hook that classifies a name
 * takes the discovered skill list explicitly, so ownership is decided by
 * membership, never by name prefix. Native modules (skillDiscovery,
 * setupStatus, statusReset, versionManifest) contain NO knowledge of external
 * skills.
 *
 * ── Removing external-skills support ────────────────────────────────────────
 * Delete `lib/externalSkillsProvider.js` and `lib/aiSkills.js`, then remove the
 * `externalSkills` hook calls in index.js. Nothing else needs to change — the
 * native install / delete (orphan removal) / update paths are self-contained.
 *
 * ── Adding another external source ──────────────────────────────────────────
 * Implement the same provider shape in a new module and aggregate it here
 * (e.g. compose discover()/buildCategories()/… across multiple providers).
 */

import * as ai from './aiSkills.js';

/**
 * @typedef {Object} ExternalSkill
 * @property {string} name
 * @property {string} domain - Source domain (e.g. 'research')
 * @property {boolean} isAiSkill - Marker the install loop uses for source resolution
 * @property {string} group - External group id (`ai-domain-<domain>`)
 * @property {string} path - Source path, installed for every agent
 * @property {Map<string, Map<string, Buffer>>} variants - Every other agent's
 *   files (SKILL.md, Codex's agents/openai.yaml), by copy id
 */

/**
 * The external skills provider. Each method is a hook the installer calls.
 */
export const externalSkills = {
    /**
     * Discovers all external skills available from configured sources.
     * Returns [] when no external source is initialized (e.g. submodule absent).
     *
     * @param {string} sourcePath - LaunchBridge source root
     * @param {{ nativeNames?: Set<string>, onWarn?: (msg: string) => void }} [opts]
     *   Native skill names (native wins a name collision) and a warning sink
     * @returns {ExternalSkill[]}
     */
    discover(sourcePath, opts) {
        return ai.discoverAiSkills(sourcePath, opts);
    },

    /**
     * Builds the selection categories contributed by external sources, shaped
     * like native SKILL_CATEGORIES so they slot into the existing prompt/flags.
     *
     * @param {ExternalSkill[]} skills
     * @param {Set<string>} [nativeNames] - Native skill names (for bundled companions)
     * @returns {import('./skillDiscovery.js').SkillCategory[]}
     */
    buildCategories(skills, nativeNames) {
        return ai.buildAiCategories(skills, nativeNames);
    },

    /**
     * Whether a skill name is owned by an external source.
     * @param {string} name
     * @param {ExternalSkill[]} skills - Discovered external skills
     * @returns {boolean}
     */
    ownsSkill(name, skills) {
        return ai.isAiSkill(name, skills);
    },

    /**
     * Resolves the source directory for an external skill. Every agent
     * installs the same folder; `adaptForAgent` then gives each agent its
     * SKILL.md.
     *
     * @param {ExternalSkill} skill
     * @returns {string}
     */
    resolveSource(skill) {
        return skill.path;
    },

    /**
     * Gives an installed external skill the files its agent reads: the source
     * ones for Claude Code, its own SKILL.md (and Codex's agents/openai.yaml)
     * for every other agent. Called after each copy or symlink install of an
     * external skill.
     *
     * @param {ExternalSkill} skill
     * @param {string} agent - Agent name
     * @param {string} targetDir - The installed skill directory
     * @param {string[]} agents - Every selected agent
     * @param {'local' | 'global'} [scope] - The install scope (default `local`)
     * @returns {Promise<void>}
     */
    adaptForAgent(skill, agent, targetDir, agents, scope = 'local') {
        return ai.writeAgentFiles(skill, agent, targetDir, agents, scope);
    },

    /**
     * The files `adaptForAgent` writes into that agent's copy, by relative
     * path, or undefined when the agent gets the source files unchanged. A
     * re-run compares an installed copy against the source with these.
     *
     * @param {ExternalSkill} skill
     * @param {string} agent
     * @param {string[]} agents - Every selected agent
     * @param {'local' | 'global'} [scope]
     * @returns {Map<string, Buffer> | undefined}
     */
    agentFiles(skill, agent, agents, scope = 'local') {
        return ai.agentFilesFor(skill, agent, agents, scope);
    },

    /**
     * Skills directories several selected agents share, each holding one
     * agent's copy of the external skills.
     *
     * @param {string[]} agents
     * @param {'local' | 'global'} [scope]
     * @returns {Array<{ dir: string, owner: string, others: string[] }>}
     */
    sharedDirectories(agents, scope = 'local') {
        return ai.sharedSkillsDirectories(agents, scope);
    },

    /**
     * Collapses a list of skill names into the manifest/lifecycle keyspace.
     * Native skills pass through unchanged; external skills collapse to their
     * group id so change detection happens at the group level.
     *
     * @param {string[]} skillNames
     * @param {ExternalSkill[]} skills - Discovered external skills
     * @returns {string[]}
     */
    toManifestKeys(skillNames, skills) {
        return ai.toManifestKeys(skillNames, skills);
    },

    /**
     * Inverse of toManifestKeys: expands manifest keys back to actual skill
     * names using the given selection. Native keys pass through.
     *
     * @param {string[]} keys
     * @param {string[]} selectedSkills
     * @param {ExternalSkill[]} skills - Discovered external skills
     * @returns {string[]}
     */
    expandManifestKeys(keys, selectedSkills, skills) {
        return ai.expandManifestKeys(keys, selectedSkills, skills);
    },

    /**
     * Computes group-level content hashes for the selected external skills,
     * keyed by manifest keyspace group id.
     *
     * @param {string[]} selectedSkills
     * @param {ExternalSkill[]} skills
     * @param {{ allowedRoot?: string }} [options] - Passed to the content hash
     * @returns {Promise<Record<string, string>>}
     */
    computeHashes(selectedSkills, skills, options) {
        return ai.computeAiGroupHashes(selectedSkills, skills, options);
    },

    /**
     * Computes the content hash of every selected external skill as each
     * agent receives it, keyed `<agent>/<skillName>`. Group hashes drive
     * upgrades; these are the digests an integrity check can verify against
     * an installed directory.
     *
     * @param {string[]} selectedSkills
     * @param {ExternalSkill[]} skills
     * @param {string[]} agents - Agent names the skills are installed for
     * @param {{ allowedRoot?: string, scope?: 'local' | 'global' }} [options]
     *   `allowedRoot` is passed to the content hash; `scope` decides which
     *   agents share a skills directory
     * @returns {Promise<Record<string, string>>}
     */
    computeFolderHashes(selectedSkills, skills, agents, options) {
        return ai.computeAiSkillFolderHashes(
            selectedSkills,
            skills,
            agents,
            options
        );
    },

    /**
     * Builds group-level setup_status.md rows for external skills. Appended to
     * the native rows by the installer's status writer.
     *
     * @param {Map<string, string>} existingStatuses
     * @param {string[]} installedSkillNames
     * @param {ExternalSkill[]} skills - Discovered external skills
     * @returns {Array<{ name: string, status: string }>}
     */
    buildStatusRows(existingStatuses, installedSkillNames, skills) {
        return ai.buildAiStatusRows(
            existingStatuses,
            installedSkillNames,
            skills
        );
    },

    /**
     * Post-pull update hook for external skills. Reinstalls external skills
     * whose group content changed and returns refreshed group hashes and
     * per-agent digests to merge back into the manifest. Self-contained so the
     * native updater stays unaware of external skills.
     *
     * @param {string} sourcePath
     * @param {string} targetRepo - The repository, or for a global install the
     *   home directory
     * @param {object} manifest
     * @param {{ muted: Function, success: Function, warn: Function }} ui
     * @param {{ scope?: 'local' | 'global' }} [options]
     * @returns {Promise<{ updated: string[], newHashes: Record<string, string>,
     *   newFolderHashes: Record<string, string> }>}
     */
    update(sourcePath, targetRepo, manifest, ui, options) {
        return ai.updateAiSkills(sourcePath, targetRepo, manifest, ui, options);
    },
};
