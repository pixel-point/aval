import { describe, expect, it } from "vitest";

import {
  createEncodedLoopUnit,
  validateEncodedLoopUnit,
  type EncodedLoopUnit
} from "./encoded-loop.js";

describe("encoded loop unit", () => {
  it("copies every access unit and decoder description into owned storage", () => {
    const descriptionBacking = new Uint8Array([99, 10, 11, 12, 88]);
    const key = new Uint8Array([1, 2, 3]);
    const delta = new Uint8Array([4, 5, 6]);
    const input = validUnit({
      config: validConfig({
        description: descriptionBacking.subarray(1, 4)
      }),
      frames: [
        { type: "key", data: key },
        { type: "delta", data: delta }
      ]
    });

    const owned = createEncodedLoopUnit(input);

    key.fill(200);
    delta.fill(201);
    descriptionBacking.fill(202);

    expect([...owned.frames[0]!.data]).toEqual([1, 2, 3]);
    expect([...owned.frames[1]!.data]).toEqual([4, 5, 6]);
    expect(bytesOf(owned.config.description)).toEqual([10, 11, 12]);
    expect(owned.frames[0]!.data).not.toBe(key);
    expect(owned.frames[1]!.data).not.toBe(delta);
    expect(owned.frames[0]!.data.buffer).not.toBe(
      owned.frames[1]!.data.buffer
    );
  });

  it("rejects a detached access-unit payload before trying to own it", () => {
    const detached = new Uint8Array([1, 2, 3]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });

    expect(detached.byteLength).toBe(0);
    expect(() =>
      createEncodedLoopUnit(
        validUnit({ frames: [{ type: "key", data: detached }] })
      )
    ).toThrow("must not be empty");
  });

  it("retains exact dimensions, rational rate, codec config, and frame types", () => {
    const owned = createEncodedLoopUnit(validUnit());

    expect(owned).toMatchObject({
      codedWidth: 256,
      codedHeight: 128,
      displayWidth: 256,
      displayHeight: 128,
      frameRate: { numerator: 60_000, denominator: 1_001 },
      frames: [{ type: "key" }, { type: "delta" }],
      config: {
        codec: "avc1.42E020",
        codedWidth: 256,
        codedHeight: 128,
        displayAspectWidth: 256,
        displayAspectHeight: 128
      }
    });
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.frames)).toBe(true);
    expect(Object.isFrozen(owned.config)).toBe(true);
    expect(() => validateEncodedLoopUnit(owned)).not.toThrow();
  });

  it("rejects an empty unit and a non-key first frame", () => {
    expect(() =>
      validateEncodedLoopUnit(validUnit({ frames: [] }))
    ).toThrow("at least one frame");
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({ frames: [{ type: "delta", data: new Uint8Array([1]) }] })
      )
    ).toThrow("frame zero must be a key frame");
  });

  it("rejects empty, missing, and malformed payloads", () => {
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({ frames: [{ type: "key", data: new Uint8Array() }] })
      )
    ).toThrow("must not be empty");
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({
          frames: [
            { type: "key", data: [1, 2, 3] as unknown as Uint8Array }
          ]
        })
      )
    ).toThrow("must be a Uint8Array");
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({
          frames: [
            {
              type: "invalid" as EncodedVideoChunkType,
              data: new Uint8Array([1])
            }
          ]
        })
      )
    ).toThrow("invalid chunk type");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid dimensions: %s",
    (dimension) => {
      expect(() =>
        validateEncodedLoopUnit(validUnit({ codedWidth: dimension }))
      ).toThrow(RangeError);
    }
  );

  it("rejects decoder configuration dimension mismatches or omissions", () => {
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({ config: validConfig({ codedWidth: 512 }) })
      )
    ).toThrow("coded width must match");

    const configWithoutDisplayHeight = validConfig();
    delete configWithoutDisplayHeight.displayAspectHeight;
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({
          config: configWithoutDisplayHeight
        })
      )
    ).toThrow("display height is required");
  });

  it("rejects an empty codec and unsafe or over-limit frame rates", () => {
    expect(() =>
      validateEncodedLoopUnit(validUnit({ config: validConfig({ codec: " " }) }))
    ).toThrow("non-empty string");
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({ frameRate: { numerator: 61, denominator: 1 } })
      )
    ).toThrow("must not exceed 60 fps");
    expect(() =>
      validateEncodedLoopUnit(
        validUnit({ frameRate: { numerator: 1.5, denominator: 1 } })
      )
    ).toThrow("positive safe integer");
  });
});

function validUnit(overrides: Partial<EncodedLoopUnit> = {}): EncodedLoopUnit {
  return {
    config: validConfig(),
    codedWidth: 256,
    codedHeight: 128,
    displayWidth: 256,
    displayHeight: 128,
    frameRate: { numerator: 60_000, denominator: 1_001 },
    frames: [
      { type: "key", data: new Uint8Array([1, 2, 3]) },
      { type: "delta", data: new Uint8Array([4, 5, 6]) }
    ],
    ...overrides
  };
}

function validConfig(
  overrides: Partial<VideoDecoderConfig> = {}
): VideoDecoderConfig {
  return {
    codec: "avc1.42E020",
    codedWidth: 256,
    codedHeight: 128,
    displayAspectWidth: 256,
    displayAspectHeight: 128,
    optimizeForLatency: true,
    ...overrides
  };
}

function bytesOf(source: AllowSharedBufferSource | undefined): number[] {
  if (source === undefined) {
    throw new Error("expected decoder description");
  }
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);

  return [...bytes];
}
