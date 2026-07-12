import { describe, expect, it } from "vitest";

import type { ManagedDecoderWorkerFrame } from "../decoder-worker/client.js";
import {
  PresentationRing,
  type PresentationRingExpectedFrame
} from "./presentation-ring.js";

describe("PresentationRing", () => {
  it.each([0, 5, 13, 100])("rejects invalid immutable capacity %s", (capacity) => {
    expect(() => new PresentationRing({
      capacity,
      generation: 1,
      path: "body"
    })).toThrow(RangeError);
  });

  it("drains the exact FIFO head to renderer ownership", () => {
    const ring = createRing();
    const first = makeOwned(0);
    const second = makeOwned(1);

    expect(ring.enqueue(makeInsertion(first))).toEqual({
      kind: "accepted",
      size: 1
    });
    expect(ring.enqueue(makeInsertion(second))).toEqual({
      kind: "accepted",
      size: 2
    });

    const result = ring.takeExpected(expected(0));
    expect(result.kind).toBe("frame");
    if (result.kind !== "frame") {
      throw new Error("expected a ring frame");
    }
    expect(result.entry.frame).toBe(first.frame);
    expect(first.frame.closed).toBe(false);
    expect(ring.snapshot()).toMatchObject({ size: 1, decodedBytes: 128 });

    result.entry.frame.close();
    result.entry.frame.close();
    expect(first.releaseCalls).toBe(1);
    expect(first.videoFrameCloseCalls).toBe(1);
  });

  it("reports an empty-ring underflow without inventing a frame", () => {
    const ring = createRing();

    const result = ring.takeExpected(expected(0));
    expect(result).toEqual({
      kind: "underflow",
      expected: expected(0)
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(ring.snapshot()).toMatchObject({ size: 0, underflows: 1 });
  });

  it("closes an incoming frame when the immutable capacity is full", () => {
    const ring = createRing();
    const frames = Array.from({ length: 7 }, (_, index) => makeOwned(index));
    for (const owned of frames.slice(0, 6)) {
      ring.enqueue(makeInsertion(owned));
    }

    expect(() => ring.enqueue(makeInsertion(frames[6]!))).toThrow(
      "capacity"
    );
    expect(frames[6]?.releaseCalls).toBe(1);
    expect(ring.snapshot()).toMatchObject({ size: 6, decodedBytes: 768 });

    ring.clear();
    expect(frames.every((owned) => owned.releaseCalls === 1)).toBe(true);
  });

  it("closes stale output immediately and never admits it", () => {
    const ring = createRing();
    ring.activatePath({ generation: 2, path: "replacement" });
    const stale = makeOwned(0);

    expect(ring.enqueue(makeInsertion(stale))).toEqual({
      kind: "stale",
      activeGeneration: 2,
      discardedGeneration: 1
    });
    expect(stale.releaseCalls).toBe(1);
    expect(ring.snapshot()).toMatchObject({
      generation: 2,
      activePath: "replacement",
      size: 0,
      staleFrames: 1
    });
  });

  it("rejects mismatched, duplicate, and out-of-order identities without leaking", () => {
    const ring = createRing();
    const first = makeOwned(0);
    ring.enqueue(makeInsertion(first));

    const mismatch = makeOwned(1, { unitFrame: 9 });
    expect(() => ring.enqueue({
      ...makeInsertion(mismatch),
      expected: expected(1)
    })).toThrow("did not match");
    expect(mismatch.releaseCalls).toBe(1);

    const duplicate = makeOwned(0, {}, 44);
    expect(() => ring.enqueue(makeInsertion(duplicate))).toThrow("duplicate");
    expect(duplicate.releaseCalls).toBe(1);

    const gap = makeOwned(2);
    expect(() => ring.enqueue(makeInsertion(gap))).toThrow("FIFO");
    expect(gap.releaseCalls).toBe(1);
    expect(ring.snapshot()).toMatchObject({ size: 1, decodedBytes: 128 });
  });

  it("validates the expected identity again when removing the head", () => {
    const ring = createRing();
    const first = makeOwned(0);
    ring.enqueue(makeInsertion(first));

    expect(() => ring.takeExpected(expected(1))).toThrow(
      "expected presentation"
    );
    expect(ring.snapshot().size).toBe(1);
    expect(first.releaseCalls).toBe(0);
    expect(ring.takeExpected(expected(0)).kind).toBe("frame");
  });

  it("activation closes the obsolete generation before accepting the newer path", () => {
    const ring = createRing();
    const oldFrames = [makeOwned(0), makeOwned(1)];
    for (const owned of oldFrames) {
      ring.enqueue(makeInsertion(owned));
    }

    expect(ring.activatePath({ generation: 2, path: "target" })).toEqual({
      closedFrames: 2,
      generation: 2,
      path: "target"
    });
    expect(oldFrames.every((owned) => owned.releaseCalls === 1)).toBe(true);

    const nextIdentity = expected(10, {
      generation: 2,
      path: "target",
      unitInstance: 0,
      unitFrame: 0
    });
    const next = makeOwned(10, nextIdentity);
    ring.enqueue(makeInsertion(next, nextIdentity));
    expect(ring.snapshot()).toMatchObject({ generation: 2, size: 1 });

    expect(() => ring.activatePath({ generation: 1, path: "old" })).toThrow(
      "increase"
    );
    ring.clear();
    expect(next.releaseCalls).toBe(1);
  });

  it("clear and dispose close every owned frame once and are idempotent", () => {
    const ring = createRing();
    const frames = [makeOwned(0), makeOwned(1), makeOwned(2)];
    for (const owned of frames) {
      ring.enqueue(makeInsertion(owned));
    }

    expect(ring.clear()).toEqual({ closedFrames: 3 });
    expect(ring.clear()).toEqual({ closedFrames: 0 });
    expect(frames.every((owned) => owned.releaseCalls === 1)).toBe(true);

    const final = makeOwned(3);
    ring.enqueue(makeInsertion(final));
    expect(ring.dispose()).toEqual({ closedFrames: 1 });
    expect(ring.dispose()).toEqual({ closedFrames: 0 });
    expect(final.releaseCalls).toBe(1);

    const afterDispose = makeOwned(4);
    expect(() => ring.enqueue(makeInsertion(afterDispose))).toThrow("disposed");
    expect(afterDispose.releaseCalls).toBe(1);
  });

  it("detects an externally closed ownership race without double release", () => {
    const ring = createRing();
    const owned = makeOwned(0);
    ring.enqueue(makeInsertion(owned));
    owned.frame.close();

    expect(() => ring.takeExpected(expected(0))).toThrow("already closed");
    expect(owned.releaseCalls).toBe(1);
    expect(ring.snapshot()).toMatchObject({ size: 0, decodedBytes: 0 });
    expect(ring.dispose()).toEqual({ closedFrames: 0 });
    expect(owned.releaseCalls).toBe(1);
  });
});

function createRing(): PresentationRing {
  return new PresentationRing({
    capacity: 6,
    generation: 1,
    path: "body"
  });
}

function expected(
  index: number,
  overrides: Partial<PresentationRingExpectedFrame> = {}
): PresentationRingExpectedFrame {
  return {
    generation: 1,
    path: "body",
    unitId: "body-unit",
    unitInstance: 0,
    unitFrame: index,
    decodeOrdinal: index,
    timestamp: index * 1_000,
    duration: 1_000,
    intendedPresentationOrdinal: BigInt(index),
    ...overrides
  };
}

function makeOwned(
  index: number,
  overrides: Partial<PresentationRingExpectedFrame> = {},
  frameId = index + 1
): FakeOwnedFrame {
  return new FakeOwnedFrame(expected(index, overrides), frameId);
}

function makeInsertion(
  owned: FakeOwnedFrame,
  identity: PresentationRingExpectedFrame = expected(owned.index)
) {
  return {
    expected: identity,
    frame: owned.frame,
    workerOutputTimeMs: identity.decodeOrdinal,
    uploadReadyTimeMs: null
  } as const;
}

class FakeOwnedFrame {
  public readonly index: number;
  public readonly frame: ManagedDecoderWorkerFrame;
  public releaseCalls = 0;
  public videoFrameCloseCalls = 0;
  #closed = false;

  public constructor(
    identity: PresentationRingExpectedFrame,
    frameId: number
  ) {
    this.index = identity.unitFrame;
    const videoFrame = {
      close: () => {
        this.videoFrameCloseCalls += 1;
      }
    } as unknown as VideoFrame;
    const owner = this;
    this.frame = {
      frame: videoFrame,
      frameId,
      generation: identity.generation,
      ordinal: identity.decodeOrdinal,
      unitId: identity.unitId,
      unitInstance: identity.unitInstance,
      unitFrame: identity.unitFrame,
      timestamp: identity.timestamp,
      duration: identity.duration,
      decodedBytes: 128,
      get closed() {
        return owner.#closed;
      },
      close() {
        if (owner.#closed) {
          return;
        }
        owner.#closed = true;
        videoFrame.close();
        owner.releaseCalls += 1;
      }
    };
  }
}
