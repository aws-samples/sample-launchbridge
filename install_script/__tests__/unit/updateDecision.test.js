// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * `launchbridge update` applies only an update someone has seen: at the prompt,
 * or by naming the previewed commit with --apply. --yes alone applies nothing.
 */

import { describe, it, expect } from 'vitest';
import { decideUpdate, parseApplyCommit } from '../../lib/updateDecision.js';

// Only the 40-hex shape matters; built at runtime so no hash-shaped literal is committed.
const SHORT = 'ab'.repeat(6);
const preview = { to: SHORT + '0'.repeat(28) };

describe('decideUpdate', () => {
    it('prompts on a terminal', () => {
        expect(decideUpdate(preview, { isTTY: true }).action).toBe('prompt');
    });

    it('does not apply with --yes alone, and names the commit to apply', () => {
        const d = decideUpdate(preview, { yes: true, isTTY: true });
        expect(d.action).toBe('decline');
        expect(d.message).toContain(`--apply ${SHORT}`);
    });

    it('does not apply without a terminal', () => {
        expect(decideUpdate(preview, { isTTY: false }).action).toBe('decline');
    });

    it('applies the previewed commit', () => {
        expect(
            decideUpdate(preview, { applyCommit: SHORT.toUpperCase() }).action
        ).toBe('apply');
    });

    it('refuses when the update moved past the reviewed commit', () => {
        const d = decideUpdate(preview, { applyCommit: 'f'.repeat(12) });
        expect(d.action).toBe('decline');
        expect(d.message).toContain(`now ends at ${SHORT}`);
    });

    it('accepts the full commit id', () => {
        expect(decideUpdate(preview, { applyCommit: preview.to }).action).toBe(
            'apply'
        );
    });

    it('refuses a prefix shorter than 12 characters, even when it matches', () => {
        const d = decideUpdate(preview, { applyCommit: SHORT.slice(0, 11) });
        expect(d.action).toBe('decline');
        expect(d.message).toContain('at least the first 12 characters');
    });

    it('refuses something that is not a commit id', () => {
        expect(decideUpdate(preview, { applyCommit: 'main' }).action).toBe(
            'decline'
        );
    });
});

describe('parseApplyCommit', () => {
    it('reads both forms', () => {
        expect(parseApplyCommit(['--apply', 'abc1234'])).toBe('abc1234');
        expect(parseApplyCommit(['--apply=abc1234'])).toBe('abc1234');
        expect(parseApplyCommit(['--yes'])).toBeNull();
    });
});
