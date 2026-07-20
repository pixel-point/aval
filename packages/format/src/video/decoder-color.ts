export type DecoderColorTuple = readonly [
  primaries: string | null,
  transfer: string | null,
  matrix: string | null,
  fullRange: boolean | null
];

export type DecoderColorClassification =
  | Readonly<{ kind: "exact" }>
  | Readonly<{
      kind: "known-normalization";
      normalization:
        | "bt709-transfer-as-smpte170m"
        | "limited-bt709-srgb-transfer";
    }>
  | Readonly<{
      kind: "incompatible";
      field: "range" | "matrix" | "primaries" | "transfer";
    }>;

const EXACT = Object.freeze({ kind: "exact" } as const);
const BT709_TRANSFER_AS_SMPTE170M = Object.freeze({
  kind: "known-normalization",
  normalization: "bt709-transfer-as-smpte170m"
} as const);
const LIMITED_BT709_SRGB_TRANSFER = Object.freeze({
  kind: "known-normalization",
  normalization: "limited-bt709-srgb-transfer"
} as const);
const INCOMPATIBLE_PRIMARIES = incompatible("primaries");
const INCOMPATIBLE_TRANSFER = incompatible("transfer");
const INCOMPATIBLE_MATRIX = incompatible("matrix");
const INCOMPATIBLE_RANGE = incompatible("range");

/** Classify concrete decoded color metadata by semantic equivalence. */
export function classifyDecoderColor(
  expected: Readonly<DecoderColorTuple>,
  actual: Readonly<DecoderColorTuple>
): Readonly<DecoderColorClassification> {
  if (sameTuple(expected, actual)) return EXACT;

  if (isLimitedBt709(expected)) {
    if (
      actual[0] === "bt709" &&
      actual[1] === "smpte170m" &&
      actual[2] === "bt709" &&
      actual[3] === false
    ) {
      return BT709_TRANSFER_AS_SMPTE170M;
    }
    if (
      actual[0] === "bt709" &&
      actual[1] === "iec61966-2-1" &&
      actual[2] === "bt709" &&
      actual[3] === false
    ) {
      return LIMITED_BT709_SRGB_TRANSFER;
    }
  }

  if (expected[3] !== actual[3]) return INCOMPATIBLE_RANGE;
  if (expected[2] !== actual[2]) return INCOMPATIBLE_MATRIX;
  if (expected[0] !== actual[0]) return INCOMPATIBLE_PRIMARIES;
  return INCOMPATIBLE_TRANSFER;
}

function sameTuple(
  expected: Readonly<DecoderColorTuple>,
  actual: Readonly<DecoderColorTuple>
): boolean {
  return expected[0] === actual[0] &&
    expected[1] === actual[1] &&
    expected[2] === actual[2] &&
    expected[3] === actual[3];
}

function isLimitedBt709(color: Readonly<DecoderColorTuple>): boolean {
  return color[0] === "bt709" &&
    color[1] === "bt709" &&
    color[2] === "bt709" &&
    color[3] === false;
}

function incompatible(
  field: "primaries" | "transfer" | "matrix" | "range"
): Readonly<DecoderColorClassification> {
  return Object.freeze({ kind: "incompatible", field });
}
