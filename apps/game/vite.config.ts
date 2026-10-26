import { defineConfig } from 'vite';

export default defineConfig({
  // Track and car packages live in the repo-level public/ folder.
  publicDir: '../../public',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
  },
});
