import {
  FormatError,
  inspectAvcAnnexBRendition,
  type AvcRenditionInspection,
  type RenditionV01
} from "@rendered-motion/format";

import {
  type RuntimeAssetCatalog
} from "./asset-catalog.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure,
  type RuntimeFailureContext
} from "./errors.js";
import {
  createRuntimeCandidateReport,
  type RuntimeCandidateReport
} from "./model.js";

export type RuntimeOpaqueRendition = Extract<
  RenditionV01,
  { readonly profile: "avc-annexb-opaque-v0" }
>;

export interface RuntimeOpaqueRenditionCandidate {
  readonly rank: number;
  readonly codedArea: number;
  readonly rendition: Readonly<RuntimeOpaqueRendition>;
}

export type RuntimeOpaqueRenditionInspection =
  | {
      readonly ok: true;
      readonly candidate: Readonly<RuntimeOpaqueRenditionCandidate>;
      readonly inspection: Readonly<AvcRenditionInspection>;
      readonly report: Readonly<RuntimeCandidateReport>;
    }
  | {
      readonly ok: false;
      readonly candidate: Readonly<RuntimeOpaqueRenditionCandidate>;
      readonly inspection: null;
      readonly report: Readonly<RuntimeCandidateReport>;
    };

/**
 * Pure, input-order-independent M5.5 preference. The format remains the
 * geometry/schema authority; checked multiplication protects this boundary.
 */
export function createOpaqueRenditionCandidates(
  renditions: readonly Readonly<RenditionV01>[]
): readonly Readonly<RuntimeOpaqueRenditionCandidate>[] {
  if (!Array.isArray(renditions)) {
    throw selectionError(
      "invalid-asset",
      "validated rendition collection is unavailable"
    );
  }

  const eligible: Array<{
    readonly codedArea: number;
    readonly rendition: Readonly<RuntimeOpaqueRendition>;
  }> = [];
  for (const rendition of renditions) {
    if (!isExactOpaqueRendition(rendition)) {
      continue;
    }
    eligible.push(Object.freeze({
      codedArea: checkedCodedArea(rendition),
      rendition: cloneOpaqueRendition(rendition)
    }));
  }

  eligible.sort((left, right) => {
    if (left.codedArea !== right.codedArea) {
      return right.codedArea - left.codedArea;
    }
    if (left.rendition.bitrate.peak !== right.rendition.bitrate.peak) {
      return right.rendition.bitrate.peak - left.rendition.bitrate.peak;
    }
    return compareAscii(left.rendition.id, right.rendition.id);
  });

  return Object.freeze(eligible.map((entry, rank) => Object.freeze({
    rank,
    codedArea: entry.codedArea,
    rendition: entry.rendition
  })));
}

/**
 * Assemble fresh catalog-owned sample copies and invoke the sole public AVC
 * inspector across every unit before any worker is created.
 */
export function inspectOpaqueRenditionCandidate(
  catalog: RuntimeAssetCatalog,
  candidate: Readonly<RuntimeOpaqueRenditionCandidate>
): Readonly<RuntimeOpaqueRenditionInspection> {
  try {
    const installed = catalog.renditions.require(candidate.rendition.id);
    if (
      !isExactOpaqueRendition(installed) ||
      !sameOpaqueRendition(installed, candidate.rendition) ||
      candidate.codedArea !== checkedCodedArea(installed) ||
      !Number.isSafeInteger(candidate.rank) ||
      candidate.rank < 0
    ) {
      throw selectionError(
        "invalid-asset",
        "opaque rendition candidate does not match the installed catalog",
        { rendition: candidate.rendition.id, rank: candidate.rank }
      );
    }

    const units = catalog.manifest.units.map((unit) => {
      const accessUnits = Array.from(
        { length: unit.frameCount },
        (_, localFrame) => {
          const entry = catalog.records.require(
            installed.id,
            unit.id,
            localFrame
          );
          return Object.freeze({
            bytes: new Uint8Array(catalog.copySample(
              installed.id,
              unit.id,
              localFrame
            )),
            key: entry.record.key
          });
        }
      );
      return Object.freeze({
        id: unit.id,
        accessUnits: Object.freeze(accessUnits)
      });
    });

    const inspection = inspectAvcAnnexBRendition({
      profile: Object.freeze({
        codedWidth: installed.codedWidth,
        codedHeight: installed.codedHeight,
        frameRate: Object.freeze({
          numerator: catalog.manifest.frameRate.numerator,
          denominator: catalog.manifest.frameRate.denominator
        }),
        averageBitrate: installed.bitrate.average,
        peakBitrate: installed.bitrate.peak,
        cpbBufferBits: installed.bitrate.peak,
        requireBt709LimitedRange: true
      }),
      units: Object.freeze(units)
    });
    const report = createRuntimeCandidateReport({
      rendition: installed.id,
      rank: candidate.rank,
      outcome: "eligible",
      failure: null
    });
    return Object.freeze({
      ok: true,
      candidate,
      inspection,
      report
    });
  } catch (error) {
    const failure = normalizeInspectionFailure(
      error,
      candidate.rendition.id,
      candidate.rank
    );
    const report = createRuntimeCandidateReport({
      rendition: candidate.rendition.id,
      rank: candidate.rank,
      outcome: "rejected",
      failure
    });
    return Object.freeze({
      ok: false,
      candidate,
      inspection: null,
      report
    });
  }
}

function isExactOpaqueRendition(
  rendition: Readonly<RenditionV01> | undefined
): rendition is Readonly<RuntimeOpaqueRendition> {
  if (
    typeof rendition !== "object" ||
    rendition === null ||
    rendition.profile !== "avc-annexb-opaque-v0"
  ) {
    return false;
  }
  const capabilities = rendition.capabilities as readonly unknown[];
  return rendition.codec === "avc1.42E020" &&
    rendition.alphaLayout.type === "opaque-v0" &&
    Array.isArray(capabilities) &&
    capabilities.length === 2 &&
    capabilities[0] === "webcodecs" &&
    capabilities[1] === "webgl2";
}

function checkedCodedArea(
  rendition: Readonly<RuntimeOpaqueRendition>
): number {
  const { codedWidth, codedHeight } = rendition;
  const colorRect = rendition.alphaLayout.colorRect as readonly unknown[];
  if (
    !Number.isSafeInteger(codedWidth) ||
    !Number.isSafeInteger(codedHeight) ||
    codedWidth <= 0 ||
    codedHeight <= 0 ||
    codedWidth > Math.floor(Number.MAX_SAFE_INTEGER / codedHeight) ||
    !Array.isArray(colorRect) ||
    colorRect.length !== 4 ||
    colorRect[0] !== 0 ||
    colorRect[1] !== 0 ||
    colorRect[2] !== codedWidth ||
    colorRect[3] !== codedHeight ||
    !Number.isSafeInteger(rendition.bitrate.average) ||
    rendition.bitrate.average <= 0 ||
    !Number.isSafeInteger(rendition.bitrate.peak) ||
    rendition.bitrate.peak <= 0 ||
    rendition.bitrate.average > rendition.bitrate.peak
  ) {
    throw selectionError(
      "invalid-asset",
      "opaque rendition geometry or bitrate is unsafe",
      { rendition: rendition.id }
    );
  }
  return codedWidth * codedHeight;
}

function cloneOpaqueRendition(
  rendition: Readonly<RuntimeOpaqueRendition>
): Readonly<RuntimeOpaqueRendition> {
  const colorRect = Object.freeze([
    rendition.alphaLayout.colorRect[0],
    rendition.alphaLayout.colorRect[1],
    rendition.alphaLayout.colorRect[2],
    rendition.alphaLayout.colorRect[3]
  ] as const);
  return Object.freeze({
    id: rendition.id,
    profile: "avc-annexb-opaque-v0",
    codec: "avc1.42E020",
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    alphaLayout: Object.freeze({
      type: "opaque-v0" as const,
      colorRect
    }),
    bitrate: Object.freeze({
      average: rendition.bitrate.average,
      peak: rendition.bitrate.peak
    }),
    capabilities: Object.freeze([
      "webcodecs",
      "webgl2"
    ] as const)
  });
}

function sameOpaqueRendition(
  left: Readonly<RuntimeOpaqueRendition>,
  right: Readonly<RuntimeOpaqueRendition>
): boolean {
  return left.id === right.id &&
    left.codedWidth === right.codedWidth &&
    left.codedHeight === right.codedHeight &&
    left.bitrate.average === right.bitrate.average &&
    left.bitrate.peak === right.bitrate.peak &&
    left.alphaLayout.colorRect.every(
      (value, index) => value === right.alphaLayout.colorRect[index]
    );
}

function normalizeInspectionFailure(
  error: unknown,
  rendition: string,
  rank: number
): Readonly<RuntimeFailure> {
  if (error instanceof FormatError) {
    return normalizeRuntimeFailure("unsupported-profile", undefined, {
      rendition,
      rank,
      sourceCode: error.code,
      ...(error.path === undefined ? {} : { sourcePath: error.path }),
      ...(error.offset === undefined ? {} : { offset: error.offset })
    });
  }
  if (error instanceof RuntimePlaybackError) {
    return normalizeRuntimeFailure(
      error.code,
      error.message,
      {
        ...error.failure.context,
        rendition,
        rank
      }
    );
  }
  return normalizeRuntimeFailure("unsupported-profile", undefined, {
    rendition,
    rank
  });
}

function compareAscii(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function selectionError(
  code: "invalid-asset" | "resource-rejection",
  message: string,
  context: Readonly<RuntimeFailureContext> = {}
): RuntimePlaybackError {
  return new RuntimePlaybackError(
    normalizeRuntimeFailure(code, message, context)
  );
}
