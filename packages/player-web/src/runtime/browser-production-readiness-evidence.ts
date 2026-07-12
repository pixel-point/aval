import type { GraphEdgeDefinition } from "@rendered-motion/graph";

import { graphBodyFrameAt } from "./body-frame-semantics.js";
import type { BrowserFrameMedia } from "./browser-playback-types.js";
import type {
  BrowserRehearsalCleanup,
  BrowserRehearsalRouteRun
} from "./browser-readiness-rehearsal-driver.js";
import type {
  OpaqueCandidateReadinessSessionInput
} from "./opaque-candidate-factory.js";

export interface BrowserProductionMediaEvidence {
  readonly graphKind: BrowserFrameMedia["graphKind"];
  readonly state: string | null;
  readonly edge: string | null;
  readonly unit: string;
  readonly localFrame: number;
  readonly drawSource: BrowserFrameMedia["drawSource"];
  readonly generation: number;
  readonly intendedPresentationOrdinal: string;
}

export interface BrowserProductionRouteEvidence {
  readonly edge: string;
  readonly passed: boolean;
  readonly responseFrames: number;
  readonly transitionSequenceReady: boolean;
  readonly targetEntryReady: boolean;
  readonly generationReady: boolean;
  readonly handoffReady: boolean;
  readonly endpointReady: boolean;
  readonly media: readonly Readonly<BrowserProductionMediaEvidence>[];
}

export interface BrowserProductionPhaseEvidence {
  readonly edge: string;
  readonly pendingCancellationReady: boolean;
  readonly pendingReplacementReady: boolean;
  readonly prospectiveTargetReady: boolean;
  readonly lockedFollowOnReady: boolean;
  readonly visibleRunwayFollowOnReady: boolean;
}

export interface BrowserProductionLoopEvidence {
  readonly unit: string;
  readonly passed: boolean;
  readonly frames: readonly number[];
}

export interface BrowserProductionEndpointEvidence {
  readonly unit: string;
  readonly state: string;
  readonly port: string;
  readonly passed: boolean;
  readonly residentFrame: number | null;
  readonly streamingFrame: number | null;
  readonly generationReady: boolean;
}

export interface BrowserProductionInverseEvidence {
  readonly unit: string;
  readonly passed: boolean;
  readonly responseFrames: number;
  readonly beforeFrame: number | null;
  readonly afterFrame: number | null;
  readonly stagedEndpointPassed: boolean;
}

export interface BrowserProductionScenarioEvidence {
  readonly label: string;
  readonly elapsedMs: number;
  readonly cleanup: Readonly<BrowserRehearsalCleanup>;
}

export interface BrowserProductionReadinessReport {
  readonly passed: boolean;
  readonly ringCapacity: number;
  readonly initialRingReady: boolean;
  readonly loops: readonly Readonly<BrowserProductionLoopEvidence>[];
  readonly routes: readonly Readonly<BrowserProductionRouteEvidence>[];
  readonly phases: readonly Readonly<BrowserProductionPhaseEvidence>[];
  readonly endpoints: readonly Readonly<BrowserProductionEndpointEvidence>[];
  readonly inverses: readonly Readonly<BrowserProductionInverseEvidence>[];
  readonly cleanup: readonly Readonly<BrowserRehearsalCleanup>[];
  readonly scenarios: readonly Readonly<BrowserProductionScenarioEvidence>[];
  readonly cleanupReady: boolean;
}

export function createProductionRouteEvidence(input: {
  readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly edge: Readonly<GraphEdgeDefinition>;
  readonly run: Readonly<BrowserRehearsalRouteRun>;
}): Readonly<BrowserProductionRouteEvidence> {
  const { candidate, edge, run } = input;
  const needsHandoff = edge.start.type === "cut" ||
    edge.transition?.kind === "reversible";
  const media = Object.freeze(run.ticks.map(({ media: value }) =>
    freezeMediaEvidence(value)
  ));
  const transitionSequenceReady = verifyTransitionSequence(edge, run);
  const targetEntryReady = verifyTargetEntry(edge, run);
  const handoffReady = needsHandoff
    ? verifyTargetHandoff(candidate, edge, run)
    : run.ticks[run.targetEntryIndex]?.media.drawSource === "streaming";
  const generationReady = verifyGenerations(run, needsHandoff);
  const endpointReady = edge.transition?.kind === "reversible"
    ? run.targetResidentEntry !== null && handoffReady
    : true;
  const passed =
    transitionSequenceReady &&
    targetEntryReady &&
    generationReady &&
    handoffReady &&
    endpointReady &&
    (edge.start.type !== "cut" || run.responseFrames === 1);
  return Object.freeze({
    edge: edge.id,
    passed,
    responseFrames: run.responseFrames,
    transitionSequenceReady,
    targetEntryReady,
    generationReady,
    handoffReady,
    endpointReady,
    media
  });
}

export function createProductionEndpointEvidence(input: {
  readonly unit: string;
  readonly state: string;
  readonly port: string;
  readonly routes: readonly Readonly<BrowserProductionRouteEvidence>[];
  readonly edges: readonly Readonly<GraphEdgeDefinition>[];
}): Readonly<BrowserProductionEndpointEvidence> {
  const edge = input.edges.find((candidate) =>
    candidate.to === input.state &&
    candidate.transition?.kind === "reversible" &&
    candidate.transition.unitId === input.unit
  );
  const route = edge === undefined
    ? undefined
    : input.routes.find((candidate) => candidate.edge === edge.id);
  const resident = route?.media.find((media) =>
    media.graphKind === "body" &&
    media.state === input.state &&
    media.drawSource === "resident"
  );
  const streaming = route?.media.find((media) =>
    media.graphKind === "body" &&
    media.state === input.state &&
    media.drawSource === "streaming"
  );
  const generationReady = resident !== undefined && streaming !== undefined &&
    resident.generation === streaming.generation;
  return Object.freeze({
    unit: input.unit,
    state: input.state,
    port: input.port,
    passed: route?.endpointReady === true && generationReady,
    residentFrame: resident?.localFrame ?? null,
    streamingFrame: streaming?.localFrame ?? null,
    generationReady
  });
}

export function productionRouteEvidence(
  report: Readonly<BrowserProductionReadinessReport>,
  edge: string
): Readonly<BrowserProductionRouteEvidence> {
  const evidence = report.routes.find((candidate) => candidate.edge === edge);
  if (evidence === undefined) {
    throw new Error(`production readiness route ${edge} is absent`);
  }
  return evidence;
}

export function productionPhaseEvidence(
  report: Readonly<BrowserProductionReadinessReport>,
  edge: string
): Readonly<BrowserProductionPhaseEvidence> {
  const evidence = report.phases.find((candidate) => candidate.edge === edge);
  if (evidence === undefined) {
    throw new Error(`production readiness phase ${edge} is absent`);
  }
  return evidence;
}

export function productionLoopEvidence(
  report: Readonly<BrowserProductionReadinessReport>,
  unit: string
): Readonly<BrowserProductionLoopEvidence> {
  const evidence = report.loops.find((candidate) => candidate.unit === unit);
  if (evidence === undefined) {
    throw new Error(`production readiness loop ${unit} is absent`);
  }
  return evidence;
}

export function productionEndpointEvidence(
  report: Readonly<BrowserProductionReadinessReport>,
  unit: string,
  state: string,
  port: string
): Readonly<BrowserProductionEndpointEvidence> {
  const evidence = report.endpoints.find((candidate) =>
    candidate.unit === unit &&
    candidate.state === state &&
    candidate.port === port
  );
  if (evidence === undefined) {
    throw new Error(
      `production readiness endpoint ${unit}:${state}:${port} is absent`
    );
  }
  return evidence;
}

export function productionInverseEvidence(
  report: Readonly<BrowserProductionReadinessReport>,
  unit: string
): Readonly<BrowserProductionInverseEvidence> {
  const evidence = report.inverses.find((candidate) => candidate.unit === unit);
  if (evidence === undefined) {
    throw new Error(`production readiness inverse ${unit} is absent`);
  }
  return evidence;
}

function freezeMediaEvidence(
  media: Readonly<BrowserFrameMedia>
): Readonly<BrowserProductionMediaEvidence> {
  return Object.freeze({
    graphKind: media.graphKind,
    state: media.state,
    edge: media.edge,
    unit: media.frame.unit,
    localFrame: media.frame.localFrame,
    drawSource: media.drawSource,
    generation: media.generation,
    intendedPresentationOrdinal: String(media.intendedPresentationOrdinal)
  });
}

function verifyTransitionSequence(
  edge: Readonly<GraphEdgeDefinition>,
  run: Readonly<BrowserRehearsalRouteRun>
): boolean {
  const transition = edge.transition;
  if (transition === undefined) return true;
  const frames = run.ticks.filter(({ media }) =>
    media.edge === edge.id && media.graphKind === transition.kind
  ).map(({ media }) => media.frame.localFrame);
  const expected = transition.kind === "locked" ||
    transition.direction === "forward"
    ? Array.from({ length: transition.frameCount }, (_, index) => index)
    : Array.from(
        { length: transition.frameCount },
        (_, index) => transition.frameCount - index - 1
      );
  return frames.length === expected.length &&
    frames.every((frame, index) => frame === expected[index]);
}

function verifyTargetEntry(
  edge: Readonly<GraphEdgeDefinition>,
  run: Readonly<BrowserRehearsalRouteRun>
): boolean {
  const entry = run.ticks[run.targetEntryIndex]?.media;
  return entry?.graphKind === "body" &&
    entry.state === edge.to &&
    entry.frame.localFrame === 0;
}

function verifyTargetHandoff(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  edge: Readonly<GraphEdgeDefinition>,
  run: Readonly<BrowserRehearsalRouteRun>
): boolean {
  const resident = run.targetResidentEntry;
  const streaming = run.targetStreamingHandoff;
  if (resident === null || streaming === null) return false;
  const target = requireStateBody(input, edge.to);
  const runway = edge.start.type === "cut"
    ? requireCutRunwayFrames(input, edge.id)
    : requireEndpointRunwayFrames(input, edge);
  return resident.frame.localFrame === 0 &&
    streaming.frame.localFrame === graphBodyFrameAt(target, runway) &&
    resident.generation === streaming.generation;
}

function verifyGenerations(
  run: Readonly<BrowserRehearsalRouteRun>,
  needsHandoff: boolean
): boolean {
  if (run.ticks.some(({ media }) =>
    !Number.isSafeInteger(media.generation) || media.generation < 1
  )) return false;
  if (!needsHandoff) return true;
  return run.targetResidentEntry !== null &&
    run.targetStreamingHandoff !== null &&
    run.targetResidentEntry.generation ===
      run.targetStreamingHandoff.generation;
}

function requireCutRunwayFrames(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  edge: string
): number {
  const runway = input.interactionCache.cutRunways.find(
    (candidate) => candidate.edge === edge
  );
  if (runway === undefined) {
    throw new Error(`production readiness cut runway ${edge} is absent`);
  }
  return runway.frames.length;
}

function requireEndpointRunwayFrames(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  edge: Readonly<GraphEdgeDefinition>
): number {
  if (edge.transition?.kind !== "reversible") {
    throw new Error("production readiness endpoint edge is not reversible");
  }
  const clip = input.interactionCache.reversibleClips.find((candidate) =>
    candidate.unit === edge.transition?.unitId
  );
  const endpoint = clip === undefined
    ? undefined
    : [clip.sourceEndpoint, clip.targetEndpoint].find((candidate) =>
        candidate.state === edge.to && candidate.port === edge.start.targetPort
      );
  if (endpoint === undefined) {
    throw new Error(`production readiness endpoint runway ${edge.id} is absent`);
  }
  return endpoint.frames.length;
}

function requireStateBody(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  state: string
) {
  const value = input.context.catalog.graph.definition.states.find(
    (candidate) => candidate.id === state
  );
  if (value === undefined) {
    throw new Error(`production readiness state ${state} is absent`);
  }
  return value.body;
}
