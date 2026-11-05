// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for Verifier Module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    verifyInstallation,
    verifySymlink,
    verifySkillFiles,
} from '../../lib/verifier.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('verifyInstallation', () => {
    describe('failed installation handling', () => {
        it('should return verified=false when installation already failed', () => {
            const result = {
                skillName: 'test-skill',
                agent: 'kiro',
                success: false,
                error: 'Permission denied',
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification.verified).toBe(false);
            expect(verification.skillName).toBe('test-skill');
            expect(verification.agent).toBe('kiro');
            expect(verification.error).toBe('Permission denied');
        });

        it('should use default error message when installation failed without error', () => {
            const result = {
                skillName: 'test-skill',
                agent: 'claude',
                success: false,
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'copy');

            expect(verification.verified).toBe(false);
            expect(verification.error).toBe('Installation failed');
        });

        it('should preserve skillName and agent from failed installation', () => {
            const result = {
                skillName: 'my-skill',
                agent: 'claude',
                success: false,
                error: 'Some error',
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification.skillName).toBe('my-skill');
            expect(verification.agent).toBe('claude');
        });
    });

    describe('symlink method verification', () => {
        it('should delegate to verifySymlink for symlink method', () => {
            const result = {
                skillName: 'test-skill',
                agent: 'kiro',
                success: true,
                targetPath: '/path/to/target',
            };

            // verifySymlink returns false by default (stub)
            const verification = verifyInstallation(result, 'symlink');

            expect(verification.verified).toBe(false);
            expect(verification.error).toContain('Symlink verification failed');
            expect(verification.error).toContain('/path/to/target');
        });

        it('should preserve skillName and agent for symlink verification', () => {
            const result = {
                skillName: 'my-skill',
                agent: 'claude',
                success: true,
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification.skillName).toBe('my-skill');
            expect(verification.agent).toBe('claude');
        });
    });

    describe('copy method verification', () => {
        it('should delegate to verifySkillFiles for copy method', () => {
            const result = {
                skillName: 'test-skill',
                agent: 'kiro',
                success: true,
                targetPath: '/path/to/target',
            };

            // verifySkillFiles returns false by default (stub)
            const verification = verifyInstallation(result, 'copy');

            expect(verification.verified).toBe(false);
            expect(verification.error).toContain(
                'Skill files verification failed'
            );
            expect(verification.error).toContain('/path/to/target');
        });

        it('should preserve skillName and agent for copy verification', () => {
            const result = {
                skillName: 'another-skill',
                agent: 'kiro',
                success: true,
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'copy');

            expect(verification.skillName).toBe('another-skill');
            expect(verification.agent).toBe('kiro');
        });
    });

    describe('unknown method handling', () => {
        it('should return error for unknown installation method', () => {
            const result = {
                skillName: 'test-skill',
                agent: 'kiro',
                success: true,
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'unknown');

            expect(verification.verified).toBe(false);
            expect(verification.error).toContain('Unknown installation method');
            expect(verification.error).toContain('unknown');
        });
    });

    describe('result structure', () => {
        it('should return correct structure for failed installation', () => {
            const result = {
                skillName: 'test-skill',
                agent: 'kiro',
                success: false,
                error: 'Test error',
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification).toHaveProperty('skillName');
            expect(verification).toHaveProperty('agent');
            expect(verification).toHaveProperty('verified');
            expect(verification).toHaveProperty('error');
        });

        it('should return correct structure for verification failure', () => {
            const result = {
                skillName: 'test-skill',
                agent: 'kiro',
                success: true,
                targetPath: '/path/to/target',
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification).toHaveProperty('skillName');
            expect(verification).toHaveProperty('agent');
            expect(verification).toHaveProperty('verified');
            expect(verification).toHaveProperty('error');
        });
    });
});

describe('verifySymlink', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('valid symlink installations', () => {
        it('should return true for a directory with symlinked SKILL.md', () => {
            const sourceDir = path.join(tempDir, 'source');
            const targetDir = path.join(tempDir, 'target');

            fs.mkdirSync(sourceDir);
            fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Test Skill');

            fs.mkdirSync(targetDir);
            fs.symlinkSync(
                path.join(sourceDir, 'SKILL.md'),
                path.join(targetDir, 'SKILL.md')
            );

            expect(verifySymlink(targetDir)).toBe(true);
        });

        it('should return true for a directory with multiple symlinked files', () => {
            const sourceDir = path.join(tempDir, 'source');
            const targetDir = path.join(tempDir, 'target');

            fs.mkdirSync(sourceDir);
            fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Test Skill');
            fs.writeFileSync(path.join(sourceDir, 'README.md'), '# Readme');

            fs.mkdirSync(targetDir);
            fs.symlinkSync(
                path.join(sourceDir, 'SKILL.md'),
                path.join(targetDir, 'SKILL.md')
            );
            fs.symlinkSync(
                path.join(sourceDir, 'README.md'),
                path.join(targetDir, 'README.md')
            );

            expect(verifySymlink(targetDir)).toBe(true);
        });
    });

    describe('invalid symlink installations', () => {
        it('should return false for a directory without SKILL.md', () => {
            const targetDir = path.join(tempDir, 'target');
            fs.mkdirSync(targetDir);

            expect(verifySymlink(targetDir)).toBe(false);
        });

        it('should return false for a directory with regular SKILL.md (not symlinked)', () => {
            const targetDir = path.join(tempDir, 'target');
            fs.mkdirSync(targetDir);
            fs.writeFileSync(path.join(targetDir, 'SKILL.md'), '# Test Skill');

            expect(verifySymlink(targetDir)).toBe(false);
        });

        it('should return false for a directory with broken SKILL.md symlink', () => {
            const targetDir = path.join(tempDir, 'target');
            fs.mkdirSync(targetDir);
            fs.symlinkSync(
                path.join(tempDir, 'non-existent', 'SKILL.md'),
                path.join(targetDir, 'SKILL.md')
            );

            expect(verifySymlink(targetDir)).toBe(false);
        });

        it('should return false for a regular file (not a directory)', () => {
            const filePath = path.join(tempDir, 'regular-file.txt');
            fs.writeFileSync(filePath, 'test content');

            expect(verifySymlink(filePath)).toBe(false);
        });

        it('should return false for a symlinked directory (old approach)', () => {
            const sourceDir = path.join(tempDir, 'source');
            const symlinkPath = path.join(tempDir, 'link');

            fs.mkdirSync(sourceDir);
            fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Test');
            fs.symlinkSync(sourceDir, symlinkPath);

            // Old approach: directory symlink should now fail
            // because we expect a real directory with symlinked files
            expect(verifySymlink(symlinkPath)).toBe(false);
        });
    });

    describe('non-existent paths', () => {
        it('should return false for a path that does not exist', () => {
            const nonExistentPath = path.join(tempDir, 'does-not-exist');

            expect(verifySymlink(nonExistentPath)).toBe(false);
        });
    });

    describe('error handling', () => {
        it('should return false and not throw for invalid path input', () => {
            expect(() => verifySymlink('')).not.toThrow();
            expect(verifySymlink('')).toBe(false);
        });

        it('should return false for null-like paths', () => {
            expect(verifySymlink(null)).toBe(false);
            expect(verifySymlink(undefined)).toBe(false);
        });
    });
});

describe('verifySkillFiles', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'verifier-skill-test-')
        );
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('valid skill directories', () => {
        it('should return true for a directory with SKILL.md file', () => {
            const skillDir = path.join(tempDir, 'my-skill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(
                path.join(skillDir, 'SKILL.md'),
                '# My Skill\n\nDescription'
            );

            expect(verifySkillFiles(skillDir)).toBe(true);
        });

        it('should return true for a skill directory with additional files', () => {
            const skillDir = path.join(tempDir, 'complex-skill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(
                path.join(skillDir, 'SKILL.md'),
                '# Complex Skill'
            );
            fs.mkdirSync(path.join(skillDir, 'references'));
            fs.writeFileSync(
                path.join(skillDir, 'references', 'doc.md'),
                'Reference doc'
            );

            expect(verifySkillFiles(skillDir)).toBe(true);
        });
    });

    describe('invalid skill directories', () => {
        it('should return false for a directory without SKILL.md', () => {
            const skillDir = path.join(tempDir, 'no-skill-md');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'README.md'), '# Readme');

            expect(verifySkillFiles(skillDir)).toBe(false);
        });

        it('should return false for an empty directory', () => {
            const skillDir = path.join(tempDir, 'empty-skill');
            fs.mkdirSync(skillDir);

            expect(verifySkillFiles(skillDir)).toBe(false);
        });

        it('should return false for a file instead of directory', () => {
            const filePath = path.join(tempDir, 'not-a-dir');
            fs.writeFileSync(filePath, 'just a file');

            expect(verifySkillFiles(filePath)).toBe(false);
        });

        it('should return false when SKILL.md is empty', () => {
            const skillDir = path.join(tempDir, 'empty-skill-md');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '');

            expect(verifySkillFiles(skillDir)).toBe(false);
        });

        it('should return false when SKILL.md is a directory instead of file', () => {
            const skillDir = path.join(tempDir, 'skill-md-is-dir');
            fs.mkdirSync(skillDir);
            fs.mkdirSync(path.join(skillDir, 'SKILL.md'));

            expect(verifySkillFiles(skillDir)).toBe(false);
        });
    });

    describe('non-existent paths', () => {
        it('should return false for a path that does not exist', () => {
            const nonExistentPath = path.join(tempDir, 'does-not-exist');

            expect(verifySkillFiles(nonExistentPath)).toBe(false);
        });
    });

    describe('error handling', () => {
        it('should return false and not throw for empty string path', () => {
            expect(() => verifySkillFiles('')).not.toThrow();
            expect(verifySkillFiles('')).toBe(false);
        });

        it('should return false for null-like paths', () => {
            expect(verifySkillFiles(null)).toBe(false);
            expect(verifySkillFiles(undefined)).toBe(false);
        });
    });
});

describe('verifyInstallation integration', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'verifier-integration-')
        );
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('copy method with real files', () => {
        it('should return verified=true for valid copied skill with SKILL.md', () => {
            const skillDir = path.join(tempDir, 'my-skill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');

            const result = {
                skillName: 'my-skill',
                agent: 'kiro',
                success: true,
                targetPath: skillDir,
            };

            const verification = verifyInstallation(result, 'copy');

            expect(verification.verified).toBe(true);
            expect(verification.skillName).toBe('my-skill');
            expect(verification.agent).toBe('kiro');
            expect(verification.error).toBeUndefined();
        });

        it('should return verified=false for copied skill without SKILL.md', () => {
            const skillDir = path.join(tempDir, 'incomplete-skill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'README.md'), '# Readme');

            const result = {
                skillName: 'incomplete-skill',
                agent: 'claude',
                success: true,
                targetPath: skillDir,
            };

            const verification = verifyInstallation(result, 'copy');

            expect(verification.verified).toBe(false);
            expect(verification.error).toContain(
                'Skill files verification failed'
            );
        });
    });

    describe('symlink method with real files', () => {
        it('should return verified=true for directory with symlinked SKILL.md', () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            const targetDir = path.join(tempDir, 'linked-skill');

            fs.mkdirSync(sourceDir);
            fs.writeFileSync(
                path.join(sourceDir, 'SKILL.md'),
                '# Source Skill'
            );

            fs.mkdirSync(targetDir);
            fs.symlinkSync(
                path.join(sourceDir, 'SKILL.md'),
                path.join(targetDir, 'SKILL.md')
            );

            const result = {
                skillName: 'linked-skill',
                agent: 'kiro',
                success: true,
                targetPath: targetDir,
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification.verified).toBe(true);
            expect(verification.skillName).toBe('linked-skill');
            expect(verification.agent).toBe('kiro');
            expect(verification.error).toBeUndefined();
        });

        it('should return verified=false for directory with broken SKILL.md symlink', () => {
            const targetDir = path.join(tempDir, 'broken-skill');
            fs.mkdirSync(targetDir);
            fs.symlinkSync(
                path.join(tempDir, 'non-existent', 'SKILL.md'),
                path.join(targetDir, 'SKILL.md')
            );

            const result = {
                skillName: 'broken-skill',
                agent: 'claude',
                success: true,
                targetPath: targetDir,
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification.verified).toBe(false);
            expect(verification.error).toContain('Symlink verification failed');
        });

        it('should return verified=false for directory without SKILL.md', () => {
            const targetDir = path.join(tempDir, 'no-skill-md');
            fs.mkdirSync(targetDir);

            const result = {
                skillName: 'no-skill-md',
                agent: 'kiro',
                success: true,
                targetPath: targetDir,
            };

            const verification = verifyInstallation(result, 'symlink');

            expect(verification.verified).toBe(false);
            expect(verification.error).toContain('Symlink verification failed');
        });
    });
});
