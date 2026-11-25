// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Source Changes Module
 *
 * Tells which skills, or other files from the LaunchBridge clone, have changes
 * the clone has not committed, so that `launchbridge update` never records them
 * as a global install's baseline: the global record is the only one its
 * integrity check has.
 *
 * A skill has such changes when a file in its folder is modified, added,
 * deleted, untracked or ignored (the content hash covers ignored files too,
 * except the ones it skips itself: `.DS_Store`, `__pycache__/`, `*.pyc` and
 * `.git`), when git is told not to check one of its files (assume-unchanged or
 * skip-worktree), when its folder is a link to a folder outside the clone, or
 * when the submodule holding it is checked out at another commit than the one
 * the clone records for it. A folder elsewhere in the clone that a skill links
 * to (evaluate-predictions' lib/metric-library) is hashed with the skill, so it
 * is checked the same way.
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { isPathWithin } from './pathSanitizer.js';

/** How long one git command may run. */
const GIT_TIMEOUT_MS = 30000;

/** What the content hash skips (contentHash.js); keep the two in step. */
const UNHASHED_NAMES = new Set(['.DS_Store', '__pycache__', '.git']);

// Variables that would point git at some other repository than the one -C
// names (for example when launchbridge runs inside a git hook).
const REPO_SELECTING_GIT_VARS = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
];

function gitEnv() {
    const env = { ...process.env };
    for (const name of REPO_SELECTING_GIT_VARS) {
        delete env[name];
    }
    env.GIT_TERMINAL_PROMPT = '0';
    // git status would otherwise refresh the clone's index, a write.
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_LITERAL_PATHSPECS = '1';
    return env;
}

// Settings with which git status could pass over a changed file.
const GIT_CONFIG = [
    'core.fsmonitor=false',
    'core.untrackedCache=false',
    'core.ignoreStat=false',
    'core.checkStat=default',
    'core.trustctime=true',
];

/**
 * Runs git with an argument list (no shell), with a time limit, in the folder
 * the arguments name with `-C`.
 *
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runGit(args) {
    return new Promise((resolve) => {
        // A fixed argument list with no shell, run in LaunchBridge's own clone.
        // It also runs from there, not from the folder launchbridge was started
        // in: Windows looks for git.exe in the current folder before PATH.
        // nosemgrep: detect-child-process
        const proc = spawn(
            'git',
            [...GIT_CONFIG.flatMap((setting) => ['-c', setting]), ...args],
            {
                cwd: args[0] === '-C' ? args[1] : undefined,
                env: gitEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: GIT_TIMEOUT_MS,
                windowsHide: true,
            }
        );
        const stdout = [];
        let stderr = '';
        proc.stdout.on('data', (data) => {
            stdout.push(data);
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.on('close', (code) => {
            resolve({
                code: code ?? 1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr,
            });
        });
        proc.on('error', (err) => {
            resolve({ code: 1, stdout: '', stderr: err.message });
        });
    });
}

function isUnhashed(name) {
    return UNHASHED_NAMES.has(name) || name.endsWith('.pyc');
}

/** A POSIX relative path the content hash skips, by any of its parts. */
function isUnhashedPath(relPath) {
    return relPath.split('/').some((part) => part && isUnhashed(part));
}

function toPosix(relPath) {
    return relPath.split(path.sep).join('/');
}

/**
 * The real path of `p`; for a path that is gone, that of its nearest folder
 * that is there, followed by the rest of `p`.
 */
async function realPathOf(p) {
    const resolved = path.resolve(p);
    try {
        return await fs.realpath(resolved);
    } catch {
        const parent = path.dirname(resolved);
        if (parent === resolved) return resolved;
        return path.join(await realPathOf(parent), path.basename(resolved));
    }
}

/**
 * Whether a folder git reports as a whole (ignored, or a repository of its
 * own) holds anything the content hash would cover.
 */
async function holdsHashedFiles(dir) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return true;
    }
    for (const entry of entries) {
        if (isUnhashed(entry.name)) continue;
        if (!entry.isDirectory()) return true;
        if (await holdsHashedFiles(path.join(dir, entry.name))) return true;
    }
    return false;
}

/**
 * The real paths, inside `root` and outside the skill folder, that links in
 * the skill folder lead to, walked as the content hash walks them.
 */
async function linkedPaths(skillDir, root) {
    const found = new Set();
    const visited = new Set();
    const walk = async (dir) => {
        if (visited.has(dir)) return;
        visited.add(dir);
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (isUnhashed(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isSymbolicLink()) {
                let target;
                try {
                    target = await fs.realpath(full);
                } catch {
                    continue;
                }
                if (!isPathWithin(target, root)) continue;
                if (!isPathWithin(target, skillDir)) found.add(target);
                const stats = await fs.stat(target).catch(() => null);
                if (stats?.isDirectory()) await walk(target);
            }
        }
    };
    await walk(skillDir);
    return [...found];
}

/**
 * The paths `git status --porcelain=v1 -z` reports, relative to the work
 * tree; a folder reported as a whole ends with `/`. A rename reports the path
 * it was renamed from too.
 */
function parseStatus(output) {
    const fields = output.split('\0');
    const paths = [];
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (field.length < 4) continue;
        paths.push(field.slice(3));
        if (field[0] === 'R' || field[0] === 'C') {
            i++;
            if (field[0] === 'R' && fields[i]) paths.push(fields[i]);
        }
    }
    return paths;
}

/** Whether a status path is under a pathspec, or is a folder holding it. */
function covers(spec, reported) {
    return (
        spec === '.' ||
        reported === spec ||
        reported.startsWith(`${spec}/`) ||
        (reported.endsWith('/') && spec.startsWith(reported))
    );
}

/**
 * @typedef {Object} CheckedSkill
 * @property {string} name
 * @property {string} path - The skill's folder (or a file), in the clone or in
 *   a submodule of it
 */

/**
 * The skills with changes the LaunchBridge clone has not committed, and the
 * paths that changed.
 *
 * @param {string} sourcePath - The LaunchBridge clone
 * @param {CheckedSkill[]} skills
 * @param {{ git?: (args: string[]) => Promise<{ code: number, stdout: string, stderr: string }> }} [options]
 *   `git` runs git with an argument list (default: git itself, with no shell,
 *   the settings that could hide a change overridden, and a time limit)
 * @returns {Promise<Map<string, string[]> | null>} Each skill that has such
 *   changes, with its changed paths relative to the clone (POSIX, sorted; a
 *   folder ends with `/`, and a path git can't account for, such as a
 *   submodule checked out at another commit, comes with a note saying why).
 *   Null when the source is not a git clone (it has no `.git`), so it has
 *   nothing it has not committed.
 * @throws {Error} When git can't tell: git is missing or fails, or the source
 *   is not the top of its work tree
 */
export async function uncommittedSkillChanges(
    sourcePath,
    skills,
    { git = runGit } = {}
) {
    if (skills.length === 0) return new Map();
    try {
        await fs.lstat(path.join(sourcePath, '.git'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    return findChanges(sourcePath, skills, git);
}

async function findChanges(sourcePath, skills, git) {
    const output = async (args) => {
        const result = await git(args);
        if (result.code !== 0) {
            throw new Error(result.stderr.trim() || `git ${args[2]} failed`);
        }
        return result.stdout;
    };
    const isWorkTreeTop = async (dir) => {
        const result = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
        if (result.code !== 0) return false;
        const top = await fs.realpath(result.stdout.trim()).catch(() => null);
        return top === dir;
    };

    const root = await fs.realpath(sourcePath);
    const top = (
        await output(['-C', root, 'rev-parse', '--show-toplevel'])
    ).trim();
    if ((await fs.realpath(top).catch(() => null)) !== root) {
        throw new Error(
            `${sourcePath} is not the top of its git work tree (${top} is)`
        );
    }

    // A work tree: the clone, or a submodule (`rel` from its parent's root).
    const clone = { root, rel: '', parent: null, gitlinks: null };
    const submodules = new Map();
    const gitlinksOf = async (tree) => {
        if (!tree.gitlinks) {
            const listed = await output([
                '-C',
                tree.root,
                'ls-files',
                '-z',
                '--stage',
            ]);
            const links = [];
            for (const line of listed.split('\0')) {
                const tab = line.indexOf('\t');
                if (tab < 0 || !line.startsWith('160000 ')) continue;
                const rel = line.slice(tab + 1);
                const abs = await fs
                    .realpath(path.join(tree.root, ...rel.split('/')))
                    .catch(() => null);
                if (abs && !links.some((link) => link.abs === abs)) {
                    links.push({ rel, abs });
                }
            }
            tree.gitlinks = links;
        }
        return tree.gitlinks;
    };
    const treeFor = async (abs) => {
        let tree = clone;
        for (;;) {
            const link = (await gitlinksOf(tree)).find((g) =>
                isPathWithin(abs, g.abs)
            );
            if (!link) return tree;
            if (!submodules.has(link.abs)) {
                submodules.set(
                    link.abs,
                    (await isWorkTreeTop(link.abs))
                        ? {
                              root: link.abs,
                              rel: link.rel,
                              parent: tree,
                              gitlinks: null,
                          }
                        : null
                );
            }
            const sub = submodules.get(link.abs);
            if (!sub) return tree;
            tree = sub;
        }
    };
    const fromClone = (tree) => toPosix(path.relative(root, tree.root));
    const shown = (tree, rel) =>
        tree === clone ? rel : `${fromClone(tree)}/${rel}`;

    /** @type {Map<string, Set<string>>} */
    const changes = new Map();
    const add = (name, changedPath) => {
        if (!changes.has(name)) changes.set(name, new Set());
        changes.get(name).add(changedPath);
    };

    // Each skill's folder as it is named in the clone (a link there is a
    // change of its own) and as it resolves, with the folders it links to.
    /** @type {Array<{ name: string, tree: object, spec: string }>} */
    const checks = [];
    for (const skill of skills) {
        const rel = path.relative(
            path.resolve(sourcePath),
            path.resolve(skill.path)
        );
        const named = path.join(root, rel);
        const checked = new Set();
        if (isPathWithin(named, root)) checked.add(named);
        const real = await realPathOf(skill.path);
        if (isPathWithin(real, root)) {
            checked.add(real);
            for (const linked of await linkedPaths(real, root)) {
                checked.add(linked);
            }
        } else {
            add(
                skill.name,
                `${checked.size > 0 ? toPosix(rel) : skill.path} (links outside the LaunchBridge clone)`
            );
        }
        for (const abs of checked) {
            const tree = await treeFor(abs);
            const spec = toPosix(path.relative(tree.root, abs)) || '.';
            checks.push({ name: skill.name, tree, spec });
        }
    }

    for (const tree of new Set(checks.map((c) => c.tree))) {
        const here = checks.filter((c) => c.tree === tree);
        const specs = [...new Set(here.map((c) => c.spec))];
        const status = await output([
            '-C',
            tree.root,
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignored=matching',
            '--ignore-submodules=none',
            '--',
            ...specs,
        ]);
        for (const reported of parseStatus(status)) {
            if (isUnhashedPath(reported)) continue;
            if (
                reported.endsWith('/') &&
                !(await holdsHashedFiles(
                    path.join(tree.root, ...reported.split('/'))
                ))
            ) {
                continue;
            }
            for (const check of here) {
                if (covers(check.spec, reported)) {
                    add(check.name, shown(tree, reported));
                }
            }
        }

        // git status passes over a file it is told not to check: tagged in
        // lower case (assume-unchanged) or S (skip-worktree).
        const listed = await output([
            '-C',
            tree.root,
            'ls-files',
            '-v',
            '-z',
            '--',
            ...specs,
        ]);
        for (const entry of listed.split('\0')) {
            const tag = entry[0];
            const file = entry.slice(2);
            if (!file || isUnhashedPath(file)) continue;
            if (tag !== 'S' && !(tag >= 'a' && tag <= 'z')) continue;
            for (const check of here) {
                if (covers(check.spec, file)) {
                    add(
                        check.name,
                        `${shown(tree, file)} (marked assume-unchanged or skip-worktree, so git does not check it)`
                    );
                }
            }
        }
    }

    // A submodule at another commit than its parent records changes every
    // skill in it, and in the submodules inside it.
    const differs = new Map();
    const commitDiffers = async (tree) => {
        if (!differs.has(tree)) {
            const [head, recorded] = await Promise.all([
                git([
                    '-C',
                    tree.root,
                    'rev-parse',
                    '--verify',
                    '--quiet',
                    'HEAD',
                ]),
                git([
                    '-C',
                    tree.parent.root,
                    'rev-parse',
                    '--verify',
                    '--quiet',
                    `HEAD:${tree.rel}`,
                ]),
            ]);
            differs.set(
                tree,
                head.code !== 0 ||
                    recorded.code !== 0 ||
                    head.stdout.trim() !== recorded.stdout.trim()
            );
        }
        return differs.get(tree);
    };
    for (const check of checks) {
        for (let tree = check.tree; tree.parent; tree = tree.parent) {
            if (await commitDiffers(tree)) {
                add(
                    check.name,
                    `${fromClone(tree)} (checked out at a different commit than the clone records)`
                );
            }
        }
    }

    return new Map(
        [...changes].map(([name, paths]) => [name, [...paths].sort()])
    );
}
