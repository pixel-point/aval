import type {
  AlphaLayout,
  FormatVersion,
  ValidatedAssetLayout,
  VideoBitstream,
  VideoCodec,
  VideoLayout
} from "@pixel-point/aval-format";

import { throwIfAborted } from "../cancellation.js";
import {
  describeChunks,
  readValidatedAsset,
  sha256AssetBytes,
  type InspectedChunkRange,
  type VideoRenditionInspection
} from "./asset-validation.js";

export interface AssetInspection {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly formatVersion: FormatVersion;
  readonly generator: string;
  readonly codec: VideoCodec;
  readonly bitstream: VideoBitstream;
  readonly layout: VideoLayout;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly frameRate: string;
  readonly initialState: string;
  readonly states: readonly string[];
  readonly renditions: readonly {
    readonly id: string;
    readonly codec: string;
    readonly bitDepth: 8 | 10;
    readonly coded: string;
    readonly alphaLayout: AlphaLayout;
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
  readonly chunks: number;
  readonly chunkRanges: readonly InspectedChunkRange[];
  readonly digestClaim: "all-internal-and-whole-file";
  readonly videoClaim: "syntax-dependency-and-timeline-inspected";
  readonly video: readonly VideoRenditionInspection[];
}

export interface AssetValidationReport {
  readonly command: "validate";
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly codec: VideoCodec;
  readonly bitstream: VideoBitstream;
  readonly layout: VideoLayout;
  readonly chunks: number;
  readonly unitBlobs: number;
  readonly digestClaim: "all-internal-and-whole-file";
  readonly videoClaim: "syntax-dependency-and-timeline-inspected";
  readonly video: readonly VideoRenditionInspection[];
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
    codec: front.manifest.codec,
    bitstream: front.manifest.bitstream,
    layout: front.manifest.layout,
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
        codec: rendition.codec,
        bitDepth: rendition.bitDepth,
        coded: `${String(rendition.codedWidth)}x${String(rendition.codedHeight)}`,
        alphaLayout: rendition.alphaLayout
      })
    )),
    units: Object.freeze(units),
    chunks: front.records.length,
    chunkRanges: describeChunks(bytes, front, signal),
    digestClaim: "all-internal-and-whole-file",
    videoClaim: "syntax-dependency-and-timeline-inspected",
    video: validated.video
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
  const { bytes, layout, video } = await readValidatedAsset(file, signal);
  const { manifest, records, unitBlobs } = layout.frontIndex;
  throwIfAborted(signal);
  return Object.freeze({
    command: "validate",
    file,
    bytes: bytes.byteLength,
    sha256: sha256AssetBytes(bytes, signal),
    codec: manifest.codec,
    bitstream: manifest.bitstream,
    layout: manifest.layout,
    chunks: records.length,
    unitBlobs: unitBlobs.length,
    digestClaim: "all-internal-and-whole-file",
    videoClaim: "syntax-dependency-and-timeline-inspected",
    video
  });
}

export { unpackAssetFile } from "./unpack-asset.js";
export type { UnpackReport } from "./unpack-asset.js";
export type {
  InspectedChunkRange,
  VideoRenditionInspection
} from "./asset-validation.js";

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
