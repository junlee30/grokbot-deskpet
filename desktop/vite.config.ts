import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port (devUrl in src-tauri/tauri.conf.json).
// Two pages: index.html (the main window: pairing + settings) and pet.html (one per bot).
export default defineConfig({
  clearScreen: false,
  plugins: [
    {
      // public/grokbot-art/ (scripts/import-grokbot-art.mjs) is for the browser preview only.
      // Grok Bot's art is not ours to ship: the app copies it from the user's own Grok Bot at
      // runtime (src-tauri/src/grokbot_art.rs), so no build may contain it.
      name: "no-grokbot-art-in-builds",
      apply: "build",
      closeBundle() {
        rmSync(resolve(import.meta.dirname, "dist/grokbot-art"), { recursive: true, force: true });
      },
    },
  ],
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
