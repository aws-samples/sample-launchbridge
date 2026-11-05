// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Nothing can be installed into .venv_lb after lb-setup seals it, so each
 * skill's python_deps extras must cover everything it runs.
 */

import { describe, it, expect } from 'vitest';
import { buildPyprojectContent } from '../../lib/venvSetup.js';

const DEPS = {
    coreDeps: ['pydantic>=2.0.0'],
    optionalDeps: {
        eval_toolkit: ['numpy>=2.1,<3'],
        eval_toolkit_media: ['pillow>=10'],
        config_prompt_registry: ['PyYAML>=6.0'],
    },
};

describe('buildPyprojectContent extras', () => {
    it('gives evaluate-predictions the media extra its metrics need', () => {
        const content = buildPyprojectContent(
            ['evaluate-predictions'],
            '>=3.12',
            DEPS
        );
        expect(content).toContain('eval_toolkit = [');
        expect(content).toContain('eval_toolkit_media = [');
        expect(content).toContain('"pillow>=10"');
    });

    it('lists an extra once when two skills share it', () => {
        const content = buildPyprojectContent(
            ['evaluate-predictions', 'generate-predictions'],
            '>=3.12',
            DEPS
        );
        expect(content.match(/^eval_toolkit = \[/gm)).toHaveLength(1);
    });

    it('adds no media extra for skills that do not score media', () => {
        const content = buildPyprojectContent(
            ['generate-predictions'],
            '>=3.12',
            DEPS
        );
        expect(content).not.toContain('eval_toolkit_media');
    });
});
