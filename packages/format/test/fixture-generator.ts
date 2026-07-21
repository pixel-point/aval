import { createHash } from "node:crypto";

import type {
  CanonicalAssetInput,
  CompiledManifest,
  CompiledManifestInput,
  EncodedChunkInput,
  Unit,
  UnitInput
} from "../src/model.js";
import { writeCanonicalAsset } from "../src/writer.js";
import { validManifest } from "./manifest-fixture.js";

const DECLARED_DIGEST = "0".repeat(64);

export interface GeneratedConformanceFixture {
  readonly fileName: "video-loop.avl" | "video-graph.avl";
  readonly description: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

function encodedChunks(manifest: CompiledManifestInput): readonly EncodedChunkInput[] {
  const result: EncodedChunkInput[] = [];
  let ordinal = 0;
  for (const rendition of manifest.renditions) {
    for (const unit of manifest.units) {
      for (let decodeIndex = 0; decodeIndex < unit.frameCount; decodeIndex += 1) {
        result.push(Object.freeze({
          rendition: rendition.id,
          unit: unit.id,
          decodeIndex,
          presentationTimestamp: decodeIndex,
          duration: 1,
          randomAccess: decodeIndex === 0,
          displayedFrameCount: 1,
          bytes: new Uint8Array([0, 0, 1, ordinal++ & 0xff])
        }));
      }
    }
  }
  return Object.freeze(result);
}

function unitInput(unit: Unit): UnitInput {
  const chunks = Object.freeze(
    unit.chunks.map(({ rendition, sha256 }) => Object.freeze({ rendition, sha256 }))
  );
  switch (unit.kind) {
    case "body":
      return Object.freeze({
        id: unit.id,
        kind: unit.kind,
        frameCount: unit.frameCount,
        playback: unit.playback,
        ports: unit.ports,
        chunks
      });
    case "bridge":
    case "one-shot":
      return Object.freeze({ id: unit.id, kind: unit.kind, frameCount: unit.frameCount, chunks });
    case "reversible":
      return Object.freeze({
        id: unit.id,
        kind: unit.kind,
        frameCount: unit.frameCount,
        residency: unit.residency,
        chunks
      });
  }
}

function writerInputFromManifest(source: CompiledManifest): CanonicalAssetInput {
  const { units, ...rest } = source;
  const manifest: CompiledManifestInput = {
    ...rest,
    units: Object.freeze(units.map(unitInput))
  };
  return Object.freeze({ manifest, chunks: encodedChunks(manifest) });
}

function videoLoopInput(): CanonicalAssetInput {
  const manifest: CompiledManifestInput = {
    formatVersion: "1.1",
    generator: "aval-v1.1-video-loop",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: {
      width: 2,
      height: 2,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [{
      id: "video",
      codec: "avc1.42E020",
      bitDepth: 8,
      codedWidth: 16,
      codedHeight: 16,
      alphaLayout: { type: "opaque", colorRect: [0, 0, 2, 2] },
      bitrate: { average: 1_000, peak: 2_000 }
    }],
    units: [{
      id: "idle-body",
      kind: "body",
      playback: "loop",
      frameCount: 3,
      ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 2] }],
      chunks: [{ rendition: "video", sha256: DECLARED_DIGEST }]
    }],
    initialState: "idle",
    states: [{ id: "idle", bodyUnit: "idle-body" }],
    edges: [],
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: ["idle-body"],
      immediateEdges: []
    },
    limits: {
      maxCompiledBytes: 32 * 1024,
      maxRuntimeBytes: 64 * 1024,
      decodedPixelBytes: 1_024,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 1_024
    }
  };
  return Object.freeze({ manifest, chunks: encodedChunks(manifest) });
}

export function generateVideoLoopFixture(): Uint8Array {
  return writeCanonicalAsset(videoLoopInput());
}

export function generateVideoGraphFixture(): Uint8Array {
  return writeCanonicalAsset(writerInputFromManifest(validManifest()));
}

export function fixtureSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function generateConformanceFixtures(): readonly GeneratedConformanceFixture[] {
  const definitions = [
    {
      fileName: "video-loop.avl" as const,
      description: "one-state, three-frame encoded video loop",
      bytes: generateVideoLoopFixture()
    },
    {
      fileName: "video-graph.avl" as const,
      description: "multi-state graph spanning every unit and transition kind",
      bytes: generateVideoGraphFixture()
    }
  ];
  return Object.freeze(definitions.map((fixture) => Object.freeze({
    ...fixture,
    sha256: fixtureSha256(fixture.bytes)
  })));
}
