import type { Manifest, Unit } from "./asset.js";
import type { MotionGraphSnapshot } from "@pixel-point/aval-graph";

export const MAX_ROUTE_PREFETCH_INTENTS = 4;

export type PrefetchReason =
  | "resume-body"
  | "active-target"
  | "pending-route"
  | "follow-on-route"
  | "intro-body"
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
  readonly onFailure: (error: unknown) => void;
}

type EntryState<Run> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "admitted"; run: Run }>
  | Readonly<{ kind: "ready"; run: Run }>;

interface Entry<Run> {
  readonly intent: Readonly<PrefetchIntent>;
  readonly controller: AbortController;
  readonly created: Promise<Run>;
  readonly ready: Promise<Run>;
  state: EntryState<Run>;
}

/** Produces decoder intent in admission order without starting any work. */
export function planRoutePrefetch(
  manifest: Readonly<Manifest>,
  snapshot: Readonly<MotionGraphSnapshot>,
  active: Readonly<ActiveMediaRef> | null,
  lookaheadFrames: number,
  resumeUnitId: string | null = null
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

  if (resumeUnitId !== null) {
    if (presentation?.kind !== "body" || presentation.unitId !== resumeUnitId) {
      throw new Error("AVAL prefetch resume invariant failed");
    }
    immediate.push({
      unit: unit(manifest, resumeUnitId),
      reason: "resume-body"
    });
  }

  if (activeEdge !== null) {
    let target = activeEdge.to;
    if (snapshot.phase === "reversible") {
      if (followOn !== null) target = followOn.from;
      else if (snapshot.requestedState === activeEdge.from) target = activeEdge.from;
    }
    const targetUnit = unit(manifest, state(manifest, target).bodyUnit);
    if (active?.unitId !== targetUnit.id || active.mode === "resident") {
      immediate.push({ unit: targetUnit, reason: "active-target" });
    }
  }

  const pending = edge(manifest, snapshot.pendingEdgeId);
  if (pending !== null) {
    departureIntent(
      manifest,
      pending,
      "pending-route",
      presentation?.kind === "intro" ? deferred : immediate,
      resident
    );
  }
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
        speculative.push({ unit: body, reason: "loop" });
      }
    }
  }

  return {
    decode: uniqueIntents([...immediate, ...deferred, ...speculative]),
    resident: uniqueUnits(resident)
  };
}

/**
 * Owns discardable route prefetches and admits their decoder runs in plan
 * order, independently of asynchronous asset-load completion order.
 */
export class RoutePrefetchQueue<Run extends PrefetchableRun> {
  readonly #signal: AbortSignal;
  readonly #preload: (unit: Unit, signal: AbortSignal) => Promise<void>;
  readonly #admit: (unit: Unit) => Run;
  readonly #onFailure: (error: unknown) => void;
  readonly #entries = new Map<string, Entry<Run>>();
  readonly #operations = new Set<Promise<Run>>();
  #claimedAdmission: Promise<unknown> = Promise.resolve();

  public constructor(operations: Readonly<RoutePrefetchOperations<Run>>) {
    this.#signal = operations.signal;
    this.#preload = operations.preload;
    this.#admit = operations.admit;
    this.#onFailure = operations.onFailure;
  }

  public reconcile(intents: readonly Readonly<PrefetchIntent>[]): void {
    if (intents.length > MAX_ROUTE_PREFETCH_INTENTS) {
      throw new Error("AVAL prefetch invariant failed");
    }
    const desiredIds = intents.map(({ unit: value }) => value.id);
    if (new Set(desiredIds).size !== desiredIds.length) {
      throw new Error("AVAL prefetch invariant failed");
    }

    const current = [...this.#entries.values()];
    let prefix = 0;
    while (prefix < current.length && prefix < intents.length &&
      current[prefix]!.intent.unit.id === desiredIds[prefix]) prefix += 1;

    for (const entry of current.slice(prefix)) {
      this.#entries.delete(entry.intent.unit.id);
      this.#cancel(entry);
    }

    let predecessor: Promise<unknown> = prefix === 0
      ? this.#claimedAdmission
      : current[prefix - 1]!.created;
    for (const intent of intents.slice(prefix)) {
      const entry = this.#start(intent, predecessor);
      this.#entries.set(intent.unit.id, entry);
      predecessor = entry.created;
    }
  }

  public claim(unitId: string): RoutePrefetchClaim<Run> | undefined {
    const entry = this.#entries.get(unitId);
    if (entry === undefined) return undefined;
    if (this.#entries.keys().next().value !== unitId) {
      throw new Error("AVAL prefetch claim invariant failed");
    }
    this.#entries.delete(unitId);
    this.#operations.delete(entry.ready);
    const admission = entry.created.then(
      () => undefined,
      () => undefined
    );
    this.#claimedAdmission = admission;
    let canceled = false;
    return Object.freeze({
      ready: entry.ready,
      cancel: () => {
        if (canceled) return;
        canceled = true;
        this.#cancel(entry);
      }
    });
  }

  public isReady(unitId: string): boolean {
    return this.#entries.get(unitId)?.state.kind === "ready";
  }

  public async settled(): Promise<void> {
    await Promise.allSettled([...this.#operations]);
  }

  public retire(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) this.#cancel(entry);
    return Promise.allSettled([...this.#operations]).then(() => undefined);
  }

  #start(
    intent: Readonly<PrefetchIntent>,
    predecessor: Promise<unknown>
  ): Entry<Run> {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#signal, controller.signal]);
    let entry!: Entry<Run>;
    const loaded = Promise.resolve().then(() => this.#preload(intent.unit, signal));
    const priorAdmission = predecessor.then(
      () => undefined,
      () => undefined
    );
    const created = Promise.all([loaded, priorAdmission]).then(() => {
      signal.throwIfAborted();
      const run = this.#admit(intent.unit);
      entry.state = { kind: "admitted", run };
      return run;
    });
    const ready = created.then(async (run) => {
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
    entry = {
      intent,
      controller,
      created,
      ready,
      state: { kind: "loading" }
    };
    this.#operations.add(ready);
    void ready.finally(() => this.#operations.delete(ready)).catch(() => undefined);
    void ready.catch((error) => {
      if (!controller.signal.aborted && !this.#signal.aborted) {
        this.#onFailure(error);
      }
    });
    return entry;
  }

  #cancel(entry: Entry<Run>): void {
    entry.controller.abort(abortError());
    if (entry.state.kind !== "loading") entry.state.run.close();
    void entry.ready.then((run) => run.close(), () => undefined);
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

function uniqueIntents(
  intents: readonly Readonly<PrefetchIntent>[]
): readonly Readonly<PrefetchIntent>[] {
  const seen = new Set<string>();
  return intents.filter(({ unit: value }) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
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
