import type {
  RuntimeByteCategory,
  RuntimeByteLease
} from "./model.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type { PlayerResourceAdmission } from "./player-resource-admission.js";
import {
  PlayerResourceAccount,
  shrinkPlayerResourceLease
} from "./player-resource-account.js";
import type {
  BrowserCanvasBackingResourceHost,
  BrowserCanvasBackingResourceInput,
  BrowserCanvasBackingResourceTransition
} from "./browser-canvas-backing-resources.js";

/** Exact two-plane backing owner with async pressure admission before growth. */
export function createPlayerCanvasBackingResourceHost(
  account: PlayerResourceAccount,
  admission?: Readonly<PlayerResourceAdmission>
): BrowserCanvasBackingResourceHost {
  return new PlayerCanvasBackingHost(account, admission);
}

interface CanvasBackingLeaseRecord {
  readonly category: "animated-canvas-backing" | "static-canvas-backing";
  readonly lease: RuntimeByteLease;
  bytes: number;
}

interface CanvasBackingTransitionRecord {
  readonly additions: CanvasBackingLeaseRecord[];
  readonly nextAnimated: number;
  readonly nextStatic: number;
  settled: boolean;
  rolledBack: boolean;
}

class PlayerCanvasBackingHost implements BrowserCanvasBackingResourceHost {
  public readonly asynchronous: boolean;
  readonly #account: PlayerResourceAccount;
  readonly #admission: Readonly<PlayerResourceAdmission> | null;
  readonly #generation: number;
  readonly #animated: CanvasBackingLeaseRecord[] = [];
  readonly #statics: CanvasBackingLeaseRecord[] = [];
  #animatedBytes = 0;
  #staticBytes = 0;
  #active: CanvasBackingTransitionRecord | null = null;
  #released = false;

  public constructor(
    account: PlayerResourceAccount,
    admission?: Readonly<PlayerResourceAdmission>
  ) {
    if (!(account instanceof PlayerResourceAccount)) {
      throw new TypeError("canvas backing resources require a player account");
    }
    const participant = account.snapshot().participant;
    if (participant === null) throw disposedError();
    this.#account = account;
    this.#generation = participant.generation;
    this.#admission = admission ?? null;
    this.asynchronous = admission !== undefined;
    if (admission !== undefined && (
      admission === null ||
      typeof admission !== "object" ||
      typeof admission.reserve !== "function"
    )) {
      throw new TypeError("canvas backing admission is malformed");
    }
  }

  public beginTransition(
    input: Readonly<BrowserCanvasBackingResourceInput>
  ): BrowserCanvasBackingResourceTransition |
    Promise<BrowserCanvasBackingResourceTransition> {
    this.#assertAvailable();
    if (this.#active !== null) {
      throw new RangeError("canvas backing resource transition is already active");
    }
    const nextAnimated = requireBackingBytes(
      input?.animatedAllocationBytes,
      "animated canvas backing bytes"
    );
    const nextStatic = requireBackingBytes(
      input?.staticAllocationBytes,
      "static canvas backing bytes"
    );
    return this.#admission === null
      ? this.#beginSynchronous(nextAnimated, nextStatic)
      : this.#beginAsynchronous(nextAnimated, nextStatic);
  }

  public release(): void {
    if (this.#released) return;
    this.#released = true;
    if (this.#active !== null) this.#rollback(this.#active);
    releaseCanvasBackingLeases(this.#animated);
    releaseCanvasBackingLeases(this.#statics);
    this.#animatedBytes = 0;
    this.#staticBytes = 0;
  }

  #beginSynchronous(
    nextAnimated: number,
    nextStatic: number
  ): BrowserCanvasBackingResourceTransition {
    const additions: CanvasBackingLeaseRecord[] = [];
    try {
      reserveCanvasBackingGrowth(
        (category, bytes) => this.#reserveDirect(category, bytes),
        additions,
        "animated-canvas-backing",
        this.#animatedBytes,
        nextAnimated
      );
      reserveCanvasBackingGrowth(
        (category, bytes) => this.#reserveDirect(category, bytes),
        additions,
        "static-canvas-backing",
        this.#staticBytes,
        nextStatic
      );
    } catch (error) {
      releaseCanvasBackingLeases(additions);
      throw error;
    }
    const record = this.#activate(additions, nextAnimated, nextStatic);
    return this.#transition(record);
  }

  async #beginAsynchronous(
    nextAnimated: number,
    nextStatic: number
  ): Promise<BrowserCanvasBackingResourceTransition> {
    const record = this.#activate([], nextAnimated, nextStatic);
    try {
      await this.#reserveGrowthAsync(
        record,
        "animated-canvas-backing",
        this.#animatedBytes,
        nextAnimated
      );
      await this.#reserveGrowthAsync(
        record,
        "static-canvas-backing",
        this.#staticBytes,
        nextStatic
      );
      this.#assertRecordActive(record);
      return this.#transition(record);
    } catch (error) {
      this.#rollback(record);
      throw error;
    }
  }

  async #reserveGrowthAsync(
    record: CanvasBackingTransitionRecord,
    category: CanvasBackingLeaseRecord["category"],
    currentBytes: number,
    nextBytes: number
  ): Promise<void> {
    if (nextBytes <= currentBytes) return;
    const admission = this.#admission;
    if (admission === null) throw new TypeError("canvas admission is unavailable");
    const bytes = nextBytes - currentBytes;
    const lease = await admission.reserve(category, bytes);
    if (
      this.#released ||
      record.settled ||
      this.#active !== record ||
      !this.#isGenerationCurrent()
    ) {
      lease.release();
      throw staleError(this.#generation);
    }
    record.additions.push({ category, bytes, lease });
  }

  #activate(
    additions: CanvasBackingLeaseRecord[],
    nextAnimated: number,
    nextStatic: number
  ): CanvasBackingTransitionRecord {
    const record: CanvasBackingTransitionRecord = {
      additions,
      nextAnimated,
      nextStatic,
      settled: false,
      rolledBack: false
    };
    this.#active = record;
    return record;
  }

  #transition(
    record: CanvasBackingTransitionRecord
  ): BrowserCanvasBackingResourceTransition {
    return Object.freeze({
      assertActive: (): void => this.#assertRecordActive(record),
      commit: (): void => this.#commit(record),
      rollback: (): void => this.#rollback(record)
    });
  }

  #commit(record: CanvasBackingTransitionRecord): void {
    if (record.settled) {
      if (record.rolledBack) throw staleError(this.#generation);
      return;
    }
    this.#assertRecordActive(record);
    trimCanvasBackingLeases(
      this.#account,
      this.#animated,
      this.#animatedBytes - Math.min(this.#animatedBytes, record.nextAnimated)
    );
    trimCanvasBackingLeases(
      this.#account,
      this.#statics,
      this.#staticBytes - Math.min(this.#staticBytes, record.nextStatic)
    );
    for (const addition of record.additions.splice(0)) {
      (addition.category === "animated-canvas-backing"
        ? this.#animated
        : this.#statics).push(addition);
    }
    this.#animatedBytes = record.nextAnimated;
    this.#staticBytes = record.nextStatic;
    record.settled = true;
    this.#active = null;
  }

  #rollback(record: CanvasBackingTransitionRecord): void {
    if (record.settled) return;
    record.settled = true;
    record.rolledBack = true;
    releaseCanvasBackingLeases(record.additions);
    if (this.#active === record) this.#active = null;
  }

  #reserveDirect(
    category: RuntimeByteCategory,
    bytes: number
  ): RuntimeByteLease {
    this.#assertAvailable();
    return this.#account.reserve(category, bytes);
  }

  #assertRecordActive(record: CanvasBackingTransitionRecord): void {
    this.#assertAvailable();
    if (record.settled || this.#active !== record) throw staleError(this.#generation);
  }

  #assertAvailable(): void {
    if (this.#released) {
      throw new DOMException("canvas backing resource host is released", "AbortError");
    }
    if (!this.#isGenerationCurrent()) throw staleError(this.#generation);
  }

  #isGenerationCurrent(): boolean {
    return this.#account.snapshot().participant?.generation === this.#generation;
  }
}

function reserveCanvasBackingGrowth(
  reserve: (category: RuntimeByteCategory, bytes: number) => RuntimeByteLease,
  additions: CanvasBackingLeaseRecord[],
  category: CanvasBackingLeaseRecord["category"],
  currentBytes: number,
  nextBytes: number
): void {
  if (nextBytes <= currentBytes) return;
  const bytes = nextBytes - currentBytes;
  additions.push({ category, bytes, lease: reserve(category, bytes) });
}

function trimCanvasBackingLeases(
  account: PlayerResourceAccount,
  leases: CanvasBackingLeaseRecord[],
  removeBytes: number
): void {
  let remaining = removeBytes;
  while (remaining > 0) {
    const record = leases.at(-1);
    if (record === undefined) {
      throw new RangeError("canvas backing lease accounting underflowed");
    }
    if (record.bytes <= remaining) {
      remaining -= record.bytes;
      leases.pop();
      record.lease.release();
      continue;
    }
    const nextBytes = record.bytes - remaining;
    shrinkPlayerResourceLease(account, record.lease, nextBytes);
    record.bytes = nextBytes;
    remaining = 0;
  }
}

function releaseCanvasBackingLeases(leases: CanvasBackingLeaseRecord[]): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try { leases[index]!.lease.release(); } catch {}
  }
  leases.length = 0;
}

function requireBackingBytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function staleError(generation: number): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "abort",
    undefined,
    { generation, operation: "stale-canvas-backing-generation" }
  ));
}

function disposedError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
}
