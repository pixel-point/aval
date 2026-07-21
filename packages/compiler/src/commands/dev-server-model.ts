import {
  FORMAT_DEFAULT_BUDGETS,
  parseVideoCodecString,
  SHA256_HEX_PATTERN,
  VIDEO_CODECS
} from "@pixel-point/aval-format";

import type {
  CompileBundleArtifact,
  VideoCodec
} from "../model.js";
import { sha256Hex } from "../compile/hash.js";

export interface DevServerAsset {
  readonly codec: VideoCodec;
  readonly path: `${VideoCodec}.avl`;
  readonly bytes: number;
  readonly sha256: string;
  readonly type: `application/vnd.aval; codecs="${string}"`;
  readonly integrity: `sha256-${string}`;
}

export interface DevServerBuildReport {
  readonly path: "build.json";
  readonly bytes: number;
  readonly sha256: string;
}

export interface DevServerBuild {
  readonly generation: number;
  readonly assets: readonly Readonly<DevServerAsset>[];
  readonly buildReport: Readonly<DevServerBuildReport>;
  readonly warnings: readonly string[];
}

export const MAX_ASSET_BYTES = FORMAT_DEFAULT_BUDGETS.maxFileBytes;
export const MAX_BUILD_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_WARNINGS = 64;
const SOURCE_TYPE = /^application\/vnd\.aval; codecs="([^"]+)"$/u;

/** Convert one unpublished compiler bundle into exact dev-server metadata. */
export function createDevServerBuild(
  generation: number,
  artifact: Readonly<CompileBundleArtifact>
): Readonly<DevServerBuild> {
  if (artifact.assets.length !== artifact.buildReport.assets.length) {
    throw new TypeError("dev bundle artifact and report asset counts differ");
  }
  for (let index = 0; index < artifact.assets.length; index += 1) {
    const encoded = artifact.assets[index]!;
    const reported = artifact.buildReport.assets[index]!;
    if (
      encoded.codec !== reported.codec ||
      encoded.filename !== reported.path ||
      encoded.bytes !== reported.bytes ||
      encoded.sha256 !== reported.sha256 ||
      encoded.assetBytes.byteLength !== encoded.bytes
    ) {
      throw new TypeError("dev bundle artifact does not match its build report");
    }
  }
  return normalizePublishedBuild({
    generation,
    assets: artifact.buildReport.assets.map((asset) => ({
      codec: asset.codec,
      path: asset.path as `${VideoCodec}.avl`,
      bytes: asset.bytes,
      sha256: asset.sha256,
      type: asset.type as `application/vnd.aval; codecs="${string}"`,
      integrity: asset.integrity as `sha256-${string}`
    })),
    buildReport: {
      path: "build.json",
      bytes: artifact.buildReportBytes.byteLength,
      sha256: sha256Hex(artifact.buildReportBytes)
    },
    warnings: artifact.warnings
  }, null);
}

export function normalizePublishedBuild(
  build: Readonly<DevServerBuild>,
  priorGeneration: number | null
): Readonly<DevServerBuild> {
  if (
    build === null || typeof build !== "object" ||
    !Number.isSafeInteger(build.generation) || build.generation < 1 ||
    (priorGeneration !== null && build.generation <= priorGeneration) ||
    !Array.isArray(build.assets) ||
    build.assets.length < 1 || build.assets.length > VIDEO_CODECS.length ||
    !Array.isArray(build.warnings) || build.warnings.length > MAX_WARNINGS ||
    !build.warnings.every(
      (warning) => typeof warning === "string" && warning.length <= 512
    )
  ) {
    throw new TypeError("dev build publication is malformed");
  }
  const codecs = new Set<VideoCodec>();
  const assets = build.assets.map((asset) => normalizeAsset(asset, codecs));
  const buildReport = normalizeBuildReport(build.buildReport);
  return Object.freeze({
    generation: build.generation,
    assets: Object.freeze(assets),
    buildReport,
    warnings: Object.freeze([...build.warnings])
  });
}

function normalizeAsset(
  asset: Readonly<DevServerAsset>,
  codecs: Set<VideoCodec>
): Readonly<DevServerAsset> {
  if (
    asset === null || typeof asset !== "object" ||
    !VIDEO_CODECS.includes(asset.codec) ||
    codecs.has(asset.codec) ||
    asset.path !== `${asset.codec}.avl` ||
    !validBytes(asset.bytes, MAX_ASSET_BYTES) ||
    !validSha256(asset.sha256)
  ) {
    throw new TypeError("dev build asset is malformed");
  }
  const sourceType = SOURCE_TYPE.exec(asset.type);
  const codecString = sourceType?.[1];
  if (
    codecString === undefined ||
    parseVideoCodecString(codecString)?.family !== asset.codec ||
    asset.integrity !== integrityForHexDigest(asset.sha256)
  ) {
    throw new TypeError("dev build asset source metadata is malformed");
  }
  codecs.add(asset.codec);
  return Object.freeze({
    codec: asset.codec,
    path: asset.path,
    bytes: asset.bytes,
    sha256: asset.sha256,
    type: asset.type,
    integrity: asset.integrity
  });
}

function normalizeBuildReport(
  value: Readonly<DevServerBuildReport>
): Readonly<DevServerBuildReport> {
  if (
    value === null || typeof value !== "object" ||
    value.path !== "build.json" ||
    !validBytes(value.bytes, MAX_BUILD_REPORT_BYTES) ||
    !validSha256(value.sha256)
  ) {
    throw new TypeError("dev build report metadata is malformed");
  }
  return Object.freeze({
    path: "build.json",
    bytes: value.bytes,
    sha256: value.sha256
  });
}

function validBytes(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validSha256(value: string): boolean {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function integrityForHexDigest(value: string): `sha256-${string}` {
  return `sha256-${Buffer.from(value, "hex").toString("base64")}`;
}
