import {
  decodedOutputIncompatibleCandidateOutcome,
  retryableCandidateOutcome,
  type ProvisionalCandidateOutcome,
  type RetryableCandidateRejection
} from "./provisional-candidate-outcome.js";
import type {
  CompiledManifest as Manifest,
  PackedAlphaWitnessV1
} from "@pixel-point/aval-format";
import { qualifyDecodedPackedAlphaOutput } from
  "./decoded-output-qualifier.js";
import type { DecoderPoolCandidate } from "./decoder-pool.js";
import type { RendererFrameInspector } from "./renderer-contract.js";
import type { RenderLayout } from "./renderer-geometry.js";

export interface ProvisionalDecodedFrame {
  readonly frame: VideoFrame;
  readonly unit: string;
  readonly localFrame: number;
}

export interface ProvisionalOutputQualificationInput {
  readonly manifest: Readonly<Manifest>;
  readonly renditionId: string;
  readonly layout: Readonly<RenderLayout>;
  readonly withDecodedFrame: (
    unit: string,
    localFrame: number,
    use: (decoded: Readonly<ProvisionalDecodedFrame>) => Promise<void>
  ) => Promise<void>;
  readonly inspectAndPrime: (
    frame: VideoFrame,
    inspect: RendererFrameInspector
  ) => Promise<void>;
}

export class UnsupportedPlaybackProfileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}

type ProvisionalFrameCandidate = Readonly<
  Pick<DecoderPoolCandidate, "unitId" | "cancel"> & {
    readonly run: Readonly<Pick<
      DecoderPoolCandidate["run"],
      "frameCount" | "take" | "release"
    >>;
  }
>;

export interface ProvisionalCandidateFrameInput {
  readonly candidate: ProvisionalFrameCandidate;
  readonly localFrame: number;
  readonly signal: AbortSignal;
  readonly use: (
    decoded: Readonly<ProvisionalDecodedFrame>
  ) => Promise<void>;
}

/** Drains one discardable decoder run through an exact witnessed frame. */
export async function withProvisionalCandidateFrame(
  input: Readonly<ProvisionalCandidateFrameInput>
): Promise<void> {
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    input.candidate.cancel();
  };
  try {
    if (
      typeof input.candidate.unitId !== "string" ||
      input.candidate.unitId.length === 0 ||
      !Number.isSafeInteger(input.candidate.run.frameCount) ||
      input.candidate.run.frameCount < 1 ||
      !Number.isSafeInteger(input.localFrame) || input.localFrame < 0 ||
      input.localFrame >= input.candidate.run.frameCount
    ) throw new RangeError("provisional witness frame identity is invalid");
    input.signal.throwIfAborted();
    input.signal.addEventListener("abort", cancel, { once: true });
    try {
      for (let index = 0; index <= input.localFrame; index += 1) {
        input.signal.throwIfAborted();
        const frame = await input.candidate.run.take(index);
        try {
          input.signal.throwIfAborted();
          if (index === input.localFrame) {
            await input.use(Object.freeze({
              frame,
              unit: input.candidate.unitId,
              localFrame: index
            }));
          }
        } finally {
          input.candidate.run.release(frame);
        }
      }
    } finally {
      input.signal.removeEventListener("abort", cancel);
    }
  } finally {
    cancel();
  }
}

/** Qualifies one exact packed-alpha witness frame without owning publication. */
export async function qualifyProvisionalOutput(
  input: Readonly<ProvisionalOutputQualificationInput>
): Promise<void> {
  const witness = outputWitness(input.manifest, input.renditionId);
  if (witness === null) return;
  await input.withDecodedFrame(
    witness.unit,
    witness.frame,
    async (decoded) => input.inspectAndPrime(
      decoded.frame,
      (source) => qualifyDecodedPackedAlphaOutput({
        unit: decoded.unit,
        localFrame: decoded.localFrame,
        layout: input.layout,
        witness,
        source
      })
    )
  );
}

export interface ProvisionalCandidateRetirement {
  readonly retryAllowed: boolean;
}

export interface ProvisionalCandidateOrchestrator<T> {
  next(): Promise<T>;
  qualify(candidate: T): Promise<void>;
  localFailure(candidate: T): unknown;
  retire(candidate: T): Promise<Readonly<ProvisionalCandidateRetirement>>;
  cancelled(): boolean;
  selected(candidate: T): void;
  rejected(candidate: T, rejection: Readonly<RetryableCandidateRejection>): void;
}

/** Owns provisional qualification, retirement, and retry publication ordering. */
export async function orchestrateProvisionalCandidates<T>(
  input: Readonly<ProvisionalCandidateOrchestrator<T>>
): Promise<T> {
  for (;;) {
    const candidate = await input.next();
    const outcome = await qualifyCandidate(input, candidate);
    switch (outcome.kind) {
      case "selected":
        return outcome.value;
      case "retryable-rejection":
        input.rejected(candidate, outcome.rejection);
        break;
      default:
        return unreachableOutcome(outcome);
    }
  }
}

async function qualifyCandidate<T>(
  input: Readonly<ProvisionalCandidateOrchestrator<T>>,
  candidate: T
): Promise<Readonly<ProvisionalCandidateOutcome<T>>> {
  try {
    await input.qualify(candidate);
    input.selected(candidate);
    return Object.freeze({ kind: "selected", value: candidate });
  } catch (error) {
    const localFailure = input.localFailure(candidate) ?? error;
    const retirement = await input.retire(candidate);
    if (input.cancelled() || !retirement.retryAllowed) throw error;
    const outcome = decodedOutputIncompatibleCandidateOutcome(localFailure) ??
      retryableCandidateOutcome(localFailure);
    if (outcome === null) throw error;
    return outcome;
  }
}

function outputWitness(
  manifest: Readonly<Manifest>,
  renditionId: string
): Readonly<PackedAlphaWitnessV1> | null {
  const rendition = manifest.renditions.find(({ id }) => id === renditionId);
  if (rendition === undefined) return invalidAsset();
  if (manifest.layout === "opaque") {
    return null;
  }
  if (rendition.outputQualification === undefined) return invalidAsset();
  return rendition.outputQualification;
}

function invalidAsset(): never {
  throw new Error("Invalid AVAL asset");
}

function unreachableOutcome(outcome: never): never {
  throw new Error(`unreachable provisional outcome ${String(outcome)}`);
}
