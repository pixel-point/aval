import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureDir, "../../..");

/**
 * Serve the monorepo root so:
 *  - URL stays /fixtures/rings/v1-eight-way-facing/test.html
 *  - bare package imports (@pixel-point/*) resolve via node_modules
 *  - decoder module Worker (new URL("./entry.js", import.meta.url)) is
 *    rewritten by Vite (plain http.server cannot do this → readiness-failure)
 */
export default defineConfig({
  root: repoRoot,
  publicDir: false,
  appType: "mpa",
  plugins: [
    {
      name: "avl-mime",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && /\.avl(\?|$)/.test(req.url)) {
            res.setHeader("Content-Type", "application/vnd.aval");
            res.setHeader("Accept-Ranges", "bytes");
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 8765,
    host: true,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    include: [
      "@pixel-point/aval-element",
      "@pixel-point/aval-element/auto",
      "@pixel-point/aval-player-web",
      "@pixel-point/aval-format",
      "@pixel-point/aval-graph",
    ],
  },
});
