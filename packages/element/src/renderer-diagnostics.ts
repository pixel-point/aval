import { sanitizeDecoderException } from "./decoder-diagnostics.js";

export type RendererDiagnosticPhase =
  | "backing-admission"
  | "context-create"
  | "capability-query"
  | "device-limits"
  | "program-create"
  | "stream-texture-create"
  | "resident-texture-create"
  | "native-upload"
  | "semantic-upload"
  | "rgba-copy"
  | "rgba-upload"
  | "draw"
  | "resize"
  | "context-event";

export type RendererDiagnosticOperation = "construct" | "runtime" | "restore";
export type RendererDiagnosticUploadPath = "native" | "rgba-copy";
export type RendererDiagnosticBackend = "webgl2" | "canvas2d";

export interface RendererDiagnosticLayout {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly storageWidth: number;
  readonly storageHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
}

export interface RendererDiagnosticBacking {
  readonly width: number;
  readonly height: number;
}

export interface RendererDiagnosticBytes {
  readonly stagingBytes: number;
  readonly residentBytes: number;
  readonly textureBytes: number;
  readonly backingBytes: number;
  readonly runtimeBytes: number;
  readonly maxTextureBytes: number;
  readonly maxBackingBytes: number;
  readonly maxRuntimeBytes: number;
}

export interface RendererDiagnosticLimits {
  readonly maxTextureSize: number;
  readonly maxViewportWidth: number;
  readonly maxViewportHeight: number;
  readonly maxResidentTextures: number;
}

export interface RendererDiagnosticContextAttributes {
  readonly alpha: boolean | null;
  readonly antialias: boolean | null;
  readonly depth: boolean | null;
  readonly desynchronized: boolean | null;
  readonly failIfMajorPerformanceCaveat: boolean | null;
  readonly powerPreference: "default" | "high-performance" | "low-power" | null;
  readonly premultipliedAlpha: boolean | null;
  readonly preserveDrawingBuffer: boolean | null;
  readonly stencil: boolean | null;
  readonly xrCompatible: boolean | null;
}

export interface RendererFailureDiagnostic {
  readonly backend: RendererDiagnosticBackend;
  readonly phase: RendererDiagnosticPhase;
  readonly operation: RendererDiagnosticOperation;
  readonly operationOrdinal: number;
  readonly exception: Readonly<{ name: string; message: string }> | null;
  readonly glError: number | null;
  readonly contextLost: boolean;
  readonly uploadPath: RendererDiagnosticUploadPath | null;
  readonly textureOrdinal: number | null;
  readonly layout: Readonly<RendererDiagnosticLayout>;
  readonly backing: Readonly<RendererDiagnosticBacking>;
  readonly bytes: Readonly<RendererDiagnosticBytes>;
  readonly limits: Readonly<RendererDiagnosticLimits>;
  readonly contextAttributes: Readonly<RendererDiagnosticContextAttributes> | null;
  readonly vendor: string | null;
  readonly renderer: string | null;
}

export interface RendererFailureDiagnosticInput {
  /** Defaults to WebGL2 for the existing renderer while backend selection migrates. */
  readonly backend?: RendererDiagnosticBackend;
  readonly phase: RendererDiagnosticPhase;
  readonly operation: RendererDiagnosticOperation;
  readonly operationOrdinal: number;
  readonly reason: unknown;
  readonly glError: number | null;
  readonly contextLost: boolean;
  readonly uploadPath: RendererDiagnosticUploadPath | null;
  readonly textureOrdinal: number | null;
  readonly layout: Readonly<RendererDiagnosticLayout>;
  readonly backing: Readonly<RendererDiagnosticBacking>;
  readonly bytes: Readonly<RendererDiagnosticBytes>;
  readonly limits: Readonly<RendererDiagnosticLimits>;
  readonly contextAttributes: Readonly<RendererDiagnosticContextAttributes> | null;
  readonly vendor: string | null;
  readonly renderer: string | null;
}

export class RendererFailureError extends Error {
  public readonly diagnostic: Readonly<RendererFailureDiagnostic>;

  public constructor(diagnostic: Readonly<RendererFailureDiagnostic>) {
    super(diagnostic.exception?.message || "AVAL renderer failed");
    this.name = "RendererFailureError";
    this.diagnostic = diagnostic;
  }
}

export function createRendererFailureDiagnostic(
  input: Readonly<RendererFailureDiagnosticInput>
): Readonly<RendererFailureDiagnostic> {
  return Object.freeze({
    backend: input.backend ?? "webgl2",
    phase: input.phase,
    operation: input.operation,
    operationOrdinal: nonNegativeSafeInteger(input.operationOrdinal),
    exception: sanitizeDecoderException(input.reason),
    glError: input.glError === null ? null : nonNegativeSafeInteger(input.glError),
    contextLost: input.contextLost,
    uploadPath: input.uploadPath,
    textureOrdinal: input.textureOrdinal === null
      ? null : nonNegativeSafeInteger(input.textureOrdinal),
    layout: freezeLayout(input.layout),
    backing: Object.freeze({
      width: nonNegativeSafeInteger(input.backing.width),
      height: nonNegativeSafeInteger(input.backing.height)
    }),
    bytes: freezeBytes(input.bytes),
    limits: freezeLimits(input.limits),
    contextAttributes: input.contextAttributes === null
      ? null : freezeContextAttributes(input.contextAttributes),
    vendor: boundedDeviceText(input.vendor),
    renderer: boundedDeviceText(input.renderer)
  });
}

function freezeContextAttributes(
  value: Readonly<RendererDiagnosticContextAttributes>
): Readonly<RendererDiagnosticContextAttributes> {
  return Object.freeze({
    alpha: diagnosticBoolean(value.alpha),
    antialias: diagnosticBoolean(value.antialias),
    depth: diagnosticBoolean(value.depth),
    desynchronized: diagnosticBoolean(value.desynchronized),
    failIfMajorPerformanceCaveat:
      diagnosticBoolean(value.failIfMajorPerformanceCaveat),
    powerPreference:
      value.powerPreference === "default" ||
      value.powerPreference === "high-performance" ||
      value.powerPreference === "low-power"
        ? value.powerPreference : null,
    premultipliedAlpha: diagnosticBoolean(value.premultipliedAlpha),
    preserveDrawingBuffer: diagnosticBoolean(value.preserveDrawingBuffer),
    stencil: diagnosticBoolean(value.stencil),
    xrCompatible: diagnosticBoolean(value.xrCompatible)
  });
}

function freezeLayout(
  value: Readonly<RendererDiagnosticLayout>
): Readonly<RendererDiagnosticLayout> {
  return Object.freeze({
    codedWidth: positiveSafeInteger(value.codedWidth),
    codedHeight: positiveSafeInteger(value.codedHeight),
    storageWidth: positiveSafeInteger(value.storageWidth),
    storageHeight: positiveSafeInteger(value.storageHeight),
    logicalWidth: positiveSafeInteger(value.logicalWidth),
    logicalHeight: positiveSafeInteger(value.logicalHeight)
  });
}

function freezeBytes(
  value: Readonly<RendererDiagnosticBytes>
): Readonly<RendererDiagnosticBytes> {
  return Object.freeze({
    stagingBytes: nonNegativeSafeInteger(value.stagingBytes),
    residentBytes: nonNegativeSafeInteger(value.residentBytes),
    textureBytes: nonNegativeSafeInteger(value.textureBytes),
    backingBytes: nonNegativeSafeInteger(value.backingBytes),
    runtimeBytes: nonNegativeSafeInteger(value.runtimeBytes),
    maxTextureBytes: positiveSafeInteger(value.maxTextureBytes),
    maxBackingBytes: positiveSafeInteger(value.maxBackingBytes),
    maxRuntimeBytes: positiveSafeInteger(value.maxRuntimeBytes)
  });
}

function freezeLimits(
  value: Readonly<RendererDiagnosticLimits>
): Readonly<RendererDiagnosticLimits> {
  return Object.freeze({
    maxTextureSize: nonNegativeSafeInteger(value.maxTextureSize),
    maxViewportWidth: nonNegativeSafeInteger(value.maxViewportWidth),
    maxViewportHeight: nonNegativeSafeInteger(value.maxViewportHeight),
    maxResidentTextures: nonNegativeSafeInteger(value.maxResidentTextures)
  });
}

function positiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("renderer diagnostic dimension is invalid");
  }
  return value;
}

function nonNegativeSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("renderer diagnostic scalar is invalid");
  }
  return value;
}

function diagnosticBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function boundedDeviceText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = sanitizeDecoderException({
    name: "WebGLDevice",
    message: value
  })?.message.trim() ?? "";
  return normalized.length === 0 ? null : normalized.slice(0, 128);
}
