// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * AI Skills Module
 *
 * Integrates the `ai-skills` git submodule (project_dependencies/ai-skills,
 * the public sample-ai-skills library) into the LaunchBridge installer.
 *
 * Layout: one agent-agnostic tree, `<submodule>/skills/<domain>/<skill>/`,
 * where every skill directory holds a SKILL.md. Every agent installs the same
 * folder into its own skills dir, so there is no per-agent source variant.
 *
 * Bundles are derived from the tree, not from name prefixes: each domain
 * becomes one selectable category with group id `ai-domain-<domain>`
 * (AI_GROUP_PREFIX keeps group ids from ever equalling a skill name in the
 * mixed manifest keyspace). A single-skill domain is offered as an individual
 * choice. Native LaunchBridge companions (e.g. the `ai-workflow`
 * orchestrator for the research domain) are appended to a domain's category
 * via AI_DOMAIN_COMPANIONS, but stay native skills. There is no core skill and
 * nothing is added to a selection implicitly.
 *
 * Classification is by membership in the discovered list: every helper below
 * takes that list explicitly, so a native skill can never be mistaken for an
 * external one. Native names always win a collision.
 *
 * For status tracking and change detection AI skills are handled at the
 * domain level: setup_status.md shows one row per domain and the version
 * manifest stores one content hash per `ai-domain-<domain>` key. Group hashes
 * drive upgrades only; they cannot verify an installed directory. The manifest
 * also records one `shared/<skill>` digest per installed skill folder
 * (`computeAiSkillFolderHashes`), which is what `verify_integrity.py` checks
 * in every agent's skills dir.
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { safePathJoin, sanitizePathComponent } from './pathSanitizer.js';
import { discoverSkills, validateSkillStructure } from './skillDiscovery.js';
import { computeContentHash } from './contentHash.js';
import { copySkill } from './installer.js';

/** Path to the ai-skills submodule, relative to the LaunchBridge source root. */
export const AI_SUBMODULE_REL = path.join('project_dependencies', 'ai-skills');

/** Prefix of every AI group id (`ai-domain-<domain>`). */
export const AI_GROUP_PREFIX = 'ai-domain-';

/**
 * ai-skills domains LaunchBridge does not offer. `semantic-release` (the
 * `ai-release` skill) writes CI jobs and release scripts for hosting
 * platforms; it is available directly from aws-samples/sample-ai-skills.
 */
export const EXCLUDED_AI_DOMAINS = new Set(['semantic-release']);

/** Display labels for known domains. Unknown domains get `AI Skills: <domain>`. */
export const AI_DOMAIN_LABELS = {
    research: 'AI Spec-Driven Development',
};

/** Descriptions for known domains. Unknown domains list their skill names. */
export const AI_DOMAIN_DESCRIPTIONS = {
    research:
        'Spec-driven development: /ai-create → /ai-research → /ai-plan → /ai-implement → /ai-archive, plus the ai-workflow orchestrator',
};

/**
 * Native LaunchBridge skills bundled into a domain's category. They are only
 * appended when present in the native skill set, and remain native skills
 * (sourced from <root>/skills, hashed and tracked under their own name).
 *
 * @type {Record<string, string[]>}
 */
export const AI_DOMAIN_COMPANIONS = { research: ['ai-workflow'] };

/** Valid domain and skill directory names. */
const AI_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Shared-references directory name; never a domain or a skill. */
const REFERENCES_DIR = 'references';

/**
 * @typedef {Object} AiSkill
 * @property {string} name - Skill directory name (e.g. 'ai-plan')
 * @property {string} domain - Domain directory name (e.g. 'research')
 * @property {string} group - Group id, `ai-domain-<domain>`
 * @property {boolean} isAiSkill - Always true (marker for the install loop)
 * @property {string} path - Source directory, installed for every agent
 * @property {boolean} hasReferences
 * @property {boolean} hasScripts
 */

/**
 * Reads a directory's entries, or null on any error.
 * @param {string} dir
 * @returns {fs.Dirent[]|null}
 */
function readEntries(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
}

/**
 * Whether an entry is a directory (symlinks count when they stat as one).
 * @param {fs.Dirent} entry
 * @param {string} entryPath
 * @returns {boolean}
 */
function isDirectoryEntry(entry, entryPath) {
    if (entry.isDirectory()) {
        return true;
    }
    if (!entry.isSymbolicLink()) {
        return false;
    }
    try {
        return fs.statSync(entryPath).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Lists the candidate child directories of `dir`, applying the shared skip
 * rules: dot entries, `references` and non-directories are skipped silently;
 * names not matching AI_NAME_PATTERN are skipped with a warning.
 *
 * @param {string} dir
 * @param {string} kind - 'domain' or 'skill' (for warning text)
 * @param {(msg: string) => void} onWarn
 * @returns {Array<{ name: string, path: string }>} Sorted by name
 */
function listCandidateDirs(dir, kind, onWarn) {
    const entries = readEntries(dir);
    if (entries === null) {
        return [];
    }

    const result = [];
    for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith('.') || name === REFERENCES_DIR) {
            continue;
        }
        const entryPath = safePathJoin(dir, sanitizePathComponent(name));
        if (!isDirectoryEntry(entry, entryPath)) {
            continue;
        }
        if (!AI_NAME_PATTERN.test(name)) {
            onWarn(`ai-skills: invalid ${kind} name "${name}"; skipped`);
            continue;
        }
        result.push({ name, path: entryPath });
    }

    result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return result;
}

/**
 * Discovers the AI skills in `<sourcePath>/project_dependencies/ai-skills/skills`.
 *
 * Every `skills/<domain>/<skill>/` directory containing a SKILL.md is a skill
 * in group `ai-domain-<domain>`. No deeper nesting is scanned. Native names
 * win a collision; a skill name in several domains is kept from the first
 * domain in sorted order. Returns [] when the submodule is not initialized.
 * Never throws.
 *
 * @param {string} sourcePath - LaunchBridge source root
 * @param {{ nativeNames?: Set<string>, onWarn?: (msg: string) => void,
 *   excludedDomains?: Set<string> }} [options] - `excludedDomains` defaults to
 *   EXCLUDED_AI_DOMAINS
 * @returns {AiSkill[]} Sorted by name
 */
export function discoverAiSkills(
    sourcePath,
    {
        nativeNames = new Set(),
        onWarn = () => {},
        excludedDomains = EXCLUDED_AI_DOMAINS,
    } = {}
) {
    const root = safePathJoin(sourcePath, AI_SUBMODULE_REL, 'skills');
    if (!fs.existsSync(root)) {
        return [];
    }

    /** @type {Map<string, AiSkill>} */
    const byName = new Map();

    for (const domain of listCandidateDirs(root, 'domain', onWarn)) {
        if (excludedDomains.has(domain.name)) {
            continue;
        }
        for (const candidate of listCandidateDirs(
            domain.path,
            'skill',
            onWarn
        )) {
            if (!validateSkillStructure(candidate.path)) {
                continue;
            }
            if (nativeNames.has(candidate.name)) {
                onWarn(
                    `ai-skills: "${candidate.name}" shadowed by native LaunchBridge skill; skipped`
                );
                continue;
            }
            const existing = byName.get(candidate.name);
            if (existing) {
                onWarn(
                    `ai-skills: "${candidate.name}" in domain "${domain.name}" duplicates domain "${existing.domain}"; skipped`
                );
                continue;
            }
            byName.set(candidate.name, {
                name: candidate.name,
                domain: domain.name,
                group: AI_GROUP_PREFIX + domain.name,
                isAiSkill: true,
                path: candidate.path,
                hasReferences: fs.existsSync(
                    safePathJoin(candidate.path, 'references')
                ),
                hasScripts: fs.existsSync(
                    safePathJoin(candidate.path, 'scripts')
                ),
            });
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Finds a discovered AI skill by name.
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills
 * @returns {AiSkill|null}
 */
function findAiSkill(skillName, aiSkills) {
    if (!Array.isArray(aiSkills)) {
        return null;
    }
    return aiSkills.find((s) => s.name === skillName) ?? null;
}

/**
 * Returns the group id (`ai-domain-<domain>`) of a discovered AI skill, or
 * null when the name is not in the discovered list.
 *
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string|null}
 */
export function getAiSkillGroup(skillName, aiSkills) {
    return findAiSkill(skillName, aiSkills)?.group ?? null;
}

/**
 * Whether a skill is an external (submodule-sourced) AI skill, decided by
 * membership in the discovered list. Native skills always return false.
 *
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {boolean}
 */
export function isAiSkill(skillName, aiSkills) {
    return findAiSkill(skillName, aiSkills) !== null;
}

/**
 * The manifest/status tracking key for a skill: `ai-domain-<domain>` for every
 * AI skill (including single-skill domains; `individual` only affects how the
 * prompt displays the category), otherwise the name itself.
 *
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string}
 */
export function aiTrackingKey(skillName, aiSkills) {
    return getAiSkillGroup(skillName, aiSkills) ?? skillName;
}

/**
 * Builds selection categories for the discovered AI skills, shaped like
 * SKILL_CATEGORIES entries so they slot into the existing prompt/flag logic.
 * One category per domain, in sorted domain order. A single-skill domain is
 * `individual: true`. Companions from AI_DOMAIN_COMPANIONS are appended when
 * they are present in `nativeNames`.
 *
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @param {Set<string>} [nativeNames] - Native LaunchBridge skill names
 * @returns {import('./skillDiscovery.js').SkillCategory[]}
 */
export function buildAiCategories(aiSkills, nativeNames = new Set()) {
    /** @type {Map<string, string[]>} */
    const byDomain = new Map();
    for (const skill of aiSkills) {
        if (!byDomain.has(skill.domain)) {
            byDomain.set(skill.domain, []);
        }
        byDomain.get(skill.domain).push(skill.name);
    }

    const categories = [];
    for (const domain of [...byDomain.keys()].sort()) {
        const skillNames = byDomain.get(domain).sort();
        const companions = (AI_DOMAIN_COMPANIONS[domain] ?? []).filter(
            (name) => nativeNames.has(name) && !skillNames.includes(name)
        );
        const category = {
            name: AI_DOMAIN_LABELS[domain] ?? `AI Skills: ${domain}`,
            description:
                AI_DOMAIN_DESCRIPTIONS[domain] ?? skillNames.join(', '),
            skills: [...skillNames, ...companions],
            ai: true,
            group: AI_GROUP_PREFIX + domain,
        };
        if (skillNames.length === 1) {
            category.individual = true;
        }
        categories.push(category);
    }

    return categories;
}

/**
 * Maps a list of skill names to the manifest/status keyspace:
 *   - AI skills collapse to their `ai-domain-<domain>` group id
 *   - LaunchBridge skills map to themselves
 * Order is preserved and duplicates removed.
 *
 * @param {string[]} skillNames
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string[]}
 */
export function toManifestKeys(skillNames, aiSkills) {
    const seen = new Set();
    const keys = [];
    for (const name of skillNames) {
        const key = aiTrackingKey(name, aiSkills);
        if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

/**
 * Expands manifest keys back to actual skill names. Keys starting with
 * AI_GROUP_PREFIX expand to the given skills that belong to that group;
 * every other key passes through unchanged.
 *
 * @param {string[]} keys - Manifest keyspace entries
 * @param {string[]} selectedSkills - Skill names to expand group keys into
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string[]}
 */
export function expandManifestKeys(keys, selectedSkills, aiSkills) {
    const result = [];
    const seen = new Set();
    const add = (name) => {
        if (!seen.has(name)) {
            seen.add(name);
            result.push(name);
        }
    };

    for (const key of keys) {
        if (key.startsWith(AI_GROUP_PREFIX)) {
            for (const skill of selectedSkills) {
                if (getAiSkillGroup(skill, aiSkills) === key) {
                    add(skill);
                }
            }
        } else {
            add(key);
        }
    }
    return result;
}

/**
 * Builds the setup_status.md rows for AI skills: one row per discovered
 * domain, sorted by domain. AI skills do not require lb-setup, so an
 * installed domain is "ready"; a domain with nothing installed is "not
 * installed". Existing non-trivial status is preserved across merges.
 *
 * These rows are appended to the native rows by the installer's status writer
 * — native setup_status logic has no knowledge of AI skills.
 *
 * @param {Map<string, string>} existingStatuses - Parsed statuses from the current file
 * @param {string[]} installedSkillNames - Skill names from the current install run
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {Array<{ name: string, status: string }>}
 */
export function buildAiStatusRows(
    existingStatuses,
    installedSkillNames,
    aiSkills
) {
    const installedGroups = new Set();
    for (const name of installedSkillNames) {
        const group = getAiSkillGroup(name, aiSkills);
        if (group !== null) {
            installedGroups.add(group);
        }
    }

    const domains = [...new Set(aiSkills.map((s) => s.domain))].sort();
    return domains.map((domain) => {
        const key = AI_GROUP_PREFIX + domain;
        if (!installedGroups.has(key)) {
            return { name: key, status: 'not installed' };
        }
        const existing = existingStatuses.get(key);
        if (existing && existing !== 'not installed') {
            return { name: key, status: existing };
        }
        return { name: key, status: 'ready' };
    });
}

/**
 * Hashes the source folder behind every selected AI skill.
 *
 * The single hashing pass both public hash functions are built on, so a group
 * hash and the per-folder digests it covers can never disagree about the bytes
 * they saw. Entry keys are `shared/<skillName>` (`shared/ai-plan`): every agent
 * installs the same folder, and `verify_integrity.py` resolves that key in
 * each agent's skills dir.
 *
 * @param {string[]} selectedSkills - Actual selected skill names
 * @param {AiSkill[]} aiSkills - Discovered AI skills (provides source paths)
 * @returns {Promise<Map<string, Array<{key: string, hash: string}>>>}
 *   Map of group id → its folder entries, sorted by key.
 */
async function hashAiSkillFolders(selectedSkills, aiSkills, options = {}) {
    /** @type {Map<string, Array<{key: string, dir: string}>>} */
    const groupEntries = new Map();
    const seen = new Set();

    for (const name of selectedSkills) {
        const skill = findAiSkill(name, aiSkills);
        if (!skill || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const group = aiTrackingKey(name, aiSkills);
        if (!groupEntries.has(group)) {
            groupEntries.set(group, []);
        }
        groupEntries
            .get(group)
            .push({ key: `shared/${name}`, dir: skill.path });
    }

    /** @type {Map<string, Array<{key: string, hash: string}>>} */
    const hashed = new Map();
    for (const [group, entries] of groupEntries) {
        const sorted = entries.sort((a, b) => a.key.localeCompare(b.key));
        const withHashes = [];
        for (const { key, dir } of sorted) {
            withHashes.push({
                key,
                hash: await computeContentHash(dir, options),
            });
        }
        hashed.set(group, withHashes);
    }

    return hashed;
}

/**
 * Computes one content hash per AI group over the selected AI skills. The
 * hash combines every selected skill folder in the domain, so a change in any
 * of them flips the group hash and triggers a reinstall.
 *
 * This is an upgrade-detection hash only. It is NOT verifiable against an
 * installed directory — use computeAiSkillFolderHashes for that.
 *
 * @param {string[]} selectedSkills - Actual selected skill names
 * @param {AiSkill[]} aiSkills - Discovered AI skills (provides source paths)
 * @returns {Promise<Record<string, string>>} Map of group id → combined hash
 */
export async function computeAiGroupHashes(
    selectedSkills,
    aiSkills,
    options = {}
) {
    const hashed = await hashAiSkillFolders(selectedSkills, aiSkills, options);

    /** @type {Record<string, string>} */
    const result = {};
    for (const [group, entries] of hashed) {
        const hasher = crypto.createHash('sha256');
        for (const { key, hash } of entries) {
            hasher.update(key + '\0');
            hasher.update(hash);
        }
        result[group] = hasher.digest('hex');
    }

    return result;
}

/**
 * Computes a per-folder content hash for every selected AI skill.
 *
 * These are the digests an integrity check can actually verify: each key names
 * one source folder that was copied (or symlinked) into every selected
 * agent's skills dir, so recomputing any installed copy reproduces the value.
 *
 * @param {string[]} selectedSkills - Actual selected skill names
 * @param {AiSkill[]} aiSkills - Discovered AI skills (provides source paths)
 * @returns {Promise<Record<string, string>>} Map of `shared/<skillName>` → hash
 */
export async function computeAiSkillFolderHashes(
    selectedSkills,
    aiSkills,
    options = {}
) {
    const hashed = await hashAiSkillFolders(selectedSkills, aiSkills, options);

    /** @type {Record<string, string>} */
    const result = {};
    for (const entries of hashed.values()) {
        for (const { key, hash } of entries) {
            result[key] = hash;
        }
    }

    return result;
}

/**
 * Removes a path (file, symlink, or directory). No-op if it doesn't exist.
 * @param {string} p
 */
async function removePathRecursive(p) {
    try {
        const stats = await fsp.lstat(p);
        if (stats.isSymbolicLink() || stats.isFile()) {
            await fsp.unlink(p);
        } else if (stats.isDirectory()) {
            await fsp.rm(p, { recursive: true, force: true });
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

/**
 * Post-pull update for AI skills, kept self-contained so the native updater
 * has no knowledge of external skills. AI skills are tracked at the domain
 * level, so the manifest does not record which individual skills were
 * installed — instead we scan each agent's target directory for installed AI
 * skills (by membership in the discovered list) and re-copy the ones whose
 * domain content changed.
 *
 * For symlink installs the git submodule update already refreshed the content,
 * so nothing is copied.
 *
 * @param {string} sourcePath - LaunchBridge source root
 * @param {string} targetRepo - Target repository root
 * @param {object} manifest - Existing version manifest (provides group hashes, agents, method)
 * @param {{ muted: Function, success: Function, warn: Function }} ui
 * @returns {Promise<{ updated: string[], newHashes: Record<string, string>,
 *   newFolderHashes: Record<string, string> }>} updated skill names, refreshed
 *   group hashes, and refreshed per-folder digests (all merged into the manifest)
 */
export async function updateAiSkills(sourcePath, targetRepo, manifest, ui) {
    const { muted, success, warn } = ui;
    const aiSkills = discoverAiSkills(sourcePath, {
        nativeNames: new Set(discoverSkills(sourcePath).map((s) => s.name)),
        onWarn: warn,
    });
    if (aiSkills.length === 0) {
        return { updated: [], newHashes: {}, newFolderHashes: {} };
    }

    const installMethod = manifest.installMethod;
    const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
    const oldHashes = manifest.skillHashes || {};

    const { getTargetPath, checkSkillsDirectory } =
        await import('./pathValidator.js');
    const { readInstalledTargets, namesUnder } =
        await import('./installedTargets.js');
    const installedTargets = readInstalledTargets(manifest);

    // Scan each agent's target dir for installed AI skills. When the manifest
    // records which directories LaunchBridge installed, only those count; a
    // same-named directory it skipped is left alone.
    const installedByAgent = new Map();
    const allInstalled = new Set();
    for (const agent of agents) {
        let base;
        try {
            base = getTargetPath(agent, 'local', targetRepo);
        } catch {
            continue;
        }
        const dirCheck = await checkSkillsDirectory(base, targetRepo);
        if (!dirCheck.ok) {
            warn(`  Skipped AI skills for ${agent}: ${dirCheck.reason}`);
            continue;
        }
        let entries;
        try {
            entries = await fsp.readdir(base, { withFileTypes: true });
        } catch {
            continue;
        }
        const names = entries
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name)
            .filter((n) => isAiSkill(n, aiSkills));
        const owned = installedTargets
            ? names.filter((n) =>
                  namesUnder(installedTargets, targetRepo, base).has(n)
              )
            : names;
        installedByAgent.set(agent, owned);
        owned.forEach((n) => allInstalled.add(n));
    }

    if (allInstalled.size === 0) {
        return { updated: [], newHashes: {}, newFolderHashes: {} };
    }

    // Recompute hashes from the union of installed AI skills. Links that leave
    // the LaunchBridge source tree are not hashed (or copied, below).
    const allowedRoot = await fsp.realpath(sourcePath);
    const newHashes = await computeAiGroupHashes([...allInstalled], aiSkills, {
        allowedRoot,
    });
    // Refreshed alongside the group hashes: an update that changed the source
    // must move the per-folder digests too, or the next integrity check reports
    // the update as tampering.
    const newFolderHashes = await computeAiSkillFolderHashes(
        [...allInstalled],
        aiSkills,
        { allowedRoot }
    );
    const changedGroups = Object.keys(newHashes).filter(
        (group) => newHashes[group] !== oldHashes[group]
    );

    const updated = [];

    if (installMethod === 'copy' && changedGroups.length > 0) {
        const changedSet = new Set(changedGroups);

        for (const [agent, names] of installedByAgent) {
            const base = getTargetPath(agent, 'local', targetRepo);
            for (const name of names) {
                if (!changedSet.has(aiTrackingKey(name, aiSkills))) {
                    continue;
                }
                const skill = findAiSkill(name, aiSkills);
                if (!skill) {
                    continue;
                }
                const target = safePathJoin(base, name);
                try {
                    await removePathRecursive(target);
                    await copySkill(skill.path, target, {
                        allowedRoot,
                        onSkip: (src, resolved) =>
                            warn(
                                `  Skipped link outside the LaunchBridge source: ${src} -> ${resolved}`
                            ),
                    });
                    muted(`  Updated AI skill: ${name} (${agent})`);
                    if (!updated.includes(name)) {
                        updated.push(name);
                    }
                } catch (err) {
                    warn(
                        `  Could not update AI skill ${name} for ${agent}: ${err.message}`
                    );
                }
            }
        }

        if (updated.length > 0) {
            success(
                `${updated.length} AI skill(s) re-copied from updated source.`
            );
        }
    } else if (installMethod === 'symlink' && changedGroups.length > 0) {
        muted('  AI skills updated automatically via symlinks / submodule.');
    }

    return { updated, newHashes, newFolderHashes };
}
