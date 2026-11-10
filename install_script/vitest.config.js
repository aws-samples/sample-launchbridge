// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

// vitest is started from the repository root (`npm test`), so anchor paths here.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        root: here,
        setupFiles: [path.join(here, '__tests__/setup/isolateState.js')],
    },
});
