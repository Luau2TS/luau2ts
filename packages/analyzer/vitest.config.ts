import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // The analyzer test cases load a ~5 MB WASM module on first use;
    // bump the per-test timeout so cold-start doesn't trip vitest's
    // default 5 s budget.
    testTimeout: 30000,
  },
});
