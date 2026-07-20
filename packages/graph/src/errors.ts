export type MotionGraphErrorCode =
  | "GRAPH_VALIDATION"
  | "NOT_READY"
  | "ROUTE_NOT_FOUND"
  | "INPUT_OVERFLOW"
  | "NON_CONSECUTIVE_TICK"
  | "PLAYBACK_ERROR"
  | "DISPOSED";

export class MotionGraphError extends Error {
  public constructor(
    public readonly code: MotionGraphErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MotionGraphError";
  }
}

export class MotionGraphValidationError extends MotionGraphError {
  public constructor(message: string, options?: ErrorOptions) {
    super("GRAPH_VALIDATION", message, options);
    this.name = "MotionGraphValidationError";
  }
}
