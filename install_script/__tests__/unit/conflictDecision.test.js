// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * An existing directory with a selected skill's name is replaced without asking
 * only if LaunchBridge installed it before; --yes never replaces anyone else's.
 */

import { describe, it, expect } from 'vitest';
import { decideExistingSkillPath } from '../../lib/conflictDecision.js';

describe('decideExistingSkillPath', () => {
    it('replaces a previously installed skill under --yes', () => {
        expect(
            decideExistingSkillPath({
                overwriteAll: true,
                yes: true,
                previouslyInstalled: true,
            })
        ).toBe('overwrite');
    });

    it('skips a directory LaunchBridge did not install under --yes', () => {
        expect(
            decideExistingSkillPath({
                overwriteAll: true,
                yes: true,
                previouslyInstalled: false,
            })
        ).toBe('skip');
    });

    it('asks about a directory LaunchBridge did not install, even after a method change', () => {
        expect(
            decideExistingSkillPath({
                overwriteAll: true,
                yes: false,
                previouslyInstalled: false,
            })
        ).toBe('prompt');
    });

    it('asks about a previously installed skill unless told to overwrite all', () => {
        expect(
            decideExistingSkillPath({
                overwriteAll: false,
                previouslyInstalled: true,
            })
        ).toBe('prompt');
    });
});
