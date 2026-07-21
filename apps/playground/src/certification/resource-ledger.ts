import type { AvalDiagnostics } from "@pixel-point/aval-element";

export interface ResourceSnapshot {
  readonly ordinal: number;
  readonly phase: string;
  readonly timestampMicroseconds: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly observations: Readonly<Record<string, Readonly<{
    value: number | null;
    unit: string;
    provider: string;
    resolution: string;
    available: boolean;
  }>>>;
}

export class BrowserResourceLedger {
  readonly #limit: number;
  readonly #snapshots: ResourceSnapshot[] = [];

  public constructor(limit = 10_000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new RangeError("resource ledger limit is invalid");
    this.#limit = limit;
  }

  public append(phase: string, diagnostics: Readonly<AvalDiagnostics>): void {
    if (this.#snapshots.length >= this.#limit) throw new RangeError("resource ledger limit exceeded");
    if (phase.length < 1 || phase.length > 128) throw new RangeError("resource phase is invalid");
    const runtime = diagnostics.runtime;
    const counters = Object.freeze({
      "element.player": counter(diagnostics.outstanding.player ?? 0, "element.player"),
      "element.decoder": counter(diagnostics.outstanding.decoder ?? 0, "element.decoder"),
      "element.bytes": counter(diagnostics.outstanding.bytes ?? 0, "element.bytes"),
      "transport.active-bodies": counter(runtime.activeTransportBodies, "transport.active-bodies"),
      "transport.pending-loads": counter(runtime.pendingLoads, "transport.pending-loads"),
      "transport.waiters": counter(runtime.interestedWaiters, "transport.waiters"),
      "asset.resident-blob-bytes": counter(runtime.residentBlobBytes, "asset.resident-blob-bytes"),
      "player.tracked-bytes": counter(runtime.playerTrackedBytes, "player.tracked-bytes"),
      "page.physical-bytes": counter(runtime.pagePhysicalBytes, "page.physical-bytes"),
      "page.active-leases": counter(runtime.activeLeaseCount, "page.active-leases")
    });
    this.#snapshots.push(Object.freeze({
      ordinal: this.#snapshots.length,
      phase,
      timestampMicroseconds: nowMicroseconds(),
      counters,
      observations: observationalMemory()
    }));
  }

  public snapshot(): readonly Readonly<ResourceSnapshot>[] {
    return Object.freeze(this.#snapshots.map((snapshot) => Object.freeze({
      ...snapshot,
      counters: Object.freeze({ ...snapshot.counters }),
      observations: Object.freeze({ ...snapshot.observations })
    })));
  }

  public peakCounters(): Readonly<Record<string, number>> {
    const peak: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const { counters } of this.#snapshots) for (const [name, value] of Object.entries(counters)) {
      peak[name] = Math.max(peak[name] ?? 0, value);
    }
    return Object.freeze(peak);
  }
}

function observationalMemory(): ResourceSnapshot["observations"] {
  const memory = performance as Performance & { readonly memory?: { readonly usedJSHeapSize?: number } };
  const heap = memory.memory?.usedJSHeapSize;
  return Object.freeze({
    "js-heap": Object.freeze({
      value: typeof heap === "number" && Number.isFinite(heap) ? Math.max(0, Math.floor(heap)) : null,
      unit: "bytes",
      provider: "performance.memory",
      resolution: "implementation-defined",
      available: typeof heap === "number" && Number.isFinite(heap)
    })
  });
}

function counter(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} is not a nonnegative safe integer`);
  return value;
}

function nowMicroseconds(): number {
  return Math.max(0, Math.floor(performance.timeOrigin * 1_000 + performance.now() * 1_000));
}
