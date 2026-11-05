// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The repository's frozen constraints reach the target's python_deps/, where
 * lb-setup installs with them; a source checkout leaves none behind.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writePyprojectConfig } from '../../lib/venvSetup.js';

const PYPROJECT = `[project]
name = "launchbridge"
requires-python = ">=3.12"
dependencies = ["pydantic>=2.0.0"]

[project.optional-dependencies]
config_prompt_registry = [
    "PyYAML>=6.0",
]
`;

describe('writePyprojectConfig constraints', () => {
    let base;
    let source;
    let target;
    const depsDir = () =>
        path.join(target, '.lb_workspace', 'config', 'python_deps');

    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-constraints-'));
        source = path.join(base, 'launchbridge');
        target = path.join(base, 'target');
        fs.mkdirSync(path.join(source, 'project_dependencies'), {
            recursive: true,
        });
        fs.mkdirSync(target);
        fs.writeFileSync(
            path.join(source, 'project_dependencies', 'pyproject.toml'),
            PYPROJECT
        );
    });
    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('copies the frozen constraints.txt next to the generated pyproject', async () => {
        fs.writeFileSync(
            path.join(source, 'project_dependencies', 'constraints.txt'),
            'pyyaml==6.0.3\n'
        );
        const result = await writePyprojectConfig(
            target,
            ['config-prompt-registry'],
            source
        );
        expect(result.success).toBe(true);
        expect(
            fs.readFileSync(path.join(depsDir(), 'constraints.txt'), 'utf8')
        ).toBe('pyyaml==6.0.3\n');
    });

    it('fails, and leaves no stale constraints, when the source has none', async () => {
        fs.mkdirSync(depsDir(), { recursive: true });
        fs.writeFileSync(path.join(depsDir(), 'constraints.txt'), 'old\n');
        const result = await writePyprojectConfig(
            target,
            ['config-prompt-registry'],
            source
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('constraints.txt is missing');
        expect(fs.existsSync(path.join(depsDir(), 'constraints.txt'))).toBe(
            false
        );
    });

    it('fails without a source to read constraints from', async () => {
        const result = await writePyprojectConfig(target, [
            'config-prompt-registry',
        ]);
        expect(result.success).toBe(false);
    });
});
