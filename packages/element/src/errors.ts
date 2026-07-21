import type { AvalPublicFailure } from "./public-types.js";

const PLAYBACK_ERROR_MESSAGE = "aval-player playback could not continue";

export class AvalPlaybackError extends Error {
  public readonly failure: Readonly<AvalPublicFailure>;
  public readonly generation: number;

  public constructor(failure: Readonly<AvalPublicFailure>, generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new RangeError("playback generation must be a positive integer");
    }
    super(PLAYBACK_ERROR_MESSAGE);
    this.name = "AvalPlaybackError";
    this.failure = Object.isFrozen(failure)
      ? failure
      : Object.freeze({
          code: failure.code,
          message: failure.message,
          operation: failure.operation
        });
    this.generation = generation;
  }
}

export class AvalEnvironmentError extends Error {
  public constructor(message = "aval-player requires a browser custom-element environment") {
    super(message);
    this.name = "NotSupportedError";
  }
}

export class AvalNotReadyError extends Error {
  public constructor(message = "aval-player is not ready") {
    super(message);
    this.name = "NotReadyError";
  }
}

export class ElementCleanupIncompleteError extends Error {
  public constructor() {
    super("aval-player element cleanup was incomplete");
    this.name = "OperationError";
  }
}
