import { resolve } from "node:path";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port (devUrl in src-tauri/tauri.conf.json).
// Two pages: index.html (the main window: pairing + settings) and pet.html (one per bot).
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
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        pet: resolve(import.meta.dirname, "pet.html"),
      },
    },
  },
});
