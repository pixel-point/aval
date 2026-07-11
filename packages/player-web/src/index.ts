export {
  durationForFrame,
  splitVirtualFrame,
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate,
  type VirtualFramePosition
} from "./experimental/rational-time.js";
export {
  createEncodedLoopUnit,
  validateEncodedLoopUnit,
  type EncodedLoopUnit,
  type OwnedEncodedFrame
} from "./experimental/encoded-loop.js";
export {
  ContinuousLoopDecoder,
  DecoderDisposedError,
  DecoderEndOfStreamError,
  DecoderWatchdogError,
  type ContinuousLoopDecoderMetrics,
  type ContinuousLoopDecoderOptions,
  type EncodedVideoChunkFactory,
  type ManagedDecodedFrame,
  type VideoDecoderAdapter,
  type VideoDecoderFactory,
  type WaitForFramesOptions
} from "./experimental/continuous-loop-decoder.js";
export {
  STRESS_LOOP_ITERATIONS,
  STRESS_LOOP_OUTPUT_FRAMES,
  STRESS_LOOP_SEAMS,
  runContinuousLoopStress,
  type ContinuousLoopStressOptions,
  type ContinuousLoopStressReport,
  type StressExpectedFrame,
  type StressFrameValidator,
  type StressTagReader
} from "./experimental/stress-loop.js";
export {
  LoopCanvasPlayer,
  type LoopCanvasPlayerOptions,
  type LoopCanvasPlayerSnapshot,
  type LoopCanvasPlayerState
} from "./experimental/loop-canvas-player.js";
