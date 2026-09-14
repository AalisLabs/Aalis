import { defineConfig } from 'vitest/config';
import { resolveDshSource } from './dsh-source.mjs';

const dshSource = resolveDshSource();

// Deliberately separate from the product regression suite: these tests document
// both supported contracts and observed limitations of the evaluated snapshot.
export default defineConfig({
  // The repository's Vitest uses an older esbuild than DSH. Fix a common
  // transpilation target rather than inheriting DSH's ES2024 tsconfig target.
  esbuild: { target: 'es2022', tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } } },
  test: {
    include: ['experiments/core-evaluation/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: /^@aalis\/([a-z0-9-]+)$/, replacement: `${import.meta.dirname}/../../packages/$1/src/index.ts` },
      ...(dshSource
        ? [
            { find: '@deepseek-ai/cordis', replacement: `${dshSource}/vendor/cordis/src/index.ts` },
            { find: '@deepseek-ai/cosmokit', replacement: `${dshSource}/vendor/cosmokit/src/index.ts` },
          ]
        : []),
    ],
  },
});
