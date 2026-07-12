import {
  MotionGraphEngine,
  type GraphPresentation,
  type MotionGraphResult,
  type MotionGraphSnapshot,
  type ValidatedMotionGraph
} from "@rendered-motion/graph";
import { describe, expect, it } from "vitest";

import { createIntegratedPathTestAsset } from "./asset-test-fixture.js";
import type { EffectHostEvent } from "./effect-host.js";
import {
  IntegratedPlayer,
  IntegratedPlaybackInvariantError,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedCandidateFactory,
  type IntegratedContentTickContext,
  type IntegratedPlaybackSession,
  type IntegratedPlaybackTraceState,
  type IntegratedPreparedContentTick,
  type IntegratedStaticSurfaceStore
} from "./integrated-player.js";
import type {
  RuntimeMediaCursor,
  RuntimeMediaPresentation,
  RuntimeSchedulerSnapshot
} from "./model.js";

describe("IntegratedPlayer content-path coordination", () => {
  it("draws intro into body zero and maintains a continuous loop seam", async () => {
    const harness = await createHarness();

    advance(harness, 6);

    expect(harness.session.initialDraws).toEqual(["intro:idle:intro:0"]);
    expect(contentTags(harness)).toEqual([
      "intro:idle:intro:1",
      "body:idle:idle-body:0",
      "body:idle:idle-body:1",
      "body:idle:idle-body:2",
      "body:idle:idle-body:3",
      "body:idle:idle-body:0"
    ]);
    expectTraceAgreement(harness);
  });

  it("uses the first ready portal or a later eligible portal without drift", async () => {
    const first = await createHarness();
    advance(first, 2);
    const firstRequest = trackedRequest(first, "hover");
    advance(first, 2, [true, true]);
    await settleMicrotasks();

    expect(contentTags(first).slice(-2)).toEqual([
      "body:idle:idle-body:1",
      "body:hover:hover-body:0"
    ]);
    expect(firstRequest.trace).toEqual(["resolve:hover"]);
    expect(drawBarrierTail(first)).toEqual([
      "effect:transitionstart",
      "draw:body:hover:hover-body:0",
      "effect:visualstatechange",
      "effect:transitionend",
      "promise:resolve:hover"
    ]);
    expectTraceAgreement(first);

    const later = await createHarness();
    advance(later, 2);
    const laterRequest = trackedRequest(later, "hover");
    advance(later, 4, [false, false, true, true]);
    await settleMicrotasks();

    expect(contentTags(later).slice(-4)).toEqual([
      "body:idle:idle-body:1",
      "body:idle:idle-body:2",
      "body:idle:idle-body:3",
      "body:hover:hover-body:0"
    ]);
    expect(laterRequest.trace).toEqual(["resolve:hover"]);
    expectTraceAgreement(later);
  });

  it("waits at finite and held boundaries until exact media is ready", async () => {
    const finite = await createHarness();
    await enterState(finite, "archive");
    const finiteRequest = trackedRequest(finite, "idle");
    advance(finite, 4, [true, false, false, true]);
    await settleMicrotasks();

    expect(contentTags(finite).slice(-4)).toEqual([
      "body:archive:archive-body:1",
      "body:archive:archive-body:2",
      "body:archive:archive-body:2",
      "body:idle:idle-body:0"
    ]);
    expect(finiteRequest.trace).toEqual(["resolve:idle"]);
    expectTraceAgreement(finite);

    const held = await createHarness();
    await enterState(held, "loading");
    advance(held, 3);
    expect(lastContentTag(held)).toBe("body:done:done-body:0");
    const heldRequest = trackedRequest(held, "idle");
    advance(held, 2, [false, true]);
    await settleMicrotasks();

    expect(contentTags(held).slice(-2)).toEqual([
      "body:done:done-body:0",
      "body:idle:idle-body:0"
    ]);
    expect(heldRequest.trace).toEqual(["resolve:idle"]);
    expectTraceAgreement(held);
  });

  it.each([0, 1, 2])(
    "finishes a finite body from phase %i",
    async (phase) => {
      const harness = await createHarness();
      await enterState(harness, "archive");
      advance(harness, phase);
      const request = trackedRequest(harness, "success");
      for (let index = phase; index < 3; index += 1) advance(harness, 1);
      await settleMicrotasks();

      expect(lastContentTag(harness)).toBe("body:success:success-body:0");
      expect(request.trace).toEqual(["resolve:success"]);
      expectTraceAgreement(harness);
    }
  );

  it("draws transitionless target zero and every one/long bridge frame", async () => {
    const transitionless = await createHarness();
    advance(transitionless, 2);
    const hover = trackedRequest(transitionless, "hover");
    advance(transitionless, 2);
    await settleMicrotasks();
    expect(lastContentTag(transitionless)).toBe(
      "body:hover:hover-body:0"
    );
    expect(hover.trace).toEqual(["resolve:hover"]);
    expectTraceAgreement(transitionless);

    const one = await createHarness();
    await enterState(one, "loading");
    expect(contentTags(one).slice(-2)).toEqual([
      "locked:idle-loading:one-bridge:0",
      "body:loading:loading-body:0"
    ]);
    expectTraceAgreement(one);

    const long = await createHarness();
    await enterState(long, "archive");
    expect(contentTags(long).slice(-6)).toEqual([
      "locked:idle-archive:long-bridge:0",
      "locked:idle-archive:long-bridge:1",
      "locked:idle-archive:long-bridge:2",
      "locked:idle-archive:long-bridge:3",
      "locked:idle-archive:long-bridge:4",
      "body:archive:archive-body:0"
    ]);
    expectTraceAgreement(long);
  });

  it("executes completion routing and a latest locked follow-on", async () => {
    const completion = await createHarness();
    await enterState(completion, "loading");
    advance(completion, 3);
    expect(contentTags(completion).slice(-3)).toEqual([
      "body:loading:loading-body:1",
      "body:loading:loading-body:2",
      "body:done:done-body:0"
    ]);
    expect(completion.events.filter(({ type }) =>
      type === "requestedstatechange"
    ).at(-1)).toMatchObject({ type: "requestedstatechange", to: "done" });
    expectTraceAgreement(completion);

    const followOn = await createHarness();
    advance(followOn, 2);
    const loading = trackedRequest(followOn, "loading");
    advance(followOn, 2);
    expect(lastContentTag(followOn)).toBe("locked:idle-loading:one-bridge:0");
    const success = trackedRequest(followOn, "success");
    advance(followOn, 2);
    await settleMicrotasks();

    expect(contentTags(followOn).slice(-3)).toEqual([
      "locked:idle-loading:one-bridge:0",
      "body:loading:loading-body:0",
      "body:success:success-body:0"
    ]);
    expect(loading.trace).toEqual(["reject:loading:AbortError"]);
    expect(success.trace).toEqual(["resolve:success"]);
    expectTraceAgreement(followOn);
  });

  it("coalesces rapid pending replacements to the latest prepared path", async () => {
    const harness = await createHarness();
    advance(harness, 2);
    const hover = trackedRequest(harness, "hover");
    const archive = trackedRequest(harness, "archive");
    advance(harness, 7);
    await settleMicrotasks();

    expect(hover.trace).toEqual(["reject:hover:AbortError"]);
    expect(archive.trace).toEqual(["resolve:archive"]);
    expect(contentTags(harness).some((tag) => tag.includes("hover"))).toBe(false);
    expect(lastContentTag(harness)).toBe("body:archive:archive-body:0");
    expectTraceAgreement(harness);
  });

  it("does not tick or draw when exact media is unavailable", async () => {
    const harness = await createHarness();
    harness.session.available = false;

    expect(harness.player.tryContentTick(tickContext(harness))).toEqual({
      status: "underflow"
    });
    expect(harness.player.snapshot().visualState).toBe("idle");
    expect(harness.session.draws).toEqual([]);
    expect(harness.player.getTrace().at(-1)).toMatchObject({
      kind: "content-tick",
      graph: null,
      media: null
    });
  });

  it("queues an interactive-ready listener request until activation commits", async () => {
    let nested: Promise<void> | null = null;
    const harness = await createHarness((event, player) => {
      if (
        event.type === "readinesschange" &&
        event.to === "interactiveReady" &&
        nested === null
      ) nested = player.requestState("hover");
    });

    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "hover",
      visualState: "idle"
    });
    advance(harness, 5);
    await settleMicrotasks();
    await expect(nested).resolves.toBeUndefined();
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      visualState: "hover"
    });
    expect(harness.events.some(({ type }) => type === "fallback")).toBe(false);
    expectTraceAgreement(harness);
  });

  it("queues a visual-state listener request behind the complete draw barrier", async () => {
    let nested: Promise<void> | null = null;
    const harness = await createHarness((event, player) => {
      if (
        event.type === "visualstatechange" &&
        event.to === "hover" &&
        nested === null
      ) nested = player.requestState("idle");
    });
    advance(harness, 2);
    const hover = trackedRequest(harness, "hover");
    advance(harness, 2);
    await settleMicrotasks();

    expect(nested).not.toBeNull();
    expect(harness.player.snapshot().requestedState).toBe("idle");
    advance(harness, 3);
    await settleMicrotasks();
    await expect(hover.promise).resolves.toBeUndefined();
    await expect(nested).resolves.toBeUndefined();
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    expect(harness.events.some(({ type }) => type === "fallback")).toBe(false);
    expectTraceAgreement(harness);
  });

  it("queues a transition-start listener request behind playback synchronization", async () => {
    let nested: Promise<void> | null = null;
    const harness = await createHarness((event, player) => {
      if (
        event.type === "transitionstart" &&
        event.to === "hover" &&
        nested === null
      ) nested = player.requestState("idle");
    });
    advance(harness, 2);
    const hover = trackedRequest(harness, "hover");
    advance(harness, 2);
    await settleMicrotasks();

    expect(nested).not.toBeNull();
    advance(harness, 3);
    await settleMicrotasks();
    await expect(hover.promise).resolves.toBeUndefined();
    await expect(nested).resolves.toBeUndefined();
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    expect(harness.events.some(({ type }) => type === "fallback")).toBe(false);
    expectTraceAgreement(harness);
  });

  it("refuses a nested manual tick without interrupting the outer draw", async () => {
    let harness!: PathHarness;
    let nestedError: unknown = null;
    harness = await createHarness((event, player) => {
      if (event.type !== "transitionstart" || nestedError !== null) return;
      try {
        player.tryContentTick({
          presentationOrdinal: harness.nextPresentationOrdinal + 1n,
          rationalDeadlineUs:
            Number(harness.nextPresentationOrdinal + 1n) * 33_333
        });
      } catch (error) {
        nestedError = error;
      }
    });
    advance(harness, 2);
    const hover = trackedRequest(harness, "hover");

    expect(() => advance(harness, 2)).not.toThrow();
    await settleMicrotasks();
    await expect(hover.promise).resolves.toBeUndefined();
    expect(nestedError).toBeInstanceOf(IntegratedPlaybackInvariantError);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
    expect(harness.events.some(({ type }) => type === "fallback")).toBe(false);
    expectTraceAgreement(harness);
  });
});

interface PathHarness {
  readonly player: IntegratedPlayer;
  readonly factory: PathCandidateFactory;
  readonly session: FakePlaybackSession;
  readonly events: Readonly<EffectHostEvent>[];
  readonly order: string[];
  nextPresentationOrdinal: bigint;
}

async function createHarness(
  onEvent?: (event: Readonly<EffectHostEvent>, player: IntegratedPlayer) => void
): Promise<PathHarness> {
  const order: string[] = [];
  const factory = new PathCandidateFactory(order);
  const events: Readonly<EffectHostEvent>[] = [];
  let player!: IntegratedPlayer;
  player = new IntegratedPlayer({
    bytes: createIntegratedPathTestAsset(),
    createStaticStore: () => new ImmediateStaticStore(),
    candidateFactory: factory,
    eventSink(event) {
      events.push(event);
      order.push(`effect:${event.type}`);
      if (player !== undefined) onEvent?.(event, player);
    },
    timers: new IdleTimers()
  });
  const prepared = await player.prepare();
  expect(prepared.mode, JSON.stringify(prepared)).toBe("animated");
  const session = factory.session;
  return {
    player,
    factory,
    session,
    events,
    order,
    nextPresentationOrdinal: 1n
  };
}

function advance(
  harness: PathHarness,
  count: number,
  routeReady: readonly boolean[] = []
): void {
  harness.session.routeReady.push(...routeReady);
  for (let index = 0; index < count; index += 1) {
    const result = harness.player.tryContentTick(tickContext(harness));
    expect(result.status).toBe("advanced");
    harness.nextPresentationOrdinal += 1n;
  }
}

function tickContext(harness: PathHarness): IntegratedContentTickContext {
  return {
    presentationOrdinal: harness.nextPresentationOrdinal,
    rationalDeadlineUs: Number(harness.nextPresentationOrdinal) * 33_333
  };
}

async function enterState(
  harness: PathHarness,
  state: "loading" | "archive"
): Promise<void> {
  advance(harness, 2);
  const request = trackedRequest(harness, state);
  advance(harness, state === "loading" ? 3 : 7);
  await settleMicrotasks();
  expect(lastContentTag(harness)).toBe(`body:${state}:${state}-body:0`);
  expect(request.trace).toEqual([`resolve:${state}`]);
}

function trackedRequest(harness: PathHarness, state: string) {
  const trace: string[] = [];
  const promise = harness.player.requestState(state);
  void promise.then(
    () => {
      trace.push(`resolve:${state}`);
      harness.order.push(`promise:resolve:${state}`);
    },
    (error: unknown) => {
      const name = error instanceof Error ? error.name : "unknown";
      trace.push(`reject:${state}:${name}`);
      harness.order.push(`promise:reject:${state}:${name}`);
    }
  );
  return { promise, trace };
}

function contentTags(harness: PathHarness): string[] {
  return harness.player.getTrace()
    .filter((record) => record.kind === "content-tick" && record.graph !== null)
    .map((record) => presentationTag(record.graph!.presentation!));
}

function lastContentTag(harness: PathHarness): string {
  const tag = contentTags(harness).at(-1);
  if (tag === undefined) throw new Error("path harness has no content tick");
  return tag;
}

function drawBarrierTail(harness: PathHarness): string[] {
  const start = harness.order.findLastIndex((entry) =>
    entry === "effect:transitionstart"
  );
  return harness.order.slice(start);
}

function expectTraceAgreement(harness: PathHarness): void {
  const records = harness.player.getTrace().filter((record) =>
    record.kind === "content-tick" && record.graph !== null
  );
  const graph = records.map((record) =>
    presentationTag(record.graph!.presentation!)
  );
  const output = records.map((record) => mediaTag(record.media!));
  expect(output).toEqual(graph);
  expect(harness.session.submissions).toEqual(graph);
  expect(harness.session.outputs).toEqual(graph);
  expect(harness.session.draws).toEqual(graph);
  for (const record of records) {
    expect(record.media?.kind).toBe("frame");
    if (record.media?.kind === "frame") {
      expect(record.media.intendedPresentationOrdinal).toBe(
        record.presentationOrdinal
      );
    }
    expect(record.graph?.snapshot.contentOrdinal).toBe(
      record.presentationOrdinal! - 1n
    );
  }
}

function presentationTag(presentation: Readonly<GraphPresentation>): string {
  switch (presentation.kind) {
    case "static":
      return `static:${presentation.state}:${presentation.staticFrameId}`;
    case "intro":
    case "body":
      return `${presentation.kind}:${presentation.state}:${presentation.unitId}:${String(presentation.frameIndex)}`;
    case "locked":
    case "reversible":
      return `${presentation.kind}:${presentation.edgeId}:${presentation.unitId}:${String(presentation.frameIndex)}`;
  }
}

function mediaTag(media: Readonly<RuntimeMediaPresentation>): string {
  if (media.kind === "static") {
    return `static:${media.state}:${media.staticFrame}`;
  }
  const owner = media.state ?? media.edge;
  return `${media.graphKind}:${owner}:${media.frame.unit}:${String(media.frame.localFrame)}`;
}

class PathCandidateFactory implements IntegratedCandidateFactory {
  readonly #order: string[];
  #session: FakePlaybackSession | null = null;

  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });

  public constructor(order: string[]) {
    this.#order = order;
  }

  public get session(): FakePlaybackSession {
    if (this.#session === null) throw new Error("candidate was not created");
    return this.#session;
  }

  public create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): IntegratedCandidateAttempt {
    const session = new FakePlaybackSession(
      context.catalog.graph,
      context.candidate.rendition.id,
      this.#order
    );
    this.#session = session;
    return {
      playback: session,
      prepare: async () => undefined,
      prepareActivation: async ({ expectedPresentation }) =>
        Object.freeze({ expectedPresentation }),
      drawInitial: (_activation, presentation) => {
        session.initialDraws.push(presentationTag(presentation));
      },
      dispose: () => undefined
    };
  }
}

class FakePlaybackSession implements IntegratedPlaybackSession {
  public readonly routeReady: boolean[] = [];
  public readonly initialDraws: string[] = [];
  public readonly submissions: string[] = [];
  public readonly outputs: string[] = [];
  public readonly draws: string[] = [];
  public available = true;

  readonly #mirror = new MotionGraphEngine();
  readonly #rendition: string;
  readonly #order: string[];
  #predicted: Readonly<MotionGraphResult> | null = null;
  #lastCursor: Readonly<RuntimeMediaCursor> | null = null;
  #lastMedia: Readonly<RuntimeMediaPresentation> | null = null;

  public constructor(
    graph: Readonly<ValidatedMotionGraph>,
    rendition: string,
    order: string[]
  ) {
    this.#mirror.install(graph);
    this.#rendition = rendition;
    this.#order = order;
  }

  public synchronizeGraph(result: Readonly<MotionGraphResult>): void {
    let mirrored: Readonly<MotionGraphResult>;
    if (result.operation === "begin-animated") {
      mirrored = this.#mirror.beginAnimated();
    } else if (result.operation === "request") {
      const target = result.snapshot.requestedState;
      if (target === null) throw new Error("request has no graph target");
      mirrored = this.#mirror.request(target);
    } else if (result.operation === "tick") {
      mirrored = this.#predicted ?? fail("tick was not predicted");
      this.#predicted = null;
    } else if (result.operation === "dispose") {
      mirrored = this.#mirror.dispose();
    } else {
      return;
    }
    expect(result.presentation).toEqual(mirrored.presentation);
    expect(result.effects).toEqual(mirrored.effects);
    expect(result.snapshot).toEqual(mirrored.snapshot);
  }

  public prepareContentTick(input: {
    readonly presentationOrdinal: bigint;
    readonly rationalDeadlineUs: number | null;
    readonly graphSnapshot: Readonly<MotionGraphSnapshot>;
  }): Readonly<IntegratedPreparedContentTick> | null {
    if (!this.available) return null;
    if (this.#predicted !== null) throw new Error("tick prediction is still live");
    expect(input.graphSnapshot).toEqual(this.#mirror.snapshot());
    const routeReady = this.routeReady.shift() ?? true;
    const predicted = this.#mirror.tick({
      contentOrdinal: input.presentationOrdinal - 1n,
      routeReady
    });
    const presentation = predicted.presentation ?? fail("tick has no presentation");
    if (presentation.kind === "static") {
      throw new Error("animated tick predicted a static presentation");
    }
    const media = mediaFor(
      presentation,
      this.#rendition,
      input.presentationOrdinal
    );
    const tag = presentationTag(presentation);
    this.submissions.push(tag);
    this.outputs.push(tag);
    this.#predicted = predicted;
    this.#lastMedia = media;
    this.#lastCursor = media.kind === "frame"
      ? Object.freeze({
          path: media.path,
          unit: media.frame.unit,
          unitInstance: media.unitInstance,
          localFrame: media.frame.localFrame
        })
      : null;
    return Object.freeze({
      routeReady,
      selectedBoundary: routeReady ? `${tag}@ready` : null,
      scheduler: schedulerSnapshot(this.#lastCursor),
      submitted: this.#lastCursor === null
        ? Object.freeze([])
        : Object.freeze([this.#lastCursor]),
      media,
      decodeLeadFrames: 6
    });
  }

  public drawContentTick(
    prepared: Readonly<IntegratedPreparedContentTick>,
    presentation: Readonly<GraphPresentation>
  ): string {
    expect(prepared.media).toBe(this.#lastMedia);
    const tag = presentationTag(presentation);
    this.draws.push(tag);
    this.#order.push(`draw:${tag}`);
    return `readback:${tag}`;
  }

  public traceState(): Readonly<IntegratedPlaybackTraceState> {
    return Object.freeze({
      selectedBoundary: null,
      scheduler: schedulerSnapshot(this.#lastCursor),
      submitted: Object.freeze([]),
      decodeLeadFrames: 6
    });
  }
}

function mediaFor(
  presentation: Exclude<Readonly<GraphPresentation>, { readonly kind: "static" }>,
  rendition: string,
  ordinal: bigint
): Readonly<RuntimeMediaPresentation> {
  const state = presentation.kind === "body" || presentation.kind === "intro"
    ? presentation.state
    : null;
  const edge = presentation.kind === "locked" || presentation.kind === "reversible"
    ? presentation.edgeId
    : null;
  return Object.freeze({
    kind: "frame",
    graphKind: presentation.kind,
    state,
    edge,
    path: `path:${state ?? edge}`,
    frame: Object.freeze({
      rendition,
      unit: presentation.unitId,
      localFrame: presentation.frameIndex
    }),
    drawSource: presentation.kind === "reversible" ? "resident" : "streaming",
    generation: 1,
    unitInstance: Number(ordinal),
    decodeOrdinal: Number(ordinal),
    timestamp: Number(ordinal) * 33_333,
    intendedPresentationOrdinal: ordinal
  });
}

function schedulerSnapshot(
  cursor: Readonly<RuntimeMediaCursor> | null
): Readonly<RuntimeSchedulerSnapshot> {
  return Object.freeze({
    generation: 1,
    activePath: cursor?.path ?? "path:initial",
    sourceCursor: cursor,
    submittedCursor: cursor,
    decodedCursor: cursor,
    displayedCursor: cursor,
    ringSize: 6,
    ringCapacity: 6,
    smoothSession: true
  });
}

class ImmediateStaticStore implements IntegratedStaticSurfaceStore {
  public async installInitial(): Promise<void> {}
  public async validateAll(): Promise<void> {}
  public async presentState(): Promise<void> {}
  public coverCurrent(): void {}
  public revealAnimated(): void {}
  public async settled(): Promise<void> {}
  public dispose(): void {}
}

class IdleTimers {
  #next = 1;
  public readonly setTimeout = (_callback: () => void, _ms: number): number =>
    this.#next++;
  public readonly clearTimeout = (_handle: number): void => undefined;
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fail(message: string): never {
  throw new Error(message);
}
