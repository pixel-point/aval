import { AvalPlaybackError } from "../../src/errors.js";
import { parseVideoCodecString } from "@pixel-point/aval-format";
import {
  createRendererFailureDiagnostic,
  RendererFailureError,
  type RendererFailureDiagnostic
} from "../../src/renderer-diagnostics.js";

type CreatePlayer = typeof import("../../src/player.js").createPlayer;

export type CodecFamily = "av1" | "vp9" | "h265" | "h264";

export const FAMILIES = Object.freeze([
  "av1",
  "vp9",
  "h265",
  "h264"
] as const);

export const CODECS = Object.freeze({
  av1: "av01.0.05M.08.0.110.01.01.01.0",
  vp9: "vp09.00.10.08.01.01.01.01.00",
  h265: "hvc1.1.6.L93.B0",
  h264: "avc1.42E020"
} satisfies Readonly<Record<CodecFamily, string>>);

export const WIDTHS = Object.freeze({
  av1: 16,
  vp9: 18,
  h265: 20,
  h264: 22
} satisfies Readonly<Record<CodecFamily, number>>);

export interface CandidateHarnessState {
  readonly disposals: string[];
  readonly operations: string[];
  readonly cleanupFailures: ReadonlySet<string>;
  readonly witnessFrames: ReadonlyMap<CodecFamily, number>;
}

export class SyntheticAsset {
  public readonly manifest;
  public readonly blobs;
  public readonly records;
  readonly #state: Readonly<CandidateHarnessState>;
  readonly #family: CodecFamily;
  #disposed = false;

  public constructor(
    state: Readonly<CandidateHarnessState>,
    family: CodecFamily,
    codec: string
  ) {
    this.#state = state;
    this.#family = family;
    const unit = `${family}-body`;
    const witnessFrame = state.witnessFrames.get(family);
    const packed = witnessFrame !== undefined;
    const frameCount = packed ? witnessFrame + 1 : 1;
    const codedHeight = packed ? 40 : 16;
    this.manifest = {
      formatVersion: "1.1",
      generator: "player-startup-test",
      codec: family,
      bitstream: family === "av1"
        ? "low-overhead"
        : family === "vp9" ? "frame" : "annex-b",
      layout: packed ? "packed-alpha" : "opaque",
      canvas: {
        width: 16,
        height: 16,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [{
        id: "main",
        codec,
        bitDepth: 8,
        codedWidth: WIDTHS[family],
        codedHeight,
        bitrate: { average: 1_000, peak: 1_000 },
        ...(packed
          ? {
              alphaLayout: {
                type: "stacked",
                colorRect: [0, 0, 16, 16],
                alphaRect: [0, 24, 16, 16]
              },
              outputQualification: {
                kind: "packed-alpha-v1",
                unit,
                frame: witnessFrame,
                samples: [{ x: 0, y: 0, expectedRange: [32, 64] }]
              }
            }
          : { alphaLayout: { type: "opaque", colorRect: [0, 0, 16, 16] } })
      }],
      units: [{
        id: unit,
        kind: "body",
        playback: frameCount === 1 ? "finite" : "loop",
        frameCount,
        ports: [{ id: "entry", entryFrame: 0, portalFrames: [0] }],
        chunks: [{
          rendition: "main",
          chunkStart: 0,
          chunkCount: frameCount,
          frameCount,
          sha256: "0".repeat(64)
        }]
      }],
      initialState: family,
      states: [{ id: family, bodyUnit: unit }],
      edges: [],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: [unit],
        immediateEdges: []
      },
      limits: {
        maxCompiledBytes: 16_000_000,
        maxRuntimeBytes: 16_000_000,
        decodedPixelBytes: 4_096,
        persistentCacheBytes: 0,
        runtimeWorkingSetBytes: 1_000_000
      }
    };
    this.blobs = [{
      rendition: "main",
      unit,
      offset: 1_000,
      length: frameCount,
      chunkStart: 0,
      chunkCount: frameCount,
      frameCount,
      sha256: "0".repeat(64)
    }];
    this.records = Array.from({ length: frameCount }, (_, index) => ({
      byteOffset: 1_000 + index,
      byteLength: 1,
      presentationTimestamp: index,
      duration: 1,
      randomAccess: index === 0,
      displayedFrameCount: 1
    }));
  }

  public async unitBytes(): Promise<Uint8Array<ArrayBuffer>> {
    this.#state.operations.push(`asset-fetch:${this.#family}`);
    return new Uint8Array(1);
  }

  public chunkBytes(): ArrayBuffer {
    return new Uint8Array([0]).buffer;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#state.disposals.push(this.#family);
    this.#state.operations.push(`asset-dispose:${this.#family}`);
    if (this.#state.cleanupFailures.has(this.#family)) {
      throw new Error(`synthetic asset cleanup failure for ${this.#family}`);
    }
    this.#disposed = true;
  }

  public snapshot() {
    return {
      mode: "range",
      disposed: this.#disposed,
      declaredFileBytes: 2_000,
      metadataBytes: 1_000,
      verifiedBytes: 1,
      residentBlobBytes: 1,
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0
    };
  }
}

export function createCandidateHarness(
  createPlayer: CreatePlayer,
  state: Readonly<CandidateHarnessState>,
  families: readonly CodecFamily[],
  controller = new AbortController()
) {
  const publications = {
    metadata: [] as string[],
    readiness: [] as string[],
    draws: 0,
    retirements: 0,
    playbackFailures: [] as string[]
  };
  const terminal = new AvalPlaybackError(Object.freeze({
    code: "worker-decode-failure",
    message: "Playback could not continue.",
    operation: "prepare"
  }), 1);
  const input = {
    canvas: new EventTarget() as HTMLCanvasElement,
    platform: testPlatform(),
    initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
    baseUrl: "https://example.test/",
    sources: families.map((family, sourceIndex) => ({
      src: `${family}.avl`,
      codec: CODECS[family],
      integrity: "",
      sourceIndex
    })),
    credentials: "same-origin" as const,
    signal: controller.signal,
    preparationTimeoutMs: 5_000,
    motion: "full" as const,
    reduced: false,
    initialState: null,
    initialBody: false,
    visible: true,
    decoderReady: () => true,
    onResourceBytes: () => undefined,
    onMetadata: (metadata: Readonly<{ initialState: string }>) => {
      publications.metadata.push(metadata.initialState);
    },
    onReadiness: (value: string) => publications.readiness.push(value),
    onAnimationResourcesRetired: () => { publications.retirements += 1; },
    onDraw: () => { publications.draws += 1; },
    onRestart: () => undefined,
    onEvent: () => undefined,
    onFailure: () => undefined,
    onPlaybackFailure: (
      code: ConstructorParameters<typeof AvalPlaybackError>[0]["code"],
      operation: string
    ) => {
      publications.playbackFailures.push(`${code}:${operation}`);
      return terminal;
    }
  };
  return { controller, input, publications, terminal, createPlayer };
}

export async function prepareCandidateAttempt(
  createPlayer: CreatePlayer,
  input: Parameters<CreatePlayer>[0]
) {
  let player: Awaited<ReturnType<CreatePlayer>> | null = null;
  try {
    player = await createPlayer(input);
    player.activate();
    const result = await player.prepare();
    return { status: "fulfilled" as const, player, result };
  } catch (error) {
    if (player !== null) {
      try { await player.dispose(); } catch { /* retain startup outcome */ }
    }
    return { status: "rejected" as const, error };
  }
}

export function requirePrepared(
  outcome: Awaited<ReturnType<typeof prepareCandidateAttempt>>
): Awaited<ReturnType<CreatePlayer>> {
  if (outcome.status === "rejected") throw outcome.error;
  return outcome.player;
}

export async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

export function invalidOutputError(codec: string): Error {
  const error = new Error(`synthetic invalid decoded frame for ${codec}`);
  error.name = "EncodingError";
  return error;
}

export function rgbaCopyFailureError(): RendererFailureError {
  return new RendererFailureError(baseRgbaCopyDiagnostic());
}

export function baseRgbaCopyDiagnostic(): Readonly<RendererFailureDiagnostic> {
  return createRendererFailureDiagnostic({
    backend: "webgl2",
    phase: "rgba-copy",
    operation: "runtime",
    operationOrdinal: 2,
    reason: new DOMException("VideoFrame RGBA export is unavailable", "NotSupportedError"),
    glError: null,
    contextLost: false,
    uploadPath: "rgba-copy",
    textureOrdinal: null,
    layout: {
      codedWidth: 16, codedHeight: 16, storageWidth: 16, storageHeight: 16,
      logicalWidth: 16, logicalHeight: 16
    },
    backing: { width: 16, height: 16 },
    bytes: {
      stagingBytes: 1_024, residentBytes: 0, textureBytes: 3_840,
      backingBytes: 1_280, runtimeBytes: 6_144,
      maxTextureBytes: 16_000_000, maxBackingBytes: 16_000_000,
      maxRuntimeBytes: 16_000_000
    },
    limits: {
      maxTextureSize: 8_192, maxViewportWidth: 8_192,
      maxViewportHeight: 8_192, maxResidentTextures: 4_096
    },
    contextAttributes: null,
    vendor: "Synthetic Vendor",
    renderer: "Synthetic Renderer"
  });
}

export function codecFamily(codec: string): CodecFamily {
  const parsed = parseVideoCodecString(codec);
  if (parsed === undefined) {
    throw new Error(`unknown synthetic codec ${codec}`);
  }
  return parsed.family;
}

export function familyForWidth(width: number): CodecFamily {
  const match = FAMILIES.find((family) => WIDTHS[family] === width);
  if (match === undefined) throw new Error(`unknown synthetic width ${String(width)}`);
  return match;
}

function testPlatform() {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    Worker: globalThis.Worker ?? null,
    VideoDecoder: globalThis.VideoDecoder ?? null,
    VideoFrame: globalThis.VideoFrame ?? null,
    requestAnimationFrame: globalThis.requestAnimationFrame.bind(globalThis),
    cancelAnimationFrame: globalThis.cancelAnimationFrame.bind(globalThis),
    now: () => performance.now(),
    setTimeout: (callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay) as unknown as number,
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    crypto: globalThis.crypto
  };
}
