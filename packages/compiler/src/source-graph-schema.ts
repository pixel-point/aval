import type {
  BindingSourceV01,
  BindingV01,
  EdgeV01,
  StartV01,
  TransitionV01,
  TriggerV01
} from "@rendered-motion/format";

import {
  boundedArray,
  exactKeys,
  identifier,
  invalid,
  integer,
  literal,
  oneOf,
  optionalIdentifier,
  record,
  sortUniqueById
} from "./schema-validation.js";

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
] as const satisfies readonly BindingSourceV01[];

export function cloneSourceEdges(
  value: unknown,
  maximum: number
): readonly EdgeV01[] {
  const inputs = boundedArray(value, "edges", 0, maximum);
  return sortUniqueById(inputs.map((entry, index) =>
    cloneEdge(entry, `edges[${String(index)}]`)
  ), "edges");
}

export function cloneSourceBindings(
  value: unknown,
  maximum: number
): readonly BindingV01[] {
  const inputs = boundedArray(value, "bindings", 0, maximum);
  const bindings = inputs.map((entry, index) => {
    const path = `bindings[${String(index)}]`;
    const input = record(entry, path);
    exactKeys(input, ["source", "event"], path);
    return Object.freeze({
      source: oneOf(input.source, BINDING_SOURCES, `${path}.source`),
      event: identifier(input.event, `${path}.event`)
    });
  }).sort((left, right) =>
    left.source < right.source ? -1 :
      left.source > right.source ? 1 :
        left.event < right.event ? -1 : left.event > right.event ? 1 : 0
  );
  for (let index = 1; index < bindings.length; index += 1) {
    if (bindings[index]?.source === bindings[index - 1]?.source) {
      invalid("bindings", `source ${bindings[index]!.source} is duplicated`);
    }
  }
  return Object.freeze(bindings);
}

function cloneEdge(value: unknown, path: string): EdgeV01 {
  const input = record(value, path);
  const startInput = record(input.start, `${path}.start`);
  const startType = oneOf(
    startInput.type,
    ["portal", "finish", "cut"] as const,
    `${path}.start.type`
  );
  const commonKeys = ["id", "from", "to", "start", "continuity"];
  const optionalCommon = ["trigger"];
  if (startType === "cut") {
    exactKeys(input, [...commonKeys, "targetRunwayFrames"], path, optionalCommon);
  } else {
    exactKeys(input, commonKeys, path, [...optionalCommon, "transition"]);
  }
  const id = identifier(input.id, `${path}.id`);
  const from = identifier(input.from, `${path}.from`);
  const to = identifier(input.to, `${path}.to`);
  const trigger = cloneTrigger(input.trigger, `${path}.trigger`);
  const start = cloneStart(startInput, startType, `${path}.start`);

  if (startType === "cut") {
    literal(input.continuity, "cut", `${path}.continuity`);
    return Object.freeze({
      id,
      from,
      to,
      ...(trigger === undefined ? {} : { trigger }),
      start: start as Extract<StartV01, { readonly type: "cut" }>,
      continuity: "cut",
      targetRunwayFrames: integer(
        input.targetRunwayFrames,
        `${path}.targetRunwayFrames`,
        6,
        12
      )
    });
  }
  const continuity = oneOf(
    input.continuity,
    ["exact-authored", "exact-reverse"] as const,
    `${path}.continuity`
  );
  const transition = cloneTransition(input.transition, `${path}.transition`);
  return Object.freeze({
    id,
    from,
    to,
    ...(trigger === undefined ? {} : { trigger }),
    start: start as Exclude<StartV01, { readonly type: "cut" }>,
    ...(transition === undefined ? {} : { transition }),
    continuity
  });
}

function cloneTrigger(value: unknown, path: string): TriggerV01 | undefined {
  if (value === undefined) return undefined;
  const input = record(value, path);
  const type = oneOf(input.type, ["event", "completion"] as const, `${path}.type`);
  if (type === "completion") {
    exactKeys(input, ["type"], path);
    return Object.freeze({ type });
  }
  exactKeys(input, ["type", "name"], path);
  return Object.freeze({ type, name: identifier(input.name, `${path}.name`) });
}

function cloneStart(
  input: Record<string, unknown>,
  type: "portal" | "finish" | "cut",
  path: string
): StartV01 {
  if (type === "portal") {
    exactKeys(
      input,
      ["type", "sourcePort", "targetPort", "maxWaitFrames"],
      path
    );
    return Object.freeze({
      type,
      sourcePort: identifier(input.sourcePort, `${path}.sourcePort`),
      targetPort: identifier(input.targetPort, `${path}.targetPort`),
      maxWaitFrames: integer(input.maxWaitFrames, `${path}.maxWaitFrames`, 0, 900)
    });
  }
  exactKeys(input, ["type", "targetPort", "maxWaitFrames"], path);
  const targetPort = identifier(input.targetPort, `${path}.targetPort`);
  if (type === "cut") {
    literal(input.maxWaitFrames, 1, `${path}.maxWaitFrames`);
    return Object.freeze({ type, targetPort, maxWaitFrames: 1 });
  }
  return Object.freeze({
    type,
    targetPort,
    maxWaitFrames: integer(input.maxWaitFrames, `${path}.maxWaitFrames`, 0, 900)
  });
}

function cloneTransition(
  value: unknown,
  path: string
): TransitionV01 | undefined {
  if (value === undefined) return undefined;
  const input = record(value, path);
  const kind = oneOf(input.kind, ["locked", "reversible"] as const, `${path}.kind`);
  if (kind === "locked") {
    exactKeys(input, ["kind", "unit"], path);
    return Object.freeze({ kind, unit: identifier(input.unit, `${path}.unit`) });
  }
  exactKeys(input, ["kind", "unit", "direction"], path, ["reverseOf"]);
  const reverseOf = optionalIdentifier(input.reverseOf, `${path}.reverseOf`);
  return Object.freeze({
    kind,
    unit: identifier(input.unit, `${path}.unit`),
    direction: oneOf(
      input.direction,
      ["forward", "reverse"] as const,
      `${path}.direction`
    ),
    ...(reverseOf === undefined ? {} : { reverseOf })
  });
}
