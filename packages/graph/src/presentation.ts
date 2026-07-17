import type { GraphPresentation } from "./model.js";

/** Exact equality for the graph's externally visible presentation identity. */
export function sameGraphPresentation(
  left: Readonly<GraphPresentation> | null,
  right: Readonly<GraphPresentation> | null
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "static":
      return right.kind === "static" && left.state === right.state;
    case "intro":
    case "body":
      return right.kind === left.kind && left.state === right.state &&
        left.unitId === right.unitId && left.frameIndex === right.frameIndex;
    case "locked":
      return right.kind === "locked" && left.edgeId === right.edgeId &&
        left.unitId === right.unitId && left.frameIndex === right.frameIndex;
    case "reversible":
      return right.kind === "reversible" && left.edgeId === right.edgeId &&
        left.unitId === right.unitId && left.frameIndex === right.frameIndex &&
        left.direction === right.direction;
  }
}
