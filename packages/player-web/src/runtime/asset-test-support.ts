import {
  writeCanonicalAsset,
  type CanonicalAssetInput,
  type ChunkDigestInput,
  type EncodedChunkInput,
  type ProductionRenditionV1_0,
  type UnitInput
} from "@pixel-point/aval-format";

const DIGEST = "0".repeat(64);
const TWO_FRAME_H264_DIGEST =
  "3801db7b8816b53a06db163aea978616c754e3bc193d8cc90434da506c168341";

const KEY_ACCESS_UNIT = hexNumbers(
  "0000000109100000000167640020ace5109a6a02020280000003008000001e46d04422cb0000000168eeb2c8b00000000165b840fc"
);
const DELTA_ACCESS_UNIT = hexNumbers(
  "0000000109300000000141e243f8"
);

export interface RuntimeTestAssetOptions {
  readonly corruptIntroDelta?: boolean;
  readonly pixelAspect?: readonly [number, number];
}

export function opaqueTestRendition(
  id = "opaque",
  codedWidth = 64,
  codedHeight = 64,
  peakBitrate = 2_000_000,
  averageBitrate = 1_000_000
): ProductionRenditionV1_0 {
  return Object.freeze({
    id,
    codec: "avc1.640020",
    bitDepth: 8,
    codedWidth,
    codedHeight,
    alphaLayout: Object.freeze({
      type: "opaque" as const,
      colorRect: Object.freeze([0, 0, codedWidth, codedHeight] as const)
    }),
    bitrate: Object.freeze({ average: averageBitrate, peak: peakBitrate })
  });
}

export function createRuntimeTestAsset(
  options: RuntimeTestAssetOptions = {}
): Uint8Array {
  const rendition = opaqueTestRendition();
  const descriptors = chunkDescriptors([rendition], TWO_FRAME_H264_DIGEST);
  const units: readonly UnitInput[] = Object.freeze([
    bodyUnit("body", "loop", 2, [0, 1], descriptors),
    Object.freeze({
      id: "intro",
      kind: "one-shot" as const,
      frameCount: 2,
      chunks: descriptors
    })
  ]);
  const chunks = Object.freeze([
    encodedChunk(rendition.id, "body", 0, true, KEY_ACCESS_UNIT),
    encodedChunk(rendition.id, "body", 1, false, DELTA_ACCESS_UNIT),
    encodedChunk(rendition.id, "intro", 0, true, KEY_ACCESS_UNIT),
    encodedChunk(
      rendition.id,
      "intro",
      1,
      false,
      options.corruptIntroDelta === true
        ? DELTA_ACCESS_UNIT.slice(0, -2)
        : DELTA_ACCESS_UNIT
    )
  ]);

  return writeCanonicalAsset({
    manifest: baseManifest({
      generator: "player-web-tests",
      pixelAspect: options.pixelAspect ?? [1, 1],
      renditions: [rendition],
      units,
      initialState: "idle",
      states: [{ id: "idle", bodyUnit: "body", initialUnit: "intro" }],
      edges: [],
      bootstrapUnits: ["body", "intro"],
      immediateEdges: [],
      maxCompiledBytes: 64 * 1024,
      maxRuntimeBytes: 1024 * 1024,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 64 * 64 * 4
    }),
    chunks
  });
}

export interface IntegratedTestAssetOptions {
  readonly corruptHighIntroDelta?: boolean;
}

/** Two authored quality rungs and two states for integrated lifecycle tests. */
export function createIntegratedTestAsset(
  options: IntegratedTestAssetOptions = {}
): Uint8Array {
  const renditions = Object.freeze([
    opaqueTestRendition("opaque-high", 64, 64, 2_000_000, 1_000_000),
    opaqueTestRendition("opaque-low", 64, 64, 1_000_000, 500_000)
  ]);
  const descriptors = chunkDescriptors(renditions, TWO_FRAME_H264_DIGEST);
  const units: readonly UnitInput[] = Object.freeze([
    bodyUnit("hover-body", "loop", 2, [0, 1], descriptors),
    bodyUnit("idle-body", "loop", 2, [0, 1], descriptors),
    Object.freeze({
      id: "intro",
      kind: "one-shot" as const,
      frameCount: 2,
      chunks: descriptors
    })
  ]);
  const chunks = Object.freeze(renditions.flatMap((rendition) =>
    units.flatMap((unit) => [
      encodedChunk(rendition.id, unit.id, 0, true, KEY_ACCESS_UNIT),
      encodedChunk(
        rendition.id,
        unit.id,
        1,
        false,
        options.corruptHighIntroDelta === true &&
          rendition.id === "opaque-high" &&
          unit.id === "intro"
          ? DELTA_ACCESS_UNIT.slice(0, -2)
          : DELTA_ACCESS_UNIT
      )
    ])
  ));

  return writeCanonicalAsset({
    manifest: baseManifest({
      generator: "player-web-integrated-tests",
      pixelAspect: [1, 1],
      renditions,
      units,
      initialState: "idle",
      states: [
        { id: "hover", bodyUnit: "hover-body" },
        { id: "idle", bodyUnit: "idle-body", initialUnit: "intro" }
      ],
      edges: [
        cutEdge("hover-idle", "hover", "idle"),
        cutEdge("idle-hover", "idle", "hover")
      ],
      bootstrapUnits: ["hover-body", "idle-body", "intro"],
      immediateEdges: ["idle-hover"],
      maxCompiledBytes: 128 * 1024,
      maxRuntimeBytes: 8 * 1024 * 1024,
      persistentCacheBytes: 12 * 64 * 64 * 4,
      runtimeWorkingSetBytes: 2 * 1024 * 1024
    }),
    chunks
  });
}

/** One-rendition graph spanning the non-resident playback path matrix. */
export function createIntegratedPathTestAsset(): Uint8Array {
  const rendition = opaqueTestRendition("opaque-path", 64, 64);
  const descriptors = chunkDescriptors([rendition]);
  const units: readonly UnitInput[] = Object.freeze([
    bodyUnit("idle-body", "loop", 4, [1, 3], descriptors),
    bodyUnit("hover-body", "loop", 3, [0, 2], descriptors),
    bodyUnit("loading-body", "finite", 3, [0, 1, 2], descriptors),
    bodyUnit("archive-body", "finite", 3, [1, 2], descriptors),
    bodyUnit("success-body", "loop", 2, [1], descriptors),
    bodyUnit("done-body", "finite", 1, [0], descriptors),
    Object.freeze({
      id: "intro",
      kind: "one-shot" as const,
      frameCount: 2,
      chunks: descriptors
    }),
    Object.freeze({
      id: "one-bridge",
      kind: "bridge" as const,
      frameCount: 1,
      chunks: descriptors
    }),
    Object.freeze({
      id: "long-bridge",
      kind: "bridge" as const,
      frameCount: 5,
      chunks: descriptors
    })
  ]);
  const chunks = Object.freeze(units.flatMap((unit) =>
    Array.from({ length: unit.frameCount }, (_, frameIndex) =>
      encodedChunk(
        rendition.id,
        unit.id,
        frameIndex,
        frameIndex === 0,
        frameIndex === 0 ? KEY_ACCESS_UNIT : deltaAccessUnit(frameIndex)
      )
    )
  ));
  const states = ["idle", "hover", "loading", "archive", "success", "done"]
    .map((id) => ({
      id,
      bodyUnit: `${id}-body`,
      ...(id === "idle" ? { initialUnit: "intro" } : {})
    }));

  return writeCanonicalAsset({
    manifest: baseManifest({
      generator: "player-web-integrated-path-tests",
      pixelAspect: [1, 1],
      renditions: [rendition],
      units,
      initialState: "idle",
      states,
      edges: [
        portalEdge("idle-hover", "idle", "hover"),
        portalEdge("hover-idle", "hover", "idle"),
        portalEdge("done-idle", "done", "idle"),
        portalEdge("archive-idle", "archive", "idle"),
        {
          ...portalEdge("idle-loading", "idle", "loading"),
          transition: { kind: "locked" as const, unit: "one-bridge" }
        },
        {
          ...portalEdge("idle-archive", "idle", "archive"),
          transition: { kind: "locked" as const, unit: "long-bridge" }
        },
        portalEdge("loading-success", "loading", "success"),
        {
          id: "archive-success",
          from: "archive",
          to: "success",
          start: {
            type: "finish" as const,
            targetPort: "default",
            maxWaitFrames: 8
          },
          continuity: "exact-authored" as const
        },
        {
          id: "loading-done",
          from: "loading",
          to: "done",
          trigger: { type: "completion" as const },
          start: {
            type: "finish" as const,
            targetPort: "default",
            maxWaitFrames: 8
          },
          continuity: "exact-authored" as const
        }
      ],
      bootstrapUnits: units.map(({ id }) => id),
      immediateEdges: ["idle-hover", "idle-loading", "idle-archive"],
      maxCompiledBytes: 256 * 1024,
      maxRuntimeBytes: 8 * 1024 * 1024,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 2 * 1024 * 1024
    }),
    chunks
  });
}

interface BaseManifestInput {
  readonly generator: string;
  readonly pixelAspect: readonly [number, number];
  readonly renditions: readonly ProductionRenditionV1_0[];
  readonly units: readonly UnitInput[];
  readonly initialState: string;
  readonly states: CanonicalAssetInput["manifest"]["states"];
  readonly edges: CanonicalAssetInput["manifest"]["edges"];
  readonly bootstrapUnits: readonly string[];
  readonly immediateEdges: readonly string[];
  readonly maxCompiledBytes: number;
  readonly maxRuntimeBytes: number;
  readonly persistentCacheBytes: number;
  readonly runtimeWorkingSetBytes: number;
}

function baseManifest(
  input: BaseManifestInput
): CanonicalAssetInput["manifest"] {
  return {
    formatVersion: "1.0",
    generator: input.generator,
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: {
      width: 64,
      height: 64,
      fit: "contain",
      pixelAspect: input.pixelAspect,
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: input.renditions,
    units: input.units,
    initialState: input.initialState,
    states: input.states,
    edges: input.edges,
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: input.bootstrapUnits,
      immediateEdges: input.immediateEdges
    },
    limits: {
      maxCompiledBytes: input.maxCompiledBytes,
      maxRuntimeBytes: input.maxRuntimeBytes,
      decodedPixelBytes: 64 * 64 * 4,
      persistentCacheBytes: input.persistentCacheBytes,
      runtimeWorkingSetBytes: input.runtimeWorkingSetBytes
    }
  };
}

function chunkDescriptors(
  renditions: readonly ProductionRenditionV1_0[],
  sha256 = DIGEST
): readonly ChunkDigestInput[] {
  return Object.freeze(renditions.map(({ id }) => Object.freeze({
    rendition: id,
    sha256
  })));
}

function encodedChunk(
  rendition: string,
  unit: string,
  decodeIndex: number,
  randomAccess: boolean,
  values: readonly number[]
): Readonly<EncodedChunkInput> {
  return Object.freeze({
    rendition,
    unit,
    decodeIndex,
    presentationTimestamp: decodeIndex,
    duration: 1,
    randomAccess,
    displayedFrameCount: 1,
    bytes: new Uint8Array(values)
  });
}

function bodyUnit(
  id: string,
  playback: "loop" | "finite",
  frameCount: number,
  portalFrames: readonly number[],
  chunks: readonly ChunkDigestInput[]
): Extract<UnitInput, { readonly kind: "body" }> {
  return Object.freeze({
    id,
    kind: "body",
    playback,
    frameCount,
    ports: [Object.freeze({ id: "default", entryFrame: 0, portalFrames })],
    chunks
  });
}

function cutEdge(id: string, from: string, to: string) {
  return Object.freeze({
    id,
    from,
    to,
    start: {
      type: "cut" as const,
      targetPort: "default",
      maxWaitFrames: 1 as const
    },
    continuity: "cut" as const,
    targetRunwayFrames: 6
  });
}

function portalEdge(id: string, from: string, to: string) {
  return Object.freeze({
    id,
    from,
    to,
    start: {
      type: "portal" as const,
      sourcePort: "default",
      targetPort: "default",
      maxWaitFrames: 16
    },
    continuity: "exact-authored" as const
  });
}

function deltaAccessUnit(frameNum: number): readonly number[] {
  const bits: number[] = [];
  const bit = (value: boolean | number): void => {
    bits.push(value ? 1 : 0);
  };
  const fixed = (value: number, width: number): void => {
    for (let shift = width - 1; shift >= 0; shift -= 1) {
      bit(Math.floor(value / 2 ** shift) % 2);
    }
  };
  const ue = (value: number): void => {
    const code = value + 1;
    const width = Math.floor(Math.log2(code)) + 1;
    for (let index = 1; index < width; index += 1) bit(0);
    fixed(code, width);
  };
  ue(0);
  ue(0);
  ue(0);
  fixed(frameNum, 4);
  fixed((frameNum * 2) % 16, 4);
  bit(false);
  bit(false);
  bit(false);
  ue(0);
  ue(0);
  ue(0);
  ue(0);
  ue(0);
  bit(true);
  bit(true);
  while (bits.length % 8 !== 0) bit(false);
  const slice = new Array<number>(bits.length / 8).fill(0);
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] === 1) {
      const byte = Math.floor(index / 8);
      slice[byte] = slice[byte]! | (1 << (7 - (index % 8)));
    }
  }
  return Object.freeze([0, 0, 0, 1, 9, 48, 0, 0, 0, 1, 65, ...slice]);
}

function hexNumbers(value: string): readonly number[] {
  if (value.length % 2 !== 0) throw new TypeError("hex fixture is malformed");
  return Object.freeze(Array.from(
    { length: value.length / 2 },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  ));
}
