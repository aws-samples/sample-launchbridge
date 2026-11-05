// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import chalk from 'chalk';
import { AGENTS } from './agentConfig.js';
import { section, kv, divider, spacer, muted, successBanner } from './ui.js';

/**
 * Reporter Module
 *
 * Formats and displays output to the user.
 */

/**
 * @typedef {Object} InstallationReport
 * @property {import('./installer.js').InstallationResult[]} successful - Successful installations
 * @property {import('./installer.js').InstallationResult[]} failed - Failed installations
 * @property {import('./installer.js').InstallationResult[]} skipped - Skipped installations
 * @property {string[]} [warnings] - Non-fatal warnings to surface at the end
 */

/**
 * Displays a summary of user selections.
 * @param {import('./promptManager.js').UserSelections} selections - User selections
 * @returns {string} Empty string — output is printed directly
 */
export function displaySummary(selections) {
    section('Installation Summary');

    const agentNames = selections.agents.map((a) => {
        const config = AGENTS[a];
        return config ? config.displayName : a;
    });

    kv('Agents', agentNames.join(', '));
    kv(
        'Scope',
        selections.scope === 'local'
            ? 'Local (repository)'
            : 'Global (home directory)'
    );
    kv('Method', selections.method === 'symlink' ? 'Symlink' : 'Copy');
    kv('Source', selections.sourcePath);
    kv('Skills', selections.skills.join(', '));

    return '';
}

/**
 * Displays progress for a skill installation.
 * @param {string} skillName
 * @param {import('./promptManager.js').Agent} agent
 * @param {string} status
 */
export function displayProgress(skillName, agent, status) {
    const label = chalk.dim(`(${agent})`);

    switch (status.toLowerCase()) {
        case 'success':
            console.log(chalk.green(`  ✓ ${skillName} ${label}`));
            break;
        case 'failure':
        case 'failed':
        case 'error':
            console.log(chalk.red(`  ✗ ${skillName} ${label}`));
            break;
        case 'installing':
        case 'in-progress':
        case 'in_progress':
            console.log(chalk.dim(`  · ${skillName} ${label}`));
            break;
        case 'skipped':
        case 'skip':
            console.log(chalk.dim(`  ○ ${skillName} ${label} — skipped`));
            break;
        default:
            console.log(`  ${skillName} ${label} [${status}]`);
    }
}

/**
 * Displays the final installation report.
 * @param {InstallationReport} report
 */
export function displayFinalReport(report) {
    const successCount = report.successful.length;
    const failedCount = report.failed.length;
    const skippedCount = report.skipped.length;
    const warnings = report.warnings ?? [];

    section('Results');

    console.log(
        `  ${chalk.green(`${successCount} skills installed`)}` +
            (failedCount ? `  ${chalk.red(`${failedCount} failed`)}` : '') +
            (skippedCount ? `  ${chalk.dim(`${skippedCount} skipped`)}` : '') +
            (warnings.length
                ? `  ${chalk.yellow(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`)}`
                : '')
    );

    if (report.failed.length > 0) {
        spacer();
        console.log(chalk.red('  Failed:'));
        for (const result of report.failed) {
            console.log(
                chalk.red(`    • ${result.skillName} (${result.agent})`)
            );
            if (result.error) {
                muted(result.error);
            }
        }
    }

    if (report.skipped.length > 0) {
        spacer();
        console.log(chalk.dim('  Skipped:'));
        for (const result of report.skipped) {
            console.log(
                chalk.dim(`    • ${result.skillName} (${result.agent})`)
            );
        }
    }

    if (warnings.length > 0) {
        spacer();
        console.log(chalk.yellow('  Warnings:'));
        for (const warning of warnings) {
            console.log(chalk.yellow(`    ⚠ ${warning}`));
        }
    }

    divider();
}

/**
 * Determines the exit code based on installation results.
 * @param {InstallationReport} report
 * @returns {number}
 */
export function getExitCode(report) {
    return report.failed.length > 0 ? 1 : 0;
}

/**
 * @typedef {Object} LifecycleReport
 * @property {import('./lifecycleOrchestrator.js').LifecycleScenario} scenario
 * @property {string[]} installed - Skills freshly installed (new additions)
 * @property {string[]} updated - Skills overwritten with new content (status reset)
 * @property {string[]} removed - Skills removed as orphans
 * @property {string[]} unchanged - Skills with no changes (skipped)
 * @property {string[]} failed - Skills that failed to install
 * @property {string[]} warnings - Non-fatal warnings
 * @property {string} [upgradeFromVersion] - Previous version
 * @property {string} [upgradeToVersion] - New version
 * @property {boolean} needsLbSetup - Whether user should run lb-setup
 * @property {string[]} resetReasons - Human-readable reasons for resets
 */

/**
 * Builds a lifecycle-aware report from installation results and decisions.
 *
 * Categorizes skills into installed/updated/removed/unchanged/failed based on
 * the installation results and the lifecycle decision that was executed.
 *
 * @param {Object} results - Installation execution results
 * @param {Object[]} results.successful - Successfully installed skills
 * @param {Object[]} results.failed - Skills that failed to install
 * @param {Object[]} results.skipped - Skills that were skipped
 * @param {import('./lifecycleOrchestrator.js').LifecycleDecision} decision - The lifecycle decision
 * @returns {LifecycleReport}
 */
export function buildLifecycleReport(results, decision) {
    const installed = [];
    const updated = [];
    const failed = [];

    // Categorize successful results into installed vs updated
    for (const result of results.successful) {
        const skillName = result.skillName;
        if (decision.skillsToReset.includes(skillName)) {
            updated.push(skillName);
        } else {
            installed.push(skillName);
        }
    }

    // Failed skills
    for (const result of results.failed) {
        failed.push(result.skillName);
    }

    // Removed and unchanged come directly from the decision
    const removed = [...decision.skillsToRemove];
    const unchanged = [...decision.skillsUnchanged];

    // Warnings from the decision
    const warnings = [...(decision.warnings || [])];

    // Determine if lb-setup is needed
    const needsLbSetup =
        installed.length > 0 ||
        updated.length > 0 ||
        decision.resetVenvSetup ||
        decision.resetMcpSetup ||
        decision.resetAgentsMerge;

    // Build human-readable reset reasons
    const resetReasons = [];
    if (updated.length > 0) {
        resetReasons.push(
            `${updated.length} skill${updated.length > 1 ? 's' : ''} updated with new content — setup will re-run`
        );
    }
    if (decision.resetVenvSetup) {
        resetReasons.push(
            'Python dependencies changed — virtual environment will be rebuilt'
        );
    }
    if (decision.resetMcpSetup) {
        resetReasons.push(
            'MCP server template changed — MCP config will be reconciled'
        );
    }
    if (decision.resetAgentsMerge) {
        resetReasons.push('AGENTS.md updated — merge will be prompted');
    }

    return {
        scenario: decision.scenario,
        installed,
        updated,
        removed,
        unchanged,
        failed,
        warnings,
        upgradeFromVersion: decision.upgradeFromVersion,
        upgradeToVersion: decision.upgradeToVersion,
        needsLbSetup,
        resetReasons,
    };
}

/**
 * Displays the lifecycle report to the user.
 *
 * Adapts the output based on the lifecycle scenario:
 * - idempotent_rerun: "Installation is up to date — no changes needed."
 * - fresh_install: "X skills installed. Run lb-setup..."
 * - incremental_update: counts of installed/updated/removed/unchanged + reset reasons
 * - release_upgrade: version header + counts + reset reasons
 * - interrupt_recovery: recovery header + normal counts
 *
 * @param {LifecycleReport} report
 */
export function displayLifecycleReport(report) {
    section('Results');

    // Scenario-specific header
    switch (report.scenario) {
        case 'idempotent_rerun':
            console.log(
                chalk.green('  Installation is up to date — no changes needed.')
            );
            _displayWarnings(report.warnings);
            divider();
            return;

        case 'fresh_install': {
            if (report.failed.length === 0) {
                console.log(
                    chalk.green(
                        `  ${report.installed.length} skill${report.installed.length !== 1 ? 's' : ''} installed.`
                    )
                );
            } else {
                console.log(
                    `  ${chalk.green(`${report.installed.length} installed`)}  ${chalk.red(`${report.failed.length} failed`)}`
                );
            }
            _displayFailed(report.failed);
            _displayWarnings(report.warnings);
            if (report.needsLbSetup) {
                successBanner(
                    'Skills installed — open your agent and run the skill "lb-setup" or ask your agent to start the LaunchBridge skills'
                );
            }
            return;
        }

        case 'release_upgrade':
            console.log(
                chalk.bold.cyan(
                    `  Upgrading from v${report.upgradeFromVersion} to v${report.upgradeToVersion}`
                )
            );
            spacer();
            break;

        case 'interrupt_recovery':
            console.log(
                chalk.yellow('  Recovering from interrupted installation...')
            );
            spacer();
            break;

        case 'incremental_update':
        default:
            break;
    }

    // Counts line for incremental_update, release_upgrade, interrupt_recovery
    const parts = [];
    if (report.installed.length > 0) {
        parts.push(chalk.green(`${report.installed.length} installed`));
    }
    if (report.updated.length > 0) {
        parts.push(chalk.yellow(`${report.updated.length} updated`));
    }
    if (report.removed.length > 0) {
        parts.push(chalk.red(`${report.removed.length} removed`));
    }
    if (report.unchanged.length > 0) {
        parts.push(chalk.dim(`${report.unchanged.length} unchanged`));
    }
    if (report.failed.length > 0) {
        parts.push(chalk.red(`${report.failed.length} failed`));
    }

    if (parts.length > 0) {
        console.log(`  ${parts.join('  ')}`);
    }

    // Reset reasons
    if (report.resetReasons.length > 0) {
        spacer();
        for (const reason of report.resetReasons) {
            console.log(chalk.dim(`  → ${reason}`));
        }
    }

    // Failed skills detail
    _displayFailed(report.failed);

    // Warnings
    _displayWarnings(report.warnings);

    // Next-step guidance
    if (report.needsLbSetup) {
        successBanner(
            'Skills installed — open your agent and run the skill "lb-setup" or ask your agent to start the LaunchBridge skills'
        );
    }

    divider();
}

/**
 * Displays failed skills with error styling.
 * @param {string[]} failed
 * @private
 */
function _displayFailed(failed) {
    if (failed.length > 0) {
        spacer();
        console.log(chalk.red('  Failed:'));
        for (const skillName of failed) {
            console.log(chalk.red(`    • ${skillName}`));
        }
    }
}

/**
 * Displays warnings if present.
 * @param {string[]} warnings
 * @private
 */
function _displayWarnings(warnings) {
    if (warnings.length > 0) {
        spacer();
        console.log(chalk.yellow('  Warnings:'));
        for (const warning of warnings) {
            console.log(chalk.yellow(`    ⚠ ${warning}`));
        }
    }
}
