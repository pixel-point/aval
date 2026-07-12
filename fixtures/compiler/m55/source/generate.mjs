import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalRgbaPng
} from "../../../../packages/compiler/dist/compile/png.js";

const WIDTH = 32;
const HEIGHT = 32;
const TAG_COLUMNS = Object.freeze([
  0b000111,
  0b001011,
  0b001101,
  0b001110,
  0b010011,
  0b100011
]);

// The background follows every authored exact boundary with a small color
// delta. The six-tile marker is a transformed Gray code: every consecutive
// source frame changes exactly three robust 4x8 tiles, while any branch seam
// changes at most six. That keeps compiler seam ratios bounded by sqrt(2)
// while letting a tolerant readback recover the exact source-frame ordinal.
const BACKGROUNDS = Object.freeze([
  [76, 84, 92], [84, 92, 96], [92, 96, 100],
  [100, 100, 100], [108, 100, 96], [112, 108, 96], [108, 116, 100],
  [100, 120, 104], [92, 116, 108], [88, 108, 108], [92, 100, 104],
  [96, 100, 108], [96, 100, 116], [96, 100, 124], [96, 100, 132],
  [96, 100, 140], [96, 100, 148],
  [100, 100, 152], [108, 100, 148], [112, 108, 148], [108, 116, 152],
  [100, 120, 156], [92, 116, 160], [88, 108, 160], [92, 100, 156],
  [96, 98, 103], [96, 94, 107], [96, 90, 111], [96, 94, 109],
  [96, 98, 105]
]);

const root = dirname(fileURLToPath(import.meta.url));
const target = resolve(root, "frames");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all(BACKGROUNDS.map(async (background, frameIndex) => {
  const rgba = taggedFrame(background, frameIndex);
  await writeFile(
    resolve(target, `frame-${String(frameIndex).padStart(4, "0")}.png`),
    encodeCanonicalRgbaPng({ width: WIDTH, height: HEIGHT, rgba })
  );
}));

function taggedFrame(background, frameIndex) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let offset = 0; offset < rgba.byteLength; offset += 4) {
    rgba.set([...background, 255], offset);
  }
  const code = tagCode(frameIndex);
  for (let bit = 0; bit < 6; bit += 1) {
    const value = (code & (1 << bit)) === 0 ? 32 : 224;
    for (let y = 12; y < 20; y += 1) {
      for (let x = 4 + bit * 4; x < 8 + bit * 4; x += 1) {
        const offset = (y * WIDTH + x) * 4;
        rgba.set([value, value, value, 255], offset);
      }
    }
  }
  return rgba;
}

function tagCode(frameIndex) {
  const gray = frameIndex ^ (frameIndex >> 1);
  return TAG_COLUMNS.reduce(
    (code, column, bit) => (gray & (1 << bit)) === 0 ? code : code ^ column,
    0
  );
}
