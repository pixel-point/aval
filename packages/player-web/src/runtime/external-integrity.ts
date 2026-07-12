import { encodeSha256Hex } from "./sha256-verifier.js";

const SHA256_BASE64_LENGTH = 44;
const EXTERNAL_SHA256_PREFIX = "sha256-";
const normalizedExternalIntegrityBrand: unique symbol = Symbol(
  "NormalizedExternalIntegrity"
);

export interface NormalizedExternalIntegrity {
  readonly algorithm: "sha256";
  readonly token: string;
  readonly digestBase64: string;
  /** Immutable normalized form consumed by the shared SHA-256 verifier. */
  readonly sha256Hex: string;
  /** Parser authority: host code cannot construct normalized integrity. */
  readonly [normalizedExternalIntegrityBrand]: true;
}

/** Parse only `sha256-` plus canonical standard Base64 for exactly 32 bytes. */
export function parseExternalIntegrity(
  value: string
): Readonly<NormalizedExternalIntegrity> {
  if (
    typeof value !== "string" ||
    value.length !== EXTERNAL_SHA256_PREFIX.length + SHA256_BASE64_LENGTH ||
    !value.startsWith(EXTERNAL_SHA256_PREFIX)
  ) {
    throw invalidExternalIntegrity();
  }

  const encoded = value.slice(EXTERNAL_SHA256_PREFIX.length);
  const digest = decodeCanonicalSha256Base64(encoded);
  const normalized = {
    algorithm: "sha256",
    token: value,
    digestBase64: encoded,
    sha256Hex: encodeSha256Hex(digest)
  } as NormalizedExternalIntegrity;
  Object.defineProperty(normalized, normalizedExternalIntegrityBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(normalized);
}

function decodeCanonicalSha256Base64(value: string): Uint8Array {
  if (
    value.length !== SHA256_BASE64_LENGTH ||
    value.charCodeAt(SHA256_BASE64_LENGTH - 1) !== 0x3d
  ) {
    throw invalidExternalIntegrity();
  }

  const sextets = new Uint8Array(SHA256_BASE64_LENGTH - 1);
  for (let index = 0; index < sextets.byteLength; index += 1) {
    const sextet = base64Sextet(value.charCodeAt(index));
    if (sextet < 0) throw invalidExternalIntegrity();
    sextets[index] = sextet;
  }

  // Thirty-two bytes leave two input bytes in the final quartet. Canonical
  // RFC 4648 encoding therefore requires the last sextet's low pad bits zero.
  if ((sextets[42]! & 0b11) !== 0) {
    throw invalidExternalIntegrity();
  }

  const bytes = new Uint8Array(32);
  let output = 0;
  for (let input = 0; input < 40; input += 4) {
    const first = sextets[input]!;
    const second = sextets[input + 1]!;
    const third = sextets[input + 2]!;
    const fourth = sextets[input + 3]!;
    bytes[output] = (first << 2) | (second >>> 4);
    bytes[output + 1] = ((second & 0x0f) << 4) | (third >>> 2);
    bytes[output + 2] = ((third & 0x03) << 6) | fourth;
    output += 3;
  }

  const first = sextets[40]!;
  const second = sextets[41]!;
  const third = sextets[42]!;
  bytes[30] = (first << 2) | (second >>> 4);
  bytes[31] = ((second & 0x0f) << 4) | (third >>> 2);
  return bytes;
}

function base64Sextet(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

function invalidExternalIntegrity(): TypeError {
  return new TypeError(
    "external integrity must be canonical sha256 Base64 for 32 bytes"
  );
}
