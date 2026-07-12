export {
  durationForFrame,
  splitVirtualFrame,
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate,
  type VirtualFramePosition
} from "./runtime/rational-time.js";
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
export {
  DECODER_WORKER_PROTOCOL_VERSION,
  DECODER_WORKER_HARD_LIMITS,
  DEFAULT_DECODER_WAIT_TIMEOUT_MS,
  type DecoderWorkerAbortGenerationCommand,
  type DecoderWorkerAckEvent,
  type DecoderWorkerActivateGenerationCommand,
  type DecoderWorkerAvcConfig,
  type DecoderWorkerAvcProfile,
  type DecoderWorkerClientPort,
  type DecoderWorkerColorSpaceExpectation,
  type DecoderWorkerCommand,
  type DecoderWorkerConfigureCommand,
  type DecoderWorkerDisposeCommand,
  type DecoderWorkerDisposedEvent,
  type DecoderWorkerErrorCode,
  type DecoderWorkerErrorEvent,
  type DecoderWorkerEvent,
  type DecoderWorkerFrameEvent,
  type DecoderWorkerLimits,
  type DecoderWorkerMessagePort,
  type DecoderWorkerMetrics,
  type DecoderWorkerOutputExpectation,
  type DecoderWorkerReleaseFrameCommand,
  type DecoderWorkerRequestOperation,
  type DecoderWorkerSample,
  type DecoderWorkerSnapshotCommand,
  type DecoderWorkerSnapshotEvent,
  type DecoderWorkerSubmitCommand,
  type DecoderWorkerVisibleRect
} from "./decoder-worker/protocol.js";
export {
  isDecoderWorkerCommand,
  isDecoderWorkerEvent
} from "./decoder-worker/protocol-validation.js";
export {
  type WorkerAvcInspector,
  type WorkerAvcInspectorFactory,
  type WorkerAvcSampleInspection
} from "./decoder-worker/avc-inspector-adapter.js";
export {
  DecoderWorkerCore,
  type DecoderWorkerCoreOptions,
  type DecoderWorkerEventSink,
  type WorkerEncodedVideoChunkFactory,
  type WorkerVideoDecoderAdapter,
  type WorkerVideoDecoderFactory,
  type WorkerVideoDecoderSupportProbe
} from "./decoder-worker/core.js";
export {
  DecoderWorkerHost,
  installDecoderWorker,
  type DecoderWorkerHostOptions
} from "./decoder-worker/host.js";
export {
  DecoderWorkerClient,
  DecoderWorkerGenerationAbortedError,
  DecoderWorkerRemoteError,
  DecoderWorkerTransportError,
  DecoderWorkerWatchdogError,
  type DecoderWorkerClientOptions,
  type DecoderWorkerConfigureOptions,
  type DecoderWorkerWaitOptions,
  type ManagedDecoderWorkerFrame
} from "./decoder-worker/client.js";
export {
  createDecoderWorkerClient,
  resolveDecoderWorkerEntryUrl,
  type BrowserDecoderWorkerFactory,
  type CreateDecoderWorkerClientOptions,
  type OwnedDecoderWorkerPort
} from "./decoder-worker/factory.js";
export {
  MAX_RUNTIME_DIAGNOSTIC_TEXT_LENGTH,
  MAX_RUNTIME_FAILURE_MESSAGE_LENGTH,
  RUNTIME_FAILURE_CODES,
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure,
  type RuntimeFailureCode,
  type RuntimeFailureContext
} from "./runtime/errors.js";
export {
  DecodeTimeline,
  type DecodeSampleMetadata,
  type DecodeTimelineBatchPlan,
  type DecodeTimelineFrameRequest,
  type DecodeTimelineSnapshot,
  type DecodeUnitOccurrence
} from "./runtime/decode-timeline.js";
export {
  RuntimeAssetCatalog,
  installRuntimeAssetCatalog,
  type RuntimeCatalogAccessUnit,
  type RuntimeCatalogIdIndex,
  type RuntimeCatalogPortEntry,
  type RuntimeCatalogPortIndex,
  type RuntimeCatalogRecordIndex,
  type RuntimeCatalogStaticFrame
} from "./runtime/asset-catalog.js";
export {
  createOpaqueRenditionCandidates,
  inspectOpaqueRenditionCandidate,
  type RuntimeOpaqueRendition,
  type RuntimeOpaqueRenditionCandidate,
  type RuntimeOpaqueRenditionInspection
} from "./runtime/rendition-selection.js";
export {
  WorkerSampleFactory,
  type CreateWorkerSampleBatchInput,
  type DecoderWorkerSampleBatch,
  type WorkerSampleCatalog,
  type WorkerSampleFactoryOptions,
  type WorkerSampleFrameRequest
} from "./runtime/worker-samples.js";
export {
  BYTES_PER_RGBA_PIXEL,
  GPU_OVERHEAD_DENOMINATOR,
  GPU_OVERHEAD_NUMERATOR,
  MAX_PLAYER_RUNTIME_BYTES,
  RUNTIME_MEBIBYTE,
  STREAMING_TEXTURE_LAYER_COUNT,
  checkedByteNumber,
  checkedByteProduct,
  checkedByteSum,
  checkedRgbaBytes,
  roundedGpuAllocationBytes,
  validateNonNegativeSafeInteger,
  validatePositiveSafeInteger
} from "./runtime/checked-runtime-bytes.js";
export {
  MAX_INTERACTION_CACHE_LAYERS,
  MAX_REVERSIBLE_ENDPOINT_PAIR_BYTES,
  createInteractionCachePlan,
  createInteractionCachePlanFromSemanticSequences,
  type InteractionCacheCutRunway,
  type InteractionCacheDeviceLimits,
  type InteractionCacheEndpointRunway,
  type InteractionCacheLayer,
  type InteractionCachePlan,
  type InteractionCachePlanInput,
  type InteractionCacheReversibleClip,
  type InteractionCacheSemanticInput,
  type InteractionCacheSequence,
  type SemanticCutRunwayInput,
  type SemanticEndpointRunwayInput,
  type SemanticReversibleClipInput
} from "./runtime/interaction-cache-plan.js";
export {
  MAX_RESOURCE_RING_CAPACITY,
  MIN_RESOURCE_RING_CAPACITY,
  RESOURCE_DECODE_SURFACE_COUNT,
  createRuntimeResourcePlan,
  maximumActualEncodedWindowBytes,
  type RuntimeResourceCatalogView,
  type RuntimeResourcePlan,
  type RuntimeResourcePlanInput
} from "./runtime/resource-plan.js";
export {
  DEFAULT_INTERACTION_CACHE_PREPARATION_TIMEOUT_MS,
  InteractionCachePreparationTimeoutError,
  asInteractionCachePreparationRenderer,
  asInteractionCachePreparationWorker,
  prepareInteractionCache,
  type InteractionCachePreparationInput,
  type InteractionCachePreparationRenderer,
  type InteractionCachePreparationReport,
  type InteractionCachePreparationUnitCatalog,
  type InteractionCachePreparationWorker,
  type PrepareInteractionCacheOptions
} from "./runtime/interaction-cache-preparation.js";
export {
  OPAQUE_STREAMING_SLOT_COUNT,
  OpaqueFrameRenderer,
  RendererUploadTimeoutError,
  type OpaqueFrameRendererBackend,
  type OpaqueFrameRendererBackendLimits,
  type OpaqueFrameRendererOptions,
  type OpaqueFrameRendererSnapshot,
  type OpaqueFrameRendererTimerHost,
  type OpaqueFrameTextureLayout,
  type OpaqueTextureKind
} from "./runtime/opaque-frame-renderer.js";
export {
  BrowserOpaqueFrameBackend,
  type BrowserOpaqueFrameBackendOptions
} from "./runtime/opaque-frame-renderer-browser.js";
export {
  BrowserStaticCanvasPlane,
  BrowserStaticSurfaceDecoder,
  StaticSurfaceDecodeTimeoutError,
  StaticSurfaceStore,
  StaticSurfaceStoreDisposedError,
  StaticSurfaceUnavailableError,
  asStaticSurfaceCatalog,
  type BrowserDecodedStaticSurface,
  type BrowserStaticSurfaceDecoderOptions,
  type BrowserStaticSurfaceTimerHost,
  type DecodedStaticSurface,
  type StaticPresentationPlane,
  type StaticSurfaceCatalogView,
  type StaticSurfaceDecodeOptions,
  type StaticSurfaceDecoder,
  type StaticSurfacePresentationReport,
  type StaticSurfaceStoreSnapshot,
  type StaticSurfaceValidationReport
} from "./runtime/static-surfaces.js";
export {
  createBrowserOpaqueCandidateComposition,
  type BrowserOpaqueCandidateComposition,
  type BrowserOpaqueCandidateCompositionOptions,
  type BrowserOpaqueCandidateControls,
  type BrowserOpaqueCandidateSnapshot,
  type BrowserOpaqueCleanupSnapshot,
  type BrowserOpaquePlaybackSnapshot,
  type BrowserOpaqueReadPixelsResult,
  type BrowserOpaqueReadinessSnapshot,
  type BrowserOpaqueRendererSnapshot,
  type BrowserOpaqueWorkerSnapshot
} from "./runtime/browser-opaque-candidate.js";
export {
  MAX_PRESENTATION_RING_CAPACITY,
  MIN_PRESENTATION_RING_CAPACITY,
  PresentationRing,
  validatePresentationRingCapacity,
  type PresentationRingEnqueueResult,
  type PresentationRingEntry,
  type PresentationRingExpectedFrame,
  type PresentationRingInsertion,
  type PresentationRingOptions,
  type PresentationRingSnapshot,
  type PresentationRingSnapshotEntry,
  type PresentationRingTakeResult
} from "./runtime/presentation-ring.js";
export {
  calculateRequiredEdgeLeadFrames,
  planEdgeLead,
  type EdgeLeadInput,
  type EdgeLeadPlan,
  type RequiredEdgeLeadInput
} from "./runtime/edge-lead.js";
export {
  planSubmissionHorizon,
  planUnresolvedSubmissionHorizon,
  type SourceBodyCursor,
  type SourceBoundary,
  type SubmissionHorizonDecision,
  type SubmissionHorizonInput,
  type UnresolvedSubmissionHorizon,
  type UnresolvedSubmissionHorizonInput
} from "./runtime/submission-horizon.js";
export {
  PathScheduler,
  type PathSchedulerClock,
  type PathSchedulerFramePurpose,
  type PathSchedulerOptions,
  type PathSchedulerPumpOptions,
  type PathSchedulerPumpReport,
  type PathSchedulerResidentFrame,
  type PathSchedulerSnapshot,
  type PathSchedulerStatus,
  type PathSchedulerTakeResult,
  type PathSchedulerTraceRecord,
  type PathSchedulerWorkerAdapter,
  type PrepareScheduledRouteInput,
  type StartResidentRunwayInput,
  type StartScheduledBodyInput
} from "./runtime/path-scheduler.js";
export {
  MAX_READINESS_RING_CAPACITY,
  MIN_READINESS_MEASURED_OUTPUTS,
  MIN_READINESS_RING_CAPACITY,
  MIN_READINESS_THROUGHPUT_MULTIPLE,
  READINESS_RECOVERY_MARGIN_FRAMES,
  ReadinessMetricsRecorder,
  calculateReadinessMetrics,
  idealReadinessDeadlineMs,
  nearestRankPercentile,
  type ReadinessFrameMeasurement,
  type ReadinessFrameMetric,
  type ReadinessMediaIdentity,
  type ReadinessMetricFailureReason,
  type ReadinessMetricsInput,
  type ReadinessMetricsRecorderOptions,
  type ReadinessMetricsReport,
  type ReadinessRecorderSubmission
} from "./runtime/readiness-metrics.js";
export {
  evaluateAllRoutesReadiness,
  type AllRoutesReadinessEvidence,
  type AllRoutesReadinessInput,
  type AllRoutesReadinessReport,
  type CutReadinessEvidence,
  type EdgeDryRunEvidence,
  type EndpointRecoveryEvidence,
  type InitialRingReadinessEvidence,
  type InverseReadinessEvidence,
  type LoopReadinessEvidence,
  type ReadinessEdgeReport,
  type ReadinessEvaluationFailure,
  type ReadinessEvaluationFailureCode,
  type ReadinessSourceFrameReport,
  type ResourceReadinessEvidence,
  type RoutePhaseEvidence
} from "./runtime/readiness-evaluator.js";
export {
  runAllRoutesReadiness,
  type CutAdapterResult,
  type EdgeAdapterInput,
  type EdgeDryRunAdapterResult,
  type EndpointAdapterInput,
  type EndpointAdapterResult,
  type InitialRingAdapterInput,
  type InverseAdapterInput,
  type InverseAdapterResult,
  type LoopAdapterInput,
  type LoopAdapterResult,
  type ReadinessRunnerAdapters,
  type ReadinessRunnerInput,
  type ReadinessRunnerResult,
  type ResourceAdapterInput,
  type RoutePhaseAdapterResult,
  type WarmupAdapterInput,
  type WarmupAdapterResult
} from "./runtime/readiness-runner.js";
export {
  GraphRequestSettlementError,
  RequestPromiseInvariantError,
  RequestPromises,
  type RequestPromisesOptions,
  type RequestSettlementEffect
} from "./runtime/request-promises.js";
export {
  EffectHost,
  EffectHostInvariantError,
  type EffectHostDraw,
  type EffectHostEvent,
  type EffectHostOptions,
  type EffectHostReadinessEvent,
  type EffectHostSnapshot,
  type EffectHostTraceRecord
} from "./runtime/effect-host.js";
export {
  RealtimeDriver,
  RealtimeDriverDisposedError,
  type RealtimeContentTickContext,
  type RealtimeContentTickResult,
  type RealtimeDriverOptions,
  type RealtimeDriverSnapshot,
  type RealtimeTickOutcome,
  type RealtimeUnderflowEvent
} from "./runtime/realtime-driver.js";
export {
  RUNTIME_READINESS_LADDER,
  RUNTIME_READINESS_LEVELS,
  RUNTIME_TRACE_CAPACITY,
  STATIC_REASONS,
  createRuntimeCandidateReport,
  createRuntimeReadinessReport,
  summarizeStaticReason,
  translateGraphReadiness,
  type GraphReadinessTranslation,
  type RuntimeCandidateReport,
  type RuntimeFrameKey,
  type RuntimeGraphTrace,
  type RuntimeMediaCursor,
  type RuntimeMediaPresentation,
  type RuntimeReadiness,
  type RuntimeReadinessReport,
  type RuntimeReadinessResult,
  type RuntimeSchedulerSnapshot,
  type RuntimeTraceCounters,
  type RuntimeTraceRecord,
  type StaticReason,
  type StaticReasonSummaryInput
} from "./runtime/model.js";
export {
  IntegratedPlayer,
  IntegratedPlaybackInvariantError,
  PlaybackFallbackError,
  type IntegratedCandidateActivationOptions,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedCandidateAvailability,
  type IntegratedCandidateFactory,
  type IntegratedCandidatePrepareOptions,
  type IntegratedContentTickContext,
  type IntegratedContentTickResult,
  type IntegratedPlaybackSession,
  type IntegratedPlaybackTickContext,
  type IntegratedPlaybackTraceState,
  type IntegratedPlayerOptions,
  type IntegratedPlayerSnapshot,
  type IntegratedPlayerTrace,
  type IntegratedRealtimeDriverOptions,
  type IntegratedPreparedActivation,
  type IntegratedPreparedContentTick,
  type IntegratedPrepareOptions,
  type IntegratedPrepareResult,
  type IntegratedStaticSurfaceStore,
  type IntegratedTimerHost
} from "./runtime/integrated-player.js";
export {
  OpaqueCandidateFactory,
  createOpaqueCandidateWorkerSetup,
  type OpaqueCandidateActivationInput,
  type OpaqueCandidateCachePreparer,
  type OpaqueCandidateFactoryOptions,
  type OpaqueCandidatePreparedMedia,
  type OpaqueCandidateReadinessFactory,
  type OpaqueCandidateReadinessSession,
  type OpaqueCandidateReadinessSessionInput,
  type OpaqueCandidateRendererFactory,
  type OpaqueCandidateRendererReservation,
  type OpaqueCandidateTimerHost,
  type OpaqueCandidateWorker,
  type OpaqueCandidateWorkerFactory,
  type OpaqueCandidateWorkerSetup
} from "./runtime/opaque-candidate-factory.js";
export {
  CutPresentationCoordinator,
  CutPresentationInvariantError,
  CutPresentationSupersededError,
  type CutActivationInput,
  type CutActivationReport,
  type CutFrameMedia,
  type CutPresentationCoordinatorOptions,
  type CutPresentationRenderer,
  type CutPresentationScheduler,
  type CutPresentationSnapshot,
  type CutPresentationStatus,
  type CutResidentRunwayFrame
} from "./runtime/cut-presentation-coordinator.js";
export {
  ReversiblePresentationCoordinator,
  ReversiblePresentationInvariantError,
  type PreparedReversiblePresentation,
  type PreparedReversibleRunwayFrame,
  type ReversiblePresentationRenderer,
  type ReversiblePresentationSnapshot
} from "./runtime/reversible-presentation.js";
