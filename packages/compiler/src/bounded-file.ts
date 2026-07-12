import { open } from "node:fs/promises";

import {
  CompilerError,
  type CompilerErrorCode
} from "./diagnostics.js";
import { throwIfAborted } from "./cancellation.js";

export interface BoundedFileReadInput {
  readonly path: string;
  readonly maxBytes: number;
  readonly label: string;
  readonly limitCode: CompilerErrorCode;
  readonly signal?: AbortSignal;
}

/** Read one opened regular-file identity and reject growth or mutation races. */
export async function readBoundedRegularFile(
  input: BoundedFileReadInput
): Promise<Uint8Array> {
  throwIfAborted(input.signal);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(input.path, "r");
  } catch (error) {
    throwIfAborted(input.signal);
    throw new CompilerError("IO_FAILED", `Cannot open ${input.label}`, {
      path: input.path,
      cause: error
    });
  }
  try {
    throwIfAborted(input.signal);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(input.maxBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new CompilerError(
        input.limitCode,
        `${input.label} must be a regular file no larger than ${String(
          input.maxBytes
        )} bytes`,
        { path: input.path }
      );
    }
    const length = Number(before.size);
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      throwIfAborted(input.signal);
      const result = await handle.read(bytes, offset, length - offset, offset);
      throwIfAborted(input.signal);
      if (result.bytesRead === 0) {
        throw changedFile(input);
      }
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, length)).bytesRead !== 0) {
      throw changedFile(input);
    }
    const after = await handle.stat({ bigint: true });
    throwIfAborted(input.signal);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw changedFile(input);
    }
    return bytes;
  } catch (error) {
    throwIfAborted(input.signal);
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("IO_FAILED", `Cannot read ${input.label}`, {
      path: input.path,
      cause: error
    });
  } finally {
    await handle.close().catch(() => undefined);
    throwIfAborted(input.signal);
  }
}

function changedFile(input: BoundedFileReadInput): CompilerError {
  return new CompilerError(
    "IO_FAILED",
    `${input.label} changed while it was being read`,
    { path: input.path }
  );
}
