import type { ValidatedMotionGraph } from "@rendered-motion/graph";
import {
  FORMAT_DEFAULT_BUDGETS,
  FormatError,
  validateCompleteAsset,
  type ByteRange,
  type CompiledManifestV01,
  type EdgeV01,
  type RenditionV01,
  type StateV01,
  type UnitV01,
  type ValidatedAssetLayout
} from "@rendered-motion/format";

import {
  buildCatalogMaps,
  checkedCatalogRangeEnd,
  createCatalogIdIndex,
  createCatalogPortIndex,
  createCatalogRecordIndex,
  type CatalogMaps,
  type RuntimeCatalogIdIndex,
  type RuntimeCatalogPortIndex,
  type RuntimeCatalogRecordIndex,
  type RuntimeCatalogStaticFrame
} from "./asset-catalog-index.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureContext
} from "./errors.js";

export type {
  RuntimeCatalogAccessUnit,
  RuntimeCatalogIdIndex,
  RuntimeCatalogPortEntry,
  RuntimeCatalogPortIndex,
  RuntimeCatalogRecordIndex,
  RuntimeCatalogStaticFrame
} from "./asset-catalog-index.js";

/**
 * One completely resident, validated asset. No caller-owned byte view or
 * mutable Map crosses this boundary.
 */
export class RuntimeAssetCatalog {
  public readonly renditions: RuntimeCatalogIdIndex<RenditionV01>;
  public readonly units: RuntimeCatalogIdIndex<UnitV01>;
  public readonly states: RuntimeCatalogIdIndex<StateV01>;
  public readonly edges: RuntimeCatalogIdIndex<EdgeV01>;
  public readonly ports: RuntimeCatalogPortIndex;
  public readonly records: RuntimeCatalogRecordIndex;
  public readonly staticFrames: RuntimeCatalogIdIndex<RuntimeCatalogStaticFrame>;

  #bytes: Uint8Array | null;
  #layout: ValidatedAssetLayout | null;
  #maps: CatalogMaps | null;

  public constructor(callerBytes: Uint8Array) {
    const installed = installOwnedBytes(callerBytes);
    this.#bytes = installed.bytes;
    this.#layout = installed.layout;
    this.#maps = installed.maps;

    this.renditions = createCatalogIdIndex(
      "rendition",
      () => this.#requireMaps().renditions,
      (rendition) => ({ rendition })
    );
    this.units = createCatalogIdIndex(
      "unit",
      () => this.#requireMaps().units,
      (unit) => ({ unit })
    );
    this.states = createCatalogIdIndex(
      "state",
      () => this.#requireMaps().states,
      (state) => ({ state })
    );
    this.edges = createCatalogIdIndex(
      "edge",
      () => this.#requireMaps().edges,
      (edge) => ({ edge })
    );
    this.staticFrames = createCatalogIdIndex(
      "static frame",
      () => this.#requireMaps().staticFrames,
      (staticFrame) => ({ staticFrame })
    );
    this.ports = createCatalogPortIndex(() => this.#requireMaps().ports);
    this.records = createCatalogRecordIndex(() => this.#requireMaps().records);
  }

  public get disposed(): boolean {
    return this.#bytes === null;
  }

  public get ownedByteLength(): number {
    return this.#bytes?.byteLength ?? 0;
  }

  public get layout(): Readonly<ValidatedAssetLayout> {
    return this.#requireLayout();
  }

  public get manifest(): Readonly<CompiledManifestV01> {
    return this.#requireLayout().frontIndex.manifest;
  }

  public get graph(): Readonly<ValidatedMotionGraph> {
    return this.#requireLayout().frontIndex.graph;
  }

  /** A fresh exact-length ArrayBuffer that may be transferred once. */
  public copySample(
    rendition: string,
    unit: string,
    localFrame: number
  ): ArrayBuffer {
    const entry = this.records.require(rendition, unit, localFrame);
    return this.#copyRange(entry.range, {
      rendition,
      unit,
      localFrame
    }).buffer;
  }

  /** A fresh PNG copy; catalog storage remains compressed and untouched. */
  public copyStaticPng(staticFrame: string): Uint8Array {
    const entry = this.staticFrames.require(staticFrame);
    return this.#copyRange(entry.range, { staticFrame });
  }

  public dispose(): void {
    if (this.#bytes === null) {
      return;
    }
    this.#bytes = null;
    this.#layout = null;
    const maps = this.#maps;
    this.#maps = null;
    if (maps !== null) {
      maps.renditions.clear();
      maps.units.clear();
      maps.states.clear();
      maps.edges.clear();
      maps.ports.clear();
      maps.records.clear();
      maps.staticFrames.clear();
    }
  }

  #requireLayout(): ValidatedAssetLayout {
    if (this.#layout === null) {
      throw disposedCatalogError();
    }
    return this.#layout;
  }

  #requireMaps(): CatalogMaps {
    if (this.#maps === null) {
      throw disposedCatalogError();
    }
    return this.#maps;
  }

  #copyRange(
    range: Readonly<ByteRange>,
    context: Readonly<RuntimeFailureContext>
  ): Uint8Array<ArrayBuffer> {
    const bytes = this.#bytes;
    if (bytes === null) {
      throw disposedCatalogError();
    }
    const end = checkedCatalogRangeEnd(
      range.offset,
      range.length,
      bytes.byteLength
    );
    let copy: Uint8Array<ArrayBuffer>;
    try {
      copy = new Uint8Array(new ArrayBuffer(range.length));
    } catch {
      throw catalogError(
        "resource-rejection",
        "asset catalog byte-copy allocation failed",
        context
      );
    }
    copy.set(bytes.subarray(range.offset, end));
    return copy;
  }
}

export function installRuntimeAssetCatalog(
  bytes: Uint8Array
): RuntimeAssetCatalog {
  return new RuntimeAssetCatalog(bytes);
}

function installOwnedBytes(callerBytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly layout: ValidatedAssetLayout;
  readonly maps: CatalogMaps;
} {
  if (!(callerBytes instanceof Uint8Array)) {
    throw catalogError(
      "invalid-asset",
      "asset catalog input must be a Uint8Array"
    );
  }
  if (callerBytes.byteLength > FORMAT_DEFAULT_BUDGETS.maxFileBytes) {
    throw catalogError(
      "invalid-asset",
      "asset catalog input exceeds the complete-file limit"
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(callerBytes.byteLength);
    bytes.set(callerBytes);
  } catch {
    throw catalogError(
      "resource-rejection",
      "asset catalog owned-byte allocation failed"
    );
  }

  let layout: ValidatedAssetLayout;
  try {
    layout = validateCompleteAsset({ bytes });
  } catch (error) {
    throw normalizeInstallError(error);
  }

  try {
    return Object.freeze({
      bytes,
      layout,
      maps: buildCatalogMaps(layout, bytes.byteLength)
    });
  } catch (error) {
    if (error instanceof RuntimePlaybackError) {
      throw error;
    }
    throw catalogError(
      "invalid-asset",
      "validated asset catalog indexes could not be constructed"
    );
  }
}

function normalizeInstallError(error: unknown): RuntimePlaybackError {
  if (error instanceof RuntimePlaybackError) {
    return error;
  }
  if (error instanceof FormatError) {
    return new RuntimePlaybackError(normalizeRuntimeFailure(
      "invalid-asset",
      undefined,
      {
        sourceCode: error.code,
        ...(error.path === undefined ? {} : { sourcePath: error.path }),
        ...(error.offset === undefined ? {} : { offset: error.offset })
      }
    ));
  }
  return catalogError(
    "invalid-asset",
    "complete asset validation failed"
  );
}

function disposedCatalogError(): RuntimePlaybackError {
  return catalogError("disposed", "asset catalog is disposed");
}

function catalogError(
  code: "invalid-asset" | "resource-rejection" | "disposed",
  message: string,
  context: Readonly<RuntimeFailureContext> = {}
): RuntimePlaybackError {
  return new RuntimePlaybackError(
    normalizeRuntimeFailure(code, message, context)
  );
}
