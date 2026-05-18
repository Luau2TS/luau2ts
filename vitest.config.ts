import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Several tests run a loop of compile() calls (the every-datatype-
    // constructor macros sweep, the Prettier-on-by-default test).
    // Each individual compile is fast, but the loop can take 5-8s on
    // CI runners under load, and longer under the coverage job's v8
    // instrumentation. The 5000ms default flakes on those specific
    // cases. 15000ms gives headroom without masking real performance
    // regressions; anything pushing past 15s is worth investigating.
    testTimeout: 15000,
  },
});
