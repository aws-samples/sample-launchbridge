// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Unit tests for the AI Skills module (public sample-ai-skills layout:
 * project_dependencies/ai-skills/skills/<domain>/<skill>/SKILL.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { computeContentHash } from '../../lib/contentHash.js';
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

/** Creates `skills/<domain>/<name>/SKILL.md` in the fake submodule. */
function makeSkill(root, domain, name, body = `# ${name}`) {
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

/** The upstream v0.3.4 layout. */
const UPSTREAM_LAYOUT = {
    research: [
        'ai-create',
        'ai-research',
        'ai-plan',
        'ai-implement',
        'ai-archive',
    ],
    'semantic-release': ['ai-release'],
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
                'ai-release',
                'ai-research',
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
            const release = skills.find((s) => s.name === 'ai-release');
            expect(release.group).toBe('ai-domain-semantic-release');
        });

        it('reports references/ and scripts/ presence', () => {
            const dir = makeSkill(tempDir, 'semantic-release', 'ai-release');
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
                fs.writeFileSync(path.join(external, 'SKILL.md'), '# linked');
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
            expect(aiTrackingKey('ai-release', list)).toBe(
                'ai-domain-semantic-release'
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
                'ai-domain-research',
                'ai-domain-semantic-release',
            ]);

            const research = cats[0];
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
            const release = cats[1];
            expect(release.name).toBe('AI Skills: semantic-release');
            expect(release.description).toBe('ai-release');
            expect(release.individual).toBe(true);
            // the orchestrator is never bundled with ai-release
            expect(release.skills).toEqual(['ai-release']);
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
                        'ai-release',
                    ],
                    list
                )
            ).toEqual([
                'lb-setup',
                'ai-domain-research',
                'ai-workflow',
                'ai-domain-semantic-release',
            ]);
        });

        it('selecting ai-plan yields only ai-domain-research (no ai-init)', () => {
            const keys = toManifestKeys(['ai-plan'], list);
            expect(keys).toEqual(['ai-domain-research']);
            expect(keys.join(' ')).not.toContain('ai-init');
        });

        it('round-trips through manifest keys', () => {
            const selected = ['ai-plan', 'ai-release', 'lb-setup'];
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
                    ['lb-setup', 'ai-domain-semantic-release'],
                    ['ai-plan'],
                    list
                )
            ).toEqual(['lb-setup']);
        });
    });

    describe('hashing', () => {
        it('keys one shared/<name> digest per folder equal to its content hash', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const hashes = await computeAiSkillFolderHashes(
                ['ai-plan', 'ai-release', 'lb-setup'],
                list
            );
            expect(Object.keys(hashes).sort()).toEqual([
                'shared/ai-plan',
                'shared/ai-release',
            ]);
            expect(hashes['shared/ai-plan']).toBe(
                await computeContentHash(
                    path.join(skillsRoot(tempDir), 'research', 'ai-plan')
                )
            );
        });

        it('produces one stable hash per selected domain', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const selected = ['ai-plan', 'ai-research', 'ai-release'];
            const hashes = await computeAiGroupHashes(selected, list);
            expect(Object.keys(hashes).sort()).toEqual([
                'ai-domain-research',
                'ai-domain-semantic-release',
            ]);
            expect(await computeAiGroupHashes(selected, list)).toEqual(hashes);
        });

        it('agrees with the group hash, which is built from the same pass', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const selected = ['ai-research', 'ai-plan'];
            const folderHashes = await computeAiSkillFolderHashes(
                selected,
                list
            );
            const groupHashes = await computeAiGroupHashes(selected, list);
            const hasher = crypto.createHash('sha256');
            for (const key of Object.keys(folderHashes).sort()) {
                hasher.update(key + '\0');
                hasher.update(folderHashes[key]);
            }
            expect(groupHashes['ai-domain-research']).toBe(
                hasher.digest('hex')
            );
        });

        it('changes the group hash and only the affected digest when a file changes', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const selected = ['ai-plan', 'ai-research'];
            const beforeGroup = await computeAiGroupHashes(selected, list);
            const beforeFolders = await computeAiSkillFolderHashes(
                selected,
                list
            );

            fs.writeFileSync(
                path.join(
                    skillsRoot(tempDir),
                    'research',
                    'ai-plan',
                    'SKILL.md'
                ),
                '# changed content'
            );
            const afterGroup = await computeAiGroupHashes(selected, list);
            const afterFolders = await computeAiSkillFolderHashes(
                selected,
                list
            );
            expect(afterGroup['ai-domain-research']).not.toBe(
                beforeGroup['ai-domain-research']
            );
            expect(afterFolders['shared/ai-plan']).not.toBe(
                beforeFolders['shared/ai-plan']
            );
            expect(afterFolders['shared/ai-research']).toBe(
                beforeFolders['shared/ai-research']
            );
        });

        it('returns empty for a selection with no external skills', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            expect(
                await computeAiSkillFolderHashes(
                    ['lb-setup', 'ai-workflow'],
                    list
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
                { name: 'ai-domain-research', status: 'ready' },
                { name: 'ai-domain-semantic-release', status: 'not installed' },
            ]);
        });

        it('preserves an existing non-trivial status', () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const existing = new Map([
                ['ai-domain-research', 'customized'],
                ['ai-domain-semantic-release', 'not installed'],
            ]);
            expect(
                buildAiStatusRows(existing, ['ai-plan', 'ai-release'], list)
            ).toEqual([
                { name: 'ai-domain-research', status: 'customized' },
                { name: 'ai-domain-semantic-release', status: 'ready' },
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

        it('re-copies only the skills of changed domains for copy installs, for every agent', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const list = discoverAll(tempDir);
            const kiroBase = seedInstalled('.kiro', ['ai-plan', 'ai-release']);
            const claudeBase = seedInstalled('.claude', ['ai-plan']);
            // a native skill in the target is never treated as external
            seedInstalled('.kiro', ['ai-workflow']);

            const correct = await computeAiGroupHashes(
                ['ai-plan', 'ai-release'],
                list
            );
            const manifest = {
                installMethod: 'copy',
                agents: ['kiro', 'claude'],
                skillHashes: {
                    'ai-domain-research': 'STALE',
                    'ai-domain-semantic-release':
                        correct['ai-domain-semantic-release'],
                },
            };

            const result = await updateAiSkills(
                tempDir,
                targetRepo,
                manifest,
                noopUi
            );

            expect(result.updated).toEqual(['ai-plan']);
            for (const base of [kiroBase, claudeBase]) {
                expect(
                    fs.readFileSync(
                        path.join(base, 'ai-plan', 'SKILL.md'),
                        'utf8'
                    )
                ).toBe('# ai-plan');
            }
            // ai-release (semantic-release) is no longer offered, so an
            // earlier install of it is left as it is, not refreshed.
            expect(
                fs.readFileSync(
                    path.join(kiroBase, 'ai-release', 'SKILL.md'),
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
                await computeAiSkillFolderHashes(['ai-plan'], list)
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
                'shared/ai-plan',
            ]);
            expect(warnings).toContain(
                'ai-skills: "lb-setup" shadowed by native LaunchBridge skill; skipped'
            );
        });

        it('does not copy for symlink installs', async () => {
            scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
            const base = seedInstalled('.kiro', ['ai-plan']);
            const result = await updateAiSkills(
                tempDir,
                targetRepo,
                {
                    installMethod: 'symlink',
                    agents: ['kiro'],
                    skillHashes: { 'ai-domain-research': 'STALE' },
                },
                noopUi
            );
            expect(result.updated).toEqual([]);
            expect(
                fs.readFileSync(path.join(base, 'ai-plan', 'SKILL.md'), 'utf8')
            ).toBe('OLD');
            expect(Object.keys(result.newHashes)).toEqual([
                'ai-domain-research',
            ]);
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

    it('does not offer ai-release (the semantic-release domain) by default', () => {
        scaffoldSubmodule(tempDir, UPSTREAM_LAYOUT);
        const skills = discoverAiSkills(tempDir);
        expect(skills.map((s) => s.name)).not.toContain('ai-release');
        expect(skills.some((s) => s.domain === 'semantic-release')).toBe(false);
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

    it('lists semantic-release in EXCLUDED_AI_DOMAINS', () => {
        expect(EXCLUDED_AI_DOMAINS.has('semantic-release')).toBe(true);
    });
});
