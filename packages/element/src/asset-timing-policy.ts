/** Maximum wall time owned by one asset transport operation. */
export const ASSET_REQUEST_TIMEOUT_MS = 5_000;

/** Maximum silence allowed while consuming an asset response body. */
export const ASSET_BODY_PROGRESS_TIMEOUT_MS = 2_000;

/** Header, manifest, and front-index requests form the longest admission path. */
export const ASSET_ADMISSION_REQUEST_LIMIT = 3;

/** Maximum wall time required to admit one range-capable asset. */
export const ASSET_ADMISSION_TIMEOUT_MS =
  ASSET_ADMISSION_REQUEST_LIMIT * ASSET_REQUEST_TIMEOUT_MS;
