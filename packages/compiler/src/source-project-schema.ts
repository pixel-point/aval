import {
  FORMAT_DEFAULT_BUDGETS,
  FormatError,
  parseStrictJson
} from "@pixel-point/aval-format";

import { CompilerError } from "./diagnostics.js";
import type {
  Canvas,
  NormalizedSourceProject
} from "./model.js";
import {
  exactKeys,
  identifier,
  integer,
  invalid,
  literal,
  oneOf,
  record,
  tuple
} from "./schema-validation.js";
import {
  cloneSourceDescriptors,
  cloneSourceFrameRate,
  cloneSourceStates,
  cloneSourceUnits,
  greatestCommonDivisor,
  validateSourceReferences
} from "./source-project-schema-common.js";
import {
  cloneSourceBindings,
  cloneSourceEdges
} from "./source-graph-schema.js";
import { preflightSourceGraph } from "./source-graph-preflight.js";
import { cloneVideoEncodings } from "./compile/video-encoding-policy.js";

const PROJECT_KEYS = [
  "projectVersion",
  "alpha",
  "canvas",
  "frameRate",
  "sources",
  "encodings",
  "units",
  "initialState",
  "states",
  "edges",
  "bindings"
] as const;
const PNG_DIMENSION_MAX = 0xffff_ffff;

/** Parse strict JSON and validate the sole project format. */
export function parseSourceProject(
  bytes: Uint8Array
): Readonly<NormalizedSourceProject> {
  let value: unknown;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof FormatError) {
      throw new CompilerError("INPUT_INVALID", error.message, { cause: error });
    }
    throw error;
  }
  return validateSourceProject(value);
}

/** Validate the exact project 1.0 schema and return its normalized model. */
export function validateSourceProject(
  value: unknown
): Readonly<NormalizedSourceProject> {
  const input = record(value, "project");
  exactKeys(input, PROJECT_KEYS, "project");
  literal(input.projectVersion, "1.0", "project.projectVersion");
  const canvas = cloneCanvas(input.canvas);
  const frameRate = cloneSourceFrameRate(input.frameRate);
  const sources = cloneSourceDescriptors(input.sources);
  const units = cloneSourceUnits(input.units, sources);
  const states = cloneSourceStates(input.states, units);
  const edges = cloneSourceEdges(input.edges, FORMAT_DEFAULT_BUDGETS.maxEdges);
  const bindings = cloneSourceBindings(
    input.bindings,
    FORMAT_DEFAULT_BUDGETS.maxBindings
  );
  const initialState = identifier(input.initialState, "project.initialState");
  validateSourceReferences({
    initialState,
    sources,
    units,
    states,
    edges,
    bindings
  });
  const project = Object.freeze({
    projectVersion: "1.0" as const,
    alpha: oneOf(
      input.alpha,
      ["auto", "opaque", "packed"] as const,
      "project.alpha"
    ),
    canvas,
    frameRate,
    sources,
    encodings: cloneVideoEncodings(input.encodings, canvas),
    units,
    initialState,
    states,
    edges,
    bindings
  }) satisfies Readonly<NormalizedSourceProject>;
  preflightSourceGraph(project);
  return project;
}

function cloneCanvas(value: unknown): Canvas {
  const input = record(value, "canvas");
  exactKeys(
    input,
    ["width", "height", "fit", "pixelAspect", "colorSpace"],
    "canvas"
  );
  const width = integer(input.width, "canvas.width", 1, PNG_DIMENSION_MAX);
  const height = integer(input.height, "canvas.height", 1, PNG_DIMENSION_MAX);
  const aspectInput = tuple(input.pixelAspect, 2, "canvas.pixelAspect");
  const numerator = integer(
    aspectInput[0],
    "canvas.pixelAspect[0]",
    1,
    10_000
  );
  const denominator = integer(
    aspectInput[1],
    "canvas.pixelAspect[1]",
    1,
    10_000
  );
  if (greatestCommonDivisor(numerator, denominator) !== 1) {
    invalid("canvas.pixelAspect", "must be a reduced positive fraction");
  }
  return Object.freeze({
    width,
    height,
    fit: oneOf(
      input.fit,
      ["contain", "cover", "fill", "none"] as const,
      "canvas.fit"
    ),
    pixelAspect: Object.freeze([numerator, denominator]) as readonly [
      number,
      number
    ],
    colorSpace: literal(input.colorSpace, "srgb", "canvas.colorSpace")
  });
}
