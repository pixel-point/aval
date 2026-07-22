import { describe, expect, it } from "vitest";

import { parseCompileBundleReport } from "../src/compile-bundle-report.js";

describe("compile bundle report", () => {
  it("validates, detaches, and freezes the browser-facing report contract", () => {
    const source = validReport();
    const parsed = parseCompileBundleReport(source);

    expect(parsed.assets[0]).toMatchObject({
      codec: "h264",
      path: "h264.avl",
      codecString: "avc1.42E01E"
    });
    expect(parsed.encodings[0]).toMatchObject({
      codec: "h264",
      preset: "medium",
      renditions: [{ id: "video.main", width: 640, height: 360, crf: 30 }]
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.assets)).toBe(true);
    expect(Object.isFrozen(parsed.encodings[0]?.renditions)).toBe(true);
    source.assets[0]!.bytes = 1;
    expect(parsed.assets[0]?.bytes).toBe(1234);
  });

  it("rejects codec strings outside the supported AVAL codec contract", () => {
    const source = validReport();
    source.assets[0]!.codecString = "avc1.000000";
    source.assets[0]!.type = 'application/vnd.aval; codecs="avc1.000000"';
    expect(() => parseCompileBundleReport(source)).toThrow(
      /codecString.*supported codec string/u
    );
  });

  it("rejects asset and encoding order drift", () => {
    const source = validReport();
    source.assets[0]!.codec = "vp9";
    source.assets[0]!.path = "vp9.avl";
    expect(() => parseCompileBundleReport(source)).toThrow(
      /must match the encoding/u
    );
  });

  it("rejects integrity metadata that disagrees with the SHA-256 digest", () => {
    const source = validReport();
    source.assets[0]!.integrity =
      "sha256-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    expect(() => parseCompileBundleReport(source)).toThrow(
      /integrity.*declared sha256 digest/u
    );
  });

  it("accepts the compiler's empty arguments and full path-free text limits", () => {
    const source = validReport();
    source.invocations[0]!.arguments = ["", "x".repeat(17 * 1024)];
    source.warnings = ["w".repeat(5 * 1024)];

    const parsed = parseCompileBundleReport(source);

    expect(parsed.invocations[0]?.arguments[0]).toBe("");
    expect(parsed.invocations[0]?.arguments[1]).toHaveLength(17 * 1024);
    expect(parsed.warnings[0]).toHaveLength(5 * 1024);
  });

  it("enforces the compiler's warning-count limit", () => {
    const source = validReport();
    source.warnings = Array.from({ length: 4_097 }, () => "warning");

    expect(() => parseCompileBundleReport(source)).toThrow(
      /warnings.*0 through 4096 entries/u
    );
  });

  it("rejects presets outside the compiler's encoder allowlists", () => {
    const source = validReport();
    source.encodings[0]!.preset = "not-an-x264-preset";

    expect(() => parseCompileBundleReport(source)).toThrow(
      /preset.*must be one of/u
    );
  });

  it("rejects malformed toolchain provenance", () => {
    const source = validReport();
    source.toolchain = {} as typeof source.toolchain;

    expect(() => parseCompileBundleReport(source)).toThrow(
      /toolchain\.ffmpeg.*required/u
    );
  });

  it("requires source markup derived from the ordered assets", () => {
    const source = validReport();
    source.sourceMarkup = "<source>";

    expect(() => parseCompileBundleReport(source)).toThrow(
      /sourceMarkup.*ordered asset metadata/u
    );
  });
});

function validReport() {
  const asset = {
    codec: "h264",
    path: "h264.avl",
    bytes: 1234,
    sha256: "0".repeat(64),
    codecString: "avc1.42E01E",
    type: 'application/vnd.aval; codecs="avc1.42E01E"',
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  };
  return {
    reportVersion: "1.0",
    assets: [asset],
    encodings: [{
      codec: "h264",
      preset: "medium",
      renditions: [{ id: "video.main", width: 640, height: 360, crf: 30 }]
    }],
    invocations: [{
      operation: "h264:video.main:loop:encode",
      tool: "ffmpeg",
      arguments: ["-c:v", "libx264"]
    }],
    warnings: [] as string[],
    toolchain: validToolchain(),
    sourceMarkup:
      `<source src="${asset.path}" data-codec="${asset.codec}" integrity="${asset.integrity}">`
  };
}

function validToolchain() {
  return {
    ffmpeg: {
      executableSha256: "1".repeat(64),
      executableIdentity: executableIdentity("1"),
      version: "ffmpeg version 8.0-test",
      versionOutputSha256: "2".repeat(64),
      configurationSha256: "3".repeat(64),
      encodersOutputSha256: "4".repeat(64),
      calibrationSha256: "5".repeat(64)
    },
    ffprobe: {
      executableSha256: "6".repeat(64),
      executableIdentity: executableIdentity("2"),
      version: "ffprobe version 8.0-test",
      versionOutputSha256: "7".repeat(64)
    },
    aggregateMemoryLimit: "derived"
  };
}

function executableIdentity(inode: string) {
  return {
    device: "1",
    inode,
    size: 123,
    mtimeNanoseconds: "1000",
    ctimeNanoseconds: "1001"
  };
}
