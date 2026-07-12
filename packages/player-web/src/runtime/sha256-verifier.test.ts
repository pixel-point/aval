import { FORMAT_DEFAULT_BUDGETS } from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import {
  Sha256DigestError,
  Sha256IntegrityMismatchError,
  Sha256VerificationStaleError,
  consumeVerifiedSha256Input,
  createWebCryptoSha256Adapter,
  decodeSha256Hex,
  sha256DigestsEqual,
  verifySha256AndPromote,
  type Sha256DigestAdapter,
  type Sha256InputLease,
  type VerifiedSha256Input
} from "./sha256-verifier.js";

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb924" +
  "27ae41e4649b934ca495991b7852b855";
const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223" +
  "b00361a396177a9cb410ff61f20015ad";

describe("SHA-256 digest primitives", () => {
  it("decodes exact lowercase hexadecimal and rejects every relaxed form", () => {
    expect([...decodeSha256Hex("00".repeat(32))]).toEqual(
      new Array<number>(32).fill(0)
    );
    expect([...decodeSha256Hex("ff".repeat(32))]).toEqual(
      new Array<number>(32).fill(255)
    );

    for (const malformed of [
      "",
      "0".repeat(63),
      "0".repeat(65),
      "00".repeat(31) + "0g",
      "AA".repeat(32),
      ` ${"00".repeat(32)}`,
      `${"00".repeat(32)}\n`
    ]) {
      expect(() => decodeSha256Hex(malformed)).toThrow(TypeError);
    }
    expect(() => decodeSha256Hex(null as unknown as string)).toThrow(
      TypeError
    );
  });

  it("compares all 32 bytes and rejects non-digest inputs", () => {
    const actual = decodeSha256Hex(ABC_SHA256);
    expect(sha256DigestsEqual(actual, actual.slice())).toBe(true);

    for (const index of [0, 16, 31]) {
      const different = actual.slice();
      different[index] = different[index]! ^ 1;
      expect(sha256DigestsEqual(actual, different)).toBe(false);
    }

    expect(() => sha256DigestsEqual(new Uint8Array(31), actual)).toThrow(
      RangeError
    );
    expect(() => sha256DigestsEqual(actual, new Uint8Array(33))).toThrow(
      RangeError
    );
  });

  it.each([
    ["empty", new Uint8Array(), EMPTY_SHA256],
    ["abc", new TextEncoder().encode("abc"), ABC_SHA256]
  ] as const)("matches the official %s known-answer vector", async (
    _label,
    bytes,
    expectedSha256Hex
  ) => {
    const lease = countingLease();
    const promoted = await verifySha256AndPromote(
      createWebCryptoSha256Adapter(globalThis.crypto.subtle),
      {
        bytes,
        expectedSha256Hex,
        generation: 1,
        isGenerationCurrent: (generation) => generation === 1,
        signal: new AbortController().signal,
        inputLease: lease.lease,
        promote(verified) {
          expect(verified.bytes).toBe(bytes);
          expect(verified.generation).toBe(1);
          verified.inputLease.release();
          return "promoted" as const;
        }
      }
    );

    expect(promoted).toBe("promoted");
    expect(lease.releaseCalls()).toBe(1);
  });
});

describe("generation-aware SHA-256 verification", () => {
  it("issues one unforgeable, one-use promotion identity", async () => {
    const lease = countingLease();
    const verified = await verifySha256AndPromote(
      fakeAdapter(new Uint8Array(32)),
      {
        bytes: new Uint8Array([1, 2]),
        expectedSha256Hex: "00".repeat(32),
        generation: 4,
        isGenerationCurrent: () => true,
        signal: new AbortController().signal,
        inputLease: lease.lease,
        promote: (input) => input
      }
    );

    expect(consumeVerifiedSha256Input(verified, (input) => {
      expect([...input.bytes]).toEqual([1, 2]);
      expect(input.generation).toBe(4);
      input.inputLease.release();
      return "consumed" as const;
    })).toBe("consumed");
    expect(lease.releaseCalls()).toBe(1);
    expect(() => consumeVerifiedSha256Input(verified, () => undefined))
      .toThrow(Sha256IntegrityMismatchError);

    const forged = Object.freeze({
      bytes: new Uint8Array([1, 2]),
      generation: 4,
      inputLease: countingLease().lease
    }) as unknown as Readonly<VerifiedSha256Input>;
    expect(() => consumeVerifiedSha256Input(forged, () => undefined))
      .toThrow(Sha256IntegrityMismatchError);
  });

  it("releases verifier ownership when the token consumer throws", async () => {
    const lease = countingLease();
    const verified = await verifySha256AndPromote(
      fakeAdapter(new Uint8Array(32)),
      {
        bytes: new Uint8Array([1]),
        expectedSha256Hex: "00".repeat(32),
        generation: 1,
        isGenerationCurrent: () => true,
        signal: new AbortController().signal,
        inputLease: lease.lease,
        promote: (input) => input
      }
    );
    expect(() => consumeVerifiedSha256Input(verified, () => {
      throw new Error("promotion failed");
    })).toThrow("promotion failed");
    expect(lease.releaseCalls()).toBe(1);
  });

  it("accepts the maximum bounded input without making a second copy", async () => {
    const bytes = new Uint8Array(FORMAT_DEFAULT_BUDGETS.maxFileBytes);
    const digest = new Uint8Array(32);
    const adapter: Sha256DigestAdapter = {
      async digestSha256(observed) {
        expect(observed).toBe(bytes);
        return digest.buffer;
      }
    };
    const lease = countingLease();

    await expect(verifySha256AndPromote(adapter, {
      bytes,
      expectedSha256Hex: "00".repeat(32),
      generation: Number.MAX_SAFE_INTEGER,
      isGenerationCurrent: () => true,
      signal: new AbortController().signal,
      inputLease: lease.lease,
      promote(verified) {
        verified.inputLease.release();
        return verified.bytes.byteLength;
      }
    })).resolves.toBe(FORMAT_DEFAULT_BUDGETS.maxFileBytes);
    expect(lease.releaseCalls()).toBe(1);
  });

  it("rejects an input above the format cap before hashing", async () => {
    const adapter = fakeAdapter(new Uint8Array(32));
    const lease = countingLease();

    await expect(verifySha256AndPromote(adapter, {
      bytes: new Uint8Array(FORMAT_DEFAULT_BUDGETS.maxFileBytes + 1),
      expectedSha256Hex: "00".repeat(32),
      generation: 1,
      isGenerationCurrent: () => true,
      signal: new AbortController().signal,
      inputLease: lease.lease,
      promote: vi.fn()
    })).rejects.toBeInstanceOf(RangeError);
    expect(adapter.digestSha256).not.toHaveBeenCalled();
    expect(lease.releaseCalls()).toBe(1);
  });

  it.each([0, 16, 31])(
    "does not promote a mismatch at byte %i",
    async (mismatchIndex) => {
      const digest = decodeSha256Hex(ABC_SHA256);
      digest[mismatchIndex] = digest[mismatchIndex]! ^ 1;
      const adapter = fakeAdapter(digest);
      const lease = countingLease();
      const promote = vi.fn();

      await expect(verifySha256AndPromote(adapter, {
        bytes: new TextEncoder().encode("abc"),
        expectedSha256Hex: ABC_SHA256,
        generation: 1,
        isGenerationCurrent: () => true,
        signal: new AbortController().signal,
        inputLease: lease.lease,
        promote
      })).rejects.toBeInstanceOf(Sha256IntegrityMismatchError);
      expect(promote).not.toHaveBeenCalled();
      expect(lease.releaseCalls()).toBe(1);
    }
  );

  it("keeps promotion behind the completed digest", async () => {
    const pending = deferred<ArrayBuffer>();
    const adapter: Sha256DigestAdapter = {
      digestSha256: vi.fn(() => pending.promise)
    };
    const lease = countingLease();
    const promote = vi.fn((verified: {
      readonly inputLease: Sha256InputLease;
    }) => {
      verified.inputLease.release();
      return "done";
    });
    const operation = verifySha256AndPromote(adapter, {
      bytes: new Uint8Array(),
      expectedSha256Hex: EMPTY_SHA256,
      generation: 1,
      isGenerationCurrent: () => true,
      signal: new AbortController().signal,
      inputLease: lease.lease,
      promote
    });

    await Promise.resolve();
    expect(promote).not.toHaveBeenCalled();
    expect(lease.releaseCalls()).toBe(0);

    pending.resolve(toArrayBuffer(decodeSha256Hex(EMPTY_SHA256)));
    await expect(operation).resolves.toBe("done");
    expect(promote).toHaveBeenCalledOnce();
    expect(lease.releaseCalls()).toBe(1);
  });

  it("normalizes digest rejection and releases quarantine", async () => {
    const adapter: Sha256DigestAdapter = {
      async digestSha256() {
        throw new Error("/private/digest-provider-secret");
      }
    };
    const lease = countingLease();
    const promote = vi.fn();

    await expect(verifySha256AndPromote(adapter, {
      bytes: new Uint8Array(),
      expectedSha256Hex: EMPTY_SHA256,
      generation: 1,
      isGenerationCurrent: () => true,
      signal: new AbortController().signal,
      inputLease: lease.lease,
      promote
    })).rejects.toMatchObject({
      name: "Sha256DigestError",
      message: "SHA-256 digest failed"
    });
    expect(promote).not.toHaveBeenCalled();
    expect(lease.releaseCalls()).toBe(1);
  });

  it("rejects abort before digest without invoking the adapter", async () => {
    const adapter = fakeAdapter(new Uint8Array(32));
    const lease = countingLease();
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));

    await expect(verifySha256AndPromote(adapter, {
      bytes: new Uint8Array(),
      expectedSha256Hex: "00".repeat(32),
      generation: 1,
      isGenerationCurrent: () => true,
      signal: controller.signal,
      inputLease: lease.lease,
      promote: vi.fn()
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.digestSha256).not.toHaveBeenCalled();
    expect(lease.releaseCalls()).toBe(1);
  });

  it("retires an uncancelable digest after abort and never promotes", async () => {
    const pending = deferred<ArrayBuffer>();
    const adapter: Sha256DigestAdapter = {
      digestSha256: vi.fn(() => pending.promise)
    };
    const lease = countingLease();
    const controller = new AbortController();
    const promote = vi.fn();
    const operation = verifySha256AndPromote(adapter, {
      bytes: new Uint8Array(),
      expectedSha256Hex: EMPTY_SHA256,
      generation: 7,
      isGenerationCurrent: (generation) => generation === 7,
      signal: controller.signal,
      inputLease: lease.lease,
      promote
    });

    controller.abort();
    await Promise.resolve();
    expect(lease.releaseCalls()).toBe(0);
    expect(promote).not.toHaveBeenCalled();

    pending.resolve(toArrayBuffer(decodeSha256Hex(EMPTY_SHA256)));
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(lease.releaseCalls()).toBe(1);
    expect(promote).not.toHaveBeenCalled();
  });

  it("rejects stale generations before and after an uncancelable digest", async () => {
    const staleBeforeAdapter = fakeAdapter(new Uint8Array(32));
    const staleBeforeLease = countingLease();
    await expect(verifySha256AndPromote(staleBeforeAdapter, {
      bytes: new Uint8Array(),
      expectedSha256Hex: "00".repeat(32),
      generation: 4,
      isGenerationCurrent: () => false,
      signal: new AbortController().signal,
      inputLease: staleBeforeLease.lease,
      promote: vi.fn()
    })).rejects.toBeInstanceOf(Sha256VerificationStaleError);
    expect(staleBeforeAdapter.digestSha256).not.toHaveBeenCalled();
    expect(staleBeforeLease.releaseCalls()).toBe(1);

    let currentGeneration = 9;
    const pending = deferred<ArrayBuffer>();
    const staleAfterLease = countingLease();
    const promote = vi.fn();
    const operation = verifySha256AndPromote({
      digestSha256: () => pending.promise
    }, {
      bytes: new Uint8Array(),
      expectedSha256Hex: EMPTY_SHA256,
      generation: 9,
      isGenerationCurrent: (generation) => generation === currentGeneration,
      signal: new AbortController().signal,
      inputLease: staleAfterLease.lease,
      promote
    });
    currentGeneration = 10;
    pending.resolve(toArrayBuffer(decodeSha256Hex(EMPTY_SHA256)));

    await expect(operation).rejects.toBeInstanceOf(
      Sha256VerificationStaleError
    );
    expect(staleAfterLease.releaseCalls()).toBe(1);
    expect(promote).not.toHaveBeenCalled();
  });

  it("releases quarantine when promotion throws", async () => {
    const lease = countingLease();
    await expect(verifySha256AndPromote(
      fakeAdapter(decodeSha256Hex(EMPTY_SHA256)),
      {
        bytes: new Uint8Array(),
        expectedSha256Hex: EMPTY_SHA256,
        generation: 1,
        isGenerationCurrent: () => true,
        signal: new AbortController().signal,
        inputLease: lease.lease,
        promote() {
          throw new Error("promotion failed");
        }
      }
    )).rejects.toThrow("promotion failed");
    expect(lease.releaseCalls()).toBe(1);
  });

  it("rejects malformed digest output", async () => {
    const lease = countingLease();
    await expect(verifySha256AndPromote(fakeAdapter(new Uint8Array(31)), {
      bytes: new Uint8Array(),
      expectedSha256Hex: EMPTY_SHA256,
      generation: 1,
      isGenerationCurrent: () => true,
      signal: new AbortController().signal,
      inputLease: lease.lease,
      promote: vi.fn()
    })).rejects.toBeInstanceOf(Sha256DigestError);
    expect(lease.releaseCalls()).toBe(1);
  });
});

function fakeAdapter(digest: Uint8Array): Sha256DigestAdapter {
  return {
    digestSha256: vi.fn(async () => toArrayBuffer(digest))
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function countingLease(): {
  readonly lease: Sha256InputLease;
  readonly releaseCalls: () => number;
} {
  let calls = 0;
  return {
    lease: {
      release() {
        calls += 1;
      }
    },
    releaseCalls: () => calls
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => { resolve = done; }),
    resolve
  };
}
