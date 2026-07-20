import { FormatError, isFormatError } from "./errors.js";
import type { FormatBudgets, FormatOptions } from "./model.js";

export type { FormatBudgets, FormatOptions } from "./model.js";

export const FORMAT_MAGIC = Object.freeze([
  0x41, 0x56, 0x4c, 0x46, 0x0d, 0x0a, 0x1a, 0x0a
] as const);
export const CHUNK_INDEX_MAGIC = Object.freeze([
  0x41, 0x56, 0x4c, 0x49
] as const);

export const FORMAT_VERSION_MAJOR = 1;
export const FORMAT_VERSION_MINOR = 1;
export const FORMAT_SUPPORTED_VERSIONS = Object.freeze([
  "1.0",
  "1.1"
] as const);
export const FORMAT_HEADER_LENGTH = 64;
export const FORMAT_ALIGNMENT = 8;
export const CHUNK_INDEX_HEADER_LENGTH = 16;
export const CHUNK_INDEX_RECORD_LENGTH = 48;
export const PACKED_ALPHA_WITNESS_MAX_SAMPLES = 8;
export const PACKED_ALPHA_WITNESS_MAX_INTERVAL_WIDTH = 96;
export const PACKED_ALPHA_WITNESS_MAX_REFERENCE_DELTA = 32;
const UINT32_MAX = 0xffff_ffff;

export const IDENTIFIER_PATTERN = Object.freeze(
  /^[a-z][a-z0-9._-]{0,63}$/
);
export const SHA256_HEX_PATTERN = Object.freeze(/^[0-9a-f]{64}$/);

export const FORMAT_DEFAULT_BUDGETS: Readonly<FormatBudgets> = Object.freeze({
  maxFileBytes: Number.MAX_SAFE_INTEGER,
  maxManifestBytes: 1024 * 1024,
  maxIndexBytes: Number.MAX_SAFE_INTEGER,
  maxChunkBytes: UINT32_MAX,
  maxPngBytes: Number.MAX_SAFE_INTEGER,
  maxJsonDepth: 64,
  maxJsonNodes: 20_000,
  maxJsonStringBytes: 4_096,
  maxStates: 32,
  maxEdges: 64,
  maxUnits: 96,
  maxRenditions: 4,
  maxBindings: 32,
  maxBlobRanges: 128,
  maxTotalUnitFrames: UINT32_MAX,
  maxChunkRecords: UINT32_MAX,
  maxPortsPerBody: 16,
  maxReversibleFrames: UINT32_MAX
});

const BUDGET_KEYS = Object.freeze(
  Object.keys(FORMAT_DEFAULT_BUDGETS) as (keyof FormatBudgets)[]
);
const BUDGET_KEY_SET: ReadonlySet<string> = new Set(BUDGET_KEYS);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves lower-only caller overrides into a fresh immutable budget set. */
export function resolveFormatBudgets(
  options?: FormatOptions
): Readonly<FormatBudgets> {
  try {
    if (options === undefined) {
      return FORMAT_DEFAULT_BUDGETS;
    }
    if (!isRecord(options)) {
      throw new FormatError("INPUT_INVALID", "format options must be an object");
    }

    for (const key of Reflect.ownKeys(options)) {
      if (key !== "budgets") {
        throw new FormatError(
          "INPUT_INVALID",
          `unknown format option ${String(key)}`
        );
      }
    }

    const overrides = options.budgets;
    if (overrides === undefined) {
      return FORMAT_DEFAULT_BUDGETS;
    }
    if (!isRecord(overrides)) {
      throw new FormatError("INPUT_INVALID", "format budgets must be an object", {
        path: "budgets"
      });
    }

    for (const key of Reflect.ownKeys(overrides)) {
      if (typeof key !== "string" || !BUDGET_KEY_SET.has(key)) {
        throw new FormatError(
          "INPUT_INVALID",
          `unknown format budget ${String(key)}`,
          { path: `budgets.${String(key)}` }
        );
      }
    }

    const resolved: FormatBudgets = { ...FORMAT_DEFAULT_BUDGETS };
    for (const key of BUDGET_KEYS) {
      const override = overrides[key];
      if (override === undefined) {
        continue;
      }
      if (
        typeof override !== "number" ||
        !Number.isSafeInteger(override) ||
        override < 0 ||
        override > FORMAT_DEFAULT_BUDGETS[key]
      ) {
        throw new FormatError(
          "INPUT_INVALID",
          `${key} must be a nonnegative safe integer no greater than ${FORMAT_DEFAULT_BUDGETS[key]}`,
          { path: `budgets.${key}` }
        );
      }
      (resolved as { -readonly [K in keyof FormatBudgets]: FormatBudgets[K] })[
        key
      ] = override;
    }

    return Object.freeze(resolved);
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("INPUT_INVALID", "format options could not be read");
  }
}
