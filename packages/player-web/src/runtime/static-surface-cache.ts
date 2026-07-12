export interface StaticSurfaceCacheLease {
  release(): void;
}

export interface StaticSurfaceCacheSurface {
  close(): void;
}

export interface StaticSurfaceEviction {
  readonly staticFrame: string;
  readonly byteLength: number;
  readonly lastTouchSequence: number;
}

export interface StaticSurfaceCacheSnapshot {
  readonly disposed: boolean;
  readonly currentStaticFrame: string | null;
  readonly incomingStaticFrame: string | null;
  readonly retainedSurfaces: number;
  readonly peakRetainedSurfaces: number;
  readonly retainedBytes: number;
  readonly peakRetainedBytes: number;
  readonly installs: number;
  readonly hits: number;
  readonly misses: number;
  readonly pinTransitions: number;
  readonly evictions: number;
  readonly closes: number;
  readonly releases: number;
  readonly cleanupErrors: number;
}

interface CacheEntry<TSurface extends StaticSurfaceCacheSurface> {
  readonly staticFrame: string;
  readonly surface: TSurface;
  readonly byteLength: number;
  readonly insertionOrdinal: number;
  readonly close: () => void;
  readonly release: () => void;
  lastTouchSequence: number;
}

/** Deterministic ownership cache; current and incoming entries are hard pins. */
export class StaticSurfaceCache<
  TSurface extends StaticSurfaceCacheSurface = StaticSurfaceCacheSurface
> {
  readonly #entries = new Map<string, CacheEntry<TSurface>>();
  readonly #ownedSurfaces = new WeakSet<object>();

  #currentStaticFrame: string | null = null;
  #incomingStaticFrame: string | null = null;
  #nextInsertionOrdinal = 0;
  #retainedBytes = 0;
  #peakRetainedBytes = 0;
  #peakRetainedSurfaces = 0;
  #installs = 0;
  #hits = 0;
  #misses = 0;
  #pinTransitions = 0;
  #evictions = 0;
  #closes = 0;
  #releases = 0;
  #cleanupErrors = 0;
  #disposed = false;

  public install(
    staticFrame: string,
    surface: TSurface,
    byteLength: number,
    lease: StaticSurfaceCacheLease,
    touchSequence: number
  ): void {
    this.#assertActive();
    requireNonEmptyString(staticFrame, "static frame id");
    requirePositiveSafeInteger(byteLength, "static surface byte length");
    requireNonNegativeSafeInteger(touchSequence, "static surface touch sequence");
    const capturedLease = captureLease(lease);
    let capturedSurface: Readonly<{ close: () => void }>;
    try {
      capturedSurface = captureSurface(surface);
    } catch (error) {
      safelyCall(capturedLease.release);
      throw error;
    }

    if (this.#entries.has(staticFrame)) {
      cleanupCandidate(capturedSurface.close, capturedLease.release);
      throw new RangeError("static surface cache key is already installed");
    }
    if (this.#ownedSurfaces.has(surface)) {
      // The existing entry still owns this identity; closing it would corrupt
      // that live owner. Only the newly supplied lease can be retired here.
      safelyCall(capturedLease.release);
      throw new RangeError("static surface identity was already owned");
    }
    const nextBytes = checkedAdd(
      this.#retainedBytes,
      byteLength,
      "retained static surface bytes"
    );
    const insertionOrdinal = checkedIncrement(
      this.#nextInsertionOrdinal,
      "static surface insertion ordinal"
    );
    const installs = checkedIncrement(this.#installs, "static surface installs");

    this.#ownedSurfaces.add(surface);
    this.#entries.set(staticFrame, {
      staticFrame,
      surface,
      byteLength,
      insertionOrdinal,
      close: capturedSurface.close,
      release: capturedLease.release,
      lastTouchSequence: touchSequence
    });
    this.#nextInsertionOrdinal = insertionOrdinal;
    this.#retainedBytes = nextBytes;
    this.#peakRetainedBytes = Math.max(this.#peakRetainedBytes, nextBytes);
    this.#peakRetainedSurfaces = Math.max(
      this.#peakRetainedSurfaces,
      this.#entries.size
    );
    this.#installs = installs;
  }

  public get(staticFrame: string, touchSequence: number): TSurface | null {
    this.#assertActive();
    requireNonEmptyString(staticFrame, "static frame id");
    requireNonNegativeSafeInteger(touchSequence, "static surface touch sequence");
    const entry = this.#entries.get(staticFrame);
    if (entry === undefined) {
      this.#misses = checkedIncrement(this.#misses, "static surface misses");
      return null;
    }
    entry.lastTouchSequence = touchSequence;
    this.#hits = checkedIncrement(this.#hits, "static surface hits");
    return entry.surface;
  }

  public pinCurrent(staticFrame: string | null): void {
    this.#currentStaticFrame = this.#setPin(
      this.#currentStaticFrame,
      staticFrame,
      "current"
    );
  }

  public pinIncoming(staticFrame: string | null): void {
    this.#incomingStaticFrame = this.#setPin(
      this.#incomingStaticFrame,
      staticFrame,
      "incoming"
    );
  }

  public evictOldest(): Readonly<StaticSurfaceEviction> | null {
    this.#assertActive();
    let victim: CacheEntry<TSurface> | null = null;
    for (const entry of this.#entries.values()) {
      if (this.#isPinned(entry.staticFrame)) continue;
      if (
        victim === null ||
        entry.lastTouchSequence < victim.lastTouchSequence ||
        (
          entry.lastTouchSequence === victim.lastTouchSequence &&
          entry.insertionOrdinal < victim.insertionOrdinal
        )
      ) {
        victim = entry;
      }
    }
    if (victim === null) return null;
    const report = Object.freeze({
      staticFrame: victim.staticFrame,
      byteLength: victim.byteLength,
      lastTouchSequence: victim.lastTouchSequence
    });
    this.#evictions = checkedIncrement(this.#evictions, "static surface evictions");
    this.#retire(victim);
    return report;
  }

  public remove(staticFrame: string): boolean {
    this.#assertActive();
    requireNonEmptyString(staticFrame, "static frame id");
    const entry = this.#entries.get(staticFrame);
    if (entry === undefined || this.#isPinned(staticFrame)) return false;
    this.#retire(entry);
    return true;
  }

  public snapshot(): Readonly<StaticSurfaceCacheSnapshot> {
    return Object.freeze({
      disposed: this.#disposed,
      currentStaticFrame: this.#currentStaticFrame,
      incomingStaticFrame: this.#incomingStaticFrame,
      retainedSurfaces: this.#entries.size,
      peakRetainedSurfaces: this.#peakRetainedSurfaces,
      retainedBytes: this.#retainedBytes,
      peakRetainedBytes: this.#peakRetainedBytes,
      installs: this.#installs,
      hits: this.#hits,
      misses: this.#misses,
      pinTransitions: this.#pinTransitions,
      evictions: this.#evictions,
      closes: this.#closes,
      releases: this.#releases,
      cleanupErrors: this.#cleanupErrors
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#currentStaticFrame = null;
    this.#incomingStaticFrame = null;
    for (const entry of [...this.#entries.values()]) this.#retire(entry);
  }

  #setPin(
    previous: string | null,
    next: string | null,
    role: "current" | "incoming"
  ): string | null {
    this.#assertActive();
    if (next !== null) {
      requireNonEmptyString(next, `${role} static frame id`);
      if (!this.#entries.has(next)) {
        throw new RangeError(`${role} static surface is not installed`);
      }
    }
    if (previous !== next) {
      this.#pinTransitions = checkedIncrement(
        this.#pinTransitions,
        "static surface pin transitions"
      );
    }
    return next;
  }

  #isPinned(staticFrame: string): boolean {
    return staticFrame === this.#currentStaticFrame ||
      staticFrame === this.#incomingStaticFrame;
  }

  #retire(entry: CacheEntry<TSurface>): void {
    if (!this.#entries.delete(entry.staticFrame)) return;
    this.#retainedBytes -= entry.byteLength;
    this.#closes = checkedIncrement(this.#closes, "static surface closes");
    try {
      entry.close();
    } catch {
      this.#cleanupErrors = checkedIncrement(
        this.#cleanupErrors,
        "static surface cleanup errors"
      );
    }
    this.#releases = checkedIncrement(this.#releases, "static surface releases");
    try {
      entry.release();
    } catch {
      this.#cleanupErrors = checkedIncrement(
        this.#cleanupErrors,
        "static surface cleanup errors"
      );
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("static surface cache is disposed");
  }
}

function captureSurface<TSurface extends StaticSurfaceCacheSurface>(
  surface: TSurface
): Readonly<{ close: () => void }> {
  if (typeof surface !== "object" || surface === null) {
    throw new TypeError("static surface must be an object");
  }
  let close: unknown;
  try {
    close = Reflect.get(surface, "close");
  } catch {
    throw new TypeError("static surface close capability is inaccessible");
  }
  if (typeof close !== "function") {
    throw new TypeError("static surface close capability is unavailable");
  }
  return Object.freeze({
    close: () => Reflect.apply(close as (...args: never[]) => unknown, surface, [])
  });
}

function captureLease(lease: StaticSurfaceCacheLease): Readonly<{
  release: () => void;
}> {
  if (typeof lease !== "object" || lease === null) {
    throw new TypeError("static surface lease must be an object");
  }
  let release: unknown;
  try {
    release = Reflect.get(lease, "release");
  } catch {
    throw new TypeError("static surface lease release is inaccessible");
  }
  if (typeof release !== "function") {
    throw new TypeError("static surface lease release is unavailable");
  }
  let released = false;
  return Object.freeze({
    release: () => {
      if (released) return;
      released = true;
      Reflect.apply(release as (...args: never[]) => unknown, lease, []);
    }
  });
}

function cleanupCandidate(close: () => void, release: () => void): void {
  safelyCall(close);
  safelyCall(release);
}

function safelyCall(callback: () => void): void {
  try {
    callback();
  } catch {
    // Candidate rejection and terminal cleanup continue across host failures.
  }
}

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe-integer range`);
  }
  return result;
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeds the safe-integer range`);
  }
  return value + 1;
}
