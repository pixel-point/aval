import type { SourceProject, SourceUnit } from "../model.js";
import { CompilerError } from "../diagnostics.js";
import {
  type PreparedProjectSource,
  resolvePreparedFrameRange
} from "./project-source.js";
import { readCanonicalRgbaRange } from "./rgba-spool.js";
import { analyzeSeam } from "./seam-analysis.js";

export interface ProjectContinuityResult {
  readonly reports: readonly ContinuityReport[];
  readonly warnings: readonly string[];
}

export interface ContinuityReport {
  readonly name: string;
  readonly kind: "loop" | "intro" | "departure" | "arrival" | "cut";
  readonly status: "pass" | "review" | "cut";
  readonly from: {
    readonly unit: string;
    readonly frame: number | null;
    readonly direction: "forward" | "reverse" | "runtime";
  };
  readonly to: {
    readonly unit: string;
    readonly frame: number;
    readonly direction: "forward" | "reverse";
  };
  readonly metrics: {
    readonly boundaryRms: number;
    readonly alphaBoundaryRms: number;
    readonly neighborP95: number;
    readonly alphaNeighborP95: number;
    readonly identicalBoundary: boolean;
    readonly repeatedEndpointPause: boolean;
  } | null;
}

interface FramePoint {
  readonly unit: SourceUnit;
  readonly frame: number;
  readonly direction: "forward" | "reverse";
}

type ProjectMediaDefinition = Pick<
  SourceProject,
  "canvas" | "units" | "initialState" | "states" | "edges"
>;

export async function validateProjectMedia(input: {
  readonly project: ProjectMediaDefinition;
  readonly sources: ReadonlyMap<string, Readonly<PreparedProjectSource>>;
  readonly signal?: AbortSignal;
}): Promise<Readonly<ProjectContinuityResult>> {
  validateRanges(input.project, input.sources);
  const units = new Map(input.project.units.map((unit) => [unit.id, unit]));
  const states = new Map(input.project.states.map((state) => [state.id, state]));

  const boundaries: {
    readonly name: string;
    readonly kind: Exclude<ContinuityReport["kind"], "cut">;
    readonly from: FramePoint;
    readonly to: FramePoint;
  }[] = [];
  const reports: ContinuityReport[] = [];
  const warnings: string[] = [];
  for (const unit of input.project.units) {
    if (unit.kind === "body" && unit.playback === "loop") {
      boundaries.push({
        name: `${unit.id} loop`,
        kind: "loop",
        from: { unit, frame: unit.range[1] - 1, direction: "forward" },
        to: { unit, frame: unit.range[0], direction: "forward" }
      });
    }
  }
  const initialState = states.get(input.project.initialState)!;
  if (initialState.initialUnit !== undefined) {
    const intro = requiredUnit(units, initialState.initialUnit, "one-shot");
    const body = requiredUnit(units, initialState.bodyUnit, "body");
    boundaries.push({
      name: `${intro.id} intro`,
      kind: "intro",
      from: {
        unit: intro,
        frame: intro.range[1] - 1,
        direction: "forward"
      },
      to: { unit: body, frame: body.range[0], direction: "forward" }
    });
  }
  for (const edge of input.project.edges) {
    const sourceState = states.get(edge.from);
    const targetState = states.get(edge.to);
    if (sourceState === undefined || targetState === undefined) continue;
    const sourceBody = requiredUnit(units, sourceState.bodyUnit, "body");
    const targetBody = requiredUnit(units, targetState.bodyUnit, "body");
    if (edge.start.type === "cut") {
      reports.push(Object.freeze({
        name: `${edge.id} cut`,
        kind: "cut",
        status: "cut",
        from: Object.freeze({
          unit: sourceBody.id,
          frame: null,
          direction: "runtime"
        }),
        to: Object.freeze({
          unit: targetBody.id,
          frame: targetBody.range[0],
          direction: "forward"
        }),
        metrics: null
      }));
      continue;
    }
    const departures = edge.start.type === "finish"
      ? [sourceBody.range[1] - 1]
      : portalDepartures(sourceBody, edge.start.sourcePort);
    const transition = edge.transition === undefined
      ? undefined
      : requiredUnit(units, edge.transition.unit);
    const transitionStart = transition === undefined
      ? undefined
      : transitionPoint(transition, edge.transition?.kind === "reversible"
        ? edge.transition.direction
        : "forward", true);
    const transitionEnd = transition === undefined
      ? undefined
      : transitionPoint(transition, edge.transition?.kind === "reversible"
        ? edge.transition.direction
        : "forward", false);
    for (const departure of departures) {
      boundaries.push({
        name: `${edge.id} departure`,
        kind: "departure",
        from: { unit: sourceBody, frame: departure, direction: "forward" },
        to: transitionStart ?? {
          unit: targetBody,
          frame: targetBody.range[0],
          direction: "forward"
        }
      });
    }
    if (transitionEnd !== undefined) {
      boundaries.push({
        name: `${edge.id} arrival`,
        kind: "arrival",
        from: transitionEnd,
        to: {
          unit: targetBody,
          frame: targetBody.range[0],
          direction: "forward"
        }
      });
    }
  }

  for (const boundary of boundaries) {
    const result = await analyzeBoundary(
      boundary.from,
      boundary.to,
      input.project,
      input.sources,
      input.signal
    );
    const needsReview = result.repeatedEndpointPause || !result.passes;
    reports.push(Object.freeze({
      name: boundary.name,
      kind: boundary.kind,
      status: needsReview ? "review" : "pass",
      from: Object.freeze({
        unit: boundary.from.unit.id,
        frame: boundary.from.frame,
        direction: boundary.from.direction
      }),
      to: Object.freeze({
        unit: boundary.to.unit.id,
        frame: boundary.to.frame,
        direction: boundary.to.direction
      }),
      metrics: Object.freeze({
        boundaryRms: result.boundaryRms,
        alphaBoundaryRms: result.alphaBoundaryRms,
        neighborP95: result.neighborP95,
        alphaNeighborP95: result.alphaNeighborP95,
        identicalBoundary: result.identicalBoundary,
        repeatedEndpointPause: result.repeatedEndpointPause
      })
    }));
    if (needsReview) warnings.push(continuityReviewWarning(boundary, result));
  }
  return Object.freeze({
    reports: Object.freeze(reports),
    warnings: Object.freeze(warnings)
  });
}

function continuityReviewWarning(
  boundary: Readonly<{
    name: string;
    from: FramePoint;
    to: FramePoint;
  }>,
  result: Readonly<{
    boundaryRms: number;
    alphaBoundaryRms: number;
    neighborP95: number;
    alphaNeighborP95: number;
    repeatedEndpointPause: boolean;
  }>
): string {
  const frames = `${boundary.from.unit.id}:${String(boundary.from.frame)} → ` +
    `${boundary.to.unit.id}:${String(boundary.to.frame)}`;
  if (result.repeatedEndpointPause) {
    return `${boundary.name} needs visual review: ${frames} repeats an endpoint ` +
      "amid surrounding motion; source pixels were preserved";
  }
  return `${boundary.name} needs visual review: ${frames}, RGB RMS ` +
    `${result.boundaryRms.toFixed(9)} vs neighboring ${result.neighborP95.toFixed(9)}, ` +
    `alpha RMS ${result.alphaBoundaryRms.toFixed(9)} vs neighboring ` +
    `${result.alphaNeighborP95.toFixed(9)}; source pixels were preserved`;
}

function validateRanges(
  project: ProjectMediaDefinition,
  sources: ReadonlyMap<string, Readonly<PreparedProjectSource>>
): void {
  for (const unit of project.units) {
    const source = requiredSource(sources, unit.source);
    if (unit.range[1] > source.probe.frameCount) {
      throw new CompilerError(
        "FRAME_RANGE_INVALID",
        `${unit.id} range exceeds source ${source.id}`
      );
    }
  }
}

async function analyzeBoundary(
  from: FramePoint,
  to: FramePoint,
  project: ProjectMediaDefinition,
  sources: ReadonlyMap<string, Readonly<PreparedProjectSource>>,
  signal?: AbortSignal
) {
  const fromSource = requiredSource(sources, from.unit.source);
  const toSource = requiredSource(sources, to.unit.source);
  const before = await readProjectFrames(fromSource, beforeFrames(from), signal);
  const after = await readProjectFrames(toSource, afterFrames(to), signal);
  return analyzeSeam({
    width: project.canvas.width,
    height: project.canvas.height,
    frames: Object.freeze([...before, ...after]),
    boundaryAfter: before.length - 1
  });
}

function portalDepartures(
  unit: Extract<SourceUnit, { readonly kind: "body" }>,
  portId: string
): number[] {
  const port = unit.ports.find(({ id }) => id === portId);
  if (port === undefined) {
    throw new CompilerError(
      "INPUT_INVALID",
      `Port ${portId} does not exist on ${unit.id}`
    );
  }
  return port.portalFrames.map((frame) => unit.range[0] + frame);
}

function transitionPoint(
  unit: SourceUnit,
  direction: "forward" | "reverse",
  first: boolean
): FramePoint {
  const forwardStart = unit.range[0];
  const forwardEnd = unit.range[1] - 1;
  const frame = direction === "forward"
    ? (first ? forwardStart : forwardEnd)
    : (first ? forwardEnd : forwardStart);
  return { unit, frame, direction };
}

function beforeFrames(point: FramePoint): number[] {
  const step = point.direction === "forward" ? 1 : -1;
  const frames: number[] = [];
  for (let offset = 4; offset >= 0; offset -= 1) {
    const frame = point.frame - step * offset;
    if (frame >= point.unit.range[0] && frame < point.unit.range[1]) {
      frames.push(frame);
    }
  }
  return frames;
}

function afterFrames(point: FramePoint): number[] {
  const step = point.direction === "forward" ? 1 : -1;
  const frames: number[] = [];
  for (let offset = 0; offset <= 4; offset += 1) {
    const frame = point.frame + step * offset;
    if (frame >= point.unit.range[0] && frame < point.unit.range[1]) {
      frames.push(frame);
    }
  }
  return frames;
}

async function readProjectFrames(
  source: Readonly<PreparedProjectSource>,
  projectFrames: readonly number[],
  signal?: AbortSignal
): Promise<readonly Uint8Array[]> {
  if (projectFrames.length < 1) {
    throw new CompilerError("IO_FAILED", "Continuity frame window is empty");
  }
  const ascending = projectFrames[0]! <= projectFrames.at(-1)!;
  const minimum = Math.min(...projectFrames);
  const maximum = Math.max(...projectFrames);
  const [startFrame, endFrame] = resolvePreparedFrameRange(
    source,
    minimum,
    maximum + 1
  );
  const frames = await readCanonicalRgbaRange({
    source: source.input,
    frameCount: source.spoolFrameCount,
    startFrame,
    endFrame,
    ...(signal === undefined ? {} : { signal })
  });
  return ascending ? frames : Object.freeze([...frames].reverse());
}

function requiredSource(
  sources: ReadonlyMap<string, Readonly<PreparedProjectSource>>,
  id: string
): Readonly<PreparedProjectSource> {
  const source = sources.get(id);
  if (source === undefined) {
    throw new CompilerError("INPUT_INVALID", `Unknown source ${id}`);
  }
  return source;
}

function requiredUnit<K extends SourceUnit["kind"]>(
  units: ReadonlyMap<string, SourceUnit>,
  id: string,
  kind: K
): Extract<SourceUnit, { readonly kind: K }>;
function requiredUnit(
  units: ReadonlyMap<string, SourceUnit>,
  id: string
): SourceUnit;
function requiredUnit(
  units: ReadonlyMap<string, SourceUnit>,
  id: string,
  kind?: SourceUnit["kind"]
): SourceUnit {
  const unit = units.get(id);
  if (unit === undefined || (kind !== undefined && unit.kind !== kind)) {
    throw new CompilerError(
      "INPUT_INVALID",
      `${id} must reference ${kind ?? "a known"} unit`
    );
  }
  return unit;
}
