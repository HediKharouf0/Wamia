import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run app` serves the full app; the live screens talk to the local fork server through /api.
// `npm run app:hosted` builds only what needs no chain (the replay) into one self-contained HTML file.
const hosted = process.env.P1NCH_HOSTED === "1";

export default defineConfig({
  root: "app",
  plugins: hosted ? [react(), viteSingleFile()] : [react()],
  define: { __HOSTED__: JSON.stringify(hosted) },
  build: { outDir: hosted ? "dist-hosted" : "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
