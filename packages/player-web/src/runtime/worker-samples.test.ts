import { DECODER_WORKER_HARD_LIMITS } from "../decoder-worker/protocol.js";
import { describe, expect, it, vi } from "vitest";

import { installRuntimeAssetCatalog } from "./asset-catalog.js";
import { createOpaqueTestAsset } from "./asset-test-fixture.js";
import { DecodeTimeline } from "./decode-timeline.js";
import {
  WorkerSampleFactory,
  type WorkerSampleCatalog,
  type WorkerSampleFrameRequest
} from "./worker-samples.js";

const LIMITS = Object.freeze({
  maxDecodeQueueSize: 8,
  maxPendingSamples: 12,
  maxOutstandingFrames: 12,
  maxDecodedBytes: 12 * 64 * 64 * 4
});

describe("WorkerSampleFactory", () => {
  it("creates one closed batch across complete unit boundaries", () => {
    const fixture = createFixture();

    const batch = fixture.factory.createBatch({
      frames: [frame("body", 0), frame("body", 1), frame("intro", 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    });

    expect(batch.generation).toBe(1);
    expect(batch.samples.map((sample) => ({
      ordinal: sample.ordinal,
      unitId: sample.unitId,
      unitInstance: sample.unitInstance,
      unitFrame: sample.unitFrame,
      unitFrameCount: sample.unitFrameCount,
      type: sample.type,
      timestamp: sample.timestamp,
      duration: sample.duration
    }))).toEqual([
      {
        ordinal: 0,
        unitId: "body",
        unitInstance: 0,
        unitFrame: 0,
        unitFrameCount: 2,
        type: "key",
        timestamp: 0,
        duration: 33_333
      },
      {
        ordinal: 1,
        unitId: "body",
        unitInstance: 0,
        unitFrame: 1,
        unitFrameCount: 2,
        type: "delta",
        timestamp: 33_333,
        duration: 33_334
      },
      {
        ordinal: 2,
        unitId: "intro",
        unitInstance: 1,
        unitFrame: 0,
        unitFrameCount: 2,
        type: "key",
        timestamp: 66_667,
        duration: 33_333
      }
    ]);
    expect(Object.keys(batch)).toEqual(["generation", "samples"]);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.samples)).toBe(true);
    expect(batch.samples.every(Object.isFrozen)).toBe(true);
  });

  it("continues a split occurrence and crosses into a new loop instance", () => {
    const fixture = createFixture();

    const first = fixture.factory.createBatch({
      frames: [frame("body", 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    });
    const second = fixture.factory.createBatch({
      frames: [frame("body", 1), frame("body", 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    });

    expect(first.samples.map(identity)).toEqual([
      [0, "body", 0, 0]
    ]);
    expect(second.samples.map(identity)).toEqual([
      [1, "body", 0, 1],
      [2, "body", 1, 0]
    ]);
  });

  it("allocates one distinct exact-length buffer and preserves catalog bytes after transfer", () => {
    const fixture = createFixture();
    const expected = [0, 1].map((localFrame) =>
      new Uint8Array(fixture.catalog.copySample("opaque", "body", localFrame))
    );
    const batch = fixture.factory.createBatch({
      frames: [frame("body", 0), frame("body", 1)],
      pendingSamples: 0,
      outstandingFrames: 0
    });

    expect(new Set(batch.samples.map((sample) => sample.data)).size).toBe(2);
    for (let index = 0; index < batch.samples.length; index += 1) {
      const sample = batch.samples[index]!;
      expect(sample.data.byteLength).toBe(expected[index]?.byteLength);
      expect(new Uint8Array(sample.data)).toEqual(expected[index]);
    }

    const transferred = structuredClone(batch.samples, {
      transfer: batch.samples.map((sample) => sample.data)
    });
    expect(batch.samples.every((sample) => sample.data.byteLength === 0)).toBe(
      true
    );
    expect(transferred.map((sample) => new Uint8Array(sample.data))).toEqual(
      expected
    );
    expect(new Uint8Array(
      fixture.catalog.copySample("opaque", "body", 0)
    )).toEqual(expected[0]);
    expect(new Uint8Array(
      fixture.catalog.copySample("opaque", "body", 1)
    )).toEqual(expected[1]);
  });

  it("validates the complete batch before copying or advancing the timeline", () => {
    const fixture = createFixture();
    const copySample = vi.fn(fixture.catalog.copySample.bind(fixture.catalog));
    const factory = createFactory({
      ...catalogView(fixture.catalog),
      copySample
    }, fixture.timeline);
    const before = fixture.timeline.snapshot();

    expect(() => factory.createBatch({
      frames: [frame("body", 0), frame("missing", 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow();
    expect(copySample).not.toHaveBeenCalled();
    expect(fixture.timeline.snapshot()).toEqual(before);

    expect(() => factory.createBatch({
      frames: [frame("body", 1)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow("frame zero");
    expect(copySample).not.toHaveBeenCalled();
    expect(fixture.timeline.snapshot()).toEqual(before);
  });

  it("does not advance the timeline when a later payload allocation fails", () => {
    const fixture = createFixture();
    const copySample = vi.fn((
      rendition: string,
      unitId: string,
      localFrame: number
    ) => {
      if (localFrame === 1) {
        throw new RangeError("injected sample allocation failure");
      }
      return fixture.catalog.copySample(rendition, unitId, localFrame);
    });
    const factory = createFactory({
      ...catalogView(fixture.catalog),
      copySample
    }, fixture.timeline);
    const before = fixture.timeline.snapshot();

    expect(() => factory.createBatch({
      frames: [frame("body", 0), frame("body", 1)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow("injected sample allocation failure");
    expect(copySample).toHaveBeenCalledTimes(2);
    expect(fixture.timeline.snapshot()).toEqual(before);
  });

  it("enforces pending and outstanding credit before any payload copy", () => {
    const fixture = createFixture();
    const copySample = vi.fn(fixture.catalog.copySample.bind(fixture.catalog));
    const factory = createFactory({
      ...catalogView(fixture.catalog),
      copySample
    }, fixture.timeline);
    const frames = [frame("body", 0), frame("body", 1)];

    for (const input of [
      { frames, pendingSamples: 11, outstandingFrames: 0 },
      { frames, pendingSamples: 0, outstandingFrames: 11 },
      {
        frames: alternatingBodyFrames(13),
        pendingSamples: 0,
        outstandingFrames: 0
      }
    ]) {
      expect(() => factory.createBatch(input)).toThrow("limit");
    }
    expect(copySample).not.toHaveBeenCalled();
    expect(fixture.timeline.snapshot()).toMatchObject({ nextOrdinal: 0 });

    expect(factory.createBatch({
      frames,
      pendingSamples: 10,
      outstandingFrames: 10
    }).samples).toHaveLength(2);
  });

  it("rejects hostile record lengths before copying sample bytes", () => {
    const fixture = createFixture();
    const firstRecord = fixture.catalog.records.require("opaque", "body", 0);
    const copySample = vi.fn(fixture.catalog.copySample.bind(fixture.catalog));
    const hostile: WorkerSampleCatalog = {
      ...catalogView(fixture.catalog),
      records: {
        require() {
          return {
            ...firstRecord,
            range: {
              offset: firstRecord.range.offset,
              length: DECODER_WORKER_HARD_LIMITS.maxSampleBytes + 1
            },
            record: {
              ...firstRecord.record,
              payloadLength: DECODER_WORKER_HARD_LIMITS.maxSampleBytes + 1
            }
          };
        }
      },
      copySample
    };
    const factory = createFactory(hostile, fixture.timeline);

    expect(() => factory.createBatch({
      frames: [frame("body", 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow("sample byte length");
    expect(copySample).not.toHaveBeenCalled();
    expect(fixture.timeline.snapshot()).toMatchObject({ nextOrdinal: 0 });
  });

  it("resets occurrence identity but not ordinal or time on generation change", () => {
    const fixture = createFixture();
    const first = fixture.factory.createBatch({
      frames: [frame("body", 0), frame("body", 1)],
      pendingSamples: 0,
      outstandingFrames: 0
    });
    expect(fixture.timeline.activateNextGeneration()).toBe(2);
    const beforeBad = fixture.timeline.snapshot();

    expect(() => fixture.factory.createBatch({
      frames: [frame("body", 1)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow("frame zero");
    expect(fixture.timeline.snapshot()).toEqual(beforeBad);

    const second = fixture.factory.createBatch({
      frames: [frame("body", 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    });
    expect(second.generation).toBe(2);
    expect(second.samples.map(identity)).toEqual([[2, "body", 0, 0]]);
    expect(second.samples[0]?.timestamp).toBeGreaterThan(
      first.samples.at(-1)?.timestamp ?? Number.MAX_SAFE_INTEGER
    );
  });

  it("rejects a copied buffer whose runtime length differs from its record", () => {
    const fixture = createFixture();
    const factory = createFactory({
      ...catalogView(fixture.catalog),
      copySample: () => new ArrayBuffer(1)
    }, fixture.timeline);

    expect(() => factory.createBatch({
      frames: [frame("body", 0)],
      pendingSamples: 0,
      outstandingFrames: 0
    })).toThrow("exact record length");
    expect(fixture.timeline.snapshot()).toMatchObject({ nextOrdinal: 0 });
  });
});

function createFixture() {
  const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());
  const timeline = new DecodeTimeline(catalog.manifest.frameRate);
  timeline.activateNextGeneration();
  return {
    catalog,
    timeline,
    factory: createFactory(catalog, timeline)
  };
}

function createFactory(
  catalog: WorkerSampleCatalog,
  timeline: DecodeTimeline
): WorkerSampleFactory {
  return new WorkerSampleFactory({
    catalog,
    timeline,
    rendition: "opaque",
    limits: LIMITS
  });
}

function catalogView(
  catalog: ReturnType<typeof installRuntimeAssetCatalog>
): WorkerSampleCatalog {
  return {
    renditions: catalog.renditions,
    units: catalog.units,
    records: catalog.records,
    copySample: catalog.copySample.bind(catalog)
  };
}

function frame(unitId: string, unitFrame: number): WorkerSampleFrameRequest {
  return { unitId, unitFrame };
}

function alternatingBodyFrames(length: number): WorkerSampleFrameRequest[] {
  return Array.from({ length }, (_, index) => frame("body", index % 2));
}

function identity(sample: {
  readonly ordinal: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
}): readonly [number, string, number, number] {
  return [
    sample.ordinal,
    sample.unitId,
    sample.unitInstance,
    sample.unitFrame
  ];
}
