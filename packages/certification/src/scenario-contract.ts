export const REQUIRED_RUNTIME_SCENARIOS = Object.freeze({
  loop: { id: "loop-1000", minimumBoundaries: 1_000 },
  routes: { id: "all-routes-1000", minimumBoundaries: 1_000 },
  inverse: { id: "active-inverse-1000", minimumBoundaries: 1_000 },
  portal: { id: "portal-1000", minimumBoundaries: 1_000 },
  rapidInput: { id: "rapid-input-10000", minimumOperations: 10_000, minimumHeadedOperations: 1_000 },
  throughput: { id: "decoder-throughput-300", minimumFrames: 300 },
  settlement: { id: "terminal-settlement" }
} as const);

export const RELEASE_RUNTIME_REPETITIONS = 3;

export function scenarioAttachmentId(id: string, repetition: number): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$/u.test(id)) throw new TypeError("scenario ID is invalid");
  if (!Number.isSafeInteger(repetition) || repetition < 1 || repetition > RELEASE_RUNTIME_REPETITIONS) throw new RangeError("scenario repetition is invalid");
  return `scenario-${id}-${String(repetition)}`;
}

export const REQUIRED_RUNTIME_CRITERION_IDS = Object.freeze([
  "runtime-content-identity",
  "runtime-boundary-submission",
  "runtime-route-semantics",
  "runtime-throughput",
  "runtime-forbidden-operations",
  "runtime-resource-settlement",
  "runtime-fatal-error-boundary"
] as const);

export const REQUIRED_DISPLAY_CRITERION_IDS = Object.freeze([
  "display-content-identity",
  "display-boundary-interval",
  "display-capture-calibration",
  "display-capture-completeness"
] as const);

export const DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID = "display-observation-ledger";
export const DISPLAY_RAW_CAPTURE_ATTACHMENT_ID = "display-raw-capture";
export const FATAL_ERROR_BOUNDARY_ATTACHMENT_ID = "runtime-fatal-error-boundary-ledger";

export interface ScenarioCoverageInput {
  readonly id: string;
  readonly repetition: number;
  readonly boundaryCount?: number;
  readonly operationCount?: number;
  readonly headedOperationCount?: number;
  readonly frameCount?: number;
}

export function validateScenarioCoverage(inputs: readonly ScenarioCoverageInput[]): readonly string[] {
  const failures: string[] = [];
  for (let repetition = 1; repetition <= RELEASE_RUNTIME_REPETITIONS; repetition += 1) {
    requireMinimum(inputs, REQUIRED_RUNTIME_SCENARIOS.loop.id, repetition, "boundaryCount", 1_000, failures);
    requireMinimum(inputs, REQUIRED_RUNTIME_SCENARIOS.routes.id, repetition, "boundaryCount", 1_000, failures);
    requireMinimum(inputs, REQUIRED_RUNTIME_SCENARIOS.inverse.id, repetition, "boundaryCount", 1_000, failures);
    requireMinimum(inputs, REQUIRED_RUNTIME_SCENARIOS.portal.id, repetition, "boundaryCount", 1_000, failures);
    requireMinimum(inputs, REQUIRED_RUNTIME_SCENARIOS.rapidInput.id, repetition, "operationCount", 10_000, failures);
    requireMinimum(inputs, REQUIRED_RUNTIME_SCENARIOS.rapidInput.id, repetition, "headedOperationCount", 1_000, failures);
    requireMinimum(inputs, REQUIRED_RUNTIME_SCENARIOS.throughput.id, repetition, "frameCount", 300, failures);
    if (!inputs.some((input) => input.id === REQUIRED_RUNTIME_SCENARIOS.settlement.id && input.repetition === repetition)) {
      failures.push(`${REQUIRED_RUNTIME_SCENARIOS.settlement.id}#${repetition}: missing`);
    }
  }
  return failures;
}

function requireMinimum(
  inputs: readonly ScenarioCoverageInput[],
  id: string,
  repetition: number,
  field: "boundaryCount" | "operationCount" | "headedOperationCount" | "frameCount",
  minimum: number,
  failures: string[]
): void {
  const found = inputs.find((input) => input.id === id && input.repetition === repetition);
  if (found === undefined) {
    failures.push(`${id}#${repetition}: missing`);
    return;
  }
  const value = found[field] ?? 0;
  if (!Number.isSafeInteger(value) || value < minimum) failures.push(`${id}#${repetition}.${field}: ${value} < ${minimum}`);
}
