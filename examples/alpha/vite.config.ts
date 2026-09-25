import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../.cache/alpha/media", import.meta.url)),
  server: { host: "127.0.0.1", port: 4188, strictPort: true },
  resolve: { alias: { "@pixel-point/aval-alpha/element": fileURLToPath(new URL("../../packages/alpha/src/element.ts", import.meta.url)),
    "@pixel-point/aval-alpha": fileURLToPath(new URL("../../packages/alpha/src/index.ts", import.meta.url)) } }
});
