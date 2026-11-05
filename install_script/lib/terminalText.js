// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Text from outside LaunchBridge (commit metadata, file names from a remote)
 * shown in the terminal. Control characters are removed so the text cannot move
 * the cursor, recolour the terminal, or reorder what is displayed.
 */

// C0 controls and DEL, C1 controls, and Unicode bidirectional controls
// (ALM, LRM, RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI).
const CONTROL_CHARACTERS =
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * @param {unknown} text
 * @returns {string}
 */
export function stripControlCharacters(text) {
    return String(text).replace(CONTROL_CHARACTERS, '');
}
