// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from 'vitest';
import path from 'path';
import {
    isPathWithin,
    validatePathWithinBase,
} from '../../lib/pathSanitizer.js';

const base = path.resolve('/tmp/lb-base/launchbridge');
const at = (...parts) => path.join(base, ...parts);

describe('isPathWithin', () => {
    it('accepts a child', () => {
        expect(isPathWithin(at('skills', 'demo', 'SKILL.md'), base)).toBe(true);
    });

    it('accepts the base itself, with or without a trailing separator', () => {
        expect(isPathWithin(base, base)).toBe(true);
        expect(isPathWithin(base, base + path.sep)).toBe(true);
    });

    it('rejects a sibling that shares the base as a string prefix', () => {
        expect(isPathWithin(`${base}-old`, base)).toBe(false);
        expect(isPathWithin(path.join(`${base}-old`, 'x'), base)).toBe(false);
    });

    it('rejects the parent and traversal out of the base', () => {
        expect(isPathWithin(path.dirname(base), base)).toBe(false);
        expect(isPathWithin(at('..', 'other'), base)).toBe(false);
        expect(isPathWithin(at('skills', '..', '..', 'x'), base)).toBe(false);
    });

    it('accepts a child whose name only starts with dots', () => {
        expect(isPathWithin(at('..cache', 'f'), base)).toBe(true);
    });

    it('resolves traversal that stays inside', () => {
        expect(isPathWithin(at('a', '..', 'b'), base)).toBe(true);
    });
});

describe('validatePathWithinBase', () => {
    it('keeps its result shape for callers', () => {
        expect(validatePathWithinBase(at('x'), base)).toEqual({ valid: true });
        const outside = validatePathWithinBase(`${base}-old`, base);
        expect(outside.valid).toBe(false);
        expect(outside.error).toMatch(/Path traversal detected/);
    });
});
