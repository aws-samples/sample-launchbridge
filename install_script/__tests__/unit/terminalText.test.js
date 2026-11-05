// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Remote-supplied text in the update preview cannot drive the terminal or
 * reorder what it displays.
 */

import { describe, it, expect } from 'vitest';
import { stripControlCharacters } from '../../lib/terminalText.js';

const ch = (code) => String.fromCodePoint(code);

describe('stripControlCharacters', () => {
    it('removes C0 controls, DEL and escape sequences', () => {
        expect(
            stripControlCharacters(`a${ch(0x1b)}[31mb${ch(0x7f)}c${ch(0x07)}`)
        ).toBe('a[31mbc');
    });

    it('removes C1 controls such as CSI', () => {
        expect(stripControlCharacters(`a${ch(0x9b)}31mb${ch(0x85)}`)).toBe(
            'a31mb'
        );
    });

    it('removes bidirectional overrides and isolates', () => {
        const codes = [
            0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
            0x2066, 0x2067, 0x2068, 0x2069,
        ];
        const text = 'fix' + codes.map(ch).join('') + 'cxe.tpircs';
        expect(stripControlCharacters(text)).toBe('fixcxe.tpircs');
    });

    it('keeps ordinary text, including non-ASCII letters', () => {
        expect(stripControlCharacters('Café — naïve résumé 日本')).toBe(
            'Café — naïve résumé 日本'
        );
    });
});
