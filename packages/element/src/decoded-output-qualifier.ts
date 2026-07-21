import type { PackedAlphaWitnessV1 } from "@pixel-point/aval-format";
import type {
  MaterializedRgbaFrameReference
} from "./rgba-materializer.js";
import type { RenderLayout } from "./renderer-geometry.js";

export class DecodedOutputIncompatibleError extends Error {
  public constructor(message = "decoded output is semantically incompatible") {
    super(message);
    this.name = "DecodedOutputIncompatibleError";
  }
}

export interface DecodedPackedAlphaQualificationInput {
  readonly unit: string;
  readonly localFrame: number;
  readonly layout: Readonly<RenderLayout>;
  readonly witness: Readonly<PackedAlphaWitnessV1>;
  readonly source: Readonly<MaterializedRgbaFrameReference>;
}

/** Validates an already-identified packed-alpha frame before readiness. */
export function qualifyDecodedPackedAlphaOutput(
  input: Readonly<DecodedPackedAlphaQualificationInput>
): void {
  const alphaRect = input.layout.alphaRect;
  if (alphaRect === undefined) {
    throw new Error("packed-alpha output witness requires an alpha pane");
  }
  if (
    input.unit !== input.witness.unit ||
    input.localFrame !== input.witness.frame
  ) throw new Error("decoded witness frame identity is invalid");

  const source = input.source.rgba;
  validateStorage(source, input.layout);
  const [alphaX, alphaY] = alphaRect;
  for (const sample of input.witness.samples) {
    const offset = (alphaY + sample.y) * source.stride +
      (alphaX + sample.x) * 4;
    const red = source.pixels[offset];
    if (
      red === undefined ||
      red < sample.expectedRange[0] ||
      red > sample.expectedRange[1]
    ) throw new DecodedOutputIncompatibleError(
      "decoded packed-alpha output failed qualification"
    );
  }
}

function validateStorage(
  source: Readonly<{
    width: number;
    height: number;
    stride: number;
    pixels: Uint8Array;
  }>,
  layout: Readonly<RenderLayout>
): void {
  const expectedStride = layout.storageWidth * 4;
  if (
    source.width !== layout.storageWidth ||
    source.height !== layout.storageHeight ||
    source.stride !== expectedStride ||
    source.pixels.byteLength !== expectedStride * layout.storageHeight
  ) throw new Error("decoded RGBA storage is invalid");
}
