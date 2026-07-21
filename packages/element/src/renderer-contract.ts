import type {
  RendererFailureError,
  RendererFailureDiagnostic
} from "./renderer-diagnostics.js";
import type {
  MaterializedRgbaFrameReference
} from "./rgba-materializer.js";

export type RendererFrameInspector = (
  source: Readonly<MaterializedRgbaFrameReference>
) => void;

export type RendererContextChange =
  | Readonly<{ state: "lost"; error: null }>
  | Readonly<{ state: "restored"; error: null }>
  | Readonly<{ state: "error"; error: RendererFailureError }>;

export type RendererUploadMode = "native-probing" | "native" | "rgba-copy";

export type RendererBackendDetails =
  | Readonly<{
      kind: "webgl2";
      uploadMode: RendererUploadMode;
      nativeProbeAttempts: number;
      probeReadbackBytes: number;
      nativeProbeInFlight: boolean;
    }>
  | Readonly<{ kind: "canvas2d" }>;

/** Backend-neutral accounting and lifecycle state exposed by every renderer. */
export interface RendererSnapshot {
  readonly backendDetails: RendererBackendDetails;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly effectiveDprX: number;
  readonly effectiveDprY: number;
  readonly contextLossCount: number;
  readonly contextRecoveryCount: number;
  readonly stagingBytes: number;
  readonly residentBytes: number;
  readonly textureBytes: number;
  readonly runtimeBytes: number;
  readonly pendingOperations: number;
  readonly sourceCopiesInFlight: number;
  readonly resourceCount: number;
  readonly contextListenerCount: number;
  readonly failure: Readonly<RendererFailureDiagnostic> | null;
}

export interface RendererRuntime {
  resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
    fit: string
  ): void;
  draw(frame: VideoFrame, newDecoderRun: boolean): Promise<void>;
  inspectAndPrime(
    frame: VideoFrame,
    inspect: RendererFrameInspector
  ): Promise<void>;
  store(
    group: string,
    index: number,
    frame: VideoFrame,
    newDecoderRun: boolean
  ): Promise<void>;
  drawStored(group: string, index: number): Promise<void>;
  settled(): Promise<void>;
  admit(residentCount: number): Readonly<{
    textureBytes: number;
    runtimeBytes: number;
  }>;
  snapshot(): Readonly<RendererSnapshot>;
  dispose(): void;
}
