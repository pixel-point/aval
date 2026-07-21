import type {
  ProductionRendition,
  Unit
} from "@pixel-point/aval-format";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeCatalogChunk } from "./asset-catalog.js";
import { DecodeTimeline } from "./decode-timeline.js";
import type {
  VideoCodecAdapterInspection,
  VideoDecodeSubmissionMetadata
} from "./video-codec-adapters.js";
import {
  planWorkerSampleGroupCredit,
  WorkerSampleFactory,
  type WorkerSampleCatalog,
  type WorkerSampleFrameRequest,
  type WorkerSampleResourceHost
} from "./worker-samples.js";

const FRAME_DURATION = 40_000;
const LIMITS = Object.freeze({
  maxDecodeQueueSize: 8,
  maxPendingSamples: 8,
  maxOutstandingFrames: 8,
  maxDecodedBytes: 8 * 64 * 64 * 4
});

const RENDITION = Object.freeze({
  id: "vp9-main",
  codec: "vp09.00.10.08.01.01.01.01.00",
  bitDepth: 8,
  codedWidth: 64,
  codedHeight: 64,
  alphaLayout: Object.freeze({
    type: "opaque" as const,
    colorRect: Object.freeze([0, 0, 64, 64] as const)
  }),
  bitrate: Object.freeze({ average: 1_000_000, peak: 2_000_000 })
} satisfies ProductionRendition);

const UNIT = Object.freeze({
  id: "clip",
  kind: "one-shot" as const,
  frameCount: 6,
  chunks: Object.freeze([Object.freeze({
    rendition: RENDITION.id,
    chunkStart: 0,
    chunkCount: 7,
    frameCount: 6,
    sha256: "0".repeat(64)
  })])
} satisfies Unit);

/**
 * Decode order:
 *   hidden, 0 | 3, 1, 2 | [4, 5], hidden
 * Presentation order:
 *   0         | 1, 2, 3 | 4, 5
 */
const SUBMISSIONS = Object.freeze([
  submission(0, "key", [], 0),
  submission(1, "delta", [0], 0),
  submission(2, "delta", [3], 3 * FRAME_DURATION),
  submission(3, "delta", [1], FRAME_DURATION),
  submission(4, "delta", [2], 2 * FRAME_DURATION),
  submission(5, "delta", [4, 5], 4 * FRAME_DURATION),
  submission(6, "delta", [], 6 * FRAME_DURATION)
]);

const INSPECTION = Object.freeze({
  family: "vp9" as const,
  bitstream: "frame" as const,
  bitDepth: 8 as const,
  decoderConfig: Object.freeze({
    codec: RENDITION.codec,
    codedWidth: RENDITION.codedWidth,
    codedHeight: RENDITION.codedHeight
  }),
  units: Object.freeze([Object.freeze({
    id: UNIT.id,
    displayedFrameCount: UNIT.frameCount,
    submissions: SUBMISSIONS
  })])
} satisfies VideoCodecAdapterInspection);

const PAYLOADS = Object.freeze(SUBMISSIONS.map(({ decodeIndex }) =>
  Object.freeze(Array.from(
    { length: decodeIndex + 3 },
    (_, offset) => decodeIndex * 16 + offset
  ))
));

describe("WorkerSampleFactory", () => {
  it("uses one credit decision for chunks and displayed frames", () => {
    const requirement = {
      chunkCount: 2,
      frameCount: 1
    } as const;
    expect(planWorkerSampleGroupCredit(requirement, {
      pendingSamples: 6,
      outstandingFrames: 7
    }, LIMITS)).toEqual({
      chunkCost: 2,
      frameCost: 1,
      fits: true
    });
    expect(planWorkerSampleGroupCredit(requirement, {
      pendingSamples: 7,
      outstandingFrames: 7
    }, LIMITS).fits).toBe(false);
    expect(() => planWorkerSampleGroupCredit(requirement, {
      pendingSamples: -1,
      outstandingFrames: 0
    }, LIMITS)).toThrow("pending sample count");
  });

  it("reports the smallest safe groups for hidden and reordered chunks", () => {
    const { factory } = createFixture();

    expect(factory.nextGroupRequirement(frame(UNIT.id, 0))).toEqual({
      unitId: UNIT.id,
      firstUnitFrame: 0,
      frameCount: 1,
      chunkCount: 2,
      reorderFrameCount: 1
    });
    expect(factory.nextGroupRequirement(frame(UNIT.id, 1))).toEqual({
      unitId: UNIT.id,
      firstUnitFrame: 1,
      frameCount: 3,
      chunkCount: 3,
      reorderFrameCount: 1
    });
    expect(factory.nextGroupRequirement(frame(UNIT.id, 4))).toEqual({
      unitId: UNIT.id,
      firstUnitFrame: 4,
      frameCount: 2,
      chunkCount: 2,
      reorderFrameCount: 1
    });

    expect(() => factory.nextGroupRequirement(frame(UNIT.id, 2)))
      .toThrow("safe presentation-group boundary");
  });

  it("keeps transferred samples in decode order and outputs in presentation order", () => {
    const { factory } = createFixture();
    const prefix = factory.createBatch({
      frames: [frame(UNIT.id, 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    });
    const reordered = factory.createBatch({
      frames: [frame(UNIT.id, 1), frame(UNIT.id, 2), frame(UNIT.id, 3)],
      pendingSamples: 0,
      outstandingFrames: 0
    });
    const suffix = factory.createBatch({
      frames: [frame(UNIT.id, 4), frame(UNIT.id, 5)],
      pendingSamples: 0,
      outstandingFrames: 0
    });

    expect(prefix.samples.map(sampleIdentity)).toEqual([
      [0, [], 0, 0, 0],
      [1, [0], 1, 0, FRAME_DURATION]
    ]);
    expect(prefix.outputs.map(outputIdentity)).toEqual([
      [0, 0, 1, 0, FRAME_DURATION]
    ]);

    expect(reordered.samples.map(sampleIdentity)).toEqual([
      [2, [3], 1, 3 * FRAME_DURATION, FRAME_DURATION],
      [3, [1], 1, FRAME_DURATION, FRAME_DURATION],
      [4, [2], 1, 2 * FRAME_DURATION, FRAME_DURATION]
    ]);
    expect(reordered.outputs.map(outputIdentity)).toEqual([
      [1, 1, 3, FRAME_DURATION, FRAME_DURATION],
      [2, 2, 4, 2 * FRAME_DURATION, FRAME_DURATION],
      [3, 3, 2, 3 * FRAME_DURATION, FRAME_DURATION]
    ]);

    expect(suffix.samples.map(sampleIdentity)).toEqual([
      [5, [4, 5], 2, 4 * FRAME_DURATION, FRAME_DURATION],
      [6, [], 0, 4 * FRAME_DURATION, 0]
    ]);
    expect(suffix.outputs.map(outputIdentity)).toEqual([
      [4, 4, 5, 4 * FRAME_DURATION, FRAME_DURATION],
      [5, 5, 5, 5 * FRAME_DURATION, FRAME_DURATION]
    ]);

    for (const batch of [prefix, reordered, suffix]) {
      expect(batch.generation).toBe(1);
      expect(Object.keys(batch)).toEqual(["generation", "samples", "outputs"]);
      expect(Object.isFrozen(batch)).toBe(true);
      expect(Object.isFrozen(batch.samples)).toBe(true);
      expect(Object.isFrozen(batch.outputs)).toBe(true);
      expect(batch.samples.every(Object.isFrozen)).toBe(true);
      expect(batch.outputs.every(Object.isFrozen)).toBe(true);
      expect(batch.samples.every((sample) =>
        sample.unitInstance === 0 &&
        sample.unitChunkCount === SUBMISSIONS.length &&
        sample.unitFrameCount === UNIT.frameCount &&
        sample.presentationOrdinalBase === 0
      )).toBe(true);
    }
  });

  it("copies distinct exact buffers that can transfer without altering catalog bytes", () => {
    const { catalog, factory } = createFixture();
    factory.createBatch({
      frames: [frame(UNIT.id, 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    });
    const batch = factory.createBatch({
      frames: [frame(UNIT.id, 1), frame(UNIT.id, 2), frame(UNIT.id, 3)],
      pendingSamples: 0,
      outstandingFrames: 0
    });
    const expected = [2, 3, 4].map((decodeIndex) =>
      new Uint8Array(catalog.copyChunk(RENDITION.id, UNIT.id, decodeIndex))
    );

    expect(new Set(batch.samples.map(({ data }) => data)).size).toBe(3);
    expect(batch.samples.map(({ data }) => new Uint8Array(data))).toEqual(expected);

    const transferred = structuredClone(batch.samples, {
      transfer: batch.samples.map(({ data }) => data)
    });
    expect(batch.samples.every(({ data }) => data.byteLength === 0)).toBe(true);
    expect(transferred.map(({ data }) => new Uint8Array(data))).toEqual(expected);
    expect([2, 3, 4].map((decodeIndex) => new Uint8Array(
      catalog.copyChunk(RENDITION.id, UNIT.id, decodeIndex)
    ))).toEqual(expected);
  });

  it("claims all group bytes before copying and releases the claim once", () => {
    const events: string[] = [];
    let activeBytes = 0;
    let releases = 0;
    const baseCatalog = createCatalog();
    const catalog: WorkerSampleCatalog = {
      ...baseCatalog,
      copyChunk(rendition, unit, decodeIndex) {
        events.push(`copy:${String(decodeIndex)}`);
        return baseCatalog.copyChunk(rendition, unit, decodeIndex);
      }
    };
    const resourceHost: WorkerSampleResourceHost = {
      claim(byteLength) {
        events.push(`claim:${String(byteLength)}`);
        activeBytes += byteLength;
        return {
          release() {
            activeBytes -= byteLength;
            releases += 1;
          }
        };
      }
    };
    const { factory } = createFixture({ catalog, resourceHost });
    const expectedBytes = payloadByteLength(0) + payloadByteLength(1);

    const batch = factory.createBatch({
      frames: [frame(UNIT.id, 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    });

    expect(events).toEqual([
      `claim:${String(expectedBytes)}`,
      "copy:0",
      "copy:1"
    ]);
    expect(activeBytes).toBe(expectedBytes);
    batch.release();
    batch.release();
    expect({ activeBytes, releases }).toEqual({ activeBytes: 0, releases: 1 });
  });

  it("releases a byte claim and preserves timeline state after a copy fails", () => {
    const baseCatalog = createCatalog();
    const copyChunk = vi.fn((
      rendition: string,
      unit: string,
      decodeIndex: number
    ) => {
      if (decodeIndex === 1) throw new Error("injected chunk-copy failure");
      return baseCatalog.copyChunk(rendition, unit, decodeIndex);
    });
    let activeClaims = 0;
    const { factory, timeline } = createFixture({
      catalog: { ...baseCatalog, copyChunk },
      resourceHost: {
        claim() {
          activeClaims += 1;
          return { release: () => { activeClaims -= 1; } };
        }
      }
    });
    const before = timeline.snapshot();

    expect(() => factory.createBatch({
      frames: [frame(UNIT.id, 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow("injected chunk-copy failure");

    expect(copyChunk).toHaveBeenCalledTimes(2);
    expect(activeClaims).toBe(0);
    expect(timeline.snapshot()).toEqual(before);
  });

  it("rejects partial groups, non-boundaries, unknown units, and out-of-range frames", () => {
    const baseCatalog = createCatalog();
    const copyChunk = vi.fn(baseCatalog.copyChunk.bind(baseCatalog));
    const { factory, timeline } = createFixture({
      catalog: { ...baseCatalog, copyChunk }
    });
    const before = timeline.snapshot();

    for (const frames of [
      [frame(UNIT.id, 1)],
      [frame(UNIT.id, 1), frame(UNIT.id, 2)],
      [frame(UNIT.id, 2)],
      [frame(UNIT.id, UNIT.frameCount)],
      [frame("missing", 0)]
    ]) {
      expect(() => factory.createBatch({
        frames,
        pendingSamples: 0,
        outstandingFrames: 0
      })).toThrow();
    }

    expect(copyChunk).not.toHaveBeenCalled();
    expect(timeline.snapshot()).toEqual(before);
  });

  it("charges pending chunks separately from displayed-frame credit", () => {
    const baseCatalog = createCatalog();
    const copyChunk = vi.fn(baseCatalog.copyChunk.bind(baseCatalog));
    const { factory, timeline } = createFixture({
      catalog: { ...baseCatalog, copyChunk }
    });
    const request = {
      frames: [frame(UNIT.id, 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    };
    const before = timeline.snapshot();

    expect(() => factory.createBatch({
      ...request,
      pendingSamples: LIMITS.maxPendingSamples - 1
    })).toThrow("pending sample limit");
    expect(() => factory.createBatch({
      ...request,
      outstandingFrames: LIMITS.maxOutstandingFrames
    })).toThrow("outstanding frame limit");
    expect(copyChunk).not.toHaveBeenCalled();
    expect(timeline.snapshot()).toEqual(before);

    expect(factory.createBatch({
      ...request,
      pendingSamples: LIMITS.maxPendingSamples - 2,
      outstandingFrames: LIMITS.maxOutstandingFrames - 1
    })).toMatchObject({
      samples: [{ decodeIndex: 0 }, { decodeIndex: 1 }],
      outputs: [{ unitFrame: 0 }]
    });
  });

  it("rejects a copied chunk with the wrong length before committing the timeline", () => {
    const baseCatalog = createCatalog();
    const copyChunk = vi.fn((
      rendition: string,
      unit: string,
      decodeIndex: number
    ) => decodeIndex === 1
      ? new ArrayBuffer(payloadByteLength(decodeIndex) - 1)
      : baseCatalog.copyChunk(rendition, unit, decodeIndex));
    const { factory, timeline } = createFixture({
      catalog: { ...baseCatalog, copyChunk }
    });
    const before = timeline.snapshot();

    expect(() => factory.createBatch({
      frames: [frame(UNIT.id, 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow("exact record length");
    expect(timeline.snapshot()).toEqual(before);
  });
});

function submission(
  decodeIndex: number,
  chunkType: EncodedVideoChunkType,
  presentationIndices: readonly number[],
  presentationTimestamp: number
): Readonly<VideoDecodeSubmissionMetadata> {
  return Object.freeze({
    decodeIndex,
    chunkType,
    presentationTimestamp,
    duration: presentationIndices.length === 0 ? 0 : FRAME_DURATION,
    displayedFrameCount: presentationIndices.length,
    presentationIndices: Object.freeze([...presentationIndices])
  });
}

function createCatalog(): WorkerSampleCatalog {
  const chunks = createChunks();
  return Object.freeze({
    renditions: Object.freeze({
      require(id: string) {
        if (id !== RENDITION.id) throw new RangeError("unknown rendition");
        return RENDITION;
      }
    }),
    units: Object.freeze({
      require(id: string) {
        if (id !== UNIT.id) throw new RangeError("unknown unit");
        return UNIT;
      }
    }),
    chunks: Object.freeze({
      require(rendition: string, unit: string, decodeIndex: number) {
        const chunk = rendition === RENDITION.id && unit === UNIT.id
          ? chunks[decodeIndex]
          : undefined;
        if (chunk === undefined) throw new RangeError("unknown chunk");
        return chunk;
      }
    }),
    copyChunk(rendition: string, unit: string, decodeIndex: number) {
      if (
        rendition !== RENDITION.id ||
        unit !== UNIT.id ||
        PAYLOADS[decodeIndex] === undefined
      ) {
        throw new RangeError("unknown chunk");
      }
      return Uint8Array.from(PAYLOADS[decodeIndex]!).buffer;
    }
  });
}

function createChunks(): readonly Readonly<RuntimeCatalogChunk>[] {
  let offset = 4_096;
  return Object.freeze(SUBMISSIONS.map((entry) => {
    const length = payloadByteLength(entry.decodeIndex);
    const range = Object.freeze({ offset, length });
    const chunk = Object.freeze({
      rendition: RENDITION.id,
      unit: UNIT.id,
      decodeIndex: entry.decodeIndex,
      ordinal: entry.decodeIndex,
      record: Object.freeze({
        byteOffset: offset,
        byteLength: length,
        presentationTimestamp: entry.presentationTimestamp,
        duration: entry.duration,
        randomAccess: entry.chunkType === "key",
        displayedFrameCount: entry.displayedFrameCount
      }),
      range
    } satisfies RuntimeCatalogChunk);
    offset += length;
    return chunk;
  }));
}

function createFixture(options: {
  readonly catalog?: WorkerSampleCatalog;
  readonly resourceHost?: WorkerSampleResourceHost;
} = {}): {
  readonly catalog: WorkerSampleCatalog;
  readonly timeline: DecodeTimeline;
  readonly factory: WorkerSampleFactory;
} {
  const catalog = options.catalog ?? createCatalog();
  const timeline = new DecodeTimeline({ numerator: 25, denominator: 1 });
  timeline.activateNextGeneration();
  return {
    catalog,
    timeline,
    factory: new WorkerSampleFactory({
      catalog,
      timeline,
      rendition: RENDITION.id,
      inspection: INSPECTION,
      limits: LIMITS,
      ...(options.resourceHost === undefined
        ? {}
        : { resourceHost: options.resourceHost })
    })
  };
}

function frame(unitId: string, unitFrame: number): WorkerSampleFrameRequest {
  return { unitId, unitFrame };
}

function payloadByteLength(decodeIndex: number): number {
  const payload = PAYLOADS[decodeIndex];
  if (payload === undefined) throw new RangeError("unknown test payload");
  return payload.length;
}

function sampleIdentity(sample: {
  readonly decodeIndex: number;
  readonly presentationIndices: readonly number[];
  readonly displayedFrameCount: number;
  readonly presentationTimestamp: number;
  readonly duration: number;
}): readonly [number, readonly number[], number, number, number] {
  return [
    sample.decodeIndex,
    sample.presentationIndices,
    sample.displayedFrameCount,
    sample.presentationTimestamp,
    sample.duration
  ];
}

function outputIdentity(output: {
  readonly ordinal: number;
  readonly unitFrame: number;
  readonly decodeIndex: number;
  readonly timestamp: number;
  readonly duration: number;
}): readonly [number, number, number, number, number] {
  return [
    output.ordinal,
    output.unitFrame,
    output.decodeIndex,
    output.timestamp,
    output.duration
  ];
}
