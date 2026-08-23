import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Serves the OG card only — never part of the shipped bundle. */
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  server: { port: 5198, strictPort: true },
});
