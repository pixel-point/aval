import {
  deriveVideoRenditionGeometry,
  parseFrontIndex
} from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { compileProjectEncoding } from "../src/compile/project-encoding-compiler.js";
import { CompilerError } from "../src/diagnostics.js";
import type { NormalizedSourceProject } from "../src/model.js";

describe("one-codec project encoding assembly", () => {
  it("emits a qualified AV1 10-bit wire-1.1 asset and preserves decode order", () => {
    const project = projectFixture();
    const encoding = project.encodings[0]!;
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 16,
      canvasHeight: 8,
      layout: "packed-alpha",
      visibleWidth: 16,
      visibleHeight: 8,
      storage: { widthAlignment: 2, heightAlignment: 2 }
    });
    const result = compileProjectEncoding({
      project,
      encoding,
      layout: "packed-alpha",
      renditions: [{
        id: "video.main",
        codec: "av01.0.08M.10.0.110.01.01.01.0",
        bitDepth: 10,
        geometry,
        bitrate: { average: 800, peak: 1_200 },
        outputQualification: witness(),
        units: [{
          id: "idle.body",
          chunks: [
            chunk([1, 2, 3], 1, true),
            chunk([4, 5], 0, false)
          ]
        }]
      }]
    });

    const front = parseFrontIndex(result.assetBytes);
    expect(result).toMatchObject({ codec: "av1", bytes: result.assetBytes.byteLength });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(front.manifest).toMatchObject({
      formatVersion: "1.1",
      generator: "aval-compiler/1.0",
      codec: "av1",
      bitstream: "low-overhead",
      layout: "packed-alpha",
      renditions: [{
        id: "video.main",
        codec: "av01.0.08M.10.0.110.01.01.01.0",
        bitDepth: 10,
        codedWidth: 16,
        codedHeight: 24,
        alphaLayout: {
          type: "stacked",
          colorRect: [0, 0, 16, 8],
          alphaRect: [0, 16, 16, 8]
        },
        outputQualification: witness()
      }]
    });
    expect(front.records.map((record) => ({
      presentationTimestamp: record.presentationTimestamp,
      randomAccess: record.randomAccess
    }))).toEqual([
      { presentationTimestamp: 1, randomAccess: true },
      { presentationTimestamp: 0, randomAccess: false }
    ]);
    expect(front.manifest.units[0]?.chunks[0]).toMatchObject({
      rendition: "video.main",
      chunkStart: 0,
      chunkCount: 2,
      frameCount: 2
    });
  });

  it("rejects a prepared rendition set that does not match its codec-major project entry", () => {
    const project = projectFixture();
    const encoding = project.encodings[0]!;
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 16,
      canvasHeight: 8,
      layout: "opaque",
      visibleWidth: 16,
      visibleHeight: 8,
      storage: { widthAlignment: 2, heightAlignment: 2 }
    });
    expect(() => compileProjectEncoding({
      project,
      encoding,
      layout: "opaque",
      renditions: [{
        id: "video.main",
        codec: "vp09.00.10.08",
        bitDepth: 10,
        geometry,
        bitrate: { average: 1, peak: 1 },
        units: [{ id: "idle.body", chunks: [chunk([1], 0, true)] }]
      }]
    })).toThrow(CompilerError);
  });

  it("rejects packed-alpha assembly without an emitted-rendition witness", () => {
    const project = projectFixture();
    const encoding = project.encodings[0]!;
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 16,
      canvasHeight: 8,
      layout: "packed-alpha",
      visibleWidth: 16,
      visibleHeight: 8,
      storage: { widthAlignment: 2, heightAlignment: 2 }
    });
    expect(() => compileProjectEncoding({
      project,
      encoding,
      layout: "packed-alpha",
      renditions: [{
        id: "video.main",
        codec: "av01.0.08M.10.0.110.01.01.01.0",
        bitDepth: 10,
        geometry,
        bitrate: { average: 1, peak: 1 },
        units: [{ id: "idle.body", chunks: [chunk([1], 0, true)] }]
      }]
    })).toThrowError(expect.objectContaining<Partial<CompilerError>>({
      code: "INPUT_INVALID",
      message: expect.stringContaining("missing output qualification")
    }));
  });
});

function witness() {
  return Object.freeze({
    kind: "packed-alpha-v1" as const,
    unit: "idle.body",
    frame: 0,
    samples: Object.freeze([Object.freeze({
      x: 0,
      y: 0,
      expectedRange: Object.freeze([0, 32] as const)
    })])
  });
}

function chunk(bytes: number[], presentationTimestamp: number, randomAccess: boolean) {
  return Object.freeze({
    bytes: new Uint8Array(bytes),
    presentationTimestamp,
    duration: 1,
    randomAccess,
    displayedFrameCount: 1
  });
}

function projectFixture(): NormalizedSourceProject {
  const av1 = Object.freeze({
    codec: "av1" as const,
    bitDepth: 10 as const,
    cpuUsed: 0,
    tiles: Object.freeze({ columns: 2, rows: 1 }),
    rowMt: true,
    threads: 4,
    renditions: Object.freeze([
      Object.freeze({ id: "video.main", width: 16, height: 8, crf: 15 })
    ])
  });
  return Object.freeze({
    projectVersion: "1.0" as const,
    alpha: "packed" as const,
    canvas: Object.freeze({
      width: 16,
      height: 8,
      fit: "contain" as const,
      pixelAspect: Object.freeze([1, 1] as const),
      colorSpace: "srgb" as const
    }),
    frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
    sources: Object.freeze([Object.freeze({
      id: "render",
      type: "video" as const,
      path: "render.mov",
      timing: Object.freeze({ mode: "exact" as const })
    })]),
    encodings: Object.freeze([
      av1,
      Object.freeze({
        codec: "h264" as const,
        preset: "veryslow" as const,
        renditions: Object.freeze([
          Object.freeze({ id: "video.main", width: 16, height: 8, crf: 20 })
        ])
      })
    ]),
    units: Object.freeze([Object.freeze({
      id: "idle.body",
      kind: "body" as const,
      source: "render",
      range: Object.freeze([0, 2] as const),
      playback: "loop" as const,
      ports: Object.freeze([])
    })]),
    initialState: "idle",
    states: Object.freeze([Object.freeze({ id: "idle", bodyUnit: "idle.body" })]),
    edges: Object.freeze([]),
    bindings: Object.freeze([])
  });
}
