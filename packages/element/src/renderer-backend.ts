import type {
  RendererDiagnosticContextAttributes,
  RendererDiagnosticLimits,
  RendererDiagnosticPhase,
  RendererDiagnosticUploadPath
} from "./renderer-diagnostics.js";
import type { RendererViewport } from "./renderer-geometry.js";
import type {
  MaterializedRgbaFrame,
  RgbaFrameReference
} from "./rgba-materializer.js";
import type {
  RendererBackendDetails,
  RendererUploadMode
} from "./renderer-contract.js";

export const RENDERER_BACKEND_TARGET: unique symbol = Symbol(
  "renderer-backend-target"
);

/** Opaque storage owned and released exclusively by one backend instance. */
export interface RendererBackendTarget {
  readonly [RENDERER_BACKEND_TARGET]: true;
}

export type RendererBackendTargetKind = "stream" | "resident";

/** A frame whose geometry was validated before crossing the backend boundary. */
export type RendererUploadSource = Readonly<RgbaFrameReference>;
export type RendererRgbaUploadSource = Readonly<MaterializedRgbaFrame>;

export type RendererBackendEvent =
  | Readonly<{ kind: "lost" }>
  | Readonly<{ kind: "restore" }>;

export type RendererBackendEventSink = (
  event: Readonly<RendererBackendEvent>
) => void;

export interface RendererBackendFailureEvidence {
  readonly phase: RendererDiagnosticPhase;
  readonly reason: unknown;
  readonly glError: number | null;
  readonly contextLost: boolean;
  readonly uploadPath: RendererDiagnosticUploadPath | null;
  readonly textureOrdinal: number | null;
}

/** Closed low-level evidence; the controller alone creates public failures. */
export class RendererBackendFailure extends Error {
  public constructor(
    public readonly evidence: Readonly<RendererBackendFailureEvidence>,
    public readonly snapshot: Readonly<RendererBackendSnapshot> | null = null
  ) {
    super("renderer backend operation failed", { cause: evidence.reason });
    this.name = "RendererBackendFailure";
  }
}

/** Exact presentation arithmetic is not a backend/runtime failure. */
export class RendererBackendArithmeticError extends RangeError {}

export interface RendererBackendMemory {
  readonly stagingBytes: number;
  readonly residentBytes: number;
  readonly textureBytes: number;
  /** Raw backing bytes; the controller applies allocation accounting once. */
  readonly backingRawBytes: number;
  readonly runtimeOverheadBytes: number;
}

export interface RendererBackendSnapshot {
  readonly details: RendererBackendDetails;
  readonly memory: Readonly<RendererBackendMemory>;
  readonly resourceCount: number;
  readonly contextListenerCount: number;
  readonly limits: Readonly<RendererDiagnosticLimits>;
  readonly contextAttributes:
    Readonly<RendererDiagnosticContextAttributes> | null;
  readonly vendor: string | null;
  readonly renderer: string | null;
}

export interface RendererBackend {
  readonly kind: "webgl2" | "canvas2d";
  validatePresentation(width: number, height: number): void;
  allocateTarget(
    kind: RendererBackendTargetKind,
    ordinal: number
  ): RendererBackendTarget;
  upload(
    target: RendererBackendTarget,
    source: RendererUploadSource
  ): Promise<void>;
  uploadRgba(
    target: RendererBackendTarget,
    source: RendererRgbaUploadSource
  ): void;
  draw(
    target: RendererBackendTarget,
    viewport: Readonly<RendererViewport>
  ): void;
  releaseTarget(target: RendererBackendTarget): void;
  plannedMemory(
    residentCount: number,
    plannedTargetCount: number,
    backingWidth: number,
    backingHeight: number
  ): Readonly<RendererBackendMemory>;
  snapshot(
    residentCount: number,
    backingWidth: number,
    backingHeight: number
  ): Readonly<RendererBackendSnapshot>;
  restore(): void;
  deactivate(): void;
  dispose(): void;
}

export function backendFailure(
  phase: RendererDiagnosticPhase,
  reason: unknown,
  details: Readonly<{
    glError?: number | null;
    contextLost?: boolean;
    uploadPath?: RendererDiagnosticUploadPath | null;
    textureOrdinal?: number | null;
  }> = {}
): RendererBackendFailure {
  if (reason instanceof RendererBackendFailure) return reason;
  return new RendererBackendFailure(Object.freeze({
    phase,
    reason,
    glError: details.glError ?? null,
    contextLost: details.contextLost ?? false,
    uploadPath: details.uploadPath ?? null,
    textureOrdinal: details.textureOrdinal ?? null
  }));
}

export function webglBackendDetails(
  uploadMode: RendererUploadMode,
  nativeProbeAttempts: number,
  probeReadbackBytes: number,
  nativeProbeInFlight: boolean
): Extract<RendererBackendDetails, { readonly kind: "webgl2" }> {
  return Object.freeze({
    kind: "webgl2",
    uploadMode,
    nativeProbeAttempts,
    probeReadbackBytes,
    nativeProbeInFlight
  });
}
