// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * UI Utilities
 *
 * Shared terminal formatting helpers. Uses chalk (already a dependency)
 * and ANSI escape codes — no additional dependencies required.
 */

import chalk from 'chalk';

// ─── Primitives ──────────────────────────────────────────────────────────────

export const dim = (s) => chalk.dim(s);

// ─── Status lines ─────────────────────────────────────────────────────────────

export const success = (msg) => console.log(chalk.green(`  ✓ ${msg}`));
export const warn = (msg) => console.log(chalk.yellow(`  ⚠ ${msg}`));
export const error = (msg) => console.log(chalk.red(`  ✗ ${msg}`));
export const info = (msg) => console.log(chalk.cyan(`  ℹ ${msg}`));
export const muted = (msg) => console.log(chalk.dim(`    ${msg}`));

// ─── Section / step headers ───────────────────────────────────────────────────

/**
 * Prints a numbered step header, e.g.
 *   ┌─ Step 1 ─ AWS Credentials ──────────────────────────────────────────────
 */
export function step(n, title) {
    const label = chalk.bold.white(` Step ${n} `);
    const titlePart = chalk.bold.cyan(` ${title} `);
    const line = '─'.repeat(Math.max(0, 72 - ` Step ${n}  ${title} `.length));
    console.log(
        '\n' +
            chalk.dim('┌─') +
            chalk.dim('─') +
            titlePart +
            chalk.dim('─' + line)
    );
    console.log('');
}

/**
 * Prints a plain section divider with a label.
 */
export function section(title) {
    const line = '─'.repeat(Math.max(0, 74 - title.length));
    console.log('\n' + chalk.bold.white(title) + ' ' + chalk.dim(line));
}

// ─── Dividers ─────────────────────────────────────────────────────────────────

export const divider = () => console.log(chalk.dim('─'.repeat(76)));
export const spacer = () => console.log('');

// ─── Key/value pairs (used in summary) ───────────────────────────────────────

export function kv(key, value) {
    const paddedKey = chalk.dim(key.padEnd(14));
    console.log(`  ${paddedKey} ${chalk.white(value)}`);
}

// ─── Final banner ─────────────────────────────────────────────────────────────

export function successBanner(msg) {
    const width = 76;
    const inner = ` ${msg} `;
    const pad = Math.max(0, Math.floor((width - inner.length) / 2));
    const line = '═'.repeat(width);
    console.log('\n' + chalk.green(line));
    spacer();
    console.log(chalk.green(' '.repeat(pad) + chalk.bold(inner)));
    spacer();
    console.log(chalk.green(line) + '\n');
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Starts a spinner with a label. Returns a stop function that clears the line
 * and prints a final status line.
 *
 * @param {string} label
 * @returns {{ stop: (finalMsg?: string, failed?: boolean) => void }}
 */
export function spinner(label) {
    // Don't spin in non-TTY environments (CI logs, pipes)
    if (!process.stdout.isTTY) {
        process.stdout.write(`  ${label}...\n`);
        return {
            stop: (finalMsg) => {
                if (finalMsg) process.stdout.write(`  ${finalMsg}\n`);
            },
        };
    }

    let i = 0;
    const interval = setInterval(() => {
        process.stdout.write(
            `\r  ${chalk.cyan(SPINNER_FRAMES[i % SPINNER_FRAMES.length])} ${chalk.dim(label)}`
        );
        i++;
    }, 80);

    return {
        stop: (finalMsg, failed = false) => {
            clearInterval(interval);
            process.stdout.write('\r\x1b[K'); // clear the spinner line
            if (finalMsg) {
                const icon = failed ? chalk.red('✗') : chalk.green('✓');
                console.log(`  ${icon} ${finalMsg}`);
            }
        },
    };
}
