import { describe, expect, it } from "vitest";

import { ELEMENT_DECODER_CAPACITY } from "@pixel-point/aval-element";
import { deriveReadiness } from "../src/compile/readiness-plan.js";
import { estimateRuntimeLimits } from "../src/compile/resource-estimate.js";
import { deriveVideoRenditionGeometry } from "@pixel-point/aval-format";
import type {
  NormalizedSourceProject,
  SourceProject
} from "../src/model.js";

describe("compiled resource and readiness derivation", () => {
  it("includes reversible residency, cuts, two decoder rings, real encoded bytes, and canvas", () => {
    const project = {
      canvas: { width: 32, height: 16 },
      encodings: [{
        codec: "h264",
        preset: "medium",
        renditions: [
          { id: "large", width: 32, height: 16, crf: 20 },
          { id: "small", width: 16, height: 8, crf: 20 }
        ]
      }],
      units: [{
        id: "resident",
        kind: "reversible",
        range: [10, 15],
        residency: { endpoints: [{ frames: 6 }, { frames: 7 }] }
      }],
      edges: [{
        start: { type: "cut" },
        targetRunwayFrames: 8
      }]
    } as unknown as NormalizedSourceProject;
    const limits = estimateRuntimeLimits(project, "h264", [
      sample("large", 10),
      sample("large", 20),
      sample("small", 40)
    ], [
      deriveVideoRenditionGeometry({
        canvasWidth: 32,
        canvasHeight: 16,
        layout: "opaque",
        visibleWidth: 32,
        visibleHeight: 16,
        storage: { widthAlignment: 2, heightAlignment: 2 }
      }),
      deriveVideoRenditionGeometry({
        canvasWidth: 32,
        canvasHeight: 16,
        layout: "opaque",
        visibleWidth: 16,
        visibleHeight: 8,
        storage: { widthAlignment: 2, heightAlignment: 2 }
      })
    ]);

    expect(limits).toEqual({
      maxCompiledBytes: Number.MAX_SAFE_INTEGER,
      maxRuntimeBytes: Number.MAX_SAFE_INTEGER,
      decodedPixelBytes: 2_048,
      persistentCacheBytes: 26 * 2_048,
      runtimeWorkingSetBytes: 26 * 2_048 +
        ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces * 64 * 48 * 4 +
        40 + 2_048
    });
  });

  it("reports rather than rejects a runtime estimate above the old 64 MiB cap", () => {
    const project = {
      canvas: { width: 2_048, height: 2_048 },
      encodings: [{
        codec: "h264",
        preset: "medium",
        renditions: [{ id: "large", width: 2_048, height: 2_048, crf: 20 }]
      }],
      units: [],
      edges: []
    } as unknown as NormalizedSourceProject;
    const limits = estimateRuntimeLimits(project, "h264", [], [
      deriveVideoRenditionGeometry({
        canvasWidth: 2_048,
        canvasHeight: 2_048,
        layout: "opaque",
        visibleWidth: 2_048,
        visibleHeight: 2_048,
        storage: { widthAlignment: 2, heightAlignment: 2 }
      })
    ]);
    expect(limits.runtimeWorkingSetBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(limits.maxRuntimeBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps bootstrap readiness to the initial path and immediate routes", () => {
    const project = {
      initialState: "idle",
      states: [
        { id: "idle", bodyUnit: "idle-body", initialUnit: "intro" },
        { id: "hover", bodyUnit: "hover-body" },
        { id: "later", bodyUnit: "unrelated-body" }
      ],
      edges: [
        {
          id: "idle-hover",
          from: "idle",
          to: "hover",
          transition: { kind: "locked", unit: "bridge" }
        },
        { id: "hover-later", from: "hover", to: "later" }
      ]
    } as unknown as SourceProject;
    expect(deriveReadiness(project)).toEqual({
      policy: "all-routes",
      bootstrapUnits: ["bridge", "hover-body", "idle-body", "intro"],
      immediateEdges: ["idle-hover"]
    });
  });
});

function sample(rendition: string, bytes: number) {
  return {
    rendition,
    unit: "unit",
    decodeIndex: 0,
    presentationTimestamp: 0,
    duration: 1,
    randomAccess: true,
    displayedFrameCount: 1,
    bytes: new Uint8Array(bytes)
  };
}
