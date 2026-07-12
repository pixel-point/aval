import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalRgbaPng
} from "../../../../packages/compiler/dist/compile/png.js";

const root = dirname(fileURLToPath(import.meta.url));

await generate("loop", [100, 101]);
await generate("path", [98, 99, 100, 101, 102, 103, 104, 105]);
await generate(
  "reversible",
  [60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190]
);

async function generate(directory, values) {
  const target = resolve(root, directory);
  await mkdir(target, { recursive: true });
  await Promise.all(values.map(async (gray, index) => {
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let offset = 0; offset < rgba.byteLength; offset += 4) {
      rgba.set([gray, gray, gray, 255], offset);
    }
    await writeFile(
      resolve(target, `frame-${String(index).padStart(4, "0")}.png`),
      encodeCanonicalRgbaPng({ width: 32, height: 32, rgba })
    );
  }));
}
