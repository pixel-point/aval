import type { ParsedFrontIndex } from "@rendered-motion/format";

import {
  RuntimeBlobAssembly,
  type BlobAssemblyResourceHost,
  type QuarantinedRuntimeBlob
} from "./blob-assembly.js";
import {
  planBlobStorageRanges,
  type PlannedBlobTransportRange,
  type PlannedRuntimeBlob,
  type RuntimeBlobSelection
} from "./blob-range-plan.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  VerifiedBlobAdmissionMode,
  VerifiedBlobLoadRequest
} from "./verified-blob-store.js";
import type { RuntimeCompleteSourceRange } from "./runtime-complete-source.js";

export interface RuntimeAssetBatchBytes {
  readonly bytes: Uint8Array;
  release(): void;
}

export interface RuntimeAssetBlobLoadBatch {
  register(
    selection: RuntimeBlobSelection,
    request: Readonly<VerifiedBlobLoadRequest>
  ): Promise<void>;
}

export interface RuntimeAssetBatchCoordinatorOptions {
  readonly frontIndex: Readonly<ParsedFrontIndex>;
  readonly generation: number;
  readonly targetRequestBytes: number;
  readonly maximumActiveBodies: number;
  readonly resources: BlobAssemblyResourceHost;
  /** Returns a retained complete-source view, or null while range-backed. */
  readonly readComplete: (
    offset: number,
    length: number
  ) => Readonly<RuntimeCompleteSourceRange> | null;
  readonly fetchRange: (
    range: Readonly<PlannedBlobTransportRange>,
    signal: AbortSignal
  ) => Promise<Readonly<RuntimeAssetBatchBytes>>;
  readonly verifyAndPromote: (
    blob: PlannedRuntimeBlob,
    quarantined: Readonly<QuarantinedRuntimeBlob>,
    request: Readonly<VerifiedBlobLoadRequest>
  ) => Promise<void>;
  /** Verify a private view whose lifetime is retained by one complete source. */
  readonly verifyBorrowedAndPromote: (
    blob: PlannedRuntimeBlob,
    source: Readonly<RuntimeCompleteSourceRange>,
    request: Readonly<VerifiedBlobLoadRequest>
  ) => Promise<void>;
}

interface RegisteredBlobLoad {
  readonly selection: RuntimeBlobSelection;
  readonly request: Readonly<VerifiedBlobLoadRequest>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  outcome: "pending" | "success" | "failure";
  cause: unknown;
  settled: boolean;
}

interface BlobBinding {
  readonly blob: PlannedRuntimeBlob;
  readonly member: RegisteredBlobLoad;
  assembly: RuntimeBlobAssembly | null;
}

interface FailedTransportRange {
  readonly range: Readonly<PlannedBlobTransportRange>;
  readonly cause: unknown;
}

interface ProcessingTurn {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/** Coalesces canonical selections while preserving per-blob promotion state. */
export class RuntimeAssetBatchCoordinator {
  readonly #options: Readonly<RuntimeAssetBatchCoordinatorOptions>;
  readonly #gate: TransportBodyGate;

  public constructor(options: Readonly<RuntimeAssetBatchCoordinatorOptions>) {
    this.#options = captureCoordinatorOptions(options);
    this.#gate = new TransportBodyGate(this.#options.maximumActiveBodies);
  }

  public get activeTransportBodies(): number { return this.#gate.active; }

  public createBatch(expectedLoads: number): RuntimeAssetBlobLoadBatch {
    return new BlobLoadBatch(expectedLoads, (members) => this.#run(members));
  }

  public load(
    selection: RuntimeBlobSelection,
    request: Readonly<VerifiedBlobLoadRequest>
  ): Promise<void> {
    return this.createBatch(1).register(selection, request);
  }

  async #run(members: readonly RegisteredBlobLoad[]): Promise<void> {
    const plan = planBlobStorageRanges({
      frontIndex: this.#options.frontIndex,
      requested: members.map(({ selection }) => selection),
      targetRequestBytes: this.#options.targetRequestBytes
    });
    const bindings: BlobBinding[] = plan.blobs.map((blob) => ({
      blob,
      member: requireBlobMember(blob, members),
      assembly: null
    }));
    try {
      const first = plan.requests[0];
      const complete = first === undefined
        ? null
        : this.#options.readComplete(first.offset, first.length);
      if (complete !== null) {
        for (const binding of bindings) {
          try { await this.#finishBorrowedBinding(binding); }
          catch (cause) { this.#failBinding(binding, cause); }
        }
      } else {
        await this.#fetchRanges(plan.requests, bindings);
      }
    } finally {
      for (const binding of bindings) {
        binding.assembly?.dispose();
        binding.assembly = null;
        if (binding.member.settled) continue;
        settleBlobLoad(
          binding.member,
          binding.member.outcome === "success"
            ? null
            : binding.member.outcome === "failure"
              ? binding.member.cause
              : runtimeError("load-failure")
        );
      }
    }
  }

  async #fetchRanges(
    ranges: readonly Readonly<PlannedBlobTransportRange>[],
    bindings: readonly BlobBinding[]
  ): Promise<void> {
    const failures = new Map<number, FailedTransportRange>();
    let previous = Promise.resolve();
    const operations = ranges.map((range) => {
      const prior = previous;
      const turn = processingTurn();
      previous = turn.promise;
      return this.#fetchOneRange(range, bindings, failures, prior, turn);
    });
    await Promise.all(operations);
    for (const failure of [...failures.values()]) {
      const range = failure.range;
      const source = this.#options.readComplete(range.offset, range.length);
      if (source === null) continue;
      failures.delete(range.ordinal);
      await this.#processRange(range, bindings, source.bytes, failures);
    }
    for (const failure of failures.values()) {
      for (const ordinal of failure.range.blobOrdinals) {
        this.#failBinding(bindings[ordinal]!, failure.cause);
      }
    }
    for (let ordinal = 0; ordinal < bindings.length; ordinal += 1) {
      const binding = bindings[ordinal]!;
      if (
        binding.member.outcome !== "pending" || binding.assembly === null ||
        hasBindingFailure(ordinal, failures)
      ) continue;
      await this.#finishBinding(binding);
    }
  }

  async #fetchOneRange(
    range: Readonly<PlannedBlobTransportRange>,
    bindings: readonly BlobBinding[],
    failures: Map<number, FailedTransportRange>,
    prior: Promise<void>,
    turn: ProcessingTurn
  ): Promise<void> {
    const interested = range.blobOrdinals.map(
      (ordinal) => bindings[ordinal]!.member.request.signal
    );
    const scope = sharedInterestSignal(interested);
    try {
      await this.#gate.run(scope.signal, async () => {
        let result: Readonly<RuntimeAssetBatchBytes> | null = null;
        let failure: unknown = null;
        try {
          result = await this.#options.fetchRange(range, scope.signal);
        } catch (cause) {
          failure = cause;
        }
        await prior;
        try {
          const complete = this.#options.readComplete(range.offset, range.length);
          await this.#processRange(
            range,
            bindings,
            complete?.bytes ?? result?.bytes ?? failure ??
              runtimeError("load-failure"),
            failures
          );
        } finally {
          safeRelease(result);
          turn.resolve();
        }
      });
    } catch (cause) {
      await prior;
      try {
        const complete = this.#options.readComplete(range.offset, range.length);
        await this.#processRange(
          range, bindings, complete?.bytes ?? cause, failures
        );
      } finally {
        turn.resolve();
      }
    } finally {
      scope.dispose();
    }
  }

  async #processRange(
    range: Readonly<PlannedBlobTransportRange>,
    bindings: readonly BlobBinding[],
    value: Uint8Array | unknown,
    failures: Map<number, FailedTransportRange>
  ): Promise<void> {
    const bytes = value instanceof Uint8Array && value.byteLength === range.length
      ? value
      : null;
    if (bytes === null) {
      failures.set(range.ordinal, { range, cause: value });
      return;
    }
    for (const ordinal of range.blobOrdinals) {
      const binding = bindings[ordinal]!;
      if (binding.member.outcome !== "pending") continue;
      try {
        if (this.#completeStorage(binding.blob) !== null) {
          await this.#finishBorrowedBinding(binding);
          continue;
        }
        let assembly = binding.assembly;
        if (assembly === null) {
          await admitBlobLoad(binding.member.request, "copied");
          if (binding.member.request.signal.aborted) throw abortError();
          assembly = await RuntimeBlobAssembly.create({
            blob: binding.blob,
            generation: this.#options.generation,
            resources: this.#options.resources,
            signal: binding.member.request.signal
          });
        }
        binding.assembly = assembly;
        const start = Math.max(range.offset, binding.blob.storageRange.offset);
        const end = Math.min(
          range.offset + range.length,
          binding.blob.storageRange.offset + binding.blob.storageRange.length
        );
        assembly.accept({
          generation: this.#options.generation,
          offset: start,
          bytes: bytes.subarray(start - range.offset, end - range.offset)
        });
        if (end !== binding.blob.storageRange.offset +
          binding.blob.storageRange.length) continue;
        if (hasBindingFailure(ordinal, failures)) continue;
        await this.#finishBinding(binding);
      } catch (cause) {
        this.#failBinding(binding, cause);
      }
    }
  }

  async #finishBinding(binding: BlobBinding): Promise<void> {
    const assembly = binding.assembly;
    if (assembly === null) return;
    const quarantined = assembly.complete();
    binding.assembly = null;
    await this.#options.verifyAndPromote(
      binding.blob,
      quarantined,
      binding.member.request
    );
    binding.member.outcome = "success";
  }

  async #finishBorrowedBinding(binding: BlobBinding): Promise<void> {
    binding.assembly?.dispose();
    binding.assembly = null;
    await admitBlobLoad(binding.member.request, "borrowed");
    if (binding.member.request.signal.aborted) throw abortError();
    const storage = this.#completeStorage(binding.blob);
    if (storage === null) throw runtimeError("load-failure");
    assertZeroPadding(binding.blob, storage.bytes);
    const source = this.#options.readComplete(
      binding.blob.blobRange.offset,
      binding.blob.blobRange.length
    );
    if (source === null || source.bytes.byteLength !== binding.blob.blobRange.length) {
      throw runtimeError("load-failure");
    }
    await this.#options.verifyBorrowedAndPromote(
      binding.blob,
      source,
      binding.member.request
    );
    binding.member.outcome = "success";
  }

  #completeStorage(
    blob: PlannedRuntimeBlob
  ): Readonly<RuntimeCompleteSourceRange> | null {
    const source = this.#options.readComplete(
      blob.storageRange.offset,
      blob.storageRange.length
    );
    return source !== null && source.bytes.byteLength === blob.storageRange.length
      ? source
      : null;
  }

  #failBinding(binding: BlobBinding, cause: unknown): void {
    binding.assembly?.dispose();
    binding.assembly = null;
    binding.member.outcome = "failure";
    binding.member.cause = cause;
  }
}

class BlobLoadBatch implements RuntimeAssetBlobLoadBatch {
  readonly #expected: number;
  readonly #start: (members: readonly RegisteredBlobLoad[]) => Promise<void>;
  readonly #members: RegisteredBlobLoad[] = [];

  public constructor(
    expected: number,
    start: (members: readonly RegisteredBlobLoad[]) => Promise<void>
  ) {
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new TypeError("blob batch size must be positive");
    }
    if (typeof start !== "function") {
      throw new TypeError("blob batch start capability is missing");
    }
    this.#expected = expected;
    this.#start = (members) => Promise.resolve(Reflect.apply(
      start,
      undefined,
      [members]
    ) as PromiseLike<void>);
  }

  public register(
    selection: RuntimeBlobSelection,
    request: Readonly<VerifiedBlobLoadRequest>
  ): Promise<void> {
    if (this.#members.length >= this.#expected) {
      return Promise.reject(runtimeError("load-failure"));
    }
    return new Promise((resolve, reject) => {
      const member: RegisteredBlobLoad = {
        selection,
        request,
        resolve,
        reject,
        outcome: "pending",
        cause: null,
        settled: false
      };
      this.#members.push(member);
      if (this.#members.length !== this.#expected) return;
      const members = Object.freeze(this.#members.slice());
      void Promise.resolve().then(() => this.#start(members)).catch((cause) => {
        for (const entry of members) settleBlobLoad(entry, cause);
      });
    });
  }
}

interface TransportWaiter {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  readonly listener: () => void;
  settled: boolean;
}

class TransportBodyGate {
  readonly #maximum: number;
  readonly #queue: TransportWaiter[] = [];
  #active = 0;

  public constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4) {
      throw new TypeError("transport body limit must be from one through four");
    }
    this.#maximum = maximum;
  }
  public get active(): number { return this.#active; }

  public async run<Result>(
    signal: AbortSignal,
    operation: () => Promise<Result>
  ): Promise<Result> {
    await this.#acquire(signal);
    try {
      if (signal.aborted) throw abortError();
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.#active < this.#maximum) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let waiter!: TransportWaiter;
      const listener = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(abortError());
      };
      waiter = { signal, resolve, reject, listener, settled: false };
      this.#queue.push(waiter);
      try {
        signal.addEventListener("abort", listener, { once: true });
      } catch (error) {
        waiter.settled = true;
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        try { signal.removeEventListener("abort", listener); } catch {}
        reject(error);
        return;
      }
      if (signal.aborted) listener();
    });
  }

  #release(): void {
    this.#active -= 1;
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      try { waiter.signal.removeEventListener("abort", waiter.listener); } catch {}
      this.#active += 1;
      waiter.resolve();
      return;
    }
  }
}

function captureCoordinatorOptions(
  value: Readonly<RuntimeAssetBatchCoordinatorOptions>
): Readonly<RuntimeAssetBatchCoordinatorOptions> {
  if (typeof value !== "object" || value === null) throw runtimeError("load-failure");
  let frontIndex: Readonly<ParsedFrontIndex>;
  let generation: number;
  let targetRequestBytes: number;
  let maximumActiveBodies: number;
  let resources: BlobAssemblyResourceHost;
  let readComplete: unknown;
  let fetchRange: unknown;
  let verifyAndPromote: unknown;
  let verifyBorrowedAndPromote: unknown;
  try {
    frontIndex = value.frontIndex;
    generation = value.generation;
    targetRequestBytes = value.targetRequestBytes;
    maximumActiveBodies = value.maximumActiveBodies;
    resources = value.resources;
    readComplete = Reflect.get(value, "readComplete");
    fetchRange = Reflect.get(value, "fetchRange");
    verifyAndPromote = Reflect.get(value, "verifyAndPromote");
    verifyBorrowedAndPromote = Reflect.get(value, "verifyBorrowedAndPromote");
  } catch {
    throw runtimeError("load-failure");
  }
  if (
    typeof frontIndex !== "object" || frontIndex === null ||
    !Number.isSafeInteger(generation) || generation < 0 ||
    !Number.isSafeInteger(targetRequestBytes) || targetRequestBytes < 1 ||
    !Number.isSafeInteger(maximumActiveBodies) ||
    maximumActiveBodies < 1 || maximumActiveBodies > 4 ||
    typeof resources !== "object" || resources === null ||
    typeof readComplete !== "function" || typeof fetchRange !== "function" ||
    typeof verifyAndPromote !== "function" ||
    typeof verifyBorrowedAndPromote !== "function"
  ) throw runtimeError("load-failure");
  return Object.freeze({
    frontIndex,
    generation,
    targetRequestBytes,
    maximumActiveBodies,
    resources,
    readComplete: (offset: number, length: number) => Reflect.apply(
      readComplete,
      value,
      [offset, length]
    ) as Readonly<RuntimeCompleteSourceRange> | null,
    fetchRange: (
      range: Readonly<PlannedBlobTransportRange>,
      signal: AbortSignal
    ) => Promise.resolve(Reflect.apply(
      fetchRange,
      value,
      [range, signal]
    ) as PromiseLike<Readonly<RuntimeAssetBatchBytes>>),
    verifyAndPromote: (
      blob: PlannedRuntimeBlob,
      quarantined: Readonly<QuarantinedRuntimeBlob>,
      request: Readonly<VerifiedBlobLoadRequest>
    ) => Promise.resolve(
      Reflect.apply(
        verifyAndPromote,
        value,
        [blob, quarantined, request]
      ) as PromiseLike<void>
    ),
    verifyBorrowedAndPromote: (
      blob: PlannedRuntimeBlob,
      source: Readonly<RuntimeCompleteSourceRange>,
      request: Readonly<VerifiedBlobLoadRequest>
    ) => Promise.resolve(Reflect.apply(
      verifyBorrowedAndPromote,
      value,
      [blob, source, request]
    ) as PromiseLike<void>)
  });
}

function assertZeroPadding(blob: PlannedRuntimeBlob, storage: Uint8Array): void {
  for (let offset = 0; offset < blob.paddingRange.length; offset += 1) {
    if (storage[offset] !== 0) {
      throw new Error("canonical blob padding must contain only zero bytes");
    }
  }
}

function hasBindingFailure(
  ordinal: number,
  failures: ReadonlyMap<number, FailedTransportRange>
): boolean {
  for (const { range } of failures.values()) {
    if (range.blobOrdinals.includes(ordinal)) return true;
  }
  return false;
}

function requireBlobMember(
  blob: PlannedRuntimeBlob,
  members: readonly RegisteredBlobLoad[]
): RegisteredBlobLoad {
  const member = members.find(({ selection }) =>
    blob.kind === "unit" && selection.kind === "unit"
      ? blob.rendition === selection.rendition && blob.unit === selection.unit
      : blob.kind === "static" && selection.kind === "static" &&
        blob.staticFrame === selection.staticFrame
  );
  if (member === undefined) throw runtimeError("invalid-asset");
  return member;
}

function settleBlobLoad(
  member: RegisteredBlobLoad,
  cause: unknown | null
): void {
  if (member.settled) return;
  member.settled = true;
  if (cause === null) member.resolve();
  else member.reject(cause);
}

async function admitBlobLoad(
  request: Readonly<VerifiedBlobLoadRequest>,
  mode: VerifiedBlobAdmissionMode
): Promise<void> {
  let admit: unknown;
  try { admit = Reflect.get(request, "admit"); } catch {
    throw runtimeError("load-failure");
  }
  if (typeof admit !== "function") throw runtimeError("load-failure");
  await Promise.resolve(Reflect.apply(admit, request, [mode]) as
    void | PromiseLike<void>);
}

function sharedInterestSignal(signals: readonly AbortSignal[]): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const links: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = [];
  const check = (): void => {
    if (signals.every(({ aborted }) => aborted)) controller.abort();
  };
  try {
    for (const signal of signals) {
      const listener = (): void => { check(); };
      const link = { signal, listener };
      links.push(link);
      signal.addEventListener("abort", listener, { once: true });
    }
  } catch (error) {
    for (const link of links.splice(0)) {
      try { link.signal.removeEventListener("abort", link.listener); } catch {}
    }
    throw error;
  }
  check();
  return Object.freeze({
    signal: controller.signal,
    dispose(): void {
      for (const link of links) {
        try { link.signal.removeEventListener("abort", link.listener); } catch {}
      }
      links.length = 0;
    }
  });
}

function processingTurn(): ProcessingTurn {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function safeRelease(value: { release(): void } | null): void {
  if (value === null) return;
  try { value.release(); } catch {}
}

function runtimeError(code: "invalid-asset" | "load-failure"): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(code));
}

function abortError(): DOMException {
  return new DOMException("runtime asset transport was aborted", "AbortError");
}
