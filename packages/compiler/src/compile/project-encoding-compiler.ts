import {
  FormatError,
  isVideoCodecString,
  VIDEO_BITSTREAM_BY_CODEC,
  writeCanonicalAsset,
  type Bitrate,
  type CanonicalAssetInput,
  type EncodedChunkInput,
  type OpaqueCompiledManifestInputV1_1,
  type OpaqueProductionRenditionV1_1,
  type PackedAlphaCompiledManifestInputV1_1,
  type PackedAlphaProductionRenditionV1_1,
  type PackedAlphaWitnessV1,
  type UnitInput,
  type VideoBitDepth,
  type VideoLayout,
  type VideoRenditionGeometry
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";
import type {
  NormalizedSourceProject,
  NormalizedVideoEncoding,
  SourceUnit
} from "../model.js";
import { sha256Concat, sha256Hex } from "./hash.js";
import { ffmpegGenerator } from "./output.js";
import { validateCompiledOutput } from "./output-validation.js";
import { deriveReadiness } from "./readiness-plan.js";
import { estimateRuntimeLimits } from "./resource-estimate.js";

export interface PreparedEncodingChunk {
  readonly bytes: Uint8Array;
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
}

export interface PreparedEncodingUnit {
  readonly id: string;
  readonly chunks: readonly Readonly<PreparedEncodingChunk>[];
}

export interface PreparedEncodingRendition {
  readonly id: string;
  readonly codec: string;
  readonly bitDepth: VideoBitDepth;
  readonly geometry: Readonly<VideoRenditionGeometry>;
  readonly bitrate: Readonly<Bitrate>;
  readonly units: readonly Readonly<PreparedEncodingUnit>[];
  readonly outputQualification?: Readonly<PackedAlphaWitnessV1>;
}

export interface CompileProjectEncodingInput {
  readonly project: Readonly<NormalizedSourceProject>;
  readonly encoding: Readonly<NormalizedVideoEncoding>;
  readonly layout: VideoLayout;
  readonly renditions: readonly Readonly<PreparedEncodingRendition>[];
}

/** A validated, byte-complete one-codec artifact before bundle publication. */
export interface CompiledProjectEncoding {
  readonly codec: NormalizedVideoEncoding["codec"];
  readonly manifest: CompiledProjectManifest;
  readonly assetBytes: Uint8Array;
  readonly bytes: number;
  readonly sha256: string;
}

export type CompiledProjectManifest =
  | OpaqueCompiledManifestInputV1_1
  | PackedAlphaCompiledManifestInputV1_1;

/**
 * Assemble exactly one codec-major project encoding into one qualified 1.1 asset.
 * Codec adapters must finish syntax inspection before crossing this boundary.
 */
export function compileProjectEncoding(
  input: Readonly<CompileProjectEncodingInput>
): Readonly<CompiledProjectEncoding> {
  validateEncodingMembership(input.project, input.encoding);
  validateRenditionSet(input.encoding, input.renditions, input.layout);

  const chunks: EncodedChunkInput[] = [];
  const digestsByUnit = new Map<string, { rendition: string; sha256: string }[]>();
  for (let renditionIndex = 0; renditionIndex < input.renditions.length; renditionIndex += 1) {
    const rendition = input.renditions[renditionIndex]!;
    for (let unitIndex = 0; unitIndex < input.project.units.length; unitIndex += 1) {
      const sourceUnit = input.project.units[unitIndex]!;
      const preparedUnit = rendition.units[unitIndex]!;
      validatePreparedUnit(sourceUnit, preparedUnit, rendition.id);
      const unitDigests = digestsByUnit.get(sourceUnit.id) ?? [];
      unitDigests.push(Object.freeze({
        rendition: rendition.id,
        sha256: sha256Concat(preparedUnit.chunks.map(({ bytes }) => bytes))
      }));
      digestsByUnit.set(sourceUnit.id, unitDigests);
      for (let decodeIndex = 0; decodeIndex < preparedUnit.chunks.length; decodeIndex += 1) {
        const chunk = preparedUnit.chunks[decodeIndex]!;
        chunks.push(Object.freeze({
          rendition: rendition.id,
          unit: sourceUnit.id,
          decodeIndex,
          presentationTimestamp: chunk.presentationTimestamp,
          duration: chunk.duration,
          randomAccess: chunk.randomAccess,
          displayedFrameCount: chunk.displayedFrameCount,
          bytes: chunk.bytes
        }));
      }
    }
  }

  const units = input.project.units.map((unit) =>
    lowerUnit(unit, Object.freeze(digestsByUnit.get(unit.id) ?? []))
  );
  const manifestBase = Object.freeze({
    generator: ffmpegGenerator(),
    codec: input.encoding.codec,
    bitstream: VIDEO_BITSTREAM_BY_CODEC[input.encoding.codec],
    canvas: input.project.canvas,
    frameRate: input.project.frameRate,
    units: Object.freeze(units),
    initialState: input.project.initialState,
    states: input.project.states,
    edges: input.project.edges,
    bindings: input.project.bindings,
    readiness: deriveReadiness(input.project),
    limits: estimateRuntimeLimits(
      input.project,
      input.encoding.codec,
      chunks,
      input.renditions.map(({ geometry }) => geometry)
    )
  });
  const manifest: CompiledProjectManifest = input.layout === "opaque"
    ? Object.freeze({
        ...manifestBase,
        formatVersion: "1.1" as const,
        layout: "opaque" as const,
        renditions: Object.freeze(input.renditions.map(lowerOpaqueRendition))
      })
    : Object.freeze({
        ...manifestBase,
        formatVersion: "1.1" as const,
        layout: "packed-alpha" as const,
        renditions: Object.freeze(input.renditions.map(lowerPackedRendition))
      });
  const assetInput: CanonicalAssetInput = Object.freeze({
    manifest,
    chunks: Object.freeze(chunks)
  });

  try {
    const assetBytes = writeCanonicalAsset(assetInput);
    validateCompiledOutput(assetBytes);
    const ownedBytes = assetBytes.slice();
    return Object.freeze({
      codec: input.encoding.codec,
      manifest,
      assetBytes: ownedBytes,
      bytes: ownedBytes.byteLength,
      sha256: sha256Hex(ownedBytes)
    });
  } catch (error) {
    if (error instanceof FormatError) {
      throw new CompilerError("ASSET_INVALID", error.message, { cause: error });
    }
    throw error;
  }
}

function validateEncodingMembership(
  project: Readonly<NormalizedSourceProject>,
  encoding: Readonly<NormalizedVideoEncoding>
): void {
  const matches = project.encodings.filter(({ codec }) => codec === encoding.codec);
  if (matches.length !== 1 || matches[0] !== encoding) {
    invalid(`The ${encoding.codec} encoding is not the project's canonical encoding object`);
  }
}

function validateRenditionSet(
  encoding: Readonly<NormalizedVideoEncoding>,
  renditions: readonly Readonly<PreparedEncodingRendition>[],
  layout: VideoLayout
): void {
  if (layout !== "opaque" && layout !== "packed-alpha") {
    invalid("Encoding layout must be opaque or packed-alpha");
  }
  if (!Array.isArray(renditions) || renditions.length !== encoding.renditions.length) {
    invalid(`Prepared ${encoding.codec} rendition set is incomplete`);
  }
  for (let index = 0; index < encoding.renditions.length; index += 1) {
    const expected = encoding.renditions[index]!;
    const actual = renditions[index];
    if (actual === undefined || actual.id !== expected.id) {
      invalid(`Prepared ${encoding.codec} rendition order differs from the project`);
    }
    if (!isVideoCodecString(actual.codec, encoding.codec, actual.bitDepth)) {
      invalid(`Prepared rendition ${actual.id} has an invalid ${encoding.codec} codec string`);
    }
    const expectedBitDepth = encoding.codec === "av1" ? encoding.bitDepth : 8;
    if (actual.bitDepth !== expectedBitDepth) {
      invalid(`Prepared rendition ${actual.id} has the wrong bit depth`);
    }
    if (
      actual.geometry.layout !== layout ||
      actual.geometry.visibleColorRect[2] !== expected.width ||
      actual.geometry.visibleColorRect[3] !== expected.height
    ) {
      invalid(`Prepared rendition ${actual.id} geometry differs from the project`);
    }
    if (!Array.isArray(actual.units)) {
      invalid(`Prepared rendition ${actual.id} has no unit set`);
    }
    if (layout === "opaque" && actual.outputQualification !== undefined) {
      invalid(`Prepared opaque rendition ${actual.id} cannot carry output qualification`);
    }
    if (layout === "packed-alpha" && actual.outputQualification === undefined) {
      invalid(`Prepared packed-alpha rendition ${actual.id} is missing output qualification`);
    }
  }
}

function validatePreparedUnit(
  source: Readonly<SourceUnit>,
  prepared: Readonly<PreparedEncodingUnit>,
  rendition: string
): void {
  if (prepared === undefined || prepared.id !== source.id) {
    invalid(`Prepared rendition ${rendition} unit order differs from the project`);
  }
  if (!Array.isArray(prepared.chunks) || prepared.chunks.length < 1) {
    invalid(`Prepared rendition ${rendition} unit ${source.id} has no chunks`);
  }
  let displayedFrames = 0;
  for (let index = 0; index < prepared.chunks.length; index += 1) {
    const chunk = prepared.chunks[index];
    if (chunk === undefined || !(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength < 1) {
      invalid(`Prepared rendition ${rendition} unit ${source.id} has invalid chunk bytes`);
    }
    if (index === 0 && !chunk.randomAccess) {
      invalid(`Prepared rendition ${rendition} unit ${source.id} must begin at random access`);
    }
    if (
      !Number.isSafeInteger(chunk.displayedFrameCount) ||
      chunk.displayedFrameCount < 0 ||
      !Number.isSafeInteger(chunk.presentationTimestamp) ||
      chunk.presentationTimestamp < 0 ||
      !Number.isSafeInteger(chunk.duration) ||
      chunk.duration < 0 ||
      (chunk.displayedFrameCount > 0 && chunk.duration === 0)
    ) {
      invalid(`Prepared rendition ${rendition} unit ${source.id} has invalid timeline metadata`);
    }
    displayedFrames = checkedAdd(
      displayedFrames,
      chunk.displayedFrameCount,
      `Prepared rendition ${rendition} unit ${source.id} frame count`
    );
  }
  const expectedFrames = source.range[1] - source.range[0];
  if (displayedFrames !== expectedFrames) {
    invalid(
      `Prepared rendition ${rendition} unit ${source.id} displays ${String(displayedFrames)} frames; expected ${String(expectedFrames)}`
    );
  }
}

function lowerOpaqueRendition(
  rendition: Readonly<PreparedEncodingRendition>
): OpaqueProductionRenditionV1_1 {
  return Object.freeze({
    id: rendition.id,
    codec: rendition.codec,
    bitDepth: rendition.bitDepth,
    codedWidth: rendition.geometry.codedWidth,
    codedHeight: rendition.geometry.codedHeight,
    alphaLayout: Object.freeze({
      type: "opaque" as const,
      colorRect: rendition.geometry.visibleColorRect
    }),
    bitrate: rendition.bitrate
  });
}

function lowerPackedRendition(
  rendition: Readonly<PreparedEncodingRendition>
): PackedAlphaProductionRenditionV1_1 {
  const outputQualification = rendition.outputQualification;
  if (outputQualification === undefined) {
    invalid(`Prepared rendition ${rendition.id} is missing output qualification`);
  }
  return Object.freeze({
    id: rendition.id,
    codec: rendition.codec,
    bitDepth: rendition.bitDepth,
    codedWidth: rendition.geometry.codedWidth,
    codedHeight: rendition.geometry.codedHeight,
    alphaLayout: Object.freeze({
      type: "stacked" as const,
      colorRect: rendition.geometry.visibleColorRect,
      alphaRect: requireAlphaRect(rendition)
    }),
    bitrate: rendition.bitrate,
    outputQualification
  });
}

function requireAlphaRect(
  rendition: Readonly<PreparedEncodingRendition>
): NonNullable<VideoRenditionGeometry["visibleAlphaRect"]> {
  const rect = rendition.geometry.visibleAlphaRect;
  if (rect === undefined) {
    invalid(`Prepared rendition ${rendition.id} is missing its packed alpha pane`);
  }
  return rect;
}

function lowerUnit(
  unit: Readonly<SourceUnit>,
  chunks: UnitInput["chunks"]
): UnitInput {
  const frameCount = unit.range[1] - unit.range[0];
  if (unit.kind === "body") {
    return Object.freeze({
      id: unit.id,
      kind: unit.kind,
      playback: unit.playback,
      frameCount,
      ports: unit.ports,
      chunks
    });
  }
  if (unit.kind === "reversible") {
    return Object.freeze({
      id: unit.id,
      kind: unit.kind,
      frameCount,
      residency: unit.residency,
      chunks
    });
  }
  return Object.freeze({ id: unit.id, kind: unit.kind, frameCount, chunks });
}

function checkedAdd(left: number, right: number, label: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new CompilerError("OUTPUT_LIMIT", `${label} exceeds safe arithmetic`);
  }
  return left + right;
}

function invalid(message: string): never {
  throw new CompilerError("INPUT_INVALID", message);
}
