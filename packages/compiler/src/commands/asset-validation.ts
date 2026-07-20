import {
  FORMAT_DEFAULT_BUDGETS,
  FormatError,
  inspectAv1Rendition,
  inspectH264AnnexBRendition,
  inspectH265AnnexBRendition,
  inspectVp9Rendition,
  validateCompleteAsset,
  type Av1RenditionInspection,
  type H264RenditionInspection,
  type EncodedChunkRecord,
  type H265RenditionInspection,
  type ParsedFrontIndex,
  type ProductionRendition,
  type Unit,
  type ValidatedAssetLayout,
  type VideoCodec,
  type Vp9RenditionInspection
} from "@pixel-point/aval-format";

import { readBoundedRegularFile } from "../bounded-file.js";
import { throwIfAborted } from "../cancellation.js";
import { createSha256Accumulator } from "../compile/hash.js";
import { CompilerError } from "../diagnostics.js";

export type VideoRenditionInspection =
  | Readonly<{
      codec: "h264";
      rendition: string;
      codecString: string;
      inspection: Readonly<H264RenditionInspection>;
    }>
  | Readonly<{
      codec: "h265";
      rendition: string;
      codecString: string;
      inspection: Readonly<H265RenditionInspection>;
    }>
  | Readonly<{
      codec: "vp9";
      rendition: string;
      codecString: string;
      inspection: Readonly<Vp9RenditionInspection>;
    }>
  | Readonly<{
      codec: "av1";
      rendition: string;
      codecString: string;
      inspection: Readonly<Av1RenditionInspection>;
    }>;

export interface ValidatedAsset {
  readonly bytes: Uint8Array;
  readonly layout: Readonly<ValidatedAssetLayout>;
  readonly video: readonly VideoRenditionInspection[];
}

export interface InspectedChunkRange {
  readonly rendition: string;
  readonly unit: string;
  readonly decodeIndex: number;
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly sha256: string;
}

interface RoutedUnitChunks {
  readonly unit: Unit;
  readonly records: readonly EncodedChunkRecord[];
  readonly bytes: readonly Uint8Array[];
}

/** Read once, validate the complete layout/digests, then inspect every rendition. */
export async function readValidatedAsset(
  file: string,
  signal?: AbortSignal
): Promise<ValidatedAsset> {
  const bytes = await readBoundedRegularFile({
    path: file,
    maxBytes: FORMAT_DEFAULT_BUDGETS.maxFileBytes,
    label: "compiled asset",
    limitCode: "ASSET_INVALID",
    ...(signal === undefined ? {} : { signal })
  });
  try {
    throwIfAborted(signal);
    const layout = validateCompleteAsset({ bytes });
    throwIfAborted(signal);
    verifyBlobDigests(bytes, layout, signal);
    const video = inspectVideoRenditions(bytes, layout.frontIndex, signal);
    throwIfAborted(signal);
    return Object.freeze({ bytes, layout, video });
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof CompilerError) throw error;
    if (error instanceof FormatError) {
      throw new CompilerError("ASSET_INVALID", error.message, {
        path: file,
        cause: error
      });
    }
    throw new CompilerError("ASSET_INVALID", "Compiled asset is invalid", {
      path: file,
      cause: error
    });
  }
}

/** Map fixed records back to their rendition/unit identity through canonical spans. */
export function describeChunks(
  bytes: Uint8Array,
  front: ParsedFrontIndex,
  signal?: AbortSignal
): readonly InspectedChunkRange[] {
  const ranges: InspectedChunkRange[] = [];
  const visited = new Set<number>();
  for (const rendition of front.manifest.renditions) {
    for (const unit of front.manifest.units) {
      throwIfAborted(signal);
      const span = unit.chunks.find(({ rendition: id }) => id === rendition.id);
      if (span === undefined) {
        throw new CompilerError("ASSET_INVALID", "Encoded-chunk span is missing");
      }
      for (let decodeIndex = 0; decodeIndex < span.chunkCount; decodeIndex += 1) {
        throwIfAborted(signal);
        const ordinal = span.chunkStart + decodeIndex;
        const record = front.records[ordinal];
        if (record === undefined || visited.has(ordinal)) {
          throw new CompilerError("ASSET_INVALID", "Encoded-chunk identity is invalid");
        }
        visited.add(ordinal);
        ranges.push(Object.freeze({
          rendition: rendition.id,
          unit: unit.id,
          decodeIndex,
          presentationTimestamp: record.presentationTimestamp,
          duration: record.duration,
          randomAccess: record.randomAccess,
          displayedFrameCount: record.displayedFrameCount,
          byteOffset: record.byteOffset,
          byteLength: record.byteLength,
          sha256: sha256AssetBytes(bytes.subarray(
            record.byteOffset,
            record.byteOffset + record.byteLength
          ), signal)
        }));
      }
    }
  }
  if (visited.size !== front.records.length) {
    throw new CompilerError("ASSET_INVALID", "Encoded-chunk routing is incomplete");
  }
  throwIfAborted(signal);
  return Object.freeze(ranges);
}

/** Incremental whole/range digest with cancellation checkpoints. */
export function sha256AssetBytes(
  bytes: Uint8Array,
  signal?: AbortSignal
): string {
  const digest = createSha256Accumulator();
  const chunkBytes = 1024 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    throwIfAborted(signal);
    digest.update(bytes.subarray(
      offset,
      Math.min(bytes.byteLength, offset + chunkBytes)
    ));
  }
  throwIfAborted(signal);
  return digest.digestHex();
}

function inspectVideoRenditions(
  bytes: Uint8Array,
  front: ParsedFrontIndex,
  signal?: AbortSignal
): readonly VideoRenditionInspection[] {
  const results: VideoRenditionInspection[] = [];
  for (const rendition of front.manifest.renditions) {
    throwIfAborted(signal);
    const units = routeRenditionChunks(bytes, front, rendition, signal);
    const result = inspectVideoRendition(
      front.manifest.codec,
      rendition,
      units,
      front,
      signal
    );
    results.push(result);
  }
  return Object.freeze(results);
}

function inspectVideoRendition(
  codec: VideoCodec,
  rendition: ProductionRendition,
  units: readonly RoutedUnitChunks[],
  front: ParsedFrontIndex,
  signal?: AbortSignal
): VideoRenditionInspection {
  switch (codec) {
    case "h264": {
      const inspection = inspectH264AnnexBRendition({
        profile: {
          codedWidth: rendition.codedWidth,
          codedHeight: rendition.codedHeight,
          expectedVisibleRect: decodedStorageRect(rendition),
          frameRate: front.manifest.frameRate,
          requireBt709LimitedRange: true
        },
        units: units.map(({ unit, records, bytes: chunks }) => ({
          id: unit.id,
          accessUnits: chunks.map((chunk, index) => ({
            bytes: chunk,
            key: records[index]!.randomAccess
          }))
        }))
      });
      assertCodecString(
        rendition,
        inspection.parameterSet.codec
      );
      assertH264Timeline(units, inspection);
      throwIfAborted(signal);
      return Object.freeze({
        codec,
        rendition: rendition.id,
        codecString: rendition.codec,
        inspection
      });
    }
    case "h265": {
      const inspection = inspectH265AnnexBRendition({
        profile: {
          codedWidth: rendition.codedWidth,
          codedHeight: rendition.codedHeight,
          expectedVisibleRect: decodedStorageRect(rendition),
          frameRate: front.manifest.frameRate,
          requireBt709LimitedRange: true
        },
        units: units.map(({ unit, records, bytes: chunks }) => ({
          id: unit.id,
          accessUnits: chunks.map((chunk, index) => ({
            bytes: chunk,
            key: records[index]!.randomAccess
          }))
        }))
      });
      assertCodecString(rendition, inspection.parameterSet.codec);
      assertH265Timeline(units, inspection);
      throwIfAborted(signal);
      return Object.freeze({
        codec,
        rendition: rendition.id,
        codecString: rendition.codec,
        inspection
      });
    }
    case "vp9": {
      const inspection = inspectVp9Rendition({
        width: rendition.codedWidth,
        height: rendition.codedHeight,
        frameRate: front.manifest.frameRate,
        averageBitrate: rendition.bitrate.average,
        units: units.map(({ unit, records, bytes: chunks }) => ({
          id: unit.id,
          expectedDisplayedFrames: unit.frameCount,
          packets: chunks.map((chunk, index) => ({
            bytes: chunk,
            key: records[index]!.randomAccess,
            timestamp: records[index]!.presentationTimestamp
          }))
        }))
      });
      assertCodecString(rendition, inspection.codec);
      assertVp9Timeline(units, inspection);
      throwIfAborted(signal);
      return Object.freeze({
        codec,
        rendition: rendition.id,
        codecString: rendition.codec,
        inspection
      });
    }
    case "av1": {
      const inspection = inspectAv1Rendition({
        width: rendition.codedWidth,
        height: rendition.codedHeight,
        bitDepth: rendition.bitDepth,
        units: units.map(({ unit, records, bytes: chunks }) => ({
          id: unit.id,
          expectedDisplayedFrames: unit.frameCount,
          chunks: chunks.map((chunk, index) => ({
            bytes: chunk,
            key: records[index]!.randomAccess,
            timestamp: records[index]!.presentationTimestamp
          }))
        }))
      });
      assertCodecString(rendition, inspection.codec);
      assertAv1Timeline(units, inspection);
      throwIfAborted(signal);
      return Object.freeze({
        codec,
        rendition: rendition.id,
        codecString: rendition.codec,
        inspection
      });
    }
  }
}

function routeRenditionChunks(
  bytes: Uint8Array,
  front: ParsedFrontIndex,
  rendition: ProductionRendition,
  signal?: AbortSignal
): readonly RoutedUnitChunks[] {
  return Object.freeze(front.manifest.units.map((unit) => {
    throwIfAborted(signal);
    const span = unit.chunks.find(({ rendition: id }) => id === rendition.id);
    if (span === undefined || span.frameCount !== unit.frameCount) {
      throw new CompilerError("ASSET_INVALID", "Rendition chunk span is invalid");
    }
    const records = front.records.slice(
      span.chunkStart,
      span.chunkStart + span.chunkCount
    );
    if (records.length !== span.chunkCount) {
      throw new CompilerError("ASSET_INVALID", "Rendition chunk records are missing");
    }
    return Object.freeze({
      unit,
      records: Object.freeze(records),
      bytes: Object.freeze(records.map((record) => bytes.subarray(
        record.byteOffset,
        record.byteOffset + record.byteLength
      )))
    });
  }));
}

function decodedStorageRect(
  rendition: ProductionRendition
): readonly [0, 0, number, number] {
  const color = rendition.alphaLayout.colorRect;
  const width = color[2] + color[2] % 2;
  const height = rendition.alphaLayout.type === "opaque"
    ? color[3] + color[3] % 2
    : rendition.alphaLayout.alphaRect[1] +
      rendition.alphaLayout.alphaRect[3] +
      rendition.alphaLayout.alphaRect[3] % 2;
  if (width > rendition.codedWidth || height > rendition.codedHeight) {
    throw new CompilerError("ASSET_INVALID", "Decoded storage rectangle is invalid");
  }
  return Object.freeze([0, 0, width, height]);
}

function assertCodecString(
  rendition: ProductionRendition,
  inspectedCodec: string
): void {
  if (rendition.codec === inspectedCodec) return;
  const permitsExtendedForm =
    (rendition.codec.startsWith("vp09.") || rendition.codec.startsWith("av01.")) &&
    inspectedCodec.startsWith(`${rendition.codec}.`);
  if (permitsExtendedForm) return;
  throw new CompilerError(
    "ASSET_INVALID",
    `Rendition ${rendition.id} codec string disagrees with its bitstream`
  );
}

function assertH264Timeline(
  routed: readonly RoutedUnitChunks[],
  inspection: Readonly<H264RenditionInspection>
): void {
  for (let unitIndex = 0; unitIndex < routed.length; unitIndex += 1) {
    const source = routed[unitIndex]!;
    const inspected = inspection.units[unitIndex];
    assertUnitIdentity(source, inspected?.id, inspected?.accessUnits.length);
    for (let index = 0; index < source.records.length; index += 1) {
      const record = source.records[index]!;
      const accessUnit = inspected!.accessUnits[index]!;
      assertChunkAgreement(record, accessUnit.key, 1, source.unit.id, index);
    }
    const byTimestamp = source.records
      .map((record, decodeIndex) => ({ decodeIndex, timestamp: record.presentationTimestamp }))
      .sort((left, right) => left.timestamp - right.timestamp || left.decodeIndex - right.decodeIndex)
      .map(({ decodeIndex }) => decodeIndex);
    const byInspection = [...inspected!.accessUnits]
      .sort((left, right) => left.presentationIndex - right.presentationIndex)
      .map(({ decodeIndex }) => decodeIndex);
    if (!sameNumbers(byTimestamp, byInspection)) {
      throw new CompilerError(
        "ASSET_INVALID",
        `Unit ${source.unit.id} presentation timeline disagrees with its H.264 bitstream`
      );
    }
  }
}

function assertH265Timeline(
  routed: readonly RoutedUnitChunks[],
  inspection: Readonly<H265RenditionInspection>
): void {
  for (let unitIndex = 0; unitIndex < routed.length; unitIndex += 1) {
    const source = routed[unitIndex]!;
    const inspected = inspection.units[unitIndex];
    assertUnitIdentity(source, inspected?.id, inspected?.accessUnits.length);
    for (let index = 0; index < source.records.length; index += 1) {
      const record = source.records[index]!;
      const accessUnit = inspected!.accessUnits[index]!;
      assertChunkAgreement(record, accessUnit.key, 1, source.unit.id, index);
    }
    const byTimestamp = source.records
      .map((record, decodeIndex) => ({ decodeIndex, timestamp: record.presentationTimestamp }))
      .sort((left, right) => left.timestamp - right.timestamp || left.decodeIndex - right.decodeIndex)
      .map(({ decodeIndex }) => decodeIndex);
    const byInspection = [...inspected!.accessUnits]
      .sort((left, right) => left.presentationIndex - right.presentationIndex)
      .map(({ decodeIndex }) => decodeIndex);
    if (!sameNumbers(byTimestamp, byInspection)) {
      throw new CompilerError(
        "ASSET_INVALID",
        `Unit ${source.unit.id} presentation timeline disagrees with its HEVC bitstream`
      );
    }
  }
}

function assertVp9Timeline(
  routed: readonly RoutedUnitChunks[],
  inspection: Readonly<Vp9RenditionInspection>
): void {
  for (let unitIndex = 0; unitIndex < routed.length; unitIndex += 1) {
    const source = routed[unitIndex]!;
    const inspected = inspection.units[unitIndex];
    assertUnitIdentity(source, inspected?.id, inspected?.packets.length);
    for (let index = 0; index < source.records.length; index += 1) {
      const packet = inspected!.packets[index]!;
      assertChunkAgreement(
        source.records[index]!,
        packet.chunkType === "key",
        packet.displayedFrameCount,
        source.unit.id,
        index
      );
    }
  }
}

function assertAv1Timeline(
  routed: readonly RoutedUnitChunks[],
  inspection: Readonly<Av1RenditionInspection>
): void {
  for (let unitIndex = 0; unitIndex < routed.length; unitIndex += 1) {
    const source = routed[unitIndex]!;
    const inspected = inspection.units[unitIndex];
    assertUnitIdentity(source, inspected?.id, inspected?.chunks.length);
    for (let index = 0; index < source.records.length; index += 1) {
      const chunk = inspected!.chunks[index]!;
      assertChunkAgreement(
        source.records[index]!,
        chunk.chunkType === "key",
        chunk.displayedFrameCount,
        source.unit.id,
        index
      );
    }
  }
}

function assertUnitIdentity(
  source: RoutedUnitChunks,
  inspectedId: string | undefined,
  inspectedChunkCount: number | undefined
): void {
  if (
    inspectedId !== source.unit.id ||
    inspectedChunkCount !== source.records.length
  ) {
    throw new CompilerError(
      "ASSET_INVALID",
      `Unit ${source.unit.id} inspection does not match its encoded chunks`
    );
  }
}

function assertChunkAgreement(
  record: EncodedChunkRecord,
  randomAccess: boolean,
  displayedFrameCount: number,
  unit: string,
  decodeIndex: number
): void {
  if (
    record.randomAccess !== randomAccess ||
    record.displayedFrameCount !== displayedFrameCount
  ) {
    throw new CompilerError(
      "ASSET_INVALID",
      `Unit ${unit} chunk ${String(decodeIndex)} metadata disagrees with its bitstream`
    );
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function verifyBlobDigests(
  bytes: Uint8Array,
  layout: ValidatedAssetLayout,
  signal?: AbortSignal
): void {
  for (const blob of layout.frontIndex.unitBlobs) {
    throwIfAborted(signal);
    const actual = sha256AssetBytes(
      bytes.subarray(blob.offset, blob.offset + blob.length),
      signal
    );
    if (actual !== blob.sha256) {
      throw new CompilerError(
        "ASSET_INVALID",
        `Digest mismatch for ${blob.unit}`
      );
    }
  }
}
