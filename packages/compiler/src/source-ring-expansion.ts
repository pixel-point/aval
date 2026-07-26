import type {
  SourceEdge,
  SourceRing,
  SourceRingOverride,
  SourceState,
  SourceTransition,
  SourceUnit
} from "./model.js";
import { identifier, invalid } from "./schema-validation.js";

export interface RingExpansionInput {
  readonly rings: readonly SourceRing[];
  readonly states: readonly SourceState[];
  readonly units: readonly SourceUnit[];
  readonly edges: readonly SourceEdge[];
}

export interface RingExpansion {
  /** Authored edges first, then every derived step, sorted by id. */
  readonly edges: readonly SourceEdge[];
  readonly notes: readonly string[];
}

interface StepPair {
  readonly from: string;
  readonly to: string;
  readonly step: 1 | -1;
}

/**
 * Expand every ring into the turn edges which walk it.
 *
 * A ring is authoring shorthand: the compiled asset still contains one ordinary
 * edge per ordered neighbour pair, so nothing downstream has to understand rings
 * to play them. Derived edges are marked so `inspect` can tell them apart from
 * authored ones, and an authored edge always wins over the step it shadows.
 */
export function expandSourceRings(
  input: Readonly<RingExpansionInput>
): Readonly<RingExpansion> {
  if (input.rings.length === 0) {
    return Object.freeze({ edges: input.edges, notes: Object.freeze([]) });
  }

  const stateIds = new Set(input.states.map(({ id }) => id));
  const portsByState = indexPortsByState(input.states, input.units);
  const authoredByPair = new Map<string, SourceEdge>();
  for (const edge of input.edges) {
    authoredByPair.set(pairKey(edge.from, edge.to), edge);
  }

  const notes: string[] = [];
  const derived: SourceEdge[] = [];
  const owners = new Map<string, string>();
  const ringsById = new Map(input.rings.map((ring) => [ring.id, ring]));

  for (const ring of input.rings) {
    validateRingMembers(ring, stateIds);
    const pairs = neighbourPairs(ring);
    const pairSet = new Set(pairs.map(({ from, to }) => pairKey(from, to)));
    validateOverrides(ring, pairSet);
    validateUnitMode(ring, pairs);

    for (const pair of pairs) {
      const key = pairKey(pair.from, pair.to);
      const owner = owners.get(key);
      if (owner !== undefined) {
        // V7: one pair, one edge; two owners would make routing ambiguous.
        invalid(
          `rings.${ring.id}`,
          `steps from ${pair.from} to ${pair.to}, which ring ${owner} already derives`
        );
      }
      owners.set(key, ring.id);

      const authored = authoredByPair.get(key);
      if (authored !== undefined) {
        notes.push(
          `ring ${ring.id} step ${pair.from} to ${pair.to} is shadowed by authored edge ${authored.id}`
        );
        continue;
      }
      derived.push(deriveStep(ring, pair, portsByState));
    }
  }

  reconcileReversibleOverrides(input.rings, derived);
  for (const edge of input.edges) {
    validateAuthoredTurnEdge(edge, ringsById, owners);
  }

  return Object.freeze({
    edges: Object.freeze(sortEdgesById([...input.edges, ...derived])),
    notes: Object.freeze(notes)
  });
}

/** V1, V2, V3: the ring's own members must be usable before anything derives. */
function validateRingMembers(ring: SourceRing, stateIds: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const state of ring.states) {
    if (seen.has(state)) {
      invalid(`rings.${ring.id}`, `duplicates state ${state}`);
    }
    seen.add(state);
    if (!stateIds.has(state)) {
      invalid(`rings.${ring.id}`, `references unknown state ${state}`);
    }
  }
  if (ring.states.length < 2) {
    invalid(
      `rings.${ring.id}`,
      `must contain at least 2 states, not ${String(ring.states.length)}`
    );
  }
  if (ring.cyclic && ring.states.length < 3) {
    invalid(
      `rings.${ring.id}`,
      `is cyclic and must contain at least 3 states, not ${String(ring.states.length)}`
    );
  }
  if (ring.maxChainedSteps > ring.states.length) {
    invalid(
      `rings.${ring.id}`,
      `maxChainedSteps ${String(ring.maxChainedSteps)} exceeds its ${String(ring.states.length)} states`
    );
  }
}

/** V5: an override only means something on a pair the ring actually steps. */
function validateOverrides(
  ring: SourceRing,
  pairs: ReadonlySet<string>
): void {
  for (const override of ring.overrides) {
    if (!pairs.has(pairKey(override.from, override.to))) {
      invalid(
        `rings.${ring.id}`,
        `override ${override.from} to ${override.to} is not an adjacent step`
      );
    }
  }
}

/** V4: ring-level unit mode needs a unit for every single step. */
function validateUnitMode(
  ring: SourceRing,
  pairs: readonly StepPair[]
): void {
  if (ring.turn.mode !== "unit") return;
  const supplied = new Map(
    ring.overrides
      .filter((override) => override.mode === "unit")
      .map((override) => [pairKey(override.from, override.to), override])
  );
  const missing = pairs.filter(
    ({ from, to }) => !supplied.has(pairKey(from, to))
  );
  if (missing.length > 0) {
    const first = missing[0]!;
    invalid(
      `rings.${ring.id}`,
      `turn mode unit needs a per-step unit override; ${String(missing.length)} step(s) have none, starting at ${first.from} to ${first.to}`
    );
  }
}

/** V6: an authored turn edge must name a real ring adjacency. */
function validateAuthoredTurnEdge(
  edge: SourceEdge,
  ringsById: ReadonlyMap<string, SourceRing>,
  owners: ReadonlyMap<string, string>
): void {
  if (edge.kind === undefined && edge.ring === undefined) return;
  const ring = edge.ring === undefined ? undefined : ringsById.get(edge.ring);
  if (ring === undefined) {
    invalid(
      `edges.${edge.id}`,
      `references unknown ring ${String(edge.ring)}`
    );
  }
  const owner = owners.get(pairKey(edge.from, edge.to));
  if (owner !== ring.id) {
    invalid(
      `edges.${edge.id}`,
      `is not an adjacent step of ring ${ring.id} from ${edge.from} to ${edge.to}`
    );
  }
}

/** Every ordered adjacency of a ring: forward around first, then backward. */
function neighbourPairs(ring: SourceRing): readonly StepPair[] {
  const forward: StepPair[] = [];
  const backward: StepPair[] = [];
  const length = ring.states.length;
  const adjacencies = ring.cyclic ? length : length - 1;
  for (let index = 0; index < adjacencies; index += 1) {
    const from = ring.states[index]!;
    const to = ring.states[(index + 1) % length]!;
    forward.push({ from, to, step: 1 });
    backward.push({ from: to, to: from, step: -1 });
  }
  return Object.freeze([...forward, ...backward]);
}

function deriveStep(
  ring: SourceRing,
  pair: StepPair,
  portsByState: ReadonlyMap<string, ReadonlySet<string>>
): SourceEdge {
  const override = ring.overrides.find(
    (candidate) => candidate.from === pair.from && candidate.to === pair.to
  );
  const mode = override?.mode ?? ring.turn.mode;
  const start = ring.turn.start;
  validatePorts(ring, pair, start, portsByState);

  const base = {
    id: stepEdgeId(ring, pair),
    from: pair.from,
    to: pair.to,
    kind: "turn" as const,
    ring: ring.id,
    step: pair.step,
    derived: true as const,
    start,
    continuity: override?.continuity ?? ring.turn.continuity
  };
  if (mode === "cut") return Object.freeze(base);
  return Object.freeze({
    ...base,
    transition: unitTransition(ring, pair, override!)
  });
}

function unitTransition(
  ring: SourceRing,
  pair: StepPair,
  override: SourceRingOverride
): SourceTransition {
  const unit = override.unit;
  if (unit === undefined) {
    invalid(
      `rings.${ring.id}`,
      `step ${pair.from} to ${pair.to} uses mode unit without a unit`
    );
  }
  if (override.direction === undefined) {
    return Object.freeze({ kind: "locked", unit });
  }
  return Object.freeze({
    kind: "reversible",
    unit,
    direction: override.direction
  });
}

/**
 * Complete the reversible step pairs an override asked for.
 *
 * A reversible unit is shared by exactly two inverse edges, one of which points
 * at the other, so the pairing can only be resolved once both steps exist.
 */
function reconcileReversibleOverrides(
  rings: readonly SourceRing[],
  derived: SourceEdge[]
): void {
  const byId = new Map(derived.map((edge, index) => [edge.id, index]));
  for (const ring of rings) {
    for (const override of ring.overrides) {
      if (override.direction !== "reverse") continue;
      const forward = ring.overrides.find(
        (candidate) =>
          candidate.from === override.to &&
          candidate.to === override.from &&
          candidate.direction === "forward"
      );
      if (forward === undefined || forward.unit !== override.unit) {
        invalid(
          `rings.${ring.id}`,
          `reversible step ${override.from} to ${override.to} needs a forward override sharing unit ${String(override.unit)}`
        );
      }
      const reverseIndex = byId.get(
        stepEdgeId(ring, { from: override.from, to: override.to })
      );
      const forwardId = stepEdgeId(ring, {
        from: forward.from,
        to: forward.to
      });
      if (reverseIndex === undefined || !byId.has(forwardId)) {
        invalid(
          `rings.${ring.id}`,
          `reversible step ${override.from} to ${override.to} is shadowed on only one side`
        );
      }
      const edge = derived[reverseIndex]!;
      derived[reverseIndex] = Object.freeze({
        ...edge,
        continuity: "exact-reverse",
        transition: Object.freeze({
          kind: "reversible",
          unit: override.unit!,
          direction: "reverse",
          reverseOf: forwardId
        })
      }) as SourceEdge;
    }
  }
}

/** V8: a step can only depart and land through ports both bodies declare. */
function validatePorts(
  ring: SourceRing,
  pair: StepPair,
  start: SourceRing["turn"]["start"],
  portsByState: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const target = portsByState.get(pair.to);
  if (target?.has(start.targetPort) !== true) {
    invalid(
      `rings.${ring.id}`,
      `step ${pair.from} to ${pair.to} needs port ${start.targetPort} on ${pair.to}`
    );
  }
  if (start.type !== "portal") return;
  const source = portsByState.get(pair.from);
  if (source?.has(start.sourcePort) !== true) {
    invalid(
      `rings.${ring.id}`,
      `step ${pair.from} to ${pair.to} needs port ${start.sourcePort} on ${pair.from}`
    );
  }
}

/**
 * The id of a derived step: `<ring>.<from>.<to>`, with the prefix every ring
 * member shares removed so `facing.walk` over `walk_n`/`walk_ne` reads
 * `facing.walk.n.ne` instead of repeating the axis in all three positions.
 */
export function stepEdgeId(
  ring: SourceRing,
  pair: Readonly<{ from: string; to: string }>
): string {
  const prefix = sharedMemberPrefix(ring.states);
  const from = pair.from.slice(prefix.length);
  const to = pair.to.slice(prefix.length);
  const id = `${ring.id}.${from === "" ? pair.from : from}.${to === "" ? pair.to : to}`;
  return identifier(id, `rings.${ring.id}.steps`);
}

/**
 * The longest prefix shared by every member, cut back to a separator so a
 * remainder never begins mid-word. Returns "" when nothing is shared.
 */
function sharedMemberPrefix(states: readonly string[]): string {
  const first = states[0] ?? "";
  let length = first.length;
  for (const state of states) {
    let index = 0;
    while (index < length && index < state.length && state[index] === first[index]) {
      index += 1;
    }
    length = index;
  }
  const candidate = first.slice(0, length);
  const boundary = Math.max(
    candidate.lastIndexOf("_"),
    candidate.lastIndexOf("."),
    candidate.lastIndexOf("-")
  );
  if (boundary < 0) return "";
  const prefix = candidate.slice(0, boundary + 1);
  return states.every((state) => state.length > prefix.length) ? prefix : "";
}

function indexPortsByState(
  states: readonly SourceState[],
  units: readonly SourceUnit[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const portsByState = new Map<string, ReadonlySet<string>>();
  for (const state of states) {
    const unit = unitsById.get(state.bodyUnit);
    portsByState.set(
      state.id,
      new Set(unit?.kind === "body" ? unit.ports.map(({ id }) => id) : [])
    );
  }
  return portsByState;
}

function sortEdgesById(edges: readonly SourceEdge[]): SourceEdge[] {
  return [...edges].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
}

function pairKey(from: string, to: string): string {
  return `${from} ${to}`;
}
