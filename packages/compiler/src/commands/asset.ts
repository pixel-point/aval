import type {
  AvcParameterSetSummary,
  AvcUnitInspection,
  ValidatedAssetLayout
} from "@rendered-motion/format";

import { throwIfAborted } from "../cancellation.js";
import {
  describeAccessUnits,
  readValidatedAsset,
  sha256AssetBytes,
  staticPngClaim,
  type InspectedAccessUnitRange
} from "./asset-validation.js";

export interface AssetInspection {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly formatVersion: string;
  readonly generator: string;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly frameRate: string;
  readonly initialState: string;
  readonly states: readonly string[];
  readonly renditions: readonly {
    readonly id: string;
    readonly profile: string;
    readonly codec: string;
    readonly coded: string;
  }[];
  readonly units: readonly {
    readonly id: string;
    readonly kind: string;
    readonly frames: number;
    readonly startFrame: number;
    readonly endFrame: number;
    readonly startTime: string;
    readonly endTime: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
  }[];
  readonly accessUnits: number;
  readonly samples: readonly InspectedAccessUnitRange[];
  readonly staticFrames: readonly string[];
  readonly digestClaim: "all-internal-and-whole-file";
  readonly avcClaim: "syntax-and-dependency-inspected" | "not-applicable";
  readonly staticPngClaim: "generated-profile-envelope" | "m4-envelope-only";
  readonly avc: readonly OpaqueRenditionSummary[];
}

export interface OpaqueRenditionSummary {
  readonly rendition: string;
  readonly macroblocksPerFrame: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly constraintSet2: boolean;
  readonly parameterSet: AvcParameterSetSummary;
  readonly units: readonly AvcUnitInspection[];
}

export interface AssetValidationReport {
  readonly command: "validate";
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly accessUnits: number;
  readonly unitBlobs: number;
  readonly staticBlobs: number;
  readonly digestClaim: "all-internal-and-whole-file";
  readonly avcClaim: "syntax-and-dependency-inspected" | "not-applicable";
  readonly staticPngClaim: "generated-profile-envelope" | "m4-envelope-only";
}

export async function inspectAssetFile(
  file: string,
  signal?: AbortSignal
): Promise<AssetInspection> {
  const validated = await readValidatedAsset(file, signal);
  const { bytes, layout } = validated;
  const front = layout.frontIndex;
  const frameRate = front.manifest.frameRate;
  let cursor = 0;
  const units = front.manifest.units.map((unit) => {
    throwIfAborted(signal);
    const start = cursor;
    cursor += unit.frameCount;
    return Object.freeze({
      id: unit.id,
      kind: unit.kind,
      frames: unit.frameCount,
      startFrame: start,
      endFrame: cursor,
      startTime: rationalTime(start, frameRate.numerator, frameRate.denominator),
      endTime: rationalTime(cursor, frameRate.numerator, frameRate.denominator),
      startSeconds: start * frameRate.denominator / frameRate.numerator,
      endSeconds: cursor * frameRate.denominator / frameRate.numerator
    });
  });
  throwIfAborted(signal);
  return Object.freeze({
    file,
    bytes: bytes.byteLength,
    sha256: sha256AssetBytes(bytes, signal),
    formatVersion: front.manifest.formatVersion,
    generator: front.manifest.generator,
    canvas: Object.freeze({
      width: front.manifest.canvas.width,
      height: front.manifest.canvas.height
    }),
    frameRate: `${String(frameRate.numerator)}/${String(frameRate.denominator)}`,
    initialState: front.manifest.initialState,
    states: Object.freeze(front.manifest.states.map(({ id }) => id)),
    renditions: Object.freeze(front.manifest.renditions.map((rendition) =>
      Object.freeze({
        id: rendition.id,
        profile: rendition.profile,
        codec: rendition.codec,
        coded: `${String(rendition.codedWidth)}x${String(rendition.codedHeight)}`
      })
    )),
    units: Object.freeze(units),
    accessUnits: front.records.length,
    samples: describeAccessUnits(bytes, front, signal),
    staticFrames: Object.freeze(
      front.manifest.staticFrames.map(({ id }) => id)
    ),
    digestClaim: "all-internal-and-whole-file",
    avcClaim: validated.avc.length === 0
      ? "not-applicable"
      : "syntax-and-dependency-inspected",
    staticPngClaim: staticPngClaim(bytes, front, signal),
    avc: Object.freeze(validated.avc.map(({ rendition, inspection }) =>
      Object.freeze({
        rendition,
        macroblocksPerFrame: inspection.macroblocksPerFrame,
        codedWidth: inspection.parameterSet.codedWidth,
        codedHeight: inspection.parameterSet.codedHeight,
        constraintSet2: inspection.parameterSet.constraintSet2,
        parameterSet: inspection.parameterSet,
        units: inspection.units
      })
    ))
  });
}

export async function validateAssetFile(
  file: string,
  signal?: AbortSignal
): Promise<Readonly<ValidatedAssetLayout>> {
  return (await readValidatedAsset(file, signal)).layout;
}

export async function validateAssetReport(
  file: string,
  signal?: AbortSignal
): Promise<Readonly<AssetValidationReport>> {
  const { bytes, layout, avc } = await readValidatedAsset(file, signal);
  throwIfAborted(signal);
  return Object.freeze({
    command: "validate",
    file,
    bytes: bytes.byteLength,
    sha256: sha256AssetBytes(bytes, signal),
    accessUnits: layout.frontIndex.records.length,
    unitBlobs: layout.frontIndex.unitBlobs.length,
    staticBlobs: layout.frontIndex.staticBlobs.length,
    digestClaim: "all-internal-and-whole-file",
    avcClaim: avc.length === 0
      ? "not-applicable"
      : "syntax-and-dependency-inspected",
    staticPngClaim: staticPngClaim(bytes, layout.frontIndex, signal)
  });
}

export { unpackAssetFile } from "./unpack-asset.js";
export type { UnpackReport } from "./unpack-asset.js";
export type { InspectedAccessUnitRange } from "./asset-validation.js";

function rationalTime(
  frame: number,
  numerator: number,
  denominator: number
): string {
  const top = frame * denominator;
  const divisor = gcd(top, numerator);
  return `${String(top / divisor)}/${String(numerator / divisor)}`;
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a === 0 ? 1 : a;
}
