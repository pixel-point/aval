import type {
  AvalElement,
  AvalElementAttributes,
  AvalElementEventMap,
  AvalDecoderDiagnostic,
  AvalErrorDetail,
  AvalFit,
  AvalPublicFailure,
  AvalReadinessChangeDetail,
  AvalSourceCandidate,
  StaticReason
} from "@pixel-point/aval-element";
import {
  AvalPlaybackError,
  ELEMENT_DECODER_CAPACITY
} from "@pixel-point/aval-element";

declare const element: AvalElement;
declare const detail: Readonly<AvalErrorDetail>;
declare const readinessDetail: Readonly<AvalReadinessChangeDetail>;
declare const playbackError: AvalPlaybackError;
declare const events: AvalElementEventMap;
declare const decoderDiagnostic: Readonly<AvalDecoderDiagnostic>;

const decoderWorkers: 2 = ELEMENT_DECODER_CAPACITY.workerCount;
void decoderWorkers;

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
void decoderDiagnostic.sourceGeneration;
void decoderDiagnostic.exception?.message;

const attributes: AvalElementAttributes = {
  motion: "reduce",
  autoplay: "visible",
  fit: "contain",
  state: "idle",
  width: 128
};
void attributes;
const sourceCandidate: AvalSourceCandidate = {
  src: "/motion.av1.avl",
  type: 'application/vnd.aval; codecs="av01.0.08M.10"',
  codec: "av01.0.08M.10",
  integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
};
void sourceCandidate;

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
// @ts-expect-error fit is closed
const badFit: AvalFit = "scale-down";
void badFit;
