import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@pixel-point/aval-react": fileURLToPath(
        new URL("../../src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-element": fileURLToPath(
        new URL("./fake-aval-element.ts", import.meta.url)
      )
    }
  }
});
