import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  build: {
    outDir: "dist",
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
