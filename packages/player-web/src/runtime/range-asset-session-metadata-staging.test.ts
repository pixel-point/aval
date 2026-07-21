import {
  FORMAT_HEADER_LENGTH,
  parseFrontIndex
} from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import type { RuntimeFetchAdapter } from "./asset-fetch-contracts.js";
import {
  CountingResources,
  type FetchCall,
  FINAL_URL,
  flushMicrotasks,
  fullResponse,
  ManualTimerHost,
  partialResponse,
  PassiveTimerHost,
  rangeFixture,
  request,
  requireRangeSession,
  response,
  runtimeRequestedRange,
  scriptedFetch,
  scriptedReader
} from "./range-asset-session.test-support.js";
import { openRangeAssetSession } from "./range-asset-session.js";

describe("range metadata staging", () => {
  it("opens with exact header, manifest-prefix, and front-index ranges under one strong ETag", async () => {
    const fixture = rangeFixture();
    const resources = new CountingResources();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.manifestTail,
        FORMAT_HEADER_LENGTH,
        fixture.total,
        '"entity-v1"'
      ),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      )
    ]);

    const opened = await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 7,
      isGenerationCurrent: (generation) => generation === 7,
      timers: new PassiveTimerHost()
    });
    const session = requireRangeSession(opened);

    expect(fetcher.calls.map(({ init }) => init.headers)).toEqual([
      { Range: "bytes=0-63" },
      {
        Range: `bytes=64-${String(fixture.indexOffset - 1)}`,
        "If-Range": '"entity-v1"'
      },
      {
        Range: `bytes=${String(fixture.indexOffset)}-${String(fixture.frontEnd - 1)}`,
        "If-Range": '"entity-v1"'
      }
    ]);
    expect(session.identity).toEqual({
      mode: "range",
      generation: 7,
      finalUrl: FINAL_URL,
      declaredTotalBytes: fixture.total,
      strongEntityTag: '"entity-v1"'
    });
    expect(session.frontIndex).toEqual(parseFrontIndex(fixture.asset));
    expect(session.metadataByteLength).toBe(fixture.frontEnd);
    expect(resources.liveBytes).toBe(fixture.frontEnd);
    session.releaseMetadata();
    expect(session.metadataByteLength).toBe(fixture.frontEnd);
    expect(resources.liveBytes).toBe(0);

    await session.dispose();
    await session.dispose();
    expect(resources.liveBytes).toBe(0);
  });

  it("bounds sequential metadata requests by one cumulative absolute deadline", async () => {
    const fixture = rangeFixture();
    const timers = new ManualTimerHost();
    const first = partialResponse(
      fixture.header, 0, fixture.total, '"entity-v1"'
    );
    const second = partialResponse(
      fixture.manifestTail, 64, fixture.total, '"entity-v1"'
    );
    const scripted = scriptedFetch([first, second]);
    const fetcher: RuntimeFetchAdapter = {
      fetch(url, init) {
        timers.advance(scripted.calls.length === 0 ? 6 : 5);
        return scripted.fetch(url, init);
      }
    };
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(undefined, 10),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers
    })).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });

    await flushMicrotasks();
    expect(scripted.calls).toHaveLength(2);
    expect(second.reader.cancelCount).toBe(1);
    expect(second.reader.releaseLockCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  it("accepts sequential metadata work completed before the same boundary", async () => {
    const fixture = rangeFixture();
    const timers = new ManualTimerHost();
    const scripted = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      )
    ]);
    const fetcher: RuntimeFetchAdapter = {
      fetch(url, init) {
        timers.advance(3);
        return scripted.fetch(url, init);
      }
    };
    const resources = new CountingResources();
    const opened = await openRangeAssetSession({
      request: request(undefined, 10),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers
    });
    const session = requireRangeSession(opened);
    expect(scripted.calls).toHaveLength(3);
    expect(timers.now()).toBe(9);
    expect(timers.pendingCount).toBe(0);
    await session.dispose();
    expect(resources.liveBytes).toBe(0);
  });

  it("rejects a hostile raw index length before a large range or allocation", async () => {
    const fixture = rangeFixture();
    const hostileHeader = fixture.header.slice();
    const headerView = new DataView(
      hostileHeader.buffer,
      hostileHeader.byteOffset,
      hostileHeader.byteLength
    );
    const indexOffset = Number(headerView.getBigUint64(48, true));
    const maliciousIndexLength = 16 + 80_000 * 48;
    const maliciousFrontEnd = indexOffset + maliciousIndexLength;
    headerView.setBigUint64(24, BigInt(maliciousFrontEnd), true);
    headerView.setBigUint64(56, BigInt(maliciousIndexLength), true);

    const calls: FetchCall[] = [];
    const fetcher: RuntimeFetchAdapter = {
      async fetch(url, init) {
        calls.push({ url, init });
        const [start, end] = runtimeRequestedRange(init);
        const rangeBytes = start === 0
          ? hostileHeader
          : fixture.asset.slice(start, Math.min(end + 1, fixture.asset.byteLength));
        const reader = scriptedReader(rangeBytes);
        return response(206, reader, {
          etag: '"entity-v1"',
          contentLength: end - start + 1,
          contentRange: `bytes ${String(start)}-${String(end)}/${String(maliciousFrontEnd)}`
        });
      }
    };
    const resources = new CountingResources();
    const allocations: number[] = [];

    await expect(openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost(),
      allocate(byteLength) {
        allocations.push(byteLength);
        if (byteLength > fixture.frontEnd) {
          throw new Error("raw index allocation was attempted");
        }
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    })).rejects.toMatchObject({
      code: "invalid-asset",
      failure: { context: { lifecyclePhase: "manifest-prefix" } }
    });

    expect(calls.map(({ init }) => init.headers)).toEqual([
      { Range: "bytes=0-63" },
      {
        Range: `bytes=64-${String(indexOffset - 1)}`,
        "If-Range": '"entity-v1"'
      }
    ]);
    expect(allocations.every((byteLength) => byteLength <= fixture.frontEnd)).toBe(true);
    expect(resources.peakBytes).toBeLessThan(maliciousIndexLength);
    expect(resources.liveBytes).toBe(0);
  });

  it("rejects corrupt front-index bytes after exact transport cleanup", async () => {
    const fixture = rangeFixture();
    const corruptFront = fixture.indexBytes.slice();
    corruptFront[0] = 0xff;
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
        partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
        partialResponse(
          corruptFront,
          fixture.indexOffset,
          fixture.total,
          '"entity-v1"'
        )
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: "invalid-asset",
      failure: { context: { lifecyclePhase: "front-index" } }
    });

    expect(resources.liveBytes).toBe(0);
  });

  it("accepts an index-stage 200 only as an exact pinned-entity full replacement", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      fullResponse(fixture.asset, '"entity-v1"')
    ]);
    const resources = new CountingResources();

    const opened = await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 2,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    });

    expect(opened.mode).toBe("full");
    expect(fetcher.calls).toHaveLength(3);
    expect(fetcher.calls[2]!.init.headers).toEqual({
      Range: `bytes=${String(fixture.indexOffset)}-${String(fixture.frontEnd - 1)}`,
      "If-Range": '"entity-v1"'
    });
    if (opened.mode === "full") opened.release();
    expect(resources.liveBytes).toBe(0);
  });

  it.each([
    { start: FORMAT_HEADER_LENGTH + 1 },
    { totalDelta: 1 },
    { url: "https://other.example.test/motion.avl" },
    { etag: '"entity-v2"' },
    { contentEncoding: "gzip" }
  ] as const)("rejects invalid manifest-prefix response contract %#", async (change) => {
    const fixture = rangeFixture();
    const second = partialResponse(
      fixture.manifestTail,
      change.start ?? FORMAT_HEADER_LENGTH,
      fixture.total + (change.totalDelta ?? 0),
      change.etag ?? '"entity-v1"',
      {
        ...(change.url === undefined ? {} : { url: change.url }),
        ...(change.contentEncoding === undefined
          ? {}
          : { contentEncoding: change.contentEncoding })
      }
    );
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
        second.response
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: change.url !== undefined || change.etag !== undefined
        ? "entity-changed"
        : "range-response-invalid"
    });

    expect(second.reader.cancelCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
  });
});
