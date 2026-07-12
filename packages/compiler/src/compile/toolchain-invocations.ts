import {
  FFMPEG_ENCODERS_ARGUMENTS,
  FFMPEG_VERSION_ARGUMENTS,
  FFPROBE_VERSION_ARGUMENTS,
  createCalibrationInvocation
} from "../ffmpeg/discovery.js";
import type { CompileInvocationDetails } from "../model.js";

/** Exact path-free argv used by both tool discovery and final verification. */
export function toolchainInvocations(
  phase: "discover" | "verify"
): readonly CompileInvocationDetails[] {
  const calibration = createCalibrationInvocation();
  return Object.freeze([
    invocation(`${phase}:ffmpeg-version`, "ffmpeg", FFMPEG_VERSION_ARGUMENTS),
    invocation(
      `${phase}:ffmpeg-encoders`,
      "ffmpeg",
      FFMPEG_ENCODERS_ARGUMENTS
    ),
    invocation(`${phase}:ffprobe-version`, "ffprobe", FFPROBE_VERSION_ARGUMENTS),
    invocation(
      `${phase}:ffmpeg-calibration`,
      "ffmpeg",
      calibration.arguments
    )
  ]);
}

function invocation(
  operation: string,
  tool: CompileInvocationDetails["tool"],
  arguments_: readonly string[]
): Readonly<CompileInvocationDetails> {
  return Object.freeze({
    operation,
    tool,
    arguments: Object.freeze([...arguments_])
  });
}
