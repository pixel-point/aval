import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { deriveVideoRenditionGeometry, PACKED_ALPHA_GUTTER, type VideoRenditionGeometry } from "@pixel-point/aval-format";
import { CompilerError } from "../diagnostics.js";
import { decodeRgba64Le } from "../compile/canonical-rgba16.js";
import { composeVideoSurfaceRgba16 } from "../compile/video-surface-rgba16.js";
import { convertRgba16ToYuv420 } from "../compile/rgba16-to-yuv420.js";
import { mediaTool, probeVideo } from "./media.js";
import type { ResolvedAlphaOptions } from "./types.js";

export async function prepareAlphaFrames(input: string, directory: string, options: ResolvedAlphaOptions) {
  const sequence = input.includes("%");
  if (sequence && (!options.frames || !options.fps)) throw invalid("PNG sequences require frames and fps");
  if (sequence && !/%0?[1-9]?d\.png$/u.test(input)) throw invalid("Expected a PNG sequence pattern ending in %0Nd.png");
  const first = sequence ? input.replace(/%0?([1-9]?)d/u, (_, count: string) => String(options.startNumber ?? 0).padStart(Number(count) || 1, "0")) : input;
  const probe = await probeVideo(first, options);
  const fps = options.fps ?? probe.fps;
  if (!Number.isFinite(fps) || fps <= 0) throw invalid("Input needs an explicit fps");
  const width = options.width ?? (options.height ? Math.round(probe.width * options.height / probe.height) : probe.width);
  const height = options.height ?? (options.width ? Math.round(probe.height * options.width / probe.width) : probe.height);
  if (!width || !height) throw invalid("Output dimensions must be positive");
  const frameBytes = width * height * 8;
  if (!Number.isSafeInteger(frameBytes)) throw invalid("Output frame dimensions exceed safe arithmetic");
  const rgbaPath = join(directory, "reference.rgba64");
  const filters = [
    `fps=${fps}`, `scale=${width}:${height}:flags=lanczos`, "format=rgba64le"
  ];
  await mediaTool(options, options.ffmpeg, [
    "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
    ...(sequence ? ["-framerate", String(fps), "-start_number", String(options.startNumber ?? 0)] : []),
    ...(probe.codec === "vp9" && probe.alphaMode ? ["-c:v", "libvpx-vp9"] : []),
    "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters.join(","),
    ...(options.frames ? ["-frames:v", String(options.frames)] : []),
    "-f", "rawvideo", "-pix_fmt", "rgba64le", "pipe:1"
  ], rgbaPath);
  const length = (await stat(rgbaPath)).size;
  if (!length || length % frameBytes || options.frames && length / frameBytes !== options.frames) throw invalid("Decoded input has an unexpected frame count");
  const frames = length / frameBytes;
  const vertical = deriveVideoRenditionGeometry({ canvasWidth: width, canvasHeight: height,
    visibleWidth: width, visibleHeight: height, layout: "packed-alpha", storage: { widthAlignment: 2, heightAlignment: 2 } });
  const horizontal = options.layout === "horizontal" || (options.layout ?? "auto") === "auto" && height > width;
  const alphaX = width + width % 2 + PACKED_ALPHA_GUTTER;
  const codedWidth = alphaX + width + width % 2, codedHeight = height + height % 2;
  const geometry: VideoRenditionGeometry = horizontal ? { ...vertical, codedWidth, codedHeight,
    visibleAlphaRect: [alphaX, 0, width, height], decodedStorageRect: [0, 0, codedWidth, codedHeight],
    decodedRgbaBytes: codedWidth * codedHeight * 4, codedRgbaBytes: codedWidth * codedHeight * 4 } : vertical;
  const paths = new Map<number, string>();
  const bitDepths = [...new Set(options.encodings.map((e) => e.bitDepth))];
  const reader = await open(rgbaPath, options.premultiplied ? "r+" : "r");
  const writers: { depth: 8 | 10; file: Awaited<ReturnType<typeof open>> }[] = [];
  let minimumAlpha = 65_535;
  try {
    for (const depth of bitDepths) {
      const path = join(directory, `packed-${depth}.yuv`);
      paths.set(depth, path);
      writers.push({ depth, file: await open(path, "wx") });
    }
    for (let i = 0; i < frames; i++) {
      options.signal?.throwIfAborted();
      const bytes = await readFrame(reader, frameBytes, i * frameBytes);
      const rgba = decodeRgba64Le(bytes);
      if (options.premultiplied) {
        for (let p = 0; p < rgba.length; p += 4) {
          const alpha = rgba[p + 3]!;
          for (let channel = 0; channel < 3; channel++) {
            rgba[p + channel] = alpha ? Math.min(65_535, Math.round(rgba[p + channel]! * 65_535 / alpha)) : 0;
            bytes.writeUInt16LE(rgba[p + channel]!, (p + channel) * 2);
          }
        }
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await reader.write(bytes, written, bytes.length - written, i * frameBytes + written);
          if (!bytesWritten) throw invalid("Cannot write normalized reference frame");
          written += bytesWritten;
        }
      }
      for (let p = 3; p < rgba.length; p += 4) minimumAlpha = Math.min(minimumAlpha, rgba[p]!);
      const packed = composeVideoSurfaceRgba16(rgba, geometry);
      for (const { depth, file } of writers) {
        const yuv = convertRgba16ToYuv420(packed, { width: geometry.codedWidth, height: geometry.codedHeight, bitDepth: depth });
        await file.writeFile(yuv);
      }
    }
  } finally { await reader.close(); await Promise.all(writers.map(({ file }) => file.close())); }
  if (minimumAlpha === 65_535) throw invalid("Input is fully opaque; provide a source containing transparency");
  return { width, height, fps, frames, geometry, rgbaPath, paths };
}

export async function readFrame(file: Awaited<ReturnType<typeof open>>, size: number, position: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(result, offset, size - offset, position + offset);
    if (!bytesRead) throw invalid("Raw frame data ended unexpectedly");
    offset += bytesRead;
  }
  return result;
}
function invalid(message: string) { return new CompilerError("INPUT_INVALID", message); }
