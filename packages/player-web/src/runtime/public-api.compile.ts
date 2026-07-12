import type {
  MotionGraphReadiness,
  MotionGraphResult
} from "@rendered-motion/graph";
import type { ValidatedAssetLayout } from "@rendered-motion/format";

import {
  RUNTIME_TRACE_CAPACITY,
  IntegratedPlayer,
  OpaqueCandidateFactory,
  RendererUploadTimeoutError,
  RuntimeAssetCatalog,
  RuntimePlaybackError,
  StaticSurfaceDecodeTimeoutError,
  createBrowserOpaqueCandidateComposition,
  createOpaqueRenditionCandidates,
  installRuntimeAssetCatalog,
  inspectOpaqueRenditionCandidate,
  normalizeRuntimeFailure,
  summarizeStaticReason,
  translateGraphReadiness,
  type DecoderWorkerMetrics,
  type DecoderWorkerSample,
  type ManagedDecoderWorkerFrame,
  type IntegratedContentTickResult,
  type IntegratedPlayerOptions,
  type IntegratedRealtimeDriverOptions,
  type BrowserOpaqueCandidateComposition,
  type BrowserOpaqueCandidateCompositionOptions,
  type BrowserOpaqueCandidateControls,
  type BrowserOpaqueFrameBackendOptions,
  type BrowserStaticSurfaceDecoderOptions,
  type OpaqueFrameRendererTimerHost,
  type OpaqueCandidateFactoryOptions,
  type RuntimeCandidateReport,
  type RuntimeCatalogAccessUnit,
  type RuntimeCatalogStaticFrame,
  type RuntimeFailure,
  type RuntimeFrameKey,
  type RuntimeMediaPresentation,
  type RuntimeOpaqueRenditionCandidate,
  type RuntimeOpaqueRenditionInspection,
  type RuntimeReadiness,
  type RuntimeReadinessReport,
  type RuntimeReadinessResult,
  type RuntimeSchedulerSnapshot,
  type RuntimeTraceRecord,
  type StaticReason
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
const candidateFactory: typeof createOpaqueRenditionCandidates =
  createOpaqueRenditionCandidates;
const inspector: typeof inspectOpaqueRenditionCandidate =
  inspectOpaqueRenditionCandidate;
const catalogEntry = null as unknown as RuntimeCatalogAccessUnit;
const staticEntry = null as unknown as RuntimeCatalogStaticFrame;
const opaqueCandidate = null as unknown as RuntimeOpaqueRenditionCandidate;
const opaqueInspection = null as unknown as RuntimeOpaqueRenditionInspection;
const frameKey: RuntimeFrameKey = {
  rendition: "opaque",
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
const failure: RuntimeFailure = normalizeRuntimeFailure("readiness-failure");
const error: Error = new RuntimePlaybackError(failure);
const summarized = summarizeStaticReason({
  phase: "preparation",
  staticReady: true,
  deadlineExpired: false,
  hasOpaqueRendition: true,
  workerAvailable: true,
  rendererAvailable: true,
  candidateFailures: [failure]
});
const traceCapacity: 512 = RUNTIME_TRACE_CAPACITY;
const integratedPlayerConstructor: typeof IntegratedPlayer = IntegratedPlayer;
const opaqueFactoryConstructor: typeof OpaqueCandidateFactory =
  OpaqueCandidateFactory;
const integratedOptions = null as unknown as IntegratedPlayerOptions;
const integratedRealtimeOptions = null as unknown as IntegratedRealtimeDriverOptions;
const opaqueFactoryOptions = null as unknown as OpaqueCandidateFactoryOptions;
const tickResult = null as unknown as IntegratedContentTickResult;
const browserCompositionFactory: typeof createBrowserOpaqueCandidateComposition =
  createBrowserOpaqueCandidateComposition;
const browserComposition = null as unknown as BrowserOpaqueCandidateComposition;
const browserCompositionOptions =
  null as unknown as BrowserOpaqueCandidateCompositionOptions;
const browserControls = null as unknown as BrowserOpaqueCandidateControls;
const browserBackendOptions = null as unknown as BrowserOpaqueFrameBackendOptions;
const staticDecoderOptions =
  null as unknown as BrowserStaticSurfaceDecoderOptions;
const rendererTimer = null as unknown as OpaqueFrameRendererTimerHost;
const uploadTimeout: Error = new RendererUploadTimeoutError(1);
const staticTimeout: Error = new StaticSurfaceDecodeTimeoutError(1);

void readiness;
void translation;
void catalogFactory;
void candidateFactory;
void inspector;
void catalogEntry;
void staticEntry;
void opaqueCandidate;
void opaqueInspection;
void frameKey;
void candidate;
void report;
void result;
void presentation;
void scheduler;
void trace;
void reason;
void error;
void summarized;
void traceCapacity;
void integratedPlayerConstructor;
void opaqueFactoryConstructor;
void integratedOptions;
void integratedRealtimeOptions;
void opaqueFactoryOptions;
void tickResult;
void browserCompositionFactory;
void browserComposition;
void browserCompositionOptions;
void browserControls;
void browserBackendOptions;
void staticDecoderOptions;
void rendererTimer;
void uploadTimeout;
void staticTimeout;

// This project compiles with `types: []`: browser runtime code cannot rely on
// Node ambient globals. Explicit browser APIs remain available through DOM.
declare const browserWorker: Worker;
declare const browserFrame: VideoFrame;
void browserWorker;
void browserFrame;
// @ts-expect-error Node ambient APIs must not cross the browser package build
declare const nodeBuffer: Buffer;
void nodeBuffer;
