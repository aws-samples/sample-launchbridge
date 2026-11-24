// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for Installer Module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    ensureTargetDirectory,
    createSymlink,
    skillLayout,
} from '../../lib/installer.js';

const isRoot = process.getuid?.() === 0;

describe('ensureTargetDirectory', () => {
    let tempDir;

    beforeEach(async () => {
        // Create a temporary directory for each test
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
    });

    afterEach(async () => {
        // Clean up temporary directory after each test
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe('directory creation', () => {
        it('should create a single directory that does not exist', async () => {
            const targetPath = path.join(tempDir, 'new-dir');

            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should create nested directories recursively', async () => {
            const targetPath = path.join(tempDir, 'level1', 'level2', 'level3');

            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should create deeply nested directory structure', async () => {
            const targetPath = path.join(tempDir, 'a', 'b', 'c', 'd', 'e', 'f');

            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });
    });

    describe('idempotency', () => {
        it('should not throw when directory already exists', async () => {
            const targetPath = path.join(tempDir, 'existing-dir');

            // Create directory first
            await fs.mkdir(targetPath);

            // Should not throw when called again
            await expect(
                ensureTargetDirectory(targetPath)
            ).resolves.not.toThrow();
        });

        it('should be safe to call multiple times', async () => {
            const targetPath = path.join(tempDir, 'multi-call-dir');

            // Call multiple times
            await ensureTargetDirectory(targetPath);
            await ensureTargetDirectory(targetPath);
            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should preserve existing directory contents', async () => {
            const targetPath = path.join(tempDir, 'dir-with-contents');
            await fs.mkdir(targetPath);

            // Create a file inside the directory
            const testFile = path.join(targetPath, 'test.txt');
            await fs.writeFile(testFile, 'test content');

            // Call ensureTargetDirectory
            await ensureTargetDirectory(targetPath);

            // File should still exist
            const content = await fs.readFile(testFile, 'utf-8');
            expect(content).toBe('test content');
        });
    });

    describe('error handling', () => {
        it('should throw descriptive error for permission denied', async () => {
            // Skip on Windows (different permission model) and root (bypasses permissions)
            if (process.platform === 'win32' || isRoot) {
                return;
            }

            // Create a directory with no write permissions
            const restrictedDir = path.join(tempDir, 'restricted');
            await fs.mkdir(restrictedDir, { mode: 0o444 });

            const targetPath = path.join(restrictedDir, 'cannot-create');

            await expect(ensureTargetDirectory(targetPath)).rejects.toThrow(
                /Permission denied/
            );

            // Restore permissions for cleanup
            await fs.chmod(restrictedDir, 0o755);
        });

        it('should include path in error message', async () => {
            // Skip on Windows (different permission model) and root (bypasses permissions)
            if (process.platform === 'win32' || isRoot) {
                return;
            }

            const restrictedDir = path.join(tempDir, 'restricted2');
            await fs.mkdir(restrictedDir, { mode: 0o444 });

            const targetPath = path.join(restrictedDir, 'cannot-create');

            try {
                await ensureTargetDirectory(targetPath);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).toContain(targetPath);
            }

            // Restore permissions for cleanup
            await fs.chmod(restrictedDir, 0o755);
        });
    });

    describe('path handling', () => {
        it('should handle paths with spaces', async () => {
            const targetPath = path.join(
                tempDir,
                'path with spaces',
                'nested dir'
            );

            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should handle paths with special characters', async () => {
            const targetPath = path.join(
                tempDir,
                'path-with-dashes',
                'path_with_underscores'
            );

            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should handle .kiro style hidden directories', async () => {
            const targetPath = path.join(
                tempDir,
                '.kiro',
                'skills',
                'my-skill'
            );

            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should handle .claude style hidden directories', async () => {
            const targetPath = path.join(
                tempDir,
                '.claude',
                'skills',
                'my-skill'
            );

            await ensureTargetDirectory(targetPath);

            const stats = await fs.stat(targetPath);
            expect(stats.isDirectory()).toBe(true);
        });
    });
});

describe('createSymlink', () => {
    let tempDir;

    beforeEach(async () => {
        // Create a temporary directory for each test
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'symlink-test-'));
    });

    afterEach(async () => {
        // Clean up temporary directory after each test
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    /** The skill folder is one link to the source folder, read through. */
    async function expectFolderLink(targetLink, sourceDir) {
        const stats = await fs.lstat(targetLink);
        expect(stats.isSymbolicLink()).toBe(true);
        expect(await fs.readlink(targetLink)).toBe(path.resolve(sourceDir));
        expect(await fs.realpath(targetLink)).toBe(
            await fs.realpath(sourceDir)
        );
        // SKILL.md is the source's regular file, not a link of its own
        const skillMd = await fs.lstat(path.join(targetLink, 'SKILL.md'));
        expect(skillMd.isFile()).toBe(true);
    }

    describe('symlink creation', () => {
        it('links the whole skill folder to the source folder', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(
                path.join(sourceDir, 'SKILL.md'),
                '# Test Skill'
            );

            const targetLink = path.join(tempDir, 'target-skill');

            await createSymlink(sourceDir, targetLink);

            await expectFolderLink(targetLink, sourceDir);
        });

        it('should allow reading files through the symlink', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            const skillContent = '# My Skill\n\nThis is a test skill.';
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), skillContent);

            const targetLink = path.join(tempDir, 'target-skill');

            await createSymlink(sourceDir, targetLink);

            // Read file through symlink
            const content = await fs.readFile(
                path.join(targetLink, 'SKILL.md'),
                'utf-8'
            );
            expect(content).toBe(skillContent);
        });

        it('should create symlink in nested directory structure', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Test');

            // Create nested target directory
            const nestedDir = path.join(tempDir, '.kiro', 'skills');
            await fs.mkdir(nestedDir, { recursive: true });
            const targetLink = path.join(nestedDir, 'my-skill');

            await createSymlink(sourceDir, targetLink);

            await expectFolderLink(targetLink, sourceDir);
        });

        it('shows subfolders, and files the source gains later, through the link', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Test');
            const refsDir = path.join(sourceDir, 'references');
            await fs.mkdir(refsDir);
            await fs.writeFile(path.join(refsDir, 'api.md'), '# API');

            const targetLink = path.join(tempDir, 'target-skill');

            await createSymlink(sourceDir, targetLink);
            await fs.writeFile(path.join(refsDir, 'added.md'), '# Added');

            expect(
                (await fs.readdir(path.join(targetLink, 'references'))).sort()
            ).toEqual(['added.md', 'api.md']);
        });

        it('makes an absolute link from a relative source path', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Test');
            const targetLink = path.join(tempDir, 'target-skill');

            await createSymlink(
                path.relative(process.cwd(), sourceDir),
                targetLink
            );

            await expectFolderLink(targetLink, sourceDir);
        });

        it('makes a junction on Windows, which needs no Developer Mode', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            const targetLink = path.join(tempDir, 'target-skill');
            const symlink = vi.spyOn(fs, 'symlink').mockResolvedValue();
            try {
                await createSymlink(sourceDir, targetLink, {
                    platform: 'win32',
                });
                expect(symlink).toHaveBeenCalledWith(
                    path.resolve(sourceDir),
                    targetLink,
                    'junction'
                );
            } finally {
                symlink.mockRestore();
            }
        });

        it('refuses a source that is missing or not a folder', async () => {
            const missing = path.join(tempDir, 'missing');
            await expect(
                createSymlink(missing, path.join(tempDir, 'a'))
            ).rejects.toThrow(/Source path does not exist/);

            const file = path.join(tempDir, 'file.md');
            await fs.writeFile(file, '# not a folder');
            await expect(
                createSymlink(file, path.join(tempDir, 'b'))
            ).rejects.toThrow(/Source path is not a directory/);
            await expect(fs.lstat(path.join(tempDir, 'b'))).rejects.toThrow();
        });
    });

    describe('existing target handling', () => {
        it('should throw error when target already exists as a file', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            const targetPath = path.join(tempDir, 'existing-file');
            await fs.writeFile(targetPath, 'existing content');

            await expect(createSymlink(sourceDir, targetPath)).rejects.toThrow(
                /Target path already exists/
            );
        });

        it('should throw error when target already exists as a directory', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            const targetPath = path.join(tempDir, 'existing-dir');
            await fs.mkdir(targetPath);

            await expect(createSymlink(sourceDir, targetPath)).rejects.toThrow(
                /Target path already exists/
            );
        });

        it('should throw error when target already exists as a symlink', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            const otherSource = path.join(tempDir, 'other-source');
            await fs.mkdir(otherSource);

            const targetPath = path.join(tempDir, 'existing-symlink');
            await fs.symlink(otherSource, targetPath, 'dir');

            await expect(createSymlink(sourceDir, targetPath)).rejects.toThrow(
                /Target path already exists/
            );
        });

        it('should include target path in error message', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            const targetPath = path.join(tempDir, 'existing-file');
            await fs.writeFile(targetPath, 'existing content');

            try {
                await createSymlink(sourceDir, targetPath);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).toContain(targetPath);
            }
        });
    });

    describe('error handling', () => {
        it('should throw descriptive error for permission denied', async () => {
            // Skip on Windows (different permission model) and root (bypasses permissions)
            if (process.platform === 'win32' || isRoot) {
                return;
            }

            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            // Create a directory with no write permissions
            const restrictedDir = path.join(tempDir, 'restricted');
            await fs.mkdir(restrictedDir, { mode: 0o444 });

            const targetPath = path.join(restrictedDir, 'cannot-create');

            await expect(createSymlink(sourceDir, targetPath)).rejects.toThrow(
                /Permission denied|Failed to create symlink/
            );

            // Restore permissions for cleanup
            await fs.chmod(restrictedDir, 0o755);
        });

        it('should include both source and target paths in generic error message', async () => {
            // Skip on Windows (different permission model) and root (bypasses permissions)
            if (process.platform === 'win32' || isRoot) {
                return;
            }

            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            // Create a directory with no write permissions
            const restrictedDir = path.join(tempDir, 'restricted');
            await fs.mkdir(restrictedDir, { mode: 0o444 });

            const targetPath = path.join(restrictedDir, 'cannot-create');

            try {
                await createSymlink(sourceDir, targetPath);
                expect.fail('Should have thrown an error');
            } catch (error) {
                // Error should contain useful context
                expect(error.message).toMatch(
                    /Permission denied|Failed to create symlink/
                );
            }

            // Restore permissions for cleanup
            await fs.chmod(restrictedDir, 0o755);
        });
    });

    describe('path handling', () => {
        it.each([
            ['paths with spaces', 'source skill', 'target skill'],
            [
                'paths with special characters',
                'source-skill_v1',
                'target-skill_v1',
            ],
            [
                '.kiro style hidden directories',
                'source-skill',
                '.kiro/skills/my-skill',
            ],
            [
                '.claude style hidden directories',
                'source-skill',
                '.claude/skills/my-skill',
            ],
        ])('should handle %s', async (_label, source, target) => {
            const sourceDir = path.join(tempDir, source);
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Test');

            const targetLink = path.join(tempDir, ...target.split('/'));
            await fs.mkdir(path.dirname(targetLink), { recursive: true });

            await createSymlink(sourceDir, targetLink);

            await expectFolderLink(targetLink, sourceDir);
        });
    });
});

describe('skillLayout', () => {
    it('links a symlink install and copies a copy install', () => {
        expect(skillLayout('symlink')).toBe('link');
        expect(skillLayout('copy')).toBe('copy');
    });

    it('copies a folder the installer writes files of its own into, in a symlink install too', () => {
        const own = new Map([['SKILL.md', Buffer.from('# adapted')]]);
        expect(skillLayout('symlink', own)).toBe('copy');
        expect(skillLayout('symlink', new Map())).toBe('link');
    });
});

import { copySkill } from '../../lib/installer.js';

describe('copySkill', () => {
    let tempDir;

    beforeEach(async () => {
        // Create a temporary directory for each test
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copyskill-test-'));
    });

    afterEach(async () => {
        // Clean up temporary directory after each test
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe('basic copy operations', () => {
        it('should copy a skill directory with SKILL.md file', async () => {
            // Create source skill directory
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(
                path.join(sourceDir, 'SKILL.md'),
                '# Test Skill\n\nThis is a test.'
            );

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            // Verify target directory exists
            const stats = await fs.stat(targetDir);
            expect(stats.isDirectory()).toBe(true);

            // Verify SKILL.md was copied
            const content = await fs.readFile(
                path.join(targetDir, 'SKILL.md'),
                'utf-8'
            );
            expect(content).toBe('# Test Skill\n\nThis is a test.');
        });

        it('should copy all files in the skill directory', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');
            await fs.writeFile(path.join(sourceDir, 'README.md'), '# README');
            await fs.writeFile(
                path.join(sourceDir, 'LICENSE.txt'),
                'MIT License'
            );

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            // Verify all files were copied
            const files = await fs.readdir(targetDir);
            expect(files).toContain('SKILL.md');
            expect(files).toContain('README.md');
            expect(files).toContain('LICENSE.txt');
        });

        it('should copy subdirectories recursively', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            // Create references subdirectory
            const refsDir = path.join(sourceDir, 'references');
            await fs.mkdir(refsDir);
            await fs.writeFile(path.join(refsDir, 'api.md'), '# API Reference');
            await fs.writeFile(path.join(refsDir, 'guide.md'), '# User Guide');

            // Create scripts subdirectory
            const scriptsDir = path.join(sourceDir, 'scripts');
            await fs.mkdir(scriptsDir);
            await fs.writeFile(
                path.join(scriptsDir, 'setup.sh'),
                '#!/bin/bash\necho "setup"'
            );

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            // Verify subdirectories were copied
            const targetRefs = path.join(targetDir, 'references');
            const targetScripts = path.join(targetDir, 'scripts');

            expect((await fs.stat(targetRefs)).isDirectory()).toBe(true);
            expect((await fs.stat(targetScripts)).isDirectory()).toBe(true);

            // Verify files in subdirectories
            const apiContent = await fs.readFile(
                path.join(targetRefs, 'api.md'),
                'utf-8'
            );
            expect(apiContent).toBe('# API Reference');

            const setupContent = await fs.readFile(
                path.join(targetScripts, 'setup.sh'),
                'utf-8'
            );
            expect(setupContent).toBe('#!/bin/bash\necho "setup"');
        });

        it('should copy deeply nested directory structures', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            // Create deeply nested structure
            const deepDir = path.join(sourceDir, 'level1', 'level2', 'level3');
            await fs.mkdir(deepDir, { recursive: true });
            await fs.writeFile(
                path.join(deepDir, 'deep-file.txt'),
                'deep content'
            );

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            // Verify deep file was copied
            const deepContent = await fs.readFile(
                path.join(
                    targetDir,
                    'level1',
                    'level2',
                    'level3',
                    'deep-file.txt'
                ),
                'utf-8'
            );
            expect(deepContent).toBe('deep content');
        });
    });

    describe('file permissions preservation', () => {
        it('should preserve file permissions', async () => {
            // Skip on Windows as permission handling is different
            if (process.platform === 'win32') {
                return;
            }

            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            // Create a file with specific permissions (executable)
            const scriptPath = path.join(sourceDir, 'script.sh');
            await fs.writeFile(scriptPath, '#!/bin/bash\necho "hello"');
            await fs.chmod(scriptPath, 0o755);

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            // Verify permissions were preserved
            const targetScript = path.join(targetDir, 'script.sh');
            const stats = await fs.stat(targetScript);
            // Check executable bit is set (mode & 0o111 should be non-zero)
            expect(stats.mode & 0o111).not.toBe(0);
        });

        it('should preserve directory permissions', async () => {
            // Skip on Windows as permission handling is different
            if (process.platform === 'win32') {
                return;
            }

            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir, { mode: 0o755 });
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            const stats = await fs.stat(targetDir);
            // Directory should have similar permissions
            expect(stats.isDirectory()).toBe(true);
        });
    });

    describe('existing target handling', () => {
        it('should throw error when target already exists as a file', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const targetPath = path.join(tempDir, 'existing-file');
            await fs.writeFile(targetPath, 'existing content');

            await expect(copySkill(sourceDir, targetPath)).rejects.toThrow(
                /Target path already exists/
            );
        });

        it('should throw error when target already exists as a directory', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const targetPath = path.join(tempDir, 'existing-dir');
            await fs.mkdir(targetPath);

            await expect(copySkill(sourceDir, targetPath)).rejects.toThrow(
                /Target path already exists/
            );
        });

        it('should throw error when target already exists as a symlink', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const otherDir = path.join(tempDir, 'other-dir');
            await fs.mkdir(otherDir);

            const targetPath = path.join(tempDir, 'existing-symlink');
            await fs.symlink(otherDir, targetPath, 'dir');

            await expect(copySkill(sourceDir, targetPath)).rejects.toThrow(
                /Target path already exists/
            );
        });

        it('should include target path in error message', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const targetPath = path.join(tempDir, 'existing-file');
            await fs.writeFile(targetPath, 'existing content');

            try {
                await copySkill(sourceDir, targetPath);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).toContain(targetPath);
            }
        });
    });

    describe('source validation', () => {
        it('should throw error when source does not exist', async () => {
            const sourceDir = path.join(tempDir, 'non-existent');
            const targetDir = path.join(tempDir, 'target-skill');

            await expect(copySkill(sourceDir, targetDir)).rejects.toThrow(
                /Source path does not exist/
            );
        });

        it('should throw error when source is a file, not a directory', async () => {
            const sourceFile = path.join(tempDir, 'source-file.txt');
            await fs.writeFile(sourceFile, 'not a directory');

            const targetDir = path.join(tempDir, 'target-skill');

            await expect(copySkill(sourceFile, targetDir)).rejects.toThrow(
                /Source path is not a directory/
            );
        });
    });

    describe('path handling', () => {
        it('should handle paths with spaces', async () => {
            const sourceDir = path.join(tempDir, 'source skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const targetDir = path.join(tempDir, 'target skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            const stats = await fs.stat(targetDir);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should handle paths with special characters', async () => {
            const sourceDir = path.join(tempDir, 'source-skill_v1');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const targetDir = path.join(tempDir, 'target-skill_v1');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            const stats = await fs.stat(targetDir);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should handle .kiro style hidden directories', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const kiroDir = path.join(tempDir, '.kiro', 'skills');
            await fs.mkdir(kiroDir, { recursive: true });
            const targetDir = path.join(kiroDir, 'my-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            const stats = await fs.stat(targetDir);
            expect(stats.isDirectory()).toBe(true);
        });

        it('should handle .claude style hidden directories', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            const claudeDir = path.join(tempDir, '.claude', 'skills');
            await fs.mkdir(claudeDir, { recursive: true });
            const targetDir = path.join(claudeDir, 'my-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            const stats = await fs.stat(targetDir);
            expect(stats.isDirectory()).toBe(true);
        });
    });

    describe('content integrity', () => {
        it('should preserve exact file content', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);

            const originalContent =
                '# Test Skill\n\n## Features\n- Feature 1\n- Feature 2\n\n```javascript\nconst x = 1;\n```';
            await fs.writeFile(
                path.join(sourceDir, 'SKILL.md'),
                originalContent
            );

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            const copiedContent = await fs.readFile(
                path.join(targetDir, 'SKILL.md'),
                'utf-8'
            );
            expect(copiedContent).toBe(originalContent);
        });

        it('should preserve binary file content', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            // Create a binary file (simple PNG header simulation)
            const binaryData = Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]);
            await fs.writeFile(path.join(sourceDir, 'icon.png'), binaryData);

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            const copiedBinary = await fs.readFile(
                path.join(targetDir, 'icon.png')
            );
            expect(copiedBinary.equals(binaryData)).toBe(true);
        });

        it('should copy empty directories', async () => {
            const sourceDir = path.join(tempDir, 'source-skill');
            await fs.mkdir(sourceDir);
            await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');

            // Create an empty subdirectory
            await fs.mkdir(path.join(sourceDir, 'empty-dir'));

            const targetDir = path.join(tempDir, 'target-skill');

            await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

            // Verify empty directory was copied
            const emptyDirStats = await fs.stat(
                path.join(targetDir, 'empty-dir')
            );
            expect(emptyDirStats.isDirectory()).toBe(true);

            const contents = await fs.readdir(
                path.join(targetDir, 'empty-dir')
            );
            expect(contents).toHaveLength(0);
        });
    });
});

describe('copySkill - symlink resolution', () => {
    let tempDir;

    beforeEach(async () => {
        tempDir = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'copy-symlink-test-'))
        );
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should resolve file symlinks and copy the real file content', async () => {
        // Create a real file somewhere
        const realFile = path.join(tempDir, 'real-file.txt');
        await fs.writeFile(realFile, 'real content');

        // Create source skill with a symlink to that file
        const sourceDir = path.join(tempDir, 'source-skill');
        await fs.mkdir(sourceDir);
        await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');
        await fs.symlink(realFile, path.join(sourceDir, 'linked-file.txt'));

        const targetDir = path.join(tempDir, 'target-skill');
        await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

        // Target should have a real file, not a symlink
        const stats = await fs.lstat(path.join(targetDir, 'linked-file.txt'));
        expect(stats.isSymbolicLink()).toBe(false);
        expect(stats.isFile()).toBe(true);

        // Content should match the original
        const content = await fs.readFile(
            path.join(targetDir, 'linked-file.txt'),
            'utf-8'
        );
        expect(content).toBe('real content');
    });

    it('should resolve directory symlinks and copy the real directory contents', async () => {
        // Create a real directory somewhere (simulates metric-library submodule)
        const realDir = path.join(tempDir, 'real-library');
        await fs.mkdir(realDir);
        await fs.writeFile(path.join(realDir, 'README.md'), '# Library');
        const subDir = path.join(realDir, 'src');
        await fs.mkdir(subDir);
        await fs.writeFile(path.join(subDir, 'index.py'), 'print("hello")');

        // Create source skill with a symlink to that directory
        const sourceDir = path.join(tempDir, 'source-skill');
        await fs.mkdir(sourceDir);
        await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');
        const libDir = path.join(sourceDir, 'lib');
        await fs.mkdir(libDir);
        await fs.symlink(realDir, path.join(libDir, 'metric-library'));

        const targetDir = path.join(tempDir, 'target-skill');
        await copySkill(sourceDir, targetDir, { allowedRoot: tempDir });

        // Target should have a real directory, not a symlink
        const stats = await fs.lstat(
            path.join(targetDir, 'lib', 'metric-library')
        );
        expect(stats.isSymbolicLink()).toBe(false);
        expect(stats.isDirectory()).toBe(true);

        // Contents should be copied
        const readme = await fs.readFile(
            path.join(targetDir, 'lib', 'metric-library', 'README.md'),
            'utf-8'
        );
        expect(readme).toBe('# Library');

        const index = await fs.readFile(
            path.join(targetDir, 'lib', 'metric-library', 'src', 'index.py'),
            'utf-8'
        );
        expect(index).toBe('print("hello")');
    });

    it('should resolve relative symlinks that would break at the target', async () => {
        // Create structure that mirrors the real scenario:
        // project/
        //   project_dependencies/metric-library/  (the real content)
        //   skills/evaluate-predictions/lib/metric-library -> ../../../project_dependencies/metric-library
        const projectDir = path.join(tempDir, 'project');
        await fs.mkdir(projectDir);

        const depDir = path.join(
            projectDir,
            'project_dependencies',
            'metric-library'
        );
        await fs.mkdir(depDir, { recursive: true });
        await fs.writeFile(path.join(depDir, 'README.md'), '# Metric Library');

        const skillDir = path.join(
            projectDir,
            'skills',
            'evaluate-predictions'
        );
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');
        const libDir = path.join(skillDir, 'lib');
        await fs.mkdir(libDir);
        // Relative symlink — same pattern as the real codebase
        await fs.symlink(
            '../../../project_dependencies/metric-library',
            path.join(libDir, 'metric-library')
        );

        // Copy to a completely different location
        const targetDir = path.join(tempDir, 'installed-skill');
        await copySkill(skillDir, targetDir, { allowedRoot: tempDir });

        // The copied version should work — real directory, not a broken symlink
        const stats = await fs.lstat(
            path.join(targetDir, 'lib', 'metric-library')
        );
        expect(stats.isSymbolicLink()).toBe(false);
        expect(stats.isDirectory()).toBe(true);

        const content = await fs.readFile(
            path.join(targetDir, 'lib', 'metric-library', 'README.md'),
            'utf-8'
        );
        expect(content).toBe('# Metric Library');
    });

    it('skips links that resolve outside allowedRoot', async () => {
        const root = path.join(tempDir, 'launchbridge');
        const outside = path.join(tempDir, 'home-secrets');
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(path.join(outside, 'id_rsa'), 'private');
        const skillDir = path.join(root, 'skills', 'demo');
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');
        await fs.symlink(outside, path.join(skillDir, 'data'));
        const skipped = [];

        const targetDir = path.join(tempDir, 'installed');
        await copySkill(skillDir, targetDir, {
            allowedRoot: root,
            onSkip: (src) => skipped.push(src),
        });

        await expect(
            fs.lstat(path.join(targetDir, 'data'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(skipped).toEqual([path.join(skillDir, 'data')]);
    });

    it('follows no links when allowedRoot is not given', async () => {
        const realFile = path.join(tempDir, 'real-file.txt');
        await fs.writeFile(realFile, 'real content');
        const sourceDir = path.join(tempDir, 'source-skill');
        await fs.mkdir(sourceDir);
        await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Skill');
        await fs.symlink(realFile, path.join(sourceDir, 'linked-file.txt'));

        const targetDir = path.join(tempDir, 'target-skill');
        await copySkill(sourceDir, targetDir);

        await expect(
            fs.lstat(path.join(targetDir, 'linked-file.txt'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not loop on a link back to an ancestor directory', async () => {
        const skillDir = path.join(tempDir, 'skill');
        await fs.mkdir(path.join(skillDir, 'sub'), { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');
        await fs.symlink(skillDir, path.join(skillDir, 'sub', 'loop'));

        const targetDir = path.join(tempDir, 'installed');
        await copySkill(skillDir, targetDir, { allowedRoot: tempDir });

        expect(
            await fs.readFile(path.join(targetDir, 'SKILL.md'), 'utf-8')
        ).toBe('# Skill');
    });
});

describe.skipIf(process.platform === 'win32')('copySkill - file modes', () => {
    let base;
    beforeEach(async () => {
        base = await fs.mkdtemp(path.join(os.tmpdir(), 'lb-mode-'));
    });
    afterEach(async () => {
        await fs.rm(base, { recursive: true, force: true });
    });

    it('keeps permission bits but drops setuid, setgid and sticky', async () => {
        const src = path.join(base, 'src');
        await fs.mkdir(src);
        await fs.writeFile(path.join(src, 'SKILL.md'), '# s\n');
        await fs.writeFile(path.join(src, 'run.sh'), '#!/bin/sh\n');
        await fs.chmod(path.join(src, 'run.sh'), 0o6755);

        await copySkill(src, path.join(base, 'dst'));

        const { mode } = await fs.stat(path.join(base, 'dst', 'run.sh'));
        expect(mode & 0o7777).toBe(0o755);
    });
});
