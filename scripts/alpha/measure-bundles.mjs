import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(".cache/alpha/bundles");
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile("packages/alpha/package.json", "utf8"));
if (Object.keys(manifest.dependencies ?? {}).length) throw Error("aval-alpha must have no runtime dependencies");
const measurements = {};
for (const [name, entry, peer] of [
  ["core", "alpha/dist/index.js"], ["withElement", "alpha/dist/element.js"],
  ["withBinding", "alpha/dist/adapter.js"],
  ["react", "alpha-react/dist/index.js", "react"], ["svelte", "alpha-svelte/dist/index.js", "svelte"]
]) {
  const isPeer = (id) => Boolean(peer && (id === peer || id.startsWith(peer + "/")));
  const result = await build({ configFile: false, logLevel: "silent",
    plugins: peer === "svelte" ? [svelte({ configFile: false })] : [], build: {
    write: false, target: "es2022", minify: "oxc", lib: { entry: resolve(`packages/${entry}`), formats: ["es"] },
    rollupOptions: { external: isPeer }
  } });
  const files = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
  const sizes = { raw: 0, gzip: 0, brotli: 0, resources: [] };
  for (const file of files) {
    if (file.type !== "chunk") throw Error(`Unexpected runtime resource: ${file.fileName}`);
    if (file.imports.some((id) => !isPeer(id)) || file.dynamicImports.length) throw Error("Runtime must not download non-peer modules or decoder assets");
    for (const module of Object.keys(file.modules)) {
      if (!["alpha", ...(peer ? [`alpha-${peer}`] : [])].some((directory) => module.startsWith(resolve(`packages/${directory}/dist`) + "/"))) throw Error(`Unexpected dependency: ${module}`);
    }
    const bytes = Buffer.from(file.code);
    const size = { file: file.fileName, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, brotli: brotliCompressSync(bytes).length };
    sizes.raw += size.raw; sizes.gzip += size.gzip; sizes.brotli += size.brotli; sizes.resources.push(size);
    const filename = { core: "aval-alpha", withElement: "aval-alpha-element", withBinding: "aval-alpha-adapter" }[name] ?? `aval-alpha-${name}`;
    await writeFile(resolve(output, `${filename}.js`), bytes);
  }
  measurements[name] = { ...sizes, excludedPeer: peer ?? null };
}
measurements.elementIncrement = Object.fromEntries(["raw", "gzip", "brotli"].map((key) => [key, measurements.withElement[key] - measurements.core[key]]));
for (const framework of ["react", "svelte"]) measurements[`${framework}Increment`] = Object.fromEntries(["raw", "gzip", "brotli"].map((key) => [key, measurements[framework][key] - measurements.core[key]]));
await writeFile(resolve(output, "sizes.json"), JSON.stringify(measurements, null, 2) + "\n");
console.log(JSON.stringify(measurements, null, 2));
if (measurements.core.gzip > 5000 || measurements.core.brotli > 4000) throw Error("Core exceeds its compressed byte budget");
if (measurements.elementIncrement.gzip > 1000 || measurements.elementIncrement.brotli > 1000) throw Error("Element exceeds its incremental compressed byte budget");
for (const framework of ["react", "svelte"]) {
  const increment = measurements[`${framework}Increment`];
  if (increment.gzip > 2000 || increment.brotli > 1800) throw Error(`${framework} adapter exceeds its incremental byte budget`);
}
