import { describe, expect, it } from "vitest";

import type {
  Blob,
  Manifest
} from "../src/asset.js";
import { createReadinessPlan } from "../src/readiness.js";

describe("all-routes readiness plan", () => {
  it("expands every direct route and deduplicates resident frame identities", () => {
    const manifest = fixture();
    const plan = createReadinessPlan(manifest, "r", blobs(manifest));

    expect(plan.units).toEqual(["a", "rev", "b", "bridge", "c"]);
    expect(plan.loops).toEqual(["a", "c"]);
    expect(plan.reversibleUnits).toEqual(["rev"]);
    expect(plan.resident).toEqual([
      { unit: "a", frames: [0, 1, 2, 3] },
      { unit: "rev", frames: [0, 1, 2] },
      { unit: "b", frames: [0, 1] },
      { unit: "c", frames: [0, 1, 2, 3, 4] }
    ]);
    expect(plan.endpoints).toEqual([
      {
        reversibleUnit: "rev", state: "a", bodyUnit: "a",
        frames: [0, 1, 2, 3, 0, 1], continuationFrame: 2
      },
      {
        reversibleUnit: "rev", state: "b", bodyUnit: "b",
        frames: [0, 1, 1, 1, 1, 1], continuationFrame: 1
      }
    ]);
    expect(plan.routes.map(({ edge, kind, transitionUnit, targetFrames }) => ({
      edge, kind, transitionUnit, targetFrames
    }))).toEqual([
      { edge: "a.b", kind: "reversible", transitionUnit: "rev",
        targetFrames: [0, 1, 1, 1, 1, 1] },
      { edge: "b.a", kind: "reversible", transitionUnit: "rev",
        targetFrames: [0, 1, 2, 3, 0, 1] },
      { edge: "b.c", kind: "cut", transitionUnit: null,
        targetFrames: [0, 1, 2, 3, 4, 0] },
      { edge: "c.a", kind: "stream", transitionUnit: "bridge",
        targetFrames: [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3] }
    ]);
    expect(plan.decodedFrameBytes).toBe(8 * 8 * 4);
    expect(plan.encodedBytes).toBe(150);
    expect(plan.semanticPersistentBytes).toBe(21 * 8 * 8 * 4);
    expect(plan.uniquePersistentBytes).toBe(14 * 8 * 8 * 4);
    expect(plan.declaredWorkingSetBytes).toBe(
      21 * 8 * 8 * 4 + 12 * 8 * 8 * 4 + 150 + 8 * 8 * 4
    );
  });

  it("fails closed when declared resource evidence is understated", () => {
    const manifest = fixture();
    const limits = { ...manifest.limits, persistentCacheBytes: 1 };
    expect(() => createReadinessPlan(
      { ...manifest, limits }, "r", blobs(manifest)
    )).toThrow(/resource declarations/u);
  });
});

function fixture(): Manifest {
  const frameBytes = 8 * 8 * 4;
  const persistent = 21 * frameBytes;
  return {
    formatVersion: "1.0",
    generator: "test",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: {
      width: 8, height: 8, fit: "contain", pixelAspect: [1, 1], colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [{
      id: "r", codec: "avc1.64000A", bitDepth: 8,
      codedWidth: 8, codedHeight: 8,
      alphaLayout: { type: "opaque", colorRect: [0, 0, 8, 8] },
      bitrate: { average: 1_000, peak: 2_000 }
    }],
    units: [
      body("a", 4, "loop"),
      {
        id: "rev", kind: "reversible", frameCount: 3, chunks: [span("rev", 1)],
        residency: { endpoints: [
          { state: "a", port: "p", frames: 6 },
          { state: "b", port: "p", frames: 6 }
        ] }
      },
      body("b", 2, "finite"),
      { id: "bridge", kind: "bridge", frameCount: 2, chunks: [span("bridge", 3)] },
      body("c", 5, "loop")
    ],
    initialState: "a",
    states: [
      { id: "a", bodyUnit: "a" },
      { id: "b", bodyUnit: "b" },
      { id: "c", bodyUnit: "c" }
    ],
    edges: [
      {
        id: "a.b", from: "a", to: "b", trigger: { type: "event", name: "go" },
        start: { type: "portal", sourcePort: "p", targetPort: "p", maxWaitFrames: 3 },
        transition: { kind: "reversible", unit: "rev", direction: "forward" },
        continuity: "exact-authored"
      },
      {
        id: "b.a", from: "b", to: "a", trigger: { type: "event", name: "back" },
        start: { type: "finish", targetPort: "p", maxWaitFrames: 1 },
        transition: { kind: "reversible", unit: "rev", direction: "reverse", reverseOf: "a.b" },
        continuity: "exact-reverse"
      },
      {
        id: "b.c", from: "b", to: "c", trigger: { type: "event", name: "cut" },
        start: { type: "cut", targetPort: "p", maxWaitFrames: 1 },
        continuity: "cut", targetRunwayFrames: 6
      },
      {
        id: "c.a", from: "c", to: "a", trigger: { type: "event", name: "reset" },
        start: { type: "portal", sourcePort: "p", targetPort: "p", maxWaitFrames: 4 },
        transition: { kind: "locked", unit: "bridge" },
        continuity: "exact-authored"
      }
    ],
    bindings: [],
    readiness: { policy: "all-routes", bootstrapUnits: ["a", "rev"], immediateEdges: ["a.b"] },
    limits: {
      maxCompiledBytes: Number.MAX_SAFE_INTEGER,
      maxRuntimeBytes: Number.MAX_SAFE_INTEGER,
      decodedPixelBytes: frameBytes,
      persistentCacheBytes: persistent,
      runtimeWorkingSetBytes: persistent + 12 * frameBytes + 150 + frameBytes
    }
  };
}

function body(id: string, frameCount: number, playback: "loop" | "finite") {
  return {
    id, kind: "body" as const, playback, frameCount,
    ports: [{ id: "p", entryFrame: 0 as const, portalFrames: [0] }],
    chunks: [span(id, id === "a" ? 0 : id === "b" ? 2 : 4)]
  };
}

function span(unit: string, chunkStart: number) {
  return {
    rendition: "r", chunkStart, chunkCount: 1, frameCount: 1,
    sha256: unit.padEnd(64, "0").slice(0, 64)
  };
}

function blobs(manifest: Manifest): Blob[] {
  return manifest.units.map((unit, index) => ({
    rendition: "r", unit: unit.id, chunkStart: index, chunkCount: 1,
    frameCount: unit.frameCount, sha256: "0".repeat(64),
    offset: 100 + index * 30, length: 10 + index * 10
  }));
}
