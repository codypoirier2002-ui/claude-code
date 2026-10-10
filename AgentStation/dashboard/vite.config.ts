import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const STATION = 'http://127.0.0.1:8787';
const DEV = 'http://127.0.0.1:5173';

// The station server serves dist/ and the API on the same origin.
// `npm run dev` proxies /api to a running station for UI work.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: STATION,
        changeOrigin: true,
        // Never bypasses (returns nothing). The station refuses foreign Origins,
        // so only this dev server's own Origin is presented as the station's;
        // any other Origin is forwarded unchanged and still refused.
        bypass: (req) => {
          if (req.headers.origin === DEV) req.headers.origin = STATION;
        },
      },
    },
  },
});
