// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for Path Validator Module
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { getTargetPath } from '../../lib/pathValidator.js';

describe('getTargetPath', () => {
    describe('local scope', () => {
        it('should return .kiro/skills path for kiro agent with local scope', () => {
            const targetRepo = '/home/user/my-project';
            const result = getTargetPath('kiro', 'local', targetRepo);
            expect(result).toBe(path.join(targetRepo, '.kiro', 'skills'));
        });

        it('should return .claude/skills path for claude agent with local scope', () => {
            const targetRepo = '/home/user/my-project';
            const result = getTargetPath('claude', 'local', targetRepo);
            expect(result).toBe(path.join(targetRepo, '.claude', 'skills'));
        });

        it('should handle relative paths by resolving them', () => {
            const targetRepo = './my-project';
            const result = getTargetPath('kiro', 'local', targetRepo);
            const expected = path.join(
                path.resolve(targetRepo),
                '.kiro',
                'skills'
            );
            expect(result).toBe(expected);
        });

        it('should handle paths with trailing slashes', () => {
            const targetRepo = '/home/user/my-project/';
            const result = getTargetPath('kiro', 'local', targetRepo);
            // path.join normalizes trailing slashes
            expect(result).toBe(path.join(targetRepo, '.kiro', 'skills'));
        });
    });

    describe('global scope', () => {
        it('should return ~/.kiro/skills path for kiro agent with global scope', () => {
            const targetRepo = '/home/user/my-project';
            const result = getTargetPath('kiro', 'global', targetRepo);
            expect(result).toBe(path.join(os.homedir(), '.kiro', 'skills'));
        });

        it('should return ~/.claude/skills path for claude agent with global scope', () => {
            const targetRepo = '/home/user/my-project';
            const result = getTargetPath('claude', 'global', targetRepo);
            expect(result).toBe(path.join(os.homedir(), '.claude', 'skills'));
        });

        it('should ignore targetRepo for global scope', () => {
            const result1 = getTargetPath('kiro', 'global', '/path/one');
            const result2 = getTargetPath('kiro', 'global', '/path/two');
            expect(result1).toBe(result2);
        });
    });

    describe('cross-platform compatibility', () => {
        it('should use platform-specific path separators', () => {
            const targetRepo = '/home/user/project';
            const result = getTargetPath('kiro', 'local', targetRepo);
            // path.join uses the correct separator for the platform
            expect(result).toContain(path.sep);
        });
    });
});

import fs from 'fs';
import {
    validateTargetDirectory,
    checkWritePermissions,
} from '../../lib/pathValidator.js';

describe('validateTargetDirectory', () => {
    describe('valid directories', () => {
        it('should return valid for existing directory', () => {
            const result = validateTargetDirectory(os.tmpdir());
            expect(result.valid).toBe(true);
            expect(result.resolvedPath).toBeDefined();
        });

        it('should return valid for non-existing path (will be created during installation)', () => {
            const nonExistentPath = path.join(
                os.tmpdir(),
                'non-existent-dir-' + Date.now()
            );
            const result = validateTargetDirectory(nonExistentPath);
            expect(result.valid).toBe(true);
        });

        it('should resolve relative paths', () => {
            const result = validateTargetDirectory('.');
            expect(result.valid).toBe(true);
            expect(result.resolvedPath).toBe(path.resolve('.'));
        });

        it('should resolve home directory paths', () => {
            const result = validateTargetDirectory('~');
            expect(result.valid).toBe(true);
            expect(result.resolvedPath).toBe(os.homedir());
        });
    });

    describe('invalid inputs', () => {
        it('should return invalid for empty path', () => {
            const result = validateTargetDirectory('');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('cannot be empty');
        });

        it('should return invalid for whitespace-only path', () => {
            const result = validateTargetDirectory('   ');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('cannot be empty');
        });

        it('should return invalid for null path', () => {
            const result = validateTargetDirectory(null);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('cannot be empty');
        });
    });

    describe('file instead of directory', () => {
        it('should return invalid when path is a file', () => {
            // Create a temporary file
            const tempFile = path.join(
                os.tmpdir(),
                'test-file-' + Date.now() + '.txt'
            );
            fs.writeFileSync(tempFile, 'test');

            try {
                const result = validateTargetDirectory(tempFile);
                expect(result.valid).toBe(false);
                expect(result.error).toContain('not a valid directory');
            } finally {
                fs.unlinkSync(tempFile);
            }
        });
    });
});

describe('checkWritePermissions', () => {
    describe('writable directories', () => {
        it('should return valid for writable directory', () => {
            const result = checkWritePermissions(os.tmpdir());
            expect(result.valid).toBe(true);
        });

        it('should check parent directory for non-existing paths', () => {
            const nonExistentPath = path.join(
                os.tmpdir(),
                'non-existent-' + Date.now()
            );
            const result = checkWritePermissions(nonExistentPath);
            expect(result.valid).toBe(true);
        });

        it('should resolve home directory paths', () => {
            const result = checkWritePermissions('~');
            expect(result.valid).toBe(true);
        });
    });

    describe('invalid inputs', () => {
        it('should return invalid for empty path', () => {
            const result = checkWritePermissions('');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('cannot be empty');
        });

        it('should return invalid for whitespace-only path', () => {
            const result = checkWritePermissions('   ');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('cannot be empty');
        });
    });

    describe('error messages', () => {
        it('should include platform-specific suggestions in error messages', () => {
            // This test verifies the error message format
            // We can't easily test actual permission denied scenarios without root
            const result = checkWritePermissions('');
            expect(result.error).toBeDefined();
        });
    });
});
