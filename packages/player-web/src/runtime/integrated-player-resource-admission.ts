import {
  RuntimeAssetCatalog,
  installRuntimeAssetCatalog
} from "./asset-catalog.js";
import { MAX_PLAYER_RUNTIME_BYTES } from "./checked-runtime-bytes.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type { IntegratedCandidateFactory } from "./integrated-player-contracts.js";
import {
  IntegratedPlayerAssetBinding,
  type CapturedIntegratedPlayerAssetSource
} from "./integrated-player-asset-session.js";
import {
  captureRuntimeCanvasResourceHost,
  createStaticRuntimeResourcePlan,
  type RuntimeCanvasResourceHost,
  type RuntimeCanvasResourceLease,
  type RuntimeStaticResourceCatalogView
} from "./static-resource-plan.js";

export interface IntegratedPlayerResourceAdmission {
  readonly catalog: RuntimeAssetCatalog;
  readonly hostMaxRuntimeBytes: number | null;
  readonly staticResourceLease: RuntimeCanvasResourceLease | null;
}

export interface IntegratedPlayerSourceAdmission {
  readonly resources: Readonly<IntegratedPlayerResourceAdmission>;
  readonly binding: IntegratedPlayerAssetBinding;
}

/** Claim a sparse session before any player-specific resource reservation. */
export function admitIntegratedPlayerAssetSource(input: Readonly<{
  readonly source: Readonly<CapturedIntegratedPlayerAssetSource>;
  readonly candidateFactory: IntegratedCandidateFactory;
  readonly hostMaxRuntimeBytes?: number;
}>): Readonly<IntegratedPlayerSourceAdmission> {
  let resources: Readonly<IntegratedPlayerResourceAdmission> | null = null;
  let binding: IntegratedPlayerAssetBinding | null = null;
  try {
    if (input.source.kind === "session") {
      binding = new IntegratedPlayerAssetBinding(
        input.source,
        input.source.session.catalog
      );
    }
    resources = input.source.kind === "bytes"
      ? admitIntegratedPlayerResources({
          bytes: input.source.bytes,
          candidateFactory: input.candidateFactory,
          ...(input.hostMaxRuntimeBytes === undefined
            ? {}
            : { hostMaxRuntimeBytes: input.hostMaxRuntimeBytes })
        })
      : admitIntegratedPlayerSessionResources({
          catalog: input.source.session.catalog,
          candidateFactory: input.candidateFactory,
          ...(input.hostMaxRuntimeBytes === undefined
            ? {}
            : { hostMaxRuntimeBytes: input.hostMaxRuntimeBytes })
        });
    binding ??= new IntegratedPlayerAssetBinding(input.source, resources.catalog);
    return Object.freeze({ resources, binding });
  } catch (error) {
    if (binding !== null) {
      void binding.dispose();
    } else if (resources !== null) {
      try { resources.staticResourceLease?.release(); } catch {}
      if (input.source.kind === "bytes") resources.catalog.dispose();
    }
    throw error;
  }
}

/** Admit owned bytes and the complete static peak as one constructor transaction. */
export function admitIntegratedPlayerResources(input: Readonly<{
  readonly bytes: Uint8Array;
  readonly candidateFactory: IntegratedCandidateFactory;
  readonly hostMaxRuntimeBytes?: number;
}>): Readonly<IntegratedPlayerResourceAdmission> {
  const hostMaxRuntimeBytes = input.hostMaxRuntimeBytes ?? null;
  if (
    hostMaxRuntimeBytes !== null &&
    (!Number.isSafeInteger(hostMaxRuntimeBytes) || hostMaxRuntimeBytes <= 0)
  ) {
    throw new RangeError("host runtime byte policy must be a positive integer");
  }
  const preinstallCap = Math.min(
    MAX_PLAYER_RUNTIME_BYTES,
    hostMaxRuntimeBytes ?? MAX_PLAYER_RUNTIME_BYTES
  );
  if (input.bytes.byteLength > preinstallCap) {
    throw resourceAdmissionError("asset-catalog-admission");
  }

  const resourceHost = captureCanvasResourceHost(input.candidateFactory);

  const catalog = installRuntimeAssetCatalog(input.bytes);
  let staticResourceLease: RuntimeCanvasResourceLease | null = null;
  try {
    const staticResourcePlan = createStaticRuntimeResourcePlan({
      catalog,
      ...(hostMaxRuntimeBytes === null ? {} : { hostMaxRuntimeBytes }),
      ...(resourceHost === null
        ? {}
        : { canvasBacking: resourceHost.currentCanvasBacking() })
    });
    if (resourceHost !== null) {
      staticResourceLease = resourceHost.reserveCanvasResources(
        staticResourcePlan
      );
    }
    return Object.freeze({
      catalog,
      hostMaxRuntimeBytes,
      staticResourceLease
    });
  } catch (error) {
    try {
      staticResourceLease?.release();
    } catch {
      // Cleanup cannot replace the admission result.
    }
    catalog.dispose();
    if (error instanceof RuntimePlaybackError) throw error;
    throw resourceAdmissionError("static-resource-admission");
  }
}

/**
 * Sparse sessions already own and account their catalog bytes. Player
 * admission borrows that catalog. A conservative metadata-only PNG view keeps
 * legacy canvas-plan admission ahead of decode; exact M7 hosts still reserve
 * each actual PNG/surface/canvas allocation independently.
 */
export function admitIntegratedPlayerSessionResources(input: Readonly<{
  readonly catalog: RuntimeAssetCatalog;
  readonly candidateFactory: IntegratedCandidateFactory;
  readonly hostMaxRuntimeBytes?: number;
}>): Readonly<IntegratedPlayerResourceAdmission> {
  const hostMaxRuntimeBytes = input.hostMaxRuntimeBytes ?? null;
  if (!(input.catalog instanceof RuntimeAssetCatalog) || input.catalog.disposed) {
    throw new TypeError("session asset catalog is unavailable");
  }
  if (
    hostMaxRuntimeBytes !== null &&
    (!Number.isSafeInteger(hostMaxRuntimeBytes) || hostMaxRuntimeBytes <= 0)
  ) {
    throw new RangeError("host runtime byte policy must be a positive integer");
  }
  const preinstallCap = Math.min(
    MAX_PLAYER_RUNTIME_BYTES,
    hostMaxRuntimeBytes ?? MAX_PLAYER_RUNTIME_BYTES
  );
  if (input.catalog.ownedByteLength > preinstallCap) {
    throw resourceAdmissionError("asset-catalog-admission");
  }
  const resourceHost = captureCanvasResourceHost(input.candidateFactory);
  let staticResourceLease: RuntimeCanvasResourceLease | null = null;
  try {
    const staticResourcePlan = createStaticRuntimeResourcePlan({
      catalog: createConservativeSparseStaticCatalog(input.catalog),
      ...(hostMaxRuntimeBytes === null ? {} : { hostMaxRuntimeBytes }),
      ...(resourceHost === null
        ? {}
        : { canvasBacking: resourceHost.currentCanvasBacking() })
    });
    if (resourceHost !== null) {
      staticResourceLease = resourceHost.reserveCanvasResources(
        staticResourcePlan
      );
    }
    return Object.freeze({
      catalog: input.catalog,
      hostMaxRuntimeBytes,
      staticResourceLease
    });
  } catch (error) {
    try { staticResourceLease?.release(); } catch {}
    if (error instanceof RuntimePlaybackError) throw error;
    throw resourceAdmissionError("static-resource-admission");
  }
}

function createConservativeSparseStaticCatalog(
  catalog: RuntimeAssetCatalog
): RuntimeStaticResourceCatalogView {
  const entries = catalog.staticFrames.values().map(({ frame, range }) => {
    const expectedFilteredBytes = frame.height * (1 + frame.width * 4);
    const expectedRgbaBytes = frame.width * frame.height * 4;
    return Object.freeze({
      frame,
      range,
      png: Object.freeze({
        width: frame.width,
        height: frame.height,
        byteRange: Object.freeze({ offset: 0, length: range.length }),
        zlibByteLength: range.length,
        expectedFilteredBytes,
        expectedRgbaBytes
      })
    });
  });
  return Object.freeze({
    ownedByteLength: catalog.ownedByteLength,
    manifest: catalog.manifest,
    staticFrames: Object.freeze({
      values: () => Object.freeze(entries.slice())
    })
  });
}

function captureCanvasResourceHost(
  factory: IntegratedCandidateFactory
): Readonly<RuntimeCanvasResourceHost> | null {
  try {
    const host = factory.resourceHost;
    if (host === undefined) return null;
    return captureRuntimeCanvasResourceHost(host);
  } catch (error) {
    if (error instanceof RuntimePlaybackError) throw error;
    throw resourceAdmissionError("static-resource-admission");
  }
}

function resourceAdmissionError(operation: string): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "resource-rejection",
    undefined,
    { operation }
  ));
}
