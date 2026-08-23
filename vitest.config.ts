import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The automatic JSX runtime, so a component test needs no React import and
  // reads the same as the component it renders.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    // Runs before any test file: clears every ambient credential and pins the
    // few the suite needs, so the same program runs on a laptop and in CI. See
    // test/setup.ts for what that cost us before it existed.
    setupFiles: ['./test/setup.ts'],
    // .tsx too: the landing page's rust ration is a rule about rendered
    // output, so the only way to hold it is to render the component.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/server/routing/**/*.ts'],
      exclude: ['src/server/routing/types.ts'],
      thresholds: {
        'src/server/routing/**/*.ts': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
      },
    },
  },
});
