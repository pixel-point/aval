import type { AvalPlaybackLifecycleCounters } from "./public-types.js";

const MAXIMUM = Number.MAX_SAFE_INTEGER;

export function saturatingIncrement(value: number): number {
  return value >= MAXIMUM ? MAXIMUM : value + 1;
}

export function emptyPlaybackLifecycleCounters(): Readonly<AvalPlaybackLifecycleCounters> {
  return freezePlaybackLifecycleCounters({
    outputsAccepted: 0,
    drawsCompleted: 0,
    logicalRunsCreated: 0,
    candidateCommits: 0,
    runsClosed: 0,
    transitionStarts: 0,
    transitionEnds: 0,
    loopCrossings: 0,
    nativeDecoderCreatesByLane: [0, 0],
    nativeDecoderClosesByLane: [0, 0]
  });
}

export function freezePlaybackLifecycleCounters(
  counters: Readonly<AvalPlaybackLifecycleCounters>
): Readonly<AvalPlaybackLifecycleCounters> {
  return Object.freeze({
    outputsAccepted: counters.outputsAccepted,
    drawsCompleted: counters.drawsCompleted,
    logicalRunsCreated: counters.logicalRunsCreated,
    candidateCommits: counters.candidateCommits,
    runsClosed: counters.runsClosed,
    transitionStarts: counters.transitionStarts,
    transitionEnds: counters.transitionEnds,
    loopCrossings: counters.loopCrossings,
    nativeDecoderCreatesByLane: Object.freeze([
      counters.nativeDecoderCreatesByLane[0],
      counters.nativeDecoderCreatesByLane[1]
    ] as [number, number]),
    nativeDecoderClosesByLane: Object.freeze([
      counters.nativeDecoderClosesByLane[0],
      counters.nativeDecoderClosesByLane[1]
    ] as [number, number])
  });
}

export function retainPlaybackLifecycleCounters(
  retained: Readonly<AvalPlaybackLifecycleCounters>,
  current: Readonly<AvalPlaybackLifecycleCounters>
): Readonly<AvalPlaybackLifecycleCounters> {
  return freezePlaybackLifecycleCounters({
    outputsAccepted: Math.max(retained.outputsAccepted, current.outputsAccepted),
    drawsCompleted: Math.max(retained.drawsCompleted, current.drawsCompleted),
    logicalRunsCreated: Math.max(
      retained.logicalRunsCreated,
      current.logicalRunsCreated
    ),
    candidateCommits: Math.max(retained.candidateCommits, current.candidateCommits),
    runsClosed: Math.max(retained.runsClosed, current.runsClosed),
    transitionStarts: Math.max(retained.transitionStarts, current.transitionStarts),
    transitionEnds: Math.max(retained.transitionEnds, current.transitionEnds),
    loopCrossings: Math.max(retained.loopCrossings, current.loopCrossings),
    nativeDecoderCreatesByLane: [
      Math.max(
        retained.nativeDecoderCreatesByLane[0],
        current.nativeDecoderCreatesByLane[0]
      ),
      Math.max(
        retained.nativeDecoderCreatesByLane[1],
        current.nativeDecoderCreatesByLane[1]
      )
    ],
    nativeDecoderClosesByLane: [
      Math.max(
        retained.nativeDecoderClosesByLane[0],
        current.nativeDecoderClosesByLane[0]
      ),
      Math.max(
        retained.nativeDecoderClosesByLane[1],
        current.nativeDecoderClosesByLane[1]
      )
    ]
  });
}
