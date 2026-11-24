// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Folder Setup Module
 *
 * Creates the .lb_workspace folder structure for LaunchBridge.
 */

import fs from 'fs/promises';
import { safePathJoin } from './pathSanitizer.js';
import { success, error as uiError, spinner } from './ui.js';

/**
 * Folder structure definition
 */
const FOLDER_STRUCTURE = {
    root: '.lb_workspace',
    subdirectories: [
        'indexing_and_qa',
        'config',
        'data',
        'feature_recommendations',
        'evaluations',
        'guardrails',
        'operational_metrics',
        'metric_analysis',
        'tests',
        'predictions',
    ],
};

/**
 * Project artifacts folder structure (created at codebase root, not inside .lb_workspace)
 */
export const ARTIFACT_STRUCTURE = {
    root: '.project_artifacts',
    // Phase folder names recognized by the iris artifact classifier
    // (RECOMMENDED_FOLDER_MAP in iris/artifacts) — other names index fine but
    // are classified as "unclassified".
    subdirectories: ['pre-project', 'during-project', 'post-project'],
};

/**
 * Extra `.lb_workspace` subdirectories created only when a specific skill is
 * installed. Keeps skill-specific workspace folders out of the default tree.
 *
 * @type {Record<string, string[]>}
 */
const SKILL_CONDITIONAL_SUBDIRS = {
    'ai-workflow': ['ai_workflow', 'ai_workflow/references'],
};

/**
 * Every `.lb_workspace` subdirectory the installer may create.
 * @type {string[]}
 */
export const WORKSPACE_SUBDIRECTORIES = [
    ...FOLDER_STRUCTURE.subdirectories,
    ...Object.values(SKILL_CONDITIONAL_SUBDIRS).flat(),
];

/**
 * The folders a repository gets for the installed skills: `.lb_workspace`
 * with its subdirectories (the skill-specific ones only for the skills that
 * need them), and `.project_artifacts` with its phase folders.
 *
 * @param {string[]} [installedSkills]
 * @returns {{ workspace: { root: string, subdirectories: string[] },
 *   artifacts: { root: string, subdirectories: string[] } }}
 */
export function workspaceLayout(installedSkills = []) {
    const extraSubdirs = [];
    for (const skill of installedSkills) {
        const subdirs = Object.hasOwn(SKILL_CONDITIONAL_SUBDIRS, skill)
            ? SKILL_CONDITIONAL_SUBDIRS[skill]
            : null;
        if (subdirs) {
            for (const dir of subdirs) {
                if (!extraSubdirs.includes(dir)) extraSubdirs.push(dir);
            }
        }
    }
    return {
        workspace: {
            root: FOLDER_STRUCTURE.root,
            subdirectories: [
                ...FOLDER_STRUCTURE.subdirectories,
                ...extraSubdirs,
            ],
        },
        artifacts: {
            root: ARTIFACT_STRUCTURE.root,
            subdirectories: [...ARTIFACT_STRUCTURE.subdirectories],
        },
    };
}

/**
 * @typedef {Object} SetupResult
 * @property {boolean} success - Whether the setup succeeded
 * @property {string[]} created - Directories that were created
 * @property {string[]} skipped - Directories that already existed
 * @property {string[]} errors - Error messages for failed operations
 */

/**
 * Creates a root directory and its subdirectories, accumulating results.
 * Returns false if the root directory could not be created (fatal), true otherwise.
 *
 * @param {string} basePath - The parent directory
 * @param {{ root: string, subdirectories: string[] }} structure - Structure definition
 * @param {SetupResult} result - Accumulated result object (mutated in place)
 * @returns {Promise<boolean>} False if root creation failed fatally
 */
async function createStructure(basePath, structure, result) {
    const rootPath = safePathJoin(basePath, structure.root);

    try {
        await fs.access(rootPath);
        result.skipped.push(structure.root);
    } catch {
        try {
            await fs.mkdir(rootPath, { recursive: true });
            result.created.push(structure.root);
        } catch (error) {
            const reason =
                error.code === 'EACCES' || error.code === 'EPERM'
                    ? `Permission denied creating ${structure.root}`
                    : `Failed to create ${structure.root}: ${error.message}`;
            result.errors.push(`Error: ${reason}`);
            return false;
        }
    }

    for (const subdir of structure.subdirectories) {
        const subdirPath = safePathJoin(rootPath, subdir);
        const label = `${structure.root}/${subdir}`;
        try {
            await fs.access(subdirPath);
            result.skipped.push(label);
        } catch {
            try {
                await fs.mkdir(subdirPath, { recursive: true });
                result.created.push(label);
            } catch (error) {
                const reason =
                    error.code === 'EACCES' || error.code === 'EPERM'
                        ? `Permission denied creating ${label}`
                        : `Failed to create ${label}: ${error.message}`;
                result.errors.push(`Error: ${reason}`);
            }
        }
    }

    return true;
}

/**
 * Creates the LaunchBridge folder structure.
 *
 * @param {string} basePath - The root directory where folders will be created
 * @param {string[]} [installedSkills] - Skills being installed; enables skill-specific subdirs
 * @returns {Promise<SetupResult>}
 */
export async function createFolderStructure(basePath, installedSkills = []) {
    /** @type {SetupResult} */
    const result = {
        success: true,
        created: [],
        skipped: [],
        errors: [],
    };

    // Verify base path exists
    try {
        await fs.access(basePath);
    } catch {
        result.success = false;
        result.errors.push(`Error: Base path does not exist: ${basePath}`);
        return result;
    }

    // Build the .lb_workspace structure, appending any skill-conditional
    // subdirectories for the skills being installed (e.g. ai_workflow).
    const layout = workspaceLayout(installedSkills);

    for (const structure of [layout.workspace, layout.artifacts]) {
        const rootCreated = await createStructure(basePath, structure, result);
        if (!rootCreated) {
            result.success = false;
            return result;
        }
    }

    if (result.errors.length > 0) {
        result.success = false;
    }

    return result;
}

/**
 * Runs the folder setup and displays results.
 *
 * @param {string} basePath - The root directory where .lb_workspace will be created
 * @param {string[]} [installedSkills] - Skills being installed; enables skill-specific subdirs
 * @returns {Promise<boolean>} True if setup succeeded
 */
export async function runFolderSetup(basePath, installedSkills = []) {
    const spin = spinner('Creating workspace folder structure');
    const result = await createFolderStructure(basePath, installedSkills);
    spin.stop();

    if (result.success) {
        success('LaunchBridge folder structure ready.');
    } else {
        uiError('Failed to create complete folder structure.');
    }

    if (result.skipped.length > 0) {
        console.log('\nSkipped (already exist):');
        for (const directory of result.skipped) {
            console.log(`  - ${directory}`);
        }
    }

    if (result.errors.length > 0) {
        console.log('\nErrors:');
        for (const error of result.errors) {
            console.log(`  ! ${error}`);
        }
    }

    return result.success;
}
