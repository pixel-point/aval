import { describe, expect, it } from "vitest";

import {
  ReversibleClipController,
  type ReversibleClipPresentation,
  type ReversibleClipTraceRecord
} from "./reversible-clip-controller.js";

type Endpoint = "resting" | "engaged" | "celebrate" | "share" | "forbidden";

describe("ReversibleClipController", () => {
  it("waits for the matching opaque portal before drawing the first clip frame", () => {
    const controller = createController();

    expect(controller.snapshot()).toMatchObject({
      phase: "stable",
      inTransition: false,
      requestedEndpoint: "resting",
      visualEndpoint: "resting",
      prospectiveEndpoint: "resting"
    });

    expect(controller.request("engaged")).toBe(1);
    const waiting = controller.tick();
    expect(waiting.presentation).toEqual({ kind: "stable", endpoint: "resting" });
    expect(waiting.snapshot).toMatchObject({
      phase: "waiting",
      direction: "forward",
      inTransition: true,
      requestedEndpoint: "engaged",
      visualEndpoint: "resting",
      prospectiveEndpoint: "engaged",
      clipFrameIndex: null
    });

    const wrongPortal = controller.tick({ portalEndpoint: "engaged" });
    expect(wrongPortal.presentation).toEqual({
      kind: "stable",
      endpoint: "resting"
    });
    expect(wrongPortal.snapshot.phase).toBe("waiting");

    const started = controller.tick({ portalEndpoint: "resting" });
    expect(started.presentation).toEqual({
      kind: "clip",
      frameIndex: 0,
      direction: "forward"
    });
    expect(started.snapshot).toMatchObject({
      phase: "clip",
      clipFrameIndex: 0,
      visualEndpoint: "resting",
      prospectiveEndpoint: "engaged"
    });
  });

  it("restores at the target endpoint and begins reverse from the last clip frame", () => {
    const controller = createController({
      initialEndpoint: "engaged",
      clipFrameCount: 5
    });

    expect(controller.snapshot()).toMatchObject({
      phase: "stable",
      inTransition: false,
      requestedEndpoint: "engaged",
      visualEndpoint: "engaged",
      prospectiveEndpoint: "engaged"
    });

    controller.request("resting");
    const started = controller.tick({ portalEndpoint: "engaged" });
    expect(started.presentation).toEqual(clip(4, "reverse"));
    expect(started.snapshot).toMatchObject({
      phase: "clip",
      direction: "reverse",
      requestedEndpoint: "resting",
      visualEndpoint: "engaged",
      prospectiveEndpoint: "resting",
      clipFrameIndex: 4
    });
  });

  it("cancels a pending transition without ever presenting the clip", () => {
    const controller = createController();
    controller.request("engaged");
    controller.tick();

    controller.request("resting");
    const cancelled = controller.tick({ portalEndpoint: "resting" });

    expect(cancelled.requests).toEqual([
      { sequence: 2, destination: "resting", outcome: "cancel" }
    ]);
    expect(cancelled.presentation).toEqual({
      kind: "stable",
      endpoint: "resting"
    });
    expect(cancelled.snapshot).toMatchObject({
      phase: "stable",
      inTransition: false,
      requestedEndpoint: "resting",
      visualEndpoint: "resting"
    });
    expect(
      controller.getTrace().some((record) => record.presentation.kind === "clip")
    ).toBe(false);
  });

  it("reverses from an interior frame to its adjacent predecessor on the next tick", () => {
    const controller = createController();
    startForward(controller);
    expect(controller.tick().presentation).toEqual(clip(1, "forward"));
    expect(controller.tick().presentation).toEqual(clip(2, "forward"));

    controller.request("resting");
    const reversed = controller.tick();

    expect(reversed.requests[0]).toMatchObject({ outcome: "reverse" });
    expect(reversed.presentation).toEqual(clip(1, "reverse"));
    expect(reversed.snapshot).toMatchObject({
      direction: "reverse",
      clipFrameIndex: 1,
      requestedEndpoint: "resting",
      visualEndpoint: "resting",
      prospectiveEndpoint: "resting"
    });
  });

  it("reverses forward frame zero directly into source runway zero", () => {
    const controller = createController();
    startForward(controller);

    controller.request("resting");
    const committed = controller.tick();

    expect(committed.presentation).toEqual(runway("resting", 0, "reverse"));
    expect(committed.snapshot).toMatchObject({
      phase: "runway",
      runwayFrameIndex: 0,
      visualEndpoint: "resting",
      prospectiveEndpoint: "resting"
    });
  });

  it("reverses at the forward last frame instead of committing the target", () => {
    const controller = createController({ clipFrameCount: 4 });
    startForward(controller);
    controller.tick();
    controller.tick();
    expect(controller.tick().presentation).toEqual(clip(3, "forward"));

    controller.request("resting");
    const reversed = controller.tick();

    expect(reversed.presentation).toEqual(clip(2, "reverse"));
    expect(reversed.snapshot.visualEndpoint).toBe("resting");
  });

  it("commits the visual endpoint exactly when target runway frame zero is presented", () => {
    const controller = createController({ clipFrameCount: 3 });
    startForward(controller);
    controller.tick();
    const lastClip = controller.tick();
    expect(lastClip.presentation).toEqual(clip(2, "forward"));
    expect(lastClip.snapshot.visualEndpoint).toBe("resting");

    const committed = controller.tick();
    expect(committed.presentation).toEqual(runway("engaged", 0, "forward"));
    expect(committed.before.visualEndpoint).toBe("resting");
    expect(committed.snapshot.visualEndpoint).toBe("engaged");
    expect(committed.snapshot.phase).toBe("runway");
  });

  it("starts reverse at the last frame and observes both reverse boundary rules", () => {
    const controller = createController({ clipFrameCount: 4 });
    settleAtTarget(controller);

    controller.request("resting");
    controller.tick();
    const reverseStart = controller.tick({ portalEndpoint: "engaged" });
    expect(reverseStart.presentation).toEqual(clip(3, "reverse"));

    controller.request("engaged");
    const lastFrameInverse = controller.tick();
    expect(lastFrameInverse.presentation).toEqual(
      runway("engaged", 0, "forward")
    );

    controller.request("resting");
    const restarted = controller.tick({ portalEndpoint: "engaged" });
    expect(restarted.presentation).toEqual(clip(3, "reverse"));
    expect(controller.tick().presentation).toEqual(clip(2, "reverse"));

    controller.request("engaged");
    const interiorInverse = controller.tick();
    expect(interiorInverse.presentation).toEqual(clip(3, "forward"));
  });

  it("handles a one-frame clip without repeating its sole clip frame", () => {
    const forward = createController({ clipFrameCount: 1 });
    startForward(forward);
    expect(forward.tick().presentation).toEqual(
      runway("engaged", 0, "forward")
    );

    const inverse = createController({ clipFrameCount: 1 });
    startForward(inverse);
    inverse.request("resting");
    expect(inverse.tick().presentation).toEqual(
      runway("resting", 0, "reverse")
    );

    for (const controller of [forward, inverse]) {
      expect(
        controller
          .getTrace()
          .filter((record) => record.presentation.kind === "clip")
      ).toHaveLength(1);
    }
  });

  it("coalesces ordered same-tick requests into the newest accepted direction", () => {
    const controller = createController();
    controller.request("engaged");
    controller.request("resting");
    controller.request("engaged");

    const started = controller.tick({ portalEndpoint: "resting" });
    expect(started.requests.map(({ outcome }) => outcome)).toEqual([
      "begin",
      "cancel",
      "begin"
    ]);
    expect(started.presentation).toEqual(clip(0, "forward"));

    controller.tick();
    controller.tick();
    controller.request("resting");
    controller.request("engaged");
    controller.request("resting");
    const coalesced = controller.tick();

    expect(coalesced.requests.map(({ outcome }) => outcome)).toEqual([
      "reverse",
      "reverse",
      "reverse"
    ]);
    expect(coalesced.presentation).toEqual(clip(1, "reverse"));
    expect(coalesced.snapshot.requestedEndpoint).toBe("resting");
  });

  it("treats duplicate prospective intent as continuation without restarting", () => {
    const controller = createController();
    startForward(controller);
    expect(controller.tick().presentation).toEqual(clip(1, "forward"));

    controller.request("engaged");
    controller.request("engaged");
    const continued = controller.tick();

    expect(continued.requests.map(({ outcome }) => outcome)).toEqual([
      "continue",
      "continue"
    ]);
    expect(continued.presentation).toEqual(clip(2, "forward"));
  });

  it("retains only a valid latest opaque follow-on and emits it at endpoint commit", () => {
    const controller = createController({
      clipFrameCount: 3,
      canFollow: (from, destination) =>
        from === "engaged" &&
        (destination === "celebrate" || destination === "share")
    });
    startForward(controller);

    const celebrateSequence = controller.request("celebrate");
    controller.request("forbidden");
    const pending = controller.tick();
    expect(pending.requests.map(({ outcome }) => outcome)).toEqual([
      "follow-on",
      "ignored"
    ]);
    expect(pending.snapshot).toMatchObject({
      requestedEndpoint: "celebrate",
      pendingFollowOn: "celebrate"
    });

    const shareSequence = controller.request("share");
    const replaced = controller.tick();
    expect(replaced.requests[0]?.outcome).toBe("follow-on");
    expect(replaced.snapshot.pendingFollowOn).toBe("share");
    expect(replaced.emittedFollowOn).toBeNull();

    const committed = controller.tick();
    expect(committed.presentation).toEqual(runway("engaged", 0, "forward"));
    expect(committed.emittedFollowOn).toEqual({
      sequence: shareSequence,
      fromEndpoint: "engaged",
      destination: "share"
    });
    expect(committed.emittedFollowOn?.sequence).not.toBe(celebrateSequence);
    expect(committed.snapshot).toMatchObject({
      visualEndpoint: "engaged",
      requestedEndpoint: "share",
      pendingFollowOn: null
    });
  });

  it("clears an obsolete follow-on when direct inverse intent changes the endpoint", () => {
    const controller = createController({
      canFollow: (from, destination) =>
        from === "engaged" && destination === "celebrate"
    });
    startForward(controller);
    controller.tick();

    controller.request("celebrate");
    controller.request("resting");
    const reversed = controller.tick();

    expect(reversed.requests.map(({ outcome }) => outcome)).toEqual([
      "follow-on",
      "reverse"
    ]);
    expect(reversed.snapshot).toMatchObject({
      direction: "reverse",
      requestedEndpoint: "resting",
      pendingFollowOn: null
    });

    while (controller.snapshot().phase === "clip") {
      expect(controller.tick().emittedFollowOn).toBeNull();
    }
  });

  it("presents every authored runway frame once before becoming stable", () => {
    const controller = createController({
      clipFrameCount: 1,
      targetRunwayFrameCount: 3
    });
    startForward(controller);

    expect(controller.tick().presentation).toEqual(
      runway("engaged", 0, "forward")
    );
    expect(controller.tick().presentation).toEqual(
      runway("engaged", 1, "forward")
    );
    expect(controller.tick().presentation).toEqual(
      runway("engaged", 2, "forward")
    );
    const stable = controller.tick();
    expect(stable.presentation).toEqual({ kind: "stable", endpoint: "engaged" });
    expect(stable.snapshot.inTransition).toBe(false);
  });

  it("returns deeply immutable snapshots, presentations, requests, tokens, and traces", () => {
    const controller = createController({
      clipFrameCount: 1,
      canFollow: (from, destination) =>
        from === "engaged" && destination === "celebrate"
    });
    startForward(controller);
    controller.request("celebrate");
    const committed = controller.tick();
    const trace = controller.getTrace();

    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.before)).toBe(true);
    expect(Object.isFrozen(committed.snapshot)).toBe(true);
    expect(Object.isFrozen(committed.presentation)).toBe(true);
    expect(Object.isFrozen(committed.requests)).toBe(true);
    expect(Object.isFrozen(committed.requests[0])).toBe(true);
    expect(Object.isFrozen(committed.emittedFollowOn)).toBe(true);
    expect(Object.isFrozen(trace)).toBe(true);
    expect(trace.every(Object.isFrozen)).toBe(true);

    expect(Reflect.set(committed.snapshot, "phase", "stable")).toBe(false);
    expect(committed.snapshot.phase).toBe("runway");
    expect(() =>
      (trace as ReversibleClipTraceRecord<Endpoint>[]).push(committed)
    ).toThrow(TypeError);
    expect(controller.getTrace()).toHaveLength(trace.length);
  });

  it("rejects ambiguous endpoints and non-positive or unsafe frame counts", () => {
    expect(
      () =>
        new ReversibleClipController({
          sourceEndpoint: "resting",
          targetEndpoint: "resting",
          clipFrameCount: 1,
          sourceRunwayFrameCount: 1,
          targetRunwayFrameCount: 1
        })
    ).toThrow("must differ");

    expect(() => createController({ initialEndpoint: "celebrate" })).toThrow(
      "initialEndpoint must be sourceEndpoint or targetEndpoint"
    );

    for (const clipFrameCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createController({ clipFrameCount })).toThrow(
        "clipFrameCount must be a positive safe integer"
      );
    }
  });

  it("survives a seeded 10,000-tick rapid-input schedule without invalid output", () => {
    const clipFrameCount = 12;
    const sourceRunwayFrameCount = 7;
    const targetRunwayFrameCount = 9;
    const controller = createController({
      clipFrameCount,
      sourceRunwayFrameCount,
      targetRunwayFrameCount,
      canFollow: (from, destination) =>
        (from === "engaged" && destination === "celebrate") ||
        (from === "resting" && destination === "share")
    });
    const random = mulberry32(0x5eedc0de);
    const destinations: readonly Endpoint[] = [
      "resting",
      "engaged",
      "celebrate",
      "share",
      "forbidden"
    ];
    const portals: readonly (Endpoint | undefined)[] = [
      undefined,
      "resting",
      "engaged",
      "forbidden"
    ];
    let previous: ReversibleClipTraceRecord<Endpoint> | null = null;
    let operationCount = 0;
    let expectedRequestSequence = 0;

    for (let tickIndex = 0; tickIndex < 10_000; tickIndex += 1) {
      const requestCount = Math.floor(random() * 4);
      for (let requestIndex = 0; requestIndex < requestCount; requestIndex += 1) {
        const destination = destinations[Math.floor(random() * destinations.length)]!;
        expectedRequestSequence += 1;
        expect(controller.request(destination)).toBe(expectedRequestSequence);
        operationCount += 1;
      }

      const portalEndpoint = portals[Math.floor(random() * portals.length)];
      const record = controller.tick(
        portalEndpoint === undefined ? {} : { portalEndpoint }
      );
      operationCount += 1;

      expect(record.tick).toBe(tickIndex + 1);
      expect(record.before.tick).toBe(tickIndex);
      expect(record.snapshot.tick).toBe(tickIndex + 1);
      expect(record.snapshot.pendingRequestCount).toBe(0);
      expect(["resting", "engaged"]).toContain(record.snapshot.visualEndpoint);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.requests)).toBe(true);

      assertPresentationBounds(
        record.presentation,
        clipFrameCount,
        sourceRunwayFrameCount,
        targetRunwayFrameCount
      );
      assertSnapshotShape(record);

      if (record.before.visualEndpoint !== record.snapshot.visualEndpoint) {
        expect(record.presentation).toEqual(
          runway(
            record.snapshot.visualEndpoint,
            0,
            record.snapshot.visualEndpoint === "engaged" ? "forward" : "reverse"
          )
        );
      }

      if (
        previous?.presentation.kind === "clip" &&
        record.presentation.kind === "clip"
      ) {
        expect(
          Math.abs(
            record.presentation.frameIndex - previous.presentation.frameIndex
          )
        ).toBe(1);
      }

      previous = record;
    }

    expect(operationCount).toBeGreaterThanOrEqual(10_000);
    const retainedTrace = controller.getTrace();
    expect(retainedTrace).toHaveLength(256);
    expect(retainedTrace[0]?.tick).toBe(9_745);
    expect(retainedTrace.at(-1)?.tick).toBe(10_000);
  });

  it("bounds and coalesces request bursts while preserving the newest intent", () => {
    const controller = createController();

    for (let index = 0; index < 40; index += 1) {
      controller.request(index === 39 ? "engaged" : "resting");
    }

    expect(controller.snapshot().pendingRequestCount).toBe(32);
    const tick = controller.tick({ portalEndpoint: "resting" });
    expect(tick.requests).toHaveLength(32);
    expect(tick.requests.at(-1)).toMatchObject({
      sequence: 40,
      destination: "engaged",
      outcome: "begin"
    });
    expect(tick.snapshot.requestedEndpoint).toBe("engaged");
  });
});

function createController(
  overrides: Partial<{
    initialEndpoint: Endpoint;
    clipFrameCount: number;
    sourceRunwayFrameCount: number;
    targetRunwayFrameCount: number;
    canFollow: (from: Endpoint, destination: Endpoint) => boolean;
  }> = {}
): ReversibleClipController<Endpoint> {
  return new ReversibleClipController<Endpoint>({
    sourceEndpoint: "resting",
    targetEndpoint: "engaged",
    clipFrameCount: 5,
    sourceRunwayFrameCount: 3,
    targetRunwayFrameCount: 3,
    ...overrides
  });
}

function startForward(controller: ReversibleClipController<Endpoint>): void {
  controller.request("engaged");
  expect(controller.tick({ portalEndpoint: "resting" }).presentation).toEqual(
    clip(0, "forward")
  );
}

function settleAtTarget(controller: ReversibleClipController<Endpoint>): void {
  startForward(controller);
  while (controller.snapshot().phase !== "stable") {
    controller.tick();
  }
  expect(controller.snapshot().visualEndpoint).toBe("engaged");
}

function clip(
  frameIndex: number,
  direction: "forward" | "reverse"
): ReversibleClipPresentation<Endpoint> {
  return { kind: "clip", frameIndex, direction };
}

function runway(
  endpoint: Endpoint,
  frameIndex: number,
  direction: "forward" | "reverse"
): ReversibleClipPresentation<Endpoint> {
  return { kind: "runway", endpoint, frameIndex, direction };
}

function assertPresentationBounds(
  presentation: ReversibleClipPresentation<Endpoint>,
  clipFrameCount: number,
  sourceRunwayFrameCount: number,
  targetRunwayFrameCount: number
): void {
  switch (presentation.kind) {
    case "stable":
      expect(["resting", "engaged"]).toContain(presentation.endpoint);
      break;
    case "clip":
      expect(presentation.frameIndex).toBeGreaterThanOrEqual(0);
      expect(presentation.frameIndex).toBeLessThan(clipFrameCount);
      break;
    case "runway": {
      const frameCount =
        presentation.endpoint === "resting"
          ? sourceRunwayFrameCount
          : targetRunwayFrameCount;
      expect(presentation.frameIndex).toBeGreaterThanOrEqual(0);
      expect(presentation.frameIndex).toBeLessThan(frameCount);
      break;
    }
  }
}

function assertSnapshotShape(record: ReversibleClipTraceRecord<Endpoint>): void {
  const snapshot = record.snapshot;
  expect(snapshot.inTransition).toBe(snapshot.phase !== "stable");
  switch (snapshot.phase) {
    case "stable":
      expect(snapshot.direction).toBeNull();
      expect(snapshot.clipFrameIndex).toBeNull();
      expect(snapshot.runwayFrameIndex).toBeNull();
      break;
    case "waiting":
      expect(snapshot.direction).not.toBeNull();
      expect(snapshot.clipFrameIndex).toBeNull();
      expect(snapshot.runwayFrameIndex).toBeNull();
      break;
    case "clip":
      expect(snapshot.direction).not.toBeNull();
      expect(snapshot.clipFrameIndex).not.toBeNull();
      expect(snapshot.runwayFrameIndex).toBeNull();
      expect(record.presentation.kind).toBe("clip");
      break;
    case "runway":
      expect(snapshot.direction).not.toBeNull();
      expect(snapshot.clipFrameIndex).toBeNull();
      expect(snapshot.runwayFrameIndex).not.toBeNull();
      expect(record.presentation.kind).toBe("runway");
      break;
  }
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
