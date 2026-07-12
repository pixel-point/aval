import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // The local playground exercises workspace sources without a prior build.
    alias: {
      "@rendered-motion/format": fileURLToPath(
        new URL("../../packages/format/src/index.ts", import.meta.url)
      ),
      "@rendered-motion/graph": fileURLToPath(
        new URL("../../packages/graph/src/index.ts", import.meta.url)
      ),
      "@rendered-motion/player-web": fileURLToPath(
        new URL("../../packages/player-web/src/index.ts", import.meta.url)
      )
    }
  }
});
