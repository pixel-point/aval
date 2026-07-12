import { describe, expect, it } from "vitest";

import {
  createEncodeAvcUnitInvocation,
  createExtractAlphaRangeInvocation,
  createExtractRgbaRangeInvocation,
  createNativeAlphaAuditInvocation,
  encodeAvcUnit,
  FROZEN_AVC_KEYINT,
  inspectNativeAlpha,
  sourceArguments
} from "../src/ffmpeg/encode-unit.js";

describe("frozen FFmpeg encode invocation", () => {
  it("owns the complete raw-RGBA pipe vector and fixed key interval", () => {
    const invocation = createEncodeAvcUnitInvocation({
      source: {
        type: "raw-rgba",
        path: "/private/job/canonical.rgba",
        width: 32,
        height: 32,
        frameRate: { numerator: 30, denominator: 1 }
      },
      startFrame: 3,
      endFrame: 7,
      frameRate: { numerator: 30, denominator: 1 },
      codedWidth: 32,
      codedHeight: 32,
      bitrate: { average: 2_000_000, peak: 3_000_000 }
    });

    expect(FROZEN_AVC_KEYINT).toBe(901);
    expect(invocation).toEqual({
      cwd: "/private/job",
      stdinFile: {
        path: "/private/job/canonical.rgba",
        offset: 12_288,
        length: 16_384
      },
      arguments: [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
        "-max_alloc", "67108864",
        "-protocol_whitelist", "pipe",
        "-f", "rawvideo", "-pixel_format", "rgba",
        "-video_size", "32x32", "-framerate", "30/1", "-i", "pipe:0",
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-vf", "scale=32:32:flags=lanczos+accurate_rnd+full_chroma_int:in_range=full:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709,setsar=1,format=yuv420p",
        "-frames:v", "4", "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "medium", "-tune", "zerolatency",
        "-profile:v", "baseline", "-level:v", "3.2", "-pix_fmt", "yuv420p",
        "-color_range", "tv", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-colorspace", "bt709",
        "-threads", "1", "-filter_threads", "1",
        "-g", "901", "-keyint_min", "901", "-sc_threshold", "0",
        "-bf", "0", "-refs", "1",
        "-b:v", "2000000", "-maxrate", "3000000", "-bufsize", "3000000",
        "-x264-params", "aud=1:bframes=0:cabac=0:colormatrix=bt709:colorprim=bt709:force-cfr=1:keyint=901:min-keyint=901:open-gop=0:ref=1:range=tv:repeat-headers=1:scenecut=0:sliced-threads=0:slices=1:threads=1:lookahead-threads=1:sync-lookahead=0:transfer=bt709",
        "-f", "h264", "pipe:1"
      ]
    });
  });

  it("forces the reviewed MOV demuxer for direct video reads", () => {
    expect(sourceArguments({ type: "video", path: "/input/clip.mp4" }))
      .toEqual(["-f", "mov", "-i", "/input/clip.mp4"]);
  });

  it("owns sparse native-alpha audit and targeted extraction vectors", () => {
    const source = {
      type: "png-sequence" as const,
      path: "/input/-metadata=evil;touch-pwn/frame-%04d.png",
      firstFileNumber: 17,
      frameRate: { numerator: 30, denominator: 1 }
    };
    expect(createNativeAlphaAuditInvocation({
      source,
      sourceFrames: [0, 2, 3, 7]
    })).toEqual({
      cwd: "/input/-metadata=evil;touch-pwn",
      arguments: [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
        "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe",
        "-f", "image2", "-framerate", "30/1", "-start_number", "17",
        "-i", "/input/-metadata=evil;touch-pwn/frame-%04d.png",
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-threads", "1", "-filter_threads", "1",
        "-vf", "select=eq(n\\,0)+between(n\\,2\\,3)+eq(n\\,7),format=rgba,alphaextract,signalstats,metadata=mode=print:key=lavfi.signalstats.YMIN:file='pipe\\:1':direct=1",
        "-frames:v", "4", "-fps_mode", "passthrough", "-f", "null", "-"
      ]
    });
    expect(createExtractAlphaRangeInvocation({
      source,
      startFrame: 7,
      endFrame: 8,
      width: 4096,
      height: 4096
    })).toEqual({
      cwd: "/input/-metadata=evil;touch-pwn",
      arguments: [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
        "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe",
        "-f", "image2", "-framerate", "30/1", "-start_number", "17",
        "-i", "/input/-metadata=evil;touch-pwn/frame-%04d.png",
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-threads", "1", "-filter_threads", "1",
        "-vf", "select=between(n\\,7\\,7),format=rgba,alphaextract,format=gray",
        "-frames:v", "1", "-fps_mode", "passthrough",
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
      ]
    });
  });

  it("owns the complete canvas RGBA extraction vector", () => {
    expect(createExtractRgbaRangeInvocation({
      source: { type: "video", path: "/input/clip.mov" },
      startFrame: 4,
      endFrame: 6,
      width: 320,
      height: 180
    })).toEqual({
      cwd: "/input",
      arguments: [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
        "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe",
        "-f", "mov", "-i", "/input/clip.mov",
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-threads", "1", "-filter_threads", "1",
        "-vf", "select=between(n\\,4\\,5),scale=320:180:flags=lanczos+accurate_rnd+full_chroma_int:in_range=auto:out_range=full:in_color_matrix=auto:out_color_matrix=bt709,setsar=1,format=rgba",
        "-frames:v", "2", "-fps_mode", "passthrough",
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
      ]
    });
  });

  it("only permits low-level callers to lower the media timeout ceiling", async () => {
    const source = {
      type: "raw-rgba" as const,
      path: "/input/canonical.rgba",
      width: 32,
      height: 32,
      frameRate: { numerator: 30, denominator: 1 }
    };
    await expect(encodeAvcUnit({
      source,
      startFrame: 0,
      endFrame: 1,
      frameRate: source.frameRate,
      codedWidth: 32,
      codedHeight: 32,
      bitrate: { average: 100_000, peak: 200_000 },
      executable: "not-used",
      timeoutMs: 120_001
    })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(inspectNativeAlpha({
      source,
      sourceFrames: [0],
      executable: "not-used",
      timeoutMs: 0
    })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
