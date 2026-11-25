// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Updater Module
 *
 * Performs a `git pull` to update the LaunchBridge repository to the latest
 * version. If a version_manifest.json exists in the target repository, it
 * also handles post-pull skill synchronisation:
 *
 *  - symlink installs: each skill folder is a link to the source, so the git
 *    pull updates it; a folder an older install made of per-file links is
 *    linked again as a whole unless it holds files LaunchBridge did not
 *    install, and pyproject.toml is regenerated if dependencies changed.
 *  - copy installs: skills whose content hash changed are re-copied from
 *    the updated source, then pyproject.toml is regenerated if needed.
 *
 * Additionally, setup_status.md is updated to reset changed skills to
 * "not started" so that lb-setup re-runs their configuration on the next
 * invocation — matching the behavior of the full installer re-run.
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { detectDeliveryMethod } from './deliveryDetector.js';
import { NPM_CI_ARGS, needsNpmInstall, runNpm } from './npmRunner.js';
import {
    isPathWithin,
    safePathJoin,
    validatePathWithinBase,
} from './pathSanitizer.js';
import { stripControlCharacters } from './terminalText.js';

/**
 * Runs a git command in the given directory and returns stdout/stderr.
 *
 * @param {string[]} args - Git arguments
 * @param {string} cwd - Working directory
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runGit(args, cwd) {
    return new Promise((resolve) => {
        // Arguments are an array built by this module (no shell), run in
        // LaunchBridge's own clone.
        // nosemgrep: detect-child-process
        const proc = spawn('git', args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });

        proc.on('error', (err) => {
            resolve({ code: 1, stdout: '', stderr: err.message });
        });
    });
}

/**
 * Classifies a git error into a user-friendly message.
 *
 * @param {string} stderr - Raw stderr from git
 * @returns {string} Human-readable error message
 */
function classifyGitError(stderr) {
    const lower = stderr.toLowerCase();

    if (
        lower.includes('repository not found') ||
        lower.includes('does not exist') ||
        lower.includes('not found')
    ) {
        return 'Repository not found. Verify the remote URL is correct and you have access.';
    }

    if (
        lower.includes('permission denied') ||
        lower.includes('authentication failed') ||
        lower.includes('could not read username') ||
        lower.includes('invalid username or password') ||
        lower.includes('access denied') ||
        lower.includes('403') ||
        lower.includes('401')
    ) {
        return (
            'Access denied. You do not have permission to pull from this repository.\n' +
            'Check that your credentials (SSH key or token) are configured correctly.'
        );
    }

    if (
        lower.includes('could not resolve host') ||
        lower.includes('unable to connect') ||
        lower.includes('network') ||
        lower.includes('timeout')
    ) {
        return 'Network error. Could not reach the remote repository. Check your internet connection.';
    }

    if (lower.includes('no remote') || lower.includes('no such remote')) {
        return "No remote configured. Run 'git remote add origin <url>' to set one up.";
    }

    if (lower.includes('conflict') || lower.includes('merge conflict')) {
        return (
            'Merge conflict detected. Resolve conflicts manually before updating:\n' +
            '  git status\n' +
            '  git diff'
        );
    }

    // Return raw stderr trimmed if we cannot classify it
    return stderr.trim() || 'Unknown git error.';
}

/**
 * Groups the paths an update would change: skill instructions (`SKILL.md`),
 * other skill files, installer files, agent steering, submodule pointers and
 * scripts. Used to build the preview shown before an update is applied.
 *
 * @param {string[]} changedPaths - Repo-relative paths from `git diff --name-only`
 * @returns {{ skills: string[], skillInstructions: string[], installer: string[], steering: string[], submodules: string[], scripts: string[], other: string[] }}
 */
export function summarizeIncomingChanges(changedPaths) {
    const skills = new Set();
    const skillInstructions = new Set();
    const installer = [];
    const steering = [];
    const submodules = [];
    const scripts = [];
    const other = [];

    for (const changed of changedPaths) {
        const parts = changed.split('/');
        if (parts[0] === 'skills' && parts.length > 2) {
            skills.add(parts[1]);
            if (parts[parts.length - 1] === 'SKILL.md') {
                skillInstructions.add(parts[1]);
            }
        } else if (parts[0] === 'install_script') {
            installer.push(changed);
        } else if (
            parts[0] === 'agent_steering' ||
            changed === 'AGENTS.md' ||
            changed === 'CLAUDE.md'
        ) {
            steering.push(changed);
        } else if (parts[0] === 'project_dependencies' && parts.length === 2) {
            // A gitlink: the submodule pointer itself. pyproject.toml also lives
            // at this depth but is an ordinary file.
            if (parts[1] === 'pyproject.toml') {
                other.push(changed);
            } else {
                submodules.push(changed);
            }
        } else {
            other.push(changed);
        }

        if (/\.(js|mjs|cjs|py|sh)$/.test(changed)) {
            scripts.push(changed);
        }
    }

    return {
        skills: [...skills].sort(),
        skillInstructions: [...skillInstructions].sort(),
        installer,
        steering,
        submodules,
        scripts,
        other,
    };
}

/**
 * Runs the update command: fetches the latest changes from the remote and
 * applies them only after the caller confirms.
 *
 * The incoming commits and the files they touch are summarized and passed to
 * `confirm`; only an explicit yes fast-forwards the branch. Anything other than
 * a fast-forward (local commits, or rewritten remote history) is reported as an
 * error for the operator to resolve.
 *
 * @param {string} sourcePath - Path to the LaunchBridge repository root
 * @param {{ confirm?: (preview: object) => Promise<boolean>, npm?: typeof runNpm }} [options]
 *     `confirm` receives the preview and returns whether to apply it. Without
 *     one, nothing is applied. `npm` replaces the npm runner (tests).
 * @returns {Promise<{ output: string, branch: string, alreadyCurrent: boolean, declined?: boolean, preview?: object, submoduleWarning?: string, npmInstalled?: boolean, npmError?: string }>}
 *     Resolves on success (including "already up to date" and "declined"), rejects with an Error on failure
 */
export async function runUpdate(sourcePath, { confirm, npm = runNpm } = {}) {
    // Ensure we are in a git repository (not a bundled install)
    const deliveryMethod = await detectDeliveryMethod(sourcePath);
    if (deliveryMethod !== 'git_repo') {
        throw new Error(
            'This installation was not set up as a git repository.\n' +
                'The update command only works in a git clone of LaunchBridge. Clone the repository, ' +
                'or install with `npm install -g github:aws-samples/sample-launchbridge`, which updates through ~/.launchbridge.'
        );
    }

    // Verify git is available
    const versionCheck = await runGit(['--version'], sourcePath);
    if (versionCheck.code !== 0) {
        throw new Error(
            'git is not installed or not on PATH. Install git and try again.'
        );
    }

    // Check that a remote is configured
    const remoteCheck = await runGit(['remote'], sourcePath);
    if (remoteCheck.code !== 0 || !remoteCheck.stdout.trim()) {
        throw new Error(
            'No git remote configured. Cannot pull updates.\n' +
                "Run 'git remote add origin <url>' to set one up."
        );
    }

    // Detect current branch so we pull the correct remote ref
    const branchResult = await runGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        sourcePath
    );
    const currentBranch =
        branchResult.code === 0 && branchResult.stdout.trim()
            ? branchResult.stdout.trim()
            : 'HEAD';

    // A detached HEAD (for example a checked-out release tag) has no branch
    // to follow. Fetching HEAD would offer the default branch's tip instead
    // of a newer release, so stop and point to the tag-based update.
    if (currentBranch === 'HEAD') {
        const described = await runGit(
            ['describe', '--tags', '--exact-match', 'HEAD'],
            sourcePath
        );
        const at =
            described.code === 0 && described.stdout.trim()
                ? `release tag ${described.stdout.trim()}`
                : 'a detached HEAD';
        throw new Error(
            `This LaunchBridge clone is checked out at ${at}, not on a branch, ` +
                "so 'launchbridge update' has nothing to follow.\n" +
                'To move to a newer release, fetch the tags, verify the new tag and check it out:\n' +
                '  git fetch --tags origin\n' +
                '  git -c gpg.ssh.allowedSignersFile=~/.config/launchbridge/allowed_signers verify-tag <new-tag>\n' +
                '  git checkout <new-tag> && git submodule update --init --recursive\n' +
                "Then run 'launchbridge' again: for a global install choose Global (or pass --scope global); " +
                'for a local install, run it in your project and choose Local (or pass --scope local).'
        );
    }

    // Fetch only — disable recursive submodule fetching so that a
    // missing/unreachable submodule commit doesn't block the main fetch.
    const fetchResult = await runGit(
        ['fetch', '--no-recurse-submodules', 'origin', currentBranch],
        sourcePath
    );
    if (fetchResult.code !== 0) {
        throw new Error(classifyGitError(fetchResult.stderr));
    }

    const headResult = await runGit(['rev-parse', 'HEAD'], sourcePath);
    const incomingResult = await runGit(
        ['rev-parse', 'FETCH_HEAD'],
        sourcePath
    );
    if (headResult.code !== 0 || incomingResult.code !== 0) {
        throw new Error(
            classifyGitError(headResult.stderr || incomingResult.stderr)
        );
    }
    const from = headResult.stdout.trim();
    const to = incomingResult.stdout.trim();

    if (from === to) {
        // Nothing new to review. The submodule sync below still runs, as it
        // did before: it only checks out the commits this tree already pins.
        const alreadyCurrent = {
            output: '',
            branch: currentBranch,
            alreadyCurrent: true,
        };
        const sync = await runGit(
            ['submodule', 'update', '--init', '--recursive'],
            sourcePath
        );
        if (sync.code !== 0) {
            alreadyCurrent.submoduleWarning = `Submodule update failed (non-fatal): ${sync.stderr.trim() || 'unknown error'}. Skill content may be stale.`;
        }
        return alreadyCurrent;
    }

    // `merge-base --is-ancestor` exits 0 when HEAD is an ancestor of the fetched
    // commit (a fast-forward), 1 when it is not, and anything else on error.
    const ancestry = await runGit(
        ['merge-base', '--is-ancestor', from, to],
        sourcePath
    );
    if (ancestry.code === 1) {
        throw new Error(
            `Local branch '${currentBranch}' is not an ancestor of origin/${currentBranch}.\n` +
                'Either it has local commits, or the remote history was rewritten. ' +
                'Update only fast-forwards; it will not merge or rewrite history ' +
                'on your behalf. Inspect the difference before reconciling it:\n' +
                `  git log --oneline --left-right HEAD...FETCH_HEAD`
        );
    }
    if (ancestry.code !== 0) {
        throw new Error(classifyGitError(ancestry.stderr));
    }

    const logResult = await runGit(
        [
            'log',
            '--format=%h%x09%an%x09%ad%x09%s',
            '--date=short',
            `${from}..${to}`,
        ],
        sourcePath
    );
    const diffResult = await runGit(
        ['diff', '--name-only', '--no-renames', from, to],
        sourcePath
    );
    if (logResult.code !== 0 || diffResult.code !== 0) {
        throw new Error(
            classifyGitError(logResult.stderr || diffResult.stderr)
        );
    }

    const commits = logResult.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [hash, author, date, ...subject] = line.split('\t');
            return { hash, author, date, subject: subject.join('\t') };
        });
    const changedPaths = diffResult.stdout.split('\n').filter(Boolean);
    const preview = {
        branch: currentBranch,
        from,
        to,
        commits,
        changedPaths,
        changes: summarizeIncomingChanges(changedPaths),
    };

    // Apply only on an explicit confirmation.
    const confirmed = typeof confirm === 'function' && (await confirm(preview));
    if (!confirmed) {
        return {
            output: '',
            branch: currentBranch,
            alreadyCurrent: false,
            declined: true,
            preview,
        };
    }

    // Fast-forward to the commit that was previewed.
    const result = await runGit(['merge', '--ff-only', to], sourcePath);
    if (result.code !== 0) {
        throw new Error(classifyGitError(result.stderr));
    }

    // Update submodules so that content under project_dependencies/ (e.g.
    // metric-library) matches the commit pointer the pull just advanced.
    // This ensures downstream hash comparisons and skill copies see the
    // latest submodule content, not a stale checkout.
    // Non-fatal: if the submodule remote is unreachable or the referenced
    // commit doesn't exist yet, warn and continue with the stale checkout.
    const subResult = await runGit(
        ['submodule', 'update', '--init', '--recursive'],
        sourcePath
    );
    const updated = {
        output: result.stdout.trim(),
        branch: currentBranch,
        alreadyCurrent: false,
        preview,
    };
    if (subResult.code !== 0) {
        // Flag the submodule issue so the caller can surface a warning.
        updated.submoduleWarning = `Submodule update failed (non-fatal): ${subResult.stderr.trim() || 'unknown error'}. Skill content may be stale.`;
    }

    // The CLI runs from this clone's node_modules. If the update changed the
    // npm manifest or lockfile, reinstall now: otherwise the next run loads
    // packages that no longer match the code (a crash, for a major bump).
    if (needsNpmInstall(changedPaths)) {
        const npmResult = await npm(NPM_CI_ARGS, sourcePath);
        if (npmResult.code === 0) {
            updated.npmInstalled = true;
        } else {
            updated.npmError =
                `npm ci failed in ${sourcePath}: ` +
                (npmResult.stderr.trim().split('\n').slice(-3).join(' ') ||
                    'unknown error');
        }
    }

    return updated;
}

// ── Manifest-aware post-pull sync ─────────────────────────────────────────────

/** Relative path from target repo root to the manifest file. */
const MANIFEST_REL_PATH = '.lb_workspace/config/version_manifest.json';

/**
 * Reads and parses the version manifest from the target repository.
 * Returns null if the file is missing or invalid.
 *
 * @param {string} targetRepo - Root of the target repository (cwd)
 * @returns {Promise<object|null>}
 */
async function readManifestFromTarget(targetRepo) {
    const manifestPath = safePathJoin(targetRepo, MANIFEST_REL_PATH);
    try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.skillHashes !== 'object'
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Writes the manifest back to disk.
 *
 * @param {string} targetRepo
 * @param {object} manifest
 */
async function writeManifestToTarget(targetRepo, manifest) {
    const manifestPath = safePathJoin(targetRepo, MANIFEST_REL_PATH);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
        manifestPath,
        JSON.stringify(manifest, null, 2) + '\n',
        'utf-8'
    );
}

/** Relative path from target repo root to the tracked digest baseline. */
const BASELINE_REL_PATH = '.lb_workspace/config/skill_digests.json';

/**
 * Manifest fields copied into the tracked baseline. Mirrors BASELINE_FIELDS in
 * skills/lb-setup/scripts/verify_integrity.py, which documents why sourcePath,
 * gitCommitHash and deliveryMethod are left out: they describe the installing
 * machine, and the baseline is committed to the client repository.
 * `tests/unit/test_verify_integrity.py` asserts the two lists agree.
 */
export const BASELINE_FIELDS = [
    'version',
    'timestamp',
    'installMethod',
    'agents',
    'skillHashes',
    'externalSkillHashes',
    'externalManifestKeys',
    'agentsHash',
];

/**
 * Writes the tracked digest baseline from `manifest` unless one already exists.
 *
 * @param {string} targetRepo - Root of the target repository
 * @param {object} manifest - The install manifest as it was before the update
 * @returns {Promise<boolean>} true if a baseline was written
 */
export async function writeBaselineIfMissing(targetRepo, manifest) {
    const baselinePath = safePathJoin(targetRepo, BASELINE_REL_PATH);
    try {
        await fs.access(baselinePath);
        return false;
    } catch {
        // No baseline yet — fall through and create one.
    }
    if (!manifest || !Object.keys(manifest.skillHashes || {}).length) {
        return false;
    }

    const baseline = {};
    for (const key of BASELINE_FIELDS) {
        if (key in manifest) {
            baseline[key] = manifest[key];
        }
    }
    baseline.note =
        'Digest baseline for installed LaunchBridge skills. Tracked in git so that ' +
        'an edit to a SKILL.md, or to this file, appears in a reviewable diff. ' +
        'Regenerate only when intentionally upgrading LaunchBridge.';

    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(
        baselinePath,
        JSON.stringify(baseline, null, 2) + '\n',
        'utf-8'
    );
    return true;
}

/**
 * Recursively removes a path (file, symlink, or directory).
 *
 * @param {string} p
 */
async function removePath(p) {
    try {
        const stats = await fs.lstat(p);
        if (stats.isSymbolicLink() || stats.isFile()) {
            await fs.unlink(p);
        } else if (stats.isDirectory()) {
            await fs.rm(p, { recursive: true, force: true });
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

/**
 * Recursively copies a directory from source to target, overwriting existing files.
 * Skips entries that are not regular files or directories (e.g. git submodules,
 * sockets, device files) to avoid ENOTSUP errors.
 *
 * Symlinks are followed when they resolve inside `allowedRoot` (the LaunchBridge
 * source tree), so linked content such as evaluate-predictions'
 * lib/metric-library is copied; other links are skipped and reported through
 * `onSkip`. Directories already visited, by real path, are not entered again.
 *
 * @param {string} source
 * @param {string} target
 * @param {{ allowedRoot?: string, onSkip?: (src: string, resolved: string) => void, _visited?: Set<string> }} [options]
 *     `allowedRoot` must be a real (symlink-resolved) path. Without it, links are
 *     not followed at all.
 */
export async function copyDirRecursive(source, target, options = {}) {
    const { allowedRoot, onSkip } = options;
    const visited = options._visited ?? new Set();
    const realSource = await fs.realpath(source);
    if (visited.has(realSource)) {
        return;
    }
    visited.add(realSource);
    const next = { allowedRoot, onSkip, _visited: visited };

    await fs.mkdir(target, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        const src = safePathJoin(source, entry.name);
        const dst = safePathJoin(target, entry.name);

        // Guard against path traversal — skip entries that escape the base dirs
        const srcCheck = validatePathWithinBase(src, source);
        const dstCheck = validatePathWithinBase(dst, target);
        if (!srcCheck.valid || !dstCheck.valid) {
            continue;
        }

        if (entry.isDirectory()) {
            await copyDirRecursive(src, dst, next);
        } else if (entry.isFile()) {
            await fs.copyFile(src, dst);
        } else {
            // Symlinks, git submodules (gitlinks), sockets, devices. Resolve the
            // real path first and follow it only if it stays inside the source
            // tree; then stat the resolved path to copy symlinked directories
            // (e.g. lib/metric-library) as real content.
            let resolved;
            try {
                resolved = await fs.realpath(src);
            } catch {
                continue; // broken link — skip it
            }
            if (!allowedRoot || !isPathWithin(resolved, allowedRoot)) {
                onSkip?.(src, resolved);
                continue;
            }
            try {
                const stat = await fs.stat(resolved);
                if (stat.isDirectory()) {
                    await copyDirRecursive(resolved, dst, next);
                } else if (stat.isFile()) {
                    await fs.copyFile(resolved, dst);
                }
                // Anything else (socket, gitlink, device) is silently skipped.
            } catch {
                // If we can't stat it, skip it.
            }
        }
    }
}

/**
 * Merges refreshed external digests (`<agent>/<skill>` keys) over the recorded
 * ones. A `shared/<skill>` digest from an older install, one digest for every
 * agent, is dropped once the skill has refreshed per-agent digests: it no
 * longer matches the adapted copies.
 *
 * Returns undefined when neither side has any, so an install with no external
 * skills does not gain an empty object in its manifest.
 *
 * @param {Record<string, string>|undefined} existing
 * @param {Record<string, string>} refreshed
 * @returns {Record<string, string>|undefined}
 */
export function mergeExternalFolderHashes(existing, refreshed) {
    const merged = { ...(existing || {}) };
    for (const key of Object.keys(refreshed)) {
        delete merged[`shared/${key.slice(key.indexOf('/') + 1)}`];
    }
    Object.assign(merged, refreshed);
    return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merges the recorded external manifest-key list with any refreshed group keys
 * (`ai-domain-*`).
 *
 * The list tells the integrity checker which skillHashes keys are group ids it
 * must not treat as folders. A key that drops out of it would be verified as a
 * directory that does not exist, so keys are only ever added.
 *
 * @param {string[]|undefined} existing
 * @param {Record<string, string>} refreshedHashes
 * @returns {string[]|undefined}
 */
export function mergeExternalManifestKeys(existing, refreshedHashes) {
    const merged = new Set([
        ...(Array.isArray(existing) ? existing : []),
        ...Object.keys(refreshedHashes),
    ]);
    return merged.size > 0 ? [...merged].sort() : undefined;
}

/** Up to five names, then how many more. */
function listNames(names) {
    const shown = names.slice(0, 5).map(stripControlCharacters).join(', ');
    return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

/**
 * Replaces each recorded skill folder of a local symlink install that an
 * older LaunchBridge made of one link per file with a link to its folder. A
 * folder that also holds files LaunchBridge did not install is left as it is,
 * with a warning: replacing it would delete them.
 *
 * @param {string} sourcePath - LaunchBridge source root
 * @param {string} targetRepo
 * @param {object} manifest - The repository's version manifest
 * @param {string[]} agents
 * @param {string[]} skillNames - Native skills with a source folder
 * @param {Record<string, string>} skillPathMap - Skill name → source folder
 * @param {{ muted: Function, warn: Function }} ui
 * @returns {Promise<string[]>} The skills linked again
 */
async function relinkPerFileSkills(
    sourcePath,
    targetRepo,
    manifest,
    agents,
    skillNames,
    skillPathMap,
    { muted, warn }
) {
    const { getTargetPath, checkSkillsDirectory } =
        await import('./pathValidator.js');
    const { targetKey, readInstalledTargets } =
        await import('./installedTargets.js');
    const { installedLayout, entriesNotInstalled } =
        await import('./installedContent.js');
    const { createSymlink } = await import('./installer.js');
    const installedTargets = readInstalledTargets(manifest);
    const relinked = [];
    for (const agent of agents) {
        let base;
        try {
            base = getTargetPath(agent, 'local', targetRepo);
        } catch {
            continue;
        }
        if (!(await checkSkillsDirectory(base, targetRepo)).ok) continue;
        for (const skillName of skillNames) {
            const target = safePathJoin(base, skillName);
            if (!validatePathWithinBase(target, base).valid) continue;
            if (
                installedTargets &&
                !installedTargets.has(targetKey(targetRepo, target))
            ) {
                continue;
            }
            if ((await installedLayout(target)) !== 'per-file') continue;
            try {
                const extras = await entriesNotInstalled(target, sourcePath);
                if (extras.length > 0) {
                    warn(
                        `  Not linking ${skillName} (${agent}) to its source folder: ${target} holds files LaunchBridge did not install (${listNames(extras)}). To replace it, run 'launchbridge' here and choose Local.`
                    );
                    continue;
                }
                await removePath(target);
                await createSymlink(skillPathMap[skillName], target);
                muted(`  Linked ${skillName} (${agent}) to its source folder.`);
                relinked.push(skillName);
            } catch (err) {
                warn(
                    `  Could not link ${skillName} for ${agent} to its source folder: ${err.message}`
                );
            }
        }
    }
    return relinked;
}

/**
 * Performs a smart post-pull update for a target repository:
 *
 *  1. Reads the version_manifest.json from `targetRepo/.lb_workspace/config/`.
 *  2. If no manifest is found, returns immediately (git pull already ran).
 *  3. Computes fresh content hashes for all skills listed in the manifest.
 *  4. For copy installs: re-copies any skill whose hash changed.
 *  5. For symlink installs: skills are already up-to-date via the git pull.
 *  5b. Resets changed skills to "not started" in setup_status.md so lb-setup
 *      re-configures them on the next run.
 *  6. Regenerates pyproject.toml if any skill hash changed or the source
 *     pyproject.toml itself changed.
 *  7. Writes an updated manifest with the new hashes.
 *
 * @param {string} sourcePath - Root of the LaunchBridge source repo
 * @param {string} targetRepo - Root of the target repository (cwd)
 * @param {{ step: Function, success: Function, warn: Function, muted: Function, spacer: Function }} ui
 * @returns {Promise<{ skippedNoManifest: boolean, updatedSkills: string[], pyprojectRegenerated: boolean, statusResetsApplied: number }>}
 */
export async function runPostPullSync(sourcePath, targetRepo, ui) {
    const { step, success, warn, muted, spacer } = ui;

    // ── 1. Read manifest ──────────────────────────────────────────────────────
    const manifest = await readManifestFromTarget(targetRepo);
    if (!manifest) {
        return {
            skippedNoManifest: true,
            updatedSkills: [],
            pyprojectRegenerated: false,
        };
    }

    const {
        skillHashes: oldHashes = {},
        installMethod,
        agents = [],
        skills: manifestSkills,
    } = manifest;

    // Determine the list of skills to check — prefer the manifest's skills list,
    // fall back to the keys of skillHashes.
    const skillNames =
        Array.isArray(manifestSkills) && manifestSkills.length > 0
            ? manifestSkills
            : Object.keys(oldHashes);

    step(2, 'Checking for skill updates');
    spacer();

    // ── 2. Compute fresh hashes ───────────────────────────────────────────────
    const { computeSkillHashes, computeFileHash } =
        await import('./contentHash.js');
    const { discoverSkills } = await import('./skillDiscovery.js');

    const availableSkills = discoverSkills(sourcePath);
    const skillPathMap = {};
    for (const skillName of skillNames) {
        const skill = availableSkills.find((s) => s.name === skillName);
        if (skill) {
            skillPathMap[skillName] = skill.path;
        }
    }

    const newHashes = await computeSkillHashes(skillPathMap, {
        allowedRoot: await fs.realpath(sourcePath),
    });

    // ── 3. Determine changed skills ───────────────────────────────────────────
    const changedSkills = skillNames.filter(
        (name) => skillPathMap[name] && newHashes[name] !== oldHashes[name]
    );

    const updatedSkills = [];

    if (installMethod === 'copy' && changedSkills.length > 0) {
        // ── 4. Re-copy changed skills for each agent ──────────────────────────
        const { getTargetPath, checkSkillsDirectory } =
            await import('./pathValidator.js');
        const { targetKey, readInstalledTargets } =
            await import('./installedTargets.js');
        const installedTargets = readInstalledTargets(manifest);
        const allowedRoot = await fs.realpath(sourcePath);
        const onSkip = (src, resolved) =>
            warn(
                `  Skipped link outside the LaunchBridge source: ${src} -> ${resolved}`
            );

        for (const agent of agents) {
            const baseTargetPath = getTargetPath(agent, 'local', targetRepo);
            const dirCheck = await checkSkillsDirectory(
                baseTargetPath,
                targetRepo
            );
            if (!dirCheck.ok) {
                warn(
                    `  Skipped updating skills for ${agent}: ${dirCheck.reason}`
                );
                continue;
            }

            for (const skillName of changedSkills) {
                const skillSourcePath = skillPathMap[skillName];
                const skillTargetPath = safePathJoin(baseTargetPath, skillName);

                // Replace only a directory LaunchBridge installed; a same-named
                // directory it skipped at install time stays as it is.
                if (
                    installedTargets &&
                    !installedTargets.has(
                        targetKey(targetRepo, skillTargetPath)
                    )
                ) {
                    continue;
                }

                // Guard against path traversal from manifest-sourced skill names
                const targetCheck = validatePathWithinBase(
                    skillTargetPath,
                    baseTargetPath
                );
                if (!targetCheck.valid) {
                    continue;
                }

                try {
                    await removePath(skillTargetPath);
                    await copyDirRecursive(skillSourcePath, skillTargetPath, {
                        allowedRoot,
                        onSkip,
                    });
                    muted(`  Updated skill: ${skillName} (${agent})`);
                    if (!updatedSkills.includes(skillName)) {
                        updatedSkills.push(skillName);
                    }
                } catch (err) {
                    warn(
                        `  Could not update skill ${skillName} for ${agent}: ${err.message}`
                    );
                }
            }
        }

        if (updatedSkills.length > 0) {
            success(
                `${updatedSkills.length} skill(s) re-copied from updated source.`
            );
        }
    } else if (installMethod === 'symlink') {
        // Each skill folder is a link to the updated source — nothing to copy.
        // A folder an older install made, of one link per file, is linked
        // again as a whole: it has no link for a file the skill gained.
        await relinkPerFileSkills(
            sourcePath,
            targetRepo,
            manifest,
            agents,
            skillNames.filter((name) => skillPathMap[name]),
            skillPathMap,
            { muted, warn }
        );
        if (changedSkills.length > 0) {
            muted(
                `  ${changedSkills.length} skill(s) updated automatically via symlinks.`
            );
        } else {
            muted('  All skills are already up to date.');
        }
    } else if (changedSkills.length === 0) {
        muted('  All skills are already up to date.');
    }

    // ── 5. Regenerate pyproject.toml if needed ────────────────────────────────
    let pyprojectRegenerated = false;
    let generatedPyprojectChanged = false;
    let newGeneratedPyprojectHash = manifest.generatedPyprojectHash;
    const skillsChanged = changedSkills.length > 0;

    // Also check if the source dependency set (pyproject.toml or the frozen
    // constraints.txt) changed
    let sourcePyprojectChanged = false;
    let newPyprojectHash = manifest.pyprojectHash;
    try {
        const { computeDependencySetHash } = await import('./contentHash.js');
        newPyprojectHash = await computeDependencySetHash(sourcePath);
        sourcePyprojectChanged = manifest.pyprojectHash
            ? manifest.pyprojectHash !== newPyprojectHash
            : true;
    } catch {
        // Source pyproject.toml or constraints.txt doesn't exist — skip
    }

    const generatedPath = safePathJoin(
        targetRepo,
        '.lb_workspace/config/python_deps/pyproject.toml'
    );
    const hashOf = async (file) => {
        const crypto = await import('crypto');
        return crypto
            .createHash('sha256')
            .update(await fs.readFile(file, 'utf8'))
            .digest('hex');
    };
    // What .venv_lb was built from: the hash recorded at install, or else the
    // file as it is before it is regenerated.
    const builtFromHash =
        manifest.generatedPyprojectHash ||
        (await hashOf(generatedPath).catch(() => undefined));

    if (skillsChanged || sourcePyprojectChanged) {
        const { runVenvSetup } = await import('./venvSetup.js');
        const venv = await runVenvSetup(targetRepo, sourcePath, skillNames);
        if (venv.ok) {
            pyprojectRegenerated = true;
            success('Python dependency config regenerated.');
            // The generated file changes with the skills' extras even when the
            // source dependency set doesn't (a skill gained an extra); .venv_lb
            // must then be rebuilt, since nothing installs into it after
            // lb-setup seals it.
            try {
                newGeneratedPyprojectHash = await hashOf(generatedPath);
                generatedPyprojectChanged =
                    Boolean(builtFromHash) &&
                    builtFromHash !== newGeneratedPyprojectHash;
            } catch {
                // Unreadable: the source hash alone decides, as before
            }
        } else {
            warn(
                `Could not regenerate Python dependency config: ${venv.error}`
            );
        }
    }

    // ── 5b. Reset setup_status.md for changed skills ──────────────────────────
    // Surgically update only the affected rows in setup_status.md, preserving
    // all other statuses as-is. We do NOT use mergeSetupStatus/applyStatusResets
    // here because those functions re-enumerate all known skills from
    // SKILL_CATEGORIES and would reset skills not in the manifest to "not installed".
    let statusResetCount = 0;
    const resetSkillNames = [];
    const venvDepsChanged = sourcePyprojectChanged || generatedPyprojectChanged;
    if (changedSkills.length > 0 || venvDepsChanged) {
        try {
            const { parseSetupStatusContent, buildMarkdownTable } =
                await import('./setupStatus.js');
            const { SKILL_REQUIRES_SETUP } =
                await import('./skillDiscovery.js');

            const statusFilePath = safePathJoin(
                targetRepo,
                '.lb_workspace/setup_status.md'
            );

            let existingStatuses = new Map();
            try {
                const existingContent = await fs.readFile(
                    statusFilePath,
                    'utf-8'
                );
                existingStatuses = parseSetupStatusContent(existingContent);
            } catch {
                // File doesn't exist — nothing to reset
            }

            if (existingStatuses.size > 0) {
                // Detect MCP template and AGENTS.md changes
                let mcpTemplateChanged = false;
                let agentsChanged = false;

                try {
                    const { computeFileHash: hashFile } =
                        await import('./contentHash.js');
                    const newMcpHash = await hashFile(
                        safePathJoin(
                            sourcePath,
                            'skills',
                            'lb-setup',
                            'templates',
                            'lb_mcp.json'
                        )
                    );
                    mcpTemplateChanged = manifest.mcpTemplateHash
                        ? manifest.mcpTemplateHash !== newMcpHash
                        : false;
                } catch {
                    /* template may not exist */
                }

                try {
                    const { computeFileHash: hashFile } =
                        await import('./contentHash.js');
                    const newAgHash = await hashFile(
                        safePathJoin(sourcePath, 'agent_steering', 'AGENTS.md')
                    );
                    agentsChanged = manifest.agentsHash
                        ? manifest.agentsHash !== newAgHash
                        : false;
                } catch {
                    /* file may not exist */
                }

                // Read MCP-gated skills from the template
                let mcpGatedSkills = [];
                try {
                    const mcpTemplatePath = safePathJoin(
                        sourcePath,
                        'skills',
                        'lb-setup',
                        'templates',
                        'lb_mcp.json'
                    );
                    const mcpTemplateContent = await fs.readFile(
                        mcpTemplatePath,
                        'utf-8'
                    );
                    const mcpTemplate = JSON.parse(mcpTemplateContent);
                    mcpGatedSkills = Object.values(mcpTemplate.mcpServers || {})
                        .filter((server) => server.gatedBySkill)
                        .map((server) => server.gatedBySkill);
                } catch {
                    /* fallback: empty list */
                }

                // Surgically update only the affected rows
                let modified = false;

                for (const skillName of changedSkills) {
                    if (existingStatuses.has(skillName)) {
                        // No-setup ("ready") skills stay usable; only skills
                        // that have a setup phase go back to "not started".
                        const requiresSetup =
                            SKILL_REQUIRES_SETUP[skillName] ?? false;
                        if (requiresSetup) {
                            existingStatuses.set(skillName, 'not started');
                            resetSkillNames.push(skillName);
                        } else {
                            existingStatuses.set(skillName, 'ready');
                        }
                        modified = true;
                    }
                }

                // Reset venv-setup only if the dependencies changed (the source
                // set, or the generated file's extras), not just because the
                // same content was regenerated
                if (venvDepsChanged) {
                    if (existingStatuses.has('venv-setup')) {
                        existingStatuses.set('venv-setup', 'not started');
                        modified = true;
                    }
                }
                if (mcpTemplateChanged) {
                    if (existingStatuses.has('mcp-setup')) {
                        existingStatuses.set('mcp-setup', 'not started');
                        modified = true;
                    }
                }
                if (agentsChanged || changedSkills.length > 0) {
                    if (existingStatuses.has('agents-md-merge')) {
                        existingStatuses.set('agents-md-merge', 'not started');
                        modified = true;
                    }
                }

                if (modified) {
                    // Rebuild the file preserving the existing row order
                    const rows = [];
                    for (const [name, status] of existingStatuses) {
                        rows.push({ name, status });
                    }
                    const content = buildMarkdownTable(rows);
                    await fs.writeFile(statusFilePath, content, 'utf-8');
                    statusResetCount = resetSkillNames.length;
                }
            }
        } catch (err) {
            warn(`Could not update setup_status.md: ${err.message}`);
        }
    }

    if (statusResetCount > 0) {
        success(
            `${statusResetCount} skill(s) reset to "not started" in setup_status.md — run lb-setup to re-configure:`
        );
        for (const name of resetSkillNames) {
            muted(`  • ${name}`);
        }
    }

    // ── 5d. Sync external (non-native) skills via their provider ──────────────
    // External skills (e.g. ai-skills) are tracked at the domain level
    // (`ai-domain-*` group keys, `<agent>/<skill>` folder digests) and handled
    // entirely by the provider, keeping this native updater agnostic.
    let externalNewHashes = {};
    let externalNewFolderHashes = {};
    try {
        const { externalSkills } = await import('./externalSkillsProvider.js');
        const externalResult = await externalSkills.update(
            sourcePath,
            targetRepo,
            manifest,
            { muted, success, warn }
        );
        externalNewHashes = externalResult.newHashes || {};
        externalNewFolderHashes = externalResult.newFolderHashes || {};
    } catch (err) {
        warn(`Could not sync external skills: ${err.message}`);
    }

    // ── 5c. Update AGENTS.md reference if it changed ──────────────────────────
    // lb-setup uses .lb_workspace/config/lb_agents_reference.md when tailoring
    // the project's AGENTS.md. Keep it in sync with the source after a pull.
    if (changedSkills.length > 0 || sourcePyprojectChanged) {
        try {
            const { copyAgentsSteering } = await import('./agentsSteering.js');
            await copyAgentsSteering(targetRepo);
        } catch {
            // Non-fatal — lb-setup will fall back to other sources
        }
    }

    // ── 5f. Record the pre-update digest baseline ─────────────────────────────
    // When the target has no tracked skill_digests.json yet, write one from the
    // manifest as it was before this update. An existing baseline is left as is;
    // lb-setup refreshes it (verify_integrity.py --write-baseline) after the
    // changed skills have been reviewed.
    let baselineCreated = false;
    try {
        baselineCreated = await writeBaselineIfMissing(targetRepo, manifest);
    } catch (err) {
        warn(`Could not record the pre-update digest baseline: ${err.message}`);
    }

    // ── 6. Write updated manifest ─────────────────────────────────────────────
    try {
        const { readReleaseVersion, getGitCommitHash } =
            await import('./deliveryDetector.js');
        const newVersion = await readReleaseVersion(sourcePath).catch(
            () => manifest.version
        );
        const newGitHash = await getGitCommitHash(sourcePath).catch(
            () => manifest.gitCommitHash
        );

        // Recompute remaining meta-file hashes
        let newMcpTemplateHash = manifest.mcpTemplateHash;
        let newAgentsHash = manifest.agentsHash;

        try {
            newMcpTemplateHash = await computeFileHash(
                safePathJoin(
                    sourcePath,
                    'skills',
                    'lb-setup',
                    'templates',
                    'lb_mcp.json'
                )
            );
        } catch {
            /* file may not exist — keep existing hash */
        }

        try {
            newAgentsHash = await computeFileHash(
                safePathJoin(sourcePath, 'agent_steering', 'AGENTS.md')
            );
        } catch {
            /* file may not exist — keep existing hash */
        }

        const updatedManifest = {
            ...manifest,
            version: newVersion,
            timestamp: new Date().toISOString(),
            gitCommitHash: newGitHash || manifest.gitCommitHash,
            skillHashes: { ...oldHashes, ...newHashes, ...externalNewHashes },
            // Merged rather than replaced: updateAiSkills only reports the skills
            // it found installed, so a digest it could not see must keep the
            // value it already had instead of dropping out of the check.
            externalSkillHashes: mergeExternalFolderHashes(
                manifest.externalSkillHashes,
                externalNewFolderHashes
            ),
            externalManifestKeys: mergeExternalManifestKeys(
                manifest.externalManifestKeys,
                externalNewHashes
            ),
            pyprojectHash: newPyprojectHash,
            generatedPyprojectHash: newGeneratedPyprojectHash || undefined,
            mcpTemplateHash: newMcpTemplateHash,
            agentsHash: newAgentsHash,
        };

        await writeManifestToTarget(targetRepo, updatedManifest);
        // The source this update ran from, not the manifest's own record.
        const { recordInstallSource } = await import('./versionManifest.js');
        await recordInstallSource(targetRepo, sourcePath);
    } catch (err) {
        warn(`Could not update version manifest: ${err.message}`);
    }

    return {
        skippedNoManifest: false,
        updatedSkills,
        changedSkills,
        pyprojectRegenerated,
        statusResetsApplied: statusResetCount,
        baselineCreated,
    };
}
