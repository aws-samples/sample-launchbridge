// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Version Manifest Module
 *
 * Reads, writes, and compares the Version_Manifest stored at
 * `.lb_workspace/config/version_manifest.json`. The manifest records what
 * was installed (release version, per-skill content hashes, delivery method,
 * installation method) and enables change detection on subsequent runs.
 *
 * Writes are atomic (temp file + rename) to prevent corruption if the
 * process is interrupted mid-write.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { safePathJoin } from './pathSanitizer.js';
import { checkPathInRoot } from './pathValidator.js';
import { writeRepoState } from './stateDir.js';

/**
 * @typedef {Object} VersionManifest
 * @property {number} schemaVersion - Schema version for future migrations (currently 1)
 * @property {string} version - Release version from version.txt
 * @property {string} timestamp - ISO 8601 timestamp of last install
 * @property {string} deliveryMethod - 'git_repo' | 'bundled'
 * @property {string} installMethod - 'symlink' | 'copy'
 * @property {string[]} [agents] - Agent names selected during install (e.g. ['kiro', 'codex'])
 * @property {string} [gitCommitHash] - Git HEAD commit (only for git_repo)
 * @property {string} sourcePath - Absolute path to LaunchBridge source at install time
 * @property {Record<string, string>} skillHashes - Map of skill name → Content_Hash.
 *   Mixed keyspace: native skills are keyed by name, external (ai-skills) ones
 *   collapse to an `ai-domain-<domain>` group key whose hash spans every
 *   selected skill in that domain. Drives upgrade detection; not verifiable
 *   per directory.
 * @property {string[]} [installedTargets] - Repository-relative skill directories
 *   LaunchBridge installed (e.g. `.claude/skills/testing-framework`). Only these
 *   are replaced or removed; a same-named directory it skipped is not listed.
 * @property {Record<string, string>} [externalSkillHashes] - Map of
 *   `shared/<skillName>` (e.g. `shared/ai-plan`) → Content_Hash of that one
 *   source folder, which every agent installs. What verify_integrity.py checks
 *   for external skills, since a group hash matches no installed directory.
 * @property {string[]} [externalManifestKeys] - The skillHashes keys owned by the
 *   external provider (the `ai-domain-*` group keys). The integrity checker
 *   skips these rather than verifying them as skill folders.
 * @property {string} [pyprojectHash] - Hash of the source dependency set (project_dependencies/pyproject.toml and constraints.txt)
 * @property {string} [mcpTemplateHash] - Hash of the MCP server template
 * @property {string} [agentsHash] - Hash of the AGENTS.md source file
 */

/**
 * @typedef {Object} ManifestDiff
 * @property {boolean} isVersionUpgrade - Release version changed
 * @property {string[]} changedSkills - Skills whose Content_Hash differs
 * @property {string[]} addedSkills - Skills in current but not existing
 * @property {string[]} removedSkills - Skills in existing but not current
 * @property {string[]} unchangedSkills - Skills with matching hashes
 * @property {boolean} pyprojectChanged - Python dependency config changed
 * @property {boolean} mcpTemplateChanged - MCP server template changed
 * @property {boolean} agentsChanged - AGENTS.md content changed
 * @property {boolean} methodChanged - Installation method changed
 * @property {boolean} pathChanged - Source path changed
 */

/** Current schema version for the manifest format. */
const CURRENT_SCHEMA_VERSION = 1;

/** Relative path from target repo root to the manifest file. */
const MANIFEST_REL_PATH = '.lb_workspace/config/version_manifest.json';

/**
 * Reads and parses the Version_Manifest from disk.
 * Returns null if the file is missing, unreadable, or contains invalid JSON.
 *
 * @param {string} targetRepo - Root of the target repository
 * @returns {Promise<VersionManifest | null>} Parsed manifest or null if not found/invalid
 */
export async function readManifest(targetRepo) {
    const manifestPath = safePathJoin(targetRepo, MANIFEST_REL_PATH);

    try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(content);

        // Basic validation: must be an object with required fields
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.version !== 'string' ||
            typeof parsed.skillHashes !== 'object'
        ) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}

/** The state-directory record of the LaunchBridge source this repo uses. */
export const INSTALL_SOURCE_RECORD = 'install_source.json';

/**
 * Records the LaunchBridge source path in the repository's state directory.
 * verify_integrity.py reads it from there: the manifest in the repository can
 * be replaced by a pulled file, so its sourcePath can't vouch for the links of
 * a symlink install. Best effort: without the record, verify checks the links
 * against each other only.
 *
 * @param {string} targetRepo
 * @param {string} sourcePath
 */
export async function recordInstallSource(targetRepo, sourcePath) {
    try {
        await writeRepoState(
            targetRepo,
            INSTALL_SOURCE_RECORD,
            JSON.stringify({ sourcePath: path.resolve(sourcePath) }) + '\n'
        );
    } catch {
        // No writable state directory: verify falls back as described above
    }
}

/**
 * Writes the Version_Manifest atomically (write to temp file, then rename).
 * Creates the parent directory if it does not exist.
 *
 * @param {string} targetRepo - Root of the target repository
 * @param {VersionManifest} manifest - The manifest to write
 * @returns {Promise<void>}
 */
export async function writeManifest(targetRepo, manifest) {
    const manifestPath = safePathJoin(targetRepo, MANIFEST_REL_PATH);
    const manifestDir = path.dirname(manifestPath);

    // Refuse a manifest directory reached through a symlink: the write would
    // land outside the target repository.
    const placement = await checkPathInRoot(manifestDir, targetRepo);
    if (!placement.ok) {
        throw new Error(
            `Refusing to write the version manifest: ${placement.reason}`
        );
    }

    // Ensure the directory exists
    await fs.mkdir(manifestDir, { recursive: true });

    // Ensure schemaVersion is set
    const toWrite = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ...manifest,
    };

    const content = JSON.stringify(toWrite, null, 2) + '\n';

    // Write to a temp file in the same directory, then rename for atomicity
    const tempName = `.version_manifest.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const tempPath = safePathJoin(manifestDir, tempName);

    try {
        await fs.writeFile(tempPath, content, 'utf-8');
        await fs.rename(tempPath, manifestPath);
        if (manifest.sourcePath) {
            await recordInstallSource(targetRepo, manifest.sourcePath);
        }
    } catch (err) {
        // Clean up temp file on failure
        try {
            await fs.unlink(tempPath);
        } catch {
            // Ignore cleanup errors
        }
        throw err;
    }
}

/**
 * Compares two manifests and returns a change summary.
 * If existing is null (fresh install), all current skills are classified as added.
 *
 * @param {VersionManifest | null} existing - Previously stored manifest (null = fresh install)
 * @param {VersionManifest} current - Newly computed manifest
 * @returns {ManifestDiff}
 */
export function diffManifests(existing, current) {
    // Fresh install: everything is new
    if (!existing) {
        return {
            isVersionUpgrade: false,
            changedSkills: [],
            addedSkills: Object.keys(current.skillHashes || {}),
            removedSkills: [],
            unchangedSkills: [],
            pyprojectChanged: false,
            mcpTemplateChanged: false,
            agentsChanged: false,
            methodChanged: false,
            pathChanged: false,
        };
    }

    const existingHashes = existing.skillHashes || {};
    const currentHashes = current.skillHashes || {};

    const existingSkills = new Set(Object.keys(existingHashes));
    const currentSkills = new Set(Object.keys(currentHashes));

    const changedSkills = [];
    const addedSkills = [];
    const removedSkills = [];
    const unchangedSkills = [];

    // Classify skills present in current manifest
    for (const skill of currentSkills) {
        if (!existingSkills.has(skill)) {
            addedSkills.push(skill);
        } else if (currentHashes[skill] !== existingHashes[skill]) {
            changedSkills.push(skill);
        } else {
            unchangedSkills.push(skill);
        }
    }

    // Skills in existing but not in current are removed
    for (const skill of existingSkills) {
        if (!currentSkills.has(skill)) {
            removedSkills.push(skill);
        }
    }

    return {
        isVersionUpgrade: existing.version !== current.version,
        changedSkills,
        addedSkills,
        removedSkills,
        unchangedSkills,
        pyprojectChanged:
            (existing.pyprojectHash || null) !==
            (current.pyprojectHash || null),
        mcpTemplateChanged:
            (existing.mcpTemplateHash || null) !==
            (current.mcpTemplateHash || null),
        agentsChanged:
            (existing.agentsHash || null) !== (current.agentsHash || null),
        methodChanged: existing.installMethod !== current.installMethod,
        pathChanged: existing.sourcePath !== current.sourcePath,
    };
}
