import { FORMAT_DEFAULT_BUDGETS } from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAXIMUM_CONCURRENT_PAYLOAD_BODIES,
  normalizeRuntimeAssetRequest,
  snapshotRuntimeFetchResponse
} from "./asset-fetch-contracts.js";

describe("runtime asset fetch contracts", () => {
  it("normalizes one closed request and finite loader policy", () => {
    const controller = new AbortController();
    const normalized = normalizeRuntimeAssetRequest({
      url: new URL("https://cdn.example.test/motion.rma"),
      integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      signal: controller.signal,
      timeoutMs: 7_500,
      credentials: "omit"
    });

    expect(normalized).toMatchObject({
      url: "https://cdn.example.test/motion.rma",
      signal: controller.signal,
      credentials: "omit",
      integrity: {
        algorithm: "sha256",
        token: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        digestBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        sha256Hex: "00".repeat(32)
      },
      policy: {
        maximumFileBytes: FORMAT_DEFAULT_BUDGETS.maxFileBytes,
        maximumRangeBytes: 4 * 1024 * 1024,
        maximumConcurrentPayloadBodies: 4,
        overallTimeoutMs: 7_500,
        firstByteTimeoutMs: 2_000,
        idleBodyTimeoutMs: 2_000
      }
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.policy)).toBe(true);
  });

  it("defaults credentials, signal, integrity, and timeout deterministically", () => {
    const normalized = normalizeRuntimeAssetRequest({
      url: "http://127.0.0.1:4173/asset.rma"
    });
    expect(normalized.credentials).toBe("same-origin");
    expect(normalized.signal).toBeNull();
    expect(normalized.integrity).toBeNull();
    expect(normalized.policy.overallTimeoutMs).toBe(5_000);
    expect(DEFAULT_MAXIMUM_CONCURRENT_PAYLOAD_BODIES).toBe(4);
  });

  it("preserves credentialed CORS fetch mode", () => {
    expect(normalizeRuntimeAssetRequest({
      url: "https://cdn.example.test/credentialed.rma",
      credentials: "include"
    }).credentials).toBe("include");
  });

  it("allows a lower file cap but never a larger format cap", () => {
    expect(normalizeRuntimeAssetRequest(
      { url: "https://example.test/a.rma" },
      { maximumFileBytes: 1024 }
    ).policy.maximumFileBytes).toBe(1024);
    expect(() => normalizeRuntimeAssetRequest(
      { url: "https://example.test/a.rma" },
      { maximumFileBytes: FORMAT_DEFAULT_BUDGETS.maxFileBytes + 1 }
    )).toThrow();
  });

  it.each([
    { url: "relative.rma" },
    { url: "data:text/plain,no" },
    { url: "https://example.test/a.rma", timeoutMs: 0 },
    { url: "https://example.test/a.rma", timeoutMs: 1.5 },
    { url: "https://example.test/a.rma", credentials: "invalid" },
    { url: "https://example.test/a.rma", integrity: "sha256-nope" },
    { url: "https://example.test/a.rma", surprise: true }
  ])("rejects hostile request %#", (request) => {
    expect(() => normalizeRuntimeAssetRequest(request as never)).toThrow();
  });

  it("captures response fields, four headers, and one reader without retaining Response", async () => {
    const requestedHeaders: string[] = [];
    let readerCalls = 0;
    const reader = {
      read: () => Promise.resolve({ done: true as const, value: undefined }),
      cancel: () => Promise.resolve(),
      releaseLock: () => undefined
    };
    const captured = await snapshotRuntimeFetchResponse({
      status: 206,
      type: "cors",
      url: "https://cdn.example.test/final.rma",
      headers: {
        get(name) {
          requestedHeaders.push(name);
          return ({
            "Content-Encoding": null,
            "Content-Length": "64",
            "Content-Range": "bytes 0-63/128",
            ETag: '"one"'
          } as Record<string, string | null>)[name] ?? null;
        }
      },
      body: {
        getReader() {
          readerCalls += 1;
          return reader;
        }
      }
    });

    expect(captured).toMatchObject({
      status: 206,
      type: "cors",
      finalUrl: "https://cdn.example.test/final.rma",
      bodyReader: reader
    });
    expect(captured.headers).toEqual({
      contentEncoding: null,
      contentLength: "64",
      contentRange: "bytes 0-63/128",
      entityTag: '"one"'
    });
    expect(requestedHeaders).toEqual([
      "Content-Encoding",
      "Content-Length",
      "Content-Range",
      "ETag"
    ]);
    expect(readerCalls).toBe(1);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.headers)).toBe(true);
  });

  it("rejects hostile response/body access without exposing body text", async () => {
    const response = Object.create(null);
    let cancelCalls = 0;
    let releaseLockCalls = 0;
    Object.defineProperty(response, "status", {
      get(): never { throw new Error("secret response"); }
    });
    response.body = {
      getReader: () => ({
        read: () => Promise.resolve({ done: true as const }),
        cancel: () => {
          cancelCalls += 1;
          return Promise.resolve();
        },
        releaseLock: () => {
          releaseLockCalls += 1;
        }
      })
    };
    await expect(snapshotRuntimeFetchResponse(response)).rejects.toThrow(
      "fetch response access failed"
    );
    expect(cancelCalls).toBe(1);
    expect(releaseLockCalls).toBe(1);

    await expect(snapshotRuntimeFetchResponse({
      status: 200,
      type: "basic",
      url: "https://example.test/a.rma",
      headers: { get: () => null },
      body: null
    })).rejects.toThrow("fetch response body is unavailable");
  });

  it("cancels and unlocks a detached reader when later header access fails", async () => {
    let cancelCalls = 0;
    let releaseLockCalls = 0;
    const cancellation = Promise.resolve();

    await expect(snapshotRuntimeFetchResponse({
      status: 206,
      type: "cors",
      url: "https://example.test/a.rma",
      headers: {
        get(): never {
          throw new Error("secret header");
        }
      },
      body: {
        getReader() {
          return {
            read: () => Promise.resolve({ done: true as const }),
            cancel() {
              cancelCalls += 1;
              return cancellation;
            },
            releaseLock() {
              releaseLockCalls += 1;
            }
          };
        }
      }
    })).rejects.toThrow("response header access failed");

    expect(cancelCalls).toBe(1);
    expect(releaseLockCalls).toBe(1);
  });

  it("continues reader retirement when cancel and releaseLock reject", async () => {
    let releaseLockCalls = 0;
    await expect(snapshotRuntimeFetchResponse({
      status: 206,
      type: "cors",
      url: "https://example.test/a.rma",
      headers: {
        get(): never {
          throw new Error("secret header");
        }
      },
      body: {
        getReader() {
          return {
            read: () => Promise.resolve({ done: true as const }),
            cancel: () => Promise.reject(new Error("secret cancel")),
            releaseLock() {
              releaseLockCalls += 1;
              throw new Error("secret unlock");
            }
          };
        }
      }
    })).rejects.toThrow("response header access failed");

    expect(releaseLockCalls).toBe(1);
  });
});
