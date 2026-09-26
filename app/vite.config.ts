import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run app` serves the full app; the live screens talk to the local fork server through /api.
// `npm run app:hosted` builds only what needs no chain (the replay) into one self-contained HTML file.
const hosted = process.env.WAMIA_HOSTED === "1";

export default defineConfig({
  root: "app",
  plugins: hosted ? [react(), viteSingleFile()] : [react()],
  define: { __HOSTED__: JSON.stringify(hosted) },
  // Large enough that the logo (~44KB) inlines as base64 too, so the single-file hosted
  // build (vite-plugin-singlefile) stays one self-contained HTML file with no external image.
  build: { outDir: hosted ? "dist-hosted" : "dist", emptyOutDir: true, assetsInlineLimit: 200_000 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
