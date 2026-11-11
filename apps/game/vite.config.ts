import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type ProxyOptions } from 'vite';
// Relative path, not '@drivee/shared': Vite bundles relative imports into the config but
// hands package imports to Node, which can't load the shared package's TypeScript.
import { SIGNAL_PATH } from '../../packages/shared/src/controller';

// The FastAPI signalling server (apps/signaling). Proxied rather than called directly so
// the pages reach it on their own origin and HTTPS certificate: a phone only has to accept
// one self-signed certificate, and there is no mixed content or CORS to deal with.
const signalProxy: Record<string, ProxyOptions> = {
  [SIGNAL_PATH]: { target: process.env['SIGNAL_URL'] ?? 'http://127.0.0.1:8000' },
};

export default defineConfig({
  // Track and car packages live in the repo-level public/ folder.
  publicDir: '../../public',
  plugins: [
    // Phone motion sensors only work in a secure context, so dev serves HTTPS with a
    // self-signed certificate (accept the browser warning once on each device).
    basicSsl(),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: signalProxy,
  },
  preview: {
    host: true,
    proxy: signalProxy,
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
