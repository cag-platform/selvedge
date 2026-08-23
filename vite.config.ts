import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * PRELOAD THE TWO FACES THE FIRST PAINT ACTUALLY USES.
 *
 * The fonts are self-hosted already (@fontsource in index.css), so there is no
 * Google round-trip to remove — but they are still discovered only once the
 * browser has downloaded and parsed the stylesheet, which puts the hero's
 * Fraunces one full round-trip behind where it could be. On a cold Fast 3G
 * load that is most of the gap between a fast page and a nearly fast one.
 *
 * It has to be a plugin rather than two lines in index.html because the
 * filenames are content-hashed at build time. Fifteen lines and no dependency:
 * a package to do this would be a package to keep, for a `<link>` tag.
 *
 * Only the two the landing paints with — the display face for the headline and
 * the body face for the lede. Preloading all six would spend the same
 * connection budget fetching faces nothing on screen is set in, which is the
 * usual way this optimisation turns into its opposite.
 */
function preloadLandingFonts(): Plugin {
  const wanted = [/fraunces-latin-wght-normal.*\.woff2$/, /inter-tight-latin-wght-normal.*\.woff2$/];
  return {
    name: 'selvedge:preload-landing-fonts',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html, ctx) {
      const fonts = Object.keys(ctx.bundle ?? {}).filter((f) => wanted.some((re) => re.test(f)));
      return {
        html,
        tags: fonts.map((file) => ({
          tag: 'link',
          attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${file}`, crossorigin: '' },
          injectTo: 'head-prepend' as const,
        })),
      };
    },
  };
}

export default defineConfig({
  root: 'src/client',
  plugins: [react(), preloadLandingFonts()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/webhooks': 'http://localhost:3000',
    },
  },
});
