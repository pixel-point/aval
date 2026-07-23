import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "scripts/**/*.test.ts",
      "scripts/**/*.test.tsx"
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    pool: "threads",
    maxWorkers: 1,
    testTimeout: 30_000
  },
  resolve: {
    // Match the workspace suite's single source-module identity. Packed and
    // registry consumer tests address built artifacts by explicit file path.
    alias: {
      "@pixel-point/aval-compiler": fileURLToPath(
        new URL("./packages/compiler/src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-format": fileURLToPath(
        new URL("./packages/format/src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-graph": fileURLToPath(
        new URL("./packages/graph/src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-react": fileURLToPath(
        new URL("./packages/react/src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-player-web": fileURLToPath(
        new URL("./packages/player-web/src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-element/auto": fileURLToPath(
        new URL("./packages/element/src/auto.ts", import.meta.url)
      ),
      "@pixel-point/aval-element": fileURLToPath(
        new URL("./packages/element/src/index.ts", import.meta.url)
      )
    }
  }
});
