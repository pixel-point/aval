import {
  decodedOutputIncompatibleCandidateOutcome,
  retryableCandidateOutcome,
  type ProvisionalCandidateOutcome,
  type RetryableCandidateRejection
} from "./provisional-candidate-outcome.js";
import type {
  Manifest,
  PackedAlphaWitnessV1
} from "./asset.js";
import { qualifyDecodedPackedAlphaOutput } from
  "./decoded-output-qualifier.js";
import type { RgbaFrameReference } from "./rgba-materializer.js";
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
    inspect: (source: Readonly<RgbaFrameReference>) => Promise<void>
  ) => Promise<void>;
}

export class UnsupportedPlaybackProfileError extends Error {
  public constructor() {
    super("legacy packed-alpha output is outside the qualified playback profile");
    this.name = "NotSupportedError";
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
      async (source) => qualifyDecodedPackedAlphaOutput({
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
  if (manifest.layout === "opaque") {
    if (!manifest.renditions.some(({ id }) => id === renditionId)) invalidAsset();
    return null;
  }
  if (manifest.formatVersion === "1.0") {
    if (!manifest.renditions.some(({ id }) => id === renditionId)) invalidAsset();
    throw new UnsupportedPlaybackProfileError();
  }
  const rendition = manifest.renditions.find(({ id }) => id === renditionId);
  if (rendition === undefined) return invalidAsset();
  return rendition.outputQualification;
}

function invalidAsset(): never {
  throw new Error("Invalid AVAL asset");
}

function unreachableOutcome(outcome: never): never {
  throw new Error(`unreachable provisional outcome ${String(outcome)}`);
}
