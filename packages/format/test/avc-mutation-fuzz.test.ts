import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import { inspectAvcAnnexBRendition } from "../src/avc/index.js";
import { validInspectionInput } from "./avc-fixture.js";

describe("seeded hostile AVC mutation corpus", () => {
  it("returns one deterministic frozen result or PROFILE_INVALID without leaks", () => {
    const random = xorshift32(0x5a17_0c5e);
    for (let iteration = 0; iteration < 2_048; iteration += 1) {
      const input = cloneInput();
      const unit = input.units[Math.floor(random() * input.units.length)]!;
      const accessUnit = unit.accessUnits[
        Math.floor(random() * unit.accessUnits.length)
      ]!;
      accessUnit.bytes = mutate(accessUnit.bytes, random);

      const first = inspectOutcome(input);
      const second = inspectOutcome(input);
      expect(second).toEqual(first);
      if (first.ok) {
        expect(first.frozen).toBe(true);
      } else {
        expect(first.error).toMatchObject({
          name: "FormatError",
          code: "PROFILE_INVALID"
        });
      }
    }
  });
});

function cloneInput(): ReturnType<typeof validInspectionInput> {
  const source = validInspectionInput();
  return {
    profile: {
      ...source.profile,
      frameRate: { ...source.profile.frameRate }
    },
    units: source.units.map((unit) => ({
      id: unit.id,
      accessUnits: unit.accessUnits.map((sample) => ({
        key: sample.key,
        bytes: sample.bytes.slice()
      }))
    }))
  };
}

function mutate(
  bytes: Uint8Array,
  random: () => number
): Uint8Array {
  const operation = Math.floor(random() * 5);
  const index = Math.floor(random() * Math.max(1, bytes.length));
  if (operation === 0 && bytes.length > 0) {
    const result = bytes.slice();
    const target = index % result.length;
    result[target] =
      (result[target] ?? 0) ^ (1 << Math.floor(random() * 8));
    return result;
  }
  if (operation === 1) {
    return bytes.slice(0, index % (bytes.length + 1));
  }
  if (operation === 2 && bytes.length > 1) {
    const start = index % bytes.length;
    const count = 1 + Math.floor(random() * Math.min(8, bytes.length - start));
    const result = new Uint8Array(bytes.length - count);
    result.set(bytes.subarray(0, start));
    result.set(bytes.subarray(start + count), start);
    return result;
  }
  if (operation === 3) {
    const count = 1 + Math.floor(random() * 8);
    const at = index % (bytes.length + 1);
    const result = new Uint8Array(bytes.length + count);
    result.set(bytes.subarray(0, at));
    for (let offset = 0; offset < count; offset += 1) {
      result[at + offset] = Math.floor(random() * 256);
    }
    result.set(bytes.subarray(at), at + count);
    return result;
  }
  return bytes.slice();
}

function inspectOutcome(input: ReturnType<typeof validInspectionInput>):
  | { readonly ok: true; readonly frozen: boolean; readonly json: string }
  | {
      readonly ok: false;
      readonly error: {
        readonly name: string;
        readonly code: string;
        readonly message: string;
        readonly path?: string;
        readonly offset?: number;
      };
    } {
  try {
    const result = inspectAvcAnnexBRendition(input);
    return {
      ok: true,
      frozen: Object.isFrozen(result),
      json: JSON.stringify(result)
    };
  } catch (error) {
    if (!(error instanceof FormatError)) throw error;
    return {
      ok: false,
      error: {
        name: error.name,
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.offset === undefined ? {} : { offset: error.offset })
      }
    };
  }
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
