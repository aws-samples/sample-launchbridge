// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['./__tests__/setup/isolateState.js'],
    },
});
