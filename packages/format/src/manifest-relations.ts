import { compareAscii, invalid, quote } from "./manifest-validation.js";
import type {
  Binding,
  Edge,
  FormatBudgets,
  Readiness,
  ProductionRendition,
  State,
  Unit
} from "./model.js";

export interface ManifestRelationInput {
  readonly initialState: string;
  readonly renditions: readonly ProductionRendition[];
  readonly units: readonly Unit[];
  readonly states: readonly State[];
  readonly edges: readonly Edge[];
  readonly bindings: readonly Binding[];
  readonly readiness: Readiness;
}

export function validateManifestRelations(input: ManifestRelationInput): void {
  const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
  const statesById = new Map(input.states.map((state) => [state.id, state]));
  const edgesById = new Map(input.edges.map((edge) => [edge.id, edge]));
  if (!statesById.has(input.initialState)) {
    invalid("initialState", "does not reference a state");
  }

  const unitUseCount = new Map(input.units.map((unit) => [unit.id, 0]));
  for (let index = 0; index < input.states.length; index += 1) {
    const state = input.states[index]!;
    const path = `states[${String(index)}]`;
    const body = unitsById.get(state.bodyUnit);
    if (body?.kind !== "body") {
      invalid(`${path}.bodyUnit`, "must reference a body unit");
    }
    incrementUse(unitUseCount, body.id);
    if (state.initialUnit !== undefined) {
      if (state.id !== input.initialState) {
        invalid(`${path}.initialUnit`, "is allowed only on the initial state");
      }
      const initial = unitsById.get(state.initialUnit);
      if (initial?.kind !== "one-shot") {
        invalid(`${path}.initialUnit`, "must reference a one-shot unit");
      }
      incrementUse(unitUseCount, initial.id);
    }
  }

  const reversibleEdges = new Map<string, { edge: Edge; index: number }[]>();
  const eventNames = new Set<string>();
  for (let index = 0; index < input.edges.length; index += 1) {
    const edge = input.edges[index]!;
    validateEdgeReferences(edge, index, statesById, unitsById, unitUseCount);
    if (edge.trigger?.type === "event") {
      eventNames.add(edge.trigger.name);
    }
    if (edge.transition?.kind === "reversible") {
      const group = reversibleEdges.get(edge.transition.unit) ?? [];
      group.push({ edge, index });
      reversibleEdges.set(edge.transition.unit, group);
    }
  }

  validateReversibleGroups(reversibleEdges, unitsById);
  validateUseCounts(input.units, unitUseCount);
  for (let index = 0; index < input.bindings.length; index += 1) {
    if (!eventNames.has(input.bindings[index]!.event)) {
      invalid(
        `bindings[${String(index)}].event`,
        "is not used by an event-triggered edge"
      );
    }
  }
  validateReadiness(
    input.readiness,
    input.initialState,
    statesById,
    edgesById,
    unitsById
  );
  validateOutputQualifications(
    input.renditions,
    unitsById,
    new Set(input.readiness.bootstrapUnits)
  );
}

function validateOutputQualifications(
  renditions: readonly ProductionRendition[],
  unitsById: ReadonlyMap<string, Unit>,
  bootstrapUnits: ReadonlySet<string>
): void {
  for (let index = 0; index < renditions.length; index += 1) {
    const rendition = renditions[index]!;
    const witness = rendition.outputQualification;
    if (witness === undefined) continue;
    const path = `renditions[${String(index)}].outputQualification`;
    const unit = unitsById.get(witness.unit);
    if (unit === undefined) {
      invalid(`${path}.unit`, "does not reference a unit");
    }
    if (!bootstrapUnits.has(unit.id)) {
      invalid(`${path}.unit`, "must reference a bootstrap unit");
    }
    if (witness.frame >= unit.frameCount) {
      invalid(`${path}.frame`, "must be a local presentation frame in the unit");
    }
    if (!unit.chunks.some((span) => span.rendition === rendition.id)) {
      invalid(`${path}.unit`, "must contain a chunk span for the rendition");
    }
  }
}

export function validateBlobCount(
  units: readonly Unit[],
  renditions: readonly ProductionRendition[],
  budgets: FormatBudgets
): void {
  rejectBlobCount(units.length * renditions.length, budgets);
}

export function validateRawBlobCount(
  units: unknown,
  renditionCount: number,
  budgets: FormatBudgets
): void {
  if (!Array.isArray(units)) {
    invalid("units", "must be an array");
  }
  rejectBlobCount(units.length * renditionCount, budgets);
}

function rejectBlobCount(count: number, budgets: FormatBudgets): void {
  if (!Number.isSafeInteger(count) || count > budgets.maxBlobRanges) {
    invalid(
      "manifest",
      `declares ${String(count)} blobs, exceeding ${String(budgets.maxBlobRanges)}`
    );
  }
}

function validateEdgeReferences(
  edge: Edge,
  index: number,
  statesById: ReadonlyMap<string, State>,
  unitsById: ReadonlyMap<string, Unit>,
  unitUseCount: Map<string, number>
): void {
  const path = `edges[${String(index)}]`;
  const source = statesById.get(edge.from);
  const target = statesById.get(edge.to);
  if (source === undefined) {
    invalid(`${path}.from`, "does not reference a state");
  }
  if (target === undefined) {
    invalid(`${path}.to`, "does not reference a state");
  }
  const sourceBody = unitsById.get(source.bodyUnit);
  const targetBody = unitsById.get(target.bodyUnit);
  if (sourceBody?.kind !== "body" || targetBody?.kind !== "body") {
    invalid(path, "state body reference is invalid");
  }
  if (!targetBody.ports.some((port) => port.id === edge.start.targetPort)) {
    invalid(`${path}.start.targetPort`, "does not reference the target body");
  }
  if (edge.start.type === "portal") {
    const sourcePortId = edge.start.sourcePort;
    const sourcePort = sourceBody.ports.find((port) => port.id === sourcePortId);
    if (sourcePort === undefined) {
      invalid(`${path}.start.sourcePort`, "does not reference the source body");
    }
    if (
      sourceBody.playback === "finite" &&
      sourcePort.portalFrames.at(-1) !== sourceBody.frameCount - 1
    ) {
      invalid(
        `${path}.start.sourcePort`,
        "finite source port must include the held final frame"
      );
    }
  } else if (edge.start.type === "finish" && sourceBody.playback === "loop") {
    invalid(`${path}.start.type`, "finish cannot originate from a looping body");
  }

  if (edge.transition?.kind === "locked") {
    const unit = unitsById.get(edge.transition.unit);
    if (unit?.kind !== "bridge") {
      invalid(`${path}.transition.unit`, "must reference a bridge unit");
    }
    incrementUse(unitUseCount, unit.id);
    if (edge.continuity !== "exact-authored") {
      invalid(`${path}.continuity`, "locked transitions require exact-authored");
    }
  } else if (edge.transition?.kind === "reversible") {
    const unit = unitsById.get(edge.transition.unit);
    if (unit?.kind !== "reversible") {
      invalid(`${path}.transition.unit`, "must reference a reversible unit");
    }
    incrementUse(unitUseCount, unit.id);
  } else if (edge.start.type !== "cut" && edge.continuity !== "exact-authored") {
    invalid(`${path}.continuity`, "transitionless edges require exact-authored");
  }
}

function validateReversibleGroups(
  groups: ReadonlyMap<string, readonly { edge: Edge; index: number }[]>,
  unitsById: ReadonlyMap<string, Unit>
): void {
  for (const [unitId, group] of groups) {
    if (group.length !== 2) {
      invalid("edges", `reversible unit ${quote(unitId)} must have two inverse edges`);
    }
    const first = group[0]!;
    const second = group[1]!;
    const primary = [first, second].find(
      ({ edge }) =>
        edge.transition?.kind === "reversible" &&
        edge.transition.direction === "forward"
    );
    const inverse = [first, second].find(
      ({ edge }) =>
        edge.transition?.kind === "reversible" &&
        edge.transition.direction === "reverse"
    );
    if (primary === undefined || inverse === undefined) {
      invalid("edges", `reversible unit ${quote(unitId)} needs forward and reverse edges`);
    }
    const primaryTransition = primary.edge.transition;
    const inverseTransition = inverse.edge.transition;
    if (
      primaryTransition?.kind !== "reversible" ||
      inverseTransition?.kind !== "reversible"
    ) {
      invalid("edges", `reversible unit ${quote(unitId)} has invalid transitions`);
    }
    if (primaryTransition.reverseOf !== undefined) {
      invalid(
        `edges[${String(primary.index)}].transition.reverseOf`,
        "must be omitted on the primary edge"
      );
    }
    if (inverseTransition.reverseOf !== primary.edge.id) {
      invalid(
        `edges[${String(inverse.index)}].transition.reverseOf`,
        "must reference the primary edge"
      );
    }
    if (
      primary.edge.continuity !== "exact-authored" ||
      inverse.edge.continuity !== "exact-reverse"
    ) {
      invalid("edges", "reversible pair continuity is invalid");
    }
    if (
      primary.edge.from !== inverse.edge.to ||
      primary.edge.to !== inverse.edge.from
    ) {
      invalid("edges", "reversible pair must reverse its states");
    }
    const unit = unitsById.get(unitId);
    if (unit?.kind !== "reversible") {
      invalid("edges", `reversible unit ${quote(unitId)} is missing`);
    }
    validateResidencyForEdge(unit, primary.edge, primary.index);
    validateResidencyForEdge(unit, inverse.edge, inverse.index);
  }
}

function validateResidencyForEdge(
  unit: Extract<Unit, { readonly kind: "reversible" }>,
  edge: Edge,
  index: number
): void {
  const path = `edges[${String(index)}]`;
  const source = unit.residency.endpoints.find(
    (endpoint) => endpoint.state === edge.from
  );
  const target = unit.residency.endpoints.find(
    (endpoint) => endpoint.state === edge.to
  );
  if (source === undefined || target === undefined || source === target) {
    invalid(path, "must connect the reversible residency states");
  }
  if (edge.start.type === "portal" && edge.start.sourcePort !== source.port) {
    invalid(`${path}.start.sourcePort`, "must match source residency endpoint");
  }
  if (edge.start.targetPort !== target.port) {
    invalid(`${path}.start.targetPort`, "must match target residency endpoint");
  }
}

function validateUseCounts(
  units: readonly Unit[],
  counts: ReadonlyMap<string, number>
): void {
  for (const unit of units) {
    const count = counts.get(unit.id) ?? 0;
    const expected = unit.kind === "reversible" ? 2 : 1;
    if (count !== expected) {
      invalid(
        "units",
        `${unit.kind} unit ${quote(unit.id)} must be referenced exactly ${String(expected)} time${expected === 1 ? "" : "s"}`
      );
    }
  }
}

function validateReadiness(
  readiness: Readiness,
  initialStateId: string,
  statesById: ReadonlyMap<string, State>,
  edgesById: ReadonlyMap<string, Edge>,
  unitsById: ReadonlyMap<string, Unit>
): void {
  const immediate = [...edgesById.values()]
    .filter((edge) => edge.from === initialStateId)
    .map((edge) => edge.id)
    .sort(compareAscii);
  if (!sameStrings(readiness.immediateEdges, immediate)) {
    invalid(
      "readiness.immediateEdges",
      "must exactly list edges originating at initialState"
    );
  }
  const bootstrap = new Set(readiness.bootstrapUnits);
  for (let index = 0; index < readiness.bootstrapUnits.length; index += 1) {
    if (!unitsById.has(readiness.bootstrapUnits[index]!)) {
      invalid(
        `readiness.bootstrapUnits[${String(index)}]`,
        "does not reference a unit"
      );
    }
  }
  const initial = statesById.get(initialStateId)!;
  const required = new Set<string>([initial.bodyUnit]);
  if (initial.initialUnit !== undefined) {
    required.add(initial.initialUnit);
  }
  for (const edgeId of immediate) {
    const edge = edgesById.get(edgeId)!;
    required.add(statesById.get(edge.to)!.bodyUnit);
    if (edge.transition !== undefined) {
      required.add(edge.transition.unit);
    }
  }
  for (const unitId of required) {
    if (!bootstrap.has(unitId)) {
      invalid(
        "readiness.bootstrapUnits",
        `must include required unit ${quote(unitId)}`
      );
    }
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function incrementUse(counts: Map<string, number>, id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}
