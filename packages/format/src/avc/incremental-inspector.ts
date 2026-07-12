import { FORMAT_DEFAULT_BUDGETS, IDENTIFIER_PATTERN } from "../constants.js";
import { FormatError, isFormatError } from "../errors.js";
import { requireAvc } from "./failure.js";
import {
  cloneAvcPictureOrderState,
  cloneAvcProfile,
  createAvcParameterSetSummary,
  createAvcPictureOrderState,
  inspectAvcAccessUnitStatefully,
  validateAvcAccessUnitInput,
  validateAvcSpsAgainstProfile,
  type AvcParameterSetState,
  type AvcPictureOrderState
} from "./inspector.js";
import type {
  AvcConstrainedBaselineProfile,
  AvcIncrementalAccessUnitInput,
  AvcIncrementalAccessUnitInspection,
  AvcParameterSetSummary
} from "./types.js";

interface ActiveUnitState {
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrameCount: number;
  readonly nextUnitFrame: number;
  readonly pictureOrder: AvcPictureOrderState;
}

/**
 * Strict, occurrence-aware AVC inspection for worker decode submission.
 *
 * The instance retains only numbers, strings, frozen parsed syntax, and a
 * parameter-set byte signature string. Caller-owned byte views are consumed
 * synchronously and never retained. A failed inspection does not advance the
 * unit or picture-order state.
 */
export class AvcIncrementalInspector {
  readonly #profile: AvcConstrainedBaselineProfile;
  #stableParameterSets: AvcParameterSetState | undefined;
  #parameterSetSummary: AvcParameterSetSummary | undefined;
  #macroblocksPerFrame: number | undefined;
  #activeUnit: ActiveUnitState | undefined;
  #maximumUnitInstance = -1;

  public constructor(profile: AvcConstrainedBaselineProfile) {
    try {
      const validated = cloneAvcProfile(profile);
      this.#profile = validated;
    } catch (error) {
      if (isFormatError(error)) {
        throw error;
      }
      throw new FormatError(
        "PROFILE_INVALID",
        "incremental AVC profile could not be read"
      );
    }
  }

  public get parameterSet(): AvcParameterSetSummary | undefined {
    return this.#parameterSetSummary;
  }

  public get macroblocksPerFrame(): number | undefined {
    return this.#macroblocksPerFrame;
  }

  /**
   * Inspects one access unit and advances state only after every check passes.
   */
  public inspect(
    input: AvcIncrementalAccessUnitInput
  ): AvcIncrementalAccessUnitInspection {
    try {
      validateIncrementalInput(input);
      const previous = this.#activeUnit;
      validateUnitSequence(input, previous, this.#maximumUnitInstance);

      const pictureOrder =
        previous === undefined
          ? createAvcPictureOrderState()
          : cloneAvcPictureOrderState(previous.pictureOrder);
      const result = inspectAvcAccessUnitStatefully(
        input,
        input.unitFrame,
        incrementalPath(input),
        this.#stableParameterSets,
        this.#stableParameterSets,
        this.#profile,
        pictureOrder,
        this.#macroblocksPerFrame
      );
      let stableParameterSets = this.#stableParameterSets;
      let parameterSetSummary = this.#parameterSetSummary;
      let macroblocksPerFrame = this.#macroblocksPerFrame;
      if (stableParameterSets === undefined) {
        stableParameterSets = result.parameterSets;
        macroblocksPerFrame = validateAvcSpsAgainstProfile(
          stableParameterSets.sps,
          this.#profile,
          `${incrementalPath(input)}.sps`
        );
        parameterSetSummary = createAvcParameterSetSummary(
          stableParameterSets.sps
        );
      }

      const nextUnitFrame = input.unitFrame + 1;
      const unitComplete = nextUnitFrame === input.unitFrameCount;
      this.#stableParameterSets = stableParameterSets;
      this.#parameterSetSummary = parameterSetSummary;
      this.#macroblocksPerFrame = macroblocksPerFrame;
      this.#maximumUnitInstance = Math.max(
        this.#maximumUnitInstance,
        input.unitInstance
      );
      this.#activeUnit = unitComplete
        ? undefined
        : {
            unitId: input.unitId,
            unitInstance: input.unitInstance,
            unitFrameCount: input.unitFrameCount,
            nextUnitFrame,
            pictureOrder
          };

      return Object.freeze({
        unitId: input.unitId,
        unitInstance: input.unitInstance,
        unitFrame: input.unitFrame,
        unitFrameCount: input.unitFrameCount,
        unitComplete,
        chunkType: result.summary.idr ? "key" : "delta",
        accessUnit: result.summary
      });
    } catch (error) {
      if (isFormatError(error)) {
        throw error;
      }
      throw new FormatError(
        "PROFILE_INVALID",
        "incremental AVC access unit could not be inspected"
      );
    }
  }

  /**
   * Starts a new generation while preserving rendition parameter identity.
   * The next accepted sample must still be frame-zero SPS/PPS/IDR.
   */
  public resetUnitSequence(): void {
    this.#activeUnit = undefined;
    this.#maximumUnitInstance = -1;
  }
}

function validateIncrementalInput(
  input: AvcIncrementalAccessUnitInput
): void {
  requireAvc(input !== null && typeof input === "object", "sample", "sample is required");
  requireAvc(
    typeof input.unitId === "string" && IDENTIFIER_PATTERN.test(input.unitId),
    "sample.unitId",
    "unit id is invalid"
  );
  requireAvc(
    Number.isSafeInteger(input.unitInstance) && input.unitInstance >= 0,
    "sample.unitInstance",
    "unit instance must be a nonnegative safe integer"
  );
  requireAvc(
    Number.isSafeInteger(input.unitFrameCount) &&
      input.unitFrameCount > 0 &&
      input.unitFrameCount <= FORMAT_DEFAULT_BUDGETS.maxTotalUnitFrames,
    "sample.unitFrameCount",
    "unit frame count is outside the format budget"
  );
  requireAvc(
    Number.isSafeInteger(input.unitFrame) &&
      input.unitFrame >= 0 &&
      input.unitFrame < input.unitFrameCount,
    "sample.unitFrame",
    "unit frame lies outside the unit"
  );
  validateAvcAccessUnitInput(input, "sample");
}

function validateUnitSequence(
  input: AvcIncrementalAccessUnitInput,
  active: ActiveUnitState | undefined,
  maximumUnitInstance: number
): void {
  if (active === undefined) {
    requireAvc(
      input.unitFrame === 0,
      "sample.unitFrame",
      "a unit instance must begin with frame zero"
    );
    requireAvc(
      input.unitInstance > maximumUnitInstance,
      "sample.unitInstance",
      "unit instances must increase monotonically"
    );
    return;
  }
  requireAvc(
    input.unitId === active.unitId &&
      input.unitInstance === active.unitInstance &&
      input.unitFrameCount === active.unitFrameCount &&
      input.unitFrame === active.nextUnitFrame,
    "sample",
    "unit-instance samples must be contiguous and internally consistent"
  );
}

function incrementalPath(input: AvcIncrementalAccessUnitInput): string {
  return `units.${input.unitId}.${String(input.unitInstance)}[${String(
    input.unitFrame
  )}]`;
}
