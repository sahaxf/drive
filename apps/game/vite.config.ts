import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';
import { controllerRelayPlugin } from './server/controllerRelay';

export default defineConfig({
  // Track and car packages live in the repo-level public/ folder.
  publicDir: '../../public',
  plugins: [
    // Phone motion sensors only work in a secure context, so dev serves HTTPS with a
    // self-signed certificate (accept the browser warning once on each device).
    basicSsl(),
    controllerRelayPlugin(),
  ],
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
  },
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: {
        game: fileURLToPath(new URL('./index.html', import.meta.url)),
        controller: fileURLToPath(new URL('./controller.html', import.meta.url)),
      },
    },
  },
});
