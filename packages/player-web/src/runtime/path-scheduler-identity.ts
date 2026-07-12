import type {
  RuntimeMediaCursor,
  RuntimeMediaPresentation
} from "./model.js";
import type { SourceBodyCursor } from "./submission-horizon.js";

export function schedulerMediaCursor(
  media: Extract<RuntimeMediaPresentation, { readonly kind: "frame" }>
): Readonly<RuntimeMediaCursor> {
  return Object.freeze({
    path: media.path,
    unit: media.frame.unit,
    unitInstance: media.unitInstance,
    localFrame: media.frame.localFrame
  });
}

export function freezeSchedulerCursor(
  cursor: RuntimeMediaCursor | null
): Readonly<RuntimeMediaCursor> | null {
  return cursor === null ? null : Object.freeze({ ...cursor });
}

export function freezeSchedulerSourceCursor(
  cursor: SourceBodyCursor | null
): Readonly<SourceBodyCursor> | null {
  return cursor === null ? null : Object.freeze({ ...cursor });
}
