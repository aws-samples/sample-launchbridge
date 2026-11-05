// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Prompt Manager Module
 *
 * Handles all user interactions using Inquirer.js.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { getAgentChoices } from './agentConfig.js';
import {
    SKILL_CATEGORIES,
    resolveSkillsFromCategories,
    resolveAllSkills,
} from './skillDiscovery.js';

/** Strips the default '?' prefix from all inquirer prompts */
const p = (question) => ({ prefix: '', ...question });

/**
 * @typedef {import('./agentConfig.js').AgentType} Agent
 * @typedef {'local' | 'global'} Scope
 * @typedef {'symlink' | 'copy'} Method
 * @typedef {'overwrite' | 'overwriteAll' | 'skip' | 'cancel'} ConflictResolution
 * @typedef {'remove' | 'removeAll' | 'skip' | 'skipAll' | 'cancel'} OrphanResolution
 */

/**
 * @typedef {Object} UserSelections
 * @property {Agent[]} agents - Selected agents
 * @property {Scope} scope - Installation scope
 * @property {Method} method - Installation method
 * @property {string} sourcePath - Path to source repository
 * @property {string[]} skills - Selected skill names
 */

/**
 * Prompts the user to select agents.
 * If a manifest exists, pre-selects agents from it.
 * The user can always change the selection.
 *
 * @param {string[]|null} manifestAgents - Agents from version_manifest.json, or null if no manifest
 * @returns {Promise<Agent[]>}
 */
export async function promptForAgents(manifestAgents = null) {
    const preSelected = manifestAgents ?? [];

    if (preSelected.length > 0) {
        console.log(
            chalk.dim(
                `  From previous install: ${preSelected.join(', ')} (pre-selected from version manifest)`
            )
        );
    }

    let agents = [];
    while (agents.length === 0) {
        const result = await inquirer.prompt([
            p({
                type: 'checkbox',
                name: 'agents',
                message: 'Select the agents to install skills for:',
                choices: getAgentChoices(preSelected),
                loop: false,
            }),
        ]);
        agents = result.agents;
        if (agents.length === 0) {
            console.log(chalk.yellow('  Please select at least one agent.'));
        }
    }
    return agents;
}

/**
 * Prompts the user to select installation method.
 * @returns {Promise<Method>}
 */
export async function promptForMethod() {
    const { method } = await inquirer.prompt([
        p({
            type: 'list',
            name: 'method',
            message: 'Select the installation method:',
            choices: [
                {
                    name: 'Symlink - Create symbolic links to source skill directories',
                    value: 'symlink',
                },
                {
                    name: 'Copy - Copy all skill files to target directories (Recommended)',
                    value: 'copy',
                },
            ],
        }),
    ]);

    return method;
}

/**
 * Prompts the user to choose between installing all skills or selecting specific ones.
 * If "select", shows the category/individual skill list with previously installed
 * skills pre-checked (from version_manifest.json when available).
 * Required skills (lb-setup) are always included regardless of choice.
 *
 * @param {string[]|null} previousSkills - Skill names from version_manifest.json, or null if no manifest
 * @param {import('./skillDiscovery.js').SkillCategory[]} [categories] - Categories to offer (defaults to SKILL_CATEGORIES)
 * @returns {Promise<string[]>} Array of skill directory names to install
 */
export async function promptForSkillCategories(
    previousSkills = null,
    categories = SKILL_CATEGORIES
) {
    const requiredCategories = categories.filter((c) => c.required);
    const requiredSkillNames = requiredCategories.flatMap((c) => c.skills);

    if (requiredSkillNames.length > 0) {
        console.log(
            chalk.dim(`  Always installed: ${requiredSkillNames.join(', ')}`)
        );
    }
    const { installMode } = await inquirer.prompt([
        p({
            type: 'list',
            name: 'installMode',
            message: 'Which skills would you like to install?',
            choices: [
                { name: 'Install all skills', value: 'all' },
                { name: 'Select skills to install', value: 'select' },
            ],
        }),
    ]);

    if (installMode === 'all') {
        return resolveAllSkills(categories);
    }

    // Build a set of previously installed skill names for pre-checking
    const previousSkillSet = new Set(previousSkills ?? []);

    // A category is pre-checked if ALL of its skills were previously installed
    const wasPreviouslyInstalled = (category) =>
        previousSkillSet.size > 0 &&
        category.skills.every((s) => previousSkillSet.has(s));

    // Step 2: Show category + individual skill list
    const optionalCategories = categories.filter(
        (c) => !c.required && !c.hidden
    );
    const groupedCategories = optionalCategories.filter((c) => !c.individual);
    const individualCategories = optionalCategories.filter((c) => c.individual);

    const choices = [
        new inquirer.Separator('── Grouped Skills ──'),
        ...groupedCategories.map((c) => ({
            name: `${c.name} — ${chalk.dim(c.description)}`,
            value: c.name,
            checked: wasPreviouslyInstalled(c),
        })),
        ...(individualCategories.length > 0
            ? [
                  new inquirer.Separator('── Individual Skills ──'),
                  ...individualCategories.map((c) => ({
                      name: `${c.name} — ${chalk.dim(c.description)}`,
                      value: c.name,
                      checked: wasPreviouslyInstalled(c),
                  })),
              ]
            : []),
    ];

    let selectedCategories = [];

    while (selectedCategories.length === 0) {
        const result = await inquirer.prompt([
            p({
                type: 'checkbox',
                name: 'selectedCategories',
                message: 'Select the skills to install:',
                choices,
                loop: false,
            }),
        ]);
        selectedCategories = result.selectedCategories;
        if (selectedCategories.length === 0) {
            console.log(chalk.yellow('  Please select at least one skill.'));
        }
    }

    return resolveSkillsFromCategories(selectedCategories, categories);
}

/**
 * Prompts the user to confirm the installation.
 * @param {string} _summary - Ignored; summary is printed by reporter before this is called
 * @returns {Promise<boolean>}
 */
export async function promptForConfirmation(_summary) {
    const { confirmed } = await inquirer.prompt([
        p({
            type: 'confirm',
            name: 'confirmed',
            message: 'Proceed with installation?',
            default: true,
        }),
    ]);

    return confirmed;
}

/**
 * Prompts the user to apply a previewed LaunchBridge update.
 *
 * Defaults to "no", unlike the install confirmation.
 * @returns {Promise<boolean>}
 */
export async function promptForUpdateConfirmation() {
    const { confirmed } = await inquirer.prompt([
        p({
            type: 'confirm',
            name: 'confirmed',
            message: 'Apply this update?',
            default: false,
        }),
    ]);

    return confirmed;
}

/**
 * Prompts the user to resolve a conflict when a skill already exists.
 * @param {string} skillName - Name of the conflicting skill
 * @returns {Promise<ConflictResolution>}
 */
export async function promptForConflictResolution(skillName) {
    console.log(
        chalk.yellow(
            `\n  Conflict: "${skillName}" already exists at the target location.`
        )
    );

    const { resolution } = await inquirer.prompt([
        p({
            type: 'list',
            name: 'resolution',
            message: `How to handle "${skillName}"?`,
            choices: [
                { name: 'Overwrite', value: 'overwrite' },
                { name: 'Overwrite all remaining', value: 'overwriteAll' },
                { name: 'Skip', value: 'skip' },
                { name: 'Cancel installation', value: 'cancel' },
            ],
        }),
    ]);

    return resolution;
}

/**
 * Prompts the user to decide what to do with orphaned skill directories.
 * @param {string[]} orphanNames
 * @param {string} targetPath
 * @returns {Promise<{action: 'remove', names: string[]} | {action: 'skip'} | {action: 'cancel'}>}
 */
export async function promptForOrphanResolution(orphanNames, targetPath) {
    console.log(
        chalk.yellow(
            `\n  Found ${orphanNames.length} orphaned skill director${orphanNames.length === 1 ? 'y' : 'ies'} not in the current skill list:`
        )
    );
    console.log(chalk.dim(`  Target: ${targetPath}`));
    for (const name of orphanNames) {
        console.log(chalk.dim(`    - ${name}`));
    }

    const { resolution } = await inquirer.prompt([
        p({
            type: 'list',
            name: 'resolution',
            message: 'How to handle previously installed skills?',
            choices: [
                { name: 'Remove all', value: 'removeAll' },
                { name: 'Review each', value: 'reviewEach' },
                { name: 'Skip all — leave as-is', value: 'skip' },
                { name: 'Cancel installation', value: 'cancel' },
            ],
        }),
    ]);

    if (resolution === 'cancel') return { action: 'cancel' };
    if (resolution === 'skip') return { action: 'skip' };
    if (resolution === 'removeAll')
        return { action: 'remove', names: [...orphanNames] };

    // reviewEach
    const toRemove = [];
    for (const name of orphanNames) {
        const { choice } = await inquirer.prompt([
            p({
                type: 'list',
                name: 'choice',
                message: `Remove orphaned directory "${name}"?`,
                choices: [
                    { name: 'Remove', value: 'remove' },
                    {
                        name: 'Remove this and all remaining',
                        value: 'removeAll',
                    },
                    { name: 'Skip', value: 'skip' },
                    { name: 'Skip this and all remaining', value: 'skipAll' },
                ],
            }),
        ]);

        if (choice === 'remove') {
            toRemove.push(name);
        } else if (choice === 'removeAll') {
            toRemove.push(
                name,
                ...orphanNames.slice(orphanNames.indexOf(name) + 1)
            );
            break;
        } else if (choice === 'skipAll') {
            break;
        }
    }

    return { action: 'remove', names: toRemove };
}
