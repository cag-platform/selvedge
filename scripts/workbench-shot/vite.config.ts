import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Serves the screenshot harness only — never part of the shipped bundle. */
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});
