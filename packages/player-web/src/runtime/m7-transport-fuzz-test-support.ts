import { expect } from "vitest";

import {
  type BoundedBodyByteLease,
  type BoundedBodyByteResourceHost,
  readBoundedBody,
  type RuntimeBodyReader,
  type RuntimeBodyReadResult
} from "./bounded-body-reader.js";
import {
  parseCanonicalContentRange,
  validateExactContentRange
} from "./http-content-range.js";
import {
  parseStrongEntityTag,
  requireMatchingStrongEntityTag
} from "./http-entity-tag.js";
import {
  parseCanonicalContentLength,
  validateIdentityContentEncoding
} from "./http-response-contract.js";
import {
  createLoadWatchdogs,
  type LoadWatchdogTimerHost
} from "./load-watchdogs.js";
import {
  createM7FuzzRandom,
  m7FuzzInteger
} from "./m7-fuzz-random-test-support.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import { createPlayerRuntimeAssetSessionResources } from "./runtime-asset-resources.js";
import { openRuntimeAssetBytes } from "./runtime-asset-session.js";

export function runM7ResponseGrammarFuzz(seed: number, cases: number): void {
  const random = createM7FuzzRandom(seed);
  for (let index = 0; index < cases; index += 1) {
    const start = m7FuzzInteger(random, 100_000);
    const length = m7FuzzInteger(random, 256) + 1;
    const end = start + length - 1;
    const total = end + m7FuzzInteger(random, 4_096) + 1;
    const canonical = `bytes ${String(start)}-${String(end)}/${String(total)}`;
    const parsed = validateExactContentRange(
      index % 2 === 0 ? canonical : `\tBYTES ${String(start)}-${String(end)}/${String(total)} `,
      { start, end },
      total
    );
    expect(parsed).toEqual({ start, end, total, length });
    expect(parseCanonicalContentLength(String(length))).toBe(length);
    expect(validateIdentityContentEncoding(index % 2 === 0
      ? null
      : " Identity ")).toBe(index % 2 === 0 ? null : "identity");

    const malformedRanges = [
      `bytes 0${String(start)}-${String(end)}/${String(total)}`,
      `${canonical},${canonical}`,
      canonical.replace("-", " -"),
      canonical.replace("/", " /"),
      `bytes ${String(start)}-${String(end)}/*`,
      `bytes=${String(start)}-${String(end)}/${String(total)}`,
      `items ${String(start)}-${String(end)}/${String(total)}`,
      `bytes ${String(start)}-${String(end)}/${String(Number.MAX_SAFE_INTEGER)}0`
    ];
    expect(() => parseCanonicalContentRange(
      malformedRanges[m7FuzzInteger(random, malformedRanges.length)]!
    )).toThrow(RangeError);

    const malformedLengths = [
      `0${String(length)}`,
      `+${String(length)}`,
      `${String(length)},${String(length)}`,
      `${String(length)}.0`,
      "9007199254740992"
    ];
    expect(() => parseCanonicalContentLength(
      malformedLengths[m7FuzzInteger(random, malformedLengths.length)]!
    )).toThrow(RangeError);
    const invalidEncodings = [
      "",
      "gzip",
      "identity,gzip",
      "identity identity"
    ];
    expect(() => validateIdentityContentEncoding(
      invalidEncodings[m7FuzzInteger(random, invalidEncodings.length)]!
    )).toThrow(RangeError);

    const generation = index + 1;
    const pinned = parseStrongEntityTag(
      `"generation-${String(generation)}-${String(m7FuzzInteger(random, 65_536))}"`
    );
    if (pinned === null) throw new Error("generated strong ETag was rejected");
    expect(requireMatchingStrongEntityTag(`\t${pinned} `, pinned)).toBe(pinned);
    const hostileEntities = [
      null,
      `W/${pinned}`,
      `${pinned.slice(0, -1)}-changed"`,
      `${pinned},${pinned}`
    ];
    expect(() => requireMatchingStrongEntityTag(
      hostileEntities[m7FuzzInteger(random, hostileEntities.length)],
      pinned
    )).toThrowError(expect.objectContaining({ code: "entity-changed" }));
  }
}

export async function runM7BoundedBodyFuzz(
  seed: number,
  cases: number
): Promise<void> {
  const random = createM7FuzzRandom(seed ^ 0xb0d1_5eed);
  for (let index = 0; index < cases; index += 1) {
    const expectedBytes = m7FuzzInteger(random, 96) + 1;
    const source = Uint8Array.from(
      { length: expectedBytes },
      (_, offset) => (seed + index + offset) & 0xff
    );
    const scenario = index % 6;
    const reader = new FuzzBodyReader(bodySteps(source, scenario, random));
    const resources = new FuzzBodyResources();
    const timers = new FuzzTimerHost();
    const watchdogs = createLoadWatchdogs({ timers });
    const operation = readBoundedBody({
      reader,
      mode: scenario === 3
        ? { kind: "bounded-unknown", maximumBytes: expectedBytes }
        : {
            kind: "known-exact",
            expectedBytes,
            maximumBytes: expectedBytes
          },
      resources,
      watchdogs,
      isCurrent: scenario === 5 ? () => false : () => true
    });

    if (scenario === 0) {
      const body = await operation;
      expect(body.bytes).toEqual(source);
      expect(resources.liveBytes).toBe(expectedBytes);
      body.release();
      body.release();
    } else {
      await expect(operation).rejects.toMatchObject({
        code: scenario === 5 ? "abort" : "load-failure"
      });
    }
    expect(resources.liveBytes).toBe(0);
    expect(reader.releaseLockCount).toBe(1);
    expect(timers.activeCount).toBe(0);
    expect(watchdogs.snapshot()).toMatchObject({
      active: false,
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
  }
}

export async function runM7IntegrityPromotionFuzz(
  seed: number,
  cases: number,
  fixture: Uint8Array
): Promise<void> {
  const random = createM7FuzzRandom(seed ^ 0x1eaf_cafe);
  for (let index = 0; index < cases; index += 1) {
    const manager = new PageResourceManager(createRuntimePageResourcePolicy({
      maximumDecoderLeases: 0,
      maximumPagePhysicalBytes: 4 * 1024 * 1024,
      maximumPlayerLogicalBytes: 4 * 1024 * 1024
    }));
    const account = new PlayerResourceAccount(manager);
    let pngEntries = 0;
    const session = await openRuntimeAssetBytes(fixture, {
      resources: createPlayerRuntimeAssetSessionResources(account),
      generation: index + 1,
      digestAdapter: {
        async digestSha256(bytes) {
          expect(bytes.byteLength).toBeGreaterThan(0);
          return new Uint8Array(32).fill(0xa5);
        }
      },
      validateStaticPng() {
        pngEntries += 1;
        throw new Error("corrupt bytes reached the browser PNG seam");
      }
    });

    if (m7FuzzInteger(random, 2) === 0) {
      const staticFrame = session.catalog.staticFrames.keys()[m7FuzzInteger(
        random,
        session.catalog.staticFrames.size
      )]!;
      await expect(session.ensureStatic(staticFrame)).rejects.toMatchObject({
        code: "integrity-mismatch"
      });
      expect(() => session.catalog.copyStaticPng(staticFrame)).toThrow();
      expect(pngEntries).toBe(0);
      expect(session.snapshot().staticBlobs).toMatchObject({
        loading: 0,
        verified: 0,
        verifiedBytes: 0
      });
    } else {
      const record = session.catalog.records.values()[m7FuzzInteger(
        random,
        session.catalog.records.size
      )]!;
      await expect(session.ensureUnit(record.rendition, record.unit))
        .rejects.toMatchObject({ code: "integrity-mismatch" });
      expect(() => session.catalog.copySample(
        record.rendition,
        record.unit,
        record.localFrame
      )).toThrow();
      expect(session.snapshot().unitBlobs).toMatchObject({
        loading: 0,
        verified: 0,
        verifiedBytes: 0
      });
    }

    expect(session.snapshot()).toMatchObject({
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0,
      verifiedPayloadBytes: 0
    });
    for (const category of manager.snapshot().categories) {
      if (category.category === "asset-full") continue;
      expect(category.bytes, category.category).toBe(0);
    }
    await session.dispose();
    expect(account.snapshot().activeLeaseCount).toBe(0);
    account.dispose();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0,
      decoderLeaseCount: 0,
      participants: []
    });
    manager.dispose();
  }
}

function bodySteps(
  bytes: Uint8Array,
  scenario: number,
  random: () => number
): readonly RuntimeBodyReadResult[] {
  if (scenario === 3) {
    return [bodyChunk(new Uint8Array()), bodyChunk(new Uint8Array()), bodyEnd()];
  }
  if (scenario === 4) {
    return [{
      done: false,
      value: new DataView(new ArrayBuffer(1))
    } as unknown as RuntimeBodyReadResult];
  }
  const source = scenario === 1
    ? bytes.subarray(0, Math.max(0, bytes.byteLength - 1))
    : bytes;
  const steps = splitBodyBytes(source, random);
  if (scenario === 2) steps.push(bodyChunk(Uint8Array.of(0xff)));
  steps.push(bodyEnd());
  return steps;
}

function splitBodyBytes(
  bytes: Uint8Array,
  random: () => number
): RuntimeBodyReadResult[] {
  const steps: RuntimeBodyReadResult[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (m7FuzzInteger(random, 4) === 0) {
      steps.push(bodyChunk(new Uint8Array()));
    }
    const remaining = bytes.byteLength - offset;
    const length = m7FuzzInteger(random, remaining) + 1;
    steps.push(bodyChunk(bytes.slice(offset, offset + length)));
    offset += length;
  }
  return steps;
}

function bodyChunk(value: Uint8Array): RuntimeBodyReadResult {
  return Object.freeze({ done: false, value });
}

function bodyEnd(): RuntimeBodyReadResult {
  return Object.freeze({ done: true, value: undefined });
}

class FuzzBodyReader implements RuntimeBodyReader {
  public cancelCount = 0;
  public readCount = 0;
  public releaseLockCount = 0;
  readonly #steps: RuntimeBodyReadResult[];

  public constructor(steps: readonly RuntimeBodyReadResult[]) {
    this.#steps = [...steps];
  }

  public async read(): Promise<RuntimeBodyReadResult> {
    this.readCount += 1;
    return this.#steps.shift() ?? bodyEnd();
  }

  public async cancel(): Promise<void> {
    this.cancelCount += 1;
  }

  public releaseLock(): void {
    this.releaseLockCount += 1;
  }
}

class FuzzBodyResources implements BoundedBodyByteResourceHost {
  public liveBytes = 0;
  public peakBytes = 0;

  public reserve(byteLength: number): BoundedBodyByteLease {
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
      throw new RangeError("fuzz reservation must be a positive safe integer");
    }
    this.liveBytes += byteLength;
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes);
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.liveBytes -= byteLength;
        if (this.liveBytes < 0) {
          throw new Error("fuzz body resources underflowed");
        }
      }
    });
  }
}

class FuzzTimerHost implements LoadWatchdogTimerHost {
  readonly #active = new Set<object>();

  public get activeCount(): number {
    return this.#active.size;
  }

  public now(): number { return 0; }

  public setTimeout(): object {
    const handle = {};
    this.#active.add(handle);
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "object" && handle !== null) {
      this.#active.delete(handle);
    }
  }
}
