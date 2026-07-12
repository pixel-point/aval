/** Deterministic unsigned 32-bit source shared by the M7 mutation tapes. */
export function createM7FuzzRandom(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b_79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function m7FuzzInteger(
  random: () => number,
  exclusiveMaximum: number
): number {
  if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum < 1) {
    throw new RangeError("fuzz random bound must be a positive safe integer");
  }
  return Math.floor(random() * exclusiveMaximum);
}
