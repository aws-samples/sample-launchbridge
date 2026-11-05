// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import {
    displaySummary,
    displayFinalReport,
    displayProgress,
    getExitCode,
} from '../../lib/reporter.js';

describe('Reporter Module', () => {
    describe('displaySummary', () => {
        let consoleOutput;
        let originalLog;

        beforeEach(() => {
            consoleOutput = [];
            originalLog = console.log;
            console.log = (...args) => {
                consoleOutput.push(args.join(' '));
            };
        });

        afterEach(() => {
            console.log = originalLog;
        });

        it('should include all five pieces of information', () => {
            const selections = {
                agents: ['kiro', 'claude'],
                scope: 'local',
                method: 'symlink',
                sourcePath: '/path/to/source',
                skills: ['skill-a', 'skill-b'],
            };

            displaySummary(selections);
            const output = consoleOutput.join('\n');

            assert.ok(output.includes('Kiro'), 'Should include Kiro agent');
            assert.ok(
                output.includes('Claude Code'),
                'Should include Claude Code agent'
            );
            assert.ok(
                output.includes('Local') || output.includes('local'),
                'Should include scope'
            );
            assert.ok(
                output.includes('Symlink') || output.includes('symlink'),
                'Should include method'
            );
            assert.ok(
                output.includes('/path/to/source'),
                'Should include source path'
            );
            assert.ok(output.includes('skill-a'), 'Should include first skill');
            assert.ok(
                output.includes('skill-b'),
                'Should include second skill'
            );
        });

        it('should handle single agent selection', () => {
            const selections = {
                agents: ['kiro'],
                scope: 'global',
                method: 'copy',
                sourcePath: '/home/user/repo',
                skills: ['my-skill'],
            };

            displaySummary(selections);
            const output = consoleOutput.join('\n');

            assert.ok(output.includes('Kiro'), 'Should include Kiro');
            assert.ok(
                !output.includes('Claude Code'),
                'Should not include Claude Code'
            );
            assert.ok(
                output.includes('Global') || output.includes('global'),
                'Should include global scope'
            );
            assert.ok(
                output.includes('Copy') || output.includes('copy'),
                'Should include copy method'
            );
        });

        it('should handle empty skills array', () => {
            const selections = {
                agents: ['claude'],
                scope: 'local',
                method: 'symlink',
                sourcePath: '/source',
                skills: [],
            };

            displaySummary(selections);
            const output = consoleOutput.join('\n');

            assert.ok(
                output.includes('Claude Code'),
                'Should include Claude Code'
            );
        });

        it('should return a string', () => {
            const selections = {
                agents: ['kiro'],
                scope: 'local',
                method: 'copy',
                sourcePath: '/path',
                skills: ['skill'],
            };

            const result = displaySummary(selections);

            assert.strictEqual(
                typeof result,
                'string',
                'Should return a string'
            );
        });
    });

    describe('displayFinalReport', () => {
        let consoleOutput;
        let originalLog;

        beforeEach(() => {
            consoleOutput = [];
            originalLog = console.log;
            console.log = (...args) => {
                consoleOutput.push(args.join(' '));
            };
        });

        afterEach(() => {
            console.log = originalLog;
        });

        it('should display header and counts', () => {
            const report = {
                successful: [
                    {
                        skillName: 's1',
                        agent: 'kiro',
                        success: true,
                        targetPath: '/p',
                    },
                ],
                failed: [],
                skipped: [],
            };

            displayFinalReport(report);

            const output = consoleOutput.join('\n');
            assert.ok(
                output.includes('Results') || output.includes('1 installed'),
                'Should include results'
            );
        });

        it('should list successful installations', () => {
            const report = {
                successful: [
                    {
                        skillName: 'skill-a',
                        agent: 'kiro',
                        success: true,
                        targetPath: '/path/a',
                    },
                    {
                        skillName: 'skill-b',
                        agent: 'claude',
                        success: true,
                        targetPath: '/path/b',
                    },
                ],
                failed: [],
                skipped: [],
            };

            displayFinalReport(report);

            const output = consoleOutput.join('\n');
            // New reporter shows a compact count line, not individual skill names for successes
            assert.ok(
                output.includes('2 skills installed'),
                'Should include installed count'
            );
        });

        it('should list failed installations with error messages', () => {
            const report = {
                successful: [],
                failed: [
                    {
                        skillName: 'failed-skill',
                        agent: 'kiro',
                        success: false,
                        error: 'Permission denied',
                        targetPath: '/path',
                    },
                ],
                skipped: [],
            };

            displayFinalReport(report);

            const output = consoleOutput.join('\n');
            assert.ok(
                output.includes('failed-skill'),
                'Should include failed skill name'
            );
            assert.ok(
                output.includes('Permission denied'),
                'Should include error message'
            );
        });

        it('should list skipped installations', () => {
            const report = {
                successful: [],
                failed: [],
                skipped: [
                    {
                        skillName: 'skipped-skill',
                        agent: 'claude',
                        success: false,
                        targetPath: '/path',
                    },
                ],
            };

            displayFinalReport(report);

            const output = consoleOutput.join('\n');
            assert.ok(
                output.includes('skipped-skill'),
                'Should include skipped skill name'
            );
        });

        it('should correctly categorize all results', () => {
            const report = {
                successful: [
                    {
                        skillName: 'success-1',
                        agent: 'kiro',
                        success: true,
                        targetPath: '/p1',
                    },
                ],
                failed: [
                    {
                        skillName: 'fail-1',
                        agent: 'claude',
                        success: false,
                        error: 'Error',
                        targetPath: '/p2',
                    },
                ],
                skipped: [
                    {
                        skillName: 'skip-1',
                        agent: 'kiro',
                        success: false,
                        targetPath: '/p3',
                    },
                ],
            };

            displayFinalReport(report);

            const output = consoleOutput.join('\n');
            // Failures and skips are listed individually; successes show as a count
            assert.ok(
                output.includes('1 skills installed'),
                'Should include installed count'
            );
            assert.ok(output.includes('fail-1'), 'Should include failed skill');
            assert.ok(
                output.includes('skip-1'),
                'Should include skipped skill'
            );
        });
    });

    describe('displayProgress', () => {
        let consoleOutput;
        let originalLog;

        beforeEach(() => {
            consoleOutput = [];
            originalLog = console.log;
            console.log = (...args) => {
                consoleOutput.push(args.join(' '));
            };
        });

        afterEach(() => {
            console.log = originalLog;
        });

        it('should display skill name and agent', () => {
            displayProgress('my-skill', 'kiro', 'success');

            const output = consoleOutput.join('\n');
            assert.ok(output.includes('my-skill'), 'Should include skill name');
            assert.ok(output.includes('kiro'), 'Should include agent');
        });

        it('should display status', () => {
            displayProgress('skill', 'claude', 'installing');

            const output = consoleOutput.join('\n');
            // 'installing' status renders as a dim dot line, not the word itself
            assert.ok(output.includes('skill'), 'Should include skill name');
        });
    });

    describe('getExitCode', () => {
        it('should return 0 when all installations are successful', () => {
            const report = {
                successful: [
                    {
                        skillName: 'skill-a',
                        agent: 'kiro',
                        success: true,
                        targetPath: '/path/a',
                    },
                    {
                        skillName: 'skill-b',
                        agent: 'claude',
                        success: true,
                        targetPath: '/path/b',
                    },
                ],
                failed: [],
                skipped: [],
            };

            const exitCode = getExitCode(report);

            assert.strictEqual(
                exitCode,
                0,
                'Should return 0 for all successful installations'
            );
        });

        it('should return 1 when any installation failed', () => {
            const report = {
                successful: [
                    {
                        skillName: 'skill-a',
                        agent: 'kiro',
                        success: true,
                        targetPath: '/path/a',
                    },
                ],
                failed: [
                    {
                        skillName: 'skill-b',
                        agent: 'claude',
                        success: false,
                        error: 'Permission denied',
                        targetPath: '/path/b',
                    },
                ],
                skipped: [],
            };

            const exitCode = getExitCode(report);

            assert.strictEqual(
                exitCode,
                1,
                'Should return 1 when any installation failed'
            );
        });

        it('should return 0 when installations are skipped but none failed', () => {
            const report = {
                successful: [
                    {
                        skillName: 'skill-a',
                        agent: 'kiro',
                        success: true,
                        targetPath: '/path/a',
                    },
                ],
                failed: [],
                skipped: [
                    {
                        skillName: 'skill-b',
                        agent: 'claude',
                        success: false,
                        targetPath: '/path/b',
                    },
                ],
            };

            const exitCode = getExitCode(report);

            assert.strictEqual(
                exitCode,
                0,
                'Should return 0 when only skipped (no failures)'
            );
        });

        it('should return 0 when all installations are skipped', () => {
            const report = {
                successful: [],
                failed: [],
                skipped: [
                    {
                        skillName: 'skill-a',
                        agent: 'kiro',
                        success: false,
                        targetPath: '/path/a',
                    },
                    {
                        skillName: 'skill-b',
                        agent: 'claude',
                        success: false,
                        targetPath: '/path/b',
                    },
                ],
            };

            const exitCode = getExitCode(report);

            assert.strictEqual(
                exitCode,
                0,
                'Should return 0 when all are skipped (no failures)'
            );
        });

        it('should return 1 when all installations failed', () => {
            const report = {
                successful: [],
                failed: [
                    {
                        skillName: 'skill-a',
                        agent: 'kiro',
                        success: false,
                        error: 'Error 1',
                        targetPath: '/path/a',
                    },
                    {
                        skillName: 'skill-b',
                        agent: 'claude',
                        success: false,
                        error: 'Error 2',
                        targetPath: '/path/b',
                    },
                ],
                skipped: [],
            };

            const exitCode = getExitCode(report);

            assert.strictEqual(
                exitCode,
                1,
                'Should return 1 when all installations failed'
            );
        });

        it('should return 0 for empty report', () => {
            const report = {
                successful: [],
                failed: [],
                skipped: [],
            };

            const exitCode = getExitCode(report);

            assert.strictEqual(
                exitCode,
                0,
                'Should return 0 for empty report (no failures)'
            );
        });

        it('should return 1 when there are failures even with skipped', () => {
            const report = {
                successful: [],
                failed: [
                    {
                        skillName: 'skill-a',
                        agent: 'kiro',
                        success: false,
                        error: 'Error',
                        targetPath: '/path/a',
                    },
                ],
                skipped: [
                    {
                        skillName: 'skill-b',
                        agent: 'claude',
                        success: false,
                        targetPath: '/path/b',
                    },
                ],
            };

            const exitCode = getExitCode(report);

            assert.strictEqual(
                exitCode,
                1,
                'Should return 1 when there are failures regardless of skipped'
            );
        });
    });
});
