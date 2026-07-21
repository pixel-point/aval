import { describe, expect, it } from "vitest";

import {
  normalizeRuntimeAssetRequest,
  type RuntimeFetchAdapter,
  type RuntimeFetchResponseView
} from "./asset-fetch-contracts.js";
import type { RuntimeBodyReadResult } from "./bounded-body-reader.js";
import {
  CountingResources,
  deferred,
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
  scriptedFetch,
  type ScriptedReader
} from "./range-asset-session.test-support.js";
import { openRangeAssetSession } from "./range-asset-session.js";

describe("entity-pinned range metadata session", () => {
  it("does not restart the deadline for a no-validator full fallback", async () => {
    const fixture = rangeFixture();
    const timers = new ManualTimerHost();
    const initial = partialResponse(fixture.header, 0, fixture.total, null);
    const fallback = fullResponse(fixture.asset, null);
    const scripted = scriptedFetch([initial, fallback]);
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

    expect(scripted.calls.map(({ init }) => init.headers)).toEqual([
      { Range: "bytes=0-63" },
      {}
    ]);
    expect(initial.reader.cancelCount).toBe(1);
    expect(fallback.reader.cancelCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  it("keeps caller abort linked after metadata readiness and releases idle metadata", async () => {
    const fixture = rangeFixture();
    const controller = new AbortController();
    const resources = new CountingResources();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      )
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: normalizeRuntimeAssetRequest({
        url: FINAL_URL,
        signal: controller.signal
      }),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));
    expect(resources.liveBytes).toBe(fixture.frontEnd);

    controller.abort();
    await session.dispose();
    expect(session.disposed).toBe(true);
    expect(resources.liveBytes).toBe(0);
    await expect(session.fetchPayloadRange({
      start: fixture.payloadStart,
      end: fixture.payloadEnd
    })).rejects.toMatchObject({ code: "disposed" });
    expect(fetcher.calls).toHaveLength(3);
  });

  it("accepts an initial ignored-range 200 only as one standalone full asset", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      fullResponse(fixture.asset, '"full-v1"')
    ]);
    const resources = new CountingResources();

    const opened = await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    });

    expect(opened.mode).toBe("full");
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.init.headers).toEqual({ Range: "bytes=0-63" });
    if (opened.mode === "full") opened.release();
    expect(resources.liveBytes).toBe(0);
  });

  it.each([null, 'W/"weak"', "malformed"])(
    "discards an initial 206 with unavailable strong ETag %j and restarts once without Range",
    async (etag) => {
      const fixture = rangeFixture();
      const initial = partialResponse(fixture.header, 0, fixture.total, etag);
      const fetcher = scriptedFetch([
        initial.response,
        fullResponse(fixture.asset, null)
      ]);
      const resources = new CountingResources();

      const opened = await openRangeAssetSession({
        request: request(),
        fetcher,
        resources,
        generation: 1,
        isGenerationCurrent: () => true,
        timers: new PassiveTimerHost()
      });

      expect(opened.mode).toBe("full");
      expect(fetcher.calls.map(({ init }) => init.headers)).toEqual([
        { Range: "bytes=0-63" },
        {}
      ]);
      expect(initial.reader.readCount).toBe(0);
      expect(initial.reader.cancelCount).toBe(1);
      expect(initial.reader.releaseLockCount).toBe(1);
      if (opened.mode === "full") opened.release();
      expect(resources.liveBytes).toBe(0);
    }
  );

  it("accepts a browser-decoded gzip 200 after a weak-validator range restart", async () => {
    const fixture = rangeFixture();
    const initial = partialResponse(fixture.header, 0, fixture.total, 'W/"weak"');
    const fallback = fullResponse(fixture.asset, null, undefined, {
      contentEncoding: "gzip",
      contentLength: 1
    });
    const fetcher = scriptedFetch([initial.response, fallback.response]);
    const resources = new CountingResources();

    const opened = await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    });

    expect(opened.mode).toBe("full");
    expect(fetcher.calls.map(({ init }) => init.headers)).toEqual([
      { Range: "bytes=0-63" },
      {}
    ]);
    if (opened.mode === "full") opened.release();
    expect(resources.liveBytes).toBe(0);
  });

  it("allows only one no-validator restart and rejects a second 206", async () => {
    const fixture = rangeFixture();
    const first = partialResponse(fixture.header, 0, fixture.total, null);
    const second = partialResponse(fixture.header, 0, fixture.total, '"late"');
    const fetcher = scriptedFetch([first.response, second.response]);

    await expect(openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({ code: "range-response-invalid" });

    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[1]!.init.headers).toEqual({});
    expect(second.reader.cancelCount).toBe(1);
  });

  it("rejects header total disagreement and invalid format headers before front-index Fetch", async () => {
    const fixture = rangeFixture();
    const resources = new CountingResources();
    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total + 1, '"entity-v1"')
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({ code: "range-response-invalid" });
    expect(resources.liveBytes).toBe(0);

    const corruptHeader = fixture.header.slice();
    corruptHeader[0] = 0;
    const corruptResources = new CountingResources();
    const fetcher = scriptedFetch([
      partialResponse(corruptHeader, 0, fixture.total, '"entity-v1"')
    ]);
    await expect(openRangeAssetSession({
      request: request(),
      fetcher,
      resources: corruptResources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: "invalid-asset",
      failure: { context: { sourceCode: "HEADER_INVALID" } }
    });
    expect(fetcher.calls).toHaveLength(1);
    expect(corruptResources.liveBytes).toBe(0);
  });

  it("accepts a later 200 only as an exact pinned-entity full replacement", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
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
    expect(fetcher.calls).toHaveLength(2);
    if (opened.mode === "full") opened.release();
    expect(resources.liveBytes).toBe(0);
  });

  it.each([
    { url: "https://other.example.test/motion.avl", etag: '"entity-v1"' },
    { etag: '"entity-v2"' },
    { etag: null },
    { etag: 'W/"entity-v1"' }
  ] as const)("rejects changed later-200 identity %# before reading", async (change) => {
    const fixture = rangeFixture();
    const replacement = fullResponse(fixture.asset, change.etag, change.url);
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
        replacement.response
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({ code: "entity-changed" });

    expect(replacement.reader.readCount).toBe(0);
    expect(replacement.reader.cancelCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
  });

  it("fetches later exact ranges with If-Range and transfers the verified entity bytes", async () => {
    const fixture = rangeFixture();
    const payload = fixture.asset.slice(
      fixture.payloadStart,
      fixture.payloadEnd + 1
    );
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      ),
      partialResponse(payload, fixture.payloadStart, fixture.total, '"entity-v1"')
    ]);
    const resources = new CountingResources();
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 5,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));

    const loaded = await session.fetchPayloadRange({
      start: fixture.payloadStart,
      end: fixture.payloadEnd
    });
    expect(loaded.mode).toBe("range");
    expect(fetcher.calls[3]!.init.headers).toEqual({
      Range: `bytes=${String(fixture.payloadStart)}-${String(fixture.payloadEnd)}`,
      "If-Range": '"entity-v1"'
    });
    if (loaded.mode === "range") {
      expect(loaded.bytes).toEqual(payload);
      loaded.release();
    }
    await session.dispose();
    expect(resources.liveBytes).toBe(0);
  });

  it("rejects metadata-overlapping payload ranges before Fetch", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      )
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));

    await expect(session.fetchPayloadRange({
      start: fixture.frontEnd - 1,
      end: fixture.frontEnd
    })).rejects.toMatchObject({ code: "range-response-invalid" });
    expect(fetcher.calls).toHaveLength(3);
    await session.dispose();
  });

  it("cancels one payload operation signal while preserving session retry", async () => {
    const fixture = rangeFixture();
    const range = { start: fixture.payloadStart, end: fixture.payloadEnd };
    const payload = fixture.asset.slice(range.start, range.end + 1);
    const pendingRead = deferred<RuntimeBodyReadResult>();
    let cancelCount = 0;
    let releaseLockCount = 0;
    const pendingReader: ScriptedReader = {
      get readCount() { return 1; },
      get cancelCount() { return cancelCount; },
      get releaseLockCount() { return releaseLockCount; },
      read: () => pendingRead.promise,
      async cancel() { cancelCount += 1; },
      releaseLock() { releaseLockCount += 1; }
    };
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      ),
      response(206, pendingReader, {
        etag: '"entity-v1"',
        contentLength: payload.byteLength,
        contentRange: `bytes ${String(range.start)}-${String(range.end)}/${String(fixture.total)}`
      }),
      partialResponse(payload, range.start, fixture.total, '"entity-v1"')
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));
    const controller = new AbortController();
    const aborted = session.fetchPayloadRange(range, {
      signal: controller.signal
    });
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    expect(cancelCount).toBe(1);
    pendingRead.resolve({ done: true, value: undefined });
    await expect(aborted).rejects.toMatchObject({ code: "abort" });
    expect(releaseLockCount).toBe(1);
    expect(session.disposed).toBe(false);

    const retried = await session.fetchPayloadRange(range);
    expect(retried.mode).toBe("range");
    if (retried.mode === "range") retried.release();
    await session.dispose();
  });

  it("replaces a live range session when a later payload request returns exact pinned 200", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      ),
      fullResponse(fixture.asset, '"entity-v1"')
    ]);
    const resources = new CountingResources();
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));

    const replacement = await session.fetchPayloadRange({
      start: fixture.payloadStart,
      end: fixture.payloadEnd
    });
    expect(replacement.mode).toBe("full");
    expect(session.disposed).toBe(true);
    if (replacement.mode === "full") replacement.release();
    expect(resources.liveBytes).toBe(0);
  });

  it("caps concurrent payload bodies at four without issuing a fifth Fetch", async () => {
    const fixture = rangeFixture();
    const pending = Array.from({ length: 4 }, () =>
      deferred<RuntimeFetchResponseView>()
    );
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.manifestTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.indexBytes,
        fixture.indexOffset,
        fixture.total,
        '"entity-v1"'
      ),
      ...pending.map(({ promise }) => promise)
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));
    const range = { start: fixture.payloadStart, end: fixture.payloadEnd };
    const operations = pending.map(() => session.fetchPayloadRange(range));

    await expect(session.fetchPayloadRange(range)).rejects.toMatchObject({
      code: "resource-rejection"
    });
    expect(fetcher.calls).toHaveLength(7);

    const bytes = fixture.asset.slice(range.start, range.end + 1);
    pending.forEach((entry) => entry.resolve(
      partialResponse(bytes, range.start, fixture.total, '"entity-v1"').response
    ));
    const results = await Promise.all(operations);
    for (const result of results) if (result.mode === "range") result.release();
    await session.dispose();
  });

  it("uses one range-free externally gated full path", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      fullResponse(fixture.asset, null)
    ]);
    const opened = await openRangeAssetSession({
      request: request("sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost(),
      digestAdapter: { digestSha256: async () => new Uint8Array(32) }
    });

    expect(opened.mode).toBe("full");
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.init.headers).toEqual({});
    if (opened.mode === "full") opened.release();
  });
});
