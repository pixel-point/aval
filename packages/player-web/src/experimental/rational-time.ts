/** Compatibility path for M1/M2 consumers; runtime owns the implementation. */
export {
  durationForFrame,
  splitVirtualFrame,
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate,
  type VirtualFramePosition
} from "../runtime/rational-time.js";
