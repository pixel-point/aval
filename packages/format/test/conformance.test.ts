import { describe, expect, it } from "vitest";

import { writeUint32LE, writeUint64LE } from "../src/checked-integer.js";
import { FormatError } from "../src/errors.js";
import { parseFrontIndex, validateCompleteAsset } from "../src/parser.js";
import {
  generateConformanceFixtures,
  generateVideoGraphFixture
} from "./fixture-generator.js";

function expectFormatError(action: () => unknown): FormatError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect(Object.isFrozen(error)).toBe(true);
    return error as FormatError;
  }
  throw new Error("expected a FormatError");
}

describe("wire 1.1 conformance", () => {
  it("generates deterministic, complete single-codec assets", () => {
    const first = generateConformanceFixtures();
    const second = generateConformanceFixtures();
    expect(first.map(({ fileName }) => fileName)).toEqual(["video-loop.avl", "video-graph.avl"]);
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index]!.bytes).toEqual(second[index]!.bytes);
      expect(first[index]!.sha256).toBe(second[index]!.sha256);
      const layout = validateCompleteAsset({ bytes: first[index]!.bytes });
      expect(layout.fileRange.length).toBe(first[index]!.bytes.length);
      expect(layout.frontIndex.manifest.formatVersion).toBe("1.1");
      expect(new Set(layout.frontIndex.manifest.renditions.map(({ codec }) => codec.slice(0, 4))).size)
        .toBe(1);
    }
  });

  it("covers every graph unit and transition shape", () => {
    const parsed = parseFrontIndex(generateVideoGraphFixture());
    const bodyKinds = new Set(parsed.graph.definition.states.map(({ body }) => body.kind));
    const startKinds = new Set(parsed.graph.definition.edges.map(({ start }) => start.type));
    const transitionKinds = new Set(parsed.graph.definition.edges.flatMap(({ transition }) =>
      transition === undefined ? [] : [transition.kind]
    ));
    expect(bodyKinds).toEqual(new Set(["loop", "finite", "held"]));
    expect(startKinds).toEqual(new Set(["portal", "finish", "cut"]));
    expect(transitionKinds).toEqual(new Set(["locked", "reversible"]));
  });

  it("maps every proper whole-file truncation to FormatError", () => {
    for (const fixture of generateConformanceFixtures()) {
      for (let boundary = 0; boundary < fixture.bytes.length; boundary += 1) {
        expectFormatError(() => validateCompleteAsset({
          bytes: fixture.bytes.subarray(0, boundary)
        }));
      }
    }
  }, 30_000);

  it("rejects hostile header, index, timeline, random-access, and file-length mutations", () => {
    const source = generateVideoGraphFixture();
    const front = parseFrontIndex(source);
    const firstRecord = front.header.indexOffset + 16;
    const mutations = [
      () => {
        const bytes = source.slice();
        writeUint64LE(bytes, 24, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
        return bytes;
      },
      () => {
        const bytes = source.slice();
        writeUint32LE(bytes, front.header.indexOffset + 8, 0xffff_ffff);
        return bytes;
      },
      () => {
        const bytes = source.slice();
        writeUint64LE(bytes, 56, front.header.indexLength + 1);
        return bytes;
      },
      () => {
        const bytes = source.slice();
        writeUint32LE(bytes, firstRecord + 8, 0);
        return bytes;
      },
      () => {
        const bytes = source.slice();
        writeUint32LE(bytes, firstRecord + 32, 0);
        return bytes;
      },
      () => {
        const bytes = source.slice();
        writeUint64LE(bytes, firstRecord + 16, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
        return bytes;
      }
    ];
    for (const mutate of mutations) expectFormatError(() => validateCompleteAsset({ bytes: mutate() }));
  });

  it("treats elementary payload bytes as opaque to the wire layer", () => {
    const source = generateVideoGraphFixture();
    const front = parseFrontIndex(source);
    const bytes = source.slice();
    const offset = front.records[0]!.byteOffset;
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    expect(validateCompleteAsset({ bytes }).fileRange.length).toBe(bytes.length);
  });
});
