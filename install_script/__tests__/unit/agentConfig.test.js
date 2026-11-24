// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from 'vitest';
import { AGENTS, getAgentConfig, getSkillsDir } from '../../lib/agentConfig.js';

describe('getAgentConfig', () => {
    it('returns the config for a known agent', () => {
        expect(getAgentConfig('claude')?.skillsDir).toBe('.claude/skills');
    });

    it('does not resolve inherited object keys as agents', () => {
        for (const key of ['__proto__', 'constructor', 'toString']) {
            expect(getAgentConfig(key)).toBeUndefined();
        }
    });
});

describe('getSkillsDir', () => {
    it('gives every agent a skills directory for both scopes', () => {
        for (const name of Object.keys(AGENTS)) {
            expect(getSkillsDir(name, 'local')).toMatch(/^\.[a-z]+\/skills$/);
            expect(getSkillsDir(name, 'global')).toMatch(/^\.[a-z]+\/skills$/);
        }
    });

    it('uses the documented user-level folders for a global install', () => {
        expect(getSkillsDir('claude', 'global')).toBe('.claude/skills');
        expect(getSkillsDir('kiro', 'global')).toBe('.kiro/skills');
        expect(getSkillsDir('cline', 'global')).toBe('.cline/skills');
        expect(getSkillsDir('roo', 'global')).toBe('.roo/skills');
        expect(getSkillsDir('pi', 'global')).toBe('.agents/skills');
        expect(getSkillsDir('other', 'global')).toBe('.agents/skills');
    });

    it('puts Codex user skills in .agents/skills, and leaves its local folder as it was', () => {
        expect(getSkillsDir('codex', 'global')).toBe('.agents/skills');
        expect(getSkillsDir('codex', 'local')).toBe('.codex/skills');
    });

    it('defaults to the local scope', () => {
        expect(getSkillsDir('codex')).toBe('.codex/skills');
    });

    it('refuses an unknown agent or scope', () => {
        expect(() => getSkillsDir('__proto__', 'global')).toThrow(
            /Unknown agent/
        );
        expect(() => getSkillsDir('claude', 'system')).toThrow(
            /Unknown install scope/
        );
    });
});
