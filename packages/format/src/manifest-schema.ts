import {
  FORMAT_SUPPORTED_VERSIONS,
  resolveFormatBudgets
} from "./constants.js";
import { FormatError } from "./errors.js";
import {
  cloneBindings,
  cloneEdges,
  cloneReadiness,
  cloneStates
} from "./manifest-graph-schema.js";
import { cloneDeclaredLimits } from "./manifest-limits-schema.js";
import {
  validateBlobCount,
  validateManifestRelations,
  validateRawBlobCount
} from "./manifest-relations.js";
import {
  cloneCanvas,
  cloneFrameRate,
  cloneRenditions
} from "./manifest-rendition-schema.js";
import {
  exactKeys,
  generatorString,
  identifier,
  oneOf,
  record,
  invalid
} from "./manifest-validation.js";
import { cloneUnits } from "./manifest-unit-schema.js";
import {
  VIDEO_BITSTREAM_BY_CODEC,
  VIDEO_CODECS
} from "./video/codec-string.js";
import type {
  CompiledManifest,
  FormatOptions
} from "./model.js";

const TOP_LEVEL_KEYS = [
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

/** Validate, detach, and recursively freeze one supported manifest version. */
export function validateCompiledManifest(
  value: unknown,
  options?: FormatOptions
): CompiledManifest {
  try {
    const budgets = resolveFormatBudgets(options);
    const input = record(value, "manifest");
    exactKeys(input, TOP_LEVEL_KEYS, "manifest");
    const formatVersion = oneOf(
      input.formatVersion,
      FORMAT_SUPPORTED_VERSIONS,
      "formatVersion"
    );
    const generator = generatorString(input.generator, "generator");
    const codec = oneOf(input.codec, VIDEO_CODECS, "codec");
    const bitstream = oneOf(
      input.bitstream,
      ["annex-b", "frame", "low-overhead"],
      "bitstream"
    );
    if (bitstream !== VIDEO_BITSTREAM_BY_CODEC[codec]) {
      invalid(
        "bitstream",
        `must be ${VIDEO_BITSTREAM_BY_CODEC[codec]} for ${codec}`
      );
    }
    const layout = oneOf(input.layout, ["opaque", "packed-alpha"], "layout");
    const canvas = cloneCanvas(input.canvas, "canvas");
    const frameRate = cloneFrameRate(input.frameRate, "frameRate");
    const renditions = cloneRenditions(
      input.renditions,
      canvas,
      codec,
      layout,
      formatVersion,
      budgets,
      "renditions"
    );
    validateRawBlobCount(input.units, renditions.length, budgets);
    const units = cloneUnits(input.units, renditions, budgets, "units");
    const initialState = identifier(input.initialState, "initialState");
    const states = cloneStates(input.states, budgets, "states");
    const edges = cloneEdges(input.edges, budgets, "edges");
    const bindings = cloneBindings(input.bindings, budgets, "bindings");
    const readiness = cloneReadiness(input.readiness, budgets, "readiness");
    const limits = cloneDeclaredLimits(
      input.limits,
      renditions,
      budgets,
      "limits"
    );

    validateBlobCount(units, renditions, budgets);
    validateManifestRelations({
      initialState,
      renditions,
      units,
      states,
      edges,
      bindings,
      readiness
    });

    return Object.freeze({
      formatVersion,
      generator,
      codec,
      bitstream,
      layout,
      canvas,
      frameRate,
      renditions,
      units,
      initialState,
      states,
      edges,
      bindings,
      readiness,
      limits
    }) as CompiledManifest;
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError("MANIFEST_INVALID", "manifest validation failed");
  }
}
