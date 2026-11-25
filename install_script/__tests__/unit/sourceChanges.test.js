// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * `launchbridge update` must not record a global install's digests from
 * changes the LaunchBridge clone has not committed, so it asks which skills
 * have any. Each test builds a clone in a temporary folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { uncommittedSkillChanges } from '../../lib/sourceChanges.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

function git(cwd, ...args) {
    const result = spawnSync(
        'git',
        [
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@example.invalid',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'protocol.file.allow=always',
            ...args,
        ],
        { cwd, encoding: 'utf-8' }
    );
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

function write(root, rel, text) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/** Runs git as the module would, for a stand-in that fails some calls. */
async function realGit(args) {
    const result = spawnSync('git', args, { encoding: 'utf-8' });
    return {
        code: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

describe.skipIf(!hasGit || process.platform === 'win32')(
    'uncommittedSkillChanges',
    () => {
        let root;
        let clone;
        beforeEach(() => {
            root = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), 'lb-srcchg-'))
            );
            clone = path.join(root, 'clone');
            write(clone, 'skills/alpha/SKILL.md', '# alpha\n');
            write(clone, 'skills/alpha/scripts/run.py', 'print(1)\n');
            write(clone, 'skills/beta/SKILL.md', '# beta\n');
            write(clone, '.gitignore', 'build/\n__pycache__/\n*.pyc\n');
            git(root, 'init', '-q', '-b', 'main', clone);
            git(clone, 'add', '-A');
            git(clone, 'commit', '-q', '-m', 'initial');
        });
        afterEach(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        const skills = () => [
            { name: 'alpha', path: path.join(clone, 'skills', 'alpha') },
            { name: 'beta', path: path.join(clone, 'skills', 'beta') },
        ];

        it('finds nothing in a clean clone', async () => {
            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map()
            );
        });

        it('finds modified, deleted, untracked and ignored files, by skill', async () => {
            fs.appendFileSync(
                path.join(clone, 'skills', 'alpha', 'SKILL.md'),
                'An edit.\n'
            );
            fs.rmSync(path.join(clone, 'skills', 'alpha', 'scripts', 'run.py'));
            write(clone, 'skills/alpha/notes/new.md', 'untracked\n');
            write(
                clone,
                'skills/beta/build/out.txt',
                'ignored, still hashed\n'
            );

            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map([
                    [
                        'alpha',
                        [
                            'skills/alpha/SKILL.md',
                            'skills/alpha/notes/new.md',
                            'skills/alpha/scripts/run.py',
                        ],
                    ],
                    ['beta', ['skills/beta/build/']],
                ])
            );
        });

        it('counts a change that is staged but not committed', async () => {
            write(clone, 'skills/beta/SKILL.md', '# beta, staged\n');
            git(clone, 'add', '-A');

            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map([['beta', ['skills/beta/SKILL.md']]])
            );
        });

        it('does not count what the content hash skips', async () => {
            write(
                clone,
                'skills/alpha/scripts/__pycache__/run.cpython-312.pyc',
                'x'
            );
            write(clone, 'skills/alpha/scripts/stale.pyc', 'x');
            write(clone, 'skills/alpha/.DS_Store', 'x');
            // An ignored folder holding nothing the hash covers.
            write(
                clone,
                'skills/beta/build/__pycache__/x.cpython-312.pyc',
                'x'
            );

            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map()
            );
        });

        it('checks a folder a skill links to elsewhere in the clone', async () => {
            write(clone, 'shared/lib/util.py', 'x = 1\n');
            fs.symlinkSync(
                path.join('..', '..', 'shared', 'lib'),
                path.join(clone, 'skills', 'alpha', 'lib')
            );
            git(clone, 'add', '-A');
            git(clone, 'commit', '-q', '-m', 'link');
            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map()
            );

            fs.appendFileSync(
                path.join(clone, 'shared', 'lib', 'util.py'),
                'y\n'
            );

            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map([['alpha', ['shared/lib/util.py']]])
            );
        });

        it('finds changes in a submodule, and every skill of a submodule at another commit', async () => {
            const lib = path.join(root, 'lib');
            write(lib, 'skills/research/ai-plan/SKILL.md', '# plan\n');
            write(lib, 'skills/research/ai-create/SKILL.md', '# create\n');
            git(root, 'init', '-q', '-b', 'main', lib);
            git(lib, 'add', '-A');
            git(lib, 'commit', '-q', '-m', 'lib');
            git(
                clone,
                'submodule',
                'add',
                '-q',
                lib,
                'project_dependencies/ai-skills'
            );
            git(clone, 'commit', '-q', '-m', 'submodule');
            const sub = path.join(clone, 'project_dependencies', 'ai-skills');
            const ai = ['ai-plan', 'ai-create'].map((name) => ({
                name,
                path: path.join(sub, 'skills', 'research', name),
            }));
            expect(await uncommittedSkillChanges(clone, ai)).toEqual(new Map());

            fs.appendFileSync(
                path.join(sub, 'skills', 'research', 'ai-plan', 'SKILL.md'),
                'An edit.\n'
            );
            expect(await uncommittedSkillChanges(clone, ai)).toEqual(
                new Map([
                    [
                        'ai-plan',
                        [
                            'project_dependencies/ai-skills/skills/research/ai-plan/SKILL.md',
                        ],
                    ],
                ])
            );

            // Committed in the submodule, but not recorded by the clone.
            git(sub, 'commit', '-q', '-am', 'ahead');
            const note =
                'project_dependencies/ai-skills (checked out at a different commit than the clone records)';
            expect(await uncommittedSkillChanges(clone, ai)).toEqual(
                new Map([
                    ['ai-plan', [note]],
                    ['ai-create', [note]],
                ])
            );

            git(clone, 'commit', '-q', '-am', 'record the submodule');
            expect(await uncommittedSkillChanges(clone, ai)).toEqual(new Map());
        });

        it('has nothing to tell for a source that is not a git clone', async () => {
            const plain = path.join(root, 'plain');
            fs.cpSync(path.join(clone, 'skills'), path.join(plain, 'skills'), {
                recursive: true,
            });
            const inPlain = [
                { name: 'alpha', path: path.join(plain, 'skills', 'alpha') },
            ];
            expect(await uncommittedSkillChanges(plain, inPlain)).toBeNull();

            const inside = path.join(clone, 'skills');
            expect(await uncommittedSkillChanges(inside, skills())).toBeNull();
        });

        it('throws when git can’t tell: a clone git can’t read, git missing, or git failing', async () => {
            const broken = path.join(root, 'broken');
            fs.cpSync(path.join(clone, 'skills'), path.join(broken, 'skills'), {
                recursive: true,
            });
            fs.writeFileSync(path.join(broken, '.git'), 'gitdir: nowhere\n');
            await expect(
                uncommittedSkillChanges(broken, [
                    {
                        name: 'alpha',
                        path: path.join(broken, 'skills', 'alpha'),
                    },
                ])
            ).rejects.toThrow();

            const missing = async () => ({
                code: 1,
                stdout: '',
                stderr: 'spawn git ENOENT',
            });
            await expect(
                uncommittedSkillChanges(clone, skills(), { git: missing })
            ).rejects.toThrow('spawn git ENOENT');

            const statusFails = async (args) =>
                args.includes('status')
                    ? { code: 128, stdout: '', stderr: 'fatal: bad index' }
                    : realGit(args);
            await expect(
                uncommittedSkillChanges(clone, skills(), {
                    git: statusFails,
                })
            ).rejects.toThrow('fatal: bad index');
        });

        it('counts a file git is told not to check', async () => {
            git(
                clone,
                'update-index',
                '--assume-unchanged',
                'skills/alpha/SKILL.md'
            );
            git(
                clone,
                'update-index',
                '--skip-worktree',
                'skills/beta/SKILL.md'
            );
            fs.appendFileSync(
                path.join(clone, 'skills', 'alpha', 'SKILL.md'),
                'An edit git status does not show.\n'
            );
            expect(git(clone, 'status', '--porcelain')).toBe('');

            const note =
                '(marked assume-unchanged or skip-worktree, so git does not check it)';
            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map([
                    ['alpha', [`skills/alpha/SKILL.md ${note}`]],
                    ['beta', [`skills/beta/SKILL.md ${note}`]],
                ])
            );
        });

        it('counts a skill folder that is a link, and still checks the other skills', async () => {
            const outside = path.join(root, 'outside', 'beta');
            fs.cpSync(path.join(clone, 'skills', 'beta'), outside, {
                recursive: true,
            });
            fs.rmSync(path.join(clone, 'skills', 'beta'), { recursive: true });
            fs.symlinkSync(outside, path.join(clone, 'skills', 'beta'));
            fs.appendFileSync(
                path.join(clone, 'skills', 'alpha', 'SKILL.md'),
                'An edit.\n'
            );

            expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                new Map([
                    ['alpha', ['skills/alpha/SKILL.md']],
                    [
                        'beta',
                        [
                            'skills/beta',
                            'skills/beta (links outside the LaunchBridge clone)',
                            'skills/beta/SKILL.md',
                        ],
                    ],
                ])
            );

            // A link to a skill folder in the clone that has no changes.
            fs.unlinkSync(path.join(clone, 'skills', 'beta'));
            fs.symlinkSync('alpha', path.join(clone, 'skills', 'beta'));
            git(clone, 'checkout', '--', 'skills/alpha');
            expect(
                (await uncommittedSkillChanges(clone, skills())).get('beta')
            ).toEqual(['skills/beta', 'skills/beta/SKILL.md']);
        });

        it('checks a file, and counts one that is gone', async () => {
            const file = [
                {
                    name: 'skills/alpha/scripts/run.py',
                    path: path.join(
                        clone,
                        'skills',
                        'alpha',
                        'scripts',
                        'run.py'
                    ),
                },
            ];
            expect(await uncommittedSkillChanges(clone, file)).toEqual(
                new Map()
            );
            fs.rmSync(path.join(clone, 'skills', 'alpha', 'scripts'), {
                recursive: true,
            });

            expect(await uncommittedSkillChanges(clone, file)).toEqual(
                new Map([
                    [
                        'skills/alpha/scripts/run.py',
                        ['skills/alpha/scripts/run.py'],
                    ],
                ])
            );
        });

        it('runs git from the clone, not from the folder it was started in', async () => {
            const realGitPath = spawnSync('sh', ['-c', 'command -v git'], {
                encoding: 'utf-8',
            }).stdout.trim();
            const bin = path.join(root, 'bin');
            const marker = path.join(root, 'where-git-ran');
            fs.mkdirSync(bin);
            fs.writeFileSync(
                path.join(bin, 'git'),
                `#!/bin/sh\npwd -P >> "${marker}"\nexec "${realGitPath}" "$@"\n`,
                { mode: 0o755 }
            );
            const savedPath = process.env.PATH;
            process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
            try {
                expect(await uncommittedSkillChanges(clone, skills())).toEqual(
                    new Map()
                );
            } finally {
                process.env.PATH = savedPath;
            }

            const ran = fs.readFileSync(marker, 'utf8').trim().split('\n');
            expect(ran.length).toBeGreaterThan(0);
            expect(new Set(ran)).toEqual(new Set([clone]));
        });

        it('runs no git for no skills', async () => {
            const never = async () => {
                throw new Error('git should not run');
            };
            expect(
                await uncommittedSkillChanges(clone, [], { git: never })
            ).toEqual(new Map());
        });
    }
);
