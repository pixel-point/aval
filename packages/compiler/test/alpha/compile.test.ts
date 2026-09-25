import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileAlpha } from "../../src/alpha/compile.js";
import { encodeCanonicalRgbaPng } from "../../src/compile/png.js";

// These execute real encoders. Keep the ordinary unit suite independent of host FFmpeg.
describe.skipIf(process.env.AVAL_ALPHA_FFMPEG_TESTS !== "1")("alpha media integration", () => {
  let root: string;
  let input: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aval-alpha-test-"));
    input = join(root, "frame-%04d.png");
    for (let frame = 0; frame < 4; frame++) {
      const width = 128, height = 65, rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        rgba[p] = 210; rgba[p + 1] = 40 + frame * 20; rgba[p + 2] = 80;
        rgba[p + 3] = Math.round(x * 255 / (width - 1));
      }
      await writeFile(join(root, `frame-${String(frame).padStart(4, "0")}.png`), encodeCanonicalRgbaPng({ width, height, rgba }));
    }
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("compiles all four codecs with aligned odd dimensions and decoded alpha metrics", async () => {
    const out = join(root, "media");
    const result = await compileAlpha(input, { out, fps: 12, frames: 4,
      encodings: ["av1", "vp9", "h265", "h264"].map((codec) => ({ codec: codec as "av1" | "vp9" | "h265" | "h264", crf: 20, threads: 2 })) });
    expect(result.sources).toHaveLength(4);
    for (const source of result.sources) {
      expect(source.width % 2).toBe(0); expect(source.height % 2).toBe(0);
      expect(source.colorRect).toEqual([0, 0, 128, 65]);
      expect(source.alphaRect[1] % 2).toBe(0);
      expect(source.type).toMatch(/codecs="(?:av01|vp09|hvc1|avc1)\./u);
    }
    for (const candidate of result.candidates) {
      expect(candidate.selected).toBe(true);
      expect(candidate.metrics.frames).toBe(4);
      expect(candidate.metrics.alphaMae).toBeLessThan(3);
      expect(candidate.metrics.compositeMae).toBeLessThan(4);
      expect(candidate.arguments.join(" ")).not.toMatch(/videotoolbox|bf 0|scenecut=0/u);
    }
    expect(JSON.parse(await readFile(join(out, "sources.json"), "utf8")).sources).toEqual(result.sources);
    expect(await readdir(out)).not.toContain(".work");
    await expect(compileAlpha(input, { out, fps: 12, frames: 4 })).rejects.toThrow(/already exists/u);
  }, 90_000);
  it("searches CRF and preset combinations, selecting the smallest qualifying file", async () => {
    const result = await compileAlpha(input, { out: join(root, "search"), fps: 12, frames: 4,
      encodings: [{ codec: "h265", threads: 2, x265: { aqMode: 3, sao: false } }],
      optimize: { crfs: [18, 30], presets: { h265: ["fast", "slow"] }, maxAlphaMae: 5, maxCompositeMae: 5 } });
    expect(result.candidates).toHaveLength(4);
    const selected = result.candidates.filter((candidate) => candidate.selected);
    expect(selected).toHaveLength(1);
    const qualifies = result.candidates.filter((c) => c.metrics.alphaMae <= 5 && c.metrics.compositeMae <= 5);
    expect(selected[0]!.bytes).toBe(Math.min(...qualifies.map((c) => c.bytes)));
    expect(result.candidates.some((c) => c.pareto)).toBe(true);
    expect(selected[0]!.arguments.join(" ")).toContain("aq-mode=3:sao=0");
  }, 90_000);
  it("removes staging on rejection or cancellation without publishing partial output", async () => {
    const out = join(root, "failed");
    await expect(compileAlpha(input, { out, fps: 12, frames: 8, encodings: [{ codec: "h264" }] })).rejects.toThrow();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(compileAlpha(input, { out, fps: 12, frames: 4, signal })).rejects.toThrow();
    expect((await readdir(root)).every((name) => name.startsWith("frame-"))).toBe(true);
  });
  it("packs portrait clips horizontally and emits qualified 10-bit codec declarations", async () => {
    const result = await compileAlpha(input, { out: join(root, "portrait"), width: 65, height: 128, fps: 12, frames: 4,
      encodings: [{ codec: "av1", bitDepth: 10, threads: 2 }, { codec: "h265", bitDepth: 10, threads: 2 }] });
    expect(result.sources[0]!.alphaRect).toEqual([74, 0, 65, 128]);
    expect(result.sources[0]!.type).toMatch(/av01\..*\.10/u);
    expect(result.sources[1]!.type).toMatch(/hvc1\.2\./u);
    for (const candidate of result.candidates) expect(candidate.metrics.alphaMae).toBeLessThan(3);
  }, 90_000);
  it("preserves an existing VP9 WebM alpha input through the libvpx decoder", async () => {
    const movie = join(root, "transparent.webm");
    await promisify(execFile)("ffmpeg", ["-v", "error", "-framerate", "12", "-i", input, "-frames:v", "4", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "12", "-pix_fmt", "yuva420p", movie]);
    const result = await compileAlpha(movie, { out: join(root, "converted"), fps: 12, encodings: [{ codec: "h264", crf: 16 }] });
    expect(result.frames).toBe(4);
    expect(result.candidates[0]!.metrics.alphaMae).toBeLessThan(3);
  });
  it("unpremultiplies authored colors before encoding", async () => {
    const rgba = new Uint8Array(128 * 65 * 4);
    for (let p = 0; p < rgba.length; p += 4) rgba.set([110, 40, 55, 128], p);
    await writeFile(join(root, "frame-0000.png"), encodeCanonicalRgbaPng({ width: 128, height: 65, rgba }));
    const out = join(root, "straight");
    await compileAlpha(input, { out, fps: 12, frames: 1, premultiplied: true, encodings: [{ codec: "h264", crf: 12 }] });
    const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-i", join(out, "h264.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer" });
    const pixel = (16 * 128 + 80) * 4;
    [219, 80, 110].forEach((expected, channel) => expect(Math.abs(stdout[pixel + channel]! - expected)).toBeLessThan(5));
  });
});
