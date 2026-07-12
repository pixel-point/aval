import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      reporter: ["text", "html"]
    }
  },
  resolve: {
    // Workspace tests execute one source module identity; consumers use dist.
    alias: {
      "@rendered-motion/compiler": fileURLToPath(
        new URL("./packages/compiler/src/index.ts", import.meta.url)
      ),
      "@rendered-motion/format": fileURLToPath(
        new URL("./packages/format/src/index.ts", import.meta.url)
      ),
      "@rendered-motion/graph": fileURLToPath(
        new URL("./packages/graph/src/index.ts", import.meta.url)
      ),
      "@rendered-motion/player-web": fileURLToPath(
        new URL("./packages/player-web/src/index.ts", import.meta.url)
      )
    }
  }
});
