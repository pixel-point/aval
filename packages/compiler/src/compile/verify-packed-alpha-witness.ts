import {
  PACKED_ALPHA_WITNESS_MAX_REFERENCE_DELTA,
  PACKED_ALPHA_WITNESS_MAX_SAMPLES,
  type PackedAlphaWitnessSampleV1,
  type PackedAlphaWitnessV1,
  type VideoCodec
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";
import { mediaTimeout } from "../ffmpeg/encode-unit.js";
import { serializeIvf } from "../ffmpeg/ivf.js";
import {
  MAX_PROCESS_STDERR_BYTES,
  type Rational
} from "../model.js";
import { runBoundedProcess } from "../process-runner.js";
import type { PreparedEncodingRendition } from "./project-encoding-compiler.js";
import {
  PACKED_ALPHA_WITNESS_SEPARATED_ALPHA_DELTA,
  type PackedAlphaWitnessCandidate,
  type PackedAlphaWitnessCandidateSelection
} from "./packed-alpha-witness.js";

const RGBA_CHANNELS = 4;
const UINT8_MAXIMUM = 255;

export interface VerifyPackedAlphaWitnessInput {
  readonly codec: VideoCodec;
  readonly frameRate: Readonly<Rational>;
  readonly rendition: Readonly<PreparedEncodingRendition>;
  readonly selection: Readonly<PackedAlphaWitnessCandidateSelection>;
  readonly executable: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface VerifyPackedAlphaWitnessInvocation {
  readonly arguments: readonly string[];
  readonly stdin: Uint8Array;
  readonly outputWidth: number;
  readonly outputHeight: number;
}

export interface VerifiedPackedAlphaWitness {
  readonly witness: Readonly<PackedAlphaWitnessV1>;
  readonly invocationArguments: readonly string[];
}

/** Decode the selected exact encoded unit and bind its sampled output to source alpha. */
export async function verifyPackedAlphaWitness(
  input: Readonly<VerifyPackedAlphaWitnessInput>
): Promise<Readonly<VerifiedPackedAlphaWitness>> {
  const invocation = createVerifyPackedAlphaWitnessInvocation(input);
  const outputBytes = checkedProduct(
    invocation.outputWidth,
    invocation.outputHeight,
    RGBA_CHANNELS
  );
  const result = await runBoundedProcess({
    executable: input.executable,
    arguments: invocation.arguments,
    cwd: process.cwd(),
    stdin: invocation.stdin,
    limits: {
      maxStdoutBytes: outputBytes,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES,
      ...(input.timeoutMs === undefined
        ? {}
        : { timeoutMs: mediaTimeout(input.timeoutMs) })
    },
    expectedStdoutBytes: outputBytes,
    privateWorkingDirectory: true,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const alphaRect = input.rendition.geometry.visibleAlphaRect!;
  const emitted = input.selection.candidates.map(({ x, y }) => {
    const sampleX = alphaRect[0] + x;
    const sampleY = alphaRect[1] + y;
    return result.stdout[
      (sampleY * invocation.outputWidth + sampleX) * RGBA_CHANNELS
    ]!;
  });
  return Object.freeze({
    witness: qualifyPackedAlphaWitnessCandidates(input.selection, emitted),
    invocationArguments: invocation.arguments
  });
}

/** Own the exact shell-free invocation and unchanged encoded verification bytes. */
export function createVerifyPackedAlphaWitnessInvocation(
  input: Readonly<VerifyPackedAlphaWitnessInput>
): Readonly<VerifyPackedAlphaWitnessInvocation> {
  validateSelection(input.selection);
  const geometry = input.rendition.geometry;
  const alphaRect = geometry.visibleAlphaRect;
  if (geometry.layout !== "packed-alpha" || alphaRect === undefined) {
    throw invalid("Packed-alpha verification requires a packed rendition geometry");
  }
  const [decodedX, decodedY, outputWidth, outputHeight] = geometry.decodedStorageRect;
  if (
    decodedX !== 0 ||
    decodedY !== 0 ||
    alphaRect[0] < 0 ||
    alphaRect[1] < 0 ||
    alphaRect[0] + alphaRect[2] > outputWidth ||
    alphaRect[1] + alphaRect[3] > outputHeight
  ) {
    throw invalid("Packed-alpha verification geometry is not addressable");
  }
  if (input.selection.candidates.some(({ x, y }) =>
    x >= alphaRect[2] || y >= alphaRect[3]
  )) {
    throw invalid("Packed-alpha witness candidate lies outside the visible alpha pane");
  }
  const unit = input.rendition.units.find(({ id }) => id === input.selection.unit);
  if (unit === undefined || unit.chunks.length < 1) {
    throw invalid("Packed-alpha verification unit is missing encoded chunks");
  }
  const displayedFrames = unit.chunks.reduce(
    (total, chunk) => checkedAdd(total, chunk.displayedFrameCount),
    0
  );
  if (input.selection.frame >= displayedFrames) {
    throw invalid("Packed-alpha verification frame is outside its encoded unit");
  }
  const stdin = input.codec === "vp9" || input.codec === "av1"
    ? serializeIvf({
        codec: input.codec,
        width: geometry.codedWidth,
        height: geometry.codedHeight,
        timeBase: {
          numerator: input.frameRate.denominator,
          denominator: input.frameRate.numerator
        },
        frames: unit.chunks.map(({ bytes, presentationTimestamp }) =>
          Object.freeze({ bytes, timestamp: presentationTimestamp })
        )
      })
    : concatenateChunks(unit.chunks);
  const inputFormat = input.codec === "vp9" || input.codec === "av1"
    ? "ivf"
    : input.codec === "h265"
      ? "hevc"
      : "h264";
  return Object.freeze({
    arguments: Object.freeze([
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-xerror",
      "-protocol_whitelist", "pipe",
      "-f", inputFormat,
      "-i", "pipe:0",
      "-map", "0:v:0",
      "-an", "-sn", "-dn",
      "-map_metadata", "-1",
      "-map_chapters", "-1",
      "-threads", "1",
      "-filter_threads", "1",
      "-vf", `select=eq(n\\,${String(input.selection.frame)}),format=rgba`,
      "-fps_mode", "passthrough",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1"
    ]),
    stdin,
    outputWidth,
    outputHeight
  });
}

/** Apply the format-owned delta and interval rules to exact emitted samples. */
export function qualifyPackedAlphaWitnessCandidates(
  selection: Readonly<PackedAlphaWitnessCandidateSelection>,
  emittedValues: readonly number[]
): Readonly<PackedAlphaWitnessV1> {
  validateSelection(selection);
  if (
    !Array.isArray(emittedValues) ||
    emittedValues.length !== selection.candidates.length ||
    emittedValues.some((value) =>
      !Number.isSafeInteger(value) || value < 0 || value > UINT8_MAXIMUM
    )
  ) {
    throw invalid("Packed-alpha emitted witness samples are invalid");
  }
  const survivors = selection.candidates.flatMap((candidate, index) => {
    const emitted = emittedValues[index]!;
    if (
      Math.abs(candidate.canonicalAlpha - emitted) >
      PACKED_ALPHA_WITNESS_MAX_REFERENCE_DELTA
    ) return [];
    return [Object.freeze({
      candidate,
      sample: witnessSample(candidate, emitted)
    })];
  });
  if (survivors.length < 1) {
    throw qualificationFailure(
      selection,
      "Encoded packed alpha produced no bounded output witness sample"
    );
  }
  if (
    selection.requiresSeparatedCoverage &&
    !hasSeparatedIntervals(survivors)
  ) {
    throw qualificationFailure(
      selection,
      "Encoded packed alpha did not retain separated witness intervals"
    );
  }
  return Object.freeze({
    kind: "packed-alpha-v1",
    unit: selection.unit,
    frame: selection.frame,
    samples: Object.freeze(survivors.map(({ sample }) => sample))
  });
}

function witnessSample(
  candidate: Readonly<PackedAlphaWitnessCandidate>,
  emitted: number
): Readonly<PackedAlphaWitnessSampleV1> {
  const lower = Math.max(
    0,
    Math.min(candidate.canonicalAlpha, emitted) -
      PACKED_ALPHA_WITNESS_MAX_REFERENCE_DELTA
  );
  const upper = Math.min(
    UINT8_MAXIMUM,
    Math.max(candidate.canonicalAlpha, emitted) +
      PACKED_ALPHA_WITNESS_MAX_REFERENCE_DELTA
  );
  return Object.freeze({
    x: candidate.x,
    y: candidate.y,
    expectedRange: Object.freeze([lower, upper] as const)
  });
}

function hasSeparatedIntervals(survivors: readonly Readonly<{
  readonly candidate: Readonly<PackedAlphaWitnessCandidate>;
  readonly sample: Readonly<PackedAlphaWitnessSampleV1>;
}>[]): boolean {
  for (let left = 0; left < survivors.length; left += 1) {
    for (let right = left + 1; right < survivors.length; right += 1) {
      const a = survivors[left]!;
      const b = survivors[right]!;
      if (
        Math.abs(a.candidate.canonicalAlpha - b.candidate.canonicalAlpha) <
        PACKED_ALPHA_WITNESS_SEPARATED_ALPHA_DELTA
      ) {
        continue;
      }
      if (
        a.sample.expectedRange[1] < b.sample.expectedRange[0] ||
        b.sample.expectedRange[1] < a.sample.expectedRange[0]
      ) return true;
    }
  }
  return false;
}

function validateSelection(
  selection: Readonly<PackedAlphaWitnessCandidateSelection>
): void {
  if (
    typeof selection !== "object" ||
    selection === null ||
    typeof selection.unit !== "string" ||
    selection.unit.length < 1 ||
    !Number.isSafeInteger(selection.frame) ||
    selection.frame < 0 ||
    typeof selection.requiresSeparatedCoverage !== "boolean" ||
    !Array.isArray(selection.candidates) ||
    selection.candidates.length < 1 ||
    selection.candidates.length > PACKED_ALPHA_WITNESS_MAX_SAMPLES
  ) {
    throw invalid("Packed-alpha witness candidate selection is invalid");
  }
  const coordinates = new Set<string>();
  for (const candidate of selection.candidates) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !Number.isSafeInteger(candidate.x) ||
      !Number.isSafeInteger(candidate.y) ||
      candidate.x < 0 ||
      candidate.y < 0 ||
      !Number.isSafeInteger(candidate.canonicalAlpha) ||
      candidate.canonicalAlpha < 0 ||
      candidate.canonicalAlpha > UINT8_MAXIMUM ||
      !Number.isSafeInteger(candidate.gradient) ||
      candidate.gradient < 0 ||
      candidate.gradient > UINT8_MAXIMUM
    ) {
      throw invalid("Packed-alpha witness candidate is invalid");
    }
    const coordinate = `${String(candidate.x)}:${String(candidate.y)}`;
    if (coordinates.has(coordinate)) {
      throw invalid("Packed-alpha witness candidate coordinate is duplicated");
    }
    coordinates.add(coordinate);
  }
}

function concatenateChunks(
  chunks: Readonly<PreparedEncodingRendition>["units"][number]["chunks"]
): Uint8Array {
  const total = chunks.reduce(
    (bytes, chunk) => checkedAdd(bytes, chunk.bytes.byteLength),
    0
  );
  const output = allocateBytes(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return output;
}

function allocateBytes(length: number): Uint8Array {
  try {
    return new Uint8Array(length);
  } catch (cause) {
    throw new CompilerError(
      "OUTPUT_LIMIT",
      "Packed-alpha verification bytes could not be allocated",
      { cause, phase: "pixel-pipeline" }
    );
  }
}

function checkedProduct(...values: number[]): number {
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new CompilerError(
        "OUTPUT_LIMIT",
        "Packed-alpha verification size exceeds safe arithmetic",
        { phase: "pixel-pipeline" }
      );
    }
  }
  return result;
}

function checkedAdd(left: number, right: number): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new CompilerError(
      "OUTPUT_LIMIT",
      "Packed-alpha verification size exceeds safe arithmetic",
      { phase: "pixel-pipeline" }
    );
  }
  return left + right;
}

function qualificationFailure(
  selection: Readonly<PackedAlphaWitnessCandidateSelection>,
  message: string
): CompilerError {
  return new CompilerError("FFMPEG_FAILED", message, {
    unit: selection.unit,
    frame: selection.frame,
    phase: "pixel-pipeline",
    hint: "Reduce rendition CRF or use a higher-quality packed-alpha encoding."
  });
}

function invalid(message: string): CompilerError {
  return new CompilerError("INPUT_INVALID", message, { phase: "pixel-pipeline" });
}
