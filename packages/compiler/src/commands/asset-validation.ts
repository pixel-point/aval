import {
  FORMAT_DEFAULT_BUDGETS,
  FormatError,
  inspectAvcAnnexBRendition,
  validateCompleteAsset,
  type AvcRenditionInspection,
  type ParsedFrontIndex,
  type ValidatedAssetLayout
} from "@rendered-motion/format";

import { readBoundedRegularFile } from "../bounded-file.js";
import { throwIfAborted } from "../cancellation.js";
import { crc32 } from "../compile/crc32.js";
import { createSha256Accumulator } from "../compile/hash.js";
import { CompilerError } from "../diagnostics.js";

export interface ValidatedAsset {
  readonly bytes: Uint8Array;
  readonly layout: Readonly<ValidatedAssetLayout>;
  readonly avc: readonly {
    readonly rendition: string;
    readonly inspection: AvcRenditionInspection;
  }[];
}

export interface InspectedAccessUnitRange {
  readonly rendition: string;
  readonly unit: string;
  readonly frameIndex: number;
  readonly key: boolean;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

/** Read once, validate M4 layout, verify digests, then inspect every AVC unit. */
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
    const avc = inspectOpaqueRenditions(bytes, layout.frontIndex, signal);
    throwIfAborted(signal);
    return Object.freeze({ bytes, layout, avc });
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof CompilerError) throw error;
    if (error instanceof FormatError) {
      throw new CompilerError(
        error.code === "PROFILE_INVALID"
          ? "AVC_PROFILE_INVALID"
          : "ASSET_INVALID",
        error.message,
        {
          path: file,
          cause: error
        }
      );
    }
    throw new CompilerError("ASSET_INVALID", "Compiled asset is invalid", {
      path: file,
      cause: error
    });
  }
}

export function staticPngClaim(
  bytes: Uint8Array,
  front: ParsedFrontIndex,
  signal?: AbortSignal
): "generated-profile-envelope" | "m4-envelope-only" {
  throwIfAborted(signal);
  if (!front.manifest.generator.startsWith("rendered-motion-compiler/")) {
    return "m4-envelope-only";
  }
  for (let index = 0; index < front.staticBlobs.length; index += 1) {
    throwIfAborted(signal);
    const blob = front.staticBlobs[index];
    const frame = front.manifest.staticFrames[index];
    if (
      blob === undefined ||
      frame === undefined ||
      !isGeneratedPngEnvelope(
        bytes.subarray(blob.offset, blob.offset + blob.length),
        frame.width,
        frame.height,
        signal
      )
    ) {
      return "m4-envelope-only";
    }
  }
  return "generated-profile-envelope";
}

export function describeAccessUnits(
  bytes: Uint8Array,
  front: ParsedFrontIndex,
  signal?: AbortSignal
): readonly InspectedAccessUnitRange[] {
  const ranges: InspectedAccessUnitRange[] = [];
  for (const record of front.records) {
    throwIfAborted(signal);
    const rendition = front.manifest.renditions[record.renditionIndex];
    const unit = front.manifest.units[record.unitIndex];
    if (rendition === undefined || unit === undefined) {
      throw new CompilerError("ASSET_INVALID", "Access-unit identity is missing");
    }
    ranges.push(Object.freeze({
      rendition: rendition.id,
      unit: unit.id,
      frameIndex: record.frameIndex,
      key: record.key,
      offset: record.payloadOffset,
      length: record.payloadLength,
      sha256: sha256AssetBytes(bytes.subarray(
        record.payloadOffset,
        record.payloadOffset + record.payloadLength
      ), signal)
    }));
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

function inspectOpaqueRenditions(
  bytes: Uint8Array,
  front: ParsedFrontIndex,
  signal?: AbortSignal
): ValidatedAsset["avc"] {
  const results: Array<ValidatedAsset["avc"][number]> = [];
  for (
    let renditionIndex = 0;
    renditionIndex < front.manifest.renditions.length;
    renditionIndex += 1
  ) {
    throwIfAborted(signal);
    const rendition = front.manifest.renditions[renditionIndex];
    if (rendition?.profile !== "avc-annexb-opaque-v0") continue;
    const units = front.manifest.units.map((unit, unitIndex) => {
      const accessUnits: Array<{ readonly key: boolean; readonly bytes: Uint8Array }> = [];
      for (const record of front.records) {
        throwIfAborted(signal);
        if (
          record.renditionIndex === renditionIndex &&
          record.unitIndex === unitIndex
        ) {
          accessUnits.push({
            key: record.key,
            bytes: bytes.subarray(
              record.payloadOffset,
              record.payloadOffset + record.payloadLength
            )
          });
        }
      }
      return { id: unit.id, accessUnits };
    });
    throwIfAborted(signal);
    const inspection = inspectAvcAnnexBRendition({
      profile: {
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        frameRate: front.manifest.frameRate,
        averageBitrate: rendition.bitrate.average,
        peakBitrate: rendition.bitrate.peak,
        cpbBufferBits: rendition.bitrate.peak,
        requireBt709LimitedRange: true
      },
      units
    });
    throwIfAborted(signal);
    results.push(Object.freeze({ rendition: rendition.id, inspection }));
  }
  return Object.freeze(results);
}

function verifyBlobDigests(
  bytes: Uint8Array,
  layout: ValidatedAssetLayout,
  signal?: AbortSignal
): void {
  for (const blob of [
    ...layout.frontIndex.unitBlobs,
    ...layout.frontIndex.staticBlobs
  ]) {
    throwIfAborted(signal);
    const actual = sha256AssetBytes(
      bytes.subarray(blob.offset, blob.offset + blob.length),
      signal
    );
    if (actual !== blob.sha256) {
      throw new CompilerError(
        "ASSET_INVALID",
        `Digest mismatch for ${"unit" in blob ? blob.unit : blob.staticFrame}`
      );
    }
  }
}

const PNG_SIGNATURE = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
);

function isGeneratedPngEnvelope(
  bytes: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal
): boolean {
  throwIfAborted(signal);
  if (
    bytes.length < 58 ||
    !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    return false;
  }
  let cursor = 8;
  const chunks: Array<{ readonly type: string; readonly data: Uint8Array }> = [];
  while (cursor <= bytes.length - 12) {
    throwIfAborted(signal);
    const length = readUint32BE(bytes, cursor);
    const end = cursor + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) return false;
    const typeBytes = bytes.subarray(cursor + 4, cursor + 8);
    const data = bytes.subarray(cursor + 8, cursor + 8 + length);
    const expectedCrc = readUint32BE(bytes, cursor + 8 + length);
    if (crc32(bytes.subarray(cursor + 4, cursor + 8 + length)) !== expectedCrc) {
      return false;
    }
    chunks.push({ type: String.fromCharCode(...typeBytes), data });
    cursor = end;
  }
  if (cursor !== bytes.length || chunks.length !== 4) return false;
  const [ihdr, srgb, idat, iend] = chunks;
  return ihdr?.type === "IHDR" &&
    ihdr.data.length === 13 &&
    readUint32BE(ihdr.data, 0) === width &&
    readUint32BE(ihdr.data, 4) === height &&
    equalBytes(ihdr.data.subarray(8), Uint8Array.of(8, 6, 0, 0, 0)) &&
    srgb?.type === "sRGB" &&
    srgb.data.length === 1 &&
    srgb.data[0] === 0 &&
    idat?.type === "IDAT" &&
    idat.data.length > 0 &&
    iend?.type === "IEND" &&
    iend.data.length === 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x100_0000) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  ) >>> 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
