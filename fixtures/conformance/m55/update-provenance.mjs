import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectAvcAnnexBRendition,
  parseFrontIndex,
  serializeCanonicalJson,
  validateCompleteAsset
} from "../../../packages/format/dist/index.js";

const outputRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(outputRoot, "../../..");
const sourceRoot = resolve(repositoryRoot, "fixtures/compiler/m55/source");
const assetPath = resolve(outputRoot, "opaque-all-routes.rma");
const reportPath = `${assetPath}.build.json`;
const projectPath = resolve(sourceRoot, "all-routes.json");
const generatorPath = resolve(sourceRoot, "generate.mjs");

const asset = new Uint8Array(await readFile(assetPath));
const projectBytes = await readFile(projectPath);
const generatorBytes = await readFile(generatorPath);
const project = JSON.parse(projectBytes.toString("utf8"));
const report = JSON.parse(await readFile(reportPath, "utf8"));
const { frontIndex } = validateCompleteAsset({ bytes: asset });
requireEqual(
  frontIndex,
  parseFrontIndex(asset),
  "front index changes across complete validation"
);
require(
  report.asset.sha256 === sha256(asset) &&
    report.asset.bytes === asset.byteLength,
  "build report does not identify the checked asset"
);
require(
  report.buildDetails.projectFile?.sha256 === sha256(projectBytes),
  "build report does not identify the checked project"
);

const sourceFrames = [];
for (const source of project.sources) {
  require(
    source.type === "png-sequence",
    "checked M5.5 fixture sources must be PNG sequences"
  );
  for (let index = 0; index < source.frameCount; index += 1) {
    const frameNumber = source.firstNumber + index;
    const relativePath =
      `${source.directory}/${source.prefix}` +
      `${String(frameNumber).padStart(source.digits, "0")}${source.suffix}`;
    const bytes = await readFile(resolve(sourceRoot, relativePath));
    sourceFrames.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
}

const units = frontIndex.unitBlobs.map((blob) => {
  require(
    sha256(asset.subarray(blob.offset, blob.offset + blob.length)) === blob.sha256,
    `unit blob ${blob.rendition}/${blob.unit} has a digest mismatch`
  );
  return { ...blob };
});
const staticFrames = frontIndex.staticBlobs.map((blob) => {
  require(
    sha256(asset.subarray(blob.offset, blob.offset + blob.length)) === blob.sha256,
    `static blob ${blob.staticFrame} has a digest mismatch`
  );
  return { ...blob };
});
const strictInspections = frontIndex.manifest.renditions.map(
  (rendition, renditionIndex) => {
    const inspection = inspectAvcAnnexBRendition({
      profile: {
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        frameRate: frontIndex.manifest.frameRate,
        averageBitrate: rendition.bitrate.average,
        peakBitrate: rendition.bitrate.peak,
        cpbBufferBits: rendition.bitrate.peak,
        requireBt709LimitedRange: true
      },
      units: frontIndex.manifest.units.map((unit, unitIndex) => ({
        id: unit.id,
        accessUnits: frontIndex.records
          .filter((record) =>
            record.renditionIndex === renditionIndex &&
            record.unitIndex === unitIndex
          )
          .map((record) => ({
            key: record.key,
            bytes: asset.slice(
              record.payloadOffset,
              record.payloadOffset + record.payloadLength
            )
          }))
      }))
    });
    return {
      rendition: rendition.id,
      parameterSet: inspection.parameterSet,
      macroblocksPerFrame: inspection.macroblocksPerFrame,
      units: inspection.units.map((unit) => ({
        id: unit.id,
        frames: unit.frames.length
      }))
    };
  }
);

const provenance = {
  provenanceVersion: "0.1",
  generatedAt: "2026-07-12",
  generator: "rendered-motion-compiler/0.1",
  compiler: report.compiler,
  toolchain: normalizedToolchain(report.toolchain),
  fixture: {
    name: "opaque-all-routes.rma",
    coverage: [
      "initial-one-shot",
      "looping-bodies",
      "finite-and-held-bodies",
      "resident-reversible-forward-and-reverse",
      "both-reversible-endpoint-runways",
      "portal-and-finish-starts",
      "transitionless-portal-and-finish",
      "one-frame-locked-bridge",
      "cut-runway-shared-with-reversible-endpoint",
      "locked-follow-on"
    ],
    generatorSource: {
      path: "fixtures/compiler/m55/source/generate.mjs",
      bytes: generatorBytes.byteLength,
      sha256: sha256(generatorBytes)
    },
    sourceProject: {
      path: "fixtures/compiler/m55/source/all-routes.json",
      bytes: projectBytes.byteLength,
      sha256: sha256(projectBytes)
    },
    sourceFrames,
    frontIndex: frontIndex.frontIndexRange,
    manifestSha256: sha256(serializeCanonicalJson(frontIndex.manifest)),
    units,
    staticFrames,
    stateStatics: frontIndex.manifest.states.map(({ id, staticFrame }) => ({
      state: id,
      staticFrame
    })),
    readiness: frontIndex.manifest.readiness,
    strictInspections,
    normalization: report.buildDetails.sources.map((source) => ({
      source: source.id,
      probe: {
        width: source.width,
        height: source.height,
        frameCount: source.frameCount,
        frameRate: source.frameRate,
        timeBase: source.timeBase,
        durationMicros: source.durationMicros,
        pixelFormat: source.pixelFormat,
        hasAlpha: source.hasAlpha,
        variableFrameRate: source.variableFrameRate,
        frames: source.frames
      },
      normalization: source.normalization,
      alphaAudit: source.alphaAudit
    })),
    invocations: report.buildDetails.invocations,
    renditions: report.buildDetails.renditions,
    continuity: report.buildDetails.continuity,
    asset: { bytes: asset.byteLength, sha256: sha256(asset) }
  }
};

assertNoAbsolutePaths(provenance);
await writeFile(
  resolve(outputRoot, "provenance.json"),
  `${JSON.stringify(provenance, null, 2)}\n`
);
await unlink(reportPath);

function normalizedToolchain(toolchain) {
  return {
    aggregateMemoryLimit: toolchain.aggregateMemoryLimit,
    ffmpeg: {
      executableSha256: toolchain.ffmpeg.executableSha256,
      version: toolchain.ffmpeg.version,
      versionOutputSha256: toolchain.ffmpeg.versionOutputSha256,
      configurationSha256: toolchain.ffmpeg.configurationSha256,
      encodersOutputSha256: toolchain.ffmpeg.encodersOutputSha256,
      calibrationSha256: toolchain.ffmpeg.calibrationSha256
    },
    ffprobe: {
      executableSha256: toolchain.ffprobe.executableSha256,
      version: toolchain.ffprobe.version,
      versionOutputSha256: toolchain.ffprobe.versionOutputSha256
    }
  };
}

function assertNoAbsolutePaths(value, path = "provenance") {
  if (typeof value === "string") {
    require(
      !value.startsWith("/") &&
        !value.startsWith("\\\\") &&
        !/^[a-z]:[\\/]/iu.test(value) &&
        !/(?:^|[\s"'=:(,])\/[a-z0-9._-]/iu.test(value) &&
        !/(?:^|[\s"'=:(,])[a-z]:[\\/]/iu.test(value),
      `${path} contains an absolute path`
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoAbsolutePaths(entry, `${path}[${String(index)}]`)
    );
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      assertNoAbsolutePaths(child, `${path}.${key}`);
    }
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEqual(actual, expected, message) {
  require(JSON.stringify(actual) === JSON.stringify(expected), message);
}
