// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Skill Discovery Module
 *
 * Discovers available skills in the source repository.
 */

import fs from 'fs';
import { sanitizePathComponent, safePathJoin } from './pathSanitizer.js';

/**
 * @typedef {Object} Skill
 * @property {string} name - Name of the skill
 * @property {string} path - Full path to the skill directory
 * @property {boolean} hasSkillMd - Whether SKILL.md exists
 * @property {boolean} hasReferences - Whether references/ directory exists
 * @property {boolean} hasScripts - Whether scripts/ directory exists
 */

/**
 * @typedef {Object} SkillCategory
 * @property {string} name - Display name shown in the prompt
 * @property {string} description - Short description of what this category provides
 * @property {string[]} skills - Skill directory names that belong to this category
 * @property {boolean} [required] - If true, always installed and not shown as a choice
 * @property {boolean} [individual] - If true, rendered as a standalone skill choice rather than a grouped category
 * @property {boolean} [hidden] - If true, never shown as a choice, but still enumerated (e.g. for status tracking) and resolvable; used for skills bundled into another category
 * @property {boolean} [ai] - If true, this category comes from the ai-skills submodule
 * @property {string} [group] - For AI categories, the group id (`ai-domain-<domain>`, e.g. ai-domain-research)
 */

/**
 * Per-skill setup requirement. Determines whether a skill needs lb-setup to run
 * its setup phase (`not started`) or is ready to use immediately after installation (`ready`).
 *
 * Skills with `true` → status set to `not started` when newly installed
 * Skills with `false` → status set to `ready` when newly installed
 *
 * @type {Record<string, boolean>}
 */
export const SKILL_REQUIRES_SETUP = {
    'indexing-and-qa': true,
    'code-guardrails': true,
    'config-prompt-registry': true,
    'testing-framework': true,
    'data-wrangler': false,
    'generate-predictions': false,
    'evaluate-predictions': false,
    'comparative-metric-analysis': false,
    'operational-metrics': false,
    'feature-recommendations': false,
    'ai-workflow': false,
};

/**
 * Skill categories define how skills are grouped for selection.
 * Skills within a category are always installed together.
 * Categories marked `required: true` are always included silently.
 * Categories marked `individual: true` are shown as standalone checkboxes.
 *
 * A skill can appear in multiple categories — duplicates are resolved at install time.
 * Whether a skill requires setup is determined by SKILL_REQUIRES_SETUP (per-skill),
 * not by the category.
 *
 * @type {SkillCategory[]}
 */
export const SKILL_CATEGORIES = [
    {
        name: 'Setup (required)',
        description: 'Core LaunchBridge setup — always installed',
        skills: ['lb-setup'],
        required: true,
    },

    // ── Grouped categories ────────────────────────────────────────────────────

    {
        name: 'Automated Evaluation',
        description:
            'Data wrangling, prediction generation, and evaluation metrics',
        skills: [
            'data-wrangler',
            'generate-predictions',
            'evaluate-predictions',
            'comparative-metric-analysis',
        ],
    },
    {
        name: 'Operational Analysis',
        description:
            'Cost and latency analysis with prediction data to back it up',
        skills: ['generate-predictions', 'operational-metrics'],
    },

    // ── Individual skills ─────────────────────────────────────────────────────
    {
        name: 'Indexing and Q&A',
        description: 'Code indexing and semantic Q&A',
        skills: ['indexing-and-qa'],
        individual: true,
    },
    {
        name: 'Code Guardrails',
        description:
            'Coding standards, best practices, and guardrail enforcement',
        skills: ['code-guardrails'],
        individual: true,
    },
    {
        name: 'Feature Recommendations',
        description:
            'Codebase analysis for high-impact feature opportunities and production readiness',
        skills: ['feature-recommendations'],
        individual: true,
    },
    {
        name: 'Testing Framework',
        description: 'Python test discovery, generation, and coverage analysis',
        skills: ['testing-framework'],
        individual: true,
    },
    {
        name: 'Config and Prompt Registry',
        description:
            'One registry of every config value and prompt template, kept in sync with the code',
        skills: ['config-prompt-registry'],
        individual: true,
    },

    // ── Hidden: bundled into another category, never shown standalone ─────────
    {
        // The AI code workflow orchestrator is a native skill bundled into the
        // AI Spec-Driven Development selection (the ai-skills research domain;
        // see AI_DOMAIN_COMPANIONS in aiSkills.js). It is hidden here so it is
        // enumerated for status tracking and resolved by "Install all", but
        // never offered as its own checkbox.
        name: 'AI Workflow (orchestrator)',
        description:
            'Orchestrator for the AI Spec-Driven Development skills (bundled with the research domain; see aiSkills.js AI_DOMAIN_COMPANIONS)',
        skills: ['ai-workflow'],
        hidden: true,
    },
];

/**
 * Returns the flat list of skill names for a given set of selected category names,
 * always including skills from required categories.
 *
 * @param {string[]} selectedCategoryNames - Category names the user chose
 * @param {SkillCategory[]} [categories] - Category list to resolve against (defaults to SKILL_CATEGORIES)
 * @returns {string[]} Deduplicated list of skill directory names to install
 */
export function resolveSkillsFromCategories(
    selectedCategoryNames,
    categories = SKILL_CATEGORIES
) {
    const skillSet = new Set();

    for (const category of categories) {
        if (
            category.required ||
            selectedCategoryNames.includes(category.name)
        ) {
            for (const skill of category.skills) {
                skillSet.add(skill);
            }
        }
    }

    return [...skillSet];
}

/**
 * Returns all skill directory names across every category (including required).
 * Used when the user chooses "Install all skills".
 *
 * @param {SkillCategory[]} [categories] - Category list to resolve against (defaults to SKILL_CATEGORIES)
 * @returns {string[]} Deduplicated list of all skill directory names
 */
export function resolveAllSkills(categories = SKILL_CATEGORIES) {
    const skillSet = new Set();
    for (const category of categories) {
        for (const skill of category.skills) {
            skillSet.add(skill);
        }
    }
    return [...skillSet];
}

/**
 * Discovers all available skills in the source repository.
 * Scans the /skills directory for subdirectories that contain a SKILL.md file.
 *
 * @param {string} sourcePath - Path to the source repository
 * @returns {Skill[]} Array of discovered skills with their metadata
 */
export function discoverSkills(sourcePath) {
    const skillsDir = safePathJoin(sourcePath, 'skills');

    // Check if skills directory exists
    if (!fs.existsSync(skillsDir)) {
        return [];
    }

    // Get all entries in the skills directory
    let entries;
    try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const skills = [];

    for (const entry of entries) {
        // Process directories and symlinks that point to directories
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
            continue;
        }

        // For symlinks, verify the target is a directory
        if (entry.isSymbolicLink()) {
            const symPath = safePathJoin(skillsDir, entry.name);
            try {
                const targetStats = fs.statSync(symPath); // follows symlinks
                if (!targetStats.isDirectory()) {
                    continue;
                }
            } catch {
                continue; // broken symlink or inaccessible
            }
        }

        const sanitizedEntryName = sanitizePathComponent(entry.name);
        const skillPath = safePathJoin(skillsDir, sanitizedEntryName);

        // Only include directories that have a SKILL.md file (required)
        if (!validateSkillStructure(skillPath)) {
            continue;
        }

        // Build the Skill object with all metadata
        const skill = {
            name: entry.name,
            path: skillPath,
            hasSkillMd: true, // Already validated above
            hasReferences: fs.existsSync(safePathJoin(skillPath, 'references')),
            hasScripts: fs.existsSync(safePathJoin(skillPath, 'scripts')),
        };

        skills.push(skill);
    }

    return skills;
}

/**
 * Validates that a skill directory has the required structure.
 * A valid skill must contain a SKILL.md file.
 *
 * @param {string} skillPath - Path to the skill directory
 * @returns {boolean} True if the skill has a valid structure (contains SKILL.md)
 */
export function validateSkillStructure(skillPath) {
    const skillMdPath = safePathJoin(skillPath, 'SKILL.md');

    try {
        return fs.existsSync(skillMdPath) && fs.statSync(skillMdPath).isFile();
    } catch {
        return false;
    }
}
