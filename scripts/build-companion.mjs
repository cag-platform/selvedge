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
