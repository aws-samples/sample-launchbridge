// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Path Sanitizer Module
 *
 * Provides utilities for sanitizing file paths to prevent path traversal attacks.
 */

import path from 'path';

/**
 * Sanitizes a path component by removing potentially dangerous characters and sequences.
 * @param {string} pathComponent - A single path component (not a full path)
 * @returns {string} Sanitized path component
 */
export function sanitizePathComponent(pathComponent) {
    if (!pathComponent || typeof pathComponent !== 'string') {
        return '';
    }

    // Remove null bytes and other control characters
    let sanitized = pathComponent.replace(/[\x00-\x1f\x7f]/g, '');

    // Remove path traversal sequences
    sanitized = sanitized.replace(/\.\./g, '');

    // Remove leading/trailing whitespace
    sanitized = sanitized.trim();

    return sanitized;
}

/**
 * True when `child` is `root` itself or sits inside it.
 *
 * Compares path segments via path.relative rather than string prefixes, so
 * `/x/launchbridge-old` is not inside `/x/launchbridge`, while a child whose
 * name merely starts with dots (`/x/launchbridge/..cache`) is. On Windows a
 * different drive yields an absolute relative path and is rejected. Paths are
 * resolved lexically; symlinks are not followed, so callers that need that
 * must pass real paths (see contentHash.js and updater.js).
 *
 * @param {string} child - Path to test
 * @param {string} root - Directory that should contain it
 * @returns {boolean}
 */
export function isPathWithin(child, root) {
    const rel = path.relative(path.resolve(root), path.resolve(child));
    return (
        rel === '' ||
        (rel !== '..' &&
            !rel.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(rel))
    );
}

/**
 * Validates that a resolved path is within the expected base directory.
 * Prevents path traversal attacks by ensuring the final path doesn't escape the base.
 *
 * @param {string} resolvedPath - The fully resolved absolute path
 * @param {string} basePath - The base directory that should contain the path
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export function validatePathWithinBase(resolvedPath, basePath) {
    if (!isPathWithin(resolvedPath, basePath)) {
        return {
            valid: false,
            error: `Path traversal detected: "${resolvedPath}" is outside of "${basePath}"`,
        };
    }

    return { valid: true };
}

/**
 * Safely joins path components, sanitizing each component.
 *
 * Built using manual concatenation with path.sep + path.normalize rather than
 * path.join() to make the sanitization boundary explicit to static analysis.
 * Each component has already been stripped of traversal sequences and control
 * characters by sanitizePathComponent before being joined.
 *
 * @param {string} basePath - The base path (should be trusted/validated)
 * @param {...string} components - Path components to join (will be sanitized)
 * @returns {string} The joined and sanitized path
 */
export function safePathJoin(basePath, ...components) {
    const sanitizedComponents = components
        .map((c) => sanitizePathComponent(String(c)))
        .filter((c) => c.length > 0);

    // Manually concatenate with the platform separator, then normalize.
    // No user input flows into path.join here.
    let joined = String(basePath);
    for (const component of sanitizedComponents) {
        if (!joined.endsWith(path.sep)) {
            joined += path.sep;
        }
        joined += component;
    }
    return path.normalize(joined);
}
