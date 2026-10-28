// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for the AI Skills module (public sample-ai-skills layout:
 * project_dependencies/ai-skills/skills/<domain>/<skill>/SKILL.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { computeContentHash } from '../../lib/contentHash.js';
import { copySkill } from '../../lib/installer.js';
import * as aiSkillsModule from '../../lib/aiSkills.js';
import {
    AI_GROUP_PREFIX,
    AI_DOMAIN_LABELS,
    AI_DOMAIN_DESCRIPTIONS,
    AI_DOMAIN_COMPANIONS,
    getAiSkillGroup,
    isAiSkill,
    aiTrackingKey,
    discoverAiSkills,
    buildAiCategories,
    toManifestKeys,
    expandManifestKeys,
    computeAiGroupHashes,
    computeAiSkillFolderHashes,
    updateAiSkills,
    buildAiStatusRows,
    writeAgentFiles,
    EXCLUDED_AI_DOMAINS,
} from '../../lib/aiSkills.js';

/**
 * Discovery with no domain excluded. These tests exercise discovery across
 * several domains with the upstream layout; the default exclusion is tested
 * on its own below.
 */
function discoverAll(dir, options = {}) {
    return discoverAiSkills(dir, { excludedDomains: new Set(), ...options });
}

/** Root of the fake submodule's skills tree under a source root. */
function skillsRoot(root) {
    return path.join(root, 'project_dependencies', 'ai-skills', 'skills');
}

/** A SKILL.md with the frontmatter every ai-skills skill has, plus `fields`. */
function skillMd(name, fields = '') {
    return `---\nname: ${name}\ndescription: "${name} test skill"\n${fields}---\n# ${name}\n`;
}

/** Creates `skills/<domain>/<name>/SKILL.md` in the fake submodule. */
function makeSkill(root, domain, name, body = skillMd(name)) {
    const dir = path.join(skillsRoot(root), domain, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
    return dir;
}

/**
 * Builds a fake ai-skills submodule. `layout` maps domain → skill names.
 * Returns the skills root.
 */
function scaffoldSubmodule(root, layout) {
    fs.mkdirSync(skillsRoot(root), { recursive: true });
    for (const [domain, names] of Object.entries(layout)) {
        for (const name of names) makeSkill(root, domain, name);
    }
    return skillsRoot(root);
}

/** The upstream research domain and the release domain LaunchBridge excludes. */
const UPSTREAM_LAYOUT = {
    research: [
        'ai-create',
        'ai-research',
        'ai-plan',
        'ai-implement',
        'ai-archive',
    ],
    release: ['ai-scaffold-release'],
};

/** Collects warnings emitted by discovery. */
function warnSink() {
    const messages = [];
    return { messages, onWarn: (msg) => messages.push(msg) };
}

describe('aiSkills', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-skills-'));
    });
    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('module exports', () => {
        it('has no ai-init core, implicit auto-add or prefix exceptions', () => {
            expect(aiSkillsModule).not.toHaveProperty('addAiCoreIfSelected');
            expect(aiSkillsModule).not.toHaveProperty('AI_INIT_SKILL');
            expect(aiSkillsModule).not.toHaveProperty(
                'NATIVE_AI_PREFIX_EXCEPTIONS'
            );
            expect(aiSkillsModule).not.toHaveProperty('AI_CORE_GROUP');
            expect(aiSkillsModule).not.toHaveProperty('aiSkillSourceForAgent');
            expect(aiSkillsModule).not.toHaveProperty('aiSkillsSourceDir');
        });

        it('uses the ai-domain- group prefix', () => {
            expect(AI_GROUP_PREFIX).toBe('ai-domain-');
            expect(AI_DOMAIN_COMPANIONS).toEqual({
                research: ['ai-workflow'],
            });
        });
    });

    describe('discoverAiSkills', () => {
        it('returns [] with no warning when the submodule is missing', () => {
            const sink = warnSink();
            expect(discoverAll(tempDir, { onWarn: sink.onWarn })).toEqual([]);
            expect(sink.messages).toEqual([]);
        });

        it('works with no options', () => {
            scaffoldSubmodule(tempDir, { research: ['ai-plan'] });
            const skills = discoverAll(tempDir);
            expect(skills.map((s) => s.name)).toEqual(['ai-plan']);
        });

        it('discovers skills/<domain>/<skill> with domain group ids, sorted by name', () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const skills = discoverAll(tempDir);

            expect(skills.map((s) => s.name)).toEqual([
                'ai-archive',
                'ai-create',
                'ai-implement',
                'ai-plan',
                'ai-research',
                'ai-scaffold-release',
            ]);
            const plan = skills.find((s) => s.name === 'ai-plan');
            expect(plan).toMatchObject({
                name: 'ai-plan',
                domain: 'research',
                group: 'ai-domain-research',
                isAiSkill: true,
                path: path.join(skillsRoot(tempDir), 'research', 'ai-plan'),
                hasReferences: false,
                hasScripts: false,
            });
            const release = skills.find(
                (s) => s.name === 'ai-scaffold-release'
            );
            expect(release.group).toBe('ai-domain-release');
        });

        it('reports references/ and scripts/ presence', () => {
            const dir = makeSkill(tempDir, 'release', 'ai-scaffold-release');
            fs.mkdirSync(path.join(dir, 'references'));
            fs.mkdirSync(path.join(dir, 'scripts'));
            const [skill] = discoverAll(tempDir);
            expect(skill.hasReferences).toBe(true);
            expect(skill.hasScripts).toBe(true);
        });

        it('skips dot entries and references/ at both levels', () => {
            const root = scaffoldSubmodule(tempDir, { research: ['ai-plan'] });
            // upstream CI allowlist file and a dot dir at domain level
            fs.writeFileSync(path.join(root, '.network-prose-baseline'), 'x');
            makeSkill(tempDir, '.hidden', 'ai-hidden');
            // shared references dir at domain level (looks like a domain)
            makeSkill(tempDir, 'references', 'ai-not-a-skill');
            // shared references dir at skill level with a SKILL.md
            makeSkill(tempDir, 'research', 'references');
            // dot dir at skill level
            makeSkill(tempDir, 'research', '.draft');

            const sink = warnSink();
            const names = discoverAll(tempDir, {
                onWarn: sink.onWarn,
            }).map((s) => s.name);
            expect(names).toEqual(['ai-plan']);
            expect(sink.messages).toEqual([]);
        });

        it('skips dirs without SKILL.md and does not scan deeper nesting', () => {
            scaffoldSubmodule(tempDir, { research: ['ai-plan'] });
            fs.mkdirSync(
                path.join(skillsRoot(tempDir), 'research', 'ai-empty')
            );
            // nested skill inside a non-skill dir
            const nested = path.join(
                skillsRoot(tempDir),
                'research',
                'group',
                'ai-nested'
            );
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(nested, 'SKILL.md'), '# nested');
            // SKILL.md that is a directory, not a file
            fs.mkdirSync(
                path.join(
                    skillsRoot(tempDir),
                    'research',
                    'ai-bad',
                    'SKILL.md'
                ),
                { recursive: true }
            );

            const names = discoverAll(tempDir).map((s) => s.name);
            expect(names).toEqual(['ai-plan']);
        });

        it('skips non-directory entries silently', () => {
            const root = scaffoldSubmodule(tempDir, { research: ['ai-plan'] });
            fs.writeFileSync(path.join(root, 'README.md'), '# readme');
            fs.writeFileSync(path.join(root, 'research', 'notes.md'), 'x');
            const sink = warnSink();
            expect(
                discoverAll(tempDir, { onWarn: sink.onWarn }).map((s) => s.name)
            ).toEqual(['ai-plan']);
            expect(sink.messages).toEqual([]);
        });

        it('warns and skips invalid domain and skill names', () => {
            scaffoldSubmodule(tempDir, { research: ['ai-plan'] });
            makeSkill(tempDir, 'Bad_Domain', 'ai-x');
            makeSkill(tempDir, 'research', 'Ai_Plan');
            makeSkill(tempDir, 'research', '-leading');

            const sink = warnSink();
            const names = discoverAll(tempDir, {
                onWarn: sink.onWarn,
            }).map((s) => s.name);
            expect(names).toEqual(['ai-plan']);
            expect(sink.messages).toHaveLength(3);
            expect(sink.messages.join('\n')).toContain('"Bad_Domain"');
            expect(sink.messages.join('\n')).toContain('"Ai_Plan"');
            expect(sink.messages.join('\n')).toContain('"-leading"');
        });

        it('accepts a symlinked skill directory', () => {
            scaffoldSubmodule(tempDir, { research: ['ai-plan'] });
            const external = fs.mkdtempSync(
                path.join(os.tmpdir(), 'ai-linked-')
            );
            try {
                fs.writeFileSync(
                    path.join(external, 'SKILL.md'),
                    skillMd('ai-linked')
                );
                fs.symlinkSync(
                    external,
                    path.join(skillsRoot(tempDir), 'research', 'ai-linked')
                );
                const names = discoverAll(tempDir).map((s) => s.name);
                expect(names).toEqual(['ai-linked', 'ai-plan']);
            } finally {
                fs.rmSync(external, { recursive: true, force: true });
            }
        });

        it('skips a broken symlink', () => {
            scaffoldSubmodule(tempDir, { research: ['ai-plan'] });
            fs.symlinkSync(
                path.join(tempDir, 'does-not-exist'),
                path.join(skillsRoot(tempDir), 'research', 'ai-broken')
            );
            expect(discoverAll(tempDir).map((s) => s.name)).toEqual([
                'ai-plan',
            ]);
        });

        it('skips a native-name collision with the exact warning', () => {
            scaffoldSubmodule(tempDir, {
                research: ['ai-plan', 'ai-workflow'],
            });
            const sink = warnSink();
            const names = discoverAll(tempDir, {
                nativeNames: new Set(['ai-workflow', 'lb-setup']),
                onWarn: sink.onWarn,
            }).map((s) => s.name);
            expect(names).toEqual(['ai-plan']);
            expect(sink.messages).toEqual([
                'ai-skills: "ai-workflow" shadowed by native LaunchBridge skill; skipped',
            ]);
        });

        it('keeps the first domain in sorted order for a cross-domain duplicate', () => {
            scaffoldSubmodule(tempDir, {
                zeta: ['ai-shared'],
                alpha: ['ai-shared', 'ai-alpha'],
            });
            const sink = warnSink();
            const skills = discoverAll(tempDir, { onWarn: sink.onWarn });
            const shared = skills.find((s) => s.name === 'ai-shared');
            expect(shared.domain).toBe('alpha');
            expect(skills.filter((s) => s.name === 'ai-shared')).toHaveLength(
                1
            );
            expect(sink.messages).toHaveLength(1);
            expect(sink.messages[0]).toContain('"ai-shared"');
            expect(sink.messages[0]).toContain('"zeta"');
        });
    });

    describe('membership classification', () => {
        let list;
        beforeEach(() => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            list = discoverAll(tempDir);
        });

        it('classifies by membership in the discovered list', () => {
            expect(isAiSkill('ai-plan', list)).toBe(true);
            expect(getAiSkillGroup('ai-plan', list)).toBe('ai-domain-research');
            // native skills are never in the list, whatever their name
            expect(isAiSkill('ai-workflow', list)).toBe(false);
            expect(getAiSkillGroup('ai-workflow', list)).toBeNull();
            expect(isAiSkill('lb-setup', list)).toBe(false);
            expect(isAiSkill('ai-unknown', list)).toBe(false);
            // without a list nothing is external
            expect(isAiSkill('ai-plan', [])).toBe(false);
        });

        it('aiTrackingKey is ai-domain-<domain>, also for a single-skill domain', () => {
            expect(aiTrackingKey('ai-plan', list)).toBe('ai-domain-research');
            expect(aiTrackingKey('ai-scaffold-release', list)).toBe(
                'ai-domain-release'
            );
            expect(aiTrackingKey('lb-setup', list)).toBe('lb-setup');
        });
    });

    describe('buildAiCategories', () => {
        it('builds one category per domain with labels and descriptions', () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const cats = buildAiCategories(
                discoverAll(tempDir),
                new Set(['ai-workflow', 'lb-setup'])
            );
            expect(cats.map((c) => c.group)).toEqual([
                'ai-domain-release',
                'ai-domain-research',
            ]);

            const research = cats[1];
            expect(research.name).toBe(AI_DOMAIN_LABELS.research);
            expect(research.name).toBe('AI Spec-Driven Development');
            expect(research.description).toBe(AI_DOMAIN_DESCRIPTIONS.research);
            expect(research.ai).toBe(true);
            expect(research.individual).toBeUndefined();
            expect(research.skills).toEqual([
                'ai-archive',
                'ai-create',
                'ai-implement',
                'ai-plan',
                'ai-research',
                'ai-workflow',
            ]);

            // A domain with no label falls back to the generic one.
            const release = cats[0];
            expect(release.name).toBe('AI Skills: release');
            expect(release.description).toBe('ai-scaffold-release');
            expect(release.individual).toBe(true);
            // the orchestrator is never bundled with ai-scaffold-release
            expect(release.skills).toEqual(['ai-scaffold-release']);
        });

        it('every category group is ai-domain-<domain>', () => {
            scaffoldSubmodule(tempDir, {
                ...UPSTREAM_LAYOUT,
                docs: ['ai-outline', 'ai-draft'],
            });
            const list = discoverAll(tempDir);
            for (const cat of buildAiCategories(list)) {
                const domain = list.find(
                    (s) => s.name === cat.skills[0]
                ).domain;
                expect(cat.group).toBe(AI_GROUP_PREFIX + domain);
            }
        });

        it('appends the companion only when it is a native skill', () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const withoutNative = buildAiCategories(list);
            expect(withoutNative.flatMap((c) => c.skills)).not.toContain(
                'ai-workflow'
            );
            const withNative = buildAiCategories(
                list,
                new Set(['ai-workflow'])
            );
            expect(
                withNative.find((c) => c.group === 'ai-domain-research').skills
            ).toContain('ai-workflow');
        });

        it('uses a fallback label and a skill-name description for unknown domains', () => {
            scaffoldSubmodule(tempDir, { docs: ['ai-outline', 'ai-draft'] });
            const [cat] = buildAiCategories(discoverAll(tempDir));
            expect(cat.name).toBe('AI Skills: docs');
            expect(cat.description).toBe('ai-draft, ai-outline');
            expect(cat.group).toBe('ai-domain-docs');
            expect(cat.individual).toBeUndefined();
        });

        it('marks a single-skill unknown domain individual', () => {
            scaffoldSubmodule(tempDir, { tools: ['ai-tool'] });
            const [cat] = buildAiCategories(discoverAll(tempDir));
            expect(cat.individual).toBe(true);
            expect(cat.skills).toEqual(['ai-tool']);
        });

        it('returns [] when nothing is discovered', () => {
            expect(buildAiCategories([])).toEqual([]);
        });
    });

    describe('toManifestKeys / expandManifestKeys', () => {
        let list;
        beforeEach(() => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            list = discoverAll(tempDir);
        });

        it('collapses AI skills to domain keys and dedupes', () => {
            expect(
                toManifestKeys(
                    [
                        'lb-setup',
                        'ai-plan',
                        'ai-research',
                        'ai-workflow',
                        'ai-scaffold-release',
                    ],
                    list
                )
            ).toEqual([
                'lb-setup',
                'ai-domain-research',
                'ai-workflow',
                'ai-domain-release',
            ]);
        });

        it('selecting ai-plan yields only ai-domain-research (no ai-init)', () => {
            const keys = toManifestKeys(['ai-plan'], list);
            expect(keys).toEqual(['ai-domain-research']);
            expect(keys.join(' ')).not.toContain('ai-init');
        });

        it('round-trips through manifest keys', () => {
            const selected = ['ai-plan', 'ai-scaffold-release', 'lb-setup'];
            const keys = toManifestKeys(selected, list);
            expect(expandManifestKeys(keys, selected, list).sort()).toEqual(
                [...selected].sort()
            );
        });

        it('expands group keys to the prior installed names for the prompt pre-check', () => {
            // A partial install recorded only ai-plan and ai-research.
            const manifestKeys = [
                'lb-setup',
                'ai-workflow',
                'ai-domain-research',
            ];
            const priorNames = ['ai-plan', 'ai-research'];
            expect(expandManifestKeys(manifestKeys, priorNames, list)).toEqual([
                'lb-setup',
                'ai-workflow',
                'ai-plan',
                'ai-research',
            ]);
        });

        it('drops a group key with no matching selected skills', () => {
            expect(
                expandManifestKeys(
                    ['lb-setup', 'ai-domain-release'],
                    ['ai-plan'],
                    list
                )
            ).toEqual(['lb-setup']);
        });
    });

    describe('hashing', () => {
        it('keys one <agent>/<name> digest per agent, matching the copy that agent receives', async () => {
            const dir = makeSkill(
                tempDir,
                'research',
                'ai-plan',
                skillMd(
                    'ai-plan',
                    'disallowed-tools: "WebFetch"\ndisable-model-invocation: true\n'
                )
            );
            const list = discoverAll(tempDir);
            const agents = ['claude', 'kiro', 'codex', 'pi'];
            const hashes = await computeAiSkillFolderHashes(
                ['ai-plan', 'lb-setup'],
                list,
                agents
            );
            expect(Object.keys(hashes).sort()).toEqual([
                'claude/ai-plan',
                'codex/ai-plan',
                'kiro/ai-plan',
                'pi/ai-plan',
            ]);
            for (const agent of agents) {
                const installed = path.join(tempDir, 'installed', agent);
                fs.mkdirSync(path.dirname(installed), { recursive: true });
                await copySkill(dir, installed);
                await writeAgentFiles(list[0], agent, installed, agents);
                expect(hashes[`${agent}/ai-plan`]).toBe(
                    await computeContentHash(installed)
                );
            }
            // Claude Code gets the source folder; every other copy differs.
            expect(hashes['claude/ai-plan']).toBe(
                await computeContentHash(dir)
            );
            expect(new Set(Object.values(hashes)).size).toBe(agents.length);
        });

        it('produces one stable hash per selected domain', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const selected = ['ai-plan', 'ai-research', 'ai-scaffold-release'];
            const hashes = await computeAiGroupHashes(selected, list);
            expect(Object.keys(hashes).sort()).toEqual([
                'ai-domain-release',
                'ai-domain-research',
            ]);
            expect(await computeAiGroupHashes(selected, list)).toEqual(hashes);
        });

        it('changes the group hash and only the affected digests when a file changes', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const notes = path.join(
                skillsRoot(tempDir),
                'research',
                'ai-plan',
                'references',
                'notes.md'
            );
            fs.mkdirSync(path.dirname(notes));
            fs.writeFileSync(notes, 'before\n');
            const list = discoverAll(tempDir);
            const selected = ['ai-plan', 'ai-research'];
            const agents = ['claude', 'kiro'];
            const beforeGroup = await computeAiGroupHashes(selected, list);
            const beforeDigests = await computeAiSkillFolderHashes(
                selected,
                list,
                agents
            );

            fs.writeFileSync(notes, 'after\n');
            const afterGroup = await computeAiGroupHashes(selected, list);
            const afterDigests = await computeAiSkillFolderHashes(
                selected,
                list,
                agents
            );
            expect(afterGroup['ai-domain-research']).not.toBe(
                beforeGroup['ai-domain-research']
            );
            for (const agent of agents) {
                expect(afterDigests[`${agent}/ai-plan`]).not.toBe(
                    beforeDigests[`${agent}/ai-plan`]
                );
                expect(afterDigests[`${agent}/ai-research`]).toBe(
                    beforeDigests[`${agent}/ai-research`]
                );
            }
        });

        it('returns empty for a selection with no external skills', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            expect(
                await computeAiSkillFolderHashes(
                    ['lb-setup', 'ai-workflow'],
                    list,
                    ['kiro']
                )
            ).toEqual({});
            expect(
                await computeAiGroupHashes(['lb-setup', 'ai-workflow'], list)
            ).toEqual({});
        });
    });

    describe('buildAiStatusRows', () => {
        it('emits one row per discovered domain, sorted by domain', () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            expect(buildAiStatusRows(new Map(), ['ai-plan'], list)).toEqual([
                { name: 'ai-domain-release', status: 'not installed' },
                { name: 'ai-domain-research', status: 'ready' },
            ]);
        });

        it('preserves an existing non-trivial status', () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const existing = new Map([
                ['ai-domain-research', 'customized'],
                ['ai-domain-release', 'not installed'],
            ]);
            expect(
                buildAiStatusRows(
                    existing,
                    ['ai-plan', 'ai-scaffold-release'],
                    list
                )
            ).toEqual([
                { name: 'ai-domain-release', status: 'ready' },
                { name: 'ai-domain-research', status: 'customized' },
            ]);
        });

        it('emits no rows when nothing is discovered', () => {
            expect(buildAiStatusRows(new Map(), ['ai-plan'], [])).toEqual([]);
        });
    });

    describe('updateAiSkills', () => {
        let targetRepo;
        beforeEach(() => {
            targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-upd-tgt-'));
        });
        afterEach(() => {
            fs.rmSync(targetRepo, { recursive: true, force: true });
        });

        const noopUi = { muted: () => {}, success: () => {}, warn: () => {} };

        /** Simulates a prior copy install of `names` into an agent's skills dir. */
        function seedInstalled(agentDir, names) {
            const base = path.join(targetRepo, agentDir, 'skills');
            for (const name of names) {
                const dir = path.join(base, name);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'SKILL.md'), 'OLD');
            }
            return base;
        }

        it('reinstalls only the skills of changed domains for copy installs, each with its agent’s SKILL.md', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const planDir = makeSkill(
                tempDir,
                'research',
                'ai-plan',
                skillMd(
                    'ai-plan',
                    'disallowed-tools: "WebFetch"\ndisable-model-invocation: true\n'
                )
            );
            const list = discoverAll(tempDir);
            const kiroBase = seedInstalled('.kiro', [
                'ai-plan',
                'ai-scaffold-release',
            ]);
            const claudeBase = seedInstalled('.claude', ['ai-plan']);
            const codexBase = seedInstalled('.codex', ['ai-plan']);
            // a native skill in the target is never treated as external
            seedInstalled('.kiro', ['ai-workflow']);

            const correct = await computeAiGroupHashes(
                ['ai-plan', 'ai-scaffold-release'],
                list
            );
            const manifest = {
                installMethod: 'copy',
                agents: ['kiro', 'claude', 'codex'],
                skillHashes: {
                    'ai-domain-research': 'STALE',
                    'ai-domain-release': correct['ai-domain-release'],
                },
            };

            const result = await updateAiSkills(
                tempDir,
                targetRepo,
                manifest,
                noopUi
            );

            expect(result.updated).toEqual(['ai-plan']);
            const plan = list.find((s) => s.name === 'ai-plan');
            expect(
                fs.readFileSync(path.join(claudeBase, 'ai-plan', 'SKILL.md'))
            ).toEqual(fs.readFileSync(path.join(planDir, 'SKILL.md')));
            for (const [base, agent] of [
                [kiroBase, 'kiro'],
                [codexBase, 'codex'],
            ]) {
                for (const [rel, bytes] of plan.variants.get(agent)) {
                    expect(
                        fs.readFileSync(path.join(base, 'ai-plan', rel))
                    ).toEqual(bytes);
                }
            }
            expect(
                fs.existsSync(
                    path.join(codexBase, 'ai-plan', 'agents', 'openai.yaml')
                )
            ).toBe(true);
            // ai-scaffold-release (release) is not offered, so an earlier
            // install of it is left as it is, not refreshed.
            expect(
                fs.readFileSync(
                    path.join(kiroBase, 'ai-scaffold-release', 'SKILL.md'),
                    'utf8'
                )
            ).toBe('OLD');
            expect(
                fs.readFileSync(
                    path.join(kiroBase, 'ai-workflow', 'SKILL.md'),
                    'utf8'
                )
            ).toBe('OLD');
            expect(Object.keys(result.newHashes).sort()).toEqual([
                'ai-domain-research',
            ]);
            expect(result.newFolderHashes).toEqual(
                await computeAiSkillFolderHashes(['ai-plan'], list, [
                    'kiro',
                    'claude',
                    'codex',
                ])
            );
        });

        it('skips an external skill shadowed by a native one and warns', async () => {
            scaffoldSubmodule(tempDir, { research: ['ai-plan', 'lb-setup'] });
            // native skill with the same name in the source root
            const nativeDir = path.join(tempDir, 'skills', 'lb-setup');
            fs.mkdirSync(nativeDir, { recursive: true });
            fs.writeFileSync(path.join(nativeDir, 'SKILL.md'), '# native');
            seedInstalled('.kiro', ['ai-plan', 'lb-setup']);

            const warnings = [];
            const result = await updateAiSkills(
                tempDir,
                targetRepo,
                {
                    installMethod: 'copy',
                    agents: ['kiro'],
                    skillHashes: { 'ai-domain-research': 'STALE' },
                },
                { ...noopUi, warn: (m) => warnings.push(m) }
            );
            expect(result.updated).toEqual(['ai-plan']);
            expect(Object.keys(result.newFolderHashes)).toEqual([
                'kiro/ai-plan',
            ]);
            expect(warnings).toContain(
                'ai-skills: "lb-setup" shadowed by native LaunchBridge skill; skipped'
            );
        });

        it('re-links changed skills for symlink installs, with a real adapted SKILL.md for every agent but Claude Code', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const planDir = makeSkill(
                tempDir,
                'research',
                'ai-plan',
                skillMd('ai-plan', 'disallowed-tools: "WebFetch"\n')
            );
            fs.mkdirSync(path.join(planDir, 'references'));
            fs.writeFileSync(
                path.join(planDir, 'references', 'added.md'),
                'added upstream\n'
            );
            const sourceSkillMd = fs.readFileSync(
                path.join(planDir, 'SKILL.md')
            );
            const plan = discoverAll(tempDir).find((s) => s.name === 'ai-plan');
            const kiroBase = seedInstalled('.kiro', ['ai-plan']);
            const claudeBase = seedInstalled('.claude', ['ai-plan']);

            const result = await updateAiSkills(
                tempDir,
                targetRepo,
                {
                    installMethod: 'symlink',
                    agents: ['kiro', 'claude'],
                    skillHashes: { 'ai-domain-research': 'STALE' },
                },
                noopUi
            );

            expect(result.updated).toEqual(['ai-plan']);
            // A file the skill gained since the install gets its link.
            for (const base of [kiroBase, claudeBase]) {
                const added = path.join(
                    base,
                    'ai-plan',
                    'references',
                    'added.md'
                );
                expect(fs.lstatSync(added).isSymbolicLink()).toBe(true);
                expect(fs.readFileSync(added, 'utf8')).toBe('added upstream\n');
            }
            // Claude Code links the source SKILL.md; Kiro has its adapted one.
            const claudeSkillMd = path.join(claudeBase, 'ai-plan', 'SKILL.md');
            expect(fs.lstatSync(claudeSkillMd).isSymbolicLink()).toBe(true);
            const kiroSkillMd = path.join(kiroBase, 'ai-plan', 'SKILL.md');
            expect(fs.lstatSync(kiroSkillMd).isFile()).toBe(true);
            expect(fs.readFileSync(kiroSkillMd)).toEqual(
                plan.variants.get('kiro').get('SKILL.md')
            );
            // The submodule's own SKILL.md was not written through a link.
            expect(fs.readFileSync(path.join(planDir, 'SKILL.md'))).toEqual(
                sourceSkillMd
            );
        });

        it('returns empty when no AI skills are installed in the target', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const result = await updateAiSkills(
                tempDir,
                targetRepo,
                { installMethod: 'copy', agents: ['kiro'], skillHashes: {} },
                noopUi
            );
            expect(result).toEqual({
                updated: [],
                newHashes: {},
                newFolderHashes: {},
            });
        });

        it('returns empty when the submodule is missing', async () => {
            seedInstalled('.kiro', ['ai-plan']);
            const result = await updateAiSkills(
                tempDir,
                targetRepo,
                { installMethod: 'copy', agents: ['kiro'], skillHashes: {} },
                noopUi
            );
            expect(result).toEqual({
                updated: [],
                newHashes: {},
                newFolderHashes: {},
            });
        });
    });
});

describe('excluded ai-skills domains', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-skills-excl-'));
    });
    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('does not offer ai-scaffold-release (the release domain) by default', () => {
        scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
        const skills = discoverAiSkills(tempDir);
        expect(skills.map((s) => s.name)).not.toContain('ai-scaffold-release');
        expect(skills.some((s) => s.domain === 'release')).toBe(false);
        expect(buildAiCategories(skills).map((c) => c.name)).toEqual([
            'AI Spec-Driven Development',
        ]);
    });

    it('still offers every research-domain skill', () => {
        scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
        expect(discoverAiSkills(tempDir).map((s) => s.name)).toEqual(
            [...UPSTREAM_LAYOUT.research].sort()
        );
    });

    it('lists release in EXCLUDED_AI_DOMAINS', () => {
        expect(EXCLUDED_AI_DOMAINS.has('release')).toBe(true);
    });

    it('offers the pinned submodule as six labelled bundles', () => {
        const repoRoot = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            '..',
            '..'
        );
        const sink = warnSink();
        const skills = discoverAiSkills(repoRoot, { onWarn: sink.onWarn });
        expect(sink.messages).toEqual([]);
        const bundles = buildAiCategories(skills, new Set(['ai-workflow']));
        expect(
            Object.fromEntries(bundles.map((c) => [c.name, c.skills]))
        ).toEqual({
            'AI Architecture Decisions': ['ai-adr'],
            'AI Agent Context': [
                'ai-agent-context',
                'ai-make-skill',
                'ai-scaffold-agents-md',
            ],
            'AI Development Process': [
                'ai-dev-autopr',
                'ai-dev-issue',
                'ai-scaffold-dev-context',
                'ai-scaffold-dev-templates',
            ],
            'AI Prose Documents': [
                'ai-human-docx',
                'ai-human-draft',
                'ai-human-outline',
                'ai-human-pdf',
                'ai-human-xlsx',
            ],
            'AI Spec-Driven Development': [
                'ai-archive',
                'ai-create',
                'ai-implement',
                'ai-plan',
                'ai-research',
                'ai-workflow',
            ],
            'AI Software Documentation': [
                'ai-doc',
                'ai-scaffold-docusaurus-site',
            ],
        });
    });
});

describe('the SKILL.md agents other than Claude Code receive', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-skills-adapt-'));
    });
    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /** Discovers one fixture skill and returns it with the warnings. */
    function discoverOne(source) {
        makeSkill(tempDir, 'research', 'ai-plan', source);
        const sink = warnSink();
        const [skill] = discoverAll(tempDir, { onWarn: sink.onWarn });
        return { skill, warnings: sink.messages };
    }

    // The expected text is what the ai-skills installer (v0.6.2) writes for
    // Kiro from the same source.
    it('keeps the fields Kiro reads and restates the explicit-only and tool declarations', () => {
        const { skill, warnings } = discoverOne(
            '---\n' +
                '# kept: lines before the first field\n' +
                'name: ai-plan\n' +
                'description: "Plan a feature. Invoke ONLY via the /ai-plan slash command."\n' +
                'disallowed-tools: "WebFetch, Skill"\n' +
                'allowed-tools: "Bash(git config user.name:*), Bash(find:*)"\n' +
                '\n' +
                'effort: high\n' +
                'disable-model-invocation: true\n' +
                'license: MIT-0\n' +
                'metadata:\n' +
                '  owner: docs\n' +
                '---\n' +
                '# ai-plan\n' +
                '\n' +
                'Body text.'
        );
        expect(warnings).toEqual([]);
        expect(
            skill.variants.get('kiro').get('SKILL.md').toString('utf8')
        ).toBe(
            '---\n' +
                '# kept: lines before the first field\n' +
                'name: ai-plan\n' +
                'description: "Plan a feature. Invoke ONLY via the /ai-plan slash command."\n' +
                'license: MIT-0\n' +
                'metadata:\n' +
                '  owner: docs\n' +
                '---\n' +
                '# ai-plan\n' +
                '\n' +
                'Body text.\n' +
                '\n' +
                '## Invocation\n' +
                '\n' +
                'Run this skill only when the user invokes it by name. Do not start it on your own because a request looks related to what it does.\n' +
                '\n' +
                '## Tool restrictions\n' +
                '\n' +
                'This skill was written for an agent that enforces the tool declarations in its frontmatter. Kiro does not enforce them, so they are stated here, and you must follow them yourself. An entry `Bash(<command>:*)` means any shell command that starts with `<command>`.\n' +
                '\n' +
                'Do not use these tools:\n' +
                '\n' +
                '- `WebFetch`\n' +
                '- `Skill`\n' +
                '\n' +
                "This skill's steps run these commands. The list does not limit which other tools you may use:\n" +
                '\n' +
                '- `Bash(git config user.name:*)`\n' +
                '- `Bash(find:*)`\n'
        );
    });

    it('leaves a SKILL.md with only a name and a description unchanged for every agent', () => {
        const source = skillMd('ai-plan');
        const { skill } = discoverOne(source);
        for (const files of skill.variants.values()) {
            expect([...files.keys()]).toEqual(['SKILL.md']);
            expect(files.get('SKILL.md').toString('utf8')).toBe(source);
        }
    });

    // Expected text from the ai-skills installer's Codex and pi adapters
    // (v0.6.2) for the same source.
    const EXPLICIT_ONLY_SOURCE =
        '---\n' +
        'name: ai-plan\n' +
        'description: "Plan a feature. Invoke ONLY via the /ai-plan slash command."\n' +
        'disallowed-tools: "WebFetch, Skill"\n' +
        'allowed-tools: "Bash(find:*)"\n' +
        '\n' +
        'effort: high\n' +
        'disable-model-invocation: true\n' +
        '---\n' +
        '# ai-plan\n' +
        '\n' +
        'Then run /ai-create, not /ai-plan-extra or .claude/skills/ai-plan/.\n';
    const RESTRICTIONS = (label) =>
        '## Tool restrictions\n' +
        '\n' +
        `This skill was written for an agent that enforces the tool declarations in its frontmatter. ${label} does not enforce them, so they are stated here, and you must follow them yourself. An entry \`Bash(<command>:*)\` means any shell command that starts with \`<command>\`.\n` +
        '\n' +
        'Do not use these tools:\n' +
        '\n' +
        '- `WebFetch`\n' +
        '- `Skill`\n' +
        '\n' +
        "This skill's steps run these commands. The list does not limit which other tools you may use:\n" +
        '\n' +
        '- `Bash(find:*)`\n';

    /** Discovers ai-plan from EXPLICIT_ONLY_SOURCE, beside an ai-create to invoke. */
    function discoverExplicitOnly() {
        makeSkill(tempDir, 'research', 'ai-create');
        makeSkill(tempDir, 'research', 'ai-plan', EXPLICIT_ONLY_SOURCE);
        return discoverAll(tempDir).find((s) => s.name === 'ai-plan');
    }

    it('gives Codex $name invocations and an invocation policy instead of an Invocation section', () => {
        const codex = discoverExplicitOnly().variants.get('codex');
        expect(codex.get('SKILL.md').toString('utf8')).toBe(
            '---\n' +
                'name: ai-plan\n' +
                'description: "Plan a feature. Invoke ONLY via the $ai-plan slash command."\n' +
                '---\n' +
                '# ai-plan\n' +
                '\n' +
                'Then run $ai-create, not /ai-plan-extra or .claude/skills/ai-plan/.\n' +
                '\n' +
                RESTRICTIONS('Codex')
        );
        expect(codex.get('agents/openai.yaml').toString('utf8')).toBe(
            '# Written by ai-skills: ai-plan declares disable-model-invocation, so Codex\n' +
                '# runs it only when the user invokes it.\n' +
                'policy:\n' +
                '  allow_implicit_invocation: false\n'
        );
    });

    it('keeps the fields pi enforces and gives it /skill:name invocations', () => {
        const pi = discoverExplicitOnly().variants.get('pi');
        expect([...pi.keys()]).toEqual(['SKILL.md']);
        expect(pi.get('SKILL.md').toString('utf8')).toBe(
            '---\n' +
                'name: ai-plan\n' +
                'description: "Plan a feature. Invoke ONLY via the /skill:ai-plan slash command."\n' +
                'allowed-tools: "Bash(find:*)"\n' +
                '\n' +
                'disable-model-invocation: true\n' +
                '---\n' +
                '# ai-plan\n' +
                '\n' +
                'Then run /skill:ai-create, not /ai-plan-extra or .claude/skills/ai-plan/.\n' +
                '\n' +
                RESTRICTIONS('pi')
        );
    });

    it('gives Cline, Roo Code and other agents the Kiro copy, naming the agent', () => {
        const { variants } = discoverExplicitOnly();
        const kiro = variants.get('kiro').get('SKILL.md').toString('utf8');
        for (const [id, label] of [
            ['cline', 'Cline'],
            ['roo', 'Roo Code'],
            ['other', 'This agent'],
        ]) {
            expect(variants.get(id).get('SKILL.md').toString('utf8')).toBe(
                kiro.replace(
                    'Kiro does not enforce',
                    `${label} does not enforce`
                )
            );
        }
    });

    it('gives a skills directory two agents share the copy of the first in agentConfig order', async () => {
        const skill = discoverExplicitOnly();
        const list = discoverAll(tempDir);
        // pi and "other" both install into .agents/skills.
        const agents = ['other', 'pi'];
        const hashes = await computeAiSkillFolderHashes(
            ['ai-plan'],
            list,
            agents
        );
        const installed = path.join(tempDir, 'installed');
        await copySkill(skill.path, installed);
        await writeAgentFiles(skill, 'other', installed, agents);
        expect(fs.readFileSync(path.join(installed, 'SKILL.md'))).toEqual(
            skill.variants.get('pi').get('SKILL.md')
        );
        const digest = await computeContentHash(installed);
        expect(hashes['other/ai-plan']).toBe(digest);
        expect(hashes['pi/ai-plan']).toBe(digest);
    });

    // A declaration in a form the adapter cannot read is never dropped: the
    // skill is not offered at all.
    it.each([
        ['no frontmatter', '# ai-plan\n', 'does not begin with a --- line'],
        [
            'an unclosed frontmatter',
            '---\nname: ai-plan\ndescription: "x"\n',
            'has no closing --- line',
        ],
        [
            'another name',
            skillMd('ai-other'),
            'does not give the name "ai-plan"',
        ],
        ['no description', '---\nname: ai-plan\n---\n', 'has no description'],
        [
            'a field given twice',
            skillMd('ai-plan', 'name: ai-plan\n'),
            'has the field "name" twice',
        ],
        [
            'a tool list over several lines',
            skillMd('ai-plan', 'allowed-tools:\n  - Read\n'),
            'field "allowed-tools" spans several lines',
        ],
        [
            'an escape in a quoted value',
            skillMd('ai-plan', 'disallowed-tools: "Web\\"Fetch"\n'),
            'field "disallowed-tools" has a value this installer cannot read',
        ],
        [
            'a flow list',
            skillMd('ai-plan', 'disallowed-tools: [WebFetch]\n'),
            'field "disallowed-tools" is not a quoted string',
        ],
        [
            'an unquoted tool list',
            skillMd('ai-plan', 'disallowed-tools: WebFetch, Skill\n'),
            'field "disallowed-tools" is not a quoted string',
        ],
        [
            'an explicit-only flag that is not true or false',
            skillMd('ai-plan', 'disable-model-invocation: yes\n'),
            'field "disable-model-invocation" is not true or false',
        ],
        // YAML reads these as the field; the column-0 `key:` rule would not.
        [
            'a quoted key',
            skillMd('ai-plan', '"disable-model-invocation": true\n'),
            'writes the field "disable-model-invocation" in a form this installer cannot read',
        ],
        [
            'an explicit key',
            skillMd('ai-plan', '? disallowed-tools\n: "WebFetch"\n'),
            'writes the field "disallowed-tools" in a form this installer cannot read',
        ],
        [
            'a byte-order mark',
            Buffer.concat([
                Buffer.from([0xef, 0xbb, 0xbf]),
                Buffer.from(skillMd('ai-plan')),
            ]),
            'does not begin with a --- line',
        ],
        [
            'bytes that are not UTF-8',
            Buffer.concat([
                Buffer.from(skillMd('ai-plan')),
                Buffer.from([0xff]),
            ]),
            'is not UTF-8',
        ],
    ])('skips a skill whose SKILL.md has %s', (_case, source, reason) => {
        const { skill, warnings } = discoverOne(source);
        expect(skill).toBeUndefined();
        expect(warnings).toEqual([
            `ai-skills: "ai-plan" SKILL.md ${reason}; skipped`,
        ]);
    });
});
