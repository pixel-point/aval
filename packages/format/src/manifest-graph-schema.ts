import {
  MAX_RUNWAY_FRAMES,
  MIN_RUNWAY_FRAMES
} from "./manifest-constraints.js";
import {
  boundedArray,
  compareAscii,
  exactKeys,
  identifier,
  integerInRange,
  invalid,
  literal,
  nonNegativeInteger,
  oneOf,
  owns,
  record,
  requireIdOrder,
  requireStringOrder
} from "./manifest-validation.js";
import type {
  BindingSource,
  Binding,
  Edge,
  FormatBudgets,
  Readiness,
  Ring,
  Start,
  State,
  Transition,
  Trigger
} from "./model.js";

const BINDING_SOURCES = new Set<BindingSource>([
  "activate",
  "engagement.off",
  "engagement.on",
  "focus.in",
  "focus.out",
  "hidden",
  "pointer.enter",
  "pointer.leave",
  "visible"
]);

export function cloneStates(
  value: unknown,
  budgets: FormatBudgets,
  path: string
): readonly State[] {
  const inputs = boundedArray(value, path, 1, budgets.maxStates);
  const states = inputs.map((entry, index) => {
    const statePath = `${path}[${String(index)}]`;
    const input = record(entry, statePath);
    exactKeys(input, ["id", "bodyUnit"], statePath, ["initialUnit"]);
    const base = {
      id: identifier(input.id, `${statePath}.id`),
      bodyUnit: identifier(input.bodyUnit, `${statePath}.bodyUnit`)
    };
    if (!owns(input, "initialUnit")) {
      return Object.freeze(base);
    }
    return Object.freeze({
      ...base,
      initialUnit: identifier(input.initialUnit, `${statePath}.initialUnit`)
    });
  });
  requireIdOrder(states, path);
  return Object.freeze(states);
}

export function cloneEdges(
  value: unknown,
  budgets: FormatBudgets,
  path: string
): readonly Edge[] {
  const inputs = boundedArray(value, path, 0, budgets.maxEdges);
  const edges = inputs.map((entry, index) =>
    cloneEdge(entry, `${path}[${String(index)}]`)
  );
  requireIdOrder(edges, path);
  return Object.freeze(edges);
}

const TURN_KEYS = ["ring", "step", "derived"] as const;

function cloneEdge(value: unknown, path: string): Edge {
  const input = record(value, path);
  const startProbe = record(input.start, `${path}.start`);
  const cut = startProbe.type === "cut";
  exactKeys(
    input,
    cut
      ? ["id", "from", "to", "start", "continuity", "targetRunwayFrames"]
      : ["id", "from", "to", "start", "continuity"],
    path,
    cut ? ["trigger", ...TURN_KEYS] : ["trigger", "transition", ...TURN_KEYS]
  );
  const turn = cloneTurnMembership(input, path);
  const id = identifier(input.id, `${path}.id`);
  const from = identifier(input.from, `${path}.from`);
  const to = identifier(input.to, `${path}.to`);
  if (from === to) {
    invalid(`${path}.to`, "must differ from from");
  }
  const trigger = owns(input, "trigger")
    ? cloneTrigger(input.trigger, `${path}.trigger`)
    : undefined;
  const start = cloneStart(input.start, `${path}.start`);

  if (start.type === "cut") {
    literal(input.continuity, "cut", `${path}.continuity`);
    const targetRunwayFrames = integerInRange(
      input.targetRunwayFrames,
      `${path}.targetRunwayFrames`,
      MIN_RUNWAY_FRAMES,
      MAX_RUNWAY_FRAMES
    );
    const base = {
      id,
      from,
      to,
      start,
      continuity: "cut",
      targetRunwayFrames,
      ...turn
    } as const;
    return trigger === undefined
      ? Object.freeze(base)
      : Object.freeze({ ...base, trigger });
  }

  const continuity = oneOf(
    input.continuity,
    ["exact-authored", "exact-reverse"],
    `${path}.continuity`
  );
  const transition = owns(input, "transition")
    ? cloneTransition(input.transition, `${path}.transition`)
    : undefined;
  const base = { id, from, to, start, continuity, ...turn } as const;
  if (trigger === undefined && transition === undefined) {
    return Object.freeze(base);
  }
  if (trigger === undefined) {
    return Object.freeze({ ...base, transition: transition! });
  }
  if (transition === undefined) {
    return Object.freeze({ ...base, trigger });
  }
  return Object.freeze({ ...base, trigger, transition });
}

/**
 * Read the optional ring membership of a turn edge. `ring` and `step` travel
 * together: a step is meaningless without the axis it steps along.
 */
function cloneTurnMembership(
  input: Record<string, unknown>,
  path: string
): {
  readonly ring?: string;
  readonly step?: 1 | -1;
  readonly derived?: true;
} {
  const hasRing = owns(input, "ring");
  if (!hasRing && !owns(input, "step")) {
    if (owns(input, "derived")) {
      invalid(`${path}.derived`, "requires ring membership");
    }
    return {};
  }
  if (!hasRing) invalid(`${path}.ring`, "is required by step");
  const ring = identifier(input.ring, `${path}.ring`);
  if (input.step !== 1 && input.step !== -1) {
    invalid(`${path}.step`, "must be 1 or -1");
  }
  if (!owns(input, "derived")) return { ring, step: input.step };
  if (input.derived !== true) {
    invalid(`${path}.derived`, "must be true when present");
  }
  return { ring, step: input.step, derived: true };
}

/**
 * Validate the manifest's rings. Member order is authored, so it is preserved;
 * only the ring array itself must be sorted, which keeps the canonical bytes
 * independent of authoring order.
 */
export function cloneRings(
  value: unknown,
  budgets: FormatBudgets,
  path: string
): readonly Ring[] {
  const inputs = boundedArray(value, path, 1, budgets.maxRings);
  const rings = inputs.map((entry, index) => {
    const ringPath = `${path}[${String(index)}]`;
    const input = record(entry, ringPath);
    exactKeys(
      input,
      ["id", "states", "cyclic", "tieBreak", "maxChainedSteps"],
      ringPath
    );
    const id = identifier(input.id, `${ringPath}.id`);
    const states = boundedArray(
      input.states,
      `${ringPath}.states`,
      2,
      budgets.maxRingStates
    ).map((state, stateIndex) =>
      identifier(state, `${ringPath}.states[${String(stateIndex)}]`)
    );
    if (new Set(states).size !== states.length) {
      invalid(`${ringPath}.states`, "must be unique");
    }
    if (typeof input.cyclic !== "boolean") {
      invalid(`${ringPath}.cyclic`, "must be a boolean");
    }
    if (input.cyclic && states.length < 3) {
      invalid(`${ringPath}.states`, "must contain 3 states when cyclic");
    }
    return Object.freeze({
      id,
      states: Object.freeze(states),
      cyclic: input.cyclic,
      tieBreak: oneOf(
        input.tieBreak,
        ["forward", "backward"],
        `${ringPath}.tieBreak`
      ),
      maxChainedSteps: integerInRange(
        input.maxChainedSteps,
        `${ringPath}.maxChainedSteps`,
        1,
        budgets.maxRingStates
      )
    });
  });
  requireIdOrder(rings, path);
  return Object.freeze(rings);
}

function cloneTrigger(value: unknown, path: string): Trigger {
  const input = record(value, path);
  if (input.type === "completion") {
    exactKeys(input, ["type"], path);
    return Object.freeze({ type: "completion" });
  }
  if (input.type === "event") {
    exactKeys(input, ["type", "name"], path);
    return Object.freeze({
      type: "event",
      name: identifier(input.name, `${path}.name`)
    });
  }
  invalid(`${path}.type`, "must be event or completion");
}

function cloneStart(value: unknown, path: string): Start {
  const input = record(value, path);
  if (input.type === "portal") {
    exactKeys(input, ["type", "sourcePort", "targetPort", "maxWaitFrames"], path);
    return Object.freeze({
      type: "portal",
      sourcePort: identifier(input.sourcePort, `${path}.sourcePort`),
      targetPort: identifier(input.targetPort, `${path}.targetPort`),
      maxWaitFrames: nonNegativeInteger(input.maxWaitFrames, `${path}.maxWaitFrames`)
    });
  }
  if (input.type === "finish") {
    exactKeys(input, ["type", "targetPort", "maxWaitFrames"], path);
    return Object.freeze({
      type: "finish",
      targetPort: identifier(input.targetPort, `${path}.targetPort`),
      maxWaitFrames: nonNegativeInteger(input.maxWaitFrames, `${path}.maxWaitFrames`)
    });
  }
  if (input.type === "cut") {
    exactKeys(input, ["type", "targetPort", "maxWaitFrames"], path);
    literal(input.maxWaitFrames, 1, `${path}.maxWaitFrames`);
    return Object.freeze({
      type: "cut",
      targetPort: identifier(input.targetPort, `${path}.targetPort`),
      maxWaitFrames: 1
    });
  }
  invalid(`${path}.type`, "must be portal, finish, or cut");
}

function cloneTransition(value: unknown, path: string): Transition {
  const input = record(value, path);
  if (input.kind === "locked") {
    exactKeys(input, ["kind", "unit"], path);
    return Object.freeze({
      kind: "locked",
      unit: identifier(input.unit, `${path}.unit`)
    });
  }
  if (input.kind === "reversible") {
    exactKeys(input, ["kind", "unit", "direction"], path, ["reverseOf"]);
    const base = {
      kind: "reversible",
      unit: identifier(input.unit, `${path}.unit`),
      direction: oneOf(
        input.direction,
        ["forward", "reverse"],
        `${path}.direction`
      )
    } as const;
    if (!owns(input, "reverseOf")) {
      return Object.freeze(base);
    }
    return Object.freeze({
      ...base,
      reverseOf: identifier(input.reverseOf, `${path}.reverseOf`)
    });
  }
  invalid(`${path}.kind`, "must be locked or reversible");
}

export function cloneBindings(
  value: unknown,
  budgets: FormatBudgets,
  path: string
): readonly Binding[] {
  const inputs = boundedArray(value, path, 0, budgets.maxBindings);
  const bindings = inputs.map((entry, index) => {
    const bindingPath = `${path}[${String(index)}]`;
    const input = record(entry, bindingPath);
    exactKeys(input, ["source", "event"], bindingPath);
    if (typeof input.source !== "string" || !BINDING_SOURCES.has(input.source as BindingSource)) {
      invalid(`${bindingPath}.source`, "is not a supported binding source");
    }
    return Object.freeze({
      source: input.source as BindingSource,
      event: identifier(input.event, `${bindingPath}.event`)
    });
  });
  for (let index = 1; index < bindings.length; index += 1) {
    const previous = bindings[index - 1]!;
    const current = bindings[index]!;
    const order = compareAscii(previous.source, current.source) ||
      compareAscii(previous.event, current.event);
    if (order >= 0) {
      invalid(path, "must be sorted and unique by source then event");
    }
    if (previous.source === current.source) {
      invalid(`${path}[${String(index)}].source`, "duplicates a binding source");
    }
  }
  return Object.freeze(bindings);
}

export function cloneReadiness(
  value: unknown,
  budgets: FormatBudgets,
  path: string
): Readiness {
  const input = record(value, path);
  exactKeys(input, ["policy", "bootstrapUnits", "immediateEdges"], path);
  literal(input.policy, "all-routes", `${path}.policy`);
  const bootstrapUnits = cloneIdArray(
    input.bootstrapUnits,
    budgets.maxUnits,
    `${path}.bootstrapUnits`
  );
  const immediateEdges = cloneIdArray(
    input.immediateEdges,
    budgets.maxEdges,
    `${path}.immediateEdges`
  );
  return Object.freeze({
    policy: "all-routes",
    bootstrapUnits,
    immediateEdges
  });
}

function cloneIdArray(
  value: unknown,
  maximum: number,
  path: string
): readonly string[] {
  const inputs = boundedArray(value, path, 0, maximum);
  const ids = inputs.map((entry, index) =>
    identifier(entry, `${path}[${String(index)}]`)
  );
  requireStringOrder(ids, path);
  return Object.freeze(ids);
}
