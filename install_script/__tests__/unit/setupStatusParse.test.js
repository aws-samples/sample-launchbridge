// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * setup_status.md keeps lb-setup's progress. An editor or PowerShell on
 * Windows can save it with CRLF line endings, and the installer reads its rows
 * whatever the line endings, as bootstrap_workspace.py does, so a rerun keeps
 * the progress.
 */

import { describe, it, expect } from 'vitest';
import {
    buildMarkdownTable,
    parseSetupStatusContent,
} from '../../lib/setupStatus.js';

describe('parseSetupStatusContent', () => {
    const rows = [
        { name: 'venv-setup', status: 'complete' },
        { name: 'testing-framework', status: 'in progress' },
    ];

    it.each([
        ['LF', '\n'],
        ['CRLF', '\r\n'],
        ['CR', '\r'],
    ])('reads the rows of a file with %s line endings', (_, newline) => {
        const content = buildMarkdownTable(rows).replaceAll('\n', newline);

        expect(parseSetupStatusContent(content)).toEqual(
            new Map(rows.map(({ name, status }) => [name, status]))
        );
    });
});
