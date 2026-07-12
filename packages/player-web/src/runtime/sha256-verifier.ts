import { FORMAT_DEFAULT_BUDGETS } from "@rendered-motion/format";

const SHA256_BYTES = 32;
const SHA256_HEX_LENGTH = SHA256_BYTES * 2;
const issuedVerifiedInputs = new WeakSet<object>();
const consumedVerifiedInputs = new WeakSet<object>();

declare const verifiedSha256InputBrand: unique symbol;

/** M7 never hashes a body larger than the format's complete-file ceiling. */
export const MAX_SHA256_INPUT_BYTES = FORMAT_DEFAULT_BUDGETS.maxFileBytes;

export interface Sha256DigestAdapter {
  digestSha256(bytes: Uint8Array): PromiseLike<ArrayBuffer | Uint8Array>;
}

/** Owns the quarantine allocation supplied to one digest operation. */
export interface Sha256InputLease {
  readonly promoteToAssetFull?: () => void;
  release(): void;
}

export interface VerifiedSha256Input {
  readonly bytes: Uint8Array;
  readonly generation: number;
  /** Ownership transfers to the synchronous promotion callback. */
  readonly inputLease: Sha256InputLease;
  /** Only this module can issue a verifier-authorized promotion token. */
  readonly [verifiedSha256InputBrand]: true;
}

export interface ConsumedVerifiedSha256Input {
  readonly bytes: Uint8Array;
  readonly generation: number;
  readonly inputLease: Sha256InputLease;
}

export interface Sha256VerificationOptions<Result> {
  readonly bytes: Uint8Array;
  readonly expectedSha256Hex: string;
  readonly generation: number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly signal: AbortSignal;
  readonly inputLease: Sha256InputLease;
  /** Must synchronously accept or reject ownership of the verified input. */
  readonly promote: (verified: Readonly<VerifiedSha256Input>) => Result;
}

export class Sha256IntegrityMismatchError extends Error {
  public constructor() {
    super("SHA-256 digest did not match");
    this.name = "Sha256IntegrityMismatchError";
  }
}

export class Sha256DigestError extends Error {
  public constructor() {
    super("SHA-256 digest failed");
    this.name = "Sha256DigestError";
  }
}

export class Sha256VerificationStaleError extends DOMException {
  public constructor() {
    super("SHA-256 verification generation is stale", "AbortError");
  }
}

export class Sha256VerificationAbortError extends DOMException {
  public constructor() {
    super("SHA-256 verification was aborted", "AbortError");
  }
}

/**
 * Consume one verifier-issued identity exactly once. A successful callback
 * owns the input lease; a throwing callback retires it automatically.
 */
export function consumeVerifiedSha256Input<Result>(
  value: Readonly<VerifiedSha256Input>,
  consume: (input: Readonly<ConsumedVerifiedSha256Input>) => Result
): Result {
  if (
    typeof value !== "object" ||
    value === null ||
    !issuedVerifiedInputs.has(value) ||
    consumedVerifiedInputs.has(value)
  ) {
    throw new Sha256IntegrityMismatchError();
  }
  const consumer = requireFunction<
    readonly [Readonly<ConsumedVerifiedSha256Input>],
    Result
  >(consume, "verified SHA-256 input consumer");
  const bytes = requireBoundedBytes(value.bytes);
  const generation = requireGeneration(value.generation);
  const inputLease = captureInputLease(value.inputLease);
  issuedVerifiedInputs.delete(value);
  consumedVerifiedInputs.add(value);
  let ownershipTransferred = false;
  try {
    const result = Reflect.apply(consumer, undefined, [Object.freeze({
      bytes,
      generation,
      inputLease
    })]) as Result;
    ownershipTransferred = true;
    return result;
  } finally {
    if (!ownershipTransferred) releaseWithoutMasking(inputLease);
  }
}

/**
 * Captures one Web Crypto digest capability. The verifier depends on this
 * adapter rather than discovering `crypto.subtle` itself.
 */
export function createWebCryptoSha256Adapter(
  subtle: Pick<SubtleCrypto, "digest">
): Readonly<Sha256DigestAdapter> {
  if (subtle === null || typeof subtle !== "object") {
    throw new TypeError("Web Crypto subtle adapter must be an object");
  }
  let digest: unknown;
  try {
    digest = Reflect.get(subtle, "digest");
  } catch {
    throw new TypeError("Web Crypto digest capability is inaccessible");
  }
  if (typeof digest !== "function") {
    throw new TypeError("Web Crypto digest capability is unavailable");
  }

  return Object.freeze({
    digestSha256(bytes: Uint8Array): Promise<ArrayBuffer | Uint8Array> {
      return Promise.resolve().then(() =>
        Reflect.apply(digest, subtle, ["SHA-256", bytes]) as
          | ArrayBuffer
          | Uint8Array
          | PromiseLike<ArrayBuffer | Uint8Array>
      );
    }
  });
}

/** Decode the format's exact lowercase 64-character SHA-256 representation. */
export function decodeSha256Hex(value: string): Uint8Array {
  if (typeof value !== "string" || value.length !== SHA256_HEX_LENGTH) {
    throw new TypeError("SHA-256 hex must contain exactly 64 lowercase digits");
  }

  const bytes = new Uint8Array(SHA256_BYTES);
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    const high = lowercaseHexNibble(value.charCodeAt(index * 2));
    const low = lowercaseHexNibble(value.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0) {
      throw new TypeError("SHA-256 hex must contain exactly 64 lowercase digits");
    }
    bytes[index] = (high << 4) | low;
  }
  return bytes;
}

/** Encode one exact 32-byte digest without delegating digest computation. */
export function encodeSha256Hex(bytes: Uint8Array): string {
  assertDigestBytes(bytes, "SHA-256 digest");
  let result = "";
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    result += bytes[index]!.toString(16).padStart(2, "0");
  }
  return result;
}

/** Compare every digest byte through one full XOR accumulation. */
export function sha256DigestsEqual(
  left: Uint8Array,
  right: Uint8Array
): boolean {
  assertDigestBytes(left, "left SHA-256 digest");
  assertDigestBytes(right, "right SHA-256 digest");

  let difference = 0;
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/**
 * Hash one leased quarantine buffer and synchronously hand ownership to the
 * promoter only after digest, abort, and generation checks all succeed.
 */
export async function verifySha256AndPromote<Result>(
  adapterValue: Sha256DigestAdapter,
  options: Readonly<Sha256VerificationOptions<Result>>
): Promise<Result> {
  const lease = captureInputLease(options.inputLease);
  let ownershipTransferred = false;

  try {
    const bytes = requireBoundedBytes(options.bytes);
    const expectedDigest = decodeSha256Hex(options.expectedSha256Hex);
    const generation = requireGeneration(options.generation);
    const signal = requireAbortSignal(options.signal);
    const isGenerationCurrent = requireFunction<readonly [number], boolean>(
      options.isGenerationCurrent,
      "SHA-256 generation predicate"
    );
    const promote = requireFunction<
      readonly [Readonly<VerifiedSha256Input>],
      Result
    >(options.promote, "SHA-256 promoter");
    const adapter = captureDigestAdapter(adapterValue);

    assertOperationCurrent(signal, isGenerationCurrent, generation);

    let rawDigest: ArrayBuffer | Uint8Array;
    try {
      rawDigest = await adapter.digestSha256(bytes);
    } catch {
      assertOperationCurrent(signal, isGenerationCurrent, generation);
      throw new Sha256DigestError();
    }

    assertOperationCurrent(signal, isGenerationCurrent, generation);
    const observedDigest = requireDigestOutput(rawDigest);
    if (!sha256DigestsEqual(observedDigest, expectedDigest)) {
      throw new Sha256IntegrityMismatchError();
    }
    // No promise or host callback occurs between this final current-generation
    // check and the synchronous promotion handoff.
    assertOperationCurrent(signal, isGenerationCurrent, generation);

    const verified = Object.freeze({
      bytes,
      generation,
      inputLease: lease
    }) as Readonly<VerifiedSha256Input>;
    issuedVerifiedInputs.add(verified);
    const result = Reflect.apply(promote, undefined, [verified]) as Result;
    ownershipTransferred = true;
    return result;
  } finally {
    if (!ownershipTransferred) {
      releaseWithoutMasking(lease);
    }
  }
}

function lowercaseHexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function requireBoundedBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("SHA-256 input must be a Uint8Array");
  }
  if (value.byteLength > MAX_SHA256_INPUT_BYTES) {
    throw new RangeError("SHA-256 input exceeds the complete-file limit");
  }
  return value;
}

function assertDigestBytes(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  if (value.byteLength !== SHA256_BYTES) {
    throw new RangeError(`${label} must contain exactly 32 bytes`);
  }
}

function requireDigestOutput(value: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : value instanceof Uint8Array
      ? value
      : null;
  if (bytes === null || bytes.byteLength !== SHA256_BYTES) {
    throw new Sha256DigestError();
  }
  return bytes;
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "SHA-256 verification generation must be a non-negative safe integer"
    );
  }
  return value;
}

function requireAbortSignal(value: AbortSignal): AbortSignal {
  if (value === null || typeof value !== "object") {
    throw new TypeError("SHA-256 verification signal must be an AbortSignal");
  }
  return value;
}

function requireFunction<Arguments extends readonly unknown[], Result>(
  value: ((...args: Arguments) => Result) | unknown,
  label: string
): (...args: Arguments) => Result {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
  return value as (...args: Arguments) => Result;
}

function assertOperationCurrent(
  signal: AbortSignal,
  isGenerationCurrent: (generation: number) => boolean,
  generation: number
): void {
  if (signal.aborted) {
    throw new Sha256VerificationAbortError();
  }

  let current = false;
  try {
    current = isGenerationCurrent(generation) === true;
  } catch {
    current = false;
  }
  if (!current) {
    throw new Sha256VerificationStaleError();
  }
}

function captureDigestAdapter(
  value: Sha256DigestAdapter
): Readonly<Sha256DigestAdapter> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("SHA-256 digest adapter must be an object");
  }
  let digestSha256: unknown;
  try {
    digestSha256 = Reflect.get(value, "digestSha256");
  } catch {
    throw new TypeError("SHA-256 digest capability is inaccessible");
  }
  if (typeof digestSha256 !== "function") {
    throw new TypeError("SHA-256 digest capability is unavailable");
  }
  return Object.freeze({
    digestSha256: (bytes: Uint8Array) =>
      Reflect.apply(digestSha256, value, [bytes]) as PromiseLike<
        ArrayBuffer | Uint8Array
      >
  });
}

function captureInputLease(value: Sha256InputLease): Sha256InputLease {
  if (value === null || typeof value !== "object") {
    throw new TypeError("SHA-256 input lease must be an object");
  }
  let release: unknown;
  let promote: unknown;
  try {
    release = Reflect.get(value, "release");
    promote = Reflect.get(value, "promoteToAssetFull");
  } catch {
    throw new TypeError("SHA-256 input lease release is inaccessible");
  }
  if (typeof release !== "function") {
    throw new TypeError("SHA-256 input lease release is unavailable");
  }
  if (promote !== undefined && typeof promote !== "function") {
    throw new TypeError("SHA-256 input lease promotion is invalid");
  }

  let released = false;
  let promoted = false;
  return Object.freeze({
    promoteToAssetFull(): void {
      if (released) throw new TypeError("SHA-256 input lease is released");
      if (promoted) return;
      if (typeof promote === "function") Reflect.apply(promote, value, []);
      promoted = true;
    },
    release(): void {
      if (released) return;
      released = true;
      Reflect.apply(release, value, []);
    }
  });
}

function releaseWithoutMasking(lease: Sha256InputLease): void {
  try {
    lease.release();
  } catch {
    // Cleanup failure must not replace the digest/abort/generation failure.
  }
}
