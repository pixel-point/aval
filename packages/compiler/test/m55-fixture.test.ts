import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import {
  adaptManifestToMotionGraph,
  inspectAvcAnnexBRendition,
  parseFrontIndex,
  serializeCanonicalJson,
  validateCompleteAsset
} from "@rendered-motion/format";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateAssetReport } from "../src/commands/asset.js";
import { compileProjectFile } from "../src/compile/project-compiler.js";
import { discoverFfmpeg } from "../src/ffmpeg/discovery.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const SOURCE_ROOT = join(REPOSITORY_ROOT, "fixtures/compiler/m55/source");
const PROJECT_PATH = join(SOURCE_ROOT, "all-routes.json");
const CONFORMANCE_ROOT = join(REPOSITORY_ROOT, "fixtures/conformance/m55");
const GOLDEN_PATH = join(CONFORMANCE_ROOT, "opaque-all-routes.rma");
const PROVENANCE_PATH = join(CONFORMANCE_ROOT, "provenance.json");
const M5_PROVENANCE_PATH = join(
  REPOSITORY_ROOT,
  "fixtures/conformance/m5/provenance.json"
);

const HAS_TOOLCHAIN = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return /\blibx264\b/u.test(encoders);
  } catch {
    return false;
  }
})();

interface ReviewedToolchain {
  readonly ffmpeg: {
    readonly executableSha256: string;
    readonly versionOutputSha256: string;
    readonly configurationSha256: string;
    readonly encodersOutputSha256: string;
    readonly calibrationSha256: string;
  };
  readonly ffprobe: {
    readonly executableSha256: string;
    readonly versionOutputSha256: string;
  };
}

interface FixtureProvenance {
  readonly compiler: unknown;
  readonly toolchain: ReviewedToolchain;
  readonly fixture: {
    readonly coverage: readonly string[];
    readonly generatorSource: FileDigest;
    readonly sourceProject: FileDigest;
    readonly sourceFrames: readonly FileDigest[];
    readonly manifestSha256: string;
    readonly units: readonly BlobDigest[];
    readonly staticFrames: readonly StaticBlobDigest[];
    readonly strictInspections: readonly {
      readonly rendition: string;
      readonly units: readonly { readonly id: string; readonly frames: number }[];
    }[];
    readonly asset: { readonly bytes: number; readonly sha256: string };
  };
}

interface FileDigest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface BlobDigest {
  readonly rendition: string;
  readonly unit: string;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

interface StaticBlobDigest {
  readonly staticFrame: string;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

type DiscoveredTools = Awaited<ReturnType<typeof discoverFfmpeg>>;

describe.skipIf(!HAS_TOOLCHAIN)("M5.5 compiler-backed all-routes fixture", () => {
  let temporaryRoot = "";
  let tools: DiscoveredTools;
  let provenance: FixtureProvenance;
  let exactReviewedToolPair = false;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "rma-m55-fixture-"));
    provenance = JSON.parse(
      await readFile(PROVENANCE_PATH, "utf8")
    ) as FixtureProvenance;
    tools = await discoverFfmpeg();
    exactReviewedToolPair =
      tools.executableSha256 === provenance.toolchain.ffmpeg.executableSha256 &&
      tools.ffprobeExecutableSha256 ===
        provenance.toolchain.ffprobe.executableSha256;
  });

  afterAll(async () => {
    if (temporaryRoot !== "") {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("validates checked bytes, every digest, strict AVC unit, source tag, and path-free provenance", async () => {
    const bytes = new Uint8Array(await readFile(GOLDEN_PATH));
    const front = validateCompleteAsset({ bytes }).frontIndex;
    expect(parseFrontIndex(bytes)).toEqual(front);
    expect(bytes.byteLength).toBe(provenance.fixture.asset.bytes);
    expect(sha256(bytes)).toBe(provenance.fixture.asset.sha256);
    expect(sha256(serializeCanonicalJson(front.manifest)))
      .toBe(provenance.fixture.manifestSha256);

    expect(front.unitBlobs).toEqual(provenance.fixture.units);
    for (const blob of provenance.fixture.units) {
      expect(sha256(bytes.subarray(blob.offset, blob.offset + blob.length)))
        .toBe(blob.sha256);
    }
    expect(front.staticBlobs).toEqual(provenance.fixture.staticFrames);
    for (const blob of provenance.fixture.staticFrames) {
      expect(sha256(bytes.subarray(blob.offset, blob.offset + blob.length)))
        .toBe(blob.sha256);
    }

    const inspections = inspectEveryRendition(bytes);
    expect(inspections).toEqual(provenance.fixture.strictInspections.map(
      ({ rendition, units }) => ({ rendition, units })
    ));
    await expect(validateAssetReport(GOLDEN_PATH)).resolves.toMatchObject({
      command: "validate",
      bytes: provenance.fixture.asset.bytes,
      sha256: provenance.fixture.asset.sha256,
      digestClaim: "all-internal-and-whole-file",
      avcClaim: "syntax-and-dependency-inspected"
    });

    await expectFileDigest(provenance.fixture.generatorSource);
    await expectFileDigest(provenance.fixture.sourceProject);
    expect(provenance.fixture.sourceFrames).toHaveLength(30);
    const codes: number[] = [];
    for (let index = 0; index < provenance.fixture.sourceFrames.length; index += 1) {
      const frame = provenance.fixture.sourceFrames[index]!;
      await expectFileDigest({ ...frame, path: `fixtures/compiler/m55/source/${frame.path}` });
      const png = new Uint8Array(await readFile(join(SOURCE_ROOT, frame.path)));
      const code = readTagCode(png);
      expect(code).toBe(tagCode(index));
      if (index > 0) expect(populationCount(code ^ codes[index - 1]!)).toBe(3);
      codes.push(code);
    }
    expect(new Set(codes).size).toBe(30);

    const provenanceValue = JSON.parse(
      await readFile(PROVENANCE_PATH, "utf8")
    ) as unknown;
    expect(findAbsolutePaths(provenanceValue)).toEqual([]);
    const m5 = JSON.parse(
      await readFile(M5_PROVENANCE_PATH, "utf8")
    ) as { readonly toolchain: ReviewedToolchain };
    expect(provenance.toolchain.ffmpeg).toMatchObject({
      executableSha256: m5.toolchain.ffmpeg.executableSha256,
      versionOutputSha256: m5.toolchain.ffmpeg.versionOutputSha256,
      configurationSha256: m5.toolchain.ffmpeg.configurationSha256,
      encodersOutputSha256: m5.toolchain.ffmpeg.encodersOutputSha256,
      calibrationSha256: m5.toolchain.ffmpeg.calibrationSha256
    });
    expect(provenance.toolchain.ffprobe).toMatchObject({
      executableSha256: m5.toolchain.ffprobe.executableSha256,
      versionOutputSha256: m5.toolchain.ffprobe.versionOutputSha256
    });
  }, 30_000);

  it("contains every frozen M5.5 route and cache policy", async () => {
    const bytes = new Uint8Array(await readFile(GOLDEN_PATH));
    const { manifest } = parseFrontIndex(bytes);
    const graph = adaptManifestToMotionGraph(manifest).definition;
    const states = new Map(graph.states.map((state) => [state.id, state]));
    const edges = new Map(manifest.edges.map((edge) => [edge.id, edge]));
    const units = new Map(manifest.units.map((unit) => [unit.id, unit]));

    expect(manifest.renditions.map(({ id, codedWidth, codedHeight }) => ({
      id,
      codedWidth,
      codedHeight
    }))).toEqual([
      { id: "opaque.0.5x", codedWidth: 16, codedHeight: 16 },
      { id: "opaque.1x", codedWidth: 32, codedHeight: 32 }
    ]);
    expect(states.get("idle")?.initialUnit).toEqual({
      unitId: "intro",
      frameCount: 3
    });
    expect(new Set(graph.states.map(({ body }) => body.kind)))
      .toEqual(new Set(["loop", "finite", "held"]));

    const reversible = units.get("hover-shift");
    expect(reversible).toMatchObject({
      kind: "reversible",
      frameCount: 6,
      residency: {
        endpoints: [
          { state: "hover", port: "default", frames: 6 },
          { state: "idle", port: "default", frames: 6 }
        ]
      }
    });
    expect(edges.get("idle-hover")?.transition).toEqual({
      kind: "reversible",
      unit: "hover-shift",
      direction: "forward"
    });
    expect(edges.get("hover-idle")?.transition).toEqual({
      kind: "reversible",
      unit: "hover-shift",
      direction: "reverse",
      reverseOf: "idle-hover"
    });

    expect(units.get("loading-bridge")).toMatchObject({
      kind: "bridge",
      frameCount: 1
    });
    expect(edges.get("idle-loading")).toMatchObject({
      from: "idle",
      to: "loading",
      start: { type: "portal" },
      transition: { kind: "locked", unit: "loading-bridge" }
    });
    expect(edges.get("loading-done")).toMatchObject({
      from: "loading",
      to: "done",
      trigger: { type: "completion" },
      start: { type: "finish" }
    });
    expect(edges.get("loading-done")?.transition).toBeUndefined();
    expect(edges.get("done-idle")).toMatchObject({
      from: "done",
      to: "idle",
      start: { type: "portal" }
    });
    expect(edges.get("done-idle")?.transition).toBeUndefined();

    const cut = edges.get("loading-idle");
    expect(cut).toMatchObject({
      from: "loading",
      to: "idle",
      start: { type: "cut", targetPort: "default", maxWaitFrames: 1 },
      continuity: "cut",
      targetRunwayFrames: 6
    });
    expect(
      reversible?.kind === "reversible" &&
        reversible.residency.endpoints.some((endpoint) =>
          endpoint.state === cut?.to && endpoint.port === cut.start.targetPort
        )
    ).toBe(true);

    const locked = edges.get("idle-loading");
    expect(
      [...edges.values()].some((edge) =>
        edge.from === locked?.to && edge.id === "loading-done"
      )
    ).toBe(true);
    expect(manifest.readiness.policy).toBe("all-routes");
    expect(new Set(provenance.fixture.coverage)).toEqual(new Set([
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
    ]));
  });

  it("compiles twice to byte-identical strict assets and matches the reviewed golden", async () => {
    const firstPath = join(temporaryRoot, "first.rma");
    const secondPath = join(temporaryRoot, "second.rma");
    const first = await compileProjectFile({
      projectPath: PROJECT_PATH,
      outputPath: firstPath,
      ffmpegPath: tools.executable,
      ffprobePath: tools.ffprobeExecutable
    });
    const second = await compileProjectFile({
      projectPath: PROJECT_PATH,
      outputPath: secondPath,
      ffmpegPath: tools.executable,
      ffprobePath: tools.ffprobeExecutable
    });
    const firstBytes = new Uint8Array(await readFile(firstPath));
    const secondBytes = new Uint8Array(await readFile(secondPath));

    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).toBe(second.bytes);
    expect(firstBytes).toEqual(secondBytes);
    expect(first.buildDetails.renditions).toHaveLength(2);
    expect(first.buildDetails.renditions.every(({ accessUnits }) =>
      accessUnits === 30
    )).toBe(true);
    expect(JSON.stringify(first.buildDetails.invocations))
      .not.toContain(REPOSITORY_ROOT);
    expect(() => validateCompleteAsset({ bytes: firstBytes })).not.toThrow();
    expect(inspectEveryRendition(firstBytes)).toHaveLength(2);

    if (exactReviewedToolPair) {
      const golden = new Uint8Array(await readFile(GOLDEN_PATH));
      expect(first.sha256).toBe(provenance.fixture.asset.sha256);
      expect(firstBytes).toEqual(golden);
    }
  }, 120_000);
});

function inspectEveryRendition(
  bytes: Uint8Array
): readonly {
  readonly rendition: string;
  readonly units: readonly { readonly id: string; readonly frames: number }[];
}[] {
  const front = parseFrontIndex(bytes);
  return front.manifest.renditions.map((rendition, renditionIndex) => {
    if (rendition.profile !== "avc-annexb-opaque-v0") {
      throw new Error("M5.5 fixture contains a non-opaque rendition");
    }
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
      units: front.manifest.units.map((unit, unitIndex) => ({
        id: unit.id,
        accessUnits: front.records
          .filter((record) =>
            record.renditionIndex === renditionIndex &&
            record.unitIndex === unitIndex
          )
          .map((record) => ({
            key: record.key,
            bytes: bytes.slice(
              record.payloadOffset,
              record.payloadOffset + record.payloadLength
            )
          }))
      }))
    });
    return Object.freeze({
      rendition: rendition.id,
      units: Object.freeze(inspection.units.map((unit) => Object.freeze({
        id: unit.id,
        frames: unit.frames.length
      })))
    });
  });
}

async function expectFileDigest(file: FileDigest): Promise<void> {
  const bytes = await readFile(join(REPOSITORY_ROOT, file.path));
  expect(bytes.byteLength).toBe(file.bytes);
  expect(sha256(bytes)).toBe(file.sha256);
}

function readTagCode(png: Uint8Array): number {
  let offset = 8;
  let inflated: Uint8Array | undefined;
  while (offset + 12 <= png.byteLength) {
    const length = readUint32(png, offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") {
      inflated = new Uint8Array(
        inflateSync(png.subarray(offset + 8, offset + 8 + length))
      );
    }
    offset += 12 + length;
  }
  if (inflated === undefined || inflated.byteLength !== 32 * 129) {
    throw new Error("generated fixture PNG is not canonical 32×32 RGBA");
  }
  let code = 0;
  for (let bit = 0; bit < 6; bit += 1) {
    const x = 6 + bit * 4;
    const y = 16;
    const pixel = y * 129 + 1 + x * 4;
    expect(inflated[y * 129]).toBe(0);
    expect(inflated[pixel + 3]).toBe(255);
    if (inflated[pixel]! > 128) code |= 1 << bit;
  }
  return code;
}

function tagCode(frameIndex: number): number {
  const columns = [
    0b000111,
    0b001011,
    0b001101,
    0b001110,
    0b010011,
    0b100011
  ];
  const gray = frameIndex ^ (frameIndex >> 1);
  return columns.reduce(
    (code, column, bit) => (gray & (1 << bit)) === 0 ? code : code ^ column,
    0
  );
}

function populationCount(value: number): number {
  let count = 0;
  for (let remaining = value; remaining !== 0; remaining >>>= 1) {
    count += remaining & 1;
  }
  return count;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!
  ) >>> 0;
}

function findAbsolutePaths(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    if (
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-z]:[\\/]/iu.test(value) ||
      /(?:^|[\s"'=:(,])\/[a-z0-9._-]/iu.test(value) ||
      /(?:^|[\s"'=:(,])[a-z]:[\\/]/iu.test(value)
    ) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) findAbsolutePaths(child, output);
    return output;
  }
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) findAbsolutePaths(child, output);
  }
  return output;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
