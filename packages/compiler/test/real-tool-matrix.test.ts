import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import {
  adaptManifestToMotionGraph,
  FormatError,
  inspectAvcAnnexBRendition,
  parseFrontIndex,
  parseStrictJson,
  serializeCanonicalJson,
  validateCompleteAsset,
  writeCanonicalAsset,
  type AvcRenditionInspectionInput,
  type CompiledManifestInputV01,
  type CompiledManifestV01
} from "@rendered-motion/format";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  unpackAssetFile,
  validateAssetReport
} from "../src/commands/asset.js";
import { compileDirectInput } from "../src/compile/direct-compiler.js";
import { normalizeHoldTimeline } from "../src/compile/normalize-timeline.js";
import { compileProjectFile } from "../src/compile/project-compiler.js";
import { discoverFfmpeg } from "../src/ffmpeg/discovery.js";
import { probeMedia } from "../src/ffmpeg/probe.js";
import type { CompileResult, ToolProvenance } from "../src/model.js";
import { runBoundedProcess } from "../src/process-runner.js";
import {
  concatBytes,
  encodePngVideo,
  FRAME_RATE,
  hasRequiredToolchain,
  matrixProject,
  processWrapperSource,
  waitForPidFile,
  waitForPidsToExit,
  writeGrayFrames
} from "./real-tool-matrix-fixture.js";

const HAS_TOOLCHAIN = hasRequiredToolchain();

describe.skipIf(!HAS_TOOLCHAIN)("real FFmpeg compiler verification matrix", () => {
  let root = "";
  let tools: ToolProvenance;
  let cfrVideo = "";
  let vfrVideo = "";
  let projectPath = "";
  let cfrAssetPromise: Promise<Readonly<CompileResult>> | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rma-real-tool-matrix-"));
    tools = await discoverFfmpeg();

    const cfrFrames = join(root, "cfr-frames");
    await writeGrayFrames(
      cfrFrames,
      [218, 243, 218, 188, 149, 89, 149, 188, 218, 243, 218]
    );
    cfrVideo = join(root, "cfr-intro.mp4");
    encodePngVideo(tools.executable, cfrFrames, 11, cfrVideo, false);

    const vfrFrames = join(root, "vfr-frames");
    await writeGrayFrames(vfrFrames, [128, 190, 230, 190, 128, 66, 26, 66]);
    vfrVideo = join(root, "normalize-hold.mp4");
    encodePngVideo(tools.executable, vfrFrames, 8, vfrVideo, true);

    const projectFrames = join(root, "project-frames");
    await writeGrayFrames(
      projectFrames,
      [
        60, 80, 100, 120, 140, 160, 178, 179, 180, 181, 182, 183, 184,
        185, 182, 170, 160, 150, 140, 130, 120, 110, 100, 90, 80, 70
      ]
    );
    projectPath = join(root, "matrix.rma-project.json");
    await writeFile(projectPath, JSON.stringify(matrixProject(), null, 2));
  }, 60_000);

  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  it("direct-compiles a real CFR video with a separate intro unit", async () => {
    const probe = await probeMedia(cfrVideo, tools.ffprobeExecutable);
    expect(probe).toMatchObject({
      frameCount: 11,
      frameRate: FRAME_RATE,
      variableFrameRate: false
    });

    const result = await cfrAsset();
    const bytes = new Uint8Array(await readFile(result.outputPath));
    const front = parseFrontIndex(bytes);
    expect(front.manifest.states).toEqual([{
      id: "default",
      bodyUnit: "body.default",
      staticFrame: "static.00",
      initialUnit: "intro.default"
    }]);
    expect(front.manifest.units).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "intro.default",
        kind: "one-shot",
        frameCount: 3
      }),
      expect.objectContaining({
        id: "body.default",
        kind: "body",
        playback: "loop",
        frameCount: 8
      })
    ]));
    expect(() => validateCompleteAsset({ bytes })).not.toThrow();
    await expect(validateAssetReport(result.outputPath)).resolves.toMatchObject({
      digestClaim: "all-internal-and-whole-file",
      avcClaim: "syntax-and-dependency-inspected"
    });
  }, 60_000);

  it("explicitly normalize-holds a real VFR video before compilation", async () => {
    const probe = await probeMedia(vfrVideo, tools.ffprobeExecutable);
    expect(probe.variableFrameRate).toBe(true);
    const normalized = normalizeHoldTimeline(
      probe.frames,
      FRAME_RATE,
      probe.timeBase
    );
    expect(normalized.duplicatedSourceFrames.length).toBeGreaterThan(0);
    expect(normalized.sourceFrameByOutputFrame.length).toBeGreaterThan(2);

    const outputPath = join(root, "normalize-hold.rma");
    const result = await compileDirectInput({
      inputPath: vfrVideo,
      outputPath,
      loop: [0, normalized.sourceFrameByOutputFrame.length],
      fps: FRAME_RATE,
      normalizeVfr: true,
      ffmpegPath: tools.executable,
      ffprobePath: tools.ffprobeExecutable
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^VFR normalization produced \d+ frames$/u),
      expect.stringMatching(/^duplicated source frames: (?!none)/u)
    ]));
    const front = parseFrontIndex(new Uint8Array(await readFile(outputPath)));
    expect(front.manifest.frameRate).toEqual(FRAME_RATE);
    expect(front.manifest.units).toEqual([
      expect.objectContaining({
        id: "body.default",
        frameCount: normalized.sourceFrameByOutputFrame.length
      })
    ]);
    await expect(validateAssetReport(outputPath)).resolves.toMatchObject({
      digestClaim: "all-internal-and-whole-file",
      avcClaim: "syntax-and-dependency-inspected"
    });
  }, 60_000);

  it("preserves locked, reversible, finish, and cut metadata in one compiled graph", async () => {
    const outputPath = join(root, "matrix-project.rma");
    const result = await compileProjectFile({
      projectPath,
      outputPath,
      ffmpegPath: tools.executable,
      ffprobePath: tools.ffprobeExecutable
    });
    expect(result.warnings).toEqual([]);
    expect(result.buildDetails.continuity.map(({ name }) => name)).toEqual([
      "idle-done cut",
      "done-idle departure",
      "done-idle departure",
      "done-idle arrival",
      "hover-done departure",
      "hover-idle departure",
      "hover-idle arrival",
      "idle-hover departure",
      "idle-hover arrival"
    ]);
    for (const report of result.buildDetails.continuity) {
      if (report.kind === "cut") {
        expect(report).toMatchObject({ status: "cut", metrics: null });
      } else {
        expect(report.status).toBe("pass");
        expect(report.metrics).toMatchObject({
          boundaryRms: expect.any(Number),
          neighborP95: expect.any(Number),
          repeatedEndpointPause: false
        });
      }
    }
    const bytes = new Uint8Array(await readFile(outputPath));
    const front = parseFrontIndex(bytes);
    const graph = adaptManifestToMotionGraph(front.manifest).definition;

    expect(front.manifest.units).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "state-change",
        kind: "reversible",
        frameCount: 6,
        residency: {
          endpoints: [
            { state: "hover", port: "default", frames: 6 },
            { state: "idle", port: "default", frames: 6 }
          ]
        }
      })
    ]));
    expect(front.manifest.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "done-idle",
        transition: { kind: "locked", unit: "reset-bridge" }
      }),
      expect.objectContaining({
        id: "idle-hover",
        transition: {
          kind: "reversible",
          unit: "state-change",
          direction: "forward"
        }
      }),
      expect.objectContaining({
        id: "hover-idle",
        continuity: "exact-reverse",
        transition: {
          kind: "reversible",
          unit: "state-change",
          direction: "reverse",
          reverseOf: "idle-hover"
        }
      }),
      expect.objectContaining({
        id: "hover-done",
        trigger: { type: "completion" },
        start: { type: "finish", targetPort: "default", maxWaitFrames: 0 }
      }),
      expect.objectContaining({
        id: "idle-done",
        start: { type: "cut", targetPort: "default", maxWaitFrames: 1 },
        continuity: "cut",
        targetRunwayFrames: 6
      })
    ]));
    expect(graph.edges.map(({ id }) => id)).toEqual([
      "done-idle",
      "hover-done",
      "hover-idle",
      "idle-done",
      "idle-hover"
    ]);
    expect(() => validateCompleteAsset({ bytes })).not.toThrow();
    await expect(validateAssetReport(outputPath)).resolves.toMatchObject({
      digestClaim: "all-internal-and-whole-file",
      avcClaim: "syntax-and-dependency-inspected"
    });
  }, 60_000);

  it("cancels a real FFmpeg descendant and leaves no live process tree", async () => {
    const wrapper = join(root, "ffmpeg-child.mjs");
    const pidFile = join(root, "ffmpeg-child-pids.json");
    const privateRoot = join(root, "cancelled-process-work");
    await mkdir(privateRoot);
    await writeFile(wrapper, processWrapperSource());
    const controller = new AbortController();
    const operation = runBoundedProcess({
      executable: execPath,
      arguments: [wrapper, tools.executable, pidFile],
      cwd: root,
      limits: {
        timeoutMs: 10_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024
      },
      privateWorkingDirectory: { root: privateRoot, prefix: "ffmpeg-" },
      signal: controller.signal
    });
    const pids = await waitForPidFile(pidFile);
    controller.abort("real-tool-matrix");
    await expect(operation).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(waitForPidsToExit(pids)).resolves.toBeUndefined();
    expect(await readdir(privateRoot)).toEqual([]);
  }, 10_000);

  it("bounds real FFmpeg output and rejects overflow", async () => {
    await expect(runBoundedProcess({
      executable: tools.executable,
      arguments: [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=black:size=32x32:rate=30",
        "-frames:v", "2", "-an",
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
      ],
      cwd: root,
      limits: {
        timeoutMs: 5_000,
        maxStdoutBytes: 128,
        maxStderrBytes: 1024
      }
    })).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  }, 10_000);

  it("rejects a corrupted access unit from the real encoder", async () => {
    const result = await cfrAsset();
    const bytes = new Uint8Array(await readFile(result.outputPath));
    const input = realAvcInspectionInput(bytes);
    expect(() => inspectAvcAnnexBRendition(input)).not.toThrow();
    const first = input.units[0]?.accessUnits[0]?.bytes;
    expect(first?.subarray(0, 4)).toEqual(Uint8Array.of(0, 0, 0, 1));
    first![4] = first![4]! | 0x80;
    expect(() => inspectAvcAnnexBRendition(input)).toThrow(FormatError);
    expect(() => inspectAvcAnnexBRendition(input)).toThrow(/forbidden_zero_bit/u);
  }, 60_000);

  it("rejects a targeted B-slice mutation of a real libx264 P access unit", async () => {
    const result = await cfrAsset();
    const input = realAvcInspectionInput(
      new Uint8Array(await readFile(result.outputPath))
    );
    expect(() => inspectAvcAnnexBRendition(input)).not.toThrow();

    const accessUnit = input.units[0]?.accessUnits[1];
    if (accessUnit === undefined) {
      throw new Error("real encoder fixture did not produce a non-IDR access unit");
    }
    const vcl = requireNal(accessUnit.bytes, 1);
    const rbsp = mappedRbsp(accessUnit.bytes, vcl);
    const firstMacroblock = readUnsignedExpGolomb(rbsp.bytes, 0);
    const sliceType = readUnsignedExpGolomb(
      rbsp.bytes,
      firstMacroblock.nextBitOffset
    );
    expect(firstMacroblock.value).toBe(0);
    expect(sliceType.value).toBe(5);

    // libx264 emits the all-P code 5. Code 6 is the same-width all-B form,
    // so changing its final code bit leaves every other real encoded bit in
    // the access unit at its original position.
    const changedBit = sliceType.nextBitOffset - 1;
    expect(readBit(rbsp.bytes, changedBit)).toBe(0);
    setMappedRbspBit(accessUnit.bytes, rbsp.byteOffsets, changedBit, 1);

    expect(() => inspectAvcAnnexBRendition(input)).toThrow(FormatError);
    expect(() => inspectAvcAnnexBRendition(input)).toThrow(
      /only I and P slices are permitted \(B\/SP\/SI are forbidden\)/u
    );
  }, 60_000);

  it("rejects an extra real libx264 IDR access unit after frame zero", async () => {
    const result = await cfrAsset();
    const original = realAvcInspectionInput(
      new Uint8Array(await readFile(result.outputPath))
    );
    expect(() => inspectAvcAnnexBRendition(original)).not.toThrow();

    const first = original.units[0]?.accessUnits[0];
    if (first === undefined) {
      throw new Error("real encoder fixture did not produce a frame-zero IDR");
    }
    expect(requireNal(first.bytes, 5).type).toBe(5);
    const input = replaceAccessUnit(original, 0, 1, {
      key: true,
      bytes: first.bytes.slice()
    });

    expect(() => inspectAvcAnnexBRendition(input)).toThrow(FormatError);
    expect(() => inspectAvcAnnexBRendition(input)).toThrow(
      /later frames must contain exactly AUD\/non-IDR/u
    );
  }, 60_000);

  it("rejects a changed SPS in a later real libx264 unit", async () => {
    const result = await cfrAsset();
    const input = realAvcInspectionInput(
      new Uint8Array(await readFile(result.outputPath))
    );
    expect(() => inspectAvcAnnexBRendition(input)).not.toThrow();

    const laterUnitIdr = input.units[1]?.accessUnits[0];
    if (laterUnitIdr === undefined) {
      throw new Error("real encoder fixture did not produce a second unit IDR");
    }
    const sps = requireNal(laterUnitIdr.bytes, 7);
    const rbsp = mappedRbsp(laterUnitIdr.bytes, sps);
    const direct8x8InferenceBit = locateDirect8x8InferenceBit(rbsp.bytes);
    const original = readBit(rbsp.bytes, direct8x8InferenceBit);
    setMappedRbspBit(
      laterUnitIdr.bytes,
      rbsp.byteOffsets,
      direct8x8InferenceBit,
      original === 0 ? 1 : 0
    );

    expect(() => inspectAvcAnnexBRendition(input)).toThrow(FormatError);
    expect(() => inspectAvcAnnexBRendition(input)).toThrow(
      /SPS bytes changed within the rendition/u
    );
  }, 60_000);

  it("unpacks every compiled byte range without changing a byte", async () => {
    const result = await cfrAsset();
    const bytes = new Uint8Array(await readFile(result.outputPath));
    const front = parseFrontIndex(bytes);
    const outputDirectory = join(root, "unpacked-cfr");
    const report = await unpackAssetFile(result.outputPath, outputDirectory);

    const manifestBytes = new Uint8Array(await readFile(
      join(outputDirectory, "manifest.json")
    ));
    expect(manifestBytes).toEqual(serializeCanonicalJson(front.manifest));
    expect(new Uint8Array(await readFile(join(outputDirectory, "index.json"))))
      .toEqual(serializeCanonicalJson({
        header: front.header,
        records: front.records
      }));
    for (const blob of front.unitBlobs) {
      const prefix = `${blob.rendition}--${blob.unit}`;
      const expected = bytes.slice(blob.offset, blob.offset + blob.length);
      expect(new Uint8Array(await readFile(join(outputDirectory, `${prefix}.h264`))))
        .toEqual(expected);
      const accessUnits: Uint8Array[] = [];
      for (
        let ordinal = blob.sampleStart;
        ordinal < blob.sampleStart + blob.sampleCount;
        ordinal += 1
      ) {
        const record = front.records[ordinal]!;
        accessUnits.push(new Uint8Array(await readFile(join(
          outputDirectory,
          `${prefix}--${String(record.frameIndex).padStart(4, "0")}.au`
        ))));
      }
      expect(concatBytes(accessUnits)).toEqual(expected);
    }
    for (const blob of front.staticBlobs) {
      expect(new Uint8Array(await readFile(
        join(outputDirectory, `${blob.staticFrame}.png`)
      ))).toEqual(bytes.slice(blob.offset, blob.offset + blob.length));
    }
    const unpackedManifest = parseStrictJson(manifestBytes) as unknown as
      CompiledManifestV01;
    const accessUnits = await Promise.all(front.records.map(async (record) => {
      const rendition = front.manifest.renditions[record.renditionIndex]!;
      const unit = front.manifest.units[record.unitIndex]!;
      const prefix = `${rendition.id}--${unit.id}`;
      return {
        rendition: rendition.id,
        unit: unit.id,
        frameIndex: record.frameIndex,
        key: record.key,
        bytes: new Uint8Array(await readFile(join(
          outputDirectory,
          `${prefix}--${String(record.frameIndex).padStart(4, "0")}.au`
        )))
      };
    }));
    const staticPayloads = await Promise.all(front.staticBlobs.map(async (blob) => ({
      staticFrame: blob.staticFrame,
      bytes: new Uint8Array(await readFile(
        join(outputDirectory, `${blob.staticFrame}.png`)
      ))
    })));
    expect(writeCanonicalAsset({
      manifest: writerManifest(unpackedManifest),
      accessUnits,
      staticPayloads
    })).toEqual(bytes);
    const unpackReport = parseStrictJson(new Uint8Array(await readFile(
      join(outputDirectory, "unpack-report.json")
    ))) as { readonly source?: { readonly sha256?: string } };
    expect(unpackReport.source?.sha256).toBe(result.sha256);
    expect(report.accessUnits).toBe(front.records.length);
  }, 60_000);

  function cfrAsset(): Promise<Readonly<CompileResult>> {
    cfrAssetPromise ??= compileDirectInput({
      inputPath: cfrVideo,
      outputPath: join(root, "cfr-intro.rma"),
      loop: [3, 11],
      ffmpegPath: tools.executable,
      ffprobePath: tools.ffprobeExecutable
    });
    return cfrAssetPromise;
  }
});

function writerManifest(
  manifest: CompiledManifestV01
): CompiledManifestInputV01 {
  const { units, staticFrames, ...rest } = manifest;
  return {
    ...rest,
    units: units.map((unit) => {
      const { samples, ...fields } = unit;
      return {
        ...fields,
        samples: samples.map(({ rendition, sha256 }) => ({ rendition, sha256 }))
      };
    }),
    staticFrames: staticFrames.map(({ id, width, height, sha256 }) => ({
      id,
      width,
      height,
      sha256
    }))
  } as CompiledManifestInputV01;
}

interface TestNalRange {
  readonly type: number;
  readonly headerOffset: number;
  readonly payloadEnd: number;
}

interface MappedRbsp {
  readonly bytes: Uint8Array;
  readonly byteOffsets: readonly number[];
}

interface ExpGolombValue {
  readonly value: number;
  readonly nextBitOffset: number;
}

function realAvcInspectionInput(bytes: Uint8Array): AvcRenditionInspectionInput {
  const front = parseFrontIndex(bytes);
  const rendition = front.manifest.renditions[0];
  if (rendition?.profile !== "avc-annexb-opaque-v0") {
    throw new Error("real encoder fixture did not produce an opaque AVC rendition");
  }
  return {
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
          record.renditionIndex === 0 && record.unitIndex === unitIndex
        )
        .map((record) => ({
          key: record.key,
          bytes: bytes.slice(
            record.payloadOffset,
            record.payloadOffset + record.payloadLength
          )
        }))
    }))
  };
}

function replaceAccessUnit(
  input: AvcRenditionInspectionInput,
  unitIndex: number,
  frameIndex: number,
  replacement: { readonly key: boolean; readonly bytes: Uint8Array }
): AvcRenditionInspectionInput {
  return {
    profile: input.profile,
    units: input.units.map((unit, candidateUnitIndex) => ({
      id: unit.id,
      accessUnits: unit.accessUnits.map((accessUnit, candidateFrameIndex) =>
        candidateUnitIndex === unitIndex && candidateFrameIndex === frameIndex
          ? replacement
          : { key: accessUnit.key, bytes: accessUnit.bytes.slice() }
      )
    }))
  };
}

function requireNal(bytes: Uint8Array, expectedType: number): TestNalRange {
  const starts: { readonly offset: number; readonly prefixLength: 3 | 4 }[] = [];
  for (let offset = 0; offset + 3 <= bytes.length;) {
    if (
      offset + 4 <= bytes.length &&
      bytes[offset] === 0 &&
      bytes[offset + 1] === 0 &&
      bytes[offset + 2] === 0 &&
      bytes[offset + 3] === 1
    ) {
      starts.push({ offset, prefixLength: 4 });
      offset += 4;
    } else if (
      bytes[offset] === 0 &&
      bytes[offset + 1] === 0 &&
      bytes[offset + 2] === 1
    ) {
      starts.push({ offset, prefixLength: 3 });
      offset += 3;
    } else {
      offset += 1;
    }
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined) continue;
    const headerOffset = start.offset + start.prefixLength;
    const type = (bytes[headerOffset] ?? 0) & 0x1f;
    if (type === expectedType) {
      return {
        type,
        headerOffset,
        payloadEnd: starts[index + 1]?.offset ?? bytes.length
      };
    }
  }
  throw new Error(`real access unit has no NAL type ${String(expectedType)}`);
}

function mappedRbsp(bytes: Uint8Array, nal: TestNalRange): MappedRbsp {
  const values: number[] = [];
  const byteOffsets: number[] = [];
  let zeroCount = 0;
  for (
    let offset = nal.headerOffset + 1;
    offset < nal.payloadEnd;
    offset += 1
  ) {
    const value = bytes[offset];
    if (value === undefined) {
      throw new Error("real access unit ended inside a NAL payload");
    }
    if (zeroCount === 2 && value === 0x03) {
      zeroCount = 0;
      continue;
    }
    values.push(value);
    byteOffsets.push(offset);
    zeroCount = value === 0 ? zeroCount + 1 : 0;
  }
  return { bytes: Uint8Array.from(values), byteOffsets };
}

function locateDirect8x8InferenceBit(rbsp: Uint8Array): number {
  let cursor = 24;
  ({ nextBitOffset: cursor } = readUnsignedExpGolomb(rbsp, cursor));
  ({ nextBitOffset: cursor } = readUnsignedExpGolomb(rbsp, cursor));
  const pictureOrderCount = readUnsignedExpGolomb(rbsp, cursor);
  cursor = pictureOrderCount.nextBitOffset;
  if (pictureOrderCount.value === 0) {
    ({ nextBitOffset: cursor } = readUnsignedExpGolomb(rbsp, cursor));
  } else if (pictureOrderCount.value === 1) {
    throw new Error("real encoder unexpectedly emitted pic_order_cnt_type 1");
  }
  ({ nextBitOffset: cursor } = readUnsignedExpGolomb(rbsp, cursor));
  cursor += 1; // gaps_in_frame_num_value_allowed_flag
  ({ nextBitOffset: cursor } = readUnsignedExpGolomb(rbsp, cursor));
  ({ nextBitOffset: cursor } = readUnsignedExpGolomb(rbsp, cursor));
  if (readBit(rbsp, cursor) !== 1) {
    throw new Error("real encoder unexpectedly emitted field-coded pictures");
  }
  cursor += 1;
  return cursor;
}

function readUnsignedExpGolomb(
  bytes: Uint8Array,
  bitOffset: number
): ExpGolombValue {
  let cursor = bitOffset;
  let leadingZeros = 0;
  while (readBit(bytes, cursor) === 0) {
    leadingZeros += 1;
    cursor += 1;
    if (leadingZeros > 31) {
      throw new Error("real encoder emitted an oversized Exp-Golomb value");
    }
  }
  cursor += 1;
  let code = 1;
  for (let index = 0; index < leadingZeros; index += 1) {
    code = code * 2 + readBit(bytes, cursor);
    cursor += 1;
  }
  return { value: code - 1, nextBitOffset: cursor };
}

function readBit(bytes: Uint8Array, bitOffset: number): number {
  const byte = bytes[Math.floor(bitOffset / 8)];
  if (byte === undefined) {
    throw new Error("real encoder NAL ended inside the targeted syntax element");
  }
  return (byte >> (7 - (bitOffset % 8))) & 1;
}

function setMappedRbspBit(
  accessUnit: Uint8Array,
  byteOffsets: readonly number[],
  bitOffset: number,
  value: 0 | 1
): void {
  const byteOffset = byteOffsets[Math.floor(bitOffset / 8)];
  if (byteOffset === undefined || accessUnit[byteOffset] === undefined) {
    throw new Error("targeted RBSP bit has no access-unit byte mapping");
  }
  const mask = 1 << (7 - (bitOffset % 8));
  accessUnit[byteOffset] = value === 1
    ? accessUnit[byteOffset] | mask
    : accessUnit[byteOffset] & ~mask;
}
