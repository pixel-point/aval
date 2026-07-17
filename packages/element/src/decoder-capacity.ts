import { DECODER_RING_SIZE } from "./decoder-protocol.js";

export const ELEMENT_DECODER_LANE_IDS = Object.freeze([0, 1] as const);
const CANDIDATE_READY_FRAMES = 6 as const;

/** Canonical physical decoder capacity for one animated AVAL element. */
export const ELEMENT_DECODER_CAPACITY = Object.freeze({
  workerCount: ELEMENT_DECODER_LANE_IDS.length,
  ringSize: DECODER_RING_SIZE,
  candidateReadyFrames: CANDIDATE_READY_FRAMES,
  totalDecodedSurfaces: ELEMENT_DECODER_LANE_IDS.length * DECODER_RING_SIZE
});
