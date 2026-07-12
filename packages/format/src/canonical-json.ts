import { resolveFormatBudgets } from "./constants.js";
import { FormatError } from "./errors.js";
import {
  compareBytes,
  decodeSurrogatePair,
  encodeUtf8String,
  isHighSurrogate,
  isLowSurrogate,
  pushUtf8Scalar,
  readStringScalar,
  readUtf8Scalar,
  utf8ScalarWidth
} from "./utf8.js";
import type { FormatBudgets, FormatOptions } from "./constants.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export interface CanonicalJsonWriteLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringBytes: number;
}

type CanonicalJsonWriterBudgets = Pick<
  FormatBudgets,
  "maxManifestBytes" | "maxJsonDepth" | "maxJsonNodes" | "maxJsonStringBytes"
>;

const MAX_CANONICAL_WRITE_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxStringBytes: 32 * 1024 * 1024
});
const WRITER_PAGE_BYTES = 64 * 1024;

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fail(
  code:
    | "BUDGET_EXCEEDED"
    | "INPUT_INVALID"
    | "INTEGER_UNSAFE"
    | "JSON_DANGEROUS_KEY"
    | "JSON_DUPLICATE_KEY"
    | "JSON_INVALID"
    | "JSON_NONCANONICAL",
  message: string,
  offset?: number
): never {
  throw new FormatError(
    code,
    message,
    offset === undefined ? undefined : { offset }
  );
}

function isFormatError(error: unknown): error is FormatError {
  return error instanceof FormatError;
}

function failInputUnicode(message: string): never {
  return fail("INPUT_INVALID", message);
}

function failJsonUnicode(message: string, offset?: number): never {
  return fail("JSON_INVALID", message, offset);
}

function encodeBoundedKey(value: string, maximum: number): Uint8Array {
  let byteLength = 0;
  for (let offset = 0; offset < value.length; ) {
    const scalar = readStringScalar(value, offset, failInputUnicode);
    const width = utf8ScalarWidth(scalar.codePoint);
    if (byteLength > maximum - width) {
      return fail("BUDGET_EXCEEDED", "JSON string budget exceeded");
    }
    byteLength += width;
    offset += scalar.width;
  }
  return encodeUtf8String(value, failInputUnicode);
}

/** Compare decoded strings using unsigned lexicographic UTF-8 byte order. */
export function compareUtf8Strings(left: string, right: string): number {
  try {
    if (typeof left !== "string" || typeof right !== "string") {
      return fail("INPUT_INVALID", "UTF-8 comparison inputs must be strings");
    }
    return compareBytes(
      encodeUtf8String(left, failInputUnicode),
      encodeUtf8String(right, failInputUnicode)
    );
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("INPUT_INVALID", "Could not compare UTF-8 strings");
  }
}

class CanonicalJsonParser {
  readonly #bytes: Uint8Array;
  readonly #budgets: FormatBudgets;
  #offset = 0;
  #nodes = 0;

  public constructor(bytes: Uint8Array, budgets: FormatBudgets) {
    this.#bytes = bytes;
    this.#budgets = budgets;
  }

  public parse(): CanonicalJsonValue {
    if (
      this.#bytes[0] === 0xef &&
      this.#bytes[1] === 0xbb &&
      this.#bytes[2] === 0xbf
    ) {
      return fail("JSON_INVALID", "A UTF-8 BOM is not permitted", 0);
    }

    this.#skipWhitespace();
    const value = this.#parseValue(1);
    this.#skipWhitespace();
    if (this.#offset !== this.#bytes.byteLength) {
      return fail("JSON_INVALID", "Unexpected trailing JSON data", this.#offset);
    }
    return value;
  }

  #parseValue(depth: number): CanonicalJsonValue {
    if (depth > this.#budgets.maxJsonDepth) {
      return fail("BUDGET_EXCEEDED", "JSON depth budget exceeded", this.#offset);
    }
    this.#nodes += 1;
    if (this.#nodes > this.#budgets.maxJsonNodes) {
      return fail("BUDGET_EXCEEDED", "JSON node budget exceeded", this.#offset);
    }

    const byte = this.#bytes[this.#offset];
    switch (byte) {
      case 0x22:
        return this.#parseString();
      case 0x5b:
        return this.#parseArray(depth);
      case 0x7b:
        return this.#parseObject(depth);
      case 0x74:
        this.#parseLiteral("true");
        return true;
      case 0x66:
        this.#parseLiteral("false");
        return false;
      case 0x6e:
        this.#parseLiteral("null");
        return null;
      case 0x2d:
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
        return this.#parseInteger();
      default:
        return fail("JSON_INVALID", "Expected a JSON value", this.#offset);
    }
  }

  #parseLiteral(literal: string): void {
    for (let index = 0; index < literal.length; index += 1) {
      if (this.#bytes[this.#offset + index] !== literal.charCodeAt(index)) {
        return fail("JSON_INVALID", `Invalid JSON literal`, this.#offset + index);
      }
    }
    this.#offset += literal.length;
  }

  #parseInteger(): number {
    const start = this.#offset;
    const negative = this.#bytes[this.#offset] === 0x2d;
    if (negative) this.#offset += 1;

    const firstDigit = this.#bytes[this.#offset];
    if (firstDigit === undefined || firstDigit < 0x30 || firstDigit > 0x39) {
      return fail("JSON_INVALID", "Expected a digit after minus", this.#offset);
    }

    let magnitude = 0;
    if (firstDigit === 0x30) {
      this.#offset += 1;
      const next = this.#bytes[this.#offset];
      if (next !== undefined && next >= 0x30 && next <= 0x39) {
        return fail(
          "JSON_NONCANONICAL",
          "Leading zeroes are not canonical",
          this.#offset
        );
      }
    } else {
      while (true) {
        const byte = this.#bytes[this.#offset];
        if (byte === undefined || byte < 0x30 || byte > 0x39) break;
        const digit = byte - 0x30;
        if (magnitude > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
          return fail("INTEGER_UNSAFE", "JSON integer is not safe", start);
        }
        magnitude = magnitude * 10 + digit;
        this.#offset += 1;
      }
    }

    const suffix = this.#bytes[this.#offset];
    if (suffix === 0x2e || suffix === 0x45 || suffix === 0x65) {
      return fail(
        "JSON_NONCANONICAL",
        "Fractions and exponents are not canonical integers",
        this.#offset
      );
    }
    if (negative && magnitude === 0) {
      return fail("JSON_NONCANONICAL", "Negative zero is not canonical", start);
    }
    return negative ? -magnitude : magnitude;
  }

  #parseArray(depth: number): readonly CanonicalJsonValue[] {
    this.#offset += 1;
    const values: CanonicalJsonValue[] = [];
    this.#skipWhitespace();
    if (this.#bytes[this.#offset] === 0x5d) {
      this.#offset += 1;
      return values;
    }

    while (true) {
      values.push(this.#parseValue(depth + 1));
      this.#skipWhitespace();
      const delimiter = this.#bytes[this.#offset];
      if (delimiter === 0x5d) {
        this.#offset += 1;
        return values;
      }
      if (delimiter !== 0x2c) {
        return fail(
          "JSON_INVALID",
          "Expected a comma or closing bracket",
          this.#offset
        );
      }
      this.#offset += 1;
      this.#skipWhitespace();
    }
  }

  #parseObject(depth: number): CanonicalJsonObject {
    this.#offset += 1;
    const value: Record<string, CanonicalJsonValue> = Object.create(null) as Record<
      string,
      CanonicalJsonValue
    >;
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#bytes[this.#offset] === 0x7d) {
      this.#offset += 1;
      return value;
    }

    while (true) {
      if (this.#bytes[this.#offset] !== 0x22) {
        return fail("JSON_INVALID", "Expected a quoted object key", this.#offset);
      }
      const keyOffset = this.#offset;
      const key = this.#parseString();
      if (DANGEROUS_KEYS.has(key)) {
        return fail(
          "JSON_DANGEROUS_KEY",
          `Dangerous object key ${key} is forbidden`,
          keyOffset
        );
      }
      if (keys.has(key)) {
        return fail(
          "JSON_DUPLICATE_KEY",
          `Duplicate decoded object key ${key}`,
          keyOffset
        );
      }
      keys.add(key);

      this.#skipWhitespace();
      if (this.#bytes[this.#offset] !== 0x3a) {
        return fail("JSON_INVALID", "Expected a colon after object key", this.#offset);
      }
      this.#offset += 1;
      this.#skipWhitespace();
      value[key] = this.#parseValue(depth + 1);
      this.#skipWhitespace();

      const delimiter = this.#bytes[this.#offset];
      if (delimiter === 0x7d) {
        this.#offset += 1;
        return value;
      }
      if (delimiter !== 0x2c) {
        return fail(
          "JSON_INVALID",
          "Expected a comma or closing brace",
          this.#offset
        );
      }
      this.#offset += 1;
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#offset;
    this.#offset += 1;
    const scalars: string[] = [];
    let decodedBytes = 0;

    while (this.#offset < this.#bytes.byteLength) {
      const byte = this.#bytes[this.#offset];
      if (byte === undefined) break;
      if (byte === 0x22) {
        this.#offset += 1;
        return scalars.join("");
      }
      if (byte === 0x5c) {
        const escaped = this.#parseEscape();
        decodedBytes += utf8ScalarWidth(escaped);
        this.#checkStringBudget(decodedBytes, start);
        scalars.push(String.fromCodePoint(escaped));
        continue;
      }
      if (byte < 0x20) {
        return fail("JSON_INVALID", "Unescaped control character in string", this.#offset);
      }
      const scalar = readUtf8Scalar(
        this.#bytes,
        this.#offset,
        failJsonUnicode
      );
      decodedBytes += scalar.width;
      this.#checkStringBudget(decodedBytes, start);
      scalars.push(String.fromCodePoint(scalar.codePoint));
      this.#offset += scalar.width;
    }

    return fail("JSON_INVALID", "Unterminated JSON string", start);
  }

  #parseEscape(): number {
    const escapeOffset = this.#offset;
    this.#offset += 1;
    const escaped = this.#bytes[this.#offset];
    this.#offset += 1;
    switch (escaped) {
      case 0x22:
        return 0x22;
      case 0x2f:
        return 0x2f;
      case 0x5c:
        return 0x5c;
      case 0x62:
        return 0x08;
      case 0x66:
        return 0x0c;
      case 0x6e:
        return 0x0a;
      case 0x72:
        return 0x0d;
      case 0x74:
        return 0x09;
      case 0x75:
        return this.#parseUnicodeEscape(escapeOffset);
      default:
        return fail("JSON_INVALID", "Invalid JSON string escape", escapeOffset);
    }
  }

  #parseUnicodeEscape(escapeOffset: number): number {
    const first = this.#readHexQuad(escapeOffset);
    if (isLowSurrogate(first)) {
      return fail("JSON_INVALID", "Lone low surrogate escape", escapeOffset);
    }
    if (!isHighSurrogate(first)) return first;

    if (
      this.#bytes[this.#offset] !== 0x5c ||
      this.#bytes[this.#offset + 1] !== 0x75
    ) {
      return fail("JSON_INVALID", "Lone high surrogate escape", escapeOffset);
    }
    this.#offset += 2;
    const second = this.#readHexQuad(this.#offset - 2);
    if (!isLowSurrogate(second)) {
      return fail("JSON_INVALID", "Invalid surrogate pair escape", escapeOffset);
    }
    return decodeSurrogatePair(first, second);
  }

  #readHexQuad(escapeOffset: number): number {
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      const byte = this.#bytes[this.#offset];
      if (byte === undefined) {
        return fail("JSON_INVALID", "Truncated Unicode escape", escapeOffset);
      }
      let digit: number;
      if (byte >= 0x30 && byte <= 0x39) digit = byte - 0x30;
      else if (byte >= 0x41 && byte <= 0x46) digit = byte - 0x41 + 10;
      else if (byte >= 0x61 && byte <= 0x66) digit = byte - 0x61 + 10;
      else return fail("JSON_INVALID", "Invalid Unicode escape", this.#offset);
      value = value * 16 + digit;
      this.#offset += 1;
    }
    return value;
  }

  #checkStringBudget(decodedBytes: number, offset: number): void {
    if (decodedBytes > this.#budgets.maxJsonStringBytes) {
      return fail("BUDGET_EXCEEDED", "JSON string budget exceeded", offset);
    }
  }

  #skipWhitespace(): void {
    while (true) {
      const byte = this.#bytes[this.#offset];
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return;
      this.#offset += 1;
    }
  }
}

interface EncodedKey {
  readonly key: string;
  readonly bytes: Uint8Array;
}

class CanonicalJsonWriter {
  readonly #budgets: CanonicalJsonWriterBudgets;
  readonly #pages: Uint8Array[] = [];
  readonly #active = new Set<object>();
  #current = new Uint8Array(WRITER_PAGE_BYTES);
  #currentLength = 0;
  #byteLength = 0;
  #nodes = 0;

  public constructor(budgets: CanonicalJsonWriterBudgets) {
    this.#budgets = budgets;
  }

  public serialize(value: unknown): Uint8Array {
    this.#writeValue(value, 1);
    const output = new Uint8Array(this.#byteLength);
    let offset = 0;
    for (const page of this.#pages) {
      output.set(page, offset);
      offset += page.byteLength;
    }
    output.set(this.#current.subarray(0, this.#currentLength), offset);
    return output;
  }

  #writeValue(value: unknown, depth: number): void {
    if (depth > this.#budgets.maxJsonDepth) {
      return fail("BUDGET_EXCEEDED", "JSON depth budget exceeded");
    }
    this.#nodes += 1;
    if (this.#nodes > this.#budgets.maxJsonNodes) {
      return fail("BUDGET_EXCEEDED", "JSON node budget exceeded");
    }

    if (value === null) {
      this.#pushAscii("null");
      return;
    }
    if (typeof value === "boolean") {
      this.#pushAscii(value ? "true" : "false");
      return;
    }
    if (typeof value === "string") {
      this.#writeString(value);
      return;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        return fail("INTEGER_UNSAFE", "JSON numbers must be safe integers");
      }
      if (Object.is(value, -0)) {
        return fail("INPUT_INVALID", "Negative zero is not canonical");
      }
      this.#pushAscii(String(value));
      return;
    }
    if (typeof value !== "object") {
      return fail("INPUT_INVALID", "Value is not representable as canonical JSON");
    }

    if (this.#active.has(value)) {
      return fail("INPUT_INVALID", "Canonical JSON cannot contain cycles");
    }
    this.#active.add(value);
    try {
      if (Array.isArray(value)) this.#writeArray(value, depth);
      else this.#writeObject(value, depth);
    } finally {
      this.#active.delete(value);
    }
  }

  #writeArray(value: readonly unknown[], depth: number): void {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string") {
        return fail("INPUT_INVALID", "Symbol properties are not canonical arrays");
      }
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      ) {
        return fail("INPUT_INVALID", "Named properties are not canonical arrays");
      }
    }

    this.#pushByte(0x5b);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return fail("INPUT_INVALID", "Sparse arrays are not canonical JSON");
      }
      if (index !== 0) this.#pushByte(0x2c);
      this.#writeValue(descriptor.value, depth + 1);
    }
    this.#pushByte(0x5d);
  }

  #writeObject(value: object, depth: number): void {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      return fail("INPUT_INVALID", "Canonical JSON objects must be plain objects");
    }

    const ownKeys = Reflect.ownKeys(value);
    const remainingNodes = this.#budgets.maxJsonNodes - this.#nodes;
    if (ownKeys.length > remainingNodes) {
      return fail("BUDGET_EXCEEDED", "JSON node budget exceeded");
    }
    const encodedKeys: EncodedKey[] = [];
    let retainedKeyBytes = 0;
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        return fail("INPUT_INVALID", "Symbol keys are not canonical JSON");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return fail("INPUT_INVALID", "Accessors are not canonical JSON");
      }
      if (!descriptor.enumerable) {
        return fail("INPUT_INVALID", "Non-enumerable keys are not canonical JSON");
      }
      if (DANGEROUS_KEYS.has(key)) {
        return fail("JSON_DANGEROUS_KEY", `Dangerous object key ${key} is forbidden`);
      }
      const bytes = encodeBoundedKey(key, this.#budgets.maxJsonStringBytes);
      const remainingManifestBytes =
        this.#budgets.maxManifestBytes - this.#byteLength;
      if (retainedKeyBytes > remainingManifestBytes - bytes.byteLength) {
        return fail("BUDGET_EXCEEDED", "Manifest byte budget exceeded");
      }
      retainedKeyBytes += bytes.byteLength;
      encodedKeys.push({ key, bytes });
    }
    encodedKeys.sort((left, right) => compareBytes(left.bytes, right.bytes));

    this.#pushByte(0x7b);
    for (let index = 0; index < encodedKeys.length; index += 1) {
      const encodedKey = encodedKeys[index];
      if (encodedKey === undefined) continue;
      if (index !== 0) this.#pushByte(0x2c);
      this.#writeString(encodedKey.key);
      this.#pushByte(0x3a);
      const descriptor = Object.getOwnPropertyDescriptor(value, encodedKey.key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return fail("INPUT_INVALID", "Object changed during serialization");
      }
      this.#writeValue(descriptor.value, depth + 1);
    }
    this.#pushByte(0x7d);
  }

  #writeString(value: string): void {
    this.#pushByte(0x22);
    let decodedBytes = 0;
    for (let offset = 0; offset < value.length; ) {
      const scalar = readStringScalar(value, offset, failInputUnicode);
      const codePoint = scalar.codePoint;
      decodedBytes += utf8ScalarWidth(codePoint);
      if (decodedBytes > this.#budgets.maxJsonStringBytes) {
        return fail("BUDGET_EXCEEDED", "JSON string budget exceeded");
      }

      switch (codePoint) {
        case 0x08:
          this.#pushAscii("\\b");
          break;
        case 0x09:
          this.#pushAscii("\\t");
          break;
        case 0x0a:
          this.#pushAscii("\\n");
          break;
        case 0x0c:
          this.#pushAscii("\\f");
          break;
        case 0x0d:
          this.#pushAscii("\\r");
          break;
        case 0x22:
          this.#pushAscii("\\\"");
          break;
        case 0x5c:
          this.#pushAscii("\\\\");
          break;
        default:
          if (codePoint < 0x20) {
            this.#pushAscii(`\\u00${codePoint.toString(16).padStart(2, "0")}`);
          } else {
            this.#pushScalar(codePoint);
          }
      }
      offset += scalar.width;
    }
    this.#pushByte(0x22);
  }

  #pushScalar(codePoint: number): void {
    const encoded: number[] = [];
    pushUtf8Scalar(encoded, codePoint);
    this.#reserve(encoded.length);
    for (const byte of encoded) this.#appendByte(byte);
  }

  #pushAscii(value: string): void {
    this.#reserve(value.length);
    for (let index = 0; index < value.length; index += 1) {
      this.#appendByte(value.charCodeAt(index));
    }
  }

  #pushByte(value: number): void {
    this.#reserve(1);
    this.#appendByte(value);
  }

  #appendByte(value: number): void {
    if (this.#currentLength === this.#current.byteLength) {
      this.#pages.push(this.#current);
      this.#current = new Uint8Array(WRITER_PAGE_BYTES);
      this.#currentLength = 0;
    }
    this.#current[this.#currentLength] = value;
    this.#currentLength += 1;
    this.#byteLength += 1;
  }

  #reserve(length: number): void {
    if (this.#byteLength > this.#budgets.maxManifestBytes - length) {
      return fail("BUDGET_EXCEEDED", "Manifest byte budget exceeded");
    }
  }
}

function freezeParsed(value: CanonicalJsonValue): CanonicalJsonValue {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeParsed(item);
    return Object.freeze(value) as readonly CanonicalJsonValue[];
  }
  const object = value as CanonicalJsonObject;
  for (const key of Object.keys(object)) {
    freezeParsed(object[key] as CanonicalJsonValue);
  }
  return Object.freeze(object);
}

/** Serialize a JSON-compatible value into the one canonical UTF-8 form. */
export function serializeCanonicalJson(
  value: unknown,
  options?: FormatOptions
): Uint8Array {
  try {
    const budgets = resolveFormatBudgets(options);
    return new CanonicalJsonWriter(budgets).serialize(value);
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("INPUT_INVALID", "Could not serialize canonical JSON");
  }
}

/**
 * Serialize trusted high-cardinality JSON with the same canonical owner while
 * retaining explicit hard upper limits independent from on-wire budgets.
 */
export function serializeCanonicalJsonWithLimits(
  value: unknown,
  limits: CanonicalJsonWriteLimits
): Uint8Array {
  try {
    const budgets = resolveCanonicalJsonWriteLimits(limits);
    return new CanonicalJsonWriter(budgets).serialize(value);
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("INPUT_INVALID", "Could not serialize canonical JSON");
  }
}

function resolveCanonicalJsonWriteLimits(
  limits: CanonicalJsonWriteLimits
): CanonicalJsonWriterBudgets {
  if (typeof limits !== "object" || limits === null) {
    return fail("INPUT_INVALID", "Canonical JSON write limits are required");
  }
  for (const key of Object.keys(MAX_CANONICAL_WRITE_LIMITS) as (
    keyof CanonicalJsonWriteLimits
  )[]) {
    const value = limits[key];
    const maximum = MAX_CANONICAL_WRITE_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      return fail(
        "INPUT_INVALID",
        `${key} must be an integer from 1 through ${String(maximum)}`
      );
    }
  }
  if (limits.maxStringBytes > limits.maxBytes) {
    return fail("INPUT_INVALID", "maxStringBytes may not exceed maxBytes");
  }
  return Object.freeze({
    maxManifestBytes: limits.maxBytes,
    maxJsonDepth: limits.maxDepth,
    maxJsonNodes: limits.maxNodes,
    maxJsonStringBytes: limits.maxStringBytes
  });
}

/**
 * Parse canonical UTF-8 JSON without `JSON.parse`, reject alternate byte
 * spellings, and return a recursively frozen null-prototype object graph.
 */
export function parseCanonicalJson(
  bytes: Uint8Array,
  options?: FormatOptions
): CanonicalJsonValue {
  try {
    if (!(bytes instanceof Uint8Array)) {
      return fail("INPUT_INVALID", "Canonical JSON input must be a Uint8Array");
    }
    const budgets = resolveFormatBudgets(options);
    if (bytes.byteLength > budgets.maxManifestBytes) {
      return fail("BUDGET_EXCEEDED", "Manifest byte budget exceeded", 0);
    }
    const value = new CanonicalJsonParser(bytes, budgets).parse();
    const canonical = new CanonicalJsonWriter(budgets).serialize(value);
    const comparedLength = Math.min(bytes.byteLength, canonical.byteLength);
    let mismatch = comparedLength;
    for (let index = 0; index < comparedLength; index += 1) {
      if (bytes[index] !== canonical[index]) {
        mismatch = index;
        break;
      }
    }
    if (mismatch !== comparedLength || bytes.byteLength !== canonical.byteLength) {
      return fail(
        "JSON_NONCANONICAL",
        "JSON bytes do not match canonical serialization",
        mismatch
      );
    }
    return freezeParsed(value);
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("JSON_INVALID", "Could not parse canonical JSON");
  }
}

/**
 * Parse bounded strict UTF-8 JSON while allowing insignificant whitespace and
 * object-key order. Numbers remain safe integers and duplicate/dangerous keys
 * retain the canonical parser's rejection behavior.
 */
export function parseStrictJson(
  bytes: Uint8Array,
  options?: FormatOptions
): CanonicalJsonValue {
  try {
    if (!(bytes instanceof Uint8Array)) {
      return fail("INPUT_INVALID", "Strict JSON input must be a Uint8Array");
    }
    const budgets = resolveFormatBudgets(options);
    if (bytes.byteLength > budgets.maxManifestBytes) {
      return fail("BUDGET_EXCEEDED", "JSON byte budget exceeded", 0);
    }
    return freezeParsed(new CanonicalJsonParser(bytes, budgets).parse());
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("JSON_INVALID", "Could not parse strict JSON");
  }
}
