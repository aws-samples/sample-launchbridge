// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Debug flag module.
 *
 * Set once at startup by parsing --debug from process.argv.
 * Import isDebug() anywhere to check whether verbose output is enabled.
 */

const _debug = process.argv.includes('--debug');

/**
 * Returns true if --debug was passed on the command line.
 * @returns {boolean}
 */
export function isDebug() {
    return _debug;
}

/**
 * Prints a message only when --debug is active.
 * @param {string} msg
 */
export function debug(msg) {
    if (_debug) {
        process.stdout.write(`\x1b[2m[debug] ${msg}\x1b[0m\n`);
    }
}
