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
export {
  ContinuousPathDecoder,
  PathDecoderDisposedError,
  PathDecoderNotStartedError,
  PathDecoderSupersededError,
  PathDecoderWatchdogError,
  type ContinuousPathDecoderMetrics,
  type ContinuousPathDecoderOptions,
  type ContinuousPathUnit,
  type ManagedPathFrame,
  type PathFramePurpose,
  type StartPathOptions,
  type WaitForPathFramesOptions
} from "./experimental/continuous-path-decoder.js";
export {
  preflightResidentPathRecovery,
  ResidentPathRecoveryReadinessError,
  type ResidentPathRecoveryEndpoint,
  type ResidentPathRecoveryEndpointReport,
  type ResidentPathRecoveryPreflightOptions
} from "./experimental/resident-path-recovery-preflight.js";
export {
  MAX_ENDPOINT_RUNWAY_FRAMES,
  MAX_RESIDENT_FRAME_BYTES,
  MAX_RESIDENT_FRAME_LAYERS,
  MAX_REVERSIBLE_CLIP_BYTES,
  MAX_REVERSIBLE_CLIP_FRAMES,
  MAX_TRACKED_PLAYER_BYTES,
  MIN_ENDPOINT_RUNWAY_FRAMES,
  MIN_REVERSIBLE_CLIP_FRAMES,
  STREAMING_SLOT_COUNT,
  createResidentFramePlan,
  type ResidentFrameDeviceLimits,
  type ResidentFrameKey,
  type ResidentFrameLayer,
  type ResidentFramePlan,
  type ResidentFramePlanInput
} from "./experimental/resident-frame-plan.js";
export {
  asResidentUploadTarget,
  prepareResidentFrames,
  type PrepareResidentFramesOptions,
  type ResidentFramePreparationReport,
  type ResidentFrameUploadTarget,
  type ResidentPreparationUnit
} from "./experimental/resident-frame-preparation.js";
export {
  RESIDENT_REVERSAL_STRESS_CHANGES,
  runResidentReversalStress,
  type ResidentReversalDrawTarget,
  type ResidentReversalStressOptions,
  type ResidentReversalStressReport,
  type ResidentReversalValidationContext
} from "./experimental/resident-reversal-stress.js";
export {
  ReversibleClipController,
  type ReversibleClipControllerOptions,
  type ReversibleClipDirection,
  type ReversibleClipFollowOn,
  type ReversibleClipPhase,
  type ReversibleClipPresentation,
  type ReversibleClipRequest,
  type ReversibleClipRequestOutcome,
  type ReversibleClipRequestTrace,
  type ReversibleClipSnapshot,
  type ReversibleClipTickOptions,
  type ReversibleClipTraceRecord
} from "./experimental/reversible-clip-controller.js";
export {
  BrowserWebGl2FrameBackend,
  RendererDisposedError,
  RendererFrameUnavailableError,
  RendererUnavailableError,
  WebGlFrameRenderer,
  type BackendTextureKind,
  type BorrowedVideoFrame,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type FrameRendererBackendLimits,
  type FrameRendererState,
  type FrameTextureLayout,
  type RenderFrameHandle,
  type ResidentFrameHandle,
  type StreamingFrameHandle,
  type WebGlFrameRendererOptions,
  type WebGlFrameRendererSnapshot
} from "./experimental/webgl-frame-renderer.js";
export {
  ResidentReversiblePlayer,
  type ResidentRecoverySnapshot,
  type ResidentReversibleDraw,
  type ResidentReversibleEndpoint,
  type ResidentReversiblePlayerOptions,
  type ResidentReversiblePlayerSnapshot,
  type ResidentReversiblePlayerState,
  type ResidentReversiblePlayerTick,
  type ResidentReversibleVisibilitySource
} from "./experimental/resident-reversible-player.js";
