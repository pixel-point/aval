import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const codecAssets = ["av1.avl", "vp9.avl", "h265.avl", "h264.avl"];
const assets = [
  ...codecAssets.map((filename) => ({
    source: new URL(`../../grass-rabbit/public/grass-rabbit/${filename}`, import.meta.url),
    target: new URL(`../public/grass-rabbit/${filename}`, import.meta.url),
  })),
  {
    source: new URL("../../grass-rabbit/public/interaction-hotspot.svg", import.meta.url),
    target: new URL("../public/interaction-hotspot.svg", import.meta.url),
  },
];

await Promise.all(
  assets.map(async ({ source }) => {
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) {
      throw new Error(`Expected an asset file at ${fileURLToPath(source)}`);
    }
  }),
);

await Promise.all(
  assets.map(async ({ source, target }) => {
    await mkdir(dirname(fileURLToPath(target)), { recursive: true });
    await copyFile(source, target);
  }),
);

process.stdout.write(`${JSON.stringify({ status: "prepared", assets: assets.length })}\n`);
