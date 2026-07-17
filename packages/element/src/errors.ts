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

export function avalAbortError(message = "aval-player operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
