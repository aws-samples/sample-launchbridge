// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Conflict Decision Module
 *
 * Decides what the installer does when a selected skill's target directory
 * already exists. A directory LaunchBridge installed before (it is in the
 * previous manifest) may be replaced without asking. Any other directory with
 * that name belongs to someone else, so it is never replaced without a person
 * saying so: an unattended (--yes) run skips it, and an interactive run asks.
 */

/**
 * @param {{ overwriteAll: boolean, yes?: boolean, previouslyInstalled: boolean }} options
 * @returns {'overwrite' | 'skip' | 'prompt'}
 */
export function decideExistingSkillPath({
    overwriteAll,
    yes = false,
    previouslyInstalled,
}) {
    if (previouslyInstalled) {
        return overwriteAll ? 'overwrite' : 'prompt';
    }
    return yes ? 'skip' : 'prompt';
}
