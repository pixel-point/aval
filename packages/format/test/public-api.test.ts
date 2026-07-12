import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as packageApi from "@rendered-motion/format";
import * as sourceApi from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, "../../..");

const RUNTIME_EXPORTS = Object.freeze([
  "ACCESS_UNIT_INDEX_HEADER_LENGTH",
  "ACCESS_UNIT_INDEX_MAGIC",
  "ACCESS_UNIT_RECORD_LENGTH",
  "AVC_DECODER_SURFACE_PADDING",
  "AvcIncrementalInspector",
  "FORMAT_ALIGNMENT",
  "FORMAT_DEFAULT_BUDGETS",
  "FORMAT_HEADER_LENGTH",
  "FORMAT_MAGIC",
  "FORMAT_VERSION_MAJOR",
  "FORMAT_VERSION_MINOR",
  "FormatError",
  "IDENTIFIER_PATTERN",
  "REFERENCE_FRAME_HEADER_LENGTH",
  "REFERENCE_FRAME_MAGIC",
  "SHA256_HEX_PATTERN",
  "adaptManifestToMotionGraph",
  "encodeReferenceFrame",
  "inspectAvcAnnexBEncoderCandidateRendition",
  "inspectAvcAnnexBRendition",
  "maximumAvcDecodedRgbaBytes",
  "maximumAvcDecoderSurfaceDimension",
  "parseStrictJson",
  "parseFrontIndex",
  "parseHeader",
  "parseReferenceFrameHeader",
  "prepareAvcEncoderRendition",
  "resolveFormatBudgets",
  "serializeCanonicalJson",
  "serializeCanonicalJsonWithLimits",
  "validateCompleteAsset",
  "validateReferenceFrame",
  "writeCanonicalAsset"
] as const);

const FORBIDDEN_PLATFORM_IMPORT =
  /(?:from\s+|import\s*\()["'](?:node:|fs(?:\/|["'])|http(?:\/|["'])|https(?:\/|["'])|net(?:\/|["'])|tls(?:\/|["'])|crypto(?:\/|["'])|timers(?:\/|["'])|undici(?:\/|["']))/u;
const FORBIDDEN_PLATFORM_IDENTIFIER =
  /\b(?:DOM|WebCodecs|Document|HTMLElement|HTMLVideoElement|VideoDecoder|VideoFrame|EncodedVideoChunk|ImageBitmap|CanvasRenderingContext2D|WebGL2RenderingContext|Window|NodeJS|Buffer|Crypto|CryptoKey|SubtleCrypto|setTimeout|setInterval|clearTimeout|clearInterval|fetch|XMLHttpRequest|WebSocket)\b/u;

function productionSources(packageName: "format" | "graph"): readonly string[] {
  const sourceDirectory = resolve(WORKSPACE, `packages/${packageName}/src`);
  return readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .sort()
    .map((entry) => resolve(sourceDirectory, entry));
}

describe("@rendered-motion/format public boundary", () => {
  it("exposes exactly the approved runtime surface from source and package root", () => {
    expect(Object.keys(sourceApi).sort()).toEqual([...RUNTIME_EXPORTS].sort());
    expect(Object.keys(packageApi).sort()).toEqual([...RUNTIME_EXPORTS].sort());

    for (const name of RUNTIME_EXPORTS) {
      expect(packageApi[name]).toBe(sourceApi[name]);
    }
  });

  it("keeps all public collection constants and resolved budgets immutable", () => {
    expect(Object.isFrozen(packageApi.FORMAT_MAGIC)).toBe(true);
    expect(Object.isFrozen(packageApi.ACCESS_UNIT_INDEX_MAGIC)).toBe(true);
    expect(Object.isFrozen(packageApi.REFERENCE_FRAME_MAGIC)).toBe(true);
    expect(Object.isFrozen(packageApi.IDENTIFIER_PATTERN)).toBe(true);
    expect(Object.isFrozen(packageApi.SHA256_HEX_PATTERN)).toBe(true);
    expect(Object.isFrozen(packageApi.FORMAT_DEFAULT_BUDGETS)).toBe(true);
    expect(
      Object.isFrozen(
        packageApi.resolveFormatBudgets({ budgets: { maxStates: 3 } })
      )
    ).toBe(true);
  });

  it("keeps the production declaration/source graph platform-independent", () => {
    for (const packageName of ["format", "graph"] as const) {
      const config = JSON.parse(
        readFileSync(
          resolve(WORKSPACE, `packages/${packageName}/tsconfig.json`),
          "utf8"
        )
      ) as {
        readonly compilerOptions?: {
          readonly lib?: readonly string[];
          readonly types?: readonly string[];
        };
      };

      expect(config.compilerOptions?.lib).toEqual(["ES2023"]);
      expect(config.compilerOptions?.types).toEqual([]);

      for (const source of productionSources(packageName)) {
        const text = readFileSync(source, "utf8");
        expect(text, source).not.toMatch(FORBIDDEN_PLATFORM_IMPORT);
        expect(text, source).not.toMatch(FORBIDDEN_PLATFORM_IDENTIFIER);
      }
    }
  });

  it("does not leak internal runtime helpers through the package root", () => {
    const runtime = packageApi as Record<string, unknown>;
    for (const privateName of [
      "align8",
      "deriveCanonicalAssetLayout",
      "encodeAccessUnitIndex",
      "encodeHeader",
      "parseAccessUnitIndex",
      "parseCanonicalJson",
      "validateCompiledManifestV01",
      "validatePngEnvelope"
    ]) {
      expect(runtime[privateName]).toBeUndefined();
    }
  });
});
