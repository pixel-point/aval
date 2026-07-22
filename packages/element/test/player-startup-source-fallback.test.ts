import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_ADMISSION_TIMEOUT_MS } from
  "../src/asset-timing-policy.js";
import type {
  DecoderDiagnosticCode,
  DecoderDiagnosticPhase,
  DecoderFailureDiagnostic
} from "../src/decoder-diagnostics.js";
import type { RendererFailureDiagnostic } from "../src/renderer-diagnostics.js";
import { DECODER_PROGRESS_TIMEOUT_MS } from
  "../src/decoder-timing-policy.js";
import {
  CANDIDATE_INSTALLATION_TIMEOUT_MS,
  CANDIDATE_PREPARATION_TIMEOUT_MS,
  playerPreparationBudgetMs
} from "../src/preparation-budget.js";
import {
  CODECS,
  FAMILIES,
  SyntheticAsset,
  codecFamily,
  createCandidateHarness,
  eventually,
  familyForWidth,
  invalidOutputError,
  prepareCandidateAttempt,
  requirePrepared,
  rgbaCopyFailureError,
  type CodecFamily
} from "./support/provisional-startup-harness.js";
import { installSafariZeroDurationDecoder } from
  "./support/safari-zero-duration-decoder.js";

type StartupOutcome =
  | "success"
  | "invalid-output"
  | "encoding-error"
  | "unsupported-config"
  | "configure-not-supported"
  | "decode-not-supported"
  | "decode-encoding-rejected"
  | "flush-not-supported"
  | "flush-encoding-rejected"
  | "transport-error"
  | "probe-unsupported-config"
  | "probe-not-supported"
  | "probe-encoding-error"
  | "probe-transport-error"
  | "probe-arbitrary-error"
  | "probe-supported-then-transport"
  | "probe-unsupported-false"
  | "probe-progress-timeout"
  | "decode-progress-timeout"
  | "pending";

const startup = vi.hoisted(() => ({
  outcomes: new Map<string, StartupOutcome>(),
  assetOpenDelayMs: 0,
  renditionCounts: new Map<CodecFamily, number>(),
  probeOutcomes: new Map<string, readonly [StartupOutcome, StartupOutcome]>(),
  actualDecoderFamilies: new Set<string>(),
  opens: [] as string[],
  disposals: [] as string[],
  operations: [] as string[],
  cleanupFailures: new Set<string>(),
  witnessFrames: new Map<CodecFamily, number>(),
  semanticMismatches: new Set<string>(),
  identityFailures: new Set<string>(),
  storageFailures: new Set<string>(),
  pendingQualificationTakes: new Map<string, number>(),
  rgbaCopyFailures: new Set<string>(),
  rendererFailures: new Set<string>(),
  resizeFailures: new Set<string>(),
  snapshotFailures: new Set<string>(),
  mixedRuntimeTransportFailures: new Set<string>(),
  mixedRendererTransportFailures: new Set<string>(),
  decoders: [] as Array<{
    codec: string;
    disposed: boolean;
    fail: (
      reason?: Error,
      phase?: DecoderDiagnosticPhase,
      code?: DecoderDiagnosticCode
    ) => void;
  }>
}));

vi.mock("../src/asset.js", () => ({
  Asset: class {
    public static async open(source: Readonly<{ src: string; codec: string }>) {
      const family = codecFamily(source.codec);
      startup.opens.push(family);
      startup.operations.push(`asset-open:${family}`);
      if (startup.assetOpenDelayMs > 0) {
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, startup.assetOpenDelayMs);
        });
      }
      return new SyntheticAsset(
        startup,
        family,
        CODECS[family],
        startup.renditionCounts.get(family) ?? 1
      );
    }
  }
}));

vi.mock("../src/codec-validator.js", () => ({
  createCodecValidator: () => ({
    validate: () => undefined,
    complete: () => undefined
  })
}));

vi.mock("../src/decoder.js", async () => {
  const actual = await vi.importActual<typeof import("../src/decoder.js")>(
    "../src/decoder.js"
  );
  const diagnostics = await vi.importActual<
    typeof import("../src/decoder-diagnostics.js")
  >("../src/decoder-diagnostics.js");
  return {
    DecoderLocalFailureError: actual.DecoderLocalFailureError,
    Decoder: class SyntheticDecoder {
    public encodedBytes = 0;
    readonly #codec: string;
    readonly #failure!: Promise<never>;
    readonly #control!: {
      codec: string;
      disposed: boolean;
      fail: (
        reason?: Error,
        phase?: DecoderDiagnosticPhase,
        code?: DecoderDiagnosticCode
      ) => void;
    };
    readonly #lane: 0 | 1;
    #rejectFailure!: (reason: unknown) => void;
    #failureSettled = false;
    #terminalError: Error | null = null;
    #disposed = false;
    #generation = 0;
    #diagnostic: Readonly<DecoderFailureDiagnostic> | null = null;
    #rejectRunReady: ((reason: unknown) => void) | null = null;
    #runReadySettled = false;

    public constructor(
      config: Readonly<VideoDecoderConfig>,
      expectation: ConstructorParameters<typeof actual.Decoder>[1],
      limits?: ConstructorParameters<typeof actual.Decoder>[2]
    ) {
      this.#codec = codecFamily(config.codec);
      this.#lane = startup.decoders.filter(({ codec }) =>
        codec === this.#codec
      ).length % 2 as 0 | 1;
      if (startup.actualDecoderFamilies.has(this.#codec)) {
        return new actual.Decoder(
          config,
          expectation,
          limits
        ) as unknown as SyntheticDecoder;
      }
      this.#failure = new Promise<never>((_resolve, reject) => {
        this.#rejectFailure = reject;
      });
      void this.#failure.catch(() => undefined);
      this.#control = {
        codec: this.#codec,
        disposed: false,
        fail: (
          reason = invalidOutputError(this.#codec),
          phase = "output-validation",
          code = "invalid-output"
        ) => this.#fail(reason, phase, code)
      };
      startup.decoders.push(this.#control);
    }

    public get available(): boolean { return !this.#disposed; }

    public async supported(): Promise<boolean> {
      startup.operations.push(`probe:${this.#codec}`);
      const outcome = startup.probeOutcomes.get(this.#codec)?.[this.#lane] ??
        startup.outcomes.get(this.#codec) ?? "success";
      if (outcome === "probe-supported-then-transport") {
        const error = new Error(
          `synthetic post-support transport failure for ${this.#codec}`
        );
        this.#fail(error, "frame-transfer", "transport");
        return true;
      }
      if (outcome === "probe-unsupported-false") {
        const error = new Error(
          `synthetic unsupported boolean probe for ${this.#codec}`
        );
        this.#fail(error, "probe", "unsupported-config");
        return false;
      }
      if (outcome === "probe-unsupported-config") {
        const error = new Error(
          `synthetic unsupported probe config for ${this.#codec}`
        );
        throw this.#fail(error, "probe", "unsupported-config");
      }
      if (outcome === "probe-not-supported" ||
        outcome === "probe-encoding-error") {
        const error = new Error(`synthetic probe failure for ${this.#codec}`);
        error.name = outcome === "probe-not-supported"
          ? "NotSupportedError"
          : "EncodingError";
        throw this.#fail(error, "probe", "decoder-operation");
      }
      if (outcome === "probe-transport-error") {
        const error = new Error(
          `synthetic probe transport failure for ${this.#codec}`
        );
        throw this.#fail(error, "probe", "transport");
      }
      if (outcome === "probe-arbitrary-error") {
        const error = new Error(`synthetic arbitrary probe failure for ${this.#codec}`);
        throw this.#fail(error, "probe", "decoder-operation");
      }
      if (outcome === "probe-progress-timeout") {
        return new Promise<boolean>((_resolve, reject) => {
          globalThis.setTimeout(() => {
            const error = new DOMException(
              `synthetic probe progress timeout for ${this.#codec}`,
              "TimeoutError"
            );
            reject(this.#fail(error, "probe", "watchdog-timeout"));
          }, DECODER_PROGRESS_TIMEOUT_MS);
        });
      }
      return true;
    }

    public failure(): Promise<never> { return this.#failure; }
    public terminalError(): Error | null { return this.#terminalError; }

    public createRun(samples: readonly Readonly<{
      displayedFrames: number;
    }>[]) {
      this.#rejectRunReady = null;
      this.#runReadySettled = false;
      const generation = ++this.#generation;
      const outcome = startup.outcomes.get(this.#codec) ?? "success";
      startup.operations.push(`run:${this.#codec}`);
      let resolveRunReady!: () => void;
      const readiness = new Promise<void>((resolve, reject) => {
        resolveRunReady = resolve;
        this.#rejectRunReady = reject;
      });
      if (outcome === "success") {
        queueMicrotask(() => {
          if (this.#runReadySettled) return;
          this.#runReadySettled = true;
          resolveRunReady();
        });
      } else if (outcome === "invalid-output") {
        queueMicrotask(() => {
          if (startup.mixedRuntimeTransportFailures.has(this.#codec)) {
            const sibling = startup.decoders.find((candidate) =>
              candidate.codec === this.#codec &&
              candidate !== this.#control &&
              !candidate.disposed
            );
            const transport = new Error(
              `synthetic concurrent transport failure for ${this.#codec}`
            );
            sibling?.fail(transport, "frame-transfer", "transport");
          }
          this.#fail(invalidOutputError(this.#codec));
        });
      } else if (outcome === "encoding-error") {
        const error = new Error(`synthetic decode failure for ${this.#codec}`);
        error.name = "EncodingError";
        queueMicrotask(() => this.#fail(error, "decode", "decoder-operation"));
      } else if (
        outcome === "configure-not-supported" ||
        outcome === "decode-not-supported" ||
        outcome === "decode-encoding-rejected" ||
        outcome === "flush-not-supported" ||
        outcome === "flush-encoding-rejected"
      ) {
        const phase = outcome.startsWith("configure")
          ? "configure"
          : outcome.startsWith("flush") ? "flush" : "decode";
        const error = new Error(`synthetic ${outcome} for ${this.#codec}`);
        error.name = outcome.endsWith("not-supported")
          ? "NotSupportedError"
          : "EncodingError";
        queueMicrotask(() => this.#fail(error, phase, "decoder-operation"));
      } else if (outcome === "unsupported-config") {
        const error = new Error(`synthetic unsupported config for ${this.#codec}`);
        error.name = "NotSupportedError";
        queueMicrotask(() => this.#fail(error, "configure", "unsupported-config"));
      } else if (outcome === "transport-error") {
        queueMicrotask(() => this.#fail(
          new Error(`synthetic worker transport failure for ${this.#codec}`),
          "frame-transfer",
          "transport"
        ));
      } else if (outcome === "decode-progress-timeout") {
        globalThis.setTimeout(() => this.#fail(
          new DOMException(
            `synthetic decode progress timeout for ${this.#codec}`,
            "TimeoutError"
          ),
          "decode",
          "watchdog-timeout"
        ), DECODER_PROGRESS_TIMEOUT_MS);
      }
      let closed = false;
      let rejectPendingTake: ((reason: unknown) => void) | null = null;
      return {
        generation,
        frameCount: samples.reduce((total, sample) =>
          total + sample.displayedFrames, 0),
        openFrames: 0,
        outstanding: 0,
        get closed() { return closed; },
        ready: (minimum?: number) => {
          startup.operations.push(
            `ready:${this.#codec}:${minimum === undefined ? "default" : String(minimum)}`
          );
          return readiness;
        },
        take: async (index: number) => {
          await readiness;
          startup.operations.push(`take:${this.#codec}:${String(index)}`);
          startup.operations.push(
            `lane-take:${this.#codec}:${String(this.#lane)}:${String(index)}`
          );
          if (
            this.#lane === 1 &&
            startup.pendingQualificationTakes.get(this.#codec) === index
          ) {
            return new Promise((_resolve, reject) => {
              rejectPendingTake = reject;
            });
          }
          return { codec: this.#codec, index };
        },
        release: (frame: Readonly<{ index: number }>) => {
          startup.operations.push(
            `release:${this.#codec}:${String(frame.index)}`
          );
          startup.operations.push(
            `lane-release:${this.#codec}:${String(this.#lane)}:${String(frame.index)}`
          );
        },
        complete: async () => undefined,
        close: () => {
          if (closed) return;
          closed = true;
          startup.operations.push(
            `run-close:${this.#codec}:${String(this.#lane)}`
          );
          rejectPendingTake?.(
            new DOMException("synthetic decoder run closed", "AbortError")
          );
          if (!this.#runReadySettled) {
            this.#runReadySettled = true;
            this.#rejectRunReady?.(
              new DOMException("synthetic decoder run closed", "AbortError")
            );
          }
        }
      };
    }

    public snapshot() {
      if (startup.snapshotFailures.has(this.#codec)) {
        throw new Error(`synthetic renderer snapshot failure for ${this.#codec}`);
      }
      return {
        workerCount: this.#disposed ? 0 : 1,
        openFrames: 0,
        openFrameBytes: 0,
        diagnostic: this.#diagnostic
      };
    }

    public dispose(): void {
      if (this.#disposed) return;
      this.#disposed = true;
      this.#control.disposed = true;
      startup.operations.push(`decoder-dispose:${this.#codec}`);
      if (!this.#runReadySettled) {
        this.#runReadySettled = true;
        this.#rejectRunReady?.(
          new DOMException("synthetic decoder disposed", "AbortError")
        );
      }
    }

    #fail(
      reason: Error,
      phase: DecoderDiagnosticPhase = "output-validation",
      code: DecoderDiagnosticCode = "invalid-output"
    ): Error {
      if (this.#failureSettled || this.#disposed) return reason;
      this.#failureSettled = true;
      const diagnostic = diagnostics.createDecoderFailureDiagnostic({
        phase,
        code,
        run: this.#generation === 0 ? null : this.#generation,
        decodeOrdinal: this.#generation === 0 ? null : 0,
        reason,
        firstFrame: null,
        outputFailure: code === "invalid-output"
          ? Object.freeze({
              kind: "unknown-output",
              validationLayer: "host-expectation",
              field: "timestamp",
              expected: null,
              actual: null
            })
          : null
      });
      this.#diagnostic = diagnostic;
      const reported = actual.decoderReportedError(reason, diagnostic);
      this.#terminalError = reported;
      if (!this.#runReadySettled) {
        this.#runReadySettled = true;
        this.#rejectRunReady?.(reported);
      }
      this.#rejectFailure(reported);
      return reported;
    }
    }
  };
});

vi.mock("../src/renderer.js", () => ({
  Renderer: class {
    readonly #codec: string;
    #disposed = false;
    #failure: Readonly<RendererFailureDiagnostic> | null = null;

    public constructor(
      _canvas: HTMLCanvasElement,
      layout: Readonly<{ codedWidth: number }>
    ) {
      this.#codec = familyForWidth(layout.codedWidth);
      startup.operations.push(`renderer:${this.#codec}`);
    }

    public admit() { return { textureBytes: 1, runtimeBytes: 3 }; }

    public snapshot() {
      return {
        backendDetails: Object.freeze({
          kind: "webgl2" as const,
          uploadMode: "native-probing" as const,
          nativeProbeAttempts: 0,
          probeReadbackBytes: 0,
          nativeProbeInFlight: false
        }),
        cssWidth: 16,
        cssHeight: 16,
        backingWidth: 16,
        backingHeight: 16,
        effectiveDprX: 1,
        effectiveDprY: 1,
        contextLossCount: 0,
        contextRecoveryCount: 0,
        stagingBytes: 1,
        residentBytes: 0,
        textureBytes: 1,
        runtimeBytes: 3,
        pendingOperations: 0,
        sourceCopiesInFlight: 0,
        resourceCount: 4,
        contextListenerCount: 2,
        failure: this.#failure
      };
    }

    public async draw(): Promise<void> {
      startup.operations.push(`draw:${this.#codec}`);
      if (startup.rgbaCopyFailures.has(this.#codec)) {
        if (startup.mixedRendererTransportFailures.has(this.#codec)) {
          const transport = new Error(
            `synthetic concurrent renderer transport failure for ${this.#codec}`
          );
          startup.decoders.find((candidate) =>
            candidate.codec === this.#codec && !candidate.disposed
          )?.fail(transport, "frame-transfer", "transport");
        }
        const error = rgbaCopyFailureError();
        this.#failure = error.diagnostic;
        throw error;
      }
      if (startup.rendererFailures.has(this.#codec)) {
        throw new Error(`synthetic WebGL draw failure for ${this.#codec}`);
      }
    }

    public async inspectAndPrime(
      frame: VideoFrame,
      inspect: (source: Readonly<{
        frame: VideoFrame;
        rgba: Readonly<{
          width: number;
          height: number;
          stride: number;
          pixels: Uint8Array;
        }>;
      }>) => void
    ): Promise<void> {
      const index = (frame as unknown as Readonly<{ index: number }>).index;
      startup.operations.push(`inspect:${this.#codec}:${String(index)}`);
      if (startup.rendererFailures.has(this.#codec)) {
        throw new Error(`synthetic WebGL inspection failure for ${this.#codec}`);
      }
      if (startup.identityFailures.has(this.#codec)) {
        throw new Error("renderer inspection frame identity mismatch");
      }
      if (startup.rgbaCopyFailures.has(this.#codec)) {
        const error = rgbaCopyFailureError();
        this.#failure = error.diagnostic;
        throw error;
      }
      const width = startup.storageFailures.has(this.#codec) ? 15 : 16;
      const height = 40;
      const stride = width * 4;
      const pixels = new Uint8Array(stride * height);
      pixels[24 * stride] = startup.semanticMismatches.has(this.#codec) ? 96 : 48;
      inspect(Object.freeze({
        frame,
        rgba: Object.freeze({ width, height, stride, pixels })
      }));
      startup.operations.push(`prime:${this.#codec}:${String(index)}`);
    }

    public async store(): Promise<void> {}
    public async drawStored(): Promise<void> {}
    public resize(): void {
      if (startup.resizeFailures.has(this.#codec)) {
        throw new Error(`synthetic WebGL resize failure for ${this.#codec}`);
      }
    }
    public settled(): Promise<void> { return Promise.resolve(); }

    public dispose(): void {
      if (this.#disposed) return;
      this.#disposed = true;
      startup.operations.push(`renderer-dispose:${this.#codec}`);
    }
  }
}));

import { createPlayer } from "../src/player.js";

function createHarness(
  families: readonly CodecFamily[],
  controller = new AbortController()
) {
  return createCandidateHarness(createPlayer, startup, families, controller);
}

function prepareAttempt(input: Parameters<typeof createPlayer>[0]) {
  return prepareCandidateAttempt(createPlayer, input);
}

function failLiveDecoder(family: CodecFamily): void {
  const control = startup.decoders.find((candidate) =>
    candidate.codec === family && !candidate.disposed
  );
  if (control === undefined) throw new Error(`no live ${family} decoder`);
  control.fail();
}

function requireWitnesses(
  families: readonly CodecFamily[],
  frame = 17
): void {
  for (const family of families) startup.witnessFrames.set(family, frame);
}

beforeEach(() => {
  startup.outcomes.clear();
  startup.assetOpenDelayMs = 0;
  startup.renditionCounts.clear();
  startup.probeOutcomes.clear();
  startup.actualDecoderFamilies.clear();
  startup.opens.length = 0;
  startup.disposals.length = 0;
  startup.operations.length = 0;
  startup.cleanupFailures.clear();
  startup.witnessFrames.clear();
  startup.semanticMismatches.clear();
  startup.identityFailures.clear();
  startup.storageFailures.clear();
  startup.pendingQualificationTakes.clear();
  startup.rgbaCopyFailures.clear();
  startup.rendererFailures.clear();
  startup.resizeFailures.clear();
  startup.snapshotFailures.clear();
  startup.mixedRuntimeTransportFailures.clear();
  startup.mixedRendererTransportFailures.clear();
  startup.decoders.length = 0;
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("VideoFrame", class {});
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("player startup source fallback", () => {
  it("memoizes high-index qualification across onCandidate prepare reentry", async () => {
    requireWitnesses(["av1"]);
    const harness = createHarness(["av1"]);
    let reentrantPreparation: Promise<unknown> | null = null;
    const onCandidate = vi.fn((
      candidate: Awaited<ReturnType<typeof createPlayer>>
    ) => {
      reentrantPreparation = candidate.prepare();
      return Promise.resolve();
    });

    const player = await createPlayer({ ...harness.input, onCandidate });
    const reentrant = reentrantPreparation;
    if (reentrant === null) throw new Error("onCandidate did not reenter prepare");
    const [reentrantResult, winnerResult] = await Promise.all([
      reentrant,
      player.prepare()
    ]);

    expect(onCandidate).toHaveBeenCalledTimes(1);
    expect(reentrantResult).toBe(winnerResult);
    expect(winnerResult).toMatchObject({ mode: "animated" });
    expect(startup.operations.filter((operation) =>
      operation.startsWith("inspect:av1:")
    )).toEqual(["inspect:av1:17"]);
    expect(startup.operations.filter((operation) =>
      operation.startsWith("lane-take:av1:1:") ||
      operation.startsWith("lane-release:av1:1:") ||
      operation === "inspect:av1:17" || operation === "prime:av1:17"
    )).toEqual([
      ...Array.from({ length: 17 }, (_, index) => [
        `lane-take:av1:1:${String(index)}`,
        `lane-release:av1:1:${String(index)}`
      ]).flat(),
      "lane-take:av1:1:17",
      "inspect:av1:17",
      "prime:av1:17",
      "lane-release:av1:1:17"
    ]);
    expect(startup.operations.some((operation) =>
      /^ready:av1:\d+$/.test(operation)
    )).toBe(false);
    expect(player.snapshot(false).playbackLifecycle.candidateCommits).toBe(0);
    await player.dispose();
  });

  it("does not arm qualification during reentrant candidate installation", async () => {
    vi.useFakeTimers();
    requireWitnesses(["av1"]);
    const harness = createHarness(["av1"]);
    let reentrantPreparation: Promise<unknown> | null = null;
    let reentrantResume: Promise<void> | null = null;
    let installationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      installationStarted = resolve;
    });
    const attempt = createPlayer({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(1),
      onCandidate: async (candidate) => {
        reentrantPreparation = candidate.prepare();
        reentrantResume = candidate.resume();
        installationStarted();
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 3_000);
        });
      }
    });
    await started;

    await vi.advanceTimersByTimeAsync(CANDIDATE_PREPARATION_TIMEOUT_MS);
    expect(startup.operations.some((operation) =>
      operation.startsWith("inspect:av1:")
    )).toBe(false);

    await vi.advanceTimersByTimeAsync(
      3_000 - CANDIDATE_PREPARATION_TIMEOUT_MS
    );
    const player = await attempt;
    if (reentrantPreparation === null || reentrantResume === null) {
      throw new Error("candidate installation did not reenter preparation");
    }
    await Promise.all([reentrantPreparation, reentrantResume]);
    expect(startup.operations.filter((operation) =>
      operation.startsWith("inspect:av1:")
    )).toEqual(["inspect:av1:17"]);
    await player.dispose();
  });

  it("lets candidate installation await resume without entering qualification", async () => {
    requireWitnesses(["av1"]);
    const harness = createHarness(["av1"]);
    let installationFinished = false;
    const player = await createPlayer({
      ...harness.input,
      onCandidate: async (candidate) => {
        await candidate.resume();
        expect(startup.operations.some((operation) =>
          operation.startsWith("inspect:av1:")
        )).toBe(false);
        installationFinished = true;
      }
    });

    expect(installationFinished).toBe(true);
    expect(startup.operations.filter((operation) =>
      operation.startsWith("inspect:av1:")
    )).toEqual(["inspect:av1:17"]);
    await player.dispose();
  });

  it("grants each provisional candidate a fresh installation window", async () => {
    vi.useFakeTimers();
    startup.outcomes.set("av1", "decode-progress-timeout");
    const families = ["av1", "vp9"] as const;
    const harness = createHarness(families);
    const installations: string[] = [];
    const attempt = prepareAttempt({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(families.length),
      onCandidate: async (candidate) => {
        installations.push(candidate.snapshot(false).selectedCodec ?? "none");
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(
            resolve,
            CANDIDATE_INSTALLATION_TIMEOUT_MS - 1
          );
        });
      }
    });

    await vi.advanceTimersByTimeAsync(
      2 * (CANDIDATE_INSTALLATION_TIMEOUT_MS - 1) +
      DECODER_PROGRESS_TIMEOUT_MS
    );
    const outcome = await attempt;

    const player = requirePrepared(outcome);
    expect(installations).toHaveLength(2);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("keeps candidate installation timeout terminal and out of codec fallback", async () => {
    vi.useFakeTimers();
    const harness = createHarness(["av1", "vp9"]);
    const attempt = prepareAttempt({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(2),
      onCandidate: async () => new Promise<void>(() => undefined)
    });

    await vi.advanceTimersByTimeAsync(CANDIDATE_INSTALLATION_TIMEOUT_MS - 1);
    expect(startup.opens).toEqual(["av1"]);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await attempt;

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([
      "watchdog-timeout:prepare"
    ]);
  });

  it("uses H264 only after witnessed AV1, VP9, and HEVC mismatches", async () => {
    requireWitnesses(FAMILIES, 2);
    for (const family of FAMILIES.slice(0, 3)) {
      startup.semanticMismatches.add(family);
    }
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(FAMILIES);
    expect(startup.disposals).toEqual(FAMILIES.slice(0, 3));
    expect(startup.operations.filter((operation) =>
      operation.startsWith("inspect:")
    )).toEqual(FAMILIES.map((family) => `inspect:${family}:2`));
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.h264);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("publishes one typed terminal failure when every witnessed output mismatches", async () => {
    requireWitnesses(FAMILIES, 2);
    for (const family of FAMILIES) startup.semanticMismatches.add(family);
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected startup rejection");
    expect(outcome.error).toBe(harness.terminal);
    expect(startup.opens).toEqual(FAMILIES);
    expect(startup.disposals).toEqual(FAMILIES);
    expect(harness.publications.playbackFailures).toEqual([
      "worker-decode-failure:prepare"
    ]);
  });

  it.each([
    ["RGBA materializer", "rgba", "renderer-failure:prepare"],
    ["renderer", "renderer", "renderer-failure:prepare"],
    ["frame identity", "identity", "renderer-failure:prepare"],
    ["RGBA storage", "storage", "worker-decode-failure:prepare"],
    ["decoder transport", "transport", "worker-decode-failure:prepare"]
  ] as const)("keeps a %s qualification failure terminal", async (
    _label,
    failure,
    publicFailure
  ) => {
    requireWitnesses(["av1"], 2);
    if (failure === "rgba") startup.rgbaCopyFailures.add("av1");
    else if (failure === "renderer") startup.rendererFailures.add("av1");
    else if (failure === "identity") startup.identityFailures.add("av1");
    else if (failure === "storage") startup.storageFailures.add("av1");
    else startup.outcomes.set("av1", "transport-error");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([publicFailure]);
  });

  it("does not decode or inspect a qualification frame for valid opaque output", async () => {
    const harness = createHarness(["av1"]);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    expect(startup.operations.some((operation) =>
      operation.startsWith("inspect:") || operation.startsWith("lane-take:av1:1:")
    )).toBe(false);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.av1);
    await player.dispose();
  });

  it("cancels a high-index qualification candidate on abort without trying VP9", async () => {
    requireWitnesses(["av1"], 17);
    startup.pendingQualificationTakes.set("av1", 13);
    const controller = new AbortController();
    const harness = createHarness(FAMILIES, controller);
    const attempt = prepareAttempt(harness.input);
    await eventually(() => startup.operations.includes("lane-take:av1:1:13"));
    const reason = new DOMException("source generation replaced", "AbortError");

    controller.abort(reason);
    const outcome = await attempt;

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected startup rejection");
    expect(outcome.error).toBe(reason);
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.operations).toContain("run-close:av1:1");
    expect(harness.publications.playbackFailures).toEqual([]);
  });

  it("falls through a positive AV1 probe with invalid output to VP9", async () => {
    startup.outcomes.set("av1", "invalid-output");
    const harness = createHarness(["av1", "vp9", "h265", "h264"]);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    if (outcome.status !== "fulfilled") throw outcome.error;
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(player.snapshot(false).decoderDiagnostics).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        codec: CODECS.av1,
        phase: "output-validation",
        code: "invalid-output"
      })
    ]);
    expect(harness.publications.metadata).toEqual(["vp9"]);
    expect(harness.publications.readiness).toEqual([
      "metadataReady",
      "visualReady",
      "interactiveReady"
    ]);
    expect(harness.publications.draws).toBe(1);
    expect(harness.publications.playbackFailures).toEqual([]);
    expect(outcome.result.report.candidates.map((candidate) => ({
      rank: candidate.rank,
      outcome: candidate.outcome,
      code: candidate.failure?.code ?? null
    }))).toEqual([
      { rank: 0, outcome: "rejected", code: "worker-decode-failure" },
      { rank: 1, outcome: "selected", code: null }
    ]);
    const vp9Open = startup.operations.indexOf("asset-open:vp9");
    expect(startup.operations.indexOf("decoder-dispose:av1")).toBeLessThan(vp9Open);
    expect(startup.operations.indexOf("renderer-dispose:av1")).toBeLessThan(vp9Open);
    expect(startup.operations.indexOf("asset-dispose:av1")).toBeLessThan(vp9Open);
    await player.dispose();
  });

  it("falls through AV1 invalid output and a VP9 EncodingError to HEVC", async () => {
    startup.outcomes.set("av1", "invalid-output");
    startup.outcomes.set("vp9", "encoding-error");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    if (outcome.status !== "fulfilled") throw outcome.error;
    expect(startup.opens).toEqual(["av1", "vp9", "h265"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.h265);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("keeps Safari HEVC selected after repairing a zero frame duration", async () => {
    startup.outcomes.set("av1", "probe-unsupported-false");
    startup.outcomes.set("vp9", "probe-unsupported-false");
    startup.actualDecoderFamilies.add("h265");
    const safari = installSafariZeroDurationDecoder();
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    if (outcome.status !== "fulfilled") throw outcome.error;
    expect(startup.opens).toEqual(["av1", "vp9", "h265"]);
    expect(startup.opens).not.toContain("h264");
    const snapshot = player.snapshot(false);
    expect(snapshot.selectedCodec).toBe(CODECS.h265);
    expect(snapshot.decoderDiagnostics.filter(({ codec }) =>
      codec === CODECS.h265
    )).toEqual([]);
    expect(safari.repairedDurations.length).toBeGreaterThan(0);
    expect(safari.repairedDurations.every((duration) => duration === 33_333))
      .toBe(true);
    expect(safari.missingDurationFrames).toHaveLength(
      safari.repairedDurations.length
    );
    expect(safari.missingDurationFrames.every(({ closed }) => closed)).toBe(true);
    expect(harness.publications.metadata).toEqual(["h265"]);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("advances on retained unsupported-config evidence", async () => {
    startup.outcomes.set("av1", "unsupported-config");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it.each([
    ["configure NotSupportedError", "configure-not-supported"],
    ["decode NotSupportedError", "decode-not-supported"],
    ["decode EncodingError", "decode-encoding-rejected"],
    ["flush NotSupportedError", "flush-not-supported"],
    ["flush EncodingError", "flush-encoding-rejected"]
  ] as const)("advances on the closed %s variant", async (_label, failure) => {
    startup.outcomes.set("av1", failure);
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("advances when the decoder support echo rejects the candidate config", async () => {
    startup.outcomes.set("av1", "probe-unsupported-config");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    if (outcome.status !== "fulfilled") throw outcome.error;
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    const diagnostics = player.snapshot(false).decoderDiagnostics;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceIndex: 0,
        codec: CODECS.av1,
        phase: "probe",
        code: "unsupported-config"
      })
    ]));
    expect(outcome.result.report.candidates.map((candidate) => ({
      rank: candidate.rank,
      outcome: candidate.outcome,
      code: candidate.failure?.code ?? null
    }))).toEqual([
      { rank: 0, outcome: "rejected", code: "unsupported-profile" },
      { rank: 1, outcome: "selected", code: null }
    ]);
    const vp9Open = startup.operations.indexOf("asset-open:vp9");
    expect(startup.operations.indexOf("decoder-dispose:av1")).toBeLessThan(vp9Open);
    expect(startup.operations.indexOf("asset-dispose:av1")).toBeLessThan(vp9Open);
    await player.dispose();
  });

  it.each([
    ["NotSupportedError", "probe-not-supported"],
    ["EncodingError", "probe-encoding-error"]
  ] as const)("advances on a probe %s for the current candidate", async (
    _name,
    probeOutcome
  ) => {
    startup.outcomes.set("av1", probeOutcome);
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("advances after a silent AV1 support probe times out", async () => {
    vi.useFakeTimers();
    startup.outcomes.set("av1", "probe-progress-timeout");
    const families = ["av1", "vp9"] as const;
    const harness = createHarness(families);
    const attempt = prepareAttempt({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(families.length)
    });

    await vi.advanceTimersByTimeAsync(DECODER_PROGRESS_TIMEOUT_MS - 1);
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await attempt;

    const player = requirePrepared(outcome);
    if (outcome.status !== "fulfilled") throw outcome.error;
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(player.snapshot(false).decoderDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIndex: 0,
          codec: CODECS.av1,
          phase: "probe",
          code: "watchdog-timeout"
        })
      ])
    );
    expect(outcome.result.report.candidates.map((candidate) => ({
      rank: candidate.rank,
      outcome: candidate.outcome,
      code: candidate.failure?.code ?? null
    }))).toEqual([
      { rank: 0, outcome: "rejected", code: "unsupported-profile" },
      { rank: 1, outcome: "selected", code: null }
    ]);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it.each([
    ["transport", "probe-transport-error"],
    ["arbitrary", "probe-arbitrary-error"]
  ] as const)("keeps a %s probe failure terminal", async (_name, probeOutcome) => {
    startup.outcomes.set("av1", probeOutcome);
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([
      "readiness-failure:prepare"
    ]);
  });

  it.each([
    [
      "a false support result",
      ["probe-supported-then-transport", "probe-unsupported-false"]
    ],
    [
      "a rejected support probe",
      ["probe-unsupported-config", "probe-transport-error"]
    ]
  ] as const)("keeps mixed-lane transport terminal after %s", async (
    _name,
    probeOutcomes
  ) => {
    startup.probeOutcomes.set("av1", probeOutcomes);
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toHaveLength(1);
  });

  it("keeps mixed runtime invalid-output and transport evidence terminal", async () => {
    startup.outcomes.set("av1", "invalid-output");
    startup.mixedRuntimeTransportFailures.add("av1");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toHaveLength(1);
  });

  it("keeps retryable renderer evidence terminal when decoder transport also failed", async () => {
    startup.rgbaCopyFailures.add("av1");
    startup.mixedRendererTransportFailures.add("av1");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toHaveLength(1);
  });

  it("keeps an unavailable AV1 RGBA materializer path terminal", async () => {
    startup.rgbaCopyFailures.add("av1");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([
      "renderer-failure:prepare"
    ]);
  });

  it("qualifies without publishing or scheduling until publication", async () => {
    let published = false;
    vi.stubGlobal("requestAnimationFrame", () => {
      if (!published) throw new Error("playback scheduled before publication");
      return 1;
    });
    const harness = createHarness(["av1"]);

    const player = await createPlayer(harness.input);

    expect(harness.publications.readiness).toEqual([]);
    player.activate({ publish: false });
    expect(harness.publications.readiness).toEqual([]);
    published = true;
    player.publish();
    expect(harness.publications.readiness).toEqual([
      "metadataReady",
      "visualReady",
      "interactiveReady"
    ]);
    await player.dispose();
  });

  it("suppresses provisional animated publications after pre-publication reduction", async () => {
    const harness = createHarness(["av1"]);
    const player = await createPlayer(harness.input);

    player.activate({ publish: false });
    await player.setMotion("reduce", true);
    player.publish();

    expect(harness.publications.metadata).toEqual(["av1"]);
    expect(harness.publications.readiness).toEqual([
      "metadataReady",
      "staticReady"
    ]);
    expect(harness.publications.draws).toBe(0);
    expect(await player.prepare()).toMatchObject({
      mode: "static",
      reason: "reduced-motion"
    });
    await player.dispose();
  });

  it("suppresses provisional animated publications after pre-publication suspension", async () => {
    const harness = createHarness(["av1"]);
    const player = await createPlayer(harness.input);

    player.activate({ publish: false });
    await player.suspend("visibility-suspended");
    player.publish();

    expect(harness.publications.metadata).toEqual(["av1"]);
    expect(harness.publications.readiness).toEqual([
      "metadataReady",
      "staticReady"
    ]);
    expect(harness.publications.draws).toBe(0);
    await player.dispose();
  });

  it("releases the total deadline listener when a qualified player is disposed", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const harness = createHarness(["av1"], controller);
    const player = await createPlayer(harness.input);

    await player.dispose();

    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function)
    );
  });

  it("does not publish stale readiness when an unpublished winner fails", async () => {
    const harness = createHarness(["av1"]);
    const player = await createPlayer(harness.input);

    player.activate({ publish: false });
    failLiveDecoder("av1");
    await eventually(() => harness.publications.playbackFailures.length === 1);
    player.publish();

    expect(harness.publications.metadata).toEqual([]);
    expect(harness.publications.readiness).toEqual([]);
    expect(harness.publications.draws).toBe(0);
    expect(harness.publications.playbackFailures).toEqual([
      "worker-decode-failure:playback"
    ]);
    await player.dispose();
  });

  it("does not reuse AV1 qualification evidence for a VP9 transport failure", async () => {
    startup.outcomes.set("av1", "invalid-output");
    startup.outcomes.set("vp9", "transport-error");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(startup.disposals).toEqual(["av1", "vp9"]);
    expect(harness.publications.playbackFailures).toEqual([
      "worker-decode-failure:prepare"
    ]);
  });

  it("uses H264 only after AV1, VP9, and HEVC fail startup qualification", async () => {
    startup.outcomes.set("av1", "invalid-output");
    startup.outcomes.set("vp9", "invalid-output");
    startup.outcomes.set("h265", "invalid-output");
    const harness = createHarness(["av1", "vp9", "h265", "h264"]);

    const outcome = await prepareAttempt(harness.input);

    const player = requirePrepared(outcome);
    if (outcome.status !== "fulfilled") throw outcome.error;
    expect(startup.opens).toEqual(["av1", "vp9", "h265", "h264"]);
    expect(startup.disposals).toEqual(["av1", "vp9", "h265"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.h264);
    expect(harness.publications.metadata).toEqual(["h264"]);
    expect(harness.publications.readiness).toEqual([
      "metadataReady",
      "visualReady",
      "interactiveReady"
    ]);
    expect(harness.publications.draws).toBe(1);
    expect(harness.publications.playbackFailures).toEqual([]);
    expect(outcome.result.report.candidates.map((candidate) => ({
      rank: candidate.rank,
      outcome: candidate.outcome,
      code: candidate.failure?.code ?? null
    }))).toEqual([
      { rank: 0, outcome: "rejected", code: "worker-decode-failure" },
      { rank: 1, outcome: "rejected", code: "worker-decode-failure" },
      { rank: 2, outcome: "rejected", code: "worker-decode-failure" },
      { rank: 3, outcome: "selected", code: null }
    ]);
    await player.dispose();
  });

  it("reaches H264 after three retryable decoder progress timeouts", async () => {
    vi.useFakeTimers();
    startup.outcomes.set("av1", "decode-progress-timeout");
    startup.outcomes.set("vp9", "decode-progress-timeout");
    startup.outcomes.set("h265", "decode-progress-timeout");
    const harness = createHarness(FAMILIES);
    const attempt = prepareAttempt({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(FAMILIES.length)
    });

    await vi.advanceTimersByTimeAsync(3 * DECODER_PROGRESS_TIMEOUT_MS);
    const outcome = await attempt;

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(FAMILIES);
    expect(startup.disposals).toEqual(FAMILIES.slice(0, 3));
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.h264);
    expect(outcome.status === "fulfilled" &&
      outcome.result.report.candidates.map((candidate) =>
        candidate.failure?.code ?? null
      )).toEqual([
      "worker-decode-failure",
      "worker-decode-failure",
      "worker-decode-failure",
      null
    ]);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("starts each qualification timeout after asynchronous candidate setup", async () => {
    vi.useFakeTimers();
    startup.outcomes.set("av1", "decode-progress-timeout");
    const families = ["av1", "vp9"] as const;
    const harness = createHarness(families);
    let candidateOrdinal = 0;
    const attempt = prepareAttempt({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(families.length),
      onCandidate: async () => {
        if (candidateOrdinal++ !== 0) return;
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 3_000);
        });
      }
    });

    await vi.advanceTimersByTimeAsync(3_000 + DECODER_PROGRESS_TIMEOUT_MS);
    const outcome = await attempt;

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("keeps parent cancellation live while qualification timing is deferred", async () => {
    const controller = new AbortController();
    const harness = createHarness(["av1", "vp9"], controller);
    let releaseSetup!: () => void;
    const setupBlocked = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let reportSetupStarted!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      reportSetupStarted = resolve;
    });
    const attempt = prepareAttempt({
      ...harness.input,
      onCandidate: async () => {
        reportSetupStarted();
        await setupBlocked;
      }
    });
    await setupStarted;
    const reason = new DOMException("source generation replaced", "AbortError");

    controller.abort(reason);
    releaseSetup();
    const outcome = await attempt;

    expect(outcome).toEqual({ status: "rejected", error: reason });
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([]);
  });

  it("reaches a lower-family winner after every upper-family rendition stalls", async () => {
    vi.useFakeTimers();
    startup.renditionCounts.set("av1", 4);
    startup.outcomes.set("av1", "decode-progress-timeout");
    const families = ["av1", "vp9"] as const;
    const harness = createHarness(families);
    const attempt = prepareAttempt({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(families.length)
    });

    await vi.advanceTimersByTimeAsync(4 * DECODER_PROGRESS_TIMEOUT_MS);
    const outcome = await attempt;

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(["av1", "av1", "av1", "av1", "vp9"]);
    expect(startup.disposals).toEqual(["av1", "av1", "av1", "av1"]);
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.vp9);
    expect(outcome.status === "fulfilled" &&
      outcome.result.report.candidates.map((candidate) =>
        candidate.failure?.code ?? null
      )).toEqual([
      "worker-decode-failure",
      "worker-decode-failure",
      "worker-decode-failure",
      "worker-decode-failure",
      null
    ]);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it("keeps the global deadline alive across repeated slow asset admissions", async () => {
    vi.useFakeTimers();
    startup.assetOpenDelayMs = ASSET_ADMISSION_TIMEOUT_MS - 1;
    for (const family of FAMILIES.slice(0, 3)) {
      startup.renditionCounts.set(family, 4);
      startup.outcomes.set(family, "decode-progress-timeout");
    }
    const harness = createHarness(FAMILIES);
    let settled = false;
    const attempt = prepareAttempt({
      ...harness.input,
      preparationTimeoutMs: playerPreparationBudgetMs(FAMILIES.length)
    }).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(74_500);
    expect(settled).toBe(false);
    expect(harness.publications.playbackFailures).toEqual([]);

    const rejectedCandidates = 3 * 4;
    const expectedElapsed =
      (rejectedCandidates + 1) * startup.assetOpenDelayMs +
      rejectedCandidates * DECODER_PROGRESS_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(expectedElapsed - 74_500);
    const outcome = await attempt;

    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual([
      ...Array.from({ length: 4 }, () => "av1"),
      ...Array.from({ length: 4 }, () => "vp9"),
      ...Array.from({ length: 4 }, () => "h265"),
      "h264"
    ]);
    expect(startup.disposals).toEqual(FAMILIES.slice(0, 3).flatMap(
      (family) => Array.from({ length: 4 }, () => family)
    ));
    expect(player.snapshot(false).selectedCodec).toBe(CODECS.h264);
    expect(harness.publications.playbackFailures).toEqual([]);
    await player.dispose();
  });

  it.each([
    ["av1", []],
    ["vp9", ["av1"]],
    ["h265", ["av1", "vp9"]],
    ["h264", ["av1", "vp9", "h265"]]
  ] as const)(
    "never touches a candidate after the %s winner",
    async (winner, rejected) => {
      for (const family of rejected) startup.outcomes.set(family, "invalid-output");
      const harness = createHarness(FAMILIES);

      const outcome = await prepareAttempt(harness.input);

      const player = requirePrepared(outcome);
      const winnerIndex = FAMILIES.indexOf(winner);
      const touched = FAMILIES.slice(0, winnerIndex + 1);
      expect(startup.opens).toEqual(touched);
      expect(player.snapshot(false).selectedCodec).toBe(CODECS[winner]);
      for (const family of FAMILIES.slice(winnerIndex + 1)) {
        expect(startup.operations.some((operation) =>
          operation.endsWith(`:${family}`)
        )).toBe(false);
      }
      await player.dispose();
    }
  );

  it("publishes one canonical terminal error after every candidate fails", async () => {
    for (const family of FAMILIES) {
      startup.outcomes.set(family, "invalid-output");
    }
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected startup rejection");
    expect(outcome.error).toBe(harness.terminal);
    expect(startup.opens).toEqual(FAMILIES);
    expect(startup.disposals).toEqual(FAMILIES);
    expect(harness.publications.metadata).toEqual([]);
    expect(harness.publications.readiness).toEqual([]);
    expect(harness.publications.draws).toBe(0);
    expect(harness.publications.playbackFailures).toEqual([
      "worker-decode-failure:prepare"
    ]);
  });

  it("does not traverse sources after a non-codec renderer failure", async () => {
    startup.rendererFailures.add("av1");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([
      "renderer-failure:prepare"
    ]);
  });

  it("keeps a post-qualification renderer failure terminal", async () => {
    const harness = createHarness(FAMILIES);
    const outcome = await prepareAttempt(harness.input);
    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(["av1"]);

    startup.resizeFailures.add("av1");
    player.resize(32, 32, 1, "contain");
    await eventually(() => harness.publications.playbackFailures.length === 1);

    expect(startup.opens).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([
      "renderer-failure:resize"
    ]);
    await player.dispose();
  });

  it("surfaces candidate resize failure before qualification can succeed", async () => {
    startup.resizeFailures.add("av1");
    const harness = createHarness(FAMILIES);
    const input = {
      ...harness.input,
      onCandidate: async (player: Awaited<ReturnType<typeof createPlayer>>) => {
        player.activate({ publish: false });
        player.resize(32, 32, 1, "contain");
      }
    };

    const outcome = await prepareAttempt(input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(harness.publications.metadata).toEqual([]);
    expect(harness.publications.readiness).toEqual([]);
    expect(harness.publications.draws).toBe(0);
    expect(harness.publications.playbackFailures).toEqual([
      "renderer-failure:prepare"
    ]);
  });

  it("does not traverse sources when failed-candidate cleanup is incomplete", async () => {
    startup.outcomes.set("av1", "invalid-output");
    startup.cleanupFailures.add("av1");
    const harness = createHarness(FAMILIES);

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(startup.disposals.every((codec) => codec === "av1")).toBe(true);
    expect(startup.disposals.length).toBeGreaterThan(0);
    expect(harness.publications.playbackFailures).toHaveLength(1);
  });

  it("disposes a rejected candidate even when its diagnostic snapshot throws", async () => {
    startup.outcomes.set("av1", "invalid-output");
    startup.snapshotFailures.add("av1");
    const harness = createHarness(FAMILIES);
    const removeListener = vi.spyOn(harness.input.canvas, "removeEventListener");

    const outcome = await prepareAttempt(harness.input);

    expect(outcome.status).toBe("rejected");
    expect(startup.opens).toEqual(["av1"]);
    expect(removeListener.mock.calls.filter(([type]) =>
      type === "webglcontextrestored"
    )).toHaveLength(0);
    expect(harness.publications.playbackFailures).toEqual([
      "renderer-failure:prepare"
    ]);
  });

  it("does not traverse sources after an abort during provisional readiness", async () => {
    startup.outcomes.set("av1", "pending");
    const controller = new AbortController();
    const harness = createHarness(FAMILIES, controller);
    const attempt = prepareAttempt(harness.input);
    await eventually(() => startup.operations.includes("run:av1"));
    const reason = new DOMException("source generation replaced", "AbortError");

    controller.abort(reason);
    // Unblock the synthetic decoder after cancellation, as a real worker would
    // settle its in-flight run while the owning generation retires.
    failLiveDecoder("av1");
    const outcome = await attempt;

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected startup rejection");
    expect(outcome.error).toBe(reason);
    expect(startup.opens).toEqual(["av1"]);
    expect(harness.publications.playbackFailures).toEqual([]);
  });

  it("does not hot-switch sources after a qualified player later fails", async () => {
    startup.outcomes.set("av1", "invalid-output");
    const harness = createHarness(FAMILIES);
    const outcome = await prepareAttempt(harness.input);
    const player = requirePrepared(outcome);
    expect(startup.opens).toEqual(["av1", "vp9"]);

    failLiveDecoder("vp9");
    await eventually(() => harness.publications.playbackFailures.length === 1);

    await expect(player.prepare()).rejects.toBe(harness.terminal);
    expect(startup.opens).toEqual(["av1", "vp9"]);
    expect(harness.publications.playbackFailures).toEqual([
      "worker-decode-failure:playback"
    ]);
    await player.dispose();
  });

});
