import type {
  GraphEdgeDefinition,
  GraphPresentation,
  MotionGraphResult,
  MotionGraphSnapshot
} from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import type { ManagedDecoderWorkerFrame } from "../decoder-worker/client.js";
import {
  BROWSER_PLAYBACK_TERMINAL_LISTENER
} from "./browser-playback-terminal-listener.js";
import type { CutResidentHandoff } from "./cut-presentation-coordinator.js";
import {
  BrowserVideoPlaybackSession,
  handoffBrowserVisibleEndpointToInverse
} from "./browser-video-playback-session.js";
import { BrowserVideoCandidateHub } from "./browser-video-candidate-hub.js";
import type { BrowserNormalReady } from "./browser-playback-types.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  VideoCandidateActivationInput,
  VideoCandidateReadinessSessionInput
} from "./video-candidate-factory.js";

describe("browser playback asynchronous terminal propagation", () => {
  it.each(["background", "resident"] as const)(
    "reports a %s decode failure without waiting for another host operation",
    async (failureSource) => {
      const fixture = await createTerminalFixture(failureSource);
      const observed: RuntimePlaybackError[] = [];
      fixture.session[BROWSER_PLAYBACK_TERMINAL_LISTENER]((error) => {
        observed.push(error);
      });

      fixture.session.drawInitial();
      fixture.session.synchronizeGraph(fixture.begin);
      if (failureSource === "resident") {
        const prepared = fixture.session.prepareContentTick({
          presentationOrdinal: 1n,
          rationalDeadlineUs: 33_333,
          graphSnapshot: fixture.begin.snapshot,
          previewTick: () => fixture.cutTick
        });
        if (prepared === null) throw new Error("resident cut was not prepared");
        fixture.session.drawContentTick(
          prepared,
          fixture.cutTick.presentation!
        );
        fixture.session.synchronizeGraph(fixture.cutTick);
      }

      await waitForTerminal(observed);

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ code: "worker-decode-failure" });
      expect(fixture.hub.snapshot().diagnostics).toContainEqual(
        observed[0]!.failure
      );

      await fixture.session.dispose();
      await expect(fixture.session.settled()).rejects.toBe(observed[0]);
    }
  );
});

describe("browser visible-endpoint inverse handoff", () => {
  it("materializes the resident inverse before releasing endpoint ownership", () => {
    const calls: string[] = [];
    const ready = inverseReady();
    const checkpoint = endpointCheckpoint();
    let inversePrepared = false;
    const resident = {
      visibleEndpoint: true,
      canEnterReversible(
        candidate: Readonly<GraphEdgeDefinition>,
        presentation: BodyPresentation
      ): boolean {
        calls.push("check-eligibility");
        expect(candidate).toBe(INVERSE_EDGE);
        expect(presentation).toBe(ENGAGED_BODY_ZERO);
        return true;
      },
      reversibleEntryReady(
        candidate: Readonly<GraphEdgeDefinition>,
        generation: number,
        ordinal: bigint
      ): Readonly<BrowserNormalReady> {
        calls.push("prepare-inverse");
        expect(candidate).toBe(INVERSE_EDGE);
        expect(generation).toBe(3);
        expect(ordinal).toBe(8n);
        inversePrepared = true;
        return ready;
      },
      takeResidentHandoff(): Readonly<CutResidentHandoff> {
        calls.push("take-checkpoint");
        return checkpoint;
      },
      retireCutAndSupersede(): boolean {
        calls.push("retire-endpoint");
        expect(inversePrepared).toBe(true);
        return true;
      }
    };

    const handoff = handoffBrowserVisibleEndpointToInverse({
      resident,
      edge: INVERSE_EDGE,
      presentation: ENGAGED_BODY_ZERO,
      generation: 3,
      ordinal: 8n
    });

    expect(calls).toEqual([
      "check-eligibility",
      "prepare-inverse",
      "take-checkpoint",
      "retire-endpoint"
    ]);
    expect(handoff).toEqual({ ready, checkpoint });
    if (handoff === null) throw new Error("eligible inverse was not handed off");
    expect(handoff.ready).toMatchObject({
      routeReady: true,
      media: {
        graphKind: "reversible",
        edge: "engaged.idle",
        drawSource: "resident",
        intendedPresentationOrdinal: 8n
      }
    });
  });

  it("keeps endpoint ownership until the authored portal is eligible", () => {
    const calls: string[] = [];
    const resident = {
      visibleEndpoint: true,
      canEnterReversible(
        candidate: Readonly<GraphEdgeDefinition>,
        presentation: BodyPresentation
      ): boolean {
        calls.push("check-eligibility");
        expect(candidate).toBe(INVERSE_EDGE);
        expect(presentation).toBe(ENGAGED_BODY_FOUR);
        return false;
      },
      reversibleEntryReady(): Readonly<BrowserNormalReady> {
        calls.push("prepare-inverse");
        return inverseReady();
      },
      takeResidentHandoff(): Readonly<CutResidentHandoff> {
        calls.push("take-checkpoint");
        return endpointCheckpoint();
      },
      retireCutAndSupersede(): boolean {
        calls.push("retire-endpoint");
        return true;
      }
    };

    const handoff = handoffBrowserVisibleEndpointToInverse({
      resident,
      edge: INVERSE_EDGE,
      presentation: ENGAGED_BODY_FOUR,
      generation: 3,
      ordinal: 8n
    });

    expect(handoff).toBeNull();
    expect(calls).toEqual(["check-eligibility"]);
  });
});

type BodyPresentation = Extract<
  GraphPresentation,
  { readonly kind: "body" }
>;

const ENGAGED_BODY_ZERO: BodyPresentation = Object.freeze({
  kind: "body",
  state: "engaged",
  unitId: "engaged.body",
  frameIndex: 0
});

const ENGAGED_BODY_FOUR: BodyPresentation = Object.freeze({
  ...ENGAGED_BODY_ZERO,
  frameIndex: 4
});

const INVERSE_EDGE: Readonly<GraphEdgeDefinition> = Object.freeze({
  id: "engaged.idle",
  from: "engaged",
  to: "idle",
  start: Object.freeze({
    type: "portal" as const,
    sourcePort: "default",
    targetPort: "default",
    maxWaitFrames: 1
  }),
  transition: Object.freeze({
    kind: "reversible" as const,
    unitId: "engage.shift",
    frameCount: 6,
    direction: "reverse" as const,
    reverseOf: "idle.engaged"
  }),
  continuity: "exact-reverse" as const
});

function inverseReady(): Readonly<BrowserNormalReady> {
  return Object.freeze({
    media: Object.freeze({
      kind: "frame" as const,
      graphKind: "reversible" as const,
      state: null,
      edge: INVERSE_EDGE.id,
      path: `reversible:${INVERSE_EDGE.id}`,
      frame: Object.freeze({
        rendition: "motion.1x",
        unit: "engage.shift",
        localFrame: 5
      }),
      drawSource: "resident" as const,
      generation: 3,
      unitInstance: 0,
      decodeOrdinal: 5,
      timestamp: 5,
      intendedPresentationOrdinal: 8n
    }),
    handle: Object.freeze({
      kind: "resident" as const,
      layer: 5,
      resourceGeneration: 1
    }),
    routeReady: true,
    purpose: "source" as const,
    schedulerReservation: false,
    heldPresentation: false,
    scheduler: null
  });
}

function endpointCheckpoint(): Readonly<CutResidentHandoff> {
  return Object.freeze({
    media: Object.freeze({
      kind: "frame" as const,
      graphKind: "body" as const,
      state: "engaged",
      edge: "idle.engaged",
      path: "endpoint:idle.engaged",
      frame: Object.freeze({
        rendition: "motion.1x",
        unit: "engaged.body",
        localFrame: 0
      }),
      drawSource: "resident" as const,
      generation: 3,
      unitInstance: 0,
      decodeOrdinal: 0,
      timestamp: 0,
      intendedPresentationOrdinal: 7n
    }),
    handle: Object.freeze({
      kind: "resident" as const,
      layer: 6,
      resourceGeneration: 1
    })
  });
}

type TerminalFailureSource = "background" | "resident";

async function createTerminalFixture(source: TerminalFailureSource) {
  const injected = new RuntimePlaybackError(normalizeRuntimeFailure(
    "worker-decode-failure",
    `injected ${source} decode failure`,
    { operation: `test-${source}` }
  ));
  const scheduler = new TerminalScheduler(source, injected);
  const renderer = new TerminalRenderer();
  const runtimeSignal = new AbortController();
  const candidate = {
    context: {
      candidate: { rendition: { id: "motion" } },
      catalog: {
        graph: {
          definition: {
            states: [
              { id: "idle", body: SOURCE_BODY },
              { id: "hover", body: TARGET_BODY }
            ],
            edges: [CUT_EDGE]
          }
        }
      }
    },
    renderer,
    interactionCache: {
      reversibleClips: [],
      cutRunways: [{
        edge: CUT_EDGE.id,
        state: "hover",
        port: "default",
        frames: CUT_FRAMES,
        layers: CUT_FRAMES.map((_frame, index) => index)
      }]
    }
  } as unknown as VideoCandidateReadinessSessionInput;
  const activationSnapshot = snapshot({
    readiness: "static",
    phase: "static",
    requestedState: "idle",
    visualState: "idle",
    presentation: SOURCE_PRESENTATION,
    pendingEdgeId: null,
    activeEdgeId: null
  });
  const beginSnapshot = snapshot({
    readiness: "animated",
    phase: "stable",
    requestedState: source === "resident" ? "hover" : "idle",
    visualState: "idle",
    presentation: SOURCE_PRESENTATION,
    pendingEdgeId: source === "resident" ? CUT_EDGE.id : null,
    activeEdgeId: null
  });
  const cutSnapshot = snapshot({
    readiness: "animated",
    phase: "stable",
    requestedState: "hover",
    visualState: "hover",
    presentation: TARGET_PRESENTATION,
    pendingEdgeId: null,
    activeEdgeId: null,
    contentOrdinal: 0n
  });
  const activation = {
    graphSnapshot: activationSnapshot,
    expectedPresentation: SOURCE_PRESENTATION,
    scheduler,
    finalResourcePlan: { ringCapacity: 3 },
    signal: runtimeSignal.signal,
    deadlineMs: 10_000
  } as unknown as VideoCandidateActivationInput;
  const hub = new BrowserVideoCandidateHub(
    { width: 1, height: 1 } as HTMLCanvasElement
  );
  const session = await BrowserVideoPlaybackSession.create({
    candidate,
    activation,
    hub
  });
  return {
    session,
    hub,
    begin: result("begin-animated", beginSnapshot, SOURCE_PRESENTATION),
    cutTick: result("tick", cutSnapshot, TARGET_PRESENTATION)
  };
}

function snapshot(input: {
  readonly readiness: "static" | "animated";
  readonly phase: "static" | "stable";
  readonly requestedState: string;
  readonly visualState: string;
  readonly presentation: Readonly<GraphPresentation>;
  readonly pendingEdgeId: string | null;
  readonly activeEdgeId: string | null;
  readonly contentOrdinal?: bigint | null;
}): Readonly<MotionGraphSnapshot> {
  return Object.freeze({
    readiness: input.readiness,
    phase: input.phase,
    requestedState: input.requestedState,
    visualState: input.visualState,
    presentation: input.presentation,
    pendingEdgeId: input.pendingEdgeId,
    activeEdgeId: input.activeEdgeId,
    followOnEdgeId: null,
    contentOrdinal: input.contentOrdinal ?? null
  }) as Readonly<MotionGraphSnapshot>;
}

function result(
  operation: "begin-animated" | "tick",
  graphSnapshot: Readonly<MotionGraphSnapshot>,
  presentation: Readonly<GraphPresentation>
): Readonly<MotionGraphResult> {
  return Object.freeze({
    operation,
    snapshot: graphSnapshot,
    presentation,
    effects: Object.freeze([])
  }) as Readonly<MotionGraphResult>;
}

async function waitForTerminal(errors: readonly RuntimePlaybackError[]) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (errors.length > 0) return;
    await Promise.resolve();
  }
  throw new Error("browser terminal listener was not called");
}

const SOURCE_BODY = Object.freeze({
  unitId: "idle.body",
  frameCount: 8
});

const TARGET_BODY = Object.freeze({
  unitId: "hover.body",
  frameCount: 8
});

const SOURCE_PRESENTATION = Object.freeze({
  kind: "body" as const,
  state: "idle",
  unitId: SOURCE_BODY.unitId,
  frameIndex: 0
});

const TARGET_PRESENTATION = Object.freeze({
  kind: "body" as const,
  state: "hover",
  unitId: TARGET_BODY.unitId,
  frameIndex: 0
});

const CUT_EDGE: Readonly<GraphEdgeDefinition> = Object.freeze({
  id: "idle.hover",
  from: "idle",
  to: "hover",
  start: Object.freeze({
    type: "cut" as const,
    targetPort: "default",
    maxWaitFrames: 1
  }),
  continuity: "cut" as const
});

const CUT_FRAMES = Object.freeze(Array.from({ length: 6 }, (_, index) =>
  Object.freeze({
    rendition: "motion",
    unit: TARGET_BODY.unitId,
    localFrame: index
  })
));

class TerminalScheduler {
  readonly #source: TerminalFailureSource;
  readonly #failure: RuntimePlaybackError;
  #pumpCalls = 0;
  #disposed = false;

  public constructor(
    source: TerminalFailureSource,
    failure: RuntimePlaybackError
  ) {
    this.#source = source;
    this.#failure = failure;
  }

  public async startBody(): Promise<void> {}

  public async pump(options: { readonly signal?: AbortSignal }) {
    this.#pumpCalls += 1;
    if (this.#pumpCalls === 1) return EMPTY_PUMP_REPORT;
    if (this.#source === "background") throw this.#failure;
    const signal = options.signal;
    if (signal === undefined) return EMPTY_PUMP_REPORT;
    if (signal.aborted) throw signal.reason;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    });
  }

  public reserveNext() {
    return Object.freeze({
      kind: "frame" as const,
      purpose: "source" as const,
      media: Object.freeze({
        kind: "frame" as const,
        graphKind: "body" as const,
        state: "idle",
        edge: null,
        path: "body:idle",
        frame: Object.freeze({
          rendition: "motion",
          unit: SOURCE_BODY.unitId,
          localFrame: 0
        }),
        drawSource: "streaming" as const,
        generation: 1,
        unitInstance: 0,
        decodeOrdinal: 0,
        timestamp: 0,
        intendedPresentationOrdinal: 0n
      }),
      frame: new TerminalFrame()
    });
  }

  public commitPreparedPresentation(): void {}
  public discardPreparedPresentation(): void {}
  public takeNext() {
    return Object.freeze({ kind: "underflow" as const });
  }

  public stageResidentRunway(input: {
    readonly edgeId: string;
    readonly targetState: string;
    readonly frames: readonly Readonly<{
      readonly frame: { readonly unit: string; readonly localFrame: number };
      readonly unitInstance: number;
      readonly decodeOrdinal: number;
      readonly timestamp: number;
    }>[];
    readonly path: string;
    readonly firstPresentationOrdinal?: bigint;
  }) {
    const firstOrdinal = input.firstPresentationOrdinal ?? 0n;
    return Object.freeze({
      generation: 2,
      path: input.path,
      edgeId: input.edgeId,
      targetState: input.targetState,
      media: Object.freeze(input.frames.map((value, index) => Object.freeze({
        kind: "frame" as const,
        graphKind: "body" as const,
        state: input.targetState,
        edge: input.edgeId,
        path: input.path,
        frame: value.frame,
        drawSource: "resident" as const,
        generation: 2,
        unitInstance: value.unitInstance,
        decodeOrdinal: value.decodeOrdinal,
        timestamp: value.timestamp,
        intendedPresentationOrdinal: firstOrdinal + BigInt(index)
      })))
    });
  }

  public commitResidentRunway() {
    return async (): Promise<void> => {
      if (this.#source === "resident") throw this.#failure;
    };
  }

  public rollbackResidentRunway(): void {}
  public commitResidentPresentation(): void {}
  public takeStreamingContinuation() {
    return Object.freeze({ kind: "underflow" as const });
  }

  public snapshot() {
    return Object.freeze({
      generation: 1,
      activePath: "body:idle",
      sourceCursor: null,
      submittedCursor: null,
      decodedCursor: null,
      displayedCursor: null,
      ringSize: 0,
      ringCapacity: 3,
      smoothSession: true,
      status: this.#disposed ? "disposed" as const : "active" as const,
      pendingEdge: null,
      expectedOutputs: 0,
      residentFrames: 0,
      discardedDependencyFrames: 0,
      staleFrames: 0,
      nextDecodeOrdinal: 0,
      submittedSource: null,
      displayedSource: null,
      unresolvedMaximumSubmitted: null
    });
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
  }
}

class TerminalRenderer {
  public readonly resourceGeneration = 1;
  #uploadSerial = 0;

  public residentHandle(layer: number) {
    return Object.freeze({
      kind: "resident" as const,
      layer,
      resourceGeneration: this.resourceGeneration
    });
  }

  public async uploadStreaming(
    slot: number,
    pathGeneration: number,
    frame: ManagedDecoderWorkerFrame
  ) {
    frame.close();
    this.#uploadSerial += 1;
    return Object.freeze({
      kind: "stream" as const,
      slot,
      pathGeneration,
      uploadSerial: this.#uploadSerial,
      resourceGeneration: this.resourceGeneration
    });
  }

  public draw(): void {}
}

class TerminalFrame implements ManagedDecoderWorkerFrame {
  public readonly frame = { close() {} } as unknown as VideoFrame;
  public readonly frameId = 1;
  public readonly generation = 1;
  public readonly ordinal = 0;
  public readonly unitId = SOURCE_BODY.unitId;
  public readonly unitInstance = 0;
  public readonly unitFrame = 0;
  public readonly decodeIndex = 0;
  public readonly timestamp = 0;
  public readonly duration = 33_333;
  public readonly decodedBytes = 16;
  #closed = false;

  public get closed(): boolean {
    return this.#closed;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.frame.close();
  }
}

const EMPTY_PUMP_REPORT = Object.freeze({
  submittedFrames: 0,
  decodedFrames: 0,
  discardedFrames: 0,
  staleFrames: 0,
  waits: 0,
  ringSize: 0,
  expectedOutputs: 0
});
