import { checkedAdd } from "./checked-integer.js";
import { resolveFormatBudgets } from "./constants.js";
import { FormatError, isFormatError } from "./errors.js";
import { adaptManifestToMotionGraph } from "./graph-adapter.js";
import { validateCompiledManifest } from "./manifest-schema.js";
import {
  compareAscii,
  exactKeys,
  identifier,
  nonNegativeInteger,
  oneOf,
  owns,
  positiveInteger,
  record
} from "./manifest-validation.js";
import type {
  CanonicalAssetInput,
  CompiledManifest,
  EncodedChunkInput,
  FormatBudgets,
  FormatOptions,
  UnitChunkSpan
} from "./model.js";

const BINDING_SOURCES = [
  "activate",
  "engagement.off",
  "engagement.on",
  "focus.in",
  "focus.out",
  "hidden",
  "pointer.enter",
  "pointer.leave",
  "visible"
] as const;
const UNIT_KINDS = ["body", "bridge", "reversible", "one-shot"] as const;
const MANIFEST_INPUT_KEYS = [
  "formatVersion",
  "generator",
  "codec",
  "bitstream",
  "layout",
  "canvas",
  "frameRate",
  "renditions",
  "units",
  "initialState",
  "states",
  "edges",
  "bindings",
  "readiness",
  "limits"
] as const;
const OPTIONAL_MANIFEST_INPUT_KEYS = ["rings"] as const;

export interface NormalizedWriterInput {
  readonly manifest: CompiledManifest;
  readonly chunks: readonly EncodedChunkInput[];
}

interface NormalizedUnitBase {
  readonly value: Record<string, unknown>;
  readonly id: string;
  readonly frameCount: number;
  readonly digests: ReadonlyMap<string, string>;
}

/** Clone, canonicalize, and validate writer metadata without copying payloads. */
export function normalizeWriterInput(
  input: CanonicalAssetInput,
  options?: FormatOptions
): Readonly<NormalizedWriterInput> {
  try {
    const budgets = resolveFormatBudgets(options);
    const root = record(input, "writer input");
    exactKeys(root, ["manifest", "chunks"], "writer input");
    const sourceManifest = record(root.manifest, "manifest input");
    exactKeys(
      sourceManifest,
      MANIFEST_INPUT_KEYS,
      "manifest input",
      OPTIONAL_MANIFEST_INPUT_KEYS
    );
    const sourceRenditions = boundedInputArray(
      sourceManifest.renditions,
      "manifest.renditions",
      budgets.maxRenditions,
      1
    );
    const renditionIds = authoredRenditionIds(sourceRenditions);
    const sourceUnits = sortById(
      boundedInputArray(sourceManifest.units, "manifest.units", budgets.maxUnits, 1),
      "units"
    );
    const unitBases = sourceUnits.map((unit, unitIndex) =>
      normalizeUnitBase(unit, unitIndex, renditionIds, budgets)
    );
    const blobCount = unitBases.length * renditionIds.length;
    if (!Number.isSafeInteger(blobCount) || blobCount > budgets.maxBlobRanges) {
      budget("blob range count");
    }

    const suppliedChunks = normalizeChunkInputs(
      boundedInputArray(root.chunks, "chunks", budgets.maxChunkRecords, 1),
      budgets.maxChunkBytes
    );
    const groups = groupChunks(suppliedChunks);
    const unitSpans: UnitChunkSpan[][] = Array.from(
      { length: unitBases.length },
      () => []
    );
    const orderedChunks: EncodedChunkInput[] = [];
    let chunkStart = 0;
    for (const rendition of renditionIds) {
      for (let unitIndex = 0; unitIndex < unitBases.length; unitIndex += 1) {
        const unit = unitBases[unitIndex]!;
        const key = chunkGroupKey(rendition, unit.id);
        const group = groups.get(key);
        if (group === undefined || group.length === 0) {
          invalid(`missing encoded chunks for ${rendition}/${unit.id}`);
        }
        groups.delete(key);
        group.sort((left, right) => left.decodeIndex - right.decodeIndex);
        let displayedFrames = 0;
        for (let index = 0; index < group.length; index += 1) {
          const chunk = group[index]!;
          if (chunk.decodeIndex !== index) {
            invalid(`${rendition}/${unit.id} decode indexes must be contiguous from zero`);
          }
          if (index === 0 && !chunk.randomAccess) {
            invalid(`${rendition}/${unit.id} must begin with a random-access chunk`);
          }
          displayedFrames = checkedAdd(
            displayedFrames,
            chunk.displayedFrameCount,
            budgets.maxTotalUnitFrames,
            "unit displayed frame count"
          );
          orderedChunks.push(chunk);
        }
        if (displayedFrames !== unit.frameCount) {
          invalid(`${rendition}/${unit.id} must display exactly ${String(unit.frameCount)} frames`);
        }
        const sha256 = unit.digests.get(rendition);
        if (sha256 === undefined) invalid(`${unit.id} is missing digest for ${rendition}`);
        unitSpans[unitIndex]!.push(Object.freeze({
          rendition,
          chunkStart,
          chunkCount: group.length,
          frameCount: unit.frameCount,
          sha256
        }));
        chunkStart = checkedAdd(
          chunkStart,
          group.length,
          budgets.maxChunkRecords,
          "chunk span end"
        );
      }
    }
    if (groups.size !== 0) invalid("chunks contain an unknown rendition or unit");
    if (orderedChunks.length !== suppliedChunks.length) invalid("chunks contain duplicate identities");

    const sourceStates = boundedInputArray(
      sourceManifest.states,
      "manifest.states",
      budgets.maxStates,
      1
    );
    const sourceEdges = boundedInputArray(sourceManifest.edges, "manifest.edges", budgets.maxEdges);
    const sourceBindings = boundedInputArray(
      sourceManifest.bindings,
      "manifest.bindings",
      budgets.maxBindings
    );
    const units = unitBases.map((unit, index) => ({
      ...unit.value,
      chunks: unitSpans[index]
    }));
    const sourceRings = owns(sourceManifest, "rings")
      ? boundedInputArray(sourceManifest.rings, "manifest.rings", budgets.maxRings, 1)
      : null;
    const manifestCandidate = {
      ...sourceManifest,
      renditions: sourceRenditions,
      units,
      states: sortById(sourceStates, "states"),
      edges: sortById(sourceEdges, "edges"),
      bindings: normalizeBindings(sourceBindings),
      ...(sourceRings === null ? {} : { rings: sortById(sourceRings, "rings") }),
      readiness: normalizeReadiness(sourceManifest.readiness, budgets)
    };
    const manifest = validateCompiledManifest(manifestCandidate, options);
    adaptManifestToMotionGraph(manifest);
    return Object.freeze({
      manifest,
      chunks: Object.freeze(orderedChunks)
    });
  } catch (error) {
    if (isFormatError(error)) {
      if (error.code === "BUDGET_EXCEEDED" || error.code === "INTEGER_UNSAFE") {
        throw error;
      }
      throw new FormatError("WRITER_INVALID", error.message, {
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.offset === undefined ? {} : { offset: error.offset })
      });
    }
    throw new FormatError("WRITER_INVALID", "writer input could not be normalized");
  }
}

function normalizeUnitBase(
  value: Record<string, unknown>,
  unitIndex: number,
  renditionIds: readonly string[],
  budgets: Readonly<FormatBudgets>
): NormalizedUnitBase {
  const path = `units[${String(unitIndex)}]`;
  const kind = oneOf(value.kind, UNIT_KINDS, `${path}.kind`);
  if (kind === "body") {
    exactKeys(value, ["id", "kind", "playback", "frameCount", "ports", "chunks"], path);
  } else if (kind === "reversible") {
    exactKeys(value, ["id", "kind", "frameCount", "residency", "chunks"], path);
  } else {
    exactKeys(value, ["id", "kind", "frameCount", "chunks"], path);
  }
  const id = identifier(value.id, `${path}.id`);
  const frameCount = positiveInteger(value.frameCount, `${path}.frameCount`);
  const digests = normalizeDigests(value.chunks, renditionIds, `${path}.chunks`);

  if (kind === "body") {
    const ports = sortById(
      boundedInputArray(value.ports, `${path}.ports`, budgets.maxPortsPerBody),
      `${path}.ports`
    ).map((port, index) => {
      const portPath = `${path}.ports[${String(index)}]`;
      exactKeys(port, ["id", "entryFrame", "portalFrames"], portPath);
      return {
        ...port,
        portalFrames: numericSort(
          boundedInputArray(port.portalFrames, `${portPath}.portalFrames`, frameCount, 1),
          `${portPath}.portalFrames`
        )
      };
    });
    const { chunks: _chunks, ...rest } = value;
    return { value: { ...rest, kind, ports }, id, frameCount, digests };
  }
  if (kind === "reversible") {
    const residency = record(value.residency, `${path}.residency`);
    exactKeys(residency, ["endpoints"], `${path}.residency`);
    const endpoints = exactInputArray(
      residency.endpoints,
      `${path}.residency.endpoints`,
      2
    ).map((endpoint, index) => {
      const endpointPath = `${path}.residency.endpoints[${String(index)}]`;
      const input = record(endpoint, endpointPath);
      exactKeys(input, ["state", "port", "frames"], endpointPath);
      return {
        ...input,
        state: identifier(input.state, `${endpointPath}.state`),
        port: identifier(input.port, `${endpointPath}.port`)
      };
    });
    endpoints.sort((left, right) =>
      compareAscii(left.state, right.state) || compareAscii(left.port, right.port)
    );
    const { chunks: _chunks, ...rest } = value;
    return {
      value: { ...rest, kind, residency: { ...residency, endpoints } },
      id,
      frameCount,
      digests
    };
  }
  const { chunks: _chunks, ...rest } = value;
  return { value: { ...rest, kind }, id, frameCount, digests };
}

function normalizeDigests(
  value: unknown,
  renditionIds: readonly string[],
  path: string
): ReadonlyMap<string, string> {
  const inputs = exactInputArray(value, path, renditionIds.length);
  const supplied = new Map<string, string>();
  for (let index = 0; index < inputs.length; index += 1) {
    const input = record(inputs[index], `${path}[${String(index)}]`);
    exactKeys(input, ["rendition", "sha256"], `${path}[${String(index)}]`);
    const rendition = identifier(input.rendition, `${path}[${String(index)}].rendition`);
    if (typeof input.sha256 !== "string") invalid(`${path}[${String(index)}].sha256 must be a string`);
    if (supplied.has(rendition)) invalid(`${path} duplicates rendition ${rendition}`);
    supplied.set(rendition, input.sha256);
  }
  for (const rendition of renditionIds) {
    if (!supplied.has(rendition)) invalid(`${path} is missing rendition ${rendition}`);
  }
  if (supplied.size !== renditionIds.length) invalid(`${path} references an unknown rendition`);
  return supplied;
}

function authoredRenditionIds(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const ids = values.map((value, index) => {
    const input = record(value, `renditions[${String(index)}]`);
    const id = identifier(input.id, `renditions[${String(index)}].id`);
    if (seen.has(id)) invalid(`renditions[${String(index)}].id duplicates ${id}`);
    seen.add(id);
    return id;
  });
  return Object.freeze(ids);
}

function normalizeChunkInputs(values: readonly unknown[], maxBytes: number): EncodedChunkInput[] {
  return values.map((value, index) => {
    const path = `chunks[${String(index)}]`;
    const input = record(value, path);
    exactKeys(
      input,
      [
        "rendition",
        "unit",
        "decodeIndex",
        "presentationTimestamp",
        "duration",
        "randomAccess",
        "displayedFrameCount",
        "bytes"
      ],
      path
    );
    if (typeof input.randomAccess !== "boolean") invalid(`${path}.randomAccess must be boolean`);
    if (!(input.bytes instanceof Uint8Array)) invalid(`${path}.bytes must be a Uint8Array`);
    if (input.bytes.byteLength < 1) invalid(`${path}.bytes must not be empty`);
    if (input.bytes.byteLength > maxBytes) budget(`${path}.bytes`);
    const displayedFrameCount = nonNegativeInteger(
      input.displayedFrameCount,
      `${path}.displayedFrameCount`
    );
    const duration = nonNegativeInteger(input.duration, `${path}.duration`);
    if (displayedFrameCount > 0 && duration === 0) {
      invalid(`${path}.duration must be positive when the chunk displays frames`);
    }
    return Object.freeze({
      rendition: identifier(input.rendition, `${path}.rendition`),
      unit: identifier(input.unit, `${path}.unit`),
      decodeIndex: nonNegativeInteger(input.decodeIndex, `${path}.decodeIndex`),
      presentationTimestamp: nonNegativeInteger(
        input.presentationTimestamp,
        `${path}.presentationTimestamp`
      ),
      duration,
      randomAccess: input.randomAccess,
      displayedFrameCount,
      bytes: input.bytes
    });
  });
}

function groupChunks(values: readonly EncodedChunkInput[]): Map<string, EncodedChunkInput[]> {
  const groups = new Map<string, EncodedChunkInput[]>();
  const identities = new Set<string>();
  for (const chunk of values) {
    const identity = `${chunkGroupKey(chunk.rendition, chunk.unit)}\u0000${String(chunk.decodeIndex)}`;
    if (identities.has(identity)) invalid(`duplicate encoded chunk ${identity}`);
    identities.add(identity);
    const key = chunkGroupKey(chunk.rendition, chunk.unit);
    const group = groups.get(key) ?? [];
    group.push(chunk);
    groups.set(key, group);
  }
  return groups;
}

function normalizeBindings(values: readonly unknown[]): readonly Record<string, unknown>[] {
  const bindings = values.map((value, index) => {
    const path = `bindings[${String(index)}]`;
    const binding = record(value, path);
    exactKeys(binding, ["source", "event"], path);
    return {
      ...binding,
      source: oneOf(binding.source, BINDING_SOURCES, `${path}.source`),
      event: identifier(binding.event, `${path}.event`)
    };
  });
  bindings.sort((left, right) =>
    compareAscii(left.source, right.source) || compareAscii(left.event, right.event)
  );
  return bindings;
}

function normalizeReadiness(value: unknown, budgets: Readonly<FormatBudgets>): Record<string, unknown> {
  const readiness = record(value, "manifest.readiness");
  exactKeys(readiness, ["policy", "bootstrapUnits", "immediateEdges"], "manifest.readiness");
  const bootstrapUnits = stringArray(
    boundedInputArray(readiness.bootstrapUnits, "readiness.bootstrapUnits", budgets.maxUnits),
    "readiness.bootstrapUnits"
  );
  const immediateEdges = stringArray(
    boundedInputArray(readiness.immediateEdges, "readiness.immediateEdges", budgets.maxEdges),
    "readiness.immediateEdges"
  );
  bootstrapUnits.sort(compareAscii);
  immediateEdges.sort(compareAscii);
  return { ...readiness, bootstrapUnits, immediateEdges };
}

function sortById(values: readonly unknown[], path: string): Record<string, unknown>[] {
  const identified = values.map((value, index) => {
    const entry = record(value, `${path}[${String(index)}]`);
    return { entry, id: identifier(entry.id, `${path}[${String(index)}].id`) };
  });
  identified.sort((left, right) => compareAscii(left.id, right.id));
  return identified.map(({ entry }) => entry);
}

function numericSort(values: readonly unknown[], path: string): number[] {
  const result = values.map((value, index) =>
    nonNegativeInteger(value, `${path}[${String(index)}]`)
  );
  result.sort((left, right) => left - right);
  return result;
}

function stringArray(values: readonly unknown[], path: string): string[] {
  return values.map((value, index) => identifier(value, `${path}[${String(index)}]`));
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  return value;
}

function boundedInputArray(
  value: unknown,
  path: string,
  maximum: number,
  minimum = 0
): readonly unknown[] {
  const array = requireArray(value, path);
  if (array.length > maximum) budget(`${path} count`);
  if (array.length < minimum) invalid(`${path} must contain at least ${String(minimum)} entries`);
  requireDenseArray(array, path);
  return array;
}

function exactInputArray(value: unknown, path: string, expected: number): readonly unknown[] {
  const array = requireArray(value, path);
  if (array.length !== expected) invalid(`${path} must contain exactly ${String(expected)} entries`);
  requireDenseArray(array, path);
  return array;
}

function requireDenseArray(value: readonly unknown[], path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!owns(value, String(index))) invalid(`${path}[${String(index)}] must not be sparse`);
  }
}

function chunkGroupKey(rendition: string, unit: string): string {
  return `${rendition}\u0000${unit}`;
}

function budget(label: string): never {
  throw new FormatError("BUDGET_EXCEEDED", `${label} exceeds the active budget`);
}

function invalid(message: string): never {
  throw new FormatError("WRITER_INVALID", message);
}
