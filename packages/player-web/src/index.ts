export {
  durationForFrame,
  splitVirtualFrame,
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate,
  type VirtualFramePosition
} from "./runtime/rational-time.js";
export type {
  BindingSource,
  Binding,
  Canvas,
  CompiledManifest
} from "@pixel-point/aval-format";
export {
  IDENTIFIER_PATTERN,
  parseVideoCodecString
} from "@pixel-point/aval-format";
export {
  DECODER_WORKER_PROTOCOL_VERSION,
  DECODER_WORKER_HARD_LIMITS,
  DEFAULT_DECODER_WAIT_TIMEOUT_MS,
  type DecoderWorkerAbortGenerationCommand,
  type DecoderWorkerAckOperation,
  type DecoderWorkerAckEvent,
  type DecoderWorkerActivateGenerationCommand,
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
  type DecoderWorkerProbeConfig,
  type DecoderWorkerProbeConfigCommand,
  type DecoderWorkerProbeResultEvent,
  type DecoderWorkerReleaseFrameCommand,
  type DecoderWorkerRequestOperation,
  type DecoderWorkerSample,
  type DecoderWorkerSnapshotCommand,
  type DecoderWorkerSnapshotEvent,
  type DecoderWorkerSubmitCommand,
  type DecoderWorkerVideoConfig,
  type DecoderWorkerVideoProfile,
  type DecoderWorkerVisibleRect
} from "./decoder-worker/protocol.js";
export {
  isDecoderWorkerCommand,
  isDecoderWorkerEvent
} from "./decoder-worker/protocol-validation.js";
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
  parseExternalIntegrity,
  type NormalizedExternalIntegrity
} from "./runtime/external-integrity.js";
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
  type CertifiedVideoRendition,
  type RuntimeCatalogChunk,
  type RuntimeCatalogChunkIndex,
  type RuntimeCatalogIdIndex,
  type RuntimeCatalogPortEntry,
  type RuntimeCatalogPortIndex
} from "./runtime/asset-catalog.js";
export {
  SourceSupportProbe,
  createSourceSupportProbe,
  type SourceSupportProbeClient,
  type SourceSupportProbeCreationOptions
} from "./runtime/source-support-probe.js";
export {
  VideoSourceSelectionError,
  selectVideoSource,
  type AcceptedVideoSource,
  type VideoSourceAttemptOutcome,
  type VideoSourceDescriptor,
  type VideoSourceSelectionAttempt,
  type VideoSourceSelectionInput,
  type VideoSourceSession
} from "./runtime/video-source-selection.js";
export {
  WorkerSampleFactory,
  type CreateWorkerSampleBatchInput,
  type DecoderWorkerSampleBatch,
  type WorkerSampleResourceHost,
  type WorkerSampleTransferLease,
  type WorkerSampleCatalog,
  type WorkerSampleFactoryOptions,
  type WorkerSampleFrameRequest,
  type WorkerSampleGroupRequirement,
  type WorkerSampleOutput
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
  createCanvasRuntimeResourcePlan,
  createRuntimeResourcePlan,
  maximumActualEncodedWindowBytes,
  withRuntimeResourceRingCapacity,
  type RuntimeCanvasBackingSize,
  type RuntimeCanvasResourceAllocationSnapshot,
  type RuntimeCanvasResourceCatalogView,
  type RuntimeCanvasResourceHost,
  type RuntimeCanvasResourceLease,
  type RuntimeCanvasResourcePlan,
  type RuntimeCanvasResourcePlanInput,
  type RuntimeResourceCatalogView,
  type RuntimeResourceAllocationSnapshot,
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
  FRAME_STREAMING_SLOT_COUNT,
  FrameRenderer,
  RendererDisposedError,
  RendererFrameUnavailableError,
  RendererUnavailableError,
  RendererUploadTimeoutError,
  type BorrowedVideoFrame,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type FrameRendererBackendLimits,
  type FrameRendererOptions,
  type FrameRendererSnapshot,
  type FrameRendererState,
  type FrameRendererTimerHost,
  type FrameSourceLayout,
  type FrameTextureKind,
  type FrameTextureLayout,
  type RenderFrameHandle,
  type ResidentFrameHandle,
  type StreamingFrameHandle
} from "./runtime/frame-renderer.js";
export {
  BrowserFrameBackend,
  FRAME_FRAGMENT_SHADER_SOURCE,
  type BrowserFrameBackendOptions
} from "./runtime/frame-renderer-browser.js";
export {
  BrowserPresentationPlanes,
  type BrowserCanvasBackingResourceHost,
  type BrowserCanvasBackingResourceInput,
  type BrowserCanvasBackingResourceTransition,
  type BrowserPresentationPlanesOptions,
  type BrowserPresentationPlanesSnapshot,
  type BrowserPresentationResizeInput,
  type PresentableFrameBackend
} from "./runtime/browser-presentation-planes.js";
export {
  createBrowserVideoCandidateComposition,
  type BrowserVideoCandidateCleanupSnapshot,
  type BrowserVideoCandidateComposition,
  type BrowserVideoCandidateCompositionOptions,
  type BrowserVideoCandidateControls,
  type BrowserVideoCandidateOrderEntry,
  type BrowserVideoCandidateSnapshot,
  type BrowserVideoCandidateTestDependencies,
  type BrowserVideoPlaybackSnapshot,
  type BrowserVideoReadPixelsResult,
  type BrowserVideoReadinessSnapshot,
  type BrowserVideoRendererSnapshot,
  type BrowserVideoWorkerSnapshot
} from "./runtime/browser-video-candidate.js";
export {
  VideoCandidateFactory,
  createVideoCandidateWorkerSetup,
  type VideoCandidateActivationInput,
  type VideoCandidateCachePreparer,
  type VideoCandidateFactoryOptions,
  type VideoCandidatePreparedMedia,
  type VideoCandidateReadinessFactory,
  type VideoCandidateReadinessSession,
  type VideoCandidateReadinessSessionInput,
  type VideoCandidateRendererFactory,
  type VideoCandidateRendererReservation,
  type VideoCandidateResourceAuthority,
  type VideoCandidateResourcePlanLease,
  type VideoCandidateResourcePlanLeaseSnapshot,
  type VideoCandidateTimerHost,
  type VideoCandidateWorker,
  type VideoCandidateWorkerFactory,
  type VideoCandidateWorkerSetup
} from "./runtime/video-candidate-factory.js";
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
  BrowserContextRecovery,
  type BrowserContextRebuildInput,
  type BrowserContextRecoveryEvent,
  type BrowserContextRecoveryEventTarget,
  type BrowserContextRecoveryOptions,
  type BrowserContextRecoverySnapshot,
  type BrowserContextRecoveryState,
  type BrowserContextRetirementInput
} from "./runtime/browser-context-recovery.js";
export {
  IntegratedPlayerContext,
  type IntegratedPlayerContextOptions,
  type IntegratedPlayerContextSnapshot
} from "./runtime/integrated-player-context.js";
export {
  MOTION_POLICIES,
  MotionPolicyCoordinator,
  type ActualMotionMode,
  type EffectiveMotionMode,
  type MotionPolicy,
  type MotionPolicyCoordinatorOptions,
  type MotionPolicySnapshot,
  type MotionStaticOrigin,
  type MotionPolicyTransition,
  type MotionPolicyTransitionKind
} from "./runtime/motion-policy.js";
export {
  VisibilityPolicyCoordinator,
  type VisibilityPolicyCoordinatorOptions,
  type VisibilityPolicyTransition,
  type VisibilityPolicyTransitionKind
} from "./runtime/visibility-policy.js";
export {
  DEFAULT_MAXIMUM_DECODER_LEASES,
  DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES,
  DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES,
  createRuntimePageResourcePolicy
} from "./runtime/page-resource-policy.js";
export {
  PageResourceManager,
  type RuntimePageResourceCounterContribution,
  type RuntimePageResourceCounterContributor,
  type RuntimeParticipantRegistration,
  type RuntimeParticipantStatusUpdate
} from "./runtime/page-resource-manager.js";
export {
  PlayerResourceAccount,
  type PlayerResourceAccountSnapshot,
  type RuntimeLeasedAllocation
} from "./runtime/player-resource-account.js";
export {
  PageDecoderLeases,
  type PageDecoderLeasesSnapshot
} from "./runtime/page-decoder-leases.js";
export {
  PageReclamationCoordinator,
  type PageReclamationSnapshot,
  type RuntimeReclamationParticipant,
  type RuntimeReclamationReservationInput
} from "./runtime/page-reclamation.js";
export {
  openRuntimeAsset,
  openRuntimeAssetBytes,
  type OpenRuntimeAssetBytesOptions,
  type OpenRuntimeAssetOptions,
  type RuntimeAssetEnsureOptions,
  type RuntimeAssetSession,
  type RuntimeAssetSessionResources,
  type RuntimeAssetSessionSnapshot
} from "./runtime/runtime-asset-session.js";
export {
  createPlayerRuntimeAssetSessionResources
} from "./runtime/runtime-asset-resources.js";
export {
  createPlayerWebRuntimeResources,
  type PlayerWebRuntimeResources
} from "./runtime/player-web-runtime-resources.js";
export {
  PlayerWebPageRuntime,
  type PlayerWebOpenAssetBytesOptions,
  type PlayerWebOpenAssetOptions,
  type PlayerWebOwnedPlayer,
  type PlayerWebPageRuntimeOptions,
  type PlayerWebPageRuntimeSnapshot,
  type PlayerWebParticipantRegistration,
  type PlayerWebReclamationParticipant,
  type PlayerWebRuntimeParticipant,
  type PlayerWebRuntimeParticipantSnapshot
} from "./runtime/player-web-page-runtime.js";
export {
  RUNTIME_SESSION_CLEANUP_PHASES,
  RuntimeSessionLifecycle,
  type RuntimeSessionCleanup,
  type RuntimeSessionCleanupPhase,
  type RuntimeSessionGenerationContext,
  type RuntimeSessionLifecycleSnapshot,
  type RuntimeSessionLifecycleState,
  type RuntimeSessionPendingWait
} from "./runtime/runtime-session-lifecycle.js";
export {
  MAX_PRESENTATION_BACKING_DIMENSION,
  PRESENTATION_FIT_MODES,
  computePresentationGeometry,
  type PresentationClampReason,
  type PresentationFit,
  type PresentationGeometry,
  type PresentationGeometryInput,
  type PresentationPlaneMapping,
  type PresentationRect,
  type PresentationSize
} from "./runtime/presentation-geometry.js";
export {
  RUNTIME_READINESS_LADDER,
  RUNTIME_READINESS_LEVELS,
  RUNTIME_BLOB_RESIDENCY_STATES,
  RUNTIME_BYTE_CATEGORIES,
  RUNTIME_TRANSPORT_MODES,
  RUNTIME_TRACE_CAPACITY,
  STATIC_REASON_CLASSIFICATIONS,
  STATIC_REASONS,
  TRANSIENT_STATIC_REASONS,
  createRuntimeCandidateReport,
  createRuntimeReadinessReport,
  isTransientStaticReason,
  translateGraphReadiness,
  type GraphReadinessTranslation,
  type RuntimeAssetRequest,
  type RuntimeAssetResidencySnapshot,
  type RuntimeBlobResidencySnapshot,
  type RuntimeBlobResidencyState,
  type RuntimeByteCategory,
  type RuntimeByteLease,
  type RuntimeByteLeaseId,
  type RuntimeByteLeaseSnapshot,
  type RuntimeCandidateReport,
  type RuntimeCategoryBytesSnapshot,
  type RuntimeContextRecoveryPhase,
  type RuntimeContextRecoverySnapshot,
  type RuntimeDecoderLease,
  type RuntimeDecoderLeaseId,
  type RuntimeDecoderLeaseSnapshot,
  type RuntimeDecoderTicket,
  type RuntimeDecoderTicketId,
  type RuntimeDecoderTicketSnapshot,
  type RuntimeDecoderTicketState,
  type RuntimeFrameKey,
  type RuntimeGraphEffect,
  type RuntimeGraphTrace,
  type RuntimeMediaCursor,
  type RuntimeMediaPresentation,
  type RuntimeLoaderDiagnosticSnapshot,
  type RuntimeLoaderPhase,
  type RuntimeLoaderPolicy,
  type RuntimePageResourcePolicy,
  type RuntimePageResourcePolicyInput,
  type RuntimePageResourceSnapshot,
  type RuntimeParticipantId,
  type RuntimeParticipantPhase,
  type RuntimeParticipantState,
  type RuntimeParticipantVisibility,
  type RuntimeReadiness,
  type RuntimeReadinessReport,
  type RuntimeReadinessResult,
  type RuntimeReclamationReason,
  type RuntimeReclamationRequest,
  type RuntimeReclamationResult,
  type RuntimeReclamationToken,
  type RuntimeResourceDiagnosticSnapshot,
  type RuntimeSchedulerSnapshot,
  type RuntimeTraceCounters,
  type RuntimeTraceRecord,
  type RuntimeTransportMode,
  type RuntimeSuspensionState,
  type RuntimeVisibilitySnapshot,
  type RuntimeVisibilityState,
  type StaticReason,
  type StaticReasonClassification
} from "./runtime/model.js";
export {
  IntegratedPlayer,
  IntegratedPlaybackInvariantError,
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
  type IntegratedTimerHost
} from "./runtime/integrated-player.js";
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
