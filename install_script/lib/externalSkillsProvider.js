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
     * installs the same folder.
     *
     * @param {ExternalSkill} skill
     * @returns {string}
     */
    resolveSource(skill) {
        return skill.path;
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
     * Computes per-folder content hashes for the selected external skills,
     * keyed `shared/<skillName>`. Group hashes drive upgrades; these are the
     * digests an integrity check can verify against an installed directory.
     *
     * @param {string[]} selectedSkills
     * @param {ExternalSkill[]} skills
     * @param {{ allowedRoot?: string }} [options] - Passed to the content hash
     * @returns {Promise<Record<string, string>>}
     */
    computeFolderHashes(selectedSkills, skills, options) {
        return ai.computeAiSkillFolderHashes(selectedSkills, skills, options);
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
     * Post-pull update hook for external skills. Re-copies external skills
     * whose group content changed (copy installs) and returns refreshed group
     * hashes to merge back into the manifest. Self-contained so the native
     * updater stays unaware of external skills.
     *
     * @param {string} sourcePath
     * @param {string} targetRepo
     * @param {object} manifest
     * @param {{ muted: Function, success: Function, warn: Function }} ui
     * @returns {Promise<{ updated: string[], newHashes: Record<string, string>,
     *   newFolderHashes: Record<string, string> }>}
     */
    update(sourcePath, targetRepo, manifest, ui) {
        return ai.updateAiSkills(sourcePath, targetRepo, manifest, ui);
    },
};
