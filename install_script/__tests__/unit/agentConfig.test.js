// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from 'vitest';
import { getAgentConfig } from '../../lib/agentConfig.js';

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
