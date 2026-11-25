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
 * @property {string} skillsDir - Skills directory relative to the project root
 *   (local install, e.g. '.kiro/skills')
 * @property {string} globalSkillsDir - Skills directory relative to the user's
 *   home directory (global install, e.g. '.kiro/skills' for `~/.kiro/skills`)
 */

/**
 * @typedef {keyof typeof AGENTS} AgentType
 * @typedef {'local' | 'global'} Scope
 */

/**
 * Agent configurations. `globalSkillsDir` is the folder each agent documents
 * for user-level skills; it differs from `skillsDir` only for Codex, which
 * reads user skills from `~/.agents/skills`.
 * @type {const}
 */
export const AGENTS = /** @type {const} */ ({
    claude: {
        name: 'claude',
        displayName: 'Claude Code',
        skillsDir: '.claude/skills',
        globalSkillsDir: '.claude/skills',
    },
    cline: {
        name: 'cline',
        displayName: 'Cline',
        skillsDir: '.cline/skills',
        globalSkillsDir: '.cline/skills',
    },
    codex: {
        name: 'codex',
        displayName: 'Codex',
        skillsDir: '.codex/skills',
        globalSkillsDir: '.agents/skills',
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
        globalSkillsDir: '.kiro/skills',
    },
    pi: {
        name: 'pi',
        displayName: 'Pi',
        skillsDir: '.agents/skills',
        globalSkillsDir: '.agents/skills',
    },
    roo: {
        name: 'roo',
        displayName: 'Roo Code',
        skillsDir: '.roo/skills',
        globalSkillsDir: '.roo/skills',
    },
    other: {
        name: 'other',
        displayName: 'Not Listed? Install to .agents/skills',
        skillsDir: '.agents/skills',
        globalSkillsDir: '.agents/skills',
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
 * The agent's skills directory for an install scope, as a POSIX path relative
 * to the project root (`local`) or the user's home directory (`global`).
 *
 * @param {string} agentType
 * @param {Scope} [scope]
 * @returns {string}
 * @throws {Error} For an unknown agent or scope
 */
export function getSkillsDir(agentType, scope = 'local') {
    const config = getAgentConfig(agentType);
    if (!config) {
        throw new Error(`Unknown agent type: ${agentType}`);
    }
    if (scope === 'global') {
        return config.globalSkillsDir;
    }
    if (scope === 'local') {
        return config.skillsDir;
    }
    throw new Error(`Unknown install scope: ${scope}`);
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
