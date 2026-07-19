import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@pixel-point/aval-element": fileURLToPath(
        new URL("./src/listener-timing-element.ts", import.meta.url)
      )
    }
  }
});
