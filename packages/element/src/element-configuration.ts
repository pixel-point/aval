import { IDENTIFIER_PATTERN } from "@pixel-point/aval-format";

import type {
  AvalAutoplay,
  AvalBindings,
  AvalCrossOrigin,
  AvalFit,
  AvalMotion
} from "./public-types.js";

export const MAX_ELEMENT_URL_CODE_UNITS = 4_096;
export const MAX_INTERACTION_ID_CODE_UNITS = 256;
const MAX_SAFE_INTEGER_DECIMAL_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
const EXTERNAL_INTEGRITY_PATTERN = /^sha256-([A-Za-z0-9+/]{43})=$/u;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function normalizeSource(value: unknown): string {
  const normalized = normalizeBoundedString(value, "src");
  if (normalized.length === 0) throw new TypeError("src must not be empty");
  if (/\0|[\u0001-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("src contains control characters");
  }
  return normalized;
}

export function normalizeIntegrity(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("integrity must be a string");
  if (value.length !== 51) {
    throw new TypeError("integrity must be canonical sha256 Base64 for 32 bytes");
  }
  const match = EXTERNAL_INTEGRITY_PATTERN.exec(value);
  const finalSextet = match === null
    ? -1
    : BASE64_ALPHABET.indexOf(match[1]!.at(-1)!);
  if (match === null || finalSextet < 0 || (finalSextet & 0b11) !== 0) {
    throw new TypeError("integrity must be canonical sha256 Base64 for 32 bytes");
  }
  return value;
}

export function normalizeCrossOrigin(value: unknown): AvalCrossOrigin {
  return normalizeEnum(value, CROSS_ORIGINS, "crossOrigin");
}

export function normalizeMotion(value: unknown): AvalMotion {
  return normalizeEnum(value, MOTIONS, "motion");
}

export function normalizeAutoplay(value: unknown): AvalAutoplay {
  return normalizeEnum(value, AUTOPLAYS, "autoplay");
}

export function normalizeFit(value: unknown): AvalFit | null {
  if (value === null) return null;
  return normalizeEnum(value, FITS, "fit");
}

export function normalizeBindings(value: unknown): AvalBindings {
  return normalizeEnum(value, BINDINGS, "bindings");
}

export function normalizeState(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError("state must be a valid authored identifier or null");
  }
  return value;
}

export function normalizeInteractionFor(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("interactionFor must be a string");
  }
  if (value.length > MAX_INTERACTION_ID_CODE_UNITS) {
    throw new RangeError("interactionFor exceeds 256 UTF-16 code units");
  }
  if (/\0|[\u0001-\u001f\u007f]/u.test(value)) {
    throw new TypeError("interactionFor contains control characters");
  }
  return value;
}

export function normalizeSize(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new RangeError("size hint must be a positive safe integer");
  }
  return value;
}

function normalizeBoundedString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.length > MAX_ELEMENT_URL_CODE_UNITS) {
    throw new RangeError(`${label} exceeds 4096 UTF-16 code units`);
  }
  return value;
}

export function normalizeCrossOriginAttribute(value: string | null): AvalCrossOrigin {
  if (value === null || value === "") return "anonymous";
  return normalizeCrossOrigin(value);
}

export function normalizeMotionAttribute(value: string | null): AvalMotion {
  return normalizeEnum(value ?? "auto", MOTIONS, "motion");
}

export function normalizeAutoplayAttribute(value: string | null): AvalAutoplay {
  return normalizeEnum(value ?? "visible", AUTOPLAYS, "autoplay");
}

export function normalizeFitAttribute(value: string | null): AvalFit | null {
  if (value === null || value === "") return null;
  return normalizeFit(value);
}

export function normalizeBindingsAttribute(value: string | null): AvalBindings {
  return normalizeEnum(value ?? "auto", BINDINGS, "bindings");
}

export function normalizeStateAttribute(value: string | null): string | null {
  if (value === null || value === "") return null;
  return normalizeState(value);
}

export function normalizeInteractionForAttribute(value: string | null): string {
  return normalizeInteractionFor(value ?? "");
}

export function normalizeSizeAttribute(value: string | null): number | null {
  if (value === null || value === "") return null;
  if (!/^[0-9]+$/u.test(value)) {
    throw new RangeError("size attribute must be a positive integer");
  }
  let firstSignificant = 0;
  while (
    firstSignificant < value.length &&
    value.charCodeAt(firstSignificant) === 0x30
  ) {
    firstSignificant += 1;
  }
  if (
    firstSignificant === value.length ||
    value.length - firstSignificant > MAX_SAFE_INTEGER_DECIMAL_DIGITS
  ) {
    throw new RangeError("size attribute must be a positive safe integer");
  }
  return normalizeSize(Number(value.slice(firstSignificant)));
}

function normalizeEnum<const T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string
): T {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !values.has(value as T)
  ) {
    throw new TypeError(`${label} has an unsupported value`);
  }
  return value as T;
}

const CROSS_ORIGINS: ReadonlySet<AvalCrossOrigin> = new Set([
  "anonymous",
  "use-credentials"
]);
const MOTIONS: ReadonlySet<AvalMotion> = new Set([
  "auto",
  "reduce",
  "full"
]);
const AUTOPLAYS: ReadonlySet<AvalAutoplay> = new Set([
  "visible",
  "manual"
]);
const FITS: ReadonlySet<AvalFit> = new Set([
  "contain",
  "cover",
  "fill",
  "none"
]);
const BINDINGS: ReadonlySet<AvalBindings> = new Set([
  "auto",
  "none"
]);
