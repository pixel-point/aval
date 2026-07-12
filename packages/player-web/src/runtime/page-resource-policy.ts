import type {
  RuntimePageResourcePolicy,
  RuntimePageResourcePolicyInput
} from "./model.js";

export const DEFAULT_MAXIMUM_DECODER_LEASES = 2;
export const DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES = 192 * 1024 * 1024;
export const DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES = 64 * 1024 * 1024;

const POLICY_FIELDS = new Set([
  "maximumDecoderLeases",
  "maximumPagePhysicalBytes",
  "maximumPlayerLogicalBytes",
  "allowUncertifiedHigherLimits"
]);

/** Normalize host policy while making every non-reference limit explicit. */
export function createRuntimePageResourcePolicy(
  input: Readonly<RuntimePageResourcePolicyInput> = {}
): Readonly<RuntimePageResourcePolicy> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("page resource policy input must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!POLICY_FIELDS.has(field)) {
      throw new TypeError("page resource policy contains an unknown field");
    }
  }
  if (
    input.allowUncertifiedHigherLimits !== undefined &&
    typeof input.allowUncertifiedHigherLimits !== "boolean"
  ) {
    throw new TypeError("uncertified higher-limit opt-in must be boolean");
  }

  const maximumDecoderLeases = input.maximumDecoderLeases ??
    DEFAULT_MAXIMUM_DECODER_LEASES;
  const maximumPagePhysicalBytes = input.maximumPagePhysicalBytes ??
    DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES;
  const maximumPlayerLogicalBytes = input.maximumPlayerLogicalBytes ??
    DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES;
  requireNonNegativeSafeInteger(
    maximumDecoderLeases,
    "maximum decoder leases"
  );
  requirePositiveSafeInteger(
    maximumPagePhysicalBytes,
    "maximum page physical bytes"
  );
  requirePositiveSafeInteger(
    maximumPlayerLogicalBytes,
    "maximum player logical bytes"
  );

  const aboveReference =
    maximumDecoderLeases > DEFAULT_MAXIMUM_DECODER_LEASES ||
    maximumPagePhysicalBytes > DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES ||
    maximumPlayerLogicalBytes > DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES;
  if (aboveReference && input.allowUncertifiedHigherLimits !== true) {
    throw new RangeError(
      "higher page resource limits require explicit uncertified opt-in"
    );
  }

  return Object.freeze({
    maximumDecoderLeases,
    maximumPagePhysicalBytes,
    maximumPlayerLogicalBytes,
    referenceProfile: !aboveReference
  });
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
