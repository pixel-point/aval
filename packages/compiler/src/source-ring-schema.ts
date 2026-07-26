import type { SourceRing, SourceRingOverride, SourceStart } from "./model.js";

import {
  boundedArray,
  exactKeys,
  identifier,
  integer,
  invalid,
  oneOf,
  optionalIdentifier,
  record,
  sortUniqueById
} from "./schema-validation.js";

export const MAX_RINGS = 8;
export const MAX_RING_STATES = 32;

/**
 * Validate the authored rings.
 *
 * Only the ring array is sorted; member order is the axis itself and must be
 * preserved exactly as authored. Structural rules which depend on the rest of
 * the project (member existence, adjacency, port compatibility) belong to ring
 * expansion, which owns the V1-V8 diagnostics.
 */
export function cloneSourceRings(value: unknown): readonly SourceRing[] {
  if (value === undefined) return Object.freeze([]);
  const inputs = boundedArray(value, "rings", 0, MAX_RINGS);
  return sortUniqueById(
    inputs.map((entry, index) => cloneRing(entry, `rings[${String(index)}]`)),
    "rings"
  );
}

function cloneRing(value: unknown, path: string): SourceRing {
  const input = record(value, path);
  exactKeys(
    input,
    ["id", "states", "cyclic", "tieBreak", "turn", "maxChainedSteps"],
    path,
    ["overrides"]
  );
  const id = identifier(input.id, `${path}.id`);
  // Length rules live in expansion, which can name the ring in its diagnostic.
  const stateInputs = boundedArray(
    input.states,
    `${path}.states`,
    0,
    MAX_RING_STATES
  );
  const states = stateInputs.map((state, index) =>
    identifier(state, `${path}.states[${String(index)}]`)
  );
  const cyclic = boolean(input.cyclic, `${path}.cyclic`);
  return Object.freeze({
    id,
    states: Object.freeze(states),
    cyclic,
    tieBreak: oneOf(
      input.tieBreak,
      ["forward", "backward"] as const,
      `${path}.tieBreak`
    ),
    turn: cloneTurn(input.turn, `${path}.turn`),
    maxChainedSteps: integer(
      input.maxChainedSteps,
      `${path}.maxChainedSteps`,
      1,
      MAX_RING_STATES
    ),
    overrides: cloneOverrides(input.overrides, `${path}.overrides`)
  });
}

function cloneTurn(value: unknown, path: string): SourceRing["turn"] {
  const input = record(value, path);
  exactKeys(input, ["mode", "start", "continuity"], path);
  return Object.freeze({
    mode: oneOf(input.mode, ["cut", "unit"] as const, `${path}.mode`),
    start: cloneStart(input.start, `${path}.start`),
    continuity: oneOf(
      input.continuity,
      ["exact-authored", "exact-reverse"] as const,
      `${path}.continuity`
    )
  });
}

/**
 * Every step departs at an authored boundary, so a ring's start policy is a
 * portal or a finish. The compiled step is a cut only in the sense that it plays
 * no bridge unit, which `turn.mode` decides.
 */
function cloneStart(
  value: unknown,
  path: string
): Exclude<SourceStart, { readonly type: "cut" }> {
  const input = record(value, path);
  const type = oneOf(input.type, ["portal", "finish"] as const, `${path}.type`);
  if (type === "portal") {
    exactKeys(input, ["type", "sourcePort", "targetPort", "maxWaitFrames"], path);
    return Object.freeze({
      type,
      sourcePort: identifier(input.sourcePort, `${path}.sourcePort`),
      targetPort: identifier(input.targetPort, `${path}.targetPort`),
      maxWaitFrames: integer(input.maxWaitFrames, `${path}.maxWaitFrames`, 0)
    });
  }
  exactKeys(input, ["type", "targetPort", "maxWaitFrames"], path);
  return Object.freeze({
    type,
    targetPort: identifier(input.targetPort, `${path}.targetPort`),
    maxWaitFrames: integer(input.maxWaitFrames, `${path}.maxWaitFrames`, 0)
  });
}

function cloneOverrides(
  value: unknown,
  path: string
): readonly SourceRingOverride[] {
  if (value === undefined) return Object.freeze([]);
  const inputs = boundedArray(value, path, 0, MAX_RING_STATES * 2);
  const seen = new Set<string>();
  const overrides = inputs.map((entry, index) => {
    const overridePath = `${path}[${String(index)}]`;
    const input = record(entry, overridePath);
    exactKeys(input, ["from", "to", "mode"], overridePath, [
      "unit",
      "direction",
      "continuity"
    ]);
    const from = identifier(input.from, `${overridePath}.from`);
    const to = identifier(input.to, `${overridePath}.to`);
    const key = `${from} ${to}`;
    if (seen.has(key)) {
      invalid(overridePath, `duplicates the step ${from} to ${to}`);
    }
    seen.add(key);
    const mode = oneOf(input.mode, ["cut", "unit"] as const, `${overridePath}.mode`);
    const unit = optionalIdentifier(input.unit, `${overridePath}.unit`);
    if (mode === "unit" && unit === undefined) {
      invalid(`${overridePath}.unit`, "is required by mode unit");
    }
    if (mode === "cut" && unit !== undefined) {
      invalid(`${overridePath}.unit`, "is not allowed by mode cut");
    }
    return Object.freeze({
      from,
      to,
      mode,
      ...(unit === undefined ? {} : { unit }),
      ...(input.direction === undefined
        ? {}
        : {
            direction: oneOf(
              input.direction,
              ["forward", "reverse"] as const,
              `${overridePath}.direction`
            )
          }),
      ...(input.continuity === undefined
        ? {}
        : {
            continuity: oneOf(
              input.continuity,
              ["exact-authored", "exact-reverse"] as const,
              `${overridePath}.continuity`
            )
          })
    });
  });
  return Object.freeze(overrides);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}
