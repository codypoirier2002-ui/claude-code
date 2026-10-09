import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The station server serves dist/ and the API on the same origin.
// `npm run dev` proxies /api to a running station for UI work.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8787' } },
});
