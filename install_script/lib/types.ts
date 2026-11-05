// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Type definitions for the Skill Installer Script
 *
 * This module defines all TypeScript interfaces and types used throughout
 * the skill installer CLI tool.
 */

import { AGENTS } from './agentConfig.js';

/** Union of all valid agent identifiers, derived from AGENTS keys. */
export type Agent = keyof typeof AGENTS;

/** Shape of a single agent's configuration entry. */
export type AgentConfig = (typeof AGENTS)[Agent];

// =============================================================================
// Core Types
// =============================================================================

/**
 * Installation scope options
 * - 'local': Install skills within the target repository
 * - 'global': Install skills in the user's home directory
 */
export type Scope = 'local' | 'global';

/**
 * Installation method options
 * - 'symlink': Create symbolic links from target to source
 * - 'copy': Copy skill files from source to target
 */
export type Method = 'symlink' | 'copy';

/**
 * Conflict resolution options when a skill already exists
 * - 'overwrite': Replace the existing skill
 * - 'overwriteAll': Replace this and all remaining conflicting skills
 * - 'skip': Skip this skill and continue
 * - 'cancel': Cancel the entire installation
 */
export type ConflictResolution =
    | 'overwrite'
    | 'overwriteAll'
    | 'skip'
    | 'cancel';

// =============================================================================
// Skill Interface
// =============================================================================

/**
 * Represents a discovered skill in the source repository
 */
export interface Skill {
    /** Name of the skill (directory name) */
    name: string;
    /** Full path to the skill directory */
    path: string;
    /** Whether the skill has a SKILL.md file */
    hasSkillMd: boolean;
    /** Whether the skill has a references/ directory */
    hasReferences: boolean;
    /** Whether the skill has a scripts/ directory */
    hasScripts: boolean;
}

// =============================================================================
// User Selection Interfaces
// =============================================================================

/**
 * User's selections during the installation wizard
 */
export interface UserSelections {
    /** Selected agents to install skills for */
    agents: Agent[];
    /** Installation scope (local or global) */
    scope: Scope;
    /** Installation method (symlink or copy) */
    method: Method;
    /** Path to the source repository */
    sourcePath: string;
    /** Names of selected skills to install */
    skills: string[];
}

// =============================================================================
// Result Interfaces
// =============================================================================

/**
 * Result of a single skill installation attempt
 */
export interface InstallationResult {
    /** Name of the skill that was installed */
    skillName: string;
    /** Agent the skill was installed for */
    agent: Agent;
    /** Whether the installation succeeded */
    success: boolean;
    /** Error message if installation failed */
    error?: string;
    /** Path where the skill was installed */
    targetPath: string;
}

/**
 * Result of verifying a skill installation
 */
export interface VerificationResult {
    /** Name of the skill that was verified */
    skillName: string;
    /** Agent the skill was verified for */
    agent: Agent;
    /** Whether the verification passed */
    verified: boolean;
    /** Error message if verification failed */
    error?: string;
}

/**
 * Result of validating a path
 */
export interface ValidationResult {
    /** Whether the path is valid */
    valid: boolean;
    /** Error message if validation failed */
    error?: string;
    /** Resolved absolute path if valid */
    resolvedPath?: string;
}

// =============================================================================
// Context and State Interfaces
// =============================================================================

/**
 * Context for executing an installation
 */
export interface InstallationContext {
    /** User's selections from the wizard */
    selections: UserSelections;
    /** Path to the target repository */
    targetRepository: string;
}

/**
 * Complete state of an installation session
 */
export interface InstallationState {
    /** Path to the source repository */
    sourcePath: string;
    /** Path to the target repository */
    targetRepository: string;
    /** User's selections from the wizard */
    selections: UserSelections;
    /** Results of installation attempts */
    results: InstallationResult[];
    /** Results of verification checks */
    verifications: VerificationResult[];
}

// =============================================================================
// Report Interface
// =============================================================================

/**
 * Categorized installation report for final display
 */
export interface InstallationReport {
    /** Successfully installed skills */
    successful: InstallationResult[];
    /** Failed skill installations */
    failed: InstallationResult[];
    /** Skipped skill installations */
    skipped: InstallationResult[];
}
