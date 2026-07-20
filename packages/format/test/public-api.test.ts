import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as packageApi from "@pixel-point/aval-format";
import * as sourceApi from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, "../../..");

const REQUIRED_RUNTIME_EXPORTS = Object.freeze([
  "CHUNK_INDEX_HEADER_LENGTH",
  "CHUNK_INDEX_MAGIC",
  "CHUNK_INDEX_RECORD_LENGTH",
  "FORMAT_VERSION_MAJOR",
  "FORMAT_VERSION_MINOR",
  "FormatError",
  "classifyDecoderColor",
  "createCanonicalChunkPlan",
  "deriveVideoRenditionGeometry",
  "h264CodecForLevel",
  "h264CodecForProfileLevel",
  "h264LevelLimits",
  "inspectH264AnnexBRendition",
  "minimumH264CompatibilityLevel",
  "maximumDecodedRgbaBytes",
  "prepareH264EncoderRendition",
  "parseH264Codec",
  "parseVideoCodecString",
  "isVideoCodecString",
  "inspectH265AnnexBRendition",
  "inspectVp9Rendition",
  "inspectAv1Rendition",
  "parseFrontIndex",
  "validateCompleteAsset",
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

describe("@pixel-point/aval-format public boundary", () => {
  it("exposes the canonical video surface from source and package root", () => {
    expect(Object.keys(packageApi).sort()).toEqual(Object.keys(sourceApi).sort());
    for (const name of REQUIRED_RUNTIME_EXPORTS) {
      expect(sourceApi[name]).toBeDefined();
      expect(packageApi[name]).toBe(sourceApi[name]);
    }
  });

  it("keeps all public collection constants and resolved budgets immutable", () => {
    expect(Object.isFrozen(packageApi.FORMAT_MAGIC)).toBe(true);
    expect(Object.isFrozen(packageApi.CHUNK_INDEX_MAGIC)).toBe(true);
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
        const executableText = text.replace(
          /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
          ""
        );
        expect(text, source).not.toMatch(FORBIDDEN_PLATFORM_IMPORT);
        expect(executableText, source).not.toMatch(FORBIDDEN_PLATFORM_IDENTIFIER);
      }
    }
  });

  it("does not leak internal runtime helpers through the package root", () => {
    const runtime = packageApi as Record<string, unknown>;
    for (const privateName of [
      "align8",
      "deriveCanonicalAssetLayout",
      "encodeEncodedChunkIndex",
      "encodeHeader",
      "parseEncodedChunkIndex",
      "parseCanonicalJson",
      "validateCompiledManifest",
      "validatePngEnvelope"
    ]) {
      expect(runtime[privateName]).toBeUndefined();
    }
  });
});
