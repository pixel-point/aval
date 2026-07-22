import type {
  AvalElement,
  AvalElementAttributes,
  AvalElementEventMap,
  AvalDecoderDiagnostic,
  AvalErrorDetail,
  AvalFit,
  AvalPublicFailure,
  AvalPlaybackLifecycleCounters,
  AvalReadinessChangeDetail,
  AvalRendererDiagnostic,
  AvalSourceCodec,
  StaticReason
} from "@pixel-point/aval-element";
import {
  AvalPlaybackError,
  ELEMENT_DECODER_CAPACITY,
  SOURCE_CODEC_PRIORITY
} from "@pixel-point/aval-element";

declare const element: AvalElement;
declare const detail: Readonly<AvalErrorDetail>;
declare const readinessDetail: Readonly<AvalReadinessChangeDetail>;
declare const playbackError: AvalPlaybackError;
declare const events: AvalElementEventMap;
declare const decoderDiagnostic: Readonly<AvalDecoderDiagnostic>;
declare const rendererDiagnostic: Readonly<AvalRendererDiagnostic>;

const decoderWorkers: 2 = ELEMENT_DECODER_CAPACITY.workerCount;
void decoderWorkers;
const preferredCodec: AvalSourceCodec = SOURCE_CODEC_PRIORITY[0]!;
void preferredCodec;

element.motion = "auto";
element.autoplay = "manual";
element.fit = "cover" satisfies AvalFit;
element.state = "author.state";
void element.prepare({ timeoutMs: 1_000 });
void element.setState("author.state");
element.send("author.event");
element.readyFor("author.state");
element.pause();
void element.resume();
element.getDiagnostics({ trace: true });
const diagnostics = element.getDiagnostics();
const retainedDecoderDiagnostics: readonly Readonly<AvalDecoderDiagnostic>[] =
  diagnostics.runtime.decoderDiagnostics;
void retainedDecoderDiagnostics;
const lifecycle: Readonly<AvalPlaybackLifecycleCounters> =
  diagnostics.runtime.playbackLifecycle;
void lifecycle.nativeDecoderCreatesByLane[0];
void decoderDiagnostic.sourceGeneration;
void decoderDiagnostic.exception?.message;
const activeRendererBackend: "webgl2" | "canvas2d" | null =
  diagnostics.runtime.rendererBackend;
const failedRendererBackend: "webgl2" | "canvas2d" =
  rendererDiagnostic.backend;
void activeRendererBackend;
void failedRendererBackend;

const attributes: AvalElementAttributes = {
  motion: "reduce",
  autoplay: "visible",
  fit: "contain",
  state: "idle",
  width: 128
};
void attributes;
// @ts-expect-error source children are the sole source authority
element.src = "/motion.avl";
// @ts-expect-error integrity belongs to each direct source child
element.integrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
void detail.failure.code;
const readinessReason: StaticReason | undefined = readinessDetail.reason;
void readinessReason;
void playbackError.failure.code;
void playbackError.failure.operation;
void playbackError.generation;
// @ts-expect-error fallback presentation is owned by the consumer
void events.fallback;

async function narrowPlaybackFailure(work: Promise<void>): Promise<AvalPublicFailure | null> {
  try {
    await work;
    return null;
  } catch (error: unknown) {
    // @ts-expect-error rejected values must be narrowed before inspecting failure
    void error.failure.code;
    if (error instanceof AvalPlaybackError) {
      return error.failure;
    }
    throw error;
  }
}
void narrowPlaybackFailure(Promise.resolve());

// @ts-expect-error motion is a closed union
element.motion = "sometimes";
// @ts-expect-error staged properties are read-only
element.visualState = "forged";
// @ts-expect-error immutable failure detail
detail.fatal = false;
// @ts-expect-error playback failure is immutable
playbackError.failure = detail.failure;
// @ts-expect-error playback generation is immutable
playbackError.generation = 9;
// @ts-expect-error public failure code is immutable
playbackError.failure.code = "renderer-failure";
// @ts-expect-error public failure operation is immutable
playbackError.failure.operation = null;
// @ts-expect-error decoder diagnostics are immutable
decoderDiagnostic.sourceGeneration = 7;
// @ts-expect-error nested decoder exception evidence is immutable
decoderDiagnostic.exception!.message = "forged";
// @ts-expect-error renderer failure backend evidence is immutable
rendererDiagnostic.backend = "canvas2d";
// @ts-expect-error playback lifecycle counters are immutable
lifecycle.drawsCompleted = 7;
// @ts-expect-error playback decoder lane tuples are immutable
lifecycle.nativeDecoderCreatesByLane[0] = 7;
// @ts-expect-error fit is closed
const badFit: AvalFit = "scale-down";
void badFit;
