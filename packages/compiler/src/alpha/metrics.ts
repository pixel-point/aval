import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CompilerError } from "../diagnostics.js";
import { readFrame, type prepareAlphaFrames } from "./frames.js";
import { mediaTool } from "./media.js";
import type { AlphaMetrics, ResolvedAlphaOptions } from "./types.js";

/** Score all frames; composite references use black, white and saturated magenta. */
export async function measureAlpha(video: string, input: Awaited<ReturnType<typeof prepareAlphaFrames>>, directory: string, options: ResolvedAlphaOptions): Promise<AlphaMetrics> {
  const decodedPath = join(directory, "decoded.rgba");
  await mediaTool(options, options.ffmpeg, ["-nostdin", "-v", "error", "-i", video, "-map", "0:v:0", "-an", "-fps_mode", "passthrough",
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], decodedPath);
  const packedBytes = input.geometry.codedWidth * input.geometry.codedHeight * 4;
  if ((await stat(decodedPath)).size !== input.frames * packedBytes) throw new CompilerError("FFMPEG_FAILED", "Encoded frame count changed");
  const original = await open(input.rgbaPath, "r");
  let decoded: Awaited<ReturnType<typeof open>> | undefined;
  let alphaError = 0, compositeError = 0, alphaMaxError = 0;
  const [ax, ay] = input.geometry.visibleAlphaRect!;
  try {
    decoded = await open(decodedPath, "r");
    for (let frame = 0; frame < input.frames; frame++) {
      options.signal?.throwIfAborted();
      const reference = await readFrame(original, input.width * input.height * 8, frame * input.width * input.height * 8);
      const pixels = await readFrame(decoded, packedBytes, frame * packedBytes);
      for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
        const r = (y * input.width + x) * 8;
        const c = (y * input.geometry.codedWidth + x) * 4;
        const a = ((ay + y) * input.geometry.codedWidth + ax + x) * 4;
        const originalAlpha = reference.readUInt16LE(r + 6) / 257;
        const recoveredAlpha = pixels[a]! * 0.2126 + pixels[a + 1]! * 0.7152 + pixels[a + 2]! * 0.0722;
        const error = Math.abs(originalAlpha - recoveredAlpha);
        alphaError += error;
        alphaMaxError = Math.max(alphaMaxError, error);
        for (let channel = 0; channel < 3; channel++) {
          const rgb = reference.readUInt16LE(r + channel * 2) / 257;
          for (const background of [0, 255, channel === 1 ? 0 : 255]) {
            const expected = (rgb * originalAlpha + background * (255 - originalAlpha)) / 255;
            const actual = (pixels[c + channel]! * recoveredAlpha + background * (255 - recoveredAlpha)) / 255;
            compositeError += Math.abs(expected - actual);
          }
        }
      }
    }
  } finally { await original.close(); await decoded?.close(); await unlink(decodedPath); }
  const count = input.width * input.height * input.frames;
  return { alphaMae: alphaError / count, compositeMae: compositeError / (count * 9), alphaMaxError, frames: input.frames };
}
