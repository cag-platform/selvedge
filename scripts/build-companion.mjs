import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/client/selvedge-companion.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
});

// A CommonJS bundle for Node's Single Executable Application container. The
// native Mac app embeds this into an official Node runtime, so customers do not
// install Node or run a shell before Selvedge can start.
await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/mac/selvedge-companion.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  minify: false,
});
