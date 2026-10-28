// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * AI Skills Module
 *
 * Integrates the `ai-skills` git submodule (project_dependencies/ai-skills,
 * the public sample-ai-skills library) into the LaunchBridge installer.
 *
 * Layout: `<submodule>/skills/<domain>/<skill>/`, where every skill directory
 * holds a SKILL.md written for Claude Code. Every agent installs the same
 * folder into its own skills dir. Claude Code gets it unchanged. Every other
 * agent gets it with its own SKILL.md (`adaptSkillMd`), as the ai-skills
 * installer writes it for Kiro, Codex and pi: the frontmatter keeps the fields
 * that agent reads, invocations use its syntax, and the declarations it does
 * not enforce are restated in the body. Codex also gets an `agents/openai.yaml`
 * for each explicit-only skill. Cline, Roo Code and other agents get the Kiro
 * form, naming the agent.
 *
 * Bundles are derived from the tree, not from name prefixes: each domain
 * becomes one selectable category with group id `ai-domain-<domain>`
 * (AI_GROUP_PREFIX keeps group ids from ever equalling a skill name in the
 * mixed manifest keyspace). A single-skill domain is offered as an individual
 * choice. Native LaunchBridge companions (e.g. the `ai-workflow`
 * orchestrator for the research domain) are appended to a domain's category
 * via AI_DOMAIN_COMPANIONS, but stay native skills. There is no core skill and
 * nothing is added to a selection implicitly.
 *
 * Classification is by membership in the discovered list: every helper below
 * takes that list explicitly, so a native skill can never be mistaken for an
 * external one. Native names always win a collision.
 *
 * For status tracking and change detection AI skills are handled at the
 * domain level: setup_status.md shows one row per domain and the version
 * manifest stores one content hash per `ai-domain-<domain>` key. Group hashes
 * drive upgrades only; they cannot verify an installed directory. The manifest
 * also records one `<agent>/<skill>` digest per agent and skill
 * (`computeAiSkillFolderHashes`), the content the installer gives that agent,
 * which is what `verify_integrity.py` checks in that agent's skills dir.
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { safePathJoin, sanitizePathComponent } from './pathSanitizer.js';
import { discoverSkills, validateSkillStructure } from './skillDiscovery.js';
import { computeContentHash } from './contentHash.js';
import { copySkill, createSymlink } from './installer.js';
import { AGENTS } from './agentConfig.js';

/** Path to the ai-skills submodule, relative to the LaunchBridge source root. */
export const AI_SUBMODULE_REL = path.join('project_dependencies', 'ai-skills');

/** Prefix of every AI group id (`ai-domain-<domain>`). */
export const AI_GROUP_PREFIX = 'ai-domain-';

/**
 * ai-skills domains LaunchBridge does not offer. `release` (the
 * `ai-scaffold-release` skill) writes CI jobs and release scripts for hosting
 * platforms; it is available directly from aws-samples/sample-ai-skills.
 */
export const EXCLUDED_AI_DOMAINS = new Set(['release']);

/** Display labels for known domains. Unknown domains get `AI Skills: <domain>`. */
export const AI_DOMAIN_LABELS = {
    adr: 'AI Architecture Decisions',
    agents: 'AI Agent Context',
    dev: 'AI Development Process',
    'human-docs': 'AI Prose Documents',
    research: 'AI Spec-Driven Development',
    'software-docs': 'AI Software Documentation',
};

/** Descriptions for known domains. Unknown domains list their skill names. */
export const AI_DOMAIN_DESCRIPTIONS = {
    adr: 'Architecture decision log: /ai-adr stands it up, then writes records and moves them through propose, accept and decline',
    agents: 'Agent context: /ai-agent-context (CLAUDE.md and README.md for a source directory), /ai-scaffold-agents-md (AGENTS.md as the single source), /ai-make-skill (write a new skill)',
    dev: 'How the repository is developed: /ai-scaffold-dev-context, /ai-scaffold-dev-templates (issue, merge request and review templates), /ai-dev-issue (file an issue), /ai-dev-autopr (a spec or issue to a merge-ready pull or merge request)',
    'human-docs':
        'Documents for people: /ai-human-outline → /ai-human-draft, and export to Word, PDF and Excel with /ai-human-docx, /ai-human-pdf and /ai-human-xlsx (these need uv)',
    research:
        'Spec-driven development: /ai-create → /ai-research → /ai-plan → /ai-implement → /ai-archive, plus the ai-workflow orchestrator',
    'software-docs':
        'Documentation tree: /ai-doc (file pages by Diátaxis mode), /ai-scaffold-docusaurus-site (scaffold a Docusaurus 3 site)',
};

/**
 * The agent the ai-skills SKILL.md files are written for. It gets them
 * unchanged; every other agent gets its own copy (`adaptSkillMd`).
 */
const CLAUDE_AGENT = 'claude';

/**
 * Native LaunchBridge skills bundled into a domain's category. They are only
 * appended when present in the native skill set, and remain native skills
 * (sourced from <root>/skills, hashed and tracked under their own name).
 *
 * @type {Record<string, string[]>}
 */
export const AI_DOMAIN_COMPANIONS = { research: ['ai-workflow'] };

/** Valid domain and skill directory names. */
const AI_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Shared-references directory name; never a domain or a skill. */
const REFERENCES_DIR = 'references';

/**
 * @typedef {Object} AiSkill
 * @property {string} name - Skill directory name (e.g. 'ai-plan')
 * @property {string} domain - Domain directory name (e.g. 'research')
 * @property {string} group - Group id, `ai-domain-<domain>`
 * @property {boolean} isAiSkill - Always true (marker for the install loop)
 * @property {string} path - Source directory, installed for every agent
 * @property {Map<string, Map<string, Buffer>>} variants - For every agent but
 *   Claude Code, by AGENT_ADAPTERS id: the files whose bytes replace or join
 *   the source folder's, by relative path (SKILL.md, and Codex's
 *   agents/openai.yaml for an explicit-only skill)
 * @property {boolean} hasReferences
 * @property {boolean} hasScripts
 */

// ── SKILL.md for agents other than Claude Code ───────────────────────────────
//
// A port of the ai-skills installer's agent adapters (installer/ai_skills/
// frontmatter.py, agents/__init__.py, agents/kiro.py, agents/codex.py and
// agents/pi.py at the pinned tag). The frontmatter is filtered by whole
// top-level entries and never re-serialized, so every byte that is kept is the
// source's own. Only the fields the adapters read are parsed, and a SKILL.md
// whose fields take a form this parser does not handle is refused, so a
// declaration is never dropped silently.

/** Fields every agent's copy keeps. */
const REQUIRED_FIELDS = ['name', 'description'];

/** The fields the ai-skills installer keeps for Kiro, Codex and OpenCode. */
const SPEC_FIELDS = ['license', 'compatibility', 'metadata'];

/**
 * How each agent's copy differs from the source, keyed by agent name. Claude
 * Code, which the skills are written for, gets the source unchanged.
 *   - `label`: the agent the "Tool restrictions" section names.
 *   - `keep`: frontmatter fields kept besides `name` and `description`.
 *   - `explicitOnlyInBody`: an explicit-only skill says so in the body.
 *   - `invoke`: how the agent invokes a skill, when it is not `/<name>`.
 *   - `policyFile`: an explicit-only skill gets Codex's `agents/openai.yaml`.
 * Kiro, Codex and pi follow the installer's adapters for them. The installer
 * has none for Cline, Roo Code and other agents; they get the Kiro form,
 * naming the agent.
 */
const AGENT_ADAPTERS = {
    kiro: { label: 'Kiro', keep: SPEC_FIELDS, explicitOnlyInBody: true },
    codex: {
        label: 'Codex',
        keep: SPEC_FIELDS,
        invoke: (name) => `$${name}`,
        policyFile: true,
    },
    pi: {
        label: 'pi',
        keep: [...SPEC_FIELDS, 'allowed-tools', 'disable-model-invocation'],
        invoke: (name) => `/skill:${name}`,
    },
    cline: { label: 'Cline', keep: SPEC_FIELDS, explicitOnlyInBody: true },
    roo: { label: 'Roo Code', keep: SPEC_FIELDS, explicitOnlyInBody: true },
    other: { label: 'This agent', keep: SPEC_FIELDS, explicitOnlyInBody: true },
};

/** Where Codex reads a skill's invocation policy, relative to the skill. */
const POLICY_FILE = 'agents/openai.yaml';

/** A top-level frontmatter entry starts with `key:` in column 0. */
const FIELD_PATTERN = /^([A-Za-z0-9_-]+):/;

/**
 * A field the adapter reads, in a key form YAML accepts but FIELD_PATTERN does
 * not see (`"key":`, `key :`, `? key`). Grouped as part of the previous entry,
 * it would be kept or dropped with that entry and never restated.
 */
const HIDDEN_READ_FIELD =
    /^(?:\?\s*)?(["']?)(name|description|disable-model-invocation|disallowed-tools|allowed-tools)\1\s*(?::|$)/;

const INVOCATION_SECTION =
    '## Invocation\n' +
    '\n' +
    'Run this skill only when the user invokes it by name. Do not start it on your own because a' +
    ' request looks related to what it does.\n';

/** `text` split after each `\r\n`, `\r` or `\n`, as Python's splitlines(keepends=True). */
function splitLines(text) {
    return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

/** `line` without its line ending. */
function stripEol(line) {
    return line.replace(/[\r\n]+$/, '');
}

/**
 * The value of a frontmatter field the adapter reads: `key: value` on one
 * line, followed by nothing but blank lines. A quoted value must close and
 * contain no escapes; a plain value is returned as written, and every caller
 * accepts only an exact literal. Anything else throws.
 *
 * @param {{ key: string, lines: string[] }} entry
 * @returns {{ value: string, quoted: boolean }}
 */
function readFieldValue(entry) {
    const [first, ...rest] = entry.lines;
    if (rest.some((line) => line.trim() !== '')) {
        throw new Error(`field "${entry.key}" spans several lines`);
    }
    const raw = stripEol(first)
        .slice(entry.key.length + 1)
        .trim();
    if (raw.startsWith('"') || raw.startsWith("'")) {
        const quote = raw[0];
        const inner = raw.slice(1, -1);
        const escaped = quote === '"' ? /["\\]/ : /'/;
        if (
            raw.length < 2 ||
            !raw.endsWith(quote) ||
            escaped.test(quote === "'" ? inner.replaceAll("''", '') : inner)
        ) {
            throw new Error(
                `field "${entry.key}" has a value this installer cannot read`
            );
        }
        return {
            value: quote === "'" ? inner.replaceAll("''", "'") : inner,
            quoted: true,
        };
    }
    return { value: raw, quoted: false };
}

/**
 * A tool declaration as its entries: split at commas outside parentheses,
 * trimmed, empty entries dropped.
 *
 * @param {string} value
 * @returns {string[]}
 */
function toolEntries(value) {
    const entries = [];
    let depth = 0;
    let current = '';
    for (const char of value) {
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (char === ',' && depth === 0) {
            entries.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    entries.push(current.trim());
    return entries.filter((entry) => entry !== '');
}

/**
 * The "Tool restrictions" section for an agent that enforces neither tool
 * field, or null when the skill declares no tools. `allowed-tools` is a
 * pre-approval list in Claude Code, not a limit, and is stated as such.
 *
 * @param {string[]} denied
 * @param {string[]} allowed
 * @param {string} label - The agent the section names
 * @returns {string|null}
 */
function restrictionsSection(denied, allowed, label) {
    if (denied.length === 0 && allowed.length === 0) {
        return null;
    }
    const lines = [
        '## Tool restrictions',
        '',
        'This skill was written for an agent that enforces the tool declarations in its frontmatter.' +
            ` ${label} does not enforce them, so they are stated here, and you must follow them` +
            ' yourself. An entry `Bash(<command>:*)` means any shell command that starts with `<command>`.',
    ];
    if (denied.length > 0) {
        lines.push(
            '',
            'Do not use these tools:',
            '',
            ...denied.map((entry) => `- \`${entry}\``)
        );
    }
    if (allowed.length > 0) {
        lines.push(
            '',
            "This skill's steps run these commands. The list does not limit which other tools you may use:",
            '',
            ...allowed.map((entry) => `- \`${entry}\``)
        );
    }
    return lines.join('\n') + '\n';
}

/** `text` with `section` added after a blank line. */
function appendSection(text, section) {
    return (text.endsWith('\n') ? text : `${text}\n`) + '\n' + section;
}

/**
 * `text` with each `/<name>` invocation of a catalog skill replaced by
 * `invoke(name)`, where the `/` follows no path character and the name ends
 * there: `/ai-plan` is rewritten, `.claude/skills/ai-plan/` and
 * `/ai-plan-extra` are not.
 *
 * @param {string} text
 * @param {string[]} names - Every skill name in the submodule
 * @param {(name: string) => string} invoke
 * @returns {string}
 */
function rewriteInvocations(text, names, invoke) {
    if (names.length === 0) {
        return text;
    }
    const alternatives = [...names]
        .sort((a, b) => b.length - a.length)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const pattern = new RegExp(
        `(?<![A-Za-z0-9._/-])/(${alternatives})(?![A-Za-z0-9_-])`,
        'g'
    );
    return text.replace(pattern, (_match, name) => invoke(name));
}

/**
 * Codex's invocation policy for an explicit-only skill, as the ai-skills
 * installer writes it.
 *
 * @param {string} name
 * @returns {string}
 */
function policyFileText(name) {
    return (
        `# Written by ai-skills: ${name} declares disable-model-invocation, so Codex\n` +
        '# runs it only when the user invokes it.\n' +
        'policy:\n' +
        '  allow_implicit_invocation: false\n'
    );
}

/**
 * Every agent's files for one skill, other than Claude Code's: its SKILL.md
 * and, for Codex and an explicit-only skill, `agents/openai.yaml`.
 *
 * @param {Buffer} source - The SKILL.md as written upstream
 * @param {string} name - The skill's directory name
 * @param {string} skillPath - The skill's source directory
 * @param {string[]} catalogNames - Every skill name in the submodule
 * @returns {Map<string, Map<string, Buffer>>} By AGENT_ADAPTERS id
 * @throws {Error} When the SKILL.md cannot be adapted; the message completes
 *   "SKILL.md …"
 */
function adaptSkillMd(source, name, skillPath, catalogNames) {
    let text;
    try {
        // A byte-order mark is kept, so it fails the opening `---` check, as
        // it does upstream.
        text = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
        }).decode(source);
    } catch {
        throw new Error('is not UTF-8');
    }

    const lines = splitLines(text);
    if (lines.length === 0 || stripEol(lines[0]) !== '---') {
        throw new Error('does not begin with a --- line');
    }
    const end = lines.findIndex((line, i) => i > 0 && stripEol(line) === '---');
    if (end === -1) {
        throw new Error('has no closing --- line');
    }

    // Entries: a `key:` line in column 0 and every line after it up to the
    // next one. Lines before the first key belong to no field and are kept.
    const entries = [];
    for (const line of lines.slice(1, end)) {
        const match = FIELD_PATTERN.exec(line);
        const hidden = match ? null : HIDDEN_READ_FIELD.exec(stripEol(line));
        if (hidden) {
            throw new Error(
                `writes the field "${hidden[2]}" in a form this installer cannot read`
            );
        }
        if (match || entries.length === 0) {
            entries.push({ key: match ? match[1] : null, lines: [line] });
        } else {
            entries[entries.length - 1].lines.push(line);
        }
    }
    const fields = new Map();
    for (const entry of entries) {
        if (entry.key === null) continue;
        if (fields.has(entry.key)) {
            throw new Error(`has the field "${entry.key}" twice`);
        }
        fields.set(entry.key, entry);
    }

    if (!fields.has('description')) {
        throw new Error('has no description');
    }
    if (
        !fields.has('name') ||
        readFieldValue(fields.get('name')).value !== name
    ) {
        throw new Error(`does not give the name "${name}"`);
    }
    let explicitOnly = false;
    if (fields.has('disable-model-invocation')) {
        const flag = readFieldValue(fields.get('disable-model-invocation'));
        if (flag.quoted || !['true', 'false'].includes(flag.value)) {
            throw new Error(
                'field "disable-model-invocation" is not true or false'
            );
        }
        explicitOnly = flag.value === 'true';
    }
    const [denied, allowed] = ['disallowed-tools', 'allowed-tools'].map(
        (key) => {
            if (!fields.has(key)) return [];
            const tools = readFieldValue(fields.get(key));
            if (!tools.quoted) {
                throw new Error(`field "${key}" is not a quoted string`);
            }
            return toolEntries(tools.value);
        }
    );
    if (
        explicitOnly &&
        fs.existsSync(safePathJoin(skillPath, ...POLICY_FILE.split('/')))
    ) {
        throw new Error(`has a ${POLICY_FILE} the Codex copy would replace`);
    }

    const variants = new Map();
    for (const [id, adapter] of Object.entries(AGENT_ADAPTERS)) {
        const keep = new Set([...REQUIRED_FIELDS, ...adapter.keep]);
        const kept = entries
            .filter((entry) => entry.key === null || keep.has(entry.key))
            .flatMap((entry) => entry.lines);
        let output =
            lines[0] +
            kept.join('') +
            lines[end] +
            lines.slice(end + 1).join('');
        if (adapter.invoke) {
            output = rewriteInvocations(output, catalogNames, adapter.invoke);
        }
        if (adapter.explicitOnlyInBody && explicitOnly) {
            output = appendSection(output, INVOCATION_SECTION);
        }
        const section = restrictionsSection(denied, allowed, adapter.label);
        if (section !== null) {
            output = appendSection(output, section);
        }
        const files = new Map([['SKILL.md', Buffer.from(output, 'utf8')]]);
        if (adapter.policyFile && explicitOnly) {
            files.set(POLICY_FILE, Buffer.from(policyFileText(name), 'utf8'));
        }
        variants.set(id, files);
    }
    return variants;
}

/**
 * The agent whose copy an agent's skills directory holds. Two agents can share
 * a directory (pi and "other" both use .agents/skills), and it holds one copy:
 * that of the first selected agent sharing it, in agentConfig order, so pi's
 * when pi is selected. Agents without an adapter get the "other" copy.
 *
 * @param {string} agent - Agent name
 * @param {string[]} agents - Every selected agent
 * @returns {string} 'claude', or an AGENT_ADAPTERS id
 */
function copyFor(agent, agents) {
    const dir = AGENTS[agent]?.skillsDir;
    const owner =
        Object.keys(AGENTS).find(
            (name) => agents.includes(name) && AGENTS[name].skillsDir === dir
        ) ?? agent;
    if (owner === CLAUDE_AGENT) {
        return CLAUDE_AGENT;
    }
    return Object.hasOwn(AGENT_ADAPTERS, owner) ? owner : 'other';
}

/**
 * Reads a directory's entries, or null on any error.
 * @param {string} dir
 * @returns {fs.Dirent[]|null}
 */
function readEntries(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
}

/**
 * Whether an entry is a directory (symlinks count when they stat as one).
 * @param {fs.Dirent} entry
 * @param {string} entryPath
 * @returns {boolean}
 */
function isDirectoryEntry(entry, entryPath) {
    if (entry.isDirectory()) {
        return true;
    }
    if (!entry.isSymbolicLink()) {
        return false;
    }
    try {
        return fs.statSync(entryPath).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Lists the candidate child directories of `dir`, applying the shared skip
 * rules: dot entries, `references` and non-directories are skipped silently;
 * names not matching AI_NAME_PATTERN are skipped with a warning.
 *
 * @param {string} dir
 * @param {string} kind - 'domain' or 'skill' (for warning text)
 * @param {(msg: string) => void} onWarn
 * @returns {Array<{ name: string, path: string }>} Sorted by name
 */
function listCandidateDirs(dir, kind, onWarn) {
    const entries = readEntries(dir);
    if (entries === null) {
        return [];
    }

    const result = [];
    for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith('.') || name === REFERENCES_DIR) {
            continue;
        }
        const entryPath = safePathJoin(dir, sanitizePathComponent(name));
        if (!isDirectoryEntry(entry, entryPath)) {
            continue;
        }
        if (!AI_NAME_PATTERN.test(name)) {
            onWarn(`ai-skills: invalid ${kind} name "${name}"; skipped`);
            continue;
        }
        result.push({ name, path: entryPath });
    }

    result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return result;
}

/**
 * Discovers the AI skills in `<sourcePath>/project_dependencies/ai-skills/skills`.
 *
 * Every `skills/<domain>/<skill>/` directory containing a SKILL.md is a skill
 * in group `ai-domain-<domain>`. No deeper nesting is scanned. Native names
 * win a collision; a skill name in several domains is kept from the first
 * domain in sorted order. A skill whose SKILL.md cannot be adapted for the
 * agents other than Claude Code is skipped with a warning. Returns [] when the
 * submodule is not initialized. Never throws.
 *
 * @param {string} sourcePath - LaunchBridge source root
 * @param {{ nativeNames?: Set<string>, onWarn?: (msg: string) => void,
 *   excludedDomains?: Set<string> }} [options] - `excludedDomains` defaults to
 *   EXCLUDED_AI_DOMAINS
 * @returns {AiSkill[]} Sorted by name
 */
export function discoverAiSkills(
    sourcePath,
    {
        nativeNames = new Set(),
        onWarn = () => {},
        excludedDomains = EXCLUDED_AI_DOMAINS,
    } = {}
) {
    const root = safePathJoin(sourcePath, AI_SUBMODULE_REL, 'skills');
    if (!fs.existsSync(root)) {
        return [];
    }

    // Every skill name in the tree, as in the ai-skills installer's catalog,
    // excluded domains included: the invocations Codex and pi copies rewrite.
    const catalogNames = listCandidateDirs(root, 'domain', () => {}).flatMap(
        (domain) =>
            listCandidateDirs(domain.path, 'skill', () => {})
                .filter((skill) => validateSkillStructure(skill.path))
                .map((skill) => skill.name)
    );

    /** @type {Map<string, AiSkill>} */
    const byName = new Map();

    for (const domain of listCandidateDirs(root, 'domain', onWarn)) {
        if (excludedDomains.has(domain.name)) {
            continue;
        }
        for (const candidate of listCandidateDirs(
            domain.path,
            'skill',
            onWarn
        )) {
            if (!validateSkillStructure(candidate.path)) {
                continue;
            }
            if (nativeNames.has(candidate.name)) {
                onWarn(
                    `ai-skills: "${candidate.name}" shadowed by native LaunchBridge skill; skipped`
                );
                continue;
            }
            const existing = byName.get(candidate.name);
            if (existing) {
                onWarn(
                    `ai-skills: "${candidate.name}" in domain "${domain.name}" duplicates domain "${existing.domain}"; skipped`
                );
                continue;
            }
            let variants;
            try {
                variants = adaptSkillMd(
                    fs.readFileSync(safePathJoin(candidate.path, 'SKILL.md')),
                    candidate.name,
                    candidate.path,
                    catalogNames
                );
            } catch (err) {
                onWarn(
                    `ai-skills: "${candidate.name}" SKILL.md ${err.message}; skipped`
                );
                continue;
            }
            byName.set(candidate.name, {
                name: candidate.name,
                domain: domain.name,
                group: AI_GROUP_PREFIX + domain.name,
                isAiSkill: true,
                path: candidate.path,
                variants,
                hasReferences: fs.existsSync(
                    safePathJoin(candidate.path, 'references')
                ),
                hasScripts: fs.existsSync(
                    safePathJoin(candidate.path, 'scripts')
                ),
            });
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Finds a discovered AI skill by name.
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills
 * @returns {AiSkill|null}
 */
function findAiSkill(skillName, aiSkills) {
    if (!Array.isArray(aiSkills)) {
        return null;
    }
    return aiSkills.find((s) => s.name === skillName) ?? null;
}

/**
 * Returns the group id (`ai-domain-<domain>`) of a discovered AI skill, or
 * null when the name is not in the discovered list.
 *
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string|null}
 */
export function getAiSkillGroup(skillName, aiSkills) {
    return findAiSkill(skillName, aiSkills)?.group ?? null;
}

/**
 * Whether a skill is an external (submodule-sourced) AI skill, decided by
 * membership in the discovered list. Native skills always return false.
 *
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {boolean}
 */
export function isAiSkill(skillName, aiSkills) {
    return findAiSkill(skillName, aiSkills) !== null;
}

/**
 * The manifest/status tracking key for a skill: `ai-domain-<domain>` for every
 * AI skill (including single-skill domains; `individual` only affects how the
 * prompt displays the category), otherwise the name itself.
 *
 * @param {string} skillName
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string}
 */
export function aiTrackingKey(skillName, aiSkills) {
    return getAiSkillGroup(skillName, aiSkills) ?? skillName;
}

/**
 * Builds selection categories for the discovered AI skills, shaped like
 * SKILL_CATEGORIES entries so they slot into the existing prompt/flag logic.
 * One category per domain, in sorted domain order. A single-skill domain is
 * `individual: true`. Companions from AI_DOMAIN_COMPANIONS are appended when
 * they are present in `nativeNames`.
 *
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @param {Set<string>} [nativeNames] - Native LaunchBridge skill names
 * @returns {import('./skillDiscovery.js').SkillCategory[]}
 */
export function buildAiCategories(aiSkills, nativeNames = new Set()) {
    /** @type {Map<string, string[]>} */
    const byDomain = new Map();
    for (const skill of aiSkills) {
        if (!byDomain.has(skill.domain)) {
            byDomain.set(skill.domain, []);
        }
        byDomain.get(skill.domain).push(skill.name);
    }

    const categories = [];
    for (const domain of [...byDomain.keys()].sort()) {
        const skillNames = byDomain.get(domain).sort();
        const companions = (AI_DOMAIN_COMPANIONS[domain] ?? []).filter(
            (name) => nativeNames.has(name) && !skillNames.includes(name)
        );
        const category = {
            name: AI_DOMAIN_LABELS[domain] ?? `AI Skills: ${domain}`,
            description:
                AI_DOMAIN_DESCRIPTIONS[domain] ?? skillNames.join(', '),
            skills: [...skillNames, ...companions],
            ai: true,
            group: AI_GROUP_PREFIX + domain,
        };
        if (skillNames.length === 1) {
            category.individual = true;
        }
        categories.push(category);
    }

    return categories;
}

/**
 * Maps a list of skill names to the manifest/status keyspace:
 *   - AI skills collapse to their `ai-domain-<domain>` group id
 *   - LaunchBridge skills map to themselves
 * Order is preserved and duplicates removed.
 *
 * @param {string[]} skillNames
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string[]}
 */
export function toManifestKeys(skillNames, aiSkills) {
    const seen = new Set();
    const keys = [];
    for (const name of skillNames) {
        const key = aiTrackingKey(name, aiSkills);
        if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

/**
 * Expands manifest keys back to actual skill names. Keys starting with
 * AI_GROUP_PREFIX expand to the given skills that belong to that group;
 * every other key passes through unchanged.
 *
 * @param {string[]} keys - Manifest keyspace entries
 * @param {string[]} selectedSkills - Skill names to expand group keys into
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {string[]}
 */
export function expandManifestKeys(keys, selectedSkills, aiSkills) {
    const result = [];
    const seen = new Set();
    const add = (name) => {
        if (!seen.has(name)) {
            seen.add(name);
            result.push(name);
        }
    };

    for (const key of keys) {
        if (key.startsWith(AI_GROUP_PREFIX)) {
            for (const skill of selectedSkills) {
                if (getAiSkillGroup(skill, aiSkills) === key) {
                    add(skill);
                }
            }
        } else {
            add(key);
        }
    }
    return result;
}

/**
 * Builds the setup_status.md rows for AI skills: one row per discovered
 * domain, sorted by domain. AI skills do not require lb-setup, so an
 * installed domain is "ready"; a domain with nothing installed is "not
 * installed". Existing non-trivial status is preserved across merges.
 *
 * These rows are appended to the native rows by the installer's status writer
 * — native setup_status logic has no knowledge of AI skills.
 *
 * @param {Map<string, string>} existingStatuses - Parsed statuses from the current file
 * @param {string[]} installedSkillNames - Skill names from the current install run
 * @param {AiSkill[]} aiSkills - Discovered AI skills
 * @returns {Array<{ name: string, status: string }>}
 */
export function buildAiStatusRows(
    existingStatuses,
    installedSkillNames,
    aiSkills
) {
    const installedGroups = new Set();
    for (const name of installedSkillNames) {
        const group = getAiSkillGroup(name, aiSkills);
        if (group !== null) {
            installedGroups.add(group);
        }
    }

    const domains = [...new Set(aiSkills.map((s) => s.domain))].sort();
    return domains.map((domain) => {
        const key = AI_GROUP_PREFIX + domain;
        if (!installedGroups.has(key)) {
            return { name: key, status: 'not installed' };
        }
        const existing = existingStatuses.get(key);
        if (existing && existing !== 'not installed') {
            return { name: key, status: existing };
        }
        return { name: key, status: 'ready' };
    });
}

/**
 * Hashes every copy of every selected AI skill: the source folder, which
 * Claude Code receives, and the folder with each other agent's files.
 *
 * The single hashing pass both public hash functions are built on, so a group
 * hash and the per-agent digests can never disagree about the bytes they saw.
 *
 * @param {string[]} selectedSkills - Actual selected skill names
 * @param {AiSkill[]} aiSkills - Discovered AI skills (provides source paths)
 * @param {{ allowedRoot?: string }} [options] - Passed to the content hash
 * @returns {Promise<Map<string, Array<{name: string, hashes: Map<string, string>}>>>}
 *   Map of group id → its skills, sorted by skill name, each with the hash of
 *   every copy by `copyFor` id.
 */
async function hashAiSkillFolders(selectedSkills, aiSkills, options = {}) {
    /** @type {Map<string, AiSkill[]>} */
    const groupSkills = new Map();
    const seen = new Set();

    for (const name of selectedSkills) {
        const skill = findAiSkill(name, aiSkills);
        if (!skill || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const group = aiTrackingKey(name, aiSkills);
        if (!groupSkills.has(group)) {
            groupSkills.set(group, []);
        }
        groupSkills.get(group).push(skill);
    }

    /** @type {Map<string, Array<{name: string, hashes: Map<string, string>}>>} */
    const hashed = new Map();
    for (const [group, skills] of groupSkills) {
        // Code-unit order, so the group hash does not depend on the locale.
        skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const entries = [];
        for (const skill of skills) {
            const hashes = new Map([
                [CLAUDE_AGENT, await computeContentHash(skill.path, options)],
            ]);
            for (const [id, files] of skill.variants) {
                hashes.set(
                    id,
                    await computeContentHash(skill.path, {
                        ...options,
                        overrides: files,
                    })
                );
            }
            entries.push({ name: skill.name, hashes });
        }
        hashed.set(group, entries);
    }

    return hashed;
}

/**
 * Computes one content hash per AI group over the selected AI skills. The
 * hash covers every agent's copy of every selected skill in the domain, so a
 * change to any of them flips the group hash and triggers a reinstall. It does
 * not depend on which agents are selected, but it does depend on
 * AGENT_ADAPTERS: editing an adapter reinstalls every installed AI skill once.
 *
 * This is an upgrade-detection hash only. It is NOT verifiable against an
 * installed directory — use computeAiSkillFolderHashes for that.
 *
 * @param {string[]} selectedSkills - Actual selected skill names
 * @param {AiSkill[]} aiSkills - Discovered AI skills (provides source paths)
 * @param {{ allowedRoot?: string }} [options] - Passed to the content hash
 * @returns {Promise<Record<string, string>>} Map of group id → combined hash
 */
export async function computeAiGroupHashes(
    selectedSkills,
    aiSkills,
    options = {}
) {
    const hashed = await hashAiSkillFolders(selectedSkills, aiSkills, options);

    /** @type {Record<string, string>} */
    const result = {};
    for (const [group, entries] of hashed) {
        const hasher = crypto.createHash('sha256');
        for (const { name, hashes } of entries) {
            for (const id of [...hashes.keys()].sort()) {
                hasher.update(`${id}/${name}\0`);
                hasher.update(hashes.get(id));
            }
        }
        result[group] = hasher.digest('hex');
    }

    return result;
}

/**
 * Computes the digest of every selected AI skill for every selected agent, as
 * the installer gives that agent the skill.
 *
 * These are the digests an integrity check can actually verify: the key
 * `<agent>/<skill>` names the directory in that agent's skills dir, and
 * recomputing an installed copy reproduces the value. A copy the installer
 * left alone or failed to write still gets a digest, so the check reports it.
 *
 * @param {string[]} selectedSkills - Actual selected skill names
 * @param {AiSkill[]} aiSkills - Discovered AI skills (provides source paths)
 * @param {string[]} agents - Agent names the skills are installed for
 * @param {{ allowedRoot?: string }} [options] - Passed to the content hash
 * @returns {Promise<Record<string, string>>} Map of `<agent>/<skillName>` → hash
 */
export async function computeAiSkillFolderHashes(
    selectedSkills,
    aiSkills,
    agents,
    options = {}
) {
    const hashed = await hashAiSkillFolders(selectedSkills, aiSkills, options);

    /** @type {Record<string, string>} */
    const result = {};
    for (const entries of hashed.values()) {
        for (const { name, hashes } of entries) {
            for (const agent of agents) {
                result[`${agent}/${name}`] = hashes.get(copyFor(agent, agents));
            }
        }
    }

    return result;
}

/**
 * Writes the agent's own files into an installed AI skill directory: for
 * every agent but Claude Code, its SKILL.md and, for Codex and an
 * explicit-only skill, `agents/openai.yaml`. An installed file (a copy, or in
 * a symlink install a link into the submodule) is removed first and never
 * written through, so the submodule's own files are left unchanged.
 *
 * @param {AiSkill} skill
 * @param {string} agent - Agent name
 * @param {string} targetDir - The installed skill directory
 * @param {string[]} agents - Every selected agent (decides a shared directory's copy)
 * @returns {Promise<void>}
 */
export async function writeAgentFiles(skill, agent, targetDir, agents) {
    const files = skill.variants.get(copyFor(agent, agents));
    if (!files) {
        return;
    }
    for (const [relPath, bytes] of files) {
        const parts = relPath.split('/');
        const target = safePathJoin(targetDir, ...parts);
        try {
            await fsp.unlink(target);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        if (parts.length > 1) {
            await fsp.mkdir(safePathJoin(targetDir, ...parts.slice(0, -1)), {
                recursive: true,
            });
        }
        await fsp.writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    }
}

/**
 * Removes a path (file, symlink, or directory). No-op if it doesn't exist.
 * @param {string} p
 */
async function removePathRecursive(p) {
    try {
        const stats = await fsp.lstat(p);
        if (stats.isSymbolicLink() || stats.isFile()) {
            await fsp.unlink(p);
        } else if (stats.isDirectory()) {
            await fsp.rm(p, { recursive: true, force: true });
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

/**
 * Post-pull update for AI skills, kept self-contained so the native updater
 * has no knowledge of external skills. AI skills are tracked at the domain
 * level, so the manifest does not record which individual skills were
 * installed — instead we scan each agent's target directory for installed AI
 * skills (by membership in the discovered list) and reinstall the ones whose
 * domain content changed, the way they were installed (copy or symlink), each
 * with the agent's own files.
 *
 * @param {string} sourcePath - LaunchBridge source root
 * @param {string} targetRepo - Target repository root
 * @param {object} manifest - Existing version manifest (provides group hashes, agents, method)
 * @param {{ muted: Function, success: Function, warn: Function }} ui
 * @returns {Promise<{ updated: string[], newHashes: Record<string, string>,
 *   newFolderHashes: Record<string, string> }>} updated skill names, refreshed
 *   group hashes, and refreshed per-agent digests (all merged into the manifest)
 */
export async function updateAiSkills(sourcePath, targetRepo, manifest, ui) {
    const { muted, success, warn } = ui;
    const aiSkills = discoverAiSkills(sourcePath, {
        nativeNames: new Set(discoverSkills(sourcePath).map((s) => s.name)),
        onWarn: warn,
    });
    if (aiSkills.length === 0) {
        return { updated: [], newHashes: {}, newFolderHashes: {} };
    }

    const installMethod = manifest.installMethod;
    const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
    const oldHashes = manifest.skillHashes || {};

    const { getTargetPath, checkSkillsDirectory } =
        await import('./pathValidator.js');
    const { readInstalledTargets, namesUnder } =
        await import('./installedTargets.js');
    const installedTargets = readInstalledTargets(manifest);

    // Scan each agent's target dir for installed AI skills. When the manifest
    // records which directories LaunchBridge installed, only those count; a
    // same-named directory it skipped is left alone.
    const installedByAgent = new Map();
    const allInstalled = new Set();
    for (const agent of agents) {
        let base;
        try {
            base = getTargetPath(agent, 'local', targetRepo);
        } catch {
            continue;
        }
        const dirCheck = await checkSkillsDirectory(base, targetRepo);
        if (!dirCheck.ok) {
            warn(`  Skipped AI skills for ${agent}: ${dirCheck.reason}`);
            continue;
        }
        let entries;
        try {
            entries = await fsp.readdir(base, { withFileTypes: true });
        } catch {
            continue;
        }
        const names = entries
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name)
            .filter((n) => isAiSkill(n, aiSkills));
        const owned = installedTargets
            ? names.filter((n) =>
                  namesUnder(installedTargets, targetRepo, base).has(n)
              )
            : names;
        installedByAgent.set(agent, owned);
        owned.forEach((n) => allInstalled.add(n));
    }

    if (allInstalled.size === 0) {
        return { updated: [], newHashes: {}, newFolderHashes: {} };
    }

    // Recompute hashes from the union of installed AI skills. Links that leave
    // the LaunchBridge source tree are not hashed (or copied, below).
    const allowedRoot = await fsp.realpath(sourcePath);
    const newHashes = await computeAiGroupHashes([...allInstalled], aiSkills, {
        allowedRoot,
    });
    // Refreshed alongside the group hashes: an update that changed the source
    // must move the per-agent digests too, or the next integrity check reports
    // the update as tampering.
    const newFolderHashes = await computeAiSkillFolderHashes(
        [...allInstalled],
        aiSkills,
        agents,
        { allowedRoot }
    );
    const changedGroups = Object.keys(newHashes).filter(
        (group) => newHashes[group] !== oldHashes[group]
    );

    // A symlink install needs the reinstall as much as a copy: it has links
    // only for the files a skill had at install time, and every agent but
    // Claude Code has its own files written in place of links.
    const install =
        installMethod === 'copy'
            ? (src, target) =>
                  copySkill(src, target, {
                      allowedRoot,
                      onSkip: (link, resolved) =>
                          warn(
                              `  Skipped link outside the LaunchBridge source: ${link} -> ${resolved}`
                          ),
                  })
            : installMethod === 'symlink'
              ? (src, target) => createSymlink(src, target)
              : null;

    const updated = [];

    if (install && changedGroups.length > 0) {
        const changedSet = new Set(changedGroups);

        for (const [agent, names] of installedByAgent) {
            const base = getTargetPath(agent, 'local', targetRepo);
            for (const name of names) {
                if (!changedSet.has(aiTrackingKey(name, aiSkills))) {
                    continue;
                }
                const skill = findAiSkill(name, aiSkills);
                if (!skill) {
                    continue;
                }
                const target = safePathJoin(base, name);
                try {
                    await removePathRecursive(target);
                    await install(skill.path, target);
                    await writeAgentFiles(skill, agent, target, agents);
                    muted(`  Updated AI skill: ${name} (${agent})`);
                    if (!updated.includes(name)) {
                        updated.push(name);
                    }
                } catch (err) {
                    warn(
                        `  Could not update AI skill ${name} for ${agent}: ${err.message}`
                    );
                }
            }
        }

        if (updated.length > 0) {
            success(
                `${updated.length} AI skill(s) reinstalled from updated source.`
            );
        }
    }

    return { updated, newHashes, newFolderHashes };
}
