import {
  encodeReferenceFrame,
  writeCanonicalAsset,
  type CanonicalAssetInputV01,
  type RenditionV01
} from "@rendered-motion/format";

const DIGEST = "0".repeat(64);

const KEY_ACCESS_UNIT = Object.freeze([
  0, 0, 0, 1, 9, 16, 0, 0, 0, 1, 103, 66, 224, 32, 218, 16, 154,
  106, 2, 2, 2, 128, 0, 0, 3, 0, 128, 0, 0, 30, 70, 208, 68, 35, 80,
  0, 0, 1, 104, 206, 50, 200, 0, 0, 1, 101, 184, 79, 192
] as const);
const DELTA_ACCESS_UNIT = Object.freeze([
  0, 0, 0, 1, 9, 48, 0, 0, 1, 97, 226, 63
] as const);

export interface OpaqueTestAssetOptions {
  readonly corruptIntroDelta?: boolean;
}

export function opaqueTestRendition(
  id = "opaque",
  codedWidth = 64,
  codedHeight = 64,
  peakBitrate = 2_000_000,
  averageBitrate = 1_000_000
): Extract<RenditionV01, { readonly profile: "avc-annexb-opaque-v0" }> {
  return {
    id,
    profile: "avc-annexb-opaque-v0",
    codec: "avc1.42E020",
    codedWidth,
    codedHeight,
    alphaLayout: {
      type: "opaque-v0",
      colorRect: [0, 0, codedWidth, codedHeight]
    },
    bitrate: { average: averageBitrate, peak: peakBitrate },
    capabilities: ["webcodecs", "webgl2"]
  };
}

export function createOpaqueTestAsset(
  options: OpaqueTestAssetOptions = {}
): Uint8Array {
  const rendition = opaqueTestRendition();
  const samples = [{ rendition: rendition.id, sha256: DIGEST }];
  const input: CanonicalAssetInputV01 = {
    manifest: {
      formatVersion: "0.1",
      generator: "player-web-m55-tests",
      canvas: {
        width: 64,
        height: 64,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [rendition],
      units: [
        {
          id: "body",
          kind: "body",
          playback: "loop",
          frameCount: 2,
          ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 1] }],
          samples
        },
        {
          id: "intro",
          kind: "one-shot",
          frameCount: 2,
          samples
        }
      ],
      staticFrames: [
        { id: "idle", width: 64, height: 64, sha256: DIGEST }
      ],
      initialState: "idle",
      states: [
        {
          id: "idle",
          bodyUnit: "body",
          initialUnit: "intro",
          staticFrame: "idle"
        }
      ],
      edges: [],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: ["body", "intro"],
        immediateEdges: []
      },
      fallback: {
        unsupported: "per-state-static",
        reducedMotion: "per-state-static"
      },
      limits: {
        maxCompiledBytes: 64 * 1024,
        maxRuntimeBytes: 1024 * 1024,
        decodedPixelBytes: 64 * 64 * 4,
        persistentCacheBytes: 0,
        runtimeWorkingSetBytes: 64 * 64 * 4
      }
    },
    accessUnits: [
      accessUnit("body", 0, true, KEY_ACCESS_UNIT),
      accessUnit("body", 1, false, DELTA_ACCESS_UNIT),
      accessUnit("intro", 0, true, KEY_ACCESS_UNIT),
      accessUnit(
        "intro",
        1,
        false,
        options.corruptIntroDelta === true
          ? [0, 0, 0, 1, 9, 48, 0, 0, 1, 97]
          : DELTA_ACCESS_UNIT
      )
    ],
    staticPayloads: [
      { staticFrame: "idle", bytes: shallowPng(64, 64) }
    ]
  };

  return writeCanonicalAsset(input);
}

export interface IntegratedOpaqueTestAssetOptions {
  readonly corruptHighIntroDelta?: boolean;
}

/** Two candidates and two states for integrated lifecycle tests. */
export function createIntegratedOpaqueTestAsset(
  options: IntegratedOpaqueTestAssetOptions = {}
): Uint8Array {
  const renditions = [
    opaqueTestRendition("opaque-high", 64, 64, 2_000_000, 1_000_000),
    opaqueTestRendition("opaque-low", 64, 64, 1_000_000, 500_000)
  ] as const;
  const samples = renditions.map(({ id }) => ({
    rendition: id,
    sha256: DIGEST
  }));
  const units = [
    {
      id: "hover-body",
      kind: "body",
      playback: "loop",
      frameCount: 2,
      ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 1] }],
      samples
    },
    {
      id: "idle-body",
      kind: "body",
      playback: "loop",
      frameCount: 2,
      ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 1] }],
      samples
    },
    {
      id: "intro",
      kind: "one-shot",
      frameCount: 2,
      samples
    }
  ] as const;
  const accessUnits: CanonicalAssetInputV01["accessUnits"] = renditions.flatMap(
    ({ id: rendition }) => units.flatMap(({ id: unit }) => [
      accessUnitFor(rendition, unit, 0, true, KEY_ACCESS_UNIT),
      accessUnitFor(
        rendition,
        unit,
        1,
        false,
        options.corruptHighIntroDelta === true &&
          rendition === "opaque-high" &&
          unit === "intro"
          ? [0, 0, 0, 1, 9, 48, 0, 0, 1, 97]
          : DELTA_ACCESS_UNIT
      )
    ])
  );
  return writeCanonicalAsset({
    manifest: {
      formatVersion: "0.1",
      generator: "player-web-integrated-tests",
      canvas: {
        width: 64,
        height: 64,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions,
      units,
      staticFrames: [
        { id: "hover-static", width: 64, height: 64, sha256: DIGEST },
        { id: "idle-static", width: 64, height: 64, sha256: DIGEST }
      ],
      initialState: "idle",
      states: [
        {
          id: "hover",
          bodyUnit: "hover-body",
          staticFrame: "hover-static"
        },
        {
          id: "idle",
          bodyUnit: "idle-body",
          initialUnit: "intro",
          staticFrame: "idle-static"
        }
      ],
      edges: [
        {
          id: "hover-idle",
          from: "hover",
          to: "idle",
          start: {
            type: "cut",
            targetPort: "default",
            maxWaitFrames: 1
          },
          continuity: "cut",
          targetRunwayFrames: 6
        },
        {
          id: "idle-hover",
          from: "idle",
          to: "hover",
          start: {
            type: "cut",
            targetPort: "default",
            maxWaitFrames: 1
          },
          continuity: "cut",
          targetRunwayFrames: 6
        }
      ],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: ["hover-body", "idle-body", "intro"],
        immediateEdges: ["idle-hover"]
      },
      fallback: {
        unsupported: "per-state-static",
        reducedMotion: "per-state-static"
      },
      limits: {
        maxCompiledBytes: 128 * 1024,
        maxRuntimeBytes: 8 * 1024 * 1024,
        decodedPixelBytes: 64 * 64 * 4,
        persistentCacheBytes: 12 * 64 * 64 * 4,
        runtimeWorkingSetBytes: 2 * 1024 * 1024
      }
    },
    accessUnits,
    staticPayloads: [
      { staticFrame: "hover-static", bytes: shallowPng(64, 64) },
      { staticFrame: "idle-static", bytes: shallowPng(64, 64) }
    ]
  });
}

/** One-rendition graph spanning the non-resident M5.5 playback path matrix. */
export function createIntegratedPathTestAsset(): Uint8Array {
  const rendition = opaqueTestRendition("opaque-path", 64, 64);
  const samples = [{ rendition: rendition.id, sha256: DIGEST }];
  const units = [
    bodyUnit("idle-body", "loop", 4, [1, 3], samples),
    bodyUnit("hover-body", "loop", 3, [0, 2], samples),
    bodyUnit("loading-body", "finite", 3, [0, 1, 2], samples),
    bodyUnit("archive-body", "finite", 3, [1, 2], samples),
    bodyUnit("success-body", "loop", 2, [1], samples),
    bodyUnit("done-body", "finite", 1, [0], samples),
    {
      id: "intro",
      kind: "one-shot",
      frameCount: 2,
      samples
    },
    {
      id: "one-bridge",
      kind: "bridge",
      frameCount: 1,
      samples
    },
    {
      id: "long-bridge",
      kind: "bridge",
      frameCount: 5,
      samples
    }
  ] as const;
  const accessUnits: CanonicalAssetInputV01["accessUnits"] = units.flatMap(
    (unit) => Array.from({ length: unit.frameCount }, (_, frameIndex) =>
      accessUnitFor(
        rendition.id,
        unit.id,
        frameIndex,
        frameIndex === 0,
        frameIndex === 0 ? KEY_ACCESS_UNIT : deltaAccessUnit(frameIndex)
      )
    )
  );
  const states = ["idle", "hover", "loading", "archive", "success", "done"]
    .map((id) => ({
      id,
      bodyUnit: `${id}-body`,
      ...(id === "idle" ? { initialUnit: "intro" } : {}),
      staticFrame: `${id}-static`
    }));
  const staticFrames = states.map(({ id, staticFrame }) => ({
    id: staticFrame,
    width: 64,
    height: 64,
    sha256: DIGEST
  }));

  return writeCanonicalAsset({
    manifest: {
      formatVersion: "0.1",
      generator: "player-web-integrated-path-tests",
      canvas: {
        width: 64,
        height: 64,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [rendition],
      units,
      staticFrames,
      initialState: "idle",
      states,
      edges: [
        portalEdge("idle-hover", "idle", "hover"),
        portalEdge("hover-idle", "hover", "idle"),
        portalEdge("done-idle", "done", "idle"),
        portalEdge("archive-idle", "archive", "idle"),
        {
          ...portalEdge("idle-loading", "idle", "loading"),
          transition: { kind: "locked", unit: "one-bridge" }
        },
        {
          ...portalEdge("idle-archive", "idle", "archive"),
          transition: { kind: "locked", unit: "long-bridge" }
        },
        portalEdge("loading-success", "loading", "success"),
        {
          id: "archive-success",
          from: "archive",
          to: "success",
          start: {
            type: "finish",
            targetPort: "default",
            maxWaitFrames: 8
          },
          continuity: "exact-authored"
        },
        {
          id: "loading-done",
          from: "loading",
          to: "done",
          trigger: { type: "completion" },
          start: {
            type: "finish",
            targetPort: "default",
            maxWaitFrames: 8
          },
          continuity: "exact-authored"
        }
      ],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: units.map(({ id }) => id),
        immediateEdges: ["idle-hover", "idle-loading", "idle-archive"]
      },
      fallback: {
        unsupported: "per-state-static",
        reducedMotion: "per-state-static"
      },
      limits: {
        maxCompiledBytes: 256 * 1024,
        maxRuntimeBytes: 8 * 1024 * 1024,
        decodedPixelBytes: 64 * 64 * 4,
        persistentCacheBytes: 0,
        runtimeWorkingSetBytes: 2 * 1024 * 1024
      }
    },
    accessUnits,
    staticPayloads: staticFrames.map(({ id }) => ({
      staticFrame: id,
      bytes: shallowPng(64, 64)
    }))
  });
}

/** Valid but deliberately has no M5.5 animated rendition candidate. */
export function createReferenceOnlyTestAsset(): Uint8Array {
  const rendition: Extract<
    RenditionV01,
    { readonly profile: "reference-rgba-v0" }
  > = {
    id: "reference",
    profile: "reference-rgba-v0",
    codec: "rma.reference-rgba",
    codedWidth: 2,
    codedHeight: 2,
    alphaLayout: { type: "straight-rgba-v0" },
    capabilities: []
  };
  const samples = [{ rendition: rendition.id, sha256: DIGEST }];
  const rgba = new Uint8Array(2 * 2 * 4).fill(255);
  return writeCanonicalAsset({
    manifest: {
      formatVersion: "0.1",
      generator: "player-web-reference-only-tests",
      canvas: {
        width: 2,
        height: 2,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [rendition],
      units: [{
        id: "body",
        kind: "body",
        playback: "loop",
        frameCount: 2,
        ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 1] }],
        samples
      }],
      staticFrames: [
        { id: "idle-static", width: 2, height: 2, sha256: DIGEST }
      ],
      initialState: "idle",
      states: [{ id: "idle", bodyUnit: "body", staticFrame: "idle-static" }],
      edges: [],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: ["body"],
        immediateEdges: []
      },
      fallback: {
        unsupported: "per-state-static",
        reducedMotion: "per-state-static"
      },
      limits: {
        maxCompiledBytes: 64 * 1024,
        maxRuntimeBytes: 1024 * 1024,
        decodedPixelBytes: 16,
        persistentCacheBytes: 0,
        runtimeWorkingSetBytes: 1024
      }
    },
    accessUnits: [0, 1].map((frameIndex) => ({
      rendition: rendition.id,
      unit: "body",
      frameIndex,
      key: true,
      bytes: encodeReferenceFrame({ width: 2, height: 2, frameIndex, rgba })
    })),
    staticPayloads: [
      { staticFrame: "idle-static", bytes: shallowPng(2, 2) }
    ]
  });
}

function accessUnit(
  unit: string,
  frameIndex: number,
  key: boolean,
  values: readonly number[]
): CanonicalAssetInputV01["accessUnits"][number] {
  return {
    rendition: "opaque",
    unit,
    frameIndex,
    key,
    bytes: new Uint8Array(values)
  };
}

function accessUnitFor(
  rendition: string,
  unit: string,
  frameIndex: number,
  key: boolean,
  values: readonly number[]
): CanonicalAssetInputV01["accessUnits"][number] {
  return {
    rendition,
    unit,
    frameIndex,
    key,
    bytes: new Uint8Array(values)
  };
}

function bodyUnit(
  id: string,
  playback: "loop" | "finite",
  frameCount: number,
  portalFrames: readonly number[],
  samples: readonly { readonly rendition: string; readonly sha256: string }[]
) {
  return {
    id,
    kind: "body" as const,
    playback,
    frameCount,
    ports: [{ id: "default", entryFrame: 0 as const, portalFrames }],
    samples
  };
}

function portalEdge(id: string, from: string, to: string) {
  return {
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
  };
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
  ue(0); // first_macroblock_in_slice
  ue(0); // P slice
  ue(0); // PPS zero
  fixed(frameNum, 4);
  bit(false); // num_ref_idx_active_override_flag
  bit(false); // ref_pic_list_modification_flag_l0
  bit(false); // adaptive_ref_pic_marking_mode_flag
  ue(0); // slice_qp_delta
  ue(0); // disable_deblocking_filter_idc
  ue(0); // slice_alpha_c0_offset_div2
  ue(0); // slice_beta_offset_div2
  bit(true); // opaque CAVLC fixture bit
  bit(true); // rbsp_stop_one_bit
  while (bits.length % 8 !== 0) bit(false);
  const slice = new Array<number>(bits.length / 8).fill(0);
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] === 1) {
      const byte = Math.floor(index / 8);
      slice[byte] = slice[byte]! | (1 << (7 - (index % 8)));
    }
  }
  return [0, 0, 0, 1, 9, 48, 0, 0, 1, 97, ...slice];
}

function shallowPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeUint32Be(bytes, 8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  writeUint32Be(bytes, 16, width);
  writeUint32Be(bytes, 20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0xde, 0xad, 0xbe, 0xef], 29);
  return bytes;
}

function writeUint32Be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = Math.floor(value / 0x100_0000) & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x1_0000) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
