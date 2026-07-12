import {
  FormatError,
  deriveAvcRenditionGeometry,
  type AvcRenditionGeometry,
  type AvcRenditionInspection,
  type RenditionV01
} from "@rendered-motion/format";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import { inspectRuntimeCatalogAvcRendition } from "./borrowed-avc-inspection.js";
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

export type RuntimeAvcRendition = Extract<
  RenditionV01,
  {
    readonly profile:
      | "avc-annexb-opaque-v0"
      | "avc-annexb-packed-alpha-v0";
  }
>;

export interface RuntimeAvcRenditionCandidate {
  readonly rank: number;
  readonly visibleColorArea: number;
  /** Retained diagnostic/resource fact; never used as the quality rank. */
  readonly codedArea: number;
  readonly geometry: Readonly<AvcRenditionGeometry>;
  readonly rendition: Readonly<RuntimeAvcRendition>;
}

export type RuntimeAvcRenditionInspection =
  | {
      readonly ok: true;
      readonly candidate: Readonly<RuntimeAvcRenditionCandidate>;
      readonly inspection: Readonly<AvcRenditionInspection>;
      readonly report: Readonly<RuntimeCandidateReport>;
    }
  | {
      readonly ok: false;
      readonly candidate: Readonly<RuntimeAvcRenditionCandidate>;
      readonly inspection: null;
      readonly report: Readonly<RuntimeCandidateReport>;
    };

export interface RuntimeAvcCanvas {
  readonly width: number;
  readonly height: number;
}

/** @deprecated Use RuntimeAvcRendition. */
export type RuntimeOpaqueRendition = Extract<
  RenditionV01,
  { readonly profile: "avc-annexb-opaque-v0" }
>;
/** @deprecated Use RuntimeAvcRenditionCandidate. */
export type RuntimeOpaqueRenditionCandidate = RuntimeAvcRenditionCandidate;
/** @deprecated Use RuntimeAvcRenditionInspection. */
export type RuntimeOpaqueRenditionInspection = RuntimeAvcRenditionInspection;

/**
 * Pure, input-order-independent AVC preference. Visible color area is the
 * quality authority; packed storage area remains only a resource fact.
 */
export function createAvcRenditionCandidates(
  renditions: readonly Readonly<RenditionV01>[],
  canvas?: Readonly<RuntimeAvcCanvas>
): readonly Readonly<RuntimeAvcRenditionCandidate>[] {
  if (!Array.isArray(renditions)) {
    throw selectionError(
      "invalid-asset",
      "validated rendition collection is unavailable"
    );
  }

  const production = renditions.filter(isExactAvcRendition);
  if (production.length === 0) return Object.freeze([]);
  const checkedCanvas = canvas ?? inferCompatibilityCanvas(production);
  const alphaClass = production[0]!.profile;
  if (production.some(({ profile }) => profile !== alphaClass)) {
    throw selectionError(
      "invalid-asset",
      "opaque and packed AVC candidates cannot be mixed"
    );
  }

  const eligible = production.map((rendition) => {
    try {
      validateBitrate(rendition);
      const geometry = deriveGeometry(checkedCanvas, rendition);
      return Object.freeze({
        visibleColorArea: geometry.visibleColorArea,
        codedArea: checkedCodedArea(geometry, rendition.id),
        geometry,
        rendition: cloneAvcRendition(rendition)
      });
    } catch (error) {
      throw normalizeSelectionError(error, rendition.id);
    }
  });

  eligible.sort((left, right) => {
    if (left.visibleColorArea !== right.visibleColorArea) {
      return right.visibleColorArea - left.visibleColorArea;
    }
    if (left.rendition.bitrate.peak !== right.rendition.bitrate.peak) {
      return right.rendition.bitrate.peak - left.rendition.bitrate.peak;
    }
    return compareAscii(left.rendition.id, right.rendition.id);
  });

  return Object.freeze(eligible.map((entry, rank) => Object.freeze({
    rank,
    visibleColorArea: entry.visibleColorArea,
    codedArea: entry.codedArea,
    geometry: entry.geometry,
    rendition: entry.rendition
  })));
}

/** Thin compatibility name over the same neutral implementation. */
export const createOpaqueRenditionCandidates = createAvcRenditionCandidates;

/**
 * Invoke the sole AVC inspector through the catalog's private synchronous
 * borrow authority before any worker or transfer-owned sample is created.
 */
export function inspectAvcRenditionCandidate(
  catalog: RuntimeAssetCatalog,
  candidate: Readonly<RuntimeAvcRenditionCandidate>
): Readonly<RuntimeAvcRenditionInspection> {
  try {
    const installed = catalog.renditions.require(candidate.rendition.id);
    if (!isExactAvcRendition(installed)) {
      throw selectionError(
        "invalid-asset",
        "AVC rendition candidate does not match the installed catalog",
        { rendition: candidate.rendition.id, rank: candidate.rank }
      );
    }
    const geometry = deriveGeometry(catalog.manifest.canvas, installed);
    if (
      !sameAvcRendition(installed, candidate.rendition) ||
      candidate.visibleColorArea !== geometry.visibleColorArea ||
      candidate.codedArea !== checkedCodedArea(geometry, installed.id) ||
      !sameGeometry(candidate.geometry, geometry) ||
      !Number.isSafeInteger(candidate.rank) ||
      candidate.rank < 0
    ) {
      throw selectionError(
        "invalid-asset",
        "AVC rendition candidate does not match the installed catalog",
        { rendition: candidate.rendition.id, rank: candidate.rank }
      );
    }

    const inspection = inspectRuntimeCatalogAvcRendition(
      catalog,
      installed.id,
      Object.freeze({
        codedWidth: installed.codedWidth,
        codedHeight: installed.codedHeight,
        expectedDecodedStorageRect: geometry.decodedStorageRect,
        frameRate: Object.freeze({
          numerator: catalog.manifest.frameRate.numerator,
          denominator: catalog.manifest.frameRate.denominator
        }),
        averageBitrate: installed.bitrate.average,
        peakBitrate: installed.bitrate.peak,
        cpbBufferBits: installed.bitrate.peak,
        requireBt709LimitedRange: true
      })
    );
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

/** Thin compatibility name over the same neutral implementation. */
export const inspectOpaqueRenditionCandidate = inspectAvcRenditionCandidate;

function isExactAvcRendition(
  rendition: Readonly<RenditionV01> | undefined
): rendition is Readonly<RuntimeAvcRendition> {
  if (typeof rendition !== "object" || rendition === null) return false;
  const profileMatches =
    (rendition.profile === "avc-annexb-opaque-v0" &&
      rendition.alphaLayout.type === "opaque-v0") ||
    (rendition.profile === "avc-annexb-packed-alpha-v0" &&
      rendition.alphaLayout.type === "stacked-v0");
  const capabilities = rendition.capabilities as readonly unknown[];
  return profileMatches &&
    rendition.codec === "avc1.42E020" &&
    Array.isArray(capabilities) &&
    capabilities.length === 2 &&
    capabilities[0] === "webcodecs" &&
    capabilities[1] === "webgl2";
}

function deriveGeometry(
  canvas: Readonly<RuntimeAvcCanvas>,
  rendition: Readonly<RuntimeAvcRendition>
): Readonly<AvcRenditionGeometry> {
  const base = {
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    profile: rendition.profile,
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    colorRect: rendition.alphaLayout.colorRect
  } as const;
  return rendition.profile === "avc-annexb-packed-alpha-v0"
    ? deriveAvcRenditionGeometry({
        ...base,
        profile: "avc-annexb-packed-alpha-v0",
        alphaRect: rendition.alphaLayout.alphaRect
      })
    : deriveAvcRenditionGeometry({
        ...base,
        profile: "avc-annexb-opaque-v0"
      });
}

function inferCompatibilityCanvas(
  renditions: readonly Readonly<RuntimeAvcRendition>[]
): Readonly<RuntimeAvcCanvas> {
  let width = 0;
  let height = 0;
  for (const rendition of renditions) {
    const rect = rendition.alphaLayout.colorRect as readonly unknown[];
    if (
      !Array.isArray(rect) ||
      rect.length !== 4 ||
      !Number.isSafeInteger(rect[2]) ||
      !Number.isSafeInteger(rect[3]) ||
      (rect[2] as number) <= 0 ||
      (rect[3] as number) <= 0
    ) {
      throw selectionError(
        "invalid-asset",
        "AVC rendition has no safe visible color size",
        { rendition: rendition.id }
      );
    }
    width = Math.max(width, rect[2] as number);
    height = Math.max(height, rect[3] as number);
  }
  return Object.freeze({ width, height });
}

function validateBitrate(rendition: Readonly<RuntimeAvcRendition>): void {
  if (
    !Number.isSafeInteger(rendition.bitrate.average) ||
    rendition.bitrate.average <= 0 ||
    !Number.isSafeInteger(rendition.bitrate.peak) ||
    rendition.bitrate.peak <= 0 ||
    rendition.bitrate.average > rendition.bitrate.peak
  ) {
    throw selectionError(
      "invalid-asset",
      "AVC rendition bitrate is unsafe",
      { rendition: rendition.id }
    );
  }
}

function checkedCodedArea(
  geometry: Readonly<AvcRenditionGeometry>,
  rendition: string
): number {
  if (
    geometry.codedWidth >
      Math.floor(Number.MAX_SAFE_INTEGER / geometry.codedHeight)
  ) {
    throw selectionError(
      "invalid-asset",
      "AVC rendition coded area is unsafe",
      { rendition }
    );
  }
  return geometry.codedWidth * geometry.codedHeight;
}

function cloneAvcRendition(
  rendition: Readonly<RuntimeAvcRendition>
): Readonly<RuntimeAvcRendition> {
  const colorRect = cloneRect(rendition.alphaLayout.colorRect);
  const common = {
    id: rendition.id,
    codec: "avc1.42E020" as const,
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    bitrate: Object.freeze({
      average: rendition.bitrate.average,
      peak: rendition.bitrate.peak
    }),
    capabilities: Object.freeze(["webcodecs", "webgl2"] as const)
  };
  if (rendition.profile === "avc-annexb-packed-alpha-v0") {
    return Object.freeze({
      ...common,
      profile: "avc-annexb-packed-alpha-v0" as const,
      alphaLayout: Object.freeze({
        type: "stacked-v0" as const,
        colorRect,
        alphaRect: cloneRect(rendition.alphaLayout.alphaRect)
      })
    });
  }
  return Object.freeze({
    ...common,
    profile: "avc-annexb-opaque-v0" as const,
    alphaLayout: Object.freeze({ type: "opaque-v0" as const, colorRect })
  });
}

function cloneRect(rect: readonly number[]): readonly [number, number, number, number] {
  return Object.freeze([rect[0]!, rect[1]!, rect[2]!, rect[3]!] as const);
}

function sameAvcRendition(
  left: Readonly<RuntimeAvcRendition>,
  right: Readonly<RuntimeAvcRendition>
): boolean {
  if (
    left.id !== right.id ||
    left.profile !== right.profile ||
    left.codedWidth !== right.codedWidth ||
    left.codedHeight !== right.codedHeight ||
    left.bitrate.average !== right.bitrate.average ||
    left.bitrate.peak !== right.bitrate.peak ||
    !sameRect(left.alphaLayout.colorRect, right.alphaLayout.colorRect)
  ) return false;
  return left.profile === "avc-annexb-opaque-v0" ||
    (right.profile === "avc-annexb-packed-alpha-v0" &&
      sameRect(left.alphaLayout.alphaRect, right.alphaLayout.alphaRect));
}

function sameGeometry(
  left: Readonly<AvcRenditionGeometry>,
  right: Readonly<AvcRenditionGeometry>
): boolean {
  return left.profile === right.profile &&
    left.codedWidth === right.codedWidth &&
    left.codedHeight === right.codedHeight &&
    left.visibleColorArea === right.visibleColorArea &&
    sameRect(left.visibleColorRect, right.visibleColorRect) &&
    sameRect(left.decodedStorageRect, right.decodedStorageRect) &&
    (left.visibleAlphaRect === undefined
      ? right.visibleAlphaRect === undefined
      : right.visibleAlphaRect !== undefined &&
        sameRect(left.visibleAlphaRect, right.visibleAlphaRect));
}

function sameRect(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function normalizeSelectionError(error: unknown, rendition: string): Error {
  if (error instanceof RuntimePlaybackError) return error;
  if (error instanceof FormatError) {
    return selectionError(
      "invalid-asset",
      "AVC rendition geometry is invalid",
      {
        rendition,
        sourceCode: error.code,
        ...(error.path === undefined ? {} : { sourcePath: error.path })
      }
    );
  }
  return selectionError(
    "invalid-asset",
    "AVC rendition could not be inspected",
    { rendition }
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
    return normalizeRuntimeFailure(error.code, error.message, {
      ...error.failure.context,
      rendition,
      rank
    });
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
