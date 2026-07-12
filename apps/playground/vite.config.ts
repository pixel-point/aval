import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { m7HttpFixturePlugin } from "./m7-http-fixture-plugin.js";
import { m8HttpFixturePlugin } from "./m8-http-fixture-plugin.js";

export default defineConfig({
  plugins: [m7HttpFixturePlugin(), m8HttpFixturePlugin()],
  build: {
    rollupOptions: {
      input: {
        playground: fileURLToPath(new URL("./index.html", import.meta.url)),
        element: fileURLToPath(new URL("./m8-dev-entry.html", import.meta.url)),
        certification: fileURLToPath(new URL("./certification.html", import.meta.url))
      }
    }
  },
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
      ),
      "@rendered-motion/element/auto": fileURLToPath(
        new URL("../../packages/element/src/auto.ts", import.meta.url)
      ),
      "@rendered-motion/element": fileURLToPath(
        new URL("../../packages/element/src/index.ts", import.meta.url)
      )
    }
  }
});
