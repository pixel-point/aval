import type {
  GraphEdgeDefinition,
  GraphPresentation,
  GraphStateDefinition
} from "@rendered-motion/graph";

import { graphBodyFrameAt } from "./body-frame-semantics.js";
import {
  BrowserReadinessRehearsalDriver,
  type BrowserRehearsalTick
} from "./browser-readiness-rehearsal-driver.js";
import type { BrowserProductionPhaseEvidence } from "./browser-production-readiness-evidence.js";
import type {
  OpaqueCandidateReadinessSessionInput
} from "./opaque-candidate-factory.js";

export async function measureBrowserProductionPhase(input: {
  readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly driver: BrowserReadinessRehearsalDriver;
  readonly edge: Readonly<GraphEdgeDefinition>;
}): Promise<Readonly<BrowserProductionPhaseEvidence>> {
  const { candidate, driver, edge } = input;
  await driver.reachState(edge.from, {
    leaveTargetUnsettled: edge.start.type === "cut"
  });
  if (edge.trigger?.type === "completion") {
    return measureAutomaticCompletion(driver, edge);
  }

  const before = requireBodyPresentation(driver.snapshot.presentation);
  const admitted = await admitEdgeIntent(driver, edge);
  const prospective = driver.snapshot;
  const prospectiveTargetReady = admitted.accepted === true &&
    prospective.prospectiveState === edge.to &&
    (prospective.pendingEdgeId === edge.id ||
      prospective.activeEdgeId === edge.id);
  const cancelled = await driver.request(edge.from);
  const cancellationTick = await driver.tick();
  const expected = graphBodyFrameAt(
    requireState(candidate, edge.from).body,
    before.frameIndex + 1
  );
  const pendingCancellationReady = cancelled.accepted === true &&
    cancellationTick.media.graphKind === "body" &&
    cancellationTick.media.state === edge.from &&
    cancellationTick.media.frame.localFrame === expected &&
    driver.playbackSnapshot().cut === null;

  const replacement = candidate.context.catalog.graph.definition.edges.find(
    (value) => value.from === edge.from && value.id !== edge.id
  );
  let pendingReplacementReady = true;
  if (replacement !== undefined) {
    const staged = await admitEdgeIntent(driver, edge);
    const replaced = await admitEdgeIntent(driver, replacement);
    const replacementSnapshot = driver.snapshot;
    const restored = await driver.request(edge.from);
    const replacementTick = await driver.tick();
    pendingReplacementReady =
      staged.accepted === true &&
      replaced.accepted === true &&
      restored.accepted === true &&
      replacementSnapshot.requestedState === replacement.to &&
      replacementSnapshot.prospectiveState === replacement.to &&
      driver.playbackSnapshot().cut?.edge !== edge.id &&
      !isTransitionMediaForEdge(replacementTick, edge);
  }

  const lockedFollowOnReady = await measureLockedFollowOn(
    candidate,
    driver,
    edge
  );
  const visibleRunwayFollowOnReady = await measureVisibleRunway(
    candidate,
    driver,
    edge
  );
  return Object.freeze({
    edge: edge.id,
    pendingCancellationReady,
    pendingReplacementReady,
    prospectiveTargetReady,
    lockedFollowOnReady,
    visibleRunwayFollowOnReady
  });
}

async function measureAutomaticCompletion(
  driver: BrowserReadinessRehearsalDriver,
  edge: Readonly<GraphEdgeDefinition>
): Promise<Readonly<BrowserProductionPhaseEvidence>> {
  let automaticAdmissionReady = false;
  for (let count = 0; count < driver.maxTicks; count += 1) {
    const tick = await driver.tick();
    automaticAdmissionReady ||=
      tick.result.snapshot.pendingEdgeId === edge.id ||
      tick.result.snapshot.activeEdgeId === edge.id ||
      (tick.media.graphKind === "body" && tick.media.state === edge.to);
    if (automaticAdmissionReady) break;
  }
  if (!automaticAdmissionReady) {
    throw new Error(
      `production readiness completion edge ${edge.id} exceeded its bound`
    );
  }
  // Completion routes have no user-pending intent to cancel or replace.
  return Object.freeze({
    edge: edge.id,
    pendingCancellationReady: true,
    pendingReplacementReady: true,
    prospectiveTargetReady: true,
    lockedFollowOnReady: true,
    visibleRunwayFollowOnReady: true
  });
}

async function measureLockedFollowOn(
  candidate: Readonly<OpaqueCandidateReadinessSessionInput>,
  driver: BrowserReadinessRehearsalDriver,
  edge: Readonly<GraphEdgeDefinition>
): Promise<boolean> {
  const transition = edge.transition;
  if (transition?.kind !== "locked") return true;
  const followOn = candidate.context.catalog.graph.definition.edges.find(
    (value) => value.from === edge.to
  );
  if (followOn === undefined) return true;
  if ((await admitEdgeIntent(driver, edge)).accepted !== true) return false;
  const ticks: Readonly<BrowserRehearsalTick>[] = [];
  for (let count = 0; driver.snapshot.phase !== "locked"; count += 1) {
    if (count >= driver.maxTicks) {
      throw new Error(
        `production readiness locked edge ${edge.id} exceeded its entry bound`
      );
    }
    ticks.push(await driver.tick());
  }
  if ((await admitEdgeIntent(driver, followOn)).accepted !== true) return false;
  let targetZeroSeen = false;
  let followOnSeen = false;
  for (let count = 0; count < driver.maxTicks; count += 1) {
    const tick = await driver.tick();
    ticks.push(tick);
    targetZeroSeen ||= tick.media.graphKind === "body" &&
      tick.media.state === edge.to && tick.media.frame.localFrame === 0;
    followOnSeen ||= tick.media.graphKind === "body" &&
      tick.media.state === followOn.to;
    if (followOnSeen) break;
  }
  const lockedFrames = ticks.filter(({ media }) =>
    media.graphKind === "locked" && media.edge === edge.id
  ).map(({ media }) => media.frame.localFrame);
  return targetZeroSeen && followOnSeen &&
    lockedFrames.length === transition.frameCount &&
    lockedFrames.every((frame, index) => frame === index);
}

async function measureVisibleRunway(
  candidate: Readonly<OpaqueCandidateReadinessSessionInput>,
  driver: BrowserReadinessRehearsalDriver,
  edge: Readonly<GraphEdgeDefinition>
): Promise<boolean> {
  if (edge.start.type !== "cut") return true;
  const followOn = candidate.context.catalog.graph.definition.edges.find(
    (value) => value.from === edge.to
  );
  if (followOn === undefined) return true;
  const entry = await driver.driveEdge(edge, false);
  if (entry.targetResidentEntry === null) return false;
  if ((await admitEdgeIntent(driver, followOn)).accepted !== true) return false;
  if (followOn.start.type === "cut") {
    const next = await driver.tick();
    return next.media.graphKind === "body" &&
      next.media.state === followOn.to &&
      next.media.frame.localFrame === 0 &&
      next.media.drawSource === "resident";
  }
  let streamingHandoff = false;
  let followOnSeen = false;
  for (let count = 0; count < driver.maxTicks; count += 1) {
    const tick = await driver.tick();
    if (
      tick.media.graphKind === "body" &&
      tick.media.state === edge.to &&
      tick.media.drawSource === "streaming"
    ) streamingHandoff = true;
    if (
      tick.media.graphKind === "body" &&
      tick.media.state === followOn.to
    ) {
      followOnSeen = true;
      break;
    }
  }
  return streamingHandoff && followOnSeen;
}

function isTransitionMediaForEdge(
  tick: Readonly<BrowserRehearsalTick>,
  edge: Readonly<GraphEdgeDefinition>
): boolean {
  return tick.media.edge === edge.id ||
    (tick.media.graphKind === "body" && tick.media.state === edge.to);
}

function admitEdgeIntent(
  driver: BrowserReadinessRehearsalDriver,
  edge: Readonly<GraphEdgeDefinition>
) {
  return edge.trigger?.type === "event"
    ? driver.send(edge.trigger.name)
    : driver.request(edge.to);
}

function requireState(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  state: string
): Readonly<GraphStateDefinition> {
  const value = input.context.catalog.graph.definition.states.find(
    (candidate) => candidate.id === state
  );
  if (value === undefined) {
    throw new Error(`production readiness state ${state} is absent`);
  }
  return value;
}

function requireBodyPresentation(
  presentation: Readonly<GraphPresentation> | null
): Extract<GraphPresentation, { readonly kind: "body" }> {
  if (presentation?.kind !== "body") {
    throw new Error("production readiness source is not a visible body");
  }
  return presentation;
}
