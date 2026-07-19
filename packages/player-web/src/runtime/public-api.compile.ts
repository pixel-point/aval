import type {
  MotionGraphReadiness,
  MotionGraphResult
} from "@pixel-point/aval-graph";
import type { ValidatedAssetLayout } from "@pixel-point/aval-format";

import {
  RUNTIME_TRACE_CAPACITY,
  VideoCandidateFactory,
  BrowserContextRecovery,
  BrowserFrameBackend,
  BrowserPresentationPlanes,
  FrameRenderer,
  IntegratedPlayer,
  IntegratedPlayerContext,
  PageDecoderLeases,
  PageReclamationCoordinator,
  PageResourceManager,
  PlayerWebPageRuntime,
  PlayerResourceAccount,
  RuntimeSessionLifecycle,
  MOTION_POLICIES,
  MotionPolicyCoordinator,
  VisibilityPolicyCoordinator,
  PRESENTATION_FIT_MODES,
  computePresentationGeometry,
  RendererUploadTimeoutError,
  RuntimeAssetCatalog,
  RuntimePlaybackError,
  createBrowserVideoCandidateComposition,
  createSourceSupportProbe,
  createPlayerRuntimeAssetSessionResources,
  createPlayerWebRuntimeResources,
  createRuntimePageResourcePolicy,
  installRuntimeAssetCatalog,
  normalizeRuntimeFailure,
  openRuntimeAsset,
  openRuntimeAssetBytes,
  parseExternalIntegrity,
  selectVideoSource,
  translateGraphReadiness,
  type DecoderWorkerMetrics,
  type DecoderWorkerSample,
  type ManagedDecoderWorkerFrame,
  type IntegratedContentTickResult,
  type IntegratedPlayerOptions,
  type IntegratedPlayerContextSnapshot,
  type IntegratedRealtimeDriverOptions,
  type OpenRuntimeAssetBytesOptions,
  type OpenRuntimeAssetOptions,
  type MotionPolicy,
  type MotionPolicySnapshot,
  type MotionStaticOrigin,
  type MotionPolicyTransition,
  type PresentationFit,
  type PresentationGeometry,
  type PresentationGeometryInput,
  type PresentableFrameBackend,
  type BrowserVideoCandidateComposition,
  type BrowserVideoCandidateCompositionOptions,
  type BrowserContextRecoverySnapshot,
  type BrowserFrameBackendOptions,
  type BrowserPresentationPlanesOptions,
  type BrowserCanvasBackingResourceHost,
  type BrowserPresentationPlanesSnapshot,
  type BrowserPresentationResizeInput,
  type FrameRendererOptions,
  type FrameRendererSnapshot,
  type FrameRendererTimerHost,
  type NormalizedExternalIntegrity,
  type PageDecoderLeasesSnapshot,
  type PageReclamationSnapshot,
  type PlayerWebRuntimeResources,
  type PlayerWebOpenAssetBytesOptions,
  type PlayerWebOpenAssetOptions,
  type PlayerWebPageRuntimeOptions,
  type PlayerWebPageRuntimeSnapshot,
  type PlayerWebParticipantRegistration,
  type PlayerWebRuntimeParticipant,
  type PlayerWebRuntimeParticipantSnapshot,
  type PlayerResourceAccountSnapshot,
  type RuntimeAssetRequest,
  type RuntimeAssetEnsureOptions,
  type RuntimeAssetResidencySnapshot,
  type RuntimeAssetSession,
  type RuntimeAssetSessionResources,
  type RuntimeAssetSessionSnapshot,
  type RuntimeByteLease,
  type RuntimeLoaderPolicy,
  type RuntimeCandidateReport,
  type RuntimeCatalogChunk,
  type RuntimeFailure,
  type RuntimeFrameKey,
  type RuntimeMediaPresentation,
  type RuntimePageResourcePolicyInput,
  type RuntimePageResourcePolicy,
  type RuntimePageResourceSnapshot,
  type RuntimeParticipantRegistration,
  type RuntimeParticipantStatusUpdate,
  type RuntimeReclamationParticipant,
  type RuntimeReclamationReservationInput,
  type RuntimeSessionCleanupPhase,
  type RuntimeSessionGenerationContext,
  type RuntimeSessionLifecycleSnapshot,
  type RuntimeSessionPendingWait,
  type RuntimeReadiness,
  type RuntimeReadinessReport,
  type RuntimeReadinessResult,
  type RuntimeSchedulerSnapshot,
  type RuntimeTraceRecord,
  type RuntimeVisibilitySnapshot,
  type RuntimeVisibilityState,
  type StaticReason,
  type AcceptedVideoSource,
  type CertifiedVideoRendition,
  type SourceSupportProbeCreationOptions,
  type VideoSourceDescriptor,
  type VideoSourceSelectionInput,
  type VideoSourceSession,
  type VisibilityPolicyTransition
} from "../index.js";

// The integrated runtime is allowed to join these three existing authorities;
// it does not publish aliases that fork any of their contracts.
export type RuntimeBoundaryAuthorities = readonly [
  MotionGraphResult,
  ValidatedAssetLayout,
  DecoderWorkerSample,
  DecoderWorkerMetrics,
  ManagedDecoderWorkerFrame
];

const readiness: RuntimeReadiness = "metadataReady";
const graphReadiness: MotionGraphReadiness = "preparing";
const translation = translateGraphReadiness(graphReadiness);
const catalogFactory: (bytes: Uint8Array) => RuntimeAssetCatalog =
  installRuntimeAssetCatalog;
const sourceSelector: typeof selectVideoSource = selectVideoSource;
const sourceProbeFactory: typeof createSourceSupportProbe =
  createSourceSupportProbe;
const catalogEntry = null as unknown as RuntimeCatalogChunk;
const videoCandidate = null as unknown as CertifiedVideoRendition;
const sourceDescriptor = null as unknown as VideoSourceDescriptor;
const sourceSession = null as unknown as VideoSourceSession;
const sourceSelectionInput = null as unknown as VideoSourceSelectionInput<
  VideoSourceDescriptor,
  VideoSourceSession
>;
const acceptedSource = null as unknown as AcceptedVideoSource<
  VideoSourceDescriptor,
  VideoSourceSession
>;
const sourceProbeOptions = null as unknown as SourceSupportProbeCreationOptions;
const frameKey: RuntimeFrameKey = {
  rendition: "video",
  unit: "idle",
  localFrame: 0
};
const candidate = null as unknown as RuntimeCandidateReport;
const report = null as unknown as RuntimeReadinessReport;
const result = null as unknown as RuntimeReadinessResult;
const presentation = null as unknown as RuntimeMediaPresentation;
const scheduler = null as unknown as RuntimeSchedulerSnapshot;
const trace = null as unknown as RuntimeTraceRecord;
const reason = null as unknown as StaticReason;
const staticReasons: readonly StaticReason[] = [
  "reduced-motion",
  "visibility-suspended",
  "decoder-queued"
];
// @ts-expect-error terminal playback failures are not static policy reasons.
const terminalFailureReason: StaticReason = "animation-failure";
const failure: RuntimeFailure = normalizeRuntimeFailure("readiness-failure");
const error: Error = new RuntimePlaybackError(failure);
const traceCapacity: 512 = RUNTIME_TRACE_CAPACITY;
const motionPolicies: readonly MotionPolicy[] = MOTION_POLICIES;
const motionCoordinatorConstructor: typeof MotionPolicyCoordinator =
  MotionPolicyCoordinator;
const motionSnapshot = null as unknown as MotionPolicySnapshot;
// @ts-expect-error terminal playback failure is not a motion-policy mode.
void motionSnapshot.stickyFailure;
const motionTransition = null as unknown as MotionPolicyTransition;
const motionStaticOrigin = null as unknown as MotionStaticOrigin;
const visibilityCoordinatorConstructor: typeof VisibilityPolicyCoordinator =
  VisibilityPolicyCoordinator;
const visibilitySnapshot = null as unknown as RuntimeVisibilitySnapshot;
const visibilityState = null as unknown as RuntimeVisibilityState;
const visibilityTransition = null as unknown as VisibilityPolicyTransition;
const presentationFits: readonly PresentationFit[] = PRESENTATION_FIT_MODES;
const presentationInput = null as unknown as PresentationGeometryInput;
const presentationGeometry: PresentationGeometry =
  computePresentationGeometry(presentationInput);
const integratedPlayerConstructor: typeof IntegratedPlayer = IntegratedPlayer;
const integratedContextConstructor: typeof IntegratedPlayerContext =
  IntegratedPlayerContext;
const integratedContextSnapshot =
  null as unknown as IntegratedPlayerContextSnapshot;
const videoFactoryConstructor: typeof VideoCandidateFactory =
  VideoCandidateFactory;
const integratedOptions = null as unknown as IntegratedPlayerOptions;
const integratedRealtimeOptions = null as unknown as IntegratedRealtimeDriverOptions;
const tickResult = null as unknown as IntegratedContentTickResult;
const browserCompositionFactory:
  typeof createBrowserVideoCandidateComposition =
    createBrowserVideoCandidateComposition;
const browserComposition = null as unknown as BrowserVideoCandidateComposition;
const browserCompositionOptions =
  null as unknown as BrowserVideoCandidateCompositionOptions;
const browserControls =
  null as unknown as BrowserVideoCandidateComposition["controls"];
const frameBackendConstructor: typeof BrowserFrameBackend = BrowserFrameBackend;
const contextRecoveryConstructor: typeof BrowserContextRecovery =
  BrowserContextRecovery;
const contextRecoverySnapshot = null as unknown as BrowserContextRecoverySnapshot;
const presentationPlanesConstructor: typeof BrowserPresentationPlanes =
  BrowserPresentationPlanes;
const frameRendererConstructor: typeof FrameRenderer = FrameRenderer;
const frameBackendOptions = null as unknown as BrowserFrameBackendOptions;
const presentationPlanesOptions =
  null as unknown as BrowserPresentationPlanesOptions;
const presentationPlanesSnapshot =
  null as unknown as BrowserPresentationPlanesSnapshot;
const presentationResizeInput =
  null as unknown as BrowserPresentationResizeInput;
const presentableBackend = null as unknown as PresentableFrameBackend;
const browserBackendOptions = null as unknown as BrowserFrameBackendOptions;
const rendererOptions = null as unknown as FrameRendererOptions;
const rendererSnapshot = null as unknown as FrameRendererSnapshot;
const frameRendererTimer = null as unknown as FrameRendererTimerHost;
const uploadTimeout: Error = new RendererUploadTimeoutError(1);

// The package-root composition surface remains sufficient without access to
// accounting bridges or manager-owned maps.
const assetOpener: typeof openRuntimeAsset = openRuntimeAsset;
const byteAssetOpener: typeof openRuntimeAssetBytes = openRuntimeAssetBytes;
const pagePolicyFactory: (
  input?: Readonly<RuntimePageResourcePolicyInput>
) => Readonly<RuntimePageResourcePolicy> = createRuntimePageResourcePolicy;
const pageManagerConstructor: new (
  policy?: Readonly<RuntimePageResourcePolicy>
) => PageResourceManager = PageResourceManager;
const playerAccountConstructor: new (
  manager: PageResourceManager,
  registration?: Readonly<RuntimeParticipantRegistration>
) => PlayerResourceAccount = PlayerResourceAccount;
const decoderLeasesConstructor: new (
  manager: PageResourceManager
) => PageDecoderLeases = PageDecoderLeases;
const reclamationConstructor: new (
  manager: PageResourceManager
) => PageReclamationCoordinator = PageReclamationCoordinator;
const lifecycleConstructor: new () => RuntimeSessionLifecycle =
  RuntimeSessionLifecycle;
const sessionResourcesFactory: (
  account: PlayerResourceAccount
) => Readonly<RuntimeAssetSessionResources> =
  createPlayerRuntimeAssetSessionResources;
const webRuntimeResourcesFactory: (
  account: PlayerResourceAccount,
  decoders: PageDecoderLeases
) => Readonly<PlayerWebRuntimeResources> = createPlayerWebRuntimeResources;
const webRuntimeResources = null as unknown as PlayerWebRuntimeResources;
const pageRuntimeConstructor: new (
  options?: Readonly<PlayerWebPageRuntimeOptions>
) => PlayerWebPageRuntime = PlayerWebPageRuntime;
const pageRuntimeSnapshot = null as unknown as PlayerWebPageRuntimeSnapshot;
const pageParticipantRegistration =
  null as unknown as PlayerWebParticipantRegistration;
const invalidPageParticipantRegistration: PlayerWebParticipantRegistration = {
  // @ts-expect-error page lifecycle owns participant generation
  generation: 2
};
void invalidPageParticipantRegistration;
const pageRuntimeParticipant = null as unknown as PlayerWebRuntimeParticipant;
const pageRuntimeParticipantSnapshot =
  null as unknown as PlayerWebRuntimeParticipantSnapshot;
const pageRuntimeOpenOptions = null as unknown as PlayerWebOpenAssetOptions;
const pageRuntimeBytesOptions =
  null as unknown as PlayerWebOpenAssetBytesOptions;
const bundledCanvasBacking: Readonly<BrowserCanvasBackingResourceHost> =
  webRuntimeResources.canvasBacking;
const bundledParticipantBinding = webRuntimeResources.participant;
const urlOpenOptions = null as unknown as OpenRuntimeAssetOptions;
const byteOpenOptions = null as unknown as OpenRuntimeAssetBytesOptions;
const ensureOptions = null as unknown as RuntimeAssetEnsureOptions;
const assetSession = null as unknown as RuntimeAssetSession;
const evictRenditionUnits: (rendition: string) => number =
  assetSession.evictRenditionUnits;
const assetSessionSnapshot = null as unknown as RuntimeAssetSessionSnapshot;
const playerAccountSnapshot = null as unknown as PlayerResourceAccountSnapshot;
const decoderSnapshot = null as unknown as PageDecoderLeasesSnapshot;
const reclamationSnapshot = null as unknown as PageReclamationSnapshot;
const participantUpdate = null as unknown as RuntimeParticipantStatusUpdate;
const reclamationParticipant = null as unknown as RuntimeReclamationParticipant;
const reclamationReservation =
  null as unknown as RuntimeReclamationReservationInput;
const lifecycleGeneration = null as unknown as RuntimeSessionGenerationContext;
const lifecycleSnapshot = null as unknown as RuntimeSessionLifecycleSnapshot;
const lifecycleWait = null as unknown as RuntimeSessionPendingWait<void>;
const lifecyclePhase: RuntimeSessionCleanupPhase = "network-digest";

const packageApi = null as unknown as typeof import("../index.js");
// @ts-expect-error async manager-lease adoption is page-composition private
void packageApi.adoptPlayerResourceLease;
// @ts-expect-error generation-bound async admission is page-composition private
void packageApi.createPlayerResourceAdmission;
// @ts-expect-error manager lease authentication remains an internal bridge
void packageApi.assertPageResourceByteLeaseOwner;
// @ts-expect-error request capture is internal to the generation wrapper
void packageApi.captureRuntimeAssetRequest;
// @ts-expect-error raw final URL/ETag transport identity stays internal
const privateEntityIdentity: import("../index.js").RuntimeEntityIdentity = {};
void privateEntityIdentity;
// @ts-expect-error participant bindings are created only by the closed bundle
void packageApi.createIntegratedPlayerParticipantBinding;
// @ts-expect-error lease reclassification is an internal ownership bridge
void packageApi.reclassifyPageResourceByteLease;
// @ts-expect-error synchronous lease shrinking is an internal ownership bridge
void packageApi.shrinkPageResourceByteLease;
// @ts-expect-error account lease shrinking is an internal ownership bridge
void packageApi.shrinkPlayerResourceLease;
// @ts-expect-error account reclassification is not a host capability
void packageApi.reclassifyPlayerResourceLease;
// @ts-expect-error raw account category observation remains internal
void packageApi.snapshotPlayerResourceCategories;
// @ts-expect-error exact reclaimable publication remains account-owned
void packageApi.setPlayerResourceLeaseReclaimable;
// @ts-expect-error reclaimable category ownership remains page-composition private
void packageApi.retainPlayerReclaimableCategories;
// @ts-expect-error automatic reclaimable publication remains account-owned
void packageApi.refreshPlayerAutomaticReclaimablePublication;
// @ts-expect-error generation retirement remains page-composition private
void packageApi.retirePlayerResourceGeneration;
// @ts-expect-error verified-blob publication marker remains store-owned
void packageApi.MARK_VERIFIED_BLOB_RECLAIMABLE;
// @ts-expect-error complete-source borrowed promotion remains store-owned
void packageApi.PROMOTE_BORROWED_VERIFIED_BLOB;
// @ts-expect-error raw response-body host construction remains internal
void packageApi.createPlayerBodyResourceHost;
// @ts-expect-error raw whole-file promotion capability remains internal
void packageApi.createPlayerFullBodyResourceHost;
// @ts-expect-error raw assembly host construction remains internal
void packageApi.createPlayerBlobAssemblyResourceHost;
// @ts-expect-error raw verified-store host construction remains internal
void packageApi.createPlayerVerifiedBlobResourceHost;
// @ts-expect-error candidate accounting is available only through the closed bundle
void packageApi.createPlayerCandidateResourceAuthority;
// @ts-expect-error canvas accounting is available only through the closed bundle
void packageApi.createPlayerCanvasBackingResourceHost;
// @ts-expect-error sparse-store construction remains session-owned
void packageApi.VerifiedBlobStore;
// @ts-expect-error range transport construction remains session-owned
void packageApi.openRangeAssetSession;
// @ts-expect-error bounded readers remain behind the asset-session API
void packageApi.readBoundedBody;
// @ts-expect-error digest promotion capabilities remain session-owned
void packageApi.verifySha256AndPromote;

const assetRequest: RuntimeAssetRequest = {
  url: "https://example.test/motion.avl",
  integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  credentials: "same-origin"
};
const requestWithUnknownField: RuntimeAssetRequest = {
  url: "https://example.test/motion.avl",
  // @ts-expect-error asset requests do not expose transport header overrides
  headers: { Range: "bytes=0-63" }
};
const policyWithUnknownField: RuntimePageResourcePolicyInput = {
  // @ts-expect-error page policy has no generic or untracked byte bucket
  maximumOtherBytes: 1
};
const loaderPolicyWithUnknownField: RuntimeLoaderPolicy = {
  maximumFileBytes: 1024,
  maximumRangeBytes: 256,
  maximumConcurrentPayloadBodies: 4,
  overallTimeoutMs: 1_000,
  firstByteTimeoutMs: 250,
  idleBodyTimeoutMs: 250,
  // @ts-expect-error hosts cannot add retry behavior to the closed policy
  retries: 1
};
const normalizedIntegrity: Readonly<NormalizedExternalIntegrity> =
  parseExternalIntegrity(
    "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  );
// @ts-expect-error only the parser can produce normalized integrity metadata
const weakIntegrity: NormalizedExternalIntegrity = "W/sha256-invalid";
const residencySnapshot = null as unknown as RuntimeAssetResidencySnapshot;
// @ts-expect-error residency observations are immutable
residencySnapshot.verifiedPayloadBytes = 1;
const pageResourceSnapshot = null as unknown as RuntimePageResourceSnapshot;
// @ts-expect-error participant snapshot arrays are immutable
pageResourceSnapshot.participants.push(pageResourceSnapshot.participants[0]!);
// @ts-expect-error manager-issued leases carry an inaccessible nominal brand
const directlyConstructedLease: RuntimeByteLease = {
  snapshot: () => null as never,
  resize: async () => undefined,
  release: () => undefined
};
const openOptionsWithUnknownField: OpenRuntimeAssetOptions = {
  resources: null as unknown as RuntimeAssetSessionResources,
  // @ts-expect-error the public opener has no retry loop or retry override
  retries: 1
};
// @ts-expect-error asset session observations are immutable
assetSessionSnapshot.pendingLoads = 1;
// @ts-expect-error decoder observations are immutable
decoderSnapshot.tickets.push(decoderSnapshot.tickets[0]!);
// @ts-expect-error lifecycle observations are immutable
lifecycleSnapshot.pendingWaitCount = 1;

void readiness;
void translation;
void catalogFactory;
void sourceSelector;
void sourceProbeFactory;
void catalogEntry;
void videoCandidate;
void sourceDescriptor;
void sourceSession;
void sourceSelectionInput;
void acceptedSource;
void sourceProbeOptions;
void frameKey;
void candidate;
void report;
void result;
void presentationGeometry;
void scheduler;
void trace;
void reason;
void staticReasons;
void terminalFailureReason;
void error;
void traceCapacity;
void motionPolicies;
void motionCoordinatorConstructor;
void motionSnapshot;
void motionTransition;
void motionStaticOrigin;
void presentationFits;
void presentation;
void integratedPlayerConstructor;
void videoFactoryConstructor;
void integratedOptions;
void integratedRealtimeOptions;
void tickResult;
void browserCompositionFactory;
void browserComposition;
void browserCompositionOptions;
void browserControls;
void frameBackendConstructor;
void presentationPlanesConstructor;
void frameRendererConstructor;
void frameBackendOptions;
void presentationPlanesOptions;
void presentationPlanesSnapshot;
void presentationResizeInput;
void presentableBackend;
void browserBackendOptions;
void rendererOptions;
void rendererSnapshot;
void frameRendererTimer;
void uploadTimeout;
void assetRequest;
void requestWithUnknownField;
void policyWithUnknownField;
void loaderPolicyWithUnknownField;
void normalizedIntegrity;
void weakIntegrity;
void residencySnapshot;
void pageResourceSnapshot;
void directlyConstructedLease;
void assetOpener;
void byteAssetOpener;
void pagePolicyFactory;
void pageManagerConstructor;
void playerAccountConstructor;
void decoderLeasesConstructor;
void reclamationConstructor;
void lifecycleConstructor;
void sessionResourcesFactory;
void webRuntimeResourcesFactory;
void webRuntimeResources;
void bundledParticipantBinding;
void bundledCanvasBacking;
void urlOpenOptions;
void byteOpenOptions;
void ensureOptions;
void assetSession;
void evictRenditionUnits;
void assetSessionSnapshot;
void playerAccountSnapshot;
void decoderSnapshot;
void reclamationSnapshot;
void participantUpdate;
void reclamationParticipant;
void reclamationReservation;
void lifecycleGeneration;
void lifecycleSnapshot;
void lifecycleWait;
void lifecyclePhase;
void openOptionsWithUnknownField;

// This project compiles with `types: []`: browser runtime code cannot rely on
// Node ambient globals. Explicit browser APIs remain available through DOM.
declare const browserWorker: Worker;
declare const browserFrame: VideoFrame;
void browserWorker;
void browserFrame;
// @ts-expect-error Node ambient APIs must not cross the browser package build
declare const nodeBuffer: Buffer;
void nodeBuffer;
