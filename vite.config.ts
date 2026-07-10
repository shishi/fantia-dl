import { defineConfig } from "vite";
import { resolve } from "path";
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        "content/content-script": resolve(__dirname, "src/content/content-script.ts"),
        "content/page-script": resolve(__dirname, "src/content/page-script.ts"),
        "options/options": resolve(__dirname, "src/options/options.ts"),
      },
      output: { entryFileNames: "[name].js", format: "es" },
    },
  },
  publicDir: "public",
});
