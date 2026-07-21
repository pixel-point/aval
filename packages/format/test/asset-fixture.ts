import { serializeCanonicalJson } from "../src/canonical-json.js";
import { parseFrontIndex } from "../src/parser.js";
import type {
  CompiledManifest,
  EncodedChunkRecord
} from "../src/model.js";
import { writeCanonicalAsset } from "../src/writer.js";
import { validWriterInput } from "./writer-fixture.js";

export interface AssetFixture {
  readonly bytes: Uint8Array;
  readonly manifest: CompiledManifest;
  readonly manifestBytes: Uint8Array;
  readonly records: readonly EncodedChunkRecord[];
  readonly payloads: readonly Uint8Array[];
}

export interface AssetFixtureOptions {
  readonly sampleLength?: (ordinal: number) => number;
  readonly generatorSuffix?: string;
}

/** Build a small canonical 1.1 video asset. */
export function canonicalAssetFixture(
  options: AssetFixtureOptions = {}
): AssetFixture {
  const input = validWriterInput(
    options.generatorSuffix === undefined
      ? {}
      : { generatorSuffix: options.generatorSuffix }
  );
  const chunks = input.chunks.map((chunk, ordinal) => ({
    ...chunk,
    bytes: new Uint8Array(options.sampleLength?.(ordinal) ?? chunk.bytes.byteLength)
      .fill(ordinal & 0xff)
  }));
  const bytes = writeCanonicalAsset({ ...input, chunks });
  const front = parseFrontIndex(bytes);
  return {
    bytes,
    manifest: front.manifest,
    manifestBytes: serializeCanonicalJson(front.manifest),
    records: front.records,
    payloads: Object.freeze(chunks.map(({ bytes: payload }) => payload))
  };
}
