// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Agent Configuration Module
 *
 * Centralized configuration for all supported agents.
 * To add a new agent, simply add an entry to the AGENTS object.
 */

/**
 * @typedef {Object} AgentConfig
 * @property {string} name - Internal identifier for the agent
 * @property {string} displayName - Human-readable name shown in prompts
 * @property {string} skillsDir - Relative path to skills directory (e.g., '.kiro/skills')
 */

/**
 * @typedef {keyof typeof AGENTS} AgentType
 */

/**
 * Agent configurations
 * @type {const}
 */
export const AGENTS = /** @type {const} */ ({
    claude: {
        name: 'claude',
        displayName: 'Claude Code',
        skillsDir: '.claude/skills',
    },
    cline: {
        name: 'cline',
        displayName: 'Cline',
        skillsDir: '.cline/skills',
    },
    codex: {
        name: 'codex',
        displayName: 'Codex',
        skillsDir: '.codex/skills',
    },
    // cursor: {
    //     name: 'cursor',
    //     displayName: 'Cursor',
    //     skillsDir: '.cursor/skills',
    // },
    kiro: {
        name: 'kiro',
        displayName: 'Kiro',
        skillsDir: '.kiro/skills',
    },
    pi: {
        name: 'pi',
        displayName: 'Pi',
        skillsDir: '.agents/skills',
    },
    roo: {
        name: 'roo',
        displayName: 'Roo Code',
        skillsDir: '.roo/skills',
    },
    other: {
        name: 'other',
        displayName: 'Not Listed? Install to .agents/skills',
        skillsDir: '.agents/skills',
    },
});

/**
 * Get agent config by type
 * @param {string} agentType
 * @returns {AgentConfig | undefined}
 */
export function getAgentConfig(agentType) {
    return Object.hasOwn(AGENTS, agentType) ? AGENTS[agentType] : undefined;
}

/**
 * Get choices for inquirer prompts, optionally pre-checking detected agents.
 * @param {string[]} [preChecked] - Agent names to pre-check (e.g. from detectInstalledAgents)
 * @returns {Array<{name: string, value: string, checked: boolean}>}
 */
export function getAgentChoices(preChecked = []) {
    const preCheckedSet = new Set(preChecked);
    return Object.values(AGENTS).map((agent) => ({
        name: agent.displayName,
        value: agent.name,
        checked: preCheckedSet.has(agent.name),
    }));
}
