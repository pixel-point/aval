import {
  parseCompileBundleReport,
  serializeCanonicalJson
} from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import {
  buildCompileBundleReport,
  type CompileBundleReportInput
} from "../src/compile/compile-bundle-report.js";
import type { ToolProvenance } from "../src/model.js";

describe("compile bundle report", () => {
  it("serializes ordered codec facts, SRI, policies, and safe source markup", () => {
    const input = reportInput();
    const built = buildCompileBundleReport(input);
    const zeroIntegrity = `sha256-${Buffer.from("00".repeat(32), "hex").toString("base64")}`;
    const oneIntegrity = `sha256-${Buffer.from("11".repeat(32), "hex").toString("base64")}`;

    expect(built.report).toMatchObject({
      reportVersion: "1.0",
      assets: [
        {
          codec: "av1",
          path: "av1.avl",
          bytes: 111,
          sha256: "00".repeat(32),
          codecString: "av01.0.00M.10.0.110.01.01.01.0",
          type: 'application/vnd.aval; codecs="av01.0.00M.10.0.110.01.01.01.0"',
          integrity: zeroIntegrity
        },
        {
          codec: "h264",
          path: "h264.avl",
          bytes: 222,
          sha256: "11".repeat(32),
          codecString: "avc1.42E028",
          type: 'application/vnd.aval; codecs="avc1.42E028"',
          integrity: oneIntegrity
        }
      ],
      encodings: [
        {
          codec: "av1",
          bitDepth: 10,
          cpuUsed: 0,
          tiles: { columns: 4, rows: 2 },
          rowMt: true,
          threads: 32,
          renditions: [{ id: "hero", width: 1920, height: 1080, crf: 15 }]
        },
        {
          codec: "h264",
          preset: "veryslow",
          renditions: [{ id: "hero", width: 1920, height: 1080, crf: 20 }]
        }
      ],
      invocations: [{
        operation: "av1:hero:unit:encode",
        tool: "ffmpeg",
        arguments: ["-i", "pipe:0", "-c:v", "libaom-av1"]
      }],
      warnings: ["AV1 uses the requested ten-bit pixel pipeline."],
      sourceMarkup: [
        `<source src="av1.avl" data-codec="av1" integrity="${zeroIntegrity}">`,
        `<source src="h264.avl" data-codec="h264" integrity="${oneIntegrity}">`
      ].join("\n")
    });
    expect(built.bytes).toEqual(serializeCanonicalJson(built.report));
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.report)).toBe(true);
    expect(Object.isFrozen(built.report.assets)).toBe(true);
    expect(Object.isFrozen(built.report.assets[0])).toBe(true);
    expect(Object.isFrozen(built.report.encodings[0]?.renditions)).toBe(true);
    expect(Object.isFrozen(built.report.invocations[0]?.arguments)).toBe(true);
    expect(Object.isFrozen(built.report.toolchain.ffmpeg.executableIdentity))
      .toBe(true);
  });

  it("round-trips every compiler-valid report field through the format parser", () => {
    const input = reportInput();
    input.invocations[0]!.arguments = ["", "x".repeat(17 * 1024)];
    input.warnings = ["w".repeat(5 * 1024)];
    const built = buildCompileBundleReport(input);

    const parsed = parseCompileBundleReport(
      JSON.parse(new TextDecoder().decode(built.bytes))
    );

    expect(parsed).toEqual(built.report);
    expect(parsed.invocations[0]?.arguments[0]).toBe("");
    expect(parsed.invocations[0]?.arguments[1]).toHaveLength(17 * 1024);
    expect(parsed.warnings[0]).toHaveLength(5 * 1024);
  });

  it("omits executable, configuration, source, and unknown local paths", () => {
    const input = reportInput() as CompileBundleReportInput & {
      readonly sourcePath?: string;
    };
    const firstAsset = input.assets[0] as typeof input.assets[0] & {
      readonly sourcePath: string;
    };
    Object.defineProperty(firstAsset, "sourcePath", {
      value: "/Users/alex/private/render.mov",
      enumerable: true
    });
    const built = buildCompileBundleReport(Object.assign(input, {
      sourcePath: "/Users/alex/private/project.json"
    }));
    const json = new TextDecoder().decode(built.bytes);

    expect(json).not.toContain("/Users/alex");
    expect(json).not.toContain("/opt/homebrew");
    expect(json).not.toContain("render.mov");
    expect(json).not.toContain("project.json");
    expect(json).not.toContain('"executable"');
    expect(json).not.toContain('"configuration"');
    expect(json).toContain('"configurationSha256"');
  });

  it("records the H.265 and VP9 slow-compression policies exactly", () => {
    const built = buildCompileBundleReport({
      assets: [
        {
          codec: "h265",
          bytes: 333,
          sha256: "88".repeat(32),
          codecString: "hvc1.1.6.L93.B0"
        },
        {
          codec: "vp9",
          bytes: 444,
          sha256: "99".repeat(32),
          codecString: "vp09.00.10.08.01.01.01.01.00"
        }
      ],
      encodings: [
        {
          codec: "h265",
          preset: "veryslow",
          threads: 16,
          renditions: [{ id: "uhd", width: 3840, height: 2160, crf: 32 }]
        },
        {
          codec: "vp9",
          deadline: "best",
          cpuUsed: 0,
          threads: 8,
          renditions: [{ id: "uhd", width: 3840, height: 2160, crf: 40 }]
        }
      ],
      invocations: [],
      warnings: [],
      provenance: provenance()
    });

    expect(built.report.encodings).toEqual([
      {
        codec: "h265",
        preset: "veryslow",
        threads: 16,
        renditions: [{ id: "uhd", width: 3840, height: 2160, crf: 32 }]
      },
      {
        codec: "vp9",
        deadline: "best",
        cpuUsed: 0,
        threads: 8,
        renditions: [{ id: "uhd", width: 3840, height: 2160, crf: 40 }]
      }
    ]);
    expect(built.report.assets.map(({ path }) => path))
      .toEqual(["h265.avl", "vp9.avl"]);
  });

  it("rejects duplicate, misordered, or incorrectly qualified asset facts", () => {
    const duplicate = reportInput();
    duplicate.assets[1] = {
      codec: "av1",
      bytes: 222,
      sha256: "11".repeat(32),
      codecString: "av01.0.00M.10.0.110.01.01.01.0"
    };
    expect(() => buildCompileBundleReport(duplicate)).toThrowError(
      expect.objectContaining({ code: "INPUT_INVALID" })
    );

    const wrongDepth = reportInput();
    wrongDepth.assets[0] = {
      ...wrongDepth.assets[0]!,
      codecString: "av01.0.00M.08.0.110.01.01.01.0"
    };
    expect(() => buildCompileBundleReport(wrongDepth)).toThrowError(
      expect.objectContaining({ code: "INPUT_INVALID", field: "assets[0].codecString" })
    );

    const badDigest = reportInput();
    badDigest.assets[0] = { ...badDigest.assets[0]!, sha256: "A".repeat(64) };
    expect(() => buildCompileBundleReport(badDigest)).toThrowError(
      expect.objectContaining({ code: "INPUT_INVALID", field: "assets[0].sha256" })
    );
  });

  it("rejects paths and URLs in diagnostics or normalized invocations", () => {
    const invocationPath = reportInput();
    invocationPath.invocations[0] = {
      operation: "av1:encode",
      tool: "ffmpeg",
      arguments: ["-i", "/private/tmp/source.yuv"]
    };
    expect(() => buildCompileBundleReport(invocationPath)).toThrowError(
      expect.objectContaining({
        code: "INPUT_INVALID",
        field: "invocations[0].arguments[1]"
      })
    );

    const warningUrl = reportInput();
    warningUrl.warnings[0] = "Source came from https://secret.example/video.mov";
    expect(() => buildCompileBundleReport(warningUrl)).toThrowError(
      expect.objectContaining({ code: "INPUT_INVALID", field: "warnings[0]" })
    );
  });

  it("owns immutable snapshots instead of retaining mutable input arrays", () => {
    const input = reportInput();
    const built = buildCompileBundleReport(input);
    input.assets.reverse();
    input.encodings[0]!.renditions[0]!.crf = 63;
    input.invocations[0]!.arguments[0] = "mutated";
    input.warnings[0] = "mutated";

    expect(built.report.assets.map(({ codec }) => codec)).toEqual(["av1", "h264"]);
    expect(built.report.encodings[0]?.renditions[0]?.crf).toBe(15);
    expect(built.report.invocations[0]?.arguments[0]).toBe("-i");
    expect(built.report.warnings[0]).toBe(
      "AV1 uses the requested ten-bit pixel pipeline."
    );
  });
});

function reportInput(): {
  assets: Array<{
    codec: "av1" | "h264";
    bytes: number;
    sha256: string;
    codecString: string;
  }>;
  encodings: Array<MutableEncoding>;
  invocations: Array<{
    operation: string;
    tool: "ffmpeg";
    arguments: string[];
  }>;
  warnings: string[];
  provenance: ToolProvenance;
} {
  return {
    assets: [
      {
        codec: "av1",
        bytes: 111,
        sha256: "00".repeat(32),
        codecString: "av01.0.00M.10.0.110.01.01.01.0"
      },
      {
        codec: "h264",
        bytes: 222,
        sha256: "11".repeat(32),
        codecString: "avc1.42E028"
      }
    ],
    encodings: [
      {
        codec: "av1",
        bitDepth: 10,
        cpuUsed: 0,
        tiles: { columns: 4, rows: 2 },
        rowMt: true,
        threads: 32,
        renditions: [{ id: "hero", width: 1920, height: 1080, crf: 15 }]
      },
      {
        codec: "h264",
        preset: "veryslow",
        renditions: [{ id: "hero", width: 1920, height: 1080, crf: 20 }]
      }
    ],
    invocations: [{
      operation: "av1:hero:unit:encode",
      tool: "ffmpeg",
      arguments: ["-i", "pipe:0", "-c:v", "libaom-av1"]
    }],
    warnings: ["AV1 uses the requested ten-bit pixel pipeline."],
    provenance: provenance()
  };
}

interface MutableRendition {
  id: string;
  width: number;
  height: number;
  crf: number;
}

type MutableEncoding =
  | {
      codec: "av1";
      bitDepth: 8 | 10;
      cpuUsed: number;
      tiles: { columns: number; rows: number };
      rowMt: boolean;
      threads: number;
      renditions: MutableRendition[];
    }
  | {
      codec: "h264";
      preset: "veryslow";
      renditions: MutableRendition[];
    };

function provenance(): ToolProvenance {
  return {
    executable: "/Users/alex/tools/ffmpeg",
    executableSha256: "22".repeat(32),
    executableIdentity: identity("1"),
    versionLine: "ffmpeg version 8.0-test",
    versionOutputSha256: "33".repeat(32),
    configurationLine: "--enable-libaom --prefix=/opt/homebrew/private-build",
    encodersOutputSha256: "44".repeat(32),
    calibrationSha256: "55".repeat(32),
    ffprobeExecutable: "/Users/alex/tools/ffprobe",
    ffprobeExecutableSha256: "66".repeat(32),
    ffprobeExecutableIdentity: identity("2"),
    ffprobeVersionLine: "ffprobe version 8.0-test",
    ffprobeVersionOutputSha256: "77".repeat(32),
    aggregateMemoryLimit: "derived"
  };
}

function identity(inode: string): ToolProvenance["executableIdentity"] {
  return {
    device: "1",
    inode,
    size: 123,
    mtimeNanoseconds: "1000",
    ctimeNanoseconds: "1001"
  };
}
