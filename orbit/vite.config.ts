import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// WebXR and the microphone need HTTPS on a LAN, so every serve command (dev and
// preview) gets a self-signed certificate unless ORBIT_HTTP is set.
export default defineConfig(({ command }) => ({
  base: "./",
  plugins: command === "serve" && !process.env.ORBIT_HTTP ? [basicSsl()] : [],
  server: { host: true },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
}));
