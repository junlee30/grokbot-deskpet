import { defineConfig } from "vite";

// Tauri expects a fixed dev port (devUrl in src-tauri/tauri.conf.json).
export default defineConfig({
  clearScreen: false,
  server: {
    host: "localhost",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
  },
});
