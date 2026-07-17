import type { Manifest, Unit } from "./asset.js";
import type { MotionGraphSnapshot } from "@pixel-point/aval-graph";

export const MAX_ROUTE_PREFETCH_INTENTS = 4;
const CANDIDATE_READY_FRAMES = 6;

export type PrefetchReason =
  | "active-target"
  | "pending-route"
  | "follow-on-route"
  | "intro-body"
  | "presentation-continuation"
  | "completion"
  | "loop";

export interface ActiveMediaRef {
  readonly unitId: string;
  readonly mode: "stream" | "resident";
}

export interface PrefetchIntent {
  readonly unit: Unit;
  readonly reason: PrefetchReason;
}

export interface RoutePrefetchPlan {
  readonly decode: readonly Readonly<PrefetchIntent>[];
  readonly resident: readonly Unit[];
}

export interface PrefetchableRun {
  ready(): Promise<void>;
  close(): void;
}

export interface RoutePrefetchClaim<Run> {
  readonly ready: Promise<Run>;
  cancel(): void;
}

export interface RoutePrefetchOperations<Run extends PrefetchableRun> {
  readonly signal: AbortSignal;
  readonly preload: (unit: Unit, signal: AbortSignal) => Promise<void>;
  readonly admit: (unit: Unit) => Run;
  readonly canAdmit?: () => boolean;
  readonly onFailure: (error: unknown) => void;
}

type EntryState<Run> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "loaded" }>
  | Readonly<{ kind: "admitted"; run: Run }>
  | Readonly<{ kind: "ready"; run: Run }>;

interface Entry<Run> {
  intent: Readonly<PrefetchIntent>;
  readonly controller: AbortController;
  readonly loaded: Promise<void>;
  admission: Promise<Run> | null;
  ready: Promise<Run> | null;
  state: EntryState<Run>;
}

/** Produces decoder intent in admission order without starting any work. */
export function planRoutePrefetch(
  manifest: Readonly<Manifest>,
  snapshot: Readonly<MotionGraphSnapshot>,
  active: Readonly<ActiveMediaRef> | null,
  lookaheadFrames: number,
  pendingRouteReady: boolean
): Readonly<RoutePrefetchPlan> {
  if (!Number.isSafeInteger(lookaheadFrames) || lookaheadFrames < 1) {
    throw new RangeError("AVAL route lookahead is invalid");
  }
  const immediate: PrefetchIntent[] = [];
  const deferred: PrefetchIntent[] = [];
  const speculative: PrefetchIntent[] = [];
  const resident: Unit[] = [];
  const activeEdge = edge(manifest, snapshot.activeEdgeId);
  const followOn = edge(manifest, snapshot.followOnEdgeId);
  const presentation = snapshot.presentation;

  if (activeEdge !== null) {
    let target = activeEdge.to;
    if (snapshot.phase === "reversible") {
      if (followOn !== null) target = followOn.from;
      else if (snapshot.requestedState === activeEdge.from) target = activeEdge.from;
    }
    const targetUnit = unit(manifest, state(manifest, target).bodyUnit);
    if (active?.unitId !== targetUnit.id || active.mode === "resident") {
      immediate.push({
        unit: targetUnit,
        reason: "active-target"
      });
    }
  }

  const pending = edge(manifest, snapshot.pendingEdgeId);
  const continuation = pending !== null && presentation?.kind === "body"
    ? loopContinuation(
        manifest,
        presentation,
        pending,
        lookaheadFrames,
        pendingRouteReady
      )
    : null;
  if (continuation?.required === true) immediate.push(continuation.intent);
  if (pending !== null) {
    departureIntent(
      manifest,
      pending,
      "pending-route",
      presentation?.kind === "intro" ? deferred : immediate,
      resident
    );
  }
  if (continuation?.required === false) deferred.push(continuation.intent);
  if (followOn !== null) {
    departureIntent(
      manifest,
      followOn,
      "follow-on-route",
      immediate,
      resident
    );
  }

  if (presentation?.kind === "intro") {
    immediate.push({
      unit: unit(manifest, state(manifest, presentation.state).bodyUnit),
      reason: "intro-body"
    });
  } else if (
    presentation?.kind === "body" && pending === null && followOn === null
  ) {
    const body = unit(manifest, presentation.unitId);
    if (body.frameCount - presentation.frameIndex <= lookaheadFrames) {
      const completion = manifest.edges.find((candidate) =>
        candidate.from === presentation.state &&
        candidate.trigger?.type === "completion"
      );
      if (completion !== undefined) {
        departureIntent(
          manifest,
          completion,
          "completion",
          speculative,
          resident
        );
      } else if (body.kind === "body" && body.playback === "loop") {
        speculative.push({
          unit: body,
          reason: "loop"
        });
      }
    }
  }

  return {
    decode: uniqueIntents([...immediate, ...deferred, ...speculative]),
    resident: uniqueUnits(resident)
  };
}

/**
 * Owns discardable route prefetches. Bytes for every bounded intent may load
 * concurrently, but only the current head owns a decoder run.
 */
export class RoutePrefetchQueue<Run extends PrefetchableRun> {
  readonly #signal: AbortSignal;
  readonly #preload: (unit: Unit, signal: AbortSignal) => Promise<void>;
  readonly #admit: (unit: Unit) => Run;
  readonly #canAdmit: () => boolean;
  readonly #onFailure: (error: unknown) => void;
  readonly #entries = new Map<string, Entry<Run>>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #reported = new WeakSet<Entry<Run>>();

  public constructor(operations: Readonly<RoutePrefetchOperations<Run>>) {
    this.#signal = operations.signal;
    this.#preload = operations.preload;
    this.#admit = operations.admit;
    this.#canAdmit = operations.canAdmit ?? (() => true);
    this.#onFailure = operations.onFailure;
  }

  public reconcile(intents: readonly Readonly<PrefetchIntent>[]): void {
    if (intents.length > MAX_ROUTE_PREFETCH_INTENTS) {
      throw new Error("AVAL prefetch invariant failed");
    }
    const desiredIds = intents.map(intentIdentity);
    if (new Set(desiredIds).size !== desiredIds.length) {
      throw new Error("AVAL prefetch invariant failed");
    }

    const currentHead = this.#entries.entries().next().value as
      | [string, Entry<Run>]
      | undefined;
    const nextHeadId = desiredIds[0];
    if (
      currentHead !== undefined && currentHead[0] !== nextHeadId &&
      currentHead[1].ready !== null
    ) {
      this.#entries.delete(currentHead[0]);
      this.#cancel(currentHead[1]);
    }

    const desired = new Set(desiredIds);
    for (const [id, entry] of this.#entries) {
      if (desired.has(id)) continue;
      this.#entries.delete(id);
      this.#cancel(entry);
    }

    const ordered = new Map<string, Entry<Run>>();
    for (let index = 0; index < intents.length; index += 1) {
      const intent = intents[index]!;
      const id = desiredIds[index]!;
      const entry = this.#entries.get(id) ?? this.#start(intent);
      entry.intent = intent;
      ordered.set(id, entry);
    }
    this.#entries.clear();
    for (const [id, entry] of ordered) this.#entries.set(id, entry);
    this.#admitHead();
  }

  public claim(unitId: string): RoutePrefetchClaim<Run> | undefined {
    const matching = [...this.#entries.values()].find(
      (entry) => entry.intent.unit.id === unitId
    );
    if (matching === undefined) return undefined;
    const head = this.#entries.entries().next().value as
      | [string, Entry<Run>]
      | undefined;
    if (head === undefined) throw new Error("AVAL prefetch claim invariant failed");
    const [id, entry] = head;
    if (entry.intent.unit.id !== unitId) {
      throw new Error("AVAL prefetch claim invariant failed");
    }
    if (entry.state.kind !== "ready" || entry.ready === null) return undefined;
    this.#entries.delete(id);
    const ready = entry.ready;
    this.#operations.delete(entry.loaded);
    this.#operations.delete(ready);
    let canceled = false;
    return Object.freeze({
      ready,
      cancel: () => {
        if (canceled) return;
        canceled = true;
        this.#cancel(entry);
      }
    });
  }

  public isReady(unitId: string): boolean {
    const head = this.#entries.values().next().value as Entry<Run> | undefined;
    return head?.intent.unit.id === unitId && head.state.kind === "ready";
  }

  public async settled(): Promise<void> {
    await Promise.allSettled([...this.#operations]);
  }

  public wake(): void {
    this.#admitHead();
  }

  public retire(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) this.#cancel(entry);
    return Promise.allSettled([...this.#operations]).then(() => undefined);
  }

  #start(intent: Readonly<PrefetchIntent>): Entry<Run> {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#signal, controller.signal]);
    let entry!: Entry<Run>;
    const loaded = Promise.resolve()
      .then(() => this.#preload(intent.unit, signal))
      .then(() => {
        signal.throwIfAborted();
        if (entry.state.kind === "loading") entry.state = { kind: "loaded" };
      });
    entry = {
      intent,
      controller,
      loaded,
      admission: null,
      ready: null,
      state: { kind: "loading" }
    };
    this.#track(entry, loaded);
    return entry;
  }

  #admitHead(): void {
    const head = this.#entries.values().next().value as Entry<Run> | undefined;
    if (head !== undefined) this.#scheduleAdmission(head);
  }

  #scheduleAdmission(entry: Entry<Run>): void {
    if (entry.ready !== null || !this.#canAdmit()) return;
    const signal = AbortSignal.any([this.#signal, entry.controller.signal]);
    const admission = entry.loaded.then(() => {
      signal.throwIfAborted();
      const run = this.#admit(entry.intent.unit);
      entry.state = { kind: "admitted", run };
      return run;
    });
    const ready = admission.then(async (run) => {
      try {
        await run.ready();
        signal.throwIfAborted();
        entry.state = { kind: "ready", run };
        return run;
      } catch (error) {
        run.close();
        throw error;
      }
    });
    entry.admission = admission;
    entry.ready = ready;
    this.#track(entry, ready);
  }

  #track(entry: Entry<Run>, operation: Promise<unknown>): void {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation)).catch(() => undefined);
    void operation.catch((error) => {
      if (
        !entry.controller.signal.aborted && !this.#signal.aborted &&
        !this.#reported.has(entry)
      ) {
        this.#reported.add(entry);
        this.#onFailure(error);
      }
    });
  }

  #cancel(entry: Entry<Run>): void {
    entry.controller.abort(abortError());
    if (entry.state.kind === "admitted" || entry.state.kind === "ready") {
      entry.state.run.close();
    }
    void entry.ready?.then((run) => run.close(), () => undefined);
  }
}

function departureIntent(
  manifest: Readonly<Manifest>,
  value: Readonly<Manifest["edges"][number]>,
  reason: PrefetchReason,
  decode: PrefetchIntent[],
  resident: Unit[]
): void {
  const transition = value.transition;
  if (transition?.kind === "reversible") {
    resident.push(unit(manifest, transition.unit));
    return;
  }
  decode.push({
    unit: unit(
      manifest,
      transition === undefined
        ? state(manifest, value.to).bodyUnit
        : transition.unit
    ),
    reason
  });
}

function loopContinuation(
  manifest: Readonly<Manifest>,
  presentation: Extract<Readonly<MotionGraphSnapshot>["presentation"], {
    readonly kind: "body";
  }>,
  pending: Readonly<Manifest["edges"][number]>,
  lookaheadFrames: number,
  pendingRouteReady: boolean
): Readonly<{
  intent: Readonly<PrefetchIntent>;
  required: boolean;
}> | null {
  const start = pending.start;
  if (start.type !== "portal" || pending.from !== presentation.state) {
    return null;
  }
  const body = unit(manifest, presentation.unitId);
  if (
    body.kind !== "body" || body.playback !== "loop" ||
    body.frameCount - presentation.frameIndex > lookaheadFrames
  ) return null;
  const port = body.ports.find(({ id }) => id === start.sourcePort);
  if (port === undefined) throw new Error("AVAL prefetch invariant failed");
  const remainingPortals = port.portalFrames.filter(
    (frame) => frame >= presentation.frameIndex
  );
  const lastPortal = remainingPortals.at(-1);
  const currentPortalReady = pendingRouteReady &&
    remainingPortals[0] === presentation.frameIndex;
  const required = !currentPortalReady && (
    lastPortal === undefined ||
    !pendingRouteReady &&
      lastPortal - presentation.frameIndex <= CANDIDATE_READY_FRAMES
  );
  return Object.freeze({
    intent: Object.freeze({
      unit: body,
      reason: "presentation-continuation"
    }),
    required
  });
}

function uniqueIntents(
  intents: readonly Readonly<PrefetchIntent>[]
): readonly Readonly<PrefetchIntent>[] {
  const seen = new Set<string>();
  return intents.filter((intent) => {
    const id = intentIdentity(intent);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function intentIdentity(intent: Readonly<PrefetchIntent>): string {
  return intent.unit.id;
}

function uniqueUnits(units: readonly Unit[]): readonly Unit[] {
  const seen = new Set<string>();
  return units.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function state(
  manifest: Readonly<Manifest>,
  id: string
): Readonly<Manifest["states"][number]> {
  const value = manifest.states.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error("Invalid AVAL graph");
  return value;
}

function unit(manifest: Readonly<Manifest>, id: string): Unit {
  const value = manifest.units.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error("Invalid AVAL graph");
  return value;
}

function edge(
  manifest: Readonly<Manifest>,
  id: string | null
): Readonly<Manifest["edges"][number]> | null {
  if (id === null) return null;
  const value = manifest.edges.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error("Invalid AVAL graph");
  return value;
}

function abortError(): DOMException {
  return new DOMException("AVAL route prefetch was aborted", "AbortError");
}
