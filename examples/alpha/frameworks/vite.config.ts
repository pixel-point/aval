import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../../.cache/alpha/media", import.meta.url)),
  plugins: [svelte({ configFile: fileURLToPath(new URL("../../../packages/alpha-svelte/svelte.config.js", import.meta.url)) }), {
    name: "alpha-framework-ssr",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const framework = request.url?.split("?")[0]?.slice(1);
        if (framework !== "react" && framework !== "svelte") { next(); return; }
        try {
          const extension = framework === "react" ? "tsx" : "ts";
          const entry = await server.ssrLoadModule(`/${framework}-server.${extension}`);
          const body = (entry.render as () => string)();
          const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>aval-alpha ${framework}</title><style>body{font:16px system-ui;margin:32px}#stage{width:256px;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0/24px 24px}output{display:block;margin:12px 0}button{margin:4px;padding:8px}</style></head><body><div id="app">${body}</div><script type="module" src="/${framework}-client.${extension}"></script></body></html>`;
          response.setHeader("Content-Type", "text/html");
          response.end(await server.transformIndexHtml(request.url!, html));
        } catch (error) { next(error); }
      });
    }
  }],
  ssr: { noExternal: ["@pixel-point/aval-alpha-svelte", "@pixel-point/aval-alpha-react"] },
  server: { host: "127.0.0.1", port: 4189, strictPort: true }
});
