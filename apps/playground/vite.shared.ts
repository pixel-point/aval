import { fileURLToPath } from "node:url";

import type { UserConfig } from "vite";

import { playgroundFixturePlugin } from "./http-fixture-plugin.js";

/** Inputs and local fixture authorities shared by development and release builds. */
export function createPlaygroundConfig(): UserConfig {
  return {
    plugins: [playgroundFixturePlugin()],
    build: {
      rollupOptions: {
        input: {
          playground: fileURLToPath(new URL("./index.html", import.meta.url)),
          certification: fileURLToPath(new URL("./certification.html", import.meta.url))
        }
      }
    }
  };
}
