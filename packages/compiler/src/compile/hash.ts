import { createHash } from "node:crypto";

export interface Sha256Accumulator {
  update(bytes: Uint8Array): void;
  digestHex(): string;
}

/** Sole compiler owner for creating incremental SHA-256 state. */
export function createSha256Accumulator(): Sha256Accumulator {
  const digest = createHash("sha256");
  let finalized = false;
  return Object.freeze({
    update(bytes: Uint8Array): void {
      if (finalized) throw new Error("SHA-256 accumulator is finalized");
      digest.update(bytes);
    },
    digestHex(): string {
      if (finalized) throw new Error("SHA-256 accumulator is finalized");
      finalized = true;
      return digest.digest("hex");
    }
  });
}

export function sha256Hex(bytes: Uint8Array): string {
  const digest = createSha256Accumulator();
  digest.update(bytes);
  return digest.digestHex();
}

export function sha256Concat(parts: readonly Uint8Array[]): string {
  const digest = createSha256Accumulator();
  for (const part of parts) digest.update(part);
  return digest.digestHex();
}
