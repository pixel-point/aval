import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from "../../format/src/canonical-json.js";
import { writeCanonicalAsset } from "../../format/src/writer.js";
import type { CanonicalAssetInput } from "../../format/src/model.js";
import { Asset } from "../src/asset.js";

const URL = "https://example.test/motion.avl";
const CODEC = "avc1.640020";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Asset manifest parity", () => {
  it("accepts the exact constrained-baseline H264 codec grammar", async () => {
    const body = assetBytes(
      1,
      new Uint8Array([1, 2, 3, 4]),
      undefined,
      [1, 1],
      "avc1.42E01E"
    );
    vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(body)));

    const asset = await open(`sha256-${"A".repeat(43)}=`);
    expect(asset.manifest.renditions[0]?.codec).toBe("avc1.42E01E");
    await asset.dispose();
  });

  it("accepts positive non-reduced pixel-aspect terms admitted by the canonical format", async () => {
    const body = assetBytes(1, new Uint8Array([1, 2, 3, 4]), undefined, [2, 2]);
    vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(body)));

    const asset = await open(`sha256-${"A".repeat(43)}=`);
    expect(asset.manifest.canvas.pixelAspect).toEqual([2, 2]);
    await asset.dispose();
  });

  it("does not treat transitioned one-frame completion routes as immediate cycle links", async () => {
    const body = transitionedCompletionCycleBytes();
    vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(body)));

    const asset = await open(`sha256-${"A".repeat(43)}=`);
    expect(asset.manifest.edges.map((edge) => edge.transition?.kind)).toEqual(["locked", "locked"]);
    await asset.dispose();
  });

  it("admits and freezes a qualified 1.1 packed-alpha witness in full and range modes", async () => {
    const body = qualifiedPackedAssetBytes();
    vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(body)));

    const full = await open(`sha256-${"A".repeat(43)}=`);
    expect(full.mode).toBe("full");
    expect(full.manifest.formatVersion).toBe("1.1");
    expect(full.manifest.renditions[0]?.outputQualification).toMatchObject({
      kind: "packed-alpha-v1",
      unit: "body-00",
      frame: 0,
      samples: [{ x: 0, y: 0, expectedRange: [0, 32] }]
    });
    expect(Object.isFrozen(full.manifest.renditions[0]?.outputQualification)).toBe(true);
    expect(Object.isFrozen(
      full.manifest.renditions[0]?.outputQualification?.samples[0]?.expectedRange
    )).toBe(true);
    await full.dispose();

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      rangeResponse(body, requestedRange(init))
    ));
    const range = await open();
    expect(range.mode).toBe("range");
    expect(range.manifest.formatVersion).toBe("1.1");
    expect(range.manifest.renditions[0]?.outputQualification?.unit).toBe("body-00");
    await range.dispose();
  });

  it("retains strict legacy 1.0 inspection without inventing a witness", async () => {
    const body = assetBytes(1, new Uint8Array([1, 2, 3, 4]));
    vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(body)));

    const asset = await open(`sha256-${"A".repeat(43)}=`);
    expect(asset.manifest.formatVersion).toBe("1.0");
    expect(asset.manifest.renditions[0]?.outputQualification).toBeUndefined();
    await asset.dispose();

    const legacyPacked = rewriteManifest(qualifiedPackedAssetBytes(), (manifest) => {
      manifest.formatVersion = "1.0";
      delete manifest.renditions[0].outputQualification;
    });
    vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(legacyPacked)));
    const packed = await open(`sha256-${"A".repeat(43)}=`);
    expect(packed.manifest).toMatchObject({
      formatVersion: "1.0",
      layout: "packed-alpha"
    });
    expect(packed.manifest.renditions[0]?.outputQualification).toBeUndefined();
    await packed.dispose();

    const qualifiedOpaque = rewriteManifest(body, (manifest) => {
      manifest.formatVersion = "1.1";
    });
    vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(qualifiedOpaque)));
    const opaque = await open(`sha256-${"A".repeat(43)}=`);
    expect(opaque.manifest).toMatchObject({
      formatVersion: "1.1",
      layout: "opaque"
    });
    await opaque.dispose();
  });

  it("rejects both header and manifest version mismatches", async () => {
    const cases = [
      mutateHeaderMinor(qualifiedPackedAssetBytes(), 0),
      mutateHeaderMinor(assetBytes(1, new Uint8Array([1, 2, 3, 4])), 1)
    ];
    for (const body of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(body)));
      await expect(open(`sha256-${"A".repeat(43)}=`)).rejects.toThrow(
        "Invalid AVAL asset"
      );
    }
  });

  it("rejects versioned witness exact-key, bound, and relation failures", async () => {
    const qualified = qualifiedPackedAssetBytes();
    const legacy = assetBytes(1, new Uint8Array([1, 2, 3, 4]));
    const cases = [
      rewriteManifest(qualified, (manifest) => {
        delete manifest.renditions[0].outputQualification;
      }),
      rewriteManifest(legacy, (manifest) => {
        manifest.renditions[0].outputQualification = witness();
      }),
      rewriteManifest(legacy, (manifest) => {
        manifest.formatVersion = "1.1";
        manifest.renditions[0].outputQualification = witness();
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.extra = true;
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.kind = "packed-alpha-v2";
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.samples = [];
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.samples = Array.from(
          { length: 9 },
          () => ({ x: 0, y: 0, expectedRange: [0, 32] })
        );
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.samples[0].x = 2;
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.samples[0].expectedRange = [0, 97];
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.samples.push({
          x: 0,
          y: 0,
          expectedRange: [0, 32]
        });
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.unit = "unknown";
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.renditions[0].outputQualification.frame = 6;
      }),
      rewriteManifest(qualified, (manifest) => {
        manifest.readiness.bootstrapUnits = [];
      })
    ];

    for (const body of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => wholeResponse(body)));
      await expect(open(`sha256-${"A".repeat(43)}=`)).rejects.toThrow(
        "Invalid AVAL asset"
      );
    }
  });
});

describe("Asset transport ownership", () => {
  it("copies a genuine Uint8Array body chunk from another realm", async () => {
    const body = assetBytes(1, new Uint8Array([1, 2, 3, 4]));
    const foreign = runInNewContext("Uint8Array.from(values)", {
      values: [...body]
    }) as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(foreign);
          controller.close();
        }
      }));
      Object.defineProperty(response, "url", { value: URL });
      return response;
    }));

    const asset = await open(`sha256-${"A".repeat(43)}=`);
    expect(asset.fileBytes?.byteLength).toBe(body.byteLength);
    await asset.dispose();
  });

  it("rejects an unknown-length body with a huge false index before allocating its front end", async () => {
    const NativeUint8Array = Uint8Array;
    const body = assetBytes(1, new NativeUint8Array([1, 2, 3, 4]), 9_000_000);
    const view = new DataView(body.buffer, body.byteOffset, 64);
    const indexOffset = Number(view.getBigUint64(48, true));
    const maliciousIndexLength = 16 + 180_000 * 48;
    const maliciousFrontEnd = indexOffset + maliciousIndexLength;
    expect(maliciousFrontEnd).toBeLessThan(9_000_000);
    view.setBigUint64(24, BigInt(maliciousFrontEnd), true);
    view.setBigUint64(56, BigInt(maliciousIndexLength), true);
    const streamed = body.slice();
    let attemptedFrontEndAllocation = false;
    const GuardedUint8Array = new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        if (args[0] === maliciousFrontEnd) {
          attemptedFrontEndAllocation = true;
          throw new Error("front-end allocation was attempted");
        }
        return Reflect.construct(target, args, newTarget);
      }
    });
    vi.stubGlobal("Uint8Array", GuardedUint8Array);
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(streamed);
          controller.close();
        }
      }));
      expect(response.headers.has("Content-Length")).toBe(false);
      Object.defineProperty(response, "url", { value: URL });
      return response;
    }));

    await expect(open(`sha256-${"A".repeat(43)}=`)).rejects.toThrow("Invalid AVAL asset");
    expect(attemptedFrontEndAllocation).toBe(false);
  });

  it("rejects a declared SRI body above the manifest ceiling before allocating it", async () => {
    const NativeUint8Array = Uint8Array;
    const declared = Number.MAX_SAFE_INTEGER;
    const body = assetBytes(1, new NativeUint8Array([1, 2, 3, 4]));
    new DataView(body.buffer, body.byteOffset, 64).setBigUint64(24, BigInt(declared), true);
    let attemptedDeclaredAllocation = false;
    const GuardedUint8Array = new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        if (args[0] === declared) {
          attemptedDeclaredAllocation = true;
          throw new Error("declared allocation was attempted");
        }
        return Reflect.construct(target, args, newTarget);
      }
    });
    vi.stubGlobal("Uint8Array", GuardedUint8Array);
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = new Response(body.slice().buffer as ArrayBuffer);
      Object.defineProperty(response, "url", { value: URL });
      return response;
    }));

    await expect(open(`sha256-${"A".repeat(43)}=`)).rejects.toThrow("Invalid AVAL asset");
    expect(attemptedDeclaredAllocation).toBe(false);
  });

  it("admits a valid SRI body into exact resident storage", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const body = assetBytes(1, payload);
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = new Response(body.slice().buffer as ArrayBuffer);
      Object.defineProperty(response, "url", { value: URL });
      return response;
    }));

    const asset = await open(`sha256-${"A".repeat(43)}=`);
    expect(asset.mode).toBe("full");
    expect(asset.fileBytes?.byteLength).toBe(body.byteLength);
    await expect(asset.unitBytes("video", "body-00")).resolves.toEqual(payload);
    await asset.dispose();
  });

  it("shares one five-second deadline across every range of a unit", async () => {
    vi.useFakeTimers();
    const payload = new Uint8Array(4 * 1024 * 1024 + 257).fill(7);
    const bytes = assetBytes(1, payload);
    let payloadRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = requestedRange(init);
      if (range[0] >= frontEnd(bytes)) {
        payloadRequests += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      }
      return rangeResponse(bytes, range);
    }));

    const asset = await open();
    const load = asset.unitBytes("video", "body-00");
    await until(() => payloadRequests === 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await until(() => payloadRequests === 2);
    const rejected = expect(load).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(2_001);
    await rejected;
    await until(() => asset.snapshot().pendingLoads === 0);
    expect(asset.snapshot()).toMatchObject({
      activeTransportBodies: 0,
      interestedWaiters: 0,
      pendingLoads: 0
    });
    await asset.dispose();
  });

  it("removes one aborted interest without cancelling an interested peer", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const bytes = assetBytes(1, payload);
    let release!: () => void;
    let transportAborted = false;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const range = requestedRange(init);
      if (range[0] < frontEnd(bytes)) return Promise.resolve(rangeResponse(bytes, range));
      return new Promise<Response>((resolve, reject) => {
        release = () => resolve(rangeResponse(bytes, range));
        init!.signal!.addEventListener("abort", () => {
          transportAborted = true;
          reject(init!.signal!.reason);
        }, { once: true });
      });
    }));

    const asset = await open();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = asset.unitBytes("video", "body-00", firstController.signal);
    const second = asset.unitBytes("video", "body-00", secondController.signal);
    await until(() => asset.snapshot().activeTransportBodies === 1);
    expect(asset.snapshot().interestedWaiters).toBe(2);
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(transportAborted).toBe(false);
    expect(asset.snapshot().interestedWaiters).toBe(1);
    release();
    await expect(second).resolves.toEqual(payload);
    expect(asset.snapshot()).toMatchObject({
      interestedWaiters: 0,
      pendingLoads: 0,
      verifiedBytes: payload.byteLength,
      blobs: { verified: 1 }
    });
    await asset.dispose();
  });

  it("cancels an unobserved load and permits a clean resident retry", async () => {
    const payload = new Uint8Array([5, 6, 7, 8]);
    const bytes = assetBytes(1, payload);
    let block = true;
    let transportAborted = false;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const range = requestedRange(init);
      if (range[0] < frontEnd(bytes) || !block) return Promise.resolve(rangeResponse(bytes, range));
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => {
          transportAborted = true;
          reject(init!.signal!.reason);
        }, { once: true });
      });
    }));

    const asset = await open();
    const controller = new AbortController();
    const obsoletePrefetch = asset.unitBytes("video", "body-00", controller.signal);
    await until(() => asset.snapshot().activeTransportBodies === 1);
    controller.abort();
    await expect(obsoletePrefetch).rejects.toMatchObject({ name: "AbortError" });
    await until(() => asset.snapshot().pendingLoads === 0);
    expect(transportAborted).toBe(true);
    expect(asset.snapshot()).toMatchObject({
      interestedWaiters: 0,
      pendingLoads: 0,
      verifiedBytes: 0,
      blobs: { absent: 1, loading: 0, verified: 0 }
    });

    block = false;
    await expect(asset.unitBytes("video", "body-00")).resolves.toEqual(payload);
    expect(asset.snapshot()).toMatchObject({ verifiedBytes: payload.byteLength, blobs: { verified: 1 } });
    await asset.dispose();
  });

  it("never opens more than four payload bodies for one asset", async () => {
    const payload = new Uint8Array([9, 10, 11, 12]);
    const bytes = assetBytes(5, payload);
    let payloadRequests = 0;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const range = requestedRange(init);
      if (range[0] < frontEnd(bytes)) return Promise.resolve(rangeResponse(bytes, range));
      payloadRequests += 1;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    }));

    const asset = await open();
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const loads = controllers.map((controller, index) =>
      asset.unitBytes("video", `body-${String(index).padStart(2, "0")}`, controller.signal)
    );
    await until(() => asset.snapshot().interestedWaiters === 5 && payloadRequests === 4);
    expect(asset.snapshot()).toMatchObject({
      activeTransportBodies: 4,
      interestedWaiters: 5,
      pendingLoads: 5
    });
    for (const controller of controllers) controller.abort();
    expect((await Promise.allSettled(loads)).every((result) => result.status === "rejected")).toBe(true);
    await until(() => asset.snapshot().pendingLoads === 0);
    expect(payloadRequests).toBe(4);
    expect(asset.snapshot()).toMatchObject({ activeTransportBodies: 0, interestedWaiters: 0 });
    await asset.dispose();
  });

  it("rejects a same-tag full replacement with a different admitted front while peers retain the old session", async () => {
    const payload = new Uint8Array([13, 14, 15, 16]);
    const original = assetBytes(2, payload);
    const replacement = assetBytes(2, payload, undefined, [2, 2]);
    const requests: Array<{
      readonly range: readonly [number, number];
      readonly resolve: (response: Response) => void;
    }> = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const range = requestedRange(init);
      if (range[0] < frontEnd(original)) return Promise.resolve(rangeResponse(original, range));
      return new Promise<Response>((resolve) => requests.push({ range, resolve }));
    }));

    const asset = await open();
    const changed = asset.unitBytes("video", "body-00");
    const peer = asset.unitBytes("video", "body-01");
    await until(() => requests.length === 2);
    requests[0]!.resolve(wholeResponse(replacement));
    await expect(changed).rejects.toThrow("Invalid AVAL asset");
    expect(asset.mode).toBe("range");
    expect(asset.manifest.canvas.pixelAspect).toEqual([1, 1]);

    requests[1]!.resolve(rangeResponse(original, requests[1]!.range));
    await expect(peer).resolves.toEqual(payload);
    const retry = asset.unitBytes("video", "body-00");
    await until(() => requests.length === 3);
    requests[2]!.resolve(rangeResponse(original, requests[2]!.range));
    await expect(retry).resolves.toEqual(payload);
    expect(asset.snapshot()).toMatchObject({ mode: "range", blobs: { verified: 2 } });
    await asset.dispose();
  });

  it("uses one matching full replacement for already-open peer range loads", async () => {
    const payload = new Uint8Array([17, 18, 19, 20]);
    const original = assetBytes(2, payload);
    const requests: Array<{
      readonly range: readonly [number, number];
      readonly resolve: (response: Response) => void;
    }> = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const range = requestedRange(init);
      if (range[0] < frontEnd(original)) return Promise.resolve(rangeResponse(original, range));
      return new Promise<Response>((resolve) => requests.push({ range, resolve }));
    }));

    const asset = await open();
    const first = asset.unitBytes("video", "body-00");
    const peer = asset.unitBytes("video", "body-01");
    await until(() => requests.length === 2);
    requests[0]!.resolve(wholeResponse(original));
    await until(() => asset.mode === "full");
    const stale = original.slice();
    stale.fill(0, requests[1]!.range[0], requests[1]!.range[1] + 1);
    requests[1]!.resolve(rangeResponse(stale, requests[1]!.range));

    await expect(first).resolves.toEqual(payload);
    await expect(peer).resolves.toEqual(payload);
    expect(asset.snapshot()).toMatchObject({ mode: "full", blobs: { verified: 2 } });
    await asset.dispose();
  });
});

function assetBytes(
  unitCount: number,
  payload: Uint8Array,
  maxCompiledBytes?: number,
  pixelAspect: readonly [number, number] = [1, 1],
  codecString = CODEC
): Uint8Array {
  const digest = createHash("sha256").update(payload).digest("hex");
  const units = Array.from({ length: unitCount }, (_, index) => {
    const id = `body-${String(index).padStart(2, "0")}`;
    return {
      id,
      kind: "body" as const,
      playback: "finite" as const,
      frameCount: 6,
      ports: [{ id: "default", entryFrame: 0 as const, portalFrames: [5] }],
      chunks: [{ rendition: "video", sha256: digest }]
    };
  });
  const states = units.map((unit, index) => ({
    id: `state-${String(index).padStart(2, "0")}`,
    bodyUnit: unit.id
  }));
  const edges = states.slice(1).map((state, index) => ({
    id: `edge-${String(index + 1).padStart(2, "0")}`,
    from: "state-00",
    to: state.id,
    start: { type: "cut" as const, targetPort: "default", maxWaitFrames: 1 as const },
    continuity: "cut" as const,
    targetRunwayFrames: 6
  }));
  const payloadBytes = payload.byteLength * unitCount;
  const input = {
    manifest: {
      formatVersion: "1.0",
      generator: "asset-tests",
      codec: "h264",
      bitstream: "annex-b",
      layout: "opaque",
      canvas: { width: 2, height: 2, fit: "contain", pixelAspect, colorSpace: "srgb" },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [{
        id: "video",
        codec: codecString,
        bitDepth: 8,
        codedWidth: 16,
        codedHeight: 16,
        alphaLayout: { type: "opaque", colorRect: [0, 0, 2, 2] },
        bitrate: { average: 1_000, peak: 2_000 }
      }],
      units,
      initialState: "state-00",
      states,
      edges,
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: units.map((unit) => unit.id),
        immediateEdges: edges.map((edge) => edge.id)
      },
      limits: {
        maxCompiledBytes: maxCompiledBytes ?? payloadBytes + 1024 * 1024,
        maxRuntimeBytes: payloadBytes + 1024 * 1024,
        decodedPixelBytes: 1_024,
        persistentCacheBytes: payloadBytes,
        runtimeWorkingSetBytes: Math.max(1_024, payloadBytes)
      }
    },
    chunks: units.map((unit) => ({
      rendition: "video",
      unit: unit.id,
      decodeIndex: 0,
      presentationTimestamp: 0,
      duration: 1,
      randomAccess: true,
      displayedFrameCount: 6,
      bytes: payload
    }))
  } as unknown as CanonicalAssetInput;
  return writeCanonicalAsset(input);
}

function witness(): Record<string, any> {
  return {
    kind: "packed-alpha-v1",
    unit: "body-00",
    frame: 0,
    samples: [{ x: 0, y: 0, expectedRange: [0, 32] }]
  };
}

function qualifiedPackedAssetBytes(): Uint8Array {
  const payload = new Uint8Array([31, 32, 33, 34]);
  const digest = createHash("sha256").update(payload).digest("hex");
  const input = {
    manifest: {
      formatVersion: "1.1",
      generator: "qualified-asset-tests",
      codec: "h264",
      bitstream: "annex-b",
      layout: "packed-alpha",
      canvas: {
        width: 2,
        height: 2,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [{
        id: "video",
        codec: CODEC,
        bitDepth: 8,
        codedWidth: 16,
        codedHeight: 32,
        alphaLayout: {
          type: "stacked",
          colorRect: [0, 0, 2, 2],
          alphaRect: [0, 10, 2, 2]
        },
        bitrate: { average: 1_000, peak: 2_000 },
        outputQualification: witness()
      }],
      units: [{
        id: "body-00",
        kind: "body",
        playback: "finite",
        frameCount: 6,
        ports: [{ id: "default", entryFrame: 0, portalFrames: [5] }],
        chunks: [{ rendition: "video", sha256: digest }]
      }],
      initialState: "state-00",
      states: [{ id: "state-00", bodyUnit: "body-00" }],
      edges: [],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: ["body-00"],
        immediateEdges: []
      },
      limits: {
        maxCompiledBytes: 1024 * 1024,
        maxRuntimeBytes: 1024 * 1024,
        decodedPixelBytes: 16 * 32 * 4,
        persistentCacheBytes: payload.byteLength,
        runtimeWorkingSetBytes: 16 * 32 * 4
      }
    },
    chunks: [{
      rendition: "video",
      unit: "body-00",
      decodeIndex: 0,
      presentationTimestamp: 0,
      duration: 1,
      randomAccess: true,
      displayedFrameCount: 6,
      bytes: payload
    }]
  } as unknown as CanonicalAssetInput;
  return writeCanonicalAsset(input);
}

function mutateHeaderMinor(bytes: Uint8Array, minor: 0 | 1): Uint8Array {
  const output = bytes.slice();
  new DataView(output.buffer, output.byteOffset, 64).setUint16(10, minor, true);
  return output;
}

function rewriteManifest(
  bytes: Uint8Array,
  mutate: (manifest: Record<string, any>) => void
): Uint8Array {
  const oldHeader = new DataView(bytes.buffer, bytes.byteOffset, 64);
  const oldManifestLength = Number(oldHeader.getBigUint64(40, true));
  const oldIndexOffset = Number(oldHeader.getBigUint64(48, true));
  const indexLength = Number(oldHeader.getBigUint64(56, true));
  const oldIndex = bytes.slice(oldIndexOffset, oldIndexOffset + indexLength);
  const oldIndexView = new DataView(oldIndex.buffer, oldIndex.byteOffset, oldIndex.byteLength);
  const oldPayloadOffset = Number(oldIndexView.getBigUint64(16, true));
  const payload = bytes.slice(oldPayloadOffset);
  const manifest = JSON.parse(
    new TextDecoder().decode(bytes.subarray(64, 64 + oldManifestLength))
  ) as Record<string, any>;
  mutate(manifest);
  const manifestBytes = serializeCanonicalJson(manifest);
  const indexOffset = align8ForTest(64 + manifestBytes.byteLength);
  const payloadOffset = align8ForTest(indexOffset + indexLength);
  oldIndexView.setBigUint64(16, BigInt(payloadOffset), true);
  const declared = payloadOffset + payload.byteLength;
  const header = bytes.slice(0, 64);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  headerView.setUint16(10, manifest.formatVersion === "1.1" ? 1 : 0, true);
  headerView.setBigUint64(24, BigInt(declared), true);
  headerView.setBigUint64(40, BigInt(manifestBytes.byteLength), true);
  headerView.setBigUint64(48, BigInt(indexOffset), true);

  const output = new Uint8Array(declared);
  output.set(header);
  output.set(manifestBytes, 64);
  output.set(oldIndex, indexOffset);
  output.set(payload, payloadOffset);
  return output;
}

function align8ForTest(value: number): number {
  return Math.ceil(value / 8) * 8;
}

function transitionedCompletionCycleBytes(): Uint8Array {
  const payload = new Uint8Array([21, 22, 23, 24]);
  const digest = createHash("sha256").update(payload).digest("hex");
  const units = [
    {
      id: "body-a",
      kind: "body" as const,
      playback: "finite" as const,
      frameCount: 1,
      ports: [{ id: "default", entryFrame: 0 as const, portalFrames: [0] }],
      chunks: [{ rendition: "video", sha256: digest }]
    },
    {
      id: "body-b",
      kind: "body" as const,
      playback: "finite" as const,
      frameCount: 1,
      ports: [{ id: "default", entryFrame: 0 as const, portalFrames: [0] }],
      chunks: [{ rendition: "video", sha256: digest }]
    },
    {
      id: "bridge-a",
      kind: "bridge" as const,
      frameCount: 1,
      chunks: [{ rendition: "video", sha256: digest }]
    },
    {
      id: "bridge-b",
      kind: "bridge" as const,
      frameCount: 1,
      chunks: [{ rendition: "video", sha256: digest }]
    }
  ];
  const input: CanonicalAssetInput = {
    manifest: {
      formatVersion: "1.0",
      generator: "asset-cycle-tests",
      codec: "h264",
      bitstream: "annex-b",
      layout: "opaque",
      canvas: { width: 2, height: 2, fit: "contain", pixelAspect: [1, 1], colorSpace: "srgb" },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [{
        id: "video",
        codec: CODEC,
        bitDepth: 8,
        codedWidth: 16,
        codedHeight: 16,
        alphaLayout: { type: "opaque", colorRect: [0, 0, 2, 2] },
        bitrate: { average: 1_000, peak: 2_000 }
      }],
      units,
      initialState: "state-a",
      states: [
        { id: "state-a", bodyUnit: "body-a" },
        { id: "state-b", bodyUnit: "body-b" }
      ],
      edges: [
        {
          id: "edge-a",
          from: "state-a",
          to: "state-b",
          trigger: { type: "completion" },
          start: { type: "finish", targetPort: "default", maxWaitFrames: 0 },
          transition: { kind: "locked", unit: "bridge-a" },
          continuity: "exact-authored"
        },
        {
          id: "edge-b",
          from: "state-b",
          to: "state-a",
          trigger: { type: "completion" },
          start: { type: "finish", targetPort: "default", maxWaitFrames: 0 },
          transition: { kind: "locked", unit: "bridge-b" },
          continuity: "exact-authored"
        }
      ],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: units.map((unit) => unit.id),
        immediateEdges: ["edge-a"]
      },
      limits: {
        maxCompiledBytes: 1024 * 1024,
        maxRuntimeBytes: 1024 * 1024,
        decodedPixelBytes: 1_024,
        persistentCacheBytes: payload.byteLength * units.length,
        runtimeWorkingSetBytes: 1_024
      }
    },
    chunks: units.map((unit) => ({
      rendition: "video",
      unit: unit.id,
      decodeIndex: 0,
      presentationTimestamp: 0,
      duration: 1,
      randomAccess: true,
      displayedFrameCount: 1,
      bytes: payload
    }))
  };
  return writeCanonicalAsset(input);
}

function requestedRange(init?: RequestInit): readonly [number, number] {
  const value = new Headers(init?.headers).get("Range") ?? "";
  const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(value);
  if (match === null) throw new Error(`missing range: ${value}`);
  return [Number(match[1]), Number(match[2])];
}

function rangeResponse(bytes: Uint8Array, range: readonly [number, number]): Response {
  const [start, end] = range;
  const response = new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${String(start)}-${String(end)}/${String(bytes.byteLength)}`,
      ETag: '"asset-test"'
    }
  });
  Object.defineProperty(response, "url", { value: URL });
  return response;
}

function wholeResponse(bytes: Uint8Array): Response {
  const response = new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: {
      "Content-Length": String(bytes.byteLength),
      ETag: '"asset-test"'
    }
  });
  Object.defineProperty(response, "url", { value: URL });
  return response;
}

function frontEnd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 64);
  return Number(view.getBigUint64(48, true) + view.getBigUint64(56, true));
}

async function open(integrity = ""): Promise<Asset> {
  const controller = new AbortController();
  return Asset.open({ src: URL, codec: CODEC, integrity }, URL, "same-origin", controller.signal);
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not settle");
}
