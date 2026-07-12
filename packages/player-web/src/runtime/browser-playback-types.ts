import type {
  GraphEdgeDefinition,
  GraphPresentation,
  GraphStateDefinition
} from "@rendered-motion/graph";

import type { ManagedDecoderWorkerFrame } from "../decoder-worker/client.js";
import type { RuntimeMediaPresentation } from "./model.js";
import type { OpaqueCandidateReadinessSessionInput } from "./opaque-candidate-factory.js";
import type { RenderFrameHandle } from "./opaque-frame-renderer.js";
import type { PathScheduler } from "./path-scheduler.js";

export const BROWSER_RUNTIME_MEDIA_TIMEOUT_MS = 2_000 as const;

export type BrowserFrameMedia = Extract<
  RuntimeMediaPresentation,
  { readonly kind: "frame" }
>;

export interface BrowserNormalReady {
  readonly media: Readonly<BrowserFrameMedia>;
  readonly handle: Readonly<RenderFrameHandle>;
  readonly routeReady: boolean;
  readonly purpose: "source" | "bridge" | "target" | "intro";
  readonly schedulerReservation: boolean;
  readonly heldPresentation: boolean;
  readonly scheduler: PathScheduler | null;
}

export function requireBrowserState(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  id: string
): Readonly<GraphStateDefinition> {
  const state = input.context.catalog.graph.definition.states.find(
    (candidate) => candidate.id === id
  );
  if (state === undefined) throw new Error(`browser graph state ${id} is absent`);
  return state;
}

export function requireBrowserEdge(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  id: string
): Readonly<GraphEdgeDefinition> {
  const edge = input.context.catalog.graph.definition.edges.find(
    (candidate) => candidate.id === id
  );
  if (edge === undefined) throw new Error(`browser graph edge ${id} is absent`);
  return edge;
}

export function browserOutgoingStarts(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  state: string
) {
  return input.context.catalog.graph.definition.edges
    .filter((edge) => edge.from === state)
    .map((edge) => edge.start);
}

export function browserCompletionEdge(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  state: string
): Readonly<GraphEdgeDefinition> | null {
  return input.context.catalog.graph.definition.edges.find((edge) =>
    edge.from === state && edge.trigger?.type === "completion"
  ) ?? null;
}

export function browserMediaTag(media: Readonly<BrowserFrameMedia>): string {
  return `${media.graphKind}:${media.state ?? media.edge}:${media.frame.unit}:${String(media.frame.localFrame)}`;
}

export function browserResidentMedia(
  presentation: Extract<GraphPresentation, { readonly kind: "reversible" }>,
  frame: BrowserFrameMedia["frame"],
  generation: number,
  ordinal: bigint
): Readonly<BrowserFrameMedia> {
  return Object.freeze({
    kind: "frame",
    graphKind: "reversible",
    state: null,
    edge: presentation.edgeId,
    path: `reversible:${presentation.edgeId}`,
    frame,
    drawSource: "resident",
    generation,
    unitInstance: 0,
    decodeOrdinal: presentation.frameIndex,
    timestamp: presentation.frameIndex,
    intendedPresentationOrdinal: ordinal
  });
}

export function assertBrowserFrame(
  frame: ManagedDecoderWorkerFrame,
  sample: {
    readonly ordinal: number;
    readonly unitId: string;
    readonly unitInstance: number;
    readonly unitFrame: number;
  },
  generation: number
): void {
  if (
    frame.generation !== generation ||
    frame.ordinal !== sample.ordinal ||
    frame.unitId !== sample.unitId ||
    frame.unitInstance !== sample.unitInstance ||
    frame.unitFrame !== sample.unitFrame
  ) throw new Error("browser decoded frame identity diverged");
}

export function safeBrowserSchedulerSnapshot(
  scheduler: PathScheduler
): ReturnType<PathScheduler["snapshot"]> | null {
  try {
    return scheduler.snapshot();
  } catch {
    return null;
  }
}
