import { validateCompleteAsset } from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import { createIntegratedPathTestAsset } from "./asset-test-fixture.js";
import type { BlobAssemblyLease, BlobAssemblyResourceHost } from "./blob-assembly.js";
import type {
  PlannedRuntimeBlob,
  RuntimeBlobSelection
} from "./blob-range-plan.js";
import {
  RuntimeAssetBatchCoordinator,
  type RuntimeAssetBatchBytes
} from "./runtime-asset-batch.js";
import { createRuntimeCompleteSource } from "./runtime-complete-source.js";
import type {
  VerifiedBlobAdmissionMode,
  VerifiedBlobLoadRequest
} from "./verified-blob-store.js";

describe("runtime asset batch coordinator", () => {
  it("coalesces adjacent statics and promotes with one live assembly at a time", async () => {
    const asset = createIntegratedPathTestAsset();
    const front = validateCompleteAsset({ bytes: asset }).frontIndex;
    const resources = new AssemblyResources();
    const fetches: Array<Readonly<{ offset: number; length: number }>> = [];
    const promotions: string[] = [];
    const admissions: VerifiedBlobAdmissionMode[] = [];
    let releases = 0;
    const coordinator = new RuntimeAssetBatchCoordinator({
      frontIndex: front,
      generation: 0,
      targetRequestBytes: 4 * 1024 * 1024,
      maximumActiveBodies: 4,
      resources,
      readComplete: () => null,
      async fetchRange(range) {
        fetches.push({ offset: range.offset, length: range.length });
        return body(asset.slice(range.offset, range.offset + range.length), () => {
          releases += 1;
        });
      },
      async verifyAndPromote(blob, quarantined) {
        promotions.push(blobId(blob));
        expect(resources.live).toBe(quarantined.bytes.byteLength);
        quarantined.release();
      },
      async verifyBorrowedAndPromote() { throw new Error("unexpected full source"); }
    });
    const selections = front.staticBlobs.map(({ staticFrame }) => ({
      kind: "static" as const,
      staticFrame
    }));

    await loadBatch(coordinator, selections, front, admissions);

    expect(fetches).toHaveLength(1);
    expect(releases).toBe(1);
    expect(promotions).toEqual(front.staticBlobs.map(({ staticFrame }) =>
      `static:${staticFrame}`
    ));
    expect(resources.peak).toBe(Math.max(
      ...front.staticBlobs.map(({ length }) => length)
    ));
    expect(resources.live).toBe(0);
    expect(admissions).toEqual(selections.map(() => "copied"));
  });

  it("settles copied admission before constructing an assembly", async () => {
    const asset = createIntegratedPathTestAsset();
    const front = validateCompleteAsset({ bytes: asset }).frontIndex;
    const blob = front.staticBlobs[0]!;
    const selection = {
      kind: "static" as const,
      staticFrame: blob.staticFrame
    };
    const admitted = deferred<void>();
    const events: string[] = [];
    const resources: BlobAssemblyResourceHost = {
      reserve(byteLength) {
        events.push(`assembly:${String(byteLength)}`);
        return { release() { events.push("assembly-release"); } };
      }
    };
    const coordinator = new RuntimeAssetBatchCoordinator({
      frontIndex: front,
      generation: 0,
      targetRequestBytes: 4 * 1024 * 1024,
      maximumActiveBodies: 4,
      resources,
      readComplete: () => null,
      async fetchRange(range) {
        events.push("fetch");
        return body(asset.slice(range.offset, range.offset + range.length));
      },
      async verifyAndPromote(_planned, quarantined) {
        events.push("promote");
        quarantined.release();
      },
      async verifyBorrowedAndPromote() {
        throw new Error("unexpected full source");
      }
    });
    const requestValue = request(blob.length, "static");
    const operation = coordinator.load(selection, Object.freeze({
      ...requestValue,
      async admit(mode: VerifiedBlobAdmissionMode) {
        events.push(`admit:${mode}`);
        await admitted.promise;
        events.push("admitted");
      }
    }));

    await flushMicrotasks();
    expect(events).toEqual(["fetch", "admit:copied"]);
    admitted.resolve();
    await operation;
    expect(events).toEqual([
      "fetch",
      "admit:copied",
      "admitted",
      `assembly:${String(blob.length)}`,
      "promote",
      "assembly-release"
    ]);
  });

  it("holds at most four fetched bodies while processing tiny range chunks", async () => {
    const asset = createIntegratedPathTestAsset();
    const front = validateCompleteAsset({ bytes: asset }).frontIndex;
    const resources = new AssemblyResources();
    let active = 0;
    let maximum = 0;
    let releaseWave!: () => void;
    const wave = new Promise<void>((resolve) => { releaseWave = resolve; });
    let firstWave = true;
    const coordinator = new RuntimeAssetBatchCoordinator({
      frontIndex: front,
      generation: 0,
      targetRequestBytes: 16,
      maximumActiveBodies: 4,
      resources,
      readComplete: () => null,
      async fetchRange(range) {
        active += 1;
        maximum = Math.max(maximum, active);
        if (firstWave && active === 4) releaseWave();
        if (firstWave) await wave;
        firstWave = false;
        active -= 1;
        return body(asset.slice(range.offset, range.offset + range.length));
      },
      async verifyAndPromote(_blob, quarantined) { quarantined.release(); },
      async verifyBorrowedAndPromote() { throw new Error("unexpected full source"); }
    });
    const selections = front.unitBlobs.map(({ rendition, unit }) => ({
      kind: "unit" as const,
      rendition,
      unit
    }));

    await loadBatch(coordinator, selections, front);

    expect(maximum).toBe(4);
    expect(coordinator.activeTransportBodies).toBe(0);
    expect(resources.live).toBe(0);
  });

  it("never constructs a blob assembly for a retained complete source", async () => {
    const asset = createIntegratedPathTestAsset();
    const front = validateCompleteAsset({ bytes: asset }).frontIndex;
    const selections = front.staticBlobs.map(({ staticFrame }) => ({
      kind: "static" as const,
      staticFrame
    }));

    const resources = new AssemblyResources(1);
    const source = createRuntimeCompleteSource(asset, () => {});
    let promotions = 0;
    const admissions: VerifiedBlobAdmissionMode[] = [];
    const coordinator = new RuntimeAssetBatchCoordinator({
      frontIndex: front,
      generation: 0,
      targetRequestBytes: 4 * 1024 * 1024,
      maximumActiveBodies: 4,
      resources,
      readComplete: source.read,
      async fetchRange() { throw new Error("unexpected transport"); },
      async verifyAndPromote() { throw new Error("unexpected assembly"); },
      async verifyBorrowedAndPromote() { promotions += 1; }
    });

    const settled = await loadBatchSettled(
      coordinator,
      selections,
      front,
      admissions
    );

    expect(settled.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(promotions).toBe(selections.length);
    expect(resources.reservations).toBe(0);
    expect(resources.live).toBe(0);
    expect(admissions).toEqual(selections.map(() => "borrowed"));
  });

  it.each(["failure-before-full", "full-before-failure"] as const)(
    "rescues incomplete transport for the %s replacement race",
    async (permutation) => {
      const asset = createIntegratedPathTestAsset();
      const front = validateCompleteAsset({ bytes: asset }).frontIndex;
      const selection = {
        kind: "static" as const,
        staticFrame: front.staticBlobs[0]!.staticFrame
      };
      const resources = new AssemblyResources();
      let complete = false;
      const completeSource = createRuntimeCompleteSource(asset, () => {});
      let promotions = 0;
      const coordinator = new RuntimeAssetBatchCoordinator({
        frontIndex: front,
        generation: 0,
        targetRequestBytes: 16,
        maximumActiveBodies: 4,
        resources,
        readComplete: (offset, length) => complete
          ? completeSource.read(offset, length)
          : null,
        async fetchRange(range) {
          if (permutation === "failure-before-full") {
            if (range.ordinal === 0) throw new Error("range failed first");
            if (range.ordinal === 1) complete = true;
          } else {
            if (range.ordinal === 0) complete = true;
            if (range.ordinal === 1) {
              await Promise.resolve();
              throw new Error("range failed second");
            }
          }
          return body(asset.slice(range.offset, range.offset + range.length));
        },
        async verifyAndPromote(_blob, quarantined) {
          promotions += 1;
          quarantined.release();
        },
        async verifyBorrowedAndPromote() {
          promotions += 1;
        }
      });

      const settled = await loadBatchSettled(
        coordinator,
        [selection],
        front
      );

      expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(promotions).toBe(1);
      expect(resources.live).toBe(0);
    }
  );

  it("rolls copied admission and partial assembly into one later full borrow", async () => {
    const asset = createIntegratedPathTestAsset();
    const front = validateCompleteAsset({ bytes: asset }).frontIndex;
    const blob = front.staticBlobs[0]!;
    const selection = {
      kind: "static" as const,
      staticFrame: blob.staticFrame
    };
    const assemblyStarted = deferred<void>();
    const resources = new AssemblyResources(
      null,
      () => { assemblyStarted.resolve(); }
    );
    const completeSource = createRuntimeCompleteSource(asset, () => {});
    const modes: VerifiedBlobAdmissionMode[] = [];
    let selectedMode: VerifiedBlobAdmissionMode | null = null;
    let complete = false;
    let borrowedPromotions = 0;
    const coordinator = new RuntimeAssetBatchCoordinator({
      frontIndex: front,
      generation: 0,
      targetRequestBytes: 16,
      maximumActiveBodies: 4,
      resources,
      readComplete: (offset, length) => complete
        ? completeSource.read(offset, length)
        : null,
      async fetchRange(range) {
        if (range.ordinal === 1) {
          await assemblyStarted.promise;
          complete = true;
        }
        return body(asset.slice(range.offset, range.offset + range.length));
      },
      async verifyAndPromote(_planned, quarantined) {
        quarantined.release();
        throw new Error("partial range must not promote");
      },
      async verifyBorrowedAndPromote() { borrowedPromotions += 1; }
    });
    const base = request(blob.length, "static");
    const operation = coordinator.load(selection, Object.freeze({
      ...base,
      async admit(mode: VerifiedBlobAdmissionMode) {
        modes.push(mode);
        if (selectedMode === "borrowed" && mode === "copied") {
          throw new Error("borrowed admission cannot return to copied");
        }
        selectedMode = mode;
      }
    }));

    await operation;
    expect(modes[0]).toBe("copied");
    expect(modes).toContain("borrowed");
    expect(selectedMode).toBe("borrowed");
    expect(borrowedPromotions).toBe(1);
    expect(resources.live).toBe(0);
    completeSource.release();
  });

  it("snapshots option capabilities once and rejects batch over-registration", async () => {
    const asset = createIntegratedPathTestAsset();
    const front = validateCompleteAsset({ bytes: asset }).frontIndex;
    const selection = {
      kind: "static" as const,
      staticFrame: front.staticBlobs[0]!.staticFrame
    };
    const reads = new Map<PropertyKey, number>();
    const completeSource = createRuntimeCompleteSource(asset, () => {});
    const base = {
      frontIndex: front,
      generation: 0,
      targetRequestBytes: 4 * 1024 * 1024,
      maximumActiveBodies: 4,
      resources: new AssemblyResources(),
      readComplete: completeSource.read,
      async fetchRange() { throw new Error("unexpected transport"); },
      async verifyAndPromote(_blob: PlannedRuntimeBlob, quarantined: {
        readonly bytes: Uint8Array;
        release(): void;
      }) { quarantined.release(); },
      async verifyBorrowedAndPromote() {}
    };
    const options = new Proxy(base, {
      get(target, property, receiver) {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      }
    });
    const coordinator = new RuntimeAssetBatchCoordinator(options);
    expect(() => coordinator.createBatch(0)).toThrow();
    const batch = coordinator.createBatch(1);
    const first = batch.register(
      selection,
      request(front.staticBlobs[0]!.length, "static")
    );
    await expect(batch.register(
      selection,
      request(front.staticBlobs[0]!.length, "static")
    )).rejects.toMatchObject({ code: "load-failure" });
    await first;

    for (const property of Reflect.ownKeys(base)) {
      expect(reads.get(property), String(property)).toBe(1);
    }
  });
});

async function loadBatch(
  coordinator: RuntimeAssetBatchCoordinator,
  selections: readonly RuntimeBlobSelection[],
  front: ReturnType<typeof validateCompleteAsset>["frontIndex"],
  admissions?: VerifiedBlobAdmissionMode[]
): Promise<void> {
  const settled = await loadBatchSettled(
    coordinator,
    selections,
    front,
    admissions
  );
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
  }
}

function loadBatchSettled(
  coordinator: RuntimeAssetBatchCoordinator,
  selections: readonly RuntimeBlobSelection[],
  front: ReturnType<typeof validateCompleteAsset>["frontIndex"],
  admissions?: VerifiedBlobAdmissionMode[]
) {
  const batch = coordinator.createBatch(selections.length);
  return Promise.allSettled(selections.map((selection) => {
    const blob = selection.kind === "static"
      ? front.staticBlobs.find(({ staticFrame }) =>
          staticFrame === selection.staticFrame
        )!
      : front.unitBlobs.find(({ rendition, unit }) =>
          rendition === selection.rendition && unit === selection.unit
        )!;
    return batch.register(
      selection,
      request(blob.length, selection.kind, admissions)
    );
  }));
}

function request(
  byteLength: number,
  kind: "unit" | "static",
  admissions?: VerifiedBlobAdmissionMode[]
): Readonly<VerifiedBlobLoadRequest> {
  return Object.freeze({
    key: `${kind}:${String(byteLength)}`,
    kind,
    byteLength,
    generation: 0,
    signal: new AbortController().signal,
    async admit(mode: VerifiedBlobAdmissionMode) { admissions?.push(mode); },
    promote() {}
  });
}

function body(bytes: Uint8Array, onRelease: () => void = () => {}):
Readonly<RuntimeAssetBatchBytes> {
  let released = false;
  return Object.freeze({
    bytes,
    release(): void {
      if (released) return;
      released = true;
      onRelease();
    }
  });
}

function blobId(blob: PlannedRuntimeBlob): string {
  return blob.kind === "unit"
    ? `unit:${blob.rendition}:${blob.unit}`
    : `static:${blob.staticFrame}`;
}

class AssemblyResources implements BlobAssemblyResourceHost {
  public live = 0;
  public peak = 0;
  public reservations = 0;
  readonly #failure: number | null;
  readonly #onReserve: (() => void) | null;

  public constructor(
    failure: number | null = null,
    onReserve: (() => void) | null = null
  ) {
    this.#failure = failure;
    this.#onReserve = onReserve;
  }

  public reserve(byteLength: number): BlobAssemblyLease {
    this.reservations += 1;
    this.#onReserve?.();
    if (this.reservations === this.#failure) throw new Error("rejected");
    this.live += byteLength;
    this.peak = Math.max(this.peak, this.live);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.live -= byteLength;
      }
    };
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return Object.freeze({ promise, resolve });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
