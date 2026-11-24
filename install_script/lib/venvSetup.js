// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Virtual Environment Setup Module
 *
 * Generates a scoped pyproject.toml for the selected skills and writes it to
 * .lb_workspace/config/python_deps/pyproject.toml in the target repository.
 *
 * Placing it in its own subdirectory means pip can find it naturally, next to the
 * frozen constraints.txt it is always installed with:
 *   pip install -e ".lb_workspace/config/python_deps[all]" -c .lb_workspace/config/python_deps/constraints.txt
 *
 * The actual venv creation and dependency installation is deferred to the
 * lb-setup agent skill, which runs `uv venv .venv_lb` (reading requires-python
 * from this file) and then `pip install -e ".[all]" -c constraints.txt` inside
 * python_deps/.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { spinner } from './ui.js';
import { isDebug, debug } from './debug.js';
import { spawn } from 'child_process';
import { safePathJoin } from './pathSanitizer.js';
import crypto from 'crypto';
import { writeRepoState } from './stateDir.js';

/** File in the repository's state directory recording python_deps' digests. */
export const PYTHON_DEPS_RECORD = 'python_deps.json';

// Allowed Python commands (hardcoded, not user input)
const ALLOWED_PYTHON_COMMANDS = ['python3', 'python'];

/**
 * Default minimum Python version. Used as fallback if the canonical
 * pyproject.toml cannot be read at runtime.
 */
const DEFAULT_MIN_PYTHON_VERSION = [3, 12];

/**
 * Reads the `requires-python` value from the canonical pyproject.toml
 * at project_dependencies/pyproject.toml relative to the launchbridge source root.
 *
 * @param {string|null} sourcePath - Root of the launchbridge source repo
 * @returns {string} The requires-python specifier (e.g. ">=3.12"), or default if unreadable
 */
function readRequiresPython(sourcePath) {
    if (!sourcePath) return `>=${DEFAULT_MIN_PYTHON_VERSION.join('.')}`;
    try {
        const pyprojectPath = safePathJoin(
            sourcePath,
            'project_dependencies',
            'pyproject.toml'
        );
        const content = fsSync.readFileSync(pyprojectPath, 'utf8');
        const match = content.match(/requires-python\s*=\s*"([^"]+)"/);
        if (match) return match[1];
    } catch {
        // Fall through to default
    }
    return `>=${DEFAULT_MIN_PYTHON_VERSION.join('.')}`;
}

/**
 * Parses a requires-python specifier (e.g. ">=3.12") into [major, minor].
 *
 * @param {string} spec - The requires-python value
 * @returns {[number, number]} [major, minor]
 */
function parseMinVersionFromSpec(spec) {
    const match = spec.match(/(\d+)\.(\d+)/);
    if (match) return [parseInt(match[1], 10), parseInt(match[2], 10)];
    return DEFAULT_MIN_PYTHON_VERSION;
}

// ---------------------------------------------------------------------------
// TOML Parsing Utilities
// ---------------------------------------------------------------------------

/**
 * Parses the `dependencies = [...]` array from a TOML file into an array of
 * unquoted string values. Comments and blank lines are stripped.
 *
 * Only the literal field name "dependencies" is supported. Using a hardcoded
 * regex literal (rather than dynamic RegExp construction) avoids any ReDoS risk.
 *
 * @param {string} content - Full TOML file content
 * @param {string} fieldName - Must be "dependencies"
 * @returns {string[]} Array of dependency strings
 */
function parseTomlArray(content, fieldName) {
    if (fieldName !== 'dependencies') return [];
    // Hardcoded literal regex — avoids dynamic RegExp() and ReDoS risk.
    const regex = /^dependencies\s*=\s*\[([^\]]*?)\]/ms;
    const match = content.match(regex);
    if (!match) return [];
    return match[1]
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('"'))
        .map((line) =>
            line
                .replace(/^"/, '')
                .replace(/",?\s*(#.*)?$/, '')
                .trim()
        );
}

/**
 * Parses all optional-dependency groups from a TOML file.
 * Looks for the `[project.optional-dependencies]` section and extracts each
 * `group_name = [...]` block.
 *
 * @param {string} content - Full TOML file content
 * @returns {Record<string, string[]>} Map of group name → dependency strings
 */
function parseTomlOptionalDeps(content) {
    const sectionStart = content.indexOf('[project.optional-dependencies]');
    if (sectionStart === -1) return {};

    // Slice from section header to the next top-level section (or end of file)
    let sectionContent = content.slice(
        sectionStart + '[project.optional-dependencies]'.length
    );
    const nextSection = sectionContent.search(/^\[(?!project\.optional)/m);
    if (nextSection !== -1) {
        sectionContent = sectionContent.slice(0, nextSection);
    }

    const result = {};
    // Match group_name = [ ... ] blocks. We can't use a simple non-greedy match
    // because dep strings may contain brackets (e.g. "package[extra]").
    // Instead, match from `name = [` to a closing `]` that appears on its own line
    // (or at end of content after only whitespace).
    const groupRegex = /^([\w][\w-]*)\s*=\s*\[([\s\S]*?)\n\]/gm;
    let groupMatch;
    while ((groupMatch = groupRegex.exec(sectionContent)) !== null) {
        const groupName = groupMatch[1];
        const deps = groupMatch[2]
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('"'))
            .map((line) =>
                line
                    .replace(/^"/, '')
                    .replace(/",?\s*(#.*)?$/, '')
                    .trim()
            );
        if (deps.length > 0) {
            result[groupName] = deps;
        }
    }

    return result;
}

/**
 * Reads dependencies from the canonical pyproject.toml at
 * project_dependencies/pyproject.toml relative to the launchbridge source root.
 *
 * @param {string|null} sourcePath - Root of the launchbridge source repo
 * @returns {{coreDeps: string[], optionalDeps: Record<string, string[]>} | null}
 *   Parsed deps, or null if the file can't be read.
 */
function readDependenciesFromToml(sourcePath) {
    if (!sourcePath) return null;
    try {
        const tomlPath = safePathJoin(
            sourcePath,
            'project_dependencies',
            'pyproject.toml'
        );
        const content = fsSync.readFileSync(tomlPath, 'utf8');

        const coreDeps = parseTomlArray(content, 'dependencies');
        const optionalDeps = parseTomlOptionalDeps(content);

        return { coreDeps, optionalDeps };
    } catch {
        return null;
    }
}

/**
 * @typedef {Object} PyprojectResult
 * @property {boolean} success - Whether the file was written successfully
 * @property {string} [filePath] - Path to the written pyproject.toml
 * @property {string} [error] - Error message if failed
 */

/**
 * Spawns one of the allowlisted Python commands. The executable is selected
 * via an index into a hardcoded constant array, so no caller-supplied string
 * ever flows into spawn().
 *
 * @param {number} cmdIndex - Index into ALLOWED_PYTHON_COMMANDS
 * @param {string[]} args - Command arguments
 * @param {Object} options - Spawn options
 * @returns {import('child_process').ChildProcess}
 */
function spawnAllowedPython(cmdIndex, args, options) {
    // Each branch hardcodes the executable so static analysis can see that
    // spawn() is never called with a function argument.
    if (cmdIndex === 0) {
        return spawn('python3', args, options);
    }
    if (cmdIndex === 1) {
        return spawn('python', args, options);
    }
    throw new Error(`Invalid python command index: ${cmdIndex}`);
}

/**
 * Executes a command and returns a promise with the result.
 * Only commands in ALLOWED_PYTHON_COMMANDS are permitted to prevent
 * command injection from untrusted input.
 *
 * @param {string} command - The command to execute (must be in allowed list)
 * @param {string[]} args - Command arguments
 * @param {Object} options - Spawn options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function execCommand(command, args, options = {}) {
    // Validate command against allowlist; map to a fixed index so spawn()
    // is invoked with a hardcoded literal (see spawnAllowedPython).
    const allowedIndex = ALLOWED_PYTHON_COMMANDS.indexOf(command);
    if (allowedIndex === -1) {
        return Promise.resolve({
            code: 1,
            stdout: '',
            stderr: `Command not allowed: ${command}. Only ${ALLOWED_PYTHON_COMMANDS.join(', ')} are permitted.`,
        });
    }

    return new Promise((resolve) => {
        const debugMode = isDebug();
        if (debugMode) {
            debug(
                `$ ${ALLOWED_PYTHON_COMMANDS[allowedIndex]} ${args.join(' ')}`
            );
        }

        const proc = spawnAllowedPython(allowedIndex, args, options);

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            if (debugMode) process.stdout.write(chunk);
        });

        proc.stderr?.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            if (debugMode) process.stderr.write(chunk);
        });

        proc.on('close', (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });

        proc.on('error', (err) => {
            resolve({ code: 1, stdout, stderr: err.message });
        });
    });
}

/**
 * Parses a Python version string (e.g., "Python 3.11.4") into [major, minor].
 *
 * @param {string} versionOutput - Output from python --version
 * @returns {[number, number] | null} [major, minor] or null if parsing fails
 */
function parsePythonVersion(versionOutput) {
    const match = versionOutput.match(/Python\s+(\d+)\.(\d+)/);
    if (!match) return null;
    return [parseInt(match[1], 10), parseInt(match[2], 10)];
}

/**
 * Checks if a Python version meets the minimum requirement.
 *
 * @param {[number, number]} version - [major, minor] version
 * @param {[number, number]} [minVersion] - Minimum required [major, minor]
 * @returns {boolean}
 */
function meetsMinVersion(version, minVersion = DEFAULT_MIN_PYTHON_VERSION) {
    const [major, minor] = version;
    const [minMajor, minMinor] = minVersion;
    return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Finds a Python executable that meets the minimum version requirement.
 *
 * @returns {Promise<string|null>} The Python command or null if not found
 */
export async function findPython() {
    for (const cmd of ALLOWED_PYTHON_COMMANDS) {
        const result = await execCommand(cmd, ['--version']);
        if (result.code === 0) {
            const version = parsePythonVersion(result.stdout || result.stderr);
            if (version && meetsMinVersion(version)) {
                return cmd;
            }
        }
    }
    return null;
}

/**
 * Maps skill directory names to their optional-dependency extra group names
 * (one name, or a list). Skills not listed here contribute no extra
 * dependencies beyond core.
 *
 * @type {Record<string, string | string[]>}
 */
export const SKILL_TO_EXTRA = {
    'indexing-and-qa': 'indexing_and_qa',
    'config-prompt-registry': 'config_prompt_registry',
    'testing-framework': 'testing-skill',
    // The media extra too: nothing can be added to .venv_lb after lb-setup
    // seals it, and image, audio and video metrics need it.
    'evaluate-predictions': ['eval_toolkit', 'eval_toolkit_media'],
    'generate-predictions': 'eval_toolkit',
    'data-wrangler': 'eval_toolkit',
};
/**
 * Builds the content of a scoped pyproject.toml for the given skills.
 * Only includes extras that are needed by the selected skills.
 *
 * Both core dependencies and optional-dependency groups (extras) come solely
 * from the canonical pyproject.toml — there is no hardcoded fallback. If the
 * canonical TOML cannot be read, the respective dependency lists are empty.
 *
 * @param {string[]} selectedSkills - Skill directory names that were installed
 * @param {string} requiresPython - The requires-python specifier
 * @param {{coreDeps: string[], optionalDeps: Record<string, string[]>} | null} tomlDeps -
 *   Dependencies parsed from the canonical TOML.
 * @returns {string} TOML content
 */
export function buildPyprojectContent(
    selectedSkills,
    requiresPython = '>=3.12',
    tomlDeps = null
) {
    const coreDeps = tomlDeps?.coreDeps ?? [];
    const extraDeps = tomlDeps?.optionalDeps ?? null;

    // Resolve the unique set of extras needed
    const neededExtras = [
        ...new Set(selectedSkills.flatMap((s) => SKILL_TO_EXTRA[s] ?? [])),
    ];

    const lines = [
        '# Auto-generated by the LaunchBridge installer.',
        '# Do not edit manually — re-run the installer to regenerate.',
        '# lb-setup will create .venv_lb and install from this file.',
        '',
        '[build-system]',
        'requires = ["setuptools>=61"]',
        'build-backend = "setuptools.build_meta"',
        '',
        '[project]',
        'name = "launchbridge-skills"',
        'version = "0.1.0"',
        `requires-python = "${requiresPython}"`,
        '',
        'dependencies = [',
        ...coreDeps.map((d) => `    "${d}",`),
        ']',
    ];

    if (neededExtras.length > 0) {
        lines.push('', '[project.optional-dependencies]');
        for (const extra of neededExtras) {
            const deps = extraDeps?.[extra] ?? [];
            lines.push(`${extra} = [`);
            for (const dep of deps) {
                lines.push(`    "${dep}",`);
            }
            lines.push(']');
        }

        // Convenience "all" extra that installs everything selected
        lines.push('', `all = [`);
        lines.push(`    "launchbridge-skills[${neededExtras.join(',')}]",`);
        lines.push(']');
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * The two python_deps files for the selected skills: the scoped
 * pyproject.toml, and the frozen constraints.txt it is always installed with.
 * A global install writes them into lb-setup's generated assets, and lb-setup
 * copies them into each repository it prepares.
 *
 * @param {string} sourcePath - Root of the launchbridge source repo
 * @param {string[]} selectedSkills
 * @returns {{ pyproject: string, constraints: Buffer }}
 * @throws {Error} When project_dependencies/constraints.txt is missing
 */
export function buildPythonDepsFiles(sourcePath, selectedSkills = []) {
    const constraintsPath = safePathJoin(
        sourcePath,
        'project_dependencies',
        'constraints.txt'
    );
    if (!fsSync.existsSync(constraintsPath)) {
        throw new Error(
            'project_dependencies/constraints.txt is missing from the LaunchBridge source. ' +
                'Restore it (git checkout -- project_dependencies/constraints.txt) and run the installer again.'
        );
    }
    return {
        pyproject: buildPyprojectContent(
            selectedSkills,
            readRequiresPython(sourcePath),
            readDependenciesFromToml(sourcePath)
        ),
        constraints: fsSync.readFileSync(constraintsPath),
    };
}

/**
 * Writes the scoped pyproject.toml to .lb_workspace/config/python_deps/pyproject.toml
 * in the target repository. The python_deps/ subdirectory is a self-contained
 * installable package, installed with its constraints:
 *   pip install -e ".lb_workspace/config/python_deps[all]" -c .lb_workspace/config/python_deps/constraints.txt
 *
 * @param {string} targetRepo - Root path of the target repository
 * @param {string[]} selectedSkills - Skill directory names that were installed
 * @param {string|null} sourcePath - Root of the launchbridge source repo, whose
 *   project_dependencies/ holds the canonical pyproject.toml and constraints.txt
 * @returns {Promise<PyprojectResult>}
 */
export async function writePyprojectConfig(
    targetRepo,
    selectedSkills = [],
    sourcePath = null
) {
    const pkgDir = safePathJoin(
        targetRepo,
        '.lb_workspace',
        'config',
        'python_deps'
    );
    // pkgDir is the target folder plus fixed segments; the file name is fixed.
    // nosemgrep: path-join-resolve-traversal
    const filePath = path.join(pkgDir, 'pyproject.toml');

    const localProjectDeps = sourcePath
        ? safePathJoin(sourcePath, 'project_dependencies')
        : null;

    // Read dependencies from the canonical TOML (empty if it cannot be read)
    const tomlDeps = readDependenciesFromToml(sourcePath);

    // Recreated from scratch: lb-setup installs from this folder, and any other
    // file in it (a setup.py, a module setuptools would pick up) could have
    // arrived with the repository.
    try {
        await fs.rm(pkgDir, { recursive: true, force: true });
        await fs.mkdir(pkgDir, { recursive: true });
    } catch (err) {
        return {
            success: false,
            error: `Could not create python_deps dir: ${err.message}`,
        };
    }

    // The frozen dependency set (project_dependencies/constraints.txt, written by
    // install_script/freeze_deps.py) goes next to the generated pyproject.toml,
    // where lb-setup installs with it. lb-setup installs only with constraints, so
    // a source without them is an error, not an unconstrained install.
    const constraintsPath = safePathJoin(pkgDir, 'constraints.txt');
    const sourceConstraints = localProjectDeps
        ? safePathJoin(localProjectDeps, 'constraints.txt')
        : null;
    try {
        if (!sourceConstraints || !fsSync.existsSync(sourceConstraints)) {
            await fs.rm(constraintsPath, { force: true });
            return {
                success: false,
                error:
                    'project_dependencies/constraints.txt is missing from the LaunchBridge source. ' +
                    'Restore it (git checkout -- project_dependencies/constraints.txt) and run the installer again.',
            };
        }
        await fs.copyFile(sourceConstraints, constraintsPath);
    } catch (err) {
        return {
            success: false,
            error: `Could not write constraints.txt: ${err.message}`,
        };
    }

    try {
        const requiresPython = readRequiresPython(sourcePath);
        const content = buildPyprojectContent(
            selectedSkills,
            requiresPython,
            tomlDeps
        );
        await fs.writeFile(filePath, content, 'utf8');
    } catch (err) {
        return {
            success: false,
            error: `Could not write pyproject.toml: ${err.message}`,
        };
    }

    // Record what was written, outside the repository. lb-setup installs .venv_lb
    // from these two files, and python_deps/ can arrive with a repository, so it
    // installs only from files that match this record.
    try {
        const digest = async (file) =>
            crypto
                .createHash('sha256')
                .update(await fs.readFile(file))
                .digest('hex');
        const record = {
            'pyproject.toml': await digest(filePath),
            'constraints.txt': await digest(constraintsPath),
        };
        await writeRepoState(
            targetRepo,
            PYTHON_DEPS_RECORD,
            JSON.stringify(record, null, 2) + '\n'
        );
    } catch (err) {
        return {
            success: false,
            error: `Could not record the Python dependency config: ${err.message}`,
        };
    }
    return { success: true, filePath };
}

/**
 * Runs the pyproject config generation and displays results.
 *
 * @param {string} targetRepo - Root path of the target repository
 * @param {string[]} selectedSkills - Skill directory names that were installed
 * @returns {Promise<{ok: boolean, error?: string}>} ok is true if the file was written; otherwise error says why
 */
export async function runVenvSetup(
    targetRepo,
    sourcePath,
    selectedSkills = []
) {
    const debugMode = isDebug();
    const spin = debugMode
        ? null
        : spinner('Generating Python dependency config');
    if (debugMode)
        debug('Generating .lb_workspace/config/python_deps/pyproject.toml...');

    let result;
    try {
        result = await writePyprojectConfig(
            targetRepo,
            selectedSkills,
            sourcePath
        );
    } catch (err) {
        if (spin)
            spin.stop(
                `Failed to generate dependency config: ${err.message}`,
                true
            );
        else debug(`Failed to generate dependency config: ${err.message}`);
        return { ok: false, error: err.message };
    }

    if (result.success) {
        const msg =
            'Python dependency config written to .lb_workspace/config/python_deps/pyproject.toml';
        if (spin) spin.stop(msg);
        else debug(msg);
        return { ok: true };
    } else {
        if (spin)
            spin.stop(
                `Failed to generate dependency config: ${result.error}`,
                true
            );
        else debug(`Failed to generate dependency config: ${result.error}`);
        return { ok: false, error: result.error };
    }
}

// Export internals for testing
export { readDependenciesFromToml, parseTomlArray, parseTomlOptionalDeps };
