const COMPLETE_SOURCE_RANGE: unique symbol = Symbol(
  "runtime complete source range"
);

export interface RuntimeCompleteSourceRange {
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface RuntimeCompleteSource {
  read(offset: number, byteLength: number): Readonly<RuntimeCompleteSourceRange>;
  release(): void;
}

/** Own one complete private representation and issue only live exact views. */
export function createRuntimeCompleteSource(
  bytesValue: Uint8Array,
  releaseSource: () => void
): Readonly<RuntimeCompleteSource> {
  if (
    !(bytesValue instanceof Uint8Array) ||
    !(bytesValue.buffer instanceof ArrayBuffer) ||
    bytesValue.byteOffset !== 0 ||
    bytesValue.byteLength < 1 ||
    bytesValue.buffer.byteLength !== bytesValue.byteLength ||
    typeof releaseSource !== "function"
  ) {
    throw new TypeError("complete runtime source ownership is invalid");
  }
  const bytes = bytesValue as Uint8Array<ArrayBuffer>;
  let live = true;
  const read = (
    offset: number,
    byteLength: number
  ): Readonly<RuntimeCompleteSourceRange> => {
    if (
      !live ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(byteLength) ||
      offset < 0 ||
      byteLength < 1 ||
      offset > bytes.byteLength ||
      byteLength > bytes.byteLength - offset
    ) {
      throw new RangeError("complete runtime source range is invalid");
    }
    const view = new Uint8Array(bytes.buffer, offset, byteLength);
    return Object.freeze({
      bytes: view,
      [COMPLETE_SOURCE_RANGE](candidate: Uint8Array): boolean {
        return live && candidate === view;
      }
    });
  };
  return Object.freeze({
    read,
    release(): void {
      if (!live) return;
      live = false;
      Reflect.apply(releaseSource, undefined, []);
    }
  });
}

/** @internal Prove that bytes are the exact view of one still-live source. */
export function assertLiveRuntimeCompleteSourceRange(
  range: Readonly<RuntimeCompleteSourceRange>,
  bytes: Uint8Array
): void {
  if (typeof range !== "object" || range === null || range.bytes !== bytes) {
    throw new TypeError("borrowed verified bytes lack complete-source ownership");
  }
  const validate = Reflect.get(range, COMPLETE_SOURCE_RANGE) as unknown;
  if (
    typeof validate !== "function" ||
    Reflect.apply(validate, range, [bytes]) !== true
  ) {
    throw new TypeError("borrowed verified bytes outlived their complete source");
  }
}
