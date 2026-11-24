// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for promptManager module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import inquirer from 'inquirer';
import {
    promptForAgents,
    promptForScope,
    resolveScope,
    promptForConfirmation,
    promptForConflictResolution,
} from '../../lib/promptManager.js';

// Mock inquirer
vi.mock('inquirer');

describe('promptForScope', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('defaults to Global and lists it first', async () => {
        inquirer.prompt.mockResolvedValueOnce({ scope: 'global' });

        const result = await promptForScope(['claude']);

        expect(result).toBe('global');
        const config = inquirer.prompt.mock.calls[0][0][0];
        expect(config.type).toBe('select');
        expect(config.default).toBe('global');
        expect(config.choices.map((c) => c.value)).toEqual(['global', 'local']);
    });

    it('shows every selected agent’s folder for each scope', async () => {
        inquirer.prompt.mockResolvedValueOnce({ scope: 'local' });

        expect(await promptForScope(['claude', 'codex', 'kiro'])).toBe('local');

        const [globalChoice, localChoice] =
            inquirer.prompt.mock.calls[0][0][0].choices;
        expect(globalChoice.name).toContain(
            '~/.claude/skills, ~/.agents/skills, ~/.kiro/skills'
        );
        expect(localChoice.name).toContain(
            './.claude/skills, ./.codex/skills, ./.kiro/skills'
        );
    });

    it('names a folder agents share once', async () => {
        inquirer.prompt.mockResolvedValueOnce({ scope: 'global' });

        await promptForScope(['codex', 'pi', 'other']);

        const [globalChoice, localChoice] =
            inquirer.prompt.mock.calls[0][0][0].choices;
        expect(globalChoice.name.match(/~\/\.agents\/skills/g)).toHaveLength(1);
        expect(localChoice.name).toContain('./.codex/skills, ./.agents/skills');
        expect(localChoice.name.match(/\.agents\/skills/g)).toHaveLength(1);
    });

    it('shows Claude Code’s folders when no agent is given', async () => {
        inquirer.prompt.mockResolvedValueOnce({ scope: 'global' });

        await promptForScope();

        const [globalChoice] = inquirer.prompt.mock.calls[0][0][0].choices;
        expect(globalChoice.name).toContain('~/.claude/skills');
    });

    it('says when this folder or the home folder already has an install', async () => {
        inquirer.prompt.mockResolvedValueOnce({ scope: 'global' });

        await promptForScope(['kiro'], {
            localInstall: true,
            globalInstall: true,
        });

        const printed = console.log.mock.calls.flat().join('\n');
        expect(printed).toContain('local LaunchBridge install');
        expect(printed).toContain('global LaunchBridge install');
    });
});

describe('resolveScope', () => {
    it('uses --scope when it is given', async () => {
        const prompt = vi.fn();
        expect(await resolveScope({ scope: 'local', yes: true }, prompt)).toBe(
            'local'
        );
        expect(
            await resolveScope({ scope: 'global', yes: false }, prompt)
        ).toBe('global');
        expect(prompt).not.toHaveBeenCalled();
    });

    it('installs globally for --yes without --scope, without asking', async () => {
        const prompt = vi.fn();
        expect(await resolveScope({ scope: null, yes: true }, prompt)).toBe(
            'global'
        );
        expect(prompt).not.toHaveBeenCalled();
    });

    it('asks when neither flag decides', async () => {
        const prompt = vi.fn().mockResolvedValue('local');
        expect(await resolveScope({ scope: null, yes: false }, prompt)).toBe(
            'local'
        );
        expect(prompt).toHaveBeenCalledTimes(1);
    });
});

describe('promptForAgents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should return selected agents when user selects Kiro', async () => {
        inquirer.prompt.mockResolvedValueOnce({ agents: ['kiro'] });

        const result = await promptForAgents();

        expect(result).toEqual(['kiro']);
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should return selected agents when user selects Claude Code', async () => {
        inquirer.prompt.mockResolvedValueOnce({ agents: ['claude'] });

        const result = await promptForAgents();

        expect(result).toEqual(['claude']);
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should return both agents when user selects both', async () => {
        inquirer.prompt.mockResolvedValueOnce({ agents: ['kiro', 'claude'] });

        const result = await promptForAgents();

        expect(result).toEqual(['kiro', 'claude']);
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should re-prompt until at least one agent is selected', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ agents: [] })
            .mockResolvedValueOnce({ agents: ['kiro'] });

        const result = await promptForAgents();

        expect(result).toEqual(['kiro']);
        expect(inquirer.prompt).toHaveBeenCalledTimes(2);
    });

    it('should use checkbox type for multi-select', async () => {
        inquirer.prompt.mockResolvedValueOnce({ agents: ['kiro'] });

        await promptForAgents();

        expect(inquirer.prompt).toHaveBeenCalledWith([
            expect.objectContaining({
                type: 'checkbox',
                name: 'agents',
                choices: expect.arrayContaining([
                    expect.objectContaining({ name: 'Kiro', value: 'kiro' }),
                    expect.objectContaining({
                        name: 'Claude Code',
                        value: 'claude',
                    }),
                ]),
            }),
        ]);
    });

    it('should pre-check agents from manifest when provided', async () => {
        inquirer.prompt.mockResolvedValueOnce({ agents: ['kiro'] });

        await promptForAgents(['kiro']);

        const promptConfig = inquirer.prompt.mock.calls[0][0][0];
        const kiroChoice = promptConfig.choices.find((c) => c.value === 'kiro');
        expect(kiroChoice.checked).toBe(true);
    });
});

describe('promptForConfirmation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should return true when user confirms', async () => {
        inquirer.prompt.mockResolvedValueOnce({ confirmed: true });

        const result = await promptForConfirmation('Test summary');

        expect(result).toBe(true);
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should return false when user cancels', async () => {
        inquirer.prompt.mockResolvedValueOnce({ confirmed: false });

        const result = await promptForConfirmation('Test summary');

        expect(result).toBe(false);
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should not print the summary (summary is printed by reporter before this is called)', async () => {
        inquirer.prompt.mockResolvedValueOnce({ confirmed: true });

        await promptForConfirmation('Test summary');

        expect(console.log).not.toHaveBeenCalled();
    });

    it('should use confirm type for yes/no prompt', async () => {
        inquirer.prompt.mockResolvedValueOnce({ confirmed: true });

        await promptForConfirmation('Test summary');

        expect(inquirer.prompt).toHaveBeenCalledWith([
            expect.objectContaining({
                type: 'confirm',
                name: 'confirmed',
            }),
        ]);
    });

    it('should default to true (yes) for convenience', async () => {
        inquirer.prompt.mockResolvedValueOnce({ confirmed: true });

        await promptForConfirmation('Test summary');

        expect(inquirer.prompt).toHaveBeenCalledWith([
            expect.objectContaining({
                default: true,
            }),
        ]);
    });

    it('should ask about proceeding with installation', async () => {
        inquirer.prompt.mockResolvedValueOnce({ confirmed: true });

        await promptForConfirmation('Test summary');

        const promptConfig = inquirer.prompt.mock.calls[0][0][0];
        expect(promptConfig.message).toContain('Proceed');
    });
});

describe('promptForConflictResolution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should return overwrite when user selects overwrite', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'overwrite' });

        const result = await promptForConflictResolution('test-skill');

        expect(result).toBe('overwrite');
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should return skip when user selects skip', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'skip' });

        const result = await promptForConflictResolution('test-skill');

        expect(result).toBe('skip');
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should return cancel when user selects cancel', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'cancel' });

        const result = await promptForConflictResolution('test-skill');

        expect(result).toBe('cancel');
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should return overwriteAll when user selects overwrite all', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'overwriteAll' });

        const result = await promptForConflictResolution('test-skill');

        expect(result).toBe('overwriteAll');
        expect(inquirer.prompt).toHaveBeenCalledTimes(1);
    });

    it('should display conflict message with skill name', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'skip' });

        await promptForConflictResolution('my-awesome-skill');

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('my-awesome-skill')
        );
    });

    it('names the existing folder, so a run for several agents says which one', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'skip' });

        await promptForConflictResolution(
            'lb-setup',
            '/home/me/.claude/skills/lb-setup'
        );

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining(
                '"lb-setup" already exists at /home/me/.claude/skills/lb-setup.'
            )
        );
    });

    it('should use select type for single selection', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'overwrite' });

        await promptForConflictResolution('test-skill');

        expect(inquirer.prompt).toHaveBeenCalledWith([
            expect.objectContaining({
                type: 'select',
                name: 'resolution',
            }),
        ]);
    });

    it('should include skill name in the prompt message', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'skip' });

        await promptForConflictResolution('specific-skill');

        const promptConfig = inquirer.prompt.mock.calls[0][0][0];
        expect(promptConfig.message).toContain('specific-skill');
    });

    it('should offer overwrite, overwrite all, skip, and cancel options', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'overwrite' });

        await promptForConflictResolution('test-skill');

        const promptConfig = inquirer.prompt.mock.calls[0][0][0];
        const values = promptConfig.choices.map((c) => c.value);

        expect(values).toContain('overwrite');
        expect(values).toContain('overwriteAll');
        expect(values).toContain('skip');
        expect(values).toContain('cancel');
    });

    it('should have descriptive labels for each option', async () => {
        inquirer.prompt.mockResolvedValueOnce({ resolution: 'overwrite' });

        await promptForConflictResolution('test-skill');

        const promptConfig = inquirer.prompt.mock.calls[0][0][0];

        const overwriteChoice = promptConfig.choices.find(
            (c) => c.value === 'overwrite'
        );
        const overwriteAllChoice = promptConfig.choices.find(
            (c) => c.value === 'overwriteAll'
        );
        const skipChoice = promptConfig.choices.find((c) => c.value === 'skip');
        const cancelChoice = promptConfig.choices.find(
            (c) => c.value === 'cancel'
        );

        expect(overwriteChoice.name).toContain('Overwrite');
        expect(overwriteAllChoice.name).toContain('Overwrite all');
        expect(skipChoice.name).toContain('Skip');
        expect(cancelChoice.name).toContain('Cancel');
    });
});
