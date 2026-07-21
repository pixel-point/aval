import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import { parseFrontIndex, validateCompleteAsset } from "../src/parser.js";
import type { CanonicalAssetInput } from "../src/model.js";
import { writeCanonicalAsset } from "../src/writer.js";
import {
  byteIdentity,
  largeChunkWriterInput,
  shuffledWriterInput,
  twoRenditionWriterInput,
  validWriterInput
} from "./writer-fixture.js";

function expectFormatError(action: () => unknown, code?: FormatError["code"]): FormatError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    if (code !== undefined) expect((error as FormatError).code).toBe(code);
    return error as FormatError;
  }
  throw new Error("expected operation to throw");
}

describe("canonical 1.1 asset writer", () => {
  it("emits deterministic bytes while normalizing unordered graph/chunk input", () => {
    const input = twoRenditionWriterInput();
    const canonical = writeCanonicalAsset(input);
    const shuffled = writeCanonicalAsset(shuffledWriterInput(input));
    expect(byteIdentity(canonical, shuffled)).toBe(true);
    expect(parseFrontIndex(canonical).manifest.renditions.map(({ id }) => id))
      .toEqual(["alternate", "video"]);
  });

  it("does not mutate metadata or payload bytes", () => {
    const input = validWriterInput();
    const snapshot = JSON.stringify(input.manifest);
    const payload = input.chunks[0]!.bytes.slice();
    const bytes = writeCanonicalAsset(input);
    expect(JSON.stringify(input.manifest)).toBe(snapshot);
    expect(input.chunks[0]!.bytes).toEqual(payload);
    bytes.fill(0);
    expect(input.chunks[0]!.bytes).toEqual(payload);
  });

  it("derives canonical chunk spans from decoder submission groups", () => {
    const input = validWriterInput();
    const parsed = parseFrontIndex(writeCanonicalAsset(input));
    expect(parsed.records).toHaveLength(input.chunks.length);
    expect(parsed.manifest.units[0]!.chunks[0]).toMatchObject({
      rendition: "video",
      chunkStart: 0,
      chunkCount: 4,
      frameCount: 4
    });
    expect(parsed.records.slice(0, 4).map(({ presentationTimestamp }) => presentationTimestamp))
      .toEqual([0, 1, 2, 3]);
  });

  it("supports hidden chunks and presentation order independent of decode order", () => {
    const input = validWriterInput();
    const first = input.chunks[0]!;
    const second = input.chunks[1]!;
    const replacement = [
      {
        ...first,
        decodeIndex: 0,
        presentationTimestamp: 1,
        duration: 0,
        displayedFrameCount: 0,
        randomAccess: true
      },
      { ...first, decodeIndex: 1, presentationTimestamp: 1, randomAccess: false },
      { ...second, decodeIndex: 2, presentationTimestamp: 0, randomAccess: false },
      ...input.chunks.slice(2, 4).map((chunk) => ({
        ...chunk,
        decodeIndex: chunk.decodeIndex + 1
      })),
      ...input.chunks.slice(4)
    ];
    const bytes = writeCanonicalAsset({ ...input, chunks: replacement });
    const parsed = parseFrontIndex(bytes);
    expect(parsed.records.slice(0, 3).map(({ presentationTimestamp }) => presentationTimestamp))
      .toEqual([1, 1, 0]);
    expect(parsed.records[0]?.displayedFrameCount).toBe(0);
  });

  it("rejects missing, duplicate, unknown, and gapped chunk identities", () => {
    const input = validWriterInput();
    const mutations: CanonicalAssetInput[] = [
      { ...input, chunks: input.chunks.slice(1) },
      { ...input, chunks: [...input.chunks, input.chunks[0]!] },
      { ...input, chunks: [{ ...input.chunks[0]!, unit: "unknown" }, ...input.chunks.slice(1)] },
      { ...input, chunks: [{ ...input.chunks[0]!, decodeIndex: 9 }, ...input.chunks.slice(1)] }
    ];
    for (const value of mutations) {
      expectFormatError(() => writeCanonicalAsset(value), "WRITER_INVALID");
    }
  });

  it("requires each unit to begin at random access and display its authored frame count", () => {
    const input = validWriterInput();
    expectFormatError(
      () => writeCanonicalAsset({
        ...input,
        chunks: [{ ...input.chunks[0]!, randomAccess: false }, ...input.chunks.slice(1)]
      }),
      "WRITER_INVALID"
    );
    expectFormatError(
      () => writeCanonicalAsset({
        ...input,
        chunks: [{ ...input.chunks[0]!, displayedFrameCount: 0, duration: 0 }, ...input.chunks.slice(1)]
      }),
      "WRITER_INVALID"
    );
  });

  it("supports payloads and files above the former internal ceilings", () => {
    const input = largeChunkWriterInput(2 * 1024 * 1024);
    const bytes = writeCanonicalAsset(input);
    expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    expect(validateCompleteAsset({ bytes }).fileRange.length).toBe(bytes.length);
  });

  it("honors lower-only chunk, record, manifest, index, and file budgets", () => {
    const input = validWriterInput();
    for (const budgets of [
      { maxChunkBytes: 3 },
      { maxChunkRecords: input.chunks.length - 1 },
      { maxManifestBytes: 1 },
      { maxIndexBytes: 1 },
      { maxFileBytes: 1 }
    ]) {
      expectFormatError(() => writeCanonicalAsset(input, { budgets }), "BUDGET_EXCEEDED");
    }
  });

  it("rejects old root fields and non-1.1 manifests", () => {
    const input: any = validWriterInput();
    input.manifest.formatVersion = "0.1";
    expectFormatError(() => writeCanonicalAsset(input), "WRITER_INVALID");

    const extra: any = validWriterInput();
    extra.accessUnits = extra.chunks;
    delete extra.chunks;
    expectFormatError(() => writeCanonicalAsset(extra), "WRITER_INVALID");
  });

  it("wraps hostile runtime inputs without leaking built-in exceptions", () => {
    for (const value of [
      null,
      {},
      { ...validWriterInput(), extra: true },
      new Proxy(validWriterInput(), { ownKeys() { throw new Error("hostile"); } })
    ]) {
      expectFormatError(() => writeCanonicalAsset(value as CanonicalAssetInput));
    }
  });
});
