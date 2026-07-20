import type { RendererFrameInspector } from "./renderer-contract.js";
import type {
  MaterializedRgbaFrame,
  MaterializedRgbaFrameReference
} from "./rgba-materializer.js";

type RendererInspectionOutcome =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "rejected"; reason: unknown }>;

const ACCEPTED: RendererInspectionOutcome = Object.freeze({ kind: "accepted" });

/** Runs one synchronous caller inspector over already-materialized RGBA bytes. */
export function inspectMaterializedRgbaFrame(
  frame: VideoFrame,
  rgba: Readonly<MaterializedRgbaFrame>,
  inspect: RendererFrameInspector
): RendererInspectionOutcome {
  const reference: Readonly<MaterializedRgbaFrameReference> = Object.freeze({
    frame,
    rgba
  });
  try {
    const returned: unknown = inspect(reference);
    if (!isPromiseLike(returned)) return ACCEPTED;
    void Promise.resolve(returned).catch(() => undefined);
    return rejected(new TypeError("renderer frame inspector must be synchronous"));
  } catch (reason) {
    return rejected(reason);
  }
}

/** Rethrows caller rejection only after the serialized renderer job completes. */
export function rethrowInspectionRejection(
  outcome: RendererInspectionOutcome
): void {
  if (outcome.kind === "rejected") throw outcome.reason;
}

function rejected(reason: unknown): RendererInspectionOutcome {
  return Object.freeze({ kind: "rejected", reason });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (
    value === null ||
    typeof value !== "object" && typeof value !== "function"
  ) return false;
  return typeof (value as Readonly<{ then?: unknown }>).then === "function";
}
