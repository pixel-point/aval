import type { BlobAssemblyResourceHost } from "./blob-assembly.js";
import type { BoundedBodyByteResourceHost } from "./bounded-body-reader.js";
import type { VerifiedBlobResourceHost } from "./verified-blob-store.js";

export interface RuntimeAssetSessionResources {
  /** Parsed front-index ownership retained only by sparse range sessions. */
  readonly metadata: BoundedBodyByteResourceHost;
  /** Metadata and 206 response-body ownership. */
  readonly response: BoundedBodyByteResourceHost;
  /** Whole-file quarantine with narrow post-validation asset-full promotion. */
  readonly full: BoundedBodyByteResourceHost;
  /** Exact per-blob quarantine destinations. */
  readonly assembly: BlobAssemblyResourceHost;
  /** Persistent storage used only by copied range-backed blobs. */
  readonly verified: VerifiedBlobResourceHost;
}

export function captureRuntimeAssetSessionResources(
  value: RuntimeAssetSessionResources
): RuntimeAssetSessionResources {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("runtime asset resources must be an object");
  }
  let response: BoundedBodyByteResourceHost;
  let metadata: BoundedBodyByteResourceHost;
  let full: BoundedBodyByteResourceHost;
  let assembly: BlobAssemblyResourceHost;
  let verified: VerifiedBlobResourceHost;
  try {
    metadata = value.metadata;
    response = value.response;
    full = value.full;
    assembly = value.assembly;
    verified = value.verified;
  } catch {
    throw new TypeError("runtime asset resources are inaccessible");
  }
  if (
    typeof metadata !== "object" || metadata === null ||
    typeof response !== "object" || response === null ||
    typeof full !== "object" || full === null ||
    typeof assembly !== "object" || assembly === null ||
    typeof verified !== "object" || verified === null
  ) {
    throw new TypeError("runtime asset resource capability is missing");
  }
  return Object.freeze({ metadata, response, full, assembly, verified });
}
