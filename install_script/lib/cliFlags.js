// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * CLI Flags Module
 *
 * Reads the installer's options for non-interactive operation. An argument it
 * does not know, or an option that takes a value given none, is an error
 * rather than ignored: a mistyped or empty --scope would otherwise leave the
 * scope to its default, and a --yes run would then install into folders the
 * command did not name.
 */

import { stripControlCharacters } from './terminalText.js';

/** The options that take a value, and what the value is. */
const VALUE_OPTIONS = {
    '--skills': "skill or category names separated by commas, or 'all'",
    '--agent': 'agent names separated by commas',
    '--scope': "'global' or 'local'",
    '--method': "'copy' or 'symlink'",
};

/**
 * @typedef {Object} CLIFlags
 * @property {string|null} skills
 * @property {string|null} agent
 * @property {string|null} scope
 * @property {string|null} method
 * @property {boolean} yes
 */

/**
 * Parses the installer's options:
 *
 *   --skills <list>   Comma-separated skill names, category names, or 'all'
 *   --agent <list>    Comma-separated agent names (e.g., kiro, claude)
 *   --scope <value>   'global' or 'local'
 *   --method <value>  'copy' or 'symlink'
 *   --yes / -y        Auto-confirm all prompts
 *
 * A value is the next argument, or follows `=` (`--scope=local`). The next
 * argument is not taken as a value when it starts with `-`.
 *
 * @param {string[]} args - The arguments after the script (process.argv.slice(2))
 * @returns {{ flags: CLIFlags, error: null } | { flags: null, error: string }}
 *   `error` says what is wrong, for the installer to print before it exits 1
 */
export function parseCLIFlags(args) {
    /** @type {CLIFlags} */
    const flags = {
        skills: null,
        agent: null,
        scope: null,
        method: null,
        yes: false,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--yes' || arg === '-y') {
            flags.yes = true;
            continue;
        }
        const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const option = equals > 0 ? arg.slice(0, equals) : arg;
        if (!Object.hasOwn(VALUE_OPTIONS, option)) {
            return { flags: null, error: unknownArgument(arg) };
        }
        let value = '';
        if (equals > 0) {
            value = arg.slice(equals + 1);
        } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
            value = args[++i];
        }
        if (value.split(',').every((part) => part.trim() === '')) {
            return {
                flags: null,
                error: `${option} needs a value: ${VALUE_OPTIONS[option]}.`,
            };
        }
        flags[option.slice(2)] = value;
    }
    return { flags, error: null };
}

/** @param {string} arg */
function unknownArgument(arg) {
    if (arg === 'update') {
        return "'update' must come first: launchbridge update";
    }
    return (
        `Unknown option: '${stripControlCharacters(arg)}'. ` +
        'Use --skills, --agent, --scope, --method or --yes.'
    );
}
