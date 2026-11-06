import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * Names the lazy chunks after what they hold (§14): three.js in three-*.js and
 * @pixiv/three-vrm in vrm-*.js. Both load only with the VR, portrait or VRM
 * code, so the main bundle stays free of them.
 */
function chunkFor(id: string): string | undefined {
  const path = id.replace(/\\/g, "/");
  if (path.includes("/node_modules/@pixiv/three-vrm")) return "vrm";
  if (path.includes("/node_modules/three/")) return "three";
  return undefined;
}

// WebXR and the microphone need HTTPS on a LAN, so every serve command (dev and
// preview) gets a self-signed certificate unless ORBIT_HTTP is set.
export default defineConfig(({ command }) => ({
  base: "./",
  plugins: command === "serve" && !process.env.ORBIT_HTTP ? [basicSsl()] : [],
  server: { host: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rollupOptions: { output: { manualChunks: chunkFor } },
  },
}));
