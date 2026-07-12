import { describe, expect, it } from "vitest";

import {
  StaticSurfaceCache,
  type StaticSurfaceCacheLease
} from "./static-surface-cache.js";

describe("decoded static surface LRU cache", () => {
  it("evicts oldest unpinned entries while retaining current and incoming", () => {
    const cache = new StaticSurfaceCache<TestSurface>();
    const a = resource("a");
    const b = resource("b");
    const c = resource("c");
    cache.install("a", a.surface, 40, a.lease, 1);
    cache.install("b", b.surface, 40, b.lease, 2);
    cache.install("c", c.surface, 40, c.lease, 3);
    cache.pinCurrent("b");
    cache.pinIncoming("c");

    expect(cache.evictOldest()).toEqual({
      staticFrame: "a",
      byteLength: 40,
      lastTouchSequence: 1
    });
    expect(a.snapshot()).toEqual({ closes: 1, releases: 1 });
    expect(cache.evictOldest()).toBeNull();

    cache.pinIncoming(null);
    expect(cache.evictOldest()?.staticFrame).toBe("c");
    cache.pinCurrent(null);
    expect(cache.evictOldest()?.staticFrame).toBe("b");
    expect(cache.snapshot()).toMatchObject({
      retainedSurfaces: 0,
      retainedBytes: 0,
      evictions: 3,
      closes: 3,
      releases: 3
    });
  });

  it("updates deterministic recency on cache hits", () => {
    const cache = new StaticSurfaceCache<TestSurface>();
    const a = resource("a");
    const b = resource("b");
    cache.install("a", a.surface, 4, a.lease, 1);
    cache.install("b", b.surface, 4, b.lease, 2);
    expect(cache.get("a", 3)).toBe(a.surface);
    expect(cache.evictOldest()?.staticFrame).toBe("b");
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 0 });
    expect(cache.get("missing", 4)).toBeNull();
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 1 });
    cache.dispose();
  });

  it("uses insertion order as the stable tie-break", () => {
    const cache = new StaticSurfaceCache<TestSurface>();
    const first = resource("first");
    const second = resource("second");
    cache.install("z", first.surface, 4, first.lease, 10);
    cache.install("a", second.surface, 4, second.lease, 10);
    expect(cache.evictOldest()?.staticFrame).toBe("z");
    cache.dispose();
  });

  it("tracks pin transitions, retained peaks, and immutable snapshots", () => {
    const cache = new StaticSurfaceCache<TestSurface>();
    const one = resource("one");
    const two = resource("two");
    cache.install("one", one.surface, 7, one.lease, 1);
    cache.install("two", two.surface, 11, two.lease, 2);
    cache.pinCurrent("one");
    cache.pinCurrent("two");
    cache.pinIncoming("one");
    const snapshot = cache.snapshot();
    expect(snapshot).toMatchObject({
      currentStaticFrame: "two",
      incomingStaticFrame: "one",
      retainedSurfaces: 2,
      peakRetainedSurfaces: 2,
      retainedBytes: 18,
      peakRetainedBytes: 18,
      pinTransitions: 3
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    cache.dispose();
  });

  it("rejects duplicate keys, reused surface identities, and pinned removal", () => {
    const cache = new StaticSurfaceCache<TestSurface>();
    const first = resource("first");
    const duplicate = resource("duplicate");
    cache.install("one", first.surface, 4, first.lease, 1);
    expect(() => cache.install("one", duplicate.surface, 4, duplicate.lease, 2))
      .toThrow();
    expect(duplicate.snapshot()).toEqual({ closes: 1, releases: 1 });
    const reusedLease = countingLease();
    expect(() => cache.install("two", first.surface, 4, reusedLease.lease, 2))
      .toThrow();
    expect(reusedLease.releases()).toBe(1);
    cache.pinCurrent("one");
    expect(cache.remove("one")).toBe(false);
    cache.pinCurrent(null);
    expect(cache.remove("one")).toBe(true);
  });

  it("releases a captured lease when surface capability capture fails", () => {
    const cache = new StaticSurfaceCache<TestSurface>();
    const lease = countingLease();
    const hostile = Object.create(null) as TestSurface;
    Object.defineProperty(hostile, "close", {
      get(): never { throw new Error("hostile close getter"); }
    });

    expect(() => cache.install("bad", hostile, 4, lease.lease, 1)).toThrow();
    expect(lease.releases()).toBe(1);
    expect(cache.snapshot()).toMatchObject({
      retainedSurfaces: 0,
      retainedBytes: 0
    });
  });

  it("continues disposal after hostile close and release callbacks", () => {
    const cache = new StaticSurfaceCache<TestSurface>();
    const events: string[] = [];
    cache.install("a", {
      width: 1,
      height: 1,
      close() {
        events.push("close-a");
        throw new Error("close");
      }
    }, 4, {
      release() {
        events.push("release-a");
        throw new Error("release");
      }
    }, 1);
    cache.install("b", {
      width: 1,
      height: 1,
      close() { events.push("close-b"); }
    }, 4, {
      release() { events.push("release-b"); }
    }, 2);

    cache.dispose();
    cache.dispose();
    expect(events).toEqual(["close-a", "release-a", "close-b", "release-b"]);
    expect(cache.snapshot()).toMatchObject({
      disposed: true,
      retainedSurfaces: 0,
      closes: 2,
      releases: 2,
      cleanupErrors: 2
    });
  });
});

interface TestSurface {
  readonly width: number;
  readonly height: number;
  close(): void;
}

function resource(label: string): {
  readonly surface: TestSurface;
  readonly lease: StaticSurfaceCacheLease;
  readonly snapshot: () => { closes: number; releases: number };
} {
  let closes = 0;
  let releases = 0;
  return {
    surface: {
      width: 1,
      height: 1,
      close() {
        void label;
        closes += 1;
      }
    },
    lease: { release() { releases += 1; } },
    snapshot: () => ({ closes, releases })
  };
}

function countingLease(): {
  readonly lease: StaticSurfaceCacheLease;
  readonly releases: () => number;
} {
  let releases = 0;
  return {
    lease: { release() { releases += 1; } },
    releases: () => releases
  };
}
