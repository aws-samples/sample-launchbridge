// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// CI canary: a deliberately failing assertion.
import { describe, it, expect } from 'vitest';

describe('CI canary', () => {
    it('fails on purpose', () => {
        expect(1 + 1).toBe(3);
    });
});
