// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for Skill Discovery Module
 *
 * Tests the discoverSkills and validateSkillStructure functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    discoverSkills,
    validateSkillStructure,
    SKILL_CATEGORIES,
    SKILL_REQUIRES_SETUP,
} from '../../lib/skillDiscovery.js';
import { SKILL_TO_EXTRA } from '../../lib/venvSetup.js';

describe('skillDiscovery', () => {
    let tempDir;

    beforeEach(async () => {
        // Create a temporary directory for each test
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    });

    afterEach(async () => {
        // Clean up temporary directory
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('discoverSkills', () => {
        it('should return empty array when skills directory does not exist', () => {
            const result = discoverSkills(tempDir);
            expect(result).toEqual([]);
        });

        it('should return empty array when skills directory is empty', () => {
            fs.mkdirSync(path.join(tempDir, 'skills'));
            const result = discoverSkills(tempDir);
            expect(result).toEqual([]);
        });

        it('should discover a skill with only SKILL.md', () => {
            const skillsDir = path.join(tempDir, 'skills');
            const skillDir = path.join(skillsDir, 'my-skill');
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('my-skill');
            expect(result[0].path).toBe(skillDir);
            expect(result[0].hasSkillMd).toBe(true);
            expect(result[0].hasReferences).toBe(false);
            expect(result[0].hasScripts).toBe(false);
        });

        it('should discover a skill with SKILL.md and references directory', () => {
            const skillsDir = path.join(tempDir, 'skills');
            const skillDir = path.join(skillsDir, 'my-skill');
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');
            fs.mkdirSync(path.join(skillDir, 'references'));

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(1);
            expect(result[0].hasReferences).toBe(true);
            expect(result[0].hasScripts).toBe(false);
        });

        it('should discover a skill with SKILL.md and scripts directory', () => {
            const skillsDir = path.join(tempDir, 'skills');
            const skillDir = path.join(skillsDir, 'my-skill');
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');
            fs.mkdirSync(path.join(skillDir, 'scripts'));

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(1);
            expect(result[0].hasReferences).toBe(false);
            expect(result[0].hasScripts).toBe(true);
        });

        it('should discover a skill with all optional directories', () => {
            const skillsDir = path.join(tempDir, 'skills');
            const skillDir = path.join(skillsDir, 'complete-skill');
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(
                path.join(skillDir, 'SKILL.md'),
                '# Complete Skill'
            );
            fs.mkdirSync(path.join(skillDir, 'references'));
            fs.mkdirSync(path.join(skillDir, 'scripts'));

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('complete-skill');
            expect(result[0].hasSkillMd).toBe(true);
            expect(result[0].hasReferences).toBe(true);
            expect(result[0].hasScripts).toBe(true);
        });

        it('should NOT discover directories without SKILL.md', () => {
            const skillsDir = path.join(tempDir, 'skills');
            const invalidSkillDir = path.join(skillsDir, 'invalid-skill');
            fs.mkdirSync(invalidSkillDir, { recursive: true });
            fs.writeFileSync(
                path.join(invalidSkillDir, 'README.md'),
                '# Not a skill'
            );

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(0);
        });

        it('should discover multiple skills', () => {
            const skillsDir = path.join(tempDir, 'skills');

            // Create first skill
            const skill1Dir = path.join(skillsDir, 'skill-one');
            fs.mkdirSync(skill1Dir, { recursive: true });
            fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '# Skill One');

            // Create second skill
            const skill2Dir = path.join(skillsDir, 'skill-two');
            fs.mkdirSync(skill2Dir, { recursive: true });
            fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '# Skill Two');
            fs.mkdirSync(path.join(skill2Dir, 'references'));

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(2);
            const names = result.map((s) => s.name).sort();
            expect(names).toEqual(['skill-one', 'skill-two']);
        });

        it('should ignore files in skills directory (only process directories)', () => {
            const skillsDir = path.join(tempDir, 'skills');
            fs.mkdirSync(skillsDir);
            fs.writeFileSync(path.join(skillsDir, 'README.md'), '# Skills');

            // Create a valid skill
            const skillDir = path.join(skillsDir, 'valid-skill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Valid Skill');

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('valid-skill');
        });

        it('should only include valid skills (with SKILL.md) and exclude invalid ones', () => {
            const skillsDir = path.join(tempDir, 'skills');

            // Create valid skill
            const validSkillDir = path.join(skillsDir, 'valid-skill');
            fs.mkdirSync(validSkillDir, { recursive: true });
            fs.writeFileSync(path.join(validSkillDir, 'SKILL.md'), '# Valid');

            // Create invalid skill (no SKILL.md)
            const invalidSkillDir = path.join(skillsDir, 'invalid-skill');
            fs.mkdirSync(invalidSkillDir, { recursive: true });
            fs.writeFileSync(path.join(invalidSkillDir, 'other.md'), '# Other');

            const result = discoverSkills(tempDir);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('valid-skill');
        });
    });

    describe('validateSkillStructure', () => {
        it('should return true when SKILL.md exists', () => {
            const skillDir = path.join(tempDir, 'my-skill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');

            const result = validateSkillStructure(skillDir);

            expect(result).toBe(true);
        });

        it('should return false when SKILL.md does not exist', () => {
            const skillDir = path.join(tempDir, 'my-skill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'README.md'), '# Not a skill');

            const result = validateSkillStructure(skillDir);

            expect(result).toBe(false);
        });

        it('should return false when path does not exist', () => {
            const nonExistentPath = path.join(tempDir, 'non-existent');

            const result = validateSkillStructure(nonExistentPath);

            expect(result).toBe(false);
        });

        it('should return false when SKILL.md is a directory instead of a file', () => {
            const skillDir = path.join(tempDir, 'my-skill');
            fs.mkdirSync(skillDir);
            fs.mkdirSync(path.join(skillDir, 'SKILL.md')); // Create as directory

            const result = validateSkillStructure(skillDir);

            expect(result).toBe(false);
        });

        // Note: This test is skipped on case-insensitive file systems (like macOS default)
        // The implementation correctly looks for 'SKILL.md' but the file system may treat
        // 'skill.md' and 'SKILL.md' as the same file
        it.skipIf(process.platform === 'darwin')(
            'should be case-sensitive for SKILL.md',
            () => {
                const skillDir = path.join(tempDir, 'my-skill');
                fs.mkdirSync(skillDir);
                fs.writeFileSync(
                    path.join(skillDir, 'skill.md'),
                    '# Wrong case'
                );

                const result = validateSkillStructure(skillDir);

                expect(result).toBe(false);
            }
        );
    });
});

describe('skill registration consistency', () => {
    // These tests guard against accidental regressions where a new skill
    // is added to one registration table but forgotten in another.
    // Each known individual skill must appear in:
    //   1. SKILL_CATEGORIES (so the user can see/select it)
    //   2. SKILL_REQUIRES_SETUP (so its post-install status is set)
    //   3. SKILL_TO_EXTRA   (only if it has Python dependencies)
    const KNOWN_INDIVIDUAL_SKILLS = [
        'indexing-and-qa',
        'code-guardrails',
        'feature-recommendations',
        'testing-framework',
        'config-prompt-registry',
    ];

    const KNOWN_SKILLS_WITH_PYTHON_DEPS = [
        'indexing-and-qa',
        'config-prompt-registry',
        'testing-framework',
        'evaluate-predictions',
        'generate-predictions',
        'data-wrangler',
    ];

    it.each(KNOWN_INDIVIDUAL_SKILLS)(
        '%s appears as an individual category in SKILL_CATEGORIES',
        (skillName) => {
            const matching = SKILL_CATEGORIES.find(
                (c) => c.individual && c.skills.includes(skillName)
            );
            expect(matching).toBeDefined();
        }
    );

    it.each(KNOWN_INDIVIDUAL_SKILLS)(
        '%s has an entry in SKILL_REQUIRES_SETUP',
        (skillName) => {
            expect(skillName in SKILL_REQUIRES_SETUP).toBe(true);
        }
    );

    it.each(KNOWN_SKILLS_WITH_PYTHON_DEPS)(
        '%s has an entry in SKILL_TO_EXTRA',
        (skillName) => {
            expect(skillName in SKILL_TO_EXTRA).toBe(true);
        }
    );

    it('keeps the ai-workflow orchestrator as a hidden category', () => {
        const matching = SKILL_CATEGORIES.find((c) =>
            c.skills.includes('ai-workflow')
        );
        expect(matching).toBeDefined();
        expect(matching.hidden).toBe(true);
        expect(SKILL_REQUIRES_SETUP['ai-workflow']).toBe(false);
    });

    it('has no ai-init category or setup entry', () => {
        expect(
            SKILL_CATEGORIES.some(
                (c) => c.name === 'ai-init' || c.skills.includes('ai-init')
            )
        ).toBe(false);
        expect('ai-init' in SKILL_REQUIRES_SETUP).toBe(false);
    });
});
