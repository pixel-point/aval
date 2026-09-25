import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { encodeCanonicalRgbaPng } from "../../packages/compiler/dist/compile/png.js";
import { compileAlpha } from "../../packages/compiler/dist/alpha.js";

const root = resolve(".cache/alpha");
await mkdir(root, { recursive: true });
const frames = join(root, "input");
await mkdir(frames, { recursive: true });
const width = 128, height = 96, count = 24;
for (let frame = 0; frame < count; frame++) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const band = Math.floor(x / 32);
    rgba[p] = 220; rgba[p + 1] = 80 + Math.floor(y / 8); rgba[p + 2] = 110;
    rgba[p + 3] = y < 48 ? [0, 64, 128, 255][band] : Math.round(255 * x / (width - 1));
    if (y > 72 && x > frame * 4 && x < frame * 4 + 12) { rgba[p] = 40; rgba[p + 1] = 210; }
  }
  await writeFile(join(frames, `frame-${String(frame).padStart(4, "0")}.png`), encodeCanonicalRgbaPng({ width, height, rgba }));
}
const output = join(root, "media");
await rm(output, { recursive: true, force: true });
const result = await compileAlpha(join(frames, "frame-%04d.png"), {
  out: output, fps: 12, frames: count, baseUrl: "/",
  encodings: ["av1", "vp9", "h265", "h264"].map((codec) => ({ codec, crf: 16, threads: 2 }))
});
console.log(JSON.stringify({ output, sources: result.sources, quality: result.candidates.map(({ codec, metrics }) => ({ codec, ...metrics })) }, null, 2));
