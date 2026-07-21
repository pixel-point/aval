import type {
  CanonicalAssetInput,
  CompiledManifest,
  CompiledManifestInput,
  OpaqueCompiledManifestInputV1_1,
  OpaqueCompiledManifestV1_1,
  PackedAlphaCompiledManifestInputV1_1,
  PackedAlphaCompiledManifestV1_1,
  ParsedFrontIndex
} from "../src/model.js";
import { validManifest } from "./manifest-fixture.js";

type OpaqueCanonicalAssetInput = Omit<CanonicalAssetInput, "manifest"> & {
  readonly manifest: OpaqueCompiledManifestInputV1_1;
};

function manifestInputFromCompiled(
  manifest: OpaqueCompiledManifestV1_1
): OpaqueCompiledManifestInputV1_1;
function manifestInputFromCompiled(
  manifest: PackedAlphaCompiledManifestV1_1
): PackedAlphaCompiledManifestInputV1_1;
function manifestInputFromCompiled(
  manifest: CompiledManifest
): CompiledManifestInput;
function manifestInputFromCompiled(
  manifest: CompiledManifest
): CompiledManifestInput {
  const { units, ...rest } = manifest;
  return {
    ...rest,
    units: units.map((unit) => {
      const { chunks, ...fields } = unit;
      return {
        ...fields,
        chunks: chunks.map(({ rendition, sha256 }) => ({ rendition, sha256 }))
      };
    })
  } as CompiledManifestInput;
}

export interface WriterFixtureOptions {
  readonly generatorSuffix?: string;
}

/** A fresh valid writer input with one encoded chunk per displayed frame. */
export function validWriterInput(
  options: WriterFixtureOptions = {}
): OpaqueCanonicalAssetInput {
  const compiled = validManifest();
  const baseManifest = manifestInputFromCompiled(compiled);
  const manifest: OpaqueCompiledManifestInputV1_1 = {
    ...baseManifest,
    generator: baseManifest.generator + (options.generatorSuffix ?? "")
  };
  let ordinal = 0;
  const chunks = compiled.renditions.flatMap((rendition) =>
    compiled.units.flatMap((unit) =>
      Array.from({ length: unit.frameCount }, (_, decodeIndex) => ({
        rendition: rendition.id,
        unit: unit.id,
        decodeIndex,
        presentationTimestamp: decodeIndex,
        duration: 1,
        randomAccess: decodeIndex === 0,
        displayedFrameCount: 1,
        bytes: new Uint8Array([0, 0, 1, ordinal++ & 0xff])
      }))
    )
  );
  return { manifest, chunks };
}

/** Extend the compact fixture to exercise authored rendition order. */
export function twoRenditionWriterInput(): CanonicalAssetInput {
  const input = validWriterInput();
  const original = input.manifest.renditions[0]!;
  const alternate = { ...original, id: "alternate", bitrate: { average: 500, peak: 1_000 } };
  const units = input.manifest.units.map((unit) => ({
    ...unit,
    chunks: [
      { rendition: alternate.id, sha256: unit.chunks[0]!.sha256 },
      ...unit.chunks
    ]
  })) as CompiledManifestInput["units"];
  return {
    manifest: {
      ...input.manifest,
      renditions: [alternate, original],
      units
    },
    chunks: [
      ...input.chunks.map((chunk) => ({
        ...chunk,
        rendition: alternate.id,
        bytes: chunk.bytes.slice()
      })),
      ...input.chunks
    ]
  };
}

/** Add bytes to the first chunk for large-offset boundary tests. */
export function largeChunkWriterInput(extraPayloadBytes: number): CanonicalAssetInput {
  if (!Number.isSafeInteger(extraPayloadBytes) || extraPayloadBytes < 0) {
    throw new Error("extra payload bytes must be a nonnegative safe integer");
  }
  const input = validWriterInput();
  return {
    ...input,
    manifest: {
      ...input.manifest,
      limits: {
        ...input.manifest.limits,
        maxCompiledBytes: Math.max(32 * 1024 * 1024, extraPayloadBytes + 1024 * 1024)
      }
    },
    chunks: input.chunks.map((chunk, ordinal) =>
      ordinal === 0
        ? { ...chunk, bytes: new Uint8Array(1 + extraPayloadBytes).fill(ordinal & 0xff) }
        : chunk
    )
  };
}

export function writerInputFromParsed(
  front: ParsedFrontIndex,
  payloads: Pick<CanonicalAssetInput, "chunks">
): CanonicalAssetInput {
  return {
    manifest: manifestInputFromCompiled(front.manifest),
    chunks: payloads.chunks
  };
}

/** Reverse semantically unordered input collections without changing meaning. */
export function shuffledWriterInput(input: CanonicalAssetInput): CanonicalAssetInput {
  return {
    manifest: {
      ...input.manifest,
      units: [...input.manifest.units].reverse().map((unit) => {
        if (unit.kind === "body") {
          return {
            ...unit,
            chunks: [...unit.chunks].reverse(),
            ports: [...unit.ports].reverse().map((port) => ({
              ...port,
              portalFrames: [...port.portalFrames].reverse()
            }))
          };
        }
        if (unit.kind === "reversible") {
          return {
            ...unit,
            chunks: [...unit.chunks].reverse(),
            residency: {
              endpoints: [...unit.residency.endpoints].reverse() as [
                typeof unit.residency.endpoints[0],
                typeof unit.residency.endpoints[1]
              ]
            }
          };
        }
        return { ...unit, chunks: [...unit.chunks].reverse() };
      }),
      states: [...input.manifest.states].reverse(),
      edges: [...input.manifest.edges].reverse(),
      bindings: [...input.manifest.bindings].reverse(),
      readiness: {
        ...input.manifest.readiness,
        bootstrapUnits: [...input.manifest.readiness.bootstrapUnits].reverse(),
        immediateEdges: [...input.manifest.readiness.immediateEdges].reverse()
      }
    },
    chunks: [...input.chunks].reverse()
  };
}

export function byteIdentity(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}
