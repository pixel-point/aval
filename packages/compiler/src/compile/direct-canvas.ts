import { CompilerError } from "../diagnostics.js";
import type { MediaProbe } from "../model.js";

export interface DirectCanvas {
  readonly width: number;
  readonly height: number;
}

/** Validate an explicit canvas or infer the largest exact 16-aligned fit. */
export function resolveDirectCanvas(
  probe: Pick<MediaProbe, "width" | "height">,
  requested?: readonly [number, number],
  requireExplicit = false
): Readonly<DirectCanvas> {
  if (requested !== undefined) {
    const [width, height] = requested;
    validateCanvas(width, height, probe);
    return Object.freeze({ width, height });
  }
  if (requireExplicit) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Direct PNG compilation requires an explicit --canvas"
    );
  }
  let selected: DirectCanvas | undefined;
  for (let width = 16; width <= 512; width += 16) {
    for (let height = 16; height <= 512; height += 16) {
      if (
        width <= probe.width &&
        height <= probe.height &&
        width * probe.height === height * probe.width &&
        (
          selected === undefined ||
          width * height > selected.width * selected.height ||
          (width * height === selected.width * selected.height &&
            width > selected.width)
        )
      ) {
        selected = { width, height };
      }
    }
  }
  if (selected === undefined) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "No exact non-upscaled 16-aligned canvas can be inferred",
      { hint: "Provide an aspect-preserving --canvas widthxheight." }
    );
  }
  return Object.freeze(selected);
}

function validateCanvas(
  width: number,
  height: number,
  probe: Pick<MediaProbe, "width" | "height">
): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 512 ||
    height > 512 ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    width > probe.width ||
    height > probe.height ||
    width * probe.height !== height * probe.width
  ) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "Canvas must be 16-aligned, at most 512, non-upscaled, and preserve source aspect"
    );
  }
}
