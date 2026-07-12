import type {
  AccessUnitRecord,
  ByteRange,
  EdgeV01,
  PortV01,
  ParsedFrontIndex,
  RenditionV01,
  StateV01,
  StaticBlobRange,
  StaticFrameV01,
  ValidatedStaticPngProfile,
  UnitV01,
  UnitBlobRange
} from "@rendered-motion/format";

import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureContext
} from "./errors.js";

export interface RuntimeCatalogIdIndex<TValue> {
  readonly size: number;
  get(id: string): Readonly<TValue> | undefined;
  require(id: string): Readonly<TValue>;
  keys(): readonly string[];
  values(): readonly Readonly<TValue>[];
}

export interface RuntimeCatalogPortEntry {
  readonly unit: string;
  readonly port: Readonly<PortV01>;
}

export interface RuntimeCatalogPortIndex {
  readonly size: number;
  get(unit: string, port: string): Readonly<RuntimeCatalogPortEntry> | undefined;
  require(unit: string, port: string): Readonly<RuntimeCatalogPortEntry>;
  values(): readonly Readonly<RuntimeCatalogPortEntry>[];
}

export interface RuntimeCatalogAccessUnit {
  readonly rendition: string;
  readonly unit: string;
  readonly localFrame: number;
  readonly ordinal: number;
  readonly record: Readonly<AccessUnitRecord>;
  readonly blobKey?: string;
  readonly blobRange?: Readonly<UnitBlobRange>;
  readonly relativeRange?: Readonly<ByteRange>;
  readonly range: Readonly<ByteRange>;
}

export interface RuntimeCatalogRecordIndex {
  readonly size: number;
  get(
    rendition: string,
    unit: string,
    localFrame: number
  ): Readonly<RuntimeCatalogAccessUnit> | undefined;
  require(
    rendition: string,
    unit: string,
    localFrame: number
  ): Readonly<RuntimeCatalogAccessUnit>;
  values(): readonly Readonly<RuntimeCatalogAccessUnit>[];
}

export interface RuntimeCatalogStaticFrame {
  readonly frame: Readonly<StaticFrameV01>;
  readonly range: Readonly<StaticBlobRange>;
  readonly blobKey?: string;
  readonly png: Readonly<ValidatedStaticPngProfile>;
}

export interface CatalogMapBuildInput {
  readonly frontIndex: Readonly<ParsedFrontIndex>;
  readonly declaredFileLength: number;
  readonly resolveStaticPng: (
    staticFrame: string
  ) => Readonly<ValidatedStaticPngProfile>;
}

export interface CatalogMaps {
  readonly renditions: Map<string, Readonly<RenditionV01>>;
  readonly units: Map<string, Readonly<UnitV01>>;
  readonly states: Map<string, Readonly<StateV01>>;
  readonly edges: Map<string, Readonly<EdgeV01>>;
  readonly ports: Map<string, Readonly<RuntimeCatalogPortEntry>>;
  readonly records: Map<string, Readonly<RuntimeCatalogAccessUnit>>;
  readonly staticFrames: Map<string, Readonly<RuntimeCatalogStaticFrame>>;
}

export function buildCatalogMaps(
  input: Readonly<CatalogMapBuildInput>
): CatalogMaps {
  if (typeof input !== "object" || input === null) {
    throw indexError("asset catalog map input is invalid");
  }
  const frontIndex = input.frontIndex;
  const byteLength = input.declaredFileLength;
  if (
    typeof frontIndex !== "object" ||
    frontIndex === null ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    frontIndex.header?.declaredFileLength !== byteLength ||
    typeof input.resolveStaticPng !== "function"
  ) {
    throw indexError("asset catalog front-index geometry is invalid");
  }
  const manifest = frontIndex.manifest;
  const renditions = indexById<RenditionV01>(
    manifest.renditions,
    "rendition"
  );
  const units = indexById<UnitV01>(manifest.units, "unit");
  const states = indexById<StateV01>(manifest.states, "state");
  const edges = indexById<EdgeV01>(manifest.edges, "edge");
  const ports = new Map<string, Readonly<RuntimeCatalogPortEntry>>();
  const records = new Map<string, Readonly<RuntimeCatalogAccessUnit>>();
  const staticFrames = new Map<string, Readonly<RuntimeCatalogStaticFrame>>();
  const unitBlobs = indexUnitBlobs(frontIndex, byteLength);

  for (const unit of manifest.units) {
    if (unit.kind !== "body") continue;
    for (const port of unit.ports) {
      insertUnique(
        ports,
        portIdentity(unit.id, port.id),
        Object.freeze({ unit: unit.id, port }),
        "validated asset contains a duplicate body port"
      );
    }
  }

  for (let ordinal = 0; ordinal < frontIndex.records.length; ordinal += 1) {
    const record = frontIndex.records[ordinal];
    if (record === undefined) {
      throw indexError("validated asset record array is sparse");
    }
    const rendition = manifest.renditions[record.renditionIndex];
    const unit = manifest.units[record.unitIndex];
    if (rendition === undefined || unit === undefined) {
      throw indexError("validated asset record relation is missing");
    }
    checkedCatalogRangeEnd(
      record.payloadOffset,
      record.payloadLength,
      byteLength
    );
    const blob = unitBlobs.get(unitBlobIdentity(rendition.id, unit.id));
    if (blob === undefined) {
      throw indexError("validated asset record has no containing unit blob");
    }
    const blobEnd = checkedCatalogRangeEnd(
      blob.offset,
      blob.length,
      byteLength
    );
    const recordEnd = record.payloadOffset + record.payloadLength;
    if (
      ordinal < blob.sampleStart ||
      ordinal >= blob.sampleStart + blob.sampleCount ||
      record.payloadOffset < blob.offset ||
      recordEnd > blobEnd
    ) {
      throw indexError("validated asset record exceeds its unit blob");
    }
    const range = Object.freeze({
      offset: record.payloadOffset,
      length: record.payloadLength
    });
    const relativeRange = Object.freeze({
      offset: record.payloadOffset - blob.offset,
      length: record.payloadLength
    });
    insertUnique(
      records,
      recordIdentity(rendition.id, unit.id, record.frameIndex),
      Object.freeze({
        rendition: rendition.id,
        unit: unit.id,
        localFrame: record.frameIndex,
        ordinal,
        record,
        blobKey: runtimeUnitBlobKey(rendition.id, unit.id),
        blobRange: blob,
        relativeRange,
        range
      }),
      "validated asset contains a duplicate access-unit identity"
    );
  }

  const staticDescriptorById = indexById(
    manifest.staticFrames,
    "static frame"
  );
  for (let index = 0; index < frontIndex.staticBlobs.length; index += 1) {
    const range = frontIndex.staticBlobs[index];
    if (range === undefined) {
      throw indexError("validated static PNG range relation is missing");
    }
    const frame = staticDescriptorById.get(range.staticFrame);
    if (frame === undefined) {
      throw indexError("validated static range relation is missing");
    }
    checkedCatalogRangeEnd(range.offset, range.length, byteLength);
    const staticFrame = frame.id;
    const entry: RuntimeCatalogStaticFrame = {
      frame,
      range,
      blobKey: runtimeStaticBlobKey(staticFrame),
      get png(): Readonly<ValidatedStaticPngProfile> {
        return input.resolveStaticPng(staticFrame);
      }
    };
    insertUnique(
      staticFrames,
      frame.id,
      Object.freeze(entry),
      "validated asset contains a duplicate static range"
    );
  }
  if (staticFrames.size !== manifest.staticFrames.length) {
    throw indexError("validated static ranges do not cover every descriptor");
  }

  return Object.freeze({
    renditions,
    units,
    states,
    edges,
    ports,
    records,
    staticFrames
  });
}

export function runtimeUnitBlobKey(rendition: string, unit: string): string {
  return `unit:${rendition}:${unit}`;
}

export function runtimeStaticBlobKey(staticFrame: string): string {
  return `static:${staticFrame}`;
}

function indexUnitBlobs(
  frontIndex: Readonly<ParsedFrontIndex>,
  declaredFileLength: number
): ReadonlyMap<string, Readonly<UnitBlobRange>> {
  const result = new Map<string, Readonly<UnitBlobRange>>();
  for (const blob of frontIndex.unitBlobs) {
    checkedCatalogRangeEnd(blob.offset, blob.length, declaredFileLength);
    if (
      !Number.isSafeInteger(blob.sampleStart) ||
      !Number.isSafeInteger(blob.sampleCount) ||
      blob.sampleStart < 0 ||
      blob.sampleCount < 1 ||
      blob.sampleStart > frontIndex.records.length ||
      blob.sampleCount > frontIndex.records.length - blob.sampleStart
    ) {
      throw indexError("validated unit blob sample span is invalid");
    }
    insertUnique(
      result,
      unitBlobIdentity(blob.rendition, blob.unit),
      blob,
      "validated asset contains a duplicate unit blob"
    );
  }
  return result;
}

export function createCatalogIdIndex<TValue>(
  label: string,
  map: () => ReadonlyMap<string, Readonly<TValue>>,
  context: (id: string) => Readonly<RuntimeFailureContext>
): RuntimeCatalogIdIndex<TValue> {
  return Object.freeze({
    get size(): number {
      return map().size;
    },
    get(id: string): Readonly<TValue> | undefined {
      return map().get(id);
    },
    require(id: string): Readonly<TValue> {
      const value = map().get(id);
      if (value === undefined) {
        throw indexError(`asset catalog ${label} lookup failed`, context(id));
      }
      return value;
    },
    keys(): readonly string[] {
      return Object.freeze([...map().keys()]);
    },
    values(): readonly Readonly<TValue>[] {
      return Object.freeze([...map().values()]);
    }
  });
}

export function createCatalogPortIndex(
  map: () => ReadonlyMap<string, Readonly<RuntimeCatalogPortEntry>>
): RuntimeCatalogPortIndex {
  return Object.freeze({
    get size(): number {
      return map().size;
    },
    get(
      unit: string,
      port: string
    ): Readonly<RuntimeCatalogPortEntry> | undefined {
      return map().get(portIdentity(unit, port));
    },
    require(unit: string, port: string): Readonly<RuntimeCatalogPortEntry> {
      const value = map().get(portIdentity(unit, port));
      if (value === undefined) {
        throw indexError("asset catalog port lookup failed", {
          unit,
          path: port
        });
      }
      return value;
    },
    values(): readonly Readonly<RuntimeCatalogPortEntry>[] {
      return Object.freeze([...map().values()]);
    }
  });
}

export function createCatalogRecordIndex(
  map: () => ReadonlyMap<string, Readonly<RuntimeCatalogAccessUnit>>
): RuntimeCatalogRecordIndex {
  return Object.freeze({
    get size(): number {
      return map().size;
    },
    get(
      rendition: string,
      unit: string,
      localFrame: number
    ): Readonly<RuntimeCatalogAccessUnit> | undefined {
      return map().get(recordIdentity(rendition, unit, localFrame));
    },
    require(
      rendition: string,
      unit: string,
      localFrame: number
    ): Readonly<RuntimeCatalogAccessUnit> {
      const value = map().get(recordIdentity(rendition, unit, localFrame));
      if (value === undefined) {
        throw indexError("asset catalog access-unit lookup failed", {
          rendition,
          unit,
          localFrame
        });
      }
      return value;
    },
    values(): readonly Readonly<RuntimeCatalogAccessUnit>[] {
      return Object.freeze([...map().values()]);
    }
  });
}

export function checkedCatalogRangeEnd(
  offset: number,
  length: number,
  limit: number
): number {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    offset > limit ||
    length > limit - offset
  ) {
    throw indexError("validated asset byte range is unavailable");
  }
  return offset + length;
}

function indexById<TValue extends { readonly id: string }>(
  values: readonly Readonly<TValue>[],
  label: string
): Map<string, Readonly<TValue>> {
  const map = new Map<string, Readonly<TValue>>();
  for (const value of values) {
    insertUnique(
      map,
      value.id,
      value,
      `validated asset contains a duplicate ${label}`
    );
  }
  return map;
}

function insertUnique<TValue>(
  map: Map<string, TValue>,
  key: string,
  value: TValue,
  message: string
): void {
  if (map.has(key)) throw indexError(message);
  map.set(key, value);
}

function portIdentity(unit: string, port: string): string {
  return `${unit}/${port}`;
}

function unitBlobIdentity(rendition: string, unit: string): string {
  return runtimeUnitBlobKey(rendition, unit);
}

function recordIdentity(
  rendition: string,
  unit: string,
  localFrame: number
): string {
  return `${rendition}/${unit}/${String(localFrame)}`;
}

function indexError(
  message: string,
  context: Readonly<RuntimeFailureContext> = {}
): RuntimePlaybackError {
  return new RuntimePlaybackError(
    normalizeRuntimeFailure("invalid-asset", message, context)
  );
}
